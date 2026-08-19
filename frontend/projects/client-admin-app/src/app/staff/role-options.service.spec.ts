import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { RoleOptionsService } from './role-options.service';

describe('RoleOptionsService', () => {
  let apiClient: { GET: jasmine.Spy };
  let service: RoleOptionsService;

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET') };
    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });
    service = TestBed.inject(RoleOptionsService);
  });

  it('maps {id,name} roles to SelectOption[]', async () => {
    apiClient.GET.and.resolveTo({
      data: {
        count: 2,
        results: [
          { id: 'role-1', name: 'Owner', permissions: [] },
          { id: 'role-2', name: 'Manager', permissions: [] },
        ],
      },
    });

    const options = await service.loadOptions();

    expect(options).toEqual([
      { value: 'role-1', label: 'Owner' },
      { value: 'role-2', label: 'Manager' },
    ]);
  });

  it('throws with the server error message on failure', async () => {
    apiClient.GET.and.resolveTo({ error: { detail: 'Forbidden.' } });

    await expectAsync(service.loadOptions()).toBeRejectedWithError('Forbidden.');
  });
});
