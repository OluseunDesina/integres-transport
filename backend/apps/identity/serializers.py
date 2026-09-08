"""Audience-scoped JWT issuance.

Three token-obtain serializers, one per frontend app, each stamping a
distinct `aud` claim. `client_id` and `is_platform_staff` are embedded as
custom claims so `apps.core.middleware.TenancyMiddleware` can resolve
tenancy without a database round-trip per request.

These deliberately do NOT use DRF SimpleJWT's default
`TokenObtainPairSerializer.validate()` / Django's `ModelBackend`, because
both do a *global* `get_by_natural_key(email)` lookup — which breaks by
design here, since the brief requires the same email to exist
independently under two different Clients. Login is scoped: an optional
`client` field disambiguates when more than one account shares an email;
if omitted and the email is unique across matching accounts, login still
succeeds (the common case while Phase 1's subdomain-based Client
resolution doesn't exist yet — see docs/adr/0002's note on this being a
Phase 1 follow-up, not a Phase 0 build item).

Access control is the candidate queryset itself (`_candidate_queryset`,
scoped by role/audience) — a user of the wrong role is simply not a
candidate, indistinguishable from "no such account." There is
deliberately no separate "you exist but can't sign in here" error path:
that would leak account existence across audiences, and would in any
case be unreachable dead code, since any candidate the queryset returns
is by construction already the right role.
"""

from typing import Any, ClassVar

from django.conf import settings
from django.contrib.auth.password_validation import validate_password as django_validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db.models import QuerySet
from rest_framework import serializers
from rest_framework_simplejwt.tokens import RefreshToken

from apps.identity.models import Role, StaffInvitation, User

_GENERIC_AUTH_ERROR = "No active account found with the given credentials."
_AMBIGUOUS_CLIENT_ERROR = (
    "Multiple accounts use this email across different clients; specify `client`."
)


class AudienceScopedTokenObtainSerializer(serializers.Serializer):
    audience: ClassVar[str] = ""

    email = serializers.EmailField()
    password = serializers.CharField(write_only=True, trim_whitespace=False)

    def _candidate_queryset(self, attrs: dict[str, Any]) -> QuerySet[User]:
        raise NotImplementedError

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        email = attrs["email"]
        password = attrs["password"]

        candidates = list(self._candidate_queryset(attrs).filter(email__iexact=email))
        if len(candidates) > 1:
            raise serializers.ValidationError(
                {"detail": _AMBIGUOUS_CLIENT_ERROR}, code="ambiguous_client"
            )

        user = candidates[0] if candidates else None
        if user is None or not user.check_password(password) or not user.is_active:
            raise serializers.ValidationError({"detail": _GENERIC_AUTH_ERROR}, code="authorization")

        refresh = self.get_token(user)
        return {"refresh": str(refresh), "access": str(refresh.access_token)}

    @classmethod
    def get_token(cls, user: User) -> RefreshToken:
        token = RefreshToken.for_user(user)
        token["aud"] = cls.audience
        token["client_id"] = str(user.client_id) if user.client_id else None
        token["is_platform_staff"] = user.is_platform_staff
        return token


class _TenantScopedTokenObtainSerializer(AudienceScopedTokenObtainSerializer):
    """Shared base for the customer and client-admin serializers, which
    both need optional client disambiguation."""

    client = serializers.UUIDField(required=False)

    def _candidate_queryset(self, attrs: dict[str, Any]) -> QuerySet[User]:
        qs = self._role_queryset()
        client_id = attrs.get("client")
        if client_id:
            qs = qs.filter(client_id=client_id)
        return qs

    def _role_queryset(self) -> QuerySet[User]:
        raise NotImplementedError


class CustomerTokenObtainSerializer(_TenantScopedTokenObtainSerializer):
    audience = settings.JWT_AUDIENCE_CUSTOMER

    def _role_queryset(self) -> QuerySet[User]:
        return User.objects.filter(
            client__isnull=False, is_client_staff=False, is_platform_staff=False
        )


