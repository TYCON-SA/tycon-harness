#!/usr/bin/env node
'use strict';
/*
 * run-change.js — QUÉ CAMBIÓ UNA CORRIDA, SEGÚN GIT
 *
 * La vista de corridas sabe qué archivos tocó cada corrida leyendo su conversación, y eso deja afuera la
 * mayor parte: medido sobre 121 corridas, 7.294 cambios por consola contra 3.829 con las herramientas de
 * edición, y de la consola la conversación guarda el comando, no el cambio. Lo de los subagentes no está.
 * Git tiene todo. Este guion lo junta al archivar la corrida y lo deja al lado del volcado:
 * `<volcado sin .json>.cambio.json.gz`.
 *
 * Qué guarda, por cada repo donde la corrida escribió:
 *  - los COMMITS DE LA CORRIDA: los que el reflog de HEAD anota como creados en esa copia durante la
 *    corrida (`commit`, `commit (amend)`, `rebase (pick)`, `cherry-pick`, `revert`…) y siguen alcanzables.
 *    🔴 No el diff desde el commit en que arrancó: la copia se pone al día a mitad de camino (pull, reset a
 *    origin/main) y eso mete commits de otros en la línea principal — 15 de 16 en una medición. El reflog
 *    distingue lo creado acá de lo que llegó.
 *  - lo que quedó SIN COMMITEAR al archivar (`git diff HEAD` y los no trackeados que git no ignora), sólo lo
 *    MODIFICADO DURANTE la corrida (fecha del archivo): una copia sucia de antes no es de la corrida. Medido: una
 *    corrida real de un repo del equipo cargaba 241 archivos sin commitear de corridas anteriores. Lo excluido se cuenta.
 *
 * Cada repo se nombra con `nombre` (el repo según su remoto; sin remoto, la carpeta) y `proyecto` (el
 * proyecto de Azure DevOps del remoto, decodificado y con su caja; `null` si el remoto no es de Azure o no hay). Con
 * los dos, la vista ubica la corrida en un producto de repos.json por `<proyecto>/<repo>`. Un cambio sin
 * `proyecto` es válido: quien lee compara sólo el nombre.
 *
 * Qué repos: el de la story, más la carpeta git de cada archivo que la corrida escribió dentro de su
 * ventana — con las herramientas (`marker.filesTouched`, `file-events/<sesión>.jsonl`, subagentes
 * incluidos) o por consola (`console-writes/<sesión>.jsonl`, lo anota la puerta de la consola).
 *
 * Reglas:
 *  - Cada parche pasa por `sanear` de tokens-digest.js, IMPORTADO: dos saneados se separan solos. Sin él,
 *    `estado: "no_publicado"` y ningún parche.
 *  - «No pude mirar» nunca se escribe como «no cambió nada»: sin volcado legible, sin repo o sin git, el
 *    archivo dice `no_medido` con el motivo y NO trae `repos`. Un repo que falla se dice solo, y los demás
 *    se miden.
 *  - Nunca imprime un parche: por stdout sale una línea de resumen, y los errores no llevan contenido.
 *  - Sólo lecturas de git: ni stash, ni add, ni checkout.
 *
 * 🔴 Una copia que trabajaron varias sesiones a la vez (`otras_sesiones > 0`): el reflog dice qué commits se
 * hicieron EN ESA COPIA, no POR ESTA SESIÓN. Ejemplo: en
 * el checkout compartido del arnés entran 7 commits y 6 son de otras sesiones, que sin esto se publican como propios.
 * Cada commit se atribuye con el HILO de la conversación (`<volcado>.hilo.jsonl.gz`): un commit
 * de esta sesión nace mientras corre una de sus herramientas (Bash, o un subagente), así que
 *  - si en ese segundo no corría ninguna → es de otra sesión: sale de la lista y se anota en
 *    `commits_de_otras_sesiones` (con sha y asunto, nunca escondido);
 *  - si corría una que lo nombra (el sha, el asunto, o un `git commit|rebase|…`) → propio, sin marca;
 *  - si corría una que no lo nombra (dos sesiones a la vez, un subagente que commitea) → queda, con
 *    `atribucion: "coincide_la_hora"`: se muestra marcado, porque esconderlo podría ser perder trabajo propio;
 *  - sin hilo, o fuera de lo que el hilo cubre → `atribucion: "sin_constancia"`, marcado, con el motivo en el repo.
 * Los archivos que cada sesión anotó (`file-events`, `console-writes`) NO sirven para esto: una sesión sin
 * pipeline casi no deja constancia. Límite que queda: un commit hecho por un comando en segundo plano o por
 * un flujo de agentes no tiene ventana en el hilo y sale como de otra sesión — visible, con su asunto.
 *
 * Uso: node scripts/metrics/run-change.js --dump <v.json> [--state <dir>] [--output <archivo>]
 * Sale 0 cuando midió o declaró no_medido; 2 con argumentos inválidos o si no pudo escribir la salida.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
// La carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: los
// laboratorios copian carpetas sueltas de scripts/ sin scripts/setup/; ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const VERSION = 1;
const TOPE_PARTE = 200000;
const TOPE_CORRIDA = 5 * 1024 * 1024;
const MARGEN_MS = 60000;
const MAX_BUFFER = 256 * 1024 * 1024;
const MAX_NO_TRACKEADO = 64 * 1024 * 1024;
const ARBOL_VACIO = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
// Acciones del reflog que CREAN un commit en esta copia. Un fast-forward, un reset, un pull o un checkout
// mueven HEAD a algo que ya existía o que llegó de afuera: no son de la corrida.
// 🔴 Las cuatro formas del final cubren un agujero: cuando
// un rebase, un cherry-pick o un merge CHOCAN, el commit que sale de resolver el conflicto lo anota git como
// `rebase (continue):`, `commit (cherry-pick):`, `commit (merge):` o `am:` — creado en esta copia, con la
// resolución escrita a mano adentro. Sin ellas, una corrida que resolvió un conflicto perdería TODOS sus commits
// y se archivaría «medido, 0 archivos»: «no pude mirar» publicado como «no cambió nada». Medido en los reflogs
// reales de esta máquina: 2 de 239 en el arnés, 9 de 609 en otro repo.
const CREA_COMMIT = /^(?:commit(?: \((?:amend|initial|cherry-pick|merge)\))?|cherry-pick|revert|am|[\w -]+ \((?:pick|reword|edit|squash|fixup|continue)\)):/;

let sanear = null;
let motivoSinSaneado = null;
try {
  ({ sanear } = require('./tokens-digest.js'));
  if (typeof sanear !== 'function') throw new Error('no exporta sanear');
} catch (e) {
  sanear = null;
  motivoSinSaneado = `no se pudo cargar scripts/metrics/tokens-digest.js (${e.code || e.message}): sin el saneado, los cambios no se publican`;
}
let nombreDeRepoAzure = null;
let resolverRemoto = null;
try { ({ nombreDeRepo: nombreDeRepoAzure, resolverRemoto } = require('../lib/harness-repo.js')); } catch { nombreDeRepoAzure = null; resolverRemoto = null; }

function git(dir, args, ok) {
  // `--literal-pathspecs`: una ruta con `[`, `*` o `?` (las rutas dinámicas de Next.js, por ejemplo) es un
  // NOMBRE, no un patrón — sin esto, el parche de un archivo se traería el de otros.
  const r = spawnSync('git', ['-C', dir, '--literal-pathspecs', ...args], { encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
  if (r.error) return { error: r.error.code === 'ENOENT' ? 'git no está instalado en esta máquina' : `git no se pudo ejecutar (${r.error.code || r.error.message})` };
  if (r.status !== 0 && !(ok || []).includes(r.status)) return { error: `git ${args[0]} salió ${r.status}: ${String(r.stderr || '').trim().split('\n')[0] || 'sin detalle'}`, status: r.status };
  return { out: r.stdout, status: r.status };
}

/** La ruta real (resuelve enlaces, como `/var` → `/private/var` en macOS) aunque el archivo ya no exista. */
function real(p) {
  const abs = path.resolve(String(p || ''));
  try { return fs.realpathSync(abs); } catch { /* no existe: se resuelve la carpeta */ }
  const arriba = path.dirname(abs);
  return arriba === abs ? abs : path.join(real(arriba), path.basename(abs));
}

