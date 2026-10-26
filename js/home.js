import { onAuthStateChanged } from "firebase/auth";
import { collection, doc, getDoc, getDocs } from "firebase/firestore";
import "./analytics.js";
import { auth } from "./auth.js";
import { db } from "./firebase-config.js";

const trackingKeys = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
const currentParams = new URLSearchParams(window.location.search);
const plansList = document.querySelector("#plans-list");
let accountState = { type: "visitor", destination: "./signup-screen.html" };

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
    if (accountState.type === "complete") {
      link.href = trackedUrl("./dashboard.html");
      setLinkLabel(link, "Acessar painel");
    } else if (accountState.type === "incomplete") {
      const destination = new URL(accountState.destination, window.location.href);
      if (plan) destination.searchParams.set("plano", plan);
      link.href = trackedUrl(destination.href);
      setLinkLabel(link, "Continuar cadastro");
    } else {
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
    const card = document.createElement("article");
    card.className = `plan${plan.prefer === true ? " hot" : ""}`;
    if (plan.prefer === true) card.append(textElement("div", "badge", "✦ Mais escolhido"));
    card.append(
      textElement("div", "kicker", plan.title || "Plano clickchat"),
      textElement("h3", "", plan.name),
      textElement("p", "d", plan.description || "Automação para o atendimento da sua empresa.")
    );
    const price = textElement("div", "price", money(plan.price));
    price.append(textElement("small", "", "/mês"));
    card.append(price, textElement("div", "trial", "Após 14 dias grátis. Na assinatura mensal"));

    const link = document.createElement("a");
    link.className = "btn2";
    link.dataset.signupLink = "";
    link.dataset.plan = planSlug;
    link.href = `./signup-screen.html?plano=${encodeURIComponent(planSlug)}&origem_cta=plano`;
    link.append(textElement("span", "", "Começar teste grátis"), textElement("span", "", "→"));
    rememberSignupLink(link);
    card.append(link, textElement("div", "check-item", plan.subtitle || "Automatize tarefas e ganhe tempo."));
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
});

document.querySelectorAll("[data-current-year]").forEach((element) => {
  element.textContent = new Date().getFullYear();
});

document.querySelectorAll("[data-signup-link]").forEach(rememberSignupLink);

loadPlans();
