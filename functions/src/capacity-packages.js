const DEFAULT_CAPACITY_PACKAGES = Object.freeze([
  { id: "essencial", name: "Essencial", priceCents: 1990, reminders: 100, appointments: 100, active: true, featured: false, sortOrder: 10 },
  { id: "reforco", name: "Reforço", priceCents: 3500, reminders: 250, appointments: 250, active: true, featured: false, sortOrder: 20 },
  { id: "movimento", name: "Movimento", priceCents: 5500, reminders: 500, appointments: 500, active: true, featured: true, sortOrder: 30 },
  { id: "escala", name: "Escala", priceCents: 10000, reminders: 1000, appointments: 1000, active: true, featured: false, sortOrder: 40 },
  { id: "alto-volume", name: "Alto volume", priceCents: 15000, reminders: 2000, appointments: 2000, active: true, featured: false, sortOrder: 50 },
]);

function packageId(value) {
  const id = String(value || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("Identificador do pacote inválido.");
  return id;
}

function integer(value, label, { min = 0, max = 1000000 } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label} inválido.`);
  return number;
}

function normalizeCapacityPackage(input = {}, id = input.id) {
  const name = String(input.name || "").trim();
  if (name.length < 2 || name.length > 80) throw new Error("Nome do pacote inválido.");
  const priceCents = input.priceCents === undefined ? Math.round(Number(input.price) * 100) : Number(input.priceCents);
  return {
    id: packageId(id),
    name,
    priceCents: integer(priceCents, "Preço", { min: 100, max: 10000000 }),
    reminders: integer(input.reminders, "Quantidade de mensagens automáticas", { min: 1 }),
    appointments: integer(input.appointments, "Quantidade de agendamentos", { min: 1 }),
    active: input.active !== false,
    featured: input.featured === true,
    sortOrder: integer(input.sortOrder ?? 0, "Ordem", { min: 0, max: 100000 }),
  };
}

function packageDocument(item) {
  return { name: item.name, price_cents: item.priceCents, reminders: item.reminders, appointments: item.appointments, active: item.active, featured: item.featured, sort_order: item.sortOrder };
}

function packagePublic(id, data = {}) {
  return normalizeCapacityPackage({ id, name: data.name, priceCents: data.price_cents, reminders: data.reminders, appointments: data.appointments, active: data.active, featured: data.featured, sortOrder: data.sort_order }, id);
}

async function ensureCapacityPackages(db, admin) {
  const collection = db.collection("capacity_packages");
  const snapshot = await collection.limit(1).get();
  if (!snapshot.empty) return;
  const batch = db.batch();
  for (const item of DEFAULT_CAPACITY_PACKAGES) batch.set(collection.doc(item.id), { ...packageDocument(item), created_at: admin.firestore.FieldValue.serverTimestamp(), updated_at: admin.firestore.FieldValue.serverTimestamp() });
  await batch.commit();
}

async function listCapacityPackages(db, admin, activeOnly = false) {
  await ensureCapacityPackages(db, admin);
  const snapshot = await db.collection("capacity_packages").get();
  return snapshot.docs.map(document => packagePublic(document.id, document.data())).filter(item => !activeOnly || item.active).sort((a, b) => a.sortOrder - b.sortOrder || a.priceCents - b.priceCents || a.name.localeCompare(b.name, "pt-BR"));
}

module.exports = { DEFAULT_CAPACITY_PACKAGES, normalizeCapacityPackage, packageDocument, packagePublic, ensureCapacityPackages, listCapacityPackages };
