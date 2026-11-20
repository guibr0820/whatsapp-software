const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { availableSlots, buildDynamicFlow, buildPetDynamicFlow, createBookingRuntime, bookingKeywordMatches, validateBookingKeywords, displayDate } = require('../src/booking-flow');
const { decryptFlowRequest, encryptFlowResponse, normalizeFlowPrivateKey } = require('../src/flow-crypto');
const person = { active: true, service_ids: ['s1'], work_days: [1], work_start: '09:00', work_end: '12:00', interval_minutes: 30, lunch: { active: true, start: '10:00', end: '10:30' } };

test('endereço do transporte valida campos e gera cópia legível para o agendamento', () => {
  const { transportAddress } = require('../src/booking-flow');
  const input = { postal_code: '01001-000', street: ' Rua A ', number: 'S/N', district: 'Centro', city: 'São Paulo' };
  const address = transportAddress(input);
  assert.equal(address.street, 'Rua A');
  assert.match(address.line, /Rua A, S\/N · Centro · São Paulo/);
  assert.throws(() => transportAddress({ ...input, postal_code: '123' }), /CEP/);
  assert.throws(() => transportAddress({ ...input, street: '' }), /Rua/);
  assert.throws(() => transportAddress({ ...input, instructions: 'x'.repeat(301) }), /Instruções/);
  const flow = buildPetDynamicFlow();
  assert.ok(flow.routing_model.TRANSPORTE.includes('ENDERECO'));
  assert.ok(flow.routing_model.TRANSPORTE.includes('PROFISSIONAL'));
  const screen = flow.screens.find(s => s.id === 'ENDERECO');
  assert.equal(screen.layout.children[1]['init-values'].street, '${data.street}');
  assert.equal(screen.layout.children[1].children.at(-1)['on-click-action'].payload.transport_id, '${data.transport_id}');
});

test('Flow de visita inclui endereço no resumo antes da confirmação', () => {
  const flow = buildDynamicFlow({homeVisit:true});
  const summary = flow.screens.find(screen => screen.id === 'RESUMO');
  assert.ok(summary.data.address_summary);
  assert.ok(summary.layout.children.some(child => child.text === '${data.address_summary}'));
  assert.equal(buildDynamicFlow().screens.find(screen => screen.id === 'RESUMO').data.address_summary, undefined);
});

test('primeiro horário livre respeita reservas e serviço vinculado', async () => {
  const stamp = value => ({toMillis:()=>value});
  const now = new Date();
  const base = new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const date = new Date(new Date(`${base}T12:00:00Z`).getTime()+86400000).toISOString().slice(0,10);
  const data = new Map([
    ['organizations/company',{segmento:'Serviços profissionais'}],
    ['organizations/company/services/s1',{name:'Eletricista',active:true,segment_name:'Serviços profissionais',duration_minutes:30,price:0}],
    ['organizations/company/professionals/p1',{name:'Profissional',active:true,service_ids:['s1'],work_days:[0,1,2,3,4,5,6],work_start:'09:00',work_end:'10:00',interval_minutes:30}],
    [`organizations/company/appointments/a1`,{appointment_date:date,appointment_time:'09:00',duration_minutes:30,professional_id:'p1',status:'confirmed'}],
  ]);
  // Force all other days unavailable so the expected next slot is deterministic.
  data.get('organizations/company/professionals/p1').vacation = {active:true,start:base,end:base};
  const snap=path=>({id:path.split('/').at(-1),data:()=>data.get(path)});
  const collection=path=>({where:(field,_op,value)=>({get:async()=>({docs:[...data.keys()].filter(key=>key.startsWith(`${path}/`) && key.split('/').length===path.split('/').length+1 && data.get(key)[field]===value).map(snap)})})});
  const db={doc:path=>({get:async()=>snap(path),collection:name=>collection(`${path}/${name}`)})};
  const runtime=createBookingRuntime({db,admin:{firestore:{Timestamp:{fromMillis:stamp}}},axios:{},logger:{},saveOutbound:async()=>{}});
  assert.deepEqual(await runtime.firstAvailableVisit('company','s1'),{service_id:'s1',professional_id:'p1',extra_ids:[],date,time:'09:30'});
  assert.equal(await runtime.firstAvailableVisit('company','unknown'),null);
  data.get('organizations/company/services/s1').price = 50;
  assert.equal(await runtime.firstAvailableVisit('company','s1'),null);
});

