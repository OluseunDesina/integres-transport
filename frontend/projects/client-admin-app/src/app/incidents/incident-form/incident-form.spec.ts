import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';

import { IncidentForm } from './incident-form';
import { IncidentStore } from '../../shared/data/store/incident.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';

function makeDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inc-1',
    reference: 'INC-AB12CD',
    business: 'biz-1',
    title: 'Validator on bus 12 is dead',
    description: 'No lights.',
    category: 'hardware',
    severity: 'high',
    status: 'open',
    source: 'operator',
    trip: null,
    route: null,
    route_name: null,
    vehicle: null,
    vehicle_registration: null,
    driver: null,
    driver_name: null,
    stop: null,
    stop_name: null,
    device_reference: 'VLD-77',
    reported_by: 'user-1',
    reported_by_email: 'owner@example.com',
    assigned_to: null,
    assigned_to_email: null,
    latitude: null,
    longitude: null,
    resolved_at: null,
    resolution_notes: '',
    created_at: '2026-09-06T08:00:00Z',
    updated_at: '2026-09-06T08:00:00Z',
    activities: [],
    ...overrides,
  };
}

class FakeIncidentStore {
  detail: unknown = makeDetail();
  findDetail = jasmine
    .createSpy('findDetail')
    .and.callFake(() => Promise.resolve(this.detail));
  assignableUsers = jasmine.createSpy('assignableUsers').and.resolveTo([]);
}

class FakeSelectedBusinessStore {
  selectedBusinessId = signal<string | null>('biz-1');
}

describe('IncidentForm', () => {
  let fixture: ComponentFixture<IncidentForm>;
  let store: FakeIncidentStore;
  let api: { GET: jasmine.Spy; POST: jasmine.Spy; PATCH: jasmine.Spy };
  let navigate: jasmine.Spy;

  function renderedErrors(): string[] {
    return Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('[role="alert"]')
    ).map((el) => el.textContent?.trim() ?? '');
  }

  async function setup(paramId?: string): Promise<void> {
    store = new FakeIncidentStore();
    api = {
      GET: jasmine.createSpy('GET').and.resolveTo({ data: { count: 0, results: [] } }),
      POST: jasmine.createSpy('POST').and.resolveTo({ data: { id: 'inc-9' } }),
      PATCH: jasmine.createSpy('PATCH').and.resolveTo({ data: { id: 'inc-1' } }),
    };

    await TestBed.configureTestingModule({
      imports: [IncidentForm],
      providers: [
        provideRouter([]),
        { provide: API_CLIENT, useValue: api },
        { provide: IncidentStore, useValue: store },
        { provide: SelectedBusinessStore, useValue: new FakeSelectedBusinessStore() },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: convertToParamMap(paramId ? { id: paramId } : {}) },
          },
        },
      ],
    }).compileComponents();

    // Spied centrally: `provideRouter([])` registers no routes, so a
    // real navigate() rejects with NG04002 and fails the test that
    // triggered it for a reason unrelated to what it asserts.
    navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    fixture = TestBed.createComponent(IncidentForm);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  describe('creating', () => {
    beforeEach(() => setup());

    it('renders a validation message rather than failing silently', async () => {
      // The load-bearing assertion. `ui-text-field` renders an error
      // only when the parent binds both `[invalid]` and `[errorMessage]`,
      // and a form binding neither does nothing visible on submit —
      // which is exactly how a previous form in this app shipped broken.
      await fixture.componentInstance['onSubmit']();
      fixture.detectChanges();

      expect(api.POST).not.toHaveBeenCalled();
      expect(renderedErrors().join(' ')).toContain('required');
    });

    it('sends an Idempotency-Key so a retry cannot file a second incident', async () => {
      fixture.componentInstance['form'].patchValue({ title: 'Broken reader' });

      await fixture.componentInstance['onSubmit']();

      const options = api.POST.calls.mostRecent().args[1];
      expect(options.params.header['Idempotency-Key']).toBeTruthy();
      expect(options.body.business).toBe('biz-1');
    });

    it('lands on the new incident rather than back on the list', async () => {
      fixture.componentInstance['form'].patchValue({ title: 'Broken reader' });

      await fixture.componentInstance['onSubmit']();

      expect(navigate).toHaveBeenCalledWith(['/incidents', 'inc-9']);
    });

    it('surfaces a server rejection of the hidden business field', async () => {
      api.POST.and.resolveTo({ error: { business: ['Unknown business.'] } });
      fixture.componentInstance['form'].patchValue({ title: 'Broken reader' });

      await fixture.componentInstance['onSubmit']();
      fixture.detectChanges();

      // `business` has no control on screen, so without
      // HIDDEN_VALUE_CARRIERS this message would vanish entirely.
      expect((fixture.nativeElement as HTMLElement).textContent).toContain('Unknown business.');
    });

    it('shows the severity it will actually submit', async () => {
      // Found in the visual pass: the rendered <select> read "Low" while
      // the control held "medium". A control whose displayed value
      // disagrees with the value it submits files something the operator
      // never chose.
      // formControlName sits on the <ui-select> host, not the native
      // element it wraps.
      const select = (fixture.nativeElement as HTMLElement).querySelector(
        'ui-select[formcontrolname="severity"] select'
      ) as HTMLSelectElement | null;

      expect(select).not.toBeNull();
      expect(select?.value).toBe(fixture.componentInstance['form'].getRawValue().severity);
    });

    it('offers no resolution-notes field before the incident exists', () => {
      expect((fixture.nativeElement as HTMLElement).textContent).not.toContain(
        'Resolution notes'
      );
    });
  });

  describe('editing', () => {
    beforeEach(() => setup('inc-1'));

    it('loads through the detail endpoint, not a paged lookup', () => {
      expect(store.findDetail).toHaveBeenCalledWith('inc-1');
    });

    it('fills the form and shows the reference', () => {
      expect(fixture.componentInstance['form'].getRawValue().title).toBe(
        'Validator on bus 12 is dead'
      );
      expect(fixture.componentInstance['form'].getRawValue().device_reference).toBe('VLD-77');
      expect((fixture.nativeElement as HTMLElement).textContent).toContain('INC-AB12CD');
    });

    it('never offers status as an editable field', () => {
      // The backend refuses it with a 400 naming the transition
      // endpoint; the form must not invite the attempt.
      expect(Object.keys(fixture.componentInstance['form'].controls)).not.toContain('status');
    });

    it('PATCHes rather than creating a second incident', async () => {
      await fixture.componentInstance['onSubmit']();

      expect(api.PATCH).toHaveBeenCalled();
      expect(api.POST).not.toHaveBeenCalled();
    });
  });

  describe('a missing incident', () => {
    it('says so instead of rendering an empty form', async () => {
      await setup('nope');
      fixture.componentInstance['notFound'].set(true);
      fixture.detectChanges();

      expect((fixture.nativeElement as HTMLElement).textContent).toContain(
        'Incident not found'
      );
    });
  });
});
