#!/usr/bin/env node
'use strict';
/**
 * replace-section.js — reemplazar un tramo de líneas de un archivo POR LA MISMA CADENA QUE UN EDIT (story 7.25 del arnés).
 *
 *   node <skill>/scripts/replace-section.js --file <ruta> --from <n> --to <m> --with <archivo>
 *
 * Por qué existe: con el pipeline abierto, una escritura de código por consola se frena («EDICIÓN INVISIBLE»,
 * lib/ledger-visible.js) porque el registro de ediciones sólo lo alimenta el hook de Edit|Write. Para un reemplazo
 * grande —un tramo de ~300 líneas de un archivo de pruebas, caso de un producto del equipo del 2026-10-14— un Edit
 * obliga a reproducir el bloque viejo entero, y la salida que quedaba era el escape del freno más un Edit chico para que
 * el registro viera el archivo. Esta receta hace el reemplazo como lo haría el Edit:
 *   1. arma el evento de un Edit de ese tramo (`old_string` = las líneas n..m, `new_string` = el contenido nuevo);
 *   2. corre la cadena `pre-edit` del despachador (carril, story a mano, evidencia, ATDD, colisiones…): si un freno
 *      para, sale 2 con su mensaje y el archivo NO cambia;
 *   3. escribe;
 *   4. corre la cadena `post-edit` (el registro de ediciones, entre otros).
 * No hay un segundo camino que mantener: los frenos y el registro son los del Edit.
 *
 * Las líneas se cuentan desde 1 e incluyen las dos puntas. `--with` es un archivo (el scratchpad), no texto en la
 * línea de comandos: un tramo grande no entra cómodo en un argumento, y así el comando no lleva código que el freno de
 * la consola tenga que interpretar. La sesión sale de lib/session-id.js (la misma que usan marker.js y los hooks).
 *
 * Pasa por los frenos del arnés que corre un Edit (la cadena `pre-edit`), pero NO por las reglas de permisos de la
 * herramienta Edit: por consola, el permiso sólo ve `node replace-section.js`. Por eso se acota sola: escribe únicamente
 * dentro del repo de la corrida o de la carpeta desde donde se la llama, comparando rutas reales (un enlace no la saca).
 * Antes de escribir relee el archivo: si cambió mientras corrían los frenos, no lo toca.
 *
 * Exit: 0 reemplazó · 2 no escribió nada (entrada inválida, un freno del Edit lo paró o el archivo cambió en el medio;
 * stderr dice por qué) · 3 escribió, pero la cadena posterior al Edit falló (el registro puede no haberlo visto).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveSessionId } = require('./lib/session-id.js');

// El despachador de los hooks de Edit, fijo: sin variable que lo cambie (una variable puesta adelante del comando
// salteaba todos los frenos — por eso la relectura y la salida 3 no tienen prueba que los simule).
const DISPATCH = path.join(__dirname, 'dispatch.js');

function salir(msg) { process.stderr.write(`replace-section: ${msg}\n`); process.exit(2); }

function argumentos(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (['--file', '--from', '--to', '--with'].includes(k)) { a[k.slice(2)] = argv[i + 1]; i++; continue; }
    if (k === '--help' || k === '-h') a.help = true;
  }
  return a;
}

function cadena(modo, evento) {
  return spawnSync(process.execPath, [DISPATCH, modo], { input: JSON.stringify(evento), encoding: 'utf8', env: process.env });
}

function main() {
  const a = argumentos(process.argv.slice(2));
  if (a.help) {
    process.stdout.write('uso: node replace-section.js --file <ruta> --from <n> --to <m> --with <archivo>\n');
    process.exit(0);
  }
  if (!a.file || !a.from || !a.to || !a.with) salir('faltan argumentos: --file <ruta> --from <n> --to <m> --with <archivo>');
  const desde = Number(a.from);
  const hasta = Number(a.to);
  if (!Number.isInteger(desde) || !Number.isInteger(hasta) || desde < 1 || hasta < desde) {
    salir(`rango inválido: --from ${a.from} --to ${a.to} (enteros, desde 1, y --to no menor que --from)`);
  }
  const abs = path.resolve(process.cwd(), a.file);
  // Se lee como bytes: si no es UTF-8 válido, reescribirlo cambiaría en silencio los bytes de líneas que ni se tocan
  // (un .cs en Windows-1252 — vuelta 5 de revisores). Esos archivos van con la herramienta Edit.
  const comoUtf8 = (ruta, que) => {
    let buf;
    try { buf = fs.readFileSync(ruta); } catch (e) { salir(`no pude leer ${que} ${ruta} (${e.code || e.message})`); }
    const t = buf.toString('utf8');
    if (!Buffer.from(t, 'utf8').equals(buf)) salir(`${que} ${ruta} no es UTF-8 válido; no escribí nada (usá la herramienta Edit).`);
    return t;
  };
  const texto = comoUtf8(abs, 'el archivo');
  // Por consola, la receta NO pasa por las reglas de permisos de la herramienta Edit (revisión de seguridad, vuelta 2):
  // sólo escribe dentro del repo de la corrida o de la carpeta desde donde se la llama, con la RUTA REAL (un enlace
  // adentro que apunta afuera no la saca).
  // `.native`: la ruta con la caja que tiene en el disco (en macOS `.GIT` y `.git` son la misma carpeta)
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };
  let repoDeLaCorrida = null;
  try {
    const io = require('./lib/story-gate-io.js');
    const m = io.readMarker(io.DEFAULT_STATE_DIR, resolveSessionId(null));
    repoDeLaCorrida = m && m.repoPath ? m.repoPath : null;
  } catch { repoDeLaCorrida = null; }   // sin marcador legible, queda sólo la carpeta de la llamada
  // La carpeta de la llamada vale sólo si es un repo git (su raíz): desde la carpeta de la persona o desde ~/.claude no
  // se escribe (vuelta 3 de revisores).
  let repoDeLaCarpeta = null;
  try {
    repoDeLaCarpeta = require('child_process').execFileSync('git', ['-C', process.cwd(), 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { repoDeLaCarpeta = null; }
  const raices = [repoDeLaCorrida, repoDeLaCarpeta].filter(Boolean).map(real).filter(Boolean);
  const destinoReal = real(abs);
  const adentro = destinoReal && raices.some((r) => destinoReal === r || destinoReal.startsWith(r + path.sep));
  if (!adentro) {
    salir(`${abs}${destinoReal && destinoReal !== abs ? ` (en realidad ${destinoReal})` : ''} queda fuera del repo de la corrida y del repo desde donde la llamaste (${raices.join(', ') || 'ninguno'}); no escribí nada. Para otro archivo, usá la herramienta Edit.`);
  }
  // nunca lo de adentro de .git (un hook de git es código que corre solo, y la historia no se edita así)
  const bajoGit = (p) => String(p).split(path.sep).some((seg) => seg.toLowerCase() === '.git');
  if (bajoGit(destinoReal) || bajoGit(abs)) salir(`${destinoReal} está dentro de una carpeta .git; no escribí nada.`);
  const dentroDeLasRaices = (p) => p && raices.some((r) => p === r || p.startsWith(r + path.sep)) && !bajoGit(p);
  const nuevo = comoUtf8(path.resolve(process.cwd(), a.with), '--with');

  // Las líneas con su salto, para no tocar nada fuera del tramo (ni el final del archivo).
  const lineas = texto.match(/[^\n]*\n|[^\n]+$/g) || [];
  if (hasta > lineas.length) salir(`rango inválido: el archivo tiene ${lineas.length} líneas y pediste hasta la ${hasta}`);
  const viejo = lineas.slice(desde - 1, hasta).join('');
  const ultimaDelTramoTieneSalto = viejo.endsWith('\n');
  // el salto que se agrega es el del archivo: CRLF si el tramo terminaba así (pase adversarial: quedaban finales mezclados)
  const salto = viejo.endsWith('\r\n') ? '\r\n' : '\n';
  const reemplazo = ultimaDelTramoTieneSalto && nuevo && !nuevo.endsWith('\n') ? `${nuevo}${salto}` : nuevo;
  const resultado = lineas.slice(0, desde - 1).join('') + reemplazo + lineas.slice(hasta).join('');

  const evento = {
    session_id: resolveSessionId(null),
    cwd: process.cwd(),
    tool_name: 'Edit',
    tool_input: { file_path: abs, old_string: viejo, new_string: reemplazo, replace_all: false },
  };
  const pre = cadena('pre-edit', { ...evento, hook_event_name: 'PreToolUse' });
  if (pre.status === 2) {
    process.stderr.write(pre.stderr || 'replace-section: un freno del Edit lo paró (sin mensaje)\n');
    process.exit(2);
  }
  if (pre.status !== 0) salir(`la cadena de frenos del Edit no terminó bien (exit ${pre.status}); no escribí nada.\n${pre.stderr || ''}`);
  if (pre.stdout) process.stdout.write(pre.stdout);

  // Los frenos tardan: si el archivo cambió mientras corrían, se escribiría sobre algo que nadie miró. Se relee y, si
  // no es lo que se leyó al principio, no se toca (revisión de seguridad de la 7.25).
  let ahora;
  try { ahora = fs.readFileSync(abs, 'utf8'); } catch (e) { salir(`no pude releer ${abs} antes de escribir (${e.code || e.message}); no escribí nada`); }
  if (ahora !== texto) salir(`${abs} cambió mientras corrían los frenos del Edit; no escribí nada. Volvé a correr la receta sobre el archivo actual.`);

  // La ruta real se vuelve a mirar justo antes de escribir (un enlace puesto mientras corrían los frenos la sacaría de
  // las raíces), y se abre sin seguir un enlace en el último tramo (O_NOFOLLOW, donde el sistema lo tiene).
  if (!dentroDeLasRaices(real(abs))) salir(`${abs} cambió de lugar mientras corrían los frenos del Edit (ahora es ${real(abs) || 'ilegible'}); no escribí nada.`);
  const nofollow = fs.constants.O_NOFOLLOW || 0;
  let fd;
  try { fd = fs.openSync(abs, fs.constants.O_WRONLY | fs.constants.O_TRUNC | nofollow); }
  catch (e) { salir(`no pude abrir ${abs} para escribir (${e.code || e.message}); no escribí nada.`); }
  try { fs.writeSync(fd, resultado, 0, 'utf8'); } finally { fs.closeSync(fd); }

  const post = cadena('post-edit', { ...evento, hook_event_name: 'PostToolUse', tool_response: { filePath: abs, success: true } });
  if (post.stdout) process.stdout.write(post.stdout);
  if (post.status !== 0) {
    // 3, no 2: con 2 «no escribí nada»; con 3 el archivo YA cambió y lo que falló es el registro posterior
    process.stderr.write(`replace-section: el archivo QUEDÓ ESCRITO, pero la cadena posterior al Edit salió ${post.status} (el registro puede no haberlo visto):\n${post.stderr || ''}`);
    process.exit(3);
  }
  const lineasNuevas = (reemplazo.match(/[^\n]*\n|[^\n]+$/g) || []).length;   // líneas, no saltos
  process.stdout.write(`replace-section: ${abs} — líneas ${desde}-${hasta} reemplazadas (${hasta - desde + 1} → ${lineasNuevas}), registradas como un Edit.\n`);
}

main();
