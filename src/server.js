#!/usr/bin/env node
// 同一Wi-Fi内のiPad等から使うためのローカルWebサーバー。
// 依存を増やさないため Node 標準モジュールのみで実装。
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, readdir, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import { networkInterfaces } from 'node:os';
import { GENRES } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const RESULTS_DIR = join(ROOT, 'results');
const PORT = Number(process.env.PORT) || 3000;

// 同時に1件だけ実行する簡易ジョブ管理
const job = { running: false, log: [], startedAt: null, label: '', lastFile: null };

await mkdir(RESULTS_DIR, { recursive: true });

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

// 抽出ジョブを起動(本日発売 or 順位帯)。既存CLIをそのまま子プロセスで実行。
function startJob({ genre, mode, date, from, to }) {
  if (job.running) return { ok: false, error: 'すでに実行中です。' };
  if (!GENRES[genre]) return { ok: false, error: 'ジャンルが不正です。' };

  const stamp = (date || todayStr()).replaceAll('-', '');
  let outName;
  const args = ['src/cli.js', '--genre', genre];
  if (mode === 'date') {
    const d = date || todayStr();
    args.push('--date', d, '--yes');
    outName = `${genre}_発売日${stamp}.csv`;
    job.label = `${d} 発売の${genre}`;
  } else {
    args.push('--from', String(from), '--to', String(to));
    outName = `${genre}_順位${from}-${to}_${stamp}.csv`;
    job.label = `${genre} ${from}〜${to}位`;
  }
  const outPath = join(RESULTS_DIR, outName);
  args.push('--out', outPath);

  job.running = true;
  job.log = [];
  job.startedAt = Date.now();
  job.lastFile = null;

  // launchd 常駐時は PATH が最小限のため、bare 'node' ではなく実行中の node の絶対パスを使う。
  const child = spawn(process.execPath, args, { cwd: ROOT });
  const onData = (buf) => {
    for (const line of buf.toString().split('\n')) {
      if (line.trim()) job.log.push(line.replace(/\s+$/, ''));
    }
    if (job.log.length > 500) job.log.splice(0, job.log.length - 500);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('close', (code) => {
    job.running = false;
    if (code === 0 && existsSync(outPath)) job.lastFile = outName;
    else job.log.push(`⚠️ 実行終了(コード ${code})。`);
  });

  return { ok: true };
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function listResults() {
  const files = (await readdir(RESULTS_DIR)).filter((f) => f.endsWith('.csv'));
  const out = [];
  for (const f of files) {
    const s = await stat(join(RESULTS_DIR, f));
    out.push({ file: f, size: s.size, mtime: s.mtimeMs });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function lanIp() {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return 'localhost';
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    if (path === '/' ) {
      return send(res, 200, HTML, { 'Content-Type': 'text/html; charset=utf-8' });
    }
    if (path === '/api/config') {
      return send(res, 200, { genres: Object.keys(GENRES), today: todayStr() });
    }
    if (path === '/api/run' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const params = JSON.parse(body || '{}');
      return send(res, 200, startJob(params));
    }
    if (path === '/api/status') {
      return send(res, 200, {
        running: job.running,
        label: job.label,
        startedAt: job.startedAt,
        log: job.log.slice(-40),
        lastFile: job.lastFile,
      });
    }
    if (path === '/api/results') {
      return send(res, 200, await listResults());
    }
    if (path === '/api/csv') {
      const f = basename(url.searchParams.get('file') || '');
      const p = join(RESULTS_DIR, f);
      if (!f.endsWith('.csv') || !existsSync(p)) return send(res, 404, { error: 'not found' });
      const data = await readFile(p);
      const dl = url.searchParams.get('dl');
      const headers = { 'Content-Type': 'text/csv; charset=utf-8' };
      if (dl) headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(f)}"`;
      res.writeHead(200, headers);
      return res.end(data);
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: String(e && e.message) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n📚 Amazonランキング抽出 Web画面を起動しました。`);
  console.log(`   このMac: http://localhost:${PORT}`);
  console.log(`   iPad等(同じWi-Fi): http://${lanIp()}:${PORT}\n`);
});

const HTML = `<!doctype html>
<html lang="ja"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Amazonランキング抽出</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 16px; max-width: 880px; margin: 0 auto; line-height: 1.6; }
  h1 { font-size: 1.3rem; }
  .card { border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 12px; padding: 16px; margin: 14px 0; }
  label { display: block; font-weight: 600; margin: 10px 0 4px; }
  select, input { font-size: 16px; padding: 8px; border-radius: 8px; border: 1px solid #aaa; width: 100%; box-sizing: border-box; }
  .row { display: flex; gap: 12px; } .row > div { flex: 1; }
  button { font-size: 16px; padding: 12px 16px; border-radius: 10px; border: 0; background: #2563eb; color: #fff; font-weight: 700; cursor: pointer; width: 100%; margin-top: 12px; }
  button.sec { background: #475569; }
  button:disabled { opacity: .5; }
  .seg { display: flex; gap: 8px; margin: 6px 0; }
  .seg button { width: auto; flex: 1; margin: 0; background: #e5e7eb; color: #111; }
  .seg button.on { background: #2563eb; color: #fff; }
  pre { background: rgba(127,127,127,.12); padding: 10px; border-radius: 8px; max-height: 220px; overflow: auto; font-size: 12px; white-space: pre-wrap; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { border-bottom: 1px solid rgba(127,127,127,.25); padding: 6px 8px; text-align: left; }
  .muted { opacity: .7; font-size: 13px; }
  a { color: #2563eb; }
</style></head>
<body>
<h1>📚 Amazonランキング抽出</h1>

<div class="card">
  <div class="seg">
    <button id="mDate" class="on" onclick="setMode('date')">本日発売</button>
    <button id="mRank" onclick="setMode('rank')">順位帯</button>
  </div>
  <label>ジャンル</label>
  <select id="genre"></select>

  <div id="dateBox">
    <label>発売日</label>
    <input type="date" id="date">
    <div class="muted">未来日は不可（明日以降は予約順位のため）。</div>
  </div>

  <div id="rankBox" style="display:none">
    <div class="row">
      <div><label>開始順位</label><input type="number" id="from" value="201" min="201" max="1000"></div>
      <div><label>終了順位</label><input type="number" id="to" value="300" min="201" max="1000"></div>
    </div>
  </div>

  <button id="runBtn" onclick="run()">抽出を開始</button>
</div>

<div class="card" id="statusCard" style="display:none">
  <strong id="statusTitle"></strong>
  <pre id="log"></pre>
</div>

<div class="card">
  <strong>保存済みの結果</strong>
  <div id="results" class="muted">読み込み中…</div>
</div>

<div class="card" id="tableCard" style="display:none">
  <strong id="tableTitle"></strong>
  <div style="overflow:auto"><table id="table"></table></div>
</div>

<script>
let mode = 'date';
function setMode(m){ mode=m;
  document.getElementById('mDate').className = m==='date'?'on':'';
  document.getElementById('mRank').className = m==='rank'?'on':'';
  document.getElementById('dateBox').style.display = m==='date'?'':'none';
  document.getElementById('rankBox').style.display = m==='rank'?'':'none';
}
async function init(){
  const c = await (await fetch('/api/config')).json();
  const g = document.getElementById('genre');
  g.innerHTML = c.genres.map(x=>'<option>'+x+'</option>').join('');
  document.getElementById('date').value = c.today;
  document.getElementById('date').max = c.today;
  loadResults();
  poll();
}
async function run(){
  const genre = document.getElementById('genre').value;
  const body = { genre, mode };
  if(mode==='date') body.date = document.getElementById('date').value;
  else { body.from = +document.getElementById('from').value; body.to = +document.getElementById('to').value; }
  const r = await (await fetch('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
  if(!r.ok){ alert(r.error||'開始できませんでした'); return; }
  document.getElementById('statusCard').style.display='';
  poll();
}
async function poll(){
  const s = await (await fetch('/api/status')).json();
  const card = document.getElementById('statusCard');
  if(s.startedAt){ card.style.display='';
    document.getElementById('statusTitle').textContent = (s.running?'⏳ 実行中: ':'✅ 完了: ') + (s.label||'');
    document.getElementById('log').textContent = (s.log||[]).join('\\n');
  }
  document.getElementById('runBtn').disabled = s.running;
  if(s.running){ setTimeout(poll, 2000); }
  else { loadResults(); if(s.lastFile) showTable(s.lastFile); }
}
async function loadResults(){
  const list = await (await fetch('/api/results')).json();
  const el = document.getElementById('results');
  if(!list.length){ el.innerHTML='まだありません。'; return; }
  el.innerHTML = list.map(f=>{
    const d = new Date(f.mtime).toLocaleString('ja-JP');
    return '<div style="margin:8px 0">📄 <a href="#" onclick="showTable(\\''+f.file+'\\');return false">'+f.file+'</a>'
      +' <span class="muted">'+d+'</span><br>'
      +'<a href="/api/csv?dl=1&file='+encodeURIComponent(f.file)+'">CSVダウンロード</a></div>';
  }).join('');
}
async function showTable(file){
  const txt = await (await fetch('/api/csv?file='+encodeURIComponent(file))).text();
  const rows = txt.replace(/^\\ufeff/,'').trim().split('\\n').map(parseCsvLine);
  const head = rows.shift()||[];
  document.getElementById('tableCard').style.display='';
  document.getElementById('tableTitle').textContent = file + '（'+rows.length+'件）';
  const thead = '<tr>'+head.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr>';
  const body = rows.map(r=>'<tr>'+r.map(c=>'<td>'+esc(c)+'</td>').join('')+'</tr>').join('');
  document.getElementById('table').innerHTML = thead+body;
  document.getElementById('tableCard').scrollIntoView({behavior:'smooth'});
}
function parseCsvLine(line){
  const out=[]; let cur=''; let q=false;
  for(let i=0;i<line.length;i++){ const ch=line[i];
    if(q){ if(ch==='"'){ if(line[i+1]==='"'){cur+='"';i++;} else q=false; } else cur+=ch; }
    else { if(ch===','){out.push(cur);cur='';} else if(ch==='"'){q=true;} else cur+=ch; } }
  out.push(cur); return out;
}
function esc(s){ return (s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
init();
</script>
</body></html>`;
