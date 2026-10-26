const crypto = require('node:crypto');
const { decryptFlowRequest, encryptFlowResponse } = require('./flow-crypto');
const flowTemplate = require('./appointment-flow.json');
const { quote } = require('./payment-policy');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const minutes = value => /^\d{2}:\d{2}$/.test(String(value)) ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : NaN;
const money = value => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const bookable = p => p.active === true && p.allow_online_booking !== false && p.schedule_active !== false && !['paused', 'unavailable'].includes(p.status);
const overlaps = (a, b, c, d) => a < d && b > c;
const DEFAULT_BOOKING_KEYWORDS = ['agendar', 'agendamento', 'marcar horário'];
function normalizeBookingText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}
function bookingKeywordMatches(text, keywords) {
  const haystack = ` ${normalizeBookingText(text)} `;
  return keywords.some(keyword => {
    const needle = normalizeBookingText(keyword);
    return needle && haystack.includes(` ${needle} `);
  });
}
function validateBookingKeywords(value) {
  if (!Array.isArray(value) || value.length > 30) throw new Error('Cadastre até 30 palavras ou frases de agendamento.');
  const seen = new Set();
  return value.map(item => {
    if (typeof item !== 'string' || item.trim().length > 80 || !normalizeBookingText(item)) throw new Error('Cada palavra ou frase deve conter entre 1 e 80 caracteres.');
    return item.trim();
  }).filter(item => { const key = normalizeBookingText(item); if (seen.has(key)) return false; seen.add(key); return true; });
}
function publicError(message) { const error = new Error(message); error.publicMessage = message; return error; }

