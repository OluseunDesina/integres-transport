from django.shortcuts import get_object_or_404
from drf_spectacular.utils import extend_schema
from rest_framework import generics, status
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from apps.core.permissions import HasPermission, IsPlatformStaff
from apps.identity.models import User
from apps.identity.serializers import (
    ClientAdminTokenObtainSerializer,
    TokenObtainResponseSerializer,
)

from .models import Client
from .serializers import (
    ClientInvitationCompleteSerializer,
    ClientInvitationCreateSerializer,
    ClientInvitationResolveSerializer,
    ClientKycQueueSerializer,
    ClientMeSerializer,
    ClientRegistrationSerializer,
    InvitationCreatedResponseSerializer,
    KycDecisionSerializer,
    KycDocumentSerializer,
    WhiteLabelConfigSerializer,
    WhiteLabelResolveSerializer,
)
from .services import (
    complete_client_invitation,
    decide_client_kyc,
    get_or_create_white_label,
    invite_client,
    resolve_client_invitation,
    resolve_white_label_by_domain,
    submit_kyc_document,
    update_white_label,
)


@extend_schema(request=ClientRegistrationSerializer, responses=TokenObtainResponseSerializer)
class ClientRegistrationView(APIView):
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "auth_register"

    def post(self, request: Request) -> Response:
        serializer = ClientRegistrationSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        owner = serializer.save()
        assert isinstance(owner, User)
        token = ClientAdminTokenObtainSerializer.get_token(owner)
        return Response(
            {"refresh": str(token), "access": str(token.access_token)},
            status=status.HTTP_201_CREATED,
        )


@extend_schema(request=KycDocumentSerializer, responses=KycDocumentSerializer)
class KycDocumentUploadView(APIView):
    permission_classes = [HasPermission("client.view")]
    parser_classes = [MultiPartParser, FormParser]

    def post(self, request: Request) -> Response:
        user = request.user
        assert isinstance(user, User)
        assert user.client is not None

        serializer = KycDocumentSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        document = submit_kyc_document(
            client=user.client,
            document_type=serializer.validated_data["document_type"],
            file=serializer.validated_data["file"],
            uploaded_by=user,
        )
        return Response(KycDocumentSerializer(document).data, status=status.HTTP_201_CREATED)


@extend_schema(responses=ClientMeSerializer)
class ClientMeView(APIView):
    permission_classes = [HasPermission("client.view")]

    def get(self, request: Request) -> Response:
        user = request.user
        assert isinstance(user, User)
        assert user.client is not None
        return Response(ClientMeSerializer(user.client).data)


@extend_schema(responses=ClientKycQueueSerializer)
class KycQueueListView(generics.ListAPIView[Client]):
    permission_classes = [IsPlatformStaff]
    serializer_class = ClientKycQueueSerializer
    # Oldest submission first, same reasoning as `KybQueueListView`'s own
    # ordering comment — these two queues are the same screen for two
    # different models and must not answer "what comes first" differently.
    queryset = Client.objects.filter(kyc_status=Client.KycStatus.SUBMITTED).order_by(
        "kyc_submitted_at"
    )


@extend_schema(request=KycDecisionSerializer, responses=ClientKycQueueSerializer)
class KycDecideView(APIView):
    permission_classes = [IsPlatformStaff]

    def post(self, request: Request, client_id: str) -> Response:
        client = get_object_or_404(Client, pk=client_id)
        serializer = KycDecisionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        user = request.user
        assert isinstance(user, User)
        updated = decide_client_kyc(
            client=client,
            decision=serializer.validated_data["decision"],
            reason=serializer.validated_data.get("reason", ""),
            decided_by=user,
        )
        return Response(ClientKycQueueSerializer(updated).data)


@extend_schema(
    request=ClientInvitationCreateSerializer, responses=InvitationCreatedResponseSerializer
)
class ClientInvitationCreateView(APIView):
    permission_classes = [IsPlatformStaff]

    def post(self, request: Request) -> Response:
        serializer = ClientInvitationCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        user = request.user
        assert isinstance(user, User)
        invitation = invite_client(
            name=serializer.validated_data["name"],
            email=serializer.validated_data["email"],
            invited_by=user,
        )
        return Response({"id": str(invitation.id)}, status=status.HTTP_201_CREATED)


@extend_schema(responses=ClientInvitationResolveSerializer)
class ClientInvitationResolveView(APIView):
    permission_classes = [AllowAny]

    def get(self, request: Request, token: str) -> Response:
        invitation = resolve_client_invitation(token)
        return Response(ClientInvitationResolveSerializer(invitation).data)


@extend_schema(request=ClientInvitationCompleteSerializer, responses=TokenObtainResponseSerializer)
class ClientInvitationCompleteView(APIView):
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "auth_invite_accept"

    def post(self, request: Request, token: str) -> Response:
        invitation = resolve_client_invitation(token)
        serializer = ClientInvitationCompleteSerializer(
            data=request.data, context={"invitation": invitation}
        )
        serializer.is_valid(raise_exception=True)
        owner = complete_client_invitation(
            invitation=invitation,
            phone=serializer.validated_data.get("phone", ""),
            password=serializer.validated_data["password"],
        )
        token_obj = ClientAdminTokenObtainSerializer.get_token(owner)
        return Response(
            {"refresh": str(token_obj), "access": str(token_obj.access_token)},
            status=status.HTTP_201_CREATED,
        )


@extend_schema(request=WhiteLabelConfigSerializer, responses=WhiteLabelConfigSerializer)
class WhiteLabelConfigView(APIView):
    permission_classes = [HasPermission("whitelabel.manage")]

    def get(self, request: Request) -> Response:
        user = request.user
        assert isinstance(user, User)
        assert user.client is not None
        config = get_or_create_white_label(user.client)
        return Response(WhiteLabelConfigSerializer(config).data)

    def patch(self, request: Request) -> Response:
        user = request.user
        assert isinstance(user, User)
        assert user.client is not None

        serializer = WhiteLabelConfigSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        updated = update_white_label(
            client=user.client, updated_by=user, **serializer.validated_data
        )
        return Response(WhiteLabelConfigSerializer(updated).data)


@extend_schema(responses=WhiteLabelResolveSerializer)
class WhiteLabelResolveView(APIView):
    permission_classes = [AllowAny]

    def get(self, request: Request) -> Response:
        config = resolve_white_label_by_domain(request.get_host())
        if config is None:
            return Response(status=status.HTTP_404_NOT_FOUND)
        return Response(WhiteLabelResolveSerializer(config).data)
