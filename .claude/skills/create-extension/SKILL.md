---
name: create-extension
description: insession-sdk に新しい @insession/extension-* パッケージ（space に載る依存ゼロの状態機械）を追加する。移植元が SDK に入れてよいかの判断、外部依存の解き方、契約への適合、conformance テストへの登録、docs と初回 publish への引き継ぎまでを通す。
---

# create-extension — `@insession/extension-*` を1本足す

`@insession/space` の `createSpace({ extensions: [...] })` に載る**依存ゼロの状態機械**パッケージを作る。既存の実例は `extension-pomodoro` / `extension-whiteboard` / `extension-watch-party` / `extension-chat` の4本。

雛形・`package.json`・tsup/tsconfig・README 規約・changeset・検証は **`_shared/package-scaffold.md`** が持つ。このスキルは **extension 固有の判断と契約適合**だけを扱う。

---

## Phase 0: そもそもここに入れてよいかを判断する（最初に通す）

**判断基準は1点だけ: 外部 import がゼロにできるか。**

UI・i18n キー・`@insession/design-system` への依存が1つでも残るなら、それは契約層ではなく**プロダクトの一部**なので `insession-app` 側に置く。「plugin の server 面だから入れてよい」ではない（`extension-chat` は plugin ですらなく space の core 機能だが、import がゼロなので入れられた）。名前に `extension-` が付くかどうかも関係しない。**名前でも由来でもなく中身で判断する。**

判断できない場合はユーザーに確認する（`AskUserQuestion`）。

### 外部依存の解き方3パターン

移植元に外部依存があっても、次のどれかに畳めるならゼロにできる。**3つに優劣は無い。依存の性質で選ぶ。**

| 依存の性質 | 解き方 | 実例 |
| --- | --- | --- |
| **同期的な述語**（ホストしか知らない判定） | ファクトリ引数で注入する | `createWhiteboardState({ isOwnImageUrl })` — 投稿画像が自前ストレージのものかの判定。SDK は「host が判定してくれる」契約だけ持つ |
| **本物の副作用**（broadcast / DB 書き込み / 外部取得） | `reduce` から **effect 記述子**を返し、実行をホストに委ねる | `extension-watch-party` — DB 永続化・WS broadcast・YouTube oEmbed 取得すら `resolve-metadata` effect としてホストへ投げ返す |
| **非同期な判断**（DB 参照が要る照合） | ホストが**先に解決**して payload に畳み込む（host-trusted フィールド） | `extension-chat` の `stickerAllowed: boolean` — スタンプ URL の allowlist 照合は4つのうち2つが DB 参照で、同期述語に畳めない |

**⚠ 非同期な述語を注入する形にしない。** `reduce` 自体が async になり、このリポジトリの全パッケージが共有している「`reduce` は純関数」という性質が壊れる。

## Phase 1: 契約に嵌る形で書く

`@insession/space` の `ExtensionServerFacet`（`packages/space/extension/contract.ts`）を**構造的に**満たす。

```ts
defaultState: () => TState                                  // 必須
reduce: (state, action: string, payload?) => Result | null  // 必須
timerDelay?: (state) => number | null                       // タイマーが要るときだけ
onTimer?: (state) => Result | null                          // 同上
restore?: (raw: unknown) => TState | null                   // 永続化するときだけ
persistState?: (state) => TState                            // 同上
```

- **`@insession/space` を import しない。** 依存ゼロが壊れるうえ、逆向き（`space` が状態機械を import する）も禁止 — 契約側が「どの状態機械を使うか」を決めてしまう。構造的に嵌れば型は通る
- **`action` は `string`。** union にしない。ワイヤ境界の向こうから来る**信頼できない入力**なので、未知の名前は型システムに valid と判定させず `null` に落とす

### `reduce` の戻り値は必ず `{ state, effects }`

契約の型（`ExtensionReduceResult`）は素の `TState` も受けるが、**このリポジトリでは使わない**。4つの状態機械はすべて `{ state, effects }` に揃えてある（`0.3.0` で揃えた）。

