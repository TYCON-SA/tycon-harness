#!/usr/bin/env node
'use strict';
// check-unreplaced-placeholders.js — que un alta no commitee un marcador de plantilla vivo
//
// POR QUÉ EXISTE (2026-09-28). Un alta de producto copia las plantillas de
// un paquete (`packs/<paquete>/templates/`, que llega con el perfil del equipo) y les reemplaza los
// marcadores: `{{PRODUCT}}`, `{{BACKEND_REPO}}`, `{{PLUGIN}}`, `{{DATE}}`… En una corrida simulada del alta contamos **~120 marcadores de 11
// tipos repartidos en más de 20 archivos**, y ningún control miraba si quedaba alguno vivo.
//
// Un marcador que sobrevive NO da error: se lee como un valor más. Los dos casos que duelen:
//   · `repo_group: [{{BACKEND_REPO}}, {{STORIES_REPO}}]` en `.tycon/advisors.yaml` → los
//     revisores buscan repos hermanos que no existen y dicen «no encontré hermanos». Parece que
//     el producto no tiene hermanos; en realidad nadie reemplazó nada.
//   · `{{SERVER_URL}}` o `{{SQL_HOST}}` en un CLAUDE.md → una instrucción que se lee como
//     decidida y manda a un servidor que no existe.
//
// QUÉ BUSCA: `{{NOMBRE_EN_MAYUSCULAS}}` — dos llaves, letras mayúsculas, dígitos y guión bajo.
// El patrón es angosto A PROPÓSITO: `{{a:number}}` de JSDoc, `{{ .Values.x }}` de Helm y
// `{{ variable }}` de las plantillas de Azure Pipelines NO son marcadores de alta y no se marcan.
//
// CÓMO FALLA: fuerte. Una ruta que no existe, un directorio que no se puede leer → exit 2 con el
// motivo. Nunca «no encontré nada» cuando en realidad no pudo mirar.
//
// SALIDA: 0 = limpio · 1 = hay marcadores vivos · 2 = no pude mirar (o llegó una opción con su nombre
// viejo y el nuevo a la vez).
//
// A mano:
//   node scripts/ci/check-unreplaced-placeholders.js [--exclude <ruta>]... <dir-o-archivo>...
//   node scripts/ci/check-unreplaced-placeholders.js            (el repo actual, desde su raíz)
//
// 🔴 NO correrlo sobre `new-product-templates/`: ahí los marcadores son el contenido. El control
// saltea esa carpeta por nombre, y también cualquier ruta que el llamador excluya con --exclude
// (story 8.9, tanda B3a: se llamaba en castellano y el nombre viejo sigue andando hasta el retiro).

