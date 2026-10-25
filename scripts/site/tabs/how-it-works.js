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
  // `ancla`: la sección del archivo a la que salta el enlace
  const ver = (ruta, clave = 'comoTrabaja.verCodigo', ancla = null) => (publicRepo ? `<a class="btn" href="${esc(`${publicRepo}/blob/main/${ruta}${ancla ? `#${ancla}` : ''}`)}" target="_blank" rel="noopener">${esc(T(clave))}</a>` : '');
  // sin repo público, la mejora no tiene adónde ir: no se dibuja un botón que no hace nada
  const mejorar = (ruta, paso) => (!publicRepo ? '' : `<button type="button" class="btn" data-action="improve" data-piece="${esc(ruta)}" data-step-name="${esc(paso)}" aria-expanded="false">${esc(T('comoTrabaja.proponerMejora'))}</button>`);
  const pieza = ({ origin, nombre, mono = true, cuando, chips = [], acciones, ruta, archivo = '', extra = '' }) => `<li class="ct-pieza${extra}" data-origin="${origin}"${ruta ? ` data-piece="${esc(ruta)}"` : ''}><div class="ct-que"><span class="ct-nom${mono ? '' : ' sans'}">${esc(nombre)}</span>${chips.join('')}${cuando ? `<span class="ct-cuando">${esc(cuando)}</span>` : ''}${archivo ? `<span class="ct-archivo">${esc(archivo)}</span>` : ''}</div><div class="ct-acc">${acciones}</div></li>`;
  const delArnes = chip('arnes', T('comoTrabaja.delArnes'));
  const deLaOrg = chip('org', T('comoTrabaja.deTuOrganizacion'));
  // lo de una integración de la organización: sólo llega al modelo si no la tiene apagada
  const segunOrg = chip('segun', T('comoTrabaja.segunTuOrganizacionMarca'));
  // lo de la herramienta de horas que eligió la organización lleva su nombre (el `label` de su manifiesto); sin perfil no se
  // sabe cuál, y queda «según tu organización»
  const horas = model.org && model.org.timeToolLabel ? chip('horas', model.org.timeToolLabel) : null;
  const marcaDe = (x) => (x.timeTool && horas ? horas : x.integration || x.timeTool ? segunOrg : delArnes);
  // un control: su título es qué hace y el archivo va debajo; de una integración o del arnés; con su efecto (frena,
  // avisa, anota) y, si es opcional, además apagado de fábrica
  const control = (c, paso) => {
    const efecto = chip(TAG_EFECTO[c.effect][0], T(TAG_EFECTO[c.effect][1]));
    const apagado = c.optional ? chip('off', T('comoTrabaja.opcional', { variable: c.optional })) : '';
    // el de una integración dice qué hace desde su manifiesto; el del arnés, desde los textos del sitio, con el texto de
    // su momento si lo tiene (un mismo guion que avisa al abrir la sesión y frena al cerrar la respuesta)
    const nombre = c.control ? (c.control[idioma] || c.control.es) : T(TX.TEXTOS[`control.${c.spec}@${c.event}`] ? `control.${c.spec}@${c.event}` : `control.${c.spec}`);
    return { nombre, grupo: c.optional ? 'optional' : c.effect, html: pieza({ origin: 'harness', nombre, mono: false, cuando: T(`comoTrabaja.evento.${c.event}`), chips: [marcaDe(c), efecto, apagado], ruta: c.script, archivo: c.script, acciones: ver(c.script) + mejorar(c.script, paso), extra: c.optional ? ' apagada' : '' }) };
  };
  // un freno del cierre del paso: lo revisa marker.js al cerrar ese paso o, si es otro, lo dice
  const frenoDelCierre = (r, s, paso) => {
    const nombre = T(r.textKey);
    const cuando = r.checkedIn === s.id ? T('comoTrabaja.alCerrarElPaso') : T('comoTrabaja.alCerrarOtroPaso', { paso: nombrePaso({ id: r.checkedIn, name: r.checkedIn }) });
    return { nombre, grupo: 'blocks', html: pieza({ origin: 'harness', nombre, mono: false, cuando, chips: [delArnes, chip(TAG_EFECTO.blocks[0], T(TAG_EFECTO.blocks[1]))], ruta: r.code, archivo: r.code, acciones: ver(r.code) + mejorar(r.code, paso) }) };
  };
  // los controles agrupados por efecto («Frenan», «Avisan», «Anotan») y los opcionales al final; cada grupo por orden
  // alfabético y sin títulos de grupos vacíos
  const GRUPOS = [['blocks', 'comoTrabaja.grupoFrenan'], ['warns', 'comoTrabaja.grupoAvisan'], ['records', 'comoTrabaja.grupoAnotan'], ['optional', 'comoTrabaja.grupoOpcionales']];
  const agrupados = (items) => GRUPOS.map(([g, clave]) => {
    const deGrupo = items.filter((x) => x.grupo === g).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    return deGrupo.length ? `<p class="ct-grupo">${esc(T(clave))}</p><ul class="ct-lista">${deGrupo.map((x) => x.html).join('')}</ul>` : '';
  }).join('');

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
    franja = `<section class="ct-org card" aria-label="${esc(T('comoTrabaja.orgTitulo'))}"><h2>${esc(T('comoTrabaja.orgTitulo'))}</h2><div class="ct-fila"><b>${esc(T('comoTrabaja.orgIntegraciones'))}</b><span>${integ} <span class="ct-nota">${esc(T('comoTrabaja.orgIntegracionesAyuda'))} ${esc(T('comoTrabaja.telegramDeCadaMaquina'))}</span></span></div><div class="ct-fila"><b>${esc(T('comoTrabaja.orgPaquetes'))}</b><span>${esc(activos)}</span></div><div class="ct-fila"><b>${esc(T('comoTrabaja.orgReglas'))}</b><span>${esc(reglas)}</span></div>${problemas}</section>`;
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
  const porque = (r) => T('comoTrabaja.noEditableRoto', { motivo: enLlano(orgPacks.find((p) => p.name === r.pack))[0] || (r.notEditable && r.notEditable.detail) || '' });
  const pasos = model.steps.map((s) => {
    const paso = nombrePaso(s);
    const goal = (() => { try { return T(`paso.${s.id}.objetivo`); } catch { return s.goal; } })();
    const bloque = (titulo, cuerpo) => `<div class="ct-bloque"><h3>${esc(titulo)}</h3>${cuerpo}</div>`;
    // el primero es el archivo del paso mismo; las demás, las guías que cita
    const guias = `<ul class="ct-lista">${s.guides.map((g) => pieza({ origin: 'harness', nombre: g, ruta: g, acciones: ver(g) + mejorar(g, paso) })).join('')}</ul>${s.guides.length > 1 ? '' : `<p class="ct-vacio">${esc(T('comoTrabaja.sinGuias'))}</p>`}`;
    // las piezas de las integraciones de la organización que lleva el paso (sólo en los pasos que declaran alguna)
    const deLaOrgPiezas = !s.orgPiecesDeclared ? '' : bloque(T('comoTrabaja.segunTuOrganizacion'), s.orgPieces.length
      ? `<ul class="ct-lista">${s.orgPieces.map((x) => pieza({ origin: 'harness', nombre: T(x.textKey), mono: false, chips: [marcaDe(x)], ruta: x.code, archivo: x.code, acciones: ver(x.code, undefined, x.anchor) + mejorar(x.code, paso) })).join('')}</ul>`
      : `<p class="ct-vacio">${esc(T('comoTrabaja.sinPiezasOrg'))}</p>`);
    const segun = s.storyPieces.length ? `<ul class="ct-lista">${s.storyPieces.map((p) => pieza({ origin: 'harness', nombre: T(`${p.textKey}.pieza`), mono: false, cuando: T(p.textKey), chips: [delArnes], ruta: p.code, acciones: ver(p.code, undefined, p.anchor) + ver(p.guide, 'comoTrabaja.verGuia') + mejorar(p.code, paso) })).join('')}</ul>` : `<p class="ct-vacio">${esc(T('comoTrabaja.sinSegun'))}</p>`;
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
          ? (r.editable ? `<button type="button" class="btn" data-action="edit" data-pack="${esc(pack)}" data-agent="${esc(r.agent)}" data-use="${esc(r.use)}" aria-expanded="false">${esc(T('comoTrabaja.editar'))}</button>` : `<span class="ct-nota">${esc(porque(r))}</span>`)
          : ver(`packs/${pack}/${r.file.split('/').slice(1).join('/')}`) + mejorar(`packs/${pack}/pack.json`, paso);
        return pieza({ origin: r.origin, nombre: r.agent, cuando, chips, acciones, extra: r.active === false ? ' apagada' : '' });
      }).join('');
      const esOrg = rs[0].origin === 'organization';
      const agregar = esOrg && rs.some((r) => r.editable) && (s.id === 'reviewers') ? `<button type="button" class="btn mas" data-action="add" data-pack="${esc(pack)}">${esc(T('comoTrabaja.agregarRevisor'))}</button>` : '';
      rev += `<p class="ct-grupo">${esc(T('comoTrabaja.grupoPaquete', { paquete: pack }))}</p><ul class="ct-lista">${items2}</ul>${agregar}`;
    }
    if (s.id === 'reviewers') {
      for (const p of orgPacks.filter((x) => x.problems.length)) rev += `<p class="ct-error">${esc(T('comoTrabaja.paqueteRoto', { paquete: p.name, motivo: enLlano(p).join(' · ') }))}</p>`;
      if (model.org && !orgPacks.length) rev += `<p class="ct-vacio">${esc(T('comoTrabaja.sinRevisoresOrg'))}</p>`;
    }
    if (!rev) rev = `<p class="ct-vacio">${esc(T('comoTrabaja.sinRevisores'))}</p>`;
    const itemsDeControl = [...s.controls.map((c) => control(c, paso)), ...(s.closeChecks || []).map((r) => frenoDelCierre(r, s, paso))];
    const controles = itemsDeControl.length ? `<p class="ct-nota">${esc(T('comoTrabaja.leyendaControles'))}</p>${agrupados(itemsDeControl)}` : `<p class="ct-vacio">${esc(T('comoTrabaja.sinControles'))}</p>`;
    return `<section class="ct-paso card" id="paso-${esc(s.id)}" data-step="${esc(s.id)}" data-step-name="${esc(paso)}"><header><h2>${esc(paso)}</h2><p class="ct-goal">${esc(goal || '')}</p></header>${bloque(T('comoTrabaja.guias'), guias)}${deLaOrgPiezas}${bloque(T('comoTrabaja.segun'), segun)}${bloque(T('comoTrabaja.revisores'), rev)}${bloque(T('comoTrabaja.controles'), controles)}</section>`;
  }).join('');
  // «En todo el recorrido» es un paso más de la pantalla: el guion que esconde los pasos no elegidos la esconde a ella
  const todo = agrupados(model.allSteps.controls.map((c) => control(c, todoNombre)));
  const enTodo = `<section class="ct-paso card" id="paso-todo" data-step="todo" data-step-name="${esc(todoNombre)}"><header><h2>${esc(todoNombre)}</h2><p class="ct-goal">${esc(T('comoTrabaja.enTodoElRecorridoAyuda'))}</p></header><div class="ct-bloque"><h3>${esc(T('comoTrabaja.controles'))}</h3><p class="ct-nota">${esc(T('comoTrabaja.leyendaControles'))}</p>${todo}</div></section>`;
  // lo que no se pudo leer de las fuentes del arnés, arriba de todo: un paso o un control que falta no es «no hay»
  const ilegible = (model.problems || []).length ? `<section class="ct-org card ct-problemas"><h2>${esc(T('comoTrabaja.problemasArnes'))}</h2>${model.problems.map((p) => `<p class="ct-error">${esc(p)}</p>`).join('')}</section>` : '';
  return `<div class="ct" data-version="${esc(version || '')}" data-public-repo="${esc(publicRepo || '')}">${ilegible}${franja}${elegir}<div class="ct-cuerpo">${lista}<div class="ct-detalle">${pasos}${enTodo}<p class="ct-fuente">${esc(T('comoTrabaja.fuente'))}</p></div></div></div>`;
}

