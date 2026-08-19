from django.db.models import QuerySet
from drf_spectacular.utils import extend_schema
from rest_framework import generics, status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView
from rest_framework_simplejwt.views import TokenViewBase

from apps.core.permissions import HasPermission
from apps.identity.models import Role, User
from apps.identity.serializers import (
    ClientAdminTokenObtainSerializer,
    CustomerTokenObtainSerializer,
    MeSerializer,
    RoleSerializer,
    StaffInvitationAcceptSerializer,
    StaffInvitationCreatedResponseSerializer,
    StaffInvitationCreateSerializer,
    StaffInvitationResolveSerializer,
    StaffSerializer,
    StaffUpdateSerializer,
    SuperAdminTokenObtainSerializer,
    TokenObtainResponseSerializer,
)
from apps.identity.services import (
    accept_staff_invitation,
    invite_staff,
    resolve_invitation,
    update_staff_member,
)


@extend_schema(responses=TokenObtainResponseSerializer)
class CustomerTokenObtainView(TokenViewBase):
    serializer_class = CustomerTokenObtainSerializer
    permission_classes = [AllowAny]  # type: ignore[assignment]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "auth_login_customer"


@extend_schema(responses=TokenObtainResponseSerializer)
class ClientAdminTokenObtainView(TokenViewBase):
    serializer_class = ClientAdminTokenObtainSerializer
    permission_classes = [AllowAny]  # type: ignore[assignment]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "auth_login_client_admin"


@extend_schema(responses=TokenObtainResponseSerializer)
class SuperAdminTokenObtainView(TokenViewBase):
    serializer_class = SuperAdminTokenObtainSerializer
    permission_classes = [AllowAny]  # type: ignore[assignment]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "auth_login_super_admin"


class MeView(generics.RetrieveAPIView[User]):
    serializer_class = MeSerializer
    permission_classes = [IsAuthenticated]

    def get_object(self) -> User:
        request: Request = self.request
        assert isinstance(request.user, User)
        return request.user


@extend_schema(responses=RoleSerializer)
class RoleListView(generics.ListAPIView[Role]):
    permission_classes = [HasPermission("client.view")]
    serializer_class = RoleSerializer

    def get_queryset(self) -> QuerySet[Role]:
        # prefetch_related("permissions"): RoleSerializer.permissions is
        # a M2M SlugRelatedField, one query per row without this. Same
        # N+1 class as StaffListView's role/permissions fix above — only
        # 3 rows per Client today, but the fix is free and keeps this
        # correct if that ever changes.
        request = self.request
        assert isinstance(request.user, User)
        return Role.objects.all().prefetch_related("permissions")


@extend_schema(
    request=StaffInvitationCreateSerializer, responses=StaffInvitationCreatedResponseSerializer
)
class StaffInvitationCreateView(APIView):
    permission_classes = [HasPermission("staff.invite")]

    def post(self, request: Request) -> Response:
        user = request.user
        assert isinstance(user, User)
        assert user.client is not None

        serializer = StaffInvitationCreateSerializer(
            data=request.data, context={"request": request}
        )
        serializer.is_valid(raise_exception=True)
        invitation = invite_staff(
            client=user.client,
            email=serializer.validated_data["email"],
            role=serializer.validated_data["role"],
            invited_by=user,
        )
        return Response({"id": str(invitation.id)}, status=status.HTTP_201_CREATED)


@extend_schema(responses=StaffInvitationResolveSerializer)
class StaffInvitationResolveView(APIView):
    permission_classes = [AllowAny]

    def get(self, request: Request, token: str) -> Response:
        invitation = resolve_invitation(token)
        return Response(StaffInvitationResolveSerializer(invitation).data)


@extend_schema(request=StaffInvitationAcceptSerializer, responses=TokenObtainResponseSerializer)
class StaffInvitationAcceptView(APIView):
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "auth_invite_accept"

    def post(self, request: Request, token: str) -> Response:
        invitation = resolve_invitation(token)
        serializer = StaffInvitationAcceptSerializer(
            data=request.data, context={"invitation": invitation}
        )
        serializer.is_valid(raise_exception=True)
        user = accept_staff_invitation(
            invitation=invitation, password=serializer.validated_data["password"]
        )
        token_obj = ClientAdminTokenObtainSerializer.get_token(user)
        return Response(
            {"refresh": str(token_obj), "access": str(token_obj.access_token)},
            status=status.HTTP_201_CREATED,
        )


@extend_schema(responses=StaffSerializer)
class StaffListView(generics.ListAPIView[User]):
    permission_classes = [HasPermission("staff.manage")]
    serializer_class = StaffSerializer

    def get_queryset(self) -> QuerySet[User]:
        # select_related("role") + prefetch_related("role__permissions"):
        # StaffSerializer nests RoleSerializer (which reads
        # role.permissions), so without these every row would run its own
        # role query plus its own permissions query — a real N+1 found
        # during the Phase 1 self-check's query-count audit.
        request = self.request
        assert isinstance(request.user, User)
        return (
            User.objects.filter(client=request.user.client, is_client_staff=True)
            .select_related("role")
            .prefetch_related("role__permissions")
        )


@extend_schema(request=StaffUpdateSerializer, responses=StaffSerializer)
class StaffUpdateView(generics.GenericAPIView[User]):
    permission_classes = [HasPermission("staff.manage")]
    http_method_names = ["patch"]

    def get_queryset(self) -> QuerySet[User]:
        request = self.request
        assert isinstance(request.user, User)
        return User.objects.filter(client=request.user.client, is_client_staff=True)

    def patch(self, request: Request, user_id: str) -> Response:
        member = generics.get_object_or_404(self.get_queryset(), pk=user_id)
        serializer = StaffUpdateSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)

        actor = request.user
        assert isinstance(actor, User)
        updated = update_staff_member(user=member, updated_by=actor, **serializer.validated_data)
        return Response(StaffSerializer(updated).data)
