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
    _passes_luhn,
    assert_payload_safe,
    contains_sensitive_value,
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


class OversizedIntegerConfidenceTests(unittest.TestCase):
    """Codex P2: a JSON integer like 10**309 passes the numeric isinstance
    check but overflows float conversion, so math.isfinite raised
    OverflowError — which main() (catching only ValueError) turned into a raw
    CLI traceback. Overflow must be treated as non-finite and raise the same
    redacted ValueError, never echoing the value."""

    def test_huge_positive_integer_confidence_rejected_as_value_error(self) -> None:
        inference = _base_inference()
        inference["detections"] = [{"sku": "x", "confidence": 10**309}]
        with self.assertRaises(ValueError) as ctx:
            to_vision_event(inference)
        # Exact redacted message: names the field and constraint only, so no
        # digits of the oversized value can leak into caller logs.
        self.assertEqual(
            str(ctx.exception), "detections[0].confidence must be a finite number"
        )

    def test_huge_negative_integer_confidence_rejected_as_value_error(self) -> None:
        inference = _base_inference()
        inference["detections"] = [{"sku": "x", "confidence": -(10**309)}]
        with self.assertRaises(ValueError) as ctx:
            to_vision_event(inference)
        self.assertEqual(
            str(ctx.exception), "detections[0].confidence must be a finite number"
        )

    def test_cli_huge_integer_confidence_prints_error_line_not_traceback(self) -> None:
        # json.dump serializes Python big ints as full-precision JSON integers,
        # so this exercises the real CLI path with a 1e999-equivalent literal.
        inference = _base_inference()
        inference["detections"] = [{"sku": "x", "confidence": 10**309}]
        with tempfile.TemporaryDirectory() as tmp:
            model_output = Path(tmp) / "model_output.json"
            with model_output.open("w", encoding="utf-8") as handle:
                json.dump(inference, handle)
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
        self.assertEqual(result.returncode, 1)
        self.assertIn("ERROR: detections[0].confidence must be a finite number", result.stdout)
        self.assertNotIn("Traceback", result.stdout + result.stderr)


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


