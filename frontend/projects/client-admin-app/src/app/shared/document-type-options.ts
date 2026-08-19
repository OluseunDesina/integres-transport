import type { SelectOption } from '@shared-ui';

/** Shared between Client KYC and Business KYB uploads — both use the
 * same `DocumentTypeEnum` on the backend. */
export const DOCUMENT_TYPE_OPTIONS: SelectOption[] = [
  { value: 'certificate_of_incorporation', label: 'Certificate of incorporation' },
  { value: 'proof_of_address', label: 'Proof of address' },
  { value: 'directors_id', label: "Director's ID" },
  { value: 'tax_certificate', label: 'Tax certificate' },
  { value: 'other', label: 'Other' },
];
