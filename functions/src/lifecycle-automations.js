const { withAutomatedMessage } = require("./plan-limits");
const { customerId } = require("./customers");

const DEFINITIONS = [
  { id:'pet_pickup_started',group:'appointments',segmentId:'pet-shop',title:'Saiu para buscar',description:'Avisa quando a equipe sai para buscar o pet no endereço do tutor.',availability:'available',active:false,fixedMessage:true,templateName:'atualizacao_pet',language:'pt_BR',previewMessage:'Olá, Mariana! Nossa equipe está a caminho para buscar Luna. Deixe tudo pronto!' },
  { id:'pet_collected',group:'appointments',segmentId:'pet-shop',title:'Pet coletado',description:'Avisa que o pet está com a equipe, a caminho do pet shop.',availability:'available',active:false,fixedMessage:true,templateName:'atualizacao_pet',language:'pt_BR',previewMessage:'Olá, Mariana! Luna já está com nossa equipe, a caminho do pet shop.' },
  { id:'pet_delivered',group:'appointments',segmentId:'pet-shop',title:'Entrega concluída',description:'Confirma a entrega do pet ao tutor depois do atendimento.',availability:'available',active:false,fixedMessage:true,templateName:'atualizacao_pet',language:'pt_BR',previewMessage:'Olá, Mariana! A entrega de Luna foi concluída. Obrigado pela confiança!' },
  { id: "welcome_message", group: "relationship", title: "Mensagem de apresentação", description: "Apresenta a empresa depois da primeira mensagem do cliente, uma única vez.", availability: "available", active: false, freeform: true, message: "Olá, {{cliente_nome}}! Seja bem-vindo(a) à {{empresa_nome}}. Estamos aqui para ajudar. Escolha uma das opções para continuar." },
  { id: "waitlist", group: "appointments", title: "Lista de espera", description: "Avisa quando um horário compatível ficar disponível.", availability: "requires_waitlist", active: false, delayMinutes: 0, templateName: "horario_lista_espera", language: "pt_BR" },
  { id: "pet_received", group: "appointments", segmentId: "pet-shop", title: "Pet recebido", description: "Avisa o tutor quando o pet chega ao estabelecimento.", availability: "available", active: false, fixedMessage: true, templateName:"atualizacao_pet", language:"pt_BR", previewMessage: "Olá, Mariana! Luna chegou e foi recebida com segurança." },
  { id: "pet_in_service", group: "appointments", segmentId: "pet-shop", title: "Atendimento iniciado", description: "Avisa que o banho ou a tosa começou.", availability: "available", active: false, fixedMessage: true, templateName:"atualizacao_pet", language:"pt_BR", previewMessage: "Olá, Mariana! O atendimento de Luna começou. Ela está sendo cuidada pela nossa equipe." },
  { id: "pet_ready_pickup", group: "appointments", segmentId: "pet-shop", title: "Pronto para retirada", description: "Avisa quando o pet pode ser buscado, respeitando macho, fêmea ou texto neutro.", availability: "available", active: false, fixedMessage: true, templateName:"atualizacao_pet", language:"pt_BR", previewMessage: "Olá, Mariana! Luna já está pronta para você vir buscá-la." },
  { id: "pet_out_for_delivery", group: "appointments", segmentId: "pet-shop", title: "Saiu para entrega", description: "Avisa quando o pet está voltando para casa.", availability: "available", active: false, fixedMessage: true, templateName:"atualizacao_pet", language:"pt_BR", previewMessage: "Olá, Mariana! Luna já está a caminho de casa. Prepare-se para recebê-la!" },
  { id: "customer_recovery", group: "relationship", title: "Recuperação de clientes", description: "Reativa clientes sem atendimento recente e com consentimento.", availability: "available", active: false, delayDays: 30, templateName: "recuperacao_cliente", language: "pt_BR" },
  { id: "quote_followup", group: "relationship", title: "Follow-up de orçamento", description: "Retoma o contato quando o cliente demonstra interesse em um orçamento e não continua a conversa.", availability: "available", active: false, delayMinutes: 1440, templateName: "followup_orcamento", language: "pt_BR" },
  { id: "enrollment_followup", group: "relationship", title: "Acompanhamento de matrícula", description: "Retoma o contato quando o interessado inicia uma matrícula e não continua a conversa.", availability: "available", active: false, delayMinutes: 1440, templateName: "followup_matricula", language: "pt_BR" },
  { id: "visit_followup", group: "relationship", title: "Acompanhamento de visita", description: "Retoma o contato quando o cliente demonstra interesse em visitar um imóvel e não continua a conversa.", availability: "available", active: false, delayMinutes: 1440, templateName: "followup_visita", language: "pt_BR" },
  { id: "post_appointment", group: "appointments", title: "Pós-atendimento e avaliação", description: "Pede uma avaliação depois que o atendimento for concluído.", availability: "available", active: false, delayMinutes: 120, templateName: "avaliacao_atendimento", language: "pt_BR" },
  { id: "pet_post_appointment", group: "appointments", segmentId: "pet-shop", title: "Avaliação do atendimento do pet", description: "Pede uma avaliação depois que o pet for entregue ou retirado.", availability: "available", active: false, delayMinutes: 120, templateName: "avaliacao_atendimento_pet", language: "pt_BR" },
  { id: "pet_return_reminder", group: "relationship", segmentId: "pet-shop", title: "Lembrete de novo banho ou tosa", description: "Lembra o tutor no prazo padrão do pet shop ou no prazo personalizado do pet.", availability: "available", active: false, templateName: "lembrete_retorno_pet", language: "pt_BR" },
  { id: "post_order", group: "orders", title: "Pós-venda do pedido", description: "Pede uma avaliação depois que o pedido for entregue.", availability: "available", active: false, delayMinutes: 120, templateName: "avaliacao_pedido", language: "pt_BR" },
];

