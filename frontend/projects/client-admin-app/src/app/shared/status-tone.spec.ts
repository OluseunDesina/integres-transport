import { documentReviewStatusTone } from './status-tone';

describe('documentReviewStatusTone', () => {
  it('maps each status to its tone', () => {
    expect(documentReviewStatusTone('pending')).toBe('neutral');
    expect(documentReviewStatusTone('submitted')).toBe('warning');
    expect(documentReviewStatusTone('approved')).toBe('positive');
    expect(documentReviewStatusTone('rejected')).toBe('negative');
  });
});
