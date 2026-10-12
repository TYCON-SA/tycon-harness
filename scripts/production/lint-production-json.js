#!/usr/bin/env node
/**
 * lint-production-json.js — la forma de `.tycon/production.json`, verificada al commitear.
 *
 * LOS DOS NOMBRES (story 8.9, tanda P · 2026-09-30): hasta el renombre a inglés el catálogo era `.tycon/produccion.json`
 * con las claves `servidores`, `ambiente`, `llavero` y `puerto`. Los repos de producto migran en la story de retiro, y el
 * freno lee los dos nombres, así que acá se aceptan los dos —el del archivo y el de cada clave—. Lo que no se acepta es
 * tener los DOS: dos catálogos en el mismo repo, o una clave con su nombre viejo y el nuevo en el mismo objeto (el freno
 * no elige uno en silencio: ese repo le quedaría sin leer).
 *
 * QUÉ ES ESE ARCHIVO (story 6.1, AC 1): cada proyecto declara ahí sus servidores de base y si son
 * de producción. El freno `prod-access-guard.js` lo usa para saber qué host es producción; un host
 * que nadie declaró se trata COMO producción (se frena).
 *
 * POR QUÉ UNA LISTA BLANCA Y NO UNA NEGRA: el archivo vive en el repo del cliente y lo lee todo el
 * equipo. Una lista negra («que no tenga `password`») deja pasar `usuario`, `pwd`, `cadena`… Acá
 * entran SÓLO tres claves y cualquier otra rechaza el commit, nombrándola. El usuario de la base no
 * va: vive junto a la contraseña, en la entrada del Llavero.
 *
 * QUÉ NO HACE: no valida que el host exista, ni se conecta a nada. Es forma, no semántica.
 *
 * Uso:
 *   node lint-production-json.js --staged --repo <dir>   # lo que va a entrar en el commit
 *   node lint-production-json.js <archivo…>              # archivos sueltos (tests, revisión a mano)
 *
 * Salida: 0 = está bien (o no hay nada que mirar) · 1 = rechazado, con el motivo · 2 = no pude
 * mirar (git ilegible). Un «no pude mirar» NUNCA sale 0: el pre-commit tiene que frenar igual.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RUTA = /(^|\/)\.tycon\/(?:production|produccion)\.json$/;
const CLAVES_RAIZ = new Set(['servers']);
// los nombres de antes del renombre a inglés → los de ahora (ver la cabecera)
const VIEJAS_RAIZ = { servidores: 'servers' };
const VIEJAS_SERVIDOR = { ambiente: 'environment', llavero: 'keychain', puerto: 'port' };

/** El objeto con sus claves viejas pasadas a las nuevas. Las dos juntas → un motivo de rechazo. */
function aNuevas(obj, viejas, donde, malos) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const nueva = viejas[k];
    if (!nueva) { if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = v; continue; }
    if (Object.prototype.hasOwnProperty.call(obj, nueva)) { malos.push(`${donde}: «${nueva}» y su nombre viejo «${k}» están los dos: dejá sólo «${nueva}»`); continue; }
    out[nueva] = v;
  }
  return out;
}
// `base` entró el 2026-09-15, el día de la instalación: en Azure SQL no hay `USE` ni nombres de tres
// partes, así que una puerta sin base entra a `master` y toda tabla es «Invalid object name». Es un
// nombre de base, no una credencial: puede vivir en el repo.
// `port` entró el 2026-09-29: el primer producto con INSTANCIA NOMBRADA en puerto no estándar
// (SQL Server escuchando en 1435, no en 1433) no tenía forma de declararse. La puerta arma la
// conexión con `-S "host,puerto"`, que es lo que sqlcmd entiende para una instancia nombrada.
//
// 🔴 POR QUÉ UN CAMPO Y NO DEJAR LA COMA EN `host`: el host es la IDENTIDAD del servidor — con él
// la puerta lo busca en este catálogo, arma el nombre del servicio en el Llavero, y el freno lo
// reconoce cuando aparece en un comando. Si se admitiera `host,1435`, el mismo servidor tendría
// dos escrituras, y la que importa para frenar —el nombre pelado— podría no estar declarada.
// Con el puerto acá, la persona sigue tipeando el nombre pelado y NINGUNA validación se afloja.
const CLAVES_SERVIDOR = new Set(['host', 'environment', 'keychain', 'base', 'port']);
const AMBIENTES = new Set(['produccion', 'no-produccion']);
const PREFIJO_LLAVERO = 'tycon-prod-';
const HOST = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;
// sin corchetes, comillas, espacios ni `;`: va como argumento `-d` del cliente y nada más
const BASE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/**
 * @param {string} texto contenido del archivo
 * @param {string} etiqueta cómo nombrarlo en los mensajes
 * @returns {string[]} los motivos de rechazo; vacío = está bien
 */
