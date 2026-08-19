import hmac
from typing import Any

from django.conf import settings
from django.db import connections
from django.db.utils import OperationalError
from drf_spectacular.utils import extend_schema
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.serializers import HealthSerializer, ReadinessSerializer
from apps.scheduling.tasks import generate_trips
from apps.seating.tasks import expire_seat_holds


@extend_schema(responses=HealthSerializer)
@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def health(request: Request) -> Response:
    """Liveness probe: process is up. Does not touch the database."""
    return Response({"status": "ok"})


@extend_schema(responses=ReadinessSerializer)
@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def readiness(request: Request) -> Response:
    """Readiness probe: process is up and the database is reachable."""
    try:
        connections["default"].cursor()
    except OperationalError:
        return Response({"status": "not ready", "database": "unreachable"}, status=503)
    return Response({"status": "ready"})


class _InternalTaskView(APIView):
    """Base for the two endpoints that stand in for Celery Beat on
    `config.settings.vercel` (see docs/deployment.md) — there is no
    beat process there to run `generate_trips`/`expire_seat_holds` on a
    schedule, so an external scheduler (Vercel Cron, a GitHub Actions
    workflow) calls these over HTTP instead. Shared-secret auth, not
    JWT — the caller is a scheduler, not a logged-in user — mirrors
    `apps.payments.views.PaystackWebhookView`'s own shape exactly.
    Excluded from the generated OpenAPI schema for the same reason that
    view is: no frontend client here ever calls this."""

    permission_classes = [AllowAny]
    authentication_classes: list[Any] = []

    def _secret_is_valid(self, request: Request) -> bool:
        provided = request.headers.get("X-Internal-Task-Secret", "")
        return bool(settings.INTERNAL_TASK_SECRET) and hmac.compare_digest(
            provided, settings.INTERNAL_TASK_SECRET
        )


@extend_schema(exclude=True)
class GenerateTripsView(_InternalTaskView):
    def post(self, request: Request) -> Response:
        if not self._secret_is_valid(request):
            return Response(status=403)
        generate_trips()
        return Response(status=200)


@extend_schema(exclude=True)
class ExpireSeatHoldsView(_InternalTaskView):
    def post(self, request: Request) -> Response:
        if not self._secret_is_valid(request):
            return Response(status=403)
        expire_seat_holds()
        return Response(status=200)
