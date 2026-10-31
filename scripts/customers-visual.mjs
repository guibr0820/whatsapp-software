import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/User/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = process.cwd();
const edit = '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>';
const remove = '<svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>';
const customers = [
  ['Mariana Souza','mariana@exemplo.com','MS','(11) 99999-0000','30 out., 14:30','Manicure','active','Ativo'],
  ['Ana Beatriz','Chegou pelo WhatsApp','AB','(11) 98888-1234','Nenhum agendamento','0 no histórico','new','Novo'],
  ['Carla Ferreira','Cliente recorrente','CF','(11) 97777-4321','02 nov., 09:00','Pedicure','active','Ativo'],
  ['Juliana Martins','juliana@exemplo.com','JM','(11) 96666-9876','Nenhum agendamento','3 no histórico','inactive','Inativo'],
];
const rows = customers.map(([name,sub,initials,phone,next,detail,status,label]) => `<article class="customer-list-item"><div class="customer-main"><span class="customer-list-avatar">${initials}</span><button><strong>${name}</strong><small>${sub}</small></button></div><span>${phone}</span><div class="customer-next"><strong>${next}</strong><small>${detail}</small></div><span class="customer-status ${status}">${label}</span><div class="customer-actions"><button class="customer-icon-action">${edit}</button><button class="customer-icon-action delete">${remove}</button></div></article>`).join('');
const boot = `document.querySelector('#dashboard-loading').hidden=true;document.querySelector('#app-shell').hidden=false;document.querySelectorAll('.dashboard-view').forEach(n=>n.classList.toggle('active',n.id==='view-contacts'));document.querySelectorAll('.nav-item[data-view]').forEach(n=>n.classList.toggle('active',n.dataset.view==='contacts'));document.querySelector('#page-title').textContent='Clientes';document.querySelector('#profile-name').textContent='Guilherme da Silva';document.querySelector('#profile-email').textContent='guilherme@exemplo.com';document.querySelector('#sidebar-plan').textContent='Crescimento';document.querySelector('#customers-total').textContent='24';document.querySelector('#customers-scheduled').textContent='8';document.querySelector('#customers-recurring').textContent='11';document.querySelector('#customers-new').textContent='5';document.querySelector('#customers-list').innerHTML='<div class="customers-list-head"><span>Cliente</span><span>WhatsApp</span><span>Próximo agendamento</span><span>Situação</span><span>Ações</span></div>${rows}';window.fixtureReady=true;`;

const server = http.createServer(async (request, response) => {
  try {
    const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (name === '/fixture.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(boot); return; }
    const file = path.resolve(root, `.${name === '/' ? '/dashboard.html' : name}`);
    if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    let content = await fs.readFile(file);
    if (file.endsWith('dashboard.html')) content = Buffer.from(content.toString().replace('<script type="module" src="./js/dashboard.js"></script>', '<script src="/fixture.js"></script>'));
    response.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html');
    response.end(content);
  } catch { response.writeHead(404).end(); }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/dashboard.html`);
  await page.waitForFunction(() => window.fixtureReady);
  await fs.mkdir(path.join(root, 'artifacts', 'customers'), { recursive: true });
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 960 });
    const dimensions = await page.locator('#view-contacts').evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }));
    if (dimensions.scroll > dimensions.width + 1) throw new Error(`Rolagem horizontal em ${width}px: ${JSON.stringify(dimensions)}`);
    const editCount = await page.locator('.customer-icon-action:not(.delete)').count();
    const deleteCount = await page.locator('.customer-icon-action.delete').count();
    if (editCount !== 4 || deleteCount !== 4) throw new Error('Ações de editar/excluir não foram exibidas em todos os clientes.');
    await page.screenshot({ path: path.join(root, 'artifacts', 'customers', `customers-${width}.png`), fullPage: true });
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Clientes: layout, ícones e ausência de rolagem horizontal validados em 5 larguras.');
} finally {
  if (browser) await browser.close();
  server.close();
}
