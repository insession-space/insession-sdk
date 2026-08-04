# insession-sdk

InSession の SDK パッケージ群を publish する pnpm workspace。npm に公開される
`@insession/*` パッケージのソース・オブ・トゥルースはここ。

## 何のリポジトリか

InSession 本体（[`insession-app`](https://github.com/insession-space/insession-app)）の
中で育ってきたが、外部（他プロダクト・OSS 利用者）にも配れる形をした汎用実装を、
本体から切り出して npm に公開するためのリポジトリ。

第一弾は `packages/ws-resilient-transport`（`@insession/ws-resilient-transport`）。
サービス再起動時の高速再接続とジッター付き指数バックオフを両立する、依存ゼロの
WebSocket 再接続トランスポート。将来的に space-state / space-state-react /
plugin-pomodoro / pomodoro-kit もここへ移設する前提で骨組みを作ってある。

## なぜ InSession 本体から分かれているか

- **npm 公開の作法（Trusted Publishing・`publishConfig`・`files` での配布物限定）を
  本体の他コードから隔離するため。** 本体（`insession-app`）は private のまま、
  ここだけが public パッケージの入り口になる。
- **消費のされ方が違う。** 本体内では `.ts` ソースをそのまま Vite / Node のネイティブ
  型ストリップに解決させていたが、外部の npm パッケージとしては `dist`（`.js` + `.d.ts`）
  をビルドして配る必要がある（Node は `node_modules` 配下の `.ts` を型ストリップしない）。
- 兄弟リポジトリの `design-system`（`@insession/design-system`）と同じ設計・作法を踏襲している。
  設定に迷ったらそちらを参照する。

## 開発の仕方

```bash
pnpm install
pnpm verify   # typecheck + Biome + test（CI と同じ判定）
pnpm build    # 全パッケージの dist を生成
```

新しいパッケージを `packages/` に足す場合は、既存の `ws-resilient-transport` の
`package.json` / `tsup.config.ts` / `tsconfig.json` を雛形にすること。

## リリース

Changesets でバージョンを採番し、`main` への push で npm へ publish する。

```bash
pnpm changeset      # 変更の intent を積む
```

`main` に push されると Version PR が作られ、それをマージすると `release.yml` が
npm publish する。

**publish は npm の Trusted Publishing（OIDC）で行う方針。トークンは使わない。**
`release.yml` は `id-token: write` を持ち、`NPM_TOKEN` を**意図的に env へ渡していない**
（`changesets/action` は env に `NPM_TOKEN` があればトークン publish を優先するため、
渡すと OIDC が使われなくなる）。

### ⚠ OIDC publish が成立するには、リポジトリ外の設定が2つ必要

これは `design-system`（`insession-space/design-system`）で実際に publish が2回連続で
404 失敗した経緯から判明したもの。**このリポジトリでも初回 publish 前に必ず両方を確認すること。**

1. **npm 側: パッケージごとに Trusted Publisher を登録する。**
   未登録だと OIDC トークンが認証情報に交換されず、`PUT` が `E404 Not Found` で拒否される
   （npm は権限不足を 403 ではなく 404 で返す。パッケージの存在を隠すため）。

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

`package.json` の `publishConfig.registry` で公開レジストリを明示している。
**これを外さないこと** — 開発機の `~/.npmrc` が社内プロキシを `registry` に設定していると、
publish がプロキシ宛になって公開レジストリに出ない。

### ローカルから publish する場合

npm はアカウントの 2FA か「bypass 2FA 付き granular access token」を要求するので、
CI（OIDC）経由が基本。手元から publish すると provenance の無い版がレジストリに残るため、
**通常は行わないこと**。

## 構成

```
insession-sdk/
├── packages/
│   └── ws-resilient-transport/   # @insession/ws-resilient-transport
├── .changeset/
└── .github/workflows/
    ├── ci.yml       # PR / main push の検証（typecheck + Biome + test + build）
    └── release.yml  # main push で Changesets の採番・npm publish
```

## ⚠ このリポジトリに入れるもの / 入れないもの

**入れるのは「契約とランタイム」だけ。** プロダクトの意見を持たない、InSession が無くても意味が通るものに限る。

| 入れる | 入れない |
| --- | --- |
| `ws-resilient-transport`（汎用の WebSocket 再接続。InSession 固有の情報を1つも含まない） | **plugin**（`plugin-pomodoro` 等）。UI・i18n キー・プロダクト判断を抱えるので insession-app 側に置く |
| `space-state` / `space-state-react`（依存は protocol だけの状態機械と、その React バインディング） | **UI を持つもの全般**。`@insession/design-system` への依存をこのリポジトリに持ち込まない |

**「`@insession/*` スコープだから」という理由だけでここへ移さないこと。** スコープは「OSS 候補である」という表明でしかなく、置き場所の判断とは別。plugin をここへ入れると次の3つが同時に起きる:

1. **SDK が design-system に依存する** — UI プリミティブを直すたびに design-system → insession-sdk → insession-app の**3リポジトリ往復**になる
2. **共有物の消費者が向こう側に残る** — たとえば `pomodoro-kit` は space の plugin とマイルームの道具の両方が使い、どちらも insession-app 内に居る。切り出すとパネルを 1px 直すたびに publish サイクルが要る
3. **リリース周期が混ざる** — 契約層は安定していてほしいが、plugin はプロダクトと一緒に動く。同居させると採番が互いに引きずられる

外部に「space を作れる SDK」を出すのに plugin は必須ではない。`definePluginClient` の**契約さえ配れば、消費者は自分の plugin を書ける**。plugin 自体を配りたくなったら、このリポジトリに足すのではなく別リポジトリ（`insession-plugins` 等）を立てて判断する。

## ライセンス

MIT
