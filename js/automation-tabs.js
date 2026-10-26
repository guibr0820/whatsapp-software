export function createAutomationTabs() {
  const view = document.querySelector('#view-automations');
  const tabs = [...view.querySelectorAll('[data-automation-tab]')];
  const heading = view.querySelector('.automation-heading');
  function select(name, focus = false) {
    const reminders = name === 'reminders';
    tabs.forEach(tab => {
      const active = tab.dataset.automationTab === name;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      if (focus && active) tab.focus();
    });
    document.querySelector('#automation-flows').hidden = reminders;
    document.querySelector('#automation-reminders').hidden = !reminders;
    heading.querySelector('h2').textContent = reminders ? 'Lembretes automáticos' : 'WhatsApp Flows';
    heading.querySelector('p').textContent = reminders
      ? 'Defina quando lembrar seus clientes e acompanhe a prévia da mensagem.'
      : 'Crie um Flow exclusivo ou personalize um modelo já publicado na Meta.';
    heading.querySelector('.automation-actions').hidden = reminders;
    updateReminderPreview();
  }
  function updateReminderPreview() {
    const after = document.querySelector('#reminder-trigger').value === 'after_confirmation';
    const active = document.querySelector('#reminder-active').checked;
    const timing = document.querySelector(after ? '#reminder-delay' : '#reminder-lead-time');
    const label = timing.selectedOptions[0]?.textContent.replace(' (teste)', '') || '';
    document.querySelector('#reminder-delay-field').hidden = !after;
    document.querySelector('#reminder-lead-field').hidden = after;
    document.querySelector('#reminder-delivery-summary').textContent = active
      ? `Enviar ${label} ${after ? 'após a confirmação' : 'antes do agendamento'}`
      : 'Lembrete pausado';
    document.querySelector('#reminder-delivery-detail').textContent = active
      ? 'O envio usa o nome do cliente, a empresa e o horário reservado.'
      : 'Ative o lembrete e salve para retomar os envios automáticos.';
    document.querySelector('.reminder-delivery-summary').classList.toggle('paused', !active);
    document.querySelector('#reminder-active-copy').textContent = after ? 'Envia alguns segundos após a confirmação.' : 'Envia antes do horário agendado.';
    const date = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(Date.now() + 86400000));
    document.querySelector('#reminder-preview-message').textContent = `Olá Mariana, seu agendamento na Studio Bella está confirmado para ${date} às 14:00. Até breve!`;
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab.dataset.automationTab));
    tab.addEventListener('keydown', event => {
      const next = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault(); select(tabs[next].dataset.automationTab, true);
    });
  });
  view.querySelectorAll('#reminder-trigger, #reminder-delay, #reminder-lead-time, #reminder-active').forEach(field => field.addEventListener('change', updateReminderPreview));
  select('flows');
  return { updateReminderPreview, select };
}
