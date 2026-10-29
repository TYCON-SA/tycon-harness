#!/usr/bin/env node
'use strict';
/**
 * session-collision-guard.js — dos sesiones sobre el MISMO checkout no tocan git a la vez.
 *
 * ── EL CASO QUE CUBRE ────────────────────────────────────────────────────────────────
 * Dos sesiones de chat trabajan en el mismo clon. Una hace `git add <sus archivos>` + `git commit`, y el commit se
 * lleva una DELECIÓN que la otra dejó en el índice. Si la otra ya commiteó encima, un `--amend` cae sobre el commit
 * ajeno. Si la otra cambia de rama (`checkout -b story/...`), el siguiente commit de la primera cae en ESA rama, no
 * en main. Nada da error: git hace exactamente lo que se le pide, sobre un estado que otra sesión está cambiando.
 *
 * ── POR QUÉ UN FRENO Y NO UNA REGLA ─────────────────────────────────────────────────────────────
 * Ninguna sesión sabe de la otra ni puede saberlo: cada chat arranca sin historia de los demás, y
 * aunque la tuviera, la otra se sigue moviendo. Un control que depende de que alguien se acuerde es
 * un control que no corre. Éste mira el DISCO en el momento de tocar git: cada sesión de Claude Code
 * deja su transcripción en `~/.claude/projects/<carpeta-del-cwd>/<session>.jsonl`, y su mtime dice
 * si está viva. Si hay otra con actividad reciente sobre este mismo repo, se frena (exit 2) y se
 * nombra: quién, hace cuánto, y qué pidió su último prompt.
 *
 * ── QUÉ FRENA Y QUÉ NO ──────────────────────────────────────────────────────────────────────────
 * Frena lo que cambia el índice, el árbol o la rama: commit, checkout, switch, rebase, stash,
 * reset, merge, cherry-pick, pull, revert. Deja pasar la lectura (status, log, diff, show, fetch)
 * y el push (no toca el árbol; el hook de trabajo-sin-subir ya lo mira).
 * NO propone worktree en el arnés ni agent-skills: ahí está prohibido a propósito
 * (guides/git-worktrees.md) — en esos dos, una sola sesión toca git a la vez.
 *
 * Modo SessionStart (mismo script, se distingue por hook_event_name): avisa al abrir una sesión en
 * una carpeta donde ya hay otra viva. Avisa, no frena: abrir no rompe nada; tocar git sí.
 *
 * El freno es sobre el repo DESTINO de cada git que escribe —su `-C`, o el `cd` que lo precede en la
 * cadena, con las variables definidas en el mismo comando—, no sobre el repo de la sesión: un comando
 * sobre otro repo no "ve" las sesiones de éste (ver "qué repo toca…").
 *
 * Escape puntual: `TYCON_SESSION_GUARD_OK=1 git ...` como prefijo pegado al comando — deja
 * constancia en stderr y en ~/.claude/.tycon-pipeline/bypass.log. Ventana: TYCON_SESSION_GUARD_MIN
 * (3 minutos). Off: TYCON_SESSION_GUARD=0. Fail-open ante todo lo que no pueda leer.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
// La carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: este
// archivo viaja suelto (al banco, a laboratorios de pruebas); ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const { spawnSync } = require('child_process');

const TAG = '[session-guard]';
// 🔴 La ventana es de 3 minutos: la señal es la fecha de la transcripción de la otra sesión, y una sesión CERRADA
// deja su archivo igual de fresco que una viva. Con una ventana larga, abrir otra ventana, escribir «hola» y cerrarla
// frenaría el commit propio durante todo ese rato, y un freno que molesta sin motivo se apaga. Tres minutos siguen
// cubriendo dos sesiones trabajando a la vez (escriben todo el tiempo) y acortan la cola de las cerradas. La señal
// exacta —¿hay un proceso de Claude Code con ese repo abierto?— distinguiría viva de cerrada sin depender del reloj.
const VENTANA_MS = (Number(process.env.TYCON_SESSION_GUARD_MIN) || 3) * 60 * 1000;
// Repos donde el worktree está PROHIBIDO (guides/git-worktrees.md): el consejo cambia.
// (los dos nombres del arnés, el interno y el público, como segmento de ruta. Escritos acá: el banco
// copia este hook suelto a un árbol de juguete — reconocedor declarado en scripts/tests/fixtures/harness-place-names.json)
const SIN_WORKTREE = /(^|\/)(tycon-claude-guides|tycon-harness|agent-skills)$/;
// git que cambia índice / árbol / rama. `merge-base`, `stash list`, `commit-tree` no cuentan.
const GIT_ESCRIBE = /\bgit\b(?:\s+(?:-[Cc]\s+(?:[^\s-]\S*|-(?=\s))|-[\w-]+(?:=\S*)?))*\s+(commit|checkout|switch|rebase|stash(?!\s+(?:list|show))|reset|merge(?!-)|cherry-pick|pull|revert)(?!-)\b/;

if (process.env.TYCON_SESSION_GUARD === '0') process.exit(0);

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
let payload;
try { payload = JSON.parse(raw); } catch { process.exit(0); }
if (!payload || typeof payload !== 'object') process.exit(0);

const evento = payload.hook_event_name || 'PreToolUse';
const cwd = payload.cwd || process.cwd();
const sessionId = String(payload.session_id || '');
const transcriptPath = payload.transcript_path ? String(payload.transcript_path) : '';

// ── dónde están las otras sesiones ───────────────────────────────────────────────────────────────

const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
// Claude Code nombra la carpeta con la ruta del cwd cambiando los separadores por `-`; se prueban
// las dos variantes (con y sin los puntos cambiados) para no depender de ese detalle.
const encode = (p) => [p.replace(/[\/\\:]/g, '-'), p.replace(/[\/\\:.]/g, '-')];

function raizDelRepo(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? (r.stdout || '').trim() : null;
}

// El repo de la SESIÓN (donde arrancó el chat). Las sesiones vivas se buscan por el repo DESTINO del
// comando; el cwd de la sesión entra en las claves SÓLO si el destino es su propio repo — si no, un
// comando sobre otro repo "vería" las sesiones de éste (un falso positivo).
let _raizSesion;
const raizDeLaSesion = () => (_raizSesion === undefined ? (_raizSesion = raizDelRepo(cwd)) : _raizSesion);
const esElRepoDeLaSesion = (raiz) => { const r = raizDeLaSesion(); return !!r && real(r) === real(raiz); };
// La carpeta lleva el cwd TAL COMO LO VE la sesión (en macOS /var/... y no /private/var/...), y
// `git rev-parse --show-toplevel` devuelve la ruta real: se prueban las dos.
// `extras`: los directorios tal como los ESCRIBIÓ el comando y que resolvieron a este repo. La carpeta de
// transcripciones lleva el cwd como lo ve la sesión (/var/… en macOS) y `rev-parse` devuelve la ruta
// real (/private/var/…): sin el "tal como se escribió", el repo destino no encontraba sus sesiones.
const rutasDe = (raiz, extras = []) => {
  const out = [raiz, real(raiz)];
  for (const d of extras) {
    if (!d) continue;
    out.push(d, real(d));
    const rd = real(d), rr = real(raiz);   // la raíz "tal como se escribió": lo escrito menos el sobrante
    if (rd.startsWith(rr) && rd.length > rr.length) out.push(d.slice(0, d.length - (rd.length - rr.length)));
  }
  if (esElRepoDeLaSesion(raiz)) out.push(cwd, real(cwd));
  return [...new Set(out)];
};
const clavesDe = (raiz, extras) => [...new Set(rutasDe(raiz, extras).flatMap(encode))];

/** Carpeta de transcripciones de Claude Code para un repo (y las de sus subcarpetas). */
function carpetasDeSesiones(raiz, extras) {
  const base = path.join(os.homedir(), '.claude', 'projects');
  const claves = new Set(clavesDe(raiz, extras));
  let dirs = [];
  try { dirs = fs.readdirSync(base); } catch { return []; }
  const out = [];
  for (const d of dirs) {
    for (const k of claves) if (d === k || d.startsWith(k + '-')) { out.push(path.join(base, d)); break; }
  }
  // Codex y otras herramientas no ordenan por cwd: la carpeta de la PROPIA transcripción es la
  // pista, y se filtra por cwd leyendo el arranque de cada archivo (mejor esfuerzo).
  if (transcriptPath && !transcriptPath.startsWith(base + path.sep)) out.push(path.dirname(transcriptPath));
  return [...new Set(out)];
}

