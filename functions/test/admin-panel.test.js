const test = require('node:test');
const assert = require('node:assert/strict');
const { ownerProfileName, createAdminFunctions } = require('../src/admin-panel');

class TestHttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

test('normaliza o nome comercial e bloqueia conteúdo inválido', () => {
  assert.equal(ownerProfileName('  Studio Bella  ', TestHttpsError), 'Studio Bella');
  assert.throws(() => ownerProfileName('A', TestHttpsError), /entre 2 e 80/);
  assert.throws(() => ownerProfileName(`Studio\u0000Bella`, TestHttpsError), /caracteres inválidos/);
  assert.throws(() => ownerProfileName('x'.repeat(81), TestHttpsError), /entre 2 e 80/);
});

test('vincula ocupações somente a serviços ativos da própria empresa', async () => {
  const records = new Map([
    ['organizations/org',{proprietario_uid:'owner',segmento:'Serviços profissionais'}],
    ['organizations/org/members/owner',{status:'active'}],
    ['organizations/org/members/other',{status:'active'}],
    ['organizations/org/services/s1',{active:true,segment_name:'Serviços profissionais'}],
    ['organizations/org/services/s2',{active:false,segment_name:'Serviços profissionais'}],
  ]);
  const db = {doc(path) { const ref = {get:async()=>({exists:records.has(path),data:()=>records.get(path),ref}),update:async value=>records.set(path,{...records.get(path),...value})}; return ref; }};
  const admin = {firestore:{FieldValue:{serverTimestamp:()=>1}}};
  const api = createAdminFunctions({admin,db,onCall:(_options,handler)=>handler,HttpsError:TestHttpsError});
  const request = {auth:{uid:'owner'},data:{organizationId:'org',occupations:['Eletricista'],occupationServices:{Eletricista:'s1'}}};
  await api.saveOwnerOccupations(request);
  assert.deepEqual(records.get('organizations/org').occupation_services,{Eletricista:'s1'});
  await assert.rejects(api.saveOwnerOccupations({...request,auth:{uid:'other'}}),/Somente o proprietário/);
  await assert.rejects(api.saveOwnerOccupations({...request,data:{...request.data,occupationServices:{Eletricista:'s2'}}}),/serviço ativo/);
  await assert.rejects(api.saveOwnerOccupations({...request,data:{...request.data,occupationServices:{Eletricista:'../foreign'}}}),/Serviço inválido/);
});
