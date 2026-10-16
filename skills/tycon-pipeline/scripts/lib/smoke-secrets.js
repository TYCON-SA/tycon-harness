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

// ── Story 1.19 — la expectativa y la salida de un humo ──────────────────────────────────────────────────────────
// Un humo con criterios escribe antes de correr qué tiene que pasar (`--pass-if`, y opcional `--fail-if`), y su
// salida se guarda en `<evidence-dir>/<clave>-smoke-outputs/`. Las dos cosas viajan por git como el `cmd`: pasan por
// el MISMO tapado (no hay un segundo tapado aparte que se desfase de éste).

/** Tope de la salida guardada, en bytes. Decisión del dueño (2026-10-15, duda 3): 8 KB por humo. */
const SALIDA_MAX_BYTES = 8192;
/** Tope de un texto de expectativa: es una frase, no un documento. */
const EXPECTATIVA_MAX = 1000;

/** Los primeros `max` bytes de `s` en UTF-8, sin dejar un carácter partido (el resto del byte se descarta). */
function cutBytes(s, max) {
  const b = Buffer.from(String(s), 'utf8');
  if (b.length <= max) return String(s);
  return b.subarray(0, max).toString('utf8').replace(/�+$/, '');
}

/** Corta a `max` bytes sin dejar un `***` partido (un `**` suelto el freno lo leería como un valor), igual que `truncate`. */
function cortaSinPartirMascara(s, max) {
  const c = cutBytes(s, max);
  return c.length < s.length && s[c.length] === '*' ? c.replace(/\*+$/, '') : c;
}

/** Cuántas veces lo que se guarda de cada punta se tapa antes de cortar (ver `recortarSalida`). */
const VENTANA = 3;

/**
 * Recorta la salida a `max` bytes: las primeras y las últimas líneas, con `[… N líneas omitidas …]` en el medio. Una
 * línea más larga que media salida se corta sola.
 *
 * `tapar` (opcional) tapa ANTES de cortar, pero no la salida entera: el tapado general crece con el cuadrado del largo
 * (50 KB tardaban 7 s). Tapa una VENTANA de cada punta —tres veces lo que se guarda de ese lado— y recién después
 * corta. Así una credencial que el corte partiría ya está tapada cuando se corta: una línea de sqlcmd terminada en `\`
 * con su `-P` en la siguiente, o un token en el borde de una línea larga. Lo encontró el pase adversarial de la 1.19
 * (2026-10-15): cortar primero dejaba la línea del `-P` sin su sqlcmd, o un pedazo de token más corto que lo que el
 * tapado reconoce, y los dos quedaban enteros en la evidencia que viaja por git.
 */
function recortarSalida(text, max = SALIDA_MAX_BYTES, tapar = (t) => t) {
  const s = String(text);
  if (Buffer.byteLength(s, 'utf8') <= max) return tapar(s);
  const lines = s.split('\n');
  const mitad = Math.floor((max - 120) / 2);
  const ventana = mitad * VENTANA;
  const bytes = (l) => Buffer.byteLength(l, 'utf8') + 1;
  const deVentana = (l) => (bytes(l) > ventana ? cutBytes(l, ventana) : l);
  // Las dos ventanas, sin pisarse: la de la cola arranca, como mucho, donde terminó la de la cabeza.
  const vHead = [];
  let vb = 0;
  let i = 0;
  for (; i < lines.length && vb < ventana; i += 1) { const l = deVentana(lines[i]); vHead.push(l); vb += bytes(l); }
  const vTail = [];
  let tb = 0;
  for (let j = lines.length - 1; j >= i && tb < ventana; j -= 1) { const l = deVentana(lines[j]); vTail.unshift(l); tb += bytes(l); }
  // Ninguna forma del tapado se lleva un salto de línea: las ventanas tapadas tienen las mismas líneas.
  const hLines = tapar(vHead.join('\n')).split('\n');
  const tLines = vTail.length ? tapar(vTail.join('\n')).split('\n') : [];
  const corta = (l) => (bytes(l) > mitad - 40 ? `${cortaSinPartirMascara(l, mitad - 64)} [… línea recortada …]` : l);
  const head = [];
  let hb = 0;
  for (const raw of hLines) {
    const l = corta(raw);
    if (hb + bytes(l) > mitad) break;
    head.push(l); hb += bytes(l);
  }
  const tail = [];
  let kb = 0;
  for (let j = tLines.length - 1; j >= 0 && lines.length - tail.length > head.length; j -= 1) {
    const l = corta(tLines[j]);
    if (kb + bytes(l) > mitad) break;
    tail.unshift(l); kb += bytes(l);
  }
  const omitidas = lines.length - head.length - tail.length;
  return [...head, `[… ${omitidas} líneas omitidas …]`, ...tail].join('\n');
}

