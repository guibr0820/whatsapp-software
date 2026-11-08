const crypto = require("crypto");

const DEFAULT_PREFERENCES = Object.freeze({
  newSubscription: true,
  waitingCustomer: true,
  paymentFailure: false,
  whatsappDisconnected: false,
  reminderMinutes: 15,
});

function createAdminNotificationFunctions({admin, db, onCall, HttpsError, onDocumentWritten, supportOrganizationId}) {
  const options = {region: "southamerica-east1", enforceAppCheck: false};
  // Este projeto usa um banco nomeado "default" (sem os parênteses do banco padrão especial).
  const triggerOptions = {region: "southamerica-east1", database: "default", retry: false};

  function authorize(request) {
    if (!request.auth) throw new HttpsError("unauthenticated", "Entre com sua conta administrativa.");
    if (request.auth.token.admin !== true) throw new HttpsError("permission-denied", "Somente administradores podem configurar estes alertas.");
    return {uid: request.auth.uid, email: String(request.auth.token.email || "")};
  }

  const getAdminNotificationSettings = onCall(options, async request => {
    const actor = authorize(request);
    const [settings, devices] = await Promise.all([
      db.doc(`admin_notification_settings/${actor.uid}`).get(),
      db.collection("admin_notification_devices").where("admin_uid", "==", actor.uid).limit(20).get(),
    ]);
    return {
      preferences: preferences(settings.data()),
      devices: devices.docs.map(document => publicDevice(document)),
    };
  });

  const saveAdminNotificationSettings = onCall(options, async request => {
    const actor = authorize(request);
    const input = request.data?.preferences || {};
    const value = {
      new_subscription: input.newSubscription !== false,
      waiting_customer: input.waitingCustomer !== false,
      payment_failure: input.paymentFailure === true,
      whatsapp_disconnected: input.whatsappDisconnected === true,
      reminder_minutes: Math.max(5, Math.min(120, Math.trunc(Number(input.reminderMinutes) || 15))),
      enabled: true,
      admin_email: actor.email,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    };
    await db.doc(`admin_notification_settings/${actor.uid}`).set(value, {merge: true});
    return {preferences: preferences(value)};
  });

  const registerAdminNotificationDevice = onCall(options, async request => {
    const actor = authorize(request);
    const token = validToken(request.data?.token, HttpsError);
    const deviceId = tokenId(token);
    const platform = optionalText(request.data?.platform, 40);
    const label = optionalText(request.data?.label, 100) || "Navegador";
    const now = admin.firestore.FieldValue.serverTimestamp();
    const batch = db.batch();
    batch.set(db.doc(`admin_notification_devices/${deviceId}`), {admin_uid: actor.uid, admin_email: actor.email, token, platform, label, active: true, error: "", created_at: now, updated_at: now}, {merge: true});
    batch.set(db.doc(`admin_notification_settings/${actor.uid}`), {enabled: true, admin_email: actor.email, updated_at: now}, {merge: true});
    await batch.commit();
    return {device: {id: deviceId, label, platform, active: true}};
  });

  const removeAdminNotificationDevice = onCall(options, async request => {
    const actor = authorize(request);
    const deviceId = validId(request.data?.deviceId, HttpsError);
    const ref = db.doc(`admin_notification_devices/${deviceId}`);
    const snapshot = await ref.get();
    if (!snapshot.exists || snapshot.data().admin_uid !== actor.uid) throw new HttpsError("not-found", "Aparelho não encontrado.");
    await ref.set({active: false, disabled_at: admin.firestore.FieldValue.serverTimestamp(), updated_at: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
    return {removed: true};
  });

  const sendAdminTestNotification = onCall(options, async request => {
    const actor = authorize(request);
    const devices = await db.collection("admin_notification_devices").where("admin_uid", "==", actor.uid).limit(20).get();
    const result = await sendToDevices({admin, db, devices: devices.docs, title: "Automichat conectado 🔔", body: "As notificações administrativas estão funcionando neste aparelho.", link: "https://automichat.com/admin.html#conversations", tag: "automichat-test"});
    if (!result.sent) throw new HttpsError("failed-precondition", "Nenhum aparelho ativo recebeu o teste. Ative as notificações novamente.");
    return result;
  });

  const notifyAdminNewSubscription = onDocumentWritten({...triggerOptions, document: "organizations/{organizationId}/billing/subscription"}, async event => {
    const before = event.data?.before?.data() || {};
    const after = event.data?.after?.data() || {};
    if (!event.data?.after?.exists || after.status !== "active" || before.status === "active") return;
    const organization = await db.doc(`organizations/${event.params.organizationId}`).get();
    if (!organization.exists) return;
    const data = organization.data() || {};
    const planName = String(after.plan_name || data.plano_nome || "Plano Automichat").slice(0, 80);
    const amount = moneyFromCents(after.amount || Math.round(Number(data.plano_preco || 0) * 100));
    await sendAdminEvent({admin, db, preference: "new_subscription", title: "Nova assinatura 🎉", body: `${String(data.nome || "Novo cliente").slice(0, 90)} assinou o plano ${planName} por ${amount}.`, link: "https://automichat.com/admin.html#organizations", tag: `subscription-${event.params.organizationId}-${String(after.provider_subscription_id || after.payment_id || planName).slice(0, 80)}`});
  });

  const notifyAdminWaitingCustomer = onDocumentWritten({...triggerOptions, document: "organizations/{organizationId}/conversations/{conversationId}"}, async event => {
    if (event.params.organizationId !== parameterValue(supportOrganizationId)) return;
    const before = event.data?.before?.data() || {};
    const after = event.data?.after?.data() || {};
    if (!event.data?.after?.exists || after.human_support !== true || after.status === "closed") return;
    if (before.human_support === true && before.status !== "closed") return;
    const name = String(after.contact_name || after.profile_name || "Um cliente").slice(0, 90);
    const product = after.support_product === "smilecut" ? "Smilecut" : after.support_product === "automichat" ? "Automichat" : "suporte";
    await sendAdminEvent({admin, db, preference: "waiting_customer", title: "Cliente aguardando retorno ⚠️", body: `${name} está aguardando atendimento sobre ${product}.`, link: `https://automichat.com/admin.html#conversations`, tag: `waiting-${event.params.conversationId}`});
  });

  return {getAdminNotificationSettings, saveAdminNotificationSettings, registerAdminNotificationDevice, removeAdminNotificationDevice, sendAdminTestNotification, notifyAdminNewSubscription, notifyAdminWaitingCustomer};
}

async function sendAdminEvent({admin, db, preference, title, body, link, tag}) {
  const settings = await db.collection("admin_notification_settings").where("enabled", "==", true).limit(20).get();
  let sent = 0;
  for (const setting of settings.docs) {
    if (setting.data()?.[preference] === false) continue;
    const devices = await db.collection("admin_notification_devices").where("admin_uid", "==", setting.id).limit(20).get();
    const result = await sendToDevices({admin, db, devices: devices.docs, title, body, link, tag});
    sent += result.sent;
  }
  return {sent};
}

async function sendToDevices({admin, db, devices, title, body, link, tag}) {
  const active = devices.filter(document => document.data()?.active === true && document.data()?.token);
  if (!active.length) return {sent: 0, failed: 0};
  const response = await admin.messaging().sendEachForMulticast({tokens: active.map(document => document.data().token), notification: {title, body}, webpush: {notification: {icon: "https://automichat.com/notification-icon.svg", badge: "https://automichat.com/notification-icon.svg", tag, renotify: true}, fcmOptions: {link}}, data: {link, tag}});
  const batch = db.batch();
  response.responses.forEach((item, index) => {
    const ref = active[index].ref;
    if (item.success) batch.set(ref, {last_success_at: admin.firestore.FieldValue.serverTimestamp(), error: "", updated_at: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
    else {
      const code = String(item.error?.code || "messaging/unknown-error");
      const invalid = ["messaging/registration-token-not-registered", "messaging/invalid-registration-token"].includes(code);
      batch.set(ref, {active: invalid ? false : true, error: code.slice(0, 120), ...(invalid ? {disabled_at: admin.firestore.FieldValue.serverTimestamp()} : {}), updated_at: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
    }
  });
  await batch.commit();
  return {sent: response.successCount, failed: response.failureCount};
}

function preferences(data = {}) { return {newSubscription: data.new_subscription !== false, waitingCustomer: data.waiting_customer !== false, paymentFailure: data.payment_failure === true, whatsappDisconnected: data.whatsapp_disconnected === true, reminderMinutes: Math.max(5, Math.min(120, Number(data.reminder_minutes || DEFAULT_PREFERENCES.reminderMinutes)))}; }
function publicDevice(document) { const data = document.data() || {}; return {id: document.id, label: String(data.label || "Navegador").slice(0, 100), platform: String(data.platform || "").slice(0, 40), active: data.active === true, error: String(data.error || "").slice(0, 120), createdAt: data.created_at?.toMillis?.() || 0, lastSuccessAt: data.last_success_at?.toMillis?.() || 0}; }
function validToken(value, HttpsError) { const token = String(value || "").trim(); if (token.length < 40 || token.length > 4096 || !/^[A-Za-z0-9_:\-]+$/.test(token)) throw new HttpsError("invalid-argument", "Token de notificação inválido."); return token; }
function validId(value, HttpsError) { const id = String(value || "").trim(); if (!/^[a-f0-9]{64}$/.test(id)) throw new HttpsError("invalid-argument", "Aparelho inválido."); return id; }
function optionalText(value, max) { return String(value || "").trim().slice(0, max); }
function tokenId(token) { return crypto.createHash("sha256").update(token).digest("hex"); }
function parameterValue(value) { return String(typeof value?.value === "function" ? value.value() : value || "").trim(); }
function moneyFromCents(value) { return new Intl.NumberFormat("pt-BR", {style: "currency", currency: "BRL"}).format(Math.max(0, Number(value || 0)) / 100); }

module.exports = {createAdminNotificationFunctions, _test: {preferences, validToken, tokenId, moneyFromCents}};
