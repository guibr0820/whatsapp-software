const crypto = require("node:crypto");

function createCustomerFunctions({ admin, db, onCall, HttpsError }) {
  const region = "southamerica-east1";

  const listCustomers = onCall({ region }, async (request) => {
    const { organizationId } = await authorize(request, false);
    const [customerSnapshot, conversationSnapshot, appointmentSnapshot] = await Promise.all([
      db.collection(`organizations/${organizationId}/customers`).limit(1000).get(),
      db.collection(`organizations/${organizationId}/conversations`).limit(1000).get(),
      db.collection(`organizations/${organizationId}/appointments`).limit(2000).get(),
    ]);

    const customers = new Map();
    for (const document of customerSnapshot.docs) {
      const data = document.data();
      const phoneKey = normalizePhone(data.phone || data.phone_key, false);
      if (!phoneKey) continue;
      customers.set(phoneKey, { id: document.id, ...data, phone: phoneKey, phone_key: phoneKey });
    }

    for (const document of conversationSnapshot.docs) {
      const data = document.data();
      const phoneKey = normalizePhone(data.contact_phone, false);
      if (!phoneKey) continue;
      const current = customers.get(phoneKey) || {};
      customers.set(phoneKey, {
        source: "whatsapp",
        status: "active",
        tags: [],
        notes: "",
        email: "",
        ...current,
        id: current.id || customerId(phoneKey),
        phone: phoneKey,
        phone_key: phoneKey,
        name: current.name || data.contact_name || data.profile_name || "Cliente do WhatsApp",
        conversation_id: document.id,
        last_contact_at: data.last_message_at || current.last_contact_at || null,
      });
    }

    const stats = new Map();
    const now = Date.now();
    for (const document of appointmentSnapshot.docs) {
      const data = document.data();
      const phoneKey = normalizePhone(data.customer_phone || data.phone || data.contact_phone, false);
      if (!phoneKey) continue;
      const entry = stats.get(phoneKey) || { appointments: 0, completed: 0, cancelled: 0, no_show: 0, next: null };
      entry.appointments += 1;
      if (data.status === "completed") entry.completed += 1;
      if (data.status === "cancelled") entry.cancelled += 1;
      if (data.status === "no_show") entry.no_show += 1;
      const date = appointmentDate(data);
      if (date && date.getTime() >= now && data.status !== "cancelled" && data.status !== "no_show") {
        if (!entry.next || date.getTime() < entry.next.date.getTime()) {
          entry.next = { id: document.id, date, service: data.service_name || data.service || "Atendimento", status: data.status || "confirmed" };
        }
      }
      stats.set(phoneKey, entry);
    }

    const items = [];
    for (const [phoneKey, customer] of customers) {
      if (customer.archived === true) continue;
      const customerStats = stats.get(phoneKey) || { appointments: 0, completed: 0, cancelled: 0, no_show: 0, next: null };
      items.push({
        ...customer,
        appointments_count: customerStats.appointments,
        completed_count: customerStats.completed,
        cancelled_count: customerStats.cancelled,
        no_show_count: customerStats.no_show,
        next_appointment: customerStats.next ? {
          id: customerStats.next.id,
          at: customerStats.next.date.toISOString(),
          service: customerStats.next.service,
          status: customerStats.next.status,
        } : null,
      });
    }
    items.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "pt-BR"));
    return { customers: items };
  });

  const saveCustomer = onCall({ region }, async (request) => {
    const { organizationId, uid } = await authorize(request, true);
    let payload;
    try { payload = customerPayload(request.data?.customer); }
    catch (error) { throw new HttpsError(error.code || "invalid-argument", error.message || "Dados inválidos."); }

    const targetId = customerId(payload.phone_key);
    const targetRef = db.doc(`organizations/${organizationId}/customers/${targetId}`);
    const previousId = optionalId(request.data?.id);
    const previousRef = previousId && previousId !== targetId
      ? db.doc(`organizations/${organizationId}/customers/${previousId}`)
      : null;
    const [existing, previous] = await Promise.all([targetRef.get(), previousRef ? previousRef.get() : Promise.resolve(null)]);
    const now = admin.firestore.FieldValue.serverTimestamp();
    const batch = db.batch();
    batch.set(targetRef, {
      ...payload,
      archived: false,
      source: existing.data()?.source || previous?.data()?.source || "manual",
      conversation_id: existing.data()?.conversation_id || previous?.data()?.conversation_id || "",
      last_contact_at: existing.data()?.last_contact_at || previous?.data()?.last_contact_at || null,
      created_at: existing.data()?.created_at || previous?.data()?.created_at || now,
      created_by: existing.data()?.created_by || previous?.data()?.created_by || uid,
      updated_at: now,
      updated_by: uid,
    }, { merge: false });
    if (previousRef && previous?.exists) batch.delete(previousRef);
    await batch.commit();
    return { id: targetId, saved: true };
  });

  const deleteCustomer = onCall({ region }, async (request) => {
    const { organizationId, uid } = await authorize(request, true);
    const phone = normalizePhone(request.data?.phone, true);
    const id = customerId(phone);
    const ref = db.doc(`organizations/${organizationId}/customers/${id}`);
    const existing = await ref.get();
    await ref.set({
      ...(existing.exists ? existing.data() : {
        name: "Cliente removido",
        name_key: "cliente removido",
        phone,
        phone_key: phone,
        email: "",
        notes: "",
        tags: [],
        status: "inactive",
        source: "manual",
        conversation_id: "",
        last_contact_at: null,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
        created_by: uid,
      }),
      archived: true,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
      updated_by: uid,
    }, { merge: false });
    return { deleted: true };
  });

  async function authorize(request, ownerOnly) {
    if (!request.auth) throw new HttpsError("unauthenticated", "Faça login para acessar os clientes.");
    const organizationId = requiredId(request.data?.organizationId);
    const [organization, membership] = await Promise.all([
      db.doc(`organizations/${organizationId}`).get(),
      db.doc(`organizations/${organizationId}/members/${request.auth.uid}`).get(),
    ]);
    if (!organization.exists || !membership.exists || membership.data()?.status !== "active") {
      throw new HttpsError("permission-denied", "Você não possui acesso a esta empresa.");
    }
    if (organization.data()?.status === "suspended") throw new HttpsError("permission-denied", "Esta empresa está suspensa. Fale com o suporte.");
    if (ownerOnly && organization.data()?.proprietario_uid !== request.auth.uid) {
      throw new HttpsError("permission-denied", "Somente o proprietário pode alterar clientes.");
    }
    return { organizationId, uid: request.auth.uid };
  }

  return { listCustomers, saveCustomer, deleteCustomer };
}

