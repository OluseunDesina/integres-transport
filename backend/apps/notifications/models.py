"""In-app notifications — see docs/specs/9-notifications.md.

`Notification` is `client`-scoped like every other `BaseModel` (no new
exception to "every row has a Client" — unlike `identity.User` or the
one deliberate `LedgerAccount.account_type="integra_commission"` row).
For the two compliance-expiry types and the ticket-unused-reminder
type, `client` is the recipient's own Client. For the two KYC/KYB
submission types, the *recipient* is platform staff with no Client of
their own — `client` there is the **submitting** Client's id (the
Client/Business whose document was submitted), since that Client
genuinely owns the underlying event; the row is just read by someone
outside it, the same way platform staff already routinely read other
Clients' data. See `apps.notifications.views.NotificationMineView` for
the read-side branch this implies.
"""

from django.db import models

from apps.core.models import BaseModel


class Notification(BaseModel):
    class NotificationType(models.TextChoices):
        LICENSE_EXPIRING = "license_expiring", "Driver license expiring"
        INSURANCE_EXPIRING = "insurance_expiring", "Vehicle insurance expiring"
        ROADWORTHINESS_EXPIRING = "roadworthiness_expiring", "Roadworthiness expiring"
        TICKET_UNUSED_REMINDER = "ticket_unused_reminder", "Unused ticket reminder"
        KYC_DOCUMENT_SUBMITTED = "kyc_document_submitted", "New KYC document submitted"
        KYB_DOCUMENT_SUBMITTED = "kyb_document_submitted", "New KYB document submitted"
        # docs/specs/17-incidents.md. Two types rather than one, because
        # "a serious problem was just reported" and "a problem you have
        # already seen just got worse" are different enough that a
        # recipient should be able to tell them apart from the title
        # alone.
        INCIDENT_REPORTED = "incident_reported", "Incident reported"
        INCIDENT_ESCALATED = "incident_escalated", "Incident escalated"

    recipient = models.ForeignKey("identity.User", on_delete=models.PROTECT, related_name="+")
    notification_type = models.CharField(max_length=32, choices=NotificationType.choices)
    title = models.CharField(max_length=255)
    body = models.TextField()
    related_object_type = models.CharField(max_length=64, blank=True)
    related_object_id = models.UUIDField(null=True, blank=True)
    # Only meaningful for the two expiry-warning types — the exact
    # `*_expires_at` value this particular row is about. Lets the sweep
    # tell "still the same unresolved problem" (re-nag) apart from
    # "renewed, then re-entered the window" (fresh cycle) without a
    # second tracking model — see apps.notifications.services.
    expiry_snapshot = models.DateField(null=True, blank=True)
    # The calendar day the sweep created this row on — the real dedup
    # key for the uniqueness constraint below. A plain "unique per
    # (recipient, type, target)" constraint (the spec's original draft)
    # would fire a warning exactly once per target, ever; keying on the
    # day instead is what lets the sweep re-notify on a later day while
    # still closing the same-day double-run race the constraint exists
    # to prevent.
    notified_for_date = models.DateField()
    read_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=[
                    "recipient",
                    "notification_type",
                    "related_object_type",
                    "related_object_id",
                    "notified_for_date",
                ],
                name="unique_notification_per_recipient_type_target_per_day",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.notification_type} for {self.recipient_id}"
