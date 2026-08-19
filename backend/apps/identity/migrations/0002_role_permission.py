import uuid

import django.db.models.deletion
from django.db import migrations, models

from apps.core.migration_operations import EnableRowLevelSecurity


class Migration(migrations.Migration):

    dependencies = [
        ('clients', '0003_kycdocument'),
        ('identity', '0001_initial'),
    ]

    operations = [
        migrations.CreateModel(
            name='Permission',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('codename', models.CharField(max_length=100, unique=True)),
                ('description', models.CharField(blank=True, max_length=255)),
            ],
            options={
                'ordering': ['codename'],
            },
        ),
        migrations.CreateModel(
            name='Role',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('deleted_at', models.DateTimeField(blank=True, null=True)),
                ('name', models.CharField(max_length=100)),
                ('is_default_owner_role', models.BooleanField(default=False)),
                ('client', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='+', to='clients.client')),
                ('permissions', models.ManyToManyField(blank=True, related_name='+', to='identity.permission')),
            ],
        ),
        migrations.AddConstraint(
            model_name='role',
            constraint=models.UniqueConstraint(fields=('client', 'name'), name='unique_role_name_per_client'),
        ),
        EnableRowLevelSecurity('Role'),
        migrations.AddField(
            model_name='user',
            name='role',
            field=models.ForeignKey(blank=True, help_text='Set for is_client_staff=True users. Irrelevant for passengers and platform staff.', null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to='identity.role'),
        ),
    ]
