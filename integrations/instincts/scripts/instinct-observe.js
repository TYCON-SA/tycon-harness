#!/usr/bin/env node
'use strict';
/**
 * instinct-observe.js — gancho `PostToolUse`: graba una línea saneada por cada herramienta que usa la sesión, para que
 * el que propone instintos encuentre después los patrones que se repiten.
 *
 * Graba en `tycon-observations/<AAAA-MM>.jsonl` de la carpeta de los registros sueltos (scripts/lib/loose-logs.js: la del
 * estado en una máquina que vive en la casa propia del arnés, la de Claude Code en las demás), una línea por herramienta: `ts`, `session_id` (8
 * caracteres), `tool`, `project`, `summary` (lo que la herramienta recibió, saneado), `status`, y además `repo` (la
 * carpeta raíz del repo, relativa a la raíz de repos o al home) y `origin` (el host y la organización del remoto, sin el
 * repo y sin credenciales). Sólo con la integración `instincts` prendida; apagada no escribe nada ni crea la carpeta.
 *
 * Corre en cada herramienta: no lanza procesos (ni git) y no sale nunca con algo distinto de 0. Una falla deja una línea
 * con el motivo en `instinct-observe.errors.log`, al lado de lo grabado, con un tope de 100 KB.
 *
 * Casos: scripts/tests/instinct-observe.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { editEventsFrom } = require('../../../scripts/lib/hook-io.js');

const MAX_SUMMARY = 500;
const MAX_ERRORS_LOG = 100 * 1024;

// ── el saneado ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Las palabras de un secreto (`token=`, `password:`, `AZURE_DEVOPS_EXT_PAT=`, `AWS_SECRET_ACCESS_KEY=`, `AccountKey=` de
// una cadena de conexión…) tapan su valor hasta el próximo blanco o comilla; entre comillas, hasta la comilla que cierra.
// Una palabra pegada al final de un nombre (`accessToken`, `clientSecret`, `_authToken`) también cuenta, y una clave corta
// (desde 4 caracteres) se tapa después de `password`, `passwd` o `secret` con `=` o `:`. Además: las claves con forma propia (`sk-`,
// un token de GitHub, un permiso de Azure DevOps, un JWT, una llave de AWS), la firma de un enlace firmado, las
// credenciales en una URL (`usuario:clave@` hasta la última `@`, y un permiso largo puesto como usuario), `-u` y `--user`
// con `usuario:clave` (también con el usuario vacío), la clave en la opción de sqlcmd, bcp, mysql, `docker login` o `az login`,
// y `Authorization`. Una palabra cuenta también pegada a un escape (`\n`, `\t`) o a un signo codificado (`%20`). Sanear dos
// veces deja lo mismo: un valor ya tapado no se vuelve a tapar. En las formas que no son de siempre, una variable del
// shell (`"$PW"`, `$DB_PASSWORD`) o el comienzo de un objeto (`secret:{…}`) no es una clave y queda como está.
const INICIO = '(?:(?<![A-Za-z0-9])|(?<=\\\\[ntr])|(?<=%[0-9A-Fa-f]{2}))';
const PALABRAS = '(?:api[_-]?key|access[_-]?key|account[_-]?key|shared[_-]?access[_-]?key|key|token|password|passwd|pwd|secret|bearer|pat)';
const FUERTES = '(?:api[_-]?key|access[_-]?key|account[_-]?key|token|password|passwd|secret)';
const NOMBRE = (palabras) => `((?:[A-Za-z0-9]+_)*${palabras}(?:_[A-Za-z0-9]+)*)`;
const NO_TAPADO = '(?!\\[REDACTED)';
const NO_VARIABLE = '(?!\\$[{(A-Za-z_])';
const ENTRE_COMILLAS = `(?:"${NO_TAPADO}${NO_VARIABLE}[^"\\n]{4,}"|'${NO_TAPADO}${NO_VARIABLE}[^'\\n]{4,}')`;
const AUTH_RE = /(authorization)["']?\s*[:=]\s*["']?[^"'\n]+/gi;
const SIG_RE = /([?&]sig=)[^&"'\s]+/gi;
const URL_CRED_RE = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s]*@/gi;
const URL_USER_RE = /(\b[a-z][a-z0-9+.-]*:\/\/)[A-Za-z0-9_]{20,}@/gi;
const DASH_U_RE = /((?:\s-u\s*|\s--user[\s=]+)["']?)[^\s:"']*:[^\s"']+/g;
const VALOR_DE_OPCION = `("${NO_VARIABLE}[^"\\n]*"|'${NO_VARIABLE}[^'\\n]*'|${NO_VARIABLE}[^\\s"']+)`;
const CLAVE_DE_HERRAMIENTA_RES = [
  new RegExp(`(\\b(?:sqlcmd|bcp|osql)\\b[^|;&\\n]*?\\s-P\\s*)${VALOR_DE_OPCION}`, 'g'),
  new RegExp(`(\\b(?:mysql|mysqldump|mysqladmin|mariadb)\\b[^|;&\\n]*?\\s-p)${VALOR_DE_OPCION}`, 'g'),
  new RegExp(`(\\b(?:docker|podman|nerdctl|helm|oras)\\s+(?:registry\\s+)?login\\b[^|;&\\n]*?\\s-p\\s+)${VALOR_DE_OPCION}`, 'g'),
  new RegExp(`(\\baz\\s+login\\b[^|;&\\n]*?\\s-p\\s+)${VALOR_DE_OPCION}`, 'g'),
];
const QUOTED_SECRET_RE = new RegExp(`${INICIO}${NOMBRE(FUERTES)}["']?\\s*[:=]\\s*${ENTRE_COMILLAS}`, 'gi');
const SECRET_RE = new RegExp(`${INICIO}${NOMBRE(PALABRAS)}["':\\s=]+["']?${NO_TAPADO}[^\\s"'&;,]{8,}`, 'gi');
const SHORT_SECRET_RE = new RegExp(`${INICIO}${NOMBRE('(?:password|passwd|secret)')}\\s*[:=]\\s*${NO_TAPADO}(?![{(\\[<$\\\\])[^\\s"'&;,]{4,7}(?=[\\s"'&;,]|$)`, 'gi');
const CAMEL_SECRET_RE = new RegExp(`(?<=[a-z])(Token|Secret|Password|Passwd|Pwd|ApiKey|AccessKey|AccountKey|PrivateKey|SecretKey)(?:["']?\\s*[:=]\\s*${ENTRE_COMILLAS}|["':\\s=]+["']?${NO_TAPADO}${NO_VARIABLE}[^\\s"'&;,]{8,})`, 'g');
const SK_RE = /\b(sk-[A-Za-z0-9_-]{16,})/g;
const GHP_RE = new RegExp(`${INICIO}((?:gh[pousr]_|github_pat_)[A-Za-z0-9_-]{16,})`, 'g');
// los permisos de Azure DevOps: los de 52 letras de base32 y los de 84 con la marca AZDO
const ADO_RE = new RegExp(`${INICIO}(?:[A-Za-z0-9]{76}AZDO[A-Za-z0-9]{4}|[a-z2-7]{52})(?![A-Za-z0-9])`, 'g');
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g;
const AKIA_RE = /\bAKIA[0-9A-Z]{16}\b/g;

function sanitize(s, home) {
  if (!s) return s;
  let out = String(s);
  if (home) out = out.split(home).join('$HOME');
  out = out.replace(AUTH_RE, '$1: [REDACTED]');
  out = out.replace(SIG_RE, '$1[REDACTED]');
  out = out.replace(URL_CRED_RE, '$1[REDACTED]@');
  out = out.replace(URL_USER_RE, '$1[REDACTED]@');
  out = out.replace(DASH_U_RE, '$1[REDACTED]');
  for (const re of CLAVE_DE_HERRAMIENTA_RES) out = out.replace(re, '$1[REDACTED]');
  out = out.replace(QUOTED_SECRET_RE, '$1=[REDACTED]');
  out = out.replace(SECRET_RE, '$1=[REDACTED]');
  out = out.replace(SHORT_SECRET_RE, '$1=[REDACTED]');
  out = out.replace(CAMEL_SECRET_RE, '$1=[REDACTED]');
  out = out.replace(SK_RE, '[REDACTED-SK]');
  out = out.replace(GHP_RE, '[REDACTED-GHP]');
  out = out.replace(ADO_RE, '[REDACTED-ADO]');
  out = out.replace(JWT_RE, '[REDACTED-JWT]');
  out = out.replace(AKIA_RE, '[REDACTED-AKIA]');
  if (out.length > MAX_SUMMARY) out = `${out.slice(0, MAX_SUMMARY - 3)}...`;
  return out;
}

/** Lo que se graba de cada herramienta; de las que no están en la lista (las MCP incluidas), sólo el nombre. */
function summarize(tool, input) {
  const i = input && typeof input === 'object' ? input : {};
  if (tool === 'Read' || tool === 'Edit' || tool === 'Write') return i.file_path || '';
  if (tool === 'Bash' || tool === 'PowerShell') return i.command || '';
  if (tool === 'Grep' || tool === 'Glob') return i.pattern || '';
  if (tool === 'Task' || tool === 'Agent') return i.description || '';
  if (tool === 'Skill') return i.skill || '';
  return null;
}