- **副作用が無くても `effects: []` を返す。** 素の state を返す形にすると、後から副作用が1つ生えた瞬間に消費側へ「前後の state を差分して推測する」ロジックが生まれる。実際に `extension-pomodoro`（一行宣言）と `extension-whiteboard`（完成アルバム）で起きた
- **`null`** = そのアクションは invalid か no-op。state 変更なし・effect なし・broadcast なし
- **`{ effects }`（state 無し）** = state を変えずに effect だけ起こす。ライブ relay 用（描画プレビューは pointer move ごとに1フレーム転送するが、どれも保存する価値は無い）。**`null` とは別物** — `null` は「何も起きない」、これは「state 以外に何かが起きる」

## Phase 2: ready extension を同梱する

消費者が何も書かずに `createSpace` へ渡せるよう、パッケージ自身が `SpaceExtension` 形の**ファクトリ関数**を export する（`pomodoroExtension()` / `whiteboardExtension({...})` / `watchPartyExtension()` / `chatExtension()`）。

```ts
export function fooExtension(options: FooExtensionOptions = {}) {
  return {
    name: options?.name ?? 'foo',
    server: createFooState(options),
  };
}
```

`name` は**スペース状態の中でそのスライスが占めるキー**であり、更新が broadcast される識別子でもある。既定値を持たせ、`options.name` で上書きできるようにする。

**戻り値の型に `SpaceExtension` を注釈しない**（import が要るため）。構造的に一致していれば足りる。

## Phase 3: conformance テストに登録する

`packages/space/conformance.test.ts` が「このリポジトリから publish される extension は、そのままで `ExtensionServerFacet` を満たす」ことを**実行して**検査している。**新しい extension をここに足す**（足さないと契約からのドリフトが検出されない）。

```ts
import { fooExtension } from '../extension-foo/index.ts';
const Foo = fooExtension();
const ALL = [Pomodoro, Whiteboard, WatchParty, Chat, Foo] as SpaceExtension[];
```

> ⚠ **import は隣のソースへの相対パス。パッケージ名にしない。** `dependencies` に入れると契約側が実装に依存してしまい、`devDependencies` に入れると `exports` 経由で `dist` に解決されるため **`pnpm build` の後にしか走らず、古いビルドを静かに検査する**（`pnpm verify` はビルドしない）。ソースを読むからこそ、ドリフトが次の `pnpm verify` で落ちる。

`space` に changeset が要るかは、conformance テストしか変えていないなら不要（テストは配布物ではない）。判断に迷ったら `patch` を積んでおく。

## Phase 4: 雛形どおりに仕上げる

**`_shared/package-scaffold.md` に従う**（`package.json` / tsconfig / tsup / README / テスト / `pnpm verify` + `pnpm build` / changeset）。

extension は消費者である `insession-app` のサーバーが `require()` で読むため、**ESM + CJS の両方を出す**（`format: ['esm', 'cjs']`）。`tsconfig.json` の `lib` は `["ES2023"]` のみ — 純粋な状態機械が `window` を触れないようにする。

README には `## Drop it into a space` の節を Install の直後に置き、`createSpace({ extensions: [fooExtension()] })` の例を載せる（既存4本と同じ構成）。

## Phase 5: 引き継ぎ

- **docs（`apps/docs`）の追従** → `sync-docs` スキル。英語のパッケージページは README から自動生成されるが、**日本語ページ・デモ・サイドバーは手で足す**
- **初回 publish** → `publish-package` スキル。**新規パッケージは CI からは出せない**（Trusted Publisher が既存パッケージにしか登録できないため）

## 停止条件

- [ ] 外部 import がゼロ（`dependencies` が空、`devDependencies` は tsup / typescript のみ）
- [ ] `reduce` / `onTimer` が `{ state, effects }`（または `null` / `{ effects }`）を返す純関数
- [ ] ready extension のファクトリを export している
- [ ] `packages/space/conformance.test.ts` に登録され、通っている
- [ ] `pnpm verify` と `pnpm build` が**終了コード 0**
- [ ] README が英語で h1 を持ち、コード例が実際に動く
- [ ] changeset を積んだ
