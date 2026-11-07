const test = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULT_SEGMENTS, normalizeSegmentInput } = require("../src/segment-config");

class FakeHttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const cleanId = value => String(value || "").trim();
const text = (value, min, max, message) => {
  const result = String(value || "").trim();
  if (result.length < min || result.length > max) throw new FakeHttpsError("invalid-argument", message);
  return result;
};

test("segmentos iniciais cobrem serviços e alimentação sem misturar comércio", () => {
  const beauty = DEFAULT_SEGMENTS.find(item => item.id === "beleza-estetica");
  const food = DEFAULT_SEGMENTS.find(item => item.id === "pizzaria");
  assert.ok(beauty.screens.includes("appointments"));
  assert.ok(beauty.screens.includes("services"));
  assert.ok(food.screens.includes("orders"));
  assert.ok(food.screens.includes("menu"));
  assert.equal(food.family, "food");
  assert.equal(DEFAULT_SEGMENTS.find(item => item.id === "comercio").family, "sales");
  assert.equal(DEFAULT_SEGMENTS.find(item => item.id === "comercio").screens.includes("orders"), false);
});

test("configuração sempre preserva as telas essenciais e rejeita telas desconhecidas", () => {
  const value = normalizeSegmentInput({ id: "teste", name: "Teste", family: "sales", modules: ["quotes"], screens: ["payments"], active: true, sortOrder: 10 }, cleanId, text, FakeHttpsError);
  assert.deepEqual(value.screens, ["overview", "conversations", "contacts", "payments"]);
  assert.throws(() => normalizeSegmentInput({ id: "teste", name: "Teste", screens: ["admin"], sortOrder: 10 }, cleanId, text, FakeHttpsError), /tela inválida/);
  assert.throws(() => normalizeSegmentInput({ id: "teste", name: "Teste", family: "food", modules: ["unknown"], screens: [], sortOrder: 10 }, cleanId, text, FakeHttpsError), /módulo inválido/);
});
