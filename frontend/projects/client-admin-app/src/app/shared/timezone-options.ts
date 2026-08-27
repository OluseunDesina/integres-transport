import type { SelectOption } from '@shared-ui';

/**
 * `Business.timezone` was a free-text field: a typo like
 * `Africa/Lagoss` saved cleanly and only surfaced much later as a
 * `ZoneInfoNotFoundError` inside trip generation or settlement-period
 * arithmetic. The backend now validates against the full IANA set
 * (`apps.businesses.models.validate_iana_timezone`); this narrows the
 * *picker* to the zones this platform actually operates in.
 *
 * Derived from `Intl.supportedValuesOf('timeZone')` rather than a
 * hardcoded list, so it can't drift from real IANA data as tzdb
 * changes. Scoped to `Africa/*` because every market in the product
 * lives there (Nigeria, Ghana, Kenya, South Africa, Côte d'Ivoire,
 * Botswana) and `ui-select` is a plain `<select>` with no grouping or
 * search — 400+ worldwide zones in one flat list would be worse UX
 * than the free-text field this replaces. `UTC` is appended as the
 * neutral fallback.
 *
 * If a market outside Africa is ever onboarded, widen the filter here;
 * the backend already accepts any real zone, so this is a UI narrowing
 * only, not a system constraint.
 */
const FALLBACK_ZONES = [
  'Africa/Abidjan',
  'Africa/Accra',
  'Africa/Gaborone',
  'Africa/Johannesburg',
  'Africa/Lagos',
  'Africa/Nairobi',
];

function africaZones(): string[] {
  // `Intl.supportedValuesOf` is ES2022 — guard rather than assume, so
  // an older browser degrades to the markets we actually serve instead
  // of rendering an empty dropdown.
  const supported = (Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf;
  if (typeof supported !== 'function') {
    return FALLBACK_ZONES;
  }
  const zones = supported('timeZone').filter((zone) => zone.startsWith('Africa/'));
  return zones.length > 0 ? zones : FALLBACK_ZONES;
}

export const TIMEZONE_SELECT_OPTIONS: SelectOption[] = [
  ...africaZones()
    .sort((a, b) => a.localeCompare(b))
    .map((zone) => ({
      value: zone,
      label: zone.replace('Africa/', '').replace(/_/g, ' '),
    })),
  { value: 'UTC', label: 'UTC' },
];
