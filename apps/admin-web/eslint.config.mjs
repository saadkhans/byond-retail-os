// @ts-check
import eslint from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * Admin web lint config — same flavour as services/api/eslint.config.mjs so a
 * rule means the same thing on both sides of the repo. The differences are
 * environmental: browser globals for the app sources, Node globals for the
 * build/config files and the spec files that read fixtures off disk, plus the
 * React hooks rules (the sources already carry
 * `eslint-disable-next-line react-hooks/exhaustive-deps` comments, which only
 * resolve when the plugin is loaded).
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      // Calling a hook conditionally is always a bug; a dependency array that
      // drifts from the effect body usually is not, so it warns.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
);
