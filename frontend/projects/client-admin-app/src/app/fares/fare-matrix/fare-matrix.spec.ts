import { Dialog } from '@angular/cdk/dialog';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore } from '@auth';
import type { ConfirmDialogData } from '@shared-ui';
import { Subject } from 'rxjs';

import { FareMatrix } from './fare-matrix';
import { RouteStore, type Route } from '../../shared/data/store/route.store';

type FareMatrixPayload = components['schemas']['FareMatrix'];

const IKEJA = { id: 'stop-1', name: 'Ikeja', sequence: 1 };
const YABA = { id: 'stop-2', name: 'Yaba', sequence: 2 };
const LEKKI = { id: 'stop-3', name: 'Lekki', sequence: 3 };

function makeRoute(overrides: Partial<Route> = {}): Route {
  return {
    id: 'route-1',
    business: 'biz-1',
    name: 'Ikeja — Lekki',
    code: 'IKL',
    stops: [],
    created_at: '2026-08-26T00:00:00Z',
    ...overrides,
  };
}

/** Three stops: Ikeja→Yaba priced, Ikeja→Lekki priced, Yaba→Lekki not. */
function makeMatrix(overrides: Partial<FareMatrixPayload> = {}): FareMatrixPayload {
  return {
    route: 'route-1',
    currency: 'NGN',
    fare_pricing_mode: 'per_segment',
    stops: [IKEJA, YABA, LEKKI],
    cells: [
      { from_stop: IKEJA.id, to_stop: YABA.id, amount: '500.00', fare_segment_rule: 'rule-1' },
      { from_stop: IKEJA.id, to_stop: LEKKI.id, amount: '1500.00', fare_segment_rule: 'rule-2' },
      { from_stop: YABA.id, to_stop: LEKKI.id, amount: null, fare_segment_rule: null },
    ],
    ...overrides,
  };
}

class FakeRouteStore {
  findById = jasmine.createSpy('findById').and.resolveTo(makeRoute());
}

interface Harness {
  fixture: ComponentFixture<FareMatrix>;
  apiClient: { GET: jasmine.Spy; PUT: jasmine.Spy };
  dialogSpy: jasmine.SpyObj<Dialog>;
  closedSubject: Subject<boolean | undefined>;
  routeStore: FakeRouteStore;
}

async function setup(
  options: {
    matrix?: FareMatrixPayload | null;
    status?: number;
    permissions?: string[];
    routeId?: string | null;
  } = {},
): Promise<Harness> {
  const {
    matrix = makeMatrix(),
    status = 200,
    permissions = ['fares.view', 'fares.manage'],
    routeId = 'route-1',
  } = options;

  const apiClient = {
    GET: jasmine
      .createSpy('GET')
      .and.resolveTo(
        matrix ? { data: matrix, response: { status } } : { error: {}, response: { status } },
      ),
    PUT: jasmine.createSpy('PUT'),
  };
  const routeStore = new FakeRouteStore();
  const closedSubject = new Subject<boolean | undefined>();
  const dialogSpy = jasmine.createSpyObj<Dialog>('Dialog', ['open']);
  dialogSpy.open.and.returnValue({ closed: closedSubject.asObservable() } as ReturnType<
    Dialog['open']
  >);

  await TestBed.configureTestingModule({
    imports: [FareMatrix],
    providers: [
      provideRouter([]),
      { provide: API_CLIENT, useValue: apiClient },
      { provide: RouteStore, useValue: routeStore },
      { provide: Dialog, useValue: dialogSpy },
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: { paramMap: convertToParamMap(routeId ? { routeId } : {}) },
        },
      },
    ],
  }).compileComponents();

  TestBed.inject(AuthStore).setSession('token', 'refresh', {
    id: 'user-1',
    email: 'ops@example.com',
    firstName: '',
    lastName: '',
    client: 'client-1',
    isPlatformStaff: false,
    isClientStaff: true,
    permissions,
    roleName: 'Manager',
    clientName: 'Acme',
  });

  const fixture = TestBed.createComponent(FareMatrix);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();

  return { fixture, apiClient, dialogSpy, closedSubject, routeStore };
}

function cellInput(fixture: ComponentFixture<FareMatrix>, label: string): HTMLInputElement {
  const input = fixture.nativeElement.querySelector(
    `input[aria-label="${label}"]`,
  ) as HTMLInputElement | null;
  if (!input) {
    throw new Error(`No cell input labelled "${label}"`);
  }
  return input;
}

