#!/usr/bin/env node
/**
 * tycon-pipeline — la segunda capa del freno de escrituras por consola: mira lo que el comando escribió.
 *
 * El freno de antes (on-bash-write-gate.js) decide leyendo el texto del comando. Un intérprete que el shell resuelve al
 * correr (`${N:-node} x.js`, `"${CMD[@]}"`, `$1`, `N="sudo node"`, `git bisect run $N x.js`) queda fuera de su vista.
 * Esta pieza no lee el comando para saber qué escribe: saca una foto de lo protegido antes de correr (evento de antes,
 * Bash|PowerShell) y la compara por contenido después (evento de después y de fallo). Lo que cambió y no correspondía
 * vuelve a lo que tenía la foto, o se borra si no existía; queda un renglón `escritura-vista-despues` en gates.log
 * (sesión, ruta, programa; nunca el contenido) y el aviso le llega al agente.
 *
 * Qué protege y cómo se compara: lib/protected-photo.js. Los repos que se miran: el de la carpeta de la sesión y el de
 * cada `cd` escrito en el comando.
 *
 * No deshace un comando cuyos programas son todos reconocidos: marker.js o un guion de este mismo arnés (por su ruta
 * real), más `cd`, `echo`, `true`, `pwd` y `test`, sin redirecciones a archivos. Un comando que mezcla un programa
 * reconocido con otro se deshace entero: después de correr no se sabe cuál escribió cada cosa, y el aviso dice que
 * marker.js va en un comando aparte.
 *
 * Límites conocidos: un proceso que el comando deja vivo (`&`, `nohup`) y escribe cuando el comando ya terminó, un
 * comando cortado por tiempo que no llega al evento de después, un guion que escribe en otro repo sin nombrarlo con
 * `cd`, y una historia nueva en una carpeta donde no había ninguna. Para esos queda la red del commit.
 *
 * Exit 0 siempre. Apagado: TYCON_STORY_GATE=off (el mismo interruptor del freno de antes). Las fallas van a
 * hook-errors.log.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const { stateDir: stateDirOf } = require('./lib/state-dir.js');
const { homeCommand } = require('./lib/home-command.js');
const photo = require('./lib/protected-photo.js');

const RAIZ_DEL_ARNES = path.resolve(__dirname, '..', '..', '..');
const EVENTOS_DE_DESPUES = ['PostToolUse', 'PostToolUseFailure'];
const SIN_ESCRIBIR = new Set(['cd', 'echo', 'true', 'pwd', 'test', '[', ':']);

function logHookError(stateDir, e) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(path.join(stateDir, 'hook-errors.log'),
      `[${new Date().toISOString()}] on-bash-write-after FAILED OPEN: ${(e && e.stack) || e}\n\n`, 'utf8');
  } catch (_) { /* nada */ }
}

/** El repo de la carpeta de la sesión y el de cada `cd` o `pushd` literal del comando (con sus opciones y comillas). */
function reposDelComando(cwd, comando) {
  const { findRepoRoot } = require('./lib/story-discovery.js');
  const out = new Set();
  const agregar = (dir) => { const r = findRepoRoot(dir); if (r) out.add(r); };
  agregar(cwd);
  const re = /(?:^|[\s;&|(])(?:cd|pushd)((?:\s+-[-LPe@]*)*)\s+(?:"([^"]+)"|'([^']+)'|([^\s'";&|)]+))/g;
  for (const m of String(comando).matchAll(re)) {
    const destino = expandirCasa(m[2] || m[3] || m[4]);
    agregar(path.resolve(cwd, destino));
  }
  return [...out];
}

/** `~`, `$HOME` y `${HOME}` al principio de una palabra, por la carpeta de la cuenta. */
const expandirCasa = (p) => String(p).replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, os.homedir());

/**
 * ¿Hay una redirección a un archivo fuera de comillas? `2>&1`, `>&-` y `> /dev/null` no escriben nada protegido;
 * `>&archivo` sí. Un comando con el citado `$'…'` cuenta como que redirige: el lector no lo entiende.
 */
