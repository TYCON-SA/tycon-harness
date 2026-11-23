#!/usr/bin/env node
'use strict';
/**
 * subtraction-test.js — la prueba de resta: ¿el resultado cumple igual sin un control? Cada historia de juguete corre dos
 * veces por modelo, con el control y sin él, en un laboratorio aislado, y el informe dice cuántas cumplieron de cada
 * lado y cuánto costó cada lado. No apaga nada fuera del laboratorio: qué se hace con un control lo decide una
 * persona, con este número a la vista.
 *
 *   node subtraction-test.js [--cases <carpeta>] [--case <nombre>] [--model <modelo>]... [--runs N] [--json <informe>]
 *                            [--harness <arnés>]
 *
 * EL CASO. `cases/subtraction/<nombre>.json` (en scripts/controls-bench) declara:
 *   · `control`: el nombre del control, como lo nombra la tabla de controles. Una exigencia no se prueba, porque no se
 *     apaga para ningún modelo: ni las que `scripts/metrics/controls-classification.json` marca así, ni las reglas de safety-guard
 *     (`ESC-C*`), ni los controles del pipeline que protegen las historias (`story-gate`);
 *   · `quitar`: cómo se quita en el laboratorio, de una de dos formas. `env` usa una llave de apagado que el arnés ya
 *     tiene (`scripts/lib/env-switches.json`, con un valor de su `apagan`), y sólo en el ambiente de los ganchos del
 *     laboratorio. `neutralizar` (`{ archivo, buscar, poner }`, o una lista) cambia un texto que aparece una sola vez en
 *     la copia del arnés, como hace `vacuity-audit.js` con un caso del banco. No se suman llaves nuevas: una llave la
 *     puede usar cualquier agente en la máquina real, y apagaría el control para todos los modelos;
 *   · `ganchos`: los ganchos de `scripts/setup/hooks-list.json` (su `spec`) que corren en el laboratorio;
 *   · `historias`: las historias de juguete, cada una con su tarea (`task`), su árbol (`tree`, ruta → contenido) y su
 *     corrector (`corrector`, un `.js` al lado del caso). El corrector exporta `corregir({ dir, toolLog, salida, casa })
 *     → { cumple, motivo }` (con `sesion` además) y puede exportar `preparar({ dir, casa, arnes, sesion })` para lo que
 *     el árbol no alcanza a decir
 *     (un repo git, una ejecución del pipeline abierta en la casa del laboratorio). Corrige un programa, nunca otro
 *     modelo;
 *   · `k`: cuántas corridas medidas por lado hacen falta para decidir (por defecto, una por historia).
 *
 * EL LABORATORIO. Una copia del arnés por lado (sin `.git`), una casa de laboratorio por corrida en la carpeta temporal
 * (nunca la HOME de quien corre) y un árbol de trabajo por corrida. Los ganchos se escriben con la ruta de la copia y
 * con `HOME` en la casa del laboratorio: lo que anotan cae ahí y se borra al terminar. Los comandos que corre el agente
 * ven la misma casa (`env` de la configuración); el agente mismo arranca con la HOME de quien corre, porque con otra no
 * encuentra su sesión iniciada, y no guarda la sesión (`--no-session-persistence`). El agente corre con
 * `claude -p --output-format stream-json`, sin la configuración del usuario (`isolation.js`), sin guardar la sesión y
 * con tope de gasto. `TYCON_SUBTRACTION_AGENT` reemplaza al agente por otro programa (las pruebas corren así, sin
 * modelo).
 *
 * EL RESULTADO. Por control y por modelo: cuántas corridas se midieron de cada lado, cuántas cumplieron y su costo
 * (`total_cost_usd` del agente), y `cumple_igual`. Con menos de `k` corridas medidas de un lado sale «no alcanza para
 * decidir» y `cumple_igual: null`. Una corrida que no se pudo medir (el agente no terminó, el corrector falló) se cuenta
 * aparte, nunca como «no cumple». Sale 0 cuando midió, 2 con un caso inválido y 3 cuando un lado no tuvo ninguna corrida
 * medida.
 *
 * Casos: scripts/tests/subtraction-test.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const TCG = path.resolve(__dirname, '..', '..');
const BANCO = path.join(TCG, 'scripts', 'controls-bench');
const CASOS_POR_DEFECTO = path.join(BANCO, 'cases', 'subtraction');
// los dos modelos que se comparan si el caso ni la línea de comandos dicen otros
const MODELOS_POR_DEFECTO = ['claude-opus-5-5', 'claude-sonnet-5-5'];
const RUNS_POR_DEFECTO = 1;
const TIMEOUT_POR_DEFECTO_S = 600;
const TOPE_USD_POR_CORRIDA = '1';
const HERRAMIENTAS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'];
// las exigencias que la clasificación no nombra por su clave: las reglas de safety-guard y el freno de las historias
const REGLA_DE_SAFETY_GUARD = /^ESC-C\d+$/;
const EXIGENCIAS_DEL_PIPELINE = new Set(['story-gate']);

function leerJson(ruta, porDefecto) {
  try { return JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch (_) { return porDefecto; }
}

function adentro(base, ruta) {
  const r = path.resolve(base, ruta);
  return r.startsWith(path.resolve(base) + path.sep) ? r : null;
}

/** null si el control se puede probar, o el motivo por el que es una exigencia. */
function esExigencia(control, arnes) {
  const clasificacion = leerJson(path.join(arnes, 'scripts', 'metrics', 'controls-classification.json'), {});
  const entrada = clasificacion && clasificacion[control];
  if (entrada && entrada.tipo === 'exigencia') return `el control ${control} es una exigencia según la clasificación`;
  if (REGLA_DE_SAFETY_GUARD.test(control)) return `el control ${control} es una exigencia: es una regla de safety-guard`;
  if (EXIGENCIAS_DEL_PIPELINE.has(control)) return `el control ${control} es una exigencia: protege las historias`;
  return null;
}

