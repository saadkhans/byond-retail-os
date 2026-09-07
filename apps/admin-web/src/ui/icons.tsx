import type { NavIcon } from './nav';

/** Small line icons drawn inline (no icon font, no emoji). 24-unit grid. */
function Svg({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export function GroupIcon({ name }: { name: NavIcon }) {
  switch (name) {
    case 'overview':
      return (
        <Svg>
          <rect x="3" y="3" width="8" height="8" rx="1.5" />
          <rect x="13" y="3" width="8" height="5" rx="1.5" />
          <rect x="13" y="10" width="8" height="11" rx="1.5" />
          <rect x="3" y="13" width="8" height="8" rx="1.5" />
        </Svg>
      );
    case 'store':
      return (
        <Svg>
          <path d="M3 9l1.5-5h15L21 9" />
          <path d="M3 9h18v3a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0V9z" />
          <path d="M5 13v8h14v-8" />
          <path d="M10 21v-5h4v5" />
        </Svg>
      );
    case 'commerce':
      return (
        <Svg>
          <circle cx="9" cy="20" r="1.2" />
          <circle cx="17" cy="20" r="1.2" />
          <path d="M3 4h2l2.5 11h11L21 7H6.2" />
        </Svg>
      );
    case 'review':
      return (
        <Svg>
          <path d="M4 6h16v10H8l-4 4V6z" />
          <path d="M9 11l2 2 4-4" />
        </Svg>
      );
    case 'lab':
      return (
        <Svg>
          <path d="M9 3h6" />
          <path d="M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2.2h12.4a1.5 1.5 0 0 0 1.3-2.2L14 9V3" />
          <path d="M7 15h10" />
        </Svg>
      );
    case 'camera':
      return (
        <Svg>
          <rect x="3" y="7" width="13" height="10" rx="2" />
          <path d="M16 11l5-3v8l-5-3" />
        </Svg>
      );
    case 'evaluation':
      return (
        <Svg>
          <path d="M4 20V10" />
          <path d="M10 20V4" />
          <path d="M16 20v-7" />
          <path d="M22 20V8" />
          <path d="M2 20h20" />
        </Svg>
      );
    default:
      return null;
  }
}

export function MenuIcon() {
  return (
    <Svg title="Menu">
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </Svg>
  );
}

export function CollapseIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <Svg title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
      {collapsed ? <path d="M13 10l2 2-2 2" /> : <path d="M16 10l-2 2 2 2" />}
    </Svg>
  );
}

export function SunIcon() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </Svg>
  );
}

export function MoonIcon() {
  return (
    <Svg>
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
    </Svg>
  );
}

export function SystemIcon() {
  return (
    <Svg>
      <rect x="3" y="5" width="18" height="12" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </Svg>
  );
}

export function SignOutIcon() {
  return (
    <Svg title="Sign out">
      <path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5" />
      <path d="M14 8l4 4-4 4M18 12H9" />
    </Svg>
  );
}
