from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('businesses', '0002_kybdocument'),
    ]

    operations = [
        migrations.AddField(
            model_name='business',
            name='fare_pricing_mode',
            field=models.CharField(
                choices=[('flat', 'Flat'), ('per_segment', 'Per segment')],
                default='flat',
                max_length=20,
            ),
        ),
    ]
