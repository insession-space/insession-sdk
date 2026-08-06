# insession-sdk

InSession の SDK パッケージ群を publish する pnpm workspace。npm に公開される
`@insession/*` パッケージのソース・オブ・トゥルースはここ。

> **作業規約は [`CLAUDE.md`](./CLAUDE.md) が正。** この README は「このリポジトリが何か」と
> 「一度きりのセットアップ手順」を扱う。日々の開発・リリース・置き場所の判断で守るべき規約は
> `CLAUDE.md` に集約してあり、ここでは繰り返さない（二重管理して片方だけ古くなるのを避けるため）。

## 何のリポジトリか

InSession 本体（[`insession-app`](https://github.com/insession-space/insession-app)）の
中で育ってきたが、外部（他プロダクト・OSS 利用者）にも配れる形をした汎用実装を、
本体から切り出して npm に公開するためのリポジトリ。

| パッケージ | 内容 |
| --- | --- |
| [`@insession/space`](./packages/space) | **space の親パッケージ。** 依存ゼロで、ヘッドレスなスペースを extension の集合として組み立てる。extension 契約（`defineSpaceExtension`）・集約 registry・参加者ライフサイクル（members / presence / 参加・離脱）・インスタンス（`createSpace`）を持つ。WS サーバーとストレージは利用者が自前で持ち、こちらは I/O を一切行わず effect 記述子を返すだけ。**グローバルなアプリ一覧を持たず（extensions 配列が唯一の真実）**、状態は `name` で名前空間化される |
| [`@insession/ws-resilient-transport`](./packages/ws-resilient-transport) | 本番デプロイの都合に合わせて再接続する WebSocket トランスポート。サービス再起動時の高速再接続とジッター付き指数バックオフを両立する。依存ゼロ |
| [`@insession/space-state`](./packages/space-state) | transport・フレームワーク非依存のスペース状態 store。受信は純粋 reducer、副作用は記述子で返すだけ。依存ゼロ |
| [`@insession/space-state-react`](./packages/space-state-react) | 上を React の `useSyncExternalStore` に繋ぐ薄いラッパー |
| [`@insession/extension-pomodoro`](./packages/extension-pomodoro) | 依存ゼロのポモドーロタイマー状態機械。server-authoritative で `reduce` は純関数 |
| [`@insession/extension-whiteboard`](./packages/extension-whiteboard) | 依存ゼロのホワイトボード状態機械。自由描画の strokes/shapes と「お絵かき伝言ゲーム」relay を持つ `reduce` は純関数。唯一の外部依存（投稿画像URLの許可判定）はファクトリ `createWhiteboardState` の引数として注入する |
| [`@insession/extension-watch-party`](./packages/extension-watch-party) | 依存ゼロの Watch Party（動画/音声の同期再生）状態機械。`reduce` は `{ state, effects }` を返す純関数で、broadcast/persist/タイトル解決は effect 記述子としてホストに委ねる。唯一の外部依存（ランダム再生の選択ロジック）はファクトリ `createWatchParty` の `pickShuffleIndex` 引数として注入する |
| [`@insession/extension-chat`](./packages/extension-chat) | 依存ゼロのチャット状態機械。メッセージの正規化・スタンプ検証・返信・リアクション・ピン留めを担う。ログはホストの DB が持つ前提で、メモリに置くのはピン留めだけ。ストレージにしか作れない値（永続 id 等）が要る3つの流れは、`reduce` を async にせず2段の往復（effect 記述子 → 結果を戻す）で表現する |

plugin の **server 面**（UI・i18n・design-system への依存を持たない純粋な状態機械）はこのリポジトリへ移設する方針で、`extension-pomodoro` / `extension-whiteboard` がその実例。**UI を持つ部分**（client 面。`pomodoro-kit` 等）はプロダクト判断を抱えるため `insession-app` に残す
（何をここへ入れてよいかの判断は `CLAUDE.md` の「入れるもの / 入れないもの」を参照）。

## なぜ InSession 本体から分かれているか

- **npm 公開の作法（Trusted Publishing・`publishConfig`・`files` での配布物限定）を
  本体の他コードから隔離するため。** 本体（`insession-app`）は private のまま、
  ここだけが public パッケージの入り口になる。
- **消費のされ方が違う。** 本体内では `.ts` ソースをそのまま Vite / Node のネイティブ
  型ストリップに解決させていたが、外部の npm パッケージとしては `dist`（`.js` + `.d.ts`）
  をビルドして配る必要がある（Node は `node_modules` 配下の `.ts` を型ストリップしない）。
- 兄弟リポジトリの `design-system`（`@insession/design-system`）と同じ設計・作法を踏襲している。
  設定に迷ったらそちらを参照する。

## 構成

```
insession-sdk/
├── packages/
│   ├── space/                    # @insession/space（space の親）
│   ├── ws-resilient-transport/   # @insession/ws-resilient-transport
│   ├── space-state/              # @insession/space-state
│   ├── space-state-react/        # @insession/space-state-react
│   ├── extension-pomodoro/       # @insession/extension-pomodoro
│   ├── extension-whiteboard/     # @insession/extension-whiteboard
│   ├── extension-watch-party/    # @insession/extension-watch-party
│   └── extension-chat/           # @insession/extension-chat
├── .changeset/
├── CLAUDE.md        # 作業規約（開発・changeset・リリース・置き場所の判断）
└── .github/workflows/
    ├── ci.yml       # PR / main push の検証（pnpm verify + pnpm build を呼ぶだけ）
    └── release.yml  # main push で Changesets の採番・npm publish
```

## 開発の仕方

```bash
pnpm install
pnpm verify   # typecheck + Biome + test（CI と同じ判定）
pnpm build    # 全パッケージの dist を生成
```

**PR を作る前に `pnpm changeset` を積むこと。** 積み忘れると version が上がらず publish されない。
詳細と例外は `CLAUDE.md` の「PR を作る前に changeset を積む」を参照。

## リリース

Changesets で採番し、`main` への push で npm publish する。`main` に push されると
Version PR が作られ、それをマージすると `release.yml` が npm publish する。

**publish は npm の Trusted Publishing（OIDC）で行う方針。トークンは使わない。**
`release.yml` を触るときに壊してはいけない点（`NPM_TOKEN` を渡さない・`publishConfig.registry`
を外さない・npm CLI の版を下げない）は `CLAUDE.md` の「リリース」を参照。

### ⚠ 初回 publish 前に、リポジトリ外の設定を2つ済ませる

これは `design-system`（`insession-space/design-system`）で実際に publish が2回連続で
404 失敗した経緯から判明したもの。**このリポジトリでも初回 publish 前に必ず両方を確認すること。**

1. **npm 側: パッケージごとに Trusted Publisher を登録する。**
   未登録だと OIDC トークンが認証情報に交換されず、`PUT` が `E404 Not Found` で拒否される
   （npm は権限不足を 403 ではなく 404 で返す。パッケージの存在を隠すため）。

   > ### ⚠ 新規パッケージは、この登録を先に行えない
   >
   > **Trusted Publisher の登録画面はパッケージページ配下にあるため、まだ npm に無いパッケージには登録できない。**
   > 新規パッケージだけは順序が逆になる:
   >
   > 1. 手元から初回版を publish してパッケージを作る（`npm login` → `npm publish --otp=<6桁>`）
   > 2. できたパッケージページで Trusted Publisher を登録する
   > 3. 以降の版は CI（OIDC）から provenance 付きで出る
   >
   > **初回版だけは provenance が付かない。**これは避けられない
   > （`@insession/ws-resilient-transport` も `0.1.0` だけ provenance が無く、`0.2.0` 以降に付いている）。
   >
   > 順序を間違えると Version PR をマージした瞬間に release が `E404` で落ちる。ただし壊れるものは無く、
   > 採番のコミットが `main` に載るだけなので、手動 publish するか run を再実行すれば復旧する。
   >
   > **切り分け**: `E404` は未ログイン・権限不足・Trusted Publisher 未登録のどれでも同じ形で出る。
   > `npm whoami --registry https://registry.npmjs.org/` が `401` なら単に未ログイン。
   >
   > **publish 後の確認に `npm view` を使わないこと** — 開発機の `~/.npmrc` が読み取りを社内プロキシへ
   > 向けている場合、出たばかりのパッケージが `404` に見える。公開レジストリを直接見る:
   > `curl -s https://registry.npmjs.org/@insession%2F<名前> | jq '.["dist-tags"]'`

   > `https://www.npmjs.com/package/@insession/<パッケージ名>/access` → Trusted Publisher
   >
   > | 項目 | 値 |
   > | --- | --- |
   > | Publisher | GitHub Actions |
   > | Organization or user | `insession-space` |
   > | Repository | `insession-sdk` |
   > | Workflow filename | `release.yml` |
   > | Environment | （空欄。`release.yml` は environment を使わない） |

2. **GitHub org 側: 「Allow GitHub Actions to create and approve pull requests」をON。**
   未設定だと Version PR が作られず、採番が進まない（`release.yml` はワークフロー側で
   `pull-requests: write` を宣言しているが、それとは別に org のポリシーで弾かれる）。

   > `https://github.com/organizations/insession-space/settings/actions` → Workflow permissions →
   > **「Allow GitHub Actions to create and approve pull requests」** をON

## ライセンス

MIT
