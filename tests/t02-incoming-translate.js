const {chromium}=require('playwright');const fs=require('fs');
(async()=>{const b=await chromium.launch();const p=await b.newPage();p.on('pageerror',e=>console.log('PAGEERR',e.message));
await p.goto('file://'+__dirname+'/page2.html');
await p.addScriptTag({content:fs.readFileSync((process.env.SCRIPT||require('path').join(__dirname,'..','whatsapp-assistant.user.js')),'utf8')});
await p.waitForTimeout(1500);
console.log(await p.evaluate(()=>[...document.querySelectorAll('[data-testid^=conv-msg-]')].map(r=>r.dataset.testid+': '+(r.querySelector('.wat-tr')?.textContent||'-'))));
console.log('reqs',await p.evaluate(()=>reqs.length),'lang now',await p.evaluate(()=>document.getElementById('wat-lang').value));
// add new incoming message dynamically
await p.evaluate(()=>{const d=document.querySelector('[data-testid=conv-msg-c]').cloneNode(true);d.dataset.testid='conv-msg-f';d.querySelector('.wat-tr')?.remove();d.querySelector('[data-testid=selectable-text]').textContent='When can you ship?';document.querySelector('#main').insertBefore(d,document.querySelector('footer'));});
await p.waitForTimeout(800);
console.log('new:',await p.evaluate(()=>document.querySelector('[data-testid=conv-msg-f] .wat-tr')?.textContent));
// simulate react rerender removing box
await p.evaluate(()=>document.querySelector('[data-testid=conv-msg-a] .wat-tr').remove());await p.waitForTimeout(800);
console.log('rerender restored:',await p.evaluate(()=>document.querySelector('[data-testid=conv-msg-a] .wat-tr')?.textContent),'reqs',await p.evaluate(()=>reqs.length));
// toggle off
await p.click('#wat-in');await p.waitForTimeout(200);console.log('hidden:',await p.evaluate(()=>document.querySelector('.wat-tr').style.display));
await p.click('#wat-in');
// send still works
await p.click('#main footer div[contenteditable]');await p.keyboard.type('好的');await p.keyboard.press('Enter');await p.waitForTimeout(500);
console.log('sent:',await p.evaluate(()=>sent));
await p.screenshot({path:'shot2.png'});await b.close();})();
