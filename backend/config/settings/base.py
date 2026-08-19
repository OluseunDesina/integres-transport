"""
Base settings shared by every environment. Never import this directly in
`DJANGO_SETTINGS_MODULE` — use one of local / ci / staging / production,
each of which imports and overrides this module.
"""

from datetime import timedelta
from decimal import Decimal
from pathlib import Path

from corsheaders.defaults import default_headers
from decouple import Csv, config

# backend/config/settings/base.py -> backend/
BASE_DIR = Path(__file__).resolve().parent.parent.parent

SECRET_KEY = config("DJANGO_SECRET_KEY")
DEBUG = False
ALLOWED_HOSTS = config("DJANGO_ALLOWED_HOSTS", default="", cast=Csv())

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    # Postgres range fields — apps.seating.SeatReservation.segment_range
    # (docs/adr/0004), Phase 4 Slice 2. No other Postgres-contrib feature
    # (unaccent, trigram) is used; this app is required purely for
    # IntegerRangeField's system checks/serialization to work.
    "django.contrib.postgres",
    # third-party
    "rest_framework",
    "rest_framework_simplejwt",
    "drf_spectacular",
    "corsheaders",
    "django_celery_beat",
    # first-party
    "apps.businesses",
    "apps.clients",
    "apps.core",
    "apps.identity",
    "apps.network",
    "apps.fleet",
    "apps.scheduling",
    "apps.fares",
    "apps.booking",
    "apps.seating",
    "apps.tapngo",
    "apps.ledger",
    "apps.payments",
    "apps.wallet",
    "apps.ticketing",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "apps.core.middleware.NoStoreApiMiddleware",
    "apps.core.middleware.TenancyMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": config("POSTGRES_DB", default="integra_afc"),
        "USER": config("POSTGRES_USER", default="integra"),
        "PASSWORD": config("POSTGRES_PASSWORD", default="integra"),
        "HOST": config("POSTGRES_HOST", default="localhost"),
        "PORT": config("POSTGRES_PORT", default="5432"),
    }
}

AUTH_USER_MODEL = "identity.User"

# auth.E003 wants USERNAME_FIELD (`email`) to carry `unique=True`. It is
# deliberately NOT globally unique here — the brief requires the same
# email to exist independently under different Clients, so uniqueness is
# enforced via the conditional UniqueConstraints in User.Meta instead
# (see docs/adr/0003). Login is scoped accordingly in
# apps.identity.serializers, not via Django's default ModelBackend.
SILENCED_SYSTEM_CHECKS = ["auth.E003"]

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

# All datetimes are stored UTC (per convention) and rendered in Business
# timezone at the serialization boundary once Business exists (Phase 1+).
LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

# Local-disk storage only — S3/production storage is documented-but-unbuilt,
# same treatment Phase 0 gave AWS provisioning generally. `mediafiles/` was
# already in .gitignore since Phase 0 scaffolding, anticipating this.
MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / "mediafiles"

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# --- DRF / drf-spectacular ---

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": (
        "rest_framework_simplejwt.authentication.JWTAuthentication",
    ),
    "DEFAULT_PERMISSION_CLASSES": ("rest_framework.permissions.IsAuthenticated",),
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.LimitOffsetPagination",
    "PAGE_SIZE": 25,
    "DEFAULT_RENDERER_CLASSES": ("rest_framework.renderers.JSONRenderer",),
    "TEST_REQUEST_DEFAULT_FORMAT": "json",
    # Rate limiting is a cross-cutting requirement (auth, seat-hold and
    # booking endpoints); seat-hold/booking scopes are added when those
    # endpoints land. Split per-purpose (not one shared "auth" scope) so
    # unrelated endpoints don't count against each other's budget — found
    # as a real test-infrastructure fragility in the Phase 1 self-check
    # (docs/self-check-2026-08-08.md, Finding #4) once enough Playwright
    # sign-ins across multiple apps shared one 10/min pool. Same 10/min
    # ceiling per scope as before — this splits the budget, doesn't widen it.
    "DEFAULT_THROTTLE_CLASSES": ("rest_framework.throttling.ScopedRateThrottle",),
    "DEFAULT_THROTTLE_RATES": {
        "auth_login_customer": "10/min",
        "auth_login_client_admin": "10/min",
        "auth_login_super_admin": "10/min",
        "auth_register": "10/min",
        "auth_invite_accept": "10/min",
    },
}

