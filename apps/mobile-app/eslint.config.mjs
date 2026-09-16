// @ts-check
import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * The shopper app ships WITH a lint script from its first commit.
 *
 * apps/admin-web shipped without one and went unlinted in CI for the whole
 * project's life; a shopper-facing surface is the last place to repeat that.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // A shopper-facing bundle must not narrate itself into a console a
      // support agent will later be asked to read out over the phone.
      'no-console': 'error',
    },
  },
);
