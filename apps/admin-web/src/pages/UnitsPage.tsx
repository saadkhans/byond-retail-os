import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, Device, Paginated, Unit } from '../api';
import { formatDate, Page, StatusBadge, useLoad } from '../components';

const UNIT_STATUSES = ['', 'DRAFT', 'ACTIVE', 'MAINTENANCE', 'DISABLED', 'RETIRED'];

export function UnitsPage() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [skip, setSkip] = useState(0);
  const take = 25;

  const { data, error, loading } = useLoad<Paginated<Unit>>(
    () =>
      api(
        `/units?skip=${skip}&take=${take}` +
          (search ? `&search=${encodeURIComponent(search)}` : '') +
          (status ? `&status=${status}` : ''),
      ),
    [search, status, skip],
  );

  return (
    <Page title="Retail units" error={error} loading={loading}>
      <div className="toolbar">
        <input
          placeholder="Search name or code…"
          value={search}
          onChange={(e) => {
            setSkip(0);
            setSearch(e.target.value);
          }}
        />
        <select
          value={status}
          onChange={(e) => {
            setSkip(0);
            setStatus(e.target.value);
          }}
        >
          {UNIT_STATUSES.map((value) => (
            <option key={value} value={value}>
              {value || 'Any status'}
            </option>
          ))}
        </select>
        <span className="muted">{data?.total ?? 0} total</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Code</th>
            <th>Type</th>
            <th>Status</th>
            <th>Store</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((unit) => (
            <tr key={unit.id}>
              <td>
                <Link to={`/units/${unit.id}`}>{unit.name}</Link>
              </td>
              <td>{unit.code}</td>
              <td>{unit.type}</td>
              <td>
                <StatusBadge status={unit.status} />
              </td>
              <td>
                {unit.location ? (
                  <Link to={`/stores/${unit.location.id}`}>
                    {unit.location.name}
                  </Link>
                ) : (
                  unit.locationId
                )}
              </td>
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

export function UnitDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading } = useLoad<{
    unit: Unit;
    devices: Paginated<Device> | null;
    devicesError: string | null;
  }>(
    async () => {
      const unit = await api<Unit>(`/units/${id}`);
      // An authorization/module failure on the related list must surface as
      // "unavailable", never masquerade as a unit with no devices.
      try {
        const devices = await api<Paginated<Device>>(
          `/devices?unitId=${id}&take=100`,
        );
        return { unit, devices, devicesError: null };
      } catch (err) {
        return {
          unit,
          devices: null,
          devicesError:
            err instanceof ApiError
              ? `Devices unavailable (${err.status || 'network'}): ${err.message}`
              : 'Devices unavailable',
        };
      }
    },
    [id],
  );

  return (
    <Page
      title={data ? `Unit: ${data.unit.name}` : 'Unit'}
      error={error}
      loading={loading}
    >
      {data ? (
        <div className="detail">
          <dl>
            <dt>Code</dt>
            <dd>{data.unit.code}</dd>
            <dt>Type</dt>
            <dd>{data.unit.type}</dd>
            <dt>Status</dt>
            <dd>
              <StatusBadge status={data.unit.status} />
            </dd>
            <dt>Store</dt>
            <dd>
              {data.unit.location ? (
                <Link to={`/stores/${data.unit.location.id}`}>
                  {data.unit.location.name} ({data.unit.location.code})
                </Link>
              ) : (
                data.unit.locationId
              )}
            </dd>
            <dt>Placement</dt>
            <dd>{data.unit.placement ?? '—'}</dd>
            <dt>Created</dt>
            <dd>{formatDate(data.unit.createdAt)}</dd>
            <dt>Updated</dt>
            <dd>{formatDate(data.unit.updatedAt)}</dd>
          </dl>
          <h1 style={{ marginTop: '1.5rem' }}>
            Devices on this unit
            {data.devices ? ` (${data.devices.total})` : ''}
          </h1>
          {data.devicesError ? (
            <div className="error">{data.devicesError}</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Serial</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {data.devices?.items.map((device) => (
                  <tr key={device.id}>
                    <td>
                      <Link to={`/devices/${device.id}`}>{device.name}</Link>
                    </td>
                    <td>{device.type}</td>
                    <td>
                      <StatusBadge status={device.status} />
                    </td>
                    <td>{device.serialNumber}</td>
                    <td>{formatDate(device.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </Page>
  );
}
