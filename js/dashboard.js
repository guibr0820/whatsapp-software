import { onAuthStateChanged, signOut } from "firebase/auth";
import { collection, doc, getDoc, limit, limitToLast, onSnapshot, orderBy, query } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { auth } from "./auth.js";
import { app, db } from "./firebase-config.js";
import { startEmbeddedSignup, startCatalogAuthorization } from "./meta-whatsapp.js";
import { createAppointmentsUI } from './appointments.js';
import { createAutomationTabs } from './automation-tabs.js';
import { createPaymentsUI } from './payments.js';
import { createFoodBusinessUI } from './food-business.js';
import { installButtonProgress } from './ui-loading.js';
import { createOrderNotificationsUI } from './order-notifications.js';

installButtonProgress();

const shell = document.querySelector("#app-shell");
const loading = document.querySelector("#dashboard-loading");
const conversationShell = document.querySelector("#conversation-shell");
const conversationList = document.querySelector("#conversation-list");
const recentList = document.querySelector("#recent-conversations");
const messageList = document.querySelector("#message-list");
const searchInput = document.querySelector("#conversation-search");
const dialog = document.querySelector("#connection-dialog");
const dashboardViews = new Set(["overview", "appointments", "orders", "deliveries", "conversations", "services", "menu", "employees", "contacts", "payments", "automations"]);
let organizationId = "";
let conversations = [];
let selectedConversationId = "";
let selectedConversation = null;
let whatsAppConnected = false;
let whatsAppIntegration = null;
let currentFilter = "all";
let stopMessages = null;
const functions = getFunctions(app, "southamerica-east1");
const paymentsUI = createPaymentsUI({ organization: () => organizationId, call: (name, data) => httpsCallable(functions, name)(data) });
const foodUI = createFoodBusinessUI({ call: (name, data) => httpsCallable(functions, name)(data), showView: (name) => showView(name), callableMessage: (error) => callableMessage(error), startCatalogAuthorization });
const completeWhatsAppOnboarding = httpsCallable(functions, "completeWhatsAppOnboarding");
const lookupExistingWhatsAppPhoneNumber = httpsCallable(functions, "lookupExistingWhatsAppPhoneNumber");
const connectExistingWhatsAppPhoneNumber = httpsCallable(functions, "connectExistingWhatsAppPhoneNumber");
const disconnectWhatsApp = httpsCallable(functions, "disconnectWhatsApp");
const sendWhatsAppMessage = httpsCallable(functions, "sendWhatsAppMessage");
const sendWhatsAppFlow = httpsCallable(functions, "sendWhatsAppFlow");
const updateConversationState = httpsCallable(functions, "updateConversationState");
const listWhatsAppFlows = httpsCallable(functions, "listWhatsAppFlows");
const saveWhatsAppFlowConfig = httpsCallable(functions, "saveWhatsAppFlowConfig");
const createAppointmentFlow = httpsCallable(functions, "createAppointmentFlow");
const listCatalog = httpsCallable(functions, "listCatalog");
const saveCatalogItem = httpsCallable(functions, "saveCatalogItem");
const setCatalogItemActive = httpsCallable(functions, "setCatalogItemActive");
const getAppointmentReminderConfig = httpsCallable(functions, "getAppointmentReminderConfig");
const saveAppointmentReminderConfig = httpsCallable(functions, "saveAppointmentReminderConfig");
const getPlanUsage = httpsCallable(functions, "getPlanUsage");
const createCapacityPurchase = httpsCallable(functions, "createCapacityPurchase");
const getCapacityPurchase = httpsCallable(functions, "getCapacityPurchase");
const listCustomers = httpsCallable(functions, "listCustomers");
const listAvailableSegments = httpsCallable(functions, "listAvailableSegments");
const saveCustomer = httpsCallable(functions, "saveCustomer");
const deleteCustomer = httpsCallable(functions, "deleteCustomer");
let verifiedPhoneNumberId = "";
let verifiedWabaId = "";
let metaFlows = [];
let selectedFlow = null;
let editingSourceFlowId = "";
let catalog = { services: [], options: [], professionals: [] };
let activeCatalogTab = "service";
let professionalTimes = [];
let reminderLoaded = false;
let planUsage = null;
let capacityPurchaseId = "";
let capacityPollTimer = null;
let selectedCapacityPackage = null;
let customers = [];
let selectedCustomer = null;
let customersLoaded = false;
let foodBusiness = false;
let allowedViews = new Set(dashboardViews);
const automationTabs = createAutomationTabs();
const orderNotificationsUI = createOrderNotificationsUI({ organization: () => organizationId, call: (name, data) => httpsCallable(functions, name)(data), message: callableMessage });
const agendaUI = createAppointmentsUI({
  list: httpsCallable(functions,'listAppointments'),
  slots: httpsCallable(functions,'getAppointmentSlots'),
  update: httpsCallable(functions,'updateAppointment'),
  organization: () => organizationId,
  openConversation: async item => {
    let conversation = conversations.find(c => c.id === item.conversationId);
    if (!conversation && item.conversationId) {
      const snapshot = await getDoc(doc(db,'organizations',organizationId,'conversations',item.conversationId));
      if(snapshot.exists()) conversation={...snapshot.data(),id:snapshot.id};
    }
    showView('conversations');
    if(conversation) selectConversation(conversation);
  },
});

function initials(value) {
  return String(value || "CC").split(/\s+/).filter(Boolean).slice(0, 2).map((item) => item[0]).join("").toUpperCase();
}

function timestampDate(value) {
  if (value?.toDate) return value.toDate();
  if (value instanceof Date) return value;
  return value ? new Date(value) : null;
}

