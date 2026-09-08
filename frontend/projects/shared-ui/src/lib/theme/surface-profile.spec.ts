import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';

import { Alert } from '../alert';
import { Button } from '../button';
import { EmptyState } from '../empty-state';
import { Select } from '../select';
import { Table } from '../table';
import { TextField } from '../text-field';

/**
 * The surface profile, measured rather than asserted.
 *
 * `theme.css` defines two densities and every app declares one on
 * `<html>` — but until spec 14 slice 5 nothing read `--ui-text-body`, so
 * `customer-app` rendered at console density despite carrying
 * `data-surface="consumer"`. The profile existed and did nothing.
 *
 * Two things are worth guarding, and they pull in opposite directions:
 *
 * 1. **The consumer profile must reach the controls.** A focused input
 *    under 16px makes iOS Safari zoom the whole page, which is the
 *    concrete defect that motivated the change.
 * 2. **The consoles must not move.** This touches all four apps, and
 *    three of them were not meant to change at all.
 *
 * **This suite loads no stylesheet** — `shared-ui`'s Karma target has no
 * `styles` entry, so `theme.css` is not in the cascade and the tokens
 * are undefined here. What it can prove is the wiring: that each
 * component's size comes from `--ui-text-body` and follows it when it
 * changes. It sets the variable directly, the way `action-menu.spec.ts`
 * already does for `--ui-control-height`.
 *
 * The *values* those variables actually hold under each profile are
 * `theme.css`'s, and are measured against the real stylesheet in a real
 * browser by `e2e/customer-app/type-scale.spec.ts`. Neither check is
 * sufficient alone: this one would pass if `theme.css` set the wrong
 * number, and that one would pass if only one component were wired up.
 */

const PROFILE_BODY_SIZE = {
  // Mirrors theme.css's surface-profile block. The e2e check is what
  // proves these are still the real values.
  console: '14px',
  consumer: '16px',
} as const;

@Component({
  imports: [Alert, Button, EmptyState, Select, Table, TextField],
  template: `
    <ui-button>Go</ui-button>
    <ui-text-field label="Amount" />
    <ui-select label="Operator" [options]="[]" />
    <ui-alert>Something went wrong.</ui-alert>
    <ui-empty-state title="Nothing here" description="Yet." />
    <ui-table label="Rows">
      <tbody>
        <tr>
          <td>Cell</td>
        </tr>
      </tbody>
    </ui-table>
  `,
})
class Host {}

describe('surface profile', () => {
  let fixture: ComponentFixture<Host>;

  function fontSizeOf(selector: string): string {
    const element = fixture.nativeElement.querySelector(selector) as HTMLElement | null;
    if (!element) {
      throw new Error(`no element matched ${selector}`);
    }
    return getComputedStyle(element).fontSize;
  }

  function renderUnder(profile: keyof typeof PROFILE_BODY_SIZE): void {
    document.documentElement.style.setProperty('--ui-text-body', PROFILE_BODY_SIZE[profile]);
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
  }

  afterEach(() => document.documentElement.style.removeProperty('--ui-text-body'));

  it('sizes the controls from the console profile', () => {
    renderUnder('console');

    expect(fontSizeOf('ui-button button')).toBe('14px');
    expect(fontSizeOf('ui-text-field input')).toBe('14px');
    expect(fontSizeOf('ui-select select')).toBe('14px');
  });

  // The reason the change was worth making: below 16px, iOS Safari zooms
  // the page the moment the field takes focus.
  it('sizes the controls from the consumer profile', () => {
    renderUnder('consumer');

    expect(fontSizeOf('ui-button button')).toBe('16px');
    expect(fontSizeOf('ui-text-field input')).toBe('16px');
    expect(fontSizeOf('ui-select select')).toBe('16px');
  });

  it('sizes a field label with the field it belongs to', () => {
    renderUnder('consumer');

    expect(fontSizeOf('ui-text-field label')).toBe('16px');
    expect(fontSizeOf('ui-select label')).toBe('16px');
  });

  it('sizes alerts and empty states with the page', () => {
    renderUnder('consumer');

    expect(fontSizeOf('ui-alert div')).toBe('16px');
    expect(fontSizeOf('ui-empty-state h2')).toBe('16px');
  });

  /**
   * Deliberate, not an omission — see the comment in table.ts. The
   * responsive-tables slice fitted these into 390px at 14px, and growing
   * every cell would reopen that.
   *
   * Asserted as "does not follow the token" rather than "is 14px",
   * because 14px comes from the `text-sm` class and no stylesheet is
   * loaded here — an equality check would be measuring the browser
   * default, and would have passed just as happily if the table *were*
   * wired to the token. That it is 14px in a real browser is
   * `e2e/customer-app/type-scale.spec.ts`'s to prove.
   */
  it('leaves a table unmoved when the profile changes', () => {
    renderUnder('console');
    const consoleTable = fontSizeOf('ui-table table');
    const consoleButton = fontSizeOf('ui-button button');

    renderUnder('consumer');

    expect(fontSizeOf('ui-table table')).toBe(consoleTable);
    // ...while the control beside it did move, so this is the table
    // opting out rather than the token failing to apply at all.
    expect(fontSizeOf('ui-button button')).not.toBe(consoleButton);
  });
});
