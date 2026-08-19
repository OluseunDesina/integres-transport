from django.urls import path

from . import views

urlpatterns = [
    path("health/", views.health, name="health"),
    path("readiness/", views.readiness, name="readiness"),
    path(
        "internal/tasks/generate-trips/",
        views.GenerateTripsView.as_view(),
        name="internal-task-generate-trips",
    ),
    path(
        "internal/tasks/expire-seat-holds/",
        views.ExpireSeatHoldsView.as_view(),
        name="internal-task-expire-seat-holds",
    ),
]