/** Lo que va en lugar de una línea que el freno del commit todavía leería como un secreto. */
const LINEA_TAPADA = '[línea tapada: el freno del commit la lee como un secreto]';

/**
 * La salida tal como se guarda: texto (bytes inválidos → reemplazo, `\r\n` → `\n`), recortada, tapada y dentro del tope.
 *
 * Tres cosas que encontró el pase adversarial de la 1.19 (2026-10-15):
 *   · los finales de línea van como `\n`: la salida viaja por git y un checkout los reescribe (autocrlf en Windows,
 *     `eol=lf` en los repos del arnés); con los bytes crudos, la matriz la daba por editada;
 *   · se tapa en modo literal, como los argumentos de `cmd`: la salida es texto ya resuelto, no un guion, y en modo guion
 *     un valor que empieza con `$` pasaba por una variable;
 *   · una red final con el mismo lector del freno del commit (`findLeaksInContent`, que decodifica las líneas JSON):
 *     lo que todavía vería como secreto no se guarda. Si no, una línea JSON con `\n` delante de la forma pasaba el
 *     tapado (en crudo hay una `n` delante) y frenaba el commit.
 */
function salidaParaGuardar(buf, opts = {}) {
  const texto = (Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)).replace(/\r\n/g, '\n');
  let count = 0;
  const tapar = (t) => { const r = redact(t, { ...opts, literal: true }); count += r.count; return r.text; };
  let out = recortarSalida(texto, SALIDA_MAX_BYTES, tapar);
  const vistas = new Set(findLeaksInContent(out).map((l) => l.line));
  if (vistas.size) {
    out = out.split('\n').map((l, i) => (vistas.has(i + 1) ? LINEA_TAPADA : l)).join('\n');
    count += vistas.size;
  }
  // El tapado general puede alargar un valor corto (`a:bcde` → `$USUARIO:$VAL`): el tope se vuelve a cumplir al final.
  if (Buffer.byteLength(out, 'utf8') > SALIDA_MAX_BYTES) out = cortaSinPartirMascara(out, SALIDA_MAX_BYTES);
  return { text: out, count };
}

/** Una expectativa tal como se escribe en el registro: tapada (en modo literal: es un argumento ya resuelto) y cortada. */
function expectativaParaGuardar(text, opts = {}) {
  const r = redact(String(text).slice(0, 4000), { ...opts, literal: true });
  return { text: truncate(r.text, EXPECTATIVA_MAX), count: r.count };
}

function sha256(text) { return require('crypto').createHash('sha256').update(text).digest('hex'); }

/**
 * Lo que smoke-run.sh agrega a la línea del registro y a la del espejo para un humo `"v":2` (el `"v":2` lo pone el
 * envoltorio). Escribe la salida en `<evidenceDir>/<key>-smoke-outputs/<sello>-<6 hex>.txt` con apertura exclusiva:
 * dos humos del mismo segundo no se pisan (AC 18). Si la carpeta o el archivo no se pueden crear, `output: null`
 * (AC 17): el humo queda registrado y la matriz no lo cuenta.
 */
