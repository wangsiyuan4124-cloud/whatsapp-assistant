// 依次运行全部测试，打印每个测试的输出。用法：npm test
// 可用环境变量 SCRIPT 指定要测的脚本文件（默认 ../whatsapp-assistant.user.js）
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const tests = fs.readdirSync(__dirname).filter((f) => /^t\d\d-.*\.js$/.test(f)).sort();
let failed = 0;
for (const t of tests) {
  console.log('\n===== ' + t + ' =====');
  try {
    process.stdout.write(execFileSync(process.execPath, [path.join(__dirname, t)], { cwd: __dirname, encoding: 'utf8', timeout: 180000 }));
  } catch (e) {
    failed++;
    console.log((e.stdout || '') + (e.stderr || '') + '\n!!! FAILED: ' + t);
  }
}
console.log('\n' + (failed ? failed + ' 个测试失败' : '全部测试运行完成（请核对输出是否符合预期）'));
process.exit(failed ? 1 : 0);
