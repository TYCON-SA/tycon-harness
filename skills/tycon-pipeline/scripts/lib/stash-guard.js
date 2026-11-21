'use strict';
/**
 * stash-guard.js — con otra sesión viva, ningún `git stash` se lleva archivos de otra sesión, y nadie borra ni aplica lo
 * que guardó otra. Lo llama on-bash-write-gate.js en cada comando de consola; sólo trabaja si el comando
 * nombra `git … stash`.
 *
 * ── EL CASO ───────────────────────────────────────────────────────────────────────────────────────────────────────
 * Dos historias corrieron con dos sesiones sobre el mismo checkout. Una hizo `git stash` para apartar sus cambios, y el
 * stash se llevó también los de la otra, con la carpeta de su corrida (`.advisors/pipeline-runs/…`). La otra rehízo
 * todo: validación, plan, pruebas, pase adversarial, revisores y firmas.
 *
 * ── QUÉ FRENA ─────────────────────────────────────────────────────────────────────────────────────────────────────
 * - Guardar (`git stash`, `push`, `save`) con otra sesión viva en ESE checkout, si se llevaría un archivo que no es de
 *   la sesión: los cambiados contra HEAD, y los sin trackear con `-u` (más los ignorados con `-a`); con rutas, sólo ésas.
 *   Propio = `filesTouched` del marcador de la sesión, lo que su consola escribió (`console-writes/<sesión>.jsonl`, el
 *   registro de este mismo gate) o lo que está bajo el `runDir` de su corrida; todo por ruta real. Lo que no reclama
 *   nadie cuenta como ajeno, a propósito: frenar sólo deja de hacer el stash, llevárselo puede perder trabajo ajeno.
 *   Sin marcador propio, sólo frena lo que reclama otra sesión y lo que está bajo `.advisors/pipeline-runs/`.
 * - `pop` y `drop` de una entrada que no es de la sesión (ni su marca `[sesión <id corto>]`, ni todos sus archivos
 *   propios), y `clear`, con otra sesión viva en CUALQUIER copia del repo: la pila de stash vive en el `.git` común.
 * - Si git no deja calcular los archivos, frena sólo si otra sesión viva tiene su corrida abierta, y lo dice.
 *
 * Sin otra sesión viva, pasa todo. `list`, `show`, `apply`, `create`, `store` y `branch` pasan siempre. La salida es
 * de la persona: `TYCON_STASH_GUARD_OK=1 git stash …`, con constancia en stderr y en bypass.log. Corre en el gate de
 * Bash, que como todo freno está sólo en el perfil `full` (scripts/setup/install-effects.json).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TAG = '[stash-guard]';
const ESCAPE = /(^|[;&|]\s*)TYCON_STASH_GUARD_OK=1\s/;
const GUARDAN = new Set(['push', 'save']);
const PASAN = new Set(['list', 'show', 'apply', 'create', 'store', 'branch']);
const MAX_NOMBRES = 10;

const real = (p) => {
  try { return fs.realpathSync(p); } catch { /* todavía no existe, o se borró */ }
  try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch { return path.resolve(p); }
};
const debajo = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
const corto = (sid) => String(sid).slice(0, 8);

function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, '-c', 'core.fsmonitor=false', ...args], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return { code: r.error ? null : r.status, out: String(r.stdout || ''), err: String((r.error && r.error.message) || r.stderr || '').trim().split('\n')[0] };
}

// Las piezas del arnés: la lib de sesiones vive en scripts/ del mismo árbol (skills/tycon-pipeline/scripts/lib → raíz).
const libDelArnes = (nombre) => require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', nombre));

