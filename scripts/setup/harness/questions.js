'use strict';
/**
 * questions.js — lo que `install` pregunta en una primera instalación (story 8.16, tanda D · AC 30 a 33).
 *
 * El dueño decidió «que elija al instalar»: el perfil no tiene valor por defecto, y las integraciones y el paquete del
 * stack, que antes se prendían editando `~/.claude/tycon.json` a mano, se contestan con una pregunta. Acá vive lo que no
 * depende de la máquina —el texto de cada pregunta, cómo se lee una respuesta, cómo se validan las opciones que las
 * contestan (`--integrations`, `--packs`) y cómo se dicen los valores con su origen—; quién pregunta y cuándo lo decide
 * `harness.js` (`installQuestions`):
 *
 *   · el perfil: dos opciones, cada una con dos renglones de lo que trae, contados desde la lista de efectos; SIN valor
 *     por defecto (Enter vuelve a preguntar); acepta 1, 2, minimal o full; a la tercera respuesta vacía o inválida, o con
 *     fin de entrada, no hay perfil y no se escribe nada;
 *   · las integraciones: sólo las que la lista de efectos ofrece (`integrations[].offered`), ninguna marcada; Enter es
 *     «ninguna»; nombres separados por coma; un nombre que no se ofrece vuelve a preguntar;
 *   · el paquete del stack: un sí o no (`packs.default` en `all` o `none`).
 *
 * Con `--defaults` (lo que pasa `npx`) `harness.js` no pregunta ninguna: lo que nadie fijó queda en su valor por defecto,
 * y el plan es el corto de `shortPlan`, contado desde la lista de efectos.
 *
 * Las mismas preguntas en cualquier sistema: nada de esto mira la plataforma (T52). La lectura y la escritura se
 * inyectan (las da `prompt.js`), así se prueba sin una terminal de verdad. No lee ni escribe archivos.
 */

// el lugar del arnés (story 8.19): su nombre sale de place.js
const path = require('path');
const PLACE = require('./place.js');
const PROFILES = Object.freeze(['minimal', 'full']);
// los opt-in que nacen prendidos: cuentan en lo que trae un perfil (los demás, no: nacen apagados)
const BORN_ON = Object.freeze(['optin:TYCON_SAFETY_GUARD', 'optin:TYCON_TEST_SCOPE_GUARD']);
const PROFILE_WHAT = Object.freeze({
  minimal: 'las guías, las skills, los revisores y el pipeline como skill',
  full: 'todo lo de minimal y los frenos de los repos que trabajan con el arnés',
});
const ASK_PROFILE = 'Elegí 1, 2, minimal o full: ';
const ASK_INTEGRATIONS = 'Nombres separados por coma, o Enter: ';
const MAX_TRIES = 3;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Lo que trae un perfil, contado desde la lista de efectos (sin las integraciones ni lo que nace apagado). */
function profileCounts(effects, profile) {
  const inP = (e) => e && Array.isArray(e.profiles) && e.profiles.includes(profile);
  const always = (e) => e.when === 'always';
  const list = (Array.isArray(effects) ? effects : []).filter(inP);
  const hooks = list.filter((e) => e.kind === 'hook' && (always(e) || BORN_ON.includes(e.when)));
  return {
    hooks: hooks.length,
    brakes: hooks.filter((e) => e.blocks && e.blocks !== 'no').length,
    blocks: list.filter((e) => e.kind === 'block' && always(e)).length,
    settings: list.filter((e) => e.kind === 'setting').length,
    gitHooks: list.filter((e) => e.kind === 'git-hook' && always(e)).length,
    tasks: list.filter((e) => e.kind === 'task' && always(e)).length,
  };
}

