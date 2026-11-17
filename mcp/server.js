#!/usr/bin/env node
/**
 * TikTok Scraper · MCP 服务（stdio，零依赖）
 *
 * 给 Claude Code / Codex / Claude Desktop 等 MCP 客户端用：不打开桌面应用，直接在对话里抓取和分析。
 * 协议：JSON-RPC 2.0，按行分隔（MCP stdio transport）。stdout 只输出协议消息，日志一律走 stderr。
 *
 * 抓取一般要 1–5 分钟，而客户端单次工具调用常有 60 秒左右的超时，所以抓取是「先启动、再查询」：
 *   start_scrape（最多等 wait_seconds 秒，没完成就返回任务 ID）→ get_scrape（继续等 / 取结果）
 */
const readline = require('readline');
const agent = require('../lib/agent');
const { rt } = agent;
const pkg = require('../package.json');

const WAIT_DEFAULT = 45; // 低于常见的 60 秒工具超时

const handlesSchema = { type: 'array', items: { type: 'string' }, description: 'TikTok 用户名，可带 @，最多 20 个' };
const waitSchema = { type: 'integer', minimum: 0, maximum: 55, description: `最多等待秒数，默认 ${WAIT_DEFAULT}；没完成就先返回进度` };

const TOOLS = [
  {
    name: 'start_scrape',
    description:
      '抓取一个或多个 TikTok 账号在某个日期区间发布的视频（播放、点赞、评论、分享、收藏、是否挂车），可同时抓对比期。' +
      '同一时间只跑一个浏览器，多个账号依次抓。完成时直接返回分析摘要；没完成返回任务 ID，用 get_scrape 继续查询。',
    inputSchema: {
      type: 'object',
      properties: {
        handles: handlesSchema,
        preset: {
          type: 'string',
          enum: ['today', 'yesterday', 'thisWeek', 'lastWeek', 'thisMonth', 'lastMonth', 'last7', 'last30', 'last90', 'all'],
          description: '快捷日期（曼谷时间）。和 from/to 二选一，都不填默认本月',
        },
        from: { type: 'string', description: '开始日期 YYYY-MM-DD' },
        to: { type: 'string', description: '结束日期 YYYY-MM-DD，不能晚于今天' },
        compare: {
          type: 'string',
          enum: ['none', 'previous', 'lastWeek', 'lastMonth', 'custom'],
          description: '对比期：不对比 / 上一周期（等长紧邻）/ 上周同期 / 上月同期（同日期）/ 自定义。默认不对比',
        },
        compare_from: { type: 'string', description: 'compare=custom 时的对比开始日期' },
        compare_to: { type: 'string', description: 'compare=custom 时的对比结束日期' },
        wait_seconds: waitSchema,
      },
      required: ['handles'],
    },
  },
  {
    name: 'get_scrape',
    description: '查询抓取任务：进行中返回各账号进度；完成返回分析摘要（汇总、各账号、对比期变化、挂车 vs 非挂车、最佳发布时段、TOP 视频）。',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: '任务 ID；不填则取最近一个任务' },
        wait_seconds: waitSchema,
        cart_mode: { type: 'string', enum: ['mean', 'trim'], description: '挂车对比口径：条均 / 剔除最高最低后的条均（样本 <3 条自动回退为条均）' },
        top: { type: 'integer', minimum: 1, maximum: 30, description: 'TOP 视频条数，默认 5' },
      },
    },
  },
  {
    name: 'list_videos',
    description: '列出某个任务的视频明细（排序 + 截断文案）。用于找爆款、看挂车视频、核对单条数据。',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: '任务 ID；不填则取最近一个已完成任务' },
        period: { type: 'string', enum: ['current', 'compare', 'all'], description: '本期 / 对比期 / 全部，默认本期' },
        sort: { type: 'string', enum: ['views', 'likes', 'comments', 'shares', 'saves', 'engagement', 'date'], description: '默认按播放' },
        cart_only: { type: 'boolean', description: '只看挂车视频' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: '默认 20' },
      },
    },
  },
  {
    name: 'list_scrapes',
    description: '历史抓取任务列表（和桌面应用共用同一份历史）。',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50, description: '默认 10' } } },
  },
  {
    name: 'export_report',
    description: '把任务导出成 Excel（多工作表：汇总、明细、对比、挂车分析）或 CSV 文件，返回文件路径。默认存到「下载」文件夹。',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: '任务 ID；不填则取最近一个已完成任务' },
        format: { type: 'string', enum: ['xlsx', 'csv'], description: '默认 xlsx' },
        path: { type: 'string', description: '保存路径（可选）' },
        lang: { type: 'string', enum: ['zh', 'th', 'en'], description: '表格语言，默认 zh' },
      },
    },
  },
  {
    name: 'stop_scrape',
    description: '停止正在进行的抓取，已抓完的账号数据保留。',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] },
  },
  {
    name: 'doctor',
    description: '检查运行环境（依赖、浏览器、数据目录）；缺什么会自动在后台安装。首次使用或报错时先调用它。',
    inputSchema: { type: 'object', properties: { install: { type: 'boolean', description: '缺依赖或浏览器时开始安装，默认 true' } } },
  },
];

/* ---------- 工具实现 ---------- */

