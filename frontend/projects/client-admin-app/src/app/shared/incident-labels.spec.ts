import {
  categoryLabel,
  nextStatuses,
  severityLabel,
  severityTone,
  statusLabel,
  statusTone,
  transitionLabel,
  type IncidentStatus,
} from './incident-labels';

const ALL_STATUSES: IncidentStatus[] = [
  'open',
  'acknowledged',
  'investigating',
  'resolved',
  'closed',
];

describe('incident labels', () => {
  it('labels and tones every status', () => {
    for (const status of ALL_STATUSES) {
      expect(statusLabel(status)).not.toBe(status);
      expect(statusTone(status)).toBeTruthy();
    }
  });

  it('labels and tones every severity, escalating to negative at critical', () => {
    expect(severityTone('low')).toBe('neutral');
    expect(severityTone('high')).toBe('warning');
    expect(severityTone('critical')).toBe('negative');
    expect(severityLabel('critical')).toBe('Critical');
  });

  it('falls back to the raw value rather than rendering blank', () => {
    // A value the backend adds before this file catches up must still
    // render as something a person can read, not as an empty pill.
    expect(statusLabel('escalated')).toBe('escalated');
    expect(categoryLabel('weather')).toBe('weather');
    expect(statusTone('escalated')).toBe('neutral');
  });
});

describe('nextStatuses', () => {
  it('mirrors the backend lifecycle for every status', () => {
    expect(nextStatuses('open')).toEqual(['acknowledged', 'investigating', 'resolved']);
    expect(nextStatuses('acknowledged')).toEqual(['investigating', 'resolved']);
    expect(nextStatuses('investigating')).toEqual(['resolved']);
    expect(nextStatuses('resolved')).toEqual(['closed', 'investigating']);
    expect(nextStatuses('closed')).toEqual(['investigating']);
  });

  it('offers both reopen paths', () => {
    // A fault reported fixed and still broken is the normal case;
    // forcing a duplicate record would lose the history.
    expect(nextStatuses('resolved')).toContain('investigating');
    expect(nextStatuses('closed')).toContain('investigating');
  });

  it('never offers a move back to open', () => {
    for (const status of ALL_STATUSES) {
      expect(nextStatuses(status)).not.toContain('open');
    }
  });

  it('offers nothing for an unknown status rather than guessing', () => {
    expect(nextStatuses('escalated')).toEqual([]);
  });
});

describe('transitionLabel', () => {
  it('calls a reopen a reopen', () => {
    expect(transitionLabel('resolved', 'investigating')).toBe('Reopen');
    expect(transitionLabel('closed', 'investigating')).toBe('Reopen');
  });

  it('uses the plain verb when moving forward', () => {
    expect(transitionLabel('open', 'investigating')).toBe('Investigate');
    expect(transitionLabel('open', 'acknowledged')).toBe('Acknowledge');
    expect(transitionLabel('investigating', 'resolved')).toBe('Resolve');
    expect(transitionLabel('resolved', 'closed')).toBe('Close');
  });
});
