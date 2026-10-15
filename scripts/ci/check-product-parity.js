#!/usr/bin/env node
'use strict';
/**
 * ¿Los pipelines de los cinco productos hacen LO MISMO?
 *
 * 🔴 POR QUÉ EXISTE (2026-09-01).
 *
 * Ese día se dio FRESNO por alineado con URUTAU —comparando a mano— y faltaban ONCE cosas. Cuatro de
 * ellas estaban repartidas entre productos que YA se habían dado por cerrados: un backend sin
 * reintento cuando el host limita, dos productos sin el aviso de atraso, y —la peor— un pipeline
 * que NO se disparaba cuando el cambio tocaba sólo las pruebas, o sea que la prueba nueva no
 * corría hasta que alguien tocara código.
 *
 * Ninguna la encontró una revisión: las encontró el dev preguntando "¿me lo podés asegurar con
 * evidencia?". Este control existe para que esa pregunta tenga respuesta sin que nadie la haga.
 *
 * 🔴 NO JUZGA CUÁL ES EL COMPORTAMIENTO CORRECTO. Juzga que los cinco hagan lo mismo. Si divergen,
 * decide una persona — y si la diferencia es legítima, se DECLARA en `product-parity.json` con
 * motivo y fecha de revisión. Una diferencia sin motivo no es una decisión: es un descuido.
 *
 * 🔴 Un repo que no está en esta máquina NO se lee como "todo bien": se cuenta aparte y se dice.
 * "No medido" y "medido y coincide" son cosas distintas, y confundirlas es el modo de falla que
 * el arnés persigue en todas sus piezas.
 *
 * 🔴 UN RASGO PUEDE ACOTARSE A UN BLOQUE DEL YAML (`bloque: "trigger"`), 2026-09-02. El primer
 * falso negativo real de este control: `dispara-tests` buscaba `- tests/**` en el archivo ENTERO
 * y lo encontró en FRESNO… dentro del bloque `pr:`, que para Azure Repos es inerte. El `trigger:` de
 * FRESNO no lo tenía, así que un merge sólo de pruebas NO construía en main — y el control decía
 * "los cinco coinciden". Lo mismo con `dispara-pipeline` (`azure-pipelines.yml` estaba en `pr:`).
 * Un rasgo con `bloque` se evalúa SÓLO sobre ese bloque de nivel raíz; si el bloque no existe, el
 * rasgo cuenta como ausente.
 *
 * 🔴 UN GRUPO PUEDE MIRAR OTRO ARCHIVO (`archivo:`), 2026-09-02. Los 4 pipelines de producción
 * viven en `azure-pipelines-prod.yml`; hasta hoy el control sólo leía `azure-pipelines.yml`, así
 * que ningún rasgo de producción podía ponerse rojo. Un grupo declarado como objeto puede decir
 * qué archivo lee y si sólo le aplican los rasgos que lo nombran (`solo_rasgos_que_lo_nombren`):
 * a producción no se le pide el portón ni las pruebas, que son de CI.
 *
 * 🔴 CORRE CADA NOCHE Y DEJA SU RESULTADO CON FECHA (story 2.25, 2026-10-15). Hasta ese día sólo lo corrían las
 * pruebas: ningún pipeline lo llamaba, así que un producto podía dejar de hacer lo mismo que los demás y nadie se
 * enteraba hasta preguntar. Ahora lo corre la revisión nocturna de dependencias (que ya clona los repos de producto
 * sobre `main`, con la misma `ruta`) y guarda `--out .dashboard/paridad/paridad-<día>.json`, que lee el sitio de la
 * organización. Lo que imprime y el código de salida son los de siempre; el archivo dice además si algo quedó sin medir.
 *
 * El archivo (`--out`), con exactamente estas claves: `v` (1) · `fecha` (día UTC) · `generated_at` · `estado`
 * (`medido`: se comparó y todo se leyó de origin/main · `parcial`: se comparó y algún repo quedó sin medir o leído del
 * disco, o algún grupo sin comparar · `no_medido`: no se comparó nada o la configuración está rota, con `motivo` ·
 * `sin_productos`: la marca de la copia pública) · `motivo` · `comparaciones` · `divergencias` (`{grupo, rasgo, que,
 * tienen, no_tienen}`; un exigido que nadie cumple va con `tienen: []` y `ninguno: true`) · `declaradas` (las vigentes) ·
 * `vencidas` · `grupos_sin_comparar` · `no_medidos` · `desde_disco` · `por_ruta` · `rc` (el código de salida).
 * `por_ruta` es lo que lee el sitio: una entrada por `ruta` de la lista, `{ruta, estado, motivo, divergencias,
 * vencidas}`, sólo cantidades. `estado`: `medido`, `desde_disco` o `no_medido`; `motivo`, de una lista cerrada:
 * `sin_clon` (la carpeta no está, o no hay carpeta de clones), `ilegible` (no se pudo leer su archivo, o la
 * configuración trae un rasgo o un grupo roto), `grupo_sin_comparar`, `declaracion_incompleta` o `null`. Un repo en
 * varios grupos lleva el peor estado. `divergencias` cuenta los rasgos en que ese repo quedó del lado distinto: el
 * lado más chico (con empate, los dos) y, en un exigido que nadie cumple, todos. `vencidas` cuenta las declaraciones
 * vencidas de sus grupos. El texto de los YAML, la carpeta de los clones y las rutas absolutas NO van al archivo.
 * Un repo que sólo está en grupos a los que ningún rasgo les aplica no va a `por_ruta` ni a `clone-list`: no se compara
 * nunca, y salir «medido» lo mostraría «en orden». Una `revision` que no es AAAA-MM-DD es una declaración incompleta
 * (comparada como texto, no vencía nunca). `--today <AAAA-MM-DD>`: el día de la noche, para la `fecha` y para vencer.
 *
 * 🔴 UNA DECLARACIÓN VENCIDA NO AMPARA, Y LA COMPARACIÓN SIGUE (story 2.25). Antes cortaba con 1 antes de comparar
 * nada: una sola fecha vencida dejaba la noche sin mirar el resto. Ahora el rasgo cuenta como divergencia, la
 * declaración sale en `vencidas` y se sigue con los demás. Sale 1, como antes.
 *
 * DÓNDE VIVE CADA REPO (story 2.25): una entrada puede decir `ado: "<proyecto>/<repo>"` (el proyecto codificado, como en
 * repos.json: `Acme%20Uno/Back`) o `github: "<dueño>/<repo>"`. Lo usa `clone-list`, para que la noche clone lo que
 * la revisión de dependencias no trae; el resto del control (y check-trigger-without-docs.js) ignora esas claves.
 *
 * Uso:  node check-product-parity.js [--root <dir>] [--config <archivo>] [--out <archivo.json>] [--today <AAAA-MM-DD>]
 *       node check-product-parity.js clone-list --root <dir> [--config <archivo>] [--platform azure|github]
 *       (--root se llamaba en castellano hasta la story 8.9, tanda B3a; el nombre viejo sigue andando hasta el retiro)
 * Sale 0 si todos coinciden (o la diferencia está declarada) · 1 si hay divergencia o una declaración vencida o
 * incompleta · 2 si no pudo medir lo suficiente para opinar (o llegó una opción con su nombre viejo y el nuevo a la vez).
 * `clone-list` imprime `<ruta>\t<dirección>` por cada ruta que no tiene `<dir>/<ruta>/.git` y declara dónde vive (la
 * forma de `nightly-dependencies.js clone-list`); con `--platform`, sólo las de esa plataforma, y la otra se avisa por
 * stderr (no se clona: sale «no medido»). Sale 0; 2 con la configuración ilegible.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const os = require('os');
// El traductor de las opciones viejas vive al lado y viaja con este archivo en el artefacto arnes-ci (story 8.9).
const { aliasLegacyOptions, LegacyOptionsError } = (() => {
  try { return require('./legacy-options.js'); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') process.stderr.write(`⚠️  legacy-options.js no cargó (${e && e.message}): los nombres viejos de este guion no se traducen\n`); return { aliasLegacyOptions: (argv) => argv, LegacyOptionsError: Error }; }
})();

function args(argv) {
  const o = { raiz: null, config: path.join(__dirname, 'product-parity.json'), out: null, platform: null, cmd: null, today: null };
  let i = 0;
  if (argv[0] === 'clone-list') { o.cmd = 'clone-list'; i = 1; }
  for (; i < argv.length; i++) {
    if (argv[i] === '--root') o.raiz = argv[++i];
    else if (argv[i] === '--config') o.config = argv[++i];
    else if (argv[i] === '--out') o.out = argv[++i];
    else if (argv[i] === '--platform') o.platform = argv[++i];
    else if (argv[i] === '--today') o.today = argv[++i];
  }
  return o;
}

/** ¿Le aplica este rasgo a este grupo? Con `grupos` explícito, sólo a ésos; sin `grupos`, a todos salvo los que pidieron
 *  recibir únicamente los rasgos que los nombren. */
