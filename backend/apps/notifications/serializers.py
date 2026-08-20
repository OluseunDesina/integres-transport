"""Serializers for apps.notifications — see docs/specs/9-notifications.md."""

from rest_framework import serializers

from .models import Notification


class NotificationSerializer(serializers.ModelSerializer[Notification]):
    class Meta:
        model = Notification
        fields = [
            "id",
            "notification_type",
            "title",
            "body",
            "related_object_type",
            "related_object_id",
            "read_at",
            "created_at",
        ]
        read_only_fields = fields


class NotificationListQuerySerializer(serializers.Serializer):
    unread_only = serializers.BooleanField(required=False, default=False)


class NotificationReadAllResponseSerializer(serializers.Serializer):
    marked_read = serializers.IntegerField()
