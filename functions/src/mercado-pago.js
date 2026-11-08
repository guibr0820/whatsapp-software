const crypto = require('node:crypto');
const { normalizePolicy, quote } = require('./payment-policy');
const { assertFeature, withAutomatedMessage } = require('./plan-limits');
const { packagePublic } = require('./capacity-packages');
const { normalizeOrderPaymentPolicy } = require('./order-payment-policy');
const region = 'southamerica-east1';
const API = 'https://api.mercadopago.com';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function createPkce() {
  const verifier = crypto.randomBytes(64).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}
const money = cents => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
function planChangeProration({ currentPrice, targetPrice, nextDueAt, now = Date.now() }) {
  const currentCents = Math.max(0, Math.round(Number(currentPrice || 0) * 100));
  const targetCents = Math.max(0, Math.round(Number(targetPrice || 0) * 100));
  const cycleMs = 30 * 86400000;
  const remainingMs = Math.max(0, Math.min(cycleMs, Number(nextDueAt || 0) - now));
  const remainingRatio = remainingMs / cycleMs;
  const currentCreditCents = Math.round(currentCents * remainingRatio);
  const targetPeriodCents = Math.round(targetCents * remainingRatio);
  return { currentCreditCents, targetPeriodCents, amountDueCents:Math.max(0,targetPeriodCents-currentCreditCents), remainingDays:Math.ceil(remainingMs/86400000), nextDueAt:Number(nextDueAt || 0) };
}
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
function timestampMillis(value) {
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
}
function orderPaymentExpiryMillis(order = {}) {
  const explicit = timestampMillis(order.payment?.expires_at);
  if (explicit) return explicit;
  const created = timestampMillis(order.payment?.created_at) || timestampMillis(order.updated_at) || timestampMillis(order.created_at);
  return created ? created + 15 * 60 * 1000 : 0;
}
function isOrderPaymentExpired(order = {}, now = Date.now()) {
  return order.status === 'awaiting_payment' && order.payment?.status !== 'paid' && orderPaymentExpiryMillis(order) > 0 && orderPaymentExpiryMillis(order) <= now;
}
function createMercadoPago({ admin, db, axios, logger, onCall, onRequest, onSchedule, HttpsError, secrets, params = {} }) {
  const { clientId, clientSecret, encryptionKey, webhookSecret } = secrets;
  const { platformOrganizationId } = params;
  const oauthSecrets = [clientId, clientSecret, encryptionKey];
  const root = org => db.doc(`organizations/${org}`);
  const account = org => root(org).collection('integrations').doc('mercadopago');
  const policyRef = org => root(org).collection('payment_settings').doc('booking');
  const orderPolicyRef = org => root(org).collection('payment_settings').doc('orders');
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
  async function paymentContext(org) {
    const [organization, segments] = await Promise.all([root(org).get(), db.collection('app_segments').get()]);
    const segmentValue = String(organization.data()?.segmento || '').trim();
    const segment = segments.docs.find(document => document.id === segmentValue || String(document.data()?.name || '') === segmentValue);
    const screens = Array.isArray(segment?.data()?.screens) ? segment.data().screens : [];
    return { bookingEnabled: screens.includes('payments') && screens.includes('appointments'), orderEnabled: screens.includes('payments') && screens.includes('orders') };
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
    const org = await authorize(request), [settings, orderSettingsSnapshot, connection, context] = await Promise.all([policy(org), orderPolicyRef(org).get(), account(org).get(), paymentContext(org)]);
    return { settings, orderSettings: normalizeOrderPaymentPolicy(orderSettingsSnapshot.data() || {}), context, connected: connection.data()?.active === true, sellerName: connection.data()?.seller_name || '', sellerId: connection.data()?.seller_id || '' };
  });
  const billingRef = org => root(org).collection('billing').doc('subscription');
  const saoPauloMonthKey=()=>{const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit'}).formatToParts(new Date()).filter(item=>item.type!=='literal').map(item=>[item.type,item.value]));return `${parts.year}-${parts.month}`;};
  async function planForCheckout(planId) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(planId || ''))) throw new HttpsError('invalid-argument','Plano inválido.');
    const snapshot = await db.doc(`plans/${planId}`).get(), data = snapshot.data();
    if (!snapshot.exists || data?.active === false || !(Number(data?.price) > 0)) throw new HttpsError('failed-precondition','Este plano não está disponível.');
    return { id:snapshot.id, name:String(data.name || snapshot.id).slice(0,100), price:Number(data.price), priceCents:Math.round(Number(data.price)*100) };
  }
  async function planForFreeAccess(planId) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(planId || ''))) throw new HttpsError('invalid-argument','Plano inválido.');
    const snapshot=await db.doc(`plans/${planId}`).get(), data=snapshot.data();
    if (!snapshot.exists || data?.active === false || (data?.freeTrial !== true && Number(data?.price) !== 0)) throw new HttpsError('failed-precondition','Este plano não possui acesso gratuito.');
    return {id:snapshot.id,name:String(data.name || snapshot.id).slice(0,100),price:Number(data.price || 0),freeTrial:data?.freeTrial === true};
  }
  async function activatePlan(org, uid, plan, source, providerId) {
    await db.runTransaction(async tx => {
      const companyRef=root(org), userRef=db.doc(`users/${uid}`), company=await tx.get(companyRef);
      if (!company.exists || company.data().proprietario_uid !== uid) throw new HttpsError('permission-denied','A empresa não pertence a esta conta.');
      tx.set(companyRef,{plano_id:plan.id,plano_nome:plan.name,plano_preco:plan.price,status:'active',billing_source:source,billing_provider_id:String(providerId || ''),billing_updated_at:stamp(),atualizado_em:stamp()},{merge:true});
      tx.set(userRef,{onboarding_concluido:true,atualizado_em:stamp()},{merge:true});
    });
  }
  async function platformAccess() {
    const platformOrg=String(platformOrganizationId?.value?.() || '');
    if (!/^[\w-]{1,128}$/.test(platformOrg)) throw new HttpsError('failed-precondition','A conta de recebimento da plataforma não está configurada.');
    return { access:await token(platformOrg), connection:(await account(platformOrg).get()).data() || {} };
  }
  async function planChangeContext(org, targetId) {
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(String(targetId || ''))) throw new HttpsError('invalid-argument','Plano inválido.');
    const [companySnapshot,targetSnapshot,billingSnapshot]=await Promise.all([root(org).get(),db.doc(`plans/${targetId}`).get(),billingRef(org).get()]);
    const company=companySnapshot.data() || {}, target=targetSnapshot.data(), billing=billingSnapshot.data() || {};
    if(!targetSnapshot.exists || target?.active===false) throw new HttpsError('not-found','Plano indisponível.');
    let nextDueAt=billing.next_due_at?.toMillis?.() || 0;
    if(billing.method==='card' && billing.provider_subscription_id){
      try{const {access}=await platformAccess();const subscription=(await axios.get(`${API}/preapproval/${billing.provider_subscription_id}`,{headers:{Authorization:`Bearer ${access}`},timeout:15000})).data;nextDueAt=new Date(subscription.next_payment_date || nextDueAt || Date.now()+30*86400000).getTime();}
      catch(error){logger.warn('Não foi possível atualizar a data da assinatura para a troca de plano',{organizationId:org,status:error.response?.status || null});}
    }
    if(!nextDueAt) nextDueAt=Date.now()+30*86400000;
    const plan={id:targetSnapshot.id,name:String(target.name || targetSnapshot.id).slice(0,100),price:Number(target.price || 0),priceCents:Math.round(Number(target.price || 0)*100)};
    const currentPrice=Number(company.plano_preco || 0), type=plan.price<currentPrice?'downgrade':plan.price>currentPrice?'upgrade':'lateral';
    return {company,plan,billing,nextDueAt,type,quote:planChangeProration({currentPrice,targetPrice:plan.price,nextDueAt})};
  }
  async function settlePlanUpgrade(org,billing,payment){
    const pending=billing.pending_upgrade || {}, {connection,access}=await platformAccess(), collector=payment.collector_id ?? payment.user_id;
    if(!pending.reference || payment.external_reference!==pending.reference || Math.round(Number(payment.transaction_amount)*100)!==Number(pending.amount_cents) || payment.currency_id!=='BRL' || String(collector)!==String(connection.seller_id)) throw new Error('Pagamento do upgrade inconsistente.');
    if(payment.status!=='approved'){await billingRef(org).set({pending_upgrade:{...pending,status:['rejected','cancelled','canceled'].includes(payment.status)?'failed':'pending',provider_status:String(payment.status || ''),updated_at:stamp()}},{merge:true});return false;}
    if(pending.status==='paid') return true;
    const target=await planForCheckout(pending.plan_id);
    if(billing.method==='card' && billing.provider_subscription_id) await axios.put(`${API}/preapproval/${billing.provider_subscription_id}`,{reason:`Plano ${target.name} Automichat`.slice(0,120),auto_recurring:{transaction_amount:target.price,currency_id:'BRL'}},{headers:{Authorization:`Bearer ${access}`,'Content-Type':'application/json'},timeout:15000});
    await activatePlan(org,billing.owner_uid,target,billing.method,billing.provider_subscription_id || billing.payment_id || '');
    await billingRef(org).set({plan_id:target.id,plan_name:target.name,amount:target.priceCents,pending_upgrade:{...pending,status:'paid',provider_status:'approved',payment_id:String(payment.id),paid_at:stamp(),updated_at:stamp()},updated_at:stamp()},{merge:true});
    return true;
  }
  async function settleCardSubscription(org, billing) {
    const {access}=await platformAccess();
    const subscription=(await axios.get(`${API}/preapproval/${billing.provider_subscription_id}`,{headers:{Authorization:`Bearer ${access}`},timeout:15000})).data;
    const invoices=(await axios.get(`${API}/authorized_payments/search`,{params:{preapproval_id:billing.provider_subscription_id,limit:20},headers:{Authorization:`Bearer ${access}`},timeout:15000})).data?.results || [];
    const paid=invoices.find(item=>['processed','approved'].includes(String(item.status || '').toLowerCase()));
    const status=paid?'active':String(subscription.status || 'pending');
    const nextDueAt=new Date(subscription.next_payment_date || 0).getTime();
    await billingRef(org).set({status,last_invoice_id:String(paid?.id || ''),...(Number.isFinite(nextDueAt)&&nextDueAt>0?{next_due_at:admin.firestore.Timestamp.fromMillis(nextDueAt)}:{}),updated_at:stamp()},{merge:true});
    if(paid) await activatePlan(org,billing.owner_uid,await planForCheckout(billing.plan_id),'card',subscription.id);
    return status;
  }
  async function settlePlanPix(org, billing, payment) {
    const {connection}=await platformAccess(), collector=payment.collector_id ?? payment.user_id;
    if (payment.external_reference !== billing.external_reference || Math.round(Number(payment.transaction_amount)*100)!==Number(billing.amount) || payment.currency_id!=='BRL' || String(collector)!==String(connection.seller_id)) throw new Error('Pagamento do plano inconsistente.');
    if (payment.status !== 'approved') { await billingRef(org).set({status:['rejected','cancelled','canceled'].includes(payment.status)?'failed':'pending',provider_status:String(payment.status || ''),updated_at:stamp()},{merge:true}); return false; }
    const plan=await planForCheckout(billing.plan_id); await activatePlan(org,billing.owner_uid,plan,'pix',payment.id);
    await billingRef(org).set({status:'active',paid_at:stamp(),next_due_at:admin.firestore.Timestamp.fromMillis(Date.now()+30*86400000),updated_at:stamp()},{merge:true}); return true;
  }
  const getPlanCheckoutStatus = onCall({ region, secrets:oauthSecrets }, async request => {
    const org=await authorize(request), current=(await billingRef(org).get()).data() || {};
    if(current.pending_upgrade?.payment_id && ['pending','approved'].includes(current.pending_upgrade?.status)){const {access}=await platformAccess();const payment=(await axios.get(`${API}/v1/payments/${current.pending_upgrade.payment_id}`,{headers:{Authorization:`Bearer ${access}`},timeout:15000})).data;await settlePlanUpgrade(org,current,payment);}
    if (current.method === 'pix' && current.payment_id && current.status === 'pending') { const {access}=await platformAccess(); const payment=(await axios.get(`${API}/v1/payments/${current.payment_id}`,{headers:{Authorization:`Bearer ${access}`},timeout:15000})).data; await settlePlanPix(org,current,payment); }
    if (current.method === 'card' && current.provider_subscription_id && current.status !== 'active') await settleCardSubscription(org,current);
    const fresh=(await billingRef(org).get()).data() || {};
    return {status:fresh.pending_upgrade?.status==='paid'?'active':fresh.pending_upgrade?.status || fresh.status || 'none',method:fresh.method || '',planId:fresh.plan_id || '',planName:fresh.plan_name || '',amount:Number(fresh.amount || 0),qrCode:fresh.pending_upgrade?.qr_code || fresh.qr_code || '',qrCodeBase64:fresh.pending_upgrade?.qr_code_base64 || fresh.qr_code_base64 || '',ticketUrl:fresh.pending_upgrade?.ticket_url || fresh.ticket_url || '',expiresAt:fresh.pending_upgrade?.expires_at?.toMillis?.() || fresh.expires_at?.toMillis?.() || 0};
  });
  const getPlanChangeOptions = onCall({ region, secrets:oauthSecrets }, async request => {
    const org=await authorize(request), [company,plans,billing,usage]=await Promise.all([root(org).get(),db.collection('plans').get(),billingRef(org).get(),root(org).collection('usage').doc(saoPauloMonthKey()).get()]);
    const data=company.data(), bill=billing.data() || {}, used=usage.data() || {};let nextDueAt=bill.next_due_at?.toMillis?.() || 0;
    if(bill.method==='card'&&bill.provider_subscription_id){try{const {access}=await platformAccess();const subscription=(await axios.get(`${API}/preapproval/${bill.provider_subscription_id}`,{headers:{Authorization:`Bearer ${access}`},timeout:15000})).data;nextDueAt=new Date(subscription.next_payment_date || nextDueAt).getTime()||nextDueAt;}catch{}}
    const currentPrice=Number(data.plano_preco || 0);
    return {current:{id:data.plano_id || '',name:data.plano_nome || 'Sem plano',price:currentPrice,status:data.status || '',trialEndsAt:data.trial_ends_at?.toMillis?.() || 0},billing:{method:bill.method || data.billing_source || '',status:bill.status || '',nextDueAt,pendingPlanId:bill.pending_plan_id || '',pendingEffectiveAt:bill.pending_effective_at?.toMillis?.() || 0},usage:{appointments:Number(used.appointments || 0),messages:Number(used.reminders || 0)},plans:plans.docs.map(item=>{const plan={id:item.id,name:String(item.data().name || item.id),title:String(item.data().title || ''),description:String(item.data().description || ''),subtitle:String(item.data().subtitle || ''),features:Array.isArray(item.data().features)?item.data().features:null,price:Number(item.data().price || 0),prefer:item.data().prefer === true,freeTrial:item.data().freeTrial === true,active:item.data().active !== false,limits:item.data().limits || {}};const type=plan.price<currentPrice?'downgrade':plan.price>currentPrice?'upgrade':'lateral';return{...plan,change:{type,...planChangeProration({currentPrice,targetPrice:plan.price,nextDueAt:nextDueAt||Date.now()+30*86400000})}};}).filter(item=>item.active).sort((a,b)=>a.price-b.price)};
  });
  const changeOwnerPlan = onCall({ region, secrets:oauthSecrets }, async request => {
    const org=await authorize(request), targetId=String(request.data?.planId || '');
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(targetId))throw new HttpsError('invalid-argument','Plano inválido.');
    const {company:current,plan:targetPlan,billing,nextDueAt,type,quote}=await planChangeContext(org,targetId);
    if(current.plano_id===targetId)throw new HttpsError('already-exists','Este já é o plano atual.');
    if(current.status==='trial' || !['card','pix'].includes(billing.method) || billing.status!=='active')return {checkoutRequired:true,mode:'subscription',planId:targetId};
    if(type==='upgrade'&&quote.amountDueCents>0)return {checkoutRequired:true,mode:'upgrade',planId:targetId,quote};
    const billingUpdate={amount:targetPlan.priceCents,updated_at:stamp()};
    if(type==='downgrade'){if(billing.method==='card'&&billing.provider_subscription_id){const {access}=await platformAccess();await axios.put(`${API}/preapproval/${billing.provider_subscription_id}`,{reason:`Plano ${targetPlan.name} Automichat`.slice(0,120),auto_recurring:{transaction_amount:targetPlan.price,currency_id:'BRL'}},{headers:{Authorization:`Bearer ${access}`,'Content-Type':'application/json'},timeout:15000});}Object.assign(billingUpdate,{pending_plan_id:targetPlan.id,pending_plan_name:targetPlan.name,pending_plan_price:targetPlan.price,pending_effective_at:admin.firestore.Timestamp.fromMillis(nextDueAt)});await billingRef(org).set(billingUpdate,{merge:true});return {changed:true,scheduled:true,effectiveAt:nextDueAt};}
    await activatePlan(org,request.auth.uid,targetPlan,billing.method,billing.provider_subscription_id || billing.payment_id || '');
    await billingRef(org).set({...billingUpdate,plan_id:targetPlan.id,plan_name:targetPlan.name,pending_plan_id:admin.firestore.FieldValue.delete(),pending_plan_name:admin.firestore.FieldValue.delete(),pending_plan_price:admin.firestore.FieldValue.delete(),pending_effective_at:admin.firestore.FieldValue.delete()},{merge:true});
    return {changed:true,scheduled:false,effectiveAt:Date.now()};
  });
  const activatePlanFreeAccess = onCall({ region }, async request => {
    const org=await authorize(request), plan=await planForFreeAccess(request.data?.planId), now=Date.now(), trialEndsAt=admin.firestore.Timestamp.fromMillis(now+14*86400000);
    await db.runTransaction(async tx=>{
      const companyRef=root(org), userRef=db.doc(`users/${request.auth.uid}`), company=await tx.get(companyRef);
      if (!company.exists || company.data().proprietario_uid !== request.auth.uid) throw new HttpsError('permission-denied','A empresa não pertence a esta conta.');
      if (plan.freeTrial && company.data().trial_used === true) throw new HttpsError('already-exists','O teste grátis desta empresa já foi utilizado.');
      if (company.data().status === 'active' && Number(company.data().plano_preco || 0) > 0) throw new HttpsError('failed-precondition','Já existe uma assinatura ativa.');
      const status=plan.freeTrial?'trial':'active';
      const update={plano_id:plan.id,plano_nome:plan.name,plano_preco:plan.price,status,billing_source:plan.freeTrial?'free_trial':'free_plan',billing_updated_at:stamp(),atualizado_em:stamp()};
      if(plan.freeTrial){update.trial_used=true;update.trial_started_at=stamp();update.trial_ends_at=trialEndsAt;}
      tx.set(companyRef,update,{merge:true});
      tx.set(userRef,{onboarding_concluido:true,atualizado_em:stamp()},{merge:true});
    });
    return {status:plan.freeTrial?'trial':'active',trialEndsAt:plan.freeTrial?trialEndsAt.toMillis():0};
  });
  const createPlanCardSubscription = onCall({ region, secrets:oauthSecrets }, async request => {
    const org=await authorize(request), plan=await planForCheckout(request.data?.planId), cardToken=String(request.data?.cardToken || ''), email=String(request.auth.token.email || '').toLowerCase();
    if (!/^[A-Za-z0-9_-]{20,300}$/.test(cardToken) || !email || email.length>254) throw new HttpsError('invalid-argument','Dados de pagamento inválidos.');
    const existing=(await billingRef(org).get()).data(); if (existing?.status === 'active') throw new HttpsError('already-exists','Já existe uma assinatura ativa.');
    const checkoutId=crypto.randomUUID(), reference=`plan-${org}-${checkoutId}`.slice(0,120), {access}=await platformAccess();
    try {
      await db.runTransaction(async tx=>{const fresh=(await tx.get(billingRef(org))).data();if(fresh?.status==='creating' && fresh.create_until?.toMillis?.()>Date.now())throw new HttpsError('aborted','Uma assinatura já está sendo criada. Aguarde alguns segundos.');tx.set(billingRef(org),{method:'card',status:'creating',create_until:admin.firestore.Timestamp.fromMillis(Date.now()+120000),owner_uid:request.auth.uid,updated_at:stamp()},{merge:true});});
      const subscription=(await axios.post(`${API}/preapproval`,{reason:`Plano ${plan.name} Automichat`.slice(0,120),external_reference:reference,payer_email:email,card_token_id:cardToken,auto_recurring:{frequency:1,frequency_type:'months',transaction_amount:plan.price,currency_id:'BRL'},back_url:'https://automichat.com/plans.html?pagamento=retorno',status:'authorized'}, {headers:{Authorization:`Bearer ${access}`,'Content-Type':'application/json','X-Idempotency-Key':checkoutId},timeout:20000})).data;
      if (!/^[A-Za-z0-9_-]{10,128}$/.test(String(subscription.id || ''))) throw new Error('Assinatura inválida.');
      await billingRef(org).set({method:'card',status:String(subscription.status || 'pending'),provider_subscription_id:String(subscription.id),external_reference:reference,plan_id:plan.id,plan_name:plan.name,amount:plan.priceCents,payer_email:email,owner_uid:request.auth.uid,created_at:stamp(),updated_at:stamp()});
      await db.doc(`mercadopago_subscriptions/${subscription.id}`).set({organizationId:org,uid:request.auth.uid,planId:plan.id});
      return {status:String(subscription.status || 'pending')};
    } catch(error) {
      await billingRef(org).set({status:'failed',create_until:admin.firestore.Timestamp.fromMillis(0),updated_at:stamp()},{merge:true}).catch(()=>{});
      const providerMessage=String(error.response?.data?.message || ''), providerCode=String(error.response?.data?.code || error.response?.data?.cause?.[0]?.code || '');
      logger.warn('Falha ao criar assinatura',{organizationId:org,status:error.response?.status || null,providerCode:providerCode.slice(0,40)});
      if(error instanceof HttpsError)throw error;
      if(/CC_VAL_433|credit card validation has failed/i.test(`${providerCode} ${providerMessage}`)) throw new HttpsError('failed-precondition','Não foi possível validar este cartão para cobrança recorrente. Confira titular, CPF, validade e CVV ou tente outro cartão de crédito. Você também pode pagar por Pix.');
      throw new HttpsError('failed-precondition','O cartão não foi autorizado. Confira os dados, tente outro cartão de crédito ou escolha Pix.');
    }
  });
  const createPlanPixPayment = onCall({ region, secrets:oauthSecrets }, async request => {
    const org=await authorize(request), plan=await planForCheckout(request.data?.planId), email=String(request.auth.token.email || '').toLowerCase();
    if (!email || email.length>254) throw new HttpsError('invalid-argument','E-mail do pagador inválido.');
    const existing=(await billingRef(org).get()).data(); if (existing?.status === 'active') throw new HttpsError('already-exists','Já existe uma assinatura ativa.');
    if (existing?.method === 'pix' && existing?.status === 'pending' && existing?.expires_at?.toMillis?.() > Date.now()) return {status:'pending',qrCode:existing.qr_code || '',qrCodeBase64:existing.qr_code_base64 || '',ticketUrl:existing.ticket_url || '',expiresAt:existing.expires_at.toMillis()};
    const checkoutId=crypto.randomUUID(), reference=`plan-${org}-${checkoutId}`.slice(0,120), expiresAt=Date.now()+30*60000, {access}=await platformAccess();
    try {
      const payment=(await axios.post(`${API}/v1/payments`,{transaction_amount:plan.price,description:`Plano ${plan.name} Automichat`.slice(0,120),payment_method_id:'pix',date_of_expiration:new Date(expiresAt).toISOString(),payer:{email},external_reference:reference,notification_url:webhook()}, {headers:{Authorization:`Bearer ${access}`,'Content-Type':'application/json','X-Idempotency-Key':checkoutId},timeout:20000})).data;
      if (!/^\d+$/.test(String(payment.id || ''))) throw new Error('Pagamento inválido.'); const qr=payment.point_of_interaction?.transaction_data || {};
      const data={method:'pix',status:payment.status === 'approved'?'approved':'pending',payment_id:String(payment.id),external_reference:reference,plan_id:plan.id,plan_name:plan.name,amount:plan.priceCents,payer_email:email,owner_uid:request.auth.uid,qr_code:String(qr.qr_code || ''),qr_code_base64:String(qr.qr_code_base64 || ''),ticket_url:String(qr.ticket_url || ''),expires_at:admin.firestore.Timestamp.fromMillis(expiresAt),created_at:stamp(),updated_at:stamp()};
      await billingRef(org).set(data); await db.doc(`mercadopago_payments/${payment.id}`).set({kind:'plan_pix',organizationId:org}); if (payment.status === 'approved') await settlePlanPix(org,data,payment);
      return {status:data.status,qrCode:data.qr_code,qrCodeBase64:data.qr_code_base64,ticketUrl:data.ticket_url,expiresAt};
    } catch(error) { logger.warn('Falha ao criar Pix do plano',{organizationId:org,status:error.response?.status || null}); throw new HttpsError('unavailable','Não foi possível gerar o Pix agora. Tente novamente.'); }
  });
  const createPlanUpgradePixPayment = onCall({region,secrets:oauthSecrets},async request=>{
    const org=await authorize(request), context=await planChangeContext(org,request.data?.planId), email=String(request.auth.token.email || '').toLowerCase();
    if(context.type!=='upgrade'||context.quote.amountDueCents<=0||context.billing.status!=='active')throw new HttpsError('failed-precondition','Este upgrade não precisa de cobrança proporcional.');
    const existing=context.billing.pending_upgrade || {};if(existing.plan_id===context.plan.id&&(existing.status==='approved'||(existing.status==='pending'&&existing.expires_at?.toMillis?.()>Date.now())))return{status:existing.status,qrCode:existing.qr_code||'',qrCodeBase64:existing.qr_code_base64||'',ticketUrl:existing.ticket_url||'',expiresAt:existing.expires_at?.toMillis?.()||0};
    const checkoutId=crypto.randomUUID(),reference=`upgrade-${org}-${checkoutId}`.slice(0,120),expiresAt=Date.now()+30*60000,{access}=await platformAccess();
    try{const payment=(await axios.post(`${API}/v1/payments`,{transaction_amount:context.quote.amountDueCents/100,description:`Upgrade para ${context.plan.name} Automichat`.slice(0,120),payment_method_id:'pix',date_of_expiration:new Date(expiresAt).toISOString(),payer:{email},external_reference:reference,notification_url:webhook()},{headers:{Authorization:`Bearer ${access}`,'Content-Type':'application/json','X-Idempotency-Key':checkoutId},timeout:20000})).data;if(!/^\d+$/.test(String(payment.id||'')))throw new Error('Pagamento inválido.');const qr=payment.point_of_interaction?.transaction_data||{},pending={plan_id:context.plan.id,plan_name:context.plan.name,plan_price:context.plan.price,amount_cents:context.quote.amountDueCents,credit_cents:context.quote.currentCreditCents,remaining_days:context.quote.remainingDays,next_due_at:admin.firestore.Timestamp.fromMillis(context.nextDueAt),reference,payment_id:String(payment.id),status:payment.status==='approved'?'approved':'pending',provider_status:String(payment.status||''),qr_code:String(qr.qr_code||''),qr_code_base64:String(qr.qr_code_base64||''),ticket_url:String(qr.ticket_url||''),expires_at:admin.firestore.Timestamp.fromMillis(expiresAt),created_at:stamp(),updated_at:stamp()};await billingRef(org).set({pending_upgrade:pending},{merge:true});await db.doc(`mercadopago_payments/${payment.id}`).set({kind:'plan_upgrade',organizationId:org});if(payment.status==='approved')await settlePlanUpgrade(org,{...context.billing,pending_upgrade:pending},payment);return{status:pending.status,qrCode:pending.qr_code,qrCodeBase64:pending.qr_code_base64,ticketUrl:pending.ticket_url,expiresAt};}catch(error){logger.warn('Falha ao criar Pix proporcional do upgrade',{organizationId:org,status:error.response?.status||null});throw new HttpsError('unavailable','Não foi possível gerar a cobrança proporcional agora.');}
  });
  const createPlanUpgradeCardPayment = onCall({region,secrets:oauthSecrets},async request=>{
    const org=await authorize(request),context=await planChangeContext(org,request.data?.planId),tokenId=String(request.data?.cardToken||''),paymentMethodId=String(request.data?.paymentMethodId||''),issuerId=String(request.data?.issuerId||''),email=String(request.auth.token.email||'').toLowerCase(),identificationType=String(request.data?.identificationType||'CPF'),identificationNumber=String(request.data?.identificationNumber||'').replace(/\D/g,'');
    if(context.type!=='upgrade'||context.quote.amountDueCents<=0||context.billing.status!=='active')throw new HttpsError('failed-precondition','Este upgrade não precisa de cobrança proporcional.');
    if(!/^[A-Za-z0-9_-]{20,300}$/.test(tokenId)||!paymentMethodId||!email)throw new HttpsError('invalid-argument','Dados de pagamento inválidos.');
    const existing=context.billing.pending_upgrade || {};if(existing.plan_id===context.plan.id&&['pending','approved'].includes(existing.status))return{status:existing.status,reused:true};
    const checkoutId=crypto.randomUUID(),reference=`upgrade-${org}-${checkoutId}`.slice(0,120),{access}=await platformAccess();
    try{const payload={transaction_amount:context.quote.amountDueCents/100,token:tokenId,description:`Upgrade para ${context.plan.name} Automichat`.slice(0,120),installments:1,payment_method_id:paymentMethodId,payer:{email,...(identificationNumber?{identification:{type:identificationType,number:identificationNumber}}:{})},external_reference:reference,notification_url:webhook()};if(issuerId)payload.issuer_id=issuerId;const payment=(await axios.post(`${API}/v1/payments`,payload,{headers:{Authorization:`Bearer ${access}`,'Content-Type':'application/json','X-Idempotency-Key':checkoutId},timeout:20000})).data;if(!/^\d+$/.test(String(payment.id||'')))throw new Error('Pagamento inválido.');const pending={plan_id:context.plan.id,plan_name:context.plan.name,plan_price:context.plan.price,amount_cents:context.quote.amountDueCents,credit_cents:context.quote.currentCreditCents,remaining_days:context.quote.remainingDays,next_due_at:admin.firestore.Timestamp.fromMillis(context.nextDueAt),reference,payment_id:String(payment.id),status:payment.status==='approved'?'approved':'pending',provider_status:String(payment.status||''),created_at:stamp(),updated_at:stamp()};await billingRef(org).set({pending_upgrade:pending},{merge:true});await db.doc(`mercadopago_payments/${payment.id}`).set({kind:'plan_upgrade',organizationId:org});if(payment.status==='approved')await settlePlanUpgrade(org,{...context.billing,pending_upgrade:pending},payment);if(['rejected','cancelled','canceled'].includes(payment.status))throw new Error('Pagamento não aprovado.');return{status:String(payment.status||'pending')};}catch(error){logger.warn('Falha no cartão proporcional do upgrade',{organizationId:org,status:error.response?.status||null});throw new HttpsError('failed-precondition',error.response?.data?.message||error.message||'O cartão não foi autorizado.');}
  });
  const savePaymentSettings = onCall({ region }, async request => {
    const org = await authorize(request), context = await paymentContext(org), connection = (await account(org).get()).data() || {};
    let settings = null, orderSettings = null;
    if (request.data?.settings) {
      if (!context.bookingEnabled) throw new HttpsError('failed-precondition', 'As configurações de agendamento não estão habilitadas para este segmento.');
      try { settings = normalizePolicy(request.data.settings); } catch (e) { throw new HttpsError('invalid-argument', e.message); }
    }
    if (request.data?.orderSettings) {
      if (!context.orderEnabled) throw new HttpsError('failed-precondition', 'Os pagamentos de pedidos não estão habilitados para este segmento.');
      try { orderSettings = normalizeOrderPaymentPolicy(request.data.orderSettings); } catch (e) { throw new HttpsError('invalid-argument', e.message); }
    }
    if (!settings && !orderSettings) throw new HttpsError('invalid-argument', 'Nenhuma configuração de pagamento foi informada.');
    const usesOnlinePayment = settings?.mode === 'deposit' || Boolean(orderSettings && Object.values(orderSettings).some(rule => rule.allowPix || rule.allowOnlineCard));
    if (usesOnlinePayment) await assertFeature(db, org, 'pix', HttpsError);
    if (usesOnlinePayment && !connection.active) throw new HttpsError('failed-precondition', 'Conecte sua conta Mercado Pago antes de aceitar pagamentos online.');
    if (settings?.mode === 'deposit') {
      const menu = (await root(org).collection('automation_configs').doc('booking_menu').get()).data();
      const flow = menu?.flow_id ? (await root(org).collection('flow_configs').doc(menu.flow_id).get()).data() : null;
      if (!menu?.active || !flow?.active || flow.payment_schema_version !== 2) throw new HttpsError('failed-precondition', 'Primeiro crie e salve uma nova versão do Flow em Automações. Os Flows antigos ainda não têm a etapa de pagamento.');
    }
    const writes = [];
    if (settings) writes.push(policyRef(org).set({ ...settings, updated_at: stamp(), updated_by: request.auth.uid }));
    if (orderSettings) writes.push(orderPolicyRef(org).set({ ...orderSettings, updated_at: stamp(), updated_by: request.auth.uid }));
    await Promise.all(writes);
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
      const pendingOrders = await tx.get(root(org).collection('orders').where('payment.status', '==', 'pending').limit(1));
      if (!pendingOrders.empty) throw new HttpsError('failed-precondition', 'Aguarde a conclusão dos pedidos com pagamento pendente antes de desconectar.');
      await tx.get(account(org));
      tx.set(account(org), { active: false, disconnected_at: stamp() });
      tx.set(policyRef(org), { mode: 'onsite', updated_at: stamp() }, { merge: true });
      tx.set(orderPolicyRef(org), normalizeOrderPaymentPolicy({delivery:{allowPix:false,allowOnlineCard:false},pickup:{allowPix:false,allowOnlineCard:false},dine_in:{allowPix:false,allowOnlineCard:false}}), { merge: true });
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
    const result = await withAutomatedMessage({db,admin,organizationId:attempt.organizationId,HttpsError,reference:`appointment_pix_${attempt.reference}`,send:async()=>{const sent=await axios.post(`https://graph.facebook.com/${credentials.graph_version || 'v24.0'}/${credentials.phone_number_id}/messages`, { messaging_product: 'whatsapp', to: appointment.customer_phone, ...outbound }, { headers: { Authorization: `Bearer ${credentials.access_token}` }, timeout: 15000 });if(!sent.data?.messages?.[0]?.id)throw new Error('A Meta não confirmou o envio.');return sent;}});
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
  async function sendOrderMessage(org, order, body, imageUrl = '', referenceBase = '', buttonUrl = '') {
    const integration = (await root(org).collection('integrations').doc('whatsapp').get()).data() || {};
    if (!integration.active || !integration.access_token || !integration.phone_number_id || !order.customer_phone) return false;
    const url = `https://graph.facebook.com/${integration.graph_version || 'v24.0'}/${integration.phone_number_id}/messages`;
    if (imageUrl) await withAutomatedMessage({db,admin,organizationId:org,HttpsError,reference:`${referenceBase}_image`,send:async()=>{const sent=await axios.post(url, {messaging_product:'whatsapp',to:order.customer_phone,type:'image',image:{link:imageUrl,caption:`Pix do pedido #${order.number || ''} · ${money(order.total_cents)}`}}, {headers:{Authorization:`Bearer ${integration.access_token}`},timeout:15000});if(!sent.data?.messages?.[0]?.id)throw new Error('A Meta não confirmou o envio da imagem do Pix.');return sent;}});
    const outbound = buttonUrl ? {messaging_product:'whatsapp',to:order.customer_phone,type:'interactive',interactive:{type:'cta_url',body:{text:body},action:{name:'cta_url',parameters:{display_text:'Pagar com cartão',url:buttonUrl}}}} : {messaging_product:'whatsapp',to:order.customer_phone,type:'text',text:{preview_url:false,body}};
    await withAutomatedMessage({db,admin,organizationId:org,HttpsError,reference:`${referenceBase}_text`,send:async()=>{const sent=await axios.post(url, outbound, {headers:{Authorization:`Bearer ${integration.access_token}`},timeout:15000});if(!sent.data?.messages?.[0]?.id)throw new Error('A Meta não confirmou o envio da mensagem de pagamento.');return sent;}});
    return true;
  }
  async function sendOrderPaymentChoice(org, order, referenceBase) {
    const integration = (await root(org).collection('integrations').doc('whatsapp').get()).data() || {};
    if (!integration.active || !integration.access_token || !integration.phone_number_id || !order.customer_phone) return false;
    const url = `https://graph.facebook.com/${integration.graph_version || 'v24.0'}/${integration.phone_number_id}/messages`;
    const outbound = {messaging_product:'whatsapp',to:order.customer_phone,type:'interactive',interactive:{type:'button',body:{text:'Mudou de ideia? Você pode trocar para Pix antes de concluir o pagamento.'},action:{buttons:[{type:'reply',reply:{id:'order_switch_pix',title:'Gerar Pix'}},{type:'reply',reply:{id:'order_keep_card',title:'Manter cartão'}}]}}};
    await withAutomatedMessage({db,admin,organizationId:org,HttpsError,reference:`${referenceBase}_choice`,send:async()=>{const sent=await axios.post(url,outbound,{headers:{Authorization:`Bearer ${integration.access_token}`},timeout:15000});if(!sent.data?.messages?.[0]?.id)throw new Error('A Meta não confirmou as opções de pagamento.');return sent;}});
    return true;
  }
  async function createOrderPix(org, orderId) {
    const ref = root(org).collection('orders').doc(orderId);
    const snapshot = await ref.get(); const order = snapshot.data();
    if (!order || order.payment?.method !== 'pix') return {status:'not_applicable'};
    if (order.payment?.payment_id) return {status:order.payment.status || 'pending',paymentId:String(order.payment.payment_id)};
    const connection = (await account(org).get()).data();
    if (!connection?.active) throw new Error('Conecte a conta Mercado Pago antes de aceitar pedidos Pix.');
    const reference = `order-${org}-${orderId}`.slice(0,120), expiresAt = Date.now() + 15 * 60000;
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
    const update = {method:'pix',status:'pending',payment_id:String(payment.id),provider_status:String(payment.status || ''),reference,qr_code:String(transactionData.qr_code || ''),qr_image_url:qrImageUrl,ticket_url:String(transactionData.ticket_url || ''),created_at:stamp(),expires_at:admin.firestore.Timestamp.fromMillis(expiresAt)};
    await ref.set({payment:{...order.payment,...update},updated_at:stamp()},{merge:true});
    await db.doc(`mercadopago_payments/${payment.id}`).set({kind:'order',organizationId:org,orderId});
    const text = `Para confirmar seu pedido, pague ${money(order.total_cents)} via Pix em até 15 minutos. O preparo começará somente após a confirmação do pagamento.\n\nPix Copia e Cola:\n${transactionData.qr_code}${transactionData.ticket_url ? `\n\nAbrir pagamento: ${transactionData.ticket_url}` : ''}`;
    try { await sendOrderMessage(org,order,text,qrImageUrl,`order_pix_${orderId}`); }
    catch (error) { logger.warn('Pix criado, mas o envio pelo WhatsApp falhou', {organizationId:org,orderId,status:error.response?.status || null}); }
    if (payment.status === 'approved') await settleOrderPayment(org,orderId,payment);
    return {status:update.status,paymentId:String(payment.id)};
  }
  async function createOrderCardCheckout(org, orderId) {
    const ref = root(org).collection('orders').doc(orderId), snapshot = await ref.get(), order = snapshot.data();
    if (!order || order.payment?.method !== 'card_online') return {status:'not_applicable'};
    if (order.payment?.checkout_url) return {status:order.payment.status || 'pending',checkoutUrl:String(order.payment.checkout_url)};
    const connection = (await account(org).get()).data();
    if (!connection?.active) throw new Error('Conecte a conta Mercado Pago antes de aceitar cartão online.');
    const reference = `order-card-${org}-${orderId}`.slice(0,120), access = await token(org), expiresAt = Date.now() + 15 * 60 * 1000;
    const notificationUrl = new URL(webhook());
    notificationUrl.searchParams.set('organizationId', org); notificationUrl.searchParams.set('orderId', orderId);
    const total = Number(order.total_cents || 0) / 100;
    if (!(total > 0)) throw new Error('O pedido não possui valor válido para o checkout.');
    const items = [{id:String(order.number || orderId).slice(0,256),title:`Pedido ${order.number || orderId}`.slice(0,256),description:(Array.isArray(order.items) ? order.items : []).slice(0,8).map(item=>`${Number(item.quantity)||1}x ${String(item.name||'Produto')}`).join(', ').slice(0,256),quantity:1,currency_id:'BRL',unit_price:total}];
    const payload = {items,payer:{email:String(order.payment?.customer_email || order.customer?.email || '').slice(0,254)},external_reference:reference,notification_url:notificationUrl.toString(),binary_mode:true,expires:true,expiration_date_from:new Date().toISOString(),expiration_date_to:new Date(expiresAt).toISOString(),payment_methods:{excluded_payment_types:[{id:'prepaid_card'},{id:'ticket'},{id:'atm'},{id:'bank_transfer'}],installments:1},metadata:{organization_id:org,order_id:orderId}};
    const preference = (await axios.post(`${API}/checkout/preferences`,payload,{headers:{Authorization:`Bearer ${access}`,'Content-Type':'application/json','X-Idempotency-Key':`order-card-${orderId}`.slice(0,64)},timeout:20000})).data;
    const checkoutUrl = String(preference.init_point || '');
    if (!preference.id || !/^https:\/\/(?:www\.)?mercadopago\.com\.br\//i.test(checkoutUrl)) throw new Error('O Mercado Pago não retornou um checkout válido.');
    const update = {method:'card_online',status:'pending',preference_id:String(preference.id),reference,checkout_url:checkoutUrl,installments:1,created_at:stamp(),expires_at:admin.firestore.Timestamp.fromMillis(expiresAt)};
    await ref.set({payment:{...order.payment,...update},updated_at:stamp()},{merge:true});
    const text = `Para confirmar seu pedido, pague ${money(order.total_cents)} com cartão de crédito em 1x ou débito. O preparo começará somente após a confirmação do pagamento.`;
    try { await sendOrderMessage(org,order,text,'',`order_card_${orderId}`,checkoutUrl); await sendOrderPaymentChoice(org,order,`order_card_${orderId}`); }
    catch (error) { logger.warn('Checkout criado, mas o botão de cartão não foi enviado', {organizationId:org,orderId,status:error.response?.status || null}); }
    return {status:'pending',preferenceId:String(preference.id)};
  }
  async function resendOrderCardCheckout(org, orderId) {
    const order = (await root(org).collection('orders').doc(orderId).get()).data();
    if (!order || order.payment?.method !== 'card_online' || order.payment?.status === 'paid' || !order.payment?.checkout_url) return false;
    const text = `Para confirmar seu pedido, pague ${money(order.total_cents)} com cartão de crédito em 1x ou débito. O preparo começará somente após a confirmação do pagamento.`;
    await sendOrderMessage(org,order,text,'',`order_card_resend_${orderId}_${Date.now()}`,String(order.payment.checkout_url));
    return true;
  }
  async function switchOrderPaymentToPix(org, orderId) {
    const ref = root(org).collection('orders').doc(orderId), snapshot = await ref.get(), order = snapshot.data();
    if (!order || order.status !== 'awaiting_payment' || order.payment?.method !== 'card_online' || order.payment?.status === 'paid') throw new Error('Este pedido não permite trocar a forma de pagamento.');
    const access = await token(org), preferenceId = String(order.payment?.preference_id || '');
    if (preferenceId) await axios.put(`${API}/checkout/preferences/${encodeURIComponent(preferenceId)}`,{expires:true,expiration_date_to:new Date().toISOString()},{headers:{Authorization:`Bearer ${access}`,'Content-Type':'application/json'},timeout:15000});
    const previousReference = String(order.payment?.reference || '');
    await ref.set({payment:{method:'pix',status:'pending',customer_email:String(order.payment?.customer_email || order.customer?.email || ''),switched_from:'card_online',previous_reference:previousReference,switched_at:stamp()},updated_at:stamp()},{merge:true});
    return createOrderPix(org,orderId);
  }
  async function createOrderPayment(org, orderId) {
    const order = (await root(org).collection('orders').doc(orderId).get()).data();
    if (order?.payment?.method === 'pix') return createOrderPix(org, orderId);
    if (order?.payment?.method === 'card_online') return createOrderCardCheckout(org, orderId);
    return {status:'not_applicable'};
  }
  async function settleOrderPayment(org, orderId, suppliedPayment, suppliedPaymentId = '') {
    const ref = root(org).collection('orders').doc(orderId), snapshot = await ref.get(), order = snapshot.data();
    const paymentId = String(suppliedPaymentId || order?.payment?.payment_id || '');
    if (!order?.payment?.reference || (!suppliedPayment && !/^\d+$/.test(paymentId))) return false;
    const access = await token(org), payment = suppliedPayment || (await axios.get(`${API}/v1/payments/${paymentId}`,{headers:{Authorization:`Bearer ${access}`},timeout:15000})).data;
    const collectorId = payment.collector_id ?? payment.user_id;
    if (payment.external_reference !== order.payment.reference || Math.round(Number(payment.transaction_amount)*100) !== Number(order.total_cents) || payment.currency_id !== 'BRL' || String(collectorId) !== String((await account(org).get()).data()?.seller_id)) throw new Error('A cobrança não corresponde ao pedido.');
    if (payment.status !== 'approved') { await ref.set({payment:{...order.payment,provider_status:String(payment.status || ''),status:['rejected','cancelled','canceled','refunded'].includes(payment.status)?'failed':'pending'},updated_at:stamp()},{merge:true}); return false; }
    if (order.payment.status === 'paid' && order.payment_confirmation_sent_at) return true;
    if (!['awaiting_payment','confirmed'].includes(order.status)) {
      await ref.set({status:'payment_review',payment_review_reason:'payment_approved_after_order_closed',payment:{...order.payment,payment_id:String(payment.id),status:'paid',provider_status:'approved',paid_at:stamp()},status_history:admin.firestore.FieldValue.arrayUnion({status:'payment_review',source:'mercadopago',reason:'late_payment',at:admin.firestore.Timestamp.now()}),updated_at:stamp()},{merge:true});
      logger.warn('Pagamento aprovado após encerramento do pedido',{organizationId:org,orderId,previousStatus:order.status});
      return true;
    }
    const statusUpdate = ['awaiting_payment','confirmed'].includes(order.status) ? {status:'confirmed',status_history:admin.firestore.FieldValue.arrayUnion({status:'confirmed',source:'mercadopago',at:admin.firestore.Timestamp.now()})} : {};
    await ref.set({payment:{...order.payment,payment_id:String(payment.id),status:'paid',provider_status:'approved',paid_at:stamp()},...statusUpdate,updated_at:stamp()},{merge:true});
    await sendOrderMessage(org,order,'Pagamento confirmado! Já vamos começar o preparo. 🍔','',`order_payment_paid_${orderId}`);
    await ref.set({payment_confirmation_sent_at:stamp(),updated_at:stamp()},{merge:true});
    return true;
  }
  async function expireOrderPayment(org, orderId) {
    const ref = root(org).collection('orders').doc(orderId);
    const snapshot = await ref.get(), order = snapshot.data();
    if (!order || !isOrderPaymentExpired(order)) return {status:'not_expired'};
    const access = await token(org);
    let providerStatus = String(order.payment?.provider_status || 'pending');
    if (order.payment?.method === 'pix' && /^\d+$/.test(String(order.payment?.payment_id || ''))) {
      const payment = (await axios.get(`${API}/v1/payments/${order.payment.payment_id}`,{headers:{Authorization:`Bearer ${access}`},timeout:15000})).data;
      providerStatus = String(payment.status || providerStatus);
      if (payment.status === 'approved') { await settleOrderPayment(org,orderId,payment); return {status:'paid'}; }
      if (!['cancelled','canceled','rejected','refunded','charged_back'].includes(payment.status)) {
        const cancelled = (await axios.put(`${API}/v1/payments/${order.payment.payment_id}`,{status:'cancelled'},{headers:{Authorization:`Bearer ${access}`,'Content-Type':'application/json'},timeout:15000})).data;
        providerStatus = String(cancelled.status || 'cancelled');
      }
    } else if (order.payment?.method === 'card_online') {
      const search = (await axios.get(`${API}/v1/payments/search`,{params:{external_reference:String(order.payment.reference || ''),sort:'date_created',criteria:'desc'},headers:{Authorization:`Bearer ${access}`},timeout:15000})).data;
      const approved = (search.results || []).find(payment => payment.status === 'approved');
      if (approved) { await settleOrderPayment(org,orderId,approved); return {status:'paid'}; }
      const preferenceId = String(order.payment?.preference_id || '');
      if (preferenceId) await axios.put(`${API}/checkout/preferences/${encodeURIComponent(preferenceId)}`,{expires:true,expiration_date_to:new Date().toISOString()},{headers:{Authorization:`Bearer ${access}`,'Content-Type':'application/json'},timeout:15000});
      providerStatus = 'expired';
    }
    const now = stamp();
    await ref.set({status:'cancelled',cancellation_reason:'payment_expired',cancelled_at:now,payment:{...order.payment,status:'expired',provider_status:providerStatus,expired_at:now},status_history:admin.firestore.FieldValue.arrayUnion({status:'cancelled',source:'payment_expiration',reason:'payment_expired',at:admin.firestore.Timestamp.now()}),updated_at:now},{merge:true});
    const text=`O prazo para pagamento do pedido #${String(order.number || orderId).toUpperCase()} terminou e ele foi cancelado automaticamente. Se desejar, abra o cardápio para fazer um novo pedido.`;
    try {
      const sent = await sendOrderMessage(org,order,text,'',`order_payment_expired_${orderId}`);
      if (!sent) throw new Error('WhatsApp desconectado para o aviso de expiração.');
      await ref.set({payment_expiration_message_status:'sent',payment_expiration_message_sent_at:stamp(),updated_at:stamp()},{merge:true});
    } catch (error) {
      await ref.set({payment_expiration_message_status:'failed',payment_expiration_message_error:String(error.message || 'Falha no aviso').slice(0,200),updated_at:stamp()},{merge:true});
      logger.warn('Pedido expirado, mas o aviso não foi enviado',{organizationId:org,orderId,status:error.response?.status || null});
    }
    return {status:'cancelled'};
  }
  async function refundAppointment(org, appointmentId) {
    const ref = root(org).collection('appointments').doc(appointmentId);
    const snapshot = await ref.get(), appointment = snapshot.data();
    if (!appointment || appointment.status !== 'cancelled') throw new Error('O agendamento precisa estar cancelado para devolver o sinal.');
    if (appointment.refund_status === 'refunded' || appointment.payment_status === 'refunded') return {status:'refunded',refundId:String(appointment.refund_provider_id || '')};
    if (appointment.payment_status !== 'refund_pending' && appointment.refund_status !== 'failed') throw new Error('Este agendamento não possui uma devolução pendente.');
    const paymentId = String(appointment.payment_provider_id || '');
    if (!/^\d+$/.test(paymentId)) throw new Error('O pagamento do sinal não foi localizado.');
    const access = await token(org);
    try {
      const response = await axios.post(`${API}/v1/payments/${paymentId}/refunds`, {}, {headers:{Authorization:`Bearer ${access}`,'Content-Type':'application/json','X-Idempotency-Key':`appointment-refund-${appointmentId}`.slice(0,64)},timeout:20000});
      const refundId = String(response.data?.id || '');
      await ref.set({payment_status:'refunded',refund_status:'refunded',refund_provider_id:refundId,refunded_cents:Number(appointment.paid_cents || 0),refunded_at:stamp(),refund_error:admin.firestore.FieldValue.delete(),updated_at:stamp()},{merge:true});
      return {status:'refunded',refundId};
    } catch (error) {
      await ref.set({payment_status:'refund_failed',refund_status:'failed',refund_attempts:Number(appointment.refund_attempts || 0)+1,refund_next_retry_at:admin.firestore.Timestamp.fromMillis(Date.now()+15*60000),refund_error:String(error.response?.data?.message || error.message || 'Falha no estorno').slice(0,300),refund_failed_at:stamp(),updated_at:stamp()},{merge:true});
      throw error;
    }
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
      else if (map?.kind === 'plan_pix') { const billing=(await billingRef(map.organizationId).get()).data(); const {access}=await platformAccess(); const payment=(await axios.get(`${API}/v1/payments/${id}`,{headers:{Authorization:`Bearer ${access}`},timeout:15000})).data; await settlePlanPix(map.organizationId,billing,payment); }
      else if(map?.kind==='plan_upgrade'){const billing=(await billingRef(map.organizationId).get()).data();const {access}=await platformAccess();const payment=(await axios.get(`${API}/v1/payments/${id}`,{headers:{Authorization:`Bearer ${access}`},timeout:15000})).data;await settlePlanUpgrade(map.organizationId,billing,payment);}
      else if (map) await processAttempt(db.doc(`payment_attempts/${map.attemptId}`));
      else {
        const org = String(req.query.organizationId || ''), orderId = String(req.query.orderId || '');
        if (/^[A-Za-z0-9_-]{1,128}$/.test(org) && /^[A-Za-z0-9_-]{1,128}$/.test(orderId)) await settleOrderPayment(org,orderId,null,id);
      }
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
    const refunds = await db.collectionGroup('appointments').where('refund_status','==','failed').limit(100).get();
    for (const document of refunds.docs) {
      const data = document.data(), organizationId = document.ref.parent.parent?.id;
      if (!organizationId || Number(data.refund_attempts || 0) >= 10 || data.refund_next_retry_at?.toMillis?.() > Date.now()) continue;
      try { await refundAppointment(organizationId,document.id); }
      catch (error) { logger.warn('Estorno aguardando nova conciliação',{organizationId,appointmentId:document.id,status:error.response?.status || null}); }
    }
    const pendingOrders = await db.collectionGroup('orders').where('status','==','awaiting_payment').limit(500).get();
    for (const document of pendingOrders.docs) {
      const order = document.data(), organizationId = document.ref.parent.parent?.id;
      if (!organizationId || !isOrderPaymentExpired(order)) continue;
      try { await expireOrderPayment(organizationId,document.id); }
      catch (error) { logger.warn('Pedido aguardando nova conciliação de expiração',{organizationId,orderId:document.id,status:error.response?.status || null}); }
    }
  });
  const reconcilePlanSubscriptions = onSchedule({region,schedule:'every day 03:15',timeZone:'America/Sao_Paulo',secrets:oauthSecrets,timeoutSeconds:540,maxInstances:1},async()=>{
    const snapshot=await db.collectionGroup('billing').limit(500).get(), {access}=await platformAccess();
    for(const document of snapshot.docs){
      const data=document.data(), org=document.ref.parent.parent?.id; if(!org || document.id!=='subscription')continue;
      try{
        if(data.method==='card' && data.provider_subscription_id){
          const status=await settleCardSubscription(org,data);
          if(['paused','cancelled'].includes(status)) await root(org).set({status:status==='paused'?'past_due':'cancelled',billing_updated_at:stamp(),atualizado_em:stamp()},{merge:true});
        }
        if(data.method==='pix' && data.status==='active' && !data.pending_plan_id && data.next_due_at?.toMillis?.() <= Date.now()+5*86400000){
          const checkoutId=crypto.randomUUID(), reference=`renew-${org}-${checkoutId}`.slice(0,120), expiresAt=data.next_due_at.toMillis()+2*86400000;
          const payment=(await axios.post(`${API}/v1/payments`,{transaction_amount:Number(data.amount)/100,description:`Renovação ${data.plan_name} Automichat`.slice(0,120),payment_method_id:'pix',date_of_expiration:new Date(expiresAt).toISOString(),payer:{email:data.payer_email},external_reference:reference,notification_url:webhook()},{headers:{Authorization:`Bearer ${access}`,'Content-Type':'application/json','X-Idempotency-Key':checkoutId},timeout:20000})).data;
          if(!/^\d+$/.test(String(payment.id || '')))throw new Error('Renovação Pix inválida.'); const qr=payment.point_of_interaction?.transaction_data || {};
          await document.ref.set({status:'pending',payment_id:String(payment.id),external_reference:reference,qr_code:String(qr.qr_code || ''),qr_code_base64:String(qr.qr_code_base64 || ''),ticket_url:String(qr.ticket_url || ''),expires_at:admin.firestore.Timestamp.fromMillis(expiresAt),renewal_created_at:stamp(),updated_at:stamp()},{merge:true});
          await db.doc(`mercadopago_payments/${payment.id}`).set({kind:'plan_pix',organizationId:org});
        }
        if(data.pending_plan_id && data.pending_effective_at?.toMillis?.()<=Date.now()){
          const target=await db.doc(`plans/${data.pending_plan_id}`).get(); if(!target.exists || target.data().active===false)throw new Error('Plano agendado indisponível.');
          const plan={id:target.id,name:String(target.data().name || target.id),price:Number(target.data().price || 0)};
          if(data.method==='card' && data.provider_subscription_id && plan.price===0)await axios.put(`${API}/preapproval/${data.provider_subscription_id}`,{status:'canceled'},{headers:{Authorization:`Bearer ${access}`,'Content-Type':'application/json'},timeout:15000});
          await root(org).set({plano_id:plan.id,plano_nome:plan.name,plano_preco:plan.price,status:'active',billing_updated_at:stamp(),atualizado_em:stamp()},{merge:true});
          await document.ref.set({plan_id:plan.id,plan_name:plan.name,amount:Math.round(plan.price*100),...(plan.price===0?{status:'free'}:{}),pending_plan_id:admin.firestore.FieldValue.delete(),pending_plan_name:admin.firestore.FieldValue.delete(),pending_plan_price:admin.firestore.FieldValue.delete(),pending_effective_at:admin.firestore.FieldValue.delete(),updated_at:stamp()},{merge:true});
        }
      }catch(error){logger.warn('Falha ao conciliar assinatura do plano',{organizationId:org,status:error.response?.status || null});}
    }
    const trials=await db.collection('organizations').where('status','==','trial').limit(500).get(), batch=db.batch(); let expired=0;
    for(const trial of trials.docs){if(trial.data().trial_ends_at?.toMillis?.()<=Date.now()){batch.set(trial.ref,{status:'trial_expired',atualizado_em:stamp()},{merge:true});expired+=1;}}
    if(expired)await batch.commit();
  });
  return { functions: { getPaymentSettings, savePaymentSettings, connectMercadoPago, disconnectMercadoPago, createCapacityPurchase, getCapacityPurchase, getPlanCheckoutStatus, getPlanChangeOptions, changeOwnerPlan, activatePlanFreeAccess, createPlanCardSubscription, createPlanPixPayment, createPlanUpgradeCardPayment, createPlanUpgradePixPayment, mercadoPagoOAuthCallback, mercadoPagoWebhook, reconcileMercadoPagoOrders, reconcilePlanSubscriptions }, policy, intent, processAttempt, refundAppointment, createOrderPix, createOrderCardCheckout, createOrderPayment, resendOrderCardCheckout, switchOrderPaymentToPix, expireOrderPayment, quote, setOnPaid: fn => { onPaid = fn; }, oauthSecrets };
}
module.exports = { createMercadoPago, seal, unseal, validSignature, paymentPayload, paymentOutcome, pixMessage, createPkce, orderPaymentExpiryMillis, isOrderPaymentExpired, planChangeProration };
