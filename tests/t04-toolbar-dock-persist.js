const {chromium}=require('playwright');const fs=require('fs');
const code=fs.readFileSync((process.env.SCRIPT||require('path').join(__dirname,'..','whatsapp-assistant.user.js')),'utf8');
(async()=>{const b=await chromium.launch();const ctx=await b.newContext({viewport:{width:1400,height:850}});const p=await ctx.newPage();p.on('pageerror',e=>console.log('PAGEERR',e.message));
await p.goto('file://'+__dirname+'/page4.html');
await p.addScriptTag({content:code});
await p.evaluate(()=>GM_setValue('dsKey','sk-test'));await p.waitForTimeout(700);
const fr=await p.evaluate(()=>{const r=document.getElementById('wat-bar').getBoundingClientRect();return [Math.round(r.left),Math.round(r.top)]});
console.log('floating bar at',fr);
// drag
const hd=await p.evaluate(()=>{const r=document.getElementById('wat-handle').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]});
await p.mouse.move(hd[0],hd[1]);await p.mouse.down();await p.mouse.move(200,100,{steps:5});await p.mouse.up();await p.waitForTimeout(700);
console.log('after drag',await p.evaluate(()=>{const r=document.getElementById('wat-bar').getBoundingClientRect();return [Math.round(r.left),Math.round(r.top)]}),'saved',await p.evaluate(()=>JSON.stringify(GM_getValue('barPos'))));
await p.click('#wat-min');await p.waitForTimeout(600);
console.log('mini width',await p.evaluate(()=>Math.round(document.getElementById('wat-bar').getBoundingClientRect().width)));
await p.click('#wat-min');await p.waitForTimeout(600);
// ONE click analyze -> docked
await p.click('#wat-analyze');await p.waitForTimeout(2500);
const st=await p.evaluate(()=>{const b=document.getElementById('wat-bar').getBoundingClientRect();const pn=document.getElementById('wat-panel').getBoundingClientRect();const body=document.querySelector('#wat-panel .wp-body').getBoundingClientRect();return {docked:document.documentElement.classList.contains('wat-docked'),bar:[Math.round(b.left),Math.round(b.top),Math.round(b.width),Math.round(b.bottom)],panelLeft:pn.left,bodyTop:Math.round(body.top),app:document.getElementById('app').getBoundingClientRect().width}});
console.log('after 1 click',JSON.stringify(st));
// simulate WA rerender: header temporarily missing
await p.evaluate(()=>{const h=document.querySelector('#main header');window._h=h;h.remove();setTimeout(()=>document.querySelector('#main').prepend(window._h),1000)});
await p.waitForTimeout(2000);
console.log('after transient no-chat: docked',await p.evaluate(()=>document.documentElement.classList.contains('wat-docked')),'panel',await p.evaluate(()=>document.querySelector('#wat-panel .wp-body').innerText.slice(0,10)));
await p.screenshot({path:'shot6.png'});
// reload -> stays docked
const store=await p.evaluate(()=>JSON.stringify(Object.fromEntries(['docked','dsKey','analyses','barPos'].map(k=>[k,GM_getValue(k)]))));
await p.reload();
await p.evaluate((s)=>{const o=JSON.parse(s);for(const k in o)GM_setValue(k,o[k]);},store);
await p.addScriptTag({content:code});await p.waitForTimeout(1500);
console.log('after reload docked',await p.evaluate(()=>document.documentElement.classList.contains('wat-docked')),'panel:',await p.evaluate(()=>document.querySelector('#wat-panel .wp-body')?.innerText.slice(0,12)));
await p.click('#wat-panel .wp-x');await p.waitForTimeout(700);
console.log('closed: docked',await p.evaluate(()=>document.documentElement.classList.contains('wat-docked')),'saved',await p.evaluate(()=>GM_getValue('docked')),'bar back floating at',await p.evaluate(()=>{const r=document.getElementById('wat-bar').getBoundingClientRect();return [Math.round(r.left),Math.round(r.top)]}));
await b.close();})();
