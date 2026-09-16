// @ts-check
/**
 * The ONE ESLint flat-config base for the workspace. Every package's
 * `eslint.config.mjs` is a call into this file, so a rule change lands
 * in one place instead of being re-declared per package.
 *
 * Environment globals are opt-in flags rather than a fixed set: a Nest
 * service wants Node + Jest, the admin web wants Browser + Node (specs
 * read fixtures) and nothing wants all of them.
 */
import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Build artefacts and vendored trees no package should ever lint. */
export const DEFAULT_IGNORES = ['dist/**', 'build/**', 'coverage/**', 'node_modules/**'];

/**
 * Unused-variable policy shared by every package: `_`-prefixed bindings
 * are intentional placeholders, and rest-sibling omission (`const { a,
 * ...rest }`) is the normal way to drop a field.
 */
export const NO_UNUSED_VARS_RULE = /** @type {const} */ ([
  'error',
  {
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    ignoreRestSiblings: true,
  },
]);

/**
 * @typedef {object} ByondBaseOptions
 * @property {boolean} [node] Enable Node globals (process, console, __dirname...).
 * @property {boolean} [jest] Enable Jest globals (describe, it, expect, jest...).
 * @property {boolean} [browser] Enable browser globals (window, document, fetch...).
 * @property {Record<string, boolean | 'readonly' | 'writable' | 'off'>} [globals]
 *   Extra globals merged on top of the flags above.
 * @property {string[]} [ignores] Extra ignore patterns for this package.
 */

/** Resolve the opt-in environment flags into one globals record. */
export function resolveGlobals(options = {}) {
  return {
    ...(options.node ? globals.node : {}),
    ...(options.browser ? globals.browser : {}),
    ...(options.jest ? globals.jest : {}),
    ...(options.globals ?? {}),
  };
}

/**
 * The shared TypeScript lint base: ESLint recommended + typescript-eslint
 * recommended + the workspace unused-vars policy.
 *
 * @param {ByondBaseOptions} [options]
 */
export function byondBase(options = {}) {
  return tseslint.config(
    { ignores: [...DEFAULT_IGNORES, ...(options.ignores ?? [])] },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
      languageOptions: { globals: resolveGlobals(options) },
      rules: {
        '@typescript-eslint/no-unused-vars': [...NO_UNUSED_VARS_RULE],
      },
    },
  );
}

export default byondBase;
