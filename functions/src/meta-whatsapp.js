const crypto = require("node:crypto");
const { createBookingRuntime, createFlowEndpoint, buildDynamicFlow, DEFAULT_BOOKING_KEYWORDS, validateBookingKeywords } = require('./booking-flow');
const { normalizeFlowPrivateKey } = require('./flow-crypto');

function createMetaWhatsAppFunctions({
  admin,
  db,
  axios,
  logger,
  onCall,
  onRequest,
  onTaskDispatched,
  taskQueue,
  HttpsError,
  secrets,
  params,
  payments,
}) {
  const region = "southamerica-east1";
  const bookingRuntime = createBookingRuntime({ admin, db, axios, logger, taskQueue, payments, saveOutbound: saveOutboundProviderMessage });
  payments?.setOnPaid(bookingRuntime.finishConfirmed);
  const bookingFlowEndpoint = createFlowEndpoint({ onRequest, privateKey: secrets.flowPrivateKey, appSecret: secrets.appSecret, runtime: bookingRuntime, logger, paymentSecrets: payments?.oauthSecrets || [] });

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
        logger.warn("Phone Number ID não encontrado no ambiente Meta do clickchat", {
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
    { region, secrets: [secrets.systemUserAccessToken] },
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
          throw new HttpsError("already-exists", "Este Phone Number ID já está vinculado a outra empresa no clickchat.");
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

      logger.info("WhatsApp conectado ao clickchat por Phone Number ID existente", {
        organizationId,
        wabaId,
        phoneNumberId,
        uid: request.auth.uid,
      });
      return { connected: true, wabaId, ...publicPhoneNumber(phone) };
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

      logger.info("WhatsApp desconectado do clickchat", { organizationId, phoneNumberId, uid: request.auth.uid });
      return { disconnected: true };
    },
  );

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
        throw new HttpsError("failed-precondition", `O token pertence ao App ID ${tokenAppId || "desconhecido"}, mas o clickchat usa o App ID ${expectedAppId}. Gere o token selecionando o aplicativo GRSYSTEM correto.`);
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
    const configs = await db.collection(`organizations/${organizationId}/flow_configs`).get();
    const saved = new Map(configs.docs.map((item) => [item.id, item.data()]));
    return { flows: (response.data?.data || []).map((flow) => ({ id: String(flow.id), name: flow.name || "", status: flow.status || "", categories: flow.categories || [], validationErrors: flow.validation_errors || [], config: saved.get(String(flow.id)) || null })) };
  });

  const saveWhatsAppFlowConfig = onCall({ region }, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Faça login para configurar o Flow.");
    const organizationId = normalizeDocumentId(request.data?.organizationId, "Empresa inválida.");
    const flowId = normalizeMetaId(request.data?.flowId, "Flow inválido.", HttpsError);
    const message = String(request.data?.message || "").trim();
    const cta = String(request.data?.cta || "").trim();
    const active = request.data?.active === true;
    let keywords;
    if (request.data?.keywords !== undefined) {
      try { keywords = validateBookingKeywords(request.data.keywords); }
      catch (error) { throw new HttpsError('invalid-argument', error.message); }
    }
    if (!message || message.length > 1024) throw new HttpsError("invalid-argument", "A mensagem deve ter entre 1 e 1024 caracteres.");
    if (!cta || cta.length > 20) throw new HttpsError("invalid-argument", "O texto do botão deve ter entre 1 e 20 caracteres.");
    await assertOrganizationOwner(db, request.auth.uid, organizationId, HttpsError);
    const integration = (await db.doc(`organizations/${organizationId}/integrations/whatsapp`).get()).data();
    if (!integration?.active || !integration.access_token) throw new HttpsError("failed-precondition", "Conecte o WhatsApp antes de configurar o Flow.");
    const graphVersion = sanitizeGraphVersion(integration.graph_version);
    let flow;
    try {
      flow = await axios.get(`https://graph.facebook.com/${graphVersion}/${flowId}`, { params: { fields: "id,name,status,categories" }, headers: { Authorization: `Bearer ${integration.access_token}` }, timeout: 15000 });
    } catch (error) {
      logger.warn("Falha segura ao validar WhatsApp Flow", { organizationId, flowId, status: error.response?.status || null, metaCode: error.response?.data?.error?.code || null });
      throw new HttpsError("permission-denied", "Este Flow não foi encontrado ou não pertence à conta Meta conectada.");
    }
    if (active && flow.data?.status !== 'PUBLISHED') throw new HttpsError('failed-precondition', 'Publique o Flow na Meta antes de disponibilizá-lo para envio.');
    const [existingConfig, paymentSetting] = await Promise.all([db.doc(`organizations/${organizationId}/flow_configs/${flowId}`).get(), db.doc(`organizations/${organizationId}/payment_settings/booking`).get()]);
    if (active && paymentSetting.data()?.mode === 'deposit' && existingConfig.data()?.payment_schema_version !== 2) throw new HttpsError('failed-precondition', 'Crie uma nova versão do Flow pelo painel para usar a etapa de pagamento.');
    await db.doc(`organizations/${organizationId}/flow_configs/${flowId}`).set({ flow_id: flowId, name: flow.data?.name || "", status: flow.data?.status || "", categories: flow.data?.categories || [], message, cta, active, ...(keywords !== undefined ? { keywords } : {}), updated_by: request.auth.uid, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    const savedConfig = (await db.doc(`organizations/${organizationId}/flow_configs/${flowId}`).get()).data();
    if (savedConfig.dynamic) {
      const menuRef = db.doc(`organizations/${organizationId}/automation_configs/booking_menu`);
      await db.runTransaction(async transaction => {
        const current = await transaction.get(menuRef);
        if (active || current.data()?.flow_id === flowId) transaction.set(menuRef, { active, flow_id: flowId, keywords: keywords ?? savedConfig.keywords ?? DEFAULT_BOOKING_KEYWORDS, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      });
    }
    return { saved: true, dynamic: savedConfig.dynamic === true };
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
      active: data.active === true,
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
    const active = request.data?.active === true;
    if (!/^[a-z0-9_]{1,512}$/.test(templateName)) throw new HttpsError("invalid-argument", "Nome do modelo inválido.");
    if (!/^[a-z]{2}_[A-Z]{2}$/.test(language)) throw new HttpsError("invalid-argument", "Idioma do modelo inválido.");
    if (!["after_confirmation", "before_appointment"].includes(trigger)) throw new HttpsError("invalid-argument", "Momento do envio inválido.");
    if (![10, 30, 60, 300].includes(delaySeconds)) throw new HttpsError("invalid-argument", "Atraso após confirmação inválido.");
    if (![5, 60, 120, 1440].includes(leadTimeMinutes)) throw new HttpsError("invalid-argument", "Antecedência inválida.");
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
      template_id: String(template.id || ""),
      template_name: templateName,
      template_status: template.status,
      category: template.category || "UTILITY",
      language,
      trigger,
      delay_seconds: delaySeconds,
      lead_time_minutes: leadTimeMinutes,
      variable_map: { "1": "customer_name", "2": "organization_name", "3": "appointment_date", "4": "appointment_time" },
      updated_by: request.auth.uid,
      updated_at: now,
    }, { merge: true });
    return { templateName, language, trigger, delaySeconds, leadTimeMinutes, active, templateStatus: template.status };
  });

  const createAppointmentFlow = onCall({ region, secrets: [secrets.flowPrivateKey] }, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Faça login para criar o Flow.");
    const organizationId = normalizeDocumentId(request.data?.organizationId, "Empresa inválida.");
    await assertOrganizationOwner(db, request.auth.uid, organizationId, HttpsError);
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
        throw new HttpsError('failed-precondition', 'Este número já possui uma chave de Flows. Configure no clickchat a mesma chave privada usada na barbearia para preservar os Flows existentes.');
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
    { region, secrets: [secrets.appSecret] },
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

        await axios.post(
          `https://graph.facebook.com/${graphVersion}/${wabaId}/subscribed_apps`,
          null,
          { params: { access_token: accessToken }, timeout: 15000 },
        );

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

        logger.info("WhatsApp conectado ao clickchat", { organizationId, wabaId, phoneNumberId, uid: request.auth.uid });
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
      const response = await axios.post(`https://graph.facebook.com/${graphVersion}/${integrationData.phone_number_id}/messages`, {
        messaging_product: "whatsapp", recipient_type: "individual", to: phone, type: "interactive",
        interactive: { type: "flow", body: { text: body }, action: { name: "flow", parameters: { flow_message_version: "3", flow_token: token, flow_id: flowId, flow_cta: String(config.cta || "Agendar agora").slice(0, 20), ...(config.dynamic ? { flow_action: 'data_exchange' } : { flow_action: "navigate", flow_action_payload: { screen: "BOOKING" } }) } } },
      }, { headers: { Authorization: `Bearer ${integrationData.access_token}`, "Content-Type": "application/json" }, timeout: 15000 });
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
    await deliverAppointmentReminder({ admin, db, axios, logger, organizationId: request.data?.organizationId, appointmentId: request.data?.appointmentId, revision: request.data?.revision });
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
    }
    await conversationRef.set(update, { merge: true });
    return { updated: true, status: status || snapshot.data().status || "waiting" };
  });

  const metaWebhook = onRequest(
    { region, secrets: [secrets.appSecret, secrets.webhookVerifyToken] },
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
        await processWebhookPayload({ admin, db, logger, taskQueue, bookingRuntime, payload: req.body });
        res.sendStatus(200);
      } catch (error) {
        logger.error("Falha ao processar webhook da Meta", { message: 'Falha no processamento; evento será reenviado' });
        res.sendStatus(500);
      }
    },
  );

  return {
    bookingFlowEndpoint,
    lookupExistingWhatsAppPhoneNumber,
    connectExistingWhatsAppPhoneNumber,
    disconnectWhatsApp,
    listWhatsAppFlows,
    saveWhatsAppFlowConfig,
    getAppointmentReminderConfig,
    saveAppointmentReminderConfig,
    createAppointmentFlow,
    completeWhatsAppOnboarding,
    sendWhatsAppMessage,
    sendWhatsAppFlow,
    sendAppointmentReminderTask,
    updateConversationState,
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
    && member.data().status === "active";
  if (!authorized) throw new HttpsError("permission-denied", "Você não possui acesso a esta empresa.");
}

