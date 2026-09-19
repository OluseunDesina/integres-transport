"""Seeds the single `is_marketplace=True` Client row (docs/adr/0009,
docs/specs/22-marketplace.md) that every marketplace-registered
passenger's `User.client` points at.

`Client` carries no RLS (it *is* the tenant, per its own docstring), so
unlike `apps.ledger`'s `0002_seed_integra_commission_account` this needs
none of the `set_rls_session_vars` handling — a plain `get_or_create` is
enough.
"""

from django.db import migrations


def seed_marketplace_client(apps, schema_editor):
    Client = apps.get_model("clients", "Client")
    Client.objects.get_or_create(
        is_marketplace=True, defaults={"name": "TransitOS Marketplace"}
    )


def unseed_marketplace_client(apps, schema_editor):
    Client = apps.get_model("clients", "Client")
    Client.objects.filter(is_marketplace=True).delete()


class Migration(migrations.Migration):

    dependencies = [
        ("clients", "0006_is_marketplace"),
    ]

    operations = [
        migrations.RunPython(seed_marketplace_client, unseed_marketplace_client),
    ]
