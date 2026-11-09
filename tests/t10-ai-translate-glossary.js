// AI 发送翻译（DeepSeek）、术语表、失败自动退回谷歌
const {chromium}=require('playwright');const fs=require('fs');
const raw=fs.readFileSync((process.env.SCRIPT||require('path').join(__dirname,'..','whatsapp-assistant.user.js')),'utf8');
const code='(function(window){\n'+raw+'\n})(new Proxy(window,{get(t,k){const v=t[k];return (typeof v==="function"&&!/^[A-Z]/.test(String(k)))?v.bind(t):v;},set(t,k,v){t[k]=v;return true;}}));';
(async()=>{const b=await chromium.launch();const p=await b.newPage();p.on('pageerror',e=>console.log('PAGEERR',e.message));
await p.goto('file://'+__dirname+'/page2.html');
// 模拟 DeepSeek：dsMode = ok | fail | chinese
await p.evaluate(()=>{window.dsMode='ok';window.dsReqs=[];const g=window.GM_xmlhttpRequest;
 window.GM_xmlhttpRequest=(o)=>{ if(!o.url.includes('deepseek')) return g(o);
  const body=JSON.parse(o.data);window.dsReqs.push(body);window.lastTimeout=o.timeout;
  if(window.dsMode==='fail') return setTimeout(()=>o.onload({status:500,responseText:''}),30);
  const u=body.messages[1].content;const src=u.split('【要翻译的中文】\n')[1];
  const txt=window.dsMode==='chinese'?'好的 ok':(src.includes('二手车')?'"So a used SUV would work for you too, right?"':'AI-'+body.messages[0].content.match(/翻译成「([A-Za-zñ]+)/)[1]+' ok');
  setTimeout(()=>o.onload({status:200,responseText:JSON.stringify({choices:[{message:{content:txt},finish_reason:'stop'}]})}),40);};});
await p.addScriptTag({content:code});
await p.waitForTimeout(600);
const ed='#main footer div[contenteditable]';
const toast=()=>p.evaluate(()=>document.getElementById('wat-toast').textContent);
const say=async(t,keys)=>{await p.click(ed);await p.keyboard.type(t);await p.keyboard.press(keys||'Enter');await p.waitForTimeout(500);};
console.log('0 engine default:',await p.evaluate(()=>document.getElementById('wat-engine').value),'options:',await p.evaluate(()=>[...document.querySelectorAll('#wat-engine option')].map(o=>o.textContent).join('/')));
// 1 没有 Key：用谷歌，提示一次
await say('也就是说，你需要的车型可以是二手车，对吗？');
console.log('1 no key sent:',await p.evaluate(()=>sent.at(-1)),'| ds calls',await p.evaluate(()=>dsReqs.length),'| toast:',await toast());
// 2 有 Key + 术语表：AI 翻译，带上下文和术语表
await p.evaluate(()=>{GM_setValue('dsKey','sk-test');GM_setValue('glossary','# 注释行\n二手车 = used car | carro usado\n落地价 = landed price\n乱写的一行');});
await say('也就是说，你需要的车型可以是二手车，对吗？');
const r=await p.evaluate(()=>{const q=dsReqs.at(-1);return {sys:q.messages[0].content,user:q.messages[1].content,json:!!q.response_format,to:window.lastTimeout};});
console.log('2 ai sent:',await p.evaluate(()=>sent.at(-1)),'| google reqs for it:',await p.evaluate(()=>reqs.filter(u=>u.includes('translate_a')&&decodeURIComponent(u).includes('二手车')).length));
console.log('2 user msg:',JSON.stringify(r.user).slice(0,160));console.log('2 prompt: glossary',r.sys.includes('- 二手车：英语 used car；西语 carro usado'),'| comment skipped',!r.sys.includes('注释'),'| bad line skipped',!r.sys.includes('乱写'),'| faithful rule',r.sys.includes('严格保留人称'),'| context',r.user.includes('客户：'),'| json mode off',!r.json,'| timeout',r.to);
// 3 Ctrl+Enter 只翻译不发送
const n=await p.evaluate(()=>sent.length);
await say('明天发货','Control+Enter');
console.log('3 box:',await p.evaluate(s=>document.querySelector(s).innerText,ed),'| sent delta',await p.evaluate(()=>sent.length)-n,'| toast:',await toast());
await p.keyboard.press('Enter');await p.waitForTimeout(300);console.log('3 after enter:',await p.evaluate(()=>sent.at(-1)),'| ds calls',await p.evaluate(()=>dsReqs.length));
// 4 AI 失败：退回谷歌，并按术语表替换
await p.evaluate(()=>{dsMode='fail';});
await say('二手车的落地价是多少');
console.log('4 fail sent:',await p.evaluate(()=>sent.at(-1)),'| toast:',await toast());
// 5 AI 译文里有中文：视为失败
await p.evaluate(()=>{dsMode='chinese';});
await say('二手车可以');
console.log('5 chinese sent:',await p.evaluate(()=>sent.at(-1)));
// 6 西语：AI 用西语名；失败时用西语术语
await p.evaluate(()=>{dsMode='ok';});await p.selectOption('#wat-lang','es');
await say('价格可以优惠');
console.log('6 es ai sent:',await p.evaluate(()=>sent.at(-1)));
await p.evaluate(()=>{dsMode='fail';});await say('二手车和落地价');
console.log('6 es fail sent:',await p.evaluate(()=>sent.at(-1)));
// 7 选了谷歌：不调用 AI
await p.selectOption('#wat-engine','google');const c=await p.evaluate(()=>dsReqs.length);
await say('二手车');
console.log('7 google sent:',await p.evaluate(()=>sent.at(-1)),'| ds delta',await p.evaluate(()=>dsReqs.length)-c);
// 8 设置里能看到术语表并保存
await p.click('#wat-set');await p.waitForTimeout(200);
const ta=p.locator('#wat-settings textarea').nth(3);
console.log('8 settings glossary:',JSON.stringify(await ta.inputValue()).slice(0,40));
await ta.fill('二手车 = pre-owned car');await p.click('#wat-settings button:has-text("保存")');
console.log('8 saved:',await p.evaluate(()=>GM_getValue('glossary')));
await b.close();})();
