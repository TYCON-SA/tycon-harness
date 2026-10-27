'use strict';
/**
 * controls-off.js — ¿este cambio a la configuración de la herramienta saca un control del arnés? (HARNESS-C2)
 *
 * Los controles del arnés son hooks registrados en la configuración de Claude Code: `settings.json` y
 * `settings.local.json`, en `~/.claude/` o en `<repo>/.claude/`. La misma configuración los apaga de tres maneras:
 * `disableAllHooks: true`, un interruptor en `env` (los escapes de los frenos y los `TYCON_*` que apagan), o el hook
 * sacado (o con un `matcher` que ya no cubre lo que cubría). Una edición o un comando que hace cualquiera de las tres
 * frena antes.
 *
 * Frena sólo con evidencia de que se saca algo. Un hook que no es del arnés es de la persona: sacarlo pasa. Un
 * interruptor que prende, una variable que no apaga nada, un hook agregado o una clave cualquiera pasan. Una
 * configuración sin hooks del arnés puede borrarse o reescribirse entera.
 *
 * Por las herramientas de edición se compara el archivo de antes con el que queda: es exacto. Por la terminal se parte
 * el comando en sus comandos simples, respetando las comillas: sólo cuenta lo que está en posición de comando, nunca el
 * texto de un mensaje. Un comando que borra o mueve la configuración frena si tiene controles. Uno que la reemplaza
 * entera (un heredoc, un `echo`, un `cat`, la copia, el enlace o la sincronización de otro archivo, un intérprete que la
 * escribe sin leerla) se juzga por el contenido nuevo, si se ve; si no se ve, frena si tenía controles. Uno que la lee y
 * la reescribe se juzga por el resultado cuando es un filtro de `jq` que se puede correr; si no, por las formas de sacar
 * que su texto deja ver. Lo que el comando no deja ver (una variable con el valor, un filtro en un archivo) pasa: la
 * lista de esas formas está en el todo del repo privado.
 *
 * Uso por la terminal: `node controls-off.js --command-stdin --cwd <dir> [--shell powershell]` imprime un renglón
 * `frena=<motivo>` por cada control que el comando saca. Sale 0 siempre; sin renglones, no saca nada.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// las variables que apagan un freno con cualquier valor que no sea 0 ni vacío: las de ESC-C1 en safety-guard-pre.sh y
// los escapes que cuenta la revisión nocturna (ESCAPES de scripts/nightly/runs-review/rules.js; una prueba los cruza)
const APAGAN_CON_CUALQUIERA = new Set(['TYCON_TEST_GATE', 'DOD_BYPASS', 'TYCON_NO_DEEP_REVIEW', 'TYCON_STATUS_GATE',
  'TYCON_SAFETY_OFF', 'TYCON_PR_BY_HAND', 'TYCON_FULL_SUITE', 'TYCON_SESSION_GUARD_OK', 'TYCON_ENGRAM_MANIFEST_OK',
  'TYCON_RUNTIME_MATRIX_NO_MUTATION_CHECK', 'STOP_AUTONOMY', 'TYCON_EVAL_SANDBOX']);

/** ¿La variable `nombre` con el valor `valor` apaga un control? Las mismas formas que HARNESS-C1 mira en el rc. */
function apaga(nombre, valor) {
  const n = String(nombre).toUpperCase();
  const v = String(valor == null ? '' : valor).trim().toLowerCase();
  if (APAGAN_CON_CUALQUIERA.has(n)) return v !== '' && v !== '0';
  if (/^TYCON_NO_/.test(n)) return ['1', 'on', 'true'].includes(v);
  if (/^TYCON_/.test(n)) return ['0', 'off', 'false'].includes(v);
  return false;
}

/** ¿La ruta es una configuración de Claude Code? Un `settings.json` cualquiera (el de VS Code) no lo es. */
function esConfig(ruta) {
  const r = String(ruta || '').replace(/\\/g, '/');
  return /(^|\/)\.claude\/settings(\.local)?\.json$/i.test(r);
}

/** ¿El comando del hook es del arnés? Los hooks del arnés corren desde su casa o desde sus skills. */
function esDelArnes(cmd) {
  return /[\\/]\.tycon[\\/]|[\\/]\.tycon-pipeline[\\/]|[\\/]tycon-[a-z-]+[\\/]scripts[\\/]/i.test(String(cmd || ''));
}

