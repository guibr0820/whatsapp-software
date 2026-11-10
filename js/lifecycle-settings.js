const GROUPS = { appointments: "Agendamentos", relationship: "Relacionamento e vendas", orders: "Pedidos e delivery" };
const NOTES = { requires_waitlist: "Requer o cadastro da lista de espera", requires_quotes: "Requer o módulo de orçamentos", requires_marketing_consent: "Será liberado com controle de consentimento", available: "Disponível" };

export function automationApplies(item, segment = []) {
  const screens = Array.isArray(segment) ? segment : (segment?.screens || []);
  const modules = Array.isArray(segment) ? [] : (segment?.modules || []);
  const segmentId = Array.isArray(segment) ? '' : String(segment?.id || '');
  if (item.segmentId && item.segmentId !== segmentId) return false;
  if (item.group === "orders") return screens.some(value => ["orders", "deliveries", "menu"].includes(value));
  if (item.group === "appointments") return screens.includes("appointments");
  if (item.id === "quote_followup") return !modules.length || modules.includes("quotes");
  if (item.id === "enrollment_followup") return modules.includes("enrollment");
  if (item.id === "visit_followup") return modules.includes("visits");
  return true;
}

export function appointmentAutomationApplies(screens = []) {
  return screens.includes("appointments");
}

export function visibleAutomationGroups(automations = [], segment = []) {
  return Object.entries(GROUPS).map(([group, title]) => ({ group, title, items: automations.filter(item => item.group === group && automationApplies(item, segment)) })).filter(section => section.items.length > 0);
}