test('palavras-chave reconhecem frases no texto, acentos e limites de palavras', () => {
  assert.equal(bookingKeywordMatches('Olá, QUERO marcar HORÁRIO amanhã!', ['marcar horário']), true);
  assert.equal(bookingKeywordMatches('Gostaria de fazer um agendamento.', ['agendamento']), true);
  assert.equal(bookingKeywordMatches('Preciso desagendar.', ['agendar']), false);
  assert.equal(bookingKeywordMatches('Oi', []), false);
  assert.deepEqual(validateBookingKeywords([' Agendar ', 'AGENDAR', 'marcar horário']), ['Agendar', 'marcar horário']);
  assert.throws(() => validateBookingKeywords(['!']), /entre 1 e 80/);
  assert.throws(() => validateBookingKeywords(Array(31).fill('agendar')), /até 30/);
});

test('datas dos agendamentos são exibidas no padrão brasileiro', () => {
  assert.equal(displayDate('2026-11-03'), '03/11/2026');
  assert.equal(displayDate('03/11/2026'), '03/11/2026');
});

test('menu, confirmação Sim/Não, resposta expirada e pausa humana', async () => {
  const records = new Map([
    ['organizations/company', { nome: 'Studio' }],
    ['organizations/company/automation_configs/booking_menu', { active: true, flow_id: '12345', keywords: ['agendar', 'marcar horário'] }],
    ['organizations/company/integrations/whatsapp', { active: true, access_token: 'token', phone_number_id: '54321' }],
    ['organizations/company/flow_configs/12345', { active: true, dynamic: true, status: 'PUBLISHED', message: 'Olá {{cliente_nome}}', cta: 'Agendar agora' }],
  ]);
  const ref = path => ({ collection: name => ({ doc: id => ref(`${path}/${name}/${id}`) }), get: async () => ({ data: () => records.get(path) }), set: async (data, options) => records.set(path, options?.merge ? { ...records.get(path), ...data } : data) });
  const sent = [];
  const stamp = value => ({ toMillis: () => value });
  const runtime = createBookingRuntime({ db: { doc: ref }, admin: { firestore: { Timestamp: { fromMillis: stamp }, FieldValue: { serverTimestamp: () => stamp(Date.now()) } } }, axios: { post: async (url, body) => { sent.push(body); return { data: { messages: [{ id: `m${sent.length}` }] } }; } }, saveOutbound: async () => {} });
  const send = message => runtime.automate({ organizationId: 'company', contact: { profile: { name: 'Cliente' } }, message: { from: '5511999999999', ...message } });
  const text = body => send({ type: 'text', text: { body } });
  const button = id => send({ type: 'interactive', interactive: { button_reply: { id } } });
  await text('Bom dia');
  assert.equal(sent.at(-1).interactive.action.buttons.length, 3);
  await text('Quero AGENDAR para amanhã');
  assert.equal(sent.at(-1).interactive.body.text, 'Você quer realizar um agendamento?');
  assert.deepEqual(sent.at(-1).interactive.action.buttons.map(b => b.reply.title), ['Sim', 'Não']);
  await button('booking_confirm_no');
  assert.equal(sent.at(-1).interactive.action.buttons.length, 3);
  await text('Quero marcar horário');
  await button('booking_confirm_yes');
  assert.equal(sent.at(-1).interactive.type, 'flow');
  await button('booking_confirm_yes');
  assert.equal(sent.at(-1).interactive.type, 'button');
  await button('menu_support');
  const count = sent.length;
  await text('Quero agendar');
  assert.equal(sent.length, count);
  await text('menu');
  assert.equal(sent.at(-1).interactive.action.buttons.length, 3);
});

test('horários respeitam duração completa, adicionais, pausas e reservas sobrepostas', () => {
  assert.deepEqual(availableSlots(person, '2026-10-26', 60, [{ start: 660, end: 690 }], 0), ['09:00']);
  assert.deepEqual(availableSlots({ ...person, vacation: { active: true, start: '2026-10-26', end: '2026-10-27' } }, '2026-10-26', 30, [], 0), []);
  assert.deepEqual(availableSlots(person, '2026-10-27', 30, [], 0), []);
});

