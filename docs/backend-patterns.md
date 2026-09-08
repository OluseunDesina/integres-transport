# Backend patterns — the cookbook

**Read this instead of re-deriving the house shape.** Every backend
slice needs the same dozen conventions, and rediscovering them by
reading three existing apps is the single most expensive habit in this
project. `apps/tapngo` and `apps/incidents` are the two reference apps;
this file is the distilled version of what they show.

If something here is wrong or out of date, fix it here — do not go back
to reading four apps to find out.

---

## 1. A new domain app, file by file

```
apps/<name>/
  __init__.py          empty
  apps.py              AppConfig: name = "apps.<name>", label = "<name>"
  models.py            BaseModel subclasses
  serializers.py       validation + read shapes
  services.py          all business logic, and all domain exceptions
  views.py             thin request/response glue
  urls.py              plain path() entries, no routers, no viewsets
  migrations/          0001_initial.py + EnableRowLevelSecurity
  tests/
    __init__.py
    factories.py       factory_boy
    helpers.py         auth clients + fixture builders (optional)
    test_<name>.py
    test_<name>_rls.py raw-SQL adversarial probe
```

**There is no `exceptions.py` anywhere in this codebase** — domain
exceptions live at the top of `services.py`. There is no `admin.py`
unless the model genuinely needs one (and note Django admin cannot read
RLS-protected models: an admin request authenticates by cookie, resolves
as anonymous, and sees zero rows).

Register in two places:

- `config/settings/base.py` → `INSTALLED_APPS`, as `"apps.<name>"`
  (module path, not the AppConfig path), in the first-party block.
- `config/urls.py` → `path("api/v1/", include("apps.<name>.urls"))`.
  The app's own `urls.py` carries the full resource path.

## 2. Models

```python
class Thing(BaseModel):
    class Status(models.TextChoices):
        OPEN = "open", "Open"

    business = models.ForeignKey(Business, on_delete=models.PROTECT, related_name="+")
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.OPEN)

    class Meta:
        ordering = ["-created_at"]          # ← see below, this is not optional
        constraints = [...]
        indexes = [models.Index(fields=["business", "created_at"], name="thing_business_created")]
```

- `BaseModel` gives `id` (UUID), `client` FK, `created_at`,
  `updated_at`, `deleted_at`, `objects` (tenant-scoped **and**
  soft-delete-filtered) and `all_objects` (neither).
  `Meta.base_manager_name = "all_objects"`.
- **`ordering` must be restated in any `Meta` you declare.** Django
  inherits an abstract base's `Meta` options only when the subclass
  declares no `Meta` of its own. `network.Route` documents this;
  `identity.Role` and `identity.User` shipped unordered pagination — a
  real bug — through exactly this gap.
- Every FK is `related_name="+"`. A reverse accessor traverses the
  tenant-scoped manager and silently empties outside a tenancy context.
  Use `.filter(...)` for "children of X".
- Every FK is `on_delete=PROTECT`, except a child row that has no
  meaning without its parent (`IncidentActivity.incident` is `CASCADE`).
- Statuses are nested `TextChoices`. Never a bare `CharField` with
  `choices` in a dict, and never free text — a free-text field generates
  as an untyped `string` in `schema.ts`.
- **Never `condition=Q(deleted_at__isnull=True)` on a constraint.** Soft
  delete is a manager concern here; no conditioned constraint of that
  shape exists in this codebase.
- Money is `Decimal` with an explicit currency field. Datetimes are UTC.
- Geographic precision is `DecimalField(max_digits=9, decimal_places=6)`,
  matching `network.Stop`.

Django 6 spells it `CheckConstraint(condition=...)`, not `check=`.

## 3. Migrations

```bash
uv run python manage.py makemigrations <app>
```

Then **hand-append the RLS operations** — this is the step that is easy
to forget:

```python
from apps.core.migration_operations import EnableRowLevelSecurity
...
        EnableRowLevelSecurity("Thing"),      # model name, CamelCase, not the table
```

`apps/core/tests/test_row_level_security.py` walks every concrete
`BaseModel` subclass from the app registry with **no allowlist**, so a
missing operation fails the suite automatically.

Declare both managers in the initial `CreateModel` so no follow-up
`AlterModelManagers` migration is generated (`tapngo` and `booking` each
needed a `0002` for exactly that).

