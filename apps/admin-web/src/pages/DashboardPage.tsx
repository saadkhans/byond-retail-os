import { Link } from 'react-router-dom';
import { api, Paginated } from '../api';
import { Page, useLoad } from '../components';

interface Counts {
  stores?: number;
  units?: number;
  devices?: number;
  products?: number;
}

async function countOf(path: string): Promise<number | undefined> {
  try {
    const page = await api<Paginated<unknown>>(`${path}?take=1`);
    return page.total;
  } catch {
    // Missing permission or disabled module — show the tile as unavailable.
    return undefined;
  }
}

export function DashboardPage() {
  const { data, error, loading } = useLoad<Counts>(
    async () => ({
      stores: await countOf('/stores'),
      units: await countOf('/units'),
      devices: await countOf('/devices'),
      products: await countOf('/catalog/products'),
    }),
    [],
  );

  const tiles: { label: string; to: string; value?: number }[] = [
    { label: 'Stores', to: '/stores', value: data?.stores },
    { label: 'Retail units', to: '/units', value: data?.units },
    { label: 'Devices', to: '/devices', value: data?.devices },
    { label: 'Products', to: '/catalog', value: data?.products },
  ];

  return (
    <Page title="Dashboard" error={error} loading={loading}>
      <div className="cards">
        {tiles.map((tile) => (
          <Link key={tile.label} to={tile.to} className="card">
            <div className="value">{tile.value ?? '—'}</div>
            <div className="label">{tile.label}</div>
          </Link>
        ))}
      </div>
      <p className="muted" style={{ marginTop: '1rem' }}>
        A dash means the endpoint is unavailable to your account (missing
        permission or disabled module).
      </p>
    </Page>
  );
}
