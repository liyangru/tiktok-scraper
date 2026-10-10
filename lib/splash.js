/**
 * 启动画面（仅 exe 用）：极简黑白灰加载页 + 阶段进度 + 失败时显示原因。
 *
 * 为什么需要：exe 是 GUI 子系统（无控制台），启动期最长的一步是解压 Chromium，
 * 用户双击后可能十几秒没有任何反馈，像「没反应」；启动失败也完全不可见。
 *
 * 机制：bootstrap 先在本进程内起一个轻量 http 服务占住目标端口，
 * 浏览器窗口立刻打开这个加载页；主服务就绪后 splash 关闭、主服务在同一端口接管，
 * 加载页轮询到 /api/health 200 后自动跳转主界面。失败时页面显示错误与日志路径。
 */
const http = require('http');

const PAGE = (init) => `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>TikTok 数据抓取</title>
<style>
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#fbfbfb;
font-family:"Segoe UI","Microsoft YaHei",sans-serif;color:#111}
.box{text-align:center}
h1{font-size:16px;font-weight:650;margin:0 0 4px}
.sub{font-size:12px;color:#8a8a8a;margin-bottom:22px}
.bar{width:260px;height:3px;background:#ececec;border-radius:2px;margin:0 auto 14px;overflow:hidden}
.bar i{display:block;height:100%;width:30%;background:#111;border-radius:2px;animation:slide 1.1s ease-in-out infinite}
@keyframes slide{0%{margin-left:-30%}100%{margin-left:100%}}
#phase{font-size:12px;color:#3d3d3d;min-height:18px}
#err{display:none;margin-top:18px;text-align:left;width:520px;max-width:88vw;background:#fff;
border:1px solid #dcdcdc;border-radius:6px;padding:16px;font-size:12px;line-height:1.7}
#err b{color:#b42318}
#err code{display:block;margin-top:8px;padding:10px;background:#f7f7f7;border-radius:4px;
white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto;color:#3d3d3d}
.dots::after{content:'';animation:dots 1.2s steps(4,end) infinite}
@keyframes dots{0%{content:''}25%{content:'.'}50%{content:'..'}75%{content:'...'}}
</style></head><body><div class="box">
<h1>TikTok 数据抓取</h1><div class="sub">本机运行 · 数据不上云</div>
<div class="bar"><i></i></div>
<div id="phase" class="dots">${init || '正在启动'}</div>
<div id="go" style="display:none;margin-top:10px"><a id="golink" style="color:#111;font-weight:650;font-size:13px">主服务已就绪，点此进入 →</a></div>
<div id="err"><b>启动失败</b><div id="errmsg"></div><code id="errlog"></code></div>
</div>
<script>
const PH = document.getElementById('phase'), ER = document.getElementById('err');
async function poll() {
  try {
    const r = await fetch('/__splash', { cache: 'no-store' });
    const j = await r.json();
    if (j.phase) PH.textContent = j.phase;
    if (j.error) {
      PH.textContent = '';
      document.querySelector('.bar i').style.animationPlayState = 'paused';
      ER.style.display = 'block';
      document.getElementById('errmsg').textContent = j.error;
      document.getElementById('errlog').textContent = '详细日志：' + (j.logFile || '');
      return;
    }
    // 主服务就绪：splash 会把真实端口告诉我们（端口可能因占用而顺延）
    if (j.target) {
      const url = 'http://127.0.0.1:' + j.target + '/';
      try {
        const h = await fetch(url + 'api/health', { cache: 'no-store' });
        if (h.ok) { location.replace(url); return; }
      } catch (_) {}
      // 自动跳转失败也给一条明路：显示可点链接
      try {
        const g = document.getElementById('go'), a = document.getElementById('golink');
        a.href = url; g.style.display = 'block';
        document.getElementById('phase').textContent = '主服务已就绪';
      } catch (_) {}
    }
  } catch (_) {}
  setTimeout(poll, 700);
}
poll();
</script></body></html>`;

function createSplash() {
  const state = { phase: '正在启动', error: '', logFile: '', target: 0 };
  // 加载页用「临时端口」（0 = OS 分配空闲端口）：绝不和主服务抢目标端口。
  // 之前两者抢同一端口（Windows 允许同端口双绑），时序一乱页面就停在加载中。
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/__splash') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ phase: state.phase, error: state.error, logFile: state.logFile || '', target: state.target }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(PAGE(state.phase));
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      state.port = srv.address().port;
      resolve({
        port: state.port,
        set: (phase) => {
          state.phase = phase;
        },
        ready: (realPort) => {
          state.target = realPort; // 告诉加载页：主服务在哪个端口，页面自己跳过去
        },
        fail: (error, logFile) => {
          state.error = error;
          state.logFile = logFile;
          state.phase = '';
        },
        close: () => new Promise((done) => srv.close(() => done())),
      });
    });
  });
}

module.exports = { createSplash, PAGE };
