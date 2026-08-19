from django.urls import path

from . import views

urlpatterns = [
    path(
        "bookings/<uuid:booking_id>/tickets/",
        views.BookingTicketsView.as_view(),
        name="booking-tickets",
    ),
    path(
        "ticketing/signing-keys/",
        views.SigningKeysView.as_view(),
        name="ticketing-signing-keys",
    ),
    path("ticketing/revoked/", views.RevokedTicketsView.as_view(), name="ticketing-revoked"),
    path(
        "trips/<uuid:trip_id>/tickets/validate/",
        views.TicketValidateView.as_view(),
        name="ticket-validate",
    ),
]