**A data migration touching a `BaseModel` must call
`set_rls_session_vars(None, is_platform_staff=True)` and use
`all_objects`.** RLS fails closed, a migration has no
`app.current_client_id`, and the result is a migration that reports `OK`
having selected zero rows. `identity/0019` shipped that way once.

## 4. Services — the only place business logic lives

Domain exceptions at the top, each docstring naming its HTTP mapping:

```python
class ThingNotReady(Exception):
    """... — mapped to 409."""
```

There is no shared exception base, no `APIException` subclass and no
custom DRF exception handler. Views catch each one explicitly.

Audit every meaningful write: `record_audit_event(actor=..., action=
"thing.created", target=thing, **metadata)` — action names are
`"<snake_case_model>.<past_tense_verb>"`, all extra kwargs become
`metadata`. Order inside a service function is: create → mutate state →
`record_audit_event` → `notify_*` → return.

`apps.core.rls.platform_staff_bypass()` is the sanctioned way for system
code with no authenticated request to reach RLS-protected rows. It opens
its own transaction when none is active, is safe to nest, and does
**not** touch the Python contextvar — so use `.all_objects` inside it. A
service that needs it should open it around its own body rather than
relying on who happens to call it.

## 5. Idempotency

Header read in the view:

```python
idempotency_key = request.headers.get("Idempotency-Key")
if not idempotency_key:
    return Response({"detail": "Idempotency-Key header is required."}, status=400)
```

Declare it in the schema as a required header `OpenApiParameter`.
`CORS_ALLOW_HEADERS` already carries `idempotency-key`.

Service shape — lookup first, write inside one atomic block, reconcile
the race:

```python
existing = IdempotencyKey.objects.filter(
    client_id=client_id, endpoint=ENDPOINT, key=idempotency_key).first()
if existing is not None:
    if existing.request_hash != request_hash:
        raise IdempotencyKeyConflict(...)
    return _object_from_record(existing)

try:
    with transaction.atomic():
        obj = ...                               # domain rows
        IdempotencyKey.objects.create(          # same transaction, so a
            client_id=client_id, endpoint=ENDPOINT,   # failed attempt
            key=idempotency_key,                      # memorizes nothing
            request_hash=request_hash,
            response_status=201,
            response_body={"thing_id": str(obj.id)})
except IntegrityError:
    record = IdempotencyKey.objects.get(client_id=..., endpoint=..., key=...)
    if record.request_hash != request_hash:
        raise IdempotencyKeyConflict(...) from None
    return _object_from_record(record)
```

A replay returns **201 with the same `id`**, not 200.

## 6. Serializers — the frozen-queryset trap

**Never** `PrimaryKeyRelatedField(queryset=Model.objects.all())`.
`SerializerMetaclass` collects declared fields at class-body execution
time, before any request has a tenancy context, so it freezes empty
forever. Declare a `UUIDField` and resolve in `validate_<field>()`,
returning the instance:

```python
def _resolve_trip(value: Any) -> Trip:
    try:
        return Trip.objects.select_related("route", "business").get(pk=value)
    except Trip.DoesNotExist:
        raise serializers.ValidationError("Unknown trip.", code="unknown_trip") from None
```

An unknown *or another Client's* id is a 400. Silently returning an
unfiltered result would be worse — the caller would believe it had
scoped and had not.

**`identity.User` is the exception.** It is not a `BaseModel`
(docs/adr/0003 — `client` is nullable for platform staff), so
`User.objects` is the plain unscoped manager and will happily find
another Client's staff. Filter `client=` **explicitly**.

Two more:

- A serializer `default=` makes drf-spectacular emit the field as
  **required** in `schema.ts`. Use `required=False` with no `default=`
  and let the service own the default.
- A `blank=True` model field with `choices` loses the blank when a
  `ModelSerializer` infers it. Declare it explicitly with
  `allow_blank=True`.
- `search` query fields take `allow_blank=True` — the shared filter bar
  submits `''` when cleared.

## 7. Views

**Never a class-level `queryset = Model.objects.all()`** — evaluated
once at import, frozen empty. Always `get_queryset()` as a method.
(`.all_objects` is contextvar-free and safe as a class attribute.)

Permission split per method — note the trailing `()`, since
`HasPermission` is a factory returning a class:

