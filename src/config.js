// ジャンル定義。
// - label:      商品ページの「Amazon売れ筋ランキング」項目で照合するジャンル名。
//               例) コミック -> 「Amazon売れ筋ランキング - コミック」の行を参照する。
// - searchBase: 「売れ筋ランキング順(exact-aware-popularity-rank)」でソートした
//               ジャンル全件の検索URL。ページ送り(&page=N)で順位順に商品が並ぶため、
//               201〜1000位の本そのものを候補として取得できる。
//               ※順位の確定は必ず各商品ページの登録情報で行う(検索順は候補抽出のみに使用)。
//
// 新しいジャンルを足したい場合はこのオブジェクトに追記するだけでよい。
// searchBase は対象ジャンルの検索結果を「売れ筋ランキング順」に並べ、
// URLからセッション固有パラメータ(ds, qid, ref など)を除いたもの。
export const GENRES = {
  コミック: {
    label: 'コミック',
    searchBase:
      'https://www.amazon.co.jp/s?i=stripbooks&rh=n%3A465392%2Cn%3A466280%2Cn%3A2278488051&s=exact-aware-popularity-rank',
  },
  ライトノベル: {
    label: 'ライトノベル',
    searchBase:
      'https://www.amazon.co.jp/s?i=stripbooks&rh=n%3A465392%2Cn%3A466280%2Cn%3A2189052051&s=exact-aware-popularity-rank',
  },
};

// 検索結果1ページあたりの商品件数(Amazonの仕様)。順位→ページ番号の換算に使う。
export const ITEMS_PER_SEARCH_PAGE = 16;

// 検索順位と商品ページ記載の順位は近いが厳密一致しないため、
// 目的の順位範囲に対応する検索ページの前後にこの数だけ余分に取得する。
export const PAGE_MARGIN = 7;

// 安全装置: 1回の実行で許容する「指定順位数(end - start + 1)」の上限。
// これを超える範囲を指定した場合は、抽出を実行する前にアラートを出して停止する。
// スクレイプするページ数が膨らみすぎないようにするためのもの。
export const MAX_RANK_SPAN = 300;

// 公開ランキングで見える範囲。201位以上のみを対象にする。
export const PUBLIC_RANK_LIMIT = 200;
export const MAX_SUPPORTED_RANK = 1000;

// ── 発売日モード(--date) 用 ──
// 検索の並び順を「発売日が新しい順」に切り替えるためのソート指定。
export const DATE_SORT = 'date-desc-rank';

// 安全装置: 1日分として許容する候補件数の上限。
// これを超える場合は、商品ページ巡回(=順位取得)を始める前にアラートして確認を促す。
export const MAX_DAILY_ITEMS = 200;
