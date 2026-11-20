'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createMultiPayment}=require('../src/multimethod-payment');
const {paymentOutcome,paymentPayload}=require('../src/mercado-pago');
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
function fixture({approved=true}={}){
  const values=new Map(),sent=[];let pixStatus='pending',cardStatus='pending',reference='',preferenceExpired=false,failClose=false;
  const write=(path,data,options)=>{const previous=values.get(path) || {};values.set(path,options?.merge?{...previous,...data,...(data.payment?{payment:{...previous.payment,...data.payment}}:{})}:data);};
  const ref=path=>({path,id:path.split('/').at(-1),collection:name=>({doc:id=>ref(`${path}/${name}/${id}`)}),get:async()=>({data:()=>values.get(path)}),set:async(data,options)=>write(path,data,options)});
  const db={doc:ref,runTransaction:async fn=>fn({get:r=>r.get(),set:(r,data,options)=>write(r.path,data,options)})};
  const now=()=>123;const file={save:async()=>{}};const admin={firestore:{FieldValue:{serverTimestamp:now},Timestamp:{fromMillis:value=>({toMillis:()=>value})}},storage:()=>({bucket:()=>({name:'test-bucket',file:()=>file})})};
  const root=org=>ref(`organizations/${org}`),account=org=>root(org).collection('integrations').doc('mercadopago');
  values.set('organizations/o',{nome:'Empresa'});values.set('organizations/o/appointments/a',{status:'confirmed',total_price:100,paid_cents:0,customer_phone:'5511999999999',customer_name:'Ana',conversation_id:'c',service:'Reparo'});
  values.set('organizations/o/integrations/mercadopago',{active:true,seller_id:'1'});values.set('organizations/o/integrations/whatsapp',{active:true,access_token:'token',phone_number_id:'123',waba_id:'456'});
  values.set('organizations/o/payment_settings/orders',{delivery:{allowPix:true,allowOnlineCard:true}});
  values.set('organizations/o/orders/p',{number:'1',status:'awaiting_confirmation',total_cents:10000,fulfillment_type:'delivery',customer_phone:'5511999999999',customer_name:'Ana',conversation_id:'c',payment:{method:'pix',customer_email:'ana@example.com',status:'pending'}});
  const payment=(id,status)=>({id,external_reference:reference,transaction_amount:100,transaction_amount_refunded:status==='refunded'?100:0,currency_id:'BRL',collector_id:'1',status,point_of_interaction:{transaction_data:{qr_code:'pix-code',qr_code_base64:Buffer.from('png').toString('base64')}}});
  const axios={
    get:async url=>{if(url.includes('/message_templates'))return{data:{data:[{name:'cobranca_atendimento_v1',language:'pt_BR',status:approved?'APPROVED':'PENDING',components:[{type:'BUTTONS',buttons:[{type:'ORDER_DETAILS'}]}]}]}};if(url.endsWith('/v1/payments/search'))return{data:{results:[payment('11',pixStatus),payment('22',cardStatus)]}};if(url.endsWith('/v1/payments/11'))return{data:payment('11',pixStatus)};if(url.endsWith('/v1/payments/22'))return{data:payment('22',cardStatus)};if(url.includes('/checkout/preferences/'))return{data:{expires:true,expiration_date_to:new Date(Date.now()-10000).toISOString()}};throw Error(`GET inesperado ${url}`);},
    post:async(url,body)=>{if(url.endsWith('/v1/payments')){reference=body.external_reference;return{data:payment('11',pixStatus)};}if(url.endsWith('/v1/payments/11/refunds')){pixStatus='refunded';return{data:{}};}if(url.endsWith('/v1/payments/22/refunds')){cardStatus='refunded';return{data:{}};}if(url.endsWith('/checkout/preferences'))return{data:{id:'pref-1',init_point:'https://www.mercadopago.com.br/checkout/v1/redirect?id=1'}};throw Error(`POST inesperado ${url}`);},
    put:async url=>{if(failClose)throw Error('falha no provedor');if(url.includes('/checkout/preferences/'))preferenceExpired=true;else if(url.endsWith('/v1/payments/11') && pixStatus!=='approved')pixStatus='cancelled';return{data:{}};},
  };
  const api=createMultiPayment({db,admin,axios,logger:{warn(){},error(){}},HttpsError,root,account,token:async()=> 'token',webhook:()=> 'https://example.com/webhook',assertFeature:async()=>{},notify:async(_a,_b,outbound)=>sent.push(outbound),paymentOutcome,paymentPayload,stamp:now,apiUrl:'https://api.mercadopago.com'});
  return{api,values,sent,ref,setPix:value=>pixStatus=value,setCard:value=>cardStatus=value,setFailClose:value=>failClose=value,expired:()=>preferenceExpired};
}
test('cria modelo com Pix, link de cartão e imagem QR sem confirmar pagamento',async()=>{
  const f=fixture(),result=await f.api.create('o','a');assert.equal(result.pixSent,true);assert.equal(result.qrSent,true);assert.equal(f.sent[0].type,'template');assert.equal(f.sent[1].type,'image');
  assert.equal(f.values.get('organizations/o/appointments/a').payment_status,'pending');assert.equal(f.values.get('organizations/o/appointments/a').paid_cents,0);
  await assert.rejects(f.api.create('o','a'),error=>error.code==='failed-precondition');
});
test('falha ao encerrar outra opção mantém conciliação ativa',async()=>{
  const f=fixture();await f.api.create('o','a');const id=f.values.get('organizations/o/appointments/a').balance_payment_attempt_id;
  f.setCard('approved');f.setFailClose(true);await assert.rejects(f.api.acceptWebhook(f.ref(`payment_attempts/${id}`),'22'));
  assert.equal(f.values.get(`payment_attempts/${id}`).active,true);assert.equal(f.values.get('organizations/o/appointments/a').paid_cents,10000);
  f.setFailClose(false);await f.api.process(f.ref(`payment_attempts/${id}`));assert.equal(f.expired(),true);
});
test('não cria cobrança se o modelo não está aprovado na conta',async()=>{
  const f=fixture({approved:false});await assert.rejects(f.api.create('o','a'),error=>error.code==='failed-precondition');assert.equal(f.values.get('organizations/o/appointments/a').payment_status,undefined);assert.equal(f.sent.length,0);
});
test('pagamento de cartão encerra Pix e registra eventual segundo pagamento para revisão',async()=>{
  const f=fixture();await f.api.create('o','a');const id=f.values.get('organizations/o/appointments/a').balance_payment_attempt_id;
  f.setCard('approved');await f.api.acceptWebhook(f.ref(`payment_attempts/${id}`),'22');
  assert.equal(f.values.get('organizations/o/appointments/a').paid_cents,10000);assert.equal(f.values.get('organizations/o/appointments/a').payment_status,'paid');assert.equal(f.expired(),true);
  await f.api.acceptWebhook(f.ref(`payment_attempts/${id}`),'22');assert.equal(f.values.get('organizations/o/appointments/a').paid_cents,10000);
  f.setPix('approved');await f.api.acceptWebhook(f.ref(`payment_attempts/${id}`),'11');
  assert.equal(f.values.get('organizations/o/appointments/a').payment_status,'payment_review');assert.equal(f.values.get('organizations/o/appointments/a').payment_review_extra_cents,10000);
});
test('estorno posterior do pagamento aplicado gera revisão',async()=>{
  const f=fixture();await f.api.create('o','a');const id=f.values.get('organizations/o/appointments/a').balance_payment_attempt_id;
  f.setCard('approved');await f.api.acceptWebhook(f.ref(`payment_attempts/${id}`),'22');
  f.setCard('refunded');await f.api.acceptWebhook(f.ref(`payment_attempts/${id}`),'22');
  assert.equal(f.values.get('organizations/o/appointments/a').payment_review_reason,'payment_reversed');assert.equal(f.values.get('organizations/o/appointments/a').payment_status,'payment_review');
});
test('pedido pago antes do aceite permanece aguardando o restaurante e é estornado ao recusar',async()=>{
  const f=fixture();const result=await f.api.createOrder('o','p');assert.equal(result.sent,true);
  const id=f.values.get('organizations/o/orders/p').payment.multi_attempt_id;
  f.setCard('approved');await f.api.acceptWebhook(f.ref(`payment_attempts/${id}`),'22');
  assert.equal(f.values.get('organizations/o/orders/p').status,'awaiting_confirmation');
  assert.equal(f.values.get('organizations/o/orders/p').payment.status,'paid');
  await f.api.cancelOrder('o','p','Restaurante indisponível');
  assert.equal(f.values.get('organizations/o/orders/p').status,'cancelled');
  assert.equal(f.values.get('organizations/o/orders/p').payment.status,'refunded');
});
test('pedido aceito aguarda pagamento e só depois fica confirmado',async()=>{
  const f=fixture();await f.api.createOrder('o','p');const order=f.values.get('organizations/o/orders/p');const id=order.payment.multi_attempt_id;
  f.values.set('organizations/o/orders/p',{...order,status:'awaiting_payment'});
  f.setPix('approved');await f.api.acceptWebhook(f.ref(`payment_attempts/${id}`),'11');
  assert.equal(f.values.get('organizations/o/orders/p').status,'confirmed');
});
