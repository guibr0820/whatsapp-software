const test = require("node:test");
const assert = require("node:assert/strict");
const {
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
} = require("../src/meta-whatsapp");

test("suporte interno usa o número do dono e menus conforme a identificação", () => {
  assert.equal(AUTOMICHAT_SUPPORT_PHONE_NUMBER_ID, "1124719307396782");
  const customer = automichatSupportMenu(true);
  const visitor = automichatSupportMenu(false);
  assert.ok(customer.rows.some(([id]) => id === "support_account"));
  assert.ok(customer.rows.some(([id]) => id === "support_connect"));
  assert.equal(visitor.rows.some(([id]) => id === "support_account"), false);
  assert.ok(visitor.rows.some(([id]) => id === "support_signup"));
  assert.ok(customer.rows.every(([, title]) => title.length <= 24));
});

test("suporte reconhece opções interativas e atalhos de texto", () => {
  assert.equal(supportActionId({ type: "interactive", interactive: { list_reply: { id: "support_connect" } } }), "support_connect");
  assert.equal(supportActionId({ type: "text", text: { body: "atendente" } }), "support_human");
  assert.equal(supportActionId({ type: "text", text: { body: "mensagem aleatória" } }), "");
});

test("identifica o contato comercial iniciado pelo botão do site", () => {
  assert.equal(isAutomichatWebsiteLead("Olá! Vim pelo site e gostaria de saber mais sobre o Automichat."), true);
  assert.equal(isAutomichatWebsiteLead("Quero saber mais"), false);
  assert.equal(isSmilecutWebsiteLead("Olá! Vim pelo site e gostaria de saber mais sobre o Smilecut."), true);
  assert.equal(isSmilecutWebsiteLead("Quero saber mais"), false);
});

test("fallback interno é exclusivo do Number ID do Automichat", () => {
  const supportOrganizationId = "empresa_interna";
  assert.equal(resolveWebhookOrganizationId({ phoneNumberId: AUTOMICHAT_SUPPORT_PHONE_NUMBER_ID, mapping: { active: false }, supportOrganizationId }), supportOrganizationId);
  assert.equal(resolveWebhookOrganizationId({ phoneNumberId: "999999999999", mapping: { active: false }, supportOrganizationId }), "");
  assert.equal(resolveWebhookOrganizationId({ phoneNumberId: "999999999999", mapping: { active: true, organization_id: "empresa_cliente" }, supportOrganizationId }), "empresa_cliente");
});

test("modo de agenda demonstrativo é exclusivo do telefone administrador", () => {
  const authorizedPhone = "5511994917461";
  assert.equal(supportDemoRoute({ phone: authorizedPhone, authorizedPhone, conversation: {}, messageText: "agendar" }), "enter");
  assert.equal(supportDemoRoute({ phone: "5519999999999", authorizedPhone, conversation: {}, messageText: "agendar" }), "support");
  assert.equal(supportDemoRoute({ phone: authorizedPhone, authorizedPhone, conversation: { support_demo_mode: "appointments" }, messageText: "menu" }), "appointments");
  assert.equal(supportDemoRoute({ phone: authorizedPhone, authorizedPhone, conversation: { support_demo_mode: "appointments" }, messageText: "encerrar" }), "exit");
  assert.equal(supportDemoRoute({ phone: authorizedPhone, authorizedPhone: "", conversation: {}, messageText: "agendar" }), "support");
});

test("menu principal separa Automichat e Smilecut em dois botões", () => {
  const selector = supportProductSelector("Ana");
  assert.match(selector.body, /Automichat/);
  assert.match(selector.body, /Smilecut/);
  assert.deepEqual(selector.buttons.map(([id]) => id), ["product_automichat", "product_smilecut"]);
  assert.ok(selector.buttons.every(([, title]) => title.length <= 20));
});

