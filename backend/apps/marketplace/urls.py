from django.urls import path

from . import views

urlpatterns = [
    path(
        "marketplace/stops/suggest/",
        views.MarketplaceStopSuggestView.as_view(),
        name="marketplace-stop-suggest",
    ),
    path(
        "marketplace/trips/search/",
        views.MarketplaceTripSearchView.as_view(),
        name="marketplace-trip-search",
    ),
    path(
        "marketplace/trips/<uuid:pk>/availability/",
        views.MarketplaceTripAvailabilityView.as_view(),
        name="marketplace-trip-availability",
    ),
    path(
        "marketplace/trips/<uuid:pk>/fare/",
        views.MarketplaceTripFareView.as_view(),
        name="marketplace-trip-fare",
    ),
    path(
        "marketplace/bookings/",
        views.MarketplaceBookingCreateView.as_view(),
        name="marketplace-booking-create",
    ),
    path(
        "marketplace/payments/",
        views.MarketplacePaymentIntentCreateView.as_view(),
        name="marketplace-payment-create",
    ),
]
