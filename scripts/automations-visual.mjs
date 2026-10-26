import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/User/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=process.cwd();
const boot=`import {createAutomationTabs} from '/js/automation-tabs.js';
document.querySelector('#dashboard-loading').hidden=true;document.querySelector('#app-shell').hidden=false;
document.querySelectorAll('.dashboard-view').forEach(n=>n.classList.toggle('active',n.id==='view-automations'));
document.querySelectorAll('.nav-item[data-view]').forEach(n=>n.classList.toggle('active',n.dataset.view==='automations'));
document.querySelector('#page-title').textContent='Automações';
document.querySelector('#profile-name').textContent='Mariana Souza';document.querySelector('#profile-email').textContent='mariana@exemplo.com';document.querySelector('#sidebar-plan').textContent='Profissional';
document.querySelector('#connection-pill').classList.add('connected');document.querySelector('#connection-pill span').textContent='WhatsApp conectado';
document.querySelector('#reminder-status').textContent='Aprovado pela Meta';document.querySelector('#reminder-status').classList.add('approved');
document.querySelector('#flow-name').value='Agendamento padrão';document.querySelector('#flow-message').value='Olá, {{cliente_nome}}! Escolha o melhor horário para seu atendimento.';
document.querySelector('#flow-preview-message').textContent='Olá, Mariana! Escolha o melhor horário para seu atendimento.';document.querySelector('#save-flow-config').disabled=false;
document.querySelector('#flow-list').innerHTML='<div class="flow-item active"><span class="flow-item-icon">↗</span><span class="flow-item-copy"><strong>Agendamento padrão</strong><small>PUBLICADO · AGENDAMENTO</small></span><span>›</span></div>';
window.automationTabs=createAutomationTabs();window.fixtureReady=true;`;
const server=http.createServer(async(req,res)=>{try{
  const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  if(name==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(boot);return;}
  const file=path.resolve(root,`.${name==='/'?'/dashboard.html':name}`);if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  let content=await fs.readFile(file);if(file.endsWith('dashboard.html'))content=Buffer.from(content.toString().replace('<script type="module" src="./js/dashboard.js"></script>','<script type="module" src="/fixture.js"></script>'));
  res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(content);
}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{
  browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await fs.mkdir(path.join(root,'artifacts','automations'),{recursive:true});
  await page.goto(`http://127.0.0.1:${server.address().port}/dashboard.html`);await page.waitForFunction(()=>window.fixtureReady);
  if(await page.locator('#reminder-card').isVisible())throw new Error('Lembrete visível na aba Flows');
  await page.locator('#flow-message').fill('Mensagem ainda não salva');
  await page.getByRole('tab',{name:'Lembretes'}).click();
  await page.selectOption('#reminder-trigger','before_appointment');await page.selectOption('#reminder-lead-time','120');
  if(await page.locator('#reminder-delivery-summary').textContent()!=='Enviar 2 horas antes do agendamento')throw new Error('Resumo de envio incorreto');
  if(await page.locator('#reminder-delay-field').isVisible())throw new Error('Campo incorreto visível');
  await page.getByRole('tab',{name:'Flows',exact:true}).click();
  if(await page.locator('#flow-message').inputValue()!=='Mensagem ainda não salva')throw new Error('Perdeu mensagem não salva');
  await page.getByRole('tab',{name:'Lembretes'}).click();
  if(await page.locator('#reminder-lead-time').inputValue()!=='120')throw new Error('Perdeu configuração de envio');
  await page.locator('#reminder-active').uncheck();if(await page.locator('#reminder-delivery-summary').textContent()!=='Lembrete pausado')throw new Error('Estado pausado incorreto');
  await page.locator('#reminder-active').check();
  for(const width of [1440,1024,768,390,320]){
    await page.setViewportSize({width,height:1000});
    for(const tab of ['Flows','Lembretes']){
      await page.getByRole('tab',{name:tab,exact:true}).click();
      const dims=await page.locator('#view-automations').evaluate(n=>({width:n.clientWidth,scroll:n.scrollWidth}));
      if(dims.scroll>dims.width+1)throw new Error(`Rolagem horizontal em ${tab} ${width}: ${JSON.stringify(dims)}`);
      if(await page.locator(tab==='Flows'?'#automation-reminders':'#automation-flows').isVisible())throw new Error('Dois painéis visíveis');
      await page.screenshot({path:path.join(root,'artifacts','automations',`${tab.toLowerCase()}-${width}.png`)});
    }
  }
  await page.getByRole('tab',{name:'Flows',exact:true}).focus();await page.keyboard.press('ArrowRight');
  if(await page.getByRole('tab',{name:'Lembretes'}).getAttribute('aria-selected')!=='true')throw new Error('Navegação de teclado falhou');
  if(errors.length)throw new Error(errors.join('\n'));console.log('Abas, preservação dos campos, prévia, teclado e layout em 5 larguras validados.');
}finally{if(browser)await browser.close();server.close();}
