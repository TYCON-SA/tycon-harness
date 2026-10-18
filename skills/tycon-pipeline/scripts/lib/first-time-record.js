'use strict';
// first-time-record.js — la constancia de las historias que escribió el modo primera vez de tycon-create-story.
//
// La marca `origin: first-time` del frontmatter se puede escribir a mano; esta constancia no: la deja el guion
// (story-without-bmad.js) en la carpeta de estado del arnés, donde el agente no escribe. `pipeline.js start` crea la
// rama (o hace git init) sola sólo cuando hay marca Y constancia para esa ruta y ese número. Un solo lugar para la
// clave: si el guion y el arranque la calcularan distinto, ninguna historia arrancaría sola.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { stateDir } = require('./state-dir.js');

const RECORD_DIR = 'first-time-stories';

function realPath(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

function recordFile(home, real) {
  const key = crypto.createHash('sha256').update(real).digest('hex').slice(0, 32);
  return path.join(stateDir(home), RECORD_DIR, `${key}.json`);
}

/** Deja la constancia de una historia recién escrita por el guion. */
function writeRecord(home, storyPath, storyId) {
  const real = realPath(storyPath);
  if (!real) throw new Error(`no existe la historia ${storyPath}`);
  const f = recordFile(home, real);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `${JSON.stringify({ path: real, story: String(storyId), at: new Date().toISOString() }, null, 2)}\n`);
  return f;
}

/** ¿Esta historia (esta ruta, este número) la escribió el guion? Ante cualquier duda, no. */
function isRecorded(home, storyPath, storyId) {
  const real = realPath(storyPath);
  if (!real) return false;
  try {
    const r = JSON.parse(fs.readFileSync(recordFile(home, real), 'utf8'));
    return r.path === real && String(r.story) === String(storyId);
  } catch {
    return false;
  }
}

module.exports = { RECORD_DIR, writeRecord, isRecorded };
