"""Backfills `status` from the old `is_active` boolean —
docs/specs/19-route-lifecycle.md. `True -> active`, `False -> inactive`;
no route lands on `draft` from this backfill, so nothing already in
service is silently taken out of it.

**RLS.** `network_route` is RLS-protected with FORCE, and this
migration's DB session never calls `apps.core.rls.set_rls_session_vars`
otherwise, so `app.current_client_id` / `app.is_platform_staff` both
read back NULL and every row is invisible — the same trap
`businesses/0010`'s own docstring records, and the same fix: set the
session vars first and read/write through `all_objects`.

The completeness check is raw SQL over what *remains* `NULL`, not an ORM
count of what the `.update()` calls reported — see that same migration's
docstring for why counting through the manager that did the writing is
tautological.
"""

from django.db import migrations

from apps.core.rls import set_rls_session_vars


def _count_remaining_null(table: str, column: str) -> int:
    from django.db import connection

    with connection.cursor() as cursor:
        cursor.execute(f"SELECT COUNT(*) FROM {table} WHERE {column} IS NULL")  # noqa: S608
        return cursor.fetchone()[0]


def backfill_status(apps, schema_editor):  # type: ignore[no-untyped-def]
    set_rls_session_vars(None, is_platform_staff=True)
    Route = apps.get_model("network", "Route")

    Route.all_objects.filter(is_active=True).update(status="active")
    Route.all_objects.filter(is_active=False).update(status="inactive")

    remaining = _count_remaining_null("network_route", "status")
    assert remaining == 0, (
        f"{remaining} routes still have a NULL status after the backfill — "
        "the update matched fewer rows than exist, so something hid them "
        "from this migration."
    )


def unbackfill_status(apps, schema_editor):  # type: ignore[no-untyped-def]
    """Not a real reverse — there is no way to recover 'this row was
    NULL before' once every row has a value. Reversing 0006 (dropping
    the column) is what actually undoes this; this only exists so the
    migration is formally reversible without lying about symmetry."""
    set_rls_session_vars(None, is_platform_staff=True)
    Route = apps.get_model("network", "Route")
    Route.all_objects.update(status=None)


class Migration(migrations.Migration):

    dependencies = [
        ("network", "0006_route_lifecycle_additive"),
    ]

    operations = [
        migrations.RunPython(backfill_status, unbackfill_status),
    ]
