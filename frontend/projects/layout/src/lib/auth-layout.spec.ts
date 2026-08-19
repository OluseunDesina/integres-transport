import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AuthLayout } from './auth-layout';

@Component({
  imports: [AuthLayout],
  template: `<app-auth-layout><p>form goes here</p></app-auth-layout>`,
})
class HostComponent {}

describe('AuthLayout', () => {
  let fixture: ComponentFixture<HostComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
  });

  it('renders projected content inside the centered card', () => {
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('form goes here');
  });
});
