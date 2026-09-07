import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEGACY_LIST_ROUTES, NAV_GROUPS, NAV_REDIRECTS, navItemFor } from './ui/nav';

const appSource = readFileSync(join(__dirname, 'App.tsx'), 'utf8');

/** Route paths declared in App.tsx (`path="..."`), normalised to absolute. */
function declaredRoutes(): Set<string> {
  const routes = new Set<string>();
  for (const match of appSource.matchAll(/<Route\s+(?:index|path="([^"]+)")/g)) {
    routes.add(match[1] === undefined ? '/' : `/${match[1].replace(/^\//, '')}`);
  }
  return routes;
}

describe('navigation groups', () => {
  it('list every sidebar item exactly once', () => {
    const seen = new Map<string, number>();
    for (const group of NAV_GROUPS) {
      expect(group.items.length).toBeGreaterThan(0);
      for (const item of group.items) {
        seen.set(item.to, (seen.get(item.to) ?? 0) + 1);
      }
    }
    for (const [to, count] of seen) {
      expect(count, `${to} appears ${count} times`).toBe(1);
    }
  });

  it('cover every previous list route, directly or through a redirect', () => {
    const routes = declaredRoutes();
    const navTargets = new Set(NAV_GROUPS.flatMap((group) => group.items.map((item) => item.to)));
    const redirected = new Set(NAV_REDIRECTS.map((entry) => entry.from));
    for (const legacy of LEGACY_LIST_ROUTES) {
      expect(
        navTargets.has(legacy) || redirected.has(legacy),
        `${legacy} is neither in the sidebar nor redirected`,
      ).toBe(true);
      expect(routes.has(legacy), `${legacy} has no <Route> in App.tsx`).toBe(true);
    }
  });

  it('redirect targets resolve to a declared route', () => {
    const routes = declaredRoutes();
    for (const entry of NAV_REDIRECTS) {
      const [pathname] = entry.to.split('?');
      expect(routes.has(pathname), `${entry.to} does not resolve`).toBe(true);
      expect(appSource).toContain(`to="${entry.to}"`);
    }
  });

  it('every sidebar target is a declared route', () => {
    const routes = declaredRoutes();
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        expect(routes.has(item.to), `${item.to} has no <Route>`).toBe(true);
      }
    }
  });

  it('matches detail routes to their list item', () => {
    expect(navItemFor('/stores/abc')?.to).toBe('/stores');
    expect(navItemFor('/')?.to).toBe('/');
    expect(navItemFor('/storesX')).toBeNull();
    expect(navItemFor('/camera-runs')?.label).toBe('Camera runs');
  });
});
