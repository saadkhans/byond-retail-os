"""Tests for ml/runtime/yolo_detect_worker.py — protocol v1.

These run on CI with NO numpy and NO ultralytics installed: fake modules
are injected into ``sys.modules`` so the worker's lazy ``load_runtime``
resolves them. The invariants pinned here are the ones the API relies on:
classified exit codes, safe stdout (no paths, no class names, no
exception text), strict header/byte validation, and xyxy→xywh
normalization with confidence ordering + truncation.
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

import yolo_detect_worker as worker  # noqa: E402


# ------------------------------------------------------------------ fakes


class FakeArray:
    """Minimal stand-in for an ndarray: supports the exact operations the
    worker performs (int index, ``[:, :, ::-1]`` slice, reshape)."""

    def __init__(self, shape, payload=None):
        self.shape = tuple(shape)
        self.payload = payload

    def reshape(self, *shape):
        if len(shape) == 1 and isinstance(shape[0], tuple):
            shape = shape[0]
        return FakeArray(shape, self.payload)

    def __getitem__(self, key):
        if isinstance(key, int):
            return FakeArray(self.shape[1:], self.payload)
        # slice tuple such as (:, :, ::-1) — the BGR flip
        return FakeArray(self.shape, self.payload)

    def __len__(self):
        return self.shape[0] if self.shape else 0


class FakeNumpy:
    uint8 = "uint8"

    @staticmethod
    def frombuffer(payload, dtype=None):
        return FakeArray((len(payload),), payload)

    @staticmethod
    def ascontiguousarray(value):
        return value

    @staticmethod
    def zeros(shape, dtype=None):
        return FakeArray(shape)


class FakeTensor:
    def __init__(self, rows):
        self._rows = rows

    def tolist(self):
        return list(self._rows)


class FakeBoxes:
    def __init__(self, xyxyn, conf, cls):
        self.xyxyn = FakeTensor(xyxyn)
        self.conf = FakeTensor(conf)
        self.cls = FakeTensor(cls)


class FakeResult:
    def __init__(self, xyxyn=(), conf=(), cls=()):
        self.boxes = FakeBoxes(list(xyxyn), list(conf), list(cls))


class FakeYOLO:
    """Per-test configurable fake ``ultralytics.YOLO``."""

    load_error: Exception | None = None
    predict_error: Exception | None = None
    results_per_frame: list | None = None
    names = {0: "person", 39: "bottle", 41: "cup"}
    last_predict_kwargs: dict | None = None
    device = "cpu"

    def __init__(self, model_file):
        if FakeYOLO.load_error is not None:
            raise FakeYOLO.load_error
        self.model_file = model_file

    def predict(self, frames, **kwargs):
        FakeYOLO.last_predict_kwargs = dict(kwargs)
        if FakeYOLO.predict_error is not None:
            raise FakeYOLO.predict_error
        if FakeYOLO.results_per_frame is not None:
            return list(FakeYOLO.results_per_frame)
        return [FakeResult() for _ in range(len(frames))]


class FakeUltralytics:
    __version__ = "8.3.40"
    YOLO = FakeYOLO


def _install_fakes():
    fake_np = FakeNumpy()
    fake_ul = FakeUltralytics()
    return mock.patch.dict(sys.modules, {"numpy": fake_np, "ultralytics": fake_ul})


def _remove_runtime():
    return mock.patch.dict(sys.modules, {"numpy": None, "ultralytics": None})


# --------------------------------------------------------------- helpers


def _header(mode, model_file, **overrides):
    base = {
        "protocol": 1,
        "mode": mode,
        "modelFile": model_file,
        "inputSize": 640,
        "device": "auto",
    }
    if mode == "detect":
        base.update(
            {
                "confThreshold": 0.25,
                "maxDetectionsPerFrame": 32,
                "width": 16,
                "height": 16,
                "frames": [{"index": 0, "timestampMs": 0}],
            }
        )
    base.update(overrides)
    return base


def _stdin(header: dict, payload: bytes = b"") -> io.BytesIO:
    return io.BytesIO(json.dumps(header).encode("utf-8") + b"\n" + payload)


def _run(argv, stdin: io.BytesIO):
    out = io.StringIO()
    err = io.StringIO()
    code = worker.main(argv, stdin=stdin, stdout=out, stderr=err)
    lines = [line for line in out.getvalue().splitlines() if line.strip()]
    assert len(lines) == 1, f"worker must emit exactly one stdout document, got {lines!r}"
    return code, json.loads(lines[0]), err.getvalue()


class WorkerTestCase(unittest.TestCase):
    def setUp(self):
        FakeYOLO.load_error = None
        FakeYOLO.predict_error = None
        FakeYOLO.results_per_frame = None
        FakeYOLO.last_predict_kwargs = None
        FakeYOLO.device = "cpu"
        self._tmp = tempfile.TemporaryDirectory()
        self.model_dir = Path(self._tmp.name) / "secret-model-dir"
        self.model_dir.mkdir()
        self.model_file = self.model_dir / "weights-v1.pt"
        self.model_file.write_bytes(b"not-a-real-model")

    def tearDown(self):
        self._tmp.cleanup()


# ------------------------------------------------------------------ tests


class ArgvAndHeaderTests(WorkerTestCase):
    def test_unknown_argv_is_bad_job(self):
        code, body, _ = _run(["--train"], _stdin(_header("probe", str(self.model_file))))
        self.assertEqual(code, worker.EXIT_BAD_JOB)
        self.assertEqual(body, {"protocol": 1, "status": "ERROR", "code": "BAD_JOB"})

    def test_missing_header_is_bad_job(self):
        with _install_fakes():
            code, body, _ = _run(["--probe"], io.BytesIO(b""))
        self.assertEqual(code, worker.EXIT_BAD_JOB)
        self.assertEqual(body["code"], "BAD_JOB")

    def test_header_without_newline_is_bad_job(self):
        with _install_fakes():
            code, body, _ = _run(
                ["--probe"], io.BytesIO(json.dumps(_header("probe", str(self.model_file))).encode())
            )
        self.assertEqual(code, worker.EXIT_BAD_JOB)

    def test_invalid_json_header_is_bad_job(self):
        with _install_fakes():
            code, body, _ = _run(["--probe"], io.BytesIO(b"{not json\n"))
        self.assertEqual(code, worker.EXIT_BAD_JOB)
        self.assertEqual(body["code"], "BAD_JOB")

    def test_wrong_protocol_or_mode_is_bad_job(self):
        for override in ({"protocol": 2}, {"mode": "detect"}):
            header = {**_header("probe", str(self.model_file)), **override}
            with _install_fakes():
                code, _, _ = _run(["--probe"], _stdin(header))
            self.assertEqual(code, worker.EXIT_BAD_JOB, override)

    def test_relative_model_file_is_bad_job(self):
        with _install_fakes():
            code, _, _ = _run(["--probe"], _stdin(_header("probe", "relative/model.pt")))
        self.assertEqual(code, worker.EXIT_BAD_JOB)

    def test_input_size_limits(self):
        for bad in (0, 96, 320 + 1, 1281, 2048, "640", True):
            with self.assertRaises(worker.BadJob, msg=bad):
                worker.parse_header(
                    json.dumps(_header("probe", str(self.model_file), inputSize=bad)).encode(), "probe"
                )
        for good in (320, 640, 1280):
            header = worker.parse_header(
                json.dumps(_header("probe", str(self.model_file), inputSize=good)).encode(), "probe"
            )
            self.assertEqual(header["inputSize"], good)

    def test_device_must_be_allowlisted(self):
        with self.assertRaises(worker.BadJob):
            worker.parse_header(
                json.dumps(_header("probe", str(self.model_file), device="mps")).encode(), "probe"
            )

    def test_detect_limits(self):
        base = _header("detect", str(self.model_file))
        bad_cases = [
            {"frames": []},
            {"frames": [{"index": 0, "timestampMs": 0}] * 65},
            {"width": 15},
            {"height": 4097},
            {"confThreshold": 1.5},
            {"confThreshold": -0.1},
            {"maxDetectionsPerFrame": 0},
            {"frames": [{"index": -1, "timestampMs": 0}]},
            {"frames": [{"index": 0}]},
            {"frames": [{"index": 0, "timestampMs": True}]},
            # 64 frames * 4096 * 4096 * 3 = 3 GiB > 256 MiB ceiling
            {"width": 4096, "height": 4096, "frames": [{"index": i, "timestampMs": i} for i in range(64)]},
        ]
        for override in bad_cases:
            with self.assertRaises(worker.BadJob, msg=override):
                worker.parse_header(json.dumps({**base, **override}).encode(), "detect")
        header = worker.parse_header(json.dumps(base).encode(), "detect")
        self.assertEqual(header["expectedBytes"], 16 * 16 * 3)
        self.assertEqual(set(header), {
            "mode", "modelFile", "inputSize", "device", "confThreshold",
            "maxDetectionsPerFrame", "width", "height", "frames", "expectedBytes",
        })

    def test_byte_count_mismatch_is_bad_job(self):
        header = _header("detect", str(self.model_file))
        short = b"\x00" * (16 * 16 * 3 - 1)
        long = b"\x00" * (16 * 16 * 3 + 1)
        for payload in (short, long):
            with _install_fakes():
                code, body, _ = _run(["--detect"], _stdin(header, payload))
            self.assertEqual(code, worker.EXIT_BAD_JOB, len(payload))
            self.assertEqual(body["code"], "BAD_JOB")


class RuntimeAndModelFailureTests(WorkerTestCase):
    def test_missing_runtime_reports_runtime_missing(self):
        with _remove_runtime():
            code, body, err = _run(["--probe"], _stdin(_header("probe", str(self.model_file))))
        self.assertEqual(code, worker.EXIT_RUNTIME_MISSING)
        self.assertEqual(body, {"protocol": 1, "status": "ERROR", "code": "RUNTIME_MISSING"})
        self.assertNotIn(str(self.model_dir), json.dumps(body))

    def test_missing_runtime_on_detect_too(self):
        header = _header("detect", str(self.model_file))
        with _remove_runtime():
            code, body, _ = _run(["--detect"], _stdin(header, b"\x00" * (16 * 16 * 3)))
        self.assertEqual(code, worker.EXIT_RUNTIME_MISSING)
        self.assertEqual(body["code"], "RUNTIME_MISSING")

    def test_model_load_failure_exit_3(self):
        FakeYOLO.load_error = RuntimeError(f"cannot open {self.model_file}")
        with _install_fakes():
            code, body, err = _run(["--probe"], _stdin(_header("probe", str(self.model_file))))
        self.assertEqual(code, worker.EXIT_MODEL_LOAD_FAILED)
        self.assertEqual(body, {"protocol": 1, "status": "ERROR", "code": "MODEL_LOAD_FAILED"})
        # the exception text (which names the path) went to stderr only
        self.assertNotIn("weights-v1", json.dumps(body))
        self.assertIn("weights-v1", err)

    def test_missing_model_file_exit_3(self):
        missing = str(self.model_dir / "absent.pt")
        with _install_fakes():
            code, body, _ = _run(["--probe"], _stdin(_header("probe", missing)))
        self.assertEqual(code, worker.EXIT_MODEL_LOAD_FAILED)
        self.assertEqual(body["code"], "MODEL_LOAD_FAILED")

    def test_inference_failure_exit_4(self):
        FakeYOLO.predict_error = RuntimeError("CUDA out of memory at /dev/nvidia0")
        header = _header("detect", str(self.model_file))
        with _install_fakes():
            code, body, _ = _run(["--detect"], _stdin(header, b"\x00" * (16 * 16 * 3)))
        self.assertEqual(code, worker.EXIT_INFERENCE_FAILED)
        self.assertEqual(body, {"protocol": 1, "status": "ERROR", "code": "INFERENCE_FAILED"})

    def test_probe_failure_exit_6_when_predict_raises(self):
        FakeYOLO.predict_error = RuntimeError("boom")
        with _install_fakes():
            code, body, _ = _run(["--probe"], _stdin(_header("probe", str(self.model_file))))
        self.assertEqual(code, worker.EXIT_PROBE_FAILED)
        self.assertEqual(body["code"], "PROBE_FAILED")

    def test_probe_failure_exit_6_when_no_classes(self):
        original = FakeYOLO.names
        FakeYOLO.names = {}
        try:
            with _install_fakes():
                code, body, _ = _run(["--probe"], _stdin(_header("probe", str(self.model_file))))
        finally:
            FakeYOLO.names = original
        self.assertEqual(code, worker.EXIT_PROBE_FAILED)


class HappyPathTests(WorkerTestCase):
    def test_probe_happy_path(self):
        with _install_fakes():
            code, body, _ = _run(["--probe"], _stdin(_header("probe", str(self.model_file), device="cpu")))
        self.assertEqual(code, worker.EXIT_OK)
        self.assertEqual(set(body), {"protocol", "status", "mode", "classCount", "device", "runtimeVersion", "elapsedMs"})
        self.assertEqual(body["status"], "OK")
        self.assertEqual(body["mode"], "probe")
        self.assertEqual(body["classCount"], 3)
        self.assertEqual(body["device"], "cpu")
        self.assertEqual(body["runtimeVersion"], "8.3.40")
        self.assertIsInstance(body["elapsedMs"], int)
        self.assertEqual(FakeYOLO.last_predict_kwargs["imgsz"], 640)
        self.assertEqual(FakeYOLO.last_predict_kwargs["device"], "cpu")
        self.assertFalse(FakeYOLO.last_predict_kwargs["verbose"])

    def test_auto_device_passes_none_and_reports_model_device(self):
        FakeYOLO.device = "cuda:0"
        with _install_fakes():
            code, body, _ = _run(["--probe"], _stdin(_header("probe", str(self.model_file), device="auto")))
        self.assertEqual(code, 0)
        self.assertIsNone(FakeYOLO.last_predict_kwargs["device"])
        self.assertEqual(body["device"], "cuda")

    def test_runtime_stdout_chatter_is_redirected_to_stderr(self):
        """Ultralytics may print banners/notices on import, load, or
        predict; the protocol channel must still carry exactly one JSON
        document and the chatter must land on stderr."""
        original_predict = FakeYOLO.predict

        def noisy_predict(self_model, frames, **kwargs):
            print("Ultralytics banner: model loaded from /secret/path/weights.pt")
            return original_predict(self_model, frames, **kwargs)

        FakeYOLO.predict = noisy_predict
        try:
            with _install_fakes():
                out = io.StringIO()
                err = io.StringIO()
                code = worker.main(
                    ["--probe"],
                    stdin=_stdin(_header("probe", str(self.model_file), device="cpu")),
                    stdout=out,
                    stderr=err,
                )
        finally:
            FakeYOLO.predict = original_predict
        self.assertEqual(code, worker.EXIT_OK)
        lines = [line for line in out.getvalue().splitlines() if line.strip()]
        self.assertEqual(len(lines), 1)
        body = json.loads(lines[0])
        self.assertEqual(body["status"], "OK")
        self.assertNotIn("banner", out.getvalue())
        self.assertNotIn("/secret/path", out.getvalue())
        self.assertIn("banner", err.getvalue())
        # sys.stdout is restored after the run.
        self.assertIs(sys.stdout, sys.__stdout__)

    def test_detect_happy_path_normalizes_sorts_truncates(self):
        FakeYOLO.results_per_frame = [
            FakeResult(
                xyxyn=[[0.5, 0.6, 0.9, 1.0], [0.1, 0.2, 0.4, 0.6], [0.0, 0.0, 0.1, 0.1]],
                conf=[0.42, 0.81, 0.30],
                cls=[41.0, 39.0, 0.0],
            ),
            FakeResult(),
        ]
        header = _header(
            "detect",
            str(self.model_file),
            maxDetectionsPerFrame=2,
            frames=[{"index": 3, "timestampMs": 1500}, {"index": 4, "timestampMs": 2000}],
        )
        payload = b"\x00" * (2 * 16 * 16 * 3)
        with _install_fakes():
            code, body, _ = _run(["--detect"], _stdin(header, payload))
        self.assertEqual(code, worker.EXIT_OK)
        self.assertEqual(set(body), {"protocol", "status", "mode", "device", "runtimeVersion", "elapsedMs", "frames"})
        self.assertEqual(body["mode"], "detect")
        self.assertEqual([f["index"] for f in body["frames"]], [3, 4])
        first = body["frames"][0]["detections"]
        # sorted by confidence desc, truncated to maxDetectionsPerFrame=2
        self.assertEqual([d["confidence"] for d in first], [0.81, 0.42])
        self.assertEqual([d["classIndex"] for d in first], [39, 41])
        self.assertEqual(
            first[0]["box"],
            {"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4},
        )
        self.assertEqual(body["frames"][1]["detections"], [])
        self.assertEqual(FakeYOLO.last_predict_kwargs["conf"], 0.25)
        self.assertEqual(FakeYOLO.last_predict_kwargs["max_det"], 2)
        # per-detection keys are exactly the allowed set
        for det in first:
            self.assertEqual(set(det), {"classIndex", "confidence", "box"})
            self.assertEqual(set(det["box"]), {"x", "y", "width", "height"})

    def test_stdout_never_carries_paths_or_class_names(self):
        FakeYOLO.results_per_frame = [
            FakeResult(xyxyn=[[0.1, 0.1, 0.2, 0.2]], conf=[0.9], cls=[39.0]),
        ]
        header = _header("detect", str(self.model_file))
        with _install_fakes():
            code, body, _ = _run(["--detect"], _stdin(header, b"\x00" * (16 * 16 * 3)))
        self.assertEqual(code, 0)
        text = json.dumps(body)
        self.assertNotIn("secret-model-dir", text)
        self.assertNotIn("weights-v1", text)
        self.assertNotIn(os.sep, text.replace("\\/", "/"))
        for name in FakeYOLO.names.values():
            self.assertNotIn(name, text)

    def test_result_count_mismatch_is_inference_failed(self):
        FakeYOLO.results_per_frame = []  # model returned nothing for one frame
        header = _header("detect", str(self.model_file))
        with _install_fakes():
            code, body, _ = _run(["--detect"], _stdin(header, b"\x00" * (16 * 16 * 3)))
        self.assertEqual(code, worker.EXIT_INFERENCE_FAILED)


class PureHelperTests(unittest.TestCase):
    def test_to_xywh_clamps_and_reorders(self):
        self.assertEqual(
            worker.to_xywh([1.2, -0.5, 0.4, 0.9]),
            {"x": 0.4, "y": 0.0, "width": 0.6, "height": 0.9},
        )
        nan = float("nan")
        box = worker.to_xywh([nan, 0.1, 0.5, 0.2])
        self.assertEqual(box, {"x": 0.0, "y": 0.1, "width": 0.5, "height": 0.1})

    def test_detections_skip_malformed_rows(self):
        result = FakeResult(
            xyxyn=[[0.1, 0.1, 0.2, 0.2], [0.3, 0.3], [0.5, 0.5, 0.6, 0.6]],
            conf=[0.5, 0.9, "bad"],
            cls=[1.0, 2.0, 3.0],
        )
        rows = worker.detections_from_result(result, 10)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["classIndex"], 1)

    def test_runtime_version_is_sanitized(self):
        class M:
            __version__ = "8.3.40+cu121 </script>"

        self.assertEqual(worker.runtime_version(M()), "8.3.40cu121script")

        class N:
            __version__ = None

        self.assertEqual(worker.runtime_version(N()), "unknown")


if __name__ == "__main__":
    unittest.main()
