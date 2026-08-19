"""Seeds Phase 3's fleet permission codenames (see
docs/specs/3-network-scheduling-fleet.md §2). Own migration, per the
established append-only convention — 0003_seed_permissions.py (Phase 1)
and 0005_seed_phase3_network_permissions.py (Phase 3 Slice 1) stay
untouched. scheduling.* codenames land in their own migration when that
app is built (Phase 3 Slice 3).
"""

from django.db import migrations

PERMISSIONS = [
    ("fleet.view", "View Vehicle Types, Vehicles, and Drivers"),
    ("fleet.manage", "Create/edit Vehicle Types, Vehicles, and Drivers"),
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
        ('identity', '0005_seed_phase3_network_permissions'),
    ]

    operations = [
        migrations.RunPython(seed_permissions, unseed_permissions),
    ]
