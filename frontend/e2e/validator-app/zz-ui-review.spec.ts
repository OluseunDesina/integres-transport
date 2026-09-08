import { captureUiReview } from '../ui-review-capture';

// Skipped unless UI_REVIEW_DIR is set — see ../ui-review-capture.ts.
captureUiReview({
  email: 'e2e-client-staff@example.com',
  screens: [
    ['login', '/login'],
    ['record', '/record'],
    ['validate-ticket', '/validate-ticket'],
    // Spec 17 slice 3.
    ['report-issue', '/report-issue'],
  ],
});
