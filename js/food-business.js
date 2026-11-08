import {withButtonBusy} from "./ui-loading.js";

const FOOD_SEGMENTS = ["pizzaria", "lanchonete", "hamburgueria", "restaurante", "delivery de alimentos", "doceria", "confeitaria", "açaí", "sorveteria"];

export function isFoodBusiness(segment) {
  const value = String(segment || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
  return FOOD_SEGMENTS.some((item) => value.includes(item.normalize("NFD").replace(/[\u0300-\u036f]/g, "")));
}

export function createFoodBusinessUI({call, showView, callableMessage, startCatalogAuthorization}) {
  let organizationId = "";
  let food = false;
  let loaded = false;
  let activeTab = "products";
  let menu = {categories: [], products: [], integration: {}};
  let orders = [];
  let imageData = "";
  let activeOrderQuickFilter = "all";
  let knownOrderIds = null;
  let orderPolling = null;

  const money = (cents, currency = "BRL") => new Intl.NumberFormat("pt-BR", {style: "currency", currency}).format((Number(cents) || 0) / 100);
  const escape = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[char]);
  const el = (selector) => document.querySelector(selector);
  const feedback = (selector, message, error = false) => { const node = el(selector); node.textContent = message; node.classList.toggle("error", error); node.hidden = !message; };
  const orderLabels = {awaiting_data:"Aguardando cliente",awaiting_confirmation:"Aguardando confirmação",awaiting_payment:"Aguardando pagamento",received:"Aguardando confirmação",confirmed:"Confirmado",preparing:"Em preparo",ready:"Pronto",out_for_delivery:"Em entrega",completed:"Concluído",cancelled:"Cancelado"};
  const orderDayKey = (value = new Date()) => {
    const parts = new Intl.DateTimeFormat("en-US", {timeZone:"America/Sao_Paulo",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(value instanceof Date ? value : new Date(value));
    const part = (type) => parts.find((item) => item.type === type)?.value || "";
    return `${part("year")}-${part("month")}-${part("day")}`;
  };
  const dateFromKey = (key) => new Date(`${key}T12:00:00-03:00`);
  const orderDate = (order) => order.created_at ? new Date(order.created_at) : null;
  const isOperationalOrder = (order) => {
    if (!order) return false;
    if (order.status === "awaiting_data") return true;
    if (!["delivery","pickup","dine_in"].includes(order.fulfillment_type) || !["pix","card_online","cash","card"].includes(order.payment?.method)) return false;
    if (order.fulfillment_type !== "delivery") return true;
    return String(order.address?.line || "").trim().length >= 5 || Boolean(String(order.address?.street || "").trim() && String(order.address?.number || "").trim());
  };
  const paymentCategory = (order) => ["cash","card"].includes(order.payment?.method) ? "onsite" : order.payment?.status || "pending";
  const paymentDisplay = (order) => {
    if (["cash","card"].includes(order.payment?.method)) return {label:"No recebimento", className:"onsite"};
    const status = order.payment?.status || "pending";
    return {label:({paid:"Pago",pending:"Pix pendente",failed:"Falha no Pix"})[status] || "Pix pendente",className:status};
  };
  const orderMatchesQuickFilter = (order) => ({
    new:["awaiting_confirmation","awaiting_payment","received"].includes(order.status),
    preparing:["confirmed","preparing"].includes(order.status),
    ready:["ready","out_for_delivery"].includes(order.status),
    completed:order.status === "completed",
    all:true
  })[activeOrderQuickFilter] ?? true;

  function configure(segment, enabledScreens = []) {
    food = enabledScreens.length ? enabledScreens.includes("orders") || enabledScreens.includes("menu") : isFoodBusiness(segment);
    const schedule = el("#nav-schedule");
    const catalog = el("#nav-catalog");
    const employees = el("#nav-employees");
    const automations = el("#nav-automations");
    if (food) {
      schedule.dataset.view = "orders"; schedule.querySelector("span:last-child").textContent = "Pedidos"; schedule.querySelector(".nav-icon").textContent = "▤";
      catalog.dataset.view = "menu"; catalog.querySelector("span:last-child").textContent = "Cardápio"; catalog.querySelector(".nav-icon").textContent = "◫";
      if (!enabledScreens.includes("employees")) { employees.classList.add("segment-disabled"); employees.disabled = true; employees.title = "Esta área não está liberada para este segmento."; }
      if (!enabledScreens.includes("automations")) { automations.classList.add("segment-disabled"); automations.disabled = true; automations.title = "Esta área não está liberada para este segmento."; }
      el("#overview-usage-card").hidden = true;
      const agendaPanel = document.querySelector(".today-agenda-panel"); if (agendaPanel) agendaPanel.hidden = true;
      const welcome = document.querySelector(".welcome-row p"); if (welcome) welcome.textContent = "Acompanhe pedidos, conversas e o que precisa da sua atenção.";
      const metrics = document.querySelectorAll(".metric-card");
      if (metrics.length >= 4) { metrics[0].querySelector("p").textContent = "Pedidos de hoje"; metrics[0].querySelector("small").textContent = "recebidos pelo WhatsApp"; metrics[1].querySelector("p").textContent = "Em preparo"; metrics[1].querySelector("small").textContent = "pedidos na cozinha"; metrics[3].querySelector("p").textContent = "Concluídos hoje"; metrics[3].querySelector("small").textContent = "pedidos finalizados"; }
    }
    return food;
  }

  async function loadMenu(force = false) {
    if (!food || (!force && loaded)) return;
    feedback("#menu-feedback", "");
    try {
      const response = await call("listFoodCatalog", {organizationId});
      menu = response.data;
      loaded = true;
      renderMenu();
      renderMetaStatus();
    } catch (error) {
      feedback("#menu-feedback", callableMessage(error), true);
    }
  }

  function renderMetaStatus() {
    const card = el("#meta-catalog-card");
    const integration = menu.integration || {};
    card.classList.toggle("connected", integration.connected === true);
    card.classList.toggle("error", Boolean(integration.error));
    el("#meta-catalog-title").textContent = integration.connected ? (integration.name || "Catálogo Meta conectado") : "Conecte seu catálogo da Meta";
    el("#meta-catalog-detail").textContent = integration.connected ? `ID ${integration.catalogId} · ${integration.syncedProducts || 0} produto(s) sincronizado(s)` : (integration.error || "Autorize o catálogo uma vez; depois o Automichat mantém os produtos sincronizados.");
    el("#meta-catalog-status").textContent = integration.connected ? "Conectado" : (integration.error ? "Atenção" : "Pendente");
    el("#menu-sync").textContent = integration.connected ? "↻ Sincronizar Meta" : "Conectar catálogo da Meta";
    const visibility = el("#catalog-visibility-toggle");
    visibility.disabled = integration.connected !== true;
    visibility.checked = integration.connected === true && integration.catalogVisible !== false;
    el("#catalog-visibility-copy").textContent = visibility.checked ? "Catálogo e carrinho visíveis" : "Oculto no seu número do WhatsApp";
  }

  async function toggleCatalogVisibility(event) {
    const input = event.currentTarget;
    const visible = input.checked;
    input.disabled = true;
    try {
      await call("setFoodCatalogVisibility", {organizationId, visible});
      await loadMenu(true);
      feedback("#menu-feedback", visible ? "Catálogo exibido novamente no WhatsApp." : "Catálogo e carrinho ocultados do seu número do WhatsApp.");
    } catch (error) {
      input.checked = !visible;
      feedback("#menu-feedback", callableMessage(error), true);
    } finally { input.disabled = menu.integration?.connected !== true; }
  }

  function renderMenu() {
    el("#menu-products-count").textContent = String(menu.products.length);
    el("#menu-categories-count").textContent = String(menu.categories.length);
    const categoryOptions = '<option value="">Todas</option>' + menu.categories.filter((item) => item.active !== false).map((item) => `<option value="${escape(item.id)}">${escape(item.name)}</option>`).join("");
    const previous = el("#menu-category-filter").value;
    el("#menu-category-filter").innerHTML = categoryOptions; el("#menu-category-filter").value = previous;
    el("#menu-item-category").innerHTML = '<option value="">Selecione</option>' + menu.categories.filter((item) => item.active !== false).map((item) => `<option value="${escape(item.id)}">${escape(item.name)}</option>`).join("");
    const grid = el("#menu-grid");
    if (activeTab === "categories") {
      const cards = menu.categories.map((item) => `<article class="category-card"><div><strong>${escape(item.name)}</strong><small>${escape(item.description || "Sem descrição")} · ${menu.products.filter((product) => product.category_id === item.id).length} produto(s)</small></div><div class="category-card-actions"><button type="button" data-edit-category="${escape(item.id)}" aria-label="Editar categoria">✎</button><button type="button" data-delete-category="${escape(item.id)}" aria-label="Excluir categoria">⌫</button></div></article>`).join("");
      grid.innerHTML = cards || '<div class="food-empty"><span>▦</span><strong>Nenhuma categoria</strong><p>Crie categorias para organizar seus produtos.</p><button class="primary-action" type="button" data-empty-category>＋ Nova categoria</button></div>';
      bindMenuActions(); return;
    }
    const term = el("#menu-search").value.trim().toLocaleLowerCase("pt-BR");
    const category = el("#menu-category-filter").value;
    const status = el("#menu-status-filter").value;
    const products = menu.products.filter((item) => (!term || `${item.name} ${item.description || ""}`.toLocaleLowerCase("pt-BR").includes(term)) && (!category || item.category_id === category) && (status === "all" || (status === "active" && item.active !== false && item.availability === "in stock") || (status === "inactive" && (item.active === false || item.availability === "out of stock")) || (status === "error" && item.sync_status === "error")));
    grid.innerHTML = products.map((item) => `<article class="menu-card"><div class="menu-card-image">${item.image_url ? `<img src="${escape(item.image_url)}" alt="${escape(item.name)}">` : "🍽️"}<em>${escape(item.category_name || "Sem categoria")}</em></div><div class="menu-card-body"><h3>${escape(item.name)}</h3><p>${escape(item.description || "Sem descrição")}</p><div class="menu-card-meta"><strong>${money(item.price_cents)}</strong><span class="sync-state ${escape(item.sync_status || "pending")}">${item.sync_status === "synced" ? "✓ Meta" : item.sync_status === "feed" ? "✓ No feed" : item.sync_status === "error" ? "! Erro" : "↻ Pendente"}</span></div></div><div class="menu-card-actions"><button type="button" data-edit-product="${escape(item.id)}">Editar</button><button type="button" data-toggle-product="${escape(item.id)}">${item.active === false ? "Ativar" : "Pausar"}</button><button class="danger" type="button" data-delete-product="${escape(item.id)}" aria-label="Excluir">⌫</button></div></article>`).join("") || '<div class="food-empty"><span>🍕</span><strong>Nenhum produto encontrado</strong><p>Cadastre o primeiro item do seu cardápio.</p></div>';
    bindMenuActions();
  }

  function bindMenuActions() {
    document.querySelectorAll("[data-edit-product]").forEach((button) => button.onclick = () => openProduct(menu.products.find((item) => item.id === button.dataset.editProduct)));
    document.querySelectorAll("[data-toggle-product]").forEach((button) => button.onclick = () => toggleProduct(button.dataset.toggleProduct, button));
    document.querySelectorAll("[data-delete-product]").forEach((button) => button.onclick = () => deleteProduct(button.dataset.deleteProduct, button));
    document.querySelectorAll("[data-edit-category]").forEach((button) => button.onclick = () => openCategory(menu.categories.find((item) => item.id === button.dataset.editCategory)));
    document.querySelectorAll("[data-delete-category]").forEach((button) => button.onclick = () => deleteCategory(button.dataset.deleteCategory, button));
    document.querySelectorAll("[data-empty-category]").forEach((button) => button.onclick = () => openCategory());
  }

  function openProduct(item = null) {
    if (!menu.categories.some((category) => category.active !== false)) { openCategory(); feedback("#menu-category-feedback", "Crie uma categoria antes do primeiro produto."); return; }
    el("#menu-item-title").textContent = item ? "Editar produto" : "Novo produto";
    el("#menu-item-id").value = item?.id || ""; el("#menu-item-name").value = item?.name || ""; el("#menu-item-description").value = item?.description || ""; el("#menu-item-price").value = item ? (item.price_cents / 100).toFixed(2) : ""; el("#menu-item-category").value = item?.category_id || ""; el("#menu-item-retailer-id").value = item?.retailer_id || ""; el("#menu-item-availability").value = item?.availability || "in stock"; el("#menu-item-active").checked = item?.active !== false; el("#menu-item-featured").checked = item?.featured === true;
    imageData = ""; const preview = el("#menu-image-preview"); preview.hidden = !item?.image_url; preview.src = item?.image_url || ""; el("#menu-image-placeholder").hidden = Boolean(item?.image_url); el("#menu-image-remove").hidden = !item?.image_url;
    feedback("#menu-item-form-feedback", ""); el("#menu-item-dialog").showModal();
  }

  function openCategory(item = null) { el("#menu-category-title").textContent = item ? "Editar categoria" : "Nova categoria"; el("#menu-category-id").value = item?.id || ""; el("#menu-category-name").value = item?.name || ""; el("#menu-category-description").value = item?.description || ""; el("#menu-category-active").checked = item?.active !== false; feedback("#menu-category-feedback", ""); el("#menu-category-dialog").showModal(); }

  async function saveProduct(event) {
    event.preventDefault(); const button = event.submitter; button.disabled = true; feedback("#menu-item-form-feedback", "Salvando e sincronizando…");
    try { await call("saveFoodProduct", {organizationId, id: el("#menu-item-id").value, item: {name: el("#menu-item-name").value, description: el("#menu-item-description").value, price: Number(el("#menu-item-price").value), categoryId: el("#menu-item-category").value, retailerId: el("#menu-item-retailer-id").value, availability: el("#menu-item-availability").value, active: el("#menu-item-active").checked, featured: el("#menu-item-featured").checked, imageData}}); el("#menu-item-dialog").close(); await loadMenu(true); }
    catch (error) { feedback("#menu-item-form-feedback", callableMessage(error), true); } finally { button.disabled = false; }
  }

  async function saveCategory(event) { event.preventDefault(); const button = event.submitter; button.disabled = true; try { await call("saveFoodCategory", {organizationId, id: el("#menu-category-id").value, category: {name: el("#menu-category-name").value, description: el("#menu-category-description").value, active: el("#menu-category-active").checked}}); el("#menu-category-dialog").close(); await loadMenu(true); } catch (error) { feedback("#menu-category-feedback", callableMessage(error), true); } finally { button.disabled = false; } }
  async function toggleProduct(id, button) { const item = menu.products.find((product) => product.id === id); try { await withButtonBusy(button, async () => { await call("saveFoodProduct", {organizationId, id, item: {...item, price: item.price_cents / 100, categoryId: item.category_id, retailerId: item.retailer_id, imageUrl: item.image_url, active: item.active === false}}); await loadMenu(true); }, item.active === false ? "Ativando…" : "Pausando…"); } catch (error) { feedback("#menu-feedback", callableMessage(error), true); } }
  async function deleteProduct(id, button) { if (!confirm("Excluir este produto do Automichat e do catálogo da Meta?")) return; try { await withButtonBusy(button, async () => { await call("deleteFoodProduct", {organizationId, id}); await loadMenu(true); }, "…"); } catch (error) { feedback("#menu-feedback", callableMessage(error), true); } }
  async function deleteCategory(id, button) { if (!confirm("Excluir esta categoria? Ela precisa estar vazia.")) return; try { await withButtonBusy(button, async () => { await call("deleteFoodCategory", {organizationId, id}); await loadMenu(true); }, "…"); } catch (error) { feedback("#menu-feedback", callableMessage(error), true); } }
  async function syncMeta() {
    const button = el("#menu-sync");
    let catalogId = "";
    if (!menu.integration?.connected) {
      catalogId = String(prompt("Informe o ID numérico do catálogo da Meta. Você encontra esse número em Configurações da empresa → Fontes de dados → Catálogos.", "") || "").trim();
      if (!catalogId) return;
      if (!/^\d{5,30}$/.test(catalogId)) { feedback("#menu-feedback", "Informe somente os números do ID do catálogo.", true); return; }
      button.disabled = true; button.textContent = "Abrindo a Meta…";
      try {
        const authorization = await startCatalogAuthorization();
        feedback("#menu-feedback", "Validando a autorização do catálogo…");
        await call("connectFoodCatalog", {organizationId, catalogId, accessToken: authorization.accessToken});
        await loadMenu(true); feedback("#menu-feedback", "Catálogo conectado e produtos sincronizados.");
      } catch (error) { feedback("#menu-feedback", callableMessage(error), true); }
      finally { button.disabled = false; button.textContent = "Conectar catálogo da Meta"; }
      return;
    }
    button.disabled = true; button.textContent = "Sincronizando…"; feedback("#menu-feedback", "Validando catálogo e sincronizando produtos…");
    try { await call("syncFoodCatalog", {organizationId, catalogId}); await loadMenu(true); feedback("#menu-feedback", "Catálogo conectado e produtos sincronizados."); }
    catch (error) { feedback("#menu-feedback", callableMessage(error), true); }
    finally { button.disabled = false; button.textContent = "↻ Sincronizar Meta"; }
  }

  async function loadOrders() {
    if (!food) return;
    feedback("#orders-feedback", "");
    if (el("#orders-sync-label")) el("#orders-sync-label").textContent = "Atualizando…";
    try {
      const response = await call("listFoodOrders", {organizationId});
      const nextOrders = response.data.orders || [];
      const nextIds = new Set(nextOrders.map((order) => order.id));
      if (knownOrderIds) {
        const arrivals = nextOrders.filter((order) => !knownOrderIds.has(order.id) && ["awaiting_confirmation","received"].includes(order.status));
        if (arrivals.length) {
          const latest = arrivals[0];
          feedback("#orders-feedback", `${arrivals.length === 1 ? "Novo pedido recebido" : `${arrivals.length} novos pedidos recebidos`} · ${latest.customer_name || "Cliente"} · ${money(latest.total_cents)}`);
          document.title = `(${arrivals.length}) Novo pedido · Automichat`;
          if (window.Notification?.permission === "granted") new Notification("Novo pedido no Automichat", {body:`${latest.customer_name || "Cliente"} · ${money(latest.total_cents)}`,tag:`order-${latest.id}`});
          try { const AudioContext = window.AudioContext || window.webkitAudioContext; const context = new AudioContext(); const oscillator = context.createOscillator(); const gain = context.createGain(); oscillator.frequency.value = 880; gain.gain.value = .08; oscillator.connect(gain); gain.connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + .18); } catch {}
        }
      }
      knownOrderIds = nextIds;
      orders = nextOrders;
      renderOrders();
      if (el("#orders-sync-label")) el("#orders-sync-label").textContent = `Atualizado às ${new Date().toLocaleTimeString("pt-BR", {hour:"2-digit",minute:"2-digit"})}`;
    } catch (error) {
      feedback("#orders-feedback", callableMessage(error), true);
      if (el("#orders-sync-label")) el("#orders-sync-label").textContent = "Não foi possível atualizar";
    }
  }
  function renderOrders() {
    const date = el("#orders-date").value || orderDayKey();
    const today = orderDayKey();
    const selectedDate = dateFromKey(date);
    const isToday = date === today;
    const dayText = new Intl.DateTimeFormat("pt-BR", {timeZone:"America/Sao_Paulo",weekday:"long",day:"2-digit",month:"long",year:"numeric"}).format(selectedDate);
    el("#orders-day-label").textContent = `${isToday ? "Hoje" : "Exibindo"}, ${dayText}. Acompanhe cada etapa sem perder pedidos de vista.`;
    el("#view-orders .orders-heading h2").textContent = isToday ? "Pedidos de hoje" : `Pedidos de ${new Intl.DateTimeFormat("pt-BR", {day:"2-digit",month:"2-digit"}).format(selectedDate)}`;
    el("#orders-today").disabled = isToday;

    const dayOrders = orders.filter((order) => isOperationalOrder(order) && orderDate(order) && orderDayKey(orderDate(order)) === date);
    const count = (statuses) => dayOrders.filter((order) => statuses.includes(order.status)).length;
    el("#orders-new").textContent = String(count(["awaiting_data","awaiting_confirmation","awaiting_payment","received"]));
    el("#orders-preparing").textContent = String(count(["confirmed","preparing"]));
    el("#orders-ready").textContent = String(count(["ready","out_for_delivery"]));
    el("#orders-completed").textContent = String(count(["completed"]));
    el("#orders-revenue").textContent = money(dayOrders.filter((order) => order.status === "completed" || order.payment?.status === "paid").reduce((sum, order) => sum + Number(order.total_cents || 0), 0));
    document.querySelectorAll("[data-orders-quick]").forEach((button) => button.classList.toggle("active", button.dataset.ordersQuick === activeOrderQuickFilter));
    if (food) { el("#metric-today").textContent = String(dayOrders.length); el("#metric-next").textContent = String(count(["confirmed","preparing"])); el("#metric-next-name").textContent = "pedidos em preparo"; el("#metric-closed").textContent = String(count(["completed"])); }

    const term = el("#orders-search").value.trim().toLocaleLowerCase("pt-BR");
    const status = el("#orders-status").value;
    const fulfillment = el("#orders-fulfillment").value;
    const payment = el("#orders-payment").value;
    const filtered = dayOrders.filter((order) => (!status || order.status === status) && orderMatchesQuickFilter(order) && (!fulfillment || order.fulfillment_type === fulfillment) && (!payment || paymentCategory(order) === payment) && (!term || `${order.number} ${order.customer_name} ${order.customer_phone} ${(order.items || []).map((item) => item.name).join(" ")}`.toLocaleLowerCase("pt-BR").includes(term)));
    const quickTitles = {all:"Todos os pedidos",new:"Pedidos que precisam de atenção",preparing:"Pedidos em preparo",ready:"Pedidos prontos",completed:"Pedidos concluídos"};
    el("#orders-result-title").textContent = status ? orderLabels[status] || status : quickTitles[activeOrderQuickFilter];
    el("#orders-result-count").textContent = `${filtered.length} ${filtered.length === 1 ? "pedido" : "pedidos"}`;

    const fulfillmentLabels = {delivery:"Entrega",pickup:"Retirada",dine_in:"No local",pending:"A definir"};
    const groupFor = (order) => ["awaiting_data","awaiting_confirmation","awaiting_payment","received"].includes(order.status) ? "attention" : ["confirmed","preparing","ready","out_for_delivery"].includes(order.status) ? "progress" : "finished";
    const card = (order) => {
      const created = orderDate(order);
      const itemCount = (order.items || []).reduce((sum,item) => sum + Number(item.quantity || 0),0);
      const items = (order.items || []).map((item) => `${item.quantity}× ${item.name}`).join(", ") || "Itens ainda não informados";
      const paymentState = paymentDisplay(order);
      return `<article class="order-card status-${escape(order.status)}" data-order="${escape(order.id)}" tabindex="0" role="button" aria-label="Abrir pedido ${escape(order.number || order.id)}">
        <div class="order-card-time"><strong>${created ? created.toLocaleTimeString("pt-BR", {timeZone:"America/Sao_Paulo",hour:"2-digit",minute:"2-digit"}) : "—"}</strong><span>#${escape(String(order.number || order.id).slice(-4))}</span></div>
        <div class="order-customer"><strong>${escape(order.customer_name || "Cliente do WhatsApp")}</strong><small>${escape(order.customer_phone || "Telefone não informado")}</small><div class="order-card-tags"><span>${escape(fulfillmentLabels[order.fulfillment_type])}</span><span class="payment-${escape(paymentState.className)}">${escape(paymentState.label)}</span></div></div>
        <div class="order-items"><strong>${itemCount} ${itemCount === 1 ? "item" : "itens"}</strong><small>${escape(items)}</small></div>
        <div class="order-card-result"><strong class="order-total">${money(order.total_cents, order.currency || "BRL")}</strong><span class="order-status">${escape(orderLabels[order.status] || order.status)}</span></div>
        <span class="order-open" aria-hidden="true">Ver detalhes <b>→</b></span>
      </article>`;
    };
    const groups = [
      {key:"attention",title:"Precisa de atenção",copy:"Pedidos novos ou aguardando uma ação",open:true},
      {key:"progress",title:"Em andamento",copy:"Pedidos confirmados, em preparo ou a caminho",open:true},
      {key:"finished",title:"Finalizados",copy:"Pedidos concluídos ou cancelados",open:activeOrderQuickFilter === "completed" || status === "cancelled"}
    ];
    el("#orders-list").innerHTML = groups.map((group) => {
      const entries = filtered.filter((order) => groupFor(order) === group.key);
      if (!entries.length) return "";
      return `<details class="orders-group ${group.key}" ${group.open ? "open" : ""}><summary><div><strong>${group.title}</strong><span>${group.copy}</span></div><em>${entries.length}</em><i aria-hidden="true"></i></summary><div class="orders-group-content">${entries.map(card).join("")}</div></details>`;
    }).join("") || '<div class="food-empty"><span>🧾</span><strong>Nenhum pedido neste dia</strong><p>Ajuste os filtros ou escolha outra data para consultar o histórico.</p></div>';
    document.querySelectorAll("#orders-list [data-order]").forEach((node) => {
      node.onclick = () => openOrder(orders.find((order) => order.id === node.dataset.order));
      node.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); node.click(); } };
    });
    renderDeliveries();
  }
  function renderDeliveries() {
    const deliveryOrders = orders.filter((order) => order.fulfillment_type === "delivery");
    const groups = {waiting:deliveryOrders.filter((order) => order.status === "ready"),route:deliveryOrders.filter((order) => order.status === "out_for_delivery"),done:deliveryOrders.filter((order) => order.status === "completed")};
    const empty = (icon,title,text) => `<div class="delivery-empty"><div><span>${icon}</span><strong>${title}</strong><p>${text}</p></div></div>`;
    const card = (order, action, label) => `<article class="delivery-card"><header><strong>#${escape(String(order.number || order.id).slice(-4))} · ${escape(order.customer_name || "Cliente")}</strong><span>${money(order.total_cents)}</span></header><small>${escape(order.address?.line || "Endereço não informado")}${order.address?.reference ? ` · ${escape(order.address.reference)}` : ""}</small>${order.delivery?.courier_name ? `<div class="delivery-meta"><span>${escape(order.delivery.courier_name)}</span><span>${Number(order.delivery.eta_minutes || 0)} min</span></div>` : ""}${action ? `<button type="button" data-delivery-action="${action}" data-delivery-id="${escape(order.id)}">${label}</button>` : ""}</article>`;
    el("#delivery-waiting-count").textContent = groups.waiting.length; el("#delivery-route-count").textContent = groups.route.length; el("#delivery-done-count").textContent = groups.done.length;
    el("#delivery-waiting-list").className = "delivery-list"; el("#delivery-route-list").className = "delivery-list"; el("#delivery-done-list").className = "delivery-list";
    el("#delivery-waiting-list").innerHTML = groups.waiting.map((order) => card(order,"dispatch","Despachar pedido")).join("") || empty("⌛","Nenhum pedido aguardando","Pedidos prontos para entrega aparecerão aqui.");
    el("#delivery-route-list").innerHTML = groups.route.map((order) => card(order,"complete","Confirmar entrega")).join("") || empty("➜","Nenhuma entrega em rota","Ao despachar, você acompanhará o pedido nesta coluna.");
    el("#delivery-done-list").innerHTML = groups.done.slice(0,20).map((order) => card(order,"","Concluído")).join("") || empty("✓","Nenhuma entrega finalizada","As entregas concluídas ficarão registradas aqui.");
    document.querySelectorAll("[data-delivery-action]").forEach((button) => button.onclick = () => updateDelivery(button));
  }
  async function updateDelivery(button) {
    await withButtonBusy(button, async () => {
      const payload = {organizationId,id:button.dataset.deliveryId,status:button.dataset.deliveryAction === "dispatch" ? "out_for_delivery" : "completed"};
      if (button.dataset.deliveryAction === "dispatch") { payload.courierName = String(prompt("Nome do entregador:", "Motoboy") || "").trim(); if (!payload.courierName) return; payload.etaMinutes = Number(prompt("Previsão de entrega em minutos:", "20") || 0); if (!payload.etaMinutes) return; }
      try { await call("updateFoodOrderStatus",payload); await loadOrders(); } catch (error) { alert(callableMessage(error)); }
    }, button.dataset.deliveryAction === "dispatch" ? "Despachando…" : "Concluindo…");
  }
  function openOrder(order) {
    if (!order) return;
    const labels = {awaiting_data:"Aguardando cliente",awaiting_confirmation:"Aguardando confirmação",awaiting_payment:"Aguardando pagamento",received:"Aguardando confirmação",confirmed:"Confirmado",preparing:"Em preparo",ready:"Pronto",out_for_delivery:"Em entrega",completed:"Concluído",cancelled:"Cancelado"};
    const actionLabels = {confirmed:"Aceitar pedido",preparing:"Iniciar preparo",ready:"Marcar como pronto",out_for_delivery:"Saiu para entrega",completed:"Concluir pedido",cancelled:"Cancelar pedido"};
    const fulfillment = {delivery:"Entrega",pickup:"Retirada",dine_in:"Consumo no local",pending:"Aguardando definição"}[order.fulfillment_type] || order.fulfillment_type;
    const payment = {pix:"Pix online",card_online:"Cartão online · crédito 1x ou débito",cash:"Dinheiro",card:`Cartão ${order.payment?.card_type === "debit" ? "de débito" : order.payment?.card_type === "credit" ? "de crédito" : ""}`.trim(),pending:"Aguardando definição"}[order.payment?.method] || order.payment?.method || "Aguardando definição";
    const paymentStatus = ["cash","card"].includes(order.payment?.method) ? "No recebimento" : ({paid:"Pago",pending:"Pix pendente",failed:"Falha na cobrança"}[order.payment?.status] || "Pix pendente");
    let actions = ({awaiting_confirmation:["confirmed","cancelled"],received:["confirmed","cancelled"],awaiting_payment:["cancelled"],confirmed:["preparing","cancelled"],preparing:["ready","cancelled"],ready:["out_for_delivery","completed","cancelled"],out_for_delivery:["completed","cancelled"]})[order.status] || [];
    if (order.status === "confirmed" && ["pix","card_online"].includes(order.payment?.method) && order.payment?.status !== "paid") actions = actions.filter((status) => status !== "preparing");
    if (order.status === "ready" && order.fulfillment_type !== "delivery") actions = actions.filter((status) => status !== "out_for_delivery");
    const address = order.fulfillment_type === "delivery" ? `${order.address?.line || "Endereço não informado"}${order.address?.reference ? ` · ${order.address.reference}` : ""}` : "Não se aplica";
    const history = (order.status_history || []).slice().reverse().map((item) => `<div class="order-detail-item"><span>${escape(labels[item.status] || item.status)}</span><strong>${item.at ? new Date(item.at).toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo"}) : "—"}</strong></div>`).join("");
    el("#order-detail").innerHTML = `<p class="dialog-eyebrow">PEDIDO #${escape(String(order.number || order.id).slice(-4))}</p><h2>${escape(order.customer_name || "Cliente do WhatsApp")}</h2><p>${escape(order.customer_phone || "")}</p><div class="order-detail-list">${(order.items || []).map((item) => `<div class="order-detail-item"><span>${item.quantity}× ${escape(item.name)}</span><strong>${money(item.total_cents, order.currency || "BRL")}</strong></div>`).join("")}<div class="order-detail-item"><strong>Total</strong><strong>${money(order.total_cents, order.currency || "BRL")}</strong></div></div><div class="order-detail-list"><div class="order-detail-item"><span>Recebimento</span><strong>${escape(fulfillment)}</strong></div><div class="order-detail-item"><span>Endereço</span><strong>${escape(address)}</strong></div><div class="order-detail-item"><span>Pagamento</span><strong>${escape(payment)} <span class="payment-state ${order.payment?.status === "paid" ? "paid" : ""}">${escape(paymentStatus)}</span></strong></div>${order.payment?.change_for_cents ? `<div class="order-detail-item"><span>Troco para</span><strong>${money(order.payment.change_for_cents)}</strong></div>` : ""}<div class="order-detail-item"><span>Observações</span><strong>${escape(order.observations || "Nenhuma")}</strong></div></div><p>Status atual: <strong>${labels[order.status] || order.status}</strong></p>${history ? `<p class="dialog-eyebrow">HISTÓRICO</p><div class="order-detail-list">${history}</div>` : ""}<div class="order-actions">${actions.map((status) => `<button type="button" data-order-status="${status}" data-order-id="${escape(order.id)}">${actionLabels[status] || labels[status]}</button>`).join("")}${order.payment?.method === "pix" && order.payment?.status === "failed" ? `<button type="button" data-retry-pix="${escape(order.id)}">Gerar Pix novamente</button>` : ""}</div>`;
    document.querySelectorAll("[data-order-status]").forEach((button) => button.onclick = () => withButtonBusy(button, async () => { try { const payload = {organizationId, id: button.dataset.orderId, status: button.dataset.orderStatus}; if (payload.status === "out_for_delivery") { payload.courierName = String(prompt("Nome do entregador:", "Motoboy") || "").trim(); if (!payload.courierName) return; payload.etaMinutes = Number(prompt("Previsão de entrega em minutos:", "20") || 0); if (!payload.etaMinutes) return; } const result = await call("updateFoodOrderStatus", payload); el("#order-dialog").close(); await loadOrders(); if (result.data?.payment?.status === "failed") alert(`Pedido confirmado, mas o Pix não foi gerado: ${result.data.payment.error}`); } catch (error) { alert(callableMessage(error)); } }, "Atualizando…"));
    document.querySelectorAll("[data-retry-pix]").forEach((button) => button.onclick = () => withButtonBusy(button, async () => { try { await call("retryFoodOrderPix",{organizationId,id:button.dataset.retryPix}); el("#order-dialog").close(); await loadOrders(); } catch (error) { alert(callableMessage(error)); } }, "Gerando Pix…"));
    el("#order-dialog").showModal();
  }

  function bind() {
    document.addEventListener("click", async (event) => {
      const button = event.target.closest('[data-order-status="cancelled"]');
      if (!button) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const reason = prompt("Informe o motivo do cancelamento:");
      if (!reason?.trim()) return;
      await withButtonBusy(button, async () => { try { await call("updateFoodOrderStatus", {organizationId, id: button.dataset.orderId, status: "cancelled", reason}); el("#order-dialog").close(); await loadOrders(); } catch (error) { alert(callableMessage(error)); } }, "Cancelando…");
    }, true);
    el("#new-menu-item").onclick = () => activeTab === "categories" ? openCategory() : openProduct(); el("#menu-sync").onclick = syncMeta; el("#catalog-visibility-toggle").onchange = toggleCatalogVisibility; el("#orders-refresh").onclick = (event) => withButtonBusy(event.currentTarget, loadOrders, "Atualizando…"); el("#orders-alerts").onclick = async (event) => { if (!window.Notification) { event.currentTarget.textContent = "Alertas indisponíveis"; return; } const permission = await Notification.requestPermission(); event.currentTarget.textContent = permission === "granted" ? "🔔 Alertas ativos" : "🔕 Alertas bloqueados"; };
    document.querySelectorAll("[data-menu-tab]").forEach((button) => button.onclick = () => { activeTab = button.dataset.menuTab; document.querySelectorAll("[data-menu-tab]").forEach((item) => item.classList.toggle("active", item === button)); el("#new-menu-item").textContent = activeTab === "categories" ? "＋ Nova categoria" : "＋ Novo produto"; renderMenu(); });
    ["#menu-search","#menu-category-filter","#menu-status-filter"].forEach((selector) => el(selector).addEventListener(selector === "#menu-search" ? "input" : "change", renderMenu));
    ["#orders-search","#orders-fulfillment","#orders-payment"].forEach((selector) => el(selector).addEventListener(selector === "#orders-search" ? "input" : "change", renderOrders));
    el("#orders-status").addEventListener("change", () => { activeOrderQuickFilter = "all"; renderOrders(); });
    el("#orders-date").addEventListener("change", () => { activeOrderQuickFilter = "all"; el("#orders-status").value = ""; renderOrders(); });
    document.querySelectorAll("[data-orders-quick]").forEach((button) => button.onclick = () => { activeOrderQuickFilter = button.dataset.ordersQuick; el("#orders-status").value = ""; renderOrders(); });
    const moveOrderDay = (days) => { const current = dateFromKey(el("#orders-date").value || orderDayKey()); current.setUTCDate(current.getUTCDate() + days); el("#orders-date").value = orderDayKey(current); activeOrderQuickFilter = "all"; el("#orders-status").value = ""; renderOrders(); };
    el("#orders-prev-day").onclick = () => moveOrderDay(-1);
    el("#orders-next-day").onclick = () => moveOrderDay(1);
    el("#orders-today").onclick = () => { el("#orders-date").value = orderDayKey(); activeOrderQuickFilter = "all"; el("#orders-status").value = ""; renderOrders(); };
    el("#menu-item-form").onsubmit = saveProduct; el("#menu-category-form").onsubmit = saveCategory; el("#menu-item-close").onclick = () => el("#menu-item-dialog").close(); el("#menu-category-close").onclick = () => el("#menu-category-dialog").close(); el("#order-close").onclick = () => el("#order-dialog").close();
    el("#menu-item-image").onchange = (event) => { const file = event.target.files?.[0]; if (!file) return; if (file.size > 5 * 1024 * 1024) { feedback("#menu-item-form-feedback", "A imagem deve ter no máximo 5 MB.", true); return; } const reader = new FileReader(); reader.onload = () => { imageData = String(reader.result || ""); el("#menu-image-preview").src = imageData; el("#menu-image-preview").hidden = false; el("#menu-image-placeholder").hidden = true; el("#menu-image-remove").hidden = false; }; reader.readAsDataURL(file); };
    el("#menu-image-remove").onclick = () => { imageData = "__remove__"; el("#menu-image-preview").src = ""; el("#menu-image-preview").hidden = true; el("#menu-image-placeholder").hidden = false; el("#menu-image-remove").hidden = true; };
  }
  bind();
  return { initialize(id, segment, enabledScreens = []) { organizationId = id; return configure(segment, enabledScreens); }, onView(name) { if (name === "menu") loadMenu(); if (name === "orders") { el("#orders-date").value = orderDayKey(); activeOrderQuickFilter = "all"; el("#orders-status").value = ""; loadOrders(); if (!orderPolling) orderPolling = setInterval(()=>{ if (location.hash === "#orders") loadOrders(); },20000); } if (name === "deliveries") loadOrders(); } };
}
