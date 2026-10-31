const test = require("node:test");
const assert = require("node:assert/strict");
const { monthBounds, timestampMillis } = require("../src/plan-usage");

test("calcula os limites mensais no fuso de São Paulo", () => {
  const bounds = monthBounds("2026-10");
  assert.equal(new Date(bounds.start).toISOString(), "2026-10-01T03:00:00.000Z");
  assert.equal(new Date(bounds.end).toISOString(), "2026-11-01T03:00:00.000Z");
});

test("normaliza timestamps usados na reconciliação", () => {
  assert.equal(timestampMillis({ toMillis: () => 1234 }), 1234);
  assert.equal(timestampMillis("2026-10-28T12:00:00.000Z"), Date.parse("2026-10-28T12:00:00.000Z"));
  assert.equal(timestampMillis(null), 0);
});
