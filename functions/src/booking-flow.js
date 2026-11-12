const crypto = require('node:crypto');
const { decryptFlowRequest, encryptFlowResponse } = require('./flow-crypto');
const flowTemplate = require('./appointment-flow.json');
const { quote } = require('./payment-policy');
const { appointmentChangePolicy } = require('./payment-policy');
const { entitlements, monthKey, withAutomatedMessage, evaluateMonthlyConsumption } = require('./plan-limits');
const { customerId, normalizePhone } = require('./customers');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const minutes = value => /^\d{2}:\d{2}$/.test(String(value)) ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : NaN;
const money = value => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
const displayDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value).split('-').reverse().join('/') : /^\d{2}\/\d{2}\/\d{4}$/.test(String(value || '')) ? String(value) : 'Data não informada';
const cutoffLabel = minutes => Number(minutes) === 60 ? '1 hora' : Number(minutes) % 60 === 0 ? `${Number(minutes) / 60} horas` : `${Number(minutes)} minutos`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const bookable = p => p.active === true && p.allow_online_booking !== false && p.schedule_active !== false && !['paused', 'unavailable'].includes(p.status);
const overlaps = (a, b, c, d) => a < d && b > c;
const DEFAULT_BOOKING_KEYWORDS = ['agendar', 'agendamento', 'marcar horário'];
function normalizeBookingText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}
function bookingKeywordMatches(text, keywords) {
  const haystack = ` ${normalizeBookingText(text)} `;
  return keywords.some(keyword => {
    const needle = normalizeBookingText(keyword);
    return needle && haystack.includes(` ${needle} `);
  });
}
function validateBookingKeywords(value) {
  if (!Array.isArray(value) || value.length > 30) throw new Error('Cadastre até 30 palavras ou frases de agendamento.');
  const seen = new Set();
  return value.map(item => {
    if (typeof item !== 'string' || item.trim().length > 80 || !normalizeBookingText(item)) throw new Error('Cada palavra ou frase deve conter entre 1 e 80 caracteres.');
    return item.trim();
  }).filter(item => { const key = normalizeBookingText(item); if (seen.has(key)) return false; seen.add(key); return true; });
}
function publicError(message) { const error = new Error(message); error.publicMessage = message; return error; }

