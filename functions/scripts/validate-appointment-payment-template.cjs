// Validates the native order-details template; does not create charges or send messages.
const axios = require('axios');
const { execFileSync } = require('node:child_process');
async function main() {
  const mode = process.argv[2];
  if (!['--create','--inspect'].includes(mode)) throw new Error('Use --create or --inspect.');
  const google = execFileSync('gcloud.cmd',['auth','print-access-token'],{shell:true,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const secret=(await axios.get('https://secretmanager.googleapis.com/v1/projects/whatsapp-software-a85f3/secrets/META_SYSTEM_USER_ACCESS_TOKEN/versions/latest:access',{headers:{Authorization:`Bearer ${google}`}})).data;
  const headers={Authorization:`Bearer ${Buffer.from(secret.payload.data,'base64').toString()}`};
  const base='https://graph.facebook.com/v24.0/1277143801075310/message_templates';
  const name='cobranca_atendimento_v1';
  let templates=(await axios.get(base,{headers,params:{name,fields:'id,name,status,language,category,components,rejected_reason'}})).data.data;
  let found=templates.find(item=>item.name===name&&item.language==='pt_BR');
  if(!found&&mode==='--create'){
    const result=await axios.post(base,{name,language:'pt_BR',category:'UTILITY',components:[{type:'BODY',text:'Olá, {{1}}! O saldo do atendimento de {{2}} é {{3}}. Confira os detalhes e escolha como pagar.',example:{body_text:[['Guilherme','Juli','R$ 120,00']]}},{type:'BUTTONS',buttons:[{type:'ORDER_DETAILS',text:'Copy Pix code'}]}]},{headers,timeout:25000});
    console.log(JSON.stringify({created:result.data}));
    found=(await axios.get(`https://graph.facebook.com/v24.0/${result.data.id}`,{headers,params:{fields:'id,name,status,language,category,components,rejected_reason'}})).data;
  }
  console.log(JSON.stringify({template:found||null,chargesCreated:0,messagesSent:0}));
}
main().catch(error=>{const detail=error.response?.data?.error||{};console.error(JSON.stringify({message:detail.message||error.message,userMessage:detail.error_user_msg,userTitle:detail.error_user_title,code:detail.code,subcode:detail.error_subcode,status:error.response?.status}));process.exitCode=1;});