function ultimoPedido(archivo) {
  try {
    const st = fs.statSync(archivo);
    const fd = fs.openSync(archivo, 'r');
    const len = Math.min(st.size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const lineas = buf.toString('utf8').split('\n');
    for (let i = lineas.length - 1; i >= 0; i--) {
      let d; try { d = JSON.parse(lineas[i]); } catch { continue; }
      if (d.type !== 'user') continue;
      const c = d.message && d.message.content;
      const textos = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text) : [];
      const t = textos.find((x) => typeof x === 'string' && x.trim() && !x.trim().startsWith('<'));
      if (t) return t.trim().replace(/\s+/g, ' ').slice(0, 90);
    }
  } catch { /* sin pedido legible */ }
  return null;
}

/** ¿El archivo (de una carpeta que mezcla cwds) pertenece a este repo? */
function esDeEsteRepo(archivo, raiz, claves, extras) {
  try {
    const fd = fs.openSync(archivo, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    fs.closeSync(fd);
    const cab = buf.toString('utf8', 0, n);
    return rutasDe(raiz, extras).some((r) => cab.includes(`"cwd":"${r}`)) || claves.some((k) => cab.includes(k));
  } catch { return false; }
}

function sesionesVivas(raiz, ahora, extras = []) {
  const vivas = [];
  const base = path.join(os.homedir(), '.claude', 'projects');
  const claves = clavesDe(raiz, extras);
  for (const dir of carpetasDeSesiones(raiz, extras)) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    const mezclada = !dir.startsWith(base + path.sep);
    for (const f of files) {
      const p = path.join(dir, f);
      const id = f.replace(/\.jsonl$/, '');
      if (id === sessionId || (transcriptPath && real(p) === real(transcriptPath))) continue;   // la propia no cuenta
      let st; try { st = fs.statSync(p); } catch { continue; }
      const edadMs = ahora - st.mtimeMs;
      if (edadMs > VENTANA_MS) continue;
      if (mezclada && !esDeEsteRepo(p, raiz, claves, extras)) continue;
      vivas.push({ id, min: Math.max(0, Math.round(edadMs / 60000)), pedido: ultimoPedido(p) });
    }
  }
  return vivas.sort((a, b) => a.min - b.min);
}

