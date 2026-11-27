#!/usr/bin/env node
/**
 * tycon-pipeline — la segunda capa del freno de escrituras por consola: mira lo que el comando escribió.
 *
 * El freno de antes (on-bash-write-gate.js) decide leyendo el texto del comando. Un intérprete que el shell resuelve al
 * correr (`${N:-node} x.js`, `"${CMD[@]}"`, `$1`, `N="sudo node"`, `git bisect run $N x.js`) queda fuera de su vista.
 * Esta pieza no lee el comando para saber qué escribe: saca una foto de lo protegido antes de correr (evento de antes,
 * de cualquier herramienta que traiga un comando de consola: Bash, PowerShell, Monitor) y la compara por contenido
 * después (evento de después y de fallo). Lo que cambió y no correspondía
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
 * Lo que no se deshace: lo que trajo un comando que es sólo git y quedó igual a lo commiteado; lo que escribió un Edit o
 * un Write de la misma sesión sobre ese archivo mientras corría el comando (el gancho anota cuándo empieza y termina
 * cada uno, en `write-photos/in-progress/`, y lo cree sólo si la conversación de la sesión trae esa llamada). Lo dudoso no
 * se deshace: se anota `escritura-dudosa` en gates.log y se avisa. Es dudoso un cambio con otra sesión viva en el mismo
 * repo desde antes del comando (las que ve live-sessions.js, en la foto y otra vez después), o con otro comando de la
 * misma sesión que corría marker.js sobre ese archivo. La hora de un archivo no decide nada: un guion la pone donde
 * quiere. De la conversación cuenta sólo lo que estaba escrito antes del comando, y sólo una llamada sin su resultado
 * (la que terminó antes no corrió a la vez); si un comando era del orquestador sale de la conversación, no del registro,
 * que el comando puede escribir. El marcador borrado de otra sesión es dudoso sólo si esa sesión sigue viva (su
 * `lastTouch`, con el corte de 24 h de marker.js); el de una muerta vuelve. Un comando anterior que prepara la
 * trampa (agrega una llamada falsa a la conversación, o hace que otra sesión se vea viva) no se ve: lo que cambie el
 * comando siguiente queda sin deshacer, o como dudoso, anotado y avisado. Para eso queda la red del commit.
 *
 * Límites conocidos: un proceso que el comando deja vivo (`&`, `nohup`) y escribe cuando el comando ya terminó, un
 * comando cortado por tiempo que no llega al evento de después, un guion que escribe en otro repo sin nombrarlo con
 * `cd`, una historia nueva en una carpeta donde no había ninguna, y un guion hecho para falsificar la foto y su huella
 * (la carpeta de las fotos la protege el freno de antes, leyendo el comando). Monitor corre su comando de fondo: su
 * evento de después llega cuando arranca, así que lo que escriba más tarde es el mismo límite que `&`. Para esos queda
 * la red del commit.
 *
 * Lo que la pieza no puede hacer no lo deja pasar callado: sin poder anotar el inicio o guardar la foto, el comando no
 * corre (sale 2); sin foto después, frena la sesión, aunque falte también su registro de inicio; una carpeta de las
 * fotos o del freno donde no se puede escribir cuenta como freno (se prueba escribiendo), y frena con su propio aviso:
 * se arregla la carpeta, no se libera con una firma. Una sesión frenada corre sólo lo que lee (soloLee): git, sólo
 * `rev-parse`, porque `status`, `diff`, `show`, `log` y `ls-files` pueden correr un programa de la configuración de git,
 * que se escribe con la herramienta de edición. La libera otra sesión, nunca ella: la persona, o la coordinadora
 * designada por la delegación del perfil; la firma de trámite no (marker.js release-write-after). Una edición de la
 * misma sesión sobre el mismo archivo, a la vez que el comando, no se deshace pero queda como dudosa: alcanza con
 * pedirla en el mismo mensaje para que el comando use su id.
 *
 * Límite conocido de la sesión frenada: la herramienta de edición, que el freno no alcanza, puede escribir lo que corre
 * un lector (`~/.zshenv`, que corre todo `zsh -c`): en dos pasos, cualquier lectura libera la sesión. La red del commit
 * sigue, y el freno de antes lee el texto de cada comando.
 *
 * Exit 0, salvo el 2 de una sesión frenada o sin dónde guardar la foto. Apagado: TYCON_STORY_GATE=off (el mismo interruptor del freno de antes). Las fallas van a
 * hook-errors.log.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const { stateDir: stateDirOf } = require('./lib/state-dir.js');
const { homeCommand } = require('./lib/home-command.js');
const photo = require('./lib/protected-photo.js');

// El comando del orquestador que se le muestra al agente: la carpeta de Claude Code la da tycon-home.js; sin él (una
// copia sin el instalador), la ruta absoluta de este marker.js
const MARCADOR = (() => {
  const lib = path.join(__dirname, '..', '..', '..', 'scripts', 'setup', 'harness', 'tycon-home.js');
  if (!fs.existsSync(lib)) return `node "${path.join(__dirname, 'marker.js')}"`;
  return homeCommand(`${path.basename(require(lib).claudeDir('/'))}/agent-skills/skills/tycon-pipeline/scripts/marker.js`);
})();

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
    // `/dev/null` entero: `/dev/nullx` o `/dev/null.md` son otro archivo
    if (!s.startsWith('/dev/null', j) || !/^(?:$|[\s;&|)])/.test(s.slice(j + '/dev/null'.length))) return true;
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
  const { segmentos } = require(path.join(RAIZ_DEL_ARNES, 'scripts', 'lib', 'command-tokens.js'));
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

// ── lo que corre a la vez en la misma sesión ─────────────────────────────────────────────────────────────────────────
const HERRAMIENTAS_QUE_EDITAN = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const VIDA_DEL_REGISTRO_MS = 10 * 60 * 1000;
const dirEnCurso = (stateDir) => path.join(photo.photosDir(stateDir), 'in-progress');
const archivoEnCurso = (stateDir, input) => path.join(dirEnCurso(stateDir), path.basename(archivoDeLaFoto(stateDir, input)));
/** La ruta con su carpeta real: el mismo archivo escrito como /var/… o /private/var/… da lo mismo. */
const rutaReal = (p) => path.join(realOrNull(path.dirname(p)) || path.dirname(p), path.basename(p));

