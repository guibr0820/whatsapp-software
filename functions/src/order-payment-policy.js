const FULFILLMENT_KEYS = ['delivery', 'pickup', 'dine_in'];

const DEFAULT_ORDER_PAYMENT_POLICY = Object.freeze({
  delivery: Object.freeze({ requireOnlinePayment: false, allowPix: true, allowOnlineCard: false, allowCash: true, allowCard: true }),
  pickup: Object.freeze({ requireOnlinePayment: false, allowPix: true, allowOnlineCard: false, allowCash: true, allowCard: true }),
  dine_in: Object.freeze({ requireOnlinePayment: false, allowPix: true, allowOnlineCard: false, allowCash: true, allowCard: true }),
});

function normalizeOrderPaymentPolicy(input = {}) {
  return Object.fromEntries(FULFILLMENT_KEYS.map(key => {
    const source = input?.[key] && typeof input[key] === 'object' ? input[key] : {};
    const defaults = DEFAULT_ORDER_PAYMENT_POLICY[key];
    const requireOnlinePayment = source.requireOnlinePayment === true || source.requirePix === true;
    const allowPix = source.allowPix !== false;
    const allowOnlineCard = source.allowOnlineCard === true;
    const allowCash = requireOnlinePayment ? false : source.allowCash !== false;
    const allowCard = requireOnlinePayment ? false : source.allowCard !== false;
    if (requireOnlinePayment && !allowPix && !allowOnlineCard) throw new Error('Ative Pix ou cartão online quando o pagamento antecipado for obrigatório.');
    if (!allowPix && !allowOnlineCard && !allowCash && !allowCard) throw new Error('Escolha pelo menos uma forma de pagamento para cada modalidade.');
    return [key, { requireOnlinePayment, allowPix, allowOnlineCard, allowCash, allowCard }];
  }));
}

function paymentOptionsFor(policy, fulfillmentType) {
  const normalized = normalizeOrderPaymentPolicy(policy);
  const rule = normalized[FULFILLMENT_KEYS.includes(fulfillmentType) ? fulfillmentType : 'delivery'];
  const place = fulfillmentType === 'delivery' ? 'na entrega' : fulfillmentType === 'pickup' ? 'na retirada' : 'no caixa';
  const options = [];
  if (rule.allowPix) options.push({id:'pix',title:'Pix online',description:rule.requireOnlinePayment ? 'Pague antes do preparo' : 'QR Code e Copia e Cola após o aceite'});
  if (rule.allowOnlineCard) options.push({id:'card_online',title:'Cartão online',description:'Crédito em 1x ou débito · pagamento seguro'});
  if (rule.allowCash) options.push({id:'cash',title:'Dinheiro',description:`Pague ${place}; informe o troco se precisar`});
  if (rule.allowCard) options.push({id:'card',title:'Cartão',description:`Débito ou crédito na maquininha ${place}`});
  return options;
}

module.exports = { FULFILLMENT_KEYS, DEFAULT_ORDER_PAYMENT_POLICY, normalizeOrderPaymentPolicy, paymentOptionsFor };
