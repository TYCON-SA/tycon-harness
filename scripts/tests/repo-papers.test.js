'use strict';

/**
 * repo-papers.test.js — los papeles del repo público, medidos donde viven (story 8.7, tanda A · T10-T14; traída del
 * repo privado el 2026-10-13, story 8.26, desde su public-papers.test.js: lleva otro nombre para que el árbol armado
 * —el privado con el público encima— no tenga dos archivos en la misma ruta mientras el privado conserve el suyo).
 *
 * Los papeles son lo que hace de este repo un proyecto que se puede usar de afuera: `LICENSE`, `NOTICE`, las dos
 * portadas (`README.md` y `README.es.md`, en la raíz desde 2026-10-14), `.github/CONTRIBUTING.md`, `.github/CODE_OF_CONDUCT.md`,
 * `.github/SECURITY.md`, la CI (`.github/workflows/ci.yml`), las tres páginas de primeros pasos (`getting-started/`), el
 * guion de entrada (`scripts/setup/get-harness.{sh,ps1}`), la lista de remotos públicos
 * (`scripts/setup/public-remotes.json`) y la página de ejemplo del registro de incidentes (`guides/maintaining/incident-log.md`).
 * Hasta el 2026-10-13 vivían en el repo privado como plantillas (`scripts/publishing/public-files/<destino>`, con la
 * dirección del repo por marcadores) y el exportador las ponía en su lugar; desde esa noche se escriben acá, en su ruta
 * real, con la dirección ya puesta. Esta suite los lee en esa ruta (`RAIZ/<destino>`) y los compara contra lo que existe
 * en este mismo repo: el manifiesto de terceros, la lista de hooks, la lista de efectos, el instalador, las skills y los
 * paquetes (en el repo unido viven en `skills/` y `packs/`, no en un clon aparte). No usa red ni herramientas de afuera.
 *
 * Lo que no se puede perder:
 *   · T10 — la licencia es el texto canónico de la ASF byte a byte.
 *   · T11 — el NOTICE trae titular, licencia, marcas y una línea `* <ruta>` por cada `derived` del manifiesto, con su
 *     origen, licencia, copyright y el aviso MIT debajo.
 *   · T12 — CONTRIBUTING, CODE_OF_CONDUCT y SECURITY dicen lo que pide el AC 3.
 *   · T13 — las dos portadas cumplen el mismo contrato: secciones, bloques marcados idénticos, instalación de una línea;
 *     y ningún papel quedó con un marcador `{{public-*}}` sin reemplazar ni con otra dirección que la declarada.
 *   · T14 — lo que nombran (hooks, integraciones, variables, subcomandos) existe de verdad.
 *   · T33 de la story 8.13 (tanda D) — la portada del mecanismo de instalación: una línea para instalar, y «cómo se
 *     actualiza» con los comandos, la retención, los números de versión y la copia fija; el permiso de lectura; las 6
 *     horas; Node 22. Por palabras clave, en los dos idiomas, cada una con su espejo.
 *   · T35 (tanda C) — la guía de publicación le dice a la story 8.8 qué recibe, punto por punto (AC 27).
 *
 * Lo que la versión del privado medía y acá no está, porque es de la tubería privada de publicación y no existe en este
 * repo: que los repos internos no lleven `LICENSE`, el contacto permitido en `denylist.json`, los sintéticos de
 * `allowlist.json` que traían cada papel desde `public-files/`, `public-repos.json` (acá el nombre público lo declara
 * `scripts/setup/public-remotes.json`) y la evidencia de la story 8.7 en `specs/`. Cada lugar lo dice donde estaba.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const PUBLISHING = path.join(RAIZ, 'scripts', 'publishing');

// Los papeles, por la ruta donde viven en este repo. Son los quince que en el privado eran plantillas de
// scripts/publishing/public-files/<destino>, uno a uno.
const PAPERS = [
  '.github/CODE_OF_CONDUCT.md', '.github/CONTRIBUTING.md', 'README.es.md', 'README.md', '.github/SECURITY.md',
  '.github/workflows/ci.yml', 'LICENSE', 'NOTICE', 'getting-started/linux.md', 'getting-started/mac.md',
  'getting-started/windows.md', 'guides/maintaining/incident-log.md', 'scripts/setup/get-harness.ps1', 'scripts/setup/get-harness.sh',
  'scripts/setup/public-remotes.json',
];

// La dirección del repo público. En el privado los papeles la llevaban por marcadores (`{{public-org}}/{{public-repo}}`)
// y el nombre vivía en `public-repos.json`; acá los papeles ya la traen puesta y el único lugar que la declara es
// `scripts/setup/public-remotes.json` (el programa de instalación reconoce con ella un clon del público). La prueba la lee
// de ahí y no la escribe: el nombre del repo público escrito fuera de un .md frena otros controles.
function declaredPublicRepo() {
  try {
    const { remotes } = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'setup', 'public-remotes.json'), 'utf8'));
    const m = Array.isArray(remotes) && remotes.length === 1 ? /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(remotes[0]) : null;
    return m ? { org: m[1], repo: m[2] } : { error: `tiene que traer UN remoto https://github.com/<org>/<repo>: ${JSON.stringify(remotes)}` };
  } catch (e) {
    return { error: e.message };
  }
}
const PUBLIC_REPO = declaredPublicRepo();
const ORG_REPO = PUBLIC_REPO.error ? '<sin dirección declarada>' : `${PUBLIC_REPO.org}/${PUBLIC_REPO.repo}`;
// La carpeta del clon en el comando de la portada lleva el nombre del repo: también sale de la lista, no se escribe.
const CLONE_DIR = PUBLIC_REPO.error ? '<sin dirección declarada>' : PUBLIC_REPO.repo;
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// T10: el texto canónico, con su fuente. La prueba no baja nada: compara contra el hash guardado acá.
const LICENSE_SOURCE = 'https://www.apache.org/licenses/LICENSE-2.0.txt';
const LICENSE_SHA256 = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30';
const LICENSE_BYTES = 11358;
const LICENSE_LINES = 202;

const CONTACT = 'info@tycon.com.ar';
const MIT_PERMISSION = 'Permission is hereby granted, free of charge, to any person obtaining a copy';

// T13: las secciones de las dos portadas, en orden (inglés, castellano). Desde 2026-10-06 (portada clara) la parte de
// arriba lleva al lector de lo que gana a tenerlo instalado y trabajando: qué cambia antes de instalar, qué necesita,
// instalar con Claude Code y empezar a trabajar. Todo lo demás va debajo de «Referencia», sin cambios de contenido.
const SECTIONS = [
  ['Before you install: what changes on your machine', 'Antes de instalar: qué cambia en tu máquina'],
  ['What you need', 'Qué necesitás'],
  // story 8.40 (AC 15): con el paquete publicado, la entrada principal es la línea npx, antes del camino con Claude
  ['Install in one line', 'Instalar en una línea'],
  ['Install with Claude Code', 'Instalar con Claude Code'],
  ['Start working', 'Empezar a trabajar'],
  // 2026-10-13 (pedido del dueño): la sección para quien arma el arnés en una organización, y una tabla de a dónde seguir
  ['For an organization', 'Para una organización'],
  ['Where to go next', 'Dónde seguir'],
  ['License and trademarks', 'Licencia y marcas'],
  // 2026-10-14 (pedido del dueño): la «Referencia» se mudó entera a getting-started/reference(.es).md, con los bloques de
  // instalación. Las pruebas leen la portada y la referencia juntas (readCover): de acá para abajo, la referencia
  ['What it is and what it isn\'t', 'Qué es y qué no es'],
  ['Requirements', 'Requisitos'],
  ['Install by hand', 'Instalar a mano'],
  // el arnés funciona sin sitio: qué necesita cada caso, dónde vive cada configuración y qué pisa cada máquina
  ['With or without the site', 'Con sitio o sin sitio'],
  // story 8.40, tanda B: el alta guiada de la organización (harness.js team-init), después de las formas de instalar
  ['Set up your organization', 'Dar de alta tu organización'],
  ['Profiles', 'Perfiles'],
  // story 8.41: el núcleo no trae paquetes; la sección dice que llegan con el perfil del equipo
  ['Your team\'s packs', 'Los paquetes de tu equipo'],
  ['What is optional', 'Qué es opcional'],
  ['What it writes on your machine and what it does on its own', 'Qué escribe en tu máquina y qué hace solo'],
  ['Your product repo', 'El repo del producto'],
  ['Offline', 'Sin red'],
  // story 8.40 (AC 43): cómo pasar por un proxy o por la CA de la empresa, y cómo desinstalar
  ['With a proxy or your company\'s CA', 'Con un proxy o la CA de tu empresa'],
  ['Uninstall', 'Desinstalar'],
  ['How it updates', 'Cómo se actualiza'],
];
const BLOCKS = ['requirements', 'install:core', 'install:unattended', 'install:clone', 'install:clone-unattended'];
// la frase con que el paquete del stack del equipo se describe (su manifiesto vive en el perfil del equipo desde la 8.41)
const STACK_PHRASE = { es: 'el paquete del stack de TYCON: .NET + React/Next.js sobre Bizuit' };
// La marca BMad fuera de los identificadores sólo puede aparecer en la frase de compatibilidad (política de marca).
const BMAD_COMPAT = {
  en: 'uses BMad Method (MIT); it is not affiliated with or endorsed by BMad Code, LLC',
  es: 'usa BMad Method, MIT; no está afiliado ni respaldado por BMad Code, LLC',
};
// La parte fija del mensaje de `paquetesActivos()` (packs.js de agent-skills) para un paquete pedido y no instalado.
const PACK_MISSING_MESSAGE = 'el repo declara el paquete «<nombre>» en `packs:` y no está instalado en';
// La instalación de la portada (story 8.23, tanda E · AC 33): tres líneas por sistema —bajar el guion, leerlo,
// correrlo—, sin git. La bajada va por raw.githubusercontent.com, no por la API: sin credencial, la API tiene un tope de 60
// consultas por hora por conexión y una máquina nueva no llegaba ni a correr el guion (deuda DEF-8.34-portada-por-la-api). La URL es la del repo público declarado. Desde que el repo de la versión publicada es público (story
// 8.26, AC 66) la primera línea va SIN credencial: ni la cabecera `Authorization` ni la variable del permiso (T80).
const SCRIPT_URL = (file) => `https://raw.githubusercontent.com/${ORG_REPO}/main/scripts/setup/${file}`;
const INSTALL_LINES = {
  bash: [`curl -fsSL -o get-harness.sh ${SCRIPT_URL('get-harness.sh')}`, 'less get-harness.sh', 'bash get-harness.sh'],
  powershell: [`Invoke-WebRequest -OutFile get-harness.ps1 ${SCRIPT_URL('get-harness.ps1')}`, 'Get-Content get-harness.ps1', 'pwsh -File get-harness.ps1'],
};
/** Las mismas tres líneas, la última con las opciones de install (`install:unattended`). */
const withOptions = (shell, options) => [INSTALL_LINES[shell][0], INSTALL_LINES[shell][1], `${INSTALL_LINES[shell][2]} -- ${options}`];
// El clon, modo desarrollador (`install:clone`): el comando de la 8.13, para quien mantiene el arnés; no para usarlo.
const CLONE_LINE = {
  bash: `git clone https://github.com/${ORG_REPO} ${CLONE_DIR} && node ${CLONE_DIR}/scripts/setup/harness.js install`,
  powershell: `git clone https://github.com/${ORG_REPO} ${CLONE_DIR}; node ${CLONE_DIR}/scripts/setup/harness.js install`,
};
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification', 'SessionEnd'];

// ── utilidades ──────────────────────────────────────────────────────────────────────────────────────────────────
const exists = (abs) => fs.existsSync(abs);
const readPaper = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
// La portada y su referencia (getting-started/reference(.es).md, donde viven desde 2026-10-14 los bloques de instalación
// y todo lo de consultar), leídas juntas: los contratos buscan por título de sección, y ningún título se repite entre las dos
const REFERENCE = { en: 'getting-started/reference.md', es: 'getting-started/reference.es.md' };
const readCover = (lang) => `${readPaper({ en: 'README.md', es: 'README.es.md' }[lang])}\n${readPaper(REFERENCE[lang])}`;
const readJson = (abs) => JSON.parse(fs.readFileSync(abs, 'utf8'));

