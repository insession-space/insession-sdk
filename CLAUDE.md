# insession-sdk — npm に公開する `@insession/*` の source of truth

このリポジトリは **npm へ public 公開されるパッケージ群だけを置く場所**。プロダクト本体（`insession-app`）は private の別リポジトリで、ここはその外に出せる部分の入り口にあたる。

**このファイルが作業規約の正。** ルート `README.md` は「このリポジトリが何か」を外部/新規開発者へ説明する文書として残してあり、**同じ規約を二重管理しない**ために、リリース手順・置き場所の判断・技術スタックの詳細はこちらへ寄せてある。README 側は要点だけ持ち、詳細はこのファイルを指す。

## パッケージ一覧

| ディレクトリ | パッケージ | 内容 | 依存 |
| --- | --- | --- | --- |
| `packages/ws-resilient-transport` | `@insession/ws-resilient-transport` | 本番デプロイの都合に合わせて再接続する WebSocket トランスポート（サービス再起動時の高速再接続 / ジッター付き指数バックオフ / terminal close code） | **なし** |
| `packages/space-state` | `@insession/space-state` | transport・フレームワーク非依存のスペース状態 store。受信は純粋 reducer、送信は `onSend` に流すだけ、副作用は effect 記述子で返すだけ | **なし** |
| `packages/space-state-react` | `@insession/space-state-react` | 上を React の `useSyncExternalStore` に繋ぐ薄いラッパー（1関数） | `space-state` / peer に `react` |
| `packages/plugin-pomodoro-state` | `@insession/plugin-pomodoro-state` | 依存ゼロのポモドーロタイマー状態機械（server-authoritative。`reduce` は純関数、`restore`/`persistState` で永続化境界を扱う） | **なし** |
| `packages/plugin-whiteboard-state` | `@insession/plugin-whiteboard-state` | 依存ゼロのホワイトボード状態機械（server-authoritative。自由描画の strokes/shapes と「お絵かき伝言ゲーム」relay を同居させた `reduce` は純関数） | **なし** |
| `packages/plugin-watch-party-state` | `@insession/plugin-watch-party-state` | 依存ゼロの Watch Party（動画/音声の同期再生）状態機械（server-authoritative。`reduce` は `{ state, effects }` を返す純関数で、broadcast/永続化/タイトル解決は effect 記述子としてホストに委ねる） | **なし** |
| `packages/chat-state` | `@insession/chat-state` | 依存ゼロのチャット状態機械（server-authoritative。メッセージの正規化・スタンプ検証・返信・リアクション・ピン留め。`reduce` は `{ state, effects }` を返す純関数で、永続化/broadcast/bot 通知は effect 記述子としてホストに委ねる） | **なし** |

**依存の向きは `space-state-react` → `space-state` の一方向だけ。** `ws-resilient-transport` と `plugin-pomodoro-state` / `plugin-whiteboard-state` / `plugin-watch-party-state` / `chat-state` は完全に独立していて、他のパッケージと繋がっていない（transport と状態管理を分けているのが設計の要点なので、ここに依存を足さない）。

**「依存ゼロ」は `ws-resilient-transport` / `space-state` / `plugin-pomodoro-state` / `plugin-whiteboard-state` / `plugin-watch-party-state` / `chat-state` の売り。** 便利だからという理由でランタイム依存を1つでも足すと、このパッケージを選ぶ理由が消える。足したくなったら、まずそれが本当にこのリポジトリに置くべきものかを下記「入れるもの / 入れないもの」で判断すること。

## 開発の仕方

```bash
pnpm install
pnpm verify   # typecheck + Biome + test
pnpm build    # 全パッケージの dist を生成
```

**`pnpm verify` が「CI と同じ判定」の単一ソース。** `.github/workflows/ci.yml` は `pnpm verify` と `pnpm build` を呼ぶだけで、個別のチェックを列挙していない。**CI 側にチェックを直接足さないこと** — 列挙すると「CI では走るが手元の `pnpm verify` では走らない」検査が静かに生まれ、PR 前の確認が CI と一致しなくなる。検査を増やすなら `package.json` の `verify` に足す。

