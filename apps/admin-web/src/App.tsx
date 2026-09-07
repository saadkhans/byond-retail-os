import { ReactNode } from 'react';
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { AppShell } from './components';
import {
  CameraCalibrationDetailPage,
  CameraCalibrationPage,
} from './pages/CameraCalibrationPage';
import { CameraRunsPage } from './pages/CameraRunsPage';
import { CamerasPage } from './pages/CamerasPage';
import { LiveSessionDetailPage } from './pages/LiveSessionsPage';
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
import { OneSkuBootstrapPage } from './pages/OneSkuBootstrapPage';
import { PretrainedVisionPage } from './pages/PretrainedVisionPage';
import { ClipLabPage } from './pages/ClipLabPage';
import { OrderDetailPage, OrdersPage } from './pages/OrdersPage';
import { PaymentEventsPage } from './pages/PaymentEventsPage';
import {
  PaymentIntentDetailPage,
  PaymentsPage,
} from './pages/PaymentsPage';
import { PilotRunDetailPage } from './pages/PilotRunsPage';
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
                <AppShell>
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
                    <Route path="clip-lab" element={<ClipLabPage />} />
                    <Route
                      path="video-assets/:id"
                      element={<VideoAssetDetailPage />}
                    />
                    <Route
                      path="reference-library"
                      element={<ReferenceLibraryPage />}
                    />
                    <Route
                      path="one-sku-bootstrap"
                      element={<OneSkuBootstrapPage />}
                    />
                    <Route
                      path="pretrained-vision"
                      element={<PretrainedVisionPage />}
                    />
                    {/* Pickup validation lives on as a tab of CV Evaluation. */}
                    <Route
                      path="pickup-validation"
                      element={<Navigate to="/cv-evaluation?tab=validation" replace />}
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
                    {/* Replay runs and live sessions share one list; the
                        detail routes keep their type-specific controls. */}
                    <Route path="camera-runs" element={<CameraRunsPage />} />
                    <Route
                      path="pilot-runs"
                      element={<Navigate to="/camera-runs?type=replay" replace />}
                    />
                    <Route
                      path="pilot-runs/:id"
                      element={<PilotRunDetailPage />}
                    />
                    <Route
                      path="live-sessions"
                      element={<Navigate to="/camera-runs?type=live" replace />}
                    />
                    <Route
                      path="live-sessions/:id"
                      element={<LiveSessionDetailPage />}
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
                      path="review-queue"
                      element={<ReviewQueuePage />}
                    />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Routes>
                </AppShell>
              </RequireAuth>
            }
          />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
