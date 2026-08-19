from collections import defaultdict
from typing import Any

from django.contrib.auth.password_validation import validate_password as django_validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from .models import Client, ClientInvitation, KycDocument, WhiteLabelConfig
from .services import client_email_taken, register_client

_DUPLICATE_EMAIL_ERROR = "A client with this email already exists."


class ClientRegistrationSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=255)
    email = serializers.EmailField()
    phone = serializers.CharField(max_length=32, required=False, allow_blank=True)
    password = serializers.CharField(write_only=True, trim_whitespace=False)

    def validate_email(self, value: str) -> str:
        if client_email_taken(value):
            raise serializers.ValidationError(_DUPLICATE_EMAIL_ERROR, code="duplicate_email")
        return value

    def validate_password(self, value: str) -> str:
        try:
            django_validate_password(value)
        except DjangoValidationError as exc:
            raise serializers.ValidationError(list(exc.messages)) from exc
        return value

    def create(self, validated_data: dict[str, Any]) -> Any:
        return register_client(
            name=validated_data["name"],
            email=validated_data["email"],
            phone=validated_data.get("phone", ""),
            password=validated_data["password"],
        )


class KycDocumentSerializer(serializers.ModelSerializer[KycDocument]):
    class Meta:
        model = KycDocument
        fields = ["id", "document_type", "file", "status", "created_at"]
        read_only_fields = ["id", "status", "created_at"]


class ClientKycQueueSerializer(serializers.ModelSerializer[Client]):
    documents = serializers.SerializerMethodField()

    class Meta:
        model = Client
        fields = [
            "id",
            "name",
            "email",
            "phone",
            "kyc_status",
            "kyc_submitted_at",
            "documents",
        ]
        read_only_fields = fields

    @extend_schema_field(KycDocumentSerializer(many=True))
    def get_documents(self, obj: Client) -> Any:
        # No reverse accessor: BaseModel.client uses related_name="+"
        # deliberately (see docs/adr/0002) — query explicitly instead.
        # all_objects, not objects: the caller here is platform staff
        # (client_id=None in their JWT), so the default TenantScopedManager
        # would short-circuit to empty before ever reaching RLS.
        #
        # Batched, not one query per row: DRF's `many=True` reuses this
        # exact serializer instance (`self`) as `ListSerializer.child`
        # across every row, and `self.parent.instance` is the full page
        # — so the first call fetches every row's documents in one query
        # and caches the grouping on `self`, instead of firing a fresh
        # `.filter(client=obj)` per Client in the queue (found as a real
        # N+1 during the Phase 1 self-check's query-count audit).
        if getattr(self, "_documents_cache", None) is None:
            parent_instance = self.parent.instance if self.parent is not None else None
            clients = parent_instance if parent_instance is not None else [obj]
            client_ids = [client.id for client in clients]
            documents = KycDocument.all_objects.filter(client_id__in=client_ids)
            cache: dict[Any, list[KycDocument]] = defaultdict(list)
            for document in documents:
                cache[document.client_id].append(document)
            self._documents_cache = cache
        return KycDocumentSerializer(self._documents_cache.get(obj.id, []), many=True).data


class ClientMeSerializer(serializers.ModelSerializer[Client]):
    """The read-back Phase 1 never built (only `POST /clients/me/kyc-documents/`
    existed) — mirrors `WhiteLabelConfigView.get()`'s "own Client" scoping.
    Single-object, so `get_documents` doesn't need `ClientKycQueueSerializer`'s
    batched-cache trick (that's for N+1 across a *list* of Clients)."""

    documents = serializers.SerializerMethodField()

    class Meta:
        model = Client
        fields = ["kyc_status", "kyc_submitted_at", "kyc_rejection_reason", "documents"]
        read_only_fields = fields

    @extend_schema_field(KycDocumentSerializer(many=True))
    def get_documents(self, obj: Client) -> Any:
        # .objects, not .all_objects: unlike the queue above, the caller
        # here is the Client's own staff (client_id set in their JWT), so
        # the default TenantScopedManager scopes correctly on its own —
        # this is the Client's own data, not a deliberate cross-client
        # read, so it doesn't get the queue's platform-staff escape hatch.
        documents = KycDocument.objects.filter(client=obj)
        return KycDocumentSerializer(documents, many=True).data


class KycDecisionSerializer(serializers.Serializer):
    DECISION_CHOICES = ("approve", "reject")

    decision = serializers.ChoiceField(choices=DECISION_CHOICES)
    reason = serializers.CharField(required=False, allow_blank=True)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if attrs["decision"] == "reject" and not attrs.get("reason"):
            raise serializers.ValidationError(
                {"reason": "A reason is required when rejecting."}
            )
        return attrs


class ClientInvitationCreateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=255)
    email = serializers.EmailField()

    def validate_email(self, value: str) -> str:
        if client_email_taken(value):
            raise serializers.ValidationError(_DUPLICATE_EMAIL_ERROR, code="duplicate_email")
        return value


class InvitationCreatedResponseSerializer(serializers.Serializer):
    id = serializers.UUIDField()


class ClientInvitationResolveSerializer(serializers.ModelSerializer[ClientInvitation]):
    class Meta:
        model = ClientInvitation
        fields = ["name", "email", "status"]
        read_only_fields = fields


class ClientInvitationCompleteSerializer(serializers.Serializer):
    phone = serializers.CharField(max_length=32, required=False, allow_blank=True)
    password = serializers.CharField(write_only=True, trim_whitespace=False)

    def validate_password(self, value: str) -> str:
        try:
            django_validate_password(value)
        except DjangoValidationError as exc:
            raise serializers.ValidationError(list(exc.messages)) from exc
        return value

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        invitation: ClientInvitation = self.context["invitation"]
        if invitation.status != ClientInvitation.Status.PENDING:
            raise serializers.ValidationError(
                {"detail": f"This invitation is {invitation.status} and cannot be completed."}
            )
        if client_email_taken(invitation.email):
            raise serializers.ValidationError({"detail": _DUPLICATE_EMAIL_ERROR})
        return attrs


class WhiteLabelConfigSerializer(serializers.ModelSerializer[WhiteLabelConfig]):
    class Meta:
        model = WhiteLabelConfig
        fields = [
            "id",
            "domain",
            "logo",
            "primary_color",
            "secondary_color",
            "email_sender_name",
            "email_sender_address",
            "terms_url",
        ]
        read_only_fields = ["id"]


class WhiteLabelResolveSerializer(serializers.ModelSerializer[WhiteLabelConfig]):
    client_id = serializers.UUIDField(read_only=True)
    name = serializers.CharField(source="client.name", read_only=True)

    class Meta:
        model = WhiteLabelConfig
        fields = [
            "client_id",
            "name",
            "logo",
            "primary_color",
            "secondary_color",
            "email_sender_name",
            "terms_url",
        ]
        read_only_fields = fields
