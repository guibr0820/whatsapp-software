const crypto = require('node:crypto');
const { normalizePolicy, quote } = require('./payment-policy');
const region = 'southamerica-east1';
const API = 'https://api.mercadopago.com';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const money = cents => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
function seal(value, secret) {
  const iv = crypto.randomBytes(12), key = Buffer.from(secret, 'hex');
  if (key.length !== 32) throw new Error('Configure MERCADOPAGO_TOKEN_ENCRYPTION_KEY com 64 caracteres hexadecimais.');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const content = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), content.toString('base64')].join('.');
}
function unseal(value, secret) {
  const [iv, tag, content] = value.split('.').map(part => Buffer.from(part, 'base64'));
  const cipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(secret, 'hex'), iv);
  cipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([cipher.update(content), cipher.final()]).toString());
}
function validSignature(id, requestId, header, secret) {
  const fields = Object.fromEntries(String(header || '').split(',').map(p => p.trim().split('=')));
  if (!id || !requestId || !/^\d+$/.test(fields.ts || '') || !/^[a-f0-9]{64}$/.test(fields.v1 || '')) return false;
  const manifest = `id:${String(id).toLowerCase()};request-id:${requestId};ts:${fields.ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(fields.v1, 'hex'));
}
function orderPayload(attempt) {
  return { type: 'online', processing_mode: 'automatic', total_amount: (attempt.amount / 100).toFixed(2), external_reference: attempt.reference,
    payer: { email: attempt.email }, transactions: { payments: [{ amount: (attempt.amount / 100).toFixed(2), payment_method: { id: 'pix', type: 'bank_transfer' }, expiration_time: `PT${attempt.expiryMinutes}M` }] } };
}
function orderOutcome(order, attempt) {
  if (order.external_reference !== attempt.reference || Math.round(Number(order.total_amount) * 100) !== attempt.amount || order.currency !== 'BRL' || String(order.user_id) !== String(attempt.sellerId)) throw new Error('A cobrança não corresponde à reserva.');
  if (order.status === 'processed' && order.status_detail === 'accredited' && Math.round(Number(order.total_paid_amount) * 100) === attempt.amount) return 'paid';
  if (['canceled', 'cancelled', 'expired', 'failed'].includes(order.status)) return 'expired';
  return 'pending';
}
function pixMessage(attempt, appointment, policy, qr) {
  const deadline = new Date(attempt.expiresAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  const text = `Olá, ${appointment.customer_name}! Para confirmar seu agendamento, pague o sinal de ${money(attempt.amount)} até ${deadline}.\nRestante no estabelecimento: ${money(appointment.remaining_cents)}.\nO horário está reservado enquanto aguardamos o pagamento.`;
  if (!policy.pixKey || !policy.merchantName) return { type: 'text', text: { body: `${text}\n\nPix Copia e Cola:\n${qr}` } };
  const amount = { value: attempt.amount, offset: 100 };
  return { type: 'interactive', interactive: { type: 'order_details', body: { text }, action: { name: 'review_and_pay', parameters: {
    reference_id: attempt.reference, type: 'digital-goods', payment_type: 'br', currency: 'BRL', total_amount: amount,
    payment_settings: [{ type: 'pix_dynamic_code', pix_dynamic_code: { code: qr, merchant_name: policy.merchantName, key: policy.pixKey, key_type: policy.pixKeyType } }],
    order: { status: 'pending', items: [{ retailer_id: attempt.appointmentId, name: `Sinal · ${appointment.service}`.slice(0, 100), amount, quantity: 1 }], subtotal: amount }
  } } } };
}
function createMercadoPago({ admin, db, axios, logger, onCall, onRequest, onSchedule, HttpsError, secrets }) {
  const { clientId, clientSecret, encryptionKey, webhookSecret } = secrets;
  const oauthSecrets = [clientId, clientSecret, encryptionKey];
  const root = org => db.doc(`organizations/${org}`);
  const account = org => root(org).collection('integrations').doc('mercadopago');
  const policyRef = org => root(org).collection('payment_settings').doc('booking');
  const stamp = () => admin.firestore.FieldValue.serverTimestamp();
  const project = () => process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  const callback = () => `https://${region}-${project()}.cloudfunctions.net/mercadoPagoOAuthCallback`;
  let onPaid = async () => {};
  async function authorize(request) {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Entre na sua conta.');
    const org = String(request.data?.organizationId || '');
    if (!/^[\w-]{1,128}$/.test(org)) throw new HttpsError('invalid-argument', 'Empresa inválida.');
    const [company, member] = await Promise.all([root(org).get(), root(org).collection('members').doc(request.auth.uid).get()]);
    if (!company.exists || company.data().proprietario_uid !== request.auth.uid || member.data()?.status !== 'active') throw new HttpsError('permission-denied', 'Somente o proprietário pode configurar pagamentos.');
    return org;
  }
  async function policy(org) { return normalizePolicy((await policyRef(org).get()).data() || {}); }
  async function token(org) {
    const snap = await account(org).get(), data = snap.data();
    if (!data?.active) throw new Error('Conecte a conta Mercado Pago na tela Pagamentos.');
    let credentials = unseal(data.credentials, encryptionKey.value());
    if (data.expires_at.toMillis() > Date.now() + 5 * 60000) return credentials.access_token;
    const lease = crypto.randomUUID();
    await db.runTransaction(async tx => {
      const fresh = (await tx.get(account(org))).data();
      if (fresh.refresh_until?.toMillis() > Date.now()) throw new Error('A conta está sendo atualizada. Tente novamente.');
      tx.update(account(org), { refresh_lease: lease, refresh_until: admin.firestore.Timestamp.fromMillis(Date.now() + 60000) });
    });
    try {
      // Read again after acquiring the lease; another request may have refreshed it.
      const fresh = (await account(org).get()).data();
      credentials = unseal(fresh.credentials, encryptionKey.value());
      if (fresh.expires_at.toMillis() > Date.now() + 5 * 60000) return credentials.access_token;
      const result = await axios.post(`${API}/oauth/token`, { client_id: clientId.value(), client_secret: clientSecret.value(), grant_type: 'refresh_token', refresh_token: credentials.refresh_token }, { timeout: 15000 });
      if (!result.data.access_token || !result.data.refresh_token) throw new Error('Reconecte sua conta Mercado Pago.');
      await account(org).update({ credentials: seal(result.data, encryptionKey.value()), expires_at: admin.firestore.Timestamp.fromMillis(Date.now() + result.data.expires_in * 1000) });
      return result.data.access_token;
    } finally { await account(org).update({ refresh_until: admin.firestore.Timestamp.fromMillis(0) }); }
  }
  const getPaymentSettings = onCall({ region }, async request => {
    const org = await authorize(request), settings = await policy(org), connection = (await account(org).get()).data();
    return { settings, connected: connection?.active === true, sellerName: connection?.seller_name || '', sellerId: connection?.seller_id || '' };
  });
  const savePaymentSettings = onCall({ region }, async request => {
    const org = await authorize(request); let settings;
    try { settings = normalizePolicy(request.data?.settings); } catch (e) { throw new HttpsError('invalid-argument', e.message); }
    if (settings.mode === 'deposit' && !(await account(org).get()).data()?.active) throw new HttpsError('failed-precondition', 'Conecte sua conta Mercado Pago antes de exigir sinal.');
    if (settings.mode === 'deposit') {
      const menu = (await root(org).collection('automation_configs').doc('booking_menu').get()).data();
      const flow = menu?.flow_id ? (await root(org).collection('flow_configs').doc(menu.flow_id).get()).data() : null;
      if (!menu?.active || !flow?.active || flow.payment_schema_version !== 2) throw new HttpsError('failed-precondition', 'Primeiro crie e salve uma nova versão do Flow em Automações. Os Flows antigos ainda não têm a etapa de pagamento.');
    }
    await policyRef(org).set({ ...settings, updated_at: stamp(), updated_by: request.auth.uid });
    return { saved: true };
  });
  const connectMercadoPago = onCall({ region, secrets: [clientId] }, async request => {
    const org = await authorize(request), state = crypto.randomBytes(32).toString('hex');
    await db.doc(`mercadopago_oauth_states/${digest(state)}`).set({ organization_id: org, uid: request.auth.uid, expires_at: admin.firestore.Timestamp.fromMillis(Date.now() + 10 * 60000) });
    const params = new URLSearchParams({ client_id: clientId.value(), response_type: 'code', platform_id: 'mp', state, redirect_uri: callback() });
    return { url: `https://auth.mercadopago.com.br/authorization?${params}` };
  });
  const disconnectMercadoPago = onCall({ region }, async request => {
    const org = await authorize(request);
    await db.runTransaction(async tx => {
      const pending = await tx.get(db.collection('payment_attempts').where('organizationId', '==', org));
      if (pending.docs.some(d => d.data().active)) throw new HttpsError('failed-precondition', 'Aguarde a conclusão das cobranças pendentes antes de desconectar.');
      await tx.get(account(org)); tx.set(account(org), { active: false, disconnected_at: stamp() }); tx.set(policyRef(org), { mode: 'onsite', updated_at: stamp() }, { merge: true });
    });
    return { disconnected: true };
  });
  const mercadoPagoOAuthCallback = onRequest({ region, invoker: 'public', secrets: oauthSecrets }, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET') return res.sendStatus(405);
    const state = String(req.query.state || ''), code = String(req.query.code || '');
    if (!/^[a-f0-9]{64}$/.test(state) || !code || code.length > 2000) return res.status(400).send('Autorização inválida. Volte ao painel e conecte novamente.');
    try {
      let org;
      await db.runTransaction(async tx => {
        const ref = db.doc(`mercadopago_oauth_states/${digest(state)}`), data = (await tx.get(ref)).data();
        if (!data || data.used || data.expires_at.toMillis() < Date.now()) throw new Error('Estado expirado.');
        const [company, member] = await Promise.all([tx.get(root(data.organization_id)), tx.get(root(data.organization_id).collection('members').doc(data.uid))]);
        if (company.data()?.proprietario_uid !== data.uid || member.data()?.status !== 'active') throw new Error('Acesso alterado.');
        org = data.organization_id; tx.update(ref, { used: true });
      });
      const { data } = await axios.post(`${API}/oauth/token`, { client_id: clientId.value(), client_secret: clientSecret.value(), grant_type: 'authorization_code', code, redirect_uri: callback() }, { timeout: 15000 });
      if (!data.access_token || !data.refresh_token || !data.user_id || !(data.expires_in > 0)) throw new Error('Credenciais incompletas.');
      const seller = (await axios.get(`${API}/users/me`, { headers: { Authorization: `Bearer ${data.access_token}` }, timeout: 15000 })).data;
      if (seller.site_id !== 'MLB' || String(seller.id) !== String(data.user_id)) throw new Error('Use uma conta brasileira do Mercado Pago.');
      // A different seller cannot take over already-issued charges.
      await db.runTransaction(async tx => {
        const pending = await tx.get(db.collection('payment_attempts').where('organizationId', '==', org));
        if (pending.docs.some(d => d.data().active && String(d.data().sellerId) !== String(data.user_id))) throw new Error('Existem cobranças da conta anterior em andamento.');
        tx.set(account(org), { active: true, seller_id: String(data.user_id), seller_name: String(seller.nickname || 'Mercado Pago'), credentials: seal(data, encryptionKey.value()), expires_at: admin.firestore.Timestamp.fromMillis(Date.now() + data.expires_in * 1000), connected_at: stamp() });
      });
      return res.redirect(`https://${project()}.web.app/dashboard.html?mp=connected`);
    } catch (e) { logger.warn('Falha ao conectar Mercado Pago', { status: e.response?.status || null }); return res.status(400).send('Não foi possível conectar. Confira sua conta e inicie uma nova conexão pelo painel.'); }
  });
  async function intent(org, id, appointment, settings) {
    const connection = (await account(org).get()).data();
    if (!connection?.active) throw new Error('Conecte o Mercado Pago antes de exigir sinal.');
    const reference = digest(`${org}:${id}`).slice(0, 40), ref = db.doc(`payment_attempts/${reference}`);
    return { ref, data: { reference, organizationId: org, appointmentId: id, amount: appointment.deposit_cents, email: appointment.customer_email, sellerId: connection.seller_id, expiryMinutes: settings.expiryMinutes, expiresAt: Date.now() + settings.expiryMinutes * 60000, policy: settings, active: true, state: 'creating', created_at: stamp() } };
  }
  async function notify(attempt, appointment, outbound) {
    const credentials = (await root(attempt.organizationId).collection('integrations').doc('whatsapp').get()).data();
    if (!credentials?.active) throw new Error('WhatsApp desconectado.');
    const result = await axios.post(`https://graph.facebook.com/${credentials.graph_version || 'v24.0'}/${credentials.phone_number_id}/messages`, { messaging_product: 'whatsapp', to: appointment.customer_phone, ...outbound }, { headers: { Authorization: `Bearer ${credentials.access_token}` }, timeout: 15000 });
    const id = result.data.messages?.[0]?.id;
    if (!id) throw new Error('A Meta não confirmou o envio.');
    // Imported lazily to avoid a circular module initialization.
    const { saveOutboundProviderMessage } = require('./meta-whatsapp');
    await saveOutboundProviderMessage({ admin, db, organizationId: attempt.organizationId, conversationId: appointment.conversation_id, providerMessageId: id, type: outbound.type, text: outbound.text?.body || outbound.interactive?.body?.text || 'Cobrança Pix enviada', createdBy: 'automation' });
  }
  async function settle(ref, attempt, order) {
    const outcome = orderOutcome(order, attempt);
    if (outcome === 'pending') return false;
    const appointment = root(attempt.organizationId).collection('appointments').doc(attempt.appointmentId);
    let confirmed = false;
    await db.runTransaction(async tx => {
      const fresh = (await tx.get(ref)).data(), data = (await tx.get(appointment)).data();
      if (!fresh?.active || !data) return;
      const lockRef = root(attempt.organizationId).collection('booking_days').doc(`${data.professional_id}_${data.appointment_date}`);
      const lock = (await tx.get(lockRef)).data() || {}, reservations = { ...(lock.reservations || {}) };
      const valid = data.status === 'awaiting_payment' && Boolean(reservations[attempt.appointmentId]);
      confirmed = outcome === 'paid' && valid;
      const status = confirmed ? 'confirmed' : outcome === 'paid' ? 'payment_review' : 'payment_expired';
      tx.update(appointment, { status, payment_status: outcome === 'paid' ? 'paid' : 'expired', paid_cents: outcome === 'paid' ? attempt.amount : 0, payment_order_id: order.id, payment_updated_at: stamp(), updated_at: stamp() });
      if (outcome !== 'paid') { delete reservations[attempt.appointmentId]; tx.set(lockRef, { ...lock, reservations, updated_at: stamp() }); }
      tx.update(ref, { active: false, state: outcome, settled_at: stamp(), needs_confirmation: confirmed });
    });
    // The scheduler retries notifications independently of payment settlement.
    if (confirmed) await completeNotification(ref, attempt);
    return true;
  }
  async function completeNotification(ref, attempt) {
    const claimed = await db.runTransaction(async tx => {
      const a = (await tx.get(ref)).data();
      if (!a.needs_confirmation || a.confirm_until > Date.now()) return false;
      tx.update(ref, { confirm_until: Date.now() + 120000 }); return true;
    });
    if (!claimed) return;
    try { await onPaid(attempt.organizationId, attempt.appointmentId); await ref.update({ needs_confirmation: false }); }
    finally { await ref.update({ confirm_until: 0 }); }
  }
  async function processAttempt(ref) {
    const attempt = (await ref.get()).data();
    if (!attempt?.active) return;
    const access = await token(attempt.organizationId), headers = { Authorization: `Bearer ${access}` };
    let order;
    if (!attempt.orderId) {
      const result = await axios.post(`${API}/v1/orders`, orderPayload(attempt), { headers: { ...headers, 'X-Idempotency-Key': attempt.reference }, timeout: 20000 });
      order = result.data;
      if (!/^ORD[A-Za-z0-9]+$/.test(order.id || '')) throw new Error('A API Orders não retornou uma order válida.');
      await ref.update({ orderId: order.id, state: 'pending' });
      await db.doc(`mercadopago_orders/${order.id}`).set({ attemptId: ref.id });
      attempt.orderId = order.id;
    } else order = (await axios.get(`${API}/v1/orders/${attempt.orderId}`, { headers, timeout: 15000 })).data;
    await db.doc(`mercadopago_orders/${attempt.orderId}`).set({ attemptId: ref.id });
    if (await settle(ref, attempt, order)) return;
    if (Date.now() >= attempt.expiresAt) {
      try { await axios.post(`${API}/v1/orders/${order.id}/cancel`, {}, { headers: { ...headers, 'X-Idempotency-Key': `cancel-${attempt.reference}` }, timeout: 15000 }); } catch (e) { if (![400, 409].includes(e.response?.status)) throw e; }
      order = (await axios.get(`${API}/v1/orders/${order.id}`, { headers, timeout: 15000 })).data;
      await settle(ref, attempt, order); // Never free a slot on an unverified cancellation.
      return;
    }
    const appointment = (await root(attempt.organizationId).collection('appointments').doc(attempt.appointmentId).get()).data();
    const qr = order.transactions?.payments?.[0]?.payment_method?.qr_code;
    if (!qr || !appointment) return; // Async order: the webhook/scheduler will retry.
    // A short lease prevents concurrent webhook and scheduler sends.
    const claimed = await db.runTransaction(async tx => {
      const fresh = (await tx.get(ref)).data();
      if (!fresh.active || fresh.pix_sent || fresh.send_until > Date.now()) return false;
      tx.update(ref, { send_until: Date.now() + 60000 }); return true;
    });
    if (!claimed) return;
    try {
      let outbound = pixMessage(attempt, appointment, attempt.policy, qr);
      try { await notify(attempt, appointment, outbound); }
      catch (e) {
        if (outbound.type !== 'interactive' || e.response?.status !== 400) throw e;
        await notify(attempt, appointment, pixMessage(attempt, appointment, {}, qr));
      }
      await ref.update({ pix_sent: true });
      await root(attempt.organizationId).collection('appointments').doc(attempt.appointmentId).update({ payment_order_id: order.id });
    } finally { await ref.update({ send_until: 0 }); }
  }
  const mercadoPagoWebhook = onRequest({ region, invoker: 'public', secrets: [...oauthSecrets, webhookSecret], timeoutSeconds: 60 }, async (req, res) => {
    if (req.method !== 'POST') return res.sendStatus(405);
    const id = String(req.query['data.id'] || '');
    if (!/^ORD[A-Za-z0-9]+$/.test(id) || !validSignature(id, req.get('x-request-id'), req.get('x-signature'), webhookSecret.value())) return res.sendStatus(401);
    try {
      const map = (await db.doc(`mercadopago_orders/${id}`).get()).data();
      if (map) await processAttempt(db.doc(`payment_attempts/${map.attemptId}`));
      return res.sendStatus(200);
    } catch (e) { logger.error('Falha ao conciliar order', { orderId: id, status: e.response?.status || null }); return res.sendStatus(500); }
  });
  const reconcileMercadoPagoOrders = onSchedule({ region, schedule: 'every 1 minutes', secrets: oauthSecrets, timeoutSeconds: 540, maxInstances: 1 }, async () => {
    for (const field of ['active', 'needs_confirmation']) {
      let cursor;
      do {
        let query = db.collection('payment_attempts').where(field, '==', true).limit(100);
        if (cursor) query = query.startAfter(cursor);
        const page = await query.get(); cursor = page.docs.at(-1);
        for (const doc of page.docs) {
          try {
            const a = doc.data();
            if (field === 'active') await processAttempt(doc.ref);
            else await completeNotification(doc.ref, a);
          } catch (e) { logger.warn('Order aguardando nova conciliação', { attemptId: doc.id, status: e.response?.status || null }); }
        }
        if (page.size < 100) break;
      } while (cursor);
    }
  });
  return { functions: { getPaymentSettings, savePaymentSettings, connectMercadoPago, disconnectMercadoPago, mercadoPagoOAuthCallback, mercadoPagoWebhook, reconcileMercadoPagoOrders }, policy, intent, processAttempt, quote, setOnPaid: fn => { onPaid = fn; }, oauthSecrets };
}
module.exports = { createMercadoPago, seal, unseal, validSignature, orderPayload, orderOutcome, pixMessage };