function type(fixture: ComponentFixture<FareMatrix>, label: string, value: string): void {
  const input = cellInput(fixture, label);
  input.value = value;
  input.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

describe('FareMatrix', () => {
  describe('grid rendering', () => {
    it('renders one editable cell per forward stop pair, and nothing for the rest', async () => {
      const { fixture } = await setup();

      const inputs = fixture.debugElement.queryAll(By.css('tbody input'));
      // 3 stops => 3 forward pairs, out of a 2x2 rendered grid.
      expect(inputs.length).toBe(3);
      expect(cellInput(fixture, 'Ikeja to Yaba fare').value).toBe('500.00');
      expect(cellInput(fixture, 'Ikeja to Lekki fare').value).toBe('1500.00');
      expect(cellInput(fixture, 'Yaba to Lekki fare').value).toBe('');
      // Yaba→Yaba is not a journey, so it is inert rather than blank.
      expect(fixture.nativeElement.querySelector('input[aria-label="Yaba to Yaba fare"]')).toBeNull();
    });

    it('gives every cell an accessible name naming both stops', async () => {
      // Locked in by test deliberately: without this a screen-reader
      // user hears "edit text" 45 times on a 10-stop route, and the
      // grid is unusable. docs/specs/12-fare-matrix.md calls this the
      // screen's real risk.
      const { fixture } = await setup();

      const labels = fixture.debugElement
        .queryAll(By.css('tbody input'))
        .map((el) => (el.nativeElement as HTMLInputElement).getAttribute('aria-label'));

      expect(labels).toEqual([
        'Ikeja to Yaba fare',
        'Ikeja to Lekki fare',
        'Yaba to Lekki fare',
      ]);
    });

    it('scopes its row and column headers', async () => {
      const { fixture } = await setup();

      const columnHeaders = fixture.debugElement
        .queryAll(By.css('thead th'))
        .map((el) => el.nativeElement as HTMLTableCellElement);
      const rowHeaders = fixture.debugElement
        .queryAll(By.css('tbody th'))
        .map((el) => el.nativeElement as HTMLTableCellElement);

      // The first stop heads no column (nothing alights where it
      // boarded) and the last heads no row.
      expect(columnHeaders.map((el) => el.textContent?.trim())).toEqual(['Yaba', 'Lekki']);
      expect(columnHeaders.every((el) => el.getAttribute('scope') === 'col')).toBeTrue();
      expect(rowHeaders.map((el) => el.textContent?.trim())).toEqual(['Ikeja', 'Yaba']);
      expect(rowHeaders.every((el) => el.getAttribute('scope') === 'row')).toBeTrue();
    });

    it('shows an empty state pointing at the stop editor for a one-stop route', async () => {
      const { fixture } = await setup({
        matrix: makeMatrix({ stops: [IKEJA], cells: [] }),
      });

      expect(fixture.nativeElement.textContent).toContain('needs at least two stops');
      expect(fixture.nativeElement.querySelector('table')).toBeNull();
      expect(
        fixture.nativeElement.querySelector('a[href="/routes/route-1/edit"]'),
      ).not.toBeNull();
    });

    it('shows a not-found message when the route does not exist', async () => {
      const { fixture } = await setup({ matrix: null, status: 404 });

      expect(fixture.nativeElement.textContent).toContain("couldn't be found");
    });
  });

  describe('dirty tracking', () => {
    it('marks an edited cell dirty and counts it', async () => {
      const { fixture } = await setup();

      type(fixture, 'Yaba to Lekki fare', '900');

      expect(fixture.componentInstance['dirtyKeys']().size).toBe(1);
      expect(fixture.nativeElement.textContent).toContain('1 unsaved change');
      expect(cellInput(fixture, 'Yaba to Lekki fare').classList).toContain('bg-amber-50');
      expect(cellInput(fixture, 'Ikeja to Yaba fare').classList).not.toContain('bg-amber-50');
    });

    it('does not treat a differently-formatted equal amount as an edit', async () => {
      // `1500` over a stored `1500.00` is the same price. Flagging it
      // would send a supersede that churns version history for nothing.
      const { fixture } = await setup();

      type(fixture, 'Ikeja to Lekki fare', '1500');

      expect(fixture.componentInstance['dirtyKeys']().size).toBe(0);
      expect(fixture.nativeElement.textContent).toContain('No unsaved changes');
    });

    it('blocks saving on a zero or non-numeric amount', async () => {
      const { fixture } = await setup();

      type(fixture, 'Yaba to Lekki fare', '0');
      expect(fixture.componentInstance['canSave']()).toBeFalse();
      expect(fixture.nativeElement.textContent).toContain('1 cell needs a fare greater than zero');
      expect(cellInput(fixture, 'Yaba to Lekki fare').getAttribute('aria-invalid')).toBe('true');

      type(fixture, 'Yaba to Lekki fare', 'free');
      expect(fixture.componentInstance['canSave']()).toBeFalse();
    });

    it('moves focus down a column on ArrowDown', async () => {
      const { fixture } = await setup();

      const top = cellInput(fixture, 'Ikeja to Lekki fare');
      top.focus();
      top.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      fixture.detectChanges();

      expect(document.activeElement).toBe(cellInput(fixture, 'Yaba to Lekki fare'));
    });
  });

  describe('saving', () => {
    it('submits only the edited cells', async () => {
      // Sending the whole grid would let a stale blank close a rule
      // another operator created while this grid was open — see the
      // component docstring.
      const { fixture, apiClient } = await setup();
      apiClient.PUT.and.resolveTo({
        data: { created: 1, superseded: 0, closed: 0, unchanged: 0 },
      });

      type(fixture, 'Yaba to Lekki fare', '900');
      fixture.componentInstance['onSave']();
      await fixture.whenStable();

      expect(apiClient.PUT).toHaveBeenCalledWith(
        '/api/v1/routes/{id}/fare-matrix/',
        jasmine.objectContaining({
          params: { path: { id: 'route-1' } },
          body: {
            cells: [{ from_stop: YABA.id, to_stop: LEKKI.id, amount: '900.00' }],
          },
        }),
      );
    });

    it('reloads the grid and reports what changed after a save', async () => {
      const { fixture, apiClient } = await setup();
      apiClient.PUT.and.resolveTo({
        data: { created: 1, superseded: 1, closed: 0, unchanged: 0 },
      });

      type(fixture, 'Yaba to Lekki fare', '900');
      fixture.componentInstance['onSave']();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(fixture.nativeElement.textContent).toContain('Saved 2 fares.');
      // Once (on load) plus once after saving — new rules mean new ids,
      // which the next save needs to detect a moved tip.
      expect(apiClient.GET).toHaveBeenCalledTimes(2);
    });

    it('surfaces a rejected save without clearing the edit', async () => {
      const { fixture, apiClient } = await setup();
      apiClient.PUT.and.resolveTo({
        error: { detail: 'This business prices fares flat.' },
      });

      type(fixture, 'Yaba to Lekki fare', '900');
      fixture.componentInstance['onSave']();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(fixture.nativeElement.textContent).toContain('This business prices fares flat.');
      expect(cellInput(fixture, 'Yaba to Lekki fare').value).toBe('900');
    });

    it('confirms before clearing a fare, naming the segments it stops selling', async () => {
      const { fixture, dialogSpy, apiClient } = await setup();

      type(fixture, 'Ikeja to Yaba fare', '');
      fixture.componentInstance['onSave']();

      expect(apiClient.PUT).not.toHaveBeenCalled();
      expect(dialogSpy.open).toHaveBeenCalled();
      const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
      expect(data.danger()).toBeTrue();
      expect(
        fixture.componentInstance['closingCells']().map((c) => c.label),
      ).toEqual(['Ikeja to Yaba fare']);
    });

    it('saves without a confirm when nothing is being cleared', async () => {
      const { fixture, dialogSpy, apiClient } = await setup();
      apiClient.PUT.and.resolveTo({
        data: { created: 0, superseded: 1, closed: 0, unchanged: 0 },
      });

      type(fixture, 'Ikeja to Yaba fare', '600');
      fixture.componentInstance['onSave']();
      await fixture.whenStable();

      expect(dialogSpy.open).not.toHaveBeenCalled();
      expect(apiClient.PUT).toHaveBeenCalled();
    });
  });

  describe('when the business prices flat', () => {
    it('says so, links to the business settings, and disables every cell', async () => {
      const { fixture } = await setup({
        matrix: makeMatrix({ fare_pricing_mode: 'flat' }),
      });

      expect(fixture.nativeElement.textContent).toContain('prices fares flat');
      expect(fixture.nativeElement.querySelector('a[href="/businesses/biz-1/edit"]')).not.toBeNull();
      expect(cellInput(fixture, 'Ikeja to Yaba fare').disabled).toBeTrue();
      expect(fixture.componentInstance['canSave']()).toBeFalse();
    });
  });

  describe('without fares.manage', () => {
    it('renders the grid read-only with no save button', async () => {
      const { fixture } = await setup({ permissions: ['fares.view'] });

      expect(cellInput(fixture, 'Ikeja to Yaba fare').disabled).toBeTrue();
      expect(fixture.debugElement.query(By.css('ui-button'))).toBeNull();
      // Still shows the prices — reading what a route charges is the
      // whole point of a read-only view.
      expect(cellInput(fixture, 'Ikeja to Yaba fare').value).toBe('500.00');
    });
  });
});
