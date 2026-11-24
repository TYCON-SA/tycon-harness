#!/usr/bin/env node
/**
 * on-planning-artifact.js — Reglas 12.1 y 12.4 de workflow-orchestration.md, al escribir en specs/planning-artifacts/.
 *
 * Regla 12.1 (aviso): todo artefacto de planning nuevo o reescrito sobre dominio ya cubierto por un artefacto APROBADO
 * declara `reconciles:`/`supersedes_in:` en frontmatter. La regla vivía sólo en la guía, invisible en el momento del
 * Write. Caso: un UX spec escrito ignorando el catálogo de pantallas aprobado por el cliente; el drift es invisible hasta
 * varias stories después. Mira los nombres tipo spec/mapa/architecture/PRD; el overlap de dominio es juicio, no regex,
 * así que sólo avisa.
 *
 * Regla 12.4 (los controles de planificación sin BMAD, historia 8.324):
 *   - un PRD con `estado: aprobado` (o `status: approved`) sin la validación de otro agente FRENA: pide
 *     `validacion: <informe en el repo>` con `validado_por:` distinto de `escrito_por:` del PRD, o un informe de BMAD
 *     (`validationTarget:`) sobre ese PRD;
 *   - cualquier `.md` de la carpeta sin `metodo:` o sin `proceso:` en su cabecera recibe un aviso.
 * Silencioso en todo lo demás. Casos: tests/planning-controls.test.js.
 */

const fs = require('fs');
const path = require('path');

// Tipos de artefacto que la Regla 12.1 cubre (heurística por nombre/contenido).
const ARTIFACT_NAME_RE = /(ux|design|navigation|architecture|arquitectura|prd|catalogo|catálogo|pantallas|spec)/i;

