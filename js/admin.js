import { onAuthStateChanged, signOut } from "firebase/auth";
import { getFunctions, httpsCallable } from "firebase/functions";
import { app } from "./firebase-config.js";
import { auth } from "./auth.js";
import { installButtonProgress, withButtonBusy } from "./ui-loading.js";

installButtonProgress();

window.__automichatAdminModuleLoaded = true;

const functions = getFunctions(app, "southamerica-east1");
const call = name => httpsCallable(functions, name);
const api = {
  overview: call("getAdminOverview"), plans: call("listAdminPlans"), savePlan: call("saveAdminPlan"),
  organizations: call("listAdminOrganizations"), updateOrganization: call("updateAdminOrganization"),
  support: call("getAdminSupportView"), audit: call("listAdminAuditLogs"),
  segments: call("listAdminSegments"), saveSegment: call("saveAdminSegment"),
  maintenance: call("getSiteMaintenance"), setMaintenance: call("setSiteMaintenance"),
};
const loading = document.querySelector("#admin-loading");
const shell = document.querySelector("#admin-shell");
const feedbackBox = document.querySelector("#global-feedback");
const state = { plans: [], capacityPackages: [], organizations: [], segments: [] };
const titles = { overview: "Visão geral", organizations: "Empresas", plans: "Planos e limites", packages: "Pacotes extras", settings: "Ajustes", audit: "Auditoria" };
const screenLabels = { overview: "Visão geral", appointments: "Agendamentos", orders: "Pedidos", deliveries: "Entregas", conversations: "Conversas", services: "Serviços", menu: "Cardápio", employees: "Funcionários", payments: "Pagamentos", contacts: "Contatos", automations: "Automações" };
const essentialScreens = new Set(["overview", "conversations", "contacts"]);
const REQUEST_TIMEOUT = 20000;
const AUTH_TIMEOUT = 10000;

function node(tag, className = "", text = "") { const item = document.createElement(tag); if (className) item.className = className; if (text !== "") item.textContent = text; return item; }
function feedback(message, error = false) { feedbackBox.textContent = message; feedbackBox.style.background = error ? "#9b312b" : "#173c29"; feedbackBox.hidden = false; clearTimeout(feedback.timer); feedback.timer = setTimeout(() => { feedbackBox.hidden = true; }, 5000); }
function message(error) { return String(error?.message || "Não foi possível concluir.").replace(/^Firebase:\s*/i, "").replace(/\s*\(functions\/[\w-]+\)\.?$/i, ""); }
function withTimeout(promise, label, timeout = REQUEST_TIMEOUT) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} demorou mais que o esperado.`)), timeout); })
  ]).finally(() => clearTimeout(timer));
}
function showAccessError(error) {
  loading.querySelector("p").textContent = `${message(error)} Tente novamente ou entre outra vez.`;
  loading.querySelector("span").style.background = "#9b312b";
  let actions = loading.querySelector(".admin-loading-actions");
  if (!actions) {
    actions = node("div", "admin-loading-actions");
    const retry = node("button", "primary-button", "Tentar novamente");
    const login = node("button", "secondary-button", "Entrar novamente");
    retry.type = "button"; login.type = "button";
    retry.addEventListener("click", () => location.reload());
    login.addEventListener("click", async () => { try { await signOut(auth); } finally { location.replace("./login.html?return=admin"); } });
    actions.append(retry, login); loading.append(actions);
  }
}
async function getAdminToken(user) {
  let cachedToken;
  try {
    cachedToken = await withTimeout(user.getIdTokenResult(false), "A leitura da sessão", AUTH_TIMEOUT);
    if (cachedToken.claims.admin === true) return cachedToken;
  } catch {
    // A renovação forçada abaixo ainda pode recuperar uma sessão local indisponível.
  }
  const refreshedToken = await withTimeout(user.getIdTokenResult(true), "A validação do acesso administrativo", AUTH_TIMEOUT);
  if (refreshedToken.claims.admin !== true) throw new Error("Sua conta não possui permissão administrativa.");
  return refreshedToken;
}
function money(value) { return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value || 0)); }
function date(value) { return value ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—"; }
function statusLabel(value) { return ({ active: "Ativa", trial: "Em teste", suspended: "Suspensa", onboarding: "Onboarding" })[value] || value || "Desconhecido"; }

document.querySelectorAll("[data-section]").forEach(button => button.addEventListener("click", () => {
  const section = button.dataset.section;
  document.querySelectorAll("[data-section]").forEach(item => item.classList.toggle("active", item === button));
  document.querySelectorAll(".admin-section").forEach(item => item.classList.toggle("active", item.id === `section-${section}`));
  document.querySelector("#admin-title").textContent = titles[section];
  history.replaceState(null, "", `#${section}`);
}));

