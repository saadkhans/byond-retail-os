// @ts-check
/**
 * React flavour of the shared base: browser globals plus the hook rules
 * a React package needs. Node globals stay on because unit specs read
 * fixture files off disk.
 */
import reactHooks from 'eslint-plugin-react-hooks';
import { byondBase } from './base.mjs';

/**
 * @param {import('./base.mjs').ByondBaseOptions} [options]
 */
export function byondReact(options = {}) {
  return [
    ...byondBase({ node: true, browser: true, ...options }),
    {
      files: ['**/*.{ts,tsx,js,jsx,mjs}'],
      plugins: { 'react-hooks': reactHooks },
      rules: {
        // A broken hook order is a runtime crash, so it blocks.
        'react-hooks/rules-of-hooks': 'error',
        // Dependency arrays are advisory: several pages pass a
        // deliberately spread `deps` array through `useLoad`.
        'react-hooks/exhaustive-deps': 'warn',
      },
    },
  ];
}

export default byondReact;
