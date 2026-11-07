export const PLAN_FEATURES = Object.freeze([
  { id: "customer_recovery", icon: "🔁", label: "Recuperação de clientes que sumiram" },
  { id: "appointment_confirmation", icon: "✅", label: "Confirmação automática de agendamentos" },
  { id: "waitlist", icon: "⏳", label: "Lista de espera de horários" },
  { id: "quote_followup", icon: "📨", label: "Follow-up automático de orçamentos" },
  { id: "mini_crm", icon: "🗂️", label: "Mini CRM dentro do software" },
  { id: "post_sale_review", icon: "⭐", label: "Pós-venda e pedido de avaliação" },
]);

export function planFeatureIds(plan) {
  if (Array.isArray(plan?.features)) return plan.features.filter(id => PLAN_FEATURES.some(item => item.id === id));
  const name = String(plan?.name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (name.includes("negocio")) return PLAN_FEATURES.map(item => item.id);
  if (name.includes("profissional")) return ["customer_recovery", "appointment_confirmation", "waitlist", "quote_followup", "mini_crm", "post_sale_review"];
  return ["appointment_confirmation", "mini_crm", "post_sale_review"];
}

export function planFeatureItems(plan) {
  const selected = new Set(planFeatureIds(plan));
  return PLAN_FEATURES.filter(item => selected.has(item.id));
}

export function createPlanFeatureListItem(item, className = "") {
  const listItem = document.createElement("li");
  listItem.className = className;
  const label = document.createElement("span");
  label.textContent = item.label;
  listItem.append(label);
  if (item.id !== "mini_crm") return listItem;
  listItem.classList.add("plan-feature-with-info");
  const info = document.createElement("button");
  info.type = "button";
  info.className = "plan-feature-info-button";
  info.textContent = "i";
  info.setAttribute("aria-label", "O que é o Mini CRM?");
  info.setAttribute("aria-expanded", "false");
  const tooltip = document.createElement("span");
  tooltip.className = "plan-feature-info-tip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.textContent = "É uma ficha organizada para cada cliente, com nome, telefone, histórico de conversas, último atendimento e etapa comercial. Ajuda a acompanhar contatos sem depender da memória ou procurar mensagens antigas.";
  info.addEventListener("click", event => {
    event.stopPropagation();
    const open = !listItem.classList.contains("info-open");
    document.querySelectorAll(".plan-feature-with-info.info-open").forEach(element => { element.classList.remove("info-open"); element.querySelector("button")?.setAttribute("aria-expanded", "false"); });
    listItem.classList.toggle("info-open", open);
    info.setAttribute("aria-expanded", String(open));
  });
  listItem.append(info, tooltip);
  return listItem;
}
