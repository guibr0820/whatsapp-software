const test = require('node:test');
const assert = require('node:assert/strict');
const {buildOrderFlow, validateOrderDetails, itemList, orderIntro, activeOrderStatus, activeOrderMenu} = require('../src/order-flow');

test('Flow de pedido contém etapas separadas, revisão, sucesso e erro', () => {
  const flow = buildOrderFlow();
  assert.equal(flow.version, '7.3');
  assert.deepEqual(flow.screens.map(screen => screen.id), ['IDENTIFICACAO','ENDERECO_ESCOLHA','ENDERECO','PAGAMENTO','PIX_EMAIL','REVISAO','SUCESSO','ERRO']);
  assert.equal(flow.screens.find(screen => screen.id === 'SUCESSO').terminal, true);
  assert.ok(flow.routing_model.IDENTIFICACAO.includes('ENDERECO_ESCOLHA'));
  const emailInput = flow.screens.find(screen => screen.id === 'PIX_EMAIL').layout.children[0].children.find(component => component.name === 'customer_email');
  assert.equal(emailInput.required, true);
  assert.equal(Object.hasOwn(emailInput, 'init-value'), false);
});

test('valida entrega e normaliza pagamento e troco', () => {
  const result = validateOrderDetails({client_name:' Ana ',fulfillment_type:'delivery',address_line:'Rua A, 10',address_reference:'Portão azul',payment_method:'cash',change_for:'100,00',observations:'Sem cebola'});
  assert.equal(result.clientName, 'Ana');
  assert.equal(result.changeForCents, 10000);
  assert.equal(result.addressLine, 'Rua A, 10');
});

test('endereço é obrigatório somente para entrega', () => {
  assert.throws(() => validateOrderDetails({client_name:'Ana',fulfillment_type:'delivery',payment_method:'pix',customer_email:'ana@teste.com'}), /endereço completo/i);
  assert.doesNotThrow(() => validateOrderDetails({client_name:'Ana',fulfillment_type:'pickup',payment_method:'pix',customer_email:'ana@teste.com'}));
});

test('recusa forma de recebimento e pagamento desconhecidas', () => {
  assert.throws(() => validateOrderDetails({client_name:'Ana',fulfillment_type:'drone',payment_method:'pix'}), /entrega/i);
  assert.throws(() => validateOrderDetails({client_name:'Ana',fulfillment_type:'pickup',payment_method:'cheque'}), /pagamento/i);
});

test('exige e-mail quando o pagamento escolhido é online', () => {
  assert.throws(() => validateOrderDetails({client_name:'Ana',fulfillment_type:'pickup',payment_method:'pix'}), /e-mail válido/i);
  assert.throws(() => validateOrderDetails({client_name:'Ana',fulfillment_type:'pickup',payment_method:'card_online'}), /e-mail válido/i);
  assert.doesNotThrow(() => validateOrderDetails({client_name:'Ana',fulfillment_type:'pickup',payment_method:'card_online',customer_email:'ana@teste.com'}));
  assert.doesNotThrow(() => validateOrderDetails({client_name:'Ana',fulfillment_type:'pickup',payment_method:'cash'}));
  assert.doesNotThrow(() => validateOrderDetails({client_name:'Ana',fulfillment_type:'pickup',payment_method:'card',card_type:'credit'}));
});

test('resume o carrinho com quantidade e nome dos produtos', () => {
  const order = {items:[{quantity:1,name:'Pizza de frango'},{quantity:2,name:'Coca-Cola'}],total_cents:5500};
  assert.equal(itemList(order.items), '1x Pizza de frango, 2x Coca-Cola');
  assert.equal(orderIntro(order), 'Recebemos seu carrinho: 1x Pizza de frango, 2x Coca-Cola. Total de R$ 55,00. Para continuar, clique em FINALIZAR e complete os dados do pedido.');
});

test('limita resumo de carrinho muito grande', () => {
  const summary = itemList([{quantity:1,name:'Produto muito longo A'},{quantity:2,name:'Produto muito longo B'},{quantity:3,name:'Produto muito longo C'}], 38);
  assert.match(summary, /outros$/);
  assert.ok(summary.length <= 38);
});

test('menu contextual informa o pedido ativo e sua situação', () => {
  const order = {number:'A123',status:'preparing'};
  assert.equal(activeOrderStatus(order), 'em preparo');
  assert.equal(activeOrderMenu(order), 'Vimos que você já tem um pedido #A123 em andamento. Situação: em preparo. Como deseja continuar?');
  assert.equal(activeOrderStatus({status:'ready'}), 'pronto');
  assert.equal(activeOrderStatus({status:'out_for_delivery'}), 'saiu para entrega');
});
