import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { Table } from './table';

@Component({
  imports: [Table],
  template: `<ui-table [loading]="loading" [empty]="empty" emptyMessage="No businesses yet.">
    <thead>
      <tr><th>Name</th></tr>
    </thead>
    <tbody>
      <tr><td>Acme Shuttle Co</td></tr>
    </tbody>
  </ui-table>`,
})
class HostComponent {
  loading = false;
  empty = false;
}

describe('Table', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders projected table content', () => {
    const table = fixture.debugElement.query(By.css('table'));
    expect(table.nativeElement.textContent).toContain('Acme Shuttle Co');
  });

  it('shows a loading state instead of the table', () => {
    host.loading = true;
    fixture.detectChanges();

    expect(fixture.debugElement.query(By.css('table'))).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Loading');
  });

  it('shows the empty message instead of the table', () => {
    host.empty = true;
    fixture.detectChanges();

    expect(fixture.debugElement.query(By.css('table'))).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('No businesses yet.');
  });
});
