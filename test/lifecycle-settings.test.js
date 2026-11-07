import test from "node:test";
import assert from "node:assert/strict";
import { appointmentAutomationApplies, visibleAutomationGroups } from "../js/lifecycle-settings.js";

const automations = [
  { id: "waitlist", group: "appointments" },
  { id: "post_appointment", group: "appointments" },
  { id: "customer_recovery", group: "relationship" },
  { id: "quote_followup", group: "relationship" },
  { id: "enrollment_followup", group: "relationship" },
  { id: "visit_followup", group: "relationship" },
  { id: "post_order", group: "orders" },
];

test("segmento de serviços não recebe cards ou grupo de pedidos", () => {
  const groups = visibleAutomationGroups(automations, ["appointments", "services", "employees"]);
  assert.deepEqual(groups.map(item => item.group), ["appointments", "relationship"]);
  assert.equal(groups.some(item => item.items.some(automation => automation.id === "post_order")), false);
});

test("segmento de alimentação não recebe grupo vazio de agendamentos", () => {
  const groups = visibleAutomationGroups(automations, ["orders", "deliveries", "menu"]);
  assert.deepEqual(groups.map(item => item.group), ["relationship", "orders"]);
  assert.equal(groups.some(item => item.items.some(automation => automation.id === "post_appointment")), false);
  assert.equal(appointmentAutomationApplies(["orders", "deliveries", "menu", "automations"]), false);
});

test("confirmações de agendamento aparecem somente em segmentos com agenda", () => {
  assert.equal(appointmentAutomationApplies(["appointments", "payments", "automations"]), true);
  assert.equal(appointmentAutomationApplies(["orders", "menu", "payments", "automations"]), false);
});

test("educação e imobiliário recebem somente o acompanhamento compatível", () => {
  const education = visibleAutomationGroups(automations, { screens:["automations"], modules:["enrollment","quotes","customer_recovery"] });
  const realEstate = visibleAutomationGroups(automations, { screens:["automations"], modules:["visits","quotes","customer_recovery"] });
  assert.equal(education.flatMap(group=>group.items).some(item=>item.id==="enrollment_followup"),true);
  assert.equal(education.flatMap(group=>group.items).some(item=>item.id==="visit_followup"),false);
  assert.equal(realEstate.flatMap(group=>group.items).some(item=>item.id==="visit_followup"),true);
  assert.equal(realEstate.flatMap(group=>group.items).some(item=>item.id==="enrollment_followup"),false);
});
