from django.urls import path
from rest_framework_simplejwt.views import TokenRefreshView

from . import views

urlpatterns = [
    path("customer/token/", views.CustomerTokenObtainView.as_view(), name="customer-token-obtain"),
    path(
        "client-admin/token/",
        views.ClientAdminTokenObtainView.as_view(),
        name="client-admin-token-obtain",
    ),
    path(
        "super-admin/token/",
        views.SuperAdminTokenObtainView.as_view(),
        name="super-admin-token-obtain",
    ),
    path("token/refresh/", TokenRefreshView.as_view(), name="token-refresh"),
    path("me/", views.MeView.as_view(), name="me"),
]
