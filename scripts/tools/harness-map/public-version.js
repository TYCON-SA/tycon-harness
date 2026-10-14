#!/usr/bin/env node
/**
 * public-version.js — genera la versión PÚBLICA del mapa del arnés desde la PRIVADA (2026-09-15).
 *
 * La privada (`artifacts/mapa-arnes.html`) es la fuente: cada componente con por qué está, dónde
 * corre, cuándo, y en qué repo y archivo vive. La pública (`onboarding/mini-class/mapa-del-arnes.html`)
 * va al sitio abierto y NO puede llevar la máquina ni el canal del admin, horarios de las corridas
 * desatendidas ni los límites de cada control: juntos son un mapa de dónde conviene atacar. Los repos,
 * las rutas y el nombre en el código SÍ van (decisión del dev, 2026-09-15): son privados, así que
 * solos no dan acceso, y sirven de referencia a quien lee.
 *
 * Por qué un generador y no dos archivos: dos copias mantenidas a mano se separan solas. Acá la
 * pública se DERIVA, y lo que la privada cambie llega solo. Lo que no puede llegar solo —un texto que
 * en la pública se reescribió— lleva la huella del texto privado que reemplaza: si la privada lo
 * cambia, esto frena y dice cuál revisar. Así la pública nunca queda vieja sin que nadie lo note.
 *
 * Qué aplica (todo declarado en `publica.json`, no en este código):
 *   - fichas:     texto público por campo, con la huella del privado.
 *   - reemplazos: cambios exactos sobre el HTML, con las apariciones esperadas.
 *   - quitar:     patrones que se sacan, con las apariciones esperadas.
 *   - prohibido:  lo que no puede quedar; si aparece, frena y lo muestra.
 * Además arma el documento completo
 * (la privada no trae doctype ni head: los agrega la publicación de claude.ai) y le incrusta el selector
 * de idioma ES | EN con la versión en inglés (onboarding/mini-class/i18n/: el diccionario es en.json).
 *
 * Uso:
 *   node scripts/tools/harness-map/public-version.js            # regenera la pública
 *   node scripts/tools/harness-map/public-version.js --check    # ¿la pública está al día?
 *   opciones: --input <privada> · --config <publica.json> · --output <pública> · --i18n <inject.js>
 *   Las rutas por omisión son las del repo que tiene el mapa (artifacts/, onboarding/mini-class/): el código vive en el
 *   repo público y el mapa interno, publica.json y el sitio, en el del equipo. En un repo sin mapa no hay nada que generar.
 *
 * Salida: 0 generada o al día · 1 (--check) la pública no coincide con lo que se genera ·
 *         2 no se pudo generar (privada ilegible, texto público viejo, algo interno que se filtraba).
 *
 * Lo corre el pre-commit de este repo cuando el commit toca la privada, este directorio o la
 * pública. Casos: scripts/tests/harness-map-public.test.sh
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// vive en scripts/tools/harness-map/ desde la story 8.12, tanda R4: la raíz del arnés está tres carpetas arriba
const RAIZ = path.resolve(__dirname, '..', '..', '..');
require('../../lib/legacy-names.js').aliasArgv('scripts/tools/harness-map/public-version.js', { exitCode: 2 });
const args = process.argv.slice(2);
const opcion = (nombre, porDefecto) => {
  const i = args.indexOf(nombre);
  return i >= 0 && args[i + 1] ? args[i + 1] : porDefecto;
};
const ENTRADA = opcion('--input', path.join(RAIZ, 'artifacts', 'mapa-arnes.html'));
const CONFIG = opcion('--config', path.join(__dirname, 'publica.json'));
// la mini-clase vive en onboarding/mini-class/ desde la story 8.9, tanda F
const SALIDA = opcion('--output', path.join(RAIZ, 'onboarding', 'mini-class', 'mapa-del-arnes.html'));
const CHECK = args.includes('--check');
// el selector de idioma ES | EN (programa y diccionario) se incrusta al final, igual que en las otras páginas del sitio.
// Vive con el sitio, en el repo que tiene el mapa (onboarding/mini-class/i18n/inject.js); otro lugar, con --i18n. Se
// carga recién acá, después de leer las opciones: sin él no se genera (sale 2 y dice dónde lo buscó), nunca a medias.
const IDIOMA = opcion('--i18n', path.join(RAIZ, 'onboarding', 'mini-class', 'i18n', 'inject.js'));

const huella = (texto) => crypto.createHash('sha256').update(String(texto)).digest('hex').slice(0, 12);

function frenar(motivos) {
  console.error('⛔ mapa del arnés — no se generó la versión pública:');
  for (const m of motivos) console.error('   · ' + m);
  process.exit(2);
}

function leer(ruta, que) {
  try {
    return fs.readFileSync(ruta, 'utf8');
  } catch (e) {
    return frenar([`no pude leer ${que} (${ruta}): ${e.message}`]);
  }
}

function generar(privada, cfg) {
  const errores = [];
  let html = privada;

  // 1. Las fichas: el bloque `const D = {…};` es JSON.
  const MARCA = 'const D = ';
  const ini = html.indexOf(MARCA);
  const fin = ini < 0 ? -1 : html.indexOf('\n};\n', ini);
  if (ini < 0 || fin < 0) frenar(['no encontré el bloque de fichas (const D = {…};) en la privada']);
  let D;
  try {
    D = JSON.parse(html.slice(ini + MARCA.length, fin + 2));
  } catch (e) {
    frenar([`el bloque de fichas de la privada no se puede leer: ${e.message}`]);
  }

  for (const [id, campos] of Object.entries(cfg.fichas || {})) {
    if (!D[id]) {
      errores.push(`la ficha "${id}" tiene texto público pero ya no existe en la privada: sacala de publica.json`);
      continue;
    }
    for (const [campo, pub] of Object.entries(campos)) {
      if (!(campo in D[id])) {
        errores.push(`${id}.${campo}: ese campo no existe en la privada`);
        continue;
      }
      const actual = huella(D[id][campo]);
      if (actual !== pub.privado) {
        errores.push(`${id}.${campo}: la privada cambió desde que se escribió su texto público — revisalo en publica.json y poné "privado": "${actual}"`);
        continue;
      }
      D[id][campo] = pub.texto;
    }
  }
  const bloque = '{\n' + Object.entries(D).map(([k, v]) => '  ' + JSON.stringify(k) + ': ' + JSON.stringify(v)).join(',\n') + '\n}';
  html = html.slice(0, ini + MARCA.length) + bloque + html.slice(fin + 2);

  // 2. Reemplazos exactos.
  for (const r of cfg.reemplazos || []) {
    const esperadas = r.veces ?? 1;
    const hay = html.split(r.de).length - 1;
    if (hay !== esperadas) {
      errores.push(`reemplazo «${r.de.slice(0, 60)}»: esperaba ${esperadas} y hay ${hay} — la privada cambió ahí`);
      continue;
    }
    html = html.split(r.de).join(r.a);
  }

  // 3. Lo que se saca.
  for (const q of cfg.quitar || []) {
    const re = new RegExp(q.patron, 'g');
    const hay = (html.match(re) || []).length;
    if (hay !== q.veces) {
      errores.push(`quitar ${q.motivo}: esperaba ${q.veces} y hay ${hay} — la privada cambió ahí`);
      continue;
    }
    html = html.replace(re, q.por || '');
  }

  // 4. Nada interno puede quedar.
  for (const p of cfg.prohibido || []) {
    const m = html.match(new RegExp(p.patron, p.flags || ''));
    if (m) {
      const i = m.index;
      const contexto = html.slice(Math.max(0, i - 40), i + m[0].length + 40).replace(/\s+/g, ' ');
      errores.push(`quedaría algo interno (${p.motivo}): «${m[0]}» en «…${contexto}…»`);
    }
  }

  if (errores.length) frenar(errores);

  // 5. Documento completo: la privada no trae doctype ni head.
  const corte = html.indexOf('</style>');
  if (corte < 0) frenar(['no encontré el cierre de </style> en la privada']);
  const cabeza = html.slice(0, corte + '</style>'.length);
  const cuerpo = html.slice(corte + '</style>'.length).replace(/^\s*\n/, '');
  const doc = [
    '<!doctype html>',
    '<html lang="es">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<!-- Página generada: no se edita a mano. -->',
    '<style>body{margin:0}[hidden]{display:none!important}img{max-width:100%}</style>',
    cabeza,
    '</head>',
    '<body>',
    cuerpo.replace(/\s*$/, ''),
    '</body>',
    '</html>',
    '',
  ].join('\n');
  return { doc: incrustarIdioma(doc, 'map'), fichas: Object.keys(D).length };
}

let incrustarIdioma;
try {
  ({ inject: incrustarIdioma } = require(path.resolve(IDIOMA)));
} catch (e) {
  const motivo = !fs.existsSync(path.resolve(IDIOMA)) ? 'no está' : String((e && e.message) || e).split('\n')[0];
  frenar([`no pude cargar el selector de idioma (${IDIOMA}): ${motivo} — se pasa con --i18n <inject.js>`]);
}
if (typeof incrustarIdioma !== 'function') frenar([`el selector de idioma (${IDIOMA}) no exporta inject(html, página)`]);

const privada = leer(ENTRADA, 'la privada');
let cfg;
try {
  cfg = JSON.parse(leer(CONFIG, 'publica.json'));
} catch (e) {
  frenar([`publica.json no se puede leer: ${e.message}`]);
}
const { doc, fichas } = generar(privada, cfg);

if (CHECK) {
  let actual = null;
  try {
    actual = fs.readFileSync(SALIDA, 'utf8');
  } catch (_) {
    /* ausente = desincronizada */
  }
  if (actual !== doc) {
    console.error(`⛔ mapa del arnés — la versión pública no está al día con la privada (${SALIDA}).`);
    console.error('   Se regenera con: node scripts/tools/harness-map/public-version.js');
    process.exit(1);
  }
  console.log(`✅ mapa del arnés — la versión pública está al día (${fichas} fichas).`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(SALIDA), { recursive: true });
fs.writeFileSync(SALIDA, doc);
console.log(`✅ mapa del arnés — versión pública generada: ${SALIDA} (${fichas} fichas).`);
