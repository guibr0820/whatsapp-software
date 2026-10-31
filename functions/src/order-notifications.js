const DEFAULT_ORDER_NOTIFICATIONS = [
  { id: "received", title: "Pedido recebido", summary: "Confirma que o pedido chegou.", mode: "automatic", enabled: true, message: "Recebemos seu pedido! Estamos conferindo os itens e já vamos confirmar." },
  { id: "confirmed", title: "Pedido confirmado", summary: "Avisa que o preparo vai começar.", mode: "automatic", enabled: true, message: "Pedido confirmado! Já vamos começar o preparo. 🍔" },
  { id: "preparing", title: "Em preparo", summary: "Mantém o cliente atualizado.", mode: "automatic", enabled: true, message: "Seu pedido está sendo preparado com carinho. Avisaremos quando estiver pronto." },
  { id: "ready_pickup", title: "Pronto para retirada", summary: "Libera a retirada no balcão.", mode: "automatic", enabled: false, message: "Seu pedido está pronto para retirada! Pode vir buscar. 😊" },
  { id: "out_for_delivery", title: "Saiu para entrega", summary: "Informa a saída do entregador.", mode: "manual", enabled: true, message: "Seu pedido saiu para entrega! Chega em cerca de {{tempo_entrega}} minutos. 🛵" },
  { id: "delivered", title: "Pedido entregue", summary: "Encerra a entrega com cordialidade.", mode: "manual", enabled: true, message: "Pedido entregue! Esperamos que aproveite. Obrigado pela preferência!" },
  { id: "cancelled", title: "Pedido cancelado", summary: "Comunica o cancelamento e o motivo.", mode: "manual", enabled: true, message: "Seu pedido foi cancelado. Motivo: {{motivo_cancelamento}}. Se precisar de ajuda, responda esta mensagem." },
];

function createOrderNotificationFunctions({ admin, db, onCall, HttpsError }) {
  const region = "southamerica-east1";

  const getOrderNotificationConfig = onCall({ region }, async request => {
    const { organizationId } = await authorize(request, false);
    const snapshot = await db.doc(`organizations/${organizationId}/automation_configs/order_notifications`).get();
    return { notifications: mergeNotifications(snapshot.data()?.notifications) };
  });

  const saveOrderNotificationConfig = onCall({ region }, async request => {
    const { organizationId, uid } = await authorize(request, true);
    const notifications = normalizeNotifications(request.data?.notifications, HttpsError);
    await db.doc(`organizations/${organizationId}/automation_configs/order_notifications`).set({
      notifications: Object.fromEntries(notifications.map(item => [item.id, { enabled: item.enabled }])),
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
      updated_by: uid,
    }, { merge: true });
    return { saved: true, notifications };
  });

  async function authorize(request, ownerOnly) {
    if (!request.auth) throw new HttpsError("unauthenticated", "Faça login para configurar as mensagens.");
    const organizationId = requiredId(request.data?.organizationId, HttpsError);
    const [organization, membership] = await Promise.all([
      db.doc(`organizations/${organizationId}`).get(),
      db.doc(`organizations/${organizationId}/members/${request.auth.uid}`).get(),
    ]);
    if (!organization.exists || !membership.exists || membership.data()?.status !== "active") throw new HttpsError("permission-denied", "Você não possui acesso a esta empresa.");
    if (ownerOnly && organization.data()?.proprietario_uid !== request.auth.uid) throw new HttpsError("permission-denied", "Somente o proprietário pode alterar essas mensagens.");
    return { organizationId, uid: request.auth.uid };
  }

  return { getOrderNotificationConfig, saveOrderNotificationConfig };
}

function mergeNotifications(stored = {}) {
  return DEFAULT_ORDER_NOTIFICATIONS.map(item => ({ ...item, enabled: stored[item.id]?.enabled ?? item.enabled }));
}

function normalizeNotifications(input, HttpsErrorClass = Error) {
  if (!Array.isArray(input)) throw new HttpsErrorClass("invalid-argument", "Configuração de mensagens inválida.");
  const validIds = new Set(DEFAULT_ORDER_NOTIFICATIONS.map(item => item.id));
  if (input.length !== validIds.size || input.some(item => !validIds.has(item?.id))) throw new HttpsErrorClass("invalid-argument", "Há uma mensagem inválida na configuração.");
  const unique = new Set(input.map(item => item.id));
  if (unique.size !== validIds.size) throw new HttpsErrorClass("invalid-argument", "Há mensagens repetidas na configuração.");
  return mergeNotifications(Object.fromEntries(input.map(item => [item.id, { enabled: item.enabled === true }])));
}

function requiredId(value, HttpsError) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new HttpsError("invalid-argument", "Empresa inválida.");
  return id;
}

module.exports = { createOrderNotificationFunctions, DEFAULT_ORDER_NOTIFICATIONS, mergeNotifications, normalizeNotifications };
