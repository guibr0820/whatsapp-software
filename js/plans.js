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
const manageMode = new URLSearchParams(window.location.search).get("gerenciar") === "1";
let currentUser = null;
let organizationId = "";
let selectedPlan = null, cardForm = null, statusTimer = null, planChangeData = null, proratedUpgrade = false;
const functions = getFunctions(app,'southamerica-east1');
const createPlanCardSubscription = httpsCallable(functions,'createPlanCardSubscription');
const createPlanPixPayment = httpsCallable(functions,'createPlanPixPayment');
const getPlanCheckoutStatus = httpsCallable(functions,'getPlanCheckoutStatus');
const activatePlanFreeAccess = httpsCallable(functions,'activatePlanFreeAccess');
const getPlanChangeOptions = httpsCallable(functions,'getPlanChangeOptions');
const changeOwnerPlan = httpsCallable(functions,'changeOwnerPlan');
const createPlanUpgradeCardPayment = httpsCallable(functions,'createPlanUpgradeCardPayment');
const createPlanUpgradePixPayment = httpsCallable(functions,'createPlanUpgradePixPayment');
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
    const wasPreferred = preferredPlan && (plan.id === preferredPlan || slug(plan.name) === slug(preferredPlan));
    if (plan.prefer === true || wasPreferred) card.classList.add("preferred");
    if (manageMode && planChangeData?.current?.id===plan.id) card.append(createText("span", "plan-badge", "Plano atual"));
    else if (plan.freeTrial === true) card.append(createText("span", "plan-badge", "14 dias grátis"));
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
    const isCurrent=manageMode&&planChangeData?.current?.id===plan.id;
    const button = createText("button", "plan-choice-button", isCurrent?"Plano atual":manageMode&&plan.change?.type==='upgrade'?"Fazer upgrade":manageMode&&plan.change?.type==='downgrade'?"Trocar no próximo ciclo":plan.freeTrial === true ? "Começar teste grátis" : Number(plan.price) === 0 ? "Ativar plano gratuito" : "Escolher este plano");
    button.type = "button";
    button.disabled=isCurrent;
    button.addEventListener("click", () => manageMode ? choosePlan(plan,button) : freeAccess ? activateFreePlan(plan, button) : choosePlan(plan, button));
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
  proratedUpgrade=Boolean(manageMode&&planChangeData?.current?.status==='active'&&planChangeData?.billing?.status==='active'&&plan.change?.type==='upgrade'&&plan.change.amountDueCents>0);
  document.querySelector('#checkout-plan-name').textContent=plan.name;
  document.querySelector('#checkout-plan-price').textContent=proratedUpgrade?`${money(plan.change.amountDueCents/100)} agora`:`${money(plan.price)} / mês`;
  document.querySelector('.checkout-summary > p').textContent=proratedUpgrade
    ? 'Você paga somente a diferença proporcional até a próxima renovação.'
    : 'Cobrança mensal. Você pode cancelar a renovação nas configurações.';
  document.querySelector('#card-checkout-form .secure-note').textContent=proratedUpgrade
    ? 'Os dados do cartão vão diretamente ao processador. Esta cobrança única corresponde apenas à diferença proporcional; a renovação continua na data atual.'
    : 'Os dados do cartão são enviados diretamente ao processador de pagamentos e não passam pelos servidores do Automichat. A primeira cobrança é feita em 1x; as próximas são mensais.';
  document.querySelector('#pix-checkout .secure-note').textContent=proratedUpgrade
    ? 'Este Pix cobra apenas a diferença proporcional. A data da próxima renovação não será alterada.'
    : 'O primeiro mês é pago agora. Nas próximas renovações, um novo Pix será disponibilizado antes do vencimento.';
  document.querySelector('#card-pay-button').textContent=proratedUpgrade?'Pagar diferença e fazer upgrade':'Assinar com cartão';
  document.querySelector('#generate-plan-pix').textContent=proratedUpgrade?'Gerar Pix da diferença':'Gerar Pix';
  document.querySelector('#form-checkout__cardholderEmail').value=currentUser.email || '';
  renderPlanChangeSummary(plan);
  checkoutView.scrollIntoView({block:'start'});
  if(manageMode&&['downgrade','lateral'].includes(plan.change?.type)){showChangeConfirmation(plan);return;}
  document.querySelector('.checkout-payment').hidden=false;document.querySelector('#managed-change-confirmation')?.remove();initializeCardForm();
}

