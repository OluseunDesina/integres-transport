"""Local development settings. DJANGO_SETTINGS_MODULE=config.settings.local"""

from typing import cast

from .base import *  # noqa: F403
from .base import config

DEBUG = True
ALLOWED_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0"]  # noqa: S104
CORS_ALLOWED_ORIGINS = [
    "http://localhost:4200",
    "http://localhost:4201",
    "http://localhost:4202",
    "http://localhost:4203",  # validator-app — docs/specs/4b-tap-and-go.md
    "http://localhost:4204",  # marketplace-app — docs/specs/22-marketplace.md
]

SECRET_KEY = config("DJANGO_SECRET_KEY", default="local-insecure-secret-key-do-not-use-in-prod")

# Fixed, hardcoded, insecure test Ed25519 keypair — a plain assignment,
# not a config() call (see base.py's own comment on TICKET_SIGNING_KEYS
# for why a config()-with-default override here wouldn't add anything:
# base.py's own default= already keeps this module importable).
TICKET_SIGNING_KEYS = '{"local-dev-1": "WYlOUjSxsWXGm3kUxF42mt6h2KDlakGmaLD5lChwp6w="}'
TICKET_SIGNING_ACTIVE_KID = "local-dev-1"

# Auth throttle rates, local-only — production/staging keep base.py's
# strict 10/min per scope unchanged (a real security parameter, not
# touched here). Playwright's local e2e suites run against this exact
# settings module (docker-compose.yml's backend service), and per-app
# suites have now outgrown the 10/min ceiling within their own scope
# three times over (Phase 2 self-check, docs/self-check-<date>.md,
# Finding: Slices 4-6 each independently hit it) — a test-environment
# sizing problem, not a security one. Widening only the settings module
# that's explicitly for local development is the minimal-blast-radius
# fix: `config.settings.ci` (real CI) and production/staging are
# unaffected, so the actual rate-limiting guarantee anywhere it matters
# is unchanged.
#
# **Merged into base's rates, not substituted for them.** This block used
# to replace `DEFAULT_THROTTLE_RATES` wholesale, which meant any scope
# added to `base.py` did not exist under `config.settings.local` at all —
# and DRF answers an unknown scope with `ImproperlyConfigured`, i.e. a
# 500. Spec 16 slice 4's `export` scope hit exactly that: every one of
# its endpoints 500'd the first time they were called in a browser, while
# the whole backend suite stayed green, because `config.settings.ci`
# inherits these rates rather than overriding them. Spreading base's dict
# first means the next scope is inherited automatically and only the
# values named below are widened.
REST_FRAMEWORK = {
    **REST_FRAMEWORK,  # noqa: F405
    "DEFAULT_THROTTLE_RATES": {
        **cast(dict[str, str], REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]),  # noqa: F405
        "auth_login_customer": "100/min",
        "auth_login_client_admin": "100/min",
        "auth_login_super_admin": "100/min",
        "auth_register": "100/min",
        "auth_register_customer": "100/min",
        "auth_invite_accept": "100/min",
        # Playwright downloads several exports in one run.
        "export": "100/min",
        # And files several passenger reports in one run.
        "incident_report": "100/min",
        # And resolves the same passenger on every counter-booking spec.
        "passenger_lookup": "100/min",
    },
}