function isToday(value) {
  const date = timestampDate(value);
  if (!date || Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
}

function shortTime(value) {
  const date = timestampDate(value);
  if (!date || Number.isNaN(date.getTime())) return "";
  if (isToday(date)) return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(date);
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" }).format(date);
}

function fullTime(value) {
  const date = timestampDate(value);
  if (!date || Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function conversationName(item) {
  return item.contact_name || item.profile_name || item.contact_phone || "Novo contato";
}

function updateMetrics() {
  const realConversations = conversations.filter((item) => !item.is_demo);
  const unread = realConversations.reduce((total, item) => total + Math.max(0, Number(item.unread_count) || 0), 0);
  document.querySelector("#metric-waiting").textContent = realConversations.filter((item) => item.human_support && item.status !== 'closed').length;
  document.querySelector('.setup-panel').hidden = whatsAppConnected && realConversations.length > 0;
  const unreadBadge = document.querySelector("#sidebar-unread");
  unreadBadge.textContent = unread > 99 ? "99+" : String(unread);
  unreadBadge.hidden = unread === 0;
}

function filteredConversations() {
  const term = searchInput.value.trim().toLocaleLowerCase("pt-BR");
  return conversations.filter((item) => {
    const matchesTerm = !term || `${conversationName(item)} ${item.contact_phone || ""} ${item.last_message || ""}`.toLocaleLowerCase("pt-BR").includes(term);
    const matchesFilter = currentFilter === "all"
      || (currentFilter === "unread" && Number(item.unread_count) > 0)
      || (currentFilter === "waiting" && item.status === "waiting");
    return matchesTerm && matchesFilter;
  });
}

function renderConversationList() {
  const items = filteredConversations();
  conversationList.replaceChildren();
  if (!items.length) {
    const empty = createElement("div", "inbox-empty");
    const connectedEmpty = !conversations.length && whatsAppConnected;
    empty.classList.toggle("connected", connectedEmpty);
    empty.append(
      createElement("span", "", connectedEmpty ? "✓" : "◌"),
      createElement("strong", "", conversations.length ? "Nenhuma conversa encontrada" : (connectedEmpty ? "WhatsApp conectado" : "Sua caixa está vazia")),
      createElement("p", "", conversations.length ? "Tente outro termo ou filtro." : (connectedEmpty ? "Aguardando a primeira mensagem para abrir sua caixa de entrada." : "Conecte o WhatsApp para começar a receber conversas."))
    );
    if (!conversations.length && !whatsAppConnected) {
      const button = createElement("button", "primary-action", "Conectar WhatsApp");
      button.type = "button";
      button.addEventListener("click", openConnectionDialog);
      empty.append(button);
    } else if (!conversations.length && whatsAppConnected) {
      const button = createElement("button", "secondary-action", "Visualizar conversa de teste");
      button.type = "button";
      button.addEventListener("click", openDemoConversation);
      empty.append(button);
    }
    conversationList.append(empty);
    return;
  }

  for (const item of items) {
    const button = createElement("button", `conversation-item${item.id === selectedConversationId ? " active" : ""}`);
    button.type = "button";
    const avatar = createElement("span", "contact-avatar", initials(conversationName(item)));
    const main = createElement("span", "conversation-item-main");
    main.append(createElement("strong", "", conversationName(item)), createElement("span", "", item.last_message || "Nova conversa"));
    const meta = createElement("span", "conversation-item-meta");
    meta.append(createElement("time", "", shortTime(item.last_message_at)));
    if (Number(item.unread_count) > 0) meta.append(createElement("span", "unread-badge", Number(item.unread_count) > 99 ? "99+" : String(item.unread_count)));
    button.append(avatar, main, meta);
    button.addEventListener("click", () => selectConversation(item));
    conversationList.append(button);
  }
}

function renderEmptyChat() {
  if (selectedConversationId) return;
  const empty = document.querySelector("#chat-empty");
  empty.replaceChildren();
  if (!whatsAppConnected) {
    empty.append(
      createElement("div", "chat-empty-icon", "◌"),
      createElement("h3", "", "Conecte seu WhatsApp"),
      createElement("p", "", "Depois da conexão, as mensagens dos clientes aparecerão aqui em tempo real.")
    );
    return;
  }

  empty.append(
    createElement("div", "chat-empty-icon ready", "✓"),
    createElement("h3", "", "Tudo pronto para receber"),
    createElement("p", "", "Envie uma mensagem de outro WhatsApp para o número conectado. A conversa aparecerá aqui automaticamente.")
  );
  const readiness = createElement("div", "chat-ready-list");
  ["Webhook ativo", "Respostas pelo painel prontas", "Entrega e leitura automáticas"].forEach((label) => {
    const item = createElement("span");
    item.append(createElement("i", "", "✓"), document.createTextNode(label));
    readiness.append(item);
  });
  empty.append(readiness);
  const preview = createElement("button", "secondary-action demo-preview-action", "Visualizar conversa de teste");
  preview.type = "button";
  preview.addEventListener("click", openDemoConversation);
  empty.append(preview);
}

function openDemoConversation() {
  const demo = {
    id: "demo-preview",
    is_demo: true,
    contact_name: "Mariana Souza",
    contact_phone: "+55 11 99999-0000",
    customer_type: "Cliente de demonstração",
    status: "waiting",
    unread_count: 1,
    last_message: "Olá! Tem horário para fazer as unhas amanhã?",
    last_message_at: new Date(),
  };
  conversations = [demo, ...conversations.filter((item) => !item.is_demo)];
  selectConversation(demo);
}

function renderDemoMessages() {
  const messages = [
    { direction: "inbound", text: "Olá! Tem horário para fazer as unhas amanhã?", time: "13:42" },
    { direction: "outbound", text: "Olá, Mariana! Temos sim 😊 Você prefere pela manhã ou à tarde?", time: "13:43", status: "read" },
    { direction: "inbound", text: "À tarde seria perfeito. Pode ser depois das 15h?", time: "13:44" },
  ];
  messageList.replaceChildren();
  const notice = createElement("div", "demo-notice", "Modo demonstração — nenhuma mensagem será enviada ou salva.");
  messageList.append(notice);
  messages.forEach((message) => {
    const bubble = createElement("div", `message${message.direction === "outbound" ? " outbound" : ""}`, message.text);
    const meta = createElement("span", "message-meta");
    meta.append(createElement("time", "", message.time));
    if (message.status) meta.append(createElement("small", `message-status ${message.status}`, messageStatusLabel(message.status)));
    bubble.append(meta);
    messageList.append(bubble);
  });
}

function renderRecent() {
  recentList.replaceChildren();
  const attention = conversations.filter(item => !item.is_demo && item.status !== 'closed' && (item.human_support || Number(item.unread_count)>0));
  if (!attention.length) {
    const empty = createElement("div", "empty-compact");
    empty.append(createElement("strong", "", "Tudo em dia por aqui"), createElement("span", "", "Pedidos de atendimento e mensagens não lidas aparecem aqui."));
    recentList.append(empty);
    return;
  }
  for (const item of attention.slice(0, 5)) {
    const row = createElement("div", "recent-item");
    row.tabIndex = 0;
    row.append(createElement("span", "contact-avatar", initials(conversationName(item))));
    const content = createElement("div");
    content.append(createElement("strong", "", conversationName(item)), createElement("span", "", item.last_message || "Nova conversa"));
    row.append(content, createElement("time", "", shortTime(item.last_message_at)));
    const open = () => { showView("conversations"); selectConversation(item); };
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") open(); });
    recentList.append(row);
  }
}

function statusLabel(status) {
  return { open: "Em atendimento", waiting: "Aguardando resposta", closed: "Finalizada" }[status] || "Nova conversa";
}

function messageStatusLabel(status) {
  return { pending: "Enviando", sent: "Enviada", delivered: "Entregue", read: "Lida", failed: "Falhou" }[status] || "";
}

function syncComposer() {
  const input = document.querySelector("#message-input");
  const send = document.querySelector("#composer .send-button");
  const flow = document.querySelector("#send-flow-open");
  const enabled = whatsAppConnected && Boolean(selectedConversationId) && !selectedConversation?.is_demo;
  input.disabled = !enabled;
  send.disabled = !enabled;
  flow.disabled = !enabled;
  input.placeholder = selectedConversation?.is_demo ? "Modo demonstração — envio desativado" : (whatsAppConnected ? "Digite sua resposta" : "Conecte o WhatsApp para responder");
}

async function openSendFlowDialog() {
  if (!selectedConversationId) return;
  if (!metaFlows.length) await loadFlows();
  const select = document.querySelector("#send-flow-select");
  const available = metaFlows.filter((flow) => flow.status === "PUBLISHED" && flow.config?.active === true);
  select.replaceChildren();
  available.forEach((flow) => { const option = document.createElement("option"); option.value = flow.id; option.textContent = flow.name || "Flow de agendamento"; select.append(option); });
  if (!available.length) { const option = document.createElement("option"); option.value = ""; option.textContent = "Nenhum Flow ativo"; select.append(option); }
  document.querySelector("#send-flow-feedback").hidden = true;
  document.querySelector("#send-flow-dialog").showModal();
}

async function submitSendFlow(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]'); const feedback = document.querySelector("#send-flow-feedback"); const flowId = document.querySelector("#send-flow-select").value;
  if (!flowId) return;
  button.disabled = true; button.textContent = "Enviando…"; feedback.hidden = true;
  try { await sendWhatsAppFlow({ organizationId, conversationId: selectedConversationId, flowId }); feedback.textContent = "Flow enviado. Preencha-o no WhatsApp para confirmar o agendamento."; feedback.hidden = false; }
  catch (error) { feedback.textContent = callableMessage(error); feedback.hidden = false; }
  finally { button.disabled = false; button.textContent = "Enviar Flow"; }
}

function syncConversationHeader(item) {
  if (!item) return;
  document.querySelector("#chat-status").textContent = item.is_demo ? "Demonstração" : statusLabel(item.status);
  document.querySelector("#conversation-status").value = ["open", "waiting", "closed"].includes(item.status) ? item.status : "waiting";
  document.querySelector("#conversation-status").disabled = Boolean(item.is_demo);
}

function syncCustomerPanel(item) {
  if (!item) return;
  const name = conversationName(item);
  document.querySelector("#customer-avatar").textContent = initials(name);
  document.querySelector("#customer-name").textContent = name;
  document.querySelector("#customer-kind").textContent = item.customer_type || "Cliente do WhatsApp";
  document.querySelector("#customer-phone").textContent = item.contact_phone || "Não informado";
  document.querySelector("#customer-last-contact").textContent = shortTime(item.last_message_at) || "Agora";
  document.querySelector("#customer-conversation-status").textContent = statusLabel(item.status);
  document.querySelector("#customer-state").textContent = Number(item.unread_count) > 0 ? "Nova mensagem" : statusLabel(item.status);
}

function toggleCustomerPanel(open) {
  const panel = document.querySelector("#customer-panel");
  panel.hidden = !selectedConversationId;
  conversationShell.classList.toggle("details-open", Boolean(open && selectedConversationId));
  document.querySelector("#customer-panel-toggle").setAttribute("aria-expanded", String(Boolean(open && selectedConversationId)));
}

function selectConversation(item) {
  selectedConversationId = item.id;
  selectedConversation = item;
  renderConversationList();
  conversationShell.classList.add("has-selection");
  document.querySelector("#chat-empty").hidden = true;
  document.querySelector("#chat-header").hidden = false;
  document.querySelector("#composer").hidden = false;
  messageList.hidden = false;
  document.querySelector("#chat-avatar").textContent = initials(conversationName(item));
  document.querySelector("#chat-name").textContent = conversationName(item);
  document.querySelector("#chat-phone").textContent = item.contact_phone || "WhatsApp";
  syncConversationHeader(item);
  syncCustomerPanel(item);
  syncComposer();
  document.querySelector("#customer-panel").hidden = false;
  if (item.is_demo) {
    stopMessages?.();
    stopMessages = null;
    renderDemoMessages();
    return;
  }
  updateConversationState({ organizationId, conversationId: item.id, markRead: true }).catch((error) => console.error(error));
  messageList.replaceChildren(createElement("div", "chat-empty", "Carregando mensagens…"));
  stopMessages?.();
  const messagesQuery = query(collection(db, "organizations", organizationId, "conversations", item.id, "messages"), orderBy("sent_at", "asc"), limitToLast(100));
  stopMessages = onSnapshot(messagesQuery, (snapshot) => {
    messageList.replaceChildren();
    if (snapshot.empty) {
      const empty = createElement("div", "chat-empty");
      empty.append(createElement("h3", "", "Ainda não há mensagens"), createElement("p", "", "O histórico aparecerá aqui assim que o webhook receber a primeira mensagem."));
      messageList.append(empty);
      return;
    }
    snapshot.forEach((messageDocument) => {
      const message = messageDocument.data();
      const bubble = createElement("div", `message${message.direction === "outbound" ? " outbound" : ""}`, message.text || message.caption || `[${message.type || "mensagem"}]`);
      const meta = createElement("span", "message-meta");
      meta.append(createElement("time", "", fullTime(message.sent_at)));
      if (message.direction === "outbound") meta.append(createElement("small", `message-status ${message.status || "pending"}`, messageStatusLabel(message.status)));
      bubble.append(meta);
      messageList.append(bubble);
    });
    messageList.scrollTop = messageList.scrollHeight;
  }, (error) => {
    console.error(error);
    messageList.replaceChildren(createElement("div", "chat-empty", "Não foi possível carregar as mensagens."));
  });
}

function viewFromLocation() {
  const viewName = window.location.hash.replace(/^#/, "").split("/")[0];
  return dashboardViews.has(viewName) ? viewName : "overview";
}

function rememberView(viewName) {
  const url = new URL(window.location.href);
  url.hash = viewName;
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function showView(viewName, { remember = true } = {}) {
  if (foodBusiness && viewName === "appointments") viewName = "orders";
  if (foodBusiness && viewName === "services") viewName = "menu";
  if (foodBusiness && viewName === "employees") viewName = "overview";
  if (!dashboardViews.has(viewName) || !allowedViews.has(viewName)) viewName = "overview";
  document.querySelectorAll(".dashboard-view").forEach((view) => view.classList.toggle("active", view.id === `view-${viewName}`));
  document.querySelectorAll(".nav-item[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === viewName));
  const titles = { overview: "Visão geral", appointments: 'Agendamentos', orders: "Pedidos", deliveries: "Entregas", conversations: "Conversas", services: "Serviços", menu: "Cardápio", employees: "Funcionários", contacts: "Clientes", payments: 'Pagamentos', automations: "Automações" };
  document.querySelector("#page-title").textContent = titles[viewName] || "Visão geral";
  shell.classList.remove("menu-open");
  if (remember) rememberView(viewName);
  if (viewName === 'payments') paymentsUI.load();
  if(viewName === 'appointments' || viewName === 'overview') agendaUI.refresh();
  if (viewName === "automations") {
    if (!metaFlows.length) loadFlows();
    if (!reminderLoaded) loadReminderConfig();
    loadPlanUsage();
    orderNotificationsUI.load();
  }
  if (viewName === "services" && !catalog.services.length && !catalog.options.length && !catalog.professionals.length) loadCatalog();
  if (viewName === "employees" && !catalog.services.length && !catalog.options.length && !catalog.professionals.length) loadCatalog();
  if (viewName === "contacts" && !customersLoaded) loadCustomers();
  foodUI.onView(viewName);
}

function applySegmentNavigation(segment) {
  const screens = Array.isArray(segment?.screens) && segment.screens.length ? segment.screens : [...dashboardViews];
  allowedViews = new Set(["overview", ...screens]);
  document.querySelectorAll(".nav-item[data-view]").forEach(button => {
    const enabled = allowedViews.has(button.dataset.view);
    button.hidden = !enabled;
    button.disabled = !enabled;
  });
  document.querySelectorAll('[data-view]:not(.nav-item)').forEach(button => {
    if (!allowedViews.has(button.dataset.view)) button.hidden = true;
  });
}

function catalogArray(type = activeCatalogTab) {
  return catalog[type === "service" ? "services" : type === "option" ? "options" : "professionals"] || [];
}

function money(value) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value) || 0);
}

function customerStatusLabel(customer) {
  if (customer.status === "inactive") return "Inativo";
  if (customer.status === "new" || Number(customer.appointments_count) === 0) return "Novo";
  return "Ativo";
}

function customerStatusClass(customer) {
  if (customer.status === "inactive") return "inactive";
  if (customer.status === "new" || Number(customer.appointments_count) === 0) return "new";
  return "active";
}

function formatCustomerPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  const local = digits.startsWith("55") ? digits.slice(2) : digits;
  if (local.length === 11) return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
  if (local.length === 10) return `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
  return value || "Não informado";
}

function customerDate(value, withTime = false) {
  if (!value) return "—";
  let date;
  if (typeof value === "string") date = new Date(value);
  else if (typeof value?._seconds === "number") date = new Date(value._seconds * 1000);
  else if (typeof value?.seconds === "number") date = new Date(value.seconds * 1000);
  else date = timestampDate(value);
  if (!date || Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", withTime
    ? { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }
    : { day: "2-digit", month: "short", year: "numeric" }).format(date);
}

function customerIcons() {
  return {
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>',
    delete: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>',
  };
}

async function loadCustomers({ force = false } = {}) {
  if (!organizationId || (customersLoaded && !force)) return;
  const list = document.querySelector("#customers-list");
  list.innerHTML = '<div class="customers-empty"><strong>Carregando clientes…</strong><span>Reunindo cadastros, conversas e agendamentos.</span></div>';
  const feedback = document.querySelector("#customers-feedback");
  feedback.hidden = true;
  try {
    const response = await listCustomers({ organizationId });
    customers = response.data?.customers || [];
    customersLoaded = true;
    renderCustomers();
  } catch (error) {
    customersLoaded = false;
    list.innerHTML = `<div class="customers-empty"><strong>Não foi possível carregar os clientes</strong><span>${escapeText(callableMessage(error))}</span></div>`;
  }
}

function filteredCustomers() {
  const term = document.querySelector("#customer-search").value.trim().toLocaleLowerCase("pt-BR");
  const filter = document.querySelector("#customer-status-filter").value;
  return customers.filter((customer) => {
    const haystack = `${customer.name || ""} ${customer.phone || ""} ${customer.email || ""} ${(customer.tags || []).join(" ")}`.toLocaleLowerCase("pt-BR");
    const matchesTerm = !term || haystack.includes(term);
    const matchesFilter = filter === "all"
      || (filter === "scheduled" && customer.next_appointment)
      || (filter === "new" && (customer.status === "new" || Number(customer.appointments_count) === 0))
      || (filter === "active" && customer.status !== "inactive" && Number(customer.appointments_count) > 0)
      || (filter === "inactive" && customer.status === "inactive");
    return matchesTerm && matchesFilter;
  });
}

function renderCustomers() {
  document.querySelector("#customers-total").textContent = String(customers.filter((item) => item.status !== "inactive").length);
  document.querySelector("#customers-scheduled").textContent = String(customers.filter((item) => item.next_appointment).length);
  document.querySelector("#customers-recurring").textContent = String(customers.filter((item) => Number(item.appointments_count) >= 2).length);
  document.querySelector("#customers-new").textContent = String(customers.filter((item) => Number(item.appointments_count) === 0).length);
  const list = document.querySelector("#customers-list");
  const items = filteredCustomers();
  list.replaceChildren();
  if (!items.length) {
    const empty = createElement("div", "customers-empty");
    empty.append(createElement("strong", "", customers.length ? "Nenhum cliente encontrado" : "Sua carteira ainda está vazia"), createElement("span", "", customers.length ? "Tente outro termo ou filtro." : "Cadastre um cliente ou aguarde a primeira conversa pelo WhatsApp."));
    list.append(empty);
    return;
  }
  const head = createElement("div", "customers-list-head");
  ["Cliente", "WhatsApp", "Próximo agendamento", "Situação", "Ações"].forEach((label) => head.append(createElement("span", "", label)));
  list.append(head);
  const icons = customerIcons();
  for (const customer of items) {
    const row = createElement("article", "customer-list-item");
    const main = createElement("div", "customer-main");
    const open = createElement("button");
    open.type = "button";
    open.append(createElement("strong", "", customer.name || "Cliente"), createElement("small", "", customer.email || (customer.source === "whatsapp" ? "Chegou pelo WhatsApp" : "Cadastro manual")));
    open.addEventListener("click", () => openCustomerDetail(customer));
    main.append(createElement("span", "customer-list-avatar", initials(customer.name)), open);
    const phone = createElement("span", "", formatCustomerPhone(customer.phone));
    const next = createElement("div", "customer-next");
    if (customer.next_appointment) next.append(createElement("strong", "", customerDate(customer.next_appointment.at, true)), createElement("small", "", customer.next_appointment.service || "Atendimento"));
    else next.append(createElement("strong", "", "Nenhum agendamento"), createElement("small", "", `${Number(customer.appointments_count) || 0} no histórico`));
    const status = createElement("span", `customer-status ${customerStatusClass(customer)}`, customerStatusLabel(customer));
    const actions = createElement("div", "customer-actions");
    const edit = createElement("button", "customer-icon-action");
    edit.type = "button"; edit.title = "Editar cliente"; edit.setAttribute("aria-label", `Editar ${customer.name || "cliente"}`); edit.innerHTML = icons.edit;
    edit.addEventListener("click", () => openCustomerForm(customer));
    const remove = createElement("button", "customer-icon-action delete");
    remove.type = "button"; remove.title = "Excluir cliente"; remove.setAttribute("aria-label", `Excluir ${customer.name || "cliente"}`); remove.innerHTML = icons.delete;
    remove.addEventListener("click", () => removeCustomer(customer, remove));
    actions.append(edit, remove);
    row.append(main, phone, next, status, actions);
    list.append(row);
  }
}

function openCustomerForm(customer = null) {
  selectedCustomer = customer;
  document.querySelector("#customer-dialog-title").textContent = customer ? "Editar cliente" : "Novo cliente";
  document.querySelector("#customer-id").value = customer?.id || "";
  document.querySelector("#customer-form-name").value = customer?.name || "";
  document.querySelector("#customer-form-phone").value = customer ? formatCustomerPhone(customer.phone) : "";
  document.querySelector("#customer-form-email").value = customer?.email || "";
  document.querySelector("#customer-form-status").value = customer?.status || "active";
  document.querySelector("#customer-form-tags").value = (customer?.tags || []).join(", ");
  document.querySelector("#customer-form-notes").value = customer?.notes || "";
  document.querySelector("#customer-form-feedback").hidden = true;
  document.querySelector("#customer-dialog").showModal();
  document.querySelector("#customer-form-name").focus();
}

async function submitCustomerForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const feedback = document.querySelector("#customer-form-feedback");
  const button = form.querySelector("button[type=submit]");
  button.disabled = true; button.textContent = "Salvando…"; feedback.hidden = true;
  try {
    await saveCustomer({
      organizationId,
      id: document.querySelector("#customer-id").value,
      customer: {
        name: document.querySelector("#customer-form-name").value,
        phone: document.querySelector("#customer-form-phone").value,
        email: document.querySelector("#customer-form-email").value,
        status: document.querySelector("#customer-form-status").value,
        tags: document.querySelector("#customer-form-tags").value.split(",").map((item) => item.trim()).filter(Boolean),
        notes: document.querySelector("#customer-form-notes").value,
      },
    });
    document.querySelector("#customer-dialog").close();
    customersLoaded = false;
    await loadCustomers({ force: true });
  } catch (error) {
    feedback.textContent = callableMessage(error); feedback.hidden = false;
  } finally {
    button.disabled = false; button.textContent = "Salvar cliente";
  }
}

async function removeCustomer(customer, button) {
  if (!window.confirm(`Excluir o cadastro de ${customer.name || "cliente"}? Conversas e agendamentos serão preservados.`)) return;
  button.disabled = true;
  try {
    await deleteCustomer({ organizationId, phone: customer.phone });
    customers = customers.filter((item) => item.phone !== customer.phone);
    renderCustomers();
  } catch (error) {
    const feedback = document.querySelector("#customers-feedback");
    feedback.textContent = callableMessage(error); feedback.hidden = false;
    button.disabled = false;
  }
}

function openCustomerDetail(customer) {
  selectedCustomer = customer;
  const content = document.querySelector("#customer-detail-content");
  content.replaceChildren();
  const hero = createElement("div", "customer-detail-hero");
  const copy = createElement("div");
  copy.append(createElement("h2", "", customer.name || "Cliente"), createElement("p", "", `${formatCustomerPhone(customer.phone)}${customer.email ? ` · ${customer.email}` : ""}`));
  hero.append(createElement("span", "customer-list-avatar", initials(customer.name)), copy);
  content.append(hero);
  if ((customer.tags || []).length) {
    const tags = createElement("div", "customer-detail-tags");
    customer.tags.forEach((tag) => tags.append(createElement("span", "", tag)));
    content.append(tags);
  }
  const grid = createElement("div", "customer-detail-grid");
  const cards = [
    ["Situação", customerStatusLabel(customer), customer.source === "whatsapp" ? "Contato do WhatsApp" : "Cadastro manual"],
    ["Agendamentos", String(Number(customer.appointments_count) || 0), `${Number(customer.completed_count) || 0} concluídos`],
    ["Próximo atendimento", customer.next_appointment ? customerDate(customer.next_appointment.at, true) : "Nenhum", customer.next_appointment?.service || "Sem reserva futura"],
    ["Faltas e cancelamentos", String((Number(customer.no_show_count) || 0) + (Number(customer.cancelled_count) || 0)), `${Number(customer.no_show_count) || 0} faltas · ${Number(customer.cancelled_count) || 0} cancelados`],
  ];
  cards.forEach(([label, value, detail]) => { const card = createElement("article"); card.append(createElement("span", "", label), createElement("strong", "", value), createElement("small", "", detail)); grid.append(card); });
  content.append(grid);
  const notes = createElement("div", "customer-detail-notes");
  notes.append(createElement("span", "", "OBSERVAÇÕES INTERNAS"), createElement("p", "", customer.notes || "Nenhuma observação cadastrada."));
  content.append(notes);
  const conversationButton = document.querySelector("#customer-detail-conversation");
  conversationButton.hidden = !customer.conversation_id;
  document.querySelector("#customer-detail-dialog").showModal();
}

async function openCustomerConversation() {
  if (!selectedCustomer?.conversation_id) return;
  let conversation = conversations.find((item) => item.id === selectedCustomer.conversation_id);
  if (!conversation) {
    const snapshot = await getDoc(doc(db, "organizations", organizationId, "conversations", selectedCustomer.conversation_id));
    if (snapshot.exists()) conversation = { id: snapshot.id, ...snapshot.data() };
  }
  if (!conversation) return;
  document.querySelector("#customer-detail-dialog").close();
  showView("conversations");
  selectConversation(conversation);
}

async function loadCatalog() {
  const grid = document.querySelector("#catalog-grid");
  if (grid) grid.innerHTML = '<div class="catalog-empty"><strong>Carregando catálogo…</strong><span>Aguarde um instante.</span></div>';
  try {
    const response = await listCatalog({ organizationId });
    catalog = {
      services: response.data?.services || [],
      options: response.data?.options || [],
      professionals: response.data?.professionals || [],
    };
    renderCatalog();
    renderEmployees();
    renderCatalogChoices();
  } catch (error) {
    if (grid) grid.innerHTML = `<div class="catalog-empty"><strong>Não foi possível carregar</strong><span>${escapeText(callableMessage(error))}</span></div>`;
  }
}

function escapeText(value) {
  const element = document.createElement("span");
  element.textContent = String(value || "");
  return element.innerHTML;
}

function renderCatalog() {
  document.querySelector("#services-count").textContent = String(catalog.services.length);
  document.querySelector("#options-count").textContent = String(catalog.options.length);
  const grid = document.querySelector("#catalog-grid");
  const search = document.querySelector("#catalog-search").value.trim().toLocaleLowerCase("pt-BR");
  const status = document.querySelector("#catalog-status").value;
  const items = catalogArray().filter((item) => {
    const matchesSearch = !search || `${item.name || ""} ${item.description || ""} ${item.specialty || ""}`.toLocaleLowerCase("pt-BR").includes(search);
    const matchesStatus = status === "all" || (status === "active" ? item.active !== false : item.active === false);
    return matchesSearch && matchesStatus;
  });
  grid.replaceChildren();
  if (!items.length) {
    const empty = createElement("div", "catalog-empty");
    empty.append(createElement("strong", "", "Nenhum cadastro encontrado"), createElement("span", "", "Use o botão acima para adicionar o primeiro item."));
    grid.append(empty);
    return;
  }
  items.forEach((item) => {
    const card = createElement("article", `catalog-card${item.active === false ? " inactive" : ""}`);
    const head = createElement("div", "catalog-card-head");
    const title = createElement("div");
    title.append(createElement("strong", "", item.name), createElement("small", "", item.active === false ? "Inativo" : "Ativo no agendamento"));
    const kind = activeCatalogTab === "service" ? "Serviço" : activeCatalogTab === "option" ? "Adicional" : "Profissional";
    head.append(title, createElement("span", "catalog-kind", kind));
    const description = item.description || item.specialty || (activeCatalogTab === "professional" ? "Profissional da equipe" : "Sem descrição");
    const meta = createElement("div", "catalog-meta");
    if (activeCatalogTab !== "professional") meta.append(createElement("span", "", money(item.price)), createElement("span", "", `${item.duration_minutes || 0} min`));
    else meta.append(createElement("span", "", `${item.work_start || "—"}–${item.work_end || "—"}`), createElement("span", "", `${item.service_ids?.length || 0} serviço(s)`));
    const actions = createElement("div", "catalog-card-actions");
    const edit = createElement("button", "", "Editar"); edit.type = "button"; edit.addEventListener("click", () => openCatalogDialog(activeCatalogTab, item));
    const toggle = createElement("button", "", item.active === false ? "Ativar" : "Desativar"); toggle.type = "button"; toggle.addEventListener("click", () => toggleCatalogItem(item));
    actions.append(edit, toggle);
    card.append(head, createElement("p", "", description), meta, actions);
    grid.append(card);
  });
}

function employeeStatusLabel(value, active = true) {
  if (!active) return "Inativo";
  return { available: "Disponível", busy: "Atendendo", paused: "Em pausa", unavailable: "Indisponível" }[value] || "Disponível";
}

function renderEmployees() {
  const employees = catalog.professionals;
  document.querySelector("#employees-total").textContent = String(employees.length);
  document.querySelector("#employees-active").textContent = String(employees.filter((item) => item.active !== false).length);
  document.querySelector("#employees-available").textContent = String(employees.filter((item) => item.active !== false && item.status === "available").length);
  document.querySelector("#employees-busy").textContent = String(employees.filter((item) => item.active !== false && item.status === "busy").length);
  const search = document.querySelector("#employee-search").value.trim().toLocaleLowerCase("pt-BR");
  const status = document.querySelector("#employee-status-filter").value;
  const items = employees.filter((item) => {
    const matchesSearch = !search || `${item.name || ""} ${item.specialty || ""}`.toLocaleLowerCase("pt-BR").includes(search);
    const matchesStatus = status === "all" || (status === "inactive" ? item.active === false : item.active !== false && (item.status || "available") === status);
    return matchesSearch && matchesStatus;
  });
  const grid = document.querySelector("#employee-grid");
  grid.replaceChildren();
  if (!items.length) {
    const empty = createElement("div", "catalog-empty");
    empty.append(createElement("strong", "", "Nenhum funcionário encontrado"), createElement("span", "", "Cadastre sua equipe para gerar a disponibilidade do Flow."));
    grid.append(empty); return;
  }
  items.forEach((item) => {
    const card = createElement("article", `catalog-card${item.active === false ? " inactive" : ""}`);
    const head = createElement("div", "catalog-card-head");
    const titleWrap = createElement("div", "employee-card-title");
    const avatar = createElement("span", "employee-card-avatar", initials(item.name));
    if (item.image_url) { const image = document.createElement("img"); image.src = item.image_url; image.alt = ""; image.addEventListener("error", () => image.remove()); avatar.append(image); }
    const title = createElement("div"); title.append(createElement("strong", "", item.name), createElement("small", "", employeeStatusLabel(item.status, item.active !== false)));
    titleWrap.append(avatar, title); head.append(titleWrap, createElement("span", "catalog-kind", "Funcionário"));
    const meta = createElement("div", "catalog-meta");
    meta.append(createElement("span", "", `${item.work_start || "—"}–${item.work_end || "—"}`), createElement("span", "", `${item.interval_minutes || 30} min`), createElement("span", "", `${item.service_ids?.length || 0} serviço(s)`));
    const actions = createElement("div", "catalog-card-actions");
    const edit = createElement("button", "", "Editar"); edit.type = "button"; edit.addEventListener("click", () => openCatalogDialog("professional", item));
    const toggle = createElement("button", "", item.active === false ? "Ativar" : "Desativar"); toggle.type = "button"; toggle.addEventListener("click", () => toggleCatalogItem(item, "professional"));
    actions.append(edit, toggle); card.append(head, createElement("p", "", item.specialty || "Profissional da equipe"), meta, actions); grid.append(card);
  });
}

function renderChoiceList(containerId, items, selectedIds = []) {
  const container = document.querySelector(`#${containerId}`);
  container.replaceChildren();
  const activeItems = items.filter((item) => item.active !== false);
  if (!activeItems.length) {
    container.append(createElement("span", "booking-choice-empty", "Nenhum cadastro ativo. Cadastre-o primeiro na aba Serviços."));
    return;
  }
  activeItems.forEach((item) => {
    const label = document.createElement("label");
    const input = document.createElement("input"); input.type = "checkbox"; input.value = item.id; input.checked = selectedIds.includes(item.id);
    label.append(input, document.createTextNode(item.name));
    container.append(label);
  });
}

function renderCatalogChoices() {
  renderChoiceList("professional-services", catalog.services);
  renderChoiceList("option-services", catalog.services);
}

function openCatalogDialog(type = activeCatalogTab, item = null) {
  const dialog = document.querySelector("#catalog-dialog");
  const isProfessional = type === "professional";
  const isOption = type === "option";
  document.querySelector("#catalog-item-id").value = item?.id || "";
  document.querySelector("#catalog-item-type").value = type;
  document.querySelector("#catalog-name").value = item?.name || "";
  document.querySelector("#catalog-description").value = item?.description || "";
  document.querySelector("#catalog-price").value = String(item?.price ?? 0);
  document.querySelector("#catalog-duration").value = String(item?.duration_minutes ?? 30);
  document.querySelector("#catalog-specialty").value = item?.specialty || "";
  document.querySelector("#employee-image").value = item?.image_url || "";
  document.querySelector("#catalog-active").checked = item?.active !== false;
  document.querySelector("#catalog-service-fields").hidden = isProfessional;
  document.querySelector("#catalog-professional-fields").hidden = !isProfessional;
  document.querySelector("#catalog-specialty-field").hidden = !isProfessional;
  document.querySelector("#employee-photo-fields").hidden = !isProfessional;
  document.querySelector("#option-services-field").hidden = !isOption;
  document.querySelector("#catalog-dialog-title").textContent = `${item ? "Editar" : "Novo"} ${isProfessional ? "profissional" : isOption ? "adicional" : "serviço"}`;
  renderChoiceList("professional-services", catalog.services, item?.service_ids || []);
  renderChoiceList("option-services", catalog.services, item?.service_ids || []);
  if (isProfessional) {
    document.querySelector("#professional-status").value = item?.status || "available";
    document.querySelector("#professional-commission").value = String(Math.round((Number(item?.commission_rate) || 0) * 100));
    document.querySelector("#professional-online-booking").checked = item?.allow_online_booking !== false;
    document.querySelector("#professional-schedule-active").checked = item?.schedule_active !== false;
    document.querySelector("#professional-work-start").value = item?.work_start || "08:00";
    document.querySelector("#professional-work-end").value = item?.work_end || "18:00";
    document.querySelector("#professional-interval").value = String(item?.interval_minutes || 30);
    const days = item?.work_days || [1, 2, 3, 4, 5];
    document.querySelectorAll('[name="work-day"]').forEach((input) => { input.checked = days.includes(Number(input.value)); });
    document.querySelector("#professional-lunch-active").checked = item?.lunch?.active === true;
    document.querySelector("#professional-lunch-start").value = item?.lunch?.start || "12:00";
    document.querySelector("#professional-lunch-end").value = item?.lunch?.end || "13:00";
    document.querySelector("#professional-break-active").checked = item?.additional_break?.active === true;
    document.querySelector("#professional-break-start").value = item?.additional_break?.start || "15:00";
    document.querySelector("#professional-break-end").value = item?.additional_break?.end || "15:15";
    document.querySelector("#professional-vacation-active").checked = item?.vacation?.active === true;
    document.querySelector("#professional-vacation-start").value = item?.vacation?.start || "";
    document.querySelector("#professional-vacation-end").value = item?.vacation?.end || "";
    document.querySelector("#professional-vacation-reason").value = item?.vacation?.reason || "";
    professionalTimes = Array.isArray(item?.available_times) ? [...item.available_times] : [];
    renderProfessionalTimes();
    updateEmployeePhotoPreview();
  }
  document.querySelector("#catalog-feedback").hidden = true;
  dialog.showModal();
  document.querySelector("#catalog-name").focus();
}

function updateEmployeePhotoPreview() {
  const url = document.querySelector("#employee-image").value.trim();
  const image = document.querySelector("#employee-photo-image");
  document.querySelector("#employee-photo-initial").textContent = initials(document.querySelector("#catalog-name").value || "F").slice(0, 1);
  image.hidden = !url;
  if (url) image.src = url;
}

function renderProfessionalTimes() {
  const container = document.querySelector("#professional-times");
  container.replaceChildren();
  professionalTimes.forEach((value) => {
    const tag = createElement("span", "booking-tag", value);
    const remove = createElement("button", "", "×"); remove.type = "button";
    remove.addEventListener("click", () => { professionalTimes = professionalTimes.filter((item) => item !== value); renderProfessionalTimes(); });
    tag.append(remove); container.append(tag);
  });
}

function addProfessionalTime() {
  const input = document.querySelector("#professional-time-input");
  if (input.value && !professionalTimes.includes(input.value)) professionalTimes.push(input.value);
  professionalTimes.sort(); input.value = ""; renderProfessionalTimes();
}

function checkedValues(containerId) {
  return [...document.querySelectorAll(`#${containerId} input:checked`)].map((input) => input.value);
}

async function saveCatalog(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const feedback = document.querySelector("#catalog-feedback");
  const type = document.querySelector("#catalog-item-type").value;
  const isProfessional = type === "professional";
  const item = isProfessional ? {
    name: document.querySelector("#catalog-name").value,
    specialty: document.querySelector("#catalog-specialty").value,
    imageUrl: document.querySelector("#employee-image").value,
    status: document.querySelector("#professional-status").value,
    commissionRate: Number(document.querySelector("#professional-commission").value) / 100,
    allowOnlineBooking: document.querySelector("#professional-online-booking").checked,
    scheduleActive: document.querySelector("#professional-schedule-active").checked,
    serviceIds: checkedValues("professional-services"),
    workDays: [...document.querySelectorAll('[name="work-day"]:checked')].map((input) => Number(input.value)),
    workStart: document.querySelector("#professional-work-start").value,
    workEnd: document.querySelector("#professional-work-end").value,
    intervalMinutes: Number(document.querySelector("#professional-interval").value),
    lunch: { active: document.querySelector("#professional-lunch-active").checked, start: document.querySelector("#professional-lunch-start").value, end: document.querySelector("#professional-lunch-end").value },
    additionalBreak: { active: document.querySelector("#professional-break-active").checked, start: document.querySelector("#professional-break-start").value, end: document.querySelector("#professional-break-end").value },
    availableTimes: professionalTimes,
    vacation: { active: document.querySelector("#professional-vacation-active").checked, start: document.querySelector("#professional-vacation-start").value, end: document.querySelector("#professional-vacation-end").value, reason: document.querySelector("#professional-vacation-reason").value },
    active: document.querySelector("#catalog-active").checked,
  } : {
    name: document.querySelector("#catalog-name").value,
    description: document.querySelector("#catalog-description").value,
    price: Number(document.querySelector("#catalog-price").value),
    durationMinutes: Number(document.querySelector("#catalog-duration").value),
    serviceIds: type === "option" ? checkedValues("option-services") : [],
    active: document.querySelector("#catalog-active").checked,
  };
  button.disabled = true; button.textContent = "Salvando…"; feedback.hidden = true;
  try {
    await saveCatalogItem({ organizationId, type, id: document.querySelector("#catalog-item-id").value, item });
    await loadCatalog();
    document.querySelector("#catalog-dialog").close();
  } catch (error) { feedback.textContent = callableMessage(error); feedback.hidden = false; }
  finally { button.disabled = false; button.textContent = "Salvar cadastro"; }
}

async function toggleCatalogItem(item, type = activeCatalogTab) {
  try {
    await setCatalogItemActive({ organizationId, type, id: item.id, active: item.active === false });
    await loadCatalog();
  } catch (error) { window.alert(callableMessage(error)); }
}

function setCatalogTab(type) {
  activeCatalogTab = type;
  document.querySelectorAll("[data-catalog-tab]").forEach((button) => button.classList.toggle("active", button.dataset.catalogTab === type));
  document.querySelector("#new-catalog-item").textContent = `＋ Novo ${type === "service" ? "serviço" : type === "option" ? "adicional" : "profissional"}`;
  renderCatalog();
}

function renderFlows() {
  const list = document.querySelector("#flow-list");
  list.replaceChildren();
  document.querySelector("#flow-count").textContent = String(metaFlows.length);
  if (!metaFlows.length) {
    const empty = createElement("div", "empty-compact");
    empty.append(createElement("strong", "", "Nenhum Flow encontrado"), createElement("span", "", "Crie e publique um Flow no WhatsApp Manager da Meta; depois clique em Atualizar Flows."));
    list.append(empty);
    return;
  }
  metaFlows.forEach((flow) => {
    const button = createElement("button", `flow-item${selectedFlow?.id === flow.id ? " active" : ""}`);
    button.type = "button";
    const icon = createElement("span", "flow-item-icon", "↗");
    const copy = createElement("span", "flow-item-copy");
    copy.append(createElement("strong", "", flow.name || "Flow sem nome"), createElement("small", "", `${flow.status || "RASCUNHO"} · ${(flow.categories || []).join(", ") || "Sem categoria"}`));
    button.append(icon, copy, createElement("b", "", "›"));
    button.addEventListener("click", () => selectFlow(flow));
    list.append(button);
  });
}

function selectFlow(flow) {
  selectedFlow = flow;
  document.querySelector("#flow-id").value = flow.id;
  document.querySelector("#flow-name").value = flow.name || "Flow sem nome";
  const isAppointment = (flow.categories || []).includes("APPOINTMENT_BOOKING");
  document.querySelector("#flow-message").value = flow.config?.message || (isAppointment
    ? "Olá, {{cliente_nome}}! Para agendar seu atendimento, escolha o serviço, o profissional, a data e o horário que preferir."
    : "Olá, {{cliente_nome}}! Acesse o formulário abaixo para continuarmos seu atendimento.");
  document.querySelector("#flow-cta").value = flow.config?.cta || (isAppointment ? "Agendar agora" : "Preencher agora");
  document.querySelector("#flow-active").checked = flow.config?.active !== false;
  document.querySelector('#booking-keywords-section').hidden = flow.config?.dynamic !== true;
  document.querySelector('#booking-keywords').value = (flow.config?.keywords ?? ['agendar', 'agendamento', 'marcar horário']).join('\n');
  document.querySelector("#selected-flow-status").textContent = flow.status || "Não publicado";
  document.querySelector("#save-flow-config").disabled = false;
  document.querySelector("#edit-selected-flow").disabled = false;
  updateFlowPreview();
  renderFlows();
}

function updateFlowPreview() {
  document.querySelector("#flow-preview-message").textContent = document.querySelector("#flow-message").value.replaceAll("{{cliente_nome}}", "Mariana").replaceAll("{{empresa_nome}}", "Studio Bella") || "Sua mensagem aparecerá aqui.";
  document.querySelector("#flow-preview-cta").textContent = document.querySelector("#flow-cta").value || "Abrir Flow";
}

async function loadFlows() {
  const list = document.querySelector("#flow-list");
  list.replaceChildren(createElement("div", "empty-compact", "Carregando Flows da Meta…"));
  try {
    const response = await listWhatsAppFlows({ organizationId });
    metaFlows = response.data?.flows || [];
    renderFlows();
  } catch (error) {
    const empty = createElement("div", "empty-compact");
    empty.append(createElement("strong", "", "Não foi possível carregar os Flows"), createElement("span", "", callableMessage(error)));
    list.replaceChildren(empty);
  }
}

async function saveFlowConfiguration(event) {
  event.preventDefault();
  if (!selectedFlow) return;
  const button = document.querySelector("#save-flow-config");
  const feedback = document.querySelector("#flow-feedback");
  button.disabled = true;
  button.textContent = "Salvando…";
  feedback.hidden = true;
  try {
    const config = { organizationId, flowId: selectedFlow.id, message: document.querySelector("#flow-message").value, cta: document.querySelector("#flow-cta").value, active: document.querySelector("#flow-active").checked };
    if (selectedFlow.config?.dynamic === true) {
      config.keywords = document.querySelector('#booking-keywords').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      if (config.keywords.length > 30 || config.keywords.some(value => value.length > 80)) throw new Error('Cadastre até 30 palavras ou frases, com no máximo 80 caracteres cada.');
    }
    const result = await saveWhatsAppFlowConfig(config);
    selectedFlow.config = { ...selectedFlow.config, message: config.message, cta: config.cta, active: config.active, ...(config.keywords !== undefined ? { keywords: config.keywords } : {}) };
    feedback.textContent = result.data?.dynamic
      ? (config.active ? "Configuração salva. Este é o Flow do menu automático: envie menu pelo WhatsApp para testar." : "Configuração salva. Este Flow foi desativado.")
      : "Configuração salva. Este Flow já está preparado para aparecer nas conversas.";
    feedback.hidden = false;
  } catch (error) {
    feedback.textContent = callableMessage(error);
    feedback.hidden = false;
  } finally { button.disabled = false; button.textContent = "Salvar configuração"; }
}

function applyReminderConfig(config = {}) {
  document.querySelector("#reminder-template").value = config.templateName || "lembrete_teste_whatsapp";
  document.querySelector("#reminder-language").value = config.language || "pt_BR";
  document.querySelector("#reminder-lead-time").value = String(config.leadTimeMinutes || 1440);
  document.querySelector("#reminder-trigger").value = config.trigger || "after_confirmation";
  document.querySelector("#reminder-delay").value = String(config.delaySeconds || 30);
  document.querySelector("#reminder-active").checked = config.active !== false;
  const status = document.querySelector("#reminder-status");
  status.textContent = config.templateStatus === "APPROVED" ? "Aprovado pela Meta" : (config.templateStatus || "Não configurado");
  status.classList.toggle("approved", config.templateStatus === "APPROVED");
  syncReminderTimingFields();
}

function syncReminderTimingFields() {
  automationTabs.updateReminderPreview();
  const afterConfirmation = document.querySelector("#reminder-trigger").value === "after_confirmation";
  document.querySelector("#reminder-delay-field").hidden = !afterConfirmation;
  document.querySelector("#reminder-lead-field").hidden = afterConfirmation;
  document.querySelector("#reminder-active-copy").textContent = afterConfirmation
    ? "Envia alguns segundos após a confirmação."
    : "Envia antes do horário agendado.";
}

async function loadReminderConfig() {
  const feedback = document.querySelector("#reminder-feedback");
  try {
    const response = await getAppointmentReminderConfig({ organizationId });
    applyReminderConfig(response.data || {});
    reminderLoaded = true;
  } catch (error) {
    feedback.textContent = callableMessage(error);
    feedback.hidden = false;
  }
}

function usageTone(element, percentage) {
  element.classList.toggle("warning", percentage >= 80 && percentage < 100);
  element.classList.toggle("danger", percentage >= 100);
}

function renderPlanUsage(data) {
  planUsage = data;
  const reminders = data.usage.reminders;
  const reminderLimit = data.limits.reminders;
  const appointments = data.usage.appointments;
  const appointmentLimit = data.limits.appointments;
  const percentage = data.percentage.reminders;
  const renewal = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "long" }).format(new Date(`${data.cycle.renewsOn}T12:00:00`));

  document.querySelector("#overview-usage-plan").textContent = data.plan.name.toUpperCase();
  document.querySelector("#overview-usage-title").textContent = `${reminders} de ${reminderLimit} lembretes enviados`;
  document.querySelector("#overview-usage-detail").textContent = `${appointments} de ${appointmentLimit} agendamentos · renova em ${renewal}`;
  document.querySelector("#overview-usage-count").textContent = `${reminders} de ${reminderLimit} lembretes`;
  document.querySelector("#overview-usage-percent").textContent = `${percentage}%`;
  document.querySelector("#overview-usage-bar").style.width = `${percentage}%`;
  usageTone(document.querySelector(".overview-usage-progress"), percentage);

  document.querySelector("#usage-plan-badge").textContent = `Plano ${data.plan.name}`;
  document.querySelector("#usage-reminders-used").textContent = String(reminders);
  document.querySelector("#usage-reminders-limit").textContent = String(reminderLimit);
  document.querySelector("#usage-reminders-remaining").textContent = `${data.remaining.reminders} disponíveis`;
  document.querySelector("#usage-appointments-used").textContent = String(appointments);
  document.querySelector("#usage-appointments-limit").textContent = String(appointmentLimit);
  document.querySelector("#usage-appointments-remaining").textContent = `${data.remaining.appointments} disponíveis`;
  document.querySelector("#usage-credit-reminders").textContent = String(data.credits?.reminders || 0);
  document.querySelector("#usage-credit-appointments").textContent = String(data.credits?.appointments || 0);
  document.querySelector("#usage-renewal-date").textContent = renewal;
  document.querySelector("#usage-progress-percent").textContent = `${percentage}%`;
  document.querySelector("#usage-progress-bar").style.width = `${percentage}%`;
  const progress = document.querySelector(".usage-progress-block");
  usageTone(progress, percentage);

  const projected = data.projection.reminders;
  const excess = data.projection.reminderExcess;
  document.querySelector("#usage-projection").textContent = excess > 0
    ? `No ritmo atual, a previsão é de ${projected} lembretes: ${excess} acima do seu plano.`
    : `No ritmo atual, a previsão é de ${projected} lembretes até o fim do ciclo.`;
  const extra = document.querySelector("#usage-extra");
  extra.classList.toggle("projected", excess > 0);
  document.querySelector("#usage-extra-status").textContent = "Comprar com Pix";
  const packages = data.capacityPackages || [];
  const startingAt = packages.length ? money(Math.min(...packages.map(item => item.price))) : "—";
  document.querySelector("#usage-extra-copy").textContent = excess > 0
    ? `Para não pausar os envios, escolha entre ${packages.length} pacote${packages.length === 1 ? "" : "s"} a partir de ${startingAt}. A contratação nunca é automática.`
    : `Escolha lembretes e agendamentos extras entre ${packages.length} pacote${packages.length === 1 ? "" : "s"} a partir de ${startingAt}. Nenhuma cobrança é automática.`;
}

