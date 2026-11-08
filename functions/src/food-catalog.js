const crypto = require("crypto");
const {mergeNotifications} = require("./order-notifications");
const {withAutomatedMessage} = require("./plan-limits");
const {customerId, normalizePhone} = require("./customers");

function createFoodCatalogFunctions({admin, db, onCall, onRequest, HttpsError, axios, secrets, params, payments, lifecycleTaskQueue}) {
  const options = {region: "southamerica-east1", timeoutSeconds: 60, memory: "512MiB", ...(payments?.oauthSecrets?.length ? {secrets:payments.oauthSecrets} : {})};

  const listFoodCatalog = onCall(options, async (request) => {
    const {organizationId} = await authorize(request, false);
    const [categories, products, config, feed] = await Promise.all([
      db.collection(`organizations/${organizationId}/menu_categories`).orderBy("name").get(),
      db.collection(`organizations/${organizationId}/menu_items`).orderBy("name").get(),
      db.doc(`organizations/${organizationId}/catalog_config/meta`).get(),
      ensureFeed({admin, db, organizationId}),
    ]);
    const categoryMap = new Map(categories.docs.map((document) => [document.id, document.data().name]));
    const directCatalog = config.exists && config.data().connected === true;
    const productRows = products.docs.map((document) => ({id: document.id, ...publicProduct(document.data()), sync_status: directCatalog ? document.data().sync_status : "pending", category_name: categoryMap.get(document.data().category_id) || "Sem categoria"}));
    const integration = publicIntegration(config.exists ? config.data() : {}, productRows, feed.url);
    return {categories: categories.docs.map((document) => ({id: document.id, ...publicCategory(document.data())})), products: productRows, integration};
  });

  const saveFoodCategory = onCall(options, async (request) => {
    const {organizationId, uid} = await authorize(request, true);
    const id = optionalId(request.data?.id);
    let category;
    try { category = categoryPayload(request.data?.category); }
    catch (error) { throw new HttpsError(error.code || "invalid-argument", error.message || "Categoria inválida."); }
    const collection = db.collection(`organizations/${organizationId}/menu_categories`);
    const duplicate = await collection.where("name_key", "==", normalize(category.name)).limit(2).get();
    if (duplicate.docs.some((document) => document.id !== id)) throw new HttpsError("already-exists", "Já existe uma categoria com esse nome.");
    const ref = id ? collection.doc(id) : collection.doc();
    const previous = id ? await ref.get() : null;
    if (id && !previous.exists) throw new HttpsError("not-found", "Categoria não encontrada.");
    const now = admin.firestore.FieldValue.serverTimestamp();
    await ref.set({...category, name_key: normalize(category.name), updated_at: now, updated_by: uid, ...(previous?.exists ? {created_at: previous.data().created_at, created_by: previous.data().created_by} : {created_at: now, created_by: uid})});
    return {id: ref.id, saved: true};
  });

  const deleteFoodCategory = onCall(options, async (request) => {
    const {organizationId} = await authorize(request, true);
    const id = requiredId(request.data?.id);
    const product = await db.collection(`organizations/${organizationId}/menu_items`).where("category_id", "==", id).limit(1).get();
    if (!product.empty) throw new HttpsError("failed-precondition", "Mova ou exclua os produtos desta categoria primeiro.");
    await db.doc(`organizations/${organizationId}/menu_categories/${id}`).delete();
    return {deleted: true};
  });

  const saveFoodProduct = onCall(options, async (request) => {
    const {organizationId, uid} = await authorize(request, true);
    const id = optionalId(request.data?.id);
    let item;
    try { item = productPayload(request.data?.item); }
    catch (error) { throw new HttpsError(error.code || "invalid-argument", error.message || "Produto inválido."); }
    const category = await db.doc(`organizations/${organizationId}/menu_categories/${item.category_id}`).get();
    if (!category.exists || category.data().active === false) throw new HttpsError("failed-precondition", "Selecione uma categoria ativa.");
    const collection = db.collection(`organizations/${organizationId}/menu_items`);
    const ref = id ? collection.doc(id) : collection.doc();
    const previous = id ? await ref.get() : null;
    if (id && !previous.exists) throw new HttpsError("not-found", "Produto não encontrado.");
    const retailerId = item.retailer_id || `AUTOMI-${ref.id.slice(0, 18).toUpperCase()}`;
    const duplicate = await collection.where("retailer_id", "==", retailerId).limit(2).get();
    if (duplicate.docs.some((document) => document.id !== id)) throw new HttpsError("already-exists", "Este código interno já pertence a outro produto.");
    let imageUrl = item.image_url || String(previous?.data()?.image_url || "");
    if (item.image_data === "__remove__") imageUrl = "";
    else if (item.image_data) imageUrl = await storeImage({admin, organizationId, productId: ref.id, dataUrl: item.image_data, HttpsError});
    const now = admin.firestore.FieldValue.serverTimestamp();
    await ref.set({...item, image_url: imageUrl, retailer_id: retailerId, image_data: admin.firestore.FieldValue.delete(), sync_status: "pending", sync_error: "", updated_at: now, updated_by: uid, ...(previous?.exists ? {created_at: previous.data().created_at, created_by: previous.data().created_by, meta_product_id: previous.data().meta_product_id || ""} : {created_at: now, created_by: uid, meta_product_id: ""})}, {merge: true});
    const metaConfig = await db.doc(`organizations/${organizationId}/catalog_config/meta`).get();
    if (!metaConfig.exists || metaConfig.data().connected !== true) {
      await ref.set({sync_status: "feed", sync_error: "", updated_at: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
      return {id: ref.id, saved: true, sync: {synced: false, feed: true}};
    }
    const sync = await syncOne({admin, db, axios, organizationId, productId: ref.id}).catch((error) => ({synced: false, error: safeMetaMessage(error)}));
    return {id: ref.id, saved: true, sync};
  });

  const deleteFoodProduct = onCall(options, async (request) => {
    const {organizationId} = await authorize(request, true);
    const id = requiredId(request.data?.id);
    const ref = db.doc(`organizations/${organizationId}/menu_items/${id}`);
    const product = await ref.get();
    if (!product.exists) throw new HttpsError("not-found", "Produto não encontrado.");
    const metaId = String(product.data().meta_product_id || "");
    if (metaId) {
      const integration = await integrationData(db, organizationId);
      if (integration?.access_token) await axios.delete(`https://graph.facebook.com/${graphVersion(integration)}/${metaId}`, {headers: {Authorization: `Bearer ${integration.access_token}`}, timeout: 15000}).catch(() => null);
    }
    await ref.delete();
    return {deleted: true};
  });

  const syncFoodCatalog = onCall(options, async (request) => {
    const {organizationId} = await authorize(request, true);
    const integration = await integrationData(db, organizationId);
    if (!integration?.active || !integration.access_token || !integration.waba_id) throw new HttpsError("failed-precondition", "Conecte o WhatsApp antes de sincronizar o catálogo.");
    let catalogId;
    try { catalogId = optionalMetaId(request.data?.catalogId); }
    catch (error) { throw new HttpsError("invalid-argument", error.message || "ID do catálogo inválido."); }
    const storedConfig = await db.doc(`organizations/${organizationId}/catalog_config/meta`).get();
    const config = storedConfig.exists && storedConfig.data().connected && storedConfig.data().access_token ? storedConfig.data() : await discoverCatalog({admin, db, axios, organizationId, integration, HttpsError, catalogId});
    const products = await db.collection(`organizations/${organizationId}/menu_items`).get();
    let synced = 0; let failed = 0;
    for (const product of products.docs) {
      const result = await syncOne({admin, db, axios, organizationId, productId: product.id, integration, config}).catch((error) => ({synced: false, error: safeMetaMessage(error)}));
      if (result.synced) synced += 1; else failed += 1;
    }
    const visible = config.catalog_visible !== false;
    const commerce = await setWhatsAppCommerceVisibility({axios, integration, HttpsError, visible});
    await saveCatalogConfig(db, admin, organizationId, {commerce_enabled: visible, catalog_visible: commerce.isCatalogVisible, cart_enabled: commerce.isCartEnabled, commerce_settings_id: commerce.id, commerce_error: ""});
    return {catalogId: config.catalog_id, name: config.name, synced, failed, commerceEnabled: commerce.isCatalogVisible};
  });

  const setFoodCatalogVisibility = onCall(options, async (request) => {
    const {organizationId} = await authorize(request, true);
    const visible = request.data?.visible === true;
    const integration = await integrationData(db, organizationId);
    const commerce = await setWhatsAppCommerceVisibility({axios, integration, HttpsError, visible});
    await saveCatalogConfig(db, admin, organizationId, {
      commerce_enabled: visible,
      catalog_visible: commerce.isCatalogVisible,
      cart_enabled: commerce.isCartEnabled,
      commerce_settings_id: commerce.id,
      commerce_error: "",
    });
    return {visible: commerce.isCatalogVisible, cartEnabled: commerce.isCartEnabled};
  });

  const connectFoodCatalog = onCall({...options, secrets: [secrets.appSecret]}, async (request) => {
    const {organizationId, uid} = await authorize(request, true);
    const catalogId = optionalMetaId(request.data?.catalogId);
    const shortToken = String(request.data?.accessToken || "").trim();
    if (!catalogId || shortToken.length < 40 || shortToken.length > 4096) throw new HttpsError("invalid-argument", "Autorização ou ID do catálogo inválido.");
    const version = paramValue(params.graphVersion) || "v24.0";
    const appId = paramValue(params.appId);
    const appSecret = secretValue(secrets.appSecret);
    try {
      const exchanged = await axios.get(`https://graph.facebook.com/${version}/oauth/access_token`, {params: {grant_type: "fb_exchange_token", client_id: appId, client_secret: appSecret, fb_exchange_token: shortToken}, timeout: 15000});
      const accessToken = String(exchanged.data?.access_token || shortToken);
      const debug = await axios.get(`https://graph.facebook.com/${version}/debug_token`, {params: {input_token: accessToken}, headers: {Authorization: `Bearer ${accessToken}`}, timeout: 15000});
      const scopes = Array.isArray(debug.data?.data?.scopes) ? debug.data.data.scopes.map(String) : [];
      if (!scopes.includes("catalog_management")) throw new HttpsError("failed-precondition", "A Meta não concedeu catalog_management. Autorize o acesso ao catálogo na janela aberta pelo Automichat.");
      const catalogResponse = await axios.get(`https://graph.facebook.com/${version}/${catalogId}`, {params: {fields: "id,name,vertical"}, headers: {Authorization: `Bearer ${accessToken}`}, timeout: 15000});
      if (!catalogResponse.data?.id) throw new HttpsError("not-found", "Catálogo não encontrado para esta conta.");
      const config = {connected: true, catalog_id: String(catalogResponse.data.id), name: String(catalogResponse.data.name || "Catálogo Meta"), vertical: String(catalogResponse.data.vertical || "commerce"), access_token: accessToken, token_expires_in: Number(exchanged.data?.expires_in || 0), connected_by: uid, connected_at: admin.firestore.FieldValue.serverTimestamp(), error: ""};
      await db.doc(`organizations/${organizationId}/catalog_config/meta`).set(config, {merge: true});
      const products = await db.collection(`organizations/${organizationId}/menu_items`).get();
      let synced = 0; let failed = 0;
      for (const product of products.docs) { const result = await syncOne({admin, db, axios, organizationId, productId: product.id, config}); if (result.synced) synced += 1; else failed += 1; }
      const integration = await integrationData(db, organizationId);
      const commerce = await setWhatsAppCommerceVisibility({axios, integration, HttpsError, visible: true});
      await saveCatalogConfig(db, admin, organizationId, {commerce_enabled: true, catalog_visible: commerce.isCatalogVisible, cart_enabled: commerce.isCartEnabled, commerce_settings_id: commerce.id, commerce_error: ""});
      return {connected: true, catalogId: config.catalog_id, name: config.name, synced, failed, commerceEnabled: true};
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      throw new HttpsError("failed-precondition", `A Meta não autorizou este catálogo. ${safeMetaMessage(error)}`);
    }
  });

  const listFoodOrders = onCall(options, async (request) => {
    const {organizationId} = await authorize(request, false);
    const snapshot = await db.collection(`organizations/${organizationId}/orders`).orderBy("created_at", "desc").limit(300).get();
    const orders = snapshot.docs.filter((document) => isOperationalOrder(document.data())).slice(0, 100).map((document) => ({id: document.id, ...publicOrder(document.data())}));
    return {orders};
  });

  const updateFoodOrderStatus = onCall(options, async (request) => {
    const {organizationId, uid} = await authorize(request, true);
    const id = requiredId(request.data?.id);
    const status = String(request.data?.status || "");
    const allowed = ["confirmed", "preparing", "ready", "out_for_delivery", "completed", "cancelled"];
    if (!allowed.includes(status)) throw new HttpsError("invalid-argument", "Status inválido.");
    const ref = db.doc(`organizations/${organizationId}/orders/${id}`);
    const existing = await ref.get();
    if (!existing.exists) throw new HttpsError("not-found", "Pedido não encontrado.");
    if (["completed", "cancelled"].includes(existing.data().status)) throw new HttpsError("failed-precondition", "Este pedido já foi encerrado.");
    const transitions = {awaiting_confirmation:["confirmed","cancelled"],received:["confirmed","cancelled"],awaiting_payment:["cancelled"],confirmed:["preparing","cancelled"],preparing:["ready","cancelled"],ready:["out_for_delivery","completed","cancelled"],out_for_delivery:["completed","cancelled"]};
    if (!(transitions[existing.data().status] || []).includes(status)) throw new HttpsError("failed-precondition", "Essa mudança de status não é permitida agora.");
    const operationalIssue = orderOperationalIssue(existing.data());
    if (status !== "cancelled" && operationalIssue) throw new HttpsError("failed-precondition", operationalIssue);
    if (status === "preparing" && ["pix","card_online"].includes(existing.data().payment?.method) && existing.data().payment?.status !== "paid") throw new HttpsError("failed-precondition", "Aguarde a confirmação do pagamento online antes de iniciar o preparo.");
    const reason = String(request.data?.reason || "").trim().slice(0, 300);
    if (status === "cancelled" && reason.length < 3) throw new HttpsError("invalid-argument", "Informe o motivo do cancelamento.");
    const courierName = String(request.data?.courierName || "").trim().slice(0, 100);
    const etaMinutes = Math.max(0, Math.min(240, Math.trunc(Number(request.data?.etaMinutes) || 0)));
    if (status === "out_for_delivery" && existing.data().fulfillment_type !== "delivery") throw new HttpsError("failed-precondition", "Somente pedidos para entrega podem sair para entrega.");
    if (status === "out_for_delivery" && (!courierName || etaMinutes < 1)) throw new HttpsError("invalid-argument", "Informe o entregador e a previsão em minutos.");
    const delivery = status === "out_for_delivery" ? {...object(existing.data().delivery),courier_name:courierName,eta_minutes:etaMinutes,dispatched_at:admin.firestore.Timestamp.now()} : status === "completed" && existing.data().fulfillment_type === "delivery" ? {...object(existing.data().delivery),delivered_at:admin.firestore.Timestamp.now()} : object(existing.data().delivery);
    const waitsForOnlinePayment = status === "confirmed" && ["pix","card_online"].includes(existing.data().payment?.method) && existing.data().payment?.status !== "paid";
    const nextStatus = waitsForOnlinePayment ? "awaiting_payment" : status;
    await ref.set({status:nextStatus, delivery, ...(status === "cancelled" ? {cancellation_reason: reason} : {}), status_history: admin.firestore.FieldValue.arrayUnion({status:nextStatus, source: "dashboard", changed_by: uid, ...(reason ? {reason} : {}), ...(courierName ? {courier_name:courierName,eta_minutes:etaMinutes} : {}), at: admin.firestore.Timestamp.now()}), updated_at: admin.firestore.FieldValue.serverTimestamp(), updated_by: uid}, {merge: true});
    const customerPhone = normalizePhone(existing.data().customer_phone, false);
    if (status === "completed" && customerPhone) await db.doc(`organizations/${organizationId}/customers/${customerId(customerPhone)}`).set({phone:customerPhone,phone_key:customerPhone,last_activity_at:admin.firestore.FieldValue.serverTimestamp(),updated_at:admin.firestore.FieldValue.serverTimestamp(),updated_by:uid},{merge:true});
    const notification = await sendOrderStatusNotification({admin, db, axios, HttpsError, organizationId, orderId: id, order: {...existing.data(),delivery}, status:nextStatus, reason});
    if (status === "completed" && lifecycleTaskQueue) {
      const config = (await db.doc(`organizations/${organizationId}/automation_configs/lifecycle_reminders`).get()).data()?.automations?.post_order;
      if (config?.active) {
        try { await lifecycleTaskQueue.enqueue({organizationId,automationId:"post_order",entityId:id},{scheduleDelaySeconds:Math.max(0,Number(config.delay_minutes)||0)*60}); }
        catch { await ref.set({post_order_queue_status:"failed",updated_at:admin.firestore.FieldValue.serverTimestamp()},{merge:true}); }
      }
    }
    let payment = {status:"not_applicable"};
    if (status === "confirmed" && ["pix","card_online"].includes(existing.data().payment?.method) && payments?.createOrderPayment) {
      try { payment = await payments.createOrderPayment(organizationId,id); }
      catch (error) { payment = {status:"failed",error:String(error.message || "Não foi possível gerar a cobrança.").slice(0,200)}; await ref.set({payment:{...object(existing.data().payment),status:"failed",error:payment.error},updated_at:admin.firestore.FieldValue.serverTimestamp()},{merge:true}); }
    }
    return {updated: true, notification, payment};
  });

  const retryFoodOrderPix = onCall(options, async (request) => {
    const {organizationId} = await authorize(request, true);
    const id = requiredId(request.data?.id);
    const snapshot = await db.doc(`organizations/${organizationId}/orders/${id}`).get();
    if (!snapshot.exists) throw new HttpsError("not-found", "Pedido não encontrado.");
    if (snapshot.data().payment?.method !== "pix" || !["awaiting_payment","confirmed","preparing"].includes(snapshot.data().status)) throw new HttpsError("failed-precondition", "Este pedido não permite gerar uma nova cobrança Pix.");
    try { return await payments.createOrderPix(organizationId,id); }
    catch (error) { throw new HttpsError("failed-precondition", String(error.message || "Não foi possível gerar o Pix.").slice(0,200)); }
  });

  const foodCatalogFeed = onRequest({region: "southamerica-east1", timeoutSeconds: 30, memory: "256MiB", invoker: "public"}, async (request, response) => {
    if (request.method !== "GET") { response.status(405).send("Method not allowed"); return; }
    const organizationId = String(request.query.organizationId || "").trim();
    const token = String(request.query.token || "").trim();
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(organizationId) || !/^[a-f0-9-]{36}$/.test(token)) { response.status(404).send("Feed not found"); return; }
    const feed = await db.doc(`organizations/${organizationId}/catalog_config/feed`).get();
    const savedToken = String(feed.data()?.token || "");
    if (!feed.exists || !safeEqual(savedToken, token)) { response.status(404).send("Feed not found"); return; }
    const [organization, products] = await Promise.all([db.doc(`organizations/${organizationId}`).get(), db.collection(`organizations/${organizationId}/menu_items`).get()]);
    if (!organization.exists) { response.status(404).send("Feed not found"); return; }
    const brand = String(organization.data().nome || "Automichat");
    const headers = ["id","title","description","availability","condition","price","link","image_link","brand"];
    const rows = products.docs.map((document) => document.data()).filter((item) => item.active !== false && item.image_url).map((item) => [item.retailer_id, item.name, item.description, item.availability === "out of stock" ? "out of stock" : "in stock", "new", `${(Number(item.price_cents || 0) / 100).toFixed(2)} BRL`, "https://whatsapp-software-a85f3.web.app", item.image_url, brand]);
    response.set("Content-Type", "text/csv; charset=utf-8"); response.set("Cache-Control", "private, no-store");
    response.status(200).send(`\uFEFF${[headers, ...rows].map((row) => row.map(csv).join(",")).join("\n")}`);
  });

  async function authorize(request, ownerOnly) {
    if (!request.auth) throw new HttpsError("unauthenticated", "Faça login para acessar o cardápio.");
    const organizationId = requiredId(request.data?.organizationId);
    const [profile, organization, member] = await Promise.all([db.doc(`users/${request.auth.uid}`).get(), db.doc(`organizations/${organizationId}`).get(), db.doc(`organizations/${organizationId}/members/${request.auth.uid}`).get()]);
    const allowed = profile.exists && organization.exists && member.exists && profile.data().organizacao_id === organizationId && organization.data().status !== "suspended" && member.data().status === "active";
    if (!allowed || (ownerOnly && organization.data().proprietario_uid !== request.auth.uid)) throw new HttpsError("permission-denied", ownerOnly ? "Somente o proprietário pode alterar o cardápio." : "Você não possui acesso a esta empresa.");
    return {organizationId, uid: request.auth.uid, organization: organization.data()};
  }

  return {listFoodCatalog, saveFoodCategory, deleteFoodCategory, saveFoodProduct, deleteFoodProduct, syncFoodCatalog, setFoodCatalogVisibility, connectFoodCatalog, listFoodOrders, updateFoodOrderStatus, retryFoodOrderPix, foodCatalogFeed};
}

function secretValue(secret) { try { return String(secret?.value?.() || ""); } catch { return ""; } }
function paramValue(param) { try { return String(param?.value?.() || ""); } catch { return String(param || ""); } }

async function ensureFeed({admin, db, organizationId}) {
  const ref = db.doc(`organizations/${organizationId}/catalog_config/feed`);
  const snapshot = await ref.get();
  let token = String(snapshot.data()?.token || "");
  if (!/^[a-f0-9-]{36}$/.test(token)) { token = crypto.randomUUID(); await ref.set({token, created_at: admin.firestore.FieldValue.serverTimestamp()}, {merge: true}); }
  const projectId = admin.app().options.projectId || "whatsapp-software-a85f3";
  return {url: `https://southamerica-east1-${projectId}.cloudfunctions.net/foodCatalogFeed?organizationId=${encodeURIComponent(organizationId)}&token=${encodeURIComponent(token)}`};
}

function safeEqual(left, right) { const a = Buffer.from(String(left)); const b = Buffer.from(String(right)); return a.length === b.length && crypto.timingSafeEqual(a, b); }
function csv(value) { const text = String(value ?? "").replace(/\r?\n/g, " "); return `"${text.replace(/"/g, '""')}"`; }

async function discoverCatalog({admin, db, axios, organizationId, integration, HttpsError, catalogId = ""}) {
  const version = graphVersion(integration);
  let rows;
  try {
    if (catalogId) {
      const response = await axios.get(`https://graph.facebook.com/${version}/${catalogId}`, {params: {fields: "id,name,vertical"}, headers: {Authorization: `Bearer ${integration.access_token}`}, timeout: 15000});
      rows = response.data?.id ? [response.data] : [];
    } else {
      const response = await axios.get(`https://graph.facebook.com/${version}/${integration.waba_id}/product_catalogs`, {params: {fields: "id,name,vertical"}, headers: {Authorization: `Bearer ${integration.access_token}`}, timeout: 15000});
      rows = Array.isArray(response.data?.data) ? response.data.data : [];
    }
  } catch (error) {
    const message = safeMetaMessage(error);
    await saveCatalogConfig(db, admin, organizationId, {connected: false, error: message});
    throw new HttpsError("failed-precondition", `${catalogId ? "A Meta não permitiu acessar este catálogo" : "A Meta não permitiu consultar o catálogo"}. ${message}`);
  }
  if (!rows.length) {
    const message = "Nenhum catálogo está conectado a esta conta do WhatsApp.";
    await saveCatalogConfig(db, admin, organizationId, {connected: false, error: message});
    throw new HttpsError("failed-precondition", message);
  }
  const catalog = rows[0];
  const config = {connected: true, catalog_id: String(catalog.id), name: String(catalog.name || "Catálogo Meta"), vertical: String(catalog.vertical || "commerce"), error: "", updated_at: admin.firestore.FieldValue.serverTimestamp()};
  await db.doc(`organizations/${organizationId}/catalog_config/meta`).set(config, {merge: true});
  return config;
}

async function syncOne({admin, db, axios, organizationId, productId, integration: providedIntegration, config: providedConfig}) {
  const [productSnapshot, integration] = await Promise.all([db.doc(`organizations/${organizationId}/menu_items/${productId}`).get(), providedIntegration ? Promise.resolve(providedIntegration) : integrationData(db, organizationId)]);
  if (!productSnapshot.exists) return {synced: false, error: "Produto não encontrado."};
  const product = productSnapshot.data();
  if ((!providedConfig?.access_token) && (!integration?.active || !integration.access_token || !integration.waba_id)) return markSync(db, admin, organizationId, productId, false, "Conecte o WhatsApp para sincronizar.");
  let config = providedConfig;
  if (!config) {
    const stored = await db.doc(`organizations/${organizationId}/catalog_config/meta`).get();
    config = stored.exists && stored.data().connected ? stored.data() : await discoverCatalog({admin, db, axios, organizationId, integration, HttpsError: CatalogDiscoveryError});
  }
  const catalogAccessToken = String(config?.access_token || integration?.access_token || "");
  if (!product.image_url) return markSync(db, admin, organizationId, productId, false, "Adicione uma foto antes de sincronizar com a Meta.");
  const body = {retailer_id: product.retailer_id, name: product.name, description: product.description, availability: product.active === false ? "out of stock" : product.availability, condition: "new", price: Number(product.price_cents), currency: "BRL", image_url: product.image_url, url: "https://whatsapp-software-a85f3.web.app"};
  try {
    let metaId = String(product.meta_product_id || "");
    if (metaId) await axios.post(`https://graph.facebook.com/${graphVersion(integration)}/${metaId}`, body, {headers: {Authorization: `Bearer ${catalogAccessToken}`}, timeout: 20000});
    else {
      const response = await axios.post(`https://graph.facebook.com/${graphVersion(integration)}/${config.catalog_id}/products`, body, {headers: {Authorization: `Bearer ${catalogAccessToken}`}, timeout: 20000});
      metaId = String(response.data?.id || "");
      if (!metaId) throw new Error("A Meta não retornou o ID do produto.");
    }
    await db.doc(`organizations/${organizationId}/menu_items/${productId}`).set({meta_product_id: metaId, sync_status: "synced", sync_error: "", synced_at: admin.firestore.FieldValue.serverTimestamp(), updated_at: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
    return {synced: true, metaProductId: metaId};
  } catch (error) {
    const message = safeMetaMessage(error);
    await markSync(db, admin, organizationId, productId, false, message);
    return {synced: false, error: message};
  }
}

async function markSync(db, admin, organizationId, productId, synced, error) { await db.doc(`organizations/${organizationId}/menu_items/${productId}`).set({sync_status: synced ? "synced" : "error", sync_error: String(error || "").slice(0, 500), updated_at: admin.firestore.FieldValue.serverTimestamp()}, {merge: true}); return {synced, error}; }
async function saveCatalogConfig(db, admin, organizationId, data) { await db.doc(`organizations/${organizationId}/catalog_config/meta`).set({...data, updated_at: admin.firestore.FieldValue.serverTimestamp()}, {merge: true}); }
async function integrationData(db, organizationId) { const snapshot = await db.doc(`organizations/${organizationId}/integrations/whatsapp`).get(); return snapshot.data() || null; }

async function setWhatsAppCommerceVisibility({axios, integration, HttpsError, visible}) {
  const phoneNumberId = String(integration?.phone_number_id || "");
  const accessToken = String(integration?.access_token || "");
  if (!integration?.active || !phoneNumberId || !accessToken) {
    throw new HttpsError("failed-precondition", "Conecte novamente o WhatsApp antes de ativar o catálogo no aplicativo.");
  }
  const url = `https://graph.facebook.com/${graphVersion(integration)}/${phoneNumberId}/whatsapp_commerce_settings`;
  try {
    await axios.post(url, null, {params: {is_cart_enabled: visible, is_catalog_visible: visible}, headers: {Authorization: `Bearer ${accessToken}`}, timeout: 15000});
    const response = await axios.get(url, {headers: {Authorization: `Bearer ${accessToken}`}, timeout: 15000});
    const settings = Array.isArray(response.data?.data) ? response.data.data[0] : null;
    if (!settings || settings.is_catalog_visible !== visible) throw new Error("A Meta ainda não confirmou a alteração do catálogo.");
    return {id: String(settings.id || ""), isCartEnabled: settings.is_cart_enabled === true, isCatalogVisible: settings.is_catalog_visible === true};
  } catch (error) {
    throw new HttpsError("failed-precondition", `A Meta não permitiu alterar a exibição do catálogo no WhatsApp. Confirme que ele está associado à mesma conta. ${safeMetaMessage(error)}`);
  }
}

async function storeImage({admin, organizationId, productId, dataUrl, HttpsError}) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([a-zA-Z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!match) throw new HttpsError("invalid-argument", "Imagem inválida. Use JPG, PNG ou WebP.");
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) throw new HttpsError("invalid-argument", "A imagem deve ter no máximo 5 MB.");
  const extension = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}[match[1]];
  const token = crypto.randomUUID();
  const path = `organizations/${organizationId}/menu/${productId}.${extension}`;
  const bucket = admin.storage().bucket();
  await bucket.file(path).save(buffer, {resumable: false, contentType: match[1], metadata: {cacheControl: "public,max-age=31536000", metadata: {firebaseStorageDownloadTokens: token}}});
  return `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket.name)}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

function categoryPayload(value) { const input = object(value); return {name: requiredText(input.name, 2, 60, "Informe o nome da categoria."), description: optionalText(input.description, 160), active: input.active !== false}; }
function productPayload(value) { const input = object(value); const price = Number(input.price); if (!Number.isFinite(price) || price < 0.01 || price > 100000) throw invalid("Preço inválido."); const availability = String(input.availability || "in stock"); if (!["in stock", "out of stock"].includes(availability)) throw invalid("Disponibilidade inválida."); const imageData = String(input.imageData || ""); if (imageData.length > 7_100_000) throw invalid("Imagem muito grande."); const imageUrl = optionalText(input.imageUrl, 1000); if (imageUrl && !/^https:\/\//.test(imageUrl)) throw invalid("URL da imagem inválida."); return {name: requiredText(input.name, 2, 100, "Informe o nome do produto."), description: requiredText(input.description, 2, 500, "Informe a descrição do produto."), price_cents: Math.round(price * 100), category_id: requiredId(input.categoryId), retailer_id: optionalIdentifier(input.retailerId), availability, active: input.active !== false, featured: input.featured === true, image_data: imageData, image_url: imageUrl}; }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function requiredText(value, min, max, message) { const text = String(value || "").trim(); if (text.length < min || text.length > max) throw invalid(message); return text; }
function optionalText(value, max) { const text = String(value || "").trim(); if (text.length > max) throw invalid("Texto muito longo."); return text; }
function requiredId(value) { const id = String(value || "").trim(); if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw invalid("Identificador inválido."); return id; }
function optionalId(value) { return value ? requiredId(value) : ""; }
function optionalIdentifier(value) { const id = String(value || "").trim().toUpperCase(); if (id && !/^[A-Z0-9._-]{2,80}$/.test(id)) throw invalid("Código interno inválido."); return id; }
function optionalMetaId(value) { const id = String(value || "").trim(); if (id && !/^\d{5,30}$/.test(id)) throw invalid("ID do catálogo inválido."); return id; }
function invalid(message) { const error = new Error(message); error.code = "invalid-argument"; return error; }
class CatalogDiscoveryError extends Error { constructor(code, message) { super(message); this.code = code; } }
function normalize(value) { return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR"); }
function graphVersion(integration) { const value = String(integration?.graph_version || "v24.0"); return /^v\d+\.\d+$/.test(value) ? value : "v24.0"; }
function safeMetaMessage(error) { return String(error?.response?.data?.error?.error_user_msg || error?.response?.data?.error?.message || error?.message || "Falha na sincronização com a Meta.").replace(/EA[A-Za-z0-9_-]{20,}/g, "[credencial protegida]").slice(0, 500); }

async function sendOrderStatusNotification({admin, db, axios, HttpsError, organizationId, orderId, order, status, reason}) {
  const notificationId = status === "ready" && order.fulfillment_type === "delivery" ? null : {confirmed:"confirmed",preparing:"preparing",ready:"ready_pickup",out_for_delivery:"out_for_delivery",completed:"delivered",cancelled:"cancelled"}[status];
  if (!notificationId) return {status:"not_applicable"};
  const [config, integration] = await Promise.all([db.doc(`organizations/${organizationId}/automation_configs/order_notifications`).get(), db.doc(`organizations/${organizationId}/integrations/whatsapp`).get()]);
  const item = mergeNotifications(config.data()?.notifications).find(entry => entry.id === notificationId);
  if (!item?.enabled) return {status:"disabled"};
  const credentials = integration.data() || {};
  if (!credentials.active || !credentials.access_token || !credentials.phone_number_id) return {status:"failed",error:"WhatsApp desconectado"};
  const text = item.message.replace("{{motivo_cancelamento}}", reason || "não informado").replace("{{tempo_entrega}}", String(order.delivery?.eta_minutes || 20));
  try {
    const response = await withAutomatedMessage({db,admin,organizationId,HttpsError,reference:`order_status_${orderId}_${notificationId}`,send:async()=>{const sent=await axios.post(`https://graph.facebook.com/${graphVersion(credentials)}/${credentials.phone_number_id}/messages`, {messaging_product:"whatsapp",recipient_type:"individual",to:order.customer_phone,type:"text",text:{preview_url:false,body:text}}, {headers:{Authorization:`Bearer ${credentials.access_token}`,"Content-Type":"application/json"},timeout:15000});if(!sent.data?.messages?.[0]?.id)throw new Error("A Meta não retornou o ID da mensagem.");return sent;}});
    const providerMessageId = String(response.data?.messages?.[0]?.id || "");
    if (!providerMessageId) throw new Error("A Meta não retornou o ID da mensagem.");
    const messageId = crypto.createHash("sha256").update(`message:${providerMessageId}`).digest("hex");
    const now = admin.firestore.FieldValue.serverTimestamp(); const batch = db.batch();
    const conversationRef = db.doc(`organizations/${organizationId}/conversations/${order.conversation_id}`);
    batch.set(conversationRef.collection("messages").doc(messageId),{provider_message_id:providerMessageId,direction:"outbound",type:"text",text,status:"sent",sent_at:now,created_by:"order_automation",created_at:now});
    batch.set(conversationRef,{last_message:text,last_message_at:now,last_direction:"outbound",status:"open",updated_at:now},{merge:true});
    batch.set(db.doc(`meta_messages/${messageId}`),{organization_id:organizationId,conversation_id:order.conversation_id,message_id:messageId,active:true,updated_at:now},{merge:true});
    batch.set(db.doc(`organizations/${organizationId}/orders/${orderId}`),{message_statuses:{[notificationId]:{status:"sent",provider_message_id:providerMessageId,updated_at:admin.firestore.Timestamp.now()}},updated_at:now},{merge:true});
    await batch.commit(); return {status:"sent"};
  } catch (error) {
    await db.doc(`organizations/${organizationId}/orders/${orderId}`).set({message_statuses:{[notificationId]:{status:"failed",error:safeMetaMessage(error),updated_at:admin.firestore.Timestamp.now()}},updated_at:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    return {status:"failed",error:safeMetaMessage(error)};
  }
}
function publicCategory(data) { return {name: String(data.name || ""), description: String(data.description || ""), active: data.active !== false}; }
function publicProduct(data) { return {name: String(data.name || ""), description: String(data.description || ""), price_cents: Number(data.price_cents || 0), category_id: String(data.category_id || ""), retailer_id: String(data.retailer_id || ""), availability: String(data.availability || "out of stock"), active: data.active !== false, featured: data.featured === true, image_url: String(data.image_url || ""), meta_product_id: String(data.meta_product_id || ""), sync_status: String(data.sync_status || "pending"), sync_error: String(data.sync_error || "")}; }
function publicIntegration(data, products, feedUrl = "") { return {connected: data.connected === true, catalogId: String(data.catalog_id || ""), name: String(data.name || ""), error: String(data.error || ""), catalogVisible: data.catalog_visible !== false, cartEnabled: data.cart_enabled !== false, syncedProducts: products.filter((item) => item.sync_status === "synced").length, feedUrl: String(feedUrl || "")}; }
function publicOrder(data) { return {number: String(data.number || ""), customer_name: String(data.customer_name || data.customer?.name || ""), customer_phone: String(data.customer_phone || data.customer?.phone || ""), status: String(data.status || "awaiting_data"), currency: String(data.currency || "BRL"), subtotal_cents: Number(data.subtotal_cents || data.total_cents || 0), delivery_fee_cents: Number(data.delivery_fee_cents || 0), discount_cents: Number(data.discount_cents || 0), total_cents: Number(data.total_cents || 0), fulfillment_type: String(data.fulfillment_type || "pending"), address: object(data.address), payment: object(data.payment), observations: String(data.observations || ""), delivery: object(data.delivery), requires_checkout: data.requires_checkout === true, message_statuses: object(data.message_statuses), status_history: Array.isArray(data.status_history) ? data.status_history.slice(-50).map(item => ({status: String(item?.status || ""), source: String(item?.source || ""), at: item?.at?.toMillis?.() || null})) : [], items: Array.isArray(data.items) ? data.items.slice(0, 100).map((item) => ({product_id: String(item.product_id || ""), name: String(item.name || "Produto"), retailer_id: String(item.retailer_id || ""), quantity: Number(item.quantity || 0), unit_price_cents: Number(item.unit_price_cents || 0), total_cents: Number(item.total_cents || 0)})) : [], created_at: data.created_at?.toMillis?.() || null, updated_at: data.updated_at?.toMillis?.() || null}; }

function orderOperationalIssue(data = {}) {
  if (!['delivery','pickup','dine_in'].includes(String(data.fulfillment_type || ''))) return 'Defina se o pedido será entregue, retirado ou consumido no local antes de avançar.';
  if (!['pix','card_online','cash','card'].includes(String(data.payment?.method || ''))) return 'Defina a forma de pagamento antes de avançar.';
  if (data.fulfillment_type === 'delivery') {
    const address = object(data.address);
    if (String(address.line || '').trim().length < 5 && (!String(address.street || '').trim() || !String(address.number || '').trim())) return 'Informe o endereço completo antes de avançar o pedido para entrega.';
  }
  return '';
}

function isOperationalOrder(data = {}) { return String(data.status || '') !== 'awaiting_data' && !orderOperationalIssue(data); }

module.exports = {createFoodCatalogFunctions, _test: {categoryPayload, productPayload, publicOrder, safeMetaMessage, orderOperationalIssue, isOperationalOrder}};
