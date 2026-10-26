import { randomUUID } from "node:crypto";

const projectId = "whatsapp-software-a85f3";
const databaseId = "default";
const apiKey = "AIzaSyAiVpljQvXQPPdKcOwNt5KCrLczO0vX00w";
const documentId = `smoke-test-${randomUUID()}`;
const documentName = `projects/${projectId}/databases/${databaseId}/documents/leads/${documentId}`;
const endpoint = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents:commit?key=${apiKey}`;

const stringValue = (value) => ({ stringValue: value });
const booleanValue = (value) => ({ booleanValue: value });

const response = await fetch(endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    writes: [{
      update: {
        name: documentName,
        fields: {
          nome: stringValue("Teste Automatizado"),
          email: stringValue("teste.automatizado@example.com"),
          whatsapp: stringValue("+5511999999999"),
          profissao: stringValue("Teste de integração"),
          segmento: stringValue("Serviços em geral"),
          volume_conversas: stringValue("ate-20"),
          origem: stringValue("Outro"),
          aceitou_termos: booleanValue(true),
          aceitou_marketing: booleanValue(false),
          plano: stringValue("profissional"),
          origem_cta: stringValue("smoke-test"),
          utm_source: stringValue("teste"),
          utm_medium: stringValue("automatizado"),
          utm_campaign: stringValue("smoke-test"),
          pagina: stringValue("http://127.0.0.1/teste")
        }
      },
      updateTransforms: [{ fieldPath: "criado_em", setToServerValue: "REQUEST_TIME" }]
    }]
  })
});

const result = await response.json();
if (!response.ok) {
  throw new Error(`Firestore respondeu ${response.status}: ${JSON.stringify(result)}`);
}

console.log(`TEST_LEAD_ID=${documentId}`);