function renderSummary(target, values, labels = {}) {
  const box = document.querySelector(target); box.replaceChildren();
  const entries = Object.entries(values || {}); const max = Math.max(1, ...entries.map(([, value]) => Number(value)));
  if (!entries.length) { box.append(node("p", "empty-row", "Ainda não há dados.")); return; }
  for (const [key, value] of entries) {
    const row = node("div", "summary-row"); row.append(node("span", "", labels[key] || key));
    const bar = node("i"); const fill = node("b"); fill.style.width = `${Math.max(4, Number(value) / max * 100)}%`; bar.append(fill); row.append(bar, node("strong", "", String(value))); box.append(row);
  }
}

async function loadOverview() {
  const data = (await withTimeout(api.overview(), "A visão geral")).data;
  const metrics = [["Empresas", data.organizations, "contas cadastradas"], ["Usuários", data.users, "perfis no sistema"], ["Planos", data.plans, "opções comerciais"], ["Ciclo atual", data.month, "controle mensal"]];
  const grid = document.querySelector("#admin-metrics"); grid.replaceChildren(...metrics.map(([label, value, hint]) => { const card = node("article", "metric-card"); card.append(node("span", "", label), node("strong", "", String(value)), node("small", "", hint)); return card; }));
  renderSummary("#status-summary", data.statuses, { active: "Ativas", trial: "Em teste", suspended: "Suspensas", onboarding: "Onboarding" });
  const planNames = Object.fromEntries(state.plans.map(plan => [plan.id, plan.name])); renderSummary("#plan-summary", data.planCounts, planNames);
}

function field(label, key, value, type = "text") { const wrapper = node("label"); wrapper.append(document.createTextNode(label)); const input = document.createElement("input"); input.type = type; input.name = key; input.value = value ?? ""; wrapper.append(input); return wrapper; }
function planCard(plan) {
  const form = node("form", "plan-editor"); form.dataset.id = plan.id;
  const heading = node("header"); heading.append(node("strong", "", plan.name), node("small", "", plan.id)); form.append(heading);
  form.append(field("Nome", "name", plan.name), field("Chamada curta", "title", plan.title || ""), field("Preço mensal", "price", plan.price, "number"), field("Texto abaixo do preço", "subtitle", plan.subtitle || ""));
  form.querySelector('[name="price"]').step = "0.01";
  const description = node("label"); description.append(document.createTextNode("Descrição")); const textarea = document.createElement("textarea"); textarea.name = "description"; textarea.value = plan.description || ""; description.append(textarea); form.append(description);
  const limits = node("div", "plan-limit-grid"); limits.append(field("Profissionais", "professionals", plan.limits.professionals, "number"), field("Agendamentos/mês", "appointmentsPerMonth", plan.limits.appointmentsPerMonth, "number"), field("Lembretes/mês", "remindersPerMonth", plan.limits.remindersPerMonth, "number"), field("Flows", "flows", plan.limits.flows, "number")); form.append(limits);
  const pix = node("label", "switch-label"); pix.append(document.createTextNode("Pix e sinal")); const pixInput = document.createElement("input"); pixInput.type = "checkbox"; pixInput.name = "pix"; pixInput.checked = plan.limits.pix; pix.append(pixInput); form.append(pix);
  const automation = node("label"); automation.append(document.createTextNode("Automações")); const select = document.createElement("select"); select.name = "automations"; select.append(new Option("Básicas", "basic"), new Option("Completas", "full")); select.value = plan.limits.automations; automation.append(select); form.append(automation);
  const active = node("label", "switch-label"); active.append(document.createTextNode("Plano disponível")); const activeInput = document.createElement("input"); activeInput.type = "checkbox"; activeInput.name = "active"; activeInput.checked = plan.active; active.append(activeInput); form.append(active);
  const prefer = node("label", "switch-label"); prefer.append(document.createTextNode("Destacar como mais escolhido")); const preferInput = document.createElement("input"); preferInput.type = "checkbox"; preferInput.name = "prefer"; preferInput.checked = plan.prefer === true; prefer.append(preferInput); form.append(prefer);
  const save = node("button", "primary-button", "Salvar plano"); save.type = "submit"; form.append(save);
  form.addEventListener("submit", async event => { event.preventDefault(); save.disabled = true; save.textContent = "Salvando…"; const data = new FormData(form); try { await api.savePlan({ id: plan.id, name: data.get("name"), title: data.get("title"), price: Number(data.get("price")), subtitle: data.get("subtitle"), description: data.get("description"), prefer: preferInput.checked, active: activeInput.checked, limits: { professionals: Number(data.get("professionals")), appointmentsPerMonth: Number(data.get("appointmentsPerMonth")), remindersPerMonth: Number(data.get("remindersPerMonth")), flows: Number(data.get("flows")), pix: pixInput.checked, automations: data.get("automations") } }); feedback("Plano e limites atualizados."); await loadPlans(); await loadOverview(); } catch (error) { feedback(message(error), true); } finally { save.disabled = false; save.textContent = "Salvar plano"; } });
  return form;
}

