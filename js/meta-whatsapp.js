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
    const receiveMessage = (event) => {
      let hostname = "";
      try { hostname = new URL(event.origin).hostname; } catch { return; }
      if (hostname !== "facebook.com" && !hostname.endsWith(".facebook.com")) return;
      let data = event.data;
      try { if (typeof data === "string") data = JSON.parse(data); } catch { return; }
      if (data?.type !== "WA_EMBEDDED_SIGNUP") return;
      if (data.event === "FINISH") session = { ...session, ...data.data };
      if (data.event === "CANCEL" || data.event === "ERROR") session = { ...session, event: data.event };
    };
    window.addEventListener("message", receiveMessage);
    FB.login((response) => {
      window.removeEventListener("message", receiveMessage);
      const code = response?.authResponse?.code;
      if (!code) {
        reject(new Error("A conexão foi cancelada antes da autorização."));
        return;
      }
      resolve({ code, wabaId: session.waba_id || "", phoneNumberId: session.phone_number_id || "" });
    }, {
      config_id: META_CONFIGURATION_ID,
      response_type: "code",
      override_default_response_type: true,
      extras: { setup: {}, featureType: "", sessionInfoVersion: "3" }
    });
  });
}

export { META_APP_ID, META_CONFIGURATION_ID, META_GRAPH_VERSION, startEmbeddedSignup };
