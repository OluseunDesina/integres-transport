import type { AbstractControl, FormGroup } from '@angular/forms';

/**
 * One way of turning a control's state into the sentence shown under
 * it, and one way of putting a server's field errors back where they
 * belong.
 *
 * Before this existed, `fieldError` was hand-written in seventeen
 * components and twelve of those returned the literal string
 * `'This field is required.'` for *any* invalid control, whatever
 * validator had actually failed. A value that was present but too small,
 * or malformed, or rejected by the server, was reported as missing.
 *
 * The server half is the other half of the same problem. The apps'
 * `extractFirstErrorMessage` helpers take DRF's `{field: ["message"]}`
 * and return the *first* message for a page-level alert — which
 * discards both the field it belonged to and every other field error in
 * the response. `applyServerErrors` puts each one on its own control
 * instead, and hands back only what could not be placed.
 *
 * Lives in `@shared-ui` rather than in one app because it is the same
 * problem in all of them: spec 14 slice 4 wrote it for
 * `client-admin-app`, slice 5 needed it in `customer-app`, and path
 * aliases only cross library boundaries. Nothing here is Angular-
 * component code — it is the presentation half of form validation,
 * which is what this library owns.
 */

/** The key `applyServerErrors` writes onto `control.errors`. Kept
 * distinct from Angular's own validator keys so a server complaint is
 * never mistaken for a client one, and so it can be cleared
 * independently. */
export const SERVER_ERROR_KEY = 'server';

/**
 * The server messages themselves, held beside the controls rather than
 * only inside `control.errors`.
 *
 * `setErrors` alone is not durable enough. Angular calls
 * `updateValueAndValidity` whenever a control is (re-)bound to a
 * `formControlName` directive, and that **replaces** `errors` with
 * whatever the validators return — so a message set on a control that
 * is not currently rendered, or one inside an `@if` that opens after
 * the response arrives (a per-segment fare's stop pickers, say),
 * vanished the moment the field appeared. Found by a white-label test
 * whose form happened to render for the first time after the submit.
 *
 * The snapshot of the value is how this self-clears: the message
 * applies to the value the server rejected, so the moment the control
 * holds anything else it no longer does. No subscription, nothing to
 * unsubscribe, and it cannot outlive the control — the map is weak.
 */
const SERVER_ERRORS = new WeakMap<AbstractControl, { message: string; value: unknown }>();

export interface FieldErrorOptions {
  /**
   * The field's own name, used in the default `required` message.
   * Without it the message is the generic "This field is required."
   */
  label?: string;
  /**
   * Per-validator overrides, for the cases where the generic wording is
   * wrong — `{ min: 'A fare cannot be negative.' }`.
   */
  messages?: Partial<Record<string, string>>;
}

function defaultMessage(key: string, error: unknown, label?: string): string {
  switch (key) {
    case 'required':
      return label ? `${label} is required.` : 'This field is required.';
    case 'email':
      return 'Enter a valid email address.';
    case 'min': {
      const min = (error as { min?: unknown })?.min;
      return min === undefined ? 'This value is too small.' : `Enter ${min} or more.`;
    }
    case 'max': {
      const max = (error as { max?: unknown })?.max;
      return max === undefined ? 'This value is too large.' : `Enter ${max} or less.`;
    }
    case 'minlength': {
      const length = (error as { requiredLength?: unknown })?.requiredLength;
      return length === undefined
        ? 'This value is too short.'
        : `Use at least ${length} characters.`;
    }
    case 'maxlength': {
      const length = (error as { requiredLength?: unknown })?.requiredLength;
      return length === undefined ? 'This value is too long.' : `Use at most ${length} characters.`;
    }
    case 'pattern':
      return 'This value is not in the expected format.';
    default:
      return 'This value is not valid.';
  }
}

/**
 * The message to show under a control, or `null` for none.
 *
 * Silent until the control is touched, so a pristine form does not open
 * covered in red. A **server** error is shown immediately regardless,
 * because the user has already submitted — waiting for a touch would
 * hide the very thing they need to read.
 */
