'use strict';
/**
 * test-deps.js — compara lo que piden las pruebas de una story con lo que el proyecto tiene declarado.
 * Casos: skills/tycon-pipeline/scripts/tests/test-deps.test.js
 *
 * Lo corre `pipeline.js validators` en el paso «Validar la historia», sin modelo: que un paquete esté declarado es una comparación exacta.
 * La tabla de lo que cada herramienta exige sin que nadie lo escriba vive en `test-deps.json`.
 *
 * Qué mira:
 *   - Las pruebas de la story: los archivos de `files_to_create`/`files_to_modify` que son pruebas JS/TS (`*.test.*`,
 *     `*.spec.*`, o bajo `tests/`, `__tests__/`, `e2e/`), con su contenido si ya existen. Sin pruebas declaradas, los
 *     archivos JS/TS declarados, y sólo para la regla del proyecto (la cobertura de vitest). Un archivo con el prefijo
 *     «(otro-repo)» es de otro repo: no se resuelve contra éste.
 *   - El texto de la story: la sección de pruebas y los bloques de código.
 *   - El `package.json` y el `tsconfig.json` más cercanos a cada archivo, subiendo sin salir del repo. Un `package.json`
 *     que la story crea cuenta como el más cercano aunque todavía no exista.
 *
 * Un archivo que existe y no se puede leer da una entrada `no_medido`: nunca una lista vacía que parezca «está todo».
 * Nada se lee fuera del repo: una ruta declarada que sale de él también es «no medido».
 *
 * Límites conocidos (no dan falsas alarmas nuevas, pueden callar): con la prueba todavía sin escribir, «usa Node» y
 * «usa Playwright» se deciden por el texto de la story entera, no por el de esa prueba; un `extends` de tsconfig que
 * apunta a un paquete (no a un archivo) no se sigue.
 */
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const SECCIONES = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const JS_TS = /\.[cm]?[jt]sx?$/i;
const TS = /\.[cm]?tsx?$/i;
const ES_PRUEBA = /(^|\/)(tests?|__tests__|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;
const MODULOS_NODE = builtinModules.filter((m) => !m.startsWith('_')).map((m) => m.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));
const USA_NODE = new RegExp(
  `\\bnode:[a-z_/]+|\\bprocess\\.[a-zA-Z]|\\b__dirname\\b|\\b__filename\\b|\\bBuffer\\.` +
  `|(require\\(\\s*|from\\s+|import\\s+)['"](${MODULOS_NODE.join('|')})(\\/[\\w/]+)?['"]`);
