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

admin.initializeApp();

const metaAppSecret = defineSecret("META_APP_SECRET");
const metaWebhookVerifyToken = defineSecret("META_WEBHOOK_VERIFY_TOKEN");
const metaSystemUserAccessToken = defineSecret("META_SYSTEM_USER_ACCESS_TOKEN");
const flowPrivateKey = defineSecret("WHATSAPP_FLOW_PRIVATE_KEY");
const metaAppId = defineString("META_APP_ID", { default: "2325508071569046" });
const metaBusinessId = defineString("META_BUSINESS_ID", { default: "2971128526241085" });
const metaGraphVersion = defineString("META_GRAPH_VERSION", { default: "v24.0" });

const shared = {
  admin,
  db: getFirestore("default"),
  onCall,
  HttpsError,
  taskQueue: getFunctions().taskQueue("locations/southamerica-east1/functions/sendAppointmentReminderTask"),
  onTaskDispatched,
};

const payments = createMercadoPago({ ...shared, axios, logger, onRequest, onSchedule, secrets: {
  clientId: defineSecret('MERCADOPAGO_CLIENT_ID'),
  clientSecret: defineSecret('MERCADOPAGO_CLIENT_SECRET'),
  encryptionKey: defineSecret('MERCADOPAGO_TOKEN_ENCRYPTION_KEY'),
  webhookSecret: defineSecret('MERCADOPAGO_WEBHOOK_SECRET'),
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
  },
  }),
  ...createCatalogFunctions(shared),
  ...createAppointmentFunctions(shared),
};
