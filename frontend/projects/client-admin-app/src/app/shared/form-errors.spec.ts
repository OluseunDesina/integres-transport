import { FormBuilder } from '@angular/forms';
import { fieldErrorMessage } from '@shared-ui';

import { HIDDEN_VALUE_CARRIERS, applyServerErrors } from './form-errors';

/**
 * The module itself is tested in `@shared-ui`. What is tested here is
 * the only thing this app adds: that `business` is still diverted to the
 * page-level alert without any call site asking for it.
 *
 * That default is the reason this wrapper exists at all. Spec 14 slice 5
 * moved the implementation into the library, where a `business` default
 * would have been one app's field name shipped to all four — but nine
 * forms here depend on it, and passing it nine times is how a tenth form
 * ends up silently swallowing the message.
 */
describe('client-admin form errors', () => {
  const fb = new FormBuilder();

  it('diverts a business error to the alert with no options passed', () => {
    const group = fb.group({ business: ['biz-1'], name: ['Ikeja'] });

    const remainder = applyServerErrors(
      group,
      { business: ['This Business must be KYB-approved before creating Routes.'] },
      'Could not save.'
    );

    expect(remainder).toBe('This Business must be KYB-approved before creating Routes.');
    expect(fieldErrorMessage(group.controls.business)).toBeNull();
  });

  it('still places every other field error on its own control', () => {
    const group = fb.group({ business: ['biz-1'], name: ['Ikeja'] });

    const remainder = applyServerErrors(group, { name: ['Already exists.'] }, 'Could not save.');

    expect(remainder).toBeNull();
    expect(fieldErrorMessage(group.controls.name)).toBe('Already exists.');
  });

  it('lets a form that renders a business field opt out', () => {
    const group = fb.group({ business: ['biz-1'] });

    const remainder = applyServerErrors(group, { business: ['Not yours.'] }, 'Could not save.', {
      unplaceable: [],
    });

    expect(remainder).toBeNull();
    expect(fieldErrorMessage(group.controls.business)).toBe('Not yours.');
  });

  it('names business as the carrier', () => {
    expect(HIDDEN_VALUE_CARRIERS).toEqual(['business']);
  });
});