/** Las líneas de un markdown con una marca de si están dentro de un cerco de código. */
function linesWithFence(text) {
  let inFence = false;
  return text.split('\n').map((line, i) => {
    const fence = /^\s*(```|~~~)/.test(line);
    const out = { n: i + 1, line, inFence: inFence || fence };
    if (fence) inFence = !inFence;
    return out;
  });
}
const headings = (text) => linesWithFence(text).filter((l) => !l.inFence && /^## /.test(l.line)).map((l) => l.line.slice(3).trim());

/** Los cercos de código: [{ lang, body }]. */
function fences(text) {
  const out = [];
  const re = /^(```|~~~)([^\n]*)\n([\s\S]*?)^\1[ \t]*$/gm;
  let m;
  while ((m = re.exec(text))) out.push({ lang: m[2].trim(), body: m[3] });
  return out;
}

/** El contenido entre `<!-- name -->` y `<!-- /name -->`, cada marcador solo en su línea. Tira si no está una vez. */
function block(text, name, file) {
  const open = `<!-- ${name} -->`;
  const close = `<!-- /${name} -->`;
  const lines = text.split('\n');
  const opens = lines.map((l, i) => (l.trim() === open ? i : -1)).filter((i) => i >= 0);
  const closes = lines.map((l, i) => (l.trim() === close ? i : -1)).filter((i) => i >= 0);
  assert.strictEqual(opens.length, 1, `${file}: el bloque ${open} tiene que abrir una vez (abre ${opens.length})`);
  assert.strictEqual(closes.length, 1, `${file}: el bloque ${open} tiene que cerrar una vez con ${close} (cierra ${closes.length})`);
  assert.ok(closes[0] > opens[0], `${file}: ${close} está antes de ${open}`);
  return lines.slice(opens[0] + 1, closes[0]).join('\n');
}

/** La sección `## <title>` hasta la siguiente `## `. */
function section(text, title) {
  const lines = linesWithFence(text);
  const start = lines.findIndex((l) => !l.inFence && l.line.trim() === `## ${title}`);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => !l.inFence && /^## /.test(l.line));
  return (end < 0 ? rest : rest.slice(0, end)).map((l) => l.line).join('\n');
}

/** La primera tabla de un texto: { header: [celdas], rows: [[celdas]] }, o null. */
function firstTable(text) {
  const lines = linesWithFence(text).filter((l) => !l.inFence);
  const i = lines.findIndex((l) => /^\s*\|/.test(l.line));
  if (i < 0) return null;
  const tableLines = [];
  for (let j = i; j < lines.length && /^\s*\|/.test(lines[j].line); j++) tableLines.push(lines[j]);
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
  const [head, sep, ...rows] = tableLines;
  assert.ok(sep && /^[\s|:-]+$/.test(sep.line), 'la tabla no tiene su fila separadora');
  return { header: cells(head.line), rows: rows.map((r) => ({ n: r.n, cells: cells(r.line) })) };
}
const unTick = (s) => s.replace(/`/g, '').trim();

/** El primer párrafo después del título `# …`. */
function firstParagraph(text) {
  const lines = text.split('\n');
  const h1 = lines.findIndex((l) => /^# /.test(l));
  const body = [];
  for (const l of lines.slice(h1 + 1)) {
    if (!l.trim()) { if (body.length) break; continue; }
    body.push(l);
  }
  return body.join(' ');
}
function assertEnglishParagraph(p, file) {
  assert.ok(p, `${file}: falta el primer párrafo`);
  assert.match(p, /\bthe\b/i, `${file}: el primer párrafo tiene que estar en inglés: ${p.slice(0, 120)}`);
  assert.doesNotMatch(p, /\b(el|los|las|del|para|que|una)\b/i, `${file}: el primer párrafo tiene que estar en inglés, no en castellano: ${p.slice(0, 120)}`);
}

/** Corre un script del arnés en una HOME temporal (sin perfil del equipo: lo que vería alguien de afuera). */
function runHarnessScript(rel, args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-papers-home.'));
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_NO_NIGHTLY_EXAM: '1', TYCON_NO_GUI_ENV: '1', TYCON_CODEX: '0', TYCON_PROFILE: '0' };
    const r = spawnSync(process.execPath, [path.join(RAIZ, rel), ...args], { env, encoding: 'utf8', cwd: home });
    assert.strictEqual(r.status, 0, `no pude correr ${rel} ${args.join(' ')} (exit ${r.status}): ${r.stderr}`);
    return r.stdout;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/**
 * Los hooks que registra el arnés: los de scripts/setup/hooks-list.json, LA lista que leen los dos instaladores desde la
 * story 8.17 (tanda W3 · AC 27). Antes se leían del texto de install-tycon-hooks.sh.
 */
function installerHooks() {
  const list = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'setup', 'hooks-list.json'), 'utf8')).hooks;
  const pairs = new Map();
  for (const h of list) {
    assert.ok(EVENTS.includes(h.event) && /\.(js|sh)$/.test(h.spec), `no entiendo el registro de la lista: ${JSON.stringify(h).slice(0, 120)}`);
    const name = h.spec.replace(/^@tcg:/, '');
    pairs.set(`${h.event} ${name}`, { event: h.event, script: name });
  }
  return { count: list.length, pairs };
}

/** El texto donde una variable `TYCON_*` nombrada tiene que existir (AC 4, T14). */
function variableCorpus({ withHooks = false } = {}) {
  const files = [
    'scripts/install-tycon-hooks.sh',
    // desde la W3 de la 8.17 los interruptores de los hooks viven en la lista única y su aplicador
    'scripts/setup/hooks-list.json',
    'scripts/setup/apply-hooks.js',
    'scripts/setup/sync-claude-md-blocks.sh',
    'scripts/lib/tycon-config.js',
    'scripts/setup/harness.js',
    // El paso de terceros del instalador: su tope de red (`TYCON_THIRD_PARTY_NETWORK_BUDGET_S`) vive acá (AC 23).
    'scripts/publishing/install-third-party.js',
    // La consulta al modelo del portón de edición: su interruptor (`TYCON_LANE_LLM`) vive acá (story 8.16, AC 5).
    'skills/tycon-pipeline/scripts/lib/lane-classifier.js',
    // El guion de entrada de la portada (story 8.23, tanda E): el permiso de lectura le llega por `TYCON_GITHUB_TOKEN`.
    'scripts/setup/get-harness.sh',
  ].map((f) => path.join(RAIZ, f));
  const harnessDir = path.join(RAIZ, 'scripts', 'setup', 'harness');
  for (const f of fs.readdirSync(harnessDir)) if (f.endsWith('.js')) files.push(path.join(harnessDir, f));
  if (withHooks) {
    const hooksDir = path.join(RAIZ, 'scripts', 'hooks');
    for (const f of fs.readdirSync(hooksDir)) if (/\.(js|sh)$/.test(f)) files.push(path.join(hooksDir, f));
  }
  return files.filter(exists).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}
const namedVariables = (text) => [...new Set(text.match(/\bTYCON_[A-Z0-9_]+\b/g) || [])];

const README = { en: 'README.md', es: 'README.es.md' };
// Los pedidos de instalación guiada que un dev de afuera le pega a Claude Code (enlazados desde «Instalación»).
// los tres (el de Linux desde la story 8.23 E: la portada lo enlaza y se reescribió con la misma bajada del guion)
const GUIDED_PAPERS = ['getting-started/windows.md', 'getting-started/mac.md', 'getting-started/linux.md'];

// ── T10 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
test('Papeles_Licencia_TextoCanonico', () => {
  const file = path.join(RAIZ, 'LICENSE');
  assert.ok(exists(file), 'falta LICENSE en la raíz del repo');
  const buf = fs.readFileSync(file);
  assert.strictEqual(buf.length, LICENSE_BYTES, `LICENSE: ${buf.length} bytes, el canónico (${LICENSE_SOURCE}) tiene ${LICENSE_BYTES}`);
  assert.strictEqual(buf.toString('utf8').split('\n').length - 1, LICENSE_LINES, `LICENSE: el canónico tiene ${LICENSE_LINES} líneas`);
  assert.strictEqual(crypto.createHash('sha256').update(buf).digest('hex'), LICENSE_SHA256,
    `LICENSE no es el texto canónico de ${LICENSE_SOURCE} byte a byte`);
  // (el privado medía además que los repos internos —el arnés y agent-skills— NO llevan LICENSE en su raíz: es una
  // regla de los repos internos, y acá la raíz es la del público, que sí la lleva)
});

// ── T11 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
test('Papeles_Notice_TitularMarcasYDerivadas', () => {
  const notice = readPaper('NOTICE');
  assert.match(notice, /Copyright 2026 TYCON/, 'NOTICE: falta «Copyright 2026 TYCON»');
  assert.match(notice, /Licensed under the Apache License, Version 2\.0/, 'NOTICE: falta la línea de licencia');
  const marks = notice.split('\n').filter((l) => /trademark/i.test(l)).join(' ');
  for (const mark of ['TYCON', 'Bizuit', 'BMad']) assert.match(marks, new RegExp(mark), `NOTICE: la nota de marcas no nombra ${mark}`);
  assert.match(notice, /section 6/i, 'NOTICE: la nota de marcas tiene que citar la sección 6 de la licencia');

  const manifest = readJson(path.join(PUBLISHING, 'third-party-skills.json'));
  const allow = readJson(path.join(PUBLISHING, 'allowlist.json'));
  const renames = (allow.skillRenames || []);
  const inCopy = (d) => {
    const r = renames.find((x) => x.source === d.repo && x.from === d.target);
    return r ? r.to : d.target;
  };
  const lines = notice.split('\n');
  const bulletLines = lines.map((l, i) => ({ l, i })).filter((x) => /^\* /.test(x.l));
  const bulletPath = (l) => l.slice(2).split(/\s/)[0].replace(/`/g, '');
  const expected = manifest.derived.map(inCopy);
  assert.ok(expected.length >= 13, `el manifiesto trae ${expected.length} derived; se esperan al menos 13`);
  assert.deepStrictEqual([...bulletLines.map((x) => bulletPath(x.l))].sort(), [...expected].sort(),
    'NOTICE: tiene que haber exactamente una línea `* <ruta>` por cada derived del manifiesto (con su ruta en la copia)');

  const mitIdx = lines.map((l, i) => (l.includes(MIT_PERMISSION) ? i : -1)).filter((i) => i >= 0);
  for (const d of manifest.derived) {
    const p = inCopy(d);
    const b = bulletLines.find((x) => bulletPath(x.l) === p);
    assert.ok(b.l.includes(d.based_on.origin), `NOTICE: la línea de ${p} no nombra su origen ${d.based_on.origin}`);
    assert.ok(b.l.includes(d.license), `NOTICE: la línea de ${p} no nombra su licencia ${d.license}`);
    assert.ok(b.l.includes(d.copyright), `NOTICE: la línea de ${p} no nombra su copyright «${d.copyright}»`);
    if (d.license === 'MIT') assert.ok(mitIdx.some((i) => i > b.i), `NOTICE: falta el aviso MIT debajo de ${p}`);
  }
  const renamed = bulletLines.find((x) => bulletPath(x.l) === 'skills/tycon-create-story');
  assert.ok(renamed, 'NOTICE: falta la línea de skills/tycon-create-story');
  assert.match(renamed.l, /bmad-create-story/, 'NOTICE: la de tycon-create-story tiene que nombrar su origen bmad-create-story');
  assert.match(renamed.l, /BMad Method/, 'NOTICE: la de tycon-create-story tiene que nombrar BMad Method');
  assert.match(renamed.l, /renombrada como pide su política de marca/, 'NOTICE: la de tycon-create-story tiene que decir que se renombró por la política de marca');
});

// ── T12 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
test('Papeles_Comunidad_SusSecciones', () => {
  const contributing = readPaper('.github/CONTRIBUTING.md');
  const coc = readPaper('.github/CODE_OF_CONDUCT.md');
  const security = readPaper('.github/SECURITY.md');
  for (const [file, text] of [['CONTRIBUTING.md', contributing], ['CODE_OF_CONDUCT.md', coc], ['SECURITY.md', security]]) {
    assertEnglishParagraph(firstParagraph(text), file);
  }

  // CONTRIBUTING: los pull requests son bienvenidos (decisión del dueño, 2026-10-13: el público es la fuente, ya no un
  // espejo), cómo correr lo de la CI, las dos reglas de escritura, licencia e idioma.
  assert.doesNotMatch(contributing, /espejo|mirror|sincronizaci/i, 'CONTRIBUTING: el repo ya no es un espejo que se sincroniza');
  assert.match(contributing, /bienvenidos/, 'CONTRIBUTING: tiene que decir que los pull requests son bienvenidos');
  assert.match(contributing, /TYCON lo revisa y decide/, 'CONTRIBUTING: tiene que decir quién revisa y decide');
  assert.match(contributing, /se mergea acá/, 'CONTRIBUTING: tiene que decir que uno aceptado se mergea en este repo');
  assert.match(contributing, /se cierra con su motivo/, 'CONTRIBUTING: tiene que decir que uno no aceptado se cierra con su motivo');
  assert.match(contributing, /\(un fork\)/, 'CONTRIBUTING: tiene que decir qué pasa por ahora con un pull request desde una copia');
  assert.ok(contributing.includes('bash scripts/ci/public-ci.sh'), 'CONTRIBUTING: falta cómo correr lo mismo que la CI');
  assert.ok(contributing.includes('guides/maintaining/nombres-en-ingles.md'), 'CONTRIBUTING: falta la regla de nombres en inglés');
  assert.match(contributing, /nombres inventados/, 'CONTRIBUTING: falta la regla de ejemplos con nombres inventados');
  assert.match(contributing, /Apache-2\.0/, 'CONTRIBUTING: falta que una contribución entra bajo Apache-2.0');
  assert.match(contributing, /\bCLA\b/, 'CONTRIBUTING: tiene que decir que no hay CLA');
  assert.match(contributing, /castellano o en inglés/, 'CONTRIBUTING: falta que issues y pull requests pueden ir en castellano o en inglés');

  // CODE_OF_CONDUCT: el Contributor Covenant 2.1, texto oficial con su atribución y el contacto puesto.
  assert.match(coc, /Contributor Covenant/, 'CODE_OF_CONDUCT: no es el Contributor Covenant');
  assert.ok(coc.includes('https://www.contributor-covenant.org/version/2/1/code_of_conduct.html'), 'CODE_OF_CONDUCT: falta la atribución a la versión 2.1');
  assert.match(coc, /## Attribution/, 'CODE_OF_CONDUCT: falta la sección de atribución del texto oficial');
  assert.ok(coc.includes('Mozilla'), 'CODE_OF_CONDUCT: la atribución oficial nombra la escalera de Mozilla');
  assert.ok(coc.includes(CONTACT), `CODE_OF_CONDUCT: falta el contacto ${CONTACT}`);
  assert.doesNotMatch(coc, /\[INSERT|\[INSERTAR/, 'CODE_OF_CONDUCT: quedó el marcador del contacto sin reemplazar');

  // SECURITY: los dos canales privados, qué cubre, terceros a su origen, sin plazos.
  assert.match(security, /private vulnerability reporting/i, 'SECURITY: falta el reporte privado de vulnerabilidades de GitHub');
  assert.match(security, /reporte privado de vulnerabilidades/, 'SECURITY: falta el reporte privado de vulnerabilidades (castellano)');
  assert.ok(security.includes(CONTACT), `SECURITY: falta ${CONTACT}`);
  assert.ok(security.includes('third-party-skills.json'), 'SECURITY: una skill de terceros se reporta a su origen, que nombra el manifiesto');
  assert.match(security, /no hay plazos de respuesta comprometidos/, 'SECURITY: tiene que decir que no hay plazos de respuesta comprometidos');
  assert.doesNotMatch(security, /\b\d+\s*(días|horas|days|hours)\b/i, 'SECURITY: no compromete plazos');

  // (el privado medía además que el contacto está permitido, con su motivo, en scripts/publishing/denylist.json: la lista
  // de denegación del detector de publicación es privada y no está en este repo)
});

// ── T13 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
test('Papeles_Portadas_MismoContratoEnDosIdiomas', async (t) => {
  const text = { en: readCover('en'), es: readCover('es') };
  assert.match(text.en, /\]\(README\.es\.md\)/, 'la portada en inglés tiene que enlazar a README.es.md');
  assert.match(text.es, /\]\(README\.md\)/, 'la portada en castellano tiene que enlazar a README.md');

  assert.deepStrictEqual(headings(text.en), SECTIONS.map((s) => s[0]), 'README.md: secciones o su orden');
  assert.deepStrictEqual(headings(text.es), SECTIONS.map((s) => s[1]), 'README.es.md: secciones o su orden');

  for (const name of BLOCKS) {
    assert.strictEqual(block(text.en, name, README.en), block(text.es, name, README.es),
      `el bloque <!-- ${name} --> tiene que ser byte a byte igual en las dos portadas`);
  }

  // install:core: tres líneas por sistema —bajar el guion, leerlo, correrlo—, con la URL por marcadores (story 8.23 E).
  const core = fences(block(text.en, 'install:core', README.en));
  for (const lang of ['bash', 'powershell']) {
    const f = core.filter((x) => x.lang === lang);
    assert.strictEqual(f.length, 1, `install:core: tiene que haber un bloque ${lang}`);
    const body = f[0].body.split('\n').filter((l) => l.trim());
    assert.deepStrictEqual(body, INSTALL_LINES[lang], `install:core (${lang}): las tres líneas de la portada sin git (bajar, leer, correr)`);
  }
  // install:clone: el modo desarrollador, una línea por sistema, el comando de la 8.13 (para quien mantiene el arnés)
  const clone = fences(block(text.en, 'install:clone', README.en));
  for (const lang of ['bash', 'powershell']) {
    const f = clone.filter((x) => x.lang === lang);
    assert.strictEqual(f.length, 1, `install:clone: tiene que haber un bloque ${lang}`);
    assert.deepStrictEqual(f[0].body.split('\n').filter((l) => l.trim()), [CLONE_LINE[lang]], `install:clone (${lang}): una sola línea, el clon y harness.js install`);
  }

  // La dirección del repo público. En el privado los papeles la llevaban por marcadores y el nombre vivía en
  // public-repos.json (que no está en este repo); acá cada papel la trae ya puesta: ningún marcador sin reemplazar, y
  // toda dirección del arnés en GitHub es la que declara scripts/setup/public-remotes.json.
  assert.ok(!PUBLIC_REPO.error, `scripts/setup/public-remotes.json: ${PUBLIC_REPO.error}`);
  for (const rel of PAPERS) {
    assert.ok(exists(path.join(RAIZ, rel)), `${rel}: el papel no está en su lugar`);
    const paper = readPaper(rel);
    // (sólo los del exportador: `${{ … }}` de la CI es sintaxis de GitHub Actions, no un marcador)
    assert.deepStrictEqual(paper.match(/\{\{\s*public-[^}\n]*\}\}/g) || [], [], `${rel}: marcadores del exportador sin reemplazar`);
    const address = new RegExp(`(?:github\\.com|api\\.github\\.com/repos)/([A-Za-z0-9_.-]+/${escRe(CLONE_DIR)}[A-Za-z0-9_.-]*)`, 'g');
    const other = [...paper.matchAll(address)].map((m) => m[1]).filter((x) => x !== ORG_REPO);
    assert.deepStrictEqual(other, [], `${rel}: una dirección del arnés en GitHub que no es la declarada en public-remotes.json`);
  }

  for (const lang of ['en', 'es']) {
    const file = README[lang];
    const all = fences(text[lang]).map((f) => f.body).join('\n');
    assert.doesNotMatch(all, /@~\/|SessionStart/, `${file}: la portada no pide escribir el @import ni la línea de arranque a mano`);
    assert.doesNotMatch(text[lang], /guides-heal/, `${file}: no nombra guides-heal`);
    // BMad: fuera de los identificadores (código en línea y cercos) sólo en la frase de compatibilidad.
    const prose = text[lang].replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '').replace(/`[^`\n]*`/g, '').split(BMAD_COMPAT[lang]).join('');
    assert.ok(text[lang].includes(BMAD_COMPAT[lang]), `${file}: falta la frase de compatibilidad con BMad Method`);
    assert.doesNotMatch(prose, /bmad/i, `${file}: la marca BMad sólo puede aparecer en la frase de compatibilidad`);
    assert.doesNotMatch(text[lang], /paquete de Bizuit|Bizuit pack/i, `${file}: el paquete del stack no es «de Bizuit»`);
    assert.ok(text[lang].includes(PACK_MISSING_MESSAGE), `${file}: falta la parte fija del mensaje de un paquete pedido y no instalado (AC 22)`);
    assert.match(text[lang], /\]\(\.\.\/INSTALL\.md[#)]/, `${file}: tiene que enlazar a INSTALL.md (la tabla de hooks)`);
    // el pedido que un dev de afuera le pega a Claude Code: las dos portadas enlazan los dos, dentro de «Instalar con Claude Code»
    const guidedTitle = SECTIONS.find((s) => s[0] === 'Install with Claude Code')[lang === 'en' ? 0 : 1];
    const install = section(text[lang], guidedTitle) || '';
    for (const guided of GUIDED_PAPERS) {
      assert.ok(install.includes(`](${guided})`), `${file}: «${guidedTitle}» tiene que enlazar a ${guided}`);
    }
  }

  // y cada pedido existe como papel, en su ruta. (El privado medía además su sintético en allowlist.json, el que lo traía
  // desde public-files/: era la tubería privada de publicación, y acá el papel ya está en su lugar.)
  for (const guided of GUIDED_PAPERS) {
    assert.ok(exists(path.join(RAIZ, guided)), `${guided}: el papel no existe`);
    // la dirección del repo (la de raw.githubusercontent.com que baja el guion) es la declarada, y la bajada no va por la API
    assert.ok(readPaper(guided).includes(`${ORG_REPO}/main/scripts/setup/get-harness.`), `${guided}: la bajada del guion va por raw.githubusercontent.com con la dirección de public-remotes.json`);
    assert.doesNotMatch(readPaper(guided), /api\.github\.com\/repos\/[^\s]*\/contents\/scripts\/setup\/get-harness/, `${guided}: la bajada del guion no va por la API (su tope sin credencial deja trabada a una máquina nueva)`);
    assert.doesNotMatch(readPaper(guided), /git clone/, `${guided}: el pedido guiado ya no clona (story 8.23 E)`);
  }

  // el paquete del stack vive en el perfil del equipo (story 8.41): se mide donde está (el repo del equipo encima)
  await t.test('la description del paquete del stack', (tt) => {
    const file = path.join(RAIZ, 'packs', 'bizuit', 'pack.json');
    // en la copia pública (sin los paquetes del equipo: la señal es el de clientes) no se mide y se dice; con el repo del
    // equipo encima, que falte es un rojo
    const publica = !exists(path.join(RAIZ, 'packs', 'clients', 'pack.json'));
    if (publica) { tt.skip('NO MEDIDO: el paquete del stack viaja con el perfil del equipo, no con esta copia'); return; }
    assert.ok(exists(file), `${file}: el paquete del stack del equipo no está`);
    const pack = readJson(file);
    assert.strictEqual(pack.name, 'bizuit', 'pack.json: el nombre no cambia');
    assert.ok(pack.description.toLowerCase().includes(STACK_PHRASE.es.toLowerCase()), `pack.json: la description tiene que decir «${STACK_PHRASE.es}»`);
    assert.doesNotMatch(pack.description, /paquete de Bizuit|SDK de Bizuit Extensions es público/, 'pack.json: la description vieja');
  });
});

// ── T14 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
test('Papeles_HooksEInterruptoresQueExisten', async (t) => {
  const text = { en: readCover('en'), es: readCover('es') };

  await t.test('cada variable nombrada en las portadas existe', () => {
    const corpus = variableCorpus();
    for (const lang of ['en', 'es']) {
      const missing = namedVariables(text[lang]).filter((v) => !new RegExp(`\\b${v}\\b`).test(corpus));
      assert.deepStrictEqual(missing, [], `${README[lang]}: variables que no existen en el instalador, la sincronización, tycon-config.js ni harness.js`);
    }
  });

  await t.test('cada subcomando de harness.js nombrado lo lista --help', () => {
    const help = runHarnessScript('scripts/setup/harness.js', ['--help']);
    const listed = new Set(help.split('\n').map((l) => (l.match(/^ {2}([a-z][a-z-]*)\b/) || [])[1]).filter(Boolean));
    assert.ok(listed.has('install'), `no entiendo el --help de harness.js: ${help.slice(0, 200)}`);
    for (const lang of ['en', 'es']) {
      const named = [...new Set([...text[lang].matchAll(/harness\.js\s+([a-z][a-z-]*)/g)].map((m) => m[1]))];
      assert.deepStrictEqual(named.filter((s) => !listed.has(s)), [], `${README[lang]}: subcomandos que harness.js --help no lista`);
    }
  });

  await t.test('las nueve integraciones, contra tycon-config.js explain --json', () => {
    const explained = JSON.parse(runHarnessScript('scripts/lib/tycon-config.js', ['explain', '--json']));
    const keys = Object.keys(explained.integraciones).sort();
    // nueve desde la story 8.23 (tanda C): `claude` es una integración más, como `codex` (qué herramienta se enchufa)
    assert.strictEqual(keys.length, 9, `tycon-config.js explain --json da ${keys.length} integraciones`);
    for (const [lang, title] of [['en', 'What is optional'], ['es', 'Qué es opcional']]) {
      const sec = section(text[lang], title);
      assert.ok(sec, `${README[lang]}: falta la sección «${title}»`);
      const table = firstTable(sec);
      assert.ok(table, `${README[lang]}: la sección «${title}» no tiene la tabla de integraciones`);
      const names = table.rows.map((r) => unTick(r.cells[0]));
      assert.deepStrictEqual([...names].sort(), keys, `${README[lang]}: una fila por integración, ni una más ni una menos`);
      for (const r of table.rows) assert.match(r.cells.join(' '), /TYCON_[A-Z]|\.claude\/tycon\.json|`[a-z]+\.[a-z_]+`/, `${README[lang]}: la integración ${r.cells[0]} no dice cómo se prende`);
    }
  });

  await t.test('INSTALL.md: una fila por hook del set canónico del instalador', () => {
    const { count, pairs } = installerHooks();
    assert.ok(count >= 40, `leí ${count} registros de scripts/setup/hooks-list.json`);
    const install = fs.readFileSync(path.join(RAIZ, 'INSTALL.md'), 'utf8');
    const lines = linesWithFence(install);
    const h = lines.findIndex((l) => !l.inFence && /^#+\s.*Los hooks que instala/.test(l.line));
    assert.ok(h >= 0, 'INSTALL.md: falta la sección «Los hooks que instala»');
    const table = firstTable(lines.slice(h + 1).map((l) => l.line).join('\n'));
    assert.ok(table, 'INSTALL.md: la sección «Los hooks que instala» no tiene tabla');
    // «Perfil» (story 8.16, tanda C): su cruce con la lista de efectos vive en install-effects.test.js (T31)
    assert.deepStrictEqual(table.header, ['Hook', 'Evento', 'Qué hace', '¿Bloquea?', 'Perfil', 'Interruptor'], 'INSTALL.md: las columnas de la tabla de hooks');
    const seen = new Map();
    for (const r of table.rows) {
      assert.strictEqual(r.cells.length, 6, `INSTALL.md: la fila ${r.n} no tiene seis celdas`);
      assert.ok(r.cells.every((c) => c.length), `INSTALL.md: la fila ${r.n} tiene una celda vacía`);
      const event = (r.cells[1].replace(/`/g, '').match(new RegExp(`\\b(${EVENTS.join('|')})\\b`)) || [])[1];
      const key = `${event} ${unTick(r.cells[0])}`;
      assert.ok(!seen.has(key), `INSTALL.md: el par (${key}) está dos veces (filas ${seen.get(key)} y ${r.n})`);
      seen.set(key, r.n);
    }
    const expected = [...pairs.keys()].sort();
    const got = [...seen.keys()].sort();
    assert.deepStrictEqual({ faltan: expected.filter((k) => !seen.has(k)), sobran: got.filter((k) => !pairs.has(k)) }, { faltan: [], sobran: [] },
      'INSTALL.md: la tabla de hooks contra scripts/setup/hooks-list.json (par evento, script)');
    const corpus = variableCorpus({ withHooks: true });
    const switches = table.rows.flatMap((r) => namedVariables(r.cells[5]));
    assert.deepStrictEqual(switches.filter((v) => !new RegExp(`\\b${v}\\b`).test(corpus)), [], 'INSTALL.md: interruptores que no existen');
  });
});

// ── T33 de la story 8.13 (tanda D · AC 27) ──────────────────────────────────────────────────────────────────────
// La portada después del mecanismo de instalación: una línea para instalar, y lo que la persona necesita saber para
// actualizar. Se afirma por PALABRAS CLAVE y en los dos idiomas: una prosa en castellano y otra en inglés no pueden ser
// iguales byte a byte (eso vale para los bloques marcados). Cada punto dice DÓNDE tiene que estar (su sección, o su
// párrafo) y qué palabras; y cada palabra tiene su espejo: una portada de juguete sin ella falla en ese punto.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Una palabra clave, tolerante al corte de renglón: cada espacio vale por cualquier blanco (y la sangría de una viñeta). */
const loose = (keyword) => new RegExp(keyword.split(' ').map(escapeRe).join('\\s+'), 'g');
const says = (where, keyword) => loose(keyword).test(where);
const titleOf = (i, lang) => SECTIONS[i][lang === 'en' ? 0 : 1];
const sectionOf = (i) => (text, lang) => section(text, titleOf(i, lang)) || '';
/** El índice de una sección por su título en inglés: sumar una sección no corre a las demás. */
const at = (en) => { const i = SECTIONS.findIndex((x) => x[0] === en); assert.ok(i >= 0, `no hay sección «${en}»`); return i; };
/** El párrafo de una sección que empieza con `**<marca>**` (hasta la línea en blanco). */
const paragraphOf = (i, mark) => (text, lang) => {
  const lines = sectionOf(i)(text, lang).split('\n');
  const start = lines.findIndex((l) => l.startsWith(`**${mark[lang]}**`));
  if (start < 0) return '';
  const end = lines.findIndex((l, n) => n > start && !l.trim());
  return lines.slice(start, end < 0 ? lines.length : end).join('\n');
};
const IN_REQUIREMENTS = sectionOf(at('Requirements'));
const IN_INSTALL = sectionOf(at('Install by hand'));
const IN_ON_ITS_OWN = paragraphOf(at('What it writes on your machine and what it does on its own'), { en: 'What it does on its own', es: 'Qué hace solo' });
const IN_UPDATES = sectionOf(at('How it updates'));
// Las viñetas de «Cómo se actualiza», en orden: los números de versión primero, el arranque al final.
const UPDATE_BULLETS = {
  en: ['Versions', 'Channel', 'Policy', 'By hand', 'Going back', 'Removing everything', 'Startup'],
  es: ['Versiones', 'Canal', 'Política', 'A mano', 'Volver atrás', 'Quitar todo', 'El arranque'],
};
const updateBullets = (text, lang) => IN_UPDATES(text, lang).split('\n').map((l) => (l.match(/^- \*\*([^*]+)\*\*:/) || [])[1]).filter(Boolean);

/** Un punto por palabras clave: `both` vale para los dos idiomas; `en` / `es`, para el suyo. */
const keywordPoint = (what, where, { both = [], en = [], es = [] }) => ({ what, where, keywords: { en: [...both, ...en], es: [...both, ...es] } });
const FRONT_PAGE_KEYWORDS = [
  // story 8.40 (AC 31, decisión del dueño 2026-10-16): el piso para instalar es Node 22, el de los dos guiones y el
  // paquete de npm; 20 se tolera sólo para actualizar una instalación existente (harness.js) y no se prueba
  keywordPoint('requisitos: Node 22', IN_REQUIREMENTS, {
    both: ['Node 22', 'node >= 22'],
    en: ['20 is tolerated only to update an existing installation; it is not tested'],
    es: ['20 se tolera sólo para actualizar una instalación existente; no se prueba'],
  }),
  keywordPoint('empezar a trabajar: el permiso de lectura que Claude Code pide la primera vez (D5)', sectionOf(at('Start working')), {
    en: ['permission to read the folder', 'You accept it once'],
    es: ['permiso para leer la carpeta', 'Se acepta una vez'],
  }),
  keywordPoint('qué hace solo: mira como mucho una vez cada 6 horas', IN_ON_ITS_OWN, { en: ['6 hours'], es: ['6 horas'] }),
  keywordPoint('cómo se actualiza: los números de versión', IN_UPDATES, {
    en: ['`YYYY.MM.DD.N`', 'never goes down a version'],
    es: ['`AAAA.MM.DD.N`', 'nunca baja de versión'],
  }),
  keywordPoint('cómo se actualiza: el canal', IN_UPDATES, { both: ['`stable`', '`latest`', 'harness.js channel', 'TYCON_UPDATE_CHANNEL'] }),
  keywordPoint('cómo se actualiza: la política', IN_UPDATES, { both: ['`ask`', '`auto`', 'TYCON_UPDATE_APPLY', '`update.apply`'] }),
  keywordPoint('cómo se actualiza: latest con auto pide confirmación (D2)', IN_UPDATES, {
    en: ['`latest` together with `auto` asks you to confirm'],
    es: ['`latest` junto con `auto` te pide que lo confirmes'],
  }),
  keywordPoint('cómo se actualiza: update', IN_UPDATES, { both: ['harness.js update --check', 'harness.js update --yes'] }),
  keywordPoint('cómo se actualiza: rollback vuelve a una COPIA', IN_UPDATES, {
    both: ['harness.js rollback --list'],
    en: ['harness.js rollback --to <copy>'],
    es: ['harness.js rollback --to <copia>'],
  }),
  keywordPoint('cómo se actualiza: la retención que deja rollback', IN_UPDATES, {
    both: ['harness.js rollback --release'],
    en: ['stops updating on its own'],
    es: ['deja de actualizarse solo'],
  }),
  keywordPoint('cómo se actualiza: doctor', IN_UPDATES, { both: ['harness.js doctor'] }),
  keywordPoint('cómo se actualiza: uninstall', IN_UPDATES, { both: ['harness.js uninstall --dry-run', 'harness.js uninstall --yes'] }),
  keywordPoint('cómo se actualiza: la copia fija de arranque, con su carpeta y sus interruptores', IN_UPDATES, {
    both: ['~/.claude/.tycon-pipeline/harness/', 'TYCON_UPDATE=0', 'TYCON_UPDATE_CHANNEL', 'TYCON_UPDATE_APPLY'],
    en: ['pinned copy'],
    es: ['copia fija'],
  }),
];

/** Los problemas del bloque `install:core` de UNA portada: un bloque por sistema, cada uno con las tres líneas de la portada sin git. */
function oneLineInstallProblems(text) {
  let core;
  try { core = fences(block(text, 'install:core', 'la portada')); } catch (e) { return [e.message]; }
  const out = [];
  for (const shell of ['bash', 'powershell']) {
    const f = core.filter((x) => x.lang === shell);
    if (f.length !== 1) { out.push(`install:core: ${f.length} bloques ${shell} (tiene que haber uno)`); continue; }
    const body = f[0].body.split('\n').filter((l) => l.trim());
    if (JSON.stringify(body) !== JSON.stringify(INSTALL_LINES[shell])) out.push(`install:core (${shell}): no son las tres líneas de la portada sin git (bajar, leer, correr)`);
  }
  return out;
}
/** Lo que la portada ya NO pide ni nombra: escribir el `@import` o la línea de arranque a mano, `guides-heal`, y un `rollback --to <versión>`. */
function leftoverProblems(text, lang) {
  const out = [];
  if (/@~\/|SessionStart/.test(fences(text).map((f) => f.body).join('\n'))) out.push('un bloque de código pide escribir el @import o la línea de arranque a mano');
  if (/guides-heal/.test(text)) out.push('nombra guides-heal');
  if (says(IN_UPDATES(text, lang), `rollback --to <${lang === 'en' ? 'version' : 'versión'}>`)) out.push('rollback --to no recibe un número de versión: recibe una copia de seguridad');
  return out;
}
/** Todo lo que a una portada le falta o le sobra, punto por punto. */
function frontPageProblems(text, lang) {
  const out = [];
  for (const p of FRONT_PAGE_KEYWORDS) {
    const where = p.where(text, lang);
    for (const k of p.keywords[lang]) if (!says(where, k)) out.push(`${p.what} — falta «${k}»`);
  }
  for (const m of oneLineInstallProblems(text)) out.push(`instalación de una línea — ${m}`);
  for (const m of leftoverProblems(text, lang)) out.push(`lo que ya no va — ${m}`);
  const bullets = updateBullets(text, lang);
  if (JSON.stringify(bullets) !== JSON.stringify(UPDATE_BULLETS[lang])) out.push(`cómo se actualiza: las viñetas o su orden — ${bullets.join(', ') || 'ninguna'}`);
  return out;
}

// 🔴 rojo previo (medido con las portadas de antes de la tanda D): 14 problemas en la primera portada que mira —12
//    palabras clave que faltan (el permiso de lectura, «6 hours», los números de versión, la confirmación de latest con
//    auto, `rollback --to <copy>`, la retención con `rollback --release`, la copia fija con su carpeta y `TYCON_UPDATE=0`),
//    «rollback --to no recibe un número de versión» y las viñetas (cinco, sin «Versions» ni «Startup»)—. Los dos espejos
//    fallaban antes: sin la frase en la portada real no hay de dónde sacarla («la portada de juguete … es igual a la real»).
test('PublicFrontPage_OneLineInstall_BothLanguages', async (t) => {
  const text = { en: readCover('en'), es: readCover('es') };

  await t.test('las dos portadas dicen cada punto del AC 27, por palabras clave', () => {
    for (const lang of ['en', 'es']) {
      assert.deepStrictEqual(frontPageProblems(text[lang], lang), [], `${README[lang]}: lo que le falta o le sobra a la portada`);
    }
    assert.strictEqual(block(text.en, 'install:core', README.en), block(text.es, 'install:core', README.es),
      'el bloque <!-- install:core --> tiene que ser byte a byte igual en las dos portadas');
  });

  await t.test('el espejo: una portada de juguete sin una palabra clave falla en ESE punto', () => {
    let toys = 0;
    for (const lang of ['en', 'es']) {
      for (const p of FRONT_PAGE_KEYWORDS) {
        for (const k of p.keywords[lang]) {
          const toy = text[lang].replace(loose(k), '');
          assert.notStrictEqual(toy, text[lang], `${README[lang]}: la portada de juguete sin «${k}» es igual a la real (la real no lo dice)`);
          const hit = frontPageProblems(toy, lang).filter((m) => m.startsWith(`${p.what} — `));
          assert.ok(hit.length, `${README[lang]}: sin «${k}» la portada tenía que fallar en «${p.what}»`);
          toys += 1;
        }
      }
    }
    assert.ok(toys >= 2 * FRONT_PAGE_KEYWORDS.length, `armé ${toys} portadas de juguete: menos de una por punto y por idioma`);
  });

  await t.test('el espejo: lo que ya no va, la instalación de dos líneas y las viñetas en otro orden también fallan', () => {
    for (const lang of ['en', 'es']) {
      const real = text[lang];
      const failsWith = (toy, needle, what) => {
        assert.notStrictEqual(toy, real, `${README[lang]}: la portada de juguete de «${what}» es igual a la real`);
        assert.ok(frontPageProblems(toy, lang).some((m) => m.includes(needle)), `${README[lang]}: ${what} tenía que fallar con «${needle}»`);
      };
      // `bash get-harness.sh` seguido de la valla: la primera así es la de install:core (la de install:unattended lleva opciones)
      failsWith(real.replace(`${INSTALL_LINES.bash[2]}\n\`\`\``, `${INSTALL_LINES.bash[2]}\necho listo\n\`\`\``), 'install:core (bash)', 'una instalación de cuatro líneas');
      failsWith(`${real}\n\`\`\`bash\necho '@~/.claude/tycon-harness/INDEX.md' >> ~/.claude/CLAUDE.md\n\`\`\`\n`, '@import', 'un bloque que pide el @import a mano');
      failsWith(`${real}\nSi algo falla, corré guides-heal.js.\n`, 'guides-heal', 'una portada que nombra guides-heal');
      const copy = lang === 'en' ? 'copy' : 'copia';
      const version = lang === 'en' ? 'version' : 'versión';
      failsWith(real.replace(`rollback --to <${copy}>`, `rollback --to <${version}>`), 'recibe una copia de seguridad', 'un rollback --to con un número de versión');
      const [first, second] = UPDATE_BULLETS[lang];
      const swapped = real.replace(`- **${first}**:`, '- **@@**:').replace(`- **${second}**:`, `- **${first}**:`).replace('- **@@**:', `- **${second}**:`);
      failsWith(swapped, 'las viñetas o su orden', 'las viñetas en otro orden');
    }
    // y el bloque: con un carácter de más en una sola portada deja de ser igual
    assert.notStrictEqual(block(text.en.replace(`${INSTALL_LINES.bash[2]}\n\`\`\``, `${INSTALL_LINES.bash[2]} \n\`\`\``), 'install:core', README.en), block(text.es, 'install:core', README.es),
      'el espejo del bloque: una portada con el bloque cambiado tenía que diferir de la otra');
  });
});

// ── T35 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// La guía de publicación viaja con el arnés, y su sección «Lo que la publicación recibe» se mide igual que en el privado.
const HANDOFF_GUIDE = 'guides/maintaining/publicacion-espejo.md';
const HANDOFF_SECTION = 'Lo que la publicación recibe';
// Cada punto del AC 27 de la story 8.7: lo que la sección tiene que decir. Un punto es una lista de expresiones; todas
// tienen que estar en la sección (no en el resto de la guía: la 8.8 lee ESA sección).
const HANDOFF_POINTS = [
  ['qué exportación se publica', [/--package core,bizuit --single-repo/]],
  ['a qué repo: el que devuelve readPublicRepo()', [/readPublicRepo\(\)/]],
  ['public-repos.json no viaja', [/`?public-repos\.json`?[^.\n]*\bno viaja/]],
  ['`ajustes` y `renamed` del --json son la correspondencia de rutas', [/`ajustes`/, /`renamed`/, /`--json`/, /correspondencia de rutas/]],
  ['el reporte privado de vulnerabilidades se activa antes de anunciar', [/reporte privado de vulnerabilidades/, /antes de anunciar/i]],
  ['el chequeo que el ruleset exige se llama public-ci', [/ruleset/, /se llama `public-ci`/]],
  ['el flujo de contribuciones de CONTRIBUTING es el que la publicación implementa', [/flujo de contribuciones/, /CONTRIBUTING/, /la publicación implementa/]],
  ['la copia trae el programa de instalación de la 8.13, con la copia fija de arranque', [/`scripts\/setup\/harness\.js`/, /`scripts\/setup\/harness\/`/, /copia fija de arranque/]],
  ['version.json lo estampa la sincronización sólo cuando el árbol publicable cambió', [/`version\.json`/, /sincronización/, /sólo cuando el árbol publicable cambió/]],
  ['las dos ramas son los dos canales: mirror/sync «al día» y main «estable»', [/`mirror\/sync`[^.\n]*«al día»/, /`main`[^.\n]*«estable»/]],
  ['marcar estable es mergear el pull request, sin etiquetas', [/mergear el pull request/, /sin etiquetas/]],
  ['si la publicación o el programa de instalación cambian algo de esto, cambia acá en el mismo commit', [/Si la publicación o el programa de instalación cambian algo de esto, cambia acá en el mismo commit/]],
];
test('Papeles_LoQueRecibeLa88', async (t) => {
  await t.test(`${HANDOFF_GUIDE} §«${HANDOFF_SECTION}» dice cada punto del AC 27`, () => {
    const guide = fs.readFileSync(path.join(RAIZ, HANDOFF_GUIDE), 'utf8');
    const sec = section(guide, HANDOFF_SECTION);
    assert.ok(sec, `${HANDOFF_GUIDE}: falta la sección «## ${HANDOFF_SECTION}»`);
    // la sección se lee como un texto corrido: una frase puede partirse en dos renglones
    const flat = sec.replace(/\s*\n\s*/g, ' ');
    const missing = HANDOFF_POINTS.filter(([, res]) => !res.every((re) => re.test(flat))).map(([what]) => what);
    assert.deepStrictEqual(missing, [], `${HANDOFF_GUIDE} §«${HANDOFF_SECTION}»: puntos del AC 27 que la sección no dice`);
    // «sin repetir el nombre»: el nombre público vive en un solo archivo; la sección remite a quien lo lee. (En el privado
    // ese archivo es public-repos.json; acá el nombre se toma de scripts/setup/public-remotes.json, que dice el mismo.)
    assert.ok(!PUBLIC_REPO.error, `scripts/setup/public-remotes.json: ${PUBLIC_REPO.error}`);
    for (const name of [PUBLIC_REPO.repo, ORG_REPO]) {
      assert.ok(!flat.toLowerCase().includes(String(name).toLowerCase()), `${HANDOFF_GUIDE} §«${HANDOFF_SECTION}»: no repite el nombre del repo público («${name}»): lo da readPublicRepo()`);
    }
  });

  // (el privado medía además la evidencia de la corrida con modelo —Task 16, AC 28— en el Dev Agent Record de la story
  // 8.7: las stories viven en specs/ del repo privado, que no está en este repo)
});

// ── story 8.16, tanda A · «decir la verdad» (AC 5, 6, 7 y 10) ───────────────────────────────────────────────────
// La portada dice TODO lo que la instalación cambia en la máquina y en cómo contesta el asistente, y lo dice desde la
// lista declarada (`scripts/setup/install-effects.json`): cada efecto marcado `front_page: true` tiene que estar
// nombrado en los dos idiomas. «Nombrado» es mecánico e igual en los dos idiomas: el nombre del bloque, la clave del
// ajuste, el interruptor de la pieza o la ruta donde guarda. Lo demás va por palabras clave, como el AC 27 de la 8.13.
const { readEffects } = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'managed.js'));
const IN_WHAT_IT_IS = sectionOf(at('What it is and what it isn\'t'));
const IN_FIRST_USE = sectionOf(at('Start working'));
const IN_WRITES = sectionOf(at('What it writes on your machine and what it does on its own'));
const IN_PRODUCT = sectionOf(at('Your product repo'));
// El orden de la sección (AC 5): primero cómo contesta el asistente; después lo que frena, lo que corre solo, lo que
// escribe y guarda, y la red.
const WRITES_ORDER = {
  en: ['It changes how your assistant answers', 'Guards that can block', 'What it does on its own', 'What it writes and keeps on disk', 'Network'],
  es: ['Cambia cómo contesta tu asistente', 'Controles que frenan', 'Qué hace solo', 'Qué escribe y qué guarda en disco', 'La red'],
};
// La frase de Windows (AC 10). La story pedía «por WSL; el nativo, en preparación»; el dueño delegó la decisión
// (2026-10-04) y la revisión adversaria mostró que esa frase ya era falsa: el camino nativo se midió ese día en una
// máquina virtual y WSL no lo probó nadie. Hasta el 2026-10-06 la portada decía «ninguno probado con esta copia»; ese
// día el camino nativo se instaló desde la copia en una máquina Windows 11 limpia, con `doctor` en orden y los hooks de
// git puestos (prueba del dev externo), y la frase pasó a decir eso. WSL sigue sin probar, y lo dice. Dos piezas la atan
// a lo declarado: la lista de soporte de Windows (`windows-support.json`: el día que diga `supported`, esta frase y
// `recommended` se revisan juntas) y la lista de efectos (mientras el instalador de Windows no registre los dos frenos,
// la portada lo dice; cuando los registre, deja de decirlo).
const WINDOWS_PHRASE = {
  requirements: {
    en: 'The native path was tested on 2026-10-06 on a clean Windows 11 machine, installed from this copy',
    es: 'El camino nativo se probó el 2026-10-06 en una máquina Windows 11 limpia, instalado desde esta copia',
  },
  install: { en: 'native, tested with this copy', es: 'nativo, probado con esta copia' },
  noGuards: { en: 'does not yet register the two command guards', es: 'no registra los dos frenos de comandos' },
};
const WINDOWS_GUARDS = ['PreToolUse:@tcg:safety-guard-pre.sh', 'PreToolUse:@tcg:test-scope-guard-pre.sh'];

/** Lo que la portada tiene que escribir para nombrar un efecto: igual en los dos idiomas. */
function frontPageToken(e) {
  if (e.kind === 'block') return `\`${e.id.replace(/^TYCON_BLOCK:/, '')}\``;
  if (e.kind === 'setting') return e.id.split('.').pop();
  if (e.kind === 'import') return 'INDEX.md';   // el índice que carga la línea de import (hasta 2026-10-14, README.md)
  const variable = (String(e.switch || '').match(/\bTYCON_[A-Z0-9_]+/) || [])[0];
  if (variable) return variable;
  if (e.stores) return e.stores;
  return effectName(e).split(/[:/]/).pop();
}
/** Cómo se nombra una entrada en un mensaje: su `id`, o su patrón si vale por un conjunto. */
const effectName = (e) => String(e.id || e.id_pattern);
/**
 * El nombre ENTERO, no como parte de otro: `TYCON_UPDATE` no queda nombrado por `TYCON_UPDATE_CHANNEL`, ni
 * `~/.claude/.tycon-pipeline/` por la ruta de las copias, ni `~/.claude/tycon-harness` por la ruta del comando
 * (pase adversarial de la tanda A: se podía borrar la frase que de verdad nombraba el efecto y la prueba seguía verde).
 */
const wholeToken = (token) => new RegExp(`${escapeRe(token)}(?![A-Za-z0-9_./-])`, 'g');
const namesToken = (text, token) => wholeToken(token).test(text);
/**
 * Los KB del índice (INDEX.md; hasta 2026-10-14, el README) que la línea de import carga en cada sesión, TAL COMO SALE en la copia pública: el de la raíz sin sus
 * bloques internos (la misma transformación que le aplica el exportador). El del repo interno pesa más.
 */
function importedReadmeKb() {
  const { internalBlocks } = require(path.join(PUBLISHING, 'public-copy.js'));
  const r = internalBlocks(fs.readFileSync(path.join(RAIZ, 'INDEX.md'), 'utf8'), 'INDEX.md');
  assert.deepStrictEqual(r.errors, [], 'INDEX.md: sus bloques internos están mal marcados');
  return Math.round(Buffer.byteLength(r.text, 'utf8') / 1024);
}

/** Los efectos de portada que una portada no nombra, el orden de la sección y el tamaño del README. */
function effectsProblems(text, lang, effects) {
  const out = [];
  const sec = IN_WRITES(text, lang);
  for (const e of effects.filter((x) => x.front_page)) {
    if (!namesToken(sec, frontPageToken(e))) out.push(`efecto sin nombrar — ${effectName(e)} (falta «${frontPageToken(e)}»)`);
  }
  const marks = WRITES_ORDER[lang].map((m) => sec.indexOf(`**${m}**`));
  if (marks.some((i) => i < 0)) out.push(`orden de la sección — falta «${WRITES_ORDER[lang][marks.findIndex((i) => i < 0)]}»`);
  else if (marks.some((i, n) => n > 0 && i < marks[n - 1])) out.push('orden de la sección — primero cómo contesta el asistente, después lo que frena, lo que corre solo, lo que escribe y guarda, y la red');
  const kb = (sec.match(/(\d+) KB/) || [])[1];
  if (!kb) out.push('tamaño del README — la sección no dice cuántos KB carga el import');
  else if (Math.abs(Number(kb) - importedReadmeKb()) > 1) out.push(`tamaño del README — dice ${kb} KB y pesa ${importedReadmeKb()} KB`);
  return out;
}

// Los puntos por palabras clave de la tanda A. `what` empieza con el AC, así el espejo sabe en qué punto tiene que fallar.
const GUIDED_INSTALL_KEYWORDS = [
  // AC 5 (f): lo que el dueño aprobó para la tanda D de la 8.13 sigue dicho
  keywordPoint('AC 5 · aprobado en la 8.13 D: la consulta cada 6 horas', IN_ON_ITS_OWN, { en: ['at most once every 6 hours'], es: ['como mucho una vez cada 6 horas'] }),
  keywordPoint('AC 5 · aprobado en la 8.13 D: no aplica sin update --yes desde una terminal', IN_ON_ITS_OWN, {
    both: ['harness.js update --yes'], en: ['unless you ask for it from a terminal'], es: ['sin que se lo pidas desde una terminal'],
  }),
  keywordPoint('AC 5 · aprobado en la 8.13 D: los números de versión', IN_UPDATES, { en: ['`YYYY.MM.DD.N`'], es: ['`AAAA.MM.DD.N`'] }),
  keywordPoint('AC 5 · aprobado en la 8.13 D: latest con auto se confirma', IN_UPDATES, {
    en: ['`latest` together with `auto` asks you to confirm'], es: ['`latest` junto con `auto` te pide que lo confirmes'],
  }),
  keywordPoint('AC 5 · aprobado en la 8.13 D: la retención y rollback --release', IN_UPDATES, { both: ['harness.js rollback --release'] }),
  keywordPoint('AC 5 · aprobado en la 8.13 D: la copia fija y rollback --to <copia>', IN_UPDATES, {
    en: ['pinned copy', 'harness.js rollback --to <copy>'], es: ['copia fija', 'harness.js rollback --to <copia>'],
  }),
  // AC 5 (a) a (e)
  keywordPoint('AC 5 · (a) el tope de largo que un hook mide y cobra', IN_WRITES, {
    both: ['1300'], en: ['in all your projects', 'plain Spanish'], es: ['en todos tus proyectos', 'castellano llano'],
  }),
  keywordPoint('AC 5 · (b) lo que frena sólo en un repo que trabaja con el arnés, con la tabla', IN_WRITES, {
    both: ['`.tycon/`', '(../INSTALL.md#los-hooks-que-instala)'], en: ['works with the harness', 'stories created with the skill'], es: ['trabaja con el arnés', 'stories creadas con la skill'],
  }),
  keywordPoint('AC 5 · (c) el barrido diario de los repos vecinos', IN_WRITES, { both: ['200'], en: ['Once a day', 'parent folder'], es: ['Una vez por día', 'carpeta madre'] }),
  keywordPoint('AC 5 · (d) lo que guarda en disco', IN_WRITES, {
    both: ['~/.claude/response-style/', '~/.claude/safety-guard.log', '~/.claude/commands/', '~/.claude/.tycon-pipeline/timing-history/',
      '~/.claude/blocking-meter/', '~/.claude/lectura-grande/'],
    en: ['a compressed copy of the conversation', 'the last 8 requests of each session'], es: ['una copia comprimida de la conversación', 'los últimos 8 pedidos de cada sesión'],
  }),
  // lo que escribe el lado Codex (pedido del dueño, 2026-10-04: «acá habla solo de Claude, ¿y Codex?»)
  keywordPoint('AC 5 · el lado Codex: qué escribe bajo ~/.codex/, su llave y el paso a mano', IN_WRITES, {
    both: ['~/.codex/', '`AGENTS.md`', '`hooks.json`', '`config.toml`', '`integrations.codex: true`', 'TYCON_CODEX=1', '`/hooks`'],
    en: ['off by default', 'One step stays manual'], es: ['viene apagado', 'Queda un paso a mano'],
  }),
  keywordPoint('AC 5 · (e) la red: no manda datos de uso; de fábrica, sólo GitHub', IN_WRITES, {
    both: ['GitHub', 'scripts/publishing/third-party-skills.json'], en: ['sends no usage data'], es: ['no manda datos de uso'],
  }),
  // AC 6
  keywordPoint('AC 6 · dónde quedan las copias de respaldo y cómo se vuelve', IN_WRITES, { both: ['~/.claude/.tycon-pipeline/harness/backups/', 'harness.js rollback --list'] }),
  keywordPoint('AC 6 · dónde se pone un interruptor', IN_WRITES, {
    both: ['`env`', '~/.claude/settings.json', '~/.claude/tycon.json'],
    en: ['the VS Code extension may not see'], es: ['la extensión de VS Code puede no ver'],
  }),
  keywordPoint('AC 6 · uninstall quita sólo lo registrado, y lo que deja', IN_WRITES, {
    both: ['harness.js uninstall'], en: ['removes only what the mechanism recorded', 'It leaves'], es: ['quita sólo lo que el mecanismo registró', 'Deja'],
  }),
  keywordPoint('AC 6 · primer uso', IN_FIRST_USE, {
    both: ['harness.js doctor', 'implementemos la story'], en: ['never commits'], es: ['nunca commitea'],
  }),
  keywordPoint('AC 6 · toda la salida está sólo en castellano (portada en inglés)', IN_WHAT_IT_IS, { en: ['are in Spanish only today'] }),
  // AC 7
  keywordPoint('AC 7 · qué pone un repo bajo el arnés (la carpeta .tycon/, la primera story o .advisors/) y sus dos apagados', IN_PRODUCT, {
    both: ['`.tycon/`', '`.advisors/`', 'TYCON_STORY_GATE=off', '`pipeline.story_gate: false`', 'TYCON_RETRO_PENDING=0'],
    en: ['the first story', 'is denied'], es: ['la primera story', 'se deniega'],
  }),
  // AC 10
  keywordPoint('AC 10 · Windows, en los requisitos', IN_REQUIREMENTS, { both: ['PowerShell 7', 'WSL'], en: [WINDOWS_PHRASE.requirements.en], es: [WINDOWS_PHRASE.requirements.es] }),
  keywordPoint('AC 10 · Windows, junto al bloque de PowerShell', IN_INSTALL, { both: ['PowerShell 7'], en: [WINDOWS_PHRASE.install.en], es: [WINDOWS_PHRASE.install.es] }),
];
const FIRST_USE_MAX_LINES = 8;

/** Lo que una portada dice de más: la promesa vieja de `uninstall`, «Primer uso» largo, o Windows sin WSL. */
function guidedLeftovers(text, lang) {
  const out = [];
  if (/deshace todo|undoes all of it/.test(text)) out.push('AC 6 · uninstall no «deshace todo»: quita sólo lo que el mecanismo registró');
  const firstUse = IN_FIRST_USE(text, lang).split('\n').filter((l) => l.trim());
  if (firstUse.length > FIRST_USE_MAX_LINES) out.push(`AC 6 · «Empezar a trabajar» tiene ${firstUse.length} renglones (tope ${FIRST_USE_MAX_LINES})`);
  // AC 10: en la «Referencia», todo párrafo que nombra Windows nombra WSL (WSL sigue sin probar, y lo dice). Arriba
  // alcanza con una mención en «Qué necesitás»: la regla, aplicada a toda la página, llenaba de WSL el camino recomendado
  // (revisión del lector interno, 2026-10-06).
  // la referencia empieza en su primera sección (desde 2026-10-14 vive en getting-started/reference(.es).md)
  const refTitle = `## ${titleOf(at('What it is and what it isn\'t'), lang)}`;
  const reference = text.includes(refTitle) ? text.slice(text.indexOf(refTitle)) : text;
  if (!/\bWSL\b/.test(sectionOf(at('What you need'))(text, lang))) out.push('AC 10 · «Qué necesitás» no nombra WSL');
  const prose = reference.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '');
  for (const p of prose.split(/\n\s*\n/)) {
    if (/\bWindows\b/.test(p) && !/\bWSL\b/.test(p)) out.push(`AC 10 · un párrafo nombra Windows sin WSL: «${p.trim().slice(0, 80)}»`);
  }
  return out;
}
function guidedProblems(text, lang, effects) {
  const out = [];
  for (const p of GUIDED_INSTALL_KEYWORDS) {
    const where = p.where(text, lang);
    for (const k of p.keywords[lang]) if (!says(where, k)) out.push(`${p.what} — falta «${k}»`);
  }
  return [...out, ...effectsProblems(text, lang, effects).map((m) => `AC 5 · ${m}`), ...guidedLeftovers(text, lang)];
}

// 🔴 rojo previo (medido con las portadas de antes de la tanda A): la sección no nombra ningún bloque por su nombre ni
//    los dos ajustes, no dice «1300», el barrido diario, lo que guarda, la red ni dónde va un interruptor; dice
//    «deshace todo»; no hay «Primer uso» ni la frase de Windows.
test('Papers_FrontPage_GuidedInstall_TandaA', async (t) => {
  const text = { en: readCover('en'), es: readCover('es') };
  const loaded = readEffects(RAIZ);
  assert.strictEqual(loaded.ok, true, `no pude leer la lista de efectos: ${loaded.reason}`);
  const effects = loaded.effects;
  const onPage = effects.filter((e) => e.front_page);

  // T4
  await t.test('Papers_FrontPage_NamesEveryFrontPageEffect_BothLanguages', () => {
    assert.ok(onPage.length >= 12, `la lista marca ${onPage.length} efectos para la portada: los bloques, el import, los dos frenos, lo que corre solo, lo que guarda y los dos ajustes son más`);
    for (const kind of ['block', 'import', 'setting', 'hook', 'task', 'command', 'git-hook', 'third-party']) {
      assert.ok(onPage.some((e) => e.kind === kind), `ningún efecto «${kind}» va a la portada`);
    }
    for (const lang of ['en', 'es']) assert.deepStrictEqual(effectsProblems(text[lang], lang, effects), [], `${README[lang]}: la sección contra la lista de efectos`);
    // el espejo: sin el nombre de un efecto, la portada falla en ESE efecto
    for (const lang of ['en', 'es']) {
      for (const e of onPage) {
        const token = frontPageToken(e);
        // se saca sólo el nombre ENTERO: lo que lo contiene como parte de otro (otra variable, otra ruta) queda
        const toy = text[lang].replace(wholeToken(token), '');
        assert.notStrictEqual(toy, text[lang], `${README[lang]}: la portada no dice «${token}»`);
        assert.ok(effectsProblems(toy, lang, effects).some((m) => m.includes(effectName(e))), `${README[lang]}: sin «${token}» tenía que fallar en ${effectName(e)}`);
      }
      const [first, second] = WRITES_ORDER[lang];
      const swapped = text[lang].replace(`**${first}**`, '**@@**').replace(`**${second}**`, `**${first}**`).replace('**@@**', `**${second}**`);
      assert.ok(effectsProblems(swapped, lang, effects).some((m) => m.startsWith('orden de la sección')), `${README[lang]}: con las partes en otro orden tenía que fallar`);
      assert.ok(effectsProblems(text[lang].replace(/(\d+) KB/, '999 KB'), lang, effects).some((m) => m.startsWith('tamaño del README')), `${README[lang]}: con otro tamaño tenía que fallar`);
    }
  });

  // T5, T6, T7 y la mitad de T11
  await t.test('Papers_FrontPage_KeepsOwnerApprovedSentences · BackupsSwitchPlaceFirstUseOutputLanguage · ProductRepoGate · WslNowNativeInPreparation', () => {
    for (const lang of ['en', 'es']) assert.deepStrictEqual(guidedProblems(text[lang], lang, effects), [], `${README[lang]}: lo que le falta o le sobra a la portada`);
  });

  await t.test('el espejo: una portada de juguete sin una palabra clave falla en ESE punto', () => {
    let toys = 0;
    for (const lang of ['en', 'es']) {
      for (const p of GUIDED_INSTALL_KEYWORDS) {
        for (const k of p.keywords[lang]) {
          // se saca de DONDE tiene que estar: la misma palabra puede estar además en otra sección
          const where = p.where(text[lang], lang);
          const toy = text[lang].replace(where, () => where.replace(loose(k), ''));
          assert.notStrictEqual(toy, text[lang], `${README[lang]}: la portada de juguete sin «${k}» es igual a la real (la real no lo dice)`);
          assert.ok(guidedProblems(toy, lang, effects).some((m) => m.startsWith(`${p.what} — `)), `${README[lang]}: sin «${k}» la portada tenía que fallar en «${p.what}»`);
          toys += 1;
        }
      }
    }
    assert.ok(toys >= 2 * GUIDED_INSTALL_KEYWORDS.length - 1, `armé ${toys} portadas de juguete: menos de una por punto y por idioma`);
  });

  await t.test('el espejo: lo que sobra también falla', () => {
    for (const lang of ['en', 'es']) {
      const real = text[lang];
      const failsWith = (toy, needle, what) => assert.ok(guidedProblems(toy, lang, effects).some((m) => m.includes(needle)), `${README[lang]}: ${what} tenía que fallar con «${needle}»`);
      failsWith(`${real}\n\`harness.js uninstall\` ${lang === 'en' ? 'undoes all of it' : 'deshace todo'}.\n`, 'deshace todo', 'la promesa vieja de uninstall');
      const title = `## ${titleOf(at('Start working'), lang)}`;
      failsWith(real.replace(title, `${title}\n\n${Array.from({ length: 9 }, (_, i) => `${i + 1}. paso`).join('\n')}`), 'renglones', 'un «Primer uso» largo');
      failsWith(`${real}\n\nWindows 11.\n`, 'Windows sin WSL', 'un párrafo que nombra Windows sin WSL');
    }
  });

  // T7: los dos apagados que la portada nombra existen en el portón
  await t.test('Papers_FrontPage_ProductRepoGateAndItsSwitchesExist', () => {
    const gate = fs.readFileSync(path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'story-gate.js'), 'utf8');
    assert.match(gate, /\bTYCON_STORY_GATE\b/, 'story-gate.js: el interruptor de la persona');
    assert.match(gate, /pipeline\.story_gate: false/, 'story-gate.js: el apagado por repo');
  });

  // T11: la frase de Windows sale de la lista declarada de Windows (8.17), no de una decisión suelta
  await t.test('Papers_WindowsPhrase_FollowsTheDeclaredLists', () => {
    const support = readJson(path.join(RAIZ, 'scripts', 'setup', 'windows-support.json'));
    assert.notStrictEqual(support.native, 'supported',
      'windows-support.json ya dice «supported»: la frase de Windows de las dos portadas (WINDOWS_PHRASE) y `recommended` se revisan en el mismo commit');
    // los dos frenos de comandos en Windows: la portada dice lo que dice la lista de efectos, en los dos sentidos
    const registered = WINDOWS_GUARDS.map((id) => effects.find((e) => e.id === id)).map((e) => Boolean(e && e.windows));
    assert.ok(registered.every((x) => x === registered[0]), 'los dos frenos de comandos tienen que estar los dos, o ninguno, en Windows');
    for (const lang of ['en', 'es']) {
      const core = fences(block(text[lang], 'install:core', README[lang]));
      assert.strictEqual(core.filter((f) => f.lang === 'powershell').length, 1, `${README[lang]}: el bloque de PowerShell sigue`);
      const saysMissing = says(IN_INSTALL(text[lang], lang), WINDOWS_PHRASE.noGuards[lang]);
      assert.strictEqual(saysMissing, !registered[0],
        `${README[lang]}: la lista de efectos dice que el instalador de Windows ${registered[0] ? 'YA registra' : 'NO registra'} los dos frenos, y la portada ${saysMissing ? 'dice que no' : 'no lo dice'} («${WINDOWS_PHRASE.noGuards[lang]}»)`);
    }
  });
});

