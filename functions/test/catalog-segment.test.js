const test = require('node:test');
const assert = require('node:assert/strict');
const { catalogMatchesSegment } = require('../src/catalog-segment');
test('catálogo preserva o segmento e impede serviço de beleza no pet shop', () => {
  assert.equal(catalogMatchesSegment({ name: 'Manicure' }, 'Pet shop e banho e tosa'), false);
  assert.equal(catalogMatchesSegment({ name: 'Manicure' }, 'Beleza e estética'), true);
  assert.equal(catalogMatchesSegment({ segment_name: 'Pet shop e banho e tosa' }, 'Pet shop e banho e tosa'), true);
  assert.equal(catalogMatchesSegment({ segment_name: 'Pet shop e banho e tosa' }, 'Saúde'), false);
});
