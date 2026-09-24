# VLM-assisted labelling — execution handoff

**Audience:** a fresh Claude Code session on the GPU machine, with access to this repository
and nothing else. Assume no memory of the analysis that produced this plan. Everything
needed to execute is either in this document or re-derivable by the commands it gives.

**Branch:** `integration/completion-program`. Stage A below is already merged and committed.
**Status of the rest:** not started.

---

## 1. The question this answers

*Can the local VLM generate ground truth to train the CV model?*

**Answer: yes for event labels, no for product identity.** That split is not a preference,
it is what the data says, and the rest of this document is the consequence.

### The evidence

Measured on the development database (192 `PickupFusionRun` rows over 43 clips, model
`qwen2.5vl:7b`). Re-derive any of it with the SQL in §7.

```
verdict:  MATCH 116 · AMBIGUOUS 5 · UNKNOWN 4 · MISMATCH 0
status:   VERDICT 126 · TIMEOUT 8 · UNAVAILABLE 6 · INVALID_SCHEMA 5 · other errors 4
latency:  median 60 s · max 161 s
```

**The VLM has never once returned `MISMATCH`.** On the 101 `MATCH` runs whose clip carries a
human label:

| | |
|---|---|
| VLM's selected SKU correct | **81** |
| VLM's selected SKU wrong | **20** |
| Fusion pipeline correct, same clips | 83 |

So on identity the VLM is not a teacher — it is a slightly *worse* peer (80% vs 82%). And
every one of the 20 errors is a single confusion:

```
WATER-BOTTLE-500ML  ->  SKU-LIME-GREEN   x20   (100% of errors)
```

It stamps every one of those `MATCH`. Auto-labelling identity today would produce a training
set in which every water bottle is confidently labelled a Nescafé can, and bake that error
in permanently. **This is the single most important fact in this document.**

### Why events are different

The same model, asked to **count units before and after** the hand motion, scores **26/27
against ground truth**, with every false touch correctly answered `NONE`. The design note in
`services/api/src/pickup-fusion/adapters/vlm-shared.ts` explains why:

> "The model is asked to COUNT — a concrete, checkable task — never 'was this a pickup', so
> the answer can be cross-checked against the counts by the strict parser."

A reply whose `change` word contradicts its own before/after numbers is rejected as
`INVALID_SCHEMA` rather than trusted. That self-consistency check is the reason counting is
usable and identity is not, and it is the template for any future model-as-labeller.

---

## 2. Two constraints that shape the implementation

**`VideoGroundTruth` must never be written by a machine.** It has one write site
(`services/api/src/pickup-detection/pickup-validation.service.ts:273`), it is an **in-place
`upsert`** keyed `@@unique([tenantId, videoAssetId])`, it has **no provenance field**, no
history row, no audit-log write, and it is *not* covered by the append-only DB triggers.
`createdById` is nullable and the service parameter optional, so a machine write would
silently overwrite an operator's label leaving nothing to tell them apart. Phase 18 already
works around this mutability with a `STALE_GROUND_TRUTH` exclusion
(`services/api/src/cv-dataset/cv-dataset.service.ts:1099-1102`).

Machine proposals go to **`PilotObservationReview`** instead: genuinely append-only (trigger
`pilot_review_append_only`), carries both the corrected label (`expectedAction`,
`expectedProductId`) and a server-side snapshot of what CV predicted, and is already defined
as "an operator label over one CV observation". Its verdict vocabulary includes `FALSE_TOUCH`,
which Phase 18 maps to a reviewed negative (`NO_OP`).

**Models reload from disk on every call.** `load_model` sits inside `run_detect` / `run_embed`
in `ml/runtime/*.py`, never cached, and `WorkerJobGate` permits one worker process per model
with four queued. Every clip therefore pays a YOLOv8n load plus CUDA init (~1–3 s) and a full
CLIP ViT-B-32 push (~600 MB) to VRAM. An 8 GB card holds both resident at ~1.5 GB — nothing
keeps them there. **This, not GPU capacity, is what limits continuous operation.** See Stage E.

