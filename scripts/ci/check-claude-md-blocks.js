#!/usr/bin/env node
'use strict';
/**
 * check-claude-md-blocks.js — el presupuesto de los bloques del CLAUDE.md que cada máquina carga en
 * cada sesión (CLAUDEMD-SIN-PRESUPUESTO, decidido por el dev el 2026-09-06).
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────────────
 * Cada `claude-md-blocks/<bloque>.md` se sincroniza al `~/.claude/CLAUDE.md` de todo el equipo y se
 * carga ENTERO en cada sesión. Nada medía cuánto pesaba: el bloque de estilo llegó a 17.034 bytes
 * (el 40 % del CLAUDE.md) con seis pasadas de la misma regla, cada una arrastrando su caso disparador,
 * su fecha y las citas del dev; la poda del 03-09 lo dejó en 6.270 sin perder una regla. Y el patrón
 * siguió: `ado-runs-list-lag` creció de 4.634 a 9.979 bytes en una madrugada por la misma vía.
 *
 * ── QUÉ HACE ─────────────────────────────────────────────────────────────────────────────────────
 * `claude-md-blocks/budget.json` declara el techo en BYTES de cada bloque, uno `default` para los
 * que no lo declaran, y un `total`. Este guion lo verifica y FRENA (exit 1) el commit que se pasa; el
 * pre-commit del arnés lo llama con `--staged`. Ningún bloque nace en rojo: los techos están apenas
 * por encima del tamaño real, así que ninguno puede crecer sin que alguien lo decida AHÍ, con el
 * motivo al lado. Además AVISA (sin frenar) cuando lo que el commit AGREGA tiene forma de historia
 * —«caso disparador», pasada numerada, fecha de pasada, cita del dev—: la regla queda en el bloque; el
 * caso, la fecha y la cita van a la guía o al incident-log.
 *
 * 🔴 En `--staged` TODO sale del ÍNDICE: el presupuesto, la lista de bloques y su contenido. La
 * primera versión leía el techo y la lista del DISCO y el contenido del índice, así que un techo
 * subido sin stagear dejaba entrar un bloque que en la máquina de cualquier otro estaba en rojo, y la
 * lista de bloques salía del disco (revisión adversarial 2026-09-06; el contenido siempre salió del
 * índice). Y lo que no se pudo medir NO es verde: un presupuesto ilegible, un techo
 * inválido (0, texto) o un git que no contesta salen 2.
 *
 * Las VARIANTES de Codex (`claude-md-blocks/names/<bloque>.codex.md`) reemplazan al bloque en las
 * máquinas con TYCON_CODEX=1: se miden contra el techo del bloque que reemplazan, y el total del lado
 * Codex (variante si existe, base si no) tiene que entrar en `total_codex` (o en `total` si no se declara).
 *
 * Uso: node scripts/ci/check-claude-md-blocks.js [--repo <raíz>] [--staged] [--json]
 * Red: scripts/tests/claude-md-blocks.test.sh.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Señales de «historia» en lo que el commit agrega. Sin `\b`: en JS `\b` corta ANTES de una vocal
// acentuada («preguntó», «pidió»), así que cuatro de los cinco verbos nunca matcheaban.
const L = '(?<![\\p{L}\\p{N}_])';
const R = '(?![\\p{L}\\p{N}_])';
const SENIALES = [
  [new RegExp(`${L}caso disparador${R}`, 'iu'), 'suma un «caso disparador» a la regla (el caso va al registro de incidentes; el bloque dice la regla y su porqué, sin contarlo ni enlazarlo)'],
  [new RegExp(`${L}\\d+\\s*(?:ª|a|era|da|ra|ta|ma|va)\\s+pasada${R}`, 'iu'), 'numera una pasada de la misma regla'],
  [/\(\s*agregad[oa]\s+20\d\d-\d\d-\d\d/iu, 'fecha una pasada entre paréntesis'],
  [new RegExp(`${L}el dev (?:dijo|pidió|marcó|preguntó|contestó)${R}`, 'iu'), 'pega una cita del dev'],
  [/«[^»]{60,}»/u, 'cita textual larga'],
];

const DIR = 'claude-md-blocks';
const BUDGET = `${DIR}/budget.json`;

// ── El presupuesto, por sus dos nombres (story 8.9, tanda D1) ───────────────────────────────────
// Este guion mide el disco o el ÍNDICE de otro repo (`--repo`), que puede ser otra versión del arnés:
// un clon atrasado tiene el presupuesto con su nombre y sus claves de antes. Se lee el nombre nuevo y,
// si no está, el viejo —que sale del mapa de renombres, nunca escrito acá—; las claves pasan por
// `readKeysDeep`. Los dos presentes con contenido distinto es «no pude mirar» (sale 2) y nombra los dos:
// medir contra uno cualquiera daría un verde que el otro desmiente. Sin la biblioteca o sin el mapa (la
// copia pública) no hay nombres viejos: paso directo.
const nombresViejos = (() => {
  try { return require(path.join(__dirname, '..', 'lib', 'legacy-names.js')); } catch (_) { return null; }
})();
function rutasViejasDelPresupuesto() {
  if (!nombresViejos) return [];
  return [...new Set(nombresViejos.usableEntries(nombresViejos.loadMap())
    .filter((e) => e.kind === 'file' && (e.repo || 'arnes') === 'arnes' && e.new === BUDGET && typeof e.old === 'string')
    .map((e) => e.old))].filter((x) => x !== BUDGET);
}
const clavesNuevas = (obj) => (nombresViejos ? nombresViejos.readKeysDeep(obj, BUDGET) : obj);
// igualdad por contenido, sin importar el orden de las claves (la versión vieja las trae con otro nombre y otro orden)
const ordenado = (v) => (Array.isArray(v) ? v.map(ordenado)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, ordenado(v[k])])) : v);
const mismoValor = (a, b) => JSON.stringify(ordenado(a)) === JSON.stringify(ordenado(b));
function leerPresupuesto(leer, staged) {
  const donde = staged ? 'del índice de git (¿no está commiteado ni stageado, o git no contesta?)' : 'del disco';
  const leidos = [];
  for (const rel of [BUDGET, ...rutasViejasDelPresupuesto()]) {
    const raw = leer(rel);
    if (raw === null) continue;
    let obj;
    try { obj = JSON.parse(raw); } catch (e) { return { error: `${rel} no es JSON válido (${e.message})` }; }
    try { obj = clavesNuevas(obj); } catch (e) { return { error: `${rel}: ${e.message}` }; }
    leidos.push({ rel, obj });
  }
  if (!leidos.length) return { error: `no pude leer ${BUDGET} ${donde}` };
  const distinto = leidos.find((l) => !mismoValor(l.obj, leidos[0].obj));
  if (distinto) return { error: `hay dos presupuestos con contenido distinto: ${leidos[0].rel} y ${distinto.rel} — dejá uno solo` };
  return { pres: leidos[0].obj };
}

// ── Los archivos IMPORTADOS enteros en cada sesión (story 7.4, 2026-09-17) ──────────────────────
// Los BLOQUES de arriba son 15.555 bytes. El README del arnés, que el `~/.claude/CLAUDE.md` de cada
// dev importa ENTERO —y que por eso viaja también a cada subagente y a cada repo—, pesaba 235.771 y
// no lo medía nada: medido, ~76 mil tokens, el 61 % del piso con el que arranca un revisor antes de
// leer un archivo, y ningún revisor lo lee (2 de 154 lo abrieron). La sección `imported` del
// presupuesto le pone el mismo tratamiento que a los bloques: techo en bytes con el motivo al lado.
// Medición: tasks/medicion-7.4-piso-de-contexto-2026-09-17.md.

// El ancla de un encabezado `## …`, como la resuelve un visor de markdown.
const slug = (h) => h.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');

// Las ENTRADAS de un índice: líneas `- **…`.
// 🔴 `- **` y NO `- **[`: cuatro de las 105 fichas del README nombran un COMANDO y arrancan con
// `` - **` `` en vez de un enlace. El detector angosto las pierde EN SILENCIO —101 contra 105— y un
// verificador de poda montado sobre él diría «no se perdió nada» habiendo dejado cuatro afuera.
// Lo cazó el validador de stories en el Step 1 de la 7.4; lo fija el caso C-27b.
const entradasDe = (texto) => String(texto).split('\n').filter((l) => /^- \*\*/.test(l));

