#!/usr/bin/env python3
"""Local YOLO detection worker (Phase 20) — protocol v1.

Spawned by the BYOND API's local-vision-runtime module, one process per
job, with NO shell, NO network, and NO paths on the command line:

    python ml/runtime/yolo_detect_worker.py --probe|--detect

stdin  : one UTF-8 JSON header line, then (detect only) exactly
         ``frames * width * height * 3`` bytes of tightly packed RGB24.
stdout : exactly one JSON document — SAFE OUTPUT ONLY (classified codes,
         numbers, normalized boxes). Never a path, file name, class name,
         exception text, or traceback. Tracebacks go to stderr, which the
         Node runner discards at the OS level.
exit   : 0 OK · 2 RUNTIME_MISSING · 3 MODEL_LOAD_FAILED · 4 INFERENCE_FAILED
         · 5 BAD_JOB · 6 PROBE_FAILED

This file is stdlib-only at import time. ``numpy`` and ``ultralytics``
are imported lazily inside ``load_runtime`` so a machine without the
local runtime installed reports RUNTIME_MISSING instead of crashing —
the API keeps the provider UNAVAILABLE and the classical fallback runs
alone. Weights are external artifacts; nothing here fetches anything.
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback
from typing import Any, Dict, List, Sequence

PROTOCOL = 1

EXIT_OK = 0
EXIT_RUNTIME_MISSING = 2
EXIT_MODEL_LOAD_FAILED = 3
EXIT_INFERENCE_FAILED = 4
EXIT_BAD_JOB = 5
EXIT_PROBE_FAILED = 6

CODE_FOR_EXIT = {
    EXIT_RUNTIME_MISSING: "RUNTIME_MISSING",
    EXIT_MODEL_LOAD_FAILED: "MODEL_LOAD_FAILED",
    EXIT_INFERENCE_FAILED: "INFERENCE_FAILED",
    EXIT_BAD_JOB: "BAD_JOB",
    EXIT_PROBE_FAILED: "PROBE_FAILED",
}

# Limits (protocol v1). The Node runner enforces the same ceilings; the
# worker re-checks so a runner bug can never make it allocate unbounded.
MAX_FRAMES = 64
MIN_SIDE = 16
MAX_SIDE = 4096
MAX_TOTAL_BYTES = 256 * 1024 * 1024
MIN_INPUT_SIZE = 320
MAX_INPUT_SIZE = 1280
MAX_HEADER_BYTES = 256 * 1024
DEVICES = ("auto", "cpu", "cuda")


class BadJob(ValueError):
    """Header or payload violates protocol v1 — classified BAD_JOB."""


class WorkerExit(Exception):
    """Carries a classified exit code up to ``main``."""

    def __init__(self, exit_code: int) -> None:
        super().__init__(CODE_FOR_EXIT.get(exit_code, "ERROR"))
        self.exit_code = exit_code


# ----------------------------------------------------------------- header


def _require_int(header: Dict[str, Any], key: str, lo: int, hi: int) -> int:
    value = header.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise BadJob(key)
    if value < lo or value > hi:
        raise BadJob(key)
    return value


def _require_number(header: Dict[str, Any], key: str, lo: float, hi: float) -> float:
    value = header.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise BadJob(key)
    if value != value or value < lo or value > hi:  # NaN-safe
        raise BadJob(key)
    return float(value)


def parse_header(line: bytes, mode: str) -> Dict[str, Any]:
    """Strictly validate the JSON header line for ``mode`` (probe|detect).

    Returns a normalized dict containing ONLY the fields the worker uses.
    Raises ``BadJob`` on any deviation.
    """
    if mode not in ("probe", "detect"):
        raise BadJob("mode")
    if not isinstance(line, (bytes, bytearray)) or len(line) == 0:
        raise BadJob("header")
    if len(line) > MAX_HEADER_BYTES:
        raise BadJob("header")
    try:
        raw = json.loads(line.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise BadJob("header") from exc
    if not isinstance(raw, dict):
        raise BadJob("header")
    if raw.get("protocol") != PROTOCOL:
        raise BadJob("protocol")
    if raw.get("mode") != mode:
        raise BadJob("mode")

    model_file = raw.get("modelFile")
    if not isinstance(model_file, str) or not model_file or "\x00" in model_file:
        raise BadJob("modelFile")
    if not os.path.isabs(model_file):
        raise BadJob("modelFile")

    input_size = _require_int(raw, "inputSize", MIN_INPUT_SIZE, MAX_INPUT_SIZE)
    if input_size % 32 != 0:
        raise BadJob("inputSize")

    device = raw.get("device", "auto")
    if device not in DEVICES:
        raise BadJob("device")

    header: Dict[str, Any] = {
        "mode": mode,
        "modelFile": model_file,
        "inputSize": input_size,
        "device": device,
    }
    if mode == "probe":
        return header

    header["confThreshold"] = _require_number(raw, "confThreshold", 0.0, 1.0)
    header["maxDetectionsPerFrame"] = _require_int(raw, "maxDetectionsPerFrame", 1, 300)
    width = _require_int(raw, "width", MIN_SIDE, MAX_SIDE)
    height = _require_int(raw, "height", MIN_SIDE, MAX_SIDE)
    frames = raw.get("frames")
    if not isinstance(frames, list) or not (1 <= len(frames) <= MAX_FRAMES):
        raise BadJob("frames")
    normalized_frames: List[Dict[str, int]] = []
    for entry in frames:
        if not isinstance(entry, dict):
            raise BadJob("frames")
        index = entry.get("index")
        timestamp = entry.get("timestampMs")
        if isinstance(index, bool) or not isinstance(index, int) or index < 0:
            raise BadJob("frames")
        if isinstance(timestamp, bool) or not isinstance(timestamp, int) or timestamp < 0:
            raise BadJob("frames")
        normalized_frames.append({"index": index, "timestampMs": timestamp})
    total = len(frames) * width * height * 3
    if total > MAX_TOTAL_BYTES:
        raise BadJob("frames")
    header["width"] = width
    header["height"] = height
    header["frames"] = normalized_frames
    header["expectedBytes"] = total
    return header


def read_header_line(stream) -> bytes:
    """Read the header up to the first newline without over-reading."""
    line = stream.readline(MAX_HEADER_BYTES + 1)
    if not line:
        raise BadJob("header")
    if len(line) > MAX_HEADER_BYTES:
        raise BadJob("header")
    if not line.endswith(b"\n"):
        raise BadJob("header")
    return line[:-1]


# ----------------------------------------------------------------- runtime


def load_runtime():
    """Import numpy + ultralytics lazily. Raises ``WorkerExit(2)`` when
    either is missing so a bare machine reports RUNTIME_MISSING."""
    os.environ.setdefault("YOLO_VERBOSE", "False")
    try:
        import numpy as np  # type: ignore
        import ultralytics  # type: ignore
        from ultralytics import YOLO  # type: ignore
    except Exception as exc:  # ImportError and any runtime init failure
        raise WorkerExit(EXIT_RUNTIME_MISSING) from exc
    return np, ultralytics, YOLO


def load_model(YOLO, model_file: str):
    if not os.path.isfile(model_file):
        raise WorkerExit(EXIT_MODEL_LOAD_FAILED)
    try:
        return YOLO(model_file)
    except Exception as exc:
        raise WorkerExit(EXIT_MODEL_LOAD_FAILED) from exc


def resolve_device(device: str):
    return None if device == "auto" else device


def report_device(model, requested: str) -> str:
    """'cuda' when the loaded model sits on a CUDA device, else 'cpu'."""
    if requested == "cuda":
        return "cuda"
    if requested == "cpu":
        return "cpu"
    try:
        dev = getattr(model, "device", None)
        return "cuda" if dev is not None and "cuda" in str(dev).lower() else "cpu"
    except Exception:
        return "cpu"


def runtime_version(ultralytics_module) -> str:
    version = getattr(ultralytics_module, "__version__", None)
    if not isinstance(version, str) or not version:
        return "unknown"
    allowed = set("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ._-")
    cleaned = "".join(ch for ch in version if ch in allowed)[:32]
    return cleaned or "unknown"


# ------------------------------------------------------------------ frames


def read_frames(stream, np, header: Dict[str, Any]):
    """Read exactly ``expectedBytes`` of RGB24 and return a list of BGR
    contiguous ndarrays (ultralytics expects BGR for ndarray input)."""
    expected = header["expectedBytes"]
    payload = stream.read(expected)
    if payload is None or len(payload) != expected:
        raise BadJob("bytes")
    trailing = stream.read(1)
    if trailing:
        raise BadJob("bytes")
    count = len(header["frames"])
    width = header["width"]
    height = header["height"]
    stack = np.frombuffer(payload, dtype=np.uint8).reshape(count, height, width, 3)
    return [np.ascontiguousarray(stack[i][:, :, ::-1]) for i in range(count)]


# ---------------------------------------------------------------- results


def _clamp01(value: float) -> float:
    if value != value:  # NaN
        return 0.0
    return min(1.0, max(0.0, float(value)))


def to_xywh(xyxyn: Sequence[float]) -> Dict[str, float]:
    """Normalized xyxy (top-left origin) → clamped normalized xywh."""
    x1, y1, x2, y2 = (_clamp01(v) for v in xyxyn[:4])
    if x2 < x1:
        x1, x2 = x2, x1
    if y2 < y1:
        y1, y2 = y2, y1
    return {
        "x": round(x1, 6),
        "y": round(y1, 6),
        "width": round(x2 - x1, 6),
        "height": round(y2 - y1, 6),
    }


def _to_list(value) -> list:
    if value is None:
        return []
    if hasattr(value, "tolist"):
        value = value.tolist()
    if isinstance(value, (int, float)):
        return [value]
    return list(value)


def detections_from_result(result, max_detections: int) -> List[Dict[str, Any]]:
    boxes = getattr(result, "boxes", None)
    if boxes is None:
        return []
    xyxyn = _to_list(getattr(boxes, "xyxyn", None))
    conf = _to_list(getattr(boxes, "conf", None))
    cls = _to_list(getattr(boxes, "cls", None))
    rows: List[Dict[str, Any]] = []
    for i in range(min(len(xyxyn), len(conf), len(cls))):
        coords = _to_list(xyxyn[i])
        if len(coords) < 4:
            continue
        try:
            class_index = int(cls[i])
            confidence = _clamp01(float(conf[i]))
        except (TypeError, ValueError):
            continue
        if class_index < 0:
            continue
        rows.append(
            {
                "classIndex": class_index,
                "confidence": round(confidence, 6),
                "box": to_xywh([float(c) for c in coords[:4]]),
            }
        )
    rows.sort(key=lambda row: row["confidence"], reverse=True)
    return rows[:max_detections]


def build_detect_response(
    results: Sequence[Any],
    header: Dict[str, Any],
    device: str,
    version: str,
    elapsed_ms: int,
) -> Dict[str, Any]:
    frames_out = []
    for meta, result in zip(header["frames"], results):
        frames_out.append(
            {
                "index": meta["index"],
                "detections": detections_from_result(result, header["maxDetectionsPerFrame"]),
            }
        )
    return {
        "protocol": PROTOCOL,
        "status": "OK",
        "mode": "detect",
        "device": device,
        "runtimeVersion": version,
        "elapsedMs": int(elapsed_ms),
        "frames": frames_out,
    }


def build_probe_response(class_count: int, device: str, version: str, elapsed_ms: int) -> Dict[str, Any]:
    return {
        "protocol": PROTOCOL,
        "status": "OK",
        "mode": "probe",
        "classCount": int(class_count),
        "device": device,
        "runtimeVersion": version,
        "elapsedMs": int(elapsed_ms),
    }


def error_response(exit_code: int) -> Dict[str, Any]:
    return {"protocol": PROTOCOL, "status": "ERROR", "code": CODE_FOR_EXIT.get(exit_code, "ERROR")}


# ------------------------------------------------------------------- modes


def run_probe(header: Dict[str, Any], np, ultralytics_module, YOLO) -> Dict[str, Any]:
    started = time.monotonic()
    model = load_model(YOLO, header["modelFile"])
    size = header["inputSize"]
    frame = np.zeros((size, size, 3), dtype=np.uint8)
    try:
        results = model.predict(
            [frame],
            imgsz=size,
            conf=0.25,
            device=resolve_device(header["device"]),
            verbose=False,
            max_det=1,
        )
    except Exception as exc:
        raise WorkerExit(EXIT_PROBE_FAILED) from exc
    if results is None or len(list(results)) == 0:
        raise WorkerExit(EXIT_PROBE_FAILED)
    names = getattr(model, "names", None)
    try:
        class_count = len(names) if names is not None else 0
    except TypeError:
        class_count = 0
    if class_count <= 0:
        raise WorkerExit(EXIT_PROBE_FAILED)
    elapsed_ms = int((time.monotonic() - started) * 1000)
    return build_probe_response(
        class_count,
        report_device(model, header["device"]),
        runtime_version(ultralytics_module),
        elapsed_ms,
    )


def run_detect(header: Dict[str, Any], frames, np, ultralytics_module, YOLO) -> Dict[str, Any]:
    started = time.monotonic()
    model = load_model(YOLO, header["modelFile"])
    try:
        results = model.predict(
            frames,
            imgsz=header["inputSize"],
            conf=header["confThreshold"],
            device=resolve_device(header["device"]),
            verbose=False,
            max_det=header["maxDetectionsPerFrame"],
        )
        results = list(results)
    except Exception as exc:
        raise WorkerExit(EXIT_INFERENCE_FAILED) from exc
    if len(results) != len(frames):
        raise WorkerExit(EXIT_INFERENCE_FAILED)
    elapsed_ms = int((time.monotonic() - started) * 1000)
    return build_detect_response(
        results,
        header,
        report_device(model, header["device"]),
        runtime_version(ultralytics_module),
        elapsed_ms,
    )


# -------------------------------------------------------------------- main


def _emit(stdout, payload: Dict[str, Any]) -> None:
    stdout.write(json.dumps(payload, separators=(",", ":")))
    stdout.write("\n")
    stdout.flush()


def main(argv: Sequence[str] | None = None, stdin=None, stdout=None, stderr=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    stdin = sys.stdin.buffer if stdin is None else stdin
    stdout = sys.stdout if stdout is None else stdout
    stderr = sys.stderr if stderr is None else stderr

    if argv == ["--probe"]:
        mode = "probe"
    elif argv == ["--detect"]:
        mode = "detect"
    else:
        _emit(stdout, error_response(EXIT_BAD_JOB))
        return EXIT_BAD_JOB

    # stdout is the PROTOCOL channel: exactly one JSON document. Anything
    # the runtime prints while importing, loading, or predicting (banners,
    # download notices, warnings) is redirected to stderr for the whole
    # working section so it can never corrupt the document.
    saved_stdout = sys.stdout
    sys.stdout = stderr
    try:
        header = parse_header(read_header_line(stdin), mode)
        np, ultralytics_module, YOLO = load_runtime()
        if mode == "probe":
            response = run_probe(header, np, ultralytics_module, YOLO)
        else:
            frames = read_frames(stdin, np, header)
            response = run_detect(header, frames, np, ultralytics_module, YOLO)
    except BadJob:
        traceback.print_exc(file=stderr)
        _emit(stdout, error_response(EXIT_BAD_JOB))
        return EXIT_BAD_JOB
    except WorkerExit as exit_info:
        traceback.print_exc(file=stderr)
        _emit(stdout, error_response(exit_info.exit_code))
        return exit_info.exit_code
    except Exception:  # last resort: still a classified envelope
        traceback.print_exc(file=stderr)
        _emit(stdout, error_response(EXIT_INFERENCE_FAILED))
        return EXIT_INFERENCE_FAILED
    finally:
        sys.stdout = saved_stdout

    _emit(stdout, response)
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
