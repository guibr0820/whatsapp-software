import { randomUUID } from "node:crypto";

const projectId = "whatsapp-software-a85f3";
const databaseId = "default";
const apiKey = "AIzaSyAiVpljQvXQPPdKcOwNt5KCrLczO0vX00w";
const testId = randomUUID();
const email = `clickchat-smoke-${testId}@example.com`;
const password = `Teste${testId.slice(0, 8)}9`;
const firestoreBase = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents`;

const stringValue = (value) => ({ stringValue: value });
const booleanValue = (value) => ({ booleanValue: value });
const numberValue = (value) => ({ doubleValue: value });
const fields = (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value]));

async function jsonRequest(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`);
  return body;
}

let idToken = "";
let uid = "";
let organizationId = "";

try {
  const signup = await jsonRequest(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  idToken = signup.idToken;
  uid = signup.localId;
  organizationId = `smoke-${testId}`;

  const authorization = { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` };
  const userName = `projects/${projectId}/databases/${databaseId}/documents/users/${uid}`;
  const leadName = `projects/${projectId}/databases/${databaseId}/documents/leads/${uid}`;

  await jsonRequest(`${firestoreBase}:commit?key=${apiKey}`, {
    method: "POST",
    headers: authorization,
    body: JSON.stringify({ writes: [
      {
        update: { name: userName, fields: fields({
          uid: stringValue(uid), nome: stringValue("Teste Automatizado"), email: stringValue(email),
          whatsapp: stringValue("+5511999999999"), foto_url: stringValue(""), organizacao_id: stringValue(""),
          onboarding_concluido: booleanValue(false), aceitou_termos: booleanValue(true), aceitou_marketing: booleanValue(false)
        }) },
        updateTransforms: [
          { fieldPath: "criado_em", setToServerValue: "REQUEST_TIME" },
          { fieldPath: "atualizado_em", setToServerValue: "REQUEST_TIME" }
        ]
      },
      {
        update: { name: leadName, fields: fields({
          uid: stringValue(uid), nome: stringValue("Teste Automatizado"), email: stringValue(email),
          whatsapp: stringValue("+5511999999999"), aceitou_termos: booleanValue(true), aceitou_marketing: booleanValue(false),
          plano: stringValue("profissional"), origem_cta: stringValue("smoke-test"), utm_source: stringValue("teste"),
          utm_medium: stringValue("automatizado"), utm_campaign: stringValue("auth-onboarding"), etapa: stringValue("conta_criada")
        }) },
        updateTransforms: [{ fieldPath: "criado_em", setToServerValue: "REQUEST_TIME" }]
      }
    ] })
  });

  const organizationName = `projects/${projectId}/databases/${databaseId}/documents/organizations/${organizationId}`;
  const memberName = `${organizationName}/members/${uid}`;
  await jsonRequest(`${firestoreBase}:commit?key=${apiKey}`, {
    method: "POST",
    headers: authorization,
    body: JSON.stringify({ writes: [
      {
        update: { name: organizationName, fields: fields({
          proprietario_uid: stringValue(uid), nome: stringValue("Empresa de Teste"),
          segmento: stringValue("Serviços profissionais"), whatsapp: stringValue("+5511999999999"), volume_conversas: stringValue("ate-20"),
          plano_id: stringValue(""), plano_nome: stringValue(""), plano_preco: numberValue(0),
          status: stringValue("onboarding"), fuso_horario: stringValue("America/Sao_Paulo")
        }) },
        updateTransforms: [
          { fieldPath: "criado_em", setToServerValue: "REQUEST_TIME" },
          { fieldPath: "atualizado_em", setToServerValue: "REQUEST_TIME" }
        ]
      },
      {
        update: { name: memberName, fields: fields({ uid: stringValue(uid), papel: stringValue("owner"), status: stringValue("active") }) },
        updateTransforms: [{ fieldPath: "criado_em", setToServerValue: "REQUEST_TIME" }]
      },
      {
        update: { name: userName, fields: fields({
          whatsapp: stringValue("+5511999999999"), organizacao_id: stringValue(organizationId), onboarding_concluido: booleanValue(false)
        }) },
        updateMask: { fieldPaths: ["whatsapp", "organizacao_id", "onboarding_concluido"] },
        updateTransforms: [{ fieldPath: "atualizado_em", setToServerValue: "REQUEST_TIME" }]
      }
    ] })
  });

  const catalog = await jsonRequest(`${firestoreBase}:runQuery?key=${apiKey}`, {
    method: "POST",
    headers: authorization,
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "plans" }], limit: 10 } })
  });
  const planDocument = catalog.find((result) => result.document)?.document;
  if (!planDocument) throw new Error("A coleção plans está vazia.");
  const planId = planDocument.name.split("/").pop();
  const planName = planDocument.fields?.name?.stringValue;
  const planPrice = Number(planDocument.fields?.price?.doubleValue ?? planDocument.fields?.price?.integerValue);
  if (!planId || !planName || !(planPrice > 0)) throw new Error("Plano de teste inválido.");

  await jsonRequest(`${firestoreBase}:commit?key=${apiKey}`, {
    method: "POST",
    headers: authorization,
    body: JSON.stringify({ writes: [
      {
        update: { name: organizationName, fields: fields({
          plano_id: stringValue(planId), plano_nome: stringValue(planName), plano_preco: numberValue(planPrice), status: stringValue("trial")
        }) },
        updateMask: { fieldPaths: ["plano_id", "plano_nome", "plano_preco", "status"] },
        updateTransforms: [{ fieldPath: "atualizado_em", setToServerValue: "REQUEST_TIME" }]
      },
      {
        update: { name: userName, fields: fields({ onboarding_concluido: booleanValue(true) }) },
        updateMask: { fieldPaths: ["onboarding_concluido"] },
        updateTransforms: [{ fieldPath: "atualizado_em", setToServerValue: "REQUEST_TIME" }]
      }
    ] })
  });

  const profile = await jsonRequest(`${firestoreBase}/users/${uid}?key=${apiKey}`, { headers: { Authorization: `Bearer ${idToken}` } });
  if (profile.fields?.onboarding_concluido?.booleanValue !== true) throw new Error("Onboarding não foi persistido.");

  console.log(`TEST_UID=${uid}`);
  console.log(`TEST_ORGANIZATION_ID=${organizationId}`);
  console.log("AUTH_ONBOARDING_SMOKE_TEST=PASS");
} finally {
  if (idToken) {
    await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken })
    });
  }
}
