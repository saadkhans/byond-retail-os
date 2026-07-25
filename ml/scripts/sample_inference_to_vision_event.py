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
import datetime
import json
import math
import re
import sys
import urllib.parse
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

# Event types whose APPROVAL mutates the linked session's basket — must stay
# in lockstep with BASKET_AFFECTING_EVENT_TYPES in
# services/api/src/common/vision-event-policy.ts. Only these require at least
# one candidate; record-only types (PRODUCT_TRANSFER, EXIT_RECONCILIATION)
# are accepted by the ingest contract without candidates.
BASKET_AFFECTING_EVENT_TYPES = frozenset(
    {
        "PRODUCT_PICKUP",
        "PRODUCT_RETURN",
        "CART_INSERTION",
    }
)

# DTO string caps mirrored from
# services/api/src/vision/dto/ingest-vision-event.dto.ts: the mapper emits
# the normalized SKU (trimmed, uppercased) and the label verbatim, so those
# are the strings the API's MaxLength validators see.
MAX_SKU_LENGTH = 100
MAX_LABEL_LENGTH = 200

# Largest integer quantity the API accepts (Postgres int4; mirrors
# services/api/src/common/integer-bounds.ts PG_INT_MAX).
PG_INT_MAX = 2_147_483_647

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


# --- Sensitive-value screening ---------------------------------------------
# Producer-side mirror of the API's `containsSensitiveValue` guard
# (services/api/src/common/sensitive-keys.ts), which the vision service
# applies via `assertOpaque` (services/api/src/vision/vision-events.service.ts)
# to every free-form string persisted verbatim. Opaque fields (idempotencyKey,
# candidate SKUs and labels) must never carry credential- or payment-bearing
# content: credentialed URLs (rtsp://user:pass@cam.local), api-key/token
# fragments, or Luhn-valid card numbers. Screening here means a misconfigured
# adapter fails loudly at the source instead of via a 400 in production.

# URLs/connection strings: any scheme://... run (candidates get parsed), and
# a regex backstop for scheme://user:pass@ forms the parser rejects.
_URL_CANDIDATE = re.compile(r"[a-zA-Z][a-zA-Z0-9+.\-]*://[^\s\"'<>]+")
_USERINFO_BACKSTOP = re.compile(r"[a-zA-Z][a-zA-Z0-9+.\-]*://[^/\s@]+:[^/\s@]*@")

# key=value credential fragments, valid-URL or not. The leading boundary keeps
# innocent substrings out ("monkey=1", "oauth=..." never match).
_KEY_VALUE_CREDENTIAL = re.compile(
    r"(?:^|[?&;#,\s])(?:access[-_ ]?token|refresh[-_ ]?token|session[-_ ]?token"
    r"|id[-_ ]?token|api[-_ ]?key|client[-_ ]?secret|token|secret|password"
    r"|passwd|pwd|signature|sig|auth|authorization|bearer|key|cvv2|cvv|cvc2"
    r"|cvc|cvn|csc|pin|pan)\s*=\s*[^;&\s]",
    re.IGNORECASE,
)

# key: value credential fragments in free-form text. The value must not start
# with '/' or ':' (so "https://..." never matches) and ambiguous label words
# (bare key/sig/auth) are omitted, exactly like the service.
_KEY_COLON_CREDENTIAL = re.compile(
    r"(?:^|[?&;#,\s])(?:access[-_ ]?token|refresh[-_ ]?token|session[-_ ]?token"
    r"|id[-_ ]?token|api[-_ ]?key|client[-_ ]?secret|token|secret|password"
    r"|passwd|pwd|authorization|bearer|cvv2|cvv|cvc2|cvc|cvn|csc|pin|pan)"
    r"\s*:\s*[^/\s:]",
    re.IGNORECASE,
)

