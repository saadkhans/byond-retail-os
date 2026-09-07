#!/usr/bin/env python3
"""Local image-embedding worker (Phase 24) — protocol v1.

Spawned by the BYOND API's local-vision-runtime module, one process per
job, with NO shell, NO network, and NO paths on the command line:

    python ml/runtime/embed_worker.py --probe|--embed

stdin  : one UTF-8 JSON header line, then (embed only) exactly
         ``images * width * height * 3`` bytes of tightly packed RGB24.
         Every image is ALREADY letterboxed to the encoder's square input
         by the Node runtime, so this worker only normalizes and encodes.
stdout : exactly one JSON document — SAFE OUTPUT ONLY (classified codes,
         numbers, L2-normalized vectors). Never a path, file name,
         exception text, or traceback. Tracebacks go to stderr, which the
         Node runner discards at the OS level.
exit   : 0 OK · 2 RUNTIME_MISSING · 3 MODEL_LOAD_FAILED · 4 INFERENCE_FAILED
         · 5 BAD_JOB

This file is stdlib-only at import time. ``numpy``, ``torch`` and
``open_clip`` are imported lazily inside ``load_runtime`` so a machine
without the local runtime installed reports RUNTIME_MISSING instead of
crashing — the API keeps the retriever not-ready and the HOG index (or an
empty signal) stands in. Weights are external artifacts resolved from
open_clip's OWN local cache by ``pretrained`` tag, or from a checkpoint
file inside the model registry; nothing here fetches anything.
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

CODE_FOR_EXIT = {
    EXIT_RUNTIME_MISSING: "RUNTIME_MISSING",
    EXIT_MODEL_LOAD_FAILED: "MODEL_LOAD_FAILED",
    EXIT_INFERENCE_FAILED: "INFERENCE_FAILED",
    EXIT_BAD_JOB: "BAD_JOB",
}

# Limits (protocol v1). The Node runner enforces the same ceilings; the
# worker re-checks so a runner bug can never make it allocate unbounded.
MAX_IMAGES = 64
MIN_SIDE = 32
MAX_SIDE = 1024
MAX_TOTAL_BYTES = 64 * 1024 * 1024
MAX_HEADER_BYTES = 256 * 1024
DEVICES = ("auto", "cpu", "cuda")
ARCH_ALLOWED = set("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ._-")
MAX_ARCH_LEN = 48
MAX_TAG_LEN = 64

# CLIP normalization constants (open_clip's defaults for the ViT family).
CLIP_MEAN = (0.48145466, 0.4578275, 0.40821073)
CLIP_STD = (0.26862954, 0.26130258, 0.27577711)


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


def _safe_token(value: Any, max_len: int) -> str:
    if not isinstance(value, str) or not value or len(value) > max_len:
        raise BadJob("token")
    if any(ch not in ARCH_ALLOWED for ch in value):
        raise BadJob("token")
    return value


def parse_header(line: bytes, mode: str) -> Dict[str, Any]:
    """Strictly validate the JSON header line for ``mode`` (probe|embed).

    Returns a normalized dict containing ONLY the fields the worker uses.
    Raises ``BadJob`` on any deviation. Exactly one of ``modelFile`` (an
    absolute checkpoint path) or ``pretrained`` (an open_clip cache tag)
    must be present.
    """
    if mode not in ("probe", "embed"):
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
    pretrained = raw.get("pretrained")
    if model_file is not None:
        if not isinstance(model_file, str) or not model_file or "\x00" in model_file:
            raise BadJob("modelFile")
        if not os.path.isabs(model_file):
            raise BadJob("modelFile")
    if pretrained is not None:
        pretrained = _safe_token(pretrained, MAX_TAG_LEN)
    if (model_file is None) == (pretrained is None):
        raise BadJob("weights")

    arch = _safe_token(raw.get("arch"), MAX_ARCH_LEN)
    input_size = _require_int(raw, "inputSize", MIN_SIDE, MAX_SIDE)
    device = raw.get("device", "auto")
    if device not in DEVICES:
        raise BadJob("device")

    header: Dict[str, Any] = {
        "mode": mode,
        "modelFile": model_file,
        "pretrained": pretrained,
        "arch": arch,
        "inputSize": input_size,
        "device": device,
    }
    if mode == "probe":
        return header

    width = _require_int(raw, "width", MIN_SIDE, MAX_SIDE)
    height = _require_int(raw, "height", MIN_SIDE, MAX_SIDE)
    if width != input_size or height != input_size:
        # The runtime letterboxes to the encoder's square; anything else
        # is a caller bug, not something to silently resample here.
        raise BadJob("geometry")
    images = raw.get("images")
    if not isinstance(images, list) or not (1 <= len(images) <= MAX_IMAGES):
        raise BadJob("images")
    indexes: List[int] = []
    for entry in images:
        if not isinstance(entry, dict):
            raise BadJob("images")
        index = entry.get("index")
        if isinstance(index, bool) or not isinstance(index, int) or index < 0:
            raise BadJob("images")
        indexes.append(index)
    total = len(images) * width * height * 3
    if total > MAX_TOTAL_BYTES:
        raise BadJob("images")
    header["width"] = width
    header["height"] = height
    header["images"] = indexes
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
    """Import numpy + torch + open_clip lazily. Raises ``WorkerExit(2)``
    when any is missing so a bare machine reports RUNTIME_MISSING."""
    try:
        import numpy as np  # type: ignore
        import torch  # type: ignore
        import open_clip  # type: ignore
    except Exception as exc:  # ImportError and any runtime init failure
        raise WorkerExit(EXIT_RUNTIME_MISSING) from exc
    return np, torch, open_clip


def resolve_device(torch, requested: str) -> str:
    """'cuda' only when requested/auto AND torch reports it available."""
    try:
        cuda_ok = bool(torch.cuda.is_available())
    except Exception:
        cuda_ok = False
    if requested == "cpu":
        return "cpu"
    if requested == "cuda":
        return "cuda" if cuda_ok else "cpu"
    return "cuda" if cuda_ok else "cpu"


def load_model(open_clip, torch, header: Dict[str, Any], device: str):
    """Build the encoder from a checkpoint file or a cache tag. Any failure
    (missing file, unknown tag, corrupt weights) is MODEL_LOAD_FAILED."""
    model_file = header["modelFile"]
    pretrained = header["pretrained"]
    if model_file is not None and not os.path.isfile(model_file):
        raise WorkerExit(EXIT_MODEL_LOAD_FAILED)
    try:
        model, _train_transform, _eval_transform = open_clip.create_model_and_transforms(
            header["arch"],
            pretrained=model_file if model_file is not None else pretrained,
            device=device,
        )
        model.eval()
    except Exception as exc:
        raise WorkerExit(EXIT_MODEL_LOAD_FAILED) from exc
    return model


def runtime_version(open_clip_module) -> str:
    version = getattr(open_clip_module, "__version__", None)
    if not isinstance(version, str) or not version:
        return "unknown"
    cleaned = "".join(ch for ch in version if ch in ARCH_ALLOWED)[:32]
    return cleaned or "unknown"


# ------------------------------------------------------------------ images


def read_images(stream, np, header: Dict[str, Any]):
    """Read exactly ``expectedBytes`` of RGB24 and return an ndarray of
    shape (n, h, w, 3)."""
    expected = header["expectedBytes"]
    payload = stream.read(expected)
    if payload is None or len(payload) != expected:
        raise BadJob("bytes")
    trailing = stream.read(1)
    if trailing:
        raise BadJob("bytes")
    count = len(header["images"])
    return np.frombuffer(payload, dtype=np.uint8).reshape(
        count, header["height"], header["width"], 3
    )


def encode_images(torch, model, stack, device: str) -> List[List[float]]:
    """(n, h, w, 3) uint8 RGB → CLIP-normalized NCHW float → L2-normalized
    embeddings as plain lists. Raises WorkerExit(4) on any failure."""
    try:
        with torch.no_grad():
            tensor = torch.from_numpy(stack).permute(0, 3, 1, 2).float().div(255.0)
            mean = torch.tensor(CLIP_MEAN).view(1, 3, 1, 1)
            std = torch.tensor(CLIP_STD).view(1, 3, 1, 1)
            tensor = tensor.sub(mean).div(std).to(device)
            features = model.encode_image(tensor)
            features = torch.nn.functional.normalize(features.float(), dim=-1)
            rows = features.cpu().tolist()
    except Exception as exc:
        raise WorkerExit(EXIT_INFERENCE_FAILED) from exc
    if not isinstance(rows, list):
        raise WorkerExit(EXIT_INFERENCE_FAILED)
    return [[float(v) for v in row] for row in rows]


# ---------------------------------------------------------------- results


def build_probe_response(dim: int, device: str, version: str, elapsed_ms: int) -> Dict[str, Any]:
    return {
        "protocol": PROTOCOL,
        "status": "OK",
        "mode": "probe",
        "dim": int(dim),
        "device": device,
        "runtimeVersion": version,
        "elapsedMs": int(elapsed_ms),
    }


def build_embed_response(
    vectors: Sequence[Sequence[float]], device: str, version: str, elapsed_ms: int
) -> Dict[str, Any]:
    return {
        "protocol": PROTOCOL,
        "status": "OK",
        "mode": "embed",
        "device": device,
        "runtimeVersion": version,
        "elapsedMs": int(elapsed_ms),
        "vectors": [[round(float(v), 7) for v in row] for row in vectors],
    }


def error_response(exit_code: int) -> Dict[str, Any]:
    return {"protocol": PROTOCOL, "status": "ERROR", "code": CODE_FOR_EXIT.get(exit_code, "ERROR")}


# ------------------------------------------------------------------- modes


def run_probe(header: Dict[str, Any], np, torch, open_clip) -> Dict[str, Any]:
    started = time.monotonic()
    device = resolve_device(torch, header["device"])
    model = load_model(open_clip, torch, header, device)
    size = header["inputSize"]
    stack = np.zeros((1, size, size, 3), dtype=np.uint8)
    vectors = encode_images(torch, model, stack, device)
    if len(vectors) != 1 or len(vectors[0]) == 0:
        raise WorkerExit(EXIT_INFERENCE_FAILED)
    elapsed_ms = int((time.monotonic() - started) * 1000)
    return build_probe_response(len(vectors[0]), device, runtime_version(open_clip), elapsed_ms)


def run_embed(header: Dict[str, Any], stack, np, torch, open_clip) -> Dict[str, Any]:
    started = time.monotonic()
    device = resolve_device(torch, header["device"])
    model = load_model(open_clip, torch, header, device)
    vectors = encode_images(torch, model, stack, device)
    if len(vectors) != len(header["images"]):
        raise WorkerExit(EXIT_INFERENCE_FAILED)
    elapsed_ms = int((time.monotonic() - started) * 1000)
    return build_embed_response(vectors, device, runtime_version(open_clip), elapsed_ms)


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
    elif argv == ["--embed"]:
        mode = "embed"
    else:
        _emit(stdout, error_response(EXIT_BAD_JOB))
        return EXIT_BAD_JOB

    # stdout is the PROTOCOL channel: exactly one JSON document. Anything
    # the runtime prints while importing, loading, or encoding (download
    # notices, warnings) is redirected to stderr for the whole working
    # section so it can never corrupt the document.
    saved_stdout = sys.stdout
    sys.stdout = stderr
    try:
        header = parse_header(read_header_line(stdin), mode)
        np, torch, open_clip = load_runtime()
        if mode == "probe":
            response = run_probe(header, np, torch, open_clip)
        else:
            stack = read_images(stdin, np, header)
            response = run_embed(header, stack, np, torch, open_clip)
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