function stopCapacityPolling() {
  if (capacityPollTimer) clearTimeout(capacityPollTimer);
  capacityPollTimer = null;
}

function renderCapacityPurchase(purchase) {
  const dialog = document.querySelector("#capacity-dialog");
  const approved = purchase.status === "approved";
  const terminal = approved || ["expired", "failed", "rejected"].includes(purchase.status);
  dialog.classList.toggle("approved", approved);
  document.querySelector("#capacity-package-list").hidden = true;
  document.querySelector("#capacity-start").hidden = true;
  document.querySelector("#capacity-payment").hidden = false;
  document.querySelector("#capacity-pix-code").value = purchase.qrCode || "";
  const image = document.querySelector("#capacity-qr-image");
  image.src = purchase.qrCodeBase64 ? (purchase.qrCodeBase64.startsWith("data:") ? purchase.qrCodeBase64 : `data:image/png;base64,${purchase.qrCodeBase64}`) : "";
  image.hidden = !purchase.qrCodeBase64;
  const open = document.querySelector("#capacity-open");
  open.href = purchase.ticketUrl || "";
  open.hidden = !purchase.ticketUrl || approved;
  document.querySelector("#capacity-copy").hidden = !purchase.qrCode || approved;
  document.querySelector("#capacity-pix-code").hidden = !purchase.qrCode || approved;
  document.querySelector("#capacity-status-title").textContent = approved ? `${purchase.packageName} liberado` : terminal ? "Esta cobrança não está mais disponível" : `Aguardando pagamento · ${purchase.packageName}`;
  document.querySelector("#capacity-status-copy").textContent = approved
    ? `Créditos liberados: +${purchase.reminders} lembretes e +${purchase.appointments} agendamentos, sem validade.`
    : terminal ? "Gere um novo Pix para tentar novamente." : "Escaneie o QR Code ou copie o código Pix abaixo. A liberação acontece automaticamente.";
  if (approved) loadPlanUsage();
  if (terminal) stopCapacityPolling();
}

