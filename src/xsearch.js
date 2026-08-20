#!/usr/bin/env node
// X(Twitter)で「発売告知ポスト」の候補を検索する。
//
// Xは未ログインだと検索できないため、専用のブラウザプロファイル(.x-profile)に
// ユーザー自身が一度ログインしておき、そのセッションを再利用する。
// ※ .x-profile はセッション情報を含むため .gitignore で除外している(絶対にpushしない)。
//
// 使い方:
//   node src/xsearch.js --login    … ログイン用ブラウザを開く(初回のみ・手動でログイン)
//   node src/xsearch.js --test "作品名"  … 検索動作の確認
import { chromium } from 'playwright';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
export const PROFILE_DIR = join(ROOT, '.x-profile');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 検索用にタイトルを整形する。
// 例) 「妹は知っている(8) (ヤングマガジンKC)」→ 本体「妹は知っている」/ レーベル「ヤングマガジンKC」
export function parseTitle(rawTitle) {
  let t = String(rawTitle || '').replace(/　/g, ' ').trim();
  // 末尾の (レーベル名) を取り出す(数字だけの括弧は巻数なので除く)
  let imprint = null;
  const m = t.match(/[（(]([^（()）]*[^\d（()）][^（()）]*)[)）]\s*$/);
  if (m) {
    imprint = m[1].trim();
    t = t.slice(0, m.index).trim();
  }
  // 巻数表記・特典表記などを落として作品名の核を作る
  // 順序が重要: 先に【】と～～のサブタイトルを落としてから巻数表記を除去する
  // (先に巻数を消すと「…です 3 ～副題～」の 3 が末尾判定から漏れる)
  const core = t
    .replace(/[【\[][^】\]]*[】\]]/g, ' ') // 【電子特典付き】など
    .replace(/～[^～]*～/g, ' ') // ～サブタイトル～
    .replace(/[（(]\s*[0-9０-９]{1,4}\s*[)）]/g, ' ') // (8)
    .replace(/\s*第?\s*[0-9０-９]{1,4}\s*巻/g, ' ') // 8巻
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/\s+[0-9０-９]{1,4}$/, '') // 末尾の裸の巻数
    .trim();
  return { core: core || t, imprint };
}

// 検索クエリの候補(上から優先)。
export function buildQueries(rawTitle, volume) {
  const { core } = parseTitle(rawTitle);
  const v = volume != null ? String(volume) : '';
  const qs = [];
  if (v) qs.push(`"${core}" ${v}巻 発売`);
  qs.push(`"${core}" 発売`);
  qs.push(`"${core}" 発売中`);
  return qs;
}

// 公式らしさのスコア(高いほど公式/媒体アカウントらしい)。
export function officialScore({ handle = '', name = '', verified = false, text = '' }) {
  let s = 0;
  const hay = `${handle} ${name}`;
  if (verified) s += 3;
  if (/公式|編集部|編集|コミックス|comics?|magazine|マガジン|書店|出版|BOOKS?/i.test(hay)) s += 3;
  if (/(講談社|集英社|小学館|KADOKAWA|角川|白泉社|秋田書店|竹書房|一迅社|スクウェア|SQUARE|芳文社|双葉社|新潮社|少年画報|LINE|コアミックス|マッグガーデン|ヒーローズ)/i.test(hay)) s += 3;
  if (/発売|刊行|配信開始|本日発売/.test(text)) s += 2;
  if (/単行本|コミックス|最新刊|第?\d+巻/.test(text)) s += 1;
  return s;
}

// 永続プロファイルでブラウザを開く。
async function openContext({ headless = true } = {}) {
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    locale: 'ja-JP',
    userAgent: UA,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
}

// ログイン済みかどうか(検索結果が見えるか)を判定。
async function isLoggedIn(page) {
  const url = page.url();
  if (/\/i\/flow\/login|\/login/.test(url)) return false;
  const hasLoginForm = await page
    .$('input[autocomplete="username"]')
    .then((el) => !!el)
    .catch(() => false);
  return !hasLoginForm;
}

