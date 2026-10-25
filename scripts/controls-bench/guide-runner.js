#!/usr/bin/env node
'use strict';
/**
 * guide-runner.js — ¿una guía cambia lo que hace un agente? La misma tarea, dos veces: con la guía en el árbol de trabajo
 * y con la guía escondida. De cada corrida saca si el agente la leyó y si la tarea le salió bien.
 *
 *   node guide-runner.js [--cases <carpeta>] [--case <nombre>] [--runs N] [--json <informe>]
 *
 * EL CASO. `cases/guides/<nombre>.json` declara la guía (`guide`, ruta dentro del arnés), la tarea que recibe el agente
 * (`task`), los archivos del árbol de juguete (`tree`), el corrector (`corrector`, un `.js` al lado del caso) y, si hace
 * falta, `runs`, `model` y `timeout_s`. El corrector exporta `corregir({ dir, toolLog, salida }) → { score, motivo }`,
 * con `score` entre 0 y 1, y puede exportar `preparar(dir)` para lo que el árbol no alcanza a decir (un repo git, un
 * cambio sin commitear). Corrige un programa, nunca otro modelo: el mismo resultado da siempre el mismo puntaje.
 *
 * EL ÁRBOL. Cada corrida arranca en una carpeta temporal con los archivos del caso, un `CLAUDE.md` con la fila del
 * índice que nombra la guía (como la lee un agente en el arnés real) y la guía copiada del arnés. «Sin la guía» es el
 * mismo árbol sin ese archivo: el índice queda igual, así lo único que cambia es si la guía está.
 *
 * LA CORRIDA. `claude -p --output-format stream-json`, sin la configuración del usuario (`isolation.js`), sin ganchos y
 * con tope de gasto, con el mismo modelo en los dos lados. `TYCON_GUIDE_AGENT` reemplaza al agente por otro programa
 * (las pruebas corren así, sin modelo). Por defecto, UNA corrida por lado: 6 sesiones por examen con los 3 casos. Más
 * corridas, sólo por configuración; con una sola, el informe lo dice («señal gruesa: 1 corrida»).
 *
 * EL RESULTADO. Por guía: el % de corridas con la guía que la leyeron, el puntaje medio con y sin ella, y `revisar: true`
 * cuando con la guía no sale mejor. Una guía marcada se revisa a mano: este programa no borra ni apaga nada. Sale 0
 * cuando midió, aunque marque guías; 2 con un caso inválido y 3 cuando un caso no se pudo medir (ninguna corrida de un
 * lado llegó a corregirse). En los dos últimos lo dice: «no pude medir: …». Una corrida cuenta como medida sólo si el
 * agente terminó bien y el corrector devolvió un puntaje: un error del agente, del árbol o del corrector (su git, su
 * lint) es «no pude medir», nunca un 0.
 *
 * EL INFORME (`--json`) se reemplaza de una vez (temporal y renombre) y nunca pierde lo medido: una guía que esta vez no
 * se pudo medir conserva su resultado anterior, con la fecha en que se midió (`medido_en`). Los motivos de `no_medido`
 * van saneados (sin rutas ni credenciales): el examen sube este archivo al repo.
 *
 * Casos: scripts/tests/guide-runner.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TCG = path.resolve(__dirname, '..', '..');
const CASOS_POR_DEFECTO = path.join(__dirname, 'cases', 'guides');
const RUNS_POR_DEFECTO = 1;
const MODELO_POR_DEFECTO = 'sonnet';
const TIMEOUT_POR_DEFECTO_S = 420;
const TOPE_USD_POR_CORRIDA = '0.5';
const HERRAMIENTAS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'];

/** `{ ok, motivo }`: un caso sin tarea, sin guía en el arnés o sin corrector no se corre. */
function validarCaso(caso, dirCaso, raiz = TCG) {
  if (!caso || typeof caso !== 'object') return { ok: false, motivo: 'el caso no es un objeto' };
  if (typeof caso.task !== 'string' || !caso.task.trim()) return { ok: false, motivo: 'el caso no tiene tarea (task)' };
  if (typeof caso.guide !== 'string' || !caso.guide) return { ok: false, motivo: 'el caso no nombra su guía (guide)' };
  if (!path.resolve(raiz, caso.guide).startsWith(path.resolve(raiz) + path.sep) || !fs.existsSync(path.join(raiz, caso.guide)))
    return { ok: false, motivo: `la guía ${caso.guide} no está en el arnés` };
  if (caso.tree !== undefined && (typeof caso.tree !== 'object' || caso.tree === null || Array.isArray(caso.tree)))
    return { ok: false, motivo: 'el árbol (tree) no es un objeto ruta → contenido' };
  if (typeof caso.corrector !== 'string' || !caso.corrector) return { ok: false, motivo: 'el caso no tiene corrector' };
  const ruta = path.join(dirCaso, caso.corrector);
  if (!fs.existsSync(ruta)) return { ok: false, motivo: `el corrector ${caso.corrector} no existe` };
  let mod;
  try { mod = require(ruta); } catch (e) { return { ok: false, motivo: `el corrector ${caso.corrector} no carga: ${e.message}` }; }
  if (typeof mod.corregir !== 'function') return { ok: false, motivo: `el corrector ${caso.corrector} no exporta corregir()` };
  if (caso.runs !== undefined && !(Number.isInteger(caso.runs) && caso.runs >= 1)) return { ok: false, motivo: 'runs no es un entero ≥ 1' };
  return { ok: true };
}

