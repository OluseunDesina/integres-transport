import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { Component, TemplateRef, ViewChild, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { ConfirmDialog } from './confirm-dialog';
import type { ConfirmDialogData } from './confirm-dialog';

@Component({ template: `<ng-template #tpl><p>Reason field stub</p></ng-template>` })
class TemplateHost {
  @ViewChild('tpl', { static: true }) readonly tpl!: TemplateRef<unknown>;
}

describe('ConfirmDialog', () => {
  let fixture: ComponentFixture<ConfirmDialog>;
  let dialogRefSpy: jasmine.SpyObj<DialogRef<boolean>>;
  let onConfirm: jasmine.Spy;
  let confirmDisabled: ReturnType<typeof signal<boolean>>;

  beforeEach(() => {
    const templateFixture = TestBed.createComponent(TemplateHost);
    templateFixture.detectChanges();
    const bodyTemplate = templateFixture.componentInstance.tpl;

    TestBed.resetTestingModule();

    dialogRefSpy = jasmine.createSpyObj<DialogRef<boolean>>('DialogRef', ['close'], {
      disableClose: false,
    });
    onConfirm = jasmine.createSpy('onConfirm');
    confirmDisabled = signal(false);

    const data: ConfirmDialogData = {
      title: 'Reject KYC submission?',
      bodyTemplate,
      confirmLabel: signal('Reject'),
      danger: signal(true),
      confirmDisabled,
      onConfirm,
    };

    TestBed.configureTestingModule({
      imports: [ConfirmDialog],
      providers: [
        { provide: DIALOG_DATA, useValue: data },
        { provide: DialogRef, useValue: dialogRefSpy },
      ],
    });
    fixture = TestBed.createComponent(ConfirmDialog);
    fixture.detectChanges();
  });

  it('renders the title and projected body', () => {
    expect(fixture.nativeElement.textContent).toContain('Reject KYC submission?');
    expect(fixture.nativeElement.textContent).toContain('Reason field stub');
  });

  it('disables Confirm reactively as the caller-owned signal changes', () => {
    const confirmButton = () => fixture.debugElement.queryAll(By.css('button'))[1].nativeElement;

    confirmDisabled.set(true);
    fixture.detectChanges();
    expect((confirmButton() as HTMLButtonElement).disabled).toBeTrue();

    confirmDisabled.set(false);
    fixture.detectChanges();
    expect((confirmButton() as HTMLButtonElement).disabled).toBeFalse();
  });

  it('closes with true when onConfirm resolves ok', async () => {
    onConfirm.and.resolveTo({ ok: true });
    fixture.debugElement.queryAll(By.css('button'))[1].nativeElement.click();
    await fixture.whenStable();

    expect(dialogRefSpy.close).toHaveBeenCalledWith(true);
  });

  it('shows the server error inline and does not close on validation failure', async () => {
    onConfirm.and.resolveTo({ ok: false, error: 'A reason is required when rejecting.' });
    fixture.debugElement.queryAll(By.css('button'))[1].nativeElement.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(dialogRefSpy.close).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('A reason is required when rejecting.');
  });

  it('closes with false on Cancel without calling onConfirm', () => {
    fixture.debugElement.queryAll(By.css('button'))[0].nativeElement.click();

    expect(dialogRefSpy.close).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
