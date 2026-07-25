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
import hashlib
import json
import re
import sys
from pathlib import Path

SLUG_PATTERN = re.compile(r"^[a-z0-9]+(?:[-_][a-z0-9]+)*$")
VERSION_PATTERN = re.compile(r"^\d+\.\d+\.\d+$")
SKU_PATTERN = re.compile(r"^[A-Z0-9][A-Z0-9._-]{0,99}$")

# Sensitive-value screening for classes[n].sku: the VisionEvent mapper
# (sample_inference_to_vision_event.py) rejects credential- or payment-
# bearing SKUs at emission time, so a manifest carrying one (e.g. a
# Luhn-valid card number that happens to match SKU_PATTERN) must already
# fail here instead of passing validation and blowing up downstream. The
# script may run standalone, so its own directory is added to sys.path
# before importing; if the mapper module is unavailable, a minimal local
# Luhn-PAN check keeps the validator from ever hard-crashing.
_SCRIPTS_DIR = str(Path(__file__).resolve().parent)
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)
try:
    from sample_inference_to_vision_event import contains_sensitive_value as _contains_sensitive_value
except ImportError:  # pragma: no cover - fallback when the mapper is absent
    _PAN_CANDIDATE = re.compile(r"\d(?:[ \-]?\d){11,}")

    def _passes_luhn(digits: str) -> bool:
        total = 0
        for index, char in enumerate(reversed(digits)):
            digit = ord(char) - 48
            if index % 2 == 1:
                digit *= 2
                if digit > 9:
                    digit -= 9
            total += digit
        return total % 10 == 0

    def _contains_sensitive_value(text: str) -> bool:
        for candidate in _PAN_CANDIDATE.findall(text):
            digits = candidate.replace(" ", "").replace("-", "")
            if 13 <= len(digits) <= 19 and _passes_luhn(digits):
                return True
        return False

SOURCE_VALUES = {"rpc", "sku-110k", "byond-custom"}
CAPTURE_CONTEXT_VALUES = {"shelf", "pickup", "return", "cart_insertion", "exit"}
SPLIT_NAMES = ("train", "val", "test")

TOP_LEVEL_KEYS = {
    "datasetName",
    "datasetVersion",
    "source",
    "sourceRoot",
    "licenseNotes",
    "annotations",
    "classes",
    "labels",
    "splits",
}
CLASS_KEYS = {"classId", "label", "sku", "sourceId"}
LABELS_KEYS = {"tenantId", "storeId", "planogramZone"}
SAMPLE_KEYS = {"image", "annotation", "captureContext", "planogramZone", "storeId", "tenantId"}

_URI_SCHEME_PATTERN = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*://")
_WINDOWS_DRIVE_PATTERN = re.compile(r"^[a-zA-Z]:")

# Shared error tail for every value _is_bad_path rejects. A REJECTED path is
# unconstrained input — it can be a credentialed rtsp://user:secret@... URL,
# an absolute path leaking directory layout, or non-string junk — so these
# errors name the field and the rule only, never the supplied value. (Paths
# that PASSED the gate are clean canonical relative strings and may still be
# echoed by missing-file/duplicate/alias reports.)
_BAD_PATH_RULE = (
    "must be a canonical relative path (no absolute paths, URI schemes, "
    "backslashes, '..', '.', empty segments, or NUL)"
)


def _is_bad_path(value) -> bool:
    """Reject anything that is not a clean, portable, canonical relative path.

    Dataset directories are shipped/mounted across contributor machines and
    CI runners; absolute paths, backslashes, ".." traversal, and URI schemes
    would either break portability or let a manifest escape its dataset
    root, so all are rejected outright rather than "best-effort" resolved.
    Non-canonical components are rejected too — any "." segment or empty
    segment (from "//" or a trailing "/") — so two spellings of the same
    file (e.g. "images/a.jpg" vs "images/./a.jpg") can never slip past the
    exact-string duplicate/overlap checks: every accepted path is already in
    canonical form, and the dedupe may safely compare raw strings.
    An embedded NUL is rejected here too: it is not a valid filesystem
    string, so every path field (image, annotation, split-level annotation
    ref) gets the same guard sourceRoot has — without it a NUL-bearing path
    would pass shape validation whenever --check-files is off.
    """
    if not isinstance(value, str) or not value:
        return True
    if "\x00" in value:
        return True
    if "\\" in value:
        return True
    if _URI_SCHEME_PATTERN.match(value):
        return True
    if value.startswith("/"):
        return True
    if _WINDOWS_DRIVE_PATTERN.match(value):
        return True
    if any(segment in ("", ".", "..") for segment in value.split("/")):
        return True
    return False


