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
    component['setTopupAmount']('500.00');
    apiClient.POST.and.resolveTo({
      data: { id: 'intent-1', status: 'pending', authorization_url: 'https://paystack/checkout', reference: 'ref-1' },
    });
    const redirectSpy = spyOn(component as unknown as WithRedirect, 'redirectToPaystack');

    await component['topUp']();

    expect(apiClient.POST).toHaveBeenCalledWith(
      '/api/v1/payments/',
      jasmine.objectContaining({
        body: { wallet_topup: { business_id: 'biz-1', amount: '500.00' } },
      })
    );
    expect(redirectSpy).toHaveBeenCalledWith('https://paystack/checkout');
  });

  it('shows the server error message when a top-up fails', async () => {
    await createComponent();
    apiClient.GET.and.resolveTo({ data: makeWallet() });
    await component['onBusinessChange']('biz-1');
    component['setTopupAmount']('500.00');
    apiClient.POST.and.resolveTo({ error: { detail: 'This Business has no active Paystack account configured.' } });

    await component['topUp']();

    expect(component['topupError']()).toBe(
      'This Business has no active Paystack account configured.'
    );
  });
});
