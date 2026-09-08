import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { StatusPill, StatusPillTone } from './status-pill';

@Component({
  imports: [StatusPill],
  template: `<ui-status-pill [label]="label" [tone]="tone" />`,
})
class HostComponent {
  label = 'Approved';
  tone: StatusPillTone = 'positive';
}

describe('StatusPill', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders the label text', () => {
    const span = fixture.debugElement.query(By.css('span')).nativeElement as HTMLElement;
    expect(span.textContent).toContain('Approved');
  });

  it('defaults to neutral tone styling', () => {
    host.label = 'Pending';
    host.tone = 'neutral';
    fixture.detectChanges();

    const span = fixture.debugElement.query(By.css('span')).nativeElement as HTMLElement;
    expect(span.classList).toContain('bg-surface-sunken');
  });

  it('applies negative tone styling', () => {
    host.tone = 'negative';
    fixture.detectChanges();

    const span = fixture.debugElement.query(By.css('span')).nativeElement as HTMLElement;
    expect(span.classList).toContain('bg-danger-surface');
    expect(span.classList).toContain('text-danger');
  });

  it('keeps its label on one line', () => {
    // A `rounded-full` pill that wraps reads as a broken shape rather
    // than a status — visible on "Pending payment" in a narrow bookings
    // column during slice 3b's visual pass.
    const span = fixture.debugElement.query(By.css('span')).nativeElement as HTMLElement;
    expect(span.classList).toContain('whitespace-nowrap');
  });
});
