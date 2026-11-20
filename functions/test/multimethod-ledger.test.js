'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {decidePaymentApplication,applyVerifiedPayment}=require('../src/multimethod-ledger');
const base={attempt:{active:true,received_payment_ids:{}},appointment:{status:'confirmed',total_price:100,paid_cents:0},paymentId:'123',amountCents:10000};
test('primeiro pagamento aprovado é aplicado ao saldo',()=>{const result=decidePaymentApplication(base);assert.equal(result.kind,'apply');assert.equal(result.remainingCents,0);assert.equal(result.paymentStatus,'paid');});
test('mesmo pagamento recebido novamente é idempotente',()=>{assert.equal(decidePaymentApplication({...base,attempt:{active:true,received_payment_ids:{'123':true}}}).kind,'duplicate_event');});
test('segundo pagamento, saldo alterado ou agendamento encerrado exige revisão',()=>{
  assert.equal(decidePaymentApplication({...base,attempt:{active:true,applied_payment_id:'456'}}).reason,'multiple_payments');
  assert.equal(decidePaymentApplication({...base,appointment:{status:'cancelled',total_price:100,paid_cents:0}}).kind,'review');
  assert.equal(decidePaymentApplication({...base,appointment:{status:'confirmed',total_price:100,paid_cents:5000}}).kind,'review');
  assert.equal(decidePaymentApplication({...base,attempt:{active:false}}).kind,'review');
  assert.equal(decidePaymentApplication({...base,late:true}).reason,'late_or_changed_balance');
});
test('aplicação transacional registra uma vez e destaca segundo pagamento',async()=>{
  const values=new Map([['attempt',{active:true}],['appointment',{status:'confirmed',total_price:100,paid_cents:0}]]);
  const ref=path=>({path});const db={runTransaction:async fn=>fn({get:async r=>({data:()=>values.get(r.path)}),set:(r,v)=>values.set(r.path,{...values.get(r.path),...v})})};
  const admin={firestore:{FieldValue:{serverTimestamp:()=>123}}};const args={db,admin,attemptRef:ref('attempt'),appointmentRef:ref('appointment'),amountCents:10000};
  assert.equal((await applyVerifiedPayment({...args,paymentId:'123'})).kind,'apply');
  assert.equal((await applyVerifiedPayment({...args,paymentId:'123'})).kind,'duplicate_event');
  assert.equal((await applyVerifiedPayment({...args,paymentId:'456'})).kind,'review');
  assert.equal(values.get('appointment').paid_cents,10000);assert.equal(values.get('appointment').payment_review_extra_cents,10000);assert.equal(values.get('appointment').payment_status,'payment_review');
});
