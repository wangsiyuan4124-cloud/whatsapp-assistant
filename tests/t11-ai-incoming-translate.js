// 对方消息的 AI 翻译：先显示机器译文，AI 回来后替换；批量、缓存、失败兜底、只翻最近 20 条
const {chromium}=require('playwright');const fs=require('fs');
const raw=fs.readFileSync((process.env.SCRIPT||require('path').join(__dirname,'..','whatsapp-assistant.user.js')),'utf8');
const code='(function(window){\n'+raw+'\n})(new Proxy(window,{get(t,k){const v=t[k];return (typeof v==="function"&&!/^[A-Z]/.test(String(k)))?v.bind(t):v;},set(t,k,v){t[k]=v;return true;}}));';
(async()=>{const b=await chromium.launch();const p=await b.newPage();p.on('pageerror',e=>console.log('PAGEERR',e.message));
await p.goto('file://'+__dirname+'/page2.html');
// 模拟 DeepSeek：dsMode = ok | fail | partial；回复慢一点，便于看到「先机器后 AI」
await p.evaluate(()=>{window.dsMode='ok';window.dsReqs=[];const g=window.GM_xmlhttpRequest;
 window.GM_xmlhttpRequest=(o)=>{ if(!o.url.includes('deepseek')) return g(o);
  const body=JSON.parse(o.data);window.dsReqs.push(body);
  if(window.dsMode==='fail') return setTimeout(()=>o.onload({status:500,responseText:''}),30);
  const src=body.messages[1].content.split('【需要翻译的客户消息】\n')[1].split('\n');
  let items=src.map((l,i)=>({id:i+1,zh:'AI译：'+l.replace(/^\d+\.\s*/,'').slice(0,12)}));
  if(window.dsMode==='partial') items=items.slice(0,1);
  setTimeout(()=>o.onload({status:200,responseText:JSON.stringify({choices:[{message:{content:JSON.stringify({items})},finish_reason:'stop'}]})}),400);};
 GM_setValue('dsKey','sk-test');});
await p.addScriptTag({content:code});
const boxes=()=>p.evaluate(()=>[...document.querySelectorAll('[data-testid^=conv-msg-]')].map(r=>{const x=r.querySelector('.wat-tr');return r.dataset.testid.slice(-1)+':'+(x?x.dataset.kind+'|'+x.textContent:'-');}).join('  '));
const addMsg=(id,text)=>p.evaluate(([id,text])=>{const d=document.querySelector('[data-testid=conv-msg-c]').cloneNode(true);d.dataset.testid='conv-msg-'+id;d.querySelector('.wat-tr')?.remove();d.querySelector('[data-testid=selectable-text]').textContent=text;document.querySelector('#main').insertBefore(d,document.querySelector('footer'));},[id,text]);
await p.waitForTimeout(700);
console.log('1 before AI:',await boxes());
await p.waitForTimeout(1200);
console.log('1 after AI :',await boxes());
const q=await p.evaluate(()=>dsReqs[0]);
console.log('1 ds calls',await p.evaluate(()=>dsReqs.length),'| json mode',!!(q&&q.response_format),'| numbered',q.messages[1].content.includes('1. مرحبا')&&q.messages[1].content.includes('2. Necesito'),'| context',q.messages[1].content.includes('我方：Hello there'),'| rules',q.messages[0].content.includes('严格保留人称')&&q.messages[0].content.includes('ti → to'));
console.log('1 label css:',await p.evaluate(()=>getComputedStyle(document.querySelector('.wat-tr-ai'),'::before').content),'| cache',Object.keys(await p.evaluate(()=>GM_getValue('aiTrCache'))).length);
// 2 新消息：一次新请求；React 重绘删掉译文后从缓存恢复，不再调用
await addMsg('f','80 is maximum when we have ti get rid of them');await p.waitForTimeout(1800);
console.log('2 new:',await p.evaluate(()=>document.querySelector('[data-testid=conv-msg-f] .wat-tr').textContent),'| ds calls',await p.evaluate(()=>dsReqs.length));
await p.evaluate(()=>document.querySelector('[data-testid=conv-msg-a] .wat-tr').remove());await p.waitForTimeout(800);
console.log('2 restored:',await p.evaluate(()=>document.querySelector('[data-testid=conv-msg-a] .wat-tr').dataset.kind),'| ds calls',await p.evaluate(()=>dsReqs.length));
// 3 只返回一部分：缺的那条保留机器译文
await p.evaluate(()=>{dsMode='partial';});await addMsg('g','Toyota...below 50k');await addMsg('h','Can you send pictures');await p.waitForTimeout(1800);
console.log('3 partial:',(await boxes()).split('  ').slice(-2).join('  '),'| last call items',await p.evaluate(()=>dsReqs.at(-1).messages[1].content.split('【需要翻译的客户消息】\n')[1].split('\n').length));
// 4 AI 出错：保留机器译文，1 分钟内不再请求
await p.evaluate(()=>{dsMode='fail';});await addMsg('i','When can you ship?');await p.waitForTimeout(1500);
const c4=await p.evaluate(()=>dsReqs.length);await addMsg('j','Price in Belize?');await p.waitForTimeout(1500);
console.log('4 fail:',(await boxes()).split('  ').slice(-2).join('  '),'| calls during backoff',await p.evaluate(()=>dsReqs.length)-c4);
// 5 关掉 AI：变回机器译文
await p.evaluate(()=>GM_setValue('aiIn',false));await p.waitForTimeout(3500);
console.log('5 aiIn off kinds:',await p.evaluate(()=>[...document.querySelectorAll('.wat-tr')].map(x=>x.dataset.kind).join(',')));
// 6 新页面：25 条客户消息，只有最近 20 条交给 AI
const p2=await b.newPage();await p2.goto('file://'+__dirname+'/page2.html');
await p2.evaluate(()=>{window.dsReqs=[];const g=window.GM_xmlhttpRequest;window.GM_xmlhttpRequest=(o)=>{if(!o.url.includes('deepseek'))return g(o);const body=JSON.parse(o.data);dsReqs.push(body);const n=body.messages[1].content.split('【需要翻译的客户消息】\n')[1].split('\n').length;setTimeout(()=>o.onload({status:200,responseText:JSON.stringify({choices:[{message:{content:JSON.stringify({items:Array.from({length:n},(_,i)=>({id:i+1,zh:'译'+i}))})},finish_reason:'stop'}]})}),50);};
 GM_setValue('dsKey','sk-test');const tpl=document.querySelector('[data-testid=conv-msg-c]');for(let i=0;i<23;i++){const d=tpl.cloneNode(true);d.dataset.testid='conv-msg-x'+i;d.querySelector('[data-testid=selectable-text]').textContent='Message number '+i;document.querySelector('#main').insertBefore(d,document.querySelector('footer'));}});
await p2.addScriptTag({content:code});await p2.waitForTimeout(3000);
const sent6=await p2.evaluate(()=>dsReqs.flatMap(q=>q.messages[1].content.split('【需要翻译的客户消息】\n')[1].split('\n').map(l=>l.replace(/^\d+\.\s*/,''))));
console.log('6 calls',sent6.length&&await p2.evaluate(()=>dsReqs.length),'| texts sent',sent6.length,'| first sent:',sent6[0],'| arabic skipped',!sent6.some(t=>t.includes('مرحبا')),'| ai boxes',await p2.evaluate(()=>document.querySelectorAll('.wat-tr-ai').length));
// 7 没有 Key：不调用 AI
const p3=await b.newPage();await p3.goto('file://'+__dirname+'/page2.html');
await p3.evaluate(()=>{window.dsN=0;const g=window.GM_xmlhttpRequest;window.GM_xmlhttpRequest=(o)=>{if(o.url.includes('deepseek')){dsN++;return;}return g(o);};});
await p3.addScriptTag({content:code});await p3.waitForTimeout(1500);
console.log('7 no key ds calls',await p3.evaluate(()=>dsN),'| kinds',await p3.evaluate(()=>[...document.querySelectorAll('.wat-tr')].map(x=>x.dataset.kind).join(',')));
await b.close();})();