新しいパッケージを `packages/` に足すときは、既存の `ws-resilient-transport` の `package.json` / `tsup.config.ts` / `tsconfig.json` を雛形にする。

## ⚠ PR を作る前に changeset を積む

**changeset が無いと version が上がらず、Version PR も publish も起きない。**

```bash
pnpm changeset
```

「マージしたのに npm に出ない」という形で後から気づくことになるので、**出荷物に影響する変更なら必ず積む**。

- **README も配布物**（`package.json` の `files` に入っていて npm のパッケージページに出る）。README だけの変更でも `patch` を積む
- ドキュメントのみで npm 配布物に影響しない変更（このファイル、`.github/`、ルート `README.md`）は積まなくてよい
- このリポジトリの CI には `changeset-required` ジョブが**無い**ので、積み忘れても PR は赤くならない。**赤くならないぶん、自分で気づくしかない**

## リリース

Changesets で採番し、`main` への push で npm publish する。

1. `main` に push されると `release.yml` が積まれた changeset から **Version PR（`chore: version packages`）** を作る
2. その Version PR をマージすると（＝再び `main` へ push）、同じ job が **npm publish** する

### ⚠ 触ると publish が壊れる3点

いずれも「壊れても手元では何も起きず、publish の瞬間に初めて失敗する」種類のもの。

1. **`release.yml` の env に `NPM_TOKEN` を足さないこと。**
   publish は npm の **Trusted Publishing（OIDC）** で行う方針で、`release.yml` は `id-token: write` を持っている。`changesets/action` は **env に `NPM_TOKEN` があればトークン publish を優先する**ため、渡すと OIDC が使われなくなる。OIDC を捨ててトークン運用に戻す判断をしたときだけ足す。
2. **`package.json` の `publishConfig.registry` を外さないこと。**
   開発機の `~/.npmrc` が社内プロキシを `registry` に設定していると、これが無い場合 publish がプロキシ宛になり**公開レジストリに出ない**。
3. **`release.yml` の `npm install -g npm@11` を消さないこと。**
   OIDC publish は npm CLI 11.5.1 以降にしか実装が無く、Node 22/24 の同梱 npm では届かない。これが無いと npm は OIDC 交換を行わず、`E404 Not Found - PUT ...` で失敗する（**npm は書き込み権限不足を 403 ではなく 404 で返す**ので「パッケージが無い」ように見えて紛らわしい）。

### ⚠ OIDC publish にはリポジトリ外の設定が2つ要る

兄弟リポジトリ `design-system` で publish が実際に2回連続で失敗して判明した経緯がある。**初回 publish 前に必ず両方を確認すること。** 手順の詳細はルート `README.md` の「リリース」節にある。

1. **npm 側**: パッケージごとに Trusted Publisher（GitHub Actions / `insession-space` / `insession-sdk` / `release.yml`）を登録する。未登録だと OIDC トークンが認証情報に交換されず publish が E404 で落ちる。**⚠ 新規パッケージはこの登録が先にできない** — 下記「新規パッケージの初回だけは手動 publish が要る」を参照
2. **GitHub org 側**: 「Allow GitHub Actions to create and approve pull requests」をON。未許可だと Version PR が作られず採番が進まない

### ⚠ 新規パッケージの初回だけは手動 publish が要る（順序が逆にできない）

**Trusted Publisher は「既に存在するパッケージ」にしか登録できない。** 登録画面が `https://www.npmjs.com/package/@insession/<名前>/access` というパッケージページ配下にあるため、まだ npm に無いパッケージには登録しようがない。つまり上の「初回 publish 前に登録する」は**新規パッケージには適用できない**。

したがって新規パッケージの立ち上げはこの順序になる:

1. **手元から初回版を publish してパッケージを作る**（`npm login` → `npm publish --otp=<6桁>`）
2. できたパッケージページで **Trusted Publisher を登録する**
3. 以降の版は CI（OIDC）から provenance 付きで出る

**初回版だけは provenance が付かない。** これは避けられない。既存3パッケージも同じで、`@insession/ws-resilient-transport` は `0.1.0` だけ provenance が無く、`0.2.0` 以降に付いている。