function availableSlots(person, date, duration, reservations = [], now = Date.now()) {
  const noon = new Date(`${date}T12:00:00-03:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(noon.getTime()) || noon.toISOString().slice(0, 10) !== date || !bookable(person) || !Number.isFinite(duration) || duration <= 0) return [];
  if (!(person.work_days || []).map(Number).includes(noon.getUTCDay())) return [];
  if (person.vacation?.active && date >= person.vacation.start && date <= person.vacation.end) return [];
  const start = minutes(person.work_start), end = minutes(person.work_end);
  const interval = Math.max(5, Number(person.interval_minutes) || 30);
  const candidates = Array.isArray(person.available_times) && person.available_times.length ? person.available_times : Array.from({ length: Math.max(0, Math.min(288, Math.ceil((end - start) / interval) || 0)) }, (_, i) => {
    const m = start + i * interval;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  });
  const blocks = [person.lunch, person.additional_break].filter(b => b?.active).map(b => ({ start: minutes(b.start), end: minutes(b.end) }));
  return [...new Set(candidates)].filter(time => {
    const m = minutes(time);
    return Number.isFinite(m) && m >= start && m + duration <= end && new Date(`${date}T${time}:00-03:00`).getTime() > now
      && ![...blocks, ...reservations].some(b => overlaps(m, m + duration, b.start, b.end));
  }).sort();
}

function buildDynamicFlow(config = {}) {
  const json = structuredClone(flowTemplate);
  if (config.title) json.screens[0].title = config.title.slice(0, 30);
  const errorScreen = { id: 'ERRO', title: 'Não foi possível continuar', terminal: true, data: { message: { type: 'string', __example__: 'Envie menu e tente novamente.' } }, layout: { type: 'SingleColumnLayout', children: [{ type: 'TextBody', text: '${data.message}' }, { type: 'Footer', label: 'Fechar', 'on-click-action': { name: 'complete', payload: { status: 'error' } } }] } };
  json.screens.push(errorScreen);
  json.routing_model.ERRO = [];
  for (const routes of Object.values(json.routing_model)) if (routes.length && !routes.includes('ERRO')) routes.push('ERRO');
  // Additional choices can be skipped when the catalog has none.
  json.routing_model.SERVICO.push('PROFISSIONAL');
  return json;
}

function createBookingRuntime({ admin, db, axios, logger, taskQueue, saveOutbound, payments }) {
  const root = org => db.doc(`organizations/${org}`);
  const response = (screen, data) => ({ version: '3.0', screen, data });
  async function catalog(org) {
    const entries = await Promise.all(['services', 'service_options', 'professionals'].map(async name => {
      const snap = await root(org).collection(name).where('active', '==', true).get();
      return [name, snap.docs.map(d => ({ ...d.data(), id: d.id })).sort((a,b) => a.name.localeCompare(b.name, 'pt-BR'))];
    }));
    return Object.fromEntries(entries);
  }
  const option = item => ({ id: item.id, title: item.name.slice(0, 30), description: `${item.duration_minutes || 0} min · ${money(item.price || 0)}` });
  async function selection(org, input, requireProfessional = false) {
    const c = await catalog(org);
    const service = c.services.find(s => s.id === input.service_id);
    if (!service) throw publicError('Este serviço não está mais disponível. Envie menu e tente novamente.');
    const extraIds = Array.isArray(input.extra_ids) ? [...new Set(input.extra_ids)] : [];
    const extras = extraIds.map(id => c.service_options.find(e => e.id === id && (!e.service_ids?.length || e.service_ids.includes(service.id))));
    if (extras.some(e => !e)) throw publicError('Um adicional não está disponível para este serviço.');
    const people = c.professionals.filter(p => bookable(p) && p.service_ids?.includes(service.id));
    const professional = people.find(p => p.id === input.professional_id);
    if (requireProfessional && !professional) throw publicError('O profissional não está disponível para este serviço.');
    const duration = Number(service.duration_minutes) + extras.reduce((n,e) => n + Number(e.duration_minutes || 0), 0);
    const price = Number(service.price || 0) + extras.reduce((n,e) => n + Number(e.price || 0), 0);
    return { service, extras, professional, people, duration, price, ids: { service_id: service.id, extra_ids: extraIds, ...(professional ? { professional_id: professional.id } : {}) } };
  }
  async function reservations(org, person, date, reader = db) {
    const dates = [...new Set([date, date.split('-').reverse().join('/')])];
    const snapshots = await Promise.all(dates.map(value => {
      const query = root(org).collection('appointments').where('appointment_date', '==', value);
      return reader === db ? query.get() : reader.get(query);
    }));
    return snapshots.flatMap(snap => snap.docs).map(d => d.data()).filter(a => !['cancelled', 'canceled', 'rejected', 'payment_expired'].includes(a.status) && (a.professional_id === person.id || a.professional === person.name)).map(a => ({ start: minutes(a.appointment_time), end: minutes(a.appointment_time) + Number(a.duration_minutes || 30) }));
  }
  async function slots(org, s, date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || date < today() || date > new Date(Date.now() + 30 * 86400000).toISOString().slice(0,10)) return [];
    const result = availableSlots(s.professional, date, s.duration, await reservations(org, s.professional, date));
    const policy = payments ? await payments.policy(org) : { mode: 'onsite' };
    return policy.mode === 'deposit' ? result.filter(time => new Date(`${date}T${time}:00-03:00`).getTime() > Date.now() + policy.expiryMinutes * 60000) : result;
  }
  async function session(token) {
    if (!/^[a-f0-9-]{36}$/.test(String(token))) throw publicError('Sessão inválida. Envie menu novamente.');
    const snap = await db.doc(`whatsapp_flow_sessions/${token}`).get();
    const data = snap.data();
    if (!data || data.expires_at.toMillis() < Date.now()) throw publicError('Esta sessão expirou. Envie menu novamente.');
    const integration = (await root(data.organization_id).collection('integrations').doc('whatsapp').get()).data();
    if (!integration?.active) throw publicError('O estabelecimento está desconectado.');
    return { ...data, ref: snap.ref };
  }
  async function handle(payload) {
    if (payload.action === 'ping') return { version: '3.0', data: { status: 'active' } };
    const current = await session(payload.flow_token);
    const org = current.organization_id, input = payload.data || {};
    if (current.status === 'completed') {
      const appointment = (await root(org).collection('appointments').doc(current.appointment_id).get()).data();
      if (appointment) {
        if (appointment.status === 'confirmed') await finishConfirmed(org, current.appointment_id);
      }
      return response('SUCESSO', { draft_id: current.appointment_id, confirmation_message: appointment?.status === 'awaiting_payment' ? 'Sua reserva aguarda o pagamento do sinal. Confira o Pix nesta conversa.' : appointment?.status === 'confirmed' ? 'Seu agendamento já está confirmado.' : 'Consulte a situação da sua reserva na conversa com o estabelecimento.' });
    }
    if (input.error) return { version: '3.0', data: { acknowledged: true } };
    const step = payload.action === 'INIT' || payload.action === 'BACK' ? 'init' : input.step;
    if (step === 'init') {
      const c = await catalog(org);
      const services = c.services.filter(s => c.professionals.some(p => bookable(p) && p.service_ids?.includes(s.id)));
      if (!services.length) throw publicError('Não há serviços com profissionais disponíveis. Fale com o estabelecimento.');
      return response('SERVICO', { services: services.map(option) });
    }
    const s = await selection(org, input, !['service', 'extras'].includes(step));
    if (step === 'service') {
      const c = await catalog(org);
      const extras = c.service_options.filter(e => !e.service_ids?.length || e.service_ids.includes(s.service.id));
      if (extras.length) return response('ADICIONAIS', { service_id: s.service.id, extras: extras.map(option) });
    }
    if (step === 'service' || step === 'extras') {
      if (!s.people.length) throw publicError('Não há profissional disponível para esse serviço.');
      return response('PROFISSIONAL', { ...s.ids, professionals: s.people.map(p => ({ id: p.id, title: p.name.slice(0,30), description: (p.specialty || 'Disponível para agendamento').slice(0,300) })) });
    }
    if (step === 'professional') {
      const dates = [];
      const base = today();
      for (let i = 0; i < 30; i++) {
        const date = new Date(new Date(`${base}T12:00:00Z`).getTime() + i * 86400000).toISOString().slice(0,10);
        if (availableSlots(s.professional, date, s.duration).length) dates.push({ id: date, title: new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' }).format(new Date(`${date}T12:00:00Z`)), description: 'Consultar horários disponíveis' });
      }
      if (!dates.length) throw publicError('Sem datas disponíveis nos próximos 30 dias.');
      return response('DATA', { ...s.ids, dates });
    }
    const available = await slots(org, s, input.date);
    if (step === 'date') {
      if (!available.length) throw publicError('Não há horários livres nessa data. Envie menu e escolha outro dia.');
      return response('HORARIO', { ...s.ids, date: input.date, times: available.map(time => ({ id: time, title: time })) });
    }
    if (!available.includes(input.time)) throw publicError('Esse horário não está mais disponível. Envie menu e escolha outro horário.');
    const ids = { ...s.ids, date: input.date, time: input.time };
    if (step === 'time') return response('DADOS', { ...ids, profile_name: current.customer_name || 'Cliente', phone_summary: current.phone });
    const name = String(input.client_name || '').trim();
    if (name.length < 2 || name.length > 100) throw publicError('Informe um nome entre 2 e 100 caracteres.');
    const policy = payments ? await payments.policy(org) : { mode: 'onsite' };
    if (policy.mode === 'deposit' && (await root(org).collection('flow_configs').doc(current.flow_id).get()).data()?.payment_schema_version !== 2) throw publicError('Este convite foi atualizado. Envie menu para abrir o novo agendamento.');
    const amounts = quote(s.price, policy);
    const email = String(input.client_email || '').trim().toLowerCase();
    if (step === 'details' && policy.mode === 'deposit') return response('PAGAMENTO', { ...ids, client_name: name, payment_summary: `Sinal: ${money(amounts.depositCents / 100)}\nRestante no estabelecimento: ${money(amounts.remainingCents / 100)}\nPrazo para pagar: ${policy.expiryMinutes} minutos.` });
    if (policy.mode === 'deposit' && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)) throw publicError('Informe um e-mail válido para gerar o Pix.');
    if (step === 'details' || step === 'payment') {
      await current.ref.set({ reviewed_payment_policy: JSON.stringify(policy), reviewed_price: s.price }, { merge: true });
      return response('RESUMO', { ...ids, client_name: name, client_email: email, client_summary: `${name} · ${current.phone}`, service_summary: s.service.name, extras_summary: s.extras.map(e => e.name).join(', ') || 'Nenhum adicional', professional_summary: s.professional.name, datetime_summary: `${input.date.split('-').reverse().join('/')} às ${input.time}`, total_summary: `Total: ${money(s.price)}`, payment_summary: policy.mode === 'deposit' ? `Sinal por Pix: ${money(amounts.depositCents / 100)}\nRestante presencial: ${money(amounts.remainingCents / 100)}\nO horário só será confirmado após pagar. O Pix vence em ${policy.expiryMinutes} minutos.` : 'Pagamento no estabelecimento.', submit_label: policy.mode === 'deposit' ? 'Gerar Pix do sinal' : 'Confirmar agendamento' });
    }
    if (step !== 'confirm') throw publicError('Etapa inválida. Envie menu e tente novamente.');
    if (current.reviewed_payment_policy !== JSON.stringify(policy) || current.reviewed_price !== s.price) throw publicError('O valor ou a regra de pagamento mudou. Envie menu e revise o agendamento.');
    const appointmentId = hash(`booking:${payload.flow_token}`);
    const appointment = root(org).collection('appointments').doc(appointmentId);
    const dayLock = root(org).collection('booking_days').doc(`${s.professional.id}_${input.date}`);
    const scheduledFor = admin.firestore.Timestamp.fromDate(new Date(`${input.date}T${input.time}:00-03:00`));
    const paymentData = { deposit_cents: amounts.depositCents, remaining_cents: amounts.remainingCents, customer_email: email };
    const intent = policy.mode === 'deposit' ? await payments.intent(org, appointmentId, paymentData, policy) : null;
    await db.runTransaction(async tx => {
      const [previous, lock, freshSession, freshPerson, freshService] = await Promise.all([tx.get(appointment), tx.get(dayLock), tx.get(current.ref), tx.get(root(org).collection('professionals').doc(s.professional.id)), tx.get(root(org).collection('services').doc(s.service.id))]);
      if (previous.exists) return;
      const freshPolicy = await tx.get(root(org).collection('payment_settings').doc('booking'));
      if (payments && JSON.stringify(require('./payment-policy').normalizePolicy(freshPolicy.data() || {})) !== JSON.stringify(policy)) throw publicError('A regra de pagamento mudou. Envie menu e revise novamente.');
      if (intent) {
        const seller = (await tx.get(root(org).collection('integrations').doc('mercadopago'))).data();
        if (!seller?.active || seller.seller_id !== intent.data.sellerId) throw publicError('O pagamento está temporariamente indisponível. Fale com o estabelecimento.');
      }
      if (freshSession.data()?.expires_at.toMillis() < Date.now()) throw publicError('Sessão expirada. Envie menu novamente.');
      if (freshPerson.data()?.updated_at?.toMillis() !== s.professional.updated_at?.toMillis() || freshService.data()?.updated_at?.toMillis() !== s.service.updated_at?.toMillis()) throw publicError('O cadastro foi atualizado. Envie menu e confira as opções novamente.');
      for (const e of s.extras) { const fresh = await tx.get(root(org).collection('service_options').doc(e.id)); if (fresh.data()?.updated_at?.toMillis() !== e.updated_at?.toMillis()) throw publicError('Um adicional foi atualizado. Envie menu novamente.'); }
      const busy = await reservations(org, s.professional, input.date, tx);
      const held = Object.values(lock.data()?.reservations || {});
      if (!availableSlots(freshPerson.data(), input.date, s.duration, [...busy, ...held]).includes(input.time)) throw publicError('Esse horário acabou de ser reservado. Envie menu e escolha outro horário.');
      const now = admin.firestore.FieldValue.serverTimestamp();
      tx.set(dayLock, { reservations: { [appointmentId]: { start: minutes(input.time), end: minutes(input.time) + s.duration } }, updated_at: now }, { merge: true });
      tx.set(appointment, { ...s.ids, ...paymentData, payment_status: intent ? 'pending' : 'onsite', paid_cents: 0, payment_expires_at: intent ? admin.firestore.Timestamp.fromMillis(intent.data.expiresAt) : null, conversation_id: current.conversation_id, customer_phone: current.phone, customer_name: name, service: s.service.name, optional: s.extras.map(e => e.name).join(', '), professional: s.professional.name, appointment_date: input.date, appointment_time: input.time, duration_minutes: s.duration, total_price: s.price, scheduled_for: scheduledFor, status: intent ? 'awaiting_payment' : 'confirmed', flow_id: current.flow_id, created_at: now, updated_at: now });
      if (intent) tx.set(intent.ref, intent.data);
      tx.set(current.ref, { status: 'completed', appointment_id: appointmentId }, { merge: true });
    });
    if (intent) {
      try { await payments.processAttempt(intent.ref); }
      catch (e) { logger.warn('Pix será processado pela conciliação', { organizationId: org, appointmentId, status: e.response?.status || null }); }
    } else await finishConfirmed(org, appointmentId);
    return response('SUCESSO', { draft_id: appointmentId, confirmation_message: intent ? 'Sua reserva foi recebida! Vamos enviar o Pix nesta conversa. O agendamento será confirmado após o pagamento do sinal.' : 'Seu agendamento está confirmado! Os detalhes aparecerão nesta conversa.' });
  }
  async function finishConfirmed(org, appointmentId) {
    const data = (await root(org).collection('appointments').doc(appointmentId).get()).data();
    if (data?.status !== 'confirmed') return;
    await sendConfirmation(org, appointmentId);
    await queueReminder(org, appointmentId, data.scheduled_for);
  }
  async function sendConfirmation(org, appointmentId) {
    const ref = root(org).collection('appointments').doc(appointmentId);
    const data = (await ref.get()).data();
    if (!data || data.confirmation_sent || data.status !== 'confirmed') return;
    const credentials = (await root(org).collection('integrations').doc('whatsapp').get()).data();
    if (!credentials?.active) return;
    const payment = data.payment_status === 'paid' ? `Sinal pago: ${money(data.paid_cents / 100)}\nRestante no estabelecimento: ${money(data.remaining_cents / 100)}` : 'Pagamento no estabelecimento.';
    const body = `Agendamento confirmado!\n\n${data.service}${data.optional ? ` · ${data.optional}` : ''}\nProfissional: ${data.professional}\nData: ${data.appointment_date.split('-').reverse().join('/')} às ${data.appointment_time}\nTotal: ${money(data.total_price)}\n${payment}\n\nPara voltar ao atendimento automático, envie menu.`;
    const result = await axios.post(`https://graph.facebook.com/${credentials.graph_version || 'v24.0'}/${credentials.phone_number_id}/messages`, { messaging_product: 'whatsapp', to: data.customer_phone, type: 'text', text: { body } }, { headers: { Authorization: `Bearer ${credentials.access_token}` }, timeout: 15000 });
    const providerMessageId = result.data?.messages?.[0]?.id;
    if (!providerMessageId) throw new Error('A Meta não confirmou o envio da confirmação.');
    await saveOutbound({ admin, db, organizationId: org, conversationId: data.conversation_id, providerMessageId, type: 'text', text: body, createdBy: 'automation' });
    await ref.set({ confirmation_sent: true }, { merge: true });
  }
  async function queueReminder(org, appointmentId, scheduledFor) {
    const config = (await root(org).collection('automation_configs').doc('appointment_reminder').get()).data();
    if (!config?.active || !taskQueue) return;
    let delay = Number(config.delay_seconds) || 30;
    if (config.trigger === 'before_appointment') delay = Math.max(0, Math.floor((scheduledFor.toMillis() - Date.now()) / 1000) - (Number(config.lead_time_minutes) || 1440) * 60);
    try { await taskQueue.enqueue({ organizationId: org, appointmentId }, { id: `booking-${appointmentId}`, scheduleDelaySeconds: delay }); }
    catch (error) { if (![6, 'already-exists', 'functions/task-already-exists'].includes(error.code)) { logger.error('Falha ao agendar lembrete do Flow', { organizationId: org, appointmentId }); throw error; } }
  }
  async function createSession({ organizationId, conversationId, flowId, phone, customerName }) {
    const token = crypto.randomUUID();
    await db.doc(`whatsapp_flow_sessions/${token}`).set({ organization_id: organizationId, conversation_id: conversationId, flow_id: flowId, phone, customer_name: customerName, status: 'sent', expires_at: admin.firestore.Timestamp.fromMillis(Date.now() + 30 * 60000), created_at: admin.firestore.FieldValue.serverTimestamp() });
    return token;
  }
  async function automate({ organizationId, message, contact }) {
    if (message.type === 'interactive' && message.interactive?.nfm_reply) return;
    if (!['text', 'interactive'].includes(message.type)) return;
    const org = root(organizationId);
    const setting = (await org.collection('automation_configs').doc('booking_menu').get()).data();
    if (!setting?.active || !setting.flow_id) return;
    const phone = String(message.from), conversationId = hash(`contact:${phone}`);
    const conversation = org.collection('conversations').doc(conversationId);
    const text = normalizeBookingText(message.text?.body);
    const action = message.interactive?.button_reply?.id;
    const reset = ['menu', 'inicio', 'voltar'].includes(text);
    const state = (await conversation.get()).data() || {};
    if (reset) await conversation.set({ human_support: false, booking_confirmation_expires_at: null }, { merge: true });
    if (!reset && state.human_support) return;
    const credentials = (await org.collection('integrations').doc('whatsapp').get()).data();
    if (!credentials?.active) return;
    const config = (await org.collection('flow_configs').doc(setting.flow_id).get()).data();
    if (!config?.active || !config.dynamic || config.status !== 'PUBLISHED') return;
    const name = String((await org.get()).data()?.nome || 'estabelecimento');
    const pending = !reset && state.booking_confirmation_expires_at?.toMillis() > Date.now();
    const yes = pending && (action === 'booking_confirm_yes' || text === 'sim');
    const no = pending && (action === 'booking_confirm_no' || text === 'nao');
    const keywords = Array.isArray(setting.keywords) ? setting.keywords : DEFAULT_BOOKING_KEYWORDS;
    let outbound;
    if (action === 'menu_book' || yes) {
      await conversation.set({ booking_confirmation_expires_at: null }, { merge: true });
      const token = await createSession({ organizationId, conversationId, flowId: setting.flow_id, phone, customerName: contact?.profile?.name || '' });
      outbound = { type: 'interactive', interactive: { type: 'flow', body: { text: String(config.message).replaceAll('{{cliente_nome}}', contact?.profile?.name || 'cliente').replaceAll('{{empresa_nome}}', name) }, action: { name: 'flow', parameters: { flow_message_version: '3', flow_id: setting.flow_id, flow_token: token, flow_cta: config.cta || 'Agendar agora', flow_action: 'data_exchange' } } } };
    } else if (action === 'menu_support') {
      await conversation.set({ human_support: true, booking_confirmation_expires_at: null }, { merge: true });
      outbound = { type: 'text', text: { body: 'Seu pedido foi encaminhado ao atendimento. Para voltar ao agendamento automático, envie menu.' } };
    } else if (action === 'menu_appointments') {
      const snap = await org.collection('appointments').where('customer_phone', '==', phone).get();
      const upcoming = snap.docs.map(d => d.data()).filter(a => a.status === 'confirmed' && a.scheduled_for?.toMillis() > Date.now()).sort((a,b) => a.scheduled_for.toMillis() - b.scheduled_for.toMillis()).slice(0,10);
      outbound = { type: 'text', text: { body: upcoming.length ? upcoming.map(a => `${a.service} · ${a.appointment_date} às ${a.appointment_time}\nProfissional: ${a.professional}`).join('\n\n') : 'Você não tem agendamentos futuros confirmados. Envie menu para agendar.' } };
    } else if (!reset && !no && !action && bookingKeywordMatches(text, keywords)) {
      await conversation.set({ booking_confirmation_expires_at: admin.firestore.Timestamp.fromMillis(Date.now() + 10 * 60000) }, { merge: true });
      outbound = { type: 'interactive', interactive: { type: 'button', body: { text: 'Você quer realizar um agendamento?' }, action: { buttons: [{ type: 'reply', reply: { id: 'booking_confirm_yes', title: 'Sim' } }, { type: 'reply', reply: { id: 'booking_confirm_no', title: 'Não' } }] } } };
    } else {
      await conversation.set({ booking_confirmation_expires_at: null }, { merge: true });
      outbound = { type: 'interactive', interactive: { type: 'button', body: { text: `Olá! Bem-vindo à ${name}. Como podemos ajudar?` }, action: { buttons: [{ type: 'reply', reply: { id: 'menu_book', title: 'Agendar horário' } }, { type: 'reply', reply: { id: 'menu_appointments', title: 'Meus agendamentos' } }, { type: 'reply', reply: { id: 'menu_support', title: 'Falar com atendente' } }] } } };
    }
    const result = await axios.post(`https://graph.facebook.com/${credentials.graph_version || 'v24.0'}/${credentials.phone_number_id}/messages`, { messaging_product: 'whatsapp', to: phone, ...outbound }, { headers: { Authorization: `Bearer ${credentials.access_token}` }, timeout: 15000 });
    const id = result.data?.messages?.[0]?.id;
    if (id) await saveOutbound({ admin, db, organizationId, conversationId, providerMessageId: id, type: outbound.type === 'text' ? 'text' : 'interactive', text: outbound.text?.body || outbound.interactive.body.text, createdBy: 'automation' });
  }
  return { handle, automate, createSession, finishConfirmed };
}