/** Anota que una herramienta empezó (`extra`: lo que edita, o lo que nombra un comando que es sólo marker.js). */
function anotarInicio(stateDir, input, extra) {
  // stable-data: la hora de inicio, para ver qué corrió a la vez
  photo.writeWhole(archivoEnCurso(stateDir, input), JSON.stringify({ sesion: input.session_id || null, id: input.tool_use_id || null, tool: input.tool_name, inicio: Date.now(), fin: null, ...extra }));
}

const TOPE_DE_LA_CONVERSACION = 8 * 1024 * 1024;

/**
 * Las llamadas a herramientas de la conversación de la sesión, por su id: `Map<id, { name, input }>`, mirando la cola
 * del archivo (los últimos 8 MB) hasta `hasta`: el largo que tenía antes del comando. Las llamadas que corren a la vez
 * ya están escritas ahí (la herramienta escribe el mensaje entero antes de correrlas); lo que se agregó después lo pudo
 * escribir el comando mismo y no cuenta. Sin conversación legible, el mapa queda vacío.
 */
function llamadasDeLaConversacion(transcriptPath, ids, hasta) {
  const out = new Map();
  if (!transcriptPath || !ids.length || !(hasta > 0)) return out;
  let texto;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const tam = Math.min(fs.fstatSync(fd).size, hasta);
      const largo = Math.min(tam, TOPE_DE_LA_CONVERSACION);
      const buf = Buffer.alloc(largo);
      fs.readSync(fd, buf, 0, largo, tam - largo);
      texto = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (_) { return out; }
  // una llamada que ya tiene su resultado antes del comando terminó antes: no corrió a la vez, aunque un registro con su
  // id diga que sí (el comando lo pudo escribir con el id de una llamada vieja)
  const terminadas = new Set();
  for (const linea of texto.split('\n')) {
    if (!ids.some((id) => linea.includes(id))) continue;
    let o;
    try { o = JSON.parse(linea); } catch (_) { continue; }
    const contenido = o && o.message && Array.isArray(o.message.content) ? o.message.content : [];
    for (const c of contenido) {
      if (c && c.type === 'tool_use' && ids.includes(c.id)) out.set(c.id, { name: c.name, input: c.input || {} });
      if (c && c.type === 'tool_result' && ids.includes(c.tool_use_id)) terminadas.add(c.tool_use_id);
    }
  }
  for (const id of terminadas) out.delete(id);
  return out;
}

