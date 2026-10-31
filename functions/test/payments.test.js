const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { normalizePolicy, quote } = require('../src/payment-policy');
const { createMercadoPago, seal, unseal, validSignature, paymentPayload, paymentOutcome, pixMessage, createPkce } = require('../src/mercado-pago');
test('sinal em centavos, percentual e limite do total; política presencial não cobra', () => {
  assert.deepEqual(quote(80, normalizePolicy({ mode:'deposit', depositValue:20 })), { totalCents:8000, depositCents:2000, remainingCents:6000 });
  assert.equal(quote(19.99, normalizePolicy({mode:'deposit',depositType:'percent',depositValue:25})).depositCents,500);
  assert.equal(quote(10, normalizePolicy({mode:'deposit',depositValue:20})).depositCents,1000);
  assert.equal(quote(80, normalizePolicy()).depositCents,0);
  assert.throws(()=>normalizePolicy({expiryMinutes:15}));
  assert.throws(()=>normalizePolicy({depositType:'percent',depositValue:101}));
  assert.throws(()=>quote(0, normalizePolicy({mode:'deposit'})));
});
test('credenciais são cifradas, adulterações e chave incorreta são recusadas',()=>{
  const key=crypto.randomBytes(32).toString('hex'), data={access_token:'private-token',refresh_token:'private-refresh'};
  const encrypted=seal(data,key);assert.ok(!encrypted.includes(data.access_token));assert.deepEqual(unseal(encrypted,key),data);
  assert.throws(()=>unseal(encrypted,crypto.randomBytes(32).toString('hex')));
  assert.throws(()=>seal(data,'abc'));
});
test('PKCE gera verifier e challenge S256 compatíveis',()=>{
  const { verifier, challenge } = createPkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
});
test('assinatura webhook de pagamento inclui id normalizado e request-id',()=>{
  const secret='webhook-secret',ts=String(Date.now()),id='123456',rid='request-1';
  const sig=crypto.createHmac('sha256',secret).update(`id:123456;request-id:${rid};ts:${ts};`).digest('hex');
  assert.ok(validSignature(id,rid,`ts=${ts},v1=${sig}`,secret));assert.ok(!validSignature(id,'other',`ts=${ts},v1=${sig}`,secret));assert.ok(!validSignature(id,rid,'v1=abc',secret));
});
test('cria Pix pelo fluxo Payments usado no SaaS Barbearia',()=>{
  const expiresAt=Date.now()+1800000,payload=paymentPayload({amount:1234,reference:'ref',appointmentId:'appt',expiresAt,email:'cliente@exemplo.com'},'https://example.com/webhook');
  assert.equal(payload.transaction_amount,12.34);assert.equal(payload.date_of_expiration,new Date(expiresAt).toISOString());assert.equal(payload.payer.email,'cliente@exemplo.com');assert.equal(payload.payment_method_id,'pix');assert.equal(payload.notification_url,'https://example.com/webhook');
});
test('aprovação exige referência, recebedor, moeda e valor efetivamente pago',()=>{
  const a={reference:'ref',amount:2000,sellerId:'123'},p={id:987,external_reference:'ref',transaction_amount:20,currency_id:'BRL',collector_id:123,status:'approved',status_detail:'accredited'};
  assert.equal(paymentOutcome(p,a),'paid');assert.equal(paymentOutcome({...p,status:'pending'},a),'pending');
  assert.throws(()=>paymentOutcome({...p,collector_id:456},a));assert.throws(()=>paymentOutcome({...p,currency_id:'USD'},a));assert.throws(()=>paymentOutcome({...p,transaction_amount:1},a));assert.throws(()=>paymentOutcome({...p,external_reference:'other'},a));assert.equal(paymentOutcome({...p,status:'rejected'},a),'expired');
});
test('mensagem envia o Pix Copia e Cola gerado após o clique',()=>{
  const a={amount:2000,expiresAt:Date.now()+1800000,reference:'ref',appointmentId:'appt'},booking={customer_name:'Cliente',service:'Consulta',remaining_cents:6000};
  const message=pixMessage(a,booking,{},'qr');
  assert.equal(message.type,'text');assert.ok(message.text.body.includes('Pix Copia e Cola:\nqr'));assert.ok(message.text.body.includes('R$ 20,00'));
});
function fixture() {
  const values=new Map(), stamp=n=>({toMillis:()=>n}), key=crypto.randomBytes(32).toString('hex');
  const save=(path,v,o)=>values.set(path,o?.merge?{...values.get(path),...v}:v);
  const snap=path=>({exists:values.has(path),id:path.split('/').at(-1),ref:ref(path),data:()=>values.get(path)});
  const ref=path=>({path,get:async()=>snap(path),set:async(v,o)=>save(path,v,o),update:async v=>save(path,v,{merge:true}),collection:n=>coll(`${path}/${n}`)});
  const coll=(path,filter=[])=>({doc:id=>ref(`${path}/${id}`),where:(f,op,v)=>coll(path,[...filter,[f,v]]),get:async()=>({docs:[...values.keys()].filter(k=>k.startsWith(path+'/')&&k.split('/').length===path.split('/').length+1&&filter.every(([f,v])=>values.get(k)[f]===v)).map(snap)})});
  const db={doc:ref,collection:coll,runTransaction:async fn=>fn({get:r=>r.get(),set:(r,v,o)=>save(r.path,v,o),update:(r,v)=>save(r.path,v,{merge:true})})};
  const admin={firestore:{FieldValue:{serverTimestamp:()=>stamp(Date.now())},Timestamp:{fromMillis:stamp}}};
  const a={reference:'ref',organizationId:'org',appointmentId:'appt',amount:2000,sellerId:'123',paymentId:'987',active:true,expiresAt:Date.now()+1800000,pix_sent:true};
  values.set('payment_attempts/ref',a);values.set('organizations/org',{proprietario_uid:'owner'});values.set('organizations/org/members/owner',{status:'active'});
  values.set('organizations/org/integrations/mercadopago',{active:true,seller_id:'123',expires_at:stamp(Date.now()+3600000),credentials:seal({access_token:'test-only'},key)});
  values.set('organizations/org/appointments/appt',{status:'awaiting_payment',professional_id:'p',appointment_date:'2026-11-20',deposit_cents:2000});
  values.set('organizations/org/booking_days/p_2026-11-20',{reservations:{appt:{start:600,end:630},other:{start:700,end:730}}});
  let payment={id:987,external_reference:'ref',currency_id:'BRL',collector_id:123,transaction_amount:20,status:'approved',status_detail:'accredited'}, paid=0,cancels=0,failCancel=false;
  const axios={get:async()=>({data:payment}),post:async()=>({data:payment}),put:async()=>{cancels++;if(failCancel)throw new Error('network');payment={...payment,status:'cancelled'};return{data:payment};}};
  const value=s=>({value:()=>s});
  const api=createMercadoPago({admin,db,axios,logger:{warn(){},error(){}},onCall:(_,fn)=>fn,onRequest:(_,fn)=>fn,onSchedule:(_,fn)=>fn,HttpsError:class extends Error{},secrets:{clientId:value('id'),clientSecret:value('secret'),encryptionKey:value(key),webhookSecret:value('sig')}});
  api.setOnPaid(async()=>{paid++;});
  return {api,values,ref,paid:()=>paid,cancels:()=>cancels,setPayment:v=>{payment={...payment,...v};},failCancel:()=>{failCancel=true;}};
}
test('webhook repetido confirma uma vez e preserva a reserva',async()=>{
  const f=fixture();await f.api.processAttempt(f.ref('payment_attempts/ref'));await f.api.processAttempt(f.ref('payment_attempts/ref'));
  assert.equal(f.values.get('organizations/org/appointments/appt').status,'confirmed');assert.equal(f.values.get('organizations/org/appointments/appt').payment_status,'paid');assert.equal(f.paid(),1);assert.ok(f.values.get('organizations/org/booking_days/p_2026-11-20').reservations.appt);
});
test('expiração confirma cancelamento no provedor antes de liberar apenas esse horário',async()=>{
  const f=fixture();f.values.get('payment_attempts/ref').expiresAt=0;f.setPayment({status:'pending',status_detail:'pending_waiting_transfer'});
  await f.api.processAttempt(f.ref('payment_attempts/ref'));assert.equal(f.cancels(),1);assert.equal(f.values.get('organizations/org/appointments/appt').status,'payment_expired');
  assert.deepEqual(Object.keys(f.values.get('organizations/org/booking_days/p_2026-11-20').reservations),['other']);assert.equal(f.paid(),0);
});
test('falha ao cancelar mantém o horário bloqueado e permite nova conciliação',async()=>{
  const f=fixture();f.values.get('payment_attempts/ref').expiresAt=0;f.setPayment({status:'pending'});f.failCancel();
  await assert.rejects(f.api.processAttempt(f.ref('payment_attempts/ref')));assert.equal(f.values.get('organizations/org/appointments/appt').status,'awaiting_payment');assert.equal(f.values.get('payment_attempts/ref').active,true);
});
test('pagamento de reserva alterada exige revisão, sem confirmar horário indevido',async()=>{
  const f=fixture();f.values.get('organizations/org/appointments/appt').status='cancelled';await f.api.processAttempt(f.ref('payment_attempts/ref'));
  assert.equal(f.values.get('organizations/org/appointments/appt').status,'payment_review');assert.equal(f.paid(),0);
});
test('só o dono configura e a conta com cobrança pendente não pode ser desconectada',async()=>{
  const f=fixture();await assert.rejects(f.api.functions.savePaymentSettings({auth:{uid:'intruder'},data:{organizationId:'org'}}));
  await assert.rejects(f.api.functions.disconnectMercadoPago({auth:{uid:'owner'},data:{organizationId:'org'}}));assert.equal(f.values.get('organizations/org/integrations/mercadopago').active,true);
});
test('Flow pede email só para sinal e grava reserva com tentativa antes de gerar cobrança',async()=>{
  const {createBookingRuntime}=require('../src/booking-flow');
  const f=fixture(), stamp=n=>({toMillis:()=>n}), updated=stamp(1), token='12345678-1234-1234-1234-123456789012';
  const date=new Date(Date.now()+3*86400000).toISOString().slice(0,10), settings=normalizePolicy({mode:'deposit'});
  f.values.set('organizations/org/services/s',{active:true,name:'Consulta',price:80,duration_minutes:30,updated_at:updated});
  f.values.set('organizations/org/professionals/p',{active:true,name:'Ana',service_ids:['s'],work_days:[0,1,2,3,4,5,6],work_start:'08:00',work_end:'18:00',interval_minutes:30,updated_at:updated});
  f.values.set('organizations/org/flow_configs/flow',{payment_schema_version:2});f.values.set('organizations/org/payment_settings/booking',settings);
  f.values.set('organizations/org/integrations/whatsapp',{active:true});
  f.values.set(`whatsapp_flow_sessions/${token}`,{organization_id:'org',phone:'5511999999999',conversation_id:'c',flow_id:'flow',expires_at:stamp(Date.now()+1800000),status:'sent'});
  let reminders=0,confirmed=0,generated=0;
  const db={doc:f.ref,runTransaction:async fn=>fn({get:r=>r.get(),set:(r,v,o)=>f.values.set(r.path,o?.merge?{...f.values.get(r.path),...v}:v)})};
  const payments={policy:async()=>settings,intent:async(org,id,a)=>({ref:f.ref('payment_attempts/new'),data:{organizationId:org,appointmentId:id,sellerId:'123',expiresAt:Date.now()+1800000,amount:a.deposit_cents}}),processAttempt:async()=>{generated++;assert.ok(f.values.has('payment_attempts/new'));assert.equal([...f.values.entries()].find(([k])=>k.startsWith('organizations/org/appointments/')&&k!=='organizations/org/appointments/appt')[1].status,'awaiting_payment');}};
  const runtime=createBookingRuntime({db,payments,admin:{firestore:{FieldValue:{serverTimestamp:()=>updated},Timestamp:{fromMillis:stamp,fromDate:d=>stamp(d.getTime())}}},taskQueue:{enqueue:async()=>{reminders++;}},axios:{post:async()=>{confirmed++;return{data:{messages:[{id:'m'}]}};}},saveOutbound:async()=>{},logger:{warn(){}}});
  const input={service_id:'s',extra_ids:[],professional_id:'p',date,time:'10:00',client_name:'Cliente'};
  const send=(step,extra={})=>runtime.handle({flow_token:token,action:'data_exchange',data:{...input,...extra,step}});
  assert.equal((await send('details')).screen,'PAGAMENTO');await assert.rejects(send('payment',{client_email:'invalid'}));
  const review=await send('payment',{client_email:'cliente@exemplo.com'});assert.equal(review.data.submit_label,'Gerar Pix do sinal');assert.ok(review.data.payment_summary.includes('20,00'));
  assert.equal((await send('confirm',{client_email:'cliente@exemplo.com'})).screen,'SUCESSO');assert.equal(generated,1);assert.equal(confirmed,0);assert.equal(reminders,0);
});
