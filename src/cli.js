#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import {
  GENRES,
  MAX_RANK_SPAN,
  PUBLIC_RANK_LIMIT,
  MAX_SUPPORTED_RANK,
  ITEMS_PER_SEARCH_PAGE,
  PAGE_MARGIN,
  MAX_DAILY_ITEMS,
} from './config.js';
import {
  createBrowser,
  collectFromSearch,
  collectByDate,
  scrapeProduct,
} from './scraper.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

function usage() {
  console.log(`
Amazon売れ筋ランキング 書籍情報抽出ツール

【順位モード】指定ジャンルの指定順位帯(201〜1000位)を抽出
  node src/cli.js --genre <ジャンル> --from <開始順位> --to <終了順位> [--out file]

【発売日モード】指定日に発売のコミック等を全件抽出(タイトル・巻数・順位)
  node src/cli.js --genre <ジャンル> --date [YYYY-MM-DD] [--out file]
    --date を値なしで指定、または省略時は「実行当日」が対象。
    未来日(明日以降=予約)は対象外。

共通オプション:
  --genre   ジャンル名 (${Object.keys(GENRES).join(' / ')})
  --out     出力ファイル (既定: result.json。.csv 指定でCSV出力)
  --headful ブラウザを表示して実行(デバッグ用)
  --yes     上限超過などの確認をスキップして強制実行

例:
  node src/cli.js --genre コミック --from 201 --to 400 --out comic.csv
  node src/cli.js --genre コミック --date 2026-06-17 --out today.csv
`);
}

function fail(msg) {
  console.error(`\n[エラー] ${msg}\n`);
  process.exit(1);
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function writeOut(rows, headers, out) {
  if (out.endsWith('.csv')) {
    writeFileSync(out, toCsv(rows, headers), 'utf8');
  } else {
    writeFileSync(out, JSON.stringify(rows, null, 2), 'utf8');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || Object.keys(args).length === 0) {
    usage();
    process.exit(0);
  }

  const genreKey = args.genre;
  if (!genreKey || !GENRES[genreKey]) {
    fail(`--genre は次のいずれかを指定してください: ${Object.keys(GENRES).join(' / ')}`);
  }
  const genre = GENRES[genreKey];

  if (args.date !== undefined) {
    await runDateMode(args, genre);
  } else {
    await runRankMode(args, genre);
  }
}

// ── 順位モード ───────────────────────────────────────────
async function runRankMode(args, genre) {
  const from = Number(args.from);
  const to = Number(args.to);
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    fail('--from / --to は整数で指定してください。(発売日で抽出する場合は --date を使用)');
  }
  if (from > to) fail('--from は --to 以下にしてください。');

  if (from <= PUBLIC_RANK_LIMIT) {
    fail(
      `${PUBLIC_RANK_LIMIT}位までは公開ランキングで確認できるため対象外です。` +
        `--from は ${PUBLIC_RANK_LIMIT + 1} 以上を指定してください。`
    );
  }
  if (to > MAX_SUPPORTED_RANK) {
    fail(`対象は最大 ${MAX_SUPPORTED_RANK} 位までです。--to を見直してください。`);
  }

  const span = to - from + 1;
  if (span > MAX_RANK_SPAN) {
    console.error(
      `\n⚠️  指定された順位範囲は ${span} 件分で、上限 ${MAX_RANK_SPAN} 件を超えています。\n` +
        `   スクレイプするページ数が多くなりすぎるため、抽出を中止しました。\n` +
        `   範囲を狭めるか、config.js の MAX_RANK_SPAN を見直してください。\n`
    );
    process.exit(2);
  }

  console.log(
    `\n▶ ジャンル「${genre.label}」 / ${from}位〜${to}位 (${span}件) を抽出します。\n`
  );

  const startPage = Math.max(
    1,
    Math.ceil(from / ITEMS_PER_SEARCH_PAGE) - PAGE_MARGIN
  );
  const endPage = Math.ceil(to / ITEMS_PER_SEARCH_PAGE) + PAGE_MARGIN;

  const { browser, context } = await createBrowser({ headless: !args.headful });
  const results = [];
  try {
    console.log(
      `① 売れ筋ランキング順の検索ページ ${startPage}〜${endPage} から候補を収集中...`
    );
    const candidates = await collectFromSearch(
      context,
      genre.searchBase,
      startPage,
      endPage
    );
    console.log(`   候補 ${candidates.length} 件を取得。\n`);

    console.log('② 各商品ページのランキングを確認中...');
    let i = 0;
    for (const url of candidates) {
      i++;
      const data = await scrapeProduct(context, url, genre.label);
      if (!data) continue;
      const inRange = data.genreRank >= from && data.genreRank <= to;
      process.stdout.write(
        `   [${i}/${candidates.length}] ${data.genreRank}位 ${inRange ? '✓' : '–'} ${data.title.slice(0, 30)}\n`
      );
      if (inRange) {
        results.push({
          順位: data.genreRank,
          タイトル: data.title,
          巻数: data.volume,
          発売日: data.releaseDate,
        });
      }
    }
  } finally {
    await browser.close();
  }

  results.sort((a, b) => a.順位 - b.順位);
  const out = args.out || 'result.json';
  writeOut(results, ['順位', 'タイトル', '巻数', '発売日'], out);

  console.log(`\n✅ 範囲内 ${results.length} 件を ${out} に出力しました。`);
  if (results.length === 0) {
    console.log(
      '   ※ 0件の場合、検索ページの並び順と商品ページ記載順位のずれが大きい可能性があります。\n' +
        '     config.js の PAGE_MARGIN を増やして再実行してください。'
    );
  }
}

