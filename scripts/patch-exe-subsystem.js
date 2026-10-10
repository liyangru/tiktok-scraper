/**
 * 把 pkg 产出的 exe 从「控制台子系统」改成「GUI 子系统」——双击不再弹黑色命令行窗口。
 * 只改 PE 可选头里的 Subsystem 字段（2 = GUI，3 = Console），不动其它任何字节。
 * 用法：node scripts/patch-exe-subsystem.js dist/tiktok-scraper.exe
 */
const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('用法: node patch-exe-subsystem.js <exe路径>');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error('文件不存在:', file);
  process.exit(1);
}

const buf = fs.readFileSync(file);

if (buf.readUInt16LE(0) !== 0x5a4d) {
  console.error('不是有效 PE（缺 MZ 头）');
  process.exit(1);
}
const e_lfanew = buf.readUInt32LE(0x3c);
if (buf.readUInt32LE(e_lfanew) !== 0x00004550) {
  console.error('不是有效 PE（缺 PE 签名）');
  process.exit(1);
}

const optOff = e_lfanew + 24; // PE签名(4) + COFF 头(20)
const magic = buf.readUInt16LE(optOff);
if (magic !== 0x10b && magic !== 0x20b) {
  console.error('未知可选头 magic:', magic.toString(16));
  process.exit(1);
}

const subOff = optOff + 68; // Optional Header 里 Subsystem 的偏移
const before = buf.readUInt16LE(subOff);
if (before === 2) {
  console.log('[patch-exe] 已是 GUI 子系统，无需改动');
  process.exit(0);
}
buf.writeUInt16LE(2, subOff); // IMAGE_SUBSYSTEM_WINDOWS_GUI
fs.writeFileSync(file, buf);
console.log(`[patch-exe] subsystem ${before} → 2 (GUI)，已去除控制台窗口`);
