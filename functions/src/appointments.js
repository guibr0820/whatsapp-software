const crypto = require('node:crypto');
const { availableSlots } = require('./booking-flow');
const { customerId, normalizePhone } = require('./customers');
const { appointmentChangePolicy } = require('./payment-policy');
const { nextPetAction, sendPetStatusNotification } = require('./pet-lifecycle');
const { saveDraft, sendQuote } = require('./visit-quotes');
const { entitlements, monthKey, evaluateMonthlyConsumption } = require('./plan-limits');
const dayKey = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
function normalizeDate(value) {
  const text = String(value || '');
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  const result = match ? `${match[3]}-${match[2]}-${match[1]}` : text;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || new Date(`${result}T12:00:00Z`).toISOString().slice(0,10) !== result) throw new Error('Data inválida.');
  return result;
}
const minute = value => Number(value.slice(0,2)) * 60 + Number(value.slice(3));
function visitNoticeKeys(status) {
  return status === 'completed' ? ['completed','record_payment','balance_reminder'] : ['visit_departed','visit_started'].includes(status) ? ['visit_departed','record_payment'] : ['record_payment'];
}
function createAppointmentFunctions({ db, admin, axios, onCall, onSchedule, HttpsError, taskQueue, lifecycleTaskQueue, payments, logger }) {
  const root = org => db.doc(`organizations/${org}`);
  async function sendVisitNotice(org,id,body,key) {
    const ref=root(org).collection('appointments').doc(id), appointment=(await ref.get()).data();
    if (!appointment?.home_visit || appointment.visit_notices?.[key]?.status === 'sent') return false;
    const integration=(await root(org).collection('integrations').doc('whatsapp').get()).data();
    if (!integration?.active || !appointment.customer_phone) return false;
    const response=await axios.post(`https://graph.facebook.com/${integration.graph_version || 'v24.0'}/${integration.phone_number_id}/messages`,{messaging_product:'whatsapp',to:appointment.customer_phone,type:'text',text:{body}},{headers:{Authorization:`Bearer ${integration.access_token}`},timeout:15000});
    const providerMessageId=String(response.data?.messages?.[0]?.id||'');
    if (!providerMessageId) throw new Error('O WhatsApp não confirmou o envio.');
    await ref.set({visit_notices:{...appointment.visit_notices,[key]:{status:'sent',provider_message_id:providerMessageId,sent_at:admin.firestore.FieldValue.serverTimestamp()}},updated_at:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    if (appointment.conversation_id) {
      const {saveOutboundProviderMessage}=require('./meta-whatsapp');
      await saveOutboundProviderMessage({admin,db,organizationId:org,conversationId:appointment.conversation_id,providerMessageId,type:'text',text:body,createdBy:'visit_automation'});
    }
    return true;
  }
  const visitNoticeBody = (a,key) => {
    const remaining=Math.max(0,Math.round(Number(a.total_price||0)*100)-Number(a.paid_cents||0));
    const amount=`R$ ${(remaining/100).toFixed(2).replace('.',',')}`;
    if(key==='visit_departed') return `O profissional ${a.professional} está a caminho do endereço informado.`;
    if(key==='record_payment') return `Pagamento do atendimento de ${a.service} recebido. Obrigado!`;
    if(key==='completed') return a.payment_status==='payment_review' ? `O atendimento de ${a.service} foi concluído. Nossa equipe vai conferir o pagamento.` : remaining ? `O atendimento de ${a.service} foi concluído. Saldo pendente: ${amount}. A equipe pode enviar o Pix nesta conversa.` : `O atendimento de ${a.service} foi concluído. Pagamento confirmado. Obrigado!`;
    return `Olá, ${a.customer_name||'cliente'}! O saldo de ${amount} do atendimento de ${a.service} ainda está pendente. Responda a esta mensagem para solicitar o Pix.`;
  };
  const processVisitReminders = onSchedule?.({region:'southamerica-east1',schedule:'every 1 hours',timeZone:'America/Sao_Paulo',maxInstances:1},async()=>{
    const now=Date.now();
    for(const status of ['confirmed','visit_departed','visit_started','completed']) {
      let cursor, page;
      do {
        let query=db.collectionGroup('appointments').where('status','==',status).orderBy(admin.firestore.FieldPath.documentId()).limit(500);
        if(cursor) query=query.startAfter(cursor);
        page=await query.get();
        cursor=page.docs.at(-1);
        for(const doc of page.docs) {
        const a=doc.data(),org=doc.ref.parent.parent?.id;
        if(!org||!a.home_visit) continue;
        const keys=visitNoticeKeys(status);
        for(const key of keys) {
          if(a.visit_notices?.[key]?.status==='sent') continue;
          if(key==='record_payment' && a.payment_method!=='manual') continue;
          const eventAt=(key==='visit_departed'?a.visit_departed_at:key==='visit_started'?a.visit_started_at:key==='record_payment'?a.payment_updated_at:a.completed_at)?.toMillis?.()||0;
          if(!eventAt||now-eventAt>24*60*60000) continue;
          if(key==='balance_reminder') {
            if(a.payment_status==='payment_review'||now-eventAt<60*60000||Math.round(Number(a.total_price||0)*100)<=Number(a.paid_cents||0)) continue;
          }
          try { await sendVisitNotice(org,doc.id,visitNoticeBody(a,key),key); }
          catch(error) { logger?.warn?.('Aviso de visita aguardando nova tentativa',{organizationId:org,appointmentId:doc.id,key}); }
        }
        }
      } while(cursor && page.docs.length===500);
    }
  });
  async function authorize(request, owner = false) {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Entre na sua conta.');
    const org = String(request.data?.organizationId || '');
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(org)) throw new HttpsError('invalid-argument', 'Empresa inválida.');
    const [company, member] = await Promise.all([root(org).get(), root(org).collection('members').doc(request.auth.uid).get()]);
    if (!company.exists || company.data()?.status === 'suspended' || member.data()?.status !== 'active' || (owner && company.data().proprietario_uid !== request.auth.uid)) throw new HttpsError('permission-denied', company.data()?.status === 'suspended' ? 'Esta empresa está suspensa. Fale com o suporte.' : 'Você não tem permissão para esta operação.');
    return org;
  }
  const date = value => { try { return normalizeDate(value); } catch { throw new HttpsError('invalid-argument', 'Data inválida.'); } };
  async function readDay(org, key, reader) {
    const dates = [key, key.split('-').reverse().join('/')];
    const snaps = await Promise.all(dates.map(value => {
      const query = root(org).collection('appointments').where('appointment_date', '==', value);
      return reader ? reader.get(query) : query.get();
    }));
    return snaps.flatMap(s => s.docs).map(d => ({ ...d.data(), id: d.id }));
  }
  const publicItem = a => ({ id: a.id, customerName: a.customer_name || 'Cliente', phone: a.customer_phone || '', conversationId: a.conversation_id || '', service: a.service || 'Atendimento', optional: a.optional || '', petName:a.pet_name || '', petSex:a.pet_sex || 'unknown', petSize:a.pet_size || '', transport:a.transport || '', transportId:a.transport_id || 'none', petMessageStatuses:a.pet_message_statuses || {}, professional: a.professional || 'Não informado', professionalId: a.professional_id || '', date: normalizeDate(a.appointment_date), time: a.appointment_time || '', duration: Number(a.duration_minutes) || 30, price: a.total_price ?? null, status: a.status || 'confirmed', reminderStatus: a.reminder_status || 'pending', paymentStatus: a.payment_status || 'onsite', paymentReviewReason: String(a.payment_review_reason || ''), paymentReviewExtra: Number(a.payment_review_extra_cents || 0)/100, paymentReviewProviderId: String(a.payment_review_provider_id || ''), refundStatus: a.refund_status || '', refundError: a.refund_error || '', refundAttempts:Number(a.refund_attempts || 0), refundProviderId:String(a.refund_provider_id || ''), deposit: (a.deposit_cents || 0) / 100, paid: (a.paid_cents || 0) / 100, refunded: (a.refunded_cents || 0) / 100, retained: (a.deposit_retained_cents || 0) / 100, balance: (a.remaining_cents ?? Math.round(Number(a.total_price || 0) * 100)) / 100, rescheduleCount:Number(a.reschedule_count || 0), changePolicy:a.change_policy || null, paymentExpiresAt: a.payment_expires_at?.toMillis() || null });
  const listAppointments = onCall({ region: 'southamerica-east1' }, async request => {
    const org = await authorize(request);
    const key = date(request.data?.date || dayKey());
    const [items, todayItems, people] = await Promise.all([readDay(org,key), key === dayKey() ? Promise.resolve(null) : readDay(org,dayKey()), root(org).collection('professionals').get()]);
    const current = todayItems || items;
    const withProgress = a => ({...publicItem(a),homeVisit:a.home_visit === true,problemDescription:a.problem_description || '',transportAddress:a.transport_address || '',transportReference:a.transport_reference || '',transportInstructions:a.transport_instructions || '',quoteDraft:a.quote_draft || null,quoteCurrent:a.quote_current || null,executionMode:a.execution_mode || '',executionAppointmentId:a.execution_appointment_id || '',sourceVisitId:a.source_visit_id || '',petTimeline:Object.fromEntries(['pet_pickup_started','pet_collected','pet_received','pet_in_service','pet_ready','pet_out_for_delivery','completed'].map(status=>[status,a[`${status}_at`]?.toMillis?.() || null]))});
    return { date: key, appointments: items.map(withProgress).sort((a,b) => a.time.localeCompare(b.time)), todayAppointments: current.map(withProgress).sort((a,b) => a.time.localeCompare(b.time)), professionals: people.docs.map(p => ({ id: p.id, name: p.data().name, active: p.data().active !== false })), canManage: (await root(org).get()).data().proprietario_uid === request.auth.uid };
  });
  async function personFor(org, a, reader) {
    if (a.professional_id && /^[a-zA-Z0-9_-]{1,128}$/.test(a.professional_id)) {
      const ref = root(org).collection('professionals').doc(a.professional_id);
      const snap = reader ? await reader.get(ref) : await ref.get();
      if (snap.exists) return { ...snap.data(), id: snap.id };
    }
    const q = root(org).collection('professionals').where('name','==',a.professional).limit(2);
    const snap = reader ? await reader.get(q) : await q.get();
    if (snap.docs.length !== 1) throw new HttpsError('failed-precondition', 'Associe um profissional válido antes de remarcar.');
    return { ...snap.docs[0].data(), id: snap.docs[0].id };
  }
  const blocks = (items, person, exclude) => items.filter(a => a.id !== exclude && !['cancelled','canceled','rejected','payment_expired'].includes(a.status) && (a.professional_id === person.id || a.professional === person.name)).map(a => ({ start: minute(a.appointment_time), end: minute(a.appointment_time) + (Number(a.duration_minutes) || 30) }));
  const approvedQuoteReady = a => { const q=a?.quote_current,d=a?.quote_draft; return q?.status === 'approved' && (!d || (d.service === q.service && d.laborCents === q.laborCents && d.materialsCents === q.materialsCents)); };
  const getAppointmentSlots = onCall({ region: 'southamerica-east1' }, async request => {
    const org = await authorize(request, true), key = date(request.data?.date);
    const id = String(request.data?.appointmentId || '');
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new HttpsError('invalid-argument', 'Agendamento inválido.');
    const a = (await root(org).collection('appointments').doc(id).get()).data();
    const execution = request.data?.purpose === 'execution';
    if (execution ? (!a?.home_visit || !approvedQuoteReady(a) || a.execution_mode || a.execution_appointment_id || a.source_visit_id || ['cancelled','canceled','no_show'].includes(a.status)) : (!a || a.status !== 'confirmed')) throw new HttpsError('failed-precondition', execution ? 'A execução exige um orçamento aprovado ainda não utilizado e sem alterações pendentes.' : 'Somente agendamentos confirmados podem ser remarcados.');
    const person = await personFor(org,a);
    const duration = execution ? Number(request.data?.duration) : Number(a.duration_minutes) || 30;
    if (!Number.isInteger(duration) || duration < 5 || duration > 1440) throw new HttpsError('invalid-argument','Informe uma duração entre 5 e 1440 minutos.');
    return { times: availableSlots(person,key,duration,blocks(await readDay(org,key),person,execution ? '' : id)) };
  });
  const updateAppointment = onCall({ region: 'southamerica-east1', invoker:'public', ...(payments?.oauthSecrets?.length ? {secrets:payments.oauthSecrets} : {}) }, async request => {
    const org = await authorize(request,true), id = String(request.data?.appointmentId || ''), action = request.data?.action;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !['execution_now','schedule_execution','save_quote','send_quote','charge','record_payment','visit_departed','visit_started','complete','no_show','cancel','reschedule','retry_refund','pet_pickup_started','pet_collected','pet_received','pet_in_service','pet_ready','pet_out_for_delivery','save_transport'].includes(action)) throw new HttpsError('invalid-argument','Operação inválida.');
    const ref = root(org).collection('appointments').doc(id);
    if (action === 'save_quote') return {saved:true,quote:await saveDraft({db,admin,org,appointmentId:id,input:request.data?.quote,actor:request.auth.uid,HttpsError})};
    if (action === 'send_quote') return sendQuote({db,admin,axios,org,appointmentId:id,expectedQuote:request.data?.quote,actor:request.auth.uid,HttpsError,saveOutbound:require('./meta-whatsapp').saveOutboundProviderMessage});
    if (action === 'execution_now' || action === 'schedule_execution') {
      const executionId = crypto.randomUUID(), childRef = root(org).collection('appointments').doc(executionId), reminderRevision = crypto.randomUUID();
      const expectedQuoteId = String(request.data?.quoteId || '');
      const access = action === 'schedule_execution' ? await entitlements(db,org) : null;
      const usageRef = root(org).collection('usage').doc(monthKey()), creditsRef = root(org).collection('capacity').doc('credits');
      let scheduledFor = null, executionService = '';
      await db.runTransaction(async tx => {
        const a = (await tx.get(ref)).data(), quote = a?.quote_current;
        if (!a?.home_visit || !approvedQuoteReady(a) || quote.id !== expectedQuoteId || a.execution_mode || a.execution_appointment_id || a.source_visit_id || ['cancelled','canceled','no_show'].includes(a.status)) throw new HttpsError('failed-precondition','O orçamento não está aprovado, tem alterações pendentes ou já foi usado para execução.');
        if (!Number.isSafeInteger(quote.totalCents) || quote.totalCents < 0) throw new HttpsError('failed-precondition','O valor do orçamento é inválido.');
        if (Number(a.total_price || 0) !== 0 || Number(a.paid_cents || 0) !== 0 || a.payment_status === 'pending') throw new HttpsError('failed-precondition','Esta visita possui cobrança ou pagamento próprio. Resolva-o antes de registrar a execução.');
        const now = admin.firestore.FieldValue.serverTimestamp(); executionService = quote.service;
        if (action === 'execution_now') {
          if (a.status !== 'visit_started') throw new HttpsError('failed-precondition','Inicie a visita antes de registrar a execução no local.');
          tx.set(ref,{execution_mode:'same_visit',execution_started_at:now,visit_service:a.service,service:quote.service,total_price:quote.totalCents/100,remaining_cents:quote.totalCents,payment_status:'onsite',updated_at:now,updated_by:request.auth.uid},{merge:true});
          return;
        }
        const key = date(request.data?.date), time = String(request.data?.time || ''), duration = Number(request.data?.duration);
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || !Number.isInteger(duration) || duration < 5 || duration > 1440) throw new HttpsError('invalid-argument','Informe horário e duração válidos.');
        const person = await personFor(org,a,tx), lockRef = root(org).collection('booking_days').doc(`${person.id}_${key}`);
        const lock = (await tx.get(lockRef)).data() || {}, held = {...(lock.reservations || {})};
        const busy = [...blocks(await readDay(org,key,tx),person,''), ...Object.values(held)];
        if (!availableSlots(person,key,duration,busy).includes(time)) throw new HttpsError('failed-precondition','Esse horário não está disponível. Escolha outro.');
        const [usage,credits] = await Promise.all([tx.get(usageRef),tx.get(creditsRef)]);
        const consumption=evaluateMonthlyConsumption({usageData:usage.data(),creditsData:credits.data(),metric:'appointments',limit:access.limits.appointmentsPerMonth,reference:executionId});
        if (!consumption.allowed) throw new HttpsError('resource-exhausted','O limite mensal de agendamentos foi atingido.');
        scheduledFor = admin.firestore.Timestamp.fromDate(new Date(`${key}T${time}:00-03:00`));
        held[executionId] = {start:minute(time),end:minute(time)+duration};
        if(!consumption.duplicate){tx.set(usageRef,{month:monthKey(),appointments:consumption.current+1,appointments_references:{...consumption.references,[executionId]:true},...(consumption.usesCredit?{appointments_credits_used:admin.firestore.FieldValue.increment(1)}:{}),updated_at:now},{merge:true});if(consumption.usesCredit)tx.set(creditsRef,{appointments:consumption.creditBalance-1,updated_at:now},{merge:true});}
        tx.set(lockRef,{reservations:held,updated_at:now},{merge:true});
        tx.set(childRef,{home_visit:true,source_visit_id:id,execution_mode:'scheduled',quote_current:quote,customer_name:a.customer_name || 'Cliente',customer_phone:a.customer_phone,customer_email:a.customer_email || '',conversation_id:a.conversation_id || '',professional_id:person.id,professional:person.name,service:quote.service,appointment_date:key,appointment_time:time,duration_minutes:duration,scheduled_for:scheduledFor,status:'confirmed',total_price:quote.totalCents/100,paid_cents:0,remaining_cents:quote.totalCents,payment_status:'onsite',reminder_revision:reminderRevision,reminder_status:'pending',transport_address:a.transport_address || '',transport_reference:a.transport_reference || '',transport_instructions:a.transport_instructions || '',problem_description:a.problem_description || '',created_at:now,updated_at:now,created_by:request.auth.uid});
        tx.set(ref,{execution_mode:'return',execution_appointment_id:executionId,updated_at:now,updated_by:request.auth.uid},{merge:true});
      });
      let notificationSent = false, reminderQueued = true;
      if (action === 'schedule_execution') {
        const display = String(request.data.date).split('-').reverse().join('/');
        try { notificationSent = await sendVisitNotice(org,executionId,`Serviço agendado: ${executionService}. Data: ${display} às ${request.data.time}. Nossa equipe vai até o endereço combinado.`,'execution_scheduled'); }
        catch (error) { logger?.warn?.('Não foi possível avisar sobre a execução agendada',{organizationId:org,appointmentId:executionId}); }
        if (taskQueue) try {
          const config=(await root(org).collection('automation_configs').doc('appointment_reminder').get()).data();
          if(config?.active) {
            const schedules=config.trigger==='before_appointment' ? (Array.isArray(config.schedules) && config.schedules.length ? config.schedules : [Number(config.lead_time_minutes)||1440]) : [0];
            for(const lead of schedules){const reminderKey=lead?`before_${lead}`:'after_confirmation';const delay=lead?Math.max(0,Math.floor((scheduledFor.toMillis()-Date.now())/1000)-Number(lead)*60):Number(config.delay_seconds)||30;try{await taskQueue.enqueue({organizationId:org,appointmentId:executionId,revision:reminderRevision,reminderKey},{id:`execution-${executionId}-${reminderRevision}-${reminderKey}`,scheduleDelaySeconds:delay});}catch{reminderQueued=false;await childRef.set({reminder_status:'failed',reminder_error:'Não foi possível programar todos os lembretes.'},{merge:true});}}
          }
        } catch (error) { reminderQueued=false; logger?.warn?.('Falha ao programar lembrete da execução',{organizationId:org,appointmentId:executionId}); }
      }
      return {saved:true,executionAppointmentId:action === 'schedule_execution' ? executionId : id,notificationSent,reminderQueued};
    }
    if (['visit_departed','visit_started','record_payment'].includes(action)) {
      let notification = null;
      await db.runTransaction(async tx => {
        const a = (await tx.get(ref)).data();
        if (!a?.home_visit) throw new HttpsError('failed-precondition','Esta ação exige uma visita domiciliar.');
        if (action === 'record_payment') {
          if (!['confirmed','visit_departed','visit_started','completed'].includes(a.status) || ['pending','payment_review'].includes(a.payment_status)) throw new HttpsError('failed-precondition','Este pagamento não pode ser registrado agora.');
          const total = Math.round(Number(a.total_price || 0)*100), received = Number(a.paid_cents || 0), remaining = total-received;
          if (remaining <= 0) throw new HttpsError('failed-precondition','O atendimento já está pago.');
          tx.set(ref,{paid_cents:total,remaining_cents:0,payment_status:'paid',payment_method:'manual',payment_updated_at:admin.firestore.FieldValue.serverTimestamp(),updated_at:admin.firestore.FieldValue.serverTimestamp(),updated_by:request.auth.uid},{merge:true});
          notification = {appointment:a,body:`Pagamento de R$ ${(remaining/100).toFixed(2).replace('.',',')} recebido. Obrigado!`};
        } else {
          const previous = action === 'visit_departed' ? 'confirmed' : 'visit_departed';
          if (a.status !== previous) throw new HttpsError('failed-precondition','Atualize a agenda antes de avançar a visita.');
          tx.set(ref,{status:action,[`${action}_at`]:admin.firestore.FieldValue.serverTimestamp(),updated_at:admin.firestore.FieldValue.serverTimestamp(),updated_by:request.auth.uid},{merge:true});
          if (action === 'visit_departed') notification = {appointment:a,body:`O profissional ${a.professional} está a caminho do endereço informado.`};
        }
      });
      let notificationSent = false;
      try { if (notification) notificationSent=await sendVisitNotice(org,id,notification.body,action); }
      catch (error) { logger?.warn?.('Aviso da visita não enviado',{organizationId:org,appointmentId:id,action}); }
      return {saved:true,reminderQueued:true,notificationSent};
    }
    if (action === 'charge') {
      if (!payments?.createAppointmentBalancePayment) throw new HttpsError('unavailable','A cobrança pelo WhatsApp não está disponível.');
      const charge = await payments.createAppointmentBalancePayment(org,id);
      return {saved:true,reminderQueued:true,paymentCharge:charge};
    }
    if (action === 'save_transport') {
      const fields = {};
      for (const [key,max] of [['transport_address',500],['transport_reference',200],['transport_instructions',500]]) {
        const value = String(request.data?.[key] || '').trim();
        if (value.length > max) throw new HttpsError('invalid-argument','Informações de transporte muito longas.');
        fields[key] = value;
      }
      await db.runTransaction(async tx => {
        const a = (await tx.get(ref)).data();
        if (!a?.pet_id || !['pickup','delivery','both'].includes(a.transport_id) || ['completed','cancelled','canceled','no_show'].includes(a.status)) throw new HttpsError('failed-precondition','Este transporte não pode ser alterado.');
        tx.set(ref,{...fields,updated_at:admin.firestore.FieldValue.serverTimestamp(),updated_by:request.auth.uid},{merge:true});
      });
      return {saved:true,reminderQueued:true};
    }
    if (action === 'retry_refund') {
      const appointment = (await ref.get()).data();
      if (!appointment || !['cancelled','canceled'].includes(appointment.status) || !['refund_pending','refund_failed'].includes(appointment.payment_status)) throw new HttpsError('failed-precondition','Este agendamento não possui um estorno pendente.');
      if (!payments?.refundAppointment) throw new HttpsError('unavailable','O serviço de estorno não está disponível.');
      try {
        const refund = await payments.refundAppointment(org,id);
        return { saved:true, refundStatus:refund.status, reminderQueued:true };
      } catch (error) {
        logger?.warn?.('Nova tentativa manual de estorno falhou',{organizationId:org,appointmentId:id,status:error.response?.status || null});
        throw new HttpsError('unavailable','O estorno ainda não foi concluído. O sistema tentará novamente automaticamente.');
      }
    }
    const revision = crypto.randomUUID();
    let scheduledFor, refundRequired = false, notificationAppointment = null, completedPet = false;
    const paymentPolicy = payments ? await payments.policy(org) : {};
    const petShopSettings = action === 'complete' ? (await root(org).collection('pet_shop').doc('settings').get()).data() || {} : {};
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref), a = snap.data();
      const activeStatuses = a?.pet_id ? ['confirmed','pet_pickup_started','pet_collected','pet_received','pet_in_service','pet_ready','pet_out_for_delivery'] : a?.home_visit ? ['confirmed','visit_departed','visit_started'] : ['confirmed'];
      if (!a || !activeStatuses.includes(a.status)) throw new HttpsError('failed-precondition','O agendamento foi alterado. Atualize a agenda.');
      if (['pet_pickup_started','pet_collected','pet_received','pet_in_service','pet_ready','pet_out_for_delivery'].includes(action)) {
        if (!a.pet_id || nextPetAction(a) !== action) throw new HttpsError('failed-precondition','Esta etapa do atendimento não está disponível.');
        tx.set(ref,{status:action,[`${action}_at`]:admin.firestore.FieldValue.serverTimestamp(),updated_at:admin.firestore.FieldValue.serverTimestamp(),updated_by:request.auth.uid},{merge:true});
        notificationAppointment = { ...a, status: action };
        return;
      }
      if (action === 'complete' || action === 'no_show') {
        if (action === 'no_show' && a.status !== 'confirmed') throw new HttpsError('failed-precondition','A falta só pode ser registrada antes de receber o pet.');
        if (action === 'complete' && a.pet_id && nextPetAction(a) !== 'complete') throw new HttpsError('failed-precondition','Conclua as etapas de retirada ou entrega antes de encerrar.');
        const status = action === 'complete' ? 'completed' : 'no_show';
        if (action === 'complete' && a.pet_id) notificationAppointment = {...a,status:'completed'};
        const petRef = action === 'complete' && a.pet_id ? root(org).collection('pets').doc(a.pet_id) : null;
        const petSnapshot = petRef ? await tx.get(petRef) : null;
        tx.set(ref,{ status, [`${status}_at`]:admin.firestore.FieldValue.serverTimestamp(), updated_at:admin.firestore.FieldValue.serverTimestamp(),updated_by:request.auth.uid },{merge:true});
        const phone = normalizePhone(a.customer_phone || a.phone, false);
        if (action === 'complete' && phone) tx.set(root(org).collection('customers').doc(customerId(phone)), { phone, phone_key:phone, last_activity_at:admin.firestore.FieldValue.serverTimestamp(), updated_at:admin.firestore.FieldValue.serverTimestamp(), updated_by:request.auth.uid }, {merge:true});
        if (action === 'complete' && petSnapshot?.exists) {
          const returnDays = Number(petSnapshot.data().return_days || petShopSettings.return_days || 30);
          const recentHistory = [{ id, service:a.service || 'Atendimento', date:a.appointment_date || '', time:a.appointment_time || '', status:'completed', price:Number(a.total_price || 0) }, ...(Array.isArray(petSnapshot.data().recent_history) ? petSnapshot.data().recent_history.filter(item => item?.id !== id) : [])].slice(0,20);
          tx.set(petRef, { recent_history:recentHistory, last_service_at:admin.firestore.FieldValue.serverTimestamp(), last_service:a.service || 'Atendimento', last_appointment_id:id, return_interval_days:returnDays, next_care_at:admin.firestore.Timestamp.fromMillis(Date.now() + returnDays * 86400000), return_reminder_sent_for:admin.firestore.FieldValue.delete(), updated_at:admin.firestore.FieldValue.serverTimestamp(), updated_by:request.auth.uid }, {merge:true});
          completedPet = true;
        }
        return;
      }
      const person = await personFor(org,a,tx);
      const oldDate = date(a.appointment_date), oldLock = root(org).collection('booking_days').doc(`${person.id}_${oldDate}`);
      const oldSnap = await tx.get(oldLock);
      const oldReservations = { ...(oldSnap.data()?.reservations || {}) };
      delete oldReservations[id];
      const now = admin.firestore.FieldValue.serverTimestamp();
      const update = { updated_at: now, updated_by: request.auth.uid };
      if (action === 'reschedule') {
        const change = appointmentChangePolicy(a,paymentPolicy);
        if (!change.canReschedule) throw new HttpsError('failed-precondition',change.paid ? 'O prazo ou o limite de remarcações com sinal terminou.' : 'Este agendamento não pode mais ser remarcado.');
        const newDate = date(request.data?.date), time = String(request.data?.time || '');
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new HttpsError('invalid-argument','Horário inválido.');
        const newLock = root(org).collection('booking_days').doc(`${person.id}_${newDate}`);
        const newSnap = newLock.path === oldLock.path ? oldSnap : await tx.get(newLock);
        const held = { ...(newSnap.data()?.reservations || {}) }; delete held[id];
        const busy = [...blocks(await readDay(org,newDate,tx),person,id), ...Object.values(held)];
        const duration = Number(a.duration_minutes) || 30;
        if (!availableSlots(person,newDate,duration,busy).includes(time)) throw new HttpsError('failed-precondition','Esse horário não está disponível. Escolha outro.');
        scheduledFor = admin.firestore.Timestamp.fromDate(new Date(`${newDate}T${time}:00-03:00`));
        Object.assign(update,{ appointment_date: newDate, appointment_time: time, scheduled_for: scheduledFor, professional_id: person.id, reminder_revision: revision, reminder_status: 'pending', reminder_error: admin.firestore.FieldValue.delete(), rescheduled_at: now, reschedule_count: Number(a.reschedule_count || 0) + 1, deposit_transferred: change.paid });
        held[id] = { start: minute(time), end: minute(time)+duration };
        if (newLock.path !== oldLock.path) tx.set(oldLock,{ reservations: oldReservations, updated_at: now });
        tx.set(newLock,{ reservations: held, updated_at: now });
      } else {
        update.status = { complete:'completed', no_show:'no_show', cancel:'cancelled' }[action];
        update[`${update.status}_at`] = now;
        if (action === 'cancel') {
          const change = appointmentChangePolicy(a,paymentPolicy);
          if (!change.canCancel) throw new HttpsError('failed-precondition','O horário deste agendamento já começou.');
          refundRequired = change.refundEligible;
          Object.assign(update,{cancelled_by:'establishment',cancellation_reason:String(request.data?.reason || 'Cancelamento pelo estabelecimento').slice(0,200),...(change.refundEligible ? {payment_status:'refund_pending',refund_status:'pending'} : change.retainsDeposit ? {payment_status:'retained',refund_status:'not_eligible',deposit_retained_cents:Number(a.paid_cents || 0)} : {})});
          tx.set(oldLock,{ reservations:oldReservations,updated_at:now });
        }
      }
      tx.set(ref,update,{ merge:true });
    });
    let petNotification = { status:'not_applicable' };
    if (notificationAppointment) {
      const pet = notificationAppointment.pet_id ? (await root(org).collection('pets').doc(notificationAppointment.pet_id).get()).data() || {} : {};
      petNotification = await sendPetStatusNotification({ admin, db, axios, HttpsError, organizationId:org, appointmentId:id, appointment:notificationAppointment, pet, action });
    }
    if (refundRequired && payments?.refundAppointment) {
      try { await payments.refundAppointment(org,id); }
      catch (error) { logger?.warn?.('Estorno do sinal aguardando nova tentativa',{organizationId:org,appointmentId:id,status:error.response?.status || null}); }
    }
    let reminderQueued = true;
    if (scheduledFor && taskQueue) {
      const config = (await root(org).collection('automation_configs').doc('appointment_reminder').get()).data();
      if (config?.active) {
        const schedules = config.trigger === 'before_appointment' ? (Array.isArray(config.schedules) && config.schedules.length ? config.schedules : [Number(config.lead_time_minutes)||1440]) : [0];
        for (const lead of schedules) {
          const reminderKey = lead ? `before_${lead}` : 'after_confirmation';
          const delay = lead ? Math.max(0,Math.floor((scheduledFor.toMillis()-Date.now())/1000)-Number(lead)*60) : Number(config.delay_seconds)||30;
          try { await taskQueue.enqueue({ organizationId:org,appointmentId:id,revision,reminderKey },{ id:`reschedule-${id}-${revision}-${reminderKey}`,scheduleDelaySeconds:delay }); }
          catch { reminderQueued = false; await ref.set({ reminder_status:'failed',reminder_error:'Não foi possível programar todos os lembretes após a remarcação.' },{ merge:true }); }
        }
      }
    }
    if (action === 'complete' && lifecycleTaskQueue) {
      const automationId = completedPet ? 'pet_post_appointment' : 'post_appointment';
      const config = (await root(org).collection('automation_configs').doc('lifecycle_reminders').get()).data()?.automations?.[automationId];
      if (config?.active) {
        try { await lifecycleTaskQueue.enqueue({ organizationId:org,automationId,entityId:id },{ scheduleDelaySeconds:Math.max(0,Number(config.delay_minutes)||0)*60 }); }
        catch { await ref.set({ [`${automationId}_queue_status`]:'failed',updated_at:admin.firestore.FieldValue.serverTimestamp() },{merge:true}); }
      }
    }
    if (action === 'complete') {
      const done=(await ref.get()).data();
      if (done?.home_visit) {
        const remaining=Math.max(0,Math.round(Number(done.total_price||0)*100)-Number(done.paid_cents||0));
        const body=done.payment_status==='payment_review' ? `O atendimento de ${done.service} foi concluído. Nossa equipe vai conferir o pagamento.` : remaining ? `O atendimento de ${done.service} foi concluído. Saldo pendente: R$ ${(remaining/100).toFixed(2).replace('.',',')}. A equipe pode enviar o Pix nesta conversa.` : `O atendimento de ${done.service} foi concluído. Pagamento confirmado. Obrigado!`;
        try { await sendVisitNotice(org,id,body,'completed'); }
        catch (error) { logger?.warn?.('Aviso de conclusão pendente',{organizationId:org,appointmentId:id}); }
      }
    }
    return { saved:true, reminderQueued, petNotification };
  });
  return { listAppointments, getAppointmentSlots, updateAppointment, ...(processVisitReminders?{processVisitReminders}:{}) };
}
module.exports = { createAppointmentFunctions, normalizeDate, dayKey, visitNoticeKeys };
