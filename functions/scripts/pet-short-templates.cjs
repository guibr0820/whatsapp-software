// Administrative release of concise pet status templates. Never sends customer messages.
const axios = require('axios');
const { execFileSync } = require('node:child_process');
const { petShortTemplateDefinitions } = require('../src/pet-lifecycle');
const organizationId = 'e07e8e25-009b-49d4-96fb-b07b316eaf4b';
const project = 'whatsapp-software-a85f3';
async function main() {
  const mode = process.argv[2];
  if (!['--submit', '--status', '--activate', '--configure', '--delete-obsolete'].includes(mode)) throw new Error('Use --submit, --status, --configure, --activate or --delete-obsolete.');
  const googleToken = execFileSync('gcloud.cmd', ['auth', 'print-access-token'], { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const googleHeaders = { Authorization: `Bearer ${googleToken}` };
  const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/default/documents`;
  const integration = (await axios.get(`${base}/organizations/${organizationId}/integrations/whatsapp`, { headers: googleHeaders })).data.fields;
  const waba = integration.waba_id.stringValue;
  const secret = (await axios.get(`https://secretmanager.googleapis.com/v1/projects/${project}/secrets/META_SYSTEM_USER_ACCESS_TOKEN/versions/latest:access`, { headers: googleHeaders })).data;
  const headers = { Authorization: `Bearer ${Buffer.from(secret.payload.data, 'base64').toString()}` };
  const graph = 'https://graph.facebook.com/v24.0';
  const templates = [];
  let url = `${graph}/${waba}/message_templates?fields=id,name,status,language,category,components,rejected_reason&limit=100`;
  while (url) { const response = await axios.get(url, { headers, timeout: 20000 }); templates.push(...response.data.data); url = response.data.paging?.next; }
  const definitions = petShortTemplateDefinitions();
  for (const definition of definitions) {
    let template = templates.find(item => item.name === definition.name && item.language === definition.language);
    if (!template && mode === '--submit') {
      const result = await axios.post(`${graph}/${waba}/message_templates`, { name: definition.name, language: definition.language, category: 'UTILITY', components: [{ type: 'BODY', text: definition.body, example: { body_text: [definition.parameters] } }] }, { headers, timeout: 20000 });
      template = { ...result.data, name: definition.name, language: definition.language, components: [{ type: 'BODY', text: definition.body }] };
      templates.push(template);
    }
    console.log(JSON.stringify({ name: definition.name, status: template?.status || 'MISSING', reason: template?.rejected_reason || undefined }));
  }
  if (mode === '--activate' || mode === '--configure') {
    const approved = definitions.filter(definition => templates.some(template => template.name === definition.name && template.language === definition.language && template.status === 'APPROVED' && template.components.some(component => component.type === 'BODY' && component.text === definition.body)));
    if (mode === '--activate' && approved.length !== definitions.length) throw new Error(`Only ${approved.length}/${definitions.length} exact templates approved; activation stopped.`);
    const states = definitions.map(definition => {
      const template = templates.find(item => item.name === definition.name && item.language === definition.language);
      if (!template || !template.components.some(component => component.type === 'BODY' && component.text === definition.body)) throw new Error(`Template missing or body mismatch: ${definition.name}`);
      return [definition.name, { stringValue: approved.some(item => item.name === definition.name) ? 'APPROVED' : 'PENDING' }];
    });
    const fields = { enabled: { booleanValue: true }, version: { integerValue: '2' }, verified_at: { timestampValue: new Date().toISOString() }, templates: { mapValue: { fields: Object.fromEntries(states) } } };
    await axios.patch(`${base}/organizations/${organizationId}/automation_configs/pet_status_templates`, { fields }, { headers: googleHeaders });
    console.log(JSON.stringify({ configured: true, approved: approved.length, pending: definitions.length - approved.length, automaticApprovalCheck: true }));
  }
  if (mode === '--delete-obsolete') {
    const registry = (await axios.get(`${base}/organizations/${organizationId}/automation_configs/pet_status_templates`, { headers: googleHeaders })).data.fields;
    const configured = Object.keys(registry.templates?.mapValue?.fields || {});
    if (registry.version?.integerValue !== '2' || configured.length !== 7 || definitions.some(item => !configured.includes(item.name))) throw new Error('Seven-template registry must be configured before deleting obsolete variants.');
    if (definitions.some(definition => !templates.some(template => template.name === definition.name && template.language === definition.language && template.components.some(component => component.type === 'BODY' && component.text === definition.body)))) throw new Error('Replacement templates not found or body mismatch.');
    const obsoleteNames = ['pet_received','pet_in_service','pet_ready_pickup','pet_out_for_delivery'].flatMap(id => ['male','female','unknown'].map(sex => `${id}_curto_v1_${sex}`));
    for (const name of obsoleteNames) {
      if (!templates.some(template => template.name === name)) { console.log(JSON.stringify({ name, alreadyAbsent: true })); continue; }
      const result = await axios.delete(`${graph}/${waba}/message_templates`, { headers, params: { name }, timeout: 20000 });
      if (result.data.success !== true) throw new Error(`Deletion not confirmed for ${name}`);
      console.log(JSON.stringify({ deleted: name }));
    }
    const remaining=[];
    let next=`${graph}/${waba}/message_templates?fields=name,status,language&limit=100`;
    while(next){const result=await axios.get(next,{headers,timeout:20000});remaining.push(...result.data.data);next=result.data.paging?.next;}
    if (remaining.some(template=>obsoleteNames.includes(template.name))) throw new Error('Obsolete templates still returned by Meta.');
    console.log(JSON.stringify({ verifiedRemaining: remaining.filter(template=>definitions.some(definition=>definition.name===template.name)).map(template=>({name:template.name,status:template.status})), obsoleteRemaining:0 }));
  }
}
main().catch(error => { const detail = error.response?.data?.error || {}; console.error(JSON.stringify({ error: detail.message || error.message, userTitle: detail.error_user_title, userMessage: detail.error_user_msg, code: detail.code, subcode: detail.error_subcode, detail: detail.error_data, status: error.response?.status })); process.exitCode = 1; });
