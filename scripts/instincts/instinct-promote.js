#!/usr/bin/env node
/**
 * instinct-promote.js — gestión de instincts pending: list, show, approve, reject, status.
 *
 * SIMPLIFICADO: single approve sin flags. El YAML del instinct ya dice qué tipo es
 * (campo tycon_artifact_suggestion). El approve respeta esa sugerencia automáticamente.
 *
 * Estados (una carpeta por estado, en cada lugar donde hay propuestas):
 *   pending/    → recién propuestos por el observer, esperando revisión humana
 *   promoted/   → aprobados + guardados a engram + (si aplica) draft generado
 *   archived/   → rechazados con razón
 *   drafts/     → drafts auto-generados para artifact suggestions (humano commitea)
 *   descartados/ → lo que la revisión del observer descartó por repetir algo que ya existe
 *                  (local, fuera de git; `list` lo resume para que un descarte de más se vea)
 *
 * DÓNDE (story 8.27): las propuestas viven en `inbox/instincts/` del árbol si el árbol trae su buzón (el clon de
 * mantenedor); si no, en el del clon del repo privado de mantenimiento que la máquina declara, si lo trae; si no, en
 * la casa de la persona. Este guion LEE en todos los lugares que dice instinct-dirs.js (el de escritura, el clon
 * privado, lo que haya quedado en el árbol, la casa, el clon que la máquina mantiene) y no crea ninguna
 * carpeta por leer. `approve` y `reject` mueven el archivo DENTRO del lugar donde estaba.
 *
 * Comandos:
 *   list                       Lista pending con resumen (default)
 *   show <hash>                Muestra el YAML completo de un instinct
 *   approve <hash>             Mueve a promoted/ + engram mem_save instruction +
 *                              (si hay tycon_artifact_suggestion) genera draft
 *   reject <hash> --reason X   Mueve a archived/ con reason
 *   bulk-list                  1-line por instinct (machine-readable)
 *   status                     Una línea por lugar: cuántos hay en cada estado, y dónde se escribe
 *
 * NO HAY FLAGS --to-engram / --to-catalog / --to-artifact.
 * El observer ya dijo qué es. El approve respeta.
 */

const fs = require('fs');
const path = require('path');
const { generateDraft } = require('./instinct-draft');
// Dónde viven las propuestas lo contesta instinct-dirs.js, y se le pregunta en cada comando, nunca al cargar.
const DIRS = require('./instinct-dirs.js');

