// 「本日発売の新刊コミック」TOP5のX投稿ドラフトを組み立てる。
// - 巻数1〜10のみ対象(11巻以上は除外)。巻数不明は含めるが要確認フラグ。
// - 順位(コミック売れ筋ランキング)の小さい順に上位5件。
// 純粋関数なのでネットワーク非依存でテストできる。

const CIRCLED = ['①', '②', '③', '④', '⑤'];

// 日付(YYYY-MM-DD)を「2026年8月20日」表記に。
export function jpDate(dateStr) {
  const m = String(dateStr).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return dateStr;
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
}

// 投稿本文(引用は投稿時に付与)。ユーザー提示のテンプレートに準拠。
export function tweetText(dateStr, circled, title) {
  return `【${jpDate(dateStr)}時点】\n📚今売れている注目の新刊コミック${circled}\n\n${title}`;
}

// 差し替え候補プール: 巻1〜10かつ順位が取れた作品を順位順に返す。
// 画面上でTOP5を手動で入れ替えるための母集団。
export function buildPool(records, dateStr, mergedRankByAsin = new Map(), limit = 20) {
  return records
    .map((r) => ({ ...r, rank: mergedRankByAsin.get(r.asin) ?? r.rank }))
    .filter((r) => r.volume == null || (r.volume >= 1 && r.volume <= 10))
    .filter((r) => r.rank != null && Number.isFinite(r.rank))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map((r) => ({
      asin: r.asin,
      タイトル: r.title,
      巻数: r.volume,
      順位: r.rank,
      amazonUrl: r.asin ? `https://www.amazon.co.jp/dp/${r.asin}` : null,
      要巻数確認: r.volume == null,
      検索URL: `https://twitter.com/search?q=${encodeURIComponent(r.title + ' 発売')}&f=live`,
    }));
}

// records: [{asin,title,volume,rank,date}] (18時時点)
// mergedRankByAsin: 公開ランキング等で補正した asin->順位 (任意)
export function buildXTop5(records, dateStr, mergedRankByAsin = new Map()) {
  const rows = records.map((r) => {
    const rank = mergedRankByAsin.get(r.asin) ?? r.rank;
    return { ...r, rank };
  });

  // 巻数フィルタ: 1〜10のみ。11以上は除外。不明(null)は残して要確認。
  const filtered = rows.filter((r) => {
    if (r.volume == null) return true; // 巻数不明 → 残す(要確認)
    return r.volume >= 1 && r.volume <= 10;
  });

  // 順位がとれたものだけ順位昇順。順位なしは対象外(TOP5には入れない)。
  const ranked = filtered
    .filter((r) => r.rank != null && Number.isFinite(r.rank))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 5);

  return ranked.map((r, i) => {
    const circled = CIRCLED[i];
    const url = r.asin ? `https://www.amazon.co.jp/dp/${r.asin}` : null;
    return {
      位: i + 1,
      丸数字: circled,
      タイトル: r.title,
      巻数: r.volume,
      順位: r.rank,
      asin: r.asin,
      amazonUrl: url,
      要巻数確認: r.volume == null,
      投稿文: tweetText(dateStr, circled, r.title),
      検索URL: `https://twitter.com/search?q=${encodeURIComponent(r.title + ' 発売')}&f=live`,
    };
  });
}