function selectCapacityPackage(item) {
  selectedCapacityPackage = item;
  document.querySelectorAll("[data-capacity-package]").forEach(button => {
    const selected = button.dataset.capacityPackage === item.id;
    button.classList.toggle("selected", selected); button.setAttribute("aria-checked", String(selected));
  });
  document.querySelector("#capacity-selected-name").textContent = item.name;
  document.querySelector("#capacity-selected-price").textContent = `${money(item.price)} via Pix`;
  document.querySelector("#capacity-selected-credits").textContent = `+${item.reminders} lembretes e +${item.appointments} agendamentos · créditos sem validade`;
  document.querySelector("#capacity-create").disabled = false;
}

function renderCapacityPackageOptions() {
  const container = document.querySelector("#capacity-package-list"); container.replaceChildren();
  const packages = planUsage?.capacityPackages || [];
  for (const item of packages) {
    const button = document.createElement("button"); button.type = "button"; button.className = `capacity-package-option${item.featured ? " featured" : ""}`; button.dataset.capacityPackage = item.id; button.setAttribute("role", "radio"); button.setAttribute("aria-checked", "false");
    const header = document.createElement("span"); header.className = "capacity-package-heading"; header.innerHTML = `<strong></strong><em></em>`; header.querySelector("strong").textContent = item.name; header.querySelector("em").textContent = money(item.price);
    const credits = document.createElement("span"); credits.className = "capacity-package-credits"; credits.textContent = `${item.reminders} lembretes + ${item.appointments} agendamentos`;
    const badge = document.createElement("small"); badge.textContent = item.featured ? "Mais escolhido" : "Pagamento único";
    button.append(header, credits, badge); button.addEventListener("click", () => selectCapacityPackage(item)); container.append(button);
  }
  if (!packages.length) container.textContent = "Nenhum pacote está disponível no momento.";
  const preferred = packages.find(item => item.featured) || packages[0]; if (preferred) selectCapacityPackage(preferred);
}