export function fieldErrorMessage(
  control: AbstractControl | null | undefined,
  options: FieldErrorOptions = {}
): string | null {
  if (!control) {
    return null;
  }

  const serverError = SERVER_ERRORS.get(control);
  if (serverError) {
    if (serverError.value === control.value) {
      return serverError.message;
    }
    // The user has changed the value the server objected to.
    SERVER_ERRORS.delete(control);
  }

  if (!control.touched || control.valid || !control.errors) {
    return null;
  }

  // First declared error wins, which matches the order validators are
  // written in and keeps the message stable as the user types.
  const [key, error] = Object.entries(control.errors)[0];
  return options.messages?.[key] ?? defaultMessage(key, error, options.label);
}

export interface ServerErrorOptions {
  /**
   * Field names whose errors must go to the page-level alert because the
   * form renders no control for them — a control that exists only to
   * carry a value into the request body.
   *
   * Empty by default, because which fields those are is an app's own
   * business and a library must not ship one app's field name as a
   * default. An app with a standing answer wraps this rather than
   * repeating itself at every call site: see
   * `client-admin-app/src/app/shared/form-errors.ts`, which bakes in
   * `business` for all nine of its record forms.
   */
  unplaceable?: readonly string[];
}

/**
 * Distributes a DRF error body across a form's controls.
 *
 * Returns whatever could **not** be placed — `detail`,
 * `non_field_errors`, a field with no matching control, and anything
 * named in `unplaceable` — joined into one sentence for the page-level
 * alert, or `null` if the whole body landed on controls. A field error
 * with nowhere to go must still reach the user; silently dropping it
 * would be worse than the flat alert this replaces.
 *
 * Call it after a failed submit. Server errors clear as soon as the
 * control changes (see `clearServerError`), so a corrected field stops
 * complaining without a second round trip.
 */
export function applyServerErrors(
  form: FormGroup,
  error: unknown,
  fallback: string,
  options: ServerErrorOptions = {}
): string | null {
  if (!error || typeof error !== 'object') {
    return fallback;
  }

  const unplaceable = new Set(options.unplaceable ?? []);
  const unplaced: string[] = [];
  let placed = 0;

  for (const [field, value] of Object.entries(error as Record<string, unknown>)) {
    const message = Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string').join(' ')
      : typeof value === 'string'
        ? value
        : null;
    if (!message) {
      continue;
    }

    const control = form.get(field);
    if (
      control &&
      !unplaceable.has(field) &&
      field !== 'detail' &&
      field !== 'non_field_errors'
    ) {
      SERVER_ERRORS.set(control, { message, value: control.value });
      // Still set on `errors` so `form.invalid` and `aria-invalid` agree
      // with what is on screen — but the message above is the durable
      // copy, because this one does not survive re-registration.
      control.setErrors({ ...(control.errors ?? {}), [SERVER_ERROR_KEY]: message });
      control.markAsTouched();
      placed += 1;
    } else {
      unplaced.push(message);
    }
  }

  if (unplaced.length > 0) {
    return unplaced.join(' ');
  }
  // Nothing placed and nothing left over means the body was a shape this
  // does not understand — the user still needs to be told something.
  return placed > 0 ? null : fallback;
}

/**
 * Drops the server error from one control, leaving its client-side
 * validators intact.
 *
 * Editing a control already clears this by itself — the message is tied
 * to the value the server rejected. What this is for is the **start of
 * the next submit**: without it, a field the server rejected last time
 * still shows that message while the request is in flight, and if the
 * server no longer objects to that field the stale message simply
 * stays.
 */
export function clearServerError(control: AbstractControl | null | undefined): void {
  if (!control) {
    return;
  }

  SERVER_ERRORS.delete(control);

  if (!control.errors || !(SERVER_ERROR_KEY in control.errors)) {
    return;
  }
  const rest = { ...control.errors };
  delete rest[SERVER_ERROR_KEY];
  control.setErrors(Object.keys(rest).length > 0 ? rest : null);
}

/** `clearServerError` across every control in a group. */
export function clearServerErrors(form: FormGroup): void {
  for (const control of Object.values(form.controls)) {
    clearServerError(control);
  }
}