SPECTACULAR_SETTINGS = {
    "TITLE": "Integra AFC API",
    "DESCRIPTION": (
        "Automated Fare Collection platform API. Versioned from v1; see "
        "docs/adr/ for tenancy, auth and domain-model decisions."
    ),
    "VERSION": "1.0.0",
    "SERVE_INCLUDE_SCHEMA": False,
    "SCHEMA_PATH_PREFIX": "/api/v1/",
}

# distinct audiences per app, per the brief's locked auth decision
JWT_AUDIENCE_CUSTOMER = "integra-customer-app"
JWT_AUDIENCE_CLIENT_ADMIN = "integra-client-admin-app"
JWT_AUDIENCE_SUPER_ADMIN = "integra-super-admin-app"

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=15),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=7),
    "ROTATE_REFRESH_TOKENS": True,
    "BLACKLIST_AFTER_ROTATION": True,
    "ALGORITHM": "HS256",
    "SIGNING_KEY": SECRET_KEY,
    "AUTH_HEADER_TYPES": ("Bearer",),
    "USER_ID_FIELD": "id",
    "USER_ID_CLAIM": "user_id",
}

# --- CORS ---
CORS_ALLOWED_ORIGINS = config("CORS_ALLOWED_ORIGINS", default="", cast=Csv())

# `Idempotency-Key` is a declared header parameter on every mutating
# endpoint that takes one, so a browser preflights those requests and
# blocks them unless the header is echoed back in
# Access-Control-Allow-Headers. django-cors-headers' defaults cover
# Authorization but not this, which is why reads worked from the SPA
# while POST /bookings/ failed CORS. This belongs in base rather than
# local: every hosted frontend hits the same wall, and it follows from
# the API contract, not from the environment.
CORS_ALLOW_HEADERS = (*default_headers, "idempotency-key")

# --- Cache (throttle state, and anything else cache-backed later) ---
# Redis-backed, not per-process LocMemCache: throttle counters must be
# shared across gunicorn/celery workers to actually rate-limit anything
# once there's more than one process.
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.redis.RedisCache",
        "LOCATION": config("REDIS_URL", default="redis://localhost:6379/0"),
    }
}

# --- Celery ---
CELERY_BROKER_URL = config("REDIS_URL", default="redis://localhost:6379/0")
CELERY_RESULT_BACKEND = config("REDIS_URL", default="redis://localhost:6379/0")
CELERY_ACCEPT_CONTENT = ["json"]
CELERY_TASK_SERIALIZER = "json"
CELERY_RESULT_SERIALIZER = "json"
CELERY_TIMEZONE = "UTC"

# Rolling window (in days) the scheduling.tasks.generate_trips Celery
# Beat job materializes Trip rows for from each active Schedule — see
# docs/specs/3-network-scheduling-fleet.md §4. A setting, not hardcoded
# in the task, so it's tunable via ops without a deploy.
TRIP_GENERATION_HORIZON_DAYS = 14

# --- Email ---
# Console backend: first real use of Django's mail framework in this
# repo (staff invitations, Slice 4). Real SMTP is documented-but-unbuilt,
# same treatment MEDIA_ROOT/local-disk storage got in Slice 2 — tests get
# Django's automatic locmem backend regardless of this setting.
EMAIL_BACKEND = "django.core.mail.backends.console.EmailBackend"

# ASSUMPTION: local-only for now, same treatment as MEDIA_ROOT — used to
# build the staff-invitation accept link. Real environments will need a
# per-environment value (and eventually per-WhiteLabelConfig domain,
# once Slice 5 lands subdomain resolution).
CLIENT_ADMIN_APP_URL = config("CLIENT_ADMIN_APP_URL", default="http://localhost:4201")

