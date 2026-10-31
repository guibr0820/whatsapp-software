import { onAuthStateChanged, signOut } from "firebase/auth";
import { collection, doc, getDoc, getDocs } from "firebase/firestore";
import "./analytics.js";
import { auth } from "./auth.js";
import { db } from "./firebase-config.js";
import { installButtonProgress } from "./ui-loading.js";

installButtonProgress();

const trackingKeys = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
const currentParams = new URLSearchParams(window.location.search);
const plansList = document.querySelector("#plans-list");
let accountState = { type: "visitor", destination: "./signup-screen.html" };

function closePlanInfoTips() {
  document.querySelectorAll(".flow-feature.tip-open").forEach((item) => {
    item.classList.remove("tip-open");
    item.querySelector(".plan-info-button")?.setAttribute("aria-expanded", "false");
  });
}
document.addEventListener("click", closePlanInfoTips);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closePlanInfoTips(); });

function rememberSignupLink(link) {
  if (!link.dataset.signupPath) {
    const destination = new URL(link.getAttribute("href"), window.location.href);
    link.dataset.signupPath = `${destination.pathname.split("/").pop()}${destination.search}`;
  }
  if (!link.dataset.defaultLabel) {
    link.dataset.defaultLabel = link.querySelector("span:first-child")?.textContent || link.textContent;
  }
}

function slug(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function money(value) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value) || 0);
}

function trackedUrl(path) {
  const destination = new URL(path, window.location.href);
  trackingKeys.forEach((key) => {
    const value = currentParams.get(key);
    if (value) destination.searchParams.set(key, value.slice(0, 100));
  });
  return destination.href;
}

function setLinkLabel(link, label) {
  const textSpan = link.querySelector("span:first-child");
  if (textSpan) textSpan.textContent = label;
  else link.textContent = label;
}

function applyAccountState() {
  const loginLink = document.querySelector("[data-login-link]");
  loginLink.hidden = accountState.type !== "visitor";

  document.querySelectorAll("[data-signup-link]").forEach((link) => {
    rememberSignupLink(link);
    const plan = link.dataset.plan || "";
    const isPlanCard = Boolean(plan);
    if (accountState.type === "complete") {
      if (isPlanCard) {
        link.hidden = false;
        const destination = new URL(link.dataset.signupPath, window.location.href);
        link.href = trackedUrl(destination.href);
        setLinkLabel(link, link.dataset.defaultLabel);
        return;
      }
      link.hidden = false;
      link.href = trackedUrl("./dashboard.html");
      setLinkLabel(link, "Acessar painel");
    } else if (accountState.type === "incomplete") {
      link.hidden = false;
      const destination = new URL(accountState.destination, window.location.href);
      if (plan) destination.searchParams.set("plano", plan);
      link.href = trackedUrl(destination.href);
      setLinkLabel(link, "Continuar cadastro");
    } else {
      link.hidden = false;
      const destination = new URL(link.dataset.signupPath, window.location.href);
      link.href = trackedUrl(destination.href);
      setLinkLabel(link, link.dataset.defaultLabel);
    }
  });
  document.body.classList.add("auth-ready");
}

function textElement(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = value;
  return element;
}

