"""Tests for ml/runtime/embed_worker.py — protocol v1.

These run on CI with NO numpy, NO torch and NO open_clip installed: fake
modules are injected into ``sys.modules`` so the worker's lazy
``load_runtime`` resolves them. The invariants pinned here are the ones
the API relies on: classified exit codes, safe stdout (no paths, no
exception text), strict header/byte validation, one vector per image,
and unit-length output.
"""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

RUNTIME_DIR = Path(__file__).resolve().parent.parent / "runtime"
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

import embed_worker as worker  # noqa: E402


# ------------------------------------------------------------------ fakes


class FakeArray:
    """Minimal ndarray stand-in: remembers a shape, supports reshape."""

    def __init__(self, shape, payload=None):
        self.shape = tuple(shape)
        self.payload = payload

    def reshape(self, *shape):
        if len(shape) == 1 and isinstance(shape[0], tuple):
            shape = shape[0]
        return FakeArray(shape, self.payload)

    def __len__(self):
        return self.shape[0] if self.shape else 0


class FakeNumpy:
    uint8 = "uint8"

    @staticmethod
    def frombuffer(payload, dtype=None):
        return FakeArray((len(payload),), payload)

    @staticmethod
    def zeros(shape, dtype=None):
        return FakeArray(shape)


class FakeTensor:
    """Every tensor op returns the tensor itself; ``tolist`` yields the
    vectors the fake model was configured with."""

    def __init__(self, rows=None, count=1):
        self.rows = rows
        self.count = count

    def _same(self, *_args, **_kwargs):
        return self

    permute = float = div = sub = to = cpu = view = _same

    def tolist(self):
        return list(self.rows) if self.rows is not None else []


class _NoGrad:
    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


class FakeCuda:
    available = False

    @staticmethod
    def is_available():
        return FakeCuda.available


class FakeFunctional:
    @staticmethod
    def normalize(tensor, dim=-1):
        return tensor


class FakeNn:
    functional = FakeFunctional


class FakeTorch:
    cuda = FakeCuda
    nn = FakeNn

    @staticmethod
    def no_grad():
        return _NoGrad()

    @staticmethod
    def from_numpy(array):
        return FakeTensor(count=len(array))

    @staticmethod
    def tensor(values):
        return FakeTensor()


class FakeModel:
    def __init__(self):
        self.calls = 0

    def eval(self):
        return self

    def encode_image(self, tensor):
        self.calls += 1
        if FakeOpenClip.encode_error is not None:
            raise FakeOpenClip.encode_error
        rows = FakeOpenClip.vectors
        if rows is None:
            rows = [[1.0, 0.0, 0.0, 0.0]] * tensor.count
        return FakeTensor(rows)


class FakeOpenClip:
    __version__ = "2.26.1"
    load_error: Exception | None = None
    encode_error: Exception | None = None
    vectors: list | None = None
    last_create_kwargs: dict | None = None

    @staticmethod
    def create_model_and_transforms(arch, pretrained=None, device=None):
        FakeOpenClip.last_create_kwargs = {"arch": arch, "pretrained": pretrained, "device": device}
        if FakeOpenClip.load_error is not None:
            raise FakeOpenClip.load_error
        return FakeModel(), None, None


def fake_modules():
    return {"numpy": FakeNumpy, "torch": FakeTorch, "open_clip": FakeOpenClip}


def probe_header(**overrides):
    header = {
        "protocol": 1,
        "mode": "probe",
        "modelFile": None,
        "pretrained": "laion2b_s34b_b79k",
        "arch": "ViT-B-32",
        "inputSize": 64,
        "device": "auto",
    }
    header.update(overrides)
    return header


def embed_header(count=2, size=64, **overrides):
    header = probe_header(mode="embed", inputSize=size)
    header.update(
        {"width": size, "height": size, "images": [{"index": i} for i in range(count)]}
    )
    header.update(overrides)
    return header