function revisar(texto, etiqueta) {
  const malos = [];
  let doc;
  try { doc = JSON.parse(texto); } catch (e) {
    return [`${etiqueta}: no es JSON válido (${e.message})`];
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return [`${etiqueta}: la raíz tiene que ser un objeto`];
  doc = aNuevas(doc, VIEJAS_RAIZ, etiqueta, malos);
  for (const k of Object.keys(doc)) {
    if (!CLAVES_RAIZ.has(k)) malos.push(`${etiqueta}: clave de más en la raíz: «${k}» (sólo se acepta «servers»)`);
  }
  const servidores = doc.servers;
  if (!Array.isArray(servidores)) return malos.concat(`${etiqueta}: falta «servers», o no es una lista`);

  const vistos = new Map();
  servidores.forEach((s0, i) => {
    const donde = `${etiqueta} · servidor #${i + 1}`;
    if (!s0 || typeof s0 !== 'object' || Array.isArray(s0)) { malos.push(`${donde}: tiene que ser un objeto`); return; }
    const s = aNuevas(s0, VIEJAS_SERVIDOR, donde, malos);
    for (const k of Object.keys(s)) {
      if (!CLAVES_SERVIDOR.has(k)) malos.push(`${donde}: clave de más: «${k}» (sólo host, environment, keychain, base y port — el usuario de la base va en el Llavero, junto a la contraseña)`);
    }
    if ('base' in s && (typeof s.base !== 'string' || !BASE.test(s.base))) {
      malos.push(`${donde}: «base» tiene que ser un nombre de base (letras, números, «_», «.» y «-»; sin corchetes ni comillas): ${JSON.stringify(s.base)}`);
    }
    if ('port' in s && !(Number.isInteger(s.port) && s.port >= 1 && s.port <= 65535)) {
      malos.push(`${donde}: «port» tiene que ser un número entero entre 1 y 65535, sin comillas (vino ${JSON.stringify(s.port)})`);
    }
    if (typeof s.host !== 'string' || !HOST.test(s.host)) {
      malos.push(`${donde}: «host» tiene que ser un nombre de host (sin esquema, sin puerto, sin barras): ${JSON.stringify(s.host)} — si el servidor escucha en un puerto no estándar, va en «port», no acá`);
    } else {
      const clave = s.host.toLowerCase();
      if (vistos.has(clave)) malos.push(`${donde}: el host «${s.host}» ya está declarado en este archivo (servidor #${vistos.get(clave) + 1})`);
      else vistos.set(clave, i);
    }
    if (!AMBIENTES.has(s.environment)) {
      malos.push(`${donde}: «environment» tiene que ser «produccion» o «no-produccion» (vino ${JSON.stringify(s.environment)})`);
      return;
    }
    if (s.environment === 'produccion') {
      if (typeof s.keychain !== 'string' || !s.keychain) malos.push(`${donde}: un servidor de producción necesita «keychain» (la entrada del Llavero con el usuario y la contraseña)`);
      else if (!s.keychain.startsWith(PREFIJO_LLAVERO)) malos.push(`${donde}: «keychain» tiene que empezar con «${PREFIJO_LLAVERO}» (vino «${s.keychain}»)`);
    } else if ('keychain' in s) {
      malos.push(`${donde}: un servidor «no-produccion» no lleva «keychain» (no hace falta la puerta para consultarlo)`);
    }
  });
  return malos;
}

/** ¿El documento declara algún servidor de producción? (con las claves nuevas o las viejas) */
function declaraProduccion(doc) {
  if (!doc || typeof doc !== 'object') return false;
  const lista = Array.isArray(doc.servers) ? doc.servers : Array.isArray(doc.servidores) ? doc.servidores : [];
  return lista.some((x) => x && (x.environment === 'produccion' || x.ambiente === 'produccion'));
}

/** Los `.tycon/production.json` (o con su nombre viejo) STAGEADOS del repo, con su contenido del índice (no el del disco). */
function stageados(repo) {
  const git = (args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const lista = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
  if (lista.status !== 0) return { error: `no pude preguntarle a git qué hay stageado en ${repo}` };
  const rutas = lista.stdout.split('\n').map((s) => s.trim()).filter((s) => RUTA.test(s));
  const out = [];
  for (const r of rutas) {
    const blob = git(['show', `:${r}`]);
    if (blob.status !== 0) return { error: `no pude leer la versión stageada de ${r}` };
    out.push({ etiqueta: r, texto: blob.stdout });
  }
  // los dos nombres del catálogo en la misma carpeta, en lo que va a quedar commiteado: el freno no elige uno
  const dobles = [];
  if (rutas.length) {
    const todos = git(['ls-files', '--cached']);
    if (todos.status !== 0) return { error: `no pude listar los archivos de ${repo}` };
    const enIndice = new Set(todos.stdout.split('\n').map((s) => s.trim()).filter((s) => RUTA.test(s)));
    for (const r of enIndice) {
      const par = r.replace(/production\.json$/, 'produccion.json');
      if (par !== r && enIndice.has(par) && (rutas.includes(r) || rutas.includes(par))) dobles.push(`${r} y ${par}`);
    }
  }
  return { archivos: out, dobles };
}

/** ¿El repo tiene migraciones de base? Mismo criterio de carpetas que sql-compile.js (database/ o BD/), pero sobre el repo. */
function tieneMigraciones(repo) {
  try {
    return fs.readdirSync(repo, { withFileTypes: true }).some((d) => d.isDirectory() && /^(database|bd)$/i.test(d.name));
  } catch { return false; }
}

function main(argv) {
  const i = argv.indexOf('--repo');
  const repo = i >= 0 ? argv[i + 1] : process.cwd();
  let archivos;
  const malos = [];
  if (argv.includes('--staged')) {
    const r = stageados(repo);
    if (r.error) { console.error(`⛔ catálogo de producción: ${r.error}`); return 2; }
    archivos = r.archivos;
    for (const d of r.dobles) malos.push(`${d}: el catálogo está con los dos nombres (el nuevo y el de antes del renombre) — dejá sólo .tycon/production.json`);
  } else {
    archivos = argv.filter((a) => !a.startsWith('--') && a !== repo).map((a) => {
      try { return { etiqueta: path.relative(process.cwd(), a) || a, texto: fs.readFileSync(a, 'utf8') }; }
      catch (e) { return { etiqueta: a, texto: null, error: e.message }; }
    });
  }
  if (!archivos.length) return 0;

  for (const a of archivos) {
    if (a.texto === null) { malos.push(`${a.etiqueta}: no pude leerlo (${a.error})`); continue; }
    malos.push(...revisar(a.texto, a.etiqueta));
    // AC 1: producción se declara en el repo que tiene las MIGRACIONES de esa base — ahí vive el dueño
    // de la base, y ahí lo ve sólo quien tiene permiso sobre ese proyecto. Un servidor de no-producción
    // se puede declarar en cualquier repo que lo use.
    if (argv.includes('--staged')) {
      let doc = null; try { doc = JSON.parse(a.texto); } catch { /* ya lo dijo revisar() */ }
      if (declaraProduccion(doc) && !tieneMigraciones(repo)) {
        malos.push(`${a.etiqueta}: declara un servidor de PRODUCCIÓN en un repo sin migraciones (sin carpeta database/ ni BD/). Producción se declara en el repo que tiene las migraciones de esa base.`);
      }
    }
  }
  if (!malos.length) return 0;
  console.error('⛔ catálogo de producción (.tycon/production.json) rechazado:');
  for (const m of malos) console.error(`   · ${m}`);
  console.error('\n   Forma aceptada (sólo estas claves; «base» es opcional y dice a qué base entra la puerta):');
  console.error('   {"servers":[{"host":"x.database.windows.net","environment":"produccion","keychain":"tycon-prod-x","base":"xdb"},');
  console.error('               {"host":"test.bizuit.example","environment":"no-produccion"}]}');
  console.error('   Detalle: guides/produccion-con-permiso.md');
  return 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { revisar, RUTA };
