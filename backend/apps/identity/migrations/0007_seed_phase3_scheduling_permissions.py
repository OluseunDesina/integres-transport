"""Seeds Phase 3's scheduling permission codenames (see
docs/specs/3-network-scheduling-fleet.md §2). Own migration, per the
established append-only convention — 0003_seed_permissions.py (Phase 1),
0005_seed_phase3_network_permissions.py, and
0006_seed_phase3_fleet_permissions.py (Phase 3 Slices 1-2) stay
untouched.
"""

from django.db import migrations

PERMISSIONS = [
    ("scheduling.view", "View Schedules and Trips"),
    (
        "scheduling.manage",
        "Create/edit Schedules, create manual Trips, assign vehicle/driver, transition Trip status",
    ),
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
        ('identity', '0006_seed_phase3_fleet_permissions'),
    ]

    operations = [
        migrations.RunPython(seed_permissions, unseed_permissions),
    ]
