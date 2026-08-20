from django.urls import path

from . import views

urlpatterns = [
    path("notifications/mine/", views.NotificationMineView.as_view(), name="notification-mine"),
    path(
        "notifications/<uuid:pk>/read/",
        views.NotificationReadView.as_view(),
        name="notification-read",
    ),
    path(
        "notifications/read-all/",
        views.NotificationReadAllView.as_view(),
        name="notification-read-all",
    ),
]