// ── story 8.23, tanda E · la portada SIN git (AC 33 y 34 · la parte de los papeles de T34 y T35) ─────────────────
// Desde la tanda E el bloque `install:core` ES el guion de entrada (bajarlo sin credencial, leerlo,
// correrlo: tres líneas por sistema); `get-harness.*` baja la versión publicada como archivos —sin git, sin clon— y sigue
// con `harness.js install --version latest`. El guion aparte de la 8.16 E (`install:script`, guardado mientras el repo
// fuera privado) y su fixture se retiraron: ya no hay dos formas de entrar. El clon queda como MODO DESARROLLADOR
// (`install:clone`, después de `install:unattended`): para cambiar el arnés, no para usarlo.
// Nunca una tubería hacia un intérprete, en ninguna parte de la portada: `| bash`, `| sudo bash`, y las dos formas sin
// tubería que hacen lo mismo, `bash <(curl …)` y `sh -c "$(curl …)"`.
const PIPE_TO_SHELL = /\|\s*(sudo\s+(-\S+\s+)*)?(bash|sh|zsh|iex|Invoke-Expression|pwsh|powershell)\b|<\(\s*(curl|wget)\b|\$\(\s*(curl|wget)\b/i;
const NO_GIT_KEYWORDS = [
  keywordPoint('AC 33 · tres líneas a propósito: la tubería la bloquea el freno', IN_INSTALL, {
    both: ['`SUP-C1`'], en: ['three lines on purpose'], es: ['tres líneas a propósito'],
  }),
  keywordPoint('AC 33 · sin git, sin clon: la versión publicada bajada como archivos', IN_INSTALL, {
    both: ['harness.js install --version latest'], en: ['no git, no clone'], es: ['sin git, sin clon'],
  }),
  // hasta que el repo fue público este punto era «el permiso de lectura, pedido antes de bajar y guardado una vez».
  // Con el repo público el permiso no hace falta: lo que queda dicho es para qué sirve uno propio (el límite de pedidos
  // sin credencial), dónde lo guarda el guion y cómo se saca
  keywordPoint('AC 33 · sin credencial; un permiso propio sólo para el límite de pedidos, guardado donde se dice y con su salida', IN_INSTALL, {
    both: ['TYCON_GITHUB_TOKEN', '`~/.tycon/config.json`', '403', 'harness.js config unset github.token'],
    en: ['with no credential', '60 per hour', 'never carries a credential'], es: ['sin credencial', '60 por hora', 'nunca lleva credencial'],
  }),
  keywordPoint('AC 33 · nunca instala paquetes del sistema ni usa sudo; las opciones de install, después de --', IN_INSTALL, {
    both: ['`sudo`', 'bash get-harness.sh -- <'], en: ['never installs system packages'], es: ['nunca instala paquetes del sistema'],
  }),
  keywordPoint('AC 34 · usar no es mantener: el clon es el modo desarrollador', IN_INSTALL, {
    both: ['harness.js link --local', 'harness.js link --managed'],
    en: ['Developer mode (to change the harness, not to use it)'], es: ['Modo desarrollador (para cambiar el arnés, no para usarlo)'],
  }),
];

test('Papers_NoGitFrontPage_ThreeVisibleLines_NoPipeToShell_PermissionBeforeDownload', () => {
  for (const lang of ['en', 'es']) {
    const text = readCover(lang);
    const pipe = text.split('\n').find((l) => PIPE_TO_SHELL.test(l));
    assert.strictEqual(pipe, undefined, `${README[lang]}: una tubería hacia un shell — «${String(pipe || '').trim().slice(0, 100)}»`);
    const inst = IN_INSTALL(text, lang);
    for (const k of NO_GIT_KEYWORDS) for (const w of k.keywords[lang]) assert.ok(says(inst, w), `${README[lang]}: ${k.what} — falta «${w}»`);
    // el clon, sólo como modo desarrollador: después de install:unattended, dentro de «Instalación»
    const lines = text.split('\n').map((l) => l.trim());
    assert.ok(lines.indexOf('<!-- /install:unattended -->') < lines.indexOf('<!-- install:clone -->'), `${README[lang]}: install:clone va después de install:unattended`);
    assert.ok(inst.includes('<!-- install:clone -->'), `${README[lang]}: install:clone va en «Instalación»`);
    // «Instalación» no vende el clon como forma de usar: `git clone` SÓLO dentro de los dos bloques del modo desarrollador
    // (se sacan esos dos y se busca en todo lo demás, prosa y código: un bloque nuevo que clone también cae acá)
    const outsideClone = inst.replace(/<!-- install:clone(?:-unattended)? -->[\s\S]*?<!-- \/install:clone(?:-unattended)? -->/g, '');
    assert.doesNotMatch(outsideClone, /git clone/, `${README[lang]}: «Instalación» pide clonar fuera de los bloques del modo desarrollador`);
    // los espejos: la tubería se detecta en sus cuatro formas
    for (const bad of ['curl -fsSL https://x/get-harness.sh | bash', 'irm https://x | iex', 'curl -fsSL https://x | sudo -E bash', 'bash <(curl -fsSL https://x)', 'sh -c "$(curl -fsSL https://x)"']) {
      assert.ok(PIPE_TO_SHELL.test(bad), `control: «${bad}» tenía que detectarse como tubería hacia un shell`);
    }
  }
});

// ── Story 8.16, tanda B (AC 19 · T24): el plan y la conformidad, dichos en la portada ─────────────────────────────────
// `install:core` no cambia; el párrafo de abajo dice que `install` muestra el plan y pregunta; un bloque nuevo
// `install:unattended` (bash y PowerShell) trae la misma línea más `--yes`, para una máquina sin terminal, con una oración
// que avisa que así se acepta el plan sin que nadie lo vea y que conviene mirar antes `--dry-run`.
const PLAN_PHRASE = {
  asks: { en: ['shows the plan', 'asks'], es: ['muestra el plan', 'pregunta'] },
  unattended: { en: ['accepts the plan without anyone seeing it', '--dry-run'], es: ['acepta el plan sin que nadie lo vea', '--dry-run'] },
};
test('Papeles_UnattendedBlock_BothLanguages (T24)', () => {
  for (const lang of ['en', 'es']) {
    const text = readCover(lang);
    const inst = IN_INSTALL(text, lang);
    for (const k of PLAN_PHRASE.asks[lang]) assert.ok(says(inst, k), `${README[lang]}: «Instalación» no dice «${k}» (install muestra el plan y pregunta)`);
    const un = fences(block(text, 'install:unattended', README[lang]));
    for (const shell of ['bash', 'powershell']) {
      const f = un.filter((x) => x.lang === shell);
      assert.strictEqual(f.length, 1, `${README[lang]}: install:unattended tiene que traer un bloque ${shell}`);
      // desde la tanda D (AC 36) el bloque nombra el perfil: `--yes` acepta el plan pero no elige. Desde la 8.23 E son las
      // tres líneas de install:core, la última con `-- --profile minimal --yes`
      assert.deepStrictEqual(f[0].body.split('\n').filter((l) => l.trim()), withOptions(shell, '--profile minimal --yes'),
        `${README[lang]}: install:unattended (${shell}) son las líneas de install:core, la última con -- --profile minimal --yes`);
    }
    // la oración de aviso: después del bloque, en la misma sección
    const after = inst.slice(inst.indexOf('<!-- /install:unattended -->'));
    for (const k of PLAN_PHRASE.unattended[lang]) assert.ok(says(after, k), `${README[lang]}: después de install:unattended falta «${k}»`);
    assert.ok(inst.indexOf('<!-- /install:core -->') < inst.indexOf('<!-- install:unattended -->'), `${README[lang]}: install:unattended va después de install:core`);
  }
});

// ── Story 8.16, tanda C (AC 22 · T31, la mitad de las portadas): la sección «Perfiles» ──────────────────────────────
// Doce renglones como mucho, con lo que trae cada perfil: cuántos hooks trae `minimal` (contados desde la lista de
// efectos, no escritos a mano), qué se queda sólo en `full` (los frenos, los bloques que cambian cómo contesta el
// asistente, los hooks de git, las tareas de fondo), cómo se elige y qué pasa si no se elige.
const PROFILES_MAX_LINES = 12;
const IN_PROFILES = sectionOf(at('Profiles'));
const NUMBER_WORDS = { en: ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'], es: ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez'] };
const PROFILES_KEYWORDS = {
  both: ['`minimal`', '`full`', '--profile', 'install.profile', 'TYCON_INSTALL_PROFILE'],
  en: ['brakes', 'how the assistant answers', 'git hooks', 'background', 'if you don\'t choose'],
  es: ['frenos', 'cómo contesta el asistente', 'hooks de git', 'de fondo', 'si no elegís'],
};
function profilesProblems(text, lang, effects) {
  const where = IN_PROFILES(text, lang);
  if (!where.trim()) return [`«${titleOf(at('Profiles'), lang)}»: falta la sección`];
  const out = [];
  const lines = where.split('\n').filter((l) => l.trim());
  if (lines.length > PROFILES_MAX_LINES) out.push(`AC 22 · «${titleOf(at('Profiles'), lang)}» tiene ${lines.length} renglones (tope ${PROFILES_MAX_LINES})`);
  for (const k of [...PROFILES_KEYWORDS.both, ...PROFILES_KEYWORDS[lang]]) if (!says(where, k)) out.push(`AC 22 · falta «${k}»`);
  // cuántos hooks trae minimal (sin los de una integración ni el freno de sesiones, que nace apagado en los dos)
  const n = effects.filter((e) => e.kind === 'hook' && Array.isArray(e.profiles) && e.profiles.includes('minimal') && !/^integration:/.test(e.when) && e.when !== 'optin:TYCON_SESSION_GUARD').length;
  const word = NUMBER_WORDS[lang][n] || String(n);
  if (!says(where, `${word} hooks`) && !says(where, `${n} hooks`)) out.push(`AC 22 · no dice cuántos hooks trae minimal (${word} hooks, según la lista de efectos)`);
  return out;
}
test('Papers_ProfilesSection_BothLanguages (T31)', () => {
  const effects = readEffects(RAIZ).effects;
  for (const lang of ['en', 'es']) {
    const text = readCover(lang);
    assert.deepStrictEqual(profilesProblems(text, lang, effects), [], `${README[lang]}: la sección de los perfiles`);
    // el espejo: un renglón de más, o sin una palabra clave, falla
    const title = `## ${titleOf(at('Profiles'), lang)}`;
    const long = text.replace(title, `${title}\n\n${Array.from({ length: 13 }, (_, i) => `${i + 1}. renglón`).join('\n')}`);
    assert.ok(profilesProblems(long, lang, effects).some((m) => m.includes('renglones')), `${README[lang]}: una sección de 13 renglones más tenía que fallar`);
    const where = IN_PROFILES(text, lang);
    const toy = text.replace(where, () => where.replace(loose(PROFILES_KEYWORDS[lang][0]), ''));
    assert.ok(profilesProblems(toy, lang, effects).some((m) => m.includes(PROFILES_KEYWORDS[lang][0])), `${README[lang]}: sin «${PROFILES_KEYWORDS[lang][0]}» tenía que fallar`);
  }
});

// ── Story 8.16, tanda B (AC 19, arreglo de la tanda A): las skills de la portada, con su nombre EN LA COPIA ───────────
// La portada se lee en la copia pública, donde algunas skills tienen otro nombre que en su origen (`bmad-create-story`
// sale como `tycon-create-story`, por la política de marca de BMad). «Primer uso» nombraba la de origen y la exportación
// real salía 1. Una skill nombrada entre acentos graves con un nombre que acá no existe es un nombre que el lector no
// encuentra. En el privado los nombres viejos salían de `skillRenames` (from → to); acá ese renombre ya está hecho
// (from = to), así que salen del manifiesto de terceros: el nombre de origen de cada skill derivada (`based_on.path`)
// que no es el suyo, más todo `from` de `skillRenames` que todavía difiera de su `to`.
test('Papeles_Portadas_SkillsConSuNombreEnLaCopia', () => {
  const skillOf = (p) => (String(p).match(/^skills\/([^/]+)$/) || [])[1];
  const manifest = readJson(path.join(PUBLISHING, 'third-party-skills.json'));
  const renames = readJson(path.join(PUBLISHING, 'allowlist.json')).skillRenames || [];
  const renamed = new Map();
  for (const d of manifest.derived) {
    const to = skillOf(d.target);
    const from = to && d.based_on && d.based_on.path ? path.posix.basename(d.based_on.path) : null;
    if (from && from !== to) renamed.set(from, to);
  }
  for (const r of renames) if (skillOf(r.from) && skillOf(r.to) && r.from !== r.to) renamed.set(skillOf(r.from), skillOf(r.to));
  assert.ok(renamed.size > 0, 'el manifiesto de terceros no trae ninguna skill con otro nombre de origen: la prueba no estaría probando nada');
  const out = [];
  for (const lang of ['en', 'es']) {
    const ticks = readCover(lang).match(/`[^`\n]+`/g) || [];
    for (const t of ticks.map((x) => x.slice(1, -1).trim())) {
      if (renamed.has(t)) out.push(`${README[lang]}: nombra \`${t}\`, que en la copia se llama \`${renamed.get(t)}\``);
    }
  }
  assert.deepStrictEqual(out, []);
  // cada skill con su nombre nuevo existe en skills/ de este repo, y la vieja no (si no, la prueba no vería el nombre
  // viejo nunca, o el nuevo no existiría)
  for (const [from, to] of renamed) {
    assert.ok(exists(path.join(RAIZ, 'skills', to)), `«${from}» sale como «${to}», que no está en skills/`);
    assert.ok(!exists(path.join(RAIZ, 'skills', from)), `«${from}» sigue en skills/ con su nombre de origen`);
  }
});

