const buttonState = new WeakMap();

export function setButtonBusy(button, busy, label = "") {
  if (!(button instanceof HTMLButtonElement)) return;
  if (busy) {
    if (button.dataset.busy === "true") return;
    buttonState.set(button, {html: button.innerHTML, disabled: button.disabled});
    button.dataset.busy = "true";
    button.setAttribute("aria-busy", "true");
    button.disabled = true;
    if (label) button.textContent = label;
    return;
  }
  const previous = buttonState.get(button);
  if (previous) {
    button.innerHTML = previous.html;
    button.disabled = previous.disabled;
    buttonState.delete(button);
  } else {
    button.disabled = false;
  }
  delete button.dataset.busy;
  button.removeAttribute("aria-busy");
}

export async function withButtonBusy(button, task, label = "") {
  setButtonBusy(button, true, label);
  try { return await task(); }
  finally { setButtonBusy(button, false); }
}

export function installButtonProgress(root = document) {
  if (root.documentElement?.dataset.buttonProgress === "ready") return;
  if (root.documentElement) root.documentElement.dataset.buttonProgress = "ready";
  root.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled || button.dataset.noProgress !== undefined) return;
    queueMicrotask(() => {
      if (button.disabled && button.dataset.busy !== "true") {
        button.dataset.autoBusy = "true";
        button.setAttribute("aria-busy", "true");
      }
    });
  }, true);
  new MutationObserver((entries) => {
    entries.forEach(({target}) => {
      if (!(target instanceof HTMLButtonElement) || target.disabled || target.dataset.autoBusy !== "true") return;
      delete target.dataset.autoBusy;
      target.removeAttribute("aria-busy");
    });
  }).observe(root.documentElement || root, {subtree: true, attributes: true, attributeFilter: ["disabled"]});
}
