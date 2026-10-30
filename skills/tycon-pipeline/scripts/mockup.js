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
const KINDS = ['heading', 'text', 'button', 'link', 'field', 'checkbox', 'table', 'list', 'message', 'box', 'group', 'chat'];
// lo primero que lee quien aprueba: la maqueta fija qué dice la pantalla y dónde va, no cómo se ve
const SCHEMA_NOTE = 'Es un boceto: muestra qué dice cada parte y más o menos dónde va, no los colores ni las medidas.';
const TONES = ['info', 'ok', 'warn', 'error'];
// un chat de ejemplo: globos de quien usa la pantalla (us) y de la otra persona (them), sólo para ilustrar
const CHAT_FROM = ['us', 'them'];
const CHAT_NOTE = 'Mensajes de ejemplo, para ilustrar: no son los de la pantalla real';
const TEXT_KINDS = ['heading', 'text', 'button', 'link', 'message', 'box'];
// cómo se presenta una pantalla: en la página, o como una capa encima de otra (una ventana, un diálogo, un panel)
const PRESENTATIONS = ['page', 'layer'];
// dónde va un elemento, a grandes rasgos: la maqueta lo dibuja en una grilla aproximada (sin zona, va al centro)
const ZONES = ['top', 'top-end', 'left', 'center', 'right', 'bottom'];
const ZONE_NAMES = { top: 'de arriba', 'top-end': 'de arriba a la derecha', left: 'de la izquierda', center: 'del centro', right: 'de la derecha', bottom: 'de abajo' };

// Los elementos de una pantalla junto con los de sus variantes: todos se validan y se comparan igual.
const allElements = (sc) => [
  ...(Array.isArray(sc.elements) ? sc.elements : []),
  ...(Array.isArray(sc.variants) ? sc.variants.flatMap((v) => (v && Array.isArray(v.elements) ? v.elements : [])) : []),
];

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
  (model.screens || []).forEach((sc, i) => allElements(sc || {}).forEach((el, j) => {
    if (!el) return;
    const donde = `pantalla ${i + 1}, elemento ${j + 1} (${el.kind})`;
    if (el.kind === 'checkbox') conValue(el, donde);
    if (el.kind === 'group' && Array.isArray(el.items)) el.items.forEach((c, n) => conValue(c, `${donde}, casilla ${n + 1}`));
  }));
  return out;
}

/** Los problemas de un elemento del modelo; `e` dice dónde está. */
function elementProblems(el, e) {
  const out = [];
  if (!el || typeof el !== 'object') return [`${e}: no es un objeto`];
  if (!KINDS.includes(el.kind)) return [`${e}: \`kind\` «${el.kind}» no está en la lista (${KINDS.join(' | ')})`];
  const k = `${e} (${el.kind})`;
  if (TEXT_KINDS.includes(el.kind) && !isStr(el.text)) out.push(`${k}: falta \`text\` (una cadena)`);
  if ((el.kind === 'field' || el.kind === 'checkbox') && !isStr(el.label)) out.push(`${k}: falta \`label\` (una cadena)`);
  if (el.kind === 'field' && el.placeholder !== undefined && typeof el.placeholder !== 'string') out.push(`${k}: \`placeholder\` tiene que ser una cadena`);
  if (el.kind === 'table' && (!Array.isArray(el.columns) || !el.columns.length || !el.columns.every(isStr))) out.push(`${k}: falta \`columns\` (una lista de cadenas, no vacía)`);
  if (el.kind === 'list' && (!Array.isArray(el.items) || !el.items.length || !el.items.every(isStr))) out.push(`${k}: falta \`items\` (una lista de cadenas, no vacía)`);
  if (el.kind === 'list' && el.selected !== undefined && !(Array.isArray(el.items) && el.items.includes(el.selected))) out.push(`${k}: \`selected\` tiene que ser uno de los \`items\` (el renglón que se ve elegido)`);
  if (el.kind === 'message' && el.tone !== undefined && !TONES.includes(el.tone)) out.push(`${k}: \`tone\` «${el.tone}» no está en la lista (${TONES.join(' | ')})`);
  if (el.zone !== undefined && !ZONES.includes(el.zone)) out.push(`${k}: \`zone\` «${el.zone}» no está en la lista (${ZONES.join(' | ')})`);
  if (el.existing !== undefined && typeof el.existing !== 'boolean') out.push(`${k}: \`existing\` tiene que ser true o false`);
  if (el.kind === 'checkbox') out.push(...checkboxProblems(el, k));
  if (el.kind === 'chat') {
    if (!Array.isArray(el.messages) || !el.messages.length) out.push(`${k}: falta \`messages\` (una lista de mensajes de ejemplo, no vacía)`);
    else {
      el.messages.forEach((m, n) => {
        const km = `${k}, mensaje ${n + 1}`;
        if (!m || typeof m !== 'object' || Array.isArray(m)) { out.push(`${km}: no es un objeto`); return; }
        if (m.divider !== undefined) { if (!isStr(m.divider)) out.push(`${km}: \`divider\` tiene que ser una cadena`); return; }
        if (!CHAT_FROM.includes(m.from)) out.push(`${km}: \`from\` «${m.from}» no está en la lista (${CHAT_FROM.join(' | ')})`);
        if (!isStr(m.text)) out.push(`${km}: falta \`text\` (una cadena)`);
        if (m.who !== undefined && !isStr(m.who)) out.push(`${km}: \`who\` tiene que ser una cadena`);
      });
    }
  }
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
  return out;
}

