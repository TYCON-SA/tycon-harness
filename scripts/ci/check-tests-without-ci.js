#!/usr/bin/env node
'use strict';
/**
 * check-tests-without-ci.js — ¿un repo tiene pruebas de navegador que su pipeline no corre?
 * Casos: scripts/tests/tests-without-ci.test.sh
 *
 * 🔴 POR QUÉ EXISTE: un repo trajo dos suites nuevas en un mismo commit y cableó una sola en su pipeline; las pruebas de
 * navegador quedaron escritas y sin correr casi un mes, y se descubrió de casualidad. No fue una decisión: el pipeline
 * nunca las mencionó, ni para ponerlas ni para descartarlas. Medido ese día sobre los repos de los productos: 78 specs
 * en cinco repos que ningún pipeline corre, y era la tercera vez en cinco semanas que el equipo encontraba este defecto
 * sin buscarlo. El aviso que ya había (`e2eConfig()` del pipeline) vive en la máquina de quien usa la herramienta de
 * merge y mira la declaración del portón del merge, no el pipeline; la mitad de los merges de ese repo entraban desde la
 * web. Este control mira el pipeline, repo por repo: «si tenés pruebas, el pipeline las corre».
 *
 * QUÉ MIRA, por cada repo de la lista de productos:
 *   · las configuraciones `playwright.config*.{js,ts,…}` hasta 5 niveles (sin `node_modules` ni `.git`): con 3 niveles,
 *     las aplicaciones anidadas de los repos de formularios no aparecían;
 *   · los specs (`*.spec.*`) bajo una ruta que contenga `e2e`, debajo de cada configuración y sin tope de profundidad;
 *     cada spec cuenta una vez, para la configuración más honda que lo contiene. Una configuración sin specs, o specs
 *     sin configuración, es `no-aplica`;
 *   · TODOS los `azure-pipelines*.yml` de la raíz del repo, no el primero (un `azure-pipelines-prod.yml` ordena antes que
 *     el de integración y tomar el primero daba «no las corre» para un repo que sí las corre), y las plantillas del
 *     mismo repo que incluyen (`- template: ruta`; las de otro repo, `@repo`, no se siguen);
 *   · si el repo declara el portón del merge (`e2e:` en `.tycon/advisors.yaml`): con declaración, el hallazgo dice
 *     «sólo lo cubre el portón del merge»; sin ella, «no lo cubre nadie». Son dos riesgos distintos.
 *
 * VEREDICTOS: `ok` (algún pipeline o plantilla tiene `playwright test` fuera de un comentario y de un `displayName`;
 * `npx playwright install` sólo instala los navegadores y no cuenta) · `sin-ci` · `sin-pipeline` (no hay
 * ningún `azure-pipelines*.yml`: no hay dónde cablearlas, la acción es otra) · `no-aplica` · `no-medido` (algún
 * pipeline no se pudo leer y ninguno legible las corre). Un repo de la lista que no está en esta máquina es NO MEDIDO
 * (`ausentes`), nunca `ok`.
 *
 * 🔴 LO QUE NO VE: la detección es por TEXTO en el YAML. Un pipeline que corre Playwright por un script intermedio
 * (`npm run e2e`) sale `sin-ci`. Si un repo que el equipo sabe que las corre aparece acá, se suma su forma a
 * CORRE_PLAYWRIGHT y un caso que la fije. Tampoco mira las pruebas de integración de .NET (otra detección).
 *
 * ENTRA AVISANDO: con hallazgos sale 0 y los dice; con `--strict`, 1. La fecha para decidir si pasa a frenar está en
 * DECIDIR_EL_FRENO, y el aviso la repite.
 *
 * Los repos salen de `product-parity.json` (la única lista de qué repos son los productos; sin --config, la de la
 * organización en su repo de operaciones, como en check-product-parity.js). Sin raíz declarada no se mide nada.
 *
 * Uso:  node check-tests-without-ci.js [--root <dir>] [--config <product-parity.json>] [--json] [--strict]
 * Sale 0 sin hallazgos o en modo aviso · 1 con --strict y hallazgos · 2 no pudo medir (sin lista, sin raíz, una lista
 * mal armada, una opción desconocida, nada medido, o con --strict algún repo NO MEDIDO).
 * Con --json: { medidos, ausentes, no_aplican, resultados: [{ repo, specs, apps, veredicto, porton_del_merge,
 * pipelines?, ilegibles?, avisos? }] } (y `sin_productos` en la copia pública).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { normalizarGrupo, configPorDefecto } = require('./check-product-parity.js');

const DECIDIR_EL_FRENO = '2026-11-21';
const PROFUNDIDAD = 5;                 // dónde se buscan las configuraciones; los specs de cada una, sin tope
const NO_ENTRAR = new Set(['node_modules', '.git']);
const CONFIG = /^playwright\.config(?:\.[\w-]+)*\.[cm]?[jt]s$/;   // playwright.config.ts, playwright.config.e2e.ts…
const SPEC = /\.spec\.[cm]?[jt]sx?$/;
// correr las pruebas, no instalar los navegadores ni mostrar el reporte: `playwright test` por npx, por la carpeta de
// binarios o por un script del pipeline
const CORRE_PLAYWRIGHT = /\bplaywright\s+test\b(?![\w-])/;
const OPCIONES_CON_VALOR = new Set(['--root', '--config']);
const OPCIONES = new Set(['--root', '--config', '--json', '--strict']);

class ErrorDeUso extends Error {}

function args(argv) {
  const o = { root: null, config: null, configDada: false, json: false, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    // una opción mal escrita (un `--strict` con un error de tipeo) dejaría el modo aviso callado: se rechaza
    if (!OPCIONES.has(t)) throw new ErrorDeUso(`opción desconocida: ${t}`);
    if (OPCIONES_CON_VALOR.has(t)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new ErrorDeUso(`${t} necesita un valor`);
      i++;
      if (t === '--root') o.root = v; else { o.config = v; o.configDada = true; }
    } else if (t === '--json') o.json = true;
    else o.strict = true;
  }
  return o;
}

const expandir = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

/**
 * Los archivos de `dir` hasta `profundidad` niveles (Infinity: todos), sin entrar en NO_ENTRAR; rutas relativas a
 * `base`. Una carpeta que no se pudo leer queda en `fallas`: lo que no se vio no se cuenta como «no hay».
 */
