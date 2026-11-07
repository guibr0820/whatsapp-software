const test = require('node:test');
const assert = require('node:assert/strict');
const { ownerProfileName } = require('../src/admin-panel');

class TestHttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

test('normaliza o nome comercial e bloqueia conteúdo inválido', () => {
  assert.equal(ownerProfileName('  Studio Bella  ', TestHttpsError), 'Studio Bella');
  assert.throws(() => ownerProfileName('A', TestHttpsError), /entre 2 e 80/);
  assert.throws(() => ownerProfileName(`Studio\u0000Bella`, TestHttpsError), /caracteres inválidos/);
  assert.throws(() => ownerProfileName('x'.repeat(81), TestHttpsError), /entre 2 e 80/);
});
