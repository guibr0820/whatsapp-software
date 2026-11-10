const decimal = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function currencyValue(value) {
  const text = String(value ?? '').trim();
  return text.includes(',') ? Number(text.replace(/\./g, '').replace(',', '.')) : Number(text);
}
export function setCurrencyValue(input, value) {
  input.value = decimal.format(Number(value) || 0);
}
export function installCurrencyInput(input) {
  input.type = 'text';
  input.inputMode = 'numeric';
  input.removeAttribute('step');
  input.removeAttribute('min');
  input.removeAttribute('max');
  setCurrencyValue(input, currencyValue(input.value));
  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '').slice(0, 10);
    setCurrencyValue(input, Number(digits || 0) / 100);
    input.setSelectionRange(input.value.length, input.value.length);
  });
  input.addEventListener('focus', () => input.select());
}
