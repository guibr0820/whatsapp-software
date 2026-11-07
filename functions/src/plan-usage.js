const { entitlements, monthKey } = require("./plan-limits");
const { listCapacityPackages } = require("./capacity-packages");

function timestampMillis(value) {
  if (value?.toMillis) return value.toMillis();
  const parsed = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function monthBounds(key) {
  const [year, month] = key.split("-").map(Number);
  return {
    start: Date.UTC(year, month - 1, 1, 3),
    end: Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1, 3),
  };
}

async function reconcileMonthlyUsage(db, admin, organizationId, key) {
  const usageRef = db.doc(`organizations/${organizationId}/usage/${key}`);
  const previous = await usageRef.get();
  if (previous.data()?.automation_history_reconciled_v2 === true) return previous;

  const appointments = await db.collection(`organizations/${organizationId}/appointments`).get();
  const { start, end } = monthBounds(key);
  const appointmentReferences = {};
  const reminderReferences = {};
  const reminderProviderIds = new Set();
  for (const document of appointments.docs) {
    const data = document.data();
    const createdAt = timestampMillis(data.created_at || data.scheduled_at);
    const reminderAt = timestampMillis(data.reminder_sent_at);
    if (createdAt >= start && createdAt < end) appointmentReferences[document.id] = true;
    if ((reminderAt >= start && reminderAt < end) || (data.reminder_status === "sent" && createdAt >= start && createdAt < end)) {
      reminderReferences[document.id] = true;
      if (data.reminder_provider_message_id) reminderProviderIds.add(String(data.reminder_provider_message_id));
    }
  }

  const conversations = await db.collection(`organizations/${organizationId}/conversations`).get();
  for (const conversation of conversations.docs) {
    const messages = await conversation.ref.collection("messages").get();
    for (const message of messages.docs) {
      const data = message.data();
      const createdAt = timestampMillis(data.created_at || data.sent_at);
      const automated = data.direction === "outbound" && (data.type === "flow" || ["automation", "order_automation", "cart_automation"].includes(data.created_by));
      const providerId = String(data.provider_message_id || "");
      if (!automated || createdAt < start || createdAt >= end || reminderProviderIds.has(providerId)) continue;
      reminderReferences[`message_${message.id}`] = true;
    }
  }

  await db.runTransaction(async transaction => {
    const current = await transaction.get(usageRef);
    if (current.data()?.automation_history_reconciled_v2 === true) return;
    const appointmentsMerged = { ...(current.data()?.appointments_references || {}), ...appointmentReferences };
    const remindersMerged = { ...(current.data()?.reminders_references || {}), ...reminderReferences };
    transaction.set(usageRef, {
      month: key,
      appointments: Math.max(Number(current.data()?.appointments || 0), Object.keys(appointmentsMerged).length),
      reminders: Math.max(Number(current.data()?.reminders || 0), Object.keys(remindersMerged).length),
      appointments_references: appointmentsMerged,
      reminders_references: remindersMerged,
      history_reconciled: true,
      history_reconciled_at: admin.firestore.FieldValue.serverTimestamp(),
      automation_history_reconciled_v2: true,
      automation_history_reconciled_v2_at: admin.firestore.FieldValue.serverTimestamp(),
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });
  return usageRef.get();
}

function createPlanUsageFunctions({ db, admin, onCall, HttpsError }) {
  const getPlanUsage = onCall({ region: "southamerica-east1", cors: true }, async request => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Faça login para consultar o uso do plano.");
    const organizationId = String(request.data?.organizationId || "");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(organizationId)) throw new HttpsError("invalid-argument", "Empresa inválida.");

    const key = monthKey();
    const [access, membership] = await Promise.all([
      entitlements(db, organizationId),
      db.doc(`organizations/${organizationId}/members/${request.auth.uid}`).get(),
    ]);
    if (access.organization.status === "suspended" || !membership.exists || membership.data()?.status !== "active") throw new HttpsError("permission-denied", access.organization.status === "suspended" ? "Esta empresa está suspensa. Fale com o suporte." : "Você não possui acesso a esta empresa.");
    const [usage, creditsSnapshot, capacityPackages] = await Promise.all([
      reconcileMonthlyUsage(db, admin, organizationId, key),
      db.doc(`organizations/${organizationId}/capacity/credits`).get(),
      listCapacityPackages(db, admin, true),
    ]);

    const now = new Date();
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
    const daysInMonth = new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate();
    const nextMonth = parts.month === 12 ? { year: parts.year + 1, month: 1 } : { year: parts.year, month: parts.month + 1 };
    const data = usage.data() || {};
    const appointments = Math.max(0, Number(data.appointments || 0));
    const reminders = Math.max(0, Number(data.reminders || 0));
    const appointmentLimit = access.limits.appointmentsPerMonth;
    const reminderLimit = access.limits.remindersPerMonth;
    const credits = { appointments: Math.max(0, Number(creditsSnapshot.data()?.appointments || 0)), reminders: Math.max(0, Number(creditsSnapshot.data()?.reminders || 0)) };
    const project = value => Math.max(value, Math.round((value / Math.max(1, parts.day)) * daysInMonth));

    return {
      month: key,
      plan: { id: access.plan.id || access.organization.plano_id || "", name: access.plan.name || access.organization.plano_nome || "Sem plano" },
      usage: { appointments, reminders, messages: reminders },
      limits: { appointments: appointmentLimit, reminders: reminderLimit, messages: reminderLimit },
      remaining: { appointments: Math.max(0, appointmentLimit - appointments) + credits.appointments, reminders: Math.max(0, reminderLimit - reminders) + credits.reminders, messages: Math.max(0, reminderLimit - reminders) + credits.reminders },
      credits,
      percentage: { appointments: appointmentLimit ? Math.min(100, Math.round(appointments / appointmentLimit * 100)) : 100, reminders: reminderLimit ? Math.min(100, Math.round(reminders / reminderLimit * 100)) : 100, messages: reminderLimit ? Math.min(100, Math.round(reminders / reminderLimit * 100)) : 100 },
      projection: { appointments: project(appointments), reminders: project(reminders), reminderExcess: Math.max(0, project(reminders) - reminderLimit) },
      cycle: { day: parts.day, daysInMonth, renewsOn: `${nextMonth.year}-${String(nextMonth.month).padStart(2, "0")}-01` },
      capacityPackages: capacityPackages.map(item => ({ ...item, price: item.priceCents / 100, automaticCharge: false })),
      extraPackage: capacityPackages.length ? { ...capacityPackages[0], price: capacityPackages[0].priceCents / 100, automaticCharge: false } : null,
    };
  });

  return { getPlanUsage };
}

module.exports = { createPlanUsageFunctions, reconcileMonthlyUsage, monthBounds, timestampMillis };