const fs = require('fs');
const path = require('path');
const { esRutaDelArnes } = require('../lib/harness-repo.js');
// El traductor de las opciones viejas vive al lado (story 8.9).
const { aliasLegacyOptions, LegacyOptionsError } = (() => {
  try { return require('./legacy-options.js'); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') process.stderr.write(`⚠️  legacy-options.js no cargó (${e && e.message}): los nombres viejos de este guion no se traducen\n`); return { aliasLegacyOptions: (argv) => argv, LegacyOptionsError: Error }; }
})();

const MARCADOR = /\{\{[A-Z][A-Z0-9_]*\}\}/g;

// Carpetas que nunca se miran: o no son texto del producto, o los marcadores son su contenido.
const CARPETAS_SALTEADAS = new Set([
  '.git', 'node_modules', 'bin', 'obj', 'dist', 'coverage', 'TestResults',
  '.vs', '.idea', '.engram',
  'new-product-templates',   // acá los marcadores SON el contenido
]);

/** ¿Es la carpeta de plantillas de un paquete (`packs/<paquete>/templates`)? Ahí los marcadores también son el contenido. */
function esPlantillaDePaquete(dir) {
  return path.basename(dir) === 'templates' && path.basename(path.dirname(path.dirname(dir))) === 'packs';
}

const EXTENSIONES = new Set([
  '.md', '.yaml', '.yml', '.json', '.cs', '.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs',
  '.sql', '.sh', '.txt', '.template', '.props', '.csproj', '.sln', '.env', '.example',
]);

function morir(motivo) {
  console.error(`⛔ marcadores: no pude mirar — ${motivo}`);
  process.exit(2);
}

function esTexto(p) {
  const ext = path.extname(p);
  if (EXTENSIONES.has(ext)) return true;
  // Archivos sin extensión que sí son texto del producto (pre-commit, Dockerfile…).
  return ext === '' && /^(pre-commit|post-commit|Dockerfile|Makefile|\.gitignore|\.gitleaksignore)$/
    .test(path.basename(p));
}

function recorrer(raiz, excluidas, acc) {
  let entradas;
  try {
    entradas = fs.readdirSync(raiz, { withFileTypes: true });
  } catch (e) {
    morir(`no pude leer el directorio ${raiz}: ${e.message}`);
  }
  for (const e of entradas) {
    const completa = path.join(raiz, e.name);
    if (excluidas.some((x) => completa === x || completa.startsWith(x + path.sep))) continue;
    if (e.isDirectory()) {
      if (CARPETAS_SALTEADAS.has(e.name) || esPlantillaDePaquete(completa)) continue;
      recorrer(completa, excluidas, acc);
    } else if (e.isFile() && esTexto(completa)) {
      acc.push(completa);
    }
  }
}

function main(argv0) {
  let argv;
  try { argv = aliasLegacyOptions(argv0, 'excluir:exclude', 'scripts/ci/check-unreplaced-placeholders.js'); }
  catch (e) {
    if (!(e instanceof LegacyOptionsError)) throw e;
    morir(e.message);
  }
  const excluidas = [];
  const objetivos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--exclude') {
      const v = argv[++i];
      if (!v) morir('--exclude sin ruta');
      excluidas.push(path.resolve(v));
    } else {
      objetivos.push(argv[i]);
    }
  }
  if (objetivos.length === 0) objetivos.push('.');

  const archivos = [];
  for (const o of objetivos) {
    const abs = path.resolve(o);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      morir(`la ruta ${o} no existe: no se puede dar por limpia una ruta que no se miró`);
    }
    // 🔴 Apuntar el control DIRECTO a una carpeta salteada es un error de quien lo llama, y
    // hay que decirlo: el salteo por nombre sólo actúa al recorrer, así que sin esto
    // `... new-product-templates` reportaría los marcadores que SON el contenido de la
    // plantilla, y el que lo lea va a creer que un alta quedó a medias.
    // 🔴 El arnés NO es un producto. Su propio texto habla DE los marcadores —esta cabecera
    // sin ir más lejos, el `{{NONCE}}` del banco de controles, el README de las plantillas de
    // CI— así que acá el control da falsos positivos por diseño. Que falle fuerte evita que
    // alguien lo cablee al CI del arnés y lo deje en rojo permanente, que es como muere un
    // control: nadie lo mira más.
    if (esRutaDelArnes(abs)) {
      morir(`${o} está dentro del repo del arnés, que no es un producto: acá los marcadores son `
        + `texto sobre marcadores. Apuntalo a los repos del producto nuevo.`);
    }
    if (CARPETAS_SALTEADAS.has(path.basename(abs)) || esPlantillaDePaquete(abs)) {
      morir(`${o} es una carpeta que este control saltea a propósito (ahí los marcadores son el `
        + `contenido). Apuntalo a los repos del producto, no a las plantillas.`);
    }
    if (st.isDirectory()) recorrer(abs, excluidas, archivos);
    else archivos.push(abs);
  }

  if (archivos.length === 0) {
    morir('no había ni un archivo de texto para mirar en lo que me pasaste');
  }

  const hallazgos = [];
  for (const f of archivos) {
    let contenido;
    try {
      contenido = fs.readFileSync(f, 'utf8');
    } catch (e) {
      morir(`no pude leer ${f}: ${e.message}`);
    }
    const lineas = contenido.split('\n');
    lineas.forEach((linea, i) => {
      const m = linea.match(MARCADOR);
      if (m) hallazgos.push({ archivo: path.relative(process.cwd(), f), linea: i + 1, marcadores: [...new Set(m)] });
    });
  }

  if (hallazgos.length === 0) {
    console.log(`✅ marcadores: limpio — ${archivos.length} archivo(s) mirados, ningún {{MARCADOR}} vivo`);
    return 0;
  }

  const porTipo = new Map();
  for (const h of hallazgos) for (const m of h.marcadores) porTipo.set(m, (porTipo.get(m) || 0) + 1);

  console.error(`🛑 marcadores: ${hallazgos.length} línea(s) con un marcador de plantilla sin reemplazar`);
  console.error('');
  console.error('Por marcador:');
  for (const [m, n] of [...porTipo.entries()].sort((a, b) => b[1] - a[1])) {
    console.error(`  ${String(n).padStart(4)}  ${m}`);
  }
  console.error('');
  console.error('Dónde:');
  for (const h of hallazgos.slice(0, 40)) {
    console.error(`  ${h.archivo}:${h.linea}  ${h.marcadores.join(' ')}`);
  }
  if (hallazgos.length > 40) console.error(`  … y ${hallazgos.length - 40} más`);
  console.error('');
  console.error('Un marcador vivo NO da error en ningún lado: se lee como un valor más. Reemplazalos');
  console.error('antes de commitear — la tabla de marcadores está en el README.md de las plantillas del paquete (packs/<paquete>/templates/ del arnés).');
  return 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { main, MARCADOR };