function parseYamlSimple(content) {
  const out = {};
  for (const line of content.split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue;
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) {
      let val = m[2].trim();
      val = val.replace(/^["']|["']$/g, '');
      if (val === 'null') val = null;
      else if (val === 'true') val = true;
      else if (val === 'false') val = false;
      else if (val.match(/^-?\d+\.?\d*$/)) val = parseFloat(val);
      out[m[1]] = val;
    }
  }
  return out;
}

/** A la salida de error: lo que no se pudo leer. Una carpeta ilegible nunca se muestra, callada, como una vacía. */
const avisar = (m) => process.stderr.write(`[instinct-promote] ${m}\n`);

/** Los `.yaml` de una carpeta, en orden. Si no existe, ninguno; si existe y no se deja leer, ninguno y se avisa. */
function yamlsDe(dir) {
  return DIRS.listDir(dir, avisar).filter((f) => f.endsWith('.yaml')).sort();
}

/**
 * Lo pendiente en TODOS los lugares de lectura, lugar por lugar. Un mismo hash pendiente en dos lugares sale una vez
 * —el del primer lugar— con los otros en `tambienEn`.
 */
function pendientes() {
  const out = [];
  const porHash = new Map();
  for (const lugar of DIRS.readPlaces()) {
    for (const f of yamlsDe(path.join(lugar, 'pending'))) {
      const ruta = path.join(lugar, 'pending', f);
      const parsed = parseYamlSimple(fs.readFileSync(ruta, 'utf-8'));
      const clave = parsed.hash || f;
      const previo = porHash.get(clave);
      if (previo) { previo.tambienEn.push(lugar); continue; }
      const item = { lugar, archivo: f, ruta, parsed, tambienEn: [] };
      porHash.set(clave, item);
      out.push(item);
    }
  }
  return out;
}

function listPending() {
  const items = pendientes();
  if (items.length === 0) {
    console.log('No hay instincts pending.');
    resumirDescartados();
    return;
  }
  console.log(`${items.length} instincts pending:\n`);
  // con pendientes en más de un lugar, cada grupo dice de dónde es
  const variosLugares = new Set(items.map((i) => i.lugar)).size > 1;
  let actual = null;
  for (const { lugar, parsed, tambienEn } of items) {
    if (variosLugares && lugar !== actual) { actual = lugar; console.log(`En ${DIRS.shown(lugar)}:\n`); }
    const hash = parsed.hash || '?';
    const conf = parsed.confidence ?? '?';
    const dom = parsed.domain || '?';
    const trig = parsed.trigger || '?';
    console.log(`  [${hash}] (${dom}, conf=${conf})`);
    console.log(`    trigger: ${trig}`);
    console.log(`    action:  ${parsed.action || '?'}`);
    if (parsed.tycon_artifact_suggestion) {
      console.log(`    suggest: ${parsed.tycon_artifact_suggestion}`);
    }
    if (tambienEn.length) console.log(`    (también en ${tambienEn.map((l) => DIRS.shown(l)).join(', ')})`);
    console.log('');
  }
  console.log('Approve:  /tycon-instincts approve <hash>');
  console.log('Reject:   /tycon-instincts reject <hash> --reason "..."');
  console.log('Show:     /tycon-instincts show <hash>');
  resumirDescartados();
}

// Lo que la revisión del observer descartó en los últimos días, con lo que dijo que lo cubre. Sin esto, «no
// hay pending» se ve igual si no hubo nada nuevo que si la revisión descartó de más (OBSERVADOR-SIN-CATALOGO-2).
// Se cuenta por propuesta (hash), no por archivo: la misma repetición vuelve en cada corrida. Mira `descartados/` de
// todos los lugares de lectura.
function resumirDescartados(dias = 14) {
  const desde = new Date(Date.now() - dias * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
  const porHash = new Map();
  const conDescartados = [];
  for (const lugar of DIRS.readPlaces()) {
    const dir = path.join(lugar, 'descartados');
    const files = DIRS.listDir(dir, avisar).filter((f) => /^\d{8}-.+\.yaml$/.test(f));
    for (const f of files.filter((x) => x.slice(0, 8) >= desde).sort()) {
      let parsed;
      try { parsed = parseYamlSimple(fs.readFileSync(path.join(dir, f), 'utf-8')); } catch (_) { continue; }
      if (!conDescartados.includes(lugar)) conDescartados.push(lugar);
      const hash = parsed.hash || f;
      const previo = porHash.get(hash);
      const archivos = previo ? previo.archivos + 1 : 1;
      const veces = Math.max(Number(parsed.veces_descartada) || 1, previo ? previo.veces : 1, archivos);
      porHash.set(hash, { ...parsed, veces, archivos, archivo: f });
    }
  }
  if (!porHash.size) return;
  const recientes = [...porHash.values()].sort((a, b) => b.archivo.localeCompare(a.archivo));
  const carpetas = conDescartados.map((l) => `${DIRS.shown(l)}/descartados/`);
  console.log(`\n${recientes.length} propuesta(s) que la revisión del observer descartó por repetir algo que ya existe (últimos ${dias} días, en esta máquina):`);
  for (const d of recientes.slice(0, 5)) {
    console.log(`  [${d.hash || '?'}] ${String(d.trigger || '?').slice(0, 100)}${d.veces > 1 ? ` (descartada ${d.veces} veces)` : ''}`);
    console.log(`    la cubre: ${d.cubierto_por || '?'}${d.motivo_de_la_revision ? ` — ${d.motivo_de_la_revision}` : ''}`);
  }
  if (recientes.length > 5) console.log(`  … y ${recientes.length - 5} más en ${carpetas.join(', ')}`);
  if (conDescartados.length === 1) console.log(`  Si alguna NO era una repetición: movela de ${carpetas[0]} a ${DIRS.shown(conDescartados[0])}/pending/ y revisala como cualquier otra.`);
  else console.log(`  Si alguna NO era una repetición: movela de su carpeta descartados/ a pending/, en el mismo lugar, y revisala como cualquier otra. Están en: ${carpetas.join(', ')}`);
}

function bulkList() {
  for (const { parsed } of pendientes()) {
    console.log(`${parsed.hash}\t${parsed.confidence}\t${parsed.domain}\t${parsed.trigger}`);
  }
}

function findByHash(hash, dir) {
  // una carpeta que existe y no se deja leer se avisa (como en `list`): no es una traza, ni un «no encontrado» callado
  const files = DIRS.listDir(dir, avisar);
  for (const f of files) {
    if (f.includes(hash)) return path.join(dir, f);
  }
  return null;
}

/** Cada copia del instinct en las carpetas `subs`, lugar por lugar (y, dentro de cada lugar, en el orden de `subs`). */
function copiasDe(hash, subs) {
  const out = [];
  if (!hash) return out;
  for (const lugar of DIRS.readPlaces()) {
    for (const sub of subs) {
      const ruta = findByHash(hash, path.join(lugar, sub));
      if (ruta) out.push({ ruta, lugar, sub });
    }
  }
  return out;
}

function showInstinct(hash) {
  const [primera] = copiasDe(hash, ['pending', 'promoted', 'archived', 'descartados']);
  if (!primera) {
    console.error(`Instinct ${hash} no encontrado.`);
    process.exit(1);
  }
  console.log(`# File: ${primera.ruta}\n`);
  console.log(fs.readFileSync(primera.ruta, 'utf-8'));
}

/** La pendiente sobre la que se actúa (la del primer lugar) y el aviso de las otras copias, que no se tocan. */
function pendienteDe(hash) {
  const copias = copiasDe(hash, ['pending']);
  if (!copias.length) {
    console.error(`Instinct ${hash} no encontrado en pending/.`);
    process.exit(1);
  }
  return { ...copias[0], otras: copias.slice(1) };
}
function avisarOtrasCopias(otras) {
  for (const o of otras) console.log(`  Hay otra copia pendiente en ${DIRS.shown(o.ruta)}: no la toqué.`);
}

/**
 * Borra la pendiente después de escribir su copia decidida. Si no se puede (permisos), lo dice y devuelve false: la
 * decisión YA quedó escrita, y lo que sigue —la memoria que hay que guardar, el borrador— no se pierde por eso.
 */
function borrarOrigen(src, dst) {
  try { fs.unlinkSync(src); return true; } catch (e) {
    avisar(`la decisión quedó escrita en ${DIRS.shown(dst)}, pero no pude borrar ${DIRS.shown(src)} (${e.code || e.message})`);
    return false;
  }
}

function approve(hash) {
  const { ruta: src, lugar, otras } = pendienteDe(hash);

  // el archivo se mueve DENTRO del lugar donde estaba: de su pending/ a su promoted/
  const fname = path.basename(src);
  const dst = path.join(lugar, 'promoted', fname);

  // Update YAML: engram_promoted + approved_at
  let content = fs.readFileSync(src, 'utf-8');
  content = content.replace(/^engram_promoted:.*$/m, 'engram_promoted: true');
  content += `approved_at: ${new Date().toISOString()}\n`;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, content);
  const quedoEnPending = !borrarOrigen(src, dst);

  const parsed = parseYamlSimple(content);
  console.log(`✓ Approved ${hash} → promoted/${fname}\n`);
  if (quedoEnPending) console.log(`  ⚠ La pendiente no se pudo borrar: sigue también en ${DIRS.shown(src)}. Borrala a mano (si no, vuelve a salir en la lista).`);
  avisarOtrasCopias(otras);

  // Step 1: engram (siempre, scope personal)
  console.log('--- Guardalo en engram con este comando ---');
  console.log(`mem_save(`);
  console.log(`  project: "${parsed.project || 'TYCON-Global'}",`);
  console.log(`  topic_key: "instinct-${hash}",`);
  console.log(`  type: "decision",`);
  console.log(`  title: ${JSON.stringify(parsed.trigger)},`);
  console.log(`  body: ${JSON.stringify(`${parsed.action}\n\nDomain: ${parsed.domain}\nEvidence: ${parsed.evidence_count} ocurrencias\nConfidence: ${parsed.confidence}\nReasoning: ${parsed.reasoning || ''}`)}`);
  console.log(`)\n`);

  // Step 2: si hay artifact suggestion, generar draft — en drafts/ del mismo lugar
  if (parsed.tycon_artifact_suggestion && parsed.tycon_artifact_suggestion !== 'null') {
    const draft = generateDraft(parsed, path.join(lugar, 'drafts'));
    if (draft) {
      const mostrado = DIRS.shown(draft.path);
      console.log(`--- Draft auto-generado (${draft.type}) ---`);
      console.log(`Archivo: ${mostrado}`);
      if (mostrado !== draft.path) {
        // quedó adentro del árbol: va por git, a mano
        console.log(`\nRevisalo, editá si querés, y commiteá a mano cuando te convenza.`);
        console.log(`NO se commitea automáticamente — vos tenés el control.\n`);
      } else {
        console.log(`\nRevisalo y editá si querés: quedó fuera del árbol del arnés, no va por git.\n`);
      }
    }
  }
}

function reject(hash, reason) {
  const { ruta: src, lugar, otras } = pendienteDe(hash);
  const fname = path.basename(src);
  const dst = path.join(lugar, 'archived', fname);
  let content = fs.readFileSync(src, 'utf-8');
  content += `rejected_at: ${new Date().toISOString()}\n`;
  content += `rejection_reason: ${JSON.stringify(reason || 'no reason given')}\n`;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, content);
  const quedoEnPending = !borrarOrigen(src, dst);
  console.log(`✓ Rejected ${hash} → archived/${fname}`);
  if (quedoEnPending) console.log(`  ⚠ La pendiente no se pudo borrar: sigue también en ${DIRS.shown(src)}. Borrala a mano (si no, vuelve a salir en la lista).`);
  avisarOtrasCopias(otras);
}

