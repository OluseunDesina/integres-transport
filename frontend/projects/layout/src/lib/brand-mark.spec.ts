import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';
import { WhiteLabelResolverService } from '@auth';

import { BrandMark } from './brand-mark';

describe('BrandMark', () => {
  let fixture: ComponentFixture<BrandMark>;
  let whiteLabel: WhiteLabelResolverService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [BrandMark],
      providers: [{ provide: API_CLIENT, useValue: { GET: jasmine.createSpy('GET') } }],
    }).compileComponents();

    whiteLabel = TestBed.inject(WhiteLabelResolverService);
    fixture = TestBed.createComponent(BrandMark);
  });

  function render(): HTMLElement {
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('falls back to our own wordmark when the host resolves to no tenant', () => {
    // Local dev and the platform's own domain both land here.
    expect(render().textContent).toContain('Integra Travel');
    expect(render().querySelector('img')).toBeNull();
  });

  it("renders the operator's logo when they have one", () => {
    whiteLabel.branding.set({
      name: 'Lagos Shuttle',
      logo: 'https://cdn.example/lagos.png',
      primary: null,
      secondary: null,
    });

    const img = render().querySelector('img');

    expect(img?.getAttribute('src')).toBe('https://cdn.example/lagos.png');
    // Names the operator, not "logo" — a screen-reader user needs to
    // know whose app this is, which "logo" does not tell them.
    expect(img?.getAttribute('alt')).toBe('Lagos Shuttle');
  });

  it("falls back to the operator's name when they have configured no logo", () => {
    whiteLabel.branding.set({
      name: 'Lagos Shuttle',
      logo: null,
      primary: null,
      secondary: null,
    });

    expect(render().querySelector('img')).toBeNull();
    expect(render().textContent).toContain('Lagos Shuttle');
    expect(render().textContent).not.toContain('Integra Travel');
  });
});
