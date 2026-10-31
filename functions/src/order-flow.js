const crypto = require('node:crypto');
const ORDER_FLOW_SCHEMA_VERSION = 2;

const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const money = cents => `R$ ${(Number(cents || 0) / 100).toFixed(2).replace('.', ',')}`;
const publicError = message => Object.assign(new Error(message), {publicMessage: message});

function itemList(items = [], maxLength = 360) {
  const labels = items.map(item => `${Math.max(1, Number(item.quantity) || 1)}x ${String(item.name || 'Produto').trim().slice(0, 100)}`);
  let result = '';
  for (let index = 0; index < labels.length; index += 1) {
    const remaining = labels.length - index;
    const suffix = remaining > 1 ? ` + ${remaining} outros` : '';
    const candidate = result ? `${result}, ${labels[index]}` : labels[index];
    if (candidate.length + suffix.length > maxLength) return `${result || labels[index].slice(0, Math.max(1, maxLength - suffix.length))}${suffix}`;
    result = candidate;
  }
  return result || 'Seu pedido';
}

function orderIntro(order = {}) {
  return `Recebemos seu carrinho: ${itemList(order.items)}. Total de ${money(order.total_cents)}. Para continuar, clique em FINALIZAR e complete os dados do pedido.`;
}

function buildOrderFlow() {
  const choice = {type:'array',items:{type:'object',properties:{id:{type:'string'},title:{type:'string'},description:{type:'string'}}}};
  const text = example => ({type:'string',__example__:example});
  const identity = {client_name:text('Mariana'),fulfillment_type:text('delivery')};
  const address = {address_line:text('Rua Exemplo, 10'),address_reference:text('Portão azul')};
  return {version:'7.3',data_api_version:'3.0',routing_model:{IDENTIFICACAO:['ENDERECO','PAGAMENTO','ERRO'],ENDERECO:['PAGAMENTO','ERRO'],PAGAMENTO:['REVISAO','ERRO'],REVISAO:['SUCESSO','ERRO'],SUCESSO:[],ERRO:[]},screens:[
    {id:'IDENTIFICACAO',title:'Finalizar pedido',data:{order_summary:text('1x Pizza · R$ 35,00'),customer_name:text('Mariana'),fulfillment_options:{...choice,__example__:[{id:'delivery',title:'Entrega',description:'Receber no endereço'}]}},layout:{type:'SingleColumnLayout',children:[{type:'Form',name:'identity_form',children:[
      {type:'TextHeading',text:'Como deseja receber?'},{type:'TextBody',text:'${data.order_summary}'},{type:'TextInput',name:'client_name',label:'Nome de quem receberá',required:true,'input-type':'text'},{type:'Dropdown',name:'fulfillment_type',label:'Recebimento',required:true,'data-source':'${data.fulfillment_options}'},{type:'Footer',label:'Prosseguir','on-click-action':{name:'data_exchange',payload:{step:'identity',client_name:'${form.client_name}',fulfillment_type:'${form.fulfillment_type}'}}}
    ]}]}},
    {id:'ENDERECO',title:'Endereço de entrega',data:identity,layout:{type:'SingleColumnLayout',children:[{type:'Form',name:'address_form',children:[
      {type:'TextHeading',text:'Onde devemos entregar?'},{type:'TextInput',name:'street',label:'Rua ou avenida',required:true,'input-type':'text'},{type:'TextInput',name:'number',label:'Número',required:true,'input-type':'text'},{type:'TextInput',name:'district',label:'Bairro',required:true,'input-type':'text'},{type:'TextInput',name:'city',label:'Cidade',required:true,'input-type':'text'},{type:'TextInput',name:'complement',label:'Complemento',required:false,'input-type':'text'},{type:'TextInput',name:'address_reference',label:'Ponto de referência',required:false,'input-type':'text'},{type:'Footer',label:'Prosseguir','on-click-action':{name:'data_exchange',payload:{step:'address',client_name:'${data.client_name}',fulfillment_type:'${data.fulfillment_type}',street:'${form.street}',number:'${form.number}',district:'${form.district}',city:'${form.city}',complement:'${form.complement}',address_reference:'${form.address_reference}'}}}
    ]}]}},
    {id:'PAGAMENTO',title:'Forma de pagamento',data:{...identity,...address,payment_options:{...choice,__example__:[{id:'pix',title:'Pix online',description:'QR Code após o aceite'}]},card_options:{...choice,__example__:[{id:'debit',title:'Débito',description:'Pagar na maquininha'}]}},layout:{type:'SingleColumnLayout',children:[{type:'Form',name:'payment_form',children:[
      {type:'TextHeading',text:'Como deseja pagar?'},{type:'Dropdown',name:'payment_method',label:'Forma de pagamento',required:true,'data-source':'${data.payment_options}'},{type:'TextInput',name:'customer_email',label:'E-mail (obrigatório para Pix)',required:false,'input-type':'email'},{type:'Dropdown',name:'card_type',label:'Débito ou crédito? (se cartão)',required:false,'data-source':'${data.card_options}'},{type:'TextInput',name:'change_for',label:'Troco para quanto? (se dinheiro)',required:false,'input-type':'text'},{type:'TextArea',name:'observations',label:'Observações',required:false,'helper-text':'Ex.: retirar cebola.'},{type:'Footer',label:'Revisar pedido','on-click-action':{name:'data_exchange',payload:{step:'payment',client_name:'${data.client_name}',fulfillment_type:'${data.fulfillment_type}',address_line:'${data.address_line}',address_reference:'${data.address_reference}',payment_method:'${form.payment_method}',customer_email:'${form.customer_email}',card_type:'${form.card_type}',change_for:'${form.change_for}',observations:'${form.observations}'}}}
    ]}]}},
    {id:'REVISAO',title:'Revisar pedido',data:{...identity,...address,payment_method:text('pix'),customer_email:text('cliente@exemplo.com'),card_type:text(''),change_for:text(''),observations:text('Sem cebola'),review_summary:text('Entrega · Pix online'),order_summary:text('1x Pizza · R$ 35,00')},layout:{type:'SingleColumnLayout',children:[
      {type:'TextHeading',text:'Confira antes de enviar'},{type:'TextBody',text:'${data.order_summary}'},{type:'TextSubheading',text:'Cliente e recebimento'},{type:'TextBody',text:'${data.client_name}\n${data.review_summary}\n${data.address_line}\n${data.address_reference}'},{type:'TextSubheading',text:'Observações'},{type:'TextBody',text:'${data.observations}'},{type:'Footer',label:'Enviar pedido','on-click-action':{name:'data_exchange',payload:{step:'confirm',client_name:'${data.client_name}',fulfillment_type:'${data.fulfillment_type}',address_line:'${data.address_line}',address_reference:'${data.address_reference}',payment_method:'${data.payment_method}',customer_email:'${data.customer_email}',card_type:'${data.card_type}',change_for:'${data.change_for}',observations:'${data.observations}'}}}
    ]}},
    {id:'SUCESSO',title:'Pedido enviado',terminal:true,success:true,data:{message:text('Seu pedido foi enviado para confirmação.')},layout:{type:'SingleColumnLayout',children:[{type:'TextHeading',text:'Tudo certo!'},{type:'TextBody',text:'${data.message}'},{type:'Footer',label:'Concluir','on-click-action':{name:'complete',payload:{status:'order_submitted'}}}]}},
    {id:'ERRO',title:'Não foi possível continuar',terminal:true,data:{message:text('Abra o pedido novamente e tente mais uma vez.')},layout:{type:'SingleColumnLayout',children:[{type:'TextBody',text:'${data.message}'},{type:'Footer',label:'Fechar','on-click-action':{name:'complete',payload:{status:'error'}}}]}}
  ]};
}

