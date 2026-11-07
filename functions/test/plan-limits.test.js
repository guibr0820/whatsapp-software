const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultLimitsFor, normalizeLimits, monthKey, releaseMonthly, evaluateMonthlyConsumption } = require('../src/plan-limits');

test('aplica os limites padrão dos três planos', () => {
  assert.deepEqual(defaultLimitsFor({ name: 'Crescimento' }), { professionals: 2, appointmentsPerMonth: 200, remindersPerMonth: 400, flows: 1, pix: true, automations: 'basic' });
  assert.deepEqual(defaultLimitsFor({ name: 'Profissional' }), { professionals: 8, appointmentsPerMonth: 800, remindersPerMonth: 1600, flows: 3, pix: true, automations: 'full' });
  assert.deepEqual(defaultLimitsFor({ name: 'Negócios' }), { professionals: 20, appointmentsPerMonth: 2500, remindersPerMonth: 5000, flows: 10, pix: true, automations: 'full' });
});

test('normaliza limites editáveis sem aceitar valores negativos', () => {
  assert.deepEqual(normalizeLimits({ professionals: 4, appointmentsPerMonth: -1, remindersPerMonth: 80, flows: 2, pix: true, automations: 'full' }), { professionals: 4, appointmentsPerMonth: 200, remindersPerMonth: 80, flows: 2, pix: true, automations: 'full' });
  assert.match(monthKey(new Date('2026-10-28T15:00:00-03:00')), /^2026-10$/);
});

test('usa a franquia mensal antes dos créditos extras', () => {
  const result = evaluateMonthlyConsumption({ usageData: { reminders: 399 }, creditsData: { reminders: 100 }, metric: 'reminders', limit: 400, reference: 'a' });
  assert.equal(result.allowed, true);
  assert.equal(result.usesCredit, false);
  assert.equal(result.creditBalance, 100);
});

test('consome um crédito após o limite e impede duplicidade', () => {
  const result = evaluateMonthlyConsumption({ usageData: { reminders: 400, reminders_references: {} }, creditsData: { reminders: 2 }, metric: 'reminders', limit: 400, reference: 'a' });
  assert.equal(result.allowed, true);
  assert.equal(result.usesCredit, true);
  assert.equal(result.creditBalance, 2);
  assert.equal(evaluateMonthlyConsumption({ usageData: { reminders: 401, reminders_references: { a: true } }, creditsData: { reminders: 1 }, metric: 'reminders', limit: 400, reference: 'a' }).duplicate, true);
});

test('bloqueia automação sem franquia nem crédito extra', () => {
  const result = evaluateMonthlyConsumption({ usageData: { appointments: 200 }, creditsData: { appointments: 0 }, metric: 'appointments', limit: 200 });
  assert.equal(result.allowed, false);
});

test('devolve consumo e crédito reservado quando o envio automático falha', async () => {
  const key = monthKey();
  const values = new Map([
    [`organizations/org/usage/${key}`, { reminders: 401, reminders_references: { envio: true }, reminders_credit_references: { envio: true }, reminders_credits_used: 1 }],
    ['organizations/org/capacity/credits', { reminders: 4 }],
  ]);
  const db = {
    doc: path => ({ path }),
    runTransaction: async callback => callback({
      get: async ref => ({ data: () => values.get(ref.path) }),
      set: (ref, data) => values.set(ref.path, { ...(values.get(ref.path) || {}), ...data }),
    }),
  };
  const admin = { firestore: { FieldValue: { serverTimestamp: () => 'now' } } };
  await releaseMonthly(db, admin, 'org', 'reminders', 'envio');
  assert.equal(values.get(`organizations/org/usage/${key}`).reminders, 400);
  assert.equal(values.get(`organizations/org/usage/${key}`).reminders_references.envio, undefined);
  assert.equal(values.get(`organizations/org/usage/${key}`).reminders_credits_used, 0);
  assert.equal(values.get('organizations/org/capacity/credits').reminders, 5);
});
