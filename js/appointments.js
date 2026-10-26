export function createAppointmentsUI({ list, slots, update, organization, openConversation }) {
  const $ = selector => document.querySelector(selector);
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const today = () => new Intl.DateTimeFormat('en-CA',{ timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date());
  const localDate = key => new Date(`${key}T12:00:00-03:00`);
  const currency = value => value == null ? 'Valor não informado' : new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(value);
  const labels = { confirmed:'Confirmado', completed:'Concluído', cancelled:'Cancelado', canceled:'Cancelado', no_show:'Não compareceu', pending:'Pendente', awaiting_payment:'Aguardando sinal', payment_expired:'Pagamento expirado', payment_review:'Revisar pagamento' };
  let date = today(), items = [], todayItems = [], selected = null, canManage = false, loading = false, request = 0, slotRequest = 0, pendingAction = '';
  const dialog = $('#appointment-dialog');
  $('#agenda-date').value = date;
  function button(text, cls, action) { const node = el('button',cls,text); node.type = 'button'; node.addEventListener('click',action); return node; }
  function badge(item) { return el('span',`appointment-badge ${item.status}`,labels[item.status] || item.status); }
  function empty(container, title, text) { const node = el('div','agenda-empty'); node.append(el('span','','▦'),el('strong','',title),el('p','',text)); container.replaceChildren(node); }
  function paintDate() {
    $('#agenda-date-title').textContent = new Intl.DateTimeFormat('pt-BR',{weekday:'long',day:'numeric',month:'long',timeZone:'America/Sao_Paulo'}).format(localDate(date));
    $('#agenda-day-tile').textContent = date.slice(8);
    $('#agenda-relative-day').textContent = date === today() ? 'HOJE, VAMOS COMEÇAR' : 'SUA AGENDA';
  }
  function row(item, compact = false) {
    const card = el('article',`appointment-row ${item.status}${compact ? ' compact' : ''}`);
    const hour = el('div','appointment-hour'); hour.append(el('strong','',item.time),el('small','',`${item.duration} min`));
    const customer = el('div','appointment-customer'); customer.append(el('strong','',item.customerName),el('span','',item.service + (item.optional ? ` + ${item.optional}` : '')));
    customer.append(el('small','appointment-payment-note',item.paymentStatus === 'paid' ? `Sinal pago · ${currency(item.paid)}` : item.paymentStatus === 'pending' ? `Sinal pendente · ${currency(item.deposit)}` : item.paymentStatus === 'expired' ? 'Pix expirado · horário liberado' : 'Pagamento no estabelecimento'));
    const person = el('div','appointment-person'); person.append(el('span','person-dot',item.professional.slice(0,1).toUpperCase()),el('span','',item.professional));
    const side = el('div','appointment-row-side'); side.append(badge(item),button(compact ? 'Ver ↗' : 'Ver detalhes ↗','text-button',()=>details(item)));
    card.append(hour,customer,person,side); return card;
  }
  function render() {
    paintDate();
    const term = $('#agenda-search').value.trim().toLocaleLowerCase('pt-BR'), person = $('#agenda-professional').value, status = $('#agenda-status').value;
    const filtered = items.filter(a => (!person || (a.professionalId || a.professional) === person) && (!status || a.status === status || (status === 'cancelled' && a.status === 'canceled')) && (!term || `${a.customerName} ${a.phone} ${a.service}`.toLocaleLowerCase('pt-BR').includes(term)));
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
    [['Serviço',item.service],['Adicionais',item.optional || 'Nenhum adicional'],['Profissional',item.professional],['Duração',`${item.duration} minutos`],['Valor',currency(item.price)],['WhatsApp',item.phone],['Lembrete',reminder]].forEach(([name,value])=>{const field=el('div');field.append(el('dt','',name),el('dd','',value));dl.append(field);});
    $('#appointment-detail').replaceChildren(header,dl);
    [['Pagamento',item.paymentStatus === 'paid' ? 'Sinal pago por Pix' : item.paymentStatus === 'pending' ? 'Aguardando pagamento do sinal' : item.paymentStatus === 'expired' ? 'Pix expirado' : 'No estabelecimento'],['Sinal',currency(item.deposit || 0)],['Pago',currency(item.paid || 0)],['Restante presencial',currency(item.balance ?? item.price)]].forEach(([name,value])=>{const field=el('div');field.append(el('dt','',name),el('dd','',value));dl.append(field);});
    if(item.paymentExpiresAt && item.status === 'awaiting_payment') {const field=el('div');field.append(el('dt','','Prazo do Pix'),el('dd','',new Date(item.paymentExpiresAt).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})));dl.append(field);}
    if(item.paymentStatus === 'paid') dl.append(el('p','payment-help','Cancelamentos não fazem estorno automático. Gerencie eventuais devoluções na conta Mercado Pago.'));
    const actions=$('#appointment-actions');actions.replaceChildren();
    if(item.conversationId) actions.append(button('Abrir conversa ↗','secondary-action',async()=>{dialog.close();await openConversation(item);}));
    if(canManage && item.status==='confirmed') {
      actions.append(button('✓ Concluir atendimento','primary-action',()=>confirmAction('complete','Marcar este atendimento como concluído?')));
      actions.append(button('Remarcar','secondary-action',()=>{ $('#appointment-reschedule').hidden=false;$('#appointment-new-date').value=item.date;loadSlots(); }));
      actions.append(button('Marcar falta','secondary-action',()=>confirmAction('no_show','Registrar que o cliente não compareceu?')));
      actions.append(button('Cancelar agendamento','danger-action',()=>confirmAction('cancel','Cancelar este agendamento e liberar o horário?')));
    }
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
      $('#agenda-feedback').textContent=result.data.reminderQueued===false ? 'Agendamento atualizado. O lembrete não pôde ser programado; confira os detalhes.' : 'Agendamento atualizado com sucesso.';$('#agenda-feedback').hidden=false;
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