function capacityPackageCard(item) {
  const form = node("form", `capacity-package-editor${item.featured ? " featured" : ""}`); form.dataset.id = item.id;
  const heading = node("header"); const title = node("div"); title.append(node("strong", "", item.name), node("small", "", item.id)); heading.append(title, node("span", "capacity-price", money(item.priceCents / 100))); form.append(heading);
  const grid = node("div", "capacity-field-grid");
  grid.append(field("Nome", "name", item.name), field("Preço (R$)", "price", item.priceCents / 100, "number"), field("Lembretes", "reminders", item.reminders, "number"), field("Agendamentos", "appointments", item.appointments, "number"), field("Ordem", "sortOrder", item.sortOrder, "number"));
  grid.querySelector('[name="price"]').step = "0.01"; grid.querySelector('[name="price"]').min = "1";
  grid.querySelectorAll('[type="number"]:not([name="price"])').forEach(input => { input.min = input.name === "sortOrder" ? "0" : "1"; input.step = "1"; });
  form.append(grid);
  const active = node("label", "switch-label"); active.append(document.createTextNode("Disponível para venda")); const activeInput = document.createElement("input"); activeInput.type = "checkbox"; activeInput.checked = item.active; active.append(activeInput); form.append(active);
  const featured = node("label", "switch-label"); featured.append(document.createTextNode("Destacar no painel")); const featuredInput = document.createElement("input"); featuredInput.type = "checkbox"; featuredInput.checked = item.featured; featured.append(featuredInput); form.append(featured);
  const note = node("p", "package-admin-note", "Compras já emitidas mantêm o preço e as quantidades anteriores."); form.append(note);
  const save = node("button", "primary-button", "Salvar pacote"); save.type = "submit"; form.append(save);
  form.addEventListener("submit", async event => {
    event.preventDefault(); save.disabled = true; save.textContent = "Salvando…"; const data = new FormData(form);
    try {
      await api.savePlan({ entity: "capacity_package", id: item.id, name: data.get("name"), price: Number(data.get("price")), reminders: Number(data.get("reminders")), appointments: Number(data.get("appointments")), sortOrder: Number(data.get("sortOrder")), active: activeInput.checked, featured: featuredInput.checked });
      feedback("Pacote atualizado e disponível no painel do estabelecimento."); await loadPlans(); await loadAudit();
    } catch (error) { feedback(message(error), true); }
    finally { save.disabled = false; save.textContent = "Salvar pacote"; }
  });
  return form;
}

async function loadPlans() {
  const data = (await withTimeout(api.plans(), "A lista de planos e pacotes")).data;
  state.plans = data.plans || []; state.capacityPackages = data.capacityPackages || [];
  document.querySelector("#admin-plans").replaceChildren(...state.plans.map(planCard));
  const packages = document.querySelector("#admin-capacity-packages"); packages.replaceChildren(...state.capacityPackages.map(capacityPackageCard));
  if (!state.capacityPackages.length) packages.append(node("p", "empty-row", "Nenhum pacote configurado."));
}

