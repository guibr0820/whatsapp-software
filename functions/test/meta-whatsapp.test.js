const test = require("node:test");
const assert = require("node:assert/strict");
const {
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
} = require("../src/meta-whatsapp");

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
