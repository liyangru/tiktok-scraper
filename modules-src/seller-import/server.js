/**
 * 模块：卖家中心导入与挂车分析
 *
 * ┌──────────────────────────────────────────────────────────────┐
 * │ 🚨 数据原则（用户明确要求，改这里之前先想想）                  │
 * │   TikTok 数据为主，卖家中心只做补充 —— 绝不能反过来。          │
 * │   1. TikTok 抓到的 = 真实视频量（真实发布的视频清单）          │
 * │   2. 卖家中心只补「商家指标」：GMV / 订单 / 商品点击 / GPM …    │
 * │   3. 不能以卖家中心为主：里面混着大量广告计划/混剪视频          │
 * │   4. 匹配键 = 视频ID                                          │
 * │      匹配上 → 挂车；TikTok 有卖家中心没有 → 没挂车；           │
 * │      卖家中心有 TikTok 没有 → 广告/混剪，必须剔除             │
 * │   5. 挂车 vs 非挂车对比要在日期范围内做                        │
 * └──────────────────────────────────────────────────────────────┘
 *
 * 卖家中心导出（Video_Performance_List_*.xlsx）实测结构：
 *   第 1 行 = 日期范围（合并单元格），第 3 行 = 表头（30 列），第 4 行起 = 数据。
 *   解析时按「表头名」定位列，不按列序号 —— 卖家中心改列序也不怕。
 */
const fs = require('fs');
const path = require('path');

const SELLER_DIR_NAME = 'data' + path.sep + 'seller';

/** 表头别名 → 规范化键（卖家中心叫法 → 内部字段） */
const COL = {
  vid: ['视频ID', '视频id', 'Video ID'],
  author: ['达人昵称', '达人'],
  authorId: ['达人ID'],
  videoInfo: ['视频信息'],
  publishTime: ['发布时间'],
  product: ['商品'],
  vv: ['VV', '播放量'],
  likes: ['点赞数'],
  comments: ['评论数'],
  shares: ['分享数'],
  newFans: ['新增粉丝数'],
  leads: ['引流次数'],
  productImpressions: ['商品曝光次数'],
  productClicks: ['商品点击次数'],
  uniqueCustomers: ['去重客户数'],
  attributedOrders: ['归因 SKU 订单数'],
  videoOrders: ['视频 SKU 订单数'],
  indirectOrders: ['视频间接 SKU 订单数'],
  attributedUnits: ['视频归因成交件数'],
  productUnits: ['视频商品成交件数'],
  indirectUnits: ['视频间接成交件数'],
  attributedGmv: ['视频归因 GMV (฿)', '视频归因 GMV'],
  gmv: ['视频 GMV (฿)', '视频 GMV'],
  indirectGmv: ['视频间接 GMV (฿)', '视频间接 GMV'],
  gpm: ['GPM (฿)', 'GPM'],
  ctr: ['点击率（视频）', '点击率'],
  leadRate: ['引流率'],
  completionRate: ['视频完播率', '完播率'],
  ctor: ['CTOR（SKU 订单）', 'CTOR'],
};

/** 数字化：卖家中心导出的数字常带千分位/百分号/฿ */
function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v).replace(/[฿,\s%]/g, '').trim();
  if (s === '' || s === '-') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 解析卖家中心 xlsx → { dateRange, rows: [{vid, ...}], headerRow } */
