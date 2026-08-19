"""WSGI entrypoint for Vercel's Python runtime.

Vercel's @vercel/python builder loads this module and expects a
module-level WSGI-callable named `app`. Separate from config/wsgi.py
(which hardcodes DJANGO_SETTINGS_MODULE=config.settings.local as its
own default, same pattern) because this is the only entrypoint that
should ever default to config.settings.vercel.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.vercel")

from django.core.wsgi import get_wsgi_application  # noqa: E402

app = get_wsgi_application()