class StrictTimestampShapeTests(unittest.TestCase):
    """Python's fromisoformat is more permissive than the API's @IsDateString
    (CPython 3.11+ accepts ANY single character as the date-time separator,
    plus compact/seconds-bearing offsets), so the mapper gates timestamps on
    a strict YYYY-MM-DDTHH:MM:SS[.fff](Z|+-HH:MM) shape before parsing."""

    def test_non_t_separator_rejected(self) -> None:
        # The Codex repro: fromisoformat on 3.11+ parses this fine, but the
        # emitted string must never reach the API.
        inference = _base_inference()
        inference["occurredAt"] = "2025-01-01X00:00:00+00:00"
        with self.assertRaises(ValueError) as ctx:
            to_vision_event(inference)
        self.assertIn("occurredAt must be a timezone-aware ISO-8601 timestamp", str(ctx.exception))

    def test_space_separator_rejected(self) -> None:
        inference = _base_inference()
        inference["occurredAt"] = "2026-07-21 10:00:00+00:00"
        with self.assertRaises(ValueError) as ctx:
            to_vision_event(inference)
        self.assertIn("occurredAt must be a timezone-aware ISO-8601 timestamp", str(ctx.exception))

    def test_offset_with_seconds_rejected(self) -> None:
        inference = _base_inference()
        inference["occurredAt"] = "2026-07-21T10:00:00+01:00:30"
        with self.assertRaises(ValueError):
            to_vision_event(inference)

    def test_compact_offset_rejected(self) -> None:
        inference = _base_inference()
        inference["occurredAt"] = "2026-07-21T10:00:00+0300"
        with self.assertRaises(ValueError):
            to_vision_event(inference)

    def test_out_of_range_offset_minutes_rejected(self) -> None:
        # fromisoformat silently folds offset minutes 60-99 into the
        # timedelta, but validator.js isISO8601 requires [0-5]\d — the API
        # would 400, so the mapper must reject these shapes.
        for bad in ("2026-07-21T10:00:00+05:75", "2026-07-21T10:00:00-00:99"):
            with self.subTest(value=bad):
                inference = _base_inference()
                inference["occurredAt"] = bad
                with self.assertRaises(ValueError):
                    to_vision_event(inference)

    def test_strict_shapes_accepted(self) -> None:
        for good in (
            "2026-07-21T10:00:00Z",
            "2026-07-21T10:00:00.000Z",
            "2026-07-21T10:00:00+03:00",
        ):
            with self.subTest(value=good):
                inference = _base_inference()
                inference["occurredAt"] = good
                payload = to_vision_event(inference)
                self.assertEqual(payload["occurredAt"], good)

    def test_non_t_separator_rejected_across_all_timestamp_fields(self) -> None:
        for field in ("occurredAt", "captureStartedAt", "captureEndedAt"):
            with self.subTest(field=field):
                inference = _base_inference()
                inference[field] = "2025-01-01X00:00:00+00:00"
                with self.assertRaises(ValueError) as ctx:
                    to_vision_event(inference)
                self.assertIn(
                    f"{field} must be a timezone-aware ISO-8601 timestamp", str(ctx.exception)
                )


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

    def test_empty_detections_with_basket_affecting_types_rejected(self) -> None:
        # The basket-affecting set mirrors
        # services/api/src/common/vision-event-policy.ts: these types mutate
        # the basket on approval and therefore need >= 1 candidate.
        for event_type, quantity_delta in (
            ("PRODUCT_PICKUP", 1),
            ("PRODUCT_RETURN", -1),
            ("CART_INSERTION", 1),
        ):
            with self.subTest(event_type=event_type):
                inference = _base_inference()
                inference["eventType"] = event_type
                inference["quantityDelta"] = quantity_delta
                inference["detections"] = []
                with self.assertRaises(ValueError) as ctx:
                    to_vision_event(inference)
                self.assertIn("basket-affecting events", str(ctx.exception))

    def test_empty_detections_with_product_transfer_ok(self) -> None:
        # PRODUCT_TRANSFER is record-only (not basket-affecting), so the
        # ingest contract accepts it without candidates; the optional
        # `candidates` field is omitted rather than emitted as [].
        inference = _base_inference()
        inference["eventType"] = "PRODUCT_TRANSFER"
        inference["quantityDelta"] = 1
        inference["detections"] = []
        payload = to_vision_event(inference)
        self.assertNotIn("candidates", payload)
        self.assertNotIn("evidenceScore", payload)

    def test_empty_detections_with_exit_reconciliation_ok(self) -> None:
        inference = _base_inference()
        inference["eventType"] = "EXIT_RECONCILIATION"
        inference["quantityDelta"] = 1
        inference["detections"] = []
        payload = to_vision_event(inference)
        self.assertNotIn("candidates", payload)
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


