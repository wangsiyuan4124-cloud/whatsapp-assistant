// 模拟 Tampermonkey 沙箱：脚本里的 window 不是真正的 Window 对象
const {chromium}=require('playwright');const fs=require('fs');
const file=process.argv[2]||(process.env.SCRIPT||require('path').join(__dirname,'..','whatsapp-assistant.user.js'));
const raw=fs.readFileSync(file,'utf8');
const code='(function(window){\n'+raw+'\n})(new Proxy(window,{get(t,k){const v=t[k];return (typeof v==="function"&&!/^[A-Z]/.test(String(k)))?v.bind(t):v;},set(t,k,v){t[k]=v;return true;}}));';
(async()=>{for (const hash of ['','#keep']) {const b=await chromium.launch();const p=await b.newPage({viewport:{width:1400,height:900}});p.on('pageerror',e=>console.log('PAGEERR',e.message));
await p.goto('file://'+__dirname+'/page6.html'+hash);
await p.addScriptTag({content:code});
await p.evaluate(()=>{GM_setValue('dsKey','sk-test');});await p.waitForTimeout(600);
await p.click('#wat-analyze');await p.waitForTimeout(4500);
console.log(hash||'closes','lists',await p.evaluate(()=>JSON.stringify(lists)),'menu open',await p.evaluate(()=>!!document.querySelector('[role=menu]')),'ESC',await p.evaluate(()=>chatClosed),'status:',await p.evaluate(()=>document.querySelector('#wat-panel .wp-status')?.innerText.replace(/\n/g,' | ')));
await b.close();}})();
