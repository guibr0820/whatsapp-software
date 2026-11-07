const crypto = require("node:crypto");

function createCustomerFunctions({ admin, db, onCall, HttpsError }) {
  const region = "southamerica-east1";

  const listCustomers = onCall({ region }, async (request) => {
    const { organizationId } = await authorize(request, false);
    const [customerSnapshot, conversationSnapshot, appointmentSnapshot, orderSnapshot] = await Promise.all([
      db.collection(`organizations/${organizationId}/customers`).limit(1000).get(),
      db.collection(`organizations/${organizationId}/conversations`).limit(1000).get(),
      db.collection(`organizations/${organizationId}/appointments`).limit(2000).get(),
      db.collection(`organizations/${organizationId}/orders`).limit(2000).get(),
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
      const current = customers.get(phoneKey) || {};
      customers.set(phoneKey, {
        source: "appointment",
        status: "active",
        tags: [],
        notes: "",
        email: String(data.customer_email || "").trim().toLowerCase(),
        ...current,
        id: current.id || customerId(phoneKey),
        phone: phoneKey,
        phone_key: phoneKey,
        name: current.name || data.customer_name || "Cliente",
      });
      const entry = stats.get(phoneKey) || { appointments: 0, completed: 0, cancelled: 0, no_show: 0, next: null, history: [] };
      entry.appointments += 1;
      if (data.status === "completed") entry.completed += 1;
      if (data.status === "cancelled") entry.cancelled += 1;
      if (data.status === "no_show") entry.no_show += 1;
      const date = appointmentDate(data);
      entry.history.push({
        id: document.id,
        service: String(data.service || data.service_name || "Atendimento"),
        professional: String(data.professional || data.professional_name || ""),
        status: String(data.status || "confirmed"),
        payment_status: String(data.payment_status || "onsite"),
        total_price: Number(data.total_price || 0),
        at: date ? date.toISOString() : null,
      });
      if (date && date.getTime() >= now && data.status !== "cancelled" && data.status !== "no_show") {
        if (!entry.next || date.getTime() < entry.next.date.getTime()) {
          entry.next = { id: document.id, date, service: data.service_name || data.service || "Atendimento", status: data.status || "confirmed" };
        }
      }
      stats.set(phoneKey, entry);
    }

    const orderStats = new Map();
    for (const document of orderSnapshot.docs) {
      const data = document.data();
      const phoneKey = normalizePhone(data.customer_phone || data.customer?.phone, false);
      if (!phoneKey) continue;
      const current = customers.get(phoneKey) || {};
      const orderEmail = String(data.customer?.email || data.payment?.customer_email || "").trim().toLowerCase();
      const address = normalizeStoredAddress(data.address);
      customers.set(phoneKey, {
        source: "order",
        status: "active",
        tags: [],
        notes: "",
        email: orderEmail,
        ...current,
        id: current.id || customerId(phoneKey),
        phone: phoneKey,
        phone_key: phoneKey,
        name: current.name || data.customer_name || data.customer?.name || "Cliente",
        email: current.email || orderEmail,
        last_address: current.last_address || (data.fulfillment_type === "delivery" ? address : null),
      });
      const entry = orderStats.get(phoneKey) || { orders: 0, completed: 0, paid: 0, totalSpentCents: 0, latest: null, history: [] };
      entry.orders += 1;
      if (data.status === "completed") entry.completed += 1;
      if (data.payment?.status === "paid") entry.paid += 1;
      if (data.status === "completed" || data.payment?.status === "paid") entry.totalSpentCents += Number(data.total_cents || 0);
      const createdAt = timestampMillis(data.created_at) || timestampMillis(data.updated_at);
      const summary = {
        id: document.id,
        number: String(data.number || ""),
        status: String(data.status || "awaiting_data"),
        payment_status: String(data.payment?.status || "pending"),
        total_cents: Number(data.total_cents || 0),
        fulfillment_type: String(data.fulfillment_type || "pending"),
        address: data.fulfillment_type === "delivery" ? address : null,
        items: Array.isArray(data.items) ? data.items.slice(0, 8).map((item) => ({ name: String(item.name || "Produto"), quantity: Number(item.quantity || 0) })) : [],
        at: createdAt ? new Date(createdAt).toISOString() : null,
      };
      entry.history.push(summary);
      if (!entry.latest || createdAt > entry.latest.createdAt) entry.latest = { ...summary, createdAt };
      orderStats.set(phoneKey, entry);
    }

    const items = [];
    for (const [phoneKey, customer] of customers) {
      if (customer.archived === true) continue;
      const customerStats = stats.get(phoneKey) || { appointments: 0, completed: 0, cancelled: 0, no_show: 0, next: null, history: [] };
      const customerOrders = orderStats.get(phoneKey) || { orders: 0, completed: 0, paid: 0, totalSpentCents: 0, latest: null, history: [] };
      items.push({
        ...customer,
        appointments_count: customerStats.appointments,
        completed_count: customerStats.completed,
        cancelled_count: customerStats.cancelled,
        no_show_count: customerStats.no_show,
        appointment_history: customerStats.history.sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))).slice(0, 20),
        orders_count: customerOrders.orders,
        completed_orders_count: customerOrders.completed,
        paid_orders_count: customerOrders.paid,
        total_spent_cents: customerOrders.totalSpentCents,
        last_order: customerOrders.latest ? withoutInternalFields(customerOrders.latest) : null,
        last_address: customer.last_address || customerOrders.latest?.address || null,
        order_history: customerOrders.history.sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))).slice(0, 20),
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
    const base = existing.data() || previous?.data() || {};
    const consentWasActive = base.marketing_consent === true;
    const batch = db.batch();
    batch.set(targetRef, {
      ...base,
      ...payload,
      archived: false,
      source: base.source || "manual",
      conversation_id: base.conversation_id || "",
      last_contact_at: base.last_contact_at || null,
      last_activity_at: payload.marketing_consent && !consentWasActive ? now : (base.last_activity_at || base.last_contact_at || base.created_at || now),
      marketing_consent_at: payload.marketing_consent ? (consentWasActive ? base.marketing_consent_at || now : now) : null,
      marketing_consent_source: payload.marketing_consent ? (consentWasActive ? base.marketing_consent_source || "owner_recorded" : "owner_recorded") : "",
      recovery_last_sent_at: payload.marketing_consent && !consentWasActive ? null : (base.recovery_last_sent_at || null),
      recovery_last_reference: payload.marketing_consent && !consentWasActive ? "" : (base.recovery_last_reference || ""),
      created_at: base.created_at || now,
      created_by: base.created_by || uid,
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
  const marketingConsent = customer.marketingConsent === true || customer.marketing_consent === true;
  return { name, name_key: normalizeName(name), phone, phone_key: phone, email, notes, tags, status, marketing_consent: marketingConsent };
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

function timestampMillis(value) {
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (typeof value?.seconds === "number") return value.seconds * 1000;
  return 0;
}

function normalizeStoredAddress(value) {
  const address = value && typeof value === "object" ? value : {};
  return {
    street: String(address.street || ""),
    number: String(address.number || ""),
    district: String(address.district || ""),
    city: String(address.city || ""),
    state: String(address.state || ""),
    postal_code: String(address.postal_code || ""),
    complement: String(address.complement || ""),
    reference: String(address.reference || ""),
    line: String(address.line || ""),
  };
}

function withoutInternalFields(value) {
  const { createdAt, ...publicValue } = value;
  return publicValue;
}

module.exports = { createCustomerFunctions, customerPayload, normalizePhone, customerId };
