import datetime

import factory
import factory.django

from apps.network.tests.factories import RouteFactory

from ..models import Schedule, Trip


class ScheduleFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Schedule

    client = factory.SubFactory("apps.clients.tests.factories.ClientFactory")
    route = factory.SubFactory(RouteFactory, client=factory.SelfAttribute("..client"))
    business = factory.LazyAttribute(lambda o: o.route.business)
    days_of_week = [1, 2, 3, 4, 5]
    departure_time = datetime.time(7, 30)
    effective_from = datetime.date(2026, 1, 1)
    effective_until = None


class TripFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Trip

    client = factory.SubFactory("apps.clients.tests.factories.ClientFactory")
    schedule = None
    route = factory.SubFactory(RouteFactory, client=factory.SelfAttribute("..client"))
    business = factory.LazyAttribute(lambda o: o.route.business)
    service_date = datetime.date(2026, 8, 10)
    scheduled_departure_at = datetime.datetime(2026, 8, 10, 6, 30, tzinfo=datetime.UTC)
    status = Trip.Status.SCHEDULED
    booking_mode = "reservation"