function renderPlans(plans) {
  plansList.replaceChildren();
  plans.sort((a, b) => Number(a.price) - Number(b.price));

  for (const plan of plans) {
    const planSlug = slug(plan.name);
    const hasFreeTrial = planSlug.includes("crescimento");
    const defaults = planSlug.includes("negocio")
      ? {professionals:20,appointmentsPerMonth:2500,remindersPerMonth:5000,flows:10,pix:true,automations:"full"}
      : planSlug.includes("profissional")
        ? {professionals:8,appointmentsPerMonth:800,remindersPerMonth:1600,flows:3,pix:true,automations:"full"}
        : {professionals:2,appointmentsPerMonth:200,remindersPerMonth:400,flows:1,pix:true,automations:"basic"};
    const limits = {...defaults,...(plan.limits && typeof plan.limits === "object" ? plan.limits : {})};
    const summary = planSlug.includes("negocio") ? "Para equipes maiores e operações de alto volume." : planSlug.includes("profissional") ? "Para negócios em crescimento que precisam de mais automação." : "Para começar a automatizar o atendimento com organização.";
    const card = document.createElement("article");
    card.className = `plan${plan.prefer === true ? " hot" : ""}`;
    if (plan.prefer === true) card.append(textElement("div", "badge", "✦ Mais escolhido"));
    card.append(
      textElement("div", "kicker", plan.title || "Plano Automichat"),
      textElement("h3", "", plan.name),
      textElement("p", "plan-summary", summary)
    );
    const price = textElement("div", "price", money(plan.price));
    price.append(textElement("small", "", "/mês"));
    card.append(
      price,
      textElement(
        "div",
        "trial",
        hasFreeTrial ? "14 dias grátis · Cancele quando quiser" : "Assinatura mensal · Cancele quando quiser"
      )
    );

    const capacity = document.createElement("div");
    capacity.className = "plan-capacity";
    capacity.append(textElement("strong", "plan-capacity-title", "Capacidade mensal"));
    const appointmentCapacity = document.createElement("div");
    appointmentCapacity.className = "plan-capacity-row";
    appointmentCapacity.append(textElement("span", "plan-capacity-icon", "▦"), textElement("b", "", `${Number(limits.appointmentsPerMonth).toLocaleString("pt-BR")} agendamentos`), textElement("small", "", "Reservas criadas pelos clientes."));
    const messageCapacity = document.createElement("div");
    messageCapacity.className = "plan-capacity-row";
    messageCapacity.append(textElement("span", "plan-capacity-icon", "◌"), textElement("b", "", `${Number(limits.remindersPerMonth).toLocaleString("pt-BR")} mensagens automáticas`), textElement("small", "", "Confirmações, lembretes e atualizações."));
    capacity.append(appointmentCapacity, messageCapacity);
    card.append(capacity);

    const link = document.createElement("a");
    link.className = "btn2";
    link.dataset.signupLink = "";
    link.dataset.plan = planSlug;
    link.href = `./signup-screen.html?plano=${encodeURIComponent(planSlug)}&origem_cta=plano`;
    link.append(
      textElement("span", "", hasFreeTrial ? "Começar teste grátis" : "Assinar plano"),
      textElement("span", "", "→")
    );
    link.addEventListener("click", (event) => {
      if (accountState.type !== "complete") return;
      event.preventDefault();
      const email = auth.currentUser?.email || "este e-mail";
      const shouldOpenPanel = window.confirm(`Você já tem uma conta com ${email}. Quer ir para o painel?`);
      if (shouldOpenPanel) window.location.assign(trackedUrl("./dashboard.html"));
    });
    rememberSignupLink(link);
    const features = document.createElement("ul");
    features.className = "plan-features";
    const featureLabels = [
      `Até ${Number(limits.professionals).toLocaleString("pt-BR")} profissionais`,
      limits.automations === "full" ? "Automações completas" : "Automações essenciais",
      limits.pix === true ? "Pix integrado pelo Mercado Pago" : "Gestão de pagamentos",
    ];
    features.append(textElement("li", "", featureLabels[0]));
    const flowFeature = document.createElement("li");
    flowFeature.className = "flow-feature";
    flowFeature.append(document.createTextNode(`${Number(limits.flows).toLocaleString("pt-BR")} ${Number(limits.flows) === 1 ? "modelo" : "modelos"} de Flow interativo `));
    const tipId = `flow-tip-${planSlug}`;
    const info = document.createElement("button");
    info.type = "button"; info.className = "plan-info-button"; info.textContent = "i"; info.setAttribute("aria-label", "O que é um modelo de Flow?"); info.setAttribute("aria-describedby", tipId); info.setAttribute("aria-expanded", "false");
    const tip = textElement("span", "plan-info-tip", "É um formulário interativo reutilizável no WhatsApp, como agendamento ou finalização de pedido. O limite indica quantos modelos diferentes podem ser configurados, não quantas vezes podem ser enviados.");
    tip.id = tipId; tip.setAttribute("role", "tooltip");
    info.addEventListener("click", (event) => { event.stopPropagation(); const open = !flowFeature.classList.contains("tip-open"); document.querySelectorAll(".flow-feature.tip-open").forEach((item) => { item.classList.remove("tip-open"); item.querySelector("button")?.setAttribute("aria-expanded", "false"); }); flowFeature.classList.toggle("tip-open", open); info.setAttribute("aria-expanded", String(open)); });
    flowFeature.append(info, tip);
    features.append(flowFeature, textElement("li", "", featureLabels[1]), textElement("li", "", featureLabels[2]));
    card.append(link, features);
    plansList.append(card);
  }
  applyAccountState();
}

