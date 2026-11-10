const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const { getFunctions } = require("firebase-admin/functions");
const axios = require("axios");
const logger = require("firebase-functions/logger");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onTaskDispatched } = require("firebase-functions/v2/tasks");
const { defineSecret, defineString } = require("firebase-functions/params");
const { createMetaWhatsAppFunctions } = require("./src/meta-whatsapp");
const { createCatalogFunctions } = require("./src/catalog");
const { createAppointmentFunctions } = require('./src/appointments');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { createMercadoPago } = require('./src/mercado-pago');
const { createAdminFunctions } = require('./src/admin-panel');
const { createPlanUsageFunctions } = require('./src/plan-usage');
const { createCustomerFunctions } = require('./src/customers');
const { createPetFunctions } = require('./src/pets');
const { createFoodCatalogFunctions } = require('./src/food-catalog');
const { createOrderNotificationFunctions } = require('./src/order-notifications');
const { createLifecycleAutomationFunctions } = require('./src/lifecycle-automations');
const { createAdminNotificationFunctions } = require('./src/admin-notifications');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');

admin.initializeApp();

const metaAppSecret = defineSecret("META_APP_SECRET");
const metaWebhookVerifyToken = defineSecret("META_WEBHOOK_VERIFY_TOKEN");
const metaSystemUserAccessToken = defineSecret("META_SYSTEM_USER_ACCESS_TOKEN");
const flowPrivateKey = defineSecret("WHATSAPP_FLOW_PRIVATE_KEY");
const metaAppId = defineString("META_APP_ID", { default: "2325508071569046" });
const metaBusinessId = defineString("META_BUSINESS_ID", { default: "2971128526241085" });
const metaGraphVersion = defineString("META_GRAPH_VERSION", { default: "v24.0" });
const automichatSupportOrganizationId = defineString("AUTOMICHAT_SUPPORT_ORGANIZATION_ID", { default: "e07e8e25-009b-49d4-96fb-b07b316eaf4b" });
const automichatDemoAdminPhone = defineString("AUTOMICHAT_DEMO_ADMIN_PHONE", { default: "5511994917461" });

const shared = {
  admin,
  db: getFirestore("default"),
  onCall,
  HttpsError,
  taskQueue: getFunctions().taskQueue("locations/southamerica-east1/functions/sendAppointmentReminderTask"),
  lifecycleTaskQueue: getFunctions().taskQueue("locations/southamerica-east1/functions/sendLifecycleAutomationTask"),
  supportConversationTaskQueue: getFunctions().taskQueue("locations/southamerica-east1/functions/closeSupportConversationTask"),
  onTaskDispatched,
};

const payments = createMercadoPago({ ...shared, axios, logger, onRequest, onSchedule, secrets: {
  clientId: defineSecret('MERCADOPAGO_CLIENT_ID'),
  clientSecret: defineSecret('MERCADOPAGO_CLIENT_SECRET'),
  encryptionKey: defineSecret('MERCADOPAGO_TOKEN_ENCRYPTION_KEY'),
  webhookSecret: defineSecret('MERCADOPAGO_WEBHOOK_SECRET'),
}, params: {
  platformOrganizationId: defineString('PLATFORM_BILLING_ORGANIZATION_ID', { default: 'e07e8e25-009b-49d4-96fb-b07b316eaf4b' }),
} });

module.exports = {
  ...payments.functions,
  ...createMetaWhatsAppFunctions({
  ...shared,
  payments,
  axios,
  logger,
  onRequest,
  secrets: {
    appSecret: metaAppSecret,
    webhookVerifyToken: metaWebhookVerifyToken,
    systemUserAccessToken: metaSystemUserAccessToken,
    flowPrivateKey,
  },
  params: {
    appId: metaAppId,
    businessId: metaBusinessId,
    graphVersion: metaGraphVersion,
    supportOrganizationId: automichatSupportOrganizationId,
    demoAdminPhone: automichatDemoAdminPhone,
  },
  }),
  ...createCatalogFunctions(shared),
  ...createAppointmentFunctions({ ...shared, axios, payments, logger }),
  ...createAdminFunctions({ ...shared, axios, supportOrganizationId: automichatSupportOrganizationId }),
  ...createPlanUsageFunctions(shared),
  ...createCustomerFunctions(shared),
  ...createPetFunctions(shared),
  ...createOrderNotificationFunctions(shared),
  ...createLifecycleAutomationFunctions({ ...shared, axios, logger, onSchedule }),
  ...createAdminNotificationFunctions({ ...shared, onDocumentWritten, supportOrganizationId: automichatSupportOrganizationId }),
  ...createFoodCatalogFunctions({ ...shared, axios, onRequest, payments, secrets: { appSecret: metaAppSecret }, params: { appId: metaAppId, graphVersion: metaGraphVersion } }),
};
