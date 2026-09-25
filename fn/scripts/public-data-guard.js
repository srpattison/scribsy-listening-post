'use strict';

// CB-LISTEN-FIX-1 acceptance check 6: run once, before committing, with the
// change staged. The repo is public; the private review fixtures must never
// reach it, verbatim or in pieces.
//
// Usage: LP_PRIVATE_DIR=/path/outside/repo node scripts/public-data-guard.js
//
// Fails (exit 1) when:
//   - `git ls-files` lists a file whose name matches a file in LP_PRIVATE_DIR;
//   - any 40-character substring of any string value longer than 40 characters,
//     in any JSON file in LP_PRIVATE_DIR, appears in `git diff --cached`;
//   - any `author` value from those files appears as a whole word in an added
//     line of `git diff --cached`;
//   - an added line carries a Reddit-style `u/<name>` reference.
// Prints counts only. Skipped with a note when LP_PRIVATE_DIR is unset.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const WINDOW = 40;
// A window must carry real text to count: 40 dashes or spaces match any
// Markdown rule. Platform system accounts are named throughout the public
// code already and are not personal data.
const MIN_ALNUM_IN_WINDOW = 10;
const SYSTEM_ACCOUNTS = new Set(['automoderator']);
const hasText = (w) => (w.match(/[A-Za-z0-9]/g) || []).length >= MIN_ALNUM_IN_WINDOW;
const REPO = path.resolve(__dirname, '../..');
const git = (...args) => execFileSync('git', ['-c', `safe.directory=${REPO.replace(/\\/g, '/')}`, ...args],
  { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

function walkStrings(node, visit, key = null) {
  if (typeof node === 'string') visit(node, key);
  else if (Array.isArray(node)) for (const v of node) walkStrings(v, visit, key);
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walkStrings(v, visit, k);
}

function main() {
  const dir = process.env.LP_PRIVATE_DIR;
  if (!dir || !fs.existsSync(dir)) { console.log('skipped: LP_PRIVATE_DIR not set'); return; }

  const diff = git('diff', '--cached', '--no-color', '-U0');
  const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n');
  const windows = new Set();
  for (let i = 0; i + WINDOW <= diff.length; i++) windows.add(diff.slice(i, i + WINDOW));

  const privateFiles = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile());
  const tracked = new Set(git('ls-files').split('\n').map((f) => path.basename(f)));
  const trackedPrivate = privateFiles.filter((f) => tracked.has(f)).length;

  let stringsChecked = 0, substringHits = 0;
  const authors = new Set();
  for (const f of privateFiles.filter((f) => f.endsWith('.json'))) {
    const json = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    walkStrings(json, (s, key) => {
      if (key === 'author' && s.length >= 3 && !/^\[.*\]$/.test(s) && !SYSTEM_ACCOUNTS.has(s.toLowerCase())) authors.add(s);
      if (s.length <= WINDOW) return;
      stringsChecked++;
      for (let i = 0; i + WINDOW <= s.length; i++) {
        const w = s.slice(i, i + WINDOW);
        if (hasText(w) && windows.has(w)) { substringHits++; return; }
      }
    });
  }

  let authorHits = 0;
  for (const a of authors) {
    const rx = new RegExp(`(^|[^A-Za-z0-9_-])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_-])`);
    if (rx.test(added)) authorHits++;
  }
  const userRefs = (added.match(/(^|[^A-Za-z0-9])u\/[A-Za-z0-9_-]{3,}/g) || []).length;

  const result = { privateFiles: privateFiles.length, trackedPrivate, stringsChecked, substringHits,
    authorsChecked: authors.size, authorHits, userRefs, stagedDiffChars: diff.length };
  console.log(JSON.stringify(result));
  if (trackedPrivate || substringHits || authorHits || userRefs) {
    console.error('FAIL: private fixture content is staged');
    process.exitCode = 1;
  } else {
    console.log('PASS: no private fixture content in the staged diff');
  }
}

main();
