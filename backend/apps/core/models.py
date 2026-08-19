"""Tenancy base classes.

Every tenant-owned model inherits `BaseModel` and is filtered by the
active-client context (see `apps.core.context`) through the *default*
manager — there is no unscoped-by-default manager. `all_objects` is the
one explicit, grep-able escape hatch for genuinely cross-client code
(e.g. super-admin views). See docs/adr/0002-tenancy-enforcement.md.
"""

import uuid

from django.core.serializers.json import DjangoJSONEncoder
from django.db import models
from django.utils import timezone

from apps.core.context import get_current_client_id


class TenantScopedQuerySet(models.QuerySet):
    def _scoped_to_current_client(self) -> "TenantScopedQuerySet":
        client_id = get_current_client_id()
        if client_id is None:
            # No active-client context (anonymous request, or a
            # legitimately client-less platform-staff token — see
            # docs/adr/0003). Either way, the scoped manager must never
            # guess; it returns nothing. Cross-client code must opt in
            # explicitly via `Model.all_objects`.
            return self.none()
        return self.filter(client_id=client_id)

    def excluding_soft_deleted(self) -> "TenantScopedQuerySet":
        return self.filter(deleted_at__isnull=True)


class TenantScopedManager(models.Manager):
    """Default manager on every `BaseModel` subclass."""

    def get_queryset(self) -> TenantScopedQuerySet:
        qs: TenantScopedQuerySet = TenantScopedQuerySet(self.model, using=self._db)
        return qs._scoped_to_current_client().excluding_soft_deleted()


class AllObjectsManager(models.Manager):
    """Explicit, unscoped manager. Every use of `Model.all_objects` is a
    deliberate cross-client operation and is grep-able by name — this is
    the sanctioned bypass, not a forgotten filter."""

    def get_queryset(self) -> TenantScopedQuerySet:
        return TenantScopedQuerySet(self.model, using=self._db)


class BaseModel(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    client = models.ForeignKey(
        "clients.Client",
        on_delete=models.PROTECT,
        related_name="+",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    deleted_at = models.DateTimeField(null=True, blank=True)

    objects = TenantScopedManager()
    all_objects = AllObjectsManager()

    class Meta:
        abstract = True
        ordering = ["-created_at"]
        # `Model.save(update_fields=...)` doesn't perform its UPDATE
        # through whichever manager originally fetched the instance —
        # it always goes through `_base_manager`, which Django defaults
        # to the *first* manager declared on the model (`objects`,
        # `TenantScopedManager`, here). Without this override, calling
        # `.save()` on an instance fetched via `Model.all_objects...`
        # while no tenant context is active (`platform_staff_bypass()`,
        # a webhook, a Celery task) silently targets zero rows — Django
        # 6's own `save(update_fields=...)` now raises `NotUpdated` when
        # that happens, which is exactly what caught this, live, in
        # Phase 5 Slice 2's webhook handler (docs/specs/5-payments-wallet-ledger.md).
        # `all_objects` has no filtering to work around in the first
        # place, so making it the base manager is strictly safe for
        # every already-working save() call too — it only removes a
        # filter, never adds one.
        base_manager_name = "all_objects"

    def soft_delete(self) -> None:
        self.deleted_at = timezone.now()
        self.save(update_fields=["deleted_at"])


class IdempotencyKey(models.Model):
    """Generic idempotency-key record, reusable by any payment- or
    booking-mutating endpoint from Phase 4 onward (see the Phase 0 plan's
    architecture-level decisions). Phase 0 only creates the model; no
    endpoint uses it yet.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    client_id = models.UUIDField(null=True, blank=True, db_index=True)
    endpoint = models.CharField(max_length=255)
    key = models.CharField(max_length=255)
    request_hash = models.CharField(max_length=64, blank=True)
    response_status = models.PositiveIntegerField(null=True, blank=True)
    response_body = models.JSONField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["client_id", "endpoint", "key"],
                name="unique_idempotency_key_per_client_endpoint",
            )
        ]

    def __str__(self) -> str:
        return f"{self.endpoint}:{self.key}"


class AuditLog(models.Model):
    """Immutable, append-only privileged/money-moving action record.

    Not a `BaseModel` subclass: audit records must remain readable across
    clients by platform staff, and must be writable even when no active
    client context exists (e.g. a platform-staff action). `client_id` is
    a plain field, not an enforced FK, deliberately — see `save`/`delete`
    below for the append-only guarantee.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    client_id = models.UUIDField(null=True, blank=True, db_index=True)
    actor = models.ForeignKey(
        "identity.User",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
    )
    action = models.CharField(max_length=255)
    target_type = models.CharField(max_length=255, blank=True)
    target_id = models.CharField(max_length=255, blank=True)
    # DjangoJSONEncoder, not the plain json default — record_audit_event()
    # forwards a service function's **fields straight into this column,
    # and those routinely include date/time/Decimal/UUID values (e.g.
    # Schedule.departure_time, Vehicle.insurance_expires_at) that the
    # stdlib json encoder can't serialize on its own.
    metadata = models.JSONField(default=dict, blank=True, encoder=DjangoJSONEncoder)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.action} on {self.target_type}:{self.target_id}"

    def save(self, *args: object, **kwargs: object) -> None:
        if self.pk and AuditLog.objects.filter(pk=self.pk).exists():
            raise ValueError("AuditLog records are append-only and cannot be updated.")
        super().save(*args, **kwargs)  # type: ignore[arg-type]

    def delete(self, *args: object, **kwargs: object) -> tuple[int, dict[str, int]]:
        raise ValueError("AuditLog records are append-only and cannot be deleted.")
