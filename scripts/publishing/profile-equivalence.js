#!/usr/bin/env node
'use strict';
/**
 * profile-equivalence.js — ¿el equipo, con su perfil, sigue teniendo EXACTAMENTE lo mismo que tenía cuando
 * todo estaba escrito a mano? (story 8.3, AC 11 / T11 — la tanda A mide rutas y valores; la B cierra los
 * estados de integración).
 *
 * ── LA FALLA QUE MIDE ─────────────────────────────────────────────────────────────────────────────
 * La 8.3 saca del código dónde está el arnés, dónde viven los repos, la organización de Azure DevOps y el
 * chat de Telegram. La cara interna de esa falla es que una ruta o un servicio que HOY anda quede distinto
 * —o apagado— después del cambio sin que nadie se entere. Esto compara el código de `main` al sha (la línea
 * base, extraída con `git archive`: nunca una tabla escrita por quien escribe este script) contra el clon
 * actual, en esta máquina, con el perfil del equipo:
 *
 *   1. los HOOKS que registra el instalador, por NOMBRE (evento + matcher + script): los dos instaladores
 *      corren con `--check` en HOMEs temporales con `~/.claude/agent-skills` enlazado al real (sin él abortan),
 *      con `TYCON_CODEX=0` y todos los `TYCON_NO_*` (el instalador lanza suites, el refresco de `az`, el
 *      despliegue Codex y sesiones LLM reales aun con HOME temporal). Por nombre y no por comando: cada clon
 *      registra la ruta absoluta de sus hooks;
 *   2. los VALORES que hoy están escritos a mano, resueltos por las dos versiones en esta máquina: la raíz de
 *      repos (`repos-root.js`), el veredicto de la ruta canónica (`canonical-path.js`: la base contra la carpeta
 *      fija de entonces; el nuevo contra el enlace, creado en un HOME temporal como lo haría el instalador),
 *      qué repos son del arnés (`harness-repo.js` sobre el checkout real, agent-skills y hasta tres repos de
 *      producto), la carpeta del arnés (el literal de la base contra el enlace), la organización de Azure
 *      DevOps (los literales de los archivos del censo contra `ado.org` del perfil) y el chat de Telegram (el
 *      literal contra `telegram.chat_id` resuelto);
 *   3. el ESTADO de cada integración (tanda B), por SONDAS mecánicas sobre las dos versiones, nunca una tabla escrita:
 *      clockify, engram y nightly por sus hooks en el reporte `--check` de cada instalador (base vs nuevo con el
 *      perfil); ado por la organización escrita en la base vs `ado.org` resuelto; telegram por el chat escrito vs el
 *      resuelto; buzón por la llave que viene con el código vs `integrations.mailbox`; codex por `TYCON_CODEX` con el
 *      mismo ambiente para los dos; codegraph por «ningún instalador registra nada de CodeGraph» en los dos.
 *
 * Una sola diferencia es rojo (exit 1), no una tolerancia. El informe queda en `--out` (por defecto
 * `tasks/medicion-8.3-perfil-del-equipo.md`), con el sha, la máquina y el veredicto por ítem.
 *
 * Uso: node scripts/publishing/profile-equivalence.js --base <sha> [--out <md>] [--json]
 *        [--real-clone <dir>]     el checkout que el equipo usa (por defecto, este clon); en un clon descartable
 *                                 conviene pasar el checkout real: la base compara contra la carpeta fija de entonces
 *        [--agent-skills <dir>]   el repo de agent-skills (por defecto TYCON_SKILLS_DIR o ~/.claude/agent-skills)
 *
 *      node scripts/publishing/profile-equivalence.js --settings <antes.json> <despues.json>   (story 8.13, AC 14)
 *        Modo APARTE: compara dos `settings.json` por los hooks DEL ARNÉS (evento → matcher → nombre del script →
 *        comando entero + async). Lo ajeno y su orden no cuentan; la línea de arranque (`git pull` / `bootstrap.js`) se
 *        compara aparte como `startup-line` y se informa pero no decide. Sale 0 iguales · 1 con la lista · 2 si un
 *        archivo no se pudo leer (un listado que falló no es «sin diferencias»).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
// La línea base es un sha anterior: si es de antes del renombre a inglés (story 8.9), su instalador sólo lee el nombre
// viejo de cada interruptor. Por eso cada interruptor renombrado se fija con los dos nombres (el viejo sale del mapa).
const { envNames, usableEntries, loadMap, basenameRenames } = require('../lib/legacy-names.js');
const conNombresViejos = (vars) => {
  const out = {};
  for (const [k, v] of Object.entries(vars)) for (const n of envNames(k)) out[n] = v;
  return out;
};
// Lo mismo con las opciones: el `canonical-path.js` de una base anterior al renombre sólo entiende el nombre viejo, y el de
// después entiende los dos (por alias). A la base se le pasa el viejo, que sale del mapa —nunca escrito acá—; sin mapa
// (la copia pública), el nuevo.
const opcionParaLaBase = (where, nuevo) => {
  const e = usableEntries(loadMap()).find((x) => x.kind === 'option' && x.where === where && x.new === nuevo);
  return `--${e ? e.old : nuevo}`;
};
const SIN_EFECTOS = conNombresViejos({
  TYCON_CODEX: '0', TYCON_NO_UPLOAD_RUNS: '1', TYCON_NO_DOWNLOAD_RUNS: '1', TYCON_NO_THREAD_RESCUE: '1',
  TYCON_NO_COLLECT_FINDINGS: '1', TYCON_NO_AZ_PROJECTS_REFRESH: '1', TYCON_NO_NIGHTLY_EXAM: '1',
  TYCON_NO_CLAUDEMD_SYNC: '1', TYCON_NO_COMMANDS_SYNC: '1', TYCON_NO_ENGRAM_VERSION_CHECK: '1', TYCON_NO_SQLITE_CHECK: '1',
  TYCON_NO_ENGRAM_PROJECT_CHECK: '1', TYCON_NO_GIT_HOOKS: '1', TYCON_NO_GUI_ENV: '1', TYCON_NO_AGENTSMD_POINTER: '1',
  TYCON_STAGE_METRICS: '0',   // el barrido de métricas de etapa de fondo no mira --check (pase adversarial, vuelta 1)
});
// Los archivos donde el censo (story 8.3, §Origen) encontró la organización y el chat escritos a mano.
// La base es de ANTES de cualquier renombre de la 8.9 (o de después): un archivo renombrado se lee por el nombre que
// tenga en esa base (`enLaBase`), y por eso este archivo nombra los viejos a propósito (LEGACY_READERS de spanish-names.js).
const ARCHIVOS_ORG = [['scripts/ci/validate-pipeline-in-ado.sh', 'scripts/ci/validar-pipeline-en-ado.sh'], 'scripts/install-tycon-hooks.sh', ['scripts/lib/harness-repo.js', 'scripts/lib/repo-del-arnes.js'], 'scripts/production/install-guard.sh'];
/** La ruta con que existe en la base: la nueva si ya está, si no la vieja. */
const enLaBase = (dirBase, f) => (Array.isArray(f) ? f.find((x) => fs.existsSync(path.join(dirBase, x))) || f[f.length - 1] : f);
// El observador pasó a scripts/instincts/ en la story 8.12 (tanda R2) y dejó un reemplazo en la ruta vieja, que no
// trae el chat: la nueva primero; la vieja sólo si la base es de antes de la mudanza. La vieja sale del mapa —nunca
// escrita acá—; sin mapa (la copia pública), sólo la nueva.
const CHAT_NEW = 'scripts/instincts/instinct-observer.js';
const chatOld = (usableEntries(loadMap()).find((x) => x.kind === 'file' && x.new === CHAT_NEW) || {}).old;
const ARCHIVO_CHAT = [CHAT_NEW, ...(chatOld ? [chatOld] : [])];
/** El archivo de la base donde está el chat de Telegram escrito a mano. */
const chatFileIn = (dirBase) => enLaBase(dirBase, ARCHIVO_CHAT);

