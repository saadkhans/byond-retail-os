# Store flow — from shopper entry to a settled order

Phase 26 closes the loop the platform was missing. Before it, BYOND had two
computer-vision stacks that never met.

The modern stack produced observations: a fusion run decided what it thought
happened, the journey module recorded it as an append-only observation, and
journey exit set a decision on the journey row. Nothing read that decision. The
journey table had no link to a checkout session, an order or a payment, so a
journey that reached "ready to settle" simply sat there.

The older stack was the only thing that could change a basket: an inference
result became a vision event, a person bound it to a checkout session, and
approving it added the line. The fusion stack never wrote to it.

This phase builds the bridge between them, and the entry and exit that make it a
store rather than a demo.

## The loop

1. **Entry.** An operator issues a single-use, short-lived entry credential for a
   store and unit. Redeeming it creates a shopper, opens a customer journey and
   opens the checkout session the journey's observations will fold into. The
   three are bound together.
2. **Observation.** Nothing changes here. Pickups and returns reach the journey
   exactly as before, from the clip lab, camera replay, live sessions or a
   manual append.
3. **Projection.** The bridge reads observations that have not been projected
   yet and decides what each one is worth. Depending on the autonomy policy it
   creates a pending vision event, applies one automatically, or routes it to a
   human.
4. **Review.** One queue shows every uncertain observation together with what
   the bridge did with it. A decision recorded there lands in both places it has
   to: the append-only journey stream, and the vision event whose approval
   actually moves the basket.
5. **Exit and settlement.** Leaving catches up on any unprojected observation,
   refuses to settle while anything still waits for a person, closes the
   journey, completes the session into an order — which is what writes the sale
   movements to the inventory ledger — and then opens, authorises and captures a
   payment for the order total.

## Autonomy is a policy, and its default changes nothing

How much a store may do without a person is a versioned, audited policy, set for
the whole tenant or for one store. A store policy beats the tenant default; with
neither, the built-in default applies.

**Shadow** is that default. The store observes and changes nothing: no vision
event, no basket line, no order, no stock movement, no payment. This is exactly
what every phase before this one did, which is why merging this phase is inert
until an operator opts in.

**Propose** turns each product observation into a pending vision event bound to
the shopper's basket. A person still approves every one.

**Auto-apply** additionally applies observations that clear the policy's
confidence floor and pass inventory validation. Everything else still waits.

Changing the policy always publishes a new immutable version. Nothing is edited
in place, so the record of who let a store act unattended, when and why is
complete, and reverting means publishing an earlier setting forward again.

## What stops a mistake becoming a charge

The product invariant is unchanged and now enforced in code on the path that
matters: computer vision proposes, inventory validates, checkout routes, and a
low-confidence event goes to a human.

A score on its own is never sufficient. Before anything is applied unattended:

- the observation must be a product movement the pipeline did not itself flag;
- it must name a product in the tenant's catalog;
- its score must clear the policy's floor, and an observation carrying no score
  at all never clears it;
- and the store's inventory projection must make the movement plausible — a
  pickup of something the store does not stock goes to a person, however
  confident the model was.

Anything that fails a gate is still created and still visible in the queue. It
is not dropped; it waits.

Settlement has its own gate: a journey with any proposal still pending review
exits without an order. An unreviewed pickup is never silently billed and never
silently discarded.

## Replays cannot double-charge

Every effect is keyed off a stable identifier, so repeating a request re-reads
what it already did:

- the checkout session opened on entry is keyed by the entry credential;
- the vision event for an observation is keyed by that observation;
- the order is keyed by the journey, which is what protects the inventory
  ledger — a duplicate exit cannot consume stock twice;
- the payment intent, its authorisation and its capture are keyed by the order,
  and an already-captured intent short-circuits.

The projection table has one row per observation, enforced by a unique index.
Two syncs racing the same observation resolve at the database, and the loser
reads the winner's row rather than creating a second basket effect.

## Entry credentials

SECURITY.md requires that store-entry tokens are single-use and short-TTL, and
that no long-lived entry credential is ever issued. The implementation follows
that literally.

The secret is generated with 32 bytes of entropy and returned exactly once, in
the issuing response. Only its SHA-256 digest is stored, and a database check
constraint refuses anything that is not a 64-character hex digest, so a row can
never hold a usable credential. Lookup is by digest, and an unknown credential
and a wrong one produce the same answer, so redemption cannot be used to test
whether a token exists. Redemption is a guarded update on the issued state: two
concurrent redemptions race at the database and exactly one wins. The default
lifetime is two minutes and the ceiling is fifteen.

## Where the code lives, and why it lives there

The journey, fusion, camera and clip-lab modules are shadow-only by design, and
each carries a grep-level guard test that fails if any file in it writes to a
checkout, order, payment, inventory or vision-event model. Those guards are
load-bearing and this phase does not touch them.

The bridge therefore lives in its own module. It reads the observation stream
through the journey service and writes commerce through the same public services
an operator drives by hand — there is no second implementation of basket, order,
ledger or payment rules. A guard test in the other direction pins that the
bridge never writes the journey tables directly and never changes a journey's
status, decision or timestamps, so closing a journey stays the journey module's
job and its live-session ownership rules still apply.

## Known limitations

- **Simulated payments only.** The provider vocabulary still contains only a
  simulated and a manual provider. Settlement drives the real state machine, but
  no gateway is contacted and no card data exists anywhere in the path. A real
  provider arrives as an adapter behind the same contract.
- ~~**No refunds or returns after settlement.**~~ **Shipped in Phase 27.**
  Returns put goods back through the ledger and money back through the payments
  abstraction, capped at what was captured; cancelling a settled order now has a
  supported path — see [returns.md](returns.md).
- **An unpriced basket produces an unpaid order.** If pricing cannot value every
  line, the order is created with no total and is payable by hand rather than
  automatically.
- **Live-camera journeys are still review-first.** A journey owned by an active
  live camera session may only be closed by that session's finaliser, so the
  store-flow exit surfaces the same conflict rather than overriding it.
- **The confidence floor is compared against an uncalibrated ranking score**, not
  a probability. Until the calibration work lands, treat the number as a
  threshold that was tuned on your own clips, not as a percentage.
- **Anonymous shoppers only — but there IS a shopper application now.**
  A shopper row still carries no identity beyond an optional link to a platform
  user, and no stored payment instrument. What changed in Phase 35 is that the
  shopper can drive their own visit: the entry credential issued here doubles as
  a journey-scoped credential for three public routes
  (`POST /shopper/session`, `GET /shopper/basket`, `POST /shopper/exit`), which
  is the repository's first public API surface — see
  [shopper-app.md](shopper-app.md).
