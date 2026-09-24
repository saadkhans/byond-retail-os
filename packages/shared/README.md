# @byond/shared

The domain contract `services/api` and `apps/admin-web` both speak:
the wire vocabularies (status/type enums), the wire shapes that were
previously written out in full on each side, and nothing else.

## What lives here

| Module | Contents |
| --- | --- |
| `enums.ts` | 43 domain vocabularies — a `*_VALUES` list plus the union derived from it |
| `clip-lab.ts` | the Clip Lab report contract (`ClipLabReport` and friends) |
| `geometry.ts` | `RackFrameRegion`, the normalized rack rectangle |
| `pagination.ts` | `Paginated<T>`, the list envelope every search endpoint returns |

## Consumption rules

This is a **source-only internal package**: `main` and `types` both point
at `src/index.ts` and there is no build step. Consumers compile it as
part of their own program.

- `apps/admin-web` bundles it with Vite, so it may use the runtime
  exports (the `*_VALUES` lists feed filter dropdowns).
- `services/api` is compiled by `nest build`, not bundled, so it imports
  from here **type-only** (`import type` / `export type`). A value import
  would survive into `dist` as a `require('@byond/shared')` of a
  TypeScript file. `src/common/shared-contract.ts` is the type-only
  bridge that also asserts the vocabularies still match the Prisma enums.

Nothing here may import a framework, a database client, `react`, or a
Node built-in: it has to compile inside a CommonJS NestJS build and
inside a browser bundle alike.
