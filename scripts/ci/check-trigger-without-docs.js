#!/usr/bin/env node
'use strict';
/**
 * ¿Un merge de SÓLO DOCUMENTACIÓN construye, despliega y pide producción?
 *
 * 🔴 POR QUÉ EXISTE (2026-09-24).
 *
 * Ese día un pull request del backend de un producto —una story: su spec, la evidencia del pipeline
 * y la guía del tester; 29 archivos, NINGUNO de código— entró a `main` y disparó la corrida 10998:
 * compiló, corrió las pruebas, desplegó a staging, subió la versión a 1.0.248 y encoló el pedido de
 * aprobación de PRODUCCIÓN (corrida 11002). Nadie lo pidió: `requestedBy` era el propio Azure. El día
 * anterior había pasado lo mismo con el sitio de Totora, y se parchó A MANO ese pipeline —o sea que
 * el arreglo vivía en un repo y el problema en todos.
 *
 * Dos causas, y ninguna es de un repo:
 *   1. Los pipelines con lista de rutas (`trigger.paths.include`) llevan `.tycon/**`. Entró el
 *      2026-09-01 "como los otros cuatro" —por paridad, no por necesidad: ningún paso del build lee
 *      `.tycon/`, y `affected-forms.js` lo declara "no afecta al paquete" desde el 04-09— y el
 *      pipeline TYCON escribe `.tycon/runtime-waivers.jsonl` en casi toda story. O sea: casi todo merge
 *      de documentación construye. Medido ese día: 11 pipelines.
 *   2. Los pipelines SIN lista de rutas construyen con cualquier commit: para Azure, sin filtro la
 *      raíz está incluida. Los sitios de los productos estaban así.
 *
 * Un pedido de producción que no trae código no es inofensivo: quema una aprobación humana, ocupa un
 * carril del grupo de agentes, y quien aprueba tiene que averiguar qué trae —o aprueba de más.
 *
 * 🔴 QUÉ HACE. Toma el `trigger:` de push de cada pipeline PUBLICADO (`origin/main`, como el control de
 * paridad: lo que CORRE, no el disco) y le enfrenta el juego de archivos de un merge de sólo
 * documentación —la lista REAL de ese pull request, más lo que toca un commit de documentación en un sitio—
 * aplicando las reglas de Azure. Si algún archivo de ese juego queda incluido, ese pipeline construye
 * por documentación, y el informe dice POR CUÁL archivo y POR QUÉ patrón. Después, la contra-prueba:
 * el mismo pipeline TIENE que disparar con código; un filtro que apaga todo también está roto, y sin
 * esta mitad un `include` vacío saldría verde.
 *
 * 🔴 LAS REGLAS DE AZURE que simula (learn.microsoft.com › pipelines › repos › azure-repos-git, versión
 * del 2026-08-07; citadas para que nadie tenga que confiar en la memoria del autor):
 *   · «If you don't set path filters, then the root folder of the repo is implicitly included by default.»
 *   · «If you exclude a path, you cannot also include it unless you qualify it to a deeper folder.»
 *     → entre un include y un exclude que cubren el mismo archivo gana el MÁS ESPECÍFICO, y a igual
 *       especificidad gana el exclude (no se puede incluir lo que se excluyó al mismo nivel).
 *   · «You can use wildcard characters (`**`, `*`, or `?`) when specifying path filters.» `*` y `?` no
 *     cruzan `/`; `**` sí. Una ruta sin comodín es un PREFIJO por carpeta (`docs` cubre `docs/x.md`).
 *   · «Paths in Git are case-sensitive.»
 *   · Dispara si AL MENOS UN archivo cambiado queda incluido; con todos excluidos, no.
 *   · Sin `trigger:` en el YAML, Azure dispara con cualquier push a cualquier rama: cuenta como "sin filtro".
 *
 * 🔴 LO QUE NO CUBRE, a propósito:
 *   · `trigger: none`: ese pipeline no se dispara por push (lo encola otro pipeline o una persona). Se
 *     saltea y se dice. Los de PRODUCCIÓN son así: los dispara el CI al terminar, así que heredan el
 *     veredicto del CI —si el CI no construye por documentación, producción no se pide.
 *   · ramas, `batch`, etiquetas y el bloque `pr:`: otra pregunta, otro control.
 *   · un repo que legítimamente construya con documentación (un sitio de docs): hoy no hay ninguno entre
 *     los productos. El día que aparezca, se declara acá con motivo y fecha —no se afloja el control
 *     para todos.
 *   · el pipeline de PUBLICACIÓN del arnés (pipelines/azure-pipelines-public-leak-check.yml, en el repo del
 *     equipo), declarado el 2026-10-04 (story 8.18): no construye, no despliega ni pide producción —hoy
 *     verifica que lo publicado no filtre nada privado—, y desde 2026-10-13 un merge no lo dispara
 *     (`trigger: none`). No está en product-parity.json; con --file da 2 (no tiene qué medir), y
 *     trigger-without-docs.test.sh lo deja fijado.
 *
 * Los repos salen de `product-parity.json` (la única lista de qué pipelines son "los productos"; sin --config, la de la
 * organización en su repo de operaciones, como en check-product-parity.js);
 * un grupo cuyo archivo lleva `trigger: none` (producción) cuenta como "no aplica", no como medido.
 *
 * Uso:  node check-trigger-without-docs.js [--root <dir>] [--config <product-parity.json>] [--json]
 *       node check-trigger-without-docs.js --file <azure-pipelines.yml> [--file …]   (un YAML suelto)
 * (story 8.9, tanda B3a: --root y --file tenían nombre en castellano; el viejo sigue andando hasta el retiro)
 * Sale 0 ningún pipeline medido construye por documentación · 1 alguno construye (o no construye ni
 * con código) · 2 no pudo medir lo suficiente para opinar (o llegó una opción con su nombre viejo y el nuevo a la vez).
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const os = require('os');
const { bloqueRaiz, normalizarGrupo, configPorDefecto } = require('./check-product-parity.js');
// Las opciones renombradas a inglés (story 8.9, tanda B3a): el nombre viejo sigue andando hasta el retiro. El traductor
// vive al lado y viaja con este archivo en el artefacto arnes-ci.
const { aliasLegacyOptions, LegacyOptionsError } = (() => {
  try { return require('./legacy-options.js'); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') process.stderr.write(`⚠️  legacy-options.js no cargó (${e && e.message}): los nombres viejos de este guion no se traducen\n`); return { aliasLegacyOptions: (argv) => argv, LegacyOptionsError: Error }; }
})();

/**
 * El juego de archivos de un merge de SÓLO documentación. No es una lista inventada: son las rutas
 * de un pull request del backend de un producto del equipo (2026-09-24, 29 archivos y 0 de código — guides/incident-log.md#merge-de-solo-docs-que-pide-produccion-2026-09-24), más lo que
 * toca un commit de documentación en un sitio o en un repo sin pipeline TYCON. Cada entrada es algo
 * que el arnés o una persona ESCRIBE sin cambiar una línea de lo que se construye.
 *
 * 🔴 Lo que NO está, y por qué: `pruebas-pendientes.json` y las declaraciones de vulnerabilidades no
 * cambian el paquete, pero SÍ el veredicto (borrar una deuda tiene que volver a juzgar —caso del pull
 * request 2984 de los formularios de un producto del equipo, 2026-09-05 — guides/incident-log.md#deuda-de-pruebas-borrada-sin-pagarla-2026-09-05), así que un merge que las toca DEBE construir. Y `azure-pipelines*.yml`
 * tampoco: un cambio al pipeline tiene que disparar una corrida.
 */
