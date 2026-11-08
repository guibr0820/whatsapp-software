const SCREEN_KEYS = ["overview", "appointments", "orders", "deliveries", "conversations", "services", "menu", "employees", "payments", "contacts", "automations"];
const FAMILY_KEYS = ["food", "agenda", "sales", "service"];
const MODULE_KEYS = ["orders", "delivery", "appointments", "quotes", "visits", "enrollment", "payments", "customer_recovery", "post_sale"];
const MAINTENANCE_SEGMENTS = new Set(["comercio", "educacao", "imobiliario", "outros"]);

const CORE_SCREENS = ["overview", "conversations", "contacts"];
const SERVICE_SCREENS = [...CORE_SCREENS, "appointments", "services", "employees", "payments", "automations"];
const FOOD_SCREENS = [...CORE_SCREENS, "orders", "deliveries", "menu", "payments", "automations"];
const SALES_SCREENS = [...CORE_SCREENS, "services", "payments", "automations"];
const SUPPORT_SCREENS = [...CORE_SCREENS, "automations"];

const FAMILY_DEFAULTS = {
  food: { modules: ["orders", "delivery", "payments", "customer_recovery", "post_sale"], terminology: { subject: "pedido", item: "item", professional: "atendente", completion: "pedido concluído" } },
  agenda: { modules: ["appointments", "payments", "customer_recovery", "post_sale"], terminology: { subject: "agendamento", item: "serviço", professional: "profissional", completion: "atendimento concluído" } },
  sales: { modules: ["quotes", "payments", "customer_recovery", "post_sale"], terminology: { subject: "atendimento", item: "produto ou serviço", professional: "consultor", completion: "venda concluída" } },
  service: { modules: ["quotes", "customer_recovery", "post_sale"], terminology: { subject: "atendimento", item: "serviço", professional: "atendente", completion: "atendimento concluído" } },
};

const DEFAULT_SEGMENTS = [
  ["beleza-estetica", "Beleza e estética", SERVICE_SCREENS, "agenda"],
  ["pizzaria", "Pizzaria", FOOD_SCREENS, "food"],
  ["lanchonete-hamburgueria", "Lanchonete ou hamburgueria", FOOD_SCREENS, "food"],
  ["restaurante", "Restaurante", FOOD_SCREENS, "food"],
  ["delivery-alimentos", "Delivery de alimentos", FOOD_SCREENS, "food"],
  ["doceria-confeitaria", "Doceria ou confeitaria", FOOD_SCREENS, "food"],
  ["acai-sorveteria", "Açaí ou sorveteria", FOOD_SCREENS, "food"],
  ["comercio", "Comércio", SALES_SCREENS, "sales"],
  ["educacao", "Educação", SUPPORT_SCREENS, "service", ["enrollment", "quotes", "customer_recovery", "post_sale"]],
  ["imobiliario", "Imobiliário", SUPPORT_SCREENS, "sales", ["visits", "quotes", "customer_recovery", "post_sale"]],
  ["saude", "Saúde", SERVICE_SCREENS, "agenda"],
  ["servicos-profissionais", "Serviços profissionais", SERVICE_SCREENS, "service", ["appointments", "quotes", "payments", "customer_recovery", "post_sale"]],
  ["outros", "Outros", SUPPORT_SCREENS, "service", ["quotes", "customer_recovery"]],
  ["automichat-support", "Suporte Automichat", SUPPORT_SCREENS, "service", ["quotes"]],
].map(([id, name, screens, family, modules], index) => ({ id, name, screens, family, modules: modules || FAMILY_DEFAULTS[family].modules, active: true, internalOnly: id === "automichat-support", sortOrder: (index + 1) * 10 }));

function defaultFor(id) { return DEFAULT_SEGMENTS.find(segment => segment.id === id); }
function validModules(value, family) {
  const source = Array.isArray(value) ? value : FAMILY_DEFAULTS[family]?.modules || [];
  return [...new Set(source.filter(module => MODULE_KEYS.includes(module)))];
}