function segmentCard(segment) {
  const form = node("form", "segment-editor"); form.dataset.id = segment.id;
  const heading = node("header"); const title = node("div"); title.append(node("strong", "", segment.name), node("small", "", segment.id));
  const enabled = node("label", "switch-label"); enabled.append(document.createTextNode("Ativo")); const enabledInput = document.createElement("input"); enabledInput.type = "checkbox"; enabledInput.checked = segment.active !== false; enabled.append(enabledInput); heading.append(title, enabled); form.append(heading);
  const fields = node("div", "segment-fields"); fields.append(field("Nome exibido", "name", segment.name), field("Ordem", "sortOrder", segment.sortOrder, "number")); fields.querySelector('[name="sortOrder"]').min = "0"; fields.querySelector('[name="sortOrder"]').max = "10000"; form.append(fields);
  const picker = node("div", "screen-picker");
  Object.entries(screenLabels).forEach(([key, label]) => { const option = node("label", `screen-option${essentialScreens.has(key) ? " locked" : ""}`); option.append(document.createTextNode(label)); const input = document.createElement("input"); input.type = "checkbox"; input.value = key; input.checked = essentialScreens.has(key) || segment.screens.includes(key); input.disabled = essentialScreens.has(key); option.append(input); picker.append(option); });
  form.append(picker); const save = node("button", "primary-button", "Salvar segmento"); save.type = "submit"; form.append(save);
  form.addEventListener("submit", event => { event.preventDefault(); const data = new FormData(form); const screens = [...picker.querySelectorAll('input:checked')].map(input => input.value); return withButtonBusy(save, async () => { try { await api.saveSegment({ id: segment.id, name: data.get("name"), sortOrder: Number(data.get("sortOrder")), active: enabledInput.checked, screens }); feedback("Segmento e telas atualizados."); await Promise.all([loadSegments(), loadAudit()]); } catch (error) { feedback(message(error), true); } }, "Salvando…"); });
  return form;
}

async function loadSegments() {
  const result = (await withTimeout(api.segments(), "A lista de segmentos")).data;
  state.segments = result.segments || [];
  const grid = document.querySelector("#admin-segments"); grid.replaceChildren(...state.segments.map(segmentCard));
  if (!state.segments.length) grid.append(node("p", "empty-row", "Nenhum segmento configurado."));
}

async function loadMaintenance() {
  const input = document.querySelector("#site-maintenance");
  const status = document.querySelector("#maintenance-status");
  const result = (await withTimeout(api.maintenance(), "O estado do site")).data;
  input.checked = result.maintenance === true;
  input.disabled = false;
  status.textContent = input.checked ? "Manutenção ativa" : "Site disponível";
}

function organizationRow(item) {
  const tr = document.createElement("tr"); const company = document.createElement("td"); company.append(node("strong", "", item.name), node("small", "", `${item.whatsapp || item.id} · ${item.segment || "Sem segmento"}`)); tr.append(company);
  const planCell = document.createElement("td"); const planSelect = document.createElement("select"); planSelect.append(...state.plans.filter(plan => plan.active).map(plan => new Option(`${plan.name} · ${money(plan.price)}`, plan.id))); planSelect.value = item.planId; planSelect.setAttribute("aria-label", `Plano de ${item.name}`); planSelect.style.height = "34px"; planCell.append(planSelect); tr.append(planCell);
  const plan = state.plans.find(candidate => candidate.id === item.planId); const appointmentLimit = plan?.limits.appointmentsPerMonth ?? "—"; const reminderLimit = plan?.limits.remindersPerMonth ?? "—";
  const usage = document.createElement("td"); usage.className = "usage-copy"; usage.append(node("strong", "", `${item.usage.appointments}/${appointmentLimit} agendamentos`), node("span", "", `${item.usage.reminders}/${reminderLimit} lembretes · ${item.planName}`)); tr.append(usage);
  const status = document.createElement("td"); status.append(node("span", `status-pill ${item.status}`, statusLabel(item.status))); tr.append(status);
  const actionsCell = document.createElement("td"); const actions = node("div", "actions"); const savePlan = node("button", "row-action", "Alterar plano"); const changeSegment = node("button", "row-action", "Segmento"); const support = node("button", "row-action", "Suporte"); const suspension = node("button", `row-action ${item.status === "suspended" ? "" : "danger"}`, item.status === "suspended" ? "Reativar" : "Suspender"); actions.append(savePlan, changeSegment, support, suspension); actionsCell.append(actions); tr.append(actionsCell);
  savePlan.addEventListener("click", () => { if (planSelect.value === item.planId) return feedback("Selecione outro plano.", true); if (!confirm(`Alterar o plano de ${item.name}?`)) return; return withButtonBusy(savePlan, () => organizationAction(item, { action: "change_plan", planId: planSelect.value }), "Alterando…"); });
  changeSegment.addEventListener("click", () => openSegmentChange(item));
  suspension.addEventListener("click", () => { if (item.status === "suspended") { if (confirm(`Reativar ${item.name}?`)) return withButtonBusy(suspension, () => organizationAction(item, { action: "reactivate" }), "Reativando…"); return; } const reason = prompt(`Motivo da suspensão de ${item.name}:`); if (reason) return withButtonBusy(suspension, () => organizationAction(item, { action: "suspend", reason }), "Suspendendo…"); });
  support.addEventListener("click", () => openSupport(item)); return tr;
}

