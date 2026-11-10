const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizePet } = require("../src/pet-model");

test("valida e normaliza os dados do pet e telefone do tutor", () => {
  const pet = normalizePet({ name: " Mel ", tutorPhone: "+55 (11) 99999-9999", species: "dog", sex: "female", size: "small", returnDays: 30 });
  assert.equal(pet.name, "Mel");
  assert.equal(pet.tutor_phone, "5511999999999");
  assert.equal(pet.sex, "female");
  assert.equal(pet.return_days, 30);
  assert.throws(() => normalizePet({ name: "Mel", tutorPhone: "1", species: "dog", size: "small" }));
  assert.throws(() => normalizePet({ name: "Mel", tutorPhone: "5511999999999", species: "dog", size: "invalid" }));
  assert.throws(() => normalizePet({ name: "Mel", tutorPhone: "5511999999999", species: "dog", size: "small", sex: "invalid" }));
});