async function processWebhookPayload({ admin, db, logger, taskQueue, bookingRuntime, payload }) {
  if (payload?.object !== "whatsapp_business_account" || !Array.isArray(payload.entry)) return;
  for (const entry of payload.entry) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value || {};
      const phoneNumberId = String(value.metadata?.phone_number_id || "");
      if (!/^\d{5,30}$/.test(phoneNumberId)) continue;
      const mapping = await db.doc(`meta_phone_numbers/${phoneNumberId}`).get();
      if (!mapping.exists || mapping.data().active !== true) {
        logger.warn("Webhook recebido para número não associado", { phoneNumberId });
        continue;
      }
      const organizationId = normalizeDocumentId(mapping.data().organization_id, "Mapeamento de empresa inválido.");
      const contacts = new Map((Array.isArray(value.contacts) ? value.contacts : []).map((contact) => [String(contact.wa_id || ""), contact]));
      for (const message of Array.isArray(value.messages) ? value.messages : []) {
        await saveInboundMessage({ admin, db, taskQueue, bookingRuntime, organizationId, message, contact: contacts.get(String(message.from || "")) });
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

async function saveInboundMessage({ admin, db, taskQueue, bookingRuntime, organizationId, message, contact }) {
  const phone = String(message?.from || "").replace(/\D/g, "");
  const providerMessageId = String(message?.id || "");
  if (!/^\d{8,20}$/.test(phone) || !providerMessageId || providerMessageId.length > 512) return;
  const conversationId = hashId(`contact:${phone}`);
  const messageId = hashId(`message:${providerMessageId}`);
  const sentAt = timestampFromMeta(admin, message.timestamp);
  const text = extractMessageText(message).slice(0, 4096);
  const name = String(contact?.profile?.name || "").trim().slice(0, 120);
  const conversationRef = db.doc(`organizations/${organizationId}/conversations/${conversationId}`);
  const messageRef = conversationRef.collection("messages").doc(messageId);
  const conversationData = {
    contact_phone: phone,
    last_message: text || `[${String(message.type || "mensagem").slice(0, 40)}]`,
    last_message_at: sentAt,
    status: "waiting",
    unread_count: admin.firestore.FieldValue.increment(1),
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (name) {
    conversationData.contact_name = name;
    conversationData.profile_name = name;
  }
  const shouldAutomate = await db.runTransaction(async (transaction) => {
    const existingMessage = await transaction.get(messageRef);
    if (existingMessage.exists) return existingMessage.data().automation_status !== 'completed';
    transaction.set(conversationRef, conversationData, { merge: true });
    transaction.set(messageRef, {
      provider_message_id: providerMessageId,
      direction: "inbound",
      type: String(message.type || "unknown").slice(0, 40),
      text,
      status: "received",
      sent_at: sentAt,
      received_at: admin.firestore.FieldValue.serverTimestamp(),
    });
    return true;
  });
  const flowResponse = parseFlowResponse(message);
  if (flowResponse) await saveFlowAppointment({ admin, db, taskQueue, organizationId, conversationId, phone, customerName: name, response: flowResponse });
  if (shouldAutomate && bookingRuntime) {
    await bookingRuntime.automate({ organizationId, message, contact });
    await messageRef.set({ automation_status: 'completed' }, { merge: true });
  }
}

function extractMessageText(message) {
  if (message?.type === "text") return String(message.text?.body || "");
  if (message?.type === "button") return String(message.button?.text || "");
  if (message?.type === "interactive") {
    return String(message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || (message.interactive?.nfm_reply ? "Agendamento preenchido" : ""));
  }
  if (message?.image?.caption) return String(message.image.caption);
  if (message?.video?.caption) return String(message.video.caption);
  if (message?.document?.caption || message?.document?.filename) return String(message.document.caption || message.document.filename);
  return "";
}

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
  const now = admin.firestore.FieldValue.serverTimestamp();
  await db.runTransaction(async (transaction) => {
    const fresh = await transaction.get(sessionRef);
    if (!fresh.exists || fresh.data().status === "completed") return;
    transaction.set(appointmentRef, { conversation_id: conversationId, customer_phone: phone, customer_name: customerName || session.data().customer_name || "Cliente", service, optional, professional, appointment_date: date, appointment_time: time, scheduled_for: scheduledFor, status: "confirmed", reminder_status: "scheduled", source: "whatsapp_flow", flow_id: session.data().flow_id, created_at: now, updated_at: now });
    transaction.set(sessionRef, { status: "completed", appointment_id: appointmentRef.id, response, completed_at: now, updated_at: now }, { merge: true });
  });
  const config = (await db.doc(`organizations/${organizationId}/automation_configs/appointment_reminder`).get()).data() || {};
  if (config.active !== true || !taskQueue) return;
  let delaySeconds = Number(config.delay_seconds) || 30;
  if (config.trigger === "before_appointment") delaySeconds = Math.max(0, Math.floor((scheduledFor.toMillis() - Date.now()) / 1000) - (Number(config.lead_time_minutes) || 1440) * 60);
  await taskQueue.enqueue({ organizationId, appointmentId: appointmentRef.id }, { scheduleDelaySeconds: delaySeconds });
}

function brazilianAppointmentTimestamp(admin, date, time) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(date || ""));
  if (!match || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time || ""))) return null;
  const parsed = new Date(`${match[3]}-${match[2]}-${match[1]}T${time}:00-03:00`);
  return Number.isNaN(parsed.getTime()) ? null : admin.firestore.Timestamp.fromDate(parsed);
}

