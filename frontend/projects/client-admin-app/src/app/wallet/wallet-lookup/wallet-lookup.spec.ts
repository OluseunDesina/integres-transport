import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { API_CLIENT } from '@api-client';

import { WalletLookup } from './wallet-lookup';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';

class FakeSelectedBusinessStore {
  selectedBusinessId = signal<string | null>('biz-1');
}

describe('WalletLookup', () => {
  let fixture: ComponentFixture<WalletLookup>;
  let component: WalletLookup;
  let apiClient: { GET: jasmine.Spy };
  let selectedBusinessStore: FakeSelectedBusinessStore;

  beforeEach(async () => {
    apiClient = { GET: jasmine.createSpy('GET') };
    selectedBusinessStore = new FakeSelectedBusinessStore();

    await TestBed.configureTestingModule({
      imports: [WalletLookup],
      providers: [
        { provide: API_CLIENT, useValue: apiClient },
        { provide: SelectedBusinessStore, useValue: selectedBusinessStore },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(WalletLookup);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('warns that a business must be selected first when none is active', () => {
    selectedBusinessStore.selectedBusinessId.set(null);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Select a business before looking up a wallet.');
  });

  it('does not call the API when the passenger id field is left blank', async () => {
    await component['onSubmit']();

    expect(apiClient.GET).not.toHaveBeenCalled();
    expect(component['form'].controls.passengerId.touched).toBeTrue();
  });

  it('looks up the wallet for the active Business and the typed passenger id', async () => {
    apiClient.GET.and.resolveTo({
      data: { balance: '750.00', currency: 'NGN', transactions: [] },
    });
    component['form'].controls.passengerId.setValue('passenger-1');

    await component['onSubmit']();
    fixture.detectChanges();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/wallet/',
      jasmine.objectContaining({
        params: { query: { business: 'biz-1', passenger: 'passenger-1' } },
      })
    );
    expect(fixture.nativeElement.textContent).toContain('NGN 750.00');
  });

  it('renders the empty state when the wallet has no transactions', async () => {
    apiClient.GET.and.resolveTo({
      data: { balance: '0.00', currency: 'NGN', transactions: [] },
    });
    component['form'].controls.passengerId.setValue('passenger-1');

    await component['onSubmit']();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No transactions yet');
  });

  it('renders each transaction row when present', async () => {
    apiClient.GET.and.resolveTo({
      data: {
        balance: '750.00',
        currency: 'NGN',
        transactions: [{ id: 'txn-1', amount: '750.00', currency: 'NGN', created_at: '2026-08-10T00:00:00Z' }],
      },
    });
    component['form'].controls.passengerId.setValue('passenger-1');

    await component['onSubmit']();
    fixture.detectChanges();

    const rows = fixture.debugElement.queryAll(By.css('tbody tr'));
    expect(rows.length).toBe(1);
    expect(rows[0].nativeElement.textContent).toContain('750.00 NGN');
  });

  it('shows the server error message when the lookup fails', async () => {
    apiClient.GET.and.resolveTo({ error: { detail: 'No wallet found for that passenger.' } });
    component['form'].controls.passengerId.setValue('unknown-passenger');

    await component['onSubmit']();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No wallet found for that passenger.');
  });
});
