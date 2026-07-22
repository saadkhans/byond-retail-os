"""Tests for ml/scripts/sample_inference_to_vision_event.py — the Phase 7
VisionEvent ingest contract must never regress silently (unknown/forbidden
fields would be a controlled 400 in the real API, but here they must not
even be producible).
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

from sample_inference_to_vision_event import (  # noqa: E402
    FORBIDDEN_FIELDS,
    assert_payload_safe,
    to_vision_event,
)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
EXAMPLES_DIR = REPO_ROOT / "ml" / "examples"


def _load_json(name: str):
    return json.loads((EXAMPLES_DIR / name).read_text(encoding="utf-8"))


def _base_inference() -> dict:
    return {
        "sourceType": "VISION",
        "eventType": "PRODUCT_PICKUP",
        "quantityDelta": 1,
        "locationId": "loc-1",
        "unitId": "unit-1",
        "occurredAt": "2026-07-21T10:00:00.000Z",
        "detections": [{"sku": "cola-330", "confidence": 0.5}],
    }


def _collect_keys(obj):
    if isinstance(obj, dict):
        for key, value in obj.items():
            yield key
            yield from _collect_keys(value)
    elif isinstance(obj, list):
        for item in obj:
            yield from _collect_keys(item)


class SampleFixtureTests(unittest.TestCase):
    def test_matches_committed_example_payload_exactly(self) -> None:
        inference = _load_json("sample_model_output.json")
        expected = _load_json("sample_vision_event_payload.json")
        self.assertEqual(to_vision_event(inference), expected)

    def test_required_fields_present(self) -> None:
        payload = to_vision_event(_load_json("sample_model_output.json"))
        for field in ("locationId", "unitId", "type", "occurredAt", "quantity", "candidates", "sourceType"):
            self.assertIn(field, payload)


class CandidateMappingTests(unittest.TestCase):
    def test_candidates_sorted_ranked_uppercased_scored(self) -> None:
        inference = _base_inference()
        inference["detections"] = [
            {"sku": "low-sku", "confidence": 0.2},
            {"sku": "high-sku", "confidence": 0.9},
        ]
        payload = to_vision_event(inference)
        candidates = payload["candidates"]
        self.assertEqual(candidates[0]["sku"], "HIGH-SKU")
        self.assertEqual(candidates[0]["rank"], 1)
        self.assertEqual(candidates[1]["sku"], "LOW-SKU")
        self.assertEqual(candidates[1]["rank"], 2)
        for candidate in candidates:
            self.assertIn("score", candidate)
            self.assertNotIn("confidence", candidate)

    def test_more_than_20_detections_truncated_to_20_candidates(self) -> None:
        inference = _base_inference()
        inference["detections"] = [{"sku": f"sku-{i}", "confidence": i / 100} for i in range(30)]
        payload = to_vision_event(inference)
        self.assertEqual(len(payload["candidates"]), 20)
        self.assertEqual(payload["candidates"][0]["sku"], "SKU-29")
        self.assertEqual(payload["candidates"][0]["rank"], 1)


class DuplicateSkuCollapseTests(unittest.TestCase):
    def test_duplicate_same_case_sku_collapsed_to_one_candidate(self) -> None:
        inference = _base_inference()
        inference["detections"] = [
            {"sku": "COLA-330", "confidence": 0.4},
            {"sku": "COLA-330", "confidence": 0.6},
        ]
        payload = to_vision_event(inference)
        self.assertEqual(len(payload["candidates"]), 1)
        self.assertEqual(payload["candidates"][0]["sku"], "COLA-330")

    def test_duplicate_different_case_sku_collapsed(self) -> None:
        inference = _base_inference()
        inference["detections"] = [
            {"sku": "cola-330", "confidence": 0.4},
            {"sku": "COLA-330", "confidence": 0.6},
        ]
        payload = to_vision_event(inference)
        self.assertEqual(len(payload["candidates"]), 1)
        self.assertEqual(payload["candidates"][0]["sku"], "COLA-330")

    def test_strongest_confidence_and_label_retained_and_reranked(self) -> None:
        inference = _base_inference()
        inference["detections"] = [
            {"sku": "cola-330", "confidence": 0.3, "label": "weak-label"},
            {"sku": "chips-50", "confidence": 0.5, "label": "chips"},
            {"sku": "COLA-330", "confidence": 0.9, "label": "strong-label"},
        ]
        payload = to_vision_event(inference)
        candidates = payload["candidates"]
        self.assertEqual(len(candidates), 2)
        self.assertEqual(candidates[0]["sku"], "COLA-330")
        self.assertEqual(candidates[0]["rank"], 1)
        self.assertEqual(candidates[0]["score"], 0.9)
        self.assertEqual(candidates[0]["label"], "strong-label")
        self.assertEqual(candidates[1]["sku"], "CHIPS-50")
        self.assertEqual(candidates[1]["rank"], 2)
        self.assertEqual(candidates[1]["score"], 0.5)

    def test_output_never_contains_duplicate_skus(self) -> None:
        inference = _base_inference()
        inference["detections"] = [
            {"sku": "cola-330", "confidence": 0.1},
            {"sku": "COLA-330", "confidence": 0.2},
            {"sku": "Cola-330", "confidence": 0.3},
            {"sku": "chips-50", "confidence": 0.4},
            {"sku": "CHIPS-50", "confidence": 0.5},
            {"sku": "water-500", "confidence": 0.6},
        ]
        payload = to_vision_event(inference)
        skus = [candidate["sku"] for candidate in payload["candidates"]]
        self.assertEqual(len(skus), len(set(skus)))
        self.assertEqual(sorted(skus), ["CHIPS-50", "COLA-330", "WATER-500"])


class NonFiniteConfidenceTests(unittest.TestCase):
    def test_nan_confidence_rejected(self) -> None:
        inference = _base_inference()
        inference["detections"] = [{"sku": "x", "confidence": float("nan")}]
        with self.assertRaises(ValueError):
            to_vision_event(inference)

    def test_positive_infinity_confidence_rejected(self) -> None:
        inference = _base_inference()
        inference["detections"] = [{"sku": "x", "confidence": float("inf")}]
        with self.assertRaises(ValueError):
            to_vision_event(inference)

    def test_negative_infinity_confidence_rejected(self) -> None:
        inference = _base_inference()
        inference["detections"] = [{"sku": "x", "confidence": float("-inf")}]
        with self.assertRaises(ValueError):
            to_vision_event(inference)


class TimestampValidationTests(unittest.TestCase):
    def test_trailing_z_timestamp_accepted(self) -> None:
        inference = _base_inference()
        inference["occurredAt"] = "2026-07-21T10:00:00.000Z"
        inference["captureStartedAt"] = "2026-07-21T09:59:58.000Z"
        inference["captureEndedAt"] = "2026-07-21T10:00:02.000Z"
        payload = to_vision_event(inference)
        self.assertEqual(payload["occurredAt"], "2026-07-21T10:00:00.000Z")
        self.assertEqual(payload["evidenceBundle"]["captureStartedAt"], "2026-07-21T09:59:58.000Z")
        self.assertEqual(payload["evidenceBundle"]["captureEndedAt"], "2026-07-21T10:00:02.000Z")

    def test_explicit_offset_timestamp_accepted(self) -> None:
        inference = _base_inference()
        inference["occurredAt"] = "2026-07-21T10:00:00+04:00"
        inference["captureStartedAt"] = "2026-07-21T09:59:58+04:00"
        payload = to_vision_event(inference)
        self.assertEqual(payload["occurredAt"], "2026-07-21T10:00:00+04:00")
        self.assertEqual(payload["evidenceBundle"]["captureStartedAt"], "2026-07-21T09:59:58+04:00")

    def test_malformed_occurred_at_rejected(self) -> None:
        for bad in ("not-a-date", "2026-99-99T99:00:00Z"):
            with self.subTest(value=bad):
                inference = _base_inference()
                inference["occurredAt"] = bad
                with self.assertRaises(ValueError):
                    to_vision_event(inference)

    def test_malformed_capture_started_at_rejected(self) -> None:
        for bad in ("not-a-date", "2026-99-99T99:00:00Z"):
            with self.subTest(value=bad):
                inference = _base_inference()
                inference["captureStartedAt"] = bad
                with self.assertRaises(ValueError):
                    to_vision_event(inference)

    def test_malformed_capture_ended_at_rejected(self) -> None:
        for bad in ("not-a-date", "2026-99-99T99:00:00Z"):
            with self.subTest(value=bad):
                inference = _base_inference()
                inference["captureEndedAt"] = bad
                with self.assertRaises(ValueError):
                    to_vision_event(inference)

    def test_offsetless_occurred_at_rejected(self) -> None:
        inference = _base_inference()
        inference["occurredAt"] = "2026-07-21T10:00:00"
        with self.assertRaises(ValueError) as ctx:
            to_vision_event(inference)
        self.assertIn("occurredAt must be a timezone-aware ISO-8601 timestamp", str(ctx.exception))

    def test_offsetless_capture_started_at_rejected(self) -> None:
        inference = _base_inference()
        inference["captureStartedAt"] = "2026-07-21T09:59:58"
        with self.assertRaises(ValueError) as ctx:
            to_vision_event(inference)
        self.assertIn("captureStartedAt must be a timezone-aware ISO-8601 timestamp", str(ctx.exception))

    def test_offsetless_capture_ended_at_rejected(self) -> None:
        inference = _base_inference()
        inference["captureEndedAt"] = "2026-07-21T10:00:02"
        with self.assertRaises(ValueError) as ctx:
            to_vision_event(inference)
        self.assertIn("captureEndedAt must be a timezone-aware ISO-8601 timestamp", str(ctx.exception))

    def test_plus_three_offset_timestamp_accepted(self) -> None:
        inference = _base_inference()
        inference["occurredAt"] = "2026-07-21T13:00:00+03:00"
        payload = to_vision_event(inference)
        self.assertEqual(payload["occurredAt"], "2026-07-21T13:00:00+03:00")


class ForbiddenFieldTests(unittest.TestCase):
    def test_forbidden_fields_never_appear_in_generated_payload(self) -> None:
        payload = to_vision_event(_load_json("sample_model_output.json"))
        keys_present = set(_collect_keys(payload))
        for field in FORBIDDEN_FIELDS:
            with self.subTest(field=field):
                self.assertNotIn(field, keys_present)

    def test_assert_payload_safe_rejects_smuggled_artifacts(self) -> None:
        payload = to_vision_event(_load_json("sample_model_output.json"))
        payload["artifacts"] = ["x"]
        with self.assertRaises(ValueError):
            assert_payload_safe(payload)

    def test_assert_payload_safe_rejects_candidate_image_uri(self) -> None:
        payload = to_vision_event(_load_json("sample_model_output.json"))
        payload["candidates"][0]["imageUri"] = "https://example.com/x.jpg"
        with self.assertRaises(ValueError):
            assert_payload_safe(payload)

    def test_assert_payload_safe_rejects_evidence_bundle_storage_key(self) -> None:
        payload = to_vision_event(_load_json("sample_model_output.json"))
        payload["evidenceBundle"]["storageKey"] = "s3://bucket/key"
        with self.assertRaises(ValueError):
            assert_payload_safe(payload)


class ValidationErrorTests(unittest.TestCase):
    def test_quantity_delta_zero_rejected(self) -> None:
        inference = _base_inference()
        inference["quantityDelta"] = 0
        with self.assertRaises(ValueError):
            to_vision_event(inference)

    def test_positive_delta_with_product_return_rejected(self) -> None:
        inference = _base_inference()
        inference["eventType"] = "PRODUCT_RETURN"
        inference["quantityDelta"] = 1
        with self.assertRaises(ValueError):
            to_vision_event(inference)

    def test_negative_delta_with_product_pickup_rejected(self) -> None:
        inference = _base_inference()
        inference["quantityDelta"] = -1
        with self.assertRaises(ValueError):
            to_vision_event(inference)

    def test_empty_detections_with_product_pickup_rejected(self) -> None:
        inference = _base_inference()
        inference["detections"] = []
        with self.assertRaises(ValueError):
            to_vision_event(inference)

    def test_empty_detections_with_exit_reconciliation_ok(self) -> None:
        inference = _base_inference()
        inference["eventType"] = "EXIT_RECONCILIATION"
        inference["quantityDelta"] = 1
        inference["detections"] = []
        payload = to_vision_event(inference)
        self.assertEqual(payload["candidates"], [])
        self.assertNotIn("evidenceScore", payload)

    def test_confidence_out_of_range_rejected(self) -> None:
        inference = _base_inference()
        inference["detections"] = [{"sku": "x", "confidence": 1.5}]
        with self.assertRaises(ValueError):
            to_vision_event(inference)

    def test_bad_event_type_rejected(self) -> None:
        inference = _base_inference()
        inference["eventType"] = "NOT_A_TYPE"
        with self.assertRaises(ValueError):
            to_vision_event(inference)

    def test_event_type_list_rejected_with_value_error(self) -> None:
        inference = _base_inference()
        inference["eventType"] = ["PRODUCT_PICKUP"]
        with self.assertRaises(ValueError) as ctx:
            to_vision_event(inference)
        self.assertIn("eventType is required and must be a non-empty string", str(ctx.exception))

    def test_event_type_dict_rejected_with_value_error(self) -> None:
        inference = _base_inference()
        inference["eventType"] = {"type": "PRODUCT_PICKUP"}
        with self.assertRaises(ValueError) as ctx:
            to_vision_event(inference)
        self.assertIn("eventType is required and must be a non-empty string", str(ctx.exception))


class SensitiveValueScreeningTests(unittest.TestCase):
    """Producer-side mirror of the API's assertOpaque/containsSensitiveValue:
    opaque fields must never carry credential- or payment-bearing content."""

    def test_credentialed_url_idempotency_key_rejected(self) -> None:
        inference = _base_inference()
        inference["idempotencyKey"] = "rtsp://user:pass@camera.local/feed"
        with self.assertRaises(ValueError):
            to_vision_event(inference)

    def test_api_key_fragment_idempotency_key_rejected(self) -> None:
        inference = _base_inference()
        inference["idempotencyKey"] = "api_key=abc123"
        with self.assertRaises(ValueError):
            to_vision_event(inference)

    def test_luhn_valid_pan_idempotency_key_rejected(self) -> None:
        inference = _base_inference()
        inference["idempotencyKey"] = "4111111111111111"
        with self.assertRaises(ValueError):
            to_vision_event(inference)

    def test_normal_opaque_idempotency_key_accepted(self) -> None:
        inference = _base_inference()
        inference["idempotencyKey"] = "evt-7f3a2b1c-0009"
        payload = to_vision_event(inference)
        self.assertEqual(payload["idempotencyKey"], "evt-7f3a2b1c-0009")

    def test_sensitive_label_rejected(self) -> None:
        inference = _base_inference()
        inference["detections"] = [
            {"sku": "cola-330", "confidence": 0.5, "label": "password: hunter2"}
        ]
        with self.assertRaises(ValueError):
            to_vision_event(inference)

    def test_sensitive_sku_rejected(self) -> None:
        inference = _base_inference()
        # Luhn-valid 16-digit test PAN used as a SKU.
        inference["detections"] = [{"sku": "4242424242424242", "confidence": 0.5}]
        with self.assertRaises(ValueError):
            to_vision_event(inference)


class StringLengthLimitTests(unittest.TestCase):
    """DTO caps mirrored producer-side: sku MaxLength(100), label MaxLength(200)."""

    def test_101_char_sku_rejected(self) -> None:
        inference = _base_inference()
        inference["detections"] = [{"sku": "S" * 101, "confidence": 0.5}]
        with self.assertRaises(ValueError):
            to_vision_event(inference)

    def test_100_char_sku_accepted(self) -> None:
        inference = _base_inference()
        inference["detections"] = [{"sku": "S" * 100, "confidence": 0.5}]
        payload = to_vision_event(inference)
        self.assertEqual(payload["candidates"][0]["sku"], "S" * 100)

    def test_201_char_label_rejected(self) -> None:
        inference = _base_inference()
        inference["detections"] = [{"sku": "cola-330", "confidence": 0.5, "label": "L" * 201}]
        with self.assertRaises(ValueError):
            to_vision_event(inference)

    def test_200_char_label_accepted(self) -> None:
        inference = _base_inference()
        inference["detections"] = [{"sku": "cola-330", "confidence": 0.5, "label": "L" * 200}]
        payload = to_vision_event(inference)
        self.assertEqual(payload["candidates"][0]["label"], "L" * 200)


class CaptureWindowOrderingTests(unittest.TestCase):
    """Mirror of normalizeBundle: strictly reversed capture windows are
    rejected; equal timestamps are allowed."""

    def test_capture_ended_before_started_rejected(self) -> None:
        inference = _base_inference()
        inference["captureStartedAt"] = "2026-07-21T10:00:02.000Z"
        inference["captureEndedAt"] = "2026-07-21T10:00:00.000Z"
        with self.assertRaises(ValueError):
            to_vision_event(inference)

    def test_equal_capture_timestamps_accepted(self) -> None:
        inference = _base_inference()
        inference["captureStartedAt"] = "2026-07-21T10:00:00.000Z"
        inference["captureEndedAt"] = "2026-07-21T10:00:00.000Z"
        payload = to_vision_event(inference)
        self.assertEqual(payload["evidenceBundle"]["captureStartedAt"], "2026-07-21T10:00:00.000Z")
        self.assertEqual(payload["evidenceBundle"]["captureEndedAt"], "2026-07-21T10:00:00.000Z")

    def test_ordered_capture_window_accepted(self) -> None:
        inference = _base_inference()
        inference["captureStartedAt"] = "2026-07-21T09:59:58.000Z"
        inference["captureEndedAt"] = "2026-07-21T10:00:02.000Z"
        payload = to_vision_event(inference)
        self.assertEqual(payload["evidenceBundle"]["captureEndedAt"], "2026-07-21T10:00:02.000Z")


class QuantityBoundTests(unittest.TestCase):
    """Emitted quantity = abs(quantityDelta) must fit the API's PG_INT_MAX."""

    def test_quantity_delta_above_pg_int_max_rejected(self) -> None:
        inference = _base_inference()
        inference["quantityDelta"] = 2_147_483_648
        with self.assertRaises(ValueError):
            to_vision_event(inference)

    def test_negative_quantity_delta_below_pg_int_min_rejected(self) -> None:
        inference = _base_inference()
        inference["eventType"] = "PRODUCT_RETURN"
        inference["quantityDelta"] = -2_147_483_648
        with self.assertRaises(ValueError):
            to_vision_event(inference)

    def test_quantity_delta_at_pg_int_max_accepted(self) -> None:
        inference = _base_inference()
        inference["quantityDelta"] = 2_147_483_647
        payload = to_vision_event(inference)
        self.assertEqual(payload["quantity"], 2_147_483_647)


class CliErrorHandlingTests(unittest.TestCase):
    """main() must turn every malformed-input failure into the documented
    ERROR: line with a non-zero exit — never a raw traceback."""

    def test_non_string_event_type_prints_error_line_not_traceback(self) -> None:
        inference = _base_inference()
        inference["eventType"] = []
        with tempfile.TemporaryDirectory() as tmp:
            model_output = Path(tmp) / "model_output.json"
            model_output.write_text(json.dumps(inference), encoding="utf-8")
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPTS_DIR / "sample_inference_to_vision_event.py"),
                    str(model_output),
                ],
                capture_output=True,
                text=True,
                cwd=str(REPO_ROOT),
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ERROR: eventType is required and must be a non-empty string", result.stdout)
        self.assertNotIn("Traceback", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