async function ensureDefaultSegments(db, admin) {
  const collection = db.collection("app_segments");
  const batch = db.batch();
  let changed = false;
  for (const segment of DEFAULT_SEGMENTS) {
    const reference = collection.doc(segment.id);
    const current = await reference.get();
    const data = current.data() || {};
    if (current.exists && Number(data.schema_version || 0) >= 4) continue;
    const legacyCommerce = segment.id === "comercio" && Number(data.schema_version || 0) < 3;
    batch.set(reference, {
      name: data.name || segment.name,
      screens: legacyCommerce ? segment.screens : (Array.isArray(data.screens) ? data.screens : segment.screens),
      family: FAMILY_KEYS.includes(data.family) ? data.family : segment.family,
      modules: validModules(data.modules, segment.family).length ? validModules(data.modules, segment.family) : segment.modules,
      active: !MAINTENANCE_SEGMENTS.has(segment.id),
      internal_only: segment.internalOnly === true,
      sort_order: Number.isFinite(Number(data.sort_order)) ? Number(data.sort_order) : segment.sortOrder,
      schema_version: 4,
      ...(current.exists ? {} : { created_at: admin.firestore.FieldValue.serverTimestamp() }),
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    changed = true;
  }
  if (changed) await batch.commit();
}

async function listSegments(db, admin, includeInactive = false, includeInternal = false) {
  await ensureDefaultSegments(db, admin);
  const snapshot = await db.collection("app_segments").get();
  return snapshot.docs.map(document => normalizeStoredSegment(document.id, document.data()))
    .filter(segment => (includeInactive || segment.active) && (includeInternal || !segment.internalOnly))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "pt-BR"));
}

function normalizeStoredSegment(id, data = {}) {
  const fallback = defaultFor(id) || { family: "service", modules: FAMILY_DEFAULTS.service.modules };
  const family = FAMILY_KEYS.includes(data.family) ? data.family : fallback.family;
  const screens = Array.isArray(data.screens) ? data.screens.filter(screen => SCREEN_KEYS.includes(screen)) : CORE_SCREENS;
  return { id, name: String(data.name || id).slice(0, 60), family,
    modules: validModules(data.modules, family).length ? validModules(data.modules, family) : validModules(fallback.modules, family),
    terminology: { ...FAMILY_DEFAULTS[family].terminology, ...(data.terminology || {}) },
    screens: [...new Set([...CORE_SCREENS, ...screens])], active: data.active !== false, internalOnly: data.internal_only === true || fallback.internalOnly === true,
    sortOrder: Math.max(0, Math.min(10000, Number(data.sort_order) || 0)) };
}

function normalizeSegmentInput(data, cleanId, text, HttpsError) {
  const id = cleanId(data?.id, HttpsError);
  const name = text(data?.name, 2, 60, "Informe um nome de segmento válido.", HttpsError);
  const requestedScreens = Array.isArray(data?.screens) ? data.screens : [];
  if (requestedScreens.length > SCREEN_KEYS.length || requestedScreens.some(screen => !SCREEN_KEYS.includes(screen))) throw new HttpsError("invalid-argument", "Há uma tela inválida na configuração do segmento.");
  const family = String(data?.family || "service");
  if (!FAMILY_KEYS.includes(family)) throw new HttpsError("invalid-argument", "Família de segmento inválida.");
  const requestedModules = Array.isArray(data?.modules) ? data.modules : [];
  if (requestedModules.length > MODULE_KEYS.length || requestedModules.some(module => !MODULE_KEYS.includes(module))) throw new HttpsError("invalid-argument", "Há um módulo inválido na configuração do segmento.");
  const sortOrder = Number(data?.sortOrder);
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 10000) throw new HttpsError("invalid-argument", "Ordem inválida.");
  return { id, name, family, modules: [...new Set(requestedModules)], screens: [...new Set([...CORE_SCREENS, ...requestedScreens])], active: data?.active !== false, sortOrder };
}

async function getOrganizationSegment(db, organizationId) {
  const organization = await db.doc(`organizations/${organizationId}`).get();
  const name = String(organization.data()?.segmento || "Outros");
  const snapshot = await db.collection("app_segments").where("name", "==", name).limit(1).get();
  if (!snapshot.empty) return normalizeStoredSegment(snapshot.docs[0].id, snapshot.docs[0].data());
  const fallback = DEFAULT_SEGMENTS.find(segment => segment.name === name) || defaultFor("outros");
  return normalizeStoredSegment(fallback.id, fallback);
}

module.exports = { SCREEN_KEYS, FAMILY_KEYS, MODULE_KEYS, CORE_SCREENS, DEFAULT_SEGMENTS, FAMILY_DEFAULTS, ensureDefaultSegments, listSegments, normalizeStoredSegment, normalizeSegmentInput, getOrganizationSegment };