/** Los dos renglones de cada perfil (cuatro líneas en total), con el número de la opción. */
function profileLines(effects) {
  const L = [];
  PROFILES.forEach((p, i) => {
    const c = profileCounts(effects, p);
    L.push(`  ${i + 1}) ${p}: ${plural(c.hooks, 'hook', 'hooks')} (${c.brakes} ${c.brakes === 1 ? 'puede' : 'pueden'} frenar un comando); ${PROFILE_WHAT[p]}`);
    const second = [
      c.blocks ? `${plural(c.blocks, 'bloque de reglas', 'bloques de reglas')} que cambian cómo contesta el asistente en todos tus proyectos` : 'no cambia cómo contesta el asistente',
      c.settings ? plural(c.settings, 'ajuste de Claude Code', 'ajustes de Claude Code') : 'sin ajustes de Claude Code',
      c.gitHooks ? 'hooks globales de git' : 'sin hooks de git',
      `${plural(c.tasks, 'tarea que corre sola', 'tareas que corren solas')}`,
    ];
    L.push(`     ${second.join(' · ')}`);
  });
  return L;
}

/** El perfil de una respuesta (`1`, `2`, `minimal`, `full`, con mayúsculas o espacios), o null. */
function parseProfile(answer) {
  const a = String(answer == null ? '' : answer).trim().toLowerCase();
  if (a === '1') return 'minimal';
  if (a === '2') return 'full';
  return PROFILES.includes(a) ? a : null;
}

/**
 * Pregunta el perfil. `read()` devuelve `{ text, eof }`. Sin valor por defecto: vacío vuelve a preguntar; a la tercera
 * respuesta vacía o inválida, o con fin de entrada, `{ value: null }`.
 */
function askProfile({ effects, read, write }) {
  write(`¿Qué perfil instalo? Elegí uno: no hay uno por defecto.\n${profileLines(effects).join('\n')}\n`);
  for (let i = 0; i < MAX_TRIES; i++) {
    write(ASK_PROFILE);
    const r = read();
    if (r.eof) { write('\n'); return { value: null, eof: true }; }
    const v = parseProfile(r.text);
    if (v) return { value: v };
    const said = String(r.text || '').trim();
    if (said) write(`«${said}» no es una opción (1, 2, minimal o full)\n`);
  }
  return { value: null };
}

/** Las ofrecidas de la lista de efectos: `[{ key, does, needs }]`, en su orden. */
function offeredIntegrations(list) {
  return (Array.isArray(list) ? list : []).filter((x) => x && x.offered === true && typeof x.key === 'string');
}

/** `{ ok: true, names }` o `{ ok: false, bad }`: nombres separados por coma, sólo de `keys`; vacío, `none` o `ninguna` es []. */
function parseIntegrations(text, keys) {
  const a = String(text == null ? '' : text).trim().toLowerCase();
  if (!a || a === 'none' || a === 'ninguna') return { ok: true, names: [] };
  const names = [...new Set(a.split(',').map((s) => s.trim()).filter(Boolean))];
  const bad = names.find((n) => !keys.includes(n));
  return bad ? { ok: false, bad } : { ok: true, names };
}

/**
 * Pregunta qué integraciones prender, de las `offered` (las que la lista ofrece y nadie fijó todavía). Ninguna marcada:
 * Enter es «ninguna». Un nombre que no se ofrece vuelve a preguntar; a la tercera, `{ names: null }`. Fin de entrada es
 * «ninguna», como cualquier respuesta que no es un sí (AC 2), y se avisa con `eof` para no seguir leyendo.
 */
function askIntegrations({ offered, read, write }) {
  const keys = offered.map((x) => x.key);
  write(`¿Qué integraciones prendo? Ninguna viene marcada; Enter es «ninguna».\n${offered.map((x) => `  - ${x.key}: ${x.does}. Pide: ${x.needs}`).join('\n')}\n`);
  for (let i = 0; i < MAX_TRIES; i++) {
    write(ASK_INTEGRATIONS);
    const r = read();
    if (r.eof) { write('\n'); return { names: [], eof: true }; }
    const p = parseIntegrations(r.text, keys);
    if (p.ok) return { names: p.names };
    write(`«${p.bad}» no es una de las que se ofrecen (${keys.join(', ')})\n`);
  }
  return { names: null };
}

/** La pregunta de los paquetes (un sí o no): qué activa la organización. Un repo sólo puede achicar esa lista, no sumar. */
const PACKS_QUESTION = '¿Usás el paquete del stack en todos tus repos (sus skills y sus revisores)? Lo que actives acá vale para todos; un repo puede achicar la lista con `packs: [bizuit]` en su .tycon/advisors.yaml, no sumar. Para elegir algunos paquetes: --packs <a,b>. [s/N] ';

