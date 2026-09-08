import { ComponentFixture, TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { WalletScreen } from './wallet';

interface WithRedirect {
  redirectToPaystack(url: string): void;
}

function makeRoute(overrides: Record<string, unknown> = {}) {
  return {
    id: 'route-1',
    business: { id: 'biz-1', name: 'Lagos Shuttle Co' },
    name: 'Ikeja → CMS',
    code: 'IKJ-CMS',
    description: '',
    is_active: true,
    stops: [],
    created_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

function makeWallet(overrides: Record<string, unknown> = {}) {
  return {
    balance: '500.00',
    currency: 'NGN',
    transactions: [
      { id: 'txn-1', amount: '500.00', currency: 'NGN', created_at: '2026-08-10T00:00:00Z' },
    ],
    ...overrides,
  };
}

describe('WalletScreen', () => {
  let apiClient: { GET: jasmine.Spy; POST: jasmine.Spy };
  let fixture: ComponentFixture<WalletScreen>;
  let component: WalletScreen;

  async function createComponent(): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [WalletScreen],
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    }).compileComponents();

    fixture = TestBed.createComponent(WalletScreen);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(() => {
    apiClient = {
      GET: jasmine.createSpy('GET').and.resolveTo({ data: { count: 1, results: [makeRoute()] } }),
      POST: jasmine.createSpy('POST'),
    };
  });

  it('loads a deduped business picker from GET /routes/browse/', async () => {
    apiClient.GET.and.resolveTo({
      data: { count: 2, results: [makeRoute(), makeRoute({ id: 'route-2' })] },
    });

    await createComponent();

    expect(component['businessOptions']()).toEqual([
      { value: '', label: 'Select an operator' },
      { value: 'biz-1', label: 'Lagos Shuttle Co' },
    ]);
  });

  it('loads the wallet once a business is selected', async () => {
    await createComponent();
    apiClient.GET.and.resolveTo({ data: makeWallet() });

    await component['onBusinessChange']('biz-1');
    fixture.detectChanges();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/wallet/mine/',
      jasmine.objectContaining({ params: { query: { business: 'biz-1' } } })
    );
    expect(component['balanceLabel']()).toBe('NGN 500.00');
    expect(fixture.nativeElement.textContent).toContain('NGN 500.00');
  });

  it('surfaces the server error message when the wallet fails to load', async () => {
    await createComponent();
    apiClient.GET.and.resolveTo({ error: { detail: 'Unknown business.' } });

    await component['onBusinessChange']('biz-1');
    fixture.detectChanges();

    expect(component['walletError']()).toBe('Unknown business.');
  });

  it('does not submit a top-up with no business or amount selected', async () => {
    await createComponent();

    await component['topUp']();

    expect(apiClient.POST).not.toHaveBeenCalled();
  });

  it('redirects to Paystack on a successful top-up', async () => {
    await createComponent();
    apiClient.GET.and.resolveTo({ data: makeWallet() });
    await component['onBusinessChange']('biz-1');
    component['topupForm'].controls.amount.setValue('500.00');
    apiClient.POST.and.resolveTo({
      data: { id: 'intent-1', status: 'pending', authorization_url: 'https://paystack/checkout', reference: 'ref-1' },
    });
    const redirectSpy = spyOn(component as unknown as WithRedirect, 'redirectToPaystack');

    await component['topUp']();

    expect(apiClient.POST).toHaveBeenCalledWith(
      '/api/v1/payments/',
      jasmine.objectContaining({
        body: { use_wallet_balance: false, wallet_topup: { business_id: 'biz-1', amount: '500.00' } },
      })
    );
    expect(redirectSpy).toHaveBeenCalledWith('https://paystack/checkout');
  });

  it('shows the server error message when a top-up fails', async () => {
    await createComponent();
    apiClient.GET.and.resolveTo({ data: makeWallet() });
    await component['onBusinessChange']('biz-1');
    component['topupForm'].controls.amount.setValue('500.00');
    apiClient.POST.and.resolveTo({ error: { detail: 'This Business has no active Paystack account configured.' } });

    await component['topUp']();

    expect(component['topupError']()).toBe(
      'This Business has no active Paystack account configured.'
    );
  });

  /**
   * The amount was a bare string signal gated only on "not empty", so
   * every one of these reached `POST /payments/` and came back as
   * whatever DRF said about it.
   */
  describe('top-up amount validation', () => {
    async function withBusiness(amount: string): Promise<void> {
      await createComponent();
      apiClient.GET.and.resolveTo({ data: makeWallet() });
      await component['onBusinessChange']('biz-1');
      apiClient.POST.calls.reset();
      component['topupForm'].controls.amount.setValue(amount);
      await component['topUp']();
    }

    for (const amount of ['abc', '-5', '0', '12.345', '']) {
      it(`refuses to send ${JSON.stringify(amount)}`, async () => {
        await withBusiness(amount);

        expect(apiClient.POST).not.toHaveBeenCalled();
      });
    }

    it('accepts a whole number and two decimal places', async () => {
      await createComponent();
      apiClient.GET.and.resolveTo({ data: makeWallet() });
      await component['onBusinessChange']('biz-1');
      apiClient.POST.calls.reset();
      // Stubbed, or the success path sets window.location.href and
      // navigates the Karma page out from under the whole suite.
      spyOn(component as unknown as WithRedirect, 'redirectToPaystack');
      apiClient.POST.and.resolveTo({ data: { authorization_url: 'https://paystack/x' } });

      component['topupForm'].controls.amount.setValue('1500.50');
      await component['topUp']();

      expect(apiClient.POST).toHaveBeenCalled();
    });

    // Asserting on the rendered message, not just on the absent
    // request: ui-text-field shows nothing unless the parent binds both
    // `invalid` and `errorMessage`, and a form binding neither passes a
    // "did not submit" test while showing the user nothing at all.
    it('renders why it refused, under the field', async () => {
      await withBusiness('abc');
      fixture.detectChanges();

      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('Enter an amount like 1500 or 1500.50.');
    });

    it('names zero as the problem rather than the format', async () => {
      await withBusiness('0');
      fixture.detectChanges();

      expect((fixture.nativeElement as HTMLElement).textContent).toContain(
        'Enter an amount greater than zero.'
      );
    });

    it('offers a phone the numeric keypad', async () => {
      await createComponent();
      apiClient.GET.and.resolveTo({ data: makeWallet() });
      await component['onBusinessChange']('biz-1');
      fixture.detectChanges();

      const input = (fixture.nativeElement as HTMLElement).querySelector(
        'ui-text-field input'
      ) as HTMLInputElement;
      expect(input.getAttribute('inputmode')).toBe('decimal');
    });
  });

  // DRF nests the error the way the request nests the field, so
  // `{wallet_topup: {amount: [...]}}` has to be lifted before it can
  // match a control named `amount`.
  it('puts a rejected amount under the field, not in the page alert', async () => {
    await createComponent();
    apiClient.GET.and.resolveTo({ data: makeWallet() });
    await component['onBusinessChange']('biz-1');
    component['topupForm'].controls.amount.setValue('1.00');
    apiClient.POST.and.resolveTo({
      error: { wallet_topup: { amount: ['Minimum top-up is 100.00.'] } },
    });

    await component['topUp']();
    fixture.detectChanges();

    expect(component['amountError']()).toBe('Minimum top-up is 100.00.');
    expect(component['topupError']()).toBeNull();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'Minimum top-up is 100.00.'
    );
  });

  it('still shows a non-field error on the page', async () => {
    await createComponent();
    apiClient.GET.and.resolveTo({ data: makeWallet() });
    await component['onBusinessChange']('biz-1');
    component['topupForm'].controls.amount.setValue('500.00');
    apiClient.POST.and.resolveTo({ error: { detail: 'Wallet top-ups are disabled.' } });

    await component['topUp']();

    expect(component['topupError']()).toBe('Wallet top-ups are disabled.');
  });
});