# --- Paystack (Phase 5 Slice 2, docs/specs/5-payments-wallet-ledger.md) ---
# No defaults — mirrors SECRET_KEY's own precedent for a secret that must
# never silently default. Required in every process that imports this
# settings module at all (backend, celery-worker, celery-beat), even
# though only the backend process's request/response cycle ever calls
# apps.payments.psp.paystack this slice — Django settings modules execute
# fully at startup regardless of which app code later runs, so the
# worker/beat processes need these set purely to boot.
PAYSTACK_SECRET_KEY = config("PAYSTACK_SECRET_KEY")
# Paystack's real API signs webhooks with the SAME secret used for API
# calls — there is no distinct "webhook secret" concept in their product,
# unlike Stripe. Kept as its own setting anyway so
# apps.payments.psp.paystack.verify_webhook_signature() doesn't hardcode
# that Paystack-specific detail into a name that would be misleading for
# a future second PSP; every environment's config sets both to the same
# value today.
PAYSTACK_WEBHOOK_SECRET = config("PAYSTACK_WEBHOOK_SECRET")
# Neither ADR-0006 nor docs/specs/5-payments-wallet-ledger.md names an
# actual commission percentage — deliberately left as a required,
# no-default env var rather than a code-level placeholder, so a real
# rate must be set explicitly per environment before any payment can be
# processed at all.
INTEGRA_COMMISSION_RATE_PERCENT = Decimal(config("INTEGRA_COMMISSION_RATE_PERCENT"))

# --- Ticketing (Phase 6 Slice 1, docs/specs/6-ticketing.md, docs/adr/0005) ---
# Empty-string default here, deliberately NOT bare like PAYSTACK_SECRET_KEY
# above — a bare config() call with no default executes unconditionally
# the moment this module is imported (via `from .base import *`), which
# raises decouple.UndefinedValueError immediately in any process with no
# `.env` and no matching OS env var, before local.py/ci.py's own
# `default=`/hardcoded override lines are ever reached (confirmed live
# while building this: PAYSTACK_SECRET_KEY's own bare form would crash
# `manage.py migrate` in CI today, since backend/.env is gitignored and
# ci.yml's env: block sets none of these — see docs/specs/6-ticketing.md's
# implementation note). staging.py/production.py each re-declare this
# setting with a bare, no-default config() call of their own, which is
# what actually enforces "must never silently default" for real
# environments — base.py's own default merely keeps local/ci imports
# from crashing before those settings modules get a chance to override
# it with a real value. TICKET_SIGNING_KEYS is a JSON object string,
# `{"kid": "<base64 Ed25519 private key>", ...}` — apps.ticketing.signing
# is the only module that ever reads it. TICKET_SIGNING_ACTIVE_KID names
# which entry new issuance signs with; every other entry is a
# still-honored, not-yet-removed retired key (see docs/specs/6-ticketing.md's
# "Correction made during implementation" note on why there is no
# separate grace-period setting).
TICKET_SIGNING_KEYS = config("TICKET_SIGNING_KEYS", default="")
TICKET_SIGNING_ACTIVE_KID = config("TICKET_SIGNING_ACTIVE_KID", default="")
# Not secrets — real, non-secret defaults here, matching POSTGRES_DB's
# own default= usage in this file. Anchored to Trip.scheduled_departure_at,
# not issuance time — see docs/specs/6-ticketing.md's Data model section.
TICKET_VALID_BEFORE_MINUTES = config("TICKET_VALID_BEFORE_MINUTES", default=1440, cast=int)
TICKET_VALID_AFTER_MINUTES = config("TICKET_VALID_AFTER_MINUTES", default=240, cast=int)

# Gates apps.core.views.GenerateTripsView/ExpireSeatHoldsView — only
# meaningful on config.settings.vercel, which has no Celery Beat process
# to run these on a schedule instead. Safe empty default here for the
# same reason TICKET_SIGNING_KEYS has one: keeps local/ci/every other
# environment importable without ever needing this value.
INTERNAL_TASK_SECRET = config("INTERNAL_TASK_SECRET", default="")

# --- Structured logging (JSON), request-ID propagation is added in apps.core
# middleware; this is the minimal Phase 0 baseline. ---
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "json": {
            "format": (
                '{"level": "%(levelname)s", "time": "%(asctime)s", '
                '"logger": "%(name)s", "message": "%(message)s"}'
            ),
        },
    },
    "handlers": {
        "console": {"class": "logging.StreamHandler", "formatter": "json"},
    },
    "root": {"handlers": ["console"], "level": "INFO"},
}
