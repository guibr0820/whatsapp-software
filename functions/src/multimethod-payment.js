'use strict';
const crypto=require('node:crypto');
const {buildAppointmentPaymentTemplate}=require('./appointment-payment-template');
const {applyVerifiedPayment,flagPaymentReversal}=require('./multimethod-ledger');
const {applyVerifiedOrderPayment}=require('./order-payment-ledger');
const {refundCancelledOrderPayment}=require('./order-refunds');
const {normalizeOrderPaymentPolicy}=require('./order-payment-policy');

function createMultiPayment({db,admin,axios,logger,HttpsError,root,account,token,webhook,assertFeature,notify,paymentOutcome,paymentPayload,stamp,apiUrl}) {
  const attemptRef=id=>db.doc(`payment_attempts/${id}`);
  const timestamp=()=>admin.firestore.FieldValue.serverTimestamp();
  const paymentUrl=attempt=>{const url=new URL(webhook());url.searchParams.set('attemptId',attempt.reference);return url.toString();};
  const headers=access=>({Authorization:`Bearer ${access}`});
  const entityRef=attempt=>root(attempt.organizationId).collection(attempt.kind==='order_multi'?'orders':'appointments').doc(attempt.kind==='order_multi'?attempt.orderId:attempt.appointmentId);
  async function approvedTemplate(integration) {
    if(!integration?.active || !integration.access_token || !integration.phone_number_id || !/^\d+$/.test(String(integration.waba_id || ''))) throw new HttpsError('failed-precondition','Conecte o WhatsApp antes de gerar a cobrança.');
    const result=await axios.get(`https://graph.facebook.com/${integration.graph_version || 'v24.0'}/${integration.waba_id}/message_templates`,{headers:headers(integration.access_token),params:{name:'cobranca_atendimento_v1',fields:'name,status,language,components'},timeout:15000});
    const template=(result.data?.data || []).find(item=>item.name==='cobranca_atendimento_v1' && item.language==='pt_BR' && item.status==='APPROVED' && (item.components || []).some(component=>component.type==='BUTTONS' && (component.buttons || []).some(button=>button.type==='ORDER_DETAILS')));
    if(!template) throw new HttpsError('failed-precondition','O modelo de cobrança com detalhes do pedido precisa estar aprovado nesta conta do WhatsApp.');
  }
  async function create(org,appointmentId) {
    await assertFeature(db,org,'pix',HttpsError);
    const appointmentRef=root(org).collection('appointments').doc(appointmentId);
    const [snap,connectionSnap,integrationSnap]=await Promise.all([appointmentRef.get(),account(org).get(),root(org).collection('integrations').doc('whatsapp').get()]);
    const appointment=snap.data(),connection=connectionSnap.data();
    if(!appointment || appointment.payment_status==='payment_review' || ['cancelled','canceled','no_show','payment_expired','payment_review'].includes(appointment.status)) throw new HttpsError('failed-precondition','Este atendimento não permite uma nova cobrança.');
    if(!connection?.active) throw new HttpsError('failed-precondition','Conecte o Mercado Pago antes de cobrar.');
    if(!/^\d{8,20}$/.test(String(appointment.customer_phone || '')) || !appointment.conversation_id) throw new HttpsError('failed-precondition','Este atendimento precisa ter uma conversa WhatsApp vinculada.');
    const existingId=String(appointment.balance_payment_attempt_id || '');
    if(existingId){const existing=(await attemptRef(existingId).get()).data();if(existing?.active)throw new HttpsError('failed-precondition','Já existe uma cobrança em andamento para este atendimento.');}
    await approvedTemplate(integrationSnap.data());
    const total=Math.max(0,Math.round(Number(appointment.total_price || 0)*100));
    const received=Math.max(0,Number(appointment.paid_cents || 0)-Number(appointment.refunded_cents || 0));
    const amount=total-received;
    if(!Number.isSafeInteger(amount) || amount<=0)throw new HttpsError('failed-precondition','Não há saldo válido para cobrar.');
    const reference=crypto.randomBytes(20).toString('hex'),ref=attemptRef(reference),expiresAt=Date.now()+30*60000;
    const email=/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(appointment.customer_email || '')) ? appointment.customer_email : `cliente-${crypto.createHash('sha256').update(appointment.customer_phone).digest('hex').slice(0,12)}@automichat.com.br`;
    await db.runTransaction(async tx=>{
      const fresh=(await tx.get(appointmentRef)).data();
      const balance=Math.round(Number(fresh?.total_price || 0)*100)-Math.max(0,Number(fresh?.paid_cents || 0)-Number(fresh?.refunded_cents || 0));
      if(!fresh || balance!==amount || String(fresh.balance_payment_attempt_id || '')!==existingId || ['pending','payment_review'].includes(fresh.payment_status))throw new HttpsError('failed-precondition','O saldo mudou ou já existe cobrança em andamento. Atualize o atendimento.');
      tx.set(ref,{reference,kind:'balance_multi',organizationId:org,appointmentId,amount,email,sellerId:connection.seller_id,expiresAt,active:true,state:'creating',created_at:timestamp(),previousPaymentStatus:fresh.payment_status || 'onsite'});
      tx.set(appointmentRef,{payment_status:'pending',balance_payment_attempt_id:reference,balance_payment_expires_at:admin.firestore.Timestamp.fromMillis(expiresAt),updated_at:timestamp()},{merge:true});
    });
    try{await process(ref);}catch(error){logger.warn('Cobrança com Pix e cartão aguarda conciliação',{attemptId:reference,status:error.response?.status || null});}
    const current=(await ref.get()).data() || {};
    return {status:current.state==='payment_review'?'payment_review':current.applied_payment_id?'paid':'pending',amount,expiresAt,pixSent:current.template_sent===true,qrSent:current.qr_sent===true,needsReview:current.state==='payment_review' || ['creating','review'].includes(current.preference_state) || ['sending','uncertain'].includes(current.template_state)};
  }
  async function createOrder(org,orderId) {
    await assertFeature(db,org,'pix',HttpsError);
    const orderRef=root(org).collection('orders').doc(orderId);
    const [snap,connectionSnap,integrationSnap,settingsSnap]=await Promise.all([orderRef.get(),account(org).get(),root(org).collection('integrations').doc('whatsapp').get(),root(org).collection('payment_settings').doc('orders').get()]);
    const order=snap.data(),connection=connectionSnap.data();
    if(!order || !['awaiting_confirmation','awaiting_payment'].includes(order.status) || !['pix','card_online'].includes(order.payment?.method))throw new HttpsError('failed-precondition','Este pedido não permite cobrança online.');
    const rule=normalizeOrderPaymentPolicy(settingsSnap.data() || {})[order.fulfillment_type || 'delivery'];
    if(!rule?.allowPix || !rule?.allowOnlineCard)throw new HttpsError('failed-precondition','Ative Pix e cartão online nas configurações de pagamento para usar essa cobrança.');
    if(!connection?.active)throw new HttpsError('failed-precondition','Conecte o Mercado Pago antes de cobrar.');
    if(!/^\d{8,20}$/.test(String(order.customer_phone || '')) || !order.conversation_id)throw new HttpsError('failed-precondition','O pedido precisa ter uma conversa WhatsApp vinculada.');
    const existingId=String(order.payment?.multi_attempt_id || '');
    if(existingId){const existing=(await attemptRef(existingId).get()).data();if(existing?.active){await process(attemptRef(existingId));return {status:'pending',existing:true};}throw new HttpsError('failed-precondition','A cobrança anterior precisa ser conferida antes de gerar outra.');}
    await approvedTemplate(integrationSnap.data());
    const amount=Number(order.total_cents);if(!Number.isSafeInteger(amount) || amount<=0)throw new HttpsError('failed-precondition','O total do pedido é inválido.');
    const reference=crypto.randomBytes(20).toString('hex'),ref=attemptRef(reference),expiresAt=Date.now()+15*60000;
    const email=String(order.payment?.customer_email || order.customer?.email || '').trim();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new HttpsError('failed-precondition','Informe um e-mail válido para o pagamento online.');
    await db.runTransaction(async tx=>{
      const fresh=(await tx.get(orderRef)).data();
      if(!fresh || !['awaiting_confirmation','awaiting_payment'].includes(fresh.status) || Number(fresh.total_cents)!==amount || fresh.payment?.multi_attempt_id || fresh.payment?.status==='paid')throw new HttpsError('failed-precondition','O pedido mudou ou já possui cobrança.');
      tx.set(ref,{reference,kind:'order_multi',organizationId:org,orderId,appointmentId:orderId,amount,email,sellerId:connection.seller_id,expiresAt,active:true,state:'creating',created_at:timestamp()});
      tx.set(orderRef,{payment:{...fresh.payment,multi_attempt_id:reference,status:'pending',expires_at:admin.firestore.Timestamp.fromMillis(expiresAt)},updated_at:timestamp()},{merge:true});
    });
    try{await process(ref);}catch(error){logger.warn('Cobrança do pedido aguarda conciliação',{attemptId:reference,status:error.response?.status || null});}
    const current=(await ref.get()).data() || {};
    return {status:current.state==='payment_review'?'payment_review':current.applied_payment_id?'paid':'pending',sent:current.template_sent===true,needsReview:['creating','review'].includes(current.preference_state)||['sending','uncertain'].includes(current.template_state)};
  }
  async function apply(ref,attempt,payment) {
    const outcome=paymentOutcome(payment,attempt);
    if(attempt.kind==='order_multi') {
      if((attempt.cancel_requested || attempt.cancel_completed) && ['refunded','charged_back'].includes(payment.status))return false;
      if(['refunded','charged_back'].includes(payment.status)){
        await db.runTransaction(async tx=>{const fresh=(await tx.get(ref)).data();if(fresh?.applied_payment_id===String(payment.id)){tx.set(entityRef(attempt),{status:'payment_review',payment_review_reason:'payment_reversed',payment_review_provider_id:String(payment.id),updated_at:timestamp()},{merge:true});tx.set(ref,{state:'payment_review'},{merge:true});}});return false;
      }
      if(outcome!=='paid')return false;
      const approvedAt=Date.parse(String(payment.date_approved || '')),late=Number.isFinite(approvedAt)?approvedAt>attempt.expiresAt:Date.now()>attempt.expiresAt;
      const result=await applyVerifiedOrderPayment({db,admin,attemptRef:ref,orderRef:entityRef(attempt),paymentId:String(payment.id),amountCents:attempt.amount,late});
      if(result.kind==='review')logger.error('Pagamento de pedido exige revisão',{attemptId:attempt.reference,paymentId:String(payment.id),reason:result.reason});
      return result.kind!=='duplicate_event';
    }
    if(['refunded','charged_back'].includes(payment.status))return flagPaymentReversal({db,admin,attemptRef:ref,appointmentRef:root(attempt.organizationId).collection('appointments').doc(attempt.appointmentId),paymentId:String(payment.id),providerStatus:payment.status});
    if(outcome!=='paid') return false;
    const approvedAt=Date.parse(String(payment.date_approved || ''));
    const late=Number.isFinite(approvedAt) ? approvedAt>attempt.expiresAt : Date.now()>attempt.expiresAt;
    const result=await applyVerifiedPayment({db,admin,attemptRef:ref,appointmentRef:root(attempt.organizationId).collection('appointments').doc(attempt.appointmentId),paymentId:String(payment.id),amountCents:attempt.amount,late});
    if(result.kind==='review') logger.error('Pagamento adicional ou tardio exige revisão',{attemptId:attempt.reference,paymentId:String(payment.id),reason:result.reason});
    return result.kind!=='duplicate_event';
  }
  async function acceptWebhook(ref,paymentId) {
    const attempt=(await ref.get()).data();
    if(!['balance_multi','order_multi'].includes(attempt?.kind) || !/^\d+$/.test(String(paymentId)))return;
    const access=await token(attempt.organizationId);
    const payment=(await axios.get(`${apiUrl}/v1/payments/${paymentId}`,{headers:headers(access),timeout:15000})).data;
    await apply(ref,attempt,payment);
    const latest=(await ref.get()).data();
    if(latest?.active) await process(ref);
  }
  async function cancelOrder(org,orderId,reason) {
    const orderRef=root(org).collection('orders').doc(orderId);
    let ref;
    await db.runTransaction(async tx=>{
      const order=(await tx.get(orderRef)).data(),id=String(order?.payment?.multi_attempt_id || '');
      if(!order || !/^[a-f0-9]{40}$/.test(id))throw new HttpsError('failed-precondition','A cobrança deste pedido não está disponível para cancelamento automático.');
      ref=attemptRef(id);const attempt=(await tx.get(ref)).data();
      if(!attempt || attempt.kind!=='order_multi' || attempt.organizationId!==org || attempt.orderId!==orderId)throw new HttpsError('failed-precondition','A cobrança não corresponde ao pedido.');
      if(['completed','cancelled','canceled'].includes(order.status))throw new HttpsError('failed-precondition','Este pedido já foi encerrado.');
      tx.set(ref,{active:true,cancel_requested:true,cancel_completed:false,cancel_reason:reason,counterpart_close_pending:true,updated_at:timestamp()},{merge:true});
      tx.set(orderRef,{status:'cancellation_pending',cancellation_reason:reason,updated_at:timestamp()},{merge:true});
    });
    try{await process(ref);}catch(error){logger.warn('Cancelamento do pedido aguarda conciliação',{attemptId:ref.id});}
    const order=(await orderRef.get()).data();return {status:order?.status || 'cancellation_pending',refundStatus:order?.payment?.status || 'pending'};
  }
  async function closeAlternative(ref,attempt,pix,access) {
    // Provider calls are verified before a charge is released; failures remain retryable.
    if(attempt.preference_id){
      await axios.put(`${apiUrl}/checkout/preferences/${encodeURIComponent(attempt.preference_id)}`,{expires:true,expiration_date_to:new Date(Date.now()-1000).toISOString()},{headers:headers(access),timeout:15000});
      const pref=(await axios.get(`${apiUrl}/checkout/preferences/${encodeURIComponent(attempt.preference_id)}`,{headers:headers(access),timeout:15000})).data;
      if(pref.expires!==true || !Number.isFinite(Date.parse(pref.expiration_date_to)) || Date.parse(pref.expiration_date_to)>Date.now())throw new Error('Encerramento do checkout não confirmado.');
    }
    if(pix && !['approved','cancelled','canceled','rejected','refunded'].includes(pix.status)) {
      try{await axios.put(`${apiUrl}/v1/payments/${pix.id}`,{status:'cancelled'},{headers:headers(access),timeout:15000});}catch(error){if(![400,409].includes(error.response?.status))throw error;}
      pix=(await axios.get(`${apiUrl}/v1/payments/${pix.id}`,{headers:headers(access),timeout:15000})).data;
    }
    if(pix?.status==='approved')await apply(ref,attempt,pix);
    else if(pix && !['cancelled','canceled','rejected','refunded'].includes(pix.status))throw new Error('Cancelamento do Pix não confirmado.');
    await ref.set({counterpart_close_pending:false,closed_at:timestamp(),monitor_until:Date.now()+10*60000},{merge:true});
  }
  async function process(ref) {
    let attempt=(await ref.get()).data();
    if(!attempt?.active || !['balance_multi','order_multi'].includes(attempt.kind))return;
    const lease=crypto.randomUUID();
    const claimed=await db.runTransaction(async tx=>{const fresh=(await tx.get(ref)).data();if(!fresh?.active || Number(fresh.processing_until || 0)>Date.now())return false;tx.set(ref,{processing_until:Date.now()+300000,processing_lease:lease},{merge:true});return true;});
    if(!claimed)return;
    try {
      attempt=(await ref.get()).data();const access=await token(attempt.organizationId),auth=headers(access);
      let pix;
      if(!attempt.paymentId){
        const result=await axios.post(`${apiUrl}/v1/payments`,paymentPayload({...attempt,kind:'balance'},paymentUrl(attempt)),{headers:{...auth,'Content-Type':'application/json','X-Idempotency-Key':attempt.reference},timeout:20000});
        pix=result.data;if(!/^\d+$/.test(String(pix?.id || '')))throw new Error('Pagamento Pix inválido.');
        await ref.set({paymentId:String(pix.id),state:'pending'},{merge:true});
        await db.doc(`mercadopago_payments/${pix.id}`).set({attemptId:ref.id},{merge:true});
      } else pix=(await axios.get(`${apiUrl}/v1/payments/${attempt.paymentId}`,{headers:auth,timeout:15000})).data;
      const pixOutcome=paymentOutcome(pix,attempt);
      await apply(ref,attempt,pix);
      attempt=(await ref.get()).data();
      const search=(await axios.get(`${apiUrl}/v1/payments/search`,{headers:auth,params:{external_reference:attempt.reference,sort:'date_created',criteria:'desc',limit:100},timeout:15000})).data;
      for(const payment of search.results || []) if(['approved','refunded','charged_back'].includes(payment.status))await apply(ref,attempt,payment);
      attempt=(await ref.get()).data();
      if(attempt.closed_at && attempt.counterpart_close_pending === false && !attempt.cancel_requested){if(Date.now()>=Number(attempt.monitor_until || 0))await ref.set({active:false},{merge:true});return;}
      if(attempt.applied_payment_id || attempt.state==='payment_review' || attempt.cancel_requested || pixOutcome==='expired' || Date.now()>=attempt.expiresAt){
        await closeAlternative(ref,attempt,pix,access);
        if(attempt.kind==='order_multi'){
          const orderRef=entityRef(attempt),fresh=(await ref.get()).data();
          if(fresh.cancel_requested){
            const refunded={...(fresh.refunded_payment_ids || {})};
            for(const id of Object.keys(fresh.received_payment_ids || {})){if(refunded[id])continue;const result=await refundCancelledOrderPayment({axios,apiUrl,accessToken:access,paymentId:id,expectedReference:fresh.reference,expectedSellerId:fresh.sellerId,expectedAmountCents:fresh.amount});if(result.status!=='refunded')throw new Error('Estorno aguardando confirmação.');refunded[id]=true;await ref.set({refunded_payment_ids:refunded},{merge:true});}
            await db.runTransaction(async tx=>{
              const latest=(await tx.get(ref)).data(),order=(await tx.get(orderRef)).data();
              if(!latest?.cancel_requested || Object.keys(latest.received_payment_ids || {}).some(id=>!latest.refunded_payment_ids?.[id]))return;
              tx.set(orderRef,{status:'cancelled',cancellation_reason:latest.cancel_reason || 'Cancelado pelo estabelecimento',payment:{...order.payment,status:Object.keys(latest.refunded_payment_ids || {}).length?'refunded':'cancelled'},updated_at:timestamp()},{merge:true});
              tx.set(ref,{cancel_completed:true,cancel_requested:false},{merge:true});
            });
          } else if(!fresh.applied_payment_id && fresh.state!=='payment_review') {
            await db.runTransaction(async tx=>{
              const latest=(await tx.get(ref)).data(),order=(await tx.get(orderRef)).data();
              if(!latest || !order || latest.applied_payment_id || latest.state==='payment_review' || latest.cancel_requested || order.payment?.status==='paid')return;
              tx.set(orderRef,{status:'cancelled',cancellation_reason:'payment_expired',payment:{...order.payment,status:'expired'},updated_at:timestamp()},{merge:true});
              tx.set(ref,{cancel_completed:true,cancel_reason:'payment_expired'},{merge:true});
            });
          }
          return;
        }
        if(!attempt.applied_payment_id && attempt.state!=='payment_review'){
          const appointmentRef=root(attempt.organizationId).collection('appointments').doc(attempt.appointmentId);
          await db.runTransaction(async tx=>{const [fresh,a]=await Promise.all([tx.get(ref),tx.get(appointmentRef)]);if(!fresh.data()?.applied_payment_id && a.data()?.balance_payment_attempt_id===attempt.reference && a.data()?.payment_status==='pending')tx.set(appointmentRef,{payment_status:attempt.previousPaymentStatus || 'onsite',updated_at:timestamp()},{merge:true});});
        }
        return;
      }
      if(!attempt.preference_id){
        if(attempt.preference_state)throw new Error('Criação do checkout precisa de revisão.');
        await ref.set({preference_state:'creating'},{merge:true});
        try {
          const appointment=(await entityRef(attempt).get()).data();
          const payload={items:[{id:attempt.reference,title:String(attempt.kind==='order_multi'?`Pedido ${appointment?.number || attempt.orderId}`:appointment?.service || 'Atendimento').slice(0,160),quantity:1,currency_id:'BRL',unit_price:attempt.amount/100}],payer:{email:attempt.email},external_reference:attempt.reference,notification_url:paymentUrl(attempt),binary_mode:true,expires:true,expiration_date_from:new Date().toISOString(),expiration_date_to:new Date(attempt.expiresAt).toISOString(),payment_methods:{excluded_payment_types:[{id:'ticket'},{id:'atm'},{id:'bank_transfer'}],installments:1}};
          const result=await axios.post(`${apiUrl}/checkout/preferences`,payload,{headers:{...auth,'Content-Type':'application/json','X-Idempotency-Key':`visit-${attempt.reference}`},timeout:20000});
          const pref=result.data,url=new URL(String(pref.init_point || ''));if(!pref.id || url.protocol!=='https:' || url.hostname!=='www.mercadopago.com.br')throw new Error('Checkout inválido.');
          await ref.set({preference_id:String(pref.id),checkout_url:url.toString(),preference_state:'ready'},{merge:true});
        }catch(error){await ref.set({preference_state:'review'},{merge:true});throw error;}
      }
      attempt=(await ref.get()).data();
      if(attempt.template_sent || attempt.template_state) return;
      const transactionData=pix.point_of_interaction?.transaction_data || {};
      if(!transactionData.qr_code)throw new Error('O Mercado Pago ainda não forneceu o código Pix.');
      const [appointmentSnap,orgSnap]=await Promise.all([entityRef(attempt).get(),root(attempt.organizationId).get()]);
      const appointment=appointmentSnap.data(),organization=orgSnap.data();
      const outbound=buildAppointmentPaymentTemplate({customerName:appointment.customer_name || 'Cliente',serviceName:attempt.kind==='order_multi'?`Pedido ${appointment.number || attempt.orderId}`:appointment.service || 'Atendimento',merchantName:organization?.nome || 'Empresa',amountCents:attempt.amount,reference:attempt.reference,pixCode:transactionData.qr_code,checkoutUrl:attempt.checkout_url});
      const maySend=await db.runTransaction(async tx=>{const current=(await tx.get(ref)).data();if(!current?.active || current.cancel_requested || current.cancel_completed || current.applied_payment_id || current.state==='payment_review' || current.template_state)return false;tx.set(ref,{template_state:'sending'},{merge:true});return true;});
      if(!maySend)return;
      try{await notify(attempt,appointment,outbound);await ref.set({template_sent:true,template_state:'sent',pix_sent:true},{merge:true});if(attempt.kind==='order_multi')await entityRef(attempt).set({payment:{auto_charge_status:'sent'}},{merge:true});}
      catch(error){await ref.set({template_state:'uncertain'},{merge:true});if(attempt.kind==='order_multi')await entityRef(attempt).set({payment:{auto_charge_status:'failed',auto_charge_error:'Confira o envio da cobrança no WhatsApp.'}},{merge:true});throw error;}
      if(transactionData.qr_code_base64){
        try{const tokenValue=crypto.randomUUID(),path=`payment-qr/appointments/${attempt.organizationId}/${attempt.reference}.png`,bucket=admin.storage().bucket();await bucket.file(path).save(Buffer.from(String(transactionData.qr_code_base64),'base64'),{resumable:false,contentType:'image/png',metadata:{cacheControl:'private,max-age=1800',metadata:{firebaseStorageDownloadTokens:tokenValue}}});const url=`https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${tokenValue}`;await notify({...attempt,reference:`${attempt.reference}_qr`},appointment,{type:'image',image:{link:url,caption:`QR Code Pix · ${(attempt.amount/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}`}});await ref.set({qr_sent:true},{merge:true});}catch(error){logger.warn('QR Code não enviado; código Pix segue disponível no modelo',{attemptId:attempt.reference});}
      }
    } finally {await db.runTransaction(async tx=>{const fresh=(await tx.get(ref)).data();if(fresh?.processing_lease===lease)tx.set(ref,{processing_until:0,processing_lease:null},{merge:true});});}
  }
  return {create,createOrder,cancelOrder,process,acceptWebhook};
}
module.exports={createMultiPayment};
