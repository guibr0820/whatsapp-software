# Pagamento presencial e sinal Pix — Automichat

Implementação local baseada no fluxo já usado pelo **SaaS Barbearia**, com a API de pagamentos (`POST /v1/payments`). Cada estabelecimento conecta a própria conta por OAuth e recebe diretamente nela; não existe Access Token global compartilhado entre vendedores.

## Fluxo

- Presencial: revisão → confirmação → lembrete já configurado.
- Sinal: dados → e-mail para cobrança → revisão com total/sinal/saldo → reserva temporária → Pix na conversa → pagamento confirmado pela API → confirmação e lembrete.
- Regra fixa ou percentual, incluindo adicionais; sinal limitado ao total do serviço.
- Prazo: 30, 60 ou 120 minutos. O mínimo documentado do Pix pela API de Pagamentos é 30 minutos.
- O horário só é liberado após consultar/cancelar o Payment no provedor. Durante indisponibilidade do Mercado Pago a reserva permanece bloqueada para evitar receber por horário revendido.
- Conciliação a cada minuto recupera notificações perdidas, pagamentos Pix pendentes e envio de confirmação pendente. Uma cobrança que falhe repetidamente precisa ser inspecionada nos logs; ela não é tratada automaticamente como paga ou cancelada.
- Cancelar um agendamento já pago não faz estorno automático. O proprietário gerencia devoluções no Mercado Pago.

## Credenciais da aplicação

Na aplicação Mercado Pago configure **Checkout Transparente / API de Pagamentos** e OAuth para conectar contas de vendedores. Cada estabelecimento conecta sua conta pelo botão do painel. O servidor guarda os tokens OAuth cifrados; eles não são retornados ao navegador nem podem ser lidos diretamente pelas regras Firestore.

Configure esta URL de redirecionamento OAuth exatamente:

`https://southamerica-east1-whatsapp-software-a85f3.cloudfunctions.net/mercadoPagoOAuthCallback`

Configure Webhooks, tópico **Pagamentos** / **Payment**, ambiente correspondente às credenciais:

`https://southamerica-east1-whatsapp-software-a85f3.cloudfunctions.net/mercadoPagoWebhook`

A assinatura secreta exibida nas configurações de Webhooks é o valor de `MERCADOPAGO_WEBHOOK_SECRET`. Ela é diferente do Client Secret OAuth.

Na raiz do projeto, em PowerShell:

```powershell
firebase functions:secrets:set MERCADOPAGO_CLIENT_ID --project whatsapp-software-a85f3
firebase functions:secrets:set MERCADOPAGO_CLIENT_SECRET --project whatsapp-software-a85f3
firebase functions:secrets:set MERCADOPAGO_WEBHOOK_SECRET --project whatsapp-software-a85f3
```

Gere a chave de proteção dos tokens uma única vez, sem imprimi-la:

```powershell
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" | firebase functions:secrets:set MERCADOPAGO_TOKEN_ENCRYPTION_KEY --data-file - --project whatsapp-software-a85f3
```

Não regenere essa chave depois que houver contas conectadas: os tokens existentes dependem dela para serem decifrados. Não é necessário Public Key ou Access Token manual para este fluxo OAuth de servidor.

Publicação pelo proprietário:

```powershell
npm run build
firebase deploy --only functions,hosting --project whatsapp-software-a85f3
```

Functions: getPaymentSettings, savePaymentSettings, connectMercadoPago, disconnectMercadoPago, mercadoPagoOAuthCallback, mercadoPagoWebhook e reconcileMercadoPagoOrders. O último nome foi mantido para atualizar o agendamento já publicado, embora agora concilie Payments. Também foram alteradas bookingFlowEndpoint, createAppointmentFlow, saveWhatsAppFlowConfig e listAppointments. O projeto precisa permanecer no plano com suporte a Functions e Cloud Scheduler.

## Ativar no painel

1. Após publicar, abra **Automações → Flows → lápis** e crie/publique a nova versão do Flow. Flows publicados na Meta não são alterados no lugar.
2. Selecione a nova versão e clique **Salvar configuração**. Ela contém o esquema de pagamento versão 2.
3. Abra **Pagamentos → Sinal para reservar → Conectar Mercado Pago**. Autorize a conta que recebe os pagamentos.
4. Defina o sinal e o prazo. Não é necessário informar chave Pix: a conta recebedora é a conta Mercado Pago conectada.
5. Salve. O backend impede ativar sinal com um Flow antigo.
6. Envie `menu` de outro WhatsApp, agende e revise os valores. Pague o Pix e confira a confirmação, agenda e lembrete. Faça também um teste de vencimento e confira que o horário só volta a ficar livre após cancelar/expirar no provedor.

## Modelo de mensagem da Meta

A cobrança só é criada quando o cliente toca em **Gerar Pix do sinal** na revisão do Flow. Em seguida, o Pix Copia e Cola é enviado na conversa. A conta recebedora é definida pelo token OAuth usado para criar o Payment.

Um template aprovado de detalhes de pedido pode ser acrescentado futuramente para cobranças fora da janela de atendimento. Não foi criado nem enviado nenhum template à Meta nesta implementação. O template de lembrete já existente continua separado e só é programado depois da confirmação do sinal.

## Segurança e dados

- OAuth: estado aleatório, uso único, validade de 10 minutos e nova checagem do proprietário no callback.
- Credenciais: AES-256-GCM em `organizations/{org}/integrations/mercadopago`.
- Configuração: `organizations/{org}/payment_settings/booking`, acessada somente por callables do proprietário.
- Tentativas: `payment_attempts/{referencia}`; vínculo Payment → tentativa em `mercadopago_payments/{paymentId}`. Ambas negadas pelas regras já existentes.
- Reserva e tentativa gravadas na mesma transação; idempotência por tentativa; validação de assinatura webhook, referência, recebedor, moeda e valor recebido antes de confirmar.
- Banco existente `default`, edição Enterprise, mantido. Nenhuma regra de acesso foi ampliada.

## Referências oficiais consultadas

- [Pix com API de Pagamentos](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/integration-configuration/integrate-pix)
- [Criar/renovar token OAuth](https://www.mercadopago.com.br/developers/pt/reference/authentication/oauth/_oauth_token/post)
- [Consultar pagamento](https://www.mercadopago.com.br/developers/pt/reference/payments/_payments_id/get)
- [Notificações e assinatura](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/additional-content/your-integrations/notifications/webhooks)

Testes locais usam dados fictícios e chamadas simuladas. A aprovação final da Meta e o pagamento real dependem das credenciais, publicação e teste do proprietário.
