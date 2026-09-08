from django.urls import path

from . import views

urlpatterns = [
    path("schedules/", views.ScheduleListCreateView.as_view(), name="schedule-list-create"),
    path("schedules/<uuid:pk>/", views.ScheduleUpdateView.as_view(), name="schedule-update"),
    path("trips/", views.TripListCreateView.as_view(), name="trip-list-create"),
    # Safe alongside `trips/<uuid:pk>/` — the uuid converter can never
    # match the literal "search".
    path("trips/search/", views.TripSearchView.as_view(), name="trip-search"),
    path(
        "trips/<uuid:pk>/",
        views.TripAssignmentUpdateView.as_view(),
        name="trip-assignment-update",
    ),
    path("trips/<uuid:pk>/status/", views.TripStatusView.as_view(), name="trip-status"),
    path("trips/<uuid:pk>/class/", views.TripClassView.as_view(), name="trip-class"),
]
