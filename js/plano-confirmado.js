import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { app, db } from './firebase-config.js';
import { auth } from './auth.js';

const key = 'automichat_plan_confirmation';
const raw = sessionStorage.getItem(key);
sessionStorage.removeItem(key);
let confirmation;
try { confirmation = JSON.parse(raw); } catch {}
const params = new URLSearchParams(location.search);
const type = {paid:'pago',trial:'teste-gratis',free:'gratuito'}[confirmation?.kind];
const slug = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

function trackPaidConversion(conversion) {
  const transactionId = String(conversion?.transactionId || '');
  const value = Number(conversion?.value);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(transactionId) || !Number.isFinite(value) || value <= 0 || conversion.currency !== 'BRL') return;
  if (typeof window.gtag !== 'function') return;
  const dedupeKey = `automichat_ads_conversion_${transactionId}`;
  try {
    if (localStorage.getItem(dedupeKey)) return;
    localStorage.setItem(dedupeKey, 'sent');
  } catch {}
  window.gtag?.('event', 'conversion', {
    send_to: 'AW-18579540050/qebNCNqU6rkdENKQtZtF',
    value,
    currency: 'BRL',
    transaction_id: transactionId
  });
}

if (!confirmation?.organizationId || !confirmation?.planId || !confirmation?.planSlug || !type || params.get('plano') !== confirmation.planSlug || params.get('tipo') !== type || Date.now() - confirmation.createdAt > 10 * 60 * 1000) {
  location.replace('./plans.html');
} else {
  const getPlanCheckoutStatus = httpsCallable(getFunctions(app, 'southamerica-east1'), 'getPlanCheckoutStatus');
  onAuthStateChanged(auth, async user => {
    if (!user) { location.replace('./login.html'); return; }
    try {
      let confirmed = false;
      let planName = '';
      let conversion = null;
      if (confirmation.kind === 'paid') {
        const { data } = await getPlanCheckoutStatus({ organizationId: confirmation.organizationId });
        confirmed = data.status === 'active' && data.planId === confirmation.planId;
        planName = data.planName || '';
        conversion = data.conversion;
      } else {
        const [profile, company] = await Promise.all([
          getDoc(doc(db, 'users', user.uid)),
          getDoc(doc(db, 'organizations', confirmation.organizationId))
        ]);
        const plan = company.data();
        planName = plan?.plano_nome || '';
        confirmed = profile.data()?.organizacao_id === confirmation.organizationId &&
          profile.data()?.onboarding_concluido === true && plan?.plano_id === confirmation.planId &&
          (confirmation.kind === 'trial' ? plan.status === 'trial' : plan.status === 'active' && plan.billing_source === 'free_plan');
      }
      if (!confirmed || slug(planName) !== confirmation.planSlug) { location.replace('./plans.html'); return; }
      const planLabel = document.querySelector('#confirmation-plan');
      planLabel.textContent = `Plano ${planName}`;
      planLabel.hidden = false;
      const title = document.querySelector('#confirmation-title');
      const copy = document.querySelector('#confirmation-copy');
      if (confirmation.kind === 'trial') {
        title.textContent = 'Teste grátis ativado';
        copy.textContent = 'Seu período de teste começou. Você já pode acessar o painel.';
      } else if (confirmation.kind === 'paid') {
        title.textContent = 'Assinatura confirmada';
        copy.textContent = 'Seu pagamento foi confirmado e o plano está ativo. Você já pode acessar o painel.';
      }
      document.querySelector('#confirmation-loading').hidden = true;
      document.querySelector('#confirmation-success').hidden = false;
      if (confirmation.kind === 'paid') trackPaidConversion(conversion);
    } catch {
      document.querySelector('#confirmation-loading').hidden = true;
      const error = document.querySelector('#confirmation-error');
      error.textContent = 'Não foi possível confirmar o plano agora. Confira seu acesso no painel.';
      error.hidden = false;
    }
  });
}
