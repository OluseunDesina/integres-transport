from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('businesses', '0003_business_fare_pricing_mode'),
    ]

    operations = [
        migrations.AddField(
            model_name='business',
            name='seat_hold_minutes',
            field=models.PositiveIntegerField(default=15),
        ),
    ]
