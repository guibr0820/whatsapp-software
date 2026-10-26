import { onAuthStateChanged, signOut } from "firebase/auth";
import { collection, doc, getDoc, getDocs, serverTimestamp, writeBatch } from "firebase/firestore";
import { auth } from "./auth.js";
import { db } from "./firebase-config.js";

const loading = document.querySelector("#auth-loading");
const plansView = document.querySelector("#plans-view");
const successView = document.querySelector("#success-view");
const list = document.querySelector("#plans-list");
const errorBox = document.querySelector("#plans-error");
const preferredPlan = new URLSearchParams(window.location.search).get("plano") || "";
let currentUser = null;
let organizationId = "";

function slug(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function money(value) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value) || 0);
}

function showSuccess() {
  loading.hidden = true;
  plansView.hidden = true;
  successView.hidden = false;
}

function createText(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function renderPlans(plans) {
  list.replaceChildren();
  plans.sort((a, b) => Number(a.price) - Number(b.price));
  for (const plan of plans) {
    const card = document.createElement("article");
    card.className = "selection-card";
    const wasPreferred = preferredPlan && slug(plan.name) === slug(preferredPlan);
    if (plan.prefer === true || wasPreferred) card.classList.add("preferred");
    if (plan.prefer === true) card.append(createText("span", "plan-badge", "Mais escolhido"));
    else if (wasPreferred) card.append(createText("span", "plan-badge", "Sua escolha inicial"));
    card.append(
      createText("p", "plan-eyebrow", plan.title || "Plano clickchat"),
      createText("h2", "", plan.name),
      createText("p", "plan-description", plan.description || "Automação para o atendimento da sua empresa.")
    );
    const price = createText("p", "plan-price", money(plan.price));
    price.append(createText("span", "", "/mês"));
    card.append(price);
    if (plan.subtitle) card.append(createText("p", "plan-subtitle", plan.subtitle));
    const button = createText("button", "plan-choice-button", "Escolher este plano");
    button.type = "button";
    button.addEventListener("click", () => choosePlan(plan, button));
    card.append(button);
    list.append(card);
  }
}

async function choosePlan(plan, selectedButton) {
  errorBox.hidden = true;
  list.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  selectedButton.textContent = "Salvando plano…";
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, "organizations", organizationId), {
      plano_id: plan.id,
      plano_nome: plan.name,
      plano_preco: Number(plan.price),
      status: "trial",
      atualizado_em: serverTimestamp()
    });
    batch.update(doc(db, "users", currentUser.uid), { onboarding_concluido: true, atualizado_em: serverTimestamp() });
    await batch.commit();
    showSuccess();
  } catch (error) {
    console.error(error);
    errorBox.textContent = "Não foi possível salvar o plano. Atualize a página e tente novamente.";
    errorBox.hidden = false;
    list.querySelectorAll("button").forEach((button) => { button.disabled = false; });
    selectedButton.textContent = "Escolher este plano";
  }
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.replace("./login.html");
    return;
  }
  currentUser = user;
  try {
    const profile = await getDoc(doc(db, "users", user.uid));
    if (!profile.exists()) throw new Error("Seu perfil não foi encontrado.");
    const data = profile.data();
    if (data.onboarding_concluido) {
      showSuccess();
      return;
    }
    if (!data.organizacao_id) {
      window.location.replace("./onboarding.html");
      return;
    }
    organizationId = data.organizacao_id;
    const snapshot = await getDocs(collection(db, "plans"));
    const plans = snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).filter((plan) => typeof plan.name === "string" && typeof plan.price === "number");
    if (!plans.length) throw new Error("Nenhum plano foi cadastrado ainda na coleção plans.");
    renderPlans(plans);
    loading.hidden = true;
    plansView.hidden = false;
  } catch (error) {
    loading.textContent = error.message || "Não foi possível carregar os planos.";
  }
});

async function leave() {
  await signOut(auth);
  window.location.replace("./login.html");
}

document.querySelector("#sign-out").addEventListener("click", leave);
document.querySelector("#success-sign-out").addEventListener("click", leave);