export function createLifecycleSettingsUI({ organization, organizationName = () => 'Estabelecimento', call, message }) {
  let automations = [];
  let canEdit = false;
  let loaded = false;
  let segment = [];
  const applies = item => automationApplies(item, segment);

  async function load(force = false) {
    if ((!force && loaded) || !organization()) return;
    const overview = document.querySelector("#lifecycle-reminder-overview");
    try {
      const result = await call("getLifecycleAutomationConfig", { organizationId: organization() });
      automations = result.data.automations || [];
      canEdit = result.data.canEdit === true;
      loaded = true;
      renderOverview(overview);
    } catch (error) {
      overview.innerHTML = `<p class="lifecycle-error">${escapeHtml(message(error))}</p>`;
    }
  }

  function configure(value = []) { segment = value; loaded = false; }

  function renderOverview(container) {
    container.replaceChildren(...visibleAutomationGroups(automations, segment).map(({ group, title, items }) => {
      const section = document.createElement("section");
      section.className = "lifecycle-group";
      section.innerHTML = `<header><div><span>${group === "appointments" ? "AGENDA" : group === "orders" ? "DELIVERY" : "RELACIONAMENTO"}</span><h3>${title}</h3></div><em>${items.length} automações</em></header><div class="lifecycle-card-grid"></div>`;
      section.querySelector(".lifecycle-card-grid").replaceChildren(...items.map(item => {
        const card = document.createElement("article");
        card.className = `lifecycle-summary${item.active ? " active" : ""}${item.availability !== "available" ? " pending" : ""}`;
        const locked = item.availability !== "available" || !canEdit;
        card.innerHTML = `<span class="lifecycle-icon">${icon(item.id)}</span><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.description)}</p><small>${item.availability === "available" ? (item.active ? "Ativa" : "Pausada") : NOTES[item.availability]}</small></div><div class="lifecycle-card-actions"><button type="button">Ver</button><label class="lifecycle-checkbox" title="${locked ? escapeHtml(NOTES[item.availability] || 'Somente o proprietário pode alterar') : item.active ? 'Desativar automação' : 'Ativar automação'}"><input type="checkbox" ${item.active ? "checked" : ""} ${locked ? "disabled" : ""} aria-label="Ativar ${escapeHtml(item.title)}"></label></div>`;
        const actions = card.querySelector('.lifecycle-card-actions');
        actions.style.cssText = 'display:flex;align-items:center;gap:10px';
        card.querySelector("button").onclick = () => showPreview(item, organizationName());
        const checkbox = card.querySelector("input");
        checkbox.style.cssText = "width:20px;height:20px;accent-color:#159451;cursor:pointer";
        checkbox.onchange = async () => {
          const previous = item.active; item.active = checkbox.checked; checkbox.disabled = true;
          card.classList.toggle("active",item.active); card.querySelector("small").textContent = "Salvando…";
          try {
            const values = automations.map(value => ({ id:value.id,active:value.active,templateName:value.templateName,language:value.language,message:value.message,...(value.delayMinutes !== undefined?{delayMinutes:value.delayMinutes}:{}),...(value.delayDays !== undefined?{delayDays:value.delayDays}:{}) }));
            const result = await call("saveLifecycleAutomationConfig",{organizationId:organization(),automations:values});
            automations = result.data.automations || automations; renderOverview(container);
          } catch (error) {
            item.active = previous; checkbox.checked = previous; checkbox.disabled = false; card.classList.toggle("active",previous); card.querySelector("small").textContent = message(error);
          }
        };
        return card;
      }));
      return section;
    }));
  }

  function renderEditor(container) {
    container.replaceChildren(...automations.filter(applies).map(item => {
      const locked = item.availability !== "available";
      const card = document.createElement("article");
      card.className = `settings-automation-card${locked ? " locked" : ""}`;
      card.dataset.automationId = item.id;
      const delayDayOptions = (item.delayDaysOptions || [30,60,90]).map(days => `<option value="${days}">${days} dias</option>`).join('');
      const delay = item.delayDays !== undefined
        ? `<label>${item.id === 'pet_return_reminder' ? 'Enviar novo lembrete após' : 'Cliente sem retornar por'}<select data-field="delayDays">${delayDayOptions}</select></label>`
        : item.delayMinutes !== undefined
          ? `<label>Aguardar antes de enviar<select data-field="delayMinutes"><option value="0">Imediatamente</option><option value="60">1 hora</option><option value="120">2 horas</option><option value="1440">1 dia</option><option value="2880">2 dias</option></select></label>`
          : '';
      const configuration = item.fixedMessage
        ? `<div class="profile-field-wide settings-fixed-message"><strong>Mensagem automática</strong><p>${escapeHtml(item.previewMessage || 'O texto será montado com os dados do atendimento.')}</p><small>O sistema ajusta nome e sexo do pet e usa o modelo Meta ${escapeHtml(item.templateName || item.template_name || 'atualizacao_pet')}.</small></div>`
        : item.freeform
        ? `<label class="profile-field-wide">Mensagem<textarea data-field="message" maxlength="1000" ${!canEdit ? "disabled" : ""}>${escapeHtml(item.message || '')}</textarea><small>Use {{cliente_nome}} e {{empresa_nome}} para personalizar.</small></label>${delay}`
        : `<label>Modelo aprovado pela Meta<input data-field="templateName" value="${escapeHtml(item.templateName)}" ${!canEdit ? "disabled" : ""}></label><label>Idioma<input data-field="language" value="${escapeHtml(item.language)}" ${!canEdit ? "disabled" : ""}></label>${delay}`;
      card.innerHTML = `<header><span class="lifecycle-icon">${icon(item.id)}</span><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.description)}</p></div><label class="settings-switch"><input data-field="active" type="checkbox" ${item.active ? "checked" : ""} ${locked || !canEdit ? "disabled" : ""}><i></i></label></header><div class="settings-automation-fields">${configuration}</div><footer><span>${locked ? NOTES[item.availability] : "Conta no consumo de mensagens automáticas"}</span><em>${locked ? "Em preparação" : item.active ? "Ativa" : "Pausada"}</em></footer>`;
      const timing = card.querySelector('[data-field="delayDays"], [data-field="delayMinutes"]');
      if (timing) { timing.value = String(item.delayDays ?? item.delayMinutes ?? 0); timing.disabled = !canEdit || locked; }
      card.querySelectorAll("input").forEach(input => { if (locked && input.dataset.field !== "active") input.disabled = true; });
      return card;
    }));
  }

  async function save(event) {
    event.preventDefault();
    const feedback = document.querySelector("#lifecycle-settings-feedback");
    const button = document.querySelector("#save-lifecycle-settings");
    if (!canEdit) return;
    const values = automations.map(item => {
      const card = document.querySelector(`[data-automation-id="${item.id}"]`);
      if (!card) return item;
      return { id: item.id, active: card.querySelector('[data-field="active"]').checked, templateName: card.querySelector('[data-field="templateName"]')?.value.trim() || item.templateName, language: card.querySelector('[data-field="language"]')?.value.trim() || item.language, message: card.querySelector('[data-field="message"]')?.value.trim() || item.message, ...(card.querySelector('[data-field="delayMinutes"]') ? { delayMinutes: Number(card.querySelector('[data-field="delayMinutes"]').value) } : {}), ...(card.querySelector('[data-field="delayDays"]') ? { delayDays: Number(card.querySelector('[data-field="delayDays"]').value) } : {}) };
    });
    button.disabled = true; button.textContent = "Salvando…";
    try {
      const result = await call("saveLifecycleAutomationConfig", { organizationId: organization(), automations: values });
      automations = result.data.automations || automations;
      feedback.textContent = "Ajustes salvos. As novas regras já valem para os próximos eventos.";
      feedback.className = "settings-feedback success";
      renderOverview(document.querySelector("#lifecycle-reminder-overview"));
      renderEditor(document.querySelector("#lifecycle-settings-list"));
    } catch (error) { feedback.textContent = message(error); feedback.className = "settings-feedback error"; }
    finally { button.disabled = false; button.textContent = "Salvar ajustes"; }
  }

  return { load, configure };
}

