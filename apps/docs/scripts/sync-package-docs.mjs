// packages/*/README.md から、このサイトのパッケージページを生成する。
//
// ⚠ **パッケージのドキュメントは README が単一ソース。** README は npm のパッケージページに
// そのまま出る配布物（package.json の files に入っている）で、必ず維持される。同じ内容を
// サイト側にも手で書くと、片方だけ直されて静かに食い違う — しかも「どちらが正か」が
// 誰にも分からなくなる。なので**サイト側は書かず、ビルドのたびに README から作り直す**。
//
// 生成物（src/content/docs/packages/*.md）は .gitignore してある。編集しても次の
// ビルドで消えるので、直すときは packages/<name>/README.md を直すこと。
//
// 各ページの editUrl は生成物ではなく**元の README** を指すようにしてある
// （サイトの "Edit page" から辿った先が消える生成ファイルだと直しようがないため）。

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGES_DIR = join(DOCS_ROOT, '..', '..', 'packages');
const OUT_DIR = join(DOCS_ROOT, 'src', 'content', 'docs', 'packages');
const EDIT_BASE = 'https://github.com/insession-space/insession-sdk/edit/main/packages';

/** YAML のスカラーとして安全に埋め込む（引用符とバックスラッシュだけ面倒を見れば足りる）。 */
function yamlQuote(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * README を frontmatter + 本文へ割る。
 * - 先頭の `# ...` をページタイトルにし、本文からは落とす（Starlight が title から h1 を出すため、
 *   残すと h1 が2つ並ぶ）。
 * - その次の段落を description（= <meta> と検索結果の説明文）にする。Markdown の装飾は
 *   平文に均す。
 */
function parseReadme(markdown) {
  const lines = markdown.split('\n');
  const titleIndex = lines.findIndex((line) => line.startsWith('# '));
  if (titleIndex === -1) throw new Error('README に h1 が無い');

  const title = lines[titleIndex].slice(2).trim();
  const body = lines
    .slice(titleIndex + 1)
    .join('\n')
    .replace(/^\n+/, '');

  const firstParagraph = body.split('\n\n')[0] ?? '';
  const description = firstParagraph
    .replace(/\n/g, ' ')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  return { title, description, body };
}

const entries = await readdir(PACKAGES_DIR, { withFileTypes: true });
const packages = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
if (packages.length === 0) throw new Error(`packages/ にパッケージが見つからない: ${PACKAGES_DIR}`);

// 消えたパッケージのページが残らないよう、毎回まっさらから作る。
await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

for (const name of packages) {
  const readmePath = join(PACKAGES_DIR, name, 'README.md');
  const { title, description, body } = parseReadme(await readFile(readmePath, 'utf8'));

  const frontmatter = [
    '---',
    `title: ${yamlQuote(title)}`,
    `description: ${yamlQuote(description)}`,
    `editUrl: ${yamlQuote(`${EDIT_BASE}/${name}/README.md`)}`,
    '---',
    '',
  ].join('\n');

  await writeFile(join(OUT_DIR, `${name}.md`), `${frontmatter}${body}`, 'utf8');
}

console.log(`sync-package-docs: generated ${packages.length} page(s) from packages/*/README.md`);
