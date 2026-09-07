import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../auth';
import { CollapseIcon, GroupIcon, MenuIcon, MoonIcon, SignOutIcon, SunIcon, SystemIcon } from './icons';
import { NAV_GROUPS } from './nav';
import { PageTitleContext } from './primitives';
import {
  THEME_OPTIONS,
  ThemePreference,
  applyThemePreference,
  readSidebarCollapsed,
  readThemePreference,
  writeSidebarCollapsed,
  writeThemePreference,
} from './theme';

export function ThemeSwitch() {
  const [preference, setPreference] = useState<ThemePreference>(() => readThemePreference());

  useEffect(() => {
    applyThemePreference(preference);
  }, [preference]);

  return (
    <div className="theme-switch" role="group" aria-label="Theme">
      {THEME_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={preference === option.value}
          title={`${option.label} theme`}
          onClick={() => {
            setPreference(option.value);
            writeThemePreference(option.value);
          }}
        >
          {option.value === 'system' ? <SystemIcon /> : option.value === 'light' ? <SunIcon /> : <MoonIcon />}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Sidebar({
  collapsed,
  onToggle,
  onNavigate,
}: {
  collapsed: boolean;
  onToggle: () => void;
  onNavigate: () => void;
}) {
  return (
    <nav className="sidebar" aria-label="Main">
      <div className="brand">
        <span className="mark" aria-hidden="true">
          BY
        </span>
        <span>BYOND Admin</span>
      </div>
      {NAV_GROUPS.map((group) => (
        <div className="nav-group" key={group.id}>
          <div className="nav-group-title" title={group.label}>
            <GroupIcon name={group.icon} />
            <span>{group.label}</span>
          </div>
          {group.items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className="nav-link"
              title={item.label}
              onClick={onNavigate}
            >
              {item.label}
            </NavLink>
          ))}
        </div>
      ))}
      <div className="spacer" />
      <button
        type="button"
        className="icon-button sidebar-toggle"
        onClick={onToggle}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        <CollapseIcon collapsed={collapsed} />
      </button>
    </nav>
  );
}

export function TopBar({ title, onOpenDrawer }: { title: string; onOpenDrawer: () => void }) {
  const { user, logout } = useAuth();
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ');
  return (
    <header className="topbar">
      <button
        type="button"
        className="icon-button drawer-button"
        onClick={onOpenDrawer}
        aria-label="Open navigation"
      >
        <MenuIcon />
      </button>
      <div className="page-title">{title}</div>
      {user?.tenantId ? (
        <span className="chip-mono" title="Tenant">
          {user.tenantId}
        </span>
      ) : null}
      <div className="who">
        {name ? <strong>{name}</strong> : null}
        <span>{user?.email}</span>
      </div>
      <ThemeSwitch />
      <button
        type="button"
        className="icon-button"
        onClick={() => void logout()}
        aria-label="Sign out"
        title="Sign out"
      >
        <SignOutIcon />
      </button>
    </header>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(() => readSidebarCollapsed());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [title, setTitle] = useState('');
  const location = useLocation();

  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  const toggle = useCallback(() => {
    setCollapsed((current) => {
      writeSidebarCollapsed(!current);
      return !current;
    });
  }, []);

  const titleState = useMemo(() => ({ title, setTitle }), [title]);
  const layoutClass = ['layout', collapsed ? 'collapsed' : '', drawerOpen ? 'drawer-open' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <PageTitleContext.Provider value={titleState}>
      <div className={layoutClass}>
        <Sidebar collapsed={collapsed} onToggle={toggle} onNavigate={() => setDrawerOpen(false)} />
        <button
          type="button"
          className="drawer-scrim"
          aria-label="Close navigation"
          onClick={() => setDrawerOpen(false)}
        />
        <div className="content">
          <TopBar title={title} onOpenDrawer={() => setDrawerOpen(true)} />
          <main>{children}</main>
        </div>
      </div>
    </PageTitleContext.Provider>
  );
}