function validateOrderDetails(input = {}) {
  const clientName = String(input.client_name || '').trim().slice(0, 100);
  const fulfillmentType = String(input.fulfillment_type || '');
  const paymentMethod = String(input.payment_method || '');
  const addressLine = String(input.address_line || '').trim().slice(0, 300);
  const addressReference = String(input.address_reference || '').trim().slice(0, 160);
  const observations = String(input.observations || '').trim().slice(0, 500);
  const customerEmail = String(input.customer_email || '').trim().toLowerCase().slice(0, 160);
  const cardType = String(input.card_type || '').trim();
  if (clientName.length < 2) throw publicError('Informe o nome de quem receberá o pedido.');
  if (!['delivery','pickup','dine_in'].includes(fulfillmentType)) throw publicError('Escolha entrega, retirada ou consumo no local.');
  if (fulfillmentType === 'delivery' && addressLine.length < 5) throw publicError('Informe o endereço completo para entrega.');
  if (!['pix','cash','card'].includes(paymentMethod)) throw publicError('Escolha uma forma de pagamento válida.');
  if (paymentMethod === 'pix' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) throw publicError('Informe um e-mail válido para gerar o Pix.');
  if (paymentMethod === 'card' && !['debit','credit'].includes(cardType)) throw publicError('Escolha débito ou crédito para pagar na maquininha.');
  let changeForCents = 0;
  if (paymentMethod === 'cash' && String(input.change_for || '').trim()) {
    const value = Number(String(input.change_for).replace(/[^\d,.-]/g, '').replace(',', '.'));
    if (!Number.isFinite(value) || value < 0 || value > 100000) throw publicError('Informe um valor válido para o troco.');
    changeForCents = Math.round(value * 100);
  }
  return {clientName, fulfillmentType, paymentMethod, addressLine, addressReference, observations, changeForCents, customerEmail, cardType};
}

