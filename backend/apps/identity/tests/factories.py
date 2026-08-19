import factory
import factory.django

from apps.clients.tests.factories import ClientFactory
from apps.identity.models import User


class PassengerUserFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = User
        skip_postgeneration_save = True

    email = factory.Sequence(lambda n: f"passenger{n}@example.com")
    client = factory.SubFactory(ClientFactory)
    is_client_staff = False
    is_platform_staff = False

    @factory.post_generation
    def password(obj: User, create: bool, extracted: str | None, **kwargs: object) -> None:
        obj.set_password(extracted or "testpass123")
        if create:
            obj.save()


class ClientStaffUserFactory(PassengerUserFactory):
    is_client_staff = True
    email = factory.Sequence(lambda n: f"staff{n}@example.com")

    @factory.post_generation
    def role(obj: User, create: bool, extracted: object, **kwargs: object) -> None:
        """Defaults to Owner-equivalent access (every seeded permission)
        so the ~20 tests written before Slice 4 retrofitted real
        permission checks keep passing unchanged — they only ever needed
        "some client staff member", never cared which permissions. Pass
        `role=<a specific Role>` explicitly to test permission
        *enforcement* instead (e.g. a Staff-role user blocked from a
        business.manage-gated endpoint).

        `role=None` does NOT mean "leave unset" — factory_boy can't tell
        "explicitly None" apart from "not provided" here, so both take
        the Owner-default path. To test a user with genuinely no role,
        create normally then set `.role = None` and save() afterward.
        """
        if not create:
            return
        if extracted is not None:
            obj.role = extracted  # type: ignore[assignment]
        else:
            from apps.identity.services import create_default_roles

            roles = create_default_roles(obj.client)
            obj.role = roles["Owner"]
        obj.save(update_fields=["role"])


class PlatformStaffUserFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = User
        skip_postgeneration_save = True

    email = factory.Sequence(lambda n: f"platform{n}@integra.example.com")
    client = None
    is_platform_staff = True
    is_staff = True

    @factory.post_generation
    def password(obj: User, create: bool, extracted: str | None, **kwargs: object) -> None:
        obj.set_password(extracted or "testpass123")
        if create:
            obj.save()