function aplica(rasgo, grupo, g) {
  if (!rasgo) return false;
  return rasgo.grupos ? rasgo.grupos.includes(grupo) : !g.soloExplicitos;
}

/** Un grupo está «en juego» si al menos un rasgo le aplica (revisión adversarial de la 2.25). Uno al que ninguno le aplica
 *  —el de los sitios web del equipo: sólo rasgos que lo nombren, y ninguno lo nombra— no se compara nunca: sus repos no
 *  van a por_ruta (el sitio los mostraría «en orden» sin haberlos comparado) ni a la lista para clonar. */
function enJuego(cfg, grupo, g) {
  return !!g && Array.isArray(cfg && cfg.rasgos) && cfg.rasgos.some((r) => aplica(r, grupo, g));
}

/** Las rutas de los grupos en juego, en el orden en que aparecen (una vez cada una). */
function rutasDeLaLista(cfg) {
  const out = [];
  for (const [grupo, def] of Object.entries((cfg && cfg.grupos) || {})) {
    const g = normalizarGrupo(def);
    if (!enJuego(cfg, grupo, g)) continue;
    for (const r of g.repos) if (r && typeof r.ruta === 'string' && !out.includes(r.ruta)) out.push(r.ruta);
  }
  return out;
}

/** Cómo se nombra cada repo de un grupo: su producto; si dos del grupo repiten producto, el producto con su ruta (antes la
 *  segunda entrada pisaba a la primera y ese repo salía de la comparación sin aviso). */
