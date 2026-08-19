from django.urls import path

from . import views

urlpatterns = [
    path(
        "tap-credentials/",
        views.TapCredentialCreateView.as_view(),
        name="tap-credential-create",
    ),
    path(
        "tap-credentials/mine/",
        views.TapCredentialMineView.as_view(),
        name="tap-credential-mine",
    ),
    path(
        "tap-credentials/<uuid:pk>/",
        views.TapCredentialUpdateView.as_view(),
        name="tap-credential-update",
    ),
    path("trips/<uuid:trip_id>/taps/", views.TapRecordView.as_view(), name="tap-record"),
    path("fare-journeys/", views.FareJourneyListView.as_view(), name="fare-journey-list"),
    path("fare-journeys/mine/", views.FareJourneyMineView.as_view(), name="fare-journey-mine"),
]
