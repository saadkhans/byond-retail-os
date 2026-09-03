# Local YOLO provider (Phase 20)

The local YOLO provider is the **first real pretrained runtime** wired
behind the Phase 19 adapter layer (`services/api/src/pretrained-vision/`).
It fills the `YOLO_LOCAL` slot: a generic product / hand / person / object
detector run on frames of an **uploaded test clip**, whose output is
normalized into the existing `ProviderEvidence` schema and compared
against the classical fallback.

What it is **not**:

- Not authoritative. Detector evidence is shadow-only. It never touches
  checkout, order, payment, settlement, or inventory state, and every
  suggestion it contributes stays **review-required** until confidence
  gates are explicitly approved in a later phase.
- Not a replacement for the classical pipeline. `CLASSICAL` is always
  registered, always READY, and remains the baseline every comparison is
  measured against. If the local runtime or model is missing, the
  provider reports `UNAVAILABLE` with a classified reason code and the
  classical fallback runs alone — evaluation never fails because YOLO is
  absent.
- Not a SKU classifier. Labels are generic roles (`PRODUCT`, `HAND`,
  `PERSON`, `OBJECT`). SKU identity still comes from the classical
  matcher, the reference library, and (later) local embedding retrieval.

## Local-only guarantees

| Guarantee | How it is enforced |
| --- | --- |
| No external API, no cloud model call | The runtime spawns a **local Python worker** with no shell and a minimal environment allowlist; the worker never opens a socket. The pretrained-vision module's static shadow guard bans `fetch`/`http`/`net` and any process or file access inside that module. |
| No raw media leaves the process | Frames are decoded by the existing confined ffmpeg decoder into raw RGB buffers and piped to the worker over **stdin**. Nothing is written to a temp file; nothing is base64-encoded into a response. |
| No path / model-weight leakage | Model files resolve inside a confined registry root. API responses carry only an opaque `modelId`, version label, class counts, device (`CPU`/`CUDA`), and runtime version. The worker emits class **indexes**, never class names, and never a path, file name, traceback, or exception text on stdout. stderr is discarded at the OS level. |
| Safe output only | Every worker field is re-validated by the Node runner (allowlist rebuild: clamped numbers, normalized boxes, integer class indexes within the manifest's class count), then again by `sanitizeProviderEvidence` before persistence or an API response. |
| No mutation | The runtime module performs a tenant-scoped **read** of the video asset only. The pretrained-vision module writes only its own `PretrainedVisionRun` table. |

## Installing the local runtime

The worker (`ml/runtime/yolo_detect_worker.py`) needs `numpy` and
[`ultralytics`](https://docs.ultralytics.com/) importable by the Python
interpreter named in `CV_LOCAL_PYTHON_BIN`. The repo's own `ml:test` suite
stays stdlib-only — CI never installs these.

```powershell
# from the repo root (Windows / PowerShell shown; bash is equivalent)
python -m venv .venv-cv
.\.venv-cv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install ultralytics          # pulls torch (~200 MB CPU wheel)
```

- **GPU (recommended on the RTX box):** install a CUDA build of torch
  first, then `ultralytics`. Follow
  <https://pytorch.org/get-started/locally/> for the exact index URL of
  your CUDA version (wheels are 2+ GB). Set `CV_LOCAL_YOLO_DEVICE=cuda`
  (or leave `auto`).
- **CPU only:** the default CPU wheel is fine for 10-second test clips at
  2 fps (a 640-px YOLOv8n pass is ~50–100 ms per frame on a modern CPU).
- Point the API at the venv interpreter, e.g.
  `CV_LOCAL_PYTHON_BIN=C:\path\to\repo\.venv-cv\Scripts\python.exe`,
  or activate the venv in the shell that runs `pnpm run dev:api` and keep
  the default `python`.

Verify the runtime from a shell before touching the API:

```powershell
python -c "import ultralytics, numpy; print(ultralytics.__version__)"
```

## Model registry layout

Weights are **external artifacts** and are never committed (`ml/models/`
is gitignored). The registry is a directory tree under
`CV_LOCAL_MODEL_ROOT` (default `ml/models` at the repo root):

```
ml/models/
  yolov8n-coco/                # <modelId>  — ^[a-z0-9][a-z0-9._-]{0,63}$
    manifest.json              # required, strict allowlist-parsed (≤ 64 KiB)
    yolov8n.pt                 # the weights file named by manifest.file
```

`CV_LOCAL_YOLO_MODEL_ID` selects the entry. A model id is an opaque key —
it is never a path, must not contain `/`, `\`, `..`, or `:`, and the
resolved directory is re-verified to sit under the root before any read.

### `manifest.json`

```json
{
  "modelId": "yolov8n-coco",
  "task": "detect",
  "runtime": "ultralytics",
  "file": "yolov8n.pt",
  "version": "8.3.40-coco80",
  "inputSize": 640,
  "classes": [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train",
    "truck", "boat", "traffic light", "fire hydrant", "stop sign",
    "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
    "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella",
    "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard",
    "sports ball", "kite", "baseball bat", "baseball glove", "skateboard",
    "surfboard", "tennis racket", "bottle", "wine glass", "cup", "fork",
    "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
    "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair",
    "couch", "potted plant", "bed", "dining table", "toilet", "tv",
    "laptop", "mouse", "remote", "keyboard", "cell phone", "microwave",
    "oven", "toaster", "sink", "refrigerator", "book", "clock", "vase",
    "scissors", "teddy bear", "hair drier", "toothbrush"
  ],
  "roles": {
    "PRODUCT": [
      "bottle", "wine glass", "cup", "bowl", "banana", "apple", "sandwich",
      "orange", "broccoli", "carrot", "donut", "cake", "book", "vase",
      "toothbrush", "cell phone", "remote", "scissors", "teddy bear"
    ],
    "HAND": [],
    "PERSON": ["person"],
    "OBJECT": ["handbag", "backpack", "umbrella", "suitcase"]
  }
}
```

Field rules:

| Field | Rule |
| --- | --- |
| `modelId` | Must equal the directory name. |
| `task` | `detect` only (Phase 20). |
| `runtime` | `ultralytics` only. |
| `file` | `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(pt\|onnx)$`; no directories; must exist under the model directory and be ≤ 2 GiB. Ultralytics loads both `.pt` and `.onnx`. |
| `version` | Operator label, `^[A-Za-z0-9._-]{1,32}$`. |
| `inputSize` | 320–1280, multiple of 32. |
| `classes` | The model's class list **in index order**. The probe cross-checks `len(model.names)` against it — a mismatch makes the provider `UNAVAILABLE` (`MODEL_MANIFEST_MISMATCH`) rather than silently mislabeling. |
| `roles` | Maps each generic role to class **names** from `classes`. Any class not listed under a role is ignored. A role with an empty list is unsupported for this model. |

**COCO has no hand class.** With the example above `HAND` stays
unsupported, so the detector cannot emit `HAND` boxes and cannot derive
`PRODUCT_IN_HAND` on its own; the hand signal still has to come from the
`HAND_SIGNAL_LOCAL` slot (MediaPipe-class, still optional) until a
hand-capable detector (e.g. a YOLO fine-tuned on hands, or a retail
product+hand model) is registered with `"HAND": ["hand"]`. When such a
model is registered, the YOLO provider supplies the hand signal itself and
MediaPipe remains optional.

## Environment keys (`services/api/.env`)

| Key | Default | Meaning |
| --- | --- | --- |
| `CV_PRETRAINED_PROVIDER` | `classical` | `yolo_local` or `hybrid` enables the `YOLO_LOCAL` slot (`hybrid` also enables the hand and embedding slots). |
| `CV_PRETRAINED_STUB_MODE` | `false` | Lab-only deterministic stub. When `true`, the slot reports READY with `synthetic: true` evidence and the real runtime is **not** invoked. Leave `false` to use the local model. |
| `CV_LOCAL_MODEL_ROOT` | `ml/models` | Registry root. Relative values resolve against the repo root. |
| `CV_LOCAL_YOLO_MODEL_ID` | *(unset → `MODEL_NOT_CONFIGURED`)* | Registry entry to load. |
| `CV_LOCAL_PYTHON_BIN` | `python` | Interpreter: a bare executable name resolved from `PATH`, or an absolute path. |
| `CV_LOCAL_YOLO_TIMEOUT_MS` | `60000` | Wall-clock ceiling for one detect job; the worker is killed on expiry (`INFERENCE_TIMEOUT`). |
| `CV_LOCAL_YOLO_CONF_THRESHOLD` | `0.25` | Minimum detection confidence (0–1). |
| `CV_LOCAL_YOLO_FPS` | `2` | Frame sampling rate for a clip (frames are capped; long clips are downsampled). |
| `CV_LOCAL_YOLO_DEVICE` | `auto` | `auto`, `cpu`, or `cuda`. |

All keys are declared in `services/api/src/config/env.validation.ts`; an
undeclared key would be stripped by the whitelist and silently ignored.

## Availability / failure reason codes

Reported in `GET /pretrained-vision/providers` (`reasonCode`) and on the
stored `ProviderEvidence` envelope. Codes only — never a message or path.

| Code | Meaning |
| --- | --- |
| `PROVIDER_NOT_ENABLED` | `CV_PRETRAINED_PROVIDER` does not enable this slot. |
| `MODEL_ROOT_NOT_CONFIGURED` | `CV_LOCAL_MODEL_ROOT` is empty/invalid. |
| `MODEL_ROOT_NOT_FOUND` | The root directory does not exist. |
| `MODEL_NOT_CONFIGURED` | `CV_LOCAL_YOLO_MODEL_ID` is unset or not a valid id. |
| `MODEL_NOT_FOUND` | No `<root>/<modelId>/` directory, no manifest, or the weights file named by the manifest is missing. |
| `MODEL_MANIFEST_INVALID` | Manifest failed the strict allowlist parse (see field rules). |
| `MODEL_MANIFEST_MISMATCH` | Probe class count ≠ `classes.length`. |
| `MODEL_FILE_TOO_LARGE` | Weights exceed the 2 GiB ceiling. |
| `LOCAL_RUNTIME_NOT_INSTALLED` | Interpreter not found, or `numpy`/`ultralytics` not importable (worker exit 2). |
| `LOCAL_RUNTIME_PROBE_FAILED` | Readiness probe timed out or produced no result (worker exit 6). |
| `MODEL_LOAD_FAILED` | Ultralytics could not load the weights (worker exit 3). |
| `INFERENCE_FAILED` | `predict` raised (worker exit 4). |
| `INFERENCE_TIMEOUT` | Detect job exceeded `CV_LOCAL_YOLO_TIMEOUT_MS` and was killed. |
| `RUNTIME_OUTPUT_INVALID` | Worker stdout was not a valid protocol v1 document (or the runner sent a bad job — exit 5). |
| `RUNTIME_OUTPUT_TOO_LARGE` | Worker stdout exceeded the 8 MiB cap. |
| `CLIP_NOT_FOUND` | No video asset with that id in the caller's tenant. |
| `CLIP_NOT_DECODABLE` | ffmpeg could not decode analysis frames. |
| `NO_FRAMES_DECODED` | Decoding succeeded but yielded zero frames. |

Readiness is memoized for 60 s; fix the cause and re-query.

## Worker protocol (v1) summary

The Node runner spawns
`<CV_LOCAL_PYTHON_BIN> ml/runtime/yolo_detect_worker.py --probe|--detect`
with `shell: false`, stderr ignored, an 8 MiB stdout cap, and a kill timer.

- **stdin:** one JSON header line, then (detect only) exactly
  `frames × width × height × 3` bytes of RGB24. The header carries the
  absolute model file, `inputSize`, `device`, and for detect
  `confThreshold`, `maxDetectionsPerFrame`, `width`, `height`, and the
  frame list `[{ index, timestampMs }]`. Limits: 1–64 frames, 16–4096 px
  sides, ≤ 256 MiB total, `inputSize` 320–1280 (multiple of 32).
- **stdout:** exactly one JSON document.
  - probe OK: `{ protocol, status: "OK", mode: "probe", classCount, device, runtimeVersion, elapsedMs }`
  - detect OK: `{ ..., mode: "detect", frames: [{ index, detections: [{ classIndex, confidence, box: { x, y, width, height } }] }] }`
    — boxes are normalized top-left `xywh` in 0..1, sorted by confidence,
    truncated to `maxDetectionsPerFrame`.
  - failure: `{ protocol, status: "ERROR", code }` with exit code
    2 `RUNTIME_MISSING`, 3 `MODEL_LOAD_FAILED`, 4 `INFERENCE_FAILED`,
    5 `BAD_JOB`, 6 `PROBE_FAILED`.
- Frames arrive RGB and are flipped to BGR for Ultralytics; the probe
  runs one zero frame of `inputSize × inputSize`.

The worker is stdlib-only at import time; `numpy`/`ultralytics` load
lazily so a bare machine yields `RUNTIME_MISSING`, never a crash.
`ml/tests/test_yolo_detect_worker.py` pins the protocol with fake modules.

## Verifying end to end

1. Install the runtime, register a model, set the env keys (at minimum
   `CV_PRETRAINED_PROVIDER=yolo_local` and `CV_LOCAL_YOLO_MODEL_ID`), and
   restart the API (`pnpm run dev:api`).
2. `GET /pretrained-vision/providers` — `YOLO_LOCAL` should be `READY`
   with `stubMode: false` and a `runtime` block naming the `modelId`,
   `device`, and class counts. Anything else shows a reason code from the
   table above.
3. Pick an uploaded test clip that already has a classical fusion run
   (the evaluate route requires the classical baseline first) and
   `POST /pretrained-vision/videos/{videoAssetId}/evaluate` — or use the
   **Pretrained Vision** page in the admin app.
4. In the response / `GET .../report`, the `YOLO_LOCAL` run should be
   `COMPLETED` with `synthetic: false`, real `detections` (PRODUCT /
   HAND / PRODUCT_IN_HAND boxes with timestamps), and notes such as
   `LOCAL_DETECTOR_OUTPUT`, `PRODUCT_DETECTED`, and, where applicable,
   `DETECTION_COVERAGE_IMPROVED`. `fusionSuggestion.reviewRequired` stays
   `true` — by design.
5. Confirm nothing leaks: the JSON must contain no filesystem path, no
   model file name, no interpreter path, and no class names.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `UNAVAILABLE · LOCAL_RUNTIME_NOT_INSTALLED` | `python` on the API's `PATH` is not the venv, or `ultralytics` not installed there | Set `CV_LOCAL_PYTHON_BIN` to the venv interpreter; run the `python -c "import ultralytics"` check with that exact binary. On Windows the API inherits the PATH of the shell that started `pnpm run dev:api`. |
| `MODEL_NOT_CONFIGURED` | `CV_LOCAL_YOLO_MODEL_ID` unset or contains `/`, `\`, `.`, `..` | Use the bare directory name under the registry root. |
| `MODEL_NOT_FOUND` | Directory, `manifest.json`, or the weights file named by `file` is missing | Check `ml/models/<modelId>/` contents; `file` must be a bare file name. |
| `MODEL_MANIFEST_INVALID` | A field violates the rules (e.g. `inputSize` not a multiple of 32, unknown role key, class name in `roles` not present in `classes`) | Fix the manifest; keep it under 64 KiB. |
| `MODEL_MANIFEST_MISMATCH` | `classes` length differs from the model's real class count | Regenerate `classes` from `YOLO(file).names` in index order. |
| `LOCAL_RUNTIME_PROBE_FAILED` on first call, READY afterwards | Cold start (torch import + weights load) exceeded the probe timeout | Retry after 60 s; prefer keeping the venv on a local SSD. A CUDA cold start can take several seconds. |
| `INFERENCE_TIMEOUT` | CPU-only box with a large model or too many frames | Lower `CV_LOCAL_YOLO_FPS`, use a smaller model (`yolov8n`), or raise `CV_LOCAL_YOLO_TIMEOUT_MS`. |
| `DISABLED · PROVIDER_NOT_ENABLED` | `CV_PRETRAINED_PROVIDER=classical` | Set `yolo_local` or `hybrid`. |
| READY but evidence is `synthetic: true` | `CV_PRETRAINED_STUB_MODE=true` | Set it to `false`; the stub short-circuits the real runtime. |
| Evaluate returns 409 | The clip has no classical fusion run yet | Run the classical pickup-fusion flow on the clip first; the classical baseline is mandatory. |
| Evaluate returns 403 | Caller lacks `video-asset:read` or the tenant's `video-ingest` module is off | Same video boundary as the rest of Phase 19. |
| No `HAND` / `PRODUCT_IN_HAND` boxes | The registered model has no hand class (COCO) | Register a hand-capable model, or enable `hybrid` for the separate hand-signal slot. |
