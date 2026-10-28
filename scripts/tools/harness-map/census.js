#!/usr/bin/env node
/**
 * census.js — ¿toda pieza del arnés tiene lugar en el mapa?
 *
 * El mapa (`artifacts/mapa-arnes.html`) se escribió a mano, y una lista escrita a mano sólo ve lo que
 * alguien se acordó de anotar. Sin el censo, de 189 archivos del arnés las fichas citarían
 * 82 — faltarían frenos activos, avisos, todo el CI de los productos. Nadie lo nota a simple vista porque el
 * diagrama se ve completo.
 *
 * Esto recorre las carpetas donde viven las piezas y exige que cada una esté citada en el «Repo y
 * archivo» de alguna ficha, o declarada en `fuera-del-mapa.json` con su motivo. Un diagrama de bloques
 * no dibuja cada archivo, pero cada archivo tiene que pertenecer a alguna caja.
 *
 * Qué cuenta como pieza (carpetas de primer nivel, sin recorrer subcarpetas):
 *   arnés:  scripts/hooks · scripts/ci · scripts/ · scripts/{setup,instincts,metrics,controls-bench,lib} ·
 *           scripts/nightly/* (el nocturno de dependencias incluido) · scripts/tools y scripts/tools/* (el mapa mismo, en
 *           scripts/tools/harness-map/) · build/ · commands/ · azure-pipelines*.yml · pipelines/ y pipelines/templates/
 *           (si existen) · inbox/ e inbox/* (sólo datos: un ejecutable ahí no tiene lugar)
 *   skills: skills/tycon-pipeline/scripts/ · las carpetas de las skills propias
 *   integraciones: cada carpeta de integrations/ (sus guiones los declara su manifiesto)
 * Qué cuenta como citada: la ruta exacta en «Repo y archivo» (sin la aclaración entre paréntesis).
 * Una carpeta citada con comodín (las skills `tycon-*`) cubre carpetas, nunca los archivos de adentro.
 *
 * Uso:   node scripts/tools/harness-map/census.js [--map <html>] [--outside <json>] [--tcg <dir>] [--skills <dir>]
 *        node scripts/tools/harness-map/census.js --types [--json | --write] | --check   [--map <html>]   (ver abajo)
 * Salida del censo: 0 todo ubicado · 1 hay piezas sin lugar o exclusiones que sobran · 2 no se pudo medir
 * (sin skills, mapa ilegible, exclusión sin motivo). «No medido» nunca sale 0.
 *
 * El tipo de cada pieza. Cada ficha lleva un `tipo` que no se tipea:
 * sale de la ruta de su PRIMER archivo en `archivos` (sin la aclaración entre paréntesis y sin mirar el
 * repo). Si una ficha cita archivos de dos tipos —un hook y su biblioteca—, manda el primero de la lista:
 * el orden de `archivos` ya dice cuál es la pieza y cuál su apoyo. Reglas, en orden (gana la primera):
 *   agents/*.md y packs/**                                   → revisor
 *   scripts/hooks/**, skills/tycon-pipeline/scripts/{on-,hook-}*
 *                                                            → control de sesión
 *   skills/<x>/**                                            → skill
 *   guides/**                                                → guía
 *   claude-md-blocks/**                                      → bloque
 *   commands/**                                              → comando
 *   pipelines/**, azure-pipelines*.yml                       → pipeline (los yml viven en pipelines/; la forma de la raíz
 *                                                              queda por si un yml vuelve a nacer ahí)
 *   scripts/**, build/**, adapters/**                        → script
 *   specs/**                                                 → especificación
 *   engram-version, ~/.claude/settings.json                  → configuración
 *   una ficha sin `archivos` (el dev, el modelo, las herramientas) → externo
 * Una ruta que no encaja en ninguna NO recibe un tipo por defecto: queda sin tipo y `--check` la nombra,
 * para que una pieza con una ruta nueva obligue a decidir su tipo (y a sumar la regla acá).
 *
 *   --types [--json]     imprime el tipo de cada ficha (el derivado y el que tiene el mapa).
 *   --check              0 si toda ficha tiene el tipo que le da su ruta · 1 si alguna no lo tiene, tiene
 *                        otro, o su ruta no tiene regla (las nombra) · 2 mapa ilegible. No necesita las
 *                        skills: sólo lee el mapa. Lo corre el pre-commit cuando el commit toca el mapa.
 *   --types --write      escribe o corrige `tipo` en `const D` del mapa sin tocar nada más (re-serializa
 *                        el bloque con el mismo formato que `public-version.js`, que da los mismos bytes).
 *                        Con una ruta sin regla no escribe nada y sale 1.
 * Casos: scripts/tests/harness-map-census.test.sh (C-08 a C-12 son los del tipo)
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// vive en scripts/tools/harness-map/: la raíz del arnés está tres carpetas arriba
require('../../lib/legacy-names.js').aliasArgv('scripts/tools/harness-map/census.js', { exitCode: 2 });
const args = process.argv.slice(2);
const opcion = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const TCG = path.resolve(opcion('--tcg', path.join(__dirname, '..', '..', '..')));
const SKILLS = path.resolve(opcion('--skills', path.join(os.homedir(), '.claude', 'agent-skills', 'skills')));
const MAPA = opcion('--map', path.join(TCG, 'artifacts', 'mapa-arnes.html'));
const FUERA = opcion('--outside', path.join(TCG, 'scripts', 'tools', 'harness-map', 'fuera-del-mapa.json'));

const MODO_TIPOS = args.includes('--types') || args.includes('--check');

function noMedido(motivo) {
  console.error(`⛔ ${MODO_TIPOS ? 'tipos' : 'censo'} del mapa — NO MEDIDO: ${motivo}`);
  process.exit(2);
}

function fichas() {
  let html;
  try { html = fs.readFileSync(MAPA, 'utf8'); } catch (e) { return noMedido(`no pude leer el mapa (${MAPA}): ${e.message}`); }
  const M = 'const D = ', i = html.indexOf(M), f = i < 0 ? -1 : html.indexOf('\n};\n', i);
  if (i < 0 || f < 0) return noMedido('no encontré las fichas (const D = {…};) en el mapa');
  let D;
  try { D = JSON.parse(html.slice(i + M.length, f + 2)); } catch (e) { return noMedido(`las fichas del mapa no se pueden leer: ${e.message}`); }
  return { html, D, ini: i + M.length, fin: f + 2 };
}

const sinAclaracion = (ruta) => String(ruta).replace(/\s+\(.*\)$/, '');

const REGLAS = [
  [/^agents\/[^/]+\.md$/, 'revisor'],
  [/^packs\//, 'revisor'],
  [/^scripts\/hooks\//, 'control de sesión'],
  [/^skills\/tycon-pipeline\/scripts\/(on-|hook-)[^/]*$/, 'control de sesión'],
  // una integración se instala como una skill: sólo si la organización la elige
  [/^integrations\/[^/]+\//, 'skill'],
  [/^skills\/[^/]+\//, 'skill'],
  [/^guides\//, 'guía'],
  [/^claude-md-blocks\//, 'bloque'],
  [/^commands\//, 'comando'],
  [/^azure-pipelines[^/]*\.yml$/, 'pipeline'],
  [/^(ci-templates|pipelines)\//, 'pipeline'],
  [/^(scripts|build|adapters)\//, 'script'],
  [/^specs\//, 'especificación'],
  [/^(engram-version|~\/\.claude\/settings\.json)$/, 'configuración'],
];

// El tipo de una ficha: el de la ruta de su primer archivo (null = ruta sin regla).
function tipoDe(ficha) {
  const primero = (ficha.archivos || [])[0];
  if (!primero) return { tipo: 'externo', ruta: null };
  const ruta = sinAclaracion(primero[1]);
  const regla = REGLAS.find(([re]) => re.test(ruta));
  return { tipo: regla ? regla[1] : null, ruta };
}

function tipos() {
  const mapa = fichas();
  const filas = Object.entries(mapa.D).map(([id, ficha]) => ({ ficha: id, ...tipoDe(ficha), actual: ficha.tipo ?? null }));
  const sinRegla = filas.filter((f) => f.tipo === null);
  const distintas = filas.filter((f) => f.tipo !== null && f.actual !== f.tipo);

  if (args.includes('--check')) {
    if (!sinRegla.length && !distintas.length) {
      console.log(`✅ tipos del mapa — ${filas.length} piezas con el tipo que les da su ruta.`);
      process.exit(0);
    }
    console.error(`⛔ tipos del mapa — ${sinRegla.length + distintas.length} de ${filas.length} piezas sin el tipo de su ruta:`);
    for (const f of distintas) console.error(`   · ${f.ficha}: ${f.actual === null ? 'no tiene tipo' : `tiene «${f.actual}»`}, le corresponde «${f.tipo}» (${f.ruta ?? 'sin archivos'})`);
    for (const f of sinRegla) console.error(`   · ${f.ficha}: la ruta ${f.ruta} no tiene regla de tipo — sumala en scripts/tools/harness-map/census.js`);
    console.error('   Se corrige con: node scripts/tools/harness-map/census.js --types --write');
    process.exit(1);
  }

  if (args.includes('--write')) {
    if (sinRegla.length) {
      console.error(`⛔ tipos del mapa — no escribí nada: ${sinRegla.length} ruta(s) sin regla de tipo:`);
      for (const f of sinRegla) console.error(`   · ${f.ficha}: ${f.ruta}`);
      process.exit(1);
    }
    const D = {};
    for (const [id, ficha] of Object.entries(mapa.D)) {
      const { tipo } = tipoDe(ficha);
      if ('tipo' in ficha) { D[id] = { ...ficha, tipo }; continue; }
      // Un campo nuevo va después de `nombre` (o al principio si la ficha no tiene nombre).
      const nueva = 'nombre' in ficha ? {} : { tipo };
      for (const [k, v] of Object.entries(ficha)) { nueva[k] = v; if (k === 'nombre') nueva.tipo = tipo; }
      D[id] = nueva;
    }
    const bloque = '{\n' + Object.entries(D).map(([k, v]) => '  ' + JSON.stringify(k) + ': ' + JSON.stringify(v)).join(',\n') + '\n}';
    fs.writeFileSync(MAPA, mapa.html.slice(0, mapa.ini) + bloque + mapa.html.slice(mapa.fin));
    console.log(`✅ tipos del mapa — ${distintas.length} de ${filas.length} piezas actualizadas en ${MAPA}.`);
    process.exit(0);
  }

  if (args.includes('--json')) {
    console.log(JSON.stringify(filas, null, 2));
    process.exit(0);
  }
  const ancho = Math.max(...filas.map((f) => f.ficha.length), 5);
  for (const f of filas) {
    const marca = f.tipo === null ? '  ⛔ sin regla' : f.actual !== f.tipo ? `  ⚠ el mapa dice ${f.actual === null ? 'nada' : `«${f.actual}»`}` : '';
    console.log(`${f.ficha.padEnd(ancho)}  ${(f.tipo ?? '—').padEnd(17)}  ${f.ruta ?? '(sin archivos)'}${marca}`);
  }
  process.exit(0);
}

if (MODO_TIPOS) tipos();

function citas() {
  const { D } = fichas();
  const rutas = new Set();
  for (const ficha of Object.values(D)) {
    for (const [, ruta] of ficha.archivos || []) rutas.add(sinAclaracion(ruta));
  }
  return rutas;
}

function listar(dir, filtro) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(filtro).map((d) => d.name).sort(); } catch (_) { return null; }
}

function piezas() {
  const out = [];
  // un reemplazo generado (la ruta vieja de un archivo renombrado, idéntico a lo que escribe --write-shims) no
  // es una pieza: la pieza es el archivo nuevo, que tiene su ficha. Un archivo que no se deja leer no se da por reemplazo:
  // sólo «no existe» es un no; lo demás, NO MEDIDO
  const { isGeneratedShim } = require('../../lib/legacy-names.js');
  // `rel` es la ruta dentro de su repo (con la que se generó el reemplazo); `abs`, dónde leerlo si no es base + rel
  const reemplazo = (base, rel, abs = path.join(base, rel)) => {
    let texto;
    try { texto = fs.readFileSync(abs, 'utf8'); } catch (e) {
      if (e && e.code === 'ENOENT') return false;
      noMedido(`no pude leer ${rel} (${(e && e.code) || (e && e.message) || e}) para saber si es un reemplazo`);
    }
    return isGeneratedShim(rel, texto);
  };
  const archivos = (base, rel, re) => {
    const nombres = listar(path.join(base, rel), (d) => d.isFile() && re.test(d.name));
    if (nombres) for (const n of nombres) if (!reemplazo(base, rel ? `${rel}/${n}` : n)) out.push(rel ? `${rel}/${n}` : n);
  };
  const codigo = /\.(js|sh|py|ps1)$/;
  if (!fs.existsSync(path.join(TCG, 'scripts'))) noMedido(`no encontré el arnés en ${TCG}`);
  archivos(TCG, 'scripts/hooks', codigo);
  archivos(TCG, 'scripts/ci', codigo);
  archivos(TCG, 'scripts', codigo);
  // instalar y mantener cada máquina al día: lo que vive acá se censa —
  // si no, una pieza movida desaparecería del censo en silencio; en la ruta vieja quedan sólo reemplazos
  archivos(TCG, 'scripts/setup', codigo);
  // los guiones de instincts viven en scripts/instincts/ y se censan ahí
  archivos(TCG, 'scripts/instincts', codigo);
  // el buzón de decisiones (inbox/instincts/, inbox/watcher/ e inbox/dependencies/) guarda sólo datos:
  // un ejecutable que caiga en cualquiera de sus carpetas es una pieza sin lugar, y el censo la nombra
  archivos(TCG, 'inbox', codigo);
  for (const d of listar(path.join(TCG, 'inbox'), (x) => x.isDirectory()) || []) archivos(TCG, `inbox/${d}`, codigo);
  // el vigilante y el mapa del arnés no van en esta lista: viven en
  // scripts/nightly/watcher/ y scripts/tools/harness-map/, que recorren los bucles de abajo. Tampoco la carpeta vieja del
  // nocturno de dependencias: sus guiones y sus dos .json viven en scripts/nightly/dependencies/ y en
  // la vieja quedan sólo reemplazos, que no son piezas
  for (const d of ['metrics', 'controls-bench', 'lib']) archivos(TCG, `scripts/${d}`, codigo);
  // la etapa nocturna de la estructura destino: cada subcarpeta de scripts/nightly/, también las que llegan
  // de a un archivo antes que el resto de su carpeta (el nocturno de dependencias). El tablero vive en
  // scripts/nightly/dashboard/; en su carpeta vieja quedan sólo reemplazos, que no son piezas
  for (const d of listar(path.join(TCG, 'scripts', 'nightly'), (x) => x.isDirectory()) || []) archivos(TCG, `scripts/nightly/${d}`, codigo);
  // las herramientas a mano de la estructura destino: scripts/tools/ y cada subcarpeta (la
  // captura y el mapa del arnés en scripts/tools/harness-map/)
  archivos(TCG, 'scripts/tools', codigo);
  for (const d of listar(path.join(TCG, 'scripts', 'tools'), (x) => x.isDirectory()) || []) archivos(TCG, `scripts/tools/${d}`, codigo);
  archivos(TCG, 'build', codigo);
  archivos(TCG, 'commands', /\.md$/);
  archivos(TCG, '', /^azure-pipelines.*\.yml$/);
  // las definiciones de Azure DevOps en su carpeta: si la carpeta no existe, listar() no da nada
  archivos(TCG, 'pipelines', /\.ya?ml$/);
  archivos(TCG, 'pipelines/templates', /\.ya?ml$/);

  const pipeline = path.join(SKILLS, 'tycon-pipeline', 'scripts');
  if (!fs.existsSync(pipeline)) noMedido(`no encontré las skills en ${SKILLS} (se pasan con --skills)`);
  // un reemplazo generado de agent-skills tampoco es pieza (el de la equivalencia de paquetes)
  for (const n of listar(pipeline, (d) => d.isFile() && /\.(js|sh)$/.test(d.name)) || []) {
    const rel = `skills/tycon-pipeline/scripts/${n}`;
    if (!reemplazo(null, rel, path.join(pipeline, n))) out.push(rel);
  }
  for (const n of listar(SKILLS, (d) => d.isDirectory() && /^(tycon-|check-story-drift$)/.test(d.name)) || []) out.push(`skills/${n}/`);
  // cada integración es una pieza: su carpeta, porque lo que trae lo declara su manifiesto
  for (const n of listar(path.join(TCG, 'integrations'), (d) => d.isDirectory()) || []) out.push(`integrations/${n}/`);
  return out;
}

function exclusiones() {
  let data;
  try { data = JSON.parse(fs.readFileSync(FUERA, 'utf8')); } catch (e) { noMedido(`no pude leer ${FUERA}: ${e.message}`); }
  if (!Array.isArray(data.fuera)) noMedido(`${FUERA} no tiene la lista "fuera"`);
  const lista = data.fuera;
  const mapa = new Map();
  for (const x of lista) {
    if (!x || !x.ruta || !String(x.motivo || '').trim()) noMedido(`una exclusión no tiene ruta o motivo: ${JSON.stringify(x)} — excluir sin motivo es esconder`);
    mapa.set(x.ruta, x.motivo);
  }
  return mapa;
}

const comodines = (rutas) => [...rutas].filter((r) => r.includes('*') && r.endsWith('/'))
  .map((r) => new RegExp('^' + r.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$'));

const rutas = citas();
const fuera = exclusiones();
const globs = comodines(rutas);
const todas = piezas();
const citada = (p) => rutas.has(p) || (p.endsWith('/') && globs.some((g) => g.test(p)));

const sinLugar = todas.filter((p) => !citada(p) && !fuera.has(p));
const sobran = [];
for (const [ruta] of fuera) {
  if (!todas.includes(ruta)) sobran.push(`${ruta} — ya no existe: sacala de fuera-del-mapa.json`);
  else if (citada(ruta)) sobran.push(`${ruta} — ya está en el mapa: sacala de fuera-del-mapa.json`);
}

const ubicadas = todas.length - sinLugar.length - [...fuera.keys()].filter((r) => todas.includes(r) && !citada(r)).length;
if (!sinLugar.length && !sobran.length) {
  console.log(`✅ censo del mapa — ${todas.length} piezas: ${ubicadas} en alguna ficha, ${fuera.size} fuera con motivo.`);
  process.exit(0);
}
console.error(`⛔ censo del mapa — ${todas.length} piezas, ${sinLugar.length} sin lugar en el mapa:`);
for (const p of sinLugar) console.error(`   · ${p}`);
for (const s of sobran) console.error(`   · exclusión que sobra: ${s}`);
console.error('   Cada pieza va en el «Repo y archivo» de alguna ficha de artifacts/mapa-arnes.html,');
console.error('   o en scripts/tools/harness-map/fuera-del-mapa.json con el motivo.');
process.exit(1);