// 1作品分の告知ポスト候補を取得する。
// 戻り値: { queries, loginRequired, candidates: [{url, handle, name, text, datetime, verified, score}] }
export async function searchAnnouncements(context, rawTitle, volume, { max = 6 } = {}) {
  const queries = buildQueries(rawTitle, volume);
  const page = await context.newPage();
  const seen = new Map();
  let loginRequired = false;
  try {
    for (const q of queries) {
      const url = `https://x.com/search?q=${encodeURIComponent(q)}&f=live`;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch {
        continue;
      }
      await sleep(3000);
      if (!(await isLoggedIn(page))) {
        loginRequired = true;
        break;
      }
      await page
        .waitForSelector('article[data-testid="tweet"]', { timeout: 9000 })
        .catch(() => {});
      const items = await page
        .$$eval('article[data-testid="tweet"]', (arts) =>
          arts.slice(0, 12).map((a) => {
            const nameBlock = a.querySelector('div[data-testid="User-Name"]');
            const raw = nameBlock ? nameBlock.innerText : '';
            const lines = raw.split('\n').filter(Boolean);
            const name = lines[0] || '';
            const handle = (lines.find((l) => l.startsWith('@')) || '').trim();
            const textEl = a.querySelector('div[data-testid="tweetText"]');
            const text = textEl ? textEl.innerText : '';
            const timeEl = a.querySelector('time');
            const datetime = timeEl ? timeEl.getAttribute('datetime') : null;
            const anchor = timeEl ? timeEl.closest('a[href*="/status/"]') : null;
            const url = anchor ? anchor.href : null;
            const verified = !!a.querySelector('svg[data-testid="icon-verified"]');
            return { name, handle, text, datetime, url, verified };
          })
        )
        .catch(() => []);

      for (const it of items) {
        if (!it.url || seen.has(it.url)) continue;
        seen.set(it.url, { ...it, score: officialScore(it) });
      }
      if (seen.size >= max) break;
      await sleep(2500);
    }
  } finally {
    await page.close();
  }

  const candidates = [...seen.values()]
    .sort((a, b) => b.score - a.score || (b.datetime || '').localeCompare(a.datetime || ''))
    .slice(0, max);
  return { queries, loginRequired, candidates };
}

// 複数作品ぶんをまとめて取得(呼び出し側でブラウザを共有)。
export async function searchForItems(items, { max = 5 } = {}) {
  const context = await openContext({ headless: true });
  const out = [];
  try {
    for (const it of items) {
      const r = await searchAnnouncements(context, it.title, it.volume, { max });
      out.push({ ...it, ...r });
      if (r.loginRequired) {
        // 未ログインなら以降も同じなので打ち切る
        for (const rest of items.slice(out.length)) {
          out.push({ ...rest, queries: buildQueries(rest.title, rest.volume), loginRequired: true, candidates: [] });
        }
        break;
      }
      await sleep(3000);
    }
  } finally {
    await context.close();
  }
  return out;
}

// ── CLI ────────────────────────────────────────────────
async function mainCli() {
  const arg = process.argv[2];
  if (arg === '--login') {
    console.log('\nXのログイン用ブラウザを開きます。');
    console.log('表示されたウィンドウでご自身でログインしてください（このツールはパスワードを一切扱いません）。');
    console.log('ログインが完了したら、ブラウザのウィンドウを閉じてください。\n');
    const context = await openContext({ headless: false });
    const page = context.pages()[0] || (await context.newPage());
    await page.goto('https://x.com/login', { waitUntil: 'domcontentloaded' }).catch(() => {});
    // ウィンドウが閉じられるまで待つ
    await new Promise((resolve) => context.on('close', resolve));
    console.log('ログイン用ブラウザを閉じました。セッションは .x-profile に保存されます。');
    return;
  }
  if (arg === '--test') {
    const title = process.argv[3] || '妹は知っている(8) (ヤングマガジンKC)';
    const context = await openContext({ headless: true });
    try {
      const r = await searchAnnouncements(context, title, 8);
      console.log('クエリ:', r.queries);
      console.log('ログイン必要:', r.loginRequired);
      console.log('候補:', r.candidates.length, '件');
      for (const c of r.candidates) {
        console.log(` [score ${c.score}] ${c.name} ${c.handle} ${c.datetime || ''}`);
        console.log(`   ${c.url}`);
        console.log(`   ${String(c.text).replace(/\n/g, ' ').slice(0, 60)}`);
      }
    } finally {
      await context.close();
    }
    return;
  }
  console.log('使い方: node src/xsearch.js --login | --test "作品タイトル"');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mainCli().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