function availableSlots(person, date, duration, reservations = [], now = Date.now()) {
  const noon = new Date(`${date}T12:00:00-03:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(noon.getTime()) || noon.toISOString().slice(0, 10) !== date || !bookable(person) || !Number.isFinite(duration) || duration <= 0) return [];
  if (!(person.work_days || []).map(Number).includes(noon.getUTCDay())) return [];
  if (person.vacation?.active && date >= person.vacation.start && date <= person.vacation.end) return [];
  const start = minutes(person.work_start), end = minutes(person.work_end);
  const interval = Math.max(5, Number(person.interval_minutes) || 30);
  const candidates = Array.isArray(person.available_times) && person.available_times.length ? person.available_times : Array.from({ length: Math.max(0, Math.min(288, Math.ceil((end - start) / interval) || 0)) }, (_, i) => {
    const m = start + i * interval;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  });
  const blocks = [person.lunch, person.additional_break].filter(b => b?.active).map(b => ({ start: minutes(b.start), end: minutes(b.end) }));
  return [...new Set(candidates)].filter(time => {
    const m = minutes(time);
    return Number.isFinite(m) && m >= start && m + duration <= end && new Date(`${date}T${time}:00-03:00`).getTime() > now
      && ![...blocks, ...reservations].some(b => overlaps(m, m + duration, b.start, b.end));
  }).sort();
}

function buildDynamicFlow(config = {}) {
  const json = structuredClone(flowTemplate);
  if (config.title) json.screens[0].title = config.title.slice(0, 30);
  const errorScreen = { id: 'ERRO', title: 'Não foi possível continuar', terminal: true, data: { message: { type: 'string', __example__: 'Envie menu e tente novamente.' } }, layout: { type: 'SingleColumnLayout', children: [{ type: 'TextBody', text: '${data.message}' }, { type: 'Footer', label: 'Fechar', 'on-click-action': { name: 'complete', payload: { status: 'error' } } }] } };
  json.screens.push(errorScreen);
  json.routing_model.ERRO = [];
  for (const routes of Object.values(json.routing_model)) if (routes.length && !routes.includes('ERRO')) routes.push('ERRO');
  // Additional choices can be skipped when the catalog has none.
  json.routing_model.SERVICO.push('PROFISSIONAL');
  return json;
}

function flowField(type = 'string') { return type === 'array' ? { type: 'array', items: { type: 'string' }, __example__: [] } : { type: 'string', __example__: '' }; }
const ADDRESS_FIELDS = { postal_code: ['CEP', 9, true], street: ['Rua ou avenida', 120, true], number: ['Número (ou S/N)', 20, true], district: ['Bairro', 80, true], city: ['Cidade', 80, true], complement: ['Complemento', 100, false], reference: ['Ponto de referência', 150, false], instructions: ['Instruções da viagem', 300, false] };
function transportAddress(input) {
  const address = {};
  for (const [key, [label, max, required]] of Object.entries(ADDRESS_FIELDS)) {
    address[key] = String(input[key] || '').trim();
    if ((required && !address[key]) || address[key].length > max) throw publicError(`Confira o campo ${label}.`);
  }
  if (!/^\d{5}-?\d{3}$/.test(address.postal_code)) throw publicError('Informe um CEP com 8 dígitos.');
  address.line = `${address.street}, ${address.number} · ${address.district} · ${address.city} · CEP ${address.postal_code}${address.complement ? ` · ${address.complement}` : ''}`;
  return address;
}
function buildPetDynamicFlow(config = {}) {
  const json = buildDynamicFlow(config);
  const petFields = { pet_id: flowField(), pet_name: flowField(), pet_species: flowField(), pet_sex: flowField(), pet_size: flowField(), pet_breed: flowField() };
  const petScreen = { id: 'PET', title: 'Escolher pet', data: { pets: { type:'array', items:{ type:'object', properties:{ id:{type:'string'}, title:{type:'string'}, description:{type:'string'} } }, __example__:[{id:'new',title:'Cadastrar novo pet',description:'Adicionar os dados do animal'}] } }, layout:{ type:'SingleColumnLayout', children:[{ type:'Form', name:'pet_form', children:[{type:'Dropdown',name:'pet_id',label:'Pet',required:true,'data-source':'${data.pets}'},{type:'Footer',label:'Continuar','on-click-action':{name:'data_exchange',payload:{step:'pet',pet_id:'${form.pet_id}'}}}] }] } };
  const newPetScreen = { id:'PET_NOVO', title:'Cadastrar pet', data:{}, layout:{type:'SingleColumnLayout',children:[{type:'Form',name:'new_pet_form',children:[
    {type:'TextInput',name:'pet_name',label:'Nome do pet',required:true},
    {type:'Dropdown',name:'pet_species',label:'Espécie',required:true,'data-source':[{id:'dog',title:'Cachorro'},{id:'cat',title:'Gato'},{id:'other',title:'Outro'}]},
    {type:'Dropdown',name:'pet_sex',label:'Sexo',required:true,'data-source':[{id:'male',title:'Macho'},{id:'female',title:'Fêmea'},{id:'unknown',title:'Não informado'}]},
    {type:'Dropdown',name:'pet_size',label:'Porte',required:true,'data-source':[{id:'small',title:'Pequeno'},{id:'medium',title:'Médio'},{id:'large',title:'Grande'},{id:'giant',title:'Gigante'}]},
    {type:'TextInput',name:'pet_breed',label:'Raça',required:false,'helper-text':'Ex.: Shih-tzu'},
    {type:'Footer',label:'Ver serviços','on-click-action':{name:'data_exchange',payload:{step:'pet_new',pet_id:'new',pet_name:'${form.pet_name}',pet_species:'${form.pet_species}',pet_sex:'${form.pet_sex}',pet_size:'${form.pet_size}',pet_breed:'${form.pet_breed}'}}}
  ]}]}};
  const transportScreen = { id:'TRANSPORTE', title:'Busca e entrega', data:{...petFields,service_id:flowField(),extra_ids:flowField('array'),transports:{type:'array',items:{type:'object',properties:{id:{type:'string'},title:{type:'string'},description:{type:'string'}}},__example__:[{id:'none',title:'Levar e buscar no local',description:'Sem taxa de transporte'}]}},layout:{type:'SingleColumnLayout',children:[{type:'Form',name:'transport_form',children:[{type:'Dropdown',name:'transport_id',label:'Como será o transporte?',required:true,'data-source':'${data.transports}'},{type:'Footer',label:'Continuar','on-click-action':{name:'data_exchange',payload:{step:'transport',pet_id:'${data.pet_id}',pet_name:'${data.pet_name}',pet_species:'${data.pet_species}',pet_sex:'${data.pet_sex}',pet_size:'${data.pet_size}',pet_breed:'${data.pet_breed}',service_id:'${data.service_id}',extra_ids:'${data.extra_ids}',transport_id:'${form.transport_id}'}}}] }]}};
  json.screens.unshift(petScreen, newPetScreen);
  const professionalIndex = json.screens.findIndex(screen => screen.id === 'PROFISSIONAL');
  json.screens.splice(professionalIndex, 0, transportScreen);
  const addressFields = Object.fromEntries(Object.keys(ADDRESS_FIELDS).map(key => [key, flowField()]));
  json.screens.splice(professionalIndex + 1, 0, { id: 'ENDERECO', title: 'Endereço do transporte', data: { ...petFields, service_id: flowField(), extra_ids: flowField('array'), transport_id: flowField(), ...addressFields }, layout: { type: 'SingleColumnLayout', children: [{ type: 'TextBody', text: 'Informe onde devemos buscar ou entregar seu pet. Se já houver um endereço salvo, confira e atualize se necessário. Para buscar e entregar, usaremos este mesmo endereço.' }, { type: 'Form', name: 'address_form', 'init-values': Object.fromEntries(Object.keys(ADDRESS_FIELDS).map(key => [key, `\${data.${key}}`])), children: [...Object.entries(ADDRESS_FIELDS).map(([key, [label, max, required]]) => ({ type: 'TextInput', name: key, label, required, 'max-chars': max })), { type: 'Footer', label: 'Continuar', 'on-click-action': { name: 'data_exchange', payload: { step: 'address', service_id: '${data.service_id}', extra_ids: '${data.extra_ids}', ...Object.fromEntries(Object.keys(ADDRESS_FIELDS).map(key => [key, `\${form.${key}}`])) } } }] }] } });
  json.routing_model = { PET:['PET_NOVO','SERVICO','ERRO'], PET_NOVO:['SERVICO','ERRO'], ...json.routing_model, TRANSPORTE:['PROFISSIONAL','ERRO'] };
  json.routing_model.SERVICO = ['ADICIONAIS','TRANSPORTE','ERRO'];
  json.routing_model.ADICIONAIS = ['TRANSPORTE','ERRO'];
  json.routing_model.TRANSPORTE = ['ENDERECO', 'PROFISSIONAL', 'ERRO'];
  json.routing_model.ENDERECO = ['PROFISSIONAL', 'ERRO'];
  for (const screen of json.screens) {
    if (['PET','PET_NOVO','PET_RACA','ERRO'].includes(screen.id)) continue;
    screen.data = { ...petFields, ...(screen.data || {}) };
    if (!['SERVICO','ADICIONAIS','TRANSPORTE'].includes(screen.id)) screen.data.transport_id = flowField();
    const footer = JSON.stringify(screen.layout);
    if (!footer.includes('data_exchange')) continue;
    const visit = value => { if (!value || typeof value !== 'object') return; if (value.payload?.step) { for (const key of Object.keys(petFields)) value.payload[key] ??= `\${data.${key}}`; if (!['service','extras'].includes(value.payload.step)) value.payload.transport_id ??= '${data.transport_id}'; } for (const child of Object.values(value)) visit(child); };
    visit(screen.layout);
  }
  return json;
}

function createBookingRuntime({ admin, db, axios, logger, taskQueue, saveOutbound, payments, HttpsError }) {
  const root = org => db.doc(`organizations/${org}`);
  const response = (screen, data) => ({ version: '3.0', screen, data });
  const countedSend = ({ organizationId, reference, send }) => HttpsError
    ? withAutomatedMessage({ db, admin, organizationId, HttpsError, reference, send })
    : send();
  async function catalog(org) {
    const { catalogMatchesSegment } = require('./catalog-segment');
    const segmentName = (await root(org).get()).data()?.segmento || '';
    const entries = await Promise.all(['services', 'service_options', 'professionals'].map(async name => {
      const snap = await root(org).collection(name).where('active', '==', true).get();
      return [name, snap.docs.map(d => ({ ...d.data(), id: d.id })).filter(item => name === 'professionals' || catalogMatchesSegment(item, segmentName)).sort((a,b) => a.name.localeCompare(b.name, 'pt-BR'))];
    }));
    return Object.fromEntries(entries);
  }
  const option = item => ({ id: item.id, title: item.name.slice(0, 30), description: `${item.duration_minutes || 0} min · ${money(item.price || 0)}` });
  const petMetrics = (service, size) => service.charge_by_size !== false && service.pet_pricing?.[size] || { price: service.price, duration_minutes: service.duration_minutes };
  const optionForPet = (service, size) => { const values = petMetrics(service, size); return { id:service.id, title:service.name.slice(0,30), description:`${values.duration_minutes || 0} min · ${money(values.price || 0)}` }; };
  async function selection(org, input, requireProfessional = false) {
    const c = await catalog(org);
    const service = c.services.find(s => s.id === input.service_id);
    if (!service) throw publicError('Este serviço não está mais disponível. Envie menu e tente novamente.');
    const extraIds = Array.isArray(input.extra_ids) ? [...new Set(input.extra_ids)] : [];
    const extras = extraIds.map(id => c.service_options.find(e => e.id === id && (!e.service_ids?.length || e.service_ids.includes(service.id))));
    if (extras.some(e => !e)) throw publicError('Um adicional não está disponível para este serviço.');
    const people = c.professionals.filter(p => bookable(p) && p.service_ids?.includes(service.id));
    const professional = people.find(p => p.id === input.professional_id);
    if (requireProfessional && !professional) throw publicError('O profissional não está disponível para este serviço.');
    const petSize = String(input.pet_size || '');
    if (petSize && !['small','medium','large','giant'].includes(petSize)) throw publicError('O porte do pet é inválido. Envie menu e tente novamente.');
    if (petSize && !['male','female','unknown'].includes(String(input.pet_sex || 'unknown'))) throw publicError('O sexo do pet é inválido. Envie menu e tente novamente.');
    const base = petSize ? petMetrics(service, petSize) : service;
    const transportSettings = petSize ? (await root(org).collection('pet_shop').doc('settings').get()).data() || {} : {};
    const transportId = petSize ? String(input.transport_id || '') : '';
    const transports = {
      none: { price:0, duration:0, label:'Levar e buscar no local' },
      pickup: { price:Number(transportSettings.pickup_fee || 0), duration:Number(transportSettings.transport_minutes || 0), label:'Buscar o pet' },
      delivery: { price:Number(transportSettings.delivery_fee || 0), duration:Number(transportSettings.transport_minutes || 0), label:'Entregar o pet' },
      both: { price:Number(transportSettings.pickup_fee || 0) + Number(transportSettings.delivery_fee || 0), duration:Number(transportSettings.transport_minutes || 0) * 2, label:'Buscar e entregar' },
    };
    const transportAllowed = !transportId || transportId === 'none'
      || (transportId === 'pickup' && transportSettings.pickup_enabled === true)
      || (transportId === 'delivery' && transportSettings.delivery_enabled === true)
      || (transportId === 'both' && transportSettings.pickup_enabled === true && transportSettings.delivery_enabled === true);
    if (!transports[transportId || 'none'] || !transportAllowed) throw publicError('Opção de transporte inválida.');
    const transport = transports[transportId] || transports.none;
    const duration = Number(base.duration_minutes) + extras.reduce((n,e) => n + Number(e.duration_minutes || 0), 0) + transport.duration;
    const price = Number(base.price || 0) + extras.reduce((n,e) => n + Number(e.price || 0), 0) + transport.price;
    const petIds = petSize ? {pet_id:String(input.pet_id||''),pet_name:String(input.pet_name||''),pet_species:String(input.pet_species||''),pet_sex:String(input.pet_sex||'unknown'),pet_size:petSize,pet_breed:String(input.pet_breed||''),...(transportId?{transport_id:transportId}:{})} : {};
    return { service, extras, professional, people, duration, price, transport, ids: { ...petIds, service_id: service.id, extra_ids: extraIds, ...(professional ? { professional_id: professional.id } : {}) } };
  }
  async function reservations(org, person, date, reader = db, excludeId = '') {
    const dates = [...new Set([date, date.split('-').reverse().join('/')])];
    const snapshots = await Promise.all(dates.map(value => {
      const query = root(org).collection('appointments').where('appointment_date', '==', value);
      return reader === db ? query.get() : reader.get(query);
    }));
    return snapshots.flatMap(snap => snap.docs).filter(d => d.id !== excludeId).map(d => d.data()).filter(a => !['cancelled', 'canceled', 'rejected', 'payment_expired'].includes(a.status) && (a.professional_id === person.id || a.professional === person.name)).map(a => ({ start: minutes(a.appointment_time), end: minutes(a.appointment_time) + Number(a.duration_minutes || 30) }));
  }
  async function slots(org, s, date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || date < today() || date > new Date(Date.now() + 30 * 86400000).toISOString().slice(0,10)) return [];
    const result = availableSlots(s.professional, date, s.duration, await reservations(org, s.professional, date));
    const policy = payments ? await payments.policy(org) : { mode: 'onsite' };
    return policy.mode === 'deposit' ? result.filter(time => new Date(`${date}T${time}:00-03:00`).getTime() > Date.now() + policy.expiryMinutes * 60000) : result;
  }
  async function session(token) {
    if (!/^[a-f0-9-]{36}$/.test(String(token))) throw publicError('Sessão inválida. Envie menu novamente.');
    const snap = await db.doc(`whatsapp_flow_sessions/${token}`).get();
    const data = snap.data();
    if (!data || data.expires_at.toMillis() < Date.now()) throw publicError('Esta sessão expirou. Envie menu novamente.');
    const integration = (await root(data.organization_id).collection('integrations').doc('whatsapp').get()).data();
    if (!integration?.active) throw publicError('O estabelecimento está desconectado.');
    return { ...data, ref: snap.ref };
  }
  async function handle(payload) {
    if (payload.action === 'ping') return { version: '3.0', data: { status: 'active' } };
    const current = await session(payload.flow_token);
    const org = current.organization_id, input = payload.data || {};
    const organization = (await root(org).get()).data() || {};
    const petMode = String(organization.segmento || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().includes('pet shop');
    if (current.status === 'completed') {
      const appointment = (await root(org).collection('appointments').doc(current.appointment_id).get()).data();
      if (appointment) {
        if (appointment.status === 'confirmed') await finishConfirmed(org, current.appointment_id);
      }
      return response('SUCESSO', { draft_id: current.appointment_id, confirmation_message: appointment?.status === 'awaiting_payment' ? 'Sua reserva aguarda o pagamento do sinal. Confira o Pix nesta conversa.' : appointment?.status === 'confirmed' ? 'Seu agendamento já está confirmado.' : 'Consulte a situação da sua reserva na conversa com o estabelecimento.' });
    }
    if (input.error) return { version: '3.0', data: { acknowledged: true } };
    const step = payload.action === 'INIT' || payload.action === 'BACK' ? 'init' : input.step;
    if (step === 'init') {
      if (petMode) {
        const snap = await root(org).collection('pets').where('tutor_phone', '==', normalizePhone(current.phone, true)).get();
        const pets = snap.docs.filter(doc => doc.data().active !== false).map(doc => ({ id:doc.id, title:String(doc.data().name).slice(0,30), description:`${({dog:'Cachorro',cat:'Gato',other:'Outro'})[doc.data().species] || 'Pet'} · porte ${({small:'pequeno',medium:'médio',large:'grande',giant:'gigante'})[doc.data().size] || doc.data().size}`.slice(0,72) }));
        return response('PET', { pets:[...pets,{id:'new',title:'Cadastrar novo pet',description:'Adicionar os dados do animal'}] });
      }
      const c = await catalog(org);
      const services = c.services.filter(s => c.professionals.some(p => bookable(p) && p.service_ids?.includes(s.id)));
      if (!services.length) throw publicError('Não há serviços com profissionais disponíveis. Fale com o estabelecimento.');
      return response('SERVICO', { services: services.map(option) });
    }
    if (petMode && step === 'pet') {
      if (input.pet_id === 'new') return response('PET_NOVO', {});
      const pet = (await root(org).collection('pets').doc(String(input.pet_id || '')).get());
      if (!pet.exists || pet.data().active === false || pet.data().tutor_phone !== normalizePhone(current.phone, true)) throw publicError('Este pet não está disponível. Envie menu e tente novamente.');
      const data = pet.data();
      const c = await catalog(org); const services = c.services.filter(s => c.professionals.some(p => bookable(p) && p.service_ids?.includes(s.id)));
      return response('SERVICO', { pet_id:pet.id, pet_name:data.name, pet_species:data.species, pet_sex:data.sex || 'unknown', pet_size:data.size, pet_breed:data.breed || '', services:services.map(service => optionForPet(service,data.size)) });
    }
    if (petMode && step === 'pet_new') {
      const name=String(input.pet_name||'').trim(), species=String(input.pet_species||''), sex=String(input.pet_sex||'unknown'), size=String(input.pet_size||''), breed=String(input.pet_breed||'').trim();
      if(name.length<2||name.length>80||!['dog','cat','other'].includes(species)||!['male','female','unknown'].includes(sex)||!['small','medium','large','giant'].includes(size)||breed.length>80) throw publicError('Confira os dados do pet.');
      const c=await catalog(org); const services=c.services.filter(s=>c.professionals.some(p=>bookable(p)&&p.service_ids?.includes(s.id)));
      return response('SERVICO',{pet_id:'new',pet_name:name,pet_species:species,pet_sex:sex,pet_size:size,pet_breed:breed,services:services.map(service=>optionForPet(service,size))});
    }
    const s = await selection(org, input, !['service', 'extras', 'transport', 'address'].includes(step));
    if (step === 'service') {
      const c = await catalog(org);
      const extras = c.service_options.filter(e => !e.service_ids?.length || e.service_ids.includes(s.service.id));
      if (extras.length) return response('ADICIONAIS', { ...s.ids, extras: extras.map(option) });
    }
    if (step === 'service' || step === 'extras') {
      if (petMode) {
        const settings = (await root(org).collection('pet_shop').doc('settings').get()).data() || {};
        const transports = [{id:'none',title:'Eu levo e busco',description:'Você traz seu pet e busca depois. Sem taxa.'}];
        if (settings.pickup_enabled === true) transports.push({id:'pickup',title:'Buscar meu pet',description:`Nós buscamos; você busca depois. ${money(Number(settings.pickup_fee || 0))}`});
        if (settings.delivery_enabled === true) transports.push({id:'delivery',title:'Somente entregar',description:`Você traz; nós entregamos em casa. ${money(Number(settings.delivery_fee || 0))}`});
        if (settings.pickup_enabled === true && settings.delivery_enabled === true) transports.push({id:'both',title:'Buscar e entregar',description:`Nós buscamos seu pet e entregamos. ${money(Number(settings.pickup_fee || 0)+Number(settings.delivery_fee || 0))}`});
        return response('TRANSPORTE',{...s.ids,transports});
      }
      if (!s.people.length) throw publicError('Não há profissional disponível para esse serviço.');
      return response('PROFISSIONAL', { ...s.ids, professionals: s.people.map(p => ({ id: p.id, title: p.name.slice(0,30), description: (p.specialty || 'Disponível para agendamento').slice(0,300) })) });
    }
    if (step === 'transport') {
      const config = (await root(org).collection('flow_configs').doc(current.flow_id).get()).data();
      if (petMode && input.transport_id !== 'none' && config?.transport_address_schema_version === 1) {
        const contact = (await root(org).collection('customers').doc(customerId(normalizePhone(current.phone, true))).get()).data();
        const saved = current.transport_address_data || contact?.last_address || {};
        return response('ENDERECO', { ...s.ids, ...Object.fromEntries(Object.keys(ADDRESS_FIELDS).map(key => [key, String(saved[key] || '')])) });
      }
    }
    if (step === 'address') {
      if (!petMode || !['pickup', 'delivery', 'both'].includes(input.transport_id)) throw publicError('Selecione o transporte novamente.');
      await current.ref.set({ transport_address_data: transportAddress(input), transport_address_mode: input.transport_id }, { merge: true });
    }
    if (step === 'transport' || step === 'address') {
      if (!s.people.length) throw publicError('Não há profissional disponível para esse serviço.');
      return response('PROFISSIONAL',{...s.ids,professionals:s.people.map(p=>({id:p.id,title:p.name.slice(0,30),description:(p.specialty||'Disponível para agendamento').slice(0,300)}))});
    }
    if (step === 'professional') {
      const dates = [];
      const base = today();
      for (let i = 0; i < 30; i++) {
        const date = new Date(new Date(`${base}T12:00:00Z`).getTime() + i * 86400000).toISOString().slice(0,10);
        if (availableSlots(s.professional, date, s.duration).length) dates.push({ id: date, title: new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' }).format(new Date(`${date}T12:00:00Z`)), description: 'Consultar horários disponíveis' });
      }
      if (!dates.length) throw publicError('Sem datas disponíveis nos próximos 30 dias.');
      return response('DATA', { ...s.ids, dates });
    }
    const available = await slots(org, s, input.date);
    if (step === 'date') {
      if (!available.length) throw publicError('Não há horários livres nessa data. Envie menu e escolha outro dia.');
      return response('HORARIO', { ...s.ids, date: input.date, times: available.map(time => ({ id: time, title: time })) });
    }
    if (!available.includes(input.time)) throw publicError('Esse horário não está mais disponível. Envie menu e escolha outro horário.');
    const ids = { ...s.ids, date: input.date, time: input.time };
    if (step === 'time') return response('DADOS', { ...ids, profile_name: current.customer_name || 'Cliente', phone_summary: current.phone });
    const name = String(input.client_name || '').trim();
    if (name.length < 2 || name.length > 100) throw publicError('Informe um nome entre 2 e 100 caracteres.');
    const policy = payments ? await payments.policy(org) : { mode: 'onsite' };
    if (policy.mode === 'deposit' && (await root(org).collection('flow_configs').doc(current.flow_id).get()).data()?.payment_schema_version !== 2) throw publicError('Este convite foi atualizado. Envie menu para abrir o novo agendamento.');
    const amounts = quote(s.price, policy);
    const email = String(input.client_email || '').trim().toLowerCase();
    if (step === 'details' && policy.mode === 'deposit') return response('PAGAMENTO', { ...ids, client_name: name, payment_summary: `Sinal: ${money(amounts.depositCents / 100)}\nRestante no estabelecimento: ${money(amounts.remainingCents / 100)}\nPrazo para pagar: ${policy.expiryMinutes} minutos.\nO sinal é devolvido ao cancelar com pelo menos ${cutoffLabel(policy.refundCutoffMinutes)} de antecedência.` });
    if (policy.mode === 'deposit' && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)) throw publicError('Informe um e-mail válido para gerar o Pix.');
    if (step === 'details' || step === 'payment') {
      await current.ref.set({ reviewed_payment_policy: JSON.stringify(policy), reviewed_price: s.price }, { merge: true });
      return response('RESUMO', { ...ids, client_name: name, client_email: email, client_summary: `${name} · ${current.phone}`, service_summary: petMode ? `${s.service.name} · ${input.pet_name}` : s.service.name, extras_summary: [s.extras.map(e => e.name).join(', '), petMode ? s.transport.label : ''].filter(Boolean).join(' · ') || 'Nenhum adicional', professional_summary: s.professional.name, datetime_summary: `${displayDate(input.date)} às ${input.time}`, total_summary: `Total: ${money(s.price)}`, payment_summary: policy.mode === 'deposit' ? `Sinal por Pix: ${money(amounts.depositCents / 100)}\nRestante presencial: ${money(amounts.remainingCents / 100)}\nO horário só será confirmado após pagar. O Pix vence em ${policy.expiryMinutes} minutos.\nCancelando com pelo menos ${cutoffLabel(policy.refundCutoffMinutes)} de antecedência, o sinal será devolvido; depois desse prazo, será mantido.` : 'Pagamento no estabelecimento.', submit_label: policy.mode === 'deposit' ? 'Gerar Pix do sinal' : 'Confirmar agendamento' });
    }
    if (step !== 'confirm') throw publicError('Etapa inválida. Envie menu e tente novamente.');
    if (current.reviewed_payment_policy !== JSON.stringify(policy) || current.reviewed_price !== s.price) throw publicError('O valor ou a regra de pagamento mudou. Envie menu e revise o agendamento.');
    const appointmentId = hash(`booking:${payload.flow_token}`);
    const appointment = root(org).collection('appointments').doc(appointmentId);
    const customerPhone = normalizePhone(current.phone, true);
    const customer = root(org).collection('customers').doc(customerId(customerPhone));
    const flowConfig = petMode ? (await root(org).collection('flow_configs').doc(current.flow_id).get()).data() : null;
    const needsAddress = petMode && ['pickup', 'delivery', 'both'].includes(input.transport_id);
    if (needsAddress && flowConfig?.transport_address_schema_version === 1 && (!current.transport_address_data || current.transport_address_mode !== input.transport_id)) throw publicError('Informe o endereço de transporte antes de confirmar.');
    const address = needsAddress && current.transport_address_mode === input.transport_id ? transportAddress(current.transport_address_data) : null;
    const petRef = petMode ? (input.pet_id === 'new' ? root(org).collection('pets').doc(hash(`pet:${org}:${customerPhone}:${input.pet_name}`).slice(0,40)) : root(org).collection('pets').doc(String(input.pet_id || ''))) : null;
    const dayLock = root(org).collection('booking_days').doc(`${s.professional.id}_${input.date}`);
    const scheduledFor = admin.firestore.Timestamp.fromDate(new Date(`${input.date}T${input.time}:00-03:00`));
    const paymentData = { deposit_cents: amounts.depositCents, remaining_cents: amounts.remainingCents, customer_email: email };
    const intent = policy.mode === 'deposit' ? await payments.intent(org, appointmentId, paymentData, policy) : null;
    const access = await entitlements(db, org);
    if (access.organization.status === 'suspended') throw publicError('O estabelecimento está temporariamente indisponível.');
    const usageRef = root(org).collection('usage').doc(monthKey());
    const creditsRef = root(org).collection('capacity').doc('credits');
    await db.runTransaction(async tx => {
      const [previous, lock, freshSession, freshPerson, freshService, usage, credits, freshPet] = await Promise.all([tx.get(appointment), tx.get(dayLock), tx.get(current.ref), tx.get(root(org).collection('professionals').doc(s.professional.id)), tx.get(root(org).collection('services').doc(s.service.id)), tx.get(usageRef), tx.get(creditsRef), petRef ? tx.get(petRef) : Promise.resolve(null)]);
      if (previous.exists) return;
      const consumption = evaluateMonthlyConsumption({ usageData: usage.data(), creditsData: credits.data(), metric: 'appointments', limit: access.limits.appointmentsPerMonth, reference: appointmentId });
      if (!consumption.allowed) throw publicError(`O limite mensal de ${access.limits.appointmentsPerMonth} agendamentos do estabelecimento foi atingido.`);
      const freshPolicy = await tx.get(root(org).collection('payment_settings').doc('booking'));
      if (payments && JSON.stringify(require('./payment-policy').normalizePolicy(freshPolicy.data() || {})) !== JSON.stringify(policy)) throw publicError('A regra de pagamento mudou. Envie menu e revise novamente.');
      if (intent) {
        const seller = (await tx.get(root(org).collection('integrations').doc('mercadopago'))).data();
        if (!seller?.active || seller.seller_id !== intent.data.sellerId) throw publicError('O pagamento está temporariamente indisponível. Fale com o estabelecimento.');
      }
      if (freshSession.data()?.expires_at.toMillis() < Date.now()) throw publicError('Sessão expirada. Envie menu novamente.');
      if (freshPerson.data()?.updated_at?.toMillis() !== s.professional.updated_at?.toMillis() || freshService.data()?.updated_at?.toMillis() !== s.service.updated_at?.toMillis()) throw publicError('O cadastro foi atualizado. Envie menu e confira as opções novamente.');
      for (const e of s.extras) { const fresh = await tx.get(root(org).collection('service_options').doc(e.id)); if (fresh.data()?.updated_at?.toMillis() !== e.updated_at?.toMillis()) throw publicError('Um adicional foi atualizado. Envie menu novamente.'); }
      const busy = await reservations(org, s.professional, input.date, tx);
      const held = Object.values(lock.data()?.reservations || {});
      if (!availableSlots(freshPerson.data(), input.date, s.duration, [...busy, ...held]).includes(input.time)) throw publicError('Esse horário acabou de ser reservado. Envie menu e escolha outro horário.');
      const now = admin.firestore.FieldValue.serverTimestamp();
      if (petMode) {
        if (input.pet_id !== 'new' && (!freshPet?.exists || freshPet.data()?.tutor_phone !== customerPhone || freshPet.data()?.active === false)) throw publicError('O cadastro do pet mudou. Envie menu e tente novamente.');
        if (input.pet_id !== 'new') {
          const saved = freshPet.data();
          if (String(input.pet_name||'') !== String(saved.name||'') || String(input.pet_species||'') !== String(saved.species||'') || String(input.pet_sex||'unknown') !== String(saved.sex||'unknown') || String(input.pet_size||'') !== String(saved.size||'') || String(input.pet_breed||'') !== String(saved.breed||'')) throw publicError('O cadastro do pet mudou. Envie menu e revise os dados.');
        }
        if (input.pet_id === 'new' && (String(input.pet_name||'').trim().length < 2 || String(input.pet_name||'').trim().length > 80 || String(input.pet_breed||'').trim().length > 80 || !['dog','cat','other'].includes(String(input.pet_species||'')) || !['male','female','unknown'].includes(String(input.pet_sex||'unknown')) || !['small','medium','large','giant'].includes(String(input.pet_size||'')))) throw publicError('Confira os dados do pet e tente novamente.');
        if (input.pet_id === 'new' && !freshPet?.exists) tx.set(petRef,{name:String(input.pet_name).trim(),tutor_phone:customerPhone,species:input.pet_species,sex:input.pet_sex||'unknown',size:input.pet_size,breed:String(input.pet_breed||'').trim(),coat:'',birth_date:'',allergies:'',behavior:'',special_care:'',return_days:0,notes:'',active:true,created_at:now,updated_at:now,created_by:'customer_whatsapp',updated_by:'customer_whatsapp'});
      }
      tx.set(dayLock, { reservations: { [appointmentId]: { start: minutes(input.time), end: minutes(input.time) + s.duration } }, updated_at: now }, { merge: true });
      tx.set(appointment, { ...s.ids, ...(petMode?{pet_id:petRef.id,pet_name:input.pet_name,pet_species:input.pet_species,pet_sex:input.pet_sex||'unknown',pet_size:input.pet_size,pet_breed:input.pet_breed||'',transport:s.transport.label}:{}), ...paymentData, payment_status: intent ? 'pending' : 'onsite', paid_cents: 0, payment_expires_at: intent ? admin.firestore.Timestamp.fromMillis(intent.data.expiresAt) : null, change_policy:{refundCutoffMinutes:policy.refundCutoffMinutes||60,allowPaidReschedule:policy.allowPaidReschedule!==false,maxPaidReschedules:policy.maxPaidReschedules??1}, conversation_id: current.conversation_id, customer_phone: current.phone, customer_name: name, service: s.service.name, optional: s.extras.map(e => e.name).join(', '), professional: s.professional.name, appointment_date: input.date, appointment_time: input.time, duration_minutes: s.duration, total_price: s.price, scheduled_for: scheduledFor, status: intent ? 'awaiting_payment' : 'confirmed', flow_id: current.flow_id, created_at: now, updated_at: now });
      tx.set(customer, {
        ...(address ? { last_address: address } : {}),
        name,
        name_key: name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR'),
        phone: customerPhone,
        phone_key: customerPhone,
        ...(email ? { email } : {}),
        status: 'active',
        archived: false,
        last_activity_at: now,
        last_appointment_at: scheduledFor,
        last_appointment_id: appointmentId,
        last_appointment_summary: { service: s.service.name, professional: s.professional.name, appointment_date: input.date, appointment_time: input.time, status: intent ? 'awaiting_payment' : 'confirmed' },
        updated_at: now,
      }, { merge: true });
      if (address) tx.set(appointment, { transport_address: address.line, transport_reference: address.reference, transport_instructions: address.instructions, transport_address_data: address }, { merge: true });
      if (!consumption.duplicate) {
        tx.set(usageRef, { month: monthKey(), appointments: consumption.current + 1, appointments_references: { ...consumption.references, [appointmentId]: true }, ...(consumption.usesCredit ? { appointments_credits_used: admin.firestore.FieldValue.increment(1) } : {}), updated_at: now }, { merge: true });
        if (consumption.usesCredit) tx.set(creditsRef, { appointments: consumption.creditBalance - 1, updated_at: now }, { merge: true });
      }
      if (intent) tx.set(intent.ref, intent.data);
      tx.set(current.ref, { status: 'completed', appointment_id: appointmentId }, { merge: true });
    });
    if (intent) {
      try { await payments.processAttempt(intent.ref); }
      catch (e) { logger.warn('Pix será processado pela conciliação', { organizationId: org, appointmentId, status: e.response?.status || null }); }
    } else await finishConfirmed(org, appointmentId);
    return response('SUCESSO', { draft_id: appointmentId, confirmation_message: intent ? 'Sua reserva foi recebida! Vamos enviar o Pix nesta conversa. O agendamento será confirmado após o pagamento do sinal.' : 'Seu agendamento está confirmado! Os detalhes aparecerão nesta conversa.' });
  }
  async function finishConfirmed(org, appointmentId) {
    const data = (await root(org).collection('appointments').doc(appointmentId).get()).data();
    if (data?.status !== 'confirmed') return;
    await sendConfirmation(org, appointmentId);
    await queueReminder(org, appointmentId, data.scheduled_for, data.reminder_revision || 'initial');
  }
  async function sendConfirmation(org, appointmentId) {
    const ref = root(org).collection('appointments').doc(appointmentId);
    const data = (await ref.get()).data();
    if (!data || data.confirmation_sent || data.status !== 'confirmed') return;
    const confirmationConfig = (await root(org).collection('automation_configs').doc('appointment_reminder').get()).data() || {};
    const paidConfirmation = data.payment_status === 'paid';
    if (paidConfirmation ? confirmationConfig.payment_confirmation_active === false : confirmationConfig.appointment_confirmation_active === false) return;
    const credentials = (await root(org).collection('integrations').doc('whatsapp').get()).data();
    if (!credentials?.active) return;
    const payment = data.payment_status === 'paid' ? `Sinal pago: ${money(data.paid_cents / 100)}\nRestante no estabelecimento: ${money(data.remaining_cents / 100)}` : 'Pagamento no estabelecimento.';
    const policy = payments ? await payments.policy(org) : {};
    const cutoff = Number(policy.refundCutoffMinutes || 60);
    const body = `Agendamento confirmado!\n\n${data.service}${data.optional ? ` · ${data.optional}` : ''}\nProfissional: ${data.professional}\nData: ${displayDate(data.appointment_date)} às ${data.appointment_time}\nTotal: ${money(data.total_price)}\n${payment}${data.payment_status === 'paid' ? `\n\nO sinal é devolvido em cancelamentos com pelo menos ${cutoff === 60 ? '1 hora' : `${cutoff} minutos`} de antecedência.` : ''}`;
    const outbound = { messaging_product: 'whatsapp', to: data.customer_phone, type: 'interactive', interactive: { type: 'button', body: { text: body }, action: { buttons: [{ type:'reply', reply:{id:`appt_reschedule:${appointmentId}`,title:'Remarcar'} }, { type:'reply', reply:{id:`appt_cancel:${appointmentId}`,title:'Cancelar'} }] } } };
    const result = await countedSend({ organizationId: org, reference: `booking_confirmation_${appointmentId}`, send: async () => {
      const sent = await axios.post(`https://graph.facebook.com/${credentials.graph_version || 'v24.0'}/${credentials.phone_number_id}/messages`, outbound, { headers: { Authorization: `Bearer ${credentials.access_token}` }, timeout: 15000 });
      if (!sent.data?.messages?.[0]?.id) throw new Error('A Meta não confirmou o envio da confirmação.');
      return sent;
    } });
    const providerMessageId = result.data?.messages?.[0]?.id;
    if (!providerMessageId) throw new Error('A Meta não confirmou o envio da confirmação.');
    await saveOutbound({ admin, db, organizationId: org, conversationId: data.conversation_id, providerMessageId, type: 'interactive', text: body, createdBy: 'automation' });
    await ref.set({ confirmation_sent: true }, { merge: true });
  }
  async function queueReminder(org, appointmentId, scheduledFor, revision = 'initial') {
    const config = (await root(org).collection('automation_configs').doc('appointment_reminder').get()).data();
    if (!config?.active || !taskQueue) return;
    const schedules = config.trigger === 'before_appointment' ? (Array.isArray(config.schedules) && config.schedules.length ? config.schedules : [Number(config.lead_time_minutes) || 1440]) : [0];
    for (const lead of schedules) {
      const reminderKey = lead ? `before_${lead}` : 'after_confirmation';
      const delay = lead ? Math.max(0, Math.floor((scheduledFor.toMillis() - Date.now()) / 1000) - Number(lead) * 60) : Number(config.delay_seconds) || 30;
      try { await taskQueue.enqueue({ organizationId: org, appointmentId, revision, reminderKey }, { id: `booking-${appointmentId}-${String(revision).slice(0,36)}-${reminderKey}`, scheduleDelaySeconds: delay }); }
      catch (error) { if (![6, 'already-exists', 'functions/task-already-exists'].includes(error.code)) { logger.error('Falha ao agendar lembrete do Flow', { organizationId: org, appointmentId, reminderKey }); throw error; } }
    }
  }
  async function createSession({ organizationId, conversationId, flowId, phone, customerName }) {
    const token = crypto.randomUUID();
    await db.doc(`whatsapp_flow_sessions/${token}`).set({ organization_id: organizationId, conversation_id: conversationId, flow_id: flowId, phone, customer_name: customerName, status: 'sent', expires_at: admin.firestore.Timestamp.fromMillis(Date.now() + 30 * 60000), created_at: admin.firestore.FieldValue.serverTimestamp() });
    return token;
  }
  async function customerAppointment(org, id, phone) {
    if (!/^[a-f0-9]{64}$/.test(String(id || ''))) return null;
    const snapshot = await org.collection('appointments').doc(id).get();
    const data = snapshot.data();
    return data && String(data.customer_phone || '').replace(/\D/g,'') === String(phone || '').replace(/\D/g,'') ? {id:snapshot.id,ref:snapshot.ref,...data} : null;
  }
  const appointmentSummary = a => `${a.service || 'Atendimento'}\n${displayDate(a.appointment_date)} às ${a.appointment_time}\nProfissional: ${a.professional || 'a definir'}`;
  async function appointmentActions(org, appointment, policy) {
    const change = appointmentChangePolicy(appointment,policy);
    const buttons = [];
    if (change.canReschedule) buttons.push({type:'reply',reply:{id:`appt_reschedule:${appointment.id}`,title:'Remarcar'}});
    if (change.canCancel) buttons.push({type:'reply',reply:{id:`appt_cancel:${appointment.id}`,title:'Cancelar'}});
    if (!buttons.length) return {type:'text',text:{body:`${appointmentSummary(appointment)}\n\nEste agendamento não permite mais alterações automáticas.`}};
    return {type:'interactive',interactive:{type:'button',body:{text:appointmentSummary(appointment)},action:{buttons}}};
  }
  async function cancelCustomerAppointment(org, appointment, policy) {
    const change = appointmentChangePolicy(appointment,policy);
    if (!change.canCancel) throw publicError('O horário deste agendamento já começou.');
    await db.runTransaction(async tx => {
      const current = (await tx.get(appointment.ref)).data();
      if (!current || current.status !== 'confirmed') throw publicError('Este agendamento já foi alterado.');
      const freshChange = appointmentChangePolicy(current,policy);
      if (!freshChange.canCancel) throw publicError('O horário deste agendamento já começou.');
      const lockRef = org.collection('booking_days').doc(`${current.professional_id}_${current.appointment_date}`), lock = (await tx.get(lockRef)).data() || {};
      const reservations = {...(lock.reservations || {})}; delete reservations[appointment.id];
      const now = admin.firestore.FieldValue.serverTimestamp();
      tx.set(lockRef,{reservations,updated_at:now},{merge:true});
      tx.set(appointment.ref,{status:'cancelled',cancelled_at:now,cancelled_by:'customer',cancellation_reason:freshChange.retainsDeposit ? 'late_cancellation' : 'customer_request',...(freshChange.refundEligible ? {payment_status:'refund_pending',refund_status:'pending'} : freshChange.retainsDeposit ? {payment_status:'retained',refund_status:'not_eligible',deposit_retained_cents:Number(current.paid_cents || 0)} : {}),updated_at:now,updated_by:'customer_whatsapp'},{merge:true});
    });
    if (change.refundEligible && payments?.refundAppointment) {
      try { await payments.refundAppointment(org.id,appointment.id); return 'Agendamento cancelado. O estorno do sinal foi solicitado.'; }
      catch (error) { logger.warn('Estorno automático pendente',{organizationId:org.id,appointmentId:appointment.id,status:error.response?.status || null}); return 'Agendamento cancelado. A devolução do sinal está pendente e será acompanhada pelo estabelecimento.'; }
    }
    return change.retainsDeposit ? 'Agendamento cancelado. Como faltava menos que o prazo informado, o sinal foi mantido conforme a política aceita.' : 'Agendamento cancelado e horário liberado.';
  }
  async function rescheduleDates(org, appointment, policy) {
    const change = appointmentChangePolicy(appointment,policy);
    if (!change.canReschedule) throw publicError(change.paid ? 'O prazo ou o limite de remarcações com sinal terminou.' : 'Este agendamento não pode mais ser remarcado.');
    const personSnap = await org.collection('professionals').doc(appointment.professional_id).get(), person = {id:personSnap.id,...personSnap.data()};
    const rows=[];
    const base=today();
    for(let i=0;i<30&&rows.length<10;i++){
      const date=new Date(new Date(`${base}T12:00:00Z`).getTime()+i*86400000).toISOString().slice(0,10);
      const busy=await reservations(org.id,person,date,db,appointment.id);
      if(availableSlots(person,date,Number(appointment.duration_minutes)||30,busy).length) rows.push({id:`appt_date:${appointment.id}:${date}`,title:new Date(`${date}T12:00:00Z`).toLocaleDateString('pt-BR',{weekday:'short',day:'2-digit',month:'2-digit',timeZone:'UTC'}),description:'Ver horários disponíveis'});
    }
    if(!rows.length) throw publicError('Não há novas datas disponíveis nos próximos 30 dias.');
    return {type:'interactive',interactive:{type:'list',body:{text:'Escolha uma nova data. Seu horário atual permanece reservado até você selecionar o novo.'},action:{button:'Escolher data',sections:[{title:'Datas disponíveis',rows}]}}};
  }
  async function rescheduleTimes(org, appointment, date, policy) {
    if (!appointmentChangePolicy(appointment,policy).canReschedule) throw publicError('O prazo para remarcação terminou.');
    const personSnap=await org.collection('professionals').doc(appointment.professional_id).get(),person={id:personSnap.id,...personSnap.data()};
    const busy=await reservations(org.id,person,date,db,appointment.id);
    const times=availableSlots(person,date,Number(appointment.duration_minutes)||30,busy).slice(0,10);
    if(!times.length) throw publicError('Os horários desta data acabaram. Escolha outra data.');
    return {type:'interactive',interactive:{type:'list',body:{text:`Escolha o novo horário para ${date.split('-').reverse().join('/')}.`},action:{button:'Escolher horário',sections:[{title:'Horários disponíveis',rows:times.map(time=>({id:`appt_time:${appointment.id}:${date}:${time.replace(':','')}`,title:time}))}]}}};
  }
  async function applyCustomerReschedule(org, appointment, date, time, policy) {
    if (!appointmentChangePolicy(appointment,policy).canReschedule) throw publicError('O prazo para remarcação terminou.');
    await db.runTransaction(async tx=>{
      const current=(await tx.get(appointment.ref)).data();
      if(!current||current.status!=='confirmed'||!appointmentChangePolicy(current,policy).canReschedule) throw publicError('Este agendamento já foi alterado ou o prazo terminou.');
      const personRef=org.collection('professionals').doc(current.professional_id),personSnap=await tx.get(personRef),person={id:personSnap.id,...personSnap.data()};
      const oldLock=org.collection('booking_days').doc(`${person.id}_${current.appointment_date}`),newLock=org.collection('booking_days').doc(`${person.id}_${date}`);
      const oldSnap=await tx.get(oldLock),newSnap=newLock.path===oldLock.path?oldSnap:await tx.get(newLock);
      const oldReservations={...(oldSnap.data()?.reservations||{})},newReservations={...(newSnap.data()?.reservations||{})};delete oldReservations[appointment.id];delete newReservations[appointment.id];
      const busy=await reservations(org.id,person,date,tx,appointment.id),duration=Number(current.duration_minutes)||30;
      if(!availableSlots(person,date,duration,[...busy,...Object.values(newReservations)]).includes(time)) throw publicError('Esse horário acabou de ser reservado. Escolha outro.');
      newReservations[appointment.id]={start:minutes(time),end:minutes(time)+duration};
      const now=admin.firestore.FieldValue.serverTimestamp();
      if(newLock.path!==oldLock.path)tx.set(oldLock,{reservations:oldReservations,updated_at:now},{merge:true});
      tx.set(newLock,{reservations:newReservations,updated_at:now},{merge:true});
      tx.set(appointment.ref,{appointment_date:date,appointment_time:time,scheduled_for:admin.firestore.Timestamp.fromDate(new Date(`${date}T${time}:00-03:00`)),reschedule_count:Number(current.reschedule_count||0)+1,deposit_transferred:current.payment_status==='paid',rescheduled_at:now,rescheduled_by:'customer',reminder_revision:crypto.randomUUID(),reminder_status:'pending',confirmation_sent:false,updated_at:now,updated_by:'customer_whatsapp'},{merge:true});
    });
    await finishConfirmed(org.id,appointment.id);
    return `Agendamento remarcado para ${date.split('-').reverse().join('/')} às ${time}. O horário anterior foi liberado${appointment.payment_status==='paid'?' e o sinal foi transferido':''}.`;
  }
  async function automate({ organizationId, message, contact }) {
    if (message.type === 'interactive' && message.interactive?.nfm_reply) return;
    if (!['text', 'interactive'].includes(message.type)) return;
    const org = root(organizationId);
    const setting = (await org.collection('automation_configs').doc('booking_menu').get()).data();
    if (!setting?.active || !setting.flow_id) return;
    const phone = String(message.from), conversationId = hash(`contact:${phone}`);
    const conversation = org.collection('conversations').doc(conversationId);
    const text = normalizeBookingText(message.text?.body);
    const action = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id;
    const reset = ['menu', 'inicio', 'voltar'].includes(text);
    const state = (await conversation.get()).data() || {};
    if (reset) await conversation.set({ human_support: false, booking_confirmation_expires_at: null }, { merge: true });
    if (!reset && state.human_support) return;
    const credentials = (await org.collection('integrations').doc('whatsapp').get()).data();
    if (!credentials?.active) return;
    const config = (await org.collection('flow_configs').doc(setting.flow_id).get()).data();
    if (!config?.active || !config.dynamic || config.status !== 'PUBLISHED') return;
    const name = String((await org.get()).data()?.nome || 'estabelecimento');
    const pending = !reset && state.booking_confirmation_expires_at?.toMillis() > Date.now();
    const yes = pending && (action === 'booking_confirm_yes' || text === 'sim');
    const no = pending && (action === 'booking_confirm_no' || text === 'nao');
    const keywords = Array.isArray(setting.keywords) ? setting.keywords : DEFAULT_BOOKING_KEYWORDS;
    const menuButtons = [
      { type: 'reply', reply: { id: 'menu_book', title: 'Agendar horário' } },
      ...(setting.appointments_active === false ? [] : [{ type: 'reply', reply: { id: 'menu_appointments', title: 'Meus agendamentos' } }]),
      { type: 'reply', reply: { id: 'menu_support', title: 'Falar com atendente' } },
    ];
    let outbound;
    const actionParts=String(action||'').split(':'),appointmentAction=actionParts[0]?.startsWith('appt_');
    if (appointmentAction) {
      const appointment=await customerAppointment(org,actionParts[1],phone),policy=payments?await payments.policy(organizationId):{};
      if(!appointment||appointment.status!=='confirmed') outbound={type:'text',text:{body:'Este agendamento não está mais disponível para alteração.'}};
      else if(actionParts[0]==='appt_manage') outbound=await appointmentActions(org,appointment,policy);
      else if(actionParts[0]==='appt_cancel') {
        const change=appointmentChangePolicy(appointment,policy),paid=money(Number(appointment.paid_cents||0)/100);
        const copy=change.refundEligible?`Ao confirmar, o agendamento será cancelado e o sinal de ${paid} será devolvido.`:change.retainsDeposit?`Falta menos que o prazo de devolução. Ao cancelar, o sinal de ${paid} não será devolvido.`:'Deseja realmente cancelar este agendamento?';
        outbound={type:'interactive',interactive:{type:'button',body:{text:`${appointmentSummary(appointment)}\n\n${copy}`},action:{buttons:[{type:'reply',reply:{id:`appt_cancel_confirm:${appointment.id}`,title:'Sim, cancelar'}},{type:'reply',reply:{id:`appt_keep:${appointment.id}`,title:'Manter horário'}}]}}};
      } else if(actionParts[0]==='appt_cancel_confirm') outbound={type:'text',text:{body:await cancelCustomerAppointment(org,appointment,policy)}};
      else if(actionParts[0]==='appt_keep') outbound={type:'text',text:{body:'Tudo certo. Seu agendamento continua confirmado.'}};
      else if(actionParts[0]==='appt_reschedule') outbound=await rescheduleDates(org,appointment,policy);
      else if(actionParts[0]==='appt_date') outbound=await rescheduleTimes(org,appointment,actionParts[2],policy);
      else if(actionParts[0]==='appt_time') outbound={type:'text',text:{body:await applyCustomerReschedule(org,appointment,actionParts[2],`${actionParts[3].slice(0,2)}:${actionParts[3].slice(2)}`,policy)}};
    } else if (action === 'menu_book' || yes) {
      await conversation.set({ booking_confirmation_expires_at: null }, { merge: true });
      const token = await createSession({ organizationId, conversationId, flowId: setting.flow_id, phone, customerName: contact?.profile?.name || '' });
      const defaultMessage = config.type === 'pet_appointment'
        ? 'Olá, {{cliente_nome}}! Vamos agendar o cuidado do seu pet na {{empresa_nome}}? Escolha o pet, o serviço, o transporte e o melhor horário.'
        : 'Olá, {{cliente_nome}}! Escolha o serviço e o melhor horário para agendar na {{empresa_nome}}.';
      const flowMessage = typeof config.message === 'string' && config.message.trim() && config.message !== 'undefined' ? config.message : defaultMessage;
      outbound = { type: 'interactive', interactive: { type: 'flow', body: { text: flowMessage.replaceAll('{{cliente_nome}}', contact?.profile?.name || 'cliente').replaceAll('{{empresa_nome}}', name) }, action: { name: 'flow', parameters: { flow_message_version: '3', flow_id: setting.flow_id, flow_token: token, flow_cta: config.cta || (config.type === 'pet_appointment' ? 'Agendar pet' : 'Agendar agora'), flow_action: 'data_exchange' } } } };
    } else if (action === 'menu_support') {
      await conversation.set({ human_support: true, booking_confirmation_expires_at: null }, { merge: true });
      outbound = { type: 'text', text: { body: 'Seu pedido foi encaminhado ao atendimento. Para voltar ao agendamento automático, envie menu.' } };
    } else if (action === 'menu_appointments' && setting.appointments_active === false) {
      outbound = { type: 'text', text: { body: 'A consulta automática de agendamentos está pausada. Envie menu para falar com a equipe.' } };
    } else if (action === 'menu_appointments') {
      const snap = await org.collection('appointments').where('customer_phone', '==', phone).get();
      const upcoming = snap.docs.map(d => ({id:d.id,...d.data()})).filter(a => a.status === 'confirmed' && a.scheduled_for?.toMillis() > Date.now()).sort((a,b) => a.scheduled_for.toMillis() - b.scheduled_for.toMillis()).slice(0,10);
      outbound = upcoming.length ? {type:'interactive',interactive:{type:'list',body:{text:'Escolha um agendamento para ver as opções disponíveis.'},action:{button:'Ver agendamentos',sections:[{title:'Próximos horários',rows:upcoming.map(a=>({id:`appt_manage:${a.id}`,title:String(a.service||'Atendimento').slice(0,24),description:`${displayDate(a.appointment_date)} às ${a.appointment_time}`.slice(0,72)}))}]}}} : {type:'text',text:{body:'Você não tem agendamentos futuros confirmados. Envie menu para agendar.'}};
    } else if (!reset && !no && !action && bookingKeywordMatches(text, keywords)) {
      await conversation.set({ booking_confirmation_expires_at: admin.firestore.Timestamp.fromMillis(Date.now() + 10 * 60000) }, { merge: true });
      outbound = { type: 'interactive', interactive: { type: 'button', body: { text: 'Você quer realizar um agendamento?' }, action: { buttons: [{ type: 'reply', reply: { id: 'booking_confirm_yes', title: 'Sim' } }, { type: 'reply', reply: { id: 'booking_confirm_no', title: 'Não' } }] } } };
    } else {
      await conversation.set({ booking_confirmation_expires_at: null }, { merge: true });
      outbound = { type: 'interactive', interactive: { type: 'button', body: { text: `Olá! Bem-vindo à ${name}. Como podemos ajudar?` }, action: { buttons: menuButtons } } };
    }
    const automaticReference = `booking_auto_${hash(String(message.id || `${conversationId}:${JSON.stringify(message)}`))}`;
    const result = await countedSend({ organizationId, reference: automaticReference, send: async () => {
      const sent = await axios.post(`https://graph.facebook.com/${credentials.graph_version || 'v24.0'}/${credentials.phone_number_id}/messages`, { messaging_product: 'whatsapp', to: phone, ...outbound }, { headers: { Authorization: `Bearer ${credentials.access_token}` }, timeout: 15000 });
      if (!sent.data?.messages?.[0]?.id) throw new Error('A Meta não confirmou o envio automático.');
      return sent;
    } });
    const id = result.data?.messages?.[0]?.id;
    if (id) await saveOutbound({ admin, db, organizationId, conversationId, providerMessageId: id, type: outbound.type === 'text' ? 'text' : 'interactive', text: outbound.text?.body || outbound.interactive.body.text, createdBy: 'automation' });
  }
  return { handle, automate, createSession, finishConfirmed };
}

