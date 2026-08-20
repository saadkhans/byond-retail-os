# Camera Calibration & Pilot Hardening (Phase 17)

How to make a camera source ready for trustworthy live CV testing:
calibration profiles, shelf/interaction/ignore zones, readiness checks,
and the pilot hardening report. Everything here is **shadow mode**:
calibration never creates checkout sessions, orders, payment intents,
payment events, or inventory mutations — that invariant is CI-enforced
by static shadow-mode guards and shown as the zero-mutation safety line
in every report.

> Never put real secrets, camera URLs, credential values, or file paths
> in calibration names, notes, zone labels, tickets, or this document.
> Every free-text field is screened and rejects sensitive-, URL-, or
> path-looking text on write.

## 1. What calibration means in BYOND

A **calibration profile** is safe, structured setup metadata for one
camera source: frame dimensions, orientation, camera mount, and a set of
**normalized zones** describing where the shelf and the customer
interaction area sit in the frame. It exists to make live tests
repeatable and their results interpretable — it is *not* a detection
input in this phase, and it stores no media, no stream address, and no
credential material.

- One camera source can have many profiles, but at most **one ACTIVE**
  profile at a time.
- Profiles move `DRAFT → ACTIVE → ARCHIVED`. Activation is explicit;
  archiving is terminal (create a new profile instead of editing an
  archived one).

## 2. Recommended camera placement

- **Stable mount** — a fixed bracket, never handheld or leaning; motion
  windows assume the background does not move.
- **Clear shelf view** — the whole test shelf inside the frame, products
  facing the camera.
- **Avoid glare** — no direct light source or window reflection across
  the shelf face; matte lighting beats bright spots.
- **Avoid extreme angles** — keep the lens within roughly 45 degrees of
  the shelf normal; FRONT_SHELF or ANGLED_SHELF mounts test best.
- **Avoid blocked shelf zones** — no poles, signage, or door swings
  between camera and shelf; re-check after any store change.

## 3. Create a calibration profile

Admin web → **Camera calibration** → pick the camera source → create a
profile with a descriptive name (plain words only), the frame size the
camera actually delivers (for example 1280 × 720), the orientation, and
the mount type. Or via API:

```
POST /camera-calibration-profiles
GET  /camera-calibration-profiles?cameraSourceId=(id)
GET  /camera-calibration-profiles/(id)
PATCH /camera-calibration-profiles/(id)
```

## 4. Define zones

Zones use **normalized coordinates**: every x and y is between 0 and 1
relative to frame width/height (never raw pixels), with 3 to 20 points
per polygon. A simple rectangle is four points.

| Zone type | Meaning |
| --- | --- |
| `SHELF_ZONE` | Where the products sit. Required for activation. |
| `INTERACTION_ZONE` | Where hands enter to pick or return. Required for activation. |
| `IGNORE_ZONE` | Frame regions to disregard (aisle traffic, doors). Optional. |
| `ENTRY_EXIT_ZONE` | Where shoppers enter/leave the view. Optional. |

Example shelf zone (upper-middle band of the frame):

```
POST /camera-calibration-profiles/(id)/zones
{
  "zoneType": "SHELF_ZONE",
  "label": "top shelf drinks",
  "polygon": [
    { "x": 0.10, "y": 0.20 },
    { "x": 0.90, "y": 0.20 },
    { "x": 0.90, "y": 0.55 },
    { "x": 0.10, "y": 0.55 }
  ]
}
```

Update with `PATCH .../zones/(zoneId)`, delete with
`DELETE .../zones/(zoneId)`. Zones are calibration and testing aids
only — no basket, order, payment, or inventory path reads them.

## 5. Assign expected products

On a `SHELF_ZONE`, set `expectedProductIds` (tenant-scoped catalog ids,
at most 25 per zone; the SKU is snapshotted server-side). Updates use
replace-all semantics — send the full new list. Expected products tell
the reviewer what the shelf *should* carry during a test; they never
mutate inventory.