function arg(k, def) { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : def; }
function real(p) { try { return fs.realpathSync(p); } catch (_) { return null; } }
function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }
function leer(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; }
}
// 🔴 Un proceso que NO llegó a correr (binario ausente, tiempo agotado, señal) no devuelve «vacío»: devuelve
// «no medido», y una medición con un «no medido» adentro es roja — si los dos lados fallan por la misma causa
// ajena, compararlos como «igual» sería verificarse a sí misma (cazador de fallos silenciosos, vuelta 1).
const FALLOS = [];
function correr(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, Object.assign({ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, opts));
  if (r.error || r.status === null) {
    FALLOS.push(`${cmd} ${args.slice(0, 2).join(' ')}: ${r.error ? r.error.message : `sin código de salida (señal ${r.signal || '?'})`}`);
  }
  return { rc: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '', fallo: !!(r.error || r.status === null) };
}

/** Un HOME temporal como el del instalador: agent-skills enlazado; el resto vacío. */
function casa(skills) {
  const h = tmp('equiv-perfil-home-');
  fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
  fs.symlinkSync(skills, path.join(h, '.claude', 'agent-skills'));
  return h;
}
function envDe(home, extra = {}) { return Object.assign({ PATH: process.env.PATH, HOME: home, TMPDIR: os.tmpdir() }, SIN_EFECTOS, extra); }

/** Los nombres de hook del reporte `--check` del instalador. La clave canónica de settings
 *  (`settings (matcher='*') → settings:cleanupPeriodDays`) sale con el mismo formato y NO es un hook: se cuenta aparte. */
