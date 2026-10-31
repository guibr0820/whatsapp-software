export function createOrderNotificationsUI({ organization, call, message }) {
  const section = document.querySelector('#order-notifications');
  const list = document.querySelector('#order-notification-list');
  const feedback = document.querySelector('#order-notification-feedback');
  let enabled = false;
  let loaded = false;
  let notifications = [];
  let selectedId = '';

  function configure(value) {
    enabled = Boolean(value);
    section.hidden = !enabled;
    section.closest('.reminder-layout')?.classList.toggle('order-notifications-layout', enabled);
    document.querySelector('#reminder-card').hidden = enabled;
    document.querySelector('.reminder-preview-panel').hidden = false;
  }

  async function load(force = false) {
    if (!enabled || !organization() || (loaded && !force)) return;
    list.innerHTML = '<div class="order-notification-empty">Carregando atualizações do pedido…</div>';
    try {
      const result = await call('getOrderNotificationConfig', { organizationId: organization() });
      notifications = result.data.notifications || [];
      loaded = true;
      if (!selectedId && notifications.length) selectedId = notifications[0].id;
      render();
      const selected = notifications.find(item => item.id === selectedId) || notifications[0];
      if (selected) preview(selected);
    } catch (error) {
      list.innerHTML = `<div class="order-notification-empty error">${escapeHtml(message(error))}</div>`;
    }
  }

  function render() {
    list.replaceChildren(...notifications.map(item => {
      const card = document.createElement('article');
      card.className = `order-notification-card${item.enabled ? ' enabled' : ''}${item.id === selectedId ? ' selected' : ''}`;
      card.innerHTML = `<div class="order-notification-main"><label class="order-notification-check"><input type="checkbox" ${item.enabled ? 'checked' : ''} aria-label="Ativar ${escapeHtml(item.title)}"><span></span></label><div class="order-notification-title"><strong>${escapeHtml(item.title)}</strong><em class="${item.mode}">${item.mode === 'automatic' ? 'Automático' : 'Ação da equipe'}</em></div></div><button type="button" class="secondary-action">Ver</button>`;
      card.querySelector('input').addEventListener('change', async event => {
        const workspace = document.querySelector('.workspace');
        const scrollTop = workspace?.scrollTop || 0;
        event.currentTarget.blur();
        item.enabled = event.currentTarget.checked;
        card.classList.toggle('enabled', item.enabled);
        if (workspace) workspace.scrollTop = scrollTop;
        window.requestAnimationFrame(() => {
          if (workspace) workspace.scrollTop = scrollTop;
        });
        await save(event.currentTarget);
        if (workspace) workspace.scrollTop = scrollTop;
      });
      card.querySelector('button').addEventListener('click', () => {
        selectedId = item.id;
        render();
        preview(item);
      });
      return card;
    }));
  }

  function preview(item) {
    document.querySelector('#reminder-preview-message').textContent = item.message
      .replace('{{cliente_nome}}', 'Mariana')
      .replace('{{numero_pedido}}', '#1024')
      .replace('{{tempo_entrega}}', '20')
      .replace('{{motivo_cancelamento}}', 'item indisponível');
    document.querySelector('#reminder-delivery-summary').textContent = item.title;
    document.querySelector('#reminder-delivery-detail').textContent = item.mode === 'automatic'
      ? 'Será enviada automaticamente quando esta etapa estiver conectada ao pedido.'
      : 'A equipe enviará esta atualização ao mudar o estado do pedido.';
  }

  async function save(control) {
    const card = control.closest('.order-notification-card');
    card?.classList.add('saving');
    control.setAttribute('aria-busy', 'true');
    try {
      const payload = notifications.map(item => ({ id: item.id, enabled: item.enabled }));
      const result = await call('saveOrderNotificationConfig', { organizationId: organization(), notifications: payload });
      notifications = result.data.notifications || notifications;
      feedback.classList.remove('error');
      feedback.textContent = 'Configuração salva.';
      window.setTimeout(() => { feedback.textContent = ''; }, 2200);
    } catch (error) {
      feedback.textContent = message(error);
      feedback.classList.add('error');
      await load(true);
    } finally {
      card?.classList.remove('saving');
      control.removeAttribute('aria-busy');
    }
  }

  document.querySelector('#automation-tab-reminders').addEventListener('click', () => {
    if (!enabled) return;
    window.setTimeout(() => {
      const selected = notifications.find(item => item.id === selectedId) || notifications[0];
      if (selected) preview(selected);
    });
  });

  return { configure, load };
}

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = String(value || '');
  return node.innerHTML;
}