def run_main(argv, header, payload=b"", modules=None):
    stdin = io.BytesIO((json.dumps(header) + "\n").encode("utf-8") + payload)
    stdout = io.StringIO()
    stderr = io.StringIO()
    with mock.patch.dict(sys.modules, modules if modules is not None else fake_modules()):
        code = worker.main(argv, stdin=stdin, stdout=stdout, stderr=stderr)
    lines = [line for line in stdout.getvalue().splitlines() if line.strip()]
    assert len(lines) == 1, f"stdout must carry exactly one document: {lines!r}"
    return code, json.loads(lines[0]), stderr.getvalue()


class ResetFakes(unittest.TestCase):
    def setUp(self):
        FakeOpenClip.load_error = None
        FakeOpenClip.encode_error = None
        FakeOpenClip.vectors = None
        FakeOpenClip.last_create_kwargs = None
        FakeCuda.available = False


# ------------------------------------------------------------- exit codes


class RuntimeMissing(ResetFakes):
    def test_missing_runtime_reports_runtime_missing_exit_2(self):
        missing = {"numpy": None, "torch": None, "open_clip": None}
        code, doc, _ = run_main(["--probe"], probe_header(), modules=missing)
        self.assertEqual(code, 2)
        self.assertEqual(doc, {"protocol": 1, "status": "ERROR", "code": "RUNTIME_MISSING"})

    def test_bad_argv_is_bad_job(self):
        stdout = io.StringIO()
        code = worker.main(["--detect"], stdin=io.BytesIO(b""), stdout=stdout, stderr=io.StringIO())
        self.assertEqual(code, 5)
        self.assertEqual(json.loads(stdout.getvalue())["code"], "BAD_JOB")


class HeaderValidation(ResetFakes):
    def test_rejects_wrong_protocol_mode_and_missing_weights(self):
        for bad in (
            probe_header(protocol=2),
            probe_header(mode="embed"),
            probe_header(pretrained=None),  # neither file nor tag
            probe_header(modelFile="C:\\x\\model.pt"),  # both
            probe_header(pretrained="../evil"),
            probe_header(arch="ViT B 32"),
            probe_header(inputSize=16),
            probe_header(device="tpu"),
        ):
            code, doc, _ = run_main(["--probe"], bad)
            self.assertEqual(code, 5, bad)
            self.assertEqual(doc["code"], "BAD_JOB")

    def test_relative_model_file_is_bad_job(self):
        code, doc, _ = run_main(
            ["--probe"], probe_header(modelFile="models/x.pt", pretrained=None)
        )
        self.assertEqual(code, 5)
        self.assertEqual(doc["code"], "BAD_JOB")

    def test_embed_geometry_must_match_input_size(self):
        code, doc, _ = run_main(["--embed"], embed_header(width=32), b"\0" * (32 * 64 * 3 * 2))
        self.assertEqual(code, 5)
        self.assertEqual(doc["code"], "BAD_JOB")

    def test_byte_count_mismatch_is_bad_job(self):
        header = embed_header(count=1)
        short = b"\0" * (64 * 64 * 3 - 1)
        code, doc, _ = run_main(["--embed"], header, short)
        self.assertEqual(code, 5)
        self.assertEqual(doc["code"], "BAD_JOB")
        long = b"\0" * (64 * 64 * 3 + 1)
        code, doc, _ = run_main(["--embed"], header, long)
        self.assertEqual(code, 5)
        self.assertEqual(doc["code"], "BAD_JOB")


