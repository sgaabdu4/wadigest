// Slots every N days (weekly by default) in an IANA timezone, DST-safe, with catch-up and retry rules.

import { DAYS, setConfigValue } from './config.js';

const CATCH_UP_MS = 72 * 3600e3; // post up to 72 h late (computer asleep on Sunday)
const RETRY_GAP_MS = 30 * 60e3;
const MAX_ATTEMPTS = 3;

function partsIn(date, timeZone) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'long',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second,
    weekday: DAYS.indexOf(p.weekday.toLowerCase()),
  };
}

/** Offset (ms) of `timeZone` from UTC at instant `date`. */
function offsetAt(date, timeZone) {
  const p = partsIn(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The UTC instant for a wall-clock time in a zone. Times inside a DST gap move forward. */
export function zonedToUtc(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let t = guess - offsetAt(new Date(guess), timeZone);
  const o2 = offsetAt(new Date(t), timeZone);
  t = guess - o2;
  const check = partsIn(new Date(t), timeZone);
  if (check.hour !== hour || check.minute !== minute) {
    // Nonexistent local time (spring-forward gap): use the instant just after the gap.
    t = guess - offsetAt(new Date(guess - 12 * 3600e3), timeZone);
  }
  return new Date(t);
}

const DAY_MS = 864e5;
const calDay = (y, m, d) => Date.UTC(y, m - 1, d) / DAY_MS;

export function everyDays(schedule) {
  const n = Number(schedule?.everyDays) || 7;
  return Math.min(Math.max(Math.round(n), 1), 31);
}

/** How many days each digest reads. */
export function readDays(schedule) {
  return Number(schedule?.readDays) || everyDays(schedule);
}

// Calendar day number of one run. Weekly-style schedules count from a fixed reference
// date on the chosen weekday (4 Jan 2026 was a Sunday); `start` pins the first run.
function anchorDay(schedule) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(schedule.start || '');
  if (m) return calDay(+m[1], +m[2], +m[3]);
  return calDay(2026, 1, 4) + Math.max(DAYS.indexOf(String(schedule.day).toLowerCase()), 0);
}

function slotOn(dayNum, schedule) {
  const [hh, mm] = String(schedule.time).split(':').map(Number);
  const c = new Date(dayNum * DAY_MS);
  return zonedToUtc(c.getUTCFullYear(), c.getUTCMonth() + 1, c.getUTCDate(), hh, mm, schedule.timezone);
}

/** Most recent scheduled slot at or before `now`. */
export function latestSlot(now, schedule) {
  const n = everyDays(schedule);
  const local = partsIn(now, schedule.timezone);
  const today = calDay(local.year, local.month, local.day);
  const back = (((today - anchorDay(schedule)) % n) + n) % n;
  const slot = slotOn(today - back, schedule);
  return slot.getTime() > now.getTime() ? slotOn(today - back - n, schedule) : slot;
}

/** The first run, when the schedule pins one (start); otherwise null. */
export function firstSlot(schedule) {
  return /^\d{4}-\d{2}-\d{2}$/.test(schedule.start || '') ? slotOn(anchorDay(schedule), schedule) : null;
}

export function nextSlot(now, schedule) {
  const first = firstSlot(schedule);
  if (first && first.getTime() > now.getTime()) return first;
  const p = partsIn(latestSlot(now, schedule), schedule.timezone);
  return slotOn(calDay(p.year, p.month, p.day) + everyDays(schedule), schedule);
}

/** Plain words for the schedule, e.g. "Sundays at 09:00" or "every 3 days at 09:00". */
export function describeSchedule(schedule) {
  const n = everyDays(schedule);
  const day = String(schedule.day);
  if (n === 7) return `${day.charAt(0).toUpperCase()}${day.slice(1)}s at ${schedule.time}`;
  if (n === 1) return `every day at ${schedule.time}`;
  if (n === 14) return `every other ${day.charAt(0).toUpperCase()}${day.slice(1)} at ${schedule.time}`;
  return `every ${n} days at ${schedule.time}`;
}

/** Calendar date (YYYY-MM-DD) of the next `day` from now, today included if `time` hasn't passed. */
export function nextDateFor(now, schedule) {
  const local = partsIn(now, schedule.timezone);
  const want = Math.max(DAYS.indexOf(String(schedule.day).toLowerCase()), 0);
  let d = calDay(local.year, local.month, local.day) + ((want - local.weekday + 7) % 7);
  if (slotOn(d, schedule).getTime() <= now.getTime()) d += 7;
  return new Date(d * DAY_MS).toISOString().slice(0, 10);
}

/** Save day/time/timezone/how often/days read together, pinning the first run for non-weekly schedules. */
export function applySchedule(cfg, { day, time, timezone, everyDays: n, readDays: r } = {}, now = new Date()) {
  if (day) setConfigValue(cfg, 'schedule.day', String(day));
  if (time) setConfigValue(cfg, 'schedule.time', String(time));
  if (timezone) setConfigValue(cfg, 'schedule.timezone', String(timezone));
  if (n !== undefined && n !== '') setConfigValue(cfg, 'schedule.everyDays', String(n));
  if (r !== undefined && r !== '') setConfigValue(cfg, 'schedule.readDays', String(r));
  const every = everyDays(cfg.schedule);
  cfg.schedule.start = every === 7 || every === 1 ? '' : nextDateFor(now, cfg.schedule);
  return cfg;
}

/** Week key = local date of the slot, e.g. "2026-10-18". */
export function weekKey(slot, timeZone) {
  const p = partsIn(slot, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** The days the digest for `slot` covers: [slot − days, slot). Whole local days across DST. */
export function windowFor(slot, timeZone, days = 7) {
  const p = partsIn(slot, timeZone);
  const cal = new Date(Date.UTC(p.year, p.month - 1, p.day - days));
  const start = zonedToUtc(cal.getUTCFullYear(), cal.getUTCMonth() + 1, cal.getUTCDate(), p.hour, p.minute, timeZone);
  return { start, end: slot };
}

/** Window for an ad-hoc preview/run: the last `days` days up to now. */
export function rollingWindow(now = new Date(), days = 7) {
  return { start: new Date(now.getTime() - days * DAY_MS), end: now };
}

/**
 * Should the daemon run now?
 * @returns {{ due: boolean, reason: string, key?: string, slot?: Date }}
 */
export function decide(now, cfg, state) {
  const slot = latestSlot(now, cfg.schedule);
  const date = weekKey(slot, cfg.schedule.timezone);
  if (!cfg.group?.jid) return { due: false, reason: 'no group chosen' };
  const key = `${cfg.group.jid}|${date}`;
  // Before multi-group support, posts were keyed by date alone.
  if (state.posted?.[key] || state.posted?.[date]) return { due: false, reason: `already posted for ${key}`, key, slot };
  const first = firstSlot(cfg.schedule);
  if (first && slot.getTime() < first.getTime()) return { due: false, reason: 'before the first scheduled run', key, slot };
  if (cfg.installedAt && slot.getTime() < Date.parse(cfg.installedAt)) return { due: false, reason: 'slot is before install', key, slot };
  if (now.getTime() - slot.getTime() > CATCH_UP_MS) return { due: false, reason: `missed ${key} by more than 72 h`, key, slot };
  const a = state.attempts?.[key];
  if (a && a.count >= MAX_ATTEMPTS) return { due: false, reason: `gave up on ${key} after ${a.count} attempts`, key, slot };
  if (a && a.lastAt && now.getTime() - Date.parse(a.lastAt) < RETRY_GAP_MS) return { due: false, reason: 'waiting to retry', key, slot };
  return { due: true, reason: a ? `retry ${a.count + 1}` : 'scheduled', key, slot };
}

export const _internals = { partsIn, offsetAt, CATCH_UP_MS, RETRY_GAP_MS, MAX_ATTEMPTS };
