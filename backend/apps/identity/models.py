"""Custom User model.

Per docs/adr/0003: one User model for every audience (passengers, client
staff, platform staff). `client` is nullable — populated for tenant-scoped
users, `NULL` for platform staff — and is the one deliberate exception to
"every tenant-owned row carries client_id" (User does not inherit
`apps.core.models.BaseModel`; it manages its own tenancy-adjacent fields
directly because its manager/queryset semantics differ from every other
tenant-owned model — auth lookups must work *before* a client context is
known, not be scoped by one).

Uniqueness is deliberately NOT global on `email`: a passenger belongs to
one Client, so the same email may exist independently under two different
Clients (locked decision in the brief). Platform staff have no Client, so
their email must be globally unique among platform staff instead.
"""

import uuid
from typing import ClassVar

from django.contrib.auth.base_user import AbstractBaseUser, BaseUserManager
from django.contrib.auth.models import PermissionsMixin
from django.db import models
from django.db.models import Q

from apps.core.models import BaseModel


class UserManager(BaseUserManager["User"]):
    use_in_migrations = True

    def _create_user(self, email: str, password: str | None, **extra_fields: object) -> "User":
        if not email:
            raise ValueError("Users must have an email address.")
        email = self.normalize_email(email)
        user = self.model(email=email, **extra_fields)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_user(
        self, email: str, password: str | None = None, **extra_fields: object
    ) -> "User":
        extra_fields.setdefault("is_platform_staff", False)
        extra_fields.setdefault("is_staff", False)
        extra_fields.setdefault("is_superuser", False)
        return self._create_user(email, password, **extra_fields)

    def create_superuser(
        self, email: str, password: str | None = None, **extra_fields: object
    ) -> "User":
        extra_fields.setdefault("is_platform_staff", True)
        extra_fields.setdefault("is_staff", True)
        extra_fields.setdefault("is_superuser", True)
        if extra_fields.get("is_staff") is not True:
            raise ValueError("Superuser must have is_staff=True.")
        if extra_fields.get("is_superuser") is not True:
            raise ValueError("Superuser must have is_superuser=True.")
        return self._create_user(email, password, **extra_fields)


class User(AbstractBaseUser, PermissionsMixin):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    client = models.ForeignKey(
        "clients.Client",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="users",
        help_text="NULL for platform staff. Set for tenant-scoped staff and passengers.",
    )
    is_platform_staff = models.BooleanField(default=False)
    is_client_staff = models.BooleanField(
        default=False,
        help_text=(
            "Only meaningful when `client` is set: True routes this user to the "
            "client-admin app, False to the customer (passenger) app. Coarse "
            "Phase 0 split — full RBAC roles land in Phase 1."
        ),
    )

    email = models.EmailField()
    first_name = models.CharField(max_length=150, blank=True)
    last_name = models.CharField(max_length=150, blank=True)

    is_active = models.BooleanField(default=True)
    is_staff = models.BooleanField(
        default=False, help_text="Django admin site access, distinct from is_client_staff."
    )
    date_joined = models.DateTimeField(auto_now_add=True)

    role = models.ForeignKey(
        "identity.Role",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
        help_text=(
            "Set for is_client_staff=True users. Irrelevant for passengers and platform staff."
        ),
    )

    objects = UserManager()

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS: ClassVar[list[str]] = []

    class Meta:
        # `AbstractBaseUser`/`PermissionsMixin` gives no default ordering
        # to inherit (unlike a `BaseModel` subclass, which would get
        # `-created_at` for free) — without this, `StaffListView`'s
        # `LimitOffsetPagination` has no stable `ORDER BY`, the same
        # class of bug `Route.Meta`'s own comment documents.
        ordering = ["email"]
        constraints = [
            models.UniqueConstraint(
                fields=["client", "email"],
                condition=Q(client__isnull=False),
                name="unique_email_per_client",
            ),
            models.UniqueConstraint(
                fields=["email"],
                condition=Q(client__isnull=True),
                name="unique_email_for_platform_staff",
            ),
        ]

    def __str__(self) -> str:
        return self.email

    @property
    def app_audience(self) -> str:
        from django.conf import settings

        if self.is_platform_staff:
            return settings.JWT_AUDIENCE_SUPER_ADMIN
        if self.is_client_staff:
            return settings.JWT_AUDIENCE_CLIENT_ADMIN
        return settings.JWT_AUDIENCE_CUSTOMER


class Permission(models.Model):
    """Platform-wide, not tenant-owned — deliberately NOT a `BaseModel`
    subclass, no `client` field, no RLS. Append-only by convention: every
    future phase adds its own codenames as it ships features that need
    gating, never redesigns this table. Seeded by a data migration, not a
    management command — see docs/specs/1-identity-client-business.md §2.
    """

    codename = models.CharField(max_length=100, unique=True)
    description = models.CharField(max_length=255, blank=True)

    class Meta:
        ordering = ["codename"]

    def __str__(self) -> str:
        return self.codename


class Role(BaseModel):
    """Three rows auto-created per Client at registration
    (`apps.identity.services.create_default_roles`) — Owner (all
    permissions), Manager, Staff. Not user-editable in Phase 1 (§1
    non-goal: custom/editable roles are a later feature)."""

    name = models.CharField(max_length=100)
    permissions = models.ManyToManyField(Permission, related_name="+", blank=True)
    is_default_owner_role = models.BooleanField(default=False)

    class Meta:
        # Declaring a bare `class Meta:` here (for `constraints`) drops
        # `BaseModel.Meta`'s inherited `-created_at` ordering entirely —
        # Django only inherits an abstract base's Meta options when the
        # subclass declares no Meta of its own (see `Route.Meta`'s own
        # comment for the same trap). Ordered by `name`, not
        # `-created_at`, matching `Permission.Meta`'s own
        # `ordering = ["codename"]` — a small, stable, non-time-relevant
        # set reads better alphabetically than newest-first.
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(fields=["client", "name"], name="unique_role_name_per_client")
        ]

    def __str__(self) -> str:
        return self.name


class StaffInvitation(BaseModel):
    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        ACCEPTED = "accepted", "Accepted"
        REVOKED = "revoked", "Revoked"
        EXPIRED = "expired", "Expired"

    email = models.EmailField()
    role = models.ForeignKey(Role, on_delete=models.PROTECT, related_name="+")
    invited_by = models.ForeignKey(
        "identity.User", on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    token = models.CharField(max_length=64, unique=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING)
    expires_at = models.DateTimeField()

    def __str__(self) -> str:
        return f"{self.email} ({self.status})"
