/**
 * Builds the documentation as static HTML (docs/*.md -> docs-site/*.html) for
 * a relay that serves it at /docs/ (`--docs`, `QU_DOCS=1`; off by default).
 * Build time only (`marked` is a dev dependency): the relay serves plain files.
 *
 *   node web/build-docs.mjs          (also part of `node web/build.mjs`)
 *
 * Links between the docs become links between the pages (`API.md#errors` ->
 * `API.html#errors`), heading ids follow GitHub's rules so the same anchors
 * work on GitHub and here, links outside docs/ point to the repository.
 */
import { Marked } from 'marked';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const REPO = 'https://github.com/ReactivityJS/Qu-lite/blob/main/';

/** Navigation order and titles; files not listed follow alphabetically. */
const NAV = [
  ['README.md', 'Übersicht'],
  ['BENUTZER.md', 'Für Nutzer'],
  ['GUIDE.md', 'Entwickler-Guide'],
  ['REZEPTE.md', 'Rezepte'],
  ['API.md', 'API-Referenz'],
  ['CONSOLE.md', 'Dev-Konsole'],
  ['INSTALL.md', 'Installation'],
  ['DEPLOY.md', 'Betrieb'],
  ['SECURITY-REVIEW.md', 'Sicherheit'],
  ['DECISIONS.md', 'Entscheidungen'],
  ['TESTING.md', 'Tests'],
  ['RELEASING.md', 'Releases'],
];
const pageOf = (md) => (md === 'README.md' ? 'index.html' : md.replace(/\.md$/, '.html'));
const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to dashes, duplicates numbered. */
function slugger() {
  const seen = new Map();
  return (text) => {
    const base = text
      .toLowerCase()
      .replace(/<[^>]+>/g, '')
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
}

/** A link target in docs/ -> its page; elsewhere in the repository -> GitHub. */
function rewrite(href) {
  if (/^([a-z]+:|#|\/)/i.test(href)) return href;
  const [path, hash] = href.split('#');
  const anchor = hash ? `#${hash}` : '';
  if (/^[\w.-]+\.md$/.test(path)) return pageOf(path) + anchor;
  if (path.startsWith('../')) return REPO + path.slice(3) + anchor;
  return href;
}

function render(md, file) {
  const slug = slugger();
  const renderer = {
    heading({ tokens, depth, text }) {
      const id = slug(text.replace(/`/g, ''));
      return `<h${depth} id="${escape(id)}"><a class="anchor" href="#${escape(id)}" aria-hidden="true">#</a>${this.parser.parseInline(tokens)}</h${depth}>\n`;
    },
    link({ href, title, tokens }) {
      const target = rewrite(href);
      const external = /^https?:/i.test(target) && !target.startsWith(REPO);
      return `<a href="${escape(target)}"${title ? ` title="${escape(title)}"` : ''}${external ? ' rel="noopener"' : ''}>${this.parser.parseInline(tokens)}</a>`;
    },
  };
  return new Marked({ gfm: true, renderer }).parse(md);
}

const CSS = `
:root { color-scheme: light dark; --bg: #fff; --fg: #1f2328; --muted: #59636e; --line: #d1d9e0; --code: #f6f8fa; --link: #0969da; --side: #f6f8fa; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --line: #3d444d; --code: #151b23; --link: #4493f8; --side: #010409; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
.layout { display: grid; grid-template-columns: 240px minmax(0, 1fr); min-height: 100vh; }
nav { background: var(--side); border-right: 1px solid var(--line); padding: 24px 16px; position: sticky; top: 0; height: 100vh; overflow: auto; }
nav .brand { font-weight: 700; margin-bottom: 16px; display: block; color: var(--fg); text-decoration: none; }
nav a { display: block; padding: 4px 8px; border-radius: 6px; color: var(--fg); text-decoration: none; font-size: 15px; }
nav a:hover { background: var(--line); }
nav a.active { background: var(--link); color: #fff; }
nav .foot { margin-top: 24px; font-size: 13px; color: var(--muted); }
nav .foot a { display: inline; padding: 0; color: var(--link); }
main { padding: 32px 48px 64px; max-width: 980px; }
a { color: var(--link); }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.6em 0 .6em; position: relative; }
h1 { margin-top: 0; font-size: 2em; border-bottom: 1px solid var(--line); padding-bottom: .3em; }
h2 { font-size: 1.5em; border-bottom: 1px solid var(--line); padding-bottom: .3em; }
.anchor { position: absolute; left: -1em; opacity: 0; text-decoration: none; color: var(--muted); }
h1:hover .anchor, h2:hover .anchor, h3:hover .anchor, h4:hover .anchor { opacity: 1; }
code { font: 85% ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--code); padding: .2em .4em; border-radius: 6px; }
pre { background: var(--code); padding: 16px; border-radius: 6px; overflow: auto; line-height: 1.45; }
pre code { background: none; padding: 0; font-size: 85%; }
table { border-collapse: collapse; display: block; overflow: auto; margin: 1em 0; }
th, td { border: 1px solid var(--line); padding: 6px 13px; vertical-align: top; }
th { background: var(--code); text-align: left; }
blockquote { margin: 0; padding: 0 1em; color: var(--muted); border-left: .25em solid var(--line); }
img { max-width: 100%; }
.menu { display: none; }
@media (max-width: 800px) {
  .layout { display: block; }
  nav { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); padding: 12px 16px; }
  nav .links { display: none; }
  nav.open .links { display: block; }
  .menu { display: inline-block; float: right; background: none; border: 1px solid var(--line); color: var(--fg); border-radius: 6px; padding: 2px 10px; font: inherit; }
  main { padding: 20px 16px 48px; }
  .anchor { display: none; }
}`;

function page({ title, body, current, nav }) {
  const links = nav.map(([md, label]) => `<a href="${pageOf(md)}"${md === current ? ' class="active" aria-current="page"' : ''}>${escape(label)}</a>`).join('\n');
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} – Qu Lite</title><link rel="stylesheet" href="docs.css"></head>
<body><div class="layout">
<nav id="nav"><a class="brand" href="index.html">Qu Lite</a><button class="menu" onclick="document.getElementById('nav').classList.toggle('open')" aria-label="Menü">☰</button>
<div class="links">${links}
<div class="foot"><a href="../qu.html">Startseite</a> · <a href="../">App</a> · <a href="${REPO.replace('/blob/main/', '')}" rel="noopener">GitHub</a></div></div></nav>
<main>${body}</main></div></body></html>
`;
}

/** @returns {Promise<number>} pages written */
export async function buildDocs({ from = join(root, 'docs'), to = join(root, 'docs-site') } = {}) {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  const files = readdirSync(from).filter((f) => f.endsWith('.md'));
  const known = new Set(NAV.map(([f]) => f));
  const nav = [...NAV.filter(([f]) => files.includes(f)), ...files.filter((f) => !known.has(f)).sort().map((f) => [f, f.replace(/\.md$/, '')])];
  for (const file of files) {
    const md = readFileSync(join(from, file), 'utf8');
    const title = md.match(/^#\s+(.+)$/m)?.[1]?.replace(/`/g, '') ?? file;
    writeFileSync(join(to, pageOf(file)), page({ title, body: render(md, file), current: file, nav }));
  }
  writeFileSync(join(to, 'docs.css'), CSS.trim() + '\n');
  return files.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`docs: ${await buildDocs()} pages in docs-site/`);
}
