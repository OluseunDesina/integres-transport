"""Version FareRule / FareSegmentRule with effective date windows.

Sequence (zero-downtime): additive columns → backfill → enforce NOT NULL
→ drop OneToOne uniqueness / is_active → add GiST exclusion constraints.

Approved destructive steps (plan §5): drop the route OneToOne unique
constraint, and drop `is_active` (replaced by the validity window).
"""

from __future__ import annotations

import django.db.models.deletion
from django.db import connection, migrations, models


_ENABLE_BTREE_GIST = "CREATE EXTENSION IF NOT EXISTS btree_gist;"

_FARE_RULE_EXCLUSION = """
    ALTER TABLE fares_farerule
      ADD CONSTRAINT no_overlapping_fare_rule_per_route
      EXCLUDE USING gist (
        route_id WITH =,
        tstzrange(effective_from, effective_to) WITH &&
      )
      WHERE (deleted_at IS NULL);
"""

_DROP_FARE_RULE_EXCLUSION = (
    "ALTER TABLE fares_farerule DROP CONSTRAINT no_overlapping_fare_rule_per_route;"
)

_FARE_SEGMENT_EXCLUSION = """
    ALTER TABLE fares_faresegmentrule
      ADD CONSTRAINT no_overlapping_fare_segment_per_route
      EXCLUDE USING gist (
        route_id WITH =,
        from_stop_id WITH =,
        to_stop_id WITH =,
        tstzrange(effective_from, effective_to) WITH &&
      )
      WHERE (deleted_at IS NULL);
"""

_DROP_FARE_SEGMENT_EXCLUSION = (
    "ALTER TABLE fares_faresegmentrule "
    "DROP CONSTRAINT no_overlapping_fare_segment_per_route;"
)


def _bypass_rls(cursor) -> None:  # type: ignore[no-untyped-def]
    cursor.execute("SELECT set_config('app.is_platform_staff', 'true', true)")
    cursor.execute("SELECT set_config('app.current_client_id', NULL, true)")


def backfill_effective_windows(apps, schema_editor):  # type: ignore[no-untyped-def]
    with connection.cursor() as cursor:
        _bypass_rls(cursor)
        cursor.execute(
            """
            UPDATE fares_farerule
            SET effective_from = created_at,
                effective_to = CASE WHEN is_active THEN NULL ELSE updated_at END
            WHERE effective_from IS NULL
            """
        )
        cursor.execute(
            """
            UPDATE fares_faresegmentrule
            SET effective_from = created_at
            WHERE effective_from IS NULL
            """
        )


class Migration(migrations.Migration):

    dependencies = [
        ("fares", "0001_initial"),
        ("network", "0003_route_ordering"),
        ("businesses", "0003_business_fare_pricing_mode"),
    ]

    operations = [
        migrations.AddField(
            model_name="farerule",
            name="effective_from",
            field=models.DateTimeField(null=True),
        ),
        migrations.AddField(
            model_name="farerule",
            name="effective_to",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="faresegmentrule",
            name="effective_from",
            field=models.DateTimeField(null=True),
        ),
        migrations.AddField(
            model_name="faresegmentrule",
            name="effective_to",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AlterField(
            model_name="farerule",
            name="route",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.PROTECT,
                related_name="+",
                to="network.route",
            ),
        ),
        migrations.RemoveConstraint(
            model_name="faresegmentrule",
            name="unique_fare_segment_per_route",
        ),
        migrations.RunPython(backfill_effective_windows, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="farerule",
            name="effective_from",
            field=models.DateTimeField(),
        ),
        migrations.AlterField(
            model_name="faresegmentrule",
            name="effective_from",
            field=models.DateTimeField(),
        ),
        migrations.RemoveField(
            model_name="farerule",
            name="is_active",
        ),
        migrations.AlterModelOptions(
            name="farerule",
            options={"ordering": ["-effective_from", "-created_at"]},
        ),
        migrations.AlterModelOptions(
            name="faresegmentrule",
            options={"ordering": ["-effective_from", "-created_at"]},
        ),
        migrations.RunSQL(_ENABLE_BTREE_GIST, migrations.RunSQL.noop),
        migrations.RunSQL(_FARE_RULE_EXCLUSION, _DROP_FARE_RULE_EXCLUSION),
        migrations.RunSQL(_FARE_SEGMENT_EXCLUSION, _DROP_FARE_SEGMENT_EXCLUSION),
    ]
