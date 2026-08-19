"""Seeds Phase 4's fares permission codenames (see
docs/specs/4-fares-seating-booking.md §2). Own migration, per the
established append-only convention — seating.*/booking.view land in
their own migrations when those apps are built (Phase 4 slices 2-3).
"""

from django.db import migrations

PERMISSIONS = [
    ("fares.view", "View fare rules"),
    ("fares.manage", "Create/edit FareRule/FareSegmentRule"),
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
        ('identity', '0007_seed_phase3_scheduling_permissions'),
    ]

    operations = [
        migrations.RunPython(seed_permissions, unseed_permissions),
    ]
