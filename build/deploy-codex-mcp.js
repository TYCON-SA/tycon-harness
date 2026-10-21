#!/usr/bin/env node
/**
 * build/deploy-codex-mcp.js — registra los servidores MCP del arnés en ~/.codex/config.toml
 * Lo invoca install-tycon-hooks.sh dentro del bloque TYCON_CODEX=1.
 *
 * Por qué TRADUCE en vez de copiar un fragmento estático: los comandos de los MCP son
 * ESPECÍFICOS de cada máquina (paths absolutos de node, ubicación del server de Clockify) —
 * la fuente única real es el registro de Claude de ESA máquina (~/.claude.json) más la tabla
 * canónica de equivalences.json (engram/codebase_memory, cuyas etiquetas replican las de
 * Claude para que el nombre de la tool salga byte-igual).
 *
 * POLÍTICA DE SECRETOS: un env cuyo nombre matchea
 * /KEY|TOKEN|PAT|SECRET/ NUNCA se copia al TOML — el server lo hereda del ambiente del
 * proceso de codex. Si el ambiente no lo tiene, este script lo dice A GRITOS con la
 * instrucción exacta (export a ~/.zshrc) y sigue (fail-open: el resto de los servers quedan).
 * Hoy la key de Clockify viaja EN CLARO dentro de ~/.claude.json — esto no la duplica.
 *
 * Splicing quirúrgico del TOML por SECCIONES: solo se tocan las tablas [mcp_servers.<label>]
 * de las etiquetas PROPIAS; cualquier server que el dev haya registrado a mano queda intacto.
 * Backup una vez (config.toml.bak-tycon-mcp) · atomic write · idempotente · --dry-run.
 *
 * SIN CLAUDE CODE. Qué servidores ESPERA el arnés sale de su configuración (las
 * integraciones prendidas: engram, codegraph, clockify) y de la tabla de equivalences.json; `~/.claude.json` es sólo de
 * donde se toma la definición de los que son de cada máquina (clockify, spokenly), SI EXISTE. Sin ese archivo este
 * guion callaría: un dev que sólo usa Codex quedaría sin Clockify y sin una palabra. Por eso un servidor esperado que no se
 * puede registrar SE DICE, con su motivo (`missingServers`). Y `writable_roots` lleva el estado vigente y además
 * `~/.tycon/state` (la casa propia del arnés: donde vive el estado de una máquina sin Claude Code), para que el pipeline bajo Codex pueda escribir su marcador en cualquiera de las dos.
 *
 * Uso: node deploy-codex-mcp.js [--dry-run] [--selftest]
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// La carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: los
// laboratorios copian carpetas sueltas de scripts/ sin scripts/setup/; ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'scripts', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
// las carpetas del estado que el sandbox de Codex tiene que poder escribir: la vigente y la de la casa propia
const stateDirsOf = (() => { const lib = path.join(__dirname, '..', 'scripts', 'setup', 'harness', 'tycon-home.js'); const m = require('fs').existsSync(lib) ? require(lib) : null; return m && typeof m.stateDirs === 'function' ? m.stateDirs : (h) => [stateDirOf(h)]; })();
// la carpeta vieja del estado; sin la pieza (una copia suelta), la de siempre: la misma que da `stateDirOf`
const legacyStateDirOf = (() => { const lib = path.join(__dirname, '..', 'scripts', 'setup', 'harness', 'tycon-home.js'); const m = require('fs').existsSync(lib) ? require(lib) : null; return m && typeof m.legacyStateDir === 'function' ? m.legacyStateDir : stateDirOf; })();
const TCG = path.resolve(__dirname, '..');
// Con borde: el token tiene que ser un SEGMENTO del nombre (inicio/fin o entre _/-), no un
// substring — /PAT/ a secas clasificaría PATH y DATA_PATH como secretos: la variable se dropearía
// del TOML y se le gritaría al dev que exporte algo que nunca fue secreto.
const SECRET_RE = /(^|[_-])(KEY|TOKEN|PAT|SECRET)([_-]|$)/i;
const OWN_LABELS = ['plugin_engram_engram', 'codebase_memory', 'clockify', 'spokenly', 'codegraph'];
// los que se definen EN CADA MÁQUINA (salen de ~/.claude.json): si el despliegue no los resolvió y la tabla ya está en
// config.toml (la persona la escribió a mano, como manda el aviso), se queda — si se borrara en cada despliegue, el
// aviso se repetiría para siempre
const MACHINE_LABELS = ['clockify', 'spokenly'];

function tomlStr(s) { return JSON.stringify(String(s)); }

/** server → texto TOML de su tabla [mcp_servers.<label>] */
function serverToml(label, cfg) {
  const lines = [`[mcp_servers.${label}]`];
  if (cfg.url) {
    lines.push(`url = ${tomlStr(cfg.url)}`);
  } else {
    lines.push(`command = ${tomlStr(cfg.command)}`);
    lines.push(`args = [${(cfg.args || []).map(tomlStr).join(', ')}]`);
  }
  if (cfg.approval) lines.push(`default_tools_approval_mode = ${tomlStr(cfg.approval)}`);
  const env = cfg.env || {};
  const keep = Object.entries(env).filter(([k]) => !SECRET_RE.test(k));
  if (keep.length) {
    lines.push(`[mcp_servers.${label}.env]`);
    for (const [k, v] of keep) lines.push(`${k} = ${tomlStr(v)}`);
  }
  return lines.join('\n') + '\n';
}

