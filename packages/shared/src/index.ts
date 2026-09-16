/**
 * `@byond/shared` — the domain contract both `services/api` and
 * `apps/admin-web` speak.
 *
 * Scope is deliberately narrow: the wire vocabularies and the wire
 * shapes, nothing else. Nothing here may import a framework, a
 * database client, `react`, or Node built-ins — it has to compile inside
 * a NestJS CommonJS build and inside a Vite browser bundle alike.
 */
export * from './clip-lab';
export * from './enums';
export * from './geometry';
export * from './pagination';