class ErrorMessageRedactionTests(unittest.TestCase):
    """Validation errors must never echo inference-supplied values — string
    OR numeric (a PAN can arrive as a JSON number in any numeric field): a
    malformed input may carry credential- or payment-bearing content, and
    callers may log str(exception) verbatim. Messages name only the field
    and the expected shape/constraint."""

    def test_malformed_timestamp_error_does_not_echo_value(self) -> None:
        marker = "SECRETMARKER-not-a-timestamp"
        for field in ("occurredAt", "captureStartedAt", "captureEndedAt"):
            with self.subTest(field=field):
                inference = _base_inference()
                inference[field] = marker
                with self.assertRaises(ValueError) as ctx:
                    to_vision_event(inference)
                message = str(ctx.exception)
                self.assertIn(f"{field} must be a timezone-aware ISO-8601 timestamp", message)
                self.assertNotIn(marker, message)
                self.assertNotIn("SECRETMARKER", message)

    def test_sensitive_idempotency_key_rejection_does_not_echo_pan(self) -> None:
        inference = _base_inference()
        inference["idempotencyKey"] = "4111111111111111"
        with self.assertRaises(ValueError) as ctx:
            to_vision_event(inference)
        message = str(ctx.exception)
        self.assertIn("idempotencyKey", message)
        self.assertNotIn("4111111111111111", message)
        self.assertNotIn("4111", message)

    def test_invalid_event_type_error_does_not_echo_value(self) -> None:
        inference = _base_inference()
        inference["eventType"] = "BOGUS_EVENT_MARKER_ZZZ"
        with self.assertRaises(ValueError) as ctx:
            to_vision_event(inference)
        message = str(ctx.exception)
        self.assertIn("eventType must be one of", message)
        self.assertNotIn("BOGUS_EVENT_MARKER_ZZZ", message)

    def test_non_string_event_type_error_does_not_echo_value(self) -> None:
        inference = _base_inference()
        inference["eventType"] = ["LISTMARKER_QQQ"]
        with self.assertRaises(ValueError) as ctx:
            to_vision_event(inference)
        message = str(ctx.exception)
        self.assertIn("eventType is required and must be a non-empty string", message)
        self.assertNotIn("LISTMARKER_QQQ", message)

    def test_numeric_pan_confidence_error_does_not_echo_value(self) -> None:
        # Codex P1: a PAN emitted as a JSON number in `confidence` trips the
        # [0, 1] range check — the error must not print the number.
        inference = _base_inference()
        inference["detections"] = [{"sku": "x", "confidence": 4111111111111111}]
        with self.assertRaises(ValueError) as ctx:
            to_vision_event(inference)
        message = str(ctx.exception)
        self.assertIn("detections[0].confidence must be within [0, 1]", message)
        self.assertNotIn("4111111111111111", message)
        self.assertNotIn("4111", message)

    def test_nan_confidence_error_does_not_echo_value(self) -> None:
        inference = _base_inference()
        inference["detections"] = [{"sku": "x", "confidence": float("nan")}]
        with self.assertRaises(ValueError) as ctx:
            to_vision_event(inference)
        message = str(ctx.exception)
        self.assertIn("detections[0].confidence must be a finite number", message)
        self.assertNotIn("nan", message.lower())

    def test_oversized_quantity_delta_error_does_not_echo_value(self) -> None:
        # A PAN-as-JSON-number in quantityDelta exceeds PG_INT_MAX; the error
        # may name the constant bound (2147483647) but never the value.
        inference = _base_inference()
        inference["quantityDelta"] = 4111111111111111
        with self.assertRaises(ValueError) as ctx:
            to_vision_event(inference)
        message = str(ctx.exception)
        self.assertIn("quantityDelta", message)
        self.assertNotIn("4111111111111111", message)
        self.assertNotIn("4111", message)

    def test_overlong_sku_error_does_not_echo_sku(self) -> None:
        marker = "QQSKUMARKERQQ"
        overlong_sku = marker + "S" * 100  # 113 chars > MaxLength(100)
        inference = _base_inference()
        inference["detections"] = [{"sku": overlong_sku, "confidence": 0.5}]
        with self.assertRaises(ValueError) as ctx:
            to_vision_event(inference)
        message = str(ctx.exception)
        self.assertIn("detections[0].sku", message)
        self.assertIn("100", message)
        self.assertNotIn(marker, message)


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


