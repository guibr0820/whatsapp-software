const crypto = require('node:crypto');
const { normalizePolicy, quote } = require('./payment-policy');
const { assertFeature } = require('./plan-limits');
const { packagePublic } = require('./capacity-packages');
const region = 'southamerica-east1';
const API = 'https://api.mercadopago.com';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function createPkce() {
  const verifier = crypto.randomBytes(64).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}
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
function paymentPayload(attempt, notificationUrl) {
  return { transaction_amount: attempt.amount / 100, description: `Sinal do agendamento ${attempt.appointmentId}`.slice(0, 120), payment_method_id: 'pix',
    date_of_expiration: new Date(attempt.expiresAt).toISOString(), payer: { email: attempt.email }, external_reference: attempt.reference, notification_url: notificationUrl };
}
function paymentOutcome(payment, attempt) {
  const collectorId = payment.collector_id ?? payment.user_id;
  if (payment.external_reference !== attempt.reference || Math.round(Number(payment.transaction_amount) * 100) !== attempt.amount || payment.currency_id !== 'BRL' || String(collectorId) !== String(attempt.sellerId)) throw new Error('A cobrança não corresponde à reserva.');
  if (payment.status === 'approved') return 'paid';
  if (['cancelled', 'canceled', 'rejected', 'refunded', 'charged_back'].includes(payment.status)) return 'expired';
  return 'pending';
}
function pixMessage(attempt, appointment, _policy, qr) {
  const deadline = new Date(attempt.expiresAt).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  const text = `Olá, ${appointment.customer_name}! Para confirmar seu agendamento, pague o sinal de ${money(attempt.amount)} até ${deadline}.\nRestante no estabelecimento: ${money(appointment.remaining_cents)}.\nO horário está reservado enquanto aguardamos o pagamento.`;
  return { type: 'text', text: { body: `${text}\n\nPix Copia e Cola:\n${qr}` } };
}
function createMercadoPago({ admin, db, axios, logger, onCall, onRequest, onSchedule, HttpsError, secrets, params = {} }) {
  const { clientId, clientSecret, encryptionKey, webhookSecret } = secrets;
  const { platformOrganizationId } = params;
  const oauthSecrets = [clientId, clientSecret, encryptionKey];
  const root = org => db.doc(`organizations/${org}`);
  const account = org => root(org).collection('integrations').doc('mercadopago');
  const policyRef = org => root(org).collection('payment_settings').doc('booking');
  const stamp = () => admin.firestore.FieldValue.serverTimestamp();
  const project = () => process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  const callback = () => `https://${region}-${project()}.cloudfunctions.net/mercadoPagoOAuthCallback`;
  const webhook = () => `https://${region}-${project()}.cloudfunctions.net/mercadoPagoWebhook`;
  let onPaid = async () => {};
  async function authorize(request) {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Entre na sua conta.');
    const org = String(request.data?.organizationId || '');
    if (!/^[\w-]{1,128}$/.test(org)) throw new HttpsError('invalid-argument', 'Empresa inválida.');
    const [company, member] = await Promise.all([root(org).get(), root(org).collection('members').doc(request.auth.uid).get()]);
    if (!company.exists || company.data()?.status === 'suspended' || company.data().proprietario_uid !== request.auth.uid || member.data()?.status !== 'active') throw new HttpsError('permission-denied', company.data()?.status === 'suspended' ? 'Esta empresa está suspensa. Fale com o suporte.' : 'Somente o proprietário pode configurar pagamentos.');
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
  const capacityPublic = data => ({
    id: data.id,
    packageId: data.package_id || '',
    packageName: data.package_name || 'Capacidade extra',
    status: data.status,
    amount: data.amount,
    appointments: data.appointments,
    reminders: data.reminders,
    qrCode: data.qr_code || '',
    qrCodeBase64: data.qr_code_base64 || '',
    ticketUrl: data.ticket_url || '',
    expiresAt: Number(data.expires_at || 0),
  });
  async function settleCapacityPurchase(org, purchaseId, payment) {
    const ref = root(org).collection('capacity_purchases').doc(purchaseId);
    const purchase = (await ref.get()).data();
    if (!purchase) return false;
    const outcome = paymentOutcome(payment, { reference: purchase.reference, amount: purchase.amount, sellerId: purchase.seller_id });
    if (outcome === 'pending') return false;
    await db.runTransaction(async tx => {
      const fresh = (await tx.get(ref)).data();
      if (!fresh || fresh.credited_at) return;
      if (outcome !== 'paid') {
        tx.set(ref, { status: 'expired', provider_status: String(payment.status || ''), updated_at: stamp() }, { merge: true });
        return;
      }
      const creditsRef = root(org).collection('capacity').doc('credits');
      tx.set(creditsRef, {
        appointments: admin.firestore.FieldValue.increment(fresh.appointments),
        reminders: admin.firestore.FieldValue.increment(fresh.reminders),
        updated_at: stamp(),
      }, { merge: true });
      tx.set(ref, { status: 'approved', provider_status: 'approved', credited_at: stamp(), updated_at: stamp() }, { merge: true });
    });
    return outcome === 'paid';
  }
  async function processCapacityPurchase(org, purchaseId) {
    const ref = root(org).collection('capacity_purchases').doc(purchaseId);
    const purchase = (await ref.get()).data();
    if (!purchase?.payment_id || purchase.credited_at) return;
    const access = await token(platformOrganizationId.value());
    const payment = (await axios.get(`${API}/v1/payments/${purchase.payment_id}`, { headers: { Authorization: `Bearer ${access}` }, timeout: 15000 })).data;
    await settleCapacityPurchase(org, purchaseId, payment);
  }
  const createCapacityPurchase = onCall({ region, secrets: oauthSecrets }, async request => {
    const org = await authorize(request);
    const packageId = String(request.data?.packageId || '');
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(packageId)) throw new HttpsError('invalid-argument', 'Escolha um pacote válido.');
    const packageSnapshot = await db.doc(`capacity_packages/${packageId}`).get();
    if (!packageSnapshot.exists) throw new HttpsError('not-found', 'Este pacote não está mais disponível.');
    let capacityPackage;
    try { capacityPackage = packagePublic(packageSnapshot.id, packageSnapshot.data()); }
    catch { throw new HttpsError('failed-precondition', 'A configuração deste pacote precisa ser revisada.'); }
    if (!capacityPackage.active) throw new HttpsError('failed-precondition', 'Este pacote não está mais disponível.');
    const platformOrg = String(platformOrganizationId?.value?.() || '');
    if (!/^[\w-]{1,128}$/.test(platformOrg)) throw new HttpsError('failed-precondition', 'A conta de recebimento da plataforma não está configurada.');
    const connection = (await account(platformOrg).get()).data();
    if (!connection?.active) throw new HttpsError('failed-precondition', 'A conta Mercado Pago da plataforma precisa ser reconectada.');
    const ref = root(org).collection('capacity_purchases').doc();
    const reference = `capacity-${org}-${ref.id}`.slice(0, 120);
    const expiresAt = Date.now() + 30 * 60000;
    const base = { id: ref.id, reference, organization_id: org, created_by: request.auth.uid, seller_id: String(connection.seller_id), package_id: capacityPackage.id, package_name: capacityPackage.name, status: 'creating', amount: capacityPackage.priceCents, appointments: capacityPackage.appointments, reminders: capacityPackage.reminders, expires_at: expiresAt, created_at: stamp(), updated_at: stamp() };
    await ref.set(base);
    try {
      const access = await token(platformOrg);
      const payload = {
        transaction_amount: capacityPackage.priceCents / 100,
        description: `Pacote ${capacityPackage.name} Automichat`.slice(0, 120),
        payment_method_id: 'pix',
        date_of_expiration: new Date(expiresAt).toISOString(),
        payer: { email: String(request.auth.token.email || 'oguilhermereis2003@gmail.com').slice(0, 254) },
        external_reference: reference,
        notification_url: webhook(),
      };
      const payment = (await axios.post(`${API}/v1/payments`, payload, { headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json', 'X-Idempotency-Key': `capacity-${ref.id}` }, timeout: 20000 })).data;
      if (!/^\d+$/.test(String(payment.id || ''))) throw new Error('O Mercado Pago não retornou um pagamento válido.');
      const transactionData = payment.point_of_interaction?.transaction_data || {};
      const update = { status: payment.status === 'approved' ? 'approved' : 'pending', payment_id: String(payment.id), provider_status: String(payment.status || ''), qr_code: String(transactionData.qr_code || ''), qr_code_base64: String(transactionData.qr_code_base64 || ''), ticket_url: String(transactionData.ticket_url || ''), updated_at: stamp() };
      await ref.set(update, { merge: true });
      await db.doc(`mercadopago_payments/${payment.id}`).set({ kind: 'capacity', organizationId: org, purchaseId: ref.id });
      if (payment.status === 'approved') await settleCapacityPurchase(org, ref.id, payment);
      return capacityPublic({ ...base, ...update });
    } catch (error) {
      await ref.set({ status: 'failed', provider_error: String(error.response?.data?.message || error.message).slice(0, 300), updated_at: stamp() }, { merge: true });
      logger.error('Falha ao criar Pix de capacidade', { organizationId: org, status: error.response?.status || null });
      throw new HttpsError('internal', 'Não foi possível gerar o Pix agora. Tente novamente.');
    }
  });
  const getCapacityPurchase = onCall({ region, secrets: oauthSecrets }, async request => {
    const org = await authorize(request);
    const purchaseId = String(request.data?.purchaseId || '');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(purchaseId)) throw new HttpsError('invalid-argument', 'Cobrança inválida.');
    await processCapacityPurchase(org, purchaseId);
    const snapshot = await root(org).collection('capacity_purchases').doc(purchaseId).get();
    if (!snapshot.exists) throw new HttpsError('not-found', 'Cobrança não encontrada.');
    return capacityPublic({ id: snapshot.id, ...snapshot.data() });
  });
  const getPaymentSettings = onCall({ region }, async request => {
    const org = await authorize(request), settings = await policy(org), connection = (await account(org).get()).data();
    return { settings, connected: connection?.active === true, sellerName: connection?.seller_name || '', sellerId: connection?.seller_id || '' };
  });
  const savePaymentSettings = onCall({ region }, async request => {
    const org = await authorize(request); let settings;
    try { settings = normalizePolicy(request.data?.settings); } catch (e) { throw new HttpsError('invalid-argument', e.message); }
    if (settings.mode === 'deposit') await assertFeature(db, org, 'pix', HttpsError);
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
    const org = await authorize(request), state = crypto.randomBytes(32).toString('hex'), pkce = createPkce();
    await assertFeature(db, org, 'pix', HttpsError);
    await db.doc(`mercadopago_oauth_states/${digest(state)}`).set({ organization_id: org, uid: request.auth.uid, code_verifier: pkce.verifier, expires_at: admin.firestore.Timestamp.fromMillis(Date.now() + 10 * 60000) });
    const params = new URLSearchParams({ client_id: clientId.value(), response_type: 'code', platform_id: 'mp', state, redirect_uri: callback(), code_challenge: pkce.challenge, code_challenge_method: 'S256' });
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
      let org, codeVerifier;
      await db.runTransaction(async tx => {
        const ref = db.doc(`mercadopago_oauth_states/${digest(state)}`), data = (await tx.get(ref)).data();
        if (!data || data.used || data.expires_at.toMillis() < Date.now()) throw new Error('Estado expirado.');
        if (!/^[A-Za-z0-9_-]{43,128}$/.test(String(data.code_verifier || ''))) throw new Error('Verificador PKCE ausente.');
        const [company, member] = await Promise.all([tx.get(root(data.organization_id)), tx.get(root(data.organization_id).collection('members').doc(data.uid))]);
        if (company.data()?.proprietario_uid !== data.uid || member.data()?.status !== 'active') throw new Error('Acesso alterado.');
        org = data.organization_id; codeVerifier = data.code_verifier; tx.update(ref, { used: true });
      });
      const { data } = await axios.post(`${API}/oauth/token`, { client_id: clientId.value(), client_secret: clientSecret.value(), grant_type: 'authorization_code', code, redirect_uri: callback(), code_verifier: codeVerifier }, { timeout: 15000 });
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
    } catch (e) { logger.warn('Falha ao conectar Mercado Pago', { status: e.response?.status || null, provider_error: e.response?.data?.error || e.response?.data?.message || null }); return res.status(400).send('Não foi possível conectar. Confira sua conta e inicie uma nova conexão pelo painel.'); }
  });
  async function intent(org, id, appointment, settings) {
    await assertFeature(db, org, 'pix', HttpsError);
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
  async function settle(ref, attempt, payment) {
    const outcome = paymentOutcome(payment, attempt);
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
      tx.update(appointment, { status, payment_status: outcome === 'paid' ? 'paid' : 'expired', paid_cents: outcome === 'paid' ? attempt.amount : 0, payment_provider: 'mercadopago', payment_provider_id: String(payment.id), payment_updated_at: stamp(), updated_at: stamp() });
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
    let payment;
    if (!attempt.paymentId) {
      const result = await axios.post(`${API}/v1/payments`, paymentPayload(attempt, webhook()), { headers: { ...headers, 'Content-Type': 'application/json', 'X-Idempotency-Key': attempt.reference }, timeout: 20000 });
      payment = result.data;
      if (!/^\d+$/.test(String(payment.id || ''))) throw new Error('O Mercado Pago não retornou um pagamento válido.');
      await ref.update({ paymentId: String(payment.id), provider: 'mercadopago', state: 'pending' });
      await db.doc(`mercadopago_payments/${payment.id}`).set({ attemptId: ref.id });
      attempt.paymentId = String(payment.id);
    } else payment = (await axios.get(`${API}/v1/payments/${attempt.paymentId}`, { headers, timeout: 15000 })).data;
    await db.doc(`mercadopago_payments/${attempt.paymentId}`).set({ attemptId: ref.id });
    if (await settle(ref, attempt, payment)) return;
    if (Date.now() >= attempt.expiresAt) {
      let cancelError = null;
      try { await axios.put(`${API}/v1/payments/${payment.id}`, { status: 'cancelled' }, { headers: { ...headers, 'Content-Type': 'application/json' }, timeout: 15000 }); }
      catch (e) { cancelError = e; if (![400, 409].includes(e.response?.status)) throw e; }
      payment = (await axios.get(`${API}/v1/payments/${payment.id}`, { headers, timeout: 15000 })).data;
      if (await settle(ref, attempt, payment)) return;
      if (cancelError) throw cancelError;
      throw new Error('O Mercado Pago ainda não confirmou o cancelamento do Pix.');
    }
    const appointment = (await root(attempt.organizationId).collection('appointments').doc(attempt.appointmentId).get()).data();
    const qr = payment.point_of_interaction?.transaction_data?.qr_code;
    if (!qr || !appointment) return;
    // A short lease prevents concurrent webhook and scheduler sends.
    const claimed = await db.runTransaction(async tx => {
      const fresh = (await tx.get(ref)).data();
      if (!fresh.active || fresh.pix_sent || fresh.send_until > Date.now()) return false;
      tx.update(ref, { send_until: Date.now() + 60000 }); return true;
    });
    if (!claimed) return;
    try {
      const outbound = pixMessage(attempt, appointment, attempt.policy, qr);
      await notify(attempt, appointment, outbound);
      await ref.update({ pix_sent: true });
      await root(attempt.organizationId).collection('appointments').doc(attempt.appointmentId).update({ payment_provider: 'mercadopago', payment_provider_id: String(payment.id) });
    } finally { await ref.update({ send_until: 0 }); }
  }
  async function sendOrderMessage(org, order, body, imageUrl = '') {
    const integration = (await root(org).collection('integrations').doc('whatsapp').get()).data() || {};
    if (!integration.active || !integration.access_token || !integration.phone_number_id || !order.customer_phone) return false;
    const url = `https://graph.facebook.com/${integration.graph_version || 'v24.0'}/${integration.phone_number_id}/messages`;
    if (imageUrl) await axios.post(url, {messaging_product:'whatsapp',to:order.customer_phone,type:'image',image:{link:imageUrl,caption:`Pix do pedido #${order.number || ''} · ${money(order.total_cents)}`}}, {headers:{Authorization:`Bearer ${integration.access_token}`},timeout:15000});
    await axios.post(url, {messaging_product:'whatsapp',to:order.customer_phone,type:'text',text:{preview_url:false,body}}, {headers:{Authorization:`Bearer ${integration.access_token}`},timeout:15000});
    return true;
  }
  async function createOrderPix(org, orderId) {
    const ref = root(org).collection('orders').doc(orderId);
    const snapshot = await ref.get(); const order = snapshot.data();
    if (!order || order.payment?.method !== 'pix') return {status:'not_applicable'};
    if (order.payment?.payment_id) return {status:order.payment.status || 'pending',paymentId:String(order.payment.payment_id)};
    const connection = (await account(org).get()).data();
    if (!connection?.active) throw new Error('Conecte a conta Mercado Pago antes de aceitar pedidos Pix.');
    const reference = `order-${org}-${orderId}`.slice(0,120), expiresAt = Date.now() + 30 * 60000;
    const access = await token(org);
    const payload = {transaction_amount:Number(order.total_cents)/100,description:`Pedido ${order.number || orderId}`.slice(0,120),payment_method_id:'pix',date_of_expiration:new Date(expiresAt).toISOString(),payer:{email:String(order.payment?.customer_email || order.customer?.email || '').slice(0,254)},external_reference:reference,notification_url:webhook()};
    if (!payload.payer.email) throw new Error('O cliente precisa informar um e-mail para gerar o Pix.');
    const payment = (await axios.post(`${API}/v1/payments`,payload,{headers:{Authorization:`Bearer ${access}`,'Content-Type':'application/json','X-Idempotency-Key':`order-${orderId}`},timeout:20000})).data;
    if (!/^\d+$/.test(String(payment.id || ''))) throw new Error('O Mercado Pago não retornou um pagamento válido.');
    const transactionData = payment.point_of_interaction?.transaction_data || {}; let qrImageUrl = '';
    if (transactionData.qr_code_base64) {
      const path = `organizations/${org}/orders/${orderId}/pix.png`, downloadToken = crypto.randomUUID(), bucket = admin.storage().bucket();
      await bucket.file(path).save(Buffer.from(String(transactionData.qr_code_base64),'base64'),{resumable:false,contentType:'image/png',metadata:{cacheControl:'private,max-age=1800',metadata:{firebaseStorageDownloadTokens:downloadToken}}});
      qrImageUrl = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket.name)}/o/${encodeURIComponent(path)}?alt=media&token=${downloadToken}`;
    }
    const update = {method:'pix',status:payment.status === 'approved' ? 'paid' : 'pending',payment_id:String(payment.id),provider_status:String(payment.status || ''),reference,qr_code:String(transactionData.qr_code || ''),qr_image_url:qrImageUrl,ticket_url:String(transactionData.ticket_url || ''),expires_at:admin.firestore.Timestamp.fromMillis(expiresAt)};
    await ref.set({payment:{...order.payment,...update},updated_at:stamp()},{merge:true});
    await db.doc(`mercadopago_payments/${payment.id}`).set({kind:'order',organizationId:org,orderId});
    const text = `Seu pedido foi aceito! Pague ${money(order.total_cents)} via Pix para iniciarmos o preparo.\n\nPix Copia e Cola:\n${transactionData.qr_code}${transactionData.ticket_url ? `\n\nAbrir pagamento: ${transactionData.ticket_url}` : ''}`;
    try { await sendOrderMessage(org,order,text,qrImageUrl); }
    catch (error) { logger.warn('Pix criado, mas o envio pelo WhatsApp falhou', {organizationId:org,orderId,status:error.response?.status || null}); }
    if (payment.status === 'approved') await settleOrderPayment(org,orderId,payment);
    return {status:update.status,paymentId:String(payment.id)};
  }
  async function settleOrderPayment(org, orderId, suppliedPayment) {
    const ref = root(org).collection('orders').doc(orderId), snapshot = await ref.get(), order = snapshot.data();
    if (!order?.payment?.payment_id) return false;
    const access = await token(org), payment = suppliedPayment || (await axios.get(`${API}/v1/payments/${order.payment.payment_id}`,{headers:{Authorization:`Bearer ${access}`},timeout:15000})).data;
    const collectorId = payment.collector_id ?? payment.user_id;
    if (payment.external_reference !== order.payment.reference || Math.round(Number(payment.transaction_amount)*100) !== Number(order.total_cents) || payment.currency_id !== 'BRL' || String(collectorId) !== String((await account(org).get()).data()?.seller_id)) throw new Error('A cobrança não corresponde ao pedido.');
    if (payment.status !== 'approved') { await ref.set({payment:{...order.payment,provider_status:String(payment.status || ''),status:['rejected','cancelled','canceled','refunded'].includes(payment.status)?'failed':'pending'},updated_at:stamp()},{merge:true}); return false; }
    if (order.payment.status === 'paid') return true;
    const statusUpdate = order.status === 'confirmed' ? {status:'preparing',status_history:admin.firestore.FieldValue.arrayUnion({status:'preparing',source:'mercadopago',at:admin.firestore.Timestamp.now()})} : {};
    await ref.set({payment:{...order.payment,status:'paid',provider_status:'approved',paid_at:stamp()},...statusUpdate,updated_at:stamp()},{merge:true});
    await sendOrderMessage(org,order,'Pagamento Pix confirmado! ✅ Seu pedido entrou em preparo.');
    return true;
  }
  const mercadoPagoWebhook = onRequest({ region, invoker: 'public', secrets: [...oauthSecrets, webhookSecret], timeoutSeconds: 60 }, async (req, res) => {
    if (req.method !== 'POST') return res.sendStatus(405);
    let body;
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); }
    catch { return res.sendStatus(400); }
    const type = String(body.type || req.query.type || req.query.topic || '');
    const id = String(req.query['data.id'] || req.query.id || body.data?.id || '');
    if (type && type !== 'payment') return res.sendStatus(200);
    if (!/^\d+$/.test(id) || !validSignature(id, req.get('x-request-id'), req.get('x-signature'), webhookSecret.value())) return res.sendStatus(401);
    try {
      const map = (await db.doc(`mercadopago_payments/${id}`).get()).data();
      if (map?.kind === 'capacity') await processCapacityPurchase(map.organizationId, map.purchaseId);
      else if (map?.kind === 'order') await settleOrderPayment(map.organizationId, map.orderId);
      else if (map) await processAttempt(db.doc(`payment_attempts/${map.attemptId}`));
      return res.sendStatus(200);
    } catch (e) { logger.error('Falha ao conciliar pagamento', { paymentId: id, status: e.response?.status || null }); return res.sendStatus(500); }
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
          } catch (e) { logger.warn('Pagamento aguardando nova conciliação', { attemptId: doc.id, status: e.response?.status || null }); }
        }
        if (page.size < 100) break;
      } while (cursor);
    }
  });
  return { functions: { getPaymentSettings, savePaymentSettings, connectMercadoPago, disconnectMercadoPago, createCapacityPurchase, getCapacityPurchase, mercadoPagoOAuthCallback, mercadoPagoWebhook, reconcileMercadoPagoOrders }, policy, intent, processAttempt, createOrderPix, quote, setOnPaid: fn => { onPaid = fn; }, oauthSecrets };
}
module.exports = { createMercadoPago, seal, unseal, validSignature, paymentPayload, paymentOutcome, pixMessage, createPkce };
