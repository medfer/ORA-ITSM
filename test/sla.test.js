const test = require('node:test');
const assert = require('node:assert');
const sla = require('../server/sla');

// Irak : UTC+3, dimanche -> jeudi, 08:00-16:00
const BH = { offset: 180, days: [0, 1, 2, 3, 4], start: '08:00', end: '16:00' };
const local = (iso) => Date.parse(`${iso}+03:00`);

test('ajout en heures ouvrées dans la même journée', () => {
  // Dimanche 27/09/2026 10:00 + 2h -> 12:00
  assert.strictEqual(sla.addBusinessMinutes(local('2026-09-27T10:00:00'), 120, BH), local('2026-09-27T12:00:00'));
});

test('report au jour ouvré suivant', () => {
  // Dimanche 15:00 + 2h -> lundi 09:00
  assert.strictEqual(sla.addBusinessMinutes(local('2026-09-27T15:00:00'), 120, BH), local('2026-09-28T09:00:00'));
});

test('le week-end (vendredi/samedi) est ignoré', () => {
  // Jeudi 15:00 + 2h -> dimanche 09:00
  assert.strictEqual(sla.addBusinessMinutes(local('2026-10-01T15:00:00'), 120, BH), local('2026-10-04T09:00:00'));
  // Ticket ouvert vendredi soir -> démarre dimanche 08:00
  assert.strictEqual(sla.addBusinessMinutes(local('2026-10-02T20:00:00'), 60, BH), local('2026-10-04T09:00:00'));
});

test('minutes ouvrées entre deux instants', () => {
  assert.strictEqual(sla.businessMinutesBetween(local('2026-10-01T15:00:00'), local('2026-10-04T09:00:00'), BH), 120);
  assert.strictEqual(sla.businessMinutesBetween(local('2026-10-02T09:00:00'), local('2026-10-03T18:00:00'), BH), 0);
});

test('état SLA', () => {
  const t = { created_at: 0, response_due: 100 * 60000, resolution_due: 200 * 60000, paused_minutes: 0 };
  const pol = { business_hours: 0 };
  assert.strictEqual(sla.slaState(t, pol, BH, 10 * 60000).response, 'running');
  assert.strictEqual(sla.slaState(t, pol, BH, 90 * 60000).response, 'at_risk');
  assert.strictEqual(sla.slaState(t, pol, BH, 110 * 60000).response, 'breached');
  assert.strictEqual(sla.slaState({ ...t, first_response_at: 50 * 60000 }, pol, BH, 500 * 60000).response, 'met');
  assert.strictEqual(sla.slaState({ ...t, paused_at: 150 * 60000 }, pol, BH, 300 * 60000).resolution, 'paused');
});
