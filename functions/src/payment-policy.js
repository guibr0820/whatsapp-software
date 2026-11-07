const cents = value => Math.round(Number(value) * 100);
function normalizePolicy(input = {}) {
  const mode = input.mode || 'onsite';
  if (!['onsite', 'deposit'].includes(mode)) throw new Error('Escolha pagamento presencial ou sinal.');
  const depositType = input.depositType || 'fixed';
  const depositValue = Number(input.depositValue ?? 20);
  const expiryMinutes = Number(input.expiryMinutes ?? 30);
  const refundCutoffMinutes = Number(input.refundCutoffMinutes ?? 60);
  const allowPaidReschedule = input.allowPaidReschedule !== false;
  const maxPaidReschedules = Number(input.maxPaidReschedules ?? 1);
  if (!['fixed', 'percent'].includes(depositType) || !Number.isFinite(depositValue) || depositValue <= 0 || depositValue > (depositType === 'percent' ? 100 : 100000)) throw new Error('Informe um sinal válido.');
  if (![30, 60, 120].includes(expiryMinutes)) throw new Error('Escolha um prazo entre 30 minutos e 2 horas.');
  if (![30, 60, 120, 180, 360, 720, 1440].includes(refundCutoffMinutes)) throw new Error('Escolha um prazo válido para devolução do sinal.');
  if (![0, 1, 2, 3].includes(maxPaidReschedules)) throw new Error('Escolha até 3 remarcações com sinal.');
  return { mode, depositType, depositValue, expiryMinutes, refundCutoffMinutes, allowPaidReschedule, maxPaidReschedules };
}

function appointmentChangePolicy(appointment, policy, now = Date.now()) {
  const effective = appointment?.change_policy && typeof appointment.change_policy === 'object' ? appointment.change_policy : policy;
  const scheduled = appointment?.scheduled_for?.toMillis?.() ?? new Date(`${appointment?.appointment_date || ''}T${appointment?.appointment_time || ''}:00-03:00`).getTime();
  const remainingMinutes = Number.isFinite(scheduled) ? Math.floor((scheduled - now) / 60000) : -1;
  const paid = appointment?.payment_status === 'paid' && Number(appointment?.paid_cents || 0) > 0;
  const cutoff = Number(effective?.refundCutoffMinutes || 60);
  const beforeCutoff = remainingMinutes >= cutoff;
  return {
    scheduled,
    remainingMinutes,
    paid,
    canCancel: remainingMinutes >= 0,
    refundEligible: paid && beforeCutoff,
    retainsDeposit: paid && !beforeCutoff,
    canReschedule: remainingMinutes >= 0 && (!paid || (effective?.allowPaidReschedule !== false && beforeCutoff && Number(appointment?.reschedule_count || 0) < Number(effective?.maxPaidReschedules ?? 1))),
  };
}
function quote(total, policy = {}) {
  const totalCents = cents(total);
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) throw new Error('Valor do serviço inválido.');
  const depositCents = policy.mode === 'deposit' ? Math.min(totalCents, policy.depositType === 'percent' ? Math.round(totalCents * Number(policy.depositValue) / 100) : cents(policy.depositValue)) : 0;
  if (policy.mode === 'deposit' && (!Number.isSafeInteger(depositCents) || depositCents < 1)) throw new Error('O sinal deste serviço deve ser maior que zero.');
  return { totalCents, depositCents, remainingCents: totalCents - depositCents };
}
module.exports = { normalizePolicy, quote, appointmentChangePolicy };
