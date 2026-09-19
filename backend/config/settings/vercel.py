"""Vercel + Supabase settings. DJANGO_SETTINGS_MODULE=config.settings.vercel

See docs/deployment.md. A sibling of staging.py/production.py, not a
patch on either — Vercel runs no persistent process, so this module
makes three real, deliberate departures from them:

1. `CELERY_TASK_ALWAYS_EAGER = True` — there is no celery-worker/
   celery-beat on Vercel. Eager mode makes every `.delay()` call
   (`send_client_invitation_email`, `send_staff_invitation_email`)
   execute synchronously in-process instead of going through a broker;
   the two Celery Beat jobs (`generate_trips`, `expire_seat_holds`) are
   instead triggered over HTTP — see `apps.core.views` and
   `docs/deployment.md`.
2. `CACHES` uses the local in-memory backend, not Redis — nothing in
   this codebase actually uses Django's cache framework today (confirmed
   by grep before adding this module), so there's nothing to provision
   Redis for on this target.
3. `DATABASES["default"]["OPTIONS"]["prepare_threshold"] = None` —
   required for psycopg3 against Supabase's Supavisor pooler in
   transaction mode, whose prepared-statement support has documented
   bugs; disabling prepared statements client-side is Supabase's own
   documented workaround.
4. `MEDIA_ROOT` under `/tmp` — Vercel's filesystem is read-only outside
   `/tmp` (confirmed 2026-09-17: every KYB/KYC document upload against
   the live deployment was throwing an unhandled `OSError: [Errno 30]
   Read-only file system`, not silently losing the file the way
   docs/deployment.md §7 originally assumed). This stops the crash —
   uploads succeed — but does **not** fix persistence: `/tmp` is still
   wiped on cold start and not shared across concurrent instances, so a
   document can still vanish later. Deliberately the fast unblock, not
   the real fix; docs/deployment.md §7 still names S3 + `django-storages`
   as what an environment trusted with real documents actually needs.
"""

from pathlib import Path

from .base import *  # noqa: F403
from .base import DATABASES, config

DEBUG = False
SECURE_SSL_REDIRECT = True
# See staging.py's identical line — required alongside SECURE_SSL_REDIRECT
# behind Vercel's TLS-terminating edge, or every request 301-loops forever.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SECURE_HSTS_SECONDS = 3600

SECRET_KEY = config("DJANGO_SECRET_KEY")
# Re-declared bare, same reasoning staging.py/production.py already
# document for these two lines.
TICKET_SIGNING_KEYS = config("TICKET_SIGNING_KEYS")
TICKET_SIGNING_ACTIVE_KID = config("TICKET_SIGNING_ACTIVE_KID")
INTERNAL_TASK_SECRET = config("INTERNAL_TASK_SECRET")

CELERY_TASK_ALWAYS_EAGER = True

CACHES = {
    "default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"},
}

DATABASES["default"]["OPTIONS"] = {"prepare_threshold": None}

MEDIA_ROOT = Path("/tmp") / "mediafiles"  # noqa: S108 — the one writable path on this target, see docstring point 4
