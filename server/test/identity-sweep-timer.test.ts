import { describe, it, expect, vi, afterEach } from 'vitest';
import { IDENTITY_SWEEP_INTERVAL_MS } from '../src/modules/identity/constants.js';
import { buildHermeticGoogleApp } from './helpers/google-mode.js';

/**
 * google mode registers a periodic expired-flow / expired-session sweep at
 * boot; it is unref()'d, runs the repository sweep on each tick, and is
 * cleared when the app closes (no Postgres: the repo method is stubbed).
 */
describe('identity expiry sweep timer (google mode)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is registered at boot, sweeps on tick, and is cleared on close', async () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');

    const t = await buildHermeticGoogleApp({ recordDb: true });
    const call = setSpy.mock.calls.findIndex(([, ms]) => ms === IDENTITY_SWEEP_INTERVAL_MS);
    expect(call).toBeGreaterThanOrEqual(0);
    const tick = setSpy.mock.calls[call]![0] as () => void;
    const timer = setSpy.mock.results[call]!.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);

    const sweep = vi
      .spyOn(t.container.identityRepo, 'sweepExpired')
      .mockResolvedValue({ oauthFlows: 0, sessions: 0 });
    tick();
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(sweep.mock.calls[0]![0]).toBeInstanceOf(Date);
    // A tick while the previous sweep is still in flight is skipped.
    tick();
    expect(sweep).toHaveBeenCalledTimes(1);
    await new Promise((r) => setImmediate(r));
    tick();
    expect(sweep).toHaveBeenCalledTimes(2);

    expect(clearSpy).not.toHaveBeenCalledWith(timer);
    await t.close();
    expect(clearSpy).toHaveBeenCalledWith(timer);
  });

  it('a failing sweep is logged, not thrown', async () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const t = await buildHermeticGoogleApp({ recordDb: true });
    const call = setSpy.mock.calls.findIndex(([, ms]) => ms === IDENTITY_SWEEP_INTERVAL_MS);
    const tick = setSpy.mock.calls[call]![0] as () => void;
    const sweep = vi.spyOn(t.container.identityRepo, 'sweepExpired').mockRejectedValue(new Error('db down'));
    const warn = vi.spyOn(t.app.log, 'warn');
    tick();
    await new Promise((r) => setImmediate(r));
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({ err: 'db down' }, 'identity expiry sweep failed');
    await t.close();
  });
});
