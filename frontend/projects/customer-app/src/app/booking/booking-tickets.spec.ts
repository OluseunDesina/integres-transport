import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { API_CLIENT } from '@api-client';

import { BookingTickets } from './booking-tickets';

interface WithGenerateQr {
  generateQrDataUrl(payload: string): Promise<string>;
}

function makeTicket(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ticket-1',
    signed_payload: 'signed-payload-abc',
    status: 'issued',
    issued_at: '2026-08-18T00:00:00Z',
    expires_at: '2026-08-18T06:00:00Z',
    boarded_at: null,
    trip_class: 'standard',
    ...overrides,
  };
}

describe('BookingTickets', () => {
  let apiClient: { GET: jasmine.Spy };
  let router: { navigate: jasmine.Spy };
  let fixture: ComponentFixture<BookingTickets>;
  let component: BookingTickets;

  async function createComponent(): Promise<void> {
    fixture = TestBed.createComponent(BookingTickets);
    component = fixture.componentInstance;
    spyOn(component as unknown as WithGenerateQr, 'generateQrDataUrl').and.resolveTo(
      'data:image/png;base64,fake'
    );
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(() => {
    apiClient = {
      GET: jasmine.createSpy('GET').and.resolveTo({ data: { count: 1, results: [makeTicket()] } }),
    };
    router = { navigate: jasmine.createSpy('navigate').and.resolveTo(true) };

    TestBed.configureTestingModule({
      imports: [BookingTickets],
      providers: [
        { provide: API_CLIENT, useValue: apiClient },
        { provide: Router, useValue: router },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: 'booking-1' }) } },
        },
      ],
    });
  });

  it("loads the booking's tickets on init and renders a QR per ticket", async () => {
    await createComponent();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/bookings/{booking_id}/tickets/',
      jasmine.objectContaining({ params: { path: { booking_id: 'booking-1' } } })
    );
    const img = (fixture.nativeElement as HTMLElement).querySelector('img');
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,fake');
    const pill = (fixture.nativeElement as HTMLElement).querySelector('ui-status-pill');
    expect(pill?.textContent?.trim()).toBe('Issued');
  });

  it('renders one QR block per ticket for a multi-seat booking', async () => {
    apiClient.GET.and.resolveTo({
      data: { count: 2, results: [makeTicket({ id: 'ticket-1' }), makeTicket({ id: 'ticket-2' })] },
    });

    await createComponent();

    const images = (fixture.nativeElement as HTMLElement).querySelectorAll('img');
    expect(images.length).toBe(2);
  });

  it('names the service class on the ticket', async () => {
    // docs/specs/15-trip-classes.md slice 3. It comes from the API, not
    // from router state: this screen is deep-linkable by design, so
    // there is nothing carried into it to read.
    apiClient.GET.and.resolveTo({
      data: { count: 1, results: [makeTicket({ trip_class: 'exclusive' })] },
    });

    await createComponent();

    const host = fixture.nativeElement as HTMLElement;
    const terms = [...host.querySelectorAll('dt')].map((dt) => dt.textContent?.trim());
    expect(terms).toContain('Service');
    expect(host.querySelector('dl')?.textContent).toContain('Exclusive');
  });

  it('shows a loading state before the response resolves', async () => {
    let resolveGet!: (value: { data: { count: number; results: unknown[] } }) => void;
    apiClient.GET.and.returnValue(
      new Promise((resolve) => {
        resolveGet = resolve;
      })
    );

    fixture = TestBed.createComponent(BookingTickets);
    component = fixture.componentInstance;
    fixture.detectChanges();

    // A ui-skeleton now, not the word "Loading…" — the placeholder is
    // aria-hidden by design, so the wait is announced on the region.
    const region = (fixture.nativeElement as HTMLElement).querySelector('[aria-busy="true"]');
    expect(region).not.toBeNull();
    expect(region?.getAttribute('aria-label')).toBe('Loading tickets');
    expect(region?.querySelector('ui-skeleton')).not.toBeNull();

    resolveGet({ data: { count: 0, results: [] } });
    await fixture.whenStable();
  });

  it('shows the server error message when the request fails', async () => {
    apiClient.GET.and.resolveTo({ error: { detail: 'Booking is not paid yet.' } });

    await createComponent();

    expect((fixture.nativeElement as HTMLElement).querySelector('ui-alert')?.textContent?.trim()).toBe(
      'Booking is not paid yet.'
    );
  });

  it('shows an empty state when the booking has no tickets', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });

    await createComponent();

    expect((fixture.nativeElement as HTMLElement).querySelector('ui-empty-state')).toBeTruthy();
  });

  it('navigates back to the booking list', async () => {
    await createComponent();

    await component['backToBookings']();

    expect(router.navigate).toHaveBeenCalledWith(['/my-bookings']);
  });
});
