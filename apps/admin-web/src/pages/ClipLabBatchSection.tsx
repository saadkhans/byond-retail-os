import { ChangeEvent, DragEvent, FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  apiUpload,
  ClipLabReport,
  CvTestScenario,
  GroundTruthEventKind,
  GroundTruthView,
  Paginated,
  PlanogramRackView,
  Product,
  ScreeningPreview,
  ScreeningPreviewFrame,
  setToken,
  Store,
  VideoAsset,
} from '../api';
import { createSequentialRunner, RunnerSnapshot, SequentialRunner } from '../clip-batch-runner';
import {
  AGREEMENT_LABELS,
  ClipNameParse,
  countAgreements,
  DEFAULT_SKU_ALIASES,
  distinctSkuTokens,
  GroundTruthRow,
  GroundTruthSuggestion,
  isVideoFilename,
  matchUploadedAssets,
  PARSE_REASON_LABELS,
  parseClipFilename,
  previewIsFresh,
  resolveProductForToken,
  sanitizeFilenameLikeServer,
  suggestGroundTruth,
  truthAgreement,
  validateGroundTruthRow,
} from '../clip-batch-utils';
import { parseRegion, percentLabel } from '../clip-lab-utils';
import { Badge, DataTable, Notice, useLoad } from '../components';
import { errorText, labelFor, MATCH_LABELS, STEP_BADGE, STEP_LABELS, useStoreUnits } from './clip-lab-shared';
import { UPLOAD_ATTESTATIONS } from './VideoAssetsPage';

/**
 * Clip Lab — Batch upload. One-time settings (store, unit, rack, the
 * operator attestations), then a whole folder of named clips goes in as a
 * client-side SEQUENTIAL loop over the same single-file upload the
 * single-clip tab uses. Every server gate stays exactly as it is: one
 * file per request, attestations per request, a human screening decision
 * per clip, ground truth saved only on the operator's action.
 */

const SETTINGS_KEY = 'clip-batch:settings';
const APPROVE_DECISION = 'APPROVE';
const REJECT_DECISION = 'REJECT';
const SCENARIOS: CvTestScenario[] = [
  'PICKUP_SINGLE',
  'RETURN_SINGLE',
  'FALSE_TOUCH',
  'TWO_SIMILAR_PICK_ONE',
  'TWO_VISIBLE_PICK_ONE',
  'VLM_UNAVAILABLE',
  'VLM_INVALID_SKU',
];

type UploadStatus = 'queued' | 'resumed' | 'uploading' | 'uploaded' | 'failed';
type TruthStatus = 'suggested' | 'saved' | 'changed' | 'invalid' | 'failed' | 'saving';
type RunStatus = 'idle' | 'running' | 'done' | 'failed';
type Stage = 'idle' | 'upload' | 'preview' | 'approve' | 'truth' | 'run';

interface BatchRow {
  key: string;
  fileName: string;
  file: File | null;
  parse: ClipNameParse;
  suggestion: GroundTruthSuggestion | null;
  asset: VideoAsset | null;
  uploadStatus: UploadStatus;
  uploadError: string | null;
  preview: { frames: ScreeningPreviewFrame[]; at: number; durationMs: number } | null;
  screeningError: string | null;
  truth: GroundTruthRow;
  truthStatus: TruthStatus;
  truthError: string | null;
  report: ClipLabReport | null;
  runStatus: RunStatus;
  runError: string | null;
}

interface BatchSettings {
  locationId: string;
  unitId: string;
  rackCode: string;
  region: { rx: string; ry: string; rw: string; rh: string };
  aliases: Record<string, string>;
}

const EMPTY_SETTINGS: BatchSettings = {
  locationId: '',
  unitId: '',
  rackCode: '',
  region: { rx: '', ry: '', rw: '', rh: '' },
  aliases: { ...DEFAULT_SKU_ALIASES },
};

function loadSettings(): BatchSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return EMPTY_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<BatchSettings>;
    return {
      ...EMPTY_SETTINGS,
      ...parsed,
      region: { ...EMPTY_SETTINGS.region, ...(parsed.region ?? {}) },
      aliases: { ...DEFAULT_SKU_ALIASES, ...(parsed.aliases ?? {}) },
    };
  } catch {
    return EMPTY_SETTINGS;
  }
}

