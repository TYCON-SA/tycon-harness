'use strict';
/**
 * result-travel.js — cómo viajan los resultados de la noche que produce una máquina: el examen de revisores, los casos de
 * guía y la revisión semanal. Casos: scripts/tests/result-travel.test.js.
 *
 * POR QUÉ ES ASÍ. La máquina no puede empujar a `main` del repo de mantenimiento: tiene validaciones obligatorias y sólo
 * el servicio de compilación las saltea. Entonces cada resultado va como una ENTRADA a la rama `night-results`, y un
 * nocturno (scripts/ci/carry-night-results.js) la lleva a `main` por el camino de siempre (scripts/ci/push-nightly-data.js).
 *
 * EL CLON NO SE TOCA. La publicación lee `origin/main` del clon (un `fetch` que mueve sólo esa referencia) y su URL, y
 * nada más: el commit se arma con un índice temporal en un repo desnudo propio, en la carpeta de estado, y se empuja
 * desde ahí. Ni el HEAD, ni el índice, ni el árbol del clon cambian. El repo desnudo tampoco tiene árbol: un gancho de
 * `pre-push` que trabaja en la raíz del repo que empuja (el de la memoria, `.engram-project`) no encuentra ninguna.
 *
 * LA ENTRADA. `runs/<id>/entry.json` y `runs/<id>/files/<ruta>`, sin historia común con `main`. Cada entrada vive en su
 * carpeta y nunca se reescribe: dos noches o dos piezas no se pisan. Si el empuje se rechaza (otra entrada llegó antes),
 * se relee la punta y se rehace el commit encima, hasta 3 veces.
 *
 * LO GUARDADO. El resultado se guarda primero en `<estado>/result-travel/<pieza>/<ruta>`, pase lo que pase con el empuje:
 * ahí queda si no viaja. No se republica solo: la próxima corrida de la pieza publica el suyo.
 *
 * EL ESTADO. `<estado>/result-travel/status.json`, por pieza: si publicó o no, cuándo, el motivo y la entrada. Lo lee el
 * aviso del arranque (scripts/hooks/bench-notice.js): un empuje fallido no queda sólo en el registro.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// La carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: los laboratorios
// copian carpetas sueltas de scripts/; ahí vale la ruta de siempre, que es la misma.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();

const BRANCH = 'night-results';
const CARRIED = '.dashboard/night-results/carried.json';
const PATHS = Object.freeze({
  exam: 'scripts/controls-bench/ultimo-examen.json',
  guides: 'scripts/controls-bench/ultimo-guias.json',
  report: '.dashboard/weekly-review/latest.json',
  proposals: 'guides/guide-update-proposals.md',
});
// Las únicas rutas que viajan, con su pieza, su modo y cómo se reconoce un resultado de verdad. Lo usa también el nocturno
// para rechazar lo que no tiene esa forma: cualquiera con permiso de escritura puede empujar a la rama.
const ALLOWED = Object.freeze({
  [PATHS.exam]: { piece: 'exam', mode: 'replace', kind: 'examen-periodico', date: 'ts' },
  [PATHS.guides]: { piece: 'guides', mode: 'replace', kind: 'casos-de-guia', date: 'ts' },
  [PATHS.report]: { piece: 'weekly', mode: 'replace', schema: 1, date: 'hecho' },
  [PATHS.proposals]: { piece: 'weekly', mode: 'append' },
});
const PIECES = Object.freeze({ exam: 'el examen de revisores', guides: 'los casos de guía', weekly: 'la revisión semanal' });
const ATTEMPTS = 3;
// 🔴 tope de tiempo y sin preguntas: bajo launchd nadie contesta un pedido de contraseña, y un git colgado deja el
// disparador ocupado para siempre. Colgar es peor que fallar.
const GIT_TIMEOUT_MS = 120000;
const SECTION_HEAD = /^## Revisión semanal (\d{4}-\d{2}-\d{2}) — /;
const MARKER = /<!-- revision-semanal:(\d{4}-\d{2}-\d{2}):(\d+) -->/;

const rootDir = (home) => path.join(stateDirOf(home || os.homedir()), 'result-travel');
const keptPath = (piece, rel, home) => path.join(rootDir(home), piece, ...rel.split('/'));
const statusFile = (home) => path.join(rootDir(home), 'status.json');

/** Un motivo para mostrar al arrancar: una línea, sin claves de una URL ni caracteres de control. */
function clean(text) {
  let s = String(text === undefined || text === null ? '' : text);
  try {
    const { redact, clean: oneLine } = require(path.join(__dirname, 'maintainers-sync.js'));
    s = oneLine(redact(s), 300);
  } catch (_) {
    s = (s.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '').replace(/(\w+:\/\/)[^/@\s]*@/g, '$1').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').slice(0, 300);
  }
  return s;
}

