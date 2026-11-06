#!/usr/bin/env node
'use strict';
// generate.js — a baseline of Codex's AGENTS.md and of the output of `pipeline.js advisors`, so a later change can prove
// that Codex and Claude Code did not move. Everything runs in a temporary folder with its own HOME; paths and times are
// replaced by fixed marks so the files are the same on every machine.
//
// Usage:  node scripts/tests/fixtures/8.90-baseline/generate.js [--check]
//   (no flag)  rewrites agents-md-codex.md and advisors.json next to this file
//   --check    writes nothing; exits 1 and names the file when today's output differs from the saved one

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..', '..', '..', '..');
const CHECK = process.argv.includes('--check');

function normalize(text, marks) {
  let t = String(text);
  for (const [from, to] of marks.sort((a, b) => b[0].length - a[0].length)) t = t.split(from).join(to);
  return t.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<TS>');
}

function main() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-890-')));
  try {
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home, { recursive: true });
    const marks = [[tmp, '<TMP>'], [ROOT, '<ROOT>'], [os.tmpdir(), '<OSTMP>']];

    // Codex's AGENTS.md from the blocks of this tree, profile full, no integrations
    const blocks = require(path.join(ROOT, 'scripts', 'setup', 'agents-md-blocks.js'));
    const target = path.join(tmp, 'codex', 'AGENTS.md');
    const tree = path.join(tmp, 'tree');
    fs.mkdirSync(tree, { recursive: true });
    blocks.sync({ blocksDir: path.join(ROOT, 'claude-md-blocks'), target, integrations: {}, profile: 'full', tree, home, env: {}, quiet: true });
    const agentsMd = normalize(fs.readFileSync(target, 'utf8'), marks);

    // `pipeline.js advisors` on the example repo, one source file
    const repo = path.join(tmp, 'repo');
    fs.cpSync(path.join(ROOT, 'scripts', 'tests', 'fixtures', 'example-repo'), repo, { recursive: true });
    const tpl = fs.readFileSync(path.join(repo, 'story-1.1.md.tpl'), 'utf8');
    fs.writeFileSync(path.join(repo, 'story-1.1.md'), tpl.replace(/\{\{[^}]*\}\}/g, 'x'));
    // a minimal environment: the settings of the dev's shell (packs, cost tier…) would change the output
    const env = { HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: 'baseline-8.90' };
    for (const k of ['PATH', 'Path', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'PATHEXT']) if (process.env[k]) env[k] = process.env[k];
    const r = spawnSync(process.execPath, [path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'pipeline.js'), 'advisors',
      '--repo', repo, '--story', path.join(repo, 'story-1.1.md'), '--files', 'src/greeting.js'], { env, encoding: 'utf8', cwd: repo });
    if (r.status !== 0) {
      process.stderr.write(`generate: pipeline.js advisors salió ${r.status}\n${r.stderr}`);
      process.exitCode = 2;
      return;
    }
    const parsed = JSON.parse(r.stdout);
    const advisors = `${normalize(JSON.stringify(parsed, null, 2), marks.concat([[home, '<HOME>']]))}\n`;

    const outputs = { 'agents-md-codex.md': agentsMd, 'advisors.json': advisors };
    for (const [name, text] of Object.entries(outputs)) {
      const file = path.join(HERE, name);
      if (CHECK) {
        const saved = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        if (saved !== text) { process.exitCode = 1; process.stderr.write(`generate --check: ${name} es distinto de la línea base\n`); }
      } else {
        fs.writeFileSync(file, text);
        process.stdout.write(`escrito: ${path.relative(ROOT, file)}\n`);
      }
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* the OS cleans tmp */ }
  }
}

main();
