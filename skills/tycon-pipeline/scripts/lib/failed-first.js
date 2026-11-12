#!/usr/bin/env node
'use strict';
/**
 * failed-first.js — la lista de suites que fallaron en la última corrida completa de la puerta.
 *
 * La lista vive en el marcador (`testsFailed: [{ruta, raiz, repo, at}]`, al lado de `checks`) y guarda la entrada de
 * `scripts/tests/suites.json`: su `ruta` es la que recibe `test-gate.sh <repo> <story> --suite <ruta>`. `repo` es el
 * repo de la corrida, canónico: el marcador es de la sesión y una sesión puede correr la puerta en varios repos. Acá están las
 * funciones puras que la leen y la arman; las escrituras al marcador las hace `marker.js tests-failed`.
 *
 * Uso:  node failed-first.js has <suites.json> <ruta>   → sale 0 si la ruta es una entrada de la lista, 1 si no, 2 si
 *       la lista no se deja leer (y lo dice).
 *       node failed-first.js decide --dir --hash --repo --tree --base --trim → imprime la decisión (abajo, «Repetir
 *       solas cierra»); merge --dir --out [--new] [--changed] [--coverage] → arma el resumen juntado, sale 0 verde o 1
 *       rojo (una falla, una ausente o algo sin medir, como en una completa).
 *
 * Casos: skills/tycon-pipeline/scripts/tests/test-gate-failed-first.test.js
 */
const fs = require('fs');

/** Las entradas de `diarias` y `semanales`; lanza si el archivo no se deja leer. */
function entries(suitesJson) {
  const d = JSON.parse(fs.readFileSync(suitesJson, 'utf8'));
  return [...(d.diarias || []), ...(d.semanales || [])];
}

function find(suitesJson, ruta) {
  return entries(suitesJson).find((s) => s.ruta === ruta) || null;
}

/**
 * Las suites que fallaron según el resumen de run-suites-json.js, de la corrida en `repo`. Sin resumen legible, ninguna.
 * `fullTs` es la hora de esa completa, la misma `ts` de su constancia: la repetición reescribe la constancia sólo si es ésa.
 */
function fromSummary(resumen, repo, at = new Date().toISOString(), fullTs = null) {
  const fallas = (resumen && Array.isArray(resumen.fallas)) ? resumen.fallas : [];
  const vistas = new Set();
  const out = [];
  for (const f of fallas) {
    const e = f && f.entrada;
    if (!e || typeof e.ruta !== 'string' || vistas.has(e.ruta)) continue;
    vistas.add(e.ruta);
    out.push({ ruta: e.ruta, raiz: e.raiz || null, repo, at, ...(fullTs ? { full_ts: fullTs } : {}) });
  }
  return out;
}

/** Separa las rutas que siguen en suites.json de las que ya no están. */
function prune(lista, suitesJson) {
  const rutas = new Set(entries(suitesJson).map((s) => s.ruta));
  const keep = [];
  const gone = [];
  for (const x of lista || []) (rutas.has(x.ruta) ? keep : gone).push(x);
  return { keep, gone };
}

// ── Repetir solas cierra ────────────────────────────────────────────────────────────────────────────────────────────
// Una completa roja en un repo que acota el portón guarda, en la carpeta de estado del marcador (la escribe marker.js
// tests-failed save-red, sólo desde la puerta), su resumen, su cobertura, la foto de la carpeta que midió (after-main.js)
// y su base y su recorte. Cada repetición verde con `--suite` suma su resultado con la foto de su carpeta. Cuando la lista
// queda vacía, la próxima completa pregunta a `decide`:
//   · `same`    — la carpeta es la de la completa y la de cada repetición: no corre nada, `merge` arma el resumen;
//   · `changed` — la carpeta cambió entre la completa y las repeticiones: corren las suites que leen esos archivos, y
//                 `merge` las junta con lo guardado;
//   · `full`    — no se puede comparar; cambió la base, el recorte o la lista de suites; la carpeta cambió después de
//                 alguna repetición (un arreglo deshecho, o un cambio más); o lo cambiado vuelve a hacer correr una suite
//                 que la completa difirió por sus carpetas o por el grupo del instalador: la completa como siempre.
// La cobertura juntada es la de la completa (sin los archivos cambiados después, que se midieron sobre el código viejo)
// más la de cada repetición y la de lo que corrió por lo cambiado.
const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');

