'use strict';
// codex-base-lock.js — another process takes a toy Codex base (`state_<n>.sqlite`), as Codex does while it writes, and
// lets it go after a while. For the tests of the readers of that base (coordination.js, office.js, work-in-progress.js).

const { spawn } = require('child_process');

/** Takes the base at `file` for `ms` milliseconds; resolves with the child process once the base is taken. */
function holdCodexBase(file, ms) {
  const script = `const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(${JSON.stringify(file)});
db.exec('BEGIN EXCLUSIVE');
process.stdout.write('tomada\\n');
setTimeout(() => { db.exec('COMMIT'); db.close(); }, ${Number(ms)});`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('tomada')) resolve(child); });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`el proceso que toma la base salió (${code}) antes de tomarla`)));
  });
}

/** Resolves when the child has exited. */
const exited = (child) => new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.on('exit', resolve); });

module.exports = { holdCodexBase, exited };