class AsciiBoundarySecretTokenTests(unittest.TestCase):
    """Codex P2: Python's \\b is Unicode-aware, so a secret token glued to an
    accented letter carried no Python word boundary and slipped past the old
    producer screen, while the API's JavaScript patterns (ASCII \\b, word
    chars [A-Za-z0-9_]) still 400 the payload. The patterns now use explicit
    ASCII lookarounds matching the JS semantics.

    Every token-shaped fixture is assembled at RUNTIME from short pieces so
    no contiguous secret-shaped literal ever appears in source (Gitleaks)."""

    @staticmethod
    def _github_style_token(prefix: str = "") -> str:
        # "égh" + "p_" + 24 body chars -> é-adjacent GitHub-classic shape.
        return prefix + "gh" + "p_" + "A" * 24

    @staticmethod
    def _stripe_style_token(prefix: str = "") -> str:
        return prefix + "s" + "k_" + "li" + "ve_" + "B" * 12

    def test_accented_adjacent_github_style_token_rejected(self) -> None:
        token = self._github_style_token("é")
        self.assertTrue(contains_sensitive_value(token))
        inference = _base_inference()
        inference["idempotencyKey"] = token
        with self.assertRaises(ValueError):
            to_vision_event(inference)

    def test_accented_adjacent_stripe_style_token_rejected(self) -> None:
        token = self._stripe_style_token("é")
        self.assertTrue(contains_sensitive_value(token))
        inference = _base_inference()
        inference["idempotencyKey"] = token
        with self.assertRaises(ValueError):
            to_vision_event(inference)

    def test_bare_tokens_still_rejected(self) -> None:
        # Plain (boundary-at-start-of-string) forms: unchanged behavior.
        for name, token in (
            ("github", self._github_style_token()),
            ("stripe", self._stripe_style_token()),
        ):
            with self.subTest(shape=name):
                self.assertTrue(contains_sensitive_value(token))

    def test_space_delimited_tokens_still_rejected(self) -> None:
        for name, token in (
            ("github", self._github_style_token("evt ")),
            ("stripe", self._stripe_style_token("evt ")),
        ):
            with self.subTest(shape=name):
                self.assertTrue(contains_sensitive_value(token))

    def test_ascii_word_char_adjacent_forms_still_not_matched(self) -> None:
        # An ASCII word char glued to the prefix suppresses the match in the
        # JS patterns and here alike — plain-ASCII behavior is unchanged.
        for name, token in (
            ("github", self._github_style_token("X")),
            ("stripe", self._stripe_style_token("X")),
        ):
            with self.subTest(shape=name):
                self.assertFalse(contains_sensitive_value(token))


def _twenty_digit_run_with_no_luhn_window() -> str:
    """Deterministically construct a 20-digit string none of whose contiguous
    13-19 digit sub-runs passes Luhn (so it must NOT flag as a PAN). Searches
    a seeded-PRNG candidate space; each candidate fails all 35 windows with
    probability ~0.9^35, so a hit is expected within a few dozen tries."""
    import random

    rng = random.Random(0)
    for _ in range(10_000):
        candidate = "".join(rng.choice("0123456789") for _ in range(20))
        windows = (
            candidate[start : start + length]
            for length in range(13, 20)
            for start in range(20 - length + 1)
        )
        if not any(_passes_luhn(window) for window in windows):
            return candidate
    raise AssertionError("could not construct a Luhn-window-free 20-digit run")


