/*
 * Public API Surface of shared-data
 */

export * from './lib/list-store';
/* Spec 20 slice 3 — the polling discipline every live-data screen
 * shares (client-admin-app's live-operations board today; slice 4's
 * passenger tracking and activity feed next). */
export * from './lib/poller';
