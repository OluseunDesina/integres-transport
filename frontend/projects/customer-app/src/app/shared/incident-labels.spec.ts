import { CATEGORY_OPTIONS, categoryLabel, statusLabel, statusTone } from './incident-labels';

describe('incident-labels', () => {
  it('speaks to the person waiting, not to the person triaging', () => {
    // The operator console calls these "Open" and "Investigating".
    expect(statusLabel('open')).toBe('Received');
    expect(statusLabel('investigating')).toBe('Being investigated');
  });

  it('never paints a received report as a problem', () => {
    // `client-admin-app` renders `open` as `negative`, which is right in
    // a triage queue and wrong here: on this screen the row means "we
    // have your report".
    expect(statusTone('open')).toBe('neutral');
    expect(statusTone('acknowledged')).toBe('warning');
    expect(statusTone('resolved')).toBe('positive');
  });

  it('falls back to the raw value rather than rendering blank', () => {
    // A category the backend adds before this app catches up must still
    // be readable — an empty cell is worse than an ugly one.
    expect(categoryLabel('teleportation')).toBe('teleportation');
    expect(statusLabel('escalated')).toBe('escalated');
    expect(statusTone('escalated')).toBe('neutral');
  });

  it('opens the category picker on a question, not on an answer', () => {
    // `hardware` happens to be first in the enum, and a select that
    // silently pre-answers is how a form submits something nobody
    // chose.
    expect(CATEGORY_OPTIONS[0].value).toBe('');
    expect(CATEGORY_OPTIONS.map((option) => option.value)).toContain('hardware');
  });
});
