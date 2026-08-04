// スペースアプリ(plugin)が space-state の reducer に自分固有の知識を持ち込むための契約
// (#1720 step6)。core(reduce.ts)は「app-state を apps[appId] へ最新値で格納する」ことしか
// 知らず、各アプリ固有の操作ログ・フェーズ判定・効果音/通知は一切持たない。
// plugin 側がこの型を実装した記述子を ReduceCtx.plugins に渡すことで、core を汚さずに
// アプリごとの畳み込みを追加できる。
//
// ⚠ ReduceCtx はここで定義し reduce.ts が re-export する(逆にすると
// reduce.ts ⇄ plugin.ts の循環 import になり depcruise の no-circular に違反する)。
import type { SpaceEffect } from './effects.ts';

export type ReduceCtx = {
  // 現行 useSpace の `name` 引数(自分の表示名)。
  selfName: string;
  // 純粋な文言解決関数。消費者が注入する(i18n の t をそのまま渡せる)。
  t: (key: string, ...args: any[]) => string;
  // Date.now() の注入(通知 tag / createdAt 既定値に使う。reducer 内で直接 Date.now() を呼ばない)。
  now: number;
  // 現行 presenceRef.current(space-state 受信時の再申告判定に使う)。
  presence: 'active' | 'away';
  // settings 省略時のフォールバック既定値（消費者が createSpaceStore の initialSettings で
  // 注入した値。store.ts の receive() が毎回積む）。space-state は特定アプリの設定既定値を
  // 知らないため、reduce.ts はこれを使う（'msg.settings || ctx.defaultSettings'）。
  defaultSettings: Record<string, any>;
  // スペースアプリ(plugin)の記述子一覧(#1720 step6)。core は自分ではアプリ固有ロジックを
  // 一切持たず、ここに渡された plugin だけが app-state を畳み込む。
  // 省略時は空配列(plugin 非依存の消費者はこのフィールドを渡さなくてよい)。
  plugins?: PluginClient[];
};

export type PluginClient = {
  // protocol の APP_IDS と一致する識別子。
  id: string;
  // 入室/再接続(space-state)時に呼ばれる。ここで返した値がこの plugin 専用のローカル
  // スライス(state.pluginLocal[id])の初期値になる。⚠ 「直前値を記録するだけ」に徹すること。
  // ここで判定して effect を出すと、入室のたびに「状態が変わった」ことになり、鳴っては
  // いけない場面で鳴ってしまう(#1591 で踏んだのと同じ理由)。
  initLocal?: (appState: any) => any;
  // app-state 受信時、msg.appId === this.id のときだけ core(reduce.ts)から呼ばれる。
  // apps[appId] への格納(最新値で置換)は core が既に行っているので、ここでは
  // 「自分のローカルスライスの更新」と「チャットのログ行」「効果音/通知」だけを返せばよい。
  onAppState?: (args: { local: any; msg: any; ctx: ReduceCtx }) => {
    local?: any;
    lines?: any[]; // pushChatLine に渡す行(順序どおりに積まれる)
    effects?: SpaceEffect[];
  };
};

// 型注釈を書かずに補完を効かせるための恒等関数(定義側で `: PluginClient` を書かずに済む)。
// 実体は引数をそのまま返すだけで、ロジックは持たない。
export function definePluginClient(c: PluginClient): PluginClient {
  return c;
}