function createOrderRuntime({admin, db, axios, logger, saveOutbound}) {
  const root = id => db.doc(`organizations/${id}`);
  const response = (screen, data) => ({version:'3.0',screen,data});
  async function session(token) {
    if (!/^[a-f0-9-]{36}$/.test(String(token))) throw publicError('Sessão inválida. Envie FINALIZAR novamente.');
    const snap = await db.doc(`whatsapp_order_flow_sessions/${token}`).get();
    if (!snap.exists || snap.data().expires_at?.toMillis() < Date.now()) throw publicError('Esta sessão expirou. Envie FINALIZAR novamente.');
    return {...snap.data(),ref:snap.ref};
  }
  async function handle(payload) {
    if (payload.action === 'ping') return {version:'3.0',data:{status:'active'}};
    const current = await session(payload.flow_token);
    const orderRef = root(current.organization_id).collection('orders').doc(current.order_id);
    const order = (await orderRef.get()).data();
    if (!order) throw publicError('Pedido não encontrado. Envie o carrinho novamente.');
    if (order.status !== 'awaiting_data') return response('SUCESSO',{message:'Este pedido já foi enviado para confirmação.'});
    const input = payload.data || {};
    const step = payload.action === 'INIT' || payload.action === 'BACK' ? 'init' : input.step;
    const paymentOptions = fulfillmentType => {
      const place = fulfillmentType === 'delivery' ? 'na entrega' : fulfillmentType === 'pickup' ? 'na retirada' : 'no caixa';
      return [{id:'pix',title:'Pix online',description:'QR Code e Copia e Cola após o aceite'},{id:'cash',title:'Dinheiro',description:`Pague ${place}; informe o troco se precisar`},{id:'card',title:'Cartão',description:`Débito ou crédito na maquininha ${place}`}];
    };
    if (step === 'init') return response('IDENTIFICACAO',{order_summary:`${itemList(order.items,260)} · ${money(order.total_cents)}`,customer_name:order.customer_name||current.customer_name||'Cliente',fulfillment_options:[{id:'delivery',title:'Entrega',description:'Receber no seu endereço'},{id:'pickup',title:'Retirada',description:'Buscar no estabelecimento'},{id:'dine_in',title:'Consumo no local',description:'Consumir no estabelecimento'}]});
    if (step === 'identity') {
      const clientName = String(input.client_name || '').trim().slice(0,100);
      const fulfillmentType = String(input.fulfillment_type || '');
      if (clientName.length < 2) throw publicError('Informe o nome de quem receberá o pedido.');
      if (!['delivery','pickup','dine_in'].includes(fulfillmentType)) throw publicError('Escolha entrega, retirada ou consumo no local.');
      if (fulfillmentType === 'delivery') return response('ENDERECO',{client_name:clientName,fulfillment_type:fulfillmentType});
      return response('PAGAMENTO',{client_name:clientName,fulfillment_type:fulfillmentType,address_line:'Não se aplica',address_reference:'',payment_options:paymentOptions(fulfillmentType),card_options:[{id:'debit',title:'Débito',description:'Pagar na maquininha'},{id:'credit',title:'Crédito',description:'Pagar na maquininha'}]});
    }
    if (step === 'address') {
      const parts = ['street','number','district','city'].map(key => String(input[key] || '').trim());
      if (parts.some(part => part.length < 1)) throw publicError('Preencha rua, número, bairro e cidade para a entrega.');
      const addressLine = `${parts[0]}, ${parts[1]} · ${parts[2]} · ${parts[3]}${input.complement ? ` · ${String(input.complement).trim()}` : ''}`.slice(0,300);
      return response('PAGAMENTO',{client_name:String(input.client_name||'').trim(),fulfillment_type:'delivery',address_line:addressLine,address_reference:String(input.address_reference||'').trim().slice(0,160),payment_options:paymentOptions('delivery'),card_options:[{id:'debit',title:'Débito',description:'Pagar na maquininha'},{id:'credit',title:'Crédito',description:'Pagar na maquininha'}]});
    }
    const details = validateOrderDetails(input);
    if (step === 'payment') {
      const fulfillment = {delivery:'Entrega',pickup:'Retirada',dine_in:'Consumo no local'}[details.fulfillmentType];
      const payment = details.paymentMethod === 'card' ? `Cartão ${details.cardType === 'debit' ? 'de débito' : 'de crédito'}` : {pix:'Pix online',cash:'Dinheiro'}[details.paymentMethod];
      return response('REVISAO',{client_name:details.clientName,fulfillment_type:details.fulfillmentType,address_line:details.addressLine||'Não se aplica',address_reference:details.addressReference||'Sem referência',payment_method:details.paymentMethod,customer_email:details.customerEmail,card_type:details.cardType,change_for:details.changeForCents?money(details.changeForCents):'',observations:details.observations||'Nenhuma',review_summary:`${fulfillment} · ${payment}${details.changeForCents?` · troco para ${money(details.changeForCents)}`:''}`,order_summary:`${itemList(order.items,260)} · ${money(order.total_cents)}`});
    }
    if (step !== 'confirm') throw publicError('Etapa inválida. Envie FINALIZAR novamente.');
    await db.runTransaction(async transaction => {
      const fresh = await transaction.get(orderRef);
      if (!fresh.exists || fresh.data().status !== 'awaiting_data') return;
      transaction.set(orderRef,{customer_name:details.clientName,customer:{name:details.clientName,phone:fresh.data().customer_phone,email:details.customerEmail},fulfillment_type:details.fulfillmentType,address:{line:details.addressLine,reference:details.addressReference},payment:{method:details.paymentMethod,customer_email:details.customerEmail,card_type:details.cardType,change_for_cents:details.changeForCents,status:'pending'},observations:details.observations,status:'awaiting_confirmation',requires_checkout:false,status_history:admin.firestore.FieldValue.arrayUnion({status:'awaiting_confirmation',source:'whatsapp_flow',at:admin.firestore.Timestamp.now()}),updated_at:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
      transaction.set(current.ref,{status:'completed',completed_at:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    });
    return response('SUCESSO',{message:'Seu pedido foi enviado ao estabelecimento e aguarda confirmação.'});
  }
  async function ensureFlow(organizationId) {
    const settingRef = root(organizationId).collection('automation_configs').doc('order_checkout');
    const setting = (await settingRef.get()).data();
    if (setting?.active && Number(setting.schema_version) === ORDER_FLOW_SCHEMA_VERSION && /^\d{5,30}$/.test(String(setting.flow_id))) return String(setting.flow_id);
    const integration = (await root(organizationId).collection('integrations').doc('whatsapp').get()).data() || {};
    if (!integration.active || !integration.access_token || !/^\d+$/.test(String(integration.waba_id))) throw publicError('Atualize a conexão do WhatsApp antes de finalizar pedidos.');
    const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
    const auth = {Authorization:`Bearer ${integration.access_token}`};
    const form = new FormData(); form.append('name',`Finalizar pedido ${new Date().toISOString().replace(/\D/g,'').slice(0,14)}`); form.append('categories',JSON.stringify(['OTHER'])); form.append('endpoint_uri',`https://southamerica-east1-${projectId}.cloudfunctions.net/orderFlowEndpoint`);
    const created = await axios.post(`https://graph.facebook.com/${integration.graph_version||'v24.0'}/${integration.waba_id}/flows`,form,{headers:auth,timeout:20000});
    const flowId = String(created.data?.id || ''); if (!flowId) throw publicError('A Meta não conseguiu criar o Flow do pedido.');
    const asset = new FormData(); asset.append('name','flow.json'); asset.append('asset_type','FLOW_JSON'); asset.append('file',new Blob([JSON.stringify(buildOrderFlow())],{type:'application/json'}),'flow.json');
    const uploaded = await axios.post(`https://graph.facebook.com/${integration.graph_version||'v24.0'}/${flowId}/assets`,asset,{headers:auth,timeout:30000});
    if (uploaded.data?.validation_errors?.length) throw publicError(`A Meta recusou o Flow: ${uploaded.data.validation_errors[0]?.error || 'validação inválida'}`);
    await axios.post(`https://graph.facebook.com/${integration.graph_version||'v24.0'}/${flowId}/publish`,null,{headers:auth,timeout:20000});
    await settingRef.set({active:true,flow_id:flowId,status:'PUBLISHED',schema_version:ORDER_FLOW_SCHEMA_VERSION,created_at:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    return flowId;
  }
  async function sendForOrder({organizationId,orderId,conversationId,phone,customerName}) {
    const pending = await root(organizationId).collection('orders').doc(orderId).get();
    if (!pending.exists || pending.data().status !== 'awaiting_data') return false;
    const integration = (await root(organizationId).collection('integrations').doc('whatsapp').get()).data() || {};
    const flowId = await ensureFlow(organizationId); const token = crypto.randomUUID();
    await db.doc(`whatsapp_order_flow_sessions/${token}`).set({organization_id:organizationId,order_id:pending.id,conversation_id:conversationId,flow_id:flowId,phone,customer_name:customerName||pending.data().customer_name||'Cliente',status:'sent',expires_at:admin.firestore.Timestamp.fromMillis(Date.now()+30*60000),created_at:admin.firestore.FieldValue.serverTimestamp()});
    const body=orderIntro(pending.data());
    const outbound={type:'interactive',interactive:{type:'flow',body:{text:body},action:{name:'flow',parameters:{flow_message_version:'3',flow_id:flowId,flow_token:token,flow_cta:'FINALIZAR',flow_action:'data_exchange'}}}};
    const result=await axios.post(`https://graph.facebook.com/${integration.graph_version||'v24.0'}/${integration.phone_number_id}/messages`,{messaging_product:'whatsapp',to:phone,...outbound},{headers:{Authorization:`Bearer ${integration.access_token}`},timeout:15000});
    const providerMessageId=String(result.data?.messages?.[0]?.id||'');
    if (providerMessageId) await saveOutbound({admin,db,organizationId,conversationId,providerMessageId,type:'flow',text:body,createdBy:'order_automation'});
    await pending.ref.set({message_statuses:{checkout_invite:{status:providerMessageId?'sent':'failed',provider_message_id:providerMessageId,updated_at:admin.firestore.Timestamp.now()}},updated_at:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    return true;
  }
  async function automate({organizationId,message,contact}) {
    if (!['text','interactive'].includes(message?.type) || normalize(message.text?.body || message.interactive?.button_reply?.title) !== 'finalizar') return false;
    const phone = String(message.from || '').replace(/\D/g,'');
    const snapshot = await root(organizationId).collection('orders').where('customer_phone','==',phone).limit(50).get();
    const pending = snapshot.docs.filter(d=>d.data().status==='awaiting_data').sort((a,b)=>(b.data().created_at?.toMillis?.()||0)-(a.data().created_at?.toMillis?.()||0))[0];
    if (!pending) return false;
    const conversationId = crypto.createHash('sha256').update(`contact:${phone}`).digest('hex');
    return sendForOrder({organizationId,orderId:pending.id,conversationId,phone,customerName:contact?.profile?.name||pending.data().customer_name||'Cliente'});
  }
  return {handle,automate,ensureFlow,sendForOrder};
}

module.exports={buildOrderFlow,validateOrderDetails,createOrderRuntime,itemList,orderIntro};
