import { ReactNode, createContext, useContext, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

/* ---------------------------------------------------------------- */
/* Page title bridge: `Page` publishes its title to the top bar.      */
/* ---------------------------------------------------------------- */
export interface PageTitleState {
  title: string;
  setTitle(title: string): void;
}

export const PageTitleContext = createContext<PageTitleState>({
  title: '',
  setTitle: () => undefined,
});

export function usePageTitle(title: string): void {
  const { setTitle } = useContext(PageTitleContext);
  useEffect(() => {
    setTitle(title);
  }, [title, setTitle]);
}

/* ---------------------------------------------------------------- */
/* Page chrome                                                        */
/* ---------------------------------------------------------------- */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {description ? <p className="description">{description}</p> : null}
      </div>
      {actions ? <div className="actions">{actions}</div> : null}
    </div>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
}: {
  title?: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section">
      {title ? (
        <div className="page-header" style={{ marginBottom: 8, alignItems: 'center' }}>
          <div>
            <h2 style={{ margin: 0 }}>{title}</h2>
            {description ? <p className="description">{description}</p> : null}
          </div>
          {actions ? <div className="actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className ? `card ${className}` : 'card'}>{children}</div>;
}

export function StatTiles({
  tiles,
}: {
  tiles: { label: string; value: ReactNode; to?: string }[];
}) {
  return (
    <div className="stat-tiles">
      {tiles.map((tile) =>
        tile.to ? (
          <Link key={tile.label} to={tile.to} className="stat-tile">
            <span className="value">{tile.value}</span>
            <span className="label">{tile.label}</span>
          </Link>
        ) : (
          <div key={tile.label} className="stat-tile">
            <span className="value">{tile.value}</span>
            <span className="label">{tile.label}</span>
          </div>
        ),
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Tables                                                             */
/* ---------------------------------------------------------------- */
export interface DataColumn<Row> {
  key: string;
  header: ReactNode;
  render: (row: Row) => ReactNode;
  /** Right-aligned with tabular digits. */
  numeric?: boolean;
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  empty = 'Nothing to show yet.',
}: {
  columns: DataColumn<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  empty?: ReactNode;
}) {
  if (rows.length === 0) {
    return <EmptyState>{empty}</EmptyState>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} className={column.numeric ? 'num' : undefined}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td key={column.key} className={column.numeric ? 'num' : undefined}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({
  skip,
  take,
  total,
  onChange,
}: {
  skip: number;
  take: number;
  total: number | undefined;
  onChange: (skip: number) => void;
}) {
  const end = total === undefined ? skip + take : Math.min(total, skip + take);
  return (
    <div className="pagination">
      <button disabled={skip === 0} onClick={() => onChange(Math.max(0, skip - take))}>
        Previous
      </button>
      <button
        disabled={total === undefined || skip + take >= total}
        onClick={() => onChange(skip + take)}
      >
        Next
      </button>
      {total !== undefined ? (
        <span className="range">
          {total === 0 ? '0 of 0' : `${skip + 1}–${end} of ${total}`}
        </span>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Badges, notices, empty states                                      */
/* ---------------------------------------------------------------- */
export type BadgeTone = 'ok' | 'warn' | 'down' | 'neutral' | 'accent';

export function Badge({
  tone = 'neutral',
  children,
  title,
}: {
  tone?: BadgeTone | string;
  children: ReactNode;
  title?: string;
}) {
  const cls = tone && tone !== 'neutral' ? `badge ${tone}` : 'badge';
  return (
    <span className={cls} title={title}>
      {children}
    </span>
  );
}

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'ok' | 'warn' | 'critical' | 'info';
  children: ReactNode;
}) {
  return <div className={`notice ${tone}`}>{children}</div>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

/* ---------------------------------------------------------------- */
/* Forms                                                              */
/* ---------------------------------------------------------------- */
export function FormRow({ children }: { children: ReactNode }) {
  return <div className="form-row">{children}</div>;
}

export function Field({
  label,
  required,
  hint,
  children,
}: {
  label: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>
        {label}
        {required ? <span className="required-mark"> *</span> : null}
      </span>
      {children}
      {hint ? <span className="muted">{hint}</span> : null}
    </label>
  );
}

export function Disclosure({
  summary,
  defaultOpen = false,
  children,
}: {
  summary: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="disclosure" open={defaultOpen || undefined}>
      <summary>{summary}</summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

export function Tabs({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: string; label: ReactNode }[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === value}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** Small helper for pages that keep a `tab` query parameter in sync. */
export function useTabState(initial: string): [string, (id: string) => void] {
  const [tab, setTab] = useState(initial);
  return [tab, setTab];
}
