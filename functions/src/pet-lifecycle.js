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
  if (action === 'pet_received') return `${petName} chegou e foi ${sex === 'female' ? 'recebida' : 'recebido'} com segurança no pet shop.`;
  if (action === 'pet_in_service') {
    if (sex === 'male') return `O atendimento de ${petName} começou. Ele está sendo cuidado com todo carinho pela nossa equipe.`;
    if (sex === 'female') return `O atendimento de ${petName} começou. Ela está sendo cuidada com todo carinho pela nossa equipe.`;
    return `O atendimento de ${petName} começou. Seu pet está sendo cuidado com todo carinho pela nossa equipe.`;
  }
  if (action === 'pet_ready') {
    if (sex === 'male') return `O atendimento de ${petName} terminou. Já está pronto para você vir buscá-lo no pet shop.`;
    if (sex === 'female') return `O atendimento de ${petName} terminou. Já está pronta para você vir buscá-la no pet shop.`;
    return `O atendimento de ${petName} terminou. Já está disponível para você vir buscar seu pet no pet shop.`;
  }
  if (action === 'pet_out_for_delivery') {
    if (sex === 'male') return `${petName} já está a caminho de casa. Prepare-se para recebê-lo na chegada!`;
    if (sex === 'female') return `${petName} já está a caminho de casa. Prepare-se para recebê-la na chegada!`;
    return `${petName} já está a caminho de casa. Prepare-se para receber seu pet na chegada!`;
  }
  return '';
}

function petShortTemplate(action, appointment = {}, pet = {}) {
  const automationId = petStatusAutomationId(action, appointment);
  if (!automationId) return null;
  const sex = normalizePetSex(pet.sex || appointment.pet_sex);
  const gendered = ['pet_received', 'pet_in_service', 'pet_ready', 'pet_out_for_delivery'].includes(action);
  const name = `${automationId}_curto_${gendered ? 'v2' : 'v1'}`;
  let body = `Olá, {{1}}! ${petStatusMessage(action, { ...appointment, pet_name: '{{2}}' }, { name: '{{2}}', sex })}`;
  const parameters = [String(appointment.customer_name || 'Cliente').slice(0, 1024), String(pet.name || appointment.pet_name || 'Seu pet').trim().slice(0, 80) || 'Seu pet'];
  if (action === 'pet_received') {
    body = 'Olá, {{1}}! {{2}} chegou e foi {{3}} com segurança no pet shop.';
    parameters.push(sex === 'female' ? 'recebida' : 'recebido');
  } else if (action === 'pet_in_service') {
    body = 'Olá, {{1}}! O atendimento de {{2}} começou. {{3}} está sendo {{4}} com todo carinho pela nossa equipe.';
    parameters.push(sex === 'female' ? 'Ela' : sex === 'male' ? 'Ele' : 'Seu pet', sex === 'female' ? 'cuidada' : 'cuidado');
  } else if (action === 'pet_ready') {
    body = 'Olá, {{1}}! O atendimento de {{2}} terminou. Já está {{3}} para você vir {{4}} no pet shop.';
    parameters.push(sex === 'female' ? 'pronta' : sex === 'male' ? 'pronto' : 'disponível', sex === 'female' ? 'buscá-la' : sex === 'male' ? 'buscá-lo' : 'buscar seu pet');
  } else if (action === 'pet_out_for_delivery') {
    body = 'Olá, {{1}}! {{2}} já está a caminho de casa. Prepare-se para {{3}} na chegada!';
    parameters.push(sex === 'female' ? 'recebê-la' : sex === 'male' ? 'recebê-lo' : 'receber seu pet');
  }
  return { name, body, parameters, language: 'pt_BR', text: body.replace(/\{\{(\d+)\}\}/g, (_, index) => parameters[Number(index) - 1]) };
}

