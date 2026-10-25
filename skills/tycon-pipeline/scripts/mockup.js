#!/usr/bin/env node
/**
 * mockup.js — la maqueta de la pantalla antes de construirla.
 *
 * Sin maqueta, la pantalla se ve recién construida: un error de diseño (qué se muestra, dónde, con qué palabras) se descubre
 * cuando ya está programado y probado, y arreglarlo cuesta otra vuelta de revisores, del pase adversarial y de las
 * pruebas de navegador. La maqueta es un HTML local, de un archivo, sin red y sin código, con los textos reales de la
 * pantalla. En las stories con pantalla la persona que pide la story la aprueba junto con el plan (paso «Aprobar el plan», `marker.js complete-step approve-plan
 * --mockup-approved`), su huella queda anotada, y la revisión de la pantalla (`qa-guide.js --check`, capas 9 y 10)
 * compara lo construido contra ella.
 *
 * Comandos:
 *   render --data <json|-> [--out <ruta>] [--story <spec>] [--open]   arma la maqueta (sin --out: la ruta de `status`)
 *   check <html>                                                       0 = maqueta válida · 1 = hallazgos · 2 = ilegible
 *   texts <html> [--json]                                              los textos que se comparan con la pantalla
 *   status --story <spec> [--json]                                     ¿tiene pantalla? dónde va su maqueta, aprobada o no
 *   schema                                                             la forma del modelo
 *   demo [--out <ruta>]                                                la maqueta del modelo de ejemplo
 *
 * Es estática a propósito: sin <script>, sin imágenes, sin enlaces que naveguen, con una política de seguridad del
 * contenido que niega todo salvo estilos en línea. Sin código ni direcciones no hay forma de cargar red, y la
 * validación es determinística. Es la misma con Claude y con Codex: se abre con doble clic y se mira en el chat.
 */
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('./lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GENERATOR = 'tycon-mockup/1';
const CSP = "default-src 'none'; style-src 'unsafe-inline'";
const KINDS = ['heading', 'text', 'button', 'link', 'field', 'checkbox', 'table', 'list', 'message', 'box', 'group'];
// lo primero que lee quien aprueba: la maqueta fija qué dice la pantalla, no cómo se ve
const SCHEMA_NOTE = 'Esquema de textos y estados, no del aspecto.';
const EXISTING_NOTE = 'En gris, lo que la pantalla ya tiene.';
const TONES = ['info', 'ok', 'warn', 'error'];
const TEXT_KINDS = ['heading', 'text', 'button', 'link', 'message', 'box'];
// cómo se presenta una pantalla: en la página, o como una capa encima de otra (una ventana, un diálogo, un panel)
const PRESENTATIONS = ['page', 'layer'];

// El escape propio de la maqueta: además de `& < > " '` codifica `= ( ) @ :` como entidades numéricas. Así un texto
// que trae `<img src=https://…>` o `url(…)` no deja ningún `src=` ni `url(` literal en el archivo, y `check` no da
// falsos hallazgos. `esc` de visual-plan.js no alcanza: deja `src=` y `url(` tal cual.
function mockupEsc(s) {
  return String(s).replace(/[&<>"'=()@:]/g, (c) => `&#${c.charCodeAt(0)};`);
}
function decode(s) {
  return String(s)
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, h) => { const n = parseInt(h, 16); return n <= 0x10ffff ? String.fromCodePoint(n) : m; })
    .replace(/&#(\d{1,7});/g, (m, d) => { const n = Number(d); return n <= 0x10ffff ? String.fromCodePoint(n) : m; });
}

// La huella del contenido con los fines de línea llevados a LF: con `core.autocrlf` en Windows el mismo archivo sale
// de git con CRLF y daría «la maqueta cambió» sin que nadie la toque.
function mockupHash(content) {
  return crypto.createHash('sha256').update(String(content).replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

const isStr = (v) => typeof v === 'string' && v.trim() !== '';

// Una casilla está marcada con `checked`; un modelo viejo que trae `value: true` también vale, y `checked` gana.
const isChecked = (c) => (typeof c.checked === 'boolean' ? c.checked : c.value === true);

// Los textos que se comparan con la pantalla, de un elemento del modelo. El rótulo de un `box` describe una imagen o un
// gráfico para quien aprueba y no está en la pantalla: se compara sólo con `compare: true`. `value`, `rows`, `notes`,
// `checked` y `disabled` son datos de ejemplo y no se comparan.
function comparedOf(el) {
  if (['heading', 'text', 'button', 'link', 'message'].includes(el.kind)) return [el.text];
  if (el.kind === 'box') return el.compare === true ? [el.text] : [];
  if (el.kind === 'checkbox') return [el.label, ...(isStr(el.title) ? [el.title] : [])];
  if (el.kind === 'group') return [el.legend, ...el.items.flatMap((c) => [c.label, ...(isStr(c.title) ? [c.title] : [])])];
  if (el.kind === 'field') return [el.label, ...(isStr(el.placeholder) ? [el.placeholder] : [])];
  if (el.kind === 'table') return el.columns;
  if (el.kind === 'list') return el.items;
  return [];
}

// Relleno: la maqueta lleva los textos reales de la pantalla. `lorem`/`ipsum` como palabra
// entera; `TBD`/`TODO`/`XXX` en mayúsculas, solos o al principio («TODO: …»). «VER TODO», «Seleccionar todo» o «Pagar
// TODO el saldo» son textos reales (con la palabra suelta en cualquier lugar, se rechazarían).
function isFiller(t) {
  const s = String(t).replace(/\s+/g, ' ').trim();
  if (/\b(lorem|ipsum)\b/i.test(s)) return true;
  if (s === '...' || s === '…' || /^x{3}$/i.test(s) || /^texto de ejemplo$/i.test(s)) return true;
  return /^(TBD|TODO|XXX)\b(?![ ][A-ZÁÉÍÓÚÑ]+\b)/.test(s);
}

// Los estados de una casilla. `value` no es un problema: un modelo viejo lo trae y se toma como `checked` (lo avisa
// `modelWarnings`). `title` es el motivo que la pantalla muestra al pasar el mouse sobre una casilla deshabilitada.
function checkboxProblems(c, k) {
  const out = [];
  if (c.checked !== undefined && typeof c.checked !== 'boolean') out.push(`${k}: \`checked\` tiene que ser true o false`);
  if (c.disabled !== undefined && typeof c.disabled !== 'boolean') out.push(`${k}: \`disabled\` tiene que ser true o false`);
  if (c.title !== undefined && (!isStr(c.title) || c.disabled !== true)) out.push(`${k}: \`title\` es una cadena y va sólo con \`disabled: true\` (el motivo que muestra la casilla deshabilitada)`);
  return out;
}

/** Lo que el modelo trae y se toma igual, con su aviso: hoy, el `value` de una casilla. */
function modelWarnings(model) {
  const out = [];
  const conValue = (c, donde) => { if (c && c.value !== undefined) out.push(`${donde}: \`value\` en una casilla se tomó como \`checked: ${isChecked(c)}\` — usá checked`); };
  (model.screens || []).forEach((sc, i) => (sc.elements || []).forEach((el, j) => {
    const donde = `pantalla ${i + 1}, elemento ${j + 1} (${el.kind})`;
    if (el.kind === 'checkbox') conValue(el, donde);
    if (el.kind === 'group' && Array.isArray(el.items)) el.items.forEach((c, n) => conValue(c, `${donde}, casilla ${n + 1}`));
  }));
  return out;
}

/** Los problemas del modelo, cada uno con su pantalla y su número de elemento. Vacío = se puede armar. */
function validateModel(model) {
  const out = [];
  if (!model || typeof model !== 'object' || Array.isArray(model)) return ['el modelo tiene que ser un objeto JSON'];
  if (!isStr(model.title)) out.push('falta `title` (el nombre de la maqueta)');
  if (!Array.isArray(model.screens) || !model.screens.length) {
    out.push('falta `screens` (una lista con al menos una pantalla)');
    return out;
  }
  const nombreDe = (sc, i) => (sc && isStr(sc.name) ? sc.name : `Pantalla ${i + 1}`);
  model.screens.forEach((sc, i) => {
    const p = `pantalla ${i + 1}`;
    if (!sc || typeof sc !== 'object') { out.push(`${p}: no es un objeto`); return; }
    if (sc.presentation !== undefined && !PRESENTATIONS.includes(sc.presentation)) out.push(`${p}: \`presentation\` «${sc.presentation}» no está en la lista (${PRESENTATIONS.join(' | ')})`);
    if (sc.presentation === 'layer') {
      // una capa se abre encima de otra pantalla con un botón o un enlace que está en esa pantalla
      if (!isStr(sc.over)) out.push(`${p}: una capa necesita \`over\` (el nombre de la pantalla sobre la que se abre)`);
      if (!isStr(sc.trigger)) out.push(`${p}: una capa necesita \`trigger\` (el texto del botón o enlace que la abre)`);
      if (isStr(sc.over)) {
        const abajo = model.screens.filter((o, j) => j !== i && nombreDe(o, j) === sc.over && nombreDe(o, j) !== nombreDe(sc, i));
        if (!abajo.length) out.push(`${p}: \`over\` «${sc.over}» no es el nombre de otra pantalla de la maqueta`);
        else if (isStr(sc.trigger) && !abajo.some((o) => Array.isArray(o.elements) && o.elements.some((el) => el && (el.kind === 'button' || el.kind === 'link') && el.text === sc.trigger))) {
          out.push(`${p}: \`trigger\` «${sc.trigger}» no es un botón ni un enlace de «${sc.over}»`);
        }
      }
    }
    if (!Array.isArray(sc.elements) || !sc.elements.length) { out.push(`${p}: falta \`elements\` (lo que muestra la pantalla)`); return; }
    sc.elements.forEach((el, j) => {
      const e = `${p}, elemento ${j + 1}`;
      if (!el || typeof el !== 'object') { out.push(`${e}: no es un objeto`); return; }
      if (!KINDS.includes(el.kind)) { out.push(`${e}: \`kind\` «${el.kind}» no está en la lista (${KINDS.join(' | ')})`); return; }
      const k = `${e} (${el.kind})`;
      if (TEXT_KINDS.includes(el.kind) && !isStr(el.text)) out.push(`${k}: falta \`text\` (una cadena)`);
      if ((el.kind === 'field' || el.kind === 'checkbox') && !isStr(el.label)) out.push(`${k}: falta \`label\` (una cadena)`);
      if (el.kind === 'field' && el.placeholder !== undefined && typeof el.placeholder !== 'string') out.push(`${k}: \`placeholder\` tiene que ser una cadena`);
      if (el.kind === 'table' && (!Array.isArray(el.columns) || !el.columns.length || !el.columns.every(isStr))) out.push(`${k}: falta \`columns\` (una lista de cadenas, no vacía)`);
      if (el.kind === 'list' && (!Array.isArray(el.items) || !el.items.length || !el.items.every(isStr))) out.push(`${k}: falta \`items\` (una lista de cadenas, no vacía)`);
      if (el.kind === 'message' && el.tone !== undefined && !TONES.includes(el.tone)) out.push(`${k}: \`tone\` «${el.tone}» no está en la lista (${TONES.join(' | ')})`);
      if (el.existing !== undefined && typeof el.existing !== 'boolean') out.push(`${k}: \`existing\` tiene que ser true o false`);
      if (el.kind === 'checkbox') out.push(...checkboxProblems(el, k));
      if (el.kind === 'group') {
        if (!isStr(el.legend)) out.push(`${k}: falta \`legend\` (el título del grupo, una cadena)`);
        if (!Array.isArray(el.items) || !el.items.length) out.push(`${k}: falta \`items\` (una lista de casillas, no vacía)`);
        else {
          el.items.forEach((c, n) => {
            const ki = `${k}, casilla ${n + 1}`;
            if (!c || typeof c !== 'object' || Array.isArray(c)) { out.push(`${ki}: no es un objeto`); return; }
            if (!isStr(c.label)) out.push(`${ki}: falta \`label\` (una cadena)`);
            out.push(...checkboxProblems(c, ki));
          });
        }
      }
    });
  });
  if (out.length) return out;
  model.screens.forEach((sc, i) => sc.elements.forEach((el, j) => {
    for (const t of comparedOf(el)) {
      if (isFiller(t)) out.push(`pantalla ${i + 1}, elemento ${j + 1} (${el.kind}): «${t}» es texto de relleno — la maqueta lleva los textos reales de la pantalla`);
    }
  }));
  return out;
}

const STYLE = `
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; background: #f4f5f7; color: #1d2433; margin: 0; padding: 24px; }
  header h1 { font-size: 20px; margin: 0 0 4px; }
  header p { margin: 0 0 20px; color: #5a6475; font-size: 13px; }
  header p.schema-note { margin: 0 0 6px; color: #1d2433; font-weight: 600; }
  .screen { background: #fff; border: 1px solid #d5d9e0; border-radius: 10px; margin: 0 0 24px; max-width: 760px; }
  .screen-head { display: flex; gap: 10px; align-items: baseline; padding: 10px 16px; border-bottom: 1px solid #e6e9ee; background: #fafbfc; border-radius: 10px 10px 0 0; }
  .screen-name { font-weight: 600; }
  .screen-state { font-size: 12px; color: #fff; background: #5a6475; border-radius: 10px; padding: 1px 8px; }
  .screen-file { font-size: 12px; color: #8a93a3; margin-left: auto; font-family: ui-monospace, Menlo, monospace; }
  .screen-body { padding: 16px; display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }
  .heading { font-size: 18px; margin: 0; }
  .text { margin: 0; }
  .button { display: inline-block; border: 1px solid #9aa3b2; border-radius: 6px; padding: 6px 14px; background: #fff; }
  .button.primary { background: #2f5bd3; border-color: #2f5bd3; color: #fff; }
  .link { color: #2f5bd3; text-decoration: underline; }
  .field { display: flex; flex-direction: column; gap: 4px; min-width: 280px; }
  .field .label { font-size: 13px; font-weight: 600; }
  .field .input { border: 1px solid #c3c9d3; border-radius: 6px; padding: 6px 10px; min-height: 18px; }
  .field .ph { color: #8a93a3; }
  .field .ph-note { font-size: 12px; color: #8a93a3; }
  .checkbox { display: flex; gap: 8px; align-items: center; }
  .cb-mark { width: 14px; height: 14px; border: 1px solid #9aa3b2; border-radius: 3px; display: inline-flex; align-items: center; justify-content: center; flex: none; font-size: 12px; line-height: 1; font-weight: 700; }
  .checkbox.disabled { color: #9aa3b2; }
  .checkbox.disabled .cb-mark { border-color: #c3c9d3; background: #f0f2f5; }
  .cb-title { font-size: 12px; }
  fieldset.group { border: 1px solid #d5d9e0; border-radius: 6px; padding: 6px 12px 10px; margin: 0; }
  fieldset.group legend { font-size: 13px; font-weight: 600; padding: 0 4px; }
  .group-row { display: flex; flex-direction: row; flex-wrap: wrap; gap: 16px; }
  .existing { color: #9aa3b2; }
  .existing * { color: #9aa3b2; border-color: #d5d9e0; background: transparent; }
  table.table { border-collapse: collapse; min-width: 420px; }
  table.table th, table.table td { border: 1px solid #d5d9e0; padding: 6px 10px; text-align: left; font-size: 14px; }
  table.table th { background: #f0f2f5; }
  ul.list { margin: 0; padding-left: 20px; }
  .message { border-radius: 6px; padding: 8px 12px; border: 1px solid; }
  .tone-info { background: #eef3ff; border-color: #b9cbf5; }
  .tone-ok { background: #ecf8ef; border-color: #a9dcb5; }
  .tone-warn { background: #fff7e6; border-color: #f0cf8a; }
  .tone-error { background: #fdeeee; border-color: #eeb0b0; }
  .box { border: 2px dashed #b4bccb; border-radius: 8px; padding: 24px; color: #5a6475; min-width: 280px; text-align: center; }
  .notes { max-width: 760px; font-size: 13px; color: #5a6475; }
`;
// Sólo va cuando la maqueta tiene una capa: una maqueta sin capas sale sin esa parte y su huella aprobada sigue valiendo.
const LAYER_STYLE = `
  .layer { background: transparent; border: 0; }
  .layer-backdrop { background: rgba(29, 36, 51, 0.45); border-radius: 10px; padding: 32px 24px; }
  .layer-dialog { background: #fff; border: 1px solid #9aa3b2; border-radius: 10px; max-width: 520px; margin: 0 auto; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25); }
  .screen-layer { font-size: 12px; color: #1d2433; background: #ffe9a8; border-radius: 10px; padding: 1px 8px; }
`;

/** El HTML de la maqueta: un archivo, sin código ni direcciones. */
function renderMockup(model) {
  const E = mockupEsc;
  const T = (text, kind, i) => `<span class="t" data-mockup-text="${E(text)}" data-kind="${kind}" data-screen="${i}">${E(text)}</span>`;
  // la casilla, sola o dentro de un grupo: marcada con una «x», deshabilitada en gris con su motivo a la vista (en la
  // imagen del chat no hay mouse para ver el `title`)
  const casilla = (c, i) => {
    const on = isChecked(c);
    const motivo = c.disabled === true && isStr(c.title) ? ` <span class="cb-title">(${T(c.title, 'title', i)})</span>` : '';
    return `<div class="checkbox${c.disabled === true ? ' disabled' : ''}"><span class="cb-mark${on ? ' on' : ''}">${on ? 'x' : ''}</span>${T(c.label, 'checkbox', i)}${motivo}</div>`;
  };
  const el = (x, i) => (x.existing === true ? `<div class="existing">${dibujo(x, i)}</div>` : dibujo(x, i));
  const dibujo = (x, i) => {
    switch (x.kind) {
      case 'heading': return `<h2 class="heading">${T(x.text, x.kind, i)}</h2>`;
      case 'text': return `<p class="text">${T(x.text, x.kind, i)}</p>`;
      case 'button': return `<span class="button${x.primary ? ' primary' : ''}">${T(x.text, x.kind, i)}</span>`;
      case 'link': return `<span class="link">${T(x.text, x.kind, i)}</span>`;
      case 'field': {
        const ph = isStr(x.placeholder) ? T(x.placeholder, x.kind, i) : '';
        const input = isStr(x.value) ? E(x.value) : (ph ? `<span class="ph">${ph}</span>` : '');
        const note = isStr(x.value) && ph ? `<span class="ph-note">vacío dice ${ph}</span>` : '';
        return `<div class="field"><span class="label">${T(x.label, x.kind, i)}</span><span class="input">${input}</span>${note}</div>`;
      }
      case 'checkbox': return casilla(x, i);
      case 'group': return `<fieldset class="group"><legend>${T(x.legend, x.kind, i)}</legend><div class="group-row">${x.items.map((c) => casilla(c, i)).join('')}</div></fieldset>`;
      case 'table': {
        const rows = (Array.isArray(x.rows) ? x.rows : []).map((r) => `<tr>${(Array.isArray(r) ? r : []).map((c) => `<td>${E(c)}</td>`).join('')}</tr>`).join('');
        return `<table class="table"><thead><tr>${x.columns.map((c) => `<th>${T(c, x.kind, i)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
      }
      case 'list': return `<ul class="list">${x.items.map((it) => `<li>${T(it, x.kind, i)}</li>`).join('')}</ul>`;
      case 'message': return `<div class="message tone-${TONES.includes(x.tone) ? x.tone : 'info'}">${T(x.text, x.kind, i)}</div>`;
      case 'box': return `<div class="box">${x.compare === true ? T(x.text, x.kind, i) : E(x.text)}</div>`;
      default: return '';
    }
  };
  const screens = model.screens.map((sc, i) => {
    const name = isStr(sc.name) ? sc.name : `Pantalla ${i + 1}`;
    const capa = sc.presentation === 'layer';
    const head = `<div class="screen-head"><span class="screen-name">${E(name)}</span>${isStr(sc.state) ? `<span class="screen-state">${E(sc.state)}</span>` : ''}${capa ? `<span class="screen-layer">Se abre encima de «${E(sc.over)}» con «${E(sc.trigger)}»</span>` : ''}${isStr(sc.file) ? `<span class="screen-file">${E(sc.file)}</span>` : ''}</div>`;
    const body = [`<div class="screen-body">`, ...sc.elements.map((x) => el(x, i)), '</div>'];
    if (capa) {
      return [
        `<section class="screen layer" data-screen-index="${i}" data-screen-name="${E(name)}" data-presentation="layer">`,
        '<div class="layer-backdrop"><div class="layer-dialog">', head, ...body, '</div></div>',
        '</section>',
      ].join('\n');
    }
    return [`<section class="screen" data-screen-index="${i}" data-screen-name="${E(name)}">`, head, ...body, '</section>'].join('\n');
  }).join('\n');
  const conCapas = model.screens.some((sc) => sc.presentation === 'layer');
  const conExistentes = model.screens.some((sc) => sc.elements.some((x) => x.existing === true));
  const sub = `Maqueta de la pantalla${isStr(model.storyId) ? ` — story ${E(model.storyId)}` : ''}. Se mira y se aprueba con el plan; lo construido se compara contra estos textos.`;
  return [
    '<!doctype html>',
    '<html lang="es"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    `<meta name="generator" content="${GENERATOR}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>Maqueta — ${E(model.title)}</title>`,
    `<style>${STYLE}${conCapas ? LAYER_STYLE : ''}</style>`,
    '</head><body>',
    `<header><h1>${E(model.title)}</h1><p class="schema-note">${SCHEMA_NOTE}${conExistentes ? ` ${EXISTING_NOTE}` : ''}</p><p>${sub}</p></header>`,
    screens,
    isStr(model.notes) ? `<div class="notes">${E(model.notes)}</div>` : '',
    '</body></html>',
    '',
  ].join('\n');
}

const LOADS = [
  [/<script/i, '<script'], [/<link\b/i, '<link'], [/<iframe/i, '<iframe'], [/<object\b/i, '<object'], [/<embed\b/i, '<embed'],
  [/<base\b/i, '<base'], [/<form\b/i, '<form'], [/<img\b/i, '<img'], [/<svg\b/i, '<svg'], [/<video\b/i, '<video'],
  [/<audio\b/i, '<audio'], [/<source\b/i, '<source'], [/<meta[^>]*http-equiv\s*=\s*["']?refresh/i, '<meta http-equiv="refresh"'],
  [/\bsrc\s*=/i, 'src='], [/\bhref\s*=/i, 'href='], [/\bsrcset\s*=/i, 'srcset='], [/\bposter\s*=/i, 'poster='],
  [/\bbackground\s*=/i, 'background='], [/\bformaction\s*=/i, 'formaction='], [/\bon[a-z]+\s*=/i, 'on…= (un atributo de evento)'],
  [/url\(/i, 'url('], [/image-set\(/i, 'image-set('], [/@import/i, '@import'],
];
/**
 * ¿Es una maqueta de este guion, sin cargas? `{ ok, findings: [{ line, what }] }`. Se busca en el archivo ENTERO: una
 * etiqueta o un atributo partido en varias líneas (`<a\nhref\n=…>`) también cuenta (una búsqueda línea por línea
 * los dejaría escapar). Los textos no dan falsos hallazgos porque salen con `mockupEsc`.
 */
function validateMockupHtml(html) {
  const findings = [];
  const s = String(html);
  if (!/<meta\s+name="generator"\s+content="tycon-mockup\/1"\s*\/?>/.test(s)) findings.push({ line: 0, what: `falta la meta generator ${GENERATOR}: no es una maqueta de mockup.js (armala con mockup.js render)` });
  if (!s.includes(`<meta http-equiv="Content-Security-Policy" content="${CSP}">`)) findings.push({ line: 0, what: `falta la meta de la política de seguridad (${CSP})` });
  if (!/data-mockup-text="/.test(s)) findings.push({ line: 0, what: 'no trae ningún texto que se compare con la pantalla' });
  for (const [re, what] of LOADS) {
    for (const m of s.matchAll(new RegExp(re.source, 'gi'))) {
      findings.push({ line: s.slice(0, m.index).split('\n').length, what: `carga externa o código: «${what}»` });
    }
  }
  return { ok: findings.length === 0, findings };
}

/** Los textos que se comparan: [{ text, kind, screen, screenName }], o null si no es una maqueta de este guion. */
function mockupTexts(html) {
  const s = String(html);
  if (!/<meta\s+name="generator"\s+content="tycon-mockup\/1"\s*\/?>/.test(s)) return null;
  const names = {};
  for (const m of s.matchAll(/data-screen-index="(\d+)" data-screen-name="([^"]*)"/g)) names[m[1]] = decode(m[2]);
  const out = [];
  for (const m of s.matchAll(/data-mockup-text="([^"]*)" data-kind="([^"]*)" data-screen="(\d+)"/g)) {
    out.push({ text: decode(m[1]), kind: m[2], screen: Number(m[3]), screenName: names[m[3]] || null });
  }
  return out;
}

/**
 * ¿La story tiene pantalla? Con la MISMA detección que la guía de QA (`qa-guide.js#isUiStory` con la raíz del
 * repo de la STORY), no la de `markerStoryIsUi` (raíz del repo del código). Una story ilegible TIRA: «no pude mirar»
 * nunca es «no hay pantalla».
 */
function screenStory(storyPath) {
  if (!storyPath) throw new Error('sin ruta de la story');
  const abs = path.resolve(storyPath);
  const content = fs.readFileSync(abs, 'utf8');
  const fm = (content.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '';
  const repoRoot = require(path.join(__dirname, 'lib', 'evidence-config.js')).discoverRepoRoot(abs);
  const detail = require(path.join(__dirname, 'lib', 'ui-signal.js')).uiSignalDetail(content, repoRoot);
  const screen = require(path.join(__dirname, 'qa-guide.js')).isUiStory(content, fm, repoRoot);
  return { screen: screen === true, signal: detail.signal, detail, repoRoot, story: abs };
}

/** Dónde van la maqueta y su aprobación: la carpeta y la clave de la guía del tester (`qa-guide.js#qaLocation`). */
function mockupPaths(storyPath) {
  const { qaDir, qk } = require(path.join(__dirname, 'qa-guide.js')).qaLocation(storyPath);
  return { qaDir, key: qk, mockup: path.join(qaDir, `${qk}-mockup.html`), approval: path.join(qaDir, `${qk}-mockup-approval.json`) };
}

/** El archivo de aprobación: `{ state: 'absent' }`, `{ state: 'ok', data }` o `{ state: 'bad', error }` (nunca «no hay»). */
function readApproval(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { state: 'absent' };
    return { state: 'bad', error: e.code || e.message };
  }
  let data;
  try { data = JSON.parse(raw); } catch (e) { return { state: 'bad', error: `JSON inválido (${e.message})` }; }
  if (!data || data.schema !== 1 || !/^[0-9a-f]{64}$/.test(String(data.sha256)) || !isStr(data.file) || !isStr(String(data.story === undefined || data.story === null ? '' : data.story))) {
    return { state: 'bad', error: 'no tiene la forma { schema: 1, story, file, sha256, approvedAt }' };
  }
  return { state: 'ok', data };
}

/** Escribe la aprobación (sin la cita: el archivo viaja con el repo). Lo llama sólo marker.js. */
function writeApproval({ approvalPath, mockupPath, story, sha256, approvedAt }) {
  const data = { schema: 1, story: String(story), file: path.relative(path.dirname(approvalPath), mockupPath).split(path.sep).join('/'), sha256, approvedAt };
  fs.mkdirSync(path.dirname(approvalPath), { recursive: true });
  fs.writeFileSync(approvalPath, JSON.stringify(data, null, 2) + '\n');
  return data;
}

const wordCount = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const collapse = (s) => String(s).replace(/\s+/g, ' ').trim();
// Un texto corto como palabra entera, respetando mayúsculas: «Pagar» no está en «sin pagar» ni en `onPagar`.
const wordIn = (needle, hay) => new RegExp(`(^|[^\\p{L}\\p{N}_])${reEsc(collapse(needle))}(?=$|[^\\p{L}\\p{N}_])`, 'u').test(collapse(hay));
// Un texto corto que la pantalla trae como cadena literal ENTERA (`'Guardar'`, `"Número"`, `` `%` ``) o como texto de
// JSX entero (`>Guardar<`): `visibleTexts` descarta las cadenas de una palabra fuera del JSX y los textos sin letras, y
// sin esto una columna definida en un arreglo, un `{cond ? 'A' : 'B'}` o un `t('Cancelar')` saldrían como faltantes. Entera: `onPagar` sigue sin contar como «Pagar».
const literalIn = (needle, src) => {
  const t = reEsc(collapse(needle)).replace(/ /g, '\\s+');
  return new RegExp(`(['"\`])\\s*${t}\\s*\\1|>\\s*${t}\\s*<`, 'u').test(String(src));
};

/** Las diferencias declaradas en la revisión: `- «<texto>» — differs: <por qué>` (sin motivo no cuenta). */
function declaredDiffs(md) {
  const out = new Map();
  for (const l of String(md || '').split('\n')) {
    const m = l.match(/\bdiffers:\s*(.*)$/);
    if (!m || !m[1].trim()) continue;
    const antes = l.slice(0, m.index);
    // un solo texto que lleva «» adentro (una cabecera con el título de la story): de la primera « a la última »
    // (las comillas de adentro, balanceadas: «a» y «b» son dos textos)
    const entero = antes.match(/^\s*-\s*«(.*)»\s*—\s*$/);
    const balanceadas = (s) => { let d = 0; for (const c of s) { if (c === '«') d += 1; else if (c === '»') { d -= 1; if (d < 0) return false; } } return d === 0; };
    if (entero && /«/.test(entero[1]) && balanceadas(entero[1])) { out.set(entero[1].replace(/\s+/g, ' ').trim(), m[1].trim()); continue; }
    for (const q of antes.matchAll(/«([^»]+)»/g)) out.set(q[1].replace(/\s+/g, ' ').trim(), m[1].trim());
  }
  return out;
}

/**
 * Lo construido contra la maqueta. `texts`: los de `mockupTexts`; `screens`: [{ rel, abs }]; `md`: la revisión de la
 * pantalla (para `differs:`). Devuelve `{ missing, extras, declared, unreadable, warnings }` (`warnings`: los `title`
 * que no aparecen ni como atributo ni como texto). Un texto de 3 palabras o más se
 * busca como en la capa 8 (`whereInScreens`: literal o mensaje armado); uno más corto sólo entre los textos visibles,
 * como palabra entera: `whereInScreens` busca primero en el archivo entero, y «Pagar» aparece en `onPagar`.
 */
function compareWithScreens({ texts, screens, md }) {
  const ui = require(path.join(__dirname, 'lib', 'ui-texts.js'));
  const declaredMap = declaredDiffs(md);
  const unreadable = []; const readable = [];
  for (const s of screens || []) {
    try { readable.push({ ...s, src: fs.readFileSync(s.abs, 'utf8') }); } catch (e) { unreadable.push({ rel: s.rel, error: e.code || e.message }); }
  }
  const visibles = readable.map((s) => ({ rel: s.rel, texts: ui.visibleTexts(s.src) }));
  const seen = new Set(); const missing = []; const declared = []; const warnings = [];
  for (const t0 of texts || []) {
    // espacios colapsados, como los textos de la pantalla («Ver  todo» tiene que coincidir con «Ver todo»)
    const t = { ...t0, text: collapse(t0.text) };
    // el motivo de una casilla se cuenta aparte: si tiene las mismas palabras que un texto obligatorio, ese texto se
    // sigue comparando como faltante
    const clave = (t.kind === 'title' ? 'title:' : 'texto:') + t.text;
    if (!t.text || seen.has(clave)) continue;
    seen.add(clave);
    const motivo = declaredMap.get(t.text);
    if (motivo) { declared.push({ ...t, motivo }); continue; }
    // el motivo de una casilla deshabilitada suele ser un atributo `title` o un tooltip, que no es texto visible: se
    // busca también como atributo, y si no está es un aviso, no un faltante
    if (t.kind === 'title') {
      const attr = new RegExp(`\\btitle\\s*=\\s*\\{?\\s*(['"\`])\\s*${reEsc(t.text).replace(/ /g, '\\s+')}\\s*\\1`, 'u');
      const hay = readable.some((s) => attr.test(s.src) || literalIn(t.text, s.src))
        || visibles.some((v) => v.texts.some((x) => wordIn(t.text, x.text)));
      if (!hay) warnings.push(t);
      continue;
    }
    const present = wordCount(t.text) >= 3
      ? ui.whereInScreens(t.text, readable).some((h) => !h.unreadable)
      : visibles.some((v) => v.texts.some((x) => wordIn(t.text, x.text))) || readable.some((s) => literalIn(t.text, s.src));
    if (!present) missing.push(t);
  }
  const extras = [];
  for (const v of visibles) {
    for (const x of v.texts) {
      const matched = (texts || []).some((t) => wordIn(t.text, x.text) || wordIn(x.text, t.text)
        || ui.quoteMatchesText(t.text, x.text) || ui.quoteMatchesText(x.text, t.text));
      if (!matched) extras.push({ text: x.text, rel: v.rel, line: x.line });
    }
  }
  return { missing, extras, declared, unreadable, warnings };
}

/** Los argumentos de `qa-guide.js --check` en «Preparar el commit»: con la maqueta aprobada en el marcador, su huella. */
function qaGuideCheckArgs(storyPath, marker) {
  const sha = marker && marker.mockupApproval && marker.mockupApproval.sha256;
  return [path.join(__dirname, 'qa-guide.js'), '--check', '--story', storyPath, ...(sha ? ['--mockup-sha', sha] : [])];
}

/**
 * Qué hace «Preparar el commit» con la maqueta. `{ block, skip, compare, screenNow }`:
 *   block   — la story ganó una pantalla después de aprobar el plan sin maqueta (el paso «Aprobar el plan» anotó `screen: false`).
 *   skip    — tenía maqueta aprobada y no se detecta pantalla: no se compara, se dice y se anota.
 *   compare — hay maqueta aprobada y la story sigue con pantalla (o no se pudo leer: «no pude mirar» no saltea).
 */
function mockupStep8(marker, storyPath) {
  const ap = marker && marker.mockupApproval;
  const dec = marker && marker.mockupDecision;
  const none = { block: null, skip: false, compare: false, screenNow: null };
  if (!ap && !(dec && dec.screen === false)) return none;
  let screenNow = null; let leerError = null;
  try { screenNow = screenStory(storyPath).screen; } catch (e) { screenNow = null; leerError = e.code || e.message; }
  let block = null;
  if (!ap && dec && dec.screen === false && screenNow === true) {
    block = `la story ganó una pantalla después de aprobar el plan: armá la maqueta (\`mockup.js render --story ${storyPath}\`), mostrásela al dueño (o a quien tenga su delegación) y \`marker.js approve-mockup --approved "<cita>"\``;
  } else if (!ap && dec && dec.screen === false && screenNow === null) {
    // «no pude mirar» nunca es «no hay»: sin leer la story no se sabe si ganó una pantalla
    block = `no pude leer la story (${storyPath || '(sin ruta en el marcador)'}: ${leerError}): no sé si ganó una pantalla después de aprobar el plan. Arreglá la ruta (\`marker.js set\` con \`storyPath\`) y volvé a cerrar.`;
  }
  return { block, skip: !!ap && screenNow === false, compare: !!ap && screenNow !== false, screenNow };
}

const DEMO = {
  storyId: '1.1',
  title: 'La lista de facturas',
  screens: [
    {
      name: 'Lista de facturas',
      state: 'con facturas sin pagar',
      file: 'src/components/Facturas.tsx',
      elements: [
        { kind: 'heading', text: 'Facturas de Acme SA' },
        { kind: 'text', text: 'Tiene 3 facturas sin pagar.' },
        { kind: 'field', label: 'Buscar factura', placeholder: 'Número o fecha', value: '0001-00012345', existing: true },
        {
          kind: 'group', legend: 'Estado', items: [
            { label: 'Sin pagar', checked: true },
            { label: 'Pagadas' },
            { label: 'Anuladas', disabled: true, title: 'Sólo las ve el administrador' },
          ],
        },
        { kind: 'table', columns: ['Número', 'Vence', 'Importe'], rows: [['0001-00012345', '12/11', '$ 120.000']] },
        { kind: 'message', tone: 'warn', text: 'Las facturas vencidas no se pueden pagar desde acá.' },
        { kind: 'button', text: 'Pagar seleccionadas', primary: true },
        { kind: 'link', text: 'Ver facturas pagadas' },
        { kind: 'box', text: 'Gráfico de vencimientos por mes' },
      ],
    },
    { name: 'Lista de facturas', state: 'sin facturas', elements: [{ kind: 'text', text: 'No tiene facturas sin pagar.' }] },
    {
      name: 'Confirmar el pago',
      state: 'abierta',
      presentation: 'layer',
      over: 'Lista de facturas',
      trigger: 'Pagar seleccionadas',
      elements: [
        { kind: 'text', text: 'Va a pagar 1 factura por $ 120.000.' },
        { kind: 'button', text: 'Confirmar pago', primary: true },
        { kind: 'button', text: 'Volver' },
      ],
    },
  ],
  notes: 'para el dueño; no se compara',
};

const SCHEMA = `La forma del modelo de la maqueta (JSON). Los ejemplos son inventados.

${JSON.stringify(DEMO, null, 2)}

- kind: ${KINDS.join(' | ')}
- tone (de message): ${TONES.join(' | ')}
- El texto que exige cada kind: text para heading, text, button, link, message y box; label para field y checkbox
  (placeholder opcional); columns no vacío para table; items no vacío para list; legend e items no vacío para group.
- checkbox: "checked" (true o false: marcada con una x o vacía) y "disabled" (true: en gris). "title", sólo con
  "disabled": true, es el motivo que la pantalla muestra al pasar el mouse; la maqueta lo pone a la vista. Un "value"
  de un modelo viejo se toma como "checked" y render avisa: usá checked.
- group: "legend" (el título del grupo) e "items", una lista de casillas (label, checked, disabled, title) que se
  dibujan en una fila.
- "existing": true, en cualquier elemento, lo dibuja en gris: la pantalla ya lo tiene y la story no lo agrega. Se sigue
  comparando.
- Toda maqueta abre con la cabecera "${SCHEMA_NOTE}": fija qué dice cada pantalla y en qué estado, no cómo se ve.
- Se comparan con la pantalla: el texto de heading, text, button, link y message; label y placeholder; columns; items;
  la legend y los label de un group; y el text de un box sólo con "compare": true (el rótulo de un box describe una
  imagen o un gráfico para el dueño). El title de una casilla se busca como atributo o como texto, y si no está es un
  aviso, no un faltante. No se comparan value, checked, disabled, rows, notes, ni el nombre, el estado o la
  presentation de la pantalla.
- Los estados de falla (vacío, error) van como otra pantalla con su "state": así el dueño los aprueba y se comparan.
- presentation (opcional): "page" (la de siempre) o "layer", una ventana, un diálogo o un panel que se abre encima de
  otra pantalla. Una capa lleva "over" (el nombre de la pantalla de abajo) y "trigger" (el texto exacto de un botón o
  enlace de esa pantalla, el que la abre); se dibuja como un marco sobre un fondo atenuado. La maqueta fija el
  contenido y los estados, no la forma: la forma sale de la story y de la guía del stack.
- Los textos son los reales de la pantalla: lorem ipsum, TBD, TODO, XXX o "..." no se aceptan.`;

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const opt = (n) => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : null; };
  const fail = (msg, code = 2) => { console.error(`mockup.js: ${msg}`); process.exit(code); };

  if (cmd === 'schema') { console.log(SCHEMA); return; }

  if (cmd === 'render' || cmd === 'demo') {
    let model;
    if (cmd === 'demo') model = DEMO;
    else {
      const dataArg = opt('--data');
      if (!dataArg) fail('uso: mockup.js render --data <modelo.json|-> [--out <maqueta.html>] [--story <spec.md>] [--open]');
      let raw;
      try { raw = dataArg === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(dataArg, 'utf8'); } catch (e) { fail(`no pude leer --data: ${e.message}`); }
      try { model = JSON.parse(raw); } catch (e) { fail(`JSON inválido en --data: ${e.message}`); }
      const problems = validateModel(model);
      if (problems.length) fail(`la maqueta no se armó (no se escribió nada):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
      for (const w of modelWarnings(model)) console.error(`mockup.js: aviso: ${w}`);
    }
    const story = cmd === 'render' ? opt('--story') : null;
    let out = opt('--out') || (cmd === 'demo' ? 'mockup-demo.html' : null);
    if (story && !isStr(model.storyId)) {
      try { const m = fs.readFileSync(story, 'utf8').match(/^story:\s*["']?([^"'\n]+)/m); if (m) model.storyId = m[1].trim(); } catch { /* lo dice status */ }
    }
    if (!out) {
      if (!story) fail('falta --out (o --story, para escribirla donde la busca la revisión)');
      let sc;
      try { sc = screenStory(story); } catch (e) { fail(`no pude leer la story (${e.code || e.message}): no sé si tiene pantalla`); }
      if (!sc.screen) fail('la story no tiene pantalla: no hay maqueta que armar');
      try { out = mockupPaths(story).mockup; } catch (e) { fail(`no pude calcular dónde va la maqueta: ${e.message}`); }
    }
    const html = renderMockup(model);
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, html);
    console.log(JSON.stringify({ ok: true, out, sha256: mockupHash(html) }));
    // La ruta sale SIEMPRE: un `open`/`xdg-open` que arranca y falla (sesión por SSH, Linux sin escritorio, la jaula de
    // Codex) no se ve, y el navegador puede estar en otra máquina.
    console.error(`abrila: ${out}`);
    if (argv.includes('--open')) require(path.join(__dirname, 'visual-plan.js')).openInBrowser(out, 'la maqueta');
    return;
  }

  if (cmd === 'check') {
    const f = argv[1];
    let html;
    try { html = fs.readFileSync(f, 'utf8'); } catch (e) { fail(`no pude leer la maqueta ${f || '(sin ruta)'}: ${e.code || e.message}`); }
    const v = validateMockupHtml(html);
    if (v.ok) { console.log(`✅ maqueta válida: ${f}`); return; }
    console.error(`🔴 la maqueta no pasa (${f}):`);
    for (const x of v.findings) console.error(`  - ${x.line ? `línea ${x.line}: ` : ''}${x.what}`);
    process.exit(1);
  }

  if (cmd === 'texts') {
    const f = argv[1];
    let html;
    try { html = fs.readFileSync(f, 'utf8'); } catch (e) { fail(`no pude leer ${f || '(sin ruta)'}: ${e.code || e.message}`); }
    const t = mockupTexts(html);
    if (!t) fail('no es una maqueta de mockup.js (le falta la meta generator)');
    if (argv.includes('--json')) { console.log(JSON.stringify(t, null, 2)); return; }
    let last = null;
    for (const x of t) {
      if (x.screen !== last) { console.log(`## ${x.screenName || `pantalla ${x.screen + 1}`}`); last = x.screen; }
      console.log(`- ${x.kind}: ${x.text}`);
    }
    return;
  }

  if (cmd === 'status') {
    const story = opt('--story');
    if (!story) fail('uso: mockup.js status --story <spec.md> [--json]');
    let sc;
    try { sc = screenStory(story); } catch (e) { fail(`no pude leer la story (${e.code || e.message}): no sé si tiene pantalla`); }
    let res = { screen: false, signal: sc.signal, key: null, path: null, exists: false, approval: null, changed: null };
    if (sc.screen) {
      let p;
      try { p = mockupPaths(story); } catch (e) { fail(`no pude calcular la clave de la story: ${e.message}`); }
      const ap = readApproval(p.approval);
      const exists = fs.existsSync(p.mockup);
      let changed = null;
      if (exists && ap.state === 'ok') {
        try { changed = mockupHash(fs.readFileSync(p.mockup, 'utf8')) !== ap.data.sha256; } catch (e) {
          changed = null;
          console.error(`mockup.js: no pude leer la maqueta (${e.code || e.message}): no sé si cambió después de aprobada`);
        }
      }
      res = { screen: true, signal: sc.signal, key: p.key, path: p.mockup, exists, approval: ap.state === 'ok' ? ap.data : ap.state === 'bad' ? { error: ap.error } : null, changed };
    }
    if (argv.includes('--json')) { console.log(JSON.stringify(res, null, 2)); return; }
    if (!res.screen) { console.log(`la story no tiene pantalla: no lleva maqueta${sc.detail && sc.detail.proseDropped ? ' (la palabra del frente sólo está en la prosa)' : ''}`); return; }
    console.log(`la story tiene pantalla (señal: ${res.signal}): su maqueta va en ${res.path}`);
    console.log(`  ${res.exists ? 'existe' : 'todavía no existe: armala con mockup.js render --data <modelo.json> --story <spec>'}`);
    if (res.approval && res.approval.sha256) console.log(`  aprobada (${res.approval.sha256.slice(0, 12)})${res.changed ? ' — y CAMBIÓ después de aprobada' : ''}`);
    else if (res.approval && res.approval.error) console.log(`  no pude leer su aprobación: ${res.approval.error}`);
    else console.log('  sin aprobar todavía');
    return;
  }

  fail('comandos: render | check | texts | status | schema | demo');
}

module.exports = {
  renderMockup, mockupEsc, validateMockupHtml, mockupTexts, mockupHash, mockupPaths, screenStory, readApproval,
  writeApproval, compareWithScreens, qaGuideCheckArgs, mockupStep8, validateModel, modelWarnings, declaredDiffs, GENERATOR, CSP,
};

if (require.main === module) main();
