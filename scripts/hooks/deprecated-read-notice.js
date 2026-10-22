#!/usr/bin/env node
/**
 * deprecated-read-notice.js — PostToolUse: leer un archivo deprecado trae su aviso.
 *
 * Cuando el agente lee un archivo que el repo declara deprecado (la lista de `.tycon/advisors.yaml` o la marca
 * `harness-deprecated:` en su cabecera), el arnés le agrega «deprecado (<nivel>): <motivo> — no lo uses de ejemplo».
 * Una vez por archivo y por sesión (`<estado>/deprecated-notices/read-<sesión>.json`).
 *
 * Dos lecturas: la herramienta Read de Claude Code y un `cat`/`sed -n`/`head`/… por la terminal (su evento Bash, que
 * es el único que Codex tiene: su herramienta propia de lectura no emite evento). Los comandos se leen con el mismo
 * lector que `missing-path-notice.js`; un comando con `cd` propio se saltea, como ahí (no se sabe contra qué carpeta
 * resolvió).
 *
 * El aviso viaja en `hookSpecificOutput.additionalContext`, el canal de PostToolUse que llega al modelo en las dos
 * herramientas (medido por el banco, `controls-bench/live-fire.js`). Ante cualquier error, calla.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const LIB = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'deprecated.js');
const NIVEL = { frozen: 'congelado', dead: 'muerto' };

function stateDir() {
  const lib = path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js');
  return fs.existsSync(lib) ? require(lib).stateDir(os.homedir()) : path.join(os.homedir(), '.claude', '.tycon-pipeline');
}

/** Las rutas que el evento leyó, absolutas. */
function rutasLeidas(evento) {
  const entrada = evento.tool_input || {};
  const cwd = (evento.cwd && String(evento.cwd)) || process.cwd();
  if (evento.tool_name === 'Read') return entrada.file_path ? [path.resolve(cwd, String(entrada.file_path))] : [];
  const cmd = String(entrada.command || '');
  if (!cmd || /(^|[;&|]\s*)cd\s/.test(cmd)) return [];
  // `sed -n '<rango>' archivo` es una lectura; el lector de comandos sólo conoce los comandos que no escriben nunca,
  // así que se le presenta como un `cat`. `sed -i` no se toca: es escribir.
  const comoLectura = cmd.replace(/\bsed\s+-n\s+(?:'[^']*'|"[^"]*"|\S+)/g, 'cat');
  const { readPaths } = require('./missing-path-notice.js');
  return readPaths(comoLectura).flat().map((r) => path.resolve(cwd, r));
}

function yaAvisados(dir, sesion) {
  const archivo = path.join(dir, 'deprecated-notices', `read-${String(sesion || 'sin-sesion').replace(/[^\w.-]/g, '_')}.json`);
  let lista = [];
  try { lista = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch (_e) { lista = []; }
  return { archivo, lista: Array.isArray(lista) ? lista : [] };
}

function avisos(evento, { dir = stateDir() } = {}) {
  if (!fs.existsSync(LIB)) return '';
  const dep = require(LIB);
  const vistos = yaAvisados(dir, evento.session_id);
  const lineas = [];
  for (const abs of rutasLeidas(evento)) {
    if (vistos.lista.includes(abs)) continue;
    const repo = dep.raizDelRepo(abs);
    if (!repo) continue;
    const c = dep.clasificar(repo, abs, { stateDir: dir, sessionId: evento.session_id });
    if (!c) continue;
    vistos.lista.push(abs);
    lineas.push(`${dep.relativa(repo, abs)}: deprecado (${NIVEL[c.level]}): ${c.reason} — no lo uses de ejemplo.`);
  }
  if (!lineas.length) return '';
  try {
    fs.mkdirSync(path.dirname(vistos.archivo), { recursive: true });
    fs.writeFileSync(vistos.archivo, JSON.stringify(vistos.lista));
  } catch (_e) { /* sin estado se repite el aviso: mejor que callarlo */ }
  return lineas.join('\n');
}

/**
 * Escribir lo deprecado por la terminal con `deprecated.edit: warn`: el aviso de antes del comando sólo lo ve la persona
 * (PreToolUse no le habla al modelo), así que acá, después, se le dice al modelo. Con `block` el comando no corrió.
 */
function avisoDeEscritura(evento) {
  if (evento.tool_name !== 'Bash' && evento.tool_name !== 'PowerShell') return '';
  const cmd = String((evento.tool_input || {}).command || '');
  if (!cmd) return '';
  const puerta = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'on-bash-write-gate.js');
  const freno = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'on-deprecated-edit.js');
  if (!fs.existsSync(puerta) || !fs.existsSync(freno)) return '';
  const { destinosResueltos } = require(puerta);
  const r = require(freno).porLaTerminal({
    cmd, cwd: (evento.cwd && String(evento.cwd)) || process.cwd(),
    destinos: (c, cwd) => destinosResueltos(c, cwd, process.platform, { keep: () => true }).map((d) => d.abs),
    sessionId: evento.session_id || null, stateDir: stateDir(), soloAvisar: true,
  });
  return r && r.aviso ? r.aviso : '';
}

module.exports = { rutasLeidas, avisos, avisoDeEscritura };

if (require.main === module) {
  try {
    const evento = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    let escritura = '';
    try { escritura = avisoDeEscritura(evento); } catch (_e) { escritura = ''; }
    const texto = [avisos(evento), escritura].filter(Boolean).join('\n');
    if (texto) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: texto } }) + '\n');
    }
  } catch (_e) { /* el aviso nunca rompe la lectura */ }
  process.exit(0);
}
