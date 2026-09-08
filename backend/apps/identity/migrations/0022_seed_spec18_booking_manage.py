"""Seeds `booking.manage` (docs/specs/18-manifest-and-staff-booking.md
slice 2). Append-only, same convention as every prior phase's seed.

Granted to **Owner and Manager only**, unlike spec 17's incident
codenames which reached all three presets. Booking on someone else's
behalf creates a financial obligation for a person who is not in the
room when it is created; `booking.view` — which Staff hold, and which
the manifest is gated on — is not sufficient authority for that.

`0023` is what actually reaches roles that already exist: a seed
migration alone grants a codename to nobody.
"""

from django.db import migrations

PERMISSIONS = [
    ("booking.manage", "Book on a passenger's behalf, and resolve a passenger to book for"),
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
        ("identity", "0021_backfill_role_permissions"),
    ]

    operations = [
        migrations.RunPython(seed_permissions, unseed_permissions),
    ]
