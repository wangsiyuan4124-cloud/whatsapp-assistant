// 学习你的回复方式：自动收集发出的回复 / 历史补录 / AI 稿改动 / 修改要求 / 风格学习 / 写建议时参考
const {chromium}=require('playwright');const fs=require('fs');
const raw=fs.readFileSync((process.env.SCRIPT||require('path').join(__dirname,'..','whatsapp-assistant.user.js')),'utf8');
const code='(function(window){\n'+raw+'\n})(new Proxy(window,{get(t,k){const v=t[k];return (typeof v==="function"&&!/^[A-Z]/.test(String(k)))?v.bind(t):v;},set(t,k,v){t[k]=v;return true;}}));';
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1400,height:900}});p.on('pageerror',e=>console.log('PAGEERR',e.message));
await p.goto('file://'+__dirname+'/page9.html');
await p.evaluate(()=>{const g=window.GM_xmlhttpRequest;window.dsLog=[];
 window.GM_xmlhttpRequest=(o)=>{
  if(o.url.includes('translate.googleapis')&&!o.url.includes('tl=zh-CN')) return setTimeout(()=>o.onload({status:200,responseText:JSON.stringify([[["Ships tomorrow","x"]],null,"zh-CN"])}),30);
  if(o.url.includes('deepseek')){const body=JSON.parse(o.data);dsLog.push(body);
   if(body.messages[0].content.includes('个人风格')) return setTimeout(()=>o.onload({status:200,responseText:JSON.stringify({choices:[{message:{content:JSON.stringify({style:'回复很短，一两句\n不用表情',rules:['不要用 I understand 开头','先回答客户的问题再提问']})},finish_reason:'stop'}]})}),50);}
  return g(o);};
 GM_setValue('aiIn',false);GM_setValue('engine','google');GM_setValue('dsKey','sk-test');
 const l=[];for(let i=0;i<33;i++)l.push({at:i,chat:'Bob',cust:'random filler words number '+i,sent:'Filler reply '+i,src:'history'});
 l.splice(5,0,{at:99,chat:'Maria',cust:'Cual es el precio del carro?',sent:'MATCH reply about precio',src:'history'});
 GM_setValue('myReplies',l);});
