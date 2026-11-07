const test = require("node:test");
const assert = require("node:assert/strict");
const { DEFINITIONS, mergeConfig, normalizeConfig, recoveryEligibility } = require("../src/lifecycle-automations");

test("oferece os lembretes gerais e os acompanhamentos por segmento", () => {
  const config = mergeConfig();
  assert.equal(config.length, 7);
  assert.deepEqual(new Set(config.map(item => item.group)), new Set(["appointments", "relationship", "orders"]));
  assert.equal(config.find(item => item.id === "post_appointment").availability, "available");
});

test("salva apenas automações disponíveis e limita os tempos", () => {
  const input = DEFINITIONS.map(item => ({ ...item, active: true, delayMinutes: 999999, delayDays: 60 }));
  const normalized = normalizeConfig(input);
  assert.equal(normalized.find(item => item.id === "post_appointment").active, true);
  assert.equal(normalized.find(item => item.id === "customer_recovery").active, true);
  assert.equal(normalized.find(item => item.id === "waitlist").active, false);
  assert.equal(normalized.find(item => item.id === "quote_followup").active, true);
  assert.equal(normalized.find(item => item.id === "enrollment_followup").active, true);
  assert.equal(normalized.find(item => item.id === "visit_followup").active, true);
  assert.equal(normalized.find(item => item.id === "post_order").delay_minutes, 43200);
  assert.equal(normalized.find(item => item.id === "customer_recovery").delay_days, 60);
});

test("recupera somente cliente autorizado, inativo no prazo e ainda não contatado", () => {
  const now = Date.UTC(2026, 10, 2, 12);
  const oldActivity = new Date(now - 31 * 86400000);
  assert.equal(recoveryEligibility({ marketing_consent: true, last_activity_at: oldActivity }, now, 30).eligible, true);
  assert.equal(recoveryEligibility({ marketing_consent: false, last_activity_at: oldActivity }, now, 30).reason, "no_consent");
  assert.equal(recoveryEligibility({ marketing_consent: true, last_activity_at: oldActivity, recovery_last_sent_at: new Date(now - 1 * 86400000) }, now, 30).reason, "already_recovered");
});

test("recusa modelo da Meta com nome inseguro", () => {
  const input = DEFINITIONS.map(item => ({ ...item }));
  input[0].templateName = "Modelo Inválido";
  assert.throws(() => normalizeConfig(input), /Modelo inválido/);
});
