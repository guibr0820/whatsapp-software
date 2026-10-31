const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");

const email = String(process.argv[2] || "").trim().toLowerCase();
const enabled = String(process.argv[3] || "true").toLowerCase() !== "false";
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("Uso: node scripts/set-admin.js email@dominio.com [true|false]");
  process.exit(1);
}

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || "whatsapp-software-a85f3" });

(async () => {
  const user = await admin.auth().getUserByEmail(email);
  const claims = { ...(user.customClaims || {}) };
  if (enabled) claims.admin = true;
  else delete claims.admin;
  await admin.auth().setCustomUserClaims(user.uid, claims);
  await getFirestore("default").doc(`admins/${user.uid}`).set({
    uid: user.uid,
    email: user.email,
    active: enabled,
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  console.log(`${email}: administrador ${enabled ? "ativado" : "removido"}. Saia e entre novamente para renovar o token.`);
})().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