# Bare well-known secret tokens (no key=/key: label, not inside a URL): a
# fixed allow-list of provider formats, NOT an entropy heuristic — opaque
# fields are legitimately random-looking. Case-sensitive like the service.
#
# JS-parity boundaries: the API's patterns (KNOWN_SECRET_TOKENS in
# services/api/src/common/sensitive-keys.ts) use JavaScript \b, whose word
# chars are ASCII-only ([A-Za-z0-9_]). Python's \b is Unicode-aware, so a
# token glued to an accented letter ("é" + "ghp_" + body) has NO Python word
# boundary and would slip past this screen while the API still 400s it.
# Every boundary is therefore an explicit ASCII lookaround — leading
# (?<![A-Za-z0-9_]), trailing (?![A-Za-z0-9_]) — matching JS \b semantics at
# each token's edges. All token edges here abut ASCII word chars (leading
# edges are alnum; trailing classes are alnum or alnum plus '-'/'_', where
# backtracking preserves the same accept set as \b), so the substitution is
# exact where it matters and never looser than the service.
_ASCII_BOUNDARY_START = r"(?<![A-Za-z0-9_])"
_ASCII_BOUNDARY_END = r"(?![A-Za-z0-9_])"
_KNOWN_SECRET_TOKENS = (
    # Stripe-style keys: sk_live_/pk_live_/rk_live_/sk_test_/...
    re.compile(_ASCII_BOUNDARY_START + r"[sprk]k_(?:live|test)_[A-Za-z0-9]{8,}" + _ASCII_BOUNDARY_END),
    # JSON Web Tokens: three base64url segments, header begins `eyJ`.
    re.compile(
        _ASCII_BOUNDARY_START
        + r"eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}"
        + _ASCII_BOUNDARY_END
    ),
    # AWS access-key ids: AKIA/ASIA/AKID + uppercase-alphanumeric body.
    re.compile(_ASCII_BOUNDARY_START + r"(?:AKIA|ASIA|AKID)[0-9A-Z]{12,}" + _ASCII_BOUNDARY_END),
    # GitHub tokens: ghp_/gho_/ghs_/ghr_/ghu_ + body.
    re.compile(_ASCII_BOUNDARY_START + r"gh[posru]_[A-Za-z0-9]{20,}" + _ASCII_BOUNDARY_END),
    # GitHub fine-grained PATs: github_pat_ + body.
    re.compile(_ASCII_BOUNDARY_START + r"github_pat_[A-Za-z0-9_]{20,}" + _ASCII_BOUNDARY_END),
    # Google API keys: AIza + body.
    re.compile(_ASCII_BOUNDARY_START + r"AIza[0-9A-Za-z_\-]{20,}" + _ASCII_BOUNDARY_END),
    # Slack tokens: xoxb-/xoxa-/xoxp-/xoxr-/xoxs- + body (trailing boundary
    # sits after an alnum/'-' body char, exactly like the JS pattern).
    re.compile(_ASCII_BOUNDARY_START + r"xox[baprs]-[0-9A-Za-z\-]{10,}" + _ASCII_BOUNDARY_END),
)

# Payment-card numbers: 13-19 digit runs, optionally space/dash separated,
# Luhn-validated so ordinary serial/order numbers pass through.
_PAN_CANDIDATE = re.compile(r"\d(?:[ \-]?\d){11,}")

# Credential/payment-shaped KEY detection for URL query-parameter names,
# ported from `isSensitiveKey` in sensitive-keys.ts (?access_token=...,
# ?X-Amz-Signature=..., ?apiToken=... must all flag).
_SENSITIVE_KEY_EXACT = frozenset(
    {
        "password", "passwordhash", "secret", "secretkey", "clientsecret",
        "privatekey", "token", "accesstoken", "refreshtoken", "sessiontoken",
        "idtoken", "bearer", "bearertoken", "apikey", "authorization",
        "cardnumber", "creditcard", "creditcardnumber", "cvv", "cvv2", "cvc",
        "cvc2", "cvn", "csc", "cid", "cardverificationvalue",
        "cardverificationcode", "cardverificationnumber", "cardsecuritycode",
        "primaryaccountnumber", "iban", "accesskeyid", "track1", "track2",
        "track3", "trackdata", "magstripe", "magstripedata", "magneticstripe",
        "magneticstripedata",
    }
)
_SENSITIVE_KEY_SUFFIXES = (
    "token", "secret", "password", "apikey", "cardnumber", "accountnumber",
    "pannumber", "panno", "cardpan", "accountpan", "paymentpan", "pinnumber",
    "pinno", "pinblock", "cardpin", "paymentpin", "debitpin", "encryptedpin",
    "cvv", "cvv2", "cvc", "cvc2", "cvn", "csc", "verificationvalue",
    "verificationcode", "verificationnumber", "securitycode", "accesskey",
    "accesskeyid", "accountkey", "track1", "track2", "track3", "trackdata",
    "magstripe", "magstripedata", "magneticstripe", "magneticstripedata",
)
_SENSITIVE_KEY_TOKENS = frozenset(
    {
        "pan", "pin", "cvv", "cvv2", "cvc", "cvc2", "cvn", "csc", "iban",
        "track1", "track2", "track3", "magstripe",
    }
)
_TRACK_EQUIVALENT = re.compile(r"track[123]equivalent")
_SENSITIVE_PARAM_EXTRA = frozenset({"key", "pwd", "passwd", "sig", "signature", "auth"})


