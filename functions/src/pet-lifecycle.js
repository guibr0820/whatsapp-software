const crypto = require('node:crypto');
const { withAutomatedMessage } = require('./plan-limits');

const PET_SEXES = new Set(['male', 'female', 'unknown']);
const DELIVERY_TRANSPORTS = new Set(['delivery', 'both']);

function normalizePetSex(value) {
  const sex = String(value || 'unknown').trim().toLowerCase();
  return PET_SEXES.has(sex) ? sex : 'unknown';
}

function hasPetDelivery(appointment = {}) {
  return DELIVERY_TRANSPORTS.has(String(appointment.transport_id || ''));
}

function petStatusAutomationId(action, appointment = {}) {
  if (action === 'pet_ready' && hasPetDelivery(appointment)) return '';
  return ({
    pet_pickup_started: 'pet_pickup_started',
    pet_collected: 'pet_collected',
    complete: hasPetDelivery(appointment) ? 'pet_delivered' : '',
    pet_received: 'pet_received',
    pet_in_service: 'pet_in_service',
    pet_ready: 'pet_ready_pickup',
    pet_out_for_delivery: 'pet_out_for_delivery',
  })[action] || '';
}

function petStatusMessage(action, appointment = {}, pet = {}) {
  const petName = String(pet.name || appointment.pet_name || 'Seu pet').trim().slice(0, 80) || 'Seu pet';
  const sex = normalizePetSex(pet.sex || appointment.pet_sex);
  if (action === 'pet_pickup_started') return `Nossa equipe está a caminho para buscar ${petName}. Deixe tudo pronto!`;
  if (action === 'pet_collected') return `${petName} já está com nossa equipe, a caminho do pet shop.`;
  if (action === 'complete' && hasPetDelivery(appointment)) return `A entrega de ${petName} foi concluída. Obrigado pela confiança!`;
  if (action === 'pet_received') return `${petName} chegou e foi recebido com segurança.`;
  if (action === 'pet_in_service') {
    if (sex === 'male') return `O atendimento de ${petName} começou. Ele está sendo cuidado pela nossa equipe.`;
    if (sex === 'female') return `O atendimento de ${petName} começou. Ela está sendo cuidada pela nossa equipe.`;
    return `O atendimento de ${petName} começou. Seu pet está sendo cuidado pela nossa equipe.`;
  }
  if (action === 'pet_ready') {
    if (sex === 'male') return `${petName} já está pronto para você vir buscá-lo.`;
    if (sex === 'female') return `${petName} já está pronta para você vir buscá-la.`;
    return `${petName} já está esperando por você. Pode vir buscar seu pet.`;
  }
  if (action === 'pet_out_for_delivery') {
    if (sex === 'male') return `${petName} já está a caminho de casa. Prepare-se para recebê-lo!`;
    if (sex === 'female') return `${petName} já está a caminho de casa. Prepare-se para recebê-la!`;
    return `${petName} já está a caminho de casa. A entrega será feita em breve!`;
  }
  return '';
}

function nextPetAction(appointment = {}) {
  if (appointment.status === 'confirmed') return ['pickup','both'].includes(appointment.transport_id) ? 'pet_pickup_started' : 'pet_received';
  if (appointment.status === 'pet_pickup_started') return 'pet_collected';
  if (appointment.status === 'pet_collected') return 'pet_received';
  if (appointment.status === 'pet_received') return 'pet_in_service';
  if (appointment.status === 'pet_in_service') return 'pet_ready';
  if (appointment.status === 'pet_ready') return hasPetDelivery(appointment) ? 'pet_out_for_delivery' : 'complete';
  if (appointment.status === 'pet_out_for_delivery') return 'complete';
  return '';
}

function safeMetaError(error) {
  return String(error?.response?.data?.error?.message || error?.message || 'Falha no envio pelo WhatsApp.').replace(/EA[A-Za-z0-9_-]{20,}/g, '[credencial protegida]').slice(0, 300);
}

async function sendPetStatusNotification({ admin, db, axios, HttpsError, organizationId, appointmentId, appointment, pet, action }) {
  const automationId = petStatusAutomationId(action, appointment);
  if (!automationId) return { status: 'not_applicable' };
  const [configSnapshot, integration] = await Promise.all([
    db.doc(`organizations/${organizationId}/automation_configs/lifecycle_reminders`).get(),
    db.doc(`organizations/${organizationId}/integrations/whatsapp`).get(),
  ]);
  const config = configSnapshot.data()?.automations?.[automationId] || {};
  if (config.active !== true) return { status: 'disabled' };
  const credentials = integration.data() || {};
  const phone = String(appointment.customer_phone || '').replace(/\D/g, '');
  if (!credentials.phone_number_id || !credentials.access_token || !phone) return { status: 'failed', error: 'WhatsApp desconectado ou telefone inválido.' };
  const text = petStatusMessage(action, appointment, pet);
  try {
    const response = await withAutomatedMessage({ db, admin, organizationId, HttpsError, reference: `pet_status_${appointmentId}_${automationId}`, send: async () => axios.post(
      `https://graph.facebook.com/${credentials.graph_version || 'v24.0'}/${credentials.phone_number_id}/messages`,
      { messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, type: 'template', template: { name:config.template_name || config.templateName || 'atualizacao_pet', language:{code:config.language || 'pt_BR'}, components:[{type:'body',parameters:[appointment.customer_name || 'Cliente',text].map(value=>({type:'text',text:String(value).slice(0,1024)}))}] } },
      { headers: { Authorization: `Bearer ${credentials.access_token}`, 'Content-Type': 'application/json' }, timeout: 15000 },
    ) });
    const providerMessageId = String(response.data?.messages?.[0]?.id || '');
    if (!providerMessageId) throw new Error('A Meta não confirmou o envio da atualização do pet.');
    const now = admin.firestore.FieldValue.serverTimestamp();
    const batch = db.batch();
    const appointmentRef = db.doc(`organizations/${organizationId}/appointments/${appointmentId}`);
    batch.set(appointmentRef, { pet_message_statuses: { [automationId]: { status: 'sent', provider_message_id: providerMessageId, updated_at: admin.firestore.Timestamp.now() } }, updated_at: now }, { merge: true });
    if (appointment.conversation_id) {
      const conversationRef = db.doc(`organizations/${organizationId}/conversations/${appointment.conversation_id}`);
      const messageId = crypto.createHash('sha256').update(`message:${providerMessageId}`).digest('hex').slice(0, 40);
      const displayedText = `Olá, ${appointment.customer_name || 'Cliente'}! ${text}`;
      batch.set(conversationRef.collection('messages').doc(messageId), { provider_message_id: providerMessageId, direction: 'outbound', type: 'template', text:displayedText, status: 'sent', sent_at: now, created_at: now, created_by: 'pet_status_automation' });
      batch.set(conversationRef, { last_message:displayedText, last_message_at: now, last_direction: 'outbound', status: 'open', updated_at: now }, { merge:true });
    }
    await batch.commit();
    return { status: 'sent', providerMessageId };
  } catch (error) {
    const message = safeMetaError(error);
    await db.doc(`organizations/${organizationId}/appointments/${appointmentId}`).set({ pet_message_statuses: { [automationId]: { status: 'failed', error: message, updated_at: admin.firestore.Timestamp.now() } }, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return { status: 'failed', error: message };
  }
}

module.exports = { normalizePetSex, hasPetDelivery, petStatusAutomationId, petStatusMessage, nextPetAction, sendPetStatusNotification };
