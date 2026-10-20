'use strict';
/**
 * La pestaña «Cómo trabaja» del sitio de la organización: el recorrido de una historia paso por paso, para quien
 * mantiene. El modelo lo arma skills/tycon-pipeline/scripts/lib/how-it-works.js con las fuentes con que corre el arnés y
 * con el perfil de la organización (su clon, el mismo que lee Configuración).
 *
 * Las piezas del arnés no se editan acá: llevan su código y «Proponer una mejora», que arma un issue nuevo del repo
 * público con el texto ya escrito (el sitio no guarda credenciales del público; lo envía quien mantiene con su cuenta).
 * Los revisores de los paquetes del perfil sí se editan: «Revisar» los pasa por el validador de paquetes del pipeline y
 * «Proponer» arma UN pedido al repo del perfil con el pack.json y el .md del revisor, por el mismo camino que
 * Configuración (repo-proposal.js).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const TX = require('../texts.js');
const views = require('../views.js');
const RP = require('../../lib/repo-proposal.js');
const ORG = require('../../lib/org-config.js');
const { defensaDeEscritura } = require('./config.js');

const TREE = path.join(__dirname, '..', '..', '..');
const HIW = () => require(path.join(TREE, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'how-it-works.js'));
const PACKS = () => require(path.join(TREE, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'packs.js'));
const PIPE = () => require(path.join(TREE, 'skills', 'tycon-pipeline', 'scripts', 'pipeline.js'));
// GitHub no abre direcciones mucho más largas: el texto de la mejora se corta antes
const ISSUE_URL_MAX = 7000;
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = (status, obj) => ({ status, tipo: 'application/json; charset=utf-8', cuerpo: JSON.stringify(obj) });

/** La dirección del repo público del arnés (scripts/setup/public-remotes.json), sin `.git`; null si no se puede leer. */
function publicRepoOf(tree = TREE) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(tree, 'scripts', 'setup', 'public-remotes.json'), 'utf8')).remotes[0];
    return typeof r === 'string' && /^https:\/\//.test(r) ? r.replace(/\.git$/, '').replace(/\/+$/, '') : null;
  } catch { return null; }
}

/**
 * El enlace a un issue nuevo del repo público con la mejora ya escrita: `{ url, cut }`. Sin texto, `url: null`. Un
 * texto que no entra se corta (con «…») para que la dirección no pase de `max`. `t(clave, valores)` da los textos: la
 * función viaja tal cual al navegador (`issueUrlSource`), por eso no usa nada de afuera.
 */
function buildIssueUrl({ publicRepo, piece, stepName, version, text, t, max }) {
  const propio = String(text || '').trim();
  if (!propio || !publicRepo) return { url: null, cut: false };
  const titulo = t('comoTrabaja.mejoraTitulo', { pieza: String(piece).split('/').pop(), paso: stepName });
  const pie = ['', '---', t('comoTrabaja.mejoraPieza', { pieza: piece }), t('comoTrabaja.mejoraPaso', { paso: stepName }), t('comoTrabaja.mejoraVersion', { version }), t('comoTrabaja.mejoraOrigen')].join('\n');
  const armar = (cuerpo) => `${publicRepo}/issues/new?title=${encodeURIComponent(titulo)}&body=${encodeURIComponent(`${cuerpo}\n${pie}`)}`;
  const entero = armar(propio);
  if (entero.length <= max) return { url: entero, cut: false };
  const letras = Array.from(propio);
  let bajo = 0; let alto = letras.length;
  while (bajo < alto) {
    const medio = Math.ceil((bajo + alto) / 2);
    if (armar(`${letras.slice(0, medio).join('')}…`).length <= max) bajo = medio; else alto = medio - 1;
  }
  return { url: armar(`${letras.slice(0, bajo).join('')}…`), cut: true };
}

/** `buildIssueUrl` con los textos del sitio y el tope de GitHub. */
function issueUrl({ publicRepo, piece, stepName, version, text, idioma }) {
  return buildIssueUrl({ publicRepo, piece, stepName, version, text, t: (k, v) => TX.t(idioma, k, v), max: ISSUE_URL_MAX });
}

// ── la página ──

const TAG_EFECTO = { blocks: ['frena', 'comoTrabaja.frena'], warns: ['avisa', 'comoTrabaja.avisa'], records: ['anota', 'comoTrabaja.anota'] };

/**
 * El cuerpo de la página (sin el marco del sitio): la franja de la organización, la lista de pasos y cada paso con sus
 * guías, lo que se suma según la historia, sus revisores y sus controles. Sin el guion del navegador se ven todos los
 * pasos, uno debajo del otro.
 */
