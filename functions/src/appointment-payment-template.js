'use strict';

// Builds a message only; it does not create, send or reconcile payments.
function buildAppointmentPaymentTemplate({customerName,serviceName,merchantName,amountCents,reference,pixCode,checkoutUrl}) {
  const clean = (value,max) => String(value || '').trim().replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,max);
  const customer=clean(customerName,80),service=clean(serviceName,160),merchant=clean(merchantName,25),ref=clean(reference,64);
  if(!customer || !service || !merchant || !/^[A-Za-z0-9_-]{1,64}$/.test(ref) || !Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error('Dados inválidos para o modelo de cobrança.');
  const pix=String(pixCode || '').trim();
  let url;try{url=new URL(String(checkoutUrl || ''));}catch{throw new Error('Link do Checkout Pro inválido.');}
  if(!pix || pix.length > 4096 || url.protocol !== 'https:' || url.hostname !== 'www.mercadopago.com.br' || url.username || url.password) throw new Error('Pix ou link do Checkout Pro inválido.');
  const amount={value:amountCents,offset:100};
  const formatted=new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(amountCents/100);
  return {type:'template',template:{name:'cobranca_atendimento_v1',language:{code:'pt_BR'},components:[
    {type:'body',parameters:[customer,service,formatted].map(text=>({type:'text',text}))},
    {type:'button',sub_type:'order_details',index:'0',parameters:[{type:'action',action:{order_details:{reference_id:ref,type:'physical-goods',payment_type:'br',currency:'BRL',total_amount:amount,payment_settings:[{type:'pix_dynamic_code',pix_dynamic_code:{code:pix,merchant_name:merchant}},{type:'payment_link',payment_link:{uri:url.toString()}}],order:{status:'pending',items:[{retailer_id:ref,name:service,amount,quantity:1}],subtotal:amount,tax:{value:0,offset:100}}}}}]},
  ]}};
}
module.exports = {buildAppointmentPaymentTemplate};
