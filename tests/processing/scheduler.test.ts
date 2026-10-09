import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextScheduledTime, ProcessingScheduler } from '../../packages/core/src/processing/scheduler.js';
import { defaultProcessingSettings } from '../../packages/core/src/processing/settings.js';

afterEach(() => vi.useRealTimers());
describe('Core scheduling without catch-up', () => {
  it('uses the stored zone, skips nonexistent daily times and fires repeated times once', () => {
    const s = { ...defaultProcessingSettings(), enabled: true, daily_time: '02:30', time_zone: 'America/New_York' };
    expect(new Date(nextScheduledTime(s, Date.parse('2026-03-08T05:00:00Z'))).toISOString()).toBe('2026-03-09T06:30:00.000Z');
    s.daily_time = '01:30';
    expect(new Date(nextScheduledTime(s, Date.parse('2026-11-01T05:31:00Z'))).toISOString()).toBe('2026-11-02T06:30:00.000Z');
  });
  it('coalesces busy triggers into one waiting round and disabling settings makes no calls', async () => {
    vi.useFakeTimers(); vi.setSystemTime('2026-10-09T00:00:00Z');
    const s = { ...defaultProcessingSettings(), enabled: true, mode: 'interval' as const, interval_minutes: 1 };
    let busy = true; const submit = vi.fn(async () => {});
    const scheduler = new ProcessingScheduler(() => s, () => busy, submit); scheduler.reset();
    await vi.advanceTimersByTimeAsync(180000); expect(submit).not.toHaveBeenCalled(); expect(scheduler.read().waiting).toBe(true);
    busy = false; await vi.advanceTimersByTimeAsync(15000); expect(submit).toHaveBeenCalledTimes(1);
    s.enabled = false; scheduler.reset(); await vi.advanceTimersByTimeAsync(180000); expect(submit).toHaveBeenCalledTimes(1); expect(scheduler.read().next_due).toBeNull(); scheduler.close();
  });
  it('does not replay sleep, clock jumps, restart or a previously waiting trigger', async () => {
    vi.useFakeTimers(); vi.setSystemTime('2026-10-09T00:00:00Z');
    const s = { ...defaultProcessingSettings(), enabled: true, mode: 'interval' as const, interval_minutes: 1 };
    const submit = vi.fn(async () => {}); let busy = true;
    const scheduler = new ProcessingScheduler(() => s, () => busy, submit); scheduler.reset();
    await vi.advanceTimersByTimeAsync(60000); expect(scheduler.read().waiting).toBe(true);
    vi.setSystemTime('2026-10-09T01:00:00Z'); busy = false; await scheduler.tick(); expect(submit).not.toHaveBeenCalled(); expect(scheduler.read().waiting).toBe(false);
    vi.setSystemTime('2026-10-09T00:00:00Z'); await scheduler.tick(); expect(submit).not.toHaveBeenCalled(); scheduler.close();
    const restarted = new ProcessingScheduler(() => s, () => false, submit); restarted.reset(); expect(restarted.read().next_due).toBe('2026-10-09T00:01:00.000Z'); restarted.close();
  });
});