function nombresDelGrupo(g) {
  const base = g.repos.map((r) => (r && r.producto) || (r && r.ruta) || '?');
  return base.map((n, i) => (base.indexOf(n) !== base.lastIndexOf(n) ? `${n} (${g.repos[i].ruta})` : n));
}

const DIA = /^\d{4}-\d{2}-\d{2}$/;

// El peor estado de una ruta que está en varios grupos: un repo que no se pudo medir en uno no se ve «medido» por otro.
const GRAVEDAD = { 'medido/null': 0, 'desde_disco/null': 1, 'no_medido/grupo_sin_comparar': 2, 'no_medido/declaracion_incompleta': 3, 'no_medido/ilegible': 4, 'no_medido/sin_clon': 5 };

/** El resultado que guarda `--out`: se arma mientras el control imprime lo de siempre. */
function nuevoResultado(cfg, hoy) {
  const ahora = new Date();
  const rutas = new Map(rutasDeLaLista(cfg).map((r) => [r, { ruta: r, estado: 'medido', motivo: null, divergencias: 0, vencidas: 0 }]));
  const res = {
    v: 1, fecha: hoy || ahora.toISOString().slice(0, 10), generated_at: ahora.toISOString(), estado: null, motivo: null,
    comparaciones: 0, divergencias: [], declaradas: [], vencidas: [], grupos_sin_comparar: [], no_medidos: [], desde_disco: [],
    por_ruta: [], rc: null,
  };
  const marcar = (ruta, estado, motivo) => {
    const e = rutas.get(ruta);
    if (e && GRAVEDAD[`${estado}/${motivo}`] > GRAVEDAD[`${e.estado}/${e.motivo}`]) { e.estado = estado; e.motivo = motivo; }
  };
  const marcarTodas = (estado, motivo) => { for (const r of rutas.keys()) marcar(r, estado, motivo); };
  return { res, rutas, marcar, marcarTodas };
}

/** Cierra el resultado y lo escribe (temporal + renombrar). Devuelve el código de salida, que no cambia por escribir. */
function terminar(o, R, rc, estado, motivo) {
  if (!o.out) return rc;
  R.res.rc = rc;
  R.res.estado = estado;
  R.res.motivo = motivo == null ? null : String(motivo).replace(/^[🔴⚠️ℹ️✅\s️]+/u, '');
  R.res.comparaciones = R.res.comparaciones || 0;
  R.res.por_ruta = [...R.rutas.values()];
  const tmp = `${o.out}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(R.res, null, 2)}\n`);
    fs.renameSync(tmp, o.out);
  } catch (e) {
    // el temporal no queda: guardar lo llevaría al repo de operaciones como si fuera un resultado
    try { fs.unlinkSync(tmp); } catch (_) { /* no llegó a crearse */ }
    process.stderr.write(`⚠️ no pude escribir el resultado en ${o.out}: ${e.message}\n`);
  }
  return rc;
}

