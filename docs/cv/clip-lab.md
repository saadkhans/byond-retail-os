# Clip Lab (Phase 22) — one place to test a clip against its planogram

Clip Lab answers two operator complaints from the first fridge tests:

- *"Why is it comparing against every SKU?"* — because nothing told the
  fusion stage which rack the clip shows. Phase 22 binds the **store and
  rack at upload**, and fusion v2 scopes its candidates to that rack.
- *"Make testing easier, everything in one place, mandatory fields
  marked."* — the **Clip Lab** page (`/clip-lab`) runs the whole flow with
  one button and shows one result.

Everything Clip Lab does is **shadow-only and review-required**: it
orchestrates the existing stages and reads their results. It writes no
table of its own and never touches checkout, orders, payments, or
inventory (pinned by `services/api/src/clip-lab/shadow-mode.spec.ts`).

## The flow

| Step | Who | What happens |
| --- | --- | --- |
| 1. Upload | operator | `POST /video-assets` with the clip, the four attestations, `locationId` **\***, `planogramRackCode` **\*** and optionally `rackFrameRegion`. The rack must be an ACTIVE planogram rack at that store — validated **before any byte is stored** (400 otherwise). |
| 2. Approve screening | operator (human) | Inspect real quarantine frames and approve. Clip Lab never approves on the operator's behalf; a QUARANTINED clip reports `SCREENING · BLOCKED (SCREENING_APPROVAL_REQUIRED)`. |
| 3. Run full analysis | one click | `POST /video-assets/:id/lab-run` runs validate → classical v1 detection → fusion v2 → pretrained evaluation, all with the binding stored on the asset. A v1 `NO_MOTION_EVENT` is recorded and the run continues (fusion v2 has its own fallback). |
| 4. Result | page | Stepper, advisory suggestion (SKU · action · *Still needs review*), planogram cell with provenance, top-5 candidates with the "scoped to planogram" badge and the excluded count, and a "why" list of operator labels. `GET /video-assets/:id/lab-report` rebuilds the same shape from stored results. |

Mandatory fields on the page are marked with `*`; the upload button stays
disabled until they are complete. The rack region is optional: leave it
blank when the rack fills the frame (frame it tightly), otherwise enter
the normalized rectangle `x, y, width, height` in 0..1.

## Binding after upload

`PATCH /video-assets/:id/binding` (`vision:review`) sets or changes
`locationId`, `planogramRackCode`, and `rackFrameRegion` with the same
validation. The store of a clip bound to a unit, device, or session is
derived from that binding and cannot be changed here. Every change is
audited.

## What "scoped to planogram" means

When the asset is bound to an ACTIVE rack, fusion v2 ranks **only**:

- the SKUs assigned to that rack (all cells), plus
- any product a barcode or OCR hit named, plus
- the classical HSV top-1 (so a misplaced product can still surface — the
  planogram stage flags it as *Possible misplaced product*).

Every other ACTIVE product is excluded before fusion, so it never reaches
the top-10 or the VLM. The run records `planogramScope` (rack code,
version, scoped and excluded **counts**) and the note
`PLANOGRAM_SCOPED_CANDIDATES`. Rack SKUs receive a context prior equal to
the in-stock boost (0.8) — never more — so the planogram stays a SOFT
prior. An unbound clip behaves exactly as before Phase 22.

The pretrained evaluation reads the binding too: with an empty request the
rack and region come from the asset (`planogram.bindingSource: ASSET`);
explicit request values still win (`REQUEST`).

## Limits and honest notes

- The classical v1 detector (`pickup-classical-v1`) is unchanged and may
  still report `NO_MOTION_EVENT` on noisy footage; fusion v2's localized
  fallback and the pretrained detector carry the run.
- The VLM's candidate set is whatever the scoped fusion ranked — a
  transparent bottle can still come back `UNKNOWN`.
- Screening remains a separate, audited human decision by design.
- The rack region is stored per clip; camera calibration zones are not
  consulted yet.