---

## 3. What the machine needs before anything runs

The repository alone is **not** sufficient — the clips and their labels live outside git.

| Item | Where it is | Size | Notes |
|---|---|---|---|
| Database dump | `byond-backups/byond_dev_pre_integration_20260917.dump` | ~1 MB | `pg_dump -Fc` of `byond_dev` |
| Media files | `.local/video-ingest/` | **1.4 GB** | gitignored; the actual video bytes |
| CV models | `ml/models/{yolov8n-coco,clip-vit-b32}` | ~600 MB+ | gitignored |
| Python venv | `~/.byond/cv-venv` | — | `ultralytics`, `open_clip_torch`, CUDA torch |
| Ollama + model | local service on `127.0.0.1:11434` | ~6 GB | `ollama pull qwen2.5vl:7b` |

Both the dump **and** `.local/video-ingest/` must be copied. A restored database without the
media gives you rows whose pixels are gone; the pipeline will fail or silently exclude them.

The lab tenant id is **`cmscwigr300409z687nhcpsm5`** ("Platform Sandbox"), which owns all 95
video assets. You will need it for every command below.

### Setup

```bash
# 1. Postgres 16 on port 5433, database byond_dev, user byond
docker run -d --name byond-postgres-dev -p 5433:5432 \
  -e POSTGRES_USER=byond -e POSTGRES_PASSWORD=<pw> -e POSTGRES_DB=byond_dev postgres:16

# 2. Restore
docker exec -i byond-postgres-dev pg_restore -U byond -d byond_dev --clean --if-exists \
  < byond-backups/byond_dev_pre_integration_20260917.dump

# 3. Media — copy .local/video-ingest/ to the same relative path in the repo

# 4. services/api/.env — copy from the source machine, or build from .env.example.
#    DATABASE_URL must point at 5433/byond_dev. VIDEO_STORAGE_ROOT defaults to
#    ../../.local/video-ingest. Required for this work:
#      PICKUP_VLM_ENABLED=true
#      PICKUP_VLM_PROVIDER=local
#      PICKUP_VLM_MODEL=qwen2.5vl:7b
#      PICKUP_VLM_EVENT_CHECK=true        # the count check — Stage A added this key
#      CV_LOCAL_YOLO_DEVICE=cuda
#      CV_LOCAL_PYTHON_BIN=<path to ~/.byond/cv-venv python>
#      VIDEO_FFMPEG_ENABLED=true

# 5. Apply migrations and install
pnpm install
pnpm --filter @byond/api run prisma:migrate-deploy

# 6. Confirm the model answers at all
curl http://127.0.0.1:11434/api/tags
```

`services/api/.env` is gitignored, so a fresh git worktree will not have one. Every key the
validator declares is documented in `services/api/.env.example`, and a drift guard keeps the
two in sync.

---

## 4. Stage A — already done

`feat/vlm-event-verification` is merged into `integration/completion-program`. It brought:

- `verifyEvent()` as an **optional** port method — a verifier lacking it reports `NOT_RUN`
  and the pipeline behaves exactly as before, so nothing else changed.
- The self-consistency rejection described in §1.
- Describe-then-choose prompting: the model must state what it *sees* before seeing the
  candidate list, "so a clear plastic bottle is not talked into being a coloured can by a
  stronger-looking reference photo". Includes the instruction "never pick the best of a bad set."
- `vlmDisagreementYieldsToFusion` — when fusion was confident and the VLM picks a different
  SKU without STRONG visual support, fusion's answer stands and the clip goes to review.
- Reference ordering by largest-file-first. The commit note reads *"a 4 KB crop was the water
  reference"* — directly upstream of the 20 errors above.
- `services/api/scripts/replay-fusion.ts`, exposed as `pnpm --filter @byond/api fusion:replay`.

