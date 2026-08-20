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
import {
  CameraCalibrationDetailPage,
  CameraCalibrationPage,
} from './pages/CameraCalibrationPage';
import { CamerasPage } from './pages/CamerasPage';
import {
  LiveSessionDetailPage,
  LiveSessionsPage,
} from './pages/LiveSessionsPage';
import {
  PilotEvaluationDetailPage,
  PilotEvaluationsPage,
} from './pages/PilotEvaluationsPage';
import {
  CvTestProtocolDetailPage,
  CvTestProtocolsPage,
} from './pages/CvTestProtocolsPage';
import {
  CvDatasetImprovementDetailPage,
  CvDatasetImprovementPage,
} from './pages/CvDatasetImprovementPage';
import { CatalogPage } from './pages/CatalogPage';
import {
  CheckoutSessionDetailPage,
  CheckoutSessionsPage,
} from './pages/CheckoutSessionsPage';
import { CvEvaluationPage } from './pages/CvEvaluationPage';
import { DashboardPage } from './pages/DashboardPage';
import { DeviceDetailPage, DevicesPage } from './pages/DevicesPage';
import {
  InferenceJobDetailPage,
  InferenceJobsPage,
} from './pages/InferenceJobsPage';
import { InventoryPage } from './pages/InventoryPage';
import { JourneyDetailPage, JourneysPage } from './pages/JourneysPage';
import { LoginPage } from './pages/LoginPage';
import { OrderDetailPage, OrdersPage } from './pages/OrdersPage';
import { PaymentEventsPage } from './pages/PaymentEventsPage';
import {
  PaymentIntentDetailPage,
  PaymentsPage,
} from './pages/PaymentsPage';
import { PickupValidationPage } from './pages/PickupValidationPage';
import {
  PilotRunDetailPage,
  PilotRunsPage,
} from './pages/PilotRunsPage';
import {
  ReconciliationDetailPage,
  ReconciliationPage,
} from './pages/ReconciliationPage';
import { ReferenceLibraryPage } from './pages/ReferenceLibraryPage';
import { ReviewQueuePage } from './pages/ReviewQueuePage';
import { StoreDetailPage, StoresPage } from './pages/StoresPage';
import { UnitDetailPage, UnitsPage } from './pages/UnitsPage';
import {
  VideoAssetDetailPage,
  VideoAssetsPage,
} from './pages/VideoAssetsPage';
import {
  VisionEventDetailPage,
  VisionEventsPage,
} from './pages/VisionEventsPage';

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
        <NavLink to="/checkout-sessions">Checkout sessions</NavLink>
        <NavLink to="/orders">Orders</NavLink>
        <NavLink to="/payments">Payments</NavLink>
        <NavLink to="/payment-events">Payment events</NavLink>
        <NavLink to="/reconciliation">Reconciliation</NavLink>
        <NavLink to="/vision-events">CV events</NavLink>
        <NavLink to="/inference">Inference jobs</NavLink>
        <NavLink to="/video-assets">Test videos</NavLink>
        <NavLink to="/reference-library">Reference library</NavLink>
        <NavLink to="/pickup-validation">Pickup validation</NavLink>
        <NavLink to="/cv-evaluation">CV Evaluation</NavLink>
        <NavLink to="/journeys">Journeys</NavLink>
        <NavLink to="/cameras">Cameras</NavLink>
        <NavLink to="/camera-calibration">Camera calibration</NavLink>
        <NavLink to="/pilot-runs">Pilot runs</NavLink>
        <NavLink to="/live-sessions">Live sessions</NavLink>
        <NavLink to="/pilot-evaluations">Pilot evaluations</NavLink>
        <NavLink to="/cv-test-protocols">Test protocols</NavLink>
        <NavLink to="/cv-dataset-improvement">Dataset improvement</NavLink>
        <NavLink to="/review-queue">Review queue</NavLink>
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
                    <Route
                      path="checkout-sessions"
                      element={<CheckoutSessionsPage />}
                    />
                    <Route
                      path="checkout-sessions/:id"
                      element={<CheckoutSessionDetailPage />}
                    />
                    <Route path="orders" element={<OrdersPage />} />
                    <Route path="orders/:id" element={<OrderDetailPage />} />
                    <Route path="payments" element={<PaymentsPage />} />
                    <Route
                      path="payments/:id"
                      element={<PaymentIntentDetailPage />}
                    />
                    <Route
                      path="payment-events"
                      element={<PaymentEventsPage />}
                    />
                    <Route
                      path="reconciliation"
                      element={<ReconciliationPage />}
                    />
                    <Route
                      path="reconciliation/:id"
                      element={<ReconciliationDetailPage />}
                    />
                    <Route path="vision-events" element={<VisionEventsPage />} />
                    <Route
                      path="vision-events/:id"
                      element={<VisionEventDetailPage />}
                    />
                    <Route path="inference" element={<InferenceJobsPage />} />
                    <Route
                      path="inference/:id"
                      element={<InferenceJobDetailPage />}
                    />
                    <Route path="video-assets" element={<VideoAssetsPage />} />
                    <Route
                      path="video-assets/:id"
                      element={<VideoAssetDetailPage />}
                    />
                    <Route
                      path="reference-library"
                      element={<ReferenceLibraryPage />}
                    />
                    <Route
                      path="pickup-validation"
                      element={<PickupValidationPage />}
                    />
                    <Route
                      path="cv-evaluation"
                      element={<CvEvaluationPage />}
                    />
                    <Route path="journeys" element={<JourneysPage />} />
                    <Route
                      path="journeys/:id"
                      element={<JourneyDetailPage />}
                    />
                    <Route path="cameras" element={<CamerasPage />} />
                    <Route
                      path="camera-calibration"
                      element={<CameraCalibrationPage />}
                    />
                    <Route
                      path="camera-calibration/:cameraSourceId"
                      element={<CameraCalibrationDetailPage />}
                    />
                    <Route path="pilot-runs" element={<PilotRunsPage />} />
                    <Route
                      path="pilot-runs/:id"
                      element={<PilotRunDetailPage />}
                    />
                    <Route
                      path="live-sessions"
                      element={<LiveSessionsPage />}
                    />
                    <Route
                      path="pilot-evaluations"
                      element={<PilotEvaluationsPage />}
                    />
                    <Route
                      path="pilot-evaluations/:id"
                      element={<PilotEvaluationDetailPage />}
                    />
                    <Route
                      path="cv-test-protocols"
                      element={<CvTestProtocolsPage />}
                    />
                    <Route
                      path="cv-test-protocols/:id"
                      element={<CvTestProtocolDetailPage />}
                    />
                    <Route
                      path="cv-dataset-improvement"
                      element={<CvDatasetImprovementPage />}
                    />
                    <Route
                      path="cv-dataset-improvement/:id"
                      element={<CvDatasetImprovementDetailPage />}
                    />
                    <Route
                      path="live-sessions/:id"
                      element={<LiveSessionDetailPage />}
                    />
                    <Route
                      path="review-queue"
                      element={<ReviewQueuePage />}
                    />
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
