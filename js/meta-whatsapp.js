const META_APP_ID = "2325508071569046";
const META_CONFIGURATION_ID = "997277053394617";
const META_GRAPH_VERSION = "v24.0";

let sdkPromise = null;

function loadMetaSdk() {
  if (window.FB) return Promise.resolve(window.FB);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB.init({ appId: META_APP_ID, cookie: true, xfbml: false, version: META_GRAPH_VERSION });
      resolve(window.FB);
    };
    const script = document.createElement("script");
    script.src = "https://connect.facebook.net/pt_BR/sdk.js";
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => reject(new Error("Não foi possível carregar o login da Meta."));
    document.head.append(script);
  });
  return sdkPromise;
}

async function startEmbeddedSignup() {
  const FB = await loadMetaSdk();
  return new Promise((resolve, reject) => {
    let session = {};
    const finishEvents = new Set([
      "FINISH", "FINISH_ONLY_WABA", "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
    ]);
    const receiveMessage = (event) => {
      let hostname = "";
      try { hostname = new URL(event.origin).hostname; } catch { return; }
      if (hostname !== "facebook.com" && !hostname.endsWith(".facebook.com")) return;
      let data = event.data;
      try { if (typeof data === "string") data = JSON.parse(data); } catch { return; }
      if (data?.type !== "WA_EMBEDDED_SIGNUP") return;
      if (finishEvents.has(data.event)) {
        session = { ...session, ...(data.data || {}), event: data.event };
      } else if (data.event === "CANCEL" || data.event === "ERROR") {
        session = { ...session, ...(data.data || {}), event: data.event };
      }
    };
    window.addEventListener("message", receiveMessage);
    const finish = (response) => {
      window.removeEventListener("message", receiveMessage);
      const code = String(response?.authResponse?.code || "");
      if (!code) {
        const detail = session.error_message ? `: ${String(session.error_message).slice(0, 180)}` : ".";
        reject(new Error(`A autorização pela Meta não foi concluída${detail}`));
        return;
      }
      const ids = Array.isArray(session.messaging_account_ids) ? session.messaging_account_ids : [];
      const wabaId = String(session.waba_id || ids[0] || "");
      const phoneNumberId = String(session.phone_number_id || "");
      if (!wabaId) {
        reject(new Error("A Meta não retornou a conta WhatsApp autorizada. Conclua o cadastro e tente novamente."));
        return;
      }
      resolve({
        code, wabaId, phoneNumberId,
        onboardingEvent: session.event || "",
        isOnBizApp: session.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" || session.is_on_biz_app === true,
      });
    };
    try {
      FB.login(finish, {
        config_id: META_CONFIGURATION_ID,
        scope: "business_management,catalog_management,whatsapp_business_management,whatsapp_business_messaging",
        return_scopes: true,
        auth_type: "rerequest",
        response_type: "code",
        override_default_response_type: true,
        // Mantém os parâmetros validados no configurador de cadastro da Meta.
        extras: {
          setup: {},
          version: "v4",
          featureType: "whatsapp_business_app_onboarding",
          sessionInfoVersion: "3",
        },
      });
    } catch (error) {
      window.removeEventListener("message", receiveMessage);
      reject(error);
    }
  });
}

async function startCatalogAuthorization() {
  const FB = await loadMetaSdk();
  return new Promise((resolve, reject) => {
    FB.login((response) => {
      const accessToken = String(response?.authResponse?.accessToken || "");
      if (!accessToken) { reject(new Error("A autorização do catálogo foi cancelada.")); return; }
      resolve({accessToken, grantedScopes: String(response?.authResponse?.grantedScopes || "")});
    }, {scope: "business_management,catalog_management,whatsapp_business_management", return_scopes: true, auth_type: "rerequest"});
  });
}

export { META_APP_ID, META_CONFIGURATION_ID, META_GRAPH_VERSION, startEmbeddedSignup, startCatalogAuthorization };
