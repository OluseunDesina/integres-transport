# Frontend patterns — the cookbook

The counterpart to `backend-patterns.md`, for `client-admin-app` and its
siblings. **Read this instead of re-deriving the house shape from three
screens.** If something here is wrong, fix it here.

Conventions (standalone components, `OnPush`, `input()`/`output()`,
native control flow, reactive forms, `inject()`, path aliases) are in
`CLAUDE.md`; this is the how.

---

## 1. A domain's files

```
src/app/<domain>/
  <domain>-list/   <name>-list.ts | .html | .spec.ts
  <domain>-form/   create *and* edit, one component
  <domain>-detail/ only when there is something a list cannot show
src/app/shared/data/store/<domain>.store.ts   (+ .spec.ts)
src/app/shared/<domain>-labels.ts             enum → label/tone/options
```

Register in `app.routes.ts` (one block per screen) and `app-shell.ts`
(one `NavItem`, optionally one `QuickAction`).

## 2. The store

```ts
export type Thing = components['schemas']['Thing'];
export interface ThingQuery { business?: string; status?: string; search?: string }

@Injectable({ providedIn: 'root' })
export class ThingStore extends ListStore<Thing, ThingQuery> {
  private readonly api = inject(API_CLIENT);
  constructor() { super({}, 25); }          // initial query, page size

  protected override async fetchPage(query: ThingQuery, page: Page) {
    const { data, error } = await this.api.GET('/api/v1/things/', {
      params: { query: { limit: page.limit, offset: page.offset, ...query } },
    });
    if (!data) throw new Error(toErrorMessage(error));
    return { items: data.results, total: data.count };
  }
}
```

`ListStore` (`@shared-data`) owns `items/total/query/page/loading/error/isEmpty`,
`getAll()`, `updateQuery()`, `changePage()`. `toErrorMessage` is a local
function per store reading `error.detail` with a domain-specific
fallback — copied, not shared, by convention.

**Resolving one record.** Expose a thin `findById(id)` delegating to
`findByIdPaged(id, {})` — **passing the scope explicitly**, never
`this.query()`, since inheriting a leftover filter is a recorded bug.
`findByIdPaged` checks the loaded page then pages via `fetchPage`,
deliberately never touching `state`, so a detail lookup cannot clobber
the list's pagination.

**Not every response is a list.** An endpoint returning an envelope —
`trip`, `kind` and `totals` beside `results` — is not a `ListStore`
subclass; that base models a bare `{count, results}`.
`TripPerformanceStore` and `ManifestStore` are the shape to copy,
including their distinction between **not found** and a failure: a
bookmarked link to a deleted record is an ordinary thing to happen and
reads very differently from "the server broke".

**Unless the domain has a real single-record GET.** `apps/incidents`
does, and it is the only source of its activity trail — so its detail
and edit screens call it directly, one request instead of up to fifty.
Check for one before reaching for the paged lookup, and say in a comment
why you did.

**A boolean query param that is off must disappear**, not become
`false` — the server reads `?flag=false` as a filter, not the absence of
one.

## 3. The list screen

- `ListFilters` from `shared/list-filters.ts` — a plain class the screen
  instantiates, taking `{key, label, chipValue}` configs. It owns
  `search`, `activeFilter` and arbitrary `extras`, and produces the
  `chips()` that make a narrowing visible. **No URL sync**; only
  `payment-list` does that, for its period picker.
- **Business scoping** is an `effect()` reading
  `SelectedBusinessStore.selectedBusinessId()` and calling the store
  inside `untracked()`, with `{ allowSignalWrites: true }`. It is the
  only fetch trigger — there is no `ngOnInit` calling `getAll()`.
- **A default filter must be seeded in the store *and* rendered as a
  chip.** A list quietly showing a subset is indistinguishable from a
  list with no data.
- Template order: `@if (store.error())` → `@else` filter bar + table;
  inside, `@if (store.isEmpty() && !filters.isFiltered())` empty state
  → `@else` table; inside the table body, `@if (store.loading())`
  skeleton rows → `@else` data rows.
- A **transient** failure (a refused action) goes in its own `ui-alert`
  *above* the table and must not replace it — the row it came from still
  needs to be visible. A load error does replace it.
- `ui-table [stickyHeader]`, `ui-paginator`, `ui-density-toggle`, and
  `cellClass()`/`densityStyle()` computed off `TableDensityStore`.
- Row actions: `ui-action-menu` behind `*appHasPermission`, `[items]`
  from a `menuItems(row)` method, `[label]="'Actions for ' + name"`,
  `(selected)` emitting the item id.