class ModelAndInference(ResetFakes):
    def test_model_load_failure_is_exit_3(self):
        FakeOpenClip.load_error = RuntimeError("no such pretrained tag")
        code, doc, err = run_main(["--probe"], probe_header())
        self.assertEqual(code, 3)
        self.assertEqual(doc["code"], "MODEL_LOAD_FAILED")
        self.assertNotIn("no such pretrained", json.dumps(doc))
        self.assertIn("no such pretrained", err)  # traceback goes to stderr only

    def test_missing_checkpoint_file_is_exit_3(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = os.path.join(tmp, "model.pt")
            code, doc, _ = run_main(["--probe"], probe_header(modelFile=missing, pretrained=None))
        self.assertEqual(code, 3)
        self.assertEqual(doc["code"], "MODEL_LOAD_FAILED")
        self.assertNotIn(tmp, json.dumps(doc))

    def test_encode_failure_is_exit_4(self):
        FakeOpenClip.encode_error = RuntimeError("CUDA out of memory")
        code, doc, _ = run_main(["--embed"], embed_header(count=1), b"\0" * (64 * 64 * 3))
        self.assertEqual(code, 4)
        self.assertEqual(doc["code"], "INFERENCE_FAILED")
        self.assertNotIn("CUDA", json.dumps(doc))

    def test_probe_happy_path_reports_dim_device_version(self):
        FakeOpenClip.vectors = [[0.5, 0.5, 0.5, 0.5]]
        code, doc, _ = run_main(["--probe"], probe_header())
        self.assertEqual(code, 0)
        self.assertEqual(doc["status"], "OK")
        self.assertEqual(doc["mode"], "probe")
        self.assertEqual(doc["dim"], 4)
        self.assertEqual(doc["device"], "cpu")
        self.assertEqual(doc["runtimeVersion"], "2.26.1")
        self.assertEqual(set(doc), {"protocol", "status", "mode", "dim", "device", "runtimeVersion", "elapsedMs"})
        self.assertEqual(FakeOpenClip.last_create_kwargs["pretrained"], "laion2b_s34b_b79k")

    def test_cuda_reported_only_when_available(self):
        FakeCuda.available = True
        code, doc, _ = run_main(["--probe"], probe_header(device="cuda"))
        self.assertEqual(code, 0)
        self.assertEqual(doc["device"], "cuda")
        FakeCuda.available = False
        code, doc, _ = run_main(["--probe"], probe_header(device="cuda"))
        self.assertEqual(doc["device"], "cpu")

    def test_embed_happy_path_one_vector_per_image(self):
        FakeOpenClip.vectors = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]
        payload = b"\x10" * (64 * 64 * 3 * 2)
        code, doc, _ = run_main(["--embed"], embed_header(count=2), payload)
        self.assertEqual(code, 0)
        self.assertEqual(doc["mode"], "embed")
        self.assertEqual(len(doc["vectors"]), 2)
        self.assertEqual(doc["vectors"][0], [1.0, 0.0, 0.0])
        self.assertEqual(set(doc), {"protocol", "status", "mode", "device", "runtimeVersion", "elapsedMs", "vectors"})

    def test_vector_count_mismatch_is_exit_4(self):
        FakeOpenClip.vectors = [[1.0, 0.0]]
        payload = b"\x10" * (64 * 64 * 3 * 2)
        code, doc, _ = run_main(["--embed"], embed_header(count=2), payload)
        self.assertEqual(code, 4)
        self.assertEqual(doc["code"], "INFERENCE_FAILED")

    def test_stdout_never_carries_paths_or_tags(self):
        with tempfile.TemporaryDirectory() as tmp:
            checkpoint = os.path.join(tmp, "model.pt")
            with open(checkpoint, "wb") as handle:
                handle.write(b"\0" * 16)
            FakeOpenClip.vectors = [[0.6, 0.8]]
            code, doc, _ = run_main(
                ["--embed"],
                embed_header(count=1, modelFile=checkpoint, pretrained=None),
                b"\0" * (64 * 64 * 3),
            )
        self.assertEqual(code, 0)
        text = json.dumps(doc)
        self.assertNotIn(tmp, text)
        self.assertNotIn("model.pt", text)
        self.assertNotIn("ViT-B-32", text)


class PureHelpers(ResetFakes):
    def test_runtime_version_is_sanitized(self):
        class Weird:
            __version__ = "2.26.1+cu121 (dev)"

        self.assertEqual(worker.runtime_version(Weird), "2.26.1cu121dev")

        class Missing:
            pass

        self.assertEqual(worker.runtime_version(Missing), "unknown")

    def test_build_embed_response_rounds_floats(self):
        doc = worker.build_embed_response([[0.123456789, 1]], "cpu", "x", 3)
        self.assertEqual(doc["vectors"], [[0.1234568, 1.0]])


if __name__ == "__main__":
    unittest.main()
