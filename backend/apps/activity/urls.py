from django.urls import path

from . import views

urlpatterns = [
    path("activity/mine/", views.ActivityMineView.as_view(), name="activity-mine"),
]
