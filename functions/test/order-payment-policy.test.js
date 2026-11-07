const test = require('node:test');
const assert = require('node:assert/strict');
const {normalizeOrderPaymentPolicy, paymentOptionsFor} = require('../src/order-payment-policy');

test('mantém todas as formas presenciais liberadas por padrão', () => {
  assert.deepEqual(paymentOptionsFor({}, 'pickup').map(item => item.id), ['pix','cash','card']);
});

test('pagamento online obrigatório remove dinheiro e cartão presencial', () => {
  const policy = normalizeOrderPaymentPolicy({pickup:{requirePix:true,allowCash:true,allowCard:true}});
  assert.deepEqual(policy.pickup, {requireOnlinePayment:true,allowPix:true,allowOnlineCard:false,allowCash:false,allowCard:false});
  assert.deepEqual(paymentOptionsFor(policy, 'pickup').map(item => item.id), ['pix']);
});

test('cartão online é separado da maquininha e fica em uma parcela', () => {
  const policy = normalizeOrderPaymentPolicy({pickup:{allowPix:false,allowOnlineCard:true,allowCash:false,allowCard:false}});
  assert.deepEqual(paymentOptionsFor(policy, 'pickup').map(item => item.id), ['card_online']);
});

test('recusa modalidade sem forma de pagamento', () => {
  assert.throws(() => normalizeOrderPaymentPolicy({delivery:{allowPix:false,allowOnlineCard:false,allowCash:false,allowCard:false}}), /pelo menos uma/i);
});
