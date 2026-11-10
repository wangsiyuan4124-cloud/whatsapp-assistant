// 车型资料：导入资料包文件夹 / CIF 到港价 / AI 背景 / 发介绍、照片、规格书 PDF、视频
const {chromium}=require('playwright');const fs=require('fs');const path=require('path');
const raw=fs.readFileSync((process.env.SCRIPT||path.join(__dirname,'..','whatsapp-assistant.user.js')),'utf8');
const code='(function(window){\n'+raw+'\n})(new Proxy(window,{get(t,k){const v=t[k];return (typeof v==="function"&&!/^[A-Z]/.test(String(k)))?v.bind(t):v;},set(t,k,v){t[k]=v;return true;}}));';
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1400,height:900}});p.on('pageerror',e=>console.log('PAGEERR',e.message));
await p.goto('file://'+__dirname+'/page9.html');
await p.evaluate(()=>{const g=window.GM_xmlhttpRequest;window.dsLog=[];
 window.GM_xmlhttpRequest=(o)=>{ if(o.url.includes('deepseek')){const body=JSON.parse(o.data);dsLog.push(body);
   if(body.messages[0].content.includes('本次任务：给这位客户写一条介绍')) return setTimeout(()=>o.onload({status:200,responseText:JSON.stringify({choices:[{message:{content:JSON.stringify({reply:'Hi! The TEST Diesel fits your work needs.',reply_zh:'你好！TEST 柴油版适合你的工作需要。'})},finish_reason:'stop'}]})}),40);}
  return g(o);};
 GM_setValue('aiIn',false);GM_setValue('dsKey','sk-test');GM_setValue('piSeller',{phone:'+86 000',email:'test@example.com'});});
