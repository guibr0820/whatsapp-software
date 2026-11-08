const { normalizeLimits, defaultLimitsFor, monthKey } = require("./plan-limits");
const { normalizeCapacityPackage, packageDocument, listCapacityPackages } = require("./capacity-packages");
const { listSegments, normalizeSegmentInput } = require("./segment-config");
const crypto = require("crypto");

function createAdminFunctions({ admin, db, onCall, HttpsError, axios, supportOrganizationId }) {
  const region = "southamerica-east1";
  const options = { region, enforceAppCheck: false };

  function authorize(request) {
    if (!request.auth) throw new HttpsError("unauthenticated", "Entre com uma conta administrativa.");
    if (request.auth.token.admin !== true) throw new HttpsError("permission-denied", "Esta conta não possui acesso administrativo.");
    return { uid: request.auth.uid, email: String(request.auth.token.email || "") };
  }

  async function audit(actor, action, targetType, targetId, details = {}) {
    await db.collection("admin_audit_logs").add({
      actor_uid: actor.uid,
      actor_email: actor.email,
      action,
      target_type: targetType,
      target_id: targetId,
      details,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  const getSiteMaintenance = onCall(options, async () => {
    const snapshot = await db.doc("app_config/site").get();
    return { maintenance: snapshot.data()?.maintenance === true };
  });

  const setSiteMaintenance = onCall(options, async request => {
    const actor = authorize(request);
    const maintenance = request.data?.maintenance === true;
    await db.doc("app_config/site").set({
      maintenance,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
      updated_by: actor.uid,
    }, { merge: true });
    await audit(actor, maintenance ? "site.maintenance_enabled" : "site.maintenance_disabled", "site", "main", { maintenance });
    return { maintenance };
  });

  const getAdminOverview = onCall(options, async request => {
    authorize(request);
    const [organizations, users, plans] = await Promise.all([
      db.collection("organizations").get(),
      db.collection("users").count().get(),
      db.collection("plans").get(),
    ]);
    const statuses = {};
    const planCounts = {};
    for (const document of organizations.docs) {
      const data = document.data();
      statuses[data.status || "unknown"] = (statuses[data.status || "unknown"] || 0) + 1;
      planCounts[data.plano_id || "sem-plano"] = (planCounts[data.plano_id || "sem-plano"] || 0) + 1;
    }
    return { organizations: organizations.size, users: Number(users.data().count || 0), plans: plans.size, statuses, planCounts, month: monthKey() };
  });

  const listAdminPlans = onCall(options, async request => {
    authorize(request);
    const [snapshot, capacityPackages] = await Promise.all([db.collection("plans").get(), listCapacityPackages(db, admin)]);
    return { plans: snapshot.docs.map(document => {
      const data = document.data();
      return { id: document.id, name: data.name || document.id, price: Number(data.price || 0), title: data.title || "", description: data.description || "", subtitle: data.subtitle || "", features: Array.isArray(data.features) ? data.features : null, prefer: data.prefer === true, freeTrial: data.freeTrial === true, active: data.active !== false, limits: defaultLimitsFor({ id: document.id, ...data }) };
    }).sort((a, b) => a.price - b.price), capacityPackages };
  });

  const listAvailableSegments = onCall(options, async request => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Entre para carregar os segmentos.");
    return { segments: await listSegments(db, admin, request.data?.includeInactive === true) };
  });

  const getOwnerSettings = onCall(options, async request => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Entre para carregar os ajustes.");
    const organizationId = cleanId(request.data?.organizationId, HttpsError);
    const [organization, member, segments] = await Promise.all([
      db.doc(`organizations/${organizationId}`).get(),
      db.doc(`organizations/${organizationId}/members/${request.auth.uid}`).get(),
      listSegments(db, admin, true),
    ]);
    if (!organization.exists || organization.data().proprietario_uid !== request.auth.uid || member.data()?.status !== "active") throw new HttpsError("permission-denied", "Somente o proprietário pode alterar estes ajustes.");
    const data = organization.data();
    return { organization: { name:data.nome || "", segment:data.segmento || "", planId:data.plano_id || "", planName:data.plano_nome || "Sem plano", planPrice:Number(data.plano_preco || 0), status:data.status || "" }, segments };
  });

  const saveOwnerSegment = onCall(options, async request => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Entre para alterar o segmento.");
    const organizationId = cleanId(request.data?.organizationId, HttpsError);
    const segmentName = text(request.data?.segment, 2, 60, "Escolha um segmento válido.", HttpsError);
    const [organization, member, segments] = await Promise.all([
      db.doc(`organizations/${organizationId}`).get(),
      db.doc(`organizations/${organizationId}/members/${request.auth.uid}`).get(),
      listSegments(db, admin, false),
    ]);
    if (!organization.exists || organization.data().proprietario_uid !== request.auth.uid || member.data()?.status !== "active") throw new HttpsError("permission-denied", "Somente o proprietário pode alterar o segmento.");
    const segment = segments.find(item => item.name === segmentName);
    if (!segment) throw new HttpsError("invalid-argument", "Segmento indisponível.");
    await organization.ref.set({ segmento:segment.name, atualizado_em:admin.firestore.FieldValue.serverTimestamp() }, { merge:true });
    return { saved:true, segment };
  });

  const saveOwnerProfile = onCall(options, async request => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Entre para alterar o perfil.");
    const organizationId = cleanId(request.data?.organizationId, HttpsError);
    const name = ownerProfileName(request.data?.name, HttpsError);
    const [organization, member] = await Promise.all([
      db.doc(`organizations/${organizationId}`).get(),
      db.doc(`organizations/${organizationId}/members/${request.auth.uid}`).get(),
    ]);
    if (!organization.exists || organization.data().proprietario_uid !== request.auth.uid || member.data()?.status !== "active") throw new HttpsError("permission-denied", "Somente o proprietário pode alterar o perfil.");
    await organization.ref.set({ nome:name, atualizado_em:admin.firestore.FieldValue.serverTimestamp(), perfil_atualizado_por:request.auth.uid }, { merge:true });
    return { saved:true, name };
  });

  const listAdminSegments = onCall(options, async request => {
    authorize(request);
    return { segments: await listSegments(db, admin, true, true) };
  });

  const saveAdminSegment = onCall(options, async request => {
    const actor = authorize(request);
    const segment = normalizeSegmentInput(request.data, cleanId, text, HttpsError);
    const ref = db.doc(`app_segments/${segment.id}`);
    const before = await ref.get();
    await ref.set({
      name: segment.name,
      screens: segment.screens,
      family: segment.family,
      modules: segment.modules,
      active: segment.active,
      sort_order: segment.sortOrder,
      schema_version: 4,
      created_at: before.exists ? (before.data().created_at || admin.firestore.FieldValue.serverTimestamp()) : admin.firestore.FieldValue.serverTimestamp(),
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
      updated_by: actor.uid,
    }, { merge: true });
    let migratedOrganizations = 0;
    const oldName = String(before.data()?.name || "");
    if (before.exists && oldName && oldName !== segment.name) {
      const organizations = await db.collection("organizations").where("segmento", "==", oldName).get();
      const writer = db.bulkWriter();
      for (const document of organizations.docs) {
        writer.set(document.ref, { segmento: segment.name, atualizado_em: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        migratedOrganizations += 1;
      }
      await writer.close();
    }
    await audit(actor, "segment.updated", "segment", segment.id, { name: segment.name, active: segment.active, family: segment.family, modules: segment.modules, screens: segment.screens, sortOrder: segment.sortOrder, migratedOrganizations });
    return { saved: true, segment };
  });

  const saveAdminPlan = onCall(options, async request => {
    const actor = authorize(request);
    if (request.data?.entity === "capacity_package") {
      let item;
      try { item = normalizeCapacityPackage(request.data, request.data?.id); }
      catch (error) { throw new HttpsError("invalid-argument", error.message); }
      const ref = db.doc(`capacity_packages/${item.id}`);
      await ref.set({ ...packageDocument(item), updated_at: admin.firestore.FieldValue.serverTimestamp(), updated_by: actor.uid }, { merge: true });
      if (item.featured) {
        const snapshot = await db.collection("capacity_packages").get();
        const batch = db.batch();
        for (const document of snapshot.docs) if (document.id !== item.id && document.data().featured === true) batch.set(document.ref, { featured: false, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        await batch.commit();
      }
      await audit(actor, "capacity_package.updated", "capacity_package", item.id, { name: item.name, priceCents: item.priceCents, reminders: item.reminders, appointments: item.appointments, active: item.active, featured: item.featured });
      return { saved: true, capacityPackage: item };
    }
    const id = cleanId(request.data?.id, HttpsError);
    const name = text(request.data?.name, 2, 100, "Nome do plano inválido.", HttpsError);
    const price = Number(request.data?.price);
    if (!Number.isFinite(price) || price < 0 || price > 100000) throw new HttpsError("invalid-argument", "Preço inválido.");
    const limits = normalizeLimits(request.data?.limits, defaultLimitsFor({ id, name }));
    const allowedFeatures = new Set(["customer_recovery", "appointment_confirmation", "waitlist", "quote_followup", "mini_crm", "post_sale_review"]);
    const features = Array.isArray(request.data?.features) ? [...new Set(request.data.features.map(value => String(value)).filter(value => allowedFeatures.has(value)))].slice(0, 6) : [];
    const payload = {
      name,
      price: Math.round(price * 100) / 100,
      title: optionalText(request.data?.title, 140, HttpsError),
      description: optionalText(request.data?.description, 500, HttpsError),
      subtitle: optionalText(request.data?.subtitle, 180, HttpsError),
      features,
      prefer: request.data?.prefer === true,
      freeTrial: request.data?.freeTrial === true,
      active: request.data?.active !== false,
      limits,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    };
    await db.doc(`plans/${id}`).set(payload, { merge: true });
    if (payload.freeTrial) {
      const plans = await db.collection("plans").get();
      const batch = db.batch();
      for (const plan of plans.docs) if (plan.id !== id && plan.data().freeTrial === true) batch.set(plan.ref, { freeTrial: false, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      await batch.commit();
    }
    await audit(actor, "plan.updated", "plan", id, { name, price: payload.price, limits });
    return { saved: true, plan: { id, ...payload, updated_at: null } };
  });

  const listAdminOrganizations = onCall(options, async request => {
    authorize(request);
    const search = String(request.data?.search || "").trim().toLocaleLowerCase("pt-BR").slice(0, 100);
    const status = String(request.data?.status || "all");
    const snapshot = await db.collection("organizations").get();
    let rows = snapshot.docs.map(document => ({ id: document.id, ...document.data() }));
    if (status !== "all") rows = rows.filter(item => item.status === status);
    if (search) rows = rows.filter(item => `${item.nome || ""} ${item.whatsapp || ""} ${item.plano_nome || ""}`.toLocaleLowerCase("pt-BR").includes(search));
    rows.sort((a, b) => timestamp(b.criado_em) - timestamp(a.criado_em));
    const limited = rows.slice(0, 200);
    const usageDocs = await Promise.all(limited.map(item => db.doc(`organizations/${item.id}/usage/${monthKey()}`).get()));
    return { organizations: limited.map((item, index) => ({
      id: item.id,
      name: item.nome || "Empresa sem nome",
      whatsapp: item.whatsapp || "",
      planId: item.plano_id || "",
      planName: item.plano_nome || "Sem plano",
      planPrice: Number(item.plano_preco || 0),
      status: item.status || "unknown",
      segment: item.segmento || "",
      ownerUid: item.proprietario_uid || "",
      createdAt: timestamp(item.criado_em),
      usage: sanitizeUsage(usageDocs[index].data()),
    })), total: rows.length, month: monthKey() };
  });

  const updateAdminOrganization = onCall(options, async request => {
    const actor = authorize(request);
    const organizationId = cleanId(request.data?.organizationId, HttpsError);
    const action = String(request.data?.action || "");
    const organizationRef = db.doc(`organizations/${organizationId}`);
    const organization = await organizationRef.get();
    if (!organization.exists) throw new HttpsError("not-found", "Empresa não encontrada.");
    const before = organization.data();
    let update;
    if (action === "change_plan") {
      const planId = cleanId(request.data?.planId, HttpsError);
      const plan = await db.doc(`plans/${planId}`).get();
      if (!plan.exists || plan.data().active === false) throw new HttpsError("failed-precondition", "Plano não encontrado ou inativo.");
      update = { plano_id: plan.id, plano_nome: plan.data().name, plano_preco: Number(plan.data().price), atualizado_em: admin.firestore.FieldValue.serverTimestamp() };
    } else if (action === "change_segment") {
      const segment = text(request.data?.segment, 2, 60, "Informe um segmento válido.", HttpsError);
      const allowedSegments = await listSegments(db, admin, false);
      if (!allowedSegments.some(item => item.name === segment)) throw new HttpsError("invalid-argument", "Segmento não reconhecido ou inativo.");
      update = { segmento: segment, atualizado_em: admin.firestore.FieldValue.serverTimestamp() };
    } else if (action === "suspend") {
      update = { status: "suspended", suspended_reason: text(request.data?.reason, 5, 300, "Informe o motivo da suspensão.", HttpsError), suspended_at: admin.firestore.FieldValue.serverTimestamp(), suspended_by: actor.uid, atualizado_em: admin.firestore.FieldValue.serverTimestamp() };
    } else if (action === "reactivate") {
      update = { status: before.plano_id ? "active" : "onboarding", suspended_reason: admin.firestore.FieldValue.delete(), suspended_at: admin.firestore.FieldValue.delete(), suspended_by: admin.firestore.FieldValue.delete(), atualizado_em: admin.firestore.FieldValue.serverTimestamp() };
    } else {
      throw new HttpsError("invalid-argument", "Ação administrativa inválida.");
    }
    await organizationRef.set(update, { merge: true });
    await audit(actor, `organization.${action}`, "organization", organizationId, { before: { planId: before.plano_id || "", status: before.status || "", segment: before.segmento || "" }, planId: update.plano_id || before.plano_id || "", segment: update.segmento || before.segmento || "", reason: update.suspended_reason || "" });
    return { saved: true };
  });

  const getAdminSupportView = onCall(options, async request => {
    const actor = authorize(request);
    const organizationId = cleanId(request.data?.organizationId, HttpsError);
    const reason = text(request.data?.reason, 10, 300, "Explique o motivo do acesso de suporte.", HttpsError);
    const root = db.doc(`organizations/${organizationId}`);
    const [organization, usage, professionals, services, appointments, conversations, whatsapp, mercadoPago] = await Promise.all([
      root.get(),
      root.collection("usage").doc(monthKey()).get(),
      root.collection("professionals").count().get(),
      root.collection("services").count().get(),
      root.collection("appointments").count().get(),
      root.collection("conversations").count().get(),
      root.collection("integrations").doc("whatsapp").get(),
      root.collection("integrations").doc("mercadopago").get(),
    ]);
    if (!organization.exists) throw new HttpsError("not-found", "Empresa não encontrada.");
    await audit(actor, "support.read", "organization", organizationId, { reason });
    const data = organization.data();
    return { organization: { id: organization.id, name: data.nome || "", status: data.status || "", planName: data.plano_nome || "Sem plano", createdAt: timestamp(data.criado_em) }, usage: sanitizeUsage(usage.data()), counts: { professionals: count(professionals), services: count(services), appointments: count(appointments), conversations: count(conversations) }, integrations: { whatsapp: whatsapp.data()?.active === true, mercadoPago: mercadoPago.data()?.active === true }, readOnly: true };
  });

  const listAdminAuditLogs = onCall(options, async request => {
    authorize(request);
    const snapshot = await db.collection("admin_audit_logs").orderBy("created_at", "desc").limit(100).get();
    return { logs: snapshot.docs.map(document => { const data = document.data(); return { id: document.id, actorEmail: data.actor_email || "", action: data.action || "", targetType: data.target_type || "", targetId: data.target_id || "", details: data.details || {}, createdAt: timestamp(data.created_at) }; }) };
  });

  function supportOrganization() {
    const value = typeof supportOrganizationId?.value === "function" ? supportOrganizationId.value() : supportOrganizationId;
    return cleanId(value, HttpsError);
  }

  const listAdminSupportConversations = onCall(options, async request => {
    authorize(request);
    const organizationId = supportOrganization();
    const snapshot = await db.collection(`organizations/${organizationId}/conversations`).orderBy("last_message_at", "desc").limit(100).get();
    return { conversations: snapshot.docs.map(document => supportConversation(document)), organizationId };
  });

  const listAdminSupportMessages = onCall(options, async request => {
    authorize(request);
    const organizationId = supportOrganization();
    const conversationId = cleanId(request.data?.conversationId, HttpsError);
    const conversation = await db.doc(`organizations/${organizationId}/conversations/${conversationId}`).get();
    if (!conversation.exists) throw new HttpsError("not-found", "Conversa não encontrada.");
    const snapshot = await conversation.ref.collection("messages").orderBy("sent_at", "desc").limit(150).get();
    return { conversation: supportConversation(conversation), messages: snapshot.docs.reverse().map(document => supportMessage(document)) };
  });

  const sendAdminSupportMessage = onCall(options, async request => {
    const actor = authorize(request);
    const organizationId = supportOrganization();
    const conversationId = cleanId(request.data?.conversationId, HttpsError);
    const body = text(request.data?.text, 1, 4096, "Digite uma mensagem de até 4.096 caracteres.", HttpsError);
    const [conversation, integration] = await Promise.all([
      db.doc(`organizations/${organizationId}/conversations/${conversationId}`).get(),
      db.doc(`organizations/${organizationId}/integrations/whatsapp`).get(),
    ]);
    if (!conversation.exists) throw new HttpsError("not-found", "Conversa não encontrada.");
    const credentials = integration.data() || {};
    const phone = String(conversation.data().phone || conversation.data().contact_phone || "").replace(/\D/g, "");
    if (!credentials.active || !credentials.access_token || !credentials.phone_number_id || !phone) throw new HttpsError("failed-precondition", "O WhatsApp de suporte não está pronto para enviar mensagens.");
    try {
      const version = /^v\d+\.\d+$/.test(String(credentials.graph_version || "")) ? credentials.graph_version : "v24.0";
      const sent = await axios.post(`https://graph.facebook.com/${version}/${credentials.phone_number_id}/messages`, {messaging_product: "whatsapp", recipient_type: "individual", to: phone, type: "text", text: {preview_url: false, body}}, {headers: {Authorization: `Bearer ${credentials.access_token}`, "Content-Type": "application/json"}, timeout: 15000});
      const providerId = String(sent.data?.messages?.[0]?.id || "");
      if (!providerId) throw new Error("A Meta não confirmou o envio.");
      const messageId = crypto.createHash("sha256").update(`message:${providerId}`).digest("hex");
      const now = admin.firestore.FieldValue.serverTimestamp();
      const batch = db.batch();
      batch.set(conversation.ref.collection("messages").doc(messageId), {provider_message_id: providerId, direction: "outbound", type: "text", text: body, status: "sent", sent_at: now, created_by: actor.uid, created_at: now});
      batch.set(conversation.ref, {last_message: body, last_message_at: now, last_direction: "outbound", unread_count: 0, status: "open", human_support: true, automation_paused: true, assigned_admin_uid: actor.uid, updated_at: now}, {merge: true});
      batch.set(db.doc(`meta_messages/${messageId}`), {organization_id: organizationId, conversation_id: conversationId, message_id: messageId, active: true, updated_at: now}, {merge: true});
      await batch.commit();
      return {sent: true, messageId};
    } catch (error) {
      throw new HttpsError("internal", String(error?.response?.data?.error?.error_user_msg || error?.response?.data?.error?.message || error?.message || "Não foi possível enviar.").slice(0, 300));
    }
  });

  const updateAdminSupportConversation = onCall(options, async request => {
    const actor = authorize(request);
    const organizationId = supportOrganization();
    const conversationId = cleanId(request.data?.conversationId, HttpsError);
    const status = String(request.data?.status || "open");
    if (!["open", "waiting", "closed"].includes(status)) throw new HttpsError("invalid-argument", "Status inválido.");
    const update = {status, unread_count: 0, updated_at: admin.firestore.FieldValue.serverTimestamp(), updated_by: actor.uid};
    if (status === "closed") Object.assign(update, {human_support: false, automation_paused: false, support_product: null, support_session_status: "closed", closed_at: admin.firestore.FieldValue.serverTimestamp()});
    else Object.assign(update, {human_support: true, automation_paused: true, assigned_admin_uid: actor.uid});
    await db.doc(`organizations/${organizationId}/conversations/${conversationId}`).set(update, {merge: true});
    return {updated: true, status};
  });

  return { getSiteMaintenance, setSiteMaintenance, getAdminOverview, listAdminPlans, saveAdminPlan, listAvailableSegments, getOwnerSettings, saveOwnerSegment, saveOwnerProfile, listAdminSegments, saveAdminSegment, listAdminOrganizations, updateAdminOrganization, getAdminSupportView, listAdminAuditLogs, listAdminSupportConversations, listAdminSupportMessages, sendAdminSupportMessage, updateAdminSupportConversation };
}

function cleanId(value, HttpsError) { const result = String(value || "").trim(); if (!/^[a-zA-Z0-9_-]{1,128}$/.test(result)) throw new HttpsError("invalid-argument", "Identificador inválido."); return result; }
function text(value, min, max, message, HttpsError) { const result = String(value || "").trim(); if (result.length < min || result.length > max) throw new HttpsError("invalid-argument", message); return result; }
function optionalText(value, max, HttpsError) { const result = String(value || "").trim(); if (result.length > max) throw new HttpsError("invalid-argument", "Texto muito longo."); return result; }
function ownerProfileName(value, HttpsError) { const result = text(value, 2, 80, "Informe um nome entre 2 e 80 caracteres.", HttpsError); if (/[\u0000-\u001f\u007f]/.test(result)) throw new HttpsError("invalid-argument", "O nome contém caracteres inválidos."); return result; }
function timestamp(value) { return typeof value?.toMillis === "function" ? value.toMillis() : 0; }
function count(snapshot) { return Number(snapshot.data().count || 0); }
function sanitizeUsage(data = {}) { return { appointments: Number(data.appointments || 0), reminders: Number(data.reminders || 0) }; }
function supportConversation(document) { const data = document.data() || {}; return {id: document.id, contactName: String(data.contact_name || data.profile_name || "Cliente do WhatsApp").slice(0, 120), phone: String(data.phone || data.contact_phone || "").slice(0, 30), lastMessage: String(data.last_message || "").slice(0, 1000), lastMessageAt: timestamp(data.last_message_at), lastDirection: String(data.last_direction || ""), unreadCount: Math.max(0, Number(data.unread_count || 0)), status: String(data.status || "open"), humanSupport: data.human_support === true, product: ["automichat", "smilecut"].includes(data.support_product) ? data.support_product : ""}; }
function supportMessage(document) { const data = document.data() || {}; return {id: document.id, direction: data.direction === "outbound" ? "outbound" : "inbound", type: String(data.type || "text"), text: String(data.text || (data.type ? `[${data.type}]` : "Mensagem")).slice(0, 4096), status: String(data.status || ""), sentAt: timestamp(data.sent_at || data.created_at)}; }

module.exports = { createAdminFunctions, ownerProfileName };
