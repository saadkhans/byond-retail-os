/**
 * Navigation vocabulary. The kit owns the SHAPE of a grouped sidebar —
 * which is what `Sidebar` and `GroupIcon` render against — while each app
 * owns its own `NavGroup[]` (see `apps/admin-web/src/ui/nav.ts`).
 */

/** Icon key a nav group renders; `GroupIcon` draws one per key. */
export type NavIcon =
  | 'overview'
  | 'store'
  | 'commerce'
  | 'review'
  | 'lab'
  | 'camera'
  | 'evaluation';

export interface NavItem {
  to: string;
  label: string;
  /** `end` matching for the index route only. */
  end?: boolean;
}

export interface NavGroup {
  id: string;
  label: string;
  icon: NavIcon;
  items: NavItem[];
}
