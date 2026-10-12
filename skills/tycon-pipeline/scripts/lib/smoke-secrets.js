'use strict';
/**
 * smoke-secrets — tapa los secretos del comando de una prueba de humo ANTES de escribirlo en el registro
 * (`<story>-smoke-ledger.jsonl`), y los encuentra si igual llegaron a `.advisors/dod-runtime/`.
 *
 * ── Por qué existe (2026-10-04) ──────────────────────────────────────────────────────────────
 * El registro guarda el comando tal cual corrió, y `.advisors/dod-runtime/` VIAJA por git a propósito (es la
 * evidencia de cierre). El 2026-10-04 aparecieron contraseñas SQL escritas tal cual en los registros de un
 * producto, una de ellas la de la base de PRODUCCIÓN; en otro producto pasó lo mismo con tokens Bearer (se limpió
 * a mano el 2026-09-18). El tapado de la SMOKE-SECRETO-1 (2026-09-22) ya existía, pero sólo reconocía valores
 * hechos de letras y números: `SQLCMDPASSWORD='…'` (comillas y un símbolo) o `sqlcmd -P <valor>` pasaban
 * enteros. Caso: guides/incident-log.md#case-sql-passwords-in-smoke-ledgers-2026-10-04.
 *
 * ── Qué hace ─────────────────────────────────────────────────────────────────────────────────
 * Un conjunto CERRADO de formas inequívocas, cada una con el nombre a la vista y el valor a tapar:
 *   · `SQLCMDPASSWORD=…` y toda variable de entorno puesta en línea cuyo nombre (en mayúsculas) tenga PASSWORD,
 *     SECRET o TOKEN, o termine en PASS o PWD;
 *   · el `-P` de `sqlcmd`;
 *   · `Password=`, `Pwd=` y `AccountKey=` de una cadena de conexión;
 *   · `Authorization: Bearer …`;
 *   · el `sig=` de una URL con SAS.
 * El valor se reemplaza por `***` (las comillas quedan). Un valor que ya es `***` o una variable (`$X`, `${X}`,
 * `$(…)`) no se toca: eso es lo que hay que escribir.
 *
 * 🔴 No intenta entender el comando de shell entero: con estas formas exactas alcanza, y un intérprete de shell
 * hecho con patrones se equivoca justo en los casos raros. Lo que esté fuera de la lista lo cubren el tapado
 * general de antes (`legacyPatterns`, apagable con TYCON_SMOKE_REDACT=0) y el buscador de secretos del pipeline.
 * Las formas de la lista se tapan SIEMPRE, también con TYCON_SMOKE_REDACT=0: una contraseña nunca es el dato bajo
 * prueba de un registro que viaja por git.
 *
 * Lo usan: smoke-run.sh (al escribir), runtime-matrix.js y qa-guide.js (al mostrar un comando de un registro
 * viejo) y el freno de on-pre-commit.js (`findLeaks`, al commitear).
 */

const MASK = '***';

// El valor de una palabra de shell, ENTERA: tramos entre comillas simples, entre comillas dobles (con escapes),
// caracteres escapados y caracteres sueltos, pegados entre sí (`'it'\''s'` es una sola palabra). Corta en un blanco o
// en un separador sin comillas. Revisión adversarial del 2026-10-04: con un tramo solo, `Ab;cd` o `'Ab'cd` se tapaban
// hasta el símbolo y el resto quedaba a la vista detrás de `***`.
const SHELL_VALUE = String.raw`(?:'[^']*'|"(?:[^"\\]|\\.)*"|\$\([^)\n]*\)|\\.|[^\s'"` + '`' + String.raw`;&|()<>\\])+`;
// El valor dentro de una cadena de conexión: sin comillas llega hasta el `;` o el fin de línea —una contraseña con un
// espacio o una comilla en el medio no se corta—, y una comilla seguida de un blanco o del final la cierra. Si se
// lleva algo de más, sólo se lee peor.
const CONN_VALUE = String.raw`'[^'\n]*'(?=[;\s"]|$)|"(?:[^"\\\n]|\\.)*"(?=[;\s']|$)|\{[^}\n]*\}|(?:[^;\n'"]|['"](?!\s|$))+`;
// En un argumento que el shell ya resolvió, la comilla no cierra nada: el valor llega hasta el `;` o el final.
const CONN_VALUE_LITERAL = String.raw`'[^'\n]*'(?=;|$)|"[^"\n]*"(?=;|$)|\{[^}\n]*\}|[^;\n]+`;
// El token de un Authorization: Bearer, con el mismo criterio para las comillas.
const TOKEN_VALUE = String.raw`(?:[^\s'"` + '`' + String.raw`]|['"](?!\s|$))+`;

