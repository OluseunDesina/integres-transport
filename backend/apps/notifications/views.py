"""Views for apps.notifications — see docs/specs/9-notifications.md.

`GET /notifications/mine/` and `POST /notifications/{id}/read/` both
read through `Notification.all_objects`, not the ordinary tenant-scoped
`.objects` — originally (see git history) this branched on
`request.user.is_platform_staff`, `.all_objects` only for that case,
since a platform-staff recipient's own notifications can span several
different Clients (see `apps.notifications.models`'s module docstring:
`client` on a KYC/KYB-submission row is the *submitting* Client, not
the recipient's own). docs/adr/0009 needs the identical treatment for an
*ordinary* passenger too — a marketplace passenger's ticket-reminder
notification carries the operator's own Client, not the passenger's own
(Marketplace) one — so the branch was collapsed to always use
`all_objects`: `recipient=user` is already the sole real authorization
check either way, and using it unconditionally changes nothing for an
operator-Client passenger (their own notifications only ever carry their
own Client regardless of manager). Every caller must be inside
`platform_staff_bypass()` — RLS itself, not just the ORM filter, still
has to be satisfied, same as everywhere else docs/adr/0009 touches.
"""

from django.db.models import QuerySet
from django.shortcuts import get_object_or_404
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import generics
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response

from apps.core.rls import platform_staff_bypass
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
    return Notification.all_objects.filter(recipient=user, deleted_at__isnull=True)


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

    def list(self, request: Request, *args: object, **kwargs: object) -> Response:
        with platform_staff_bypass():
            return super().list(request, *args, **kwargs)


@extend_schema(request=None, responses=NotificationSerializer)
class NotificationReadView(generics.GenericAPIView[Notification]):
    permission_classes = [IsAuthenticated]
    serializer_class = NotificationSerializer

    def post(self, request: Request, pk: str) -> Response:
        user = request.user
        assert isinstance(user, User)
        with platform_staff_bypass():
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
        with platform_staff_bypass():
            count = mark_all_notifications_read(recipient=user)
        return Response(NotificationReadAllResponseSerializer({"marked_read": count}).data)
