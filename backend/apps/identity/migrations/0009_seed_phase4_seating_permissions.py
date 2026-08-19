"""Seeds Phase 4's seating permission codenames (see
docs/specs/4-fares-seating-booking.md §2). Own migration, per the
established append-only convention — booking.view lands in its own
migration when apps/booking's creation/cancellation flow is built
(Phase 4 Slice 3).
"""

from django.db import migrations

PERMISSIONS = [
    ("seating.view", "View seat layouts"),
    ("seating.manage", "Create/edit Seat rows for a VehicleType"),
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
        ('identity', '0008_seed_phase4_fares_permissions'),
    ]

    operations = [
        migrations.RunPython(seed_permissions, unseed_permissions),
    ]