async function pollCapacityPurchase() {
  if (!capacityPurchaseId || !document.querySelector("#capacity-dialog").open) return;
  try {
    const response = await getCapacityPurchase({ organizationId, purchaseId: capacityPurchaseId });
    renderCapacityPurchase(response.data);
    if (response.data.status === "pending") capacityPollTimer = setTimeout(pollCapacityPurchase, 4000);
  } catch (error) {
    document.querySelector("#capacity-feedback").textContent = callableMessage(error);
    document.querySelector("#capacity-feedback").hidden = false;
    capacityPollTimer = setTimeout(pollCapacityPurchase, 7000);
  }
}

function openCapacityDialog() {
  stopCapacityPolling(); capacityPurchaseId = ""; selectedCapacityPackage = null;
  const dialog = document.querySelector("#capacity-dialog");
  dialog.classList.remove("approved");
  document.querySelector("#capacity-start").hidden = false;
  document.querySelector("#capacity-package-list").hidden = false;
  document.querySelector("#capacity-payment").hidden = true;
  document.querySelector("#capacity-feedback").hidden = true;
  document.querySelector("#capacity-create").disabled = true;
  renderCapacityPackageOptions();
  dialog.showModal();
}

async function startCapacityPurchase() {
  const button = document.querySelector("#capacity-create");
  const feedback = document.querySelector("#capacity-feedback");
  if (!selectedCapacityPackage) return;
  button.disabled = true; button.textContent = "Gerando Pix…"; feedback.hidden = true;
  try {
    const response = await createCapacityPurchase({ organizationId, packageId: selectedCapacityPackage.id });
    capacityPurchaseId = response.data.id;
    renderCapacityPurchase(response.data);
    if (response.data.status === "pending") capacityPollTimer = setTimeout(pollCapacityPurchase, 4000);
  } catch (error) {
    feedback.textContent = callableMessage(error); feedback.hidden = false;
  } finally { button.disabled = false; button.textContent = "Gerar Pix"; }
}

