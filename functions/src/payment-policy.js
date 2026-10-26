const cents = value => Math.round(Number(value) * 100);
function normalizePolicy(input = {}) {
  const mode = input.mode || 'onsite';
  if (!['onsite', 'deposit'].includes(mode)) throw new Error('Escolha pagamento presencial ou sinal.');
  const depositType = input.depositType || 'fixed';
  const depositValue = Number(input.depositValue ?? 20);
  const expiryMinutes = Number(input.expiryMinutes ?? 30);
  if (!['fixed', 'percent'].includes(depositType) || !Number.isFinite(depositValue) || depositValue <= 0 || depositValue > (depositType === 'percent' ? 100 : 100000)) throw new Error('Informe um sinal válido.');
  if (![30, 60, 120].includes(expiryMinutes)) throw new Error('Escolha um prazo entre 30 minutos e 2 horas.');
  const merchantName = String(input.merchantName || '').trim().slice(0, 60);
  const pixKey = String(input.pixKey || '').trim().slice(0, 120);
  const pixKeyType = input.pixKeyType || 'EVP';
  if (Boolean(merchantName) !== Boolean(pixKey)) throw new Error('Preencha nome do recebedor e chave Pix juntos, ou deixe ambos vazios.');
  if (!['CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP'].includes(pixKeyType)) throw new Error('Tipo de chave Pix inválido.');
  return { mode, depositType, depositValue, expiryMinutes, merchantName, pixKey, pixKeyType };
}
function quote(total, policy = {}) {
  const totalCents = cents(total);
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) throw new Error('Valor do serviço inválido.');
  const depositCents = policy.mode === 'deposit' ? Math.min(totalCents, policy.depositType === 'percent' ? Math.round(totalCents * Number(policy.depositValue) / 100) : cents(policy.depositValue)) : 0;
  if (policy.mode === 'deposit' && (!Number.isSafeInteger(depositCents) || depositCents < 1)) throw new Error('O sinal deste serviço deve ser maior que zero.');
  return { totalCents, depositCents, remainingCents: totalCents - depositCents };
}
module.exports = { normalizePolicy, quote };