const MERGE_SOLO_DOCS = [
  // ── lo que deja una corrida del pipeline TYCON (ese pull request) ──
  '.advisors/dod-runtime/CA-2-e2e-gate-20260924T144134Z.md',
  '.advisors/dod-runtime/CA-2-runtime-matrix.md',
  '.advisors/dod-runtime/CA-2-smoke-e2e-gate-20260924T151622Z.md',
  '.advisors/pipeline-runs/CA-2-20260924T122243Z/findings.json',
  '.advisors/pipeline-runs/CA-2-20260924T122243Z/review-roster.json',
  '.engram/chunks/e083966f.jsonl.gz',
  '.engram/manifest.json',
  '.tycon/runtime-waivers.jsonl',
  '.tycon/dod-scenarios/CA-2.md',
  'qa/PED-1-pasos.md',
  'qa/story-ca2-detalle-de-ruta-guia-qa.html',
  'specs/story-ca2-detalle-de-ruta.md',
  'tasks/todo.md',
  // ── lo que toca un commit de documentación en un sitio o un repo sin pipeline TYCON ──
  'README.md',
  'CLAUDE.md',
  'AGENTS.md',
  '.engram-project',
  'docs/arquitectura.md',
];

/**
 * La contra-prueba: archivos de CÓDIGO de las formas que tienen los productos (plugin .NET,
 * formularios, sitio Next.js). Con al menos uno el pipeline TIENE que disparar.
 */
