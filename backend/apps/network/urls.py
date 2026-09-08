from django.urls import path

from . import views

urlpatterns = [
    path("routes/", views.RouteListCreateView.as_view(), name="route-list-create"),
    # Safe above/below `routes/<uuid:pk>/` either way — the uuid
    # converter can never match the literal "browse".
    path("routes/browse/", views.RouteBrowseView.as_view(), name="route-browse"),
    path("routes/<uuid:pk>/", views.RouteDetailView.as_view(), name="route-detail"),
    path("routes/<uuid:pk>/status/", views.RouteStatusView.as_view(), name="route-status"),
    path(
        "routes/<uuid:pk>/duplicate/",
        views.RouteDuplicateView.as_view(),
        name="route-duplicate",
    ),
    path("routes/<uuid:pk>/stops/", views.RouteStopsView.as_view(), name="route-stops-update"),
    path("stops/", views.StopListCreateView.as_view(), name="stop-list-create"),
    path("stops/<uuid:pk>/", views.StopUpdateView.as_view(), name="stop-update"),
]