/** los servers a registrar en ESTA máquina + los secretos que el ambiente debe proveer */
function resolveServers(claudeCfg, eq) {
  const out = {};
  const missingEnv = [];
  // canónicos de equivalences (etiquetas = las de Claude; engram viene por plugin y no está
  // en mcpServers de ~/.claude.json — su forma suelta vive en la tabla)
  for (const label of ['plugin_engram_engram', 'codebase_memory']) {
    const e = eq.mcp_servers && eq.mcp_servers[label];
    if (e && e.command) out[label] = { command: e.command, args: e.args || [], approval: e.approval_mode || 'approve' };
  }
  // traducidos del registro de Claude de la máquina
  const srv = (claudeCfg && claudeCfg.mcpServers) || {};
  if (srv.clockify && srv.clockify.command) {
    out.clockify = { command: srv.clockify.command, args: srv.clockify.args || [], approval: 'approve', env: srv.clockify.env || {} };
    for (const k of Object.keys(srv.clockify.env || {}))
      if (SECRET_RE.test(k) && !process.env[k]) missingEnv.push([k, 'clockify', '~/.claude.json → mcpServers.clockify.env']);
  }
  if (srv.spokenly && srv.spokenly.url) out.spokenly = { url: srv.spokenly.url };
  // codegraph: global por convención — el server resuelve el índice por cwd.
  // --mcp es OBLIGATORIO (sin el flag no habla stdio). Para probarlo: (a) codex DIFIERE las
  // tools MCP tras su tool search (ToolSearchAlwaysDeferMcpTools) — una prueba que pregunta
  // "¿tenés mcp__X__*?" mide el listado inicial y da NO aunque el server esté sano; la prueba
  // correcta ORDENA llamar la tool. (b) el protocolo MCP anterior NO es problema: codex
  // lo inicializa igual, no hace falta un shim de protocolo.
  // 🔴 PIN: codegraph se queda en 0.7.9 — la versión 1.5.0 expone 1 sola tool contra 9 (rediseño
  // breaking que rompería el lado Claude entero).
  const probe = process.platform === 'win32' ? 'where codegraph' : 'command -v codegraph';
  try { require('child_process').execSync(probe, { stdio: 'ignore', shell: true }); out.codegraph = { command: 'codegraph', args: ['serve', '--mcp'], approval: 'approve' }; } catch (_) { /* sin codegraph en esta máquina */ }
  return { servers: out, missingEnv };
}

/** ¿`name` está en el PATH? (sin shell) */
function inPath(name, env = process.env) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) for (const x of exts) {
    try { fs.accessSync(path.join(d, name + x), fs.constants.X_OK); return true; } catch (_) { /* siguiente */ }
  }
  return false;
}

/**
 * Los servidores que el arnés ESPERA y no puede registrar (AC 23): una línea por cada uno, con el motivo. Puro.
 * @param {{integrations:object|null, servers:object, claudeJson:'missing'|'present', has:(bin:string)=>boolean, target:string}} p
 *   `integrations` = lo que dice la configuración del arnés (`null`: no se pudo leer → no se afirma nada).
 */
function missingServers({ integrations, servers, claudeJson, has, target, registered = () => false }) {
  const out = [];
  if (!integrations) return out;
  const cant = (label, key, why, fix) => out.push(`⚠ tycon/codex: el servidor MCP «${label}» está prendido (integrations.${key}) y no lo puedo registrar en Codex: ${why} — ${fix}`);
  // ya registrado a mano en config.toml (lo que el propio aviso manda a hacer): no hay nada que avisar
  if (integrations.clockify && !servers.clockify && !registered('clockify')) {
    cant('clockify', 'clockify', claudeJson === 'missing'
      ? 'su definición es de cada máquina y sale de ~/.claude.json, que no existe en ésta'
      : 'su definición es de cada máquina y ~/.claude.json no lo trae (mcpServers.clockify)',
    `registralo a mano en ${target} ([mcp_servers.clockify], con su command y sus args), o apagá la integración`);
  }
  if (integrations.codegraph && !servers.codegraph) cant('codegraph', 'codegraph', 'el ejecutable `codegraph` no está en el PATH', 'instalalo (guides/integrations/codegraph-mcp.md) o apagá la integración');
  const eng = servers.plugin_engram_engram;
  if (integrations.engram && !eng) cant('plugin_engram_engram', 'engram', 'build/equivalences.json no lo define', 'revisá esa tabla');
  else if (integrations.engram && eng && eng.command && !path.isAbsolute(eng.command) && !has(eng.command)) {
    out.push(`⚠ tycon/codex: el servidor MCP «plugin_engram_engram» quedó registrado, pero su ejecutable \`${eng.command}\` no está en el PATH: bajo Codex va a fallar hasta instalarlo (guides/integrations/engram-workflow.md)`);
  }
  return out;
}

/** Las integraciones según la configuración del arnés, o null si no se pudo leer (no se lee como «todo apagado»). */
function readIntegrations() {
  try {
    const C = require(path.join(TCG, 'scripts', 'lib', 'tycon-config.js'));
    const read = () => C.integraciones(C.leer());
    return typeof C.sinAnotar === 'function' ? C.sinAnotar(read) : read();
  } catch (_) { return null; }
}