def _normalize_key(key: str) -> str:
    return re.sub(r"[^a-z0-9]", "", key.lower())


def _tokenize_key(key: str) -> list:
    """Splits on separators AND camelCase boundaries: paymentPanNumber -> [payment, pan, number]."""
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", key)
    spaced = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", spaced)
    return [token.lower() for token in re.split(r"[^a-zA-Z0-9]+", spaced) if token]


def _is_sensitive_key(key: str) -> bool:
    normalized = _normalize_key(key)
    if (
        normalized in _SENSITIVE_KEY_EXACT
        or any(normalized.endswith(suffix) for suffix in _SENSITIVE_KEY_SUFFIXES)
        or _TRACK_EQUIVALENT.search(normalized)
    ):
        return True
    tokens = _tokenize_key(key)
    if any(token in _SENSITIVE_KEY_TOKENS for token in tokens):
        return True
    return any(
        token == "track" and tokens[index + 1] in {"1", "2", "3"}
        for index, token in enumerate(tokens[:-1])
    )


def _is_sensitive_param_name(name: str) -> bool:
    normalized = _normalize_key(name)
    return (
        normalized in _SENSITIVE_PARAM_EXTRA
        # Provider-namespaced signed-URL params: X-Amz-Signature,
        # X-Goog-Signature, X-Amz-Credential, ...
        or normalized.endswith("signature")
        or normalized.endswith("credential")
        or _is_sensitive_key(name)
    )


def _contains_credential_value(text: str) -> bool:
    for candidate in _URL_CANDIDATE.findall(text):
        try:
            url = urllib.parse.urlsplit(candidate)
            if url.username or url.password:
                return True
            for name, _value in urllib.parse.parse_qsl(url.query, keep_blank_values=True):
                if _is_sensitive_param_name(name):
                    return True
        except ValueError:
            pass  # Not parseable — the regex backstops below still apply.
    return bool(
        _USERINFO_BACKSTOP.search(text)
        or _KEY_VALUE_CREDENTIAL.search(text)
        or _KEY_COLON_CREDENTIAL.search(text)
    )


def _passes_luhn(digits: str) -> bool:
    total = 0
    for index, char in enumerate(reversed(digits)):
        digit = ord(char) - 48
        if index % 2 == 1:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit
    return total % 10 == 0


def _contains_payment_card_value(text: str) -> bool:
    # For every digit run of length >= 13 (no upper cutoff), Luhn-test ALL
    # contiguous sub-runs of PAN length (13-19): a card number padded or
    # prefixed with extra digits ("4111111111111111" + "0000" = 20 digits)
    # must still flag. For a run of exactly 13-19 digits the windows include
    # the whole run, so this is a strict superset of the old whole-run check.
    # Deliberately stricter than the Phase 7 service's greedy-run check:
    # producer-side over-strictness is safe — the mapper may reject what the
    # API would accept, never the reverse. Work is bounded at
    # O(run_length x 7) windows per run.
    for candidate in _PAN_CANDIDATE.findall(text):
        digits = candidate.replace(" ", "").replace("-", "")
        if len(digits) < 13:
            continue
        for length in range(13, 20):
            for start in range(len(digits) - length + 1):
                if _passes_luhn(digits[start : start + length]):
                    return True
    return False


def _contains_sensitive_value(text: str) -> bool:
    return (
        _contains_credential_value(text)
        or any(pattern.search(text) for pattern in _KNOWN_SECRET_TOKENS)
        or _contains_payment_card_value(text)
    )


def contains_sensitive_value(value: str) -> bool:
    """Public alias of the sensitive-value screen (credential URLs,
    api-key/token fragments, known secret-token formats, Luhn-valid card
    numbers). Exposed so other Phase 8 tooling (the dataset-manifest
    validator) can apply the exact same screening; identical behavior to the
    internal check."""
    return _contains_sensitive_value(value)


def _assert_opaque(name: str, value: str) -> None:
    """Mirror of the API's `assertOpaque`: reject credential- or payment-
    bearing content in fields persisted verbatim. Never echoes the value —
    the whole point is that it may be a secret."""
    if _contains_sensitive_value(value):
        raise ValueError(
            f"{name} must be an opaque value and must not contain credential- "
            "or payment-bearing content (credential URLs, api-key/token "
            "fragments, or card numbers); secrets belong in a secret store, "
            "and payment data must never be stored"
        )