> ⚠ **順序を間違えると Version PR をマージした瞬間に release が落ちる。** 症状は `E404 Not Found - PUT`。npm は書き込み権限の不足を 403 ではなく 404 で返すので「パッケージが無い」ように見えるが、**未ログイン・権限不足・Trusted Publisher 未登録のどれでも同じ 404 になる**ため区別が付かない。手元で切り分けるなら `npm whoami --registry https://registry.npmjs.org/` を打つ（401 なら単に未ログイン）。
>
> 落ちても壊れるものは無い。採番のコミットが `main` に載るだけなので、原因を潰してから手動 publish するか、失敗した run を再実行すればよい。

### ローカルから publish しない（既存パッケージの話）

npm はアカウントの 2FA か bypass 2FA 付きトークンを要求するうえ、手元から出すと **provenance の無い版がレジストリに残る**。publish は CI（OIDC）経由が基本。**上記のとおり新規パッケージの初回だけが例外**で、それ以外で手元から出す理由は無い。

> **⚠ 手元から publish するときは `publishConfig.registry` が効いていることが前提。** 開発機の `~/.npmrc` は `registry` を社内プロキシ（`https://npm.flatt.tech/`）に向けていることがあり、`publishConfig.registry` が無いと publish がプロキシ宛になって**公開レジストリに出ない**。
>
> 同じ理由で、**publish 直後の確認に `npm view` を使うと嘘をつく** — 読み取りもプロキシへ行くため、出たばかりのパッケージが 404 に見える。公開レジストリを直接見ること:
>
> ```bash
> curl -s https://registry.npmjs.org/@insession%2F<名前> | jq '.["dist-tags"]'
> ```

## ⚠ このリポジトリに入れるもの / 入れないもの

**入れるのは「契約とランタイム」だけ。** プロダクトの意見を持たない、InSession が無くても意味が通るものに限る。

| 入れる | 入れない |
| --- | --- |
| 汎用のランタイム（`ws-resilient-transport`。InSession 固有の情報を1つも含まない） | **plugin**（`plugin-pomodoro` 等）。UI・i18n キー・プロダクト判断を抱えるので `insession-app` 側に置く |
| 依存ゼロの状態機械（`space-state`）とその薄いバインディング（`space-state-react`） | **UI を持つもの全般**。`@insession/design-system` への依存をこのリポジトリに持ち込まない |
| **ただし plugin の server 面**（UI・i18n・design-system への依存を持たず、外部 import がゼロの純粋な状態機械）は入れてよい（`plugin-pomodoro-state` / `plugin-whiteboard-state`） | plugin の **client 面**（UI コンポーネント。`pomodoro-kit` 等） |

**「`@insession/*` スコープだから」という理由だけでここへ移さないこと。** スコープは「OSS 候補である」という表明でしかなく、置き場所の判断とは別。plugin をここへ入れると次の3つが同時に起きる:

1. **SDK が design-system に依存する** — UI プリミティブを直すたびに design-system → insession-sdk → insession-app の**3リポジトリ往復**になる
2. **共有物の消費者が向こう側に残る** — plugin の道具は space の plugin と本体側の両方が使い、どちらも `insession-app` 内に居る。切り出すとパネルを 1px 直すたびに publish サイクルが要る
3. **リリース周期が混ざる** — 契約層は安定していてほしいが、plugin はプロダクトと一緒に動く。同居させると採番が互いに引きずられる

外部に「space を作れる SDK」を出すのに plugin は必須ではない。`definePluginClient` の**契約さえ配れば、消費者は自分の plugin を書ける**。plugin 自体を配りたくなったら、このリポジトリに足すのではなく別リポジトリを立てて判断する。

### 例外: plugin の server 面（純粋な状態機械）は入れてよい

`plugin-pomodoro-state` は `insession-app` の `plugin-pomodoro` から **server 面だけ**（`reduce` / `timerDelay` / `onTimer` / `restore` / `persistState`）を切り出したもので、上の禁止理由3点のどれにも当たらない — 依存ゼロなので (1) が起きず、消費者はアプリのサーバー1箇所だけで UI を持たないため (2) のパネル修正ごとの publish サイクルが発生せず、仕様が安定した純粋関数なので (3) の採番の引きずり合いも起きない。

