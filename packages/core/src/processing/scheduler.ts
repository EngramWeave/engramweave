import { DateTime } from 'luxon';
import type { ProcessingSettings, ScheduleState } from '@engramweave/contracts';

/** Pick one future occurrence; nonexistent DST clock times are skipped, repeated ones fire once. */
export function nextScheduledTime(settings: ProcessingSettings, now: number): number {
  if (settings.mode === 'interval') return now + settings.interval_minutes * 60_000;
  const local = DateTime.fromMillis(now, { zone: settings.time_zone });
  const [hour, minute] = settings.daily_time.split(':').map(Number);
  for (let day = 0; day < 8; day++) {
    const date = local.startOf('day').plus({ days: day });
    const target = date.set({ hour, minute, second: 0, millisecond: 0 });
    if (target.hour !== hour || target.minute !== minute) continue;
    const earliest = Math.min(...target.getPossibleOffsets().map(item => item.toMillis()));
    if (earliest > now) return earliest;
  }
  throw new Error('No future daily time could be computed');
}
export class ProcessingScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private due: number | null = null;
  private lastTick = 0;
  private state: ScheduleState = { next_due: null, waiting: false, last_trigger: null, reason: null };
  constructor(private readonly settings: () => ProcessingSettings, private readonly busy: () => boolean,
    private readonly submit: () => Promise<void>, private readonly clock: () => number = Date.now) {}
  read(): ScheduleState { return { ...this.state }; }
  reset() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null; this.lastTick = this.clock(); this.state.waiting = false;
    this.due = this.settings().enabled ? nextScheduledTime(this.settings(), this.lastTick) : null;
    this.state.next_due = this.due === null ? null : new Date(this.due).toISOString(); this.state.reason = null;
    this.arm();
  }
  private arm() {
    if (this.closed || this.due === null) return;
    this.timer = setTimeout(() => { this.timer = null; void this.tick().finally(() => this.arm()); }, Math.max(250, Math.min(15000, this.due - this.clock())));
    this.timer.unref?.();
  }
  async tick() {
    if (this.closed || !this.settings().enabled || this.due === null) return;
    const now = this.clock();
    // A 15s heartbeat distinguishes normal scheduling delay from missed/wake-up periods.
    if (now < this.lastTick || now - this.lastTick > 30000) {
      this.state.waiting = false; this.state.reason = 'Clock changed or Core resumed after a missed period; no catch-up round';
      this.due = nextScheduledTime(this.settings(), now);
    } else if (now >= this.due) {
      this.state.last_trigger = new Date(this.due).toISOString(); this.state.waiting = true;
      this.due = nextScheduledTime(this.settings(), now);
      this.state.reason = this.busy() ? 'Core is busy; one round is waiting' : null;
    }
    this.lastTick = now; this.state.next_due = new Date(this.due).toISOString();
    if (this.state.waiting && !this.busy()) {
      this.state.waiting = false;
      try { await this.submit(); this.state.reason = 'Scheduled round accepted'; }
      catch (error) { this.state.reason = error instanceof Error ? error.message : 'Scheduled round could not start'; }
    }
  }
  close() { this.closed = true; if (this.timer) clearTimeout(this.timer); this.timer = null; this.state.waiting = false; }
}