// Un paquete con scope cuenta si se importa (`from '@x/y'`, `require('@x/y')`, `import '@x/y'`) o va entre comillas
// invertidas: en la prosa suelta puede ser cualquier cosa.
const IMPORTA_SCOPE = /(?:from\s+|require\(\s*|import\s+)['"](@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*)(?:\/[^'"]*)?['"]|`(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*)(?:\/[^`]*)?`/gi;

const norm = (f) => String(f).replace(/\\/g, '/').replace(/^\.\//, '');
const sinBom = (t) => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);
/** ¿`abs` queda dentro de `repo`? (`/a/b2` no está dentro de `/a/b`). */
function dentro(repo, abs) {
  const rel = path.relative(repo, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function tabla() {
  try { return require('./test-deps.json').rules; } catch (e) { throw new Error(`test-deps.json, ${e.message.split('\n')[0]}`); }
}

/** Los ítems de una lista del frontmatter (`files_to_create:` con `- ruta`). */
function listaDelFrontmatter(texto, clave) {
  const m = String(texto || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return [];
  const out = [];
  let dentroDeClave = false;
  for (const l of m[1].split(/\r?\n/)) {
    if (/^\S/.test(l)) { dentroDeClave = new RegExp(`^${clave}\\s*:\\s*$`).test(l); continue; }
    const im = dentroDeClave && l.match(/^\s*-\s*(.+?)\s*$/);
    if (im) out.push(im[1].replace(/^["']|["']$/g, ''));
  }
  return out;
}

/** La sección de pruebas de la story (desde el título «Tests» hasta el próximo título del mismo nivel o más alto). */
function seccionDePruebas(texto) {
  const out = [];
  let nivel = 0;
  for (const l of String(texto || '').split(/\r?\n/)) {
    const m = l.match(/^(#{1,6})\s+(.*)$/);
    if (m && nivel && m[1].length <= nivel) nivel = 0;
    if (m && !nivel && /^tests\b/i.test(m[2].trim())) { nivel = m[1].length; continue; }
    if (nivel) out.push(l);
  }
  return out.join('\n');
}
function bloquesDeCodigo(texto) {
  return (String(texto || '').match(/```[\s\S]*?```/g) || []).join('\n');
}

/** Recorre `txt` copiando los strings JSON tal cual y pasando el resto, de a un carácter, por `fuera`. */
function fueraDeStrings(txt, fuera) {
  let out = '';
  for (let i = 0; i < txt.length; i++) {
    if (txt[i] === '"') {
      let j = i + 1;
      while (j < txt.length && txt[j] !== '"') j += txt[j] === '\\' ? 2 : 1;
      out += txt.slice(i, j + 1);
      i = j;
      continue;
    }
    const r = fuera(txt, i);
    out += r.texto;
    i = r.hasta;
  }
  return out;
}
/** JSON con comentarios y comas finales, como los escribe `tsc --init`. Los strings no se tocan. */
function parseJsonc(txt) {
  const sinComentarios = fueraDeStrings(sinBom(txt), (t, i) => {
    if (t[i] === '/' && t[i + 1] === '/') { let j = i; while (j < t.length && t[j] !== '\n') j++; return { texto: '\n', hasta: j }; }
    if (t[i] === '/' && t[i + 1] === '*') { const fin = t.indexOf('*/', i + 2); return { texto: '', hasta: fin === -1 ? t.length : fin + 1 }; }
    return { texto: t[i], hasta: i };
  });
  const sinComas = fueraDeStrings(sinComentarios, (t, i) => ({ texto: t[i] === ',' && /^,\s*[}\]]/.test(t.slice(i)) ? '' : t[i], hasta: i }));
  return JSON.parse(sinComas);
}

function crearLector(repo) {
  const cache = new Map();
  return (abs, { jsonc = false } = {}) => {
    if (cache.has(abs)) return cache.get(abs);
    let r;
    try {
      const txt = sinBom(fs.readFileSync(abs, 'utf8'));
      r = { ok: true, data: jsonc ? parseJsonc(txt) : JSON.parse(txt) };
    } catch (e) {
      r = { ok: false, motivo: e.code === 'EACCES' ? 'sin permiso de lectura' : `no se pudo leer (${e.message.split('\n')[0]})` };
    }
    r.rel = path.relative(repo, abs);
    cache.set(abs, r);
    return r;
  };
}

/**
 * El archivo `nombre` más cercano a `rel`, subiendo sin salir del repo: el que existe, o el que la story declara crear
 * (`planeados`). null si no hay.
 */
function masCercano(repo, rel, nombre, planeados = new Set()) {
  let dir = path.dirname(path.resolve(repo, rel));
  while (dentro(repo, dir)) {
    const f = path.join(dir, nombre);
    if (fs.existsSync(f)) return { abs: f, existe: true };
    if (planeados.has(norm(path.relative(repo, f)))) return { abs: f, existe: false };
    const padre = path.dirname(dir);
    if (padre === dir) break;
    dir = padre;
  }
  return null;
}

/** El contenido de una prueba declarada: `{ existe: false }`, `{ existe: true, txt }` o `{ existe: true, motivo }`. */
function leerPrueba(repo, rel) {
  const abs = path.resolve(repo, rel);
  if (!fs.existsSync(abs)) return { existe: false };
  try { return { existe: true, txt: fs.readFileSync(abs, 'utf8') }; } catch (e) {
    return { existe: true, motivo: e.code === 'EACCES' ? 'sin permiso de lectura' : `no se pudo leer (${e.code || e.message.split('\n')[0]})` };
  }
}

/** `compilerOptions.types` y `paths` del tsconfig, siguiendo los `extends` a archivos del repo (el hijo manda). */
function opcionesDeTs(repo, abs, leer) {
  const out = { types: undefined, paths: undefined, roto: null };
  for (let i = 0, f = abs; f && i < 6; i++) {
    const r = leer(f, { jsonc: true });
    if (!r.ok) { out.roto = r; return out; }
    const co = (r.data && r.data.compilerOptions) || {};
    if (out.types === undefined && co.types !== undefined) out.types = co.types;
    if (out.paths === undefined && co.paths !== undefined) out.paths = co.paths;
    const ext = r.data && r.data.extends;
    if (typeof ext !== 'string' || !ext.startsWith('.')) break;
    const sig = path.resolve(path.dirname(f), /\.json$/i.test(ext) ? ext : `${ext}.json`);
    f = dentro(repo, sig) && fs.existsSync(sig) ? sig : null;
  }
  return out;
}

function faltante(r, donde, paquete = r.suggest) {
  return { paquete, herramienta: r.tool, motivo: r.reason, caso: r.case, donde };
}

/**
 * @param {{repo: string, storyText: string, declared?: string[]}} args  `declared`: files_to_create + files_to_modify,
 *   relativos al repo y sin prefijo; si falta, sale del frontmatter de la story (los «(otro-repo) ruta» se saltean).
 * @returns {Array<object>} los faltantes (`paquete`, `herramienta`, `motivo`, `caso`, `donde`) y los «no medido»
 *   (`no_medido`, `archivo`); [] cuando no falta nada.
 */
function dependenciasDePruebas({ repo, storyText, declared }) {
  try {
    const texto = String(storyText || '');
    const lista = declared || [...listaDelFrontmatter(texto, 'files_to_create'), ...listaDelFrontmatter(texto, 'files_to_modify')]
      .filter((f) => !/^\(/.test(f));
    return calcular({ repo: path.resolve(repo), storyText: texto, declared: lista.map(norm), reglas: tabla() });
  } catch (e) {
    return [{ no_medido: `no medido: dependencias de las pruebas, ${e.message}` }];
  }
}

function calcular({ repo, storyText, declared, reglas }) {
  const regla = (tool) => reglas.find((r) => r.tool === tool);
  const out = [];
  const noMedido = (archivo, motivo) => { if (!out.some((x) => x.no_medido && x.archivo === archivo)) out.push({ no_medido: `no medido: ${archivo}, ${motivo}`, archivo }); };

  const enElRepo = declared.filter((f) => {
    if (dentro(repo, path.resolve(repo, f))) return true;
    if (JS_TS.test(f) || /(^|\/)package\.json$/.test(f)) noMedido(f, 'fuera del repo');
    return false;
  });
  const planeados = new Set(enElRepo.filter((f) => /(^|\/)package\.json$/.test(f)));
  const pruebas = enElRepo.filter((f) => JS_TS.test(f) && ES_PRUEBA.test(f));
  const archivos = pruebas.length ? pruebas : enElRepo.filter((f) => JS_TS.test(f));
  if (!archivos.length) return out;
  const textoDePruebas = `${seccionDePruebas(storyText)}\n${bloquesDeCodigo(storyText)}`;
  const leer = crearLector(repo);

  // El contenido de cada prueba; una que existe y no se puede leer es «no medido» y no entra en las reglas.
  const contenido = new Map();
  for (const f of pruebas) {
    const c = leerPrueba(repo, f);
    if (c.motivo) noMedido(f, c.motivo);
    else contenido.set(f, c.existe ? c.txt : null);
  }

  // Agrupar por el package.json más cercano: en los formularios hay uno por formulario. Sin ninguno, la clave es ''.
  const grupos = new Map();
  for (const f of archivos) {
    if (pruebas.length && !contenido.has(f)) continue;
    const m = masCercano(repo, f, 'package.json', planeados);
    const clave = m ? m.abs : '';
    if (!grupos.has(clave)) grupos.set(clave, { lista: [], existe: !!(m && m.existe) });
    grupos.get(clave).lista.push(f);
  }

  const deps = new Map();   // clave del grupo → { declarados, propio, rel }; null si su package.json no se pudo leer
  for (const [clave, g] of grupos) {
    if (!clave) { deps.set(clave, { declarados: {}, propio: null, rel: 'package.json (no hay)' }); continue; }
    if (!g.existe) { deps.set(clave, { declarados: {}, propio: null, rel: path.relative(repo, clave) }); continue; }
    const r = leer(clave);
    if (!r.ok) { noMedido(r.rel, r.motivo); deps.set(clave, null); continue; }
    const declarados = {};
    for (const k of SECCIONES) Object.assign(declarados, (r.data && r.data[k]) || {});
    deps.set(clave, { declarados, propio: r.data && r.data.name, rel: r.rel });
  }
  // «Declarado»: está en el package.json, o la story pone ese package.json en sus archivos Y nombra el paquete.
  const tiene = (clave, nombre) => {
    const d = deps.get(clave);
    if (!d) return true;   // ilegible: ya salió como «no medido»
    if (d.declarados[nombre] || d.propio === nombre) return true;
    return !!clave && planeados.has(norm(path.relative(repo, clave))) && storyText.includes(nombre);
  };

  const nombraPlaywright = /playwright/i.test(textoDePruebas) && !/cypress/i.test(textoDePruebas);
  const prefijosDeAlias = new Set();
  for (const [clave, g] of grupos) {
    // Con el package.json ilegible, `tiene` da todo por declarado (ya salió «no medido»); el tsconfig se mira igual.
    const d = deps.get(clave);
    const donde = d ? d.rel : null;
    // vitest: lo exige el portón, aunque la story no nombre la cobertura.
    const rv = regla('vitest');
    if (d && rv.detect.some((x) => d.declarados[x]) && !rv.anyOf.some((p) => tiene(clave, p))) out.push(faltante(rv, donde));
    if (!pruebas.length) continue;
    // Playwright: la prueba lo importa; si todavía no existe, vive bajo e2e/ o es un .spec y la story nombra Playwright.
    const rp = regla('playwright');
    const conPlaywright = g.lista.filter((f) => {
      const c = contenido.get(f);
      if (c !== null) return c.includes('@playwright/test');
      return nombraPlaywright && (/(^|\/)e2e\//i.test(f) || /\.spec\./i.test(f));
    });
    if (conPlaywright.length && !rp.anyOf.some((p) => tiene(clave, p))) out.push(faltante(rp, donde));
    // Pruebas TypeScript que usan Node: @types/node, y «node» en compilerOptions.types si tsconfig fija la lista.
    const rt = regla('typescript');
    const conNode = g.lista.filter((f) => {
      if (!TS.test(f)) return false;
      const c = contenido.get(f);
      return USA_NODE.test(c !== null ? c : textoDePruebas);
    });
    if (conNode.length && !rt.anyOf.some((p) => tiene(clave, p))) out.push(faltante(rt, donde));
    for (const f of g.lista) {
      const m = masCercano(repo, f, 'tsconfig.json');
      if (!m) continue;
      const ts = opcionesDeTs(repo, m.abs, leer);
      if (ts.roto) { if (conNode.includes(f)) noMedido(ts.roto.rel, ts.roto.motivo); continue; }
      for (const k of Object.keys(ts.paths || {})) prefijosDeAlias.add(k.replace(/\*.*$/, ''));
      const rel = path.relative(repo, m.abs);
      if (conNode.includes(f) && Array.isArray(ts.types) && !ts.types.includes(rt.tsconfigType) && !out.some((x) => x.donde === rel)) {
        out.push(faltante(rt, rel, rt.tsconfigType));
      }
    }
  }

  // Paquetes con scope que la story importa o nombra en sus pruebas: alcanza con que alguno de los package.json lo
  // tenga. Un alias de `compilerOptions.paths` no es un paquete.
  if (pruebas.length) {
    const nombrados = new Set([...textoDePruebas.matchAll(IMPORTA_SCOPE)].map((m) => m[1] || m[2]));
    const claves = [...grupos.keys()].filter((c) => deps.get(c));
    for (const nombre of nombrados) {
      if ([...prefijosDeAlias].some((p) => p && `${nombre}/`.startsWith(p))) continue;
      if (!claves.length || claves.some((c) => tiene(c, nombre))) continue;
      if (out.some((x) => x.paquete === nombre)) continue;
      out.push({ paquete: nombre, herramienta: 'la story', motivo: 'la story lo nombra en sus pruebas y el proyecto no lo declara', caso: null, donde: deps.get(claves[0]).rel });
    }
  }
  return out;
}

module.exports = { dependenciasDePruebas, parseJsonc, seccionDePruebas, listaDelFrontmatter };
