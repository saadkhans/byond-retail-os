"""Validate a BYOND CV dataset manifest (see ml/configs/dataset.schema.json).

Why a hand-rolled validator instead of `jsonschema`: Phase 8 tooling must run
on any contributor or CI machine with nothing beyond the Python 3.10+ standard
library — no pip install, no network access. The JSON Schema file is kept as
the documentation / source-of-truth copy; this module implements the same
rules by hand so both stay in sync deliberately (any drift is a code-review
concern, not a runtime dependency).

The manifest format is shared across RPC, SKU-110K, and BYOND custom
datasets so the same downstream training/export tooling can consume any of
them without per-source special casing.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

SLUG_PATTERN = re.compile(r"^[a-z0-9]+(?:[-_][a-z0-9]+)*$")
VERSION_PATTERN = re.compile(r"^\d+\.\d+\.\d+$")
SKU_PATTERN = re.compile(r"^[A-Z0-9][A-Z0-9._-]{0,99}$")

SOURCE_VALUES = {"rpc", "sku-110k", "byond-custom"}
CAPTURE_CONTEXT_VALUES = {"shelf", "pickup", "return", "cart_insertion", "exit"}
SPLIT_NAMES = ("train", "val", "test")

TOP_LEVEL_KEYS = {
    "datasetName",
    "datasetVersion",
    "source",
    "licenseNotes",
    "classes",
    "labels",
    "splits",
}
CLASS_KEYS = {"classId", "label", "sku"}
LABELS_KEYS = {"tenantId", "storeId", "planogramZone"}
SAMPLE_KEYS = {"image", "annotation", "captureContext", "planogramZone", "storeId", "tenantId"}

_URI_SCHEME_PATTERN = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*://")
_WINDOWS_DRIVE_PATTERN = re.compile(r"^[a-zA-Z]:")


def _is_bad_path(value) -> bool:
    """Reject anything that is not a clean, portable, relative path.

    Dataset directories are shipped/mounted across contributor machines and
    CI runners; absolute paths, backslashes, ".." traversal, and URI schemes
    would either break portability or let a manifest escape its dataset
    root, so all are rejected outright rather than "best-effort" resolved.
    """
    if not isinstance(value, str) or not value:
        return True
    if "\\" in value:
        return True
    if _URI_SCHEME_PATTERN.match(value):
        return True
    if value.startswith("/"):
        return True
    if _WINDOWS_DRIVE_PATTERN.match(value):
        return True
    if ".." in value.split("/"):
        return True
    return False


def validate_manifest(manifest, *, base_dir: "Path | None" = None, check_files: bool = False) -> list:
    """Validate a parsed manifest dict; return a list of error strings (empty = valid).

    Set check_files=True with base_dir pointing at the dataset root to also
    confirm every referenced image/annotation actually exists on disk — kept
    optional because manifest *shape* validation must work with no dataset
    present (CI, dry runs, schema-only checks).
    """
    errors: list = []

    if not isinstance(manifest, dict):
        return ["manifest must be a JSON object"]

    unknown_top = set(manifest.keys()) - TOP_LEVEL_KEYS
    for key in sorted(unknown_top):
        errors.append(f"unknown top-level field: {key!r}")

    if "datasetName" not in manifest:
        errors.append("missing required field: datasetName")
    else:
        name = manifest["datasetName"]
        if not isinstance(name, str) or not SLUG_PATTERN.match(name):
            errors.append(f"datasetName must match {SLUG_PATTERN.pattern!r}, got {name!r}")

    if "datasetVersion" not in manifest:
        errors.append("missing required field: datasetVersion")
    else:
        version = manifest["datasetVersion"]
        if not isinstance(version, str) or not VERSION_PATTERN.match(version):
            errors.append(f"datasetVersion must match {VERSION_PATTERN.pattern!r}, got {version!r}")

    source = manifest.get("source")
    if "source" not in manifest:
        errors.append("missing required field: source")
    elif source not in SOURCE_VALUES:
        errors.append(f"source must be one of {sorted(SOURCE_VALUES)}, got {source!r}")

    if "licenseNotes" not in manifest:
        errors.append("missing required field: licenseNotes")
    else:
        license_notes = manifest["licenseNotes"]
        if not isinstance(license_notes, str) or len(license_notes) < 1:
            errors.append("licenseNotes must be a non-empty string")

    if "classes" not in manifest:
        errors.append("missing required field: classes")
    else:
        classes = manifest["classes"]
        if not isinstance(classes, list) or len(classes) < 1:
            errors.append("classes must be a non-empty array")
        else:
            seen_class_ids: dict = {}
            seen_labels: dict = {}
            seen_skus: dict = {}
            for idx, cls in enumerate(classes):
                path = f"classes[{idx}]"
                if not isinstance(cls, dict):
                    errors.append(f"{path} must be an object")
                    continue

                unknown_cls = set(cls.keys()) - CLASS_KEYS
                for key in sorted(unknown_cls):
                    errors.append(f"{path}: unknown field {key!r}")

                if "classId" not in cls:
                    errors.append(f"{path}: missing required field classId")
                else:
                    class_id = cls["classId"]
                    if not isinstance(class_id, int) or isinstance(class_id, bool) or class_id < 0:
                        errors.append(f"{path}.classId must be an integer >= 0, got {class_id!r}")
                    elif class_id in seen_class_ids:
                        errors.append(
                            f"{path}.classId {class_id} duplicates classes[{seen_class_ids[class_id]}]"
                        )
                    else:
                        seen_class_ids[class_id] = idx

                if "label" not in cls:
                    errors.append(f"{path}: missing required field label")
                else:
                    label = cls["label"]
                    if not isinstance(label, str) or not SLUG_PATTERN.match(label):
                        errors.append(f"{path}.label must match {SLUG_PATTERN.pattern!r}, got {label!r}")
                    elif label in seen_labels:
                        errors.append(f"{path}.label {label!r} duplicates classes[{seen_labels[label]}]")
                    else:
                        seen_labels[label] = idx

                if "sku" in cls:
                    sku = cls["sku"]
                    if not isinstance(sku, str) or not SKU_PATTERN.match(sku):
                        errors.append(f"{path}.sku must match {SKU_PATTERN.pattern!r}, got {sku!r}")
                    elif sku in seen_skus:
                        errors.append(f"{path}.sku {sku!r} duplicates classes[{seen_skus[sku]}]")
                    else:
                        seen_skus[sku] = idx
                elif source == "byond-custom":
                    errors.append(f"{path}: sku is required when source is 'byond-custom'")

    if "labels" in manifest:
        labels = manifest["labels"]
        if not isinstance(labels, dict):
            errors.append("labels must be an object")
        else:
            unknown_labels = set(labels.keys()) - LABELS_KEYS
            for key in sorted(unknown_labels):
                errors.append(f"labels: unknown field {key!r}")
            for key in LABELS_KEYS:
                if key in labels and not isinstance(labels[key], str):
                    errors.append(f"labels.{key} must be a string")

    if "splits" not in manifest:
        errors.append("missing required field: splits")
    else:
        splits = manifest["splits"]
        if not isinstance(splits, dict):
            errors.append("splits must be an object")
        else:
            unknown_splits = set(splits.keys()) - set(SPLIT_NAMES)
            for key in sorted(unknown_splits):
                errors.append(f"splits: unknown field {key!r}")

            structurally_ok = True
            for split_name in SPLIT_NAMES:
                if split_name not in splits:
                    errors.append(f"splits: missing required split {split_name!r}")
                    structurally_ok = False

            any_non_empty = False
            for split_name in SPLIT_NAMES:
                if split_name not in splits:
                    continue
                samples = splits[split_name]
                if not isinstance(samples, list):
                    errors.append(f"splits.{split_name} must be an array")
                    structurally_ok = False
                    continue
                if samples:
                    any_non_empty = True
                for idx, sample in enumerate(samples):
                    sample_path = f"splits.{split_name}[{idx}]"
                    if not isinstance(sample, dict):
                        errors.append(f"{sample_path} must be an object")
                        continue

                    unknown_sample = set(sample.keys()) - SAMPLE_KEYS
                    for key in sorted(unknown_sample):
                        errors.append(f"{sample_path}: unknown field {key!r}")

                    if "image" not in sample:
                        errors.append(f"{sample_path}: missing required field image")
                    elif _is_bad_path(sample["image"]):
                        errors.append(
                            f"{sample_path}.image must be a relative path with no '..', "
                            f"backslashes, absolute prefix, or URI scheme, got {sample['image']!r}"
                        )

                    if "annotation" in sample and _is_bad_path(sample["annotation"]):
                        errors.append(
                            f"{sample_path}.annotation must be a relative path with no '..', "
                            f"backslashes, absolute prefix, or URI scheme, got {sample['annotation']!r}"
                        )

                    if "captureContext" in sample:
                        capture_context = sample["captureContext"]
                        if capture_context not in CAPTURE_CONTEXT_VALUES:
                            errors.append(
                                f"{sample_path}.captureContext must be one of "
                                f"{sorted(CAPTURE_CONTEXT_VALUES)}, got {capture_context!r}"
                            )

                    for key in ("planogramZone", "storeId", "tenantId"):
                        if key in sample and not isinstance(sample[key], str):
                            errors.append(f"{sample_path}.{key} must be a string")

            if structurally_ok and not any_non_empty:
                errors.append("splits: at least one of train/val/test must be non-empty")

            if check_files and base_dir is not None:
                root = Path(base_dir)
                missing = []
                for split_name in SPLIT_NAMES:
                    samples = splits.get(split_name)
                    if not isinstance(samples, list):
                        continue
                    for sample in samples:
                        if not isinstance(sample, dict):
                            continue
                        for key in ("image", "annotation"):
                            rel = sample.get(key)
                            if isinstance(rel, str) and not _is_bad_path(rel):
                                if not (root / rel).exists():
                                    missing.append(f"missing file: {rel}")
                for line in missing[:25]:
                    errors.append(line)
                if len(missing) > 25:
                    errors.append(f"...and {len(missing) - 25} more")

    return errors


def _split_counts(manifest: dict) -> tuple:
    splits = manifest.get("splits") or {}
    counts = []
    for name in SPLIT_NAMES:
        value = splits.get(name)
        counts.append(len(value) if isinstance(value, list) else 0)
    return tuple(counts)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Validate a BYOND CV dataset manifest against the Phase 8 manifest format."
    )
    parser.add_argument("manifest", help="Path to the manifest JSON file")
    parser.add_argument(
        "--check-files",
        action="store_true",
        help="Also confirm every referenced image/annotation exists on disk",
    )
    parser.add_argument(
        "--base-dir",
        default=None,
        help="Dataset root used to resolve relative paths when --check-files is set "
        "(defaults to the manifest's parent directory)",
    )
    args = parser.parse_args(argv)

    manifest_path = Path(args.manifest)
    try:
        raw = manifest_path.read_text(encoding="utf-8")
    except OSError as exc:
        print(f"ERROR: could not read manifest {manifest_path}: {exc}")
        return 1

    try:
        manifest = json.loads(raw)
    except json.JSONDecodeError as exc:
        print(f"ERROR: {manifest_path} is not valid JSON: {exc}")
        return 1

    base_dir = Path(args.base_dir) if args.base_dir is not None else manifest_path.resolve().parent
    errors = validate_manifest(manifest, base_dir=base_dir, check_files=args.check_files)

    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1

    n_classes = len(manifest.get("classes", []))
    train_n, val_n, test_n = _split_counts(manifest)
    print(
        f"OK: {manifest.get('datasetName')}@{manifest.get('datasetVersion')} — "
        f"{n_classes} classes, train/val/test = {train_n}/{val_n}/{test_n} samples"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
