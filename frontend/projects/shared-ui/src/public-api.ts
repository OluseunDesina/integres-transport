/*
 * Public API Surface of shared-ui
 */

export * from './lib/button';
export * from './lib/text-field';
export * from './lib/alert';
export * from './lib/status-pill';
export * from './lib/select';
export * from './lib/empty-state';
export * from './lib/table';
export * from './lib/paginator';
export * from './lib/stat';
export * from './lib/confirm-dialog';
export * from './lib/icon';
export * from './lib/toggle';
/* Spec 14 slice 2 — the primitives the Transit OS briefs require. */
export * from './lib/page-header';
export * from './lib/filter-bar';
export * from './lib/action-menu';
export * from './lib/drawer';
export * from './lib/skeleton';
export * from './lib/tabs';
export * from './lib/form-section';
export * from './lib/toolbar';
export * from './lib/density-toggle';
export * from './lib/export-button';
/* Spec 14 responsive-tables slice — `ui-table`'s column convention: the
 * sub-line hidden columns re-flow into, and the guard every list spec
 * in all three apps calls to prove the pairing holds. */
export * from './lib/summary-line';
export * from './lib/testing/table-columns';
/* Spec 14 slice 5 — validation presentation, moved here from
 * client-admin-app once customer-app needed it too. */
export * from './lib/form-errors';
/* Spec 14 slice 6a — the three form controls this library never had, so
 * seven screens hand-rolled them (two still on the 1.48:1 input border
 * slice 1 replaced everywhere else). */
export * from './lib/textarea';
export * from './lib/radio-group';
export * from './lib/checkbox';
/* Spec 14 slice 6b — one money format for all four apps. */
export * from './lib/money';
/* Spec 16 slice 3 — the one charting primitive that spec owns. */
export * from './lib/chart';
/* Spec 20 slice 3 — the one mapping primitive that spec owns. */
export * from './lib/map';
export * from './lib/theme/color';
export * from './lib/theme/brand-theme.service';
/* Spec 21 slice 2 — the seat-hold countdown, `booking-confirm` and
 * `my-bookings`. */
export * from './lib/countdown';