/**
 * Borra las fotos de los comandos de la sesión que ya terminaron (su registro tiene `fin`), menos la del comando que
 * empieza. El evento de después no borra su foto: un segundo evento del mismo comando la vuelve a comparar (después de
 * deshacer no encuentra nada) en vez de confiar en una marca de «ya mirado», que el comando podría escribir. Un `fin`
 * fabricado sólo adelanta el borrado, y sin foto el evento de después frena.
 */
function borrarFotosMiradas(stateDir, input) {
  const propia = path.basename(archivoDeLaFoto(stateDir, input));
  const prefijo = `${path.basename(propia).split('-')[0]}-`;
  let nombres = [];
  try { nombres = fs.readdirSync(photo.photosDir(stateDir)); } catch (_) { return; }
  for (const n of nombres) {
    if (n === propia || !n.startsWith(prefijo) || !n.endsWith('.json')) continue;
    let r = null;
    try { r = JSON.parse(fs.readFileSync(path.join(dirEnCurso(stateDir), n), 'utf8')); } catch (_) { continue; }
    if (r && typeof r.fin === 'number') { try { fs.rmSync(path.join(photo.photosDir(stateDir), n), { force: true }); } catch (_) { /* otra la borró */ } }
  }
}

function anotarFin(stateDir, input) {
  const f = archivoEnCurso(stateDir, input);
  try {
    const r = JSON.parse(fs.readFileSync(f, 'utf8'));
    r.fin = Date.now(); // stable-data: la hora de fin, para ver qué corrió a la vez
    photo.writeWhole(f, JSON.stringify(r));
  } catch (_) { /* sin registro de inicio: no hay nada que cerrar */ }
}

const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/**
 * Lo que corrió en la misma sesión mientras corría el comando, sin el comando mismo. Cuenta un registro que empezó
 * dentro de la ventana del comando (desde la foto), o uno anterior que terminó dentro de ella; uno abierto que empezó
 * antes es de una herramienta que no llegó a su evento de después (otro freno la negó) y no cuenta. Y cuenta sólo si la
 * conversación de la sesión trae esa llamada, con la misma herramienta y el mismo archivo: un registro que escribió el
 * comando mismo no está ahí.
 */
