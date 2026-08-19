import django.db.models.deletion
import uuid
from django.db import migrations, models

from apps.core.migration_operations import EnableRowLevelSecurity


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ('businesses', '0003_business_fare_pricing_mode'),
        ('clients', '0004_whitelabel_clientinvitation'),
        ('network', '0003_route_ordering'),
    ]

    operations = [
        migrations.CreateModel(
            name='FareRule',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('deleted_at', models.DateTimeField(blank=True, null=True)),
                ('amount', models.DecimalField(decimal_places=2, max_digits=10)),
                ('is_active', models.BooleanField(default=True)),
                ('business', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='+', to='businesses.business')),
                ('client', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='+', to='clients.client')),
                ('route', models.OneToOneField(on_delete=django.db.models.deletion.PROTECT, related_name='+', to='network.route')),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
        migrations.CreateModel(
            name='FareSegmentRule',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('deleted_at', models.DateTimeField(blank=True, null=True)),
                ('amount', models.DecimalField(decimal_places=2, max_digits=10)),
                ('business', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='+', to='businesses.business')),
                ('client', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='+', to='clients.client')),
                ('route', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='+', to='network.route')),
                ('from_stop', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='+', to='network.stop')),
                ('to_stop', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='+', to='network.stop')),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
        migrations.AddConstraint(
            model_name='faresegmentrule',
            constraint=models.UniqueConstraint(fields=('route', 'from_stop', 'to_stop'), name='unique_fare_segment_per_route'),
        ),
        EnableRowLevelSecurity('FareRule'),
        EnableRowLevelSecurity('FareSegmentRule'),
    ]