function latest(store, finishedOnly) {
  const list = store.list(50);
  const j = finishedOnly ? list.find((x) => x.status === 'done' || x.status === 'stopped') : list[0];
  if (!j) throw new Error('还没有抓取任务，请先调用 start_scrape');
  return j.id;
}

const mine = new Set(); // 本进程启动的任务

const handlers = {
  async start_scrape(a) {
    const store = await agent.ensureReady();
    const job = store.create(agent.startParams({ ...a, source: 'mcp' }));
    mine.add(job.id);
    const r = await agent.waitFor(store, job.id, a.wait_seconds ?? WAIT_DEFAULT);
    return r.finished ? r.summary : { ...r.progress, next: `抓取进行中，稍后调用 get_scrape(job_id="${job.id}") 取结果` };
  },
  async get_scrape(a) {
    const store = await agent.ensureReady();
    const id = a.job_id || latest(store, false);
    const r = await agent.waitFor(store, id, a.wait_seconds ?? WAIT_DEFAULT, { cartMode: a.cart_mode, top: a.top });
    return r.finished ? r.summary : { ...r.progress, next: `还在抓取，继续调用 get_scrape(job_id="${id}")` };
  },
  async list_videos(a) {
    const store = await agent.ensureReady();
    const id = a.job_id || latest(store, true);
    return { job_id: id, videos: await agent.videos(store, id, { period: a.period, sort: a.sort, limit: a.limit, cartOnly: a.cart_only }) };
  },
  async list_scrapes(a) {
    const store = await agent.ensureReady();
    return store.list(a.limit || 10).map((j) => ({
      id: j.id,
      status: j.status,
      handles: j.handles,
      current: `${j.currentFrom} ~ ${j.currentTo}`,
      compare: j.compareFrom ? `${j.compareFrom} ~ ${j.compareTo}（${j.compareMode}）` : undefined,
      videos: j.rowCount,
      createdAt: j.createdAt,
      source: j.source,
    }));
  },
  async export_report(a) {
    const store = await agent.ensureReady();
    const id = a.job_id || latest(store, true);
    return { file: await agent.exportFile(store, id, a.format || 'xlsx', a.path, a.lang || 'zh') };
  },
  async stop_scrape(a) {
    const store = await agent.ensureReady();
    return agent.progress(store.stop(a.job_id));
  },
  async doctor(a) {
    if (a.install !== false) {
      try {
        await agent.ensureReady();
      } catch (_) {}
    }
    const d = rt.doctor();
    d.ready = d.depsReady && !!d.browser;
    if (!d.ready) d.hint = d.installingDeps || d.installingBrowser ? '正在后台安装，1–3 分钟后再调用 doctor 确认' : '可手动运行：npm run setup';
    return d;
  },
};

/* ---------- JSON-RPC over stdio ---------- */

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function onMessage(m) {
  const { id, method, params = {} } = m;
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: params.protocolVersion || '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'tiktok-scraper', title: 'TikTok Scraper', version: pkg.version },
          instructions:
            '抓取 TikTok 账号视频数据并做周期对比与挂车分析。流程：start_scrape → 没完成就 get_scrape 轮询 → 需要明细用 list_videos，要文件用 export_report。日期按曼谷时间。首次使用会自动安装依赖和浏览器，先调用 doctor 可确认环境。',
        });
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, { tools: TOOLS });
      case 'tools/call': {
        const h = handlers[params.name];
        if (!h) return fail(id, -32602, `未知工具：${params.name}`);
        try {
          const out = await h(params.arguments || {});
          return reply(id, { content: [{ type: 'text', text: JSON.stringify(out) }] });
        } catch (e) {
          const msg = e instanceof agent.NotReady ? e.message : `出错：${e.message || e}`;
          return reply(id, { content: [{ type: 'text', text: msg }], isError: true });
        }
      }
      case 'resources/list':
        return reply(id, { resources: [] });
      case 'prompts/list':
        return reply(id, { prompts: [] });
      default:
        if (isRequest) return fail(id, -32601, `不支持的方法：${method}`);
    }
  } catch (e) {
    if (isRequest) fail(id, -32603, e.message || String(e));
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let m;
  try {
    m = JSON.parse(line);
  } catch (_) {
    return fail(null, -32700, 'JSON 解析失败');
  }
  (Array.isArray(m) ? m : [m]).forEach(onMessage);
});
// 客户端断开：停掉本进程里的抓取并落盘（标记为已停止，已抓完的账号数据保留），再退出
rl.on('close', async () => {
  try {
    if (mine.size) {
      const store = rt.getStore();
      const live = [...mine].filter((id) => ['queued', 'running'].includes((store.get(id) || {}).status));
      live.forEach((id) => store.stop(id));
      const until = Date.now() + 8000;
      while (Date.now() < until && live.some((id) => ['queued', 'running', 'stopping'].includes((store.get(id) || {}).status))) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  } catch (_) {}
  process.exit(0);
});

// 启动时就在后台补齐依赖，第一次调用时更可能已经就绪
if (!rt.depsReady() && process.env.TT_NO_AUTO_INSTALL !== '1') {
  rt.installDeps().catch((e) => process.stderr.write(`[tiktok-scraper] 依赖安装失败：${e.message}\n`));
}
process.stderr.write(`[tiktok-scraper] MCP 已启动 v${pkg.version} · 数据目录 ${rt.BASE.dir}\n`);