/** Las palabras de una sentencia como las ve la consola: una comilla puede abrir en medio (`--message="a b"`, `-m"a b"`). */
function palabras(s) {
  const out = [];
  let cur = null;
  let comilla = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (comilla) {
      if (c === comilla) comilla = null;
      else if (c === '\\' && comilla === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") { comilla = c; cur = cur || ''; }
    else if (c === '\\' && i + 1 < s.length) cur = (cur || '') + s[++i];
    else if (/\s/.test(c)) { if (cur !== null) out.push(cur); cur = null; }
    else cur = (cur || '') + c;
  }
  if (cur !== null) out.push(cur);
  return out;
}

const citar = (f) => (/^[\w./@+:=-]+$/.test(f) ? f : `'${f.replace(/'/g, `'\\''`)}'`);
// los nombres de git separados por NUL: con renglones, un nombre con acento o espacio sale citado y con escapes
const nombres = (out) => out.split('\0').filter(Boolean);

/** Lo que pide un `git … stash …`: `{ sub, flags, paths, ref }`. */
function leerStash(st) {
  const w = palabras(st);
  const i = w.indexOf('stash');
  const resto = i >= 0 ? w.slice(i + 1) : [];
  let sub = 'push';
  let args = resto;
  if (resto.length && !resto[0].startsWith('-')) { sub = resto[0]; args = resto.slice(1); }
  const flags = new Set();
  const paths = [];
  let ref = null;
  let tras = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (tras) { paths.push(a); continue; }
    if (a === '--') { tras = true; continue; }
    if (a === '-m' || a === '--message') { k++; continue; }
    if (/^--message=/.test(a)) continue;
    if (a.startsWith('--')) { flags.add(a); continue; }
    if (a.startsWith('-') && a.length > 1) {
      // banderas cortas juntas: `-m` se lleva el resto de la palabra o, si no queda nada, la palabra siguiente
      for (let j = 1; j < a.length; j++) {
        if (a[j] === 'm') { if (j === a.length - 1) k++; break; }
        flags.add(`-${a[j]}`);
      }
      continue;
    }
    if (sub === 'push') paths.push(a);
    else if (sub === 'pop' || sub === 'drop' || sub === 'apply') ref = ref || a;
  }
  if (sub === 'pop' || sub === 'drop') ref = ref ? (/^\d+$/.test(ref) ? `stash@{${ref}}` : ref) : 'stash@{0}';
  return { sub, flags, paths, ref };
}

function marcador(stateDir, sid, avisar) {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'active', `${String(sid).replace(/[/\\]/g, '_')}.json`), 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') avisar(`no pude leer el marcador de la sesión ${corto(sid)} (${e.code || e.message}): lo suyo no cuenta como propio`);
    return null;
  }
}

/** Lo que escribió por consola una sesión (el registro de este gate), por ruta real. */
function escriturasDe(stateDir, sid, avisar) {
  try {
    const { lineas, problemas } = require('./undeclared-changes.js').consoleWritesOf(stateDir, sid);
    for (const p of problemas || []) avisar(`lo escrito por consola de la sesión ${corto(sid)}: ${p}`);
    return new Set(lineas.map((l) => l && l.path).filter((p) => typeof p === 'string').map(real));
  } catch (e) {
    avisar(`no pude leer lo escrito por consola de la sesión ${corto(sid)} (${e.code || e.message})`);
    return new Set();
  }
}

/** De quién es un archivo (ruta real): `{ sid, story, run }` o null. */
function quienReclama(f, ajenos) {
  for (const a of ajenos) {
    if (a.runDir && debajo(f, a.runDir)) return { sid: a.sessionId, story: a.storyId, run: true };
    if (a.files.has(f) || a.consola.has(f)) return { sid: a.sessionId, story: a.storyId, run: false };
  }
  return null;
}

/** Los archivos que se llevaría un guardado, relativos a la raíz. `{ files }` o `{ error }`. */
function seLlevaria(raiz, { flags, paths }) {
  const cambiados = git(raiz, ['diff', '--name-only', '-z', 'HEAD']);
  if (cambiados.code !== 0) return { error: cambiados.err || `git salió con código ${cambiados.code}` };
  const lista = nombres(cambiados.out);
  const todos = flags.has('-a') || flags.has('--all');
  if (todos || flags.has('-u') || flags.has('--include-untracked')) {
    const otros = git(raiz, ['ls-files', '--others', '-z', ...(todos ? [] : ['--exclude-standard'])]);
    if (otros.code !== 0) return { error: otros.err || `git salió con código ${otros.code}` };
    lista.push(...nombres(otros.out));
  }
  return { files: [...new Set(lista)] };
}

/** Los archivos de una entrada de la pila (con los sin trackear que guardó), relativos a la raíz. */
function deLaEntrada(raiz, ref) {
  const r = git(raiz, ['stash', 'show', '--name-only', '-z', '--include-untracked', ref]);
  if (r.code === 0) return { files: nombres(r.out) };
  const sin = git(raiz, ['stash', 'show', '--name-only', '-z', ref]);
  return sin.code === 0 ? { files: nombres(sin.out) } : { error: sin.err || r.err };
}

function constancia(stateDir, cmd) {
  process.stderr.write(`${TAG} TYCON_STASH_GUARD_OK=1: dejo pasar el stash con otra sesión viva. Lo decidió la persona; queda dicho.\n`);
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(path.join(stateDir, 'bypass.log'), JSON.stringify({ ts: new Date().toISOString(), type: 'STASH_GUARD_OK', command: String(cmd).slice(0, 500) }) + '\n');
  } catch { /* la constancia en stderr ya salió */ }
}

const salida = 'Si la persona decide seguir igual, la salida es suya, no del agente: `TYCON_STASH_GUARD_OK=1 git stash …` pegado al comando (queda en bypass.log).';
const listaDeOtras = (vivas) => vivas.map((s) => `   · sesión ${corto(s.id)}${s.story ? ` — historia ${s.story}` : ''}${s.lastPrompt ? ` — último pedido: «${s.lastPrompt}»` : ''}`).join('\n');

/**
 * El veredicto para un comando de consola: null (pasa) o `{ block }`. `opts`: `{ cmd, cwd, sessionId, stateDir, home,
 * avisar }`; `avisar(texto)` recibe lo que no se pudo medir, para que un paso sin medir quede dicho.
 */
function evaluar({ cmd, cwd, sessionId, stateDir, home = os.homedir(), avisar = () => {} }) {
  if (typeof cmd !== 'string' || !/\bgit\b[\s\S]*\bstash\b/.test(cmd)) return null;
  const destino = libDelArnes('git-target.js');
  const live = libDelArnes('live-sessions.js');
  const re = destino.regexDeGit('stash');
  const ds = destino.destinos(cmd, cwd, re);
  for (const d of ds) {
    const pedido = leerStash(d.st);
    if (PASAN.has(pedido.sub)) continue;
    const raiz = live.raizDelRepo(d.dir);
    if (!raiz) continue;
    const guarda = GUARDAN.has(pedido.sub);
    const scope = guarda ? 'checkout' : 'repo';
    const vivas = live.others({ root: raiz, selfSessionId: sessionId, home, scope });
    vivas.problems.forEach(avisar);
    const otras = vivas.sessions;
    if (!otras.length) continue;
    if (ESCAPE.test(cmd)) { constancia(stateDir, cmd); return null; }
    const rraiz = real(raiz);
    // quién reclama qué: los marcadores presentes (con cualquier edad) y lo que cada sesión escribió por consola
    const reclamos = live.claims({ root: raiz, home });
    reclamos.problems.forEach(avisar);
    const marcadores = reclamos.markers;
    const propio = marcador(stateDir, sessionId, avisar);
    const misArchivos = new Set((propio && Array.isArray(propio.filesTouched) ? propio.filesTouched : []).filter((f) => typeof f === 'string').map(real));
    const miConsola = escriturasDe(stateDir, sessionId, avisar);
    const miRun = propio && typeof propio.runDir === 'string' && propio.runDir ? real(propio.runDir) : null;
    const ajenos = marcadores.filter((m) => m.sessionId !== sessionId).map((m) => ({ ...m, consola: escriturasDe(stateDir, m.sessionId, avisar) }));
    for (const s of otras) if (!ajenos.some((a) => a.sessionId === s.id)) ajenos.push({ sessionId: s.id, storyId: s.story, files: new Set(), runDir: null, consola: escriturasDe(stateDir, s.id, avisar) });
    const esPropio = (f) => misArchivos.has(f) || miConsola.has(f) || (miRun && debajo(f, miRun));
    const corridas = path.join(rraiz, '.advisors', 'pipeline-runs');
    const ajeno = (f) => {
      if (esPropio(f)) return null;
      const d2 = quienReclama(f, ajenos);
      if (d2) return d2;
      if (debajo(f, corridas)) return { sid: null, story: null, run: true };
      // sin marcador propio, lo que nadie reclama no es de nadie en particular: pasa
      return propio ? { sid: null, story: null, run: false } : null;
    };
    const nombre = (f, dd) => `${path.relative(rraiz, f)} — ${dd.sid ? `${dd.run ? 'de la corrida de la sesión' : 'de la sesión'} ${corto(dd.sid)}${dd.story ? ` (historia ${dd.story})` : ''}` : dd.run ? 'de la corrida de otra sesión' : 'ninguna sesión lo reclama'}`;
    const conCorrida = otras.some((s) => s.story);
    const noCalcula = (motivo) => {
      if (conCorrida) return { block: `🔴 ${TAG} no pude calcular qué se llevaría \`git stash ${pedido.sub}\` en ${raiz} (${motivo}), y otra sesión viva tiene su corrida abierta ahí:\n${listaDeOtras(otras)}\n   Ante la duda, freno. ${salida}\n` };
      avisar(`no pude calcular qué toca \`git stash ${pedido.sub}\` en ${raiz} (${motivo}): lo dejé pasar, ninguna otra sesión viva tiene su corrida abierta`);
      return null;
    };

    if (guarda) {
      const calc = seLlevaria(raiz, pedido);
      if (calc.error) { const v = noCalcula(calc.error); if (v) return v; continue; }
      const dirComando = d.dir;
      const filtros = pedido.paths.map((p) => real(path.resolve(dirComando, p)));
      const archivos = calc.files.map((f) => real(path.join(raiz, f))).filter((f) => !filtros.length || filtros.some((p) => debajo(f, p)));
      const malos = archivos.map((f) => [f, ajeno(f)]).filter(([, dd]) => dd);
      if (!malos.length) continue;
      const propios = archivos.filter((f) => esPropio(f)).map((f) => path.relative(rraiz, f));
      const nombres = malos.slice(0, MAX_NOMBRES).map(([f, dd]) => `   · ${nombre(f, dd)}`).join('\n') + (malos.length > MAX_NOMBRES ? `\n   · y ${malos.length - MAX_NOMBRES} más` : '');
      const sugerido = propios.length
        ? `\`git stash push -m "[sesión ${corto(sessionId)}] <motivo>" -- ${propios.map(citar).join(' ')}\``
        : 'nada: no hay cambios propios para guardar';
      return { block: `🔴 ${TAG} con otra sesión viva en este checkout (${raiz}), este \`git stash\` se llevaría archivos que no son de esta sesión:\n${nombres}\n   Las otras sesiones vivas:\n${listaDeOtras(otras)}\n   Caso real: un stash así se llevó la corrida de la otra sesión, que rehízo todo.\n   Qué hacer: guardá sólo lo propio, con la marca de la sesión: ${sugerido}; o arrancá la historia en su propia copia (pipeline.js start la crea con otra sesión viva).\n   ${salida}\n` };
    }

    if (pedido.sub === 'clear') {
      return { block: `🔴 ${TAG} \`git stash clear\` borra TODAS las entradas de la pila, que comparten todas las copias de ${raiz}, y hay otra sesión viva en el repo:\n${listaDeOtras(otras)}\n   Borrá sólo las tuyas, de a una (\`git stash drop <entrada>\`). ${salida}\n` };
    }
    // pop / drop: la entrada es de la sesión por su marca o porque todos sus archivos son suyos
    const msg = git(raiz, ['log', '-1', '--format=%s', pedido.ref]);
    if (msg.code !== 0) { const v = noCalcula(msg.err || `no encontré ${pedido.ref}`); if (v) return v; continue; }
    if (msg.out.includes(`[sesión ${corto(sessionId)}]`)) continue;
    const ent = deLaEntrada(raiz, pedido.ref);
    if (ent.error) { const v = noCalcula(ent.error); if (v) return v; continue; }
    const archivos = ent.files.map((f) => real(path.join(raiz, f)));
    if (archivos.length && archivos.every((f) => esPropio(f))) continue;
    const ajenosDeLaEntrada = archivos.filter((f) => !esPropio(f)).slice(0, MAX_NOMBRES).map((f) => `   · ${nombre(f, quienReclama(f, ajenos) || { sid: null, run: debajo(f, corridas) })}`).join('\n');
    const verbo = pedido.sub === 'drop' ? 'borraría' : 'aplicaría en esta rama';
    return { block: `🔴 ${TAG} \`git stash ${pedido.sub} ${pedido.ref}\` ${verbo} una entrada que no es de esta sesión (no lleva la marca [sesión ${corto(sessionId)}] y tiene archivos que no son suyos), con otra sesión viva en el repo (la pila es común a todas sus copias):\n${ajenosDeLaEntrada || '   · (sin archivos que mostrar)'}\n   Las otras sesiones vivas:\n${listaDeOtras(otras)}\n   No se puede atribuir: decidilo con la persona. ${salida}\n` };
  }
  return null;
}

module.exports = { evaluar, leerStash };
