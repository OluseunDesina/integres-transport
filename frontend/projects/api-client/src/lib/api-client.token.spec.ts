import { TestBed } from '@angular/core/testing';

import { API_CLIENT, provideApiClient } from './api-client.token';

describe('provideApiClient', () => {
  it('registers a typed client resolvable via API_CLIENT', () => {
    TestBed.configureTestingModule({
      providers: [provideApiClient('http://localhost:8000/api/v1')],
    });

    const client = TestBed.inject(API_CLIENT);

    expect(typeof client.GET).toBe('function');
    expect(typeof client.POST).toBe('function');
  });
});