def _require_nonempty_string(value, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{field} is required and must be a non-empty string")
    return value


# Strict ISO-8601 shape gate applied BEFORE datetime.fromisoformat, which is
# far more permissive than the API side: CPython 3.11+ accepts ANY single
# character as the date-time separator ("2025-01-01X00:00:00+00:00"),
# space-separated forms, compact +-HHMM offsets, and offsets with seconds —
# strings that would be emitted verbatim and 400 at POST /vision-events.
# Only literal-'T' timestamps with a full date, full time, optional
# fractional seconds, and a mandatory 'Z' or +-HH:MM offset pass. This is a
# strict SUBSET of what services/api's @IsDateString (validator.js isISO8601
# in its default, loose mode) accepts — the safe direction: the mapper can
# never emit a timestamp the API rejects.
_ISO8601_STRICT = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:[0-5]\d)$"
)


def _parse_iso8601(name: str, value: str) -> datetime.datetime:
    # Timestamp errors never echo the supplied value: a malformed "timestamp"
    # may be an arbitrary string (even a secret pasted into the wrong field),
    # and the raised message may end up in caller logs.
    if not _ISO8601_STRICT.fullmatch(value):
        raise ValueError(
            f"{name} must be a timezone-aware ISO-8601 timestamp shaped "
            "YYYY-MM-DDTHH:MM:SS[.fff](Z|+HH:MM|-HH:MM)"
        )
    # .replace keeps trailing-Z inputs parseable on Python < 3.11.
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError(f"{name} must be an ISO-8601 timestamp string") from None
    if parsed.tzinfo is None:
        # An offset-less stamp would be emitted verbatim and the API's
        # `new Date()` would interpret it in server-local time, silently
        # shifting stored event times — so reject rather than normalize.
        raise ValueError(
            f"{name} must be a timezone-aware ISO-8601 timestamp (include an offset or 'Z')"
        )
    return parsed


def _require_iso8601(name: str, value) -> str:
    """Require a non-empty, timezone-aware ISO-8601 timestamp string
    (trailing 'Z' or an explicit UTC offset)."""
    _require_nonempty_string(value, name)
    _parse_iso8601(name, value)
    return value