class ClientAdminTokenObtainSerializer(_TenantScopedTokenObtainSerializer):
    audience = settings.JWT_AUDIENCE_CLIENT_ADMIN

    def _role_queryset(self) -> QuerySet[User]:
        return User.objects.filter(
            client__isnull=False, is_client_staff=True, is_platform_staff=False
        )


class SuperAdminTokenObtainSerializer(AudienceScopedTokenObtainSerializer):
    audience = settings.JWT_AUDIENCE_SUPER_ADMIN

    def _candidate_queryset(self, attrs: dict[str, Any]) -> QuerySet[User]:
        # Platform staff are always client-less, and unique on email
        # globally by constraint (see apps.identity.models.User.Meta) —
        # no disambiguation ever needed.
        return User.objects.filter(client__isnull=True, is_platform_staff=True)


class TokenObtainResponseSerializer(serializers.Serializer):
    """Documents the actual response shape of the three token-obtain
    endpoints for drf-spectacular. `AudienceScopedTokenObtainSerializer`
    itself only describes the *request* fields (email/password/client),
    so without this, the generated OpenAPI schema — and the TS types
    generated from it — would incorrectly describe the response as an
    echo of the request instead of `{access, refresh}`."""

    access = serializers.CharField()
    refresh = serializers.CharField()


class MeSerializer(serializers.ModelSerializer[User]):
    """`permissions` is additive to the Phase 0 contract (§4) — passengers
    get `["customer:access"]`, platform staff get `["super-admin:access"]`,
    client staff get `["client-admin:access", *role.permissions.codenames]`.
    `role_name`/`client_name` are additive too (NavShell profile menu) —
    both null for passengers and platform staff, since neither has a
    `role` FK, and platform staff have no `client` at all.
    """

    permissions = serializers.SerializerMethodField()
    role_name = serializers.SerializerMethodField()
    client_name = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = [
            "id",
            "email",
            "first_name",
            "last_name",
            "client",
            "is_platform_staff",
            "is_client_staff",
            "permissions",
            "role_name",
            "client_name",
        ]
        read_only_fields = fields

    def get_role_name(self, obj: User) -> str | None:
        return obj.role.name if obj.role else None

    def get_client_name(self, obj: User) -> str | None:
        return obj.client.name if obj.client else None

    def get_permissions(self, obj: User) -> list[str]:
        if obj.is_platform_staff:
            return ["super-admin:access"]
        if obj.is_client_staff:
            role = obj.role
            codenames = list(role.permissions.values_list("codename", flat=True)) if role else []
            return ["client-admin:access", *codenames]
        return ["customer:access"]


class RoleSerializer(serializers.ModelSerializer[Role]):
    permissions: Any = serializers.SlugRelatedField(
        many=True, slug_field="codename", read_only=True
    )

    class Meta:
        model = Role
        fields = ["id", "name", "permissions"]
        read_only_fields = fields


class StaffInvitationCreateSerializer(serializers.Serializer):
    email = serializers.EmailField()
    # Not PrimaryKeyRelatedField(queryset=Role.objects.all()): that
    # queryset would be evaluated once at class-definition/import time,
    # before any request has set a tenancy context — the exact
    # frozen-queryset bug Slice 3 found, just in a serializer field
    # instead of a view attribute. Resolved per-request in validate_role
    # instead.
    role = serializers.UUIDField()

    def validate_email(self, value: str) -> str:
        request = self.context["request"]
        if User.objects.filter(client=request.user.client, email__iexact=value).exists():
            raise serializers.ValidationError(
                "This person is already a member of your team.", code="already_member"
            )
        return value

    def validate_role(self, value: str) -> Role:
        request = self.context["request"]
        try:
            return Role.objects.get(pk=value, client=request.user.client)
        except Role.DoesNotExist:
            raise serializers.ValidationError("Unknown role.", code="unknown_role") from None


