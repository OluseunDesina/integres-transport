import type { SelectOption } from '@shared-ui';

/**
 * Service classes, passenger side — docs/specs/15-trip-classes.md
 * slice 3.
 *
 * A deliberately smaller sibling of `client-admin-app`'s file of the
 * same name. Per-app rather than promoted to a library, following
 * `validator-app/src/app/shared/labels.ts`: `@shared-ui` is
 * presentational, and a domain label map is not.
 *
 * What is **not** copied across is the fare half — `ANY_TRIP_CLASS`,
 * `TRIP_CLASS_OPTIONS_WITH_ANY`, the "Any class" wording. No passenger
 * surface touches a fare rule, and the `''` wildcard is a fares
 * concept: it is a *fallback* an exact-class rule overrides. The
 * empty option here means something genuinely different — "do not
 * filter" — and is labelled accordingly.
 */
export type TripClass = 'premium' | 'exclusive' | 'standard' | 'mini';

export const TRIP_CLASS_LABEL: Record<TripClass, string> = {
  premium: 'Premium',
  exclusive: 'Exclusive',
  standard: 'Standard',
  mini: 'Mini',
};

export const TRIP_CLASS_OPTIONS: SelectOption[] = (
  Object.keys(TRIP_CLASS_LABEL) as TripClass[]
).map((value) => ({ value, label: TRIP_CLASS_LABEL[value] }));

/**
 * The search filter's "do not narrow" option.
 *
 * **"All classes", not "Any class"** — the label client-admin's fare
 * screens use for the wildcard. A filter that matches everything and a
 * fare rule that an exact-class rule overrides are different things,
 * and reusing one label for both would be wrong on whichever screen it
 * was borrowed from. `trip-list`'s own filter already drew this line.
 */
export const ALL_TRIP_CLASSES = '';
export const ALL_TRIP_CLASSES_LABEL = 'All classes';

/** Renders a class value for display. Falls back to the raw value
 * rather than a blank, so an enum this build has not heard of is still
 * legible rather than silently invisible. */
export function tripClassLabel(value: string | undefined | null): string {
  if (!value) {
    return '';
  }
  return TRIP_CLASS_LABEL[value as TripClass] ?? value;
}

/**
 * The classes a route actually runs, as filter options.
 *
 * **An empty allow-list means no restriction**, not "nothing allowed".
 * Getting that backwards would empty the filter on every Route created
 * before spec 15 — which is all of them.
 */
export function tripClassFilterOptions(availableTripClasses: readonly string[]): SelectOption[] {
  const allowed =
    availableTripClasses.length === 0
      ? TRIP_CLASS_OPTIONS
      : TRIP_CLASS_OPTIONS.filter((option) =>
          availableTripClasses.includes(option.value as TripClass)
        );
  return [{ value: ALL_TRIP_CLASSES, label: ALL_TRIP_CLASSES_LABEL }, ...allowed];
}
