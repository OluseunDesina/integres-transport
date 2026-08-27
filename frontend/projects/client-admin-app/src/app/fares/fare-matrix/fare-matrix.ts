import { Dialog } from '@angular/cdk/dialog';
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  TemplateRef,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore, PermissionsService } from '@auth';
import { Alert, Button, CONFIRM_DIALOG_TITLE_ID, ConfirmDialog, EmptyState } from '@shared-ui';
import type { ConfirmDialogData, ConfirmDialogResult } from '@shared-ui';

import { RouteStore, type Route } from '../../shared/data/store/route.store';
import { extractFirstErrorMessage } from '../../shared/error-message';

type FareMatrixPayload = components['schemas']['FareMatrix'];
type FareMatrixStop = components['schemas']['FareMatrixStop'];
type FareMatrixCellWrite = components['schemas']['FareMatrixCellWrite'];

export interface GridCell {
  key: string;
  fromStop: FareMatrixStop;
  toStop: FareMatrixStop;
  /** Row/column position, used for the input's id so arrow-key
   * navigation can find its neighbour without a ViewChildren query. */
  rowIndex: number;
  columnIndex: number;
  /** False for backward and same-stop pairs, which are rendered as
   * inert cells: a passenger cannot book them, so pricing them would
   * create rows nothing ever reads. */
  editable: boolean;
  label: string;
}

export interface GridRow {
  stop: FareMatrixStop;
  cells: GridCell[];
}

export function cellKey(fromStopId: string, toStopId: string): string {
  return `${fromStopId}|${toStopId}`;
}

/**
 * Canonical form for comparing a typed value against the stored one.
 *
 * Blank and "no rule" are the same thing, so both become `null`.
 * Numbers are compared at two decimal places rather than as strings:
 * typing `1500` over a stored `1500.00` is not an edit, and
 * highlighting it as one — then sending it — would churn a version
 * history for nothing. Anything unparseable is passed through
 * unchanged so it registers as dirty and gets rejected rather than
 * silently swallowed.
 */
export function normalizeAmount(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value.toFixed(2) : trimmed;
}

function isPriceable(raw: string): boolean {
  const value = Number(raw.trim());
  return Number.isFinite(value) && value > 0;
}

/**
 * The stop-pair fare grid for one Route — docs/specs/12-fare-matrix.md.
 *
 * Per-stop-pair pricing has existed since Phase 4 but was entered one
 * create flow at a time; a 10-stop route is 45 forward pairs. This is
 * the bulk editor that makes it usable, over `GET`/`PUT
 * /routes/{id}/fare-matrix/`.
 *
 * **Only dirty cells are submitted**, even though the endpoint accepts
 * and correctly skips a full-grid submission. Sending every rendered
 * cell has a real failure mode: if another operator prices a segment
 * while this grid is open, submitting our stale `null` for that
 * untouched cell would *close* their rule — a destructive write from a
 * cell the operator never looked at. Sending only what was edited makes
 * that impossible. The endpoint's own unchanged-skip stays as a second
 * guard.
 */
