import { defineConfig, devices } from '@playwright/test';

/**
 * Runs against the real stack (backend + Postgres + the relevant Angular
 * app), per the brief's e2e convention — never mocks. `webServer` starts
 * each app's dev server; the backend is expected to already be running
 * (`docker compose up`) with e2e test users seeded (see
 * scripts/seed-e2e-users.py, invoked by globalSetup).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  reporter: [['html', { open: 'never' }]],
  globalSetup: './e2e/global-setup.ts',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'customer-app',
      testMatch: /customer-app\/.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4200' },
    },
    {
      name: 'client-admin-app',
      testMatch: /client-admin-app\/.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4201' },
    },
    {
      name: 'super-admin-app',
      testMatch: /super-admin-app\/.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4202' },
    },
    {
      name: 'validator-app',
      testMatch: /validator-app\/.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4203' },
    },
  ],
  webServer: [
    {
      command: 'npm run start:customer',
      url: 'http://localhost:4200',
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
    },
    {
      command: 'npm run start:client-admin',
      url: 'http://localhost:4201',
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
    },
    {
      command: 'npm run start:super-admin',
      url: 'http://localhost:4202',
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
    },
    {
      command: 'npm run start:validator',
      url: 'http://localhost:4203',
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
    },
  ],
});