/** Lo que la noche tiene que clonar para comparar: `ruta<TAB>dirección`, cada ruta una vez (story 2.25). */
function cloneList(o) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(o.config, 'utf8')); }
  catch (e) { process.stderr.write(`🔴 no pude leer la configuración (${o.config}): ${e.message}\n`); return 2; }
  const sinProductos = sinProductosAProposito(cfg);
  if (sinProductos) { if (sinProductos.rc) process.stderr.write(`${sinProductos.msg}\n`); return sinProductos.rc; }
  if (o.platform && !['azure', 'github'].includes(o.platform)) { process.stderr.write(`🔴 --platform «${o.platform}» no es azure ni github\n`); return 2; }
  const raizDeclarada = o.raiz || cfg.raiz_por_defecto;
  if (!raizDeclarada) { process.stderr.write('🔴 sin raíz de repos: pasá --root <carpeta>\n'); return 2; }
  const raiz = expandir(raizDeclarada);
  const clave = { azure: 'ado', github: 'github' }[o.platform];
  const otra = { azure: 'github', github: 'ado' }[o.platform];
  const porRuta = new Map();
  for (const [grupo, def] of Object.entries(cfg.grupos || {})) {
    const g = normalizarGrupo(def);
    if (!g) { process.stderr.write(`🔴 el grupo "${grupo}" no es ni una lista de repos ni un objeto con "repos"\n`); return 2; }
    if (!enJuego(cfg, grupo, g)) continue;   // ningún rasgo le aplica: no se compara, no hace falta clonarlo
    for (const r of g.repos) {
      if (!r || typeof r.ruta !== 'string' || !r.ruta) continue;
      if (!porRuta.has(r.ruta)) porRuta.set(r.ruta, { dir: '', otra: '' });
      const e = porRuta.get(r.ruta);
      const dir = clave ? r[clave] : (r.ado || r.github);
      if (!e.dir && typeof dir === 'string' && dir) e.dir = dir;
      if (otra && !e.otra && typeof r[otra] === 'string' && r[otra]) e.otra = r[otra];
    }
  }
  for (const [ruta, e] of porRuta) {
    if (fs.existsSync(path.join(raiz, ruta, '.git'))) continue;
    if (path.isAbsolute(ruta) || ruta.split(/[\\/]/).includes('..')) { process.stderr.write(`⚠️ la ruta «${ruta}» sale de la carpeta de los clones: no se clona\n`); continue; }
    if (!e.dir) {
      if (e.otra) process.stderr.write(`⚠️ ${ruta}: declara «${otra}: ${e.otra}» y esta organización es de ${o.platform === 'azure' ? 'Azure DevOps' : 'GitHub'}: no se clona (va a salir «no medido»)\n`);
      continue;
    }
    if (!/^[^/\s]+\/[^/\s]+$/.test(e.dir) || e.dir.split('/').some((p) => p === '.' || p === '..')) {
      process.stderr.write(`⚠️ ${ruta}: «${e.dir}» no tiene la forma <proyecto>/<repo>: no se clona\n`);
      continue;
    }
    console.log(`${ruta}\t${e.dir}`);
  }
  return 0;
}

