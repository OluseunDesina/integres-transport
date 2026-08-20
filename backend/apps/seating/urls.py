from django.urls import path

from . import views

urlpatterns = [
    path(
        "vehicle-types/<uuid:pk>/seats/",
        views.VehicleTypeSeatsView.as_view(),
        name="vehicle-type-seats",
    ),
    path(
        "vehicle-types/<uuid:pk>/seats/generate/",
        views.VehicleTypeSeatsGenerateView.as_view(),
        name="vehicle-type-seats-generate",
    ),
    path(
        "trips/<uuid:pk>/availability/",
        views.TripAvailabilityView.as_view(),
        name="trip-availability",
    ),
]
