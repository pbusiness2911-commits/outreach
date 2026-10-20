// Send windows in the lead's (or campaign's) time zone.

export interface Window {
  timezone: string;
  sendDays: number[]; // 0=Sun..6=Sat
  start: string; // "09:00"
  end: string; // "17:00"
}

function parts(date: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(date)) p[x.type] = x.value;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { dow, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
};

export function isValidTimezone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function inWindow(date: Date, w: Window): boolean {
  const { dow, minutes } = parts(date, w.timezone);
  return w.sendDays.includes(dow) && minutes >= toMin(w.start) && minutes < toMin(w.end);
}

/** The first moment at or after `from` that is inside the window (searches minute-by-minute in 15-min steps, max 8 days). */
export function nextWindowStart(from: Date, w: Window): Date {
  if (inWindow(from, w)) return from;
  if (!w.sendDays.length) throw new Error('Campaign has no send days');
  const step = 15 * 60 * 1000;
  let t = new Date(Math.ceil(from.getTime() / step) * step);
  for (let i = 0; i < 8 * 24 * 4; i++) {
    if (inWindow(t, w)) return t;
    t = new Date(t.getTime() + step);
  }
  throw new Error('Send window never opens; check the campaign hours');
}

/** When the next step is due: delay in days after `from`, then pushed into the window, with a few random minutes so sends don't line up. */
export function scheduleNext(from: Date, delayDays: number, w: Window, jitterMinutes = 30): Date {
  const base = new Date(from.getTime() + delayDays * 86400000 + Math.floor(Math.random() * jitterMinutes) * 60000);
  return nextWindowStart(base, w);
}

export function randomBetween(min: number, max: number) {
  return Math.floor(min + Math.random() * Math.max(0, max - min));
}