await p.addScriptTag({path:'node_modules/html2canvas/dist/html2canvas.min.js'});await p.addScriptTag({path:'node_modules/jspdf/dist/jspdf.umd.min.js'});
await p.addScriptTag({content:code});await p.waitForTimeout(500);
const info=()=>p.evaluate(()=>[...document.querySelectorAll('#wat-settings .wp-muted')].map(x=>x.textContent).find(t=>/已导入|还没有导入|读取/.test(t)));
// 1 设置 → 车型资料 → 导入资料包文件夹
await p.click('#wat-set');await p.click('#wat-settings .ws-tab:has-text("车型资料")');await p.waitForTimeout(300);
console.log('1 before:',await info());
await p.locator('#wat-settings input[webkitdirectory]').setInputFiles(path.join(__dirname,'fixtures','catalog'));await p.waitForTimeout(1500);
console.log('1 after :',await info());
console.log('1 media groups:',await p.evaluate(()=>[...document.querySelectorAll('#wat-settings .ws-pbi')].filter(r=>r.querySelector('select')).map(r=>r.querySelector('.ws-pbt').firstChild.textContent+'→'+r.querySelector('select').value).join(', ')));
// 2 运费 / 保险 / 手动 CIF
const ins=p.locator('#wat-settings .pi-row input');
await ins.nth(1).fill('2800');await ins.nth(2).fill('100');await p.waitForTimeout(100);
const ov=p.locator('#wat-settings table input');await ov.nth(3).fill('9999');await ov.nth(3).dispatchEvent('change');await p.waitForTimeout(100);
console.log('2 table:',await p.evaluate(()=>[...document.querySelectorAll('#wat-settings table tr')].slice(1).map(r=>[...r.cells].map(c=>c.querySelector('input')?c.querySelector('input').value||'-':c.textContent).join('|')).join('  ')));
await p.click('#wat-settings button:has-text("保存")');
console.log('2 saved:',JSON.stringify(await p.evaluate(()=>GM_getValue('catPrice'))));
// 3 分析时 AI 拿到车型资料（CIF 价、待确认，不含 FOB）
await p.click('#wat-analyze');await p.waitForTimeout(1500);
let sys=await p.evaluate(()=>dsLog.filter(q=>q.messages[0].content.includes('分析客户并给出')).at(-1).messages[0].content);
const blk=sys.split('【车型资料')[1].split('【硬规则】')[0];
console.log('3 context: CIF',blk.includes('6MT Comfort') && blk.includes('报价 CIF Belize City USD 3,900.00'),'| ev override',blk.includes('USD 9,999.00'),'| pending',blk.includes('续航待确认'),'| no FOB',!/fob|1,000\.00/i.test(blk),'| rule',sys.includes('标了「待确认」的不要给数字'),'| cif excludes',blk.includes('不包含进口关税'));
// 4 打开「发车型资料」
await p.click('#wat-panel button:has-text("发车型资料")');await p.waitForTimeout(800);
const head=()=>p.evaluate(()=>document.querySelector('#wat-panel .wp-head').innerText.replace(/\n/g,' | '));
console.log('4 head:',await head(),'| tabs:',await p.evaluate(()=>[...document.querySelectorAll('#wat-panel .ask-top button')].map(b=>b.textContent+(b.className?'':'*')).join(' ')));
console.log('4 photos:',await p.evaluate(()=>[...document.querySelectorAll('#wat-panel img')].map(i=>i.title+(i.style.opacity==='1'?'✓':'')).join(' ')),'| videos:',await p.evaluate(()=>[...document.querySelectorAll('#wat-panel label')].map(l=>l.textContent).filter(t=>t.includes('🎬')).join(' ')),'| send btn:',await p.evaluate(()=>document.querySelector('#wat-panel .pi-actions button').textContent));
// 5 标准介绍 / AI 介绍 / 填入
await p.click('#wat-panel button:has-text("标准介绍")');
console.log('5 std:',JSON.stringify(await p.inputValue('#wat-panel .wr-draft')));
await p.click('#wat-panel button:has-text("AI 按客户需求写")');await p.waitForTimeout(600);
sys=await p.evaluate(()=>dsLog.at(-1).messages[0].content);
console.log('5 ai:',await p.inputValue('#wat-panel .wr-draft'),'| zh:',await p.evaluate(()=>document.querySelector('#wat-panel .wp-zh').textContent),'| prompt',sys.includes('介绍「TEST Diesel」')&&sys.includes('可以提 CIF 起价'));
await p.click('#wat-panel button:has-text("填入聊天")');await p.waitForTimeout(300);
console.log('5 input:',await p.evaluate(()=>document.querySelector('#main footer div[contenteditable]').innerText));
// 5b 不满意 → 和 AI 改一改 → 用这条返回：介绍更新，照片选择保留
await p.click('#wat-panel img[title="02_side.jpg"]');
await p.click('#wat-panel button:has-text("和 AI 改一改")');await p.waitForTimeout(300);
console.log('5b refine head:',await head(),'| draft:',await p.inputValue('#wat-panel .wr-draft'),'| back btn:',await p.evaluate(()=>[...document.querySelectorAll('#wat-panel .wp-btns button')].map(b=>b.textContent).find(t=>t.includes('返回'))));
await p.fill('#wat-panel .wr-ask','更简短，加上可以视频看车');await p.keyboard.press('Enter');await p.waitForTimeout(600);
sys=await p.evaluate(()=>dsLog.at(-1).messages[0].content);
console.log('5b refined draft:',await p.inputValue('#wat-panel .wr-draft'),'| extra rule',sys.includes('这是一条介绍「TEST Diesel」的消息')&&sys.includes('可以提 CIF 起价'),'| catalog in prompt',sys.includes('【车型资料'));
await p.click('#wat-panel .wp-btns button:has-text("用这条，返回")');await p.waitForTimeout(600);
console.log('5b back:',await head(),'| intro:',await p.inputValue('#wat-panel .wr-draft'),'|',await p.evaluate(()=>document.querySelector('#wat-panel .wp-zh').textContent),'| photos:',await p.evaluate(()=>[...document.querySelectorAll('#wat-panel img')].map(i=>i.title+(i.style.opacity==='1'?'✓':'')).join(' ')));
await p.click('#wat-panel button:has-text("和 AI 改一改")');await p.waitForTimeout(300);await p.fill('#wat-panel .wr-draft','Manual edit');await p.click('#wat-panel .wp-back');await p.waitForTimeout(600);
console.log('5b head back keeps manual edit:',await p.inputValue('#wat-panel .wr-draft'));
await p.click('#wat-panel img[title="02_side.jpg"]');
// 6 预览规格书
await p.click('#wat-panel button:has-text("预览规格书")');await p.waitForTimeout(500);
console.log('6 logo in header:',await p.evaluate(()=>document.querySelectorAll('#wat-pi-modal img[src^="data:image"]').length===2));
console.log('6 preview:',await p.evaluate(()=>{const m=document.getElementById('wat-pi-modal');const t=m.innerText;return [m.style.display,/SPECIFICATIONS|FICHA TÉCNICA/.test(t),t.includes('TEST Diesel')||t.includes('TEST Diésel'),t.includes('3,900.00')&&t.includes('4,900.00'),(t.match(/●/g)||[]).length,!!m.querySelector('img[src^="data:image"]')].join(' ');}));
console.log('6 cif note:',await p.evaluate(()=>(document.getElementById('wat-pi-modal').innerText.match(/CIF Belize City: [^\n]*/)||[''])[0]));
await p.click('#wat-pi-modal button:has-text("关闭")');
// 7 选视频后放进聊天：照片 + 规格书 JPG/PDF + 视频
await p.click('#wat-panel label:has-text("🎬") input');
console.log('7 send btn:',await p.evaluate(()=>document.querySelector('#wat-panel .pi-actions button').textContent));
await p.click('#wat-panel .pi-actions button');for(let i=0;i<30&&!(await p.evaluate(()=>window.__pastedAll));i++)await p.waitForTimeout(500);await p.waitForTimeout(100);
console.log('7 notice:',await p.evaluate(()=>document.querySelector('#wat-panel .wp-status').innerText.split('\n').slice(1).join(' ')));
console.log('7 pasted:',await p.evaluate(()=>(window.__pastedAll||[]).map(f=>f.name+' '+f.type+' '+(f.size>1000?'big':'small')).join(', ')));
// 8 换到 EV：只显示 EV 照片，没有视频，用手动 CIF
await p.click('#wat-panel .ask-top button:has-text("EV")');await p.waitForTimeout(300);
console.log('8 ev photos:',await p.evaluate(()=>[...document.querySelectorAll('#wat-panel img')].map(i=>i.title).join(' ')),'| videos:',await p.evaluate(()=>[...document.querySelectorAll('#wat-panel label')].filter(l=>l.textContent.includes('🎬')).length),'| price label:',await p.evaluate(()=>[...document.querySelectorAll('#wat-panel label')].map(l=>l.textContent).find(t=>t.includes('到港价'))));
await p.click('#wat-panel button:has-text("标准介绍")');console.log('8 ev std price line:',(await p.inputValue('#wat-panel .wr-draft')).split('\n').find(l=>/USD/.test(l)));
// 9 返回
await p.click('#wat-panel .wp-back');await p.waitForTimeout(200);console.log('9 back:',await head());
// 10 再导入一次：替换资料包里的媒体，不重复；手动添加的保留
await p.click('#wat-set');await p.click('#wat-settings .ws-tab:has-text("车型资料")');await p.waitForTimeout(300);
await p.locator('#wat-settings input[accept="image/*,video/*"]').setInputFiles(path.join(__dirname,'fixtures','seal-dummy.png'));await p.waitForTimeout(800);
await p.locator('#wat-settings input[webkitdirectory]').setInputFiles(path.join(__dirname,'fixtures','catalog'));await p.waitForTimeout(1500);
console.log('10 reimport:',await info());
await b.close();})();