test('JSON usa profissional genérico, etapas dinâmicas e rotas válidas', () => {
  const json = buildDynamicFlow({ title: 'Escolher atendimento' });
  assert.ok(json.screens.some(s => s.id === 'PROFISSIONAL'));
  assert.ok(!JSON.stringify(json).includes('barber'));
  assert.ok(json.routing_model.SERVICO.includes('PROFISSIONAL'));
  assert.deepEqual(json.routing_model.SUCESSO, []);
  const names = new Set(json.screens.map(s => s.id));
  Object.values(json.routing_model).flat().forEach(name => assert.ok(names.has(name)));
});

test('Flow de pet shop mantém pet, porte e transporte até a confirmação', () => {
  const json = buildPetDynamicFlow({ title: 'Agendar banho e tosa' });
  const ids = json.screens.map(screen => screen.id);
  assert.equal(ids[0], 'PET');
  assert.ok(ids.includes('PET_NOVO'));
  assert.ok(ids.includes('TRANSPORTE'));
  assert.deepEqual(json.routing_model.ADICIONAIS.slice(0, 1), ['TRANSPORTE']);
  for (const screen of json.screens.filter(screen => ['PROFISSIONAL','DATA','HORARIO','DADOS','PAGAMENTO','RESUMO'].includes(screen.id))) {
    assert.ok(screen.data.pet_id);
    assert.ok(screen.data.pet_sex);
    assert.ok(screen.data.pet_size);
    assert.ok(screen.data.transport_id);
  }
  const serialized = JSON.stringify(json.screens.find(screen => screen.id === 'RESUMO'));
  assert.match(serialized, /\$\{data\.pet_id\}/);
  assert.match(serialized, /\$\{data\.pet_sex\}/);
  assert.match(serialized, /\$\{data\.transport_id\}/);
});

test('Flow de visita exige endereço entre horário e dados do cliente', () => {
  const flow = buildDynamicFlow({homeVisit:true});
  assert.ok(flow.screens.some(screen => screen.id === 'VISITA_ENDERECO'));
  assert.ok(flow.routing_model.HORARIO.includes('VISITA_ENDERECO'));
  assert.ok(flow.routing_model.VISITA_ENDERECO.includes('DADOS'));
  const screen = flow.screens.find(item => item.id === 'VISITA_ENDERECO');
  const payload = screen.layout.children[0].children.at(-1)['on-click-action'].payload;
  assert.equal(payload.postal_code, '${form.postal_code}');
  assert.equal(payload.problem_description, '${form.problem_description}');
});

test('criptografia RSA-OAEP e AES-GCM corresponde ao protocolo do Flow', () => {
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const aes = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const payload = { action: 'ping', version: '3.0' };
  const cipher = crypto.createCipheriv('aes-128-gcm', aes, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final(), cipher.getAuthTag()]);
  const request = { encrypted_aes_key: crypto.publicEncrypt({ key: keys.publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, aes).toString('base64'), encrypted_flow_data: encrypted.toString('base64'), initial_vector: iv.toString('base64') };
  const result = decryptFlowRequest(request, keys.privateKey);
  assert.deepEqual(result.payload, payload);
  const output = Buffer.from(encryptFlowResponse({ data: { status: 'active' } }, result.aesKey, result.initialVector), 'base64');
  const decipher = crypto.createDecipheriv('aes-128-gcm', aes, Buffer.from(iv.map(v => v ^ 255)));
  decipher.setAuthTag(output.subarray(-16));
  assert.deepEqual(JSON.parse(Buffer.concat([decipher.update(output.subarray(0, -16)), decipher.final()]).toString()), { data: { status: 'active' } });
});

test('sessão expirada é recusada antes de acessar os dados da empresa', async () => {
  const db = { doc: () => ({ get: async () => ({ data: () => ({ organization_id: 'org', expires_at: { toMillis: () => 0 } }) }) }) };
  const runtime = createBookingRuntime({ db });
  await assert.rejects(runtime.handle({ action: 'INIT', flow_token: '12345678-1234-1234-1234-123456789012' }), /expirou/);
});

test('saúde do endpoint não exige sessão', async () => {
  const runtime = createBookingRuntime({});
  assert.deepEqual(await runtime.handle({ action: 'ping' }), { version: '3.0', data: { status: 'active' } });
});