function aLaVez(stateDir, input, desde, largoDeLaConversacion) {
  const propio = path.basename(archivoEnCurso(stateDir, input));
  const ahora = Date.now(); // stable-data: el fin de la ventana del comando
  const candidatos = [];
  let nombres = [];
  try { nombres = fs.readdirSync(dirEnCurso(stateDir)); } catch (_) { return []; }
  for (const n of nombres) {
    const f = path.join(dirEnCurso(stateDir), n);
    let r;
    try { r = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { continue; }
    if (!r || typeof r !== 'object') continue;
    const viejo = (r.fin || r.inicio) && ahora - (r.fin || r.inicio) > VIDA_DEL_REGISTRO_MS;
    if (viejo) { try { fs.rmSync(f, { force: true }); } catch (_) { /* otra lo borró */ } continue; }
    if (n === propio || r.sesion !== (input.session_id || null) || typeof r.id !== 'string') continue;
    const empezoAdentro = typeof r.inicio === 'number' && r.inicio >= desde;
    const terminoAdentro = typeof r.fin === 'number' && r.fin >= desde;
    if (empezoAdentro || terminoAdentro) candidatos.push(r);
  }
  const llamadas = llamadasDeLaConversacion(input.transcript_path, candidatos.map((r) => r.id), largoDeLaConversacion);
  const cwd = input.cwd || process.cwd();
  return candidatos.filter((r) => {
    const l = llamadas.get(r.id);
    if (!l || l.name !== r.tool) return false;
    if (HERRAMIENTAS_QUE_EDITAN.includes(r.tool)) {
      const pedido = [l.input.file_path, l.input.notebook_path].filter((x) => typeof x === 'string').map(rutaReal);
      return strings(r.archivos).every((a) => pedido.includes(rutaReal(a)));
    }
    return String(l.input.command || '') === String(r.comando || '');
  // si es del orquestador y qué nombra salen del comando de la conversación, no del registro: el registro lo puede
  // escribir el comando
  }).map((r) => (HERRAMIENTAS_QUE_EDITAN.includes(r.tool) ? r
    : { ...r, ...lecturaDelComando(String(llamadas.get(r.id).input.command || ''), cwd, r.tool === 'PowerShell') }));
}

/** De un comando: si es sólo marker.js, y los archivos que nombra (lo dudoso por él es sólo eso). */
function lecturaDelComando(comando, cwd, powershell) {
  const reconocido = programas(comando, cwd, { powershell }).todosReconocidos;
  const nombra = reconocido ? String(comando).split(/\s+/).map((w) => w.replace(/^["']|["']$/g, '')).filter((w) => /[\\/.]/.test(w))
    .map((w) => path.resolve(cwd, expandirCasa(w))).filter((p) => fs.existsSync(p)) : [];
  return { reconocido, nombra };
}

// el corte de un marcador viejo, el mismo de marker.js y live-sessions.js
const MARCADOR_VIEJO_MS = 24 * 60 * 60 * 1000;

/**
 * ¿El marcador borrado era de una sesión viva? Por su `lastTouch` en la copia de la foto, con el corte de marker.js. Sin
 * copia o sin fecha legible, ante la duda, vivo: queda como dudoso y no se deshace.
 */
function marcadorVivo(stateDir, d) {
  try {
    const m = JSON.parse(photo.copyOf(stateDir, d.sha).toString('utf8'));
    const t = Date.parse(m && m.lastTouch);
    return !Number.isFinite(t) || Date.now() - t <= MARCADOR_VIEJO_MS; // stable-data: la edad del marcador borrado
  } catch (_) { return true; }
}

/** Las otras sesiones vivas en cada repo (las de live-sessions.js): `{ raíz: [ids] }`; una raíz que no se pudo mirar no está. */
function sesionesVivas(roots, input) {
  const out = {};
  const live = require(path.join(RAIZ_DEL_ARNES, 'scripts', 'lib', 'live-sessions.js'));
  for (const raiz of roots) {
    try {
      const r = live.others({ root: raiz, selfSessionId: input.session_id || '', selfTranscript: input.transcript_path || '', home: os.homedir(), sources: { subagents: false } });
      out[raiz] = r.sessions.map((s) => s.id);
    } catch (_) { /* sin saber, la raíz no da sesiones: se deshace */ }
  }
  return out;
}

/**
 * Separa las diferencias: las que escribió un Edit o un Write de la misma sesión sobre ese archivo mientras corría el
 * comando no cuentan; las dudosas no se deshacen y se avisan: con otra sesión viva en el repo desde antes del comando
 * (una que aparece durante el comando la pudo fabricar él), o con un comando de marker.js que nombra ese archivo
 * corriendo a la vez. El resto se deshace.
 */
function separar(foto, diferencias, input, stateDir) {
  const juntas = aLaVez(stateDir, input, foto.at, foto.conversacion);
  // el marcador propio de la sesión y el viejo `active.json`; el de otra sesión lo cierra esa sesión
  const marcadorPropio = (abs) => path.basename(abs) === 'active.json' || path.basename(abs) === `${String(input.session_id || '').replace(/[/\\]/g, '_')}.json`;
  const editados = new Set(juntas.filter((r) => HERRAMIENTAS_QUE_EDITAN.includes(r.tool)).flatMap((r) => strings(r.archivos)).map(rutaReal));
  const nombradosPorMarker = new Set(juntas.filter((r) => r.reconocido).flatMap((r) => strings(r.nombra)).map(rutaReal));
  const antes = foto.vivas || {};
  const ahora = Object.keys(antes).length ? sesionesVivas(Object.keys(antes), input) : {};
  const deshacer = [];
  const dudosas = [];
  for (const d of diferencias) {
    // una edición pedida en el mismo mensaje basta para esta excepción, aunque todavía no haya corrido: el comando pudo
    // escribir con su id. No se deshace, pero se anota y se avisa
    if (editados.has(rutaReal(d.abs))) { dudosas.push({ ...d, porque: 'una edición de esta sesión sobre ese archivo corría a la vez' }); continue; }
    if (d.kind === 'marker' && !marcadorPropio(d.abs) && marcadorVivo(stateDir, d)) { dudosas.push({ ...d, porque: 'es el marcador de otra sesión, que puede haber cerrado su ejecución' }); continue; }
    if (nombradosPorMarker.has(rutaReal(d.abs)) || (d.kind === 'marker' && juntas.some((r) => r.reconocido))) { dudosas.push({ ...d, porque: 'mientras corría, otro comando de esta sesión corría el del orquestador (marker.js) sobre ese archivo' }); continue; }
    const raiz = foto.roots.find((r) => d.abs.startsWith(r + path.sep));
    const otras = raiz ? strings(antes[raiz]).filter((id) => strings(ahora[raiz]).includes(id)) : [];
    if (otras.length) { dudosas.push({ ...d, porque: `otra sesión trabaja en el mismo repo (${otras.map((s) => s.slice(0, 8)).join(', ')})` }); continue; }
    deshacer.push(d);
  }
  return { deshacer, dudosas };
}

function mensaje(hechas, fallas, mezclado) {
  const rel = (abs) => abs.replace(os.homedir(), '~');
  const lineas = ['⛔ tycon-pipeline — LO QUE EL COMANDO ESCRIBIÓ SE DESHIZO', ''];
  for (const d of hechas) lineas.push(`  · ${rel(d.abs)}: ${d.que}; ${d.deshacer === 'borrar' ? 'lo borré' : 'volvió a lo que tenía'}`);
  for (const f of fallas) lineas.push(`  · ${rel(f.abs)}: no se pudo deshacer (${f.motivo})`);
  lineas.push('', 'Una historia que no está en borrador, el estado de un borrador, una constancia y los marcadores de la ejecución no se',
    'escriben desde un comando: desde la consola no se ve qué queda escrito. La historia se edita con la herramienta de',
    'edición y su estado lo cambia marker.js:',
    `  · ${MARCADOR} update-story-status <ruta de la historia> <estado>`);
  if (mezclado) lineas.push('', 'El comando mezclaba el del orquestador (marker.js) con otros programas: después de correr no se sabe cuál',
    'escribió cada cosa. Corré el del orquestador solo, sin otros programas en la misma línea.');
  return lineas.join('\n');
}

/** Una mirada que no se pudo hacer queda en hook-errors.log y se le dice al agente: callarla dejaría pasar lo escrito. */
const COMO_SE_LIBERA = (sid) => [
  'La libera otra sesión, nunca ésta: la coordinadora (si el perfil le delega la firma) o la persona en su terminal, después',
  'de mirar las historias y las constancias que pudo tocar el comando:',
  `  · ${MARCADOR} release-write-after --for-session ${sid || '<sesión>'} --reason "<qué miró>" [--terminal]`,
].join('\n');

/**
 * Pone el freno de la sesión y devuelve la frase que lo dice. Si no lo pudo anotar, lo dice así: afirmar que quedó
 * frenada sin estarlo dejaría pasar lo que siga. Una carpeta donde no se puede escribir frena igual (readBrake).
 */
function frenar(stateDir, input, motivo) {
  try { photo.setBrake(stateDir, input.session_id, motivo); } catch (e) {
    logHookError(stateDir, e);
    if (!photo.readBrake(stateDir, input.session_id)) {
      return `No pude anotar el freno de esta sesión (${e.code || e.message}): decíselo a la persona, que lo mire antes de seguir.`;
    }
  }
  return 'Esta sesión queda frenada: los comandos que pueden escribir no corren hasta que alguien lo mire.';
}

/**
 * Una mirada que no se pudo hacer queda en hook-errors.log, se le dice al agente y frena los comandos siguientes de la
 * sesión que pueden escribir: callarla dejaría pasar lo escrito, y romper la mirada a propósito no puede ser un escape.
 */
function noSePudoMirar(input, stateDir, motivo) {
  logHookError(stateDir, new Error(`no se pudo mirar: ${motivo}`));
  const frenada = frenar(stateDir, input, motivo);
  const texto = [`⛔ tycon-pipeline — no pude mirar qué escribió el comando en las historias y las constancias (${motivo}).`,
    frenada, COMO_SE_LIBERA(input.session_id)].join('\n');
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: texto } }) + '\n');
}

