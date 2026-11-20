'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {buildAppointmentPaymentTemplate}=require('../src/appointment-payment-template');
const input={customerName:'Ana',serviceName:'Revisão elétrica',merchantName:'Empresa',amountCents:16000,reference:'visit_123',pixCode:'000201-pix-exemplo',checkoutUrl:'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=abc'};
test('modelo de cobrança usa o mesmo valor em centavos, Pix e Checkout Pro',()=>{
  const result=buildAppointmentPaymentTemplate(input),details=result.template.components[1].parameters[0].action.order_details;
  assert.equal(result.template.name,'cobranca_atendimento_v1');assert.equal(details.total_amount.value,16000);assert.equal(details.order.items[0].amount.value,16000);
  assert.equal(details.payment_settings[0].pix_dynamic_code.code,input.pixCode);assert.equal(details.payment_settings[1].payment_link.uri,input.checkoutUrl);
});
test('recusa valores inválidos e links que não são do Mercado Pago',()=>{
  for(const changes of [{amountCents:0},{amountCents:1.5},{pixCode:''},{checkoutUrl:'https://www.mercadopago.com.br.evil.example/'},{reference:'a/b'}]) assert.throws(()=>buildAppointmentPaymentTemplate({...input,...changes}));
});
