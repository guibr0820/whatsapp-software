import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/User/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = process.cwd();
const fixture = `
document.querySelector('[data-current-year]').textContent = new Date().getFullYear();
document.querySelector('#plans-list').innerHTML = ['Crescimento','Profissional','Negócios'].map((name,index) => '<article class="plan '+(index===1?'popular':'')+'"><div class="kicker">Plano Automichat</div><h3>'+name+'</h3><p>Automação para acompanhar sua rotina.</p><div class="price">R$ '+['47,90','97,90','197,90'][index]+'<small>/mês</small></div><a class="plan-action" href="#">Começar teste grátis</a></article>').join('');
window.fixtureReady = true;
`;

const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/fixture.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(fixture);
      return;
    }
    const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(`${root}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    let content = await fs.readFile(file);
    if (file.endsWith('index.html')) {
      content = Buffer.from(content.toString().replace('<script type="module" src="./js/home.js"></script>', '<script type="module" src="/fixture.js"></script>'));
    }
    response.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html');
    response.end(content);
  } catch {
    response.writeHead(404).end();
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({headless: true, channel: 'msedge'});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await fs.mkdir(path.join(root, 'artifacts', 'home'), {recursive: true});
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.fixtureReady);

  if (await page.locator('.showcase .pwrap').count() !== 3) throw new Error('A vitrine precisa ter exatamente três exemplos.');
  const text = await page.locator('body').innerText();
  if (!text.includes('Manicure') || !text.includes('Barbearia') || !text.includes('Delivery')) throw new Error('Exemplos esperados não encontrados.');
  if (/clicknex|clickchat/i.test(text)) throw new Error('Marca antiga ainda visível.');
  if (/Responda 1|\n1\n/.test(text)) throw new Error('Fluxo antigo de confirmação da barbearia ainda visível.');

  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({width, height: 1100});
    const dimensions = await page.locator('body').evaluate((node) => ({width: node.clientWidth, scroll: node.scrollWidth}));
    if (dimensions.scroll > dimensions.width + 1) throw new Error(`Rolagem horizontal em ${width}px: ${JSON.stringify(dimensions)}`);
    await page.locator('.showcase').screenshot({path: path.join(root, 'artifacts', 'home', `showcase-${width}.png`)});
  }

  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Marca, três exemplos, conteúdo e responsividade validados em cinco larguras.');
} finally {
  if (browser) await browser.close();
  server.close();
}