async function loadPlans() {
  try {
    // Catálogo pequeno e público: uma leitura simples evita exigir índices e mantém compatibilidade com Live Server.
    const snapshot = await getDocs(collection(db, "plans"));
    const plans = snapshot.docs
      .map((item) => ({ id: item.id, ...item.data() }))
      .filter((plan) => typeof plan.name === "string" && typeof plan.price === "number");
    if (!plans.length) throw new Error("Nenhum plano disponível.");
    renderPlans(plans);
  } catch (error) {
    console.error(error);
    plansList.replaceChildren(textElement("p", "plans-status plans-error", "Não foi possível carregar os planos agora. Tente novamente em instantes."));
  }
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    accountState = { type: "visitor", destination: "./signup-screen.html" };
    applyAccountState();
    syncAccountMenu();
    return;
  }
  try {
    const profile = await getDoc(doc(db, "users", user.uid));
    const data = profile.data();
    if (profile.exists() && data.onboarding_concluido === true) {
      accountState = { type: "complete", destination: "./dashboard.html" };
    } else {
      accountState = { type: "incomplete", destination: data?.organizacao_id ? "./plans.html" : "./onboarding.html" };
    }
  } catch (error) {
    console.error(error);
    accountState = { type: "incomplete", destination: "./onboarding.html" };
  }
  applyAccountState();
  syncAccountMenu();
});

const accountMenuButton = document.querySelector("#account-menu-button");
const accountMenu = document.querySelector("#account-menu");
const accountPrimaryLink = document.querySelector("#account-primary-link");
const accountSignOut = document.querySelector("#account-sign-out");

function syncAccountMenu() {
  const signedIn = accountState.type !== "visitor";
  accountPrimaryLink.textContent = signedIn ? (accountState.type === "complete" ? "Acessar painel" : "Continuar cadastro") : "Entrar";
  accountPrimaryLink.href = signedIn ? trackedUrl(accountState.destination) : "./login.html";
  accountSignOut.hidden = !signedIn;
}

function closeAccountMenu() { accountMenu.hidden = true; accountMenuButton.setAttribute("aria-expanded", "false"); }
accountMenuButton.addEventListener("click", event => { event.stopPropagation(); const open = accountMenu.hidden; accountMenu.hidden = !open; accountMenuButton.setAttribute("aria-expanded", String(open)); });
accountMenu.addEventListener("click", event => event.stopPropagation());
accountSignOut.addEventListener("click", async () => { accountSignOut.disabled = true; accountSignOut.textContent = "Saindo…"; try { await signOut(auth); closeAccountMenu(); window.location.reload(); } finally { accountSignOut.disabled = false; accountSignOut.textContent = "Sair da conta"; } });
document.addEventListener("click", closeAccountMenu);
document.addEventListener("keydown", event => { if (event.key === "Escape") closeAccountMenu(); });

document.querySelectorAll("[data-current-year]").forEach((element) => {
  element.textContent = new Date().getFullYear();
});

document.querySelectorAll("[data-signup-link]").forEach(rememberSignupLink);

loadPlans();
