# Mapa de manutenção — Automichat

Este documento serve como referência para continuar o projeto em outro chat ou com outro desenvolvedor. O projeto Firebase usado em produção é `whatsapp-software-a85f3`, região `southamerica-east1`, com Firestore Enterprise Native no banco `default`.

## Regra principal

- `index.html` é a landing page pública e os cards comerciais.
- `dashboard.html` contém a marcação de todas as telas do painel do estabelecimento.
- `admin.html` contém o painel interno da plataforma.
- Arquivos em `js/` controlam a interface e chamam Firebase Functions.
- Arquivos em `functions/src/` validam permissões e executam operações protegidas no servidor.
- Não grave pedidos, pagamentos, limites ou integrações diretamente pelo navegador. Use uma Firebase Callable Function.
- Depois de alterar frontend, execute `npm run build` e publique `hosting`.
- Depois de alterar backend, execute os testes em `functions` e publique apenas as Functions afetadas.

## Landing page e planos

| Arquivo | Responsabilidade |
|---|---|
| `index.html` | Estrutura da página inicial, seção de preços e cards dos planos Crescimento, Profissional e Negócios. |
| `css/home.css` | Aparência da landing page, incluindo cards, preços, responsividade e seção de comparação. |
| `js/home.js` | Interações da landing page, sessão autenticada e dados carregados para a página pública. |
| `plans.html` | Tela dedicada à escolha ou troca de plano. |
| `js/plans.js` | Carrega planos e grava a escolha da empresa. |
| `functions/src/admin-panel.js` | Administração dos planos, preços, limites e recursos liberados. |
| `functions/src/plan-limits.js` | Limites padrão, recursos por plano e validações de capacidade. |
| `functions/src/plan-usage.js` | Consumo mensal exibido no dashboard. |

Ao melhorar os cards do `index.html`, os números devem vir da configuração real dos planos sempre que possível. Não duplicar limites diferentes no HTML, no admin e no backend.

## Núcleo do dashboard

| Arquivo | Responsabilidade |
|---|---|
| `dashboard.html` | Sidebar, cabeçalho, views, formulários, dialogs e IDs usados pelos scripts. |
| `css/dashboard.css` | Layout geral do painel, sidebar, cards, dialogs, estados e responsividade. |
| `js/dashboard.js` | Autenticação, empresa atual, navegação entre views, conversas, agenda, catálogo de serviços, contatos e inicialização dos módulos. |
| `js/firebase-config.js` | Inicialização do Firebase e exportação de `app` e `db`. |
| `js/auth.js` | Instância de autenticação e tradução de erros de login. |
| `js/ui-loading.js` | Progress bar e bloqueio temporário de botões com `withButtonBusy` e `installButtonProgress`. |
| `js/maintenance-guard.js` | Verifica manutenção global; administrador autenticado pode acessar durante manutenção. |

`js/dashboard.js` é o orquestrador. A função `showView()` troca a tela visível e chama `foodUI.onView(viewName)` quando precisa carregar Cardápio, Pedidos ou Entregas.

## Telas e módulos do estabelecimento

| Tela | Frontend | Backend principal |
|---|---|---|
| Visão geral | `js/dashboard.js`, `css/dashboard.css` | `functions/src/plan-usage.js`, consultas de agenda e conversas |
| Agendamentos | `js/appointments.js`, parte de `js/dashboard.js` | `functions/src/appointments.js`, `functions/src/booking-flow.js` |
| Conversas | `js/dashboard.js` | `functions/src/meta-whatsapp.js` |
| Serviços | `js/dashboard.js` | `functions/src/catalog.js` |
| Cardápio | `js/food-business.js`, `css/food-business.css` | `functions/src/food-catalog.js` |
| Pedidos | `js/food-business.js`, `css/food-business.css` | `functions/src/food-catalog.js`, `functions/src/order-flow.js` |
| Entregas | `js/food-business.js`, `css/deliveries.css`, regras complementares em `css/dashboard.css` | `functions/src/food-catalog.js` |
| Pagamentos | `js/payments.js`, `css/payments.css` | `functions/src/mercado-pago.js`, `functions/src/payment-policy.js` |
| Contatos | Parte de `js/dashboard.js`, `css/customers.css` | `functions/src/customers.js` |
| Automações | `js/automation-tabs.js`, `js/order-notifications.js` | `functions/src/meta-whatsapp.js`, `functions/src/order-notifications.js` |

## Pedidos, catálogo e delivery

### `js/food-business.js`

Controla:

- categorias e produtos do cardápio;
- imagem, preço, estoque, pausa e exclusão de produtos;
- conexão e sincronização do catálogo com a Meta;
- lista, pesquisa, data e filtro de status dos pedidos;
- detalhes, histórico e mudança de status;
- indicador de Pix pendente, pago ou com falha;
- tentativa de gerar novamente uma cobrança Pix;
- quadro de Entregas: aguardando despacho, em rota e finalizadas;
- nome do entregador e previsão em minutos.

Functions chamadas: `listFoodCatalog`, `saveFoodCategory`, `deleteFoodCategory`, `saveFoodProduct`, `deleteFoodProduct`, `connectFoodCatalog`, `syncFoodCatalog`, `listFoodOrders`, `updateFoodOrderStatus` e `retryFoodOrderPix`.

### `functions/src/food-catalog.js`