async function loadPlanUsage() {
  if (!organizationId) return;
  try {
    const response = await getPlanUsage({ organizationId });
    renderPlanUsage(response.data);
  } catch (error) {
    console.error(error);
    document.querySelector("#overview-usage-title").textContent = "Não foi possível carregar o uso do plano.";
    document.querySelector("#usage-projection").textContent = callableMessage(error);
  }
}

async function saveReminderConfig(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const feedback = document.querySelector("#reminder-feedback");
  button.disabled = true; button.textContent = "Validando na Meta…"; feedback.hidden = true;
  try {
    const response = await saveAppointmentReminderConfig({
      organizationId,
      templateName: document.querySelector("#reminder-template").value,
      language: document.querySelector("#reminder-language").value,
      trigger: document.querySelector("#reminder-trigger").value,
      delaySeconds: Number(document.querySelector("#reminder-delay").value),
      leadTimeMinutes: Number(document.querySelector("#reminder-lead-time").value),
      active: document.querySelector("#reminder-active").checked,
    });
    applyReminderConfig(response.data || {});
    reminderLoaded = true;
    feedback.textContent = "Modelo aprovado e configuração salva. O próximo teste usará dados reais do agendamento.";
    feedback.hidden = false;
  } catch (error) {
    feedback.textContent = callableMessage(error);
    feedback.hidden = false;
  } finally { button.disabled = false; button.textContent = "Salvar lembrete"; }
}

