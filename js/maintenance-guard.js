import { getFunctions, httpsCallable } from "firebase/functions";
import { getAuth } from "firebase/auth";
import { app } from "./firebase-config.js";

const isAdminLogin = location.pathname.endsWith("/login.html") && new URLSearchParams(location.search).get("return") === "admin";
let gate = null;

if (!isAdminLogin) {
  gate = document.createElement("div");
  gate.className = "maintenance-check";
  gate.setAttribute("aria-hidden", "true");
  document.documentElement.append(gate);
}

const releasePage = () => gate?.remove();

const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 6000));

try {
  if (isAdminLogin) throw new Error("admin-login-bypass");
  const functions = getFunctions(app, "southamerica-east1");
  const response = await Promise.race([httpsCallable(functions, "getSiteMaintenance")(), timeout]);
  if (response.data?.maintenance !== true) releasePage();
  else {
    const auth = getAuth(app);
    await Promise.race([auth.authStateReady(), new Promise(resolve => setTimeout(resolve, 3500))]);
    const token = auth.currentUser ? await auth.currentUser.getIdTokenResult(false) : null;
    if (token?.claims?.admin === true) releasePage();
    else location.replace("./maintenance.html");
  }
} catch {
  releasePage();
}