/** `--integrations <lista|none>`: `{ names }` o `{ error }` nombrando las válidas. */
function checkIntegrationsOption(value, keys) {
  if (value === undefined || value === null) return null;
  const p = parseIntegrations(value, keys);
  if (String(value).trim() === '') return { error: `--integrations necesita una lista: válidas ${keys.join(', ')}, o none` };
  if (!p.ok) return { error: `--integrations: «${p.bad}» no es una de las que se ofrecen; válidas: ${keys.join(', ')}, o none` };
  return { names: p.names };
}

/** `--packs <all|none|a,b>`: `{ value }` (`all`, `none` o la lista) o `{ error }`. La regla es la del lector. */
function checkPacksOption(value, installed = null) {
  if (value === undefined || value === null) return null;
  const p = require('../../lib/tycon-config.js').paquetesDeTexto(value);
  if (p.motivo) return { error: `--packs ${p.motivo}` };
  // una lista nombra paquetes de la versión que se instala (`installed`): uno que no trae es un error de tipeo, no un pedido
  const missing = Array.isArray(p.valor) && Array.isArray(installed) ? p.valor.filter((n) => !installed.includes(n)) : [];
  if (missing.length) return { error: `--packs ${String(value).trim()}: ${missing.map((n) => `«${n}»`).join(', ')} no es un paquete de esta versión (trae: ${installed.join(', ') || 'ninguno'}); tiene que ser all, none o una lista de ellos` };
  return { value: p.valor };
}
/** El valor de `packs.default` en una línea (`all`, `none` o `a,b`), como se escribe en `--packs`. */
const packsText = (v) => (Array.isArray(v) ? v.join(',') : String(v));
/** ¿Dos valores de `packs.default` dicen lo mismo? Una lista es un conjunto: el orden no cambia qué se activa. */
const samePacks = (a, b) => (Array.isArray(a) && Array.isArray(b)
  ? a.length === b.length && a.every((n) => b.includes(n))
  : packsText(a) === packsText(b));

/** La línea que `install` deja cuando no preguntó las integraciones (decisión del dueño, 2026-10-05): cómo cambiar el perfil
 *  y las integraciones después. Una sola línea. */
const CHANGE_HINT = `para cambiar el perfil o las integraciones: node ~/.claude/${PLACE.PLACE_NAME}/scripts/setup/harness.js install --profile minimal|full --integrations <lista|none> --packs all|none|<a,b> (o tycon-config.js set <clave> <valor>)`;

/** Cómo se dice el origen de un valor de la configuración, para una persona. */
/**
 * El origen de un valor, para una persona. `machineFile` es el archivo de la máquina COMO SE LE DICE (story 8.23, tanda
 * G · AC 44 c): `~/.tycon/config.json` donde la máquina vive ahí, el de siempre donde no; sin él, el nombre genérico.
 */
function originLabel(origin, variable, machineFile = null) {
  return ({
    env: variable || 'una variable', maquina: machineFile || 'el archivo de la máquina', perfil: 'perfil', default: 'de fábrica',
    apagado: 'apagada', 'sin-valor': 'sin valor', 'archivo-llave': 'por su llave', plugin: 'por el plugin',
  })[origin] || origin;
}
/** El archivo de la máquina de una configuración cargada, con `~` por la carpeta de la persona (lo que se imprime). */
function machineFileOf(config) {
  const f = config && config.archivos && config.archivos.maquina && config.archivos.maquina.ruta;
  if (!f) return null;
  const home = (config && config.home) || require('os').homedir();
  return f.startsWith(home + path.sep) ? `~/${f.slice(home.length + 1).split(path.sep).join('/')}` : f;
}

