import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/User/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = process.cwd();
const boot = `
import {createAppointmentsUI} from '/js/appointments.js';
document.querySelector('#dashboard-loading').hidden=true;
document.querySelector('#app-shell').hidden=false;
document.querySelector('#welcome-name').textContent='Mariana';
document.querySelector('#profile-name').textContent='Mariana Souza';
document.querySelector('#profile-email').textContent='mariana@exemplo.com';
document.querySelector('#sidebar-plan').textContent='Profissional';
document.querySelector('.setup-panel').hidden=true;
document.querySelector('#meta-connect-card').classList.add('connected-compact');
document.querySelector('#meta-connect-card h3').textContent='WhatsApp conectado';
document.querySelector('#meta-connect-card .meta-copy p').textContent='Seu atendimento está pronto para receber mensagens.';
document.querySelector('#connect-whatsapp').hidden=false;
document.querySelector('#connect-whatsapp').textContent='Ver conexão';
document.querySelector('#connection-pill').classList.add('connected');
document.querySelector('#connection-pill span').textContent='WhatsApp conectado';
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const items=[['09:00','Mariana Souza','Manicure + esmaltação','Alexandra','confirmed'],['10:30','Beatriz Lima','Pedicure','Camila','confirmed'],['13:00','Ana Oliveira','Alongamento em gel','Alexandra','completed'],['14:30','Carolina Santos','Manicure','Camila','cancelled']].map((a,i)=>({id:'appointment'+i,date:today,time:a[0],customerName:a[1],service:a[2],professional:a[3],professionalId:i%2?'p2':'p1',status:a[4],duration:60,price:85,phone:'5511999990000',conversationId:'conversation'+i,reminderStatus:'sent'}));
const ui=createAppointmentsUI({organization:()=> 'fixture',list:async()=>({data:{appointments:items,todayAppointments:items,professionals:[{id:'p1',name:'Alexandra'},{id:'p2',name:'Camila'}],canManage:true}}),slots:async()=>({data:{times:['11:00','15:00']}}),update:async()=>({data:{saved:true,reminderQueued:true}}),openConversation:async()=>{}});
window.fixtureReady=ui.refresh();
`;
const server = http.createServer(async (req,res) => {
  try {
    const name = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if(name === '/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(boot);return;}
    const file = path.resolve(root,`.${name === '/' ? '/dashboard.html' : name}`);
    if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
    let content=await fs.readFile(file);
    if(file.endsWith('dashboard.html')) content=Buffer.from(content.toString().replace('<script type="module" src="./js/dashboard.js"></script>','<script type="module" src="/fixture.js"></script>'));
    res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(content);
  }catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser=await chromium.launch({headless:true,channel:'msedge'});
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await fs.mkdir(path.join(root,'artifacts','agenda'),{recursive:true});
  await page.goto(`http://127.0.0.1:${server.address().port}/dashboard.html`);await page.evaluate(()=>window.fixtureReady);
  for(const width of [1440,768,390,320]) {
    await page.setViewportSize({width,height:960});
    for(const view of ['overview','appointments']) {
      await page.evaluate(view=>{document.querySelectorAll('.dashboard-view').forEach(n=>n.classList.toggle('active',n.id==='view-'+view));document.querySelectorAll('.nav-item[data-view]').forEach(n=>n.classList.toggle('active',n.dataset.view===view));document.querySelector('#page-title').textContent=view==='overview'?'Visão geral':'Agendamentos';},view);
      const dimensions=await page.locator('#view-'+view).evaluate(n=>({client:n.clientWidth,scroll:n.scrollWidth}));
      if(dimensions.scroll>dimensions.client+1) throw new Error('Rolagem horizontal em '+view+' '+width+': '+JSON.stringify(dimensions));
      await page.screenshot({path:path.join(root,'artifacts','agenda',view+'-'+width+'.png')});
    }
  }
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'Ver detalhes ↗'}).first().click();
  await page.getByRole('button',{name:'Remarcar',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#appointment-new-time').options[0]?.value==='11:00');
  await page.screenshot({path:path.join(root,'artifacts','agenda','details-mobile.png')});
  await page.getByRole('button',{name:'Fechar detalhes'}).click();
  await page.locator('#agenda-search').fill('Beatriz');
  if(await page.locator('#agenda-list .appointment-row').count()!==1)throw new Error('Filtro não aplicado');
  if(errors.length)throw new Error(errors.join('\n'));
  console.log('Layout validado em 1440, 768, 390 e 320 px; detalhes, remarcação e busca sem erros.');
} finally {if(browser)await browser.close();server.close();}
