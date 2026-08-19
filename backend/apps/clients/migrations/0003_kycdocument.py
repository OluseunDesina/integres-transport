import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models

from apps.core.migration_operations import EnableRowLevelSecurity


class Migration(migrations.Migration):

    dependencies = [
        ('clients', '0002_client_kyc_fields'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='KycDocument',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('deleted_at', models.DateTimeField(blank=True, null=True)),
                ('document_type', models.CharField(choices=[('certificate_of_incorporation', 'Certificate of incorporation'), ('proof_of_address', 'Proof of address'), ('directors_id', "Director's ID"), ('tax_certificate', 'Tax certificate'), ('other', 'Other')], max_length=40)),
                ('file', models.FileField(upload_to='kyc-documents/%Y/%m/')),
                ('status', models.CharField(choices=[('pending', 'Pending'), ('approved', 'Approved'), ('rejected', 'Rejected')], default='pending', max_length=20)),
                ('reviewed_at', models.DateTimeField(blank=True, null=True)),
                ('rejection_reason', models.TextField(blank=True)),
                ('client', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='+', to='clients.client')),
                ('reviewed_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['-created_at'],
                'abstract': False,
            },
        ),
        EnableRowLevelSecurity('KycDocument'),
    ]