/** Los casos de una carpeta, cada uno con su validez. Una guía sin caso no aparece: no se mide. */
function cargarCasos(dir) {
  // absoluta: `require` de una ruta relativa sin `./` buscaría un paquete
  dir = path.resolve(dir);
  let nombres;
  try { nombres = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch (_) { return []; }
  return nombres.map((f) => {
    const nombre = f.replace(/\.json$/, '');
    let caso = null;
    try { caso = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
    catch (e) { return { nombre, caso: {}, dir, validez: { ok: false, motivo: `no es JSON: ${e.message}` } }; }
    return { nombre, caso, dir, validez: validarCaso(caso, dir) };
  });
}

/** El árbol de trabajo de una corrida, en una carpeta temporal. Devuelve su ruta. */
function armarArbol(caso, { conGuia, raiz = TCG }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-bench-'));
  try {
    for (const [rel, contenido] of Object.entries(caso.tree || {})) {
      const destino = path.join(dir, rel);
      if (!destino.startsWith(dir + path.sep)) throw new Error(`el árbol del caso sale de su carpeta: ${rel}`);
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      fs.writeFileSync(destino, contenido);
    }
    const fila = caso.index_row || `| ${caso.task.split('\n')[0].slice(0, 80)} | \`${caso.guide}\` |`;
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'),
      `# Guías\n\nLeé la guía que corresponde a la tarea antes de hacerla.\n\n| Trabajando en... | Leer |\n|---|---|\n${fila}\n`);
    if (conGuia) {
      const destino = path.join(dir, caso.guide);
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      fs.copyFileSync(path.join(raiz, caso.guide), destino);
    }
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return dir;
}

/** Los `tool_use` de un registro `stream-json`, en orden: `[{ name, input }]`. Lo que no es JSON se saltea. */
function usosDeHerramientas(stream) {
  const usos = [];
  for (const linea of String(stream || '').split('\n')) {
    if (!linea.trim()) continue;
    let d;
    try { d = JSON.parse(linea); } catch (_) { continue; }
    const contenido = d && d.type === 'assistant' && d.message && Array.isArray(d.message.content) ? d.message.content : [];
    for (const b of contenido) if (b && b.type === 'tool_use') usos.push({ name: b.name, input: b.input || {} });
  }
  return usos;
}

/**
 * ¿El registro muestra una lectura de la guía? Read de su ruta, o un Bash que la nombra. Con `arbol`, la ruta del Read
 * tiene que ser la de la guía en ESE árbol (o relativa a él): un archivo con el mismo nombre en otro lado no cuenta.
 */
function leyoLaGuia(stream, guia, arbol) {
  const base = path.basename(guia);
  const propias = new Set([guia]);
  if (arbol) {
    propias.add(path.join(arbol, guia));
    try { propias.add(path.join(fs.realpathSync(arbol), guia)); } catch (_) { /* el árbol ya no está: queda la ruta tal cual */ }
  }
  return usosDeHerramientas(stream).some((u) => {
    if (u.name === 'Read') {
      const f = u.input.file_path;
      if (typeof f !== 'string') return false;
      return arbol ? propias.has(f) : (f === guia || f.endsWith(`/${guia}`));
    }
    if (u.name === 'Bash') return typeof u.input.command === 'string' && u.input.command.includes(base);
    return false;
  });
}

/**
 * El evento `result` con que termina una corrida de `stream-json`, o `null`. Un `result` de error (`is_error`, o un
 * `subtype` que no es `success`: se acabó el tope de gasto, se cortó por turnos) no es una respuesta.
 */
function resultadoDe(stream) {
  let res = null;
  for (const l of String(stream || '').split('\n')) {
    try { const d = JSON.parse(l); if (d && d.type === 'result') res = d; } catch (_) { /* no es un evento */ }
  }
  return res;
}

let _sanear;
/** Rutas y credenciales fuera del texto: el informe viaja al repo. */
function sanear(txt) {
  if (_sanear === undefined) {
    try { _sanear = require(path.join(TCG, 'scripts', 'metrics', 'tokens-digest.js')).sanear; } catch (_) { _sanear = null; }
  }
  // sin el saneador (la copia del banco), no se arriesga: del motivo queda sólo el principio, antes de cualquier detalle
  return _sanear ? _sanear(String(txt)) : `${String(txt).split(/[:(—/]/)[0].trim()} (detalle oculto)`;
}

function promedio(xs) { return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : null; }

/** El resultado de una guía a partir de sus corridas medidas de cada lado. */
function resumir({ guia, con, sin }) {
  const c = con.filter((r) => r.medida);
  const s = sin.filter((r) => r.medida);
  const puntajeCon = promedio(c.map((r) => r.score));
  const puntajeSin = promedio(s.map((r) => r.score));
  // la señal la da el lado con menos corridas medidas; las que no se midieron se cuentan aparte, no se esconden
  const corridas = Math.min(c.length, s.length);
  const sinMedir = (con.length - c.length) + (sin.length - s.length);
  return Object.assign({
    guia,
    corridas,
    leyo_pct: c.length ? Math.round((c.filter((r) => r.leyo).length / c.length) * 100) : null,
    puntaje_con: puntajeCon,
    puntaje_sin: puntajeSin,
    revisar: puntajeCon !== null && puntajeSin !== null && puntajeCon <= puntajeSin,
    senal: corridas === 1 ? 'señal gruesa: 1 corrida' : null,
  }, sinMedir ? { sin_medir: sinMedir } : {},
  // 0 de los dos lados: el caso es lo que hay que mirar antes que la guía
  puntajeCon === 0 && puntajeSin === 0 ? { ninguno_lo_logro: true } : {});
}

function lanzar(bin, args, { cwd, timeoutS }) {
  return new Promise((res) => {
    const hijo = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { TYCON_EVAL_SANDBOX: '1' }) });
    let out = '', err = '';
    const corte = setTimeout(() => { try { hijo.kill('SIGKILL'); } catch (_) { /* ya terminó */ } }, timeoutS * 1000);
    hijo.stdout.on('data', (d) => (out += d));
    hijo.stderr.on('data', (d) => (err += d));
    hijo.on('error', (e) => { clearTimeout(corte); res({ code: null, out, err: String(e && e.message) }); });
    hijo.on('close', (code) => { clearTimeout(corte); res({ code, out, err }); });
  });
}

