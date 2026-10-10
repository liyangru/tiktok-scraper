/**
 * pkg 打包前的源码补丁（build:exe 会自动先跑本脚本）
 * ------------------------------------------------------------------
 * 背景：pkg 内置的 node 为了瘦身**剥离了 inspector 绑定**，而
 *   playwright-core / patchright-core 在初始化 page 模块时会「立即」
 *   require("inspector")，导致打出的 exe 一启动就崩：
 *     Error [ERR_INSPECTOR_NOT_AVAILABLE]
 *
 * 处理：把 require("inspector") 换成无害 stub。inspector 在原库里只用于
 *   page.pause() 调试 与 profiling，本抓取器完全用不到，替换绝对安全。
 *
 * 注意：本脚本会改动 node_modules 内的文件，所以「每次 npm install 之后、
 *   每次打包之前」都必须重新执行（build:exe 已内置这一步，保持用它即可）。
 */
const fs = require('fs');
const path = require('path');

const STUB =
  '(function(){return {Session:function(){this.connect=function(){};this.post=function(){};this.disconnect=function(){};},url:function(){return void 0;}};})()';

const targets = [
  'node_modules/playwright-core/lib/coreBundle.js',
  'node_modules/patchright-core/lib/coreBundle.js',
];

const root = path.join(__dirname, '..');
let changed = 0;

for (const rel of targets) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    console.log('  跳过（不存在）:', rel);
    continue;
  }
  const before = fs.readFileSync(file, 'utf8');
  let after = before
    .split('require("inspector")').join(STUB)
    .split("require('inspector')").join(STUB);
  if (after !== before) {
    fs.writeFileSync(file, after);
    changed++;
    console.log('  已打补丁:', rel);
  } else {
    console.log('  无需改动（已打或未匹配）:', rel);
  }
}

console.log(`[patch-pkg] 完成，改动 ${changed} 个文件。`);

/**
 * 补丁 2：强制 generator-function / async-function 走 CJS 入口
 * ------------------------------------------------------------------
 * 这两个包的 exports 里把 "module-sync" 指向 ./require.mjs（ESM）。pkg 的 ESM
 * 加载器无法从「虚拟快照」里解析 import，会报：
 *   ERR_MODULE_NOT_FOUND ... generator-function/index.js
 * 而它们的 index.js 就是等价的自包含 CJS 实现，直接把 main 指过去即可。
 */
const cjsPackages = [
  'node_modules/generator-function/package.json',
  'node_modules/async-function/package.json',
];
for (const rel of cjsPackages) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    console.log('  跳过（不存在）:', rel);
    continue;
  }
  const pj = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (pj.exports || pj.module || pj['jsnext:main']) {
    delete pj.exports;
    delete pj.module;
    delete pj['jsnext:main'];
    pj.main = './index.js';
    fs.writeFileSync(file, JSON.stringify(pj, null, 2) + '\n');
    console.log('  已改为 CJS 入口:', rel);
  } else {
    console.log('  无需改动:', rel);
  }
}