Two merge conflicts were resolved as unions: `services/api/package.json` (kept both
`prisma:migrate-deploy` and `fusion:replay`) and `services/api/.env.example` (kept the
regenerated key set, added `PICKUP_VLM_EVENT_CHECK` and `PICKUP_VLM_EVENT_CHECK_TIMEOUT_MS`,
dropped a duplicated `PICKUP_VLM_MODE` line).

---

## 5. Stages to execute

### Stage B — make accuracy reproducible (no human input)

The 26/27 and 20/24 figures currently exist **only as prose in commit messages**, produced by
hand and reproducible by no committed artifact. Nothing persists a VLM-verdict-vs-ground-truth
comparison — `shadowVerdict` scores the pipeline's final answer, not the VLM's.

Extend `services/api/scripts/replay-fusion.ts` to emit a per-clip agreement record as CSV/JSON
rather than only a printed table: ground-truth kind and SKU, VLM event verdict, VLM identity
verdict, fusion top choice, and an agreement flag per task. Persist the result as a
`PilotEvaluationRun` — the Phase 15 tables are fully built, tested and wired to an admin UI
but hold **zero rows** and have never run.

**Promotion gate.** The VLM may label a task only after clearing a stated bar on held-out
clips: **event labelling ≥95% agreement with zero false pickups; identity labelling must beat
the fusion pipeline**, which it currently does not. Without this gate the exercise becomes
self-confirmation.

Two measurement traps:

- The 7B reports `LABEL_MISMATCH` on virtually every clip because it compares printed
  packaging text against catalog names ("AKOYA" vs "Drinking Water Bottle 500ml"). That is an
  artefact of the prompt inputs, **not** disagreement. Exclude it.
- **39 ground-truth rows is an upper bound, not a count.** A clip can be soft-deleted while its
  label row survives. Join to `videoAsset WHERE deletedAt IS NULL` before quoting coverage.
  Note also `CONFUSION_MATRIX_MIN_REVIEWED = 50`, so the built-in confusion matrix stays
  suppressed at 39 rows.

Run:
```bash
cd services/api
npx ts-node -T scripts/replay-fusion.ts --tenant cmscwigr300409z687nhcpsm5 --prefix r1_
```
Needs Ollama up and the database reachable. Expect roughly 60 s per clip.

### Stage C — fix the reference library (the only step needing a human)

The cause of 100% of the identity errors, and the highest-leverage action available.

First try with no human input:
```bash
cd services/api
npx ts-node -T scripts/curate-references.ts --tenant cmscwigr300409z687nhcpsm5 \
  --sku WATER-BOTTLE-500ML --prune-below-bytes 8192 --dry-run
# then without --dry-run, then rebuild the index:
# POST /pickup-fusion/reference-index/reindex  with { "rebuild": true }
```
Re-run Stage B and see whether the 20 errors move.

Then Saad photographs the water bottle properly (he has agreed to this). The existing
references are placeholder images plus crops cut from the evaluation clips themselves — which
both weakens them and **leaks evaluation data into the retrieval index**, inflating any
accuracy measured afterwards. Reindex and re-measure.

### Stage D — machine-proposed event labels (no human input)

**Only after Stage B's gate passes.** Sweep every clip with the count check and append
proposals as `PilotObservationReview` rows through the existing bridge
`POST /one-sku-bootstrap/:productId/videos/:videoAssetId/review`, which already imports a
clip's latest fusion run as a shadow journey event and appends a pilot review against it.

**Provenance is mandatory and does not exist yet.** Add an explicit marker distinguishing
machine-proposed rows from human ones. A nullable `reviewedById` is *not* sufficient — that is
also what an unattributed human row looks like. A small enum column on `PilotObservationReview`
is the honest fix, and it must be filterable so a training set can later be restricted to
human labels. **Never write `VideoGroundTruth` from a machine.**

### Stage E — only if continuous operation is actually wanted