async function organizationAction(item, payload) { try { await api.updateOrganization({ organizationId: item.id, ...payload }); feedback("Empresa atualizada."); await Promise.all([loadOrganizations(), loadOverview(), loadAudit()]); return true; } catch (error) { feedback(message(error), true); return false; } }

let segmentOrganization = null;
function openSegmentChange(item) {
  segmentOrganization = item; const dialog = document.querySelector("#segment-change-dialog"); const select = document.querySelector("#organization-segment-select");
  select.replaceChildren(...state.segments.filter(segment => segment.active).map(segment => new Option(segment.name, segment.name))); select.value = item.segment;
  document.querySelector("#segment-change-copy").textContent = `Escolha quais telas e recursos serão usados por ${item.name}.`; dialog.showModal();
}
async function loadOrganizations() { const result = (await withTimeout(api.organizations({ search: document.querySelector("#organization-search").value, status: document.querySelector("#organization-status").value }), "A lista de empresas")).data; state.organizations = result.organizations; document.querySelector("#organization-total").textContent = `${result.total} empresa${result.total === 1 ? "" : "s"}`; const body = document.querySelector("#organizations-body"); body.replaceChildren(...result.organizations.map(organizationRow)); if (!result.organizations.length) { const tr = document.createElement("tr"); const td = node("td", "empty-row", "Nenhuma empresa encontrada."); td.colSpan = 5; tr.append(td); body.append(tr); } }

async function openSupport(item) { const reason = prompt(`Informe o motivo do acesso de suporte a ${item.name}:`); if (!reason) return; try { const data = (await api.support({ organizationId: item.id, reason })).data; document.querySelector("#support-title").textContent = data.organization.name; const values = [["Status", statusLabel(data.organization.status)], ["Plano", data.organization.planName], ["Profissionais", data.counts.professionals], ["Serviços", data.counts.services], ["Agendamentos", data.counts.appointments], ["Conversas", data.counts.conversations], ["WhatsApp", data.integrations.whatsapp ? "Conectado" : "Desconectado"], ["Mercado Pago", data.integrations.mercadoPago ? "Conectado" : "Desconectado"], ["Uso mensal", `${data.usage.appointments} agend. · ${data.usage.reminders} lembretes`]]; const content = node("div", "support-grid"); content.append(...values.map(([label, value]) => { const card = node("div", "support-item"); card.append(node("small", "", label), node("strong", "", String(value))); return card; })); document.querySelector("#support-content").replaceChildren(content); document.querySelector("#support-dialog").showModal(); await loadAudit(); } catch (error) { feedback(message(error), true); } }

async function loadAudit() { const logs = (await withTimeout(api.audit(), "O histórico de auditoria")).data.logs; const body = document.querySelector("#audit-body"); body.replaceChildren(...logs.map(log => { const tr = document.createElement("tr"); [date(log.createdAt), log.actorEmail, log.action, `${log.targetType}: ${log.targetId}`, JSON.stringify(log.details)].forEach(value => tr.append(node("td", "", value))); return tr; })); if (!logs.length) { const tr = document.createElement("tr"); const td = node("td", "empty-row", "Nenhuma ação registrada."); td.colSpan = 5; tr.append(td); body.append(tr); } }