let _settings = null;
/** La configuración de la corrida: esfuerzo fijo y sin ganchos, como el examen de revisores. */
function settingsDeCorrida() {
  if (!_settings) {
    _settings = path.join(os.tmpdir(), `guide-bench-settings-${process.pid}.json`);
    fs.writeFileSync(_settings, JSON.stringify({ effortLevel: 'high', disableAllHooks: true }));
  }
  return _settings;
}

/** Cómo se lanza el agente: el inyectado (`TYCON_GUIDE_AGENT`) o `claude`. */
function comandoDelAgente(caso) {
  const inyectado = process.env.TYCON_GUIDE_AGENT;
  const args = ['-p', caso.task, '--model', caso.model || MODELO_POR_DEFECTO, '--output-format', 'stream-json', '--verbose'];
  if (inyectado) return inyectado.endsWith('.js') ? { bin: process.execPath, args: [inyectado, ...args] } : { bin: inyectado, args };
  const { rutaDeHerramienta } = require('./tools-path.js');
  const { claudeIsolation } = require('./isolation.js');
  return {
    bin: rutaDeHerramienta('claude'),
    args: [...args, '--max-budget-usd', TOPE_USD_POR_CORRIDA, '--settings', settingsDeCorrida(),
      ...claudeIsolation().args, '--allowedTools', HERRAMIENTAS.join(',')],
  };
}