function saveSettings(settings: BatchSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage may be unavailable (private window); the form still works.
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function emptyTruth(): GroundTruthRow {
  return { eventKind: 'PICKUP', productId: null, testType: null, actualTimestampMs: null, quantity: 1, note: '' };
}

function truthFromSuggestion(
  suggestion: GroundTruthSuggestion | null,
  products: Product[],
  aliases: Record<string, string>,
): GroundTruthRow {
  if (!suggestion) return emptyTruth();
  const resolved = suggestion.productToken
    ? resolveProductForToken(suggestion.productToken, products, aliases)
    : null;
  return {
    eventKind: suggestion.eventKind,
    productId: resolved && resolved.status === 'RESOLVED' ? resolved.product.id : null,
    testType: suggestion.testType,
    actualTimestampMs: suggestion.actualTimestampMs,
    quantity: suggestion.quantity,
    note: suggestion.note,
  };
}

function truthFromServer(view: GroundTruthView): GroundTruthRow {
  return {
    eventKind: view.eventKind,
    productId: view.productId,
    testType: view.testType,
    actualTimestampMs: view.actualTimestampMs,
    quantity: view.quantity,
    note: view.note ?? '',
  };
}

function makeRow(file: File | null, fileName: string, products: Product[], aliases: Record<string, string>): BatchRow {
  const parse = parseClipFilename(fileName);
  const suggestion = parse.ok ? suggestGroundTruth(parse.parsed) : null;
  return {
    key: sanitizeFilenameLikeServer(fileName),
    fileName,
    file,
    parse,
    suggestion,
    asset: null,
    uploadStatus: 'queued',
    uploadError: null,
    preview: null,
    screeningError: null,
    truth: truthFromSuggestion(suggestion, products, aliases),
    truthStatus: 'suggested',
    truthError: null,
    report: null,
    runStatus: 'idle',
    runError: null,
  };
}

/** Walks a dropped folder when the browser exposes the entry API; falls back to the flat file list. */
async function filesFromDrop(dataTransfer: DataTransfer): Promise<File[]> {
  const items = Array.from(dataTransfer.items ?? []);
  const entries = items
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
    .filter((entry): entry is FileSystemEntry => entry !== null);
  if (entries.length === 0) {
    return Array.from(dataTransfer.files);
  }
  const out: File[] = [];
  async function walk(entry: FileSystemEntry): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      out.push(file);
      return;
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const children = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      for (const child of children) {
        await walk(child);
      }
    }
  }
  for (const entry of entries) {
    await walk(entry);
  }
  return out;
}

function isUploaded(row: BatchRow): boolean {
  return row.asset !== null && (row.uploadStatus === 'uploaded' || row.uploadStatus === 'resumed');
}

function isApproved(row: BatchRow): boolean {
  return (
    isUploaded(row) &&
    row.asset!.status !== 'QUARANTINED' &&
    row.asset!.status !== 'REJECTED' &&
    row.asset!.status !== 'FAILED'
  );
}

// ------------------------------------------------------------- section

