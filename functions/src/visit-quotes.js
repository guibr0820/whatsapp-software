const crypto = require('node:crypto');

function normalizeQuote(input, HttpsError) {
  const service = String(input?.service || '').trim();
  if (!service || service.length > 300 || /[\u0000-\u001f\u007f]/.test(service)) throw new HttpsError('invalid-argument', 'Informe o serviço com até 300 caracteres.');
  const value = (key, label) => {
    const cents = input?.[key];
    if (!Number.isSafeInteger(cents) || cents < 0 || cents > 100000000) throw new HttpsError('invalid-argument', `${label} inválido.`);
    return cents;
  };
  const laborCents = value('laborCents', 'Valor da mão de obra');
  const materialsCents = value('materialsCents', 'Valor dos materiais');
  const notes = String(input?.notes || '').trim();
  if (notes.length > 500) throw new HttpsError('invalid-argument', 'Use até 500 caracteres nas observações.');
  return { service, laborCents, materialsCents, totalCents: laborCents + materialsCents, notes };
}

function quoteText(quote) {
  const money = cents => new Intl.NumberFormat('pt-BR', {style:'currency',currency:'BRL'}).format(cents / 100);
  return `Conforme conversamos, segue o orçamento:\n\nServiço: ${quote.service}\nMão de obra: ${money(quote.laborCents)}\nMateriais: ${money(quote.materialsCents)}\nTotal: ${money(quote.totalCents)}${quote.notes ? `\nObservações: ${quote.notes}` : ''}\n\nVocê confirma este orçamento?`;
}

async function saveDraft({ db, admin, org, appointmentId, conversationId, input, actor, HttpsError }) {
  const quote = normalizeQuote(input, HttpsError);
  const ref = db.doc(`organizations/${org}/${conversationId ? 'conversations' : 'appointments'}/${conversationId || appointmentId}`);
  await db.runTransaction(async tx => {
    const appointment = (await tx.get(ref)).data();
    if (conversationId ? !appointment || appointment.is_demo : !appointment?.home_visit || ['cancelled','canceled','no_show'].includes(appointment.status)) throw new HttpsError('failed-precondition', 'Atendimento inválido para orçamento.');
    if (appointment.execution_mode || appointment.execution_appointment_id || appointment.source_visit_id) throw new HttpsError('failed-precondition', 'O orçamento está vinculado à execução e não pode ser alterado.');
    if (appointment.quote_current?.status === 'sending') throw new HttpsError('failed-precondition', 'Aguarde o envio em andamento.');
    tx.set(ref, {quote_draft:{...quote,updated_by:actor,updated_at:admin.firestore.FieldValue.serverTimestamp()},updated_at:admin.firestore.FieldValue.serverTimestamp()}, {merge:true});
  });
  return quote;
}

