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
    ) -> None:
        for split, image_name in self.IMAGE_NAMES.items():
            image_dir = raw / f"{split}2019"
            image_dir.mkdir(parents=True, exist_ok=True)
            categories = list(self.CATEGORIES)
            if split == "train" and train_categories is not None:
                categories = train_categories
            if split == "val" and val_categories is not None:
                categories = val_categories
            coco: dict = {
                "images": [{"id": 1, "file_name": image_name}],
                "categories": categories,
            }
            if split == "train":
                coco["annotations"] = (
                    train_annotations
                    if train_annotations is not None
                    else [{"image_id": 1, "category_id": 7, "bbox": [1, 2, 3, 4]}]
                )
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


if __name__ == "__main__":
    unittest.main()
