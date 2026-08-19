import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ForbiddenPage } from './forbidden-page';

describe('ForbiddenPage', () => {
  let fixture: ComponentFixture<ForbiddenPage>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ForbiddenPage] });
    fixture = TestBed.createComponent(ForbiddenPage);
    fixture.detectChanges();
  });

  it('renders an access-denied heading', () => {
    const heading = fixture.nativeElement.querySelector('h1') as HTMLElement;
    expect(heading.textContent).toContain("don't have access");
  });
});