class StaffInvitationCreatedResponseSerializer(serializers.Serializer):
    """Same shape as apps.clients.serializers.InvitationCreatedResponseSerializer
    for the identical "invite and return {id}" response — duplicated
    rather than cross-imported, matching how KYC/KYB's near-identical
    per-app serializers are already handled."""

    id = serializers.UUIDField()


class StaffInvitationResolveSerializer(serializers.Serializer):
    client_name = serializers.CharField(source="client.name", read_only=True)
    role_name = serializers.CharField(source="role.name", read_only=True)
    status = serializers.CharField(read_only=True)


class StaffInvitationAcceptSerializer(serializers.Serializer):
    _STATUS_MESSAGES: ClassVar[dict[str, str]] = {
        StaffInvitation.Status.EXPIRED: "This invitation has expired.",
        StaffInvitation.Status.REVOKED: "This invitation has been revoked.",
        StaffInvitation.Status.ACCEPTED: "This invitation has already been accepted.",
    }

    password = serializers.CharField(write_only=True, trim_whitespace=False)

    def validate_password(self, value: str) -> str:
        try:
            django_validate_password(value)
        except DjangoValidationError as exc:
            raise serializers.ValidationError(list(exc.messages)) from exc
        return value

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        invitation: StaffInvitation = self.context["invitation"]
        if invitation.status != StaffInvitation.Status.PENDING:
            message = self._STATUS_MESSAGES.get(
                invitation.status, "This invitation is no longer valid."
            )
            raise serializers.ValidationError({"detail": message})
        return attrs


class StaffSerializer(serializers.ModelSerializer[User]):
    role = RoleSerializer(read_only=True)

    class Meta:
        model = User
        fields = ["id", "email", "first_name", "last_name", "role", "is_active"]
        read_only_fields = ["id", "email", "first_name", "last_name"]


class StaffListQuerySerializer(serializers.Serializer):
    """Query shape for GET /staff/ — this endpoint's first, added by
    spec 14 slice 3b so its filter bar has something real behind it.

    Email is what a colleague is identified by everywhere in this
    console, and `identity.User` has no display name of its own worth
    searching. `allow_blank`, because the filter bar emits '' when its
    search box is cleared."""

    search = serializers.CharField(required=False, allow_blank=True)


class StaffUpdateSerializer(serializers.Serializer):
    role = serializers.UUIDField(required=False)
    is_active = serializers.BooleanField(required=False)

    def validate_role(self, value: str) -> Role:
        request = self.context["request"]
        try:
            return Role.objects.get(pk=value, client=request.user.client)
        except Role.DoesNotExist:
            raise serializers.ValidationError("Unknown role.", code="unknown_role") from None


class PassengerLookupQuerySerializer(serializers.Serializer):
    """Query shape for GET /passengers/lookup/ —
    docs/specs/18-manifest-and-staff-booking.md slice 2.

    **The spec names `?phone=` as well, and there is no phone number to
    match.** `identity.User` carries email, first and last name and
    nothing else; `phone` exists on `Client`, `Driver` and `Incident`,
    but a passenger has none anywhere in the schema, and no registration
    path collects one. Adding the column would ship a lookup field that
    is empty for every account that exists and is filled by nothing —
    worse than not offering it, because it would fail as "not found"
    rather than as "not supported". Email only, and the gap is recorded
    rather than papered over.
    """

    email = serializers.EmailField()


class PassengerSerializer(serializers.Serializer):
    """What a counter agent is allowed to see about a passenger they
    just resolved: enough to confirm the right person and to book for
    them, and no more.

    `email` is masked (`apps.identity.services.mask_email`) — the agent
    typed the address to get here, so this withholds nothing they did
    not already have, while keeping a full address off a screen a queue
    of other passengers can read.
    """

    id = serializers.UUIDField()
    first_name = serializers.CharField()
    last_name = serializers.CharField()
    email = serializers.CharField(help_text="Masked — e.g. `a••••••@example.com`.")
