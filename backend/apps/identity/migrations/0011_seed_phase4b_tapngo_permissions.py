"""Seeds the Phase 4b permission codenames (see
docs/specs/4b-tap-and-go.md). Append-only, same convention as every
prior phase's seed migration."""

from django.db import migrations

PERMISSIONS = [
    ("tapngo.record", "Record board/alight taps via the tap-and-go validator harness"),
    ("tapngo.view", "View tap-and-go fare journeys"),
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
        ('identity', '0010_seed_phase4_booking_permission'),
    ]

    operations = [
        migrations.RunPython(seed_permissions, unseed_permissions),
    ]
