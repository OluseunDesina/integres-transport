import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { WhiteLabelResolverService } from './white-label-resolver.service';

describe('WhiteLabelResolverService', () => {
  let apiClient: { GET: jasmine.Spy };
  let service: WhiteLabelResolverService;

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET') };
    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });
    service = TestBed.inject(WhiteLabelResolverService);
  });

  it('starts with no resolved client', () => {
    expect(service.clientId()).toBeNull();
  });

  it('sets clientId from a successful resolve', async () => {
    apiClient.GET.and.resolveTo({ data: { client_id: 'client-1', name: 'Acme' } });

    await service.resolve();

    expect(service.clientId()).toBe('client-1');
  });

  it('falls back to null when the domain is unknown (404)', async () => {
    apiClient.GET.and.resolveTo({ error: { detail: 'Not found.' } });

    await service.resolve();

    expect(service.clientId()).toBeNull();
  });

  it('falls back to null on a network error instead of throwing', async () => {
    apiClient.GET.and.rejectWith(new Error('network down'));

    await expectAsync(service.resolve()).toBeResolved();

    expect(service.clientId()).toBeNull();
  });

  // --- Branding (docs/specs/14-design-system-and-ui-rebuild.md) ---

  it('carries the branding the endpoint has always returned', async () => {
    apiClient.GET.and.resolveTo({
      data: {
        client_id: 'client-1',
        name: 'Acme Transit',
        logo: 'https://cdn.example/logo.svg',
        primary_color: '#7c3aed',
        secondary_color: '#f59e0b',
      },
    });

    await service.resolve();

    expect(service.branding()).toEqual({
      name: 'Acme Transit',
      logo: 'https://cdn.example/logo.svg',
      primary: '#7c3aed',
      secondary: '#f59e0b',
    });
  });

  it('normalises unconfigured blank strings to null', async () => {
    // These are `blank=True` CharFields server-side, so "not configured"
    // arrives as '' rather than null — passing that on would hand the
    // theme service a falsy colour to reason about.
    apiClient.GET.and.resolveTo({
      data: { client_id: 'client-1', name: 'Acme', logo: '', primary_color: '', secondary_color: '' },
    });

    await service.resolve();

    expect(service.branding()).toEqual({
      name: 'Acme',
      logo: null,
      primary: null,
      secondary: null,
    });
  });

  it('leaves branding null when the domain is unknown', async () => {
    apiClient.GET.and.resolveTo({ error: { detail: 'Not found.' } });

    await service.resolve();

    expect(service.branding()).toBeNull();
  });
});
