// Legacy catalogues predate segment selection and belong to beauty services.
function segmentKey(name) {
  return String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}
function catalogMatchesSegment(item, segmentName) {
  const current = segmentKey(segmentName);
  if (!current) return true;
  if (item.segment_name) return segmentKey(item.segment_name) === current;
  return current === 'beleza e estetica';
}
module.exports = { segmentKey, catalogMatchesSegment };
