# BYOND ML — Phase 8: CV Training Dataset + Model Pipeline MVP

This workspace is the foundation for preparing computer-vision training
datasets and mapping model output onto the Phase 7 `VisionEvent` API
(`POST /vision-events`, `services/api/src/vision/`). It is plain Python
(stdlib-only) and lives **outside** the pnpm workspace — it has no runtime
dependency on, and is not depended on by, `apps/` or `services/`.

## What this is

- Dataset manifest schema + validator (`ml/configs/dataset.schema.json`,
  `ml/scripts/validate_dataset_manifest.py`).
- Dataset preparation scripts for two public datasets (RPC, SKU-110K) and a
  future BYOND custom store dataset — they normalize raw downloads into a
  manifest-described layout; they do **not** fetch or redistribute data.
- A mapping script (`ml/scripts/sample_inference_to_vision_event.py`) that
  turns a model's output JSON into a valid Phase 7 `VisionEvent` ingest
  payload, so downstream integration has one obvious, testable seam.
- Small, synthetic JSON examples and unit tests that exercise the above
  without any real dataset or trained model present.

## What this is NOT

- **Not** an edge runtime — no camera integration, no on-device inference,
  no streaming pipeline. That is a later phase.
- **Not** production autonomous checkout — nothing here writes to a
  checkout session, basket, or order; only `POST /vision-events` (reviewed
  by a human, per Phase 7) ever does that.
- **Not** real training yet — there is no training loop, no GPU requirement,
  and no model weights in this repo. `ml/configs/training.example.yaml`
  documents the *intended* shape of a future training command; it is not
  wired to anything today.

The goal of Phase 8 is narrower: give BYOND a repeatable way to prepare
labeled data and evaluate/export product-recognition models whose output
can be reduced to the vendor-neutral `VisionEvent` contract.

## Directory layout

```
ml/
  datasets/      Dataset READMEs + gitignored raw/ and processed/ subdirs
  scripts/       CLI tools (manifest validation, dataset prep, VisionEvent mapping)
  configs/       Schemas and example configs (dataset.schema.json, training.example.yaml)
  examples/      Tiny synthetic JSON/YAML fixtures used by docs and tests
  tests/         Unit tests (python -m unittest)
```

## Dataset & artifact policy

**Datasets, trained weights, and media are never committed to this repo.**

- No images, no video, no annotated frames.
- No RPC or SKU-110K dataset files (both carry their own license terms —
  see `ml/datasets/rpc/README.md` and `ml/datasets/sku-110k/README.md`).
- No customer or store media of any kind.
- No trained model weights (`.pt`, `.onnx`, `.engine`, `.safetensors`,
  `.weights`, or any other checkpoint format).

The repo stores pipeline **code**, the manifest **schema**, **docs**,
**tests**, and tiny **synthetic** JSON examples only. The root
`.gitignore` enforces this (see the "ML datasets, models, and media"
section) — `raw/` and `processed/` under every dataset directory, `ml/models/`,
`ml/runs/`, `ml/outputs/`, model weight extensions, and media extensions
scoped to `ml/` are all ignored.

## Model strategy (recommended BYOND CV approach)

BYOND's product-recognition pipeline is deliberately layered rather than
one monolithic model, and every layer is a swappable, pluggable artifact
behind the Phase 7 `VisionEvent` contract (per `AGENTS.md` vendor
neutrality: no LLM/CV vendor is hardcoded into core logic):

1. **Lightweight detector + tracker** (YOLO-style) — finds people, hands,
   and shelf-interaction events cheaply, in near real time. This is the
   first-pass signal that something happened, not what.
2. **Higher-accuracy shelf/product detector** (RT-DETR or similar) — used
   where the lightweight detector's shelf/product localization isn't
   accurate enough on its own.
3. **Dedicated SKU classifier** on cropped detections — takes a crop from
   the detector and answers "which exact catalog SKU is this," producing
   the ranked `candidates[]` a `VisionEvent` carries.
4. **VLM as a verifier only**, on uncertain cropped product cases — never
   full-video or full-frame VLM analysis. It is a narrow, targeted
   second opinion on a single crop when the SKU classifier's confidence is
   low, not a general-purpose scene interpreter.

Two invariants apply regardless of which models are plugged in:

- **No raw media ever enters the app database.** Every model's output is
  reduced to `VisionEvent` JSON (typed fields + ranked SKU candidates +
  lineage-only evidence) before it reaches the API.
- **BYOND Retail OS stays model-provider neutral.** Models are pluggable
  external artifacts behind the `VisionEvent` contract; core logic never
  hardcodes a specific vendor or model family.

## Future runtime direction (documentation only — nothing here is implemented in Phase 8)

This section records the agreed direction for a *future* camera/inference
runtime, so later phases build on a shared plan rather than re-deriving one.

- **Event-driven, not always-on.** BYOND CV runs lightweight continuous
  tracking (people/hand/shelf-zone geofences) on a low-res/downscaled
  stream. Heavy inference never runs on every frame.
- **Trigger layer.** A hand/wrist entering a shelf zone, or a suspected
  shelf change / pickup / return, triggers analysis — the lightweight
  tracker decides *when* to look closer, not *what* was taken.
