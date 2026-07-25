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
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from validate_dataset_manifest import validate_manifest, CAPTURE_CONTEXT_VALUES, SKU_PATTERN

SPLIT_NAMES = ("train", "val", "test")

# Repository root this script lives in (ml/scripts/<this file> -> repo root).
# Used by the staging-destination policy below to keep customer manifests
# (tenant/store ids, SKU maps, capture labels) out of committable paths.
REPO_ROOT = Path(__file__).resolve().parents[2]

STAGING_POLICY = (
    "staged custom manifests must go to a gitignored location or outside the repository"
)

# Conservative fallback used only when git itself cannot answer: the two
# in-repo locations .gitignore is known to cover for generated ML outputs.
FALLBACK_ALLOWED_SUBTREES = (
    Path("ml") / "datasets" / "byond-custom" / "processed",
    Path("ml") / "outputs",
)


def _staging_destination_error(output_dir) -> "str | None":
    """Policy check for --output: returns an error string when staging there
    would put a customer manifest into git-trackable territory, else None.

    Allowed: any resolved path outside the repository, or an in-repo path git
    confirms is ignored (`git check-ignore`). If git is unavailable or errors,
    only the known-gitignored subtrees in FALLBACK_ALLOWED_SUBTREES are
    allowed. The returned message names only the offending path — never any
    manifest content.
    """
    try:
        resolved_output = Path(output_dir).resolve()
    except (OSError, ValueError):
        return f"output path {str(output_dir)!r} cannot be resolved; {STAGING_POLICY}"

    if not (REPO_ROOT / ".git").exists():
        # Not running from a repo checkout — nothing here is trackable.
        return None

    try:
        if not resolved_output.is_relative_to(REPO_ROOT):
            return None
    except (TypeError, ValueError):
        return None

    # Probe with a contained file path rather than the directory itself: the
    # directory may not exist yet, and subtree patterns like
    # ml/datasets/byond-custom/** match contained files.
    probe = resolved_output / "manifest.json"
    try:
        returncode = subprocess.run(
            ["git", "check-ignore", "-q", "--", str(probe)],
            cwd=str(REPO_ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
        ).returncode
    except (OSError, subprocess.SubprocessError):
        returncode = None

    if returncode == 0:
        return None  # git confirms the destination is ignored.
    if returncode != 1:
        # git unavailable or errored (not a clean yes/no): conservative
        # allowlist of known-gitignored subtrees only.
        for subtree in FALLBACK_ALLOWED_SUBTREES:
            if resolved_output.is_relative_to(REPO_ROOT / subtree):
                return None
    return f"refusing to stage into {resolved_output}: {STAGING_POLICY}"


def _source_root(input_dir, output_dir) -> str:
    """Relative path (POSIX separators) from the output dir to the source root.

    Staging writes only the manifest (media is never copied), so the staged
    copy must record where the source data lives relative to its own
    directory. Both endpoints are resolved to physical paths first so
    symlinked input/output dirs record a root that actually resolves. Falls
    back to the absolute source root when no relative path exists (e.g.
    different drives on Windows).
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
    content or receives the complete new one. (Local copy of the same
    helper in prepare_rpc.py — scripts stay import-independent.)
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


def _effective_source_root(manifest: dict, input_dir: Path) -> Path:
    """Directory the manifest's file references resolve against.

    A relative sourceRoot resolves against the manifest's own directory
    (the input dir); an absolute one is used as-is; absent/invalid falls
    back to the input dir. Used both for check_files validation and for
    recomputing the staged manifest's sourceRoot, so the two can never
    disagree.
    """
    source_root = manifest.get("sourceRoot")
    if isinstance(source_root, str) and source_root:
        source_root_path = Path(source_root)
        return source_root_path if source_root_path.is_absolute() else input_dir / source_root_path
    return input_dir


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
    print("       (split-level annotations.train/val/test refs included)")
    print("    7. enforce every sample is annotation-covered: a per-sample 'annotation'")
    print("       or a top-level annotations.<split> entry for its split")
    print("  if --output is given, the validated manifest is staged to <output>/manifest.json")
    print("  with sourceRoot recomputed so references still resolve to the input dataset")
    print("  (media is never copied)")
    print("  staging policy: an in-repo --output is accepted only when gitignored")
    print("  (e.g. ml/datasets/byond-custom/processed/); otherwise the run is rejected")


def _extra_byond_checks(manifest: dict) -> list:
    errors = []

    # Redaction policy (mirrors the base validator's SKU messages): errors
    # here may name fields and interpolate path values (needed for
    # remediation, not secret-bearing), but must never echo sku/label-like
    # manifest values — a malformed SKU can be a mistyped PAN or credential
    # that must not reach terminal/CI logs.
    source = manifest.get("source")
    if source != "byond-custom":
        errors.append("source must be 'byond-custom' for a BYOND custom dataset")

    classes = manifest.get("classes")
    if isinstance(classes, list):
        for idx, cls in enumerate(classes):
            if not isinstance(cls, dict):
                continue
            sku = cls.get("sku")
            if not isinstance(sku, str) or not SKU_PATTERN.match(sku):
                errors.append(
                    f"classes[{idx}].sku is required and must match {SKU_PATTERN.pattern!r}"
                )

    # Split-level annotation refs (annotations.train/val/test) must obey the
    # same BYOND layout constraint as per-sample annotation paths — without
    # this, a byond-custom manifest could point a whole split's annotations
    # outside the annotations/ subtree.
    annotations = manifest.get("annotations")
    if isinstance(annotations, dict):
        for split_name in SPLIT_NAMES:
            annotation = annotations.get(split_name)
            if isinstance(annotation, str) and not annotation.startswith("annotations/"):
                errors.append(
                    f"annotations.{split_name} must live under 'annotations/', got {annotation!r}"
                )

    splits = manifest.get("splits")
    if isinstance(splits, dict):
        for split_name in SPLIT_NAMES:
            samples = splits.get(split_name)
            if not isinstance(samples, list):
                continue
            # Annotation coverage: a nonempty split whose samples carry no
            # `annotation` and that has no top-level annotations.<split>
            # entry would validate but be untrainable — every sample must be
            # covered one way or the other.
            split_covered = isinstance(annotations, dict) and split_name in annotations
            for idx, sample in enumerate(samples):
                if not isinstance(sample, dict):
                    continue
                path = f"splits.{split_name}[{idx}]"

                if not split_covered and "annotation" not in sample:
                    errors.append(
                        f"{path} has no annotation coverage: add a per-sample "
                        f"'annotation' or a top-level annotations.{split_name} entry"
                    )

                capture_context = sample.get("captureContext")
                if capture_context is not None and (
                    not isinstance(capture_context, str)
                    or capture_context not in CAPTURE_CONTEXT_VALUES
                ):
                    errors.append(
                        f"{path}.captureContext must be one of {sorted(CAPTURE_CONTEXT_VALUES)}"
                    )

                image = sample.get("image")
                if isinstance(image, str) and not image.startswith("raw/"):
                    errors.append(f"{path}.image must live under 'raw/', got {image!r}")

                annotation = sample.get("annotation")
                if isinstance(annotation, str) and not annotation.startswith("annotations/"):
                    errors.append(f"{path}.annotation must live under 'annotations/', got {annotation!r}")

    return errors


def validate(input_dir: Path, output_dir) -> int:
    # Enforce the staging-destination policy BEFORE the manifest is even
    # read: a rejected run must never echo tenant/SKU/capture content, and
    # must leave nothing behind at the rejected destination.
    if output_dir is not None:
        policy_error = _staging_destination_error(output_dir)
        if policy_error:
            print(f"ERROR: {policy_error}")
            return 1

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

    # References resolve through sourceRoot (when present), exactly like the
    # standalone validator's CLI — validating against input_dir directly would
    # wrongly fail manifests whose sourceRoot points elsewhere (e.g. "data").
    effective_source_root = _effective_source_root(manifest if isinstance(manifest, dict) else {}, input_dir)
    try:
        # Physical (symlink-resolved) roots so validation and the staged
        # manifest's recomputed sourceRoot agree on the same real location.
        resolved_input_dir = input_dir.resolve()
        effective_source_root = effective_source_root.resolve()
    except (OSError, ValueError):
        # Left unresolved; the base validator reports an unresolvable root
        # as a normal validation error below.
        pass
    else:
        # A manifest-supplied sourceRoot must never leave the dataset
        # directory: "../other-tenant", an absolute outside path, or an
        # in-dir symlink resolving elsewhere would let a manifest reference
        # (and later stage) another tenant's captures while being reported
        # valid. Enforced BEFORE validation and BEFORE staging.
        if not effective_source_root.is_relative_to(resolved_input_dir):
            source_root_value = manifest.get("sourceRoot") if isinstance(manifest, dict) else None
            print(
                f"ERROR: sourceRoot {source_root_value!r} resolves to "
                f"{effective_source_root}, which is outside the dataset "
                f"directory {resolved_input_dir}; custom source roots must "
                "stay inside the dataset directory"
            )
            return 1
    errors = validate_manifest(manifest, base_dir=effective_source_root, check_files=True)
    # The extra checks dereference dict fields; a manifest whose top level is
    # a list/scalar/null already failed shape validation above and must not
    # crash them with an AttributeError.
    if isinstance(manifest, dict):
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

        # A verbatim copy would break path resolution: a relative (or absent)
        # sourceRoot resolves against the manifest's own directory, which is
        # now the output dir. Recompute sourceRoot (from the same effective
        # root the validation above used) so the staged copy still points at
        # the input dataset's media (never copied/staged).
        staged = dict(manifest)
        staged["sourceRoot"] = _source_root(effective_source_root, output_dir)
        _write_json_atomically(staged, destination)
        print(f"  staged validated manifest to {destination}")

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