const configRef = (db, organizationId) => db.doc(`organizations/${organizationId}/automation_configs/lifecycle_reminders`);
const safeId = value => /^[A-Za-z0-9_-]{1,128}$/.test(String(value || ""));

function mergeConfig(stored = {}) {
  const saved = stored.automations || {};
  return DEFINITIONS.map(definition => ({ ...definition, ...(saved[definition.id] || {}), id: definition.id, group: definition.group, title: definition.title, description: definition.description, availability: definition.availability }));
}

function invalid(HttpsErrorClass, message) {
  return HttpsErrorClass === Error ? new Error(message) : new HttpsErrorClass("invalid-argument", message);
}

function normalizeConfig(input, HttpsErrorClass = Error) {
  if (!Array.isArray(input)) throw invalid(HttpsErrorClass, "Configurações inválidas.");
  const provided = new Map(input.map(item => [String(item?.id || ""), item]));
  if (provided.size !== DEFINITIONS.length || DEFINITIONS.some(item => !provided.has(item.id))) throw invalid(HttpsErrorClass, "Envie todas as configurações de automação.");
  return DEFINITIONS.map(definition => {
    const value = provided.get(definition.id);
    const templateName = String(value.templateName || "").trim();
    const language = String(value.language || "pt_BR").trim();
    const message = String(value.message ?? definition.message ?? "").trim();
    if (!definition.freeform && !/^[a-z0-9_]{3,128}$/.test(templateName)) throw invalid(HttpsErrorClass, `Modelo inválido em ${definition.title}.`);
    if (!definition.freeform && !/^[a-z]{2}_[A-Z]{2}$/.test(language)) throw invalid(HttpsErrorClass, `Idioma inválido em ${definition.title}.`);
    if (definition.freeform && (message.length < 10 || message.length > 1000)) throw invalid(HttpsErrorClass, `A mensagem em ${definition.title} deve ter entre 10 e 1.000 caracteres.`);
    const result = { active: definition.availability === "available" && value.active === true, ...(definition.freeform ? { message } : { template_name: templateName, language }) };
    if (Object.hasOwn(definition, "delayMinutes")) result.delay_minutes = Math.max(0, Math.min(43200, Math.trunc(Number(value.delayMinutes) || 0)));
    if (Object.hasOwn(definition, "delayDays")) { const options=definition.delayDaysOptions || [30,60,90]; result.delay_days = options.includes(Number(value.delayDays)) ? Number(value.delayDays) : definition.delayDays; }
    return { ...definition, ...result, templateName, message, delayMinutes: result.delay_minutes, delayDays: result.delay_days };
  });
}

