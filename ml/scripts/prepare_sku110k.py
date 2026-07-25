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

Each annotations CSV row follows SKU-110K's published 8-column format:

    image_name,x1,y1,x2,y2,class,image_width,image_height

Rows are validated (column count, finite numeric coordinates/dimensions,
x2 > x1, y2 > y1, positive dimensions, boxes inside the declared image
bounds) before any manifest is written.
Because SKU-110K only labels "product present", it maps to a single
generic BYOND class rather than per-SKU classes.

Given that layout, this script builds a BYOND dataset manifest
(ml/configs/dataset.schema.json) at `<output>/manifest.json` with one class
(`product`) and splits built from the distinct image names referenced by
each CSV.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sys
import tempfile
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
    print("    each CSV row validated against SKU-110K's published 8-column")
    print("    shape (finite coordinates, x2 > x1, y2 > y1, positive image")
    print("    dimensions) before any write, samples deduped from each split")
    print("    CSV's image-name column")
    print("    (referenced in place via sourceRoot; nothing copied), per-split")
    print("    annotation CSV refs, and validated — including file existence")
    print("    under the input root — against ml/configs/dataset.schema.json")
    print("    before reporting OK.")


# Published SKU-110K annotation row shape (8 columns).
CSV_COLUMNS = ("image_name", "x1", "y1", "x2", "y2", "class", "image_width", "image_height")

# (column index, column name) pairs that must parse as finite numbers.
NUMERIC_CSV_COLUMNS = (
    (1, "x1"),
    (2, "y1"),
    (3, "x2"),
    (4, "y2"),
    (6, "image_width"),
    (7, "image_height"),
)

# Cap on collected row errors per CSV: enough to characterise a broken
# export without flooding logs when every row of a huge file is bad.
MAX_ROW_ERRORS_PER_CSV = 25


def _finite_number(text: str):
    """Parsed finite float for one CSV cell, or None when it is not one."""
    try:
        value = float(text)
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def _row_errors(row: list) -> list:
    """Rule violations for one non-empty CSV row (rule names only — the raw
    row content is never included, so a corrupt export cannot dump arbitrary
    bytes into terminal/CI logs)."""
    if len(row) != len(CSV_COLUMNS):
        return [f"expected {len(CSV_COLUMNS)} columns, got {len(row)}"]
    errors = []
    if not row[0].strip():
        errors.append("image_name must be non-empty")
    numbers = {}
    for column_index, column_name in NUMERIC_CSV_COLUMNS:
        value = _finite_number(row[column_index])
        if value is None:
            errors.append(f"{column_name} must be a finite number")
        else:
            numbers[column_name] = value
    if "x1" in numbers and "x2" in numbers and numbers["x2"] <= numbers["x1"]:
        errors.append("x2 must be greater than x1")
    if "y1" in numbers and "y2" in numbers and numbers["y2"] <= numbers["y1"]:
        errors.append("y2 must be greater than y1")
    for dimension in ("image_width", "image_height"):
        if dimension in numbers and numbers[dimension] <= 0:
            errors.append(f"{dimension} must be greater than 0")
    # Boxes must stay inside the row's declared image bounds: a negative
    # origin or an endpoint beyond image_width/height is a corrupt export.
    for coordinate in ("x1", "y1"):
        if coordinate in numbers and numbers[coordinate] < 0:
            errors.append(f"{coordinate} must not be negative")
    if "x2" in numbers and "image_width" in numbers and numbers["x2"] > numbers["image_width"]:
        errors.append("x2 must not exceed image_width")
    if "y2" in numbers and "image_height" in numbers and numbers["y2"] > numbers["image_height"]:
        errors.append("y2 must not exceed image_height")
    return errors


def _image_names_from_csv(csv_path: Path) -> tuple:
    """(distinct image names, row-validation errors) for one annotations CSV.

    Every non-empty row must satisfy SKU-110K's published 8-column shape
    (see _row_errors). Errors carry the 1-based row number and the violated
    rule only. Collection stops after MAX_ROW_ERRORS_PER_CSV errors with an
    explicit truncation note. Truly empty rows (blank lines) are skipped
    silently, matching the previous parser's behavior.

    A file the csv module cannot parse (e.g. a cell beyond the field-size
    limit raises csv.Error mid-iteration) or cannot even decode/read
    (corrupt non-UTF-8 bytes, I/O failure) must also be a controlled error
    naming the exception class only — never the raw bytes/cell content and
    never a traceback (mirrors prepare_rpc's _load_coco style).
    """
    names = []
    seen = set()
    errors = []
    row_number = 0
    try:
        with csv_path.open("r", encoding="utf-8", newline="") as fh:
            reader = csv.reader(fh)
            for row_number, row in enumerate(reader, start=1):
                if not row:
                    continue
                violations = _row_errors(row)
                if violations:
                    remaining = MAX_ROW_ERRORS_PER_CSV - len(errors)
                    errors.extend(
                        f"row {row_number}: {violation}" for violation in violations[:remaining]
                    )
                    if len(errors) >= MAX_ROW_ERRORS_PER_CSV:
                        errors.append(
                            f"row-error limit ({MAX_ROW_ERRORS_PER_CSV}) reached; "
                            "remaining rows not checked"
                        )
                        break
                    continue
                image_name = row[0].strip()
                if image_name in seen:
                    continue
                seen.add(image_name)
                names.append(image_name)
    except csv.Error as exc:
        # The failing row is the one after the last successfully yielded
        # row_number (0 when the very first row fails).
        errors.append(
            f"row {row_number + 1}: could not be parsed ({type(exc).__name__})"
        )
    except (UnicodeDecodeError, OSError) as exc:
        errors.append(f"could not be read ({type(exc).__name__})")
    return names, errors


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
    row_errors = []
    for split_name, csv_name in SPLIT_CSV_NAMES.items():
        image_names, csv_errors = _image_names_from_csv(input_dir / "annotations" / csv_name)
        row_errors.extend(f"annotations/{csv_name} {error}" for error in csv_errors)
        splits[split_name] = [{"image": f"images/{name}"} for name in image_names]
        annotations[split_name] = f"annotations/{csv_name}"

    # Reject bad annotation rows BEFORE any manifest write: truncated rows,
    # non-numeric coordinates, or degenerate/invalid boxes must never yield
    # an OK manifest.
    if row_errors:
        print(
            "ERROR: SKU-110K annotation CSVs contain invalid rows; "
            "no manifest was written:"
        )
        for error in row_errors:
            print(f"  - {error}")
        return 1

    # Resolve to the physical input root so the written sourceRoot and the
    # check_files validation below agree on the same real location even when
    # --input/--output are symlinks.
    resolved_input = Path(input_dir).resolve()

    manifest = {
        "datasetName": DATASET_NAME,
        "datasetVersion": DATASET_VERSION,
        "source": "sku-110k",
        "sourceRoot": _source_root(resolved_input, output_dir),
        "licenseNotes": LICENSE_NOTES,
        "annotations": annotations,
        "classes": [{"classId": 0, "label": "product"}],
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

    # A write-side failure — --output naming an existing file (mkdir raises
    # FileExistsError, an OSError subclass), a read-only destination, a full
    # disk — must be a controlled ERROR naming the destination and exception
    # class only: never a traceback, never file/manifest content.
    try:
        output_dir.mkdir(parents=True, exist_ok=True)
        _write_json_atomically(manifest, manifest_path)
    except OSError as exc:
        print(f"ERROR: could not write {manifest_path} ({type(exc).__name__})")
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
