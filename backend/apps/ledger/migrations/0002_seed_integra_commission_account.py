"""Seeds the single platform-level `integra_commission` LedgerAccount
row (docs/adr/0006, docs/specs/5-payments-wallet-ledger.md).

RLS is enabled and FORCEd on `ledger_ledgeraccount` as of migration
0001, and a policy with no explicit WITH CHECK clause reuses its USING
expression for INSERT too (Postgres's own documented default) — so a
plain `apps.get_model(...).objects.create(...)` here would be rejected:
this migration's DB session never calls
`apps.core.rls.set_rls_session_vars`, so both `app.current_client_id`
and `app.is_platform_staff` read back NULL, and `NULL OR NULL` is not
TRUE. `set_rls_session_vars(None, is_platform_staff=True)` is called
directly (not the `platform_staff_bypass()` context manager, which
exists to restore a caller's *previous* RLS state afterward — there is
no prior state to restore inside a migration) before the insert, using
`set_config(..., true)` (`SET LOCAL` semantics), which stays in effect
for the rest of this transactional migration.
"""

from decimal import Decimal

from django.db import migrations

from apps.core.rls import set_rls_session_vars


def seed_commission_account(apps, schema_editor):
    set_rls_session_vars(None, is_platform_staff=True)
    LedgerAccount = apps.get_model("ledger", "LedgerAccount")
    LedgerAccount.objects.get_or_create(
        account_type="integra_commission",
        defaults={"client": None, "business": None, "cached_balance": Decimal("0.00")},
    )


def unseed_commission_account(apps, schema_editor):
    set_rls_session_vars(None, is_platform_staff=True)
    LedgerAccount = apps.get_model("ledger", "LedgerAccount")
    LedgerAccount.objects.filter(account_type="integra_commission").delete()


class Migration(migrations.Migration):

    dependencies = [
        ('ledger', '0001_initial'),
    ]

    operations = [
        migrations.RunPython(seed_commission_account, unseed_commission_account),
    ]