/**
 * La carpeta raíz del repo git que contiene una ruta, o null. Un archivo borrado cuenta si su carpeta
 * sigue: si no queda ni la carpeta, no se sube a buscar un repo más arriba — un clon descartable ya
 * borrado haría mirar el repo que lo contiene, y eso sería atribuirle a la corrida lo de otro.
 */
function raizDe(ruta, cache) {
  const abs = path.resolve(String(ruta || ''));
  let dir = abs;
  try { if (!fs.statSync(abs).isDirectory()) dir = path.dirname(abs); } catch { dir = path.dirname(abs); }
  try { if (!fs.statSync(dir).isDirectory()) return null; } catch { return null; }
  if (cache.has(dir)) return cache.get(dir);
  const r = git(dir, ['rev-parse', '--show-toplevel']);
  const top = r.error ? null : real(r.out.trim());
  cache.set(dir, top);
  return top;
}

function nombreDe(top) {
  try { const n = nombreDeRepoAzure && nombreDeRepoAzure(top); if (n) return n; } catch { /* sin remoto legible */ }
  const u = git(top, ['remote', 'get-url', 'origin']);
  if (!u.error && u.out.trim() && !/^[./~]|^file:/i.test(u.out.trim())) {
    const b = u.out.trim().replace(/\/+$/, '').split(/[/:]/).pop().replace(/\.git$/i, '');
    if (b) return b;
  }
  return path.basename(top).replace(/--(?:wt-[^/]+|merge)$/, '');
}