function parseWorkbook(ctx, buf) {
  const ExcelJS = ctx.core.exceljs;
  const wb = new ExcelJS.Workbook();
  // 保留原样读：numFmt 里的百分号我们自己做
  return wb.xlsx.load(buf).then((book) => {
    const ws = book.worksheets[0];
    if (!ws) throw new Error('xlsx 里没有工作表');

    // 1) 找表头行：包含「视频ID」的那一行
    let headerRow = -1;
    const headers = [];
    for (let r = 1; r <= Math.min(10, ws.rowCount); r++) {
      const vals = [];
      ws.getRow(r).eachCell({ includeEmpty: false }, (c) => vals.push(String(c.value ?? '').trim()));
      if (vals.some((v) => COL.vid.includes(v))) {
        headerRow = r;
        headers.push(...vals);
        break;
      }
    }
    if (headerRow < 0) throw new Error('找不到表头（需要含「视频ID」列）。请确认是卖家中心的「视频表现」导出。');

    // 2) 表头名 → 列号
    const colOf = {};
    for (const [key, names] of Object.entries(COL)) {
      const i = headers.findIndex((h) => names.includes(h));
      if (i >= 0) colOf[key] = i + 1; // exceljs 列从 1 起
    }
    if (!colOf.vid) throw new Error('表头里没有「视频ID」列，无法匹配');

    // 3) 日期范围（第 1 行合并单元格里的文本）
    let dateRange = '';
    try {
      const c = ws.getCell('A1');
      dateRange = String(c.value?.richText ? c.value.richText.map((x) => x.text).join('') : c.value ?? '').trim();
      // 去掉「[日期范围]: 」这类标签前缀，只留日期区间
      const dr = /[:：]\s*(.+)$/.exec(dateRange);
      if (dr) dateRange = dr[1].trim();
    } catch (_) {}

    // 4) 数据行
    const rows = [];
    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const get = (k) => (colOf[k] ? row.getCell(colOf[k]).value : null);
      const cellText = (k) => {
        const v = get(k);
        if (v === null || v === undefined) return '';
        if (v.richText) return v.richText.map((x) => x.text).join('');
        if (v.result !== undefined) return v.result; // 公式
        if (v.text) return v.text; // 超链接
        return v;
      };
      const vid = String(cellText('vid') || '').trim();
      if (!vid || !/^\d{6,}$/.test(vid)) continue; // 跳过空行/小计行
      rows.push({
        vid,
        author: String(cellText('author') || '').trim(),
        authorId: String(cellText('authorId') || '').trim(),
        videoInfo: String(cellText('videoInfo') || '').trim(),
        publishTime: String(cellText('publishTime') || '').trim(),
        product: String(cellText('product') || '').trim(),
        vv: toNum(cellText('vv')),
        likes: toNum(cellText('likes')),
        comments: toNum(cellText('comments')),
        shares: toNum(cellText('shares')),
        newFans: toNum(cellText('newFans')),
        leads: toNum(cellText('leads')),
        productImpressions: toNum(cellText('productImpressions')),
        productClicks: toNum(cellText('productClicks')),
        uniqueCustomers: toNum(cellText('uniqueCustomers')),
        attributedOrders: toNum(cellText('attributedOrders')),
        videoOrders: toNum(cellText('videoOrders')),
        indirectOrders: toNum(cellText('indirectOrders')),
        attributedUnits: toNum(cellText('attributedUnits')),
        productUnits: toNum(cellText('productUnits')),
        indirectUnits: toNum(cellText('indirectUnits')),
        attributedGmv: toNum(cellText('attributedGmv')),
        gmv: toNum(cellText('gmv')),
        indirectGmv: toNum(cellText('indirectGmv')),
        gpm: toNum(cellText('gpm')),
        ctr: toNum(cellText('ctr')),
        leadRate: toNum(cellText('leadRate')),
        completionRate: toNum(cellText('completionRate')),
        ctor: toNum(cellText('ctor')),
      });
    }
    return { dateRange, headerRow, rows };
  });
}

