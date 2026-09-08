"""Operational incidents and passenger issue reports — see
docs/specs/17-incidents.md.

One model, two entry points. `transit-admin-app-prompt.md` asks for
operator-created incidents with a queue and a status lifecycle;
`transit_os_architecture_updated.md` asks for passenger-submitted
hardware reports ("broken reader", "GPS inaccuracy", "wrong stop
announcement"). Building the operator queue alone would mean building
the passenger end again later against a schema that never anticipated
it, so `Incident.source` carries the distinction and everything else is
shared.

`IncidentActivity` is the append-only trail that *renders* — status
moves, assignment changes, severity changes and notes. It is
deliberately distinct from `apps.core.AuditLog`, which stays the
security/compliance record nobody sees. Both are written on every
status change.

Every FK uses `related_name="+"`, matching `apps.tapngo`/`apps.booking`:
a reverse accessor on an RLS-protected model traverses the same
`TenantScopedManager` that silently empties outside a tenancy context.
Batched `.filter(...)` queries are used instead wherever a "children of
X" query is needed.
"""

from django.db import models

from apps.businesses.models import Business
from apps.core.models import BaseModel
from apps.fleet.models import Driver, Vehicle
from apps.identity.models import User
from apps.network.models import Route, Stop
from apps.scheduling.models import Trip


class Incident(BaseModel):
    """One reported operational problem.

    **Every relation is nullable and `PROTECT`.** Nullable because a
    passenger reporting a broken reader on a platform may know none of
    them, and an incident with no trip is still worth recording.
    `PROTECT` because an incident that silently loses the vehicle it was
    about is worse than a delete that fails loudly — and it matches
    every other FK in this codebase.

    `latitude`/`longitude` mirror `network.Stop`'s existing precision
    exactly rather than inventing a second geographic convention. They
    are recorded exactly as the browser supplied them and never
    inferred; a report with no location is normal, not degraded.
    """

    class Category(models.TextChoices):
        HARDWARE = "hardware", "Hardware"
        VEHICLE = "vehicle", "Vehicle"
        SAFETY = "safety", "Safety"
        SERVICE = "service", "Service quality"
        GPS = "gps", "GPS / location"
        ANNOUNCEMENT = "announcement", "Stop announcement"
        OTHER = "other", "Other"

    class Severity(models.TextChoices):
        LOW = "low", "Low"
        MEDIUM = "medium", "Medium"
        HIGH = "high", "High"
        CRITICAL = "critical", "Critical"

    class Status(models.TextChoices):
        OPEN = "open", "Open"
        ACKNOWLEDGED = "acknowledged", "Acknowledged"
        INVESTIGATING = "investigating", "Investigating"
        RESOLVED = "resolved", "Resolved"
        CLOSED = "closed", "Closed"

    class Source(models.TextChoices):
        OPERATOR = "operator", "Operator"
        PASSENGER = "passenger", "Passenger"

    business = models.ForeignKey(Business, on_delete=models.PROTECT, related_name="+")
    reference = models.CharField(max_length=16)
    title = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    category = models.CharField(max_length=20, choices=Category.choices)
    severity = models.CharField(max_length=20, choices=Severity.choices, default=Severity.MEDIUM)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.OPEN)
    source = models.CharField(max_length=20, choices=Source.choices, default=Source.OPERATOR)

    trip = models.ForeignKey(
        Trip, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    route = models.ForeignKey(
        Route, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    vehicle = models.ForeignKey(
        Vehicle, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    driver = models.ForeignKey(
        Driver, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    stop = models.ForeignKey(
        Stop, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    # Free text, not a FK: there is no Device model in this system and
    # nothing reports in. A real device registry belongs with spec 20,
    # where hardware starts sending telemetry — this is enough to route a
    # fault to a human in the meantime.
    device_reference = models.CharField(max_length=64, blank=True)

    reported_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    assigned_to = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )

    latitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    longitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)

    resolved_at = models.DateTimeField(null=True, blank=True)
    resolution_notes = models.TextField(blank=True)

    class Meta:
        # Restated explicitly. A subclass declaring its own `Meta` (here,
        # for `constraints`/`indexes`) inherits *none* of
        # `BaseModel.Meta`'s options — the trap documented on
        # `apps.network.models.Route.Meta` and hit a second time by
        # `identity.Role`, which shipped unordered pagination because of
        # it.
        ordering = ["-created_at"]
        constraints = [
            # No `condition=Q(deleted_at__isnull=True)`: there is no such
            # conditioned constraint anywhere in this codebase — soft
            # delete is a manager concern (`TenantScopedManager` filters
            # it), never a constraint condition. A soft-deleted incident
            # keeping its reference reserved is also correct on its own
            # terms: the reference is what a passenger quotes on the
            # phone, and reissuing it would make two records answer to
            # one name.
            models.UniqueConstraint(
                fields=["business", "reference"],
                name="unique_incident_reference_per_business",
            ),
        ]
        indexes = [
            models.Index(fields=["business", "created_at"], name="incident_business_created"),
            models.Index(fields=["business", "status"], name="incident_business_status"),
            models.Index(fields=["business", "severity"], name="incident_business_severity"),
        ]

    def __str__(self) -> str:
        return f"{self.reference} ({self.status})"


class IncidentActivity(BaseModel):
    """Append-only trail. `CASCADE` from the incident — unlike every
    other FK here — because an activity row has no meaning without its
    incident, and the incident itself is soft-deleted via `BaseModel`
    rather than hard-deleted in normal operation."""

    class Kind(models.TextChoices):
        STATUS_CHANGE = "status_change", "Status change"
        ASSIGNMENT = "assignment", "Assignment"
        SEVERITY_CHANGE = "severity_change", "Severity change"
        NOTE = "note", "Note"

    incident = models.ForeignKey(Incident, on_delete=models.CASCADE, related_name="+")
    actor = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    kind = models.CharField(max_length=20, choices=Kind.choices)
    from_status = models.CharField(max_length=20, blank=True)
    to_status = models.CharField(max_length=20, blank=True)
    note = models.TextField(blank=True)

    class Meta:
        # Oldest first: a trail reads forwards. Restated for the same
        # reason as `Incident.Meta.ordering` above.
        ordering = ["created_at"]

    def __str__(self) -> str:
        return f"{self.kind} on {self.incident_id}"


#: Module-level so `SPECTACULAR_SETTINGS["ENUM_NAME_OVERRIDES"]` can
#: reach it: that setting resolves a dotted path with `import_string`,
#: which cannot walk into a nested class, so `Incident.Status.choices`
#: is not addressable. Exists to give the generated OpenAPI enum a
#: stable name (`IncidentStatusEnum`) rather than a hash of its own
#: values — see that setting's comment.
INCIDENT_STATUS_CHOICES = Incident.Status.choices

#: The statuses that count as "still someone's problem". Used by the
#: incidents list's own default and by `apps.analytics`' dashboard count,
#: so the two can never drift into disagreeing about what "open" means.
OPEN_STATUSES = (
    Incident.Status.OPEN,
    Incident.Status.ACKNOWLEDGED,
    Incident.Status.INVESTIGATING,
)
