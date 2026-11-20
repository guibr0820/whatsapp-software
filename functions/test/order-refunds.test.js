'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {refundCancelledOrderPayment}=require('../src/order-refunds');
const valid={id:123,external_reference:'ref',collector_id:456,currency_id:'BRL',transaction_amount:50,status:'approved',transaction_amount_refunded:0};
const args={apiUrl:'https://api.mercadopago.com',accessToken:'test',paymentId:'123',expectedReference:'ref',expectedSellerId:'456',expectedAmountCents:5000};
test('solicita estorno integral com chave idempotente e confirma no provedor',async()=>{
 let count=0,header;const axios={get:async()=>({data:count?{...valid,status:'refunded',transaction_amount_refunded:50}:valid}),post:async(_url,_body,options)=>{count++;header=options.headers['X-Idempotency-Key'];return {data:{}};}};
 const result=await refundCancelledOrderPayment({...args,axios});assert.equal(result.status,'refunded');assert.equal(header,'automichat-order-refund-123');assert.equal(count,1);
});
test('recusa pagamento de outra cobrança e não afirma estorno antes de confirmação',async()=>{
 let count=0;await assert.rejects(refundCancelledOrderPayment({...args,axios:{get:async()=>({data:{...valid,collector_id:999}}),post:async()=>{count++;}}}));assert.equal(count,0);
 const pending=await refundCancelledOrderPayment({...args,axios:{get:async()=>({data:valid}),post:async()=>({data:{}})}});assert.equal(pending.status,'pending');
});
test('estorno já confirmado não gera outra solicitação',async()=>{
 let count=0;const result=await refundCancelledOrderPayment({...args,axios:{get:async()=>({data:{...valid,status:'refunded',transaction_amount_refunded:50}}),post:async()=>{count++;}}});assert.equal(result.status,'refunded');assert.equal(count,0);
});
