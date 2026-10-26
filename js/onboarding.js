import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, getDoc, serverTimestamp, writeBatch } from "firebase/firestore";
import { auth } from "./auth.js";
import { db } from "./firebase-config.js";

const loading = document.querySelector("#auth-loading");
const view = document.querySelector("#onboarding-view");
const form = document.querySelector("#onboarding-form");
const phoneInput = document.querySelector("#whatsapp");
const submitButton = document.querySelector("#submit-button");
const submitError = document.querySelector("#submit-error");
let currentUser = null;

phoneInput.addEventListener("input", () => {
  const digits = phoneInput.value.replace(/\D/g, "").slice(0, 11);
  let formatted = digits.length ? `(${digits.slice(0, 2)}` : "";
  if (digits.length >= 3) formatted += `) ${digits.slice(2, digits.length > 10 ? 7 : 6)}`;
  if (digits.length > (digits.length > 10 ? 7 : 6)) formatted += `-${digits.slice(digits.length > 10 ? 7 : 6)}`;
  phoneInput.value = formatted;
});

function fieldValue(id) {
  return document.querySelector(`#${id}`).value.trim();
}

function setInvalid(name, invalid) {
  const wrapper = form.querySelector(`[data-field="${name}"]`);
  wrapper?.classList.toggle("invalid", invalid);
  wrapper?.querySelector("input, select")?.setAttribute("aria-invalid", String(invalid));
  return invalid;
}

function validateForm() {
  let invalid = false;
  invalid = setInvalid("empresa", fieldValue("empresa").length < 2) || invalid;
  invalid = setInvalid("segmento", !fieldValue("segmento")) || invalid;
  invalid = setInvalid("volume", !["ate-20", "21-100", "100+"].includes(fieldValue("volume"))) || invalid;
  invalid = setInvalid("whatsapp", phoneInput.value.replace(/\D/g, "").length < 10) || invalid;
  return !invalid;
}

function setLoading(isLoading) {
  submitButton.disabled = isLoading;
  submitButton.querySelector(".button-label").hidden = isLoading;
  submitButton.querySelector(".button-loading").hidden = !isLoading;
}

function goToPlans() {
  const destination = new URL("./plans.html", window.location.href);
  const plan = new URLSearchParams(window.location.search).get("plano");
  if (plan) destination.searchParams.set("plano", plan.slice(0, 80));
  window.location.assign(destination.href);
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
    if (data.onboarding_concluido || data.organizacao_id) {
      goToPlans();
      return;
    }
    if (data.whatsapp) phoneInput.value = data.whatsapp.replace(/^\+55/, "");
    phoneInput.dispatchEvent(new Event("input"));
    loading.hidden = true;
    view.hidden = false;
  } catch (error) {
    loading.textContent = error.message || "Não foi possível carregar seu perfil.";
  }
});

form.addEventListener("input", (event) => event.target.closest("[data-field]")?.classList.remove("invalid"));

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submitError.hidden = true;
  if (!currentUser || !validateForm()) {
    form.querySelector(".invalid")?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  setLoading(true);
  try {
    const organizationReference = doc(db, "organizations", crypto.randomUUID());
    const memberReference = doc(organizationReference, "members", currentUser.uid);
    const userReference = doc(db, "users", currentUser.uid);
    const whatsapp = `+55${phoneInput.value.replace(/\D/g, "")}`;
    const batch = writeBatch(db);

    batch.set(organizationReference, {
      proprietario_uid: currentUser.uid,
      nome: fieldValue("empresa").slice(0, 120),
      segmento: fieldValue("segmento").slice(0, 60),
      whatsapp,
      volume_conversas: fieldValue("volume"),
      plano_id: "",
      plano_nome: "",
      plano_preco: 0,
      status: "onboarding",
      fuso_horario: "America/Sao_Paulo",
      criado_em: serverTimestamp(),
      atualizado_em: serverTimestamp()
    });
    batch.set(memberReference, { uid: currentUser.uid, papel: "owner", status: "active", criado_em: serverTimestamp() });
    batch.update(userReference, { whatsapp, organizacao_id: organizationReference.id, onboarding_concluido: false, atualizado_em: serverTimestamp() });
    await batch.commit();
    goToPlans();
  } catch (error) {
    console.error(error);
    submitError.textContent = "Não foi possível salvar os dados da empresa. Tente novamente.";
    submitError.hidden = false;
  } finally {
    setLoading(false);
  }
});

document.querySelector("#sign-out").addEventListener("click", async () => {
  await signOut(auth);
  window.location.replace("./login.html");
});

document.querySelector("#back-step").addEventListener("click", () => {
  if (window.history.length > 1) {
    window.history.back();
  } else {
    window.location.assign("./index.html");
  }
});
