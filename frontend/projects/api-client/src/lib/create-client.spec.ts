import { createApiClient } from './create-client';

describe('createApiClient', () => {
  it('builds a client exposing the typed HTTP verbs', () => {
    const client = createApiClient('http://localhost:8000/api/v1');

    expect(typeof client.GET).toBe('function');
    expect(typeof client.POST).toBe('function');
  });
});
