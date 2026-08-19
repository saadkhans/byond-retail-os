# Live Footage Test Protocol (Phase 16)

How to run structured, honest real-footage tests of the BYOND live CV
pipeline. Everything here is **shadow mode**: no checkout sessions, no
orders, no payment intents, no payment events, and no automatic
inventory mutation are ever created from CV — that invariant is
CI-enforced by static shadow-mode guards and shown as the zero-mutation
safety line in every report.

> Never put real secrets, camera URLs, or credential values in
> protocols, notes, tickets, or this document. Notes fields are screened
> and reject sensitive-looking text.

## 1. Start the stack locally

```bash
pnpm install
pnpm run dev:api        # NestJS API (see Windows notes in the repo docs)
pnpm --filter @byond/admin-web dev   # admin web on Vite
```

## 2. Required environment flags

Set these for the API process (names only — values live in your local
env, never in the repo):

| Flag | Purpose |
| --- | --- |
| `CV_LIVE_FAST_MODE` | `true` = skip the reason-refining per-crop OCR passes for live windows. Review-first is unchanged; the VLM stays hard-blocked for live windows either way. |
| `CV_LIVE_PILOT_RUNNER_ENABLED` | `true` = enable the bounded pilot test runner endpoint (off by default). |
| `CAMERA_RTSP_SOURCE_<TENANTID>_<SLOT>` | The per-tenant camera slot. The value may be a credential-free `rtsp://host/path` URL **or a local video file path** for dev testing. Credential-bearing or query-string RTSP URLs are rejected before ffmpeg ever runs. |

File-backed dev sources advance through the video automatically between
samples (seek), so a recorded clip behaves like a moving scene.

## 3. Preflight

Before a test run, check readiness (booleans only — no URLs or
credentials in the response):

```
GET /camera-sources/:id/live-test-preflight?evaluationRunId=<optional>
```

`ready: true` means: source exists, is ACTIVE and RTSP_SHADOW, the env
slot is configured, ffmpeg is available, no live session is already
active, and the pilot runner is enabled.

## 4. Create the test protocol

Admin web → **Test protocols** → create, then:

1. Add the scenario checklist (see the recommended first set below).
2. Create an evaluation run under **Pilot evaluations** and link it to
   the protocol (`Link evaluation run`).
3. Activate the protocol.

## 5. Run live sessions

- Start a session from the camera source page (or run the bounded pilot
  runner endpoint `POST /camera-sources/:id/pilot-test` with
  `maxFrames`/`maxSeconds`).
- Attach each session to the evaluation run from the evaluation page.
- Watch **Live sessions → detail** for status, per-stage timings
  (p50/p95/max), fast-mode badge, and the slowest stage.
- The pilot runner refuses to touch a session it did not create — an
  already-active source returns a controlled conflict.

## 6. Review and correct observations

On the evaluation run page:

- Each live CV observation can be labeled **CORRECT / INCORRECT /
  UNCERTAIN / FALSE_TOUCH / WRONG_SKU / WRONG_ACTION** with the expected
  action/product. Reviews are append-only labels; the original CV event
  is never rewritten.
- Interactions the CV never detected are recorded as **MISSED_EVENT**
  against the session (expected PICKUP or RETURN, optional product).

Then record each protocol scenario as **PASS / FAIL / INCONCLUSIVE** on
the protocol page.

## 7. Read the metrics honestly

The protocol **Validation report** shows:

- scenario pass/fail/inconclusive counts,
- action / SKU / combined accuracy (definitions are documented in code;
  every rate is `null` when its denominator is zero — nothing is ever
  fabricated),
- detection recall = confirmed-or-corrected detections ÷ (those +
  missed events),
- predicted→expected confusion for SKU and action,
- latency (event-to-review, fusion, journey import; p50/p95/max) and the
  slowest stage,
- fast mode expected vs observed,
- the zero-mutation safety line.

## 8. Export the dataset

`Export dataset (JSONL)` on the evaluation page downloads one row per
**operator-confirmed or corrected** observation (CORRECT / WRONG_SKU /
WRONG_ACTION only). Rows carry controlled ids/enums/numbers, the label,
the prediction, confidence, and timing metadata. Live crops have no
stored artifacts yet, so `evidenceStatus` is
`NOT_AVAILABLE_IN_PHASE15` — stated, never faked.

## 9. Recommended first test set

| # | Scenario | Expected |
| --- | --- | --- |
| 1 | Single water bottle pickup | PICKUP of the bottle SKU |
| 2 | Water bottle return | RETURN of the bottle SKU |
| 3 | False touch (hand near shelf, nothing moves) | NO_OP |
| 4 | Two products visible, pick one | PICKUP of the picked SKU only |
| 5 | Similar SKU confusion (two look-alikes, pick one) | PICKUP of the correct SKU |
| 6 | Missed pickup (fast/occluded grab) | record as MISSED_EVENT if undetected |
| 7 | Fast pickup | PICKUP of the SKU |
| 8 | Low-light pickup | PICKUP of the SKU |

**Pass** = the review queue shows the expected action and SKU for the
scenario (review-first: live sessions always land in review — that is
correct behavior, not a failure). **Fail** = wrong/no detection or wrong
SKU/action. **Inconclusive** = setup problems (camera, lighting, feed)
that prevented a fair judgment — fix and re-run.

## 10. Known limitations

- Live windows never invoke the VLM (no pixel-level screen exists for
  live crops yet) — every live observation routes to human review.
- Live crops are not persisted as evidence artifacts yet.
- Percentile latency stats need a handful of windows before they are
  meaningful; single-event sessions show wide numbers.
- One live session per camera source at a time (by design).
- Live-owned journeys never settle `READY_TO_SETTLE_SHADOW` in this
  phase — review-first is the contract.

## Safety reminder

CV proposes; nothing settles. No checkout, order, payment, or inventory
records are created or mutated by any CV path — enforced statically in
CI and reported as structural zeros in every summary.
