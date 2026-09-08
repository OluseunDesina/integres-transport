import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { Component, TemplateRef, ViewChild, inject, viewChild } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { DRAWER_TITLE_ID, Drawer, DrawerService, type DrawerData } from './drawer';

@Component({
  template: `
    <ng-template #body><p>Registration field stub</p></ng-template>
    <ng-template #footer><button type="button">Save</button></ng-template>
  `,
})
class TemplateHost {
  @ViewChild('body', { static: true }) readonly body!: TemplateRef<unknown>;
  @ViewChild('footer', { static: true }) readonly footer!: TemplateRef<unknown>;
}

function buildTemplates(): { body: TemplateRef<unknown>; footer: TemplateRef<unknown> } {
  const templateFixture = TestBed.createComponent(TemplateHost);
  templateFixture.detectChanges();
  const { body, footer } = templateFixture.componentInstance;
  TestBed.resetTestingModule();
  return { body, footer };
}

describe('Drawer', () => {
  let fixture: ComponentFixture<Drawer>;
  let dialogRefSpy: jasmine.SpyObj<DialogRef<unknown>>;

  function render(data: Partial<DrawerData>): void {
    const { body, footer } = buildTemplates();
    dialogRefSpy = jasmine.createSpyObj<DialogRef<unknown>>('DialogRef', ['close']);

    TestBed.configureTestingModule({
      imports: [Drawer],
      providers: [
        {
          provide: DIALOG_DATA,
          useValue: { title: 'Edit vehicle', bodyTemplate: body, footerTemplate: footer, ...data },
        },
        { provide: DialogRef, useValue: dialogRefSpy },
      ],
    });
    fixture = TestBed.createComponent(Drawer);
    fixture.detectChanges();
  }

  it('renders its title with the id the open config labels the panel by', () => {
    // ariaModal defaults off and ariaLabelledBy has no automatic wiring
    // in plain @angular/cdk/dialog — DrawerService supplies both, and
    // this id is the contract between them.
    render({});
    const heading = fixture.debugElement.query(By.css('h2')).nativeElement as HTMLElement;
    expect(heading.id).toBe(DRAWER_TITLE_ID);
    expect(heading.textContent).toContain('Edit vehicle');
  });

  it('projects the body template, keeping the caller injection context', () => {
    render({});
    expect(fixture.nativeElement.textContent).toContain('Registration field stub');
  });

  it('projects a footer when one is given', () => {
    render({});
    expect(fixture.debugElement.query(By.css('footer'))).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Save');
  });

  it('renders no footer element at all when there is nothing to pin', () => {
    render({ footerTemplate: undefined });
    expect(fixture.debugElement.query(By.css('footer'))).toBeNull();
  });

  it('renders an optional description', () => {
    render({ description: 'Changes apply immediately.' });
    expect(fixture.nativeElement.textContent).toContain('Changes apply immediately.');
  });

  it('gives the close control a real accessible name', () => {
    render({});
    const close = fixture.debugElement
      .queryAll(By.css('button'))
      .find(
        (el) => (el.nativeElement as HTMLElement).getAttribute('aria-label') === 'Close panel',
      );
    expect(close).toBeDefined();
  });

  it('closes through the DialogRef, not by hiding itself', () => {
    render({});
    const close = fixture.debugElement
      .queryAll(By.css('button'))
      .find(
        (el) => (el.nativeElement as HTMLElement).getAttribute('aria-label') === 'Close panel',
      )!;
    (close.nativeElement as HTMLButtonElement).click();
    expect(dialogRefSpy.close).toHaveBeenCalled();
  });
});

@Component({
  template: `<ng-template #body><p>Panel body</p></ng-template>`,
})
class OpenerHost {
  private readonly drawers = inject(DrawerService);
  readonly body = viewChild.required<TemplateRef<unknown>>('body');

  open(): void {
    this.drawers.open({ title: 'Edit vehicle', bodyTemplate: this.body() });
  }
}

describe('DrawerService', () => {
  let fixture: ComponentFixture<OpenerHost>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [OpenerHost] });
    fixture = TestBed.createComponent(OpenerHost);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('opens a modal panel labelled by its own heading', () => {
    fixture.componentInstance.open();
    fixture.detectChanges();

    const container = document.querySelector('cdk-dialog-container')!;
    expect(container).not.toBeNull();
    expect(container.getAttribute('aria-modal')).toBe('true');
    expect(container.getAttribute('aria-labelledby')).toBe(DRAWER_TITLE_ID);
  });

  it('renders the caller template inside the panel', () => {
    fixture.componentInstance.open();
    fixture.detectChanges();
    expect(document.querySelector('cdk-dialog-container')!.textContent).toContain('Panel body');
  });

  it('moves focus into the panel, onto its heading', () => {
    // 'first-heading', not a CSS selector: a bare <h2> is not focusable,
    // so a selector would silently no-op and leave focus on <body>
    // outside the trap.
    fixture.componentInstance.open();
    fixture.detectChanges();
    expect(document.activeElement?.id).toBe(DRAWER_TITLE_ID);
  });
});
