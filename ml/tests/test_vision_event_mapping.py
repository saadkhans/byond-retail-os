"""Tests for ml/scripts/sample_inference_to_vision_event.py — the Phase 7
VisionEvent ingest contract must never regress silently (unknown/forbidden
fields would be a controlled 400 in the real API, but here they must not
even be producible).
"""

from __future__ import annotations

import json
import sys
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


if __name__ == "__main__":
    unittest.main()