/**
 * Los controles del arnés que la página muestra con efectos distintos en distintos lugares (avisa en «Arrancar», frena
 * en otro paso) y a los que les falta el texto de algún momento: sin él, el texto general contradice a una etiqueta.
 * Devuelve `[{ spec, event, message }]`, uno por control y momento.
 */
function momentTextProblems(model) {
  const porControl = new Map();
  for (const c of [...model.steps.flatMap((s) => s.controls), ...model.allSteps.controls].filter((x) => !x.control)) {
    if (!porControl.has(c.spec)) porControl.set(c.spec, []);
    porControl.get(c.spec).push(c);
  }
  const out = [];
  for (const [spec, cs] of porControl) {
    if (new Set(cs.map((c) => c.effect)).size < 2) continue;
    for (const event of [...new Set(cs.map((c) => c.event))]) {
      const clave = `control.${spec}@${event}`;
      const faltan = TX.IDIOMAS.filter((i) => !(TX.TEXTOS[clave] && TX.TEXTOS[clave][i]));
      if (faltan.length) out.push({ spec, event, message: `${spec} frena en un lugar y avisa o anota en otro: falta el texto ${clave} (${faltan.join(', ')}) en scripts/site/texts.js` });
    }
  }
  return out;
}

// ── el revisor propio: revisar con el lector del pipeline ──

/** La cabecera y el cuerpo de un `.md`, sin el BOM que agregan algunos editores: `[bloque, cuerpo]`, o null sin cabecera. */
function partesDe(texto) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(texto || '').replace(/^﻿/, ''));
  return m ? [m[1], m[2]] : null;
}

/**
 * Las claves de primer nivel de una cabecera, en orden, cada una con sus renglones: el suyo y los que la siguen sin ser
 * otra clave (un valor de varios renglones, una lista). Los renglones antes de la primera clave van con `clave: null`.
 */
