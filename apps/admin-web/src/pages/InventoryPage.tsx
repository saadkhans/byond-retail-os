import { useState } from 'react';
import { api, StockLevel } from '../api';
import { Page, useLoad } from '../components';

/** Read-only stock level visibility (Phase 3 API — returns a plain array). */
export function InventoryPage() {
  const [lowStockOnly, setLowStockOnly] = useState(false);

  const { data, error, loading } = useLoad<StockLevel[]>(
    () => api(`/inventory/levels${lowStockOnly ? '?lowStockOnly=true' : ''}`),
    [lowStockOnly],
  );

  return (
    <Page title="Inventory levels (read-only)" error={error} loading={loading}>
      <div className="toolbar">
        <label>
          <input
            type="checkbox"
            checked={lowStockOnly}
            onChange={(e) => setLowStockOnly(e.target.checked)}
          />{' '}
          Low stock only
        </label>
        <span className="muted">{data?.length ?? 0} levels</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Location</th>
            <th>SKU</th>
            <th>Product</th>
            <th>On hand</th>
            <th>Low stock</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((level) => (
            <tr key={level.id}>
              <td>
                {level.location.name} ({level.location.code})
              </td>
              <td>{level.product.sku}</td>
              <td>{level.product.name}</td>
              <td>{level.quantity}</td>
              <td>
                {level.isLowStock ? (
                  <span className="badge down">LOW</span>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Page>
  );
}
