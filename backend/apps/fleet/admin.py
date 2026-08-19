"""Deliberately no admin registrations.

VehicleType/Vehicle/Driver are RLS-protected (apps.core.migration_operations
.EnableRowLevelSecurity). Django admin sessions authenticate via cookies,
not the JWT apps.core.middleware.TenancyMiddleware reads, so an admin
request resolves as anonymous and RLS would show an always-empty list —
same gap already documented for apps.clients.KycDocument and
apps.network's models in CLAUDE.md.
"""