// Una entrada COMPLETA, con sus líneas de continuación. En markdown una viñeta sigue en las líneas
// indentadas que le siguen, y el README tiene una ficha así (`guides/que-hace-el-arnes.md`, 12
// líneas de continuación). 🔴 `entradasDe` devuelve sólo el PRIMER renglón —que es lo que hace falta
// para medir el tope por entrada— y con eso una mudanza perdería el resto EN SILENCIO: fue el
// defecto real de la primera poda de la 7.4, y el verificador no lo vio porque comparaba el mismo
// texto truncado en los dos lados. Quien mueva texto usa ESTA función, no la de arriba.
function entradasCompletasDe(texto) {
  const lineas = String(texto).split('\n');
  const out = [];
  let cur = null;
  for (const l of lineas) {
    if (/^- \*\*/.test(l)) { if (cur) out.push(cur); cur = [l]; continue; }
    if (!cur) continue;
    if (!l.trim() || /^\S/.test(l)) { out.push(cur); cur = null; continue; }   // línea vacía o sin indentar: la entrada terminó
    cur.push(l);
  }
  if (cur) out.push(cur);
  return out.map((ls) => ls.join('\n'));
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, '-c', 'color.ui=never', '-c', 'color.diff=never', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function validarPresupuesto(pres) {
  const entero = (v) => Number.isInteger(v) && v >= 1;
  if (!pres || typeof pres !== 'object') return 'budget.json no es un objeto';
  if (!entero(pres.default)) return '`default` tiene que ser un entero ≥ 1 (bytes)';
  if (pres.total !== undefined && !entero(pres.total)) return '`total` tiene que ser un entero ≥ 1 (bytes)';
  if (pres.total_codex !== undefined && !entero(pres.total_codex)) return '`total_codex` tiene que ser un entero ≥ 1 (bytes)';
  const techos = pres.blocks === undefined ? {} : pres.blocks;
  if (!techos || typeof techos !== 'object' || Array.isArray(techos)) return '`blocks` tiene que ser un objeto {bloque: techo}';
  for (const [k, v] of Object.entries(techos)) if (!entero(v)) return `el techo de «${k}» tiene que ser un entero ≥ 1 (bytes), no ${JSON.stringify(v)}`;
  const imp = pres.imported === undefined ? {} : pres.imported;
  if (!imp || typeof imp !== 'object' || Array.isArray(imp)) return '`imported` tiene que ser un objeto {archivo: {ceiling, max_input?, detail?}}';
  for (const [k, v] of Object.entries(imp)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return `«${k}» de \`imported\` tiene que ser un objeto {ceiling, max_input?, detail?}`;
    if (!entero(v.ceiling)) return `el techo de «${k}» tiene que ser un entero ≥ 1 (bytes), no ${JSON.stringify(v.ceiling)}`;
    if (v.max_input !== undefined && !entero(v.max_input)) return `\`max_input\` de «${k}» tiene que ser un entero ≥ 1 (bytes), no ${JSON.stringify(v.max_input)}`;
    if (v.detail !== undefined && (typeof v.detail !== 'string' || !v.detail.trim())) return `\`detail\` de «${k}» tiene que ser una ruta`;
    if (v.linked_sections !== undefined && typeof v.linked_sections !== 'boolean') return `\`linked_sections\` de «${k}» tiene que ser true o false, no ${JSON.stringify(v.linked_sections)}`;
  }
  return null;
}

// Mide un archivo importado: su peso, sus entradas largas, y —si declara `detail`— que cada enlace
// al detalle tenga su sección y cada sección su enlace. `leer` es el del `medir` que lo llama (en
// `--staged` sale del índice, como todo lo demás). Las claves de la configuración pasaron a inglés
// (story 8.9, tanda D1); las de la salida `--json` conservan sus nombres de antes, a propósito.
function medirImportado({ archivo, conf, leer }) {
  const contenido = leer(archivo);
  if (contenido === null) return { archivo, error: `no pude leer «${archivo}»` };
  const bytes = Buffer.byteLength(contenido, 'utf8');
  const entradas = entradasDe(contenido);
  const emax = conf.max_input;
  const largas = emax === undefined ? [] : entradas
    .map((l) => ({ bytes: Buffer.byteLength(l, 'utf8'), principio: l.slice(0, 60) }))
    .filter((e) => e.bytes > emax);
  let enlacesRotos = [], seccionesSinEntrada = [];
  if (conf.detail) {
    const det = leer(conf.detail);
    if (det === null) return { archivo, error: `no pude leer el detalle «${conf.detail}» que «${archivo}» declara` };
    const secciones = det.split('\n').filter((l) => /^## +\S/.test(l)).map((l) => l.replace(/^## +/, ''));
    const anclas = new Set(secciones.map(slug));
    const ruta = conf.detail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const enlazadas = new Set();
    for (const m of contenido.matchAll(new RegExp(`\\]\\((?:\\./)?(?:[\\w./-]*/)?${ruta.split('/').pop()}#([^)\\s]+)\\)`, 'g'))) enlazadas.add(m[1]);
    enlacesRotos = [...enlazadas].filter((a) => !anclas.has(a));
    // `linked_sections: false` (story 7.7): el importado ya no es índice —las piezas se buscan en
    // el detalle— y no se le exige un enlace por sección. Los enlaces que SÍ tiene siguen tener que
    // resolver: eso es lo que evita que la guía y el importado se separen.
    if (conf.linked_sections !== false) seccionesSinEntrada = secciones.filter((s) => !enlazadas.has(slug(s)));
  }
  return {
    archivo, bytes, techo: conf.ceiling, entradas: entradas.length,
    ok: bytes <= conf.ceiling && largas.length === 0 && enlacesRotos.length === 0 && seccionesSinEntrada.length === 0,
    dentroDelTecho: bytes <= conf.ceiling, entradas_largas: largas, enlaces_rotos: enlacesRotos, secciones_sin_entrada: seccionesSinEntrada,
  };
}

function medir({ repo, staged }) {
  const leer = (rel) => {
    if (staged) { try { return git(repo, ['show', `:${rel}`]); } catch { return null; } }
    try { return fs.readFileSync(path.join(repo, rel), 'utf8'); } catch { return null; }
  };
  // ── presupuesto: del índice en --staged ──
  const leido = leerPresupuesto(leer, staged);
  if (leido.error) return { error: leido.error };
  const pres = leido.pres;
  const invalido = validarPresupuesto(pres);
  if (invalido) return { error: invalido };
  const def = pres.default;
  const total = pres.total || 0;
  const totalCodex = pres.total_codex || total;   // el lado Codex carga las variantes, que pesan distinto
  const techos = pres.blocks || {};
  // ── la lista de bloques: del índice en --staged ──
  let rutas;
  if (staged) {
    try {
      rutas = git(repo, ['ls-files', '--cached', '-z', '--', `:(glob)${DIR}/*.md`, `:(glob)${DIR}/names/*.md`]).split('\0').filter(Boolean);
    } catch { return { error: 'no pude leer el índice de git (¿estás en un repo? ¿git está en el PATH?)' }; }
  } else {
    rutas = [];
    try { rutas.push(...fs.readdirSync(path.join(repo, DIR)).filter((f) => f.endsWith('.md')).map((f) => `${DIR}/${f}`)); } catch { /* sin dir */ }
    try { rutas.push(...fs.readdirSync(path.join(repo, DIR, 'names')).filter((f) => f.endsWith('.md')).map((f) => `${DIR}/names/${f}`)); } catch { /* sin variantes */ }
  }
  const filas = []; let sumaClaude = 0; const codex = new Map();   // bloque → bytes del lado Codex
  for (const rel of rutas.sort()) {
    const c = leer(rel);
    if (c === null) continue;
    const bytes = Buffer.byteLength(c, 'utf8');
    if (rel.startsWith(`${DIR}/names/`) && !rel.endsWith('.codex.md')) continue;   // sólo *.codex.md es una variante; otro .md ahí no reemplaza a nadie
    const esVariante = rel.startsWith(`${DIR}/names/`);
    const base = esVariante ? path.basename(rel).replace(/\.codex\.md$/, '').replace(/\.md$/, '') : path.basename(rel, '.md');
    // la variante puede declarar su propio techo («<bloque>.codex»); si no, hereda el del bloque
    const clave = esVariante && Object.prototype.hasOwnProperty.call(techos, `${base}.codex`) ? `${base}.codex` : base;
    const declarado = Object.prototype.hasOwnProperty.call(techos, clave);
    const techo = declarado ? techos[clave] : def;
    filas.push({ bloque: esVariante ? `${base} (variante Codex: ${rel})` : base, ruta: rel, bytes, techo, declarado, ok: bytes <= techo });
    if (esVariante) codex.set(base, bytes);
    else { sumaClaude += bytes; if (!codex.has(base)) codex.set(base, bytes); }
  }
  // el lado Codex: la variante reemplaza a la base
  let sumaCodex = 0;
  for (const rel of rutas) {
    if (!rel.startsWith(`${DIR}/names/`) || !rel.endsWith('.codex.md')) continue;
    const base = path.basename(rel).replace(/\.codex\.md$/, '').replace(/\.md$/, '');
    if (codex.has(base)) codex.set(base, Buffer.byteLength(leer(rel) || '', 'utf8'));
  }
  for (const v of codex.values()) sumaCodex += v;
  // ── los archivos importados enteros en cada sesión (7.4) ──
  const importados = [];
  for (const [archivo, conf] of Object.entries(pres.imported || {})) {
    const m = medirImportado({ archivo, conf, leer });
    if (m.error) return { error: m.error };   // no medido no es verde
    importados.push(m);
  }
  const avisos = [];
  if (staged) {
    let diff = '';
    const objetivos = [`:(glob)${DIR}/*.md`, `:(glob)${DIR}/names/*.md`, ...Object.keys(pres.imported || {})];
    try { diff = git(repo, ['diff', '--cached', '-U0', '--', ...objetivos]); } catch { /* nada */ }
    let bloque = '';
    for (const l of diff.split('\n')) {
      if (l.startsWith('+++ ')) { bloque = l.slice(4).replace(/^b\//, ''); continue; }
      if (l.startsWith('--- ') || !l.startsWith('+')) continue;
      const t = l.slice(1);
      for (const [re, que] of SENIALES) {
        if (re.test(t)) { avisos.push({ bloque, que, linea: t.trim().slice(0, 100) }); break; }
      }
    }
  }
  return { filas, importados, suma: sumaClaude, sumaCodex, total, totalCodex, totalOk: !total || sumaClaude <= total, totalCodexOk: !totalCodex || sumaCodex <= totalCodex, avisos, def };
}

function main(argv) {
  const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const repo = path.resolve(arg('--repo', path.join(__dirname, '..', '..')));
  const staged = argv.includes('--staged');
  const r = medir({ repo, staged });
  const fmt = (n) => n.toLocaleString('es-AR');
  const malImportado = (r.importados || []).some((i) => !i.ok);
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return r.error ? 2 : (r.filas.some((f) => !f.ok) || !r.totalOk || !r.totalCodexOk || malImportado ? 1 : 0); }
  if (r.error) { console.error(`⚠ claude-md-blocks: ${r.error} — NO se midió nada, y no medido no es verde.`); return 2; }
  const rojos = r.filas.filter((f) => !f.ok);
  for (const f of r.filas) {
    console.log(`${f.ok ? '✅' : '❌'} ${f.bloque}: ${fmt(f.bytes)} / ${fmt(f.techo)} bytes${f.declarado ? '' : ' (techo por default)'}`);
  }
  if (r.total) {
    console.log(`${r.totalOk ? '✅' : '❌'} total (lado Claude): ${fmt(r.suma)} / ${fmt(r.total)} bytes`);
    if (r.sumaCodex !== r.suma) console.log(`${r.totalCodexOk ? '✅' : '❌'} total (lado Codex, con sus variantes): ${fmt(r.sumaCodex)} / ${fmt(r.totalCodex)} bytes`);
  }
  for (const i of r.importados || []) {
    console.log(`${i.ok ? '✅' : '❌'} ${i.archivo} (importado en cada sesión): ${fmt(i.bytes)} / ${fmt(i.techo)} bytes · ${fmt(i.entradas)} entradas`);
    for (const e of i.entradas_largas) console.log(`   ❌ entrada de ${fmt(e.bytes)} bytes: «${e.principio}…»`);
    for (const a of i.enlaces_rotos) console.log(`   ❌ enlace al detalle sin sección: #${a}`);
    for (const sec of i.secciones_sin_entrada) console.log(`   ❌ sección del detalle que el índice no enlaza: «${sec}»`);
  }
  for (const a of r.avisos) {
    console.error(`⚠  ${a.bloque}: lo que este commit agrega ${a.que}:`);
    console.error(`     «${a.linea}»`);
  }
  if (r.avisos.length) console.error('   La regla queda en el bloque; el caso, la fecha y la cita van a la guía o al incident-log (guides/response-style.md cuenta cómo se poda un bloque sin perder una regla).');
  const problemas = [];
  if (rojos.length) problemas.push(`${rojos.map((f) => f.bloque).join(', ')} se pasa de su techo`);
  if (!r.totalOk) problemas.push(`la suma de los bloques (lado Claude, ${fmt(r.suma)}) se pasa del total de ${fmt(r.total)}`);
  if (!r.totalCodexOk) problemas.push(`la suma del lado Codex (${fmt(r.sumaCodex)}) se pasa del total de ${fmt(r.totalCodex)}`);
  for (const i of (r.importados || []).filter((x) => !x.ok)) {
    const cuales = [];
    if (!i.dentroDelTecho) cuales.push(`pesa ${fmt(i.bytes)} contra un techo de ${fmt(i.techo)}`);
    if (i.entradas_largas.length) cuales.push(`${i.entradas_largas.length} entrada(s) se pasan del tope por entrada`);
    if (i.enlaces_rotos.length) cuales.push(`${i.enlaces_rotos.length} enlace(s) al detalle sin sección`);
    if (i.secciones_sin_entrada.length) cuales.push(`${i.secciones_sin_entrada.length} sección(es) del detalle que el índice no enlaza`);
    problemas.push(`${i.archivo} (se importa entero en cada sesión) ${cuales.join(' y ')}`);
  }
  if (problemas.length) {
    console.error(`\n❌ ${problemas.join('; ')}. Subir un techo es una decisión: se declara en ${BUDGET} con el motivo al lado (y viaja en el MISMO commit). Podar es la otra salida: la historia va a la guía.`);
    return 1;
  }
  return 0;
}

module.exports = { medir, SENIALES, validarPresupuesto, slug, entradasDe, entradasCompletasDe, medirImportado };
if (require.main === module) process.exit(main(process.argv.slice(2)));
