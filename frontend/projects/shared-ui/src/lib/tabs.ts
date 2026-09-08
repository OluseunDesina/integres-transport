import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  output,
  viewChildren,
} from '@angular/core';

let nextId = 0;

export interface TabItem {
  id: string;
  label: string;
  disabled?: boolean;
}

/**
 * The WAI-ARIA tabs pattern, for sectioned detail screens.
 *
 * Renders the tab list and **one** panel element, whose content the
 * caller swaps with `@if`. A component that owned every panel would have
 * to hold every panel's content live at once, which for a detail screen
 * means fetching all of it up front.
 *
 * One panel means `aria-controls` cannot point every tab at its own
 * panel, so only the selected tab carries it. That is the correct
 * reading of the spec — `aria-controls` names the element a tab
 * *currently* controls, and an unselected tab controls nothing that
 * exists.
 *
 * **Selection follows focus** (automatic activation). The pattern
 * recommends this when revealing a panel is cheap, and reserves manual
 * activation (arrow to move, Enter to select) for panels that are
 * expensive to build — a caller whose panel triggers a fetch should
 * debounce the fetch rather than ask for a different keyboard model,
 * because the two models are indistinguishable to a mouse user and only
 * one of them is what keyboard users expect here.
 *
 * Roving tabindex: exactly one tab is in the tab order, so Tab moves
 * past the whole list to the panel rather than through every tab.
 */
@Component({
  selector: 'ui-tabs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div class="flex flex-col" style="gap: var(--ui-gutter)">
      <!-- The keydown handler is on each tab, not on the tablist. The
           tablist is not focusable (only its tabs are, via roving
           tabindex), and a key listener on an unfocusable container can
           only ever fire by accident of bubbling. -->
      <div
        role="tablist"
        [attr.aria-label]="ariaLabel()"
        class="flex gap-1 overflow-x-auto border-b border-border"
      >
        @for (tab of tabs(); track tab.id) {
          <button
            #tabButton
            type="button"
            role="tab"
            [id]="tabId(tab.id)"
            [attr.aria-selected]="tab.id === activeId()"
            [attr.aria-controls]="tab.id === activeId() ? panelId : null"
            [attr.aria-disabled]="tab.disabled ? true : null"
            [tabIndex]="tab.id === activeId() ? 0 : -1"
            (click)="select(tab)"
            (keydown)="onKeydown($event)"
            class="-mb-px shrink-0 border-b-2 px-4 py-2 text-sm font-medium whitespace-nowrap focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
            [class.border-primary]="tab.id === activeId()"
            [class.text-strong]="tab.id === activeId()"
            [class.border-transparent]="tab.id !== activeId()"
            [class.text-muted]="tab.id !== activeId() && !tab.disabled"
            [class.hover:text-default]="tab.id !== activeId() && !tab.disabled"
            [class.text-border]="!!tab.disabled && tab.id !== activeId()"
            [class.cursor-not-allowed]="!!tab.disabled"
          >
            {{ tab.label }}
          </button>
        }
      </div>
      <div [id]="panelId" role="tabpanel" [attr.aria-labelledby]="activeTabId()" tabindex="0">
        <ng-content />
      </div>
    </div>
  `,
})
export class Tabs {
  readonly tabs = input.required<TabItem[]>();
  readonly activeId = input.required<string>();
  readonly ariaLabel = input.required<string>();
  readonly activeIdChange = output<string>();

  private readonly tabButtons = viewChildren<ElementRef<HTMLButtonElement>>('tabButton');

  private readonly instanceId = `ui-tabs-${nextId++}`;
  protected readonly panelId = `${this.instanceId}-panel`;

  protected tabId(id: string): string {
    return `${this.instanceId}-tab-${id}`;
  }

  /** `aria-labelledby` on the panel must name the tab that owns it. */
  protected readonly activeTabId = computed(() => {
    const active = this.tabs().find((tab) => tab.id === this.activeId());
    return active ? this.tabId(active.id) : null;
  });

  protected select(tab: TabItem): void {
    if (tab.disabled || tab.id === this.activeId()) {
      return;
    }
    this.activeIdChange.emit(tab.id);
  }

  protected onKeydown(event: KeyboardEvent): void {
    const enabled = this.tabs().filter((tab) => !tab.disabled);
    if (enabled.length === 0) {
      return;
    }

    const current = enabled.findIndex((tab) => tab.id === this.activeId());
    let nextIndex: number;

    switch (event.key) {
      case 'ArrowRight':
        // Wraps, per the pattern — a tab list is a ring, and stopping at
        // the end is a common and needless dead end.
        nextIndex = (current + 1 + enabled.length) % enabled.length;
        break;
      case 'ArrowLeft':
        nextIndex = (current - 1 + enabled.length) % enabled.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = enabled.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const next = enabled[nextIndex];
    this.select(next);
    this.focusTab(next.id);
  }

  private focusTab(id: string): void {
    const index = this.tabs().findIndex((tab) => tab.id === id);
    this.tabButtons()[index]?.nativeElement.focus();
  }
}
