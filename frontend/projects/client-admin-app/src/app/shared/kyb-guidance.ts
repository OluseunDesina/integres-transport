import type { SelectOption } from '@shared-ui';

/**
 * Copy for the KYB screen — docs/specs/11-kyb-directors.md's "Guidance
 * text" section, kept out of the template so the wording is reviewable
 * in one place rather than scattered through markup.
 *
 * The point of this screen is that an operator can tell what a valid
 * document looks like *before* uploading one, instead of discovering it
 * from a rejection days later.
 */

/** Mirrors `apps.businesses.models.Director.IdType`. */
export const ID_TYPE_OPTIONS: SelectOption[] = [
  { value: 'nin', label: 'National Identification Number (NIN)' },
  { value: 'passport', label: 'International passport' },
  { value: 'drivers_licence', label: "Driver's licence" },
  { value: 'voters_card', label: "Voter's card" },
];

/** What a valid document looks like, per ID type. */
export const ID_TYPE_GUIDANCE: Record<string, string> = {
  nin: 'A NIN slip or NIMC card showing the 11-digit number clearly.',
  passport: 'The data page of an international passport, showing the photo and expiry date.',
  drivers_licence: 'A current driver’s licence, front side, not expired.',
  voters_card: 'A permanent voter’s card (PVC), front side.',
};

export const ID_GENERAL_GUIDANCE =
  'The document must be in date, and the name on it must match the director’s name as entered above.';

export const PROOF_OF_ADDRESS_GUIDANCE =
  'A utility bill, bank statement, or tenancy agreement dated within the last 3 months, showing the business name and address.';

export const CERTIFICATE_GUIDANCE =
  'The CAC certificate of incorporation for this business.';

export const TAX_CERTIFICATE_GUIDANCE =
  'A current tax clearance certificate or TIN registration document.';

export const OTHER_GUIDANCE =
  'Anything else supporting this application — a board resolution, a licence, a letter of authority.';