function redirigeAArchivo(comando) {
  let q = null;
  const s = String(comando);
  if (s.includes("$'")) return true;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; else if (c === '\\' && q === '"') i++; continue; }
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c !== '>') continue;
    let j = i + 1;
    if (s[j] === '>' || s[j] === '|') j++;
    if (s[j] === '&') {
      if (/[\d-]/.test(s[j + 1] || '')) { i = j + 1; continue; }
      return true;
    }
    while (s[j] === ' ' || s[j] === '\t') j++;
    if (!s.startsWith('/dev/null', j)) return true;
  }
  return false;
}

const realOrNull = (p) => { try { return fs.realpathSync(p); } catch (_) { return null; } };

/**
 * ¿Es un guion de este arnés que se puede reconocer? marker.js siempre; otro guion, sólo si git lo sigue y no tiene
 * cambios (uno que el agente dejó o editó bajo la raíz no cuenta).
 */
function guionDelArnes(palabra, cwd) {
  const real = realOrNull(path.resolve(cwd, expandirCasa(palabra)));
  const raiz = realOrNull(RAIZ_DEL_ARNES);
  if (!real || !raiz || !real.startsWith(raiz + path.sep) || !/\.(c?js|sh)$/.test(real)) return false;
  if (real === realOrNull(path.join(__dirname, 'marker.js'))) return true;
  const rel = path.relative(raiz, real);
  const git = (args) => require('child_process').execFileSync('git', ['-C', raiz, ...args], { windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
  try {
    if (!git(['ls-files', '--', rel]).trim()) return false;
    git(['diff', '--quiet', 'HEAD', '--', rel]);
    return true;
  } catch (_) { return false; }
}

/** ¿Es el `node` de verdad? `node` a secas, o una ruta al mismo ejecutable que corre este gancho. */
const esNode = (p) => p === 'node' || p === 'node.exe' || (path.isAbsolute(p) && realOrNull(p) === realOrNull(process.execPath));

/**
 * Los programas del comando: `{ todosReconocidos, algunoReconocido, soloGit }`. Reconocido: marker.js o un guion de
 * este arnés, corrido con node o directo, sin asignaciones delante (`NODE_OPTIONS=`, `PATH=` cambian lo que corre); los
 * de SIN_ESCRIBIR no cuentan para ningún lado. `soloGit`: todos los programas son git, sin asignaciones.
 */
function programas(comando, cwd, { powershell = false } = {}) {
  const { segmentos } = require(path.join(RAIZ_DEL_ARNES, 'scripts', 'lib', 'az-pr.js'));
  let reconocidos = 0;
  let otros = 0;
  let gits = 0;
  for (const seg of segmentos(String(comando || ''), { powershell })) {
    let i = 0;
    while (seg[i] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[i].texto)) i++;
    const p = seg[i];
    if (!p) continue;
    if (!p.esBandera) { otros++; continue; }
    if (SIN_ESCRIBIR.has(p.texto) && i === 0) continue;
    if (p.texto === 'git' && i === 0) { gits++; continue; }
    if (i > 0) { otros++; continue; }
    let guion = p.texto;
    if (esNode(p.texto)) {
      const g = seg[i + 1];
      // una opción antes del guion (`--require`, `-e`) puede correr otra cosa
      if (!g || g.texto.startsWith('-')) { otros++; continue; }
      guion = g.texto;
    }
    if (guionDelArnes(guion, cwd)) reconocidos++; else otros++;
  }
  const limpio = !redirigeAArchivo(comando);
  return {
    todosReconocidos: limpio && reconocidos > 0 && otros === 0 && gits === 0,
    algunoReconocido: reconocidos > 0,
    soloGit: limpio && gits > 0 && otros === 0 && reconocidos === 0,
  };
}

function leerEntrada() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { return null; }
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function archivoDeLaFoto(stateDir, input) {
  const limpio = (x) => String(x || '').replace(/[^\w.-]/g, '_');
  return path.join(photo.photosDir(stateDir), `${limpio(input.session_id || '_nosession')}-${limpio(input.tool_use_id || '_sinid')}.json`);
}

function mensaje(hechas, fallas, mezclado) {
  const rel = (abs) => abs.replace(os.homedir(), '~');
  const lineas = ['⛔ tycon-pipeline — LO QUE EL COMANDO ESCRIBIÓ SE DESHIZO', ''];
  for (const d of hechas) lineas.push(`  · ${rel(d.abs)}: ${d.que}; ${d.deshacer === 'borrar' ? 'lo borré' : 'volvió a lo que tenía'}`);
  for (const f of fallas) lineas.push(`  · ${rel(f.abs)}: no se pudo deshacer (${f.motivo})`);
  lineas.push('', 'Una historia que no está en borrador, el estado de un borrador, una constancia y los marcadores de la ejecución no se',
    'escriben desde un comando: desde la consola no se ve qué queda escrito. La historia se edita con la herramienta de',
    'edición y su estado lo cambia marker.js:',
    `  · ${homeCommand('.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js')} update-story-status <ruta de la historia> <estado>`);
  if (mezclado) lineas.push('', 'El comando mezclaba el del orquestador (marker.js) con otros programas: después de correr no se sabe cuál',
    'escribió cada cosa. Corré el del orquestador solo, sin otros programas en la misma línea.');
  return lineas.join('\n');
}

/** Una mirada que no se pudo hacer queda en hook-errors.log y se le dice al agente: callarla dejaría pasar lo escrito. */
function noSePudoMirar(input, stateDir, motivo) {
  logHookError(stateDir, new Error(`no se pudo mirar: ${motivo}`));
  const texto = `⚠️ tycon-pipeline — no pude mirar qué escribió el comando en las historias y las constancias (${motivo}). Si tocó alguna, revisala antes de seguir.`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: texto } }) + '\n');
}

