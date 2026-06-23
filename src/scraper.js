import { chromium } from 'playwright';
import {
  extractGenreRank,
  extractVolume,
  normalizeReleaseDate,
  extractCardReleaseDate,
} from './parse.js';
import { DATE_SORT } from './config.js';

const NAV_TIMEOUT = 30_000;

// 礼儀正しいクロールのための待機(ミリ秒)。Amazon側の負荷とbot検知を避ける。
const DELAY_MS = 2500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function createBrowser({ headless = true } = {}) {
  // --no-sandbox 等はCI(Linux)で必要になることがある。macではほぼ無害。
  const browser = await chromium.launch({
    headless,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    locale: 'ja-JP',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });
  context.setDefaultNavigationTimeout(NAV_TIMEOUT);
  return { browser, context };
}

// 「売れ筋ランキング順」検索結果の指定ページ範囲から候補商品URLを集める。
// 検索結果は順位順に並ぶので、目的の順位範囲に対応するページだけを取得すればよい。
// 商品ASINを検索順(=おおよその順位順)を保ったまま返す。
export async function collectFromSearch(context, searchBase, startPage, endPage) {
  const found = new Map(); // asin -> 最初に出現した検索ページ(参考情報)
  const page = await context.newPage();
  try {
    for (let pg = startPage; pg <= endPage; pg++) {
      try {
        const items = await loadSearchCards(page, searchBase, pg);
        for (const it of items) {
          if (!found.has(it.asin)) found.set(it.asin, pg);
        }
      } catch (e) {
        console.warn(`[warn] 検索ページ取得に失敗: page=${pg} (${e.message})`);
      }
      await sleep(DELAY_MS);
    }
  } finally {
    await page.close();
  }
  return [...found.keys()].map((asin) => `https://www.amazon.co.jp/dp/${asin}`);
}

// ── 発売日モード ─────────────────────────────────────────
// 検索を「発売日が新しい順」に並べると、未来の予約本→当日→過去 の順に並ぶ。
// 目的日付のページまで二分探索で一気に飛び、その前後を走査して候補を集める。

// 検索URLのソート指定を「発売日が新しい順」に差し替える。
function toDateSortedBase(searchBase) {
  return searchBase.replace(/([?&])s=[^&]*/, `$1s=${DATE_SORT}`);
}

// 検索ページを開き、遅延読み込みのカードを下までスクロールして全件読み込ませてから
// 各商品カードの {asin, text} を返す。取りこぼし(=読み込み前に取得)を防ぐ。
async function loadSearchCards(page, base, pg) {
  // 一時的な遅延・失敗に備えて数回リトライ。全滅したら空配列を返す(全体は止めない)。
  let loaded = false;
  for (let attempt = 1; attempt <= 3 && !loaded; attempt++) {
    try {
      await page.goto(`${base}&page=${pg}`, { waitUntil: 'domcontentloaded' });
      loaded = true;
    } catch (e) {
      console.warn(`[warn] page=${pg} 読み込み失敗(${attempt}/3): ${e.message}`);
      if (attempt < 3) await sleep(3000);
    }
  }
  if (!loaded) return [];
  // 結果コンテナの出現を待つ(無ければタイムアウトしても続行)
  await page
    .waitForSelector('div.s-main-slot div[data-asin]', { timeout: 8000 })
    .catch(() => {});
  // 段階的にスクロールして遅延読み込みを発火させる
  await page.evaluate(async () => {
    const step = 700;
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 150));
    }
    window.scrollTo(0, 0);
  });
  await sleep(700);
  return page.$$eval('div[data-asin]', (els) =>
    els
      .filter((e) => (e.getAttribute('data-asin') || '').length === 10)
      .map((e) => ({ asin: e.getAttribute('data-asin'), text: e.innerText }))
  );
}

// 指定ページの先頭商品の発売日(YYYY-MM-DD)を返す。商品が無ければ null。
async function firstItemDate(page, base, pg) {
  const items = await loadSearchCards(page, base, pg);
  for (const it of items) {
    const d = extractCardReleaseDate(it.text);
    if (d) return d;
  }
  return null;
}

// 発売日が新しい順の検索で、先頭商品の発売日が target 以下になる最小ページを二分探索。
async function findStartPage(page, base, target, maxPage = 400) {
  let lo = 1;
  let hi = maxPage;
  let ans = 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const d = await firstItemDate(page, base, mid);
    if (d == null) {
      // データが無いページ(末尾超過)。より手前を探す。
      hi = mid - 1;
      continue;
    }
    if (d > target) {
      // まだ未来寄り。後ろのページへ。
      lo = mid + 1;
    } else {
      // target 以下。ここを候補にしつつ、より手前を探す。
      ans = mid;
      hi = mid - 1;
    }
  }
  return ans;
}

