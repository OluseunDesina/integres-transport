"""Staging settings. DJANGO_SETTINGS_MODULE=config.settings.staging

Phase 0 assumption: secrets are read from environment variables (see
.env.example). The documented-but-unbuilt path to AWS Secrets Manager/SSM
is: replace `decouple.config()` calls in base.py with a secrets-backed
config source once real AWS infrastructure exists — not a Phase 0 item.
"""

from .base import *  # noqa: F403
from .base import config

DEBUG = False
SECURE_SSL_REDIRECT = True
# Without this, SECURE_SSL_REDIRECT loops forever behind any TLS-terminating
# reverse proxy (Render's load balancer, Vercel's edge, ...): the proxy's own
# hop to this process is plain HTTP, so request.is_secure() reads False and
# every request gets redirected to itself. Safe only because every real
# deployment target for this settings module sits behind exactly such a
# proxy, which sets/overwrites this header itself — never expose this
# process directly to untrusted clients with this set.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SECURE_HSTS_SECONDS = 3600

SECRET_KEY = config("DJANGO_SECRET_KEY")
# Re-declared bare (no default), same as SECRET_KEY above — base.py's
# own default="" only keeps local/ci importable; this line is what
# actually enforces "must never silently default" for this environment.
TICKET_SIGNING_KEYS = config("TICKET_SIGNING_KEYS")
TICKET_SIGNING_ACTIVE_KID = config("TICKET_SIGNING_ACTIVE_KID")
