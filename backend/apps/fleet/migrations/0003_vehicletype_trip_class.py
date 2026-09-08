"""What class of service a vehicle type runs —
docs/specs/15-trip-classes.md.

No backfill step: `ADD COLUMN ... DEFAULT 'standard'` is catalog-only on
Postgres 11+, so every existing VehicleType reads as `standard` — the
class each one already implicitly was — without a table rewrite.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('fleet', '0002_alter_driver_managers_alter_vehicle_managers_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='vehicletype',
            name='trip_class',
            field=models.CharField(choices=[('premium', 'Premium'), ('exclusive', 'Exclusive'), ('standard', 'Standard'), ('mini', 'Mini')], default='standard', max_length=20),
        ),
    ]
