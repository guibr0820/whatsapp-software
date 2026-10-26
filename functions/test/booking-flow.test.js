const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { availableSlots, buildDynamicFlow, createBookingRuntime, bookingKeywordMatches, validateBookingKeywords } = require('../src/booking-flow');
const { decryptFlowRequest, encryptFlowResponse, normalizeFlowPrivateKey } = require('../src/flow-crypto');
const person = { active: true, service_ids: ['s1'], work_days: [1], work_start: '09:00', work_end: '12:00', interval_minutes: 30, lunch: { active: true, start: '10:00', end: '10:30' } };

test('palavras-chave reconhecem frases no texto, acentos e limites de palavras', () => {
  assert.equal(bookingKeywordMatches('Olá, QUERO marcar HORÁRIO amanhã!', ['marcar horário']), true);
  assert.equal(bookingKeywordMatches('Gostaria de fazer um agendamento.', ['agendamento']), true);
  assert.equal(bookingKeywordMatches('Preciso desagendar.', ['agendar']), false);
  assert.equal(bookingKeywordMatches('Oi', []), false);
  assert.deepEqual(validateBookingKeywords([' Agendar ', 'AGENDAR', 'marcar horário']), ['Agendar', 'marcar horário']);
  assert.throws(() => validateBookingKeywords(['!']), /entre 1 e 80/);
  assert.throws(() => validateBookingKeywords(Array(31).fill('agendar')), /até 30/);
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

test('percorre o Flow, grava uma reserva, rejeita conflito e não duplica ao repetir confirmação', async () => {
  const data = new Map();
  const stamp = value => ({ toMillis: () => value });
  const updated = stamp(1);
  const ref = path => ({ path, collection: name => collection(`${path}/${name}`), get: async () => snapshot(path), set: async (value, options) => set(path, value, options) });
  const snapshot = path => ({ exists: data.has(path), id: path.split('/').at(-1), ref: ref(path), data: () => data.get(path) });
  const set = (path, value, options) => data.set(path, options?.merge ? { ...data.get(path), ...value } : value);
  const collection = path => ({ doc: id => ref(`${path}/${id}`), where: (field, op, value) => ({ get: async () => ({ docs: [...data.keys()].filter(key => key.startsWith(`${path}/`) && key.split('/').length === path.split('/').length + 1 && data.get(key)[field] === value).map(snapshot) }) }) });
  const db = { doc: ref, runTransaction: async work => work({ get: target => target.get(), set: (target, value, options) => set(target.path, value, options) }) };
  const org = 'organizations/company';
  data.set(`${org}/services/s1`, { name: 'Atendimento', active: true, duration_minutes: 60, price: 40, updated_at: updated });
  data.set(`${org}/professionals/p1`, { ...person, name: 'Especialista', work_days: [0,1,2,3,4,5,6], updated_at: updated });
  data.set(`${org}/integrations/whatsapp`, { active: true, access_token: 'segredo', phone_number_id: '12345' });
  const token1 = '12345678-1234-1234-1234-123456789012', token2 = '22345678-1234-1234-1234-123456789012';
  for (const token of [token1, token2]) data.set(`whatsapp_flow_sessions/${token}`, { organization_id: 'company', phone: '5511999999999', conversation_id: 'conversation', flow_id: '12345', expires_at: stamp(Date.now() + 600000), status: 'sent' });
  const admin = { firestore: { FieldValue: { serverTimestamp: () => updated }, Timestamp: { fromDate: date => stamp(date.getTime()) } } };
  const runtime = createBookingRuntime({ db, admin, axios: { post: async () => ({ data: { messages: [{ id: 'message-id' }] } }) }, saveOutbound: async () => {}, logger: { error() {} } });
  const send = (step, input = {}, token = token1) => runtime.handle({ flow_token: token, action: 'data_exchange', data: { step, ...input } });
  const init = await runtime.handle({ action: 'INIT', flow_token: token1 });
  assert.equal(init.data.services[0].id, 's1');
  const professional = await send('service', { service_id: 's1' });
  assert.equal(professional.screen, 'PROFISSIONAL');
  const ids = { service_id: 's1', extra_ids: [], professional_id: 'p1' };
  const dates = await send('professional', ids);
  const date = dates.data.dates.find(d => d.id > new Date().toISOString().slice(0,10)).id;
  const times = await send('date', { ...ids, date });
  const input = { ...ids, date, time: times.data.times[0].id, client_name: 'Cliente Teste' };
  assert.equal((await send('time', input)).screen, 'DADOS');
  assert.equal((await send('details', input)).screen, 'RESUMO');
  assert.equal((await send('confirm', input)).screen, 'SUCESSO');
  assert.equal((await send('confirm', input)).screen, 'SUCESSO');
  await assert.rejects(send('confirm', input, token2), /não está mais disponível/);
  assert.equal([...data.keys()].filter(k => k.startsWith(`${org}/appointments/`)).length, 1);
});
