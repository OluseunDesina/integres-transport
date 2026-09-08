import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { API_CLIENT } from '@api-client';

import { WalletLookup } from './wallet-lookup';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';

class FakeSelectedBusinessStore {
  selectedBusinessId = signal<string | null>('biz-1');
}

const PASSENGER = {
  id: 'passenger-1',
  first_name: 'Ada',
  last_name: 'Obi',
  email: 'a••••••@example.com',
};

describe('WalletLookup', () => {
  let fixture: ComponentFixture<WalletLookup>;
  let component: WalletLookup;
  let apiClient: { GET: jasmine.Spy };
  let selectedBusinessStore: FakeSelectedBusinessStore;

  /** The screen makes two calls in order — resolve the person, then
   * read their wallet — so the spy answers by path rather than by call
   * count, which would break the moment either gains a call. */
  function respond(byPath: Record<string, unknown>): void {
    apiClient.GET.and.callFake((path: string) => Promise.resolve(byPath[path]));
  }

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

    expect(fixture.nativeElement.textContent).toContain(
      'Select a business before looking up a wallet.'
    );
  });

  it('does not call the API when the email field is left blank', async () => {
    await component['onSubmit']();

    expect(apiClient.GET).not.toHaveBeenCalled();
    expect(component['form'].controls.email.touched).toBeTrue();
  });

  it('renders a validation message for an incomplete address', () => {
    component['form'].controls.email.setValue('ada');
    component['form'].controls.email.markAsTouched();
    fixture.detectChanges();

    // Asserted on rendered output, not on "the request did not happen" —
    // the standing rule for this repo's form fields.
    expect(fixture.nativeElement.textContent).toContain('Enter a complete email address.');
  });

  it('resolves the passenger by email, then reads their wallet by id', async () => {
    respond({
      '/api/v1/passengers/lookup/': { data: PASSENGER },
      '/api/v1/wallet/': { data: { balance: '750.00', currency: 'NGN', transactions: [] } },
    });
    component['form'].controls.email.setValue('ada.obi@example.com');

    await component['onSubmit']();
    fixture.detectChanges();

    expect(apiClient.GET).toHaveBeenCalledWith('/api/v1/passengers/lookup/', {
      params: { query: { email: 'ada.obi@example.com' } },
    });
    // The id the agent never had to type — the whole reason this screen
    // changed.
    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/wallet/',
      jasmine.objectContaining({
        params: { query: { business: 'biz-1', passenger: 'passenger-1' } },
      })
    );
    expect(fixture.nativeElement.textContent).toContain('NGN 750.00');
    expect(fixture.nativeElement.textContent).toContain('Ada Obi');
  });

  it('says nobody uses that address rather than showing an error box', async () => {
    respond({
      '/api/v1/passengers/lookup/': { data: undefined, error: {}, response: { status: 404 } },
    });
    component['form'].controls.email.setValue('nobody@example.com');

    await component['onSubmit']();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No passenger account uses that email');
    // And it does not go on to ask for a wallet it has no id for.
    expect(apiClient.GET).toHaveBeenCalledTimes(1);
  });

  it('renders the empty state when the wallet has no transactions', async () => {
    respond({
      '/api/v1/passengers/lookup/': { data: PASSENGER },
      '/api/v1/wallet/': { data: { balance: '0.00', currency: 'NGN', transactions: [] } },
    });
    component['form'].controls.email.setValue('ada.obi@example.com');

    await component['onSubmit']();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No transactions yet');
  });

  it('renders each transaction row when present', async () => {
    respond({
      '/api/v1/passengers/lookup/': { data: PASSENGER },
      '/api/v1/wallet/': {
        data: {
          balance: '750.00',
          currency: 'NGN',
          transactions: [
            { id: 'txn-1', amount: '750.00', currency: 'NGN', created_at: '2026-08-10T00:00:00Z' },
          ],
        },
      },
    });
    component['form'].controls.email.setValue('ada.obi@example.com');

    await component['onSubmit']();
    fixture.detectChanges();

    const rows = fixture.debugElement.queryAll(By.css('tbody tr'));
    expect(rows.length).toBe(1);
    expect(rows[0].nativeElement.textContent).toContain('750.00 NGN');
  });

  it('shows the server error message when the wallet read fails', async () => {
    respond({
      '/api/v1/passengers/lookup/': { data: PASSENGER },
      '/api/v1/wallet/': { error: { detail: 'No wallet found for that passenger.' } },
    });
    component['form'].controls.email.setValue('ada.obi@example.com');

    await component['onSubmit']();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No wallet found for that passenger.');
  });
});
