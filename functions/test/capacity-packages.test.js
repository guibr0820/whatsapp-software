const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_CAPACITY_PACKAGES, normalizeCapacityPackage, packageDocument, packagePublic } = require('../src/capacity-packages');

test('oferece os cinco pacotes iniciais na ordem comercial', () => {
  assert.deepEqual(DEFAULT_CAPACITY_PACKAGES.map(item => item.priceCents), [1990, 3500, 5500, 10000, 15000]);
  assert.deepEqual(DEFAULT_CAPACITY_PACKAGES.map(item => item.reminders), [100, 250, 500, 1000, 2000]);
  assert.deepEqual(DEFAULT_CAPACITY_PACKAGES.map(item => item.appointments), [100, 250, 500, 1000, 2000]);
});

test('normaliza pacote administrativo e converte preço para centavos', () => {
  const item = normalizeCapacityPackage({ id: 'teste', name: 'Teste', price: 35, reminders: 250, appointments: 200, active: true, featured: true, sortOrder: 20 });
  assert.equal(item.priceCents, 3500);
  assert.deepEqual(packagePublic(item.id, packageDocument(item)), item);
});

test('rejeita pacotes sem créditos ou com preço inválido', () => {
  assert.throws(() => normalizeCapacityPackage({ id: 'x', name: 'X', price: 0, reminders: 100, appointments: 100 }), /Nome/);
  assert.throws(() => normalizeCapacityPackage({ id: 'teste', name: 'Teste', price: 10, reminders: 0, appointments: 100 }), /lembretes/);
  assert.throws(() => normalizeCapacityPackage({ id: 'teste', name: 'Teste', price: -1, reminders: 100, appointments: 100 }), /Preço/);
});
