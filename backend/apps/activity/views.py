"""Views for apps.activity — docs/specs/20-live-operations.md slice 4."""

from django.conf import settings
from drf_spectacular.utils import extend_schema, extend_schema_view
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.identity.models import User

from .serializers import ActivityResponseSerializer
from .services import list_activity


@extend_schema_view(
    get=extend_schema(operation_id="activity_mine_retrieve", responses=ActivityResponseSerializer)
)
class ActivityMineView(APIView):
    """GET /activity/mine/ — the signed-in passenger's own recent
    activity: wallet top-ups, booking payments, tickets boarded and
    pay-as-you-go fares, newest first.

    `IsAuthenticated` only, matching every other "mine" passenger
    endpoint (`GET /wallet/mine/`, `GET /activity/mine/`'s own sibling)
    — passengers hold no Role/Permission to gate on (docs/adr/0003).
    Polled on the same `poll_interval_seconds`-in-the-response
    discipline as `GET /trips/live/`, at its own, wider interval:
    a passenger's history changes far less often than a vehicle's
    position, so there is no `ETag`/`?since=` machinery here — the
    fleet-bandwidth motivation for that in spec 20 slice 2 does not
    apply to one passenger's own small, bounded feed.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request: Request) -> Response:
        user = request.user
        assert isinstance(user, User)
        entries = list_activity(passenger=user)
        body = {
            "results": entries,
            "poll_interval_seconds": settings.ACTIVITY_POLL_INTERVAL_SECONDS,
        }
        return Response(ActivityResponseSerializer(body).data)