/** Una corrida: arma el árbol, lanza al agente y corrige. `{ medida, score, leyo, motivo }`. */
async function correrUna(entrada, conGuia) {
  const { caso, dir: dirCaso } = entrada;
  let corrector, arbol, bin, args;
  try {
    corrector = require(path.join(dirCaso, caso.corrector));
    arbol = armarArbol(caso, { conGuia });
    if (typeof corrector.preparar === 'function') corrector.preparar(arbol);
    ({ bin, args } = comandoDelAgente(caso));
  } catch (e) {
    if (arbol) fs.rmSync(arbol, { recursive: true, force: true });
    return { medida: false, motivo: `no pude preparar la corrida: ${e && e.message}` };
  }
  try {
    const r = await lanzar(bin, args, { cwd: arbol, timeoutS: caso.timeout_s || TIMEOUT_POR_DEFECTO_S });
    const res = resultadoDe(r.out);
    if (r.code !== 0 || !res || res.is_error || (res.subtype && res.subtype !== 'success')) {
      const ultima = r.err.trim().split('\n').pop();
      const motivo = r.code === null ? `el agente no terminó (${ultima || 'cortado'})`
        : r.code !== 0 || !res ? `el agente salió ${r.code} sin contestar${ultima ? `: ${ultima}` : ''}`
          : `el agente terminó con error (${res.subtype || 'is_error'})`;
      return { medida: false, motivo };
    }
    let nota;
    try { nota = corrector.corregir({ dir: arbol, toolLog: usosDeHerramientas(r.out), salida: r.out }); }
    catch (e) { return { medida: false, motivo: `el corrector falló: ${e.message}` }; }
    const score = Number(nota && nota.score);
    if (!Number.isFinite(score) || score < 0 || score > 1) return { medida: false, motivo: 'el corrector no devolvió un puntaje entre 0 y 1' };
    return { medida: true, score, leyo: conGuia ? leyoLaGuia(r.out, caso.guide, arbol) : false, motivo: (nota && nota.motivo) || '' };
  } finally {
    fs.rmSync(arbol, { recursive: true, force: true });
  }
}

// sin la opción, undefined; con la opción y sin valor (la última, o seguida de otra opción), null
function argVal(argv, flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? null : v;
}

/**
 * Escribe el informe sin perder lo medido antes: cada guía que esta vez no se midió conserva su resultado anterior.
 * `medido_en` arriba es la fecha de la última medición (la de antes si esta vez no se midió nada). Temporal y renombre:
 * un corte a mitad de camino deja el informe anterior entero.
 */
