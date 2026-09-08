import type { SelectOption } from '@shared-ui';

/**
 * Service classes — docs/specs/15-trip-classes.md.
 *
 * One place for the labels and option lists six screens need, rather
 * than six copies of the same four strings. Same reasoning as
 * `validator-app`'s own `labels.ts`: the API returns raw enum values
 * (`premium`, `standard`) and nothing else in the app is allowed to
 * render one directly.
 */
export type TripClass = 'premium' | 'exclusive' | 'standard' | 'mini';

export const TRIP_CLASS_LABEL: Record<TripClass, string> = {
  premium: 'Premium',
  exclusive: 'Exclusive',
  standard: 'Standard',
  mini: 'Mini',
};

/**
 * The wildcard fare class — an empty string, not a missing value.
 *
 * A fare rule with no class prices any class that has no rule of its
 * own; an exact-class rule beats it. See the backend's
 * `apps.fares.models.ANY_TRIP_CLASS` for why the sentinel is `''`
 * rather than NULL (Postgres `=` does not match NULL to NULL, so a
 * nullable column would defeat the exclusion constraint).
 */
/** What the two fare surfaces accept: a class, or the wildcard. */
export type FareTripClass = TripClass | '';

export const ANY_TRIP_CLASS: FareTripClass = '';

/**
 * **"Any class", not "All classes".** A wildcard rule is a *fallback*
 * for classes with no price of their own — it is not a rule that
 * applies to every class at once, because an exact-class rule
 * overrides it. "All classes" would be read as the stronger claim, and
 * the label has to survive being read on the same screen as a Premium
 * rule that overrides it.
 */
export const ANY_TRIP_CLASS_LABEL = 'Any class';

export const TRIP_CLASS_OPTIONS: SelectOption[] = (
  Object.keys(TRIP_CLASS_LABEL) as TripClass[]
).map((value) => ({ value, label: TRIP_CLASS_LABEL[value] }));

/** For the two fare surfaces, where the wildcard is a real choice. */
export const TRIP_CLASS_OPTIONS_WITH_ANY: SelectOption[] = [
  { value: ANY_TRIP_CLASS, label: ANY_TRIP_CLASS_LABEL },
  ...TRIP_CLASS_OPTIONS,
];

/**
 * Renders any class value, wildcard included, for display.
 *
 * Takes `string | undefined` because every model field here carries a
 * default, which makes DRF mark it `required=False` and the generated
 * read types admit `undefined` even though a response always carries
 * one. Treating a missing value as the wildcard is the honest fallback:
 * it is what an unset class means everywhere else in this feature.
 */
export function tripClassLabel(value: string | undefined): string {
  if (!value) {
    return ANY_TRIP_CLASS_LABEL;
  }
  return TRIP_CLASS_LABEL[value as TripClass] ?? value;
}

/**
 * The classes a route may be scheduled in.
 *
 * **An empty allow-list means no restriction**, not "nothing allowed" —
 * that reading is what keeps every Route created before spec 15 usable,
 * and getting it backwards here would silently empty the class picker
 * on every existing route.
 */
export function allowedTripClassOptions(availableTripClasses: readonly string[]): SelectOption[] {
  if (availableTripClasses.length === 0) {
    return TRIP_CLASS_OPTIONS;
  }
  return TRIP_CLASS_OPTIONS.filter((option) =>
    availableTripClasses.includes(option.value as TripClass)
  );
}