async function deliverAppointmentReminder({ admin, db, axios, logger, organizationId, appointmentId, revision }) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(String(organizationId || "")) || !/^[a-zA-Z0-9_-]{1,128}$/.test(String(appointmentId || ""))) return;
  const appointmentRef = db.doc(`organizations/${organizationId}/appointments/${appointmentId}`);
  const [appointment, config, integration, organization] = await Promise.all([appointmentRef.get(), db.doc(`organizations/${organizationId}/automation_configs/appointment_reminder`).get(), db.doc(`organizations/${organizationId}/integrations/whatsapp`).get(), db.doc(`organizations/${organizationId}`).get()]);
  if (!appointment.exists || !config.exists || !integration.exists || !organization.exists) return;
  const data = appointment.data(); const reminder = config.data(); const meta = integration.data();
  if ((data.reminder_revision || revision) && data.reminder_revision !== revision) return;
  if (data.reminder_status === "sent" || reminder.active !== true || data.status !== "confirmed") return;
    const reminderDate = /^\d{4}-\d{2}-\d{2}$/.test(data.appointment_date || '') ? data.appointment_date.split('-').reverse().join('/') : data.appointment_date;
    const parameters = [data.customer_name || "Cliente", organization.data().nome || "Estabelecimento", reminderDate, data.appointment_time].map((text) => ({ type: "text", text: String(text).slice(0, 1024) }));
  try {
    const response = await axios.post(`https://graph.facebook.com/${sanitizeGraphVersion(meta.graph_version)}/${meta.phone_number_id}/messages`, { messaging_product: "whatsapp", recipient_type: "individual", to: data.customer_phone, type: "template", template: { name: reminder.template_name, language: { code: reminder.language }, components: [{ type: "body", parameters }] } }, { headers: { Authorization: `Bearer ${meta.access_token}`, "Content-Type": "application/json" }, timeout: 15000 });
    const providerMessageId = String(response.data?.messages?.[0]?.id || "");
    if (!providerMessageId) throw new Error("missing-message-id");
    await appointmentRef.set({ reminder_status: "sent", reminder_sent_at: admin.firestore.FieldValue.serverTimestamp(), reminder_provider_message_id: providerMessageId, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await saveOutboundProviderMessage({ admin, db, organizationId, conversationId: data.conversation_id, providerMessageId, type: "template", text: `Lembrete enviado: ${data.appointment_date} às ${data.appointment_time}`, createdBy: "automation" });
  } catch (error) {
    logger.error("Falha ao enviar lembrete", { organizationId, appointmentId, status: error.response?.status || null });
    await appointmentRef.set({ reminder_status: "failed", reminder_error: String(error.response?.data?.error?.message || error.message).slice(0, 300), updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
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
};