function recorrer(dir, base, profundidad, out, fallas, reales = new Set()) {
  // una carpeta enlazada se sigue una vez (por su ruta real): un enlace que vuelve sobre sí mismo no da vueltas
  let real;
  try { real = fs.realpathSync(dir); } catch (e) { fallas.push(`${path.relative(base, dir) || '.'} (${e.code || e.message})`); return out; }
  if (reales.has(real)) return out;
  reales.add(real);
  let entradas;
  try { entradas = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { fallas.push(`${path.relative(base, dir) || '.'} (${e.code || e.message})`); return out; }
  for (const e of entradas) {
    if (NO_ENTRAR.has(e.name)) continue;
    const p = path.join(dir, e.name);
    let tipo = e;
    if (e.isSymbolicLink()) {
      try { tipo = fs.statSync(p); } catch (err) { fallas.push(`${path.relative(base, p)} (enlace roto: ${err.code || err.message})`); continue; }
    }
    if (tipo.isDirectory()) { if (profundidad > 0) recorrer(p, base, profundidad - 1, out, fallas, reales); }
    else if (tipo.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

/**
 * Las pruebas de navegador de un repo: `{ specs, apps, fallas }`. Las configuraciones se buscan hasta PROFUNDIDAD; sus
 * specs, debajo de cada una sin tope. Cada spec cuenta una vez, para la configuración más honda que lo contiene.
 */
function pruebasDelRepo(dir) {
  const fallas = [];
  const configs = [...new Set(recorrer(dir, dir, PROFUNDIDAD, [], fallas)
    .filter((f) => CONFIG.test(path.posix.basename(f))).map((f) => path.posix.dirname(f)))];
  const dentro = (c, f) => c === '.' || f.startsWith(`${c}/`);
  const porApp = new Map();
  const vistos = new Set();
  for (const c of configs) {
    const raiz = c === '.' ? dir : path.join(dir, ...c.split('/'));
    for (const f of recorrer(raiz, dir, Infinity, [], fallas)) {
      if (vistos.has(f) || !SPEC.test(f) || !f.split('/').some((t) => /e2e/i.test(t))) continue;
      vistos.add(f);
      const duena = configs.filter((x) => dentro(x, f)).sort((a, b) => b.length - a.length)[0];
      porApp.set(duena, (porApp.get(duena) || 0) + 1);
    }
  }
  const apps = [...porApp.keys()].sort();
  return { specs: vistos.size, apps, fallas: [...new Set(fallas)] };
}

/** El texto de un YAML sin comentarios ni nombres para mostrar: un paso comentado o un título no corren nada. */
function sinComentarios(texto) {
  return texto.split('\n')
    .filter((l) => !/^\s*#/.test(l) && !/^\s*-?\s*(?:displayName|name)\s*:/.test(l))
    .map((l) => l.replace(/\s+#.*$/, ''))
    .join('\n');
}

/** Las plantillas del mismo repo que nombra un YAML (`template: ruta`, sin `@otro-repo`), relativas a la raíz. */
function plantillas(texto, desde) {
  const out = [];
  const rx = /^\s*-?\s*template\s*:\s*['"]?([^'"#\s@]+)['"]?\s*$/gm;
  let m;
  while ((m = rx.exec(texto))) {
    const ref = m[1];
    out.push(ref.startsWith('/') ? ref.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(desde), ref)));
  }
  return out;
}

/**
 * TODOS los pipelines de la raíz del repo con las plantillas del repo que incluyen (y las de éstas). Cada uno con su
 * texto sin comentarios; uno que no se pudo leer lleva `texto: null`. Una carpeta ilegible devuelve `null`.
 */
function pipelinesDelRepo(dir) {
  let nombres;
  try { nombres = fs.readdirSync(dir).filter((n) => /^azure-pipelines.*\.ya?ml$/.test(n)).sort(); }
  catch (_) { return null; }
  const out = [];
  const vistos = new Set();
  const raiz = path.resolve(dir);
  const leer = (rel, raizDe) => {
    if (vistos.has(rel)) return;
    vistos.add(rel);
    // una plantilla que sale del repo (`../`) no se lee: no es del repo y podría hacer «ok» a uno que no las corre
    const donde = path.relative(raiz, path.resolve(raiz, ...rel.split('/')));
    if (!donde || donde.startsWith('..') || path.isAbsolute(donde)) { out.push({ nombre: rel, texto: '', de: raizDe, fuera: true }); return; }
    let texto = null;
    try { texto = sinComentarios(fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8')); } catch (_) { texto = null; }
    out.push({ nombre: rel, texto, de: raizDe });
    if (texto !== null) for (const t of plantillas(texto, rel)) leer(t, raizDe);
  };
  for (const n of nombres) leer(n, n);
  return out;
}

/** ¿El repo declara el portón del merge (`e2e:` en `.tycon/advisors.yaml`)? true · false · null (no se pudo leer). */
function declaraPorton(dir) {
  try { return /^e2e:/m.test(fs.readFileSync(path.join(dir, '.tycon', 'advisors.yaml'), 'utf8')); }
  catch (e) { return e && e.code === 'ENOENT' ? false : null; }
}

function medirRepo(nombre, dir) {
  const { specs, apps, fallas } = pruebasDelRepo(dir);
  const porton = declaraPorton(dir);
  const base = { repo: nombre, specs, apps, porton_del_merge: porton === true };
  const avisos = [];
  if (porton === null) avisos.push('no pude leer .tycon/advisors.yaml: no sé si declara el portón del merge');
  // sin specs vistos y con carpetas que no se pudieron leer, «no aplica» sería mentir
  if (!specs) return fallas.length ? { ...base, ...(avisos.length ? { avisos } : {}), veredicto: 'no-medido', ilegibles: fallas } : { ...base, veredicto: 'no-aplica' };
  // con specs vistos, una carpeta ilegible deja la cuenta corta: se dice
  if (fallas.length) avisos.push(`la cuenta de specs puede quedar corta: no pude leer ${fallas.join(', ')}`);
  const pipes = pipelinesDelRepo(dir);
  for (const p of pipes || []) if (p.fuera) avisos.push(`la plantilla ${p.nombre} queda fuera del repo: no se sigue`);
  if (avisos.length) base.avisos = avisos;
  if (pipes === null) return { ...base, veredicto: 'no-medido', ilegibles: ['la carpeta del repo'] };
  const raices = [...new Set(pipes.map((p) => p.de))];
  if (!raices.length) return { ...base, veredicto: 'sin-pipeline' };
  const corre = pipes.some((p) => p.texto !== null && CORRE_PLAYWRIGHT.test(p.texto));
  // «no las corre» sólo si se leyó todo: un archivo ilegible puede ser justo el que las corre
  const ilegibles = pipes.filter((p) => p.texto === null).map((p) => p.nombre);
  if (!corre && ilegibles.length) return { ...base, veredicto: 'no-medido', pipelines: raices, ilegibles };
  return { ...base, veredicto: corre ? 'ok' : 'sin-ci', pipelines: raices };
}

function sinProductosAProposito(cfg) {
  if (!Object.prototype.hasOwnProperty.call(cfg || {}, 'sin_productos')) return null;
  const hayGrupos = cfg.grupos && typeof cfg.grupos === 'object' && Object.keys(cfg.grupos).length > 0;
  if (typeof cfg.sin_productos !== 'string' || !cfg.sin_productos.trim()) return { rc: 2, msg: '🔴 "sin_productos" tiene que decir por qué (texto) — no se midió nada' };
  if (hayGrupos) return { rc: 2, msg: '🔴 la configuración dice "sin_productos" y además declara grupos: es una contradicción — no se midió nada' };
  return { rc: 0, msg: `ℹ️ no hay productos declarados (${cfg.sin_productos.trim()}): no se midió nada` };
}

function main(argv) {
  let o;
  try { o = args(argv); }
  catch (e) {
    if (!(e instanceof ErrorDeUso)) throw e;
    console.log(`🔴 ${e.message} — no se midió nada (uso: --root <dir> --config <json> --json --strict)`);
    return 2;
  }
  if (!o.configDada) {
    const d = configPorDefecto();
    if (d.problema) { console.log(`🔴 sin la lista de productos: ${d.problema} — no se midió nada`); return 2; }
    o.config = d.ruta;
  }
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(o.config, 'utf8')); }
  catch (e) { console.log(`🔴 no pude leer la configuración (${o.config}): ${e.message}`); return 2; }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) { console.log(`🔴 la configuración (${o.config}) no es un objeto — no se midió nada`); return 2; }
  const sin = sinProductosAProposito(cfg);
  if (sin) {
    if (o.json && sin.rc === 0) console.log(JSON.stringify({ medidos: 0, ausentes: 0, no_aplican: 0, resultados: [], sin_productos: cfg.sin_productos.trim() }, null, 2));
    else console.log(sin.msg);
    return sin.rc;
  }
  const raizDeclarada = o.root || cfg.raiz_por_defecto;
  if (!raizDeclarada) { console.log('🔴 sin raíz de repos: pasá --root <carpeta> o declará raiz_por_defecto en la configuración — no se midió nada, y eso no es «todo bien»'); return 2; }
  const raiz = expandir(raizDeclarada);

  // un repo puede estar en varios grupos (con un pipeline distinto en cada uno): se mide una vez, por su carpeta
  const vistos = new Set();
  const resultados = [];
  let ausentes = 0;
  for (const [grupo, def] of Object.entries(cfg.grupos || {})) {
    const g = normalizarGrupo(def);
    if (!g) { console.log(`🔴 el grupo "${grupo}" no es ni una lista de repos ni un objeto con "repos"`); return 2; }
    for (const r of g.repos) {
      // una entrada sin ruta no se saltea callada: el control diría «nada que medir» sin haber mirado
      if (!r || typeof r.ruta !== 'string' || !r.ruta.trim()) {
        console.log(`🔴 el grupo "${grupo}" tiene una entrada sin "ruta" (texto): ${JSON.stringify(r)} — no se midió nada`);
        return 2;
      }
      if (vistos.has(r.ruta)) continue;
      vistos.add(r.ruta);
      const dir = path.join(raiz, r.ruta);
      // «no está en esta máquina» sólo si no existe; sin permiso para mirarla es NO MEDIDO, con su causa
      let st = null;
      try { st = fs.statSync(dir); } catch (e) {
        if (e && e.code !== 'ENOENT') { resultados.push({ repo: r.ruta, specs: 0, apps: [], porton_del_merge: false, veredicto: 'no-medido', ilegibles: [`la carpeta del repo (${e.code || e.message})`] }); continue; }
      }
      if (!st || !st.isDirectory()) { ausentes++; continue; }
      resultados.push(medirRepo(r.ruta, dir));
    }
  }
  const noMedidos = resultados.filter((r) => r.veredicto === 'no-medido');
  const noAplican = resultados.filter((r) => r.veredicto === 'no-aplica').length;
  const medidos = resultados.length - noAplican - noMedidos.length;
  const hallazgos = resultados.filter((r) => r.veredicto === 'sin-ci' || r.veredicto === 'sin-pipeline');

  if (o.json) {
    console.log(JSON.stringify({ medidos, ausentes, no_aplican: noAplican, resultados }, null, 2));
  } else {
    for (const r of hallazgos) {
      const quien = r.porton_del_merge ? 'sólo el portón del merge (en la máquina de quien mergea, si usa la herramienta del arnés)' : 'no lo cubre nadie';
      const que = r.veredicto === 'sin-pipeline' ? 'no tiene ningún azure-pipelines*.yml donde cablearlas' : `ningún pipeline las corre (${r.pipelines.join(', ')})`;
      console.log(`  ⚠️ ${r.repo}: ${r.specs} spec(s) en ${r.apps.join(', ')} — ${que}; ${quien}`);
    }
    for (const r of noMedidos) console.log(`  ⚠️ ${r.repo}: NO MEDIDO — no pude leer ${r.ilegibles.join(', ')}`);
    for (const r of resultados) for (const a of r.avisos || []) console.log(`  ⚠️ ${r.repo}: ${a}`);
    if (ausentes) console.log(`\n⚠️ ${ausentes} repo(s) no están en esta máquina: NO se midieron. «No medido» no es «las corre».`);
    if (noAplican) console.log(`ℹ️ ${noAplican} repo(s) sin pruebas de navegador: no aplica.`);
  }
  if (hallazgos.length) {
    if (!o.json) {
      const specs = hallazgos.reduce((s, r) => s + r.specs, 0);
      console.log(`\n${o.strict ? '🔴' : '⚠️'} ${hallazgos.length} de ${medidos} repo(s) con pruebas de navegador que su pipeline no corre (${specs} spec(s)).`);
      if (!o.strict) console.log(`   Modo aviso: no frena. Se decide si frena el ${DECIDIR_EL_FRENO}.`);
    }
    return o.strict ? 1 : 0;
  }
  if (!medidos) {
    const sinMirar = ausentes + noMedidos.length;
    if (!o.json) console.log(sinMirar ? '🔴 no se midió ningún repo con pruebas de navegador — no puedo opinar' : 'ℹ️ ningún repo de la lista tiene pruebas de navegador');
    return sinMirar ? 2 : 0;
  }
  if (noMedidos.length) {
    // con repos sin mirar no se dice «todos las corren»; con --strict, no se puede dar el verde
    if (!o.json) console.log(`⚠️ ${medidos} repo(s) medidos corren sus pruebas de navegador; ${noMedidos.length} NO MEDIDO(s).`);
    return o.strict ? 2 : 0;
  }
  if (!o.json) console.log(`✅ pruebas sin ci: ${medidos} repo(s) medidos, todos corren sus pruebas de navegador en el pipeline`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { main, pruebasDelRepo, pipelinesDelRepo, medirRepo };
