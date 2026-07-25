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
from the COCO `categories` list sorted by original category id (label =
slugified category name, classId = contiguous 0..N-1 index in that sorted
order — deterministic regardless of the categories array's on-disk order,
sourceId = the original COCO category id that the annotation files
reference; no `sku` — RPC classes are not mapped to any tenant catalog),
and each split's samples are the image paths recorded in that split's COCO
`images` list.

Annotation-label policy: the TRAIN split's COCO file must carry a present,
non-empty `annotations` list — there is nothing to train on without labels.
The val/test files MAY omit the key entirely (unlabeled evaluation sets
exist); when any file does carry an `annotations` array it is fully
cross-checked regardless of split.
"""

from __future__ import annotations

import argparse
import json
import math
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

    Redaction policy: both maps have already passed _coco_shape_errors, so
    every id here is a validated non-negative non-bool int — echoing the
    integer id is safe and needed for remediation. Category NAMES are
    arbitrary COCO-supplied strings (a hostile or mangled export can carry
    credentials or PII in a name) and are never echoed — only the fact that
    the name differs.
    """
    mismatches = []
    for cid in sorted(set(train_map) - set(split_map)):
        mismatches.append(f"category id {cid} is missing from this split's categories")
    for cid in sorted(set(split_map) - set(train_map)):
        mismatches.append(f"category id {cid} is not in the training categories")
    for cid in sorted(set(train_map) & set(split_map)):
        if train_map[cid] != split_map[cid]:
            mismatches.append(f"category id {cid}: name differs from the training split")
    return mismatches


