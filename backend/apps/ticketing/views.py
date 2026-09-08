"""Views for apps.ticketing — see docs/specs/6-ticketing.md."""

from django.db.models import QuerySet
from django.shortcuts import get_object_or_404
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import generics, status
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response

from apps.booking.models import Booking
from apps.core.idempotency import IdempotencyKeyConflict
from apps.core.permissions import HasPermission
from apps.identity.models import User
from apps.scheduling.models import Trip
from apps.tapngo.services import CredentialInactive, UnknownToken

from . import signing
from .models import Ticket
from .serializers import (
    RevokedTicketsResponseSerializer,
    SigningKeysResponseSerializer,
    TicketSerializer,
    TicketValidateSerializer,
    TicketValidationResultSerializer,
)
from .services import (
    AlreadyBoarded,
    InvalidSignature,
    NoTicketForCredential,
    TicketExpired,
    TicketNotYetValid,
    TicketRevoked,
    TripNotPrepaid,
    UnknownTicket,
    WrongTrip,
    validate_credential,
    validate_ticket,
)

_IDEMPOTENCY_KEY_PARAM = OpenApiParameter(
    "Idempotency-Key",
    str,
    OpenApiParameter.HEADER,
    required=True,
    description="Client-generated key. A retried request with the same key and body "
    "returns the original validation result rather than re-validating.",
)


class BookingTicketsView(generics.ListAPIView[Ticket]):
    """GET /bookings/{booking_id}/tickets/ — the passenger's own
    Tickets for one Booking (normally one, N for a group booking).
    Ownership-mismatch returns 403, matching
    `apps.booking.views.BookingCancelView`'s own precedent; a real but
    not-yet-`paid` Booking returns 404 (no Tickets exist yet), matching
    `PaystackAccountConfigView`'s "distinct 404 for a real-but-not-yet-
    configured state" precedent."""

    permission_classes = [IsAuthenticated]
    serializer_class = TicketSerializer

    def get_queryset(self) -> QuerySet[Ticket]:
        # Ownership and paid-status are already checked in list() below
        # before this is ever reached — this only runs on the success
        # path.
        #
        # `select_related` is load-bearing, not an optimisation:
        # TicketSerializer.trip_class reads through booking -> trip, so
        # without it every row costs two extra queries.
        return Ticket.objects.select_related("booking__trip").filter(
            booking_id=self.kwargs["booking_id"]
        )

    def list(self, request: Request, *args: object, **kwargs: object) -> Response:
        booking = get_object_or_404(Booking.objects.all(), pk=self.kwargs["booking_id"])
        user = request.user
        assert isinstance(user, User)
        if booking.passenger_id != user.id:
            return Response(
                {"detail": "You cannot view another passenger's tickets."},
                status=status.HTTP_403_FORBIDDEN,
            )
        if booking.status != Booking.Status.PAID:
            return Response(
                {"detail": "No tickets have been issued for this booking yet."},
                status=status.HTTP_404_NOT_FOUND,
            )
        return super().list(request, *args, **kwargs)


@extend_schema(responses=SigningKeysResponseSerializer)
class SigningKeysView(generics.GenericAPIView[Ticket]):
    """GET /ticketing/signing-keys/ — JWKS-shaped, every `kid` currently
    in `TICKET_SIGNING_KEYS`. `IsAuthenticated` only, no `ticketing.*`
    permission — this is low-sensitivity key material a future offline
    validator device needs to cache, not a privileged action.

    `@extend_schema` is required here, not optional — this view has no
    `serializer_class` (its response isn't backed by a model), the same
    reason `apps.tapngo.views.TapCredentialCreateView`'s own docstring
    already explains for that app's equivalent case."""

    permission_classes = [IsAuthenticated]
    serializer_class = SigningKeysResponseSerializer

    def get(self, request: Request) -> Response:
        keys = [
            {"kid": kid, "public_key": public_key}
            for kid, public_key in signing.public_keys().items()
        ]
        return Response({"keys": keys})


