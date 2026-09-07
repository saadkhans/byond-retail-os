# Pickup fusion v2 — classical event detection notes

The fusion v2 pipeline (`services/api/src/pickup-fusion/`) proposes pickup
and return events from decoded analysis frames with the classical-motion
detector (`adapters/event-detection.ts`, adapter key `classical-motion`)
before any retrieval, OCR, or VLM stage runs. Nothing here is
authoritative: every proposal is shadow evidence that stays review-required.

## Global motion window

The detector first builds the frame-wide motion timeline (mean absolute
RGB difference between consecutive analysis frames) and looks for one
sustained bump whose peak is at least three times the median sample. That
is the same rule as the Phase 10 classical analyzer and it works when a
fixed camera frames the hand and product closely.

## Localized motion fallback (`LOCALIZED_MOTION_FALLBACK`)

On footage with frame-wide nuisance motion — a handheld phone, an animated
advertising display in shot, glass-door reflections — the median motion
sample is inflated so far that a small hand never reaches the three-times
ratio and the clip is refused with `NO_MOTION_EVENT`, even though the
pickup is plainly visible.

When the global search finds nothing, the detector now retries on a
localized timeline (`adapters/localized-motion.ts`): every consecutive
frame difference is partitioned into an 8×8 grid of cells, each cell's
mean absolute difference has that cell's own temporal median subtracted
(clamped at zero), and the timeline value is the maximum residual over
cells. A permanently busy region is flattened to its own noise floor, so
it cannot create an event on its own, while a hand passing through an
otherwise quiet cell stands out. The same window finder and the same
three-times rule are then applied to that timeline.

If the fallback finds a window, the rest of the pipeline is unchanged
(endpoint background models, camera-motion guard, durable-change regions,
pickup/return discrimination) and the output carries the warning
`LOCALIZED_MOTION_FALLBACK`. Two further fallback-only refinements can
apply, each with its own warning:

- `LOCALIZED_REGION_FILTERED` — when the durable-change search returns
  several regions and some intersect the neighbourhood of the cell where
  the hand moved, only those are kept (the nuisance motion that hid the
  event also litters the endpoint difference with unrelated regions).
- `LOCALIZED_REGION_RELAXED` — when the strict search returns no region at
  all, the search is repeated inside that neighbourhood with a lower
  per-channel change threshold (20 instead of 40), because a transparent
  bottle on a bright shelf leaves only a faint footprint.

The fallback never engages when the global timeline already finds an
event, so clips that worked before produce identical output. It does not
change the Phase 10 v1 analyzer (`pickup-detection/analysis/`).

Operators should still prefer the footage guidance in
`docs/cv/local-yolo-provider.md` (fixed camera, tight framing, no display
in shot): the fallback recovers the event window, but the pickup/return
classification of a low-contrast product remains less reliable than on a
close-up clip.

### Fallback region ranking (`LOCALIZED_REGION_RANKED`)

In fallback mode the endpoint difference of a noisy clip returns several durable regions and, by default, the largest one became the primary event - on a fridge shelf that is the shelf lip (a ~390x50 px strip), so the crop, the VLM and the pickup/return discriminator all looked at the wrong pixels. `rankRegionsForFallback` now orders regions product-shaped first (aspect 0.25-4, both edges >= 24 px), then those intersecting the hand's peak-cell neighbourhood, then nearest to it, then by area. The warning `LOCALIZED_REGION_RANKED` is added whenever the order changed. The strict global path is untouched.

## VLM verifier evidence

The local verifier (`PICKUP_VLM_PROVIDER=local`, Ollama on loopback only) is shown, in this order:

1. The event frames — the selected best pre-event crop, then the peak and post crops.
2. An **enlarged product crop** of the peak instant (the same product-centred region the crop ranking selected; upsampled so its short edge is at least 224 px).
3. **Up to `PICKUP_VLM_REFERENCES_PER_CANDIDATE` reference photos per candidate** (1..4, default 3), grouped per candidate, oldest rows first so a re-run shows the same photos. The ids shown are recorded on the run evidence (`vlm.references[].referenceImageIds`).

The prompt is sized to `PICKUP_VLM_NUM_CTX`: about 768 tokens per image plus a fixed text overhead. When the evidence would not fit, the planner reduces reference photos per candidate first (down to one), then drops the enlarged crop, then event frames from the end — the pre-event crop is always kept. `vlm.imagesSent` and `vlm.referencesPerCandidate` on the evidence record what was actually sent (numbers only).

With three candidates or fewer — the planogram-scoped case — the question is **comparative**: "Which ONE of these N products is being taken in the event images? Compare the product crop against each candidate's reference photos (shape, colour, label). Answer with exactly one SKU from the list, or NONE if none matches." Larger candidate sets keep the open question. The strict JSON schema, the SKU whitelist, the support levels (`STRONG`/`MEDIUM`/`WEAK`/`NONE`) and `parseStrictVerdict` are unchanged; nothing the model writes is persisted except the classified fields.

## Fusion weights (Phase 23)

The fused score is a weighted sum of one best score per signal class, **explicitly uncalibrated** (a ranking value, not a probability). Base table (sums to 1.0):

| Class | Base weight | Identity class |
| --- | --- | --- |
| barcode | 0.30 | yes |
| classical (HSV+NCC) | 0.18 | yes |
| retrieval (embedding index) | 0.18 | yes |
| ocr | 0.12 | yes |
| context (inventory prior) | 0.07 | no |
| planogram (bound rack) | 0.15 | yes |

**Available-signal renormalization.** A shelf camera rarely reads a barcode or text, so a visual-only pickup used to be capped at the sum of the visual weights regardless of how strongly its signals agreed. For each event, classes that produced *no* signal at all are marked unavailable (barcode: no catalog-matched decode; ocr: no text match; classical/retrieval: adapter unavailable or empty index; planogram: no rack bound; context: never unavailable). The remaining base weights are renormalized to sum to 1 and the fused score is multiplied by a **coverage factor**:

```
coverage = sqrt( sum of BASE weights of the available IDENTITY classes )
```

Context never counts toward coverage, so one strong classical match plus "in stock" cannot impersonate corroboration. Worked examples with an in-stock prior of 0.8:

| Signals available | Renormalized sum | Coverage | Fused |
| --- | --- | --- | --- |
| classical 0.95 only | 0.908 | √0.18 = 0.42 | 0.385 (below 0.42) |
| barcode 1.0 only | 0.962 | √0.30 = 0.55 | 0.527 (clears) |
| classical 0.34 + retrieval 0.45 (lab clip, unbound) | 0.460 | √0.36 = 0.60 | 0.276 (below) |
| … + planogram cell 1.0 (lab clip, bound) | 0.601 | √0.51 = 0.71 | 0.429 (clears narrowly) |

The evidence records `fusion.weighting = { available, unavailable, weights, coverage }` and the note `AVAILABLE_SIGNAL_RENORMALIZED` whenever a class was unavailable.

**Planogram signal.** When the clip is bound to an ACTIVE rack (Phase 22), the primary event's centre in the analysis frame is mapped through the asset's rack frame region (blank = the rack fills the frame) into rack coordinates and then to a cell (`planogram.logic.cellFromNormalized`). Candidates assigned to that cell score 1.0 (`planogram:cell(B1)`), candidates elsewhere on the rack 0.6 (`planogram:rack`), everything else 0. Without a usable point (event off the rack, live windows) every rack SKU scores at rack level. The evidence records `planogram = { rackCode, cellCode, candidates }`. The context signal is inventory only; the earlier rack prior inside it was removed so the planogram is never counted twice.