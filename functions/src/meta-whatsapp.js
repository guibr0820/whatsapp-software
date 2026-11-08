const crypto = require("node:crypto");
const { createBookingRuntime, createFlowEndpoint, buildDynamicFlow, DEFAULT_BOOKING_KEYWORDS, validateBookingKeywords } = require('./booking-flow');
const { createOrderRuntime } = require('./order-flow');
const { normalizeFlowPrivateKey } = require('./flow-crypto');
const { getOrganizationSegment } = require('./segment-config');
const { assertCollectionLimit, assertFeature, consumeMonthly, releaseMonthly, withAutomatedMessage, entitlements, monthKey, evaluateMonthlyConsumption } = require('./plan-limits');

function normalizeFlowName(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function newestFlow(flows, predicate, preferredId = '') {
  const candidates = flows.filter(predicate).sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
  return candidates.find(flow => String(flow.id) === String(preferredId) && flow.status === 'PUBLISHED')
    || candidates.find(flow => flow.status === 'PUBLISHED')
    || candidates[0]
    || null;
}

function buildOwnerFlowCatalog({ flows = [], configs = new Map(), organizationName = 'Estabelecimento', segment = {}, orderConfig = {}, bookingMenuConfig = {} }) {
  const modules = new Set(Array.isArray(segment.modules) ? segment.modules : []);
  const legacyScreens = new Set(Array.isArray(segment.screens) ? segment.screens : []);
  const isFood = modules.has('orders') || (!segment.modules && ['orders', 'deliveries', 'menu'].some(screen => legacyScreens.has(screen)));
  const isService = modules.has('appointments') || (!segment.modules && ['appointments', 'services', 'employees'].some(screen => legacyScreens.has(screen)));
  const configFor = flow => flow ? (configs.get(String(flow.id)) || {}) : {};
  const booking = newestFlow(flows, flow => {
    const name = normalizeFlowName(flow.name);
    return (flow.categories || []).includes('APPOINTMENT_BOOKING') && !name.includes('meus agendamentos') && !name.includes('finalizar pedido');
  }, [...configs.entries()].find(([, config]) => config.dynamic === true)?.[0]);
  const appointments = newestFlow(flows, flow => normalizeFlowName(flow.name).includes('meus agendamentos'));
  const order = newestFlow(flows, flow => normalizeFlowName(flow.name).includes('finalizar pedido'), orderConfig.flow_id);
  const item = ({ key, title, shortDescription, description, icon, flow, cta, previewMessage, steps, dataUsed, active, keywords }) => ({
    key, title, shortDescription, description, icon, cta, previewMessage, steps, dataUsed,
    managed: true,
    available: Boolean(flow && flow.status === 'PUBLISHED'),
    active: Boolean(flow && flow.status === 'PUBLISHED' && active),
    ...(keywords ? { keywords } : {}),
  });
  const catalog = [];
  if (isService) {
    const bookingConfig = configFor(booking);
    catalog.push(item({ key: 'booking', title: 'Novo agendamento', shortDescription: 'Reserva serviço, profissional, data e horário.', description: 'O cliente escolhe uma opção válida do seu catálogo e conclui a reserva sem sair do WhatsApp.', icon: '▦', flow: booking, cta: 'Agendar horário', previewMessage: `Olá! Escolha o serviço, o profissional, a data e o horário para reservar na ${organizationName}.`, steps: ['O cliente pede para agendar ou toca no menu de atendimento.', 'O WhatsApp mostra somente serviços, profissionais e horários disponíveis.', 'A reserva é registrada e segue as regras de sinal, cancelamento e lembretes.'], dataUsed: ['Serviços ativos', 'Profissionais', 'Agenda disponível', 'Regras de pagamento'], active: bookingConfig.active !== false, keywords: bookingConfig.keywords || DEFAULT_BOOKING_KEYWORDS }));
    catalog.push(item({ key: 'my_appointments', title: 'Meus agendamentos', shortDescription: 'Consulta, remarcação e cancelamento.', description: 'O cliente acompanha os próprios horários e vê apenas as ações permitidas pelas regras do estabelecimento.', icon: '◷', flow: appointments || booking, cta: 'Ver agendamentos', previewMessage: 'Consulte seus próximos horários e, quando permitido, remarque ou cancele pelo WhatsApp.', steps: ['O cliente abre “Meus agendamentos”.', 'A Automichat identifica os horários vinculados ao telefone.', 'As opções disponíveis respeitam sinal, prazo de cancelamento e política de estorno.'], dataUsed: ['Telefone do cliente', 'Horários reservados', 'Status do pagamento', 'Política de cancelamento'], active: bookingMenuConfig.appointments_active !== false }));
  }
  if (isFood) {
    catalog.push(item({ key: 'order_checkout', title: 'Finalizar pedido', shortDescription: 'Confere itens, entrega, contato e pagamento.', description: 'A etapa final do pedido reúne os dados necessários para entrega ou retirada e prepara o pagamento escolhido.', icon: '↗', flow: order, cta: 'Finalizar pedido', previewMessage: `Confira seu pedido na ${organizationName}, escolha entrega ou retirada e defina a forma de pagamento.`, steps: ['O cliente revisa o carrinho e toca em finalizar.', 'O Flow valida contato, endereço e forma de entrega ou retirada.', 'O pedido é criado e, se necessário, o Pix é gerado com os dados obrigatórios.'], dataUsed: ['Itens do carrinho', 'Nome e telefone', 'E-mail para Pix', 'Endereço de entrega'], active: orderConfig.owner_enabled !== false }));
  }
  return catalog;
}

const BUSINESS_VERTICALS = new Set(['UNDEFINED','OTHER','AUTO','BEAUTY','APPAREL','EDU','ENTERTAIN','EVENT_PLAN','FINANCE','GROCERY','GOVT','HOTEL','HEALTH','NONPROFIT','PROF_SERVICES','RETAIL','TRAVEL','RESTAURANT','NOT_A_BIZ']);
function normalizeBusinessProfileInput(input = {}) {
  const clean = (value, max, label) => { const result = String(value || '').trim(); if (result.length > max || /[\u0000-\u001f\u007f]/.test(result)) throw new Error(`${label} inválido.`); return result; };
  const about = clean(input.about, 139, 'Texto Sobre');
  const description = clean(input.description, 256, 'Descrição');
  const address = clean(input.address, 256, 'Endereço');
  const email = clean(input.email, 128, 'E-mail');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('E-mail inválido.');
  const vertical = String(input.vertical || 'UNDEFINED').trim().toUpperCase();
  if (!BUSINESS_VERTICALS.has(vertical)) throw new Error('Categoria inválida.');
  const websites = [input.website, input.website2].map(value => clean(value, 256, 'Site')).filter(Boolean);
  for (const website of websites) { let url; try { url = new URL(website); } catch { throw new Error('Use um endereço de site completo, começando com http:// ou https://.'); } if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use um endereço de site começando com http:// ou https://.'); }
  return { about, description, address, email, vertical, websites };
}

function createMetaWhatsAppFunctions({
  admin,
  db,
  axios,
  logger,
  onCall,
  onRequest,
  onTaskDispatched,
  taskQueue,
  lifecycleTaskQueue,
  supportConversationTaskQueue,
  HttpsError,
  secrets,
  params,
  payments,
}) {
  const region = "southamerica-east1";
  const bookingRuntime = createBookingRuntime({ admin, db, axios, logger, taskQueue, payments, HttpsError, saveOutbound: saveOutboundProviderMessage });
  const orderRuntime = createOrderRuntime({ admin, db, axios, logger, HttpsError, payments, saveOutbound: saveOutboundProviderMessage });
  payments?.setOnPaid(bookingRuntime.finishConfirmed);
  const bookingFlowEndpoint = createFlowEndpoint({ onRequest, privateKey: secrets.flowPrivateKey, appSecret: secrets.appSecret, runtime: bookingRuntime, logger, paymentSecrets: payments?.oauthSecrets || [] });
  const orderFlowEndpoint = createFlowEndpoint({ onRequest, privateKey: secrets.flowPrivateKey, appSecret: secrets.appSecret, runtime: orderRuntime, logger });

  async function subscribeWabaWebhook({ organizationId, wabaId, accessToken, graphVersion }) {
    const expectedAppId = stringParam(params.appId);
    const response = await axios.post(`https://graph.facebook.com/${graphVersion}/${wabaId}/subscribed_apps`, null, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 15000,
    });
    if (response.data?.success !== true) throw new HttpsError("failed-precondition", "A Meta não confirmou a inscrição do webhook.");
    const subscriptions = await axios.get(`https://graph.facebook.com/${graphVersion}/${wabaId}/subscribed_apps`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 15000,
    });
    const subscribedAppIds = (subscriptions.data?.data || []).map((app) => String(app?.whatsapp_business_api_data?.id || app?.id || "")).filter(Boolean);
    if (expectedAppId && !subscribedAppIds.includes(expectedAppId)) throw new HttpsError("failed-precondition", "A conta do WhatsApp não confirmou o aplicativo do Automichat no webhook.");
    logger.info("Inscrição do webhook do WhatsApp conferida", { organizationId, wabaId, expectedAppId, subscribedAppIds });
    return { expectedAppId, subscribedAppIds };
  }

  async function ensureAppMessagesWebhook({ organizationId, graphVersion }) {
    const appId = stringParam(params.appId);
    const appSecret = secretValue(secrets.appSecret);
    const verifyToken = secretValue(secrets.webhookVerifyToken);
    const projectId = String(admin.app().options.projectId || process.env.GCLOUD_PROJECT || '').trim();
    if (!appId || !appSecret || !verifyToken || !projectId) throw new HttpsError("failed-precondition", "As credenciais do webhook da Meta estão incompletas no servidor.");
    const callbackUrl = `https://${region}-${projectId}.cloudfunctions.net/metaWebhook`;
    const appAccessToken = `${appId}|${appSecret}`;
    const response = await axios.post(`https://graph.facebook.com/${graphVersion}/${appId}/subscriptions`, null, {
      params: { object: "whatsapp_business_account", callback_url: callbackUrl, fields: "messages", verify_token: verifyToken, access_token: appAccessToken },
      timeout: 20000,
    });
    if (response.data?.success !== true) throw new HttpsError("failed-precondition", "A Meta não confirmou o callback de mensagens do Automichat.");
    const subscriptions = await axios.get(`https://graph.facebook.com/${graphVersion}/${appId}/subscriptions`, {
      params: { access_token: appAccessToken },
      timeout: 15000,
    });
    const subscription = (subscriptions.data?.data || []).find((item) => String(item?.object || "") === "whatsapp_business_account");
    const fields = (subscription?.fields || []).map((field) => String(field?.name || field || ""));
    if (!subscription || String(subscription.callback_url || "") !== callbackUrl || !fields.includes("messages")) throw new HttpsError("failed-precondition", "O callback da Meta não confirmou o recebimento do campo messages.");
    logger.info("Callback de mensagens do aplicativo Meta conferido", { organizationId, appId, callbackUrl, fields });
    return { callbackUrl, fields };
  }

  const lookupExistingWhatsAppPhoneNumber = onCall(
    { region, secrets: [secrets.systemUserAccessToken] },
    async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Faça login para consultar o número.");
      const organizationId = normalizeDocumentId(request.data?.organizationId, "Empresa inválida.");
      const phoneNumberId = normalizeMetaId(request.data?.phoneNumberId, "Phone Number ID inválido.", HttpsError);
      await assertOrganizationOwner(db, request.auth.uid, organizationId, HttpsError);

      const accessToken = secretValue(secrets.systemUserAccessToken);
      const graphVersion = sanitizeGraphVersion(stringParam(params.graphVersion));
      if (!accessToken) {
        throw new HttpsError("failed-precondition", "O token permanente da Meta ainda não foi configurado no servidor.");
      }

      try {
        const wabaId = await resolveWabaIdForPhone({ axios, graphVersion, accessToken, businessId: stringParam(params.businessId), phoneNumberId });
        if (!wabaId) throw new Error("Não foi possível localizar a conta WhatsApp deste número. Confira os ativos e permissões do usuário do sistema.");
        const phone = await fetchWabaPhoneNumber({ axios, graphVersion, accessToken, wabaId, phoneNumberId });
        return { ...publicPhoneNumber(phone), wabaId };
      } catch (error) {
        logger.warn("Phone Number ID não encontrado no ambiente Meta do Automichat", {
          organizationId,
          phoneNumberId,
          status: error.response?.status || null,
          metaCode: error.response?.data?.error?.code || null,
        });
        throw new HttpsError("failed-precondition", error.discoveryMessage || "Não foi possível validar o número na Meta. Confira o acesso do usuário do sistema à conta WhatsApp.");
      }
    },
  );

  const connectExistingWhatsAppPhoneNumber = onCall(
    { region, secrets: [secrets.systemUserAccessToken, secrets.appSecret, secrets.webhookVerifyToken] },
    async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Faça login para conectar o número.");
      const organizationId = normalizeDocumentId(request.data?.organizationId, "Empresa inválida.");
      const phoneNumberId = normalizeMetaId(request.data?.phoneNumberId, "Phone Number ID inválido.", HttpsError);
      await assertOrganizationOwner(db, request.auth.uid, organizationId, HttpsError);

      const accessToken = secretValue(secrets.systemUserAccessToken);
      const graphVersion = sanitizeGraphVersion(stringParam(params.graphVersion));
      if (!accessToken) {
        throw new HttpsError("failed-precondition", "O token permanente da Meta ainda não foi configurado no servidor.");
      }

      let phone;
      let wabaId;
      try {
        wabaId = await resolveWabaIdForPhone({ axios, graphVersion, accessToken, businessId: stringParam(params.businessId), phoneNumberId });
        if (!wabaId) throw new Error("Não foi possível localizar a conta WhatsApp deste número. Confira os ativos e permissões do usuário do sistema.");
        phone = await fetchWabaPhoneNumber({ axios, graphVersion, accessToken, wabaId, phoneNumberId });
        await ensureAppMessagesWebhook({ organizationId, graphVersion });
        await subscribeWabaWebhook({ organizationId, wabaId, accessToken, graphVersion });
      } catch (error) {
        logger.warn("Falha ao validar Phone Number ID antes da conexão", {
          organizationId,
          wabaId,
          phoneNumberId,
          status: error.response?.status || null,
          metaCode: error.response?.data?.error?.code || null,
        });
        throw new HttpsError("failed-precondition", error.discoveryMessage || "Não foi possível validar o número na Meta. Confira o acesso do usuário do sistema à conta WhatsApp.");
      }

      const now = admin.firestore.FieldValue.serverTimestamp();
      const mappingRef = db.doc(`meta_phone_numbers/${phoneNumberId}`);
      const privateRef = db.doc(`organizations/${organizationId}/integrations/whatsapp`);
      const publicRef = db.doc(`organizations/${organizationId}/public_integrations/whatsapp`);

      await db.runTransaction(async (transaction) => {
        const mapping = await transaction.get(mappingRef);
        if (mapping.exists && mapping.data().active === true && mapping.data().organization_id !== organizationId) {
          throw new HttpsError("already-exists", "Este Phone Number ID já está vinculado a outra empresa no Automichat.");
        }

        transaction.set(privateRef, {
          active: true,
          provider: "meta",
          connection_mode: "existing_phone_number_id",
          access_token: accessToken,
          token_type: "system_user",
          expires_in: null,
          waba_id: wabaId,
          phone_number_id: phoneNumberId,
          display_phone_number: phone.display_phone_number || null,
          verified_name: phone.verified_name || null,
          quality_rating: phone.quality_rating || null,
          graph_version: graphVersion,
          webhook_subscribed: true,
          webhook_app_id: stringParam(params.appId),
          webhook_subscribed_at: now,
          connected_by: request.auth.uid,
          connected_at: now,
          updated_at: now,
        }, { merge: true });
        transaction.set(publicRef, {
          status: "active",
          provider: "meta",
          connection_mode: "existing_phone_number_id",
          waba_id: wabaId,
          phone_number_id: phoneNumberId,
          display_phone_number: phone.display_phone_number || null,
          verified_name: phone.verified_name || null,
          quality_rating: phone.quality_rating || null,
          connected_at: now,
          updated_at: now,
        }, { merge: true });
        transaction.set(mappingRef, {
          organization_id: organizationId,
          waba_id: wabaId,
          active: true,
          updated_at: now,
        }, { merge: true });
      });

      logger.info("WhatsApp conectado ao Automichat por Phone Number ID existente", {
        organizationId,
        wabaId,
        phoneNumberId,
        uid: request.auth.uid,
      });
      return { connected: true, wabaId, ...publicPhoneNumber(phone) };
    },
  );

  const ensureWhatsAppWebhookSubscription = onCall(
    { region, secrets: [secrets.appSecret, secrets.webhookVerifyToken] },
    async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Faça login para conferir a conexão do WhatsApp.");
      const organizationId = normalizeDocumentId(request.data?.organizationId, "Empresa inválida.");
      await assertOrganizationOwner(db, request.auth.uid, organizationId, HttpsError);
      const ref = db.doc(`organizations/${organizationId}/integrations/whatsapp`);
      const integration = (await ref.get()).data() || {};
      if (!integration.active || !integration.access_token || !integration.waba_id) throw new HttpsError("failed-precondition", "Conecte novamente o WhatsApp para receber mensagens.");
      const graphVersion = sanitizeGraphVersion(integration.graph_version || stringParam(params.graphVersion));
      try {
        await ensureAppMessagesWebhook({ organizationId, graphVersion });
        const result = await subscribeWabaWebhook({ organizationId, wabaId: String(integration.waba_id), accessToken: integration.access_token, graphVersion });
        await ref.set({ webhook_subscribed: true, webhook_app_id: result.expectedAppId, webhook_subscribed_at: admin.firestore.FieldValue.serverTimestamp(), updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        return { subscribed: true };
      } catch (error) {
        await ref.set({ webhook_subscribed: false, webhook_error_at: admin.firestore.FieldValue.serverTimestamp(), updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        logger.warn("Falha ao reparar a inscrição do webhook do WhatsApp", { organizationId, status: error.response?.status || null, metaCode: error.response?.data?.error?.code || null });
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("failed-precondition", error.response?.data?.error?.message || "A Meta não permitiu reparar o webhook. Reconecte o WhatsApp.");
      }
    },
  );

  const disconnectWhatsApp = onCall(
    { region },
    async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Faça login para desconectar o WhatsApp.");
      const organizationId = normalizeDocumentId(request.data?.organizationId, "Empresa inválida.");
      await assertOrganizationOwner(db, request.auth.uid, organizationId, HttpsError);

      const privateRef = db.doc(`organizations/${organizationId}/integrations/whatsapp`);
      const publicRef = db.doc(`organizations/${organizationId}/public_integrations/whatsapp`);
      const privateSnapshot = await privateRef.get();
      if (!privateSnapshot.exists || privateSnapshot.data().active !== true) {
        throw new HttpsError("failed-precondition", "Este WhatsApp já está desconectado.");
      }

      const phoneNumberId = normalizeMetaId(privateSnapshot.data().phone_number_id, "Phone Number ID inválido.", HttpsError);
      const mappingRef = db.doc(`meta_phone_numbers/${phoneNumberId}`);
      const now = admin.firestore.FieldValue.serverTimestamp();
      await db.runTransaction(async (transaction) => {
        const mapping = await transaction.get(mappingRef);
        transaction.set(privateRef, {
          active: false,
          access_token: admin.firestore.FieldValue.delete(),
          disconnected_by: request.auth.uid,
          disconnected_at: now,
          updated_at: now,
        }, { merge: true });
        transaction.set(publicRef, {
          status: "disconnected",
          disconnected_at: now,
          updated_at: now,
        }, { merge: true });
        if (mapping.exists && mapping.data().organization_id === organizationId) {
          transaction.set(mappingRef, { active: false, updated_at: now }, { merge: true });
        }
      });

      logger.info("WhatsApp desconectado do Automichat", { organizationId, phoneNumberId, uid: request.auth.uid });
      return { disconnected: true };
    },
  );

  const getWhatsAppBusinessProfile = onCall({ region }, async request => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Entre para consultar o perfil.');
    const organizationId = normalizeDocumentId(request.data?.organizationId, 'Empresa inválida.');
    await assertOrganizationOwner(db, request.auth.uid, organizationId, HttpsError);
    const [organizationSnapshot, integrationSnapshot] = await Promise.all([
      db.doc(`organizations/${organizationId}`).get(),
      db.doc(`organizations/${organizationId}/integrations/whatsapp`).get(),
    ]);
    const local = organizationSnapshot.data()?.business_profile || {};
    const integration = integrationSnapshot.data() || {};
    if (!integration.active || !integration.access_token || !integration.phone_number_id) return { profile: local, metaConnected: false, synced: false };
    try {
      const graphVersion = sanitizeGraphVersion(integration.graph_version);
      const [response, phoneResponse] = await Promise.all([
        axios.get(`https://graph.facebook.com/${graphVersion}/${integration.phone_number_id}/whatsapp_business_profile`, {
          params: { fields: 'about,address,description,email,profile_picture_url,websites,vertical' },
          headers: { Authorization: `Bearer ${integration.access_token}` }, timeout: 15000,
        }),
        axios.get(`https://graph.facebook.com/${graphVersion}/${integration.phone_number_id}`, {
          params: { fields: 'verified_name,display_phone_number,name_status' },
          headers: { Authorization: `Bearer ${integration.access_token}` }, timeout: 15000,
        }).catch(() => ({ data: {} })),
      ]);
      const remote = response.data?.data?.[0] || {};
      const profile = { about:remote.about || '', address:remote.address || '', description:remote.description || '', email:remote.email || '', vertical:remote.vertical || 'UNDEFINED', websites:Array.isArray(remote.websites)?remote.websites.slice(0,2):[], profilePictureUrl:remote.profile_picture_url || '', displayName:phoneResponse.data?.verified_name || '', displayNameStatus:phoneResponse.data?.name_status || '', displayPhoneNumber:phoneResponse.data?.display_phone_number || '' };
      await organizationSnapshot.ref.set({ business_profile:profile, business_profile_synced_at:admin.firestore.FieldValue.serverTimestamp() }, { merge:true });
      return { profile, metaConnected:true, synced:true };
    } catch (error) {
      logger.warn('Falha segura ao consultar perfil comercial da Meta', { organizationId, status:error.response?.status || null, metaCode:error.response?.data?.error?.code || null });
      return { profile:local, metaConnected:true, synced:false, warning:'Não foi possível consultar a Meta agora. Exibimos os últimos dados salvos.' };
    }
  });

  const updateWhatsAppProfilePicture = onCall({ region, timeoutSeconds: 60, memory: '256MiB' }, async request => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Entre para alterar a foto do WhatsApp.');
    const organizationId = normalizeDocumentId(request.data?.organizationId, 'Empresa inválida.');
    await assertOrganizationOwner(db, request.auth.uid, organizationId, HttpsError);
    const mimeType = String(request.data?.mimeType || '').trim().toLowerCase();
    const fileName = String(request.data?.fileName || 'perfil.jpg').trim().slice(0, 120);
    const encoded = String(request.data?.base64 || '').replace(/^data:[^;]+;base64,/, '');
    if (!['image/jpeg', 'image/png'].includes(mimeType)) throw new HttpsError('invalid-argument', 'Use uma imagem JPG ou PNG.');
    if (!/^[a-zA-Z0-9+/=]+$/.test(encoded)) throw new HttpsError('invalid-argument', 'A imagem enviada é inválida.');
    const buffer = Buffer.from(encoded, 'base64');
    if (!buffer.length || buffer.length > 5 * 1024 * 1024) throw new HttpsError('invalid-argument', 'A imagem deve ter no máximo 5 MB.');
    const integration = (await db.doc(`organizations/${organizationId}/integrations/whatsapp`).get()).data() || {};
    if (!integration.active || !integration.access_token || !integration.phone_number_id) throw new HttpsError('failed-precondition', 'Conecte o WhatsApp antes de alterar a foto.');
    const graphVersion = sanitizeGraphVersion(integration.graph_version);
    const appId = stringParam(params.appId);
    if (!appId) throw new HttpsError('failed-precondition', 'O aplicativo da Meta não está configurado.');
    try {
      const uploadSession = await axios.post(`https://graph.facebook.com/${graphVersion}/${appId}/uploads`, null, {
        params: { file_length: buffer.length, file_type: mimeType, file_name: fileName },
        headers: { Authorization: `Bearer ${integration.access_token}` }, timeout: 15000,
      });
      const uploadId = String(uploadSession.data?.id || '');
      if (!uploadId) throw new Error('A Meta não iniciou o envio da imagem.');
      const upload = await axios.post(`https://graph.facebook.com/${graphVersion}/${uploadId}`, buffer, {
        headers: { Authorization: `OAuth ${integration.access_token}`, file_offset: '0', 'Content-Type': 'application/octet-stream' },
        maxBodyLength: 6 * 1024 * 1024, timeout: 30000,
      });
      const handle = String(upload.data?.h || '');
      if (!handle) throw new Error('A Meta não confirmou o arquivo enviado.');
      const updated = await axios.post(`https://graph.facebook.com/${graphVersion}/${integration.phone_number_id}/whatsapp_business_profile`, { messaging_product: 'whatsapp', profile_picture_handle: handle }, { headers: { Authorization: `Bearer ${integration.access_token}`, 'Content-Type':'application/json' }, timeout:15000 });
      if (updated.data?.success !== true) throw new Error('A Meta não confirmou a atualização da foto.');
      await db.doc(`organizations/${organizationId}`).set({ business_profile_synced_at:admin.firestore.FieldValue.serverTimestamp(), atualizado_em:admin.firestore.FieldValue.serverTimestamp() }, { merge:true });
      return { updated:true };
    } catch (error) {
      logger.warn('Falha segura ao atualizar foto comercial da Meta', { organizationId, status:error.response?.status || null, metaCode:error.response?.data?.error?.code || null });
      throw new HttpsError('failed-precondition', error.response?.data?.error?.message || error.message || 'A Meta não permitiu atualizar a foto agora.');
    }
  });

  const saveWhatsAppBusinessProfile = onCall({ region }, async request => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Entre para salvar o perfil.');
    const organizationId = normalizeDocumentId(request.data?.organizationId, 'Empresa inválida.');
    await assertOrganizationOwner(db, request.auth.uid, organizationId, HttpsError);
    let profile;
    try { profile = normalizeBusinessProfileInput(request.data?.profile); }
    catch (error) { throw new HttpsError('invalid-argument', error.message); }
    const integration = (await db.doc(`organizations/${organizationId}/integrations/whatsapp`).get()).data() || {};
    if (!integration.active || !integration.access_token || !integration.phone_number_id) {
      await db.doc(`organizations/${organizationId}`).set({ business_profile:profile, atualizado_em:admin.firestore.FieldValue.serverTimestamp() }, { merge:true });
      return { saved:true, synced:false, profile, warning:'Perfil salvo no Automichat. Conecte o WhatsApp para sincronizar esses dados com a Meta.' };
    }
    try {
      const graphVersion = sanitizeGraphVersion(integration.graph_version);
      const payload = { messaging_product:'whatsapp', vertical:profile.vertical, address:profile.address, description:profile.description, email:profile.email, websites:profile.websites, ...(profile.about ? { about:profile.about } : {}) };
      const response = await axios.post(`https://graph.facebook.com/${graphVersion}/${integration.phone_number_id}/whatsapp_business_profile`, payload, { headers:{ Authorization:`Bearer ${integration.access_token}`, 'Content-Type':'application/json' }, timeout:15000 });
      if (response.data?.success !== true) throw new Error('A Meta não confirmou a atualização.');
    } catch (error) {
      logger.warn('Falha segura ao atualizar perfil comercial da Meta', { organizationId, status:error.response?.status || null, metaCode:error.response?.data?.error?.code || null });
      throw new HttpsError('failed-precondition', error.response?.data?.error?.message || 'A Meta não permitiu atualizar o perfil comercial agora.');
    }
    await db.doc(`organizations/${organizationId}`).set({ business_profile:profile, business_profile_synced_at:admin.firestore.FieldValue.serverTimestamp(), atualizado_em:admin.firestore.FieldValue.serverTimestamp() }, { merge:true });
    return { saved:true, synced:true, profile };
  });

  const listWhatsAppFlows = onCall({ region }, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Faça login para consultar os Flows.");
    const organizationId = normalizeDocumentId(request.data?.organizationId, "Empresa inválida.");
    await assertOrganizationOwner(db, request.auth.uid, organizationId, HttpsError);
    const integration = (await db.doc(`organizations/${organizationId}/integrations/whatsapp`).get()).data();
    if (!integration?.active || !integration.access_token) throw new HttpsError("failed-precondition", "Conecte o WhatsApp antes de consultar os Flows.");
    const graphVersion = sanitizeGraphVersion(integration.graph_version);
    let wabaId = String(integration.waba_id || "");
    {
      try {
        wabaId = await resolveWabaIdForPhone({ axios, graphVersion, accessToken: integration.access_token, businessId: stringParam(params.businessId), phoneNumberId: integration.phone_number_id });
      } catch (error) {
        logger.warn("Falha segura ao localizar a WABA do número conectado", { organizationId, status: error.response?.status || null, metaCode: error.response?.data?.error?.code || null });
        throw new HttpsError("failed-precondition", error.discoveryMessage || "Não foi possível localizar a conta WhatsApp Business deste número.");
      }
      if (wabaId && wabaId !== integration.waba_id) {
        await db.doc(`organizations/${organizationId}/integrations/whatsapp`).set({ waba_id: wabaId, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      }
    }
    if (!wabaId) throw new HttpsError("failed-precondition", "A Meta não informou a conta comercial deste número.");
    try {
      const tokenDebug = await axios.get(`https://graph.facebook.com/${graphVersion}/debug_token`, {
        params: { input_token: integration.access_token },
        headers: { Authorization: `Bearer ${integration.access_token}` },
        timeout: 15000,
      });
      const tokenData = tokenDebug.data?.data || {};
      const expectedAppId = stringParam(params.appId);
      const tokenAppId = String(tokenData.app_id || "");
      const tokenScopes = Array.isArray(tokenData.scopes) ? tokenData.scopes.map(String) : [];
      logger.info("Token da Meta conferido para inscrição do webhook", {
        organizationId,
        wabaId,
        expectedAppId,
        tokenAppId,
        tokenValid: tokenData.is_valid === true,
        hasManagementPermission: tokenScopes.includes("whatsapp_business_management"),
        hasMessagingPermission: tokenScopes.includes("whatsapp_business_messaging"),
      });
      if (tokenData.is_valid !== true) {
        throw new HttpsError("failed-precondition", "O token permanente da Meta está inválido.");
      }
      if (tokenAppId !== expectedAppId) {
        throw new HttpsError("failed-precondition", `O token pertence ao App ID ${tokenAppId || "desconhecido"}, mas o Automichat usa o App ID ${expectedAppId}. Gere o token selecionando o aplicativo GRSYSTEM correto.`);
      }
      if (!tokenScopes.includes("whatsapp_business_management")) {
        throw new HttpsError("failed-precondition", "O token não possui a permissão whatsapp_business_management.");
      }
      const subscriptionResult = await axios.post(`https://graph.facebook.com/${graphVersion}/${wabaId}/subscribed_apps`, null, {
        headers: { Authorization: `Bearer ${integration.access_token}` },
        timeout: 15000,
      });
      logger.info("Resposta da Meta ao inscrever a WABA", {
        organizationId,
        wabaId,
        success: subscriptionResult.data?.success === true,
      });
      if (subscriptionResult.data?.success !== true) {
        throw new HttpsError("failed-precondition", "A Meta não confirmou a inscrição da conta WhatsApp no webhook.");
      }
      const subscriptions = await axios.get(`https://graph.facebook.com/${graphVersion}/${wabaId}/subscribed_apps`, {
        headers: { Authorization: `Bearer ${integration.access_token}` },
        timeout: 15000,
      });
      const subscribedApps = (subscriptions.data?.data || []).map((app) => ({
        id: String(app?.whatsapp_business_api_data?.id || app?.id || ""),
        name: String(app?.whatsapp_business_api_data?.name || app?.name || ""),
      }));
      const expectedAppSubscribed = subscribedApps.some((app) => app.id === expectedAppId);
      logger.info("Inscrição da WABA no webhook conferida", {
        organizationId,
        wabaId,
        expectedAppId,
        expectedAppSubscribed,
        subscribedAppIds: subscribedApps.map((app) => app.id),
      });
      if (!expectedAppSubscribed) {
        throw new HttpsError("failed-precondition", `A Meta aceitou a inscrição, mas o aplicativo ${expectedAppId} ainda não aparece vinculado à conta WhatsApp ${wabaId}.`);
      }
      await db.doc(`organizations/${organizationId}/integrations/whatsapp`).set({
        webhook_subscribed: true,
        webhook_app_id: expectedAppId,
        webhook_subscribed_at: admin.firestore.FieldValue.serverTimestamp(),
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      logger.warn("Falha ao inscrever a WABA no webhook", { organizationId, wabaId, status: error.response?.status || null, metaCode: error.response?.data?.error?.code || null });
      throw new HttpsError("failed-precondition", error.response?.data?.error?.message || "Não foi possível inscrever esta conta no webhook. Confirme a permissão whatsapp_business_management do token.");
    }
    let response;
    try {
      response = { data: { data: await fetchAllMetaRows({ axios, graphVersion, accessToken: integration.access_token, path: `${wabaId}/flows`, fields: "id,name,status,categories,validation_errors" }) } };
    } catch (error) {
      logger.warn("Falha segura ao listar WhatsApp Flows", { organizationId, wabaId, status: error.response?.status || null, metaCode: error.response?.data?.error?.code || null });
      throw new HttpsError("unavailable", "A Meta não permitiu consultar os Flows desta conta. Confirme se o Flow foi criado na mesma WABA e se o token possui whatsapp_business_management.");
    }
    const [configs, organizationSnapshot, segmentsSnapshot, orderConfigSnapshot, bookingMenuSnapshot] = await Promise.all([
      db.collection(`organizations/${organizationId}/flow_configs`).get(),
      db.doc(`organizations/${organizationId}`).get(),
      db.collection('app_segments').get(),
      db.doc(`organizations/${organizationId}/automation_configs/order_checkout`).get(),
      db.doc(`organizations/${organizationId}/automation_configs/booking_menu`).get(),
    ]);
    const organization = organizationSnapshot.data() || {};
    const saved = new Map(configs.docs.map((item) => [item.id, item.data()]));
    const segment = segmentsSnapshot.docs.map(item => ({ id: item.id, ...item.data() })).find(item => item.name === organization.segmento) || { name: organization.segmento || 'Geral', screens: [] };
    const rawFlows = (response.data?.data || []).map(flow => ({ id: String(flow.id), name: flow.name || '', status: flow.status || '', categories: flow.categories || [] }));
    return {
      segment: { name: segment.name || 'Geral', screens: Array.isArray(segment.screens) ? segment.screens : [] },
      flows: buildOwnerFlowCatalog({ flows: rawFlows, configs: saved, organizationName: organization.nome || 'Estabelecimento', segment, orderConfig: orderConfigSnapshot.data() || {}, bookingMenuConfig: bookingMenuSnapshot.data() || {} }),
    };
  });

  const saveWhatsAppFlowConfig = onCall({ region }, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Faça login para configurar o Flow.");
    const organizationId = normalizeDocumentId(request.data?.organizationId, "Empresa inválida.");
    const automationKey = String(request.data?.automationKey || '').trim();
    if (!['booking', 'my_appointments', 'order_checkout'].includes(automationKey)) throw new HttpsError('invalid-argument', 'Jornada inválida.');
    const active = request.data?.active === true;
    let keywords;
    if (automationKey === 'booking' && request.data?.keywords !== undefined) {
      try { keywords = validateBookingKeywords(request.data.keywords); }
      catch (error) { throw new HttpsError('invalid-argument', error.message); }
    }
    await assertOrganizationOwner(db, request.auth.uid, organizationId, HttpsError);
    const integration = (await db.doc(`organizations/${organizationId}/integrations/whatsapp`).get()).data();
    if (!integration?.active || !integration.access_token) throw new HttpsError("failed-precondition", "Conecte o WhatsApp antes de configurar o Flow.");
    const graphVersion = sanitizeGraphVersion(integration.graph_version);
    const [organizationSnapshot, segmentsSnapshot, configsSnapshot, orderConfigSnapshot, bookingMenuSnapshot] = await Promise.all([
      db.doc(`organizations/${organizationId}`).get(), db.collection('app_segments').get(), db.collection(`organizations/${organizationId}/flow_configs`).get(), db.doc(`organizations/${organizationId}/automation_configs/order_checkout`).get(), db.doc(`organizations/${organizationId}/automation_configs/booking_menu`).get(),
    ]);
    const organization = organizationSnapshot.data() || {};
    const segment = segmentsSnapshot.docs.map(item => ({ id: item.id, ...item.data() })).find(item => item.name === organization.segmento) || { name: organization.segmento || 'Geral', screens: [] };
    let rows;
    try {
      rows = await fetchAllMetaRows({ axios, graphVersion, accessToken: integration.access_token, path: `${integration.waba_id}/flows`, fields: 'id,name,status,categories' });
    } catch (error) {
      logger.warn('Falha segura ao validar catálogo de Flows', { organizationId, status: error.response?.status || null });
      throw new HttpsError('unavailable', 'Não foi possível validar a jornada na Meta.');
    }
    const saved = new Map(configsSnapshot.docs.map(item => [item.id, item.data()]));
    const catalog = buildOwnerFlowCatalog({ flows: rows, configs: saved, organizationName: organization.nome || 'Estabelecimento', segment, orderConfig: orderConfigSnapshot.data() || {}, bookingMenuConfig: bookingMenuSnapshot.data() || {} });
    const selected = catalog.find(item => item.key === automationKey);
    if (!selected) throw new HttpsError('permission-denied', 'Esta jornada não pertence ao segmento do estabelecimento.');
    if (!selected.available) throw new HttpsError('failed-precondition', 'Esta jornada ainda está sendo preparada pela Automichat.');
    if (automationKey === 'order_checkout') {
      await db.doc(`organizations/${organizationId}/automation_configs/order_checkout`).set({ owner_enabled: active, updated_by: request.auth.uid, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return { saved: true, automationKey, active };
    }
    if (automationKey === 'my_appointments') {
      await db.doc(`organizations/${organizationId}/automation_configs/booking_menu`).set({ appointments_active: active, updated_by: request.auth.uid, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return { saved: true, automationKey, active };
    }
    const matched = automationKey === 'booking'
      ? newestFlow(rows, flow => (flow.categories || []).includes('APPOINTMENT_BOOKING') && !normalizeFlowName(flow.name).includes('meus agendamentos') && !normalizeFlowName(flow.name).includes('finalizar pedido'), [...saved.entries()].find(([, config]) => config.dynamic === true)?.[0])
      : newestFlow(rows, flow => normalizeFlowName(flow.name).includes('meus agendamentos'));
    if (!matched || matched.status !== 'PUBLISHED') throw new HttpsError('failed-precondition', 'A jornada ainda não está publicada pela Automichat.');
    const flowId = String(matched.id);
    await db.doc(`organizations/${organizationId}/flow_configs/${flowId}`).set({ active, ...(keywords !== undefined ? { keywords } : {}), updated_by: request.auth.uid, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    const savedConfig = { ...(saved.get(flowId) || {}), active, ...(keywords !== undefined ? { keywords } : {}) };
    if (automationKey === 'booking' && savedConfig.dynamic) {
      const menuRef = db.doc(`organizations/${organizationId}/automation_configs/booking_menu`);
      await db.runTransaction(async transaction => {
        const current = await transaction.get(menuRef);
        if (active || current.data()?.flow_id === flowId) transaction.set(menuRef, { active, flow_id: flowId, keywords: keywords ?? savedConfig.keywords ?? DEFAULT_BOOKING_KEYWORDS, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      });
    }
    return { saved: true, automationKey, active };
  });

  const getAppointmentReminderConfig = onCall({ region }, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Faça login para consultar o lembrete.");
    const organizationId = normalizeDocumentId(request.data?.organizationId, "Empresa inválida.");
    await assertOrganizationOwner(db, request.auth.uid, organizationId, HttpsError);
    const snapshot = await db.doc(`organizations/${organizationId}/automation_configs/appointment_reminder`).get();
    const data = snapshot.exists ? snapshot.data() : {};
    return {
      templateName: data.template_name || "lembrete_teste_whatsapp",
      language: data.language || "pt_BR",
      trigger: data.trigger || "after_confirmation",
      delaySeconds: Number(data.delay_seconds) || 30,
      leadTimeMinutes: Number(data.lead_time_minutes) || 1440,
      schedules: Array.isArray(data.schedules) && data.schedules.length ? data.schedules.map(Number) : [Number(data.lead_time_minutes) || 1440],
      active: data.active === true,
      appointmentConfirmationActive: data.appointment_confirmation_active !== false,
      paymentConfirmationActive: data.payment_confirmation_active !== false,
      templateStatus: data.template_status || "",
    };
  });

  const saveAppointmentReminderConfig = onCall({ region }, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Faça login para configurar o lembrete.");
    const organizationId = normalizeDocumentId(request.data?.organizationId, "Empresa inválida.");
    await assertOrganizationOwner(db, request.auth.uid, organizationId, HttpsError);
    const templateName = String(request.data?.templateName || "").trim();
    const language = String(request.data?.language || "").trim();
    const trigger = String(request.data?.trigger || "after_confirmation");
    const delaySeconds = Number(request.data?.delaySeconds);
    const leadTimeMinutes = Number(request.data?.leadTimeMinutes);
    const schedules = [...new Set((Array.isArray(request.data?.schedules) ? request.data.schedules : [leadTimeMinutes]).map(Number))];
    const active = request.data?.active === true;
    const appointmentConfirmationActive = request.data?.appointmentConfirmationActive !== false;
    const paymentConfirmationActive = request.data?.paymentConfirmationActive !== false;
    if (request.data?.stateOnly === true) {
      await db.doc(`organizations/${organizationId}/automation_configs/appointment_reminder`).set({
        appointment_confirmation_active: appointmentConfirmationActive,
        payment_confirmation_active: paymentConfirmationActive,
        updated_by: request.auth.uid,
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return { appointmentConfirmationActive, paymentConfirmationActive };
    }
    if (!/^[a-z0-9_]{1,512}$/.test(templateName)) throw new HttpsError("invalid-argument", "Nome do modelo inválido.");
    if (!/^[a-z]{2}_[A-Z]{2}$/.test(language)) throw new HttpsError("invalid-argument", "Idioma do modelo inválido.");
    if (!["after_confirmation", "before_appointment"].includes(trigger)) throw new HttpsError("invalid-argument", "Momento do envio inválido.");
    if (![10, 30, 60, 300].includes(delaySeconds)) throw new HttpsError("invalid-argument", "Atraso após confirmação inválido.");
    if (![5, 60, 120, 1440].includes(leadTimeMinutes)) throw new HttpsError("invalid-argument", "Antecedência inválida.");
    if (!schedules.length || schedules.some(value => ![60, 120, 1440].includes(value))) throw new HttpsError("invalid-argument", "Escolha lembretes de 24 horas, 2 horas ou 1 hora.");
    const integration = (await db.doc(`organizations/${organizationId}/integrations/whatsapp`).get()).data() || {};
    if (!integration.active || !integration.access_token || !integration.waba_id) throw new HttpsError("failed-precondition", "Conecte o WhatsApp e atualize os Flows antes de validar o lembrete.");
    const graphVersion = sanitizeGraphVersion(integration.graph_version);
    let template;
    try {
      const response = await axios.get(`https://graph.facebook.com/${graphVersion}/${integration.waba_id}/message_templates`, {
        params: { name: templateName, fields: "id,name,status,language,category,components", limit: 100 },
        headers: { Authorization: `Bearer ${integration.access_token}` },
        timeout: 15000,
      });
      template = (response.data?.data || []).find((item) => item.name === templateName && item.language === language);
    } catch (error) {
      logger.warn("Falha segura ao validar modelo de lembrete", { organizationId, status: error.response?.status || null, metaCode: error.response?.data?.error?.code || null });
      throw new HttpsError("unavailable", "A Meta não permitiu consultar os modelos desta conta.");
    }
    if (!template) throw new HttpsError("not-found", `O modelo ${templateName} no idioma ${language} não foi encontrado nesta conta.`);
    if (template.status !== "APPROVED") throw new HttpsError("failed-precondition", `O modelo está com status ${template.status || "desconhecido"}, não APPROVED.`);
    const body = (template.components || []).find((component) => component.type === "BODY");
    const parameterCount = templateParameterCount(body?.text);
    if (parameterCount !== 4) throw new HttpsError("failed-precondition", `O modelo precisa ter exatamente 4 variáveis no corpo; a Meta informou ${parameterCount}.`);
    const now = admin.firestore.FieldValue.serverTimestamp();
    await db.doc(`organizations/${organizationId}/automation_configs/appointment_reminder`).set({
      active,
      appointment_confirmation_active: appointmentConfirmationActive,
      payment_confirmation_active: paymentConfirmationActive,
      template_id: String(template.id || ""),
      template_name: templateName,
      template_status: template.status,
      category: template.category || "UTILITY",
      language,
      trigger,
      delay_seconds: delaySeconds,
      lead_time_minutes: leadTimeMinutes,
      schedules,
      variable_map: { "1": "customer_name", "2": "organization_name", "3": "appointment_date", "4": "appointment_time" },
      updated_by: request.auth.uid,
      updated_at: now,
    }, { merge: true });
    return { templateName, language, trigger, delaySeconds, leadTimeMinutes, schedules, active, appointmentConfirmationActive, paymentConfirmationActive, templateStatus: template.status };
  });

  const createAppointmentFlow = onCall({ region, secrets: [secrets.flowPrivateKey] }, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Faça login para criar o Flow.");
    if (request.auth.token?.admin !== true) throw new HttpsError('permission-denied', 'A publicação técnica de Flows é restrita à administração da Automichat.');
    const organizationId = normalizeDocumentId(request.data?.organizationId, "Empresa inválida.");
    if (!(await db.doc(`organizations/${organizationId}`).get()).exists) throw new HttpsError('not-found', 'Empresa não encontrada.');
    await assertCollectionLimit(db, organizationId, "flow_configs", "flows", HttpsError);
    const text = (key, max) => {
      const value = String(request.data?.[key] || "").trim();
      if (!value || value.length > max) throw new HttpsError("invalid-argument", `Campo ${key} inválido.`);
      return value;
    };
    const sourceFlowId = String(request.data?.sourceFlowId || "").trim();
    if (sourceFlowId && !/^\d{5,30}$/.test(sourceFlowId)) throw new HttpsError("invalid-argument", "Flow de origem inválido.");
    const catalogConfig = await buildAppointmentCatalog(db, organizationId, HttpsError);
    const requestedName = text("name", 80);
    const metaName = sourceFlowId ? `${requestedName.slice(0, 58)} ${compactTimestamp()}` : requestedName;
    const config = { name: metaName, displayName: requestedName, title: text("title", 60), description: text("description", 300), submitLabel: text("submitLabel", 20), confirmation: text("confirmation", 160), sourceFlowId, ...catalogConfig };
    const integration = (await db.doc(`organizations/${organizationId}/integrations/whatsapp`).get()).data();
    if (!integration?.active || !integration.access_token) throw new HttpsError("failed-precondition", "Conecte o WhatsApp antes de criar o Flow.");
    const wabaId = String(integration.waba_id || "");
    if (!/^\d+$/.test(wabaId)) throw new HttpsError("failed-precondition", "Atualize a lista de Flows antes de criar um modelo.");
    const graphVersion = sanitizeGraphVersion(integration.graph_version);
    const auth = { Authorization: `Bearer ${integration.access_token}` };
    let flowId = "";
    try {
      const createForm = new FormData();
      createForm.append("name", config.name);
      createForm.append("categories", JSON.stringify(["APPOINTMENT_BOOKING"]));
      const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
      if (!projectId) throw new Error('Projeto Firebase não identificado.');
      createForm.append('endpoint_uri', `https://southamerica-east1-${projectId}.cloudfunctions.net/bookingFlowEndpoint`);
      let privateKey;
      try { privateKey = normalizeFlowPrivateKey(secretValue(secrets.flowPrivateKey)); }
      catch (error) { throw new HttpsError('failed-precondition', error.message); }
      const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
      const encryptionUrl = `https://graph.facebook.com/${graphVersion}/${integration.phone_number_id}/whatsapp_business_encryption`;
      const encryption = await axios.get(encryptionUrl, { headers: auth, timeout: 15000 });
      const existingPublicKey = encryption.data?.business_public_key;
      if (existingPublicKey && String(existingPublicKey).replace(/\s/g, '') !== publicKey.replace(/\s/g, '')) {
        throw new HttpsError('failed-precondition', 'Este número já possui uma chave de Flows. Configure no Automichat a mesma chave privada usada na barbearia para preservar os Flows existentes.');
      }
      if (!existingPublicKey) {
        const encryptionForm = new FormData();
        encryptionForm.append('business_public_key', publicKey);
        await axios.post(encryptionUrl, encryptionForm, { headers: auth, timeout: 15000 });
      }
      const created = await axios.post(`https://graph.facebook.com/${graphVersion}/${wabaId}/flows`, createForm, { headers: auth, timeout: 20000 });
      flowId = String(created.data?.id || "");
      if (!flowId) throw new Error("missing-flow-id");
      const flowJson = buildDynamicFlow(config);
      const assetForm = new FormData();
      assetForm.append("name", "flow.json");
      assetForm.append("asset_type", "FLOW_JSON");
      assetForm.append("file", new Blob([JSON.stringify(flowJson)], { type: "application/json" }), "flow.json");
      const uploaded = await axios.post(`https://graph.facebook.com/${graphVersion}/${flowId}/assets`, assetForm, { headers: auth, timeout: 30000 });
      const validationErrors = uploaded.data?.validation_errors || [];
      let published = false;
      if (!validationErrors.length) {
        await axios.post(`https://graph.facebook.com/${graphVersion}/${flowId}/publish`, null, { headers: auth, timeout: 20000 });
        published = true;
      }
      await db.doc(`organizations/${organizationId}/flow_configs/${flowId}`).set({ flow_id: flowId, source_flow_id: sourceFlowId || null, name: config.displayName, meta_name: config.name, status: published ? "PUBLISHED" : "DRAFT", categories: ["APPOINTMENT_BOOKING"], type: "appointment", dynamic: true, payment_schema_version: 2, builder: config, active: published, created_by: request.auth.uid, created_at: admin.firestore.FieldValue.serverTimestamp(), updated_at: admin.firestore.FieldValue.serverTimestamp() });
      return { flowId, published, validationErrors };
    } catch (error) {
      logger.warn("Falha segura ao criar Flow de agendamento", { organizationId, flowId: flowId || null, status: error.response?.status || null, metaCode: error.response?.data?.error?.code || null });
      if (error instanceof HttpsError) throw error;
      throw new HttpsError("invalid-argument", error.response?.data?.error?.error_user_msg || error.response?.data?.error?.message || "A Meta não conseguiu criar este Flow. Revise os dados e tente novamente.");
    }
  });

  const completeWhatsAppOnboarding = onCall(
    { region, secrets: [secrets.appSecret, secrets.webhookVerifyToken] },
    async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Faça login para conectar o WhatsApp.");

      const organizationId = normalizeDocumentId(request.data?.organizationId, "Empresa inválida.");
      const code = String(request.data?.code || "").trim();
      const wabaId = normalizeMetaId(request.data?.wabaId, "Conta WhatsApp inválida.", HttpsError);
      const phoneNumberId = normalizeMetaId(request.data?.phoneNumberId, "Número do WhatsApp inválido.", HttpsError);
      if (!code || code.length > 4096) throw new HttpsError("invalid-argument", "Código de autorização inválido.");

      await assertOrganizationOwner(db, request.auth.uid, organizationId, HttpsError);

      const appId = stringParam(params.appId);
      const appSecret = secretValue(secrets.appSecret);
      const graphVersion = sanitizeGraphVersion(stringParam(params.graphVersion));
      if (!appId || !appSecret) {
        throw new HttpsError("failed-precondition", "As credenciais da Meta ainda não foram configuradas no servidor.");
      }

      try {
        const tokenResponse = await axios.get(`https://graph.facebook.com/${graphVersion}/oauth/access_token`, {
          params: { client_id: appId, client_secret: appSecret, code },
          timeout: 15000,
        });
        const accessToken = String(tokenResponse.data?.access_token || "");
        if (!accessToken) throw new Error("A Meta não retornou um token de acesso.");

        const phoneResponse = await axios.get(`https://graph.facebook.com/${graphVersion}/${wabaId}/phone_numbers`, {
          params: {
            fields: "id,display_phone_number,verified_name,quality_rating",
            access_token: accessToken,
          },
          timeout: 15000,
        });
        const phone = findPhoneNumber(phoneResponse.data?.data, phoneNumberId);
        if (!phone) {
          throw new HttpsError("permission-denied", "O número escolhido não pertence à conta WhatsApp autorizada.");
        }

        await ensureAppMessagesWebhook({ organizationId, graphVersion });
        await subscribeWabaWebhook({ organizationId, wabaId, accessToken, graphVersion });

        const now = admin.firestore.FieldValue.serverTimestamp();
        const batch = db.batch();
        batch.set(db.doc(`organizations/${organizationId}/integrations/whatsapp`), {
          active: true,
          provider: "meta",
          access_token: accessToken,
          token_type: tokenResponse.data?.token_type || "bearer",
          expires_in: tokenResponse.data?.expires_in || null,
          waba_id: wabaId,
          phone_number_id: phoneNumberId,
          display_phone_number: phone.display_phone_number || null,
          verified_name: phone.verified_name || null,
          quality_rating: phone.quality_rating || null,
          graph_version: graphVersion,
          webhook_subscribed: true,
          webhook_app_id: appId,
          webhook_subscribed_at: now,
          connected_by: request.auth.uid,
          connected_at: now,
          updated_at: now,
        }, { merge: true });
        batch.set(db.doc(`organizations/${organizationId}/public_integrations/whatsapp`), {
          status: "active",
          provider: "meta",
          phone_number_id: phoneNumberId,
          display_phone_number: phone.display_phone_number || null,
          verified_name: phone.verified_name || null,
          quality_rating: phone.quality_rating || null,
          connected_at: now,
          updated_at: now,
        }, { merge: true });
        batch.set(db.doc(`meta_phone_numbers/${phoneNumberId}`), {
          organization_id: organizationId,
          waba_id: wabaId,
          active: true,
          updated_at: now,
        }, { merge: true });
        await batch.commit();

        logger.info("WhatsApp conectado ao Automichat", { organizationId, wabaId, phoneNumberId, uid: request.auth.uid });
        return {
          connected: true,
          wabaId,
          phoneNumberId,
          displayPhoneNumber: phone.display_phone_number || null,
          verifiedName: phone.verified_name || null,
        };
      } catch (error) {
        if (error instanceof HttpsError) throw error;
        logger.error("Falha ao concluir o Embedded Signup", {
          organizationId,
          status: error.response?.status || null,
          metaCode: error.response?.data?.error?.code || null,
        });
        throw new HttpsError(
          "internal",
          error.response?.data?.error?.message || "Não foi possível concluir a conexão com a Meta.",
        );
      }
    },
  );

  const sendWhatsAppMessage = onCall({ region }, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Faça login para responder a conversa.");
    const organizationId = normalizeDocumentId(request.data?.organizationId, "Empresa inválida.");
    const conversationId = normalizeDocumentId(request.data?.conversationId, "Conversa inválida.");
    const text = String(request.data?.text || "").trim();
    if (!text || text.length > 4096) throw new HttpsError("invalid-argument", "Digite uma mensagem de até 4096 caracteres.");
    await assertOrganizationMember(db, request.auth.uid, organizationId, HttpsError);

    const conversationRef = db.doc(`organizations/${organizationId}/conversations/${conversationId}`);
    const integrationRef = db.doc(`organizations/${organizationId}/integrations/whatsapp`);
    const [conversationSnapshot, integrationSnapshot] = await Promise.all([
      conversationRef.get(),
      integrationRef.get(),
    ]);
    if (!conversationSnapshot.exists) throw new HttpsError("not-found", "Conversa não encontrada.");
    const integration = integrationSnapshot.data() || {};
    const contactPhone = String(conversationSnapshot.data().contact_phone || "").replace(/\D/g, "");
    if (integration.active !== true || !integration.access_token || !integration.phone_number_id) {
      throw new HttpsError("failed-precondition", "Conecte o WhatsApp antes de enviar mensagens.");
    }
    if (!/^\d{8,20}$/.test(contactPhone)) throw new HttpsError("failed-precondition", "O contato não possui um telefone válido.");

    const graphVersion = sanitizeGraphVersion(integration.graph_version);
    let providerMessageId;
    try {
      const response = await axios.post(
        `https://graph.facebook.com/${graphVersion}/${integration.phone_number_id}/messages`,
        {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: contactPhone,
          type: "text",
          text: { preview_url: false, body: text },
        },
        {
          headers: { Authorization: `Bearer ${integration.access_token}`, "Content-Type": "application/json" },
          timeout: 15000,
        },
      );
      providerMessageId = String(response.data?.messages?.[0]?.id || "");
      if (!providerMessageId) throw new Error("A Meta não retornou o ID da mensagem.");
    } catch (error) {
      logger.error("Falha ao enviar mensagem pelo WhatsApp", {
        organizationId,
        conversationId,
        status: error.response?.status || null,
        metaCode: error.response?.data?.error?.code || null,
      });
      throw new HttpsError("failed-precondition", error.response?.data?.error?.message || "A Meta recusou o envio da mensagem.");
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    const messageId = hashId(`message:${providerMessageId}`);
    const messageRef = conversationRef.collection("messages").doc(messageId);
    const batch = db.batch();
    batch.set(messageRef, {
      provider_message_id: providerMessageId,
      direction: "outbound",
      type: "text",
      text,
      status: "sent",
      sent_at: now,
      created_by: request.auth.uid,
      created_at: now,
    });
    batch.set(conversationRef, {
      last_message: text,
      last_message_at: now,
      last_direction: "outbound",
      status: "open",
      unread_count: 0,
      assigned_to: request.auth.uid,
      updated_at: now,
    }, { merge: true });
    batch.set(db.doc(`meta_messages/${messageId}`), {
      organization_id: organizationId,
      conversation_id: conversationId,
      message_id: messageId,
      active: true,
      updated_at: now,
    }, { merge: true });
    await batch.commit();
    return { sent: true, messageId, providerMessageId };
  });

  const sendWhatsAppFlow = onCall({ region }, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Faça login para enviar o Flow.");
    const organizationId = normalizeDocumentId(request.data?.organizationId, "Empresa inválida.");
    const conversationId = normalizeDocumentId(request.data?.conversationId, "Conversa inválida.");
    const flowId = normalizeMetaId(request.data?.flowId, "Flow inválido.", HttpsError);
    await assertOrganizationMember(db, request.auth.uid, organizationId, HttpsError);
    const [conversation, integration, flowConfig, organization] = await Promise.all([
      db.doc(`organizations/${organizationId}/conversations/${conversationId}`).get(),
      db.doc(`organizations/${organizationId}/integrations/whatsapp`).get(),
      db.doc(`organizations/${organizationId}/flow_configs/${flowId}`).get(),
      db.doc(`organizations/${organizationId}`).get(),
    ]);
    if (!conversation.exists || !flowConfig.exists) throw new HttpsError("not-found", "Conversa ou configuração do Flow não encontrada.");
    const config = flowConfig.data();
    if (config.active !== true || config.status !== "PUBLISHED") throw new HttpsError("failed-precondition", "Selecione um Flow publicado e disponível para envio.");
    const integrationData = integration.data() || {};
    const phone = String(conversation.data().contact_phone || "").replace(/\D/g, "");
    if (!integrationData.active || !integrationData.access_token || !integrationData.phone_number_id || !/^\d{8,20}$/.test(phone)) throw new HttpsError("failed-precondition", "WhatsApp ou contato inválido.");
    const token = config.dynamic ? await bookingRuntime.createSession({ organizationId, conversationId, flowId, phone, customerName: conversation.data().contact_name || 'Cliente' }) : crypto.randomUUID();
    const customerName = String(conversation.data().contact_name || conversation.data().profile_name || "cliente").slice(0, 120);
    const organizationName = String(organization.data()?.nome || "estabelecimento").slice(0, 120);
    const body = String(config.message || "Preencha os dados abaixo para agendar seu atendimento.").replaceAll("{{cliente_nome}}", customerName).replaceAll("{{empresa_nome}}", organizationName).slice(0, 1024);
    const graphVersion = sanitizeGraphVersion(integrationData.graph_version);
    let providerMessageId;
    try {
      const response = await withAutomatedMessage({ db, admin, organizationId, HttpsError, reference: `flow_${token}`, send: () => axios.post(`https://graph.facebook.com/${graphVersion}/${integrationData.phone_number_id}/messages`, {
        messaging_product: "whatsapp", recipient_type: "individual", to: phone, type: "interactive",
        interactive: { type: "flow", body: { text: body }, action: { name: "flow", parameters: { flow_message_version: "3", flow_token: token, flow_id: flowId, flow_cta: String(config.cta || "Agendar agora").slice(0, 20), ...(config.dynamic ? { flow_action: 'data_exchange' } : { flow_action: "navigate", flow_action_payload: { screen: "BOOKING" } }) } } },
      }, { headers: { Authorization: `Bearer ${integrationData.access_token}`, "Content-Type": "application/json" }, timeout: 15000 }) });
      providerMessageId = String(response.data?.messages?.[0]?.id || "");
      if (!providerMessageId) throw new Error("missing-message-id");
    } catch (error) { throw new HttpsError("failed-precondition", error.response?.data?.error?.message || "A Meta recusou o envio do Flow."); }
    const now = admin.firestore.FieldValue.serverTimestamp();
    const sessionId = hashId(`flow:${token}`);
    await db.doc(`organizations/${organizationId}/flow_sessions/${sessionId}`).set({ token, conversation_id: conversationId, flow_id: flowId, phone, customer_name: customerName, organization_name: organizationName, builder: config.builder || {}, status: "sent", created_by: request.auth.uid, created_at: now, updated_at: now });
    await saveOutboundProviderMessage({ admin, db, organizationId, conversationId, providerMessageId, type: "flow", text: body, createdBy: request.auth.uid });
    return { sent: true };
  });

  const sendAppointmentReminderTask = onTaskDispatched({ region, retryConfig: { maxAttempts: 3, minBackoffSeconds: 30 }, rateLimits: { maxConcurrentDispatches: 5 } }, async (request) => {
    await deliverAppointmentReminder({ admin, db, axios, logger, HttpsError, organizationId: request.data?.organizationId, appointmentId: request.data?.appointmentId, revision: request.data?.revision, reminderKey: request.data?.reminderKey });
  });

  const closeSupportConversationTask = onTaskDispatched({ region, retryConfig: { maxAttempts: 3, minBackoffSeconds: 30 }, rateLimits: { maxConcurrentDispatches: 5 }, secrets: [secrets.systemUserAccessToken] }, async (request) => {
    await closeInactiveSupportConversation({
      admin,
      db,
      axios,
      logger,
      organizationId: request.data?.organizationId,
      conversationId: request.data?.conversationId,
      revision: request.data?.revision,
      accessToken: secretValue(secrets.systemUserAccessToken),
      graphVersion: stringParam(params.graphVersion),
    });
  });

  const updateConversationState = onCall({ region }, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Faça login para atualizar a conversa.");
    const organizationId = normalizeDocumentId(request.data?.organizationId, "Empresa inválida.");
    const conversationId = normalizeDocumentId(request.data?.conversationId, "Conversa inválida.");
    const status = String(request.data?.status || "");
    const markRead = request.data?.markRead === true;
    if (status && !["open", "waiting", "closed"].includes(status)) {
      throw new HttpsError("invalid-argument", "Status de conversa inválido.");
    }
    if (!status && !markRead) throw new HttpsError("invalid-argument", "Nenhuma alteração foi informada.");
    await assertOrganizationMember(db, request.auth.uid, organizationId, HttpsError);
    const conversationRef = db.doc(`organizations/${organizationId}/conversations/${conversationId}`);
    const snapshot = await conversationRef.get();
    if (!snapshot.exists) throw new HttpsError("not-found", "Conversa não encontrada.");
    const now = admin.firestore.FieldValue.serverTimestamp();
    const update = { updated_at: now };
    if (markRead) update.unread_count = 0;
    if (status) {
      update.status = status;
      update.assigned_to = request.auth.uid;
      update.closed_at = status === "closed" ? now : null;
      if (status === "closed") {
        update.human_support = false;
        update.automation_paused = false;
        update.support_menu_sent_at = null;
        update.support_product = null;
        update.support_session_status = "closed";
        update.support_session_revision = null;
      }
    }
    await conversationRef.set(update, { merge: true });
    return { updated: true, status: status || snapshot.data().status || "waiting" };
  });

  const clearConversation = onCall({ region }, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Faça login para limpar a conversa.");
    const organizationId = normalizeDocumentId(request.data?.organizationId, "Empresa inválida.");
    const conversationId = normalizeDocumentId(request.data?.conversationId, "Conversa inválida.");
    await assertOrganizationMember(db, request.auth.uid, organizationId, HttpsError);
    const conversationRef = db.doc(`organizations/${organizationId}/conversations/${conversationId}`);
    if (!(await conversationRef.get()).exists) throw new HttpsError("not-found", "Conversa não encontrada.");

    let deleted = 0;
    while (true) {
      const messages = await conversationRef.collection("messages").limit(400).get();
      if (messages.empty) break;
      const batch = db.batch();
      messages.docs.forEach((message) => batch.delete(message.ref));
      await batch.commit();
      deleted += messages.size;
    }
    await conversationRef.set({
      last_message: "",
      unread_count: 0,
      cleared_at: admin.firestore.FieldValue.serverTimestamp(),
      cleared_by: request.auth.uid,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return { cleared: true, deleted };
  });

  const metaWebhook = onRequest(
    { region, secrets: [secrets.appSecret, secrets.webhookVerifyToken, secrets.systemUserAccessToken, ...(payments?.oauthSecrets || [])] },
    async (req, res) => {
      if (req.method === "GET") {
        const mode = String(req.query["hub.mode"] || "");
        const token = String(req.query["hub.verify_token"] || "");
        const challenge = String(req.query["hub.challenge"] || "");
        if (mode === "subscribe" && safeEqual(token, secretValue(secrets.webhookVerifyToken))) {
          res.status(200).send(challenge);
        } else {
          res.sendStatus(403);
        }
        return;
      }

      if (req.method !== "POST") {
        res.set("Allow", "GET, POST").sendStatus(405);
        return;
      }

      if (!verifyMetaSignature(req, secretValue(secrets.appSecret))) {
        logger.warn("POST da Meta recusado por assinatura inválida", {
          hasSignature: Boolean(req.get("x-hub-signature-256")),
          contentLength: String(req.get("content-length") || ""),
        });
        res.sendStatus(401);
        return;
      }

      logger.info("POST da Meta recebido e autenticado", {
        object: String(req.body?.object || ""),
        entries: Array.isArray(req.body?.entry) ? req.body.entry.length : 0,
      });
      try {
        await processWebhookPayload({ admin, db, axios, logger, HttpsError, taskQueue, lifecycleTaskQueue, supportConversationTaskQueue, bookingRuntime, orderRuntime, supportOrganizationId: stringParam(params.supportOrganizationId), supportAccessToken: secretValue(secrets.systemUserAccessToken), demoAdminPhone: stringParam(params.demoAdminPhone), payload: req.body });
        res.sendStatus(200);
      } catch (error) {
        logger.error("Falha ao processar webhook da Meta", safeWebhookError(error));
        res.sendStatus(500);
      }
    },
  );

  return {
    bookingFlowEndpoint,
    orderFlowEndpoint,
    lookupExistingWhatsAppPhoneNumber,
    connectExistingWhatsAppPhoneNumber,
    ensureWhatsAppWebhookSubscription,
    disconnectWhatsApp,
    getWhatsAppBusinessProfile,
    saveWhatsAppBusinessProfile,
    updateWhatsAppProfilePicture,
    listWhatsAppFlows,
    saveWhatsAppFlowConfig,
    getAppointmentReminderConfig,
    saveAppointmentReminderConfig,
    createAppointmentFlow,
    completeWhatsAppOnboarding,
    sendWhatsAppMessage,
    sendWhatsAppFlow,
    sendAppointmentReminderTask,
    closeSupportConversationTask,
    updateConversationState,
    clearConversation,
    metaWebhook,
  };
}

async function fetchMetaPhoneNumber({ axios, graphVersion, accessToken, phoneNumberId }) {
  const response = await axios.get(`https://graph.facebook.com/${graphVersion}/${phoneNumberId}`, {
    params: {
      fields: "id,display_phone_number,verified_name,quality_rating",
      access_token: accessToken,
    },
    timeout: 15000,
  });
  const phone = response.data || {};
  if (String(phone.id || "") !== phoneNumberId) throw new Error("Phone Number ID divergente.");
  return phone;
}

async function fetchWabaPhoneNumber({ axios, graphVersion, accessToken, wabaId, phoneNumberId }) {
  const rows = await fetchAllMetaRows({ axios, graphVersion, accessToken, path: `${wabaId}/phone_numbers`, fields: "id,display_phone_number,verified_name,quality_rating" });
  const phone = findPhoneNumber(rows, phoneNumberId);
  if (!phone) throw new Error("O Phone Number ID não pertence à WABA informada.");
  return phone;
}

async function fetchAllMetaRows({ axios, graphVersion, accessToken, path, fields }) {
  const rows = [];
  const seen = new Set();
  let after;
  while (true) {
    const response = await axios.get(`https://graph.facebook.com/${graphVersion}/${path}`, {
      params: { fields, limit: 100, ...(after ? { after } : {}) },
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 15000,
    });
    rows.push(...(response.data?.data || []));
    if (!response.data?.paging?.next) return rows;
    const cursor = response.data?.paging?.cursors?.after;
    if (!cursor || seen.has(cursor)) throw new Error("A paginação da Meta não avançou. Tente atualizar novamente.");
    seen.add(cursor);
    after = cursor;
  }
}

async function resolveWabaIdForPhone({ axios, graphVersion, accessToken, businessId, phoneNumberId }) {
  const auth = { Authorization: `Bearer ${accessToken}` };
  const candidateIds = new Set();
  const failures = [];
  const recordFailure = (stage, error) => {
    const meta = error.response?.data?.error || {};
    failures.push(`${stage}: HTTP ${error.response?.status || "indisponível"}, código Meta ${meta.code || "não informado"}${meta.error_subcode ? `/${meta.error_subcode}` : ""}`);
  };
  // Validate access to the requested number before searching account edges.
  try {
    await fetchMetaPhoneNumber({ axios, graphVersion, accessToken, phoneNumberId });
  } catch (error) {
    recordFailure("consulta do Phone Number ID", error);
    error.discoveryMessage = `A Meta não permitiu consultar este número. ${failures.join("; ")}.`;
    throw error;
  }
  try {
    const debug = await axios.get(`https://graph.facebook.com/${graphVersion}/debug_token`, {
      params: { input_token: accessToken }, headers: auth, timeout: 15000,
    });
    const scopes = Array.isArray(debug.data?.data?.granular_scopes) ? debug.data.data.granular_scopes : [];
    scopes
      .filter((scope) => scope.scope === "whatsapp_business_management" || scope.scope === "whatsapp_business_messaging")
      .flatMap((scope) => Array.isArray(scope.target_ids) ? scope.target_ids : [])
      .map(String).filter((id) => /^\d+$/.test(id)).forEach((id) => candidateIds.add(id));
  } catch (error) {
    recordFailure("inspeção do token", error);
  }

  if (/^\d+$/.test(String(businessId || ""))) {
    for (const edge of ["owned_whatsapp_business_accounts", "client_whatsapp_business_accounts"]) {
      try {
        const accounts = await fetchAllMetaRows({ axios, graphVersion, accessToken, path: `${businessId}/${edge}`, fields: "id" });
        accounts.map((item) => String(item.id)).filter((id) => /^\d+$/.test(id)).forEach((id) => candidateIds.add(id));
      } catch (error) {
        recordFailure(edge, error);
      }
    }
  }

  for (const wabaId of candidateIds.values()) {
    try {
      const phones = await fetchAllMetaRows({ axios, graphVersion, accessToken, path: `${wabaId}/phone_numbers`, fields: "id" });
      if (phones.some((phone) => String(phone.id) === String(phoneNumberId))) return wabaId;
    } catch (error) {
      recordFailure(`números da conta ${wabaId}`, error);
    }
  }
  const error = new Error("WABA não localizada para o Phone Number ID.");
  error.discoveryMessage = `O número está acessível, mas não foi localizado nas ${candidateIds.size} contas WhatsApp candidatas do portfólio ${businessId || "não configurado"}.${failures.length ? ` Consultas recusadas: ${failures.join("; ")}.` : " A Meta retornou as listas sem esse número. Confira o portfólio e os ativos atribuídos ao usuário do sistema."}`;
  throw error;
}

function publicPhoneNumber(phone) {
  return {
    found: true,
    phoneNumberId: String(phone.id || ""),
    displayPhoneNumber: phone.display_phone_number || null,
    verifiedName: phone.verified_name || null,
    qualityRating: phone.quality_rating || null,
  };
}

async function assertOrganizationOwner(db, uid, organizationId, HttpsError) {
  const [profile, organization, member] = await Promise.all([
    db.doc(`users/${uid}`).get(),
    db.doc(`organizations/${organizationId}`).get(),
    db.doc(`organizations/${organizationId}/members/${uid}`).get(),
  ]);
  const authorized = profile.exists
    && organization.exists
    && member.exists
    && profile.data().organizacao_id === organizationId
    && organization.data().proprietario_uid === uid
    && organization.data().status !== "suspended"
    && member.data().papel === "owner"
    && member.data().status === "active";
  if (!authorized) throw new HttpsError("permission-denied", "Somente o proprietário pode conectar o WhatsApp.");
}

async function assertOrganizationMember(db, uid, organizationId, HttpsError) {
  const [profile, organization, member] = await Promise.all([
    db.doc(`users/${uid}`).get(),
    db.doc(`organizations/${organizationId}`).get(),
    db.doc(`organizations/${organizationId}/members/${uid}`).get(),
  ]);
  const authorized = profile.exists
    && organization.exists
    && member.exists
    && profile.data().organizacao_id === organizationId
    && organization.data().status !== "suspended"
    && member.data().status === "active";
  if (!authorized) throw new HttpsError("permission-denied", "Você não possui acesso a esta empresa.");
}

async function processWebhookPayload({ admin, db, axios, logger, HttpsError, taskQueue, lifecycleTaskQueue, supportConversationTaskQueue, bookingRuntime, orderRuntime, supportOrganizationId, supportAccessToken, demoAdminPhone, payload }) {
  if (payload?.object !== "whatsapp_business_account" || !Array.isArray(payload.entry)) return;
  for (const entry of payload.entry) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value || {};
      const phoneNumberId = String(value.metadata?.phone_number_id || "");
      if (!/^\d{5,30}$/.test(phoneNumberId)) continue;
      const mapping = await db.doc(`meta_phone_numbers/${phoneNumberId}`).get();
      const organizationId = resolveWebhookOrganizationId({ phoneNumberId, mapping: mapping.data(), supportOrganizationId });
      if (!organizationId) {
        logger.warn("Webhook recebido para número não associado", { phoneNumberId });
        continue;
      }
      if (phoneNumberId === AUTOMICHAT_SUPPORT_PHONE_NUMBER_ID && mapping.data()?.active !== true) {
        logger.info("Webhook interno encaminhado pela rota protegida do Automichat", { phoneNumberId, organizationId });
      }
      const contacts = new Map((Array.isArray(value.contacts) ? value.contacts : []).map((contact) => [String(contact.wa_id || ""), contact]));
      for (const message of Array.isArray(value.messages) ? value.messages : []) {
        await saveInboundMessage({ admin, db, axios, logger, HttpsError, taskQueue, lifecycleTaskQueue, supportConversationTaskQueue, bookingRuntime, orderRuntime, organizationId, phoneNumberId, supportAccessToken, demoAdminPhone, message, contact: contacts.get(String(message.from || "")) });
      }
      for (const status of Array.isArray(value.statuses) ? value.statuses : []) {
        await saveMessageStatus({ admin, db, organizationId, status });
      }
    }
  }
}

async function saveMessageStatus({ admin, db, organizationId, status }) {
  const providerMessageId = String(status?.id || "");
  const nextStatus = normalizeMessageStatus(status?.status);
  if (!providerMessageId || providerMessageId.length > 512 || !nextStatus) return;
  const messageId = hashId(`message:${providerMessageId}`);
  const mapping = await db.doc(`meta_messages/${messageId}`).get();
  if (!mapping.exists || mapping.data().active !== true || mapping.data().organization_id !== organizationId) return;
  const conversationId = normalizeDocumentId(mapping.data().conversation_id, "Mapeamento de conversa inválido.");
  const messageRef = db.doc(`organizations/${organizationId}/conversations/${conversationId}/messages/${messageId}`);
  await db.runTransaction(async (transaction) => {
    const message = await transaction.get(messageRef);
    if (!message.exists) return;
    const currentStatus = normalizeMessageStatus(message.data().status) || "pending";
    if (nextStatus !== "failed" && messageStatusRank(nextStatus) < messageStatusRank(currentStatus)) return;
    const update = {
      status: nextStatus,
      status_at: timestampFromMeta(admin, status.timestamp),
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (nextStatus === "failed") {
      const error = Array.isArray(status.errors) ? status.errors[0] : null;
      update.error_code = String(error?.code || "").slice(0, 40);
      update.error_message = String(error?.title || error?.message || "Falha no envio").slice(0, 300);
    }
    transaction.set(messageRef, update, { merge: true });
  });
}

async function saveInboundMessage({ admin, db, axios, logger, HttpsError, taskQueue, lifecycleTaskQueue, supportConversationTaskQueue, bookingRuntime, orderRuntime, organizationId, phoneNumberId, supportAccessToken, demoAdminPhone, message, contact }) {
  const phone = String(message?.from || "").replace(/\D/g, "");
  const providerMessageId = String(message?.id || "");
  if (!/^\d{8,20}$/.test(phone) || !providerMessageId || providerMessageId.length > 512) return;
  const conversationId = hashId(`contact:${phone}`);
  const messageId = hashId(`message:${providerMessageId}`);
  const sentAt = timestampFromMeta(admin, message.timestamp);
  const text = extractMessageText(message).slice(0, 4096);
  const marketingOptOut = isMarketingOptOut(text);
  const name = String(contact?.profile?.name || "").trim().slice(0, 120);
  const conversationRef = db.doc(`organizations/${organizationId}/conversations/${conversationId}`);
  const messageRef = conversationRef.collection("messages").doc(messageId);
  const customerRef = db.doc(`organizations/${organizationId}/customers/${hashId(`customer:${phone}`)}`);
  const conversationData = {
    contact_phone: phone,
    last_message: text || `[${String(message.type || "mensagem").slice(0, 40)}]`,
    last_message_at: sentAt,
    status: "waiting",
    unread_count: admin.firestore.FieldValue.increment(1),
    last_inbound_provider_message_id: providerMessageId,
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (name) {
    conversationData.contact_name = name;
    conversationData.profile_name = name;
  }
  const shouldAutomate = await db.runTransaction(async (transaction) => {
    const [existingMessage, existingCustomer] = await Promise.all([
      transaction.get(messageRef),
      transaction.get(customerRef),
    ]);
    if (existingMessage.exists) return existingMessage.data().automation_status !== 'completed';
    transaction.set(conversationRef, conversationData, { merge: true });
    const customer = existingCustomer.data() || {};
    transaction.set(customerRef, {
      phone,
      phone_key: phone,
      source: customer.source || "whatsapp",
      status: customer.status || "active",
      tags: Array.isArray(customer.tags) ? customer.tags : [],
      notes: String(customer.notes || ""),
      email: String(customer.email || ""),
      conversation_id: conversationId,
      last_contact_at: sentAt,
      last_activity_at: sentAt,
      marketing_consent: marketingOptOut ? false : customer.marketing_consent === true,
      marketing_consent_at: marketingOptOut ? null : customer.marketing_consent_at || null,
      marketing_consent_source: marketingOptOut ? "customer_request" : customer.marketing_consent_source || "",
      ...(marketingOptOut ? { marketing_opted_out_at: sentAt } : {}),
      archived: customer.archived === true,
      created_at: customer.created_at || admin.firestore.FieldValue.serverTimestamp(),
      created_by: customer.created_by || "whatsapp",
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
      updated_by: "whatsapp",
      ...((!customer.name || customer.source === "whatsapp") && name ? {
        name,
        name_key: name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR"),
      } : {}),
      ...(!customer.name && !name ? { name: "Cliente do WhatsApp", name_key: "cliente do whatsapp" } : {}),
    }, { merge: true });
    transaction.set(messageRef, {
      provider_message_id: providerMessageId,
      direction: "inbound",
      type: String(message.type || "unknown").slice(0, 40),
      text,
      status: "received",
      sent_at: sentAt,
      received_at: admin.firestore.FieldValue.serverTimestamp(),
    });
    return !marketingOptOut;
  });
  if (phoneNumberId === AUTOMICHAT_SUPPORT_PHONE_NUMBER_ID) {
    const conversation = (await conversationRef.get()).data() || {};
    const demoRoute = supportDemoRoute({ phone, authorizedPhone: demoAdminPhone, conversation, messageText: text });
    if (demoRoute === 'enter') {
      await conversationRef.set({
        support_demo_mode: 'appointments',
        support_demo_started_at: admin.firestore.FieldValue.serverTimestamp(),
        support_product: null,
        support_session_status: 'closed',
        support_session_revision: null,
        human_support: false,
        automation_paused: false,
        status: 'open',
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    } else if (demoRoute === 'exit') {
      await conversationRef.set({
        support_demo_mode: null,
        support_demo_ended_at: admin.firestore.FieldValue.serverTimestamp(),
        booking_confirmation_expires_at: null,
        human_support: false,
        automation_paused: false,
        support_product: null,
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      await messageRef.set({ routing: { segment_id: 'automichat-support', family: 'support', enabled_modules: [] } }, { merge: true });
      const selectorMessage = { type: 'text', text: { body: 'menu' } };
      const supportHandled = shouldAutomate && await handleAutomichatSupport({ admin, db, axios, logger, HttpsError, supportConversationTaskQueue, organizationId, conversationId, conversationRef, phone, providerMessageId, supportAccessToken, message: selectorMessage, contactName: name });
      if (shouldAutomate) await messageRef.set({ automation_status: 'completed', automation_route: supportHandled ? 'automichat_support' : 'human_support' }, { merge: true });
      return;
    } else if (demoRoute !== 'appointments') {
      await messageRef.set({ routing: { segment_id: 'automichat-support', family: 'support', enabled_modules: [] } }, { merge: true });
      const supportHandled = shouldAutomate && await handleAutomichatSupport({ admin, db, axios, logger, HttpsError, supportConversationTaskQueue, organizationId, conversationId, conversationRef, phone, providerMessageId, supportAccessToken, message, contactName: name });
      if (shouldAutomate) await messageRef.set({ automation_status: 'completed', automation_route: supportHandled ? 'automichat_support' : 'human_support' }, { merge: true });
      return;
    }
  }
  const flowResponse = parseFlowResponse(message);
  const segment = await getOrganizationSegment(db, organizationId);
  const enabledModules = new Set(segment.modules);
  await messageRef.set({ routing: { segment_id: segment.id, family: segment.family, enabled_modules: segment.modules } }, { merge: true });
  if (flowResponse && enabledModules.has('appointments')) await saveFlowAppointment({ admin, db, taskQueue, organizationId, conversationId, phone, customerName: name, response: flowResponse });
  if (message?.type === "order" && enabledModules.has('orders')) {
    const cart = await saveFoodOrder({ admin, db, organizationId, conversationId, phone, customerName: name, providerMessageId, order: message.order });
    if (cart?.rejected) await sendCartReceipt({ admin, db, axios, logger, HttpsError, organizationId, conversationId, phone, orderId: cart.orderId, text: cart.reply, created: false });
    if (cart?.created && orderRuntime) {
      try {
        await orderRuntime.sendForOrder({ organizationId, orderId: cart.orderId, conversationId, phone, customerName: name });
      } catch (error) {
        const errorMessage = String(error.response?.data?.error?.message || error.publicMessage || error.message || "Falha desconhecida").slice(0, 300);
        logger.error("Falha ao abrir o Flow do pedido", {organizationId, orderId: cart.orderId, status: error.response?.status || null, code: error.response?.data?.error?.code || error.code || null, error: errorMessage});
        await db.doc(`organizations/${organizationId}/orders/${cart.orderId}`).set({message_statuses: {checkout_invite: {status: "failed", error: errorMessage, updated_at: admin.firestore.Timestamp.now()}}, updated_at: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
        await sendCartReceipt({ admin, db, axios, logger, HttpsError, organizationId, conversationId, phone, orderId: cart.orderId, text: cart.reply, created: true });
      }
    }
  }
  const orderHandled = shouldAutomate && enabledModules.has('orders') && orderRuntime ? await orderRuntime.automate({ organizationId, message, contact }) : false;
  if (shouldAutomate && enabledModules.has('appointments') && bookingRuntime && !orderHandled) await bookingRuntime.automate({ organizationId, message, contact });
  const mayOfferSegmentMenu = shouldAutomate && !orderHandled && !enabledModules.has('appointments') && shouldOfferSegmentMenu(message);
  const segmentMenuAllowed = mayOfferSegmentMenu
    ? await canOfferSegmentMenu({ conversationRef, segment, message })
    : false;
  const nicheMenuSent = segmentMenuAllowed
    ? await sendSegmentMenu({ admin, db, axios, logger, HttpsError, lifecycleTaskQueue, organizationId, conversationId, phone, providerMessageId, segment, message })
    : false;
  if (shouldAutomate) await messageRef.set({ automation_status: 'completed', automation_route: orderHandled ? 'orders' : enabledModules.has('appointments') ? 'appointments' : nicheMenuSent ? `${segment.family}_menu` : segment.family }, { merge: true });
}

function isMarketingOptOut(value) {
  const normalized = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase("pt-BR")
    .replace(/[.!?]+$/g, "")
    .trim();
  return ["sair", "parar", "cancelar mensagens", "nao quero receber"].includes(normalized);
}

function extractMessageText(message) {
  if (message?.type === "text") return String(message.text?.body || "");
  if (message?.type === "button") return String(message.button?.text || "");
  if (message?.type === "interactive") {
    return String(message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || (message.interactive?.nfm_reply ? "Agendamento preenchido" : ""));
  }
  if (message?.type === "order") {
    const count = Array.isArray(message.order?.product_items) ? message.order.product_items.reduce((total, item) => total + Math.max(0, Number(item.quantity) || 0), 0) : 0;
    return `Pedido enviado com ${count} item${count === 1 ? "" : "s"}`;
  }
  if (message?.image?.caption) return String(message.image.caption);
  if (message?.video?.caption) return String(message.video.caption);
  if (message?.document?.caption || message?.document?.filename) return String(message.document.caption || message.document.filename);
  return "";
}

async function saveFoodOrder({ admin, db, organizationId, conversationId, phone, customerName, providerMessageId, order }) {
  const sourceItems = Array.isArray(order?.product_items) ? order.product_items.slice(0, 100) : [];
  if (!sourceItems.length) return;
  const retailerIds = [...new Set(sourceItems.map((item) => String(item.product_retailer_id || "").slice(0, 80)).filter(Boolean))];
  const products = new Map();
  for (let index = 0; index < retailerIds.length; index += 10) {
    const snapshot = await db.collection(`organizations/${organizationId}/menu_items`).where("retailer_id", "in", retailerIds.slice(index, index + 10)).get();
    snapshot.docs.forEach((document) => products.set(String(document.data().retailer_id || ""), {id: document.id, ...document.data()}));
  }
  const validation = validateCartItems(sourceItems, products);
  const orderId = hashId(`order:${providerMessageId}`);
  if (!validation.valid) return {orderId, rejected: true, reply: "Não conseguimos validar todos os itens do seu carrinho. Confira se os produtos continuam disponíveis e envie o carrinho novamente."};
  const items = validation.items;
  const totalCents = items.reduce((total, item) => total + item.total_cents, 0);
  const now = admin.firestore.FieldValue.serverTimestamp();
  const eventTime = admin.firestore.Timestamp.now();
  const ref = db.doc(`organizations/${organizationId}/orders/${orderId}`);
  const created = await db.runTransaction(async transaction => {
    const existing = await transaction.get(ref);
    if (existing.exists) return false;
    transaction.create(ref, {
      number: orderId.slice(-6).toUpperCase(), provider_message_id: providerMessageId, catalog_id: String(order?.catalog_id || "").slice(0, 40),
      conversation_id: conversationId, customer_name: customerName || "Cliente do WhatsApp", customer_phone: phone,
      customer: {name: customerName || "Cliente do WhatsApp", phone},
      items, currency: "BRL", subtotal_cents: totalCents, delivery_fee_cents: 0, discount_cents: 0, total_cents: totalCents,
      fulfillment_type: "pending", address: {street: "", number: "", complement: "", district: "", city: "", state: "", postal_code: "", reference: ""},
      payment: {method: "pending", change_for_cents: 0, status: "pending"}, observations: "",
      delivery: {eta_minutes: 0, courier_id: "", courier_name: "", dispatched_at: null, delivered_at: null},
      status: "awaiting_data", status_history: [{status: "awaiting_data", source: "whatsapp_cart", at: eventTime}],
      message_statuses: {cart_received: {status: "pending", provider_message_id: "", updated_at: eventTime}},
      source: "whatsapp_cart", requires_checkout: true, prices_validated: true, prices_validated_at: now,
      created_at: now, updated_at: now,
    });
    return true;
  });
  const productSummary = items.map((item) => `${item.quantity}x ${item.name}`).join(", ");
  return {orderId, created, reply: `Recebemos seu carrinho: ${productSummary}. Total de ${formatBRL(totalCents)}. Para continuar, clique em FINALIZAR e complete os dados do pedido.`};
}

function validateCartItems(sourceItems, products) {
  const items = [];
  for (const source of sourceItems) {
    const retailerId = String(source?.product_retailer_id || "").slice(0, 80);
    const product = products.get(retailerId);
    const quantity = Math.max(1, Math.min(99, Math.trunc(Number(source?.quantity) || 1)));
    if (!retailerId || !product || product.active === false || product.availability !== "in stock") return {valid: false, items: []};
    const unitPriceCents = Math.round(Number(product.price_cents || 0));
    if (!Number.isInteger(unitPriceCents) || unitPriceCents < 1 || unitPriceCents > 10_000_000) return {valid: false, items: []};
    items.push({product_id: String(product.id || ""), retailer_id: retailerId, name: String(product.name || "Produto").slice(0, 100), quantity, unit_price_cents: unitPriceCents, total_cents: unitPriceCents * quantity});
  }
  return {valid: items.length > 0, items};
}

async function sendCartReceipt({admin, db, axios, logger, HttpsError, organizationId, conversationId, phone, orderId, text, created}) {
  const integration = (await db.doc(`organizations/${organizationId}/integrations/whatsapp`).get()).data() || {};
  if (!integration.active || !integration.access_token || !integration.phone_number_id) return;
  let providerMessageId = "";
  try {
    const response = await withAutomatedMessage({ db, admin, organizationId, HttpsError, reference: `cart_${orderId}_${created ? "accepted" : "rejected"}`, send: () => axios.post(`https://graph.facebook.com/${sanitizeGraphVersion(integration.graph_version)}/${integration.phone_number_id}/messages`, {
      messaging_product: "whatsapp", recipient_type: "individual", to: phone, type: "text", text: {preview_url: false, body: text},
    }, {headers: {Authorization: `Bearer ${integration.access_token}`, "Content-Type": "application/json"}, timeout: 15000}) });
    providerMessageId = String(response.data?.messages?.[0]?.id || "");
    if (!providerMessageId) throw new Error("A Meta não retornou o ID da mensagem.");
    await saveOutboundProviderMessage({admin, db, organizationId, conversationId, providerMessageId, type: "text", text, createdBy: "cart_automation"});
    if (created) await db.doc(`organizations/${organizationId}/orders/${orderId}`).set({message_statuses: {cart_received: {status: "sent", provider_message_id: providerMessageId, updated_at: admin.firestore.Timestamp.now()}}, updated_at: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
  } catch (error) {
    logger.error("Falha ao confirmar carrinho pelo WhatsApp", {organizationId, orderId, status: error.response?.status || null});
    if (created) await db.doc(`organizations/${organizationId}/orders/${orderId}`).set({message_statuses: {cart_received: {status: "failed", provider_message_id: providerMessageId, error: String(error.response?.data?.error?.message || error.message).slice(0, 300), updated_at: admin.firestore.Timestamp.now()}}, updated_at: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
  }
}

const AUTOMICHAT_SUPPORT_PHONE_NUMBER_ID = '1124719307396782';
const SUPPORT_MENU_REOPEN_INTENTS = new Set(['menu', 'ajuda', 'inicio', 'iniciar', 'voltar', 'comecar']);
const SUPPORT_END_INTENTS = new Set(['encerrar', 'finalizar', 'finalizar atendimento', 'encerrar atendimento']);
const SUPPORT_SESSION_SECONDS = 30 * 60;
const SUPPORT_FOOTER = '↩️ Digite *menu* para ver as opções ou *encerrar* para finalizar.';

function supportDemoRoute({ phone, authorizedPhone, conversation = {}, messageText = '' }) {
  const sender = String(phone || '').replace(/\D/g, '');
  const allowed = String(authorizedPhone || '').replace(/\D/g, '');
  if (!allowed || sender !== allowed) return 'support';
  const intent = normalizedIntent(messageText);
  const active = conversation.support_demo_mode === 'appointments';
  if (active && SUPPORT_END_INTENTS.has(intent)) return 'exit';
  if (active) return 'appointments';
  return intent === 'agendar' ? 'enter' : 'support';
}

function resolveWebhookOrganizationId({ phoneNumberId, mapping, supportOrganizationId }) {
  if (mapping?.active === true) return normalizeDocumentId(mapping.organization_id, 'Mapeamento de empresa inválido.');
  if (String(phoneNumberId) === AUTOMICHAT_SUPPORT_PHONE_NUMBER_ID && /^[A-Za-z0-9_-]{1,128}$/.test(String(supportOrganizationId || ''))) return String(supportOrganizationId);
  return '';
}

function automichatSupportMenu(identified) {
  if (identified) return {
    body: 'Olá! Sou o assistente do Automichat. Encontrei sua conta. Como posso ajudar?',
    rows: [
      ['support_account', 'Minha conta', 'Plano e conexão do WhatsApp'],
      ['support_connect', 'Conectar WhatsApp', 'Passo a passo da conexão'],
      ['support_dashboard', 'Usar o painel', 'Conheça as principais áreas'],
      ['support_automations', 'Automações', 'Lembretes e mensagens'],
      ['support_plans', 'Planos e cobrança', 'Valores, limites e Meta'],
      ['support_problem', 'Resolver problema', 'Verificações rápidas'],
      ['support_human', 'Falar com atendente', 'Pausar o robô e pedir ajuda'],
    ],
  };
  return {
    body: 'Olá! Este é o atendimento do Automichat. Como posso ajudar?',
    rows: [
      ['support_about', 'Conhecer Automichat', 'Veja como o sistema funciona'],
      ['support_plans', 'Ver planos', 'Preços e o que está incluso'],
      ['support_signup', 'Criar minha conta', 'Comece seu cadastro'],
      ['support_customer', 'Já sou cliente', 'Localizar sua conta'],
      ['support_human', 'Falar com atendente', 'Atendimento personalizado'],
    ],
  };
}

function supportProductSelector(contactName = '') {
  return {
    body: `Olá${contactName ? `, ${contactName}` : ''}! Sobre qual solução gostaria de falar?\n\n*Automichat* — automação de atendimento pelo WhatsApp.\n*Smilecut* — sistema de gestão para barbearias.`,
    buttons: [
      ['product_automichat', 'Automichat'],
      ['product_smilecut', 'Smilecut'],
    ],
  };
}

function smilecutSupportMenu() {
  return {
    body: 'Como podemos ajudar com o Smilecut?',
    rows: [
      ['smile_about', 'Conhecer o Smilecut', 'Veja como o sistema funciona'],
      ['smile_client', 'Sou cliente', 'Agendamentos, pagamentos e app'],
      ['smile_owner', 'Tenho uma barbearia', 'Gestão, agenda e equipe'],
      ['smile_plans', 'Planos e cadastro', 'Comece a usar o Smilecut'],
      ['support_human', 'Falar com atendente', 'Atendimento personalizado'],
    ],
  };
}

function smilecutClientMenu() {
  return {
    body: 'O que você precisa fazer como cliente?',
    rows: [
      ['smile_book', 'Agendar horário', 'Escolha serviço, barbeiro e data'],
      ['smile_manage_booking', 'Meus agendamentos', 'Consulte, remarque ou cancele'],
      ['smile_payments', 'Pagamentos', 'Pix, cartão e situação do pagamento'],
      ['smile_benefits', 'Assinaturas e cupons', 'Benefícios, pacotes e descontos'],
      ['smile_app_account', 'Aplicativo e conta', 'Login, notificações e perfil'],
    ],
  };
}

function smilecutOwnerMenu() {
  return {
    body: 'O que deseja conhecer para sua barbearia?',
    rows: [
      ['smile_create_shop', 'Criar barbearia', 'Cadastre e publique sua página'],
      ['smile_schedule', 'Agenda e fila', 'Horários e atendimento imediato'],
      ['smile_team_services', 'Equipe e serviços', 'Barbeiros, preços e adicionais'],
      ['smile_customers_sales', 'Clientes e vendas', 'Produtos, fidelidade e cupons'],
      ['smile_finance', 'Financeiro', 'Pagamentos e acompanhamento'],
    ],
  };
}

function supportActionId(message) {
  const interactive = String(message?.interactive?.list_reply?.id || message?.interactive?.button_reply?.id || '');
  if (/^(support|product|smile)_/.test(interactive)) return interactive;
  const intent = normalizedIntent(extractMessageText(message));
  const aliases = {
    '1': 'support_about', '2': 'support_plans', '3': 'support_signup', '4': 'support_customer', '5': 'support_human',
    conta: 'support_account', conectar: 'support_connect', conexao: 'support_connect', painel: 'support_dashboard',
    automacoes: 'support_automations', lembretes: 'support_automations', planos: 'support_plans', cobranca: 'support_plans',
    problema: 'support_problem', erro: 'support_problem', atendente: 'support_human', humano: 'support_human',
    automichat: 'product_automichat', smilecut: 'product_smilecut',
  };
  return aliases[intent] || '';
}

function isAutomichatWebsiteLead(value) {
  const intent = normalizedIntent(value).replace(/[!?,.;:]+/g, '').replace(/\s+/g, ' ');
  return intent === 'ola vim pelo site e gostaria de saber mais sobre o automichat';
}

function isSmilecutWebsiteLead(value) {
  const intent = normalizedIntent(value).replace(/[!?,.;:]+/g, '').replace(/\s+/g, ' ');
  return intent === 'ola vim pelo site e gostaria de saber mais sobre o smilecut';
}

async function findAutomichatCustomer(db, phone) {
  const normalized = String(phone || '').replace(/\D/g, '');
  if (!normalized) return null;
  const candidates = [`+${normalized}`, normalized];
  for (const value of candidates) {
    const snapshot = await db.collection('organizations').where('whatsapp', '==', value).limit(1).get();
    if (!snapshot.empty) {
      const document = snapshot.docs[0];
      const data = document.data() || {};
      if (data.status !== 'suspended') return { id: document.id, ...data };
    }
  }
  return null;
}

async function supportReply({ db, organization }) {
  const [planSnapshot, customerIntegration] = await Promise.all([
    db.collection('plans').get(),
    organization ? db.doc(`organizations/${organization.id}/integrations/whatsapp`).get() : Promise.resolve(null),
  ]);
  const plans = planSnapshot.docs.map(document => ({ id: document.id, ...document.data() }))
    .filter(plan => plan.active !== false)
    .sort((a, b) => Number(a.price || 0) - Number(b.price || 0));
  const planLines = plans.slice(0, 5).map(plan => `• ${plan.name || plan.id}: ${formatBRL(Math.round(Number(plan.price || 0) * 100))}/mês`).join('\n');
  return {
    support_about: 'O Automichat reúne atendimento pelo WhatsApp, conversas, clientes, agendamentos ou pedidos e automações em um único painel. Os recursos exibidos se adaptam ao segmento da empresa.',
    support_connect: 'Para conectar seu WhatsApp:\n\n1. No painel, toque em *Conectar WhatsApp*.\n2. Entre no Facebook que administra a empresa.\n3. Selecione o portfólio e a conta comercial corretos.\n4. Use o número do *WhatsApp Business da sua própria empresa* ou cadastre um número comercial novo.\n5. Confirme o código recebido e conclua a configuração.\n6. Na etapa de pagamento da Meta, escolha *Pular e concluir a configuração*: seu plano Automichat já cuida das mensagens operacionais incluídas.\n\nNunca envie senha, código de SMS, token ou dados completos do cartão por aqui.',
    support_dashboard: 'No painel você acompanha a visão geral, responde conversas, organiza contatos e usa os módulos do seu segmento, como agendamentos, serviços, pedidos ou entregas. Em *Automações*, você acompanha as jornadas e lembretes disponíveis.',
    support_automations: 'As automações enviam confirmações, lembretes e acompanhamentos conforme o fluxo ativo do seu segmento. Elas respeitam o limite mensal do plano e param quando a conversa é encaminhada a um atendente humano. Mensagens aleatórias do cliente não devem disparar o mesmo lembrete repetidamente.',
    support_plans: `${planLines || 'Consulte os planos atualizados em https://automichat.com/'}\n\nA mensalidade inclui os limites informados no plano. Se você adicionar uma forma de pagamento diretamente na Meta, a Meta poderá cobrar o consumo separadamente; por isso, recomendamos pular essa etapa durante a conexão.`,
    support_signup: 'Crie sua conta em https://automichat.com/ e siga o cadastro da empresa. Depois de escolher o plano, o painel mostrará o passo a passo para conectar seu WhatsApp Business.',
    support_customer: 'Para localizar automaticamente sua empresa, fale conosco pelo mesmo número informado no cadastro. Se este já for o número cadastrado e a conta não apareceu, escolha *Falar com atendente* no menu.',
    support_problem: 'Vamos verificar o básico:\n\n• Confirme se aparece “WhatsApp conectado” no painel.\n• Atualize a página e tente novamente.\n• Confira se entrou no Facebook que administra a empresa.\n• Não compartilhe senha, código de SMS ou token.\n\nSe o problema continuar, digite *atendente* e descreva o que aconteceu. Se puder, envie uma captura sem dados sensíveis.',
    support_account: organization
      ? `Empresa: *${String(organization.nome || 'Sua empresa').slice(0, 80)}*\nPlano: *${String(organization.plano_nome || 'não identificado').slice(0, 60)}*\nSituação: *${String(organization.status || 'ativa').slice(0, 40)}*\nWhatsApp: *${customerIntegration?.data()?.active === true ? 'conectado' : 'desconectado'}*`
      : 'Não consegui localizar uma empresa vinculada a este telefone. Digite *menu* e escolha “Já sou cliente” ou “Falar com atendente”.',
  };
}

function smilecutReplies() {
  return {
    smile_about: 'O *Smilecut* conecta clientes e barbearias. O cliente encontra a barbearia, consulta serviços, escolhe barbeiro e horário, agenda e acompanha pagamentos. A barbearia controla agenda, fila, equipe, serviços, produtos, clientes, cupons, fidelidade e financeiro em um único sistema.',
    smile_plans: 'Para começar, a barbearia cria a conta, escolhe um plano, informa seus dados e configura equipe, serviços, horários e formas de pagamento. Depois, recebe uma página própria para divulgar e também pode ser encontrada no aplicativo Smilecut. Acesse: https://www.smilecut.com.br/',
    smile_book: 'No aplicativo ou na página da barbearia, escolha o serviço, os adicionais, o barbeiro, a data e um horário disponível. Revise os dados e conclua o agendamento. A disponibilidade é validada novamente antes da confirmação.',
    smile_manage_booking: 'Abra *Agendamentos* para consultar seus horários. Quando a barbearia permitir, você poderá remarcar ou cancelar por essa tela. Limites, sinal e condições de devolução são mostrados antes da confirmação.',
    smile_payments: 'A barbearia pode oferecer Pix, cartão ou pagamento no local. Se um pagamento continuar pendente após ser concluído no banco, aguarde alguns minutos e depois fale com o suporte levando o comprovante e o nome da barbearia.',
    smile_benefits: 'Assinaturas liberam serviços e benefícios conforme o pacote contratado. Cupons podem ter validade, valor mínimo, serviços permitidos e limite de uso. O desconto e o total aparecem no checkout antes da confirmação.',
    smile_app_account: 'O aplicativo permite gerenciar perfil, endereços, notificações, favoritos, cartões com dados protegidos, cupons e agendamentos. O acesso pode ser feito pelos provedores habilitados, e a conta pode ser excluída nas configurações.',
    smile_create_shop: 'Cadastre a barbearia, escolha o plano e informe nome, endereço, WhatsApp e horários. Depois configure serviços e equipe. O Smilecut gera uma página própria para seus clientes consultarem e agendarem.',
    smile_schedule: 'A agenda considera duração do serviço, pausas, horários ocupados e disponibilidade do barbeiro. Também é possível controlar fila e atendimento imediato. Estados como disponível, pausa, atendendo e indisponível evitam novos encaixes incorretos.',
    smile_team_services: 'Cadastre barbeiros, serviços, preços, duração, opções extras e disponibilidade. Cada profissional pode ter sua rotina organizada, enquanto a barbearia acompanha os atendimentos pelo painel.',
    smile_customers_sales: 'O painel organiza clientes, histórico, produtos, cupons e fidelidade. A barbearia pode vender produtos, criar descontos e acompanhar benefícios sem perder o vínculo com os agendamentos.',
    smile_finance: 'O Smilecut reúne pagamentos e informações financeiras dos atendimentos. A disponibilidade de Pix, cartão, assinatura e outras opções depende da configuração e do plano da barbearia.',
  };
}

function appendSupportFooter(text) {
  return `${String(text || '').trim()}\n\n${SUPPORT_FOOTER}`.slice(0, 4096);
}

function supportListOutbound(menu, sectionTitle) {
  return {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: menu.body },
      footer: { text: 'Digite menu para opções ou encerrar para finalizar.' },
      action: { button: 'Ver opções', sections: [{ title: sectionTitle, rows: menu.rows.map(([id, title, description]) => ({ id, title, description })) }] },
    },
  };
}

function supportProductOutbound(contactName) {
  const selector = supportProductSelector(contactName);
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: selector.body },
      footer: { text: 'Escolha uma opção para continuar.' },
      action: { buttons: selector.buttons.map(([id, title]) => ({ type: 'reply', reply: { id, title } })) },
    },
  };
}

async function handleAutomichatSupport({ admin, db, axios, logger, HttpsError, supportConversationTaskQueue, organizationId, conversationId, conversationRef, phone, providerMessageId, supportAccessToken, message, contactName }) {
  const conversation = (await conversationRef.get()).data() || {};
  const messageText = extractMessageText(message);
  const intent = normalizedIntent(messageText);
  if (conversation.human_support === true && !SUPPORT_END_INTENTS.has(intent)) return false;
  const actionId = supportActionId(message);
  const cameFromWebsite = isAutomichatWebsiteLead(messageText);
  const cameFromSmilecutWebsite = isSmilecutWebsiteLead(messageText);
  const currentProduct = ['automichat', 'smilecut'].includes(conversation.support_product) ? conversation.support_product : '';
  const integration = (await db.doc(`organizations/${organizationId}/integrations/whatsapp`).get()).data() || {};
  const storedOwnerNumber = String(integration.phone_number_id || '') === AUTOMICHAT_SUPPORT_PHONE_NUMBER_ID;
  const accessToken = integration.active === true && storedOwnerNumber && integration.access_token ? integration.access_token : String(supportAccessToken || '');
  if (!accessToken) {
    logger.error('Número interno do suporte está sem uma integração válida', { organizationId });
    return false;
  }

  let product = cameFromWebsite ? 'automichat' : cameFromSmilecutWebsite ? 'smilecut' : currentProduct;
  let outbound;
  let text = '';
  let humanSupport = false;
  let ended = false;
  let customerOrganization = null;

  if (SUPPORT_END_INTENTS.has(intent)) {
    text = `Conversa encerrada${contactName ? `, ${contactName}` : ''}. Quando precisar, envie uma nova mensagem para começar novamente. 👋`;
    outbound = { type: 'text', text: { preview_url: false, body: text } };
    ended = true;
    product = '';
  } else if (!product) {
    if (actionId === 'product_automichat') product = 'automichat';
    if (actionId === 'product_smilecut') product = 'smilecut';
    if (!product) {
      outbound = supportProductOutbound(contactName);
      text = supportProductSelector(contactName).body;
    }
  }

  if (!outbound && product === 'automichat') {
    customerOrganization = await findAutomichatCustomer(db, phone);
    if (actionId === 'support_human') {
      text = `Certo${contactName ? `, ${contactName}` : ''}. Encaminhei sua conversa para o atendimento humano. O assistente ficará pausado para não interromper.\n\nPor segurança, não envie senha, código de SMS, token ou dados completos do cartão.`;
      outbound = { type: 'text', text: { preview_url: false, body: appendSupportFooter(text) } };
      humanSupport = true;
    } else if (actionId && actionId.startsWith('support_') && actionId !== 'support_human') {
      const replies = await supportReply({ db, organization: customerOrganization });
      text = replies[actionId] || 'Não encontrei essa opção.';
      outbound = { type: 'text', text: { preview_url: false, body: appendSupportFooter(text) } };
    } else if (cameFromWebsite || SUPPORT_MENU_REOPEN_INTENTS.has(intent) || actionId === 'product_automichat') {
      const menu = automichatSupportMenu(Boolean(customerOrganization));
      text = menu.body;
      outbound = supportListOutbound(menu, 'Suporte Automichat');
    } else {
      text = 'Não consegui identificar sua dúvida. Escolha uma opção do menu para continuar.';
      outbound = { type: 'text', text: { preview_url: false, body: appendSupportFooter(text) } };
    }
  }

  if (!outbound && product === 'smilecut') {
    if (actionId === 'support_human') {
      text = `Certo${contactName ? `, ${contactName}` : ''}. Encaminhei sua conversa sobre o Smilecut para o atendimento humano. O assistente ficará pausado para não interromper.`;
      outbound = { type: 'text', text: { preview_url: false, body: appendSupportFooter(text) } };
      humanSupport = true;
    } else if (actionId === 'smile_client') {
      const menu = smilecutClientMenu();
      text = menu.body;
      outbound = supportListOutbound(menu, 'Para clientes');
    } else if (actionId === 'smile_owner') {
      const menu = smilecutOwnerMenu();
      text = menu.body;
      outbound = supportListOutbound(menu, 'Para barbearias');
    } else if (actionId && actionId.startsWith('smile_') && !['smile_client', 'smile_owner'].includes(actionId)) {
      text = smilecutReplies()[actionId] || 'Não encontrei essa opção.';
      outbound = { type: 'text', text: { preview_url: false, body: appendSupportFooter(text) } };
    } else if (cameFromSmilecutWebsite || SUPPORT_MENU_REOPEN_INTENTS.has(intent) || actionId === 'product_smilecut') {
      const menu = smilecutSupportMenu();
      text = menu.body;
      outbound = supportListOutbound(menu, 'Suporte Smilecut');
    } else {
      text = 'Não consegui identificar sua dúvida sobre o Smilecut. Escolha uma opção do menu para continuar.';
      outbound = { type: 'text', text: { preview_url: false, body: appendSupportFooter(text) } };
    }
  }

  try {
    const response = await axios.post(`https://graph.facebook.com/${sanitizeGraphVersion(integration.graph_version)}/${AUTOMICHAT_SUPPORT_PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, ...outbound,
    }, { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, timeout: 15000 });
    const outboundId = String(response.data?.messages?.[0]?.id || '');
    if (!outboundId) return false;
    await saveOutboundProviderMessage({ admin, db, organizationId, conversationId, providerMessageId: outboundId, type: outbound.type, text, createdBy: 'automichat_support' });
    const revision = hashId(`support-session:${providerMessageId}`);
    const update = {
      support_segment: true,
      support_product: product || null,
      support_session_status: ended ? 'closed' : humanSupport ? 'human' : 'active',
      support_session_revision: ended || humanSupport ? null : revision,
      support_last_activity_at: admin.firestore.FieldValue.serverTimestamp(),
      support_customer_organization_id: customerOrganization?.id || conversation.support_customer_organization_id || null,
      support_intent: actionId || (ended ? 'ended' : 'message'),
      ...(cameFromWebsite ? { lead_source: 'website', lead_source_at: admin.firestore.FieldValue.serverTimestamp() } : {}),
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (ended) Object.assign(update, { human_support: false, automation_paused: false, status: 'closed', closed_at: admin.firestore.FieldValue.serverTimestamp() });
    if (humanSupport) Object.assign(update, { human_support: true, automation_paused: true, status: 'waiting' });
    await conversationRef.set(update, { merge: true });
    if (!ended && !humanSupport) await scheduleSupportConversationClosure({ supportConversationTaskQueue, logger, organizationId, conversationId, revision });
    return true;
  } catch (error) {
    logger.error('Falha ao enviar atendimento interno', { organizationId, product: product || 'selector', status: error.response?.status || null });
    return false;
  }
}

async function scheduleSupportConversationClosure({ supportConversationTaskQueue, logger, organizationId, conversationId, revision }) {
  if (!supportConversationTaskQueue) return;
  try {
    const taskId = crypto.createHash('sha256').update(`${organizationId}:${conversationId}:${revision}`).digest('hex').slice(0, 48);
    await supportConversationTaskQueue.enqueue({ organizationId, conversationId, revision }, { id: `support-close-${taskId}`, scheduleDelaySeconds: SUPPORT_SESSION_SECONDS });
  } catch (error) {
    logger.warn('Não foi possível programar o encerramento do suporte', { organizationId, conversationId, code: error.code || null });
  }
}

async function closeInactiveSupportConversation({ admin, db, axios, logger, organizationId, conversationId, revision, accessToken, graphVersion }) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(organizationId || '')) || !/^[A-Za-z0-9_-]{1,128}$/.test(String(conversationId || '')) || !revision || !accessToken) return false;
  const conversationRef = db.doc(`organizations/${organizationId}/conversations/${conversationId}`);
  let conversation;
  const reserved = await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(conversationRef);
    conversation = snapshot.data() || {};
    if (!snapshot.exists || conversation.support_session_status !== 'active' || conversation.support_session_revision !== revision || conversation.human_support === true) return false;
    if (conversation.support_closing_revision === revision) return false;
    transaction.set(conversationRef, { support_closing_revision: revision, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return true;
  });
  if (!reserved) return false;
  const phone = String(conversation.contact_phone || '').replace(/\D/g, '');
  if (!/^\d{8,20}$/.test(phone)) {
    await conversationRef.set({ support_closing_revision: null, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return false;
  }
  const text = 'Esta conversa está sendo encerrada por tempo de inatividade. Quando precisar, envie uma nova mensagem. 👋';
  try {
    const response = await axios.post(`https://graph.facebook.com/${sanitizeGraphVersion(graphVersion)}/${AUTOMICHAT_SUPPORT_PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, type: 'text', text: { preview_url: false, body: text },
    }, { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, timeout: 15000 });
    const outboundId = String(response.data?.messages?.[0]?.id || '');
    if (!outboundId) throw new Error('A Meta não retornou o ID da mensagem.');
    await saveOutboundProviderMessage({ admin, db, organizationId, conversationId, providerMessageId: outboundId, type: 'text', text, createdBy: 'support_inactivity' });
    await conversationRef.set({
      support_product: null,
      support_session_status: 'closed',
      support_session_revision: null,
      support_closing_revision: null,
      support_closed_reason: 'inactivity',
      human_support: false,
      automation_paused: false,
      status: 'closed',
      closed_at: admin.firestore.FieldValue.serverTimestamp(),
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return true;
  } catch (error) {
    await conversationRef.set({ support_closing_revision: null, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    logger.error('Falha ao encerrar suporte por inatividade', { organizationId, conversationId, status: error.response?.status || null });
    throw error;
  }
}

function normalizedIntent(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').trim().replace(/[.!?,;:]+$/g, '').trim();
}

function shouldOfferSegmentMenu(message) {
  return ['text', 'interactive'].includes(message?.type);
}

async function canOfferSegmentMenu({ conversationRef, segment, message, now = Date.now() }) {
  if (message?.type === 'interactive') return true;
  const conversation = (await conversationRef.get()).data() || {};
  if (conversation.segment_menu_id !== segment.id) return true;
  const sentAt = conversation.segment_menu_sent_at?.toMillis?.() || 0;
  return !sentAt || now - sentAt >= 6 * 60 * 60 * 1000;
}

function segmentMenu(segment) {
  if (segment.modules.includes('visits')) return { body: 'Como podemos ajudar com seu imóvel?', rows: [['segment_properties', 'Ver imóveis', 'Opções disponíveis'], ['segment_visit', 'Agendar visita', 'Escolha o melhor atendimento'], ['segment_support', 'Falar com corretor', 'Atendimento personalizado']] };
  if (segment.modules.includes('enrollment')) return { body: 'Como podemos ajudar com seus estudos?', rows: [['segment_courses', 'Cursos e turmas', 'Veja as opções disponíveis'], ['segment_enrollment', 'Matrícula', 'Receba orientação para começar'], ['segment_support', 'Falar com a equipe', 'Tire suas dúvidas']] };
  if (segment.family === 'sales') return { body: 'Olá! O que você procura?', rows: [['segment_products', 'Produtos e serviços', 'Conheça as opções'], ['segment_quote', 'Pedir orçamento', 'Conte o que você precisa'], ['segment_support', 'Falar com consultor', 'Atendimento personalizado']] };
  if (segment.family === 'food') return { mode: 'text', body: 'Olá! Gostaria de fazer um pedido?\n\nAbra o cardápio desta conversa, escolha seus itens e envie o carrinho para continuar.', rows: [] };
  return { body: 'Olá! Como podemos ajudar?', rows: [['segment_services', 'Conhecer serviços', 'Veja as opções disponíveis'], ['segment_quote', 'Solicitar orçamento', 'Conte o que você precisa'], ['segment_support', 'Falar com a equipe', 'Atendimento personalizado']] };
}

async function sendSegmentMenu({ admin, db, axios, logger, HttpsError, lifecycleTaskQueue, organizationId, conversationId, phone, providerMessageId, segment, message }) {
  const integration = (await db.doc(`organizations/${organizationId}/integrations/whatsapp`).get()).data() || {};
  if (!integration.active || !integration.access_token || !integration.phone_number_id) return false;
  const menu = segmentMenu(segment);
  const actionId = String(message?.interactive?.list_reply?.id || message?.interactive?.button_reply?.id || '');
  const actionReplies = {
    segment_menu: 'Abra o cardápio desta conversa para escolher seus itens. Quando terminar, envie o carrinho para finalizar o pedido.',
    segment_order: 'Envie o número do pedido ou fale com a equipe para consultar o andamento.',
    segment_products: 'Conte qual produto ou serviço procura para prepararmos o atendimento.',
    segment_quote: 'Conte o que você precisa e, se possível, informe quantidade, prazo e detalhes importantes.',
    segment_properties: 'Conte se deseja comprar ou alugar, a cidade ou bairro e a faixa de valor.',
    segment_visit: 'Informe o imóvel de interesse e os melhores dias ou horários para a visita.',
    segment_courses: 'Conte qual curso, turma ou assunto você procura.',
    segment_enrollment: 'Informe o curso de interesse para a equipe orientar sua matrícula.',
    segment_services: 'Conte qual serviço você procura para indicarmos a opção adequada.',
    segment_support: 'Certo. Sua mensagem foi encaminhada para a equipe do estabelecimento.',
  };
  const actionReply = actionReplies[actionId];
  if (actionReply) await db.doc(`organizations/${organizationId}/conversations/${conversationId}`).set({ human_support: actionId === 'segment_support', segment_intent: actionId.replace('segment_', ''), status: 'waiting', updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  const outbound = actionReply
    ? { type: 'text', text: { preview_url: false, body: actionReply } }
    : menu.mode === 'text'
    ? { type: 'text', text: { preview_url: false, body: menu.body } }
    : { type: 'interactive', interactive: { type: 'list', body: { text: menu.body }, action: { button: 'Ver opções', sections: [{ title: 'Atendimento', rows: menu.rows.map(([id, title, description]) => ({ id, title, description })) }] } } };
  try {
    const response = await withAutomatedMessage({ db, admin, organizationId, HttpsError, reference: `segment_menu_${providerMessageId}`, send: () => axios.post(`https://graph.facebook.com/${sanitizeGraphVersion(integration.graph_version)}/${integration.phone_number_id}/messages`, {
      messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, ...outbound,
    }, { headers: { Authorization: `Bearer ${integration.access_token}`, 'Content-Type': 'application/json' }, timeout: 15000 }) });
    const outboundId = String(response.data?.messages?.[0]?.id || '');
    if (!outboundId) return false;
    await saveOutboundProviderMessage({ admin, db, organizationId, conversationId, providerMessageId: outboundId, type: outbound.type, text: actionReply || menu.body, createdBy: 'segment_automation' });
    if (!actionReply) await db.doc(`organizations/${organizationId}/conversations/${conversationId}`).set({ segment_menu_id: segment.id, segment_menu_sent_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    const followupId = { segment_quote: 'quote_followup', segment_enrollment: 'enrollment_followup', segment_visit: 'visit_followup' }[actionId];
    if (followupId && lifecycleTaskQueue) {
      try {
        const lifecycle = (await db.doc(`organizations/${organizationId}/automation_configs/lifecycle_reminders`).get()).data()?.automations?.[followupId] || {};
        if (lifecycle.active === true) {
          await db.doc(`organizations/${organizationId}/conversations/${conversationId}`).set({ [`lifecycle_${followupId}_trigger`]: providerMessageId, [`lifecycle_${followupId}_queued_at`]: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
          const taskId = crypto.createHash('sha256').update(`${organizationId}:${followupId}:${providerMessageId}`).digest('hex').slice(0, 48);
          await lifecycleTaskQueue.enqueue({ organizationId, automationId: followupId, entityId: conversationId, triggerMessageId: providerMessageId }, { id: `followup-${taskId}`, scheduleDelaySeconds: Math.max(60, Math.min(30 * 86400, Number(lifecycle.delay_minutes || 1440) * 60)) });
        }
      } catch (error) { logger.warn('Não foi possível programar o follow-up do segmento', { organizationId, followupId, code: error.code || null }); }
    }
    return true;
  } catch (error) {
    logger.error('Falha ao enviar menu do segmento', { organizationId, segment: segment.id, status: error.response?.status || null });
    return false;
  }
}

function formatBRL(cents) { return `R$ ${(Number(cents || 0) / 100).toFixed(2).replace(".", ",")}`; }

function parseFlowResponse(message) {
  const raw = message?.interactive?.nfm_reply?.response_json;
  if (!raw) return null;
  try { const value = typeof raw === "string" ? JSON.parse(raw) : raw; return value && typeof value === "object" ? value : null; }
  catch { return null; }
}

async function saveFlowAppointment({ admin, db, taskQueue, organizationId, conversationId, phone, customerName, response }) {
  const token = String(response.flow_token || "");
  if (!token) return;
  const sessionId = hashId(`flow:${token}`);
  const sessionRef = db.doc(`organizations/${organizationId}/flow_sessions/${sessionId}`);
  const session = await sessionRef.get();
  if (!session.exists || session.data().status === "completed") return;
  const builder = session.data().builder || {};
  const resolve = (value, prefix, options) => {
    const match = new RegExp(`^${prefix}_(\\d+)$`).exec(String(value || ""));
    const index = match ? Number(match[1]) - 1 : -1;
    return index >= 0 && Array.isArray(options) ? String(options[index] || "") : String(value || "");
  };
  const service = resolve(response.service, "service", builder.services);
  const optional = resolve(response.optional, "optional", builder.optionals);
  const professional = resolve(response.professional, "professional", builder.professionals);
  const date = resolve(response.date, "date", builder.dates);
  const time = resolve(response.time, "time", builder.times);
  if (!service || !professional || !date || !time) return;
  const scheduledFor = brazilianAppointmentTimestamp(admin, date, time);
  if (!scheduledFor) return;
  const appointmentRef = db.collection(`organizations/${organizationId}/appointments`).doc();
  const access = await entitlements(db, organizationId);
  if (access.organization.status === "suspended") return;
  const usageRef = db.doc(`organizations/${organizationId}/usage/${monthKey()}`);
  const creditsRef = db.doc(`organizations/${organizationId}/capacity/credits`);
  const now = admin.firestore.FieldValue.serverTimestamp();
  let appointmentCreated = false;
  await db.runTransaction(async (transaction) => {
    const [fresh, usage, credits] = await Promise.all([transaction.get(sessionRef), transaction.get(usageRef), transaction.get(creditsRef)]);
    if (!fresh.exists || fresh.data().status === "completed") return;
    const consumption = evaluateMonthlyConsumption({ usageData: usage.data(), creditsData: credits.data(), metric: "appointments", limit: access.limits.appointmentsPerMonth, reference: appointmentRef.id });
    if (!consumption.allowed) return;
    transaction.set(appointmentRef, { conversation_id: conversationId, customer_phone: phone, customer_name: customerName || session.data().customer_name || "Cliente", service, optional, professional, appointment_date: date, appointment_time: time, scheduled_for: scheduledFor, status: "confirmed", reminder_status: "scheduled", source: "whatsapp_flow", flow_id: session.data().flow_id, created_at: now, updated_at: now });
    if (!consumption.duplicate) {
      transaction.set(usageRef, { month: monthKey(), appointments: consumption.current + 1, appointments_references: { ...consumption.references, [appointmentRef.id]: true }, ...(consumption.usesCredit ? { appointments_credits_used: admin.firestore.FieldValue.increment(1) } : {}), updated_at: now }, { merge: true });
      if (consumption.usesCredit) transaction.set(creditsRef, { appointments: consumption.creditBalance - 1, updated_at: now }, { merge: true });
    }
    transaction.set(sessionRef, { status: "completed", appointment_id: appointmentRef.id, response, completed_at: now, updated_at: now }, { merge: true });
    appointmentCreated = true;
  });
  if (!appointmentCreated) return;
  const config = (await db.doc(`organizations/${organizationId}/automation_configs/appointment_reminder`).get()).data() || {};
  if (config.active !== true || !taskQueue) return;
  const schedules = config.trigger === "before_appointment" ? (Array.isArray(config.schedules) && config.schedules.length ? config.schedules : [Number(config.lead_time_minutes) || 1440]) : [0];
  for (const lead of schedules) {
    const reminderKey = lead ? `before_${lead}` : "after_confirmation";
    const delaySeconds = lead ? Math.max(0, Math.floor((scheduledFor.toMillis() - Date.now()) / 1000) - Number(lead) * 60) : Number(config.delay_seconds) || 30;
    await taskQueue.enqueue({ organizationId, appointmentId: appointmentRef.id, reminderKey }, { id: `legacy-${appointmentRef.id}-${reminderKey}`, scheduleDelaySeconds: delaySeconds });
  }
}

function brazilianAppointmentTimestamp(admin, date, time) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(date || ""));
  if (!match || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time || ""))) return null;
  const parsed = new Date(`${match[3]}-${match[2]}-${match[1]}T${time}:00-03:00`);
  return Number.isNaN(parsed.getTime()) ? null : admin.firestore.Timestamp.fromDate(parsed);
}

async function deliverAppointmentReminder({ admin, db, axios, logger, HttpsError, organizationId, appointmentId, revision, reminderKey = "default" }) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(String(organizationId || "")) || !/^[a-zA-Z0-9_-]{1,128}$/.test(String(appointmentId || ""))) return;
  const appointmentRef = db.doc(`organizations/${organizationId}/appointments/${appointmentId}`);
  const [appointment, config, integration, organization] = await Promise.all([appointmentRef.get(), db.doc(`organizations/${organizationId}/automation_configs/appointment_reminder`).get(), db.doc(`organizations/${organizationId}/integrations/whatsapp`).get(), db.doc(`organizations/${organizationId}`).get()]);
  if (!appointment.exists || !config.exists || !integration.exists || !organization.exists) return;
  const data = appointment.data(); const reminder = config.data(); const meta = integration.data();
  if (data.reminder_revision && data.reminder_revision !== revision) return;
  if (data.reminder_deliveries?.[reminderKey]?.status === "sent" || reminder.active !== true || data.status !== "confirmed") return;
    const reminderDate = /^\d{4}-\d{2}-\d{2}$/.test(data.appointment_date || '') ? data.appointment_date.split('-').reverse().join('/') : data.appointment_date;
    const parameters = [data.customer_name || "Cliente", organization.data().nome || "Estabelecimento", reminderDate, data.appointment_time].map((text) => ({ type: "text", text: String(text).slice(0, 1024) }));
  let usageReserved = false;
  try {
    const usageReference = `${appointmentId}_${reminderKey}`;
    await consumeMonthly(db, admin, organizationId, "reminders", "remindersPerMonth", HttpsError, usageReference);
    usageReserved = true;
    // O cliente pode cancelar ou remarcar enquanto a tarefa carrega a configuração.
    // Releia o documento no último instante possível para não enviar uma confirmação obsoleta.
    const latest = (await appointmentRef.get()).data();
    const staleRevision = latest?.reminder_revision && latest.reminder_revision !== revision;
    if (!latest || latest.status !== "confirmed" || staleRevision) {
      await releaseMonthly(db, admin, organizationId, "reminders", usageReference);
      usageReserved = false;
      await appointmentRef.set({ reminder_deliveries: { [reminderKey]: { status: "skipped", reason: latest?.status !== "confirmed" ? "appointment_not_confirmed" : "appointment_changed", skipped_at: admin.firestore.Timestamp.now() } }, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return;
    }
    const response = await axios.post(`https://graph.facebook.com/${sanitizeGraphVersion(meta.graph_version)}/${meta.phone_number_id}/messages`, { messaging_product: "whatsapp", recipient_type: "individual", to: data.customer_phone, type: "template", template: { name: reminder.template_name, language: { code: reminder.language }, components: [{ type: "body", parameters }] } }, { headers: { Authorization: `Bearer ${meta.access_token}`, "Content-Type": "application/json" }, timeout: 15000 });
    const providerMessageId = String(response.data?.messages?.[0]?.id || "");
    if (!providerMessageId) throw new Error("missing-message-id");
    usageReserved = false;
    await appointmentRef.set({ reminder_status: "sent", reminder_deliveries: { [reminderKey]: { status: "sent", sent_at: admin.firestore.Timestamp.now(), provider_message_id: providerMessageId } }, reminder_sent_at: admin.firestore.FieldValue.serverTimestamp(), reminder_provider_message_id: providerMessageId, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await saveOutboundProviderMessage({ admin, db, organizationId, conversationId: data.conversation_id, providerMessageId, type: "template", text: `Lembrete enviado: ${data.appointment_date} às ${data.appointment_time}`, createdBy: "automation" });
  } catch (error) {
    if (usageReserved) await releaseMonthly(db, admin, organizationId, "reminders", `${appointmentId}_${reminderKey}`);
    logger.error("Falha ao enviar lembrete", { organizationId, appointmentId, status: error.response?.status || null });
    await appointmentRef.set({ reminder_status: "failed", reminder_deliveries: { [reminderKey]: { status: "failed", error: String(error.response?.data?.error?.message || error.message).slice(0, 300), failed_at: admin.firestore.Timestamp.now() } }, reminder_error: String(error.response?.data?.error?.message || error.message).slice(0, 300), updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    throw error;
  }
}

async function saveOutboundProviderMessage({ admin, db, organizationId, conversationId, providerMessageId, type, text, createdBy }) {
  const now = admin.firestore.FieldValue.serverTimestamp(); const messageId = hashId(`message:${providerMessageId}`); const conversationRef = db.doc(`organizations/${organizationId}/conversations/${conversationId}`); const batch = db.batch();
  batch.set(conversationRef.collection("messages").doc(messageId), { provider_message_id: providerMessageId, direction: "outbound", type, text, status: "sent", sent_at: now, created_by: createdBy, created_at: now });
  batch.set(conversationRef, { last_message: text, last_message_at: now, last_direction: "outbound", status: "open", unread_count: 0, updated_at: now }, { merge: true });
  batch.set(db.doc(`meta_messages/${messageId}`), { organization_id: organizationId, conversation_id: conversationId, message_id: messageId, active: true, updated_at: now }, { merge: true });
  await batch.commit();
}

function normalizeMessageStatus(value) {
  const status = String(value || "").toLowerCase();
  return ["pending", "sent", "delivered", "read", "failed"].includes(status) ? status : "";
}

function messageStatusRank(status) {
  return { pending: 0, sent: 1, delivered: 2, read: 3, failed: 4 }[status] ?? -1;
}

function timestampFromMeta(admin, value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0
    ? admin.firestore.Timestamp.fromMillis(seconds * 1000)
    : admin.firestore.Timestamp.now();
}

function verifyMetaSignature(req, appSecret) {
  const signature = String(req.get("x-hub-signature-256") || "");
  if (!appSecret || !signature.startsWith("sha256=") || !req.rawBody) return false;
  const expected = `sha256=${crypto.createHmac("sha256", appSecret).update(req.rawBody).digest("hex")}`;
  return safeEqual(signature, expected);
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeDocumentId(value, message) {
  const id = String(value || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error(message);
  return id;
}

function normalizeMetaId(value, message, HttpsError) {
  const id = String(value || "").trim();
  if (!/^\d{5,30}$/.test(id)) throw new HttpsError("invalid-argument", message);
  return id;
}

function findPhoneNumber(rows, phoneNumberId) {
  return Array.isArray(rows) ? rows.find((phone) => String(phone?.id || "") === phoneNumberId) || null : null;
}

function hashId(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function templateParameterCount(text) {
  const indexes = [...String(text || "").matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]));
  return indexes.length ? Math.max(...indexes) : 0;
}

async function buildAppointmentCatalog(db, organizationId, HttpsError) {
  const [servicesSnapshot, optionsSnapshot, professionalsSnapshot] = await Promise.all([
    db.collection(`organizations/${organizationId}/services`).where("active", "==", true).get(),
    db.collection(`organizations/${organizationId}/service_options`).where("active", "==", true).get(),
    db.collection(`organizations/${organizationId}/professionals`).where("active", "==", true).get(),
  ]);
  const services = servicesSnapshot.docs.map((item) => item.data()).sort(byName);
  const optionals = optionsSnapshot.docs.map((item) => item.data()).sort(byName);
  const professionals = professionalsSnapshot.docs.map((item) => item.data()).filter((item) => item.allow_online_booking !== false && item.schedule_active !== false).sort(byName);
  if (!services.length) throw new HttpsError("failed-precondition", "Cadastre pelo menos um serviço ativo antes de criar o Flow.");
  if (!professionals.length) throw new HttpsError("failed-precondition", "Cadastre pelo menos um funcionário ativo com agendamento online.");
  const dates = availableDates(professionals, 14);
  const times = [...new Set(professionals.flatMap(professionalTimes))].sort();
  if (!dates.length || !times.length) throw new HttpsError("failed-precondition", "A equipe não possui datas e horários disponíveis para gerar o Flow.");
  const labels = (items) => items.slice(0, 30).map((item) => String(item.name || "").trim()).filter(Boolean).map((name) => name.slice(0, 80));
  return { services: labels(services), optionals: labels(optionals), professionals: labels(professionals), dates, times: times.slice(0, 30) };
}

function byName(left, right) { return String(left.name || "").localeCompare(String(right.name || ""), "pt-BR"); }

function availableDates(professionals, quantity) {
  const result = [];
  const cursor = new Date();
  cursor.setUTCHours(12, 0, 0, 0);
  for (let offset = 0; offset < 60 && result.length < quantity; offset += 1) {
    const candidate = new Date(cursor.getTime() + offset * 86400000);
    const iso = candidate.toISOString().slice(0, 10);
    const weekday = candidate.getUTCDay();
    const available = professionals.some((person) => {
      const days = Array.isArray(person.work_days) ? person.work_days.map(Number) : [];
      const vacation = person.vacation || {};
      const away = vacation.active === true && vacation.start && vacation.end && iso >= vacation.start && iso <= vacation.end;
      return days.includes(weekday) && !away;
    });
    if (available) result.push(new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" }).format(candidate));
  }
  return result;
}

function professionalTimes(person) {
  const custom = Array.isArray(person.available_times) ? person.available_times.filter((value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value)) : [];
  if (custom.length) return custom;
  const start = minutes(person.work_start);
  const end = minutes(person.work_end);
  const interval = Number(person.interval_minutes) || 30;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start >= end || interval < 5) return [];
  const blocked = [person.lunch, person.additional_break].filter((range) => range?.active === true).map((range) => [minutes(range.start), minutes(range.end)]);
  const result = [];
  for (let value = start; value + interval <= end && result.length < 96; value += interval) {
    if (blocked.some(([from, to]) => Number.isInteger(from) && Number.isInteger(to) && value >= from && value < to)) continue;
    result.push(`${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`);
  }
  return result;
}

function minutes(value) { const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || "")); return match ? Number(match[1]) * 60 + Number(match[2]) : NaN; }
function compactTimestamp() { return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12); }

function buildAppointmentFlowJson(config) {
  const source = (values, prefix) => values.map((title, index) => ({ id: `${prefix}_${index + 1}`, title }));
  return {
    version: "7.3",
    screens: [{
      id: "BOOKING",
      title: config.title,
      terminal: true,
      success: true,
      data: {},
      layout: {
        type: "SingleColumnLayout",
        children: [{
          type: "Form",
          name: "booking_form",
          children: [
            { type: "TextHeading", text: config.title },
            { type: "TextBody", text: config.description },
            { type: "Dropdown", name: "service", label: "Serviço", required: true, "data-source": source(config.services, "service") },
            ...(config.optionals.length ? [{ type: "Dropdown", name: "optional", label: "Adicional (opcional)", required: false, "data-source": source(config.optionals, "optional") }] : []),
            { type: "Dropdown", name: "professional", label: "Profissional", required: true, "data-source": source(config.professionals, "professional") },
            { type: "Dropdown", name: "date", label: "Data disponível", required: true, "data-source": source(config.dates, "date") },
            { type: "Dropdown", name: "time", label: "Horário disponível", required: true, "data-source": source(config.times, "time") },
            { type: "TextBody", text: config.confirmation },
            { type: "Footer", label: config.submitLabel, "on-click-action": { name: "complete", payload: { service: "${form.service}", ...(config.optionals.length ? { optional: "${form.optional}" } : {}), professional: "${form.professional}", date: "${form.date}", time: "${form.time}" } } },
          ],
        }],
      },
    }],
  };
}

function sanitizeGraphVersion(value) {
  const version = String(value || "v24.0").trim();
  return /^v\d+\.\d+$/.test(version) ? version : "v24.0";
}

function safeWebhookError(error) {
  const sanitize = value => String(value || "")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [credencial protegida]")
    .replace(/EA[A-Za-z0-9_-]{20,}/g, "[credencial protegida]")
    .replace(/[A-Za-z0-9_-]{80,}/g, "[valor protegido]")
    .slice(0, 600);
  return {
    message: sanitize(error?.publicMessage || error?.message || "Falha desconhecida"),
    code: sanitize(error?.code),
    status: Number(error?.response?.status) || null,
    metaCode: sanitize(error?.response?.data?.error?.code),
    metaType: sanitize(error?.response?.data?.error?.type),
    stack: sanitize(error?.stack),
  };
}

function stringParam(param) {
  try { return String(param?.value?.() || "").trim(); } catch { return ""; }
}

function secretValue(secret) {
  try { return String(secret?.value?.() || "").trim(); } catch { return ""; }
}

module.exports = {
  saveOutboundProviderMessage,
  createMetaWhatsAppFunctions,
  extractMessageText,
  isMarketingOptOut,
  fetchMetaPhoneNumber,
  fetchWabaPhoneNumber,
  fetchAllMetaRows,
  resolveWabaIdForPhone,
  findPhoneNumber,
  hashId,
  normalizeDocumentId,
  normalizeMessageStatus,
  sanitizeGraphVersion,
  safeEqual,
  validateCartItems,
  buildOwnerFlowCatalog,
  normalizeBusinessProfileInput,
  normalizedIntent,
  shouldOfferSegmentMenu,
  segmentMenu,
  automichatSupportMenu,
  supportProductSelector,
  smilecutSupportMenu,
  smilecutClientMenu,
  smilecutOwnerMenu,
  supportActionId,
  isAutomichatWebsiteLead,
  isSmilecutWebsiteLead,
  resolveWebhookOrganizationId,
  AUTOMICHAT_SUPPORT_PHONE_NUMBER_ID,
  supportDemoRoute,
  safeWebhookError,
};
