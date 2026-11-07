import { onAuthStateChanged, signOut } from "firebase/auth";
import { collection, doc, getDoc, getDocs } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { app } from "./firebase-config.js";
import { auth } from "./auth.js";
import { db } from "./firebase-config.js";
import { installButtonProgress } from "./ui-loading.js";
import { createPlanFeatureListItem, planFeatureItems } from "./plan-features.js";

installButtonProgress();

const loading = document.querySelector("#auth-loading");
const plansView = document.querySelector("#plans-view");
const successView = document.querySelector("#success-view");
const list = document.querySelector("#plans-list");
const errorBox = document.querySelector("#plans-error");
const checkoutView = document.querySelector('#checkout-view');
const checkoutError = document.querySelector('#checkout-error');
const preferredPlan = new URLSearchParams(window.location.search).get("plano") || "";
let currentUser = null;
let organizationId = "";
let selectedPlan = null, cardForm = null, statusTimer = null;
const functions = getFunctions(app,'southamerica-east1');
const createPlanCardSubscription = httpsCallable(functions,'createPlanCardSubscription');
const createPlanPixPayment = httpsCallable(functions,'createPlanPixPayment');
const getPlanCheckoutStatus = httpsCallable(functions,'getPlanCheckoutStatus');
const activatePlanFreeAccess = httpsCallable(functions,'activatePlanFreeAccess');
const MP_PUBLIC_KEY = 'APP_USR-890b9fb5-8b0e-4d4e-9cfe-cdbd2c60eb16';

function slug(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function money(value) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value) || 0);
}

function showSuccess() {
  clearInterval(statusTimer);
  loading.hidden = true;
  plansView.hidden = true;
  checkoutView.hidden = true;
  successView.hidden = false;
}