/** Las neutralizaciones de `quitar`, siempre como lista. */
function neutralizaciones(quitar) {
  const n = quitar && quitar.neutralizar;
  return n === undefined ? [] : Array.isArray(n) ? n : [n];
}

/** null si `quitar` es válido contra el arnés, o el motivo. */
function validarQuitar(quitar, arnes) {
  const conEnv = quitar && quitar.env !== undefined;
  const ns = neutralizaciones(quitar);
  if (!conEnv && !ns.length) return 'el caso no dice cómo se quita el control (quitar.env o quitar.neutralizar)';
  if (conEnv) {
    if (typeof quitar.env !== 'object' || quitar.env === null || Array.isArray(quitar.env) || !Object.keys(quitar.env).length)
      return 'quitar.env no es un objeto llave → valor';
    const llaves = (leerJson(path.join(arnes, 'scripts', 'lib', 'env-switches.json'), {}).entradas) || [];
    for (const [nombre, valor] of Object.entries(quitar.env)) {
      const e = llaves.find((x) => x && x.nombre === nombre);
      if (!e) return `${nombre} no es una llave del arnés: el laboratorio no suma llaves nuevas`;
      if (!(e.apagan || []).includes(String(valor))) return `${nombre}=${valor} no la apaga (la apagan: ${(e.apagan || []).join(', ') || 'ningún valor'})`;
    }
  }
  for (const n of ns) {
    if (!n || typeof n.archivo !== 'string' || typeof n.buscar !== 'string' || !n.buscar || typeof n.poner !== 'string')
      return 'una neutralización no trae archivo, buscar y poner';
    const ruta = adentro(arnes, n.archivo);
    if (!ruta || !fs.existsSync(ruta)) return `la neutralización nombra ${n.archivo}, que no está en el arnés`;
    const veces = fs.readFileSync(ruta, 'utf8').split(n.buscar).length - 1;
    if (veces !== 1) return `el texto a neutralizar aparece ${veces} veces en ${n.archivo}: tiene que aparecer una sola`;
  }
  return null;
}