// ── story 8.19, tanda C · la ruta del lugar en las portadas (AC 24, T34) ────────────────────────────────────────────
// Las dos portadas nombran el lugar (`~/.claude/<lugar>`, el nombre de place.js) donde nombraban el viejo, y ninguna
// nombra la ruta vieja: afuera, el viejo no existe. El bloque de instalación no cambia: sigue siendo la línea de siempre
// y no nombra ninguna de las dos rutas. El install-effects.json manda a la portada el efecto del lugar, no el del viejo.
test('PublicPapers_PlacePath_ZeroLegacy_InstallBlockUnchanged', () => {
  const PLACE = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'place.js'));
  const legacyRx = new RegExp(`\\.claude[/\\\\]+${PLACE.LEGACY_PLACE_NAME}(?![A-Za-z0-9_-])`, 'g');
  const placeRx = new RegExp(`\\.claude[/\\\\]+${PLACE.PLACE_NAME}(?![A-Za-z0-9_-])`, 'g');
  for (const lang of ['en', 'es']) {
    const text = readCover(lang);
    assert.deepStrictEqual(text.match(legacyRx) || [], [], `${README[lang]}: nombra la ruta vieja del lugar`);
    // la portada reescrita para el dev externo (2026-10-06) nombra menos rutas que la de antes (eran 10 o más): el piso
    // sólo asegura que el lugar sigue nombrado donde hace falta; lo que importa es que la ruta vieja no aparezca
    assert.ok((text.match(placeRx) || []).length >= 5, `${README[lang]}: nombra el lugar ${(text.match(placeRx) || []).length} veces (piso: 5)`);
    const install = block(text, 'install:core', README[lang]);
    assert.ok(INSTALL_LINES.bash.concat(INSTALL_LINES.powershell).every((l) => install.includes(l)), `${README[lang]}: el bloque de instalación cambió`);
    assert.ok(!legacyRx.test(install) && !placeRx.test(install), `${README[lang]}: el bloque de instalación nombra una ruta del lugar`);
    legacyRx.lastIndex = 0; placeRx.lastIndex = 0;
  }
  const effects = readJson(path.join(RAIZ, 'scripts', 'setup', 'install-effects.json')).effects;
  const linkOf = (name) => effects.find((e) => e.kind === 'link' && e.id === name);
  assert.strictEqual(linkOf(PLACE.PLACE_NAME).front_page, true, 'install-effects.json: el lugar va a la portada');
  assert.strictEqual(linkOf(PLACE.PLACE_NAME).stores, `~/.claude/${PLACE.PLACE_NAME}`);
  const legacy = linkOf(PLACE.LEGACY_PLACE_NAME);
  assert.ok(!legacy || legacy.front_page === false, 'install-effects.json: el viejo no va a la portada');
});