/** El comando de un hook escrito siempre igual: sin comillas, con la casa como `~` y las barras derechas. */
function normalizarComando(cmd, home) {
  let c = String(cmd || '').replace(/["']/g, '').replace(/\\/g, '/').replace(/\s+/g, ' ').trim();
  const h = String(home || '').replace(/\\/g, '/');
  if (h) c = c.split(h + '/').join('~/');
  return c.replace(/\$\{?HOME\}?\//g, '~/');
}

/** Los hooks del arnés de una configuración: `evento · comando` → los matchers con que está registrado. */
function hooksDelArnes(conf, home = os.homedir()) {
  const out = new Map();
  const hooks = conf && typeof conf === 'object' && conf.hooks && typeof conf.hooks === 'object' ? conf.hooks : {};
  for (const [evento, grupos] of Object.entries(hooks)) {
    if (!Array.isArray(grupos)) continue;
    for (const g of grupos) {
      for (const h of (g && Array.isArray(g.hooks) ? g.hooks : [])) {
        if (!h || !esDelArnes(h.command)) continue;
        const k = `${evento} · ${normalizarComando(h.command, home)}`;
        if (!out.has(k)) out.set(k, []);
        out.get(k).push(g.matcher == null ? '' : String(g.matcher));
      }
    }
  }
  return out;
}

const tieneControles = (conf) => hooksDelArnes(conf).size > 0;

/** ¿El matcher `nuevo` cubre todo lo que cubría `viejo`? Vacío o `*` cubren todo; si no, las alternativas de `|`. */
function cubre(nuevo, viejo) {
  const todo = (m) => m === '' || m === '*';
  if (todo(nuevo)) return true;
  if (todo(viejo)) return false;
  const n = new Set(nuevo.split('|').map((s) => s.trim()));
  return viejo.split('|').every((s) => n.has(s.trim()));
}

/** Lo que `despues` le saca a `antes`, un motivo por control. Vacío si no saca nada. */
function apagados(antes, despues, { home = os.homedir() } = {}) {
  const a = antes && typeof antes === 'object' ? antes : {};
  const d = despues && typeof despues === 'object' ? despues : {};
  const motivos = [];
  if (d.disableAllHooks === true && a.disableAllHooks !== true) motivos.push('pone disableAllHooks: true, que apaga todos los hooks del arnés');
  const envA = a.env && typeof a.env === 'object' ? a.env : {};
  const envD = d.env && typeof d.env === 'object' ? d.env : {};
  for (const [k, v] of Object.entries(envD)) {
    if (apaga(k, v) && !(Object.prototype.hasOwnProperty.call(envA, k) && apaga(k, envA[k]))) motivos.push(`pone ${k}=${v} en env, que apaga un control del arnés`);
  }
  // un hook está mientras siga en el mismo evento con un matcher que cubra el de antes; un duplicado sacado no saca nada
  const hd = hooksDelArnes(d, home);
  for (const [k, matchers] of hooksDelArnes(a, home)) {
    const ahora = hd.get(k) || [];
    for (const m of new Set(matchers)) {
      if (!ahora.some((n) => cubre(n, m))) motivos.push(`saca (o le angosta el matcher a) el hook del arnés ${k} (matcher «${m}»)`);
    }
  }
  return motivos;
}

function leerJson(t) {
  try { return { ok: true, v: JSON.parse(String(t).replace(/^﻿/, '')) }; } catch (_e) { return { ok: false, v: null }; }
}

/** Compara dos textos de configuración. Uno nuevo ilegible frena si el de antes tenía controles: la herramienta lo ignora. */
function juzgarTexto(antesTexto, despuesTexto, opts) {
  const a = antesTexto == null ? { ok: true, v: {} } : leerJson(antesTexto);
  const d = leerJson(despuesTexto);
  if (!d.ok) return a.ok && tieneControles(a.v) ? ['deja la configuración ilegible, y con eso la herramienta no carga los hooks del arnés'] : [];
  return apagados(a.ok ? a.v : {}, d.v, opts);
}

function leer(ruta) { try { return fs.readFileSync(ruta, 'utf8'); } catch (_e) { return null; } }
function real(ruta) { try { return fs.realpathSync(ruta); } catch (_e) { return null; } }

// ── las herramientas de edición ─────────────────────────────────────────────────────────────────────────────────────

/** El texto que queda después de un Edit, MultiEdit o Write; null si no se puede saber (el Edit fallaría igual). */
function textoQueQueda(toolName, ti, actual) {
  if (toolName === 'Write') return typeof ti.content === 'string' ? ti.content : null;
  const edits = toolName === 'MultiEdit' ? (Array.isArray(ti.edits) ? ti.edits : []) : [ti];
  let t = actual == null ? '' : actual;
  for (const e of edits) {
    if (!e || typeof e.old_string !== 'string' || typeof e.new_string !== 'string') return null;
    if (e.old_string === '') { t = e.new_string; continue; }
    if (!t.includes(e.old_string)) return null;
    t = e.replace_all ? t.split(e.old_string).join(e.new_string) : t.replace(e.old_string, () => e.new_string);
  }
  return t;
}

/** ¿El archivo es una configuración, por su nombre o porque una configuración de la casa o del repo es un enlace a él? */
function esConfigOEnlace(abs, cwd, home) {
  if (esConfig(abs)) return true;
  const r = real(abs);
  if (!r) return false;
  const candidatas = [];
  for (const base of [home, cwd]) {
    if (!base) continue;
    for (const n of ['settings.json', 'settings.local.json']) candidatas.push(path.join(base, '.claude', n));
  }
  return candidatas.some((c) => real(c) === r);
}

/** Los motivos por los que esta edición saca un control; vacío si no es la configuración o no saca nada. */
function juzgarEdicion({ toolName, toolInput, cwd, home = os.homedir() }) {
  const ti = toolInput || {};
  if (!ti.file_path || !['Edit', 'Write', 'MultiEdit'].includes(toolName)) return [];
  const base = cwd || process.cwd();
  const abs = path.resolve(base, String(ti.file_path));
  if (!esConfigOEnlace(abs, base, home)) return [];
  const actual = leer(abs);
  const queda = textoQueQueda(toolName, ti, actual);
  if (queda == null) return [];
  return juzgarTexto(actual, queda, { home });
}

// ── la terminal: el comando partido en comandos simples ────────────────────────────────────────────────────────────

/**
 * Parte el comando en comandos simples, respetando comillas y heredocs. Cada uno trae sus palabras (sin comillas), sus
 * redirecciones `{op, a}`, los cuerpos de sus heredocs y el número de tubería: los unidos por `|` comparten número.
 * En PowerShell la barra invertida es parte de la ruta, no un escape.
 */
function partir(texto, shell) {
  const s = String(texto || '');
  const ps = shell === 'powershell';
  const segs = [];
  let tubo = 0;
  let seg = null;
  let w = null;
  let q = null;
  let pendientes = [];
  const nuevo = () => { seg = { palabras: [], redir: [], heredocs: [], tubo }; };
  const fin = () => { if (w != null) { seg.palabras.push(w); w = null; } };
  const corta = (otroTubo) => {
    fin();
    if (seg.palabras.length || seg.redir.length) segs.push(seg);
    if (otroTubo) tubo += 1;
    nuevo();
  };
  nuevo();
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && !ps && i + 1 < s.length && /["\\$`]/.test(s[i + 1])) w += s[++i];
      else w += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; w = w == null ? '' : w; continue; }
    if (c === '\\' && !ps && i + 1 < s.length && s[i + 1] !== '\n') { w = (w == null ? '' : w) + s[++i]; continue; }
    if (c === '\n') {
      // los heredocs abiertos en este renglón: su cuerpo va hasta el renglón que es sólo el delimitador
      for (const p of pendientes) {
        const re = new RegExp(`^[ \\t]*${p.delim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'm');
        const resto = s.slice(i + 1);
        const m = re.exec(resto);
        const cuerpo = m ? resto.slice(0, m.index) : resto;
        p.seg.heredocs.push(cuerpo.replace(/\n$/, ''));
        i += cuerpo.length + (m ? m[0].length : 0);
      }
      pendientes = [];
      corta(true);
      continue;
    }
    if (/\s/.test(c)) { fin(); continue; }
    if (c === ';' || c === '(' || c === ')' || c === '{' && w == null && /\s/.test(s[i + 1] || ' ') || c === '}' && w == null) { corta(true); continue; }
    if (c === '|') { if (s[i + 1] === '|') { i++; corta(true); } else corta(false); continue; }
    if (c === '&' && s[i + 1] === '&') { i++; corta(true); continue; }
    if (c === '>' || c === '<' || (c === '&' && s[i + 1] === '>')) {
      // un número pegado antes del operador es el descriptor, no una palabra
      if (w != null && /^\d+$/.test(w)) w = null;
      fin();
      let op = c;
      while (/[<>&|-]/.test(s[i + 1] || '') && op.length < 3) op += s[++i];
      if (/^\d/.test(s[i + 1] || '') && /&$/.test(op)) { while (/\d/.test(s[i + 1] || '')) i++; continue; }
      // la palabra que sigue al operador
      while (/[ \t]/.test(s[i + 1] || '')) i++;
      let a = '';
      let qa = null;
      while (i + 1 < s.length) {
        const d = s[i + 1];
        if (qa) { i++; if (d === qa) qa = null; else a += d; continue; }
        if (d === "'" || d === '"') { qa = d; i++; continue; }
        if (/[\s;|&()<>]/.test(d)) break;
        a += d; i++;
      }
      if (/^<<-?$/.test(op)) pendientes.push({ delim: a, seg });
      else seg.redir.push({ op, a });
      continue;
    }
    if (c === '&') { corta(true); continue; }
    w = (w == null ? '' : w) + c;
  }
  corta(true);
  return segs;
}

const PREFIJOS = new Set(['sudo', 'doas', 'command', 'builtin', 'env', 'nohup', 'time', 'exec', 'nice', 'xargs']);

/** El nombre del comando (sin carpeta ni `.exe`, en minúsculas) y sus argumentos. */
function comandoDe(seg) {
  const p = seg.palabras;
  let i = 0;
  while (i < p.length && (PREFIJOS.has(p[i].toLowerCase()) || /^[A-Za-z_]\w*=/.test(p[i]) || (i > 0 && PREFIJOS.has(p[i - 1].toLowerCase()) && p[i].startsWith('-')))) i++;
  const nombre = (p[i] || '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
  return { nombre, args: p.slice(i + 1) };
}

/** La ruta con `~`, `$HOME` o la casa de Windows expandidas, resuelta contra `cwd`. */
function resolver(raw, cwd, home) {
  let r = String(raw).replace(/^(?:~|\$\{?HOME\}?|\$env:USERPROFILE|%USERPROFILE%)(?=[\\/]|$)/i, home);
  r = r.replace(/\\/g, '/');
  return path.resolve(cwd, r);
}

const sinOpciones = (args) => {
  const out = [];
  let todas = false;
  for (const a of args) {
    if (!todas && a === '--') { todas = true; continue; }
    if (!todas && /^-/.test(a)) continue;
    out.push(a);
  }
  return out;
};

const BORRAN = new Set(['rm', 'unlink', 'trash', 'trash-put', 'shred', 'srm', 'truncate']);
const BORRAN_PS = new Set(['remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir']);
const MUEVEN = new Set(['mv']);
const MUEVEN_PS = new Set(['move', 'move-item', 'mi']);
const COPIAN = new Set(['cp', 'install', 'ln', 'rsync', 'ditto']);
const COPIAN_PS = new Set(['copy', 'copy-item', 'cpi']);
const ESCRIBEN_PS = new Set(['set-content', 'sc', 'out-file', 'add-content']);
const INTERPRETES = /^(python\d*(\.\d+)?|py|node|nodejs|bun|deno|ruby|perl|pwsh|powershell)$/;

/** El origen y el destino de un comando de PowerShell con `-Path`/`-Destination`; si no, los dos últimos. */
function esCarpeta(ruta) { try { return fs.statSync(ruta).isDirectory(); } catch (_e) { return false; } }

function origenYDestino(nombre, args, ps) {
  const t = args.findIndex((a) => a === '-t' || a === '--target-directory');
  if (t >= 0 && args[t + 1]) {
    const resto = sinOpciones(args.filter((_a, k) => k !== t && k !== t + 1));
    return { origenes: resto, destino: resto.length === 1 ? path.join(args[t + 1], path.basename(resto[0])) : undefined };
  }
  if (ps) {
    const val = (re) => { const i = args.findIndex((a) => re.test(a)); return i >= 0 ? args[i + 1] : undefined; };
    const dest = val(/^-destination$/i);
    const orig = val(/^-(literal)?path$/i);
    if (dest || orig) return { origenes: orig ? [orig] : [], destino: dest };
  }
  const libres = sinOpciones(args);
  if (libres.length < 2) return { origenes: [], destino: undefined };
  return { origenes: libres.slice(0, -1), destino: libres[libres.length - 1] };
}

// lo que el código de un intérprete escribe: el primer argumento de cada forma de escribir un archivo
const ESCRITURAS_LITERALES = [
  /\bopen\(\s*(['"])([^'"]+)\1\s*,\s*(?:mode\s*=\s*)?['"][wax]/g,
  /\bwriteFile(?:Sync)?\(\s*(['"`])([^'"`]+)\1/g,
  /\bWriteAllText\(\s*(['"])([^'"]+)\1/g,
  /\b(?:File|IO)\.write\(\s*(['"])([^'"]+)\1/g,
  /\bPath\(\s*(['"])([^'"]+)\1\s*\)\.write_text\(/g,
  /\b(?:Set-Content|Out-File|Add-Content)\s+(?:-(?:Path|FilePath|LiteralPath)\s+)?(['"]?)([^\s'"$|;)]+)\1/gi,
];
const ESCRIBE_UN_INTERPRETE = /\bopen\((?:[^()]|\([^()]*\))*?,\s*(?:mode\s*=\s*)?['"][wax]\+?['"]|\bwriteFile(Sync)?\(|\bWriteAllText\(|\b(File|IO)\.write\(|\.write_text\(|\bSet-Content\b|\bOut-File\b|\bAdd-Content\b|\bjson\.dump\(/i;
const LEE_UN_INTERPRETE = /\bjson\.loads?\(|\.read\(|\.read_text\(|\breadFile(Sync)?\(|\brequire\(\s*(?!['"][\w@][\w@/.-]*['"])|\bJSON\.parse\(|\bGet-Content\b|\bConvertFrom-Json\b|\b(File|IO)\.read\(|\bReadAllText\(|\bopen\(\s*[^,()]+\)/i;

/** Los archivos que escribe el código de un intérprete: los literales resueltos, y si hay alguno que no se puede saber. */
function escriturasDelCodigo(codigo, cwd, home) {
  if (!ESCRIBE_UN_INTERPRETE.test(codigo)) return { literales: [], incierta: false };
  const literales = [];
  let cuantas = 0;
  for (const re of ESCRITURAS_LITERALES) {
    for (const m of codigo.matchAll(re)) { literales.push(resolver(m[2], cwd, home)); cuantas += 1; }
  }
  const formas = (codigo.match(new RegExp(ESCRIBE_UN_INTERPRETE.source, 'gi')) || []).filter((f) => !/json\.dump/i.test(f)).length;
  return { literales, incierta: formas > cuantas };
}

/** El primer texto entre comillas (o el cuerpo de un heredoc) que es un JSON: el contenido nuevo, si se ve. */
function jsonALaVista(candidatos) {
  for (const c of candidatos) { if (c != null && leerJson(c).ok) return c; }
  return null;
}
const literalesDe = (codigo) => [...String(codigo).matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2].replace(/\\(["'\\])/g, '$1'));

// lo que el texto de un cambio que lee y reescribe la configuración deja ver
const PRENDE_DISABLE = /disableAllHooks['"]?\]?\s*(?:[:=]|\|=)\s*['"]?\$?(true|1)\b/i;
const VARIABLE_ASIGNADA = /\b(TYCON_[A-Z0-9_]+|DOD_BYPASS|STOP_AUTONOMY)['"]?\]?\s*(?:[:=]|\|=)\s*(['"]?)([^'"\s,;})\]]*)/gi;
const VACIO = String.raw`(?:\[\s*\]|\{\s*\}|None|null|undefined|nil|\$null)`;
const HOOKS = String.raw`(?:\.hooks\b|\[\s*['"]hooks['"]\s*\])`;
const SACA_HOOKS = [
  /del\(\s*\.hooks\b/i,
  new RegExp(`${HOOKS}(?:\\.[A-Za-z]+|\\[[^\\]]*\\])*\\s*(?:=|\\|=)\\s*${VACIO}`),
  new RegExp(`${HOOKS}(?:\\.[A-Za-z]+|\\[[^\\]]*\\])*\\s*\\|=\\s*[^|]*\\b(select|del|map|empty)\\b`),
  new RegExp(`${HOOKS}[^;\\n]*?\\.(pop|clear|splice|remove|shift|Remove|Clear)\\(`),
  /\bdel\s+[\w.]+\[\s*['"]hooks['"]/,
  /\.pop\(\s*['"]hooks['"]/,
  /\bdelete\s+[\w.[\]'"]+\.hooks\b/,
  /\bdelete\s+[\w.]+\[\s*['"]hooks['"]/,
  /\.Remove\(\s*['"]hooks['"]/i,
  /\.update\(\s*(?:\{\s*['"]hooks['"]|hooks\s*=)/,
  /\bhooks['"]?\s*:\s*(?:\{\s*\}|\[\s*\]|null)/,
  /with_entries\(\s*select/,
];

/** ¿Un `sed` borra o reescribe el renglón de un hook del arnés? Su dirección (`/patrón/d`) o su `s/patrón/…/` calzan. */
function tocaRenglonDeUnHook(texto, conf) {
  const comandos = [];
  const hooks = conf && conf.hooks && typeof conf.hooks === 'object' ? conf.hooks : {};
  for (const grupos of Object.values(hooks)) {
    for (const g of (Array.isArray(grupos) ? grupos : [])) {
      for (const h of (g && Array.isArray(g.hooks) ? g.hooks : [])) {
        if (h && esDelArnes(h.command)) comandos.push(String(h.command), JSON.stringify(String(h.command)));
      }
    }
  }
  const patrones = [];
  for (const m of texto.matchAll(/\/((?:[^/\\\n]|\\.)+)\/\s*d\b/g)) patrones.push(m[1]);
  for (const m of texto.matchAll(/(?:^|[\s;'"])s([^\w\s\\])((?:\\.|(?!\1).)+)\1/g)) patrones.push(m[2]);
  for (const p of patrones) {
    let re = null;
    try { re = new RegExp(p); } catch (_e) { re = null; }
    if (re ? comandos.some((c) => re.test(c)) : comandos.some((c) => c.includes(p))) return true;
  }
  return false;
}

/** Los motivos por los que un comando que lee y reescribe la configuración la deja sin un control, mirando su texto. */
function porElTexto(texto, conf, raw) {
  const m = [];
  if (PRENDE_DISABLE.test(texto)) m.push('pone disableAllHooks en true, que apaga todos los hooks del arnés');
  for (const a of texto.matchAll(VARIABLE_ASIGNADA)) {
    if (apaga(a[1], a[3])) m.push(`pone ${a[1]}=${a[3]} en la configuración, que apaga un control del arnés`);
  }
  if (tieneControles(conf) && (SACA_HOOKS.some((re) => re.test(texto)) || tocaRenglonDeUnHook(texto, conf))) m.push(`saca hooks de ${raw}, que tiene registrados los del arnés`);
  return m;
}

const JQ_OPCIONES_SIMPLES = /^(-[cMSCaer]+|--(compact-output|monochrome-output|sort-keys|color-output|ascii-output|exit-status|raw-output|tab))$/;

/** El resultado de correr el único filtro de `jq` que lee esta configuración; null si no se puede correr tal cual. */
function correrJq(segs, abs, cwd, home) {
  const jqs = segs.filter((s) => comandoDe(s).nombre === 'jq');
  if (jqs.length !== 1) return null;
  const { args } = comandoDe(jqs[0]);
  const opciones = [];
  const libres = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--indent') { opciones.push(a, args[++i]); continue; }
    if (/^-/.test(a)) { if (!JQ_OPCIONES_SIMPLES.test(a)) return null; opciones.push(a); continue; }
    libres.push(a);
  }
  const entrada = jqs[0].redir.find((r) => r.op === '<');
  const archivos = libres.slice(1).concat(entrada ? [entrada.a] : []);
  if (libres.length < 1 || archivos.length !== 1 || resolver(archivos[0], cwd, home) !== abs) return null;
  const r = spawnSync('jq', [...opciones, libres[0], abs], { encoding: 'utf8', timeout: 3000 });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

/**
 * Los motivos por los que un comando saca un control. `shell` es `powershell` cuando el comando es de esa herramienta:
 * ahí `del`, `erase` o `Remove-Item` borran; en bash son palabras.
 */
function juzgarComando({ cmd, cwd, home = os.homedir(), shell = 'bash' }) {
  const texto = String(cmd || '');
  const ps = shell === 'powershell';
  const segs = partir(texto, shell);
  // la carpeta de cada comando simple, siguiendo los `cd` de antes
  let dir = cwd;
  const enDir = [];
  for (const s of segs) {
    const { nombre, args } = comandoDe(s);
    enDir.push(dir);
    if (['cd', 'pushd', 'set-location', 'sl', 'chdir'].includes(nombre)) {
      const d = sinOpciones(args)[0];
      dir = d ? resolver(d, dir, home) : home;
    }
  }

  // lo que cada comando simple le hace a cada configuración: la saca, la reemplaza (con lo que se ve) o la transforma
  const efectos = new Map(); // abs → [{tipo, raw, origen?, contenido?}]
  const nombradas = new Map();
  const anota = (abs, raw, efecto) => {
    if (!esConfig(abs)) return;
    nombradas.set(abs, raw);
    if (!efectos.has(abs)) efectos.set(abs, []);
    efectos.get(abs).push(efecto);
  };
  const escritosPorElComando = new Set();
  segs.forEach((s, i) => {
    const d = enDir[i];
    for (const r of s.redir) if (/^(>|>>|>\||&>|&>>)$/.test(r.op)) escritosPorElComando.add(resolver(r.a, d, home));
    if (comandoDe(s).nombre === 'tee') for (const a of sinOpciones(comandoDe(s).args)) escritosPorElComando.add(resolver(a, d, home));
  });
  // el contenido que una tubería le pasa a quien escribe: lo que emite su primer comando, si se ve
  const cabeza = (s) => segs.find((o) => o.tubo === s.tubo);
  const loQueEmite = (s, d) => {
    const { nombre, args } = comandoDe(s);
    if (nombre === 'echo' || nombre === 'printf' || nombre === 'write-output') {
      const libres = nombre === 'printf' ? args.filter((a) => !/^-/.test(a)).slice(0, 1) : args.filter((a) => !/^-[neE]+$/.test(a));
      const t = libres.join(' ');
      return { tipo: 'reemplaza', contenido: nombre === 'printf' || args.includes('-e') ? t.replace(/\\n/g, '\n') : t };
    }
    if (['cat', 'type', 'get-content', 'gc'].includes(nombre)) {
      if (s.heredocs.length) return { tipo: 'reemplaza', contenido: s.heredocs[s.heredocs.length - 1] };
      const libres = sinOpciones(args);
      const entrada = s.redir.find((r) => r.op === '<');
      const archivos = libres.concat(entrada ? [entrada.a] : []);
      if (archivos.length === 1) return { tipo: 'copia', origen: resolver(archivos[0], d, home) };
      return { tipo: 'reemplaza', contenido: null };
    }
    return { tipo: 'transforma' };
  };

  segs.forEach((s, i) => {
    const d = enDir[i];
    const { nombre, args } = comandoDe(s);
    const libres = sinOpciones(args);
    // redirecciones: `> config` (y `tee`, `sponge`) escriben con lo que emite la cabeza de la tubería
    for (const r of s.redir) {
      if (/^(>|>>|>\||&>|&>>)$/.test(r.op)) anota(resolver(r.a, d, home), r.a, loQueEmite(s, d));
    }
    if (nombre === 'tee' || nombre === 'sponge') {
      const c = cabeza(s);
      for (const a of libres) anota(resolver(a, d, home), a, c === s ? { tipo: 'reemplaza', contenido: null } : loQueEmite(c, enDir[segs.indexOf(c)]));
    }
    if (BORRAN.has(nombre) || (ps && BORRAN_PS.has(nombre)) || (nombre === 'git' && libres[0] === 'rm' && !args.includes('--cached'))) {
      for (const a of (nombre === 'git' ? libres.slice(1) : libres)) anota(resolver(a, d, home), a, { tipo: 'saca' });
    }
    if (MUEVEN.has(nombre) || (ps && MUEVEN_PS.has(nombre)) || COPIAN.has(nombre) || (ps && COPIAN_PS.has(nombre))) {
      const { origenes, destino } = origenYDestino(nombre, args, ps);
      if (MUEVEN.has(nombre) || MUEVEN_PS.has(nombre)) for (const o of origenes) anota(resolver(o, d, home), o, { tipo: 'saca' });
      if (destino) {
        let abs = resolver(destino, d, home);
        if (origenes.length === 1 && esCarpeta(abs)) abs = path.join(abs, path.basename(resolver(origenes[0], d, home)));
        const origen = origenes.length === 1 ? resolver(origenes[0], d, home) : null;
        // lo que arma el mismo comando (`jq … > tmp && mv tmp config`) es la configuración reescrita
        if (origen && escritosPorElComando.has(origen)) anota(abs, destino, { tipo: 'transforma' });
        else if (origen) anota(abs, destino, { tipo: 'copia', origen });
        else anota(abs, destino, { tipo: 'reemplaza', contenido: null });
      }
    }
    if (nombre === 'dd') {
      const de = (k) => { const a = args.find((x) => x.startsWith(k + '=')); return a ? a.slice(k.length + 1) : null; };
      const of = de('of');
      const inf = de('if');
      if (of) anota(resolver(of, d, home), of, inf ? { tipo: 'copia', origen: resolver(inf, d, home) } : { tipo: 'reemplaza', contenido: null });
    }
    if (['sed', 'gsed', 'perl'].includes(nombre) && args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a))) {
      for (const a of libres) anota(resolver(a, d, home), a, { tipo: 'transforma' });
    }
    if (ps && ESCRIBEN_PS.has(nombre)) {
      const { origenes } = origenYDestino(nombre, args.concat(['-Destination']), true);
      const destino = origenes[0] || libres[0];
      if (destino) anota(resolver(destino, d, home), destino, cabeza(s) === s ? { tipo: 'reemplaza', contenido: null } : loQueEmite(cabeza(s), d));
    }
    if (INTERPRETES.test(nombre) && !(nombre === 'perl' && args.some((a) => /^-[a-zA-Z]*i/.test(a)))) {
      const codigo = args.join('\n') + '\n' + s.heredocs.join('\n');
      const { literales, incierta } = escriturasDelCodigo(codigo, d, home);
      const configs = new Map();
      for (const l of literales) if (esConfig(l)) configs.set(l, l);
      if (incierta) {
        const armaLaCasa = /\bHOME\b|homedir\(|expanduser\(|USERPROFILE/.test(codigo);
        for (const m of codigo.matchAll(/[^\s"'`<>|;&()=,+]*settings(?:\.local)?\.json/gi)) {
          const enLaCasa = armaLaCasa && /^[\\/]\.claude[\\/]/.test(m[0]);
          const abs = enLaCasa ? path.join(home, m[0]) : resolver(m[0], d, home);
          if (esConfig(abs)) configs.set(abs, m[0]);
        }
      }
      for (const [abs, raw] of configs) {
        anota(abs, raw, LEE_UN_INTERPRETE.test(codigo) ? { tipo: 'transforma' } : { tipo: 'reemplaza', contenido: jsonALaVista(literalesDe(codigo)) });
      }
    }
  });

  const motivos = [];
  for (const [abs, lista] of efectos) {
    const raw = nombradas.get(abs);
    const actual = leer(abs);
    const antes = actual == null ? { ok: true, v: {} } : leerJson(actual);
    const conControles = antes.ok && tieneControles(antes.v);
    for (const e of lista) {
      if (e.tipo === 'saca') {
        if (conControles) motivos.push(`borra o mueve ${raw}, que tiene registrados los hooks del arnés`);
      } else if (e.tipo === 'copia') {
        const t = esConfig(e.origen) && e.origen === abs ? actual : leer(e.origen);
        if (t != null) motivos.push(...juzgarTexto(actual, t, { home }));
        else if (conControles) motivos.push(`reemplaza ${raw} con un archivo que no se puede leer, y se pierden los hooks del arnés`);
      } else if (e.tipo === 'reemplaza') {
        if (e.contenido != null && leerJson(e.contenido).ok) motivos.push(...juzgarTexto(actual, e.contenido, { home }));
        else if (conControles) motivos.push(`reemplaza ${raw} entero con un contenido que no se ve, y se pierden los hooks del arnés`);
      } else {
        const resultado = correrJq(segs, abs, enDir[segs.findIndex((s) => comandoDe(s).nombre === 'jq')] || cwd, home);
        if (resultado != null) motivos.push(...juzgarTexto(actual, resultado, { home }));
        else motivos.push(...porElTexto(texto, antes.ok ? antes.v : {}, raw));
      }
    }
  }
  return [...new Set(motivos)];
}

module.exports = { apaga, esConfig, esDelArnes, apagados, juzgarTexto, juzgarEdicion, juzgarComando, partir };

if (require.main === module) {
  const args = process.argv.slice(2);
  const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  let motivos = [];
  try {
    const cmd = args.includes('--command-stdin') ? fs.readFileSync(0, 'utf8') : '';
    motivos = juzgarComando({ cmd, cwd: val('--cwd') || process.cwd(), shell: val('--shell') || 'bash' });
  } catch (e) {
    process.stderr.write(`controls-off: ${(e && e.message) || e}\n`);
    process.exit(1);
  }
  for (const m of motivos) process.stdout.write(`frena=${m.replace(/\n/g, ' ')}\n`);
  process.exit(0);
}