function createFlowEndpoint({ onRequest, privateKey, appSecret, runtime, logger, paymentSecrets = [] }) {
  return onRequest({ region: 'southamerica-east1', invoker: 'public', timeoutSeconds: 120, secrets: [privateKey, appSecret, ...paymentSecrets] }, async (req, res) => {
    if (req.method !== 'POST') return res.sendStatus(405);
    const expected = crypto.createHmac('sha256', appSecret.value()).update(req.rawBody || Buffer.alloc(0)).digest('hex');
    const signature = String(req.get('x-hub-signature-256') || '').replace(/^sha256=/, '');
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return res.sendStatus(401);
    let decrypted;
    try { decrypted = decryptFlowRequest(req.body, privateKey.value().replace(/\\n/g, '\n')); }
    catch { return res.sendStatus(421); }
    try {
      const result = await runtime.handle(decrypted.payload);
      return res.type('text/plain').send(encryptFlowResponse(result, decrypted.aesKey, decrypted.initialVector));
    } catch (error) {
      logger.error('Falha no endpoint de agendamento', { message: error.publicMessage || 'Erro interno ao processar agendamento' });
      const result = { version: '3.0', screen: 'ERRO', data: { message: error.publicMessage || 'Não foi possível concluir agora. Envie menu para tentar novamente.' } };
      return res.type('text/plain').send(encryptFlowResponse(result, decrypted.aesKey, decrypted.initialVector));
    }
  });
}
module.exports = { createBookingRuntime, createFlowEndpoint, buildDynamicFlow, availableSlots, DEFAULT_BOOKING_KEYWORDS, validateBookingKeywords, bookingKeywordMatches };
