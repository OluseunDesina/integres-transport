"""CI / test settings. DJANGO_SETTINGS_MODULE=config.settings.ci

Fast password hasher and no debug, but still a real Postgres (per the
brief's convention of testing against the real database engine, not
sqlite) — CI provisions a postgres service matching docker-compose.
"""

from .base import *  # noqa: F403
from .base import INSTALLED_APPS as _BASE_INSTALLED_APPS

DEBUG = False
SECRET_KEY = "ci-test-secret-key-that-is-long-enough-for-hs256"  # noqa: S105
ALLOWED_HOSTS = ["*"]

# Same fixed test Ed25519 keypair local.py uses — hardcoded directly
# (matching this file's own SECRET_KEY precedent above), not a bare
# config() call, since CI's env: block sets no ticketing-specific
# variables and this must not depend on one existing.
TICKET_SIGNING_KEYS = '{"local-dev-1": "WYlOUjSxsWXGm3kUxF42mt6h2KDlakGmaLD5lChwp6w="}'  # noqa: S105
TICKET_SIGNING_ACTIVE_KID = "local-dev-1"

# Test-only diagnostic app (apps/core/tests/testapp) used solely to
# exercise the tenancy base classes before a real business model exists
# (see docs/adr/0002). Never installed outside CI/test settings.
INSTALLED_APPS = [*_BASE_INSTALLED_APPS, "apps.core.tests.testapp"]

PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]

CELERY_TASK_ALWAYS_EAGER = True
CELERY_TASK_EAGER_PROPAGATES = True