/**
 * El proyecto de Azure DevOps del remoto del repo, o null si el remoto no es de Azure, no hay
 * remoto o no se puede leer. Sigue un `origin` local como `nombreDe`. Sale como `nombre`: decodificado
 * (`Beta%20Dos` → «Beta Dos») y con la caja que escribe el remoto — `identidadRemoto` lo da en minúsculas, así que
 * se toma de la URL el segmento que lo nombra. En la forma corta (`<org>/_git/<repo>`) el proyecto es el repo.
 */
function proyectoDe(top) {
  let r = null;
  try { r = resolverRemoto && resolverRemoto(top); } catch { return null; }
  if (!r || !r.id || !r.id.org || !r.id.proyecto) return null;
  const crudo = (s) => { try { return decodeURIComponent(s); } catch { return String(s); } };
  const segs = String(r.url || '').trim().replace(/\/+$/, '').replace(/\.git$/i, '').split(/[/:]/).map(crudo);
  const i = segs.lastIndexOf('_git');
  const v3 = segs.findIndex((s) => s.toLowerCase() === 'v3');
  const cand = i > 0 ? segs[i - 1] : (v3 >= 0 ? segs[v3 + 2] : null);
  if (cand && cand.toLowerCase() === r.id.proyecto) return cand;
  if (r.id.nombre && r.id.nombre.toLowerCase() === r.id.proyecto) return r.id.nombre; // forma corta
  return r.id.proyecto;
}

function leerJsonl(f) {
  try {
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/**
 * Las carpetas de las escrituras por consola: `console-writes/` y, mientras dure el renombre, la
 * de su nombre viejo, que sale del mapa. Una sesión abierta con el código anterior sigue anotando en la vieja, y la
 * migración copia la vieja UNA vez: leer sólo la nueva perdería lo que esa sesión anote después. Sin el mapa (copia
 * pública), sólo la nueva.
 */
function carpetasDeConsola(estadoDir) {
  const out = [path.join(estadoDir, 'console-writes')];
  try {
    const lib = require('../lib/legacy-names.js');
    const vieja = lib.oldPathOf(path.join(stateDirOf(os.homedir()), 'console-writes'));
    if (vieja) out.push(path.join(estadoDir, path.basename(vieja)));
  } catch { /* sin la biblioteca o sin el mapa: sólo la nueva */ }
  return out;
}
/** Las líneas de `<carpeta>/<archivo>` de todas las carpetas, sin repetir (la migración copia las mismas líneas). */
function leerUnion(dirs, archivo) {
  const vistas = new Set();
  const out = [];
  for (const d of dirs) {
    for (const e of leerJsonl(path.join(d, archivo))) {
      const k = JSON.stringify(e);
      if (vistas.has(k)) continue;
      vistas.add(k);
      out.push(e);
    }
  }
  return out;
}

function enVentana(ts, v) { const t = Date.parse(ts || ''); return Number.isFinite(t) && t >= v.desde && t <= v.hasta; }

function adentro(top, ruta) { const rel = path.relative(top, real(ruta)); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); }

const TOLERANCIA_MS = 2000; // el reflog anota segundos enteros; el hilo, milisegundos
const TOPE_TEXTO_VENTANA = 20000;
const HERRAMIENTAS_QUE_CORREN = new Set(['Bash', 'Agent', 'Task', 'Workflow']);
const GIT_QUE_CREA = /\bgit\b[^\n]*\b(?:commit|rebase|cherry-pick|revert|am|merge|push)\b/;

function rutaDeHilo(volcado) { return String(volcado).replace(/\.json$/, '') + '.hilo.jsonl.gz'; }

/**
 * Las ventanas en que ESTA sesión tenía corriendo una herramienta que ejecuta comandos, según el hilo:
 * [{ desde, hasta, texto }] con el comando (o el pedido al subagente) y lo que devolvió, acotado. Más
 * `desde`/`hasta` de todo el hilo: fuera de eso el hilo no dice nada.
 */
function ventanasDelHilo(volcado) {
  const f = rutaDeHilo(volcado);
  let lineas;
  try { lineas = zlib.gunzipSync(fs.readFileSync(f)).toString('utf8').split('\n'); } catch (e) {
    return { error: `no se pudo leer el hilo de la conversación (${e.code || e.message}): no se sabe qué commits son de esta sesión` };
  }
  const abiertas = new Map();
  const ventanas = [];
  let desde = Infinity; let hasta = -Infinity;
  const textoDe = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('\n') : '');
  for (const l of lineas) {
    if (!l) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    const t = Date.parse(e && e.timestamp || '');
    if (!Number.isFinite(t)) continue;
    if (t < desde) desde = t;
    if (t > hasta) hasta = t;
    const contenido = e.message && Array.isArray(e.message.content) ? e.message.content : [];
    for (const x of contenido) {
      if (!x || typeof x !== 'object') continue;
      if (x.type === 'tool_use' && HERRAMIENTAS_QUE_CORREN.has(x.name)) {
        const inp = x.input && typeof x.input === 'object' ? x.input : {};
        abiertas.set(x.id, { desde: t, texto: String(inp.command || inp.prompt || JSON.stringify(inp)).slice(0, TOPE_TEXTO_VENTANA) });
      } else if (x.type === 'tool_result' && abiertas.has(x.tool_use_id)) {
        const a = abiertas.get(x.tool_use_id);
        abiertas.delete(x.tool_use_id);
        ventanas.push({ desde: a.desde, hasta: t, texto: `${a.texto}\n${textoDe(x.content).slice(0, TOPE_TEXTO_VENTANA)}` });
      }
    }
  }
  if (!Number.isFinite(desde)) return { error: 'el hilo de la conversación no tiene mensajes con fecha: no se sabe qué commits son de esta sesión' };
  return { ventanas, desde, hasta };
}

