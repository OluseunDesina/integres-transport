import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';

import { BusinessForm } from './business-form';
import { BusinessStore, type Business } from '../../shared/data/store/business.store';

function makeBusiness(overrides: Partial<Business> = {}): Business {
  return {
    id: 'biz-1',
    vertical: 'shuttle',
    name: 'Acme Shuttle Co',
    currency: 'NGN',
    timezone: 'Africa/Lagos',
    booking_mode_default: 'reservation',
    kyb_status: 'pending',
    kyb_submitted_at: null,
    created_at: '2026-08-06T00:00:00Z',
    ...overrides,
  };
}

class FakeBusinessStore {
  items = signal<Business[]>([]);
  getAll = jasmine.createSpy('getAll').and.resolveTo();
  /** See the same fake in `business-kyb.spec.ts`: edit mode resolves
   * through `findById`, which pages the full list, rather than through
   * one bounded `getAll()` plus `.find()`. */
  findById = jasmine
    .createSpy('findById')
    .and.callFake((id: string) =>
      Promise.resolve(this.items().find((b) => b.id === id) ?? null)
    );
}

async function setup(paramId: string | null, existing: Business[] = []) {
  const apiClient = {
    GET: jasmine.createSpy('GET'),
    POST: jasmine.createSpy('POST'),
    PATCH: jasmine.createSpy('PATCH'),
  };
  const store = new FakeBusinessStore();
  store.items.set(existing);

  await TestBed.configureTestingModule({
    imports: [BusinessForm],
    providers: [
      provideRouter([]),
      { provide: API_CLIENT, useValue: apiClient },
      { provide: BusinessStore, useValue: store },
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: {
            paramMap: convertToParamMap(paramId ? { id: paramId } : {}),
          },
        },
      },
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(BusinessForm);
  return { fixture, apiClient, store };
}

describe('BusinessForm', () => {
  describe('create mode', () => {
    let fixture: ComponentFixture<BusinessForm>;
    let apiClient: { GET: jasmine.Spy; POST: jasmine.Spy; PATCH: jasmine.Spy };

    beforeEach(async () => {
      ({ fixture, apiClient } = await setup(null));
      fixture.detectChanges();
      await fixture.whenStable();
    });

    it('renders the "New business" heading', () => {
      expect(fixture.nativeElement.querySelector('h1').textContent).toContain('New business');
    });

    it('does not submit an invalid (empty name) form', async () => {
      await fixture.componentInstance['onSubmit']();
      expect(apiClient.POST).not.toHaveBeenCalled();
    });

    it('creates a business and navigates to /businesses on success', async () => {
      apiClient.POST.and.resolveTo({ data: makeBusiness() });
      const router = TestBed.inject(Router);
      const navigateSpy = spyOn(router, 'navigate').and.resolveTo(true);

      fixture.componentInstance['form'].setValue({
        vertical: 'shuttle',
        name: 'Acme Shuttle Co',
        currency: 'NGN',
        timezone: 'Africa/Lagos',
        booking_mode_default: 'reservation',
        fare_pricing_mode: 'flat',
      });

      await fixture.componentInstance['onSubmit']();

      expect(apiClient.POST).toHaveBeenCalledWith(
        '/api/v1/businesses/',
        jasmine.objectContaining({
          body: jasmine.objectContaining({
            name: 'Acme Shuttle Co',
            vertical: 'shuttle',
          }),
        }),
      );
      expect(navigateSpy).toHaveBeenCalledWith(['/businesses']);
    });

    it('offers a fare pricing mode control, explaining what switching does', () => {
      // Defect 1 of docs/specs/12-fare-matrix.md: this field was
      // writable on the serializer but had no control anywhere, so it
      // could only ever hold its `flat` default and `fare-form`'s
      // per-segment branch was unreachable dead code.
      const labels: HTMLLabelElement[] = Array.from(
        fixture.nativeElement.querySelectorAll('label'),
      );
      const label = labels.find((el) => el.textContent?.includes('Fare pricing mode'));
      expect(label).withContext('fare pricing mode select is rendered').toBeTruthy();

      const select = fixture.nativeElement.querySelector(
        `#${label!.getAttribute('for')}`,
      ) as HTMLSelectElement;
      expect(Array.from(select.options).map((o) => o.value)).toEqual(['flat', 'per_segment']);

      const hintId = select.getAttribute('aria-describedby');
      const hint = fixture.nativeElement.querySelector(`#${hintId}`) as HTMLElement;
      expect(hint.textContent).toContain('keeps the fares you already entered');
    });

    it('submits the chosen fare pricing mode', async () => {
      apiClient.POST.and.resolveTo({ data: makeBusiness() });
      spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);

      fixture.componentInstance['form'].setValue({
        vertical: 'shuttle',
        name: 'Acme Shuttle Co',
        currency: 'NGN',
        timezone: 'Africa/Lagos',
        booking_mode_default: 'reservation',
        fare_pricing_mode: 'per_segment',
      });
      await fixture.componentInstance['onSubmit']();

      expect(apiClient.POST).toHaveBeenCalledWith(
        '/api/v1/businesses/',
        jasmine.objectContaining({
          body: jasmine.objectContaining({ fare_pricing_mode: 'per_segment' }),
        }),
      );
    });

    it('shows the server error message on failure', async () => {
      apiClient.POST.and.resolveTo({
        error: { name: ['A business with this name already exists.'] },
      });
      fixture.componentInstance['form'].setValue({
        vertical: 'shuttle',
        name: 'Acme Shuttle Co',
        currency: 'NGN',
        timezone: 'Africa/Lagos',
        booking_mode_default: 'reservation',
        fare_pricing_mode: 'flat',
      });

      await fixture.componentInstance['onSubmit']();
      fixture.detectChanges();

      expect(fixture.componentInstance['errorMessage']()).toBe(
        'A business with this name already exists.',
      );
    });
  });

  describe('edit mode', () => {
    it('prefills the form and shows the KYB status pill when the business is found', async () => {
      const business = makeBusiness({ kyb_status: 'approved' });
      const { fixture } = await setup('biz-1', [business]);

      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('h1').textContent).toContain('Edit business');
      expect(fixture.componentInstance['form'].value.name).toBe('Acme Shuttle Co');
      const pill = fixture.debugElement.query(By.css('ui-status-pill'));
      expect(pill).not.toBeNull();
    });

    it('prefills the existing fare pricing mode rather than defaulting to flat', async () => {
      const { fixture } = await setup('biz-1', [makeBusiness({ fare_pricing_mode: 'per_segment' })]);

      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(fixture.componentInstance['form'].value.fare_pricing_mode).toBe('per_segment');
    });

    it('patches the business at its id on submit', async () => {
      const business = makeBusiness();
      const { fixture, apiClient } = await setup('biz-1', [business]);
      fixture.detectChanges();
      await fixture.whenStable();
      apiClient.PATCH.and.resolveTo({ data: business });
      const router = TestBed.inject(Router);
      spyOn(router, 'navigate').and.resolveTo(true);

      await fixture.componentInstance['onSubmit']();

      expect(apiClient.PATCH).toHaveBeenCalledWith(
        '/api/v1/businesses/{id}/',
        jasmine.objectContaining({ params: { path: { id: 'biz-1' } } }),
      );
    });

    it('shows a not-found message when the business is not in the store', async () => {
      const { fixture, store } = await setup('missing-id', []);
      store.getAll.and.callFake(() => {
        store.items.set([]);
        return Promise.resolve();
      });

      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(fixture.nativeElement.textContent).toContain("couldn't be found");
    });

    it('links to the KYB screen instead of embedding an upload form', async () => {
      // The upload block moved to its own route — see
      // docs/specs/11-kyb-directors.md. This asserts the entry point
      // survives, so removing the old form can't silently strand KYB.
      const { fixture } = await setup('biz-1', [makeBusiness()]);
      fixture.detectChanges();
      // `whenStable` is required now that edit mode always resolves the
      // business through the awaited `findById` — it used to hit the
      // already-loaded items synchronously on the happy path.
      await fixture.whenStable();
      fixture.detectChanges();

      const link = fixture.nativeElement.querySelector('a[href="/businesses/biz-1/kyb"]');
      expect(link).not.toBeNull();
      expect(fixture.nativeElement.textContent).not.toContain('Upload a KYB document');
    });
  });
});