// Nombres de configuración que no son el secreto aunque digan TOKEN o PASSWORD (`TOKEN_TTL`, `PASSWORD_MIN_LENGTH`,
// `TOKEN_URL`): falsos positivos del freno medidos en la revisión del 2026-10-04.
const CONFIG_SUFFIX = /_(?:TTL|AGE|URL|URI|ENDPOINT|FILE|PATH|DIR|LENGTH|LEN|COUNT|EXPIRY|EXPIRES|EXPIRATION|TIMEOUT|LIFETIME|MIN|MAX|NAME|TYPE|HEADER)$/;

const STRONG_NAME = /PASSWORD|PASSWD|SECRET|(?:^|_)(?:PASS|PWD)$/;

/** ¿El nombre y su valor son de un secreto? `TOKEN_TTL=60` y `PASSWORD_MIN_LENGTH=8` no; `DB_PASSWORD_MAX=Xy9#` sí. */
function envIsSecret(name, value) {
  // Un número, con el punto o la coma de la frase que lo sigue (`PASSWORD_MIN_LENGTH=8.`).
  const numeric = /^\d+[.,;:]?$/.test(value);
  // `DB_PASSWORD_FILE=/run/secrets/db`: el valor de un *_FILE / *_PATH / *_DIR que es una ruta no es el secreto.
  const isPath = /_(?:FILE|PATH|DIR)$/.test(name) && /^(?:\/|\.{1,2}\/|~\/|[A-Za-z]:[\\/])/.test(value);
  if (STRONG_NAME.test(name)) return !((numeric || isPath) && CONFIG_SUFFIX.test(name));
  if (!/TOKEN/.test(name)) return false;
  return !numeric && !CONFIG_SUFFIX.test(name);
}

/**
 * Las formas: `re` captura el prefijo (lo que queda a la vista) en el grupo 1 y el valor en el último grupo.
 * `accept(m)` descarta un calce que no es de la forma (la variable que no es un secreto).
 */
const FORMS = [
  {
    id: 'env-var',
    label: 'variable de entorno con PASSWORD, SECRET o TOKEN en el nombre',
    // En un argumento que el shell ya resolvió (modo literal), el valor es TODO el resto del argumento
    // (`--env=DB_PASSWORD=Ab;cd`, `--build-arg=…`, `--from-literal=…`), y `-eNAME=` pegado también cuenta.
    re: (opts = {}) => (opts.literal
      ? new RegExp(String.raw`(?:(?<![A-Za-z0-9_$])|(?<=^-e))(([A-Z_][A-Z0-9_]*)=)([^\n]+)`, 'g')
      : new RegExp(String.raw`(?<![A-Za-z0-9_$])(([A-Z_][A-Z0-9_]*)=)(${SHELL_VALUE})`, 'g')),
    accept: (m) => envIsSecret(m[2], m[3]),
  },
  {
    id: 'sqlcmd-P',
    label: 'el -P de sqlcmd',
    // `-P` en mayúscula: el `-p` de sqlcmd es otra opción. El `\b` después de sqlcmd deja afuera SQLCMDPASSWORD. El
    // tramo hasta el `-P` sigue una línea continuada con `\` y no cruza `&&` ni `|` (el `-P` de otro comando), salvo
    // entre comillas: `-s '|'` es el separador de columnas de sqlcmd (segunda vuelta de la revisión, 2026-10-04).
    // 🔴 El carácter suelto no acepta comillas: si las aceptara, cada tramo entre comillas se podría leer de dos
    // maneras y el retroceso sería exponencial (tercera vuelta: un INSERT con 8 valores tardaba 99 s, y el freno
    // pasado de tiempo deja pasar el commit). Por lo mismo la barra va sólo como escape (`\'`, `\` + salto).
    // Una comilla sin cerrar corta la búsqueda: no se ve un -P después.
    re: () => new RegExp(String.raw`(\b[Ss][Qq][Ll][Cc][Mm][Dd](?:\.[Ee][Xx][Ee])?\b(?:'[^'\n]*'|"(?:[^"\\\n]|\\.)*"|\\[\s\S]|(?!&&|\|)[^\n'"\\])*?\s-P\s*)(${SHELL_VALUE})`, 'g'),
  },
  {
    id: 'connection-string',
    label: 'Password=, Pwd= o AccountKey= de una cadena de conexión',
    // Sin blancos antes del `=`: una comparación de SQL (`WHERE <columna> = NULL`) no es una cadena de conexión.
    re: (opts = {}) => new RegExp(String.raw`((?<=^|[\s;'"{(])(?:password|pwd|accountkey)=\s*)(${opts.literal ? CONN_VALUE_LITERAL : CONN_VALUE})`, 'gi'),
  },
  {
    id: 'bearer',
    label: 'Authorization: Bearer',
    re: () => new RegExp(String.raw`(authorization\s*:\s*bearer\s+)(${TOKEN_VALUE})`, 'gi'),
  },
  {
    id: 'sas-sig',
    label: 'sig= de una URL con SAS',
    re: () => new RegExp(String.raw`([?&]sig=)([^&\s'"#\\]+)`, 'gi'),
  },
];

