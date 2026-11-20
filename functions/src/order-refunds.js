'use strict';

// This helper does not cancel orders. The caller must first persist an explicit
// cancellation request and invoke it only for that order's verified payment.
async function refundCancelledOrderPayment({axios,apiUrl,accessToken,paymentId,expectedReference,expectedSellerId,expectedAmountCents}) {
  const id=String(paymentId || '');
  if(!/^\d+$/.test(id) || !Number.isSafeInteger(expectedAmountCents) || expectedAmountCents<=0 || !expectedReference || !expectedSellerId)throw new Error('Dados insuficientes para validar o estorno.');
  const url=`${apiUrl}/v1/payments/${id}`,headers={Authorization:`Bearer ${accessToken}`};
  const validate=payment=>{
    if(String(payment.id)!==id || payment.external_reference!==expectedReference || String(payment.collector_id ?? payment.user_id)!==String(expectedSellerId) || payment.currency_id!=='BRL' || Math.round(Number(payment.transaction_amount)*100)!==expectedAmountCents)throw new Error('O pagamento não corresponde à cobrança do pedido.');
  };
  let payment=(await axios.get(url,{headers,timeout:15000})).data;validate(payment);
  if(payment.status==='refunded' && Math.round(Number(payment.transaction_amount_refunded || 0)*100)>=expectedAmountCents)return {status:'refunded',paymentId:id};
  if(payment.status!=='approved')throw new Error('O pagamento ainda não está aprovado para estorno integral.');
  await axios.post(`${url}/refunds`,{},{headers:{...headers,'Content-Type':'application/json','X-Idempotency-Key':`automichat-order-refund-${id}`},timeout:20000});
  payment=(await axios.get(url,{headers,timeout:15000})).data;validate(payment);
  return {status:payment.status==='refunded' && Math.round(Number(payment.transaction_amount_refunded || 0)*100)>=expectedAmountCents?'refunded':'pending',paymentId:id};
}
module.exports={refundCancelledOrderPayment};