**Responsive columns.** `hidden md:table-cell` (or `lg:`) goes on the
`<th>`, its `<td>` **and** the skeleton `<td>`; the hidden values
re-flow into a `md:hidden` sub-line built with `summaryLine([...])`.
Assert with `expectColumnVisibilityParity(fixture.nativeElement, label)`
in **both** the loaded and loading states — in `client-admin-app`. Its
lists write their own skeleton rows, which is where the third copy of
the class lives. `customer-app` hands `[loading]` to `ui-table`, which
swaps the whole table for a message, so there is no skeleton `<td>` and
nothing to keep paired; assert that no `<table>` renders instead, so the
guard is not silently checking nothing.

**A link whose text is data** needs `[overflow-wrap:anywhere]` on a
`<span>` *inside* the anchor — on the anchor it loses to `ui-table`'s
`::ng-deep` reset.

## 4. The form screen

One component for create and edit:

```ts
protected readonly thingId = signal<string | null>(null);
protected readonly editing = computed(() => this.thingId() !== null);
protected readonly form = this.fb.nonNullable.group({
  business: ['', Validators.required],     // hidden value-carrier
  name: ['', Validators.required],
});
```

`business` has no control on screen: it is patched from
`SelectedBusinessStore` on create and `.disable()`d on edit. It is in
`HIDDEN_VALUE_CARRIERS`, so a server rejection of it surfaces in the
page-level alert instead of vanishing.

**Every control must bind both `[invalid]` and `[errorMessage]`:**

```html
<ui-text-field label="Name" formControlName="name"
  [invalid]="!!fieldError('name')" [errorMessage]="fieldError('name')" />
```

`ui-text-field`/`ui-select` render nothing on their own. A form binding
neither does nothing visible on an invalid submit — which is how a form
in this app shipped broken. `fieldError()` wraps `fieldErrorMessage()`
from `shared/form-errors.ts`, which stays silent until `touched` but
shows a server error immediately.

Submit: guard `form.invalid` → `markAllAsTouched()`; `clearServerErrors`;
`PATCH` or `POST`; on failure `applyServerErrors(form, error, fallback)`
into a page alert; on success navigate.

**A documented header parameter goes in `params.header`**, not
`headers` — e.g. `params: { header: { 'Idempotency-Key': crypto.randomUUID() } }`.

**Guard every `patchValue` with `?? <default>`.** DRF marks anything
with a model default `required=False`, so the generated read type admits
`undefined`, and `patchValue` *applies* an explicit `undefined` rather
than skipping the key — blanking a required control.

**Naming.** `ui-form-section` renders a labelled **region**, so a
section must not be named around a control it contains — "Which trip"
wrapping a select called "Trip" gets both announced by a screen reader,
one nested in the other, and `getByLabel('Trip')` matches both. The
same applies to a select's blank first option: a prompt that restates
its own label ("What went wrong" / "What went wrong?") is read out
twice. Say "Choose one", or follow `record-tap`'s "Select a trip".

## 5. Enum label modules

One `shared/<domain>-labels.ts` per domain mapping each enum to a label,
a `StatusPillTone` and `SelectOption[]`. **Every pill carries its label
as text** — colour is never the only status indicator. Fall back to the
raw value rather than rendering blank, so a value the backend adds
before the frontend catches up is still readable.

**A per-app module, not a shared one**, when the sets or the wording
differ. `customer-app` and `client-admin-app` both label incident
statuses; the passenger set has no severity or source, and reads
"Received"/"Being investigated" where the operator reads
"Open"/"Investigating" — and `open` is `neutral` there, not `negative`,
because on the reporter's screen that row means "we have it".

If it also mirrors a backend state machine, say so in the docstring:
the duplication cannot be tested across languages, and it is acceptable
only because the backend is authoritative and its 409 is rendered.

## 6. Specs

Hand-written fake stores, not the real injectable:

```ts
class FakeThingStore {
  items = signal<Thing[]>([]); total = signal(0);
  page = signal({ limit: 25, offset: 0 });
  loading = signal(false); error = signal<string | null>(null);
  isEmpty = signal(false);
  getAll = jasmine.createSpy('getAll').and.resolveTo();
  updateQuery = jasmine.createSpy('updateQuery').and.resolveTo();
  changePage = jasmine.createSpy('changePage').and.resolveTo();
}
```

Providers: `provideRouter([])`, `{ provide: API_CLIENT, useValue: stub }`,
the fake store, `SelectedBusinessStore`, and for a form an
`ActivatedRoute` whose `snapshot.paramMap` is
`convertToParamMap(id ? { id } : {})` — route-param presence is how
create-vs-edit is driven. `AuthStore` is the **real** injectable, seeded
with `setSession('a', 'r', makeUser({ permissions: [...] }))` so
`*appHasPermission` resolves realistically.

