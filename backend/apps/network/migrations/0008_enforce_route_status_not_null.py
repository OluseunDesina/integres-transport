"""Enforces `NOT NULL` on `status`, with the real default going forward
— docs/specs/19-route-lifecycle.md. Safe only because 0007 already
backfilled every existing row; a `default` alone does not touch rows
that predate it.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("network", "0007_backfill_route_status"),
    ]

    operations = [
        migrations.AlterField(
            model_name="route",
            name="status",
            field=models.CharField(
                choices=[
                    ("draft", "Draft"),
                    ("active", "Active"),
                    ("inactive", "Inactive"),
                    ("archived", "Archived"),
                ],
                default="draft",
                max_length=20,
            ),
        ),
    ]
