// 构建后给 dist/sw.js 注入构建版本号（时间戳），避免手动维护 CACHE_NAME
const fs = require('fs');
const path = require('path');

const distSw = path.join(__dirname, '..', 'dist', 'sw.js');
if (!fs.existsSync(distSw)) {
  console.error('未找到 dist/sw.js，请先运行 vite build');
  process.exit(1);
}

let content = fs.readFileSync(distSw, 'utf8');
const version = 'hp-pwa-v' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
content = content.replace(/hp-pwa-v__VERSION__/g, version);
fs.writeFileSync(distSw, content);
console.log('SW 版本号已注入:', version);
