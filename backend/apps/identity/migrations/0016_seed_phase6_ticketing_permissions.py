"""Seeds the Phase 6 Slice 2 permission codename (see
docs/specs/6-ticketing.md). Append-only, same convention as every
prior phase's seed migration."""

from django.db import migrations

PERMISSIONS = [
    ("ticketing.validate", "Validate a ticket via the QR scan/validator flow"),
]


def seed_permissions(apps, schema_editor):
    Permission = apps.get_model("identity", "Permission")
    for codename, description in PERMISSIONS:
        Permission.objects.get_or_create(codename=codename, defaults={"description": description})


def unseed_permissions(apps, schema_editor):
    Permission = apps.get_model("identity", "Permission")
    Permission.objects.filter(codename__in=[codename for codename, _ in PERMISSIONS]).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('identity', '0015_alter_role_options_alter_user_options'),
    ]

    operations = [
        migrations.RunPython(seed_permissions, unseed_permissions),
    ]
