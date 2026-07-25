"""Tests for ml/scripts/validate_dataset_manifest.py and the three prepare_*
scripts' dry-run / failure contracts.

Each test file inserts ml/scripts onto sys.path itself (relative to its own
__file__) so `python -m unittest discover -s ml/tests` works from the repo
root without a shared conftest or installed package.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import prepare_byond_dataset  # noqa: E402
import prepare_rpc  # noqa: E402
import prepare_sku110k  # noqa: E402
import validate_dataset_manifest  # noqa: E402
from validate_dataset_manifest import validate_manifest  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
EXAMPLES_DIR = REPO_ROOT / "ml" / "examples"
CONFIGS_DIR = REPO_ROOT / "ml" / "configs"


def _run_script(script_name: str, args: list) -> subprocess.CompletedProcess:
    script_path = SCRIPTS_DIR / script_name
    return subprocess.run(
        [sys.executable, str(script_path)] + args,
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )


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

    def test_non_contiguous_class_ids_rejected(self) -> None:
        manifest = _valid_manifest()
        manifest["classes"][1]["classId"] = 2
        errors = validate_manifest(manifest)
        self.assertTrue(
            any("contiguous zero-based classId" in e for e in errors), errors
        )

    def test_single_class_with_high_class_id_rejected(self) -> None:
        manifest = _valid_manifest()
        manifest["classes"] = [{"classId": 999, "label": "cola-330"}]
        errors = validate_manifest(manifest)
        self.assertTrue(
            any("contiguous zero-based classId" in e for e in errors), errors
        )

    def test_contiguous_class_ids_accepted(self) -> None:
        manifest = _valid_manifest()
        self.assertEqual(
            sorted(cls["classId"] for cls in manifest["classes"]), [0, 1]
        )
        self.assertEqual(validate_manifest(manifest), [])

    def test_valid_source_ids_accepted(self) -> None:
        manifest = _valid_manifest()
        manifest["classes"][0]["sourceId"] = 7
        manifest["classes"][1]["sourceId"] = 3
        self.assertEqual(validate_manifest(manifest), [])

    def test_duplicate_source_id_rejected(self) -> None:
        manifest = _valid_manifest()
        manifest["classes"][0]["sourceId"] = 5
        manifest["classes"][1]["sourceId"] = 5
        errors = validate_manifest(manifest)
        self.assertTrue(
            any("sourceId" in e and "duplicates" in e for e in errors), errors
        )

    def test_non_int_source_id_rejected(self) -> None:
        for bad in ("7", True, -1, 1.5, None):
            with self.subTest(bad=bad):
                manifest = _valid_manifest()
                manifest["classes"][0]["sourceId"] = bad
                errors = validate_manifest(manifest)
                self.assertTrue(
                    any("sourceId must be an integer >= 0" in e for e in errors), errors
                )

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

    def test_dot_segment_image_path_rejected(self) -> None:
        manifest = _valid_manifest()
        manifest["splits"]["train"][0]["image"] = "images/./a.jpg"
        errors = validate_manifest(manifest)
        self.assertTrue(any("splits.train[0].image" in e for e in errors), errors)
        # Rejected path values are never echoed — only field + rule.
        self.assertFalse(any("images/./a.jpg" in e for e in errors), errors)

    def test_empty_segment_image_path_rejected(self) -> None:
        manifest = _valid_manifest()
        manifest["splits"]["train"][0]["image"] = "images//a.jpg"
        errors = validate_manifest(manifest)
        self.assertTrue(any("splits.train[0].image" in e for e in errors), errors)
        self.assertFalse(any("images//a.jpg" in e for e in errors), errors)

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


class SensitiveSkuScreeningTests(unittest.TestCase):
    """A Luhn-valid payment-card number (or a known credential-token format)
    matches SKU_PATTERN, but the VisionEvent mapper would reject it at
    emission time — the manifest validator must reject it up front, and its
    error must never echo the value."""

    PAN_SKU = "4111111111111111"  # Luhn-valid test PAN; matches SKU_PATTERN.

    def test_luhn_valid_pan_sku_rejected_without_echo(self) -> None:
        self.assertIsNotNone(validate_dataset_manifest.SKU_PATTERN.match(self.PAN_SKU))
        manifest = _valid_manifest()
        manifest["classes"][0]["sku"] = self.PAN_SKU
        errors = validate_manifest(manifest)
        self.assertIn("classes[0].sku contains a sensitive-looking value", errors)
        self.assertFalse(any(self.PAN_SKU in e for e in errors), errors)

    def test_credential_token_sku_rejected_without_echo(self) -> None:
        # Cloud access-key-id formats are uppercase alphanumeric, so they pass
        # SKU_PATTERN and must be caught by the sensitive-value screen. The
        # fixture is assembled at runtime so no key-shaped literal ever
        # appears in source (Gitleaks blocks even fake AKIA-style strings).
        sku = "AKI" + "A" + "ABCDEFGHIJKLMNOP"
        self.assertIsNotNone(validate_dataset_manifest.SKU_PATTERN.match(sku))
        manifest = _valid_manifest()
        manifest["classes"][0]["sku"] = sku
        errors = validate_manifest(manifest)
        self.assertIn("classes[0].sku contains a sensitive-looking value", errors)
        self.assertFalse(any(sku in e for e in errors), errors)

    def test_duplicate_pan_shaped_skus_rejected_without_echo(self) -> None:
        # Runtime-assembled Luhn-valid PAN shared by two classes: the
        # duplicate error must name only the field paths — no digits from
        # the SKU may appear in ANY reported error.
        pan = "4111" * 4
        manifest = _valid_manifest()
        manifest["classes"][0]["sku"] = pan
        manifest["classes"][1]["sku"] = pan
        errors = validate_manifest(manifest)
        self.assertIn("classes[1].sku duplicates classes[0].sku", errors)
        self.assertFalse(any("4111" in e for e in errors), errors)

    def test_normal_retail_sku_accepted(self) -> None:
        manifest = _valid_manifest()
        manifest["classes"][0]["sku"] = "COLA-330"
        self.assertEqual(validate_manifest(manifest), [])

    def test_cli_rejects_pan_sku_without_echoing_it(self) -> None:
        manifest = _valid_manifest()
        manifest["classes"][0]["sku"] = self.PAN_SKU
        with tempfile.TemporaryDirectory() as tmp:
            manifest_path = Path(tmp) / "manifest.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            result = _run_script("validate_dataset_manifest.py", [str(manifest_path)])
            self.assertEqual(result.returncode, 1)
            self.assertIn("contains a sensitive-looking value", result.stdout)
            self.assertNotIn(self.PAN_SKU, result.stdout + result.stderr)


class SensitiveClassValueRedactionTests(unittest.TestCase):
    """classes[].label gets the same sensitive-value screening as SKUs (an
    all-digit Luhn PAN satisfies SLUG_PATTERN), and classId/sourceId errors
    must report field + expected shape only — never a manifest-supplied
    value. Sensitive fixtures are assembled at runtime so no PAN-shaped
    literal appears in source."""

    def test_pan_shaped_label_rejected_without_echo(self) -> None:
        pan = "4111" * 4  # all-digit, satisfies SLUG_PATTERN
        self.assertIsNotNone(validate_dataset_manifest.SLUG_PATTERN.match(pan))
        manifest = _valid_manifest()
        manifest["classes"][0]["label"] = pan
        errors = validate_manifest(manifest)
        self.assertIn("classes[0].label contains a sensitive-looking value", errors)
        self.assertFalse(any("4111" in e for e in errors), errors)

    def test_normal_slug_label_accepted(self) -> None:
        manifest = _valid_manifest()
        manifest["classes"][0]["label"] = "cola-classic-330"
        self.assertEqual(validate_manifest(manifest), [])

    def test_string_class_id_with_pan_digits_rejected_without_echo(self) -> None:
        manifest = _valid_manifest()
        manifest["classes"][0]["classId"] = "4111" * 4
        errors = validate_manifest(manifest)
        self.assertIn("classes[0].classId must be an integer >= 0", errors)
        self.assertFalse(any("4111" in e for e in errors), errors)

    def test_duplicate_class_id_error_is_index_based_without_value(self) -> None:
        pan_like = int("4111" * 4)
        manifest = _valid_manifest()
        manifest["classes"][0]["classId"] = pan_like
        manifest["classes"][1]["classId"] = pan_like
        errors = validate_manifest(manifest)
        self.assertIn("classes[1].classId duplicates classes[0].classId", errors)
        self.assertFalse(any("4111" in e for e in errors), errors)

    def test_duplicate_source_id_error_is_index_based_without_value(self) -> None:
        pan_like = int("4111" * 4)
        manifest = _valid_manifest()
        manifest["classes"][0]["sourceId"] = pan_like
        manifest["classes"][1]["sourceId"] = pan_like
        errors = validate_manifest(manifest)
        self.assertIn("classes[1].sourceId duplicates classes[0].sourceId", errors)
        self.assertFalse(any("4111" in e for e in errors), errors)


class RejectedValueRedactionTests(unittest.TestCase):
    """Errors for REJECTED enum values, REJECTED paths, and non-string path
    junk must name the field + rule only — never the supplied value. A bad
    `source` or path can be a credentialed camera/CDN URL and a bad
    captureContext can be a pasted secret token. (Sensitive fixtures are
    assembled at runtime so no credential-shaped literal appears in source.)"""

    @staticmethod
    def _credentialed_url() -> str:
        password = "hun" + "ter2"
        return f"rtsp://svc-user:{password}@camera.internal/stream1"

    @staticmethod
    def _secret_token() -> str:
        return "sk_" + "live_" + "Abc123Def456Ghi789"

    @staticmethod
    def _token_image_url() -> str:
        return "https://cdn.example.com/images/a.jpg?access_" + "token=deadbeef42cafe"

    def _assert_absent(self, needle: str, errors: list) -> None:
        self.assertFalse(any(needle in e for e in errors), errors)

    def test_credentialed_url_source_rejected_without_echo(self) -> None:
        url = self._credentialed_url()
        manifest = _valid_manifest()
        manifest["source"] = url
        errors = validate_manifest(manifest)
        self.assertTrue(any("source must be one of" in e for e in errors), errors)
        self._assert_absent(url, errors)
        self._assert_absent("hunter2", errors)

    def test_secret_token_capture_context_rejected_without_echo(self) -> None:
        token = self._secret_token()
        manifest = _valid_manifest()
        manifest["splits"]["train"][0]["captureContext"] = token
        errors = validate_manifest(manifest)
        self.assertTrue(
            any("captureContext must be one of" in e for e in errors), errors
        )
        self._assert_absent(token, errors)

    def test_credentialed_url_split_annotation_rejected_without_echo(self) -> None:
        url = self._credentialed_url()
        manifest = _valid_manifest()
        manifest["annotations"] = {"train": url}
        errors = validate_manifest(manifest)
        self.assertTrue(any("annotations.train" in e for e in errors), errors)
        self._assert_absent(url, errors)
        self._assert_absent("hunter2", errors)

    def test_token_url_sample_image_rejected_without_echo(self) -> None:
        url = self._token_image_url()
        manifest = _valid_manifest()
        manifest["splits"]["train"][0]["image"] = url
        errors = validate_manifest(manifest)
        self.assertTrue(any("splits.train[0].image" in e for e in errors), errors)
        self._assert_absent(url, errors)
        self._assert_absent("deadbeef42cafe", errors)

    def test_credentialed_url_sample_annotation_rejected_without_echo(self) -> None:
        url = self._credentialed_url()
        manifest = _valid_manifest()
        manifest["splits"]["train"][0]["annotation"] = url
        errors = validate_manifest(manifest)
        self.assertTrue(any("splits.train[0].annotation" in e for e in errors), errors)
        self._assert_absent(url, errors)
        self._assert_absent("hunter2", errors)

    def test_non_string_source_root_error_has_no_repr(self) -> None:
        manifest = _valid_manifest()
        manifest["sourceRoot"] = ["../secret-dir"]
        errors = validate_manifest(manifest)
        self.assertIn("sourceRoot must be a non-empty string", errors)
        self._assert_absent("secret-dir", errors)
        self._assert_absent("[", errors)

    def test_normal_enum_and_path_values_still_accepted(self) -> None:
        manifest = _valid_manifest()
        manifest["source"] = "byond-custom"
        manifest["classes"][0]["sku"] = "COLA-330"
        manifest["classes"][1]["sku"] = "CHIPS-50"
        manifest["sourceRoot"] = "../raw"
        manifest["annotations"] = {"train": "annotations/train.json"}
        manifest["splits"]["train"][0]["annotation"] = "annotations/a.json"
        manifest["splits"]["train"][0]["captureContext"] = "shelf"
        self.assertEqual(validate_manifest(manifest), [])


class SensitiveMetadataScreeningTests(unittest.TestCase):
    """datasetName and the tenant metadata fields (labels.* and per-sample
    tenantId/storeId/planogramZone) are free-form strings a Luhn-valid PAN or
    credential token would silently satisfy — each must fail validation with
    a redacted error that never carries the value. (PAN fixtures are
    assembled at runtime so no card-shaped literal appears in source.)"""

    @staticmethod
    def _pan() -> str:
        return "4111" * 4  # Luhn-valid test PAN, also a valid slug.

    def _assert_no_digits(self, errors: list) -> None:
        self.assertFalse(any("4111" in e for e in errors), errors)

    def test_pan_dataset_name_rejected_without_echo(self) -> None:
        pan = self._pan()
        self.assertIsNotNone(validate_dataset_manifest.SLUG_PATTERN.match(pan))
        manifest = _valid_manifest()
        manifest["datasetName"] = pan
        errors = validate_manifest(manifest)
        self.assertIn("datasetName contains a sensitive-looking value", errors)
        self._assert_no_digits(errors)

    def test_cli_rejects_pan_dataset_name_without_echoing_digits(self) -> None:
        manifest = _valid_manifest()
        manifest["datasetName"] = self._pan()
        with tempfile.TemporaryDirectory() as tmp:
            manifest_path = Path(tmp) / "manifest.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            result = _run_script("validate_dataset_manifest.py", [str(manifest_path)])
            self.assertEqual(result.returncode, 1)
            self.assertIn(
                "datasetName contains a sensitive-looking value", result.stdout
            )
            self.assertNotIn("4111", result.stdout + result.stderr)

    def test_pan_labels_store_id_rejected_without_echo(self) -> None:
        manifest = _valid_manifest()
        manifest["labels"] = {"storeId": self._pan()}
        errors = validate_manifest(manifest)
        self.assertIn("labels.storeId contains a sensitive-looking value", errors)
        self._assert_no_digits(errors)

    def test_pan_labels_tenant_id_and_zone_rejected_without_echo(self) -> None:
        manifest = _valid_manifest()
        manifest["labels"] = {
            "tenantId": self._pan(),
            "planogramZone": "zone-" + self._pan(),
        }
        errors = validate_manifest(manifest)
        self.assertIn("labels.tenantId contains a sensitive-looking value", errors)
        self.assertIn(
            "labels.planogramZone contains a sensitive-looking value", errors
        )
        self._assert_no_digits(errors)

    def test_pan_sample_tenant_id_rejected_without_echo(self) -> None:
        manifest = _valid_manifest()
        manifest["splits"]["train"][0]["tenantId"] = self._pan()
        errors = validate_manifest(manifest)
        self.assertIn(
            "splits.train[0].tenantId contains a sensitive-looking value", errors
        )
        self._assert_no_digits(errors)

    def test_pan_sample_store_id_rejected_without_echo(self) -> None:
        manifest = _valid_manifest()
        manifest["splits"]["train"][0]["storeId"] = self._pan()
        errors = validate_manifest(manifest)
        self.assertIn(
            "splits.train[0].storeId contains a sensitive-looking value", errors
        )
        self._assert_no_digits(errors)

    def test_normal_metadata_values_accepted(self) -> None:
        manifest = _valid_manifest()
        manifest["labels"] = {
            "tenantId": "tenant-042",
            "storeId": "store-berlin-7",
            "planogramZone": "aisle-3-shelf-2",
        }
        manifest["splits"]["train"][0]["tenantId"] = "tenant-042"
        manifest["splits"]["train"][0]["storeId"] = "store-berlin-7"
        manifest["splits"]["train"][0]["planogramZone"] = "aisle-3-shelf-2"
        self.assertEqual(validate_manifest(manifest), [])


class NulPathRejectionTests(unittest.TestCase):
    """A path with an embedded NUL must fail shape validation even without
    --check-files (previously only sourceRoot carried a NUL guard)."""

    def test_nul_in_image_path_rejected_without_check_files(self) -> None:
        manifest = _valid_manifest()
        manifest["splits"]["train"][0]["image"] = "images/a\x00.jpg"
        errors = validate_manifest(manifest)
        self.assertTrue(any("splits.train[0].image" in e for e in errors), errors)

    def test_nul_in_sample_annotation_path_rejected_without_check_files(self) -> None:
        manifest = _valid_manifest()
        manifest["splits"]["train"][0]["annotation"] = "ann\x00.json"
        errors = validate_manifest(manifest)
        self.assertTrue(any("splits.train[0].annotation" in e for e in errors), errors)

    def test_nul_in_split_level_annotation_ref_rejected_without_check_files(self) -> None:
        manifest = _valid_manifest()
        manifest["annotations"] = {"train": "instances\x00.json"}
        errors = validate_manifest(manifest)
        self.assertTrue(any("annotations.train" in e for e in errors), errors)


class EnumTypeGuardTests(unittest.TestCase):
    """Unhashable enum values (list/dict) must yield validation errors, not
    TypeError from set-membership tests."""

    def test_source_as_list_reports_error_not_traceback(self) -> None:
        manifest = _valid_manifest()
        manifest["source"] = ["rpc"]
        errors = validate_manifest(manifest)
        self.assertTrue(any("source must be one of" in e for e in errors), errors)

    def test_capture_context_as_dict_reports_error_not_traceback(self) -> None:
        manifest = _valid_manifest()
        manifest["splits"]["train"][0]["captureContext"] = {"stage": "shelf"}
        errors = validate_manifest(manifest)
        self.assertTrue(any("captureContext" in e for e in errors), errors)

    def test_cli_on_unhashable_enum_values_exits_1_without_traceback(self) -> None:
        manifest = _valid_manifest()
        manifest["source"] = ["rpc"]
        manifest["splits"]["train"][0]["captureContext"] = {}
        with tempfile.TemporaryDirectory() as tmp:
            manifest_path = Path(tmp) / "manifest.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            result = _run_script("validate_dataset_manifest.py", [str(manifest_path)])
            self.assertEqual(result.returncode, 1)
            self.assertIn("ERROR", result.stdout)
            self.assertNotIn("Traceback", result.stdout + result.stderr)


class CrossSplitDuplicateTests(unittest.TestCase):
    def test_duplicate_image_within_split_rejected(self) -> None:
        manifest = _valid_manifest()
        manifest["splits"]["train"] = [{"image": "images/a.jpg"}, {"image": "images/a.jpg"}]
        errors = validate_manifest(manifest)
        self.assertTrue(
            any("splits.train[1].image duplicates splits.train[0].image" in e for e in errors),
            errors,
        )

    def test_duplicate_image_across_splits_rejected(self) -> None:
        manifest = _valid_manifest()
        manifest["splits"]["test"] = [{"image": "images/a.jpg"}]
        errors = validate_manifest(manifest)
        self.assertTrue(
            any("splits.test[0].image duplicates splits.train[0].image" in e for e in errors),
            errors,
        )

    def test_non_canonical_duplicate_across_splits_rejected(self) -> None:
        # "images/./a.jpg" in val is the same file as "images/a.jpg" in train;
        # the non-canonical spelling is rejected outright as a bad path, so it
        # can never bypass the exact-string cross-split overlap check.
        manifest = _valid_manifest()
        manifest["splits"]["val"] = [{"image": "images/./a.jpg"}]
        errors = validate_manifest(manifest)
        self.assertTrue(
            any("splits.val[0].image" in e for e in errors),
            errors,
        )
        # Rejected (non-canonical) path values are never echoed.
        self.assertFalse(any("images/./a.jpg" in e for e in errors), errors)

    def test_unique_images_across_splits_accepted(self) -> None:
        manifest = _valid_manifest()
        manifest["splits"]["val"] = [{"image": "images/b.jpg"}]
        manifest["splits"]["test"] = [{"image": "images/c.jpg"}]
        self.assertEqual(validate_manifest(manifest), [])


class SourceRootTests(unittest.TestCase):
    def test_source_root_accepted(self) -> None:
        manifest = _valid_manifest()
        manifest["sourceRoot"] = "../raw"
        self.assertEqual(validate_manifest(manifest), [])

    def test_non_string_source_root_rejected(self) -> None:
        for bad in (123, "", None, ["../raw"]):
            with self.subTest(bad=bad):
                manifest = _valid_manifest()
                manifest["sourceRoot"] = bad
                errors = validate_manifest(manifest)
                self.assertTrue(any("sourceRoot" in e for e in errors), errors)

    def test_main_resolves_relative_source_root_against_manifest_dir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            manifest = _valid_manifest()
            manifest["sourceRoot"] = "../raw"
            processed = base / "processed"
            processed.mkdir()
            manifest_path = processed / "manifest.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            image_path = base / "raw" / "images" / "a.jpg"
            image_path.parent.mkdir(parents=True, exist_ok=True)
            image_path.touch()

            result = _run_script(
                "validate_dataset_manifest.py", [str(manifest_path), "--check-files"]
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_main_source_root_resolution_reports_missing_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            manifest = _valid_manifest()
            manifest["sourceRoot"] = "../raw"
            processed = base / "processed"
            processed.mkdir()
            manifest_path = processed / "manifest.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            (base / "raw").mkdir()

            result = _run_script(
                "validate_dataset_manifest.py", [str(manifest_path), "--check-files"]
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("missing file: images/a.jpg", result.stdout)


class AnnotationsFieldTests(unittest.TestCase):
    def test_annotations_accepted(self) -> None:
        manifest = _valid_manifest()
        manifest["annotations"] = {"train": "instances_train2019.json"}
        self.assertEqual(validate_manifest(manifest), [])

    def test_annotations_unknown_key_rejected(self) -> None:
        manifest = _valid_manifest()
        manifest["annotations"] = {"holdout": "x.json"}
        errors = validate_manifest(manifest)
        self.assertTrue(any("annotations" in e and "holdout" in e for e in errors), errors)

    def test_annotations_bad_path_rejected(self) -> None:
        for bad in ("../escape.json", "/abs.json", 42):
            with self.subTest(bad=bad):
                manifest = _valid_manifest()
                manifest["annotations"] = {"train": bad}
                errors = validate_manifest(manifest)
                self.assertTrue(any("annotations.train" in e for e in errors), errors)

    def test_missing_annotation_file_reported_with_check_files(self) -> None:
        manifest = _valid_manifest()
        manifest["annotations"] = {"train": "instances_train2019.json"}
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            image_path = base / "images" / "a.jpg"
            image_path.parent.mkdir(parents=True, exist_ok=True)
            image_path.touch()
            errors = validate_manifest(manifest, base_dir=base, check_files=True)
            self.assertTrue(
                any("missing file: instances_train2019.json" in e for e in errors), errors
            )


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

    def test_directory_at_image_path_rejected(self) -> None:
        manifest = _valid_manifest()
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / "images" / "a.jpg").mkdir(parents=True)
            errors = validate_manifest(manifest, base_dir=base, check_files=True)
            self.assertTrue(
                any("not a regular file: images/a.jpg" in e for e in errors), errors
            )


class FilesystemAliasTests(unittest.TestCase):
    """check_files must reject two lexically distinct image refs that resolve
    to one underlying file (hardlink/symlink) — a hidden split overlap."""

    def _manifest_two_images(self) -> dict:
        manifest = _valid_manifest()
        manifest["splits"]["train"] = [{"image": "images/a.jpg"}]
        manifest["splits"]["val"] = [{"image": "images/b.jpg"}]
        return manifest

    def test_hardlinked_image_across_splits_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / "images").mkdir()
            original = base / "images" / "a.jpg"
            original.write_text("pixels-a", encoding="utf-8")
            try:
                os.link(str(original), str(base / "images" / "b.jpg"))
            except (OSError, NotImplementedError) as exc:
                self.skipTest(f"hardlinks unsupported on this platform/filesystem: {exc}")
            errors = validate_manifest(
                self._manifest_two_images(), base_dir=base, check_files=True
            )
            self.assertTrue(
                any(
                    "splits.val[0].image aliases splits.train[0].image "
                    "(same underlying file)" in e
                    for e in errors
                ),
                errors,
            )
            # The inode-alias pair must be reported once (as an alias), not a
            # second time by the content-digest check.
            self.assertFalse(any("duplicates content" in e for e in errors), errors)

    def test_symlinked_image_across_splits_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / "images").mkdir()
            original = base / "images" / "a.jpg"
            original.write_text("pixels-a", encoding="utf-8")
            try:
                os.symlink(str(original), str(base / "images" / "b.jpg"))
            except (OSError, NotImplementedError) as exc:
                # Windows may lack the symlink privilege.
                self.skipTest(f"symlinks unsupported on this platform/filesystem: {exc}")
            errors = validate_manifest(
                self._manifest_two_images(), base_dir=base, check_files=True
            )
            self.assertTrue(
                any(
                    "splits.val[0].image aliases splits.train[0].image "
                    "(same underlying file)" in e
                    for e in errors
                ),
                errors,
            )
            # An in-root symlink is a split-overlap alias, not an escape.
            self.assertFalse(any("escapes the source root" in e for e in errors), errors)
            self.assertFalse(any("duplicates content" in e for e in errors), errors)

    def test_distinct_files_across_splits_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / "images").mkdir()
            (base / "images" / "a.jpg").write_text("pixels-a", encoding="utf-8")
            (base / "images" / "b.jpg").write_text("pixels-b", encoding="utf-8")
            errors = validate_manifest(
                self._manifest_two_images(), base_dir=base, check_files=True
            )
            self.assertEqual(errors, [])


class SymlinkEscapeTests(unittest.TestCase):
    """check_files must reject a reference that resolves (via symlink) to a
    file outside the dataset source root."""

    def test_image_symlink_escaping_source_root_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / "dataset"
            outside = Path(tmp) / "outside"
            (base / "images").mkdir(parents=True)
            outside.mkdir()
            target = outside / "secret.jpg"
            target.write_text("outside-bytes", encoding="utf-8")
            try:
                os.symlink(str(target), str(base / "images" / "a.jpg"))
            except (OSError, NotImplementedError) as exc:
                # Windows may lack the symlink privilege.
                self.skipTest(f"symlinks unsupported on this platform/filesystem: {exc}")
            errors = validate_manifest(
                _valid_manifest(), base_dir=base, check_files=True
            )
            self.assertTrue(
                any("escapes the source root: images/a.jpg" in e for e in errors),
                errors,
            )

    def test_annotation_symlink_escaping_source_root_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / "dataset"
            outside = Path(tmp) / "outside"
            (base / "images").mkdir(parents=True)
            (base / "annotations").mkdir()
            outside.mkdir()
            (base / "images" / "a.jpg").write_text("pixels-a", encoding="utf-8")
            target = outside / "secret.json"
            target.write_text("{}", encoding="utf-8")
            try:
                os.symlink(str(target), str(base / "annotations" / "a.json"))
            except (OSError, NotImplementedError) as exc:
                self.skipTest(f"symlinks unsupported on this platform/filesystem: {exc}")
            manifest = _valid_manifest()
            manifest["splits"]["train"][0]["annotation"] = "annotations/a.json"
            errors = validate_manifest(manifest, base_dir=base, check_files=True)
            self.assertTrue(
                any("escapes the source root: annotations/a.json" in e for e in errors),
                errors,
            )

    def test_split_level_annotation_symlink_escaping_source_root_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / "dataset"
            outside = Path(tmp) / "outside"
            (base / "images").mkdir(parents=True)
            outside.mkdir()
            (base / "images" / "a.jpg").write_text("pixels-a", encoding="utf-8")
            target = outside / "instances.json"
            target.write_text("{}", encoding="utf-8")
            try:
                os.symlink(str(target), str(base / "instances_train2019.json"))
            except (OSError, NotImplementedError) as exc:
                self.skipTest(f"symlinks unsupported on this platform/filesystem: {exc}")
            manifest = _valid_manifest()
            manifest["annotations"] = {"train": "instances_train2019.json"}
            errors = validate_manifest(manifest, base_dir=base, check_files=True)
            self.assertTrue(
                any(
                    "escapes the source root: instances_train2019.json" in e
                    for e in errors
                ),
                errors,
            )


class ContentDigestTests(unittest.TestCase):
    """check_files must reject byte-for-byte copies of one image across (or
    within) splits — a train/eval leak the inode identity check cannot see."""

    def _manifest_two_images(self) -> dict:
        manifest = _valid_manifest()
        manifest["splits"]["train"] = [{"image": "images/a.jpg"}]
        manifest["splits"]["val"] = [{"image": "images/b.jpg"}]
        return manifest

    def test_copied_image_across_splits_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / "images").mkdir()
            (base / "images" / "a.jpg").write_text("same-pixels", encoding="utf-8")
            (base / "images" / "b.jpg").write_text("same-pixels", encoding="utf-8")
            errors = validate_manifest(
                self._manifest_two_images(), base_dir=base, check_files=True
            )
            self.assertTrue(
                any(
                    "splits.val[0].image duplicates content of splits.train[0].image" in e
                    for e in errors
                ),
                errors,
            )

    def test_different_content_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / "images").mkdir()
            (base / "images" / "a.jpg").write_text("pixels-one", encoding="utf-8")
            (base / "images" / "b.jpg").write_text("pixels-two", encoding="utf-8")
            errors = validate_manifest(
                self._manifest_two_images(), base_dir=base, check_files=True
            )
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


class PrepareByondStagingTests(unittest.TestCase):
    """--output staging must keep the staged manifest's sourceRoot resolving
    to the input dataset's media (a verbatim copy would resolve relative
    paths against the output dir instead)."""

    def _byond_manifest(self, **overrides) -> dict:
        manifest = {
            "datasetName": "byond-store",
            "datasetVersion": "1.0.0",
            "source": "byond-custom",
            "licenseNotes": "Internal BYOND store captures.",
            "classes": [{"classId": 0, "label": "cola-330", "sku": "SKU-1"}],
            "splits": {
                "train": [{"image": "raw/shelves/a.jpg", "annotation": "annotations/a.json"}],
                "val": [],
                "test": [],
            },
        }
        manifest.update(overrides)
        return manifest

    def _write_input(self, input_dir: Path, manifest: dict) -> None:
        (input_dir / "raw" / "shelves").mkdir(parents=True)
        (input_dir / "annotations").mkdir()
        (input_dir / "raw" / "shelves" / "a.jpg").touch()
        (input_dir / "annotations" / "a.json").write_text("{}", encoding="utf-8")
        (input_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    def _stage_and_check(self, manifest: dict) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            input_dir = base / "input"
            input_dir.mkdir()
            output_dir = base / "out"
            self._write_input(input_dir, manifest)

            result = _run_script(
                "prepare_byond_dataset.py",
                ["--input", str(input_dir), "--output", str(output_dir)],
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

            # The staged write must be atomic: valid JSON at the destination
            # and no leftover temp file from the mkstemp+replace pattern.
            staged = json.loads((output_dir / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(list(output_dir.glob("*.tmp")), [])
            staged_root = Path(staged["sourceRoot"])
            resolved = staged_root if staged_root.is_absolute() else output_dir / staged_root
            self.assertEqual(resolved.resolve(), input_dir.resolve())

            check = _run_script(
                "validate_dataset_manifest.py",
                [str(output_dir / "manifest.json"), "--check-files"],
            )
            self.assertEqual(check.returncode, 0, check.stdout + check.stderr)

    def test_staged_manifest_without_source_root_resolves_to_input(self) -> None:
        self._stage_and_check(self._byond_manifest())

    def test_staged_manifest_with_relative_source_root_resolves_to_input(self) -> None:
        self._stage_and_check(self._byond_manifest(sourceRoot="."))

    def test_manifest_with_subdir_source_root_validates_and_stages(self) -> None:
        # sourceRoot "data": references live under <input>/data/..., so
        # validation must resolve through sourceRoot (not the input dir
        # itself) exactly like the standalone validator does.
        manifest = self._byond_manifest(sourceRoot="data")
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            input_dir = base / "input"
            data_dir = input_dir / "data"
            (data_dir / "raw" / "shelves").mkdir(parents=True)
            (data_dir / "annotations").mkdir()
            (data_dir / "raw" / "shelves" / "a.jpg").touch()
            (data_dir / "annotations" / "a.json").write_text("{}", encoding="utf-8")
            (input_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            output_dir = base / "out"

            result = _run_script(
                "prepare_byond_dataset.py",
                ["--input", str(input_dir), "--output", str(output_dir)],
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

            staged = json.loads((output_dir / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(list(output_dir.glob("*.tmp")), [])
            staged_root = Path(staged["sourceRoot"])
            resolved = staged_root if staged_root.is_absolute() else output_dir / staged_root
            self.assertEqual(resolved.resolve(), data_dir.resolve())

            check = _run_script(
                "validate_dataset_manifest.py",
                [str(output_dir / "manifest.json"), "--check-files"],
            )
            self.assertEqual(check.returncode, 0, check.stdout + check.stderr)


class PrepareByondStagingPolicyTests(unittest.TestCase):
    """--output must never land a customer manifest (tenant/store ids, SKU
    maps, capture labels) in a git-trackable path: outside the repository or
    a gitignored in-repo location only."""

    POLICY_TEXT = (
        "staged custom manifests must go to a gitignored location or outside the repository"
    )
    # Strings from the fixture manifest that a rejection must never echo.
    TENANT_STRINGS = ("byond-store", "cola-330", "SKU-1")

    def _byond_manifest(self) -> dict:
        return {
            "datasetName": "byond-store",
            "datasetVersion": "1.0.0",
            "source": "byond-custom",
            "licenseNotes": "Internal BYOND store captures.",
            "classes": [{"classId": 0, "label": "cola-330", "sku": "SKU-1"}],
            "splits": {
                "train": [{"image": "raw/shelves/a.jpg", "annotation": "annotations/a.json"}],
                "val": [],
                "test": [],
            },
        }

    def _write_input(self, input_dir: Path) -> None:
        (input_dir / "raw" / "shelves").mkdir(parents=True)
        (input_dir / "annotations").mkdir()
        (input_dir / "raw" / "shelves" / "a.jpg").touch()
        (input_dir / "annotations" / "a.json").write_text("{}", encoding="utf-8")
        (input_dir / "manifest.json").write_text(
            json.dumps(self._byond_manifest()), encoding="utf-8"
        )

    def _run_with_output(self, output_dir: Path) -> subprocess.CompletedProcess:
        with tempfile.TemporaryDirectory() as tmp:
            input_dir = Path(tmp) / "input"
            input_dir.mkdir()
            self._write_input(input_dir)
            return _run_script(
                "prepare_byond_dataset.py",
                ["--input", str(input_dir), "--output", str(output_dir)],
            )

    def _require_repo_checkout(self) -> None:
        if not (REPO_ROOT / ".git").exists():
            self.skipTest("not running from a git checkout; staging policy is inert")

    def test_output_outside_repository_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "out"
            result = self._run_with_output(output_dir)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue((output_dir / "manifest.json").exists())

    def test_gitignored_in_repo_output_accepted(self) -> None:
        self._require_repo_checkout()
        output_dir = (
            REPO_ROOT
            / "ml"
            / "datasets"
            / "byond-custom"
            / "processed"
            / f"staging-policy-test-{uuid.uuid4().hex}"
        )
        # Record which ancestors we may create, so cleanup leaves the repo
        # exactly as it was even when processed/ did not exist beforehand.
        ancestors = (output_dir.parent, output_dir.parent.parent)
        preexisting = {ancestor: ancestor.exists() for ancestor in ancestors}
        try:
            result = self._run_with_output(output_dir)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue((output_dir / "manifest.json").exists())
        finally:
            shutil.rmtree(output_dir, ignore_errors=True)
            for ancestor in ancestors:
                if not preexisting[ancestor]:
                    try:
                        ancestor.rmdir()
                    except OSError:
                        pass

    def test_tracked_in_repo_output_rejected_without_echoing_manifest(self) -> None:
        self._require_repo_checkout()
        unique = f"staged-test-{uuid.uuid4().hex}"
        output_dir = REPO_ROOT / "ml" / unique
        try:
            result = self._run_with_output(output_dir)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(self.POLICY_TEXT, result.stdout)
            self.assertIn(unique, result.stdout)
            self.assertFalse(output_dir.exists())
            combined = result.stdout + result.stderr
            for tenant_string in self.TENANT_STRINGS:
                self.assertNotIn(tenant_string, combined)
        finally:
            shutil.rmtree(output_dir, ignore_errors=True)


class PrepareByondSplitAnnotationTests(unittest.TestCase):
    """Top-level annotations.train/val/test refs in a byond-custom manifest
    must live under 'annotations/', exactly like per-sample annotation
    paths — otherwise a manifest could point a whole split's annotations
    outside the annotations/ subtree."""

    def _byond_manifest(self, **overrides) -> dict:
        manifest = {
            "datasetName": "byond-store",
            "datasetVersion": "1.0.0",
            "source": "byond-custom",
            "licenseNotes": "Internal BYOND store captures.",
            "classes": [{"classId": 0, "label": "cola-330", "sku": "SKU-1"}],
            "splits": {
                "train": [{"image": "raw/shelves/a.jpg", "annotation": "annotations/a.json"}],
                "val": [],
                "test": [],
            },
        }
        manifest.update(overrides)
        return manifest

    def _run(self, manifest: dict, extra_files: tuple = ()) -> subprocess.CompletedProcess:
        with tempfile.TemporaryDirectory() as tmp:
            input_dir = Path(tmp) / "input"
            (input_dir / "raw" / "shelves").mkdir(parents=True)
            (input_dir / "annotations").mkdir()
            (input_dir / "raw" / "shelves" / "a.jpg").touch()
            (input_dir / "annotations" / "a.json").write_text("{}", encoding="utf-8")
            for rel in extra_files:
                extra = input_dir / rel
                extra.parent.mkdir(parents=True, exist_ok=True)
                extra.write_text("{}", encoding="utf-8")
            (input_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            return _run_script("prepare_byond_dataset.py", ["--input", str(input_dir)])

    def test_split_annotation_under_annotations_accepted(self) -> None:
        manifest = self._byond_manifest(annotations={"train": "annotations/train.json"})
        result = self._run(manifest, extra_files=("annotations/train.json",))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_split_annotation_outside_annotations_rejected(self) -> None:
        # The referenced file exists (so check_files stays quiet) — the BYOND
        # layout constraint alone must reject it.
        manifest = self._byond_manifest(annotations={"val": "raw/labels.json"})
        result = self._run(manifest, extra_files=("raw/labels.json",))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("annotations.val must live under 'annotations/'", result.stdout)
        self.assertNotIn("Traceback", result.stdout + result.stderr)

    def test_split_annotation_parent_traversal_rejected(self) -> None:
        # The base validator's path rules already reject '..' traversal; the
        # guarantee here is a controlled validation error, never a traceback.
        manifest = self._byond_manifest(annotations={"test": "../outside.json"})
        result = self._run(manifest)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ERROR", result.stdout)
        self.assertIn("annotations.test", result.stdout)
        self.assertNotIn("Traceback", result.stdout + result.stderr)


class PrepareByondSkuRedactionTests(unittest.TestCase):
    """The BYOND-specific checks in _extra_byond_checks must never echo
    sku/label-like manifest values: a malformed classes[].sku can be a
    mistyped PAN or credential that must not reach terminal/CI logs.
    (Sensitive fixtures are assembled at runtime so no PAN-shaped literal
    appears in source.)"""

    # A space-formatted PAN fails SKU_PATTERN, so it exercises the
    # byond-specific format error (a bare PAN passes the pattern and is
    # caught by the base validator's already-redacted sensitive screen).
    FORMATTED_PAN = " ".join(["4111"] * 4)

    def _byond_manifest(self, sku) -> dict:
        return {
            "datasetName": "byond-store",
            "datasetVersion": "1.0.0",
            "source": "byond-custom",
            "licenseNotes": "Internal BYOND store captures.",
            "classes": [{"classId": 0, "label": "cola-330", "sku": sku}],
            "splits": {
                "train": [{"image": "raw/shelves/a.jpg", "annotation": "annotations/a.json"}],
                "val": [],
                "test": [],
            },
        }

    def test_formatted_pan_sku_error_is_redacted(self) -> None:
        errors = prepare_byond_dataset._extra_byond_checks(
            self._byond_manifest(self.FORMATTED_PAN)
        )
        self.assertTrue(
            any("classes[0].sku" in e and "must match" in e for e in errors), errors
        )
        self.assertFalse(any("4111" in e for e in errors), errors)

    def test_invalid_capture_context_value_not_echoed(self) -> None:
        manifest = self._byond_manifest("SKU-1")
        secret_like = "AKI" + "A" + "ABCDEFGHIJKLMNOP"
        manifest["splits"]["train"][0]["captureContext"] = secret_like
        errors = prepare_byond_dataset._extra_byond_checks(manifest)
        self.assertTrue(
            any("captureContext must be one of" in e for e in errors), errors
        )
        self.assertFalse(any(secret_like in e for e in errors), errors)

    def test_wrong_source_value_not_echoed(self) -> None:
        manifest = self._byond_manifest("SKU-1")
        manifest["source"] = "not-the-expected-source"
        errors = prepare_byond_dataset._extra_byond_checks(manifest)
        self.assertTrue(
            any("source must be 'byond-custom'" in e for e in errors), errors
        )
        self.assertFalse(any("not-the-expected-source" in e for e in errors), errors)

    def test_cli_rejects_formatted_pan_sku_without_echoing_digits(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            input_dir = Path(tmp) / "input"
            (input_dir / "raw" / "shelves").mkdir(parents=True)
            (input_dir / "annotations").mkdir()
            (input_dir / "raw" / "shelves" / "a.jpg").touch()
            (input_dir / "annotations" / "a.json").write_text("{}", encoding="utf-8")
            (input_dir / "manifest.json").write_text(
                json.dumps(self._byond_manifest(self.FORMATTED_PAN)), encoding="utf-8"
            )
            result = _run_script("prepare_byond_dataset.py", ["--input", str(input_dir)])
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("classes[0].sku", result.stdout)
            self.assertNotIn("4111", result.stdout + result.stderr)
            self.assertNotIn("Traceback", result.stdout + result.stderr)


class PrepareByondNonObjectManifestTests(unittest.TestCase):
    """A manifest whose top level is not a JSON object must produce the base
    validator's controlled shape error — never an AttributeError traceback
    from the BYOND-specific extra checks."""

    def _run_with_payload(self, payload_text: str) -> subprocess.CompletedProcess:
        with tempfile.TemporaryDirectory() as tmp:
            input_dir = Path(tmp) / "input"
            (input_dir / "raw" / "shelves").mkdir(parents=True)
            (input_dir / "annotations").mkdir()
            (input_dir / "manifest.json").write_text(payload_text, encoding="utf-8")
            return _run_script("prepare_byond_dataset.py", ["--input", str(input_dir)])

    def _assert_controlled_error(self, result: subprocess.CompletedProcess) -> None:
        self.assertEqual(result.returncode, 1)
        self.assertIn("ERROR", result.stdout)
        self.assertIn("manifest must be a JSON object", result.stdout)
        self.assertNotIn("Traceback", result.stdout + result.stderr)

    def test_list_manifest_reports_error_not_traceback(self) -> None:
        self._assert_controlled_error(self._run_with_payload("[]"))

    def test_scalar_manifest_reports_error_not_traceback(self) -> None:
        self._assert_controlled_error(self._run_with_payload('"x"'))


class PrepareByondAnnotationCoverageTests(unittest.TestCase):
    """Every sample in a nonempty BYOND split must be annotation-covered —
    either the manifest's top-level annotations object has an entry for that
    split, or the sample carries its own `annotation` field. A split with
    neither would validate but be untrainable."""

    def _byond_manifest(self, **overrides) -> dict:
        manifest = {
            "datasetName": "byond-store",
            "datasetVersion": "1.0.0",
            "source": "byond-custom",
            "licenseNotes": "Internal BYOND store captures.",
            "classes": [{"classId": 0, "label": "cola-330", "sku": "SKU-1"}],
            "splits": {
                "train": [{"image": "raw/shelves/a.jpg"}],
                "val": [],
                "test": [],
            },
        }
        manifest.update(overrides)
        return manifest

    def test_uncovered_sample_rejected_naming_split_and_index(self) -> None:
        errors = prepare_byond_dataset._extra_byond_checks(self._byond_manifest())
        self.assertTrue(
            any(
                "splits.train[0] has no annotation coverage" in e
                and "annotations.train" in e
                for e in errors
            ),
            errors,
        )

    def test_covered_via_top_level_annotations_accepted(self) -> None:
        manifest = self._byond_manifest(
            annotations={"train": "annotations/train.json"}
        )
        errors = prepare_byond_dataset._extra_byond_checks(manifest)
        self.assertEqual(errors, [])

    def test_covered_via_per_sample_annotation_accepted(self) -> None:
        manifest = self._byond_manifest(
            splits={
                "train": [
                    {"image": "raw/shelves/a.jpg", "annotation": "annotations/a.json"}
                ],
                "val": [],
                "test": [],
            }
        )
        errors = prepare_byond_dataset._extra_byond_checks(manifest)
        self.assertEqual(errors, [])

    def test_cli_rejects_uncovered_split(self) -> None:
        # The referenced image exists, so only the coverage rule can reject.
        with tempfile.TemporaryDirectory() as tmp:
            input_dir = Path(tmp) / "input"
            (input_dir / "raw" / "shelves").mkdir(parents=True)
            (input_dir / "annotations").mkdir()
            (input_dir / "raw" / "shelves" / "a.jpg").touch()
            (input_dir / "manifest.json").write_text(
                json.dumps(self._byond_manifest()), encoding="utf-8"
            )
            result = _run_script("prepare_byond_dataset.py", ["--input", str(input_dir)])
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("splits.train[0] has no annotation coverage", result.stdout)
            self.assertNotIn("Traceback", result.stdout + result.stderr)


class PrepareByondSourceRootContainmentTests(unittest.TestCase):
    """A manifest-supplied sourceRoot must resolve inside the dataset
    directory — a root escaping via '..', an absolute path, or an in-dir
    symlink could reference (and stage) another tenant's captures while
    being reported valid."""

    ERROR_TEXT = "custom source roots must stay inside the dataset directory"

    def _byond_manifest(self, source_root: str) -> dict:
        return {
            "datasetName": "byond-store",
            "datasetVersion": "1.0.0",
            "source": "byond-custom",
            "sourceRoot": source_root,
            "licenseNotes": "Internal BYOND store captures.",
            "classes": [{"classId": 0, "label": "cola-330", "sku": "SKU-1"}],
            "splits": {
                "train": [{"image": "raw/shelves/a.jpg", "annotation": "annotations/a.json"}],
                "val": [],
                "test": [],
            },
        }

    def _write_media(self, root: Path) -> None:
        (root / "raw" / "shelves").mkdir(parents=True)
        (root / "annotations").mkdir()
        (root / "raw" / "shelves" / "a.jpg").write_text("pixels-a", encoding="utf-8")
        (root / "annotations" / "a.json").write_text("{}", encoding="utf-8")

    def _run(self, input_dir: Path, output_dir: Path) -> subprocess.CompletedProcess:
        return _run_script(
            "prepare_byond_dataset.py",
            ["--input", str(input_dir), "--output", str(output_dir)],
        )

    def _assert_rejected_nothing_staged(self, result, output_dir: Path) -> None:
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(self.ERROR_TEXT, result.stdout)
        self.assertFalse((output_dir / "manifest.json").exists())

    def test_source_root_inside_dataset_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            input_dir = base / "input"
            input_dir.mkdir()
            self._write_media(input_dir / "data")
            (input_dir / "manifest.json").write_text(
                json.dumps(self._byond_manifest("data")), encoding="utf-8"
            )
            output_dir = base / "out"
            result = self._run(input_dir, output_dir)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue((output_dir / "manifest.json").exists())

    def test_absolute_source_root_outside_dataset_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            input_dir = base / "input"
            input_dir.mkdir()
            outside = base / "other-tenant"
            # Perfectly valid media outside the dataset dir — still rejected.
            self._write_media(outside)
            (input_dir / "manifest.json").write_text(
                json.dumps(self._byond_manifest(str(outside))), encoding="utf-8"
            )
            output_dir = base / "out"
            result = self._run(input_dir, output_dir)
            self._assert_rejected_nothing_staged(result, output_dir)

    def test_parent_traversal_source_root_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            input_dir = base / "input"
            input_dir.mkdir()
            self._write_media(base / "outside")
            (input_dir / "manifest.json").write_text(
                json.dumps(self._byond_manifest("../outside")), encoding="utf-8"
            )
            output_dir = base / "out"
            result = self._run(input_dir, output_dir)
            self._assert_rejected_nothing_staged(result, output_dir)

    def test_symlinked_source_root_escaping_dataset_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            input_dir = base / "input"
            input_dir.mkdir()
            outside = base / "outside"
            self._write_media(outside)
            try:
                os.symlink(str(outside), str(input_dir / "data"), target_is_directory=True)
            except (OSError, NotImplementedError) as exc:
                # Windows may lack the symlink privilege for directories.
                self.skipTest(f"directory symlinks unsupported: {exc}")
            (input_dir / "manifest.json").write_text(
                json.dumps(self._byond_manifest("data")), encoding="utf-8"
            )
            output_dir = base / "out"
            result = self._run(input_dir, output_dir)
            self._assert_rejected_nothing_staged(result, output_dir)


class PrepareRpcEndToEndTests(unittest.TestCase):
    """Non-dry-run prepare_rpc.py against a tiny synthetic raw layout."""

    IMAGE_NAMES = {"train": "t1.jpg", "val": "v1.jpg", "test": "e1.jpg"}
    CATEGORIES = [
        {"id": 7, "name": "Cola 330"},
        {"id": 3, "name": "Chips 50"},
    ]

    def _write_raw(
        self, raw: Path, *, omit_split_image: str = "", categories: list = None
    ) -> None:
        for split, image_name in self.IMAGE_NAMES.items():
            image_dir = raw / f"{split}2019"
            image_dir.mkdir(parents=True, exist_ok=True)
            coco: dict = {
                "images": [{"id": 1, "file_name": image_name}],
                # Every split carries the same category map (as real RPC
                # files do); prepare_rpc rejects any val/test drift from
                # train. Non-contiguous COCO category ids on purpose: classId
                # must be assigned deterministically (sorted by source id)
                # while sourceId preserves these originals.
                "categories": list(categories if categories is not None else self.CATEGORIES),
                # A small valid annotations array, like real RPC files carry:
                # references must resolve against this file's image/category
                # ids and the bbox must be 4 finite positive-size numbers.
                "annotations": [
                    {"image_id": 1, "category_id": 7, "bbox": [10, 20, 30, 40]},
                    {"image_id": 1, "category_id": 3, "bbox": [5.5, 6.5, 7.5, 8.5]},
                ],
            }
            (raw / f"instances_{split}2019.json").write_text(
                json.dumps(coco), encoding="utf-8"
            )
            if split != omit_split_image:
                # Unique bytes per placeholder: identical (e.g. empty) files
                # across splits would trip the content-digest duplicate check.
                (image_dir / image_name).write_text(f"pixels-{image_name}", encoding="utf-8")

    def test_prepared_manifest_has_source_root_and_annotation_refs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "raw"
            out = Path(tmp) / "out"
            self._write_raw(raw)
            result = _run_script(
                "prepare_rpc.py", ["--input", str(raw), "--output", str(out)]
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["sourceRoot"], "../raw")
            self.assertEqual(
                manifest["annotations"],
                {
                    "train": "instances_train2019.json",
                    "val": "instances_val2019.json",
                    "test": "instances_test2019.json",
                },
            )
            self.assertEqual(manifest["splits"]["train"], [{"image": "train2019/t1.jpg"}])

    def test_prepared_manifest_preserves_coco_category_ids_as_source_ids(self) -> None:
        # Categories arrive in on-disk order [7, 3] but classIds are assigned
        # after sorting by source id, so sourceId 3 -> classId 0 and
        # sourceId 7 -> classId 1.
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "raw"
            out = Path(tmp) / "out"
            self._write_raw(raw)
            result = _run_script(
                "prepare_rpc.py", ["--input", str(raw), "--output", str(out)]
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(
                manifest["classes"],
                [
                    {"classId": 0, "label": "chips-50", "sourceId": 3},
                    {"classId": 1, "label": "cola-330", "sourceId": 7},
                ],
            )

    def test_class_ids_deterministic_across_category_array_order(self) -> None:
        # Two exports with the same id -> name map in different array orders
        # must produce identical classes lists under the same datasetVersion.
        classes_per_order = []
        for categories in (list(self.CATEGORIES), list(reversed(self.CATEGORIES))):
            with tempfile.TemporaryDirectory() as tmp:
                raw = Path(tmp) / "raw"
                out = Path(tmp) / "out"
                self._write_raw(raw, categories=categories)
                result = _run_script(
                    "prepare_rpc.py", ["--input", str(raw), "--output", str(out)]
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                manifest = json.loads(
                    (out / "manifest.json").read_text(encoding="utf-8")
                )
                classes_per_order.append(manifest["classes"])
        self.assertEqual(classes_per_order[0], classes_per_order[1])

    def test_missing_referenced_image_fails_loudly(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "raw"
            out = Path(tmp) / "out"
            self._write_raw(raw, omit_split_image="val")
            result = _run_script(
                "prepare_rpc.py", ["--input", str(raw), "--output", str(out)]
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("missing file: val2019/v1.jpg", result.stdout)
            self.assertIn(str(raw), result.stdout)

    def test_failed_rerun_preserves_previous_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "raw"
            out = Path(tmp) / "out"
            self._write_raw(raw)
            first = _run_script(
                "prepare_rpc.py", ["--input", str(raw), "--output", str(out)]
            )
            self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
            original = (out / "manifest.json").read_text(encoding="utf-8")

            (raw / "val2019" / "v1.jpg").unlink()
            second = _run_script(
                "prepare_rpc.py", ["--input", str(raw), "--output", str(out)]
            )
            self.assertNotEqual(second.returncode, 0)
            self.assertIn("missing file: val2019/v1.jpg", second.stdout)
            self.assertEqual(
                (out / "manifest.json").read_text(encoding="utf-8"), original
            )
            self.assertEqual(list(out.glob("*.tmp")), [])


class PrepareSku110kEndToEndTests(unittest.TestCase):
    """Non-dry-run prepare_sku110k.py against a tiny synthetic raw layout."""

    IMAGE_NAMES = {"train": "a.jpg", "val": "b.jpg", "test": "c.jpg"}

    def _write_raw(self, raw: Path, *, omit_split_image: str = "") -> None:
        images_dir = raw / "images"
        images_dir.mkdir(parents=True, exist_ok=True)
        annotations_dir = raw / "annotations"
        annotations_dir.mkdir(parents=True, exist_ok=True)
        for split, image_name in self.IMAGE_NAMES.items():
            (annotations_dir / f"annotations_{split}.csv").write_text(
                f"{image_name},10,10,20,20,object,100,100\n", encoding="utf-8"
            )
            if split != omit_split_image:
                # Unique bytes per placeholder: identical (e.g. empty) files
                # across splits would trip the content-digest duplicate check.
                (images_dir / image_name).write_text(f"pixels-{image_name}", encoding="utf-8")

    def test_prepared_manifest_has_source_root_and_annotation_refs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "raw"
            out = Path(tmp) / "out"
            self._write_raw(raw)
            result = _run_script(
                "prepare_sku110k.py", ["--input", str(raw), "--output", str(out)]
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["sourceRoot"], "../raw")
            self.assertEqual(
                manifest["annotations"],
                {
                    "train": "annotations/annotations_train.csv",
                    "val": "annotations/annotations_val.csv",
                    "test": "annotations/annotations_test.csv",
                },
            )
            self.assertEqual(manifest["splits"]["val"], [{"image": "images/b.jpg"}])

    def test_missing_referenced_image_fails_loudly(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "raw"
            out = Path(tmp) / "out"
            self._write_raw(raw, omit_split_image="test")
            result = _run_script(
                "prepare_sku110k.py", ["--input", str(raw), "--output", str(out)]
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("missing file: images/c.jpg", result.stdout)
            self.assertIn(str(raw), result.stdout)

    def test_failed_rerun_preserves_previous_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "raw"
            out = Path(tmp) / "out"
            self._write_raw(raw)
            first = _run_script(
                "prepare_sku110k.py", ["--input", str(raw), "--output", str(out)]
            )
            self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
            original = (out / "manifest.json").read_text(encoding="utf-8")

            (raw / "images" / "b.jpg").unlink()
            second = _run_script(
                "prepare_sku110k.py", ["--input", str(raw), "--output", str(out)]
            )
            self.assertNotEqual(second.returncode, 0)
            self.assertIn("missing file: images/b.jpg", second.stdout)
            self.assertEqual(
                (out / "manifest.json").read_text(encoding="utf-8"), original
            )
            self.assertEqual(list(out.glob("*.tmp")), [])


class Sku110kCsvRowValidationTests(unittest.TestCase):
    """prepare_sku110k must reject truncated rows, non-numeric coordinates,
    and degenerate/invalid boxes with controlled errors naming the file,
    the 1-based row number, and the violated rule (never the raw row), and
    must write no manifest."""

    IMAGE_NAMES = {"train": "a.jpg", "val": "b.jpg", "test": "c.jpg"}

    def _valid_row(self, image_name: str) -> str:
        return f"{image_name},10,10,20,20,object,100,100\n"

    def _run_prepare(self, tmp: Path, train_csv_content: str) -> tuple:
        raw = tmp / "raw"
        out = tmp / "out"
        images_dir = raw / "images"
        images_dir.mkdir(parents=True)
        annotations_dir = raw / "annotations"
        annotations_dir.mkdir(parents=True)
        for split, image_name in self.IMAGE_NAMES.items():
            content = (
                train_csv_content if split == "train" else self._valid_row(image_name)
            )
            (annotations_dir / f"annotations_{split}.csv").write_text(
                content, encoding="utf-8"
            )
            (images_dir / image_name).write_text(f"pixels-{image_name}", encoding="utf-8")
        result = _run_script(
            "prepare_sku110k.py", ["--input", str(raw), "--output", str(out)]
        )
        return result, out

    def _assert_rejected(self, result, out: Path, *fragments: str) -> None:
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ERROR", result.stdout)
        self.assertIn("annotations/annotations_train.csv", result.stdout)
        for fragment in fragments:
            self.assertIn(fragment, result.stdout)
        self.assertNotIn("Traceback", result.stdout + result.stderr)
        self.assertFalse((out / "manifest.json").exists())

    def test_truncated_row_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(Path(tmp), "a.jpg,10,10\n")
            self._assert_rejected(result, out, "row 1", "expected 8 columns, got 3")

    def test_non_numeric_coordinate_rejected_without_raw_row_dump(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp),
                self._valid_row("a.jpg") + "a.jpg,10,NOTNUM77,20,20,object,100,100\n",
            )
            self._assert_rejected(result, out, "row 2", "y1 must be a finite number")
            self.assertNotIn("NOTNUM77", result.stdout)

    def test_x2_not_greater_than_x1_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp), "a.jpg,20,10,20,20,object,100,100\n"
            )
            self._assert_rejected(result, out, "row 1", "x2 must be greater than x1")

    def test_y2_not_greater_than_y1_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp), "a.jpg,10,20,20,20,object,100,100\n"
            )
            self._assert_rejected(result, out, "row 1", "y2 must be greater than y1")

    def test_non_positive_image_dimension_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp), "a.jpg,10,10,20,20,object,0,100\n"
            )
            self._assert_rejected(
                result, out, "row 1", "image_width must be greater than 0"
            )

    def test_negative_x1_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp), "a.jpg,-5,10,20,20,object,100,100\n"
            )
            self._assert_rejected(result, out, "row 1", "x1 must not be negative")

    def test_x2_beyond_image_width_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp), "a.jpg,10,10,120,20,object,100,100\n"
            )
            self._assert_rejected(result, out, "row 1", "x2 must not exceed image_width")

    def test_full_image_bounds_row_accepted(self) -> None:
        # x1 = 0 and x2 == image_width (same for y) are in-bounds.
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp), "a.jpg,0,0,100,100,object,100,100\n"
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue((out / "manifest.json").exists())

    def test_row_error_collection_is_capped(self) -> None:
        bad_rows = "".join("a.jpg,10,10\n" for _ in range(40))
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(Path(tmp), bad_rows)
            self._assert_rejected(result, out, "row-error limit (25) reached")
            self.assertNotIn("row 40", result.stdout)

    def test_valid_eight_column_rows_accepted_end_to_end(self) -> None:
        # Two boxes for the same image: still one deduped sample per split.
        train_csv = self._valid_row("a.jpg") + "a.jpg,30,30,40,40.5,object,100,100\n"
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(Path(tmp), train_csv)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["splits"]["train"], [{"image": "images/a.jpg"}])


class RpcCategoryConsistencyTests(unittest.TestCase):
    """prepare_rpc must reject val/test COCO files whose category id -> name
    map differs from the training split's (renamed, missing, or extra id) —
    annotations join on category id, so any drift silently mislabels."""

    CATEGORIES = [{"id": 7, "name": "Cola 330"}, {"id": 3, "name": "Chips 50"}]
    IMAGE_NAMES = {"train": "t1.jpg", "val": "v1.jpg", "test": "e1.jpg"}

    def _run_prepare(self, tmp: Path, val_categories: list) -> tuple:
        raw = tmp / "raw"
        out = tmp / "out"
        for split, image_name in self.IMAGE_NAMES.items():
            image_dir = raw / f"{split}2019"
            image_dir.mkdir(parents=True, exist_ok=True)
            categories = val_categories if split == "val" else self.CATEGORIES
            coco: dict = {
                "images": [{"id": 1, "file_name": image_name}],
                "categories": categories,
            }
            if split == "train":
                # Train files must carry labels; val/test may omit the key.
                coco["annotations"] = [
                    {"image_id": 1, "category_id": 3, "bbox": [1, 2, 3, 4]}
                ]
            (raw / f"instances_{split}2019.json").write_text(
                json.dumps(coco), encoding="utf-8"
            )
            (image_dir / image_name).write_text(f"pixels-{image_name}", encoding="utf-8")
        result = _run_script(
            "prepare_rpc.py", ["--input", str(raw), "--output", str(out)]
        )
        return result, out

    def _assert_rejected(self, result, out: Path, expected_fragment: str) -> None:
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("instances_val2019.json", result.stdout)
        self.assertIn("val split", result.stdout)
        self.assertIn(expected_fragment, result.stdout)
        self.assertFalse((out / "manifest.json").exists())

    def test_renamed_category_in_val_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp),
                [{"id": 7, "name": "Soap"}, {"id": 3, "name": "Chips 50"}],
            )
            self._assert_rejected(result, out, "category id 7: name differs")
            # Category names are redacted from mismatch errors — a name can
            # carry credential-bearing content.
            self.assertNotIn("Soap", result.stdout + result.stderr)

    def test_missing_category_id_in_val_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(Path(tmp), [{"id": 7, "name": "Cola 330"}])
            self._assert_rejected(result, out, "category id 3 is missing")

    def test_extra_category_id_in_val_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp), self.CATEGORIES + [{"id": 9, "name": "Extra"}]
            )
            self._assert_rejected(
                result, out, "category id 9 is not in the training categories"
            )

    def test_identical_category_maps_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(Path(tmp), list(self.CATEGORIES))
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue((out / "manifest.json").exists())


class RpcCocoShapeGuardTests(unittest.TestCase):
    """prepare_rpc must reject null/non-object entries (or missing typed
    fields) in a COCO file's `categories` / `images` arrays with a
    controlled ERROR, never an AttributeError traceback."""

    CATEGORIES = [{"id": 7, "name": "Cola 330"}, {"id": 3, "name": "Chips 50"}]
    IMAGE_NAMES = {"train": "t1.jpg", "val": "v1.jpg", "test": "e1.jpg"}

    def _run_prepare(
        self,
        tmp: Path,
        *,
        train_categories: list = None,
        train_images: list = None,
        val_categories: list = None,
    ) -> tuple:
        raw = tmp / "raw"
        out = tmp / "out"
        for split, image_name in self.IMAGE_NAMES.items():
            image_dir = raw / f"{split}2019"
            image_dir.mkdir(parents=True, exist_ok=True)
            categories = list(self.CATEGORIES)
            images = [{"id": 1, "file_name": image_name}]
            if split == "train":
                if train_categories is not None:
                    categories = train_categories
                if train_images is not None:
                    images = train_images
            elif split == "val" and val_categories is not None:
                categories = val_categories
            coco: dict = {"images": images, "categories": categories}
            if split == "train":
                # Train files must carry labels; the join references may not
                # resolve in fixtures that deliberately break images or
                # categories, which only adds errors alongside the targeted
                # one — assertions here check fragments, not exact output.
                coco["annotations"] = [
                    {"image_id": 1, "category_id": 3, "bbox": [1, 2, 3, 4]}
                ]
            (raw / f"instances_{split}2019.json").write_text(
                json.dumps(coco), encoding="utf-8"
            )
            (image_dir / image_name).write_text(f"pixels-{image_name}", encoding="utf-8")
        result = _run_script(
            "prepare_rpc.py", ["--input", str(raw), "--output", str(out)]
        )
        return result, out

    def _assert_controlled_error(self, result, out: Path, *fragments: str) -> None:
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ERROR", result.stdout)
        for fragment in fragments:
            self.assertIn(fragment, result.stdout)
        self.assertNotIn("Traceback", result.stdout + result.stderr)
        self.assertFalse((out / "manifest.json").exists())

    def test_null_category_entry_reports_error_not_traceback(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp), train_categories=self.CATEGORIES + [None]
            )
            self._assert_controlled_error(
                result, out, "instances_train2019.json", "categories[2] must be an object"
            )

    def test_null_category_entry_in_val_reports_error_not_traceback(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp), val_categories=[None] + self.CATEGORIES
            )
            self._assert_controlled_error(
                result, out, "instances_val2019.json", "categories[0] must be an object"
            )

    def test_null_image_entry_reports_error_not_traceback(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp), train_images=[{"id": 1, "file_name": "t1.jpg"}, None]
            )
            self._assert_controlled_error(
                result, out, "instances_train2019.json", "images[1] must be an object"
            )

    def test_negative_category_id_reports_error_not_traceback(self) -> None:
        # A negative COCO category id would fail the manifest's sourceId >= 0
        # rule (or, previously, silently drop the class's source mapping), so
        # the shape guard must reject it up front with a named error.
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp),
                train_categories=[
                    {"id": -1, "name": "Cola 330"},
                    {"id": 3, "name": "Chips 50"},
                ],
            )
            self._assert_controlled_error(
                result,
                out,
                "instances_train2019.json",
                "categories[0].id must be a non-negative integer",
            )

    def test_negative_category_id_in_val_reports_error_not_traceback(self) -> None:
        # Shape errors must be checked BEFORE the category-map comparison —
        # the unvalidated val entry must produce the named shape error, not
        # reach the map-mismatch path (or a traceback).
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp),
                val_categories=[
                    {"id": -1, "name": "Cola 330"},
                    {"id": 3, "name": "Chips 50"},
                ],
            )
            self._assert_controlled_error(
                result,
                out,
                "instances_val2019.json",
                "categories[0].id must be a non-negative integer",
            )
            self.assertNotIn("categories do not match", result.stdout)

    def test_image_missing_file_name_reports_error_not_traceback(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(Path(tmp), train_images=[{"id": 1}])
            self._assert_controlled_error(
                result,
                out,
                "instances_train2019.json",
                "images[0].file_name must be a non-empty string",
            )

    def test_image_missing_id_reports_error_not_traceback(self) -> None:
        # An image entry without an id used to slip through whenever no
        # annotation referenced it — every entry must carry a usable id.
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp), train_images=[{"file_name": "t1.jpg"}]
            )
            self._assert_controlled_error(
                result,
                out,
                "instances_train2019.json",
                "images[0].id must be an integer",
            )

    def test_boolean_image_id_reports_error_not_traceback(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp), train_images=[{"id": True, "file_name": "t1.jpg"}]
            )
            self._assert_controlled_error(
                result,
                out,
                "instances_train2019.json",
                "images[0].id must be an integer",
            )

    def test_duplicate_image_id_reports_error_naming_both_indexes(self) -> None:
        # Two images entries sharing an id would collapse in the reference
        # set used for annotation joins — must be rejected up front.
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp),
                train_images=[
                    {"id": 2, "file_name": "t1.jpg"},
                    {"id": 3, "file_name": "t2.jpg"},
                    {"id": 2, "file_name": "t3.jpg"},
                ],
            )
            self._assert_controlled_error(
                result,
                out,
                "instances_train2019.json",
                "images[2].id duplicates images[0].id",
            )


class RpcRequiredCocoKeysTests(unittest.TestCase):
    """A COCO file omitting its `images` or `categories` array must produce
    a controlled ERROR naming the file — never a silently empty split (or
    empty class list) and an OK manifest."""

    CATEGORIES = [{"id": 7, "name": "Cola 330"}, {"id": 3, "name": "Chips 50"}]
    IMAGE_NAMES = {"train": "t1.jpg", "val": "v1.jpg", "test": "e1.jpg"}

    def _run_prepare(self, tmp: Path, *, drop_key: str, from_split: str) -> tuple:
        raw = tmp / "raw"
        out = tmp / "out"
        for split, image_name in self.IMAGE_NAMES.items():
            image_dir = raw / f"{split}2019"
            image_dir.mkdir(parents=True, exist_ok=True)
            coco: dict = {
                "images": [{"id": 1, "file_name": image_name}],
                "categories": list(self.CATEGORIES),
            }
            if split == "train":
                # Train files must carry labels; when this test drops the
                # images or categories key from train, the dangling join
                # references only add errors alongside the targeted one.
                coco["annotations"] = [
                    {"image_id": 1, "category_id": 3, "bbox": [1, 2, 3, 4]}
                ]
            if split == from_split:
                del coco[drop_key]
            (raw / f"instances_{split}2019.json").write_text(
                json.dumps(coco), encoding="utf-8"
            )
            (image_dir / image_name).write_text(f"pixels-{image_name}", encoding="utf-8")
        result = _run_script(
            "prepare_rpc.py", ["--input", str(raw), "--output", str(out)]
        )
        return result, out

    def _assert_controlled_error(self, result, out: Path, *fragments: str) -> None:
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ERROR", result.stdout)
        for fragment in fragments:
            self.assertIn(fragment, result.stdout)
        self.assertNotIn("Traceback", result.stdout + result.stderr)
        self.assertFalse((out / "manifest.json").exists())

    def test_missing_images_key_in_val_is_controlled_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp), drop_key="images", from_split="val"
            )
            self._assert_controlled_error(
                result,
                out,
                "instances_val2019.json",
                "images is a required key",
            )

    def test_missing_images_key_in_train_is_controlled_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp), drop_key="images", from_split="train"
            )
            self._assert_controlled_error(
                result,
                out,
                "instances_train2019.json",
                "images is a required key",
            )

    def test_missing_categories_key_in_train_is_controlled_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp), drop_key="categories", from_split="train"
            )
            self._assert_controlled_error(
                result,
                out,
                "instances_train2019.json",
                "categories is a required key",
            )

    def test_missing_categories_key_in_test_is_controlled_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp), drop_key="categories", from_split="test"
            )
            self._assert_controlled_error(
                result,
                out,
                "instances_test2019.json",
                "categories is a required key",
            )


class RpcCocoAnnotationValidationTests(unittest.TestCase):
    """prepare_rpc must validate each COCO file's `annotations` array (when
    present) before writing the manifest: image_id/category_id must reference
    known ids and bbox must be 4 finite numbers with positive width/height."""

    CATEGORIES = [{"id": 7, "name": "Cola 330"}, {"id": 3, "name": "Chips 50"}]
    IMAGE_NAMES = {"train": "t1.jpg", "val": "v1.jpg", "test": "e1.jpg"}

    def _run_prepare(self, tmp: Path, train_annotations: list) -> tuple:
        raw = tmp / "raw"
        out = tmp / "out"
        for split, image_name in self.IMAGE_NAMES.items():
            image_dir = raw / f"{split}2019"
            image_dir.mkdir(parents=True, exist_ok=True)
            coco: dict = {
                "images": [{"id": 1, "file_name": image_name}],
                "categories": list(self.CATEGORIES),
            }
            if split == "train":
                coco["annotations"] = train_annotations
            (raw / f"instances_{split}2019.json").write_text(
                json.dumps(coco), encoding="utf-8"
            )
            (image_dir / image_name).write_text(f"pixels-{image_name}", encoding="utf-8")
        result = _run_script(
            "prepare_rpc.py", ["--input", str(raw), "--output", str(out)]
        )
        return result, out

    def _assert_rejected(self, result, out: Path, fragment: str) -> None:
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("instances_train2019.json", result.stdout)
        self.assertIn(fragment, result.stdout)
        self.assertNotIn("Traceback", result.stdout + result.stderr)
        self.assertFalse((out / "manifest.json").exists())

    def test_unknown_category_id_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp), [{"image_id": 1, "category_id": 99, "bbox": [1, 2, 3, 4]}]
            )
            self._assert_rejected(
                result, out, "annotations[0].category_id references an unknown category"
            )

    def test_unknown_image_id_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp), [{"image_id": 42, "category_id": 7, "bbox": [1, 2, 3, 4]}]
            )
            self._assert_rejected(
                result, out, "annotations[0].image_id references an unknown image"
            )

    def test_negative_bbox_width_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp), [{"image_id": 1, "category_id": 7, "bbox": [1, 2, -3, 4]}]
            )
            self._assert_rejected(
                result, out, "annotations[0].bbox must have positive width and height"
            )

    def test_nan_bbox_value_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp),
                [{"image_id": 1, "category_id": 7, "bbox": [1, 2, float("nan"), 4]}],
            )
            self._assert_rejected(
                result, out, "annotations[0].bbox values must be finite numbers"
            )

    def test_wrong_arity_bbox_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp), [{"image_id": 1, "category_id": 7, "bbox": [1, 2, 3]}]
            )
            self._assert_rejected(
                result, out, "annotations[0].bbox must be a list of exactly 4 numbers"
            )

    def test_valid_annotations_accepted_end_to_end(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp),
                [
                    {"image_id": 1, "category_id": 7, "bbox": [10, 20, 30, 40]},
                    {"image_id": 1, "category_id": 3, "bbox": [5.5, 6.5, 7.5, 8.5]},
                ],
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue((out / "manifest.json").exists())


class RpcTrainAnnotationsRequiredTests(unittest.TestCase):
    """The train COCO file must carry a present, non-empty `annotations`
    list — a categories+images-only train file has nothing to train on and
    must be a named error, never an OK manifest. val/test files may omit
    the key entirely (unlabeled evaluation sets exist)."""

    CATEGORIES = [{"id": 7, "name": "Cola 330"}, {"id": 3, "name": "Chips 50"}]
    IMAGE_NAMES = {"train": "t1.jpg", "val": "v1.jpg", "test": "e1.jpg"}

    def _run_prepare(
        self, tmp: Path, *, drop_annotations: tuple = (), empty_annotations: tuple = ()
    ) -> tuple:
        raw = tmp / "raw"
        out = tmp / "out"
        for split, image_name in self.IMAGE_NAMES.items():
            image_dir = raw / f"{split}2019"
            image_dir.mkdir(parents=True, exist_ok=True)
            coco: dict = {
                "images": [{"id": 1, "file_name": image_name}],
                "categories": list(self.CATEGORIES),
                "annotations": [
                    {"image_id": 1, "category_id": 7, "bbox": [1, 2, 3, 4]}
                ],
            }
            if split in drop_annotations:
                del coco["annotations"]
            if split in empty_annotations:
                coco["annotations"] = []
            (raw / f"instances_{split}2019.json").write_text(
                json.dumps(coco), encoding="utf-8"
            )
            (image_dir / image_name).write_text(f"pixels-{image_name}", encoding="utf-8")
        result = _run_script(
            "prepare_rpc.py", ["--input", str(raw), "--output", str(out)]
        )
        return result, out

    def _assert_train_labels_required(self, result, out: Path) -> None:
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ERROR", result.stdout)
        self.assertIn("instances_train2019.json", result.stdout)
        self.assertIn("non-empty", result.stdout)
        self.assertIn("annotations", result.stdout)
        self.assertNotIn("Traceback", result.stdout + result.stderr)
        self.assertFalse((out / "manifest.json").exists())

    def test_train_without_annotations_key_rejected_naming_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(Path(tmp), drop_annotations=("train",))
            self._assert_train_labels_required(result, out)

    def test_train_with_empty_annotations_list_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(Path(tmp), empty_annotations=("train",))
            self._assert_train_labels_required(result, out)

    def test_val_and_test_without_annotations_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result, out = self._run_prepare(
                Path(tmp), drop_annotations=("val", "test")
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue((out / "manifest.json").exists())


class RpcMalformedJsonTests(unittest.TestCase):
    """Truncated/corrupt COCO files must produce a controlled ERROR naming
    the file (reason class only, never file content) — never a raw
    JSONDecodeError traceback — from both the initial train load and the
    per-split loads."""

    CATEGORIES = [{"id": 7, "name": "Cola 330"}, {"id": 3, "name": "Chips 50"}]
    IMAGE_NAMES = {"train": "t1.jpg", "val": "v1.jpg", "test": "e1.jpg"}

    def _write_valid_raw(self, raw: Path) -> None:
        for split, image_name in self.IMAGE_NAMES.items():
            image_dir = raw / f"{split}2019"
            image_dir.mkdir(parents=True, exist_ok=True)
            coco: dict = {
                "images": [{"id": 1, "file_name": image_name}],
                "categories": list(self.CATEGORIES),
                "annotations": [
                    {"image_id": 1, "category_id": 7, "bbox": [1, 2, 3, 4]}
                ],
            }
            (raw / f"instances_{split}2019.json").write_text(
                json.dumps(coco), encoding="utf-8"
            )
            (image_dir / image_name).write_text(f"pixels-{image_name}", encoding="utf-8")

    def _assert_controlled_json_error(self, result, out: Path, file_name: str) -> None:
        self.assertEqual(result.returncode, 1)
        self.assertIn("ERROR", result.stdout)
        self.assertIn(file_name, result.stdout)
        self.assertIn("not valid JSON", result.stdout)
        self.assertNotIn("Traceback", result.stdout + result.stderr)
        self.assertFalse((out / "manifest.json").exists())

    def test_truncated_train_json_is_controlled_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "raw"
            out = Path(tmp) / "out"
            self._write_valid_raw(raw)
            (raw / "instances_train2019.json").write_text(
                '{"images": [', encoding="utf-8"
            )
            result = _run_script(
                "prepare_rpc.py", ["--input", str(raw), "--output", str(out)]
            )
            self._assert_controlled_json_error(result, out, "instances_train2019.json")

    def test_corrupt_val_json_is_controlled_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "raw"
            out = Path(tmp) / "out"
            self._write_valid_raw(raw)
            (raw / "instances_val2019.json").write_text(
                '{"categories": [{', encoding="utf-8"
            )
            result = _run_script(
                "prepare_rpc.py", ["--input", str(raw), "--output", str(out)]
            )
            self._assert_controlled_json_error(result, out, "instances_val2019.json")


class RpcLabelCollisionTests(unittest.TestCase):
    """Slug collisions among COCO category names must resolve to labels that
    are actually unique — a one-shot index suffix can itself collide (e.g.
    "foo", "foo 2", "foo!" -> "foo", "foo-2", "foo-2")."""

    CATEGORIES = [
        {"id": 1, "name": "foo"},
        {"id": 2, "name": "foo 2"},
        {"id": 3, "name": "foo!"},
    ]
    IMAGE_NAMES = {"train": "t1.jpg", "val": "v1.jpg", "test": "e1.jpg"}

    def test_double_colliding_category_names_produce_unique_labels(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "raw"
            out = Path(tmp) / "out"
            for split, image_name in self.IMAGE_NAMES.items():
                image_dir = raw / f"{split}2019"
                image_dir.mkdir(parents=True, exist_ok=True)
                coco: dict = {
                    "images": [{"id": 1, "file_name": image_name}],
                    "categories": list(self.CATEGORIES),
                }
                if split == "train":
                    # Train files must carry labels; val/test may omit them.
                    coco["annotations"] = [
                        {"image_id": 1, "category_id": 1, "bbox": [1, 2, 3, 4]}
                    ]
                (raw / f"instances_{split}2019.json").write_text(
                    json.dumps(coco), encoding="utf-8"
                )
                (image_dir / image_name).write_text(
                    f"pixels-{image_name}", encoding="utf-8"
                )
            result = _run_script(
                "prepare_rpc.py", ["--input", str(raw), "--output", str(out)]
            )
            # rc 0 means the manifest also passed full validation (which
            # rejects duplicate labels).
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
            labels = [cls["label"] for cls in manifest["classes"]]
            self.assertEqual(labels, ["foo", "foo-2", "foo-3"])
            self.assertEqual(len(labels), len(set(labels)), labels)


class SourceRootHelperTests(unittest.TestCase):
    """All three preparers' _source_root must relate the physical (resolved)
    endpoints, so symlinked input/output dirs never record a bogus root."""

    MODULES = (prepare_rpc, prepare_sku110k, prepare_byond_dataset)

    def test_source_root_of_sibling_dirs_is_relative(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / "raw").mkdir()
            (base / "out").mkdir()
            for module in self.MODULES:
                with self.subTest(module=module.__name__):
                    self.assertEqual(
                        module._source_root(base / "raw", base / "out"), "../raw"
                    )

    def test_source_root_resolves_symlinked_input(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            real = base / "real-raw"
            real.mkdir()
            (base / "out").mkdir()
            link = base / "link-raw"
            try:
                os.symlink(str(real), str(link), target_is_directory=True)
            except (OSError, NotImplementedError) as exc:
                # Windows may lack the symlink privilege for directories.
                self.skipTest(f"directory symlinks unsupported: {exc}")
            for module in self.MODULES:
                with self.subTest(module=module.__name__):
                    self.assertEqual(
                        module._source_root(link, base / "out"), "../real-raw"
                    )


class AtomicWritePermissionTests(unittest.TestCase):
    """Atomically-written manifests must not keep mkstemp's private 0600
    mode — shared-pipeline readers need the normal umask-derived mode."""

    def test_written_manifest_is_readable(self) -> None:
        for module in (prepare_rpc, prepare_sku110k, prepare_byond_dataset):
            with self.subTest(module=module.__name__):
                with tempfile.TemporaryDirectory() as tmp:
                    destination = Path(tmp) / "manifest.json"
                    module._write_json_atomically({"k": "v"}, destination)
                    self.assertTrue(os.access(str(destination), os.R_OK))
                    if sys.platform != "win32":
                        current_umask = os.umask(0)
                        os.umask(current_umask)
                        self.assertEqual(
                            destination.stat().st_mode & 0o777,
                            0o666 & ~current_umask,
                        )


class UnreadableImageTests(unittest.TestCase):
    """An image that exists but cannot be read for hashing must fail
    validation — silently skipping it would let duplicates evade the leak
    check and unusable samples pass."""

    def test_undigestable_image_reported_as_unreadable(self) -> None:
        manifest = _valid_manifest()
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / "images").mkdir()
            (base / "images" / "a.jpg").write_text("pixels-a", encoding="utf-8")
            with mock.patch.object(
                validate_dataset_manifest,
                "_digest_file",
                side_effect=OSError("permission denied"),
            ):
                errors = validate_manifest(manifest, base_dir=base, check_files=True)
            self.assertTrue(
                any("unreadable file: images/a.jpg" in e for e in errors), errors
            )


class SourceRootResolutionTests(unittest.TestCase):
    """A sourceRoot that is not a valid filesystem string must be rejected as
    a validation error, never crash path resolution with a traceback."""

    def test_nul_in_source_root_rejected_by_shape_check(self) -> None:
        manifest = _valid_manifest()
        manifest["sourceRoot"] = "\x00bad"
        errors = validate_manifest(manifest)
        self.assertTrue(
            any("sourceRoot contains invalid characters" in e for e in errors), errors
        )

    def test_cli_nul_source_root_exits_1_without_traceback(self) -> None:
        manifest = _valid_manifest()
        manifest["sourceRoot"] = "\x00bad"
        with tempfile.TemporaryDirectory() as tmp:
            manifest_path = Path(tmp) / "manifest.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            result = _run_script(
                "validate_dataset_manifest.py", [str(manifest_path), "--check-files"]
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("ERROR", result.stdout)
            self.assertIn("sourceRoot contains invalid characters", result.stdout)
            self.assertNotIn("Traceback", result.stdout + result.stderr)

    def test_unresolvable_base_dir_reported_not_raised(self) -> None:
        bad_root = Path("\x00bad")
        manifest = _valid_manifest()
        try:
            errors = validate_manifest(manifest, base_dir=bad_root, check_files=True)
        except (OSError, ValueError):
            self.fail("validate_manifest raised instead of reporting an error")
        self.assertTrue(errors)
        # Whether Path.resolve raises on an embedded NUL is platform
        # dependent; the specific error line is only owed where it does.
        try:
            bad_root.resolve()
        except (OSError, ValueError):
            self.assertTrue(
                any("sourceRoot cannot be resolved" in e for e in errors), errors
            )


class UnknownFieldKeyRedactionTests(unittest.TestCase):
    """Unknown-field KEYS are attacker-chosen strings too: a PAN or token
    used as a field name must not reach terminal/CI logs."""

    def test_sensitive_unknown_key_redacted(self) -> None:
        pan = "4111" * 4
        manifest = _valid_manifest()
        manifest[pan] = "x"
        errors = validate_manifest(manifest)
        self.assertTrue(any("unknown top-level field: <redacted>" in e for e in errors), errors)
        self.assertFalse(any(pan in e for e in errors), errors)

    def test_benign_unknown_key_still_named(self) -> None:
        manifest = _valid_manifest()
        manifest["extraField"] = "x"
        errors = validate_manifest(manifest)
        self.assertTrue(any("unknown top-level field: 'extraField'" in e for e in errors), errors)


class ByondSourceRootRedactionTests(unittest.TestCase):
    """The containment error must not echo the manifest-supplied sourceRoot
    (or the resolved path, whose components derive from it)."""

    def test_containment_error_does_not_echo_source_root(self) -> None:
        marker = "sneaky-" + "sk" + "_live_" + "MARKER99999999"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dataset = root / "dataset"
            (dataset / "raw").mkdir(parents=True)
            (dataset / "annotations").mkdir()
            outside = root / marker
            outside.mkdir()
            manifest = {
                "datasetName": "byond-demo",
                "datasetVersion": "1.0.0",
                "source": "byond-custom",
                "sourceRoot": f"../{marker}",
                "licenseNotes": "synthetic",
                "classes": [{"classId": 0, "label": "cola", "sku": "COLA-330"}],
                "splits": {
                    "train": [{"image": "raw/a.jpg", "annotation": "annotations/a.json"}],
                    "val": [],
                    "test": [],
                },
            }
            (dataset / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(REPO_ROOT / "ml" / "scripts" / "prepare_byond_dataset.py"),
                 "--input", str(dataset)],
                capture_output=True,
                text=True,
                cwd=REPO_ROOT,
            )
            combined = result.stdout + result.stderr
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("sourceRoot resolves outside the dataset directory", combined)
            self.assertNotIn(marker, combined)
            self.assertNotIn("Traceback", combined)


if __name__ == "__main__":
    unittest.main()
