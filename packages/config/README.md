# @byond/config

Workspace-internal build configuration. Nothing here ships; every export
exists so a package can adopt a rule set instead of re-declaring it.

## ESLint

```js
// services/<svc>/eslint.config.mjs
import { byondBase } from '@byond/config/eslint/base';
export default byondBase({ node: true, jest: true });
```

```js
// apps/<app>/eslint.config.mjs
import { byondReact } from '@byond/config/eslint/react';
export default byondReact();
```

`byondBase` layers ESLint recommended, typescript-eslint recommended and
the workspace unused-vars policy, and takes opt-in environment flags
(`node`, `browser`, `jest`) plus extra `globals` / `ignores`.
`byondReact` adds browser globals and `eslint-plugin-react-hooks`.

## TypeScript

| Config | For |
| --- | --- |
| `@byond/config/tsconfig/base.json` | strictness + hygiene flags only |
| `@byond/config/tsconfig/node.json` | CommonJS Node services (NestJS) |
| `@byond/config/tsconfig/react.json` | bundler-resolved React packages/apps |

```json
{ "extends": "@byond/config/tsconfig/react.json" }
```

A package still owns whatever is genuinely its own: `outDir`, `types`,
`include`/`exclude`, and any flag it must deviate on.