/** Lo que hay prendido y el paquete por defecto, cada uno con de dónde vino (lo que dicen configLines y shortPlan). */
function configState(config, over = {}, order = []) {
  const v = (config && config.valores) || {};
  const o = (config && config.origenes) || {};
  const vars = (config && config.variables) || {};
  const machineFile = machineFileOf(config);
  const on = [];
  const off = [];
  for (const k of order) {
    const ruta = k === 'ado' ? 'ado.org' : (k === 'telegram' ? 'telegram.chat_id' : `integraciones.${k}`);
    const val = over[ruta] ? over[ruta].value : (k === 'ado' ? (v.ado || {}).org : (k === 'telegram' ? (v.telegram || {}).chat_id : (v.integraciones || {})[k]));
    const via = over[ruta] ? over[ruta].via : originLabel(o[ruta], vars[ruta], machineFile);
    if (val === 'detect') on.push({ key: k, text: `${k} en detect (${via})` });
    else if (val === true || (typeof val === 'string' && val.trim())) on.push({ key: k, text: `${k} (${via})` });
    else off.push(k);
  }
  const packs = over['packs.default'] ? over['packs.default'] : { value: (v.packs || {}).default || 'none', via: originLabel(o['packs.default'], vars['packs.default'], machineFile) };
  return { on, off, packs };
}

/**
 * Las dos líneas de la configuración que acompañan al perfil en la cabecera del plan y en el cierre: las integraciones
 * prendidas con su origen (y las apagadas por nombre) y el paquete del stack por defecto con el suyo. `config` es lo
 * que devuelve `cargar()` de scripts/lib/tycon-config.js; `over` lo que se va a escribir, con de dónde vino
 * (`{ 'integraciones.engram': { value: true, via: 'respuesta' } }`).
 */
function configLines(config, over = {}, order = []) {
  const { on, off, packs } = configState(config, over, order);
  return [
    `integraciones: ${on.length ? on.map((x) => x.text).join(', ') : 'ninguna prendida'}${off.length ? ` · apagadas: ${off.join(', ')}` : ''}`,
    `paquete del stack por defecto: ${packsText(packs.value)} (${packs.via})`,
  ];
}

const SHORT_WHAT = Object.freeze({
  minimal: 'las guías, las skills, los revisores y el recorrido de una historia (plan, pruebas, revisión y commit preparado)',
  full: 'todo lo de la mínima y los frenos de los repos que trabajan con el arnés',
});

/** Una carpeta como se le dice a una persona: con `~` por su carpeta personal. */
function homeRelative(dir, home) {
  if (!home || !dir) return dir;
  return dir === home ? '~' : (dir.startsWith(home + path.sep) ? `~/${dir.slice(home.length + 1).split(path.sep).join('/')}` : dir);
}

/**
 * El plan corto de la instalación con valores por defecto: cinco renglones, en este orden —qué versión, dónde y para
 * qué herramienta; qué instalación y qué trae; qué toca y qué no; las conexiones opcionales y los revisores para tu
 * tecnología; cómo cambiarlo, sacarlo y ver el detalle—. Lo que toca se cuenta desde la lista de efectos: si la
 * instalación trae bloques de reglas o hooks globales de git, el renglón lo dice en vez de negarlo. Los bloques de un
 * paquete cuentan sólo con un paquete activo (sin paquete, no se escribe ninguno).
 * `tools`: las herramientas a enchufar (`claude`, `codex`); `integrations`: los nombres prendidos; `packs`: el valor de
 * `packs.default`.
 */