// lo que se puede correr con la sesión frenada: programas que sólo leen, sin redirecciones a archivos ni sustituciones.
// Ninguno ejecuta otro programa por una opción ni escribe un archivo que nombra (por eso no están `rg` ni `git grep`,
// que corren otro con `--pre` y `-O`; ni `less`, que corre el de LESSOPEN; ni `uniq`, que escribe su segundo archivo)
const LECTORES = new Set(['cat', 'head', 'tail', 'ls', 'grep', 'egrep', 'fgrep', 'wc', 'pwd', 'echo', 'printf', 'true', 'false',
  'test', '[', 'stat', 'file', 'diff', 'cmp', 'which', 'type', 'date', 'whoami', 'id', 'uname', 'basename', 'dirname', 'realpath',
  'readlink', 'jq', 'cut', 'tr', 'nl', 'od', 'cd']);
// `sort` sólo como filtro de una tubería: sin archivos y con estas opciones. `--compress-program` corre un programa,
// `-o` escribe, y en PowerShell un bloque `{ … }` es código
const SORT_OPCIONES = /^-[rnucfdi]+$|^-[kt]$|^-[kt].+$/;
// git sólo con lo que no lee la configuración del repo para correr un programa: `status` corre `core.fsmonitor`,
// `diff` y `show` el de `diff.external` o un `textconv`, `log` el de `gpg.program` con `log.showSignature`. La
// configuración se escribe con la herramienta de edición, que el freno de la sesión no alcanza
const GIT_LEE = new Set(['rev-parse']);
// las opciones de git que escriben un archivo o corren otro programa, en cualquier subcomando (git acepta un prefijo)
const GIT_OPCION_QUE_HACE = /^(?:-c|--config-env|--exec-path|--output|--ext-diff|-O|--open-files-in-pager|--textconv)(?:=|$)|^-[cO].|^--(?:ext|textc|out|open|exec|config)/;
// lo que el shell corre adentro de una palabra: aun entre comillas dobles, `$(…)` y los acentos graves corren
const SUSTITUCION = /\$\(|`|<\(|>\(|\$\{|@\(/;

/** ¿El comando sólo lee? Cada tramo corre un lector o `git` (con su `-C <carpeta>`) con un subcomando que lee. */
function soloLee(comando, { powershell = false } = {}) {
  if (redirigeAArchivo(comando) || SUSTITUCION.test(String(comando || ''))) return false;
  const { segmentos } = require(path.join(RAIZ_DEL_ARNES, 'scripts', 'lib', 'command-tokens.js'));
  return segmentos(String(comando || ''), { powershell }).every((seg) => {
    const p = seg[0];
    if (!p) return true;
    if (!p.esBandera) return false;
    if (LECTORES.has(p.texto)) return true;
    if (p.texto === 'sort') {
      const resto = seg.slice(1).map((x) => x.texto);
      for (let i = 0; i < resto.length; i += 1) {
        if (!SORT_OPCIONES.test(resto[i])) return false;
        if (/^-[kt]$/.test(resto[i])) i += 1; // el argumento de -k o -t
      }
      return true;
    }
    if (p.texto !== 'git') return false;
    const palabras = seg.slice(1).map((x) => x.texto);
    if (palabras.some((x) => GIT_OPCION_QUE_HACE.test(x))) return false;
    let i = 0;
    while (palabras[i] === '-C' || palabras[i] === '--no-pager') i += palabras[i] === '-C' ? 2 : 1;
    return GIT_LEE.has(palabras[i]);
  });
}

function despues(input, stateDir) {
  const archivo = archivoDeLaFoto(stateDir, input);
  let foto = null;
  try { foto = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') {
      // lo que sólo lee no escribe nada que mirar: corre sin foto cuando la carpeta no deja guardarla
      if (soloLee(String((input.tool_input || {}).command || ''), { powershell: input.tool_name === 'PowerShell' })) return;
      // sin foto frena siempre: ninguna marca en disco de «ya lo miré» vale, porque el comando la puede escribir. El
      // costo es un evento de después sin el de antes (la pieza prendida a mitad de un comando)
      noSePudoMirar(input, stateDir, 'la foto de antes del comando no está');
      return;
    }
    noSePudoMirar(input, stateDir, `la foto de antes no se puede leer (${e.code || e.message})`);
    return;
  }
  // la foto queda: la borra el evento de antes del comando siguiente de la sesión (borrarFotosMiradas), y la limpieza
  if (foto && foto.fallo) { noSePudoMirar(input, stateDir, `no pude sacar la foto antes del comando (${foto.fallo})`); return; }
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
  const { deshacer, dudosas } = separar(foto, diferencias, input, stateDir);
  if (!deshacer.length && !dudosas.length) return;
  const { hechas, fallas } = photo.undo(foto, deshacer, { stateDir });
  const ts = new Date().toISOString(); // stable-data: la hora del renglón del registro
  const programa = comando.replace(/\s+/g, ' ').slice(0, 160);
  const renglon = (name, status, d) => `${JSON.stringify({ ts, name, status, sesion: input.session_id || null, archivo: d.abs, que: d.que, programa, ...(d.porque ? { porque: d.porque } : {}) })}\n`;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    for (const d of hechas) fs.appendFileSync(path.join(stateDir, 'gates.log'), renglon('escritura-vista-despues', 'undone', d));
    for (const d of dudosas) fs.appendFileSync(path.join(stateDir, 'gates.log'), renglon('escritura-dudosa', 'kept', d));
  } catch (e) { logHookError(stateDir, e); }
  for (const f of fallas) logHookError(stateDir, new Error(`no se pudo deshacer ${f.abs}: ${f.motivo}`));
  // lo que no se pudo deshacer quedó escrito: la sesión se frena hasta que alguien lo mire
  const frenada = fallas.length ? frenar(stateDir, input, `no se pudo deshacer ${fallas.map((f) => f.abs).join(', ')}`) : '';
  const partes = [];
  if (hechas.length || fallas.length) partes.push(mensaje(hechas, fallas, prog.algunoReconocido));
  if (fallas.length) partes.push(`${frenada}\n${COMO_SE_LIBERA(input.session_id)}`);
  if (dudosas.length) partes.push(mensajeDudosas(dudosas));
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: partes.join('\n\n') } }) + '\n');
}

function mensajeDudosas(dudosas) {
  const rel = (abs) => abs.replace(os.homedir(), '~');
  return ['⚠️ tycon-pipeline — EL COMANDO CAMBIÓ LO PROTEGIDO Y NO LO DESHICE', '',
    ...dudosas.map((d) => `  · ${rel(d.abs)}: ${d.que}; no lo deshice porque ${d.porque}`),
    '', 'Puede ser un cambio legítimo de otra sesión o de marker.js. Revisalo y decíselo a la persona: si no correspondía,',
    'se vuelve atrás con la herramienta de edición o con marker.js.'].join('\n');
}

function main() {
  const stateDir = stateDirOf(os.homedir());
  try {
    if (String(process.env.TYCON_STORY_GATE || '').toLowerCase() === 'off') return;
    const input = leerEntrada();
    if (!input) return;
    const ti = input.tool_input || {};
    if (HERRAMIENTAS_QUE_EDITAN.includes(input.tool_name)) {
      // un Edit o un Write a la vez que un comando: lo que escriben no lo deshace la mirada del comando
      if (input.hook_event_name === 'PreToolUse') anotarInicio(stateDir, input, { archivos: [ti.file_path, ti.notebook_path].filter(Boolean) });
      else if (EVENTOS_DE_DESPUES.includes(input.hook_event_name)) anotarFin(stateDir, input);
      return;
    }
    // un comando de consola llega con el nombre de la herramienta que lo corre (Bash, PowerShell, Monitor…): se mira por
    // lo que trae, no por el nombre. Filtrar por el nombre deja afuera a la que no está en la lista
    if (typeof ti.command !== 'string') return;
    const comando = ti.command;
    const cwd = input.cwd || process.cwd();
    if (input.hook_event_name === 'PreToolUse') {
      const powershell = input.tool_name === 'PowerShell';
      // una sesión frenada por una mirada fallida sólo corre lo que lee
      const freno = photo.readBrake(stateDir, input.session_id);
      const lee = soloLee(comando, { powershell });
      if (freno && !lee) {
        // una carpeta del estado donde no se puede escribir no se libera con una firma: se arregla la carpeta
        const comoSale = freno.carpeta
          ? `Hay que arreglar los permisos (o el espacio) de ${freno.carpeta}; mientras no se pueda escribir ahí, ningún comando que escribe corre, en ninguna sesión. Decíselo a la persona.`
          : COMO_SE_LIBERA(input.session_id);
        process.stderr.write([`⛔ tycon-pipeline — ESTA SESIÓN ESTÁ FRENADA: no se pudo mirar lo que escribió un comando anterior (${freno.motivo}).`,
          'Mientras tanto corren sólo los comandos que leen (cat, grep, head, ls, diff, git rev-parse…); git status, diff, log y ls-files no:',
          'pueden correr un programa de la configuración del repo.', comoSale].join('\n') + '\n');
        process.exitCode = 2;
        return;
      }
      let foto;
      try {
        const roots = reposDelComando(cwd, comando);
        // el largo de la conversación antes del comando: lo que se agregue después pudo escribirlo él
        let conversacion = 0;
        try { conversacion = input.transcript_path ? fs.statSync(input.transcript_path).size : 0; } catch (_) { conversacion = 0; }
        foto = photo.takePhoto({ roots, stateDir, extra: { vivas: sesionesVivas(roots, input), conversacion } });
      } catch (e) {
        // sin foto no hay contra qué comparar: el evento de después lo dice y frena
        logHookError(stateDir, e);
        foto = { fallo: (e && e.message) || String(e) };
      }
      // sin poder anotar el inicio o guardar la foto, el comando no corre: el evento de después no tendría contra qué
      // comparar ni dónde dejar el freno (un `chmod` sobre la carpeta, un disco lleno)
      try {
        anotarInicio(stateDir, input, { comando });
        photo.writeWhole(archivoDeLaFoto(stateDir, input), JSON.stringify(foto));
      } catch (e) {
        logHookError(stateDir, e);
        // lo que sólo lee no necesita foto: no escribe nada que mirar
        if (lee) return;
        process.stderr.write(`⛔ tycon-pipeline — no puedo guardar la foto de antes del comando (${e.code || e.message}): sin ella no se mira lo que escriba, y no lo dejo correr.\n` +
          `La carpeta es ${photo.photosDir(stateDir)}: decíselo a la persona.\n`);
        process.exitCode = 2;
      }
      try { borrarFotosMiradas(stateDir, input); } catch (e) { logHookError(stateDir, e); }
      return;
    }
    if (EVENTOS_DE_DESPUES.includes(input.hook_event_name)) {
      try { despues(input, stateDir); } catch (e) { noSePudoMirar(input, stateDir, (e && e.message) || String(e)); }
      anotarFin(stateDir, input);
    }
  } catch (e) { logHookError(stateDir, e); }
}

if (require.main === module) main();
module.exports = { programas, reposDelComando, redirigeAArchivo, soloLee };
