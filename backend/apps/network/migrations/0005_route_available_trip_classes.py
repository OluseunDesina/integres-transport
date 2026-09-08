"""Which classes a route may offer — docs/specs/15-trip-classes.md.

Every existing Route lands on `[]`, which means **no restriction**, not
"no classes allowed". That is what keeps every already-scheduled service
valid after this runs.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('network', '0004_alter_stop_options_alter_route_managers_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='route',
            name='available_trip_classes',
            field=models.JSONField(blank=True, default=list),
        ),
    ]
