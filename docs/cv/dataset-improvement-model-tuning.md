# BYOND CV — Dataset Improvement & Model Tuning (Phase 18)

> **Never put real secrets, camera URLs, credential values, or file
> paths in this document, in run names, in notes, or anywhere else in
> the calibration/dataset workflow.** The API rejects such text on
> write, and this document deliberately contains none of it.

Phase 18 turns the reviewed and corrected pilot data you produced in
Phases 15–17 into **training-ready metadata**: candidate lists, an
honest quality report, a deterministic split plan, a safe export
manifest for offline tuning, and an advisory model-tuning report.

It is planning and packaging only. Nothing in Phase 18 trains a model,
calls an external model API, changes CV behavior, or touches checkout,
orders, payments, settlement, or inventory.

## 1. What a dataset improvement run is

A run is a tenant-scoped workspace that links (optionally):

- one Phase 15 **evaluation run** (reviewed live observations),
- one Phase 16 **test protocol** (scenario results),
- one Phase 17 **calibration profile** (safe setup metadata).

It carries the split percentages (train, validation, test — must sum to
100), minimum reviewed-example thresholds per SKU and per action, and a
purpose (SKU classification, action recognition, false-touch filtering,
missed-event recovery, calibration validation, or mixed).

Run lifecycle: `DRAFT` (editable) → `READY` (minimum reviewed data
exists) → `EXPORTED` (manifest generated) and `ARCHIVED` (terminal).

## 2. How reviewed data becomes training-ready metadata

Refreshing candidates reads the linked sources and builds a ledger of
**references** — never media. Each candidate points at an existing
record (a pilot review, a missed-event review, or a protocol scenario)
and snapshots the label enums and SKU codes.

Verdict mapping:

| Source record                     | Eligibility | Label                                      |
| --------------------------------- | ----------- | ------------------------------------------ |
| Review verdict CORRECT            | ELIGIBLE    | The confirmed prediction                   |
| Review verdict WRONG_SKU          | ELIGIBLE    | The corrected SKU                          |
| Review verdict WRONG_ACTION       | ELIGIBLE    | The corrected action                       |
| Review verdict FALSE_TOUCH        | ELIGIBLE    | Corrected to NO_OP (a reviewed *negative*) |
| Missed-event review               | ELIGIBLE    | The expected action/SKU (recall evidence)  |
| Scenario result PASS or FAIL      | ELIGIBLE    | The scenario's expected action/SKU         |
| Unreviewed observation            | EXCLUDED    | reason NOT_REVIEWED                        |
| Review verdict UNCERTAIN          | EXCLUDED    | reason UNCERTAIN_VERDICT                   |
| Review verdict INCORRECT          | EXCLUDED    | reason INCORRECT_VERDICT                   |
| Scenario result INCONCLUSIVE      | EXCLUDED    | reason INCONCLUSIVE_RESULT                 |
| Scenario without a result         | EXCLUDED    | reason MISSING_RESULT                      |

**Why unreviewed examples are excluded:** an unreviewed prediction is
not a label — training on it would teach the model its own mistakes.
UNCERTAIN and INCONCLUSIVE records carry no usable truth either. They
stay visible in the excluded list (honest accounting), never in the
export.

Lighting and occlusion buckets and per-zone labels exist in the schema
but are always empty in this phase: no source data exists for them yet,
and BYOND never fabricates values.

## 3. The quality report

`GET` the run's `quality-report` to see, computed only from real data:

- eligible and excluded totals, and breakdowns by SKU, action, scenario
  type, source type, and calibration profile;
- missed-event and false-touch counts;
- confusion pairs, passed through verbatim from the Phase 15 summary
  (null when no evaluation run is linked);
- low-coverage SKUs/actions (below your configured minimums);
- controlled imbalance warnings (`SKU_IMBALANCE`, `ACTION_IMBALANCE`)
  and leakage warnings (`SPLITS_NOT_PLANNED`,
  `SAME_SESSION_ACROSS_SPLITS`);