/** Las comillas que abren y cierran el valor, para conservarlas al tapar: `'a'\''b'` → `'***'`. */
function quotesOf(value) {
  const v = String(value);
  const pairs = { "'": "'", '"': '"', '{': '}' };
  const open = pairs[v[0]] && v.length >= 2 ? v[0] : '';
  return { open, close: open ? pairs[open] : '' };
}

/**
 * Lo que se espera ver: `***` (con o sin comillas), una variable (`$X`, `${X}`, `$(…)`, sin comillas o entre
 * comillas dobles) o un marcador de documentación (`<…>`, `...`). Vacío tampoco es un secreto.
 *
 * 🔴 Entre comillas SIMPLES un `$` es literal: `'$ecret9X'` es la contraseña, no una variable. Y smoke-run.sh arma
 * entre comillas simples todo argumento con un `$`, porque ahí el shell ya expandió las variables (revisión
 * adversarial del 2026-10-04).
 */
function isSafeValue(value, opts = {}) {
  const v = String(value).trim();
  if (v === '' || v === "''" || v === '""') return true;
  if (/^['"{]?\*\*\*(?![A-Za-z0-9])/.test(v)) return true;
  if (!opts.literal && /^"?\$[A-Za-z_{(]/.test(v)) return true;
  // Marcadores de documentación: `<token>`, `...`.
  if (/^<[^>]*>$/.test(v) || /^(?:\.\.\.|…)$/.test(v)) return true;
  return false;
}

/** Recorre los calces de UNA forma sobre `text`: `fn(match, prefix, value)`. */
function eachFormMatch(text, form, fn, opts = {}) {
  const re = form.re(opts);
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === '') { re.lastIndex += 1; continue; }
    if (form.accept && !form.accept(m)) {
      // La variable no era un secreto: seguir desde después de su nombre, no saltear el resto del valor.
      re.lastIndex = m.index + m[1].length;
      continue;
    }
    fn(m, m[1], m[m.length - 1]);
  }
}

// El tapado general de la SMOKE-SECRETO-1 (2026-09-22), antes escrito en python dentro de smoke-run.sh. Cubre
// formas que no son de la lista (claves de API, OAuth, `curl -u`), sólo cuando el valor es de letras y números.
// Corre DESPUÉS de las formas de la lista: al revés, sobre `PASSWORD=` con el valor `'Ab1234!x'` tapaba `Ab1234` y dejaba
// `!x` a la vista detrás de un `$VAL` que el freno lee como variable. Los marcadores son cortos y empiezan con `$`
// a propósito (gitleaks marca la FORMA, no el contenido — guides/incident-log.md#case-long-redaction-marker-flagged-2026-09-22).
const LEGACY_PATTERNS = [
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{20,}/gi, '$1 $$TOKEN'],
  [/\b(basic)\s+[A-Za-z0-9+/=]{12,}/gi, '$1 $$CRED'],
  [/\b(x-api-key\s*:\s*)[A-Za-z0-9._~+/=-]{8,}/gi, '$1$$API_KEY'],
  [/\b(authorization\s*:\s*)[A-Za-z0-9._~+/=-]{20,}/gi, '$1$$CRED'],
  // SIN \b adelante: `\bsecret` nunca calza dentro de `client_secret` (`_` es carácter de palabra).
  [/([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|token|secret|password|passwd|pwd))(['"]?\s*[=:]\s*['"]?)[A-Za-z0-9._~+/=-]{6,}(['"]?)/gi,
    '$1$2$$VAL$3'],
  [/(\s-u\s+|\s--user[= ])[^\s:'"]{1,40}:[^\s'"]{4,}/gi, '$1$$USUARIO:$$VAL'],
];

/**
 * Tapa los secretos de `text`. Devuelve `{ text, count }`.
 * @param {{ legacy?: boolean }} [opts]  legacy=false apaga sólo el tapado general (TYCON_SMOKE_REDACT=0).
 */
function redact(text, opts = {}) {
  let s = String(text === undefined || text === null ? '' : text);
  let count = 0;
  for (const form of FORMS) {
    let out = '';
    let last = 0;
    eachFormMatch(s, form, (m, prefix, value) => {
      if (isSafeValue(value, opts)) return;
      const q = quotesOf(value);
      out += s.slice(last, m.index) + `${prefix}${q.open}${MASK}${q.close}`;
      last = m.index + m[0].length;
      count += 1;
    }, opts);
    s = out + s.slice(last);
  }
  if (opts.legacy !== false) {
    for (const [re, rep] of LEGACY_PATTERNS) {
      count += (s.match(re) || []).length;
      s = s.replace(re, rep);
    }
  }
  return { text: s, count };
}

/** Corta `s` a `max` caracteres sin partir un `***` (un `**` suelto el freno lo leería como un valor). */
function truncate(s, max) {
  const str = String(s);
  if (str.length <= max) return str;
  let out = str.slice(0, max);
  if (str[max] === '*') out = out.replace(/\*+$/, '');
  return out;
}

/** El `cmd` tal como se escribe en el registro: tapado y cortado a 300 caracteres (en ese orden). */
function ledgerCmd(cmd, opts = {}) {
  // Se tapan los primeros 4000 caracteres: el registro guarda 300, y el tapado general crece con el cuadrado del largo
  // (un cuerpo base64 de 50 KB tardaba 7 s).
  const r = redact(String(cmd === undefined || cmd === null ? '' : cmd).slice(0, 4000), opts);
  return { text: truncate(r.text, 300), count: r.count };
}

/**
 * El `cmd` del registro a partir de los argumentos de smoke-run.sh. Cada argumento se tapa SOLO, antes de citarlo y
 * unirlo: ahí todo `$` es literal (el shell ya expandió las variables) y una cadena de conexión con `Password='a;b'`
 * se lee con sus comillas de verdad, no con las que agrega el citado (segunda vuelta de la revisión, 2026-10-04).
 * Después se tapa el comando unido, para las formas que ocupan dos argumentos (`-P` y su valor). El texto de un `-c`
 * es un guion: se tapa como texto, sin el modo literal.
 */
function ledgerCmdFromArgs(args, opts = {}) {
  let count = 0;
  const tapados = args.map((a, i) => {
    const script = i > 0 && isScriptFlag(args[i - 1]);
    // `NAME=valor` como argumento propio (`env SQLCMDPASSWORD=Ab;cd sqlcmd`): el valor es TODO lo que sigue al `=`,
    // con sus `;` y sus comillas, porque el shell ya las resolvió.
    // Igual con `Password=…` suelto (`sqlcmd -v Password=Ab;cd`): sin otra clave delante, el `;` es de la contraseña.
    const nv = script ? null : /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]+)$/.exec(String(a));
    if (nv && ((/^[A-Z_][A-Z0-9_]*$/.test(nv[1]) && envIsSecret(nv[1], nv[2])) || /^(?:password|pwd|accountkey)$/i.test(nv[1]))
      && !isSafeValue(nv[2], { literal: true })) {
      count += 1;
      return `${nv[1]}=${MASK}`;
    }
    const r = redact(String(a).slice(0, 4000), { ...opts, literal: !script });
    count += r.count;
    return r.text;
  });
  const r = ledgerCmd(joinArgs(tapados), opts);
  return { text: r.text, count: count + r.count };
}