function constancia(texto, comando) {
  console.error(`${TAG} ${texto}`);
  try {
    const dir = path.join(stateDirOf(os.homedir()));
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'bypass.log'),
      JSON.stringify({ ts: new Date().toISOString(), type: 'SESSION_GUARD_OK', command: String(comando).slice(0, 500) }) + '\n');
  } catch { /* la constancia en stderr ya salió */ }
}

const lista = (vivas) => vivas.map((v) => `   · sesión ${v.id.slice(0, 8)} — hace ${v.min} min${v.pedido ? ` — último pedido: «${v.pedido}»` : ''}`).join('\n');
const consejo = (raiz) => SIN_WORKTREE.test(raiz)
  ? `En ${path.basename(raiz)} el worktree está prohibido a propósito: acá UNA sola sesión toca git a la vez. Coordiná con la otra (o cerrala) antes de seguir.`
  : `Coordiná con esa sesión, o trabajá en un worktree propio: scripts/tools/tycon-worktree.sh (guides/git-worktrees.md).`;

// ── SessionStart: aviso ──────────────────────────────────────────────────────────────────────────

if (evento === 'SessionStart') {
  const raiz = raizDelRepo(cwd);
  if (!raiz) process.exit(0);
  const vivas = sesionesVivas(raiz, Date.now());
  if (!vivas.length) process.exit(0);
  console.log(`⚠️ session-guard: ya hay ${vivas.length} otra(s) sesión(es) viva(s) sobre este mismo checkout (${raiz}):\n${lista(vivas)}\n   ${consejo(raiz)} Si vas a tocar git (commit, checkout, rebase, stash…) este freno te va a parar.`);
  process.exit(0);
}

// ── PreToolUse Bash|PowerShell: freno ───────────────────────────────────────────────────────────
// En Windows Claude Code corre los comandos con su herramienta PowerShell: misma entrada
// (tool_input.command), otro tool_name (ver safety-guard-pre.sh).

if (evento !== 'PreToolUse' || !['Bash', 'PowerShell'].includes(payload.tool_name)) process.exit(0);
const cmd = payload.tool_input && payload.tool_input.command;
if (typeof cmd !== 'string' || !GIT_ESCRIBE.test(cmd)) process.exit(0);

