import { onAuthStateChanged, signOut } from "firebase/auth";
import { collection, doc, getDoc, limit, limitToLast, onSnapshot, orderBy, query } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { auth } from "./auth.js";
import { app, db } from "./firebase-config.js";
import { startEmbeddedSignup } from "./meta-whatsapp.js";
import { createAppointmentsUI } from './appointments.js';
import { createAutomationTabs } from './automation-tabs.js';
import { createPaymentsUI } from './payments.js';

const shell = document.querySelector("#app-shell");
const loading = document.querySelector("#dashboard-loading");
const conversationShell = document.querySelector("#conversation-shell");
const conversationList = document.querySelector("#conversation-list");
const recentList = document.querySelector("#recent-conversations");
const messageList = document.querySelector("#message-list");
const searchInput = document.querySelector("#conversation-search");
const dialog = document.querySelector("#connection-dialog");
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
let verifiedPhoneNumberId = "";
let verifiedWabaId = "";
let metaFlows = [];
let selectedFlow = null;
let editingSourceFlowId = "";
let catalog = { services: [], options: [], professionals: [] };
let activeCatalogTab = "service";
let professionalTimes = [];
let reminderLoaded = false;
const automationTabs = createAutomationTabs();
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

function showView(viewName) {
  document.querySelectorAll(".dashboard-view").forEach((view) => view.classList.toggle("active", view.id === `view-${viewName}`));
  document.querySelectorAll(".nav-item[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === viewName));
  const titles = { overview: "Visão geral", appointments: 'Agendamentos', conversations: "Conversas", services: "Serviços", employees: "Funcionários", payments: 'Pagamentos', automations: "Automações" };
  document.querySelector("#page-title").textContent = titles[viewName] || "Visão geral";
  shell.classList.remove("menu-open");
  if (viewName === 'payments') paymentsUI.load();
  if(viewName === 'appointments' || viewName === 'overview') agendaUI.refresh();
  if (viewName === "automations") {
    if (!metaFlows.length) loadFlows();
    if (!reminderLoaded) loadReminderConfig();
  }
  if (viewName === "services" && !catalog.services.length && !catalog.options.length && !catalog.professionals.length) loadCatalog();
  if (viewName === "employees" && !catalog.services.length && !catalog.options.length && !catalog.professionals.length) loadCatalog();
}

function catalogArray(type = activeCatalogTab) {
  return catalog[type === "service" ? "services" : type === "option" ? "options" : "professionals"] || [];
}

function money(value) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value) || 0);
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
  document.querySelector("#booking-flow-name").value = builder.name || flow?.name || "Agendamento clickchat";
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
    const firstName = String(profile.nome || "por aí").split(/\s+/)[0];
    document.querySelector("#welcome-name").textContent = firstName;
    document.querySelector("#profile-name").textContent = profile.nome || "Conta clickchat";
    document.querySelector("#profile-email").textContent = profile.email || "";
    document.querySelector("#profile-avatar").textContent = initials(profile.nome);
    document.querySelector("#sidebar-plan").textContent = organization.plano_nome || "Sem plano";
    document.querySelector("#today-label").textContent = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "2-digit", month: "long" }).format(new Date());
    listenToIntegration();
    listenToConversations();
    agendaUI.refresh();
    loading.hidden = true;
    shell.hidden = false;
    if (new URLSearchParams(window.location.search).get('mp') === 'connected') {
      showView('payments'); history.replaceState(null, '', window.location.pathname);
    }
  } catch (error) {
    console.error(error);
    loading.querySelector("p").textContent = error.message || "Não foi possível abrir o painel.";
  }
});

document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
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
document.querySelector("#flow-config-form").addEventListener("submit", saveFlowConfiguration);
document.querySelector("#reminder-form").addEventListener("submit", saveReminderConfig);
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
