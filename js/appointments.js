import { appointmentPayment } from './appointment-payment.js';

export function createAppointmentsUI({ list, slots, update, organization, openConversation }) {
  const $ = selector => document.querySelector(selector);
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const today = () => new Intl.DateTimeFormat('en-CA',{ timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date());
  const localDate = key => new Date(`${key}T12:00:00-03:00`);
  const currency = value => value == null ? 'Valor não informado' : new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(value);
  const labels = { confirmed:'Confirmado', pet_received:'Pet recebido', pet_in_service:'Em atendimento', pet_ready:'Pronto', pet_out_for_delivery:'Saiu para entrega', completed:'Concluído', cancelled:'Cancelado', canceled:'Cancelado', no_show:'Não compareceu', pending:'Pendente', awaiting_payment:'Aguardando sinal', payment_expired:'Pagamento expirado', payment_review:'Revisar pagamento' };
  const cutoffLabel = minutes => minutes === 60 ? '1 hora' : minutes % 60 === 0 ? `${minutes / 60} horas` : `${minutes} minutos`;
  Object.assign(labels,{pet_pickup_started:'Saiu para buscar',pet_collected:'Pet buscado'});
  const activePetStatuses = ['confirmed','pet_pickup_started','pet_collected','pet_received','pet_in_service','pet_ready','pet_out_for_delivery'];
  function petSteps(item) {
    return [ ['confirmed','Confirmado'], ...(['pickup','both'].includes(item.transportId) ? [['pet_pickup_started','Saiu para buscar'],['pet_collected','Pet buscado']] : []), ['pet_received','Pet recebido'],['pet_in_service','Em atendimento'],['pet_ready',hasDelivery(item)?'Pronto para entrega':'Pronto para retirada'], ...(hasDelivery(item)?[['pet_out_for_delivery','Saiu para entrega']]:[]), ['completed',hasDelivery(item)?'Entregue':'Retirado'] ];
  }
  let date = today(), items = [], todayItems = [], selected = null, canManage = false, loading = false, request = 0, slotRequest = 0, pendingAction = '';
  const dialog = $('#appointment-dialog');
  for(const [value,text] of [['in_progress','Em andamento'],['pet_pickup_started','Saiu para buscar'],['pet_collected','Pet buscado']]) {const option=el('option','',text);option.value=value;$('#agenda-status').append(option);}
  const paymentFilterLabel=el('label','','Pagamento'), paymentFilterSelect=el('select');paymentFilterSelect.id='agenda-payment';
  for(const [value,text] of [['','Todos os pagamentos'],['paid','Pagos integralmente'],['partial','Pagos parcialmente'],['unpaid','Aguardando pagamento']]) {const option=el('option','',text);option.value=value;paymentFilterSelect.append(option);}
  paymentFilterLabel.append(paymentFilterSelect);$('#agenda-status').closest('.agenda-filters').append(paymentFilterLabel);
  $('#agenda-status').parentElement.firstChild.textContent='Situação do atendimento';
  $('#agenda-date').value = date;
  function button(text, cls, action) { const node = el('button',cls,text); node.type = 'button'; node.addEventListener('click',action); return node; }
  function hasDelivery(item) { return ['delivery','both'].includes(item.transportId); }
  function paymentLabel(item) {
    const payment = appointmentPayment(item);
    if(payment.fullyPaid) return `Pagamento integral confirmado · ${currency(payment.received / 100)}`;
    if(payment.reversed) return ({refunded:'Pagamento estornado',refund_pending:'Estorno em processamento',refund_failed:'Estorno precisa de atenção',retained:'Sinal retido conforme a política'})[item.paymentStatus];
    if(payment.partial) return `${payment.hasDeposit && payment.received <= payment.deposit ? 'Sinal pago' : 'Pagamento parcial'} · ${currency(payment.received / 100)} · Falta ${currency(payment.remaining == null ? null : payment.remaining / 100)}`;
    if(item.paymentStatus === 'pending') return payment.hasDeposit ? `Aguardando sinal · ${currency(payment.deposit / 100)}` : 'Aguardando pagamento';
    if(item.paymentStatus === 'expired') return payment.hasDeposit ? 'Sinal expirado' : 'Cobrança expirada';
    if(item.status === 'completed')return `Aguardando pagamento · ${currency(payment.remaining == null ? null : payment.remaining / 100)}`;
    return item.petName ? 'Pagamento ao final do atendimento' : 'Pagamento no estabelecimento';
  }
  function verifiedPaid() {
    const badge=el('span','appointment-paid-badge');
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
    const seal=document.createElementNS(svg.namespaceURI,'path');seal.setAttribute('d','M12 1.5 15 3l3.3.2 1.5 3 2.5 2.2-.7 3.3.7 3.3-2.5 2.2-1.5 3-3.3.2-3 1.5-3-1.5-3.3-.2-1.5-3L1.7 15l.7-3.3-.7-3.3 2.5-2.2 1.5-3L9 3Z');seal.setAttribute('fill','currentColor');
    const check=document.createElementNS(svg.namespaceURI,'path');check.setAttribute('d','m7.5 11.8 3 3 6-6');check.setAttribute('fill','none');check.setAttribute('stroke','white');check.setAttribute('stroke-width','2.2');check.setAttribute('stroke-linecap','round');check.setAttribute('stroke-linejoin','round');svg.append(seal,check);
    badge.append(svg,el('span','','Pago integralmente'));return badge;
  }
  function badge(item) { const label=item.status==='pet_ready' ? (hasDelivery(item)?'Pronto para entrega':'Pronto para retirada') : item.petName && item.status==='completed' ? (hasDelivery(item)?'Entregue':'Retirado') : labels[item.status] || item.status; return el('span',`appointment-badge ${item.status}`,label); }
  function empty(container, title, text) { const node = el('div','agenda-empty'); node.append(el('span','','▦'),el('strong','',title),el('p','',text)); container.replaceChildren(node); }
  function paintDate() {
    $('#agenda-date-title').textContent = new Intl.DateTimeFormat('pt-BR',{weekday:'long',day:'numeric',month:'long',timeZone:'America/Sao_Paulo'}).format(localDate(date));
    $('#agenda-day-tile').textContent = date.slice(8);
    $('#agenda-relative-day').textContent = date === today() ? 'HOJE, VAMOS COMEÇAR' : 'SUA AGENDA';
  }
  function row(item, compact = false) {
    const payment=appointmentPayment(item);
    const card = el('article',`appointment-row ${item.status}${compact ? ' compact' : ''}${payment.fullyPaid ? ' is-paid' : ''}`);
    const hour = el('div','appointment-hour'); hour.append(el('strong','',item.time),el('small','',`${item.duration} min`));
    const customer = el('div','appointment-customer'); customer.append(el('strong','',item.petName ? `${item.petName} · tutor ${item.customerName}` : item.customerName),el('span','',item.service + (item.optional ? ` + ${item.optional}` : '')));
    customer.append(el('small','appointment-payment-note',paymentLabel(item)));
    if(item.petName) customer.append(el('small','pet-transport-chip',item.transport || 'Tutor leva e busca'));
    const person = el('div','appointment-person'); person.append(el('span','person-dot',item.professional.slice(0,1).toUpperCase()),el('span','',item.professional));
    const side = el('div','appointment-row-side'); side.append(badge(item));if(payment.fullyPaid)side.append(verifiedPaid());side.append(button(compact ? 'Ver ↗' : 'Ver detalhes ↗','text-button',()=>details(item)));
    card.append(hour,customer,person,side); return card;
  }
  function render() {
    paintDate();
    const term = $('#agenda-search').value.trim().toLocaleLowerCase('pt-BR'), person = $('#agenda-professional').value, status = $('#agenda-status').value, paymentFilter=$('#agenda-payment').value;
    const petAgenda=items.some(item=>item.petName);
    $('#agenda-status').querySelector('[value="completed"]').textContent=petAgenda?'Entregues / retirados':'Atendimentos concluídos';
    const counts = new Map();
    items.forEach(item => { const key = item.status === 'canceled' ? 'cancelled' : item.status; counts.set(key, (counts.get(key) || 0) + 1); });
    const cardLabels = { confirmed:'Confirmados', pet_ready:'Pets prontos', completed:petAgenda?'Entregues / retirados':'Atendimentos concluídos', cancelled:'Cancelados', no_show:'Faltas', in_progress:'Em andamento' };
    const order = ['confirmed','pet_pickup_started','pet_collected','pet_received','pet_in_service','pet_ready','pet_out_for_delivery','completed','awaiting_payment','payment_expired','payment_review','cancelled','no_show'];
    const keys = ['', ...new Set([...order.filter(key => counts.has(key)), ...counts.keys(), ...(status ? [status] : [])])];
    $('#agenda-status-cards').replaceChildren(...keys.map(key => {
      const count = key === '' ? items.length : key === 'in_progress' ? items.filter(item => activePetStatuses.includes(item.status) && item.status !== 'confirmed').length : counts.get(key) || 0;
      const card = button('', `agenda-status-card${status === key ? ' selected' : ''}`, () => { $('#agenda-status').value = key; render(); });
      card.setAttribute('aria-pressed', String(status === key));
      card.append(el('span','',key ? cardLabels[key] || labels[key] || key : 'Todos'), el('strong','',String(count)));
      return card;
    }));
    const filtered = items.filter(a => {
      const payment=appointmentPayment(a);
      return (!paymentFilter || (paymentFilter==='paid' && payment.fullyPaid) || (paymentFilter==='partial' && payment.partial) || (paymentFilter==='unpaid' && !payment.fullyPaid && !payment.partial && !payment.reversed)) && (!person || (a.professionalId || a.professional) === person) && (!status || a.status === status || (status === 'in_progress' && activePetStatuses.includes(a.status) && a.status !== 'confirmed') || (status === 'cancelled' && a.status === 'canceled')) && (!term || `${a.customerName} ${a.petName || ''} ${a.phone} ${a.service}`.toLocaleLowerCase('pt-BR').includes(term));
    });
    $('#agenda-count').textContent = `${filtered.length} atendimento${filtered.length === 1 ? '' : 's'}${filtered.length !== items.length ? ` de ${items.length}` : ''}`;
    const container = $('#agenda-list');
    if (!filtered.length) {
      empty(container, status ? 'Nenhum atendimento nesta etapa' : items.length ? 'Nenhum resultado por aqui' : 'Um espaço livre no seu dia',items.length ? 'Experimente outra busca ou ajuste os filtros.' : 'Os agendamentos feitos pelo WhatsApp aparecerão aqui. Escolha outra data para consultar sua agenda.');
      if(status || paymentFilter)container.firstChild.append(button('Limpar filtros','secondary-action',()=>{$('#agenda-status').value='';$('#agenda-payment').value='';$('#agenda-professional').value='';$('#agenda-search').value='';render();}));
    }
    else container.replaceChildren(...filtered.map(a=>row(a)));
    $('#metric-today').textContent = todayItems.filter(a=>!['cancelled','canceled','payment_expired'].includes(a.status)).length;
    $('#metric-closed').textContent = todayItems.filter(a=>a.status === 'completed').length;
    const next = todayItems.find(a=>a.status==='confirmed' && new Date(`${a.date}T${a.time}:00-03:00`).getTime()>=Date.now());
    $('#metric-next').textContent = next?.time || '—';
    $('#metric-next-name').textContent = next?.customerName || 'sem próximos horários hoje';
    const overview = $('#overview-appointments');
    if (!todayItems.length) empty(overview,'Sua agenda de hoje está livre','Os próximos atendimentos aparecerão aqui assim que forem agendados.');
    else overview.replaceChildren(...todayItems.filter(a=>!['cancelled','canceled','payment_expired'].includes(a.status)).slice(0,6).map(a=>row(a,true)));
    if (todayItems.length && !overview.children.length) empty(overview,'Nenhum atendimento ativo hoje','Você pode consultar os cancelamentos na agenda completa.');
  }
  async function refresh() {
    if (!organization()) return;
    const revision = ++request; loading = true;
    const control = $('#agenda-refresh'); control.disabled = true; control.textContent = 'Atualizando…';
    $('#agenda-feedback').hidden = true;
    try {
      const result = await list({ organizationId:organization(), date });
      if (revision !== request) return;
      items = result.data.appointments || []; todayItems = result.data.todayAppointments || []; canManage = result.data.canManage;
      const filter = $('#agenda-professional'), previous = filter.value;
      const all = el('option','','Toda a equipe'); all.value='';
      const people = new Map((result.data.professionals || []).map(p=>[p.id,p.name]));
      items.forEach(a=>{ if(!people.has(a.professionalId || a.professional)) people.set(a.professionalId || a.professional,a.professional); });
      filter.replaceChildren(all,...[...people].map(([id,name])=>{ const node=el('option','',name);node.value=id;return node; }));
      if([...filter.options].some(o=>o.value===previous)) filter.value=previous;
      render();
      if(selected) { const fresh=items.find(a=>a.id===selected.id); if(fresh && dialog.open) details(fresh); }
    } catch(error) {
      if(revision !== request) return;
      $('#agenda-feedback').textContent=error.message || 'Não foi possível carregar a agenda.';$('#agenda-feedback').hidden=false;
      empty($('#agenda-list'),'Não foi possível carregar a agenda','Use Atualizar agenda para tentar novamente.');
      empty($('#overview-appointments'),'Agenda temporariamente indisponível','Abra Agendamentos para atualizar e tentar novamente.');
    } finally { if(revision === request) {loading=false;control.disabled=false;control.textContent='↻ Atualizar agenda';} }
  }
  function details(item) {
    dialog.append($('#appointment-confirm'));
    dialog.append($('#appointment-feedback'));
    selected=item; pendingAction=''; slotRequest++;
    $('#appointment-name').textContent=item.customerName;
    $('#appointment-reschedule').hidden=true;$('#appointment-feedback').hidden=true;$('#appointment-confirm').hidden=true;
    const header=el('div','appointment-detail-highlight');header.append(el('strong','',`${item.time} · ${new Intl.DateTimeFormat('pt-BR',{day:'numeric',month:'long',timeZone:'America/Sao_Paulo'}).format(localDate(item.date))}`),badge(item));
    const dl=el('dl','appointment-fields');
    const reminder={ sent:'Enviado',failed:'Falha no envio',pending:'Pendente' }[item.reminderStatus] || 'Pendente';
    const fields=[['Serviço',item.service],['Adicionais',item.optional || 'Nenhum adicional'],['Profissional',item.professional],['Duração',`${item.duration} minutos`],['Valor',currency(item.price)],['WhatsApp',item.phone],['Lembrete',reminder]];
    if(item.petName) fields.splice(1,0,['Pet',`${item.petName} · ${{male:'macho',female:'fêmea',unknown:'sexo não informado'}[item.petSex] || 'sexo não informado'}`],['Transporte',item.transport || 'Levar e buscar no local']);
    fields.forEach(([name,value])=>{const field=el('div');field.append(el('dt','',name),el('dd','',value));dl.append(field);});
    $('#appointment-detail').replaceChildren(header,dl);
    if(item.petName) {
      const panel=el('section','pet-progress-panel');
      const heading=el('header','pet-progress-heading'); heading.append(el('span','','ACOMPANHAR ATENDIMENTO'),el('h3','',item.petName),el('p','',item.transport || 'Tutor leva e busca no estabelecimento'));
      const steps=petSteps(item), index=steps.findIndex(([key])=>key===item.status);
      const timeline=el('ol','pet-progress-timeline');
      steps.forEach(([key,label],i)=>{
        const row=el('li',i===index?'current':i<index?'done':'');
        if(i===index) row.setAttribute('aria-current','step');
        const copy=el('div');copy.append(el('strong','',label));
        const stamp=item.petTimeline?.[key];
        if(stamp)copy.append(el('small','',new Date(stamp).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})));
        row.append(el('span','pet-step-marker',i<index?'✓':String(i+1)),copy);
        if(i === index + 1 && index >= 0 && canManage && activePetStatuses.includes(item.status)) {
          row.classList.add('next');
          const action = key === 'completed' ? 'complete' : key;
          const actionLabel = {pet_pickup_started:'Confirmar saída',pet_collected:'Confirmar busca',pet_received:'Confirmar chegada',pet_in_service:'Iniciar atendimento',pet_ready:'Marcar como pronto',pet_out_for_delivery:'Confirmar saída',completed:hasDelivery(item)?'Confirmar entrega':'Confirmar retirada'}[key];
          copy.append(el('small','pet-step-next-label','PRÓXIMA ETAPA'));
          row.append(button(actionLabel,'pet-step-action',()=>confirmAction(action,`${label} para ${item.petName}? Os avisos ativados serão enviados ao tutor.`,row)));
        } else if(i > index && index >= 0) { row.classList.add('locked'); copy.append(el('small','pet-step-locked','Aguardando etapa anterior')); }
        timeline.append(row);
      });
      panel.append(heading,timeline);
      const messageStates=Object.values(item.petMessageStatuses || {}), failures=messageStates.filter(state=>state.status==='failed');
      if(failures.length)panel.append(el('p','pet-operation-warning',`${failures.length} aviso(s) com falha no envio. O status do atendimento foi salvo. Confira a conversa e as configurações em Lembretes.`));
      panel.append(el('p','pet-progress-note','Os avisos ao tutor seguem as opções ativadas em Automações → Lembretes.'));
      $('#appointment-detail').prepend(panel);
      if(['pickup','delivery','both'].includes(item.transportId)) {
        const transport=el('section','pet-transport-panel');transport.append(el('h3','','Informações do transporte'),el('p','','Confira com o tutor o endereço e as instruções antes de sair.'));
        const form=el('form','pet-transport-form');
        for(const [key,label,value,max] of [['transport_address','Endereço e complemento',item.transportAddress,500],['transport_reference','Ponto de referência',item.transportReference,200],['transport_instructions','Instruções de transporte',item.transportInstructions,500]]) {
          const field=el('label','',label),input=el('textarea');input.name=key;input.value=value || '';input.maxLength=max;input.rows=2;input.disabled=!canManage || !activePetStatuses.includes(item.status);field.append(input);form.append(field);
        }
        if(canManage && activePetStatuses.includes(item.status)) {
          const save=el('button','secondary-action','Salvar transporte');save.type='submit';const feedback=el('p','','');feedback.setAttribute('role','status');form.append(save,feedback);
          form.addEventListener('submit',async event=>{event.preventDefault();save.disabled=true;try{const fields=Object.fromEntries(new FormData(form));await update({organizationId:organization(),appointmentId:item.id,action:'save_transport',...fields});Object.assign(item,{transportAddress:fields.transport_address,transportReference:fields.transport_reference,transportInstructions:fields.transport_instructions});feedback.textContent='Informações salvas.';}catch(error){feedback.textContent=error.message;}finally{save.disabled=false;}});
        }
        transport.append(form);$('#appointment-detail').append(transport);
      }
    }
    const payment=appointmentPayment(item);
    const paymentPanel=el('section','appointment-payment-panel');paymentPanel.append(el('h3','','Pagamento'),el('p','',paymentLabel(item)),el('small','',item.petName?'O pagamento é independente da entrega ou retirada do pet.':'O pagamento é independente da conclusão do atendimento.'));
    if(payment.fullyPaid)paymentPanel.append(verifiedPaid());
    const paymentFields=el('dl','appointment-fields');
    const financialFields=[...(payment.hasDeposit ? [['Sinal previsto',currency(payment.deposit / 100)]] : []),['Valor recebido',currency(payment.received / 100)],['Saldo a receber',currency(payment.remaining == null ? null : payment.remaining / 100)]];
    financialFields.forEach(([name,value])=>{const field=el('div');field.append(el('dt','',name),el('dd','',value));paymentFields.append(field);});paymentPanel.append(paymentFields);$('#appointment-detail').append(paymentPanel);
    if(item.paymentExpiresAt && item.status === 'awaiting_payment') {const field=el('div');field.append(el('dt','','Prazo do Pix'),el('dd','',new Date(item.paymentExpiresAt).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})));dl.append(field);}
    if(item.paymentStatus === 'paid' && payment.hasDeposit) dl.append(el('p','payment-help',`Cancelamentos dentro do prazo solicitam o estorno automaticamente. Remarcações usadas: ${item.rescheduleCount || 0}.`));
    if(item.paymentStatus === 'refunded') dl.append(el('p','payment-help',`Sinal devolvido automaticamente: ${currency(item.refunded || item.paid)}.`));
    if(item.paymentStatus === 'retained') dl.append(el('p','payment-help',`Sinal mantido por cancelamento fora do prazo: ${currency(item.retained || item.paid)}.`));
    if(item.paymentStatus === 'refund_failed') dl.append(el('p','payment-help',`Estorno pendente de atenção: ${item.refundError || 'o sistema tentará novamente automaticamente.'}`));
    if(item.paymentStatus === 'refund_pending') dl.append(el('p','payment-help',`Estorno de ${currency(item.paid)} aguardando confirmação.`));
    if(item.paymentStatus === 'paid' && payment.hasDeposit) {
      const cutoff = Number(item.changePolicy?.refundCutoffMinutes || 60);
      const deadline = new Date(new Date(`${item.date}T${item.time}:00-03:00`).getTime() - cutoff * 60000);
      const field=el('div');field.append(el('dt','','Prazo para estorno'),el('dd','',`${deadline.toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})} · ${cutoffLabel(cutoff)} antes`));dl.append(field);
    }
    if(item.refundProviderId) {const field=el('div');field.append(el('dt','','Comprovante do estorno'),el('dd','',item.refundProviderId));dl.append(field);}
    const actions=$('#appointment-actions');actions.replaceChildren();actions.classList.toggle('pet-footer-actions',Boolean(item.petName));
    if(item.conversationId) {
      const conversationButton = button('Abrir conversa ↗','secondary-action',async()=>{dialog.close();await openConversation(item);});
      if(item.petName) { conversationButton.classList.add('pet-open-conversation'); $('#appointment-detail').append(conversationButton); }
      else actions.append(conversationButton);
    }
    if(canManage && item.petName && activePetStatuses.includes(item.status)) {
      if(item.status==='confirmed') actions.append(button('Marcar falta','secondary-action',()=>confirmAction('no_show','Registrar que o tutor não levou o pet?')));
      actions.append(button('Cancelar agendamento','danger-action',()=>confirmAction('cancel',item.paymentStatus === 'paid' ? 'Cancelar e aplicar automaticamente a política de devolução do sinal?' : 'Cancelar este agendamento e liberar o horário?')));
    } else if(canManage && item.status==='confirmed') {
      actions.append(button('✓ Concluir atendimento','primary-action',()=>confirmAction('complete','Marcar este atendimento como concluído?')));
      actions.append(button('Remarcar','secondary-action',()=>{ $('#appointment-reschedule').hidden=false;$('#appointment-new-date').value=item.date;loadSlots(); }));
      actions.append(button('Marcar falta','secondary-action',()=>confirmAction('no_show','Registrar que o cliente não compareceu?')));
      actions.append(button('Cancelar agendamento','danger-action',()=>confirmAction('cancel',item.paymentStatus === 'paid' ? 'Cancelar e aplicar automaticamente a política de devolução do sinal?' : 'Cancelar este agendamento e liberar o horário?')));
    }
    if(canManage && ['cancelled','canceled'].includes(item.status) && ['refund_failed','refund_pending'].includes(item.paymentStatus)) actions.append(button('↻ Tentar estorno novamente','primary-action',()=>confirmAction('retry_refund',`Solicitar novamente o estorno de ${currency(item.paid)}? A proteção contra duplicidade permanecerá ativa.`)));
    if(!dialog.open) dialog.showModal();
  }
  function confirmAction(action,copy,anchor) { pendingAction=action;const confirmation=$('#appointment-confirm');(anchor || dialog).append(confirmation);$('#appointment-confirm-copy').textContent=copy;confirmation.hidden=false;confirmation.scrollIntoView({block:'nearest',behavior:'smooth'});$('#appointment-confirm-do').focus({preventScroll:true}); }
  async function loadSlots() {
    const revision=++slotRequest, id=selected?.id, select=$('#appointment-new-time');select.replaceChildren(el('option','','Carregando horários…'));select.disabled=true;
    $('#appointment-feedback').hidden=true;
    try {
      const result=await slots({organizationId:organization(),appointmentId:id,date:$('#appointment-new-date').value});
      if(revision!==slotRequest || selected?.id!==id)return;
      const times=result.data.times || [];
      select.replaceChildren(...(times.length ? times.map(time=>{const o=el('option','',time);o.value=time;return o;}) : [el('option','','Sem horários disponíveis')]));
      if(!times.length)select.options[0].value='';
      select.disabled=!times.length;
    } catch(error){if(revision!==slotRequest)return;$('#appointment-feedback').textContent=error.message;$('#appointment-feedback').hidden=false;select.replaceChildren(el('option','','Não foi possível carregar'));}
  }
  async function perform(action) {
    if(!selected)return;
    const controls=[...dialog.querySelectorAll('button')];controls.forEach(b=>b.disabled=true);$('#appointment-feedback').hidden=true;
    try {
      const result=await update({organizationId:organization(),appointmentId:selected.id,action,...(action==='reschedule' ? {date:$('#appointment-new-date').value,time:$('#appointment-new-time').value} : {})});
      const keepOpen = selected.petName && ['pet_pickup_started','pet_collected','pet_received','pet_in_service','pet_ready','pet_out_for_delivery','complete'].includes(action);
      if(!keepOpen){dialog.close();selected=null;}
      await refresh();
      const petNotification=result.data.petNotification;
      $('#agenda-feedback').textContent=action==='retry_refund' ? 'Estorno confirmado.' : petNotification?.status==='failed' ? `Etapa atualizada, mas a mensagem não foi enviada: ${petNotification.error}` : result.data.reminderQueued===false ? 'Agendamento atualizado. O lembrete não pôde ser programado; confira os detalhes.' : petNotification?.status==='sent' ? 'Etapa atualizada e tutor avisado pelo WhatsApp.' : 'Agendamento atualizado com sucesso.';$('#agenda-feedback').hidden=false;
      if(keepOpen && dialog.open){$('#appointment-feedback').textContent=$('#agenda-feedback').textContent;$('#appointment-feedback').hidden=false;const panel=dialog.querySelector('.pet-progress-panel');panel.append($('#appointment-feedback'));}
    }catch(error){$('#appointment-feedback').textContent=error.message;$('#appointment-feedback').hidden=false;}
    finally{controls.forEach(b=>b.disabled=false);}
  }
  function changeDate(value) { date=value;$('#agenda-status').value='';$('#agenda-date').value=date;paintDate();refresh(); }
  $('#agenda-date').addEventListener('change',event=>{if(event.target.value)changeDate(event.target.value);});
  $('#agenda-prev').addEventListener('click',()=>changeDate(new Date(localDate(date).getTime()-86400000).toISOString().slice(0,10)));
  $('#agenda-next').addEventListener('click',()=>changeDate(new Date(localDate(date).getTime()+86400000).toISOString().slice(0,10)));
  $('#agenda-today').addEventListener('click',()=>changeDate(today()));
  $('#agenda-refresh').addEventListener('click',refresh);
  ['#agenda-search','#agenda-professional','#agenda-status','#agenda-payment'].forEach(selector=>$(selector).addEventListener(selector.includes('search')?'input':'change',render));
  $('#appointment-close').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{slotRequest++;});
  $('#appointment-new-date').addEventListener('change',loadSlots);
  $('#appointment-reschedule').addEventListener('submit',event=>{event.preventDefault();if(!$('#appointment-new-time').disabled)confirmAction('reschedule','Confirmar a nova data e horário deste atendimento?');});
  $('#appointment-confirm-back').addEventListener('click',()=>{$('#appointment-confirm').hidden=true;pendingAction='';});
  $('#appointment-confirm-do').addEventListener('click',()=>{if(pendingAction)perform(pendingAction);});
  setInterval(()=>{if(!document.hidden && !dialog.open && organization() && !loading && ($('#view-overview').classList.contains('active') || $('#view-appointments').classList.contains('active'))) refresh();},60000);
  return { refresh };
}