/** Los problemas del modelo, cada uno con su pantalla y su número de elemento. Vacío = se puede armar. */
function validateModel(model) {
  const out = [];
  if (!model || typeof model !== 'object' || Array.isArray(model)) return ['el modelo tiene que ser un objeto JSON'];
  if (!isStr(model.title)) out.push('falta `title` (el nombre de la maqueta)');
  if (model.summary !== undefined && !isStr(model.summary)) out.push('`summary` tiene que ser una cadena (qué cambia en la pantalla, en una frase)');
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
    if (sc.variants !== undefined) {
      if (!Array.isArray(sc.variants)) out.push(`${p}: \`variants\` tiene que ser una lista (los otros casos de la pantalla)`);
      else {
        sc.variants.forEach((v, n) => {
          const pv = `${p}, variante ${n + 1}`;
          if (!v || typeof v !== 'object' || Array.isArray(v)) { out.push(`${pv}: no es un objeto`); return; }
          if (!isStr(v.when)) out.push(`${pv}: falta \`when\` (cuándo pasa, en una frase)`);
          if (v.zone !== undefined && !ZONES.includes(v.zone)) out.push(`${pv}: \`zone\` «${v.zone}» no está en la lista (${ZONES.join(' | ')})`);
          if (v.note !== undefined && !isStr(v.note)) out.push(`${pv}: \`note\` tiene que ser una cadena`);
          if (v.elements !== undefined && !Array.isArray(v.elements)) out.push(`${pv}: \`elements\` tiene que ser una lista`);
          const els = Array.isArray(v.elements) ? v.elements : [];
          if (!els.length && !isStr(v.note)) out.push(`${pv}: necesita \`elements\` (lo que cambia) o \`note\` (qué pasa, en una frase)`);
          els.forEach((el, j) => out.push(...elementProblems(el, `${pv}, elemento ${j + 1}`)));
        });
      }
    }
    if (!Array.isArray(sc.elements) || !sc.elements.length) { out.push(`${p}: falta \`elements\` (lo que muestra la pantalla)`); return; }
    sc.elements.forEach((el, j) => out.push(...elementProblems(el, `${p}, elemento ${j + 1}`)));
  });
  if (out.length) return out;
  model.screens.forEach((sc, i) => allElements(sc).forEach((el, j) => {
    for (const t of comparedOf(el)) {
      if (isFiller(t)) out.push(`pantalla ${i + 1}, elemento ${j + 1} (${el.kind}): «${t}» es texto de relleno — la maqueta lleva los textos reales de la pantalla`);
    }
  }));
  return out;
}

