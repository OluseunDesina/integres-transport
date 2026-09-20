from django.urls import path

from . import views

urlpatterns = [
    path("bookings/", views.BookingListCreateView.as_view(), name="booking-list-create"),
    path("bookings/mine/", views.BookingMineView.as_view(), name="booking-mine"),
    # Before the <uuid:pk> route below, though it could not collide with
    # it anyway — "staff" is not a UUID. Placed by reading order: the two
    # collection-level POSTs sit together.
    path("bookings/staff/", views.StaffBookingCreateView.as_view(), name="booking-staff-create"),
    path("bookings/<uuid:pk>/cancel/", views.BookingCancelView.as_view(), name="booking-cancel"),
    path(
        "bookings/<uuid:pk>/reservations/<uuid:reservation_pk>/change-seat/",
        views.BookingChangeSeatView.as_view(),
        name="booking-change-seat",
    ),
    # Under trips/, but owned here: the app that owns the data owns the
    # endpoint, the same way apps.fares owns trips/{id}/fare/.
    path("trips/<uuid:pk>/manifest/", views.TripManifestView.as_view(), name="trip-manifest"),
]
