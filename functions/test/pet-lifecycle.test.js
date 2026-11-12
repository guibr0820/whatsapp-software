const test = require('node:test');
const assert = require('node:assert/strict');
const { hasPetDelivery, petStatusAutomationId, petStatusMessage, petShortTemplate, petShortTemplateDefinitions, sendPetStatusNotification, nextPetAction } = require('../src/pet-lifecycle');

test('modelos curtos mantêm texto idêntico ao painel e concordância por sexo', () => {
  const appointment = { customer_name:'Guilherme',pet_name:'Juli',pet_sex:'female',transport_id:'both' };
  const template = petShortTemplate('pet_out_for_delivery', appointment);
  assert.equal(template.text, 'Olá, Guilherme! Juli já está a caminho de casa. Prepare-se para recebê-la na chegada!');
  assert.deepEqual(template.parameters, ['Guilherme','Juli','recebê-la']);
  assert.equal(template.name, petShortTemplate('pet_out_for_delivery',{...appointment,pet_sex:'male'}).name);
  assert.match(petShortTemplate('pet_out_for_delivery',{...appointment,pet_sex:'male'}).text, /recebê-lo/);
  assert.match(petShortTemplate('pet_received',appointment).text, /recebida/);
  const definitions = petShortTemplateDefinitions();
  assert.equal(definitions.length, 7);
  assert.equal(new Set(definitions.map(item=>item.name)).size, 7);
  definitions.forEach(item=>{
    assert.ok(!item.body.includes('Temos uma atualização'));
    assert.ok(!item.body.includes('Se precisar de ajuda'));
    assert.deepEqual([...item.body.matchAll(/\{\{(\d+)\}\}/g)].map(match=>Number(match[1])), item.parameters.map((_,i)=>i+1));
  });
  for(const action of ['pet_received','pet_in_service','pet_ready','pet_out_for_delivery']) for(const sex of ['male','female','unknown']) {
    const data={...appointment,pet_sex:sex,transport_id:action==='pet_ready'?'none':'both'};
    assert.equal(petShortTemplate(action,data).text,`Olá, Guilherme! ${petStatusMessage(action,data)}`);
  }
});

for (const state of ['APPROVED','PENDING','WAITING','LEGACY']) test(`envio ${state} grava exatamente o corpo enviado e respeita aprovação`, async () => {
  const appointment = { customer_name:'Guilherme',pet_name:'Juli',pet_sex:'female',transport_id:'both',customer_phone:'5511999999999',conversation_id:'conversation' };
  const template=petShortTemplate('pet_out_for_delivery',appointment);
  const records=new Map([
    ['organizations/org',{plano_id:'negocios',status:'active'}],
    ['organizations/org/automation_configs/lifecycle_reminders',{automations:{pet_out_for_delivery:{active:true}}}],
    ['organizations/org/integrations/whatsapp',{phone_number_id:'123',waba_id:'waba',access_token:'test'}],
    ['organizations/org/automation_configs/pet_status_templates',{enabled:state!=='LEGACY',templates:{[template.name]:state==='WAITING'?'PENDING':state}}],
  ]);
  const ref=path=>({path,get:async()=>({exists:records.has(path),data:()=>records.get(path)}),collection:name=>({doc:id=>ref(`${path}/${name}/${id}`)}),set:async(value)=>records.set(path,value)});
  const save=(target,value)=>records.set(target.path,{...records.get(target.path),...value});
  const db={doc:ref,runTransaction:async work=>work({get:target=>target.get(),set:save}),batch:()=>({set:save,commit:async()=>{}})};
  const admin={firestore:{FieldValue:{serverTimestamp:()=>1,increment:value=>value},Timestamp:{now:()=>1}}};
  let sent;
  const legacyBody='Olá, {{1}}! Temos uma atualização sobre o atendimento do seu pet: {{2}}\nSe precisar de ajuda, responda esta mensagem.';
  const result=await sendPetStatusNotification({admin,db,axios:{get:async(url,{params})=>({data:{data:[{name:params.name,language:'pt_BR',status:state==='WAITING'?'PENDING':'APPROVED',components:[{type:'BODY',text:params.name===template.name?template.body:legacyBody}]}]}}),post:async(url,body)=>{sent=body;return {data:{messages:[{id:'message'}]}};}},HttpsError:Error,organizationId:'org',appointmentId:'a',appointment,action:'pet_out_for_delivery'});
  assert.equal(result.status,'sent');
  const short=state==='APPROVED'||state==='PENDING';
  assert.equal(sent.template.name,short?template.name:'atualizacao_pet');
  assert.deepEqual(sent.template.components[0].parameters.map(item=>item.text),short?template.parameters:['Guilherme',petStatusMessage('pet_out_for_delivery',appointment)]);
  const message=[...records.entries()].find(([path])=>path.includes('/messages/'))[1];
  const expected=short?template.text:legacyBody.replace('{{1}}','Guilherme').replace('{{2}}',petStatusMessage('pet_out_for_delivery',appointment));
  assert.equal(message.text,expected);
  assert.equal(message.template_body,short?template.body:legacyBody);
  assert.equal(records.get('organizations/org/conversations/conversation').last_message,expected);
});

test('personaliza retirada e entrega conforme o sexo do pet', () => {
  const appointment = { pet_name:'Luna', customer_name:'Mariana' };
  assert.match(petStatusMessage('pet_ready', appointment, {sex:'female'}), /pronta para você vir buscá-la/);
  assert.match(petStatusMessage('pet_ready', {...appointment,pet_name:'Thor'}, {sex:'male'}), /pronto para você vir buscá-lo/);
  assert.match(petStatusMessage('pet_out_for_delivery', appointment, {sex:'female'}), /recebê-la/);
  assert.match(petStatusMessage('pet_ready', appointment, {}), /disponível para você vir buscar seu pet/);
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
