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
| 1. Upload | operator | `POST /video-assets` with the clip, the four attestations, `locationId` **\***, `unitId` **\*** (pre-selected when the store has one unit), `planogramRackCode` **\*** and optionally `rackFrameRegion`. The rack must be an ACTIVE planogram rack at that store — validated **before any byte is stored** (400 otherwise). |
| 2. Approve screening | operator (human) | Inspect real quarantine frames and approve. Clip Lab never approves on the operator's behalf; a QUARANTINED clip reports `SCREENING · BLOCKED (SCREENING_APPROVAL_REQUIRED)`. |
| 3. Run full analysis | one click | `POST /video-assets/:id/lab-run` runs validate → classical v1 detection → fusion v2 → pretrained evaluation, all with the binding stored on the asset. A v1 `NO_MOTION_EVENT` is recorded and the run continues (fusion v2 has its own fallback). |
| 4. Result | page | Stepper, advisory suggestion (SKU · action · *Still needs review*), planogram cell with provenance, top-5 candidates with the "scoped to planogram" badge and the excluded count, and a "why" list of operator labels. `GET /video-assets/:id/lab-report` rebuilds the same shape from stored results. Below the result, a **confidence summary** table shows each stage's own 0..1 signal as a percentage: classical detection score, local detector top detection (with product-frame coverage), fused top candidate (with the margin to #2 in points), planogram cell confidence, the VLM verdict in words, and *Overall*, which is always the review gate — never a number. **These percentages are uncalibrated ranking signals, not probabilities**, until the calibration phase of the accuracy roadmap. |

Mandatory fields on the page are marked with `*`; the upload button stays
disabled until they are complete. The rack region is optional: leave it
blank when the rack fills the frame (frame it tightly), otherwise enter
the normalized rectangle `x, y, width, height` in 0..1.

## Why the unit is mandatory

Classical v1 detection records a pickup **event** and needs both a store
and a retail unit on the clip; without a unit it fails with
`MISSING_LOCATION_CONTEXT`. Clip Lab therefore binds the unit at upload
(`unitId` **\***, pre-selected when the store has exactly one unit). A
clip uploaded elsewhere without a unit shows a warning on the Run step
with a *Bind unit* control; until then the run records
`DETECTION · SKIPPED (MISSING_UNIT_BINDING)` and continues with fusion v2
and the pretrained stage.

## Binding after upload

`PATCH /video-assets/:id/binding` (`vision:review`) sets or changes
`locationId`, `unitId`, `planogramRackCode`, and `rackFrameRegion` with the
same validation (a unit must belong to the effective store of the same
tenant; a device- or session-bound clip keeps its derived unit). The store of a clip bound to a unit, device, or session is
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

## Batch upload (a folder of named clips)

The **Batch upload** tab uploads a whole folder with the one-time inputs entered once:
store, unit, rack (optional rack region) and the four operator attestations. Every server
gate is unchanged — the batch is a client-side, one-at-a-time loop over the same single-file
upload, the attestations are recorded with every clip, each clip still needs a human
screening decision on real frames, and ground truth is saved only when you save it.

Name files as `r1_<cell>_<sku>_<type>_<light>_<n>.mp4`:

| token | values |
| --- | --- |
| cell | `a1`, `a2`, `b1`, `b2`, `rack` |
| sku | a catalog token (`water`, `nescafe`) or `none` — mapped to a product in the aliases panel |
| type | `pickup`, `return`, `touch`, `wrongcell`, `double`, `nothing` |
| light | `room`, `fridge` |
| n | `01`, `02`, … |

Ground truth is pre-filled from the name (pickup → PICKUP / PICKUP_SINGLE; return → RETURN /
RETURN_SINGLE; touch → NONE / FALSE_TOUCH; wrongcell and double → PICKUP / PICKUP_SINGLE with
a note; nothing → NONE), timestamp 4500 ms by default, note `cell=… light=… type=… sku=…`.
Names that do not parse still upload and are flagged "name not understood".

Flow: settings → pick folder/files or drop them → Upload all (pause, resume, cancel, per-file
retry) → Screening review grid (Load frames for all, Approve / Reject per card, "Approve all
previewed" only for cards whose frames were shown; previews older than 25 minutes are shown
again first) → Ground truth table (confirm, Save all) → Run all (sequential lab-runs) → summary
with agreement per clip (match, wrong SKU, wrong action, no suggestion, no ground truth).

Resume: after a refresh, pick the store and press "Check already uploaded" — clips already at
the store are matched by file name and skipped by Upload all; re-pick the folder only for the
files still queued. If the session expires mid-batch the runner pauses and an inline sign-in
resumes it in place.

### Lenient file names (batch 1 as filmed)

The light token is optional: `r1_<cell>_<sku>_<type>_<n>.mov` parses with light `unspecified`. Type synonyms are accepted and mapped: `falsetouch`/`false`/`nudge` → touch; `pick`/`grab`/`take` → pickup; `put`/`putback` → return; `wrong`/`misplaced` → wrongcell; `two`/`second` → double; `none`/`empty`/`idle` → nothing. Tokens may be separated by `_`, `-` or spaces; case does not matter. A name is only "not understood" when it has fewer than 5 or more than 6 tokens, an unknown cell, an unknown type word, or (with 6 tokens) a light other than room/fridge.
