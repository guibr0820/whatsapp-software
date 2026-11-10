const { normalizePet } = require('./pet-model');

function createPetFunctions({ admin, db, onCall, HttpsError }) {
  async function authorize(request) {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Faça login para acessar os pets.');
    const org = String(request.data?.organizationId || '');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(org)) throw new HttpsError('invalid-argument', 'Empresa inválida.');
    const root = db.doc(`organizations/${org}`);
    const [company, member] = await Promise.all([root.get(), root.collection('members').doc(request.auth.uid).get()]);
    if (!company.exists || company.data()?.status === 'suspended' || member.data()?.status !== 'active') throw new HttpsError('permission-denied', 'Você não possui acesso a esta empresa.');
    return root;
  }
  const listPets = onCall({ region: 'southamerica-east1' }, async request => {
    const root = await authorize(request);
    const snapshot = await root.collection('pets').orderBy('name').limit(100).get();
    return { pets: snapshot.docs.map(doc => { const data=doc.data(); return { id:doc.id,...data,history:(Array.isArray(data.recent_history)?data.recent_history:[]).slice(0,10) }; }) };
  });
  const savePet = onCall({ region: 'southamerica-east1' }, async request => {
    const root = await authorize(request);
    let pet;
    try { pet = normalizePet(request.data?.pet); } catch (error) { throw new HttpsError('invalid-argument', error.message); }
    const id = String(request.data?.id || '');
    if (id && !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new HttpsError('invalid-argument', 'Pet inválido.');
    const ref = id ? root.collection('pets').doc(id) : root.collection('pets').doc();
    if (id && !(await ref.get()).exists) throw new HttpsError('not-found', 'Pet não encontrado.');
    const now = admin.firestore.FieldValue.serverTimestamp();
    await ref.set({ ...pet, updated_at: now, updated_by: request.auth.uid, ...(!id ? { created_at: now, created_by: request.auth.uid } : {}) }, { merge: true });
    return { id: ref.id };
  });
  const getPetShopSettings = onCall({ region: 'southamerica-east1' }, async request => {
    const root = await authorize(request);
    const data = (await root.collection('pet_shop').doc('settings').get()).data() || {};
    return { pickupEnabled: data.pickup_enabled === true, deliveryEnabled: data.delivery_enabled === true, pickupFee: Number(data.pickup_fee || 0), deliveryFee: Number(data.delivery_fee || 0), transportMinutes: Number(data.transport_minutes || 15), returnDays: Number(data.return_days || 30) };
  });
  const savePetShopSettings = onCall({ region: 'southamerica-east1' }, async request => {
    const root = await authorize(request), input = request.data?.settings || {};
    const number = (value, min, max, label) => { const parsed = Number(value); if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new HttpsError('invalid-argument', `${label} inválido.`); return Math.round(parsed * 100) / 100; };
    const returnDays = Math.round(number(input.returnDays || 30, 1, 365, 'Prazo de retorno'));
    await root.collection('pet_shop').doc('settings').set({ pickup_enabled: input.pickupEnabled === true, delivery_enabled: input.deliveryEnabled === true, pickup_fee: number(input.pickupFee || 0, 0, 10000, 'Valor da busca'), delivery_fee: number(input.deliveryFee || 0, 0, 10000, 'Valor da entrega'), transport_minutes: Math.round(number(input.transportMinutes || 15, 0, 240, 'Tempo de transporte')), return_days: returnDays, updated_at: admin.firestore.FieldValue.serverTimestamp(), updated_by: request.auth.uid }, { merge: true });
    return { saved: true };
  });
  return { listPets, savePet, getPetShopSettings, savePetShopSettings };
}
module.exports = { createPetFunctions };
