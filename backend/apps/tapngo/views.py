"""Views for apps.tapngo — see docs/specs/4b-tap-and-go.md."""

from django.db.models import QuerySet
from django.shortcuts import get_object_or_404
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_view
from rest_framework import generics, status
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response

from apps.core.idempotency import IdempotencyKeyConflict
from apps.core.permissions import HasPermission
from apps.identity.models import User
from apps.scheduling.models import Trip

from .models import FareJourney, TapCredential
from .serializers import (
    FareJourneyListQuerySerializer,
    FareJourneySerializer,
    TapCredentialIssuedSerializer,
    TapCredentialIssueSerializer,
    TapCredentialSerializer,
    TapCredentialUpdateSerializer,
    TapEventSerializer,
    TapRecordSerializer,
)
from .services import (
    CredentialInactive,
    InvalidAlightStop,
    NoOpenJourney,
    OpenJourneyExists,
    StopNotOnRoute,
    TripNotOpenForTaps,
    TripNotTapAndGo,
    UnknownToken,
    issue_credential,
    record_tap,
    revoke_credential,
)

_TRIP_QUERY_PARAM = OpenApiParameter(
    "trip", str, OpenApiParameter.QUERY, required=False, description="Filter to a single Trip."
)
_STATUS_QUERY_PARAM = OpenApiParameter(
    "status",
    str,
    OpenApiParameter.QUERY,
    required=False,
    description="Filter to a single status.",
)
_IDEMPOTENCY_KEY_PARAM = OpenApiParameter(
    "Idempotency-Key",
    str,
    OpenApiParameter.HEADER,
    required=True,
    description="Client-generated key. A retried request with the same key and body "
    "returns the original TapEvent rather than recording a second one.",
)


# --- Tap credentials (passenger-facing) -------------------------------------


@extend_schema(request=TapCredentialIssueSerializer, responses=TapCredentialIssuedSerializer)
class TapCredentialCreateView(generics.CreateAPIView[TapCredential]):
    """POST /tap-credentials/ — a passenger issues a credential for
    themselves. `IsAuthenticated` only, no Role/Permission gate —
    passengers have no Role (docs/adr/0003), same reasoning
    `apps.booking.views.BookingListCreateView`'s POST branch documents.

    `@extend_schema` is required here, not optional: `serializer_class`
    (used for request validation) and the actual response shape
    (`TapCredentialIssuedSerializer`, built manually below since it needs
    `token` from context, not the instance) are genuinely different
    serializers — without this, drf-spectacular infers the response
    schema from `serializer_class` too and documents the *request* shape
    as the response, silently omitting `token` from the generated
    OpenAPI schema and every typed frontend client built from it."""

    permission_classes = [IsAuthenticated]
    serializer_class = TapCredentialIssueSerializer

    def create(self, request: Request, *args: object, **kwargs: object) -> Response:
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = request.user
        assert isinstance(user, User)
        credential, token = issue_credential(
            passenger=user,
            channel=serializer.validated_data["channel"],
            label=serializer.validated_data.get("label", ""),
        )
        response = TapCredentialIssuedSerializer(credential, context={"token": token})
        return Response(response.data, status=status.HTTP_201_CREATED)


class TapCredentialMineView(generics.ListAPIView[TapCredential]):
    """GET /tap-credentials/mine/ — the passenger's own credentials.
    `token` never appears in this response."""

    permission_classes = [IsAuthenticated]
    serializer_class = TapCredentialSerializer

    def get_queryset(self) -> QuerySet[TapCredential]:
        user = self.request.user
        assert isinstance(user, User)
        return TapCredential.objects.filter(passenger=user)