/** `{ ok, motivo }`: un caso que no se puede correr, o que pide probar una exigencia, no se corre. */
function validarCaso(caso, dirCaso, arnes = TCG) {
  if (!caso || typeof caso !== 'object') return { ok: false, motivo: 'el caso no es un objeto' };
  if (typeof caso.control !== 'string' || !caso.control) return { ok: false, motivo: 'el caso no nombra su control' };
  const exigencia = esExigencia(caso.control, arnes);
  if (exigencia) return { ok: false, motivo: `${exigencia}: no va a la prueba de resta` };
  const q = validarQuitar(caso.quitar, arnes);
  if (q) return { ok: false, motivo: q };
  const lista = leerJson(path.join(arnes, 'scripts', 'setup', 'hooks-list.json'), {});
  const ganchos = caso.ganchos === undefined ? [] : caso.ganchos;
  if (!Array.isArray(ganchos)) return { ok: false, motivo: 'ganchos no es una lista' };
  for (const spec of ganchos) {
    if (typeof spec !== 'string' || spec.startsWith('@int:')) return { ok: false, motivo: `el gancho ${spec} no se arma en el laboratorio` };
    if (!((lista && lista.hooks) || []).some((h) => h.spec === spec)) return { ok: false, motivo: `el gancho ${spec} no está en la lista de ganchos del arnés` };
  }
  if (!Array.isArray(caso.historias) || !caso.historias.length) return { ok: false, motivo: 'el caso no trae historias' };
  for (const h of caso.historias) {
    const quien = (h && h.nombre) || '(sin nombre)';
    if (!h || typeof h.task !== 'string' || !h.task.trim()) return { ok: false, motivo: `la historia ${quien} no tiene tarea (task)` };
    if (h.tree !== undefined && (typeof h.tree !== 'object' || h.tree === null || Array.isArray(h.tree)))
      return { ok: false, motivo: `el árbol de la historia ${quien} no es un objeto ruta → contenido` };
    if (typeof h.corrector !== 'string' || !h.corrector) return { ok: false, motivo: `la historia ${quien} no tiene corrector` };
    let mod;
    try { mod = require(path.join(dirCaso, h.corrector)); } catch (e) { return { ok: false, motivo: `el corrector ${h.corrector} no carga: ${e.message}` }; }
    if (typeof mod.corregir !== 'function') return { ok: false, motivo: `el corrector ${h.corrector} no exporta corregir()` };
  }
  const k = caso.k === undefined ? caso.historias.length : caso.k;
  if (!(Number.isInteger(k) && k >= 1)) return { ok: false, motivo: 'k no es un entero ≥ 1' };
  if (k > caso.historias.length) return { ok: false, motivo: `k (${k}) es mayor que sus historias (${caso.historias.length})` };
  return { ok: true };
}

/** Los casos de una carpeta, cada uno con su validez. */
function cargarCasos(dir, arnes = TCG) {
  dir = path.resolve(dir);
  let nombres;
  try { nombres = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch (_) { return []; }
  return nombres.map((f) => {
    const nombre = f.replace(/\.json$/, '');
    let caso = null;
    try { caso = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
    catch (e) { return { nombre, caso: {}, dir, validez: { ok: false, motivo: `no es JSON: ${e.message}` } }; }
    return { nombre, caso, dir, validez: validarCaso(caso, dir, arnes) };
  });
}

/**
 * Una copia del arnés en la carpeta temporal, sin `.git`, con las neutralizaciones aplicadas. Lo que se cambia, se
 * cambia acá: el arnés de verdad no se toca.
 */
function copiarArnes(arnes, neutralizar = []) {
  const copia = fs.mkdtempSync(path.join(os.tmpdir(), 'resta-arnes-copia-'));
  try {
    fs.cpSync(arnes, copia, { recursive: true, filter: (src) => !/(^|[\\/])\.git$/.test(src) });
    for (const n of neutralizar) {
      const ruta = path.join(copia, n.archivo);
      fs.writeFileSync(ruta, fs.readFileSync(ruta, 'utf8').replace(n.buscar, () => n.poner));
    }
  } catch (e) {
    fs.rmSync(copia, { recursive: true, force: true });
    throw e;
  }
  return copia;
}

/**
 * La casa de una corrida: una carpeta nueva en la temporal. Nunca la HOME de quien corre, ni algo adentro de ella: ahí
 * escriben los ganchos del laboratorio.
 */
function casaDelLaboratorio({ home = os.homedir() } = {}) {
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'resta-casa-'));
  const h = path.resolve(home);
  const c = path.resolve(casa);
  if (c === h || c.startsWith(h + path.sep) || h.startsWith(c + path.sep)) {
    fs.rmSync(casa, { recursive: true, force: true });
    throw new Error('la casa del laboratorio no puede ser la HOME de quien corre ni quedar adentro de ella');
  }
  return casa;
}

const comillas = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** La ruta de un gancho de la lista dentro de una copia del arnés (como `repoPathOf` de apply-hooks.js). */
function rutaDelGancho(spec, copia) {
  if (spec.startsWith('@tcg:')) return path.join(copia, 'scripts', 'hooks', spec.slice(5));
  return path.join(copia, 'skills', spec);
}