def _bbox_value_is_finite(value) -> bool:
    """True when value is a non-bool int/float that is finite.

    math.isfinite converts an int argument to float first, so a huge COCO-
    supplied integer (e.g. 10**309) raises OverflowError instead of
    returning False — treat that as non-finite (same guard style as the
    VisionEvent mapper's confidence checks) so a hostile annotation file
    yields the normal bbox shape error, never a traceback.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except (OverflowError, ValueError):
        return False


def _coco_shape_errors(coco) -> list:
    """Controlled shape errors for the COCO fields this script dereferences.

    The `categories` and `images` keys are REQUIRED: a file omitting either
    must be a named error, never a silent default to an empty list (a
    missing `images` would otherwise produce an empty split and an OK
    manifest; a missing `categories` in train would silently drop every
    class). Every entry the preparation below dereferences must already be
    a dict with correctly-typed fields (`id` a non-negative non-bool int
    and `name` a non-empty string for categories; `file_name` a non-empty
    string and `id` a present non-bool int for images), so a malformed
    annotation file produces named errors instead of AttributeError
    tracebacks. A negative category `id` is rejected here because sourceId
    must be >= 0 in the manifest — letting it through would drop the
    class's source mapping. An image with a missing/bool/non-int `id` is
    rejected even when nothing references it yet: annotation joins go
    through that id, so an unusable one must never slip past just because
    the entry happens to carry no annotations. Duplicate `images[].id`
    values are rejected too: they would collapse in the annotation-join
    reference set and silently corrupt image_id joins.

    When an `annotations` array is present it is cross-checked too: every
    entry must be an object whose `image_id` / `category_id` reference ids
    that exist in this file's `images` / `categories` lists, with a `bbox`
    of exactly 4 finite numbers and positive width/height. When the key is
    absent the check is skipped (reference-only fixtures stay valid).

    Redaction policy: every error names the file's array, index, field, and
    the violated rule only. COCO-supplied values (ids, names, file_names,
    whole entries) are never echoed — an annotation file is untrusted input
    whose values can carry credentials, PANs, or PII that must not reach
    terminal/CI logs. (Python type names of wrong-typed containers are not
    input values and remain safe to name.)
    """
    if not isinstance(coco, dict):
        return [f"top-level payload must be a JSON object, got {type(coco).__name__}"]
    errors = []
    categories = coco.get("categories")
    if "categories" not in coco:
        errors.append("categories is a required key and must be a list of objects")
    elif not isinstance(categories, list):
        errors.append(f"categories must be a list, got {type(categories).__name__}")
    else:
        for idx, category in enumerate(categories):
            if not isinstance(category, dict):
                errors.append(f"categories[{idx}] must be an object")
                continue
            category_id = category.get("id")
            if (
                isinstance(category_id, bool)
                or not isinstance(category_id, int)
                or category_id < 0
            ):
                errors.append(
                    f"categories[{idx}].id must be a non-negative integer"
                )
            name = category.get("name")
            if not isinstance(name, str) or not name:
                errors.append(f"categories[{idx}].name must be a non-empty string")
    images = coco.get("images")
    if "images" not in coco:
        errors.append("images is a required key and must be a list of objects")
    elif not isinstance(images, list):
        errors.append(f"images must be a list, got {type(images).__name__}")
    else:
        # Two images entries sharing an id would collapse into one entry in
        # the reference set below, corrupting every annotation join against
        # that id — reject duplicates outright.
        seen_image_ids = {}
        for idx, image in enumerate(images):
            if not isinstance(image, dict):
                errors.append(f"images[{idx}] must be an object")
                continue
            file_name = image.get("file_name")
            if not isinstance(file_name, str) or not file_name:
                errors.append(
                    f"images[{idx}].file_name must be a non-empty string"
                )
            image_id = image.get("id")
            if isinstance(image_id, bool) or not isinstance(image_id, int):
                errors.append(f"images[{idx}].id must be an integer")
            elif image_id in seen_image_ids:
                errors.append(
                    f"images[{idx}].id duplicates images[{seen_image_ids[image_id]}].id"
                )
            else:
                seen_image_ids[image_id] = idx
    annotations = coco.get("annotations")
    if annotations is not None:
        # Reference ids are collected only from well-formed entries; bool is
        # excluded because True/False hash-equal 1/0 and would silently
        # satisfy an integer id reference.
        image_ids = set()
        if isinstance(images, list):
            for image in images:
                if isinstance(image, dict):
                    image_id = image.get("id")
                    if isinstance(image_id, int) and not isinstance(image_id, bool):
                        image_ids.add(image_id)
        category_ids = set()
        if isinstance(categories, list):
            for category in categories:
                if isinstance(category, dict):
                    category_id = category.get("id")
                    if isinstance(category_id, int) and not isinstance(category_id, bool):
                        category_ids.add(category_id)
        if not isinstance(annotations, list):
            errors.append(f"annotations must be a list, got {type(annotations).__name__}")
        else:
            for idx, annotation in enumerate(annotations):
                if not isinstance(annotation, dict):
                    errors.append(f"annotations[{idx}] must be an object")
                    continue
                image_id = annotation.get("image_id")
                if (
                    isinstance(image_id, bool)
                    or not isinstance(image_id, int)
                    or image_id not in image_ids
                ):
                    errors.append(f"annotations[{idx}].image_id references an unknown image")
                category_id = annotation.get("category_id")
                if (
                    isinstance(category_id, bool)
                    or not isinstance(category_id, int)
                    or category_id not in category_ids
                ):
                    errors.append(
                        f"annotations[{idx}].category_id references an unknown category"
                    )
                bbox = annotation.get("bbox")
                if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
                    errors.append(
                        f"annotations[{idx}].bbox must be a list of exactly 4 numbers"
                    )
                elif not all(_bbox_value_is_finite(value) for value in bbox):
                    errors.append(f"annotations[{idx}].bbox values must be finite numbers")
                elif bbox[2] <= 0 or bbox[3] <= 0:
                    errors.append(
                        f"annotations[{idx}].bbox must have positive width and height"
                    )
    return errors


# Sentinel distinguishing "file failed to load" from any legitimate JSON
# payload (including null, which _coco_shape_errors rejects with its own
# named error).
_COCO_LOAD_ERROR = object()


def _load_coco(path: Path):
    """Parsed JSON payload of a COCO annotation file, or _COCO_LOAD_ERROR
    after printing a controlled ERROR line.

    A truncated/corrupt/unreadable file must produce the script's normal
    error style — the exception class name only, never file content or a
    raw traceback."""
    try:
        with path.open("r", encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, OSError, UnicodeDecodeError) as exc:
        print(f"ERROR: {path.name}: not valid JSON ({type(exc).__name__})")
        return _COCO_LOAD_ERROR


def _report_coco_shape_errors(annotation_file: str, errors: list) -> None:
    print(f"ERROR: {annotation_file} has malformed COCO entries:")
    for error in errors:
        print(f"  - {error}")


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
    print(f"    {output_dir}/manifest.json — classes from COCO categories")
    print("    (sorted by source category id for deterministic classIds),")
    print("    samples from each split's COCO images list (referenced in place")
    print("    via sourceRoot; nothing copied), per-split annotation refs, and")
    print("    validated — including file existence under the input root —")
    print("    against ml/configs/dataset.schema.json before reporting OK.")
    print("    Each COCO file's `annotations` array (when present) is cross-checked")
    print("    first: image_id/category_id references and 4-number positive bboxes.")
    print("    The train file must carry a non-empty annotations list; val/test")
    print("    files may omit the key (unlabeled evaluation sets).")


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
    train_annotations = _load_coco(train_annotations_path)
    if train_annotations is _COCO_LOAD_ERROR:
        return 1

    # Validate container shapes before any .get() chains dereference them —
    # a null/non-object entry must fail with a named error, not a traceback.
    shape_errors = _coco_shape_errors(train_annotations)
    if shape_errors:
        _report_coco_shape_errors(SPLIT_MARKERS["train"][1], shape_errors)
        return 1

    # The training split is what the model learns from: a train COCO file
    # with no (or an empty) `annotations` list has nothing to train on and
    # must be a named error, never an OK manifest. val/test may omit the
    # key — unlabeled evaluation sets exist (see module docstring). The
    # shape guard above already rejected a present-but-non-list value.
    if not train_annotations.get("annotations"):
        print(
            f"ERROR: {SPLIT_MARKERS['train'][1]} must contain a non-empty "
            "annotations list — the training split needs labels (val/test "
            "files may omit the annotations key)"
        )
        return 1

    # Sort categories by their source `id` before assigning contiguous
    # 0..N-1 classIds: two exports carrying the same id -> name map in
    # different array orders must produce identical classes under the same
    # datasetVersion. _coco_shape_errors above already guarantees every id
    # is a non-negative non-bool int, so the sort key is always well-typed.
    categories = sorted(train_annotations["categories"], key=lambda category: category["id"])
    classes = []
    seen_labels = set()
    for idx, category in enumerate(categories):
        label = _slugify(category.get("name", ""), fallback=f"class-{idx}")
        if label in seen_labels:
            # Keep incrementing the suffix until the label is actually unique:
            # a one-shot suffix can itself collide (e.g. "foo", "foo 3",
            # "foo!" -> "foo", "foo-3", "foo-3"). Deterministic because
            # categories are iterated in sorted source-id order.
            base = label
            suffix = idx
            label = f"{base}-{suffix}"
            while label in seen_labels:
                suffix += 1
                label = f"{base}-{suffix}"
        seen_labels.add(label)
        # The COCO annotation files reference categories by their original
        # `id`, which need not match the contiguous training index. Preserve
        # it as sourceId so consumers joining annotations by category id do
        # not mislabel classes.
        classes.append({"classId": idx, "label": label, "sourceId": category["id"]})

    # The annotation files reference categories by id; a val/test file whose
    # id -> name mapping differs from training's would silently mislabel
    # those splits, so every split must carry the exact same category map.
    train_categories = _category_id_names(train_annotations)

    splits = {}
    annotations = {}
    for split_name, (image_dir, annotation_file) in SPLIT_MARKERS.items():
        coco = _load_coco(input_dir / annotation_file)
        if coco is _COCO_LOAD_ERROR:
            return 1
        # Same shape guard for every split's file (train's re-load included)
        # BEFORE the category-map comparison and sample building below
        # iterate/dereference its categories and images entries.
        shape_errors = _coco_shape_errors(coco)
        if shape_errors:
            _report_coco_shape_errors(annotation_file, shape_errors)
            return 1
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
        # _coco_shape_errors above guarantees the images key is present, a
        # list of dicts, each with a non-empty file_name string.
        for image in coco["images"]:
            samples.append({"image": f"{image_dir}/{image.get('file_name')}"})
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