- **Heavy inference layer.** High-resolution crops from the 6MP/8MP camera
  feed product recognition / SKU classification, with OCR when useful. A
  VLM is used only as a fallback verifier for uncertain crops — it is
  never the main engine. (Research direction: downscale for YOLO-style
  tracking while keeping full sensor resolution for triggered shelf/
  product crops.)
- **Inference queue.** A future Inference Queue Manager abstraction
  batches simultaneous crop-recognition jobs. Triton-style model serving
  is a suitable future backend for the sub-second retail decision path;
  Celery/Redis-style queues are acceptable only for offline/background
  jobs.
- **Video pipeline.** The default direction is a GStreamer-style camera
  pipeline; FFmpeg serves as a utility/debug/transcoding layer; DeepStream
  is an optional premium NVIDIA adapter, never a core dependency.
- **Neutrality invariant.** No hard dependency on NVIDIA, Hailo,
  Ambarella, DeepStream, or any single VLM/provider — every layer stays
  provider- and hardware-neutral, per the same principle as the model
  strategy above.
- **Output contract unchanged.** Model output still feeds the Phase 7
  `VisionEvent` JSON contract (`POST /vision-events`) — this direction
  changes nothing about how results reach the API.

Phase 8 ships none of this — no camera runtime, no inference service, no
GStreamer/DeepStream/Triton/Redis/Celery dependencies, no VLM integration;
this section records the agreed direction only.

## Manifest format

Every prepared dataset is described by a manifest JSON file validated
against `ml/configs/dataset.schema.json`. See
`ml/scripts/validate_dataset_manifest.py` and the per-dataset READMEs
under `ml/datasets/` for the exact shape each `prepare_*` script produces.

Two fields keep manifests reference-only (nothing is ever copied for the
MVP — no dataset duplication under `processed/`):

- **`sourceRoot`** (optional string) — the dataset source root that all
  `image`/`annotation` references resolve against. A relative `sourceRoot`
  resolves against the manifest file's own directory; generated manifests
  live in `processed/` while media stays under `raw/`, so prepare scripts
  emit `../raw`-style values. `validate_dataset_manifest.py --check-files`
  uses it automatically when `--base-dir` isn't given.
- **`annotations`** (optional object, `train`/`val`/`test` keys) — the
  per-split annotation source file (RPC's COCO JSON, SKU-110K's CSV),
  relative to `sourceRoot`, same path rules as sample paths. Original
  annotation data is referenced, not copied or discarded, so future
  detector training can consume the full label set.

## VisionEvent mapping

`ml/scripts/sample_inference_to_vision_event.py` takes a model's raw
output JSON and maps it to a Phase 7 `POST /vision-events` payload
(`locationId`, `unitId`, `deviceId?`, `sessionId?`, `type`, `occurredAt`,
`quantity`, `candidates[]`, `sourceType`, `evidenceScore?`, and a CLOSED
`evidenceBundle`). The evidence bundle is intentionally lightweight —
`sourceType` + `captureStartedAt`/`captureEndedAt` lineage timestamps only.
Fields the Phase 7 API rejects with a 400 are **never** produced by this
script: no artifact descriptors, no metadata objects, no image URIs or
storage keys, no model provenance strings, no inline/raw media in any
encoding.

## Running scripts & tests

```bash
# Validate a manifest (optionally check that referenced files exist on disk)
python ml/scripts/validate_dataset_manifest.py <manifest.json> [--check-files] [--base-dir DIR]

# Prepare a dataset (dry-run needs nothing on disk)
python ml/scripts/prepare_rpc.py --input DIR --output DIR [--dry-run]
python ml/scripts/prepare_sku110k.py --input DIR --output DIR [--dry-run]
python ml/scripts/prepare_byond_dataset.py --input DIR [--output DIR] [--dry-run]

# Map a model output file to a VisionEvent ingest payload
python ml/scripts/sample_inference_to_vision_event.py <model_output.json> [--out FILE]

# Run the test suite (from the repo root)
python -m unittest discover -s ml/tests -p "test_*.py"
# or
pnpm run ml:test
```

See `ml/scripts/README.md` for per-script CLI details and exit codes.

## Local inference runtime (Phase 20)

`ml/runtime/yolo_detect_worker.py` is the first real local inference
worker: the API's `local-vision-runtime` module spawns it (no shell, no
network, stderr discarded) to run an Ultralytics-YOLO-class detector over
frames of an uploaded test clip and feed the Phase 19 pretrained-vision
adapter layer. It is stdlib-only at import time; `numpy` and `ultralytics`
load lazily, so a machine without them reports `RUNTIME_MISSING` and the
API keeps the provider UNAVAILABLE with the classical fallback intact.
`ml/tests/test_yolo_detect_worker.py` pins the stdin/stdout protocol with
fake modules, so `ml:test` still needs no heavy ML install. Weights live in
the gitignored `ml/models/<modelId>/` registry and **never enter the
repo**. Setup, manifest format, env keys, reason codes, and
troubleshooting: [`docs/cv/local-yolo-provider.md`](../docs/cv/local-yolo-provider.md).

## Future training

`ml/configs/training.example.yaml` documents the intended shape of a
future training config — the flags and structure a later `train_detector.py`
would validate and print a plan for. Nothing in Phase 8 downloads a
dataset automatically, nothing requires a GPU, and CI never needs heavy ML
libraries (no torch/tensorflow install) to pass — `ml:test` runs on the
Python standard library alone.