/**
 * La configuración de los ganchos del laboratorio: cada gancho pedido, con su evento y su matcher de la lista, con la
 * ruta de la copia y con `HOME` en la casa del laboratorio (más la llave de `quitar.env`, del lado sin el control).
 */
function settingsDelLaboratorio({ ganchos, lista, copia, casa, env = {} }) {
  // el arnés de la copia: sin él, un gancho busca el de la casa (que no tiene) y avisa que no lo encuentra
  const prefijo = [`HOME=${comillas(casa)}`, `TYCON_GUIDES_DIR=${comillas(copia)}`, `TYCON_EVAL_SANDBOX=${comillas('1')}`,
    ...Object.entries(env).map(([k, v]) => `${k}=${comillas(v)}`)].join(' ');
  const hooks = {};
  for (const spec of ganchos) {
    for (const h of ((lista && lista.hooks) || []).filter((x) => x.spec === spec)) {
      const abs = rutaDelGancho(spec, copia);
      const correr = abs.endsWith('.sh') ? 'bash' : comillas(process.execPath);
      const gancho = Object.assign({ type: 'command', command: `${prefijo} ${correr} ${comillas(abs)}` }, h.timeout ? { timeout: h.timeout } : {});
      (hooks[h.event] = hooks[h.event] || []).push({ matcher: h.matcher || '', hooks: [gancho] });
    }
  }
  // `env` de la configuración: los comandos que corre el agente también ven la casa del laboratorio. El agente mismo arranca
  // con la HOME de quien corre, porque con otra no encuentra su sesión iniciada
  return { effortLevel: 'high', env: { HOME: casa, TYCON_GUIDES_DIR: copia, TYCON_EVAL_SANDBOX: '1' }, hooks };
}

/** El árbol de trabajo de una corrida, en una carpeta temporal. */
function armarArbol(historia) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resta-arbol-'));
  try {
    for (const [rel, contenido] of Object.entries(historia.tree || {})) {
      const destino = adentro(dir, rel);
      if (!destino) throw new Error(`el árbol de la historia sale de su carpeta: ${rel}`);
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      fs.writeFileSync(destino, contenido);
    }
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return dir;
}

/** Los `tool_use` de un registro `stream-json`, en orden. */
function usosDeHerramientas(stream) {
  const usos = [];
  for (const linea of String(stream || '').split('\n')) {
    let d;
    try { d = JSON.parse(linea); } catch (_) { continue; }
    const contenido = d && d.type === 'assistant' && d.message && Array.isArray(d.message.content) ? d.message.content : [];
    for (const b of contenido) if (b && b.type === 'tool_use') usos.push({ name: b.name, input: b.input || {} });
  }
  return usos;
}

/** El evento `result` con que termina una corrida, o `null`. */
function resultadoDe(stream) {
  let res = null;
  for (const l of String(stream || '').split('\n')) {
    try { const d = JSON.parse(l); if (d && d.type === 'result') res = d; } catch (_) { /* no es un evento */ }
  }
  return res;
}

let _sanear;
/** Rutas y credenciales fuera del texto: el informe puede viajar a un repo. */
function sanear(txt) {
  if (_sanear === undefined) {
    try { _sanear = require(path.join(TCG, 'scripts', 'metrics', 'tokens-digest.js')).sanear; } catch (_) { _sanear = null; }
  }
  return _sanear ? _sanear(String(txt)) : `${String(txt).split(/[:(—/]/)[0].trim()} (detalle oculto)`;
}

const redondear = (x) => Math.round(x * 10000) / 10000;

/** Un lado medido: cuántas corridas, cuántas cumplieron y cuánto costaron (null si ninguna dijo su costo). */
function lado(corridas) {
  const medidas = corridas.filter((r) => r.medida);
  const costos = medidas.map((r) => r.costo_usd).filter((c) => Number.isFinite(c));
  return {
    corridas: medidas.length,
    cumplieron: medidas.filter((r) => r.cumple).length,
    costo_usd: costos.length ? redondear(costos.reduce((a, b) => a + b, 0)) : null,
  };
}