// ── el repo y su remoto, leídos de .git sin lanzar git ────────────────────────────────────────────────────────────
// las barras repetidas se juntan (salvo al principio, la de una ruta de red): `$TMPDIR` en la Mac termina en `/` y un
// cwd armado con él trae `//`, que si no nunca empieza con la raíz de repos
const toSlash = (p) => String(p).replace(/\\/g, '/').replace(/(?!^)\/{2,}/g, '/');

/** La carpeta del repo que contiene `cwd` y la carpeta `.git` común (la que tiene el `config`). */
function findRepo(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(dotGit); } catch (_) { st = null; }
    if (st && st.isDirectory()) return { root: dir, common: dotGit };
    if (st && st.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
      if (!m) return { root: dir, common: null };
      const gitdir = path.resolve(dir, m[1].trim());
      let common;
      try { common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim()); } catch (_) { common = gitdir; }
      return { root: dir, common };
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** El host y la organización del remoto, en minúsculas; lo que no se reconoce, null. */
function canonOrigin(url) {
  const u = String(url || '').trim();
  let m = /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)/i.exec(u)
    || /^(?:ssh:\/\/)?git@ssh\.dev\.azure\.com:v3\/([^/]+)/i.exec(u)
    || /^(?:ssh:\/\/)?([^@/]+)@vs-ssh\.visualstudio\.com/i.exec(u)
    || /^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\//i.exec(u);
  if (m) return `dev.azure.com/${m[1].toLowerCase()}`;
  m = /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)/i.exec(u) || /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)/i.exec(u);
  if (m) return `github.com/${m[1].toLowerCase()}`;
  return null;
}

