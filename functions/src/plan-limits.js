const DEFAULT_LIMITS = Object.freeze({
  crescimento: { professionals: 2, appointmentsPerMonth: 200, remindersPerMonth: 400, flows: 1, pix: true, automations: "basic" },
  profissional: { professionals: 8, appointmentsPerMonth: 800, remindersPerMonth: 1600, flows: 3, pix: true, automations: "full" },
  negocios: { professionals: 20, appointmentsPerMonth: 2500, remindersPerMonth: 5000, flows: 10, pix: true, automations: "full" },
});

function slug(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function normalizeLimits(value, fallback = DEFAULT_LIMITS.crescimento) {
  const input = value && typeof value === "object" ? value : {};
  const integer = (key, defaultValue) => {
    const number = Number(input[key]);
    return Number.isInteger(number) && number >= 0 && number <= 1000000 ? number : defaultValue;
  };
  return {
    professionals: integer("professionals", fallback.professionals),
    appointmentsPerMonth: integer("appointmentsPerMonth", fallback.appointmentsPerMonth),
    remindersPerMonth: integer("remindersPerMonth", fallback.remindersPerMonth),
    flows: integer("flows", fallback.flows),
    pix: input.pix === undefined ? fallback.pix : input.pix === true,
    automations: input.automations === "full" ? "full" : input.automations === "basic" ? "basic" : fallback.automations,
  };
}

function defaultLimitsFor(plan = {}) {
  const key = slug(plan.slug || plan.name || plan.id);
  const fallback = key.includes("negocio") ? DEFAULT_LIMITS.negocios : key.includes("profissional") ? DEFAULT_LIMITS.profissional : DEFAULT_LIMITS.crescimento;
  return normalizeLimits(plan.limits, fallback);
}

async function entitlements(db, organizationId) {
  const organization = await db.doc(`organizations/${organizationId}`).get();
  if (!organization.exists) throw new Error("Empresa não encontrada.");
  const data = organization.data();
  const plan = data.plano_id ? await db.doc(`plans/${data.plano_id}`).get() : null;
  const planData = plan?.exists ? { id: plan.id, ...plan.data() } : { id: data.plano_id, name: data.plano_nome };
  return { organization: { id: organization.id, ...data }, plan: planData, limits: defaultLimitsFor(planData) };
}

function monthKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" }).format(date).slice(0, 7);
}

function limitError(HttpsError, label, limit) {
  return new HttpsError("resource-exhausted", `O limite do plano foi atingido: ${limit} ${label}. Altere o plano ou aguarde a renovação do ciclo.`);
}

function evaluateMonthlyConsumption({ usageData = {}, creditsData = {}, metric, limit, reference = "" }) {
  const current = Math.max(0, Number(usageData[metric] || 0));
  const referenceField = `${metric}_references`;
  const references = usageData[referenceField] || {};
  if (reference && references[reference]) return { duplicate: true };
  const creditBalance = Math.max(0, Number(creditsData[metric] || 0));
  const usesCredit = current >= limit;
  return {
    duplicate: false,
    allowed: !usesCredit || creditBalance > 0,
    usesCredit,
    current,
    referenceField,
    references,
    creditBalance,
  };
}

async function assertFeature(db, organizationId, feature, HttpsError) {
  const access = await entitlements(db, organizationId);
  if (access.organization.status === "suspended") throw new HttpsError("permission-denied", "Esta empresa está suspensa. Fale com o suporte.");
  if (access.limits[feature] !== true && access.limits[feature] !== "full") throw new HttpsError("failed-precondition", "Este recurso não está disponível no plano atual.");
  return access;
}

async function assertCollectionLimit(db, organizationId, collectionName, limitKey, HttpsError) {
  const access = await entitlements(db, organizationId);
  if (access.organization.status === "suspended") throw new HttpsError("permission-denied", "Esta empresa está suspensa. Fale com o suporte.");
  const snapshot = await db.collection(`organizations/${organizationId}/${collectionName}`).where("active", "==", true).count().get();
  const count = Number(snapshot.data().count || 0);
  const limit = access.limits[limitKey];
  if (count >= limit) throw limitError(HttpsError, limitKey === "flows" ? "Flows" : "profissionais", limit);
  return access;
}

async function consumeMonthly(db, admin, organizationId, metric, limitKey, HttpsError, reference = "") {
  const access = await entitlements(db, organizationId);
  const limit = access.limits[limitKey];
  const key = monthKey();
  const usageRef = db.doc(`organizations/${organizationId}/usage/${key}`);
  const creditsRef = db.doc(`organizations/${organizationId}/capacity/credits`);
  await db.runTransaction(async transaction => {
    const [usage, credits] = await Promise.all([transaction.get(usageRef), transaction.get(creditsRef)]);
    const result = evaluateMonthlyConsumption({ usageData: usage.data(), creditsData: credits.data(), metric, limit, reference });
    if (result.duplicate) return;
    if (!result.allowed) throw limitError(HttpsError, metric === "reminders" ? "lembretes neste mês" : "agendamentos neste mês", limit);
    transaction.set(usageRef, {
      month: key,
      [metric]: result.current + 1,
      ...(reference ? { [result.referenceField]: { ...result.references, [reference]: true } } : {}),
      ...(result.usesCredit && reference ? { [`${metric}_credit_references`]: { ...(usage.data()?.[`${metric}_credit_references`] || {}), [reference]: true } } : {}),
      ...(result.usesCredit ? { [`${metric}_credits_used`]: admin.firestore.FieldValue.increment(1) } : {}),
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    if (result.usesCredit) transaction.set(creditsRef, {
      [metric]: result.creditBalance - 1,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });
  return access;
}

async function releaseMonthly(db, admin, organizationId, metric, reference = "") {
  if (!reference) return;
  const key = monthKey();
  const usageRef = db.doc(`organizations/${organizationId}/usage/${key}`);
  const creditsRef = db.doc(`organizations/${organizationId}/capacity/credits`);
  await db.runTransaction(async transaction => {
    const [usage, credits] = await Promise.all([transaction.get(usageRef), transaction.get(creditsRef)]);
    const data = usage.data() || {};
    const referenceField = `${metric}_references`;
    const creditReferenceField = `${metric}_credit_references`;
    const references = { ...(data[referenceField] || {}) };
    if (!references[reference]) return;
    const creditReferences = { ...(data[creditReferenceField] || {}) };
    const usedCredit = creditReferences[reference] === true;
    delete references[reference];
    delete creditReferences[reference];
    transaction.set(usageRef, {
      [metric]: Math.max(0, Number(data[metric] || 0) - 1),
      [referenceField]: references,
      [creditReferenceField]: creditReferences,
      ...(usedCredit ? { [`${metric}_credits_used`]: Math.max(0, Number(data[`${metric}_credits_used`] || 0) - 1) } : {}),
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    if (usedCredit) transaction.set(creditsRef, {
      [metric]: Math.max(0, Number(credits.data()?.[metric] || 0)) + 1,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });
}

async function withAutomatedMessage({ db, admin, organizationId, HttpsError, reference, send }) {
  await consumeMonthly(db, admin, organizationId, "reminders", "remindersPerMonth", HttpsError, reference);
  try {
    return await send();
  } catch (error) {
    await releaseMonthly(db, admin, organizationId, "reminders", reference);
    throw error;
  }
}

module.exports = { DEFAULT_LIMITS, normalizeLimits, defaultLimitsFor, entitlements, monthKey, assertFeature, assertCollectionLimit, consumeMonthly, releaseMonthly, withAutomatedMessage, evaluateMonthlyConsumption };