function createFlowEndpoint({ onRequest, privateKey, appSecret, runtime, logger, paymentSecrets = [] }) {
  return onRequest({ region: 'southamerica-east1', invoker: 'public', timeoutSeconds: 120, secrets: [privateKey, appSecret, ...paymentSecrets] }, async (req, res) => {
    if (req.method !== 'POST') return res.sendStatus(405);
    const expected = crypto.createHmac('sha256', appSecret.value()).update(req.rawBody || Buffer.alloc(0)).digest('hex');
    const signature = String(req.get('x-hub-signature-256') || '').replace(/^sha256=/, '');
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return res.sendStatus(401);
    let decrypted;
    try { decrypted = decryptFlowRequest(req.body, privateKey.value().replace(/\\n/g, '\n')); }
    catch { return res.sendStatus(421); }
    try {
      const result = await runtime.handle(decrypted.payload);
      return res.type('text/plain').send(encryptFlowResponse(result, decrypted.aesKey, decrypted.initialVector));
    } catch (error) {
      logger.error('Falha no endpoint de agendamento', { message: error.publicMessage || 'Erro interno ao processar agendamento' });
      const result = { version: '3.0', screen: 'ERRO', data: { message: error.publicMessage || 'Não foi possível concluir agora. Envie menu para tentar novamente.' } };
      return res.type('text/plain').send(encryptFlowResponse(result, decrypted.aesKey, decrypted.initialVector));
    }
  });
}
module.exports = { createBookingRuntime, createFlowEndpoint, buildDynamicFlow, buildPetDynamicFlow, transportAddress, availableSlots, DEFAULT_BOOKING_KEYWORDS, validateBookingKeywords, bookingKeywordMatches, displayDate };