**Spy `Router.navigate` centrally in setup.** `provideRouter([])`
registers no routes, so a real navigate rejects with NG04002 and fails
whichever test triggered it for an unrelated reason.

**Assert rendered output**, not just that a request did not fire:

```ts
Array.from(el.querySelectorAll('ui-text-field [role="alert"]')).map(e => e.textContent?.trim())
```

And assert a control **shows what it will submit** — `select.value`
against the control's value — wherever an initial value is not the first
option.

**A branch on a discriminator belongs in a `computed`, read off the
envelope** — never inferred from which keys a row happens to carry. Two
row shapes in one table (`trip-manifest`'s prepaid vs pay-as-you-go) are
two `@if` branches over two `computed` arrays, so each `@for` has one
concrete type.

## 7. E2E

`signIn`, then `selectActiveBusiness`, then one `test()` per
user-visible state, each closing with a fresh
`new AxeBuilder({ page }).analyze()`. `openRowMenu` is the row-scoped
`ui-action-menu` trigger lookup. Fixtures come from `seed_e2e_users`;
anything a spec must find **by name** needs a fixed value seeded there,
because generated ids and references are unpredictable by design.

Run per project (`--project=`); a bare run fails specs that share
fixtures.

## 8. The visual pass

```bash
UI_REVIEW_SPEC=<spec> UI_REVIEW_DIR=iteration-N E2E_SKIP_SEED=1 \
  npx playwright test --project=client-admin-app --grep @ui-review
```

Add flat screens to `screens`, and anything needing a real id to
`flows`. Findings go in `docs/ui-review/<spec>/iteration-N.md`; iterate
until clean.

**Do not edit source while a capture runs** — the dev server rebuilds
mid-run and invalidates it.

**A screen that looks merely empty is usually the harness, not the
screen.** Compare a known-populated screen at the same width before
believing a new one is broken.

## 9. Things that silently do nothing

| Symptom | Cause |
|---|---|
| A `<select>` shows the first option while the control holds another | fixed in `ui-select`; the pattern is a property binding applied before `@for` creates the options |
| A form does nothing visible on invalid submit | `[invalid]`/`[errorMessage]` not bound |
| A required control blanks itself on edit | `patchValue` applying an explicit `undefined` |
| A `computed()` over a form-control value never updates | it depends on no signal; use `toSignal(control.valueChanges)` |
| A detail screen's record goes `null` mid-session | a `computed()` over shared store `items()`; use `findByIdPaged` |
| An older response overwrites a newer one | no monotonic request id in the store |
| A hint reaches only sighted users | not wired through `describedBy`/`aria-describedby` |
| A capture pass is entirely empty | the harness lost its active Business |

## 10. Consumer storefront (`marketplace-app`)

The marketplace is the one app styled as a consumer travel storefront
rather than an operator console. Its design baseline is a survey of
travel/mobility aggregators — Omio, Busbud, FlixBus, Rome2Rio, BuuPass,
Wakanow — recorded in `docs/specs/24-marketplace-redesign.md`. When
adding a marketplace screen, check that table first: it says which
aggregator patterns we follow, which are deferred, and which are ruled
out until an endpoint can back them.

- **Tokens.** `mk-navy-950/900/800`, `mk-accent` (amber),
  `mk-on-navy-muted` live in `marketplace-app/src/styles.css`, layered
  on spec 14's theme. Amber is text/highlight **on navy only** — never a
  fill behind white text (1.67:1); where it is a fill, its text is
  `mk-navy-950`. Primary actions stay `bg-primary`.
- **Page width.** A route that needs the full width (hero, sidebar
  layout) sets `data: { fullBleed: true }`; everything else gets the
  shell's `max-w-4xl` column. `docs/traps.md`'s frontend section says
  why this is one outlet and a router-snapshot read.
- **Search bar.** One segmented bar from `lg` (fields borderless, split
  by `border-control` dividers, the bar drawing the outline), stacked
  bordered boxes below it; swap button on the From/To seam.
- **Result cards.** `@container` on the card, `@2xl:` for the
  three-column layout — the card's width, not the viewport's, decides.
  Operator first (flat cross-operator list), then depart — duration —
  arrive, then price and one action. Badges ("Cheapest", "Fastest") are
  computed over the *filtered* rows.
- **Claims.** Trust strips, payment lines and badges state only what the
  platform does today. No counts, ratings, or popularity we can't cite.
- **Browser storage** (recent searches) is a per-viewer convenience:
  every read/write wrapped, corrupt data ignored, and the page must work
  with none (`shared/recent-searches.ts`).
- **Dates** are local `YYYY-MM-DD` via `shared/dates.ts` — never
  `toISOString().slice(0, 10)`, which names yesterday in Lagos between
  00:00 and 01:00.

