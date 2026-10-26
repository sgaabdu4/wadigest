import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestSlot, nextSlot, weekKey, windowFor, decide, zonedToUtc, applySchedule, describeSchedule, readDays } from '../src/schedule.js';
import { groupConfig } from '../src/config.js';

const sched = { day: 'sunday', time: '09:00', timezone: 'Europe/London' };
const cfg = (over = {}) => ({ schedule: sched, group: { jid: 'g@g.us', name: 'G' }, installedAt: '2026-10-01T00:00:00Z', ...over });
const empty = () => ({ posted: {}, attempts: {} });

test('a group with posting and DMs disabled is never scheduled', () => {
  const c = groupConfig(cfg({ dms: { enabled: true } }), { jid: 'g@g.us', post: false, dm: false });
  const result = decide(new Date('2026-10-18T09:00:00Z'), c, empty());
  assert.equal(result.due, false);
  assert.equal(result.reason, 'no delivery enabled');
});

test('a group with DMs enabled can still run without a group post', () => {
  const c = groupConfig(cfg({ dms: { enabled: true } }), { jid: 'g@g.us', post: false, dm: true });
  assert.equal(decide(new Date('2026-10-18T09:00:00Z'), c, empty()).due, true);
});

test('zonedToUtc handles BST and GMT', () => {
  assert.equal(zonedToUtc(2026, 10, 18, 9, 0, 'Europe/London').toISOString(), '2026-10-18T08:00:00.000Z'); // BST
  assert.equal(zonedToUtc(2026, 11, 1, 9, 0, 'Europe/London').toISOString(), '2026-11-01T09:00:00.000Z'); // GMT
});

test('latestSlot / nextSlot across the 25 Oct 2026 clock change', () => {
  const sat = new Date('2026-10-24T12:00:00Z');
  assert.equal(latestSlot(sat, sched).toISOString(), '2026-10-18T08:00:00.000Z');
  assert.equal(nextSlot(sat, sched).toISOString(), '2026-10-25T09:00:00.000Z'); // GMT after change
  const sunAfter = new Date('2026-10-25T09:30:00Z');
  assert.equal(latestSlot(sunAfter, sched).toISOString(), '2026-10-25T09:00:00.000Z');
  const sunBefore = new Date('2026-10-25T08:30:00Z'); // 08:30 GMT, before 09:00 local
  assert.equal(latestSlot(sunBefore, sched).toISOString(), '2026-10-18T08:00:00.000Z');
  assert.equal(weekKey(latestSlot(sunAfter, sched), 'Europe/London'), '2026-10-25');
});

test('window is exactly the 7 local days before the slot, even across DST', () => {
  const w = windowFor(new Date('2026-10-25T09:00:00Z'), 'Europe/London');
  assert.equal(w.start.toISOString(), '2026-10-18T08:00:00.000Z');
  assert.equal(w.end.toISOString(), '2026-10-25T09:00:00.000Z');
});

test('decide: due at slot, never twice, catch-up within 72 h, not before install', () => {
  const slotTime = new Date('2026-10-18T08:00:00Z');
  assert.equal(decide(new Date('2026-10-18T07:59:00Z'), cfg(), empty()).due, false);
  const d = decide(new Date('2026-10-18T08:01:00Z'), cfg(), empty());
  assert.equal(d.due, true);
  assert.equal(d.key, 'g@g.us|2026-10-18');
  assert.equal(d.slot.getTime(), slotTime.getTime());
  // asleep until Tuesday: still catches up
  assert.equal(decide(new Date('2026-10-20T20:00:00Z'), cfg(), empty()).due, true);
  // Wednesday afternoon: too late
  assert.equal(decide(new Date('2026-10-21T09:00:00Z'), cfg(), empty()).due, false);
  // already posted
  assert.equal(decide(new Date('2026-10-18T09:00:00Z'), cfg(), { posted: { 'g@g.us|2026-10-18': { at: 'x' } }, attempts: {} }).due, false);
  // posted before multi-group support (keyed by date only)
  assert.equal(decide(new Date('2026-10-18T09:00:00Z'), cfg(), { posted: { '2026-10-18': { at: 'x' } }, attempts: {} }).due, false);
  // another group's post doesn't count
  assert.equal(decide(new Date('2026-10-18T09:00:00Z'), cfg(), { posted: { 'h@g.us|2026-10-18': { at: 'x' } }, attempts: {} }).due, true);
  // installed after the slot: wait for next week
  assert.equal(decide(new Date('2026-10-18T09:00:00Z'), cfg({ installedAt: '2026-10-18T08:30:00Z' }), empty()).due, false);
  // no group
  assert.equal(decide(new Date('2026-10-18T09:00:00Z'), cfg({ group: null }), empty()).due, false);
});

test('decide: retries 30 min apart, at most 3 attempts', () => {
  const now = new Date('2026-10-18T09:00:00Z');
  const st = (count, minsAgo) => ({ posted: {}, attempts: { 'g@g.us|2026-10-18': { count, lastAt: new Date(now - minsAgo * 60e3).toISOString() } } });
  assert.equal(decide(now, cfg(), st(1, 10)).due, false);
  assert.equal(decide(now, cfg(), st(1, 31)).due, true);
  assert.equal(decide(now, cfg(), st(3, 120)).due, false);
});

test('every N days: anchored on the first run, DST-safe, window follows readDays', () => {
  const c = { schedule: { ...sched, everyDays: 7, readDays: 0, start: '' } };
  applySchedule(c, { everyDays: 3, day: 'tuesday' }, new Date('2026-10-18T10:00:00Z'));
  assert.equal(c.schedule.start, '2026-10-20');
  assert.equal(describeSchedule(c.schedule), 'every 3 days at 09:00');
  assert.equal(readDays(c.schedule), 3);
  assert.equal(nextSlot(new Date('2026-10-18T12:00:00Z'), c.schedule).toISOString(), '2026-10-20T08:00:00.000Z'); // waits for the first run
  const early = decide(new Date('2026-10-18T12:00:00Z'), { schedule: c.schedule, group: { jid: 'g@g.us' }, installedAt: '2026-01-01T00:00:00Z' }, empty());
  assert.equal(early.due, false);
  assert.equal(nextSlot(new Date('2026-10-20T08:30:00Z'), c.schedule).toISOString(), '2026-10-23T08:00:00.000Z');
  assert.equal(latestSlot(new Date('2026-10-26T12:00:00Z'), c.schedule).toISOString(), '2026-10-26T09:00:00.000Z'); // GMT after the change
  const w = windowFor(new Date('2026-10-26T09:00:00Z'), 'Europe/London', readDays(c.schedule));
  assert.equal(w.start.toISOString(), '2026-10-23T08:00:00.000Z');

  const daily = { schedule: { ...sched, everyDays: 1, readDays: 0, start: '' } };
  assert.equal(latestSlot(new Date('2026-10-21T12:00:00Z'), daily.schedule).toISOString(), '2026-10-21T08:00:00.000Z');
  assert.equal(describeSchedule(daily.schedule), 'every day at 09:00');

  const weekly = { schedule: { ...sched, everyDays: 7, readDays: 0, start: '' } };
  applySchedule(weekly, { readDays: 10 });
  assert.equal(weekly.schedule.start, '');
  assert.equal(readDays(weekly.schedule), 10);
  assert.equal(latestSlot(new Date('2026-10-24T12:00:00Z'), weekly.schedule).toISOString(), '2026-10-18T08:00:00.000Z');
});
