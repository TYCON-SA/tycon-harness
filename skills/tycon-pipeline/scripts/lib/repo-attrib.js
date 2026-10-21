'use strict';

/**
 * Atribución de REPO y STORY para los registros del arnés.
 *
 * POR QUÉ EXISTE: sin repo ni story en los registros no se puede contestar mecánicamente
 * "¿corrieron los revisores de la story X?". El registro de arranques (`advisor-runs/<sid>.jsonl`, que
 * escribe el hook on-advisor-run.js en CADA spawn real) y el registro voluntario (`gates.log`,
 * `check=advisors`) llevan este par `{repo, story}` además de `{ts, advisor, model}`.
 *
 * El dato está al alcance: el marker del pipeline (`active/<sid>.json`) trae
 * `repoPath` y `storyId`, y cuando no hay marker la raíz de git del directorio actual alcanza
 * para el repo.
 *
 * Todo acá es best-effort y NUNCA tira: un registro que rompe el spawn que quería registrar
 * es peor que no registrar.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { stateDir: stateDirOf } = require('./state-dir.js');   // la carpeta del estado, de una sola pieza
const { execFileSync } = require('child_process');

// Resolución PEREZOSA del directorio de estado: `os.homedir()` congelado al cargar el módulo hace
// que un HOME de laboratorio no tenga efecto, y un test que no puede aislar el estado real o lo
// ensucia (escribe en el registro de verdad) o se vuelve vacuo (se salta sus propias aserciones sin
// fallar). Un hook corre con un HOME fijo, así que
// resolverlo al usarlo no cambia nada en producción.
function stateDir() {
  return path.join(stateDirOf(os.homedir()));
}

/** Raíz del repo git que contiene `cwd`, o null. */
function gitRoot(cwd) {
  try {
    const out = execFileSync('git', ['-C', cwd || process.cwd(), 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
    }).trim();
    return out || null;
  } catch (_e) { return null; }
}

/**
 * Marker del pipeline de esa sesión (archivo per-session). Sólo lectura, sin fallback al
 * legacy single-file: acá el marker es un ENRIQUECEDOR del registro, no una fuente de verdad
 * — si no está, se cae a la raíz de git y listo.
 * @param {string} sessionIdKey  id ya saneado como nombre de archivo
 */
function readMarkerFile(sessionIdKey) {
  try {
    const p = path.join(stateDir(), 'active', `${String(sessionIdKey).replace(/[/\\]/g, '_')}.json`);
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (m && m.storyId) return m;
  } catch (_e) { /* sin marker */ }
  return null;
}

/**
 * `{repo, story}` para estampar en un registro.
 * Preferencia: el marker (sabe la story); si no hay, la raíz de git del cwd (sabe el repo).
 * @param {string} sessionIdKey
 * @param {string} [cwd]
 */
function attribution(sessionIdKey, cwd) {
  const m = readMarkerFile(sessionIdKey);
  const repo = (m && m.repoPath) || gitRoot(cwd) || null;
  const story = (m && m.storyId) || null;
  return { repo, story };
}

module.exports = { stateDir, gitRoot, readMarkerFile, attribution };
