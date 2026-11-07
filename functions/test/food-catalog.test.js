const test = require("node:test");
const assert = require("node:assert/strict");
const {_test} = require("../src/food-catalog");

test("normaliza categoria e limita campos", () => {
  assert.deepEqual(_test.categoryPayload({name: " Pizzas ", description: " Artesanais ", active: true}), {name: "Pizzas", description: "Artesanais", active: true});
  assert.throws(() => _test.categoryPayload({name: ""}), /nome da categoria/i);
});

test("produto usa centavos e valida código e disponibilidade", () => {
  const product = _test.productPayload({name: "Pizza Calabresa", description: "Molho, queijo e calabresa", price: 49.9, categoryId: "pizzas", retailerId: "pizza-calabresa-g", availability: "in stock", active: true});
  assert.equal(product.price_cents, 4990);
  assert.equal(product.retailer_id, "PIZZA-CALABRESA-G");
  assert.throws(() => _test.productPayload({...product, price: -1, categoryId: "pizzas"}), /Preço inválido/);
});

test("pedido público não expõe campos internos", () => {
  const result = _test.publicOrder({number: "ABC123", customer_name: "Ana", customer_phone: "5511999999999", status: "awaiting_data", currency: "BRL", total_cents: 4990, fulfillment_type: "pending", payment: {method: "pending"}, secret: "não pode sair", items: [{name: "Pizza", retailer_id: "P1", quantity: 1, unit_price_cents: 4990, total_cents: 4990}]});
  assert.equal(result.total_cents, 4990);
  assert.equal(result.status, "awaiting_data");
  assert.equal(result.payment.method, "pending");
  assert.equal(result.secret, undefined);
});

test("lista somente pedidos concluídos pelo Flow e rejeita rascunhos", () => {
  const valid = {status: "awaiting_confirmation", fulfillment_type: "pickup", payment: {method: "cash", status: "pending"}};
  assert.equal(_test.isOperationalOrder(valid), true);
  assert.equal(_test.isOperationalOrder({...valid, status: "awaiting_data"}), false);
  assert.equal(_test.isOperationalOrder({...valid, fulfillment_type: "pending"}), false);
  assert.equal(_test.isOperationalOrder({...valid, payment: {method: "pending", status: "pending"}}), false);
});

test("aceita cartão online como forma operacional de pagamento", () => {
  const order = {status: "awaiting_confirmation", fulfillment_type: "pickup", payment: {method: "card_online", status: "pending"}};
  assert.equal(_test.isOperationalOrder(order), true);
});

test("pedido para entrega exige endereço antes de avançar", () => {
  const issue = _test.orderOperationalIssue({status: "awaiting_confirmation", fulfillment_type: "delivery", payment: {method: "card"}, address: {}});
  assert.match(issue, /endereço completo/i);
  assert.equal(_test.orderOperationalIssue({status: "awaiting_confirmation", fulfillment_type: "delivery", payment: {method: "pix"}, address: {line: "Rua das Flores, 10"}}), "");
});

test("mensagem de erro da Meta não repassa token longo", () => {
  const result = _test.safeMetaMessage({message: `Falha EA${"a".repeat(40)}`});
  assert.match(result, /credencial protegida/);
});