function petShortTemplateDefinitions() {
  return ['pet_pickup_started', 'pet_collected', 'pet_received', 'pet_in_service', 'pet_ready', 'pet_out_for_delivery', 'complete'].map(action => petShortTemplate(action, { customer_name: 'Guilherme', pet_name: 'Juli', transport_id: action === 'pet_ready' ? 'none' : 'both' }, { sex: 'female' }));
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
  const [configSnapshot, integration, templateSnapshot] = await Promise.all([
    db.doc(`organizations/${organizationId}/automation_configs/lifecycle_reminders`).get(),
    db.doc(`organizations/${organizationId}/integrations/whatsapp`).get(),
    db.doc(`organizations/${organizationId}/automation_configs/pet_status_templates`).get(),
  ]);
  const config = configSnapshot.data()?.automations?.[automationId] || {};
  if (config.active !== true) return { status: 'disabled' };
  const credentials = integration.data() || {};
  const phone = String(appointment.customer_phone || '').replace(/\D/g, '');
  if (!credentials.phone_number_id || !credentials.access_token || !phone) return { status: 'failed', error: 'WhatsApp desconectado ou telefone inválido.' };
  const text = petStatusMessage(action, appointment, pet);
  const short = petShortTemplate(action, appointment, pet);
  const registry = templateSnapshot.data() || {};
  try {
    let useShort = registry.enabled === true && registry.templates?.[short?.name] === 'APPROVED';
    if (registry.enabled === true && registry.templates?.[short?.name] === 'PENDING') {
      const result = await axios.get(`https://graph.facebook.com/${credentials.graph_version || 'v24.0'}/${credentials.waba_id}/message_templates`, { params: { name: short.name, fields: 'name,language,status,components', limit: 100 }, headers: { Authorization: `Bearer ${credentials.access_token}` }, timeout: 15000 });
      const approved = result.data?.data?.find(item => item.name === short.name && item.language === short.language && item.status === 'APPROVED' && item.components?.some(component => component.type === 'BODY' && component.text === short.body));
      if (approved) {
        useShort = true;
        await db.doc(`organizations/${organizationId}/automation_configs/pet_status_templates`).set({ templates: { [short.name]: 'APPROVED' }, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      }
    }
    const templateName = useShort ? short.name : config.template_name || config.templateName || 'atualizacao_pet';
    const language = useShort ? short.language : config.language || 'pt_BR';
    const parameters = useShort ? short.parameters : [appointment.customer_name || 'Cliente', text].map(value => String(value).slice(0, 1024));
    // Render exactly the body sent by Meta, including fixed phrases on legacy templates.
    let templateBody = short?.body;
    if (!useShort) {
      const templates = await axios.get(`https://graph.facebook.com/${credentials.graph_version || 'v24.0'}/${credentials.waba_id}/message_templates`, { params: { name: templateName, fields: 'name,language,components', limit: 100 }, headers: { Authorization: `Bearer ${credentials.access_token}` }, timeout: 15000 });
      templateBody = templates.data?.data?.find(item => item.name === templateName && item.language === language)?.components?.find(component => component.type === 'BODY')?.text;
      if (!templateBody) throw new Error('O texto do modelo de atualização do pet não foi encontrado na Meta.');
    }
    const displayedText = templateBody.replace(/\{\{(\d+)\}\}/g, (_, index) => parameters[Number(index) - 1] ?? '');
    const response = await withAutomatedMessage({ db, admin, organizationId, HttpsError, reference: `pet_status_${appointmentId}_${automationId}`, send: async () => axios.post(
      `https://graph.facebook.com/${credentials.graph_version || 'v24.0'}/${credentials.phone_number_id}/messages`,
      { messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, type: 'template', template: { name:templateName, language:{code:language}, components:[{type:'body',parameters:parameters.map(value=>({type:'text',text:value}))}] } },
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
      batch.set(conversationRef.collection('messages').doc(messageId), { provider_message_id: providerMessageId, direction: 'outbound', type: 'template', text:displayedText, template_name:templateName, template_language:language, template_body:templateBody, template_parameters:parameters, status: 'sent', sent_at: now, created_at: now, created_by: 'pet_status_automation' });
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

module.exports = { normalizePetSex, hasPetDelivery, petStatusAutomationId, petStatusMessage, petShortTemplate, petShortTemplateDefinitions, nextPetAction, sendPetStatusNotification };
