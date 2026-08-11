import { useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  ImportPreview,
  ImportReport,
  Paginated,
  Product,
  ReferenceLibraryStatus,
  ReferenceOverviewRow,
  api,
  apiObjectUrl,
  apiUpload,
} from '../api';
import { Page, useLoad } from '../components';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Unexpected error';
}

/** name / SKU / barcode search, case-insensitive, client-side. */
export function filterProducts(products: Product[], query: string): Product[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return products;
  }
  return products.filter(
    (product) =>
      product.name.toLowerCase().includes(needle) ||
      product.sku.toLowerCase().includes(needle) ||
      (product.barcodes ?? []).some((barcode) =>
        barcode.value.toLowerCase().includes(needle),
      ),
  );
}

/**
 * ZIP bulk import: pick an archive → server-side VALIDATION PREVIEW →
 * explicit Import → results report. Unknown SKU folders are surfaced and
 * never become products.
 */
function BulkImport({ onImported }: { onImported: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send<T>(path: string): Promise<T> {
    const formData = new FormData();
    formData.append('file', file as File);
    return apiUpload<T>(path, formData);
  }

  async function runPreview(picked: File | null) {
    setFile(picked);
    setPreview(null);
    setReport(null);
    setError(null);
    if (!picked) {
      return;
    }
    setBusy(true);
    try {
      const formData = new FormData();
      formData.append('file', picked);
      setPreview(
        await apiUpload<ImportPreview>(
          '/catalog/products/reference-imports/preview',
          formData,
        ),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!file) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setReport(await send<ImportReport>('/catalog/products/reference-imports'));
      setPreview(null);
      onImported();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ margin: '1rem 0' }}>
      <h2>Bulk import (ZIP)</h2>
      <p className="muted">
        Structure: <code>&lt;SKU&gt;/&lt;image files&gt;</code> (JPG, JPEG,
        PNG, WEBP). Folders must match an exact ACTIVE catalog SKU — unknown
        folders are reported, never created. Duplicates are skipped by
        SHA-256.
      </p>
      <div className="toolbar">
        <input
          type="file"
          accept=".zip,application/zip,application/x-zip-compressed"
          disabled={busy}
          onChange={(e) => void runPreview(e.target.files?.[0] ?? null)}
        />
        {busy ? <span className="muted">working…</span> : null}
      </div>
      {error ? <div className="error">{error}</div> : null}

      {preview ? (
        <div>
          <h3>Validation preview — nothing imported yet</h3>
          <p className="muted">
            {preview.totals.files} file(s): {preview.totals.importable}{' '}
            importable, {preview.totals.rejected} rejected.
          </p>
          {preview.matched.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Product</th>
                  <th>New</th>
                  <th>Zip duplicates</th>
                  <th>Already stored</th>
                  <th>After import</th>
                  <th>Inference-ready after</th>
                </tr>
              </thead>
              <tbody>
                {preview.matched.map((row) => (
                  <tr key={row.sku}>
                    <td>{row.sku}</td>
                    <td>{row.name}</td>
                    <td>{row.newImages}</td>
                    <td>{row.duplicatesInZip}</td>
                    <td>{row.alreadyStored}</td>
                    <td>
                      {row.existingImages} → {row.projectedImages}
                    </td>
                    <td>
                      <span
                        className={`badge ${row.projectedInferenceReady ? 'ok' : 'warn'}`}
                      >
                        {row.projectedInferenceReady
                          ? 'READY'
                          : `below ${preview.minRequired}`}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">No folder matched an active catalog SKU.</p>
          )}
          {preview.unknownSkus.length > 0 ? (
            <p className="error" style={{ padding: '0.5rem' }}>
              Unknown SKUs (will NOT be imported or created):{' '}
              {preview.unknownSkus
                .map((row) => `${row.sku} (${row.fileCount})`)
                .join(', ')}
            </p>
          ) : null}
          {preview.rejected.length > 0 ? (
            <details>
              <summary className="muted">
                {preview.rejected.length} rejected file(s)
              </summary>
              <ul className="muted">
                {preview.rejected.map((rejection) => (
                  <li key={rejection.path}>
                    {rejection.path} — {rejection.reason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <div className="toolbar">
            <button
              className="primary"
              disabled={busy || preview.totals.importable === 0}
              onClick={() => void commit()}
            >
              Import {preview.totals.importable} image(s)
            </button>
          </div>
        </div>
      ) : null}

      {report ? (
        <div>
          <h3>Import report</h3>
          <div className="toolbar" style={{ flexWrap: 'wrap' }}>
            <span className="badge ok">
              {report.imagesAccepted} accepted
            </span>
            <span className={`badge ${report.imagesRejected ? 'warn' : ''}`}>
              {report.imagesRejected} rejected
            </span>
            <span className="muted">
              {report.productsImported} product(s) received images
            </span>
            {report.productsNowInferenceReady.length > 0 ? (
              <span className="badge ok">
                now inference-ready:{' '}
                {report.productsNowInferenceReady
                  .map((row) => row.sku)
                  .join(', ')}
              </span>
            ) : null}
          </div>
          {report.perProduct.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Accepted</th>
                  <th>Rejected</th>
                  <th>Total images</th>
                  <th>Inference-ready</th>
                </tr>
              </thead>
              <tbody>
                {report.perProduct.map((row) => (
                  <tr key={row.sku}>
                    <td>{row.sku}</td>
                    <td>{row.accepted}</td>
                    <td>{row.rejected}</td>
                    <td>{row.totalImages}</td>
                    <td>
                      <span
                        className={`badge ${row.inferenceReady ? 'ok' : 'warn'}`}
                      >
                        {row.inferenceReady ? 'READY' : 'NOT READY'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {report.rejections.length > 0 ? (
            <details>
              <summary className="muted">
                {report.rejections.length} rejection(s) with reasons
              </summary>
              <ul className="muted">
                {report.rejections.map((rejection) => (
                  <li key={rejection.path}>
                    {rejection.path} — {rejection.reason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Authenticated thumbnail (blob URL) with cleanup. */
function ReferenceThumb({
  productId,
  imageId,
  filename,
}: {
  productId: string;
  imageId: string;
  filename: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;
    void apiObjectUrl(
      `/catalog/products/${productId}/reference-images/${imageId}/image`,
    ).then((objectUrl) => {
      if (cancelled) {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        return;
      }
      revoked = objectUrl;
      setUrl(objectUrl);
    });
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [productId, imageId]);
  if (!url) {
    return <div className="muted" style={{ width: '7rem' }}>loading…</div>;
  }
  return (
    <img
      src={url}
      alt={filename}
      style={{ width: '7rem', height: '7rem', objectFit: 'cover', borderRadius: 4 }}
    />
  );
}

/**
 * Admin-managed product reference library: pick a product, upload PNG/JPEG
 * reference images, prune bad ones, and see the inference-ready verdict
 * (5-image minimum). Everything flows through the API — no filesystem
 * conventions exist any more.
 */
export function ReferenceLibraryPage() {
  const [productId, setProductId] = useState('');
  const [search, setSearch] = useState('');
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const products = useLoad<Paginated<Product>>(
    () => api<Paginated<Product>>('/catalog/products?take=100'),
    [],
  );
  const visibleProducts = useMemo(
    () => filterProducts(products.data?.items ?? [], search),
    [products.data, search],
  );
  const overview = useLoad<ReferenceOverviewRow[]>(
    () => api<ReferenceOverviewRow[]>('/catalog/products/reference-images/overview'),
    [reload],
  );
  const status = useLoad<ReferenceLibraryStatus | null>(
    () =>
      productId
        ? api<ReferenceLibraryStatus>(
            `/catalog/products/${productId}/reference-images`,
          )
        : Promise.resolve(null),
    [productId, reload],
  );

  async function upload(files: FileList | null) {
    if (!files || files.length === 0 || !productId) {
      return;
    }
    setBusy(true);
    setActionError(null);
    setNotice(null);
    let uploaded = 0;
    try {
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append('file', file);
        await apiUpload(
          `/catalog/products/${productId}/reference-images`,
          formData,
        );
        uploaded += 1;
      }
      setNotice(`Uploaded ${uploaded} reference image(s).`);
      setReload((n) => n + 1);
    } catch (err) {
      setActionError(
        `${errorMessage(err)}${uploaded ? ` (after ${uploaded} uploaded)` : ''}`,
      );
      setReload((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  async function reindex(rebuild: boolean) {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const result = await api<{ indexed: number; total: number; modelKey: string; modelVersion: string; rebuilt: boolean }>(
        '/pickup-fusion/reference-index/reindex',
        { method: 'POST', body: { rebuild } },
      );
      setNotice(
        `${result.rebuilt ? 'Rebuilt' : 'Re-indexed'}: ${result.indexed} vector(s) computed, ` +
          `${result.total} image(s) total (${result.modelKey}@${result.modelVersion}).`,
      );
      setReload((n) => n + 1);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(imageId: string) {
    setBusy(true);
    setActionError(null);
    try {
      await api(`/catalog/products/${productId}/reference-images/${imageId}`, {
        method: 'DELETE',
      });
      setReload((n) => n + 1);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const data = status.data;

  return (
    <Page title="Reference library" error={products.error} loading={products.loading}>
      <p className="muted">
        Upload 8–15 reference photos per product (PNG/JPEG/WEBP — different angles, lighting, and distances). A product becomes INFERENCE-READY at {data?.minRequired ?? 5} images; below that it never participates in pickup matching.
      </p>
      <div className="toolbar">
        <input
          type="text"
          style={{ minWidth: '16rem' }}
          placeholder="Search by name, SKU, or barcode…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select value={productId} onChange={(e) => setProductId(e.target.value)}>
          <option value="">
            {visibleProducts.length === 0
              ? 'No products match the search'
              : `Select a product… (${visibleProducts.length})`}
          </option>
          {visibleProducts.map((product) => (
            <option key={product.id} value={product.id}>
              {product.name} ({product.sku})
            </option>
          ))}
        </select>
        {productId ? (
          <label>
            <input
              type="file"
              accept="image/png,image/jpeg"
              multiple
              disabled={busy}
              onChange={(e) => {
                void upload(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
        ) : null}
      </div>
      {actionError ? <div className="error">{actionError}</div> : null}
      {notice ? <p className="muted">{notice}</p> : null}
      {status.error ? <div className="error">{status.error}</div> : null}

      {data ? (
        <div style={{ margin: '0.75rem 0' }}>
          <div className="toolbar">
            <span className={`badge ${data.inferenceReady ? 'ok' : 'warn'}`}>
              {data.inferenceReady
                ? 'INFERENCE-READY'
                : `${data.referenceCount}/${data.minRequired} images`}
            </span>
            <span className="muted">
              SKU {data.sku} · barcode{' '}
              {data.barcodes.length > 0 ? data.barcodes.join(', ') : '—'}
              {' '} · embeddings {data.embeddingCount}/{data.referenceCount}{' '}
              ({data.embeddingModelKey}@{data.embeddingModelVersion})
            </span>
            <button
              disabled={busy}
              title="Compute vectors for any un-indexed images (Rebuild recomputes everything for the current model)"
              onClick={() => void reindex(false)}
            >
              Re-index embeddings
            </button>
            <button disabled={busy} onClick={() => void reindex(true)}>
              Rebuild
            </button>
          </div>
          <div
            style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginTop: '0.5rem' }}
          >
            {data.images.map((image) => (
              <figure key={image.id} style={{ margin: 0, textAlign: 'center' }}>
                <ReferenceThumb
                  productId={data.productId}
                  imageId={image.id}
                  filename={image.originalFilename}
                />
                <figcaption className="muted" title={image.originalFilename}>
                  {(image.sizeBytes / 1024).toFixed(0)} KiB
                </figcaption>
                <button disabled={busy} onClick={() => void remove(image.id)}>
                  Delete
                </button>
              </figure>
            ))}
            {data.images.length === 0 ? (
              <p className="muted">No reference images yet.</p>
            ) : null}
          </div>
        </div>
      ) : null}

      <BulkImport onImported={() => setReload((n) => n + 1)} />

      <h2>Library overview</h2>
      {overview.error ? <div className="error">{overview.error}</div> : null}
      <table>
        <thead>
          <tr>
            <th>SKU</th>
            <th>Product</th>
            <th>Reference images</th>
            <th>Embeddings</th>
            <th>Inference-ready</th>
          </tr>
        </thead>
        <tbody>
          {(overview.data ?? []).map((row) => (
            <tr key={row.productId}>
              <td>{row.sku}</td>
              <td>{row.name}</td>
              <td>{row.referenceCount}</td>
              <td>{row.embeddingCount}</td>
              <td>
                <span className={`badge ${row.inferenceReady ? 'ok' : 'warn'}`}>
                  {row.inferenceReady ? 'READY' : 'NOT READY'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Page>
  );
}