- a readiness verdict — `NOT_READY` (no eligible data), `WARNING`
  (usable but flawed), `READY` — plus controlled next actions.

Read it honestly: a small dataset with warnings is a small dataset with
warnings. The report never invents metrics; anything unknown is null or
zero.

## 4. How splits work

`plan-splits` assigns every eligible candidate to TRAIN, VALIDATION, or
TEST:

- **Deterministic.** The assignment hashes the tenant, run, and group
  key with sha256 — replanning the same data yields the same splits on
  any machine.
- **Same session stays together.** All candidates from one live session
  share one group, so near-identical frames can never sit on both sides
  of a train/test boundary (leakage guard).
- **Low coverage is forced into TRAIN.** A SKU or action below your
  minimum cannot support a meaningful test set; its groups all go to
  TRAIN and you get `LOW_COVERAGE_SKU_FORCED_TRAIN` /
  `LOW_COVERAGE_ACTION_FORCED_TRAIN` warnings instead of a pretend
  metric. Fewer than 30 eligible examples adds `SMALL_DATASET`.
- **HOLDOUT is never auto-assigned** in this phase; the value is
  reserved for operator-managed holdout plans.

Planning updates only the run's own candidate rows. The original
reviews, scenarios, journeys, and calibration records are never
mutated.

## 5. The export manifest

Once the run is `READY` and splits are planned, `export-manifest`
returns a single safe JSON document and stamps the run `EXPORTED`:

- run metadata, split percentages, and split summary;
- every eligible candidate (references + label snapshots, ordered by
  split);
- distinct SKU snapshots and action labels;
- a safe calibration snapshot (orientation, mount, zone counts) when a
  profile is linked;
- the quality warnings at export time;
- fixed training notes: reviewed/corrected labels only, references
  only, offline training only, no accuracy guarantee.

Use it offline: join the candidate references against your separately
managed footage/evidence store by ID. The manifest itself contains **no
media** — every row says `REFERENCES_ONLY_NO_MEDIA_IN_PHASE18`.

Intentionally **not** in the manifest: raw frames, crops, video,
embeddings, model weights, stream URLs, credential slots, local paths,
customer identity, or payment/order data.

## 6. The model tuning report

The `model-tuning-report` is **advisory only**. It maps the run's
purpose to a recommended model task, mirrors the dataset readiness,
summarizes class coverage, lists the top likely confusion pairs from
real review data, and suggests a collection plan, evaluation metrics,
and a threshold review — all as controlled enum strings.

It never invokes training, never calls an external model API, and never
projects an accuracy number. If a report ever appears to promise an
improvement percentage, that is a bug — file it.

## 7. Recommended workflow

1. Finish a Phase 16 protocol with a linked Phase 15 evaluation run;
   review every observation and label missed events.
2. Create a dataset improvement run linking the evaluation run, the
   protocol, and the camera's calibration profile.
3. Refresh candidates; read the quality report; fix what it flags
   (review pending events, add missed-event labels, balance coverage).
4. Plan splits; re-read the report — leakage warnings should be gone.
5. Mark the run READY, export the manifest, and hand it to the offline
   training owner.
6. After tuning offline, validate with a fresh Phase 16 protocol before
   trusting anything.

## 8. Known limitations

- Candidates reference records, not evidence artifacts — live windows
  still persist no crops, so offline training needs your own footage
  handling.
- Lighting/occlusion buckets and zone labels are placeholders (always
  empty) until a later phase produces safe source data.
- Confusion pairs exist only when an evaluation run is linked.
- The split planner does not stratify by class; it balances by volume
  and blocks leakage only.
- One evaluation run, one protocol, and one calibration profile per
  dataset run in this phase.

## Safety reminder

Dataset improvement is shadow-only planning. It cannot create checkout
sessions, orders, payment intents, or payment events; it cannot settle
a basket or mutate inventory; and it cannot store or return stream
URLs, credential slots, file paths, raw frames, raw crops, raw video,
or model weights. Live CV stays shadow-only and review-first
throughout.