function git(dir, args, { env, input } = {}) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', input, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(env || {}) } });
  const timedOut = Boolean(r.error && r.error.code === 'ETIMEDOUT');
  return { ok: r.status === 0, status: r.status, raw: String(r.stdout || ''), out: String(r.stdout || '').trim(),
    err: String(r.stderr || (r.error && r.error.message) || '').trim(), timedOut };
}
/** El porqué de un git que falló: la primera línea, que es la que dice qué pasó. */
const why = (r, what) => `${what}: ${r.timedOut ? 'se pasó de los 2 minutos' : (r.err.split('\n').map((l) => l.trim()).find(Boolean) || `salió ${r.status}`)}`;

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);   // el aviso puede estar leyéndolo justo ahora
  } finally { fs.rmSync(tmp, { force: true }); }
}

/** El estado de las piezas: `{ state: 'ok' | 'missing' | 'unreadable', pieces, path, why }`. */
function readStatus(home) {
  const file = statusFile(home);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    return e && e.code === 'ENOENT' ? { state: 'missing', pieces: {}, path: file } : { state: 'unreadable', pieces: {}, path: file, why: (e && e.code) || String(e) };
  }
  try {
    const d = JSON.parse(text);
    if (!d || typeof d !== 'object' || Array.isArray(d)) return { state: 'unreadable', pieces: {}, path: file, why: 'no es un objeto' };
    return { state: 'ok', pieces: d, path: file };
  } catch (e) { return { state: 'unreadable', pieces: {}, path: file, why: 'no es JSON' }; }
}
function writeStatus(piece, value, home) {
  const st = readStatus(home);
  // un estado ilegible se reemplaza: lo que diga de las otras piezas ya no se puede leer, y esta pieza sí sabe lo suyo
  writeAtomic(statusFile(home), `${JSON.stringify({ ...st.pieces, [piece]: value }, null, 2)}\n`);
}
function recordFailure(piece, motivo, home) {
  writeStatus(piece, { ok: false, at: new Date().toISOString(), motivo: clean(motivo) }, home);
}