const CODIGO = [
  'src/Plugin/Servicio.cs',
  'Formulario/src/App.tsx',
  'database/001_tabla.sql',
  'package.json',
  'app/page.tsx',
];

/** Lo que se le sugiere a un pipeline sin filtro. Es la lista de arriba, por carpeta. */
const EXCLUDE_SUGERIDO = ['README.md', 'CLAUDE.md', 'AGENTS.md', '.engram-project', 'docs', 'specs', 'qa',
  'tasks', '.advisors', '.engram', '.tycon', '.claude', '.vscode'];

function args(argv) {
  const o = { raiz: null, config: null, configDada: false, archivos: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') o.raiz = argv[++i];
    else if (argv[i] === '--config') { o.configDada = true; o.config = argv[++i]; }
    else if (argv[i] === '--file') o.archivos.push(argv[++i]);
    else if (argv[i] === '--json') o.json = true;
  }
  return o;
}

function expandir(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Quita un comentario `#` que esté fuera de comillas. */
function quitarComentario(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

/** Un ítem de lista YAML (`- 'src/**'  # comentario`) → `src/**`. */
function limpiarItem(l) {
  let s = quitarComentario(l).trim().replace(/^-\s*/, '').trim();
  if (s.length >= 2 && ((s[0] === "'" && s.endsWith("'")) || (s[0] === '"' && s.endsWith('"')))) s = s.slice(1, -1);
  return s.trim();
}

/**
 * El `trigger:` de push, leído del texto del YAML (sin parser, como los hermanos: el formato de estos
 * archivos es regular). Devuelve { tipo: 'none' | 'sin-paths' | 'paths', include, exclude }; con
 * `tipo: 'sin-trigger'` si el archivo no tiene la clave —que para Azure es "dispara con todo".
 */
function leerTrigger(texto) {
  const bloque = bloqueRaiz(texto, 'trigger');
  if (bloque === null) return { tipo: 'sin-trigger', include: [], exclude: [] };
  const lineas = bloque.split('\n').map((l) => l.replace(/\r$/, ''));
  const valor = quitarComentario(lineas[0]).trim().replace(/^trigger:\s*/, '');
  if (valor === 'none') return { tipo: 'none', include: [], exclude: [] };
  const r = { tipo: 'sin-paths', include: [], exclude: [] };
  let enPaths = false, indentPaths = -1, lista = null;
  for (let i = 1; i < lineas.length; i++) {
    const sinCom = quitarComentario(lineas[i]);
    if (!sinCom.trim()) continue;
    const indent = sinCom.match(/^\s*/)[0].length;
    const t = sinCom.trim();
    if (enPaths && indent <= indentPaths) { enPaths = false; lista = null; }
    if (!enPaths) {
      if (/^paths:\s*$/.test(t)) { enPaths = true; indentPaths = indent; r.tipo = 'paths'; }
      continue;
    }
    const m = t.match(/^(include|exclude):\s*(.*)$/);
    if (m) {
      lista = m[1];
      const inline = m[2].trim();
      if (inline.startsWith('[')) {       // forma `include: [a, b]`
        inline.replace(/^\[|\]$/g, '').split(',').map((x) => limpiarItem(x)).filter(Boolean)
          .forEach((x) => r[lista].push(x));
        lista = null;
      }
      continue;
    }
    if (lista && t.startsWith('-')) { const it = limpiarItem(t); if (it) r[lista].push(it); }
  }
  return r;
}

function normalizarPatron(p) { return p.trim().replace(/^\/+/, '').replace(/\/+$/, ''); }
function tieneComodin(p) { return /[*?]/.test(p); }
/** Cuánto "manda" un patrón: el largo de su prefijo literal (antes del primer comodín). */
function especificidad(p) { const i = p.search(/[*?]/); return i < 0 ? p.length : i; }

function aRegex(p) {
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') { if (p[i + 1] === '*') { out += '.*'; i++; } else out += '[^/]*'; }
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + out + '$');
}

/** ¿El patrón cubre el archivo? Sin comodín: prefijo por carpeta. Con comodín: el archivo o una carpeta de arriba. */
function cubre(patron, archivo) {
  const p = normalizarPatron(patron);
  if (p === '' || p === '.') return true;                       // la raíz
  if (!tieneComodin(p)) return archivo === p || archivo.startsWith(p + '/');
  const rx = aRegex(p);
  const partes = archivo.split('/');
  for (let n = partes.length; n >= 1; n--) if (rx.test(partes.slice(0, n).join('/'))) return true;
  return false;
}

/**
 * Para un archivo cambiado: null si NO queda incluido; si sí, el patrón de include que lo incluye
 * ('(raíz)' cuando no hay lista include: Azure incluye la raíz por defecto).
 */
function incluido(trigger, archivo) {
  let inc = null, incEsp = -1;
  if (!trigger.include.length) { inc = '(raíz)'; incEsp = 0; }
  for (const p of trigger.include) {
    if (!cubre(p, archivo)) continue;
    const e = especificidad(normalizarPatron(p));
    if (e > incEsp) { incEsp = e; inc = p; }
  }
  if (inc === null) return null;
  let excEsp = -1;
  for (const p of trigger.exclude) {
    if (!cubre(p, archivo)) continue;
    const e = especificidad(normalizarPatron(p));
    if (e > excEsp) excEsp = e;
  }
  if (excEsp >= incEsp) return null;                            // gana el exclude más específico (o igual)
  return inc;
}

/** El veredicto de un `trigger:`: por qué archivos de documentación dispara, y si dispara con código. */
function evaluar(trigger) {
  const porDocs = [];
  for (const a of MERGE_SOLO_DOCS) { const p = incluido(trigger, a); if (p !== null) porDocs.push({ archivo: a, patron: p }); }
  const conCodigo = CODIGO.filter((a) => incluido(trigger, a) !== null);
  return { porDocs, conCodigo };
}

/**
 * Los archivos que disparan, agrupados por su primera carpeta: lo que hay que excluir es la CARPETA,
 * así que se nombra cada una (con sus archivos si son pocos, con la cuenta si son muchos).
 */
function resumirArchivos(archivos) {
  const porRaiz = new Map();
  for (const a of archivos) {
    const r = a.includes('/') ? a.split('/')[0] : a;
    if (!porRaiz.has(r)) porRaiz.set(r, []);
    porRaiz.get(r).push(a);
  }
  return [...porRaiz.entries()].map(([r, lista]) => (lista.length <= 2 ? lista.join(', ') : `${r}/ (${lista.length} archivos)`)).join(', ');
}

/** Las líneas del informe de un pipeline que construye por documentación. */
function explicar(nombre, archivo, trigger, v) {
  const out = [`  🔴 ${nombre} · ${archivo}: construye con un merge de sólo documentación`];
  const porPatron = new Map();
  for (const x of v.porDocs) { if (!porPatron.has(x.patron)) porPatron.set(x.patron, []); porPatron.get(x.patron).push(x.archivo); }
  for (const [patron, archivos] of porPatron) {
    if (patron === '(raíz)') {
      // Sin lista include entra TODO: lo útil es nombrar las carpetas que se escapan, no cada archivo.
      const raices = [...new Set(archivos.map((a) => (a.includes('/') ? a.split('/')[0] + '/' : a)))];
      out.push(`       sin lista include: la raíz está incluida → se escapan ${raices.join(', ')}`);
    } else {
      out.push(`       por \`${patron}\` → ${resumirArchivos(archivos)}`);
    }
  }
  if (trigger.tipo !== 'paths' || !trigger.include.length) {
    out.push(`       → agregar \`paths.exclude\` con: ${EXCLUDE_SUGERIDO.join(' · ')}`);
  } else if (porPatron.has('.tycon/**')) {
    out.push('       → sacar `.tycon/**` de `paths.include`: ningún paso del build lo lee (affected-forms.js lo declara inerte desde 2026-09-04)');
  }
  return out;
}

/** Lee el archivo publicado (origin/main); si no puede, el del disco AVISANDO; si no, null. */
function leerPublicado(repoDir, archivo, avisos, etiqueta) {
  try {
    return cp.execFileSync('git', ['-C', repoDir, 'show', `origin/main:${archivo}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
  } catch (_) { /* sin remoto, sin ref, o sin el archivo en main */ }
  try {
    const t = fs.readFileSync(path.join(repoDir, archivo), 'utf8');
    avisos.push(`  ⚠️ ${etiqueta}: no pude leer ${archivo} de origin/main — se mira el archivo del disco, que puede estar en otra rama`);
    return t;
  } catch (_) { return null; }
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
  try { argv = aliasLegacyOptions(argv0, 'archivo:file raiz:root', 'scripts/ci/check-trigger-without-docs.js'); }
  catch (e) {
    if (!(e instanceof LegacyOptionsError)) throw e;
    console.log(`🔴 ${e.message} — no se midió nada`);
    return 2;
  }
  const o = args(argv);
  const resultados = [];      // { nombre, archivo, tipo, veredicto: 'docs' | 'sin-codigo' | 'ok' | 'no-aplica', detalle }
  const lineas = [], avisos = [];
  let ausentes = 0;

  const juzgar = (nombre, archivo, texto) => {
    const trigger = leerTrigger(texto);
    if (trigger.tipo === 'none') { resultados.push({ nombre, archivo, tipo: trigger.tipo, veredicto: 'no-aplica' }); return; }
    const v = evaluar(trigger);
    if (v.porDocs.length) {
      resultados.push({ nombre, archivo, tipo: trigger.tipo, veredicto: 'docs', porDocs: v.porDocs });
      lineas.push(...explicar(nombre, archivo, trigger, v));
      return;
    }
    if (!v.conCodigo.length) {
      resultados.push({ nombre, archivo, tipo: trigger.tipo, veredicto: 'sin-codigo' });
      lineas.push(`  🔴 ${nombre} · ${archivo}: NO dispara ni con código (${CODIGO.join(', ')}) — el filtro apaga todo`);
      return;
    }
    resultados.push({ nombre, archivo, tipo: trigger.tipo, veredicto: 'ok' });
  };

  if (o.archivos.length) {
    for (const f of o.archivos) {
      let texto;
      try { texto = fs.readFileSync(f, 'utf8'); }
      catch (e) { console.log(`🔴 no pude leer ${f}: ${e.message}`); return 2; }
      juzgar(path.basename(path.dirname(path.resolve(f))), path.basename(f), texto);
    }
  } else {
    let cfg;
    // sin --config, la lista de la organización (check-product-parity.js, configPorDefecto: su repo de operaciones)
    if (!o.configDada) {
      const d = configPorDefecto();
      if (d.problema) { console.log(`🔴 sin la lista de productos: ${d.problema} — no se midió nada`); return 2; }
      o.config = d.ruta;
    }
    try { cfg = JSON.parse(fs.readFileSync(o.config, 'utf8')); }
    catch (e) { console.log(`🔴 no pude leer la configuración (${o.config}): ${e.message}`); return 2; }
    const sinProductos = sinProductosAProposito(cfg);
    if (sinProductos) {
      // con --json, quien lo consume recibe la misma forma de siempre, sin nada medido y con el motivo
      if (o.json && sinProductos.rc === 0) console.log(JSON.stringify({ medidos: 0, no_aplican: 0, ausentes: 0, resultados: [], sin_productos: cfg.sin_productos.trim() }, null, 2));
      else console.log(sinProductos.msg);
      return sinProductos.rc;
    }
    // Sin raíz declarada no se mide nada, y eso se dice: hasta la story 8.3 acá había la carpeta de
    // UNA máquina como último recurso, que en cualquier otra medía cero repos en silencio.
    const raizDeclarada = o.raiz || cfg.raiz_por_defecto;
    if (!raizDeclarada) { console.log('🔴 sin raíz de repos: pasá --root <carpeta> o declará raiz_por_defecto en la configuración — no se midió nada, y eso no es «todo bien»'); return 2; }
    const raiz = expandir(raizDeclarada);
    // Un mismo archivo puede estar en dos grupos (los formularios están en `frontend` y en
    // `formularios`): se mide UNA vez, con la etiqueta del primer grupo que lo nombra.
    const vistos = new Set();
    for (const [grupo, def] of Object.entries(cfg.grupos || {})) {
      const g = normalizarGrupo(def);
      if (!g) { console.log(`🔴 el grupo "${grupo}" no es ni una lista de repos ni un objeto con "repos"`); return 2; }
      for (const r of g.repos) {
        const clave = `${r.ruta}/${g.archivo}`;
        if (vistos.has(clave)) continue;
        vistos.add(clave);
        const etiqueta = `${r.producto} (${grupo})`;
        const texto = leerPublicado(path.join(raiz, r.ruta), g.archivo, avisos, etiqueta);
        if (texto === null) { ausentes++; continue; }
        juzgar(etiqueta, g.archivo, texto);
      }
    }
  }

  const medidos = resultados.filter((r) => r.veredicto !== 'no-aplica');
  const noAplican = resultados.length - medidos.length;
  const malos = medidos.filter((r) => r.veredicto !== 'ok');

  if (o.json) {
    console.log(JSON.stringify({ medidos: medidos.length, no_aplican: noAplican, ausentes, resultados }, null, 2));
  } else {
    for (const l of lineas) console.log(l);
    if (avisos.length) {
      console.log(`\n⚠️ ${avisos.length} archivo(s) se miraron desde el DISCO y no desde lo publicado:`);
      avisos.forEach((a) => console.log(a));
    }
    if (noAplican) console.log(`ℹ️ ${noAplican} pipeline(s) con \`trigger: none\` no se disparan por push: heredan el veredicto del CI que los encola.`);
    if (ausentes) console.log(`\n⚠️ ${ausentes} repo(s) no están en esta máquina: NO se midieron. "No medido" no es "no construye".`);
  }
  if (malos.length) {
    if (!o.json) {
      console.log(`\n🔴 ${malos.length} de ${medidos.length} pipeline(s) construyen con un merge de sólo documentación (o no construyen ni con código).`);
      console.log('   Cada uno lleva arriba el archivo y el patrón que lo disparan, y qué cambiar.');
    }
    return 1;
  }
  if (!medidos.length) { if (!o.json) console.log('🔴 no se midió ningún pipeline — no puedo opinar'); return 2; }
  if (!o.json) console.log(`✅ disparador sin docs: ${medidos.length} pipeline(s) medidos, ninguno construye con un merge de sólo documentación (y todos disparan con código)`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { main, leerTrigger, cubre, incluido, evaluar, MERGE_SOLO_DOCS, CODIGO, EXCLUDE_SUGERIDO };
