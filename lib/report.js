/**
 * 报表生成：把抓取结果转成扁平行 + Excel(xlsx) + CSV
 * 视觉风格：极简黑白灰 —— 关网格线、灰阶斑马、黑色 medium 分隔线，层次靠字重和灰阶。
 */
const ExcelJS = require('exceljs');

const TZ_OFFSET_MS = 7 * 3600 * 1000; // 曼谷 GMT+7

const C = {
  black: 'FF000000',
  dark: 'FF3F3F3F',
  gray: 'FF7F7F7F',
  line: 'FFDCDCDC',
  hdr: 'FFF2F2F2',
  zebra: 'FFF7F7F7',
  white: 'FFFFFFFF',
};
const FONT = '微软雅黑';
/* 周几：0=周日 … 6=周六 */
const WEEKS = {
  zh: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
  th: ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
};

/* Excel 表头文案（按语言） */
const XLS = {
  zh: {
    sheets: ['账号汇总', '视频明细', '播放量TOP20', '挂车对比'],
    monthly: '月度分布',
    total: '合计',
    dash: '—',
    h1: ['账号', '昵称', '粉丝数', '主页视频数', '区间内条数', '总播放量', '平均播放', '中位播放', '最高播放', '总点赞', '总收藏', '总转发', '整体互动率'],
    h2: ['序号', '账号', '昵称', '发布月份', '发布日期', '星期', '发布时间', '视频文案', '时长(秒)', '播放量', '点赞', '评论', '分享', '收藏', '转发', '互动率', '话题标签', '视频链接', '视频ID', '挂车'],
    h3: ['排名', '账号', '发布日期', '视频文案', '播放量', '点赞', '评论', '分享', '收藏', '互动率', '时长(秒)', '月份', '视频链接'],
    t3: (n) => `${n}月`,
    yes: '是',
    ecTitle: '挂车视频 vs 非挂车视频',
    ecHead: ['指标', '挂车视频', '非挂车视频', '差异'],
    ecRows: ['条数', '总播放量', '平均播放', '中位播放', '最高播放', '平均点赞', '平均评论', '平均分享', '平均收藏', '平均转发', '平均时长(秒)', '互动率'],
  },
  th: {
    sheets: ['ภาพรวมบัญชี', 'รายละเอียดวิดีโอ', '20 อันดับวิว', 'เปรียบเทียบตะกร้า'],
    monthly: 'การกระจายรายเดือน',
    total: 'รวม',
    dash: '—',
    h1: ['บัญชี', 'ชื่อเล่น', 'ผู้ติดตาม', 'วิดีโอทั้งหมด', 'จำนวนในช่วง', 'วิวรวม', 'วิวเฉลี่ย', 'วิวค่ากลาง', 'วิวสูงสุด', 'ไลก์รวม', 'บันทึกรวม', 'รีโพสต์รวม', 'อัตรามีส่วนร่วม'],
    h2: ['ลำดับ', 'บัญชี', 'ชื่อเล่น', 'เดือนที่โพสต์', 'วันที่', 'วัน', 'เวลา', 'คำบรรยาย', 'ความยาว(วิ)', 'วิว', 'ไลก์', 'คอมเมนต์', 'แชร์', 'บันทึก', 'รีโพสต์', 'มีส่วนร่วม', 'แฮชแท็ก', 'ลิงก์วิดีโอ', 'ID วิดีโอ', 'ตะกร้า'],
    h3: ['ลำดับ', 'บัญชี', 'วันที่', 'คำบรรยาย', 'วิว', 'ไลก์', 'คอมเมนต์', 'แชร์', 'บันทึก', 'มีส่วนร่วม', 'ความยาว(วิ)', 'เดือน', 'ลิงก์วิดีโอ'],
    t3: (n) => `${n} เดือน`,
    yes: 'มี',
    ecTitle: 'วิดีโอติดตะกร้า vs ไม่ติดตะกร้า',
    ecHead: ['ตัวชี้วัด', 'ติดตะกร้า', 'ไม่ติดตะกร้า', 'ต่าง'],
    ecRows: ['จำนวน', 'วิวรวม', 'วิวเฉลี่ย', 'วิวค่ากลาง', 'วิวสูงสุด', 'ไลก์เฉลี่ย', 'คอมเมนต์เฉลี่ย', 'แชร์เฉลี่ย', 'บันทึกเฉลี่ย', 'รีโพสต์เฉลี่ย', 'ความยาวเฉลี่ย(วิ)', 'มีส่วนร่วม'],
  },
  en: {
    sheets: ['Account Summary', 'Video Details', 'Top 20 by Views', 'Cart vs Non-cart'],
    monthly: 'Monthly Distribution',
    total: 'Total',
    dash: '—',
    h1: ['Account', 'Nickname', 'Followers', 'Total videos', 'Items in range', 'Total views', 'Avg views', 'Median views', 'Max views', 'Total likes', 'Total saves', 'Total reposts', 'Engagement'],
    h2: ['No.', 'Account', 'Nickname', 'Month', 'Date', 'Weekday', 'Time', 'Caption', 'Duration(s)', 'Views', 'Likes', 'Comments', 'Shares', 'Saves', 'Reposts', 'Engage', 'Hashtags', 'Video URL', 'Video ID', 'Shopping'],
    h3: ['Rank', 'Account', 'Date', 'Caption', 'Views', 'Likes', 'Comments', 'Shares', 'Saves', 'Engage', 'Duration(s)', 'Month', 'Video URL'],
    t3: (n) => `M${n}`,
    yes: 'Yes',
    ecTitle: 'Shopping videos vs non-shopping videos',
    ecHead: ['Metric', 'Shopping', 'Non-shopping', 'Diff'],
    ecRows: ['Items', 'Total views', 'Avg views', 'Median views', 'Max views', 'Avg likes', 'Avg comments', 'Avg shares', 'Avg saves', 'Avg reposts', 'Avg duration(s)', 'Engagement'],
  },
};
function getXlsDict(lang) {
  return XLS[lang] || XLS.zh;
}

