import {
  GoogleAuthProvider,
  browserLocalPersistence,
  getAuth,
  setPersistence
} from "firebase/auth";
import { app } from "./firebase-config.js";

const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

setPersistence(auth, browserLocalPersistence).catch(() => {});

const authMessages = {
  "auth/email-already-in-use": "Este e-mail já possui uma conta. Entre para continuar.",
  "auth/invalid-credential": "E-mail ou senha incorretos.",
  "auth/invalid-email": "Digite um e-mail válido.",
  "auth/operation-not-allowed": "Este método de acesso ainda não foi habilitado no Firebase.",
  "auth/popup-blocked": "O navegador bloqueou a janela do Google. Permita pop-ups e tente novamente.",
  "auth/popup-closed-by-user": "A janela do Google foi fechada antes da conclusão.",
  "auth/unauthorized-domain": "Este endereço local não está autorizado para o Google. Abra o site em localhost ou autorize o domínio no Firebase.",
  "auth/too-many-requests": "Muitas tentativas. Aguarde alguns minutos e tente novamente.",
  "auth/user-not-found": "Conta não encontrada. Crie sua conta para continuar.",
  "auth/user-disabled": "Esta conta está desativada.",
  "auth/weak-password": "A senha precisa ter pelo menos 8 caracteres.",
  "auth/network-request-failed": "Não foi possível acessar o Firebase. Verifique sua conexão."
};

function authErrorMessage(error) {
  return authMessages[error?.code] || "Não foi possível concluir. Tente novamente.";
}

export { auth, authErrorMessage, googleProvider };
