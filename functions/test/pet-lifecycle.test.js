const test = require('node:test');
const assert = require('node:assert/strict');
const { hasPetDelivery, petStatusAutomationId, petStatusMessage, nextPetAction } = require('../src/pet-lifecycle');

test('personaliza retirada e entrega conforme o sexo do pet', () => {
  const appointment = { pet_name:'Luna', customer_name:'Mariana' };
  assert.equal(petStatusMessage('pet_ready', appointment, {sex:'female'}), 'Luna já está pronta para você vir buscá-la.');
  assert.equal(petStatusMessage('pet_ready', {...appointment,pet_name:'Thor'}, {sex:'male'}), 'Thor já está pronto para você vir buscá-lo.');
  assert.match(petStatusMessage('pet_out_for_delivery', appointment, {sex:'female'}), /recebê-la/);
  assert.match(petStatusMessage('pet_ready', appointment, {}), /Pode vir buscar seu pet/);
});

test('separa retirada de entrega no fluxo operacional', () => {
  assert.equal(hasPetDelivery({transport_id:'both'}), true);
  assert.equal(nextPetAction({status:'pet_ready',transport_id:'delivery'}), 'pet_out_for_delivery');
  assert.equal(nextPetAction({status:'pet_ready',transport_id:'none'}), 'complete');
  assert.equal(petStatusAutomationId('pet_ready',{transport_id:'delivery'}), '');
  assert.equal(petStatusAutomationId('pet_ready',{transport_id:'none'}), 'pet_ready_pickup');
});
test('busca percorre saída, coleta e chegada; avisos respeitam o transporte',()=>{
  for(const transport_id of ['pickup','both']) {
    assert.equal(nextPetAction({status:'confirmed',transport_id}),'pet_pickup_started');
    assert.equal(nextPetAction({status:'pet_pickup_started',transport_id}),'pet_collected');
    assert.equal(nextPetAction({status:'pet_collected',transport_id}),'pet_received');
  }
  assert.equal(nextPetAction({status:'confirmed',transport_id:'none'}),'pet_received');
  assert.equal(petStatusAutomationId('complete',{transport_id:'both'}),'pet_delivered');
  assert.equal(petStatusAutomationId('complete',{transport_id:'pickup'}),'');
  assert.match(petStatusMessage('pet_collected',{pet_name:'Luna'}),/Luna já está com nossa equipe/);
});
