import createOpenApiFetchClient, { type Client, type Middleware } from 'openapi-fetch';

import type { paths } from './schema';

export type ApiClient = Client<paths>;

/**
 * Builds a fully-typed API client from the OpenAPI schema generated at
 * `schema.ts` (via `npm run openapi:generate`, see package.json). Types
 * are regenerated from backend/openapi.yaml and are never hand-edited —
 * see docs/adr/0001 on committed-and-diffed API contracts.
 */
export function createApiClient(baseUrl: string, middleware: Middleware[] = []): ApiClient {
  const client = createOpenApiFetchClient<paths>({ baseUrl });
  for (const mw of middleware) {
    client.use(mw);
  }
  return client;
}

export type { Middleware } from 'openapi-fetch';
export type { components, paths } from './schema';
