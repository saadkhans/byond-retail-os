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

**Editing invalidates stale plans.** Changing a DRAFT run's split
percentages, coverage minimums, or purpose atomically clears any
existing split assignments — the response says
`CV_DATASET_SPLITS_REQUIRE_REPLAN` and export refuses
(`CV_DATASET_EXPORT_REQUIRES_PLANNED_SPLITS`) until you re-plan.
Changing a source link discards the candidate ledger entirely
(`CV_DATASET_CANDIDATES_REQUIRE_REFRESH`): candidates describe the old
source family and must be rebuilt. A manifest can therefore never
advertise new percentages over assignments planned for old ones.
`EXPORTED` and `ARCHIVED` runs reject configuration changes outright.

## 2. How reviewed data becomes training-ready metadata

Refreshing candidates reads the linked sources and builds a ledger of
**references** — never media. Each candidate points at an existing
record (a pilot review, a missed-event review, or a protocol scenario)
and snapshots the label enums and SKU codes.

Verdict mapping:

| Source record                       | Eligibility | Label                                      |
| ----------------------------------- | ----------- | ------------------------------------------ |
| Review verdict CORRECT              | ELIGIBLE    | The confirmed prediction                   |
| Review verdict WRONG_SKU (real fix) | ELIGIBLE    | The corrected SKU                          |
| WRONG_SKU without a corrected SKU   | EXCLUDED    | reason MISSING_CORRECTED_SKU               |
| WRONG_SKU "corrected" to same SKU   | EXCLUDED    | reason CORRECTION_NOT_DIFFERENT            |
| Review verdict WRONG_ACTION (real)  | ELIGIBLE    | The corrected action                       |
| WRONG_ACTION corrected to UNKNOWN   | EXCLUDED    | reason MISSING_CORRECTED_ACTION            |
| WRONG_ACTION same as prediction     | EXCLUDED    | reason CORRECTION_NOT_DIFFERENT            |
| Review verdict FALSE_TOUCH          | ELIGIBLE    | Corrected to NO_OP (a reviewed *negative*) |
| Missed-event review                 | EXCLUDED    | reason MISSING_EVIDENCE_LOCATOR            |
| Scenario result PASS or FAIL        | ELIGIBLE    | The scenario's expected action/SKU         |
| Unreviewed observation              | EXCLUDED    | reason NOT_REVIEWED                        |
| Review verdict UNCERTAIN            | EXCLUDED    | reason UNCERTAIN_VERDICT                   |
| Review verdict INCORRECT            | EXCLUDED    | reason INCORRECT_VERDICT                   |
| Scenario result INCONCLUSIVE        | EXCLUDED    | reason INCONCLUSIVE_RESULT                 |
| Scenario without a result           | EXCLUDED    | reason MISSING_RESULT                      |

**Why unreviewed examples are excluded:** an unreviewed prediction is
not a label — training on it would teach the model its own mistakes.
UNCERTAIN and INCONCLUSIVE records carry no usable truth either. They
stay visible in the excluded list (honest accounting), never in the
export.

**Why a correction must be a real correction:** WRONG_SKU means "the
SKU was something else" — a row without a corrected SKU, or one whose
"correction" repeats the prediction, carries no trainable truth, so it
is excluded with a controlled reason instead of polluting the labels.
Product-ID equality is canonical: when both the predicted and the
corrected product ids are known, the same id is `CORRECTION_NOT_DIFFERENT`
even if the SKU code snapshots differ or one of them is missing — SKU
text comparison is only the fallback when the ids are not both known.

**False-touch SKUs are not SKU labels:** a FALSE_TOUCH row is a
reviewed NO_OP *negative* — the reviewer confirmed nothing was taken,
not the predicted SKU's identity. The predicted SKU stays on the
candidate as reference metadata, but it never counts as a SKU class:
not for SKU-classification readiness, not in the tuning report's class
counts, and not in the manifest's label list.

**Why missed events are excluded (missing locators):** a missed-event
review names a session and a label, but Phase 15 records no safe
temporal locator (offset, window, or frame index) for the interaction —
the review timestamp is when the operator wrote it, not when the event
happened. An offline trainer could never map such a row to footage, so
it is excluded as MISSING_EVIDENCE_LOCATOR rather than exported as an
untraceable label. Missed events still count in the quality report as
recall evidence and next-action input.

**Lineage and calibration integrity:** if a run links both an
evaluation run and a protocol, the protocol must be bound to that same
evaluation run; protocol-only runs stamp the protocol's own evaluation
lineage on scenario candidates. A linked calibration profile must
belong to the camera the live sessions actually used, or the refresh is
rejected. FILE_REPLAY sources are exempt — calibration is not
applicable to them, they are never stamped, and the workflow never
advises calibrating them.

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
- low-coverage SKUs/actions, each with its raw example count AND its
  independent-group count. **Minimum class coverage is measured in
  independent groups, not raw rows**: many near-duplicate examples from
  one live session are ONE unit of evidence, so 30 rows from two
  sessions never satisfy a minimum of five
  (`INSUFFICIENT_CLASS_GROUP_COVERAGE`), and
  `LOW_INDEPENDENT_GROUP_COVERAGE` flags classes whose examples all
  come from a single session. Raw counts are still shown, but they are
  never the readiness basis;