function createText(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function renderPlans(plans) {
  list.replaceChildren();
  plans.sort((a, b) => Number(a.price) - Number(b.price));
  for (const plan of plans) {
    const planSlug = slug(plan.name);
    const defaults = planSlug.includes("negocio")
      ? {professionals:20,appointmentsPerMonth:2500,remindersPerMonth:5000,flows:10,pix:true,automations:"full"}
      : planSlug.includes("profissional")
        ? {professionals:8,appointmentsPerMonth:800,remindersPerMonth:1600,flows:3,pix:true,automations:"full"}
        : {professionals:2,appointmentsPerMonth:200,remindersPerMonth:400,flows:1,pix:true,automations:"basic"};
    const limits = {...defaults,...(plan.limits && typeof plan.limits === "object" ? plan.limits : {})};
    const freeAccess = plan.freeTrial === true || Number(plan.price) === 0;
    const card = document.createElement("article");
    card.className = "selection-card";
    const wasPreferred = preferredPlan && slug(plan.name) === slug(preferredPlan);
    if (plan.prefer === true || wasPreferred) card.classList.add("preferred");
    if (plan.freeTrial === true) card.append(createText("span", "plan-badge", "14 dias grátis"));
    else if (plan.prefer === true) card.append(createText("span", "plan-badge", "Mais escolhido"));
    else if (wasPreferred) card.append(createText("span", "plan-badge", "Sua escolha inicial"));
    card.append(
      createText("p", "plan-eyebrow", plan.title || "Plano Automichat"),
      createText("h2", "", plan.name),
      createText("p", "plan-description", plan.description || "Automação para o atendimento da sua empresa.")
    );
    const price = createText("p", "plan-price", money(plan.price));
    price.append(createText("span", "", "/mês"));
    card.append(price);
    if (plan.subtitle) card.append(createText("p", "plan-subtitle", plan.subtitle));
    const capacity = document.createElement("div");
    capacity.className = "selection-capacity";
    capacity.append(createText("strong", "", "Capacidade mensal"));
    const capacityItems = [
      ["▦", `${Number(limits.appointmentsPerMonth).toLocaleString("pt-BR")} agendamentos`, "Reservas criadas pelos clientes."],
      ["◌", `${Number(limits.remindersPerMonth).toLocaleString("pt-BR")} mensagens automáticas`, "Confirmações, lembretes e atualizações."]
    ];
    for (const [icon, title, copy] of capacityItems) { const row=document.createElement("div"); row.className="selection-capacity-row"; row.append(createText("span","",icon),createText("b","",title),createText("small","",copy)); capacity.append(row); }
    const features=document.createElement("ul"); features.className="selection-features";
    [
      `Até ${Number(limits.professionals).toLocaleString("pt-BR")} profissionais`,
      `${Number(limits.flows).toLocaleString("pt-BR")} ${Number(limits.flows)===1?"modelo":"modelos"} de Flow interativo`,
      limits.automations === "full" ? "Automações completas" : "Automações essenciais",
      limits.pix === true ? "Pix integrado" : "Gestão de pagamentos"
    ].forEach(label=>features.append(createText("li","",label)));
    planFeatureItems(plan).forEach(item=>features.append(createPlanFeatureListItem(item,"selection-automation-feature")));
    const details=document.createElement("div");details.className="selection-details";details.hidden=true;details.append(capacity,features);
    const toggle=createText("button","selection-details-toggle","Ver tudo que o plano inclui");toggle.type="button";toggle.setAttribute("aria-expanded","false");toggle.addEventListener("click",()=>{const opening=details.hidden;document.querySelectorAll('.selection-details:not([hidden])').forEach(item=>{item.hidden=true;const owner=item.parentElement?.querySelector('.selection-details-toggle');if(owner){owner.textContent='Ver tudo que o plano inclui';owner.setAttribute('aria-expanded','false');}});details.hidden=!opening;toggle.textContent=opening?'Ocultar detalhes':'Ver tudo que o plano inclui';toggle.setAttribute('aria-expanded',String(opening));});card.append(toggle,details);
    const button = createText("button", "plan-choice-button", plan.freeTrial === true ? "Começar teste grátis" : Number(plan.price) === 0 ? "Ativar plano gratuito" : "Escolher este plano");
    button.type = "button";
    button.addEventListener("click", () => freeAccess ? activateFreePlan(plan, button) : choosePlan(plan, button));
    card.append(button);
    list.append(card);
  }
}

async function activateFreePlan(plan, button) {
  button.disabled=true; button.textContent=plan.freeTrial === true?'Ativando teste…':'Ativando plano…'; errorBox.hidden=true;
  try { await activatePlanFreeAccess({organizationId,planId:plan.id}); showSuccess(); }
  catch(error) { errorBox.textContent=checkoutMessage(error); errorBox.hidden=false; button.disabled=false; button.textContent=plan.freeTrial === true?'Começar teste grátis':'Ativar plano gratuito'; }
}

async function choosePlan(plan, selectedButton) {
  selectedPlan=plan; errorBox.hidden=true; plansView.hidden=true; checkoutView.hidden=false;
  document.querySelector('#checkout-plan-name').textContent=plan.name;
  document.querySelector('#checkout-plan-price').textContent=`${money(plan.price)} / mês`;
  document.querySelector('#form-checkout__cardholderEmail').value=currentUser.email || '';
  checkoutView.scrollIntoView({block:'start'}); initializeCardForm();
}

function checkoutMessage(error) {
  const message = String(error?.message || 'Não foi possível concluir o pagamento.').replace(/^FirebaseError:\s*/,'').replace(/^\w+\/[^:]+:\s*/,'');
  if (/card token was used|token.*(?:used|utilizado)/i.test(message)) return 'Os dados seguros do cartão expiraram após a tentativa anterior. Preencha o cartão novamente para gerar uma nova validação.';
  if (/CC_VAL_433|credit card validation has failed/i.test(message)) return 'Não foi possível validar este cartão para cobrança recorrente. Confira titular, CPF, validade e CVV ou tente outro cartão de crédito. Você também pode pagar por Pix.';
  return message;
}

async function resetCardForm() {
  const previous = cardForm;
  cardForm = null;
  try { await previous?.unmount?.(); } catch {}
  document.querySelectorAll('#card-checkout-form input[name="MPHiddenInputToken"]').forEach(input => input.remove());
  initializeCardForm();
}
function initializeCardForm() {
  if (cardForm || !window.MercadoPago) return;
  const mp=new window.MercadoPago(MP_PUBLIC_KEY,{locale:'pt-BR'});
  cardForm=mp.cardForm({amount:String(selectedPlan.price),iframe:true,form:{id:'card-checkout-form',cardNumber:{id:'form-checkout__cardNumber'},expirationDate:{id:'form-checkout__expirationDate'},securityCode:{id:'form-checkout__securityCode'},cardholderName:{id:'form-checkout__cardholderName'},issuer:{id:'form-checkout__issuer'},installments:{id:'form-checkout__installments'},identificationType:{id:'form-checkout__identificationType'},identificationNumber:{id:'form-checkout__identificationNumber'},cardholderEmail:{id:'form-checkout__cardholderEmail'}},callbacks:{onFormMounted:error=>{if(error){checkoutError.textContent='Não foi possível carregar o formulário seguro.';checkoutError.hidden=false;}},onSubmit:async event=>{event.preventDefault();const button=document.querySelector('#card-pay-button');if(button.disabled)return;button.disabled=true;button.textContent='Validando cartão…';checkoutError.hidden=true;try{const data=cardForm.getCardFormData();if(!data.token)throw new Error('Confira os dados do cartão.');await createPlanCardSubscription({organizationId,planId:selectedPlan.id,cardToken:data.token});document.querySelector('#card-pay-button').textContent='Aguardando primeira cobrança…';startStatusPolling();}catch(error){checkoutError.textContent=checkoutMessage(error);checkoutError.hidden=false;await resetCardForm();}finally{button.disabled=false;if(!statusTimer)button.textContent='Assinar com cartão';}}}});
}
function renderPix(data){document.querySelector('#plan-pix-result').hidden=false;document.querySelector('#plan-pix-code').value=data.qrCode || '';const image=document.querySelector('#plan-pix-qr');image.src=data.qrCodeBase64?`data:image/png;base64,${data.qrCodeBase64}`:'';image.hidden=!data.qrCodeBase64;startStatusPolling();}
function startStatusPolling(){clearInterval(statusTimer);statusTimer=setInterval(async()=>{try{const result=await getPlanCheckoutStatus({organizationId});if(['active','authorized'].includes(result.data.status)){clearInterval(statusTimer);showSuccess();}else document.querySelector('#plan-pix-status').textContent=result.data.status==='failed'?'Pagamento não aprovado. Gere uma nova cobrança.':'Confirmando seu pagamento…';}catch{}},5000);}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.replace("./login.html");
    return;
  }
  currentUser = user;
  try {
    const profile = await getDoc(doc(db, "users", user.uid));
    if (!profile.exists()) throw new Error("Seu perfil não foi encontrado.");
    const data = profile.data();
    if (data.onboarding_concluido && new URLSearchParams(location.search).get('gerenciar') !== '1') {
      showSuccess();
      return;
    }
    if (!data.organizacao_id) {
      window.location.replace("./onboarding.html");
      return;
    }
    organizationId = data.organizacao_id;
    const snapshot = await getDocs(collection(db, "plans"));
    const plans = snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).filter((plan) => plan.active !== false && typeof plan.name === "string" && typeof plan.price === "number");
    if (!plans.length) throw new Error("Nenhum plano foi cadastrado ainda na coleção plans.");
    renderPlans(plans);
    loading.hidden = true;
    plansView.hidden = false;
  } catch (error) {
    loading.textContent = error.message || "Não foi possível carregar os planos.";
  }
});