```python
def get_permissions(self) -> list[BasePermission]:
    if self.request.method == "POST":
        return [HasPermission("thing.manage")()]
    return [HasPermission("thing.view")()]
```

- Staff endpoints: `HasPermission("<codename>")`.
- Passenger endpoints: `permission_classes = [IsAuthenticated]` plus an
  ownership filter or explicit 403. Passengers have no Role
  (docs/adr/0003), so any `HasPermission` gate excludes them by
  construction.
- Platform-only: `IsPlatformStaff`.
- Another Client's record is a **404, not a 403** — saying "forbidden"
  confirms it exists.
- `assert isinstance(user, User)` before handing `request.user` to a
  service.
- `@extend_schema` whenever the request and response serializers differ,
  or drf-spectacular documents the request shape as the response.
- Pagination is global (`LimitOffsetPagination`, `PAGE_SIZE = 25`).
  Never declare `pagination_class`.
- A **record list must not inherit an aggregate's default period.**
  `GET /payments/` was silently truncated to 30 days for two specs.

Throttling: `throttle_classes = [ScopedRateThrottle]` plus
`throttle_scope = "<scope>"`, and a named entry in `base.py`'s
`DEFAULT_THROTTLE_RATES`. `local.py` **merges** base's dict — keep it
that way, or a new scope will not exist there and DRF answers an unknown
scope with `ImproperlyConfigured`, i.e. a 500 no test catches.

## 8. Permissions — two migrations, never one

1. `identity/00NN_seed_<spec>_permissions.py` — copy
   `0003_seed_permissions.py`'s shape: a `PERMISSIONS` list of
   `(codename, description)`, `get_or_create` forward, `filter().delete()`
   reverse. `Permission` is not a `BaseModel`, so no bypass is needed.
2. Add the codenames to `DEFAULT_ROLE_PERMISSIONS` in
   `apps/identity/services.py` (`Owner` is `None` = every codename).
3. **A grant migration for roles that already exist.** A seed migration
   grants a codename to *nobody*; `create_default_roles` applies the
   dict only to roles it creates. `identity/0021` is the pattern — and
   it must `set_rls_session_vars(None, is_platform_staff=True)` and use
   `Role.all_objects`, or it reports `OK` having done nothing.

Skipping step 3 ships a feature that 403s for every existing Client.

## 9. Tests

`pytestmark = pytest.mark.django_db` at module level. `reverse()`, never
a literal path. `from rest_framework import status`.

**Factories:** `client = factory.SubFactory("apps.clients.tests.factories.ClientFactory")`,
children pinned with `factory.SelfAttribute("..client")`, or
`factory.LazyAttribute(lambda o: o.route.business)`. Existing ones:
`ClientFactory`, `BusinessFactory`, `RouteFactory`, `StopFactory`,
`RouteStopFactory`, `VehicleTypeFactory`, `VehicleFactory`,
`DriverFactory`, `ScheduleFactory`, `TripFactory`, `SeatFactory`,
`BookingFactory`, `TapCredentialFactory`, `IncidentFactory`, and
`PassengerUserFactory` / `ClientStaffUserFactory` /
`PlatformStaffUserFactory`. There is **no** `RoleFactory` — roles come
from `create_default_roles(client)`.

**Every `BaseModel` row must be created inside `tenant_context`** — RLS
is `FORCE`d and an insert with no `app.current_client_id` fails.
`ClientFactory()` and the user factories are called bare. **Do not wrap
API calls**: the JWT establishes tenancy itself, and wrapping would hide
a middleware regression.

**Auth client** (copied per module by convention):

```python
def auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)   # or Customer…, SuperAdmin…
    api = APIClient()
    api.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return api
```

Permission enforcement: `create_default_roles(client)` then
`ClientStaffUserFactory(client=client, role=roles["Staff"])`. Note
`role=None` means "not provided" to factory_boy — to test a user with no
role, create normally then set `.role = None` and save.

**The mandatory set, per endpoint and not just per model:**

- Another Client's rows absent from the list, **and** the caller's own
  rows still present — isolation must not be achieved by returning
  nothing to anybody.