def to_vision_event(inference: dict) -> dict:
    """Map ML model output (internal shape) to a POST /vision-events payload.

    Raises ValueError with a message naming the offending field for any
    input that would not produce a valid, whitelist-safe payload.
    """
    if not isinstance(inference, dict):
        raise ValueError("inference output must be an object")

    # Error messages below never echo inference-supplied values — string OR
    # numeric: malformed input can carry credential-/payment-bearing content
    # (a PAN can arrive as a JSON number in any numeric field), and callers
    # may log the raised message verbatim. Errors name the field and the
    # expected shape/constraint only.
    source_type = inference.get("sourceType", "VISION")
    if source_type != "VISION":
        raise ValueError("sourceType must be 'VISION' for vision model inference")

    event_type = inference.get("eventType")
    # isinstance guard first: a non-string (list/dict/...) must be a clear
    # ValueError, not a TypeError from the frozenset membership test below.
    if not isinstance(event_type, str) or not event_type:
        raise ValueError("eventType is required and must be a non-empty string")
    if event_type not in EVENT_TYPES:
        raise ValueError(f"eventType must be one of {sorted(EVENT_TYPES)}")

    if "quantityDelta" not in inference:
        raise ValueError("quantityDelta is required")
    quantity_delta = inference["quantityDelta"]
    if not isinstance(quantity_delta, int) or isinstance(quantity_delta, bool):
        # No value echo: the supplied object may be an arbitrary string/list.
        raise ValueError("quantityDelta must be an integer")
    if quantity_delta == 0:
        raise ValueError("quantityDelta must not be zero")
    if quantity_delta < 0 and event_type != "PRODUCT_RETURN":
        raise ValueError("negative quantityDelta is only valid with eventType PRODUCT_RETURN")
    if quantity_delta > 0 and event_type == "PRODUCT_RETURN":
        raise ValueError("PRODUCT_RETURN requires a negative quantityDelta, got a positive value")
    quantity = abs(quantity_delta)
    if quantity > PG_INT_MAX:
        raise ValueError(f"quantityDelta magnitude must not exceed {PG_INT_MAX} (the API integer bound)")

    location_id = _require_nonempty_string(inference.get("locationId"), "locationId")
    unit_id = _require_nonempty_string(inference.get("unitId"), "unitId")
    occurred_at = _require_iso8601("occurredAt", inference.get("occurredAt"))

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
        # Screen the RAW sku (before uppercasing, which would defeat the
        # case-sensitive secret-token patterns), like the service does.
        _assert_opaque(f"detections[{idx}].sku", sku)
        normalized_sku = sku.strip().upper()
        # The emitted (normalized) sku is what the API's MaxLength(100) sees.
        if len(normalized_sku) > MAX_SKU_LENGTH:
            raise ValueError(f"detections[{idx}].sku must be at most {MAX_SKU_LENGTH} characters when normalized")
        confidence = detection.get("confidence")
        if not isinstance(confidence, (int, float)) or isinstance(confidence, bool):
            raise ValueError(f"detections[{idx}].confidence is required and must be a number")
        # No value echo (see the redaction note above): a "confidence" can be
        # an arbitrary number — even a card number typed as a JSON number.
        # Overflow guard: a JSON integer of arbitrary precision (e.g. 10**309)
        # passes the isinstance check but overflows float conversion, so
        # math.isfinite raises OverflowError ("int too large to convert to
        # float"). main() catches only ValueError, so an uncaught OverflowError
        # would traceback the CLI — treat overflow as non-finite and raise the
        # same redacted error.
        try:
            confidence_is_finite = math.isfinite(confidence)
        except OverflowError:
            confidence_is_finite = False
        if not confidence_is_finite:
            raise ValueError(f"detections[{idx}].confidence must be a finite number")
        if confidence < 0 or confidence > 1:
            raise ValueError(f"detections[{idx}].confidence must be within [0, 1]")

        candidate = {"sku": normalized_sku, "confidence": float(confidence)}
        label = detection.get("label")
        if label is not None:
            if not isinstance(label, str) or not label:
                raise ValueError(f"detections[{idx}].label must be a non-empty string when provided")
            if len(label) > MAX_LABEL_LENGTH:
                raise ValueError(f"detections[{idx}].label must be at most {MAX_LABEL_LENGTH} characters")
            _assert_opaque(f"detections[{idx}].label", label)
            candidate["label"] = label
        candidates.append(candidate)

    if not candidates and event_type in BASKET_AFFECTING_EVENT_TYPES:
        raise ValueError(
            f"basket-affecting events ({sorted(BASKET_AFFECTING_EVENT_TYPES)}) need >= 1 candidate"
        )

    # Collapse duplicate SKUs (already uppercase-normalized above): keep the
    # strongest detection per SKU — the Phase 7 API rejects case-insensitive
    # duplicate candidate SKUs with a 400. On an exact confidence tie the
    # first-seen entry wins.
    strongest_by_sku: dict[str, dict] = {}
    for candidate in candidates:
        existing = strongest_by_sku.get(candidate["sku"])
        if existing is None or candidate["confidence"] > existing["confidence"]:
            strongest_by_sku[candidate["sku"]] = candidate
    candidates = list(strongest_by_sku.values())

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
        "sourceType": source_type,
    }

    # `candidates` is optional in the ingest DTO: omit it entirely for
    # record-only events with no detections rather than emitting [].
    if ranked_candidates:
        payload["candidates"] = ranked_candidates

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
            bundle["captureStartedAt"] = _require_iso8601("captureStartedAt", capture_started_at)
        if capture_ended_at is not None:
            bundle["captureEndedAt"] = _require_iso8601("captureEndedAt", capture_ended_at)
        # Mirror the service's normalizeBundle: a strictly reversed capture
        # window is a 400 (equal timestamps are allowed).
        if capture_started_at is not None and capture_ended_at is not None:
            if _parse_iso8601("captureEndedAt", bundle["captureEndedAt"]) < _parse_iso8601(
                "captureStartedAt", bundle["captureStartedAt"]
            ):
                raise ValueError("captureEndedAt must not be before captureStartedAt")
        payload["evidenceBundle"] = bundle

    idempotency_key = inference.get("idempotencyKey")
    if idempotency_key is not None:
        if not isinstance(idempotency_key, str) or not (1 <= len(idempotency_key) <= 100):
            raise ValueError("idempotencyKey must be a string between 1 and 100 characters")
        _assert_opaque("idempotencyKey", idempotency_key)
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

    rendered = json.dumps(payload, indent=2, sort_keys=True, allow_nan=False)
    if args.out:
        Path(args.out).write_text(rendered + "\n", encoding="utf-8")
    else:
        print(rendered)
    return 0


if __name__ == "__main__":
    sys.exit(main())
