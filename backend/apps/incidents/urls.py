from django.urls import path

from . import views

urlpatterns = [
    path("incidents/", views.IncidentListCreateView.as_view(), name="incident-list-create"),
    # Both literal paths sit above the `<uuid:pk>` route for readability;
    # the converter would not have matched them either way.
    path("incidents/report/", views.IncidentReportView.as_view(), name="incident-report"),
    path("incidents/mine/", views.IncidentMineView.as_view(), name="incident-mine"),
    path(
        "incidents/assignable-users/",
        views.AssignableUserListView.as_view(),
        name="incident-assignable-users",
    ),
    path("incidents/<uuid:pk>/", views.IncidentDetailView.as_view(), name="incident-detail"),
    path(
        "incidents/<uuid:pk>/transition/",
        views.IncidentTransitionView.as_view(),
        name="incident-transition",
    ),
    path("incidents/<uuid:pk>/notes/", views.IncidentNoteView.as_view(), name="incident-note"),
]
