// 商品ページの「登録情報」内テキストから必要な値を取り出すパーサ群。
// ネットワークやブラウザに依存しない純粋関数なので単体テストしやすい。

// 「Amazon 売れ筋ランキング: 本 - X,XXX位 ... コミック - YYY位」のような
// テキストから、指定ジャンルの順位を取り出す。
// 見つからなければ null を返す。
export function extractGenreRank(detailText, genreLabel) {
  if (!detailText) return null;

  // 全角スペース・改行を正規化
  const text = detailText.replace(/　/g, ' ').replace(/\s+/g, ' ');

  // 「<ジャンル> - 123位」または「<ジャンル>で123位」などの揺れを許容。
  // ジャンルラベル直後に現れる最初の「N位」を拾う。
  const escaped = genreLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 直前が日本語文字でない位置に限定し、「少年コミック」を「コミック」と誤マッチしない。
  const re = new RegExp(
    `(?<![一-龠ぁ-んァ-ンー])${escaped}[\\s\\u00A0]*[-–—での]?[\\s\\u00A0]*([0-9,]+)\\s*位`
  );
  const m = text.match(re);
  if (!m) return null;

  const rank = parseInt(m[1].replace(/,/g, ''), 10);
  return Number.isFinite(rank) ? rank : null;
}

// タイトルから巻数を推定する。
// 「(3)」「第3巻」「3巻」「vol.3」「上/中/下」などのパターンに対応。
// 取れなければ null。
export function extractVolume(title) {
  if (!title) return null;
  const t = title.replace(/　/g, ' ');

  const patterns = [
    /[第\s]?\s*([0-9０-９]{1,4})\s*巻/, // 第3巻 / 3巻
    /[（(]\s*([0-9０-９]{1,4})\s*[）)]/, // (3) / （３９） 全角半角カッコ両対応
    /vol\.?\s*([0-9]{1,4})/i, // vol.3
    /\bV\s*([0-9]{1,4})\b/, // V3
    /\s([0-9０-９]{1,4})\s*[(（]/, // 呪術廻戦 26 (ジャンプコミックス)
    /\s([0-9０-９]{1,3})\s+[～〜]/, // タイトル 3 ～サブタイトル～
    /\s([0-9０-９]{1,4})\s*$/, // 末尾の裸の巻数
  ];
  for (const p of patterns) {
    const m = t.match(p);
    if (m) return toHankakuInt(m[1]);
  }
  // 上中下巻
  const jp = t.match(/[（(]?\s*([上中下])巻?\s*[)）]?/);
  if (jp) return { 上: 1, 中: 2, 下: 3 }[jp[1]];

  return null;
}

// 発売日テキスト(例「2024/3/4」「2024年3月4日」)を YYYY-MM-DD に正規化。
export function normalizeReleaseDate(raw) {
  if (!raw) return null;
  const t = raw.replace(/　/g, ' ').trim();

  let m = t.match(/(\d{4})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})/);
  if (m) {
    return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  }
  m = t.match(/(\d{4})\s*[年./-]\s*(\d{1,2})月?/);
  if (m) return `${m[1]}-${pad(m[2])}`;
  return t || null;
}

// 検索結果カードのテキストから「発売(出版)日」を YYYY-MM-DD で取り出す。
// 「お届け 11月8日」のような配送日(年なし)は拾わない。
export function extractCardReleaseDate(cardText) {
  if (!cardText) return null;
  const t = cardText.replace(/　/g, ' ');

  // 「(出版予定)日は2026年11月6日」
  let m = t.match(/(?:出版予定日|発売日|出版日)\s*は?\s*(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;

  // 著者名の後などに現れる「2026/11/6」形式
  m = t.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;

  return null;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function toHankakuInt(s) {
  const han = String(s).replace(/[０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  );
  const n = parseInt(han, 10);
  return Number.isFinite(n) ? n : null;
}
