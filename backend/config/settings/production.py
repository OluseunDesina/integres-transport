"""Production settings. DJANGO_SETTINGS_MODULE=config.settings.production

Same posture as staging for Phase 0 (no real production infrastructure
exists yet); kept as a distinct module so environment-specific hardening
(e.g. stricter HSTS preload, real Secrets Manager wiring) lands here
without touching staging.
"""

from .base import *  # noqa: F403
from .base import config

DEBUG = False
SECURE_SSL_REDIRECT = True
# See staging.py's identical line for why this is required, not optional,
# alongside SECURE_SSL_REDIRECT.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SECURE_HSTS_SECONDS = 31536000
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = True

SECRET_KEY = config("DJANGO_SECRET_KEY")
# See staging.py's identical lines for why these are re-declared bare.
TICKET_SIGNING_KEYS = config("TICKET_SIGNING_KEYS")
TICKET_SIGNING_ACTIVE_KID = config("TICKET_SIGNING_ACTIVE_KID")
