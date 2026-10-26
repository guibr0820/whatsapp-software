import {
  createUserWithEmailAndPassword,
  deleteUser,
  getAdditionalUserInfo,
  sendEmailVerification,
  signInWithPopup,
  updateProfile
} from "firebase/auth";
import { doc, getDoc, serverTimestamp, writeBatch } from "firebase/firestore";
import { auth, authErrorMessage, googleProvider } from "./auth.js";
import { db } from "./firebase-config.js";

const form = document.querySelector("#signup-form");
const phoneInput = document.querySelector("#whatsapp");
const submitButton = document.querySelector("#submit-button");
const googleButton = document.querySelector("#google-signup");
const submitError = document.querySelector("#submit-error");
const query = new URLSearchParams(window.location.search);
const selectedPlan = (query.get("plano") || "").replace(/[^a-z0-9-]/gi, "").slice(0, 80);

phoneInput.addEventListener("input", () => {
  const digits = phoneInput.value.replace(/\D/g, "").slice(0, 11);
  let formatted = digits.length ? `(${digits.slice(0, 2)}` : "";
  if (digits.length >= 3) formatted += `) ${digits.slice(2, digits.length > 10 ? 7 : 6)}`;
  if (digits.length > (digits.length > 10 ? 7 : 6)) formatted += `-${digits.slice(digits.length > 10 ? 7 : 6)}`;
  phoneInput.value = formatted;
});

document.querySelectorAll("[data-password-toggle]").forEach((button) => {
  button.addEventListener("click", () => {
    const input = document.querySelector(`#${button.dataset.passwordToggle}`);
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    button.textContent = showing ? "Mostrar" : "Ocultar";
  });
});

function value(id) {
  return document.querySelector(`#${id}`).value.trim();
}

function setInvalid(name, invalid) {
  const wrapper = form.querySelector(`[data-field="${name}"]`);
  wrapper?.classList.toggle("invalid", invalid);
  wrapper?.querySelector("input, select")?.setAttribute("aria-invalid", String(invalid));
  return invalid;
}

function validateForm() {
  const password = value("senha");
  let invalid = false;
  invalid = setInvalid("nome", value("nome").split(/\s+/).filter(Boolean).length < 2) || invalid;
  invalid = setInvalid("email", !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value("email"))) || invalid;
  invalid = setInvalid("whatsapp", phoneInput.value.replace(/\D/g, "").length < 10) || invalid;
  invalid = setInvalid("senha", password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) || invalid;
  invalid = setInvalid("confirmar-senha", value("confirmar-senha") !== password) || invalid;
  invalid = setInvalid("termos", !document.querySelector("#termos").checked) || invalid;
  return !invalid;
}

function trackingData() {
  return {
    plano: selectedPlan,
    origem_cta: (query.get("origem_cta") || "direto").slice(0, 30),
    utm_source: (query.get("utm_source") || "").slice(0, 100),
    utm_medium: (query.get("utm_medium") || "").slice(0, 100),
    utm_campaign: (query.get("utm_campaign") || "").slice(0, 100)
  };
}

async function createInitialDocuments(user, details) {
  const userReference = doc(db, "users", user.uid);
  if ((await getDoc(userReference)).exists()) return;

  const tracking = trackingData();
  const batch = writeBatch(db);
  batch.set(userReference, {
    uid: user.uid,
    nome: details.nome.slice(0, 100),
    email: (user.email || details.email).slice(0, 254),
    whatsapp: details.whatsapp,
    foto_url: (user.photoURL || "").slice(0, 500),
    organizacao_id: "",
    onboarding_concluido: false,
    aceitou_termos: details.aceitouTermos,
    aceitou_marketing: details.aceitouMarketing,
    criado_em: serverTimestamp(),
    atualizado_em: serverTimestamp()
  });
  batch.set(doc(db, "leads", user.uid), {
    uid: user.uid,
    nome: details.nome.slice(0, 100),
    email: (user.email || details.email).slice(0, 254),
    whatsapp: details.whatsapp,
    aceitou_termos: details.aceitouTermos,
    aceitou_marketing: details.aceitouMarketing,
    plano: tracking.plano,
    origem_cta: tracking.origem_cta,
    utm_source: tracking.utm_source,
    utm_medium: tracking.utm_medium,
    utm_campaign: tracking.utm_campaign,
    etapa: "conta_criada",
    criado_em: serverTimestamp()
  });
  await batch.commit();
}

function setLoading(loading, label = "Criando sua conta…") {
  submitButton.disabled = loading;
  googleButton.disabled = loading;
  submitButton.querySelector(".button-label").hidden = loading;
  const loadingElement = submitButton.querySelector(".button-loading");
  loadingElement.textContent = label;
  loadingElement.hidden = !loading;
}

function goToOnboarding() {
  const destination = new URL("./onboarding.html", window.location.href);
  if (selectedPlan) destination.searchParams.set("plano", selectedPlan);
  window.location.assign(destination.href);
}

form.addEventListener("input", (event) => event.target.closest("[data-field]")?.classList.remove("invalid"));

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submitError.hidden = true;
  if (!validateForm()) {
    form.querySelector(".invalid")?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  setLoading(true);
  let createdUser = null;
  try {
    const credential = await createUserWithEmailAndPassword(auth, value("email"), value("senha"));
    createdUser = credential.user;
    await updateProfile(credential.user, { displayName: value("nome") });
    await createInitialDocuments(credential.user, {
      nome: value("nome"), email: value("email"),
      whatsapp: `+55${phoneInput.value.replace(/\D/g, "")}`,
      aceitouTermos: true,
      aceitouMarketing: document.querySelector("#marketing").checked
    });
    sendEmailVerification(credential.user).catch(() => {});
    goToOnboarding();
  } catch (error) {
    if (createdUser) await deleteUser(createdUser).catch(() => {});
    submitError.textContent = authErrorMessage(error);
    submitError.hidden = false;
    submitError.scrollIntoView({ behavior: "smooth", block: "center" });
  } finally {
    setLoading(false);
  }
});

googleButton.addEventListener("click", async () => {
  submitError.hidden = true;
  if (!document.querySelector("#termos").checked) {
    setInvalid("termos", true);
    document.querySelector('[data-field="termos"]').scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  setLoading(true, "Conectando ao Google…");
  let newGoogleUser = null;
  try {
    const credential = await signInWithPopup(auth, googleProvider);
    if (getAdditionalUserInfo(credential)?.isNewUser) newGoogleUser = credential.user;
    await createInitialDocuments(credential.user, {
      nome: credential.user.displayName || "Usuário clickchat",
      email: credential.user.email || "",
      whatsapp: "",
      aceitouTermos: true,
      aceitouMarketing: document.querySelector("#marketing").checked
    });
    goToOnboarding();
  } catch (error) {
    if (newGoogleUser) await deleteUser(newGoogleUser).catch(() => {});
    submitError.textContent = authErrorMessage(error);
    submitError.hidden = false;
  } finally {
    setLoading(false);
  }
});
