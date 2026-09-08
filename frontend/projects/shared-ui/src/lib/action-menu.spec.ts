import { Component } from '@angular/core';
import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { ActionMenu, type ActionMenuItem } from './action-menu';

@Component({
  imports: [ActionMenu],
  template: `<ui-action-menu
    [items]="items"
    [label]="label"
    [triggerLabel]="triggerLabel"
    [disabled]="disabled"
    (selected)="chosen.push($event)"
  />`,
})
class HostComponent {
  items: ActionMenuItem[] = [
    { id: 'edit', label: 'Edit', icon: 'swatch' },
    { id: 'deactivate', label: 'Deactivate', danger: true },
  ];
  label = 'Actions for LAG-231-KJA';
  triggerLabel: string | null = null;
  disabled = false;
  chosen: string[] = [];
}

describe('ActionMenu', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  const trigger = () =>
    fixture.debugElement.query(By.css('button')).nativeElement as HTMLButtonElement;
  const menuItems = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));

  const open = () => {
    trigger().click();
    fixture.detectChanges();
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('names the trigger for the row it belongs to', () => {
    // Every row renders one of these; without a row-specific name a
    // screen reader announces an identical "Actions" per row.
    expect(trigger().getAttribute('aria-label')).toBe('Actions for LAG-231-KJA');
  });

  it('renders nothing until opened', () => {
    expect(menuItems().length).toBe(0);
  });

  it('renders a real menu with a menuitem per action', () => {
    open();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(menuItems().map((item) => item.textContent?.trim())).toEqual(['Edit', 'Deactivate']);
  });

  it('emits the chosen item id, once the menu has closed', fakeAsync(() => {
    open();
    menuItems()[0].click();
    fixture.detectChanges();
    // Deliberately not yet: CDK emits `triggered` before it closes the
    // menu, so emitting here would hand a consumer a focus target that
    // is about to be destroyed.
    expect(host.chosen).toEqual([]);

    tick();
    expect(host.chosen).toEqual(['edit']);
  }));

  it('closes after a choice', () => {
    open();
    menuItems()[1].click();
    fixture.detectChanges();
    expect(menuItems().length).toBe(0);
  });

  it('returns focus to its trigger on close', () => {
    // Losing focus to <body> after a row action strands a keyboard user
    // at the top of the document.
    open();
    menuItems()[0].click();
    fixture.detectChanges();
    expect(document.activeElement).toBe(trigger());
  });

  it('has already restored focus by the time it emits', fakeAsync(() => {
    // The contract a consumer depends on. A handler that opens a dialog
    // captures document.activeElement as its focus-restoration target,
    // so if this fired while the menu item still held focus, closing
    // that dialog would drop focus to <body>. Found in a real browser;
    // no synchronous assertion could have shown it.
    let focusedAtEmit: Element | null | undefined;
    host.chosen = {
      push: () => {
        focusedAtEmit = document.activeElement;
        return 1;
      },
    } as unknown as string[];

    open();
    menuItems()[0].click();
    fixture.detectChanges();
    tick();

    expect(focusedAtEmit).toBe(trigger());
  }));

  it('closes on Escape without choosing anything', fakeAsync(() => {
    open();
    // CDK's menu switches on the legacy `keyCode`, which the
    // KeyboardEvent constructor ignores — an event carrying only
    // `key: 'Escape'` arrives with keyCode 0 and is silently ignored.
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    Object.defineProperty(escape, 'keyCode', { get: () => 27 });
    document.querySelector('[role="menu"]')!.dispatchEvent(escape);
    fixture.detectChanges();
    tick();
    expect(menuItems().length).toBe(0);
    expect(host.chosen).toEqual([]);
  }));

  it('styles a destructive item in the danger tone without confirming it', () => {
    // Confirmation is the caller's ui-confirm-dialog — the menu's job is
    // to make the action deliberate, not to own the write.
    open();
    expect(menuItems()[1].classList).toContain('text-danger');
    expect(host.chosen).toEqual([]);
  });

  it('marks a disabled item aria-disabled and refuses to emit it', fakeAsync(() => {
    host.items = [{ id: 'edit', label: 'Edit', disabled: true }];
    fixture.detectChanges();
    open();
    expect(menuItems()[0].getAttribute('aria-disabled')).toBe('true');
    menuItems()[0].click();
    fixture.detectChanges();
    tick();
    expect(host.chosen).toEqual([]);
  }));

  it('leaves a disabled item focusable, so arrow keys do not stall on it', () => {
    // CDK's key manager runs skipPredicate(() => false) and deliberately
    // lands on disabled items; a native `disabled` attribute would make
    // focus() a no-op and strand arrow navigation there.
    host.items = [{ id: 'edit', label: 'Edit', disabled: true }];
    fixture.detectChanges();
    open();
    expect(menuItems()[0].disabled).toBeFalse();
  });

  it('cannot be opened while the trigger is disabled', () => {
    host.disabled = true;
    fixture.detectChanges();
    expect(trigger().disabled).toBeTrue();
    open();
    expect(menuItems().length).toBe(0);
  });

  it('sizes its trigger from the surface profile, not a fixed 44px', () => {
    // One of these renders per row, so a fixed floor sets the row height
    // for the whole console — it took the vehicles table from ~40px rows
    // to ~68px. `console` resolves this to 36px and `consumer` to 44px;
    // 36px clears WCAG 2.2 SC 2.5.8's 24px minimum.
    expect(trigger().style.minHeight).toBe('var(--ui-control-height)');
    expect(trigger().style.minWidth).toBe('var(--ui-control-height)');
  });

  it('grows to whatever the profile sets, rather than ignoring the token', () => {
    // The token is set here rather than relied on from theme.css, which
    // Karma does not load — this asserts the *component* consumes it. A
    // button that ignored it would collapse to its 20px icon with no
    // usable hit area.
    const button = trigger();
    for (const [value, expected] of [
      ['2.25rem', 36],
      ['2.75rem', 44],
    ] as const) {
      document.documentElement.style.setProperty('--ui-control-height', value);
      expect(button.getBoundingClientRect().height)
        .withContext(`--ui-control-height: ${value}`)
        .toBeGreaterThanOrEqual(expected);
    }
    document.documentElement.style.removeProperty('--ui-control-height');
  });

  it('is icon-only by default, as a table row wants', () => {
    expect(trigger().textContent?.trim()).toBe('');
  });

  it('renders a visible label when given one', () => {
    // A standalone menu needs one: the shell's quick-create control
    // first shipped as a bare "…" in a top bar, which told nobody it
    // creates records. `aria-label` reaches screen-reader users only.
    host.triggerLabel = 'New';
    fixture.detectChanges();

    expect(trigger().textContent).toContain('New');
    // The accessible name stays the fuller one — it is what a screen
    // reader announces, and "New" alone is not enough there.
    expect(trigger().getAttribute('aria-label')).toBe('Actions for LAG-231-KJA');
  });
});