/** Los calces de las formas con un valor que no es `***` ni una variable: `[{ form, label, index }]`. Sin el valor. */
function findLeaks(text) {
  const leaks = [];
  for (const form of FORMS) {
    eachFormMatch(String(text || ''), form, (m, prefix, value) => {
      if (!isSafeValue(value)) leaks.push({ form: form.id, label: form.label, index: m.index });
    });
  }
  return leaks;
}

function stringsOf(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => stringsOf(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => stringsOf(v, out));
  return out;
}

/**
 * Los secretos de un archivo de `.advisors/dod-runtime/`, por línea: `[{ line, form, label }]`.
 * Una línea JSON se mira por sus textos ya decodificados (en crudo, `\"` confunde dónde termina un valor).
 */
function findLeaksInContent(content) {
  const found = [];
  String(content || '').split('\n').forEach((raw, i) => {
    let texts = [raw];
    const t = raw.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try { texts = stringsOf(JSON.parse(t)); } catch (_) { /* no es JSON: se mira en crudo */ }
    }
    const seen = new Set();
    for (const text of texts) {
      for (const l of findLeaks(text)) {
        if (seen.has(l.form)) continue;
        seen.add(l.form);
        found.push({ line: i + 1, form: l.form, label: l.label });
      }
    }
  });
  return found;
}

