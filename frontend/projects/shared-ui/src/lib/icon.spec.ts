import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { Icon } from './icon';

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
});
