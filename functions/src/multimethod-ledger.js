'use strict';

// Pure decision function; provider identity/amount must be validated before calling it.
function decidePaymentApplication({attempt,appointment,paymentId,amountCents,late=false}) {
  const id=String(paymentId || '');
  if(!/^\d+$/.test(id) || !Number.isSafeInteger(amountCents) || amountCents<=0) throw new Error('Pagamento inválido.');
  const seen=attempt?.received_payment_ids || {};
  if(seen[id]) return {kind:'duplicate_event',paymentId:id};
  const paid=Math.max(0,Number(appointment?.paid_cents || 0));
  const total=Math.max(0,Math.round(Number(appointment?.total_price || 0)*100));
  const balance=Math.max(0,total-paid);
  if(!appointment || late || ['cancelled','canceled','no_show','payment_review'].includes(appointment.status) || attempt?.applied_payment_id || amountCents>balance || attempt?.active === false) {
    return {kind:'review',paymentId:id,amountCents,reason:attempt?.applied_payment_id ? 'multiple_payments' : 'late_or_changed_balance'};
  }
  return {kind:'apply',paymentId:id,amountCents,paidCents:paid+amountCents,remainingCents:balance-amountCents,paymentStatus:balance===amountCents?'paid':'partial'};
}

async function applyVerifiedPayment({db,admin,attemptRef,appointmentRef,paymentId,amountCents,late=false}) {
  return db.runTransaction(async tx => {
    const [attemptSnapshot,appointmentSnapshot]=await Promise.all([tx.get(attemptRef),tx.get(appointmentRef)]);
    const attempt=attemptSnapshot.data(),appointment=appointmentSnapshot.data();
    if(!attempt || !appointment) throw new Error('Cobrança ou atendimento não encontrado.');
    const result=decidePaymentApplication({attempt,appointment,paymentId,amountCents,late});
    if(result.kind==='duplicate_event') return result;
    const now=admin.firestore.FieldValue.serverTimestamp();
    const received={...(attempt.received_payment_ids || {}),[result.paymentId]:{amount:amountCents,disposition:result.kind}};
    if(result.kind==='apply') {
      tx.set(appointmentRef,{paid_cents:result.paidCents,remaining_cents:result.remainingCents,payment_status:result.paymentStatus,payment_provider:'mercadopago',payment_provider_id:result.paymentId,payment_updated_at:now,updated_at:now},{merge:true});
      tx.set(attemptRef,{received_payment_ids:received,applied_payment_id:result.paymentId,state:'paid',counterpart_close_pending:true,updated_at:now},{merge:true});
    } else {
      // Preserve the actual extra receipt for manual investigation; do not hide it in paid_cents.
      const reviewTotal=Object.values(received).filter(item=>item?.disposition==='review').reduce((sum,item)=>sum+Number(item.amount || 0),0);
      tx.set(appointmentRef,{payment_status:'payment_review',payment_review_reason:result.reason,payment_review_extra_cents:reviewTotal,payment_review_provider_id:result.paymentId,updated_at:now},{merge:true});
      tx.set(attemptRef,{received_payment_ids:received,state:'payment_review',counterpart_close_pending:true,updated_at:now},{merge:true});
    }
    return result;
  });
}
async function flagPaymentReversal({db,admin,attemptRef,appointmentRef,paymentId,providerStatus}) {
  if(!['refunded','charged_back'].includes(providerStatus))return false;
  return db.runTransaction(async tx=>{
    const [attemptSnapshot,appointmentSnapshot]=await Promise.all([tx.get(attemptRef),tx.get(appointmentRef)]);
    const attempt=attemptSnapshot.data(),appointment=appointmentSnapshot.data();
    if(!appointment || attempt?.applied_payment_id!==String(paymentId) || attempt.reversal_status===providerStatus)return false;
    const now=admin.firestore.FieldValue.serverTimestamp();
    tx.set(appointmentRef,{payment_status:'payment_review',payment_review_reason:'payment_reversed',payment_review_provider_id:String(paymentId),updated_at:now},{merge:true});
    tx.set(attemptRef,{state:'payment_review',reversal_status:providerStatus,reversal_at:now},{merge:true});return true;
  });
}
module.exports={decidePaymentApplication,applyVerifiedPayment,flagPaymentReversal};