await p.addScriptTag({content:code});
const S=()=>p.evaluate(()=>GM_getValue('myReplies'));
const last=async()=>(await S()).at(-1);
const ed='#main footer div[contenteditable]';
// 1 历史补录：页面上已有的「客户说 → 我方回」
await p.waitForTimeout(5600);
const h1=(await S()).filter(s=>s.chat==='Ahmed');
console.log('1 harvested:',JSON.stringify(h1.map(s=>[s.src,s.cust,s.sent])),'| placed before live:',(await S()).findIndex(s=>s.chat==='Ahmed')===34);
// 2 直接发英文
await p.click(ed);await p.keyboard.type('ok I will check the price');await p.keyboard.press('Enter');await p.waitForTimeout(300);
let s=await last();console.log('2 typed:',s.src,'|',s.sent,'| cust:',s.cust,'| zh:',s.zh||'-');
// 3 中文回车翻译后发送：记下中文原文
await p.click(ed);await p.keyboard.type('明天发货');await p.keyboard.press('Enter');await p.waitForTimeout(800);
s=await last();console.log('3 translated:',s.sent,'| zh:',s.zh,'| sent:',await p.evaluate(()=>sent.at(-1)));
// 4 点发送按钮：只记一次
await p.click(ed);await p.keyboard.type('See you');await p.click('#sendbtn');await p.waitForTimeout(300);
console.log('4 button send:',(await last()).sent,'| dup count',(await S()).filter(x=>x.sent==='See you').length);
// 5 分析：提示词里有相似的真实回复，种子话术已不交给 AI
await p.click('#wat-analyze');await p.waitForTimeout(1500);
let sys=await p.evaluate(()=>dsLog.filter(q=>q.messages[0].content.includes('分析客户并给出')).at(-1).messages[0].content);
const exBlock=sys.split('【这位销售过去在类似情况下的真实回复')[1]||'';
console.log('5 examples first:',JSON.stringify(exBlock.split('\n')[1]+' | '+exBlock.split('\n')[2]),'| same chat excluded',!exBlock.split('【')[0].includes('Hello there'),'| seeds off',!sys.includes('[首次咨询]'),'| anti-template rule',sys.includes('客服腔'));
// 6 填入 AI 建议后自己改了再发：记下原稿和改后
await p.click('#wat-panel .wp-sug button:has-text("填入")');await p.waitForTimeout(300);
await p.click(ed);await p.keyboard.press('End');await p.keyboard.type(' Thanks!');await p.keyboard.press('Enter');await p.waitForTimeout(300);
s=await last();console.log('6 edited:',s.sent,'| ai:',s.ai);
// 7 填入后原样发出：标记 aiKept
await p.click('#wat-panel .wp-sug button:has-text("填入")');await p.waitForTimeout(300);await p.click(ed);await p.keyboard.press('Enter');await p.waitForTimeout(300);
s=await last();console.log('7 kept:',s.aiKept===true,'| ai field',s.ai||'-');
// 8 和 AI 改一改：记下修改要求，提示词里有「被改过的例子」
await p.click('#wat-panel button:has-text("和 AI 改一改")');await p.waitForTimeout(200);
await p.fill('.wr-ask','不要用 I understand 开头');await p.keyboard.press('Enter');await p.waitForTimeout(500);
sys=await p.evaluate(()=>dsLog.filter(q=>q.messages[0].content.includes('修改一条')).at(-1).messages[0].content);
console.log('8 asks:',JSON.stringify((await p.evaluate(()=>GM_getValue('refineAsks'))).map(a=>a.text)),'| edit example in prompt',sys.includes('销售改成：¿Qué versión prefiere y en qué ciudad está? Thanks!'));
// 9 设置 → AI 学到的 → 学习我的风格
await p.click('#wat-set');await p.click('#wat-settings .ws-tab:has-text("AI 学到的")');await p.waitForTimeout(100);
console.log('9 info:',await p.evaluate(()=>[...document.querySelectorAll('#wat-settings .wp-muted')].map(x=>x.textContent).find(t=>t.startsWith('已收集'))));
await p.click('#wat-settings button:has-text("学习我的风格")');await p.waitForTimeout(800);
const lq=await p.evaluate(()=>dsLog.filter(q=>q.messages[0].content.includes('个人风格')).at(-1).messages[1].content);
console.log('9 learn prompt has edits',lq.includes('他改成：'),'| asks',lq.includes('不要用 I understand 开头'),'| samples',lq.includes('他：See you'));
const tas=p.locator('#wat-settings textarea');const n=await tas.count();
console.log('9 style box:',JSON.stringify(await tas.nth(n-2).inputValue()),'| rules box:',JSON.stringify(await tas.nth(n-1).inputValue()));
await tas.nth(n-1).fill('不要用 I understand 开头\n回复不超过两句');
const before=(await S()).length;await p.click('#wat-settings button[title^="删除这条"] >> nth=0');await p.waitForTimeout(100);
console.log('9 delete one: ',before,'->',(await S()).length);
await p.click('#wat-settings button:has-text("保存")');
console.log('9 saved rules:',JSON.stringify((await p.evaluate(()=>GM_getValue('styleProfile'))).rules));
// 10 再分析：风格和规则进了提示词
await p.click('#wat-panel .wp-back');await p.waitForTimeout(200);await p.click('#wat-panel button:has-text("重新分析")');await p.waitForTimeout(1500);
sys=await p.evaluate(()=>dsLog.filter(q=>q.messages[0].content.includes('分析客户并给出')).at(-1).messages[0].content);
console.log('10 style in prompt',sys.includes('【这位销售本人的回复风格（照这个风格写）】\n回复很短'),'| rules in prompt',sys.includes('- 回复不超过两句'));
await b.close();})();