function parsearHooks(texto) {
  const hooks = [];
  const settings = [];
  for (const l of String(texto || '').split('\n')) {
    const m = /^  \+ (.+?)  \[/.exec(l);
    if (!m) continue;
    (/^settings /.test(m[1]) ? settings : hooks).push(m[1].trim());
  }
  return { hooks: hooks.sort(), settings: settings.sort() };
}
/** Un hook renombrado (story 8.9, tanda C1) sale en la base con su nombre viejo: los dos lados pasan por el mapa antes de
 *  comparar, así un renombre no se lee como «falta uno y sobra otro» ni apaga una integración que sigue prendida. */
function conNombresNuevos(nombres, renombres = basenameRenames(loadMap())) {
  if (!renombres.size) return nombres;
  return nombres.map((h) => String(h).replace(/[\w.-]+\.(?:js|sh|ps1|py|command)\b/g, (b) => renombres.get(b) || b));
}
/** Los hooks que el instalador registraría, por nombre, leídos de su propio reporte `--check`. */
function hooksDe(clon, home) {
  const r = correr('bash', [path.join(clon, 'scripts', 'install-tycon-hooks.sh'), '--check'], { env: envDe(home), timeout: 180000 });
  const p = parsearHooks(r.out);
  return { rc: r.rc, nombres: conNombresNuevos(p.hooks).sort(), settings: p.settings, salida: r.out };
}
/** Qué falta y qué sobra entre las dos listas. «No pude mirar» no es «coincide»: un reporte sin una sola línea de
 *  hook parseable es una medición fallida (`fallos`), no dos listas iguales (pase adversarial, vuelta 1). */
function compararHooks(hBase, hNuevo) {
  const fallos = [];
  if (!hBase.nombres.length) fallos.push('instalador de la base --check: ninguna línea de hook parseable');
  if (!hNuevo.nombres.length) fallos.push('instalador nuevo --check: ninguna línea de hook parseable');
  return {
    faltan: hBase.nombres.filter((h) => !hNuevo.nombres.includes(h)),
    sobran: hNuevo.nombres.filter((h) => !hBase.nombres.includes(h)),
    fallos,
  };
}
// ── el estado de las ocho integraciones (tanda B) ─────────────────────────────────────────────────
/** Los hooks que el instalador registra por cada integración (los mismos que gatea por su llave). */
const HOOKS_DE_INTEGRACION = Object.freeze({
  clockify: ['clocki/scripts/on-prompt.js', 'clocki/scripts/touch-activity.js'],
  engram: ['@tcg:engram-pre-commit.sh', '@tcg:engram-drift-notice.js'],
  nightly: ['@tcg:dashboard-notice.js', '@tcg:dependencies-notice.js', '@tcg:retro-staleness-notice.js'],
});
/** «prendida» si TODOS los hooks de la integración están en la lista de nombres del reporte --check; «apagada» si ninguno;
 *  «parcial (n/m)» si algunos — un hook de tres no es ni una cosa ni la otra, y se dice. */
function estadoPorHooks(nombres, llave) {
  const h = HOOKS_DE_INTEGRACION[llave];
  if (!h) throw new Error(`integración sin hooks conocidos: ${llave}`);
  const n = h.filter((x) => nombres.some((nm) => String(nm).includes(x))).length;
  return n === h.length ? 'prendida' : n === 0 ? 'apagada' : `parcial (${n}/${h.length})`;
}
/** Las ocho, base vs nuevo. `conf` es la salida de `tycon-config.js explain --json` con el perfil (sus `integraciones` son
 *  textos como «prendida (perfil)»). Devuelve [{ llave, viejo, nuevo, igual, nota }] en el orden de la tabla de la story. */
/** Lo que el informe escribe del chat de Telegram: la IGUALDAD se decide sobre los valores reales y sólo se enmascara el
 *  texto — la base dice «presente» y el nuevo «presente» si es el mismo chat u «OTRO» si cambió, así un chat distinto sale
 *  rojo (AC 11: una diferencia es rojo). La primera versión armaba el mismo texto para los dos lados cuando eran distintos
 *  y el informe daba verde (revisor de cobertura de ACs, tanda B, vuelta 3). */
function chatEnmascarado(chatBase, chatNuevo) {
  const viejo = chatBase ? 'chat presente (enmascarado)' : null;
  const nuevo = chatNuevo ? (chatBase && chatBase !== chatNuevo ? 'chat presente (OTRO, enmascarado)' : 'chat presente (enmascarado)') : null;
  return [viejo, nuevo];
}
function compararIntegraciones({ hooksBase, hooksNuevo, conf, orgBase, chatBase, llaveBase, codexBase, codegraphBase, codegraphNuevo }) {
  const texto = (s) => (/^detect\b/.test(String(s)) ? 'detect' : /^prendida/.test(String(s)) ? 'prendida' : 'apagada');
  const c = (conf && conf.integraciones) || {};
  const porHooks = (llave, que) => ({ llave, viejo: estadoPorHooks(hooksBase, llave), nuevo: estadoPorHooks(hooksNuevo, llave), nota: `por ${que} en el reporte --check de cada instalador · el lector, con el perfil: ${c[llave]}` });
  const filas = [
    { llave: 'ado', viejo: orgBase.length ? 'prendida' : 'apagada', nuevo: texto(c.ado), nota: `base: organización escrita a mano (${orgBase.join(', ') || 'ninguna'}) · nuevo: ${c.ado}` },
    porHooks('clockify', 'los dos hooks de clocki'),
    porHooks('engram', 'el sync de commit y el aviso diario de engram'),
    { llave: 'codegraph', viejo: codegraphBase, nuevo: codegraphNuevo, nota: `ningún instalador registra nada de CodeGraph: la instala cada dev (install-codegraph.sh) · el lector: ${c.codegraph}` },
    { llave: 'telegram', viejo: chatBase ? 'prendida' : 'apagada', nuevo: texto(c.telegram), nota: `base: chat escrito en el observador (${chatBase ? 'presente, enmascarado' : 'ninguno'}) · nuevo: ${c.telegram}` },
    { llave: 'mailbox', viejo: llaveBase ? 'prendida' : 'apagada', nuevo: texto(c.mailbox), nota: `base: la llave corridas-buzon.json ${llaveBase ? 'viene' : 'no viene'} con el código · nuevo: ${c.mailbox}` },
    { llave: 'codex', viejo: codexBase, nuevo: texto(c.codex), nota: `mismo ambiente para los dos (TYCON_CODEX=${process.env.TYCON_CODEX === undefined ? 'sin definir' : process.env.TYCON_CODEX}) · nuevo: ${c.codex}` },
    porHooks('nightly', 'los tres avisos de arranque'),
  ];
  return filas.map((f) => Object.assign(f, { igual: f.viejo === f.nuevo }));
}

/** De dónde sale «lo nuevo»: HEAD, y si el árbol de trabajo tiene cambios sin commitear, se dice — corrido ANTES del
 *  commit (el orden del pipeline) HEAD es el mismo sha que la base, y un informe que dijera «base X · nuevo X» no
 *  sería reproducible (pase adversarial, vuelta 1). Se mira `status --porcelain` (cuenta lo no versionado), no
 *  `describe --dirty` (que con un archivo nuevo sin agregar no dice nada). */
function procedenciaDe(raiz) {
  const shaHead = correr('git', ['-C', raiz, 'rev-parse', 'HEAD']).stdout.trim();
  const sucio = correr('git', ['-C', raiz, 'status', '--porcelain']).stdout.trim();
  const rutasSucias = sucio ? sucio.split('\n').length : 0;
  return { shaHead, rutasSucias, shaNuevo: rutasSucias ? `${shaHead} + árbol de trabajo sin commitear (${rutasSucias} rutas)` : shaHead };
}

function reposDeProducto(root, n) {
  if (!root) return [];
  let out = [];
  try {
    out = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(root, e.name))
      .filter((d) => fs.existsSync(path.join(d, '.git'))).sort().slice(0, n);
  } catch (_) { out = []; }
  return out;
}

