import factory
import factory.django
from django.utils import timezone

from ..models import Notification


class NotificationFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Notification

    client = factory.SubFactory("apps.clients.tests.factories.ClientFactory")
    recipient = factory.SubFactory("apps.identity.tests.factories.ClientStaffUserFactory")
    notification_type = Notification.NotificationType.LICENSE_EXPIRING
    title = "Test notification"
    body = "Test notification body."
    related_object_type = "Driver"
    related_object_id = factory.Faker("uuid4")
    notified_for_date = factory.LazyFunction(lambda: timezone.now().date())
