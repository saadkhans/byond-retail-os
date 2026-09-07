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