async function openBookingFlowEditor(flow = null) {
  if (!catalog.services.length && !catalog.professionals.length) await loadCatalog();
  const builder = flow?.config?.builder || {};
  editingSourceFlowId = flow?.id || "";
  document.querySelector("#booking-flow-dialog").querySelector("h2").textContent = flow ? "Editar Flow de agendamento" : "Novo Flow de agendamento";
  const submit = document.querySelector('#booking-flow-form button[type="submit"]');
  submit.dataset.idleLabel = flow ? "Publicar nova versão na Meta" : "Criar e publicar na Meta";
  submit.textContent = submit.dataset.idleLabel;
  document.querySelector("#booking-flow-name").value = builder.name || flow?.name || "Agendamento Automichat";
  document.querySelector("#booking-title").value = builder.title || "Agende seu atendimento";
  document.querySelector("#booking-submit-label").value = builder.submitLabel || "Confirmar";
  document.querySelector("#booking-description").value = builder.description || "Escolha o serviço, o profissional e o melhor horário disponível.";
  document.querySelector("#booking-confirmation").value = builder.confirmation || "Recebemos sua solicitação de agendamento.";
  document.querySelector("#booking-flow-feedback").hidden = true;
  document.querySelector("#booking-flow-dialog").showModal();
}

async function createBookingFlow(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const feedback = document.querySelector("#booking-flow-feedback");
  button.disabled = true; button.textContent = "Criando na Meta…"; feedback.hidden = true;
  try {
    const response = await createAppointmentFlow({ organizationId, sourceFlowId: editingSourceFlowId, name: document.querySelector("#booking-flow-name").value, title: document.querySelector("#booking-title").value, description: document.querySelector("#booking-description").value, submitLabel: document.querySelector("#booking-submit-label").value, confirmation: document.querySelector("#booking-confirmation").value });
    feedback.textContent = response.data?.published ? "Flow criado e publicado com sucesso." : `Flow criado como rascunho. ${(response.data?.validationErrors || []).map((item) => item.message).join(" · ")}`;
    feedback.hidden = false;
    if (response.data?.published) { await loadFlows(); setTimeout(() => document.querySelector("#booking-flow-dialog").close(), 900); }
  } catch (error) { feedback.textContent = callableMessage(error); feedback.hidden = false; }
  finally { button.disabled = false; button.textContent = button.dataset.idleLabel || "Criar e publicar na Meta"; }
}

function openConnectionDialog() {
  syncConnectionDialog();
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function syncConnectionDialog() {
  const details = document.querySelector("#connected-details");
  const tabs = document.querySelector(".connection-tabs");
  const intro = dialog.querySelector(":scope > p:not(.dialog-eyebrow)");
  dialog.querySelector("h2").textContent = whatsAppConnected ? "Detalhes da conexão" : "Conectar WhatsApp";
  intro.hidden = whatsAppConnected;
  details.hidden = !whatsAppConnected;
  tabs.hidden = whatsAppConnected;
  document.querySelectorAll("[data-connection-pane]").forEach((pane) => {
    pane.hidden = whatsAppConnected || !pane.classList.contains("active");
  });
  if (!whatsAppConnected) return;
  const value = (key, fallback = "Não informado") => String(whatsAppIntegration?.[key] || fallback);
  details.querySelector('[data-connection-detail="name"]').textContent = value("verified_name");
  details.querySelector('[data-connection-detail="phone"]').textContent = value("display_phone_number");
  details.querySelector('[data-connection-detail="id"]').textContent = value("phone_number_id");
  details.querySelector('[data-connection-detail="quality"]').textContent = value("quality_rating");
}

async function disconnectCurrentWhatsApp() {
  if (!whatsAppConnected) return;
  const confirmed = window.confirm("Desconectar este WhatsApp? O painel deixará de receber e enviar mensagens por este número.");
  if (!confirmed) return;
  const button = document.querySelector("#disconnect-whatsapp");
  const feedback = document.querySelector("#disconnect-feedback");
  button.disabled = true;
  button.textContent = "Desconectando…";
  feedback.hidden = true;
  try {
    await disconnectWhatsApp({ organizationId });
    feedback.textContent = "WhatsApp desconectado com sucesso.";
    feedback.hidden = false;
    dialog.close();
  } catch (error) {
    feedback.textContent = callableMessage(error);
    feedback.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Desconectar WhatsApp";
  }
}

function selectConnectionPane(name) {
  document.querySelectorAll("[data-connection-tab]").forEach((button) => {
    const active = button.dataset.connectionTab === name;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll("[data-connection-pane]").forEach((pane) => {
    const active = pane.dataset.connectionPane === name;
    pane.classList.toggle("active", active);
    pane.hidden = !active;
  });
}

function callableMessage(error) {
  return String(error?.message || "Não foi possível concluir a operação.").replace(/^FirebaseError:\s*/i, "");
}

async function lookupExistingNumber(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  const input = form.querySelector("#phone-number-id");
  const feedback = document.querySelector("#number-id-feedback");
  const resultCard = document.querySelector("#number-result");
  verifiedPhoneNumberId = "";
  verifiedWabaId = "";
  resultCard.hidden = true;
  feedback.hidden = true;
  button.disabled = true;
  button.textContent = "Buscando…";
  try {
    const response = await lookupExistingWhatsAppPhoneNumber({ organizationId, phoneNumberId: input.value });
    const phone = response.data || {};
    verifiedPhoneNumberId = String(phone.phoneNumberId || "");
    verifiedWabaId = String(phone.wabaId || "");
    resultCard.querySelector('[data-phone-result="name"]').textContent = phone.verifiedName || "Não informado";
    resultCard.querySelector('[data-phone-result="phone"]').textContent = phone.displayPhoneNumber || "Não informado";
    resultCard.querySelector('[data-phone-result="id"]').textContent = verifiedPhoneNumberId;
    resultCard.querySelector('[data-phone-result="waba"]').textContent = verifiedWabaId;
    resultCard.querySelector('[data-phone-result="quality"]').textContent = phone.qualityRating || "Não informado";
    resultCard.hidden = false;
    feedback.textContent = "Número encontrado. Confira os dados antes de conectar.";
    feedback.hidden = false;
  } catch (error) {
    feedback.textContent = callableMessage(error);
    feedback.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Buscar";
  }
}

async function connectExistingNumber() {
  if (!verifiedPhoneNumberId || !verifiedWabaId) return;
  const button = document.querySelector("#connect-existing-number");
  const feedback = document.querySelector("#number-id-feedback");
  button.disabled = true;
  button.textContent = "Conectando…";
  try {
    await connectExistingWhatsAppPhoneNumber({ organizationId, phoneNumberId: verifiedPhoneNumberId, wabaId: verifiedWabaId });
    feedback.textContent = "WhatsApp conectado com sucesso. As novas mensagens já podem aparecer na caixa de entrada.";
    feedback.hidden = false;
    button.textContent = "Número conectado";
  } catch (error) {
    feedback.textContent = callableMessage(error);
    feedback.hidden = false;
    button.disabled = false;
    button.textContent = "Conectar este número";
  }
}

async function beginMetaSignup() {
  const button = document.querySelector("#start-meta-signup");
  const feedback = document.querySelector("#dialog-feedback");
  feedback.hidden = true;
  button.disabled = true;
  button.textContent = "Abrindo Facebook…";
  try {
    const result = await startEmbeddedSignup();
    if (!result.wabaId || !result.phoneNumberId) throw new Error("A Meta não retornou o WABA e o Phone Number ID. Conclua todas as telas do cadastro.");
    await completeWhatsAppOnboarding({
      organizationId,
      code: result.code,
      wabaId: result.wabaId,
      phoneNumberId: result.phoneNumberId
    });
    feedback.textContent = "WhatsApp conectado com sucesso. As novas mensagens já podem aparecer na caixa de entrada.";
    feedback.hidden = false;
  } catch (error) {
    feedback.textContent = error.message || "Não foi possível concluir a autorização com a Meta.";
    feedback.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Continuar com Facebook";
  }
}

function listenToIntegration() {
  return onSnapshot(doc(db, "organizations", organizationId, "public_integrations", "whatsapp"), (snapshot) => {
    whatsAppIntegration = snapshot.exists() ? snapshot.data() : null;
    const connected = whatsAppIntegration?.status === "active";
    whatsAppConnected = connected;
    const connectionCard = document.querySelector('#meta-connect-card');
    connectionCard.classList.toggle('connected-compact',connected);
    connectionCard.querySelector('h3').textContent=connected ? 'WhatsApp conectado' : 'Conecte seu número oficial';
    connectionCard.querySelector('.meta-copy p').textContent=connected ? (whatsAppIntegration?.display_phone_number || 'Seu atendimento está pronto para receber mensagens.') : 'Conecte seu número para receber mensagens e agendamentos.';
    updateMetrics();
    syncComposer();
    renderConversationList();
    renderEmptyChat();
    syncConnectionDialog();
    const pill = document.querySelector("#connection-pill");
    pill.querySelector("span").textContent = connected ? "WhatsApp conectado" : "WhatsApp desconectado";
    pill.classList.toggle("connected", connected);
    document.querySelector("#setup-progress").textContent = connected ? "3/4" : "2/4";
    document.querySelector(".progress-track i").style.width = connected ? "75%" : "50%";
    const topConnect = document.querySelector("#top-connect");
    const cardConnect = document.querySelector("#connect-whatsapp");
    topConnect.hidden = connected;
    topConnect.textContent = "Conectar";
    cardConnect.hidden = false;
    cardConnect.textContent = connected ? "Detalhes da conexão" : "Conectar WhatsApp";
    const setupStep = document.querySelector("#whatsapp-setup-step");
    setupStep.classList.toggle("done", connected);
    setupStep.querySelector(":scope > span").textContent = connected ? "✓" : "3";
    setupStep.querySelector("strong").textContent = connected ? "WhatsApp conectado" : "Conectar WhatsApp";
    setupStep.querySelector("small").textContent = connected ? "Número oficial vinculado à Meta" : "Vincule seu número pela Meta";
  }, (error) => console.error(error));
}

function listenToConversations() {
  const conversationsQuery = query(collection(db, "organizations", organizationId, "conversations"), orderBy("last_message_at", "desc"), limit(50));
  return onSnapshot(conversationsQuery, (snapshot) => {
    conversations = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    customersLoaded = false;
    if (selectedConversationId) {
      selectedConversation = conversations.find((item) => item.id === selectedConversationId) || selectedConversation;
      syncConversationHeader(selectedConversation);
      syncCustomerPanel(selectedConversation);
    }
    updateMetrics();
    renderConversationList();
    renderRecent();
    renderEmptyChat();
  }, (error) => {
    console.error(error);
    conversationList.replaceChildren(createElement("div", "inbox-empty", "Não foi possível carregar as conversas."));
  });
}

onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.replace("./login.html"); return; }
  try {
    const token = await user.getIdTokenResult();
    document.querySelector("#admin-panel-link").hidden = token.claims.admin !== true;
    const profileSnapshot = await getDoc(doc(db, "users", user.uid));
    if (!profileSnapshot.exists()) throw new Error("Perfil não encontrado.");
    const profile = profileSnapshot.data();
    if (profile.onboarding_concluido !== true) {
      window.location.replace(profile.organizacao_id ? "./plans.html" : "./onboarding.html");
      return;
    }
    organizationId = profile.organizacao_id;
    const organizationSnapshot = await getDoc(doc(db, "organizations", organizationId));
    if (!organizationSnapshot.exists()) throw new Error("Empresa não encontrada.");
    const organization = organizationSnapshot.data();
    const segmentResult = await listAvailableSegments({ includeInactive: true });
    const segment = (segmentResult.data.segments || []).find(item => item.name === organization.segmento);
    foodBusiness = foodUI.initialize(organizationId, organization.segmento, segment?.screens || []);
    orderNotificationsUI.configure((segment?.screens || []).some(screen => ["orders", "deliveries", "menu"].includes(screen)));
    applySegmentNavigation(segment);
    const firstName = String(profile.nome || "por aí").split(/\s+/)[0];
    document.querySelector("#welcome-name").textContent = firstName;
    document.querySelector("#profile-name").textContent = profile.nome || "Conta Automichat";
    document.querySelector("#profile-email").textContent = profile.email || "";
    document.querySelector("#profile-avatar").textContent = initials(profile.nome);
    document.querySelector("#sidebar-plan").textContent = organization.plano_nome || "Sem plano";
    document.querySelector("#today-label").textContent = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "2-digit", month: "long" }).format(new Date());
    listenToIntegration();
    listenToConversations();
    loadPlanUsage();
    loading.hidden = true;
    shell.hidden = false;
    if (new URLSearchParams(window.location.search).get('mp') === 'connected') {
      const url = new URL(window.location.href);
      url.searchParams.delete('mp');
      url.hash = 'payments';
      history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
      showView('payments', { remember: false });
    } else showView(viewFromLocation(), { remember: false });
  } catch (error) {
    console.error(error);
    loading.querySelector("p").textContent = error.message || "Não foi possível abrir o painel.";
  }
});

