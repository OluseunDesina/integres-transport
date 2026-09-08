import { FormBuilder, Validators } from '@angular/forms';

import {
  SERVER_ERROR_KEY,
  applyServerErrors,
  clearServerErrors,
  fieldErrorMessage,
} from './form-errors';

describe('fieldErrorMessage', () => {
  const fb = new FormBuilder();

  function form() {
    return fb.group({
      name: ['', Validators.required],
      email: ['', [Validators.required, Validators.email]],
      amount: [null as number | null, [Validators.required, Validators.min(1)]],
    });
  }

  it('says nothing about a control the user has not touched', () => {
    // A pristine form must not open covered in red.
    expect(fieldErrorMessage(form().controls.name)).toBeNull();
  });

  it('reports a missing value as missing', () => {
    const control = form().controls.name;
    control.markAsTouched();

    expect(fieldErrorMessage(control)).toBe('This field is required.');
  });

  it('names the field when given a label', () => {
    const control = form().controls.name;
    control.markAsTouched();

    expect(fieldErrorMessage(control, { label: 'Route name' })).toBe('Route name is required.');
  });

  // The defect this module exists for: every one of these used to read
  // "This field is required." while holding a value.
  it('reports a malformed email as malformed, not missing', () => {
    const control = form().controls.email;
    control.setValue('not-an-email');
    control.markAsTouched();

    expect(fieldErrorMessage(control)).toBe('Enter a valid email address.');
  });

  it('reports a too-small number with the bound it failed', () => {
    const control = form().controls.amount;
    control.setValue(0);
    control.markAsTouched();

    expect(fieldErrorMessage(control)).toBe('Enter 1 or more.');
  });

  it('takes a per-validator override where the generic wording is wrong', () => {
    const control = form().controls.amount;
    control.setValue(0);
    control.markAsTouched();

    expect(fieldErrorMessage(control, { messages: { min: 'A fare cannot be zero.' } })).toBe(
      'A fare cannot be zero.'
    );
  });

  it('shows a server error even on an untouched control', () => {
    // The user has already submitted; waiting for a touch would hide
    // the one thing they need to read.
    const group = form();
    applyServerErrors(group, { name: ['Already exists.'] }, 'Could not save.');
    group.controls.name.markAsUntouched();

    expect(fieldErrorMessage(group.controls.name)).toBe('Already exists.');
  });

  // `setErrors` does not survive a control being (re-)bound to a
  // `formControlName` directive: Angular calls `updateValueAndValidity`
  // and replaces `errors` wholesale. A white-label test caught this by
  // rendering its form for the first time *after* the submit, and a
  // field inside an `@if` that opens later would hit it in production.
  it('survives the control being revalidated, as binding a field does', () => {
    const group = form();
    applyServerErrors(group, { name: ['Already exists.'] }, 'Could not save.');

    group.controls.name.updateValueAndValidity();

    expect(group.controls.name.errors?.[SERVER_ERROR_KEY]).toBeUndefined();
    expect(fieldErrorMessage(group.controls.name)).toBe('Already exists.');
  });

  it('tolerates a missing control', () => {
    expect(fieldErrorMessage(null)).toBeNull();
  });
});

describe('applyServerErrors', () => {
  const fb = new FormBuilder();

  function form() {
    return fb.group({ name: ['Ikeja'], code: ['IKJ'] });
  }

  it('puts each field error on its own control', () => {
    const group = form();

    const remainder = applyServerErrors(
      group,
      { name: ['Already exists.'], code: ['Too long.'] },
      'Could not save.'
    );

    expect(fieldErrorMessage(group.controls.name)).toBe('Already exists.');
    expect(fieldErrorMessage(group.controls.code)).toBe('Too long.');
    // Both landed, so the page-level alert has nothing left to say.
    expect(remainder).toBeNull();
  });

  it('joins a list of messages for one field', () => {
    const group = form();
    applyServerErrors(group, { name: ['Too short.', 'Already exists.'] }, 'Could not save.');

    expect(fieldErrorMessage(group.controls.name)).toBe('Too short. Already exists.');
  });

  it('returns detail and non-field errors for the page-level alert', () => {
    const group = form();

    const remainder = applyServerErrors(group, { detail: 'Not allowed.' }, 'Could not save.');

    expect(remainder).toBe('Not allowed.');
    expect(fieldErrorMessage(group.controls.name)).toBeNull();
  });

  // Dropping one would be worse than the flat alert this replaces.
  it('surfaces a field error with no matching control rather than dropping it', () => {
    const group = form();

    const remainder = applyServerErrors(
      group,
      { business: ['Not yours.'] },
      'Could not save.'
    );

    expect(remainder).toBe('Not yours.');
  });

  // Nine console forms carry `business` as a value carrier with no
  // field on screen. Placed on that control, the message would be
  // invisible — which is the one outcome this module exists to prevent.
  // The library holds no opinion about which names those are; the app
  // names them (client-admin-app/src/app/shared/form-errors.ts).
  it("sends a named value carrier's error to the alert, not to its control", () => {
    const group = fb.group({ business: ['biz-1'], name: ['Ikeja'] });

    const remainder = applyServerErrors(
      group,
      { business: ['This Business must be KYB-approved before creating Routes.'] },
      'Could not save.',
      { unplaceable: ['business'] }
    );

    expect(remainder).toBe('This Business must be KYB-approved before creating Routes.');
    expect(fieldErrorMessage(group.controls.business)).toBeNull();
  });

  it('places it on the control by default, since most forms render their fields', () => {
    const group = fb.group({ business: ['biz-1'] });

    const remainder = applyServerErrors(group, { business: ['Not yours.'] }, 'Could not save.');

    expect(remainder).toBeNull();
    expect(fieldErrorMessage(group.controls.business)).toBe('Not yours.');
  });

  it('falls back when the body is a shape it does not understand', () => {
    expect(applyServerErrors(form(), 'boom', 'Could not save.')).toBe('Could not save.');
    expect(applyServerErrors(form(), { name: 42 }, 'Could not save.')).toBe('Could not save.');
  });

  it('marks the control touched so the message actually renders', () => {
    // `ui-text-field` shows nothing unless the parent binds `invalid`,
    // and every caller derives that from this module — an untouched
    // control would have kept the message invisible.
    const group = form();
    applyServerErrors(group, { name: ['Already exists.'] }, 'Could not save.');

    expect(group.controls.name.touched).toBeTrue();
  });

  it('is cleared by editing the control', () => {
    const group = form();
    applyServerErrors(group, { name: ['Already exists.'] }, 'Could not save.');

    group.controls.name.setValue('Ikeja Express');

    expect(fieldErrorMessage(group.controls.name)).toBeNull();
  });

  it('is cleared wholesale before the next submit', () => {
    const group = form();
    applyServerErrors(group, { name: ['Already exists.'] }, 'Could not save.');

    clearServerErrors(group);

    expect(fieldErrorMessage(group.controls.name)).toBeNull();
  });

  it('leaves client-side validators alone when clearing', () => {
    const group = fb.group({ name: ['', Validators.required] });
    applyServerErrors(group, { name: ['Already exists.'] }, 'Could not save.');

    clearServerErrors(group);

    expect(group.controls.name.hasError('required')).toBeTrue();
    expect(fieldErrorMessage(group.controls.name)).toBe('This field is required.');
  });
});