class EmbeddedPanScreeningTests(unittest.TestCase):
    """Codex P1: a PAN hidden inside a LONGER digit run (>= 20 digits) must
    still be rejected — the screen scans every contiguous 13-19 digit sub-run
    with Luhn, instead of discarding long runs wholesale."""

    def test_pan_with_trailing_digits_in_idempotency_key_rejected(self) -> None:
        # 16-digit Luhn PAN + 4 trailing digits = 20-digit run: previously
        # evaded the 13-19 whole-run length gate.
        inference = _base_inference()
        inference["idempotencyKey"] = "41111111111111110000"
        with self.assertRaises(ValueError):
            to_vision_event(inference)

    def test_pan_with_trailing_digits_and_separators_rejected(self) -> None:
        inference = _base_inference()
        inference["idempotencyKey"] = "4111 1111 1111 1111 0000"
        with self.assertRaises(ValueError):
            to_vision_event(inference)

    def test_pan_embedded_mid_run_with_leading_digits_rejected(self) -> None:
        # 2 leading + 16-digit PAN + 2 trailing digits = 20-digit run.
        inference = _base_inference()
        inference["idempotencyKey"] = "12" + "4111111111111111" + "34"
        with self.assertRaises(ValueError):
            to_vision_event(inference)

    def test_pan_embedded_in_long_run_in_sku_and_label_rejected(self) -> None:
        embedded = "41111111111111110000"
        for field_patch in (
            {"detections": [{"sku": embedded, "confidence": 0.5}]},
            {"detections": [{"sku": "cola-330", "confidence": 0.5, "label": embedded}]},
        ):
            with self.subTest(patch=field_patch):
                inference = _base_inference()
                inference.update(field_patch)
                with self.assertRaises(ValueError):
                    to_vision_event(inference)

    def test_20_digit_run_without_any_luhn_window_accepted(self) -> None:
        clean_run = _twenty_digit_run_with_no_luhn_window()
        self.assertFalse(contains_sensitive_value(clean_run))
        inference = _base_inference()
        inference["idempotencyKey"] = clean_run
        payload = to_vision_event(inference)
        self.assertEqual(payload["idempotencyKey"], clean_run)

    def test_short_non_luhn_digit_run_still_accepted(self) -> None:
        # 13-digit run whose only window (itself) fails Luhn: behavior of
        # exact 13-19 runs is unchanged by the sliding-window unification.
        self.assertFalse(contains_sensitive_value("1234567890123"))
        inference = _base_inference()
        inference["idempotencyKey"] = "order-1234567890123"
        payload = to_vision_event(inference)
        self.assertEqual(payload["idempotencyKey"], "order-1234567890123")

    def test_whole_run_pan_rejections_still_fire(self) -> None:
        for pan in ("4111111111111111", "4242 4242 4242 4242"):
            with self.subTest(pan=pan):
                self.assertTrue(contains_sensitive_value(pan))

    def test_normal_opaque_values_still_accepted(self) -> None:
        # Note: date-and-serial values whose separated digit runs reach 13+
        # digits (e.g. "sku-2026-07-21-000123") CAN now flag when a window
        # happens to pass Luhn — accepted over-strictness in the safe
        # direction. Normal opaque keys keep digit runs under 13.
        for value in ("evt-7f3a2b1c-0009", "sku-2026-07-21-0001", "cam42-frame-8891"):
            with self.subTest(value=value):
                self.assertFalse(contains_sensitive_value(value))


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


class CliOutWriteTests(unittest.TestCase):
    """The --out write path must be guarded like the read path: an unwritable
    destination is the documented ERROR: line + exit 1, never a traceback."""

    def _run_cli(self, *extra_args: str, inference: dict) -> subprocess.CompletedProcess:
        with tempfile.TemporaryDirectory() as tmp:
            model_output = Path(tmp) / "model_output.json"
            model_output.write_text(json.dumps(inference), encoding="utf-8")
            return subprocess.run(
                [
                    sys.executable,
                    str(SCRIPTS_DIR / "sample_inference_to_vision_event.py"),
                    str(model_output),
                    *extra_args,
                ],
                capture_output=True,
                text=True,
                cwd=str(REPO_ROOT),
            )

    def test_out_into_nonexistent_directory_prints_error_line_not_traceback(self) -> None:
        with tempfile.TemporaryDirectory() as out_tmp:
            missing_out = Path(out_tmp) / "no" / "such" / "dir" / "payload.json"
            result = self._run_cli("--out", str(missing_out), inference=_base_inference())
            self.assertFalse(missing_out.exists())
        self.assertEqual(result.returncode, 1)
        self.assertIn(f"ERROR: cannot write output file: {missing_out}", result.stdout)
        self.assertNotIn("Traceback", result.stdout + result.stderr)
        # The error names the path and exception class only — never payload
        # content.
        self.assertNotIn("locationId", result.stdout + result.stderr)

    def test_out_to_valid_path_writes_payload_and_exits_zero(self) -> None:
        with tempfile.TemporaryDirectory() as out_tmp:
            out_path = Path(out_tmp) / "payload.json"
            result = self._run_cli("--out", str(out_path), inference=_base_inference())
            self.assertEqual(result.returncode, 0)
            self.assertNotIn("ERROR", result.stdout + result.stderr)
            written = json.loads(out_path.read_text(encoding="utf-8"))
        self.assertEqual(written, to_vision_event(_base_inference()))


if __name__ == "__main__":
    unittest.main()