// Lo que se lee de una cabecera: claves de primer nivel, con su valor sin comillas. Sin cabecera, {}.
// Un comentario de YAML al final del valor (` # …`) no es parte del valor; un BOM al comienzo no es parte de la cabecera.
function cabeceraDe(texto) {
  const fm = (String(texto || '').replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1];
  const out = {};
  if (!fm) return out;
  const lineas = fm.split(/\r?\n/);
  for (let i = 0; i < lineas.length; i++) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lineas[i]);
    if (!m || m[1] in out) continue;
    // una lista en bloque (`clave:` y debajo `  - a`, `  - b`): sus elementos, unidos por «, »
    if (!m[2].replace(/\s+#.*$/, '').trim()) {
      const items = [];
      while (i + 1 < lineas.length && /^\s+-\s*/.test(lineas[i + 1])) items.push(lineas[++i].replace(/^\s+-\s*/, '').replace(/\s+#.*$/, '').trim());
      if (items.length) { out[m[1]] = items.join(', '); continue; }
    }
    let v = m[2].trim();
    const q = /^(['"])(.*)\1(\s+#.*)?$/.exec(v);
    v = q ? q[2] : v.replace(/\s+#.*$/, '');
    out[m[1]] = v.trim();
  }
  return out;
}

/**
 * El texto después de aplicar al archivo la sección de un parche de Codex (`*** Update File: <ruta>`), como llega
 * normalizado a un Edit (scripts/lib/hook-io.js, `editEventsFrom`): cada tramo `@@` cambia su bloque viejo (renglones con
 * « » o «-») por el nuevo (« » o «+»). Null si la sección no está o un tramo no aplica.
 */
function conParche(actual, parche, filePath) {
  const lineas = String(parche || '').split('\n');
  let i = lineas.findIndex((l) => { const m = /^\*\*\* Update File: (.+)$/.exec(l); return m && (path.resolve(m[1].trim()) === path.resolve(filePath) || filePath.endsWith(`/${m[1].trim().replace(/^\.\//, '')}`)); });
  if (i < 0) return null;
  const tramos = [];
  // `*** Move to:` y `*** End of File` son parte de la sección; la cierra el encabezado del archivo siguiente o el final
  for (i += 1; i < lineas.length && !/^\*\*\* (Update File|Add File|Delete File|End Patch)/.test(lineas[i]); i++) {
    const l = lineas[i];
    if (/^\*\*\* (Move to|End of File)/.test(l)) continue;
    if (l.startsWith('@@')) { tramos.push({ viejo: [], nuevo: [] }); continue; }
    if (!tramos.length) tramos.push({ viejo: [], nuevo: [] });
    const t = tramos[tramos.length - 1];
    if (l.startsWith('-')) t.viejo.push(l.slice(1));
    else if (l.startsWith('+')) t.nuevo.push(l.slice(1));
    else { const c = l.startsWith(' ') ? l.slice(1) : l; t.viejo.push(c); t.nuevo.push(c); }
  }
  if (!tramos.length) return null;
  let texto = actual;
  for (const t of tramos) {
    const viejo = t.viejo.join('\n');
    if (!viejo) return null;
    const k = texto.indexOf(viejo);
    if (k < 0) return null;
    texto = texto.slice(0, k) + t.nuevo.join('\n') + texto.slice(k + viejo.length);
  }
  return texto;
}

/** Los renglones de la sección de un archivo en un parche de Codex (`*** <op> File: <ruta>`), o null si no está. */
function seccionDe(parche, op, filePath) {
  const lineas = String(parche || '').split('\n');
  const mismo = (r) => path.resolve(r.trim()) === path.resolve(filePath) || filePath.endsWith(`/${r.trim().replace(/^\.\//, '')}`);
  const i = lineas.findIndex((l) => { const m = new RegExp(`^\\*\\*\\* ${op} File: (.+)$`).exec(l); return m && mismo(m[1]); });
  if (i < 0) return null;
  const out = [];
  for (let k = i + 1; k < lineas.length && !/^\*\*\* (Update File|Add File|Delete File|End Patch)/.test(lineas[k]); k++) out.push(lineas[k]);
  return out;
}

// El texto entero del documento después de esta escritura: el de un Write, el archivo con el reemplazo de un Edit, o el
// archivo con el parche de Codex. Un parche que no se puede aplicar suma los renglones nuevos de SU sección a la cabecera
// de hoy: así un `+estado: aprobado` se ve igual. Borrar el archivo da null: borrar no aprueba ni escribe nada.
function textoNuevo(event, filePath) {
  const ti = event.tool_input || {};
  if (event.tool_name === 'Write') return String(ti.content || '');
  let actual = '';
  try { actual = fs.readFileSync(filePath, 'utf8'); } catch (_e) { actual = ''; }
  const viejo = String(ti.old_string || '');
  const nuevo = String(ti.new_string || '');
  const parche = ti.command || ti.patch || ti.input;
  if (!viejo && !nuevo && typeof parche === 'string' && parche.includes('*** ')) {
    if (seccionDe(parche, 'Delete', filePath)) return null;
    const aplicado = conParche(actual, parche, filePath);
    if (aplicado !== null) return aplicado;
    const agregados = (seccionDe(parche, 'Update', filePath) || []).filter((l) => /^\+[A-Za-z_][\w-]*\s*:/.test(l)).map((l) => l.slice(1));
    const fm = (actual.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '';
    return `---\n${agregados.join('\n')}\n${fm}\n---\n`;
  }
  if (!viejo) return nuevo;
  return ti.replace_all ? actual.split(viejo).join(nuevo) : actual.replace(viejo, () => nuevo);
}

const APROBADO = (c) => /^(aprobado|aprobada)$/i.test(c.estado || '') || /^approved$/i.test(c.status || '');
const mismoAutor = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/**
 * Regla 12.4: un PRD con `estado: aprobado` (o `status: approved`) necesita la validación de otro agente con su informe en
 * el repo. Devuelve el motivo para frenar, o null si vale. El informe es `validacion: <ruta>`, relativa a la raíz del repo;
 * vale si nombra a quien validó (`validado_por:`, distinto de `escrito_por:` del PRD) o si es un informe de BMAD
 * (`validationTarget:`) sobre este PRD.
 */
function motivoDelPrd(filePath, cab, event = {}) {
  if (!APROBADO(cab)) return null;
  const como = 'escribí en su cabecera `validacion: <ruta del informe, desde la raíz del repo>` y `escrito_por: <quién lo escribió>`; el informe dice `validado_por: <otro agente>`';
  if (!cab.validacion) return `falta validacion: un PRD no se aprueba sin la validación de otro agente con su informe en el repo. Para aprobarlo, ${como}`;
  const raiz = require('./lib/evidence-config.js').discoverRepoRoot(filePath);
  if (!raiz) return 'no encuentro la raíz del repo del PRD: sin ella no puedo leer el informe de validación';
  const informe = path.resolve(raiz, cab.validacion);
  const rel = path.relative(raiz, informe);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return `validacion: ${cab.validacion} sale del repo: el informe tiene que estar adentro`;
  // el mismo archivo aunque se lo nombre con otras mayúsculas (un disco que no las distingue): se compara el archivo
  const mismoArchivo = (a, b) => { try { const x = fs.statSync(a); const y = fs.statSync(b); return x.ino === y.ino && x.dev === y.dev; } catch (_e) { return false; } };
  if (informe === path.resolve(filePath) || mismoArchivo(informe, filePath)) return `validacion: ${cab.validacion} es el mismo PRD: el informe de validación es otro archivo`;
  let texto;
  try { texto = fs.readFileSync(informe, 'utf8'); } catch (_e) {
    // en Codex el informe y la aprobación pueden llegar en el mismo parche: el informe nuevo se lee del parche
    const ti = event.tool_input || {};
    const nuevo = seccionDe(ti.command || ti.patch || ti.input, 'Add', informe);
    if (!nuevo) return `validacion: ${cab.validacion} no existe en el repo`;
    texto = nuevo.filter((l) => l.startsWith('+')).map((l) => l.slice(1)).join('\n');
  }
  const inf = cabeceraDe(texto);
  if (inf.validationTarget && !inf.validado_por) {
    const destino = inf.validationTarget.replace(/\\/g, '/');
    const delPrd = path.relative(path.join(raiz, 'specs'), filePath).split(path.sep).join('/');
    if (destino.endsWith(delPrd) || destino.split('/').pop() === path.basename(filePath)) return null;
    return `el informe ${cab.validacion} es de otro documento (validationTarget: ${inf.validationTarget})`;
  }
  if (!inf.validado_por) return `el informe ${cab.validacion} no dice quién validó: falta validado_por: en su cabecera`;
  if (!cab.escrito_por) return 'falta escrito_por: en la cabecera del PRD (quién lo escribió), para ver que lo validó otro';
  if (mismoAutor(inf.validado_por, cab.escrito_por)) return `lo validó el mismo que lo escribió (${cab.escrito_por}): la validación es de otro agente`;
  return null;
}

// Regla 12.4: cada documento de planificación dice en su cabecera con qué método y qué proceso se hizo. Sólo avisa.
function avisoDeCabecera(cab) {
  const faltan = [];
  if (!cab.metodo && !cab.stepsCompleted) faltan.push('metodo:');
  if (!cab.proceso) faltan.push('proceso:');
  if (!faltan.length) return null;
  return `Regla 12.4 (workflow-orchestration.md §12): a la cabecera de este documento de planificación le falta ${faltan.join(' y ')}. `
    + 'Cada documento dice cómo se hizo, por ejemplo:\n  metodo: bmad | sin-bmad | otro\n  proceso: <qué pasos se siguieron>';
}

function handle(event) {
  // 🔴 `Edit` TAMBIÉN: con `tool_name !== 'Write'` el hook sólo vería la CREACIÓN del artefacto y nunca su
  // edición — que es la forma normal de cambiar un mapa de navegación ya existente.
  if (!event || (event.tool_name !== 'Write' && event.tool_name !== 'Edit')) return null;
  const filePath = String(event.tool_input?.file_path || '').replace(/\\/g, '/');
  if (!/\/specs\/planning-artifacts\/[^/]+\.md$/.test(filePath)) return null;
  const nombre = filePath.split('/').pop();
  const nuevo = textoNuevo(event, filePath);
  if (nuevo === null) return null;
  const cab = cabeceraDe(nuevo);

  // el freno del PRD aprobado (regla 12.4), antes que todo lo que sólo avisa
  if (/prd/i.test(nombre)) {
    const motivo = motivoDelPrd(filePath, cab, event);
    if (motivo) return { block: `⛔ Regla 12.4 (workflow-orchestration.md §12): ${nombre} queda aprobado sin una validación que valga: ${motivo}.` };
  }
  const avisos = [];
  const cabecera = avisoDeCabecera(cab);
  if (cabecera) avisos.push(cabecera);
  const regla121 = ARTIFACT_NAME_RE.test(nombre) ? avisoRegla121(event, filePath) : null;
  if (regla121) avisos.push(regla121);
  return avisos.length ? { reminder: avisos.join('\n\n') } : null;
}

// La regla 12.1 y la marca de deriva de navegación, con el filtro de nombre de siempre.
function avisoRegla121(event, filePath) {
  // La MARCA de deriva de navegación: WIRING-C5 compara el código contra este documento en un solo
  // sentido (código nuevo → documento). Si el documento cambia, las pantallas ya escritas no se
  // revisan nunca más. La marca la lee el cierre de la próxima story de interfaz.
  // Va ANTES del `return null` de la regla 12.1: un artefacto que SÍ declara `reconciles:` cumple
  // esa regla y aun así cambió el modelo de navegación.
  try {
    const nd = require('./lib/navigation-drift.js');
    if (nd.esMapaDeNavegacion(filePath)) {
      const raiz = require('./lib/evidence-config.js').discoverRepoRoot(filePath);
      if (raiz) nd.marcar(raiz, path.relative(raiz, filePath), event.tool_name);
    }
  } catch (_e) { /* la marca es best-effort: nunca rompe la edición */ }

  const content = event.tool_input?.content || event.tool_input?.new_string || '';
  const fm = (content.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '';
  if (/^reconciles\s*:/m.test(fm)) return null; // cumple la regla

  const isNew = !fs.existsSync(filePath);
  return `Regla 12.1 (workflow-orchestration.md §12): estás ${isNew ? 'creando' : 'reescribiendo'} un artefacto de planning ` +
      `(${filePath.split('/').pop()}) SIN bloque \`reconciles:\` en el frontmatter. Si toca un dominio ya cubierto por un ` +
      `artefacto APROBADO previo (catálogo de pantallas, UX spec, architecture, PRD), DEBE declarar:\n` +
      `  reconciles:\n    - "<path artefacto previo> (<aprobado-cliente|interno>)"\n  supersedes_in:   # opcional\n` +
      `y resolver cada divergencia en una sección "Reconciliación". Sin eso el artefacto no pasa de draft. ` +
      `Si cambia un modelo FIRMADO por el cliente → CR registrado (Regla 12.3). ` +
      `Si NO hay artefacto previo del dominio → ignorá este reminder (es advisory). ` +
      `Caso disparador: UX spec V7 ignoró el catálogo firmado → drift invisible hasta Story 13.0.`;
}

module.exports = { handle };

if (require.main === module) {
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    const r = handle(stdin ? JSON.parse(stdin) : null);
    if (r && r.block) { process.stderr.write(`${r.block}\n`); process.exit(2); }
    if (r && r.reminder) process.stdout.write(`<system-reminder>\n${r.reminder}\n</system-reminder>\n`);
    process.exit(0);
  } catch {
    process.exit(0); // fallo abierto: un error del control nunca rompe el Write
  }
}
