/**
 * The list envelope every search endpoint returns. The platform API
 * repeats `{ items, total, skip, take }` inline in each controller and
 * service; this is the named shape the admin web (and any future client)
 * reads it back as.
 */
export interface Paginated<T> {
  items: T[];
  /** Total rows matching the filter, not the length of `items`. */
  total: number;
  skip: number;
  take: number;
}