function entradasDe(bloque) {
  const out = [];
  for (const l of bloque.split(/\r?\n/)) {
    const k = /^([A-Za-z_][\w-]*):(.*)$/.exec(l);
    if (k) out.push({ clave: k[1], crudo: k[2].trim(), renglones: [l], siguen: [] });
    // un renglón sin sangría que no sigue una lista es otra clave (una que este lector no reconoce) o un comentario:
    // va solo, como estaba
    else if (/^[^\s-]/.test(l)) out.push({ clave: /^#/.test(l) ? null : '?', crudo: '', renglones: [l], siguen: [] });
    else if (out.length) { out[out.length - 1].renglones.push(l); out[out.length - 1].siguen.push(l); }
    else out.push({ clave: null, crudo: '', renglones: [l], siguen: [] });
  }
  return out;
}

/** Un valor sin sus comillas, como lo lee YAML: `\"` y `\\` entre dobles, `''` entre simples; sin ellas, sin el comentario. */
function sinComillas(s) {
  const d = /^"((?:[^"\\]|\\[\s\S])*)"(?:\s+#.*)?$/.exec(s);
  if (d) return d[1].replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' }[c] || c));
  const q = /^'((?:[^']|'')*)'(?:\s+#.*)?$/.exec(s);
  if (q) return q[1].replace(/''/g, "'");
  return s.replace(/\s+#.*$/, '');
}

/**
 * El valor de una entrada: un bloque (`>` junta los renglones con un espacio, `|` con un fin de renglón), una lista
 * (`- x` debajo, o `[x, y]`) como arreglo, y un valor que sigue en el renglón de abajo, junto.
 */