/** Una línea por lugar de lectura con sus cuentas; el de escritura, marcado. No crea nada. */
function status() {
  // Cada estado cuenta sus archivos: las propuestas son `.yaml`, los borradores `.md`. Una carpeta que existe y no se
  // deja leer sale como «?», nunca como 0.
  let sinLeer = false;
  const cuenta = (dir, ext) => {
    let ilegible = false;
    const n = DIRS.listDir(dir, () => { ilegible = true; }).filter((f) => f.endsWith(ext)).length;
    if (ilegible) sinLeer = true;
    return ilegible ? '?' : n;
  };
  // el lugar de escritura se le pregunta a instinct-dirs.js: si no se sabe (el buzón del clon privado no se deja
  // mirar), no se marca ninguno y readNotes() dice por qué
  let escritura = null;
  try { escritura = DIRS.writePlace(); } catch (e) { if (!e || e.name !== 'InstinctDirsError') throw e; }
  DIRS.readPlaces().forEach((lugar) => {
    const cuentas = DIRS.SUBDIRS.map((sub) => `${sub} ${cuenta(path.join(lugar, sub), sub === 'drafts' ? '.md' : '.yaml')}`).join(' · ');
    const aca = lugar === escritura;
    console.log(`${aca ? '* ' : '  '}${DIRS.shown(lugar)} — ${cuentas}${aca ? '   (acá se escribe)' : ''}`);
  });
  if (sinLeer) console.log('? = esa carpeta existe y no la pude leer (permisos): lo que haya ahí no está contado.');
  // lo que no se pudo sumar a la lista de lugares, y por qué
  const notas = DIRS.readNotes();
  for (const n of notas) console.log(`! ${n}`);
  if (!notas.length && DIRS.releaseWithoutMaintained()) {
    console.log('Esta máquina tiene una versión bajada y no declara el clon que mantiene (paths.maintained en su configuración): sólo se lee la casa.');
  }
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'list';
  try {
    if (cmd === 'status') return status();
    // Los descartados que quedaron en la carpeta de antes de la mudanza (story 8.12, R2) pasan a inbox/instincts/descartados/
    // antes de leerlos. La misma función que usa el observador; ver su comentario. Sólo corre en un árbol que trae su
    // buzón: es el único caso en que un comando que lee crea algo (story 8.27).
    require('./instinct-observer.js').migrarDescartadosViejos((m) => process.stderr.write(`[instinct-promote] ${m}\n`));

    // «no hay pendientes» o «no encontrado» no pueden decirse callando que un lugar entero quedó sin mirar: todo
    // comando que lee lo avisa primero (`status` lo imprime él mismo, arriba)
    if (['list', 'bulk-list', 'show', 'approve', 'reject'].includes(cmd)) for (const n of DIRS.readNotes()) avisar(n);
    if (cmd === 'list') return listPending();
    if (cmd === 'bulk-list') return bulkList();
    if (cmd === 'show') return showInstinct(args[1]);
    if (cmd === 'approve') return approve(args[1]);
    if (cmd === 'reject') {
      const reasonIdx = args.indexOf('--reason');
      const reason = reasonIdx >= 0 ? args[reasonIdx + 1] : '';
      return reject(args[1], reason);
    }
  } catch (e) {
    // sin poder saber dónde viven las propuestas no se lee ni se escribe en ningún lado: se dice el motivo, sin traza
    if (e && e.name === 'InstinctDirsError') { console.error(`instinct-promote: ${e.message}`); process.exit(1); }
    throw e;
  }

  console.error(`Comandos: list | show <hash> | approve <hash> | reject <hash> --reason "..." | bulk-list | status`);
  process.exit(1);
}

// Requerir este archivo no corre ningún comando (antes corría `list` y creaba carpetas).
if (require.main === module) main();
