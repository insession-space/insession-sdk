---
name: publish-package
description: insession-sdk の npm publish を扱う。新規パッケージの初回手動 publish（Trusted Publisher 登録より前にしかできない）、dist を空で publish する事故の防止、release.yml の触ると壊れる3点、E404 の切り分け、公開レジストリでの確認手順。
---

# publish-package — publish を壊さずに出す

このリポジトリの publish は **CI（`release.yml`）が npm の Trusted Publishing（OIDC）で行う**のが基本。手元から出すのは**新規パッケージの初回だけ**。

いずれの落とし穴も「壊れても手元では何も起きず、publish の瞬間か install の瞬間に初めて分かる」種類のもの。

---

## 通常のリリース（既存パッケージ）

手作業は無い。changeset を積んで `main` にマージするだけ。

1. `main` へ push されると `release.yml` が積まれた changeset から **Version PR（`chore: version packages`）** を作る
2. その Version PR をマージすると（＝再び `main` へ push）、同じ job が **npm publish** する

**ローカルから publish しない。** 手元から出すと provenance の無い版がレジストリに永久に残る。

## ⚠ publish 前に必ず `pnpm build` → `ls dist` を目視する

**`dist` は `.gitignore` されている。** ビルドせずに publish すると、`files` に列挙した `dist` が入らないまま出る。**npm は成功として扱うので、その場では何も分からない。** install して初めて `ERR_MODULE_NOT_FOUND` で気づく。

`@insession/extension-*` の初版4つ（`extension-pomodoro@0.2.0` / `extension-whiteboard@0.2.0` / `extension-watch-party@0.4.0` / `extension-chat@0.2.0`）を実際にこの形で出した。中身は `README.md` / `LICENSE` / `CHANGELOG.md` / `package.json` の4ファイルだけで import できない。

**npm は同じ版を上書きできない。** 踏んだら patch を上げて出し直し、壊れた版を deprecate するしかない。

- 全パッケージの `package.json` に `"prepublishOnly": "npm run build"` を入れてある。**消さないこと**
- **`npm publish --dry-run` は `prepublishOnly` を走らせないので、この事故を検出できない**（`total files: 4` のまま通る）。手で確認するなら `ls packages/<name>/dist` を見る

```bash
pnpm build
ls packages/<name>/dist   # index.js / index.d.ts (CJS なら index.cjs / index.d.cts) があること
```

## ⚠ 新規パッケージの初回だけは手動 publish が要る（順序を逆にできない）

**Trusted Publisher は「既に存在するパッケージ」にしか登録できない。** 登録画面が `https://www.npmjs.com/package/@insession/<名前>/access` というパッケージページ配下にあるため、まだ npm に無いパッケージには登録しようがない。

したがって新規パッケージはこの順序になる:

1. **手元から初回版を publish してパッケージを作る**
   ```bash
   pnpm build
   ls packages/<name>/dist        # ← 空でないことを目視
   cd packages/<name>
   npm login                      # 未ログインなら
   npm publish --otp=<6桁>
   ```
2. できたパッケージページで **Trusted Publisher を登録する**
   - GitHub Actions / owner `insession-space` / repository `insession-sdk` / workflow `release.yml`
3. 以降の版は CI（OIDC）から provenance 付きで出る

**初回版だけは provenance が付かない。これは避けられない。** 既存パッケージも同じで、`@insession/ws-resilient-transport` は `0.1.0` だけ provenance が無く `0.2.0` 以降に付いている。

> **旧名からの改名も「新規パッケージ」扱い。** 改名は rename ではなく「新名で publish し直して旧名を deprecate」なので、新名の初回だけ手動 publish が要る（`plugin-*-state` → `extension-*` で実際に踏んだ）。

## ⚠ 触ると publish が壊れる3点（`release.yml` / `package.json`）

1. **`release.yml` の env に `NPM_TOKEN` を足さない。**
   `changesets/action` は「env に `NPM_TOKEN` があればトークン publish、無ければ OIDC」の順で選ぶ。渡すと OIDC が使われなくなる。`release.yml` は `permissions: id-token: write` を持っている。OIDC を捨ててトークン運用に戻す判断をしたときだけ足す
2. **`release.yml` の `npm install -g npm@11` を消さない。**
   OIDC publish は npm CLI **11.5.1 以降**にしか実装が無い。Node 22 同梱は npm 10.9.8、Node 24 同梱でも 11.3.0 で届かない。これが無いと npm は OIDC 交換を行わず `E404 Not Found - PUT ...` で失敗する
3. **`package.json` の `publishConfig.registry` を外さない。**
   開発機の `~/.npmrc` が社内プロキシを `registry` に設定していると、これが無い場合 publish がプロキシ宛になり**公開レジストリに出ない**

**`release.yml` のビルドは `pnpm --filter "./packages/*" run build` であってルートの `pnpm build` ではない。** ルートに戻すと `apps/docs` のビルドが publish 経路に入り、**サイト側の失敗で npm publish が止まる**（docs は Cloudflare Pages が別途ビルドするので、ここで作る意味も無い）。

## ⚠ リポジトリ外の設定が2つ要る

兄弟リポジトリ `design-system` で publish が2回連続で失敗して判明した経緯がある。

1. **npm 側**: パッケージごとに Trusted Publisher を登録（上記）
2. **GitHub org 側**: 「Allow GitHub Actions to create and approve pull requests」を ON。未許可だと **Version PR が作られず採番が進まない**（採番と push までは成功するので気づきにくい）

## E404 の切り分け

**npm は書き込み権限の不足を 403 ではなく 404 で返す。** そのため「パッケージが無い」ように見えるが、**未ログイン・権限不足・Trusted Publisher 未登録のどれでも同じ 404** になり区別が付かない。

```bash
npm whoami --registry https://registry.npmjs.org/   # 401 なら単に未ログイン
```

落ちても壊れるものは無い。採番のコミットが `main` に載るだけなので、原因を潰してから手動 publish するか、失敗した run を再実行すればよい。

## publish 後の確認に `npm view` を使わない

読み取りも社内プロキシへ行くため、**出たばかりのパッケージが 404 に見える**。公開レジストリを直接見る:

```bash
curl -s https://registry.npmjs.org/@insession%2F<名前> | jq '.["dist-tags"]'
```

## シークレットの扱い

**npm トークン・OTP・その他の値を、チャット・ログ・ファイル・コミットメッセージ・PR 本文に出さない**（マスクや部分表示も含めて）。一度出た値はローテーションするしかなくなる。存在確認は値ではなく**有無**で報告する。

このリポジトリは長期のトークンや鍵をリポジトリにも GitHub Secrets にも持たない（`GITHUB_TOKEN` は Actions が自動発行するもの）。**この状態を崩さないこと。**

## 停止条件

- [ ] `pnpm build` 後に `ls packages/<name>/dist` が空でないことを目視した
- [ ] （新規パッケージ）初回 publish → Trusted Publisher 登録 の順で行った
- [ ] `curl` で公開レジストリの `dist-tags` を確認した（`npm view` ではなく）
- [ ] シークレットの値をどこにも出していない
