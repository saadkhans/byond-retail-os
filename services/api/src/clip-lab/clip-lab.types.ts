/**
 * Phase 22 — Clip Lab response contract.
 *
 * The shapes themselves live in `@byond/shared` because the admin web
 * renders exactly what this service builds; keeping them in one place is
 * what stops the two sides drifting. This module stays as the module-local
 * name the Clip Lab service and controller already import.
 *
 * Type-only re-export on purpose: `@byond/shared` is a source-only
 * workspace package, so nothing here may survive into `dist` as a runtime
 * `require`.
 */
export type {
  ClipLabConfidence,
  ClipLabReport,
  ClipLabStep,
  ClipLabStepResult,
  ClipLabStepStatus,
} from '@byond/shared';