/** ¿La ruta (relativa al repo) es de una carpeta de evidencia de cierre? */
function isEvidencePath(file) {
  return /(?:^|\/)\.advisors\/dod-runtime\//.test(String(file || '').replace(/\\/g, '/'));
}

/** `-c`, `-lc`, `-ec`…: la opción tras la cual va el texto de un guion (`bash -lc '…'`). */
function isScriptFlag(a) {
  return /^-[A-Za-z]*c$/.test(String(a));
}

/** Una palabra entre comillas simples, como la escribiría el shell (`'` adentro va como `'\''`). */
function quoteWord(w) {
  if (w === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(w)) return w;
  return `'${w.replace(/'/g, "'\\''")}'`;
}

/**
 * Arma el comando legible a partir de sus argumentos, que el shell ya separó y expandió.
 *
 * Todo argumento con un carácter fuera de `[A-Za-z0-9_@%+=:,./-]` va entre comillas simples: unido a secas,
 * `-P "mi clave"` quedaba `-P mi clave` (se tapaba `mi`), `-P 'Ab;cd'` se tapaba hasta el `;`, y un `$` del valor
 * —ya literal, porque el shell expandió las variables— pasaba por variable. En `NAME=valor` y en `-Pvalor` se cita
 * sólo el valor, para que la forma se siga viendo.
 *
 * El texto de un `-c` (`bash -c '…'`) va tal cual: es un guion con sus propias comillas, que ya son las del shell.
 */
function joinArgs(args) {
  return args.map((a, i) => {
    if (i > 0 && isScriptFlag(args[i - 1])) return a;
    const nv = /^([A-Za-z_][A-Za-z0-9_]*=)([\s\S]*)$/.exec(a);
    if (nv) return nv[1] + quoteWord(nv[2]);
    const p = /^(-P)([\s\S]+)$/.exec(a);
    if (p) return p[1] + quoteWord(p[2]);
    return quoteWord(a);
  }).join(' ');
}

module.exports = { MASK, FORMS, redact, truncate, ledgerCmd, ledgerCmdFromArgs, joinArgs, findLeaks, findLeaksInContent, isEvidencePath, isSafeValue };

// CLI: `node smoke-secrets.js ledger-cmd -- <comando…>` — escribe en stdout el `cmd` del registro como texto JSON.
// Lo usa smoke-run.sh; el aviso de «se taparon N valores» sale por stderr.
if (require.main === module) {
  const [sub, sep, ...args] = process.argv.slice(2);
  if (sub !== 'ledger-cmd' || sep !== '--') {
    process.stderr.write('uso: smoke-secrets.js ledger-cmd -- <comando…>\n');
    process.exit(2);
  }
  const r = ledgerCmdFromArgs(args, { legacy: process.env.TYCON_SMOKE_REDACT !== '0' });
  if (r.count > 0) {
    process.stderr.write(`[smoke-run] 🔒 se taparon ${r.count} valor(es) con forma de credencial antes de escribir la evidencia.\n`);
    process.stderr.write('[smoke-run]    El registro VIAJA por git. Pasá la credencial por variable (SQLCMDPASSWORD="$DB_PASS", -H "X-Api-Key: $API_KEY") y no habrá nada que tapar.\n');
  }
  process.stdout.write(JSON.stringify(r.text));
}
