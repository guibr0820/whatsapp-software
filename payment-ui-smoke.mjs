import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const server=createServer(async(req,res)=>{try{const path=new URL(req.url,'http://localhost').pathname;res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');let body=await readFile(`.${path==='/'?'/dashboard.html':path}`,'utf8');if(path==='/')body=body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');res.end(body);}catch{res.writeHead(404).end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
 browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 await page.goto(`http://127.0.0.1:${server.address().port}/`);
 await page.evaluate(async()=>{
 const {createAppointmentsUI}=await import('/js/appointments.js');
 const common={date:'2026-11-12',time:'12:30',duration:60,customerName:'Guilherme',petName:'Juli',petSex:'female',transportId:'both',transport:'Buscar e entregar',service:'Banho e tosa',professional:'Aline',professionalId:'p1',phone:'5511999999999',petTimeline:{},petMessageStatuses:{},price:150};
 const appointments=[{...common,id:'no-deposit',status:'completed',deposit:0,paid:0,paymentStatus:'onsite'},{...common,id:'partial',petName:'Thor',status:'confirmed',deposit:30,paid:30,paymentStatus:'paid'},{...common,id:'full',petName:'Luna',status:'completed',deposit:0,paid:150,paymentStatus:'paid'}];
 const ui=createAppointmentsUI({organization:()=> 'test',list:async()=>({data:{appointments,todayAppointments:[],canManage:true}}),slots:async()=>({data:{times:[]}}),update:async()=>({data:{}}),openConversation:async()=>{}});
 document.querySelector('#view-overview').classList.remove('active');document.querySelector('#view-appointments').classList.add('active');document.querySelector('#app-shell').hidden=false;document.querySelector('#dashboard-loading').hidden=true;
 await ui.refresh();
 });
 const rows=page.locator('#agenda-list .appointment-row');
 assert.equal(await rows.count(),3);
 assert.equal(await page.locator('#agenda-list .is-paid').count(),1);
 assert.match(await page.locator('#agenda-list .is-paid').textContent(),/Luna/);
 assert.equal(await page.locator('#agenda-list .appointment-paid-badge svg').count(),1);
 assert.equal(await page.locator('.agenda-status-card').filter({hasText:'Entregues / retirados'}).count(),1);
 assert.equal(await page.locator('#agenda-list .appointment-badge').first().evaluate(node=>getComputedStyle(node).fontSize),'14px');
 await rows.first().getByRole('button',{name:'Ver detalhes ↗'}).click();
 assert.ok(!(await page.locator('.appointment-payment-panel').textContent()).toLowerCase().includes('sinal'));
 assert.match(await page.locator('.appointment-payment-panel').textContent(),/Aguardando pagamento/);
 await page.locator('#appointment-close').click();
 await page.selectOption('#agenda-payment','paid');
 assert.equal(await rows.count(),1);
 await page.screenshot({path:'payment-ui-smoke.png'});
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.locator('#agenda-payment').isVisible());
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 console.log('PASS: somente pagamento integral recebe selo/borda; sinal parcial separado; entregue não é pago; detalhes sem sinal; filtro financeiro; status legível; mobile sem overflow.');
}finally{await browser?.close();server.close();}
