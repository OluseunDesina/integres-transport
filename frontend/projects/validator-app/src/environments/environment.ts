import type { Environment } from './environment.model';

// Base/default shape. Overridden per-configuration via angular.json
// fileReplacements (development/stage/production) — never import a
// hardcoded API URL anywhere else in the app.
export const environment: Environment = {
  production: false,
  apiBaseUrl: 'http://localhost:8000',
};