const STYLE = `
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 15px; line-height: 1.45; background: #eceef2; color: #1d2433; margin: 0; padding: 32px 24px 48px; }
  header, .screen, .notes, .dev-notes { max-width: 980px; margin-left: auto; margin-right: auto; }
  header { margin-bottom: 28px; }
  header h1 { font-size: 13px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: #5a6475; margin: 0 0 6px; }
  header p { margin: 0; color: #5a6475; font-size: 13px; }
  header p.summary { margin: 0 0 14px; color: #1d2433; font-size: 21px; line-height: 1.4; font-weight: 500; }
  header p.schema-note { margin: 0 0 4px; color: #3b4456; }
  .legend { display: flex; flex-wrap: wrap; gap: 18px; margin: 12px 0 0; font-size: 13px; color: #3b4456; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .sw { width: 16px; height: 16px; border-radius: 4px; display: inline-block; box-sizing: border-box; }
  .sw-new { border: 2px solid #6d28d9; background: #f3eefe; }
  .sw-old { background: #fff; border: 1px solid #c3c9d3; }
  .sw-open { border: 3px solid #e0a100; }
  .screen { margin-bottom: 44px; }
  .screen-caption { display: flex; flex-wrap: wrap; gap: 10px; align-items: baseline; margin: 0 0 10px; }
  .screen-name { font-weight: 600; font-size: 16px; }
  .screen-state { font-size: 14px; color: #5a6475; }
  .screen-new { font-size: 12px; font-weight: 600; color: #fff; background: #6d28d9; border-radius: 10px; padding: 1px 9px; }
  .frame { background: #fff; border: 1px solid #cfd4dc; border-radius: 12px; box-shadow: 0 1px 2px rgba(16, 24, 40, 0.06), 0 6px 18px rgba(16, 24, 40, 0.06); overflow: hidden; display: flex; flex-direction: column; }
  .screen-body { padding: 24px; display: flex; flex-direction: column; gap: 16px; align-items: flex-start; flex: 1; }
  .heading { font-size: 20px; font-weight: 600; margin: 0; }
  .text { margin: 0; }
  .button { display: inline-block; border: 1px solid #c3c9d3; border-radius: 8px; padding: 8px 16px; background: #fff; font-weight: 500; box-shadow: 0 1px 2px rgba(16, 24, 40, 0.06); }
  .button.primary { background: #2f5bd3; border-color: #2f5bd3; color: #fff; }
  .button.icon { border: 0; box-shadow: none; background: transparent; color: #5a6475; font-size: 18px; padding: 4px 8px; }
  .link { color: #2f5bd3; text-decoration: underline; }
  .field { display: flex; flex-direction: column; gap: 4px; min-width: 260px; max-width: 100%; }
  .field .label { font-size: 13px; font-weight: 600; }
  .field .input { border: 1px solid #c3c9d3; border-radius: 8px; padding: 8px 12px; min-height: 20px; }
  .field .ph { color: #8a93a3; }
  .field .ph-note { font-size: 12px; color: #8a93a3; }
  .checkbox { display: flex; gap: 8px; align-items: center; }
  .cb-mark { width: 14px; height: 14px; border: 1px solid #9aa3b2; border-radius: 3px; display: inline-flex; align-items: center; justify-content: center; flex: none; font-size: 12px; line-height: 1; font-weight: 700; }
  .checkbox.disabled { color: #9aa3b2; }
  .checkbox.disabled .cb-mark { border-color: #c3c9d3; background: #f0f2f5; }
  .cb-title { font-size: 12px; }
  fieldset.group { border: 1px solid #d5d9e0; border-radius: 8px; padding: 6px 12px 10px; margin: 0; }
  fieldset.group legend { font-size: 13px; font-weight: 600; padding: 0 4px; }
  .group-row { display: flex; flex-direction: row; flex-wrap: wrap; gap: 16px; }
  .existing { filter: saturate(0.35); opacity: 0.78; }
  .new { position: relative; outline: 2px solid #6d28d9; outline-offset: 5px; border-radius: 6px; }
  .new-tag { position: absolute; top: -22px; left: 4px; z-index: 1; font-size: 12px; font-weight: 700; line-height: 1; color: #fff; background: #6d28d9; border-radius: 4px; padding: 3px 7px; }
  .opens { position: relative; display: inline-block; }
  .open-tag { position: absolute; bottom: -26px; right: 0; z-index: 1; white-space: nowrap; font-size: 12px; font-weight: 700; line-height: 1; color: #1d2433; background: #ffe7a3; border: 1px solid #e0a100; border-radius: 4px; padding: 2px 6px; }
  .trigger { outline: 3px solid #e0a100; outline-offset: 3px; }
  .new .trigger { outline: 0; }
  .ph-bar { display: block; width: 180px; max-width: 40vw; height: 12px; border-radius: 6px; background: #e3e6eb; }
  table.table { border-collapse: collapse; min-width: 420px; }
  table.table th, table.table td { border-bottom: 1px solid #e3e6eb; padding: 8px 12px; text-align: left; font-size: 14px; }
  table.table th { color: #5a6475; font-weight: 600; }
  ul.list { margin: 0; padding-left: 20px; }
  .zone-left ul.list { list-style: none; padding: 0; width: 100%; }
  .zone-left ul.list li { padding: 12px 14px; border-bottom: 1px solid #eef0f3; font-size: 14px; color: #3b4456; }
  ul.list li.selected { font-weight: 600; color: #1d2433; background: #eef1f6; }
  .zone-left ul.list li.selected { background: #fff; box-shadow: inset 4px 0 0 #2f5bd3; }
  .message { border-radius: 8px; padding: 10px 14px; border: 1px solid; }
  .tone-info { background: #eef3ff; border-color: #b9cbf5; }
  .tone-ok { background: #ecf8ef; border-color: #a9dcb5; }
  .tone-warn { background: #fff7e6; border-color: #f0cf8a; }
  .tone-error { background: #fdeeee; border-color: #eeb0b0; }
  .box { border: 1px dashed #c3c9d3; border-radius: 8px; padding: 20px; color: #5a6475; background: #f8f9fb; font-style: italic; text-align: center; align-self: stretch; }
  .chat { align-self: stretch; background: #efeae2; border-radius: 10px; padding: 12px 14px 16px; display: flex; flex-direction: column; gap: 8px; }
  .chat-caption { margin: 0 0 4px; align-self: center; font-size: 11px; font-weight: 600; letter-spacing: 0.03em; color: #4a5263; background: repeating-linear-gradient(135deg, #fff 0 6px, #f1f2f4 6px 12px); border: 1px dashed #9aa3b2; border-radius: 10px; padding: 2px 10px; }
  .chat-divider { align-self: center; font-size: 12px; color: #54656f; background: #fff; border-radius: 8px; padding: 3px 10px; box-shadow: 0 1px 1px rgba(0, 0, 0, 0.06); }
  .bubble { max-width: 72%; padding: 7px 10px 8px; border-radius: 8px; font-size: 14px; box-shadow: 0 1px 1px rgba(0, 0, 0, 0.08); }
  .bubble-us { align-self: flex-end; background: #d9fdd3; }
  .bubble-them { align-self: flex-start; background: #fff; }
  .bubble-who { display: block; font-size: 12px; font-weight: 600; color: #1f7a4d; margin-bottom: 2px; }
  .screen-body > div:has(> .chat), .zone > div:has(> .chat) { align-self: stretch; }
  .screen-body.zoned { align-items: stretch; padding: 0; gap: 0; }
  .zone-row { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; padding: 16px 24px; }
  .zone-head { border-bottom: 1px solid #eef0f3; }
  .zone-row:has(.new), .screen-body:not(.zoned):has(> .new:first-child) { padding-top: 32px; }
  .zone-foot { border-top: 1px solid #eef0f3; }
  .zone-middle { display: flex; flex-wrap: nowrap; gap: 0; align-items: stretch; flex: 1; padding: 0; }
  .zone { display: flex; flex-direction: column; gap: 12px; align-items: flex-start; min-width: 0; overflow-wrap: anywhere; }
  .zone-middle .zone { padding: 20px 24px; }
  .zone-left { flex: 0 0 34%; min-width: 200px; box-sizing: border-box; border-right: 1px solid #e3e6eb; background: #fbfbfc; padding: 0 !important; }
  .zone-center, .zone-right { flex: 1; min-width: 0; }
  .zone-middle .zone:has(> .chat), .zone-middle .zone:has(> div > .chat) { padding: 0; }
  .zone-middle .zone > .chat, .zone-middle .zone > div > .chat { border-radius: 0; flex: 1; }
  .zone-middle .zone:has(> div > .chat) > div:has(> .chat) { flex: 1; display: flex; flex-direction: column; }
  .zone-top-end { margin-left: auto; align-items: flex-end; }
  .variants { margin-top: 18px; }
  .variants-title { margin: 0 0 10px; font-size: 13px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: #5a6475; }
  .variant-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; align-items: stretch; }
  .variant { max-width: 560px; background: #fff; border: 1px solid #cfd4dc; border-radius: 10px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; align-items: flex-start; min-width: 0; overflow-wrap: anywhere; }
  .variant-when { margin: 0; font-size: 14px; font-weight: 600; }
  .variant-zone { display: block; font-weight: 400; font-size: 12px; color: #5a6475; }
  .variant-note { margin: 0; font-size: 14px; color: #3b4456; }
  .variant-zone-preview { align-self: stretch; flex: 1; min-height: 96px; border-radius: 8px; border: 1px solid #e3e6eb; background: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; text-align: center; padding: 12px; color: #54656f; font-size: 14px; }
  .variant-zone-preview.preview-chat { background: #efeae2; border-color: #e2dccf; }
  .variant-zone-preview.preview-left { background: #fbfbfc; }
  .screen.repeat { max-width: 640px; }
  .notes { font-size: 13px; color: #5a6475; }
  .dev-notes { font-size: 12px; color: #6b7485; margin-top: 12px; border-top: 1px solid #d5d9e0; padding-top: 10px; }
  .dev-notes p { margin: 0; }
  .dev-notes ul { margin: 4px 0 0; padding-left: 20px; }
  @media (max-width: 600px) { body { padding: 20px 12px 32px; } .zone-middle { flex-direction: column; } .zone-left { flex: none; border-right: 0; border-bottom: 1px solid #e3e6eb; } .bubble { max-width: 88%; } }
`;
// Sólo va cuando la maqueta tiene una capa: una maqueta sin capas sale sin esa parte.
const LAYER_STYLE = `
  .layer-how { margin: 0 0 10px; font-size: 14px; color: #3b4456; }
  .layer-stack { display: grid; border-radius: 12px; overflow: hidden; }
  .layer-stack > div { grid-area: 1 / 1; }
  .layer-under { filter: blur(2px) saturate(0.4); }
  .layer-under .frame { height: 100%; box-shadow: none; }
  .layer-backdrop { position: relative; z-index: 1; background: rgba(29, 36, 51, 0.55); display: flex; align-items: flex-start; justify-content: center; padding: 56px 40px 40px; }
  .layer-dialog { width: 86%; max-width: 860px; box-shadow: 0 18px 48px rgba(16, 24, 40, 0.35); border-color: #b9c0cc; }
  .layer-dialog .zone-middle { min-height: 340px; }
  @media (max-width: 600px) { .layer-backdrop { padding: 24px 8px; } .layer-dialog { width: 100%; } }
`;