// ── Story 8.16, tanda D (AC 36 · T50): las preguntas, dichas en la portada ───────────────────────────────────────────
// «Instalación» dice las tres preguntas (el perfil sin valor por defecto, las integraciones, el paquete del
// stack) y las opciones que las contestan; el bloque sin terminal nombra el perfil (`--profile minimal --yes`) con la
// oración «o `--profile full`»; y la tabla de «Qué es opcional» marca `mailbox` y `nightly` como del equipo.
// 🔴 rojo previo verificado: antes de la tanda D la portada no nombraba las preguntas ni las opciones, y el bloque sin
// terminal era `install --yes`.
const QUESTIONS_KEYWORDS = {
  both: ['`--profile minimal|full`', '`--integrations <list|none>`', '`--packs all|none`'],
  en: ['asks what it cannot decide on its own', 'the profile', 'no default', 'which integrations', 'stack pack in all your repos',
    // segunda vuelta (decisión del dueño, 2026-10-05): una sola vez, y cuándo no pregunta
    'asks only once', 'with `--yes`', 'over an existing install it asks nothing', 'how to change the profile or the integrations'],
  es: ['pregunta lo que no puede decidir solo', 'el perfil', 'no hay uno por defecto', 'qué integraciones', 'paquete del stack en todos tus repos',
    'Pregunta una sola vez', 'con `--yes`', 'sobre una instalación que ya existe no pregunta nada', 'cómo cambiar el perfil o las integraciones'],
};
const UNATTENDED_FULL = { en: 'or `--profile full`', es: 'o `--profile full`' };
// 2026-10-13: mailbox y nightly ya no se marcan como «del equipo, con infraestructura que este repo no trae», sino por lo que
// son: piezas de la organización (su buzón, sus procesos de la noche, que corren desde su repo de operaciones)
const TEAM_ONLY = { en: "your organization's", es: 'de tu organización' };
function questionsProblems(text, lang) {
  const out = [];
  const inst = IN_INSTALL(text, lang);
  // el bloque `both` usa la lista en el idioma de la portada para `--integrations`
  const both = QUESTIONS_KEYWORDS.both.map((k) => (lang === 'es' ? k.replace('<list|none>', '<lista|none>') : k));
  for (const k of [...both, ...QUESTIONS_KEYWORDS[lang]]) if (!says(inst, k)) out.push(`AC 36 · «Instalación» no dice «${k}»`);
  const after = inst.slice(inst.indexOf('<!-- /install:unattended -->'));
  if (!says(after, UNATTENDED_FULL[lang])) out.push(`AC 36 · después de install:unattended falta «${UNATTENDED_FULL[lang]}»`);
  const optional = sectionOf(at('What is optional'))(text, lang);
  for (const key of ['mailbox', 'nightly']) {
    const row = optional.split('\n').find((l) => l.startsWith(`| \`${key}\` |`)) || '';
    if (!says(row, TEAM_ONLY[lang])) out.push(`portada n.º 9 · la fila de \`${key}\` no la marca «${TEAM_ONLY[lang]}»`);
  }
  for (const key of ['clockify', 'engram', 'codegraph', 'codex', 'ado', 'telegram']) {
    const row = optional.split('\n').find((l) => l.startsWith(`| \`${key}\` |`)) || '';
    if (says(row, TEAM_ONLY[lang])) out.push(`la fila de \`${key}\` no es del equipo y la portada la marca así`);
  }
  return out;
}
test('Papers_ProfilesAndQuestions_UnattendedCarriesProfile_BothLanguages (T50)', () => {
  for (const lang of ['en', 'es']) {
    const text = readCover(lang);
    assert.deepStrictEqual(questionsProblems(text, lang), [], `${README[lang]}: las preguntas en la portada`);
    // espejos: sin una palabra clave, sin la marca de una fila, o sin la oración de full, falla
    const inst = IN_INSTALL(text, lang);
    const kw = QUESTIONS_KEYWORDS[lang][2];
    const noKw = text.replace(inst, () => inst.replace(loose(kw), ''));
    assert.ok(questionsProblems(noKw, lang).some((m) => m.includes(kw)), `${README[lang]}: sin «${kw}» tenía que fallar`);
    const noTeam = text.replace(new RegExp(TEAM_ONLY[lang].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), 'x');
    assert.ok(questionsProblems(noTeam, lang).some((m) => m.includes('mailbox')), `${README[lang]}: sin la marca del equipo tenía que fallar`);
  }
});

