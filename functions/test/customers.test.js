const test = require('node:test');
const assert = require('node:assert/strict');
const { customerPayload, normalizePhone, customerId } = require('../src/customers');

test('normaliza telefone brasileiro com DDD', () => {
  assert.equal(normalizePhone('(11) 99491-7461', true), '5511994917461');
  assert.equal(normalizePhone('+55 11 99491-7461', true), '5511994917461');
});

test('valida e limita o cadastro de cliente', () => {
  assert.deepEqual(customerPayload({
    name: '  Mariana Souza ',
    phone: '(11) 99999-0000',
    email: 'MARIANA@EXEMPLO.COM',
    status: 'active',
    tags: ['VIP', 'VIP', 'Manicure'],
    notes: 'Prefere atendimento pela manhã.',
  }), {
    name: 'Mariana Souza',
    name_key: 'mariana souza',
    phone: '5511999990000',
    phone_key: '5511999990000',
    email: 'mariana@exemplo.com',
    notes: 'Prefere atendimento pela manhã.',
    tags: ['VIP', 'Manicure'],
    status: 'active',
  });
});

test('recusa dados inválidos e mantém id determinístico por telefone', () => {
  assert.throws(() => customerPayload({ name: 'A', phone: '123', status: 'active' }));
  assert.equal(customerId('5511994917461'), customerId('5511994917461'));
  assert.notEqual(customerId('5511994917461'), customerId('5511994917462'));
});
