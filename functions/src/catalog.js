function createCatalogFunctions({ admin, db, onCall, HttpsError }) {
  const region = "southamerica-east1";
  const collections = {
    service: "services",
    option: "service_options",
    professional: "professionals",
  };

  const listCatalog = onCall({ region }, async (request) => {
    const { organizationId } = await authorize(request, false);
    const entries = await Promise.all(Object.entries(collections).map(async ([type, collectionName]) => {
      const snapshot = await db.collection(`organizations/${organizationId}/${collectionName}`).orderBy("name").get();
      return [type, snapshot.docs.map((document) => ({ id: document.id, ...document.data() }))];
    }));
    return Object.fromEntries(entries.map(([type, items]) => [`${type}s`, items]));
  });

  const saveCatalogItem = onCall({ region }, async (request) => {
    const { organizationId, uid } = await authorize(request, true);
    let type;
    let itemId;
    let data;
    try {
      type = normalizeType(request.data?.type);
      itemId = normalizeOptionalId(request.data?.id);
      data = type === "professional" ? professionalPayload(request.data?.item) : catalogItemPayload(request.data?.item, type);
    } catch (error) {
      throw new HttpsError(error.code || "invalid-argument", error.message || "Dados inválidos.");
    }
    const collectionRef = db.collection(`organizations/${organizationId}/${collections[type]}`);
    const duplicate = await collectionRef.where("name_key", "==", data.name_key).limit(2).get();
    if (duplicate.docs.some((document) => document.id !== itemId)) {
      throw new HttpsError("already-exists", `Já existe ${type === "professional" ? "um profissional" : "um item"} com este nome.`);
    }
    const now = admin.firestore.FieldValue.serverTimestamp();
    const ref = itemId ? collectionRef.doc(itemId) : collectionRef.doc();
    const previous = itemId ? await ref.get() : null;
    if (itemId && !previous.exists) throw new HttpsError("not-found", "Cadastro não encontrado.");
    await ref.set({
      ...data,
      updated_at: now,
      updated_by: uid,
      ...(previous?.exists
        ? { created_at: previous.data().created_at, created_by: previous.data().created_by }
        : { created_at: now, created_by: uid }),
    }, { merge: false });
    return { id: ref.id, saved: true };
  });

  const setCatalogItemActive = onCall({ region }, async (request) => {
    const { organizationId, uid } = await authorize(request, true);
    let type;
    let itemId;
    try { type = normalizeType(request.data?.type); itemId = normalizeRequiredId(request.data?.id); }
    catch (error) { throw new HttpsError(error.code || "invalid-argument", error.message || "Dados inválidos."); }
    const active = request.data?.active === true;
    const ref = db.doc(`organizations/${organizationId}/${collections[type]}/${itemId}`);
    if (!(await ref.get()).exists) throw new HttpsError("not-found", "Cadastro não encontrado.");
    await ref.update({ active, updated_at: admin.firestore.FieldValue.serverTimestamp(), updated_by: uid });
    return { updated: true };
  });

  async function authorize(request, ownerOnly) {
    if (!request.auth) throw new HttpsError("unauthenticated", "Faça login para acessar o catálogo.");
    let organizationId;
    try { organizationId = normalizeRequiredId(request.data?.organizationId); }
    catch (error) { throw new HttpsError("invalid-argument", error.message); }
    const [organization, membership] = await Promise.all([
      db.doc(`organizations/${organizationId}`).get(),
      db.doc(`organizations/${organizationId}/members/${request.auth.uid}`).get(),
    ]);
    if (!organization.exists || !membership.exists || membership.data()?.status !== "active") {
      throw new HttpsError("permission-denied", "Você não possui acesso a esta empresa.");
    }
    if (ownerOnly && organization.data()?.proprietario_uid !== request.auth.uid) {
      throw new HttpsError("permission-denied", "Somente o proprietário pode alterar o catálogo.");
    }
    return { organizationId, uid: request.auth.uid };
  }

  return { listCatalog, saveCatalogItem, setCatalogItemActive };
}

function catalogItemPayload(input, type) {
  const item = input && typeof input === "object" ? input : {};
  const name = text(item.name, 2, 80, "Informe o nome.");
  const description = optionalText(item.description, 240);
  const price = boundedNumber(item.price, 0, 100000, "Preço inválido.");
  const durationMinutes = boundedInteger(item.durationMinutes, 5, 1440, "Duração inválida.");
  const serviceIds = type === "option" ? stringList(item.serviceIds, 60, 128) : [];
  return { name, name_key: normalizeName(name), description, price, duration_minutes: durationMinutes, service_ids: serviceIds, active: item.active !== false };
}

