import type { components } from '@api-client';
import type { SelectOption } from '@shared-ui';

type CurrencyEnum = components['schemas']['CurrencyEnum'];

/**
 * Mirrors `apps.businesses.models.Business.Currency` — the backend is
 * the authority, and `CurrencyEnum` above makes this list fail to
 * compile if a code is added or removed there without being reflected
 * here.
 *
 * Free text before this existed: a user could type `Naira`, or a
 * well-formed-but-unsupported code like `GBP`, and only discover the
 * problem once a passenger's first payment reached Paystack.
 *
 * `BWP` is listed but labelled as unsupported for payments — per
 * `docs/adr/0007`, Botswana is a named open gap rather than a market
 * we pretend doesn't exist, so its operators stay onboardable even
 * though no PSP can settle for them yet.
 */
export const CURRENCY_OPTIONS: readonly {
  value: CurrencyEnum;
  label: string;
}[] = [
  { value: 'NGN', label: 'NGN — Nigerian Naira' },
  { value: 'GHS', label: 'GHS — Ghanaian Cedi' },
  { value: 'KES', label: 'KES — Kenyan Shilling' },
  { value: 'ZAR', label: 'ZAR — South African Rand' },
  { value: 'XOF', label: 'XOF — West African CFA Franc' },
  { value: 'USD', label: 'USD — US Dollar' },
  { value: 'BWP', label: 'BWP — Botswana Pula (no payment partner yet)' },
];

export const CURRENCY_SELECT_OPTIONS: SelectOption[] = CURRENCY_OPTIONS.map(({ value, label }) => ({
  value,
  label,
}));
