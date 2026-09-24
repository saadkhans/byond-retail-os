// @ts-check
import { byondReact } from '@byond/config/eslint/react';

/**
 * The shopper app ships WITH a lint script from its first commit.
 *
 * apps/admin-web shipped without one and went unlinted in CI for the whole
 * project's life; a shopper-facing surface is the last place to repeat that.
 *
 * The environment (browser globals for the app, Node globals because a few
 * unit specs read fixture files off disk), the ignore list and the
 * unused-vars policy all come from the shared base, so this file only holds
 * what is genuinely specific to a shopper-facing bundle.
 */
export default [
  ...byondReact(),
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs}'],
    rules: {
      // A shopper-facing bundle must not narrate itself into a console a
      // support agent will later be asked to read out over the phone.
      'no-console': 'error',
    },
  },
];
