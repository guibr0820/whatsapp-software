'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {decideOrderPayment,applyVerifiedOrderPayment}=require('../src/order-payment-ledger');
const base={attempt:{active:true},order:{status:'awaiting_confirmation',total_cents:5000},paymentId:'123',amountCents:5000};
test('pagamento anterior ao aceite mantém o pedido aguardando restaurante',()=>{assert.equal(decideOrderPayment(base).status,'awaiting_confirmation');});
test('pagamento após aceite libera confirmação, sem iniciar preparo',()=>{assert.equal(decideOrderPayment({...base,order:{status:'awaiting_payment',total_cents:5000}}).status,'confirmed');});
test('pagamento duplicado, tardio ou pedido cancelado exige revisão',()=>{
  assert.equal(decideOrderPayment({...base,attempt:{active:true,applied_payment_id:'456'}}).reason,'multiple_payments');
  assert.equal(decideOrderPayment({...base,late:true}).kind,'review');
  assert.equal(decideOrderPayment({...base,order:{status:'cancelled',total_cents:5000}}).kind,'review');
  assert.equal(decideOrderPayment({...base,attempt:{active:true,received_payment_ids:{'123':true}}}).kind,'duplicate_event');
});
test('pagamento confirmado é idempotente e não esconde segundo recebimento',async()=>{
  const values=new Map([['attempt',{active:true}],['order',{status:'awaiting_confirmation',total_cents:5000,payment:{method:'pix'}}]]);
  const db={runTransaction:async fn=>fn({get:async ref=>({data:()=>values.get(ref.path)}),set:(ref,data)=>values.set(ref.path,{...values.get(ref.path),...data})})};
  const admin={firestore:{FieldValue:{serverTimestamp:()=>123}}},args={db,admin,attemptRef:{path:'attempt'},orderRef:{path:'order'},amountCents:5000};
  assert.equal((await applyVerifiedOrderPayment({...args,paymentId:'123'})).kind,'apply');assert.equal(values.get('order').status,'awaiting_confirmation');
  assert.equal((await applyVerifiedOrderPayment({...args,paymentId:'123'})).kind,'duplicate_event');
  assert.equal((await applyVerifiedOrderPayment({...args,paymentId:'456'})).kind,'review');assert.equal(values.get('order').payment_review_extra_cents,5000);
});
