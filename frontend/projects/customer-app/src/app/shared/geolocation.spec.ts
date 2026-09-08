import { TestBed } from '@angular/core/testing';

import { GeolocationService } from './geolocation';

/**
 * `navigator.geolocation` is never touched here. The service exposes
 * one `protected geolocation()` seam precisely so these branches can be
 * driven — two of them (a real permission prompt, a device with no
 * geolocation at all) are unreachable in a headless browser, and those
 * are exactly the two a passenger is most likely to hit.
 */
class TestGeolocationService extends GeolocationService {
  stub: Geolocation | null = null;
  protected override geolocation(): Geolocation | null {
    return this.stub;
  }
}

function positionStub(latitude: number, longitude: number): Geolocation {
  return {
    getCurrentPosition: (success: PositionCallback) =>
      success({ coords: { latitude, longitude } } as GeolocationPosition),
  } as unknown as Geolocation;
}

function errorStub(code: number): Geolocation {
  return {
    getCurrentPosition: (_success: PositionCallback, failure?: PositionErrorCallback | null) =>
      failure?.({
        code,
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
      } as GeolocationPositionError),
  } as unknown as Geolocation;
}

describe('GeolocationService', () => {
  let service: TestGeolocationService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [TestGeolocationService] });
    service = TestBed.inject(TestGeolocationService);
  });

  it('rounds to the six decimal places the backend column holds', async () => {
    // A raw `coords.latitude` carries up to fifteen significant digits,
    // and DRF answers a value that long with a 400 on a field the
    // passenger can neither see nor correct.
    service.stub = positionStub(6.5243793214, 3.3792057);

    const result = await service.current();

    expect(result).toEqual({ ok: true, latitude: '6.524379', longitude: '3.379206' });
  });

  it('reports a browser with no geolocation at all', async () => {
    service.stub = null;

    expect(await service.current()).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('separates a refusal from a failure', async () => {
    service.stub = errorStub(1);
    expect(await service.current()).toEqual({ ok: false, reason: 'denied' });

    // A timeout or an unavailable position might work on a second try;
    // asking again after the passenger said no would not.
    service.stub = errorStub(3);
    expect(await service.current()).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('never resolves without an answer of some kind', async () => {
    service.stub = errorStub(2);
    const result = await service.current();

    expect(result.ok).toBeFalse();
  });
});
