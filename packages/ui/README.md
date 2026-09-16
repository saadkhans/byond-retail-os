# @byond/ui

The admin UI kit: the presentational building blocks every BYOND
operator-facing surface renders against.

| Module | Contents |
| --- | --- |
| `primitives.tsx` | `PageHeader`, `Section`, `Card`, `StatTiles`, `DataTable`, `Pagination`, `Badge`, `Notice`, `EmptyState`, `FormRow`, `Field`, `Disclosure`, `Tabs`, and the page-title context |
| `icons.tsx` | the inline 24-unit line icons (`GroupIcon`, `MenuIcon`, `CollapseIcon`, `SunIcon`, `MoonIcon`, `SystemIcon`, `SignOutIcon`) |
| `theme.ts` | the three-state theme preference (`system` / `light` / `dark`), the sidebar-collapsed preference, and their best-effort storage |
| `nav.ts` | `NavGroup` / `NavItem` / `NavIcon` — the shape of a grouped sidebar |

## Boundaries

- **Presentational only.** No routes, no API client, no auth context. The
  one framework dependency beyond React is `react-router-dom`, for the
  `<Link>` inside `StatTiles`.
- **Tokens stay in the app.** Phase 23's design tokens live in the
  consuming app's stylesheet; these components only emit the class names
  those tokens style, so an app can restyle the kit without forking it.
- **App-specific shells stay in the app.** `AppShell` / `Sidebar` /
  `TopBar` remain in `apps/admin-web` because they bind that app's nav
  data and auth session.

Source-only package: `main`/`types` point at `src/index.ts` and the
consuming app's bundler compiles it.
