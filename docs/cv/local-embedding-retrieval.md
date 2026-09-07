# Local embedding retrieval (Phase 24)

The fusion pipeline's **retrieval** signal ranks catalog products by how
much the event crop looks like each product's reference photos. Until
Phase 24 that index was `hog-lab-v1`: a dependency-free HOG-and-colour
descriptor that scores a transparent water bottle 0.45 and a purple can
0.42 — near noise. This phase adds `clip-local`: real image embeddings
from a **local** open_clip-class encoder, behind the same
`VisualRetriever` port, with the same confinement as the Phase 20 YOLO
provider.

Nothing here calls an external API or a cloud model. Reference images and
crops never leave the process except as raw RGB bytes piped over stdin to
a local Python worker with no network.

## What changes for the operator

| Before | After (`PICKUP_RETRIEVAL_PROVIDER=clip_local`) |
| --- | --- |
| retrieval = HOG-and-colour similarity, nearly flat across SKUs | retrieval = cosine similarity of CLIP embeddings, sharply separated for visually different products |
| one vector per reference image under `hog-lab-v1` | one vector per reference image under `clip-local` — both generations coexist in `ProductReferenceEmbedding`; switching back never destroys an index |
| new photos need "rebuild index" | same: **Reference library → rebuild index** (or `POST /pickup-fusion/reference-index/reindex`) embeds every photo lacking a `clip-local` vector |

Onboarding a SKU is still: attach 8–12 reference photos, rebuild the
index. No training.

## Installing the local runtime

