import type { StatusPillTone } from '@shared-ui';

type DocumentReviewStatus = 'pending' | 'submitted' | 'approved' | 'rejected';

export function documentReviewStatusTone(status: DocumentReviewStatus): StatusPillTone {
  switch (status) {
    case 'approved':
      return 'positive';
    case 'submitted':
      return 'warning';
    case 'rejected':
      return 'negative';
    case 'pending':
      return 'neutral';
  }
}
