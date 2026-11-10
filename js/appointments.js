export function createAppointmentsUI({ list, slots, update, organization, openConversation }) {
  const $ = selector => document.querySelector(selector);
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const today = () => new Intl.DateTimeFormat('en-CA',{ timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date());
  const localDate = key => new Date(`${key}T12:00:00-03:00`);
  const currency = value => value == null ? 'Valor não informado' : new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(value);
  const labels = { confirmed:'Confirmado', pet_received:'Pet recebido', pet_in_service:'Em atendimento', pet_ready:'Pronto', pet_out_for_delivery:'Saiu para entrega', completed:'Concluído', cancelled:'Cancelado', canceled:'Cancelado', no_show:'Não compareceu', pending:'Pendente', awaiting_payment:'Aguardando sinal', payment_expired:'Pagamento expirado', payment_review:'Revisar pagamento' };
  const cutoffLabel = minutes => minutes === 60 ? '1 hora' : minutes % 60 === 0 ? `${minutes / 60} horas` : `${minutes} minutos`;
  Object.assign(labels,{pet_pickup_started:'Saiu para buscar',pet_collected:'Pet coletado'});
  const activePetStatuses = ['confirmed','pet_pickup_started','pet_collected','pet_received','pet_in_service','pet_ready','pet_out_for_delivery'];
  function petSteps(item) {
    return [ ['confirmed','Confirmado'], ...(['pickup','both'].includes(item.transportId) ? [['pet_pickup_started','Saiu para buscar'],['pet_collected','Pet coletado']] : []), ['pet_received','Pet recebido'],['pet_in_service','Em atendimento'],['pet_ready',hasDelivery(item)?'Pronto para entrega':'Pronto para retirada'], ...(hasDelivery(item)?[['pet_out_for_delivery','Saiu para entrega']]:[]), ['completed',hasDelivery(item)?'Entregue':'Retirado'] ];
  }
  let date = today(), items = [], todayItems = [], selected = null, canManage = false, loading = false, request = 0, slotRequest = 0, pendingAction = '';
  const dialog = $('#appointment-dialog');
  for(const [value,text] of [['in_progress','Em andamento'],['pet_pickup_started','Saiu para buscar'],['pet_collected','Pet coletado']]) {const option=el('option','',text);option.value=value;$('#agenda-status').append(option);}
  $('#agenda-date').value = date;
  function button(text, cls, action) { const node = el('button',cls,text); node.type = 'button'; node.addEventListener('click',action); return node; }
  function hasDelivery(item) { return ['delivery','both'].includes(item.transportId); }
  function badge(item) { const label=item.status==='pet_ready' ? (hasDelivery(item)?'Pronto para entrega':'Pronto para retirada') : item.petName && item.status==='completed' ? (hasDelivery(item)?'Entregue':'Retirado') : labels[item.status] || item.status; return el('span',`appointment-badge ${item.status}`,label); }
  function empty(container, title, text) { const node = el('div','agenda-empty'); node.append(el('span','','▦'),el('strong','',title),el('p','',text)); container.replaceChildren(node); }
  function paintDate() {
    $('#agenda-date-title').textContent = new Intl.DateTimeFormat('pt-BR',{weekday:'long',day:'numeric',month:'long',timeZone:'America/Sao_Paulo'}).format(localDate(date));
    $('#agenda-day-tile').textContent = date.slice(8);
    $('#agenda-relative-day').textContent = date === today() ? 'HOJE, VAMOS COMEÇAR' : 'SUA AGENDA';
  }
  function row(item, compact = false) {
    const card = el('article',`appointment-row ${item.status}${compact ? ' compact' : ''}`);
    const hour = el('div','appointment-hour'); hour.append(el('strong','',item.time),el('small','',`${item.duration} min`));
    const customer = el('div','appointment-customer'); customer.append(el('strong','',item.petName ? `${item.petName} · tutor ${item.customerName}` : item.customerName),el('span','',item.service + (item.optional ? ` + ${item.optional}` : '')));
    customer.append(el('small','appointment-payment-note',item.paymentStatus === 'paid' ? `Sinal pago · ${currency(item.paid)}` : item.paymentStatus === 'pending' ? `Sinal pendente · ${currency(item.deposit)}` : item.paymentStatus === 'expired' ? 'Pix expirado · horário liberado' : 'Pagamento no estabelecimento'));
    if(item.petName) customer.append(el('small','pet-transport-chip',item.transport || 'Tutor leva e busca'));
    const person = el('div','appointment-person'); person.append(el('span','person-dot',item.professional.slice(0,1).toUpperCase()),el('span','',item.professional));
    const side = el('div','appointment-row-side'); side.append(badge(item),button(compact ? 'Ver ↗' : 'Ver detalhes ↗','text-button',()=>details(item)));
    card.append(hour,customer,person,side); return card;
  }
  function render() {
    paintDate();
    const term = $('#agenda-search').value.trim().toLocaleLowerCase('pt-BR'), person = $('#agenda-professional').value, status = $('#agenda-status').value;
    const filtered = items.filter(a => (!person || (a.professionalId || a.professional) === person) && (!status || a.status === status || (status === 'in_progress' && activePetStatuses.includes(a.status) && a.status !== 'confirmed') || (status === 'cancelled' && a.status === 'canceled')) && (!term || `${a.customerName} ${a.petName || ''} ${a.phone} ${a.service}`.toLocaleLowerCase('pt-BR').includes(term)));
    $('#agenda-count').textContent = `${filtered.length} atendimento${filtered.length === 1 ? '' : 's'}${filtered.length !== items.length ? ` de ${items.length}` : ''}`;
    const container = $('#agenda-list');
    if (!filtered.length) empty(container,items.length ? 'Nenhum resultado por aqui' : 'Um espaço livre no seu dia',items.length ? 'Experimente outra busca ou ajuste os filtros.' : 'Os agendamentos feitos pelo WhatsApp aparecerão aqui. Escolha outra data para consultar sua agenda.');
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
        row.append(el('span','pet-step-marker',i<index?'✓':String(i+1)),copy);timeline.append(row);
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
    [['Pagamento',item.paymentStatus === 'paid' ? 'Sinal pago por Pix' : item.paymentStatus === 'pending' ? 'Aguardando pagamento do sinal' : item.paymentStatus === 'expired' ? 'Pix expirado' : 'No estabelecimento'],['Sinal',currency(item.deposit || 0)],['Pago',currency(item.paid || 0)],['Restante presencial',currency(item.balance ?? item.price)]].forEach(([name,value])=>{const field=el('div');field.append(el('dt','',name),el('dd','',value));dl.append(field);});
    if(item.paymentExpiresAt && item.status === 'awaiting_payment') {const field=el('div');field.append(el('dt','','Prazo do Pix'),el('dd','',new Date(item.paymentExpiresAt).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})));dl.append(field);}
    if(item.paymentStatus === 'paid') dl.append(el('p','payment-help',`Cancelamentos dentro do prazo solicitam o estorno automaticamente. Remarcações usadas: ${item.rescheduleCount || 0}.`));
    if(item.paymentStatus === 'refunded') dl.append(el('p','payment-help',`Sinal devolvido automaticamente: ${currency(item.refunded || item.paid)}.`));
    if(item.paymentStatus === 'retained') dl.append(el('p','payment-help',`Sinal mantido por cancelamento fora do prazo: ${currency(item.retained || item.paid)}.`));
    if(item.paymentStatus === 'refund_failed') dl.append(el('p','payment-help',`Estorno pendente de atenção: ${item.refundError || 'o sistema tentará novamente automaticamente.'}`));
    if(item.paymentStatus === 'refund_pending') dl.append(el('p','payment-help',`Estorno de ${currency(item.paid)} aguardando confirmação.`));
    if(item.paymentStatus === 'paid') {
      const cutoff = Number(item.changePolicy?.refundCutoffMinutes || 60);
      const deadline = new Date(new Date(`${item.date}T${item.time}:00-03:00`).getTime() - cutoff * 60000);
      const field=el('div');field.append(el('dt','','Prazo para estorno'),el('dd','',`${deadline.toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})} · ${cutoffLabel(cutoff)} antes`));dl.append(field);
    }
    if(item.refundProviderId) {const field=el('div');field.append(el('dt','','Comprovante do estorno'),el('dd','',item.refundProviderId));dl.append(field);}
    const actions=$('#appointment-actions');actions.replaceChildren();
    if(item.conversationId) actions.append(button('Abrir conversa ↗','secondary-action',async()=>{dialog.close();await openConversation(item);}));
    if(canManage && item.petName && activePetStatuses.includes(item.status)) {
      const next={confirmed:['pickup','both'].includes(item.transportId)?['Saiu para buscar','pet_pickup_started']:['Pet recebido','pet_received'],pet_pickup_started:['Confirmar coleta','pet_collected'],pet_collected:['Confirmar chegada ao pet shop','pet_received'],pet_received:['Iniciar atendimento','pet_in_service'],pet_in_service:[hasDelivery(item)?'Marcar como pronto para entrega':'Marcar pet como pronto','pet_ready'],pet_ready:hasDelivery(item)?['Saiu para entrega','pet_out_for_delivery']:['Concluir retirada','complete'],pet_out_for_delivery:['Confirmar entrega','complete']}[item.status];
      actions.append(button(next[0],'primary-action',()=>confirmAction(next[1],`${next[0]} para ${item.petName}?`)));
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
  function confirmAction(action,copy) { pendingAction=action;$('#appointment-confirm-copy').textContent=copy;$('#appointment-confirm').hidden=false;$('#appointment-confirm').scrollIntoView({block:'nearest',behavior:'smooth'}); }
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
      dialog.close();selected=null;await refresh();
      const petNotification=result.data.petNotification;
      $('#agenda-feedback').textContent=action==='retry_refund' ? 'Estorno confirmado.' : petNotification?.status==='failed' ? `Etapa atualizada, mas a mensagem não foi enviada: ${petNotification.error}` : result.data.reminderQueued===false ? 'Agendamento atualizado. O lembrete não pôde ser programado; confira os detalhes.' : petNotification?.status==='sent' ? 'Etapa atualizada e tutor avisado pelo WhatsApp.' : 'Agendamento atualizado com sucesso.';$('#agenda-feedback').hidden=false;
    }catch(error){$('#appointment-feedback').textContent=error.message;$('#appointment-feedback').hidden=false;}
    finally{controls.forEach(b=>b.disabled=false);}
  }
  function changeDate(value) { date=value;$('#agenda-date').value=date;paintDate();refresh(); }
  $('#agenda-date').addEventListener('change',event=>{if(event.target.value)changeDate(event.target.value);});
  $('#agenda-prev').addEventListener('click',()=>changeDate(new Date(localDate(date).getTime()-86400000).toISOString().slice(0,10)));
  $('#agenda-next').addEventListener('click',()=>changeDate(new Date(localDate(date).getTime()+86400000).toISOString().slice(0,10)));
  $('#agenda-today').addEventListener('click',()=>changeDate(today()));
  $('#agenda-refresh').addEventListener('click',refresh);
  ['#agenda-search','#agenda-professional','#agenda-status'].forEach(selector=>$(selector).addEventListener(selector.includes('search')?'input':'change',render));
  $('#appointment-close').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{slotRequest++;});
  $('#appointment-new-date').addEventListener('change',loadSlots);
  $('#appointment-reschedule').addEventListener('submit',event=>{event.preventDefault();if(!$('#appointment-new-time').disabled)confirmAction('reschedule','Confirmar a nova data e horário deste atendimento?');});
  $('#appointment-confirm-back').addEventListener('click',()=>{$('#appointment-confirm').hidden=true;pendingAction='';});
  $('#appointment-confirm-do').addEventListener('click',()=>{if(pendingAction)perform(pendingAction);});
  setInterval(()=>{if(!document.hidden && !dialog.open && organization() && !loading && ($('#view-overview').classList.contains('active') || $('#view-appointments').classList.contains('active'))) refresh();},60000);
  return { refresh };
}