/** A quién se le atribuye un commit del reflog de una copia compartida (ver la cabecera). null = propio. */
function atribuir(sha, ts, asunto, hilo) {
  if (!hilo || hilo.error || !Number.isFinite(ts)) return 'sin_constancia';
  if (ts < hilo.desde - TOLERANCIA_MS || ts > hilo.hasta + TOLERANCIA_MS) return 'sin_constancia';
  const cubren = hilo.ventanas.filter((w) => ts >= w.desde - TOLERANCIA_MS && ts <= w.hasta + TOLERANCIA_MS);
  if (!cubren.length) return 'de_otra_sesion';
  const corto = sha.slice(0, 7).toLowerCase();
  const linea = String(asunto || '').split('\n')[0].trim();
  const loNombra = (w) => w.texto.toLowerCase().includes(corto) || (linea.length >= 8 && w.texto.includes(linea)) || GIT_QUE_CREA.test(w.texto);
  return cubren.some(loNombra) ? null : 'coincide_la_hora';
}

/** `git … --numstat -z -M`: [{ruta, ruta_anterior?, mas, menos, binario}] */
function numstat(out) {
  const t = String(out || '').split('\0');
  const partes = [];
  for (let i = 0; i < t.length; i++) {
    const cab = t[i];
    if (!cab) continue;
    const m = cab.match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
    if (!m) continue;
    const binario = m[1] === '-' && m[2] === '-';
    let ruta = m[3];
    let anterior;
    if (ruta === '') { anterior = t[i + 1]; ruta = t[i + 2]; i += 2; }
    if (!ruta) continue;
    partes.push({ ruta, ...(anterior ? { ruta_anterior: anterior } : {}), mas: binario ? 0 : Number(m[1]), menos: binario ? 0 : Number(m[2]), binario });
  }
  return partes;
}

function estadoDe(p, eliminado, agregado) {
  if (p.ruta_anterior) return 'R';
  if (agregado) return 'A';
  if (eliminado) return 'D';
  return 'M';
}

const esEngram = (ruta) => /^\.engram(\/|$)/.test(ruta);

/** Aplica saneado y topes a una parte, en el orden de la corrida. */
function conParche(parte, texto, cuenta) {
  if (parte.binario) return { ...parte, parche: null, cortado: 0 };
  const sinTope = () => { cuenta.lleno = true; cuenta.sin_parche_por_tope += 1; return { ...parte, parche: null, cortado: 0, sin_parche_por_tope: true }; };
  // Pasado el total, TODAS las partes que siguen salen sin parche (no sólo la que no entró): así el corte
  // se lee de una sola forma, «desde acá, sólo los números».
  if (cuenta.lleno) return sinTope();
  if (texto === null) return { ...parte, parche: null, cortado: 0 };
  let s = sanear(texto);
  let cortado = 0;
  if (s.length > TOPE_PARTE) { cortado = s.length - TOPE_PARTE; s = s.slice(0, TOPE_PARTE); cuenta.cortados += 1; }
  if (cuenta.bytes + s.length > TOPE_CORRIDA) return sinTope();
  cuenta.bytes += s.length;
  return { ...parte, parche: s, cortado };
}