function shortPlan({ effects, profile, version, tree, home = null, tools = [], team = null, integrations = [], packs = 'none' }) {
  const inP = (e) => e && Array.isArray(e.profiles) && e.profiles.includes(profile);
  const list = (Array.isArray(effects) ? effects : []).filter(inP);
  const always = (e) => e.when === 'always';
  const noPacks = packsText(packs) === 'none';
  const blocks = list.filter((e) => e.kind === 'block' && always(e) && !(noPacks && /packs/.test(String(e.id_pattern || e.id || '')))).length;
  const gitHooks = list.some((e) => e.kind === 'git-hook' && always(e));
  const settings = list.filter((e) => e.kind === 'setting').length;
  const reads = list.some((e) => e.kind === 'import');
  const adds = [
    blocks ? `${plural(blocks, 'bloque de reglas', 'bloques de reglas')} que cambian cómo te contesta tu agente en todos tus proyectos` : null,
    gitHooks ? 'hooks globales de git' : null,
    settings ? plural(settings, 'ajuste de Claude Code', 'ajustes de Claude Code') : null,
  ].filter(Boolean);
  const keeps = [gitHooks ? null : 'git', blocks ? null : 'las reglas de cómo te contesta'].filter(Boolean);
  const touch = [reads ? 'tu agente lee el índice de guías del arnés en cada sesión' : null,
    adds.length ? `suma ${adds.length > 1 ? `${adds.slice(0, -1).join(', ')} y ${adds[adds.length - 1]}` : adds[0]}` : null,
    keeps.length ? `no toca ${keeps.join(' ni ')}` : null].filter(Boolean).join('; ');
  const label = { claude: 'Claude Code', codex: 'Codex' };
  const where = homeRelative(tree, home);
  const packsSay = noPacks ? 'ninguno' : (packsText(packs) === 'all' ? 'todos los instalados (all)' : packsText(packs));
  return [
    `Instalo el arnés ${version} en ${where}, para ${tools.map((t) => label[t] || t).join(' y ') || 'ninguna herramienta'}${team ? `, con el repo del equipo ${team}` : ''}.`,
    `Instalación ${profile === 'full' ? 'completa' : 'mínima'}: ${SHORT_WHAT[profile] || SHORT_WHAT.minimal}.`,
    `${touch.charAt(0).toUpperCase()}${touch.slice(1)}.`,
    `Conexiones opcionales: ${integrations.length ? integrations.join(', ') : 'ninguna'} · revisores para tu tecnología: ${packsSay}.`,
    `Para cambiarlo, harness.js config; para sacarlo, harness.js uninstall (los dos en ${where}/scripts/setup); el detalle completo, con --dry-run.`,
  ];
}

/**
 * La oferta de la instalación completa al cerrar la primera historia: tres renglones —qué suma la
 * completa, dónde rige, cómo se vuelve atrás—, contados desde la lista de efectos como la diferencia entre la completa y
 * la mínima. Si la completa no trae hooks de git ni bloques de reglas, los renglones no los nombran. La orden para volver
 * es la que se corre tal cual: en Windows, con la ruta entera (PowerShell no expande `~` en el argumento de un programa).
 */
function upgradeOffer({ effects, tree, home = null, platform = process.platform }) {
  const full = profileCounts(effects, 'full');
  const min = profileCounts(effects, 'minimal');
  const brakes = Math.max(0, full.brakes - min.brakes);
  const hooks = Math.max(0, full.hooks - min.hooks);
  const blocks = Math.max(0, full.blocks - min.blocks);
  const gitHooks = full.gitHooks > min.gitHooks;
  const adds = [
    brakes ? `${plural(brakes, 'freno que puede', 'frenos que pueden')} parar un comando peligroso` : null,
    blocks ? `${plural(blocks, 'bloque de reglas que cambia', 'bloques de reglas que cambian')} cómo te contesta tu agente` : null,
    gitHooks ? 'hooks globales de git' : null,
  ].filter(Boolean);
  const addsText = adds.length > 1 ? `${adds.slice(0, -1).join(', ')} y ${adds[adds.length - 1]}` : (adds[0] || 'lo mismo que la mínima');
  const where = [gitHooks ? 'en todos tus repos' : null, blocks ? 'en todas las sesiones de tu agente de código' : null].filter(Boolean);
  const harnessJs = path.join(tree || '', 'scripts', 'setup', 'harness.js');
  const shown = platform === 'win32' ? `"${harnessJs}"` : homeRelative(harnessJs, home);
  return [
    `Qué cambia: la instalación completa suma ${addsText}${hooks ? ` (${plural(hooks, 'hook', 'hooks')} más en total)` : ''}.`,
    `Dónde: ${where.length ? `rige ${where.join(' y ')}, no sólo en este proyecto` : 'sólo en los repos donde trabajás con el arnés'}.`,
    `Cómo se vuelve atrás: node ${shown} install --profile minimal --yes deja la máquina como está ahora.`,
  ];
}

module.exports = {
  PROFILES, ASK_PROFILE, ASK_INTEGRATIONS, PACKS_QUESTION, MAX_TRIES, CHANGE_HINT,
  profileCounts, profileLines, parseProfile, askProfile, offeredIntegrations, parseIntegrations, askIntegrations,
  checkIntegrationsOption, checkPacksOption, packsText, samePacks, originLabel, configLines, configState, shortPlan,
  upgradeOffer,
};
