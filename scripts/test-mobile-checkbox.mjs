import { chromium } from 'playwright-core';

const executablePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 372, height: 689 } });

await page.setContent(`<!doctype html><style>
  *{box-sizing:border-box}body{margin:0;font-family:Arial}.workspace{height:689px;overflow:auto}
  .spacer{height:480px}.card{margin:12px;padding:16px;border:1px solid #c9e6d2;border-radius:14px}
  .check{position:relative;display:block;width:20px;height:20px}.check input{position:absolute;inset:0;width:20px;height:20px;margin:0;opacity:0;cursor:pointer}.check span{display:block;width:20px;height:20px;border:2px solid green}
  .feedback{height:14px;min-height:14px;overflow:hidden;line-height:14px}.preview{height:380px;margin:12px;border:7px solid #17261e;border-radius:26px;background:#e8e2da}
</style><main class="workspace"><div class="spacer"></div><article class="card"><label class="check"><input type="checkbox" checked><span></span></label><p class="feedback"></p></article><section class="preview"></section></main>
<script>
const input=document.querySelector('input'),workspace=document.querySelector('.workspace'),feedback=document.querySelector('.feedback');
input.addEventListener('change',async event=>{const top=workspace.scrollTop;event.currentTarget.blur();workspace.scrollTop=top;requestAnimationFrame(()=>workspace.scrollTop=top);await new Promise(r=>setTimeout(r,80));feedback.textContent='Configuração salva.';workspace.scrollTop=top;});
</script>`);

await page.locator('.card').scrollIntoViewIfNeeded();
const before = await page.evaluate(() => ({
  scrollTop: document.querySelector('.workspace').scrollTop,
  scrollHeight: document.querySelector('.workspace').scrollHeight,
  preview: document.querySelector('.preview').getBoundingClientRect().toJSON(),
}));
await page.locator('input').click();
await page.waitForTimeout(150);
const after = await page.evaluate(() => ({
  scrollTop: document.querySelector('.workspace').scrollTop,
  scrollHeight: document.querySelector('.workspace').scrollHeight,
  preview: document.querySelector('.preview').getBoundingClientRect().toJSON(),
}));

console.log(JSON.stringify({ before, after, stable: before.scrollTop === after.scrollTop && before.scrollHeight === after.scrollHeight }, null, 2));
await browser.close();
