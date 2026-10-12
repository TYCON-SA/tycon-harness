#!/usr/bin/env node
'use strict';
/**
 * test-gate-report.js — el informe de test-gate.sh: lee lo que dejó el corredor de pruebas y escribe
 * `.advisors/tests-result.json` (story 8.17, tanda W6, AC 46).
 *
 * POR QUÉ ESTÁ EN NODE
 * Hasta la W6 esto era un bloque de Python embebido al final de test-gate.sh (`python3 - … <<'PY'`). En Windows
 * `python3` no es requisito del arnés —Node sí—, así que sin él el gate corría la suite y no dejaba artefacto: la
 * matriz de cierre marcaba todo NOT-RUN con la suite en verde. Se portó campo por campo: el mismo artefacto, la
 * misma copia que viaja, la misma línea de gates.log. La prueba (tests/test-gate-report.test.js, T69) compara la
 * salida contra la que escribía el bloque de Python sobre las mismas entradas, guardadas en
 * tests/fixtures/test-gate-report/.
 *
 * Tampoco depende de `timeout` ni de `realpath` (en un Git Bash pueden faltar): el tiempo máximo de cada `git` lo
 * pone spawnSync y la ruta real la resuelve `rutaReal()`, que hace lo que hacía `os.path.realpath` —resuelve lo que
 * existe y deja el resto como está—.
 *
 * Uso (los mismos argumentos posicionales que recibía el bloque de Python; los últimos son opcionales):
 *   node test-gate-report.js <runner> <repo> <repo_run> <results_dir> <out_file> <suite_exit> <story_id> <cov_min>
 *        <ts> [test_project_count] [scope] [scope_source] [declared_new] [code_state_json] [base_ref] [base_json]
 *
 * Exit 0 aunque falte algo: cada problema queda DICHO en el artefacto (totals_error, parse_error,
 * no_cross_check, touched_no_cross_check). Sale ≠0 sólo si no pudo escribir el artefacto, y test-gate.sh lo avisa.
 *
 * Fidelidad con el Python que reemplaza (lo que importa para que el JSON sea el mismo):
 *   - `dict.get(k, def)` devuelve el default sólo si la clave FALTA; un null presente queda null (`get()`).
 *   - el redondeo a un decimal es el de Python: el más cercano al valor exacto, y en un empate exacto (x,25 · x,75)
 *     el par (`redondear1()`);
 *   - el glob recursivo no entra a carpetas ocultas ni toma archivos ocultos (`buscarArchivos()`);
 *   - `cls.iter("line")` cuenta TODAS las `<line>` de la clase, también las de `<methods>` (`descendientes()`);
 *   - `max()` se queda con el primero salvo que el segundo sea mayor (`pyMax()`).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stateDir: stateDirOf } = require('./state-dir.js');   // story 8.23 (A2): la carpeta del estado, de una sola pieza
const { spawnSync } = require('child_process');

const OBS_HASTA = '2026-10-06';

// ── utilidades con la semántica de Python ────────────────────────────────────────────────────────────────────

const esObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const get = (o, k, def) => (esObjeto(o) && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : def);
const pyMax = (a, b) => (b > a ? b : a);
// `str.splitlines()`: corta en \n, \r\n, \r y los demás separadores de línea de Unicode.
const SPLITLINES = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
const splitlines = (s) => { const p = String(s).split(SPLITLINES); if (p.length && p[p.length - 1] === '') p.pop(); return p; };
const pyStrip = (s) => String(s).replace(/^[\s\x1c-\x1f\x85]+|[\s\x1c-\x1f\x85]+$/g, '');
const ordenar = (arr) => arr.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** round(x, 1) de Python: el decimal más cercano al valor EXACTO del double; en un empate exacto, el par. */
function redondear1(x) {
  if (!Number.isFinite(x)) return x;
  const cuartos = x * 4; // exacto en binario
  if (Number.isInteger(cuartos) && Math.abs(cuartos) % 2 === 1) {
    // |x| termina en ,25 o ,75 exactos: empate entre dos décimos, y Python se queda con el de cifra par (,2 u ,8)
    const entero = Math.trunc(Math.abs(x));
    const v = Number(`${entero}.${Math.abs(x) - entero === 0.25 ? 2 : 8}`);
    return x < 0 ? -v : v;
  }
  return Number(x.toFixed(1));
}

/** int() de Python sobre lo que puede venir en un JSON o un atributo; lanza como Python si no se puede. */
function pyInt(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') {
    if (Number.isNaN(v)) throw new Error('cannot convert float NaN to integer');
    if (!Number.isFinite(v)) throw new Error('cannot convert float infinity to integer');
    return Math.trunc(v);
  }
  if (typeof v === 'string') {
    const t = pyStrip(v).replace(/_/g, '');
    if (/^[+-]?\d+$/.test(t)) return parseInt(t, 10);
    const e = new Error(`invalid literal for int() with base 10: '${v}'`); e.valueError = true; throw e;
  }
  const e = new TypeError(`int() argument must be a string, a bytes-like object or a real number, not '${v === null ? 'NoneType' : typeof v}'`);
  e.typeError = true; throw e;
}

/** float() de Python sobre un atributo de texto. */
function pyFloat(v) {
  const t = pyStrip(String(v)).replace(/_/g, '');
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return Number(t);
  if (/^[+-]?nan$/i.test(t)) return NaN;
  if (/^[+-]?inf(inity)?$/i.test(t)) return t.startsWith('-') ? -Infinity : Infinity;
  throw new Error(`could not convert string to float: '${v}'`);
}

/** len() de Python: un null presente no tiene largo. */
function pyLen(v) {
  if (Array.isArray(v) || typeof v === 'string') return v.length;
  if (esObjeto(v)) return Object.keys(v).length;
  throw new TypeError(`object of type '${v === null ? 'NoneType' : typeof v}' has no len()`);
}

const leerJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const esArchivo = (f) => { try { return fs.statSync(f).isFile(); } catch (_) { return false; } };
const existe = (f) => { try { fs.statSync(f); return true; } catch (_) { return false; } };

/**
 * La ruta real, como `os.path.realpath` de Python: absoluta, con los enlaces resueltos en la parte que existe y el
 * resto tal cual. Es el reemplazo propio del comando `realpath`, que en un Git Bash puede faltar.
 */
function rutaReal(p) {
  let abs = path.resolve(p);
  const resto = [];
  const real = process.platform === 'win32' ? fs.realpathSync.native : fs.realpathSync;
  for (;;) {
    try {
      const base = real(abs);
      return resto.length ? path.join(base, ...resto) : base;
    } catch (_) {
      const arriba = path.dirname(abs);
      if (arriba === abs) return path.resolve(p);
      resto.unshift(path.basename(abs));
      abs = arriba;
    }
  }
}

/**
 * glob.glob(os.path.join(dir, "**", nombre), recursive=True): el archivo en `dir` y en cualquier subcarpeta, sin
 * entrar a las carpetas ocultas ni tomar archivos ocultos. `coincide(nombre)` decide el nombre del archivo.
 */
function buscarArchivos(dir, coincide) {
  const out = [];
  const visitar = (d) => {
    let entradas;
    try { entradas = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entradas) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      let esDir = e.isDirectory();
      if (e.isSymbolicLink()) { try { esDir = fs.statSync(full).isDirectory(); } catch (_) { esDir = false; } }
      if (esDir) visitar(full);
      else if (coincide(e.name)) out.push(full);
    }
  };
  visitar(dir);
  return out;
}

// ── XML: lo justo para un trx y un cobertura, con la forma de ElementTree ─────────────────────────────────────

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodificar(s, donde) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][\w.-]*);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    if (ENTIDADES[e] !== undefined) return ENTIDADES[e];
    throw new Error(`undefined entity &${e};: ${donde()}`);
  });
}
// Las expresiones se aplican en la posición exacta (bandera `y`): nada de copiar el resto del archivo en cada paso.
const RE_CIERRE = /<\/([^\s>/]+)\s*>/y;
const RE_NOMBRE = /<([A-Za-z_][\w.:-]*)/y;
const RE_ATRIBUTO = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
const RE_BLANCOS = /\s*/y;

/**
 * Lee un XML y devuelve la raíz: { tag, attrs, children, text }. `tag` lleva el espacio de nombres como lo escribe
 * ElementTree (`{ns}local`). Un XML mal formado lanza, como `ET.parse`.
 */
function leerXml(texto) {
  let i = 0;
  const n = texto.length;
  const pila = [];
  let raiz = null;
  const donde = () => { const antes = texto.slice(0, i); const l = antes.split('\n').length; return `line ${l}, column ${i - antes.lastIndexOf('\n') - 1}`; };
  const error = (m) => { throw new Error(`${m}: ${donde()}`); };
  const agregarTexto = (t) => {
    if (!pila.length) { if (pyStrip(t)) error('junk after document element'); return; }
    const el = pila[pila.length - 1];
    if (el.children.length) { const ult = el.children[el.children.length - 1]; ult.tail = (ult.tail || '') + t; } else el.text = (el.text || '') + t;
  };
  if (texto.charCodeAt(0) === 0xfeff) i = 1;
  while (i < n) {
    const lt = texto.indexOf('<', i);
    if (lt < 0) { agregarTexto(decodificar(texto.slice(i), donde)); i = n; break; }
    if (lt > i) agregarTexto(decodificar(texto.slice(i, lt), donde));
    i = lt;
    if (texto.startsWith('<!--', i)) { const f = texto.indexOf('-->', i + 4); if (f < 0) error('unclosed token'); i = f + 3; continue; }
    if (texto.startsWith('<![CDATA[', i)) { const f = texto.indexOf(']]>', i + 9); if (f < 0) error('unclosed token'); agregarTexto(texto.slice(i + 9, f)); i = f + 3; continue; }
    if (texto.startsWith('<?', i)) { const f = texto.indexOf('?>', i + 2); if (f < 0) error('unclosed token'); i = f + 2; continue; }
    if (texto.startsWith('<!', i)) {
      // DOCTYPE, con o sin subconjunto interno entre corchetes
      let prof = 0; let j = i + 2;
      for (; j < n; j++) { const ch = texto[j]; if (ch === '[') prof++; else if (ch === ']') prof--; else if (ch === '>' && prof <= 0) break; }
      if (j >= n) error('unclosed token');
      i = j + 1; continue;
    }
    if (texto[i + 1] === '/') {
      RE_CIERRE.lastIndex = i;
      const m = RE_CIERRE.exec(texto);
      if (!m) error('not well-formed (invalid token)');
      const el = pila.pop();
      if (!el || el.qname !== m[1]) error('mismatched tag');
      i += m[0].length;
      if (!pila.length) raiz = raiz || el;
      continue;
    }
    // etiqueta de apertura
    RE_NOMBRE.lastIndex = i;
    const mNombre = RE_NOMBRE.exec(texto);
    if (!mNombre) error('not well-formed (invalid token)');
    if (raiz && !pila.length) error('junk after document element');
    let j = i + mNombre[0].length;
    const crudos = [];
    let cerrada = false;
    for (;;) {
      RE_BLANCOS.lastIndex = j;
      RE_BLANCOS.exec(texto);
      j = RE_BLANCOS.lastIndex;
      if (j >= n) error('unclosed token');
      if (texto[j] === '>') { j++; break; }
      if (texto[j] === '/' && texto[j + 1] === '>') { j += 2; cerrada = true; break; }
      RE_ATRIBUTO.lastIndex = j;
      const mAttr = RE_ATRIBUTO.exec(texto);
      if (!mAttr) error('not well-formed (invalid token)');
      crudos.push([mAttr[1], decodificar(mAttr[2] !== undefined ? mAttr[2] : mAttr[3], donde)]);
      j += mAttr[0].length;
    }
    const padre = pila[pila.length - 1];
    // el mapa de espacios de nombres se copia sólo si el elemento declara alguno; si no, es el del padre
    let ns = padre ? padre.ns : {};
    if (crudos.some(([k]) => k === 'xmlns' || k.startsWith('xmlns:'))) {
      ns = Object.assign({}, ns);
      for (const [k, v] of crudos) {
        if (k === 'xmlns') ns[''] = v;
        else if (k.startsWith('xmlns:')) ns[k.slice(6)] = v;
      }
    }
    const nombrar = (q, esAtributo) => {
      const p = q.indexOf(':');
      if (p < 0) return esAtributo || !ns[''] ? q : `{${ns['']}}${q}`;
      const pre = q.slice(0, p);
      if (pre === 'xml') return `{http://www.w3.org/XML/1998/namespace}${q.slice(p + 1)}`;
      if (ns[pre] === undefined) error('unbound prefix');
      return `{${ns[pre]}}${q.slice(p + 1)}`;
    };
    const attrs = {};
    for (const [k, v] of crudos) if (k !== 'xmlns' && !k.startsWith('xmlns:')) attrs[nombrar(k, true)] = v;
    const el = { qname: mNombre[1], tag: nombrar(mNombre[1], false), attrs, children: [], text: null, tail: null, ns };
    if (padre) padre.children.push(el);
    i = j;
    if (cerrada) { if (!padre) raiz = el; } else pila.push(el);
  }
  if (pila.length || !raiz) error('no element found');
  return raiz;
}