É a fonte de verdade para cardápio e pedidos. Faz autorização da empresa, valida transições de status, impede preparo de Pix não pago, dispara mensagens automáticas e sincroniza produtos com a Meta. Alterações importantes de pedido devem passar por este arquivo.

### `functions/src/order-flow.js`

Cria e processa o WhatsApp Flow de checkout. O fluxo atual separa identificação, endereço, pagamento e revisão. Também cria uma sessão temporária e impede que o cliente envie o mesmo pedido duas vezes.

Flow publicado pela Meta é imutável. Ao mudar a estrutura, aumente `ORDER_FLOW_SCHEMA_VERSION`; isso força a criação de um Flow novo.

### `functions/src/meta-whatsapp.js`

Faz conexão com a Meta, recebe o webhook do WhatsApp, salva mensagens, valida carrinhos recebidos e abre automaticamente o Flow do pedido. Também contém as Callables de conexão e envio de mensagens.

## Pagamentos

### `js/payments.js`

Exibe e salva a configuração do Mercado Pago e inicia OAuth. Não deve manipular tokens diretamente.

### `functions/src/mercado-pago.js`

Responsável por:

- OAuth e armazenamento cifrado das credenciais;
- criação idempotente de Pix;
- QR Code, Copia e Cola e link de pagamento;
- webhook assinado do Mercado Pago;
- conciliação e confirmação do pagamento;
- mudança automática de pedido Pix para `preparing` após aprovação;
- Pix de sinal de agendamento e compra de capacidade extra.

Nunca exponha `access_token`, client secret, chave de criptografia ou webhook secret no frontend.

## Automações de pedidos

| Arquivo | Responsabilidade |
|---|---|
| `js/order-notifications.js` | Cards, checkboxes e prévia das mensagens no painel. |
| `functions/src/order-notifications.js` | Mensagens padrão e validação da configuração salva. |
| `functions/src/food-catalog.js` | Disparo real quando o status do pedido muda. |

Estados usados: `confirmed`, `preparing`, `ready_pickup`, `out_for_delivery`, `delivered` e `cancelled`. O tempo estimado substitui `{{tempo_entrega}}` e o cancelamento substitui `{{motivo_cancelamento}}`.

## Segmentos e telas liberadas

| Arquivo | Responsabilidade |
|---|---|
| `functions/src/segment-config.js` | Lista de telas conhecidas, segmentos padrão e regras de normalização. |
| `functions/src/admin-panel.js` | Callables para listar e alterar segmentos pelo admin. |
| `js/admin.js` | Interface de Ajustes → Segmentos e alteração do segmento da empresa. |
| `js/dashboard.js` | Oculta ou libera itens do menu de acordo com o segmento e telas permitidas. |

## Administração

| Arquivo | Responsabilidade |
|---|---|
| `admin.html` | Estrutura do painel interno. |
| `js/admin.js` | Visão geral, empresas, planos, pacotes, auditoria, segmentos e manutenção. |
| `css/admin.css` | Layout principal do admin. |
| `css/admin-settings.css` | Ajustes, segmentos e manutenção. |
| `functions/src/admin-panel.js` | Autorização de administrador, planos, empresas, auditoria, segmentos e manutenção. |

## Registro das Functions

`functions/index.js` inicializa o Firebase Admin, cria dependências compartilhadas e exporta todas as Functions. Um novo endpoint só será publicado se estiver retornado por um módulo e incluído em `module.exports` neste arquivo.

## Dados principais no Firestore

- `organizations/{organizationId}`: empresa e plano.
- `organizations/{organizationId}/members`: membros autorizados.
- `organizations/{organizationId}/orders`: pedidos, pagamento, entrega e histórico.
- `organizations/{organizationId}/menu_items`: produtos.
- `organizations/{organizationId}/menu_categories`: categorias.
- `organizations/{organizationId}/integrations/whatsapp`: conexão Meta.
- `organizations/{organizationId}/integrations/mercadopago`: credenciais Mercado Pago cifradas.
- `organizations/{organizationId}/automation_configs`: configuração das automações e Flow.
- `whatsapp_order_flow_sessions`: sessões temporárias do checkout.
- `mercadopago_payments`: índice seguro para conciliação do webhook.

## Comandos de verificação e publicação

Na raiz do projeto:

```powershell
npm run build
```

Na pasta `functions`:

```powershell
npm test -- --runInBand
```

Publicar apenas o site:

```powershell
npx -y firebase-tools@latest deploy --only hosting --project whatsapp-software-a85f3
```

Publicar Functions específicas:

```powershell
npx -y firebase-tools@latest deploy --only functions:NOME_DA_FUNCTION --project whatsapp-software-a85f3
```

## Texto sugerido para iniciar outro chat

> Estou continuando o projeto Automichat em `D:\\SAAS-SITES\\grsystem_enterprises\\whatsapp-software`. Antes de alterar qualquer coisa, leia `docs/mapa-dashboard-e-scripts.md`, verifique `git status` e preserve todas as mudanças existentes. O frontend é Vite/Firebase Hosting, o backend usa Firebase Functions Node.js 22 e Firestore Enterprise Native `default`. Não grave pedidos, pagamentos ou integrações diretamente pelo navegador. Use as Callables existentes, execute os testes e publique apenas os recursos alterados. Primeiro analise e explique o plano; só implemente depois da minha confirmação.