function despues(input, stateDir) {
  const archivo = archivoDeLaFoto(stateDir, input);
  let foto = null;
  try { foto = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') logHookError(stateDir, e); return; }
  try { fs.rmSync(archivo, { force: true }); } catch (_) { /* nada */ }
  if (!photo.photoIntact(foto)) { noSePudoMirar(input, stateDir, `la foto ${archivo} no coincide con su huella`); return; }
  let diferencias = photo.differences(foto, { stateDir });
  if (!diferencias.length) return;
  const comando = String((input.tool_input || {}).command || '');
  const cwd = input.cwd || process.cwd();
  const prog = programas(comando, cwd, { powershell: input.tool_name === 'PowerShell' });
  if (prog.todosReconocidos) return;
  // un cambio de rama, un pull o un merge traen lo commiteado: eso no lo escribió el comando
  if (prog.soloGit) {
    const deGit = new Set(photo.gitBrought(foto, diferencias));
    diferencias = diferencias.filter((d) => !deGit.has(d));
    if (!diferencias.length) return;
  }
  const { hechas, fallas } = photo.undo(foto, diferencias, { stateDir });
  const ts = new Date().toISOString(); // stable-data: la hora del renglón del registro
  const programa = comando.replace(/\s+/g, ' ').slice(0, 160);
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    for (const d of hechas) fs.appendFileSync(path.join(stateDir, 'gates.log'), `${JSON.stringify({ ts, name: 'escritura-vista-despues', status: 'undone', sesion: input.session_id || null, archivo: d.abs, que: d.que, programa })}\n`);
  } catch (e) { logHookError(stateDir, e); }
  for (const f of fallas) logHookError(stateDir, new Error(`no se pudo deshacer ${f.abs}: ${f.motivo}`));
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: mensaje(hechas, fallas, prog.algunoReconocido) } }) + '\n');
}

function main() {
  const stateDir = stateDirOf(os.homedir());
  try {
    if (String(process.env.TYCON_STORY_GATE || '').toLowerCase() === 'off') return;
    const input = leerEntrada();
    if (!input || !['Bash', 'PowerShell'].includes(input.tool_name)) return;
    if (input.hook_event_name === 'PreToolUse') {
      const comando = String((input.tool_input || {}).command || '');
      const foto = photo.takePhoto({ roots: reposDelComando(input.cwd || process.cwd(), comando), stateDir });
      photo.writeWhole(archivoDeLaFoto(stateDir, input), JSON.stringify(foto));
      return;
    }
    if (EVENTOS_DE_DESPUES.includes(input.hook_event_name)) {
      try { despues(input, stateDir); } catch (e) { noSePudoMirar(input, stateDir, (e && e.message) || String(e)); }
    }
  } catch (e) { logHookError(stateDir, e); }
}

if (require.main === module) main();
module.exports = { programas, reposDelComando, redirigeAArchivo };
