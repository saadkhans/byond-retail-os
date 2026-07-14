import { ReactNode, useEffect, useState } from 'react';
import { ApiError } from './api';

/** Shared hook: load data, expose loading/error, reload on dependency change. */
export function useLoad<T>(
  loader: () => Promise<T>,
  deps: unknown[],
): { data: T | undefined; error: string | null; loading: boolean } {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loader()
      .then((result) => {
        if (!cancelled) {
          setData(result);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof ApiError
              ? err.status === 403
                ? `No access: ${err.message}`
                : err.message
              : 'Unexpected error',
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading };
}

export function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'ACTIVE' || status === 'ONLINE' || status === 'OPEN' || status === 'COMPLETED' || status === 'CONFIRMED'
      ? 'ok'
      : status === 'MAINTENANCE' || status === 'DRAFT' || status === 'PROVISIONED' || status === 'PENDING_REVIEW'
        ? 'warn'
        : status === 'OFFLINE' || status === 'DISABLED' || status === 'RETIRED' || status === 'CLOSED' || status === 'INACTIVE' || status === 'CANCELLED' || status === 'EXPIRED'
          ? 'down'
          : '';
  return <span className={`badge ${tone}`}>{status}</span>;
}

export function Page({
  title,
  error,
  loading,
  children,
}: {
  title: string;
  error?: string | null;
  loading?: boolean;
  children?: ReactNode;
}) {
  return (
    <>
      <h1>{title}</h1>
      {error ? <div className="error">{error}</div> : null}
      {loading ? <p className="muted">Loading…</p> : children}
    </>
  );
}

export function formatDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : '—';
}
