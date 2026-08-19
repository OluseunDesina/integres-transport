from rest_framework import serializers


class HealthSerializer(serializers.Serializer):
    status = serializers.CharField()


class ReadinessSerializer(serializers.Serializer):
    status = serializers.CharField()
    database = serializers.CharField(required=False)