function renderPlanChangeSummary(plan){document.querySelector('#plan-change-breakdown')?.remove();if(!manageMode)return;const box=document.createElement('div');box.id='plan-change-breakdown';box.className='plan-change-breakdown';const date=plan.change?.nextDueAt?new Intl.DateTimeFormat('pt-BR',{dateStyle:'long',timeZone:'America/Sao_Paulo'}).format(new Date(plan.change.nextDueAt)):'próxima renovação';box.innerHTML=proratedUpgrade?`<strong>Resumo proporcional</strong><span>Crédito do plano atual <b>− ${money(plan.change.currentCreditCents/100)}</b></span><span>Novo plano pelo período restante <b>${money(plan.change.targetPeriodCents/100)}</b></span><span>Valor a pagar agora <b>${money(plan.change.amountDueCents/100)}</b></span><small>Na renovação de ${date}, o valor será ${money(plan.price)}.</small>`:`<strong>${plan.change?.type==='downgrade'?'Mudança programada':'Troca sem cobrança adicional'}</strong><small>${plan.change?.type==='downgrade'?`Seu plano atual continua até ${date}. Depois, a mensalidade será ${money(plan.price)}.`:'A alteração será aplicada imediatamente.'}</small>`;document.querySelector('.checkout-summary').append(box);}
function showChangeConfirmation(plan){document.querySelector('.checkout-payment').hidden=true;document.querySelector('#managed-change-confirmation')?.remove();const panel=document.createElement('div');panel.id='managed-change-confirmation';panel.className='checkout-payment managed-change-confirmation';const button=createText('button','submit-button',plan.change.type==='downgrade'?'Programar troca de plano':'Confirmar troca de plano');button.type='button';const feedback=createText('p','submit-error','');feedback.hidden=true;button.addEventListener('click',async()=>{button.disabled=true;button.textContent='Confirmando…';try{await changeOwnerPlan({organizationId,planId:plan.id});showSuccess();}catch(error){feedback.textContent=checkoutMessage(error);feedback.hidden=false;button.disabled=false;button.textContent='Tentar novamente';}});panel.append(createText('h2','',plan.change.type==='downgrade'?'Confirme a mudança no próximo ciclo':'Confirme a troca'),createText('p','secure-note',plan.change.type==='downgrade'?'Nenhuma cobrança será feita agora. Seus limites atuais permanecem até o vencimento.':'Não haverá cobrança adicional.'),button,feedback);document.querySelector('.checkout-shell').append(panel);}

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
  const checkoutAmount=proratedUpgrade?selectedPlan.change.amountDueCents/100:selectedPlan.price;
  cardForm=mp.cardForm({amount:String(checkoutAmount),iframe:true,form:{id:'card-checkout-form',cardNumber:{id:'form-checkout__cardNumber'},expirationDate:{id:'form-checkout__expirationDate'},securityCode:{id:'form-checkout__securityCode'},cardholderName:{id:'form-checkout__cardholderName'},issuer:{id:'form-checkout__issuer'},installments:{id:'form-checkout__installments'},identificationType:{id:'form-checkout__identificationType'},identificationNumber:{id:'form-checkout__identificationNumber'},cardholderEmail:{id:'form-checkout__cardholderEmail'}},callbacks:{onFormMounted:error=>{if(error){checkoutError.textContent='Não foi possível carregar o formulário seguro.';checkoutError.hidden=false;}},onSubmit:async event=>{event.preventDefault();const button=document.querySelector('#card-pay-button');if(button.disabled)return;button.disabled=true;button.textContent='Validando cartão…';checkoutError.hidden=true;try{const data=cardForm.getCardFormData();if(!data.token)throw new Error('Confira os dados do cartão.');if(proratedUpgrade)await createPlanUpgradeCardPayment({organizationId,planId:selectedPlan.id,cardToken:data.token,paymentMethodId:data.paymentMethodId,issuerId:data.issuerId,identificationType:data.identificationType,identificationNumber:data.identificationNumber});else await createPlanCardSubscription({organizationId,planId:selectedPlan.id,cardToken:data.token});document.querySelector('#card-pay-button').textContent='Confirmando pagamento…';startStatusPolling();}catch(error){checkoutError.textContent=checkoutMessage(error);checkoutError.hidden=false;await resetCardForm();}finally{button.disabled=false;if(!statusTimer)button.textContent=proratedUpgrade?'Pagar diferença e fazer upgrade':'Assinar com cartão';}}}});
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
    let plans;
    if(manageMode){planChangeData=(await getPlanChangeOptions({organizationId})).data;plans=planChangeData.plans||[];}
    else{const snapshot = await getDocs(collection(db, "plans"));plans = snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).filter((plan) => plan.active !== false && typeof plan.name === "string" && typeof plan.price === "number");}
    if (!plans.length) throw new Error("Nenhum plano foi cadastrado ainda na coleção plans.");
    renderPlans(plans);
    loading.hidden = true;
    plansView.hidden = false;
    if(manageMode&&preferredPlan){const chosen=plans.find(plan=>plan.id===preferredPlan||slug(plan.name)===slug(preferredPlan));if(chosen&&chosen.id!==planChangeData.current.id)await choosePlan(chosen);}
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
document.querySelector('#checkout-back').addEventListener('click',async()=>{checkoutView.hidden=true;plansView.hidden=false;checkoutError.hidden=true;document.querySelector('#managed-change-confirmation')?.remove();document.querySelector('.checkout-payment').hidden=false;proratedUpgrade=false;await resetCardForm();});
document.querySelectorAll('[data-checkout-method]').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('[data-checkout-method]').forEach(item=>item.classList.toggle('active',item===button));document.querySelector('#card-checkout-form').hidden=button.dataset.checkoutMethod!=='card';document.querySelector('#pix-checkout').hidden=button.dataset.checkoutMethod!=='pix';}));
document.querySelector('#generate-plan-pix').addEventListener('click',async event=>{const button=event.currentTarget;button.disabled=true;button.textContent='Gerando Pix…';checkoutError.hidden=true;try{renderPix((await (proratedUpgrade?createPlanUpgradePixPayment:createPlanPixPayment)({organizationId,planId:selectedPlan.id})).data);}catch(error){checkoutError.textContent=checkoutMessage(error);checkoutError.hidden=false;}finally{button.disabled=false;button.textContent=proratedUpgrade?'Gerar Pix da diferença':'Gerar Pix';}});
document.querySelector('#copy-plan-pix').addEventListener('click',async()=>{await navigator.clipboard.writeText(document.querySelector('#plan-pix-code').value);document.querySelector('#copy-plan-pix').textContent='Pix copiado ✓';});
