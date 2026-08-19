"""Seeds the Phase 5 Slice 2 permission codenames (see
docs/specs/5-payments-wallet-ledger.md). Append-only, same convention as
every prior phase's seed migration."""

from django.db import migrations

PERMISSIONS = [
    ("payments.view", "View a Business's PaymentIntents"),
    ("wallet.view", "View a passenger's wallet balance and transactions for support/disputes"),
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
        ('identity', '0012_seed_phase5_ledger_permissions'),
    ]

    operations = [
        migrations.RunPython(seed_permissions, unseed_permissions),
    ]
