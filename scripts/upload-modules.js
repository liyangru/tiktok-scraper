/**
 * 一键把模块包上传到 GitHub 仓库的 modules/ 目录。
 *
 * 为什么需要：WorkBuddy 的 GitHub 连接器对仓库只有**读**权限
 * （写入报 403 `Resource not accessible by integration`），所以模块分发只能靠本脚本由用户本人推上去。
 * 模块包已经内置在 exe 里（extraResources/modules-dist），这条通道只是「远端兜底」——
 * 用户机器上内置源缺失时，应用会回落去 GitHub 下载。
 *
 * 用法（需要 PAT，勾选 repo 权限）：
 *   Windows  : set GITHUB_TOKEN=ghp_xxx && node scripts/upload-modules.js
 *   macOS/Lin: GITHUB_TOKEN=ghp_xxx node scripts/upload-modules.js
 *
 * 可选环境变量：
 *   GH_OWNER（默认 liyangru）  GH_REPO（默认 tiktok-scraper）  GH_BRANCH（默认 master）
 *
 * 只上传索引里引用的那些包；仓库里更早版本的 tar.gz 保留不动（和 Release/tag 一样，不主动删旧版）。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const OWNER = process.env.GH_OWNER || 'liyangru';
const REPO = process.env.GH_REPO || 'tiktok-scraper';
const BRANCH = process.env.GH_BRANCH || 'master';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

const API = 'https://api.github.com';

function api(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = https.request(
      API + urlPath,
      {
        method,
        headers: {
          Authorization: 'Bearer ' + TOKEN,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'tiktok-scraper-upload',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          'Content-Length': payload ? payload.length : 0,
        },
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          let j = null;
          try { j = JSON.parse(b); } catch (_) {}
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(j || {});
          else reject(new Error(`${method} ${urlPath} -> ${res.statusCode} ${j && j.message ? j.message : b.slice(0, 200)}`));
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 取文件当前 blob sha（不存在则返回 null） */
async function existingSha(repoPath) {
  try {
    const j = await api('GET', `/repos/${OWNER}/${REPO}/contents/${repoPath}?ref=${encodeURIComponent(BRANCH)}`);
    return j && j.sha ? j.sha : null;
  } catch (e) {
    if (/-> 404/.test(e.message)) return null;
    throw e;
  }
}

/** 上传/更新一个文件；content 为 Buffer，内部自动 base64 */
async function put(repoPath, buf, message) {
  const sha = await existingSha(repoPath);
  const body = {
    message,
    branch: BRANCH,
    content: buf.toString('base64'),
  };
  if (sha) body.sha = sha;
  const j = await api('PUT', `/repos/${OWNER}/${REPO}/contents/${repoPath}`, body);
  return j && j.commit ? j.commit.sha : '(ok)';
}

(async () => {
  if (!TOKEN) {
    console.error('缺少 GITHUB_TOKEN。到 https://github.com/settings/tokens 生成一个勾选 repo 权限的 PAT，然后：');
    console.error('  Windows  : set GITHUB_TOKEN=ghp_xxx && node scripts/upload-modules.js');
    console.error('  macOS/Lin: GITHUB_TOKEN=ghp_xxx node scripts/upload-modules.js');
    process.exit(1);
  }

  // 索引决定「哪些包该在远端」：生产索引（绝对地址）放在仓库里供 lib/modules.js 远端分支用
  const indexFile = path.join(ROOT, 'modules', 'index.json');
  if (!fs.existsSync(indexFile)) {
    console.error('没有 modules/index.json，先跑 node scripts/build-modules.js');
    process.exit(1);
  }
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));

  const jobs = [{ repoPath: 'modules/index.json', file: indexFile, msg: 'chore(modules): 更新模块索引' }];
  for (const m of index.modules) {
    const file = path.join(ROOT, 'modules', path.basename(m.url));
    if (!fs.existsSync(file)) {
      console.error(`包缺失: ${file}（先跑 node scripts/build-modules.js）`);
      process.exit(1);
    }
    jobs.push({ repoPath: `modules/${path.basename(m.url)}`, file, msg: `chore(modules): ${m.id}@${m.version}` });
  }

  console.log(`目标: ${OWNER}/${REPO}@${BRANCH}  ·  待上传 ${jobs.length} 个文件`);
  for (const j of jobs) {
    const buf = fs.readFileSync(j.file);
    try {
      const sha = await put(j.repoPath, buf, j.msg);
      console.log(`  ✅ ${j.repoPath}  (${(buf.length / 1024).toFixed(1)} KB)  commit ${String(sha).slice(0, 7)}`);
    } catch (e) {
      console.error(`  ❌ ${j.repoPath}  ${e.message}`);
      process.exit(1);
    }
  }
  console.log('\n完成。远端索引地址：');
  console.log(`  https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/modules/index.json`);
})().catch((e) => {
  console.error('上传失败:', e.message);
  process.exit(1);
});
