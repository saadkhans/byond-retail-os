import { ReactNode } from 'react';
import {
  BrowserRouter,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { CatalogPage } from './pages/CatalogPage';
import { DashboardPage } from './pages/DashboardPage';
import { DeviceDetailPage, DevicesPage } from './pages/DevicesPage';
import { InventoryPage } from './pages/InventoryPage';
import { LoginPage } from './pages/LoginPage';
import { StoreDetailPage, StoresPage } from './pages/StoresPage';
import { UnitDetailPage, UnitsPage } from './pages/UnitsPage';

function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();
  if (user === undefined) {
    return <p className="muted" style={{ padding: '2rem' }}>Loading…</p>;
  }
  if (user === null) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  return <>{children}</>;
}

function Shell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="brand">BYOND Admin</div>
        <NavLink to="/" end>
          Dashboard
        </NavLink>
        <NavLink to="/stores">Stores</NavLink>
        <NavLink to="/units">Units</NavLink>
        <NavLink to="/devices">Devices</NavLink>
        <NavLink to="/catalog">Catalog</NavLink>
        <NavLink to="/inventory">Inventory</NavLink>
        <div className="spacer" />
        <div className="who">{user?.email}</div>
        <button onClick={() => void logout()}>Sign out</button>
      </nav>
      <main>{children}</main>
    </div>
  );
}

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/*"
            element={
              <RequireAuth>
                <Shell>
                  <Routes>
                    <Route index element={<DashboardPage />} />
                    <Route path="stores" element={<StoresPage />} />
                    <Route path="stores/:id" element={<StoreDetailPage />} />
                    <Route path="units" element={<UnitsPage />} />
                    <Route path="units/:id" element={<UnitDetailPage />} />
                    <Route path="devices" element={<DevicesPage />} />
                    <Route path="devices/:id" element={<DeviceDetailPage />} />
                    <Route path="catalog" element={<CatalogPage />} />
                    <Route path="inventory" element={<InventoryPage />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Routes>
                </Shell>
              </RequireAuth>
            }
          />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
