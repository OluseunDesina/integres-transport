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
    status: 'active',
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
    // The wildcard grid, which is where this screen opens.
    trip_class: '',
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
  // Exact first, then prefix: on a class grid an inherited cell's
  // accessible name gains a sentence explaining the inheritance
  // (spec 15), so "Ikeja to Yaba fare" is a prefix rather than the
  // whole name there. The exact form is still asserted directly by the
  // accessible-name test above, so nothing is loosened away here.
  const input = (fixture.nativeElement.querySelector(`input[aria-label="${label}"]`) ??
    fixture.nativeElement.querySelector(
      `input[aria-label^="${label}"]`,
    )) as HTMLInputElement | null;
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
      expect(cellInput(fixture, 'Yaba to Lekki fare').classList).toContain('bg-warning-surface');
      expect(cellInput(fixture, 'Ikeja to Yaba fare').classList).not.toContain('bg-warning-surface');
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
          // `trip_class: ''` is the wildcard grid — required since spec
          // 15, and asserted here rather than loosened away, because a
          // save that reached a different class's grid would supersede
          // rules this screen never showed the operator.
          params: { path: { id: 'route-1' }, query: { trip_class: '' } },
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

// --- docs/specs/15-trip-classes.md ---

/**
 * One grid per class, so the endpoint takes a required `?trip_class=`.
 * These tests exist for the two things that make that dangerous rather
 * than merely fiddly: a save must land in the class on screen, and an
 * inherited price must never be mistaken for one this class owns.
 */