/** element.iter(tag): el elemento mismo y todos sus descendientes con ese tag, en orden de documento. */
function descendientes(el, tag) {
  const out = [];
  const visitar = (e) => { if (e.tag === tag) out.push(e); for (const c of e.children) visitar(c); };
  visitar(el);
  return out;
}
const atributo = (el, k, def) => (Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : def);

// ── git, con su propio tiempo máximo (spawnSync, no el comando `timeout`) ───────────────────────────────────────

function correrGit(args, timeoutMs) {
  const r = spawnSync('git', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) {
    if (r.error.code === 'ETIMEDOUT') throw new Error(`Command '${['git', ...args].join(' ')}' timed out after ${timeoutMs / 1000} seconds`);
    throw r.error;
  }
  return { returncode: r.status === null ? -1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * Cuántas pruebas corrieron de verdad según los totales de cada corredor; null si no se pudo contar. Las `todo` no
 * corren: se descuentan (pase adversarial de la W6, hallazgo #7: una suite hecha sólo de `it.todo` salía 0 y verde).
 */
function pruebasCorridas(runner, t, todo = 0) {
  if (!esObjeto(t) || !Object.keys(t).length) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  if (runner === 'dotnet') return num(t.executed) !== null ? t.executed : num(t.total);
  if (runner === 'suites-json') return num(t.suites);
  if (runner === 'node-test') return num(t.executed) === null ? null : Math.max(0, t.executed - todo);
  const total = num(t.total);
  return total === null ? null : Math.max(0, total - (num(t.skipped) || 0) - todo);
}

/** El texto sin las secuencias de control de la terminal (colores y movimientos del cursor, `ESC [ … letra`). */
const sinAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');

/**
 * sum() de Python sobre números de punto flotante: desde la 3.12 es una suma compensada (Neumaier), y el promedio de
 * cobertura tiene que dar el mismo número (pase adversarial de la W6, hallazgo #9: 70,1 + 92,8 + 62,1 con una suma
 * simple da 224,99999999999997, y un promedio de 75 «no llegaba» al umbral de 75). Misma cuenta que CPython.
 */
function pySum(vals) {
  let s = 0; let c = 0;
  for (const x of vals) {
    const t = s + x;
    if (Math.abs(s) >= Math.abs(x)) c += (s - t) + x; else c += (x - t) + s;
    s = t;
  }
  return c && Number.isFinite(c) ? s + c : s;
}

// ── el informe ────────────────────────────────────────────────────────────────────────────────────────────────

function informe(argv) {
  const [runner, repo, repoRun, resultsDir, outFile, suiteExitTxt, storyId, covMinTxt, ts] = argv.slice(0, 9);
  if (argv.length < 9) throw new Error('faltan argumentos: <runner> <repo> <repo_run> <results_dir> <out_file> <suite_exit> <story_id> <cov_min> <ts>');
  const arg = (k) => (argv.length > k ? argv[k] : undefined);
  const testProjectCount = arg(9) !== undefined && /^\d+$/.test(arg(9)) ? parseInt(arg(9), 10) : 0;
  const scope = arg(10) !== undefined ? arg(10) : '';
  const scopeSource = arg(11) !== undefined ? arg(11) : '';
  const declaredNew = splitlines(arg(12) !== undefined ? arg(12) : '').map(pyStrip).filter(Boolean);
  let codeState;
  try {
    codeState = arg(13) !== undefined && pyStrip(arg(13)) ? JSON.parse(arg(13)) : { git: false };
  } catch (_) {
    codeState = { git: false };
  }
  const suiteExit = pyInt(suiteExitTxt);
  const covMin = pyFloat(covMinTxt);

  const result = {
    ts, story_id: storyId, runner, repo: repoRun,
    suite_exit: suiteExit, suite_green: suiteExit === 0,
    // `scope` = qué proyecto se miró; `scope_source` = quién lo decidió (explicito | story | diff). Sin esto, un
    // artefacto verde no dice QUÉ midió (2026-08-13).
    scope: scope || null, scope_source: scope ? scopeSource : null,
    halted: false,
    totals: {},
    coverage: { per_new_file: {}, new_files_pct: null, threshold: covMin, meets_threshold: null },
    provenance: 'test-gate.sh (run real, exit code capturado por marker.js run-check)',
    // Huella del código medido — la lee `suite-freshness.js check` (step-07b) para saber si este verde sigue
    // describiendo el working tree o quedó viejo tras iteraciones de fix.
    code_state: codeState,
  };

  // ── Totales ──
  // Las pruebas `todo` se cuentan aparte: no corren, pero jest y vitest las suman al total (y vitest, a las pasadas).
  // No van a `totals`, que sigue igual al del Python; sólo las descuenta `pruebasCorridas()` (hallazgo #7).
  let todo = 0;
  try {
    if (runner === 'dotnet') {
      // Con corrida secuencial por proyecto hay UN trx por ensamblado: se suman TODOS (fix 2026-06-11).
      const trx = buscarArchivos(resultsDir, (nm) => nm.endsWith('.trx'));
      if (trx.length) {
        const tot = { total: 0, passed: 0, failed: 0, executed: 0 };
        for (const tf of trx) {
          const t = leerXml(fs.readFileSync(tf, 'utf8'));
          // `{ns}` de la raíz, como hacía el Python: `.//x:Counters` con el espacio de nombres de la raíz
          const ns = t.tag.split('}')[0].replace(/^\{+|\{+$/g, '');
          const buscado = `{${ns}}Counters`;
          const c = descendientes(t, buscado).find((e) => e !== t);
          if (c) for (const k of Object.keys(tot)) tot[k] += pyInt(atributo(c, k, 0));
        }
        result.totals = tot;
        result.trx_files = trx.length;
        // trx_files < test_projects = corrida PARCIAL (un proyecto falló y la cadena && cortó antes de los siguientes).
        if (testProjectCount) {
          result.test_projects = testProjectCount;
          result.partial_run = trx.length < testProjectCount;
        }
      }
    } else if (runner === 'suites-json') {
      const sj = path.join(resultsDir, 'suites.json');
      if (existe(sj)) {
        const r = leerJson(sj);
        if (get(r, 'no_medido')) {
          result.totals_error = r.no_medido;
        } else {
          const fallas = get(r, 'fallas', []);
          result.totals = {
            suites: get(r, 'corridas', 0), passed: get(r, 'verdes', 0),
            failed: pyLen(fallas), missing: pyLen(get(r, 'ausentes', [])),
            failures: fallas.map((f) => path.basename(f.ruta)),
            missing_paths: get(r, 'ausentes', []),
            // story 7.15: lo que NO corrió a propósito (con el motivo), y cómo corrió el resto.
            deferred: pyLen(get(r, 'deferred_suites', [])),
            deferred_suites: get(r, 'deferred_suites', []),
            workers: get(r, 'workers', null),
            wall_ms: get(r, 'wall_ms', null),
          };
        }
      } else {
        result.totals_error = 'el runner de suites.json no dejó su resumen';
      }
    } else if (runner === 'node-test') {
      // `node --test` imprime el resumen como `ℹ tests N` / `ℹ pass N` / `ℹ fail N` / `ℹ skipped N`. Vale la ÚLTIMA
      // aparición de cada clave (con varios archivos hay resúmenes parciales y el global va al final). Si el formato
      // cambiara, `totals` queda {} y el artefacto lo dice — nunca se inventa un número.
      const nt = path.join(resultsDir, 'node-test.txt');
      if (existe(nt)) {
        // Sin las secuencias de color de la terminal (ANSI): con FORCE_COLOR, el `node --test` de Node ≥23 pinta el
        // resumen (`\x1b[34mℹ tests 2\x1b[39m`), la expresión no lo leía y una suite verde salía 6 «no se pudo contar»
        // (pase adversarial de la W6, hallazgos #3 y #4).
        const txt = sinAnsi(fs.readFileSync(nt, 'utf8'));
        const ult = (clave) => {
          const todas = [...txt.matchAll(new RegExp(`^\\s*(?:ℹ|#)\\s*${clave}\\s+(\\d+)\\s*$`, 'gm'))];
          return todas.length ? parseInt(todas[todas.length - 1][1], 10) : null;
        };
        const total = ult('tests'); const passed = ult('pass'); const failed = ult('fail'); const skipped = ult('skipped');
        todo = ult('todo') || 0;
        if (total !== null) {
          result.totals = { total, passed: passed || 0, failed: failed || 0, skipped: skipped || 0, executed: total - (skipped || 0) };
        } else {
          result.totals_error = 'no se pudo leer el resumen de `node --test` en node-test.txt';
        }
      }
    } else {
      // vitest y jest escriben el MISMO formato (vitest copió el reporter json de jest): una sola rama.
      const vj = [path.join(resultsDir, 'vitest.json'), path.join(resultsDir, 'jest.json')].find(existe);
      if (vj) {
        const d = leerJson(vj);
        const nTodo = get(d, 'numTodoTests', 0);
        todo = typeof nTodo === 'number' && Number.isFinite(nTodo) ? nTodo : 0;
        result.totals = {
          total: get(d, 'numTotalTests', 0), passed: get(d, 'numPassedTests', 0),
          failed: get(d, 'numFailedTests', 0), skipped: get(d, 'numPendingTests', 0),
        };
      }
    }
  } catch (e) {
    result.totals_error = String(e && e.message !== undefined ? e.message : e);
  }

  // ── Cero pruebas corridas no es verde (story 8.17, AC 50) ──
  // Acá el informe se aparta A PROPÓSITO del Python, que daba verde con cualquier salida 0. Caso de la tanda W6:
  // lanzado desde una prueba de `node --test`, el hijo heredaba NODE_TEST_CONTEXT, la suite escribía en el formato
  // interno de Node, no se contaba nada… y quedaba `suite_green: true`. La salida real de la suite se conserva.
  if (result.suite_green) {
    const corridas = pruebasCorridas(runner, result.totals, todo);
    if (!(corridas > 0)) {
      result.suite_green = false;
      result.no_tests_run = corridas === 0
        ? `la suite salió 0 pero no corrió ninguna prueba (${runner}): eso no es verde`
        : `la suite salió 0 pero no se pudo contar ninguna prueba corrida (${runner}${result.totals_error ? `: ${result.totals_error}` : ', no dejó su resumen'}): eso no es verde`;
      process.stderr.write(`[test-gate] 🔴 ${result.no_tests_run}\n`);
    }
  }

  // ── Archivos NUEVOS del diff (agregados + sin seguimiento, sólo código) ──
  const nuevos = new Set();
  try {
    for (const w of correrGit(['-C', repo, 'diff', 'HEAD', '--name-only', '--diff-filter=A'], 20000).stdout.split(/\s+/)) if (w) nuevos.add(w);
    for (const w of correrGit(['-C', repo, 'ls-files', '--others', '--exclude-standard'], 20000).stdout.split(/\s+/)) if (w) nuevos.add(w);
  } catch (_) { /* sin git: no hay archivos nuevos que mirar */ }
  const codeRe = /\.(cs|ts|tsx|js|jsx)$/;
  const testRe = /(\.test\.|\.spec\.|Tests?\.cs$|__tests__|test-utils)/;
  let newFiles = ordenar([...nuevos].filter((f) => codeRe.test(f) && !testRe.test(f)));
  let newFilesSource = newFiles.length ? 'git' : null;

  // Respaldo post-commit (2026-08-25): apenas la story se commitea, `--diff-filter=A` no reporta nada; se cae a los
  // archivos que la story declara CREAR y se dice de dónde salió la lista.
  if (!newFiles.length && declaredNew.length) {
    const cand = ordenar([...new Set(declaredNew.map((f) => f.split('\\').join('/')))].filter((f) => codeRe.test(f) && !testRe.test(f)));
    const existentes = cand.filter((f) => esArchivo(path.join(repo, f)));
    if (existentes.length) {
      newFiles = existentes;
      newFilesSource = 'story:files_to_create';
    }
    const faltantes = cand.filter((f) => !existentes.includes(f));
    if (faltantes.length) result.coverage.declared_not_found = faltantes;
  }

  // ── Cobertura por archivo nuevo ──
  const perFile = new Map();
  try {
    if (runner === 'dotnet') {
      // Fix 2026-08-25 (guides/incident-log.md#case-coverage-max-per-class-2026-08-25): SUMAR líneas por archivo
      // DENTRO de cada cobertura (en C# cada método async es una clase aparte con el mismo archivo), y recién ahí
      // max() ENTRE coberturas distintas (un ensamblado que no tocó el archivo lo reporta en 0).
      for (const cobf of buscarArchivos(resultsDir, (nm) => nm === 'coverage.cobertura.xml')) {
        const root = leerXml(fs.readFileSync(cobf, 'utf8'));
        const local = new Map(); // archivo → [líneas cubiertas, líneas totales, mejor line-rate]
        for (const cls of descendientes(root, 'class')) {
          const fn = String(atributo(cls, 'filename', '') || '').split('\\').join('/');
          const lr = atributo(cls, 'line-rate', null);
          if (!fn || lr === null) continue;
          let cov = 0; let tot = 0;
          for (const ln of descendientes(cls, 'line')) {
            tot += 1;
            try {
              if (pyInt(atributo(ln, 'hits', '0') || 0) > 0) cov += 1;
            } catch (e) {
              if (!e.valueError) throw e;
            }
          }
          if (!local.has(fn)) local.set(fn, [0, 0, 0.0]);
          const acc = local.get(fn);
          acc[0] += cov;
          acc[1] += tot;
          acc[2] = pyMax(acc[2], pyFloat(lr) * 100);
        }
        for (const [fn, [cov, tot, bestLr]] of local) {
          // Sin líneas medibles (interfaces, records sin cuerpo): se cae al line-rate declarado, no a un 0 inventado.
          const pct = tot ? (cov / tot) * 100 : bestLr;
          perFile.set(fn, pyMax(perFile.has(fn) ? perFile.get(fn) : 0, pct));
        }
      }
    } else {
      const covf = path.join(repoRun, 'coverage', 'coverage-final.json');
      if (existe(covf)) {
        const d = leerJson(covf);
        for (const [ruta, entry] of Object.entries(d)) {
          const s = get(entry, 's', {});
          if (s && pyLen(s)) {
            const vals = Object.values(s);
            const covered = vals.filter((v) => v > 0).length;
            perFile.set(ruta.split('\\').join('/'), (covered / vals.length) * 100);
          }
        }
      }
    }
  } catch (e) {
    result.coverage.parse_error = String(e && e.message !== undefined ? e.message : e);
  }

  const matched = {};
  for (const nf of newFiles) {
    const base = nf.split('\\').join('/');
    let hit = null;
    for (const [f, pct] of perFile) { if (f.endsWith(base) || base.endsWith(f)) { hit = pct; break; } }
    matched[nf] = hit !== null ? redondear1(hit) : null;
  }
  const coveredVals = Object.values(matched).filter((v) => v !== null);
  result.coverage.per_new_file = matched;
  result.coverage.new_files_source = newFilesSource;
  result.coverage.new_files_without_coverage_data = Object.keys(matched).filter((k) => matched[k] === null);
  if (coveredVals.length) {
    const avg = pySum(coveredVals) / coveredVals.length;
    result.coverage.new_files_pct = redondear1(avg);
    result.coverage.meets_threshold = avg >= covMin;
  } else if (runner === 'suites-json') {
    // Este corredor no produce cobertura: son suites sueltas de node/bash, sin instrumentación.
    result.coverage.no_cross_check = 'sin cruce de cobertura: el runner suites.json corre suites sueltas (node/bash) y no produce reporte de cobertura';
  } else if (!newFiles.length) {
    result.coverage.no_cross_check = 'sin cruce de cobertura: git no reporta archivos nuevos'
      + (declaredNew.length ? ' y la story no declara `files_to_create` existentes'
        : ' y no se pasó la ruta de la story (\\$2) para caer a `files_to_create`');
  } else {
    result.coverage.no_cross_check = 'sin cruce de cobertura: hay archivos nuevos pero ninguno aparece en el reporte de cobertura';
  }

  // ── Cobertura de las LÍNEAS TOCADAS (story 2.4 del arnés, 2026-09-16) ──
  // El denominador son las líneas que la story agregó o modificó desde la BASE (argumentos 15 y 16) que el reporte
  // lista como ejecutables. Una línea que el reporte no lista no entra; un archivo tocado sin datos se lista aparte;
  // sin base, sin diff, sin reporte o con un corredor sin cobertura → null CON MOTIVO; no frena hasta OBS_HASTA.
  const baseRef = arg(14) !== undefined ? arg(14) : null; // null = llamada vieja sin base
  let baseInfoError = null;
  let baseInfo;
  try {
    baseInfo = arg(15) !== undefined && pyStrip(arg(15)) ? JSON.parse(arg(15)) : {};
    if (!esObjeto(baseInfo)) {
      baseInfoError = 'la descripción de la base no es un objeto JSON';
      baseInfo = {};
    }
  } catch (e) {
    baseInfoError = `la descripción de la base es ilegible (${e.message})`;
    baseInfo = {};
  }
  const cov = result.coverage;
  cov.touched_lines_pct = null;
  cov.touched_lines = null;
  cov.touched_files_without_coverage_data = [];
  const descartadasCrudas = get(baseInfo, 'descartadas') || [];
  cov.touched_base = {
    ref: baseRef || null, source: get(baseInfo, 'source', null),
    descartadas: typeof descartadasCrudas === 'string' ? Array.from(descartadasCrudas)
      : Array.isArray(descartadasCrudas) ? descartadasCrudas.slice() : Object.keys(descartadasCrudas),
  };
  if (baseInfoError) cov.touched_base.descartadas.push({ source: 'test-gate', motivo: baseInfoError });
  cov.touched_files_ambiguous = [];
  cov.touched_files_unreadable = [];
  cov.observacion = {
    frena: false, hasta: OBS_HASTA,
    nota: 'el 75 % sobre las líneas tocadas se observa sin frenar; cada corrida deja en gates.log si habría frenado',
  };
  let touchedMotivo = null;

  const git = (top, args) => correrGit(['-C', top, '-c', 'core.quotePath=false', ...args], 30000);
  const real = (p) => { try { return rutaReal(p).split('\\').join('/'); } catch (_) { return String(p).split('\\').join('/'); } };
  const resolverClave = (k, bases) => {
    if (path.isAbsolute(k)) return real(k);
    for (const b of bases) { const cand = path.join(b, k); if (existe(cand)) return real(cand); }
    return k;
  };

  /** {ruta relativa al toplevel: Set(líneas)} con lo agregado/modificado desde `ref` + lo no trackeado. */
  const lineasTocadas = (repoDir, ref, ilegibles) => {
    let r = git(repoDir, ['rev-parse', '--show-toplevel']);
    if (r.returncode !== 0) throw new Error('la carpeta medida no es un repo git');
    const top = pyStrip(r.stdout);
    // Con detección de renombres (-M): un archivo movido aporta sólo lo que cambió (pase adversarial 2026-09-16).
    r = git(top, ['diff', '--no-color', '--no-ext-diff', '-M', '-U0', ref, '--']);
    if (r.returncode !== 0) throw new Error(`git diff contra ${ref.slice(0, 12)} falló: ${pyStrip(r.stderr || '').slice(0, 200)}`);
    const out = new Map();
    let actual = null;
    for (const ln of splitlines(r.stdout)) {
      if (ln.startsWith('+++ ')) {
        const dest = ln.slice(4);
        actual = dest === '/dev/null' ? null : (dest.startsWith('b/') ? dest.slice(2) : dest);
      } else if (ln.startsWith('@@') && actual) {
        const m = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(ln);
        if (m) {
          const ini = parseInt(m[1], 10); const cant = m[2] !== undefined ? parseInt(m[2], 10) : 1;
          if (cant > 0) {
            if (!out.has(actual)) out.set(actual, new Set());
            for (let k = ini; k < ini + cant; k++) out.get(actual).add(k);
          }
        }
      }
    }
    r = git(top, ['ls-files', '--others', '--exclude-standard', '-z']);
    if (r.returncode !== 0) throw new Error(`git ls-files falló: ${pyStrip(r.stderr || '').slice(0, 200)}`);
    for (const f of r.stdout.split('\0').filter(Boolean)) {
      let nLineas;
      try {
        const txt = fs.readFileSync(path.join(top, f), 'utf8');
        // las líneas como las cuenta Python al iterar un archivo de texto: \n, \r\n y \r cortan
        nLineas = txt === '' ? 0 : (txt.match(/\r\n|\r|\n/g) || []).length + (/[\r\n]$/.test(txt) ? 0 : 1);
      } catch (_) {
        // No se cuenta, pero se NOMBRA: un archivo nuevo que no se pudo leer no desaparece en silencio.
        ilegibles.push(f);
        continue;
      }
      if (nLineas) out.set(f, new Set(Array.from({ length: nLineas }, (_, k) => k + 1)));
    }
    return { top, tocadas: out };
  };

  /** {ruta del reporte: Map(línea → cubierta)}. Lanza si el reporte existe y no se puede leer. */
  const mapaDeLineas = () => {
    const mapa = new Map();
    if (runner === 'dotnet') {
      const cobs = buscarArchivos(resultsDir, (nm) => nm === 'coverage.cobertura.xml');
      if (!cobs.length) throw new Error('la corrida no dejó reporte de cobertura (coverage.cobertura.xml)');
      for (const cobf of cobs) {
        const root = leerXml(fs.readFileSync(cobf, 'utf8'));
        const fuentes = descendientes(root, 'source').map((x) => pyStrip(x.text || '')).filter(Boolean);
        for (const cls of descendientes(root, 'class')) {
          const fn = String(atributo(cls, 'filename', '') || '').split('\\').join('/');
          if (!fn) continue;
          const clave = resolverClave(fn, fuentes);
          if (!mapa.has(clave)) mapa.set(clave, new Map());
          const dst = mapa.get(clave);
          for (const l of descendientes(cls, 'line')) {
            let nro; let hit;
            try {
              nro = pyInt(atributo(l, 'number', null));
              hit = pyInt(atributo(l, 'hits', '0') || 0) > 0;
            } catch (e) {
              if (e.valueError || e.typeError) continue;
              throw e;
            }
            // entre clases y entre ensamblados: una línea está cubierta si ALGUNO la ejecutó
            dst.set(nro, (dst.has(nro) ? dst.get(nro) : false) || hit);
          }
        }
      }
    } else {
      const covf = path.join(repoRun, 'coverage', 'coverage-final.json');
      if (!existe(covf)) throw new Error('la corrida no dejó reporte de cobertura (coverage/coverage-final.json)');
      const d = leerJson(covf);
      for (const [ruta, entry] of Object.entries(d)) {
        const sm = get(entry, 'statementMap') || {};
        const s = get(entry, 's') || {};
        const dst = new Map();
        // Igual que istanbul: una línea es medible si una sentencia EMPIEZA en ella.
        for (const [k, loc] of Object.entries(sm)) {
          let nro;
          try {
            if (!esObjeto(loc) || !esObjeto(loc.start) || !('line' in loc.start)) continue;
            nro = pyInt(loc.start.line);
          } catch (e) {
            if (e.valueError || e.typeError) continue;
            throw e;
          }
          dst.set(nro, (dst.has(nro) ? dst.get(nro) : false) || (get(s, k, 0) || 0) > 0);
        }
        if (dst.size) mapa.set(resolverClave(ruta.split('\\').join('/'), [repoRun]), dst);
      }
    }
    return mapa;
  };

  /**
   * (datos, "ok") · (null, "sin-datos") · (null, "ambiguo"). Una clave ABSOLUTA sólo calza por igualdad exacta; una
   * relativa que no se pudo ubicar calza sólo si CONTIENE toda la ruta tocada y es la ÚNICA candidata (pase
   * adversarial 2026-09-16).
   */
  const buscar = (mapa, top, rel) => {
    const objetivo = real(path.join(top, rel));
    if (mapa.has(objetivo)) return [mapa.get(objetivo), 'ok'];
    if (mapa.has(rel)) return [mapa.get(rel), 'ok'];
    const cands = [...mapa.keys()].filter((k) => !path.isAbsolute(k) && k.endsWith('/' + rel));
    if (cands.length === 1) return [mapa.get(cands[0]), 'ok'];
    if (cands.length > 1) return [null, 'ambiguo'];
    return [null, 'sin-datos'];
  };

  if (baseRef === null) {
    touchedMotivo = 'sin cruce de líneas tocadas: test-gate no pasó una base al parser';
  } else if (runner === 'node-test' || runner === 'suites-json') {
    touchedMotivo = `sin cruce de líneas tocadas: el runner ${runner} no produce cobertura`;
  } else if (!baseRef) {
    const razones = cov.touched_base.descartadas.filter(esObjeto).map((x) => String(get(x, 'motivo', ''))).join('; ');
    touchedMotivo = 'sin cruce de líneas tocadas: no hay base contra la que comparar' + (razones ? ` (${razones})` : '');
  } else {
    try {
      const ilegibles = [];
      const { top, tocadas: todas } = lineasTocadas(repoRun, baseRef, ilegibles);
      cov.touched_files_unreadable = ordenar(ilegibles);
      // El alcance es la carpeta que se TESTEÓ (repo_run), no el contenedor (pase adversarial 2026-09-16).
      const pref = path.relative(rutaReal(top), rutaReal(repoRun)).split('\\').join('/');
      const tocadas = new Map([...todas].filter(([f]) => codeRe.test(f) && !testRe.test(f)
        && (pref === '.' || pref === '' || f.startsWith(pref + '/'))));
      if (!tocadas.size) {
        touchedMotivo = `sin cruce de líneas tocadas: no hay líneas de código tocadas desde ${cov.touched_base.source || 'la base'} (${baseRef.slice(0, 12)})`;
      } else {
        const mapa = mapaDeLineas();
        const per = {}; const sinDatos = []; const ambiguos = [];
        let cTot = 0; let mTot = 0;
        for (const f of ordenar([...tocadas.keys()])) {
          const [lm, como] = buscar(mapa, top, f);
          if (lm === null) {
            sinDatos.push(f);
            if (como === 'ambiguo') ambiguos.push(f);
            continue;
          }
          const med = [...tocadas.get(f)].filter((l) => lm.has(l));
          const cub = med.filter((l) => lm.get(l)).length;
          per[f] = { covered: cub, measurable: med.length, pct: med.length ? redondear1((cub / med.length) * 100) : null };
          cTot += cub;
          mTot += med.length;
        }
        cov.touched_files_without_coverage_data = sinDatos;
        cov.touched_files_ambiguous = ambiguos;
        cov.touched_lines = { covered: cTot, measurable: mTot, per_file: per };
        if (mTot) cov.touched_lines_pct = redondear1((cTot / mTot) * 100);
        else if (!Object.keys(per).length) touchedMotivo = 'sin cruce de líneas tocadas: ninguno de los archivos tocados aparece en el reporte de cobertura';
        else touchedMotivo = 'sin cruce de líneas tocadas: el reporte no lista como ejecutable ninguna de las líneas tocadas';
      }
    } catch (e) {
      cov.touched_lines = null;
      touchedMotivo = `sin cruce de líneas tocadas: ${e && e.message !== undefined ? e.message : e}`;
    }
  }

  if (touchedMotivo) cov.touched_no_cross_check = touchedMotivo;
  if (cov.touched_lines_pct !== null) {
    cov.threshold_basis = 'touched_lines';
    cov.meets_threshold = cov.touched_lines_pct >= covMin;
  } else if (get(cov, 'new_files_pct') !== null && get(cov, 'new_files_pct') !== undefined) {
    cov.threshold_basis = 'new_files';
  } else {
    cov.threshold_basis = null;
  }

  // Constancia de la observación en gates.log — sólo nombre y estado (lo único que lee el reductor), más el repo.
  // Ni porcentajes ni rutas de archivos. Una llamada vieja sin base no escribe: no es una corrida del gate.
  if (baseRef !== null) {
    try {
      const estado = cov.touched_lines_pct === null ? 'no-medido' : (cov.meets_threshold ? 'cumple' : 'habria-frenado');
      const sd = path.join(stateDirOf(os.homedir()));
      fs.mkdirSync(sd, { recursive: true });
      const linea = {
        ts: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
        // Si bash no pudo resolverla, la MISMA cadena que lib/session-id.js (Claude → banco → Codex).
        sessionId: process.env.GATE_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID
          || process.env.TYCON_SESSION_ID || process.env.CODEX_SESSION_ID || '_nosession',
        repoPath: repo, name: 'cobertura-tocada', status: estado, storyId,
      };
      fs.appendFileSync(path.join(sd, 'gates.log'), JSON.stringify(linea) + '\n', 'utf8');
    } catch (e) {
      process.stderr.write(`[test-gate] ⚠️  no pude dejar la constancia de cobertura-tocada en gates.log (${e.message})\n`);
    }
  }

  fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
  process.stdout.write(`[test-gate] Artefacto: ${outFile}\n`);

  // La copia que VIAJA (2026-09-06): `.advisors/tests-result.json` está en el .gitignore, así que se pierde con
  // cualquier limpieza y no existe en otra máquina ni en CI; sin él runtime-matrix.js no cuenta ningún test como
  // evidencia. La copia va al evidence-dir de la story y lleva SÓLO lo que la matriz lee.
  const claveCopia = process.env.TYCON_EVIDENCE_KEY || storyId;
  // La clave nombra un archivo: sólo letras, números y `. _ + ~ -`, sin `..` (una barra la escribiría afuera).
  const claveSegura = !!claveCopia && /^[A-Za-z0-9][A-Za-z0-9._+~-]*$/.test(String(claveCopia)) && !String(claveCopia).includes('..');
  if (storyId && !claveSegura) {
    process.stderr.write(`[test-gate] ⚠️  la copia sellada NO se escribe: «${claveCopia}» no sirve para nombrar evidencia\n`);
  } else if (storyId && process.env.TYCON_EVIDENCE_KEY_FAILED) {
    process.stderr.write(`[test-gate] ⚠️  la copia sellada NO se escribe: no se pudo calcular la clave de la evidencia (${process.env.TYCON_EVIDENCE_KEY_FAILED.trim()})\n`);
  } else if (storyId) {
    try {
      const evDir = process.env.TYCON_EVIDENCE_DIR || path.join(repo, '.advisors', 'dod-runtime');
      fs.mkdirSync(evDir, { recursive: true });
      const sellada = {
        kind: 'tests-result-sellado',
        story_id: storyId,
        ts: get(result, 'ts', null),
        runner: get(result, 'runner', null),
        suite_exit: get(result, 'suite_exit', null),
        suite_green: get(result, 'suite_green', null),
        halted: get(result, 'halted', null),
        totals: get(result, 'totals', null),
        coverage: get(result, 'coverage', null),
        provenance: get(result, 'provenance', null),
        _por_que: 'copia que VIAJA de .advisors/tests-result.json, que git ignora. Sin ella, en otra '
          + 'máquina o tras una limpieza ningún test de la tabla cuenta como evidencia y la story '
          + 'no se puede cerrar (caso 2026-09-06, stories 2.2 y 2.3 del arnés). Sólo los campos '
          + 'que runtime-matrix.js lee: sin rutas absolutas ni datos de la máquina.',
      };
      // Nombrada con la CLAVE de la evidencia (story 1.17), que test-gate.sh calcula desde la ruta de la
      // story y deja en TYCON_EVIDENCE_KEY: con un número repetido en el repo, `<id>-tests-result.json`
      // sería de cualquiera de las stories que lo comparten. Sin la variable, el id como siempre.
      const dest = path.join(evDir, `${claveCopia}-tests-result.json`);
      fs.writeFileSync(dest, JSON.stringify(sellada, null, 2), 'utf8');
      process.stdout.write(`[test-gate] Copia que viaja: ${dest}\n`);
    } catch (e) { // nunca rompe el gate: el artefacto original ya está escrito
      process.stderr.write(`[test-gate] ⚠️  no pude dejar la copia que viaja (${e.message})\n`);
    }
  }
  process.stdout.write(`[test-gate] suite_exit=${suiteExit} totals=${JSON.stringify(result.totals)} new_files_pct=${result.coverage.new_files_pct} touched_lines_pct=${cov.touched_lines_pct}`
    + (newFilesSource ? ` (archivos nuevos: ${newFilesSource})` : '') + '\n');
  if (result.coverage.no_cross_check) process.stderr.write(`[test-gate] ⚠️  ${result.coverage.no_cross_check}\n`);
  if (cov.touched_no_cross_check) process.stderr.write(`[test-gate] ⚠️  ${cov.touched_no_cross_check}\n`);
  return result;
}

module.exports = { informe, leerXml, redondear1, rutaReal, buscarArchivos };

if (require.main === module) {
  try {
    informe(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`[test-gate] el informe falló: ${e && e.stack ? e.stack : e}\n`);
    process.exit(1);
  }
}