function ledgerExtras(o, opts = {}) {
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const ledger = {};
  const mirror = {};
  let count = 0;
  for (const [campo, valor] of [['pass_if', o.pasaSi], ['fail_if', o.fallaSi]]) {
    if (valor === undefined) continue;
    const r = expectativaParaGuardar(valor, opts);
    count += r.count;
    ledger[campo] = r.text;
    mirror[`${campo}_sha`] = sha256(r.text);
  }
  ledger.output = null;
  ledger.output_sha = null;
  if (o.salidaTmp && o.evidenceDir && o.key) {
    const s = salidaParaGuardar(fs.readFileSync(o.salidaTmp), opts);
    count += s.count;
    const sello = String(o.ts || new Date().toISOString().replace(/\.\d+Z$/, 'Z')).replace(/[-:]/g, '');
    const dirRel = `${o.key}-smoke-outputs`;
    try {
      fs.mkdirSync(path.join(o.evidenceDir, dirRel), { recursive: true });
      for (let intento = 0; intento < 5 && ledger.output === null; intento += 1) {
        const rel = `${dirRel}/${sello}-${crypto.randomBytes(3).toString('hex')}.txt`;
        try {
          fs.writeFileSync(path.join(o.evidenceDir, rel), s.text, { flag: 'wx' });
          ledger.output = rel;
        } catch (e) { if (e.code !== 'EEXIST') throw e; }
      }
    } catch (e) {
      process.stderr.write(`[smoke-run] ⚠️ no se pudo guardar la salida en ${path.join(o.evidenceDir, dirRel)} (${e.code || e.message}): el humo queda registrado con salida: null y la matriz no lo cuenta.\n`);
    }
    if (ledger.output !== null) {
      ledger.output_sha = sha256(s.text);
      mirror.output_sha = ledger.output_sha;
    }
  }
  return { ledger, mirror, count };
}

/** Los campos como fragmento de JSON, para pegarlos detrás de los de la línea (`,"a":1,"b":2`; vacío si no hay). */
function fragmento(obj) {
  return Object.entries(obj).map(([k, v]) => `,${JSON.stringify(k)}:${JSON.stringify(v)}`).join('');
}

module.exports = { MASK, FORMS, redact, truncate, ledgerCmd, ledgerCmdFromArgs, joinArgs, findLeaks, findLeaksInContent, isEvidencePath, isSafeValue,
  SALIDA_MAX_BYTES, recortarSalida, salidaParaGuardar, expectativaParaGuardar, ledgerExtras, fragmento, cortaSinPartirMascara };

function avisoTapado(count) {
  if (count > 0) {
    process.stderr.write(`[smoke-run] 🔒 se taparon ${count} valor(es) con forma de credencial antes de escribir la evidencia.\n`);
    process.stderr.write('[smoke-run]    El registro VIAJA por git. Pasá la credencial por variable (SQLCMDPASSWORD="$DB_PASS", -H "X-Api-Key: $API_KEY") y no habrá nada que tapar.\n');
  }
}

// CLI, lo usa smoke-run.sh (los avisos salen por stderr):
//   `node smoke-secrets.js ledger-cmd -- <comando…>` — escribe en stdout el `cmd` del registro como texto JSON.
//   `node smoke-secrets.js ledger-extras [--pass-if <t>] [--fail-if <t>] [--output-tmp <archivo> --evidence-dir <dir>
//        --key <clave> --ts <sello>]` — escribe dos líneas: el fragmento de la línea del registro y el del espejo.
if (require.main === module) {
  const [sub, ...rest] = process.argv.slice(2);
  const legacy = process.env.TYCON_SMOKE_REDACT !== '0';
  if (sub === 'ledger-cmd' && rest[0] === '--') {
    const r = ledgerCmdFromArgs(rest.slice(1), { legacy });
    avisoTapado(r.count);
    process.stdout.write(JSON.stringify(r.text));
  } else if (sub === 'ledger-extras') {
    const flags = { '--pass-if': 'pasaSi', '--fail-if': 'fallaSi', '--output-tmp': 'salidaTmp',
      '--evidence-dir': 'evidenceDir', '--key': 'key', '--ts': 'ts' };
    const o = {};
    for (let i = 0; i < rest.length; i += 2) {
      if (!flags[rest[i]] || i + 1 >= rest.length) {
        process.stderr.write(`smoke-secrets.js ledger-extras: no entiendo «${rest[i]}»\n`);
        process.exit(2);
      }
      o[flags[rest[i]]] = rest[i + 1];
    }
    const r = ledgerExtras(o, { legacy });
    avisoTapado(r.count);
    process.stdout.write(`${fragmento(r.ledger)}\n${fragmento(r.mirror)}\n`);
  } else {
    process.stderr.write('uso: smoke-secrets.js ledger-cmd -- <comando…> | ledger-extras [--pass-if <texto>] …\n');
    process.exit(2);
  }
}