async function sendQuote({ db, admin, axios, org, appointmentId, conversationId, expectedQuote, actor, HttpsError, saveOutbound }) {
  const reviewed = normalizeQuote(expectedQuote, HttpsError);
  const ref = db.doc(`organizations/${org}/${conversationId ? 'conversations' : 'appointments'}/${conversationId || appointmentId}`);
  const integration = (await db.doc(`organizations/${org}/integrations/whatsapp`).get()).data();
  if (!integration?.active || !integration.access_token || !integration.phone_number_id) throw new HttpsError('failed-precondition', 'Conecte o WhatsApp antes de enviar o orçamento.');
  const token = crypto.randomBytes(16).toString('hex');
  const versionRef = ref.collection('quote_versions').doc(token);
  const lookupRef = db.doc(`visit_quote_replies/${token}`);
  let quote, appointment;
  await db.runTransaction(async tx => {
    appointment = (await tx.get(ref)).data();
    if (conversationId ? !appointment || appointment.is_demo : !appointment?.home_visit || ['cancelled','canceled','no_show'].includes(appointment.status)) throw new HttpsError('failed-precondition', 'Atendimento inválido para orçamento.');
    if (conversationId) appointment = {...appointment,conversation_id:conversationId,customer_phone:String(appointment.contact_phone || '').replace(/\D/g,'')};
    if (appointment.execution_mode || appointment.execution_appointment_id || appointment.source_visit_id) throw new HttpsError('failed-precondition', 'O orçamento está vinculado à execução e não pode ser alterado.');
    if (['sending','send_uncertain'].includes(appointment.quote_current?.status)) throw new HttpsError('failed-precondition', 'Há um envio em andamento ou que precisa ser conferido na conversa.');
    if (!appointment.conversation_id || !/^\d{8,20}$/.test(String(appointment.customer_phone || ''))) throw new HttpsError('failed-precondition', 'Esta visita não possui uma conversa válida no WhatsApp.');
    quote = normalizeQuote(appointment.quote_draft, HttpsError);
    if (quote.service !== reviewed.service || quote.laborCents !== reviewed.laborCents || quote.materialsCents !== reviewed.materialsCents || quote.notes !== reviewed.notes) throw new HttpsError('failed-precondition', 'O rascunho mudou. Atualize e revise o orçamento antes de enviar.');
    const previous = appointment.quote_current;
    if (previous && ['sent','approved'].includes(previous.status) && previous.service === quote.service && previous.laborCents === quote.laborCents && previous.materialsCents === quote.materialsCents && (previous.notes || '') === quote.notes) throw new HttpsError('failed-precondition', 'Este orçamento já foi enviado. Aguarde a resposta do cliente.');
    const now = admin.firestore.FieldValue.serverTimestamp();
    tx.set(versionRef, {...quote,status:'sending',created_at:now,created_by:actor});
    tx.set(lookupRef, {organization_id:org,...(conversationId ? {source:'conversation'} : {appointment_id:appointmentId}),conversation_id:appointment.conversation_id,phone:appointment.customer_phone,status:'sending',created_at:now});
    tx.set(ref, {quote_current:{...quote,id:token,status:'sending'},updated_at:now}, {merge:true});
  });
  const body = quoteText(quote);
  let providerId = '';
  try {
    const response = await axios.post(`https://graph.facebook.com/${String(integration.graph_version || 'v24.0')}/${integration.phone_number_id}/messages`, {
      messaging_product:'whatsapp', to:appointment.customer_phone, type:'interactive', interactive:{type:'button',body:{text:body},action:{buttons:[
        {type:'reply',reply:{id:`quote_${token}_yes`,title:conversationId ? 'Aprovar' : 'Sim, confirmo'}},
        {type:'reply',reply:{id:`quote_${token}_no`,title:conversationId ? 'Não aprovar' : 'Não, conversar'}},
      ]}},
    }, {headers:{Authorization:`Bearer ${integration.access_token}`},timeout:15000});
    providerId = String(response.data?.messages?.[0]?.id || '');
    if (!providerId) throw new Error('A Meta não confirmou o envio.');
    await db.runTransaction(async tx => {
      const current = (await tx.get(ref)).data();
      const now = admin.firestore.FieldValue.serverTimestamp();
      tx.set(versionRef, {status:'sent',provider_message_id:providerId,sent_at:now}, {merge:true});
      tx.set(lookupRef, {status:'sent',provider_message_id:providerId,sent_at:now}, {merge:true});
      if (current?.quote_current?.id === token) tx.set(ref, {quote_current:{...quote,id:token,status:'sent',providerMessageId:providerId},updated_at:now}, {merge:true});
    });
    try { await saveOutbound({admin,db,organizationId:org,conversationId:appointment.conversation_id,providerMessageId:providerId,type:'interactive',text:body,createdBy:actor}); } catch { /* O envio já ocorreu; não reenviar por falha no histórico. */ }
    return {sent:true,versionId:token};
  } catch (error) {
    // Uma falha após chamar a Meta pode esconder um envio realizado. Não repetir automaticamente.
    const rejected = !providerId && Number(error.response?.status) >= 400 && Number(error.response?.status) < 500 && Number(error.response?.status) !== 408;
    const failedStatus = rejected ? 'send_failed' : 'send_uncertain';
    await db.runTransaction(async tx => {
      const current = (await tx.get(ref)).data();
      if (current?.quote_current?.id !== token || current.quote_current.status !== 'sending') return;
      tx.set(versionRef, {status:failedStatus}, {merge:true});
      tx.set(lookupRef, {status:failedStatus,...(providerId ? {provider_message_id:providerId} : {})}, {merge:true});
      tx.set(ref, {quote_current:{...quote,id:token,status:failedStatus},updated_at:admin.firestore.FieldValue.serverTimestamp()}, {merge:true});
    });
    throw new HttpsError('unavailable', rejected ? 'A Meta recusou o envio. Confira a janela de atendimento e tente novamente.' : 'Não foi possível confirmar o envio. Confira a conversa antes de tentar novamente.');
  }
}

async function recordQuoteResponse({db,admin,organizationId,conversationId,phone,message,providerMessageId}) {
  const action = String(message?.interactive?.button_reply?.id || '');
  const match = /^quote_([a-f0-9]{32})_(yes|no)$/.exec(action);
  if (!match) return false;
  const token = match[1], lookupRef = db.doc(`visit_quote_replies/${token}`);
  await db.runTransaction(async tx => {
    const lookup = (await tx.get(lookupRef)).data();
    if (!lookup || lookup.organization_id !== organizationId || lookup.conversation_id !== conversationId || lookup.phone !== phone) return;
    if (lookup.status === 'sending') throw new Error('Aguardando confirmação do envio do orçamento.');
    if (!lookup.provider_message_id || lookup.provider_message_id !== message?.context?.id || !['sent','send_uncertain'].includes(lookup.status)) return;
    const appointmentRef = lookup.source === 'conversation' ? db.doc(`organizations/${organizationId}/conversations/${conversationId}`) : db.doc(`organizations/${organizationId}/appointments/${lookup.appointment_id}`);
    const versionRef = appointmentRef.collection('quote_versions').doc(token);
    const [appointmentSnapshot, versionSnapshot] = await Promise.all([tx.get(appointmentRef),tx.get(versionRef)]);
    const appointment = appointmentSnapshot.data(), version = versionSnapshot.data();
    if (!appointment || !version || ['cancelled','canceled','no_show'].includes(appointment.status) || appointment.quote_current?.id !== token || !['sent','send_uncertain'].includes(appointment.quote_current.status)) return;
    const status = match[2] === 'yes' ? 'approved' : 'discussion';
    const now = admin.firestore.FieldValue.serverTimestamp();
    tx.set(versionRef,{status,response_message_id:providerMessageId,responded_at:now},{merge:true});
    tx.set(lookupRef,{status,response_message_id:providerMessageId,responded_at:now},{merge:true});
    tx.set(appointmentRef,{quote_current:{...appointment.quote_current,status},updated_at:now},{merge:true});
    if (status === 'discussion' || lookup.source === 'conversation') tx.set(db.doc(`organizations/${organizationId}/conversations/${conversationId}`),{human_support:true,status:'waiting',team_attention_id:providerMessageId,updated_at:now},{merge:true});
  });
  return true;
}

module.exports = { normalizeQuote, quoteText, saveDraft, sendQuote, recordQuoteResponse };