// ── qué repo toca cada git que escribe ───────────────────────────────────────────────────────────
//
// 🔴 EL FALSO POSITIVO QUE EVITA. Una sesión que trabaja en un CLON descartable, precisamente para NO tocar el
// checkout compartido (que tiene sesiones vivas), no debe frenarse. Tres causas lo provocarían: (1) `cd "$D" || exit 9` no contaba como `cd`
// (sólo se aceptaban `&&` y `;`); (2) `$D` no se resolvía, y un destino irresoluble caía en "no es
// un repo" → exit 0 — o sea que el mismo defecto era un AGUJERO en la otra dirección: `git -C "$VAR"
// commit` sobre ESTE checkout pasaba sin mirar; (3) aun con el destino bien resuelto, las sesiones
// se buscaban con el cwd de LA SESIÓN entre las claves, así que cualquier repo destino "veía" las
// sesiones de este checkout. La regla correcta es sobre el repo DESTINO: se resuelve cada git que
// escribe —su `-C`, o el `cd` que lo precede en la cadena, con las variables definidas en el mismo
// comando— y se buscan las sesiones vivas de ESE repo. Lo que no se puede resolver se asume que es
// el checkout de la sesión: fail-closed hacia el repo que el freno existe para proteger, con el
// escape de siempre. Casos: 38-session-collision-guard.json (los seis últimos).
// 🔴 EL CRITERIO VIVE EN UN SOLO LADO: seguir el `cd` de la cadena y el `-C` del git, expandiendo las variables que
// el propio comando define, está en `scripts/lib/git-target.js`, porque `retro-pending.js` lo necesita igual (anota
// los push contra el repo al que se empujó, no contra el de la sesión). Dos copias de este criterio divergen. El
// regex de los verbos se genera del mismo constructor.
const destinoGit = require(path.join(__dirname, '..', 'lib', 'git-target.js'));
const GIT_QUE_ESCRIBE = destinoGit.regexDeGit(destinoGit.VERBOS_QUE_ESCRIBEN);
/**
 * Donde corre el comando si no dice otra cosa. La herramienta ejecuta en el cwd de SU shell, que
 * conserva el `cd` de un comando anterior, y el hook lo hereda como process.cwd(); el cwd del payload
 * es el de la sesión. Si difieren y el del shell es un repo, manda el del shell: ahí va a correr el
 * git. Si son iguales (lo normal) no cambia nada.
 */
function baseDelComando() {
  const shell = process.cwd();
  if (shell && real(shell) !== real(cwd) && raizDelRepo(shell)) return shell;
  return cwd;
}
const base = baseDelComando();
let destinos = destinoGit.destinos(cmd, base, GIT_QUE_ESCRIBE);
// El filtro grueso vio un git que escribe pero el análisis por sentencia no lo ubicó (p. ej. dentro
// de un `sh -c "…"`): se asume el checkout de la sesión, como siempre.
if (!destinos.length) destinos = [{ dir: base, op: (cmd.match(GIT_ESCRIBE) || [])[1] || 'git', resuelto: true }];

const ahora = Date.now();
const porRepo = new Map();
for (const d of destinos) {
  const raiz = raizDelRepo(d.dir);
  if (!raiz) continue;                                  // no es un repo: git va a fallar solo
  const k = real(raiz);
  if (!porRepo.has(k)) porRepo.set(k, { raiz, dirs: new Set(), ops: new Set(), irresuelto: false });
  const e = porRepo.get(k); e.dirs.add(d.dir); e.ops.add(d.op); if (!d.resuelto) e.irresuelto = true;
}
for (const e of porRepo.values()) e.vivas = sesionesVivas(e.raiz, ahora, [...e.dirs]);
const frenos = [...porRepo.values()].filter((e) => e.vivas.length);
if (!frenos.length) process.exit(0);

if (/(^|[;&|]\s*)TYCON_SESSION_GUARD_OK=1\s/.test(cmd)) {
  constancia(`TYCON_SESSION_GUARD_OK=1: dejo tocar git con otra(s) sesión(es) viva(s) en ${frenos.map((e) => `${path.basename(e.raiz)} (${e.vivas.length})`).join(', ')}. Queda dicho.`, cmd);
  process.exit(0);
}

const bloques = frenos.map((e) => `Hay OTRA sesión viva sobre el checkout que este comando toca (${e.raiz}) — \`git ${[...e.ops].join('`, `git ')}\`:
${lista(e.vivas)}${e.irresuelto ? '\n   (el destino de ese git no se pudo resolver desde el texto —una variable que el comando no define—: se asume que es este checkout)' : ''}`).join('\n\n');
const op = [...frenos[0].ops][0];
console.error(`🔴 ${TAG} ${bloques}

   Un ${op} ahí cambia el índice, el árbol o la rama que la otra sesión está usando. Caso real del
   2026-09-05 en este arnés: un commit arrastró una deleción ajena que estaba en el índice, el amend
   cayó sobre el commit de la otra sesión, y el commit siguiente cayó en su rama de story. Sin un
   solo error de git.

   ${consejo(frenos[0].raiz)}
   Si es a propósito y está coordinado con la otra sesión, seguir igual lo decide la persona, no el agente: no le
   dictes cómo. Si pregunta cómo seguir, señalale la guía (guides/git-worktrees.md).
   Ventana: ${Math.round(VENTANA_MS / 60000)} min sin actividad de la otra sesión libera el freno.`);
process.exit(2);