**判断基準はこの1点に尽きる: 外部 import がゼロかどうか。** UI・i18n キー・`@insession/design-system` への依存が1つでもあれば `insession-app` に残す。**「server 面だから」で自動的に入れてよくなるわけではない** — 切り出した結果 import が1つでも残るなら、それは契約層ではなくプロダクトの一部なので向こうに置く。

**`plugin-whiteboard-state` は「注入で解ければ移せる」という追加の型を示した。** 移植元の純粋部には唯一の外部依存（投稿画像URLが自前ストレージのものかを判定する `storage.isOwnUrl`）があり、これは InSession 固有のバケット設定を知っている。判断基準（外部 import がゼロか）自体は変わらないが、「元から import がゼロ」だけでなく「述語をホストから注入する形にして import をゼロにする」パターンでもここへ移せる。`plugin-whiteboard-state` はそれをファクトリ `createWhiteboardState({ isOwnImageUrl })` として実装した — SDK 側は「host が判定してくれる」という契約だけを持ち、InSession のストレージ設定そのものは持ち込まない。

**`plugin-watch-party-state` はさらにもう一つの型を示した: 本物の副作用（broadcast・DB永続化・タイトル/尺の解決）を持つ plugin も、コールバック注入ではなく `@insession/space-state` と同じ「effect 記述子を返すだけ」の形にすれば、外部 import ゼロのまま移せる。** `plugin-pomodoro-state` / `plugin-whiteboard-state` の `reduce` は純粋な状態遷移だけを返せば足りたが、Watch Party の移植元は DB 書き込み・WS broadcast・YouTube oEmbed 取得を伴う。これらを `reduce` の内部で呼ぶ代わりに `{ state, effects: WatchPartyEffect[] }` を返し、実行はホストに委ねる（`resolve-metadata` effect でタイトル/尺の取得さえもホストへ投げ返す）。この設計のおかげで、I/O を持つ plugin であっても SDK 側は依然として「Date.now() 以外に副作用ゼロの純関数」のままでいられる。もう一つの外部依存だったランダム再生の選択ロジックは、`packages/protocol` がマイルームとも共有する単一ソースだったため、`plugin-whiteboard-state` の `isOwnImageUrl` と同じ注入パターン（`createWatchParty({ pickShuffleIndex })`）で解いた。

**`chat-state` は3つ目の型を示した: 外部依存が「非同期な判断」のときは、注入ではなくホストが先に解決して payload に畳み込む。** チャットのスタンプ画像URLの allowlist 照合は、自前ストレージの URL か・管理者が用意したプリセットか・そのスペースで有効か、という**4つの照合のうち2つが DB 参照**で、`plugin-whiteboard-state` の `isOwnImageUrl` のような同期述語には畳めない。async な述語を注入する形にすると `reduce` 自体が async になり、このリポジトリの全パッケージが共有している「`reduce` は純関数」という性質が壊れる。そこで `stickerAllowed: boolean` という **host-trusted な payload フィールド**として受ける形にした（`plugin-watch-party-state` が `shuffleEnabled` 等の設定を payload で受けるのと同じ扱い）。**注入・effect 記述子・payload 畳み込みの3つは、どれも「外部 import をゼロにする」ための手段であって優劣は無い。判断基準は変わらず『外部 import がゼロか』の1点。**

**⚠ `chat-state` は plugin ではなく core 由来。** 上の表の「入れない」列にある **plugin** は名前でも由来でもなく、UI・i18n キー・プロダクト判断を抱えた実体を指す。チャットは InSession では plugin ではなく space の core 機能だが、server 面を切り出した結果 UI も i18n も持たず外部 import がゼロになったので、`plugin-*-state` と同じ資格でここに置ける。**「plugin の server 面だから入れてよい」ではなく「外部 import がゼロだから入れてよい」と読むこと。**

**⚠ 名前の `plugin-` 接頭辞は「どの plugin 由来か」を示すだけで、置き場所の判断とは関係しない。** 上の表の「入れない」列にある **plugin** は `plugin-` で始まる名前のことではなく、UI・i18n キー・プロダクト判断を抱えた実体のことを指す。`plugin-pomodoro-state` が入れてよいのは名前がどうであれ外部 import がゼロだからで、逆に `plugin-` が付かない名前でも design-system を1つ引いていれば入れられない。**名前ではなく中身で判断すること。**

