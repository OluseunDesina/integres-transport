from django.urls import path

from . import views

urlpatterns = [
    path(
        "telemetry/devices/",
        views.TelemetryDeviceListCreateView.as_view(),
        name="telemetry-device-list-create",
    ),
    path(
        "telemetry/devices/<uuid:pk>/",
        views.TelemetryDeviceUpdateView.as_view(),
        name="telemetry-device-update",
    ),
    path(
        "telemetry/positions/",
        views.PositionIngestView.as_view(),
        name="telemetry-position-ingest",
    ),
    # Registered here, not apps.scheduling.urls, even though the path is
    # under trips/ — matching how apps.booking owns trips/{id}/manifest/
    # and apps.fares owns trips/{id}/fare/: the app that owns the data
    # (VehicleLiveState/VehiclePosition) owns the endpoint.
    path("trips/live/", views.TripsLiveView.as_view(), name="trips-live"),
    path("trips/<uuid:pk>/live/", views.TripLiveDetailView.as_view(), name="trip-live-detail"),
]