function main() {
  if (process.argv.includes('--settings')) return settingsMode(process.argv);   // story 8.13 (AC 14): modo aparte, al final del archivo
  const base = arg('--base');
  if (!base) { console.error('uso: profile-equivalence.js --base <sha> [--out <md>] [--json] [--real-clone <dir>] [--agent-skills <dir>]'); return 2; }
  const out = arg('--out', path.join(RAIZ, 'tasks', 'medicion-8.3-perfil-del-equipo.md'));
  const clonReal = real(arg('--real-clone', RAIZ)) || RAIZ;
  let skills = arg('--agent-skills');
  // «No pude preguntar» no es «está en el lugar de siempre» (story 8.18, 2026-10-04): la biblioteca tira cuando su vecina
  // está y no carga. Seguir con ~/.claude/agent-skills era medir las skills instaladas en vez de las del clon, callado.
  if (!skills) {
    try { skills = require(path.join(RAIZ, 'scripts', 'lib', 'skills-dir.js')).resolveSkillsDirs().repo; } catch (e) {
      console.error(`no pude resolver la carpeta de skills: ${String((e && e.message) || e).split('\n')[0]} (o decila con --agent-skills <dir>)`);
      return 2;
    }
  }
  skills = real(skills) || skills;
  if (!fs.existsSync(path.join(skills, 'skills', 'tycon-pipeline'))) { console.error(`agent-skills no está en ${skills}: los instaladores abortan sin él (--agent-skills <dir>)`); return 2; }

  // 1. la línea base: el código de main al sha, extraído con git archive
  const dirBase = tmp('equiv-perfil-base-');
  const shaBase = correr('git', ['-C', RAIZ, 'rev-parse', '--verify', `${base}^{commit}`]).stdout.trim();
  if (!shaBase) { console.error(`no encuentro el commit ${base} en ${RAIZ}`); return 2; }
  execFileSync('sh', ['-c', `git -C "${RAIZ}" archive "${shaBase}" | tar -x -C "${dirBase}"`]);
  const { shaNuevo } = procedenciaDe(RAIZ);
  const items = [];
  const item = (grupo, nombre, viejo, nuevo, opts = {}) => {
    const igual = opts.pendiente ? null : JSON.stringify(viejo) === JSON.stringify(nuevo);
    items.push({ grupo, nombre, viejo, nuevo, igual, pendiente: !!opts.pendiente, nota: opts.nota });
  };

  // 2. hooks por nombre
  const hBase = hooksDe(dirBase, casa(skills));
  const hNuevo = hooksDe(RAIZ, casa(skills));
  const { faltan, sobran, fallos: fallosHooks } = compararHooks(hBase, hNuevo);
  FALLOS.push(...fallosHooks);
  item('hooks', 'instalador --check: hooks registrados (por nombre)', hBase.nombres, hNuevo.nombres,
    { nota: `base ${hBase.nombres.length} · nuevo ${hNuevo.nombres.length} (más ${hNuevo.settings.length} clave(s) de settings, aparte)${faltan.length ? ` · faltan: ${faltan.join(' · ')}` : ''}${sobran.length ? ` · sobran: ${sobran.join(' · ')}` : ''}` });
  item('hooks', 'instalador --check: sale 0 (aviso, nunca freno)', hBase.rc, hNuevo.rc);

  // 3. valores en esta máquina
  const rrB = correr(process.execPath, [path.join(dirBase, 'scripts', 'lib', 'repos-root.js')]).stdout.trim();
  const rrN = correr(process.execPath, [path.join(RAIZ, 'scripts', 'lib', 'repos-root.js')]).stdout.trim();
  const raiz = (s) => { const m = /raíz de repos: (.+?) · fuente:/.exec(s); return m ? m[1] : s; };
  item('valores', 'raíz de repos (repos-root.js)', raiz(rrB), raiz(rrN), { nota: `base «${rrB}» · nuevo «${rrN}»` });

  // ruta canónica: la base contra la carpeta fija de entonces; el nuevo contra el enlace, creado en un HOME
  // temporal exactamente como lo haría el instalador sobre el checkout real
  const rcB = correr(process.execPath, [path.join(dirBase, enLaBase(dirBase, ['scripts/lib/canonical-path.js', 'scripts/lib/ruta-canonica.js'])), opcionParaLaBase('scripts/lib/canonical-path.js', 'clone'), clonReal], { env: { PATH: process.env.PATH, HOME: os.homedir() } }).stdout.trim();
  const homeEnlace = casa(skills);
  correr(process.execPath, [path.join(RAIZ, 'scripts', 'lib', 'canonical-path.js'), '--ensure-link', '--clone', clonReal, '--home', homeEnlace]);
  const rcN = correr(process.execPath, [path.join(RAIZ, 'scripts', 'lib', 'canonical-path.js'), '--clone', clonReal, '--home', homeEnlace], { env: { PATH: process.env.PATH, HOME: homeEnlace } }).stdout.trim();
  item('valores', `ruta canónica (canonical-path.js) sobre ${clonReal}: calla / avisa`, rcB ? 'avisa' : 'calla', rcN ? 'avisa' : 'calla', { nota: rcB || rcN ? `base: ${rcB.split('\n')[0] || 'calla'} · nuevo: ${rcN.split('\n')[0] || 'calla'}` : 'los dos callan' });

  const rootNuevo = raiz(rrN);
  const objetivos = [clonReal, skills, ...reposDeProducto(rootNuevo && rootNuevo !== '(sin raíz)' ? rootNuevo : null, 3)];
  for (const o of objetivos) {
    const jB = correr(process.execPath, [path.join(dirBase, enLaBase(dirBase, ['scripts/lib/harness-repo.js', 'scripts/lib/repo-del-arnes.js'])), o]).stdout;
    const jN = correr(process.execPath, [path.join(RAIZ, 'scripts', 'lib', 'harness-repo.js'), o]).stdout;
    const v = (s) => { try { return JSON.parse(s).arnes; } catch (_) { return `ilegible: ${s.slice(0, 60)}`; } };
    item('valores', `repo del arnés (harness-repo.js) → ${o}`, v(jB), v(jN));
  }

  // la carpeta del arnés: el literal de la base (resuelto contra este home) contra el enlace
  const litBase = leer(path.join(dirBase, 'scripts', 'hooks', 'git-pre-commit-global.sh')).match(/TYCON_GUIDES_DIR:-\$HOME\/([^}]+)\}/);
  // una base posterior a la story 8.19 ya no escribe el literal (busca el lugar y después el viejo, con harness_dir): ahí
  // la carpeta de la base es la que resuelve esa misma regla en esta máquina (segunda vuelta, M8)
  const carpetaBase = litBase ? path.join(os.homedir(), litBase[1])
    : (/harness_dir\(\)/.test(leer(path.join(dirBase, 'scripts', 'hooks', 'git-pre-commit-global.sh'))) ? require('../setup/harness/place.js').resolvePlace({ home: os.homedir() }).dir : null);
  item('valores', 'carpeta del arnés que ven los scripts (literal de la base vs el lugar del arnés, o su nombre viejo)',
    real(carpetaBase) || `${carpetaBase} (no existe en esta máquina)`, require('../setup/harness/place.js').resolvePlace({ home: homeEnlace }).dir,
    { nota: `literal de la base: ${carpetaBase}` });

  // organización de Azure DevOps: los literales de los 4 archivos del censo vs ado.org del perfil
  const orgsBase = new Set();
  for (const f of ARCHIVOS_ORG) {
    const t = leer(path.join(dirBase, enLaBase(dirBase, f)));
    for (const m of t.matchAll(/https?:\/\/(?:[^@\s"'`]+@)?dev\.azure\.com\/([A-Za-z0-9_-]+)/g)) orgsBase.add(`https://dev.azure.com/${m[1]}`);
    for (const m of t.matchAll(/([a-z0-9_-]+)\.visualstudio\.com/gi)) orgsBase.add(`https://dev.azure.com/${m[1].toLowerCase()}`);
  }
  const cfg = correr(process.execPath, [path.join(RAIZ, 'scripts', 'lib', 'tycon-config.js'), 'explain', '--json']);
  let conf = null;
  try { conf = JSON.parse(cfg.stdout); } catch (_) { conf = null; }
  const orgNueva = conf ? conf.valores.ado.org : `configuración ilegible (rc ${cfg.rc})`;
  item('valores', `organización de Azure DevOps (literales en ${ARCHIVOS_ORG.length} archivos de la base vs ado.org con el perfil)`, [...orgsBase].sort(), [orgNueva].filter(Boolean),
    { nota: conf ? `origen: ${conf.origenes['ado.org']}` : cfg.out.slice(0, 200) });

  // chat de Telegram: el literal de la base vs telegram.chat_id resuelto
  const chatLit = leer(path.join(dirBase, chatFileIn(dirBase))).match(/TYCON_INSTINCT_TELEGRAM_CHAT_ID \|\| '(\d+)'/);
  // 🔒 el chat NUNCA se escribe en el informe (se commitea; revisor de seguridad, tanda B): se compara el valor y se
  // imprime «presente» / «otro» / «ninguno»
  const chatB = chatLit ? chatLit[1] : null, chatN = conf ? conf.valores.telegram.chat_id : null;
  const [chatViejo, chatNuevo] = chatEnmascarado(chatB, chatN);
  item('valores', 'chat de Telegram del observador de instintos (literal de la base vs telegram.chat_id resuelto)', chatViejo, chatNuevo,
    { nota: conf ? `origen: ${conf.origenes['telegram.chat_id']}` : '' });

  // 4. integraciones (tanda B): el estado de cada una en la base y en el nuevo, por sondas mecánicas — no una tabla
  const codexBase = process.env.TYCON_CODEX === '1' ? 'prendida' : process.env.TYCON_CODEX === '0' ? 'apagada' : 'detect';
  const porPresencia = (nombres, re) => (nombres.some((h) => re.test(h)) ? 'prendida' : 'apagada');
  if (!conf) FALLOS.push('tycon-config.js explain --json: ilegible — los estados de integración no se pudieron medir');
  const integ = conf ? compararIntegraciones({
    hooksBase: hBase.nombres, hooksNuevo: hNuevo.nombres, conf,
    orgBase: [...orgsBase].sort(), chatBase: chatLit ? chatLit[1] : null,
    llaveBase: fs.existsSync(path.join(dirBase, 'scripts', 'metrics', 'corridas-buzon.json')),
    codexBase, codegraphBase: porPresencia(hBase.nombres, /codegraph/i), codegraphNuevo: porPresencia(hNuevo.nombres, /codegraph/i),
  }) : [];
  for (const i of integ) item('integraciones', `estado de la integración «${i.llave}»`, i.viejo, i.nuevo, { nota: i.nota });

  // 5. el informe
  const difs = items.filter((i) => i.igual === false);
  const pendientes = items.filter((i) => i.pendiente);
  const veredicto = FALLOS.length ? `❌ NO MEDIDO: ${FALLOS.length} proceso(s) no llegaron a correr — ${FALLOS.join(' · ')}`
    : difs.length ? `❌ ${difs.length} diferencia(s)` : `✅ equivalente (${items.length - pendientes.length} ítems iguales${pendientes.length ? ` · ${pendientes.length} pendientes` : ''})`;
  const fmt = (v) => (Array.isArray(v) ? (v.length > 6 ? `${v.length} hooks` : v.join(' · ')) : String(v));
  const L = [];
  L.push('# Medición 8.3 — el equipo, con su perfil, tiene lo mismo que tenía (AC 11)');
  L.push('');
  L.push(`- fecha: ${new Date().toISOString()} · máquina: ${os.hostname()} · usuario: ${os.userInfo().username}`);
  L.push(`- línea base: \`main\` al sha \`${shaBase}\` (extraído con \`git archive\`, nada escrito a mano) · nuevo: \`${shaNuevo}\` en \`${RAIZ}\``);
  L.push(`- checkout real medido: \`${clonReal}\` · agent-skills: \`${skills}\``);
  L.push(`- instaladores con \`--check\` en HOMEs temporales (agent-skills enlazado, \`TYCON_CODEX=0\`, \`TYCON_NO_*\`); hooks comparados por nombre`);
  L.push(`- **veredicto: ${veredicto}**`);
  L.push('');
  L.push('| grupo | ítem | base (main) | nuevo | ¿igual? | nota |');
  L.push('|---|---|---|---|---|---|');
  for (const i of items) L.push(`| ${i.grupo} | ${i.nombre} | ${fmt(i.viejo)} | ${fmt(i.nuevo)} | ${i.pendiente ? 'pendiente (tanda B)' : i.igual ? '✅' : '❌'} | ${(i.nota || '').replace(/\|/g, '/').replace(/\n/g, ' ')} |`);
  L.push('');
  L.push('## Hooks (por nombre)');
  L.push('');
  L.push(`- base: ${hBase.nombres.length} · nuevo: ${hNuevo.nombres.length}${faltan.length ? `\n- faltan en el nuevo: ${faltan.join(', ')}` : ''}${sobran.length ? `\n- sobran en el nuevo: ${sobran.join(', ')}` : ''}`);
  L.push('');
  for (const h of hNuevo.nombres) L.push(`- ${h}`);
  L.push('');
  L.push('Generado por `scripts/publishing/profile-equivalence.js`. Las dos piezas manuales por dev (el `@import` de `~/.claude/CLAUDE.md` y el hook de `git pull` de `settings.json`) no entran: no las escribe el instalador.');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, L.join('\n') + '\n');
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify({ shaBase, shaNuevo, veredicto, items }, null, 2) + '\n');
  else {
    for (const i of items) console.log(`${i.pendiente ? '⏳' : i.igual ? '✅' : '❌'} ${i.grupo}: ${i.nombre}${i.igual === false ? ` — base ${fmt(i.viejo)} · nuevo ${fmt(i.nuevo)}` : ''}`);
    console.log(`\n${veredicto} — informe: ${out}`);
  }
  fs.rmSync(dirBase, { recursive: true, force: true });
  return (difs.length || FALLOS.length) ? 1 : 0;
}

// 🔴 `process.exitCode`, NO `process.exit()`: en Node las escrituras a una tubería son
// ASINCRÓNICAS y `process.exit()` mata el proceso con parte de lo escrito en el aire. Medido con
// la forma de este guión (una escritura grande y salir): a 41 KB llega cortado en 8192 y el JSON
// se rompe; el consumidor lo lee como «no pude», nunca como un error.
// Caso: guides/maintaining/incident-log.md#informe-cortado-por-la-tuberia-2026-09-28
if (require.main === module) {
  // story 8.9: las opciones viejas en castellano siguen andando hasta el retiro
  require('../lib/legacy-names.js').aliasArgv('scripts/publishing/profile-equivalence.js', { exitCode: 2 });
  process.exitCode = main();
}
module.exports = { main, parsearHooks, conNombresNuevos, compararHooks, procedenciaDe, SIN_EFECTOS, HOOKS_DE_INTEGRACION, estadoPorHooks, compararIntegraciones, chatEnmascarado, chatFileIn };

// ── story 8.13 (AC 14): `--settings <antes.json> <despues.json>` — dos settings.json, por los hooks del arnés ──────
// Modo aparte del `--base`: no extrae ninguna línea base ni corre instaladores; mira dos archivos ya escritos (la
// copia de la noche anterior y el de la mañana, T16) y dice si los hooks DEL ARNÉS son los mismos por nombre y valor.
// Nada de lo de arriba cambia por esto: `parsearHooks`/`compararHooks` leen el reporte `--check` de un instalador,
// no un settings.json, y comparan sólo nombres; acá hace falta el valor (comando + async), así que son funciones nuevas.

// (funciones, no `const` de módulo: el bloque CLI de arriba llama a `main()` antes de que esta cola se evalúe)
/** Un hook es «del arnés» si su comando nombra los hooks del clon, una skill de agent-skills o el lugar del arnés (por
 *  cualquiera de sus dos nombres, como segmento de ruta: story 8.19). */
// Un clon del arnés puede vivir en cualquier carpeta y el aplicador escribe su ruta REAL: además de los nombres de
// siempre, cuenta como del arnés un `<carpeta>/scripts/hooks/<archivo>` cuya carpeta es un clon del arnés (tiene
// `scripts/install-tycon-hooks.sh`). Antes sólo se reconocía el nombre literal y un clon en otra carpeta quedaba entero
// afuera, con veredicto verde (pase adversarial de la tanda A, clases 5 y 28).
// (la regex va adentro de la función, como las de al lado: el bloque CLI corre `main()` antes de que se evalúe la cola
// del archivo, y una `const` de acá abajo todavía no existiría)
function isHarnessClone(dir) { try { return Boolean(dir) && fs.existsSync(path.join(dir, 'scripts', 'install-tycon-hooks.sh')); } catch (_) { return false; } }
function isHarnessHook(cmd) {
  const P = require('../setup/harness/place.js');
  const names = `(?:${P.PLACE_NAME}|${P.LEGACY_PLACE_NAME})`;
  if (new RegExp(`(?:^|[\\s"'/\\\\])${names}[/\\\\]scripts[/\\\\]hooks[/\\\\]|agent-skills/skills/|\\.claude[/\\\\]${names}(?![\\w.-])`).test(cmd)) return true;
  const m = /([^\s"']*)\/scripts\/hooks\/[\w.-]+/.exec(cmd);
  return Boolean(m && isHarnessClone(m[1].replace(/^~(?=\/)/, os.homedir()).replace(/^\$HOME(?=\/)/, os.homedir())));
}
/** La línea de arranque: la vieja (`git pull` o `git -C <repo> pull` sobre los clones) o la nueva (la copia fija). */
function isStartupLine(cmd) { return /\bgit\s+(?:-C\s+\S+\s+)?pull\b|\.tycon-pipeline\/harness\/bootstrap\.js/.test(cmd); }
/**
 * El nombre del script que corre un hook, con lo que lo distingue: la ruta DENTRO de agent-skills (`clocki/scripts/
 * on-prompt.js` y `tycon-pipeline/scripts/on-prompt.js` son dos hooks distintos: con el nombre suelto la comparación
 * dependía del orden — pase adversarial, clases 3, 6 y 13) o `hooks/<archivo>` para los del arnés.
 */
function scriptName(command) {
  const s = /agent-skills\/skills\/([\w./-]+\.(?:js|sh|ps1|py|command))\b/.exec(command);
  if (s) return s[1];
  const h = /\/scripts\/hooks\/([\w.-]+\.(?:js|sh|ps1|py|command))\b/.exec(command);
  if (h) return `hooks/${h[1]}`;
  const m = /([\w.-]+\.(?:js|sh|ps1|py|command))\b/.exec(command);
  return m ? m[1] : null;
}
/**
 * Los hooks del arnés de un settings.json ya parseado, por `evento · matcher · nombre` → `{ event, matcher, name,
 * command, async }`, y aparte las líneas de arranque (`startup`). Lo ajeno no entra; el orden no importa (es un mapa).
 * Un mismo nombre bajo el mismo evento y matcher dos veces (raro, pero posible) lleva ` #2`, ` #3`… para no perderse.
 */
function hooksDeSettings(settings) {
  const hooks = {};
  const startup = [];
  const porEvento = (settings && settings.hooks && typeof settings.hooks === 'object') ? settings.hooks : {};
  for (const [event, entradas] of Object.entries(porEvento)) {
    if (!Array.isArray(entradas)) continue;
    for (const entrada of entradas) {
      const matcher = entrada && typeof entrada.matcher === 'string' && entrada.matcher ? entrada.matcher : '*';
      for (const h of (entrada && Array.isArray(entrada.hooks)) ? entrada.hooks : []) {
        const command = h && typeof h.command === 'string' ? h.command : '';
        const cmd = command.replace(/\\/g, '/');   // Windows escribe con barras invertidas: se mira igual
        if (event === 'SessionStart' && isStartupLine(cmd)) { startup.push({ command, async: h.async === true }); continue; }
        if (!isHarnessHook(cmd)) continue;
        const name = scriptName(cmd) || command;
        let key = `${event} · ${matcher} · ${name}`;
        for (let n = 2; Object.prototype.hasOwnProperty.call(hooks, key); n++) key = `${event} · ${matcher} · ${name} #${n}`;
        hooks[key] = { event, matcher, name, command, async: h.async === true };
      }
    }
  }
  return { hooks, startup };
}
/** Las diferencias entre dos resultados de `hooksDeSettings`: `[{ key, event, matcher, name, kind, before, after }]`
 *  con `kind` ∈ `missing` (falta en después) · `extra` (sobra en después) · `command` · `async`. La línea de arranque
 *  NO entra acá: va aparte (`startupDiff`). */
function compareSettingsHooks(before, after) {
  const diffs = [];
  const keys = new Set([...Object.keys(before.hooks), ...Object.keys(after.hooks)]);
  for (const key of [...keys].sort()) {
    const a = before.hooks[key], b = after.hooks[key];
    const base = a || b;
    const fila = (kind, x, y) => diffs.push({ key, event: base.event, matcher: base.matcher, name: base.name, kind, before: x, after: y });
    if (a && !b) { fila('missing', a.command, null); continue; }
    if (!a && b) { fila('extra', null, b.command); continue; }
    if (a.command !== b.command) fila('command', a.command, b.command);
    if (a.async !== b.async) fila('async', a.async, b.async);
  }
  return diffs;
}
/** La línea de arranque, aparte: `{ same, before: [cmd…], after: [cmd…] }` (se informa, no decide). */
function startupDiff(before, after) {
  const texto = (l) => l.map((s) => `${s.command}${s.async ? '' : ' [async: false]'}`).sort();
  const b = texto(before.startup), a = texto(after.startup);
  return { same: JSON.stringify(b) === JSON.stringify(a), before: b, after: a };
}
function readSettings(ruta) {
  let texto;
  try { texto = fs.readFileSync(ruta, 'utf8'); } catch (e) { return { error: `no se pudo leer ${ruta} (${e.code || e.message})` }; }
  try { const d = JSON.parse(texto.replace(/^﻿/, '')); return d && typeof d === 'object' ? { datos: d } : { error: `${ruta}: no es un objeto JSON` }; }
  catch (e) { return { error: `${ruta}: JSON ilegible (${e.message})` }; }
}
/** El comando `--settings`: 0 iguales · 1 con la lista · 2 si no se pudo leer. Imprime por stdout; nada en disco. */
function settingsMode(argv) {
  const i = argv.indexOf('--settings');
  const antes = argv[i + 1], despues = argv[i + 2];
  if (!antes || !despues || /^--/.test(antes) || /^--/.test(despues)) { console.error('uso: profile-equivalence.js --settings <antes.json> <despues.json>'); return 2; }
  const la = readSettings(antes), ld = readSettings(despues);
  if (la.error || ld.error) { console.error(`❌ NO MEDIDO: ${[la.error, ld.error].filter(Boolean).join(' · ')}`); return 2; }
  const before = hooksDeSettings(la.datos), after = hooksDeSettings(ld.datos);
  const diffs = compareSettingsHooks(before, after);
  const su = startupDiff(before, after);
  const L = [];
  L.push(`hooks del arnés: antes ${Object.keys(before.hooks).length} (${antes}) · después ${Object.keys(after.hooks).length} (${despues}) — por evento, matcher, nombre y valor; lo ajeno no cuenta`);
  const corto = (s) => (s === null || s === undefined ? '—' : String(s).length > 160 ? `${String(s).slice(0, 157)}…` : String(s));
  for (const d of diffs) {
    const donde = `${d.event} (${d.matcher}) · ${d.name}`;
    if (d.kind === 'missing') L.push(`❌ ${donde} · falta en después: «${corto(d.before)}»`);
    else if (d.kind === 'extra') L.push(`❌ ${donde} · sobra en después: «${corto(d.after)}»`);
    else if (d.kind === 'command') L.push(`❌ ${donde} · cambió el comando: «${corto(d.before)}» → «${corto(d.after)}»`);
    else L.push(`❌ ${donde} · cambió async: ${d.before} → ${d.after}`);
  }
  L.push(diffs.length ? `❌ ${diffs.length} diferencia(s) en los hooks del arnés` : '✅ los hooks del arnés son los mismos por nombre y valor');
  if (su.same) L.push(`startup-line: igual (${su.before.length ? corto(su.before.join(' | ')) : 'ninguna en los dos'})`);
  else L.push(`startup-line: distinta — antes «${corto(su.before.join(' | ')) || 'ninguna'}» · después «${corto(su.after.join(' | ')) || 'ninguna'}» (se informa; no cuenta para el veredicto)`);
  process.stdout.write(L.join('\n') + '\n');
  return diffs.length ? 1 : 0;
}
Object.assign(module.exports, { hooksDeSettings, compareSettingsHooks, startupDiff, settingsMode, isHarnessHook });
