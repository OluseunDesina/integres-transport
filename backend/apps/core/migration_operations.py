"""Reusable migration operation for Postgres Row-Level Security.

Every concrete `apps.core.models.BaseModel` subclass's first migration must
include `EnableRowLevelSecurity(model_name)` — see
docs/specs/1-identity-client-business.md §3 and docs/adr/0002. This is a
DB-only policy: it doesn't change Django's model state, so `state_forwards`
is a no-op and this operation is safe to place anywhere after the model's
`CreateModel`.
"""

from django.db.backends.base.schema import BaseDatabaseSchemaEditor
from django.db.migrations.operations.base import Operation
from django.db.migrations.state import ProjectState

_POLICY_SQL = """
    CREATE POLICY tenant_isolation ON "{table}"
    USING (
        client_id = NULLIF(current_setting('app.current_client_id', true), '')::uuid
        OR current_setting('app.is_platform_staff', true) = 'true'
    );
"""
# Two non-obvious Postgres behaviours forced the NULLIF: (1) Postgres does
# NOT guarantee short-circuit evaluation of OR — a cast error on the left
# operand still raises even when the right operand alone would make the
# whole expression true (this is documented Postgres behaviour, not a
# bug: "the order of evaluation of subexpressions is not defined"). (2)
# `set_config(name, NULL, true)` on a custom/placeholder GUC that was
# never declared elsewhere does not make `current_setting` return SQL
# NULL — it returns an empty string. Casting '' straight to ::uuid raises
# `invalid input syntax for type uuid`, which — combined with (1) — broke
# every anonymous/platform-staff request. `NULLIF(..., '')` normalizes
# the empty-string case to a real NULL first, so the cast always sees
# either a valid UUID string or NULL (never ''), and NULL = anything is
# just NULL (excludes the row), not an error.

# ENABLE ROW LEVEL SECURITY alone does NOT apply the policy to the table's
# *owner* — and the app's DB role is the table owner (it ran the CREATE
# TABLE migration). Without FORCE, every query issued by the app itself
# would silently ignore the policy entirely, RLS would look enabled in
# pg_class/pg_policies, and the completeness test would pass while the
# actual isolation guarantee was a no-op. FORCE closes exactly that gap.
_FORCE_SQL = 'ALTER TABLE "{table}" FORCE ROW LEVEL SECURITY;'


class EnableRowLevelSecurity(Operation):
    reversible = True

    def __init__(self, model_name: str) -> None:
        self.model_name = model_name

    def state_forwards(self, app_label: str, state: ProjectState) -> None:
        pass

    def database_forwards(
        self,
        app_label: str,
        schema_editor: BaseDatabaseSchemaEditor,
        from_state: ProjectState,
        to_state: ProjectState,
    ) -> None:
        model = to_state.apps.get_model(app_label, self.model_name)
        table = model._meta.db_table
        schema_editor.execute(f'ALTER TABLE "{table}" ENABLE ROW LEVEL SECURITY;')
        schema_editor.execute(_FORCE_SQL.format(table=table))
        schema_editor.execute(_POLICY_SQL.format(table=table))

    def database_backwards(
        self,
        app_label: str,
        schema_editor: BaseDatabaseSchemaEditor,
        from_state: ProjectState,
        to_state: ProjectState,
    ) -> None:
        model = from_state.apps.get_model(app_label, self.model_name)
        table = model._meta.db_table
        schema_editor.execute(f'DROP POLICY IF EXISTS tenant_isolation ON "{table}";')
        schema_editor.execute(f'ALTER TABLE "{table}" DISABLE ROW LEVEL SECURITY;')

    def describe(self) -> str:
        return f"Enable row-level security (tenant_isolation policy) on {self.model_name}"

    @property
    def migration_name_fragment(self) -> str:
        return f"enable_rls_{self.model_name.lower()}"
