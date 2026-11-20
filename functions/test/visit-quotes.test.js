const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeQuote, quoteText, saveDraft, sendQuote, recordQuoteResponse } = require('../src/visit-quotes');
class HttpsError extends Error { constructor(code,message){super(message);this.code=code;} }

function fixture() {
  const rows = new Map();
  const snapshot = path => ({data:()=>rows.get(path),exists:rows.has(path)});
  const ref = path => ({path, get:async()=>snapshot(path), collection:name=>({doc:id=>ref(`${path}/${name}/${id}`)})});
  const set = (target,value,options) => rows.set(target.path,options?.merge ? {...rows.get(target.path),...value} : value);
  const db = {doc:ref,runTransaction:async fn=>fn({get:async r=>snapshot(r.path),set})};
  const admin={firestore:{FieldValue:{serverTimestamp:()=>123}}};
  rows.set('organizations/o/appointments/a',{home_visit:true,status:'visit_started',customer_phone:'5511999999999',conversation_id:'c'});
  rows.set('organizations/o/integrations/whatsapp',{active:true,access_token:'test',phone_number_id:'123'});
  const params={db,admin,org:'o',appointmentId:'a',actor:'owner',HttpsError};
  const input={service:'Troca da resistência',laborCents:12000,materialsCents:4000};
  const axios={post:async()=>({data:{messages:[{id:'wamid.1'}]}})};
  const reply=(id,choice,overrides={})=>recordQuoteResponse({db,admin,organizationId:'o',conversationId:'c',phone:'5511999999999',providerMessageId:'response-1',message:{context:{id:'wamid.1'},interactive:{button_reply:{id:`quote_${id}_${choice}`}}},...overrides});
  return {rows,params,input,axios,reply};
}

test('valida centavos e calcula o total sem arredondamento silencioso',()=>{
  const quote=normalizeQuote({service:' Serviço ',laborCents:12000,materialsCents:4000},HttpsError);
  assert.equal(quote.totalCents,16000);assert.match(quoteText(quote),/160,00/);
  for(const input of [{service:'',laborCents:1,materialsCents:0},{service:'x',laborCents:1.2,materialsCents:0},{service:'x',laborCents:1,materialsCents:-1}]) assert.throws(()=>normalizeQuote(input,HttpsError));
});

test('rascunho, envio e aprovação registram os valores da versão enviada uma única vez',async()=>{
  const f=fixture();await saveDraft({...f.params,input:f.input});
  const sent=await sendQuote({...f.params,expectedQuote:f.input,axios:f.axios,saveOutbound:async()=>{}});
  const appointment=f.rows.get('organizations/o/appointments/a');
  assert.equal(appointment.quote_current.status,'sent');assert.equal(appointment.quote_current.totalCents,16000);
  await f.reply(sent.versionId,'yes');
  assert.equal(f.rows.get('organizations/o/appointments/a').quote_current.status,'approved');
  await f.reply(sent.versionId,'no');
  assert.equal(f.rows.get('organizations/o/appointments/a').quote_current.status,'approved');
  assert.equal(f.rows.get(`organizations/o/appointments/a/quote_versions/${sent.versionId}`).response_message_id,'response-1');
});

test('respostas de outra empresa, telefone ou mensagem e versões antigas não aprovam o orçamento atual',async()=>{
  const f=fixture();await saveDraft({...f.params,input:f.input});
  const first=await sendQuote({...f.params,expectedQuote:f.input,axios:f.axios,saveOutbound:async()=>{}});
  await f.reply(first.versionId,'yes',{organizationId:'outra'});await f.reply(first.versionId,'yes',{phone:'5511888888888'});
  await f.reply(first.versionId,'yes',{message:{context:{id:'outra-mensagem'},interactive:{button_reply:{id:`quote_${first.versionId}_yes`}}}});
  assert.equal(f.rows.get('organizations/o/appointments/a').quote_current.status,'sent');
  await saveDraft({...f.params,input:{...f.input,laborCents:15000}});
  await assert.rejects(sendQuote({...f.params,expectedQuote:f.input,axios:f.axios,saveOutbound:async()=>{}}),{code:'failed-precondition'});
  const second=await sendQuote({...f.params,expectedQuote:{...f.input,laborCents:15000},axios:f.axios,saveOutbound:async()=>{}});
  await f.reply(first.versionId,'yes');
  assert.equal(f.rows.get('organizations/o/appointments/a').quote_current.id,second.versionId);
  assert.equal(f.rows.get('organizations/o/appointments/a').quote_current.status,'sent');
  await f.reply(second.versionId,'no');
  assert.equal(f.rows.get('organizations/o/appointments/a').quote_current.status,'discussion');
  assert.equal(f.rows.get('organizations/o/conversations/c').human_support,true);
});

test('falha ambígua impede envio repetido e conserva o rascunho',async()=>{
  const f=fixture();await saveDraft({...f.params,input:f.input});
  await assert.rejects(sendQuote({...f.params,expectedQuote:f.input,axios:{post:async()=>{throw new Error('timeout');}},saveOutbound:async()=>{}}),{code:'unavailable'});
  assert.equal(f.rows.get('organizations/o/appointments/a').quote_current.status,'send_uncertain');
  await assert.rejects(sendQuote({...f.params,expectedQuote:f.input,axios:f.axios,saveOutbound:async()=>{}}),{code:'failed-precondition'});
  assert.equal(f.rows.get('organizations/o/appointments/a').quote_draft.totalCents,16000);
});

test('orçamento direto fica na conversa e registra somente resposta vinculada à mensagem enviada',async()=>{
  const f=fixture(),params={...f.params,appointmentId:undefined,conversationId:'c'};
  f.rows.set('organizations/o/conversations/c',{contact_phone:'5511999999999',professional_intake_state:'awaiting_team',status:'open'});
  const quote={...f.input,notes:'Válido por 7 dias'};
  await saveDraft({...params,input:quote});
  const sent=await sendQuote({...params,expectedQuote:quote,axios:f.axios,saveOutbound:async()=>{}});
  assert.equal(f.rows.get('organizations/o/conversations/c').quote_current.status,'sent');
  await f.reply(sent.versionId,'yes',{phone:'5511888888888'});
  assert.equal(f.rows.get('organizations/o/conversations/c').quote_current.status,'sent');
  await f.reply(sent.versionId,'yes');
  assert.equal(f.rows.get('organizations/o/conversations/c').quote_current.status,'approved');
  assert.equal(f.rows.get('organizations/o/conversations/c').quote_current.notes,'Válido por 7 dias');
  assert.equal(f.rows.get('organizations/o/conversations/c').team_attention_id,'response-1');
});

test('orçamento direto impede enviar rascunho alterado e evita duplicação',async()=>{
  const f=fixture(),params={...f.params,appointmentId:undefined,conversationId:'c'};
  f.rows.set('organizations/o/conversations/c',{contact_phone:'5511999999999'});
  await saveDraft({...params,input:{...f.input,notes:'Sem pintura'}});
  await assert.rejects(sendQuote({...params,expectedQuote:{...f.input,notes:'Com pintura'},axios:f.axios,saveOutbound:async()=>{}}),{code:'failed-precondition'});
  await sendQuote({...params,expectedQuote:{...f.input,notes:'Sem pintura'},axios:f.axios,saveOutbound:async()=>{}});
  await assert.rejects(sendQuote({...params,expectedQuote:{...f.input,notes:'Sem pintura'},axios:f.axios,saveOutbound:async()=>{}}),{code:'failed-precondition'});
});