const RED_FILES = ['resumen.json', 'medido.json', 'meta.json', 'repetidas.json', 'lcov.info', 'lcov-repetidas.info'];
const SUITE_LISTS = ['scripts/tests/suites.json', 'scripts/ci/heavy-suites.json'];

/** El hash de lo guardado: los archivos que hay, con su nombre. Lo anota el marcador; lo tocado a mano no coincide. */
function redHash(dir) {
  const h = crypto.createHash('sha256');
  for (const f of RED_FILES) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) h.update(`${f}\0`).update(fs.readFileSync(p)).update('\0');
  }
  return h.digest('hex');
}

/**
 * Guarda lo que midió una completa. `origen`: «roja» (para cerrar repitiendo solas sus rojas) o «verde» (para correr
 * después sólo lo cambiado). `forgivenFile`: el resumen
 * después del juez de heredados, si lo hubo; `summaryFile` es el de antes, con esas suites rojas: las que el juez perdonó
 * quedan anotadas en `heredadas` y se vuelven a juzgar al cerrar con lo guardado (con la foto del nocturno de ese día).
 */
function saveRed({ dir, summaryFile, lcovFile, measuredFile, base, recorte, storyId = null, origen = 'roja', forgivenFile = null, at = new Date().toISOString() }) {
  let heredadas = [];
  if (forgivenFile) {
    const despues = new Set((leerJson(forgivenFile).fallas || []).map(rutaDeFalla).filter(Boolean));
    heredadas = (leerJson(summaryFile).fallas || []).map(rutaDeFalla).filter((r) => r && !despues.has(r));
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(summaryFile, path.join(dir, 'resumen.json'));
  fs.copyFileSync(measuredFile, path.join(dir, 'medido.json'));
  if (lcovFile && fs.existsSync(lcovFile)) fs.copyFileSync(lcovFile, path.join(dir, 'lcov.info'));
  fs.writeFileSync(path.join(dir, 'meta.json'), `${JSON.stringify({ base: base || null, recorte: recorte || '', at, origen, storyId: storyId || null, heredadas })}\n`);
  fs.writeFileSync(path.join(dir, 'repetidas.json'), '{}\n');
  return redHash(dir);
}
const saveGreen = (opts) => saveRed({ ...opts, origen: 'verde' });

/** Suma una repetición verde: su entrada del resumen de la suite sola, la foto de la carpeta en que corrió y su lcov. */
function addRepeat(dir, ruta, { tree, entry, lcovFile = null }) {
  const f = path.join(dir, 'repetidas.json');
  const rep = JSON.parse(fs.readFileSync(f, 'utf8'));
  rep[ruta] = { tree, entry, at: new Date().toISOString() };
  fs.writeFileSync(f, `${JSON.stringify(rep)}\n`);
  if (lcovFile && fs.existsSync(lcovFile)) {
    const txt = fs.readFileSync(lcovFile, 'utf8');
    fs.appendFileSync(path.join(dir, 'lcov-repetidas.info'), txt && !txt.endsWith('\n') ? `${txt}\n` : txt);
  }
  return redHash(dir);
}

/** Lo que todavía tiene la constancia en rojo además de las fallas; [] si nada. */
function otrasCausasDeRojo(r) {
  const t = r.totals || {};
  const out = [];
  if (t.failed > 0) out.push(`${t.failed} suite(s) roja(s)`);
  if (t.missing > 0) out.push(`${t.missing} suite(s) ausente(s)`);
  if (Array.isArray(t.unmeasured_suites) && t.unmeasured_suites.length) out.push(`${t.unmeasured_suites.length} suite(s) sin medir`);
  if (r.totals_error) out.push(`el informe no pudo contar: ${r.totals_error}`);
  if (r.halted) out.push('la corrida se frenó');
  // `companions` lo escribe test-gate.sh: `green` por cada repo hermano, con su raíz
  const rojos = (Array.isArray(r.companions) ? r.companions : []).filter((c) => !c || c.green !== true);
  if (rojos.length) out.push(`repo hermano en rojo: ${rojos.map((c) => (c && c.root ? path.basename(c.root) : '?')).join(', ')}`);
  return out;
}

/** Saca de una constancia (la de la puerta o su copia que viaja) la falla de esa entrada; devuelve si estaba. */
function sacarFalla(r, entrada, { at, inherited }) {
  const t = r.totals || (r.totals = {});
  const entradas = Array.isArray(t.failure_entries) ? t.failure_entries : [];
  const i = entradas.findIndex((e) => e && e.ruta === entrada.ruta && (e.raiz || null) === (entrada.raiz || null));
  if (i < 0) return false;
  entradas.splice(i, 1);
  // el nombre corto sale una sola vez: si otra suite de otra carpeta lo comparte, la suya queda
  const corto = path.basename(entrada.ruta);
  const fallas = Array.isArray(t.failures) ? t.failures : [];
  const j = fallas.indexOf(corto);
  if (j >= 0) fallas.splice(j, 1);
  // las que quedan son las de `failures`: una falla sin su entrada de suites.json también cuenta
  t.failed = fallas.length;
  if (inherited) {
    t.inherited_suites = [...(Array.isArray(t.inherited_suites) ? t.inherited_suites : []), corto];
    t.inherited = t.inherited_suites.length;
  } else {
    if (typeof t.passed === 'number') t.passed += 1;
    r.repeated_green = [...(Array.isArray(r.repeated_green) ? r.repeated_green : []), { ruta: entrada.ruta, raiz: entrada.raiz || null, at }];
  }
  const pendiente = otrasCausasDeRojo(r);
  if (pendiente.length) {
    r.suite_green = false;
    r.suite_green_pending = pendiente;
  } else {
    r.suite_green = true;
    r.suite_green_by = 'repeticiones';
    delete r.suite_green_pending;
  }
  // `all_green` (el total con los repos hermanos, que escribe test-gate.sh) lee lo mismo: el revisor de pruebas no
  // toma verde una constancia con `all_green: false`
  if (Object.prototype.hasOwnProperty.call(r, 'all_green')) r.all_green = r.suite_green;
  return true;
}

/**
 * La repetición de una suite sola (`test-gate.sh --suite`) saca su falla de la constancia de la completa
 * (`.advisors/tests-result.json`, la que lee el revisor de pruebas) y de su copia que viaja (`sealed`, la que lee la
 * matriz por criterio). Sólo si la constancia es de esa misma completa (`ts` igual a `fullTs`, la que anotó la lista) y
 * de esa historia, y si trae la entrada de suites.json de cada falla: por el nombre corto se confundirían dos suites.
 * `inherited`: la repetición salió roja y el juez de heredados la perdonó; va a `inherited_suites`, no a
 * `repeated_green`. Devuelve `{ written, reason }`; sin escribir, `reason` dice por qué.
 */
function rewriteResult(outFile, entrada, { fullTs, storyId = null, at = new Date().toISOString(), inherited = false, sealed = null } = {}) {
  let r;
  try { r = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (e) {
    return { written: false, reason: e.code === 'ENOENT'
      ? 'no hay constancia de la completa: la próxima completa la escribe'
      : `la constancia no se deja leer (${e.message}): no la toco` };
  }
  if (!r || typeof r.ts !== 'string' || !r.ts) return { written: false, reason: 'la constancia no dice de qué hora es: no la toco' };
  if (!fullTs || r.ts !== fullTs) return { written: false, reason: `la constancia es de otra corrida (${r.ts}; la lista es de ${fullTs || 'una completa sin hora'}): no la toco` };
  if (storyId && r.story_id && r.story_id !== storyId) return { written: false, reason: `la constancia es de otra historia (${r.story_id}): no la toco` };
  if (!r.totals || !Array.isArray(r.totals.failure_entries)) return { written: false, reason: 'la constancia es de antes (sin la entrada de cada falla): no la toco' };
  if (!sacarFalla(r, entrada, { at, inherited })) return { written: false, reason: `${entrada.ruta} no está entre las fallas de la constancia: no la toco` };
  const escribir = (f, obj) => { const tmpOut = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmpOut, `${JSON.stringify(obj, null, 2)}\n`); fs.renameSync(tmpOut, f); };
  escribir(outFile, r);
  let copia = ' (sin copia que viaja: la corrida no nombra una historia)';
  if (sealed && !fs.existsSync(sealed)) copia = ` (la copia que viaja no está en ${sealed}: no la toco)`;
  else if (sealed) {
    try {
      const s = JSON.parse(fs.readFileSync(sealed, 'utf8'));
      if (!s || s.ts !== fullTs) copia = ' (la copia que viaja es de otra corrida: no la toco)';
      else if (!sacarFalla(s, entrada, { at, inherited })) copia = ' (la copia que viaja no trae esa falla: no la toco)';
      else {
        // la copia no guarda los repos hermanos: el veredicto es el de la constancia
        s.suite_green = r.suite_green;
        if (r.suite_green) { s.suite_green_by = r.suite_green_by; delete s.suite_green_pending; } else { delete s.suite_green_by; s.suite_green_pending = r.suite_green_pending; }
        escribir(sealed, s);
        copia = ' y de su copia que viaja';
      }
    } catch (e) { copia = ` (la copia que viaja no se dejó leer: ${e.message})`; }
  }
  const estado = r.suite_green ? 'queda en verde (por las repeticiones)' : `sigue en rojo: ${r.suite_green_pending.join(', ')}`;
  return { written: true, reason: `${entrada.ruta} salió de la constancia${copia}; ${estado}` };
}

const leerJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const rutaDeFalla = (f) => (f && f.entrada && f.entrada.ruta) || null;

/**
 * Las suites que la completa roja difirió y que lo cambiado vuelve a hacer correr: por sus carpetas
 * (`gate_only_when_touching`) o por el grupo `installer` de `scripts/ci/heavy-suites.json`. Una corrida de sólo lo
 * cambiado no las vería (lee lo cambiado, no lo de la story). Tira si no puede leer los criterios.
 */
function reEligible(repo, resumen, files) {
  const { touches } = require('./touched-files');
  const diferidas = (resumen.deferred_suites || []).filter((d) => d && typeof d.suite === 'string');
  if (!diferidas.length || !files.length) return [];
  const lista = entries(path.join(repo, 'scripts', 'tests', 'suites.json'));
  const heavy = path.join(repo, 'scripts', 'ci', 'heavy-suites.json');
  let installer = null;
  if (fs.existsSync(heavy)) {
    const crit = require(path.join(repo, 'scripts', 'ci', 'suites-for-change.js')).groupCriterion(heavy, 'installer');
    if (crit.problem) throw new Error(crit.problem);
    installer = crit;
  }
  const out = [];
  for (const d of diferidas) {
    const e = lista.find((s) => typeof s.ruta === 'string' && d.suite.endsWith(`/${s.ruta}`));
    const nombre = path.basename(d.suite);
    if (e && Array.isArray(e.gate_only_when_touching) && touches(files, e.gate_only_when_touching)) out.push(nombre);
    else if (installer && /grupo installer/.test(String(d.reason || '')) && !installer.skips(nombre, files)) out.push(nombre);
  }
  return out;
}

/** Saca del lcov los registros (`SF:` … `end_of_record`) de los archivos de `files` (rutas relativas al repo). */
function dropRecords(lcov, files) {
  if (!lcov || !files || !files.length) return lcov;
  const fuera = (sf) => files.some((f) => sf === f || sf.endsWith(`/${f}`));
  const out = [];
  let reg = [];
  for (const linea of lcov.split('\n')) {
    reg.push(linea);
    if (linea === 'end_of_record') {
      const sf = (reg.find((l) => l.startsWith('SF:')) || 'SF:').slice(3).split('\\').join('/');
      if (!fuera(sf)) out.push(...reg);
      reg = [];
    }
  }
  if (reg.some((l) => l.trim())) out.push(...reg);
  return out.join('\n');
}

/** Los archivos que cambiaron entre dos árboles del repo; tira si git no contesta. */
function changedFiles(repo, a, b) {
  const r = spawnSync('git', ['-C', repo, 'diff-tree', '-r', '-z', '--name-only', '--no-renames', a, b], { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error((r.stderr || '').trim() || `git diff-tree salió ${r.status}`);
  return r.stdout.split('\0').filter(Boolean);
}

// ── Lo que pide la completa como siempre ──────────────────────────────────────────────────────────────────────────────
// Después de una completa verde (o en el árbol armado del privado) no se acota si cambió un control, el instalador, lo
// compartido o la lista de suites: los criterios salen de las listas que ya usa la CI (scripts/ci/controls-from-base.json
// y scripts/ci/heavy-suites.json, por scripts/ci/suites-for-change.js), no de una lista propia. En el privado, además, lo
// que lanza su validación y sus ganchos. Un criterio que no se deja leer tira: nunca cuenta como «no es un control».
const PREFIJOS_DEL_PRIVADO = ['pipelines/', 'scripts/ci/', 'scripts/hooks/', '.githooks/'];

/**
 * La primera clase que pide la completa entre `files` (`[{ repo, rel }]`, con `repo` «privado», «publico» o «local»):
 * `{ clase, archivo }` o null. `raiz`: la carpeta de donde se leen las listas (la del repo, o la del árbol armado).
 */
function claseQuePideLaCompleta(files, { raiz }) {
  const rels = files.map((f) => f.rel);
  const priv = files.find((f) => f.repo === 'privado' && PREFIJOS_DEL_PRIVADO.some((p) => f.rel.startsWith(p)));
  if (priv) return { clase: 'un control del privado', archivo: priv.rel };
  const lista = rels.find((r) => SUITE_LISTS.includes(r));
  if (lista) return { clase: 'la lista de suites', archivo: lista };
  const inv = path.join(raiz, 'scripts', 'ci', 'controls-from-base.json');
  if (fs.existsSync(inv)) {
    const controles = require('./risk-paths.js').archivosDeControles(raiz);
    const datos = leerJson(inv);
    const carpetas = [...(datos.content || []), ...(datos.approvals || [])].map((x) => (typeof x === 'string' ? x : x && x.path)).filter(Boolean);
    const control = rels.find((r) => (controles && controles.has(r)) || carpetas.some((c) => (c.endsWith('/') ? r.startsWith(c) : r === c)));
    if (control) return { clase: 'un control', archivo: control };
  }
  const heavy = path.join(raiz, 'scripts', 'ci', 'heavy-suites.json');
  if (fs.existsSync(heavy)) {
    const sfc = require(path.join(raiz, 'scripts', 'ci', 'suites-for-change.js'));
    const piso = sfc.floorCriterion(heavy, path.join(raiz, 'scripts', 'tests', 'suites.json'), []);
    if (piso.problem) throw new Error(piso.problem);
    const delInstalador = piso.touched(rels);
    if (delInstalador) return { clase: 'el instalador', archivo: delInstalador };
    if (typeof sfc.sharedCriterion !== 'function') throw new Error('scripts/ci/suites-for-change.js no trae sharedCriterion');
    const comun = sfc.sharedCriterion(heavy);
    if (comun.problem) throw new Error(comun.problem);
    const compartido = comun.touched(rels);
    if (compartido) return { clase: 'algo compartido', archivo: compartido };
  }
  return null;
}

// En el árbol armado la foto es la de cada repo (after-main.js `fotoDelArbol`); fuera, el árbol de la carpeta.
const esFotoDelArbol = (t) => Boolean(t) && typeof t === 'object' && t.privado && t.publico;
const huellaDe = (t) => (esFotoDelArbol(t) ? require('./after-main.js').huellaDeFoto(t) : t);

function decide({ dir, hash, repo, tree, base, recorte, storyId = null }) {
  const full = (reason) => ({ mode: 'full', reason });
  if (!dir || !fs.existsSync(dir) || redHash(dir) !== hash) return full('lo guardado no coincide con su constancia');
  let meta; let medido; let resumen; let rep;
  try {
    meta = leerJson(path.join(dir, 'meta.json'));
    medido = leerJson(path.join(dir, 'medido.json'));
    resumen = leerJson(path.join(dir, 'resumen.json'));
    rep = leerJson(path.join(dir, 'repetidas.json'));
  } catch (e) { return full(`lo guardado no se deja leer (${e.message})`); }
  const verde = meta.origen === 'verde';
  const deLa = verde ? 'la completa verde' : 'la completa roja';
  const arbol = esFotoDelArbol(tree);
  if (!medido || !tree || (arbol ? !esFotoDelArbol(medido) : typeof medido.tree !== 'string')) return full('no hay foto de la carpeta para comparar');
  // sin la historia de la corrida no se sabe si lo guardado es suyo: ante la duda, la completa
  if (meta.storyId && !storyId) return full(`no sé de qué historia es esta corrida: lo guardado es de la ${meta.storyId}`);
  if (meta.storyId && storyId && meta.storyId !== storyId) return full(`lo guardado es de otra historia (${meta.storyId})`);
  if ((meta.base || null) !== (base || null)) return full(`la base cambió desde ${deLa} (main avanzó: las suites tocadas pueden ser otras)`);
  if ((meta.recorte || '') !== (recorte || '')) return full(`esta corrida no tiene el mismo recorte que ${deLa}`);
  const heredadas = new Set(meta.heredadas || []);
  const fallas = (resumen.fallas || []).map(rutaDeFalla).filter(Boolean);
  const sinRepetir = fallas.filter((r) => !rep[r] && !heredadas.has(r));
  if (sinRepetir.length) return full(`falta repetir sola: ${sinRepetir.join(', ')}`);
  const ahora = huellaDe(tree);
  const igual = ahora === (arbol ? huellaDe(medido) : medido.tree);
  let files = [];
  if (!igual) {
    let cambios;
    if (arbol) {
      const d = require('./after-main.js').cambiosDelArbol(medido, tree);
      if (d.no) return full(`no pude comparar la carpeta con la de ${deLa} (${d.no})`);
      cambios = d.files;
    } else {
      try { cambios = changedFiles(repo, medido.tree, tree).map((rel) => ({ repo: 'local', rel })); } catch (e) { return full(`no pude comparar la carpeta con la de ${deLa} (${e.message})`); }
    }
    files = [...new Set(cambios.map((f) => f.rel))];
    if (verde || arbol) {
      let c;
      try { c = claseQuePideLaCompleta(cambios, { raiz: repo }); } catch (e) { return full(`no pude leer los criterios de lo que pide la completa (${e.message})`); }
      if (c) return full(`cambió ${c.clase} (${c.archivo})`);
    } else if (files.some((f) => SUITE_LISTS.includes(f))) return full('cambió la lista de suites: una suite nueva no está en lo guardado');
    let vuelven;
    try { vuelven = reEligible(repo, resumen, files); } catch (e) { return full(`no pude ver qué suites difirió la completa (${e.message})`); }
    if (vuelven.length) return full(`lo cambiado vuelve a hacer correr ${vuelven.join(', ')}, que ${deLa} difirió`);
  }
  const otraCarpeta = Object.entries(rep).filter(([, x]) => x.tree !== ahora).map(([r]) => r);
  if (otraCarpeta.length) return full(`la carpeta cambió después de repetir ${otraCarpeta.join(', ')}`);
  const at = meta.at;
  const origen = verde ? 'verde' : 'roja';
  if (igual) return { mode: 'same', at, origen, repetidas: Object.keys(rep).length };
  return { mode: 'changed', at, origen, repetidas: Object.keys(rep).length, files };
}

/**
 * El resumen de la completa con las repeticiones (y, si las hay, las suites que corrieron por lo cambiado) en lugar de
 * lo que falló. De la corrida nueva pasan también sus ausentes, sus no medidas y su `no_medido`: cuentan como rojo,
 * igual que en una completa. `changed` son los archivos que cambiaron después de la completa: su cobertura vieja no va.
 */
function merge({ dir, newSummary = null, covDir = null, changed = [] }) {
  const resumen = leerJson(path.join(dir, 'resumen.json'));
  const rep = leerJson(path.join(dir, 'repetidas.json'));
  const meta = leerJson(path.join(dir, 'meta.json'));
  const porRuta = new Map((resumen.suites || []).map((s) => [s.ruta, s]));
  let fallas = (resumen.fallas || []).filter((f) => !rep[rutaDeFalla(f)]);
  for (const x of Object.values(rep)) if (x.entry && x.entry.ruta) porRuta.set(x.entry.ruta, x.entry);
  let nuevas = 0;
  const extra = {};
  if (newSummary) {
    for (const s of newSummary.suites || []) { porRuta.set(s.ruta, s); nuevas += 1; }
    const corridas = new Set((newSummary.suites || []).map((s) => s.ruta));
    fallas = [...fallas.filter((f) => !corridas.has(f.ruta)), ...(newSummary.fallas || [])];
    const ausentes = Array.isArray(newSummary.ausentes) ? newSummary.ausentes : [];
    for (const a of ausentes) porRuta.delete(a);
    extra.ausentes = [...new Set([...(resumen.ausentes || []), ...ausentes])];
    extra.unmeasured_suites = [...(resumen.unmeasured_suites || []), ...(newSummary.unmeasured_suites || [])];
    if (newSummary.no_medido) extra.no_medido = newSummary.no_medido;
  }
  const suites = [...porRuta.values()];
  const origen = meta.origen === 'verde' ? 'verde' : 'roja';
  const out = { ...resumen, ...extra, suites, fallas, corridas: suites.length, verdes: suites.filter((s) => s.exit === 0).length,
    cerrada: { completa: meta.at, repetidas: Object.keys(rep).length, nuevas, origen, cambiados: changed } };
  // lo guardado verde es de antes del perdón: el de las heredadas lo vuelve a dar el juez al final del portón, con la foto
  // del nocturno de ahora
  if (origen === 'verde') delete out.inherited;
  if (covDir) {
    fs.mkdirSync(covDir, { recursive: true });
    const lcov = path.join(covDir, 'lcov.info');
    const leer = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
    const partes = [dropRecords(leer(path.join(dir, 'lcov.info')), changed), leer(path.join(dir, 'lcov-repetidas.info')), leer(lcov)]
      .filter((t) => t.trim());
    fs.writeFileSync(lcov, partes.map((t) => (t.endsWith('\n') ? t : `${t}\n`)).join(''));
    out.coverage = { ...(resumen.coverage || {}), lcov,
      juntada: origen === 'verde'
        ? `la de la completa verde de las ${hhmm(meta.at)}${changed.length ? ' (sin los archivos que cambiaron después)' : ''}${nuevas ? `, más la de las ${nuevas} suites que leen lo cambiado` : ''}`
        : `la de la completa roja de las ${hhmm(meta.at)}${changed.length ? ' (sin los archivos que cambiaron después)' : ''}, más la de las ${Object.keys(rep).length} suites repetidas solas${nuevas ? ` y la de las ${nuevas} que leen lo cambiado` : ''}` };
  }
  return out;
}

/** ¿El resumen juntado es rojo? Como en una completa: una falla, una ausente o algo sin medir. */
const mergedRed = (out) => out.fallas.length > 0 || (out.ausentes || []).length > 0 || Boolean(out.no_medido);

const hhmm = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '??:??' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

module.exports = { entries, find, fromSummary, prune, redHash, saveRed, saveGreen, addRepeat, rewriteResult, decide, merge, mergedRed, reEligible, dropRecords, changedFiles, claseQuePideLaCompleta, hhmm, RED_FILES };

if (require.main === module) {
  const [cmd, suitesJson, ruta] = process.argv.slice(2);
  const opt = (k) => { const a = process.argv; const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  if (cmd === 'decide') {
    // decide --dir <d> --hash <h> --repo <r> --tree <árbol> --base <sha> --trim <texto>
    const d = decide({ dir: opt('--dir'), hash: opt('--hash'), repo: opt('--repo'), tree: opt('--tree'), base: opt('--base') || null, recorte: opt('--trim') || '' });
    process.stdout.write(`${JSON.stringify(d)}\n`);
    process.exit(0);
  }
  if (cmd === 'merge') {
    // merge --dir <d> --out <resumen> [--new <resumen de lo que corrió>] [--changed <a,b>] [--coverage <carpeta>]
    //   → 0 verde, 1 rojo, 2 no pude
    try {
      const nuevo = opt('--new') ? leerJson(opt('--new')) : null;
      const changed = (opt('--changed') || '').split(',').filter(Boolean);
      const out = merge({ dir: opt('--dir'), newSummary: nuevo, covDir: opt('--coverage'), changed });
      fs.writeFileSync(opt('--out'), `${JSON.stringify(out, null, 2)}\n`);
      const c = out.cerrada;
      if (c.origen === 'verde') {
        const lista = `${c.cambiados.slice(0, 5).join(', ')}${c.cambiados.length > 5 ? ` y ${c.cambiados.length - 5} más` : ''}`;
        console.log(c.cambiados.length
          ? `[test-gate] cierra con la completa de las ${hhmm(c.completa)} más ${c.nuevas} suites por lo cambiado (${lista})`
          : `[test-gate] cierra con la completa de las ${hhmm(c.completa)}: la carpeta no cambió`);
      } else console.log(`[test-gate] cierra con la completa de las ${hhmm(c.completa)} y ${c.repetidas} suites repetidas solas${c.nuevas ? ` y ${c.nuevas} que leen lo cambiado` : ': la carpeta no cambió'}`);
      if (out.coverage && out.coverage.juntada) console.log(`[test-gate] cobertura juntada: ${out.coverage.juntada}`);
      if (out.fallas.length) console.error(`[test-gate] 🔴 quedan ${out.fallas.length} roja(s): ${out.fallas.map((f) => rutaDeFalla(f) || f.ruta).join(', ')}`);
      if ((out.ausentes || []).length) console.error(`[test-gate] 🔴 ${out.ausentes.length} ausente(s): ${out.ausentes.join(', ')}`);
      if (out.no_medido) console.error(`[test-gate] 🔴 no medido: ${out.no_medido}`);
      process.exit(mergedRed(out) ? 1 : 0);
    } catch (e) {
      console.error(`[test-gate] no pude juntar lo guardado (${e.message})`);
      process.exit(2);
    }
  }
  if (cmd !== 'has' || !suitesJson || !ruta) {
    console.error('uso: failed-first.js has <suites.json> <ruta> · decide … · merge …');
    process.exit(2);
  }
  try {
    process.exit(find(suitesJson, ruta) ? 0 : 1);
  } catch (e) {
    console.error(`[failed-first] no pude leer ${suitesJson}: ${e.message}`);
    process.exit(2);
  }
}
