const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_ORDER_NOTIFICATIONS, mergeNotifications, normalizeNotifications } = require('../src/order-notifications');

test('entrega as sete atualizações padrão', () => {
  assert.equal(DEFAULT_ORDER_NOTIFICATIONS.length, 7);
  assert.deepEqual(DEFAULT_ORDER_NOTIFICATIONS.map(item => item.id), ['received', 'confirmed', 'preparing', 'ready_pickup', 'out_for_delivery', 'delivered', 'cancelled']);
});

test('mescla somente o estado e protege a mensagem padrão', () => {
  const result = mergeNotifications({ out_for_delivery: { enabled: false, message: 'Mensagem personalizada de entrega.' } });
  const item = result.find(entry => entry.id === 'out_for_delivery');
  assert.equal(item.enabled, false);
  assert.equal(item.message, 'Seu pedido saiu para entrega! Chega em cerca de {{tempo_entrega}} minutos. 🛵');
  assert.equal(item.title, 'Saiu para entrega');
});

test('normaliza uma configuração completa', () => {
  const input = DEFAULT_ORDER_NOTIFICATIONS.map(item => ({ id: item.id, enabled: !item.enabled }));
  const result = normalizeNotifications(input);
  assert.equal(result.length, 7);
  assert.equal(result[0].enabled, !DEFAULT_ORDER_NOTIFICATIONS[0].enabled);
});

test('rejeita configuração incompleta', () => {
  assert.throws(() => normalizeNotifications(DEFAULT_ORDER_NOTIFICATIONS.slice(0, 2)), /invalid-argument/);
});