function professionalPayload(input) {
  const item = input && typeof input === "object" ? input : {};
  const name = text(item.name, 2, 80, "Informe o nome do profissional.");
  const specialty = optionalText(item.specialty, 100);
  const imageUrl = optionalText(item.imageUrl, 500);
  if (imageUrl && !/^https:\/\//i.test(imageUrl)) throw new ErrorWithCode("invalid-argument", "A foto precisa usar uma URL HTTPS.");
  const status = String(item.status || "available");
  if (!["available", "busy", "paused", "unavailable"].includes(status)) throw new ErrorWithCode("invalid-argument", "Status inválido.");
  const commissionRate = boundedNumber(item.commissionRate ?? 0, 0, 1, "Comissão inválida.");
  const serviceIds = stringList(item.serviceIds, 60, 128);
  if (!serviceIds.length) throw new ErrorWithCode("invalid-argument", "Selecione pelo menos um serviço para o profissional.");
  const workDays = integerList(item.workDays, 7, 0, 6);
  if (!workDays.length) throw new ErrorWithCode("invalid-argument", "Selecione pelo menos um dia de atendimento.");
  const workStart = time(item.workStart, "Horário inicial inválido.");
  const workEnd = time(item.workEnd, "Horário final inválido.");
  if (workStart >= workEnd) throw new ErrorWithCode("invalid-argument", "O fim do expediente deve ser depois do início.");
  const intervalMinutes = boundedInteger(item.intervalMinutes, 5, 240, "Intervalo inválido.");
  const lunch = timeRange(item.lunch, "almoço");
  const additionalBreak = timeRange(item.additionalBreak, "pausa adicional");
  const availableTimes = stringList(item.availableTimes || [], 96, 5);
  if (availableTimes.some((value) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))) throw new ErrorWithCode("invalid-argument", "Há um horário personalizado inválido.");
  const vacationInput = item.vacation && typeof item.vacation === "object" ? item.vacation : {};
  const vacation = { active: vacationInput.active === true, start: dateString(vacationInput.start), end: dateString(vacationInput.end), reason: optionalText(vacationInput.reason, 120) };
  if (vacation.active && (!vacation.start || !vacation.end || vacation.start > vacation.end)) throw new ErrorWithCode("invalid-argument", "Período de afastamento inválido.");
  return { name, name_key: normalizeName(name), specialty, image_url: imageUrl, status, commission_rate: commissionRate, allow_online_booking: item.allowOnlineBooking !== false, schedule_active: item.scheduleActive !== false, service_ids: serviceIds, work_days: workDays, work_start: workStart, work_end: workEnd, interval_minutes: intervalMinutes, lunch, additional_break: additionalBreak, available_times: availableTimes, vacation, active: item.active !== false };
}

function timeRange(value, label) { const range = value && typeof value === "object" ? value : {}; const active = range.active === true; const start = active ? time(range.start, `Início do ${label} inválido.`) : String(range.start || ""); const end = active ? time(range.end, `Fim do ${label} inválido.`) : String(range.end || ""); if (active && start >= end) throw new ErrorWithCode("invalid-argument", `O fim do ${label} deve ser depois do início.`); return { active, start, end }; }
function dateString(value) { const result = String(value || ""); if (result && !/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new ErrorWithCode("invalid-argument", "Data inválida."); return result; }

function text(value, min, max, message) {
  const result = String(value || "").trim();
  if (result.length < min || result.length > max) throw new ErrorWithCode("invalid-argument", message);
  return result;
}
function optionalText(value, max) { const result = String(value || "").trim(); if (result.length > max) throw new ErrorWithCode("invalid-argument", "Texto muito longo."); return result; }
function boundedNumber(value, min, max, message) { const result = Number(value); if (!Number.isFinite(result) || result < min || result > max) throw new ErrorWithCode("invalid-argument", message); return Math.round(result * 100) / 100; }
function boundedInteger(value, min, max, message) { const result = Number(value); if (!Number.isInteger(result) || result < min || result > max) throw new ErrorWithCode("invalid-argument", message); return result; }
function stringList(value, maxItems, maxLength) { if (!Array.isArray(value) || value.length > maxItems) throw new ErrorWithCode("invalid-argument", "Lista inválida."); return [...new Set(value.map((item) => String(item || "").trim()).filter((item) => item && item.length <= maxLength))]; }
function integerList(value, maxItems, min, max) { if (!Array.isArray(value) || value.length > maxItems) throw new ErrorWithCode("invalid-argument", "Lista inválida."); return [...new Set(value.map(Number).filter((item) => Number.isInteger(item) && item >= min && item <= max))].sort(); }
function time(value, message) { const result = String(value || ""); if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(result)) throw new ErrorWithCode("invalid-argument", message); return result; }
function normalizeType(value) { const type = String(value || ""); if (!Object.hasOwn({ service: 1, option: 1, professional: 1 }, type)) throw new ErrorWithCode("invalid-argument", "Tipo de cadastro inválido."); return type; }
function normalizeRequiredId(value) { const id = String(value || "").trim(); if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new ErrorWithCode("invalid-argument", "Identificador inválido."); return id; }
function normalizeOptionalId(value) { return value ? normalizeRequiredId(value) : ""; }
function normalizeName(value) { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR"); }

class ErrorWithCode extends Error { constructor(code, message) { super(message); this.code = code; } }

module.exports = { createCatalogFunctions };