export function ClipLabBatchSection() {
  const [settings, setSettings] = useState<BatchSettings>(loadSettings);
  const [attested, setAttested] = useState<Record<string, boolean>>({});
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [skippedCount, setSkippedCount] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const [stage, setStage] = useState<Stage>('idle');
  const [snapshot, setSnapshot] = useState<RunnerSnapshot | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'critical' | 'info'; text: string } | null>(null);
  const [resumeBusy, setResumeBusy] = useState(false);
  const runnerRef = useRef<SequentialRunner<string> | null>(null);
  const rowsRef = useRef<BatchRow[]>([]);
  rowsRef.current = rows;
  const folderInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);

  const stores = useLoad<Paginated<Store>>(() => api('/stores?take=100'), []);
  const products = useLoad<Paginated<Product>>(() => api('/catalog/products?take=100&status=ACTIVE'), []);
  const productList = useMemo(() => products.data?.items ?? [], [products.data]);
  const racks = useLoad<{ racks: PlanogramRackView[] } | PlanogramRackView[]>(
    () =>
      settings.locationId
        ? api(`/planograms/racks?locationId=${encodeURIComponent(settings.locationId)}`)
        : Promise.resolve([]),
    [settings.locationId],
  );
  const rackList: PlanogramRackView[] = Array.isArray(racks.data) ? racks.data : (racks.data?.racks ?? []);
  const units = useStoreUnits(settings.locationId);
  const unitList = units.data?.items ?? [];

  useEffect(() => {
    folderInput.current?.setAttribute('webkitdirectory', '');
  }, []);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  // A store with exactly one unit needs no choice — pre-select it.
  useEffect(() => {
    if (!settings.unitId && unitList.length === 1) {
      setSettings((s) => ({ ...s, unitId: unitList[0].id }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitList.length]);

  const allAttested = UPLOAD_ATTESTATIONS.every(({ field }) => attested[field]);
  const regionParsed = parseRegion(settings.region);
  const settingsReady = Boolean(
    settings.locationId && settings.unitId && settings.rackCode && allAttested && !regionParsed.error,
  );
  const tokens = useMemo(() => distinctSkuTokens(rows.map((row) => row.parse)), [rows]);
  const busy = stage !== 'idle' && snapshot?.state === 'running';
  const authExpired = snapshot?.state === 'auth_expired';

  function updateRow(key: string, patch: Partial<BatchRow> | ((row: BatchRow) => Partial<BatchRow>)) {
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, ...(typeof patch === 'function' ? patch(row) : patch) } : row)),
    );
  }

  function rowByKey(key: string): BatchRow | undefined {
    return rowsRef.current.find((row) => row.key === key);
  }

  // ---------------------------------------------------------- files

  function addFiles(files: File[]) {
    const videos = files.filter((file) => isVideoFilename(file.name));
    setSkippedCount((n) => n + (files.length - videos.length));
    setRows((current) => {
      const next = [...current];
      const seen = new Set(current.map((row) => row.key));
      for (const file of videos) {
        const key = sanitizeFilenameLikeServer(file.name);
        const existingIndex = next.findIndex((row) => row.key === key);
        if (existingIndex >= 0) {
          // Re-picked after a refresh: attach the File to the server-side row.
          next[existingIndex] = { ...next[existingIndex], file, fileName: file.name };
          continue;
        }
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(makeRow(file, file.name, productList, settings.aliases));
      }
      return next;
    });
  }

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    addFiles(Array.from(event.target.files ?? []));
    event.target.value = '';
  }

  async function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    addFiles(await filesFromDrop(event.dataTransfer));
  }

  // --------------------------------------------------------- resume

  async function fetchStoreAssets(locationId: string): Promise<VideoAsset[]> {
    const all: VideoAsset[] = [];
    let skip = 0;
    for (;;) {
      const page = await api<Paginated<VideoAsset>>(
        `/video-assets?locationId=${encodeURIComponent(locationId)}&take=100&skip=${skip}`,
      );
      all.push(...page.items);
      skip += page.items.length;
      if (page.items.length === 0 || skip >= page.total) break;
    }
    return all;
  }

  async function checkAlreadyUploaded() {
    if (!settings.locationId) return;
    setResumeBusy(true);
    setNotice(null);
    try {
      const assets = await fetchStoreAssets(settings.locationId);
      const current = rowsRef.current;
      const matched = matchUploadedAssets(current.map((row) => ({ name: row.fileName })), assets);
      const known = new Set(current.map((row) => row.key));
      const serverOnly = assets.filter((asset) => {
        const key = sanitizeFilenameLikeServer(asset.originalFilename);
        return !known.has(key) && parseClipFilename(asset.originalFilename).ok && asset.status !== 'REJECTED' && asset.status !== 'FAILED';
      });
      const additions = serverOnly.map((asset) => ({
        ...makeRow(null, asset.originalFilename, productList, settings.aliases),
        asset,
        uploadStatus: 'resumed' as const,
      }));
      setRows((prev) => [
        ...prev.map((row) => {
          const asset = matched.get(row.key);
          return asset ? { ...row, asset, uploadStatus: 'resumed' as const, uploadError: null } : row;
        }),
        ...additions,
      ]);
      // Existing ground truth for resumed rows, one request at a time.
      const resumedKeys = [...matched.keys(), ...additions.map((row) => row.key)];
      for (const key of resumedKeys) {
        const asset = matched.get(key) ?? additions.find((row) => row.key === key)?.asset;
        if (!asset) continue;
        try {
          const view = await api<GroundTruthView | null>(`/video-assets/${asset.id}/ground-truth`);
          if (view && view.eventKind) {
            updateRow(key, { truth: truthFromServer(view), truthStatus: 'saved' });
          }
        } catch {
          // No ground truth yet — keep the suggestion.
        }
      }
      setNotice({
        tone: 'info',
        text: `${matched.size + additions.length} clip(s) already uploaded at this store were matched by name.`,
      });
    } catch (err) {
      setNotice({ tone: 'critical', text: errorText(err) });
    } finally {
      setResumeBusy(false);
    }
  }

  // --------------------------------------------------------- runners

  function startStage(next: Stage, keys: string[], work: (row: BatchRow) => Promise<void>) {
    if (busy || keys.length === 0) return;
    setStage(next);
    setNotice(null);
    const runner = createSequentialRunner<string>({
      work: async (key) => {
        const row = rowByKey(key);
        if (row) await work(row);
      },
      onChange: (s) => {
        setSnapshot(s);
        if (s.state === 'done' || s.state === 'cancelled') {
          setStage('idle');
        }
      },
    });
    runnerRef.current = runner;
    runner.start(keys);
  }

  async function uploadOne(row: BatchRow) {
    if (!row.file) {
      updateRow(row.key, { uploadStatus: 'failed', uploadError: 'file not picked in this session' });
      return;
    }
    updateRow(row.key, { uploadStatus: 'uploading', uploadError: null });
    const formData = new FormData();
    formData.append('file', row.file);
    const headers: Record<string, string> = {};
    for (const { field, header } of UPLOAD_ATTESTATIONS) {
      formData.append(field, 'true');
      headers[header] = 'true';
    }
    formData.append('locationId', settings.locationId);
    formData.append('unitId', settings.unitId);
    formData.append('planogramRackCode', settings.rackCode);
    if (regionParsed.region) {
      formData.append('rackFrameRegion', JSON.stringify(regionParsed.region));
    }
    try {
      const asset = await apiUpload<VideoAsset>('/video-assets', formData, headers);
      updateRow(row.key, { asset, uploadStatus: 'uploaded', uploadError: null });
    } catch (err) {
      updateRow(row.key, { uploadStatus: 'failed', uploadError: errorText(err) });
      throw err;
    }
  }

  function uploadAll() {
    const keys = rows.filter((row) => row.uploadStatus === 'queued' || row.uploadStatus === 'failed').map((row) => row.key);
    startStage('upload', keys, uploadOne);
  }

  async function previewOne(row: BatchRow) {
    if (!row.asset) return;
    try {
      const preview = await api<ScreeningPreview>(`/video-assets/${row.asset.id}/screening-preview`, {
        method: 'POST',
        body: {},
      });
      updateRow(row.key, {
        preview: { frames: preview.frames, at: Date.now(), durationMs: preview.durationMs },
        screeningError: null,
      });
    } catch (err) {
      updateRow(row.key, { screeningError: errorText(err) });
      throw err;
    }
  }

  function quarantinedRows(): BatchRow[] {
    return rowsRef.current.filter((row) => isUploaded(row) && row.asset!.status === 'QUARANTINED');
  }

  function loadFramesForAll() {
    startStage('preview', quarantinedRows().filter((row) => !row.preview).map((row) => row.key), previewOne);
  }

  async function decideOne(row: BatchRow, decision: string) {
    if (!row.asset) return;
    try {
      const updated = await api<Partial<VideoAsset> | null>(`/video-assets/${row.asset.id}/screening`, {
        method: 'POST',
        body: { decision },
      });
      const status = decision === REJECT_DECISION ? 'REJECTED' : (updated?.status ?? 'UPLOADED');
      updateRow(row.key, (current) => ({
        asset: current.asset ? { ...current.asset, status } : current.asset,
        preview: null,
        screeningError: null,
      }));
    } catch (err) {
      updateRow(row.key, { screeningError: errorText(err) });
      throw err;
    }
  }

  async function approveOne(row: BatchRow) {
    // The server accepts an approval only within 30 min of a served
    // preview — re-preview first when this card's frames are stale.
    let current = rowByKey(row.key) ?? row;
    if (!current.preview || !previewIsFresh(current.preview.at, Date.now())) {
      await previewOne(current);
      current = rowByKey(row.key) ?? current;
    }
    if (!current.preview || current.preview.frames.length === 0) {
      updateRow(row.key, { screeningError: 'no frames were shown for this clip' });
      return;
    }
    await decideOne(current, APPROVE_DECISION);
  }

  function approveAllPreviewed() {
    const keys = quarantinedRows()
      .filter((row) => row.preview && row.preview.frames.length > 0)
      .map((row) => row.key);
    startStage('approve', keys, approveOne);
  }

  function setTruth(key: string, patch: Partial<GroundTruthRow>) {
    updateRow(key, (row) => ({ truth: { ...row.truth, ...patch }, truthStatus: 'changed', truthError: null }));
  }

  function applyDefaultsToAll() {
    setRows((current) =>
      current.map((row) =>
        row.truthStatus === 'saved'
          ? row
          : { ...row, truth: truthFromSuggestion(row.suggestion, productList, settings.aliases), truthStatus: 'suggested', truthError: null },
      ),
    );
  }

  async function saveTruthOne(row: BatchRow) {
    if (!row.asset) return;
    const current = rowByKey(row.key) ?? row;
    if (!current.asset) return;
    const problem = validateGroundTruthRow(current.truth, current.preview?.durationMs ?? current.asset.durationMs ?? null);
    if (problem) {
      updateRow(row.key, { truthStatus: 'invalid', truthError: problem });
      return;
    }
    updateRow(row.key, { truthStatus: 'saving', truthError: null });
    try {
      await api(`/video-assets/${current.asset.id}/ground-truth`, {
        method: 'PUT',
        body: {
          eventKind: current.truth.eventKind,
          ...(current.truth.productId ? { productId: current.truth.productId } : {}),
          ...(current.truth.actualTimestampMs !== null ? { actualTimestampMs: current.truth.actualTimestampMs } : {}),
          quantity: current.truth.quantity,
          ...(current.truth.note ? { note: current.truth.note } : {}),
          ...(current.truth.testType ? { testType: current.truth.testType } : {}),
        },
      });
      updateRow(row.key, { truthStatus: 'saved', truthError: null });
    } catch (err) {
      updateRow(row.key, { truthStatus: 'failed', truthError: errorText(err) });
      throw err;
    }
  }

  function saveAllTruth() {
    const keys = rowsRef.current
      .filter((row) => isUploaded(row) && row.asset!.status !== 'REJECTED' && row.truthStatus !== 'saved')
      .map((row) => row.key);
    startStage('truth', keys, saveTruthOne);
  }

  async function runOne(row: BatchRow) {
    if (!row.asset) return;
    updateRow(row.key, { runStatus: 'running', runError: null });
    try {
      let report = await api<ClipLabReport>(`/video-assets/${row.asset.id}/lab-run`, { method: 'POST', body: {} });
      if (report.providers.some((provider) => provider.reasonCode === 'RUNTIME_BUSY')) {
        await sleep(3000);
        report = await api<ClipLabReport>(`/video-assets/${row.asset.id}/lab-run`, { method: 'POST', body: {} });
      }
      updateRow(row.key, { report, runStatus: 'done' });
    } catch (err) {
      updateRow(row.key, { runStatus: 'failed', runError: errorText(err) });
      throw err;
    }
  }

  function runAll() {
    startStage('run', rowsRef.current.filter(isApproved).map((row) => row.key), runOne);
  }

  async function reLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '');
    const password = String(form.get('password') ?? '');
    setNotice(null);
    try {
      const result = await api<{ accessToken: string }>('/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      setToken(result.accessToken);
      runnerRef.current?.resume();
    } catch (err) {
      setNotice({ tone: 'critical', text: errorText(err) });
    }
  }

  // ------------------------------------------------------- derived

  const uploadedCount = rows.filter(isUploaded).length;
  const quarantined = rows.filter((row) => isUploaded(row) && row.asset!.status === 'QUARANTINED');
  const truthRows = rows.filter((row) => isUploaded(row) && row.asset!.status !== 'REJECTED');
  const runnable = rows.filter(isApproved);
  const reports = rows.filter((row) => row.report !== null);
  const agreements = countAgreements(reports.map((row) => truthAgreement(row.report!)));
  const stageLabel: Record<Stage, string> = {
    idle: '',
    upload: 'Uploading',
    preview: 'Loading frames',
    approve: 'Approving',
    truth: 'Saving ground truth',
    run: 'Running analysis',
  };

  return (
    <div className="batch-steps">
      <Notice tone="info">
        Batch upload keeps every safeguard of the single-clip flow: one file per request, the
        attestations recorded per clip, a human screening decision per clip, and ground truth saved
        only when you save it. Files named <code>r1_cell_sku_type_light_nn.mp4</code> are understood
        and pre-filled; other names still upload.
      </Notice>

      {/* ---------------------------------------------------- B1 */}
      <section className="detail">
        <h3>1. Batch settings (entered once)</h3>
        <div className="toolbar">
          <label>
            Store *{' '}
            <select
              value={settings.locationId}
              onChange={(e) => setSettings({ ...settings, locationId: e.target.value, unitId: '', rackCode: '' })}
              disabled={busy}
            >
              <option value="">— store —</option>
              {(stores.data?.items ?? []).map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name} ({store.code})
                </option>
              ))}
            </select>
          </label>
          <label>
            Unit *{' '}
            <select
              value={settings.unitId}
              onChange={(e) => setSettings({ ...settings, unitId: e.target.value })}
              disabled={!settings.locationId || busy}
            >
              <option value="">{settings.locationId ? '— unit —' : 'pick a store first'}</option>
              {unitList.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.name} ({unit.code})
                </option>
              ))}
            </select>
          </label>
          <label>
            Rack *{' '}
            <select
              value={settings.rackCode}
              onChange={(e) => setSettings({ ...settings, rackCode: e.target.value })}
              disabled={!settings.locationId || busy}
            >
              <option value="">{settings.locationId ? '— rack —' : 'pick a store first'}</option>
              {rackList.map((rack) => (
                <option key={rack.rackId} value={rack.rackCode}>
                  {rack.rackCode} · {rack.rows}×{rack.columns} v{rack.version}
                </option>
              ))}
            </select>
          </label>
        </div>
        {settings.locationId && !racks.loading && rackList.length === 0 ? (
          <p className="error">
            No ACTIVE planogram rack at this store. Publish one on the{' '}
            <Link to="/pretrained-vision">Pretrained vision</Link> page first.
          </p>
        ) : null}
        <div className="toolbar">
          <span className="muted">Rack region in frame (optional — leave blank if the rack fills the frame)</span>
          {(['rx', 'ry', 'rw', 'rh'] as const).map((key) => (
            <input
              key={key}
              placeholder={key}
              style={{ width: '4.5em' }}
              value={settings.region[key]}
              onChange={(e) => setSettings({ ...settings, region: { ...settings.region, [key]: e.target.value } })}
              disabled={busy}
            />
          ))}
        </div>
        {regionParsed.error ? <p className="error">{regionParsed.error}</p> : null}
        <div>
          <p className="muted">Operator attestations * (declared once here, recorded with every clip in this batch)</p>
          {UPLOAD_ATTESTATIONS.map(({ field, label, title }) => (
            <label key={field} title={title} style={{ display: 'block' }}>
              <input
                type="checkbox"
                checked={Boolean(attested[field])}
                onChange={(e) => setAttested({ ...attested, [field]: e.target.checked })}
                disabled={busy}
              />{' '}
              {label}
            </label>
          ))}
        </div>
        {tokens.length > 0 ? (
          <div>
            <p className="muted">Product aliases — the SKU token in each file name maps to a catalog product:</p>
            <div className="toolbar">
              {tokens.map((token) => {
                const resolved = resolveProductForToken(token, productList, settings.aliases);
                return (
                  <label key={token}>
                    <code>{token}</code> →{' '}
                    <select
                      value={resolved.status === 'RESOLVED' ? resolved.product.sku : ''}
                      onChange={(e) => {
                        const aliases = { ...settings.aliases, [token]: e.target.value };
                        setSettings({ ...settings, aliases });
                        setRows((current) =>
                          current.map((row) =>
                            row.truthStatus === 'saved'
                              ? row
                              : { ...row, truth: truthFromSuggestion(row.suggestion, productList, aliases) },
                          ),
                        );
                      }}
                      disabled={busy}
                    >
                      <option value="">— product —</option>
                      {productList.map((product) => (
                        <option key={product.id} value={product.sku}>
                          {product.name} ({product.sku})
                        </option>
                      ))}
                    </select>{' '}
                    {resolved.status === 'AMBIGUOUS' ? <Badge tone="warn">ambiguous</Badge> : null}
                    {resolved.status === 'UNRESOLVED' ? <Badge tone="warn">not found</Badge> : null}
                  </label>
                );
              })}
            </div>
          </div>
        ) : null}
        {!settingsReady ? <p className="muted">Complete every * field to enable the upload.</p> : null}
      </section>

      {/* ---------------------------------------------------- B2 */}
      <section className="detail">
        <h3>2. Pick the clips</h3>
        <div className="toolbar">
          <label>
            Choose folder{' '}
            <input ref={folderInput} type="file" multiple onChange={onPick} disabled={busy} />
          </label>
          <label>
            Choose files{' '}
            <input
              ref={filesInput}
              type="file"
              multiple
              accept="video/mp4,video/quicktime,video/webm"
              onChange={onPick}
              disabled={busy}
            />
          </label>
          <button type="button" onClick={() => void checkAlreadyUploaded()} disabled={!settings.locationId || resumeBusy || busy}>
            {resumeBusy ? 'Checking…' : 'Check already uploaded'}
          </button>
        </div>
        <div
          className={`batch-drop${dragActive ? ' active' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(e) => void onDrop(e)}
        >
          Drop a folder or files here
        </div>
        {skippedCount > 0 ? <p className="muted">Skipped {skippedCount} non-video file(s).</p> : null}
      </section>

      {/* ---------------------------------------------------- B3 */}
      <section className="detail">
        <h3>3. Upload</h3>
        <div className="toolbar">
          <button className="primary" type="button" onClick={uploadAll} disabled={!settingsReady || busy || rows.every((row) => row.uploadStatus !== 'queued' && row.uploadStatus !== 'failed')}>
            Upload all
          </button>
          <button type="button" onClick={() => runnerRef.current?.pause()} disabled={!busy}>
            Pause
          </button>
          <button type="button" onClick={() => runnerRef.current?.resume()} disabled={snapshot?.state !== 'paused'}>
            Resume
          </button>
          <button type="button" onClick={() => runnerRef.current?.cancel()} disabled={!busy && snapshot?.state !== 'paused'}>
            Cancel
          </button>
          {stage !== 'idle' && snapshot ? (
            <span className="muted">
              {stageLabel[stage]} {Math.min(snapshot.index, snapshot.total)} of {snapshot.total}
              {snapshot.failed ? ` · ${snapshot.failed} failed` : ''} · {snapshot.state}
            </span>
          ) : null}
        </div>
        {stage !== 'idle' && snapshot ? (
          <progress className="batch-progress" value={Math.min(snapshot.index, snapshot.total)} max={Math.max(1, snapshot.total)} />
        ) : null}
        {authExpired ? (
          <Notice tone="warn">
            <p>Your session expired — sign in to resume the batch where it stopped.</p>
            <form className="toolbar" onSubmit={(e) => void reLogin(e)}>
              <input name="email" type="email" placeholder="email" autoComplete="username" required />
              <input name="password" type="password" placeholder="password" autoComplete="current-password" required />
              <button className="primary" type="submit">
                Sign in and resume
              </button>
            </form>
          </Notice>
        ) : null}
        {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
        <div className="batch-table">
          <DataTable<BatchRow>
            columns={[
              { key: 'file', header: 'File', render: (row) => <code>{row.fileName}</code> },
              { key: 'cell', header: 'Cell', render: (row) => (row.parse.ok ? row.parse.parsed.cell.toUpperCase() : '—') },
              {
                key: 'sku',
                header: 'SKU → product',
                render: (row) => {
                  if (!row.parse.ok) return '—';
                  const token = row.parse.parsed.skuToken;
                  if (token === 'none') return 'none';
                  const resolved = resolveProductForToken(token, productList, settings.aliases);
                  return resolved.status === 'RESOLVED' ? `${token} → ${resolved.product.sku}` : `${token} → ?`;
                },
              },
              { key: 'kind', header: 'Kind', render: (row) => row.suggestion?.eventKind ?? '—' },
              { key: 'scenario', header: 'Scenario', render: (row) => row.suggestion?.testType ?? '—' },
              { key: 'light', header: 'Light', render: (row) => (row.parse.ok ? row.parse.parsed.light : '—') },
              { key: 'n', header: '#', numeric: true, render: (row) => (row.parse.ok ? String(row.parse.parsed.index) : '—') },
              {
                key: 'status',
                header: 'Status',
                render: (row) => (
                  <>
                    {!row.parse.ok ? (
                      <Badge tone="warn" title={PARSE_REASON_LABELS[row.parse.reason]}>
                        name not understood
                      </Badge>
                    ) : null}{' '}
                    <Badge
                      tone={row.uploadStatus === 'failed' ? 'down' : row.uploadStatus === 'uploaded' || row.uploadStatus === 'resumed' ? 'ok' : 'neutral'}
                      title={row.uploadError ?? ''}
                    >
                      {row.uploadStatus === 'resumed' ? 'already uploaded' : row.uploadStatus}
                      {row.uploadError ? `: ${row.uploadError}` : ''}
                    </Badge>{' '}
                    {row.asset ? <Badge>{row.asset.status}</Badge> : null}{' '}
                    {row.uploadStatus === 'failed' && row.file ? (
                      <button type="button" onClick={() => startStage('upload', [row.key], uploadOne)} disabled={busy}>
                        Retry
                      </button>
                    ) : null}
                  </>
                ),
              },
            ]}
            rows={rows}
            rowKey={(row) => row.key}
            empty="Pick a folder of clips above."
          />
        </div>
      </section>

      {/* ---------------------------------------------------- B4 */}
      <section className="detail">
        <h3>4. Screening review grid *</h3>
        <p className="muted">
          Every clip stays quarantined until you inspect real frames and approve it.{' '}
          <strong>You inspected every frame set shown below</strong> before approving — nothing here
          approves without frames on screen.
        </p>
        <div className="toolbar">
          <button type="button" onClick={loadFramesForAll} disabled={busy || quarantined.every((row) => row.preview !== null)}>
            Load frames for all
          </button>
          <button
            className="primary"
            type="button"
            onClick={approveAllPreviewed}
            disabled={busy || !quarantined.some((row) => row.preview && row.preview.frames.length > 0)}
          >
            Approve all previewed
          </button>
          <span className="muted">
            {quarantined.length} awaiting a decision · {uploadedCount} uploaded
          </span>
        </div>
        {quarantined.length === 0 ? (
          <p className="muted">Nothing awaiting screening.</p>
        ) : (
          <div className="screening-grid">
            {quarantined.map((row) => (
              <div className="card" key={row.key}>
                <div>
                  <code>{row.fileName}</code>{' '}
                  {row.parse.ok ? (
                    <Badge>
                      {row.parse.parsed.cell.toUpperCase()} · {row.parse.parsed.type} · {row.parse.parsed.light}
                    </Badge>
                  ) : null}
                </div>
                {row.preview ? (
                  <div className="frames">
                    {row.preview.frames.map((frame) => (
                      <img
                        key={frame.timestampMs}
                        alt={`frame at ${frame.timestampMs} ms`}
                        src={`data:${frame.mimeType};base64,${frame.imageBase64}`}
                      />
                    ))}
                    {row.preview.frames.length === 0 ? <span className="muted">No frames decoded.</span> : null}
                  </div>
                ) : (
                  <span className="muted">Frames not shown yet.</span>
                )}
                <div className="toolbar">
                  <button type="button" onClick={() => startStage('preview', [row.key], previewOne)} disabled={busy}>
                    Show frames
                  </button>
                  <button
                    className="primary"
                    type="button"
                    onClick={() => startStage('approve', [row.key], approveOne)}
                    disabled={busy || !row.preview || row.preview.frames.length === 0}
                  >
                    Approve
                  </button>
                  <button type="button" onClick={() => startStage('approve', [row.key], (r) => decideOne(r, REJECT_DECISION))} disabled={busy}>
                    Reject
                  </button>
                </div>
                {row.screeningError ? <p className="error">{row.screeningError}</p> : null}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ---------------------------------------------------- B5 */}
      <section className="detail">
        <h3>5. Ground truth (pre-filled from the file names — confirm, then save)</h3>
        <div className="toolbar">
          <button type="button" onClick={applyDefaultsToAll} disabled={busy}>
            Apply defaults to all
          </button>
          <button className="primary" type="button" onClick={saveAllTruth} disabled={busy || truthRows.every((row) => row.truthStatus === 'saved')}>
            Save all
          </button>
          <span className="muted">{truthRows.filter((row) => row.truthStatus === 'saved').length} of {truthRows.length} saved</span>
        </div>
        <div className="batch-table">
          <DataTable<BatchRow>
            columns={[
              { key: 'file', header: 'File', render: (row) => <code>{row.fileName}</code> },
              {
                key: 'kind',
                header: 'Kind',
                render: (row) => (
                  <select value={row.truth.eventKind} onChange={(e) => setTruth(row.key, { eventKind: e.target.value as GroundTruthEventKind })} disabled={busy}>
                    <option value="PICKUP">Pickup</option>
                    <option value="RETURN">Return</option>
                    <option value="NONE">No event</option>
                  </select>
                ),
              },
              {
                key: 'product',
                header: 'Product',
                render: (row) => (
                  <select value={row.truth.productId ?? ''} onChange={(e) => setTruth(row.key, { productId: e.target.value || null })} disabled={busy}>
                    <option value="">— none —</option>
                    {productList.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.name} ({product.sku})
                      </option>
                    ))}
                  </select>
                ),
              },
              {
                key: 'scenario',
                header: 'Scenario',
                render: (row) => (
                  <select value={row.truth.testType ?? ''} onChange={(e) => setTruth(row.key, { testType: (e.target.value || null) as CvTestScenario | null })} disabled={busy}>
                    <option value="">— none —</option>
                    {SCENARIOS.map((scenario) => (
                      <option key={scenario} value={scenario}>
                        {scenario}
                      </option>
                    ))}
                  </select>
                ),
              },
              {
                key: 'ms',
                header: 'Event ms',
                numeric: true,
                render: (row) => (
                  <input
                    style={{ width: '6em' }}
                    value={row.truth.actualTimestampMs ?? ''}
                    onChange={(e) => setTruth(row.key, { actualTimestampMs: e.target.value.trim() === '' ? null : Number(e.target.value) })}
                    disabled={busy}
                  />
                ),
              },
              {
                key: 'qty',
                header: 'Qty',
                numeric: true,
                render: (row) => (
                  <input style={{ width: '3.5em' }} value={row.truth.quantity} onChange={(e) => setTruth(row.key, { quantity: Number(e.target.value) })} disabled={busy} />
                ),
              },
              {
                key: 'note',
                header: 'Note',
                render: (row) => <input style={{ width: '18em' }} value={row.truth.note} onChange={(e) => setTruth(row.key, { note: e.target.value })} disabled={busy} />,
              },
              {
                key: 'status',
                header: 'Status',
                render: (row) => (
                  <>
                    <Badge tone={row.truthStatus === 'saved' ? 'ok' : row.truthStatus === 'invalid' || row.truthStatus === 'failed' ? 'down' : 'neutral'} title={row.suggestion?.hint ?? ''}>
                      {row.truthStatus}
                      {row.truthError ? `: ${row.truthError}` : ''}
                    </Badge>{' '}
                    {row.suggestion?.confidence === 'APPROXIMATED' ? <Badge tone="warn" title={row.suggestion.hint ?? ''}>confirm</Badge> : null}{' '}
                    <button type="button" onClick={() => startStage('truth', [row.key], saveTruthOne)} disabled={busy}>
                      Save
                    </button>
                  </>
                ),
              },
            ]}
            rows={truthRows}
            rowKey={(row) => row.key}
            empty="Ground truth rows appear once clips are uploaded."
          />
        </div>
      </section>

      {/* ---------------------------------------------------- B6 */}
      <section className="detail">
        <h3>6. Run all and compare</h3>
        <div className="toolbar">
          <button className="primary" type="button" onClick={runAll} disabled={busy || runnable.length === 0}>
            Run full analysis on {runnable.length} approved clip(s)
          </button>
          {reports.length > 0 ? (
            <span className="muted">
              {agreements.MATCH} match · {agreements.SKU_MISMATCH} wrong SKU · {agreements.ACTION_MISMATCH} wrong action ·{' '}
              {agreements.NO_SUGGESTION} no suggestion · {agreements.NO_TRUTH} no ground truth
            </span>
          ) : null}
        </div>
        <DataTable<BatchRow>
          columns={[
            { key: 'file', header: 'File', render: (row) => <Link to={row.report!.links.videoAssetPage}>{row.fileName}</Link> },
            {
              key: 'expected',
              header: 'Expected',
              render: (row) =>
                row.report!.asset.groundTruth
                  ? `${row.report!.asset.groundTruth.eventKind} · ${row.report!.asset.groundTruth.sku ?? '—'}`
                  : '—',
            },
            {
              key: 'suggested',
              header: 'Suggested',
              render: (row) => (
                <>
                  {row.report!.suggestion ? `${row.report!.suggestion.sku ?? 'UNKNOWN'} · ${row.report!.suggestion.action}` : '—'}{' '}
                  <Badge tone="warn">Still needs review</Badge>
                </>
              ),
            },
            {
              key: 'agreement',
              header: 'Agreement',
              render: (row) => {
                const agreement = truthAgreement(row.report!);
                return <Badge tone={agreement === 'MATCH' ? 'ok' : agreement === 'NO_TRUTH' ? 'neutral' : 'down'}>{AGREEMENT_LABELS[agreement]}</Badge>;
              },
            },
            {
              key: 'planogram',
              header: 'Planogram',
              render: (row) =>
                row.report!.planogram?.configured
                  ? `${row.report!.planogram.cell ?? 'no cell'} · ${labelFor(row.report!.planogram.matchStatus, MATCH_LABELS)}`
                  : 'not configured',
            },
            {
              key: 'steps',
              header: 'Steps',
              render: (row) => (
                <>
                  {row.report!.steps.map((step) => (
                    <Badge key={step.step} tone={STEP_BADGE[step.status] || 'neutral'} title={step.reasonCode ?? ''}>
                      {labelFor(step.step, STEP_LABELS)} · {step.status}
                    </Badge>
                  ))}
                </>
              ),
            },
            {
              key: 'fused',
              header: 'Fused top',
              numeric: true,
              render: (row) => percentLabel(row.report!.confidence?.fusionTop?.score ?? null),
            },
            {
              key: 'run',
              header: 'Run',
              render: (row) => (
                <Badge tone={row.runStatus === 'done' ? 'ok' : row.runStatus === 'failed' ? 'down' : 'neutral'} title={row.runError ?? ''}>
                  {row.runStatus}
                  {row.runError ? `: ${row.runError}` : ''}
                </Badge>
              ),
            },
          ]}
          rows={reports}
          rowKey={(row) => row.key}
          empty="Run the analysis to see the comparison."
        />
        <p className="muted">
          Fused percentages are uncalibrated ranking signals; they are <strong>not probabilities</strong>. Every
          suggestion is advisory and review-required.
        </p>
      </section>
    </div>
  );
}
