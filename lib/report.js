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
    sheets: ['账号汇总', '视频明细', '播放量TOP20'],
    monthly: '月度分布',
    total: '合计',
    dash: '—',
    h1: ['账号', '昵称', '粉丝数', '主页视频数', '区间内条数', '总播放量', '平均播放', '中位播放', '最高播放', '总点赞', '总收藏', '整体互动率'],
    h2: ['序号', '账号', '昵称', '发布月份', '发布日期', '星期', '发布时间', '视频文案', '时长(秒)', '播放量', '点赞', '评论', '分享', '收藏', '互动率', '话题标签', '视频链接'],
    h3: ['排名', '账号', '发布日期', '视频文案', '播放量', '点赞', '评论', '分享', '收藏', '互动率', '时长(秒)', '月份', '视频链接'],
    t3: (n) => `${n}月`,
  },
  th: {
    sheets: ['ภาพรวมบัญชี', 'รายละเอียดวิดีโอ', '20 อันดับวิว'],
    monthly: 'การกระจายรายเดือน',
    total: 'รวม',
    dash: '—',
    h1: ['บัญชี', 'ชื่อเล่น', 'ผู้ติดตาม', 'วิดีโอทั้งหมด', 'จำนวนในช่วง', 'วิวรวม', 'วิวเฉลี่ย', 'วิวค่ากลาง', 'วิวสูงสุด', 'ไลก์รวม', 'บันทึกรวม', 'อัตรามีส่วนร่วม'],
    h2: ['ลำดับ', 'บัญชี', 'ชื่อเล่น', 'เดือนที่โพสต์', 'วันที่', 'วัน', 'เวลา', 'คำบรรยาย', 'ความยาว(วิ)', 'วิว', 'ไลก์', 'คอมเมนต์', 'แชร์', 'บันทึก', 'มีส่วนร่วม', 'แฮชแท็ก', 'ลิงก์วิดีโอ'],
    h3: ['ลำดับ', 'บัญชี', 'วันที่', 'คำบรรยาย', 'วิว', 'ไลก์', 'คอมเมนต์', 'แชร์', 'บันทึก', 'มีส่วนร่วม', 'ความยาว(วิ)', 'เดือน', 'ลิงก์วิดีโอ'],
    t3: (n) => `${n} เดือน`,
  },
  en: {
    sheets: ['Account Summary', 'Video Details', 'Top 20 by Views'],
    monthly: 'Monthly Distribution',
    total: 'Total',
    dash: '—',
    h1: ['Account', 'Nickname', 'Followers', 'Total videos', 'Items in range', 'Total views', 'Avg views', 'Median views', 'Max views', 'Total likes', 'Total saves', 'Engagement'],
    h2: ['No.', 'Account', 'Nickname', 'Month', 'Date', 'Weekday', 'Time', 'Caption', 'Duration(s)', 'Views', 'Likes', 'Comments', 'Shares', 'Saves', 'Engage', 'Hashtags', 'Video URL'],
    h3: ['Rank', 'Account', 'Date', 'Caption', 'Views', 'Likes', 'Comments', 'Shares', 'Saves', 'Engage', 'Duration(s)', 'Month', 'Video URL'],
    t3: (n) => `M${n}`,
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

/** 把账号结果拍平成行 */
function toRows(accounts) {
  const rows = [];
  for (const acc of accounts) {
    for (const it of acc.items) {
      const d = new Date(it.createTime * 1000 + TZ_OFFSET_MS); // 转成曼谷墙上时间
      const st = it.stats || {};
      const views = g(st, 'playCount');
      const likes = g(st, 'diggCount');
      const comments = g(st, 'commentCount');
      const shares = g(st, 'shareCount');
      const saves = g(st, 'collectCount');
      const tags = (it.textExtra || []).map((t) => t.hashtagName).filter(Boolean);
      rows.push({
        account: acc.handle,
        nickname: acc.nickname,
        month: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
        date: d.toISOString().slice(0, 10),
        wd: d.getUTCDay(),
        time: d.toISOString().slice(11, 16),
        desc: (it.desc || '').replace(/\n/g, ' ').trim(),
        url: `https://www.tiktok.com/@${acc.handle}/video/${it.id}`,
        duration: g(it, 'video', 'duration'),
        views,
        likes,
        comments,
        shares,
        saves,
        inter: views ? (likes + comments + shares + saves) / views : 0,
        tags: tags.map((t) => '#' + t).join(' '),
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
  return {
    n: rows.length,
    tv,
    avg: rows.length ? Math.round(tv / rows.length) : 0,
    med,
    max: v.length ? Math.max(...v) : 0,
    likes: lk,
    comments: cm,
    shares: sh,
    saves: sv,
    inter: tv ? (lk + cm + sh + sv) / tv : 0,
  };
}

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
  ws.mergeCells('A1:L1');
  ws.getCell('A1').value = title;
  ws.getCell('A1').font = f(14, true, C.black);
  ws.getRow(1).height = 26;
  ws.mergeCells('A2:L2');
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
      a.inter,
    ];
    const row = ws.getRow(r);
    vals.forEach((v, ci) => {
      const c = row.getCell(ci + 1);
      c.value = v;
      c.font = f(10, false, C.dark);
      c.border = boxBorder;
      if (i % 2) c.fill = fill(C.zebra);
      if (ci === 11) {
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
  [D.total, D.dash, '', '', tot.n, tot.tv, tot.avg, tot.med, tot.max, tot.likes, tot.saves, tot.inter].forEach((v, ci) => {
    const c = tr.getCell(ci + 1);
    c.value = v;
    c.font = f(10, true, C.black);
    c.fill = fill(C.hdr);
    c.border = { top: med, bottom: med, left: thin, right: thin };
    if (ci === 11) {
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
  ws.mergeCells(r, 1, r, 12);
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

  [22, 30, 12, 13, 13, 13, 12, 12, 12, 11, 11, 12].forEach((w, i) => (ws.getColumn(i + 1).width = w));

  // ---------- Sheet 2 全量明细 ----------
  const ws2 = wb.addWorksheet(D.sheets[1]);
  ws2.views = [{ showGridLines: false }];
  ws2.mergeCells('A1:Q1');
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
      x.views, x.likes, x.comments, x.shares, x.saves, x.inter, x.tags, x.url,
    ];
    vals.forEach((v, ci) => {
      const c = row.getCell(ci + 1);
      c.value = v;
      c.font = f(9.5, false, C.dark);
      c.border = boxBorder;
      if (i % 2) c.fill = fill(C.zebra);
      const n = ci + 1;
      if ([1, 2, 3, 4, 5, 6, 7, 9].includes(n)) c.alignment = { horizontal: 'center', vertical: 'middle' };
      else if (n >= 10 && n <= 14) {
        c.alignment = { horizontal: 'right', vertical: 'middle' };
        c.numFmt = '#,##0';
      } else if (n === 15) {
        c.alignment = { horizontal: 'center', vertical: 'middle' };
        c.numFmt = '0.00%';
      } else if (n === 17) {
        c.font = { name: FONT, size: 9, color: { argb: C.gray }, underline: true };
        c.value = { text: x.url, hyperlink: x.url };
      } else c.alignment = { horizontal: 'left', vertical: 'middle' };
    });
    row.height = 20;
  });

  [6, 22, 26, 10, 12, 7, 9, 50, 9, 11, 10, 9, 9, 9, 9, 24, 48].forEach((w, i) => (ws2.getColumn(i + 1).width = w));
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
      [i + 1, x.account, x.nickname, x.month, x.date, (WEEKS[lang]||WEEKS.zh)[x.wd], x.time, x.desc, x.duration, x.views, x.likes, x.comments, x.shares, x.saves, (x.inter * 100).toFixed(2) + '%', x.tags, x.url]
        .map(esc)
        .join(',')
    );
  });
  return '\ufeff' + lines.join('\n');
}

module.exports = { toRows, agg, buildWorkbook, buildCsv, XLS };