@extend_schema(request=TapCredentialUpdateSerializer, responses=TapCredentialSerializer)
class TapCredentialUpdateView(generics.GenericAPIView[TapCredential]):
    """PATCH /tap-credentials/{id}/ — revoke only, own credentials only.
    `@extend_schema` required — see `TapCredentialCreateView`'s own
    docstring: the response is built from a different serializer
    (`TapCredentialSerializer`) than the one validating the request."""

    permission_classes = [IsAuthenticated]
    serializer_class = TapCredentialUpdateSerializer

    def get_queryset(self) -> QuerySet[TapCredential]:
        return TapCredential.objects.all()

    def patch(self, request: Request, pk: str) -> Response:
        credential = get_object_or_404(self.get_queryset(), pk=pk)
        user = request.user
        assert isinstance(user, User)
        if credential.passenger_id != user.id:
            return Response(
                {"detail": "You cannot manage another passenger's credential."},
                status=status.HTTP_403_FORBIDDEN,
            )
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        updated = revoke_credential(credential=credential, revoked_by=user)
        return Response(TapCredentialSerializer(updated).data)


# --- Tap recording (staff/validator-facing) ---------------------------------


@extend_schema(
    request=TapRecordSerializer, responses=TapEventSerializer, parameters=[_IDEMPOTENCY_KEY_PARAM]
)
class TapRecordView(generics.GenericAPIView[Trip]):
    """POST /trips/{trip_id}/taps/ — the validator action, gated on
    `tapngo.record`. See docs/specs/4b-tap-and-go.md's "Operator harness"
    section: this endpoint is what that harness drives."""

    permission_classes = [HasPermission("tapngo.record")]
    serializer_class = TapRecordSerializer

    def get_queryset(self) -> QuerySet[Trip]:
        return Trip.objects.select_related("route", "business").all()

    def post(self, request: Request, trip_id: str) -> Response:
        idempotency_key = request.headers.get("Idempotency-Key")
        if not idempotency_key:
            return Response(
                {"detail": "Idempotency-Key header is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        trip = get_object_or_404(self.get_queryset(), pk=trip_id)
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            tap_event = record_tap(
                trip=trip,
                token=serializer.validated_data["token"],
                tap_type=serializer.validated_data["tap_type"],
                stop=serializer.validated_data["stop_id"],
                idempotency_key=idempotency_key,
            )
        except UnknownToken as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_404_NOT_FOUND)
        except CredentialInactive as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_403_FORBIDDEN)
        except (TripNotTapAndGo, TripNotOpenForTaps, StopNotOnRoute, InvalidAlightStop) as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except OpenJourneyExists as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)
        except NoOpenJourney as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_404_NOT_FOUND)
        except IdempotencyKeyConflict as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)
        return Response(TapEventSerializer(tap_event).data, status=status.HTTP_201_CREATED)


# --- Fare journeys -----------------------------------------------------


@extend_schema_view(get=extend_schema(parameters=[_TRIP_QUERY_PARAM, _STATUS_QUERY_PARAM]))
class FareJourneyListView(generics.ListAPIView[FareJourney]):
    """GET /fare-journeys/ — staff read-only visibility, gated on
    `tapngo.view`. No staff-side mutation of a journey exists this
    slice, matching `apps.booking.views.BookingListCreateView`'s GET
    branch."""

    permission_classes = [HasPermission("tapngo.view")]
    serializer_class = FareJourneySerializer

    def get_queryset(self) -> QuerySet[FareJourney]:
        queryset = FareJourney.objects.select_related(
            "trip__route", "board_stop", "alight_stop", "passenger"
        ).all()
        query = FareJourneyListQuerySerializer(data=self.request.query_params)
        query.is_valid(raise_exception=True)
        trip = query.validated_data.get("trip")
        status_filter = query.validated_data.get("status")
        if trip is not None:
            queryset = queryset.filter(trip=trip)
        if status_filter is not None:
            queryset = queryset.filter(status=status_filter)
        return queryset


class FareJourneyMineView(generics.ListAPIView[FareJourney]):
    """GET /fare-journeys/mine/ — the passenger's own journey history,
    parity with `apps.booking.views.BookingMineView`."""

    permission_classes = [IsAuthenticated]
    serializer_class = FareJourneySerializer

    def get_queryset(self) -> QuerySet[FareJourney]:
        user = self.request.user
        assert isinstance(user, User)
        return FareJourney.objects.select_related(
            "trip__route", "board_stop", "alight_stop", "passenger"
        ).filter(passenger=user)
