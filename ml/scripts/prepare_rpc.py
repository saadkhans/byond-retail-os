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
list index, sourceId = the original COCO category id that the annotation
files reference; no `sku` — RPC classes are not mapped to any tenant
catalog), and each split's samples are the image paths recorded in that
split's COCO `images` list.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
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
    manifest's own directory. Both endpoints are resolved to physical paths
    first so symlinked input/output dirs record a root that actually
    resolves. Falls back to the absolute input root when no relative path
    exists (e.g. different drives on Windows).
    """
    input_root = Path(input_dir).resolve()
    output_root = Path(output_dir).resolve()
    try:
        rel = os.path.relpath(str(input_root), str(output_root))
    except ValueError:
        return input_root.as_posix()
    return Path(rel).as_posix()


def _category_id_names(coco: dict) -> dict:
    """id -> name mapping of a COCO payload's `categories` list."""
    mapping = {}
    for category in coco.get("categories", []):
        if isinstance(category, dict):
            mapping[category.get("id")] = category.get("name")
    return mapping


def _category_map_mismatches(train_map: dict, split_map: dict) -> list:
    """Human-readable differences between a split's category map and train's.

    Empty list means the maps are exactly equal (same id set, same names).
    """
    mismatches = []
    for cid in sorted(set(train_map) - set(split_map), key=repr):
        mismatches.append(
            f"category id {cid!r} is missing (train names it {train_map[cid]!r})"
        )
    for cid in sorted(set(split_map) - set(train_map), key=repr):
        mismatches.append(
            f"category id {cid!r} is not in the training categories "
            f"(named {split_map[cid]!r})"
        )
    for cid in sorted(set(train_map) & set(split_map), key=repr):
        if train_map[cid] != split_map[cid]:
            mismatches.append(
                f"category id {cid!r} is named {split_map[cid]!r} but train "
                f"names it {train_map[cid]!r}"
            )
    return mismatches


def _write_json_atomically(payload: dict, destination: Path) -> None:
    """Write JSON via a same-directory temp file + os.replace.

    A crash mid-write can therefore never leave a truncated/partial
    manifest.json behind — the destination either keeps its previous
    content or receives the complete new one.
    """
    fd, tmp_name = tempfile.mkstemp(
        dir=str(destination.parent), prefix=destination.name + ".", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, sort_keys=True)
            fh.write("\n")
        # mkstemp creates the temp file 0600; give the final manifest the
        # normal umask-derived mode so shared-pipeline readers can open it.
        # (On Windows chmod is mostly a no-op — harmless.)
        current_umask = os.umask(0)
        os.umask(current_umask)
        os.chmod(tmp_name, 0o666 & ~current_umask)
        os.replace(tmp_name, destination)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


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
        entry = {"classId": idx, "label": label}
        # The COCO annotation files reference categories by their original
        # `id`, which need not match the contiguous training index. Preserve
        # it as sourceId so consumers joining annotations by category id do
        # not mislabel classes.
        source_id = category.get("id")
        if isinstance(source_id, int) and not isinstance(source_id, bool) and source_id >= 0:
            entry["sourceId"] = source_id
        classes.append(entry)

    # The annotation files reference categories by id; a val/test file whose
    # id -> name mapping differs from training's would silently mislabel
    # those splits, so every split must carry the exact same category map.
    train_categories = _category_id_names(train_annotations)

    splits = {}
    annotations = {}
    for split_name, (image_dir, annotation_file) in SPLIT_MARKERS.items():
        with (input_dir / annotation_file).open("r", encoding="utf-8") as fh:
            coco = json.load(fh)
        if split_name != "train":
            mismatches = _category_map_mismatches(train_categories, _category_id_names(coco))
            if mismatches:
                print(
                    f"ERROR: {annotation_file} ({split_name} split) categories do "
                    f"not match {SPLIT_MARKERS['train'][1]}; every split must use "
                    "the same category id -> name mapping:"
                )
                for mismatch in mismatches:
                    print(f"  - {mismatch}")
                return 1
        samples = []
        for image in coco.get("images", []):
            file_name = image.get("file_name")
            if not file_name:
                continue
            samples.append({"image": f"{image_dir}/{file_name}"})
        splits[split_name] = samples
        annotations[split_name] = annotation_file

    # Resolve to the physical input root so the written sourceRoot and the
    # check_files validation below agree on the same real location even when
    # --input/--output are symlinks.
    resolved_input = Path(input_dir).resolve()

    manifest = {
        "datasetName": DATASET_NAME,
        "datasetVersion": DATASET_VERSION,
        "source": "rpc",
        "sourceRoot": _source_root(resolved_input, output_dir),
        "licenseNotes": LICENSE_NOTES,
        "annotations": annotations,
        "classes": classes,
        "splits": splits,
    }

    manifest_path = output_dir / "manifest.json"

    # Validate BEFORE writing anything: a failed run must never clobber a
    # previously valid manifest.json with a rejected one.
    errors = validate_manifest(manifest, check_files=True, base_dir=resolved_input)
    if errors:
        print(
            f"ERROR: generated manifest for {manifest_path} failed validation "
            f"against input root {input_dir}; existing output was left untouched:"
        )
        for error in errors:
            print(f"  - {error}")
        return 1

    output_dir.mkdir(parents=True, exist_ok=True)
    _write_json_atomically(manifest, manifest_path)

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
