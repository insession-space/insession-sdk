---
name: add-package
description: insession-sdk の packages/ に extension 以外の新しい npm パッケージを足す。ここに置いてよいかの判断（契約とランタイムだけ／plugin・UI・薄いバインディングは入れない）を先に通し、雛形・検証・changeset・docs・初回 publish へ引き継ぐ。extension を作るなら create-extension を使う。
---

# add-package — `packages/` にパッケージを1本足す

`@insession/space` に載る状態機械を作るなら、このスキルではなく **`create-extension`** を使う（契約適合と conformance テストの手順がある）。

雛形・`package.json`・tsup/tsconfig・README 規約・changeset・検証は **`_shared/package-scaffold.md`** が持つ。このスキルは**置き場所の判断**だけを扱う。

---

## Phase 0: そもそもここに置いてよいかを判断する（最初に通す）

**このリポジトリに入れるのは「契約とランタイム」だけ。** プロダクトの意見を持たない、InSession が無くても意味が通るものに限る。

| 入れる | 入れない |
| --- | --- |
| 汎用のランタイム（`ws-resilient-transport`。InSession 固有の情報を1つも含まない） | **plugin**。UI・i18n キー・プロダクト判断を抱えるので `insession-app` 側に置く |
| 依存ゼロの状態機械（`space-state`） | **UI を持つもの全般**。`@insession/design-system` への依存を `packages/` 配下に持ち込まない |
| 契約（`space`） | **フレームワーク固有の薄いバインディング**（下記） |

### ⚠ 「`@insession/*` スコープだから」はここへ置く理由にならない

スコープは「OSS 候補である」という表明でしかなく、置き場所の判断とは別。plugin をここへ入れると次の3つが同時に起きる:

1. **SDK が design-system に依存する** — UI プリミティブを直すたびに design-system → insession-sdk → insession-app の**3リポジトリ往復**になる
2. **共有物の消費者が向こう側に残る** — plugin の道具は space の plugin と本体側の両方が使い、どちらも `insession-app` 内に居る。切り出すとパネルを 1px 直すたびに publish サイクルが要る
3. **リリース周期が混ざる** — 契約層は安定していてほしいが、plugin はプロダクトと一緒に動く

### ⚠ 単体で install されないものはパッケージにしない

`@insession/space-state-react` は本体が `useSyncExternalStore(store.subscribe, store.getState)` の1行しかなく、**自前の変更が入った版が一度も無いまま** `workspace:*` 依存で `space-state` の採番に引きずられ続けたので廃止した（#42、npm 上は deprecated）。消費者が自分のコードに1行書けば足りるものを、別採番のパッケージにしない。

同じ理由で **`space` を細かく割らない**。契約・registry・members・インスタンスは必ず一緒に変わるので、別採番にすると契約にフィールドを1つ足すたびに2パッケージ2版の組み合わせが増える。加えて契約だけを単体で install する人は居ない（それだけでは space が建たない）。`@tiptap/core` が `Editor` と `Extension` を同居させているのと同じ判断。

**新しいパッケージを立てる前に、既存パッケージに足せないかを先に考える。** 判断が割れるならユーザーに確認する（`AskUserQuestion`）。

### 外部依存があるとき

移植元に外部 import があるなら、`create-extension` の「外部依存の解き方3パターン」（同期述語は注入 / 副作用は effect 記述子 / 非同期な判断は payload 畳み込み）で**ゼロにできるか**を先に検討する。ゼロにできないなら `insession-app` に残す。

**「依存ゼロ」は全パッケージ共通の売り。** 便利だからという理由でランタイム依存を1つでも足すと、このパッケージを選ぶ理由が消える。

## Phase 1: 作る

**`_shared/package-scaffold.md` に従う。** ディレクトリ構成・`package.json`・tsconfig・tsup・README・テスト・`pnpm verify` + `pnpm build`・changeset まで全部そこにある。

判断が要るのは1点だけ: **ESM only か、CJS も出すか**。消費者が `insession-app` のサーバー（ビルドせず `.ts` を直接実行し `require()` で読む）を含むなら CJS も要る。

## Phase 2: 引き継ぎ

- **docs（`apps/docs`）の追従** → `sync-docs` スキル
- **初回 publish** → `publish-package` スキル。**新規パッケージは CI からは出せない**（Trusted Publisher が既存パッケージにしか登録できない）

## 停止条件

- [ ] Phase 0 の判断を通した（契約かランタイムであり、単体で install される意味がある）
- [ ] `dependencies` が空（`devDependencies` は tsup / typescript のみ）
- [ ] `pnpm verify` と `pnpm build` が**終了コード 0**
- [ ] README が英語で h1 を持つ
- [ ] changeset を積んだ
