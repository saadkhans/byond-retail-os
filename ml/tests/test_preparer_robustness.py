"""Robustness tests for the three prepare_* scripts against hostile or
corrupt inputs and write-side failures.

Every failure here must be a controlled ERROR line naming the file, field
path, index, and violated rule only — never input-supplied values (which
can carry credentials, PANs, or PII), never raw file content, and never a
traceback. Write-side failures (e.g. --output naming an existing file)
must be controlled the same way.

Each test file inserts ml/scripts onto sys.path itself (relative to its own
__file__) so `python -m unittest discover -s ml/tests` works from the repo
root without a shared conftest or installed package. Sensitive fixtures are
assembled at runtime so no credential- or token-shaped literal appears in
source (Gitleaks blocks even fake sk_live/AKIA-style strings).
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import prepare_byond_dataset  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def _run_script(script_name: str, args: list) -> subprocess.CompletedProcess:
    script_path = SCRIPTS_DIR / script_name
    return subprocess.run(
        [sys.executable, str(script_path)] + args,
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )


def _secret_token() -> str:
    """Runtime-assembled credential-shaped token (never a source literal)."""
    return "sk_" + "live_" + "Hostile123Token456"


def _credentialed_url() -> str:
    """Runtime-assembled URL with userinfo credentials."""
    password = "hun" + "ter2"
    return f"https://svc-user:{password}@cdn.example.com/captures/a.jpg"


# Sentinel distinguishing "no override supplied" from an explicit None
# override (an explicitly-null annotations key is itself a tested input).
_UNSET = object()


class _RpcRawMixin:
    """Writes the minimal valid RPC raw layout the end-to-end tests use,
    with per-test overrides for the hostile pieces."""

    CATEGORIES = [{"id": 7, "name": "Cola 330"}, {"id": 3, "name": "Chips 50"}]
    IMAGE_NAMES = {"train": "t1.jpg", "val": "v1.jpg", "test": "e1.jpg"}

    def _write_raw(
        self,
        raw: Path,
        *,
        train_categories: list = None,
        val_categories: list = None,
        train_annotations: list = None,
        train_images: list = None,
        val_annotations: object = _UNSET,
    ) -> None:
        for split, image_name in self.IMAGE_NAMES.items():
            image_dir = raw / f"{split}2019"
            image_dir.mkdir(parents=True, exist_ok=True)
            categories = list(self.CATEGORIES)
            if split == "train" and train_categories is not None:
                categories = train_categories
            if split == "val" and val_categories is not None:
                categories = val_categories
            images = [{"id": 1, "file_name": image_name}]
            if split == "train" and train_images is not None:
                images = train_images
            coco: dict = {
                "images": images,
                "categories": categories,
            }
            if split == "train":
                # The default annotation carries an `id`, like real RPC
                # exports do (prepare_rpc validates ids when present).
                coco["annotations"] = (
                    train_annotations
                    if train_annotations is not None
                    else [{"id": 1, "image_id": 1, "category_id": 7, "bbox": [1, 2, 3, 4]}]
                )
            if split == "val" and val_annotations is not _UNSET:
                coco["annotations"] = val_annotations
            (raw / f"instances_{split}2019.json").write_text(
                json.dumps(coco), encoding="utf-8"
            )
            (image_dir / image_name).write_text(f"pixels-{image_name}", encoding="utf-8")


class RpcHostileCocoValueTests(_RpcRawMixin, unittest.TestCase):
    """COCO files are untrusted input: huge numbers must not overflow into
    tracebacks and COCO-supplied values must never be echoed in errors."""

    def test_huge_int_bbox_is_controlled_error_not_traceback(self) -> None:
        # 10**309 overflows float conversion inside math.isfinite — must be
        # treated as non-finite and produce the normal bbox shape error.
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "raw"
            out = Path(tmp) / "out"
            self._write_raw(
                raw,
                train_annotations=[
                    {"image_id": 1, "category_id": 7, "bbox": [1, 2, 10**309, 4]}
                ],
            )
            result = _run_script(
                "prepare_rpc.py", ["--input", str(raw), "--output", str(out)]
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("ERROR", result.stdout)
            self.assertIn(
                "annotations[0].bbox values must be finite numbers", result.stdout
            )
            self.assertNotIn("OverflowError", result.stdout + result.stderr)
            self.assertNotIn("Traceback", result.stdout + result.stderr)
            self.assertFalse((out / "manifest.json").exists())

    def test_secret_shaped_category_id_rejected_without_echo(self) -> None:
        token = _secret_token()
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "raw"
            out = Path(tmp) / "out"
            self._write_raw(
                raw,
                train_categories=[
                    {"id": token, "name": "Cola 330"},
                    {"id": 3, "name": "Chips 50"},
                ],
            )
            result = _run_script(
                "prepare_rpc.py", ["--input", str(raw), "--output", str(out)]
            )
            combined = result.stdout + result.stderr
            self.assertEqual(result.returncode, 1)
            self.assertIn(
                "categories[0].id must be a non-negative integer", result.stdout
            )
            self.assertNotIn(token, combined)
            self.assertNotIn("sk_" + "live", combined)
            self.assertNotIn("Traceback", combined)
            self.assertFalse((out / "manifest.json").exists())

    def test_credential_bearing_val_category_name_rejected_without_echo(self) -> None:
        # A val split renaming a category to a credential-like string must be
        # a category-map mismatch error that names the integer id only —
        # never the COCO-supplied name (neither val's nor train's).
        secret_name = "hun" + "ter2"
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "raw"
            out = Path(tmp) / "out"
            self._write_raw(
                raw,
                val_categories=[
                    {"id": 7, "name": secret_name},
                    {"id": 3, "name": "Chips 50"},
                ],
            )
            result = _run_script(
                "prepare_rpc.py", ["--input", str(raw), "--output", str(out)]
            )
            combined = result.stdout + result.stderr
            self.assertEqual(result.returncode, 1)
            self.assertIn("instances_val2019.json", result.stdout)
            self.assertIn("categories do not match", result.stdout)
            self.assertIn("category id 7", result.stdout)
            self.assertNotIn(secret_name, combined)
            self.assertNotIn("Traceback", combined)
            self.assertFalse((out / "manifest.json").exists())


def _luhn_pan() -> str:
    """Runtime-assembled Luhn-valid 16-digit PAN (never a source literal)."""
    return "4111" + "1111" * 3


class PreparerSensitiveValueScreenTests(_RpcRawMixin, unittest.TestCase):
    """Values that would persist into a generated manifest or be echoed by
    downstream diagnostics — category names (before slugification mangles
    credential syntax), category/image ids in decimal form, image
    file_names, and SKU-110K CSV image names — are screened with the shared
    sensitive-value check. A hit is a controlled ERROR naming file, index,
    and field only; the value never reaches stdout/stderr and no manifest
    is written. Clean synthetic fixtures must still pass end-to-end."""

    def _run_rpc(self, tmp: Path, **overrides) -> tuple:
        raw = Path(tmp) / "raw"
        out = Path(tmp) / "out"
        self._write_raw(raw, **overrides)
        result = _run_script(
            "prepare_rpc.py", ["--input", str(raw), "--output", str(out)]
        )
        return result, out

    def _write_sku110k_raw(self, raw: Path, train_image_name: str) -> None:
        images_dir = raw / "images"
        images_dir.mkdir(parents=True)
        annotations_dir = raw / "annotations"
        annotations_dir.mkdir(parents=True)
        for split, image_name in (
            ("train", train_image_name),
            ("val", "b.jpg"),
            ("test", "c.jpg"),
        ):
            (annotations_dir / f"annotations_{split}.csv").write_text(
                f"{image_name},10,10,20,20,object,100,100\n", encoding="utf-8"
            )
            (images_dir / image_name).write_text(
                f"pixels-{split}", encoding="utf-8"
            )

    def test_sensitive_category_name_rejected_without_echo(self) -> None:
        # Slugification would turn "cvv=NNNN" into "cvv-nnnn" and hide the
        # credential syntax — the ORIGINAL name must be screened first.
        sensitive_name = "cv" + "v=" + "4242"
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_rpc(
                Path(tmp),
                train_categories=[
                    {"id": 7, "name": sensitive_name},
                    {"id": 3, "name": "Chips 50"},
                ],
            )
            combined = result.stdout + result.stderr
            self.assertEqual(result.returncode, 1)
            self.assertIn("instances_train2019.json", result.stdout)
            self.assertIn(
                "categories[0].name contains a sensitive-looking value",
                result.stdout,
            )
            self.assertNotIn(sensitive_name, combined)
            self.assertNotIn("Traceback", combined)
            self.assertFalse((out / "manifest.json").exists())

    def test_pan_integer_category_id_rejected_without_digits(self) -> None:
        pan = _luhn_pan()
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_rpc(
                Path(tmp),
                train_categories=[
                    {"id": int(pan), "name": "Cola 330"},
                    {"id": 3, "name": "Chips 50"},
                ],
            )
            combined = result.stdout + result.stderr
            self.assertEqual(result.returncode, 1)
            self.assertIn(
                "categories[0].id contains a sensitive-looking value",
                result.stdout,
            )
            self.assertNotIn(pan, combined)
            self.assertNotIn("Traceback", combined)
            self.assertFalse((out / "manifest.json").exists())

    def test_pan_integer_image_id_rejected_without_digits(self) -> None:
        pan = _luhn_pan()
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_rpc(
                Path(tmp),
                train_images=[{"id": int(pan), "file_name": "t1.jpg"}],
            )
            combined = result.stdout + result.stderr
            self.assertEqual(result.returncode, 1)
            self.assertIn(
                "images[0].id contains a sensitive-looking value", result.stdout
            )
            self.assertNotIn(pan, combined)
            self.assertNotIn("Traceback", combined)
            self.assertFalse((out / "manifest.json").exists())

    def test_pan_named_rpc_file_name_rejected_without_digits(self) -> None:
        pan = _luhn_pan()
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_rpc(
                Path(tmp),
                train_images=[{"id": 1, "file_name": f"{pan}.jpg"}],
            )
            combined = result.stdout + result.stderr
            self.assertEqual(result.returncode, 1)
            self.assertIn(
                "images[0].file_name contains a sensitive-looking value",
                result.stdout,
            )
            self.assertNotIn(pan, combined)
            self.assertNotIn("Traceback", combined)
            self.assertFalse((out / "manifest.json").exists())

    def test_pan_named_sku110k_csv_image_rejected_without_digits(self) -> None:
        pan = _luhn_pan()
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "raw"
            out = Path(tmp) / "out"
            self._write_sku110k_raw(raw, train_image_name=f"{pan}.jpg")
            result = _run_script(
                "prepare_sku110k.py", ["--input", str(raw), "--output", str(out)]
            )
            combined = result.stdout + result.stderr
            self.assertEqual(result.returncode, 1)
            self.assertIn("annotations/annotations_train.csv", result.stdout)
            self.assertIn(
                "row 1: image name contains a sensitive-looking value",
                result.stdout,
            )
            self.assertNotIn(pan, combined)
            self.assertNotIn("Traceback", combined)
            self.assertFalse((out / "manifest.json").exists())

    def test_valid_rpc_fixture_still_accepted_end_to_end(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_rpc(Path(tmp))
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("OK: wrote", result.stdout)
            self.assertTrue((out / "manifest.json").exists())

    def test_valid_sku110k_fixture_still_accepted_end_to_end(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "raw"
            out = Path(tmp) / "out"
            self._write_sku110k_raw(raw, train_image_name="a.jpg")
            result = _run_script(
                "prepare_sku110k.py", ["--input", str(raw), "--output", str(out)]
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("OK: wrote", result.stdout)
            self.assertTrue((out / "manifest.json").exists())


class HostileJsonNumberTests(_RpcRawMixin, unittest.TestCase):
    """Python 3.11+ raises a plain ValueError (not JSONDecodeError) when a
    JSON integer exceeds the 4300-digit int-conversion limit — every JSON
    load site must turn it into the controlled ERROR line, never a
    traceback, and never echo the digits."""

    HUGE_INT_JSON = '{"images": ' + "1" * 5000 + "}"

    def test_rpc_huge_integer_coco_json_is_controlled_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "raw"
            out = Path(tmp) / "out"
            self._write_raw(raw)
            (raw / "instances_train2019.json").write_text(
                self.HUGE_INT_JSON, encoding="utf-8"
            )
            result = _run_script(
                "prepare_rpc.py", ["--input", str(raw), "--output", str(out)]
            )
            combined = result.stdout + result.stderr
            self.assertEqual(result.returncode, 1)
            self.assertIn("ERROR", result.stdout)
            self.assertNotIn("Traceback", combined)
            self.assertNotIn("1" * 100, combined)
            self.assertFalse((out / "manifest.json").exists())

    def test_byond_huge_integer_manifest_json_is_controlled_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            input_dir = Path(tmp) / "input"
            (input_dir / "raw" / "shelves").mkdir(parents=True)
            (input_dir / "annotations").mkdir()
            (input_dir / "manifest.json").write_text(
                self.HUGE_INT_JSON, encoding="utf-8"
            )
            result = _run_script(
                "prepare_byond_dataset.py", ["--input", str(input_dir)]
            )
            combined = result.stdout + result.stderr
            self.assertEqual(result.returncode, 1)
            self.assertIn("ERROR", result.stdout)
            self.assertNotIn("Traceback", combined)
            self.assertNotIn("1" * 100, combined)


class Sku110kCorruptCsvTests(unittest.TestCase):
    """Unparseable or undecodable annotation CSVs must produce controlled
    ERROR lines naming the file and exception class only — never the raw
    bytes/cell content and never a traceback."""

    IMAGE_NAMES = {"train": "a.jpg", "val": "b.jpg", "test": "c.jpg"}

    def _write_raw(self, raw: Path, *, train_csv_bytes: bytes) -> None:
        images_dir = raw / "images"
        images_dir.mkdir(parents=True)
        annotations_dir = raw / "annotations"
        annotations_dir.mkdir(parents=True)
        for split, image_name in self.IMAGE_NAMES.items():
            csv_path = annotations_dir / f"annotations_{split}.csv"
            if split == "train":
                csv_path.write_bytes(train_csv_bytes)
            else:
                csv_path.write_text(
                    f"{image_name},10,10,20,20,object,100,100\n", encoding="utf-8"
                )
            (images_dir / image_name).write_text(f"pixels-{image_name}", encoding="utf-8")

    def _run_prepare(self, tmp: Path, train_csv_bytes: bytes) -> tuple:
        raw = tmp / "raw"
        out = tmp / "out"
        self._write_raw(raw, train_csv_bytes=train_csv_bytes)
        result = _run_script(
            "prepare_sku110k.py", ["--input", str(raw), "--output", str(out)]
        )
        return result, out

    def test_oversized_csv_cell_is_controlled_error(self) -> None:
        # A cell beyond the csv module's field-size limit (131072) raises
        # csv.Error mid-iteration; its content must never reach the logs.
        marker = "S3CR3TCELL"
        oversized_cell = marker * 30000  # 300k chars
        row = f"a.jpg,10,10,20,20,{oversized_cell},100,100\n".encode("utf-8")
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(Path(tmp), row)
            combined = result.stdout + result.stderr
            self.assertEqual(result.returncode, 1)
            self.assertIn("ERROR", result.stdout)
            self.assertIn("annotations/annotations_train.csv", result.stdout)
            self.assertIn("could not be parsed (Error)", result.stdout)
            self.assertNotIn(marker, combined)
            self.assertNotIn("Traceback", combined)
            self.assertFalse((out / "manifest.json").exists())

    def test_undecodable_csv_bytes_is_controlled_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(Path(tmp), b"\xff\xfe\xfa corrupt bytes")
            self.assertEqual(result.returncode, 1)
            self.assertIn("ERROR", result.stdout)
            self.assertIn("annotations/annotations_train.csv", result.stdout)
            self.assertIn("could not be read (UnicodeDecodeError)", result.stdout)
            self.assertNotIn("Traceback", result.stdout + result.stderr)
            self.assertFalse((out / "manifest.json").exists())


class OutputPathIsFileTests(_RpcRawMixin, unittest.TestCase):
    """--output pointing at an existing FILE must be a controlled ERROR from
    each preparer's mkdir/write guard (FileExistsError is the probed
    WinError 183 case) — exit 1, no traceback."""

    def _assert_controlled_write_error(self, result) -> None:
        self.assertEqual(result.returncode, 1)
        self.assertIn("ERROR", result.stdout)
        self.assertIn("could not write", result.stdout)
        self.assertIn("FileExistsError", result.stdout)
        self.assertNotIn("Traceback", result.stdout + result.stderr)

    def test_rpc_output_at_existing_file_is_controlled_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "raw"
            self._write_raw(raw)
            output_file = Path(tmp) / "not-a-dir"
            output_file.write_text("occupied", encoding="utf-8")
            result = _run_script(
                "prepare_rpc.py", ["--input", str(raw), "--output", str(output_file)]
            )
            self._assert_controlled_write_error(result)
            # The occupied path must be left untouched.
            self.assertEqual(output_file.read_text(encoding="utf-8"), "occupied")

    def test_sku110k_output_at_existing_file_is_controlled_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "raw"
            images_dir = raw / "images"
            images_dir.mkdir(parents=True)
            annotations_dir = raw / "annotations"
            annotations_dir.mkdir(parents=True)
            for split, image_name in (
                ("train", "a.jpg"),
                ("val", "b.jpg"),
                ("test", "c.jpg"),
            ):
                (annotations_dir / f"annotations_{split}.csv").write_text(
                    f"{image_name},10,10,20,20,object,100,100\n", encoding="utf-8"
                )
                (images_dir / image_name).write_text(
                    f"pixels-{image_name}", encoding="utf-8"
                )
            output_file = Path(tmp) / "not-a-dir"
            output_file.write_text("occupied", encoding="utf-8")
            result = _run_script(
                "prepare_sku110k.py",
                ["--input", str(raw), "--output", str(output_file)],
            )
            self._assert_controlled_write_error(result)
            self.assertEqual(output_file.read_text(encoding="utf-8"), "occupied")

    def test_byond_output_at_existing_file_is_controlled_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            input_dir = Path(tmp) / "input"
            (input_dir / "raw" / "shelves").mkdir(parents=True)
            (input_dir / "annotations").mkdir()
            (input_dir / "raw" / "shelves" / "a.jpg").touch()
            (input_dir / "annotations" / "a.json").write_text("{}", encoding="utf-8")
            (input_dir / "manifest.json").write_text(
                json.dumps(
                    {
                        "datasetName": "byond-store",
                        "datasetVersion": "1.0.0",
                        "source": "byond-custom",
                        "licenseNotes": "Internal BYOND store captures.",
                        "classes": [
                            {"classId": 0, "label": "cola-330", "sku": "SKU-1"}
                        ],
                        "splits": {
                            "train": [
                                {
                                    "image": "raw/shelves/a.jpg",
                                    "annotation": "annotations/a.json",
                                }
                            ],
                            "val": [],
                            "test": [],
                        },
                    }
                ),
                encoding="utf-8",
            )
            # Outside the repo, so the staging policy accepts it; only the
            # mkdir/write guard can reject.
            output_file = Path(tmp) / "not-a-dir"
            output_file.write_text("occupied", encoding="utf-8")
            result = _run_script(
                "prepare_byond_dataset.py",
                ["--input", str(input_dir), "--output", str(output_file)],
            )
            self._assert_controlled_write_error(result)
            self.assertEqual(output_file.read_text(encoding="utf-8"), "occupied")


class ByondCredentialedPathRedactionTests(unittest.TestCase):
    """The byond-specific layout checks run on arbitrary manifest strings
    (they make no assumption the base validator's bad-path gate passed), so
    a rejected value can be a credentialed URL — the error must name the
    field path and rule only, never the value."""

    def _byond_manifest(self) -> dict:
        return {
            "datasetName": "byond-store",
            "datasetVersion": "1.0.0",
            "source": "byond-custom",
            "licenseNotes": "Internal BYOND store captures.",
            "classes": [{"classId": 0, "label": "cola-330", "sku": "SKU-1"}],
            "splits": {
                "train": [
                    {"image": "raw/shelves/a.jpg", "annotation": "annotations/a.json"}
                ],
                "val": [],
                "test": [],
            },
        }

    def test_credentialed_url_image_layout_error_without_url(self) -> None:
        url = _credentialed_url()
        manifest = self._byond_manifest()
        manifest["splits"]["train"][0]["image"] = url
        errors = prepare_byond_dataset._extra_byond_checks(manifest)
        self.assertIn("splits.train[0].image must live under 'raw/'", errors)
        self.assertFalse(any(url in e for e in errors), errors)
        self.assertFalse(any("hun" + "ter2" in e for e in errors), errors)

    def test_credentialed_url_split_annotation_layout_error_without_url(self) -> None:
        url = _credentialed_url()
        manifest = self._byond_manifest()
        manifest["annotations"] = {"val": url}
        errors = prepare_byond_dataset._extra_byond_checks(manifest)
        self.assertIn("annotations.val must live under 'annotations/'", errors)
        self.assertFalse(any(url in e for e in errors), errors)
        self.assertFalse(any("hun" + "ter2" in e for e in errors), errors)

    def test_credentialed_url_sample_annotation_layout_error_without_url(self) -> None:
        url = _credentialed_url()
        manifest = self._byond_manifest()
        manifest["splits"]["train"][0]["annotation"] = url
        errors = prepare_byond_dataset._extra_byond_checks(manifest)
        self.assertIn("splits.train[0].annotation must live under 'annotations/'", errors)
        self.assertFalse(any(url in e for e in errors), errors)
        self.assertFalse(any("hun" + "ter2" in e for e in errors), errors)


class RpcNullAnnotationsKeyTests(_RpcRawMixin, unittest.TestCase):
    """An `annotations` key that is PRESENT must hold a list: an explicit
    null (JSON `"annotations": null`) is not the same as an omitted key and
    must be a controlled shape error. Only a truly absent key marks an
    unlabeled val/test split."""

    def _run_rpc(self, tmp: Path, **overrides) -> tuple:
        raw = Path(tmp) / "raw"
        out = Path(tmp) / "out"
        self._write_raw(raw, **overrides)
        result = _run_script(
            "prepare_rpc.py", ["--input", str(raw), "--output", str(out)]
        )
        return result, out

    def test_val_with_null_annotations_key_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_rpc(Path(tmp), val_annotations=None)
            combined = result.stdout + result.stderr
            self.assertEqual(result.returncode, 1)
            self.assertIn("instances_val2019.json", result.stdout)
            self.assertIn(
                "annotations must be a list when present", result.stdout
            )
            self.assertNotIn("Traceback", combined)
            self.assertFalse((out / "manifest.json").exists())

    def test_val_without_annotations_key_accepted(self) -> None:
        # The default fixture writes val/test WITHOUT the annotations key —
        # a truly absent key stays a valid unlabeled evaluation split.
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_rpc(Path(tmp))
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("OK: wrote", result.stdout)
            self.assertTrue((out / "manifest.json").exists())


class RpcAnnotationIdTests(_RpcRawMixin, unittest.TestCase):
    """Annotation `id`s are required and must be usable by standard COCO
    consumers that key annotations on them: present, non-bool integers,
    screened for PAN-likeness like category/image ids, and unique within
    the file."""

    def _run_rpc(self, tmp: Path, train_annotations: list) -> tuple:
        raw = Path(tmp) / "raw"
        out = Path(tmp) / "out"
        self._write_raw(raw, train_annotations=train_annotations)
        result = _run_script(
            "prepare_rpc.py", ["--input", str(raw), "--output", str(out)]
        )
        return result, out

    def test_missing_annotation_id_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_rpc(
                Path(tmp),
                [{"image_id": 1, "category_id": 7, "bbox": [1, 2, 3, 4]}],
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("annotations[0].id is required", result.stdout)
            self.assertNotIn("Traceback", result.stdout + result.stderr)
            self.assertFalse((out / "manifest.json").exists())

    def test_boolean_annotation_id_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_rpc(
                Path(tmp),
                [{"id": True, "image_id": 1, "category_id": 7, "bbox": [1, 2, 3, 4]}],
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("instances_train2019.json", result.stdout)
            self.assertIn("annotations[0].id must be an integer", result.stdout)
            self.assertNotIn("Traceback", result.stdout + result.stderr)
            self.assertFalse((out / "manifest.json").exists())

    def test_non_integer_annotation_id_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_rpc(
                Path(tmp),
                [{"id": "a-1", "image_id": 1, "category_id": 7, "bbox": [1, 2, 3, 4]}],
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("annotations[0].id must be an integer", result.stdout)
            self.assertNotIn("Traceback", result.stdout + result.stderr)
            self.assertFalse((out / "manifest.json").exists())

    def test_duplicate_annotation_ids_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_rpc(
                Path(tmp),
                [
                    {"id": 5, "image_id": 1, "category_id": 7, "bbox": [1, 2, 3, 4]},
                    {"id": 5, "image_id": 1, "category_id": 3, "bbox": [1, 2, 3, 4]},
                ],
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("instances_train2019.json", result.stdout)
            self.assertIn(
                "annotations[1].id duplicates annotations[0].id", result.stdout
            )
            self.assertNotIn("Traceback", result.stdout + result.stderr)
            self.assertFalse((out / "manifest.json").exists())

    def test_pan_like_annotation_id_rejected_without_digits(self) -> None:
        pan = _luhn_pan()
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_rpc(
                Path(tmp),
                [
                    {
                        "id": int(pan),
                        "image_id": 1,
                        "category_id": 7,
                        "bbox": [1, 2, 3, 4],
                    }
                ],
            )
            combined = result.stdout + result.stderr
            self.assertEqual(result.returncode, 1)
            self.assertIn(
                "annotations[0].id contains a sensitive-looking value",
                result.stdout,
            )
            self.assertNotIn(pan, combined)
            self.assertNotIn("Traceback", combined)
            self.assertFalse((out / "manifest.json").exists())

    def test_valid_unique_annotation_ids_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_rpc(
                Path(tmp),
                [
                    {"id": 1, "image_id": 1, "category_id": 7, "bbox": [10, 20, 30, 40]},
                    {"id": 2, "image_id": 1, "category_id": 3, "bbox": [5.5, 6.5, 7.5, 8.5]},
                ],
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("OK: wrote", result.stdout)
            self.assertTrue((out / "manifest.json").exists())


class _Sku110kRawMixin:
    """Writes the minimal valid SKU-110K raw layout with per-split CSV
    content overrides (image placeholder files always exist)."""

    IMAGE_NAMES = {"train": "a.jpg", "val": "b.jpg", "test": "c.jpg"}

    def _write_raw(self, raw: Path, *, csv_overrides: dict = None) -> None:
        overrides = csv_overrides or {}
        images_dir = raw / "images"
        images_dir.mkdir(parents=True)
        annotations_dir = raw / "annotations"
        annotations_dir.mkdir(parents=True)
        for split, image_name in self.IMAGE_NAMES.items():
            content = overrides.get(
                split, f"{image_name},10,10,20,20,object,100,100\n"
            )
            (annotations_dir / f"annotations_{split}.csv").write_text(
                content, encoding="utf-8"
            )
            (images_dir / image_name).write_text(
                f"pixels-{image_name}", encoding="utf-8"
            )

    def _run_prepare(self, tmp: Path, *, csv_overrides: dict = None) -> tuple:
        raw = tmp / "raw"
        out = tmp / "out"
        self._write_raw(raw, csv_overrides=csv_overrides)
        result = _run_script(
            "prepare_sku110k.py", ["--input", str(raw), "--output", str(out)]
        )
        return result, out


class Sku110kEmptyTrainSplitTests(_Sku110kRawMixin, unittest.TestCase):
    """An annotations_train.csv yielding zero annotation rows must be a
    controlled ERROR naming the file — never an OK manifest with an empty
    training split. Empty val/test CSVs stay accepted (the base manifest
    rule only requires a non-empty train split)."""

    def test_empty_train_csv_with_populated_val_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp), csv_overrides={"train": ""}
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("ERROR", result.stdout)
            self.assertIn("annotations_train.csv", result.stdout)
            self.assertIn("training split has no annotation rows", result.stdout)
            self.assertNotIn("Traceback", result.stdout + result.stderr)
            self.assertFalse((out / "manifest.json").exists())

    def test_blank_lines_only_train_csv_rejected(self) -> None:
        # Blank lines are skipped silently by the row parser, so a file of
        # nothing but blank lines also yields an empty training split.
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp), csv_overrides={"train": "\n\n\n"}
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("annotations_train.csv", result.stdout)
            self.assertIn("training split has no annotation rows", result.stdout)
            self.assertFalse((out / "manifest.json").exists())

    def test_empty_val_csv_still_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(Path(tmp), csv_overrides={"val": ""})
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("OK: wrote", result.stdout)
            manifest = json.loads(
                (out / "manifest.json").read_text(encoding="utf-8")
            )
            self.assertEqual(manifest["splits"]["val"], [])
            self.assertEqual(len(manifest["splits"]["train"]), 1)


class Sku110kClassColumnTests(_Sku110kRawMixin, unittest.TestCase):
    """Column 6 must carry SKU-110K's published class value `object` —
    an empty or different value means the file is not a SKU-110K export.
    The rejected cell content is never echoed."""

    def test_empty_class_value_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp),
                csv_overrides={"train": "a.jpg,10,10,20,20,,100,100\n"},
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("annotations/annotations_train.csv", result.stdout)
            self.assertIn("row 1: unexpected class value", result.stdout)
            self.assertNotIn("Traceback", result.stdout + result.stderr)
            self.assertFalse((out / "manifest.json").exists())

    def test_wrong_class_value_rejected_without_echo(self) -> None:
        marker = "NOTOBJECT77"
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp),
                csv_overrides={"train": f"a.jpg,10,10,20,20,{marker},100,100\n"},
            )
            combined = result.stdout + result.stderr
            self.assertEqual(result.returncode, 1)
            self.assertIn("annotations/annotations_train.csv", result.stdout)
            self.assertIn("row 1: unexpected class value", result.stdout)
            self.assertNotIn(marker, combined)
            self.assertNotIn("Traceback", combined)
            self.assertFalse((out / "manifest.json").exists())

    def test_object_class_value_accepted_end_to_end(self) -> None:
        # The default fixture rows carry the published `object` class value.
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(Path(tmp))
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("OK: wrote", result.stdout)
            self.assertTrue((out / "manifest.json").exists())


if __name__ == "__main__":
    unittest.main()
