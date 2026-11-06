const {chromium}=require('playwright');const fs=require('fs');
(async()=>{const b=await chromium.launch();const p=await b.newPage();p.on('console',m=>m.type()==='error'&&console.log('CONSOLE',m.text()));p.on('pageerror',e=>console.log('PAGEERR',e.message));
await p.goto('file://'+__dirname+'/page.html');
await p.addScriptTag({content:fs.readFileSync((process.env.SCRIPT||require('path').join(__dirname,'..','whatsapp-assistant.user.js')),'utf8')});
await p.waitForTimeout(700);
const ed='#main footer div[contenteditable]';
// 1 auto: type chinese + Enter
await p.click(ed);await p.keyboard.type('你好，这台车多少钱');await p.keyboard.press('Enter');await p.waitForTimeout(500);
console.log('1 sent:',await p.evaluate(()=>sent));
// 2 english passes through untouched
await p.click(ed);await p.keyboard.type('ok thanks');await p.keyboard.press('Enter');await p.waitForTimeout(300);
console.log('2 sent:',await p.evaluate(()=>sent), 'reqs',await p.evaluate(()=>reqs.length));
// 3 ctrl+enter translate only
await p.click(ed);await p.keyboard.type('明天发货');await p.keyboard.press('Control+Enter');await p.waitForTimeout(400);
console.log('3 box:',await p.evaluate(s=>document.querySelector(s).innerText,ed),'sent count',await p.evaluate(()=>sent.length));
await p.keyboard.press('Enter');await p.waitForTimeout(300);console.log('3 after enter:',await p.evaluate(()=>sent));
// 4 multiline
await p.click(ed);await p.keyboard.type('第一行');await p.keyboard.press('Shift+Enter');await p.keyboard.type('第二行');await p.keyboard.press('Enter');await p.waitForTimeout(500);
console.log('4 sent:',JSON.stringify(await p.evaluate(()=>sent.at(-1))));
// 5 change language to es then send
await p.selectOption('#wat-lang','es');await p.click(ed);await p.keyboard.type('价格可以优惠');await p.keyboard.press('Enter');await p.waitForTimeout(500);
console.log('5 sent:',await p.evaluate(()=>sent.at(-1)));
// 6 select incoming message -> chip
await p.evaluate(()=>{const r=document.createRange();r.selectNodeContents(document.getElementById('msgin'));const s=getSelection();s.removeAllRanges();s.addRange(r);});
await p.mouse.move(50,40);await p.mouse.up();await p.waitForTimeout(100);
console.log('6 chip visible:',await p.evaluate(()=>getComputedStyle(document.getElementById('wat-chip')).display));
await p.click('#wat-chip');await p.waitForTimeout(300);console.log('6 chip:',await p.evaluate(()=>document.getElementById('wat-chip').innerText));
console.log('bar display:',await p.evaluate(()=>getComputedStyle(document.getElementById('wat-bar')).display));
await p.screenshot({path:'shot.png'});await b.close();})();
