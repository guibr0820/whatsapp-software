const crypto = require('node:crypto');
const { availableSlots } = require('./booking-flow');
const dayKey = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
function normalizeDate(value) {
  const text = String(value || '');
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  const result = match ? `${match[3]}-${match[2]}-${match[1]}` : text;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || new Date(`${result}T12:00:00Z`).toISOString().slice(0,10) !== result) throw new Error('Data inválida.');
  return result;
}
const minute = value => Number(value.slice(0,2)) * 60 + Number(value.slice(3));
function createAppointmentFunctions({ db, admin, onCall, HttpsError, taskQueue }) {
  const root = org => db.doc(`organizations/${org}`);
  async function authorize(request, owner = false) {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Entre na sua conta.');
    const org = String(request.data?.organizationId || '');
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(org)) throw new HttpsError('invalid-argument', 'Empresa inválida.');
    const [company, member] = await Promise.all([root(org).get(), root(org).collection('members').doc(request.auth.uid).get()]);
    if (!company.exists || member.data()?.status !== 'active' || (owner && company.data().proprietario_uid !== request.auth.uid)) throw new HttpsError('permission-denied', 'Você não tem permissão para esta operação.');
    return org;
  }
  const date = value => { try { return normalizeDate(value); } catch { throw new HttpsError('invalid-argument', 'Data inválida.'); } };
  async function readDay(org, key, reader) {
    const dates = [key, key.split('-').reverse().join('/')];
    const snaps = await Promise.all(dates.map(value => {
      const query = root(org).collection('appointments').where('appointment_date', '==', value);
      return reader ? reader.get(query) : query.get();
    }));
    return snaps.flatMap(s => s.docs).map(d => ({ ...d.data(), id: d.id }));
  }
  const publicItem = a => ({ id: a.id, customerName: a.customer_name || 'Cliente', phone: a.customer_phone || '', conversationId: a.conversation_id || '', service: a.service || 'Atendimento', optional: a.optional || '', professional: a.professional || 'Não informado', professionalId: a.professional_id || '', date: normalizeDate(a.appointment_date), time: a.appointment_time || '', duration: Number(a.duration_minutes) || 30, price: a.total_price ?? null, status: a.status || 'confirmed', reminderStatus: a.reminder_status || 'pending', paymentStatus: a.payment_status || 'onsite', deposit: (a.deposit_cents || 0) / 100, paid: (a.paid_cents || 0) / 100, balance: (a.remaining_cents ?? Math.round(Number(a.total_price || 0) * 100)) / 100, paymentExpiresAt: a.payment_expires_at?.toMillis() || null });
  const listAppointments = onCall({ region: 'southamerica-east1' }, async request => {
    const org = await authorize(request);
    const key = date(request.data?.date || dayKey());
    const [items, todayItems, people] = await Promise.all([readDay(org,key), key === dayKey() ? Promise.resolve(null) : readDay(org,dayKey()), root(org).collection('professionals').get()]);
    const current = todayItems || items;
    return { date: key, appointments: items.map(publicItem).sort((a,b) => a.time.localeCompare(b.time)), todayAppointments: current.map(publicItem).sort((a,b) => a.time.localeCompare(b.time)), professionals: people.docs.map(p => ({ id: p.id, name: p.data().name, active: p.data().active !== false })), canManage: (await root(org).get()).data().proprietario_uid === request.auth.uid };
  });
  async function personFor(org, a, reader) {
    if (a.professional_id && /^[a-zA-Z0-9_-]{1,128}$/.test(a.professional_id)) {
      const ref = root(org).collection('professionals').doc(a.professional_id);
      const snap = reader ? await reader.get(ref) : await ref.get();
      if (snap.exists) return { ...snap.data(), id: snap.id };
    }
    const q = root(org).collection('professionals').where('name','==',a.professional).limit(2);
    const snap = reader ? await reader.get(q) : await q.get();
    if (snap.docs.length !== 1) throw new HttpsError('failed-precondition', 'Associe um profissional válido antes de remarcar.');
    return { ...snap.docs[0].data(), id: snap.docs[0].id };
  }
  const blocks = (items, person, exclude) => items.filter(a => a.id !== exclude && !['cancelled','canceled','rejected','payment_expired'].includes(a.status) && (a.professional_id === person.id || a.professional === person.name)).map(a => ({ start: minute(a.appointment_time), end: minute(a.appointment_time) + (Number(a.duration_minutes) || 30) }));
  const getAppointmentSlots = onCall({ region: 'southamerica-east1' }, async request => {
    const org = await authorize(request, true), key = date(request.data?.date);
    const id = String(request.data?.appointmentId || '');
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new HttpsError('invalid-argument', 'Agendamento inválido.');
    const a = (await root(org).collection('appointments').doc(id).get()).data();
    if (!a || a.status !== 'confirmed') throw new HttpsError('failed-precondition', 'Somente agendamentos confirmados podem ser remarcados.');
    const person = await personFor(org,a);
    return { times: availableSlots(person,key,Number(a.duration_minutes) || 30,blocks(await readDay(org,key),person,id)) };
  });
  const updateAppointment = onCall({ region: 'southamerica-east1' }, async request => {
    const org = await authorize(request,true), id = String(request.data?.appointmentId || ''), action = request.data?.action;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !['complete','no_show','cancel','reschedule'].includes(action)) throw new HttpsError('invalid-argument','Operação inválida.');
    const ref = root(org).collection('appointments').doc(id);
    const revision = crypto.randomUUID();
    let scheduledFor;
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref), a = snap.data();
      if (!a || a.status !== 'confirmed') throw new HttpsError('failed-precondition','O agendamento foi alterado. Atualize a agenda.');
      if (action === 'complete' || action === 'no_show') {
        const status = action === 'complete' ? 'completed' : 'no_show';
        tx.set(ref,{ status, [`${status}_at`]:admin.firestore.FieldValue.serverTimestamp(), updated_at:admin.firestore.FieldValue.serverTimestamp(),updated_by:request.auth.uid },{merge:true});
        return;
      }
      const person = await personFor(org,a,tx);
      const oldDate = date(a.appointment_date), oldLock = root(org).collection('booking_days').doc(`${person.id}_${oldDate}`);
      const oldSnap = await tx.get(oldLock);
      const oldReservations = { ...(oldSnap.data()?.reservations || {}) };
      delete oldReservations[id];
      const now = admin.firestore.FieldValue.serverTimestamp();
      const update = { updated_at: now, updated_by: request.auth.uid };
      if (action === 'reschedule') {
        const newDate = date(request.data?.date), time = String(request.data?.time || '');
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new HttpsError('invalid-argument','Horário inválido.');
        const newLock = root(org).collection('booking_days').doc(`${person.id}_${newDate}`);
        const newSnap = newLock.path === oldLock.path ? oldSnap : await tx.get(newLock);
        const held = { ...(newSnap.data()?.reservations || {}) }; delete held[id];
        const busy = [...blocks(await readDay(org,newDate,tx),person,id), ...Object.values(held)];
        const duration = Number(a.duration_minutes) || 30;
        if (!availableSlots(person,newDate,duration,busy).includes(time)) throw new HttpsError('failed-precondition','Esse horário não está disponível. Escolha outro.');
        scheduledFor = admin.firestore.Timestamp.fromDate(new Date(`${newDate}T${time}:00-03:00`));
        Object.assign(update,{ appointment_date: newDate, appointment_time: time, scheduled_for: scheduledFor, professional_id: person.id, reminder_revision: revision, reminder_status: 'pending', reminder_error: admin.firestore.FieldValue.delete(), rescheduled_at: now });
        held[id] = { start: minute(time), end: minute(time)+duration };
        if (newLock.path !== oldLock.path) tx.set(oldLock,{ reservations: oldReservations, updated_at: now });
        tx.set(newLock,{ reservations: held, updated_at: now });
      } else {
        update.status = { complete:'completed', no_show:'no_show', cancel:'cancelled' }[action];
        update[`${update.status}_at`] = now;
        if (action === 'cancel') tx.set(oldLock,{ reservations:oldReservations,updated_at:now });
      }
      tx.set(ref,update,{ merge:true });
    });
    let reminderQueued = true;
    if (scheduledFor && taskQueue) {
      const config = (await root(org).collection('automation_configs').doc('appointment_reminder').get()).data();
      if (config?.active) {
        const delay = config.trigger === 'before_appointment' ? Math.max(0,Math.floor((scheduledFor.toMillis()-Date.now())/1000)-(Number(config.lead_time_minutes)||1440)*60) : Number(config.delay_seconds)||30;
        try { await taskQueue.enqueue({ organizationId:org,appointmentId:id,revision },{ scheduleDelaySeconds:delay }); }
        catch { reminderQueued = false; await ref.set({ reminder_status:'failed',reminder_error:'Não foi possível programar o lembrete após a remarcação.' },{ merge:true }); }
      }
    }
    return { saved:true, reminderQueued };
  });
  return { listAppointments, getAppointmentSlots, updateAppointment };
}
module.exports = { createAppointmentFunctions, normalizeDate, dayKey };