test('recusa token no lugar da chave PEM e aceita a chave RSA completa', () => {
  assert.throws(() => normalizeFlowPrivateKey('a'.repeat(64)), /chave privada RSA completa/);
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.equal(normalizeFlowPrivateKey(pem), pem.trim());
  assert.equal(normalizeFlowPrivateKey(pem.replaceAll('\n', '\\n')), pem.trim());
});

for (const mode of ['normal', 'pet', 'visit', 'execution']) test(`percorre o Flow ${mode}, rejeita conflito e não duplica`, async () => {
  const petMode = mode === 'pet', executionMode = mode === 'execution', visitMode = mode === 'visit' || executionMode;
  const data = new Map();
  const stamp = value => ({ toMillis: () => value });
  const updated = stamp(1);
  const ref = path => ({ path, collection: name => collection(`${path}/${name}`), get: async () => snapshot(path), set: async (value, options) => set(path, value, options) });
  const snapshot = path => ({ exists: data.has(path), id: path.split('/').at(-1), ref: ref(path), data: () => data.get(path) });
  const set = (path, value, options) => data.set(path, options?.merge ? { ...data.get(path), ...value } : value);
  const collection = path => ({ doc: id => ref(`${path}/${id}`), where: (field, op, value) => ({ get: async () => ({ docs: [...data.keys()].filter(key => key.startsWith(`${path}/`) && key.split('/').length === path.split('/').length + 1 && data.get(key)[field] === value).map(snapshot) }) }) });
  const db = { doc: ref, runTransaction: async work => work({ get: target => target.get(), set: (target, value, options) => set(target.path, value, options) }) };
  const org = 'organizations/company';
  data.set(org, { nome: 'Studio', status: 'trial', plano_id: 'profissional', plano_nome: 'Profissional' });
  data.set(`${org}/services/s1`, { name: 'Atendimento', active: true, duration_minutes: 60, price: 40, updated_at: updated });
  data.set(`${org}/professionals/p1`, { ...person, name: 'Especialista', work_days: [0,1,2,3,4,5,6], updated_at: updated });
  data.set(`${org}/integrations/whatsapp`, { active: true, access_token: 'segredo', phone_number_id: '12345' });
  if (petMode) {
    data.get(org).segmento = 'Pet shop e banho e tosa';
    data.get(`${org}/services/s1`).segment_name = 'Pet shop e banho e tosa';
    data.set(`${org}/pet_shop/settings`, { pickup_enabled: true, delivery_enabled: true });
    data.set(`${org}/flow_configs/12345`, { transport_address_schema_version: 1 });
  }
  if (visitMode) {
    data.get(org).segmento = 'Serviços profissionais';
    data.get(`${org}/services/s1`).segment_name = 'Serviços profissionais';
    data.get(`${org}/services/s1`).price = 0;
    data.set(`${org}/flow_configs/12345`, { visit_summary_schema_version: 1 });
  }
  const token1 = '12345678-1234-1234-1234-123456789012', token2 = '22345678-1234-1234-1234-123456789012';
  for (const token of [token1, token2]) data.set(`whatsapp_flow_sessions/${token}`, { organization_id: 'company', phone: '5511999999999', conversation_id: 'conversation', flow_id: '12345', expires_at: stamp(Date.now() + 600000), status: 'sent' });
  const admin = { firestore: { FieldValue: { serverTimestamp: () => updated }, Timestamp: { fromDate: date => stamp(date.getTime()) } } };
  const runtime = createBookingRuntime({ db, admin, axios: { post: async () => ({ data: { messages: [{ id: 'message-id' }] } }) }, saveOutbound: async () => {}, logger: { error() {} } });
  const send = (step, input = {}, token = token1) => runtime.handle({ flow_token: token, action: 'data_exchange', data: { step, ...input } });
  if (executionMode) { data.set(`${org}/conversations/conversation`,{quote_current:{id:'abc',status:'approved',service:'Conserto',totalCents:16000}});for(const token of [token1,token2])Object.assign(data.get(`whatsapp_flow_sessions/${token}`),{visit_service_id:'s1',execution_quote_id:'abc'}); }
  else if (visitMode) { data.get(`whatsapp_flow_sessions/${token1}`).proposed_visit = await runtime.firstAvailableVisit('company', 's1'); data.get(`whatsapp_flow_sessions/${token1}`).visit_service_id = 's1'; }
  const init = await runtime.handle({ action: 'INIT', flow_token: token1 });
  if (petMode) assert.equal(init.screen, 'PET');
  else if (visitMode && !executionMode) assert.equal(init.screen, 'VISITA_ENDERECO');
  else assert.equal(init.data.services[0].id, 's1');
  const petIds = petMode ? { pet_id: 'new', pet_name: 'Juli', pet_species: 'dog', pet_sex: 'female', pet_size: 'small', pet_breed: 'Shih-tzu' } : {};
  let professional = visitMode && !executionMode ? {screen:'PROFISSIONAL'} : await send('service', { service_id: 's1', ...petIds });
  const address = { postal_code: '01001-000', street: 'Rua Teste', number: '10', district: 'Centro', city: 'São Paulo', reference: 'Portão verde' };
  if (petMode) {
    assert.equal(professional.screen, 'TRANSPORTE');
    assert.equal((await send('transport', { service_id: 's1', ...petIds, transport_id: 'none' })).screen, 'PROFISSIONAL');
    assert.equal((await send('transport', { service_id: 's1', ...petIds, transport_id: 'both' })).screen, 'ENDERECO');
    professional = await send('address', { service_id: 's1', ...petIds, transport_id: 'both', ...address });
  }
  assert.equal(professional.screen, 'PROFISSIONAL');
  const ids = { service_id: 's1', extra_ids: [], professional_id: 'p1', ...petIds, ...(petMode ? { transport_id: 'both' } : {}) };
  const dates = await send('professional', ids);
  const date = visitMode && !executionMode ? data.get(`whatsapp_flow_sessions/${token1}`).proposed_visit.date : dates.data.dates.find(d => d.id > new Date().toISOString().slice(0,10)).id;
  const times = await send('date', { ...ids, date });
  const input = { ...ids, date, time: visitMode && !executionMode ? data.get(`whatsapp_flow_sessions/${token1}`).proposed_visit.time : times.data.times[0].id, client_name: 'Cliente Teste' };
  assert.equal((await send('time', input)).screen, visitMode ? 'VISITA_ENDERECO' : 'DADOS');
  if (visitMode && !executionMode) await assert.rejects(send('visit_address', {...input,date:'2099-01-01',...address,problem_description:'Trocar tomada da sala'}), /não corresponde/);
  if (visitMode) assert.equal((await send('visit_address', {...input,...address,problem_description:'Trocar tomada da sala'})).screen,'DADOS');
  const summary = await send('details', input);
  assert.equal(summary.screen, 'RESUMO');
  if (visitMode) assert.match(summary.data.address_summary, /Rua Teste/);
  if (executionMode) assert.match(summary.data.total_summary, /160,00/);
  assert.equal((await send('confirm', input)).screen, 'SUCESSO');
  if (executionMode) { const booking=[...data.entries()].find(([key])=>key.startsWith(`${org}/appointments/`))[1];assert.equal(booking.total_price,160);assert.equal(booking.service,'Conserto');assert.equal(booking.source_conversation_quote_id,'abc');assert.ok(data.get(`${org}/conversations/conversation`).quote_current.execution_appointment_id); }
  assert.equal((await send('confirm', input)).screen, 'SUCESSO');
  await assert.rejects(send('confirm', input, token2), /não está mais disponível/);
  assert.equal([...data.keys()].filter(k => k.startsWith(`${org}/appointments/`)).length, 1);
  if (petMode) {
    const { customerId } = require('../src/customers');
    const contact = data.get(`${org}/customers/${customerId('5511999999999')}`);
    assert.equal(contact.last_address.street, address.street);
    const appointment = [...data.entries()].find(([key]) => key.startsWith(`${org}/appointments/`))[1];
    assert.equal(appointment.transport_address, contact.last_address.line);
    assert.equal(appointment.transport_reference, address.reference);
    const reuse = await send('transport', { service_id: 's1', ...petIds, transport_id: 'both' }, token2);
    assert.equal(reuse.data.street, address.street);
    assert.equal(reuse.data.reference, address.reference);
  }
});
