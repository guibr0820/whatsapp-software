// User-authorized R$ 1 validation, isolated from appointments and production settlement.
const axios=require('axios');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {unseal}=require('../src/mercado-pago');
const org='e07e8e25-009b-49d4-96fb-b07b316eaf4b', project='whatsapp-software-a85f3';
const runId='native_pet_payment_20261113', recipient='5511994917461';
async function main(){
 const mode=process.argv[2];if(!['--prepare','--send','--inspect','--cancel'].includes(mode))throw Error('Use --prepare, --send, --inspect or --cancel');
 const google=execFileSync('gcloud.cmd',['auth','print-access-token'],{shell:true,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const gh={Authorization:`Bearer ${google}`};
 const base=`https://firestore.googleapis.com/v1/projects/${project}/databases/default/documents`;
 const decode=v=>v.mapValue?Object.fromEntries(Object.entries(v.mapValue.fields||{}).map(([k,x])=>[k,decode(x)])):v.arrayValue?(v.arrayValue.values||[]).map(decode):v.booleanValue!==undefined?v.booleanValue:v.integerValue!==undefined?Number(v.integerValue):v.doubleValue!==undefined?v.doubleValue:v.timestampValue||v.stringValue;
 const encode=v=>Array.isArray(v)?{arrayValue:{values:v.map(encode)}}:typeof v==='object'?{mapValue:{fields:Object.fromEntries(Object.entries(v).map(([k,x])=>[k,encode(x)]))}}:typeof v==='boolean'?{booleanValue:v}:typeof v==='number'?{doubleValue:v}:{stringValue:String(v)};
 const get=async path=>{try{return decode({mapValue:{fields:(await axios.get(`${base}/${path}`,{headers:gh})).data.fields}});}catch(e){if(e.response?.status===404)return {};throw e;}};
 const set=async(path,data)=>axios.patch(`${base}/${path}`,{fields:encode(data).mapValue.fields},{headers:gh});
 const secret=async name=>Buffer.from((await axios.get(`https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${name}/versions/latest:access`,{headers:gh})).data.payload.data,'base64').toString();
 const root=`organizations/${org}`;
 const connection=await get(`${root}/integrations/mercadopago`), whatsapp=await get(`${root}/integrations/whatsapp`), organization=await get(root);
 if(!connection.active||!whatsapp.active)throw Error('Conecte Mercado Pago e WhatsApp antes do teste.');
 if(new Date(connection.expires_at).getTime()<Date.now()+300000)throw Error('A credencial Mercado Pago precisa ser renovada pela aplicação antes do teste.');
 const credentials=unseal(connection.credentials,await secret('MERCADOPAGO_TOKEN_ENCRYPTION_KEY'));
 const mh={Authorization:`Bearer ${credentials.access_token}`};
 const wh={Authorization:`Bearer ${whatsapp.access_token}`};
 const recordPath=`${root}/payment_validation_runs/${runId}`;
 let record=await get(recordPath);
 if(record.test_cancelled && ['--prepare','--send'].includes(mode))throw Error('Este teste foi cancelado pelo usuário e não pode ser reutilizado.');
 if(mode==='--cancel'){
  if(record.payment_id){
   const url=`https://api.mercadopago.com/v1/payments/${record.payment_id}`;
   let payment=(await axios.get(url,{headers:mh,timeout:15000})).data;
   if(['pending','in_process','authorized'].includes(payment.status))payment=(await axios.put(url,{status:'cancelled'},{headers:mh,timeout:15000})).data;
   record.provider_status=payment.status;
   if(payment.status==='approved')throw Error('O teste já foi pago; nenhum estorno foi realizado.');
   if(!['cancelled','canceled','rejected','refunded'].includes(payment.status))throw Error(`Cancelamento do Pix ainda não confirmado: ${payment.status}`);
  }
  if(record.preference_id){
   await axios.put(`https://api.mercadopago.com/checkout/preferences/${record.preference_id}`,{expires:true,expiration_date_to:new Date(Date.now()-1000).toISOString()},{headers:mh,timeout:15000});
   const pref=(await axios.get(`https://api.mercadopago.com/checkout/preferences/${record.preference_id}`,{headers:mh,timeout:15000})).data;
   if(pref.expires!==true||Date.parse(pref.expiration_date_to)>Date.now())throw Error('Encerramento do checkout ainda não confirmado.');
  }
  record.cancelled_at=new Date().toISOString();record.test_cancelled=true;await set(recordPath,record);
  console.log(JSON.stringify({pixStatus:record.provider_status,checkoutExpired:!!record.preference_id,testCancelled:true,messagesSent:0}));return;
 }
 const template=(await axios.get(`https://graph.facebook.com/v24.0/${whatsapp.waba_id}/message_templates`,{headers:wh,params:{name:'cobranca_atendimento_v1',fields:'id,name,status,language,components'}})).data.data.find(x=>x.name==='cobranca_atendimento_v1'&&x.language==='pt_BR');
 if(template?.status!=='APPROVED')throw Error('Modelo de cobrança ainda não aprovado.');
 if(mode==='--inspect'){console.log(JSON.stringify({templateStatus:template.status,prepared:!!record.payment_id,sent:!!record.provider_message_id,amountCents:record.amount_cents||0}));return;}
 if(mode==='--prepare'){
  const seller=(await axios.get('https://api.mercadopago.com/users/me',{headers:mh})).data;
  if(String(seller.id)!==String(connection.seller_id))throw Error('Recebedor divergente.');
  const contactId=crypto.createHash('sha256').update(`customer:${recipient}`).digest('hex').slice(0,40);
  const contact=await get(`${root}/customers/${contactId}`);
  const email=contact.email||organization.email||seller.email;
  if(!email)throw Error('E-mail do pagador necessário para gerar o teste.');
  record={...record,amount_cents:100,recipient,seller_id:String(seller.id),reference:runId,created_at:record.created_at||new Date().toISOString(),expires_at:record.expires_at||new Date(Date.now()+30*60000).toISOString(),test_only:true};
  if(!record.payment_id){
   const payment=(await axios.post('https://api.mercadopago.com/v1/payments',{transaction_amount:1,description:'TESTE técnico Automichat — R$ 1,00 — sem agendamento',payment_method_id:'pix',date_of_expiration:record.expires_at,payer:{email},external_reference:runId},{headers:{...mh,'X-Idempotency-Key':runId,'Content-Type':'application/json'},timeout:25000})).data;
   if(!payment.id||payment.transaction_amount!==1||String(payment.collector_id)!==String(seller.id))throw Error('Pix de teste inválido.');
   record.payment_id=String(payment.id);record.pix_code=payment.point_of_interaction?.transaction_data?.qr_code||'';record.qr_base64=payment.point_of_interaction?.transaction_data?.qr_code_base64||'';record.ticket_url=payment.point_of_interaction?.transaction_data?.ticket_url||'';
   await set(recordPath,record);
  }
  if(!record.checkout_url){
   const pref=(await axios.post('https://api.mercadopago.com/checkout/preferences',{items:[{id:runId,title:'TESTE técnico Automichat — sem agendamento',quantity:1,currency_id:'BRL',unit_price:1}],payer:{email},external_reference:`${runId}_card`,binary_mode:true,expires:true,expiration_date_from:new Date().toISOString(),expiration_date_to:record.expires_at,payment_methods:{excluded_payment_types:[{id:'ticket'},{id:'atm'},{id:'bank_transfer'}],installments:1}},{headers:mh,timeout:25000})).data;
   if(!pref.init_point?.startsWith('https://www.mercadopago.com.br/'))throw Error('Checkout inválido.');
   record.preference_id=String(pref.id);record.checkout_url=pref.init_point;await set(recordPath,record);
  }
  console.log(JSON.stringify({prepared:true,amountCents:record.amount_cents,paymentId:record.payment_id,checkoutReady:!!record.checkout_url,pixReady:!!record.pix_code,messagesSent:0}));return;
 }
 if(record.provider_message_id){console.log(JSON.stringify({alreadySent:true,providerMessageId:record.provider_message_id}));return;}
 if(record.amount_cents!==100||record.recipient!==recipient||!record.pix_code||!record.checkout_url||Date.parse(record.expires_at)<Date.now())throw Error('Prepare uma cobrança válida de teste de R$ 1,00 antes de enviar.');
 const amount={value:100,offset:100};
 const details={reference_id:runId,type:'physical-goods',payment_type:'br',currency:'BRL',total_amount:amount,payment_settings:[{type:'pix_dynamic_code',pix_dynamic_code:{code:record.pix_code,merchant_name:String(organization.nome||'Automichat').slice(0,25)}},{type:'payment_link',payment_link:{uri:record.checkout_url}}],order:{status:'pending',items:[{retailer_id:runId,name:'TESTE R$ 1 — sem agendamento real',amount,quantity:1}],subtotal:amount,tax:{value:0,offset:100}}};
 const body={messaging_product:'whatsapp',recipient_type:'individual',to:recipient,type:'template',template:{name:'cobranca_atendimento_v1',language:{code:'pt_BR'},components:[{type:'body',parameters:['Guilherme (teste)','teste técnico — sem agendamento real','R$ 1,00'].map(text=>({type:'text',text}))},{type:'button',sub_type:'order_details',index:'0',parameters:[{type:'action',action:{order_details:details}}]}]}};
 const response=await axios.post(`https://graph.facebook.com/v24.0/${whatsapp.phone_number_id}/messages`,body,{headers:wh,timeout:25000});
 const messageId=response.data.messages?.[0]?.id;if(!messageId)throw Error('Envio não confirmado pela Meta.');
 record.provider_message_id=messageId;record.sent_at=new Date().toISOString();await set(recordPath,record);
 console.log(JSON.stringify({sent:true,amountCents:100,providerMessageId:messageId,appointmentsChanged:0}));
}
main().catch(error=>{const x=error.response?.data?.error||{};console.error(JSON.stringify({message:x.message||error.message,userMessage:x.error_user_msg,detail:x.error_data,subcode:x.error_subcode,status:error.response?.status}));process.exitCode=1;});