def _digest_file(path: Path) -> bytes:
    """SHA-256 digest of a file, streamed in 1 MiB chunks (images can be
    large). Raises OSError when the file cannot be read."""
    hasher = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.digest()


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

    def _safe_field(key) -> str:
        # Unknown-field keys are attacker-chosen strings: echo them only when
        # they carry no sensitive-looking content (a PAN or token used as a
        # key must not reach terminal/CI logs).
        if isinstance(key, str) and not _contains_sensitive_value(key):
            return repr(key)
        return "<redacted>"

    unknown_top = set(manifest.keys()) - TOP_LEVEL_KEYS
    for key in sorted(unknown_top):
        errors.append(f"unknown top-level field: {_safe_field(key)}")

    if "datasetName" not in manifest:
        errors.append("missing required field: datasetName")
    else:
        name = manifest["datasetName"]
        if not isinstance(name, str) or not SLUG_PATTERN.match(name):
            # An arbitrary string reaches this check before any pattern
            # constraint holds, so the value is never echoed.
            errors.append(f"datasetName must match {SLUG_PATTERN.pattern!r}")
        # An all-digit Luhn PAN is a perfectly valid slug, and datasetName is
        # the one screened field the CLI later echoes (in the OK summary), so
        # it gets the same sensitive-value screen as labels/SKUs. The error
        # never echoes the value; the OK line stays safe because it is only
        # reachable when this screen passed.
        if isinstance(name, str) and _contains_sensitive_value(name):
            errors.append("datasetName contains a sensitive-looking value")

    if "datasetVersion" not in manifest:
        errors.append("missing required field: datasetVersion")
    else:
        version = manifest["datasetVersion"]
        if not isinstance(version, str) or not VERSION_PATTERN.match(version):
            # Same redaction rationale as datasetName: unconstrained input.
            errors.append(f"datasetVersion must match {VERSION_PATTERN.pattern!r}")

    source = manifest.get("source")
    if "source" not in manifest:
        errors.append("missing required field: source")
    elif not isinstance(source, str) or source not in SOURCE_VALUES:
        # isinstance guard first: unhashable values (list/dict) would raise
        # TypeError from the set membership test instead of validating.
        # The allowed values are constants and may be listed; the supplied
        # value is unconstrained (it can be a credentialed URL) and is never
        # echoed.
        errors.append(f"source must be one of {sorted(SOURCE_VALUES)}")

    if "sourceRoot" in manifest:
        source_root = manifest["sourceRoot"]
        if not isinstance(source_root, str) or not source_root:
            # Never echo the rejected value: non-string junk (or a would-be
            # path) is unconstrained manifest input.
            errors.append("sourceRoot must be a non-empty string")
        elif "\x00" in source_root:
            # An embedded NUL is not a valid filesystem string and would make
            # every later Path operation raise instead of validate.
            errors.append("sourceRoot contains invalid characters")

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
            seen_source_ids: dict = {}
            for idx, cls in enumerate(classes):
                path = f"classes[{idx}]"
                if not isinstance(cls, dict):
                    errors.append(f"{path} must be an object")
                    continue

                unknown_cls = set(cls.keys()) - CLASS_KEYS
                for key in sorted(unknown_cls):
                    errors.append(f"{path}: unknown field {_safe_field(key)}")

                if "classId" not in cls:
                    errors.append(f"{path}: missing required field classId")
                else:
                    class_id = cls["classId"]
                    # classId errors report field + expected shape only: a
                    # malformed classId can be an arbitrary (PAN-bearing)
                    # string, and even a valid duplicate could be a mistyped
                    # sensitive number — so neither is ever echoed and the
                    # duplicate error is index-based.
                    if not isinstance(class_id, int) or isinstance(class_id, bool) or class_id < 0:
                        errors.append(f"{path}.classId must be an integer >= 0")
                    elif class_id in seen_class_ids:
                        errors.append(
                            f"{path}.classId duplicates classes[{seen_class_ids[class_id]}].classId"
                        )
                    else:
                        seen_class_ids[class_id] = idx

                if "label" not in cls:
                    errors.append(f"{path}: missing required field label")
                else:
                    label = cls["label"]
                    # Never echo the label value: like SKUs, a label can be a
                    # mistyped PAN or credential (all-digit strings satisfy
                    # SLUG_PATTERN), so errors name only the field paths.
                    if not isinstance(label, str) or not SLUG_PATTERN.match(label):
                        errors.append(f"{path}.label must match {SLUG_PATTERN.pattern!r}")
                    elif label in seen_labels:
                        errors.append(f"{path}.label duplicates classes[{seen_labels[label]}].label")
                    else:
                        seen_labels[label] = idx
                    # Same screening SKUs get: an all-digit Luhn PAN satisfies
                    # SLUG_PATTERN, so a label can carry raw card data. The
                    # error NEVER echoes the value.
                    if isinstance(label, str) and _contains_sensitive_value(label):
                        errors.append(f"{path}.label contains a sensitive-looking value")

                if "sku" in cls:
                    sku = cls["sku"]
                    if not isinstance(sku, str) or not SKU_PATTERN.match(sku):
                        # Never echo the rejected value: a malformed SKU can be a
                        # spaced/formatted PAN or other sensitive string.
                        errors.append(f"{path}.sku must match {SKU_PATTERN.pattern!r}")
                    elif sku in seen_skus:
                        # Redacted like every other sku error: a duplicated SKU
                        # can still be a PAN/credential-shaped value.
                        errors.append(f"{path}.sku duplicates classes[{seen_skus[sku]}].sku")
                    else:
                        seen_skus[sku] = idx
                    # Same screening the VisionEvent mapper applies at emission
                    # time (payment-card numbers, credential fragments): a SKU
                    # it would reject must not validate here. The error NEVER
                    # echoes the value — it may be a card number or secret.
                    if isinstance(sku, str) and _contains_sensitive_value(sku):
                        errors.append(f"{path}.sku contains a sensitive-looking value")
                elif source == "byond-custom":
                    errors.append(f"{path}: sku is required when source is 'byond-custom'")

                if "sourceId" in cls:
                    source_id = cls["sourceId"]
                    # Type-guard before comparisons: bool is an int subclass and
                    # non-int values must not reach the < or dict-key checks.
                    # Redacted like classId: field + expected shape only, and
                    # index-based duplicate reporting — never the value.
                    if not isinstance(source_id, int) or isinstance(source_id, bool) or source_id < 0:
                        errors.append(f"{path}.sourceId must be an integer >= 0")
                    elif source_id in seen_source_ids:
                        errors.append(
                            f"{path}.sourceId duplicates classes[{seen_source_ids[source_id]}].sourceId"
                        )
                    else:
                        seen_source_ids[source_id] = idx

            # classIds must be exactly the set {0..N-1}: downstream training
            # tooling maps model output indices straight onto classId, so a
            # gap or offset silently mislabels every prediction.
            if seen_class_ids and set(seen_class_ids) != set(range(len(classes))):
                errors.append(
                    "classes must use contiguous zero-based classId values 0..N-1"
                )

    if "labels" in manifest:
        labels = manifest["labels"]
        if not isinstance(labels, dict):
            errors.append("labels must be an object")
        else:
            unknown_labels = set(labels.keys()) - LABELS_KEYS
            for key in sorted(unknown_labels):
                errors.append(f"labels: unknown field {_safe_field(key)}")
            for key in LABELS_KEYS:
                if key in labels and not isinstance(labels[key], str):
                    errors.append(f"labels.{key} must be a string")
                elif key in labels and _contains_sensitive_value(labels[key]):
                    # tenantId/storeId/planogramZone are free-form strings a
                    # PAN or credential token would silently satisfy — and the
                    # staged manifest would carry it downstream. Screen like
                    # SKUs/labels; the error never echoes the value.
                    errors.append(f"labels.{key} contains a sensitive-looking value")

    if "annotations" in manifest:
        annotations = manifest["annotations"]
        if not isinstance(annotations, dict):
            errors.append("annotations must be an object")
        else:
            unknown_annotations = set(annotations.keys()) - set(SPLIT_NAMES)
            for key in sorted(unknown_annotations):
                errors.append(f"annotations: unknown field {_safe_field(key)}")
            for key in SPLIT_NAMES:
                if key in annotations and _is_bad_path(annotations[key]):
                    errors.append(f"annotations.{key} {_BAD_PATH_RULE}")

    if "splits" not in manifest:
        errors.append("missing required field: splits")
    else:
        splits = manifest["splits"]
        if not isinstance(splits, dict):
            errors.append("splits must be an object")
        else:
            unknown_splits = set(splits.keys()) - set(SPLIT_NAMES)
            for key in sorted(unknown_splits):
                errors.append(f"splits: unknown field {_safe_field(key)}")

            structurally_ok = True
            for split_name in SPLIT_NAMES:
                if split_name not in splits:
                    errors.append(f"splits: missing required split {split_name!r}")
                    structurally_ok = False

            any_non_empty = False
            seen_images: dict = {}
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
                        errors.append(f"{sample_path}: unknown field {_safe_field(key)}")

                    if "image" not in sample:
                        errors.append(f"{sample_path}: missing required field image")
                    elif _is_bad_path(sample["image"]):
                        errors.append(f"{sample_path}.image {_BAD_PATH_RULE}")
                    else:
                        image = sample["image"]
                        if image in seen_images:
                            errors.append(
                                f"{sample_path}.image duplicates "
                                f"splits.{seen_images[image]}.image ({image!r})"
                            )
                        else:
                            seen_images[image] = f"{split_name}[{idx}]"

                    if "annotation" in sample and _is_bad_path(sample["annotation"]):
                        errors.append(f"{sample_path}.annotation {_BAD_PATH_RULE}")

                    if "captureContext" in sample:
                        capture_context = sample["captureContext"]
                        if not isinstance(capture_context, str) or capture_context not in CAPTURE_CONTEXT_VALUES:
                            # Enum constants may be listed; the supplied value
                            # is unconstrained (it can be a secret token) and
                            # is never echoed.
                            errors.append(
                                f"{sample_path}.captureContext must be one of "
                                f"{sorted(CAPTURE_CONTEXT_VALUES)}"
                            )

                    for key in ("planogramZone", "storeId", "tenantId"):
                        if key in sample and not isinstance(sample[key], str):
                            errors.append(f"{sample_path}.{key} must be a string")
                        elif key in sample and _contains_sensitive_value(sample[key]):
                            # Same screen the top-level labels fields get: a
                            # PAN or credential token must fail validation, and
                            # the error never echoes the value.
                            errors.append(
                                f"{sample_path}.{key} contains a sensitive-looking value"
                            )

            if structurally_ok and not any_non_empty:
                errors.append("splits: at least one of train/val/test must be non-empty")

            if check_files and base_dir is not None:
                root = Path(base_dir)
                try:
                    resolved_root = root.resolve()
                except (OSError, ValueError):
                    # An unresolvable base dir (e.g. a sourceRoot with an
                    # embedded NUL) must surface as a validation error, never
                    # a traceback; file checks are skipped because no
                    # reference could resolve against such a root anyway.
                    errors.append("sourceRoot cannot be resolved")
                    root = None
                    resolved_root = None

                def _resolve(target: Path):
                    """Resolved target, or None when resolution fails (broken
                    symlink loops, permission errors, invalid characters, ...)."""
                    try:
                        return target.resolve()
                    except (OSError, ValueError):
                        return None

                def _escapes_root(resolved) -> bool:
                    # A lexically clean relative path can still point outside
                    # the dataset root via a symlink; a manifest must never
                    # reference data it does not own.
                    if resolved is None or resolved_root is None:
                        return False
                    try:
                        return not resolved.is_relative_to(resolved_root)
                    except (ValueError, TypeError):
                        return True

                missing = []
                annotations = manifest.get("annotations") if root is not None else None
                if isinstance(annotations, dict):
                    for split_name in SPLIT_NAMES:
                        rel = annotations.get(split_name)
                        if isinstance(rel, str) and not _is_bad_path(rel):
                            target = root / rel
                            if not target.exists():
                                missing.append(f"missing file: {rel}")
                            elif not target.is_file():
                                missing.append(f"not a regular file: {rel}")
                            elif _escapes_root(_resolve(target)):
                                missing.append(f"escapes the source root: {rel}")
                seen_image_identities: dict = {}
                seen_image_digests: dict = {}
                for split_name in SPLIT_NAMES:
                    samples = splits.get(split_name) if root is not None else None
                    if not isinstance(samples, list):
                        continue
                    for idx, sample in enumerate(samples):
                        if not isinstance(sample, dict):
                            continue
                        for key in ("image", "annotation"):
                            rel = sample.get(key)
                            if not isinstance(rel, str) or _is_bad_path(rel):
                                continue
                            target = root / rel
                            if not target.exists():
                                missing.append(f"missing file: {rel}")
                                continue
                            if not target.is_file():
                                missing.append(f"not a regular file: {rel}")
                                continue
                            resolved = _resolve(target)
                            if _escapes_root(resolved):
                                missing.append(f"escapes the source root: {rel}")
                                continue
                            if key != "image":
                                # Annotations may legitimately be shared across
                                # splits (split-level files); only images get
                                # alias/copy dedup.
                                continue
                            ref = f"splits.{split_name}[{idx}].image"
                            # Two lexically distinct image refs can still be
                            # one underlying file via symlinks/hardlinks,
                            # silently leaking samples across splits past the
                            # exact-string overlap check above. Dedupe by
                            # filesystem identity (st_dev, st_ino) of the
                            # resolved path; if identity cannot be determined,
                            # skip aliasing detection for this entry (the
                            # existence checks above still applied).
                            identity = None
                            if resolved is not None:
                                try:
                                    stat_result = resolved.stat()
                                except OSError:
                                    stat_result = None
                                if stat_result is not None and stat_result.st_ino != 0:
                                    # st_ino == 0: filesystem does not report
                                    # inodes; identity would be meaningless and
                                    # every file would "alias" every other.
                                    identity = (stat_result.st_dev, stat_result.st_ino)
                            identity_seen = False
                            if identity is not None:
                                prior = seen_image_identities.get(identity)
                                if prior is None:
                                    seen_image_identities[identity] = (ref, rel)
                                else:
                                    identity_seen = True
                                    if prior[1] != rel:
                                        # Same-string duplicates are already
                                        # reported by the exact-string check
                                        # above.
                                        errors.append(
                                            f"{ref} aliases {prior[0]} (same underlying file)"
                                        )
                            if identity_seen:
                                # An inode-alias pair necessarily shares a
                                # content digest; reporting only the alias
                                # error avoids double-reporting the pair.
                                continue
                            # Inode identity misses byte-for-byte copies of an
                            # image across splits — an equally real train/eval
                            # leak. Stream a content digest and reject digest
                            # collisions. An unreadable image is unusable for
                            # training AND evades the duplicate check, so it
                            # fails validation rather than being skipped.
                            try:
                                digest = _digest_file(target)
                            except OSError:
                                missing.append(f"unreadable file: {rel}")
                                continue
                            prior_ref = seen_image_digests.get(digest)
                            if prior_ref is None:
                                seen_image_digests[digest] = ref
                            else:
                                errors.append(
                                    f"{ref} duplicates content of {prior_ref}"
                                )
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
        "(defaults to the manifest's sourceRoot resolved against the manifest's own "
        "directory, or that directory itself when no sourceRoot is present)",
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

    if args.base_dir is not None:
        base_dir = Path(args.base_dir)
    else:
        source_root = manifest.get("sourceRoot") if isinstance(manifest, dict) else None
        try:
            base_dir = manifest_path.resolve().parent
            if isinstance(source_root, str) and source_root:
                source_root_path = Path(source_root)
                base_dir = source_root_path if source_root_path.is_absolute() else base_dir / source_root_path
        except (OSError, ValueError):
            # e.g. a sourceRoot with an embedded NUL: report a normal ERROR
            # line instead of crashing with a traceback.
            print("ERROR: sourceRoot cannot be resolved")
            return 1
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
