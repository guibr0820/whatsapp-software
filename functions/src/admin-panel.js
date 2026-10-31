const { normalizeLimits, defaultLimitsFor, monthKey } = require("./plan-limits");
const { normalizeCapacityPackage, packageDocument, listCapacityPackages } = require("./capacity-packages");
const { listSegments, normalizeSegmentInput } = require("./segment-config");

function createAdminFunctions({ admin, db, onCall, HttpsError }) {
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
      return { id: document.id, name: data.name || document.id, price: Number(data.price || 0), title: data.title || "", description: data.description || "", subtitle: data.subtitle || "", prefer: data.prefer === true, active: data.active !== false, limits: defaultLimitsFor({ id: document.id, ...data }) };
    }).sort((a, b) => a.price - b.price), capacityPackages };
  });

  const listAvailableSegments = onCall(options, async request => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Entre para carregar os segmentos.");
    return { segments: await listSegments(db, admin, request.data?.includeInactive === true) };
  });

  const listAdminSegments = onCall(options, async request => {
    authorize(request);
    return { segments: await listSegments(db, admin, true) };
  });

  const saveAdminSegment = onCall(options, async request => {
    const actor = authorize(request);
    const segment = normalizeSegmentInput(request.data, cleanId, text, HttpsError);
    const ref = db.doc(`app_segments/${segment.id}`);
    const before = await ref.get();
    await ref.set({
      name: segment.name,
      screens: segment.screens,
      active: segment.active,
      sort_order: segment.sortOrder,
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
    await audit(actor, "segment.updated", "segment", segment.id, { name: segment.name, active: segment.active, screens: segment.screens, sortOrder: segment.sortOrder, migratedOrganizations });
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
    const payload = {
      name,
      price: Math.round(price * 100) / 100,
      title: optionalText(request.data?.title, 140, HttpsError),
      description: optionalText(request.data?.description, 500, HttpsError),
      subtitle: optionalText(request.data?.subtitle, 180, HttpsError),
      prefer: request.data?.prefer === true,
      active: request.data?.active !== false,
      limits,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    };
    await db.doc(`plans/${id}`).set(payload, { merge: true });
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

  return { getSiteMaintenance, setSiteMaintenance, getAdminOverview, listAdminPlans, saveAdminPlan, listAvailableSegments, listAdminSegments, saveAdminSegment, listAdminOrganizations, updateAdminOrganization, getAdminSupportView, listAdminAuditLogs };
}

function cleanId(value, HttpsError) { const result = String(value || "").trim(); if (!/^[a-zA-Z0-9_-]{1,128}$/.test(result)) throw new HttpsError("invalid-argument", "Identificador inválido."); return result; }
function text(value, min, max, message, HttpsError) { const result = String(value || "").trim(); if (result.length < min || result.length > max) throw new HttpsError("invalid-argument", message); return result; }
function optionalText(value, max, HttpsError) { const result = String(value || "").trim(); if (result.length > max) throw new HttpsError("invalid-argument", "Texto muito longo."); return result; }
function timestamp(value) { return typeof value?.toMillis === "function" ? value.toMillis() : 0; }
function count(snapshot) { return Number(snapshot.data().count || 0); }
function sanitizeUsage(data = {}) { return { appointments: Number(data.appointments || 0), reminders: Number(data.reminders || 0) }; }

module.exports = { createAdminFunctions };