@Component({
  selector: 'app-fare-matrix',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Alert, Button, EmptyState],
  templateUrl: './fare-matrix.html',
})
export class FareMatrix implements OnInit {
  private readonly activatedRoute = inject(ActivatedRoute);
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);
  private readonly routeStore = inject(RouteStore);
  private readonly permissions = inject(PermissionsService);
  private readonly dialog = inject(Dialog);

  @ViewChild('closeBody') private readonly closeBody!: TemplateRef<unknown>;

  private readonly routeId = this.activatedRoute.snapshot.paramMap.get('routeId') ?? '';

  protected readonly route = signal<Route | null>(null);
  protected readonly matrix = signal<FareMatrixPayload | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);
  protected readonly notFound = signal(false);

  /** Every rendered cell's current text, keyed by `from|to`. Seeded
   * from the payload on load and after each successful save, so
   * "dirty" always means "differs from what the server last told us". */
  protected readonly draft = signal<ReadonlyMap<string, string>>(new Map());
  private readonly original = signal<ReadonlyMap<string, string | null>>(new Map());

  protected readonly saving = signal(false);
  protected readonly saveError = signal<string | null>(null);
  protected readonly saveSummary = signal<string | null>(null);

  protected readonly currency = computed(() => this.matrix()?.currency ?? '');
  protected readonly isPerSegment = computed(
    () => this.matrix()?.fare_pricing_mode === 'per_segment',
  );
  protected readonly stops = computed<FareMatrixStop[]>(() => this.matrix()?.stops ?? []);
  /** Columns are alighting stops, so the first stop never heads one —
   * nothing can alight where it boarded. Rows are the mirror image. */
  protected readonly columnStops = computed(() => this.stops().slice(1));
  protected readonly hasGrid = computed(() => this.stops().length >= 2);

  protected readonly grid = computed<GridRow[]>(() => {
    const stops = this.stops();
    return stops.slice(0, -1).map((fromStop, rowIndex) => ({
      stop: fromStop,
      cells: stops.slice(1).map((toStop, columnIndex) => ({
        key: cellKey(fromStop.id, toStop.id),
        fromStop,
        toStop,
        rowIndex,
        columnIndex,
        // `columnIndex` is offset by one against `rowIndex` because the
        // columns start at the second stop, so a forward pair is
        // `columnIndex >= rowIndex`.
        editable: columnIndex >= rowIndex,
        label: `${fromStop.name} to ${toStop.name} fare`,
      })),
    }));
  });

  protected readonly dirtyKeys = computed(() => {
    const original = this.original();
    const dirty = new Set<string>();
    for (const [key, raw] of this.draft()) {
      if (normalizeAmount(raw) !== normalizeAmount(original.get(key) ?? null)) {
        dirty.add(key);
      }
    }
    return dirty;
  });

  /** Edited cells whose text is neither blank nor a positive number.
   * Zero is rejected here for the same reason the serializer rejects
   * it: a free segment is a policy decision, not a `0.00` fare that
   * reads as a data-entry slip. */
  protected readonly invalidKeys = computed(() => {
    const invalid = new Set<string>();
    const draft = this.draft();
    for (const key of this.dirtyKeys()) {
      const raw = (draft.get(key) ?? '').trim();
      if (raw !== '' && !isPriceable(raw)) {
        invalid.add(key);
      }
    }
    return invalid;
  });

  /** Edited cells going from priced to blank — the destructive case.
   * Closing a segment's rule makes `get_fare()` raise
   * `FareNotConfigured`, so booking it starts failing outright. */
  protected readonly closingCells = computed(() => {
    const original = this.original();
    const draft = this.draft();
    const closing: GridCell[] = [];
    for (const row of this.grid()) {
      for (const cell of row.cells) {
        if (!cell.editable || !this.dirtyKeys().has(cell.key)) {
          continue;
        }
        const wasPriced = normalizeAmount(original.get(cell.key) ?? null) !== null;
        const nowBlank = normalizeAmount(draft.get(cell.key) ?? '') === null;
        if (wasPriced && nowBlank) {
          closing.push(cell);
        }
      }
    }
    return closing;
  });

  protected readonly canManage = computed(() => this.permissions.has('fares.manage'));

  /** Read-only for a viewer without `fares.manage`, and for a Business
   * pricing flat — where a `PUT` would 409 anyway, so offering editable
   * cells would only invite wasted work. */
  protected readonly cellsDisabled = computed(() => !this.canManage() || !this.isPerSegment());

  protected readonly canSave = computed(
    () =>
      this.canManage() &&
      this.isPerSegment() &&
      this.dirtyKeys().size > 0 &&
      this.invalidKeys().size === 0 &&
      !this.saving(),
  );

  protected readonly confirmLabel = computed(() => 'Stop selling these segments');
  protected readonly danger = computed(() => true);
  protected readonly confirmDisabled = computed(() => false);

  async ngOnInit(): Promise<void> {
    if (!this.routeId) {
      this.notFound.set(true);
      this.loading.set(false);
      return;
    }
    // The route is resolved for its name (the grid's caption) and its
    // Business id (the flat-mode link below) — `GET /routes/{id}/` does
    // not exist, so this goes through the paging lookup every other
    // detail screen uses.
    const [route] = await Promise.all([this.routeStore.findById(this.routeId), this.loadMatrix()]);
    this.route.set(route);
    this.loading.set(false);
  }

  private async loadMatrix(): Promise<void> {
    this.loadError.set(null);
    const { data, error, response } = await this.api.GET('/api/v1/routes/{id}/fare-matrix/', {
      params: { path: { id: this.routeId } },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });

    if (!data) {
      if (response?.status === 404) {
        this.notFound.set(true);
        return;
      }
      this.loadError.set(extractFirstErrorMessage(error, 'Could not load this route’s fares.'));
      return;
    }

    this.matrix.set(data);
    this.seedDraft(data);
  }

  private seedDraft(payload: FareMatrixPayload): void {
    const draft = new Map<string, string>();
    const original = new Map<string, string | null>();
    for (const cell of payload.cells) {
      const key = cellKey(cell.from_stop, cell.to_stop);
      draft.set(key, cell.amount ?? '');
      original.set(key, cell.amount);
    }
    this.draft.set(draft);
    this.original.set(original);
  }

  protected cellValue(key: string): string {
    return this.draft().get(key) ?? '';
  }

  protected isDirty(key: string): boolean {
    return this.dirtyKeys().has(key);
  }

  protected isInvalid(key: string): boolean {
    return this.invalidKeys().has(key);
  }

  protected cellId(rowIndex: number, columnIndex: number): string {
    return `fare-cell-${rowIndex}-${columnIndex}`;
  }

  protected onCellInput(key: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    const next = new Map(this.draft());
    next.set(key, value);
    this.draft.set(next);
    // A previous save's summary describes state this edit has already
    // moved past — leaving it up would read as if the edit were saved.
    this.saveSummary.set(null);
  }

  /**
   * Up/down moves between rows in the same column.
   *
   * Only the vertical axis is bound: left/right have to stay free for
   * the text caret, and Tab already walks the row. Cells use
   * `inputmode="decimal"` rather than `type="number"` precisely so
   * these keys are available — a number input would spin the value
   * instead.
   */
  protected onCellKeydown(event: KeyboardEvent, rowIndex: number, columnIndex: number): void {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) {
      return;
    }
    const rows = this.grid();
    for (let row = rowIndex + step; row >= 0 && row < rows.length; row += step) {
      const target = document.getElementById(this.cellId(row, columnIndex));
      if (target) {
        event.preventDefault();
        target.focus();
        return;
      }
    }
  }

  protected onSave(): void {
    if (!this.canSave()) {
      return;
    }
    this.saveError.set(null);
    this.saveSummary.set(null);

    if (this.closingCells().length > 0) {
      this.dialog.open<boolean, ConfirmDialogData>(ConfirmDialog, {
        ariaModal: true,
        ariaLabelledBy: CONFIRM_DIALOG_TITLE_ID,
        data: {
          title: 'Stop selling these segments?',
          bodyTemplate: this.closeBody,
          confirmLabel: this.confirmLabel,
          danger: this.danger,
          confirmDisabled: this.confirmDisabled,
          onConfirm: () => this.submit(),
        },
      });
      return;
    }

    void this.saveDirectly();
  }

  private async saveDirectly(): Promise<void> {
    const result = await this.submit();
    if (!result.ok) {
      this.saveError.set(result.error);
    }
  }

  private buildPayload(): FareMatrixCellWrite[] {
    const draft = this.draft();
    const cells: FareMatrixCellWrite[] = [];
    for (const row of this.grid()) {
      for (const cell of row.cells) {
        if (!cell.editable || !this.dirtyKeys().has(cell.key)) {
          continue;
        }
        cells.push({
          from_stop: cell.fromStop.id,
          to_stop: cell.toStop.id,
          amount: normalizeAmount(draft.get(cell.key) ?? ''),
        });
      }
    }
    return cells;
  }

  private async submit(): Promise<ConfirmDialogResult> {
    this.saving.set(true);
    const { data, error } = await this.api.PUT('/api/v1/routes/{id}/fare-matrix/', {
      params: { path: { id: this.routeId } },
      body: { cells: this.buildPayload() },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });
    this.saving.set(false);

    if (!data) {
      return {
        ok: false,
        error: extractFirstErrorMessage(error, 'Could not save these fares. Try again.'),
      };
    }

    const changed = data.created + data.superseded + data.closed;
    this.saveSummary.set(
      changed === 1 ? 'Saved 1 fare.' : `Saved ${changed} fares.`,
    );
    // Reload rather than patching local state: the response reports
    // counts, not rows, and a save creates *new* rule ids the next save
    // needs in order to detect a moved tip.
    await this.loadMatrix();
    return { ok: true };
  }
}
