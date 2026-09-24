/**
 * Phase 35 — the shopper-facing surface.
 *
 * Everything the shopper app is allowed to know about the store loop passes
 * through this module. Nothing here invents commerce behaviour: the module
 * authenticates a JOURNEY-SCOPED principal and then calls the very same
 * Phase 26 `StoreFlowService` methods an operator drives by hand.
 */

/**
 * The scheme the shopper app sends its credential under:
 *
 *     Authorization: Shopper <entry secret>
 *
 * `Authorization` (rather than a bespoke header) on purpose — it is already
 * on the API's CORS allowlist, browsers never persist it, and it keeps the
 * secret out of the URL, where history, referrers and server logs would
 * otherwise carry it. `Bearer` is deliberately NOT accepted here: a staff
 * access token must never authenticate a shopper route, and a shopper
 * credential must never be mistaken for one.
 */
export const SHOPPER_CREDENTIAL_SCHEME = 'Shopper';

/** The platform module this whole surface is gated on, exactly as Phase 26. */
export const STORE_FLOW_MODULE_CODE = 'store-flow';

/**
 * How long a redeemed entry credential keeps working as a session credential.
 *
 * The credential's OWN ttl (default 120s, ceiling 900s — Phase 26) governs
 * redemption and is untouched. Once burned, the same secret is what proves
 * "I am the shopper on journey X", and that has to outlive a shop visit
 * without becoming a bearer token with no end. Four hours is longer than any
 * visit and short enough that a secret left in a browser is worthless by the
 * time anyone finds it.
 */
export const SHOPPER_SESSION_MAX_SECONDS = 4 * 60 * 60;

/**
 * The single answer every session failure gives. Unknown secret, wrong
 * secret, another tenant's secret, a suspended tenant, a disabled module, an
 * expired session, a credential that was never redeemed — all identical, so
 * the route cannot be used to probe any of them.
 */
export const SHOPPER_SESSION_INVALID = 'Shopper session is not valid';

/**
 * The answer a REDEMPTION gives when the credential resolves to nothing it
 * may act on. Deliberately word-for-word what Phase 26's own redeem path
 * says for an unknown or wrong secret, so this route adds no new way to tell
 * "no such credential" apart from "not your credential".
 */
export const ENTRY_CREDENTIAL_INVALID = 'Entry credential is not valid';