function customerPayload(input) {
  const customer = input && typeof input === "object" ? input : {};
  const name = text(customer.name, 2, 100, "Informe o nome do cliente.");
  const phone = normalizePhone(customer.phone, true);
  const email = optionalText(customer.email, 254).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw error("invalid-argument", "E-mail inválido.");
  const notes = optionalText(customer.notes, 1000);
  const status = String(customer.status || "active");
  if (!['new', 'active', 'inactive'].includes(status)) throw error("invalid-argument", "Status inválido.");
  const tags = Array.isArray(customer.tags)
    ? [...new Set(customer.tags.map((tag) => optionalText(tag, 30)).filter(Boolean))].slice(0, 12)
    : [];
  return { name, name_key: normalizeName(name), phone, phone_key: phone, email, notes, tags, status };
}

function normalizePhone(value, required) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits && !digits.startsWith("55") && (digits.length === 10 || digits.length === 11)) digits = `55${digits}`;
  if (!digits) {
    if (required) throw error("invalid-argument", "Informe o WhatsApp do cliente.");
    return "";
  }
  if (!/^55\d{10,11}$/.test(digits)) {
    if (required) throw error("invalid-argument", "Informe um WhatsApp brasileiro com DDD.");
    return "";
  }
  return digits;
}

function customerId(phone) { return crypto.createHash("sha256").update(`customer:${phone}`).digest("hex").slice(0, 40); }
function requiredId(value) { const id = String(value || "").trim(); if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("Empresa inválida."); return id; }
function optionalId(value) { const id = String(value || "").trim(); return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : ""; }
function normalizeName(value) { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR"); }
function text(value, min, max, message) { const result = String(value || "").trim(); if (result.length < min || result.length > max) throw error("invalid-argument", message); return result; }
function optionalText(value, max) { const result = String(value || "").trim(); if (result.length > max) throw error("invalid-argument", "Texto muito longo."); return result; }
function error(code, message) { const instance = new Error(message); instance.code = code; return instance; }
function appointmentDate(data) {
  const rawDate = String(data.appointment_date || data.date || "");
  const rawTime = String(data.appointment_time || data.time || "00:00");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate) || !/^\d{2}:\d{2}$/.test(rawTime)) return null;
  const date = new Date(`${rawDate}T${rawTime}:00-03:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

module.exports = { createCustomerFunctions, customerPayload, normalizePhone, customerId };
