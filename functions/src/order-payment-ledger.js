'use strict';

// Provider signature, seller, reference, currency and amount are verified by the caller.
function decideOrderPayment({attempt,order,paymentId,amountCents,late=false}) {
  const id=String(paymentId || '');
  if(!/^\d+$/.test(id) || !Number.isSafeInteger(amountCents) || amountCents<=0)throw new Error('Pagamento inválido.');
  if(attempt?.received_payment_ids?.[id])return {kind:'duplicate_event',paymentId:id};
  if(!order || Number(order.total_cents)!==amountCents || late || attempt?.active===false || attempt?.cancel_requested || attempt?.cancel_completed || attempt?.applied_payment_id || ['cancelled','canceled','cancellation_pending','payment_review','completed'].includes(order.status)) return {kind:'review',paymentId:id,amountCents,reason:attempt?.applied_payment_id?'multiple_payments':'late_or_changed_order'};
  if(!['awaiting_confirmation','awaiting_payment','confirmed'].includes(order.status))return {kind:'review',paymentId:id,amountCents,reason:'invalid_order_status'};
  return {kind:'apply',paymentId:id,amountCents,status:order.status==='awaiting_payment'?'confirmed':order.status};
}

async function applyVerifiedOrderPayment({db,admin,attemptRef,orderRef,paymentId,amountCents,late=false}) {
  return db.runTransaction(async tx=>{
    const [attemptSnap,orderSnap]=await Promise.all([tx.get(attemptRef),tx.get(orderRef)]);
    const attempt=attemptSnap.data(),order=orderSnap.data();
    if(!attempt || !order)throw new Error('Pedido ou cobrança não encontrado.');
    const result=decideOrderPayment({attempt,order,paymentId,amountCents,late});
    if(result.kind==='duplicate_event')return result;
    const now=admin.firestore.FieldValue.serverTimestamp(),received={...(attempt.received_payment_ids || {}),[result.paymentId]:{amount:amountCents,disposition:result.kind}};
    if(result.kind==='apply'){
      tx.set(orderRef,{status:result.status,payment:{...order.payment,status:'paid',payment_id:result.paymentId,paid_at:now},updated_at:now},{merge:true});
      tx.set(attemptRef,{received_payment_ids:received,applied_payment_id:result.paymentId,state:'paid',counterpart_close_pending:true,updated_at:now},{merge:true});
    }else{
      const extra=Object.values(received).filter(item=>item?.disposition==='review').reduce((sum,item)=>sum+Number(item.amount || 0),0);
      const cancelling=attempt.cancel_requested || attempt.cancel_completed;
      tx.set(orderRef,{status:cancelling?'cancellation_pending':'payment_review',payment_review_reason:result.reason,payment_review_extra_cents:extra,payment_review_provider_id:result.paymentId,updated_at:now},{merge:true});
      tx.set(attemptRef,{received_payment_ids:received,state:'payment_review',counterpart_close_pending:true,...(cancelling?{active:true,cancel_requested:true,cancel_completed:false}:{}),updated_at:now},{merge:true});
    }
    return result;
  });
}
module.exports={decideOrderPayment,applyVerifiedOrderPayment};
