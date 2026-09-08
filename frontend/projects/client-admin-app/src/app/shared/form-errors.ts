import type { FormGroup } from '@angular/forms';
import { applyServerErrors as applyServerErrorsBase } from '@shared-ui';
import type { ServerErrorOptions } from '@shared-ui';

/**
 * This console's form-error helpers.
 *
 * The implementation moved to `@shared-ui` in spec 14 slice 5, when
 * `customer-app` needed it too and path aliases only cross library
 * boundaries. What stays here is the one thing that is genuinely this
 * app's: which control names carry a value but render no field.
 */

export {
  SERVER_ERROR_KEY,
  clearServerError,
  clearServerErrors,
  fieldErrorMessage,
} from '@shared-ui';
export type { FieldErrorOptions, ServerErrorOptions } from '@shared-ui';

/**
 * Controls that exist only as value carriers and render no field, so an
 * error placed on them would be invisible.
 *
 * Every one of this console's nine record forms holds `business` this
 * way: it is resolved from the header's Business switcher rather than
 * picked in the form, and the control survives only to carry the value
 * into the POST body. `POST /routes/` can still reject it — "This
 * Business must be KYB-approved" is a real response — and that has to
 * reach the page-level alert, because there is no field to put it under.
 *
 * Baked into the wrapper below rather than passed at nine call sites:
 * forgetting it on a tenth form would swallow the message silently,
 * which is the one outcome the module exists to prevent. A form that
 * *does* render a business field passes `{ unplaceable: [] }`.
 */
export const HIDDEN_VALUE_CARRIERS: readonly string[] = ['business'];

/** `@shared-ui`'s `applyServerErrors` with this app's hidden value
 * carriers applied unless the caller says otherwise. */
export function applyServerErrors(
  form: FormGroup,
  error: unknown,
  fallback: string,
  options: ServerErrorOptions = {}
): string | null {
  return applyServerErrorsBase(form, error, fallback, {
    unplaceable: HIDDEN_VALUE_CARRIERS,
    ...options,
  });
}
