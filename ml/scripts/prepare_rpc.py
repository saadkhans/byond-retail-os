"""Prepare the RPC (Retail Product Checkout) dataset into a BYOND manifest.

RPC ("Retail Product Checkout") is a public large-scale dataset of retail
product images with COCO-style detection annotations, used in the
self-checkout / retail-recognition research literature. BYOND does NOT
redistribute RPC — its license does not permit that, and shipping it in this
repo would blow past what a git remote should hold anyway.

To use this script you must first manually download RPC yourself (from its
original publisher) and place the extracted files under
`ml/datasets/rpc/raw/` (or any directory you point `--input` at) with this
expected layout:

    <input>/
      train2019/                       (image directory)
      val2019/                         (image directory)
      test2019/                        (image directory)
      instances_train2019.json         (COCO-style annotations)
      instances_val2019.json           (COCO-style annotations)
      instances_test2019.json          (COCO-style annotations)

Given that layout, this script builds a BYOND dataset manifest
(ml/configs/dataset.schema.json) at `<output>/manifest.json`: classes come
from the COCO `categories` list (label = slugified category name, classId =
list index; no `sku` — RPC classes are not mapped to any tenant catalog),
and each split's samples are the image paths recorded in that split's COCO
`images` list.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

from validate_dataset_manifest import validate_manifest

SPLIT_MARKERS = {
    "train": ("train2019", "instances_train2019.json"),
    "val": ("val2019", "instances_val2019.json"),
    "test": ("test2019", "instances_test2019.json"),
}

DATASET_NAME = "rpc"
DATASET_VERSION = "1.0.0"
LICENSE_NOTES = (
    "RPC (Retail Product Checkout) is a third-party public dataset. BYOND "
    "does not redistribute it; obtain it from its original publisher under "
    "its own license terms and place it under ml/datasets/rpc/raw/."
)


def _slugify(text: str, fallback: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", str(text).strip().lower()).strip("-")
    return slug or fallback


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
    for image_dir, annotation_file in SPLIT_MARKERS.values():
        if not (input_dir / image_dir).is_dir():
            missing.append(str(input_dir / image_dir))
        if not (input_dir / annotation_file).is_file():
            missing.append(str(input_dir / annotation_file))
    return missing


def _print_plan(input_dir, output_dir: str) -> None:
    planned_root = _source_root(input_dir, output_dir) if input_dir else "<depends on --input>"
    print("RPC preparation plan (dry run — nothing read or written):")
    print(f"  input:  {input_dir or '<not provided>'}")
    print(f"  output: {output_dir}")
    print(f"  planned sourceRoot: {planned_root}")
    print("  expected input layout:")
    for split, (image_dir, annotation_file) in SPLIT_MARKERS.items():
        print(f"    {split}: {image_dir}/  and  {annotation_file}")
    print("  would generate:")
    print(f"    {output_dir}/manifest.json — classes from COCO categories,")
    print("    samples from each split's COCO images list (referenced in place")
    print("    via sourceRoot; nothing copied), per-split annotation refs, and")
    print("    validated — including file existence under the input root —")
    print("    against ml/configs/dataset.schema.json before reporting OK.")


def prepare(input_dir: Path, output_dir: Path) -> int:
    missing = _missing_markers(input_dir)
    if missing:
        print("ERROR: RPC input is missing expected files/directories:")
        for path in missing:
            print(f"  - {path}")
        print()
        print(
            "Download RPC from its original publisher and place it under "
            f"{input_dir} with the layout documented in this script's module "
            "docstring (train2019/, val2019/, test2019/ image dirs and "
            "instances_{train,val,test}2019.json annotation files)."
        )
        return 1

    train_annotations_path = input_dir / SPLIT_MARKERS["train"][1]
    with train_annotations_path.open("r", encoding="utf-8") as fh:
        train_annotations = json.load(fh)

    categories = train_annotations.get("categories", [])
    classes = []
    seen_labels = set()
    for idx, category in enumerate(categories):
        label = _slugify(category.get("name", ""), fallback=f"class-{idx}")
        if label in seen_labels:
            label = f"{label}-{idx}"
        seen_labels.add(label)
        classes.append({"classId": idx, "label": label})

    splits = {}
    annotations = {}
    for split_name, (image_dir, annotation_file) in SPLIT_MARKERS.items():
        with (input_dir / annotation_file).open("r", encoding="utf-8") as fh:
            coco = json.load(fh)
        samples = []
        for image in coco.get("images", []):
            file_name = image.get("file_name")
            if not file_name:
                continue
            samples.append({"image": f"{image_dir}/{file_name}"})
        splits[split_name] = samples
        annotations[split_name] = annotation_file

    manifest = {
        "datasetName": DATASET_NAME,
        "datasetVersion": DATASET_VERSION,
        "source": "rpc",
        "sourceRoot": _source_root(input_dir, output_dir),
        "licenseNotes": LICENSE_NOTES,
        "annotations": annotations,
        "classes": classes,
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
    print(
        f"  {len(classes)} classes, train/val/test = {train_n}/{val_n}/{test_n} samples"
    )
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Prepare the RPC dataset into a BYOND dataset manifest."
    )
    parser.add_argument("--input", default=None, help="Path to raw RPC data (see module docstring)")
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
