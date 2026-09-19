import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { Icon, type IconName } from './icon';

/**
 * Every name in the union, listed exhaustively. `Record<IconName, true>`
 * is the point: adding a name to the union without adding it here fails
 * the build, so this list cannot silently fall behind. Adding a name
 * without a path renders `d=""` — an icon-shaped hole that no existing
 * test would have caught.
 */
const ALL_ICON_NAMES: Record<IconName, true> = {
  home: true,
  'building-office': true,
  map: true,
  'map-pin': true,
  users: true,
  identification: true,
  swatch: true,
  'clipboard-document-check': true,
  'document-check': true,
  'user-plus': true,
  'arrow-right-start-on-rectangle': true,
  'chevron-double-left': true,
  'chevron-double-right': true,
  'chevron-up-down': true,
  check: true,
  truck: true,
  'squares-2x2': true,
  'user-circle': true,
  'calendar-days': true,
  clock: true,
  banknotes: true,
  'book-open': true,
  'credit-card': true,
  tag: true,
  bolt: true,
  bell: true,
  'ellipsis-horizontal': true,
  'x-mark': true,
  'magnifying-glass': true,
  'arrow-down-tray': true,
  'chevron-down': true,
  'bars-3': true,
  'bars-4': true,
  funnel: true,
  'arrow-up': true,
  'arrow-down': true,
  'chart-bar': true,
  'exclamation-triangle': true,
  signal: true,
  'arrows-right-left': true,
  'shield-check': true,
  ticket: true,
  'arrow-right': true,
  'chevron-left': true,
  'chevron-right': true,
  'adjustments-horizontal': true,
};

describe('Icon', () => {
  let fixture: ComponentFixture<Icon>;

  async function render(name: string, size?: number): Promise<void> {
    await TestBed.configureTestingModule({ imports: [Icon] }).compileComponents();
    fixture = TestBed.createComponent(Icon);
    fixture.componentRef.setInput('name', name);
    if (size !== undefined) {
      fixture.componentRef.setInput('size', size);
    }
    fixture.detectChanges();
  }

  it('renders the path data for the given icon name', async () => {
    await render('home');
    const path = fixture.debugElement.query(By.css('path'));
    expect(path.nativeElement.getAttribute('d')).toContain('M2.25 12l8.954-8.955');
  });

  it('renders a different path for a different icon name', async () => {
    await render('users');
    const path = fixture.debugElement.query(By.css('path'));
    expect(path.nativeElement.getAttribute('d')).toContain('M15 19.128');
  });

  it('defaults to a 24x24 svg and marks it aria-hidden', async () => {
    await render('home');
    const svg = fixture.debugElement.query(By.css('svg'));
    expect(svg.nativeElement.getAttribute('width')).toBe('24');
    expect(svg.nativeElement.getAttribute('height')).toBe('24');
    expect(svg.nativeElement.getAttribute('aria-hidden')).toBe('true');
  });

  it('respects a custom size', async () => {
    await render('home', 20);
    const svg = fixture.debugElement.query(By.css('svg'));
    expect(svg.nativeElement.getAttribute('width')).toBe('20');
  });

  it('renders the banknotes icon added for the Payments nav item', async () => {
    await render('banknotes');
    const path = fixture.debugElement.query(By.css('path'));
    expect(path.nativeElement.getAttribute('d')).toContain('M12 7.5h1.5');
  });

  it('renders the book-open icon added for the Ledger nav item', async () => {
    await render('book-open');
    const path = fixture.debugElement.query(By.css('path'));
    expect(path.nativeElement.getAttribute('d')).toContain('M12 6.042A8.967');
  });

  it('renders the credit-card icon added for the Wallet Lookup nav item', async () => {
    await render('credit-card');
    const path = fixture.debugElement.query(By.css('path'));
    expect(path.nativeElement.getAttribute('d')).toContain('M2.25 8.25h19.5');
  });

  it('renders the tag icon added for the Fares nav item', async () => {
    await render('tag');
    const path = fixture.debugElement.query(By.css('path'));
    expect(path.nativeElement.getAttribute('d')).toContain('M9.568 3H5.25');
  });

  it('renders the bolt icon added for the Tap & Go nav item', async () => {
    await render('bolt');
    const path = fixture.debugElement.query(By.css('path'));
    expect(path.nativeElement.getAttribute('d')).toContain('M3.75 13.5');
  });

  it('renders the bell icon added for the notification bell', async () => {
    await render('bell');
    const path = fixture.debugElement.query(By.css('path'));
    expect(path.nativeElement.getAttribute('d')).toContain('M14.857 17.082');
  });

  it('has real path data for every name in the union', async () => {
    // Replaces adding one near-identical test per icon. The failure this
    // catches is a name declared in IconName with no entry in PATHS,
    // which renders an empty `d` — visually an icon-shaped hole, and
    // silent.
    for (const name of Object.keys(ALL_ICON_NAMES) as IconName[]) {
      // `render` reconfigures the TestBed, which throws once a module has
      // been instantiated — so each icon needs a fresh one.
      TestBed.resetTestingModule();
      await render(name);
      const d = fixture.debugElement.query(By.css('path')).nativeElement.getAttribute('d');
      expect(d).withContext(`icon "${name}"`).toBeTruthy();
      expect(d.length).withContext(`icon "${name}"`).toBeGreaterThan(10);
    }
  });

  it('renders the ellipsis icon that triggers every ui-action-menu', async () => {
    await render('ellipsis-horizontal');
    const path = fixture.debugElement.query(By.css('path'));
    expect(path.nativeElement.getAttribute('d')).toContain('M6.75 12a.75.75');
  });

  it('renders the x-mark icon used to close a drawer and remove a chip', async () => {
    await render('x-mark');
    const path = fixture.debugElement.query(By.css('path'));
    expect(path.nativeElement.getAttribute('d')).toBe('M6 18 18 6M6 6l12 12');
  });
});
