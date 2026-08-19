import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ApiError,
  CalibrationReadiness,
  CameraCalibrationMount,
  CameraCalibrationOrientation,
  CameraCalibrationProfileDetail,
  CameraCalibrationProfileView,
  CameraCalibrationZoneType,
  CameraCalibrationZoneView,
  CameraSourceView,
  PilotHardeningReport,
  api,
} from '../api';
import { Page, StatusBadge, formatDate, useLoad } from '../components';
import {
  calibrationReadinessTone,
  formatNextAction,
  formatWarning,
  parsePolygonInput,
  polygonToInput,
  profileStatusTone,
} from '../camera-calibration-utils';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Unexpected error';
}

const ORIENTATIONS: CameraCalibrationOrientation[] = [
  'UNKNOWN',
  'LANDSCAPE',
  'PORTRAIT',
];
const MOUNTS: CameraCalibrationMount[] = [
  'UNKNOWN',
  'OVERHEAD',
  'FRONT_SHELF',
  'ANGLED_SHELF',
];
const ZONE_TYPES: CameraCalibrationZoneType[] = [
  'SHELF_ZONE',
  'INTERACTION_ZONE',
  'IGNORE_ZONE',
  'ENTRY_EXIT_ZONE',
];

/**
 * Phase 17 — camera calibration & pilot hardening (SHADOW ONLY).
 * Calibration profiles and normalized zones describe the camera view for
 * testing; they never touch baskets, orders, payments, or inventory, and
 * never carry source URLs, file paths, or credentials.
 */