function renderPage(model, { idioma, publicRepo, version }) {
  const T = (k, v) => TX.t(idioma, k, v);
  const nombrePaso = (s) => { try { return T(`paso.${s.id}`); } catch { return s.name; } };
  const chip = (clase, texto) => `<span class="ct-chip ${clase}">${esc(texto)}</span>`;
  const ver = (ruta, clave = 'comoTrabaja.verCodigo') => (publicRepo ? `<a class="btn" href="${esc(`${publicRepo}/blob/main/${ruta}`)}" target="_blank" rel="noopener">${esc(T(clave))}</a>` : '');
  // sin repo público, la mejora no tiene adónde ir: no se dibuja un botón que no hace nada
  const mejorar = (ruta, paso) => (!publicRepo ? '' : `<button type="button" class="btn" data-action="improve" data-piece="${esc(ruta)}" data-step-name="${esc(paso)}" aria-expanded="false">${esc(T('comoTrabaja.proponerMejora'))}</button>`);
  const pieza = ({ origin, nombre, mono = true, cuando, chips = [], acciones, ruta, archivo = '', extra = '' }) => `<li class="ct-pieza${extra}" data-origin="${origin}"${ruta ? ` data-piece="${esc(ruta)}"` : ''}><div class="ct-que"><span class="ct-nom${mono ? '' : ' sans'}">${esc(nombre)}</span>${chips.join('')}${cuando ? `<span class="ct-cuando">${esc(cuando)}</span>` : ''}${archivo ? `<span class="ct-archivo">${esc(archivo)}</span>` : ''}</div><div class="ct-acc">${acciones}</div></li>`;
  const delArnes = chip('arnes', T('comoTrabaja.delArnes'));
  const deLaOrg = chip('org', T('comoTrabaja.deTuOrganizacion'));
  // lo de una integración de la organización: sólo llega al modelo si no la tiene apagada
  const segunOrg = chip('segun', T('comoTrabaja.segunTuOrganizacionMarca'));
  // un control: su título es qué hace y el archivo va debajo; de una integración o del arnés; opcional y apagado de
  // fábrica, o con su efecto (frena, avisa, anota)
  const control = (c, paso) => {
    const marca = c.optional ? chip('off', T('comoTrabaja.opcional', { variable: c.optional })) : chip(TAG_EFECTO[c.effect][0], T(TAG_EFECTO[c.effect][1]));
    return pieza({ origin: 'harness', nombre: T(`control.${c.spec}`), mono: false, cuando: T(`comoTrabaja.evento.${c.event}`), chips: [c.integration ? segunOrg : delArnes, marca], ruta: c.script, archivo: c.script, acciones: ver(c.script) + mejorar(c.script, paso), extra: c.optional ? ' apagada' : '' });
  };

  // la franja de la organización
  let franja;
  if (model.org) {
    const o = model.org;
    const integ = Object.entries(o.integrations || {}).map(([k, v]) => (v === false ? `<span class="ct-ap" title="${esc(T('comoTrabaja.apagadoEnTuOrganizacion'))}">${esc(k)}</span>` : `<span>${esc(k)}</span>`)).join(' ');
    const activos = o.packs.active && o.packs.active.length ? o.packs.active.join(', ') : T('comoTrabaja.ninguno');
    const r = o.rules || {};
    const valor = (x) => (x && x.value != null ? String(x.value) : T('comoTrabaja.ninguno'));
    const reglas = [T('comoTrabaja.reglaNombres', { valor: valor(r.test_names) }), T('comoTrabaja.reglaPantallas', { valor: valor(r.screen_test) }), T('comoTrabaja.reglaIdioma', { valor: valor(r.ui_language) })].join(' · ');
    const problemas = (o.problems || []).length ? `<div class="ct-fila"><b>${esc(T('comoTrabaja.orgProblemas'))}</b><span>${o.problems.map(esc).join(' · ')}</span></div>` : '';
    franja = `<section class="ct-org card" aria-label="${esc(T('comoTrabaja.orgTitulo'))}"><h2>${esc(T('comoTrabaja.orgTitulo'))}</h2><div class="ct-fila"><b>${esc(T('comoTrabaja.orgIntegraciones'))}</b><span>${integ} <span class="ct-nota">${esc(T('comoTrabaja.orgIntegracionesAyuda'))}</span></span></div><div class="ct-fila"><b>${esc(T('comoTrabaja.orgPaquetes'))}</b><span>${esc(activos)}</span></div><div class="ct-fila"><b>${esc(T('comoTrabaja.orgReglas'))}</b><span>${esc(reglas)}</span></div>${problemas}</section>`;
  } else {
    const motivo = model.profile.state === 'no_configurado' ? T('comoTrabaja.perfilNoConfigurado') : T('comoTrabaja.perfilSinLeer', { motivo: model.profile.reason || model.profile.state });
    franja = `<section class="ct-org card"><h2>${esc(T('comoTrabaja.orgTitulo'))}</h2><p class="ct-vacio">${esc(motivo)}</p></section>`;
  }

  // la lista de pasos (y, en el teléfono, la lista desplegable)
  // primero los del recorrido, en su orden; después, aparte, los que no van en él (la tabla los tiene intercalados)
  let n = 0; let aparte = false;
  const enOrden = [...model.steps.filter((s) => s.inSequence), ...model.steps.filter((s) => !s.inSequence)];
  const items = enOrden.map((s) => {
    let pre = '';
    if (!s.inSequence && !aparte) { aparte = true; pre = `<li class="ct-aparte">${esc(T('comoTrabaja.fueraDelRecorrido'))}</li>`; }
    if (s.inSequence) n += 1;
    return `${pre}<li><a href="#paso-${esc(s.id)}" data-step="${esc(s.id)}"><span class="n">${s.inSequence ? String(n).padStart(2, '0') : '·'}</span><span>${esc(nombrePaso(s))}</span></a></li>`;
  }).join('');
  // «En todo el recorrido»: la última entrada, aparte, y se elige como un paso
  const todoNombre = T('comoTrabaja.enTodoElRecorrido');
  const itemTodo = `<li class="ct-aparte">${esc(T('comoTrabaja.enCualquierPaso'))}</li><li><a href="#paso-todo" data-step="todo"><span class="n">·</span><span>${esc(todoNombre)}</span></a></li>`;
  const lista = `<ol class="ct-pasos card" aria-label="${esc(T('pestana.comoTrabaja'))}">${items}${itemTodo}</ol>`;
  const elegir = `<label class="ct-elegir"><span>${esc(T('comoTrabaja.elegirPaso'))}</span><select data-action="step">${enOrden.map((s) => `<option value="${esc(s.id)}">${esc(nombrePaso(s))}</option>`).join('')}<option value="todo">${esc(todoNombre)}</option></select></label>`;

  const orgPacks = model.packs.filter((p) => p.origin === 'organization');
  // los problemas de un paquete en llano: el agente que falta, con dónde debería estar; los demás, como los dice el
  // lector (sin repetir y sin rutas de la máquina: así llegan del modelo)
  const enLlano = (p) => {
    const faltan = (p && p.missing) || [];
    return [
      ...faltan.map((x) => T('comoTrabaja.faltaAgente', { revisor: x.agent, rutas: x.expected.join(T('comoTrabaja.oBien')) })),
      ...((p && p.problems) || []).filter((t) => !faltan.some((x) => t.startsWith(`${x.agent}: no existe el agente`))),
    ];
  };
  const porque = (r) => (r.notEditable && r.notEditable.reason === 'validation' ? T('comoTrabaja.noEditableValidacion')
    : T('comoTrabaja.noEditableRoto', { motivo: enLlano(orgPacks.find((p) => p.name === r.pack))[0] || (r.notEditable && r.notEditable.detail) || '' }));
  const pasos = model.steps.map((s) => {
    const paso = nombrePaso(s);
    const goal = (() => { try { return T(`paso.${s.id}.objetivo`); } catch { return s.goal; } })();
    const bloque = (titulo, cuerpo) => `<div class="ct-bloque"><h3>${esc(titulo)}</h3>${cuerpo}</div>`;
    // el primero es el archivo del paso mismo; las demás, las guías que cita
    const guias = `<ul class="ct-lista">${s.guides.map((g) => pieza({ origin: 'harness', nombre: g, ruta: g, acciones: ver(g) + mejorar(g, paso) })).join('')}</ul>${s.guides.length > 1 ? '' : `<p class="ct-vacio">${esc(T('comoTrabaja.sinGuias'))}</p>`}`;
    // las piezas de las integraciones de la organización que lleva el paso (sólo en los pasos que declaran alguna)
    const deLaOrgPiezas = !s.orgPiecesDeclared ? '' : bloque(T('comoTrabaja.segunTuOrganizacion'), s.orgPieces.length
      ? `<ul class="ct-lista">${s.orgPieces.map((x) => pieza({ origin: 'harness', nombre: T(x.textKey), mono: false, chips: [segunOrg], ruta: x.code, archivo: x.code, acciones: ver(x.code) + mejorar(x.code, paso) })).join('')}</ul>`
      : `<p class="ct-vacio">${esc(T('comoTrabaja.sinPiezasOrg'))}</p>`);
    const segun = s.storyPieces.length ? `<ul class="ct-lista">${s.storyPieces.map((p) => pieza({ origin: 'harness', nombre: T(`${p.textKey}.pieza`), mono: false, cuando: T(p.textKey), chips: [delArnes], ruta: p.code, acciones: ver(p.code) + ver(p.guide, 'comoTrabaja.verGuia') + mejorar(p.code, paso) })).join('')}</ul>` : `<p class="ct-vacio">${esc(T('comoTrabaja.sinSegun'))}</p>`;
    // los revisores: los del núcleo por grupo, y los de cada paquete
    const grupos = [['always', 'comoTrabaja.grupoSiempre'], ['story', 'comoTrabaja.grupoHistoria'], ['change', 'comoTrabaja.grupoCambio']];
    let rev = grupos.filter(([g]) => s.reviewers[g].length).map(([g, clave]) => `<p class="ct-grupo">${esc(T(clave))}</p><ul class="ct-lista">${s.reviewers[g].map((r) => pieza({ origin: 'harness', nombre: r.agent, cuando: T(r.whenKey), chips: [delArnes], ruta: r.file, acciones: ver(r.file) + mejorar(r.file, paso) })).join('')}</ul>`).join('');
    const porPaquete = new Map();
    for (const r of s.reviewers.packs) { if (!porPaquete.has(r.pack)) porPaquete.set(r.pack, []); porPaquete.get(r.pack).push(r); }
    for (const [pack, rs] of porPaquete) {
      const items2 = rs.map((r) => {
        const cuando = r.when && typeof r.when.detection === 'string' && Object.keys(r.when).length === 1 ? (() => { try { return T(`bandera.${r.when.detection}`); } catch { return r.when.detection; } })() : (r.group === 'base' && !r.when ? T('comoTrabaja.grupoBase') : T('comoTrabaja.condicionEscrita'));
        const chips = [r.origin === 'organization' ? deLaOrg : delArnes, r.active === false ? chip('off', T('comoTrabaja.noActivo')) : ''];
        const acciones = r.origin === 'organization'
          ? (r.editable ? `<button type="button" class="btn" data-action="edit" data-pack="${esc(pack)}" data-agent="${esc(r.agent)}" aria-expanded="false">${esc(T('comoTrabaja.editar'))}</button>` : `<span class="ct-nota">${esc(porque(r))}</span>`)
          : ver(`packs/${pack}/${r.file.split('/').slice(1).join('/')}`) + mejorar(`packs/${pack}/pack.json`, paso);
        return pieza({ origin: r.origin, nombre: r.agent, cuando, chips, acciones, extra: r.active === false ? ' apagada' : '' });
      }).join('');
      const esOrg = rs[0].origin === 'organization';
      const agregar = esOrg && rs.some((r) => r.editable) && (s.id === '5') ? `<button type="button" class="btn mas" data-action="add" data-pack="${esc(pack)}">${esc(T('comoTrabaja.agregarRevisor'))}</button>` : '';
      rev += `<p class="ct-grupo">${esc(T('comoTrabaja.grupoPaquete', { paquete: pack }))}</p><ul class="ct-lista">${items2}</ul>${agregar}`;
    }
    if (s.id === '5') {
      for (const p of orgPacks.filter((x) => x.problems.length)) rev += `<p class="ct-error">${esc(T('comoTrabaja.paqueteRoto', { paquete: p.name, motivo: enLlano(p).join(' · ') }))}</p>`;
      if (model.org && !orgPacks.length) rev += `<p class="ct-vacio">${esc(T('comoTrabaja.sinRevisoresOrg'))}</p>`;
    }
    if (!rev) rev = `<p class="ct-vacio">${esc(T('comoTrabaja.sinRevisores'))}</p>`;
    const controles = s.controls.length ? `<ul class="ct-lista">${s.controls.map((c) => control(c, paso)).join('')}</ul>` : `<p class="ct-vacio">${esc(T('comoTrabaja.sinControles'))}</p>`;
    return `<section class="ct-paso card" id="paso-${esc(s.id)}" data-step="${esc(s.id)}" data-step-name="${esc(paso)}"><header><h2>${esc(paso)}</h2><p class="ct-goal">${esc(goal || '')}</p></header>${bloque(T('comoTrabaja.guias'), guias)}${deLaOrgPiezas}${bloque(T('comoTrabaja.segun'), segun)}${bloque(T('comoTrabaja.revisores'), rev)}${bloque(T('comoTrabaja.controles'), (s.controls.length ? `<p class="ct-nota">${esc(T('comoTrabaja.leyendaControles'))}</p>` : '') + controles)}</section>`;
  }).join('');
  // «En todo el recorrido» es un paso más de la pantalla: el guion que esconde los pasos no elegidos la esconde a ella
  const todo = model.allSteps.controls.map((c) => control(c, todoNombre)).join('');
  const enTodo = `<section class="ct-paso card" id="paso-todo" data-step="todo" data-step-name="${esc(todoNombre)}"><header><h2>${esc(todoNombre)}</h2><p class="ct-goal">${esc(T('comoTrabaja.enTodoElRecorridoAyuda'))}</p></header><div class="ct-bloque"><h3>${esc(T('comoTrabaja.controles'))}</h3><p class="ct-nota">${esc(T('comoTrabaja.leyendaControles'))}</p><ul class="ct-lista">${todo}</ul></div></section>`;
  // lo que no se pudo leer de las fuentes del arnés, arriba de todo: un paso o un control que falta no es «no hay»
  const ilegible = (model.problems || []).length ? `<section class="ct-org card ct-problemas"><h2>${esc(T('comoTrabaja.problemasArnes'))}</h2>${model.problems.map((p) => `<p class="ct-error">${esc(p)}</p>`).join('')}</section>` : '';
  return `<div class="ct" data-version="${esc(version || '')}" data-public-repo="${esc(publicRepo || '')}">${ilegible}${franja}${elegir}<div class="ct-cuerpo">${lista}<div class="ct-detalle">${pasos}${enTodo}<p class="ct-fuente">${esc(T('comoTrabaja.fuente'))}</p></div></div></div>`;
}