@extend_schema(responses=RevokedTicketsResponseSerializer)
class RevokedTicketsView(generics.GenericAPIView[Ticket]):
    """GET /ticketing/revoked/ — genuinely empty in practice this slice
    (nothing sets `Ticket.Status.REVOKED` yet — see
    docs/specs/6-ticketing.md's non-goals), but wired against the real
    query rather than hardcoded, so a future refund phase needs no
    endpoint change. `@extend_schema` required — see `SigningKeysView`'s
    own docstring."""

    permission_classes = [IsAuthenticated]
    serializer_class = RevokedTicketsResponseSerializer

    def get(self, request: Request) -> Response:
        revoked_ids = list(
            Ticket.objects.filter(status=Ticket.Status.REVOKED).values_list("id", flat=True)
        )
        return Response({"revoked_ticket_ids": [str(ticket_id) for ticket_id in revoked_ids]})


@extend_schema(
    request=TicketValidateSerializer,
    responses=TicketValidationResultSerializer,
    parameters=[_IDEMPOTENCY_KEY_PARAM],
)
class TicketValidateView(generics.GenericAPIView[Trip]):
    """POST /trips/{trip_id}/tickets/validate/ — the validator action,
    gated on `ticketing.validate`. Mirrors `apps.tapngo.views.TapRecordView`'s
    exact shape: `Idempotency-Key` header required before anything else,
    each typed exception from the service layer mapped to its own
    status.

    Takes either fare medium: a scanned ticket QR (`payload`) or a tap
    credential (`token`, docs/specs/10-booking-modes.md's universal
    tap). One endpoint rather than two, because both board the same
    `Ticket` and return the same result — a credential presented here
    is not a `TapEvent` and cannot be one, since `TapEvent.journey` is
    non-null and a prepaid trip opens no journey."""

    permission_classes = [HasPermission("ticketing.validate")]
    serializer_class = TicketValidateSerializer

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
        user = request.user
        assert isinstance(user, User)
        token = serializer.validated_data.get("token")
        try:
            if token:
                ticket = validate_credential(
                    trip=trip,
                    token=token,
                    validated_by=user,
                    idempotency_key=idempotency_key,
                )
            else:
                ticket = validate_ticket(
                    trip=trip,
                    payload=serializer.validated_data["payload"],
                    validated_by=user,
                    idempotency_key=idempotency_key,
                )
        except InvalidSignature as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except TicketNotYetValid as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except WrongTrip as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except TripNotPrepaid as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except UnknownToken as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_404_NOT_FOUND)
        except CredentialInactive as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_403_FORBIDDEN)
        except NoTicketForCredential as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_404_NOT_FOUND)
        except UnknownTicket as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_404_NOT_FOUND)
        except TicketExpired as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)
        except TicketRevoked as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)
        except AlreadyBoarded as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)
        except IdempotencyKeyConflict as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)

        ticket = Ticket.objects.select_related(
            "booking__passenger",
            "from_stop",
            "to_stop",
            "seat_reservation__seat",
        ).get(pk=ticket.pk)
        passenger = ticket.booking.passenger
        passenger_name = f"{passenger.first_name} {passenger.last_name}".strip() or passenger.email
        # Stops come off the Ticket itself now, not through
        # `seat_reservation` — an open-seating ticket has none. The seat
        # number is null for those, which is the honest answer: nobody
        # was assigned a seat, and showing a blank is better than the
        # validator inventing one (docs/specs/10-booking-modes.md).
        reservation = ticket.seat_reservation
        result = TicketValidationResultSerializer(
            {
                "status": ticket.status,
                "passenger_name": passenger_name,
                "seat_number": None if reservation is None else reservation.seat.seat_number,
                "from_stop": ticket.from_stop.name,
                "to_stop": ticket.to_stop.name,
                "trip_departure_at": trip.scheduled_departure_at,
                "booking_status": ticket.booking.status,
            }
        )
        return Response(result.data)