/** El resultado de un control con un modelo, a partir de las corridas de cada lado. */
function resumir({ control, modelo, k, con, sin }) {
  const c = lado(con);
  const s = lado(sin);
  const sinMedir = (con.length - c.corridas) + (sin.length - s.corridas);
  const alcanza = c.corridas >= k && s.corridas >= k;
  return Object.assign({ control, modelo, k, con: c, sin: s }, sinMedir ? { sin_medir: sinMedir } : {}, {
    cumple_igual: alcanza ? c.cumplieron / c.corridas === s.cumplieron / s.corridas : null,
    veredicto: alcanza ? null : 'no alcanza para decidir',
  });
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

/** Cómo se lanza el agente: el inyectado (`TYCON_SUBTRACTION_AGENT`) o `claude`. */
function comandoDelAgente({ task, modelo, settings, sesion }) {
  const inyectado = process.env.TYCON_SUBTRACTION_AGENT;
  // la sesión la elige el corredor: la ejecución del pipeline que prepara un caso se anota con ella
  const args = ['-p', task, '--model', modelo, '--output-format', 'stream-json', '--verbose', '--settings', settings, '--session-id', sesion];
  if (inyectado) return inyectado.endsWith('.js') ? { bin: process.execPath, args: [inyectado, ...args] } : { bin: inyectado, args };
  const { rutaDeHerramienta } = require(path.join(BANCO, 'tools-path.js'));
  const { claudeIsolation } = require(path.join(BANCO, 'isolation.js'));
  return {
    bin: rutaDeHerramienta('claude'),
    args: [...args, '--no-session-persistence', '--max-budget-usd', TOPE_USD_POR_CORRIDA,
      ...claudeIsolation().args, '--allowedTools', HERRAMIENTAS.join(',')],
  };
}

/** Una corrida: arma el árbol y la casa, lanza al agente y corrige. `{ medida, cumple, costo_usd, motivo }`. */
async function correrUna({ entrada, historia, modelo, copia, env, lista }) {
  const { caso, dir: dirCaso } = entrada;
  let corrector, arbol, casa, bin, args;
  const sesion = crypto.randomUUID();
  const limpiar = () => { for (const d of [arbol, casa]) if (d) fs.rmSync(d, { recursive: true, force: true }); };
  try {
    corrector = require(path.join(dirCaso, historia.corrector));
    arbol = armarArbol(historia);
    casa = casaDelLaboratorio();
    if (typeof corrector.preparar === 'function') corrector.preparar({ dir: arbol, casa, arnes: copia, sesion });
    const settings = path.join(casa, 'resta-settings.json');
    fs.writeFileSync(settings, JSON.stringify(settingsDelLaboratorio({ ganchos: caso.ganchos || [], lista, copia, casa, env })));
    ({ bin, args } = comandoDelAgente({ task: historia.task, modelo, settings, sesion }));
  } catch (e) {
    limpiar();
    return { medida: false, motivo: `no pude preparar la ejecución: ${e && e.message}` };
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
    try { nota = corrector.corregir({ dir: arbol, toolLog: usosDeHerramientas(r.out), salida: r.out, casa, sesion }); }
    catch (e) { return { medida: false, motivo: `el corrector falló: ${e.message}` }; }
    if (!nota || typeof nota.cumple !== 'boolean') return { medida: false, motivo: 'el corrector no dijo si cumple (true o false)' };
    const costo = Number(res.total_cost_usd);
    return { medida: true, cumple: nota.cumple, costo_usd: Number.isFinite(costo) ? costo : null, motivo: nota.motivo || '' };
  } finally {
    limpiar();
  }
}

/** Todos los argumentos de una opción que se repite (`--model a --model b`). */
function argVals(argv, flag) {
  const vals = [];
  argv.forEach((a, i) => { if (a === flag) vals.push(argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? null : argv[i + 1]); });
  return vals;
}
const argVal = (argv, flag) => { const v = argVals(argv, flag); return v.length ? v[v.length - 1] : undefined; };

/** El informe, de una vez (temporal y renombre). */
function escribirInforme(informe, resultados, problemas) {
  const ruta = path.resolve(informe);
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  const tmp = `${ruta}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ kind: 'prueba-de-resta', ts: new Date().toISOString(), resultados, no_medido: problemas }, null, 2) + '\n');
    fs.renameSync(tmp, ruta);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const usd = (x) => (x === null ? 'sin costo' : `${x} USD`);

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('subtraction-test.js [--cases <carpeta>] [--case <nombre>] [--model <m>]... [--runs N] [--json <informe>] [--harness <arnés>] — ver la cabecera');
    return 0;
  }
  const sinValor = ['--cases', '--case', '--model', '--runs', '--json', '--harness'].find((f) => argVals(argv, f).includes(null));
  if (sinValor) { console.error(`resta: ${sinValor} sin valor`); return 2; }
  const arnes = path.resolve(argVal(argv, '--harness') || TCG);
  const dir = argVal(argv, '--cases') || CASOS_POR_DEFECTO;
  const soloCaso = argVal(argv, '--case');
  const runsArg = argVal(argv, '--runs');
  if (runsArg !== undefined && !(/^\d+$/.test(runsArg) && Number(runsArg) >= 1)) { console.error(`resta: --runs no es un entero ≥ 1 («${runsArg}»)`); return 2; }
  const modelosArg = argVals(argv, '--model');
  const informe = argVal(argv, '--json');

  const entradas = cargarCasos(dir, arnes).filter((e) => !soloCaso || e.nombre === soloCaso);
  const problemas = [];
  if (!entradas.length) problemas.push(sanear(`no hay casos en ${dir}${soloCaso ? ` con el nombre ${soloCaso}` : ''}`));
  const invalidos = entradas.filter((e) => !e.validez.ok);
  for (const e of invalidos) problemas.push(`${e.nombre}: caso inválido — ${e.validez.motivo}`);
  if (invalidos.length || !entradas.length) {
    for (const p of problemas) console.error(`resta: no pude medir: ${p}`);
    if (informe) escribirInforme(informe, [], problemas);
    return 2;
  }

  const lista = leerJson(path.join(arnes, 'scripts', 'setup', 'hooks-list.json'), {});
  const resultados = [];
  for (const e of entradas) {
    const { caso } = e;
    const modelos = modelosArg.length ? modelosArg : (caso.models || MODELOS_POR_DEFECTO);
    const n = runsArg ? Number(runsArg) : (caso.runs || RUNS_POR_DEFECTO);
    const k = caso.k === undefined ? caso.historias.length : caso.k;
    const copiaCon = copiarArnes(arnes);
    const ns = neutralizaciones(caso.quitar);
    const copiaSin = ns.length ? copiarArnes(arnes, ns) : copiaCon;
    try {
      for (const modelo of modelos) {
        const con = [], sin = [];
        for (const historia of caso.historias) {
          for (let i = 0; i < n; i++) {
            con.push(await correrUna({ entrada: e, historia, modelo, copia: copiaCon, env: {}, lista }));
            sin.push(await correrUna({ entrada: e, historia, modelo, copia: copiaSin, env: caso.quitar.env || {}, lista }));
          }
        }
        const ladoSinMedir = [['con el control', con], ['sin el control', sin]].find(([, rs]) => !rs.some((r) => r.medida));
        if (ladoSinMedir) {
          const motivo = ladoSinMedir[1].map((r) => r.motivo).filter(Boolean)[0] || 'ninguna ejecución se corrigió';
          problemas.push(sanear(`${e.nombre} · ${modelo}: no pude medir ${ladoSinMedir[0]} — ${motivo}`));
          continue;
        }
        const res = Object.assign({ caso: e.nombre }, resumir({ control: caso.control, modelo, k, con, sin }));
        resultados.push(res);
        console.log(`resta: ${caso.control} · ${modelo}: con el control ${res.con.cumplieron}/${res.con.corridas} cumplen`
          + ` · sin él ${res.sin.cumplieron}/${res.sin.corridas} · costo con ${usd(res.con.costo_usd)}, sin ${usd(res.sin.costo_usd)}`
          + `${res.sin_medir ? ` · ${res.sin_medir} ejecución(es) sin medir` : ''}`
          + `${res.veredicto ? ` · ${res.veredicto} (hacen falta ${k} por lado)` : ''}`);
      }
    } finally {
      fs.rmSync(copiaCon, { recursive: true, force: true });
      if (copiaSin !== copiaCon) fs.rmSync(copiaSin, { recursive: true, force: true });
    }
  }

  for (const p of problemas) console.error(`resta: no pude medir: ${p}`);
  if (informe) escribirInforme(informe, resultados, problemas);
  return problemas.length ? 3 : 0;
}

module.exports = {
  validarCaso, cargarCasos, copiarArnes, casaDelLaboratorio, settingsDelLaboratorio, rutaDelGancho, armarArbol, comandoDelAgente,
  usosDeHerramientas, resumir, main, MODELOS_POR_DEFECTO,
};

if (require.main === module) {
  main(process.argv.slice(2))
    .then((c) => { process.exitCode = c; })
    .catch((e) => { console.error(`resta: ${e && e.message}`); process.exitCode = 1; });
}