async function leave() {
  await signOut(auth);
  window.location.replace("./login.html");
}

document.querySelector("#sign-out").addEventListener("click", leave);
document.querySelector("#success-sign-out").addEventListener("click", leave);
document.querySelector('#checkout-back').addEventListener('click',()=>{checkoutView.hidden=true;plansView.hidden=false;checkoutError.hidden=true;});
document.querySelectorAll('[data-checkout-method]').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('[data-checkout-method]').forEach(item=>item.classList.toggle('active',item===button));document.querySelector('#card-checkout-form').hidden=button.dataset.checkoutMethod!=='card';document.querySelector('#pix-checkout').hidden=button.dataset.checkoutMethod!=='pix';}));
document.querySelector('#generate-plan-pix').addEventListener('click',async event=>{const button=event.currentTarget;button.disabled=true;button.textContent='Gerando Pix…';checkoutError.hidden=true;try{renderPix((await createPlanPixPayment({organizationId,planId:selectedPlan.id})).data);}catch(error){checkoutError.textContent=checkoutMessage(error);checkoutError.hidden=false;}finally{button.disabled=false;button.textContent='Gerar Pix';}});
document.querySelector('#copy-plan-pix').addEventListener('click',async()=>{await navigator.clipboard.writeText(document.querySelector('#plan-pix-code').value);document.querySelector('#copy-plan-pix').textContent='Pix copiado ✓';});
