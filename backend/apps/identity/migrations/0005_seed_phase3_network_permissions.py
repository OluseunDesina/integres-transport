"""Seeds Phase 3's network permission codenames (see
docs/specs/3-network-scheduling-fleet.md §2). Own migration, per the
established append-only convention — 0003_seed_permissions.py (Phase 1)
stays untouched. fleet.*/scheduling.* codenames land in their own
migrations when those apps are built (Phase 3 slices 2-3).
"""

from django.db import migrations

PERMISSIONS = [
    ("network.view", "View Routes and Stops"),
    ("network.manage", "Create/edit Routes and Stops, reorder Route<->Stop"),
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
        ('identity', '0004_staffinvitation'),
    ]

    operations = [
        migrations.RunPython(seed_permissions, unseed_permissions),
    ]