let searchTimer;
document.querySelector("#organization-search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadOrganizations().catch(error => feedback(message(error), true)), 350); });
document.querySelector("#organization-status").addEventListener("change", () => loadOrganizations().catch(error => feedback(message(error), true)));
document.querySelector("#refresh-organizations").addEventListener("click", event => withButtonBusy(event.currentTarget, () => loadOrganizations().catch(error => feedback(message(error), true)), "Atualizando…"));
document.querySelector("#refresh-audit").addEventListener("click", event => withButtonBusy(event.currentTarget, () => loadAudit().catch(error => feedback(message(error), true)), "Atualizando…"));
document.querySelector("#new-plan").addEventListener("click", () => { const name = prompt("Nome do novo plano:"); if (!name?.trim()) return; const id = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100) || `plano-${Date.now()}`; document.querySelector("#admin-plans").prepend(planCard({ id, name: name.trim(), title: "", subtitle: "", price: 0, description: "", prefer: false, active: true, limits: { professionals: 1, appointmentsPerMonth: 50, remindersPerMonth: 20, flows: 1, pix: false, automations: "basic" } })); });
document.querySelector("#new-capacity-package").addEventListener("click", () => { const name = prompt("Nome do novo pacote:"); if (!name?.trim()) return; const id = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || `pacote-${Date.now()}`; document.querySelector("#admin-capacity-packages").prepend(capacityPackageCard({ id, name: name.trim(), priceCents: 1990, reminders: 100, appointments: 100, sortOrder: (state.capacityPackages.length + 1) * 10, active: true, featured: false })); });
document.querySelector("#new-segment").addEventListener("click", () => { const name = prompt("Nome do novo segmento:"); if (!name?.trim()) return; const id = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || `segmento-${Date.now()}`; document.querySelector("#admin-segments").prepend(segmentCard({ id, name: name.trim(), screens: [...essentialScreens], sortOrder: (state.segments.length + 1) * 10, active: true })); });
document.querySelector("#site-maintenance").addEventListener("change", async event => {
  const input = event.currentTarget; const next = input.checked;
  if (next && !confirm("Ativar a manutenção agora? Clientes e empresas perderão temporariamente o acesso ao site e aos painéis.")) { input.checked = false; return; }
  input.disabled = true; document.querySelector("#maintenance-status").textContent = "Salvando…";
  try { await api.setMaintenance({ maintenance: next }); document.querySelector("#maintenance-status").textContent = next ? "Manutenção ativa" : "Site disponível"; feedback(next ? "Modo de manutenção ativado." : "Site liberado novamente."); await loadAudit(); }
  catch (error) { input.checked = !next; document.querySelector("#maintenance-status").textContent = input.checked ? "Manutenção ativa" : "Site disponível"; feedback(message(error), true); }
  finally { input.disabled = false; }
});
document.querySelector("#admin-sign-out").addEventListener("click", async () => { await signOut(auth); location.assign("./login.html"); });
document.querySelector("#support-dialog .dialog-close").addEventListener("click", () => document.querySelector("#support-dialog").close());
document.querySelector("#segment-change-dialog .dialog-close").addEventListener("click", () => document.querySelector("#segment-change-dialog").close());
document.querySelector("#segment-change-cancel").addEventListener("click", () => document.querySelector("#segment-change-dialog").close());
document.querySelector("#segment-change-save").addEventListener("click", event => { const segment = document.querySelector("#organization-segment-select").value; if (!segmentOrganization || !segment || segment === segmentOrganization.segment) return document.querySelector("#segment-change-dialog").close(); return withButtonBusy(event.currentTarget, async () => { if (await organizationAction(segmentOrganization, { action: "change_segment", segment })) document.querySelector("#segment-change-dialog").close(); }, "Salvando…"); });

const authWatchdog = setTimeout(() => {
  if (!loading.hidden && !loading.querySelector(".admin-loading-actions")) {
    showAccessError(new Error("O Firebase não respondeu à validação da sessão."));
  }
}, AUTH_TIMEOUT + 2000);

onAuthStateChanged(auth, async user => {
  if (!user) { location.replace("./login.html?return=admin"); return; }
  try {
    await getAdminToken(user);
    clearTimeout(authWatchdog);
    window.__automichatAdminReady = true;
    document.querySelector("#admin-email").textContent = user.email || user.uid;
    loading.hidden = true; shell.hidden = false;
    const initial = location.hash.slice(1); if (titles[initial]) document.querySelector(`[data-section="${initial}"]`).click();
    try { await Promise.all([loadPlans(), loadSegments(), loadMaintenance()]); } catch (error) { feedback(message(error), true); }
    const results = await Promise.allSettled([loadOverview(), loadOrganizations(), loadAudit()]);
    const failure = results.find(result => result.status === "rejected");
    if (failure) feedback(message(failure.reason), true);
  } catch (error) { clearTimeout(authWatchdog); showAccessError(error); }
});
