#!/usr/bin/env node
// 1日2回(朝6:00 / 夕18:00)の自動抽出と、同一書籍の朝→夕ランク変化の比較。
//
// 使い方:
//   node src/daily.js            … 現在時刻から朝/夕を判定して実行
//   node src/daily.js 0600       … 朝として実行
//   node src/daily.js 1800       … 夕として実行(朝のスナップショットがあれば比較CSVを生成)
//
// 出力:
//   snapshots/コミック_YYYYMMDD_HHMM.json … 突き合わせ用(asin・順位を含む)
//   results/コミック_発売日YYYYMMDD_HHMM.csv … その回の一覧
//   results/コミック_発売日YYYYMMDD_朝夜比較.csv … 朝→夕のランク変化(夕の回で生成)
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENRES } from './config.js';
import { createBrowser, collectByDate, scrapeProduct } from './scraper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SNAP_DIR = join(ROOT, 'snapshots');
const RESULTS_DIR = join(ROOT, 'results');

const GENRE = 'コミック'; // 自動実行の対象ジャンル
const MORNING = '0600';
const EVENING = '1800';

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 実行タグ(朝/夕)を決める。引数優先、無ければ現在の時刻帯で判定。
function resolveTag() {
  const arg = process.argv[2];
  if (arg === MORNING || arg === EVENING) return arg;
  const h = new Date().getHours();
  return h < 12 ? MORNING : EVENING;
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function writeCsv(path, headers, rows) {
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvEscape(r[h])).join(','));
  writeFileSync(path, '﻿' + lines.join('\n'), 'utf8');
}

async function main() {
  mkdirSync(SNAP_DIR, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });

  const date = todayStr();
  const stamp = date.replaceAll('-', '');
  const tag = resolveTag();
  console.log(`[daily] ${date} ${tag} ${GENRE} の抽出を開始`);

  const { browser, context } = await createBrowser({ headless: true });
  const records = [];
  try {
    const candidates = await collectByDate(context, GENRES[GENRE].searchBase, date);
    console.log(`[daily] ${date} 発売の候補 ${candidates.length} 件`);
    let i = 0;
    for (const c of candidates) {
      i++;
      const asin = c.url.match(/\/dp\/([A-Z0-9]{10})/)?.[1] || null;
      const data = await scrapeProduct(context, c.url, GENRES[GENRE].label, {
        requireRank: false,
      });
      records.push({
        asin,
        title: (data && data.title) || c.title,
        volume: (data && data.volume) ?? null,
        rank: data && data.genreRank != null ? data.genreRank : null,
        date,
      });
      process.stdout.write(
        `  [${i}/${candidates.length}] ${records.at(-1).rank ?? '—'} ${records.at(-1).title.slice(0, 26)}\n`
      );
    }
  } finally {
    await browser.close();
  }

  // スナップショット(突き合わせ用)
  const snapPath = join(SNAP_DIR, `${GENRE}_${stamp}_${tag}.json`);
  writeFileSync(snapPath, JSON.stringify({ genre: GENRE, date, tag, records }, null, 2), 'utf8');

  // その回の一覧CSV(順位順、圏外は末尾)
  const sorted = [...records].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
  const runCsv = join(RESULTS_DIR, `${GENRE}_発売日${stamp}_${tag}.csv`);
  writeCsv(runCsv, ['順位', 'タイトル', '巻数', '発売日'], sorted.map((r) => ({
    順位: r.rank ?? '—',
    タイトル: r.title,
    巻数: r.volume,
    発売日: r.date,
  })));
  console.log(`[daily] 一覧を出力: ${runCsv}`);

  // 夕の回で、同日の朝スナップショットがあれば比較CSVを生成
  if (tag === EVENING) {
    const morningPath = join(SNAP_DIR, `${GENRE}_${stamp}_${MORNING}.json`);
    if (existsSync(morningPath)) {
      buildComparison(morningPath, records, date, stamp);
    } else {
      console.log('[daily] 朝のスナップショットが無いため比較はスキップ');
    }
  }

  // 翌日以降の自動起床を再設定(任意・失敗しても致命的ではない)
  rearmWake(tag);
}

// 朝→夕のランク変化を比較してCSV出力。ランクが両方とれた書籍のみ対象。
export function buildComparison(morningPath, eveningRecords, date, stamp) {
  const morning = JSON.parse(readFileSync(morningPath, 'utf8')).records;
  const mMap = new Map(morning.filter((r) => r.asin).map((r) => [r.asin, r]));

  const rows = [];
  for (const ev of eveningRecords) {
    if (!ev.asin) continue;
    const mo = mMap.get(ev.asin);
    if (!mo) continue;
    // ランキングが取れない書籍は無視
    if (mo.rank == null || ev.rank == null) continue;

    const diff = mo.rank - ev.rank; // 正=順位が上がった(数字が小さくなった)
    const pct = Math.round((diff / mo.rank) * 1000) / 10; // 上昇率(%)、小数1桁
    rows.push({
      タイトル: ev.title,
      巻数: ev.volume,
      発売日: date,
      '6時順位': mo.rank,
      '18時順位': ev.rank,
      順位変化: (diff > 0 ? '+' : '') + diff, // +は上昇
      'ランク上昇率(%)': pct,
    });
  }
  // 夕方(18時)の順位が良い順に並べる(上位ほど先頭)
  rows.sort((a, b) => a['18時順位'] - b['18時順位']);

  const outPath = join(RESULTS_DIR, `${GENRE}_発売日${stamp}_朝夜比較.csv`);
  writeCsv(
    outPath,
    ['タイトル', '巻数', '発売日', '6時順位', '18時順位', '順位変化', 'ランク上昇率(%)'],
    rows
  );
  console.log(`[daily] 朝→夕 比較を出力: ${outPath} (${rows.length}件)`);
  return outPath;
}

// 1日2回のスリープ自動起床を維持するための再設定。
// 朝の回 → 当日夕方(17:58)の起床を予約 / 夕の回 → 翌朝(05:58)の起床を予約。
// pmset の実行には root 権限が必要(sudoers で pmset を NOPASSWD 許可している前提)。
// 設定が無い/失敗する環境でもエラーで止めない。
function rearmWake(tag) {
  try {
    const d = new Date();
    let when;
    if (tag === MORNING) {
      when = fmtWake(d, 17, 58); // 当日 17:58
    } else {
      d.setDate(d.getDate() + 1);
      when = fmtWake(d, 5, 58); // 翌日 05:58
    }
    execFileSync('sudo', ['-n', 'pmset', 'schedule', 'wake', when], { stdio: 'ignore' });
    console.log(`[daily] 次回の自動起床を予約: ${when}`);
  } catch {
    // sudoers 未設定など。自動起床の再設定はスキップ(手動運用は可能)。
  }
}
function fmtWake(d, hh, mm) {
  const p = (n) => String(n).padStart(2, '0');
  // pmset の書式: "MM/dd/yyyy HH:mm:ss"
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()} ${p(hh)}:${p(mm)}:00`;
}

// 直接実行されたときだけ main() を走らせる(importしても実行されない)。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
