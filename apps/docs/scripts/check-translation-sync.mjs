// 日本語パッケージページが、生成元の英語 README から取り残されていないかを検査する。
//
// ⚠ **この非対称がこの構成の唯一の弱点。**
// 英語の /packages/* は packages/*/README.md から**生成**しているが、日本語の /ja/packages/* は
// apps/docs 内の**手書き**（npm 配布物である README を日本語で二重に持たない方針のため）。
// したがって README を直すと英語ページだけが更新され、**日本語ページは黙って古くなる**。
// ビルドは通り続けるので、検査しない限り誰も気づけない。
//
// そこで英語 README の内容ハッシュを translations.lock.json に控えておき、現在の README と
// 突き合わせる。ずれていたら警告する。
//
// ⚠ **警告であって失敗にはしない。** ここでビルドを落とすと、英語の修正が日本語の翻訳待ちで
// ブロックされる。英語が正・日本語は追随、という関係を壊さないため。
//
//   翻訳を追随させたら:  pnpm --filter @insession/docs run sync:accept
//   （lock を現在の README のハッシュへ更新する）

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGES_DIR = join(DOCS_ROOT, '..', '..', 'packages');
const LOCK_PATH = join(DOCS_ROOT, 'translations.lock.json');

const WRITE = process.argv.includes('--write');

function hash(text) {
  // 改行コードだけ揃える。末尾の空行差でハッシュが動くと、意味の無い警告が出るため。
  return createHash('sha256')
    .update(text.replace(/\r\n/g, '\n').trimEnd())
    .digest('hex')
    .slice(0, 16);
}

// ⚠ ディレクトリの存在だけでパッケージとみなさないこと。改名・削除のあと、共有チェックアウトには
// 未追跡の dist / node_modules だけを残した空ディレクトリが居座る（git はコミット済みのファイル
// しか動かさない）。sync-package-docs.mjs の同名の関数と同じ理由 — 詳細はそちらのコメント参照。
async function isPackage(name) {
  try {
    await readFile(join(PACKAGES_DIR, name, 'package.json'), 'utf8');
    return true;
  } catch {
    return false;
  }
}

const entries = await readdir(PACKAGES_DIR, { withFileTypes: true });
const dirs = entries
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
const flags = await Promise.all(dirs.map(isPackage));
const packages = dirs.filter((_, i) => flags[i]);

const current = {};
for (const name of packages) {
  current[name] = hash(await readFile(join(PACKAGES_DIR, name, 'README.md'), 'utf8'));
}

let lock;
try {
  lock = JSON.parse(await readFile(LOCK_PATH, 'utf8'));
} catch {
  lock = { packages: {} };
}
const recorded = lock.packages ?? {};

if (WRITE) {
  const next = {
    '//': 'apps/docs/scripts/check-translation-sync.mjs が管理する。手で編集しない。日本語訳を英語 README に追随させたら `pnpm --filter @insession/docs run sync:accept` で更新する。',
    packages: current,
  };
  await writeFile(LOCK_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  console.log(`check-translation-sync: lock updated (${packages.length} package(s))`);
} else {
  const stale = packages.filter((name) => recorded[name] !== current[name]);
  if (stale.length > 0) {
    const lines = stale.map((name) => {
      const known = recorded[name] ? `${recorded[name]} → ${current[name]}` : '(未記録)';
      return `  - ${name}  ${known}`;
    });
    console.warn(
      [
        '',
        '⚠ 日本語ページが英語 README から取り残されている可能性があります:',
        ...lines,
        '',
        '  英語の /packages/* は README から自動生成されますが、日本語の /ja/packages/* は手書きです。',
        '  apps/docs/src/content/docs/ja/packages/<name>.md を追随させたあと、次を実行してください:',
        '    pnpm --filter @insession/docs run sync:accept',
        '',
      ].join('\n'),
    );
  } else {
    console.log(`check-translation-sync: ${packages.length} package(s) in sync`);
  }
}