function expandir(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Un grupo puede escribirse como lista de repos (forma original) o como objeto con opciones. */
function normalizarGrupo(g) {
  if (Array.isArray(g)) return { archivo: 'azure-pipelines.yml', soloExplicitos: false, repos: g };
  if (!g || typeof g !== 'object') return null;
  return {
    archivo: g.archivo || 'azure-pipelines.yml',
    soloExplicitos: g.solo_rasgos_que_lo_nombren === true,
    repos: Array.isArray(g.repos) ? g.repos : [],
  };
}

/**
 * El texto de un bloque de nivel raíz del YAML (`trigger:`, `pr:`, `resources:`…): desde su
 * línea hasta la próxima clave de nivel raíz. Sin parser de YAML a propósito: el formato de estos
 * archivos es regular y un parser haría "desaparecer" los comentarios, que a veces son lo que
 * un rasgo busca. Devuelve null si el bloque no existe.
 */
function bloqueRaiz(texto, clave) {
  const lineas = texto.split('\n');
  const rxInicio = new RegExp(`^${clave.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`);
  const ini = lineas.findIndex((l) => rxInicio.test(l));
  if (ini < 0) return null;
  let fin = lineas.length;
  for (let i = ini + 1; i < lineas.length; i++) {
    if (/^[A-Za-z_][A-Za-z0-9_.-]*:/.test(lineas[i])) { fin = i; break; }
  }
  return lineas.slice(ini, fin).join('\n');
}

// story 8.10.3 (AC 3): la copia pública trae un product-parity.json SIN productos, a propósito (los del equipo no viajan).
// Sólo una marca explícita —`sin_productos` con su motivo y sin grupos— da 0 diciendo que no se comparó nada; grupos vacíos
// sin la marca siguen siendo «no se midió nada» (2), y la marca con grupos es una contradicción (2).
function sinProductosAProposito(cfg) {
  if (!Object.prototype.hasOwnProperty.call(cfg || {}, 'sin_productos')) return null;
  const hayGrupos = cfg.grupos && typeof cfg.grupos === 'object' && Object.keys(cfg.grupos).length > 0;
  if (typeof cfg.sin_productos !== 'string' || !cfg.sin_productos.trim()) return { rc: 2, msg: '🔴 "sin_productos" tiene que decir por qué (texto) — no se midió nada' };
  if (hayGrupos) return { rc: 2, msg: '🔴 la configuración dice "sin_productos" y además declara grupos: es una contradicción — no se midió nada' };
  return { rc: 0, msg: `ℹ️ no hay productos declarados (${cfg.sin_productos.trim()}): no se comparó nada` };
}

function main(argv0) {
  let argv;
  // Antes de leer las opciones el resultado no sabe adónde va: se busca `--out` a mano para poder dejarlo igual.
  const outCrudo = (() => { const i = (argv0 || []).indexOf('--out'); return i >= 0 ? argv0[i + 1] : null; })();
  try { argv = aliasLegacyOptions(argv0, 'raiz:root', 'scripts/ci/check-product-parity.js'); }
  catch (e) {
    if (!(e instanceof LegacyOptionsError)) throw e;
    console.log(`🔴 ${e.message} — no se midió nada`);
    return terminar({ out: outCrudo }, nuevoResultado(null), 2, 'no_medido', e.message);
  }
  const o = args(argv);
  if (o.cmd === 'clone-list') return cloneList(o);
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(o.config, 'utf8')); }
  catch (e) {
    console.log(`🔴 no pude leer la configuración (${o.config}): ${e.message}`);
    // el motivo va sin la ruta de la configuración: el archivo no lleva rutas de la máquina
    const motivo = o.config ? String(e.message).split(o.config).join(path.basename(o.config)) : 'falta el valor de --config';
    return terminar(o, nuevoResultado(null), 2, 'no_medido', `no pude leer la configuración: ${motivo}`);
  }
  // el día de la noche: el del paso que guarda (--today), para que el nombre del archivo y su `fecha` no difieran
  const hoy = o.today && DIA.test(o.today) ? o.today : new Date().toISOString().slice(0, 10);
  if (o.today && !DIA.test(o.today)) process.stderr.write(`⚠️ --today «${o.today}» no es AAAA-MM-DD: uso el día UTC de hoy (${hoy})\n`);
  const R = nuevoResultado(cfg, hoy);
  const sinProductos = sinProductosAProposito(cfg);
  if (sinProductos) {
    console.log(sinProductos.msg);
    return sinProductos.rc ? terminar(o, R, sinProductos.rc, 'no_medido', sinProductos.msg) : terminar(o, R, 0, 'sin_productos', cfg.sin_productos.trim());
  }

  // Sin raíz declarada no se mide nada, y eso se dice (story 8.3): antes había la carpeta de UNA máquina
  // como último recurso, que en cualquier otra medía cero productos en silencio.
  const raizDeclarada = o.raiz || cfg.raiz_por_defecto;
  if (!raizDeclarada) {
    console.log('🔴 sin raíz de repos: pasá --root <carpeta> o declará raiz_por_defecto en la configuración — no se midió nada, y eso no es «todo bien»');
    R.marcarTodas('no_medido', 'sin_clon');
    return terminar(o, R, 2, 'no_medido', 'sin carpeta de los clones (falta --root)');
  }
  const raiz = expandir(raizDeclarada);
  // Una configuración degenerada dice qué tiene y deja su archivo; antes caía con un TypeError y la noche sólo veía
  // «no dejó su resultado» (revisión adversarial de la 2.25).
  if (!Array.isArray(cfg.rasgos)) {
    console.log('🔴 la configuración no trae la lista "rasgos" — no se midió nada');
    return terminar(o, R, 2, 'no_medido', 'la configuración no trae la lista "rasgos"');
  }
  for (const [grupo, def] of Object.entries(cfg.grupos || {})) {
    const g = normalizarGrupo(def);
    if (g && g.repos.some((r) => !r || typeof r.ruta !== 'string' || !r.ruta)) {
      console.log(`🔴 el grupo "${grupo}" tiene una entrada sin "ruta" — no se midió nada`);
      R.marcarTodas('no_medido', 'ilegible');
      return terminar(o, R, 2, 'no_medido', `el grupo "${grupo}" tiene una entrada sin "ruta"`);
    }
  }
  const declaradas = new Map();
  for (const d of cfg.diferencias_declaradas || []) {
    for (const campo of ['grupo', 'rasgo', 'motivo', 'fecha', 'revision']) {
      if (!d[campo]) {
        console.log(`🔴 una diferencia declarada no dice "${campo}" — sin motivo ni fecha no es una decisión, es un permiso`);
        R.marcarTodas('no_medido', 'declaracion_incompleta');
        return terminar(o, R, 1, 'no_medido', `una diferencia declarada no dice "${campo}"`);
      }
    }
    // 🔴 la revisión se compara como texto: una que no es AAAA-MM-DD («2026/09/01», «permanente») no vencía NUNCA y
    // amparaba para siempre (revisión adversarial de la 2.25). Se trata como una declaración incompleta.
    if (typeof d.revision !== 'string' || !DIA.test(d.revision)) {
      console.log(`🔴 la diferencia declarada ${d.grupo}/${d.rasgo} tiene una "revision" que no es AAAA-MM-DD (${JSON.stringify(d.revision)}) — así no vence nunca: es un permiso`);
      R.marcarTodas('no_medido', 'declaracion_incompleta');
      return terminar(o, R, 1, 'no_medido', `la diferencia declarada ${d.grupo}/${d.rasgo} tiene una "revision" que no es AAAA-MM-DD`);
    }
    // 🔴 vencida: no ampara, y la comparación SIGUE (story 2.25) — antes cortaba acá y no se comparaba nada más
    if (d.revision < hoy) {
      console.log(`🔴 la diferencia declarada ${d.grupo}/${d.rasgo} venció el ${d.revision} — o se cierra, o se re-declara con fecha nueva`);
      R.res.vencidas.push({ grupo: d.grupo, rasgo: d.rasgo, revision: d.revision });
      continue;
    }
    declaradas.set(`${d.grupo}/${d.rasgo}`, d);
    R.res.declaradas.push({ grupo: d.grupo, rasgo: d.rasgo, revision: d.revision });
  }
  // cada declaración vencida cuenta en los repos de su grupo
  for (const v of R.res.vencidas) {
    const g = normalizarGrupo((cfg.grupos || {})[v.grupo]);
    for (const r of new Set(((g && g.repos) || []).map((x) => x && x.ruta))) { const e = R.rutas.get(r); if (e) e.vencidas += 1; }
  }

  let divergencias = 0, ausentes = 0, comparados = 0;
  const lineas = [];

  const avisos = [];
  for (const [grupo, def] of Object.entries(cfg.grupos || {})) {
    const g = normalizarGrupo(def);
    if (!g) {
      console.log(`🔴 el grupo "${grupo}" no es ni una lista de repos ni un objeto con "repos"`);
      R.marcarTodas('no_medido', 'ilegible');
      return terminar(o, R, 2, 'no_medido', `el grupo "${grupo}" no es ni una lista de repos ni un objeto con "repos"`);
    }
    const textos = {};
    const rutaDe = {};
    const nombres = nombresDelGrupo(g);
    // un grupo al que ningún rasgo le aplica se lee como siempre (lo que imprime no cambia), pero no cuenta en el resultado
    const juega = enJuego(cfg, grupo, g);
    for (const [i, r] of g.repos.entries()) {
      const nombre = nombres[i];
      rutaDe[nombre] = r.ruta;
      const hayCarpeta = fs.existsSync(path.join(raiz, r.ruta));
      const f = path.join(raiz, r.ruta, g.archivo);
      // 🔴 NO SE PREGUNTA POR EL DISCO ANTES DE MIRAR LO PUBLICADO (2026-09-04). Acá había un
      // `if (!fs.existsSync(f)) { ausentes++; continue; }` JUSTO ANTES de leer `origin/main`, o sea
      // que el arreglo de abajo —"se compara lo publicado, no el disco"— quedaba anulado para el
      // caso más común: el clon parado en `dev`, que es donde trabaja el dev. Si el archivo existe
      // en `origin/main` pero no en el árbol de trabajo, el repo se contaba como "no está en esta
      // máquina" y salía de la comparación ENTERA, en silencio.
      //
      // Medido el 2026-09-04, revisión de cierre: los pipelines de PRODUCCIÓN de dos productos no se
      // compararon con nada —ni siquiera el freno de retroceso, que está marcado `exigido`— porque
      // sus clones estaban en `dev`. El control decía "1 divergencia sobre 55" habiendo dejado dos
      // repos afuera. Un control que se saltea lo que no encuentra en el disco mide menos de lo que
      // dice, y "no medido" se lee como "coincide" — guides/incident-log.md#case-parity-skipped-repos-2026-09-04.
      //
      // Ahora: primero lo publicado; el disco es el plan B; y sólo si FALLAN LOS DOS es ausente.
      //
      // La pregunta que este control contesta es "¿los cinco productos hacen lo mismo?", y eso se
      // decide sobre lo que CORRE, o sea `origin/main`. Leía el árbol de trabajo, así que un
      // checkout parado en otra rama —lo normal: el dev trabaja en `dev`— se reportaba como
      // divergencia del PRODUCTO. Medido el 2026-09-03: el backend de un producto, 29 commits atrás,
      // producía CUATRO divergencias que en `origin/main` no existen. Un control que da falsas
      // alarmas se apaga, y se lleva puestos los casos donde sí importaba — guides/incident-log.md#revision-final-de-los-14-pipelines-2026-09-03.
      //
      // El disco sigue siendo el plan B —para un repo sin remoto, o sin ese ref— pero AVISANDO:
      // "no pude leer lo publicado" y "leí lo publicado" no son lo mismo y no se pueden confundir.
      let leido = null;
      try {
        leido = cp.execFileSync('git', ['-C', path.join(raiz, r.ruta), 'show', `origin/main:${g.archivo}`],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
      } catch (_) { leido = null; }
      if (leido === null) {
        avisos.push(`  ⚠️ ${nombre} (${grupo}): no pude leer ${g.archivo} de origin/main — se compara el archivo del disco, que puede estar en otra rama`);
        try { leido = fs.readFileSync(f, 'utf8'); }
        catch (_) {
          textos[nombre] = null; ausentes++;
          if (juega) {
            R.res.no_medidos.push({ grupo, producto: r.producto, ruta: r.ruta,
              motivo: hayCarpeta ? `no se pudo leer ${g.archivo} ni de origin/main ni del disco` : 'no está en la carpeta de los clones' });
            R.marcar(r.ruta, 'no_medido', hayCarpeta ? 'ilegible' : 'sin_clon');
          }
          continue;
        }
        if (juega) { R.res.desde_disco.push({ grupo, producto: r.producto }); R.marcar(r.ruta, 'desde_disco', null); }
      }
      textos[nombre] = leido;
    }
    const presentes = Object.entries(textos).filter(([, t]) => t !== null);
    if (presentes.length < 2) {
      lineas.push(`  ${grupo}: sólo ${presentes.length} repo(s) en esta máquina — no alcanza para comparar`);
      if (juega) {
        R.res.grupos_sin_comparar.push({ grupo, motivo: `sólo ${presentes.length} repo(s) leído(s): no alcanza para comparar` });
        for (const [n] of presentes) R.marcar(rutaDe[n], 'no_medido', 'grupo_sin_comparar');
      }
      continue;
    }
    // en cuántos rasgos quedó cada repo del lado distinto: el lado más chico (con empate, los dos)
    const contar = (lado) => { for (const n of new Set(lado.map((x) => rutaDe[x]))) { const e = R.rutas.get(n); if (e) e.divergencias += 1; } };
    for (const rasgo of cfg.rasgos) {
      // Un rasgo sin `id` o sin `patron` NO se saltea en silencio: `new RegExp(undefined)` compila
      // sin quejarse, no matchea nunca, y sumaría una comparación que en realidad no se hizo — o
      // sea, inflaría el "todos coinciden" con una medición fantasma. (Cazado el 2026-09-01 al
      // meter por error un bloque de comentario dentro del array de rasgos.)
      if (!rasgo.id || typeof rasgo.patron !== 'string') {
        console.log(`🔴 hay una entrada en "rasgos" sin id o sin patron: ${JSON.stringify(rasgo).slice(0, 120)}`);
        console.log('   Un rasgo que no se puede evaluar NO es un rasgo que pasa.');
        R.marcarTodas('no_medido', 'ilegible');
        return terminar(o, R, 2, 'no_medido', 'hay una entrada en "rasgos" sin id o sin patron');
      }
      // ¿Le aplica a este grupo? Con `grupos` explícito, sólo a ésos. Sin `grupos`, a todos los
      // grupos salvo los que pidieron recibir únicamente rasgos que los nombren.
      if (!aplica(rasgo, grupo, g)) continue;
      let rx;
      try { rx = new RegExp(rasgo.patron, 'm'); }
      catch (e) {
        console.log(`🔴 el rasgo ${rasgo.id} tiene un patrón ilegible: ${e.message}`);
        R.marcarTodas('no_medido', 'ilegible');
        return terminar(o, R, 2, 'no_medido', `el rasgo ${rasgo.id} tiene un patrón ilegible`);
      }
      comparados++;
      // Con `bloque`, el patrón se evalúa sólo sobre ese bloque de nivel raíz (ausente = no lo tiene).
      const donde = (t) => (rasgo.bloque ? (bloqueRaiz(t, rasgo.bloque) || '') : t);
      const tiene = presentes.filter(([, t]) => rx.test(donde(t))).map(([n]) => n);
      const noTiene = presentes.filter(([, t]) => !rx.test(donde(t))).map(([n]) => n);
      const clave = `${grupo}/${rasgo.id}`;

      // 🔴 UNANIMIDAD NO ES SIEMPRE ACUERDO (2026-09-01). Este control compara los productos
      // ENTRE SÍ, así que si los cinco dejan de hacer lo mismo a la vez, los cinco coinciden y
      // sale verde. Para los rasgos que tienen un criterio ÚNICO escrito afuera —hoy, el guión
      // `scripts/ci/audit-dependencies.js`— eso no alcanza: un rasgo `exigido` que NADIE
      // cumple es un hallazgo, no un acuerdo. Sin esto, borrar el `dotnet restore` de los cinco
      // backends el mismo día dejaría a los cinco escaneando a ciegas, en verde.
      if (rasgo.exigido && !tiene.length) {
        if (declaradas.has(clave)) {
          lineas.push(`  ⚠️ ${grupo} · ${rasgo.que}: NINGUNO lo hace, DECLARADO (revisar ${declaradas.get(clave).revision})`);
          continue;
        }
        divergencias++;
        R.res.divergencias.push({ grupo, rasgo: rasgo.id, que: rasgo.que, tienen: [], no_tienen: noTiene, ninguno: true });
        contar(noTiene);
        lineas.push(`  🔴 ${grupo} · ${rasgo.que}`);
        lineas.push(`       NINGUNO lo hace — y el criterio único (${rasgo.criterio || 'scripts/ci/'}) sí.`);
        lineas.push('       Coincidir en no hacerlo no es estar de acuerdo: es el mismo agujero en los cinco.');
        continue;
      }

      if (!tiene.length || !noTiene.length) continue;       // todos igual: nada que decir
      if (declaradas.has(clave)) {
        lineas.push(`  ⚠️ ${grupo} · ${rasgo.que}: difiere, DECLARADO (revisar ${declaradas.get(clave).revision})`);
        continue;
      }
      divergencias++;
      R.res.divergencias.push({ grupo, rasgo: rasgo.id, que: rasgo.que, tienen: tiene, no_tienen: noTiene });
      if (tiene.length <= noTiene.length) contar(tiene);
      if (noTiene.length <= tiene.length) contar(noTiene);
      lineas.push(`  🔴 ${grupo} · ${rasgo.que}`);
      lineas.push(`       lo tienen: ${tiene.join(', ')}`);
      lineas.push(`       NO lo tienen: ${noTiene.join(', ')}`);
    }
  }

  for (const l of lineas) console.log(l);
  if (avisos.length) {
    console.log(`\n⚠️ ${avisos.length} archivo(s) se compararon desde el DISCO y no desde lo publicado:`);
    avisos.forEach(a => console.log(a));
  }
  if (ausentes) console.log(`\n⚠️ ${ausentes} repo(s) no están en esta máquina: NO se compararon. "No medido" no es "coincide".`);
  R.res.comparaciones = comparados;
  if (comparados === 0) {
    console.log('🔴 no se comparó nada — no puedo opinar');
    // una declaración vencida sale 1 aunque no se haya podido comparar nada, como siempre (AC 3)
    return terminar(o, R, R.res.vencidas.length ? 1 : 2, 'no_medido', 'no se comparó nada');
  }
  // se comparó: medido si todo se leyó de lo publicado; parcial si algo quedó afuera o salió del disco
  const estado = R.res.no_medidos.length || R.res.desde_disco.length || R.res.grupos_sin_comparar.length ? 'parcial' : 'medido';
  if (divergencias) {
    console.log(`\n🔴 ${divergencias} divergencia(s) entre productos, sobre ${comparados} comparación(es).`);
    console.log('   Si alguna es legítima, declarala en product-parity.json con motivo y fecha.');
    return terminar(o, R, 1, estado, null);
  }
  if (R.res.vencidas.length) {
    console.log(`\n🔴 ${R.res.vencidas.length} diferencia(s) declarada(s) vencida(s): o se cierran, o se re-declaran con fecha nueva.`);
    return terminar(o, R, 1, estado, null);
  }
  console.log(`✅ paridad entre productos: ${comparados} comparación(es), todos coinciden`);
  return terminar(o, R, 0, estado, null);
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { main, bloqueRaiz, normalizarGrupo };
