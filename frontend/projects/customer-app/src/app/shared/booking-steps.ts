import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type BookingStep = 'search' | 'seats' | 'confirm';

const STEPS: { id: BookingStep; label: string }[] = [
  { id: 'search', label: 'Find a trip' },
  { id: 'seats', label: 'Choose seats' },
  { id: 'confirm', label: 'Review' },
];

/**
 * Where the passenger is in the booking flow — spec 14's "a visible step
 * indicator through search → seats/places → confirm".
 *
 * Three steps, not four. **Payment is deliberately absent**: it happens
 * later, from `my-bookings`, and often not in the same session — a
 * booking is created `pending_payment` and can be paid minutes or hours
 * afterwards. Drawing a fourth step here would promise a screen this
 * flow does not reach, and would make the last step look unfinished when
 * it is in fact complete.
 *
 * Local to `customer-app` rather than in `@shared-ui`: no console has a
 * wizard, so this would be a library component with a single consumer.
 *
 * Marked up as an ordered list with `aria-current="step"` on the active
 * item, which is the pattern assistive technology already understands —
 * a row of coloured pills with no structure would be a picture of
 * progress rather than a statement of it. The step *number* is real text
 * for the same reason: at 390px the labels are the first thing to be
 * squeezed, and "2 of 3" must survive that.
 */
@Component({
  selector: 'app-booking-steps',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <nav [attr.aria-label]="'Booking progress, step ' + position() + ' of ' + total">
      <!-- Below the sm breakpoint only the current step is named. Three
           labels, three numerals and two connectors do not fit 390px:
           iteration-15 photographed them truncated to "Find a t...",
           "Choose se..." and "Revi...", which is worse than no label at
           all. The numbered dots still show how far along the passenger
           is, and the one label they need is the step they are on.

           The other labels stay in the DOM for assistive technology
           either way -- sr-only, not hidden -- so the list still reads
           as three named steps however narrow the screen is. -->
      <ol class="flex items-center gap-2">
        @for (step of steps; track step.id; let index = $index) {
          <li class="flex min-w-0 items-center gap-2">
            <span
              class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
              [class.bg-primary]="index <= activeIndex()"
              [class.text-on-primary]="index <= activeIndex()"
              [class.bg-surface-sunken]="index > activeIndex()"
              [class.text-muted]="index > activeIndex()"
              aria-hidden="true"
            >
              {{ index + 1 }}
            </span>
            <span
              class="text-sm"
              [class.sr-only]="index !== activeIndex()"
              [class.sm:not-sr-only]="index !== activeIndex()"
              [class.font-medium]="index === activeIndex()"
              [class.text-strong]="index === activeIndex()"
              [class.text-muted]="index !== activeIndex()"
              [attr.aria-current]="index === activeIndex() ? 'step' : null"
            >
              {{ step.label }}
            </span>
            @if (index < total - 1) {
              <span
                class="h-px w-4 shrink-0 sm:w-8"
                [class.bg-primary]="index < activeIndex()"
                [class.bg-border]="index >= activeIndex()"
                aria-hidden="true"
              ></span>
            }
          </li>
        }
      </ol>
    </nav>
  `,
})
export class BookingSteps {
  readonly current = input.required<BookingStep>();

  protected readonly steps = STEPS;
  protected readonly total = STEPS.length;
  protected readonly activeIndex = computed(() =>
    STEPS.findIndex((step) => step.id === this.current())
  );
  protected readonly position = computed(() => this.activeIndex() + 1);
}
