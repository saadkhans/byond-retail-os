# PR body — VLM event verification, and the labelling plan

Ready-to-paste description for the pull request that carries the
`feat/vlm-event-verification` merge and the labelling handoff. Paste everything below the
line.

---

## Summary

Merges `feat/vlm-event-verification` into the integration branch and adds a handoff document
so the labelling work can be executed on the GPU machine by a session with no prior context.

The headline is a measurement, not a feature: **the local VLM cannot be trusted to label
product identity, and can be trusted to label events.** The rest follows from that.

## Why

Measured across 192 `PickupFusionRun` rows over 43 clips (`qwen2.5vl:7b`):

```
verdict:  MATCH 116 · AMBIGUOUS 5 · UNKNOWN 4 · MISMATCH 0
latency:  median 60 s · max 161 s
```

The model has **never once returned `MISMATCH`**. On the 101 `MATCH` runs whose clip carries
a human label, its SKU was correct 81 times and wrong 20 — against 83 for the fusion pipeline
on the same clips. So as an identity teacher it is a slightly worse peer, not a teacher.

Worse, the errors are not spread out. All 20 are one confusion:

```
WATER-BOTTLE-500ML -> SKU-LIME-GREEN   x20   (100% of errors)
```

and it stamps every one `MATCH`. Auto-labelling identity today would produce a dataset where
every water bottle is confidently labelled a Nescafé can, and train that error in permanently.

Asked instead to **count units before and after** the hand motion — a checkable task whose
answer the strict parser can cross-check against its own numbers — the same model scores
**26/27 against ground truth**, with every false touch answered `NONE`. That is the difference
between a judgment question and a verifiable one, and it is why this PR treats the two tasks
differently.

## What changes

**Merged from `feat/vlm-event-verification`:**

- `verifyEvent()` as an **optional** port method — a verifier that does not implement it
  reports `NOT_RUN` and the pipeline behaves exactly as before, so this is inert for the cloud
  provider and every stub.
- Self-consistency rejection: a reply whose `change` word contradicts its own before/after
  counts is `INVALID_SCHEMA` rather than trusted.
- Describe-then-choose prompting — the model commits to what it sees before seeing the
  candidate list, "so a clear plastic bottle is not talked into being a coloured can by a
  stronger-looking reference photo".
- `vlmDisagreementYieldsToFusion`: when fusion was confident and the VLM picks a different SKU
  without STRONG visual support, fusion's answer stands and the clip goes to review.
- Reference ordering by largest-file-first — the branch notes *"a 4 KB crop was the water
  reference"*, which is directly upstream of the 20 errors above.
- `scripts/replay-fusion.ts`, exposed as `pnpm --filter @byond/api fusion:replay`.

**New:** `docs/cv/vlm-labelling-handoff.md` — self-contained execution instructions covering
data migration, environment setup, the four remaining stages, the guardrails, and the SQL that
reproduces every number quoted here.

**Behaviour change on merge: none.** `PICKUP_VLM_EVENT_CHECK` defaults to **false**. Turning it
on costs roughly one extra 15 s local inference per event.

## Conflicts resolved

Two, both unions:
- `services/api/package.json` — kept both `prisma:migrate-deploy` and `fusion:replay`.
- `services/api/.env.example` — kept the regenerated key set, added
  `PICKUP_VLM_EVENT_CHECK` and `PICKUP_VLM_EVENT_CHECK_TIMEOUT_MS`, dropped a duplicated
  `PICKUP_VLM_MODE` line. The env-example drift guard passes.

## What this deliberately does not do

- **No machine writes to `VideoGroundTruth`.** That table is an in-place `upsert` with no
  provenance field, no history and no append-only trigger, so a machine row would silently
  overwrite an operator's label. Machine proposals belong in `PilotObservationReview`, which
  is genuinely append-only and already models "an operator label over one CV observation".
- **No detector fine-tuning.** There are no bounding boxes anywhere in the ground-truth data,
  `ml/configs/dataset.schema.json` has no `bbox` field with `additionalProperties: false`, and
  `ml/README.md` states there is no training loop. That is a separate, much larger project.
- **No identity auto-labelling** until it beats the fusion pipeline on held-out clips.

## Verification

```
lint        clean (5 pre-existing react-hooks warnings in admin-web, untouched)
typecheck   clean
api tests   203 suites / 5002 tests  (4959 before the merge; +43 from the branch)
build       clean
```

Shadow safety unchanged: CV still only proposes. `scripts/fusion-shadow-run.ts` prints
before/after counts of orders, payment intents, checkout sessions and inventory movements —
all four deltas remain zero.

## Reviewer note

The one number worth watching is the water→Nescafé confusion count, currently **20**. The SQL
that produces it is in §7 of the handoff doc. Driving it down — by fixing the reference
library, not by changing the model — is the point of the follow-up work.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