const g = (d, ...ks) => {
  let cur = d;
  for (const k of ks) {
    if (!cur || typeof cur !== 'object') return 0;
    cur = cur[k];
    if (cur === undefined || cur === null) return 0;
  }
  return cur;
};

/** 统一成数字：statsV2 的值是字符串，stats 的是数字，都要能吃 */
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** 从 video 对象里挑播放地址（playAddr 可能是字符串，也可能是 {UrlList:[...]}） */
function pickPlayUrl(v) {
  if (!v) return '';
  for (const cand of [v.playAddr, v.downloadAddr]) {
    if (!cand) continue;
    if (typeof cand === 'string') return cand;
    const list = cand.UrlList || cand.urlList;
    if (Array.isArray(list) && list.length) return list[0];
  }
  return '';
}

/**
 * 真实可用的最高清晰度。
 * ⚠️ video.definition 只是「网页播放」用的档位（常年 540p），不是源片质量；
 *    真实可用档位在 bitrateInfo[].GearName 里（形如 normal_1080 / lower_720）。
 */
function bestQuality(v) {
  if (!v) return '';
  const bi = v.bitrateInfo;
  if (Array.isArray(bi) && bi.length) {
    let best = null;
    for (const b of bi) {
      if (!best || num(b.Bitrate) > num(best.Bitrate)) best = b;
    }
    const m = /(\d{3,4})/.exec((best && best.GearName) || '');
    if (m) return m[1] + 'p';
  }
  return v.definition || v.ratio || '';
}

/** 可下载的清晰度档位列表（下载功能用），按码率从高到低 */
function qualityList(v) {
  const bi = v && v.bitrateInfo;
  if (!Array.isArray(bi) || !bi.length) return [];
  return [...bi]
    .map((b) => ({
      gear: b.GearName || '',
      bitrate: num(b.Bitrate),
      quality: b.QualityType || '',
      size: num(g(b, 'PlayAddr', 'DataSize')),
      url: (() => {
        const pa = b.PlayAddr;
        if (!pa) return '';
        const list = pa.UrlList || pa.urlList;
        return Array.isArray(list) && list.length ? list[0] : '';
      })(),
    }))
    .sort((a, b) => b.bitrate - a.bitrate);
}

