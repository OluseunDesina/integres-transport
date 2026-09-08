"""Additive half of the Route lifecycle — docs/specs/19-route-lifecycle.md.

`status` lands `null=True` here even though the model declares it
`default=Status.DRAFT` with no `null=True`: adding it this way leaves
every pre-existing row `NULL` rather than silently `draft`, so the
0007 backfill can tell "not yet migrated" apart from "genuinely meant
to be draft" and 0008 can assert nothing was missed before enforcing
`NOT NULL`. `distance_km`/`estimated_duration_minutes` are genuinely
optional forever, so they stay nullable.

`is_active` is relaxed to nullable here, and **this part is not
optional to defer** — found live, not in a test. Application code stops
writing it the moment this migration set lands (`Route.objects.create()`
never sets it, since it is gone from the model), but the column was
`NOT NULL` since 0001. On a database that already has rows — i.e. every
one that isn't a fresh test database created from every migration
including 0009's drop — a plain `INSERT` on a brand new Route then fails
`IntegrityError: null value in column "is_active" violates not-null
constraint` the instant this migration lands and 0009 has not, which
per this repo's own rule can be indefinitely: "no pressure to run step 4
in the same deployment as the rest." That claim is only true once this
column can hold `NULL` in the meantime.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("network", "0005_route_available_trip_classes"),
    ]

    operations = [
        migrations.AddField(
            model_name="route",
            name="distance_km",
            field=models.DecimalField(blank=True, decimal_places=2, max_digits=7, null=True),
        ),
        migrations.AddField(
            model_name="route",
            name="estimated_duration_minutes",
            field=models.PositiveIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="route",
            name="status",
            field=models.CharField(
                choices=[
                    ("draft", "Draft"),
                    ("active", "Active"),
                    ("inactive", "Inactive"),
                    ("archived", "Archived"),
                ],
                max_length=20,
                null=True,
            ),
        ),
        migrations.AlterField(
            model_name="route",
            name="is_active",
            field=models.BooleanField(null=True),
        ),
    ]
