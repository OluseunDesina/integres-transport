import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models

from apps.core.migration_operations import EnableRowLevelSecurity


class Migration(migrations.Migration):

    dependencies = [
        ('identity', '0003_seed_permissions'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='StaffInvitation',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('deleted_at', models.DateTimeField(blank=True, null=True)),
                ('email', models.EmailField(max_length=254)),
                ('token', models.CharField(max_length=64, unique=True)),
                ('status', models.CharField(choices=[('pending', 'Pending'), ('accepted', 'Accepted'), ('revoked', 'Revoked'), ('expired', 'Expired')], default='pending', max_length=20)),
                ('expires_at', models.DateTimeField()),
                ('client', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='+', to='clients.client')),
                ('invited_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL)),
                ('role', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='+', to='identity.role')),
            ],
            options={
                'ordering': ['-created_at'],
                'abstract': False,
            },
        ),
        EnableRowLevelSecurity('StaffInvitation'),
    ]