/** 把账号结果拍平成行 */
function toRows(accounts) {
  const rows = [];
  for (const acc of accounts) {
    for (const it of acc.items) {
      const d = new Date(it.createTime * 1000 + TZ_OFFSET_MS); // 转成曼谷墙上时间
      // ⚠️ 优先用 statsV2：它比 stats 多一个 repostCount（转发数）
      const st = it.statsV2 || it.stats || {};
      const views = num(g(st, 'playCount'));
      const likes = num(g(st, 'diggCount'));
      const comments = num(g(st, 'commentCount'));
      const shares = num(g(st, 'shareCount'));
      const saves = num(g(st, 'collectCount'));
      const reposts = num(g(st, 'repostCount'));
      const tags = (it.textExtra || []).map((t) => t.hashtagName).filter(Boolean);
      const mv = it.video || {};
      const mu = it.music || {};
      const playUrl = pickPlayUrl(mv);
      rows.push({
        account: acc.handle,
        nickname: acc.nickname,
        month: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
        date: d.toISOString().slice(0, 10),
        wd: d.getUTCDay(),
        time: d.toISOString().slice(11, 16),
        desc: (it.desc || '').replace(/\n/g, ' ').trim(),
        url: `https://www.tiktok.com/@${acc.handle}/video/${it.id}`,
        duration: num(g(mv, 'duration')),
        views,
        likes,
        comments,
        shares,
        saves,
        reposts,
        inter: views ? (likes + comments + shares + saves + reposts) / views : 0,
        tags: tags.map((t) => '#' + t).join(' '),
        /* ---- 新增字段 ---- */
        vid: mv.id || String(it.id || ''), // 视频 ID（下载用）
        playUrl, // 播放地址（item_list 里约 4 成视频有，其余为空 → 下载时要补）
        lang: it.textLanguage || '',
        isEC: !!it.isECVideo, // 挂车视频
        isAd: !!it.isAd,
        isAIGC: !!it.ShowAIGC,
        music: mu.title ? `${mu.title}${mu.authorName ? ' · ' + mu.authorName : ''}` : '',
        musicOriginal: !!mu.original,
        resolution: bestQuality(mv),
        qualities: qualityList(mv), // 可下载档位（下载功能用，不进表格）
      });
    }
  }
  rows.sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1));
  return rows;
}

function agg(rows) {
  const v = rows.map((r) => r.views);
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  const tv = sum('views');
  const sorted = [...v].sort((a, b) => a - b);
  const med = sorted.length
    ? sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
    : 0;
  const lk = sum('likes');
  const cm = sum('comments');
  const sh = sum('shares');
  const sv = sum('saves');
  const rp = sum('reposts');
  const du = sum('duration');
  const n = rows.length;
  const av = (t) => (n ? Math.round(t / n) : 0);
  return {
    n,
    tv,
    avg: n ? Math.round(tv / n) : 0,
    med,
    max: v.length ? Math.max(...v) : 0,
    likes: lk,
    comments: cm,
    shares: sh,
    saves: sv,
    reposts: rp,
    inter: tv ? (lk + cm + sh + sv + rp) / tv : 0,
    /* 均值指标 —— 挂车对比 / 品牌汇总都要用 */
    avgLikes: av(lk),
    avgComments: av(cm),
    avgShares: av(sh),
    avgSaves: av(sv),
    avgReposts: av(rp),
    avgDuration: av(du),
    /* 挂车维度 */
    ecN: rows.filter((r) => r.isEC).length,
    ecViews: rows.filter((r) => r.isEC).reduce((s, r) => s + r.views, 0),
    nonEcN: rows.filter((r) => !r.isEC).length,
    nonEcViews: rows.filter((r) => !r.isEC).reduce((s, r) => s + r.views, 0),
  };
}

/** 挂车 vs 非挂车对比（两列 agg + 相对差异） */
function ecCompare(rows) {
  const ec = agg(rows.filter((r) => r.isEC));
  const non = agg(rows.filter((r) => !r.isEC));
  return { ec, non };
}

/** 挂车对比要展示的指标（顺序即表格顺序，与 XLS[*].ecRows 一一对应） */
const EC_METRICS = [
  'n', 'tv', 'avg', 'med', 'max',
  'avgLikes', 'avgComments', 'avgShares', 'avgSaves', 'avgReposts',
  'avgDuration', 'inter',
];

const f = (size, bold, color) => ({ name: FONT, size, bold: !!bold, color: { argb: color } });
const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thin = { style: 'thin', color: { argb: C.line } };
const med = { style: 'medium', color: { argb: C.black } };
const boxBorder = { top: thin, left: thin, bottom: thin, right: thin };

