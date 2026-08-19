from django.urls import path

from . import views

urlpatterns = [
    path(
        "vehicle-types/",
        views.VehicleTypeListCreateView.as_view(),
        name="vehicle-type-list-create",
    ),
    path(
        "vehicle-types/<uuid:pk>/",
        views.VehicleTypeUpdateView.as_view(),
        name="vehicle-type-update",
    ),
    path("vehicles/", views.VehicleListCreateView.as_view(), name="vehicle-list-create"),
    path("vehicles/<uuid:pk>/", views.VehicleUpdateView.as_view(), name="vehicle-update"),
    path("drivers/", views.DriverListCreateView.as_view(), name="driver-list-create"),
    path("drivers/<uuid:pk>/", views.DriverUpdateView.as_view(), name="driver-update"),
]