document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
document.querySelector("#overview-usage-open").addEventListener("click", () => { showView("automations"); automationTabs.select("consumption"); });
document.querySelectorAll("#connect-whatsapp, #top-connect, [data-connect-whatsapp]").forEach((button) => button.addEventListener("click", openConnectionDialog));
document.querySelector("#dialog-close").addEventListener("click", () => dialog.close());
document.querySelectorAll("[data-connection-tab]").forEach((button) => button.addEventListener("click", () => selectConnectionPane(button.dataset.connectionTab)));
document.querySelectorAll("#phone-number-id").forEach((input) => input.addEventListener("input", (event) => {
  event.currentTarget.value = event.currentTarget.value.replace(/\D/g, "");
  verifiedPhoneNumberId = "";
  verifiedWabaId = "";
  document.querySelector("#number-result").hidden = true;
  document.querySelector("#number-id-feedback").hidden = true;
}));
document.querySelector("#number-id-form").addEventListener("submit", lookupExistingNumber);
document.querySelector("#connect-existing-number").addEventListener("click", connectExistingNumber);
document.querySelector("#start-meta-signup").addEventListener("click", beginMetaSignup);
document.querySelector("#refresh-flows").addEventListener("click", loadFlows);
document.querySelector("#new-booking-flow").addEventListener("click", () => openBookingFlowEditor());
document.querySelector("#edit-selected-flow").addEventListener("click", () => { if (selectedFlow) openBookingFlowEditor(selectedFlow); });
document.querySelector("#booking-flow-close").addEventListener("click", () => document.querySelector("#booking-flow-dialog").close());
document.querySelector("#booking-flow-form").addEventListener("submit", createBookingFlow);
document.querySelectorAll("[data-catalog-tab]").forEach((button) => button.addEventListener("click", () => setCatalogTab(button.dataset.catalogTab)));
document.querySelector("#new-catalog-item").addEventListener("click", () => openCatalogDialog(activeCatalogTab));
document.querySelector("#catalog-dialog-close").addEventListener("click", () => document.querySelector("#catalog-dialog").close());
document.querySelector("#catalog-form").addEventListener("submit", saveCatalog);
document.querySelector("#add-professional-time").addEventListener("click", addProfessionalTime);
document.querySelector("#employee-image").addEventListener("input", updateEmployeePhotoPreview);
document.querySelector("#catalog-name").addEventListener("input", updateEmployeePhotoPreview);
document.querySelector("#new-employee").addEventListener("click", () => openCatalogDialog("professional"));
document.querySelector("#catalog-search").addEventListener("input", renderCatalog);
document.querySelector("#catalog-status").addEventListener("change", renderCatalog);
document.querySelector("#employee-search").addEventListener("input", renderEmployees);
document.querySelector("#employee-status-filter").addEventListener("change", renderEmployees);
document.querySelector("#new-customer").addEventListener("click", () => openCustomerForm());
document.querySelector("#customers-refresh").addEventListener("click", () => loadCustomers({ force: true }));
document.querySelector("#customer-search").addEventListener("input", renderCustomers);
document.querySelector("#customer-status-filter").addEventListener("change", renderCustomers);
document.querySelector("#customer-dialog-close").addEventListener("click", () => document.querySelector("#customer-dialog").close());
document.querySelector("#customer-form").addEventListener("submit", submitCustomerForm);
document.querySelector("#customer-detail-close").addEventListener("click", () => document.querySelector("#customer-detail-dialog").close());
document.querySelector("#customer-detail-edit").addEventListener("click", () => { document.querySelector("#customer-detail-dialog").close(); openCustomerForm(selectedCustomer); });
document.querySelector("#customer-detail-conversation").addEventListener("click", openCustomerConversation);
document.querySelector("#flow-config-form").addEventListener("submit", saveFlowConfiguration);
document.querySelector("#reminder-form").addEventListener("submit", saveReminderConfig);
document.querySelector("#usage-extra").addEventListener("click", openCapacityDialog);
document.querySelector("#capacity-create").addEventListener("click", startCapacityPurchase);
document.querySelector("#capacity-close").addEventListener("click", () => { stopCapacityPolling(); document.querySelector("#capacity-dialog").close(); });
document.querySelector("#capacity-dialog").addEventListener("close", stopCapacityPolling);
document.querySelector("#capacity-copy").addEventListener("click", async () => {
  const code = document.querySelector("#capacity-pix-code").value;
  if (!code) return;
  await navigator.clipboard.writeText(code);
  const button = document.querySelector("#capacity-copy"); button.textContent = "Pix copiado ✓"; setTimeout(() => { button.textContent = "Copiar Pix"; }, 1800);
});
document.querySelector("#reminder-trigger").addEventListener("change", syncReminderTimingFields);
document.querySelector("#send-flow-open").addEventListener("click", openSendFlowDialog);
document.querySelector("#send-flow-close").addEventListener("click", () => document.querySelector("#send-flow-dialog").close());
document.querySelector("#send-flow-form").addEventListener("submit", submitSendFlow);
document.querySelectorAll("#flow-message, #flow-cta").forEach((field) => field.addEventListener("input", updateFlowPreview));
document.querySelectorAll("[data-variable]").forEach((button) => button.addEventListener("click", () => { const field = document.querySelector("#flow-message"); field.setRangeText(button.dataset.variable, field.selectionStart, field.selectionEnd, "end"); field.focus(); updateFlowPreview(); }));
document.querySelector("#disconnect-whatsapp").addEventListener("click", disconnectCurrentWhatsApp);
document.querySelector("#menu-button").addEventListener("click", () => shell.classList.add("menu-open"));
document.querySelector("#sidebar-close").addEventListener("click", () => shell.classList.remove("menu-open"));
document.querySelector("#sidebar-overlay").addEventListener("click", () => shell.classList.remove("menu-open"));
document.querySelector("#mobile-chat-back").addEventListener("click", () => { conversationShell.classList.remove("has-selection", "details-open"); });
document.querySelector("#customer-panel-toggle").addEventListener("click", () => toggleCustomerPanel(!conversationShell.classList.contains("details-open")));
document.querySelector("#customer-panel-close").addEventListener("click", () => toggleCustomerPanel(false));
document.querySelector("#profile-menu").addEventListener("click", () => { const actions = document.querySelector("#profile-actions"); actions.hidden = !actions.hidden; });
document.querySelector("#sign-out").addEventListener("click", async () => { await signOut(auth); window.location.replace("./index.html"); });
searchInput.addEventListener("input", renderConversationList);
document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
  currentFilter = button.dataset.filter;
  document.querySelectorAll("[data-filter]").forEach((item) => item.classList.toggle("active", item === button));
  renderConversationList();
}));
document.querySelector("#conversation-status").addEventListener("change", async (event) => {
  if (!selectedConversationId) return;
  const select = event.currentTarget;
  const previous = selectedConversation?.status || "waiting";
  select.disabled = true;
  try {
    await updateConversationState({ organizationId, conversationId: selectedConversationId, status: select.value, markRead: true });
  } catch (error) {
    select.value = previous;
    document.querySelector("#composer-feedback").textContent = callableMessage(error);
    document.querySelector("#composer-feedback").hidden = false;
  } finally {
    select.disabled = false;
  }
});
document.querySelector("#composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedConversationId || !whatsAppConnected) return;
  const form = event.currentTarget;
  const input = form.querySelector("#message-input");
  const send = form.querySelector(".send-button");
  const feedback = form.querySelector("#composer-feedback");
  const text = input.value.trim();
  if (!text) return;
  input.disabled = true;
  send.disabled = true;
  feedback.hidden = true;
  try {
    await sendWhatsAppMessage({ organizationId, conversationId: selectedConversationId, text });
    input.value = "";
    input.focus();
  } catch (error) {
    feedback.textContent = callableMessage(error);
    feedback.hidden = false;
  } finally {
    syncComposer();
  }
});