/**
 * El HTML de la maqueta: un archivo, sin código ni direcciones. Lo lee alguien que no programa: arriba la frase de qué
 * cambia, cada pantalla con sus zonas aproximadas, lo nuevo en violeta y lo de hoy atenuado, los otros casos como
 * miniaturas de la parte que cambia, y la ventana dibujada encima de su pantalla. Los archivos van al pie.
 */
function renderMockup(model) {
  const E = mockupEsc;
  // el texto que se compara con la pantalla lleva su marca; la copia de la pantalla de abajo de una ventana, no
  const marcado = (text, kind, i) => `<span class="t" data-mockup-text="${E(text)}" data-kind="${kind}" data-screen="${i}">${E(text)}</span>`;
  const plano = (text) => E(text);
  // la casilla, sola o dentro de un grupo: marcada con una «x», deshabilitada en gris con su motivo a la vista (en la
  // imagen del chat no hay mouse para ver el `title`)
  const casilla = (c, i, T) => {
    const on = isChecked(c);
    const motivo = c.disabled === true && isStr(c.title) ? ` <span class="cb-title">(${T(c.title, 'title', i)})</span>` : '';
    return `<div class="checkbox${c.disabled === true ? ' disabled' : ''}"><span class="cb-mark${on ? ' on' : ''}">${on ? 'x' : ''}</span>${T(c.label, 'checkbox', i)}${motivo}</div>`;
  };
  const dibujo = (x, i, ctx) => {
    const T = ctx.T;
    const abre = ctx.abre && ctx.abre.has(x.text) && (x.kind === 'button' || x.kind === 'link');
    const marca = (html) => (abre ? `<span class="opens">${html}<span class="open-tag">abre ventana ↓</span></span>` : html);
    switch (x.kind) {
      case 'heading': return `<h2 class="heading">${T(x.text, x.kind, i)}</h2>`;
      case 'text': return `<p class="text">${T(x.text, x.kind, i)}</p>`;
      // un botón de uno o dos caracteres (una X, una flecha) se dibuja como ícono, sin borde
      case 'button': return marca(`<span class="button${x.primary ? ' primary' : ''}${[...x.text.trim()].length <= 2 ? ' icon' : ''}${abre ? ' trigger' : ''}">${T(x.text, x.kind, i)}</span>`);
      case 'link': return marca(`<span class="link${abre ? ' trigger' : ''}">${T(x.text, x.kind, i)}</span>`);
      case 'field': {
        const ph = isStr(x.placeholder) ? T(x.placeholder, x.kind, i) : '';
        const input = isStr(x.value) ? E(x.value) : (ph ? `<span class="ph">${ph}</span>` : '');
        const note = isStr(x.value) && ph ? `<span class="ph-note">vacío dice ${ph}</span>` : '';
        return `<div class="field"><span class="label">${T(x.label, x.kind, i)}</span><span class="input">${input}</span>${note}</div>`;
      }
      case 'checkbox': return casilla(x, i, T);
      case 'group': return `<fieldset class="group"><legend>${T(x.legend, x.kind, i)}</legend><div class="group-row">${x.items.map((c) => casilla(c, i, T)).join('')}</div></fieldset>`;
      case 'table': {
        const rows = (Array.isArray(x.rows) ? x.rows : []).map((r) => `<tr>${(Array.isArray(r) ? r : []).map((c) => `<td>${E(c)}</td>`).join('')}</tr>`).join('');
        return `<table class="table"><thead><tr>${x.columns.map((c) => `<th>${T(c, x.kind, i)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
      }
      case 'list': return `<ul class="list">${x.items.map((it) => `<li${it === x.selected ? ' class="selected"' : ''}>${T(it, x.kind, i)}</li>`).join('')}</ul>`;
      case 'message': return `<div class="message tone-${TONES.includes(x.tone) ? x.tone : 'info'}">${T(x.text, x.kind, i)}</div>`;
      case 'chat': {
        const globos = x.messages.map((m) => (isStr(m.divider)
          ? `<div class="chat-divider">${E(m.divider)}</div>`
          : `<div class="bubble bubble-${m.from}">${isStr(m.who) ? `<span class="bubble-who">${E(m.who)}</span>` : ''}${E(m.text)}</div>`)).join('');
        return `<div class="chat" data-illustrative="true"><p class="chat-caption">${CHAT_NOTE}</p>${globos}</div>`;
      }
      case 'box': return `<div class="box">${x.compare === true && T === marcado ? T(x.text, x.kind, i) : E(x.text)}</div>`;
      default: return '';
    }
  };
  // lo de hoy atenuado; lo nuevo en violeta, sólo cuando la pantalla mezcla las dos cosas (si es toda nueva, la marca va
  // una vez, en su cabecera)
  const el = (x, i, ctx) => {
    if (ctx.marcas && x.existing === true) return `<div class="existing">${dibujo(x, i, ctx)}</div>`;
    if (ctx.marcas && ctx.mezcla) return `<div class="new"><span class="new-tag">Nuevo</span>${dibujo(x, i, ctx)}</div>`;
    return dibujo(x, i, ctx);
  };
  // sin zonas, la columna de siempre; con zonas, una grilla aproximada: arriba, al medio (izquierda, centro,
  // derecha) y abajo
  const cuerpo = (elements, i, ctx) => {
    if (!elements.some((x) => x.zone !== undefined)) return [`<div class="screen-body">`, ...elements.map((x) => el(x, i, ctx)), '</div>'].join('\n');
    const en = (z) => elements.filter((x) => (x.zone || 'center') === z);
    const zona = (z) => (en(z).length ? `<div class="zone zone-${z}">${en(z).map((x) => el(x, i, ctx)).join('')}</div>` : '');
    // un encabezado con algo sólo a la derecha lleva a la izquierda un renglón gris sin texto: el lugar del título
    const hueco = !en('top').length && en('top-end').length ? '<div class="zone zone-top"><span class="ph-bar" aria-hidden="true"></span></div>' : '';
    const fila = (cls, zs) => (zs.some((z) => en(z).length) ? `<div class="zone-row ${cls}">${cls === 'zone-head' ? hueco : ''}${zs.map(zona).join('')}</div>` : '');
    return [
      '<div class="screen-body zoned">',
      fila('zone-head', ['top', 'top-end']), fila('zone-middle', ['left', 'center', 'right']), fila('zone-foot', ['bottom']),
      '</div>',
    ].filter(Boolean).join('\n');
  };
  const conExistentes = model.screens.some((sc) => allElements(sc).some((x) => x.existing === true));
  // cada caso dibuja lo que cambia; si dice en qué zona, lo dibuja dentro de una miniatura de esa zona, con su fondo
  const variantes = (sc, i) => {
    if (!Array.isArray(sc.variants) || !sc.variants.length) return '';
    const cards = sc.variants.map((v) => {
      const zona = ZONES.includes(v.zone) ? v.zone : '';
      const donde = zona ? ` <span class="variant-zone">· cambia sólo la parte ${ZONE_NAMES[zona]}</span>` : '';
      let els = Array.isArray(v.elements) ? v.elements.map((x) => dibujo(x, i, { T: marcado })).join('') : '';
      if (zona && els) {
        const conChat = sc.elements.some((x) => (x.zone || 'center') === zona && x.kind === 'chat');
        els = `<div class="variant-zone-preview preview-${zona}${conChat ? ' preview-chat' : ''}">${els}</div>`;
      }
      return `<div class="variant"><p class="variant-when">${E(v.when)}${donde}</p>${els}${isStr(v.note) ? `<p class="variant-note">${E(v.note)}</p>` : ''}</div>`;
    }).join('');
    return `<div class="variants"><p class="variants-title">Otros casos</p><div class="variant-row">${cards}</div></div>`;
  };
  const nombreDe = (sc, i) => (isStr(sc.name) ? sc.name : `Pantalla ${i + 1}`);
  const vistos = new Set();
  const screens = model.screens.map((sc, i) => {
    const name = nombreDe(sc, i);
    const capa = sc.presentation === 'layer';
    const attrs = `data-screen-index="${i}" data-screen-name="${E(name)}"${capa ? ' data-presentation="layer"' : ''}`;
    const tieneExistente = sc.elements.some((x) => x.existing === true);
    // el botón que abre una ventana se marca en su propia pantalla, donde quien aprueba lo ve
    const abre = new Set(capa ? [] : model.screens.filter((o) => o.presentation === 'layer' && o.over === name && isStr(o.trigger)).map((o) => o.trigger));
    const ctx = { T: marcado, marcas: conExistentes, mezcla: tieneExistente, abre };
    const estado = isStr(sc.state) ? `<span class="screen-state">${E(sc.state)}</span>` : '';
    // la pantalla va en un marco de aplicación; lo que la explica va afuera, arriba
    const marco = (body, extra = '') => `<div class="frame${extra}">\n${body}\n</div>`;
    // otro caso de una pantalla ya dibujada (un modelo que trae cada estado como pantalla entera): va chico, debajo
    if (vistos.has(name)) {
      return [
        `<section class="screen repeat" ${attrs}>`,
        `<div class="screen-caption"><span class="screen-name">Otro caso de «${E(name)}»</span>${estado}</div>`,
        marco(cuerpo(sc.elements, i, ctx)), variantes(sc, i), '</section>',
      ].join('\n');
    }
    vistos.add(name);
    const nueva = conExistentes && !tieneExistente ? '<span class="screen-new">Todo nuevo</span>' : '';
    const caption = `<div class="screen-caption"><span class="screen-name">${E(name)}</span>${estado}${nueva}</div>`;
    if (capa) {
      // la ventana se dibuja encima de su pantalla, que se ve desenfocada detrás: es sólo contexto
      const abajo = model.screens.find((o, j) => j !== i && nombreDe(o, j) === sc.over && o.presentation !== 'layer');
      const detras = abajo ? `<div class="layer-under" aria-hidden="true">${marco(cuerpo(abajo.elements, i, { T: plano }))}</div>` : '';
      return [
        `<section class="screen layer" ${attrs}>`,
        caption,
        `<p class="layer-how">Se abre al tocar «${E(sc.trigger)}» en «${E(sc.over)}».</p>`,
        '<div class="layer-stack">', detras,
        `<div class="layer-backdrop">${marco(cuerpo(sc.elements, i, ctx), ' layer-dialog')}</div>`,
        '</div>', variantes(sc, i), '</section>',
      ].filter(Boolean).join('\n');
    }
    return [`<section class="screen" ${attrs}>`, caption, marco(cuerpo(sc.elements, i, ctx)), variantes(sc, i), '</section>'].filter(Boolean).join('\n');
  }).join('\n');
  const conCapas = model.screens.some((sc) => sc.presentation === 'layer');
  const leyenda = conExistentes || conCapas ? `<div class="legend">${conExistentes ? '<span><i class="sw sw-new"></i>Lo nuevo, que agrega la story</span><span><i class="sw sw-old"></i>Lo que la pantalla ya tiene (sin marca, apenas atenuado)</span>' : ''}${conCapas ? '<span><i class="sw sw-open"></i>Lo que abre una ventana</span>' : ''}</div>` : '';
  const archivos = model.screens.map((sc, i) => (isStr(sc.file) ? `<li>${E(nombreDe(sc, i))}: ${E(sc.file)}</li>` : '')).filter(Boolean);
  const sub = `Maqueta de la pantalla${isStr(model.storyId) ? ` — story ${E(model.storyId)}` : ''}. Se aprueba junto con el plan, y la pantalla construida tiene que decir estos mismos textos.`;
  const pie = archivos.length ? `<p>Para el programador, los archivos de cada pantalla:</p><ul>${archivos.join('')}</ul>` : '';
  return [
    '<!doctype html>',
    '<html lang="es"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    `<meta name="generator" content="${GENERATOR}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>Maqueta — ${E(model.title)}</title>`,
    `<style>${STYLE}${conCapas ? LAYER_STYLE : ''}</style>`,
    '</head><body>',
    `<header><h1>${E(model.title)}</h1>${isStr(model.summary) ? `<p class="summary">${E(model.summary)}</p>` : ''}<p class="schema-note">${SCHEMA_NOTE}</p>${leyenda}</header>`,
    screens,
    isStr(model.notes) ? `<div class="notes">${E(model.notes)}</div>` : '',
    `<footer class="dev-notes">${pie}<p class="dev-sub">${sub}</p></footer>`,
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
    block = `la story ganó una pantalla después de aprobar el plan: armá la maqueta (\`mockup.js render --story ${storyPath}\`), mostrásela a la persona que aprueba (o a quien tenga su delegación) y \`marker.js approve-mockup --approved "<cita>"\``;
  } else if (!ap && dec && dec.screen === false && screenNow === null) {
    // «no pude mirar» nunca es «no hay»: sin leer la story no se sabe si ganó una pantalla
    block = `no pude leer la story (${storyPath || '(sin ruta en el marcador)'}: ${leerError}): no sé si ganó una pantalla después de aprobar el plan. Arreglá la ruta (\`marker.js set\` con \`storyPath\`) y volvé a cerrar.`;
  }
  return { block, skip: !!ap && screenNow === false, compare: !!ap && screenNow !== false, screenNow };
}

const DEMO = {
  storyId: '1.1',
  title: 'La lista de facturas',
  summary: 'La lista de facturas suma un filtro por estado y un botón para pagar varias juntas, que pide confirmar el pago.',
  screens: [
    {
      name: 'Lista de facturas',
      state: 'con facturas sin pagar',
      file: 'src/components/Facturas.tsx',
      elements: [
        { kind: 'heading', text: 'Facturas de Acme SA', zone: 'top', existing: true },
        { kind: 'button', text: 'Pagar seleccionadas', primary: true, zone: 'top-end' },
        { kind: 'text', text: 'Tiene 3 facturas sin pagar.', existing: true },
        { kind: 'field', label: 'Buscar factura', placeholder: 'Número o fecha', value: '0001-00012345', zone: 'left', existing: true },
        {
          kind: 'group', legend: 'Estado', zone: 'left', items: [
            { label: 'Sin pagar', checked: true },
            { label: 'Pagadas' },
            { label: 'Anuladas', disabled: true, title: 'Sólo las ve el administrador' },
          ],
        },
        { kind: 'table', columns: ['Número', 'Vence', 'Importe'], rows: [['0001-00012345', '12/11', '$ 120.000']] },
        { kind: 'message', tone: 'warn', text: 'Las facturas vencidas no se pueden pagar desde acá.' },
        { kind: 'link', text: 'Ver facturas pagadas', zone: 'bottom', existing: true },
        { kind: 'box', text: 'Gráfico de vencimientos por mes', zone: 'right', existing: true },
      ],
      variants: [{ when: 'Si no tiene facturas sin pagar', zone: 'center', elements: [{ kind: 'text', text: 'No tiene facturas sin pagar.' }] }],
    },
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
  notes: 'para quien aprueba; no se compara',
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
- list: "selected" (opcional) es uno de los "items": el renglón que se ve elegido.
- "summary" (opcional): una frase en castellano llano que dice qué cambia en la pantalla. Va arriba de todo: es lo
  primero que lee quien aprueba, que no programa.
- "existing": true, en cualquier elemento, lo dibuja atenuado: la pantalla ya lo tiene y la story no lo agrega. Se sigue
  comparando. Con algún "existing" en la maqueta, lo demás sale en violeta con la marca "Nuevo" (una pantalla toda nueva
  lleva la marca una sola vez). Sin ninguno no se marca nada: marcá lo que ya existe.
- "zone" (opcional), en cualquier elemento: dónde va, a grandes rasgos: ${ZONES.join(' | ')}. Se dibuja en una grilla
  aproximada (arriba, al medio izquierda-centro-derecha, abajo); sin zona va al centro.
- "variants" (opcional), en una pantalla: los otros casos (cargando, vacío, error, sin permiso). Cada una lleva "when"
  (cuándo pasa, en una frase), "zone" (la parte que cambia, opcional) y "elements" (lo que muestra esa parte) o "note"
  (qué pasa, si no muestra nada nuevo: «el botón no aparece»). Se dibujan como miniaturas debajo de la pantalla; con
  "zone", lo que cambia va dentro de esa parte dibujada en chico, con su fondo.
- "file" (opcional): el archivo de la pantalla; va al pie, para el programador.
- "chat": una conversación de ejemplo, dibujada como globos: "messages" es una lista de { "from": "us" (quien usa la
  pantalla, a la derecha) o "them" (la otra persona, a la izquierda), "text", "who" (opcional, quién lo mandó) } o de
  { "divider": "<texto del separador>" }. Lleva el rótulo "${CHAT_NOTE}" y no se compara: muestra cómo se ve, con
  mensajes inventados.
- Toda maqueta abre con la cabecera "${SCHEMA_NOTE}": fija qué dice cada pantalla, en qué estado y más o menos dónde.
- Se comparan con la pantalla: el texto de heading, text, button, link y message; label y placeholder; columns; items;
  la legend y los label de un group; y el text de un box sólo con "compare": true (el rótulo de un box describe una
  imagen o un gráfico para el dueño). El title de una casilla se busca como atributo o como texto, y si no está es un
  aviso, no un faltante. Los textos de los elements de una variante se comparan igual. No se comparan value, checked,
  disabled, rows, notes, summary, ni el nombre, el estado, la presentation o la zone de la pantalla, ni el when o la
  note de una variante.
- Los estados de falla (vacío, error) van como "variants" de su pantalla: así el dueño los aprueba, ve qué parte
  cambia, y se comparan. Una pantalla que repite el nombre de otra también se acepta y se dibuja como otro caso chico.
- presentation (opcional): "page" (la de siempre) o "layer", una ventana, un diálogo o un panel que se abre encima de
  otra pantalla. Una capa lleva "over" (el nombre de la pantalla de abajo) y "trigger" (el texto exacto de un botón o
  enlace de esa pantalla, el que la abre); se dibuja encima de esa pantalla, que se ve desenfocada detrás, y el botón
  que la abre va marcado en su pantalla. La maqueta fija el
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
