const SCREEN_KEYS = ["overview", "appointments", "orders", "deliveries", "conversations", "services", "menu", "employees", "payments", "contacts", "automations"];

const CORE_SCREENS = ["overview", "conversations", "contacts"];
const SERVICE_SCREENS = [...CORE_SCREENS, "appointments", "services", "employees", "payments", "automations"];
const FOOD_SCREENS = [...CORE_SCREENS, "orders", "deliveries", "menu", "payments", "automations"];
const FOOD_SEGMENT_IDS = new Set(["pizzaria", "lanchonete-hamburgueria", "restaurante", "delivery-alimentos", "doceria-confeitaria", "acai-sorveteria", "comercio"]);

const DEFAULT_SEGMENTS = [
  ["beleza-estetica", "Beleza e estética", SERVICE_SCREENS],
  ["pizzaria", "Pizzaria", FOOD_SCREENS],
  ["lanchonete-hamburgueria", "Lanchonete ou hamburgueria", FOOD_SCREENS],
  ["restaurante", "Restaurante", FOOD_SCREENS],
  ["delivery-alimentos", "Delivery de alimentos", FOOD_SCREENS],
  ["doceria-confeitaria", "Doceria ou confeitaria", FOOD_SCREENS],
  ["acai-sorveteria", "Açaí ou sorveteria", FOOD_SCREENS],
  ["comercio", "Comércio", FOOD_SCREENS],
  ["educacao", "Educação", SERVICE_SCREENS],
  ["imobiliario", "Imobiliário", CORE_SCREENS.concat("automations")],
  ["saude", "Saúde", SERVICE_SCREENS],
  ["servicos-profissionais", "Serviços profissionais", SERVICE_SCREENS],
  ["outros", "Outros", CORE_SCREENS],
].map(([id, name, screens], index) => ({ id, name, screens, active: true, sortOrder: (index + 1) * 10 }));

async function ensureDefaultSegments(db, admin) {
  const collection = db.collection("app_segments");
  const snapshot = await collection.limit(1).get();
  if (!snapshot.empty) {
    const batch = db.batch();
    let changed = false;
    for (const segment of DEFAULT_SEGMENTS) {
      const reference = collection.doc(segment.id);
      const current = await reference.get();
      if (!current.exists || Number(current.data()?.schema_version || 0) >= 2) continue;
      const screens = Array.isArray(current.data()?.screens) ? current.data().screens : segment.screens;
      const migratedScreens = FOOD_SEGMENT_IDS.has(segment.id)
        ? [...new Set([...screens, "deliveries", "automations"])]
        : screens;
      batch.set(reference, { screens: migratedScreens, schema_version: 2, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      changed = true;
    }
    if (changed) await batch.commit();
    return;
  }
  const batch = db.batch();
  for (const segment of DEFAULT_SEGMENTS) {
    batch.set(collection.doc(segment.id), {
      name: segment.name,
      screens: segment.screens,
      active: true,
      sort_order: segment.sortOrder,
      schema_version: 2,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
}

async function listSegments(db, admin, includeInactive = false) {
  await ensureDefaultSegments(db, admin);
  const snapshot = await db.collection("app_segments").get();
  return snapshot.docs.map(document => normalizeStoredSegment(document.id, document.data()))
    .filter(segment => includeInactive || segment.active)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "pt-BR"));
}

function normalizeStoredSegment(id, data = {}) {
  const screens = Array.isArray(data.screens) ? data.screens.filter(screen => SCREEN_KEYS.includes(screen)) : CORE_SCREENS;
  return {
    id,
    name: String(data.name || id).slice(0, 60),
    screens: [...new Set([...CORE_SCREENS, ...screens])],
    active: data.active !== false,
    sortOrder: Math.max(0, Math.min(10000, Number(data.sort_order) || 0)),
  };
}

function normalizeSegmentInput(data, cleanId, text, HttpsError) {
  const id = cleanId(data?.id, HttpsError);
  const name = text(data?.name, 2, 60, "Informe um nome de segmento válido.", HttpsError);
  const requestedScreens = Array.isArray(data?.screens) ? data.screens : [];
  if (requestedScreens.length > SCREEN_KEYS.length || requestedScreens.some(screen => !SCREEN_KEYS.includes(screen))) {
    throw new HttpsError("invalid-argument", "Há uma tela inválida na configuração do segmento.");
  }
  const sortOrder = Number(data?.sortOrder);
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 10000) throw new HttpsError("invalid-argument", "Ordem inválida.");
  return { id, name, screens: [...new Set([...CORE_SCREENS, ...requestedScreens])], active: data?.active !== false, sortOrder };
}

module.exports = { SCREEN_KEYS, CORE_SCREENS, DEFAULT_SEGMENTS, ensureDefaultSegments, listSegments, normalizeSegmentInput };
