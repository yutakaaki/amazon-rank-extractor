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

const toHalf = (s) =>
  String(s || '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

// 候補ポストを評価する。
// 目的は「その作品・その巻の、公式(出版社/連載媒体)または作者による発売告知」を上位に出すこと。
// 作品名がどこにも出てこない投稿は誤マッチとして除外(score < 0)。
export function scoreCandidate(
  { handle = '', name = '', verified = false, text = '' },
  { core = '', volume = null } = {}
) {
  const who = `${handle} ${name}`;
  const body = toHalf(text);
  const titleInText = core && text.includes(core);
  const titleInName = core && name.includes(core);

  // 作品名が本文にもアカウント名にも無ければ別作品の誤マッチ
  if (!titleInText && !titleInName) return { score: -1, kind: '無関係' };

  let s = 0;
  let kind = 'その他';

  // 発売告知らしさ
  const isAnnounce = /発売|刊行|配信開始|本日発売|発売中|重版/.test(text);
  if (isAnnounce) s += 3;

  // 巻数の一致/不一致(重要): 対象巻に言及していれば加点、別巻の話なら減点
  if (volume != null) {
    const v = String(volume);
    const hitTarget = new RegExp(`(第\\s*)?${v}\\s*巻|[（(]\\s*${v}\\s*[)）]`).test(body);
    const otherVol = [...body.matchAll(/(?:第\s*)?(\d{1,3})\s*巻/g)].map((m) => m[1]);
    if (hitTarget) s += 4;
    else if (otherVol.length && !otherVol.includes(v)) s -= 3; // 別の巻の告知
  }

  // 公式(出版社・レーベル・連載媒体)らしさ
  const publisherish =
    /公式|編集部|コミックス|comics?|magazine|マガジン|出版|BOOKS?|文庫|少年|ヤング|月刊|週刊/i.test(who) ||
    /(講談社|集英社|小学館|KADOKAWA|角川|白泉社|秋田書店|竹書房|一迅社|スクウェア|SQUARE|芳文社|双葉社|新潮社|少年画報|コアミックス|マッグガーデン|ヒーローズ|フレックス|LINE)/i.test(who);
  if (publisherish) {
    s += 5;
    kind = '公式・媒体';
  }
  if (verified) s += 2;

  // 作者/作品アカウント(アカウント名に作品名が入っている等)
  if (titleInName) {
    s += 4;
    if (kind === 'その他') kind = '作者・作品';
  }

  // 情報収集bot・まとめ・書店ブログ等は引用元として不適切なので減点
  if (/新刊|まとめ|ランキング|売れてます|レビュー|review|bot|情報|書店/i.test(who)) {
    s -= 4;
    if (kind === 'その他') kind = '情報・書店';
  }

  return { score: s, kind };
}

// 永続プロファイルでブラウザを開く。
// 重要: UAを固定値で詐称しない。実際のブラウザ版と食い違うと自動化として弾かれるため、
// ヘッドレス時のみ "HeadlessChrome" 表記を "Chrome" に置換して整合を取る。
let cachedUA = null;
// 実際のChromiumのメジャーバージョンに一致するUAを作る。
// (固定の古いUAを名乗るとバージョン不整合で自動化と判定されるため)
async function realisticUA() {
  if (cachedUA) return cachedUA;
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const major = (b.version() || '').split('.')[0] || '140';
  await b.close();
  cachedUA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    `(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  return cachedUA;
}

async function openContext({ headless = true } = {}) {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 1280, height: 900 },
    userAgent: await realisticUA(),
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled', // navigator.webdriver 対策
    ],
  });
  // 自動化フラグを隠す(ログイン画面での誤検知を避ける)
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return context;
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
  const { core } = parseTitle(rawTitle);
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
        const { score, kind } = scoreCandidate(it, { core, volume });
        if (score < 0) continue; // 別作品の誤マッチは捨てる
        seen.set(it.url, { ...it, score, kind });
      }
      if (seen.size >= max) break;
      await sleep(2500);
    }
  } finally {
    await page.close();
  }

  // 種別を最優先で並べる(公式・媒体 → 作者・作品 → その他)。
  // ご要望どおり「出版社公式/連載媒体の告知」を引用元の第一候補にするため。
  const kindRank = { '公式・媒体': 0, '作者・作品': 1, '情報・書店': 2, その他: 3 };
  const candidates = [...seen.values()]
    .sort(
      (a, b) =>
        (kindRank[a.kind] ?? 9) - (kindRank[b.kind] ?? 9) ||
        b.score - a.score ||
        (b.datetime || '').localeCompare(a.datetime || '')
    )
    .slice(0, max);
  const hasOfficial = candidates.some((c) => c.kind === '公式・媒体');
  return { queries, loginRequired, candidates, hasOfficial };
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

    // ログイン完了(auth_token の発行)を検知したら知らせる。最大10分待つ。
    let ok = false;
    const deadline = Date.now() + 10 * 60 * 1000;
    let closed = false;
    context.on('close', () => (closed = true));
    while (Date.now() < deadline && !closed) {
      await sleep(3000);
      try {
        const cookies = await context.cookies('https://x.com');
        if (cookies.some((c) => c.name === 'auth_token' && c.value)) {
          ok = true;
          break;
        }
      } catch {
        break; // コンテキストが閉じられた
      }
    }
    if (ok) {
      console.log('\n✅ ログインを確認しました。ブラウザを閉じて構いません。');
      await sleep(1500);
      await context.close().catch(() => {});
    } else if (closed) {
      console.log('\n⚠️ ログインが完了しないままブラウザが閉じられました。');
      console.log('   もう一度お試しください（うまくいかない場合はお知らせください）。');
    } else {
      console.log('\n⚠️ 時間内にログインを確認できませんでした。');
      await context.close().catch(() => {});
    }
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
