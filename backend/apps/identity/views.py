from django.db.models import QuerySet
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import generics, status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView
from rest_framework_simplejwt.views import TokenViewBase

from apps.core.audit import record_audit_event
from apps.core.permissions import HasAnyPermission, HasPermission
from apps.identity.models import Role, User
from apps.identity.serializers import (
    ClientAdminTokenObtainSerializer,
    CustomerTokenObtainSerializer,
    MeSerializer,
    PassengerLookupQuerySerializer,
    PassengerSerializer,
    RoleSerializer,
    StaffInvitationAcceptSerializer,
    StaffInvitationCreatedResponseSerializer,
    StaffInvitationCreateSerializer,
    StaffInvitationResolveSerializer,
    StaffListQuerySerializer,
    StaffSerializer,
    StaffUpdateSerializer,
    SuperAdminTokenObtainSerializer,
    TokenObtainResponseSerializer,
)
from apps.identity.services import (
    PassengerNotFound,
    accept_staff_invitation,
    invite_staff,
    lookup_passenger,
    mask_email,
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


_STAFF_SEARCH_QUERY_PARAM = OpenApiParameter(
    "search",
    str,
    OpenApiParameter.QUERY,
    required=False,
    description="Case-insensitive substring match on the staff member's email.",
)


@extend_schema(responses=StaffSerializer, parameters=[_STAFF_SEARCH_QUERY_PARAM])
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
        queryset = (
            User.objects.filter(client=request.user.client, is_client_staff=True)
            .select_related("role")
            .prefetch_related("role__permissions")
        )

        query = StaffListQuerySerializer(data=request.query_params.dict())
        query.is_valid(raise_exception=True)
        search = query.validated_data.get("search", "").strip()
        if search:
            # Narrows an already Client-filtered queryset, so no term a
            # caller can type reaches another Client's staff.
            queryset = queryset.filter(email__icontains=search)

        return queryset


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


_EMAIL_QUERY_PARAM = OpenApiParameter(
    "email",
    str,
    OpenApiParameter.QUERY,
    required=True,
    description="Exact (case-insensitive) email address. Not a search — a "
    "partial address matches nothing.",
)


@extend_schema(parameters=[_EMAIL_QUERY_PARAM], responses=PassengerSerializer)
class PassengerLookupView(APIView):
    """`GET /passengers/lookup/?email=` — resolve one passenger of this
    Client, so staff can act for them.

    Two capabilities need this, which is why it takes either codename:

    - **`booking.manage`** — the counter-booking flow
      (docs/specs/18-manifest-and-staff-booking.md slice 2) needs a
      passenger id before it can book.
    - **`wallet.view`** — `client-admin-app`'s wallet-lookup screen has
      shipped since spec 5 with its limitation written into its own
      docstring: `GET /wallet/?business=&passenger=` takes a UUID and
      there was no way to obtain one, so the screen only worked if a
      support ticket happened to quote it. That is the capability this
      endpoint is; gating it on `booking.manage` alone would have left
      the screen broken for every Staff user, since Staff hold
      `wallet.view` and deliberately not `booking.manage`.

    Widening the gate widens who can confirm an address is registered.
    That is a real cost and it was taken deliberately: the alternative
    was a second endpoint doing the same lookup under a different name,
    which is the same disclosure with more code.

    Lives in `apps.identity` rather than `apps.booking` because the data
    is `identity.User` — the app that owns the data owns the endpoint,
    and it now has two consumers in different apps, so hanging it off
    either one would make the other depend on it.

    Throttled: an exact-match endpoint is still an enumeration oracle if
    you let someone hammer it. A `404` is returned for both "no such
    passenger" and "a passenger of another Client", with one message —
    the distinction is exactly what an attacker wants.
    """

    permission_classes = [HasAnyPermission("booking.manage", "wallet.view")]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "passenger_lookup"

    def get(self, request: Request) -> Response:
        query = PassengerLookupQuerySerializer(data=request.query_params)
        query.is_valid(raise_exception=True)
        actor = request.user
        assert isinstance(actor, User)
        assert actor.client is not None

        try:
            passenger = lookup_passenger(email=query.validated_data["email"], client=actor.client)
        except PassengerNotFound as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_404_NOT_FOUND)

        # Audited on success only. A miss records nothing but the
        # throttle counter — logging every failed address would build the
        # very list of tried addresses this endpoint exists to avoid
        # producing.
        record_audit_event(
            actor=actor,
            action="passenger.looked_up",
            target=passenger,
            client_id=str(actor.client_id),
        )
        return Response(
            PassengerSerializer(
                {
                    "id": passenger.id,
                    "first_name": passenger.first_name,
                    "last_name": passenger.last_name,
                    "email": mask_email(passenger.email),
                }
            ).data
        )