/** splicing por secciones: reemplaza SOLO las tablas de etiquetas propias, preserva el resto */
function spliceToml(existing, servers) {
  const lines = String(existing || '').split('\n');
  const isHeader = (l) => /^\s*\[/.test(l);
  const ownHeader = (l) => {
    const m = l.match(/^\s*\[mcp_servers\.("?)([A-Za-z0-9_-]+)\1(\.env)?\]\s*$/);
    // una tabla propia se reemplaza; la de un servidor de la máquina que este despliegue NO resolvió se deja como está
    return Boolean(m && OWN_LABELS.includes(m[2]) && (Object.prototype.hasOwnProperty.call(servers, m[2]) || !MACHINE_LABELS.includes(m[2])));
  };
  const kept = [];
  let skipping = false;
  for (const l of lines) {
    if (isHeader(l)) skipping = ownHeader(l);
    if (!skipping) kept.push(l);
  }
  let outText = kept.join('\n');
  // asegurar la sección padre [mcp_servers] (codex la acepta vacía; si no está, se agrega)
  if (!/^\s*\[mcp_servers\]\s*$/m.test(outText)) outText = outText.replace(/\s*$/, '\n\n[mcp_servers]\n');
  const block = Object.entries(servers).map(([label, cfg]) => serverToml(label, cfg)).join('\n');
  // el bloque propio va INMEDIATAMENTE después de la sección padre, antes de la próxima tabla ajena
  outText = outText.replace(/^(\s*\[mcp_servers\]\s*)$/m, (m0) => `${m0}\n\n${block.trimEnd()}\n`);
  return outText.replace(/\n{3,}/g, '\n\n');
}

/**
 * `[sandbox_workspace_write] writable_roots` con el directorio de estado del arnés. Sin esa
 * ruta el pipeline bajo Codex no puede escribir su marker.
 *
 * 🔴 Endurecida contra tres maneras de romperse: (a) un detector que exija el header en forma
 * canónica exacta deja que un `[sandbox_workspace_write] # comentario` o la forma inline
 * `sandbox_workspace_write = {...}` (TOML válido) caigan al append y DUPLIQUEN la tabla —
 * config.toml entero ilegible para codex, con el deploy imprimiendo "DESPLEGADO"; (b) una
 * idempotencia por substring sobre TODO el archivo haría creer el trabajo hecho para siempre si
 * la ruta se menciona en un comentario o en un arg de server; (c) sin cobertura en el selftest.
 * Por eso: header tolerante a
 * comentario, forma inline detectada y NO tocada (se avisa; editar un inline-table a ciegas es
 * cómo se corrompe un TOML), idempotencia por el predicado SCOPED de abajo, un solo paso, y
 * casos en el selftest — incluido el que reproduce la duplicación.
 */
const SANDBOX_HDR_RE = /^\s*\[sandbox_workspace_write\]\s*(?:#.*)?$/;
const SANDBOX_INLINE_RE = /^(\s*sandbox_workspace_write\s*=\s*\{.*writable_roots\s*=\s*\[)([^\]]*)(\].*)$/;

/**
 * 🔴 Codex rechaza TODOS los comandos de shell si una raíz de escritura pasa por un enlace
 * (medido con codex-cli 0.154 y 0.162: «writable root … contains symlink component …; symlinked writable roots are not supported»).
 * No avisa al arrancar: la sesión abre, y cada comando falla. Pasa en una máquina mudada a `~/.tycon`: la mudanza
 * deja la carpeta vieja del estado como enlace al estado nuevo, y esa ruta —puesta acá antes de la mudanza— seguiría en
 * `writable_roots` al lado de la real si este guion sólo agregara raíces y nunca sacara ninguna.
 *
 * `linkComponent(p)`: el primer tramo de la ruta que es un enlace (o una unión de Windows), o null. Los enlaces del
 * sistema de macOS (`/tmp`, `/var`, `/etc` → `/private/…`) no cuentan: Codex acepta una raíz bajo `/tmp` (medido). Se mira tramo por tramo con lstat —como lo dice Codex— y no comparando contra realpath, que en Windows
 * también cambia los nombres cortos y las mayúsculas. Una ruta que no existe no tiene enlaces. Nunca tira.
 */
const SYSTEM_LINKS = process.platform === 'darwin' ? new Set(['/tmp', '/var', '/etc']) : new Set();
function linkComponent(p) {
  if (!path.isAbsolute(String(p))) return null;   // una ruta de otro sistema o relativa: no hay disco que mirar
  const abs = path.resolve(String(p));
  const root = path.parse(abs).root;
  let cur = root;
  for (const part of abs.slice(root.length).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    if (SYSTEM_LINKS.has(cur)) continue;
    try { if (fs.lstatSync(cur).isSymbolicLink()) return cur; } catch (_) { return null; }
  }
  return null;
}
/** La ruta real: la del tramo que existe, más lo que falte (una carpeta que todavía no existe no tiene realpath). */
function realOf(p) {
  const abs = path.resolve(String(p));
  const rest = [];
  for (let cur = abs; ;) {
    try { return path.join(fs.realpathSync(cur), ...rest); } catch (_) { /* sube un tramo */ }
    const up = path.dirname(cur);
    if (up === cur) return abs;
    rest.unshift(path.basename(cur)); cur = up;
  }
}
/** Una raíz del arnés como Codex la acepta: tal cual si no pasa por un enlace; si pasa (una HOME detrás de un enlace), la real. */
const cleanRoot = (p) => (linkComponent(p) ? realOf(p) : p);
const samePath = (a, b) => (process.platform === 'darwin' || process.platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);

function markerRoot() { return cleanRoot(path.join(stateDirOf(os.homedir()))); }
/** Todas las raíces que tienen que estar: el estado vigente y `~/.tycon/state` (sin repetir). La primera es `markerRoot()`. */
function markerRoots() { return [...new Set([markerRoot(), ...stateDirsOf(os.homedir()).map(cleanRoot)])]; }
/** La carpeta donde el estado vivió siempre (la da tycon-home.js): tras la mudanza queda como enlace, y es del arnés. */
function legacyRoot() { return legacyStateDirOf(os.homedir()); }

/**
 * Localiza el ARRAY de writable_roots dentro de la sección (o la forma inline) y lo devuelve
 * PARSEADO en elementos, con las coordenadas para reescribirlo. Es la única lectura del array
 * en este archivo y en el audit de paridad — una versión que lo lea por
 * líneas se rompe de tres maneras: el array multilínea (formato que el propio codex emite)
 * es invisible → rojo eterno tras seguir la instrucción "agregá a mano"; una coma final
 * (TOML válido) produce doble coma → config ilegible imprimiendo DESPLEGADO; y el substring
 * acepta `.tycon-pipeline-old` como si fuera la ruta. Parsear elementos mata las tres.
 *
 * Devuelve null si no hay array reconocible. Formas: sección con array en una línea, sección
 * con array multilínea, inline table de una línea.
 */
/** Un renglón sin su comentario (`#` fuera de comillas): en un array multilínea, el comentario no es un elemento. */
function stripComment(line) {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) { if (ch === '\\' && quote === '"') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') return line.slice(0, i);
  }
  return line;
}
function findWritableRoots(lines) {
  for (let i = 0; i < lines.length; i++) {
    const inl = lines[i].match(SANDBOX_INLINE_RE);
    if (inl) return { kind: 'inline', start: i, end: i, pre: inl[1], raw: inl[2], post: inl[3], elems: parseElems(inl[2]) };
    if (!SANDBOX_HDR_RE.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length && !/^\s*\[/.test(lines[j]); j++) {
      const m = lines[j].match(/^(\s*writable_roots\s*=\s*\[)(.*)$/);
      if (!m) continue;
      const cierre = m[2].indexOf(']');
      if (cierre >= 0) {
        return { kind: 'linea', start: j, end: j, pre: m[1], raw: m[2].slice(0, cierre), post: m[2].slice(cierre), elems: parseElems(m[2].slice(0, cierre)) };
      }
      let raw = stripComment(m[2]);
      for (let k = j + 1; k < lines.length; k++) {
        const c = lines[k].indexOf(']');
        if (c >= 0) return { kind: 'multi', start: j, end: k, pre: m[1], raw, post: lines[k].slice(c), elems: parseElems(raw + ',' + lines[k].slice(0, c)) };
        raw += ',' + stripComment(lines[k]);
      }
      return null; // array sin cerrar: TOML ya roto — no lo empeoramos
    }
    return { kind: 'seccion-sin-clave', start: i, end: i, elems: [] };
  }
  return null;
}

/**
 * Los elementos del array, cada uno como la RUTA que dice.
 *
 * 🔴 Un texto básico de TOML (comillas dobles) lleva sus barras invertidas ESCAPADAS. Si se le sacaran sólo las
 * comillas, una ruta de Windows quedaría con las barras dobles, nunca sería igual a la ruta buscada y cada despliegue
 * la agregaría OTRA vez —y al re-emitir el array volvería a escapar las que ya estaban, rompiéndolas—. Uno literal
 * (comillas simples) va tal cual.
 */
function parseElems(raw) {
  return String(raw).split(',').map((e) => e.trim()).filter((e) => e !== '').map((e) => {
    if (/^".*"$/.test(e)) { try { return JSON.parse(e); } catch (_) { return e.slice(1, -1); } }
    return e.replace(/^'|'$/g, '');
  }).filter((e) => e !== '');
}

/**
 * ¿La ruta es un ELEMENTO del writable_roots vigente? Elemento exacto — un subdirectorio o un
 * hermano `.tycon-pipeline-old` no cuentan: el sandbox de codex da permiso por subtree listado,
 * y "parecido" es exactamente el verde falso sobre marker roto. Compartido con el audit.
 */
function writableRootsHas(toml, root) {
  const found = findWritableRoots(String(toml || '').split('\n'));
  return Boolean(found && found.elems && found.elems.includes(root));
}

/** Los elementos de `writable_roots` como están escritos (vacío si no hay array reconocible). Compartido con el audit. */
function writableRootsList(toml) {
  const found = findWritableRoots(String(toml || '').split('\n'));
  return found && found.elems ? [...found.elems] : [];
}
/**
 * Las raíces escritas que pasan por un enlace: `[{ root, component, own }]`. `own`: es del arnés —la carpeta vieja del
 * estado, o un alias (por enlace) de una de las raíces que este guion pone—, y entonces este guion la saca; una ajena
 * (del dev) no se toca: se dice, acá y en el audit de paridad, que la marca en rojo.
 */
function linkedRoots(toml, roots = markerRoots(), legacy = legacyRoot()) {
  const mine = roots.map(realOf);
  return writableRootsList(toml).map((root) => ({ root, component: linkComponent(root) })).filter((x) => x.component)
    .map((x) => Object.assign(x, { own: samePath(path.resolve(x.root), path.resolve(legacy)) || mine.some((m) => samePath(realOf(x.root), m)) }));
}

function ensureWritableRoots(toml, roots = markerRoots(), { legacy = legacyRoot(), log = null } = {}) {
  let t = String(toml || '');
  for (const root of roots) t = ensureWritableRoot(t, root);
  // …y saca las del arnés que pasan por un enlace (la carpeta vieja tras la mudanza): con una sola, Codex no corre nada
  for (const x of linkedRoots(t, roots, legacy)) {
    if (x.own) { const next = dropWritableRoot(t, x.root); if (next !== t && log) log(`deploy-codex-mcp: saqué ${x.root} de writable_roots — pasa por un enlace (${x.component}) y con una raíz así Codex rechaza todos los comandos de shell; queda la ruta real`); t = next; }
    else if (log) log(`⚠ deploy-codex-mcp: writable_roots trae ${x.root}, que pasa por un enlace (${x.component}) y no es del arnés: Codex rechaza todos los comandos de shell con una raíz así — cambiala por su ruta real o sacala de config.toml`);
  }
  return t;
}

/** Saca UN elemento del array, en la forma en que esté escrito (una línea, inline o multilínea), sin tocar el resto. */
function dropWritableRoot(toml, root) {
  const t = String(toml || '');
  const lines = t.split('\n');
  const found = findWritableRoots(lines);
  if (!found || !found.elems || !found.elems.includes(root)) return t;
  const emit = (elems) => elems.map((e) => JSON.stringify(e)).join(', ');
  if (found.kind === 'inline' || found.kind === 'linea') {
    lines[found.start] = `${found.pre}${emit(found.elems.filter((e) => e !== root))}${found.post}`;
    return lines.join('\n');
  }
  // multi: línea por línea, conservando sangría, comentarios y la coma final de cada una
  for (let k = found.end; k >= found.start; k--) {
    const line = lines[k];
    const head = k === found.start ? found.pre : (line.match(/^\s*/) || [''])[0];
    let body = line.slice(head.length), tail = '';
    if (k === found.end) { const c = body.indexOf(']'); tail = body.slice(c); body = body.slice(0, c); }
    const elemsText = stripComment(body);
    const comment = body.slice(elemsText.length);
    const elems = parseElems(elemsText);
    if (!elems.includes(root)) continue;
    const left = elems.filter((e) => e !== root);
    // un renglón del medio que queda sin elementos se va entero, con su comentario (hablaba de ese elemento)
    if (k !== found.start && k !== found.end && !left.length) { lines.splice(k, 1); continue; }
    const comma = left.length && elemsText.trimEnd().endsWith(',') ? ',' : '';
    lines[k] = `${head}${emit(left)}${comma}${left.length && comment ? `   ${comment}` : ''}${tail}`.replace(/[ \t]+$/, '');
  }
  return lines.join('\n');
}

function ensureWritableRoot(toml, root) {
  const t = String(toml || '');
  const rootStr = JSON.stringify(root);
  const lines = t.split('\n');
  const found = findWritableRoots(lines);
  if (found && found.elems && found.elems.includes(root)) return t;

  if (!found) {
    // Si existe CUALQUIER forma de sandbox_workspace_write que no supimos parsear (inline sin
    // el array en la misma línea, dotted keys), appendear una tabla nueva DUPLICARÍA la
    // definición — TOML inválido, config entero muerto. Se avisa y no se toca.
    if (lines.some((l) => /^\s*sandbox_workspace_write\s*[=.]/.test(l))) {
      console.log(`⚠ deploy-codex-mcp: config.toml define sandbox_workspace_write en una forma que no edito a ciegas — agregá a mano ${rootStr} a writable_roots (el audit de paridad lo sigue marcando hasta entonces).`);
      return t;
    }
    return t.replace(/\s*$/, `\n\n[sandbox_workspace_write]\nwritable_roots = [${rootStr}]\n`);
  }
  if (found.kind === 'seccion-sin-clave') {
    lines.splice(found.start + 1, 0, `writable_roots = [${rootStr}]`);
    return lines.join('\n');
  }
  if (found.kind === 'inline' || found.kind === 'linea') {
    // El array se RE-EMITE desde los elementos parseados + la ruta: reescribir sobre el texto
    // crudo duplicaría la coma final.
    const nuevos = [...found.elems, root].map((e) => JSON.stringify(e)).join(', ');
    lines[found.start] = `${found.pre}${nuevos}${found.post}`;
    return lines.join('\n');
  }
  // multi: la ruta entra como elemento propio antes del cierre, respetando el formato del dev. Si el último elemento no
  // lleva coma final (TOML lo permite), hay que ponérsela: sin eso el archivo queda inválido
  for (let k = found.end - 1; k > found.start; k--) {
    const body = lines[k].replace(/#.*$/, '').trimEnd();
    if (!body) continue;
    if (!body.endsWith(',') && !body.endsWith('[')) lines[k] = lines[k].replace(/(\s*#.*)?$/, (m0, c) => `,${c || ''}`);
    break;
  }
  const indent = (lines[found.start].match(/^\s*/) || [''])[0] + '  ';
  lines.splice(found.end, 0, `${indent}${rootStr},`);
  return lines.join('\n');
}

/**
 * ¿`[mcp_servers.<label>]` está registrado? Anclado por línea (una línea comentada no
 * registra nada) y tolerante a la forma con comillas. Compartido con el audit de paridad —
 * un `includes()` en el auditor daría verde con el header comentado.
 */
function serverRegistered(toml, label) {
  const re = new RegExp(`^\\s*\\[mcp_servers\\.("?)${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1(\\.env)?\\]\\s*(?:#.*)?$`, 'm');
  return re.test(String(toml || ''));
}

function selftest() {
  const eq = { mcp_servers: { plugin_engram_engram: { command: 'engram', args: ['mcp', '--tools=agent'], approval_mode: 'approve' }, codebase_memory: { command: 'codebase-memory-mcp', args: [], approval_mode: 'approve' } } };
  const claude = { mcpServers: { clockify: { command: '/opt/x/node', args: ['/opt/x/srv.js'], env: { CLOCKIFY_API_KEY: 'sekreto123' } }, spokenly: { type: 'http', url: 'http://localhost:51089' } } };
  const { servers, missingEnv } = resolveServers(claude, eq);
  const toml = Object.entries(servers).map(([l, c]) => serverToml(l, c)).join('\n');
  const existing = '# config del dev\nmodel = "gpt-5.6-terra"\n\n[mcp_servers]\n\n[mcp_servers.mi_server_propio]\ncommand = "propio"\nargs = []\n\n[mcp_servers.clockify]\ncommand = "viejo"\nargs = []\n\n[projects."/x"]\ntrust_level = "trusted"\n';
  const merged = spliceToml(existing, servers);
  const merged2 = spliceToml(merged, servers);
  const checks = [
    ['el secreto NO viaja al TOML', !toml.includes('sekreto123') && !merged.includes('sekreto123')],
    ['la key faltante en ambiente se reporta', missingEnv.some(([k]) => k === 'CLOCKIFY_API_KEY') || !!process.env.CLOCKIFY_API_KEY],
    ['etiquetas canónicas presentes (nombre de tool byte-igual)', merged.includes('[mcp_servers.plugin_engram_engram]') && merged.includes('[mcp_servers.codebase_memory]')],
    ['spokenly HTTP con url', merged.includes('url = "http://localhost:51089"')],
    ['el server PROPIO del dev queda intacto', merged.includes('mi_server_propio')],
    ['el clockify viejo se reemplaza (no se acumula)', !merged.includes('"viejo"')],
    ['la config ajena (model, projects) queda', merged.includes('model = "gpt-5.6-terra"') && merged.includes('[projects."/x"]')],
    ['idempotente', merged2 === merged],
  ];
  let bad = 0;
  // ensureWritableRoots — la función que puede corromper el TOML si se ablanda (un header con comentario no debe
  // duplicar la tabla).
  const root = markerRoot();
  const rs = JSON.stringify(root);
  const conComentario = ensureWritableRoots('[sandbox_workspace_write]  # del dev\nwritable_roots = []\n');
  const inline = 'sandbox_workspace_write = { writable_roots = ["/x"] }\n';
  const once = ensureWritableRoots(spliceToml('', {}));
  checks.push(
    ['wr: header con comentario NO duplica la tabla', (conComentario.match(/\[sandbox_workspace_write\]/g) || []).length === 1 && conComentario.includes(rs)],
    ['wr: la forma inline CON array recibe el elemento (re-emitido válido)', (() => {
      const out = ensureWritableRoots(inline);
      return out.split('\n').length === inline.split('\n').length && out.includes(rs) && out.includes('"/x"');
    })()],
    // multilínea cuyo último elemento no lleva coma final → el nuevo entra con
    // la coma que faltaba, y el archivo sigue siendo TOML
    ['wr: multilínea sin coma final recibe el elemento con la coma que faltaba', (() => {
      const out = ensureWritableRoots('[sandbox_workspace_write]\nwritable_roots = [\n  "/a",\n  "/b"\n]\n', ['/c']);
      return out.includes('"/b",') && out.includes('"/c",') && !/,\s*,/.test(out);
    })()],
    ['wr: multilínea sin coma final y con comentario: la coma va antes del comentario', (() => {
      const out = ensureWritableRoots('[sandbox_workspace_write]\nwritable_roots = [\n  "/a",\n  "/b"   # mío\n]\n', ['/c']);
      return out.includes('"/b",   # mío') && out.includes('"/c",');
    })()],
    // clases 3 y 24: la tabla de un servidor de la máquina escrita a mano (lo que manda el aviso) se queda si el despliegue
    // no lo resolvió, y el aviso no se repite
    ['tabla de clockify a mano: spliceToml la deja si no la resolvió, y la reemplaza si sí', (() => {
      const toml = '[mcp_servers]\n\n[mcp_servers.clockify]\ncommand = "mio"\n';
      const kept = spliceToml(toml, { codegraph: { command: 'z' } });
      const replaced = spliceToml(toml, { clockify: { command: 'nuevo' } });
      return kept.includes('command = "mio"') && !replaced.includes('command = "mio"') && replaced.includes('command = "nuevo"');
    })()],
    ['clockify ya registrado a mano: missingServers no avisa', missingServers({ integrations: { clockify: true }, servers: {}, claudeJson: 'missing', has: () => true, target: 't', registered: (l) => l === 'clockify' }).length === 0],
    ['wr: la forma inline SIN array no se toca (duplicar la definición mata el TOML)', (() => {
      const raro = 'sandbox_workspace_write = { network_access = true }\n';
      return ensureWritableRoots(raro) === raro;
    })()],
    ['wr: coma final no produce doble coma', !/,\s*,/.test(ensureWritableRoots('[sandbox_workspace_write]\nwritable_roots = ["/x", ]\n'))],
    ['wr: multilínea se detecta y se edita', (() => {
      const multi = '[sandbox_workspace_write]\nwritable_roots = [\n  "/a",\n]\n';
      const out = ensureWritableRoots(multi);
      return writableRootsHas(out, root) && writableRootsHas(multi, root) === false;
    })()],
    ['wr: un hermano .tycon-pipeline-old NO cuenta como la ruta', writableRootsHas(`[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(root + '-old')}]\n`, root) === false],
    ['wr: idempotente compuesto con spliceToml', ensureWritableRoots(spliceToml(once, {})) === once],
    ['wr: suma a un array existente preservando el comentario', ensureWritableRoots('[sandbox_workspace_write]\nwritable_roots = ["/x"] # roots\n').includes(`writable_roots = ["/x", ${markerRoots().map((r) => JSON.stringify(r)).join(', ')}] # roots`)],
    ['wr: la ruta en un comentario NO satisface la idempotencia', ensureWritableRoots('# ' + root + '\n[mcp_servers]\n').includes('[sandbox_workspace_write]')],
    ['wr: writableRootsHas es scoped (comentario no cuenta)', writableRootsHas('# ' + root + '\n', root) === false],
    // las dos raíces —el estado vigente y la casa propia del arnés—, cada una como elemento propio
    ['wr: con dos raíces entran las dos, una sola tabla, e idempotente', (() => {
      const two = ['/h/estado-de-siempre', '/h/.tycon/state'];
      const out = ensureWritableRoots('model = "x"\n', two);
      return two.every((r) => writableRootsHas(out, r)) && (out.match(/\[sandbox_workspace_write\]/g) || []).length === 1 && ensureWritableRoots(out, two) === out;
    })()],
    ['wr: una ruta de Windows (barras invertidas) no se duplica ni se rompe al re-desplegar', (() => {
      const win = ['C:\\Users\\dev\\casa\\estado', 'C:\\Users\\dev\\.tycon\\state'];
      const once = ensureWritableRoots('model = "x"\n', win);
      const twice = ensureWritableRoots(once, win);
      return twice === once && win.every((r) => writableRootsHas(once, r)) && (once.match(/Users/g) || []).length === 2;
    })()],
    // una raíz que pasa por un enlace deja a Codex sin shell. Con disco de verdad: una carpeta, un enlace a
    // ella (la carpeta vieja del estado tras la mudanza) y un enlace ajeno (del dev)
    ...(() => {
      const lab = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-codex-roots-')));
      const kind = process.platform === 'win32' ? 'junction' : 'dir';
      const real = path.join(lab, 'casa', 'state'); const legacy = path.join(lab, 'vieja'); const other = path.join(lab, 'otra'); const foreign = path.join(lab, 'del-dev');
      const out = [];
      try {
        fs.mkdirSync(real, { recursive: true }); fs.mkdirSync(other);
        fs.symlinkSync(real, legacy, kind); fs.symlinkSync(other, foreign, kind);
        const said = [];
        const opts = { legacy, log: (l) => said.push(l) };
        const line = `[sandbox_workspace_write]\nwritable_roots = [${[legacy, real, foreign].map((e) => JSON.stringify(e)).join(', ')}] # roots\n`;
        const fixed = ensureWritableRoots(line, [real], opts);
        out.push(['wr: enlace: la carpeta vieja del arnés (un enlace al estado) se saca y queda la real', JSON.stringify(writableRootsList(fixed)) === JSON.stringify([real, foreign]) && fixed.includes('# roots')]);
        out.push(['wr: enlace: lo dice, con la raíz y el tramo', said.some((l) => l.includes(`saqué ${legacy}`) && /Codex rechaza todos los comandos/.test(l))]);
        out.push(['wr: enlace: una raíz ajena con enlace NO se toca, y se avisa', writableRootsHas(fixed, foreign) && said.some((l) => l.startsWith('⚠') && l.includes(foreign) && /no es del arnés/.test(l))]);
        out.push(['wr: enlace: idempotente', ensureWritableRoots(fixed, [real], { legacy }) === fixed]);
        out.push(['wr: enlace: linkedRoots nombra cada una y de quién es', JSON.stringify(linkedRoots(line, [real], legacy).map((x) => [x.root, x.component, x.own])) === JSON.stringify([[legacy, legacy, true], [foreign, foreign, false]])]);
        // un alias del estado que no es la carpeta vieja (otro enlace a la misma carpeta) también es del arnés
        const alias = path.join(lab, 'alias'); fs.symlinkSync(real, alias, kind);
        out.push(['wr: enlace: otro enlace a una raíz del arnés también se saca', JSON.stringify(writableRootsList(ensureWritableRoots(`[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(alias)}]\n`, [real], { legacy }))) === JSON.stringify([real])]);
        // un tramo intermedio enlazado: la raíz cuelga de un enlace
        out.push(['wr: enlace: un tramo intermedio enlazado cuenta', linkComponent(path.join(legacy, 'adentro')) === legacy && linkComponent(real) === null && linkComponent(path.join(lab, 'no-existe', 'x')) === null]);
        // las tres formas en que puede estar escrito el array
        const multi = `[sandbox_workspace_write]\nwritable_roots = [\n  ${JSON.stringify(legacy)},   # la vieja\n  ${JSON.stringify(real)},\n  "/x"   # mío\n]\nmodel = "x"\n`;
        const m2 = ensureWritableRoots(multi, [real], { legacy });
        out.push(['wr: enlace: en un array multilínea saca sólo ese elemento y conserva lo demás', JSON.stringify(writableRootsList(m2)) === JSON.stringify([real, '/x']) && m2.includes('"/x"   # mío') && m2.includes('model = "x"') && !/,\s*,/.test(m2) && ensureWritableRoots(m2, [real], { legacy }) === m2]);
        const sameLine = `[sandbox_workspace_write]\nwritable_roots = [\n  ${JSON.stringify(legacy)}, ${JSON.stringify(real)},\n  "/x"\n]\n`;
        out.push(['wr: enlace: multilínea con dos elementos en un renglón', JSON.stringify(writableRootsList(ensureWritableRoots(sameLine, [real], { legacy }))) === JSON.stringify([real, '/x'])]);
        const lastOne = `[sandbox_workspace_write]\nwritable_roots = [\n  ${JSON.stringify(real)},\n  ${JSON.stringify(legacy)}\n]\n`;
        out.push(['wr: enlace: multilínea, el último elemento (sin coma final) se saca y el archivo sigue válido', (() => { const o = ensureWritableRoots(lastOne, [real], { legacy }); return JSON.stringify(writableRootsList(o)) === JSON.stringify([real]) && /\[\n {2}"[^"]+",\n\]/.test(o); })()]);
        const inline = `sandbox_workspace_write = { writable_roots = [${JSON.stringify(legacy)}, ${JSON.stringify(real)}] }\n`;
        out.push(['wr: enlace: en la forma inline también', JSON.stringify(writableRootsList(ensureWritableRoots(inline, [real], { legacy }))) === JSON.stringify([real])]);
        // una raíz del arnés que cuelga de un enlace se escribe por su ruta real (una HOME detrás de un enlace)
        out.push(['wr: enlace: cleanRoot da la ruta real de una raíz enlazada y deja igual la que no', cleanRoot(path.join(legacy, 'x')) === path.join(real, 'x') && cleanRoot(real) === real]);
        // los enlaces del sistema de macOS no cuentan (Codex acepta una raíz bajo /tmp)
        out.push(['wr: enlace: /tmp y /var de macOS no cuentan como enlace', process.platform !== 'darwin' || (linkComponent('/tmp/x') === null && linkComponent(os.tmpdir()) === null)]);
        out.push(['wr: enlace: una ruta de otro sistema (o relativa) no se mira en el disco', linkComponent('C:\\Users\\dev\\x') === null || process.platform === 'win32']);
      } catch (e) { out.push([`wr: enlace: el laboratorio no se pudo armar (${e && e.message})`, false]); }
      finally { try { fs.rmSync(lab, { recursive: true, force: true }); } catch (_) { /* queda en el temporal */ } }
      return out;
    })(),
    ['wr: markerRoots trae el estado vigente primero y la casa propia, sin repetir', markerRoots()[0] === root && new Set(markerRoots()).size === markerRoots().length && markerRoots().some((r) => /[\\/]\.tycon[\\/]state$/.test(r) || process.env.TYCON_HOME)],
    // AC 23: un servidor esperado que no se puede registrar se dice, con su motivo; uno apagado o registrado, no
    ['faltante: clockify prendido y sin ~/.claude.json → se dice', (() => {
      const m = missingServers({ integrations: { clockify: true }, servers: {}, claudeJson: 'missing', has: () => true, target: '/c/config.toml' });
      return m.length === 1 && /clockify/.test(m[0]) && /no lo puedo registrar/.test(m[0]) && /no existe/.test(m[0]);
    })()],
    ['faltante: clockify prendido, con ~/.claude.json que no lo trae → se dice con ese motivo', /no lo trae/.test(missingServers({ integrations: { clockify: true }, servers: {}, claudeJson: 'present', has: () => true, target: 't' })[0] || '')],
    ['faltante: apagado, o registrado, o sin poder leer la configuración → no se afirma nada', missingServers({ integrations: { clockify: false }, servers: {}, claudeJson: 'missing', has: () => true, target: 't' }).length === 0
      && missingServers({ integrations: { clockify: true }, servers: { clockify: { command: 'x' } }, claudeJson: 'present', has: () => true, target: 't' }).length === 0
      && missingServers({ integrations: null, servers: {}, claudeJson: 'missing', has: () => false, target: 't' }).length === 0],
    ['faltante: engram registrado sin su ejecutable en el PATH → se dice (y no dice «no lo puedo registrar»)', (() => {
      const m = missingServers({ integrations: { engram: true }, servers: { plugin_engram_engram: { command: 'engram' } }, claudeJson: 'missing', has: () => false, target: 't' });
      return m.length === 1 && /engram/.test(m[0]) && /no está en el PATH/.test(m[0]);
    })()],
  );
  for (const [name, ok] of checks) { console.log(`${ok ? '✅' : '❌'} selftest-mcp-deploy: ${name}`); if (!ok) bad++; }
  console.log(bad ? `❌ ${bad} rojos` : `✅ selftest-mcp-deploy: ${checks.length}/${checks.length} verdes`);
  return bad ? 1 : 0;
}

function main() {
  if (process.argv.includes('--selftest')) return selftest();
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const target = path.join(codexHome, 'config.toml');
  // el registro de Claude Code de la máquina es OPCIONAL (AC 23): una máquina sin Claude Code no lo tiene
  let claudeCfg = {};
  let claudeJson = 'missing';
  try { claudeCfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')); claudeJson = 'present'; } catch (e) { if (e && e.code !== 'ENOENT') claudeJson = 'present'; }
  const eq = JSON.parse(fs.readFileSync(path.join(TCG, 'build', 'equivalences.json'), 'utf8'));
  const { servers, missingEnv } = resolveServers(claudeCfg, eq);
  // un servidor que el arnés espera y no se puede registrar se dice
  for (const line of missingServers({ integrations: readIntegrations(), servers, claudeJson, has: (b) => inPath(b), target, registered: (label) => serverRegistered(fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '', label) })) console.log(line);
  for (const [k, srv, dónde] of missingEnv)
    console.log(`🛑 tycon: el server MCP "${srv}" necesita ${k} en el AMBIENTE y no está — agregá \`export ${k}=<valor>\` a ~/.zshrc (el valor actual vive en ${dónde}). Sin eso, ese server va a fallar bajo codex. El secreto NO se copia a ningún archivo.`);
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  // lo que se saca se dice DESPUÉS de escribir (en un ensayo, como lo que haría); el aviso de una raíz ajena, siempre
  const notes = [];
  const next = ensureWritableRoots(spliceToml(current, servers), markerRoots(), { log: (l) => notes.push(l) });
  const warn = notes.filter((l) => l.startsWith('⚠'));
  const done = notes.filter((l) => !l.startsWith('⚠'));
  for (const l of warn) console.log(l);
  if (next === current) { console.log('deploy-codex-mcp: sin cambios'); return 0; }
  if (process.argv.includes('--dry-run')) {
    for (const l of done) console.log(`(dry-run, sin escribir) ${l}`);
    console.log(`deploy-codex-mcp: CAMBIARÍA (dry-run) — servers: ${Object.keys(servers).join(', ')}`);
    return 0;
  }
  fs.mkdirSync(codexHome, { recursive: true });
  const bak = target + '.bak-tycon-mcp';
  if (current && !fs.existsSync(bak)) fs.writeFileSync(bak, current);
  const tmp = target + '.tmp-tycon';
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, target);
  for (const l of done) console.log(l);
  console.log(`deploy-codex-mcp: DESPLEGADO → ${target} (servers: ${Object.keys(servers).join(', ')})`);
  return 0;
}

module.exports = { OWN_LABELS, resolveServers, serverToml, spliceToml, ensureWritableRoots, writableRootsHas, writableRootsList, linkedRoots, linkComponent, dropWritableRoot, markerRoot, markerRoots, legacyRoot, missingServers, serverRegistered };
if (require.main === module) process.exit(main());
