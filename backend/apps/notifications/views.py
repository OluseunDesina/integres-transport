"""Views for apps.notifications — see docs/specs/9-notifications.md.

`GET /notifications/mine/` and `POST /notifications/{id}/read/` both
branch on `request.user.is_platform_staff`, reading through
`Notification.objects` (the ordinary tenant-scoped manager) for a
client-scoped recipient, or `Notification.all_objects` for a
platform-staff one — the latter's own notifications can span several
different Clients (see `apps.notifications.models`'s module docstring:
`client` on a KYC/KYB-submission row is the *submitting* Client, not
the recipient's own, since platform staff have none), so `.objects`
(which filters to the current request's single session client_id)
would silently return nothing for them. `.all_objects` relies on RLS's
own `client_id = session OR is_platform_staff` policy for the real
boundary — the same trust model every other `IsPlatformStaff`-reachable
cross-client read in this codebase already uses (e.g.
`apps.businesses.views.BusinessSuperAdminListView`), just picked
per-request here instead of via a separate view/permission class,
since the same endpoint genuinely serves both kinds of caller.
"""

from django.db.models import QuerySet
from django.shortcuts import get_object_or_404
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import generics
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response

from apps.identity.models import User

from .models import Notification
from .serializers import (
    NotificationListQuerySerializer,
    NotificationReadAllResponseSerializer,
    NotificationSerializer,
)
from .services import mark_all_notifications_read, mark_notification_read

_UNREAD_ONLY_PARAM = OpenApiParameter(
    "unread_only",
    bool,
    OpenApiParameter.QUERY,
    required=False,
    description="When true, only unread notifications are returned.",
)


def _notifications_for(user: User) -> QuerySet[Notification]:
    if user.is_platform_staff:
        return Notification.all_objects.filter(recipient=user)
    return Notification.objects.filter(recipient=user)


@extend_schema(parameters=[_UNREAD_ONLY_PARAM])
class NotificationMineView(generics.ListAPIView[Notification]):
    """GET /notifications/mine/?unread_only= — the authenticated user's
    own notifications. `IsAuthenticated` only, matching
    `apps.booking.views.BookingMineView`'s shape — a passenger has no
    Role (ADR-0003) and still needs this for the ticket-reminder case."""

    permission_classes = [IsAuthenticated]
    serializer_class = NotificationSerializer

    def get_queryset(self) -> QuerySet[Notification]:
        user = self.request.user
        assert isinstance(user, User)
        query = NotificationListQuerySerializer(data=self.request.query_params)
        query.is_valid(raise_exception=True)
        queryset = _notifications_for(user)
        if query.validated_data["unread_only"]:
            queryset = queryset.filter(read_at__isnull=True)
        return queryset


@extend_schema(request=None, responses=NotificationSerializer)
class NotificationReadView(generics.GenericAPIView[Notification]):
    permission_classes = [IsAuthenticated]
    serializer_class = NotificationSerializer

    def post(self, request: Request, pk: str) -> Response:
        user = request.user
        assert isinstance(user, User)
        notification = get_object_or_404(_notifications_for(user), pk=pk)
        notification = mark_notification_read(notification=notification)
        return Response(NotificationSerializer(notification).data)


@extend_schema(request=None, responses=NotificationReadAllResponseSerializer)
class NotificationReadAllView(generics.GenericAPIView[Notification]):
    permission_classes = [IsAuthenticated]
    serializer_class = NotificationReadAllResponseSerializer

    def post(self, request: Request) -> Response:
        user = request.user
        assert isinstance(user, User)
        count = mark_all_notifications_read(recipient=user)
        return Response(NotificationReadAllResponseSerializer({"marked_read": count}).data)