## README は「外部公開の配布物」

各パッケージの `README.md` は `files` に含まれ、**npm のパッケージページにそのまま表示される**。したがって:

- **英語で書く。** 3パッケージで見出し構成（冒頭のフック → Install → Usage → API 表 → Test → License）とトーンを揃える
- **リポジトリ外を参照する記述を書かない** — 社内 Issue 番号、private リポジトリのパッケージ名やシンボル（`@in-session/*` 等）、消費側リポジトリにしか無いスクリプト。外部読者には解決できず、そのまま「読めないドキュメント」として公開される
- **コード例は実装と一致させる。** 書いたら実際に動かして確かめる（過去に `effect.kind` で分岐する例が載っていたが、実際の判別子は `effect.type` だった）

ルート `README.md` は npm には出ない（配布物ではない）ので、この制約の対象外。

## 技術スタック / 規約

- **pnpm 10.12.1**（npm / yarn は使わない）・**Node >= 22.18**・**TypeScript**
- **Biome**（lint + format。ESLint / Prettier は使わない）。`pnpm check` / `pnpm format`
- **Changesets** で採番
- ビルドは **tsup**。`dist`（`.js` + `.d.ts`）を配布する。**`.ts` ソースをそのまま配らないこと** — Node は `node_modules` 配下の `.ts` を型ストリップしないため、サーバー側の消費者が読めない
- 各パッケージ内の相対 import は**拡張子 `.ts` を明示**する（`./actions.ts` 等）
- 兄弟リポジトリ `design-system`（`insession-space/design-system`）と同じ設計・作法を踏襲している。設定に迷ったらそちらを参照する

## リポジトリを跨いだ操作をしない

このリポジトリは、作業ルートに並ぶ複数の独立した Git リポジトリのうちの1つ。

- `git` / `pnpm` の**すべてのコマンドはこのディレクトリ内で実行**する。親ディレクトリは Git リポジトリではなく、`package.json` も lockfile も無い
- **1つの変更を複数リポジトリに同時コミットすることはできない。** 跨ぐ変更は「SDK を直す → publish → 消費側で版を上げる」のようにリポジトリごとに別 PR に分ける
- Issue / PR も各リポジトリに独立して立つ（`gh` は `-R insession-space/insession-sdk` かこのディレクトリ内で使う）

## ブランチとマージ

- **既定ブランチは `main`。** `develop` は存在しない。起点は直書きせず解決する: `git symbolic-ref --short refs/remotes/origin/HEAD | sed 's|^origin/||'`
- マージ方式は squash / merge commit / rebase のいずれも有効。迷ったら設定を引く: `gh api repos/insession-space/insession-sdk --jq '{squash:.allow_squash_merge, merge:.allow_merge_commit, rebase:.allow_rebase_merge}'`
- **`main` を直接編集しない。** `main` への push が採番 → publish を引き起こす。作業はブランチ（worktree）で行う
- ブランチは worktree でチェックアウトされていることが多い。**ローカルブランチを消す前に `git worktree remove` する**（順序が逆だと消せない）
- CI は **draft PR ではスキップされる**（実行分課金の節約）。検証を CI に回したいなら ready for review にすること。手元の `pnpm verify` + `pnpm build` は draft でも当然回せる

## シークレット

**このリポジトリはローカルに秘密を持たない。** `.env` は無く、`pnpm install` と `pnpm verify` は認証情報を一切要求しない。publish の認証は CI の OIDC だけで完結していて、**長期のトークンや鍵はリポジトリにも GitHub Secrets にも存在しない**（`GITHUB_TOKEN` は Actions が自動発行するもの）。

> ⚠ **万一値を扱う場面があっても、ログ・ファイル・コミットメッセージ・PR 本文・チャットに出さないこと。** マスクや部分表示も含めて出さない。一度出た値はローテーションするしかなくなる。**サブエージェントに委譲するときはこの制約をプロンプトに明記する**（委譲先はこのファイルを読まないことがある）。