function commitsDeLaCorrida(top, v) {
  const logs = git(top, ['rev-parse', '--git-path', 'logs/HEAD']);
  if (logs.error) return { commits: null, commits_motivo: `no se pudo ubicar el historial local de git (${logs.error})` };
  if (!fs.existsSync(path.resolve(top, logs.out.trim()))) {
    return { commits: null, commits_motivo: 'esta copia no tiene historial local de git (reflog): no se puede saber qué commits hizo la ejecución' };
  }
  const rl = git(top, ['reflog', 'show', '--format=%H%x09%gd%x09%gs', '--date=iso-strict', 'HEAD']);
  if (rl.error) return { commits: null, commits_motivo: `no se pudo leer el historial local de git (${rl.error})` };
  const vistos = new Set();
  const shas = [];
  const cuando = new Map(); // sha → cuándo lo anotó el reflog (lo usa la atribución en una copia compartida)
  for (const l of rl.out.split('\n').reverse()) {
    if (!l) continue;
    const [h, gd, ...resto] = l.split('\t');
    const gs = resto.join('\t');
    const ts = Date.parse(String(gd || '').replace(/^.*@\{|\}$/g, ''));
    if (!Number.isFinite(ts) || ts < v.desde || ts > v.hasta || !CREA_COMMIT.test(gs) || vistos.has(h)) continue;
    vistos.add(h);
    shas.push(h);
    cuando.set(h, ts);
  }
  const commits = [];
  for (const h of shas) {
    const anc = spawnSync('git', ['-C', top, 'merge-base', '--is-ancestor', h, 'HEAD'], { stdio: 'ignore' });
    let alcanzable = anc.status === 0;
    // Cualquier otro final (error del binario, objeto ilegible) también pregunta por las ramas: dar por
    // «no alcanzable» un fallo de git sería perder un commit de la corrida sin decirlo.
    if (!alcanzable) {
      const ramas = git(top, ['branch', '--all', '--contains', h, '--format=%(refname)']);
      alcanzable = !ramas.error && ramas.out.trim().length > 0;
    }
    if (alcanzable) commits.push(h);
  }
  return { commits, cuando };
}

function partesDeCommit(top, h, cuenta) {
  const cab = git(top, ['show', '-s', '--format=%H%x00%cI%x00%s%x00%P', h]);
  if (cab.error) return { error: cab.error };
  const [sha, fecha, asunto, padres] = cab.out.replace(/\n$/, '').split('\0');
  // 🔴 Un commit de MERGE no se puede leer con `git show`: los números salen del primer padre y el estado y
  // el parche del diff combinado, que sólo muestra lo que difiere de AMBOS. Medido: un merge con conflicto
  // da `MM a.txt` y nada para el archivo traído y el borrado (saldrían «modificado»), y su parche vacío.
  // Con más de un padre se mira todo contra el PRIMER padre, que es lo que ese commit trajo a esta línea.
  const p1 = String(padres || '').trim().split(/\s+/).filter(Boolean);
  const esMerge = p1.length > 1;
  const cmd = (extra) => (esMerge ? ['diff', p1[0], h, ...extra] : ['show', '--format=', h, ...extra]);
  const ns = git(top, cmd(['--numstat', '-z', '-M']));
  if (ns.error) return { error: ns.error };
  const st = git(top, cmd(['--name-status', '-z', '-M']));
  // 🔴 Si git no puede decir si un archivo es alta, baja o renombrado, el repo sale `no_medido`: leerlo como
  // «vacío» dejaría TODO como «modificado» y la corrida en `medido`, sin aviso.
  if (st.error) return { error: st.error };
  const tipos = tiposDeNameStatus(st.out);
  const archivos = [];
  for (const p of numstat(ns.out)) {
    if (esEngram(p.ruta)) continue;
    const tipo = tipos.get(p.ruta) || '';
    const parte = { ruta: p.ruta, estado: estadoDe(p, tipo === 'D', tipo === 'A'), ...(p.ruta_anterior ? { ruta_anterior: p.ruta_anterior } : {}), mas: p.mas, menos: p.menos, binario: p.binario };
    let texto = null;
    if (!p.binario && !cuenta.lleno) {
      const d = git(top, cmd(['--no-color', '--no-ext-diff', '-M', '--', ...(p.ruta_anterior ? [p.ruta_anterior] : []), p.ruta]));
      texto = d.error ? null : d.out;
    }
    archivos.push(conParche(parte, texto, cuenta));
  }
  return { h: sha.slice(0, 12), fecha, asunto: sanear(asunto || ''), archivos };
}

function tiposDeNameStatus(out) {
  const t = String(out || '').split('\0');
  const m = new Map();
  for (let i = 0; i < t.length; i++) {
    const s = t[i];
    if (!s) continue;
    if (/^[RC]\d*$/.test(s)) { m.set(t[i + 2], 'R'); i += 2; continue; }
    if (/^[ADMTUX]$/.test(s)) { m.set(t[i + 1], s); i += 1; }
  }
  return m;
}