function showPreview(item, companyName = 'Estabelecimento') {
  const preview = document.querySelector('.reminder-preview-panel');
  const message = document.querySelector('#reminder-preview-message');
  const title = document.querySelector('#reminder-delivery-summary');
  const detail = document.querySelector('#reminder-delivery-detail');
  const samples = {
    welcome_message: String(item.message || '').replaceAll('{{cliente_nome}}','Mariana').replaceAll('{{empresa_nome}}',companyName),
    pet_pickup_started:'Olá, Mariana! Nossa equipe está a caminho para buscar Luna. Deixe tudo pronto!',
    pet_collected:'Olá, Mariana! Luna já está com nossa equipe, a caminho do pet shop.',
    pet_delivered:'Olá, Mariana! A entrega de Luna foi concluída. Obrigado pela confiança!',
    pet_received: 'Olá, Mariana! Luna chegou e foi recebida com segurança.',
    pet_in_service: 'Olá, Mariana! O atendimento de Luna começou. Ela está sendo cuidada pela nossa equipe.',
    pet_ready_pickup: 'Olá, Mariana! Luna já está pronta para você vir buscá-la.',
    pet_out_for_delivery: 'Olá, Mariana! Luna já está a caminho de casa. Prepare-se para recebê-la!',
    pet_post_appointment: `Olá, Mariana! Como foi a experiência de Luna com a ${companyName}? Sua avaliação é muito importante.`,
    pet_return_reminder: `Olá, Mariana! Já está chegando a hora de um novo cuidado para Luna na ${companyName}.`,
    waitlist: 'Olá, Mariana! Abriu um horário hoje às 16:00. Quer ficar com ele? Responda para confirmar.',
    customer_recovery: `Olá, Mariana! Sentimos sua falta por aqui. Que tal agendar um novo horário na ${companyName}?`,
    quote_followup: 'Olá, Mariana! Conseguiu analisar o orçamento que enviamos? Se tiver alguma dúvida, podemos ajudar.',
    enrollment_followup: `Olá, Mariana! Você gostaria de continuar sua matrícula na ${companyName}? Se tiver alguma dúvida, podemos ajudar.`,
    visit_followup: `Olá, Mariana! Você gostaria de continuar o agendamento da sua visita com a ${companyName}?`,
    post_appointment: `Obrigada pela preferência, Mariana! Como foi seu atendimento na ${companyName}? Sua avaliação nos ajuda muito.`,
    post_order: 'Pedido entregue! Esperamos que tenha gostado. Como foi sua experiência? Sua avaliação nos ajuda muito.',
  };
  message.textContent = samples[item.id] || item.description;
  title.textContent = item.title;
  detail.textContent = item.active ? 'Automação ativa. A mensagem usa os dados reais do cliente.' : item.availability === 'available' ? 'Automação pausada. Esta é apenas uma prévia.' : NOTES[item.availability];
  preview.hidden = false;
  preview.scrollIntoView({behavior:'smooth',block:'center'});
  preview.animate([{transform:'scale(1)',filter:'drop-shadow(0 0 0 rgba(21,148,81,0))'},{transform:'scale(1.015)',filter:'drop-shadow(0 0 14px rgba(21,148,81,.28))'},{transform:'scale(1)',filter:'drop-shadow(0 0 0 rgba(21,148,81,0))'}],{duration:900,easing:'ease-out'});
}

function icon(id) { return { welcome_message:"☀", pet_received:"⌂", pet_in_service:"✦", pet_ready_pickup:"✓", pet_out_for_delivery:"↗", pet_post_appointment:"☆", pet_return_reminder:"↻", waitlist: "⌛", customer_recovery: "↻", quote_followup: "✉", enrollment_followup: "▣", visit_followup: "⌂", post_appointment: "☆", post_order: "★" }[id] || "◷"; }
function escapeHtml(value) { const node = document.createElement("span"); node.textContent = String(value || ""); return node.innerHTML; }