describe('FareMatrix service classes', () => {
  /** Resolves a different payload per requested class, which is what
   * the real endpoint does — a single canned response would hide the
   * inheritance behaviour entirely. */
  function byClass(grids: Record<string, FareMatrixPayload>) {
    return (_path: string, init: { params: { query: { trip_class: string } } }) => {
      const grid = grids[init.params.query.trip_class];
      return Promise.resolve(
        grid ? { data: grid, response: { status: 200 } } : { error: {}, response: { status: 400 } },
      );
    };
  }

  function unpriced(trip_class: string): FareMatrixPayload {
    return makeMatrix({
      trip_class,
      cells: [
        { from_stop: IKEJA.id, to_stop: YABA.id, amount: null, fare_segment_rule: null },
        { from_stop: IKEJA.id, to_stop: LEKKI.id, amount: null, fare_segment_rule: null },
        { from_stop: YABA.id, to_stop: LEKKI.id, amount: null, fare_segment_rule: null },
      ],
    });
  }

  it('opens on the wildcard grid, where every pre-spec-15 price lives', async () => {
    const { fixture, apiClient } = await setup();

    expect(fixture.componentInstance['tripClass']()).toBe('');
    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/routes/{id}/fare-matrix/',
      jasmine.objectContaining({
        params: { path: { id: 'route-1' }, query: { trip_class: '' } },
      }),
    );
  });

  it('does not read the wildcard grid twice while showing it', async () => {
    const { apiClient } = await setup();

    expect(apiClient.GET.calls.count()).toBe(1);
  });

  it('reloads the grid when a class is chosen', async () => {
    const { fixture, apiClient } = await setup();
    apiClient.GET.and.callFake(
      byClass({ '': makeMatrix(), premium: unpriced('premium') }),
    );
    apiClient.GET.calls.reset();

    fixture.componentInstance['onTripClassChange']('premium');
    await fixture.whenStable();

    expect(apiClient.GET.calls.allArgs().map((args) => args[1].params.query.trip_class)).toEqual([
      'premium',
      '',
    ]);
  });

  it('saves into the class on screen, never a default', async () => {
    const { fixture, apiClient } = await setup();
    apiClient.GET.and.callFake(byClass({ '': makeMatrix(), premium: unpriced('premium') }));
    apiClient.PUT.and.resolveTo({
      data: { created: 1, superseded: 0, closed: 0, unchanged: 0 },
    });

    fixture.componentInstance['onTripClassChange']('premium');
    await fixture.whenStable();
    fixture.detectChanges();
    type(fixture, 'Ikeja to Yaba fare', '900');
    fixture.componentInstance['onSave']();
    await fixture.whenStable();

    expect(apiClient.PUT).toHaveBeenCalledWith(
      '/api/v1/routes/{id}/fare-matrix/',
      jasmine.objectContaining({
        params: { path: { id: 'route-1' }, query: { trip_class: 'premium' } },
      }),
    );
  });

  describe('inherited cells', () => {
    async function onPremiumGrid() {
      const harness = await setup();
      harness.apiClient.GET.and.callFake(
        byClass({ '': makeMatrix(), premium: unpriced('premium') }),
      );
      harness.fixture.componentInstance['onTripClassChange']('premium');
      await harness.fixture.whenStable();
      harness.fixture.detectChanges();
      return harness;
    }

    /**
     * A placeholder, not a value — that one choice is what makes all
     * three required behaviours fall out: the browser renders it muted,
     * typing replaces it, and leaving it alone keeps the input empty so
     * the cell is never dirty and never submitted.
     */
    it('shows the wildcard amount as a placeholder', async () => {
      const { fixture } = await onPremiumGrid();
      const input = fixture.nativeElement.querySelector(
        'input[aria-label^="Ikeja to Yaba fare"]',
      ) as HTMLInputElement;

      expect(input.placeholder).toBe('500.00');
      expect(input.value).toBe('');
    });

    /** The other half of "visually distinct **and** labelled": a dimmed
     * number nobody can hear is worse than no number. */
    it('says in the accessible name that the amount is inherited', async () => {
      const { fixture } = await onPremiumGrid();
      const input = fixture.nativeElement.querySelector(
        'input[aria-label^="Ikeja to Yaba fare"]',
      ) as HTMLInputElement;

      expect(input.getAttribute('aria-label')).toContain('inherits 500.00');
      expect(input.getAttribute('aria-label')).toContain('Any class');
    });

    /**
     * The load-bearing one. If an inherited amount were seeded into
     * `draft`, every inherited cell would read as dirty on load and the
     * first save would copy the whole wildcard grid into this class —
     * silently detaching it from prices the operator still edits
     * elsewhere.
     */
    it('leaves an untouched inherited cell out of the save', async () => {
      const { fixture, apiClient } = await onPremiumGrid();
      apiClient.PUT.and.resolveTo({
        data: { created: 1, superseded: 0, closed: 0, unchanged: 0 },
      });

      expect(fixture.componentInstance['dirtyKeys']().size).toBe(0);

      type(fixture, 'Yaba to Lekki fare', '250');
      fixture.componentInstance['onSave']();
      await fixture.whenStable();

      const body = apiClient.PUT.calls.mostRecent().args[1].body;
      expect(body.cells.length).toBe(1);
      expect(body.cells[0]).toEqual(
        jasmine.objectContaining({ from_stop: YABA.id, to_stop: LEKKI.id, amount: '250.00' }),
      );
    });

    /**
     * The placeholder carries information, so it has to meet the same
     * contrast bar as text. Tailwind's preflight draws `::placeholder`
     * as `currentColor` at 50%, which over this field measures
     * **2.64:1** — well under 4.5:1, and the inherited amount would
     * have been the one thing on the grid a low-vision operator could
     * not read. `text-muted` is 4.76:1; the italic means the
     * inherited/owned distinction is not carried by contrast alone.
     * Caught in the spec 15 visual pass, not by any assertion.
     */
    it('draws the placeholder at a readable contrast, and not by colour alone', async () => {
      const { fixture } = await onPremiumGrid();
      const input = fixture.nativeElement.querySelector(
        'input[aria-label^="Ikeja to Yaba fare"]',
      ) as HTMLInputElement;

      expect(input.className).toContain('placeholder:text-muted');
      expect(input.className).toContain('placeholder:italic');
    });

    it('stops calling a cell inherited once it has its own price', async () => {
      const { fixture } = await onPremiumGrid();

      type(fixture, 'Ikeja to Yaba fare', '900');

      const input = fixture.nativeElement.querySelector(
        'input[aria-label^="Ikeja to Yaba fare"]',
      ) as HTMLInputElement;
      expect(input.placeholder).toBe('');
    });

    it('shows nothing as inherited on the wildcard grid itself', async () => {
      const { fixture } = await setup();

      expect(fixture.componentInstance['hasInheritedCells']()).toBeFalse();
    });
  });

  describe('switching with unsaved edits', () => {
    it('warns instead of discarding them', async () => {
      const { fixture, apiClient, dialogSpy } = await setup();
      apiClient.GET.and.callFake(byClass({ '': makeMatrix(), premium: unpriced('premium') }));
      type(fixture, 'Yaba to Lekki fare', '250');
      apiClient.GET.calls.reset();

      fixture.componentInstance['onTripClassChange']('premium');

      expect(dialogSpy.open).toHaveBeenCalled();
      // Nothing loaded, and the grid on screen is still the one being
      // edited — a silent discard is the single outcome this must not
      // have.
      expect(apiClient.GET).not.toHaveBeenCalled();
      expect(fixture.componentInstance['tripClass']()).toBe('');
    });

    it('names how much would be lost, and from which grid', async () => {
      const { fixture, dialogSpy } = await setup();
      type(fixture, 'Yaba to Lekki fare', '250');

      fixture.componentInstance['onTripClassChange']('premium');
      const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;

      expect(data.confirmLabel()).toBe('Discard and switch');
      expect(fixture.componentInstance['dirtyKeys']().size).toBe(1);
    });

    it('switches once confirmed', async () => {
      const { fixture, apiClient, dialogSpy } = await setup();
      apiClient.GET.and.callFake(byClass({ '': makeMatrix(), premium: unpriced('premium') }));
      type(fixture, 'Yaba to Lekki fare', '250');

      fixture.componentInstance['onTripClassChange']('premium');
      const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
      await data.onConfirm();
      await fixture.whenStable();

      expect(fixture.componentInstance['tripClass']()).toBe('premium');
      expect(fixture.componentInstance['dirtyKeys']().size).toBe(0);
    });

    it('switches straight away when there is nothing to lose', async () => {
      const { fixture, apiClient, dialogSpy } = await setup();
      apiClient.GET.and.callFake(byClass({ '': makeMatrix(), premium: unpriced('premium') }));

      fixture.componentInstance['onTripClassChange']('premium');
      await fixture.whenStable();

      expect(dialogSpy.open).not.toHaveBeenCalled();
      expect(fixture.componentInstance['tripClass']()).toBe('premium');
    });
  });
});