function sinCommitear(top, cuenta, v) {
  let previo = 0;
  const omitidos = [];
  // ¿El archivo se modificó dentro de la ventana de la corrida? Un borrado no tiene fecha: entra.
  const deLaCorrida = (ruta) => {
    let st;
    try { st = fs.lstatSync(path.join(top, ruta)); } catch { return true; }
    // 🔴 `mtime` NO alcanza: `mv`, `git mv`, `cp -p`, `tar -x` y `unzip` conservan la fecha de modificación
    // del archivo original, así que un renombrado hecho por la corrida se descartaría como «sucio de antes».
    // `ctime` —la fecha del último cambio de estado del inodo— sí se mueve al renombrar.
    const cuando = Math.max(st.mtimeMs, st.ctimeMs);
    if (cuando >= v.desde && cuando <= v.hasta) return true;
    previo += 1;
    return false;
  };
  const head = git(top, ['rev-parse', '--verify', '-q', 'HEAD']);
  const contra = head.error ? ARBOL_VACIO : 'HEAD';
  const ns = git(top, ['diff', contra, '--numstat', '-z', '-M']);
  if (ns.error) return { error: ns.error };
  const st = git(top, ['diff', contra, '--name-status', '-z', '-M']);
  if (st.error) return { error: st.error };
  const tipos = tiposDeNameStatus(st.out);
  const partes = [];
  for (const p of numstat(ns.out)) {
    if (esEngram(p.ruta)) continue;
    const tipo = tipos.get(p.ruta) || '';
    if (tipo !== 'D' && !deLaCorrida(p.ruta)) continue;
    const parte = { ruta: p.ruta, estado: estadoDe(p, tipo === 'D', tipo === 'A'), ...(p.ruta_anterior ? { ruta_anterior: p.ruta_anterior } : {}), mas: p.mas, menos: p.menos, binario: p.binario };
    let texto = null;
    if (!p.binario && !cuenta.lleno) {
      const d = git(top, ['diff', contra, '--no-color', '--no-ext-diff', '-M', '--', ...(p.ruta_anterior ? [p.ruta_anterior] : []), p.ruta]);
      texto = d.error ? null : d.out;
    }
    partes.push(conParche(parte, texto, cuenta));
  }
  const nt = git(top, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (nt.error) return { error: nt.error };
  for (const ruta of nt.out.split('\0').filter(Boolean)) {
    if (ruta.endsWith('/') || esEngram(ruta)) continue;
    const abs = path.join(top, ruta);
    let st2;
    try { st2 = fs.lstatSync(abs); } catch { continue; }
    // Un enlace simbólico nuevo git lo versiona (modo 120000): entra, con su destino como contenido. Lo que
    // no es ni archivo ni enlace (un socket, un fifo) se saltea y se cuenta, nunca en silencio.
    const esEnlace = st2.isSymbolicLink();
    if (!st2.isFile() && !esEnlace) { previo += 0; omitidos.push(ruta); continue; }
    // La MISMA regla que para los trackeados (la fecha de cambio de estado también cuenta): un archivo sin
    // trackear movido durante la corrida conserva su fecha de modificación.
    if (!deLaCorrida(ruta)) continue;
    if (st2.size > MAX_NO_TRACKEADO) {
      partes.push({ ruta, estado: 'A', mas: null, menos: 0, binario: false, parche: null, cortado: 0, omitido: `archivo nuevo de más de ${MAX_NO_TRACKEADO / 1024 / 1024} MB: no se lee` });
      continue;
    }
    let buf;
    try { buf = esEnlace ? Buffer.from(`${fs.readlinkSync(abs)}\n`) : fs.readFileSync(abs); } catch { continue; }
    const binario = buf.subarray(0, 8000).includes(0);
    const texto = binario ? '' : buf.toString('utf8');
    const lineas = texto ? texto.split('\n') : [];
    if (lineas.length && lineas[lineas.length - 1] === '') lineas.pop();
    const parte = { ruta, estado: 'A', mas: binario ? 0 : lineas.length, menos: 0, binario };
    let parche = null;
    if (!binario && !cuenta.lleno) {
      parche = `diff --git a/${ruta} b/${ruta}\nnew file mode 100644 (sin trackear)\n--- /dev/null\n+++ b/${ruta}\n@@ -0,0 +1,${lineas.length} @@\n${lineas.map((x) => `+${x}`).join('\n')}${lineas.length ? '\n' : ''}`;
    }
    partes.push(conParche(parte, parche, cuenta));
  }
  return { partes, previo, omitidos };
}

function noMedido(motivo, extra) {
  return { version: VERSION, estado: 'no_medido', motivo, medido_en: new Date().toISOString(), ...(extra || {}) };
}

function armar({ volcado, estado }) {
  let d;
  try { d = JSON.parse(fs.readFileSync(volcado, 'utf8')); } catch (e) {
    return noMedido(`el registro de la ejecución no se pudo leer (${e.code || 'no es JSON'}): no se sabe qué repo mirar`);
  }
  const m = (d && d.marker) || {};
  if (!sanear) return { version: VERSION, estado: 'no_publicado', motivo: motivoSinSaneado, medido_en: new Date().toISOString() };
  if (!m.repoPath) return noMedido('el registro no dice en qué repo corrió (sin repoPath): no se sabe qué mirar');
  // Una ruta relativa se resolvería contra el cwd de ESTE proceso y se mediría otro repo, publicándolo como el
  // de la corrida. No se adivina.
  if (!path.isAbsolute(String(m.repoPath))) return noMedido(`el registro trae una ruta relativa del repo («${sanear(String(m.repoPath))}»): resolverla contra otra carpeta mediría un repo que no es el de la ejecución`);
  const ini = Date.parse(m.startedAt || '');
  if (!Number.isFinite(ini)) return noMedido('el registro no dice cuándo arrancó la ejecución (sin startedAt): no se puede saber qué commits son suyos');
  const finRaw = Date.parse(d.archivedAt || '');
  const v = { desde: ini - MARGEN_MS, hasta: (Number.isFinite(finRaw) ? finRaw : Date.now()) + MARGEN_MS };
  const ventana = { desde: new Date(v.desde).toISOString(), hasta: new Date(v.hasta).toISOString() };
  const hayGit = spawnSync('git', ['--version'], { stdio: 'ignore' });
  if (hayGit.error) return noMedido(`git no está en esta máquina (${hayGit.error.code || hayGit.error.message}): no se puede mirar el cambio`, { ventana });

  const cache = new Map();
  const repos = new Map(); // top → { por:Set, principal }
  const sumar = (top, por, principal) => {
    if (!top) return;
    const r = repos.get(top) || { por: new Set(), principal: false };
    r.por.add(por);
    if (principal) r.principal = true;
    repos.set(top, r);
  };
  const topPrincipal = raizDe(m.repoPath, cache);
  const principalExiste = fs.existsSync(m.repoPath);
  if (topPrincipal && principalExiste) sumar(topPrincipal, 'story', true);
  for (const f of Array.isArray(m.filesTouched) ? m.filesTouched : []) if (path.isAbsolute(String(f))) sumar(raizDe(f, cache), 'herramientas', false);
  const sid = String(m.sessionId || '');
  const estadoDir = estado || path.join(stateDirOf(os.homedir()));
  const consola = carpetasDeConsola(estadoDir);
  if (sid) {
    for (const e of leerJsonl(path.join(estadoDir, 'file-events', `${sid}.jsonl`))) if (e.path && enVentana(e.ts, v)) sumar(raizDe(e.path, cache), 'herramientas', false);
    for (const e of leerUnion(consola, `${sid}.jsonl`)) if (e.path && enVentana(e.ts, v)) sumar(raizDe(e.path, cache), 'consola', false);
  }

  // Otras sesiones que escribieron en estas copias dentro de la ventana. Sin sesión propia no se puede
  // distinguir la de la corrida de las demás: se declara y no se cuenta (contarlas daría un aviso falso).
  const otras = new Map();
  const otrasMotivo = sid ? null : 'el registro no trae sesión: no se puede saber si otra sesión escribió en esta copia';
  for (const dirs of [[path.join(estadoDir, 'file-events')], consola]) {
    const fs2 = new Set();
    for (const dir of dirs) {
      try { for (const x of fs.readdirSync(dir)) if (x.endsWith('.jsonl')) fs2.add(x); } catch { /* sin carpeta */ }
    }
    for (const f of fs2) {
      const otraSid = f.replace(/\.jsonl$/, '');
      if (otraSid === sid) continue;
      const recientes = dirs.filter((dir) => { try { return fs.statSync(path.join(dir, f)).mtimeMs >= v.desde; } catch { return false; } });
      if (!recientes.length) continue;
      for (const e of leerUnion(recientes, f)) {
        if (!e.path || !enVentana(e.ts, v)) continue;
        for (const top of repos.keys()) if (adentro(top, e.path)) { const s = otras.get(top) || new Set(); s.add(otraSid); otras.set(top, s); }
      }
    }
  }

  const cuenta = { bytes: 0, cortados: 0, sin_parche_por_tope: 0, lleno: false };
  const salida = [];
  let hilo = null; // se lee una sola vez, y sólo si alguna copia se compartió
  if (!topPrincipal || !principalExiste) {
    // `otras_sesiones: null`, no 0: de un repo que no está no se puede saber quién escribió en él
    // (sería la confusión «0 = no medido»).
    salida.push({ nombre: path.basename(String(m.repoPath)), principal: true, por: ['story'], estado: 'no_medido', motivo: principalExiste ? 'la carpeta de la ejecución no es un repo git' : 'la carpeta del repo de la ejecución ya no existe en esta máquina', otras_sesiones: null, otras_sesiones_motivo: 'no se pudo mirar este repo: no se puede saber si otra sesión escribió en él' });
  }
  const orden = [...repos.entries()].sort((a, b) => (b[1].principal - a[1].principal));
  for (const [top, info] of orden) {
    const por = ['story', 'herramientas', 'consola'].filter((x) => info.por.has(x));
    const base = { nombre: nombreDe(top), proyecto: proyectoDe(top), principal: info.principal, por,
      otras_sesiones: otrasMotivo ? null : (otras.get(top) || new Set()).size, ...(otrasMotivo ? { otras_sesiones_motivo: otrasMotivo } : {}) };
    const c = commitsDeLaCorrida(top, v);
    const commits = [];
    const deOtras = [];
    let fallo = null;
    // 🔴 En una copia compartida el reflog anota los commits de TODAS las sesiones: cada uno se atribuye con el
    // hilo antes de leer su parche (uno ajeno no gasta el tope de la corrida). Ver la cabecera.
    const compartida = !otrasMotivo && (otras.get(top) || new Set()).size > 0;
    if (compartida && !hilo) hilo = ventanasDelHilo(volcado);
    if (c.commits) {
      for (const h of c.commits) {
        let atribucion = null;
        if (compartida) {
          const cab = git(top, ['show', '-s', '--format=%cI%x00%s', h]);
          if (cab.error) { fallo = cab.error; break; }
          const [fecha, asunto] = cab.out.replace(/\n$/, '').split('\0');
          atribucion = atribuir(h, c.cuando.get(h), asunto, hilo);
          if (atribucion === 'de_otra_sesion') { deOtras.push({ h: h.slice(0, 12), fecha, asunto: sanear(asunto || '') }); continue; }
        }
        const x = partesDeCommit(top, h, cuenta);
        if (x.error) { fallo = x.error; break; }
        commits.push(atribucion ? { ...x, atribucion } : x);
      }
    }
    const sc = fallo ? null : sinCommitear(top, cuenta, v);
    if (fallo || (sc && sc.error)) {
      salida.push({ ...base, estado: 'no_medido', motivo: sanear(`git falló al leer este repo: ${fallo || sc.error}`) });
      continue;
    }
    salida.push({ ...base, estado: 'medido', commits: c.commits ? commits : null, ...(c.commits ? {} : { commits_motivo: sanear(String(c.commits_motivo || 'sin motivo declarado')) }),
      ...(compartida && c.commits ? { commits_de_otras_sesiones: deOtras, ...(hilo && hilo.error ? { atribucion_motivo: sanear(hilo.error) } : {}) } : {}), sin_commitear: sc.partes, sin_commitear_previo: sc.previo, ...(sc.omitidos.length ? { sin_commitear_omitidos: sc.omitidos.length } : {}) });
  }

  const archivos = new Set();
  let partes = 0;
  for (const r of salida) {
    if (r.estado !== 'medido') continue;
    for (const k of r.commits || []) for (const p of k.archivos) { archivos.add(`${r.nombre}\0${p.ruta}`); partes += 1; }
    for (const p of r.sin_commitear) { archivos.add(`${r.nombre}\0${p.ruta}`); partes += 1; }
  }
  // 🔴 Si ningún repo se pudo mirar, la corrida NO está medida: publicarla como `medido` con 0 archivos es
  // exactamente «no pude mirar» escrito como «no cambió nada». Los repos van igual, con su
  // motivo, porque son el detalle de por qué no se pudo.
  const medidos = salida.filter((r) => r.estado === 'medido');
  if (salida.length && !medidos.length) {
    return {
      version: VERSION, estado: 'no_medido',
      motivo: `${salida.length === 1 ? 'no se pudo mirar el repo de la ejecución' : `no se pudo mirar ninguno de los ${salida.length} repos de la ejecución`}: ${salida.map((r) => `${r.nombre} (${r.motivo || 'sin motivo'})`).join(' · ')}`,
      medido_en: new Date().toISOString(), ventana, repos: salida,
    };
  }
  return {
    version: VERSION, estado: 'medido', motivo: null, medido_en: new Date().toISOString(), ventana,
    repos: salida,
    totales: { repos: salida.length, archivos: archivos.size, partes, cortados: cuenta.cortados, sin_parche_por_tope: cuenta.sin_parche_por_tope },
    topes: { por_parte: TOPE_PARTE, por_corrida: TOPE_CORRIDA },
  };
}

function rutaDeSalida(volcado) { return String(volcado).replace(/\.json$/, '') + '.cambio.json.gz'; }

function main(argv) {
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const volcado = arg('--dump');
  if (!volcado) {
    process.stderr.write('uso: run-change.js --dump <v.json> [--state <dir>] [--output <archivo>]\n');
    return 2;
  }
  let x;
  try { x = armar({ volcado, estado: arg('--state') }); } catch (e) {
    x = noMedido(`el armado del cambio falló (${e && (e.code || e.message) ? String(e.code || e.message).split('\n')[0] : 'motivo desconocido'})`);
    if (sanear) x.motivo = sanear(x.motivo);
  }
  const salida = arg('--output') || rutaDeSalida(volcado);
  try {
    const tmp = `${salida}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify(x)));
    fs.renameSync(tmp, salida);
  } catch (e) {
    process.stderr.write(`cambio-de-corrida: no pude escribir la salida (${e.code || e.message})\n`);
    return 2;
  }
  const resumen = { estado: x.estado, repos: x.repos ? x.repos.length : 0, archivos: x.totales ? x.totales.archivos : 0, motivo: x.motivo || null };
  process.stdout.write(JSON.stringify(resumen) + '\n');
  return 0;
}

module.exports = { armar, numstat, rutaDeSalida, atribuir, ventanasDelHilo, CREA_COMMIT, TOPE_PARTE, TOPE_CORRIDA };

if (require.main === module) {
  require('../lib/legacy-names.js').aliasArgv('scripts/metrics/run-change.js', { exitCode: 2, prefix: 'cambio-de-corrida: ' });
  process.exit(main(process.argv.slice(2)));
}
