/**
 * Sidebar navigation, grouped by the job the operator is doing. Every
 * routed list page appears exactly once; merged pages (camera runs) and
 * absorbed pages (pickup validation → CV Evaluation tab) keep their old
 * routes as redirects (see App.tsx and nav.spec.ts).
 */
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

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'overview',
    label: 'Overview',
    icon: 'overview',
    items: [{ to: '/', label: 'Dashboard', end: true }],
  },
  {
    id: 'store-operations',
    label: 'Store operations',
    icon: 'store',
    items: [
      { to: '/stores', label: 'Stores' },
      { to: '/units', label: 'Units' },
      { to: '/devices', label: 'Devices' },
      { to: '/catalog', label: 'Catalog' },
      { to: '/inventory', label: 'Inventory' },
    ],
  },
  {
    id: 'commerce',
    label: 'Commerce',
    icon: 'commerce',
    items: [
      { to: '/checkout-sessions', label: 'Checkout sessions' },
      { to: '/orders', label: 'Orders' },
      { to: '/payments', label: 'Payments' },
      { to: '/payment-events', label: 'Payment events' },
      { to: '/reconciliation', label: 'Reconciliation' },
    ],
  },
  {
    id: 'vision-review',
    label: 'Vision review',
    icon: 'review',
    items: [
      { to: '/review-queue', label: 'Review queue' },
      { to: '/journeys', label: 'Journeys' },
      { to: '/vision-events', label: 'CV events' },
      { to: '/inference', label: 'Inference jobs' },
    ],
  },
  {
    id: 'clip-lab',
    label: 'Clip lab',
    icon: 'lab',
    items: [
      { to: '/clip-lab', label: 'Clip Lab' },
      { to: '/video-assets', label: 'Test videos' },
      { to: '/reference-library', label: 'Reference library' },
      { to: '/one-sku-bootstrap', label: 'One SKU bootstrap' },
      { to: '/pretrained-vision', label: 'Pretrained vision & planograms' },
    ],
  },
  {
    id: 'cameras',
    label: 'Cameras & pilots',
    icon: 'camera',
    items: [
      { to: '/cameras', label: 'Cameras' },
      { to: '/camera-calibration', label: 'Camera calibration' },
      { to: '/camera-runs', label: 'Camera runs' },
      { to: '/pilot-evaluations', label: 'Pilot evaluations' },
      { to: '/cv-test-protocols', label: 'Test protocols' },
    ],
  },
  {
    id: 'evaluation',
    label: 'Evaluation & datasets',
    icon: 'evaluation',
    items: [
      { to: '/cv-evaluation', label: 'CV Evaluation' },
      { to: '/cv-dataset-improvement', label: 'Dataset improvement' },
    ],
  },
];

/** Old list routes that now redirect (kept so bookmarks keep working). */
export const NAV_REDIRECTS: { from: string; to: string }[] = [
  { from: '/pickup-validation', to: '/cv-evaluation?tab=validation' },
  { from: '/pilot-runs', to: '/camera-runs?type=replay' },
  { from: '/live-sessions', to: '/camera-runs?type=live' },
];

/** Every list route the sidebar linked to before the regrouping. */
export const LEGACY_LIST_ROUTES = [
  '/',
  '/stores',
  '/units',
  '/devices',
  '/catalog',
  '/inventory',
  '/checkout-sessions',
  '/orders',
  '/payments',
  '/payment-events',
  '/reconciliation',
  '/vision-events',
  '/inference',
  '/video-assets',
  '/clip-lab',
  '/reference-library',
  '/one-sku-bootstrap',
  '/pickup-validation',
  '/cv-evaluation',
  '/journeys',
  '/cameras',
  '/camera-calibration',
  '/pilot-runs',
  '/live-sessions',
  '/pilot-evaluations',
  '/cv-test-protocols',
  '/cv-dataset-improvement',
  '/pretrained-vision',
  '/review-queue',
];

export function navItemFor(pathname: string): NavItem | null {
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`)) {
        return item;
      }
    }
  }
  return null;
}
