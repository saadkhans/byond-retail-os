import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, Paginated, Store, Unit } from '../api';
import { formatDate, Page, StatusBadge, useLoad } from '../components';

export function StoresPage() {
  const [search, setSearch] = useState('');
  const [skip, setSkip] = useState(0);
  const take = 25;

  const { data, error, loading } = useLoad<Paginated<Store>>(
    () =>
      api(
        `/stores?skip=${skip}&take=${take}${
          search ? `&search=${encodeURIComponent(search)}` : ''
        }`,
      ),
    [search, skip],
  );

  return (
    <Page title="Stores" error={error} loading={loading}>
      <div className="toolbar">
        <input
          placeholder="Search name or code…"
          value={search}
          onChange={(e) => {
            setSkip(0);
            setSearch(e.target.value);
          }}
        />
        <span className="muted">{data?.total ?? 0} total</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Code</th>
            <th>Type</th>
            <th>Status</th>
            <th>Timezone</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((store) => (
            <tr key={store.id}>
              <td>
                <Link to={`/stores/${store.id}`}>{store.name}</Link>
              </td>
              <td>{store.code}</td>
              <td>{store.type}</td>
              <td>
                <StatusBadge status={store.status} />
              </td>
              <td>{store.timezone}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pagination">
        <button disabled={skip === 0} onClick={() => setSkip(Math.max(0, skip - take))}>
          Previous
        </button>
        <button
          disabled={!data || skip + take >= data.total}
          onClick={() => setSkip(skip + take)}
        >
          Next
        </button>
      </div>
    </Page>
  );
}

export function StoreDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading } = useLoad<{
    store: Store;
    units: Paginated<Unit>;
  }>(
    async () => ({
      store: await api<Store>(`/stores/${id}`),
      units: await api<Paginated<Unit>>(`/units?locationId=${id}&take=100`).catch(
        () => ({ items: [], total: 0, skip: 0, take: 0 }),
      ),
    }),
    [id],
  );

  return (
    <Page
      title={data ? `Store: ${data.store.name}` : 'Store'}
      error={error}
      loading={loading}
    >
      {data ? (
        <div className="detail">
          <dl>
            <dt>Code</dt>
            <dd>{data.store.code}</dd>
            <dt>Type</dt>
            <dd>{data.store.type}</dd>
            <dt>Status</dt>
            <dd>
              <StatusBadge status={data.store.status} />
            </dd>
            <dt>Timezone</dt>
            <dd>{data.store.timezone}</dd>
            <dt>Address</dt>
            <dd>
              {data.store.address
                ? JSON.stringify(data.store.address)
                : '—'}
            </dd>
            <dt>Created</dt>
            <dd>{formatDate(data.store.createdAt)}</dd>
            <dt>Updated</dt>
            <dd>{formatDate(data.store.updatedAt)}</dd>
          </dl>
          <h1 style={{ marginTop: '1.5rem' }}>
            Units in this store ({data.units.total})
          </h1>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Code</th>
                <th>Type</th>
                <th>Status</th>
                <th>Placement</th>
              </tr>
            </thead>
            <tbody>
              {data.units.items.map((unit) => (
                <tr key={unit.id}>
                  <td>
                    <Link to={`/units/${unit.id}`}>{unit.name}</Link>
                  </td>
                  <td>{unit.code}</td>
                  <td>{unit.type}</td>
                  <td>
                    <StatusBadge status={unit.status} />
                  </td>
                  <td>{unit.placement ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Page>
  );
}