function escribirInforme(informe, guias, problemas) {
  const ruta = path.resolve(informe);
  let anterior = null;
  try { anterior = JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch (_) { /* primera vez, o ilegible: no hay qué conservar */ }
  const nuevas = new Set(guias.map((g) => g.caso));
  const viejas = anterior && Array.isArray(anterior.guias) ? anterior.guias.filter((g) => g && !nuevas.has(g.caso)) : [];
  const ahora = new Date().toISOString();
  const medidoEn = guias.length ? ahora : (anterior && (anterior.medido_en || anterior.ts)) || null;
  const datos = { kind: 'casos-de-guia', ts: ahora, medido_en: medidoEn, guias: [...viejas, ...guias], no_medido: problemas };
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  const tmp = `${ruta}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(datos, null, 2) + '\n');
    fs.renameSync(tmp, ruta);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('guide-runner.js [--cases <carpeta>] [--case <nombre>] [--runs N] [--json <informe>] — ver la cabecera');
    return 0;
  }
  const sinValor = ['--cases', '--case', '--runs', '--json'].find((f) => argVal(argv, f) === null);
  if (sinValor) { console.error(`guías: ${sinValor} sin valor`); return 2; }
  const dir = argVal(argv, '--cases') || CASOS_POR_DEFECTO;
  const soloCaso = argVal(argv, '--case');
  const runsArg = argVal(argv, '--runs');
  if (runsArg !== undefined && !(/^\d+$/.test(runsArg) && Number(runsArg) >= 1)) { console.error(`guías: --runs no es un entero ≥ 1 («${runsArg}»)`); return 2; }
  const informe = argVal(argv, '--json');

  const entradas = cargarCasos(dir).filter((e) => !soloCaso || e.nombre === soloCaso);
  const problemas = [];
  if (!entradas.length) problemas.push(sanear(`no hay casos en ${dir}${soloCaso ? ` con el nombre ${soloCaso}` : ''}`));
  const invalidos = entradas.filter((e) => !e.validez.ok);
  for (const e of invalidos) problemas.push(sanear(`${e.nombre}: caso inválido — ${e.validez.motivo}`));

  const guias = [];
  for (const e of entradas.filter((x) => x.validez.ok)) {
    const n = runsArg ? Number(runsArg) : (e.caso.runs || RUNS_POR_DEFECTO);
    const con = [], sin = [];
    for (let i = 0; i < n; i++) {
      con.push(await correrUna(e, true));
      sin.push(await correrUna(e, false));
    }
    const ladoSinMedir = [['con la guía', con], ['sin la guía', sin]].find(([, rs]) => !rs.some((r) => r.medida));
    if (ladoSinMedir) {
      const motivo = ladoSinMedir[1].map((r) => r.motivo).filter(Boolean)[0] || 'ninguna corrida se corrigió';
      problemas.push(sanear(`${e.nombre}: no pude medir ${ladoSinMedir[0]} — ${motivo}`));
      continue;
    }
    const res = Object.assign({ caso: e.nombre }, resumir({ guia: e.caso.guide, con, sin }), { medido_en: new Date().toISOString() });
    guias.push(res);
    console.log(`guías: ${e.caso.guide} — la leyó ${res.leyo_pct}% · con ${res.puntaje_con} · sin ${res.puntaje_sin}`
      + `${res.revisar ? ' · revisar esta guía: con ella no sale mejor' : ''}`
      + `${res.ninguno_lo_logro ? ' (ninguno de los dos lados lo logró: mirar el caso)' : ''}`
      + `${res.sin_medir ? ` · ${res.sin_medir} corrida(s) sin medir` : ''}${res.senal ? ` (${res.senal})` : ''}`);
  }

  const noMedido = problemas.length > 0;
  for (const p of problemas) console.error(`guías: no pude medir: ${p}`);
  if (informe) escribirInforme(informe, guias, problemas);
  if (!noMedido) return 0;
  return invalidos.length || !entradas.length ? 2 : 3;
}

module.exports = { validarCaso, cargarCasos, armarArbol, usosDeHerramientas, leyoLaGuia, resumir, main, RUNS_POR_DEFECTO };

if (require.main === module) {
  main(process.argv.slice(2))
    .then((c) => { process.exitCode = c; })
    .catch((e) => { console.error(`guías: ${e && e.message}`); process.exitCode = 1; });
}