- controlled imbalance warnings (`SKU_IMBALANCE`, `ACTION_IMBALANCE`,
  `SMALL_DATASET` — durable, not a one-off planner note — and the
  task-label warnings `NO_SKU_LABELS_FOR_TASK`,
  `NO_ACTION_LABELS_FOR_TASK`, `INSUFFICIENT_TASK_LABELS`) and leakage
  warnings (`SPLITS_NOT_PLANNED`, `SAME_SESSION_ACROSS_SPLITS`,
  `REQUESTED_VALIDATION_SPLIT_EMPTY`, `REQUESTED_TEST_SPLIT_EMPTY`,
  `CLASS_MISSING_TRAIN_SPLIT`, `INSUFFICIENT_STABLE_SPLIT_COVERAGE`);
- a readiness verdict — `NOT_READY` (no eligible data, no usable labels
  for the run's PURPOSE, a requested split ended up empty, or a
  trainable class has no TRAIN examples), `WARNING` (usable but
  flawed), `READY` — plus controlled next actions.

Readiness is **purpose-aware**: a SKU-classification run with zero
SKU-labeled examples is `NOT_READY` no matter how many action labels it
has, and the tuning report will not recommend a task the dataset cannot
support.

Read it honestly: a small dataset with warnings is a small dataset with
warnings. The report never invents metrics; anything unknown is null or
zero.

## 4. How splits work

`plan-splits` assigns every eligible candidate to TRAIN, VALIDATION, or
TEST:

- **Deterministic AND stable across runs.** The assignment hashes the
  tenant and the group identity with sha256 — deliberately WITHOUT the
  dataset-run id — so the same reviewed session keeps the same split in
  every dataset improvement run and every replan. Evaluation data can
  never drift into TRAIN between iterations.
- **Same session stays together.** All candidates from one live session
  share one group, so near-identical frames can never sit on both sides
  of a train/test boundary (leakage guard).
- **The stable assignment is never overridden.** Earlier drafts forced
  low-coverage classes into TRAIN per run — but a rule that depends on
  THIS run's composition moves the same group between splits across
  runs (split drift, and evaluation data leaking into TRAIN as the
  dataset grows). The planner now only warns: a class the stable hash
  left without TRAIN examples gets `CLASS_MISSING_TRAIN_SPLIT` and
  `INSUFFICIENT_STABLE_SPLIT_COVERAGE`, readiness drops to `NOT_READY`,
  and export refuses — collect more independent sessions or adjust the
  percentages instead of silently rearranging groups. Fewer than 30
  eligible examples adds `SMALL_DATASET`, which persists into the
  quality report, the tuning report, and the export manifest.
- **Requested splits must exist.** If your percentages request a
  validation or test split and the planner cannot fill it, you get
  `REQUESTED_VALIDATION_SPLIT_EMPTY` / `REQUESTED_TEST_SPLIT_EMPTY`,
  readiness drops to `NOT_READY`, and export refuses — either collect
  more independent groups or explicitly configure 100/0/0.
- **HOLDOUT is never auto-assigned** in this phase; the value is
  reserved for operator-managed holdout plans.

Planning updates only the run's own candidate rows. The original
reviews, scenarios, journeys, and calibration records are never
mutated.

## 5. The export manifest

Once the run is `READY` and splits are planned, `export-manifest`
returns a single safe JSON document and stamps the run `EXPORTED`. The
whole export is atomic under the run's lock: the run status, the
candidate rows, a **re-validation against the CURRENT source records**,
the purpose-aware label check, and the split completeness check all
happen against one locked snapshot, and the manifest you receive is
built from exactly that snapshot. The freshness check compares labels
AND evidence lineage — verdicts, corrected labels, SKU snapshots, the
live session, the evaluation-run and protocol lineage, and the
calibration stamp. A scenario re-recorded with the same verdict against
a different session, or a calibration stamp that no longer matches the
cameras, is just as stale as a flipped verdict: export refuses with
`CV_DATASET_STALE_CANDIDATES` — refresh candidates and re-plan splits,
then export again. Once `EXPORTED`, the run is frozen: candidate
refresh and split planning are rejected so the stored rows keep
describing the manifest that was handed out (archive the run and create
a new one to iterate).

The manifest contains:

- run metadata, split percentages, and split summary;
- every eligible candidate (references + label snapshots, ordered by
  split);
- distinct SKU snapshots and action labels;
- a safe calibration snapshot (orientation, mount, zone counts) — only
  when the linked profile matches the camera the footage actually came
  from (FILE_REPLAY candidates are never stamped);
- the quality warnings at export time (including `SMALL_DATASET` and
  the split-completeness warnings);
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
purpose to a recommended model task — falling back to a task the
dataset actually has labels for, never recommending one with zero
usable labels — mirrors the dataset readiness, restates the durable
dataset warnings, summarizes class coverage, lists the top likely
confusion pairs from real review data, and suggests a collection plan,
evaluation metrics, and a threshold review — all as controlled enum
strings.

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
- Missed-event reviews carry no safe temporal locator yet, so they are
  excluded from training eligibility (`MISSING_EVIDENCE_LOCATOR`) and
  the MISSED_EVENT_RECOVERY purpose stays `NOT_READY` until a later
  phase records one.
- Lighting/occlusion buckets and zone labels are placeholders (always
  empty) until a later phase produces safe source data.
- Confusion pairs exist only when an evaluation run is linked.
- The split planner does not stratify by class; it balances by volume,
  blocks leakage, and keeps assignments stable — a class the stable
  hash cannot cover blocks the run rather than being rearranged.
- One evaluation run, one protocol, and one calibration profile per
  dataset run in this phase.

## Safety reminder

Dataset improvement is shadow-only planning. It cannot create checkout
sessions, orders, payment intents, or payment events; it cannot settle
a basket or mutate inventory; and it cannot store or return stream
URLs, credential slots, file paths, raw frames, raw crops, raw video,
or model weights. Live CV stays shadow-only and review-first
throughout.
