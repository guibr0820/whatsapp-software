const test = require("node:test");
const assert = require("node:assert/strict");
const {_test} = require("../src/admin-notifications");

class TestHttpsError extends Error {}

test("normaliza preferências administrativas com padrões seguros", () => {
  assert.deepEqual(_test.preferences({}), {newSubscription: true, waitingCustomer: true, paymentFailure: false, whatsappDisconnected: false, reminderMinutes: 15});
  assert.equal(_test.preferences({waiting_customer: false, reminder_minutes: 999}).waitingCustomer, false);
  assert.equal(_test.preferences({reminder_minutes: 999}).reminderMinutes, 120);
});

test("token de aparelho é validado e armazenado por hash", () => {
  const token = "deviceToken_1234567890:APA91bExampleToken_abcdefghijklmnop";
  assert.equal(_test.validToken(token, TestHttpsError), token);
  assert.match(_test.tokenId(token), /^[a-f0-9]{64}$/);
  assert.throws(() => _test.validToken("curto", TestHttpsError), TestHttpsError);
});

test("valor da assinatura é formatado a partir de centavos", () => {
  assert.equal(_test.moneyFromCents(12000), "R$ 120,00");
});
