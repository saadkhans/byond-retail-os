"""Tests for ml/scripts/validate_dataset_manifest.py and the three prepare_*
scripts' dry-run / failure contracts.

Each test file inserts ml/scripts onto sys.path itself (relative to its own
__file__) so `python -m unittest discover -s ml/tests` works from the repo
root without a shared conftest or installed package.
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

from validate_dataset_manifest import validate_manifest  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
EXAMPLES_DIR = REPO_ROOT / "ml" / "examples"
CONFIGS_DIR = REPO_ROOT / "ml" / "configs"


def _valid_manifest() -> dict:
    return {
        "datasetName": "example-dataset",
        "datasetVersion": "1.0.0",
        "source": "rpc",
        "licenseNotes": "Synthetic test fixture.",
        "classes": [
            {"classId": 0, "label": "cola-330"},
            {"classId": 1, "label": "chips-50"},
        ],
        "splits": {
            "train": [{"image": "images/a.jpg"}],
            "val": [],
            "test": [],
        },
    }


class DatasetSchemaFileTests(unittest.TestCase):
    def test_schema_parses_and_is_closed(self) -> None:
        schema = json.loads((CONFIGS_DIR / "dataset.schema.json").read_text(encoding="utf-8"))
        self.assertIn("$schema", schema)
        self.assertIn("title", schema)
        self.assertFalse(schema.get("additionalProperties", True))
        sample_schema = schema["definitions"]["sample"]
        self.assertFalse(sample_schema.get("additionalProperties", True))

    def test_sample_manifest_parses_and_validates_cleanly(self) -> None:
        manifest = json.loads((EXAMPLES_DIR / "sample_dataset_manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(validate_manifest(manifest), [])


class RequiredFieldTests(unittest.TestCase):
    def test_missing_required_fields_are_reported(self) -> None:
        for field in ("datasetName", "datasetVersion", "source", "licenseNotes", "classes", "splits"):
            with self.subTest(field=field):
                manifest = _valid_manifest()
                del manifest[field]
                errors = validate_manifest(manifest)
                self.assertTrue(any(field in e for e in errors), errors)


class FieldRuleTests(unittest.TestCase):
    def test_duplicate_class_id_rejected(self) -> None:
        manifest = _valid_manifest()
        manifest["classes"][1]["classId"] = 0
        errors = validate_manifest(manifest)
        self.assertTrue(any("classId" in e and "duplicate" in e for e in errors), errors)

    def test_bad_sku_pattern_rejected(self) -> None:
        manifest = _valid_manifest()
        manifest["classes"][0]["sku"] = "bad sku!"
        errors = validate_manifest(manifest)
        self.assertTrue(any("sku" in e for e in errors), errors)

    def test_byond_custom_class_missing_sku_rejected(self) -> None:
        manifest = _valid_manifest()
        manifest["source"] = "byond-custom"
        for cls in manifest["classes"]:
            cls.pop("sku", None)
        errors = validate_manifest(manifest)
        self.assertTrue(any("sku is required" in e for e in errors), errors)

    def test_absolute_image_path_rejected(self) -> None:
        manifest = _valid_manifest()
        manifest["splits"]["train"][0]["image"] = "/etc/passwd"
        errors = validate_manifest(manifest)
        self.assertTrue(any("image" in e for e in errors), errors)

    def test_parent_traversal_image_path_rejected(self) -> None:
        manifest = _valid_manifest()
        manifest["splits"]["train"][0]["image"] = "../secret.jpg"
        errors = validate_manifest(manifest)
        self.assertTrue(any("image" in e for e in errors), errors)

    def test_bad_capture_context_rejected(self) -> None:
        manifest = _valid_manifest()
        manifest["splits"]["train"][0]["captureContext"] = "warehouse"
        errors = validate_manifest(manifest)
        self.assertTrue(any("captureContext" in e for e in errors), errors)

    def test_unknown_top_level_key_rejected(self) -> None:
        manifest = _valid_manifest()
        manifest["extraField"] = True
        errors = validate_manifest(manifest)
        self.assertTrue(any("extraField" in e for e in errors), errors)

    def test_unknown_sample_key_rejected(self) -> None:
        manifest = _valid_manifest()
        manifest["splits"]["train"][0]["unexpected"] = True
        errors = validate_manifest(manifest)
        self.assertTrue(any("unexpected" in e for e in errors), errors)


class CheckFilesTests(unittest.TestCase):
    def test_missing_referenced_file_is_named(self) -> None:
        manifest = _valid_manifest()
        with tempfile.TemporaryDirectory() as tmp:
            errors = validate_manifest(manifest, base_dir=Path(tmp), check_files=True)
            self.assertTrue(any("images/a.jpg" in e for e in errors), errors)

    def test_all_referenced_files_present_is_clean(self) -> None:
        manifest = _valid_manifest()
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            image_path = base / "images" / "a.jpg"
            image_path.parent.mkdir(parents=True, exist_ok=True)
            image_path.touch()
            errors = validate_manifest(manifest, base_dir=base, check_files=True)
            self.assertEqual(errors, [])


class PrepareScriptDryRunTests(unittest.TestCase):
    """Dry runs must require nothing on disk and write nothing."""

    def _run(self, script_name: str, args: list) -> subprocess.CompletedProcess:
        script_path = SCRIPTS_DIR / script_name
        return subprocess.run(
            [sys.executable, str(script_path)] + args,
            capture_output=True,
            text=True,
            cwd=str(REPO_ROOT),
        )

    def test_prepare_rpc_dry_run_needs_nothing_on_disk(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = str(Path(tmp) / "out")
            result = self._run("prepare_rpc.py", ["--dry-run", "--output", output])
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(Path(output).exists())

    def test_prepare_sku110k_dry_run_needs_nothing_on_disk(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = str(Path(tmp) / "out")
            result = self._run("prepare_sku110k.py", ["--dry-run", "--output", output])
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(Path(output).exists())

    def test_prepare_byond_dataset_dry_run_needs_nothing_on_disk(self) -> None:
        result = self._run("prepare_byond_dataset.py", ["--dry-run"])
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_prepare_rpc_non_dry_run_against_empty_input_fails_helpfully(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            empty_input = Path(tmp) / "input"
            empty_input.mkdir()
            output = Path(tmp) / "output"
            result = self._run("prepare_rpc.py", ["--input", str(empty_input), "--output", str(output)])
            self.assertEqual(result.returncode, 1)
            self.assertIn("train2019", result.stdout)


if __name__ == "__main__":
    unittest.main()