function valorDe(e) {
  if (/^[|>][+-]?\d*$/.test(e.crudo)) return e.siguen.filter((l) => l.trim()).map((l) => l.trim()).join(e.crudo[0] === '>' ? ' ' : '\n');
  // fuera de un bloque, un renglón que empieza con «#» es un comentario, no parte del valor
  const mas = e.siguen.filter((l) => l.trim() && !/^\s*#/.test(l));
  if (!e.crudo && mas.length && mas.every((l) => /^\s*-(\s|$)/.test(l))) return mas.map((l) => sinComillas(l.replace(/^\s*-\s*/, '').trim())).filter(Boolean);
  if (/^\[[\s\S]*\]$/.test(e.crudo) && !mas.length) return e.crudo.slice(1, -1).split(',').map((x) => sinComillas(x.trim())).filter(Boolean);
  return sinComillas([e.crudo, ...mas.map((l) => l.trim())].filter(Boolean).join(' '));
}

/** La cabecera (frontmatter) de un agente: sus claves de primer nivel como texto (una lista, separada por comas). */
function cabeceraDe(texto) {
  const p = partesDe(texto);
  if (!p) return null;
  const claves = {};
  for (const e of entradasDe(p[0])) if (e.clave && e.clave !== '?') { const v = valorDe(e); claves[e.clave] = Array.isArray(v) ? v.join(', ') : v; }
  return { claves, cuerpo: p[1] };
}

// ── la cabecera en campos ──

/** Las herramientas que el editor ofrece como casillas, en este orden; cada una con su explicación en texts.js. */
const HERRAMIENTAS = ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch'];
const MODELOS = () => require(path.join(TREE, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'models.js'));
const TEAM_REPOS = () => require(path.join(TREE, 'scripts', 'lib', 'team-repos.js'));

/**
 * El techo de modelos de la organización, leído como lo lee el pipeline (lib/models.js): `{ techo, problema }`. Sin
 * techo, `techo` es null; si la configuración no se pudo leer, `problema` lo dice (no es «sin techo»).
 */
function techoDe(profileDir) {
  const M = MODELOS();
  const r = M.readOrgModels({ dir: profileDir, teamRepos: TEAM_REPOS() });
  return { techo: r && r.data ? M.ceilingOf(r.data) : null, problema: (r && r.problem) || null };
}

/** El aviso del selector de modelo cuando no se sabe el techo (la configuración no se pudo leer); null si se sabe. */
function avisoDeModelos(profileDir, idioma = 'es') {
  const { problema } = techoDe(profileDir);
  return problema ? TX.t(idioma, 'comoTrabaja.techoDesconocido', { motivo: HIW().withoutAbsolutePaths(problema, [profileDir, TREE]) }) : null;
}

/**
 * Las opciones del selector de modelo: «el que use la organización» (`''`) y los niveles neutros, en orden; los que
 * pasan el techo de la organización, apagados con su motivo (en el idioma de la página).
 */
function modelosDe(profileDir, idioma = 'es') {
  const M = MODELOS();
  const { techo } = techoDe(profileDir);
  const tope = techo ? M.rank(techo) : Infinity;
  return [{ valor: '', apagado: false, motivo: null }, ...M.LEVELS.map((nivel) => {
    const apagado = M.rank(M.modelOf(nivel)) > tope;
    return { valor: nivel, apagado, motivo: apagado ? TX.t(idioma, 'comoTrabaja.pasaElTecho', { techo: M.levelOf(techo) }) : null };
  })];
}

/**
 * La cabecera de un `.md` de revisor en campos: nombre, descripción, modelo (su nivel; uno que no se traduce, tal
 * cual, con `modeloTalCual`), las herramientas de las casillas y las demás (que se conservan), y las otras claves de la
 * cabecera como renglones (`otras`), que el editor no muestra y viajan igual.
 */
function camposDe(texto) {
  const p = partesDe(texto);
  const cab = cabeceraDe(texto) || { claves: {}, cuerpo: String(texto || '') };
  const tools = String(cab.claves.tools || '').split(',').map((t) => t.trim()).filter(Boolean);
  const crudo = cab.claves.model || '';
  const nivel = crudo ? MODELOS().levelOf(crudo) : '';
  const propias = new Set(['name', 'description', 'tools', 'model']);
  return {
    cabecera: {
      nombre: cab.claves.name || '', descripcion: cab.claves.description || '',
      modelo: nivel || crudo, modeloTalCual: Boolean(crudo && !nivel),
      herramientas: HERRAMIENTAS.filter((h) => tools.includes(h)), otrasHerramientas: tools.filter((t) => !HERRAMIENTAS.includes(t)),
      // cada clave con todos sus renglones: uno de una lista o de un bloque no queda colgando debajo de otra
      otras: (p ? entradasDe(p[0]) : []).filter((e) => !propias.has(e.clave)).flatMap((e) => e.renglones).filter((l) => l.trim()),
    },
    // el cuerpo sin el renglón en blanco que separa la cabecera
    cuerpo: p ? p[1].replace(/^\r?\n/, '') : String(texto || ''),
  };
}

/**
 * Un texto en un solo renglón: cualquier fin de renglón (\n, \r, NEL, los separadores de Unicode) partiría la cabecera
 * y metería otra clave. Se parte y se junta con un espacio (sin una expresión que recorra los espacios de cada lado,
 * que con un texto largo de espacios tarda el cuadrado).
 */
function unRenglon(v) {
  return String(v == null ? '' : v).split(/[\r\n\u0085\u2028\u2029]+/).map((x) => x.trim()).filter(Boolean).join(' ');
}

/** Un valor de la cabecera: entre comillas dobles sólo si sin ellas no se leería igual (un «: », un «#», comillas…). */
function valorDeCabecera(v) {
  const s = unRenglon(v);
  // también lo que YAML leería como otra cosa: un «:» al final, un nulo, un sí/no o un número
  const otraCosa = /:(\s|$)|\s#|^[\s\-?:,[\]{}#&*!|>'"%@`]|\s$/.test(s) || /^(null|~|true|false|yes|no|on|off|y|n)$/i.test(s) || /^[+-]?(\d|\.\d|\.(inf|nan)$)/i.test(s);
  return otraCosa ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : s;
}

/**
 * El `.md` de un revisor armado con sus campos y su cuerpo. El nivel se guarda como el nombre que entiende quien corre
 * el revisor (`modelOf` de lib/models.js); un modelo que no se traduce va tal cual; sin modelo, sin la clave (el que
 * use la organización). Las otras claves de la cabecera van al final, como estaban.
 */
function armarAgente(cabecera, cuerpo) {
  const c = cabecera || {};
  // una herramienta leída del archivo puede traer un fin de renglón (entre comillas, en un bloque): va en uno solo
  const tools = [...HERRAMIENTAS.filter((h) => (c.herramientas || []).includes(h)), ...(c.otrasHerramientas || []).map((t) => unRenglon(t)).filter(Boolean)];
  const modelo = c.modelo ? (MODELOS().modelOf(c.modelo) || c.modelo) : '';
  const renglones = [`name: ${valorDeCabecera(c.nombre)}`, `description: ${valorDeCabecera(c.descripcion)}`, `tools: ${tools.join(', ')}`];
  if (modelo) renglones.push(`model: ${valorDeCabecera(modelo)}`);
  return `---\n${[...renglones, ...(c.otras || [])].join('\n')}\n---\n\n${String(cuerpo || '')}`;
}

/** Los problemas de la cabecera en campos, en el idioma de la página: nombre, herramientas y el techo del modelo. */
function problemasDeCabecera(c, { agente, profileDir, idioma }) {
  const E = (k, v) => TX.t(idioma, `comoTrabaja.err.${k}`, v);
  const out = [];
  if (NAME_RE.test(agente) && c.nombre !== agente) out.push(E('nombre', { revisor: agente }));
  if (!String(c.descripcion || '').trim()) out.push(E('falta', { clave: 'description' }));
  if (!(c.herramientas || []).length && !(c.otrasHerramientas || []).length) out.push(E('sinHerramientas'));
  if (c.modelo && !c.modeloTalCual) out.push(...problemasDeModelo(c.modelo, { profileDir, idioma }));
  return out;
}

/** Los problemas de un nivel de modelo elegido: que no sea un nivel, que pase el techo, o que el techo no se sepa. */
function problemasDeModelo(modelo, { profileDir, idioma }) {
  const op = modelosDe(profileDir, idioma).find((m) => m.valor === modelo);
  const aviso = avisoDeModelos(profileDir, idioma);
  if (!op) return [TX.t(idioma, 'comoTrabaja.err.modelo', { modelo })];
  if (op.apagado) return [op.motivo];
  // sin saber el techo no se puede asegurar que el modelo elegido no lo pase: vale «el que use la organización»
  return aviso ? [aviso] : [];
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
  if (typeof draft.depth === 'string' && draft.depth) e.depth = draft.depth;
  return e;
}

/**
 * El uso que valida la historia con lo que cambió el borrador: cuándo entra, el modelo y lo que le pide. El nivel se
 * guarda como el nombre que entiende quien corre el revisor (`modelOf`); un modelo que no se traduce y no se tocó, tal
 * cual; sin modelo, sin la clave (el que use la organización). Lo que le pide, vacío, queda vacío: lo dice el validador.
 * El resto de la entrada (el código de sus hallazgos, la nota) viaja igual.
 */
function entradaValidacion(uso, original, agente) {
  const e = JSON.parse(JSON.stringify(original));
  e.agent = agente;
  if (typeof uso.detection === 'string' && uso.detection) e.when = { detection: uso.detection };
  const crudo = typeof original.model === 'string' ? original.model : '';
  const modelo = typeof uso.modelo === 'string' ? uso.modelo : '';
  if (!modelo) delete e.model;
  else if (modelo === crudo) e.model = crudo;
  else e.model = MODELOS().modelOf(modelo) || modelo;
  e.prompt = typeof uso.prompt === 'string' && uso.prompt.trim() ? uso.prompt : '';
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
  // los usos de hoy del revisor (sus entradas en reviewers[]), en el orden del manifiesto
  const originales = draft.original ? json.reviewers.filter((r) => r && r.agent === draft.original) : [];
  if (draft.original && !originales.length) return { ok: false, problems: [E('yaNoEsta', { revisor: draft.original })], files: [] };
  // el editor manda un uso por cada uno de hoy; un borrador sin `uses` (un revisor nuevo) trae los campos de su único uso
  const usos = Array.isArray(draft.uses) ? draft.uses : [{ group: draft.group, detection: draft.detection, paths: draft.paths, prefix: draft.prefix, depth: draft.depth }];
  // los usos no se suman ni se quitan desde el sitio, ni uno pasa de un paso al otro: se pide a mano
  if (usos.length !== Math.max(originales.length, 1) || usos.some((u) => !u || typeof u !== 'object')) return { ok: false, problems: [E('usos')], files: [] };
  // un nombre nuevo (renombrar o un revisor nuevo) que ya usa otro revisor del paquete: pisaría sus instrucciones
  if (agente !== draft.original && json.reviewers.some((r) => r && r.agent === agente && !originales.includes(r))) return { ok: false, problems: [E('nombreEnUso', { revisor: agente })], files: [] };
  // un uso que cambia de paso se rechaza y su entrada queda como estaba (uno nuevo, sin entrada)
  const entradas = usos.map((u, i) => {
    const original = originales[i] || null;
    const valida = Boolean(original && original.group === 'validacion');
    if ((u.group === 'validacion') !== valida) { problems.push(E('usoCambiado')); return original; }
    if (!(typeof u.detection === 'string' && u.detection) && !(original && original.when)) problems.push(E('condicion'));
    if (valida) {
      const e = entradaValidacion(u, original, agente);
      if (u.modelo && e.model !== original.model) problems.push(...problemasDeModelo(u.modelo, { profileDir, idioma }));
      return e;
    }
    if (!['base', 'condicional'].includes(u.group)) problems.push(E('grupo'));
    if (u.depth != null && u.depth !== '' && !PACKS().VOCABULARIO.profundidades.includes(u.depth)) problems.push(E('profundidad'));
    return entradaDe({ ...u, agent: agente }, original);
  });
  let k = 0;
  const nuevo = { ...json, reviewers: originales.length ? json.reviewers.map((r) => (originales.includes(r) ? entradas[k++] : r)) : [...json.reviewers, ...entradas.filter(Boolean)] };
  // la cabecera y el cuerpo del agente. El editor los manda en campos; un borrador con el .md entero (el de antes del
  // editor en campos) se pasa a campos y sigue el mismo camino: así nada entra a la cabecera sin los mismos controles
  let nombreEscrito = agente;
  if (!(draft.cabecera && typeof draft.cabecera === 'object')) {
    if (!cabeceraDe(draft.instructions)) problems.push(E('cabecera'));
    const partes = camposDe(draft.instructions);
    nombreEscrito = partes.cabecera.nombre;
    draft = { ...draft, cabecera: partes.cabecera, cuerpo: partes.cuerpo };
  }
  {
    // lo que el editor no deja cambiar sale del archivo de hoy, nunca del navegador: las otras claves de la cabecera,
    // las herramientas que no están en las casillas y el modelo que se conserva tal cual. Un revisor nuevo no trae nada
    const hoy = draft.original ? draftOf(profileDir, draft.pack, draft.original) : null;
    const actual = hoy && hoy.draft ? hoy.draft.cabecera : { otras: [], otrasHerramientas: [], modelo: '', modeloTalCual: false };
    const c = {
      nombre: nombreEscrito, descripcion: String(draft.cabecera.descripcion || ''), modelo: String(draft.cabecera.modelo || ''),
      herramientas: Array.isArray(draft.cabecera.herramientas) ? draft.cabecera.herramientas.filter((h) => HERRAMIENTAS.includes(h)) : [],
      otrasHerramientas: actual.otrasHerramientas, otras: actual.otras,
      modeloTalCual: Boolean(actual.modeloTalCual && draft.cabecera.modelo === actual.modelo),
    };
    problems.push(...problemasDeCabecera(c, { agente, profileDir, idioma }));
    if (!String(draft.cuerpo || '').trim()) problems.push(E('vacias'));
    draft = { ...draft, instructions: armarAgente({ ...c, nombre: agente }, draft.cuerpo) };
  }
  // el validador del pipeline, sobre una copia del paquete con el borrador puesto; el .md va en la carpeta de agentes
  // del paquete, la única que acepta el validador
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'how-it-works-pack-'));
  try {
    const copia = path.join(tmp, draft.pack);
    // agents/ del perfil, copiada aparte, como al instalar: un revisor que también está ahí se dice
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
      if (NAME_RE.test(agente)) { fs.mkdirSync(path.join(copia, carpetaAgentes), { recursive: true }); escribir(path.join(copia, carpetaAgentes, `${agente}.md`), String(draft.instructions || '')); }
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
    { archivo: `packs/${draft.pack}/${carpetaAgentes}/${agente}.md`, contenido: String(draft.instructions || '') },
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
/** La versión de un archivo como la daría git, leída del propio archivo (el sitio demo no tiene git): `{ oid }`, null si no está. */
function oidDeArchivo(dir, archivo) {
  return new Promise((resolve) => {
    fs.readFile(path.join(dir, archivo), 'utf8', (err, texto) => {
      if (!err) return resolve({ oid: ORG.versionDeTexto(texto, 40) });
      resolve(err.code === 'ENOENT' ? { oid: null } : { error: String(err.code || err.message).slice(0, 200) });
    });
  });
}
async function versionesDe(dir, archivos, oidDe = oidEnHead) {
  const versions = {};
  for (const a of archivos) {
    const r = await oidDe(dir, a);
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
  // el .md vive en la carpeta de agentes de su paquete
  const relMd = HIW().agentFileOf({ pack, json, agent });
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
  // la cabecera en campos y el cuerpo aparte (el editor); sin .md, el revisor arranca con su nombre
  const { cabecera, cuerpo } = camposDe(instructions);
  if (!cabecera.nombre) cabecera.nombre = agent;
  // cada uso del revisor (una entrada de reviewers[] con su nombre), en el orden del manifiesto
  const uses = json.reviewers.filter((x) => x && x.agent === agent).map(usoDe);
  return { md: relMd, draft: { pack, original: agent, agent, uses, cabecera, cuerpo } };
}

/**
 * Un uso del revisor para el editor. Los dos llevan cuándo entra (`detection`, o `whenWritten` con la condición propia
 * en `whenText`, que se muestra y no se edita) y el código de sus hallazgos; «revisa el cambio», además, los archivos
 * que mira y la profundidad; «valida la historia», su modelo (como nivel; uno que no se traduce, tal cual) y lo que le
 * pide.
 */
function usoDe(r) {
  const simple = r.when && typeof r.when.detection === 'string' && Object.keys(r.when).length === 1;
  const comun = { group: r.group, detection: simple ? r.when.detection : '', whenWritten: Boolean(r.when && !simple), whenText: r.when && !simple ? JSON.stringify(r.when, null, 2) : '' };
  if (r.group === 'validacion') {
    const crudo = typeof r.model === 'string' ? r.model : '';
    const nivel = crudo ? MODELOS().levelOf(crudo) : '';
    return { ...comun, modelo: nivel || crudo, modeloTalCual: Boolean(crudo && !nivel), prompt: typeof r.prompt === 'string' ? r.prompt : '', prefix: (r.prefixes || [])[0] || '' };
  }
  return { ...comun, paths: (r.surface && r.surface.paths) || [], always: Boolean(r.surface && r.surface.always === true), prefix: (r.prefixes || [])[0] || '', depth: r.depth || '' };
}

// ── el guion del navegador ──

/** Los textos que usa el guion del navegador, en el idioma de la página. */
function textosDelGuion(idioma) {
  // y los nombres de los niveles de modelo, los mismos de Configuración
  const claves = Object.keys(TX.TEXTOS).filter((k) => k.startsWith('comoTrabaja.') || k.startsWith('pantalla.nivel.'));
  return Object.fromEntries(claves.map((k) => [k, TX.t(idioma, k)]));
}

/** El guion de la pestaña: elegir un paso, el cuadro de la mejora y el editor del revisor propio. Sin nada en línea. */
function guion(idioma) {
  const banderas = PACKS().BANDERAS.map((b) => [b, (() => { try { return TX.t(idioma, `bandera.${b}`); } catch { return b; } })()]);
  return `'use strict';
(function () {
var TXT = ${JSON.stringify(textosDelGuion(idioma))};
var BANDERAS = ${JSON.stringify(banderas)};
var HERRAMIENTAS = ${JSON.stringify(HERRAMIENTAS)};
var PROFUNDIDADES = ${JSON.stringify(PACKS().VOCABULARIO.profundidades)};
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
  // el cuadro no va adentro de un <label>: el editor le agrega botones, y un clic en la vista previa activaría el primero
  // (el nombre del cuadro lo da su aria-label)
  var panel = el('li', { class: 'ct-panel' }, el('div', { class: 'ct-campo' }, el('span', { text: T('comoTrabaja.mejoraQue') }), ta), el('p', { class: 'ct-nota', text: T('comoTrabaja.mejoraNota') }), aviso,
    el('div', { class: 'ct-pie' }, ir, el('button', { type: 'button', class: 'btn', text: T('comoTrabaja.cerrar'), onclick: cerrarPaneles })));
  despuesDe(boton, panel);
  // el editor de texto largo del sitio: con vista previa (el issue se lee así) y sin «Ver qué cambió», que no tiene original
  if (window.LongTextEditor) window.LongTextEditor.montar(ta, { vistaPrevia: true, queCambio: false, alCambiar: act, textos: textosLargo() });
  setTimeout(function () { ta.focus(); }, 0);
}
// los textos del editor de texto largo, en el idioma de la página
function textosLargo() {
  return { escribir: T('comoTrabaja.lte.escribir'), vistaPrevia: T('comoTrabaja.lte.vistaPrevia'), buscar: T('comoTrabaja.lte.buscar'), buscarQue: T('comoTrabaja.lte.buscarQue'),
    siguiente: T('comoTrabaja.lte.siguiente'), unaVez: T('comoTrabaja.lte.unaVez'), vecesN: T('comoTrabaja.lte.vecesN'), queCambio: T('comoTrabaja.lte.queCambio'),
    sinCambios: T('comoTrabaja.lte.sinCambios'), ampliar: T('comoTrabaja.lte.ampliar'), volver: T('comoTrabaja.lte.volver') };
}
function pedir(ruta, cuerpo) {
  return fetch(ruta, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-site-token': token }, body: JSON.stringify(cuerpo) })
    .then(function (r) { return r.json().catch(function () { return { ok: false, message: String(r.status) }; }); }, function (e) { return { ok: false, message: String(e && e.message || e) }; });
}
// el editor de un revisor del perfil
// firmadas: las versiones de los archivos cuando se abrió el editor, firmadas por el servidor ({ versions, firma }); un
// revisor nuevo las toma de la primera revisión. No se pisan: el aviso de «otro lo cambió» se mide desde la apertura
function editor(boton, draft, firmadas, modelos) {
  var versiones = firmadas && firmadas.firma ? firmadas : null;
  var cab = draft.cabecera || {};
  var estado = el('div', { class: 'ct-estado', 'aria-live': 'polite' });
  var motivo = el('p', { class: 'ct-nota ct-motivo', 'data-motivo': 'antes', text: T('comoTrabaja.motivoAntesDeRevisar') });
  var proponer = el('button', { type: 'button', class: 'btn prim', disabled: 'disabled', 'data-action': 'propose', text: T('comoTrabaja.proponer') });
  var revisado = false;
  // cualquier cambio apaga «Proponer»; si ya se había revisado, la línea pide volver a revisar
  function cambio() {
    proponer.setAttribute('disabled', 'disabled'); estado.textContent = '';
    if (revisado) { revisado = false; motivo.textContent = T('comoTrabaja.motivoCambiaste'); motivo.setAttribute('data-motivo', 'cambiaste'); }
  }
  var nombre = el('input', { value: draft.agent, 'data-field': 'agent', 'aria-label': T('comoTrabaja.campoNombre'), oninput: cambio });
  // un selector de modelo: el de la organización o un nivel; los que pasan el techo, apagados con su motivo; uno que no
  // se traduce a un nivel se muestra y se conserva tal cual
  function selectorDeModelo(valor, talCual, campo, etiqueta) {
    var s = el('select', { 'data-field': campo, 'aria-label': etiqueta, onchange: cambio });
    (modelos || [{ valor: '' }]).forEach(function (m) {
      var texto = m.valor ? T('pantalla.nivel.' + m.valor) : T('comoTrabaja.modeloDeLaOrganizacion');
      s.appendChild(el('option', { value: m.valor, disabled: m.apagado ? 'disabled' : null, title: m.motivo || null, text: m.apagado ? texto + ' — ' + m.motivo : texto }));
    });
    if (talCual) s.appendChild(el('option', { value: valor, text: T('comoTrabaja.modeloTalCual', { modelo: valor }) }));
    s.value = valor || '';
    return s;
  }
  var modelo = selectorDeModelo(cab.modelo, cab.modeloTalCual, 'model', T('comoTrabaja.campoModelo'));
  // las herramientas: una casilla por cada una, con su explicación; las que no están en la lista, como etiquetas
  var casillas = el('div', { class: 'ct-herramientas' });
  HERRAMIENTAS.forEach(function (h) {
    var c = el('input', { type: 'checkbox', value: h, 'data-tool': h, onchange: cambio });
    c.checked = (cab.herramientas || []).indexOf(h) >= 0;
    casillas.appendChild(el('label', { class: 'ct-casilla' }, c, el('b', { text: h }), el('span', { text: T('comoTrabaja.herramienta.' + h) })));
  });
  var otras = (cab.otrasHerramientas || []).length ? el('div', { class: 'ct-etiquetas' }) : null;
  (cab.otrasHerramientas || []).forEach(function (h) { otras.appendChild(el('span', { class: 'ct-etiqueta', text: h })); });
  var descripcion = el('input', { value: cab.descripcion || '', 'data-field': 'description', 'aria-label': T('comoTrabaja.campoDescripcion'), oninput: cambio });
  var texto = el('textarea', { rows: '8', class: 'mono', 'data-field': 'instructions', 'aria-label': T('comoTrabaja.susInstrucciones') }); texto.value = draft.cuerpo || '';
  var campo = function (clave, control) { return el('label', {}, el('span', { text: T(clave) }), control); };
  // los archivos que mira, como etiquetas: se agrega uno escribiéndolo y con Enter; se quita con la x
  function etiquetas(valores) {
    var lista = (valores || []).slice();
    var caja = el('div', { class: 'ct-etiquetas ct-rutas' });
    var entrada = el('input', { 'data-field': 'paths', 'aria-label': T('comoTrabaja.campoRutas'), placeholder: '**/*.cs' });
    function dibujar() {
      caja.querySelectorAll('.ct-etiqueta').forEach(function (x) { x.remove(); });
      lista.forEach(function (r, i) {
        caja.insertBefore(el('span', { class: 'ct-etiqueta' }, document.createTextNode(r), el('button', { type: 'button', class: 'ct-x', 'aria-label': T('comoTrabaja.quitarRuta', { ruta: r }), text: '×', onclick: function () { lista.splice(i, 1); dibujar(); cambio(); } })), entrada);
      });
    }
    entrada.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      var v = entrada.value.trim();
      if (v && lista.indexOf(v) < 0) { lista.push(v); dibujar(); cambio(); }
      entrada.value = '';
    });
    // escribir una ruta ya cambia el borrador (cuenta aunque no se apriete Enter): apaga «Proponer» como cualquier campo
    entrada.addEventListener('input', cambio);
    caja.appendChild(entrada); dibujar();
    // lo escrito y sin Enter también cuenta: nadie pierde una ruta por no apretarlo
    return { caja: caja, valores: function () { var v = entrada.value.trim(); return v && lista.indexOf(v) < 0 ? lista.concat([v]) : lista.slice(); } };
  }
  // una solapa por uso del revisor; «Editar» abre la del uso de su renglón. Un revisor nuevo trae su único uso suelto
  var usos = draft.uses || [{ group: draft.group || 'condicional', detection: draft.detection || '', paths: draft.paths || [], prefix: draft.prefix || '', depth: draft.depth || 'lean' }];
  var leerUsos = [];
  var solapas = el('div', { class: 'ct-solapas', role: 'tablist', 'aria-label': T('comoTrabaja.usosAyuda') });
  var paneles = el('div', { class: 'ct-usos' });
  function elegir(i) {
    Array.prototype.forEach.call(solapas.children, function (s, j) { s.setAttribute('aria-selected', j === i ? 'true' : 'false'); });
    Array.prototype.forEach.call(paneles.children, function (p, j) { p.hidden = j !== i; });
  }
  usos.forEach(function (u, i) {
    var valida = u.group === 'validacion';
    solapas.appendChild(el('button', { type: 'button', role: 'tab', class: 'ct-solapa', 'data-use': valida ? 'validacion' : 'cambio', 'aria-selected': 'false', text: T(valida ? 'comoTrabaja.usoValidacion' : 'comoTrabaja.usoCambio'), onclick: function () { elegir(i); } }));
    // cuándo entra: una bandera, o la condición propia del paquete, que se muestra y viaja tal cual
    var cuando = el('select', { 'data-field': 'detection', onchange: cambio }, u.whenWritten ? el('option', { value: '', text: T('comoTrabaja.condicionPropia') }) : null);
    BANDERAS.forEach(function (b) { cuando.appendChild(el('option', { value: b[0], text: b[1] })); });
    cuando.value = u.detection || (u.whenWritten ? '' : 'codeModified');
    var propia = u.whenWritten ? el('details', { class: 'ct-propia' }, el('summary', { text: T('comoTrabaja.verComoEsta') }), el('pre', { class: 'mono', text: u.whenText || '' })) : null;
    var panel = el('div', { class: 'ct-uso', role: 'tabpanel' });
    if (valida) {
      var modeloV = selectorDeModelo(u.modelo, u.modeloTalCual, 'validation-model', T('comoTrabaja.campoModeloValidacion'));
      var pide = el('textarea', { rows: '4', class: 'mono', 'data-field': 'prompt', 'aria-label': T('comoTrabaja.campoPrompt'), oninput: cambio }); pide.value = u.prompt || '';
      panel.appendChild(campo('comoTrabaja.campoEntraCuando', cuando)); if (propia) panel.appendChild(propia);
      panel.appendChild(campo('comoTrabaja.campoModeloValidacion', modeloV));
      panel.appendChild(campo('comoTrabaja.campoPrompt', pide));
      panel.appendChild(el('p', { class: 'ct-nota', text: T('comoTrabaja.promptAyuda') }));
      leerUsos.push(function () { return { group: 'validacion', detection: cuando.value, modelo: modeloV.value, prompt: pide.value }; });
    } else {
      var grupo = el('select', { 'data-field': 'group', onchange: cambio }, el('option', { value: 'base', text: T('comoTrabaja.grupoBase') }), el('option', { value: 'condicional', text: T('comoTrabaja.grupoCondicional') }));
      grupo.value = u.group === 'base' ? 'base' : 'condicional';
      var rutas = etiquetas(u.paths);
      var prefijo = el('input', { value: u.prefix || '', 'data-field': 'prefix', 'aria-label': T('comoTrabaja.campoPrefijo') });
      var ejemplo = el('p', { class: 'ct-nota' });
      var verEjemplo = function () { ejemplo.textContent = T('comoTrabaja.prefijoEjemplo', { prefijo: prefijo.value.trim() || 'XPAT' }); };
      prefijo.addEventListener('input', function () { verEjemplo(); cambio(); }); verEjemplo();
      var prof = el('select', { 'data-field': 'depth', onchange: cambio });
      PROFUNDIDADES.forEach(function (p) { prof.appendChild(el('option', { value: p, text: T('comoTrabaja.profundidad.' + p) })); });
      prof.value = u.depth || 'lean';
      panel.appendChild(el('div', { class: 'ct-dos' }, campo('comoTrabaja.campoEntra', grupo), campo('comoTrabaja.campoCuando', cuando))); if (propia) panel.appendChild(propia);
      panel.appendChild(el('div', { class: 'ct-campo' }, el('span', { text: T('comoTrabaja.campoRutas') }), rutas.caja, el('p', { class: 'ct-nota', text: T('comoTrabaja.rutasAyuda') })));
      panel.appendChild(el('div', { class: 'ct-dos' }, el('label', {}, el('span', { text: T('comoTrabaja.campoPrefijo') }), prefijo, ejemplo), campo('comoTrabaja.campoProfundidad', prof)));
      leerUsos.push(function () { return { group: grupo.value, detection: cuando.value, paths: rutas.valores(), prefix: prefijo.value.trim(), depth: prof.value }; });
    }
    paneles.appendChild(panel);
  });
  var inicial = 0;
  usos.forEach(function (u, i) { if ((u.group === 'validacion' ? 'validacion' : 'cambio') === boton.getAttribute('data-use')) inicial = i; });
  elegir(inicial);
  function borrador() {
    var herramientas = []; casillas.querySelectorAll('input[data-tool]').forEach(function (c) { if (c.checked) herramientas.push(c.value); });
    var agente = nombre.value.trim();
    return { pack: draft.pack, original: draft.original, agent: agente, uses: leerUsos.map(function (f) { return f(); }),
      cabecera: { nombre: agente, descripcion: descripcion.value, modelo: modelo.value, herramientas: herramientas }, cuerpo: texto.value };
  }
  var revisar = el('button', { type: 'button', class: 'btn', 'data-action': 'check', text: T('comoTrabaja.revisar'), onclick: function () {
    pedir('/api/como-trabaja/revisar', { draft: borrador() }).then(function (r) {
      estado.textContent = '';
      if (r.ok) {
        if (!versiones && r.firma) versiones = { versions: r.versions, firma: r.firma };
        revisado = true; proponer.removeAttribute('disabled');
        motivo.textContent = T('comoTrabaja.motivoRevisado'); motivo.setAttribute('data-motivo', 'revisado');
        estado.appendChild(el('p', { class: 'ct-ok', text: T('comoTrabaja.seLeeBien') }));
      } else (r.problems || [r.message]).forEach(function (p) { estado.appendChild(el('p', { class: 'ct-error', text: p })); });
    });
  } });
  proponer.onclick = function () {
    proponer.setAttribute('disabled', 'disabled');
    pedir('/api/como-trabaja/proponer', { draft: borrador(), versions: versiones ? versiones.versions : {}, firma: versiones ? versiones.firma : null }).then(function (r) {
      estado.textContent = '';
      // el sitio demo no abre ningún pedido: dice lo que pasaría, igual que Configuración
      if (r.ok && r.codigo === 'demo') estado.appendChild(el('p', { class: 'ct-ok', 'data-demo': 'si', text: r.message }));
      else if (r.ok) { var p = el('p', { class: 'ct-ok' }, document.createTextNode(T('comoTrabaja.propuesto', { enlace: '' }))); if (r.enlace) p.appendChild(el('a', { href: r.enlace, target: '_blank', rel: 'noopener', text: r.enlace })); estado.appendChild(p); }
      else estado.appendChild(el('p', { class: 'ct-error', text: r.codigo === 'cambio' ? T('comoTrabaja.cambioEnMain') : T('comoTrabaja.noSePudo', { motivo: (r.problems || [r.message]).join(' · ') }) }));
    });
  };
  var panel = el('li', { class: 'ct-panel ct-editor' },
    el('p', { class: 'ct-sub', text: T('comoTrabaja.elRevisor') }),
    el('div', { class: 'ct-dos' }, campo('comoTrabaja.campoNombre', nombre), campo('comoTrabaja.campoModelo', modelo)),
    // sin saber el techo de la organización, se dice: un modelo elegido no se puede revisar
    draft.avisoModelos ? el('p', { class: 'ct-error', 'data-aviso': 'modelos', text: draft.avisoModelos }) : null,
    el('fieldset', { class: 'ct-grupo' }, el('legend', { text: T('comoTrabaja.campoHerramientas') }), casillas,
      el('p', { class: 'ct-nota', text: T('comoTrabaja.revisorSoloLee') }), otras, otras ? el('p', { class: 'ct-nota', text: T('comoTrabaja.otrasHerramientas') }) : null),
    campo('comoTrabaja.campoDescripcion', descripcion),
    el('p', { class: 'ct-sub', text: T('comoTrabaja.susInstrucciones') }), texto,
    el('p', { class: 'ct-nota', text: T('comoTrabaja.instruccionesNota') }),
    solapas, el('p', { class: 'ct-nota', text: T('comoTrabaja.usosAyuda') }), paneles, estado,
    el('div', { class: 'ct-pie' }, revisar, proponer, el('button', { type: 'button', class: 'btn', text: T('comoTrabaja.cerrar'), onclick: cerrarPaneles })), motivo);
  despuesDe(boton, panel);
  // el editor de texto largo, compartido con el resto del sitio: vista previa y qué cambió contra lo que se abrió
  if (window.LongTextEditor) window.LongTextEditor.montar(texto, { vistaPrevia: true, queCambio: true, alCambiar: cambio, textos: textosLargo() });
  else texto.addEventListener('input', cambio);
  setTimeout(function () { nombre.focus(); }, 0);
}
raiz.addEventListener('click', function (ev) {
  var b = ev.target.closest('button[data-action]'); if (!b) return;
  var accion = b.getAttribute('data-action');
  if (accion !== 'improve' && accion !== 'edit' && accion !== 'add') return;
  var abierto = b.getAttribute('aria-expanded') === 'true';
  cerrarPaneles(); if (abierto) return;
  if (accion === 'improve') return cuadroMejora(b);
  // si el revisor no se pudo abrir, se dice debajo de su renglón (nunca un clic que no hace nada)
  function noSeAbrio(motivo) { despuesDe(b, el('li', { class: 'ct-panel' }, el('p', { class: 'ct-error', text: T('comoTrabaja.noSePudo', { motivo: motivo }) }), el('div', { class: 'ct-pie' }, el('button', { type: 'button', class: 'btn', text: T('comoTrabaja.cerrar'), onclick: cerrarPaneles })))); }
  // uno nuevo pide sólo los modelos que puede elegir (sin «agent»); uno existente, su borrador y sus versiones
  var nuevo = accion === 'add';
  fetch('/api/como-trabaja/revisor?pack=' + encodeURIComponent(b.getAttribute('data-pack')) + (nuevo ? '' : '&agent=' + encodeURIComponent(b.getAttribute('data-agent'))), { credentials: 'same-origin' })
    .then(function (r) { return r.json().catch(function () { return { message: String(r.status) }; }); })
    .then(function (r) { if (r && r.draft) { r.draft.avisoModelos = r.avisoModelos || null; editor(b, r.draft, nuevo ? null : { versions: r.versions, firma: r.firma }, r.modelos); } else noSeAbrio((r && r.message) || '?'); }, function (e) { noSeAbrio(String(e && e.message || e)); });
});
})();
`;
}

// ── las rutas ──

/** Las rutas de la pestaña, para `rutasExtra` de crearSitio (como Configuración). */
function crearRutas({ cfg, fuentes, versionImagen = null, ahora = Date.now, fetch = globalThis.fetch, urlBase = {}, remotos = {}, log = () => {}, demo = false }) {
  const solo = ['maintainer'];
  // el sitio demo (demo.js) no tiene git: la versión de cada archivo sale del archivo, y Proponer muestra lo que pasaría
  const oidDe = demo ? oidDeArchivo : oidEnHead;
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
    return html.replace('</head>', `<meta name="site-token" content="${tok.replace(/[^A-Za-z0-9_-]/g, '')}"><script src="/static/long-text-editor.js" defer></script><script src="/static/como-trabaja.js?l=${idioma}" defer></script></head>`);
  }
  async function revisar(ctx) {
    const w = await defensaDeEscritura(cfg, ctx);
    if (w.error) return w.error;
    const p = perfil();
    const r = reviewDraft({ profileDir: p.dir, draft: w.body && w.body.draft, idioma: views.idiomaDe(ctx) });
    if (!r.ok) return json(200, { ok: false, problems: r.problems });
    const v = await versionesDe(p.dir, r.files.map((f) => f.archivo), oidDe);
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
      const o = await oidDe(p.dir, f.archivo);
      if (o.error) { log(`cómo trabaja: no pude leer la versión de ${f.archivo} en el clon del perfil (${o.error})`); return json(200, { ok: false, message: TX.t(views.idiomaDe(ctx), 'comoTrabaja.err.clon', { motivo: o.error }) }); }
      archivos.push({ ...f, oidEsperado: o.oid });
    }
    if (demo) return json(200, { ok: true, codigo: 'demo', demo: true, message: TX.t(views.idiomaDe(ctx), 'comoTrabaja.demoNoSeEscribe', { pack: r.pack }), loQuePasaria: { repo: 'perfil', archivos: archivos.map((f) => f.archivo) } });
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
      const idioma = views.idiomaDe(ctx);
      if (!p.dir || !NAME_RE.test(pack || '')) return json(404, { ok: false, message: TX.t(idioma, 'comoTrabaja.err.sinPaquete') });
      // sin «agent»: un revisor nuevo, con los modelos que se pueden elegir y las tres herramientas de lectura
      if (!agent) return json(200, { draft: { pack, original: null, agent: '', group: 'condicional', detection: 'codeModified', paths: [], prefix: '', cuerpo: '',
        cabecera: { nombre: '', descripcion: '', modelo: '', modeloTalCual: false, herramientas: ['Read', 'Grep', 'Glob'], otrasHerramientas: [], otras: [] } }, modelos: modelosDe(p.dir, idioma), avisoModelos: avisoDeModelos(p.dir, idioma) });
      if (!NAME_RE.test(agent)) return json(404, { ok: false, message: TX.t(idioma, 'comoTrabaja.err.sinPaquete') });
      const d = draftOf(p.dir, pack, agent);
      if (d.error) { log(`cómo trabaja: el revisor ${pack}/${agent} no se pudo abrir (${d.error})`); return json(404, { ok: false, message: d.error }); }
      // las versiones de hoy de los dos archivos, firmadas: el aviso de «otro lo cambió» se mide desde que se abrió
      const v = await versionesDe(p.dir, [`packs/${pack}/pack.json`, d.md], oidDe);
      if (v.error) { log(`cómo trabaja: no pude leer las versiones del clon del perfil (${v.error})`); return json(404, { ok: false, message: TX.t(views.idiomaDe(ctx), 'comoTrabaja.err.clon', { motivo: v.error }) }); }
      return json(200, { draft: d.draft, versions: v.versions, firma: firmaDe(ctx.sesion && ctx.sesion.tok, v.versions), modelos: modelosDe(p.dir, idioma), avisoModelos: avisoDeModelos(p.dir, idioma) });
    } },
    { method: 'POST', path: '/api/como-trabaja/revisar', needs: solo, handler: revisar },
    { method: 'POST', path: '/api/como-trabaja/proponer', needs: solo, handler: proponer },
  ];
}

module.exports = { crearRutas, renderPage, momentTextProblems, issueUrl, buildIssueUrl, reviewDraft, draftOf, publicRepoOf, ISSUE_URL_MAX, HERRAMIENTAS, modelosDe, avisoDeModelos, armarAgente, cabeceraDe, camposDe, guion, textosDelGuion };
