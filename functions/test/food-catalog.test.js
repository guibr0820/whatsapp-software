const test = require("node:test");
const assert = require("node:assert/strict");
const {_test} = require("../src/food-catalog");
const {createFoodCatalogFunctions} = require("../src/food-catalog");

test("desconexão exige proprietário e preserva o catálogo e seus produtos", async () => {
  let saved;
  const org = {status: "active", proprietario_uid: "owner"};
  const db = {doc(path) { return {
    async get() {
      if (path === "users/owner") return {exists: true, data: () => ({organizacao_id: "org"})};
      if (path === "organizations/org") return {exists: true, data: () => org};
      if (path === "organizations/org/members/owner") return {exists: true, data: () => ({status: "active"})};
      if (path === "organizations/org/integrations/whatsapp") return {exists: true, data: () => ({active: true, waba_id: "12345", access_token: "existing"})};
      if (path === "organizations/org/catalog_config/meta") return {exists: true, data: () => ({connected: false, reauthorization_required: true, catalog_id: "12345"})};
      throw new Error(`Consulta inesperada: ${path}`);
    },
    async set(value, options) { assert.equal(path, "organizations/org/catalog_config/meta"); saved = {value, options}; },
  }; }};
  const admin = {firestore: {FieldValue: {delete: () => "DELETE", serverTimestamp: () => "NOW"}}};
  class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const functions = createFoodCatalogFunctions({admin, db, onCall: (_options, handler) => handler, onRequest: (_options, handler) => handler, HttpsError, axios: {}, secrets: {}, params: {}});
  await functions.disconnectFoodCatalog({auth: {uid: "owner"}, data: {organizationId: "org"}});
  assert.equal(saved.value.connected, false);
  assert.equal(saved.value.reauthorization_required, true);
  assert.equal(saved.value.access_token, "DELETE");
  assert.equal(saved.value.catalog_id, undefined);
  assert.equal(saved.options.merge, true);
  assert.deepEqual(await functions.connectFoodCatalog({auth: {uid: "owner"}, data: {organizationId: "org"}}), {authorizationRequired: true});
  await assert.rejects(functions.syncFoodCatalog({auth: {uid: "owner"}, data: {organizationId: "org"}}), /Reconecte o catálogo/);
  org.proprietario_uid = "another-owner";
  await assert.rejects(functions.disconnectFoodCatalog({auth: {uid: "owner"}, data: {organizationId: "org"}}));
});

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