/** La URL del remoto `origin` en un `.git/config`, o null. */
function originUrl(configText) {
  const m = /\[remote\s+"origin"\]([\s\S]*?)(?=\n\s*\[|$)/.exec(configText);
  if (!m) return null;
  const u = /^\s*url\s*=\s*(.+)$/m.exec(m[1]);
  return u ? u[1].trim() : null;
}

/** `{ repo, origin }` de la carpeta donde corre la herramienta. */
function repoAndOrigin(cwd, { reposRoot, home }, logError) {
  const found = cwd ? findRepo(cwd) : null;
  if (!found) return { repo: null, origin: null };
  const base = reposRoot && toSlash(found.root).startsWith(`${toSlash(path.resolve(reposRoot))}/`) ? reposRoot : home;
  const rel = base ? toSlash(path.relative(base, found.root)) : null;
  const repo = rel && !rel.startsWith('..') ? rel : toSlash(path.basename(found.root));
  let origin = null;
  if (found.common) {
    try { origin = canonOrigin(originUrl(fs.readFileSync(path.join(found.common, 'config'), 'utf8'))); } catch (e) { logError(`config ilegible (${e.code || e.message})`); }
  }
  return { repo, origin };
}

/** La carpeta de primer nivel bajo la raíz de repos (o bajo una carpeta de primer nivel del home), como siempre. */
function projectOf(cwd, { reposRoot, home }) {
  const c = toSlash(cwd || '');
  if (reposRoot) {
    const r = toSlash(path.resolve(reposRoot));
    const m = c.startsWith(`${r}/`) ? /^([^/]+)/.exec(c.slice(r.length + 1)) : null;
    if (m) return m[1];
  } else if (home) {
    const m = new RegExp(`^${toSlash(home).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^/.][^/]*/([^/]+)`).exec(c);
    if (m) return m[1];
  }
  return path.basename(c) || 'unknown';
}

// ── el registro de fallas ──────────────────────────────────────────────────────────────────────────────────────────
function errorLogger(obsDir, now) {
  return (motivo) => {
    try {
      fs.mkdirSync(obsDir, { recursive: true });
      const file = path.join(obsDir, 'instinct-observe.errors.log');
      fs.appendFileSync(file, `${now.toISOString()} ${motivo}\n`);
      const size = fs.statSync(file).size;
      if (size > MAX_ERRORS_LOG) {
        const text = fs.readFileSync(file, 'utf8');
        const tail = text.slice(text.length - Math.floor(MAX_ERRORS_LOG / 2));
        fs.writeFileSync(file, tail.slice(tail.indexOf('\n') + 1));
      }
    } catch (_) { /* sin dónde anotarlo: el gancho sigue callado */ }
  };
}

/**
 * Graba la línea del evento. `ctx`: `{ home, reposRoot, obsDir, enabled, now }`. Devuelve el código de salida (0).
 */
function run(input, ctx) {
  const now = ctx.now || new Date();
  const logError = errorLogger(ctx.obsDir, now);
  try {
    if (!ctx.enabled) return 0;
    let ev;
    try { ev = JSON.parse(input); } catch (_) { logError('evento ilegible'); return 0; }
    if (!ev || typeof ev !== 'object') { logError('evento ilegible'); return 0; }
    // `apply_patch` de Codex da un evento por archivo, como Edit o Write: una línea por cada uno
    const lines = [];
    for (const one of editEventsFrom(ev)) {
      const toolInput = (one && one.tool_input) || {};
      // en Windows la ruta trae `\`, que en el JSON aparece escapada: vale cualquiera de las dos barras
      if (/[\\/]clients[\\/]/i.test(JSON.stringify(toolInput))) return 0;
      const cwd = one.cwd || process.cwd();
      const tool = one.tool_name || 'unknown';
      const raw = summarize(tool, toolInput);
      const resp = one.tool_response;
      const status = resp && typeof resp === 'object' && (resp.is_error || resp.error) ? 'error' : 'ok';
      const { repo, origin } = repoAndOrigin(cwd, ctx, logError);
      lines.push(JSON.stringify({
        ts: Math.floor(now.getTime() / 1000),
        session_id: String(one.session_id || '').slice(0, 8),
        tool,
        project: projectOf(cwd, ctx),
        summary: raw === null ? null : sanitize(raw, ctx.home),
        status,
        repo,
        origin,
      }));
    }
    fs.mkdirSync(ctx.obsDir, { recursive: true });
    fs.appendFileSync(path.join(ctx.obsDir, `${now.toISOString().slice(0, 7)}.jsonl`), lines.map((l) => `${l}\n`).join(''));
  } catch (e) {
    logError(`no pude grabar (${e.code || e.message})`);
  }
  return 0;
}

/** `tycon-observations` en la carpeta de los registros sueltos de `home`, o null si no se puede saber. */
function defaultObsDir(home) {
  try {
    const dir = require('../../../scripts/lib/loose-logs.js').looseLogsDir(home);
    return dir ? path.join(dir, 'tycon-observations') : null;
  } catch (_) { return null; }
}

/** Lo que el gancho necesita de la configuración, sin tirar nunca: integración apagada o rota es «no grabar». */
function contextFromConfig(env, home) {
  const ctx = { home, reposRoot: null, obsDir: env.TYCON_INSTINCT_OBS_DIR || defaultObsDir(home), enabled: false };
  // sin dónde grabar (un árbol sin tycon-home.js) no graba
  if (!ctx.obsDir) return ctx;
  try {
    const cfg = require('../../../scripts/lib/tycon-config.js');
    const r = cfg.integracionParaHook('instincts', { env, home });
    ctx.enabled = !!(r && r.ok && r.prendida);
    if (r && r.ok === false) errorLogger(ctx.obsDir, new Date())(`la configuración está rota: no graba (${r.aviso || 'sin detalle'})`);
    const leida = ctx.enabled ? cfg.leerParaHook({ env, home }) : null;
    if (leida && leida.ok) {
      const repos = cfg.valor(leida.config, 'rutas.repos');
      ctx.reposRoot = Array.isArray(repos) ? repos[0] || null : repos || null;
    }
  } catch (e) {
    // no poder leer la configuración no es «apagada»: queda anotado, para que una máquina que dejó de grabar se vea
    ctx.enabled = false;
    errorLogger(ctx.obsDir, new Date())(`no pude leer la configuración (${e.code || e.message})`);
  }
  return ctx;
}

module.exports = { sanitize, summarize, canonOrigin, originUrl, findRepo, repoAndOrigin, projectOf, toSlash, run, contextFromConfig };

if (require.main === module) {
  let input = '';
  try { input = fs.readFileSync(0, 'utf8'); } catch (_) { input = ''; }
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  process.exitCode = run(input, contextFromConfig(process.env, home));
}
