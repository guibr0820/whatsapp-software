export function createPaymentsUI({ call, organization }) {
  const $ = selector => document.querySelector(selector);
  let connected = false, loaded = false, loading = false;
  const money = value => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  function settings() { return { mode: $('[name="payment-mode"]:checked').value, depositType: $('#payment-deposit-type').value, depositValue: Number($('#payment-deposit-value').value), expiryMinutes: Number($('#payment-expiry').value), merchantName: $('#payment-merchant-name').value, pixKey: $('#payment-pix-key').value, pixKeyType: $('#payment-pix-key-type').value }; }
  function preview() {
    const config = settings(), deposit = config.mode === 'deposit';
    $('#payment-deposit-fields').hidden = !deposit; $('#payment-onsite-note').hidden = deposit;
    $('#payment-deposit-fields').querySelectorAll('input,select').forEach(input => { input.disabled = !deposit; });
    $('#payment-deposit-value').required = deposit;
    $('#payment-value-label').textContent = config.depositType === 'percent' ? 'Percentual do sinal (%)' : 'Valor do sinal (R$)';
    $('#payment-deposit-value').max = config.depositType === 'percent' ? '100' : '100000';
    const signal = Math.min(80, config.depositType === 'percent' ? 80 * config.depositValue / 100 : config.depositValue) || 0;
    $('#payment-preview-deposit').textContent = money(signal); $('#payment-preview-balance').textContent = money(80 - signal);
    $('#payment-preview-deposit-row').hidden = !deposit; $('#payment-preview-balance-row').hidden = !deposit;
    $('#payment-preview-copy').textContent = deposit ? `Pague o sinal em até ${config.expiryMinutes} minutos para confirmar seu horário. O Pix será enviado nesta conversa.` : 'Pagamento no estabelecimento. Seu horário será confirmado agora.';
    $('#payment-preview-button').textContent = deposit ? 'Gerar Pix do sinal' : 'Confirmar agendamento';
    $('#payment-preview-next').textContent = deposit ? 'Reserva temporária → Pix na conversa → sinal pago → confirmação e lembrete.' : 'Confirmação imediata → lembrete configurado → pagamento presencial.';
  }
  function feedback(text) { $('#payment-feedback').textContent = text; $('#payment-feedback').hidden = false; }
  async function load() {
    if (!organization() || loading) return;
    loading = true; $('#payment-save').disabled = true;
    try {
      const result = (await call('getPaymentSettings', { organizationId: organization() })).data;
      const config = result.settings; connected = result.connected;
      $(`[name="payment-mode"][value="${config.mode}"]`).checked = true;
      $('#payment-deposit-type').value = config.depositType; $('#payment-deposit-value').value = config.depositValue; $('#payment-expiry').value = config.expiryMinutes;
      $('#payment-merchant-name').value = config.merchantName || ''; $('#payment-pix-key').value = config.pixKey || ''; $('#payment-pix-key-type').value = config.pixKeyType || 'EVP';
      $('#payment-connection-status').textContent = connected ? `Conectado · ${result.sellerName}` : 'Conecte sua conta para receber o sinal por Pix.';
      $('#payment-connection-badge').textContent = connected ? 'Conectado ✓' : 'Não conectado';
      $('#payment-connect').textContent = connected ? 'Reconectar conta ↗' : 'Conectar Mercado Pago ↗'; $('#payment-disconnect').hidden = !connected;
      loaded = true; preview();
    } catch (e) { feedback(e.message || 'Não foi possível carregar os pagamentos.'); }
    finally { loading = false; $('#payment-save').disabled = !loaded; }
  }
  $('#payment-settings-form').addEventListener('input', preview);
  $('#payment-settings-form').addEventListener('change', preview);
  $('#payment-settings-form').addEventListener('submit', async event => {
    event.preventDefault(); const config = settings();
    if (config.mode === 'deposit' && !connected) { feedback('Conecte o Mercado Pago antes de exigir sinal.'); return; }
    if (Boolean(config.merchantName.trim()) !== Boolean(config.pixKey.trim())) { feedback('Preencha nome do recebedor e chave Pix juntos, ou deixe ambos vazios.'); return; }
    const button = $('#payment-save'); button.disabled = true; button.textContent = 'Salvando…';
    try { await call('savePaymentSettings', { organizationId: organization(), settings: config }); feedback('Configurações salvas. A regra já vale para novas reservas no Flow atualizado.'); }
    catch (e) { feedback(e.message); }
    finally { button.disabled = false; button.textContent = 'Salvar configurações'; }
  });
  $('#payment-connect').addEventListener('click', async () => {
    const button = $('#payment-connect'); button.disabled = true;
    try { const result = await call('connectMercadoPago', { organizationId: organization() }); const url = new URL(result.data.url); if (url.hostname !== 'auth.mercadopago.com.br') throw new Error('Endereço de conexão inválido.'); window.location.assign(url.href); }
    catch (e) { feedback(e.message); button.disabled = false; }
  });
  $('#payment-reload').addEventListener('click', load);
  $('#payment-disconnect').addEventListener('click', async () => {
    if (!window.confirm('Desconectar o Mercado Pago? Novas reservas passarão a usar pagamento presencial.')) return;
    const button = $('#payment-disconnect'); button.disabled = true;
    try { await call('disconnectMercadoPago', { organizationId: organization() }); await load(); feedback('Conta desconectada. Pagamento presencial ativado.'); } catch (e) { feedback(e.message); } finally { button.disabled = false; }
  });
  preview();
  return { load };
}
