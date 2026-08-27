/**
 * Pulls the first human-readable string out of a DRF error body.
 *
 * DRF returns field errors as `{field: ["message", ...]}` and
 * non-field/typed-exception errors as `{"detail": "message"}`, so both
 * shapes have to be handled. This was copy-pasted into a dozen
 * components before it lived here; new call sites should import it
 * rather than paste it again.
 */
export function extractFirstErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    for (const value of Object.values(error as Record<string, unknown>)) {
      if (Array.isArray(value) && typeof value[0] === 'string') {
        return value[0];
      }
      if (typeof value === 'string') {
        return value;
      }
    }
  }
  return fallback;
}
