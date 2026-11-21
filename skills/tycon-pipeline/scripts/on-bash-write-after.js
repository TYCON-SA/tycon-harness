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

/** El repo de la carpeta de la sesión y el de cada `cd` literal del comando, sin repetir. */
function reposDelComando(cwd, comando) {
  const { findRepoRoot } = require('./lib/story-discovery.js');
  const out = new Set();
  const agregar = (dir) => { const r = findRepoRoot(dir); if (r) out.add(r); };
  agregar(cwd);
  for (const m of String(comando).matchAll(/(?:^|[\s;&|(])cd\s+(['"]?)([^\s'";&|)]+)\1/g)) {
    const destino = m[2].replace(/^~(?=\/|$)/, os.homedir());
    agregar(path.resolve(cwd, destino));
  }
  return [...out];
}

/** ¿Hay una redirección a un archivo fuera de comillas? (`2>&1` y `> /dev/null` no escriben nada protegido) */
function redirigeAArchivo(comando) {
  let q = null;
  const s = String(comando);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; else if (c === '\\' && q === '"') i++; continue; }
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c !== '>') continue;
    let j = i + 1;
    if (s[j] === '>' || s[j] === '|') j++;
    if (s[j] === '&') { i = j; continue; }
    while (s[j] === ' ' || s[j] === '\t') j++;
    if (!s.startsWith('/dev/null', j)) return true;
  }
  return false;
}

/** ¿La ruta real del guion está dentro de este arnés? */
function guionDelArnes(palabra, cwd) {
  try {
    const real = fs.realpathSync(path.resolve(cwd, palabra.replace(/^~(?=\/|$)/, os.homedir())));
    const raiz = fs.realpathSync(RAIZ_DEL_ARNES);
    return real.startsWith(raiz + path.sep) && /\.(c?js|sh)$/.test(real);
  } catch (_) { return false; }
}

/**
 * Los programas del comando: `{ todosReconocidos, algunoReconocido }`. Reconocido: marker.js o un guion de este arnés
 * corrido con node o directo; los de SIN_ESCRIBIR no cuentan para ningún lado.
 */
function programas(comando, cwd, { powershell = false } = {}) {
  const { segmentos } = require(path.join(RAIZ_DEL_ARNES, 'scripts', 'lib', 'az-pr.js'));
  let reconocidos = 0;
  let otros = 0;
  for (const seg of segmentos(String(comando || ''), { powershell })) {
    let i = 0;
    while (seg[i] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[i].texto)) i++;
    const p = seg[i];
    if (!p) continue;
    if (!p.esBandera) { otros++; continue; }
    if (SIN_ESCRIBIR.has(p.texto)) continue;
    let guion = p.texto;
    if (/^node(\.exe)?$/i.test(path.basename(p.texto))) {
      const resto = seg.slice(i + 1);
      const g = resto.find((x) => !x.texto.startsWith('-'));
      // una opción antes del guion (`--require`, `-e`) puede correr otra cosa
      if (!g || resto.indexOf(g) !== 0) { otros++; continue; }
      guion = g.texto;
    }
    if (guionDelArnes(guion, cwd)) reconocidos++; else otros++;
  }
  const limpio = !redirigeAArchivo(comando);
  return { todosReconocidos: limpio && reconocidos > 0 && otros === 0, algunoReconocido: reconocidos > 0 };
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
    '  · node "$HOME/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js" update-story-status <ruta de la historia> <estado>');
  if (mezclado) lineas.push('', 'El comando mezclaba marker.js con otros programas: después de correr no se sabe cuál escribió cada cosa.',
    'Corré marker.js en un comando aparte.');
  return lineas.join('\n');
}

function despues(input, stateDir) {
  const archivo = archivoDeLaFoto(stateDir, input);
  let foto = null;
  try { foto = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') logHookError(stateDir, e); return; }
  try { fs.rmSync(archivo, { force: true }); } catch (_) { /* nada */ }
  if (!photo.photoIntact(foto)) { logHookError(stateDir, new Error(`no se pudo mirar: la foto ${archivo} no coincide con su huella`)); return; }
  const diferencias = photo.differences(foto, { stateDir });
  if (!diferencias.length) return;
  const comando = String((input.tool_input || {}).command || '');
  const cwd = input.cwd || process.cwd();
  const prog = programas(comando, cwd, { powershell: input.tool_name === 'PowerShell' });
  if (prog.todosReconocidos) return;
  const { hechas, fallas } = photo.undo(diferencias, { stateDir });
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
    if (EVENTOS_DE_DESPUES.includes(input.hook_event_name)) despues(input, stateDir);
  } catch (e) { logHookError(stateDir, e); }
}

if (require.main === module) main();
module.exports = { programas, reposDelComando, redirigeAArchivo };
