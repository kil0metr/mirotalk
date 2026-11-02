#!/usr/bin/env node
// Third-party browser files served from our own node instead of CDNs.
//
// vendor/sources.txt lists every file as "<sha256>  <url>"; a file lives at
// public/vendor/<host><path>, so relative references inside vendored CSS keep
// working. Google Fonts CSS depends on the browser's User-Agent and cannot be
// pinned by a checksum: it is kept as a snapshot in vendor/static/ and copied
// as is.
//
//   node vendor/vendor.mjs fetch        download, verify, install (image build)
//   node vendor/vendor.mjs add <url>…   pin new files; CSS references follow
//   node vendor/vendor.mjs font <url> <name>  snapshot a Google Fonts stylesheet
//   node vendor/vendor.mjs check        fail if pages still load third-party files
//
// fetch only downloads and compares bytes: nothing it downloads is executed.

import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = join(ROOT, 'vendor/sources.txt');
const STATIC = join(ROOT, 'vendor/static');
const PUBLIC_VENDOR = join(ROOT, 'public/vendor');

// A current desktop Chrome: Google Fonts answers it with woff2 split by unicode-range.
const FONT_UA =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

// Hosts a page must not load files from. A link to them for the user to click is fine.
const THIRD_PARTY =
    /https?:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com|npmcdn\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|storage\.googleapis\.com|buttons\.github\.io|webrtc\.github\.io|translate\.google\.com|www\.gravatar\.com|api\.dicebear\.com|eu\.ui-avatars\.com|p2p\.mirotalk\.com\/js)/;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function localPath(url) {
    const u = new URL(url);
    return join(PUBLIC_VENDOR, u.host, decodeURIComponent(u.pathname));
}

async function download(url, headers = {}) {
    const res = await fetch(url, { headers, redirect: 'follow' });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}

async function readSources() {
    let text = '';
    try {
        text = await readFile(SOURCES, 'utf8');
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
    }
    const entries = new Map();
    for (const line of text.split('\n')) {
        if (!line.trim() || line.startsWith('#')) continue;
        const [hash, url] = line.trim().split(/\s+/);
        entries.set(url, hash);
    }
    return entries;
}

async function writeSources(entries) {
    const lines = [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([url, hash]) => `${hash}  ${url}`);
    await writeFile(SOURCES, lines.join('\n') + '\n');
}

// url(...) and @import references of a stylesheet, resolved against its URL.
function cssReferences(css, base) {
    const refs = new Set();
    for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)|@import\s+(['"])([^'"]+)\3/g)) {
        const ref = m[2] || m[4];
        if (ref.startsWith('data:') || ref.startsWith('#')) continue;
        const u = new URL(ref, base);
        u.search = '';
        u.hash = '';
        refs.add(u.href);
    }
    return refs;
}

async function cmdFetch() {
    const entries = await readSources();
    let failed = 0;
    for (const [url, hash] of entries) {
        const buf = await download(url);
        const got = sha256(buf);
        if (got !== hash) {
            console.error(`sha256 mismatch: ${url}\n  expected ${hash}\n  got      ${got}`);
            failed++;
            continue;
        }
        const path = localPath(url);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, buf);
    }
    if (failed) throw new Error(`${failed} file(s) failed verification`);
    await cp(STATIC, PUBLIC_VENDOR, { recursive: true, force: true });
    console.log(`vendored ${entries.size} files`);
}

async function cmdAdd(urls) {
    const entries = await readSources();
    const queue = [...urls];
    while (queue.length) {
        const url = queue.shift();
        if (entries.has(url)) continue;
        const buf = await download(url);
        entries.set(url, sha256(buf));
        console.log(`${url}\n  -> /${relative(join(ROOT, 'public'), localPath(url))}`);
        if (new URL(url).pathname.endsWith('.css')) {
            for (const ref of cssReferences(buf.toString('utf8'), url)) {
                if (new URL(ref).host !== new URL(url).host) throw new Error(`${url} refers to another host: ${ref}`);
                queue.push(ref);
            }
        }
    }
    await writeSources(entries);
}

async function cmdFont(url, name) {
    const css = (await download(url, { 'User-Agent': FONT_UA, Accept: 'text/css,*/*;q=0.1' })).toString('utf8');
    // Only static files (/s/…) can be pinned; dynamic subsets (/l/font?kit=…)
    // are generated per request.
    const unpinnable = css.match(/url\((?!https:\/\/fonts\.gstatic\.com\/s\/)[^)]*\)/);
    if (unpinnable) throw new Error(`not a static font file: ${unpinnable[0]}`);
    const files = [...cssReferences(css, url)];
    const local = css.replaceAll('https://fonts.gstatic.com/', '/vendor/fonts.gstatic.com/');
    const path = join(STATIC, 'fonts.googleapis.com', `${name}.css`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `/* ${url} */\n${local}`);
    console.log(`${url}\n  -> /vendor/fonts.googleapis.com/${name}.css (${files.length} font files)`);
    await cmdAdd(files);
}

async function* walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
            if (p !== PUBLIC_VENDOR) yield* walk(p);
        } else if (/\.(html|css|js|mjs)$/.test(e.name)) yield p;
    }
}

// Comments only document where a library comes from. They are blanked out,
// keeping their newlines so that line numbers stay true.
function stripComments(text, file) {
    const blank = (m) => m.replace(/[^\n]/g, ' ');
    if (file.endsWith('.html')) return text.replace(/<!--[\s\S]*?-->/g, blank);
    return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|\s)\/\/[^\n]*/g, blank);
}

async function cmdCheck() {
    let found = 0;
    for (const dir of [join(ROOT, 'public'), join(ROOT, 'app/src')]) {
        for await (const file of walk(dir)) {
            const lines = stripComments(await readFile(file, 'utf8'), file).split('\n');
            lines.forEach((line, i) => {
                if (!THIRD_PARTY.test(line)) return;
                console.error(`${relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 160)}`);
                found++;
            });
        }
    }
    if (found) throw new Error(`${found} third-party load(s) left`);
    console.log('no third-party loads');
}

const [cmd, ...args] = process.argv.slice(2);
const commands = {
    fetch: () => cmdFetch(),
    add: () => cmdAdd(args),
    font: () => cmdFont(args[0], args[1]),
    check: () => cmdCheck(),
};
if (!commands[cmd]) {
    console.error('usage: vendor.mjs fetch | add <url>… | font <url> <name> | check');
    process.exit(2);
}
commands[cmd]().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
