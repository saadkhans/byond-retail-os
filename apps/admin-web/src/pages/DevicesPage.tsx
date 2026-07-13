import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, Device, Paginated } from '../api';
import { formatDate, Page, StatusBadge, useLoad } from '../components';

const DEVICE_STATUSES = [
  '',
  'PROVISIONED',
  'ONLINE',
  'OFFLINE',
  'MAINTENANCE',
  'DISABLED',
  'RETIRED',
];

export function DevicesPage() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [skip, setSkip] = useState(0);
  const take = 25;

  const { data, error, loading } = useLoad<Paginated<Device>>(
    () =>
      api(
        `/devices?skip=${skip}&take=${take}` +
          (search ? `&search=${encodeURIComponent(search)}` : '') +
          (status ? `&status=${status}` : ''),
      ),
    [search, status, skip],
  );

  return (
    <Page title="Devices" error={error} loading={loading}>
      <div className="toolbar">
        <input
          placeholder="Search name or serial…"
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
          {DEVICE_STATUSES.map((value) => (
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
            <th>Type</th>
            <th>Status</th>
            <th>Serial</th>
            <th>Unit</th>
            <th>Last seen</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((device) => (
            <tr key={device.id}>
              <td>
                <Link to={`/devices/${device.id}`}>{device.name}</Link>
              </td>
              <td>{device.type}</td>
              <td>
                <StatusBadge status={device.status} />
              </td>
              <td>{device.serialNumber}</td>
              <td>
                {device.unit ? (
                  <Link to={`/units/${device.unit.id}`}>
                    {device.unit.name}
                  </Link>
                ) : (
                  device.unitId
                )}
              </td>
              <td>{formatDate(device.lastSeenAt)}</td>
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

export function DeviceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading } = useLoad<Device>(
    () => api(`/devices/${id}`),
    [id],
  );

  return (
    <Page
      title={data ? `Device: ${data.name}` : 'Device'}
      error={error}
      loading={loading}
    >
      {data ? (
        <div className="detail">
          <dl>
            <dt>Type</dt>
            <dd>{data.type}</dd>
            <dt>Status</dt>
            <dd>
              <StatusBadge status={data.status} />
            </dd>
            <dt>Serial number</dt>
            <dd>{data.serialNumber}</dd>
            <dt>Unit</dt>
            <dd>
              {data.unit ? (
                <Link to={`/units/${data.unit.id}`}>
                  {data.unit.name} ({data.unit.code})
                </Link>
              ) : (
                data.unitId
              )}
            </dd>
            <dt>Firmware version</dt>
            <dd>{data.firmwareVersion ?? '—'}</dd>
            <dt>Software version</dt>
            <dd>{data.softwareVersion ?? '—'}</dd>
            <dt>Last seen</dt>
            <dd>{formatDate(data.lastSeenAt)}</dd>
            <dt>Registered</dt>
            <dd>{formatDate(data.registeredAt)}</dd>
            <dt>Created</dt>
            <dd>{formatDate(data.createdAt)}</dd>
            <dt>Updated</dt>
            <dd>{formatDate(data.updatedAt)}</dd>
          </dl>
          <h1 style={{ marginTop: '1.5rem' }}>Metadata (non-secret)</h1>
          <pre className="json">
            {data.metadata ? JSON.stringify(data.metadata, null, 2) : '—'}
          </pre>
        </div>
      ) : null}
    </Page>
  );
}