module.exports = {
  register(app, ctx) {
    const { core, config, log } = ctx;
    const SELLER_DIR = path.join(ctx.baseDir, 'data', 'seller');
    ensureDir(SELLER_DIR);

    const listFiles = () =>
      fs
        .readdirSync(SELLER_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          try {
            const j = JSON.parse(fs.readFileSync(path.join(SELLER_DIR, f), 'utf8'));
            return { file: f, dateRange: j.dateRange || '', rows: (j.rows || []).length, importedAt: j.importedAt };
          } catch (_) {
            return null;
          }
        })
        .filter(Boolean);

    /** 上传（body = xlsx 原始字节） */
    app.post('/api/seller-import/upload', async (req, res) => {
      try {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const buf = Buffer.concat(chunks);
        if (!buf.length) return res.status(400).json({ error: '没有收到文件内容' });

        const parsed = await parseWorkbook(ctx, buf);
        if (!parsed.rows.length) return res.status(400).json({ error: '解析到 0 行数据，请确认文件内容' });

        const name = `${Date.now()}-${parsed.rows.length}.json`;
        const record = {
          importedAt: new Date().toISOString(),
          dateRange: parsed.dateRange,
          rows: parsed.rows,
        };
        fs.writeFileSync(path.join(SELLER_DIR, name), JSON.stringify(record));
        log(`导入卖家中心数据 ${parsed.rows.length} 条（${parsed.dateRange}）`);
        res.json({ ok: true, file: name, dateRange: parsed.dateRange, count: parsed.rows.length, all: listFiles() });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    app.get('/api/seller-import/files', (req, res) => res.json({ files: listFiles() }));

    app.delete('/api/seller-import/files/:name', (req, res) => {
      const f = path.basename(req.params.name);
      const p = path.join(SELLER_DIR, f);
      if (fs.existsSync(p)) fs.rmSync(p);
      res.json({ ok: true, all: listFiles() });
    });

    /**
     * 交叉分析：把某次抓取任务（TikTok 为主）与导入的卖家中心数据按 视频ID 对齐。
     * 返回三份名单 + 对比指标，并顺带校验 item_list 的 isECVideo 是否与卖家中心一致。
     */
    app.post('/api/seller-import/analyze', async (req, res) => {
      const jobId = req.body && req.body.jobId;
      const file = req.body && req.body.file;
      if (!jobId) return res.status(400).json({ error: '缺少 jobId' });

      const jobPath = path.join(ctx.dataDir, `${jobId}.json`);
      if (!fs.existsSync(jobPath)) return res.status(404).json({ error: `找不到任务 ${jobId}` });
      const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
      // ⚠️ 任务落盘存的是 results（原始 item 数组），扁平行要用核心的 toRows 现场算
      const tiktokRows = core.report.toRows(job.results || []);

      // 选卖家中心数据：指定文件，否则用最新一份
      const files = listFiles();
      if (!files.length) return res.status(400).json({ error: '还没导入过卖家中心数据' });
      const chosen = file ? files.find((f) => f.file === file) : files[files.length - 1];
      if (!chosen) return res.status(404).json({ error: `找不到卖家中心文件 ${file}` });
      const rec = JSON.parse(fs.readFileSync(path.join(SELLER_DIR, chosen.file), 'utf8'));
      const sellerMap = new Map((rec.rows || []).map((r) => [r.vid, r]));

      // 对齐
      const carted = []; // 挂车（TikTok ∩ 卖家中心）
      const nonCarted = []; // 没挂车（TikTok 有，卖家中心没有）
      const sellerOnly = []; // 卖家中心独有 → 广告/混剪，剔除
      let flagAgree = 0;
      let flagDisagree = 0;
      const disagreements = [];

      for (const r of tiktokRows) {
        const vid = String(r.vid || '').trim();
        const s = sellerMap.get(vid);
        if (s) {
          carted.push({ ...r, seller: s, isEC: true });
          if (r.isEC === true) flagAgree++;
          else { flagDisagree++; disagreements.push({ vid, tiktokFlag: !!r.isEC }); }
        } else {
          nonCarted.push({ ...r, isEC: false });
          if (r.isEC === false) flagAgree++;
          else { flagDisagree++; disagreements.push({ vid, tiktokFlag: !!r.isEC }); }
        }
      }
      const tiktokVids = new Set(tiktokRows.map((r) => String(r.vid || '').trim()));
      for (const s of rec.rows || []) {
        if (!tiktokVids.has(s.vid)) sellerOnly.push(s);
      }

      // 日期范围内对比（TikTok 行自带 date）
      const from = req.body.from;
      const to = req.body.to;
      const inRange = (r) => (!from || r.date >= from) && (!to || r.date <= to);
      const cRows = carted.filter(inRange);
      const nRows = nonCarted.filter(inRange);

      // 指标：沿用核心 agg，再叠商家指标
      const sum = (rows, k) => rows.reduce((t, r) => t + (Number((r.seller || r)[k]) || 0), 0);
      const aggOf = (rows) => {
        const a = core.report.agg(rows);
        return {
          ...a,
          gmv: sum(rows, 'gmv'),
          orders: sum(rows, 'videoOrders'),
          productClicks: sum(rows, 'productClicks'),
          gpm: rows.length ? Number((sum(rows, 'gmv') / (rows.reduce((t, r) => t + (Number(r.views) || 0), 0) / 1000)).toFixed(2)) : 0,
        };
      };
      const ec = aggOf(cRows);
      const non = aggOf(nRows);
      const metrics = ['n', 'tv', 'avg', 'med', 'max', 'avgLikes', 'avgComments', 'avgShares', 'avgSaves', 'avgReposts', 'avgDuration', 'inter', 'gmv', 'orders', 'productClicks', 'gpm'];

      res.json({
        ok: true,
        file: chosen.file,
        dateRange: rec.dateRange || '',
        counts: {
          tiktok: tiktokRows.length,
          carted: carted.length,
          nonCarted: nonCarted.length,
          sellerOnly: sellerOnly.length,
          sellerOnlyNote: '卖家中心有、TikTok 没有 → 广告计划/混剪，已按规则剔除',
        },
        flagCheck: { agree: flagAgree, disagree: flagDisagree, disagreements: disagreements.slice(0, 20) },
        compare: { metrics, ec, non },
        carted: carted.map((r) => ({ ...r, seller: undefined, ...r.seller })),
        sellerOnly: sellerOnly.slice(0, 200),
        dateRangeApplied: { from: from || '', to: to || '' },
      });
    });

    log('卖家中心导入模块已挂载：/api/seller-import/*');
  },
};