function timestampMillis(value) {
  if (value?.toMillis) return value.toMillis();
  if (typeof value?._seconds === "number") return value._seconds * 1000;
  if (typeof value?.seconds === "number") return value.seconds * 1000;
  const parsed = value ? new Date(value).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function recoveryEligibility(customer, now = Date.now(), delayDays = 30) {
  if (customer?.marketing_consent !== true || customer?.archived === true) return { eligible: false, reason: "no_consent" };
  const lastActivity = timestampMillis(customer.last_activity_at || customer.last_contact_at || customer.created_at);
  if (!lastActivity) return { eligible: false, reason: "no_activity" };
  if (lastActivity > now - delayDays * 86400000) return { eligible: false, reason: "recent_activity" };
  const lastSent = timestampMillis(customer.recovery_last_sent_at);
  if (lastSent >= lastActivity) return { eligible: false, reason: "already_recovered" };
  return { eligible: true, lastActivity, reference: `${lastActivity}_${delayDays}` };
}

function createLifecycleAutomationFunctions({ admin, db, axios, logger, onCall, HttpsError, onTaskDispatched, onSchedule }) {
  async function authorize(request, ownerOnly = false) {
    if (!request.auth) throw new HttpsError("unauthenticated", "Entre na sua conta.");
    const organizationId = String(request.data?.organizationId || "");
    if (!safeId(organizationId)) throw new HttpsError("invalid-argument", "Empresa inválida.");
    const [organization, member] = await Promise.all([db.doc(`organizations/${organizationId}`).get(), db.doc(`organizations/${organizationId}/members/${request.auth.uid}`).get()]);
    if (!organization.exists || organization.data()?.status === "suspended" || member.data()?.status !== "active") throw new HttpsError("permission-denied", organization.data()?.status === "suspended" ? "Esta empresa está suspensa. Fale com o suporte." : "Você não possui acesso a esta empresa.");
    const canEdit = organization.data()?.proprietario_uid === request.auth.uid;
    if (ownerOnly && !canEdit) throw new HttpsError("permission-denied", "Somente o proprietário pode alterar os ajustes.");
    return { organizationId, canEdit };
  }

  const getLifecycleAutomationConfig = onCall({ region: "southamerica-east1" }, async request => {
    const { organizationId, canEdit } = await authorize(request);
    const snapshot = await configRef(db, organizationId).get();
    return { canEdit, automations: mergeConfig(snapshot.data()).map(item => ({ ...item, templateName: item.template_name || item.templateName, delayMinutes: item.delay_minutes ?? item.delayMinutes, delayDays: item.delay_days ?? item.delayDays })) };
  });

  const saveLifecycleAutomationConfig = onCall({ region: "southamerica-east1" }, async request => {
    const { organizationId } = await authorize(request, true);
    const normalized = normalizeConfig(request.data?.automations, HttpsError);
    const values = Object.fromEntries(normalized.map(item => [item.id, { active: item.active, ...(item.freeform ? { message:item.message } : { template_name:item.template_name, language:item.language }), ...(item.delay_minutes !== undefined ? { delay_minutes: item.delay_minutes } : {}), ...(item.delay_days !== undefined ? { delay_days: item.delay_days } : {}) }]));
    await configRef(db, organizationId).set({ automations: values, updated_at: admin.firestore.FieldValue.serverTimestamp(), updated_by: request.auth.uid }, { merge: true });
    return { saved: true, automations: mergeConfig({ automations: values }).map(item => ({ ...item, templateName: item.template_name || item.templateName, delayMinutes: item.delay_minutes ?? item.delayMinutes, delayDays: item.delay_days ?? item.delayDays })) };
  });

  const sendLifecycleAutomationTask = onTaskDispatched({ region: "southamerica-east1", retryConfig: { maxAttempts: 3, minBackoffSeconds: 60 } }, async request => {
    const organizationId = String(request.data?.organizationId || "");
    const automationId = String(request.data?.automationId || "");
    const entityId = String(request.data?.entityId || "");
    const conversationAutomations = new Set(["quote_followup", "enrollment_followup", "visit_followup"]);
    if (!safeId(organizationId) || !["post_appointment", "pet_post_appointment", "post_order", ...conversationAutomations].includes(automationId) || !safeId(entityId)) return;
    const [configSnapshot, organization, integration] = await Promise.all([configRef(db, organizationId).get(), db.doc(`organizations/${organizationId}`).get(), db.doc(`organizations/${organizationId}/integrations/whatsapp`).get()]);
    const config = mergeConfig(configSnapshot.data()).find(item => item.id === automationId);
    const credentials = integration.data() || {};
    if (!config?.active || !organization.exists || !credentials.phone_number_id || !credentials.access_token) return;
    if (conversationAutomations.has(automationId)) {
      const conversation = await db.doc(`organizations/${organizationId}/conversations/${entityId}`).get();
      const triggerMessageId = String(request.data?.triggerMessageId || "");
      if (!conversation.exists || !triggerMessageId || conversation.data()?.last_inbound_provider_message_id !== triggerMessageId || conversation.data()?.[`lifecycle_${automationId}_sent_for`] === triggerMessageId) return;
      const data = conversation.data();
      const phone = String(data.contact_phone || "").replace(/\D/g, "");
      if (!phone) return;
      const parameters = [data.contact_name || data.profile_name || "Cliente", organization.data()?.nome || "Estabelecimento"];
      const response = await withAutomatedMessage({ db, admin, organizationId, HttpsError, reference: `lifecycle_${automationId}_${triggerMessageId}`, send: async () => {
        const sent = await axios.post(`https://graph.facebook.com/${credentials.graph_version || "v24.0"}/${credentials.phone_number_id}/messages`, { messaging_product: "whatsapp", recipient_type: "individual", to: phone, type: "template", template: { name: config.template_name || config.templateName, language: { code: config.language || "pt_BR" }, components: [{ type: "body", parameters: parameters.map(text => ({ type: "text", text: String(text).slice(0, 1024) })) }] } }, { headers: { Authorization: `Bearer ${credentials.access_token}`, "Content-Type": "application/json" }, timeout: 15000 });
        if (!sent.data?.messages?.[0]?.id) throw new Error("A Meta não confirmou o envio do follow-up.");
        return sent;
      } });
      await conversation.ref.set({ [`lifecycle_${automationId}_sent_for`]: triggerMessageId, [`lifecycle_${automationId}_sent_at`]: admin.firestore.FieldValue.serverTimestamp(), [`lifecycle_${automationId}_provider_message_id`]: response.data.messages[0].id }, { merge: true });
      return;
    }
    const collection = automationId === "post_order" ? "orders" : "appointments";
    const entity = await db.doc(`organizations/${organizationId}/${collection}/${entityId}`).get();
    if (!entity.exists || entity.data()?.status !== "completed" || entity.data()?.[`${automationId}_sent_at`]) return;
    const data = entity.data();
    const phone = String(data.customer_phone || "").replace(/\D/g, "");
    if (!phone) return;
    const parameters = automationId === "post_order" ? [data.customer_name || "Cliente", organization.data()?.nome || "Estabelecimento", data.order_number || entityId.slice(0, 8)] : automationId === "pet_post_appointment" ? [data.customer_name || "Cliente", organization.data()?.nome || "Estabelecimento", data.pet_name || "seu pet", data.service || "atendimento"] : [data.customer_name || "Cliente", organization.data()?.nome || "Estabelecimento", data.service || "atendimento"];
    const response = await withAutomatedMessage({ db, admin, organizationId, HttpsError, reference: `lifecycle_${automationId}_${entityId}`, send: async () => {
      const sent = await axios.post(`https://graph.facebook.com/${credentials.graph_version || "v24.0"}/${credentials.phone_number_id}/messages`, { messaging_product: "whatsapp", recipient_type: "individual", to: phone, type: "template", template: { name: config.template_name || config.templateName, language: { code: config.language || "pt_BR" }, components: [{ type: "body", parameters: parameters.map(text => ({ type: "text", text: String(text).slice(0, 1024) })) }] } }, { headers: { Authorization: `Bearer ${credentials.access_token}`, "Content-Type": "application/json" }, timeout: 15000 });
      if (!sent.data?.messages?.[0]?.id) throw new Error("A Meta não confirmou o envio da automação.");
      return sent;
    } });
    const providerId = response.data?.messages?.[0]?.id;
    await entity.ref.set({ [`${automationId}_sent_at`]: admin.firestore.FieldValue.serverTimestamp(), [`${automationId}_provider_message_id`]: providerId }, { merge: true });
  });

  const processCustomerRecovery = onSchedule({ region: "southamerica-east1", schedule: "0 9 * * *", timeZone: "America/Sao_Paulo", timeoutSeconds: 540, memory: "512MiB" }, async () => {
    const organizations = await db.collection("organizations").get();
    let sent = 0;
    for (const organization of organizations.docs) {
      if (organization.data()?.status === "suspended") continue;
      const organizationId = organization.id;
      const [configSnapshot, integration, customers] = await Promise.all([
        configRef(db, organizationId).get(),
        db.doc(`organizations/${organizationId}/integrations/whatsapp`).get(),
        db.collection(`organizations/${organizationId}/customers`).where("marketing_consent", "==", true).limit(1000).get(),
      ]);
      const config = mergeConfig(configSnapshot.data()).find(item => item.id === "customer_recovery");
      const credentials = integration.data() || {};
      if (!config?.active || !credentials.phone_number_id || !credentials.access_token) continue;
      for (const customer of customers.docs) {
        const data = customer.data();
        const eligibility = recoveryEligibility(data, Date.now(), Number(config.delay_days || config.delayDays || 30));
        if (!eligibility.eligible) continue;
        const phone = String(data.phone || data.phone_key || "").replace(/\D/g, "");
        if (!phone) continue;
        try {
          const response = await withAutomatedMessage({ db, admin, organizationId, HttpsError, reference: `recovery_${customer.id}_${eligibility.reference}`, send: async () => {
            const result = await axios.post(`https://graph.facebook.com/${credentials.graph_version || "v24.0"}/${credentials.phone_number_id}/messages`, { messaging_product: "whatsapp", recipient_type: "individual", to: phone, type: "template", template: { name: config.template_name || config.templateName, language: { code: config.language || "pt_BR" }, components: [{ type: "body", parameters: [data.name || "Cliente", organization.data()?.nome || "Estabelecimento"].map(text => ({ type: "text", text: String(text).slice(0, 1024) })) }] } }, { headers: { Authorization: `Bearer ${credentials.access_token}`, "Content-Type": "application/json" }, timeout: 15000 });
            if (!result.data?.messages?.[0]?.id) throw new Error("A Meta não confirmou o envio da recuperação.");
            return result;
          } });
          const providerId = response.data.messages[0].id;
          const now = admin.firestore.FieldValue.serverTimestamp();
          const batch = db.batch();
          batch.set(customer.ref, { recovery_last_sent_at: now, recovery_last_reference: eligibility.reference, recovery_provider_message_id: providerId, updated_at: now, updated_by: "customer_recovery" }, { merge: true });
          if (data.conversation_id && safeId(data.conversation_id)) batch.set(db.doc(`organizations/${organizationId}/conversations/${data.conversation_id}/messages/${providerId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128)}`), { provider_message_id: providerId, direction: "outbound", type: "template", text: "Mensagem de recuperação enviada", status: "sent", created_by: "automation", created_at: now, sent_at: now }, { merge: true });
          await batch.commit();
          sent += 1;
        } catch (error) {
          logger?.error("Falha na recuperação automática de cliente", { organizationId, customerId: customer.id, message: String(error.message || error).slice(0, 200) });
        }
      }
    }
    logger?.info("Recuperação diária concluída", { sent });
  });

  const processPetReturnReminders = onSchedule({ region: "southamerica-east1", schedule: "30 9 * * *", timeZone: "America/Sao_Paulo", timeoutSeconds: 540, memory: "512MiB" }, async () => {
    const organizations = await db.collection("organizations").get();
    let sent = 0;
    for (const organization of organizations.docs) {
      if (organization.data()?.status === "suspended") continue;
      const organizationId = organization.id;
      const [configSnapshot, integration] = await Promise.all([
        configRef(db, organizationId).get(),
        db.doc(`organizations/${organizationId}/integrations/whatsapp`).get(),
      ]);
      const config = mergeConfig(configSnapshot.data()).find(item => item.id === "pet_return_reminder");
      const credentials = integration.data() || {};
      if (!config?.active || !credentials.phone_number_id || !credentials.access_token) continue;
      const pets = await db.collection(`organizations/${organizationId}/pets`).where("next_care_at", "<=", admin.firestore.Timestamp.now()).limit(300).get();
      for (const pet of pets.docs) {
        const data = pet.data();
        if (data.active === false || !data.next_care_at) continue;
        const reference = String(data.next_care_at.toMillis?.() || data.next_care_at.seconds || "");
        if (!reference || data.return_reminder_sent_for === reference) continue;
        const phone = String(data.tutor_phone || "").replace(/\D/g, "");
        if (!phone) continue;
        const customer = await db.doc(`organizations/${organizationId}/customers/${customerId(phone)}`).get();
        try {
          const response = await withAutomatedMessage({ db, admin, organizationId, HttpsError, reference: `pet_return_${pet.id}_${reference}`, send: async () => {
            const result = await axios.post(`https://graph.facebook.com/${credentials.graph_version || "v24.0"}/${credentials.phone_number_id}/messages`, { messaging_product: "whatsapp", recipient_type: "individual", to: phone, type: "template", template: { name: config.template_name || config.templateName, language: { code: config.language || "pt_BR" }, components: [{ type: "body", parameters: [customer.data()?.name || "Cliente", organization.data()?.nome || "Estabelecimento", data.name || "seu pet", data.last_service || "banho ou tosa"].map(text => ({ type: "text", text: String(text).slice(0, 1024) })) }] } }, { headers: { Authorization: `Bearer ${credentials.access_token}`, "Content-Type": "application/json" }, timeout: 15000 });
            if (!result.data?.messages?.[0]?.id) throw new Error("A Meta não confirmou o lembrete de retorno do pet.");
            return result;
          } });
          await pet.ref.set({ last_recommended_care_at:data.next_care_at, next_care_at:admin.firestore.FieldValue.delete(), return_reminder_sent_for: reference, return_reminder_sent_at: admin.firestore.FieldValue.serverTimestamp(), return_reminder_provider_message_id: response.data.messages[0].id, updated_at: admin.firestore.FieldValue.serverTimestamp(), updated_by: "pet_return_automation" }, { merge: true });
          sent += 1;
        } catch (error) {
          logger?.error("Falha no lembrete de retorno do pet", { organizationId, petId: pet.id, message: String(error.message || error).slice(0, 200) });
        }
      }
    }
    logger?.info("Lembretes de retorno dos pets concluídos", { sent });
  });

  return { getLifecycleAutomationConfig, saveLifecycleAutomationConfig, sendLifecycleAutomationTask, processCustomerRecovery, processPetReturnReminders };
}

module.exports = { createLifecycleAutomationFunctions, DEFINITIONS, mergeConfig, normalizeConfig, recoveryEligibility, timestampMillis };
