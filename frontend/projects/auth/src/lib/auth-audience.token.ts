import { InjectionToken } from '@angular/core';

import type { AuthAudience } from './auth-user';

/**
 * Which frontend app is hosting this instance of the auth lib — set once
 * per app in app.config.ts. Determines which of the three audience-scoped
 * token endpoints AuthApiService.login() calls (see docs/adr/0003 and
 * backend/apps/identity/serializers.py).
 */
export const AUTH_AUDIENCE = new InjectionToken<AuthAudience>('AUTH_AUDIENCE');
