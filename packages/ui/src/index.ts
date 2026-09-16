/**
 * `@byond/ui` — the BYOND admin UI kit.
 *
 * The page chrome, tables, badges, form rows, icons and theme plumbing
 * that every admin surface renders against, extracted from the admin web
 * so a second operator-facing app does not fork them. Everything here is
 * presentational and app-agnostic: the kit never imports an app's routes,
 * API client or auth context.
 *
 * The Phase 23 design tokens stay in the consuming app's stylesheet —
 * these components only emit the class names those tokens style.
 */
export * from './icons';
export * from './nav';
export * from './primitives';
export * from './theme';