- Detail / PATCH / action on another Client's record: **404**.
- Another Client's id as a query param: **400**.
- A raw-SQL probe in `test_<app>_rls.py`.
- Anonymous: 401. Wrong role: 403.
- Idempotency: replay returns the original (same `id`, DB count 1);
  same key + different body is 409; missing header is 400.

**Assert the invariant, not the example** — "the slices sum to the
total" catches what checking three values does not.

**Assert a property, not a magic query budget.** Compare a request over
1 row with one over 12 and assert the counts are equal; a fixed
`django_assert_max_num_queries(N)` drifts with unrelated changes and
still passes an N+1 that only appears at scale.

**Name the period whenever a test asserts a trip count** — trip filters
narrow on `service_date`, and a fixture departing a few hours out lands
on *tomorrow* in the evening.

`mypy` ignores `*.tests.*`; ruff does not (100 cols, sorted imports,
`apps`/`config` first-party). Annotate `-> None` anyway, and use
`# type: ignore[no-untyped-def]` on helpers taking pytest fixtures.

## 10. Verification, in order

```bash
cd backend
uv run pytest -q --create-db          # --create-db: see the --reuse-db trap
uv run ruff check . && uv run mypy .
uv run python manage.py spectacular --file openapi.yaml --validate
./scripts/check_openapi_drift.sh
cd ../frontend && npm run openapi:generate && npm run openapi:check
npm run test:all && npm run build:all
```

Then **live against the real stack**, because a passing test only proves
self-consistency. Run the backend with `uv run python manage.py runserver`
against the `postgres`/`redis` containers (the committed backend image
lags its dependencies). Direct `psql` uses **`integra_app`, never
`integra`** — the latter is a bootstrap superuser that bypasses RLS
unconditionally, so everything looks right for the wrong reason. To read
RLS-protected tables in `psql`: `SET app.is_platform_staff = 'true';`

Playwright needs `E2E_SKIP_SEED=1` when the backend is not in Docker;
seed manually first with `uv run python manage.py seed_e2e_users`. Run
every project with `--project=<name>` — a bare run has three specs that
interfere.

## 11. OpenAPI

Regenerate and commit `backend/openapi.yaml` and
`frontend/projects/api-client/src/lib/schema.ts` in the same change; CI
checks drift both ways.

**Name any new enum that collides.** drf-spectacular resolves a
colliding field name (`status`, most often) by appending a hash **of the
choice set**, so `StatusD05Enum` becomes the type `schema.ts` exports —
and adding a value later silently renames it. Add an entry to
`SPECTACULAR_SETTINGS["ENUM_NAME_OVERRIDES"]` pointing at a
**module-level** constant; the setting resolves a dotted path with
`import_string`, which cannot walk into a nested class.

Endpoints the frontend must call through the typed client have to be
documented (not `exclude=True`), or the call loses `authMiddleware`'s
bearer token and 401 refresh-and-replay.

## 12. Things that will silently do nothing

Collected because each one cost real time, and none of them raises.

| Symptom | Cause |
|---|---|
| Queryset always empty | class-level `queryset =` attribute, or `.objects` with no tenancy context |
| Migration reports `OK`, changed nothing | RLS fails closed; needs `set_rls_session_vars` + `all_objects` |
| `save(update_fields=...)` updates zero rows | no tenancy context; fixed globally by `base_manager_name = "all_objects"` |
| Serializer FK never matches | `queryset=` evaluated at import time |
| Cross-Client user resolves fine | `identity.User` is not tenant-scoped |
| New throttle scope 500s in dev only | a settings override that *replaces* a dict hides later additions |
| Streaming response returns an empty file, 200 OK | `TenancyMiddleware` commits and resets contextvars before the body is iterated |
| Half the suite fails on permissions | `--reuse-db` after a `transaction=True` test flushed seeded migration data — run `--create-db` |
| Money renders without cents | a plain-dict endpoint emits `Decimal` as a JSON float while `schema.ts` says string — render rows through the serializer the schema is built from |
| A generated list type is `{[key: string]: unknown}[]` | `ListField(child=DictField())`; two row shapes in one envelope want a `PolymorphicProxySerializer` and a discriminator |
| A unique constraint fails on the second row of a backfill | the column and the constraint landed in one migration — add the column, backfill, *then* constrain |
| A registry-driven test silently stops covering a resource | it was excluded because it needed a filter; declare the requirement on the spec so the test can supply it instead |