test("Smilecut oferece menus próprios para cliente e barbearia", () => {
  assert.ok(smilecutSupportMenu().rows.some(([id]) => id === "smile_client"));
  assert.ok(smilecutSupportMenu().rows.some(([id]) => id === "smile_owner"));
  assert.ok(smilecutClientMenu().rows.some(([id]) => id === "smile_manage_booking"));
  assert.ok(smilecutOwnerMenu().rows.some(([id]) => id === "smile_team_services"));
  for (const menu of [smilecutSupportMenu(), smilecutClientMenu(), smilecutOwnerMenu()]) {
    assert.ok(menu.rows.every(([, title, description]) => title.length <= 24 && description.length <= 72));
  }
});

test("diagnóstico do webhook não expõe credenciais", () => {
  const error = new Error("Falha com Bearer token-super-secreto e EAA123456789012345678901234567890");
  error.code = "internal";
  const result = safeWebhookError(error);
  assert.equal(result.message.includes("token-super-secreto"), false);
  assert.equal(result.message.includes("EAA123"), false);
  assert.equal(result.code, "internal");
});

test("alimentação inicia somente o caminho de pedidos", () => {
  const menu = segmentMenu({ family: "food", modules: ["orders"] });
  assert.equal(menu.mode, "text");
  assert.match(menu.body, /Gostaria de fazer um pedido/);
  assert.match(menu.body, /cardápio/);
  assert.deepEqual(menu.rows, []);
});

test("qualquer mensagem de conversa pode abrir a entrada do segmento", () => {
  assert.equal(normalizedIntent("  Oi!  "), "oi");
  assert.equal(shouldOfferSegmentMenu({ type: "text", text: { body: "oi" } }), true);
  assert.equal(shouldOfferSegmentMenu({ type: "text", text: { body: "quero fazer um pedido" } }), true);
  assert.equal(shouldOfferSegmentMenu({ type: "text", text: { body: "manda o cardapio" } }), true);
  assert.equal(shouldOfferSegmentMenu({ type: "text", text: { body: "tem sorvete?" } }), true);
  assert.equal(shouldOfferSegmentMenu({ type: "text", text: { body: "qualquer mensagem" } }), true);
  assert.equal(shouldOfferSegmentMenu({ type: "text", text: { body: "teste 2" } }), true);
  assert.equal(shouldOfferSegmentMenu({ type: "interactive", interactive: { list_reply: { id: "segment_menu" } } }), true);
  assert.equal(shouldOfferSegmentMenu({ type: "image" }), false);
});

