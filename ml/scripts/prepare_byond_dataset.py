"""Validate (and optionally stage) a BYOND custom store-capture dataset.

This is for FUTURE real BYOND store data — no public dataset to fetch, no
COCO parsing. A byond-custom dataset is expected to already exist on disk
as a hand-authored or upstream-generated manifest plus the raw captures it
references:

    byond-custom/
      raw/
        products/       (isolated product reference captures)
        shelves/        (planogram shelf captures)
        pickup/         (pickup interaction captures)
        return/         (return interaction captures)
        cart/           (cart-insertion captures)
      annotations/       (per-image annotation files)
      manifest.json      (BYOND manifest format, ml/configs/dataset.schema.json)

This script does not generate the manifest — it validates one that already
exists at `<input>/manifest.json`, applying the base manifest rules plus the
extra guarantees a byond-custom dataset must satisfy before it is trusted
for training: `source` must be `"byond-custom"`, every class must carry a
tenant catalog `sku`, every sample's `captureContext` (when present) must be
one of the five known interaction stages, and every referenced path must
live under the expected `raw/` or `annotations/` subtree (so a manifest
can never point outside its own dataset directory).
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from validate_dataset_manifest import validate_manifest, CAPTURE_CONTEXT_VALUES, SKU_PATTERN

SPLIT_NAMES = ("train", "val", "test")


def _print_plan(input_dir: str, output_dir) -> None:
    print("BYOND custom dataset validation plan (dry run — nothing read or written):")
    print(f"  input:  {input_dir}")
    print(f"  output: {output_dir if output_dir else '(not provided — validate only)'}")
    print("  expected input layout:")
    print("    raw/products/  raw/shelves/  raw/pickup/  raw/return/  raw/cart/")
    print("    annotations/")
    print("    manifest.json")
    print("  validation plan:")
    print("    1. load <input>/manifest.json")
    print("    2. run the base BYOND manifest validator with check_files=True")
    print("    3. enforce source == 'byond-custom'")
    print("    4. enforce every class has a sku matching the tenant SKU pattern")
    print("    5. enforce every sample's captureContext (if present) is a known stage")
    print("    6. enforce every image path starts with 'raw/' and annotation with 'annotations/'")
    print("  if --output is given, the validated manifest is copied to <output>/manifest.json")


def _extra_byond_checks(manifest: dict) -> list:
    errors = []

    source = manifest.get("source")
    if source != "byond-custom":
        errors.append(f"source must be 'byond-custom' for a BYOND custom dataset, got {source!r}")

    classes = manifest.get("classes")
    if isinstance(classes, list):
        for idx, cls in enumerate(classes):
            if not isinstance(cls, dict):
                continue
            sku = cls.get("sku")
            if not isinstance(sku, str) or not SKU_PATTERN.match(sku):
                errors.append(f"classes[{idx}]: sku is required and must match the tenant SKU pattern, got {sku!r}")

    splits = manifest.get("splits")
    if isinstance(splits, dict):
        for split_name in SPLIT_NAMES:
            samples = splits.get(split_name)
            if not isinstance(samples, list):
                continue
            for idx, sample in enumerate(samples):
                if not isinstance(sample, dict):
                    continue
                path = f"splits.{split_name}[{idx}]"

                capture_context = sample.get("captureContext")
                if capture_context is not None and capture_context not in CAPTURE_CONTEXT_VALUES:
                    errors.append(
                        f"{path}.captureContext must be one of {sorted(CAPTURE_CONTEXT_VALUES)}, "
                        f"got {capture_context!r}"
                    )

                image = sample.get("image")
                if isinstance(image, str) and not image.startswith("raw/"):
                    errors.append(f"{path}.image must live under 'raw/', got {image!r}")

                annotation = sample.get("annotation")
                if isinstance(annotation, str) and not annotation.startswith("annotations/"):
                    errors.append(f"{path}.annotation must live under 'annotations/', got {annotation!r}")

    return errors


def validate(input_dir: Path, output_dir) -> int:
    manifest_path = input_dir / "manifest.json"
    try:
        raw = manifest_path.read_text(encoding="utf-8")
    except OSError as exc:
        print(f"ERROR: could not read {manifest_path}: {exc}")
        return 1

    try:
        manifest = json.loads(raw)
    except json.JSONDecodeError as exc:
        print(f"ERROR: {manifest_path} is not valid JSON: {exc}")
        return 1

    errors = validate_manifest(manifest, base_dir=input_dir, check_files=True)
    errors.extend(_extra_byond_checks(manifest))

    if errors:
        print(f"ERROR: {manifest_path} failed validation:")
        for error in errors:
            print(f"  - {error}")
        return 1

    print(f"OK: {manifest_path} is a valid byond-custom dataset manifest")

    if output_dir is not None:
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        destination = output_dir / "manifest.json"
        shutil.copyfile(manifest_path, destination)
        print(f"  copied validated manifest to {destination}")

    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Validate (and optionally stage) a BYOND custom store-capture dataset."
    )
    parser.add_argument("--input", default=None, help="Path to the byond-custom dataset directory")
    parser.add_argument(
        "--output",
        default=None,
        help="Directory to copy the validated manifest into (optional)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the expected layout and validation plan without reading or writing anything",
    )
    args = parser.parse_args(argv)

    if args.dry_run:
        _print_plan(args.input or "<not provided>", args.output)
        return 0

    if not args.input:
        parser.error("--input is required unless --dry-run is set")

    return validate(Path(args.input), args.output)


if __name__ == "__main__":
    sys.exit(main())
