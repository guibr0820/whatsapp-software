import { sendPasswordResetEmail, signInWithEmailAndPassword, signInWithPopup, signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, authErrorMessage, googleProvider } from "./auth.js";
import { db } from "./firebase-config.js";

const form = document.querySelector("#login-form");
const errorBox = document.querySelector("#submit-error");
const successBox = document.querySelector("#success-message");
const loginButton = document.querySelector("#login-button");
const googleButton = document.querySelector("#google-login");

document.querySelector("[data-password-toggle]").addEventListener("click", (event) => {
  const input = document.querySelector("#senha");
  const showing = input.type === "text";
  input.type = showing ? "password" : "text";
  event.currentTarget.textContent = showing ? "Mostrar" : "Ocultar";
});

function setLoading(loading) {
  loginButton.disabled = loading;
  googleButton.disabled = loading;
  loginButton.querySelector(".button-label").hidden = loading;
  loginButton.querySelector(".button-loading").hidden = !loading;
}

async function redirectAuthenticatedUser(user) {
  const snapshot = await getDoc(doc(db, "users", user.uid));
  if (!snapshot.exists()) {
    await signOut(auth);
    const error = new Error("Perfil não encontrado");
    error.code = "auth/user-not-found";
    throw error;
  }
  const data = snapshot.data();
  if (data.onboarding_concluido === true) {
    window.location.assign("./dashboard.html");
  } else if (data.organizacao_id) {
    window.location.assign("./plans.html");
  } else {
    window.location.assign("./onboarding.html");
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  successBox.hidden = true;
  const email = document.querySelector("#email").value.trim();
  const password = document.querySelector("#senha").value;
  const invalidEmail = !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
  form.querySelector('[data-field="email"]').classList.toggle("invalid", invalidEmail);
  form.querySelector('[data-field="senha"]').classList.toggle("invalid", !password);
  if (invalidEmail || !password) return;
  setLoading(true);
  try {
    const credential = await signInWithEmailAndPassword(auth, email, password);
    await redirectAuthenticatedUser(credential.user);
  } catch (error) {
    errorBox.textContent = authErrorMessage(error);
    errorBox.hidden = false;
  } finally { setLoading(false); }
});

googleButton.addEventListener("click", async () => {
  errorBox.hidden = true;
  setLoading(true);
  try {
    const credential = await signInWithPopup(auth, googleProvider);
    await redirectAuthenticatedUser(credential.user);
  } catch (error) {
    errorBox.textContent = authErrorMessage(error);
    errorBox.hidden = false;
  } finally { setLoading(false); }
});

document.querySelector("#forgot-password").addEventListener("click", async () => {
  errorBox.hidden = true;
  successBox.hidden = true;
  const email = document.querySelector("#email").value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    errorBox.textContent = "Digite seu e-mail acima para receber o link de recuperação.";
    errorBox.hidden = false;
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
    successBox.textContent = "Enviamos o link de recuperação. Confira também a pasta de spam.";
    successBox.hidden = false;
  } catch (error) {
    errorBox.textContent = authErrorMessage(error);
    errorBox.hidden = false;
  }
});
