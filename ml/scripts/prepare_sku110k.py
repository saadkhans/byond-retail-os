"""Prepare the SKU-110K dataset into a BYOND manifest.

SKU-110K is a public densely-packed retail shelf image dataset used for
shelf-level product *detection* (it does not distinguish product identity,
only "is there a product here"). BYOND does NOT redistribute SKU-110K —
obtain it yourself from its original publisher and place it under
`ml/datasets/sku110k/raw/` (or any directory you point `--input` at) with
this expected layout:

    <input>/
      images/                          (all image files, flat)
      annotations/
        annotations_train.csv
        annotations_val.csv
        annotations_test.csv

Each annotations CSV's first column is the image file name (SKU-110K's
published format). Because SKU-110K only labels "product present", it maps
to a single generic BYOND class rather than per-SKU classes.

Given that layout, this script builds a BYOND dataset manifest
(ml/configs/dataset.schema.json) at `<output>/manifest.json` with one class
(`product`) and splits built from the distinct image names referenced by
each CSV.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from pathlib import Path

from validate_dataset_manifest import validate_manifest

SPLIT_CSV_NAMES = {
    "train": "annotations_train.csv",
    "val": "annotations_val.csv",
    "test": "annotations_test.csv",
}

DATASET_NAME = "sku-110k"
DATASET_VERSION = "1.0.0"
LICENSE_NOTES = (
    "SKU-110K is a third-party public dataset. BYOND does not redistribute "
    "it; obtain it from its original publisher under its own license terms "
    "and place it under ml/datasets/sku110k/raw/."
)


def _source_root(input_dir, output_dir) -> str:
    """Relative path (POSIX separators) from the output dir to the input root.

    The manifest references source images/annotations in place (nothing is
    copied), so it records where the source root lives relative to the
    manifest's own directory. Falls back to the absolute input root when no
    relative path exists (e.g. different drives on Windows).
    """
    try:
        rel = os.path.relpath(str(input_dir), str(output_dir))
    except ValueError:
        return Path(input_dir).resolve().as_posix()
    return Path(rel).as_posix()


def _missing_markers(input_dir: Path) -> list:
    missing = []
    if not (input_dir / "images").is_dir():
        missing.append(str(input_dir / "images"))
    if not (input_dir / "annotations").is_dir():
        missing.append(str(input_dir / "annotations"))
    for csv_name in SPLIT_CSV_NAMES.values():
        path = input_dir / "annotations" / csv_name
        if not path.is_file():
            missing.append(str(path))
    return missing


def _print_plan(input_dir, output_dir: str) -> None:
    planned_root = _source_root(input_dir, output_dir) if input_dir else "<depends on --input>"
    print("SKU-110K preparation plan (dry run — nothing read or written):")
    print(f"  input:  {input_dir or '<not provided>'}")
    print(f"  output: {output_dir}")
    print(f"  planned sourceRoot: {planned_root}")
    print("  expected input layout:")
    print("    images/  (flat image directory)")
    print("    annotations/annotations_train.csv")
    print("    annotations/annotations_val.csv")
    print("    annotations/annotations_test.csv")
    print("  would generate:")
    print(f"    {output_dir}/manifest.json — single generic 'product' class,")
    print("    samples deduped from each split CSV's image-name column")
    print("    (referenced in place via sourceRoot; nothing copied), per-split")
    print("    annotation CSV refs, and validated — including file existence")
    print("    under the input root — against ml/configs/dataset.schema.json")
    print("    before reporting OK.")


def _image_names_from_csv(csv_path: Path) -> list:
    names = []
    seen = set()
    with csv_path.open("r", encoding="utf-8", newline="") as fh:
        reader = csv.reader(fh)
        for row in reader:
            if not row:
                continue
            image_name = row[0].strip()
            if not image_name:
                continue
            if image_name in seen:
                continue
            seen.add(image_name)
            names.append(image_name)
    return names


def prepare(input_dir: Path, output_dir: Path) -> int:
    missing = _missing_markers(input_dir)
    if missing:
        print("ERROR: SKU-110K input is missing expected files/directories:")
        for path in missing:
            print(f"  - {path}")
        print()
        print(
            "Download SKU-110K from its original publisher and place it under "
            f"{input_dir} with the layout documented in this script's module "
            "docstring (images/ directory and annotations/annotations_"
            "{train,val,test}.csv files)."
        )
        return 1

    splits = {}
    annotations = {}
    for split_name, csv_name in SPLIT_CSV_NAMES.items():
        image_names = _image_names_from_csv(input_dir / "annotations" / csv_name)
        splits[split_name] = [{"image": f"images/{name}"} for name in image_names]
        annotations[split_name] = f"annotations/{csv_name}"

    manifest = {
        "datasetName": DATASET_NAME,
        "datasetVersion": DATASET_VERSION,
        "source": "sku-110k",
        "sourceRoot": _source_root(input_dir, output_dir),
        "licenseNotes": LICENSE_NOTES,
        "annotations": annotations,
        "classes": [{"classId": 0, "label": "product"}],
        "splits": splits,
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = output_dir / "manifest.json"
    with manifest_path.open("w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2, sort_keys=True)
        fh.write("\n")

    errors = validate_manifest(manifest, check_files=True, base_dir=input_dir)
    if errors:
        print(
            f"ERROR: generated manifest at {manifest_path} failed validation "
            f"against input root {input_dir}:"
        )
        for error in errors:
            print(f"  - {error}")
        return 1

    train_n = len(splits["train"])
    val_n = len(splits["val"])
    test_n = len(splits["test"])
    print(f"OK: wrote {manifest_path}")
    print(f"  1 class, train/val/test = {train_n}/{val_n}/{test_n} samples")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Prepare the SKU-110K dataset into a BYOND dataset manifest."
    )
    parser.add_argument("--input", default=None, help="Path to raw SKU-110K data (see module docstring)")
    parser.add_argument("--output", required=True, help="Directory to write manifest.json into")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the preparation plan without reading or writing anything",
    )
    args = parser.parse_args(argv)

    if args.dry_run:
        _print_plan(args.input, args.output)
        return 0

    if not args.input:
        parser.error("--input is required unless --dry-run is set")

    return prepare(Path(args.input), Path(args.output))


if __name__ == "__main__":
    sys.exit(main())