// ── portada clara (2026-10-06): lo que cambia, ANTES de instalar, y lo que las instrucciones para Claude cumplen ────
// La parte de arriba avisa, antes de los pasos, lo que el camino recomendado (`full`) cambia en todos los proyectos —
// sobre todo `core.hooksPath`, el único efecto que puede apagar algo propio del lector— y cómo pedir `minimal`. Las dos
// instrucciones que se le pegan a Claude cumplen esas promesas: el plan que se muestra antes del «sí» dice si configura
// `core.hooksPath` (desde el 2026-10-14 la pone la instalación si git no tiene ninguna: antes no la ponía nadie y una
// máquina mudada quedaba sin el freno antes de publicar), saben pedir el perfil mínimo y piden el mismo Node que
// «Requisitos». Ninguno de los cuatro papeles dice «v20» (la portada pedía 22 en los requisitos y v20 en los pasos:
// revisión del lector interno, F1).
const IN_BEFORE = sectionOf(at('Before you install: what changes on your machine'));
const BEFORE_KEYWORDS = {
  both: ['`full`', '`minimal`', '`core.hooksPath`', '`.git/hooks/`', 'harness.js uninstall --dry-run'],
  en: ['in all your projects', 'in Spanish', 'for a year'],
  es: ['en todos tus proyectos', 'en castellano', 'un año'],
};
// las páginas guiadas piden Node 24, la versión estable, y nombran el piso de 22, que alcanza para la línea de instalación
const GUIDE_KEYWORDS = ['node v24 (con v22 también anda)', 'quiero el perfil mínimo', '--profile minimal', '.git/hooks/', 'si configura la carpeta global de hooks de git) y preguntame si sigo'];
function clearTopProblems(text, lang) {
  const out = [];
  const where = IN_BEFORE(text, lang);
  for (const k of [...BEFORE_KEYWORDS.both, ...BEFORE_KEYWORDS[lang]]) if (!says(where, k)) out.push(`antes de instalar — falta «${k}»`);
  const guided = sectionOf(at('Install with Claude Code'))(text, lang);
  // desde la story 8.23 (tanda E) el arnés vive en ~/.tycon/harness como archivos bajados, no en un clon
  for (const k of ['`minimal`', '`core.hooksPath`', '`~/.tycon/harness`']) if (!says(guided, k)) out.push(`instalar con Claude Code — falta «${k}»`);
  // story 8.40 (AC 31): el piso para instalar es Node 22, en la portada y en las páginas guiadas («con v22 también anda»)
  if (says(sectionOf(at('What you need'))(text, lang), 'Node 22') === false) out.push('qué necesitás — falta «Node 22»');
  if (/\bv2[02]\b/.test(text)) out.push('dice «v20»/«v22»: la portada dice «Node 22» en «Requisitos» (la forma «v22» es la de las páginas guiadas)');
  if (/Node 20 (o posterior|or later)/.test(text)) out.push('dice «Node 20 o posterior»: el piso para instalar es Node 22');
  // lo que la revisión marcó como falso: la configuración de la primera story no queda guardada sola
  if (/writes both files|escribe los dos archivos/.test(text)) out.push('promete que la primera story guarda `_bmad/` sola');
  return out;
}
test('PublicFrontPage_ClearTop_ChangesBeforeInstall_GuidesKeepThePromises', async (t) => {
  const text = { en: readCover('en'), es: readCover('es') };
  await t.test('las dos portadas', () => {
    for (const lang of ['en', 'es']) assert.deepStrictEqual(clearTopProblems(text[lang], lang), [], `${README[lang]}: la parte de arriba`);
  });
  await t.test('el espejo: sin `core.hooksPath` arriba, con «v20» o con la promesa de `_bmad/`, falla', () => {
    for (const lang of ['en', 'es']) {
      const where = IN_BEFORE(text[lang], lang);
      const noHooks = text[lang].replace(where, () => where.replace(loose('`core.hooksPath`'), ''));
      assert.ok(clearTopProblems(noHooks, lang).some((m) => m.includes('core.hooksPath')), `${README[lang]}: sin core.hooksPath tenía que fallar`);
      assert.ok(clearTopProblems(`${text[lang]}\nnode v20\n`, lang).some((m) => m.includes('v20')), `${README[lang]}: con v20 tenía que fallar`);
    }
    assert.ok(clearTopProblems(`${text.es}\nescribe los dos archivos\n`, 'es').some((m) => m.includes('_bmad')), 'con la promesa de _bmad/ tenía que fallar');
  });
  await t.test('las instrucciones para Claude: Node 22, el perfil mínimo y el aviso de core.hooksPath', () => {
    for (const guided of GUIDED_PAPERS) {
      const paper = readPaper(guided);
      const missing = GUIDE_KEYWORDS.filter((k) => !paper.includes(k));
      assert.deepStrictEqual(missing, [], `${guided}: lo que la portada promete de estas instrucciones`);
      // story 8.40 (AC 31): las páginas guiadas piden el piso para instalar, Node 22; v20 sería pedir de menos
      assert.doesNotMatch(paper, /\bv20\b|node 20\+/, `${guided}: dice «v20»; el piso para instalar (y de las páginas guiadas) es Node 22`);
      // el aviso va ANTES del comando que configura core.hooksPath
      assert.ok(paper.indexOf('.git/hooks/') < paper.indexOf('git config --global core.hooksPath'), `${guided}: el aviso de .git/hooks/ va antes de configurar core.hooksPath`);
    }
  });
  // story 8.28: el ensayo del pipeline de Windows sigue la página de Windows por su MARCA. La marca envuelve el bloque
  // de la parte 1 desde AFUERA (un comentario adentro dejaría de ser invisible: se le pega al asistente con el bloque),
  // una sola vez, y no le cambia una letra a lo que la persona copia. Las páginas de Mac y de Linux no la llevan.
  await t.test('la página de Windows trae la marca del ensayo, afuera del bloque que se copia', () => {
    const windows = GUIDED_PAPERS.find((p) => /windows\.md$/.test(p));
    assert.ok(windows, 'la página de Windows está entre las instrucciones');
    const lines = readPaper(windows).replace(/\r\n/g, '\n').split('\n');
    const open = lines.indexOf('<!-- guided:base -->');
    const close = lines.indexOf('<!-- /guided:base -->');
    assert.deepStrictEqual([lines.filter((l) => l.includes('guided:base')).length, open >= 0, close > open], [2, true, true], `${windows}: la marca y su cierre, una vez cada una`);
    assert.deepStrictEqual([lines[open + 1], lines[close - 1]], ['```text', '```'], `${windows}: la marca envuelve el bloque desde afuera`);
    const block = lines.slice(open + 2, close - 1);
    assert.ok(block.length > 40 && !block.some((l) => l.includes('<!--')), `${windows}: adentro del bloque que se copia no hay ningún comentario`);
    assert.match(block[0], /^Necesito instalar en esta máquina el arnés/, `${windows}: el bloque marcado es el de la parte 1`);
    for (const other of GUIDED_PAPERS.filter((p) => p !== windows)) assert.ok(!readPaper(other).includes('guided:base'), `${other}: la marca es de la página de Windows`);
  });
});