The worker (`ml/runtime/embed_worker.py`) needs `numpy`, `torch` and
[`open_clip`](https://github.com/mlfoundations/open_clip) importable by the
interpreter named in `CV_LOCAL_PYTHON_BIN`. In the same venv the YOLO
provider uses:

```powershell
~\.byond\cv-venv\Scripts\python.exe -m pip install open_clip_torch
```

`open_clip` downloads the pretrained weights **once** into its own local
cache the first time a `pretrained` tag is used (ViT-B-32 /
`laion2b_s34b_b79k` is about 600 MB). Do that once from a shell, so the
API never needs network access:

```powershell
~\.byond\cv-venv\Scripts\python.exe -c "import open_clip; open_clip.create_model_and_transforms('ViT-B-32', pretrained='laion2b_s34b_b79k')"
```

A checkpoint file can be used instead of a tag (see the manifest below);
the registry then confines it exactly like YOLO weights.

## Model registry entry

Under `CV_LOCAL_MODEL_ROOT` (default `ml/models`, gitignored):

```
ml/models/clip-vit-b32/manifest.json
```

```json
{
  "modelId": "clip-vit-b32",
  "task": "embed",
  "runtime": "open_clip",
  "arch": "ViT-B-32",
  "pretrained": "laion2b_s34b_b79k",
  "dim": 512,
  "version": "laion2b",
  "inputSize": 224
}
```

| Field | Rule |
| --- | --- |
| `modelId` | `^[a-z0-9][a-z0-9._-]{0,63}$`, must equal the directory name and `CV_LOCAL_EMBED_MODEL_ID`. |
| `task` / `runtime` | `embed` / `open_clip`. |
| `arch` | open_clip architecture name, `^[A-Za-z0-9._-]{1,48}$`. |
| `pretrained` **or** `file` | exactly one. `pretrained` is an open_clip cache tag (`^[A-Za-z0-9._-]{1,64}$`, format `HUB_CACHE`); `file` is a `.pt` checkpoint inside the model directory (format `PT`, ≤ 2 GiB, symlink-confined). |
| `dim` | declared embedding length (16–4096). The readiness probe encodes one synthetic image and **fails closed** (`MODEL_MANIFEST_MISMATCH`) if the encoder returns another length — stored vectors and queries must never differ in size. |
| `version` | index generation label, `^[A-Za-z0-9._-]{1,32}$`; stored as `ProductReferenceEmbedding.modelVersion`. |
| `inputSize` | square input edge (default 224). |

## Environment keys (`services/api/.env`)

| Key | Default | Meaning |
| --- | --- | --- |
| `PICKUP_RETRIEVAL_PROVIDER` | `hog_lab` | `clip_local` binds the CLIP retriever to the fusion retrieval port. When the runtime is unavailable the signal is empty and the adapter reports not-ready in the fusion evidence — the provider is **never** switched back silently. |
| `CV_LOCAL_EMBED_MODEL_ID` | unset | Registry key of the encoder. Unset → `MODEL_NOT_CONFIGURED`. |
| `CV_LOCAL_EMBED_TIMEOUT_MS` | `60000` | Kill timeout for one worker call (5 000–300 000). |
| `CV_LOCAL_PYTHON_BIN`, `CV_LOCAL_MODEL_ROOT`, `CV_LOCAL_YOLO_DEVICE` | as for YOLO | Shared interpreter, registry root and device hint. |
| `CV_PRETRAINED_PROVIDER=embeddings_local` or `hybrid` | — | Also lights the `EMBEDDING_LOCAL` chip on the Pretrained vision page with the encoder's model id and device. The ranking itself is served by fusion (that module never reads media), so the chip reports status only (note `EMBEDDING_RANKING_SERVED_BY_FUSION_RETRIEVAL`). |

## How scoring works

1. `ensureIndex` decodes every ACTIVE product's reference images that lack
   a `clip-local` vector as an aspect-preserving, grey-padded 224×224
   square (ffmpeg `scale…force_original_aspect_ratio=decrease,pad`), embeds
   them in batches of 32, and stores L2-normalized vectors.
2. `retrieve` letterboxes the event crop the same way, embeds it, and takes
   the cosine similarity against every reference vector of the tenant's
   ACTIVE products. Per product the score is the **best** reference
   similarity; the mean of the top three travels as evidence detail.
3. `retrieveMany` (multi-crop voting) embeds the pre/peak/post crops in one
   worker call and **averages** the per-crop product scores, so a product
   must look right across the event, not in one lucky frame. The fusion
   service still passes one crop today; wiring the three crops is a
   follow-up.

Scores are cosine similarities clamped to 0..1 — like every fusion signal
they are uncalibrated ranking values until the calibration phase.

## Reason codes

The runtime reports the same classified codes as the YOLO provider
(`local-vision-runtime.port.ts`): `MODEL_NOT_CONFIGURED`,
`MODEL_ROOT_NOT_FOUND`, `MODEL_NOT_FOUND`, `MODEL_MANIFEST_INVALID`,
`MODEL_MANIFEST_MISMATCH` (declared `dim` ≠ encoder output, or id ≠
directory), `MODEL_FILE_TOO_LARGE`, `LOCAL_RUNTIME_NOT_INSTALLED`
(interpreter or `numpy`/`torch`/`open_clip` missing),
`LOCAL_RUNTIME_PROBE_FAILED`, `MODEL_LOAD_FAILED` (unknown tag, missing
or corrupt checkpoint), `INFERENCE_FAILED`, `INFERENCE_TIMEOUT`,
`RUNTIME_OUTPUT_INVALID`, `RUNTIME_OUTPUT_TOO_LARGE`, `RUNTIME_BUSY`.

## Worker protocol (v1)

`python ml/runtime/embed_worker.py --probe|--embed`, stdin = one JSON
header line, then (embed) `images × width × height × 3` RGB24 bytes;
stdout = exactly one JSON document.

- probe → `{ "protocol":1, "status":"OK", "mode":"probe", "dim":512, "device":"cpu|cuda", "runtimeVersion":"2.26.1", "elapsedMs":… }`
- embed → `{ …, "mode":"embed", "vectors":[[…512 floats]…] }` (unit length; the Node runner re-normalizes and rejects any other length)
- errors → `{ "protocol":1, "status":"ERROR", "code":"RUNTIME_MISSING|MODEL_LOAD_FAILED|INFERENCE_FAILED|BAD_JOB" }` with exit 2/3/4/5

No path, tag, architecture name, traceback or exception text ever appears
on stdout; stderr is discarded by the runner.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Fusion evidence shows `retrieval` adapter not ready | `PICKUP_RETRIEVAL_PROVIDER=clip_local` but the runtime is UNAVAILABLE | `GET /pretrained-vision/providers` with `CV_PRETRAINED_PROVIDER=hybrid` shows the `EMBEDDING_LOCAL` reason code; fix per the table above. |
| `MODEL_LOAD_FAILED` right after install | pretrained weights not in open_clip's cache yet | run the one-time download command above from a shell. |
| `MODEL_MANIFEST_MISMATCH` | `dim` in the manifest does not match the encoder (ViT-B-32 = 512, ViT-L-14 = 768) | correct the manifest. |
| Retrieval scores all near 0.2 | index built before photos were added | Reference library → rebuild index. |