export function CameraCalibrationPage() {
  const sources = useLoad<CameraSourceView[]>(() => api('/camera-sources'), []);
  // Per-source readiness — a failed lookup shows as unknown, not a page error.
  const readiness = useLoad<Record<string, CalibrationReadiness | null>>(
    async () => {
      const entries = await Promise.all(
        (sources.data ?? []).map(async (source) => {
          try {
            return [
              source.id,
              await api<CalibrationReadiness>(
                `/camera-sources/${source.id}/calibration-readiness`,
              ),
            ] as const;
          } catch {
            return [source.id, null] as const;
          }
        }),
      );
      return Object.fromEntries(entries);
    },
    [sources.data],
  );

  return (
    <Page
      title="Camera calibration (shadow)"
      error={sources.error}
      loading={sources.loading && !sources.data}
    >
      <p className="muted">
        Describe each camera view (zones, orientation, mount) so live CV
        tests are repeatable. Calibration is metadata only — no checkout,
        payment, or inventory mutation, and no source URLs or credentials.
      </p>
      <table>
        <thead>
          <tr>
            <th>Camera source</th>
            <th>Type</th>
            <th>Status</th>
            <th>Calibration</th>
            <th>Zones</th>
          </tr>
        </thead>
        <tbody>
          {(sources.data ?? []).map((source) => {
            const r = readiness.data?.[source.id] ?? null;
            return (
              <tr key={source.id}>
                <td>
                  <Link to={`/camera-calibration/${source.id}`}>
                    {source.name}
                  </Link>
                </td>
                <td>{source.sourceType}</td>
                <td>
                  <StatusBadge status={source.status} />
                </td>
                <td>
                  {r ? (
                    <span
                      className={`badge ${calibrationReadinessTone(r.readiness)}`}
                    >
                      {r.readiness}
                    </span>
                  ) : readiness.loading ? (
                    <span className="muted">checking…</span>
                  ) : (
                    <span className="muted">unknown</span>
                  )}
                </td>
                <td>{r ? r.zoneCount : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {(sources.data ?? []).length === 0 ? (
        <p className="muted">
          No camera sources yet — create one on the{' '}
          <Link to="/cameras">Cameras</Link> page first.
        </p>
      ) : null}
    </Page>
  );
}

export function CameraCalibrationDetailPage() {
  const { cameraSourceId } = useParams<{ cameraSourceId: string }>();
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Create-profile form.
  const [cName, setCName] = useState('');
  const [cOrientation, setCOrientation] =
    useState<CameraCalibrationOrientation>('UNKNOWN');
  const [cMount, setCMount] = useState<CameraCalibrationMount>('UNKNOWN');
  const [cFrameWidth, setCFrameWidth] = useState('');
  const [cFrameHeight, setCFrameHeight] = useState('');
  const [cNotes, setCNotes] = useState('');

  // Selected profile + metadata edit form.
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [editingMeta, setEditingMeta] = useState(false);
  const [eName, setEName] = useState('');
  const [eOrientation, setEOrientation] =
    useState<CameraCalibrationOrientation>('UNKNOWN');
  const [eMount, setEMount] = useState<CameraCalibrationMount>('UNKNOWN');
  const [eFrameWidth, setEFrameWidth] = useState('');
  const [eFrameHeight, setEFrameHeight] = useState('');
  const [eNotes, setENotes] = useState('');

  // Zone add/edit form (editingZoneId === '' means "add new").
  const [editingZoneId, setEditingZoneId] = useState('');
  const [zType, setZType] = useState<CameraCalibrationZoneType>('SHELF_ZONE');
  const [zLabel, setZLabel] = useState('');
  const [zPolygon, setZPolygon] = useState('');
  const [zQuality, setZQuality] = useState('');
  const [zSortOrder, setZSortOrder] = useState('0');
  const [zActive, setZActive] = useState(true);
  const [zProductIds, setZProductIds] = useState('');

  const source = useLoad<CameraSourceView>(
    () => api(`/camera-sources/${cameraSourceId}`),
    [cameraSourceId],
  );
  const readiness = useLoad<CalibrationReadiness>(
    () => api(`/camera-sources/${cameraSourceId}/calibration-readiness`),
    [cameraSourceId, tick],
  );
  const report = useLoad<PilotHardeningReport>(
    () => api(`/camera-sources/${cameraSourceId}/pilot-hardening-report`),
    [cameraSourceId, tick],
  );
  const profiles = useLoad<CameraCalibrationProfileView[]>(
    () =>
      api(`/camera-calibration-profiles?cameraSourceId=${cameraSourceId}`),
    [cameraSourceId, tick],
  );
  const profileDetail = useLoad<CameraCalibrationProfileDetail | null>(
    () =>
      selectedProfileId
        ? api(`/camera-calibration-profiles/${selectedProfileId}`)
        : Promise.resolve(null),
    [selectedProfileId, tick],
  );

  // Default the selection to the active profile (or the newest one).
  const profileList = profiles.data ?? [];
  useEffect(() => {
    if (!selectedProfileId && profileList.length > 0) {
      const active = profileList.find((p) => p.status === 'ACTIVE');
      setSelectedProfileId((active ?? profileList[0]).id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProfileId, profileList.length]);

  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    setActionError(null);
    try {
      await work();
      setTick((n) => n + 1);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function startEditMeta(profile: CameraCalibrationProfileView) {
    setEditingMeta(true);
    setEName(profile.name);
    setEOrientation(profile.orientation);
    setEMount(profile.cameraMount);
    setEFrameWidth(profile.frameWidth === null ? '' : String(profile.frameWidth));
    setEFrameHeight(
      profile.frameHeight === null ? '' : String(profile.frameHeight),
    );
    setENotes(profile.notes ?? '');
  }

  function startEditZone(zone: CameraCalibrationZoneView) {
    setEditingZoneId(zone.id);
    setZType(zone.zoneType);
    setZLabel(zone.label);
    setZPolygon(polygonToInput(zone.polygon));
    setZQuality(zone.qualityScore === null ? '' : String(zone.qualityScore));
    setZSortOrder(String(zone.sortOrder));
    setZActive(zone.isActive);
    setZProductIds(zone.expectedProducts.map((p) => p.productId).join(', '));
  }

  function resetZoneForm() {
    setEditingZoneId('');
    setZType('SHELF_ZONE');
    setZLabel('');
    setZPolygon('');
    setZQuality('');
    setZSortOrder('0');
    setZActive(true);
    setZProductIds('');
  }

  async function submitZone() {
    if (!selectedProfileId) {
      return;
    }
    const parsed = parsePolygonInput(zPolygon);
    if (parsed.error || !parsed.points) {
      setActionError(`Polygon invalid: ${parsed.error ?? 'unparseable'}`);
      return;
    }
    if (!zLabel.trim()) {
      setActionError('Zone label is required');
      return;
    }
    const productIds = zProductIds
      .split(/[\s,]+/)
      .map((id) => id.trim())
      .filter(Boolean);
    const body = {
      zoneType: zType,
      label: zLabel.trim(),
      polygon: parsed.points,
      ...(zQuality.trim() ? { qualityScore: Number(zQuality) } : {}),
      sortOrder: Number(zSortOrder) || 0,
      isActive: zActive,
      // Expected products apply to shelf zones only; PATCH replaces the set.
      ...(zType === 'SHELF_ZONE'
        ? editingZoneId
          ? { expectedProductIds: productIds }
          : productIds.length > 0
            ? { expectedProductIds: productIds }
            : {}
        : {}),
    };
    await action(() =>
      editingZoneId
        ? api(
            `/camera-calibration-profiles/${selectedProfileId}/zones/${editingZoneId}`,
            { method: 'PATCH', body },
          )
        : api(`/camera-calibration-profiles/${selectedProfileId}/zones`, {
            method: 'POST',
            body,
          }),
    );
    resetZoneForm();
  }

  const detail = profileDetail.data ?? null;
  const detailEditable = detail !== null && detail.status !== 'ARCHIVED';

  return (
    <Page
      title="Camera calibration (shadow)"
      error={source.error}
      loading={source.loading && !source.data}
    >
      {actionError ? <div className="error">{actionError}</div> : null}
      {source.data ? (
        <div className="detail">
          <div>
            <StatusBadge status={source.data.status} />{' '}
            <strong>{source.data.name}</strong>{' '}
            <span className="muted">
              {source.data.sourceType}
              {source.data.shelfZone ? ` · shelf ${source.data.shelfZone}` : ''}
            </span>
          </div>
          <p>
            <Link to="/camera-calibration">← All cameras</Link>{' '}
            <Link to="/cv-test-protocols">
              Run the Phase 16 test protocol →
            </Link>
          </p>

          <h2>Calibration readiness</h2>
          {readiness.data ? (
            <>
              <p>
                <span
                  className={`badge ${calibrationReadinessTone(readiness.data.readiness)}`}
                >
                  {readiness.data.readiness}
                </span>{' '}
                <span className="muted">
                  {readiness.data.hasActiveCalibrationProfile
                    ? 'active profile'
                    : 'no active profile'}{' '}
                  · {readiness.data.zoneCount} zones ·{' '}
                  {readiness.data.expectedProductCount} expected products
                </span>
              </p>
              {readiness.data.warnings.length > 0 ? (
                <ul>
                  {readiness.data.warnings.map((warning) => (
                    <li key={warning} className="muted">
                      {formatWarning(warning)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No warnings.</p>
              )}
            </>
          ) : readiness.error ? (
            <p className="muted">Readiness unavailable.</p>
          ) : (
            <p className="muted">Loading…</p>
          )}

          <h2>Calibration profiles ({profileList.length})</h2>
          <div className="form-row">
            <input
              placeholder="Profile name"
              value={cName}
              onChange={(e) => setCName(e.target.value)}
            />
            <select
              value={cOrientation}
              onChange={(e) =>
                setCOrientation(e.target.value as CameraCalibrationOrientation)
              }
            >
              {ORIENTATIONS.map((option) => (
                <option key={option} value={option}>
                  Orientation: {option}
                </option>
              ))}
            </select>
            <select
              value={cMount}
              onChange={(e) =>
                setCMount(e.target.value as CameraCalibrationMount)
              }
            >
              {MOUNTS.map((option) => (
                <option key={option} value={option}>
                  Mount: {option}
                </option>
              ))}
            </select>
            <input
              placeholder="Frame width px (optional)"
              inputMode="numeric"
              value={cFrameWidth}
              onChange={(e) => setCFrameWidth(e.target.value)}
            />
            <input
              placeholder="Frame height px (optional)"
              inputMode="numeric"
              value={cFrameHeight}
              onChange={(e) => setCFrameHeight(e.target.value)}
            />
            <textarea
              placeholder="Notes (optional, screened — no URLs or paths)"
              value={cNotes}
              onChange={(e) => setCNotes(e.target.value)}
            />
            <button
              className="primary"
              disabled={busy || !cName.trim()}
              onClick={() =>
                void action(() =>
                  api('/camera-calibration-profiles', {
                    method: 'POST',
                    body: {
                      cameraSourceId,
                      name: cName.trim(),
                      orientation: cOrientation,
                      cameraMount: cMount,
                      ...(cFrameWidth.trim()
                        ? { frameWidth: Number(cFrameWidth) }
                        : {}),
                      ...(cFrameHeight.trim()
                        ? { frameHeight: Number(cFrameHeight) }
                        : {}),
                      ...(cNotes.trim() ? { notes: cNotes.trim() } : {}),
                    },
                  }),
                ).then(() => {
                  setCName('');
                  setCFrameWidth('');
                  setCFrameHeight('');
                  setCNotes('');
                })
              }
            >
              Create profile
            </button>
          </div>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Version</th>
                <th>Frame</th>
                <th>Orientation</th>
                <th>Mount</th>
                <th>Zones</th>
                <th>Updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {profileList.map((profile) => (
                <tr key={profile.id}>
                  <td>
                    <button
                      onClick={() => {
                        setSelectedProfileId(profile.id);
                        setEditingMeta(false);
                        resetZoneForm();
                      }}
                      disabled={profile.id === selectedProfileId}
                    >
                      {profile.name}
                    </button>
                  </td>
                  <td>
                    <span className={`badge ${profileStatusTone(profile.status)}`}>
                      {profile.status}
                    </span>
                  </td>
                  <td>{profile.calibrationVersion}</td>
                  <td>
                    {profile.frameWidth !== null && profile.frameHeight !== null
                      ? `${profile.frameWidth}×${profile.frameHeight}`
                      : '—'}
                  </td>
                  <td>{profile.orientation}</td>
                  <td>{profile.cameraMount}</td>
                  <td>{profile.zoneCount}</td>
                  <td>{formatDate(profile.updatedAt)}</td>
                  <td>
                    {profile.status === 'DRAFT' ? (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void action(() =>
                            api(
                              `/camera-calibration-profiles/${profile.id}/activate`,
                              { method: 'POST' },
                            ),
                          )
                        }
                      >
                        Activate
                      </button>
                    ) : null}{' '}
                    {profile.status !== 'ARCHIVED' ? (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void action(() =>
                            api(
                              `/camera-calibration-profiles/${profile.id}/archive`,
                              { method: 'POST' },
                            ),
                          )
                        }
                      >
                        Archive
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {profileList.length === 0 ? (
            <p className="muted">No profiles yet — create one above.</p>
          ) : null}

          {detail ? (
            <>
              <h2>
                Profile: {detail.name}{' '}
                <span className={`badge ${profileStatusTone(detail.status)}`}>
                  {detail.status}
                </span>
              </h2>
              <p className="muted">
                v{detail.calibrationVersion} · created{' '}
                {formatDate(detail.createdAt)}
                {detail.activatedAt
                  ? ` · activated ${formatDate(detail.activatedAt)}`
                  : ''}
                {detail.archivedAt
                  ? ` · archived ${formatDate(detail.archivedAt)}`
                  : ''}
                {detail.notes ? ` · ${detail.notes}` : ''}
              </p>
              {detailEditable ? (
                editingMeta ? (
                  <div className="form-row">
                    <input
                      placeholder="Name"
                      value={eName}
                      onChange={(e) => setEName(e.target.value)}
                    />
                    <select
                      value={eOrientation}
                      onChange={(e) =>
                        setEOrientation(
                          e.target.value as CameraCalibrationOrientation,
                        )
                      }
                    >
                      {ORIENTATIONS.map((option) => (
                        <option key={option} value={option}>
                          Orientation: {option}
                        </option>
                      ))}
                    </select>
                    <select
                      value={eMount}
                      onChange={(e) =>
                        setEMount(e.target.value as CameraCalibrationMount)
                      }
                    >
                      {MOUNTS.map((option) => (
                        <option key={option} value={option}>
                          Mount: {option}
                        </option>
                      ))}
                    </select>
                    <input
                      placeholder="Frame width px"
                      inputMode="numeric"
                      value={eFrameWidth}
                      onChange={(e) => setEFrameWidth(e.target.value)}
                    />
                    <input
                      placeholder="Frame height px"
                      inputMode="numeric"
                      value={eFrameHeight}
                      onChange={(e) => setEFrameHeight(e.target.value)}
                    />
                    <textarea
                      placeholder="Notes (screened — no URLs or paths)"
                      value={eNotes}
                      onChange={(e) => setENotes(e.target.value)}
                    />
                    <button
                      className="primary"
                      disabled={busy || !eName.trim()}
                      onClick={() =>
                        void action(() =>
                          api(`/camera-calibration-profiles/${detail.id}`, {
                            method: 'PATCH',
                            body: {
                              name: eName.trim(),
                              orientation: eOrientation,
                              cameraMount: eMount,
                              ...(eFrameWidth.trim()
                                ? { frameWidth: Number(eFrameWidth) }
                                : {}),
                              ...(eFrameHeight.trim()
                                ? { frameHeight: Number(eFrameHeight) }
                                : {}),
                              ...(eNotes.trim()
                                ? { notes: eNotes.trim() }
                                : {}),
                            },
                          }),
                        ).then(() => setEditingMeta(false))
                      }
                    >
                      Save metadata
                    </button>
                    <button disabled={busy} onClick={() => setEditingMeta(false)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <p>
                    <button onClick={() => startEditMeta(detail)}>
                      Edit metadata
                    </button>
                  </p>
                )
              ) : null}

              <h2>Zones ({detail.zones.length})</h2>
              <table>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Label</th>
                    <th>Points</th>
                    <th>Quality</th>
                    <th>Active</th>
                    <th>Order</th>
                    <th>Expected products</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.zones.map((zone) => (
                    <tr key={zone.id}>
                      <td>{zone.zoneType}</td>
                      <td>{zone.label}</td>
                      <td title={polygonToInput(zone.polygon)}>
                        {zone.polygon.length}
                      </td>
                      <td>{zone.qualityScore ?? '—'}</td>
                      <td>{zone.isActive ? 'yes' : 'no'}</td>
                      <td>{zone.sortOrder}</td>
                      <td>
                        {zone.expectedProducts.length > 0
                          ? zone.expectedProducts.map((p) => p.sku).join(', ')
                          : '—'}
                      </td>
                      <td>
                        {detailEditable ? (
                          <>
                            <button
                              disabled={busy}
                              onClick={() => startEditZone(zone)}
                            >
                              Edit
                            </button>{' '}
                            <button
                              disabled={busy}
                              onClick={() =>
                                void action(() =>
                                  api(
                                    `/camera-calibration-profiles/${detail.id}/zones/${zone.id}`,
                                    { method: 'DELETE' },
                                  ),
                                ).then(() => {
                                  if (editingZoneId === zone.id) {
                                    resetZoneForm();
                                  }
                                })
                              }
                            >
                              Delete
                            </button>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {detail.zones.length === 0 ? (
                <p className="muted">No zones yet — add one below.</p>
              ) : null}

              {detailEditable ? (
                <>
                  <h3>{editingZoneId ? 'Edit zone' : 'Add zone'}</h3>
                  <div className="form-row">
                    <select
                      value={zType}
                      onChange={(e) =>
                        setZType(e.target.value as CameraCalibrationZoneType)
                      }
                    >
                      {ZONE_TYPES.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                    <input
                      placeholder="Label (screened)"
                      value={zLabel}
                      onChange={(e) => setZLabel(e.target.value)}
                    />
                    <textarea
                      placeholder={'Normalized polygon — one x,y per line (0..1), e.g.\n0.1,0.2\n0.9,0.2\n0.5,0.8'}
                      rows={5}
                      value={zPolygon}
                      onChange={(e) => setZPolygon(e.target.value)}
                    />
                    <input
                      placeholder="Quality 0..1 (optional)"
                      inputMode="decimal"
                      value={zQuality}
                      onChange={(e) => setZQuality(e.target.value)}
                    />
                    <input
                      placeholder="Sort order"
                      inputMode="numeric"
                      value={zSortOrder}
                      onChange={(e) => setZSortOrder(e.target.value)}
                    />
                    <label>
                      <input
                        type="checkbox"
                        checked={zActive}
                        onChange={(e) => setZActive(e.target.checked)}
                      />{' '}
                      active
                    </label>
                    {zType === 'SHELF_ZONE' ? (
                      <input
                        placeholder="Expected product ids (comma/space separated)"
                        value={zProductIds}
                        onChange={(e) => setZProductIds(e.target.value)}
                      />
                    ) : null}
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => void submitZone()}
                    >
                      {editingZoneId ? 'Save zone' : 'Add zone'}
                    </button>
                    {editingZoneId ? (
                      <button disabled={busy} onClick={() => resetZoneForm()}>
                        Cancel edit
                      </button>
                    ) : null}
                  </div>
                </>
              ) : (
                <p className="muted">
                  Archived profiles are read-only — create or activate another
                  profile to change zones.
                </p>
              )}
            </>
          ) : null}

          <h2>Pilot hardening report</h2>
          {report.data ? (
            <>
              <p className="muted">
                Source <StatusBadge status={report.data.sourceStatus} /> ·
                zones {report.data.zoneSummary.total} (shelf{' '}
                {report.data.zoneSummary.shelfZones} · interaction{' '}
                {report.data.zoneSummary.interactionZones} · ignore{' '}
                {report.data.zoneSummary.ignoreZones} · entry/exit{' '}
                {report.data.zoneSummary.entryExitZones}) · shelf zones with
                products {report.data.expectedProductsSummary.shelfZonesWithProducts}{' '}
                · products {report.data.expectedProductsSummary.productCount}
              </p>
              <p className="muted">
                Latest live session:{' '}
                {report.data.latestLiveSessionSummary ? (
                  <>
                    <Link
                      to={`/live-sessions/${report.data.latestLiveSessionSummary.id}`}
                    >
                      {report.data.latestLiveSessionSummary.id}
                    </Link>{' '}
                    ({report.data.latestLiveSessionSummary.status}) · frames{' '}
                    {report.data.latestLiveSessionSummary.framesSampled} ·
                    windows{' '}
                    {report.data.latestLiveSessionSummary.eventWindowsDetected}{' '}
                    · review needed{' '}
                    {report.data.latestLiveSessionSummary.reviewNeeded}
                  </>
                ) : (
                  'none yet'
                )}
                {' · '}
                Performance:{' '}
                {report.data.latestPerformanceSummary ? (
                  <>
                    fast mode{' '}
                    {report.data.latestPerformanceSummary.fastMode === null
                      ? 'unknown'
                      : report.data.latestPerformanceSummary.fastMode
                        ? 'ON'
                        : 'OFF'}
                    {report.data.latestPerformanceSummary.slowestStage
                      ? ` · slowest ${report.data.latestPerformanceSummary.slowestStage.stage} (p95 ${report.data.latestPerformanceSummary.slowestStage.p95Ms}ms)`
                      : ''}
                  </>
                ) : (
                  'unknown'
                )}
              </p>
              {report.data.recommendedNextActions.length > 0 ? (
                <>
                  <p>Recommended next actions:</p>
                  <ul>
                    {report.data.recommendedNextActions.map((nextAction) => (
                      <li key={nextAction}>{formatNextAction(nextAction)}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="muted">No recommendations — ready for testing.</p>
              )}
              <p className="muted">
                Safety — mutations from CV: orders {report.data.safety.orders}{' '}
                · checkout {report.data.safety.checkoutSessions} · payment
                intents {report.data.safety.paymentIntents} · payment events{' '}
                {report.data.safety.paymentEvents} · inventory{' '}
                {report.data.safety.inventoryMovements} (structural —
                shadow-mode guard)
              </p>
            </>
          ) : report.error ? (
            <p className="muted">Pilot hardening report unavailable.</p>
          ) : (
            <p className="muted">Report loading…</p>
          )}

          <p className="muted">
            Shadow mode — calibration describes the camera view for testing
            only; it never creates checkout sessions, orders, payments, or
            inventory movements, and never stores stream URLs, file paths, or
            credentials.
          </p>
        </div>
      ) : null}
    </Page>
  );
}
