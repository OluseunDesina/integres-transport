"""Add `trip_class` to both fare rule models and put it in the key of
both GiST exclusion constraints — docs/specs/15-trip-classes.md.

Sequence: add the columns, then drop and re-add each constraint with
`trip_class WITH =` in its key.

**No separate backfill or NOT-NULL step.** The spec's migration section
prescribes add-nullable → backfill → enforce, which is the right shape
when a default cannot be expressed. Here it can: on Postgres 11+ (this
deployment is 16) `ADD COLUMN ... DEFAULT <constant>` is a catalog-only
operation that presents the default for every existing row without
rewriting the table, so the three steps collapse into one with the same
lock profile and the same result — every pre-existing rule becomes a
`''` wildcard rule and prices exactly as it did before.

**Step 3 takes an `ACCESS EXCLUSIVE` lock** on `fares_farerule` and
`fares_faresegmentrule` while each GiST index is rebuilt. Brief at
current data volumes, but it is a real lock and is named here so it is
planned rather than discovered.

Nothing destructive: no column dropped, no row deleted, no existing
quote changed.
"""

from __future__ import annotations

from django.db import migrations, models

# The `_DROP_*` statements are the reverse operations, so a rollback
# restores the pre-class constraints rather than leaving the tables
# unconstrained. Both re-add statements are the originals from
# 0002_version_fare_rules.py with one term added.
_ADD_FARE_RULE_EXCLUSION = """
    ALTER TABLE fares_farerule
      ADD CONSTRAINT no_overlapping_fare_rule_per_route
      EXCLUDE USING gist (
        route_id WITH =,
        trip_class WITH =,
        tstzrange(effective_from, effective_to) WITH &&
      )
      WHERE (deleted_at IS NULL);
"""

_ADD_FARE_RULE_EXCLUSION_WITHOUT_CLASS = """
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

_ADD_FARE_SEGMENT_EXCLUSION = """
    ALTER TABLE fares_faresegmentrule
      ADD CONSTRAINT no_overlapping_fare_segment_per_route
      EXCLUDE USING gist (
        route_id WITH =,
        from_stop_id WITH =,
        to_stop_id WITH =,
        trip_class WITH =,
        tstzrange(effective_from, effective_to) WITH &&
      )
      WHERE (deleted_at IS NULL);
"""

_ADD_FARE_SEGMENT_EXCLUSION_WITHOUT_CLASS = """
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

_TRIP_CLASS_CHOICES = [
    ("premium", "Premium"),
    ("exclusive", "Exclusive"),
    ("standard", "Standard"),
    ("mini", "Mini"),
]


class Migration(migrations.Migration):

    dependencies = [
        ("fares", "0003_alter_farerule_managers_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="farerule",
            name="trip_class",
            field=models.CharField(
                blank=True, choices=_TRIP_CLASS_CHOICES, default="", max_length=20
            ),
        ),
        migrations.AddField(
            model_name="faresegmentrule",
            name="trip_class",
            field=models.CharField(
                blank=True, choices=_TRIP_CLASS_CHOICES, default="", max_length=20
            ),
        ),
        migrations.RunSQL(_DROP_FARE_RULE_EXCLUSION, _ADD_FARE_RULE_EXCLUSION_WITHOUT_CLASS),
        migrations.RunSQL(_ADD_FARE_RULE_EXCLUSION, _DROP_FARE_RULE_EXCLUSION),
        migrations.RunSQL(_DROP_FARE_SEGMENT_EXCLUSION, _ADD_FARE_SEGMENT_EXCLUSION_WITHOUT_CLASS),
        migrations.RunSQL(_ADD_FARE_SEGMENT_EXCLUSION, _DROP_FARE_SEGMENT_EXCLUSION),
    ]