// 指定発売日のコミック候補(ASIN・タイトル・発売日)を検索ページから集める。
// 商品ページは開かない(=安価)。順位はあとで別途取得する。
export async function collectByDate(context, searchBase, target) {
  const base = toDateSortedBase(searchBase);
  const page = await context.newPage();
  const found = new Map(); // asin -> { title, releaseDate }
  try {
    const start = await findStartPage(page, base, target);
    // 並び順は厳密な日付降順ではなく前後数日が入れ替わることがあるため、
    // 二分探索のズレ対策に少し手前から走査を開始する。
    let pg = Math.max(1, start - 2);
    let emptyStreak = 0;
    let olderStreak = 0; // ページ全体が target より古い状態が続いた回数

    while (pg <= 400) {
      const items = await loadSearchCards(page, base, pg);
      if (items.length === 0) {
        // 読み込み失敗 or 結果末尾。連続したら終了。
        if (++emptyStreak >= 3) break;
        pg++;
        continue;
      }
      emptyStreak = 0;

      let hadTarget = false;
      let pageMaxDate = null; // このページで最も新しい発売日
      for (const it of items) {
        const d = extractCardReleaseDate(it.text);
        if (!d) continue;
        if (pageMaxDate == null || d > pageMaxDate) pageMaxDate = d;
        if (d === target) {
          hadTarget = true;
          if (!found.has(it.asin)) {
            found.set(it.asin, { title: cardTitle(it.text), releaseDate: d });
          }
        }
      }
      // ページ全体が target より古ければカウント、target を含むページで0に戻す。
      if (hadTarget) olderStreak = 0;
      else if (pageMaxDate != null && pageMaxDate < target) olderStreak++;
      else olderStreak = 0;
      // 古いページが2回続いたら終了。
      // - 通常: target の本を拾い終えた後に古い日付帯へ抜けた
      // - 当日発売が無い場合: target を一度も拾えないまま古い帯に入る
      // 1ページ分の局所的な日付の入れ替わりは許容する(2回連続で判定)。
      if (olderStreak >= 2) break;

      pg++;
      await sleep(DELAY_MS);
    }
  } finally {
    await page.close();
  }
  return [...found.entries()].map(([asin, v]) => ({
    url: `https://www.amazon.co.jp/dp/${asin}`,
    ...v,
  }));
}

// 1商品ページを開いて、登録情報からジャンル順位・タイトル・巻数・発売日を取得。
// requireRank=false の場合、順位が読めなくても (genreRank=null で) 結果を返す。
export async function scrapeProduct(context, url, genreLabel, { requireRank = true } = {}) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // 登録情報ブロック(複数のレイアウトに対応)
    const detailText = await page.evaluate(() => {
      const sel = [
        '#detailBulletsWrapper_feature_div',
        '#productDetails_detailBullets_sections1',
        '#detailBullets_feature_div',
        '#productDetailsTable',
        '#prodDetails',
      ];
      for (const s of sel) {
        const el = document.querySelector(s);
        if (el && el.innerText) return el.innerText;
      }
      return document.body.innerText;
    });

    const rank = extractGenreRank(detailText, genreLabel);
    if (rank == null && requireRank) return null;

    const rawTitle = (await page.title()) || '';
    const title = await page
      .$eval('#productTitle', (el) => el.textContent.trim())
      .catch(() => cleanTitle(rawTitle));

    const releaseRaw = extractFieldFromDetail(detailText, ['発売日', '出版社']);
    const releaseDate = normalizeReleaseDate(releaseRaw);

    return {
      url,
      genreRank: rank,
      title,
      volume: extractVolume(title),
      releaseDate,
    };
  } catch (e) {
    console.warn(`[warn] 商品ページ取得に失敗: ${url} (${e.message})`);
    return null;
  } finally {
    await page.close();
    await sleep(DELAY_MS);
  }
}

// 登録情報テキストから「発売日 : 2024/3/4」のような項目値を拾う。
function extractFieldFromDetail(text, keys) {
  const normalized = text.replace(/　/g, ' ');
  for (const key of keys) {
    const re = new RegExp(`${key}[\\s\\u00A0]*[:：]?[\\s\\u00A0]*([^\\n]+)`);
    const m = normalized.match(re);
    if (m) {
      // 「出版社」行に含まれる「(2024/3/4)」のような括弧内日付も拾える
      const dateInParen = m[1].match(/[（(]?\s*(\d{4}[年./-]\d{1,2}[月./-]\d{1,2}日?)/);
      if (dateInParen) return dateInParen[1];
      if (key === '発売日') return m[1].trim();
    }
  }
  return null;
}

// 検索カードのテキストから仮タイトル(先頭の実質的な行)を取り出す。
// 「ベストセラー」などのバッジ行や空行を読み飛ばす。
function cardTitle(text) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const skip = /^(ベストセラー|新着|セール|Kindle版|コミック|タイムセール|残り\d+点)$/;
  const t = lines.find((l) => !skip.test(l) && l.length >= 3);
  return t || lines[0] || '';
}

function cleanTitle(pageTitle) {
  return pageTitle
    .replace(/\s*[|｜]\s*Amazon.*$/i, '')
    .replace(/^Amazon[.．]co[.．]jp[:：]?\s*/i, '')
    .trim();
}

