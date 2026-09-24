# The CV pipeline service

`services/cv-pipeline` is the edge half of the three-tier inference design in
[ARCHITECTURE.md](../../ARCHITECTURE.md). It watches one camera, decides which
moments are worth a heavy model, and asks the API to create an inference job for
each one. It never decides what a product is, and it never touches a basket.

## Where the tiers live

| Tier | What it does | Where it runs |
| --- | --- | --- |
| 1 — tracking | Continuous, cheap, on a downscaled stream. Produces motion regions, coarse presence and per-zone occupancy. | This service |
| 2 — trigger | Turns tracking metadata into candidate moments, debounced and rate-limited, and creates inference jobs. | This service |
| 3 — recognition | Product identity on high-resolution crops: detection, retrieval, OCR, the VLM verifier, fusion, review. | The API |

The split matters because tier 1 runs on every frame forever and tier 3 costs
tens of seconds per call. Everything this service does is in service of not
calling tier 3.

## What it produces

One moment becomes one inference job through the API's existing contract
(`POST /inference/jobs`). Three kinds exist, and the set is closed:

- **`HAND_IN_ZONE`** — sustained motion inside a configured shelf zone. Becomes a
  `PRODUCT_RECOGNITION` job.
- **`SHELF_CHANGE`** — whole-frame change that no single zone explains. Becomes a
  `SHELF_AUDIT` job.
- **`CUSTOMER_EXIT`** — the scene was active and has now been quiet long enough
  that whoever was there has gone. Becomes an `EXIT_RECONCILIATION` job, at a
  higher priority than the other two because somebody is waiting at a door.

The job descriptor carries numbers and opaque ids only: frame indices,
timestamps, a zone code, peak motion and coverage ratios, a frame count, and the
run id. No crop, no frame, no path, no camera address. The API screens every
descriptor it receives; this service screens on the way out as well, and a
descriptor that fails the screen is **dropped and counted**, not sanitised.

## The two rules that keep the queue survivable

**Debounce.** A shopper standing with a hand in a zone is one moment, not one per
frame. A zone that has emitted stays quiet until it has been still for
`CV_PIPELINE_TRIGGER_REARM_QUIET_MS`. A moment that never ends is emitted once
anyway, at `CV_PIPELINE_TRIGGER_MAX_DURATION_MS`, so a permanently busy aisle
still produces work.

**Rate limit.** A token bucket over a sliding window caps emissions across all
zones. Suppressed moments are counted by reason, never silently dropped —
`triggersEmitted` alone cannot distinguish an empty aisle from a camera whose
every trigger is being discarded, so the metrics report both.

## Backpressure

The queue between tier 2 and the API is bounded. At capacity the **oldest**
pending submission is dropped: a minute-old moment is worth less than the one
happening now, and refusing new work would mean the store stops being observed
exactly when it gets busy. Drops are counted.

Retries are only for weather. A connection failure or a timeout backs off
exponentially; a rejected descriptor or an authorization failure is dropped on
the first answer, because the same request will get the same answer and retrying
turns one bug into sustained load against an endpoint that is already saying no.

## Ports and adapters

Everything swappable is behind an interface this repository owns, as AGENTS.md
requires.

| Port | Adapters |
| --- | --- |
| `FrameSourcePort` | `SimulatedFrameSource` (default — synthesises frames, so CI needs no camera and no ffmpeg) and `FfmpegFrameSource` (one ffmpeg invocation per frame, argument vectors only) |
| `TrackerPort` | `SimulatedTracker` (deterministic, pattern from the frame index) and `MotionTracker` (frame difference over a coarse grid) |
| `InferenceClientPort` | `HttpInferenceClient` against the API's job route |

A model-backed tracker slots in behind `TrackerPort` using the same Python-worker
pattern the API already uses for local detection and embedding. Nothing in the
trigger layer would change.

## Source secrecy

The camera address is configured **by the name of the environment variable that
holds it**, not directly. It is read once, handed straight into the frame
source's private field, and never returned, thrown, logged, interpolated into a
message, or persisted — the same contract the API's RTSP sampler keeps, for the
same reason. Callers get a controlled code from a closed list and nothing else.

Only credential-free sources are supported: a scheme-shaped value must be scheme,
host and path, with no userinfo, no query string and no fragment, checked before
any process is spawned. The address lands in `argv`, which is visible to process
listings, so escaping is not a defence and there is no shell to escape for. A
camera that needs a credential is out of scope until a transport exists that
keeps it off the command line.

## Operating it

```bash
cd services/cv-pipeline
cp .env.example .env     # set CV_PIPELINE_API_TOKEN and the zones
pnpm run start
```

It binds to loopback. It holds an API token and watches a camera, so a deployment
that wants it reachable puts a reverse proxy in front and makes that an explicit
decision.

- `GET /health` — liveness and whether the tracking loop is running.
- `GET /metrics` — frames sampled and failed, observations, triggers emitted by
  kind, suppressions by reason, frame errors by code, descriptors blocked by the
  media policy, and the queue's counters. Numbers and closed-vocabulary codes
  only.

## Known limitations

- **The tracker is a proxy, not a detector.** "Person likely" is whole-frame
  motion; "hand likely" is a compact motion region over a zone. Neither detects a
  person or a hand. They are named after what they are used for, and the trigger
  layer treats them as weak evidence that a moment deserves a heavy look — which
  is the only decision they feed.
- **One camera per process.** Multi-camera deployment is one process per camera.
- **Zones are configuration, not discovery.** Zone geometry is an operator
  decision; the service does not infer shelf layout from pixels, and the zone
  codes are opaque strings it never interprets.
- **Frames are never stored.** There is no recording path and no evidence upload;
  tier 3 fetches its own high-resolution pixels through the API.
- **The trigger thresholds are uncalibrated.** The defaults are starting points,
  not tuned values, and they belong to the same calibration work as the rest of
  the accuracy roadmap.
