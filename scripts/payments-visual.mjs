import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/User/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=process.cwd();
const boot=`import {createPaymentsUI} from '/js/payments.js';
document.querySelector('#dashboard-loading').hidden=true;document.querySelector('#app-shell').hidden=false;
document.querySelectorAll('.dashboard-view').forEach(n=>n.classList.toggle('active',n.id==='view-payments'));
document.querySelectorAll('.nav-item[data-view]').forEach(n=>n.classList.toggle('active',n.dataset.view==='payments'));
document.querySelector('#page-title').textContent='Pagamentos';
let config={mode:'onsite',depositType:'fixed',depositValue:20,expiryMinutes:30,merchantName:'',pixKey:'',pixKeyType:'EVP'};
window.saved=[];const ui=createPaymentsUI({organization:()=> 'fixture',call:async(name,data)=>{if(name==='getPaymentSettings')return{data:{settings:config,connected:true,sellerName:'Studio Exemplo'}};window.saved.push(data);return{data:{saved:true}};}});
await ui.load();window.fixtureReady=true;`;
const server=http.createServer(async(req,res)=>{try{
  const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  if(name==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(boot);return;}
  const file=path.resolve(root,`.${name==='/'?'/dashboard.html':name}`);if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  let content=await fs.readFile(file);if(file.endsWith('dashboard.html'))content=Buffer.from(content.toString().replace('<script type="module" src="./js/dashboard.js"></script>','<script type="module" src="/fixture.js"></script>'));
  res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(content);
}catch{res.writeHead(404).end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/dashboard.html`);await page.waitForFunction(()=>window.fixtureReady);
  if(await page.locator('#payment-deposit-fields').isVisible())throw Error('Presencial exibiu campos de sinal');
  await page.locator('[name="payment-mode"][value="deposit"]').check();
  if(!await page.locator('#payment-deposit-fields').isVisible())throw Error('Não abriu configuração de sinal');
  await page.selectOption('#payment-deposit-type','percent');await page.locator('#payment-deposit-value').fill('25');
  if(await page.locator('#payment-preview-deposit').textContent()!=='R$ 20,00')throw Error('Prévia percentual incorreta');
  await page.locator('#payment-save').click();await page.waitForFunction(()=>window.saved.length===1);
  if((await page.evaluate(()=>window.saved[0].settings)).depositType!=='percent')throw Error('Não salvou a regra');
  await fs.mkdir(path.join(root,'artifacts','payments'),{recursive:true});
  for(const width of [1440,1024,768,390,320]){
    await page.setViewportSize({width,height:1100});
    for(const mode of ['onsite','deposit']){
      await page.locator('[name="payment-mode"][value="'+mode+'"]').check();
      const dims=await page.locator('#view-payments').evaluate(n=>({width:n.clientWidth,scroll:n.scrollWidth}));
      if(dims.scroll>dims.width+1)throw Error('Rolagem horizontal '+mode+' '+width+JSON.stringify(dims));
      await page.screenshot({path:path.join(root,'artifacts','payments',mode+'-'+width+'.png'),fullPage:true});
    }
  }
  if(errors.length)throw Error(errors.join('\n'));console.log('Pagamentos: seleção, prévia, salvamento e 5 larguras passaram.');
}finally{await browser.close();server.close();}
