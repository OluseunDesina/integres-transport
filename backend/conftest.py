"""Repo-wide pytest fixtures.

Django wraps each test in a DB transaction that's rolled back afterward,
but cache state (Redis-backed, see config.settings.base.CACHES) is NOT
part of that rollback. Without this, a throttle test that trips a rate
limit leaves the counter in Redis and 429s unrelated tests that happen to
run afterward against the same scope/IP — exactly what happened before
this fixture existed.
"""

from collections.abc import Iterator
from pathlib import Path

import pytest
from django.core.cache import cache


@pytest.fixture(autouse=True)
def _clear_cache_between_tests() -> Iterator[None]:
    cache.clear()
    yield
    cache.clear()


@pytest.fixture(autouse=True)
def _media_root_uses_tmp_path(settings: object, tmp_path: Path) -> None:
    """KycDocument.file writes to MEDIA_ROOT — without this, test uploads
    would land in the real backend/mediafiles/ directory."""
    settings.MEDIA_ROOT = tmp_path  # type: ignore[attr-defined]
