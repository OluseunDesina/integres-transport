import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

import { Home } from './home';

describe('Home', () => {
  let fixture: ComponentFixture<Home>;
  let component: Home;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Home],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(Home);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates', () => {
    expect(component).toBeTruthy();
  });

  it('shows a placeholder when no user is signed in', () => {
    const heading = fixture.nativeElement.querySelector('h1') as HTMLElement;
    expect(heading.textContent).toContain('Welcome,');
  });

  // Sign out moved to AppShell when home became a child route under it
  // (spec §4.1) — home no longer owns a second, duplicate control.
  it('sends the passenger to the search screen', async () => {
    const navigateSpy = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);

    await component['goToSearch']();

    expect(navigateSpy).toHaveBeenCalledWith(['/search']);
  });
});
