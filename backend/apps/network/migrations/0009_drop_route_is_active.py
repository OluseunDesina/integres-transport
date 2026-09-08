"""Drops `network_route.is_active` — docs/specs/19-route-lifecycle.md.

**Destructive. Per this repo's standing rule, this step must not be run
against a real (dev, staging or production) database without explicit
approval** — see CLAUDE.md's rule on destructive migrations and the
spec's own "Migration impact" section.

0006-0008 already leave the system fully working with both columns
present and every read site swept over to `status` (apps.network.views,
apps.network.serializers) — there is no pressure to run this in the
same deployment as the rest, and nothing in application code depends on
it having run. It exists mainly so the schema does not carry a column
nothing reads forever, and so `makemigrations` has nothing left pending
once it does run.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("network", "0008_enforce_route_status_not_null"),
    ]

    operations = [
        migrations.RemoveField(
            model_name="route",
            name="is_active",
        ),
    ]
