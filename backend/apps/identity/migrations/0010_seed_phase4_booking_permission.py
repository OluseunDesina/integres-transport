"""Seeds Phase 4's last permission codename (see
docs/specs/4-fares-seating-booking.md §2). Own migration, per the
established append-only convention.
"""

from django.db import migrations

PERMISSIONS = [
    ("booking.view", "Client-admin staff: view Bookings made against their Business"),
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
        ('identity', '0009_seed_phase4_seating_permissions'),
    ]

    operations = [
        migrations.RunPython(seed_permissions, unseed_permissions),
    ]
