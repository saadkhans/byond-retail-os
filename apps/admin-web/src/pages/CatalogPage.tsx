import { useState } from 'react';
import { api, Paginated, Product } from '../api';
import { Page, Pagination, StatusBadge, useLoad } from '../components';

/** Read-only catalog visibility (Phase 3 API). */
export function CatalogPage() {
  const [search, setSearch] = useState('');
  const [skip, setSkip] = useState(0);
  const take = 25;

  const { data, error, loading } = useLoad<Paginated<Product>>(
    () =>
      api(
        `/catalog/products?skip=${skip}&take=${take}` +
          (search ? `&search=${encodeURIComponent(search)}` : ''),
      ),
    [search, skip],
  );

  return (
    <Page title="Catalog (read-only)" error={error} loading={loading}>
      <div className="toolbar">
        <input
          placeholder="Search name or SKU…"
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
            <th>SKU</th>
            <th>Name</th>
            <th>Category</th>
            <th>Brand</th>
            <th>Unit</th>
            <th>Status</th>
            <th>Barcodes</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((product) => (
            <tr key={product.id}>
              <td>{product.sku}</td>
              <td>{product.name}</td>
              <td>{product.category?.name ?? '—'}</td>
              <td>{product.brand?.name ?? '—'}</td>
              <td>{product.unitOfMeasure}</td>
              <td>
                <StatusBadge status={product.status} />
              </td>
              <td>
                {product.barcodes?.map((barcode) => barcode.value).join(', ') ||
                  '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pagination skip={skip} take={take} total={data?.total} onChange={setSkip} />
    </Page>
  );
}