test('valida o perfil público antes de enviar à Meta', () => {
  assert.deepEqual(normalizeBusinessProfileInput({ about:'Aberto hoje', description:'Salão especializado', address:'Rua Central, 10', email:'contato@empresa.com.br', vertical:'beauty', website:'https://empresa.com.br', website2:'https://instagram.com/empresa' }), { about:'Aberto hoje', description:'Salão especializado', address:'Rua Central, 10', email:'contato@empresa.com.br', vertical:'BEAUTY', websites:['https://empresa.com.br','https://instagram.com/empresa'] });
  assert.throws(() => normalizeBusinessProfileInput({ email:'invalido' }), /E-mail inválido/);
  assert.throws(() => normalizeBusinessProfileInput({ website:'javascript:alert(1)' }), /http:\/\//);
  assert.throws(() => normalizeBusinessProfileInput({ description:'x'.repeat(257) }), /Descrição inválido/);
});

test("entrega ao estabelecimento apenas jornadas compatíveis com o segmento", () => {
  const flows = [
    { id: "100", name: "Agendamento padrão 20261104", status: "PUBLISHED", categories: ["APPOINTMENT_BOOKING"] },
    { id: "101", name: "Meus Agendamentos", status: "PUBLISHED", categories: ["APPOINTMENT_BOOKING"] },
    { id: "102", name: "Finalizar pedido 20261104", status: "PUBLISHED", categories: ["OTHER"] },
    { id: "103", name: "Rascunho interno", status: "DRAFT", categories: ["OTHER"] },
  ];
  const service = buildOwnerFlowCatalog({ flows, organizationName: "Studio Bela", segment: { screens: ["appointments", "services"] } });
  assert.deepEqual(service.map(item => item.key), ["booking", "my_appointments"]);
  assert.equal(service[0].previewMessage.includes("Studio Bela"), true);
  assert.equal("id" in service[0], false);
  const food = buildOwnerFlowCatalog({ flows, organizationName: "GR Lanches", segment: { screens: ["orders", "menu"] } });
  assert.deepEqual(food.map(item => item.key), ["order_checkout"]);
  const serviceWithoutDedicatedFlow = buildOwnerFlowCatalog({ flows: [flows[0]], segment: { screens: ["appointments"] }, bookingMenuConfig: { appointments_active: false } });
  assert.equal(serviceWithoutDedicatedFlow[1].available, true);
  assert.equal(serviceWithoutDedicatedFlow[1].active, false);
});

test("aceita apenas IDs seguros de documentos", () => {
  assert.equal(normalizeDocumentId("empresa_123", "inválido"), "empresa_123");
  assert.throws(() => normalizeDocumentId("empresa/123", "inválido"), /inválido/);
});

test("localiza o número autorizado dentro do WABA", () => {
  assert.equal(findPhoneNumber([{ id: "111" }, { id: "222" }], "222").id, "222");
  assert.equal(findPhoneNumber([], "222"), null);
});

test("consulta um Phone Number ID existente sem expor o token", async () => {
  let receivedUrl = "";
  let receivedParams = null;
  const axios = {
    get: async (url, options) => {
      receivedUrl = url;
      receivedParams = options.params;
      return { data: { id: "123456789012345", display_phone_number: "+55 11 99999-9999" } };
    },
  };
  const phone = await fetchMetaPhoneNumber({
    axios,
    graphVersion: "v24.0",
    accessToken: "segredo-no-servidor",
    phoneNumberId: "123456789012345",
  });
  assert.equal(phone.id, "123456789012345");
  assert.equal(receivedUrl, "https://graph.facebook.com/v24.0/123456789012345");
  assert.equal(receivedParams.access_token, "segredo-no-servidor");
});

test("confirma que o número pertence à WABA informada", async () => {
  const axios = {
    get: async (url, options) => {
      assert.equal(url, "https://graph.facebook.com/v24.0/2219889281911860/phone_numbers");
      assert.equal(options.headers.Authorization, "Bearer token-seguro");
      return { data: { data: [{ id: "1124719307396782", verified_name: "GRSYSTEM" }] } };
    },
  };
  const phone = await fetchWabaPhoneNumber({
    axios,
    graphVersion: "v24.0",
    accessToken: "token-seguro",
    wabaId: "2219889281911860",
    phoneNumberId: "1124719307396782",
  });
  assert.equal(phone.verified_name, "GRSYSTEM");
});

test("extrai texto dos formatos suportados", () => {
  assert.equal(extractMessageText({ type: "text", text: { body: "Olá" } }), "Olá");
  assert.equal(extractMessageText({ type: "interactive", interactive: { button_reply: { title: "Sim" } } }), "Sim");
});

test("reconhece pedidos explícitos de cancelamento de marketing", () => {
  assert.equal(isMarketingOptOut("SAIR"), true);
  assert.equal(isMarketingOptOut(" não quero receber! "), true);
  assert.equal(isMarketingOptOut("Quero agendar"), false);
  assert.equal(isMarketingOptOut("Quero sair às 18h"), false);
});

test("descobre a WABA pelo número mesmo com uma consulta de contas recusada", async () => {
  const axios = { get: async (url) => {
    if (url.endsWith("/1124719307396782")) return { data: { id: "1124719307396782" } };
    if (url.endsWith("/debug_token")) return { data: { data: {} } };
    if (url.endsWith("/owned_whatsapp_business_accounts")) throw { response: { status: 403, data: { error: { code: 200 } } } };
    if (url.endsWith("/client_whatsapp_business_accounts")) return { data: { data: [{ id: "1277143801075310" }] } };
    if (url.endsWith("/1277143801075310/phone_numbers")) return { data: { data: [{ id: "1124719307396782" }] } };
    throw new Error("Consulta inesperada");
  } };
  assert.equal(await resolveWabaIdForPhone({ axios, graphVersion: "v24.0", accessToken: "segredo", businessId: "12345", phoneNumberId: "1124719307396782" }), "1277143801075310");
});

test("informa a etapa e o código da Meta sem expor a credencial", async () => {
  const axios = { get: async (url) => {
    if (url.endsWith("/1124719307396782")) return { data: { id: "1124719307396782" } };
    if (url.endsWith("/debug_token")) return { data: { data: {} } };
    throw { response: { status: 403, data: { error: { code: 200, message: "segredo" } } } };
  } };
  await assert.rejects(resolveWabaIdForPhone({ axios, graphVersion: "v24.0", accessToken: "segredo", businessId: "12345", phoneNumberId: "1124719307396782" }), (error) => {
    assert.match(error.discoveryMessage, /owned_whatsapp_business_accounts: HTTP 403, código Meta 200/);
    assert.ok(!error.discoveryMessage.includes("segredo"));
    return true;
  });
});

test("carrega todas as páginas de Flows com autenticação no cabeçalho", async () => {
  let calls = 0;
  const axios = { get: async (url, options) => {
    assert.equal(url, "https://graph.facebook.com/v24.0/12345/flows");
    assert.equal(options.headers.Authorization, "Bearer token-servidor");
    calls++;
    if (calls === 1) return { data: { data: [{ id: "a" }], paging: { next: "https://graph.facebook.com/next", cursors: { after: "cursor2" } } } };
    assert.equal(options.params.after, "cursor2");
    return { data: { data: [{ id: "b" }] } };
  } };
  assert.deepEqual(await fetchAllMetaRows({ axios, graphVersion: "v24.0", accessToken: "token-servidor", path: "12345/flows", fields: "id" }), [{ id: "a" }, { id: "b" }]);
  assert.equal(calls, 2);
});

test("gera IDs determinísticos sem expor identificadores externos", () => {
  assert.equal(hashId("message:abc"), hashId("message:abc"));
  assert.match(hashId("message:abc"), /^[a-f0-9]{64}$/);
});

test("valida versão e comparação em tempo constante", () => {
  assert.equal(sanitizeGraphVersion("v24.0"), "v24.0");
  assert.equal(sanitizeGraphVersion("latest"), "v24.0");
  assert.equal(safeEqual("token", "token"), true);
  assert.equal(safeEqual("token", "outro"), false);
});

test("aceita somente estados oficiais de entrega", () => {
  assert.equal(normalizeMessageStatus("delivered"), "delivered");
  assert.equal(normalizeMessageStatus("READ"), "read");
  assert.equal(normalizeMessageStatus("inventado"), "");
});

test("carrinho usa o preço atual do cardápio e ignora o preço recebido", () => {
  const products = new Map([["PIZZA-G", {id: "pizza", name: "Pizza grande", price_cents: 4590, active: true, availability: "in stock"}]]);
  const result = validateCartItems([{product_retailer_id: "PIZZA-G", quantity: 2, item_price: 1}], products);
  assert.equal(result.valid, true);
  assert.equal(result.items[0].unit_price_cents, 4590);
  assert.equal(result.items[0].total_cents, 9180);
});

test("carrinho rejeita produto ausente, pausado ou sem estoque", () => {
  const source = [{product_retailer_id: "PIZZA-G", quantity: 1}];
  assert.equal(validateCartItems(source, new Map()).valid, false);
  assert.equal(validateCartItems(source, new Map([["PIZZA-G", {price_cents: 1000, active: false, availability: "in stock"}]])).valid, false);
  assert.equal(validateCartItems(source, new Map([["PIZZA-G", {price_cents: 1000, active: true, availability: "out of stock"}]])).valid, false);
});