/** 生成 Excel（lang: zh / th / en） */
async function buildWorkbook({ rows, accounts, title, rangeLabel, lang = 'zh' }) {
  const D = getXlsDict(lang);
  const W = WEEKS[lang] || WEEKS.zh;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TikTok Scraper';
  wb.created = new Date();

  // ---------- Sheet 1 账号汇总 ----------
  const ws = wb.addWorksheet(D.sheets[0]);
  ws.views = [{ showGridLines: false }];
  ws.mergeCells('A1:M1');
  ws.getCell('A1').value = title;
  ws.getCell('A1').font = f(14, true, C.black);
  ws.getRow(1).height = 26;
  ws.mergeCells('A2:M2');
  ws.getCell('A2').value = `${D.h1[2]} ${accounts.reduce((s, a) => s + (g(a.stats, 'followerCount') || 0), 0)} · ${D.total} ${rows.length} · ${rangeLabel} · ${new Date().toLocaleString(
    'zh-CN',
    { timeZone: 'Asia/Bangkok' }
  )} (GMT+7)`;
  ws.getCell('A2').font = f(9, false, C.gray);
  ws.getRow(2).height = 18;

  const h1 = D.h1;
  const hr = ws.getRow(3);
  h1.forEach((h, i) => {
    const c = hr.getCell(i + 1);
    c.value = h;
    c.font = f(10, true, C.black);
    c.fill = fill(C.hdr);
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.border = { top: med, bottom: med, left: thin, right: thin };
  });
  hr.height = 30;

  let r = 4;
  accounts.forEach((acc, i) => {
    const rs = rows.filter((x) => x.account === acc.handle);
    const a = agg(rs);
    const vals = [
      acc.handle,
      acc.nickname || '',
      g(acc.stats, 'followerCount') || '',
      g(acc.stats, 'videoCount') || '',
      a.n,
      a.tv,
      a.avg,
      a.med,
      a.max,
      a.likes,
      a.saves,
      a.reposts,
      a.inter,
    ];
    const row = ws.getRow(r);
    vals.forEach((v, ci) => {
      const c = row.getCell(ci + 1);
      c.value = v;
      c.font = f(10, false, C.dark);
      c.border = boxBorder;
      if (i % 2) c.fill = fill(C.zebra);
      if (ci === 12) {
        c.numFmt = '0.00%';
        c.alignment = { horizontal: 'center', vertical: 'middle' };
      } else if (ci === 0 || ci === 1) {
        c.alignment = { horizontal: 'left', vertical: 'middle' };
      } else {
        c.alignment = { horizontal: 'right', vertical: 'middle' };
        if (ci >= 2) c.numFmt = '#,##0';
      }
    });
    row.height = 22;
    r++;
  });

  const tot = agg(rows);
  const tr = ws.getRow(r);
  [D.total, D.dash, '', '', tot.n, tot.tv, tot.avg, tot.med, tot.max, tot.likes, tot.saves, tot.reposts, tot.inter].forEach((v, ci) => {
    const c = tr.getCell(ci + 1);
    c.value = v;
    c.font = f(10, true, C.black);
    c.fill = fill(C.hdr);
    c.border = { top: med, bottom: med, left: thin, right: thin };
    if (ci === 12) {
      c.numFmt = '0.00%';
      c.alignment = { horizontal: 'center', vertical: 'middle' };
    } else if (ci >= 4) {
      c.numFmt = '#,##0';
      c.alignment = { horizontal: 'right', vertical: 'middle' };
    } else {
      c.alignment = { horizontal: 'center', vertical: 'middle' };
    }
  });
  tr.height = 24;
  r += 2;

  // 月度 × 账号
  ws.mergeCells(r, 1, r, 13);
  ws.getCell(r, 1).value = D.monthly;
  ws.getCell(r, 1).font = f(12, true, C.black);
  r++;
  const months = [...new Set(rows.map((x) => x.month))].sort();
  const mh = ws.getRow(r);
  [D.h2[3], ...accounts.map((a) => a.handle), D.total].forEach((h, i) => {
    const c = mh.getCell(i + 1);
    c.value = h;
    c.font = f(10, true, C.black);
    c.fill = fill(C.hdr);
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    c.border = { top: med, bottom: med, left: thin, right: thin };
  });
  r++;
  for (const m of months) {
    const row = ws.getRow(r);
    const vals = [D.t3(parseInt(m.split('-')[1], 10))];
    let t = 0;
    for (const a of accounts) {
      const n = rows.filter((x) => x.account === a.handle && x.month === m).length;
      vals.push(n);
      t += n;
    }
    vals.push(t);
    vals.forEach((v, ci) => {
      const c = row.getCell(ci + 1);
      c.value = v;
      c.font = f(10, false, C.dark);
      c.border = boxBorder;
      c.alignment = { horizontal: 'center', vertical: 'middle' };
    });
    row.height = 22;
    r++;
  }

  [22, 30, 12, 13, 13, 13, 12, 12, 12, 11, 11, 11, 12].forEach((w, i) => (ws.getColumn(i + 1).width = w));

  // ---------- Sheet 2 全量明细 ----------
  const ws2 = wb.addWorksheet(D.sheets[1]);
  ws2.views = [{ showGridLines: false }];
  ws2.mergeCells('A1:T1');
  ws2.getCell('A1').value = `${title} · 视频明细`;
  ws2.getCell('A1').font = f(14, true, C.black);
  ws2.getRow(1).height = 26;

  const h2 = D.h2;
  const hr2 = ws2.getRow(2);
  h2.forEach((h, i) => {
    const c = hr2.getCell(i + 1);
    c.value = h;
    c.font = f(10, true, C.black);
    c.fill = fill(C.hdr);
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.border = { top: med, bottom: med, left: thin, right: thin };
  });
  hr2.height = 28;

  rows.forEach((x, i) => {
    const row = ws2.getRow(3 + i);
    const vals = [
      i + 1, x.account, x.nickname, x.month, x.date, W[x.wd], x.time, x.desc, x.duration,
      x.views, x.likes, x.comments, x.shares, x.saves, x.reposts, x.inter, x.tags, x.url,
      x.vid, x.isEC ? D.yes : D.dash,
    ];
    vals.forEach((v, ci) => {
      const c = row.getCell(ci + 1);
      c.value = v;
      c.font = f(9.5, false, C.dark);
      c.border = boxBorder;
      if (i % 2) c.fill = fill(C.zebra);
      const n = ci + 1;
      if ([1, 2, 3, 4, 5, 6, 7, 9, 20].includes(n)) c.alignment = { horizontal: 'center', vertical: 'middle' };
      else if (n >= 10 && n <= 15) {
        c.alignment = { horizontal: 'right', vertical: 'middle' };
        c.numFmt = '#,##0';
      } else if (n === 16) {
        c.alignment = { horizontal: 'center', vertical: 'middle' };
        c.numFmt = '0.00%';
      } else if (n === 18) {
        c.font = { name: FONT, size: 9, color: { argb: C.gray }, underline: true };
        c.value = { text: x.url, hyperlink: x.url };
      } else c.alignment = { horizontal: 'left', vertical: 'middle' };
      // 挂车列加粗一点，方便扫
      if (n === 20 && x.isEC) c.font = f(9.5, true, C.black);
    });
    row.height = 20;
  });

  [6, 22, 26, 10, 12, 7, 9, 50, 9, 11, 10, 9, 9, 9, 9, 9, 24, 48, 22, 8].forEach(
    (w, i) => (ws2.getColumn(i + 1).width = w)
  );
  ws2.views = [{ state: 'frozen', ySplit: 2, showGridLines: false }];
  if (rows.length) ws2.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2 + rows.length, column: h2.length } };

  // ---------- Sheet 3 TOP 20 ----------
  const ws3 = wb.addWorksheet(D.sheets[2]);
  ws3.views = [{ showGridLines: false }];
  ws3.mergeCells('A1:M1');
  ws3.getCell('A1').value = `${title} · ${D.sheets[2]}`;
  ws3.getCell('A1').font = f(14, true, C.black);
  ws3.getRow(1).height = 26;
  const h3 = D.h3;
  const hr3 = ws3.getRow(2);
  h3.forEach((h, i) => {
    const c = hr3.getCell(i + 1);
    c.value = h;
    c.font = f(10, true, C.black);
    c.fill = fill(C.hdr);
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.border = { top: med, bottom: med, left: thin, right: thin };
  });
  hr3.height = 28;
  [...rows]
    .sort((a, b) => b.views - a.views)
    .slice(0, 20)
    .forEach((x, i) => {
      const row = ws3.getRow(3 + i);
      const vals = [i + 1, x.account, x.date, x.desc.slice(0, 90), x.views, x.likes, x.comments, x.shares, x.saves, x.inter, x.duration, D.t3(parseInt(x.month.split("-")[1],10)), x.url];
      vals.forEach((v, ci) => {
        const c = row.getCell(ci + 1);
        c.value = v;
        c.font = f(9.5, false, C.dark);
        c.border = boxBorder;
        if (i % 2) c.fill = fill(C.zebra);
        const n = ci + 1;
        if ([1, 2, 3, 10, 11, 12].includes(n)) {
          c.alignment = { horizontal: 'center', vertical: 'middle' };
          if (n === 10) c.numFmt = '0.00%';
        } else if (n === 13) {
          c.font = { name: FONT, size: 9, color: { argb: C.gray }, underline: true };
          c.value = { text: x.url, hyperlink: x.url };
        } else if (n === 4) c.alignment = { horizontal: 'left', vertical: 'middle' };
        else {
          c.alignment = { horizontal: 'right', vertical: 'middle' };
          c.numFmt = '#,##0';
        }
      });
      row.height = 20;
    });
  [6, 22, 12, 56, 11, 10, 9, 9, 9, 9, 9, 10, 46].forEach((w, i) => (ws3.getColumn(i + 1).width = w));

  // ---------- Sheet 4 挂车 vs 非挂车对比 ----------
  const ws4 = wb.addWorksheet(D.sheets[3]);
  ws4.views = [{ showGridLines: false }];
  ws4.mergeCells('A1:D1');
  ws4.getCell('A1').value = `${title} · ${D.ecTitle}`;
  ws4.getCell('A1').font = f(14, true, C.black);
  ws4.getRow(1).height = 26;

  const { ec, non } = ecCompare(rows);
  const hr4 = ws4.getRow(2);
  D.ecHead.forEach((h, i) => {
    const c = hr4.getCell(i + 1);
    c.value = h;
    c.font = f(10, true, C.black);
    c.fill = fill(C.hdr);
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    c.border = { top: med, bottom: med, left: thin, right: thin };
  });
  hr4.height = 28;

  EC_METRICS.forEach((key, i) => {
    const row = ws4.getRow(3 + i);
    const a = ec[key];
    const b = non[key];
    const isPct = key === 'inter';
    // 相对差异 = (挂车 - 非挂车) / 非挂车；分母为 0 时留破折号
    const hasDiff = typeof a === 'number' && typeof b === 'number' && b !== 0;
    const vals = [D.ecRows[i], a, b, hasDiff ? (a - b) / b : D.dash];
    vals.forEach((v, ci) => {
      const c = row.getCell(ci + 1);
      c.value = v;
      c.border = boxBorder;
      if (i % 2) c.fill = fill(C.zebra);
      const n = ci + 1;
      if (n === 1) {
        c.font = f(10, false, C.dark);
        c.alignment = { horizontal: 'left', vertical: 'middle' };
      } else if (n === 4) {
        c.font = f(10, true, C.black);
        c.alignment = { horizontal: 'right', vertical: 'middle' };
        if (hasDiff) c.numFmt = '+0.0%;-0.0%;0.0%';
      } else {
        c.font = f(10, false, C.dark);
        c.alignment = { horizontal: 'right', vertical: 'middle' };
        c.numFmt = isPct ? '0.00%' : '#,##0';
      }
    });
    row.height = 22;
  });
  [28, 16, 16, 14].forEach((w, i) => (ws4.getColumn(i + 1).width = w));

  return wb;
}

/** CSV */
function buildCsv(rows, lang = "zh") {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const D = getXlsDict(lang); const head = D.h2;
  const lines = [head.join(',')];
  rows.forEach((x, i) => {
    lines.push(
      [i + 1, x.account, x.nickname, x.month, x.date, (WEEKS[lang]||WEEKS.zh)[x.wd], x.time, x.desc, x.duration, x.views, x.likes, x.comments, x.shares, x.saves, x.reposts, (x.inter * 100).toFixed(2) + '%', x.tags, x.url, x.vid, x.isEC ? D.yes : D.dash]
        .map(esc)
        .join(',')
    );
  });
  return '\ufeff' + lines.join('\n');
}

module.exports = { toRows, agg, ecCompare, EC_METRICS, buildWorkbook, buildCsv, XLS, pickPlayUrl, bestQuality, qualityList };