/** Borra los temporales de procesos que ya no existen: una corrida cortada no los deja para siempre. */
function cleanLeftovers(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return; }
  for (const name of names) {
    const m = /^(\d+)-/.exec(name);
    if (!m) continue;
    let alive = true;
    try { process.kill(Number(m[1]), 0); } catch (e) { alive = Boolean(e && e.code === 'EPERM'); }
    if (!alive) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

/** Trae `main` del remoto al clon: mueve sólo `refs/remotes/origin/main`. */
function fetchMain(repo) {
  const r = git(repo, ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  return r.ok ? { ok: true } : { ok: false, motivo: why(r, 'no pude traer main') };
}
/** Un archivo de `origin/main` del clon: `{ state: 'ok' | 'missing' | 'error', text, motivo }`. */
function readMain(repo, rel) {
  const ls = git(repo, ['ls-tree', 'refs/remotes/origin/main', '--', rel]);
  if (!ls.ok) return { state: 'error', text: null, motivo: why(ls, 'no pude listar main') };
  if (!ls.out) return { state: 'missing', text: null };
  const show = git(repo, ['show', `refs/remotes/origin/main:${rel}`]);
  return show.ok ? { state: 'ok', text: show.raw } : { state: 'error', text: null, motivo: why(show, 'no pude leer main') };
}

/**
 * Las secciones de la revisión semanal de un texto: `[{ date, n, marker, text }]`. Lo que no es una sección, afuera. Una
 * sección abre en un encabezado seguido de su marca: una línea con forma de encabezado dentro del texto de una propuesta
 * no la parte.
 */
function sectionsOf(text) {
  const out = [];
  let cur = null;
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  lines.forEach((line, i) => {
    const opens = SECTION_HEAD.test(line) && (!cur || MARKER.test(lines[i + 1] || ''));
    if (opens) { if (cur) out.push(cur); cur = { lines: [line] }; } else if (cur) cur.lines.push(line);
  });
  if (cur) out.push(cur);
  return out.map((s) => {
    const body = `${s.lines.join('\n').replace(/\s*$/, '')}\n`;
    const m = MARKER.exec(s.lines[1] || '');
    return { date: SECTION_HEAD.exec(s.lines[0])[1], n: m ? Number(m[2]) : null, marker: m ? m[0] : null, text: body };
  });
}

/**
 * Publica el resultado de una pieza: `files` es `[{ path, mode, source | text }]`. Lo guarda en la carpeta de estado,
 * deja afuera lo que `origin/main` ya tiene igual, y empuja una entrada a `night-results`. Anota el estado de la pieza
 * siempre. → `{ ok, motivo, entry }` (`entry: null` = no había nada distinto de main: cuenta como publicado).
 */
function publish({ repo, piece, files, message, home, log = () => {} }) {
  const fail = (motivo) => {
    const m = clean(motivo);
    try { recordFailure(piece, m, home); } catch (e) { log(`no pude anotar el fallo en ${statusFile(home)}: ${e.message}`); }
    return { ok: false, motivo: m };
  };
  const root = rootDir(home);
  const tmpDir = path.join(root, 'tmp');
  try {
    if (!PIECES[piece]) throw new Error(`pieza desconocida: ${piece}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    cleanLeftovers(tmpDir);

    // 1. Guardar: lo que la pieza midió queda en la carpeta de estado, viaje o no.
    const items = [];
    for (const f of files || []) {
      const rule = ALLOWED[f.path];
      if (!rule || rule.piece !== piece || rule.mode !== f.mode) throw new Error(`${f.path} (${f.mode}) no es una ruta de ${piece}`);
      const content = f.text !== undefined && f.text !== null ? String(f.text) : fs.readFileSync(f.source, 'utf8');
      const kept = keptPath(piece, f.path, home);
      if (!f.source || path.resolve(f.source) !== path.resolve(kept)) writeAtomic(kept, content);
      items.push({ path: f.path, mode: f.mode, content });
    }

    // 2. Lo que main ya tiene no viaja: el mismo archivo byte a byte, o una sección cuya marca ya está en la lista.
    const fm = fetchMain(repo);
    if (!fm.ok) return fail(fm.motivo);
    const pending = [];
    for (const it of items) {
      if (it.mode === 'replace') {
        const mine = git(repo, ['hash-object', '--stdin'], { input: it.content });
        const theirs = git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/main:${it.path}`]);
        if (mine.ok && theirs.ok && mine.out === theirs.out) continue;
        pending.push(it);
      } else {
        const main = readMain(repo, it.path);
        if (main.state === 'error') return fail(main.motivo);
        const seen = String(main.text || '');
        const fresh = sectionsOf(it.content).filter((s) => !s.marker || !seen.includes(s.marker));
        if (fresh.length) pending.push({ ...it, content: fresh.map((s) => s.text).join('\n') });
      }
    }
    if (!pending.length) {
      log('lo mismo que ya está en main: no hay nada que publicar');
      writeStatus(piece, { ok: true, at: new Date().toISOString(), entry: null }, home);
      return { ok: true, entry: null };
    }

    // 3. El transporte: un repo desnudo propio con la URL del remoto del clon.
    const url = git(repo, ['remote', 'get-url', 'origin']);
    if (!url.ok || !url.out) return fail(why(url, 'el clon no tiene origin'));
    const transport = path.join(root, 'transport.git');
    if (!fs.existsSync(path.join(transport, 'HEAD'))) {
      const init = spawnSync('git', ['init', '--quiet', '--bare', transport], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true });
      if (init.status !== 0) return fail(`no pude armar la copia de transporte: ${String(init.stderr || '').trim()}`);
    }
    // una ruta local relativa vale desde el clon; leída desde la copia de transporte apuntaría a otro lado
    const isLocal = !/^[a-z][a-z0-9+.-]*:\/\//i.test(url.out) && !/^[^/\\]+:/.test(url.out);
    const target = isLocal && !path.isAbsolute(url.out) ? path.resolve(repo, url.out) : url.out;
    const setUrl = git(transport, ['config', 'remote.origin.url', target]);
    if (!setUrl.ok) return fail(why(setUrl, 'no pude armar la copia de transporte'));
    const who = (k, def) => { const r = git(repo, ['config', k]); return r.ok && r.out ? r.out : def; };
    const name = who('user.name', 'arnés');
    const email = who('user.email', 'arnes@localhost');
    const identity = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };

    const now = new Date();
    const id = `${now.toISOString().replace(/[-:.]/g, '')}-${piece}-${crypto.randomBytes(3).toString('hex')}`;
    const entry = { schema: 1, id, piece, ts: now.toISOString(), files: pending.map((it) => ({ path: it.path, mode: it.mode })) };
    let last = '';
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      // la punta de la rama, cada vez: si el empuje se rechazó, otra entrada llegó antes y el commit va encima de ella
      const ls = git(transport, ['ls-remote', '--exit-code', 'origin', `refs/heads/${BRANCH}`]);
      let tip = null;
      if (ls.ok) {
        const f = git(transport, ['fetch', '--quiet', 'origin', `+refs/heads/${BRANCH}:refs/heads/${BRANCH}`]);
        if (!f.ok) return fail(why(f, `no pude traer ${BRANCH}`));
        tip = git(transport, ['rev-parse', `refs/heads/${BRANCH}`]).out;
      } else if (ls.status !== 2) return fail(why(ls, `no pude mirar ${BRANCH}`));

      const index = path.join(tmpDir, `${process.pid}-${crypto.randomBytes(4).toString('hex')}.index`);
      const env = { GIT_INDEX_FILE: index };
      let commit;
      try {
        const step = (r, what) => { if (!r.ok) throw new Error(why(r, what)); return r.out; };
        step(git(transport, tip ? ['read-tree', tip] : ['read-tree', '--empty'], { env }), 'no pude leer la punta de la rama');
        const add = (rel, content) => {
          const sha = step(git(transport, ['hash-object', '-w', '--stdin'], { input: content }), 'no pude guardar el archivo');
          step(git(transport, ['update-index', '--add', '--cacheinfo', `100644,${sha},${rel}`], { env }), 'no pude armar la entrada');
        };
        for (const it of pending) add(`runs/${id}/files/${it.path}`, it.content);
        add(`runs/${id}/entry.json`, `${JSON.stringify(entry, null, 2)}\n`);
        const tree = step(git(transport, ['write-tree'], { env }), 'no pude armar la entrada');
        commit = step(git(transport, ['commit-tree', tree, ...(tip ? ['-p', tip] : []), '-m', message], { env: identity }), 'no pude armar el commit');
      } finally { fs.rmSync(index, { force: true }); }

      const push = git(transport, ['push', '--quiet', 'origin', `${commit}:refs/heads/${BRANCH}`]);
      if (push.ok) {
        log(`resultado publicado en ${BRANCH} (intento ${attempt}): entrada ${id}`);
        writeStatus(piece, { ok: true, at: new Date().toISOString(), entry: id, publishedAt: new Date().toISOString() }, home);
        return { ok: true, entry: id };
      }
      last = why(push, 'empuje rechazado');
      log(`empuje rechazado (intento ${attempt} de ${ATTEMPTS}): ${clean(push.err.split('\n').pop())}`);
    }
    return fail(`no se pudo empujar a ${BRANCH} tras ${ATTEMPTS} intentos (${last}); el resultado quedó en ${path.join(root, piece)}`);
  } catch (e) {
    return fail((e && e.message) || String(e));
  }
}

module.exports = { BRANCH, CARRIED, PATHS, ALLOWED, PIECES, ATTEMPTS, MARKER, rootDir, keptPath, statusFile, clean, readStatus,
  recordFailure, fetchMain, readMain, sectionsOf, publish };