// ── story 8.26, tanda H1c (AC 66 · T80): primeros pasos sin permiso para bajar el arnés ─────────────────────────────
// Con el repo de la versión publicada ya PÚBLICO, el paso «creá un permiso de lectura de GitHub y aceptá la invitación»
// sobra: el guion de entrada se baja sin credencial, y pide un permiso sólo si GitHub contesta 401 o 404. Las tres
// páginas que se le pegan a Claude y las dos portadas dejan de pedirlo; las tres páginas siguen siendo gemelas (los
// mismos pasos, con el mismo número, y cada referencia a «el paso N» apuntando al suyo: sacar un paso corre a todos los
// demás); y dicen el caso que aparece sin credencial: GitHub limita esos pedidos (60 por hora por dirección) y contesta 403.
const SHELL_OF = { 'getting-started/windows.md': 'powershell', 'getting-started/mac.md': 'bash', 'getting-started/linux.md': 'bash' };
// el renglón que baja el guion de entrada, sin credencial: el mismo en la página y en la portada de cada sistema
const DOWNLOAD_LINE = {
  bash: `curl -fsSL -o get-harness.sh ${SCRIPT_URL('get-harness.sh')}`,
  powershell: `Invoke-WebRequest -OutFile get-harness.ps1 ${SCRIPT_URL('get-harness.ps1')}`,
};
// (story 8.40, AC 43) la parte 1 instala con la línea npx, la MISMA en los tres sistemas: el plan con --dry-run y, con el
// sí, la misma línea sin él, sin -y ni --yes (la persona contesta «¿Instalo? [s/N]» en su terminal). El guion de entrada
// queda debajo, a mano, con el renglón sin credencial de la portada
const NPX_PLAN_LINE = 'npx @tyconsa/harness@latest --audience me --profile full --integrations none --packs all --dry-run';
const NPX_INSTALL_LINE = 'npx @tyconsa/harness@latest --audience me --profile full --integrations none --packs all';
// los pasos de la parte 1, en orden, cada uno por lo que TRAE y no por su título (el de Windows dice «ventana» donde los
// otros dicen «terminal»)
const GUIDED_STEPS = [
  ['tools', /node --version/],
  ['plan', /--dry-run/],
  ['install', /^\s*npx @tyconsa\/harness@latest[^\n]*--packs all\s*$/m],
  ['git-hooks', /git config --global core\.hooksPath/],
  ['verify', /harness\.js"? doctor/],
  ['report', /Armame UN solo bloque/],
];
// el renglón que pone un permiso PROPIO en la variable sin dejarlo en el historial ni en pantalla, por sistema. Es el
// único comando de una página que puede tocar esa variable, y sólo dentro del párrafo del límite de pedidos: sin él la
// persona le pregunta al asistente cómo, y lo que salga improvisado (`export TYCON_GITHUB_TOKEN=…`) deja la clave escrita
const SAFE_TOKEN_LINE = {
  bash: "printf 'Permiso de GitHub: ' && read -rs TYCON_GITHUB_TOKEN && echo && export TYCON_GITHUB_TOKEN",
  powershell: "$s = Read-Host -AsSecureString 'Permiso de GitHub'; $env:TYCON_GITHUB_TOKEN = [System.Net.NetworkCredential]::new('', $s).Password",
};
const paragraphsOf = (text) => String(text).split(/\n\s*\n/);
const saysLimit = (p) => /\b403\b/.test(p);
const withoutLimit = (text) => paragraphsOf(text).filter((p) => !saysLimit(p)).join('\n\n');
// Lo que un texto HACE con el permiso, diga lo que diga y con las palabras que use (la primera versión de esta prueba
// frenaba el paso viejo pegado tal cual y dejaba pasar el mismo paso reescrito: «token» por «permiso», «private
// repository» por «repository is private», un párrafo sin número). Tres cosas, que ninguna página ni portada puede hacer:
//   (a) mandar una credencial en un comando que baja algo;
//   (b) pedir que se cree, se pegue o se exporte una credencial de GitHub, o que se acepte una invitación;
//   (c) tocar la variable del permiso fuera del párrafo del límite de pedidos.
const FETCHES = /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i;
const CARRIES_CREDENTIAL = /Authorization|Bearer|-H\s+@-|--user\b|\s-u\s|_TOKEN\b|-Credential\b/i;
const NAMES_A_CREDENTIAL = /\btokens?\b|[A-Z_]*_TOKEN\b|\bPAT\b|personal[- ]access|access[- ]key|\b(clave|llave) de acceso/i;
const ASKS_FOR_ONE = /\b(cre[aáeé]\w*|gener[aáeé]\w*|ped[ií]\w*|peg[aáuú]\w*|guard[aáeé]\w*|export\w*|create\w*|generate\w*|paste\w*|ask\w*\s+(?:\w+\s+){0,3}for)\b[^.\n]{0,60}\b(permisos?|permissions?|credencial\w*|credentials?|claves?|keys?|accesos?|access)\b/i;
const SAYS_PRIVATE = /\bprivate\s+repo|\brepo\w*\s+(is\s+|es\s+)?priva|\bprivad\w*\s+repo/i;
/** Lo que hay de (a) en un texto entero: los renglones que bajan algo llevando una credencial. */
function downloadsWithCredential(text) {
  return String(text).split('\n').filter((l) => FETCHES.test(l) && CARRIES_CREDENTIAL.test(l)).map((l) => l.trim().slice(0, 60));
}
/** Lo que hay de (b) y (c) en `scope`: el texto donde un permiso de GitHub no tiene nada que hacer (sin el párrafo del límite). */
function credentialActs(scope) {
  const out = [];
  const hit = (rx) => { const m = rx.exec(scope); return m ? `«${m[0].replace(/\s+/g, ' ').trim().slice(0, 50)}»` : null; };
  if (hit(NAMES_A_CREDENTIAL)) out.push(`permiso — nombra un token, una variable de permiso o una clave de acceso ${hit(NAMES_A_CREDENTIAL)}`);
  if (hit(ASKS_FOR_ONE)) out.push(`permiso — manda a crear, pedir, pegar o exportar una credencial ${hit(ASKS_FOR_ONE)}`);
  if (hit(/\binvit/i)) out.push('permiso — habla de una invitación al repo');
  if (hit(SAYS_PRIVATE)) out.push(`permiso — dice que el repo es privado ${hit(SAYS_PRIVATE)}`);
  if (hit(/permiso de (lectura|GitHub)|read permission|GitHub permission/i)) out.push('permiso — pide un permiso de GitHub fuera del caso del límite de pedidos');
  return out;
}
/** La parte 1 de una página: el primer bloque `text` y sus pasos numerados, `{ block, steps: [{ n, kind, body }] }`. */
function guidedPartOne(text) {
  const first = fences(text).find((f) => f.lang === 'text');
  const block = first ? first.body : '';
  const lines = block.split('\n');
  const starts = lines.map((l, i) => (/^\d+\. /.test(l) ? i : -1)).filter((i) => i >= 0);
  const steps = starts.map((from, k) => {
    const body = lines.slice(from, k + 1 < starts.length ? starts[k + 1] : lines.length).join('\n');
    return { n: Number(/^(\d+)\./.exec(lines[from])[1]), kind: GUIDED_STEPS.filter(([, rx]) => rx.test(body)).map(([id]) => id).join('+') || '?', body };
  });
  return { block, steps };
}
/** Lo que una página de primeros pasos tiene mal respecto de «se baja sin permiso», punto por punto. */
function guidedPermissionProblems(text, shell) {
  const out = [];
  const { block, steps } = guidedPartOne(text);
  if (!steps.length) return ['no encuentro la parte 1: el primer bloque ```text con sus pasos numerados'];
  // (1) nada pide un permiso ni una invitación para bajar el arnés. Por lo que el texto HACE: (a) ninguna bajada lleva
  // credencial, en la página entera; (b) y (c) en todo lo que va hasta la parte 2 —la presentación y el bloque de la
  // parte 1—, sin el párrafo del límite. (La parte 2 nombra otros tokens, que no son para bajar el arnés: el del bot de
  // Telegram y la regla «nunca leas ni muestres un token»: ahí sólo se miran la invitación y el enlace de los permisos.)
  if (/personal-access-tokens/.test(text)) out.push('permiso — manda a crear un permiso de GitHub (personal-access-tokens)');
  if (/\binvit/i.test(text)) out.push('permiso — habla de una invitación al repo');
  if (/Authorization/.test(text)) out.push('permiso — manda una credencial en un pedido (Authorization)');
  for (const l of downloadsWithCredential(text)) out.push(`permiso — una bajada lleva credencial: «${l}»`);
  if (/guarda mi permiso/.test(text)) out.push('permiso — dice que la instalación guarda un permiso');
  const untilPartTwo = text.split(/^## Parte 2\b/m)[0];
  out.push(...credentialActs(withoutLimit(untilPartTwo)).map((m) => `${m} (antes de la parte 2)`));
  // (2) el caso que aparece sin credencial: una vez, en la parte 1; es el único lugar que nombra la variable del permiso, y
  // el único comando que la toca es el renglón seguro de ESE sistema (el que no deja la clave en el historial ni en pantalla)
  const limit = paragraphsOf(text).filter(saysLimit);
  if (limit.length !== 1) out.push(`límite de pedidos — el caso del 403 tiene que estar una vez (está ${limit.length})`);
  else {
    if (!block.includes(limit[0])) out.push('límite de pedidos — el caso del 403 va en la parte 1, el bloque que se copia');
    for (const k of ['60 por hora', 'TYCON_GITHUB_TOKEN', 'va siempre sin credencial']) if (!says(limit[0], k)) out.push(`límite de pedidos — falta «${k}»`);
    const touching = limit[0].split('\n').map((l) => l.trim()).filter((l) => /TYCON_GITHUB_TOKEN/.test(l) && /[=$]|\b(read|export|set|setx|Read-Host)\b/.test(l));
    if (!touching.includes(SAFE_TOKEN_LINE[shell])) out.push('límite de pedidos — falta el renglón seguro que pone el permiso en la variable (sin eco y sin historial)');
    for (const l of touching.filter((x) => x !== SAFE_TOKEN_LINE[shell])) out.push(`límite de pedidos — otro comando toca la variable del permiso: «${l.slice(0, 60)}»`);
  }
  if (/TYCON_GITHUB_TOKEN/.test(withoutLimit(text))) out.push('permiso — nombra TYCON_GITHUB_TOKEN fuera del caso del límite de pedidos');
  // (3) la instalación es la línea npx, tal cual, en el plan y en instalar (sin -y ni --yes: la persona contesta); y el
  // guion de entrada, a mano debajo, se baja sin credencial: el renglón de la portada, tal cual
  const lineIn = (kind, want) => { const s = steps.find((x) => x.kind === kind); return Boolean(s && s.body.split('\n').some((l) => l.trim() === want)); };
  if (!lineIn('plan', NPX_PLAN_LINE)) out.push('npx — el paso del plan no trae la línea npx con --dry-run');
  if (!lineIn('install', NPX_INSTALL_LINE)) out.push('npx — el paso de instalar no trae la línea npx, sin --dry-run y sin --yes');
  if (/@tyconsa\/harness@latest[^\n]*(\s-y\b|--yes)/.test(block)) out.push('npx — la parte 1 escribe la línea npx con --yes: la respuesta es de la persona');
  if (!String(text).split('\n').some((l) => l.trim() === DOWNLOAD_LINE[shell])) out.push('bajada — el camino a mano no trae el renglón sin credencial de la portada');
  // (4) gemelas: los mismos pasos, numerados de corrido, y cada referencia cruzada apunta a su paso
  if (steps.map((s) => s.n).join() !== steps.map((_, i) => i + 1).join()) out.push(`pasos — no están numerados de corrido (${steps.map((s) => s.n).join(', ')})`);
  if (steps.map((s) => s.kind).join() !== GUIDED_STEPS.map(([id]) => id).join()) out.push(`pasos — no son los de siempre, en su orden (${steps.map((s) => s.kind).join(', ')})`);
  const numberOf = (id) => (steps.find((s) => s.kind === id) || {}).n;
  const refs = (rx, ids, what) => {
    const hit = rx.exec(block);
    const want = ids.map(numberOf).join();
    if (!hit || hit.slice(1).map(Number).join() !== want) out.push(`referencias — ${what} nombra ${hit ? `los pasos ${hit.slice(1).join(', ')}` : 'otra cosa'} y tenían que ser ${want.split(',').join(', ')}`);
  };
  // (cada espacio vale por cualquier blanco: la frase puede cortar de renglón en otro lugar en cada página)
  const phrase = (words) => new RegExp(words.split(' ').join('\\s+'));
  refs(phrase('en los pasos (\\d+) y (\\d+) cambiá --profile full por --profile minimal, y salteá el paso (\\d+)'), ['plan', 'install', 'git-hooks'], 'el perfil mínimo');
  refs(phrase('salida de los pasos (\\d+) y (\\d+) \\(el final\\), y la salida COMPLETA del paso (\\d+)'), ['tools', 'install', 'verify'], 'el reporte');
  const named = (block.match(/\bpasos? \d/g) || []).length;
  if (named !== 4) out.push(`referencias — la parte 1 nombra pasos por su número ${named} veces y las referencias que se comprueban son 4`);
  return out;
}
/** Lo que una portada tiene mal respecto de lo mismo. */
function coverPermissionProblems(text, lang) {
  const out = [];
  if (/personal-access-tokens/.test(text)) out.push('permiso — manda a crear un permiso de GitHub (personal-access-tokens)');
  if (/\binvit/i.test(text)) out.push('permiso — habla de una invitación al repo');
  if (/Authorization/.test(text)) out.push('permiso — manda una credencial en un pedido (Authorization)');
  for (const l of downloadsWithCredential(text)) out.push(`permiso — una bajada lleva credencial: «${l}»`);
  if (SAYS_PRIVATE.test(text)) out.push('permiso — dice que el repo es privado');
  // el permiso propio se nombra sólo junto al caso del límite de pedidos, y ese caso está en «Instalar a mano»
  for (const p of paragraphsOf(text).filter((x) => /TYCON_GITHUB_TOKEN/.test(x))) {
    if (!saysLimit(p)) out.push(`permiso — nombra TYCON_GITHUB_TOKEN fuera del caso del límite de pedidos: «${p.trim().slice(0, 70)}»`);
  }
  for (const k of ['403', lang === 'en' ? '60 per hour' : '60 por hora', 'TYCON_GITHUB_TOKEN']) if (!says(IN_INSTALL(text, lang), k)) out.push(`límite de pedidos — «${titleOf(at('Install by hand'), lang)}» no dice «${k}»`);
  // el camino de quien instala —lo que hace falta, el camino recomendado, los requisitos y «a mano»—: por lo que el texto
  // HACE, fuera de los párrafos del límite. Las otras secciones nombran otras credenciales (las integraciones, lo que
  // el arnés frena), que no son para bajar el arnés
  for (const title of ['What you need', 'Install with Claude Code', 'Requirements', 'Install by hand']) {
    const acts = credentialActs(withoutLimit(sectionOf(at(title))(text, lang)));
    if (acts.length) out.push(`permiso — «${titleOf(at(title), lang)}» pide un permiso: ${acts.map((m) => m.replace(/^permiso — /, '')).join(' · ')}`);
  }
  // y lo que el permiso propio NO cubre queda dicho donde se lo recomienda: la línea que baja el guion va sin credencial,
  // así que en una máquina compartida un permiso en la variable no evita el 403 de esa línea
  const afterUnattended = IN_INSTALL(text, lang).split('<!-- /install:unattended -->')[1] || '';
  const sharedMachine = paragraphsOf(afterUnattended).find((p) => /TYCON_GITHUB_TOKEN/.test(p)) || '';
  for (const k of lang === 'en' ? ['covers what the script and the install request', 'goes without a credential either way'] : ['cubre lo que piden el guion y la instalación', 'va sin credencial igual']) {
    if (!says(sharedMachine, k)) out.push(`límite de pedidos — donde se recomienda el permiso para una máquina compartida falta «${k}»`);
  }
  // el bloque que instala baja el guion con el renglón sin credencial
  let core = '';
  try { core = block(text, 'install:core', README[lang]); } catch (e) { out.push(`bajada — ${e.message}`); }
  for (const shell of ['bash', 'powershell']) if (!core.split('\n').includes(DOWNLOAD_LINE[shell])) out.push(`bajada — install:core (${shell}) no trae el renglón sin credencial`);
  return out;
}

// 🔴 rojo previo (medido con las páginas y las portadas de antes): cada página falla en «manda a crear un permiso»,
//    «habla de una invitación», «manda una credencial», «dice que el repo es privado», «guarda un permiso», el caso del
//    403 (no está), la bajada y las dos referencias (ocho pasos, no siete); cada portada, en los mismos cuatro primeros,
//    en TYCON_GITHUB_TOKEN fuera del caso del límite, en las tres secciones y en la bajada.
test('T80 TeamOnboardingText_InTeamLayer_GettingStartedWithoutRepoPermission — ninguna página de primeros pasos pide un permiso para bajar el arnés', async (t) => {
  const pages = Object.fromEntries(GUIDED_PAPERS.map((rel) => [rel, readPaper(rel)]));
  const covers = { en: readCover('en'), es: readCover('es') };

  await t.test('las tres páginas: sin permiso, sin invitación, sin credencial en la bajada, gemelas, y con el caso del límite', () => {
    for (const rel of GUIDED_PAPERS) assert.deepStrictEqual(guidedPermissionProblems(pages[rel], SHELL_OF[rel]), [], `${rel}: lo que le falta o le sobra`);
    // gemelas también en el caso del límite: el mismo párrafo, letra por letra, en las tres — salvo el renglón seguro, que
    // es el de cada sistema
    const notes = GUIDED_PAPERS.map((rel) => paragraphsOf(pages[rel]).filter(saysLimit).join('\n\n').split(SAFE_TOKEN_LINE[SHELL_OF[rel]]).join('<el renglón seguro>'));
    assert.ok(notes.every((n) => n && n.includes('<el renglón seguro>') && n === notes[0]), 'el caso del límite de pedidos es el mismo párrafo en las tres páginas, cada una con su renglón seguro');
    // y la página baja el guion con el renglón de la portada: uno solo, sin la variable del permiso
    for (const shell of ['bash', 'powershell']) {
      assert.strictEqual(DOWNLOAD_LINE[shell], INSTALL_LINES[shell][0], `la página y la portada bajan el guion (${shell}) con el mismo renglón`);
      assert.doesNotMatch(DOWNLOAD_LINE[shell], /TYCON_GITHUB_TOKEN|Bearer|@-/, `el renglón de la bajada (${shell}) no lleva credencial`);
    }
  });

  await t.test('las dos portadas: lo mismo, en los dos idiomas', () => {
    for (const lang of ['en', 'es']) assert.deepStrictEqual(coverPermissionProblems(covers[lang], lang), [], `${README[lang]}: lo que le falta o le sobra`);
  });

  await t.test('el espejo: una página de juguete con el paso viejo, o con un paso corrido, falla en ESE punto', () => {
    for (const rel of GUIDED_PAPERS) {
      const real = pages[rel];
      const shell = SHELL_OF[rel];
      const failsWith = (toy, needle, what) => {
        assert.notStrictEqual(toy, real, `${rel}: la página de juguete de «${what}» es igual a la real`);
        assert.ok(guidedPermissionProblems(toy, shell).some((m) => m.includes(needle)), `${rel}: ${what} tenía que fallar con «${needle}» — dio: ${guidedPermissionProblems(toy, shell).join(' · ') || 'nada'}`);
      };
      // un renglón de más al final de un paso (el paso tiene que estar: si no, la página ya falla por sus pasos)
      const inStep = (kind, extra) => { const s = guidedPartOne(real).steps.find((x) => x.kind === kind); assert.ok(s, `${rel}: no encuentro el paso ${kind}`); return real.replace(s.body, () => `${s.body.replace(/\n+$/, '')}\n${extra}\n`); };
      failsWith(inStep('tools', '   Antes, que entre a https://github.com/settings/personal-access-tokens/new y cree un token.'), 'personal-access-tokens', 'mandar a crear un permiso');
      failsWith(inStep('tools', '   Antes tengo que aceptar la invitación al repo.'), 'invitación', 'pedir la invitación');
      failsWith(inStep('tools', '   El arnés vive en un repo privado de GitHub.'), 'privado', 'decir que el repo es privado');
      failsWith(inStep('plan', '   Baja la versión a una carpeta temporal y guarda mi permiso en ~/.tycon/config.json.'), 'guarda un permiso', 'el plan que guarda un permiso');
      failsWith(inStep('tools', '   El permiso de lectura lo pongo yo en TYCON_GITHUB_TOKEN.'), 'fuera del caso del límite', 'el permiso fuera del caso del límite');
      const withHeader = shell === 'bash' ? real.replace(DOWNLOAD_LINE.bash, `printf 'Authorization: Bearer %s\\n' "$T" | curl -fsSL -H @- -o get-harness.sh ${SCRIPT_URL('get-harness.sh')}`) : real.replace(DOWNLOAD_LINE.powershell, `Invoke-WebRequest -Headers @{ Authorization = "Bearer $t" } -OutFile get-harness.ps1 ${SCRIPT_URL('get-harness.ps1')}`);
      failsWith(withHeader, 'Authorization', 'una bajada con credencial');
      failsWith(withHeader, 'bajada —', 'una bajada que no es el renglón de la portada');
      const limit = paragraphsOf(real).find(saysLimit);
      failsWith(real.replace(limit, () => 'Un párrafo cualquiera.'), 'el caso del 403', 'una página sin el caso del límite');
      failsWith(real.replace(limit, () => limit.replace('60 por hora', 'unos cuantos por hora')), '60 por hora', 'el caso del límite sin la cuenta');
      // un paso de más corre a los que siguen: las referencias dejan de apuntar al suyo
      const tools = guidedPartOne(real).steps.find((s) => s.kind === 'tools');
      const shifted = real.replace(tools.body, () => `${tools.body}2. Un paso nuevo, que hago YO.\n`).replace(/^(\d+)\. (?!Herramientas|Un paso nuevo)/gm, (m, n) => `${Number(n) + 1}. `);
      failsWith(shifted, 'referencias — el perfil mínimo', 'un paso de más, sin correr la referencia del perfil');
      failsWith(shifted, 'referencias — el reporte', 'un paso de más, sin correr la referencia del reporte');
      failsWith(real.replace('y salteá el paso', 'y los pasos 2 a 4 los corro YO; salteá el paso'), 'por su número', 'una referencia a pasos que la prueba no comprueba');
    }
    for (const lang of ['en', 'es']) {
      const real = covers[lang];
      const failsWith = (toy, needle, what) => assert.ok(coverPermissionProblems(toy, lang).some((m) => m.includes(needle)), `${README[lang]}: ${what} tenía que fallar con «${needle}»`);
      failsWith(`${real}\nhttps://github.com/settings/personal-access-tokens/new\n`, 'personal-access-tokens', 'mandar a crear un permiso');
      failsWith(`${real}\n${lang === 'en' ? 'Accept the invitation first.' : 'Primero aceptá la invitación.'}\n`, 'invitación', 'pedir la invitación');
      failsWith(`${real}\n${lang === 'en' ? 'Today this repository is private.' : 'Hoy este repo es privado.'}\n`, 'privado', 'decir que el repo es privado');
      failsWith(`${real}\n\n${lang === 'en' ? 'Put your permission in `TYCON_GITHUB_TOKEN` first.' : 'Antes poné tu permiso en `TYCON_GITHUB_TOKEN`.'}\n`, 'fuera del caso del límite', 'el permiso como requisito');
      failsWith(real.replace(DOWNLOAD_LINE.bash, `printf 'Authorization: Bearer %s\\n' "$T" | ${DOWNLOAD_LINE.bash}`), 'install:core (bash)', 'una bajada con credencial');
      const title = `## ${titleOf(at('What you need'), lang)}`;
      failsWith(real.replace(title, `${title}\n\n- ${lang === 'en' ? 'A read permission for this repository.' : 'Un permiso de lectura sobre este repo.'}`), 'pide un permiso', 'el permiso entre lo que hace falta');
      const inst = IN_INSTALL(real, lang);
      failsWith(real.replace(inst, () => inst.replace(/\b403\b/g, 'un error')), '«403»', 'una portada sin el caso del límite');
      // la promesa de más: recomendar el permiso para una máquina compartida sin decir que la bajada del guion no lo usa
      const covers1 = lang === 'en' ? 'goes without a credential either way' : 'va sin credencial igual';
      failsWith(real.replace(loose(covers1), 'too'), covers1, 'prometer que el permiso evita el 403 de la línea que baja el guion');
    }
  });

  // Las doce mutaciones de la revisión independiente de esta rama, una por una y cada una sobre UN papel: cuatro de ellas
  // (el mismo paso REESCRITO: «token» por «permiso», el adjetivo adelante, un párrafo sin número) pasaban la primera
  // versión de esta prueba en verde. Las que reponían un papel «entero como antes» van acá como el paso de antes pegado
  // de vuelta, con su texto literal.
  await t.test('el espejo de la revisión: doce maneras de volver a meter el paso, las doce en rojo', () => {
    const must = (text, from, to) => { assert.ok(text.includes(from), `la mutación no encuentra su ancla: «${from.slice(0, 50)}»`); return text.replace(from, () => to); };
    const OLD_BASH_DOWNLOAD = `printf 'Authorization: Bearer %s\\n' "$TYCON_GITHUB_TOKEN" | curl -fsSL -H @- -H "Accept: application/vnd.github.raw" -o get-harness.sh`;
    const NEW_BASH_DOWNLOAD = 'curl -fsSL -o get-harness.sh';
    const OLD_STEP = [
      '2. El permiso de lectura de GitHub. Esto lo hago YO, porque es una clave y no pasa por el chat: PARÁ y decime que entre',
      '   a https://github.com/settings/personal-access-tokens/new con la cuenta que recibió la invitación, cree un permiso',
      '   «Fine-grained» de sólo lectura (Repository access: sólo este repo; Permissions: Contents → Read-only) y que en una',
      '   terminal corra, pegando el permiso cuando lo pida (no se ve al pegarlo):',
      "       printf 'Permiso de GitHub: ' && read -rs TYCON_GITHUB_TOKEN && echo && export TYCON_GITHUB_TOKEN",
      '   Los pasos 3 a 5 los corro YO en ESA terminal, con los comandos que me des. Vos no leas ni muestres el permiso.',
      '',
    ].join('\n');
    const OLD_COVER_BULLET = '- The repo invitation, accepted, and a **read permission** for this repository: a fine-grained token (Contents:\n  read-only, on this repository only). You paste it once; the harness keeps it in `~/.tycon/config.json`.\n';
    const page = (rel) => pages[`getting-started/${rel}`];
    const MUTATIONS = [
      ['P1', 'mac.md', (t) => must(must(t, '2. Ver el plan de instalación', `${OLD_STEP}\n2. Ver el plan de instalación`), NEW_BASH_DOWNLOAD, OLD_BASH_DOWNLOAD)],
      ['P2', 'linux.md', (t) => must(t, NEW_BASH_DOWNLOAD, OLD_BASH_DOWNLOAD)],
      ['P3', 'windows.md', (t) => must(t, 'No hace falta cuenta de GitHub ni permiso: el arnés se baja de un repo público.', 'Antes, aceptá la invitación al repo que te llegó por mail de GitHub.')],
      ['P4', 'README.md', (t) => must(must(t, '- Claude Code (or Codex), installed and signed in', `${OLD_COVER_BULLET}- Claude Code (or Codex), installed and signed in`), NEW_BASH_DOWNLOAD, OLD_BASH_DOWNLOAD)],
      ['P5', 'README.es.md', (t) => must(t, '### 2. Bajar e instalar', '**En todos los sistemas**, creá antes un token de GitHub de sólo lectura con tu cuenta y dejalo a mano: el instalador lo va a pedir.\n\n### 2. Bajar e instalar')],
      ['P6', 'README.es.md', (t) => { const i = t.indexOf('<!-- install:unattended -->'); const j = t.indexOf(NEW_BASH_DOWNLOAD, i); assert.ok(i >= 0 && j > i, 'la mutación no encuentra el bloque sin terminal'); return `${t.slice(0, j)}${OLD_BASH_DOWNLOAD}${t.slice(j + NEW_BASH_DOWNLOAD.length)}`; }],
      ['P7', 'mac.md', (t) => must(t, 'Baja la versión a una carpeta temporal y muestra el plan.', 'Baja la versión a una carpeta temporal, guarda mi token en ~/.tycon/config.json y muestra el plan.')],
      ['P8', 'windows.md', (t) => must(t, 'en los pasos 2 y 3 cambiá --profile full por\n--profile minimal, y salteá el paso 4', 'en los pasos 3 y 4 cambiá --profile full por\n--profile minimal, y salteá el paso 5')],
      ['P9', 'linux.md', (t) => must(t, 'y armame UN solo bloque de texto, para guardarlo o para pedir ayuda (sin tokens', 'y armame UN solo bloque de texto para pasarle a quien me invitó al repo (sin tokens')],
      ['P10', 'mac.md', (t) => must(t, '(como mucho una hora)', '(como mucho dos horas)')],
      ['P11', 'README.md', (t) => must(t, '### 2. Download and install', 'This is a private repository: ask the maintainers for access and create an access key first.\n\n### 2. Download and install')],
      ['P12', 'mac.md', (t) => must(t, '2. Ver el plan de instalación', '   Antes de seguir: PARÁ y decime que cree un token clásico de GitHub (Settings → Developer settings) y que lo\n   exporte en mi terminal como GH_TOKEN. Sin eso no sigas.\n\n2. Ver el plan de instalación')],
    ];
    assert.strictEqual(MUTATIONS.length, 12);
    for (const [id, file, make] of MUTATIONS) {
      const isCover = /^README/.test(file);
      const lang = file === 'README.md' ? 'en' : 'es';
      const real = isCover ? covers[lang] : page(file);
      const toy = make(real);
      assert.notStrictEqual(toy, real, `${id}: la mutación no cambió ${file}`);
      // sólo cuenta lo que la mutación AGREGA: un papel que ya viniera con un problema no la pone «en rojo» de prestado
      const problemsOf = (text) => (isCover ? coverPermissionProblems(text, lang) : guidedPermissionProblems(text, SHELL_OF[`getting-started/${file}`]));
      const before = problemsOf(real);
      let problems = problemsOf(toy).filter((p) => !before.includes(p));
      // (P10 no rompe la página por sí sola: rompe que las tres sean gemelas)
      if (id === 'P10') {
        const note = (text, rel) => paragraphsOf(text).filter(saysLimit).join('\n\n').split(SAFE_TOKEN_LINE[SHELL_OF[rel]]).join('<el renglón seguro>');
        if (note(toy, 'getting-started/mac.md') !== note(pages['getting-started/linux.md'], 'getting-started/linux.md')) problems = [...problems, 'gemelas — el párrafo del límite ya no es el de las otras páginas'];
      }
      assert.ok(problems.length > 0, `${id} (${file}): la mutación de la revisión quedó en verde`);
    }
  });
});
