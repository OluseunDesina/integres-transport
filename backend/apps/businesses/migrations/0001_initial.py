import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models

from apps.core.migration_operations import EnableRowLevelSecurity


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ('clients', '0003_kycdocument'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='Business',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('deleted_at', models.DateTimeField(blank=True, null=True)),
                ('vertical', models.CharField(choices=[('shuttle', 'Shuttle'), ('intercity', 'Intercity'), ('metro', 'Metro')], max_length=20)),
                ('name', models.CharField(max_length=255)),
                ('currency', models.CharField(max_length=8)),
                ('timezone', models.CharField(max_length=64)),
                ('booking_mode_default', models.CharField(choices=[('reservation', 'Reservation'), ('tap_and_go', 'Tap and go')], max_length=20)),
                ('is_active', models.BooleanField(default=True)),
                ('kyb_status', models.CharField(choices=[('pending', 'Pending'), ('submitted', 'Submitted'), ('approved', 'Approved'), ('rejected', 'Rejected')], default='pending', max_length=20)),
                ('kyb_submitted_at', models.DateTimeField(blank=True, null=True)),
                ('kyb_decided_at', models.DateTimeField(blank=True, null=True)),
                ('kyb_rejection_reason', models.TextField(blank=True)),
                ('client', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='+', to='clients.client')),
                ('kyb_decided_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['-created_at'],
                'abstract': False,
            },
        ),
        EnableRowLevelSecurity('Business'),
    ]
