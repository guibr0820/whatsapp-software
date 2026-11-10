// Shared validation for pet records; persistence and access control live in the backend.
const SPECIES = new Set(["dog", "cat", "other"]);
const SIZES = new Set(["small", "medium", "large", "giant"]);
const SEXES = new Set(["male", "female", "unknown"]);

function normalizePet(input = {}) {
  const text = (value, max) => String(value || "").trim().slice(0, max);
  const name = text(input.name, 80);
  const tutorPhone = text(input.tutorPhone, 20).replace(/\D/g, "");
  const species = text(input.species, 20);
  const size = text(input.size, 20);
  const sex = text(input.sex || "unknown", 20);
  if (name.length < 2) throw new Error("Informe o nome do pet.");
  if (tutorPhone.length < 10 || tutorPhone.length > 15) throw new Error("Informe um telefone válido do tutor.");
  if (!SPECIES.has(species)) throw new Error("Informe uma espécie válida.");
  if (!SIZES.has(size)) throw new Error("Informe um porte válido.");
  if (!SEXES.has(sex)) throw new Error("Informe o sexo do pet.");
  const birthDate = text(input.birthDate, 10);
  if (birthDate && (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate) || new Date(`${birthDate}T12:00:00Z`).toISOString().slice(0, 10) !== birthDate)) throw new Error("Informe uma data de nascimento válida.");
  const returnDays = Number(input.returnDays || 0);
  if (!Number.isInteger(returnDays) || returnDays < 0 || returnDays > 365) throw new Error("Informe um prazo de retorno válido.");
  return {
    name, tutor_phone: tutorPhone, species, size, sex,
    breed: text(input.breed, 80), coat: text(input.coat, 80), birth_date: birthDate,
    allergies: text(input.allergies, 300), behavior: text(input.behavior, 300), special_care: text(input.specialCare, 500),
    return_days: returnDays, notes: text(input.notes, 500), active: input.active !== false,
  };
}

module.exports = { normalizePet };