## 6. Activate the profile

```
POST /camera-calibration-profiles/(id)/activate
```

Activation requires at least one active `SHELF_ZONE` **and** one active
`INTERACTION_ZONE`; it archives the source's previously ACTIVE profile.
Archive explicitly with `POST .../archive`.

## 7. Check readiness

```
GET /camera-sources/(id)/calibration-readiness
```

Returns controlled booleans/counts plus `readiness`:

- `NOT_READY` — no active profile, no shelf zone, no interaction zone,
  or the source is not ACTIVE. Fix these before testing.
- `WARNING` — usable, but something is missing (expected products,
  frame dimensions, orientation, mount, or a live session is already
  active).
- `READY` — minimum data present.

Warnings are a controlled vocabulary (for example
`NO_ACTIVE_CALIBRATION_PROFILE`, `NO_SHELF_ZONE`,
`NO_EXPECTED_PRODUCTS`, `CAMERA_MOUNT_UNKNOWN`, `SOURCE_NOT_ACTIVE`,
`LIVE_SESSION_ALREADY_ACTIVE`) — never raw exception text.

The Phase 16 live-test preflight now includes this readiness: for a
real live-footage (live shadow stream) source, a `NOT_READY`
calibration makes the preflight `ready: false`. FILE_REPLAY behavior is
unchanged — replay needs no calibration.

## 8. Pilot hardening report

```
GET /camera-sources/(id)/pilot-hardening-report
```

One page before a live test: source status, calibration readiness, zone
and expected-product coverage, the latest live session and its
performance summary (both `null` when absent — nothing is fabricated),
and `recommendedNextActions` from a controlled list such as
`CREATE_CALIBRATION_PROFILE`, `ADD_SHELF_ZONE`,
`ASSIGN_EXPECTED_PRODUCTS`, `RUN_PHASE16_TEST_PROTOCOL`,
`REVIEW_MISSED_EVENTS`, `IMPROVE_CAMERA_ANGLE`, `CHECK_LIGHTING`,
`REDUCE_OCCLUSION`.

## 9. Run the Phase 16 protocol after calibration

Once readiness is `READY` (or `WARNING` with understood gaps), follow
the live footage test protocol doc in this folder: create a test
protocol, link an evaluation run, run live sessions, review and correct
observations, read the validation report, and export the reviewed
dataset. Calibration changes none of that flow — it only adds the
readiness gate in front of it.

## 10. Recommended first calibration checklist

1. Mount the camera; confirm a stable, glare-free shelf view.
2. Create the profile with real frame dimensions, orientation, mount.
3. Draw one `SHELF_ZONE` over the test shelf.
4. Draw one `INTERACTION_ZONE` over the reach-in area in front of it.
5. Add an `IGNORE_ZONE` over any busy background region.
6. Assign the 2–5 products actually on the shelf as expected products.
7. Activate the profile.
8. Check `calibration-readiness` — resolve every warning you can.
9. Check the `pilot-hardening-report` next actions.
10. Run the Phase 16 preflight, then the protocol's first scenario set.

## 11. Known limitations

- Zones are metadata for operators and reviewers in this phase — the
  live pipeline does not yet crop or score by calibration zones.
- Polygon validation is MVP (3–20 points in the unit square); no
  self-intersection or coverage geometry checks.
- Zone overlap is not analyzed; place ignore zones thoughtfully.
- No drawing canvas in the admin UI — coordinates are entered as
  numbers (a rectangle is four points).
- One ACTIVE profile per camera source; re-activating an archived
  profile is not supported — create a new one.

## Safety reminder

Calibration configures **testing**, nothing else. It does not trigger
checkout, orders, payment, settlement, or inventory mutation; live CV
remains shadow-only and review-first, and the dataset export remains
reviewed/corrected-only. These invariants are enforced statically in CI
and reported as structural zeros in every calibration and hardening
response.
