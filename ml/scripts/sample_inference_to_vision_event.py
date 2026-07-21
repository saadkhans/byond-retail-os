"""Convert ML model inference output into a Phase 7 VisionEvent ingest payload.

This is the ONLY bridge between CV model output and `POST /vision-events`
(services/api/src/vision). The Phase 7 API runs a whitelisting
ValidationPipe (`forbidNonWhitelisted: true`): any field outside its DTO
shape is a hard 400. That is a deliberate policy, not an accident — vision
events are evidence for a human review workflow, never trusted as ground
truth, so the ingest contract intentionally carries no artifacts, no
storage keys, no raw media, and no model provenance. This module enforces
the same policy on the producing side: `assert_payload_safe()` rejects any
forbidden or unlisted field before a payload is ever emitted, so a
misconfigured model adapter fails loudly here instead of learning about it
from a 400 in production.

`modelKey` and `modelVersion` are internal-only inputs (which model
produced this inference) and are NEVER emitted into the payload.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

EVENT_TYPES = frozenset(
    {
        "PRODUCT_PICKUP",
        "PRODUCT_RETURN",
        "PRODUCT_TRANSFER",
        "CART_INSERTION",
        "EXIT_RECONCILIATION",
    }
)

MAX_CANDIDATES = 20

# Fields that must never appear anywhere in an emitted payload, regardless of
# nesting depth — evidence stays intentionally lightweight (see module
# docstring). Anything here reaching the API would be rejected anyway; we
# fail here so a bad adapter is caught at the source.
FORBIDDEN_FIELDS = frozenset(
    {
        "artifacts",
        "metadata",
        "sourceId",
        "modelName",
        "modelVersion",
        "modelKey",
        "notes",
        "imageUri",
        "imageUris",
        "storageKey",
        "storageKeys",
        "media",
        "rawMedia",
        "frames",
        "video",
        "evidence",
        "evidenceUri",
    }
)

TOP_LEVEL_ALLOWED_FIELDS = frozenset(
    {
        "locationId",
        "unitId",
        "deviceId",
        "sessionId",
        "type",
        "occurredAt",
        "quantity",
        "candidates",
        "sourceType",
        "evidenceBundle",
        "evidenceScore",
        "idempotencyKey",
    }
)
CANDIDATE_ALLOWED_FIELDS = frozenset({"sku", "rank", "score", "label"})
EVIDENCE_BUNDLE_ALLOWED_FIELDS = frozenset({"sourceType", "captureStartedAt", "captureEndedAt"})


def _iter_dicts(obj):
    if isinstance(obj, dict):
        yield obj
        for value in obj.values():
            yield from _iter_dicts(value)
    elif isinstance(obj, list):
        for item in obj:
            yield from _iter_dicts(item)


def _check_whitelist(node, allowed: frozenset, label: str) -> None:
    if not isinstance(node, dict):
        raise ValueError(f"{label} must be an object")
    unexpected = set(node.keys()) - allowed
    if unexpected:
        raise ValueError(f"{label} contains fields outside the allowed shape: {sorted(unexpected)}")


def assert_payload_safe(payload: dict) -> None:
    """Guard against emitting anything the Phase 7 API would 400 on.

    Two independent checks: (a) no FORBIDDEN_FIELDS anywhere in the payload,
    at any nesting depth; (b) every object present matches its known
    whitelist exactly (top level, each candidate, evidenceBundle).
    """
    if not isinstance(payload, dict):
        raise ValueError("payload must be an object")

    for node in _iter_dicts(payload):
        forbidden = set(node.keys()) & FORBIDDEN_FIELDS
        if forbidden:
            raise ValueError(f"forbidden field(s) may not appear in a vision-event payload: {sorted(forbidden)}")

    _check_whitelist(payload, TOP_LEVEL_ALLOWED_FIELDS, "payload")
    for candidate in payload.get("candidates") or []:
        _check_whitelist(candidate, CANDIDATE_ALLOWED_FIELDS, "candidate")
    if "evidenceBundle" in payload:
        _check_whitelist(payload["evidenceBundle"], EVIDENCE_BUNDLE_ALLOWED_FIELDS, "evidenceBundle")


def _require_nonempty_string(value, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{field} is required and must be a non-empty string")
    return value


def to_vision_event(inference: dict) -> dict:
    """Map ML model output (internal shape) to a POST /vision-events payload.

    Raises ValueError with a message naming the offending field for any
    input that would not produce a valid, whitelist-safe payload.
    """
    if not isinstance(inference, dict):
        raise ValueError("inference output must be an object")

    source_type = inference.get("sourceType", "VISION")
    if source_type != "VISION":
        raise ValueError(f"sourceType must be 'VISION' for vision model inference, got {source_type!r}")

    event_type = inference.get("eventType")
    if event_type not in EVENT_TYPES:
        raise ValueError(f"eventType must be one of {sorted(EVENT_TYPES)}, got {event_type!r}")

    if "quantityDelta" not in inference:
        raise ValueError("quantityDelta is required")
    quantity_delta = inference["quantityDelta"]
    if not isinstance(quantity_delta, int) or isinstance(quantity_delta, bool):
        raise ValueError(f"quantityDelta must be an integer, got {quantity_delta!r}")
    if quantity_delta == 0:
        raise ValueError("quantityDelta must not be zero")
    if quantity_delta < 0 and event_type != "PRODUCT_RETURN":
        raise ValueError(
            f"negative quantityDelta is only valid with eventType PRODUCT_RETURN, got eventType {event_type!r}"
        )
    if quantity_delta > 0 and event_type == "PRODUCT_RETURN":
        raise ValueError("PRODUCT_RETURN requires a negative quantityDelta, got a positive value")
    quantity = abs(quantity_delta)

    location_id = _require_nonempty_string(inference.get("locationId"), "locationId")
    unit_id = _require_nonempty_string(inference.get("unitId"), "unitId")
    occurred_at = _require_nonempty_string(inference.get("occurredAt"), "occurredAt")

    detections = inference.get("detections")
    if not isinstance(detections, list):
        raise ValueError("detections is required and must be a list")

    candidates = []
    for idx, detection in enumerate(detections):
        if not isinstance(detection, dict):
            raise ValueError(f"detections[{idx}] must be an object")
        sku = detection.get("sku")
        if not isinstance(sku, str) or not sku.strip():
            raise ValueError(f"detections[{idx}].sku is required and must be a non-empty string")
        confidence = detection.get("confidence")
        if not isinstance(confidence, (int, float)) or isinstance(confidence, bool):
            raise ValueError(f"detections[{idx}].confidence is required and must be a number")
        if confidence < 0 or confidence > 1:
            raise ValueError(f"detections[{idx}].confidence must be within [0, 1], got {confidence!r}")

        candidate = {"sku": sku.strip().upper(), "confidence": float(confidence)}
        label = detection.get("label")
        if label is not None:
            if not isinstance(label, str) or not label:
                raise ValueError(f"detections[{idx}].label must be a non-empty string when provided")
            candidate["label"] = label
        candidates.append(candidate)

    if not candidates and event_type != "EXIT_RECONCILIATION":
        raise ValueError("basket-affecting events need >= 1 candidate")

    candidates.sort(key=lambda c: c["confidence"], reverse=True)
    candidates = candidates[:MAX_CANDIDATES]

    ranked_candidates = []
    for rank, candidate in enumerate(candidates, start=1):
        ranked = {"sku": candidate["sku"], "rank": rank, "score": round(candidate["confidence"], 4)}
        if "label" in candidate:
            ranked["label"] = candidate["label"]
        ranked_candidates.append(ranked)

    payload = {
        "locationId": location_id,
        "unitId": unit_id,
        "type": event_type,
        "occurredAt": occurred_at,
        "quantity": quantity,
        "candidates": ranked_candidates,
        "sourceType": source_type,
    }

    device_id = inference.get("deviceId")
    if device_id is not None:
        payload["deviceId"] = _require_nonempty_string(device_id, "deviceId")

    session_id = inference.get("checkoutSessionId")
    if session_id is not None:
        payload["sessionId"] = _require_nonempty_string(session_id, "checkoutSessionId")

    if ranked_candidates:
        payload["evidenceScore"] = ranked_candidates[0]["score"]

    capture_started_at = inference.get("captureStartedAt")
    capture_ended_at = inference.get("captureEndedAt")
    if capture_started_at is not None or capture_ended_at is not None:
        bundle = {"sourceType": "VISION"}
        if capture_started_at is not None:
            bundle["captureStartedAt"] = _require_nonempty_string(capture_started_at, "captureStartedAt")
        if capture_ended_at is not None:
            bundle["captureEndedAt"] = _require_nonempty_string(capture_ended_at, "captureEndedAt")
        payload["evidenceBundle"] = bundle

    idempotency_key = inference.get("idempotencyKey")
    if idempotency_key is not None:
        if not isinstance(idempotency_key, str) or not (1 <= len(idempotency_key) <= 100):
            raise ValueError("idempotencyKey must be a string between 1 and 100 characters")
        payload["idempotencyKey"] = idempotency_key

    assert_payload_safe(payload)
    return payload


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Convert ML model inference output into a Phase 7 VisionEvent ingest payload."
    )
    parser.add_argument("model_output", help="Path to a model output JSON file")
    parser.add_argument("--out", default=None, help="Write the payload JSON to this file instead of stdout")
    args = parser.parse_args(argv)

    path = Path(args.model_output)
    try:
        inference = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        print(f"ERROR: could not read {path}: {exc}")
        return 1
    except json.JSONDecodeError as exc:
        print(f"ERROR: {path} is not valid JSON: {exc}")
        return 1

    try:
        payload = to_vision_event(inference)
    except ValueError as exc:
        print(f"ERROR: {exc}")
        return 1

    rendered = json.dumps(payload, indent=2, sort_keys=True)
    if args.out:
        Path(args.out).write_text(rendered + "\n", encoding="utf-8")
    else:
        print(rendered)
    return 0


if __name__ == "__main__":
    sys.exit(main())