// ── el revisor propio: revisar con el lector del pipeline ──

/** La cabecera (frontmatter) de un agente: sus claves de primer nivel como texto, sin las comillas de un valor. */
function cabeceraDe(texto) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(texto || ''));
  if (!m) return null;
  const claves = {};
  for (const l of m[1].split(/\r?\n/)) { const k = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(l); if (k) claves[k[1]] = k[2].trim().replace(/^(["'])(.*)\1$/, '$2'); }
  return { claves, cuerpo: m[2] };
}

/**
 * El revisor del manifiesto con lo que cambió el borrador; `original`: la entrada de antes (o null si es nuevo). Lo que
 * el editor no muestra se conserva: una condición escrita a mano (si no se eligió otra) y «mira todos los archivos»
 * (`surface.always`, mientras no se escriban archivos). Un prefijo vaciado queda vacío: lo dice el validador.
 */
function entradaDe(draft, original) {
  const e = original ? JSON.parse(JSON.stringify(original)) : { depth: 'lean' };
  e.agent = draft.agent;
  e.group = draft.group;
  if (typeof draft.detection === 'string' && draft.detection) e.when = { detection: draft.detection };
  const rutas = Array.isArray(draft.paths) ? draft.paths.map((p) => String(p).trim()).filter(Boolean) : [];
  const antes = e.surface && typeof e.surface === 'object' ? e.surface : {};
  if (!rutas.length && antes.always === true) e.surface = { ...antes };
  else { e.surface = { ...antes, paths: rutas }; delete e.surface.always; }
  const prefijo = typeof draft.prefix === 'string' ? draft.prefix.trim() : '';
  e.prefixes = prefijo ? [prefijo, ...(Array.isArray(e.prefixes) ? e.prefixes.slice(1) : [])] : [];
  return e;
}

/** Los revisores que ya declaran los OTROS paquetes (del árbol y del perfil), como los ve el cargador del pipeline. */
function declaradosEnOtros({ treeDir, profileDir, pack }) {
  const out = new Map();
  // lo que no se pudo leer: la revisión no puede asegurar que el nombre no esté repetido ahí, y lo dice
  const ilegibles = [];
  for (const [raiz, propio] of [[path.join(treeDir, 'packs'), false], [path.join(profileDir, 'packs'), true]]) {
    let nombres = [];
    try { nombres = fs.readdirSync(raiz, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (e) {
      if (e && e.code !== 'ENOENT') ilegibles.push(`packs (${e.code})`);
      continue;
    }
    for (const n of nombres) {
      if (propio && n === pack) continue;
      const archivo = path.join(raiz, n, 'pack.json');
      let j;
      try { j = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch (e) {
        if (e && e.code !== 'ENOENT') ilegibles.push(`${n}/pack.json (${e.code || e.name})`);
        continue;
      }
      for (const r of Array.isArray(j && j.reviewers) ? j.reviewers : []) if (r && typeof r.agent === 'string' && !out.has(r.agent)) out.set(r.agent, { paquete: n, archivo: `packs/${n}/pack.json` });
    }
  }
  return { mapa: out, ilegibles };
}

/**
 * Arma el pack.json y el .md propuestos y los pasa por el validador de paquetes del pipeline (en una carpeta aparte,
 * nunca en el clon, con los revisores de los otros paquetes, como el cargador) y por la cabecera del agente.
 * `{ ok, problems, files: [{ archivo, contenido }], pack }`. Los problemas propios salen en el idioma de la página; los
 * del validador, tal cual.
 */
function reviewDraft({ profileDir, draft, treeDir = TREE, idioma = 'es' }) {
  const E = (k, v) => TX.t(idioma, `comoTrabaja.err.${k}`, v);
  const problems = [];
  if (!profileDir) return { ok: false, problems: [E('sinPerfil')], files: [] };
  if (!draft || typeof draft !== 'object') return { ok: false, problems: [E('sinBorrador')], files: [] };
  if (typeof draft.pack !== 'string' || !NAME_RE.test(draft.pack)) return { ok: false, problems: [E('sinPaquete')], files: [] };
  const dirPack = path.join(profileDir, 'packs', draft.pack);
  let json;
  // el motivo es el código del error o su tipo (SyntaxError), igual en los dos idiomas; nunca el mensaje del parser:
  // podría citar el contenido del archivo
  try { json = JSON.parse(fs.readFileSync(path.join(dirPack, 'pack.json'), 'utf8')); } catch (e) { return { ok: false, problems: [E('paqueteIlegible', { paquete: draft.pack, codigo: (e && (e.code || e.name)) || 'Error' })], files: [] }; }
  if (!json || !Array.isArray(json.reviewers)) return { ok: false, problems: [E('paqueteRoto')], files: [] };
  // la carpeta de agentes sale del manifiesto del perfil: si sube de nivel o es absoluta, no se escribe ni se lee nada
  const carpetaAgentes = HIW().agentsFolderOf(json);
  if (!carpetaAgentes) return { ok: false, problems: [E('carpetaAgentes')], files: [] };
  const agente = typeof draft.agent === 'string' ? draft.agent : '';
  const original = draft.original ? json.reviewers.find((r) => r && r.agent === draft.original) : null;
  if (draft.original && !original) return { ok: false, problems: [E('yaNoEsta', { revisor: draft.original })], files: [] };
  if (!['base', 'condicional'].includes(draft.group)) problems.push(E('grupo'));
  if (!(typeof draft.detection === 'string' && draft.detection) && !(original && original.when)) problems.push(E('condicion'));
  const nuevo = { ...json, reviewers: original ? json.reviewers.map((r) => (r === original ? entradaDe(draft, original) : r)) : [...json.reviewers, entradaDe(draft, null)] };
  // la cabecera y el cuerpo del agente
  const cab = cabeceraDe(draft.instructions);
  if (!cab) problems.push(E('cabecera'));
  else {
    // con un nombre mal escrito, el problema es el nombre (lo dice el lector); pedir que la cabecera lo repita confunde
    if (NAME_RE.test(agente) && cab.claves.name !== agente) problems.push(E('nombre', { revisor: agente }));
    for (const k of ['description', 'tools']) if (!cab.claves[k]) problems.push(E('falta', { clave: k }));
    if (!cab.cuerpo.trim()) problems.push(E('vacias'));
  }
  // el validador del pipeline, sobre una copia del paquete con el borrador puesto
  // dónde va el .md del borrador: donde está hoy (la carpeta del paquete o agents/ del perfil); uno nuevo, en el paquete
  const destino = NAME_RE.test(agente) ? HIW().agentFileOf({ baseDir: profileDir, pack: draft.pack, json, agent: agente, agentsDir: path.join(profileDir, 'agents') }) : null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'how-it-works-pack-'));
  try {
    const copia = path.join(tmp, draft.pack);
    // agents/ del perfil, copiada aparte: es la carpeta de respaldo con que se valida, como al instalar
    const raiz = path.join(tmp, '.agents-del-perfil');
    // la copia no trae ningún enlace simbólico del perfil (ni de archivos ni de carpetas): así nada de lo que se escribe
    // en ella puede caer afuera de la carpeta temporal. Un revisor cuyo .md era un enlace queda sin él, y el lector lo dice
    const escribir = (destino, texto) => { fs.rmSync(destino, { force: true, recursive: true }); fs.writeFileSync(destino, texto); };
    try {
      fs.cpSync(dirPack, copia, { recursive: true, filter: (origen) => !fs.lstatSync(origen).isSymbolicLink() });
      fs.mkdirSync(raiz);
      const agentesPerfil = path.join(profileDir, 'agents');
      if (fs.existsSync(agentesPerfil) && !fs.lstatSync(agentesPerfil).isSymbolicLink()) fs.cpSync(agentesPerfil, raiz, { recursive: true, filter: (origen) => !fs.lstatSync(origen).isSymbolicLink() });
      escribir(path.join(copia, 'pack.json'), ORG.formatJson(nuevo));
      if (destino === `agents/${agente}.md`) escribir(path.join(raiz, `${agente}.md`), String(draft.instructions || ''));
      else if (destino) { fs.mkdirSync(path.join(copia, carpetaAgentes), { recursive: true }); escribir(path.join(copia, carpetaAgentes, `${agente}.md`), String(draft.instructions || '')); }
    } catch (e) { return { ok: false, problems: [...problems, E('copia', { codigo: (e && e.code) || 'error' })], files: [] }; }
    const P = PACKS();
    const otros = declaradosEnOtros({ treeDir, profileDir, pack: draft.pack });
    if (otros.ilegibles.length) problems.push(E('otrosIlegibles', { packs: otros.ilegibles.join(', ') }));
    const errores = P.validarManifiesto(nuevo, { archivo: path.join(copia, 'pack.json'), agentsDir: raiz, nucleo: PIPE().revisoresDelNucleo(), banderas: P.BANDERAS, yaDeclarados: otros.mapa });
    // sin la carpeta temporal en el mensaje: la persona ve rutas del perfil
    for (const e of errores) problems.push(`${e.revisor ? `${e.revisor}: ` : ''}${HIW().withoutAbsolutePaths(String(e.motivo).split(`${raiz}${path.sep}`).join('agents/').split(`${tmp}${path.sep}`).join('packs/'), [profileDir, treeDir, tmp])}`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const files = NAME_RE.test(agente) ? [
    { archivo: `packs/${draft.pack}/pack.json`, contenido: ORG.formatJson(nuevo) },
    { archivo: destino === `agents/${agente}.md` ? destino : `packs/${draft.pack}/${carpetaAgentes}/${agente}.md`, contenido: String(draft.instructions || '') },
  ] : [];
  return { ok: !problems.length, problems, files, pack: draft.pack };
}

/**
 * El identificador de objeto de un archivo en el HEAD de un clon: `{ oid }` (null si el archivo no está: `rev-parse
 * --quiet` sale 1 sin decir nada) o `{ error }` si git no pudo contestar (clon roto, git ausente): no es «no existe».
 */
function oidEnHead(dir, archivo) {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--verify', '--quiet', `HEAD:${archivo}`], { cwd: dir }, (err, out, errOut) => {
      if (!err) return resolve({ oid: String(out).trim() || null });
      if (err.code === 1 && !String(errOut || '').trim()) return resolve({ oid: null });
      resolve({ error: String(errOut || err.code || err.message).trim().split('\n')[0].slice(0, 200) });
    });
  });
}

/** Las versiones de los archivos firmadas con el token de la sesión: la página las devuelve y no las puede inventar. */
function firmaDe(tok, versiones) {
  return crypto.createHmac('sha256', String(tok || '')).update(JSON.stringify(Object.keys(versiones).sort().map((k) => [k, versiones[k]]))).digest('hex');
}
function firmaValida(tok, versiones, firma) {
  if (!tok || !versiones || typeof versiones !== 'object' || typeof firma !== 'string' || !/^[0-9a-f]{64}$/.test(firma)) return false;
  return crypto.timingSafeEqual(Buffer.from(firmaDe(tok, versiones)), Buffer.from(firma));
}

/** Las versiones de hoy, en el clon, de los archivos que tocaría el revisor: `{ versions }` o `{ error }`. */
async function versionesDe(dir, archivos) {
  const versions = {};
  for (const a of archivos) {
    const r = await oidEnHead(dir, a);
    if (r.error) return { error: `${a}: ${r.error}` };
    versions[a] = r.oid;
  }
  return { versions };
}

/**
 * Lo que el editor necesita de un revisor del perfil: `{ draft }` con lo que hay hoy, o `{ error }` con el motivo (el
 * paquete no se puede leer, su carpeta de agentes sale del paquete, el revisor ya no está). `whenWritten`: la condición
 * no es una sola bandera (se conserva salvo que se elija otra); `always`: mira todos los archivos.
 */
function draftOf(profileDir, pack, agent) {
  let json;
  try { json = JSON.parse(fs.readFileSync(path.join(profileDir, 'packs', pack, 'pack.json'), 'utf8')); } catch (e) { return { error: `packs/${pack}/pack.json (${(e && (e.code || e.name)) || 'Error'})` }; }
  const r = Array.isArray(json && json.reviewers) ? json.reviewers.find((x) => x && x.agent === agent) : null;
  if (!r) return { error: `${agent}: ya no está en packs/${pack}/pack.json` };
  const carpeta = HIW().agentsFolderOf(json);
  if (!carpeta) return { error: `packs/${pack}/pack.json: «agents» sale de la carpeta del paquete` };
  let instructions = '';
  // donde está el .md: en la carpeta del paquete o, si no, en agents/ del perfil (la que mira el instalador)
  const relMd = HIW().agentFileOf({ baseDir: profileDir, pack, json, agent, agentsDir: path.join(profileDir, 'agents') });
  const md = path.join(profileDir, relMd);
  try {
    // un enlace simbólico se rechaza: el editor mostraría el archivo al que apunta, que puede estar fuera del perfil
    if (!fs.lstatSync(md).isFile()) return { error: `${relMd} no es un archivo común` };
    // y ninguna carpeta del camino puede ser un enlace que lleve afuera del perfil
    if (!fs.realpathSync(md).startsWith(`${fs.realpathSync(profileDir)}${path.sep}`)) return { error: `${relMd} no es un archivo común` };
    instructions = fs.readFileSync(md, 'utf8');
  } catch (e) {
    // sin su .md el editor lo arma de nuevo y la cabecera lo pide; cualquier otro error se dice
    if (!e || e.code !== 'ENOENT') return { error: `${relMd} (${(e && e.code) || 'error'})` };
  }
  const simple = r.when && typeof r.when.detection === 'string' && Object.keys(r.when).length === 1;
  return { md: relMd, draft: {
    pack, original: agent, agent, group: r.group, detection: simple ? r.when.detection : '', whenWritten: Boolean(r.when && !simple),
    paths: (r.surface && r.surface.paths) || [], always: Boolean(r.surface && r.surface.always === true), prefix: (r.prefixes || [])[0] || '', instructions,
  } };
}

// ── el guion del navegador ──

/** Los textos que usa el guion del navegador, en el idioma de la página. */
function textosDelGuion(idioma) {
  const claves = Object.keys(TX.TEXTOS).filter((k) => k.startsWith('comoTrabaja.'));
  return Object.fromEntries(claves.map((k) => [k, TX.t(idioma, k)]));
}

/** El guion de la pestaña: elegir un paso, el cuadro de la mejora y el editor del revisor propio. Sin nada en línea. */
function guion(idioma) {
  const banderas = PACKS().BANDERAS.map((b) => [b, (() => { try { return TX.t(idioma, `bandera.${b}`); } catch { return b; } })()]);
  return `'use strict';
(function () {
var TXT = ${JSON.stringify(textosDelGuion(idioma))};
var BANDERAS = ${JSON.stringify(banderas)};
var MAX = ${ISSUE_URL_MAX};
var buildIssueUrl = ${buildIssueUrl.toString()};
function T(k, v) { var s = TXT[k] || k; return s.replace(/\\{([A-Za-z][A-Za-z0-9_]*)\\}/g, function (m, n) { return v && Object.prototype.hasOwnProperty.call(v, n) ? String(v[n]) : m; }); }
function el(tag, a) { var e = document.createElement(tag); for (var k in a || {}) { if (a[k] == null) continue; if (k === 'text') e.textContent = a[k]; else if (k.slice(0, 2) === 'on') e[k] = a[k]; else e.setAttribute(k, a[k]); } for (var i = 2; i < arguments.length; i++) if (arguments[i]) e.appendChild(arguments[i]); return e; }
var raiz = document.querySelector('.ct'); if (!raiz) return;
var token = (document.querySelector('meta[name="site-token"]') || {}).content || '';
function mostrar(id) {
  var hay = document.getElementById('paso-' + id); if (!hay) return;
  document.querySelectorAll('.ct-paso').forEach(function (s) { s.hidden = s.getAttribute('data-step') !== id; });
  document.querySelectorAll('.ct-pasos a').forEach(function (a) { if (a.getAttribute('data-step') === id) a.setAttribute('aria-current', 'step'); else a.removeAttribute('aria-current'); });
  var sel = document.querySelector('select[data-action="step"]'); if (sel) sel.value = id;
}
var inicial = (location.hash || '').replace('#paso-', '');
mostrar(document.getElementById('paso-' + inicial) ? inicial : (document.querySelector('.ct-paso') || { getAttribute: function () { return ''; } }).getAttribute('data-step'));
raiz.classList.add('con-guion');
document.querySelectorAll('.ct-pasos a').forEach(function (a) { a.addEventListener('click', function (ev) { ev.preventDefault(); history.replaceState(null, '', '#paso-' + a.getAttribute('data-step')); mostrar(a.getAttribute('data-step')); }); });
var sel = document.querySelector('select[data-action="step"]');
if (sel) sel.addEventListener('change', function () { history.replaceState(null, '', '#paso-' + sel.value); mostrar(sel.value); });
function cerrarPaneles() { document.querySelectorAll('.ct-panel').forEach(function (p) { p.remove(); }); document.querySelectorAll('[aria-expanded="true"]').forEach(function (b) { b.setAttribute('aria-expanded', 'false'); }); }
function despuesDe(boton, panel) { var li = boton.closest('li') || boton; li.parentNode.insertBefore(panel, li.nextSibling); boton.setAttribute('aria-expanded', 'true'); }
// la mejora de una pieza del arnés: un issue del repo público con el texto ya escrito
function cuadroMejora(boton) {
  var ta = el('textarea', { rows: '4', 'aria-label': T('comoTrabaja.mejoraQue'), placeholder: T('comoTrabaja.mejoraEjemplo') });
  var ir = el('a', { class: 'btn prim', target: '_blank', rel: 'noopener', 'data-action': 'send-improvement', text: T('comoTrabaja.mejoraEnviar') });
  var aviso = el('p', { class: 'ct-nota', hidden: 'hidden', text: T('comoTrabaja.mejoraCortado') });
  function act() {
    var r = buildIssueUrl({ publicRepo: raiz.getAttribute('data-public-repo'), piece: boton.getAttribute('data-piece'), stepName: boton.getAttribute('data-step-name'), version: raiz.getAttribute('data-version'), text: ta.value, t: T, max: MAX });
    if (r.url) { ir.href = r.url; ir.removeAttribute('aria-disabled'); } else { ir.removeAttribute('href'); ir.setAttribute('aria-disabled', 'true'); }
    if (r.cut) aviso.removeAttribute('hidden'); else aviso.setAttribute('hidden', 'hidden');
  }
  ta.addEventListener('input', act); act();
  var panel = el('li', { class: 'ct-panel' }, el('label', {}, el('span', { text: T('comoTrabaja.mejoraQue') }), ta), el('p', { class: 'ct-nota', text: T('comoTrabaja.mejoraNota') }), aviso,
    el('div', { class: 'ct-pie' }, ir, el('button', { type: 'button', class: 'btn', text: T('comoTrabaja.cerrar'), onclick: cerrarPaneles })));
  despuesDe(boton, panel); setTimeout(function () { ta.focus(); }, 0);
}
function pedir(ruta, cuerpo) {
  return fetch(ruta, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-site-token': token }, body: JSON.stringify(cuerpo) })
    .then(function (r) { return r.json().catch(function () { return { ok: false, message: String(r.status) }; }); }, function (e) { return { ok: false, message: String(e && e.message || e) }; });
}
// el editor de un revisor del perfil
// firmadas: las versiones de los archivos cuando se abrió el editor, firmadas por el servidor ({ versions, firma }); un
// revisor nuevo las toma de la primera revisión. No se pisan: el aviso de «otro lo cambió» se mide desde la apertura
function editor(boton, draft, firmadas) {
  var versiones = firmadas && firmadas.firma ? firmadas : null;
  var estado = el('div', { class: 'ct-estado', 'aria-live': 'polite' });
  var proponer = el('button', { type: 'button', class: 'btn prim', disabled: 'disabled', 'data-action': 'propose', text: T('comoTrabaja.proponer') });
  function cambio() { proponer.setAttribute('disabled', 'disabled'); estado.textContent = ''; }
  var nombre = el('input', { value: draft.agent, 'data-field': 'agent', oninput: cambio });
  var grupo = el('select', { 'data-field': 'group', onchange: cambio }, el('option', { value: 'base', text: T('comoTrabaja.grupoBase') }), el('option', { value: 'condicional', text: T('comoTrabaja.grupoCondicional') }));
  grupo.value = draft.group === 'base' ? 'base' : 'condicional';
  // «la condición escrita en el paquete» sólo existe para un revisor que ya la tiene; uno nuevo elige una bandera
  var cuando = el('select', { 'data-field': 'detection', onchange: cambio }, draft.whenWritten ? el('option', { value: '', text: T('comoTrabaja.condicionEscrita') }) : null);
  BANDERAS.forEach(function (b) { cuando.appendChild(el('option', { value: b[0], text: b[1] })); });
  cuando.value = draft.detection || (draft.whenWritten ? '' : 'codeModified');
  var rutas = el('textarea', { rows: '2', 'data-field': 'paths', oninput: cambio }); rutas.value = (draft.paths || []).join('\\n');
  var prefijo = el('input', { value: draft.prefix || '', 'data-field': 'prefix', oninput: cambio });
  var texto = el('textarea', { rows: '8', class: 'mono', 'data-field': 'instructions', oninput: cambio }); texto.value = draft.instructions || '';
  function borrador() { return { pack: draft.pack, original: draft.original, agent: nombre.value.trim(), group: grupo.value, detection: cuando.value, paths: rutas.value.split('\\n'), prefix: prefijo.value.trim(), instructions: texto.value }; }
  var revisar = el('button', { type: 'button', class: 'btn', 'data-action': 'check', text: T('comoTrabaja.revisar'), onclick: function () {
    pedir('/api/como-trabaja/revisar', { draft: borrador() }).then(function (r) {
      estado.textContent = '';
      if (r.ok) { if (!versiones && r.firma) versiones = { versions: r.versions, firma: r.firma }; proponer.removeAttribute('disabled'); estado.appendChild(el('p', { class: 'ct-ok', text: T('comoTrabaja.seLeeBien') })); }
      else (r.problems || [r.message]).forEach(function (p) { estado.appendChild(el('p', { class: 'ct-error', text: p })); });
    });
  } });
  proponer.onclick = function () {
    proponer.setAttribute('disabled', 'disabled');
    pedir('/api/como-trabaja/proponer', { draft: borrador(), versions: versiones ? versiones.versions : {}, firma: versiones ? versiones.firma : null }).then(function (r) {
      estado.textContent = '';
      if (r.ok) { var p = el('p', { class: 'ct-ok' }, document.createTextNode(T('comoTrabaja.propuesto', { enlace: '' }))); if (r.enlace) p.appendChild(el('a', { href: r.enlace, target: '_blank', rel: 'noopener', text: r.enlace })); estado.appendChild(p); }
      else estado.appendChild(el('p', { class: 'ct-error', text: r.codigo === 'cambio' ? T('comoTrabaja.cambioEnMain') : T('comoTrabaja.noSePudo', { motivo: (r.problems || [r.message]).join(' · ') }) }));
    });
  };
  var campo = function (clave, control) { return el('label', {}, el('span', { text: T(clave) }), control); };
  var panel = el('li', { class: 'ct-panel ct-editor' }, campo('comoTrabaja.campoNombre', nombre),
    el('div', { class: 'ct-dos' }, campo('comoTrabaja.campoGrupo', grupo), campo('comoTrabaja.campoCuando', cuando)),
    campo('comoTrabaja.campoRutas', rutas), campo('comoTrabaja.campoPrefijo', prefijo), campo('comoTrabaja.campoInstrucciones', texto), estado,
    el('div', { class: 'ct-pie' }, revisar, proponer, el('button', { type: 'button', class: 'btn', text: T('comoTrabaja.cerrar'), onclick: cerrarPaneles })));
  despuesDe(boton, panel); setTimeout(function () { nombre.focus(); }, 0);
}
raiz.addEventListener('click', function (ev) {
  var b = ev.target.closest('button[data-action]'); if (!b) return;
  var accion = b.getAttribute('data-action');
  if (accion !== 'improve' && accion !== 'edit' && accion !== 'add') return;
  var abierto = b.getAttribute('aria-expanded') === 'true';
  cerrarPaneles(); if (abierto) return;
  if (accion === 'improve') return cuadroMejora(b);
  if (accion === 'add') return editor(b, { pack: b.getAttribute('data-pack'), original: null, agent: '', group: 'condicional', detection: 'codeModified', paths: [], prefix: '', instructions: '---\\nname: \\ndescription: \\ntools: Read, Grep, Glob\\n---\\n\\n' });
  // si el revisor no se pudo abrir, se dice debajo de su renglón (nunca un clic que no hace nada)
  function noSeAbrio(motivo) { despuesDe(b, el('li', { class: 'ct-panel' }, el('p', { class: 'ct-error', text: T('comoTrabaja.noSePudo', { motivo: motivo }) }), el('div', { class: 'ct-pie' }, el('button', { type: 'button', class: 'btn', text: T('comoTrabaja.cerrar'), onclick: cerrarPaneles })))); }
  fetch('/api/como-trabaja/revisor?pack=' + encodeURIComponent(b.getAttribute('data-pack')) + '&agent=' + encodeURIComponent(b.getAttribute('data-agent')), { credentials: 'same-origin' })
    .then(function (r) { return r.json().catch(function () { return { message: String(r.status) }; }); })
    .then(function (r) { if (r && r.draft) editor(b, r.draft, { versions: r.versions, firma: r.firma }); else noSeAbrio((r && r.message) || '?'); }, function (e) { noSeAbrio(String(e && e.message || e)); });
});
})();
`;
}

// ── las rutas ──

/** Las rutas de la pestaña, para `rutasExtra` de crearSitio (como Configuración). */
function crearRutas({ cfg, fuentes, versionImagen = null, ahora = Date.now, fetch = globalThis.fetch, urlBase = {}, remotos = {}, log = () => {} }) {
  const solo = ['maintainer'];
  const publicRepo = publicRepoOf();
  if (!publicRepo) log('cómo trabaja: scripts/setup/public-remotes.json no se pudo leer: las piezas del arnés quedan sin enlace al repo público');
  const perfil = () => {
    const c = typeof fuentes.clones === 'function' ? fuentes.clones() : { perfil: null };
    if (!cfg.profileRepo && !(c && c.perfil)) return { dir: null, estado: 'no_configurado', motivo: null };
    if (!c || !c.perfil || !c.perfil.dir) return { dir: null, estado: c && c.perfil && c.perfil.estado === 'pendiente' ? 'bajando' : 'sin_leer', motivo: (c && c.perfil && c.perfil.motivo) || null };
    return { dir: c.perfil.dir, estado: 'leido', motivo: null };
  };
  const modelo = () => { const p = perfil(); return HIW().buildModel({ treeDir: TREE, profileDir: p.dir, profileState: p.estado, profileReason: p.motivo }); };
  const aplicarSolo = () => { const c = typeof fuentes.config === 'function' ? fuentes.config() : null; return Boolean(c && c.site && c.site.auto_apply === true); };
  function pagina(ctx) {
    const idioma = views.idiomaDe(ctx);
    const tok = ctx.sesion && typeof ctx.sesion.tok === 'string' ? ctx.sesion.tok : '';
    let cuerpo;
    try { cuerpo = renderPage(modelo(), { idioma, publicRepo, version: versionImagen }); } catch (e) {
      log(`cómo trabaja: el recorrido no se pudo armar (${String((e && e.message) || e).split('\n')[0]})`);
      cuerpo = `<p class="ct-error">${esc(TX.t(idioma, 'comoTrabaja.noSePudo', { motivo: String((e && e.message) || e).split('\n')[0] }))}</p>`;
    }
    const html = views.layout(ctx, TX.t(idioma, 'pestana.comoTrabaja'), cuerpo, TX.t(idioma, 'comoTrabaja.lede', { version: versionImagen || '' }));
    return html.replace('</head>', `<meta name="site-token" content="${tok.replace(/[^A-Za-z0-9_-]/g, '')}"><script src="/static/como-trabaja.js?l=${idioma}" defer></script></head>`);
  }
  async function revisar(ctx) {
    const w = await defensaDeEscritura(cfg, ctx);
    if (w.error) return w.error;
    const p = perfil();
    const r = reviewDraft({ profileDir: p.dir, draft: w.body && w.body.draft, idioma: views.idiomaDe(ctx) });
    if (!r.ok) return json(200, { ok: false, problems: r.problems });
    const v = await versionesDe(p.dir, r.files.map((f) => f.archivo));
    if (v.error) { log(`cómo trabaja: no pude leer las versiones del clon del perfil (${v.error})`); return json(200, { ok: false, problems: [TX.t(views.idiomaDe(ctx), 'comoTrabaja.err.clon', { motivo: v.error })] }); }
    return json(200, { ok: true, versions: v.versions, firma: firmaDe(ctx.sesion && ctx.sesion.tok, v.versions) });
  }
  async function proponer(ctx) {
    const w = await defensaDeEscritura(cfg, ctx);
    if (w.error) return w.error;
    const p = perfil();
    const body = w.body || {};
    const r = reviewDraft({ profileDir: p.dir, draft: body.draft, idioma: views.idiomaDe(ctx) });
    if (!r.ok) return json(200, { ok: false, problems: r.problems });
    const cred = cfg.escritura && cfg.escritura.perfil;
    if (!cred) return json(200, { ok: false, message: TX.t('es', 'config.sinIdentidad2') });
    const remote = remotos.perfil || ORG.remoteOf(cfg.profileRepo);
    if (!remote || !remote.platform) return json(200, { ok: false, message: TX.t('es', 'config.sinPlataforma') });
    // la versión de cada archivo es la del momento en que se abrió el editor, firmada por el servidor con el token de la
    // sesión: si main cambió desde entonces, RP.proponer lo dice. Una versión sin firma válida no se usa; para esos
    // archivos (y para uno que no estaba al abrir, como el .md de un revisor renombrado) vale la del clon de ahora
    const firmadas = firmaValida(ctx.sesion && ctx.sesion.tok, body.versions, body.firma) ? body.versions : {};
    const archivos = [];
    for (const f of r.files) {
      if (Object.prototype.hasOwnProperty.call(firmadas, f.archivo)) { archivos.push({ ...f, oidEsperado: firmadas[f.archivo] }); continue; }
      const o = await oidEnHead(p.dir, f.archivo);
      if (o.error) { log(`cómo trabaja: no pude leer la versión de ${f.archivo} en el clon del perfil (${o.error})`); return json(200, { ok: false, message: TX.t(views.idiomaDe(ctx), 'comoTrabaja.err.clon', { motivo: o.error }) }); }
      archivos.push({ ...f, oidEsperado: o.oid });
    }
    const res = await RP.proponer({
      clon: p.dir, archivos,
      // el nombre del paquete va adelante: el pedido abierto se busca por el comienzo de la rama, y «svelte» no puede
      // encontrar el de «svelte-fastapi»
      idCorto: `${r.pack}.reviewers`, secciones: [`${TX.t('es', 'pestana.comoTrabaja')}: ${r.pack}`], quien: ctx.sesion && ctx.sesion.email, credencial: cred, remote, urlBase,
      exclusivo: fuentes.exclusivo || ((fn) => fn()), now: new Date(ahora()), fetch, log, aplicarSolo: aplicarSolo(),
    });
    const { textoActual, ...sinTexto } = res || {};
    // aplicado solo: el clon del perfil se pone al día ya, como en Configuración, para que la página no muestre lo de antes
    if (sinTexto.codigo === 'aplicado' && typeof fuentes.refrescar === 'function') {
      try { await fuentes.refrescar(); } catch (e) { log(`cómo trabaja: después de aplicar ${r.pack}, el refresco falló (${(e && e.name) || 'error'}): se ve en el próximo`); }
    }
    return json(200, sinTexto);
  }
  return [
    { method: 'GET', path: '/como-trabaja', needs: solo, pestana: { id: 'comoTrabaja', titulo: 'Cómo trabaja', orden: 45 }, handler: (ctx) => ({ status: 200, tipo: 'text/html; charset=utf-8', cuerpo: pagina(ctx) }) },
    { method: 'GET', path: '/static/como-trabaja.js', needs: solo, handler: (ctx) => ({ status: 200, tipo: 'text/javascript; charset=utf-8', cuerpo: guion(['es', 'en'].includes(ctx.url && ctx.url.searchParams.get('l')) ? ctx.url.searchParams.get('l') : views.idiomaDe(ctx)) }) },
    { method: 'GET', path: '/api/como-trabaja/revisor', needs: solo, handler: async (ctx) => {
      const p = perfil();
      const pack = ctx.url && ctx.url.searchParams.get('pack'); const agent = ctx.url && ctx.url.searchParams.get('agent');
      if (!p.dir || !NAME_RE.test(pack || '') || !NAME_RE.test(agent || '')) return json(404, { ok: false, message: TX.t(views.idiomaDe(ctx), 'comoTrabaja.err.sinPaquete') });
      const d = draftOf(p.dir, pack, agent);
      if (d.error) { log(`cómo trabaja: el revisor ${pack}/${agent} no se pudo abrir (${d.error})`); return json(404, { ok: false, message: d.error }); }
      // las versiones de hoy de los dos archivos, firmadas: el aviso de «otro lo cambió» se mide desde que se abrió
      const v = await versionesDe(p.dir, [`packs/${pack}/pack.json`, d.md]);
      if (v.error) { log(`cómo trabaja: no pude leer las versiones del clon del perfil (${v.error})`); return json(404, { ok: false, message: TX.t(views.idiomaDe(ctx), 'comoTrabaja.err.clon', { motivo: v.error }) }); }
      return json(200, { draft: d.draft, versions: v.versions, firma: firmaDe(ctx.sesion && ctx.sesion.tok, v.versions) });
    } },
    { method: 'POST', path: '/api/como-trabaja/revisar', needs: solo, handler: revisar },
    { method: 'POST', path: '/api/como-trabaja/proponer', needs: solo, handler: proponer },
  ];
}

module.exports = { crearRutas, renderPage, issueUrl, buildIssueUrl, reviewDraft, draftOf, publicRepoOf, ISSUE_URL_MAX };