43 clips at ~60 s is under an hour, so 24/7 is not needed for throughput. It becomes
worthwhile for **self-consistency**: run each clip several times varying the sampled instants,
crop choice and reference order — temperature is already 0, so vary the *inputs* rather than
sampling — and keep only labels where the runs agree. Cheap disagreement detection is worth
more than raw speed.

The prerequisite is a **persistent model worker**: keep the Python process alive and feed one
job per stdin line instead of reloading weights on every call. The existing protocol-v1
header-line framing in `ml/runtime/*.py` is already most of the way there, and `WorkerJobGate`
is the natural place to hold the handle. Without it, a continuous loop spends most of its time
loading models.

---

## 6. Guardrails — these will fail the build if ignored

- `services/api/src/cv-dataset/shadow-mode.spec.ts` bans **any** VLM symbol in that directory
  (`VlmVerifier`, `PICKUP_VLM_VERIFIER`, `OllamaVlmVerifier`, `vlm-provider`, …). Labelling
  code cannot live there.
- `services/api/src/cv-evaluation/shadow-mode.spec.ts` bans **every** Prisma write in that
  directory — it is read-only aggregation, full stop.
- A new module gets no guard automatically, but `services/api/src/returns/boundary.spec.ts`
  and `services/api/src/store-flow/boundary.spec.ts` hardcode an eleven-module shadow list;
  extend both if you add a twelfth.
- **CV only proposes.** The pipeline's terminal output is a `PickupFusionRun` row. It must
  never write a vision event, checkout session, order, payment or inventory movement. If a
  guard spec fails, fix the code — never weaken the spec.
- Never run a bare `pnpm -r --if-present run test`: the API suite spawns ~18 jest workers at
  ~400 MB each. Use `pnpm --filter @byond/api run test --ci --maxWorkers=4` (drop to 2 if the
  machine is also running Docker and an editor).

---

## 7. Verification

**Baseline that must not drop:** API **203 suites / 5002 tests** (measured on this branch
after the Stage A merge; the pre-merge figure was 4959).

```bash
pnpm -r --if-present run lint
pnpm -r --if-present run typecheck
pnpm --filter @byond/api run test --ci --maxWorkers=4
pnpm -r --if-present run build
```

**Shadow safety.** `services/api/scripts/fusion-shadow-run.ts` prints before/after counts of
orders, payment intents, checkout sessions and inventory movements around a single run. All
four deltas must be zero.

**The success metric for this whole plan is one number.** Re-run this after every change to
the reference library; it is currently **20**:

```sql
WITH gt AS (
  SELECT g."videoAssetId", p.sku AS gt_sku
  FROM "VideoGroundTruth" g JOIN "Product" p ON p.id = g."productId"
),
r AS (
  SELECT f."videoAssetId", f.evidence->'vlm'->>'selectedSku' AS vlm_sku
  FROM "PickupFusionRun" f
  WHERE f.evidence->'vlm'->>'verdict' = 'MATCH'
)
SELECT gt.gt_sku || ' -> ' || COALESCE(r.vlm_sku, '(null)') AS confusion, COUNT(*)
FROM r JOIN gt ON gt."videoAssetId" = r."videoAssetId"
WHERE r.vlm_sku IS DISTINCT FROM gt.gt_sku
GROUP BY 1 ORDER BY COUNT(*) DESC;
```

Companion queries — verdict distribution and overall agreement:

```sql
SELECT COALESCE(evidence->'vlm'->>'verdict','(none)') AS verdict, COUNT(*)
FROM "PickupFusionRun" GROUP BY 1 ORDER BY COUNT(*) DESC;
```

**After Stage D:** assert every machine-proposed row is filterable by its provenance marker,
and that the `VideoGroundTruth` row count is unchanged from before the sweep.

---

## 8. Reporting back

State plainly: which stage you completed, the confusion-count number before and after, the
verification results, and anything you deliberately did not do. If the VLM fails the Stage B
promotion gate, **say so and stop** — do not proceed to Stage D. A labelling run that fails
its own gate is worse than no labelling run, because its output looks like data.
