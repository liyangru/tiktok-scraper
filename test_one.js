/** 单账号诊断：node test_one.js <handle> [from] [to] */
const scraper = require('./lib/scraper');

const handle = process.argv[2] || 'loop.earplugs.offi';
const from = process.argv[3] || '2026-07-01';
const to = process.argv[4] || '2026-09-30';

(async () => {
  const t0 = Date.now();
  console.log(`引擎: ${scraper.ENGINE} | 浏览器: ${scraper.resolveChromePath()}`);
  const ctx = await scraper.openSession(0);
  try {
    const r = await scraper.scrapeAccount(ctx, handle, {
      from,
      to,
      onProgress: (p) => console.log('  [progress]', JSON.stringify(p)),
    });
    console.log(
      `\n@${r.handle} | ${r.nickname} | 粉丝 ${(r.stats || {}).followerCount} | 抓到 ${r.items.length} 条 | API 批次 ${r.apiCalls} | 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`
    );
    r.items.slice(0, 5).forEach((it) =>
      console.log('   ', new Date(it.createTime * 1000).toISOString().slice(0, 10), (it.stats || {}).playCount, (it.desc || '').slice(0, 50))
    );
  } catch (e) {
    console.log(`\n✗ 失败（${((Date.now() - t0) / 1000).toFixed(1)}s）: ${e.message}`);
  } finally {
    await ctx.close().catch(() => {});
  }
})();
