#!/usr/bin/env node
// Scrub gate for the public release tree.
//
// The July 12 2026 lesson (RUNBOOK-HISTORY.md): a hand-copied port reintroduced
// personal example strings that had already been scrubbed once, because the leak
// was in source COMMENTS and zod .describe() strings - not in the docs anyone
// thought to re-read. So this scans every byte of every tracked file in the
// release tree, not just markdown, and fails the build on a hit.
//
// Usage:  node tools/public-port/scrub-check.js [dir]     (default: public/)
// Exit 0 = clean, 1 = at least one hit (or the tree is missing).

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'public'));

// Each rule is [label, regex]. Regexes are applied line by line, case-sensitive
// unless the pattern says otherwise, so "danfeed" does not fire on "Dandelion".
const RULES = [
  ['owner name', /\bDan(?:'s)?\b/],
  ['employer', /\bSonos\b/i],
  ['employer tracker host', /atlassian\.net/i],
  ['private project keys', /\b(?:GSSD|PCT)-?\d*\b/],
  ['issue tracker coupling', /\bJira\b/i],
  ['private service', /\bdanfeed\b/i],
  ['private topics', /\b(?:Linkhouse|PennyMac|Proofpoint)\b/i],
  ['private hostnames', /thecasmas|mcp-anchor|mcp-home/i],
  ['private LAN address', /\b192\.168\.\d{1,3}\.\d{1,3}\b/],
  ['private DB row citation', /\bobs(?:ervation)? \d{3,}\b/i],
  ['private doc reference', /\b(?:ATLAS\.md|RUNBOOK-HISTORY\.md|ATLAS-V2-RUNBOOK|SPEC-tray-and-commands)\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{16,}/],
  ['possible token secret', /\b[0-9a-f]{48,}\b/],
];

const SKIP_DIRS = new Set(['.git', 'node_modules', 'data', 'coverage']);
const SKIP_FILES = new Set(['package-lock.json']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && !SKIP_FILES.has(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

if (!fs.existsSync(ROOT)) {
  console.error(`scrub-check: release tree not found at ${ROOT}`);
  process.exit(1);
}

const hits = [];
for (const file of walk(ROOT)) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (e) {
    continue; // binary or unreadable - nothing quotable in it
  }
  content.split('\n').forEach((line, i) => {
    for (const [label, re] of RULES) {
      const m = re.exec(line);
      if (m) {
        hits.push({
          file: path.relative(ROOT, file),
          line: i + 1,
          label,
          match: m[0],
          context: line.trim().slice(0, 120),
        });
      }
    }
  });
}

const files = walk(ROOT).length;
if (hits.length === 0) {
  console.log(`scrub-check: clean - ${files} files, ${RULES.length} rules, 0 hits`);
  process.exit(0);
}

console.error(`scrub-check: FAILED - ${hits.length} hit(s) in ${files} files\n`);
for (const h of hits) {
  console.error(`  ${h.file}:${h.line}  [${h.label}] "${h.match}"`);
  console.error(`      ${h.context}`);
}
console.error(`\nThe public tree must carry no private context. Rewrite these lines`);
console.error(`(generic examples, no private identifiers) or narrow the rule in`);
console.error(`tools/public-port/scrub-check.js if it is a genuine false positive.`);
process.exit(1);