// ── 発売日モード ─────────────────────────────────────────
async function runDateMode(args, genre) {
  const target = args.date === true ? todayStr() : String(args.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) {
    fail('--date は YYYY-MM-DD 形式で指定してください。(例: --date 2026-06-17)');
  }
  const today = todayStr();
  if (target > today) {
    fail(
      `未来の日付(${target})は対象外です。明日以降は予約上の順位になるため、当日(${today})以前を指定してください。`
    );
  }

  console.log(
    `\n▶ ${target} 発売の「${genre.label}」を全件抽出します（順位が無い本は「—」）。\n`
  );

  const { browser, context } = await createBrowser({ headless: !args.headful });
  const results = [];
  try {
    console.log('① 発売日順の検索から該当日の候補を収集中...');
    const candidates = await collectByDate(context, genre.searchBase, target);
    console.log(`   ${target} 発売の候補 ${candidates.length} 件を取得。\n`);

    if (candidates.length === 0) {
      console.log('   ※ 該当日の商品が見つかりませんでした（発売の無い日付の可能性）。');
    }

    // 安全装置: 件数が多すぎる場合は商品ページ巡回前に確認
    if (candidates.length > MAX_DAILY_ITEMS && !args.yes) {
      console.error(
        `\n⚠️  該当 ${candidates.length} 件は上限 ${MAX_DAILY_ITEMS} 件を超えています。\n` +
          `   全件の商品ページを開くと時間がかかります。続行するには --yes を付けて再実行してください。\n`
      );
      await browser.close();
      process.exit(2);
    }

    console.log('② 各商品ページから順位・巻数を取得中...');
    let i = 0;
    for (const c of candidates) {
      i++;
      const data = await scrapeProduct(context, c.url, genre.label, {
        requireRank: false,
      });
      const title = (data && data.title) || c.title;
      const rank = data && data.genreRank != null ? data.genreRank : null;
      process.stdout.write(
        `   [${i}/${candidates.length}] ${rank != null ? rank + '位' : '—'} ${title.slice(0, 30)}\n`
      );
      results.push({
        順位: rank != null ? rank : '—',
        タイトル: title,
        巻数: (data && data.volume) ?? null,
        発売日: (data && data.releaseDate) || c.releaseDate,
      });
    }
  } finally {
    await browser.close();
  }

  // 順位あり(昇順)→順位なし の順に並べる
  results.sort((a, b) => {
    const ra = a.順位 === '—' ? Infinity : a.順位;
    const rb = b.順位 === '—' ? Infinity : b.順位;
    return ra - rb;
  });

  const out = args.out || 'result.json';
  writeOut(results, ['順位', 'タイトル', '巻数', '発売日'], out);
  console.log(`\n✅ ${target} 発売の ${results.length} 件を ${out} に出力しました。`);
}

function toCsv(rows, headers) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map((h) => esc(r[h])).join(','));
  }
  return '﻿' + lines.join('\n'); // BOM付きでExcelの文字化け回避
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
