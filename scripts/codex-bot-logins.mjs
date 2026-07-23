/**
 * codex-bot-logins — the single source of truth for which GitHub logins are
 * trusted as the Codex review bot.
 *
 * Every Codex identity check in the loop tooling (codex-auto-loop.mjs,
 * codex-review-summary.mjs) MUST import from this module and use STRICT,
 * case-sensitive equality against the allowlist. Substring matching (e.g.
 * `login.includes('codex')`) is forbidden: it would let a lookalike account
 * such as 'codex-reviewer-user' or 'chatgpt-codex-connector2' pass itself
 * off as the Codex bot — its review could become the "latest Codex review",
 * supersede a genuine verdict, or mint a fake clean verdict. Keeping the
 * allowlist in one file guarantees the summary script and the auto-loop
 * helper can never disagree about who Codex is.
 */

export const CODEX_BOT_LOGINS = new Set([
  'chatgpt-codex-connector',
  'chatgpt-codex-connector[bot]',
]);

/**
 * True only when `login` is EXACTLY one of the allowlisted Codex bot logins.
 * Strict equality, case-sensitive, no substring or prefix matching.
 */
export function isCodexBotLogin(login) {
  return typeof login === 'string' && CODEX_BOT_LOGINS.has(login);
}
