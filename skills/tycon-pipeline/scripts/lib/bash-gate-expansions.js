'use strict';
/**
 * bash-gate-expansions.js — una parte de on-bash-write-gate.js, el freno de escrituras por consola.
 *
 * Responsabilidad: lo que el shell arma antes de correr: comodines, corchetes, variables y `env`, las órdenes de `find`, `xargs` y `parallel`, y las constancias que un comando trae de otra rama.
 *
 * El código viene de on-bash-write-gate.js tal cual, salvo dos reescrituras mecánicas: los `require` locales van
 * relativos a esta carpeta, y las rutas que salían de la carpeta de los guiones suben un nivel más. Cada parte carga
 * sólo las de abajo (la red primero; el despachador, todas).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { NEVER_CODE_SEGMENTS } = require('./story-gate.js');
// ── variables del comando ─────────────────────────────────────
// `SP=<scratchpad>; python3 -c "open('$SP/x.cs','w')"` sale frenado como «EDICIÓN INVISIBLE»: el destino se resuelve
// tal cual, `<repo>/$SP/x.cs`, y queda adentro del repo de la corrida.
// Las variables las expande `lib/command-vars.js`: con el valor que tenían EN ESE PUNTO del comando, y si el comando no
// las asignó, con el ambiente. Lo que no se puede saber sin ejecutar (`$(…)`, `${VAR:-x}`, una variable que nadie
// define) queda «sin resolver»: se resuelve como siempre (del lado seguro: si cae en el repo, frena) y queda marcado,
// para que el mensaje diga que no se pudo resolver en vez de presentarlo como código del repo sin más.
// (Un lector compartido, `scripts/lib/shell-parse.js`, no sirve acá:
// da rutas falsas — la cabecera de command-vars.js dice por qué.)
const { expandirRuta } = require('./command-vars.js');
const { FORMAS_DE_ESCRIBIR, logHookError } = require('./bash-gate-net.js');
const { ANTES_DEL_PROGRAMA, ARGUMENTOS_DE_LECTURA, ARGUMENTO_CON_NOMBRE, CLASES_POSIX, CORCHETE_TOPE, MODO_SOLO_LEE, OPEN_LLAMADA, PREFIJO, SOLO_VARIABLE, argumentosDeLlamada, guionDeSedSinEfectos, nativePath, noSeLeeElPrograma, palabras, palabrasDelComando, posicionesDeComando, sinComillasDeLosBordes, sinEscapesDeComillas, sinGrupo, sinRedireccionesDelante, ultimosArgumentos } = require('./bash-gate-words.js');

// Las opciones de un envoltorio que llevan su valor en la palabra siguiente: las de `ENVOLTORIOS_CON_VALOR` (más abajo en
// el archivo: se juntan la primera vez que se piden) y las de estos
const MAS_OPCIONES_CON_VALOR = {
  // (las de sudo de `ENVOLTORIOS_CON_VALOR`, y el tiempo y la raíz: `-T 5`, `-R /`)
  sudo: /^-[ugCDhprtTUR]$|^--(?:user|group|close-from|chdir|host|prompt|role|type|other-user|command-timeout|chroot)$/,
  env: /^-[uCSPa]$|^--(?:unset|chdir|split-string|argv0)$/,
  doas: /^-[uC]$/,
  ionice: /^-[cnpPu]$|^--(?:class|classdata|pid|pgid|uid)$/,
  exec: /^-a$/,
  time: /^-[fo]$|^--(?:format|output)$/,
};
let opcionesConValor = null;
const opcionesDelEnvoltorio = (n) => (opcionesConValor ||= { ...ENVOLTORIOS_CON_VALOR, ...MAS_OPCIONES_CON_VALOR })[n];
/** `palabraDelShell`, también con el citado ANSI-C y sus escapes: `$'\x63p'` es `cp`. */
function palabraConAnsi(w) {
  return palabraDelShell(String(w).replace(/\$'((?:\\[\s\S]|[^'\\])*)'/g, (m, x) => `'${ansiC(x).replace(/'/g, "'\\''")}'`));
}

/**
 * Los destinos de un cp / mv: con `-t` / `--target-directory` (también `-rt`, `-t<carpeta>`), la carpeta y cada archivo
 * que llega a ella; si no, el último argumento (`palabrasDelComando`, sin redirecciones: `cp a b 2>&1`, `cp a b <<<x`).
 * En rsync `-t` conserva las fechas: ahí no hay carpeta de destino aparte.
 */
function cpMvDest(seg) {
  return destinosDeCpMv(palabrasDelComando(sinRedireccionesDelante(seg), { conVacias: true }));
}

/** Los destinos de un cp / mv de `cpMvDest`, con las palabras ya leídas: la primera, el nombre del programa. */
function destinosDeCpMv(conVacias) {
  let words = conVacias;
  // rsync e install, sin el valor de sus opciones (`--exclude x`, `-m 644`), que no es un origen ni el destino; y la
  // carpeta de `install -t`. Con las palabras vacías: un valor citado que se vació (`-f '- x'`) sigue en su lugar
  const copiador = /^rsync/.test(words[0]) ? 'rsync' : /^g?install/.test(words[0]) ? 'install' : null;
  if (copiador) {
    const { sueltos: todos, carpeta } = argumentosDeCopia(copiador, words.slice(1));
    const sueltos = todos.filter(Boolean);
    if (carpeta) return [carpeta, ...sueltos.map((f) => `${carpeta.replace(/[\\/]+$/, '')}/${f.split(/[\\/]/).pop()}`)];
    return words.sinCerrar ? sueltos : sueltos.slice(-1);
  }
  words = words.filter(Boolean);
  words.sinCerrar = conVacias.sinCerrar;
  // con varios -t vale el último, como en cp
  let dir = null;
  const fuera = new Set([0]);   // el nombre del comando, y lo que nombra la carpeta
  for (let i = 0; i < words.length && words[0] !== 'rsync'; i++) {
    const largo = /^--target-directory=(.+)$/.exec(words[i]);
    const pegado = /^-t(.+)$/.exec(words[i]);
    if (largo) { dir = largo[1]; fuera.add(i); } else if ((/^-[a-zA-Z]*t$/.test(words[i]) || words[i] === '--target-directory') && words[i + 1]) {
      dir = words[i + 1]; fuera.add(i).add(i + 1); i++;
    } else if (pegado) { dir = pegado[1]; fuera.add(i); }
  }
  // sin -t: el último argumento que no es una opción (`cp a b -f`, `Copy-Item a b -Force`, `cp a b --`)
  if (dir === null) return ultimosArgumentos(words);
  const fuentes = words.filter((w, i) => !fuera.has(i) && !w.startsWith('-'));
  return [dir, ...fuentes.map((f) => `${dir.replace(/[\\/]+$/, '')}/${f.split(/[\\/]/).pop()}`)];
}

/**
 * El programa escrito de un tramo: la primera palabra que no es del shell ni una asignación, sin comillas, leída del texto
 * (así `"$PWD"/node_modules/.bin/tsc` es `tsc`). Una variable con valor conocido vale su programa. `{ programa, ilegible }`.
 */
function programaEscrito(cmd, tramo) {
  const partes = String(tramo).trim().split(/\s+/).map((w) => sinGrupo(w)).filter(Boolean);
  const w = partes.find((x) => !ANTES_DEL_PROGRAMA.test(x) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x));
  if (!w) return { programa: '', ilegible: false };
  const s = w.replace(/["']/g, '');
  if (SOLO_VARIABLE.test(s) || /^\$\((?!\()|^`/.test(s)) return { programa: interpreteDe(cmd, s), ilegible: noSeLeeElPrograma(cmd, s) };
  return { programa: nombreDeComando(s), ilegible: false };
}

/** El programa de una palabra. Una variable con valor conocido (`N=/usr/bin/node`, `N="env node --test"`) es su programa. */
function interpreteDe(cmd, w) {
  const s = String(w || '');
  if (!SOLO_VARIABLE.test(s)) return nombreDeComando(s);
  const e = expandirRuta(cmd, s);
  if (e.sinResolver.length || /^\$/.test(String(e.valor))) return nombreDeComando(s);
  const partes = String(e.valor).trim().split(/\s+/);
  const programa = nombreDeComando(partes[0]);
  return programa !== 'env' ? programa : nombreDeComando(partes.slice(1).find((x) => !x.startsWith('-') && !x.includes('=')) || 'env');
}

/**
 * Si el `open(` que empieza en `desde` (justo después del paréntesis) puede escribir. Lee como abre: el segundo argumento
 * o `mode=` en cualquier lugar (`open(p, encoding='utf-8', mode='w')`). Escribe con un modo que no es un literal de sólo
 * lectura —`'w'`, `'a'`, `'x'`, `'+'`, o uno guardado en una variable (`open(p, m)`)—, con argumentos desplegados
 * (`*a`, `**kw`) y cuando no se terminan de leer. Como método (`Path(p).open('w')`, `os.open(p, flags)`) cuenta también
 * el primer argumento: un modo de escritura, o uno que no es un literal.
 */
function abreParaEscribir(texto, desde, metodo) {
  const args = argumentosDeLlamada(texto, desde);
  if (!args || args.some((a) => a.startsWith('*'))) return true;
  const conNombre = args.filter((a) => ARGUMENTO_CON_NOMBRE.test(a));
  const posicionales = args.filter((a) => !ARGUMENTO_CON_NOMBRE.test(a));
  for (const a of conNombre) {
    const m = /^(\w+)\s*=\s*([\s\S]*)$/.exec(a);
    const nombre = m[1].toLowerCase();
    // el modo con nombre escribe salvo un literal de lectura; los argumentos que no dicen cómo abre no cuentan; cualquier
    // otro (`flags=` de os.open, `opener=`) puede abrir para escribir
    if (nombre === 'mode') { if (!MODO_SOLO_LEE.test(m[2].trim())) return true; } else if (!ARGUMENTOS_DE_LECTURA.has(nombre)) return true;
  }
  if (posicionales.length > 1 && !MODO_SOLO_LEE.test(posicionales[1])) return true;
  if (metodo && posicionales.length) {
    const lit = /^(['"])([^'"]*)\1$/.exec(posicionales[0]);
    // un primer argumento que no es literal puede ser el modo (`p.open(m)`); uno literal escribe si es un modo de escritura
    if (!lit) return true;
    if (/^[rwaxbtU+]+$/.test(lit[2]) && /[wax+]/.test(lit[2])) return true;
  }
  return false;
}
/**
 * Si algún `open(` del texto puede escribir (ver abreParaEscribir). El texto puede venir con las comillas escapadas del
 * shell (`open(\"$F\")`): se leen como comillas.
 */
function algunOpenEscribe(texto) {
  const s = sinEscapesDeComillas(texto);
  for (const m of s.matchAll(OPEN_LLAMADA)) if (abreParaEscribir(s, m.index + m[0].length, Boolean(m[1]))) return true;
  return false;
}
/**
 * ¿Un `sed` sin `-i` escribe o corre algo con su guion? Las palabras que siguen a `sed`: un guion de `-e` o
 * `--expression`, o el primer argumento si no hay ninguno, que no sea sólo cambiar el texto que lee
 * (`guionDeSedSinEfectos`): `w`, `W`, `s///w` escriben el archivo que nombran y `e` corre un comando. Un guion de
 * archivo (`-f`) no se ve: cuenta como que sí.
 */
function sedConEfectos(args) {
  const guiones = [];
  let posicional = null;
  for (let j = 0; j < args.length; j++) {
    const w = args[j];
    if (w === '--') { if (posicional == null) posicional = args[j + 1] ?? null; break; }
    if (w === '-e' || w === '--expression') { if (j + 1 < args.length) guiones.push(args[++j]); continue; }
    // `--expression='w h.md'`: el valor citado puede llegar pegado o como la palabra que sigue
    if (/^--expression=/.test(w)) { const v = sinComillasDeLosBordes(w.slice('--expression='.length)); guiones.push(v !== '' ? v : (args[++j] ?? '')); continue; }
    if (/^-[A-Za-z]*f/.test(w) || /^--file\b/.test(w)) return true;
    if (/^-[A-Za-z]*e./.test(w)) { guiones.push(w.replace(/^-[A-Za-z]*?e/, '')); continue; }
    if (w.startsWith('-') && w !== '-') continue;
    if (posicional == null) posicional = w;
  }
  if (!guiones.length && posicional != null) guiones.push(posicional);
  return guiones.some((g) => !guionDeSedSinEfectos(g));
}

/**
 * ¿La palabra es un nombre tal cual o un comodín que se expande igual en bash y en zsh (`*`, `?` y corchetes, tramo por
 * tramo)? No lo es con `**` (zsh baja por todas las carpetas) ni con `^`, `~` (fuera del principio), `#`, `<` o `>`,
 * que zsh puede leer como parte del comodín.
 */
function comodinSimple(w) {
  const s = String(w);
  if (!/[*?[\]]/.test(s)) return true;
  return !/\*\*|[\^#<>]/.test(s) && !/.~/.test(s);
}

/**
 * Lo que un `sed` en el lugar dejaría en ese archivo, sin escribirlo: el mismo `sed` con sus guiones, leyendo el texto
 * por la entrada. null si no se pudo correr.
 */
function ensayarSeds(abs, seds) {
  let texto;
  try { texto = fs.readFileSync(abs, 'utf8'); } catch (e) { logHookError(e); return null; }
  for (const s of seds) {
    const r = require('child_process').spawnSync(s.sed, [...s.opciones, ...s.guiones.flatMap((g) => ['-e', g])],
      { windowsHide: true, input: texto, encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'] });
    if (r.error || r.status !== 0) return null;
    texto = r.stdout;
  }
  return texto;
}

/** Los `status:` del encabezado de una historia, en orden (vacío sin encabezado). */
function estadosDelEncabezado(texto) {
  const fm = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(String(texto));
  return fm ? [...fm[1].matchAll(/^["']?status["']?\s*:\s*["']?([\w-]+)/gm)].map((m) => m[1].toLowerCase()) : [];
}
// sin ninguna forma de escribir (ni un editor en el lugar), el comando no toca una historia. Un `open(` cuenta sólo si
// puede escribir: uno que lee (`open(p)`, `open(p, 'rb')`) no hace de un `for` que lee una escritura
const FORMAS_DE_ESCRIBIR_RE = new RegExp(FORMAS_DE_ESCRIBIR.join('|'), 'i');
const ESCRIBE = { test: (t) => FORMAS_DE_ESCRIBIR_RE.test(t) || algunOpenEscribe(t) };
/** El nombre de un comando: sin su ruta (`/bin/mv`), sin la barra que saltea un alias (`\mv`) y sin `.exe`. */
const nombreDeComando = (w) => path.basename(String(w || '').replace(/^\\/, '')).toLowerCase().replace(/\.exe$/, '');

// los comandos que un `xargs` puede correr en la carpeta de las constancias sin escribir nada
const LECTORES_DE_XARGS = new Set(['cat', 'grep', 'egrep', 'fgrep', 'rg', 'head', 'tail', 'wc', 'ls', 'stat', 'file', 'jq',
  'sha1sum', 'sha256sum', 'shasum', 'md5', 'md5sum', 'echo', 'printf']);
// lo que puede ir delante de un `env` sin cambiar qué corre: un paréntesis, `sudo` y sus opciones, una variable, …
const ANTES_DEL_ENV = /^(?:\(*|\{|nohup|command|exec|time|builtin|[A-Za-z_]\w*=.*)$/;
// los envoltorios con opciones que llevan valor: cuál lleva valor en la palabra siguiente
const ENVOLTORIOS_CON_VALOR = {
  sudo: /^-[ugCDhprtU]$|^--(?:user|group|close-from|chdir|host|prompt|role|type|other-user)$/,
  nice: /^-n$|^--adjustment$/,
  timeout: /^-[sk]$|^--(?:signal|kill-after)$/,
  stdbuf: /^-[ioe]$|^--(?:input|output|error)$/,
  nohup: /^$/,
};

/**
 * El tramo sin su `env` (también por su ruta, `/usr/bin/env`) y sin sus opciones, sus variables y su carpeta:
 * `{ carpetas, resto }`, con `resto` desde el comando que corre y `carpetas` las de `-C`/`--chdir`, con sus comillas
 * resueltas. `-u`/`--unset` llevan valor. Con `-S` (el comando en un texto) o sin `env`, el tramo queda como está; con
 * `-S`, además, `partida` es la orden que corre.
 */
function pelarEnv(tramo) {
  const t = String(tramo);
  const piezas = [...t.matchAll(/(?:'[^']*'|"(?:\\.|[^"\\])*"|\\.|[^\s'"\\])+/g)];
  const palabra = (k) => palabraDelShell(piezas[k][0]);
  let k = 0;
  while (k < piezas.length && path.basename(palabra(k).replace(/^\(+/, '')) !== 'env') {
    const w = path.basename(palabra(k).replace(/^\(+/, ''));
    const valor = ENVOLTORIOS_CON_VALOR[w];
    if (!valor) { if (!ANTES_DEL_ENV.test(palabra(k))) break; k++; continue; }
    // un envoltorio y sus opciones; las que llevan valor, con él; `timeout` lleva además la duración
    k++;
    while (k < piezas.length && palabra(k).startsWith('-')) k += valor.test(palabra(k)) ? 2 : 1;
    if (w === 'timeout') k++;
  }
  if (k >= piezas.length || path.basename(palabra(k).replace(/^\(+/, '')) !== 'env') return { carpetas: [], resto: t };
  const carpetas = [];
  let j = k + 1;
  while (j < piezas.length) {
    const w = palabra(j);
    let m;
    if (/^[A-Za-z_]\w*=/.test(w)) { j++; continue; }
    if (w === '--') { j++; break; }
    // `-S` lleva la orden en su valor, pegado (`-S"…"`, `--split-string=…`) o en la palabra siguiente: el tramo queda
    // como está y la orden de adentro va en `partida`, para mirarla como un comando anidado
    if ((m = /^-[iv0]*S(.*)$|^--split-string(?:=(.*))?$/s.exec(w))) {
      const pegada = m[1] !== undefined ? m[1] : m[2];
      const valor = pegada !== undefined && pegada !== '' ? pegada : (j + 1 < piezas.length ? palabra(j + 1) : '');
      const siguiente = pegada !== undefined && pegada !== '' ? j + 1 : j + 2;
      const cola = siguiente < piezas.length ? ` ${t.slice(piezas[siguiente].index)}` : '';
      return { carpetas, resto: t, partida: `${valor}${cola}`.trim() || null };
    }
    if (/^-[iv0]*C$|^--chdir$/.test(w)) { if (j + 1 < piezas.length) carpetas.push(palabra(j + 1)); j += 2; continue; }
    if ((m = /^-[iv0]*C(.+)$|^--chdir=(.*)$/.exec(w))) { carpetas.push(m[1] ?? m[2]); j++; continue; }
    if (/^-[iv0]*[uPa]$|^--(?:unset|argv0)$/.test(w)) { j += 2; continue; }
    if (w.startsWith('-')) { j++; continue; }
    break;
  }
  return { carpetas, resto: j < piezas.length ? t.slice(piezas[j].index) : '' };
}

// el tope de carpetas contra las que se miran las rutas relativas de un comando con muchos `cd`
const TOPE_DE_CARPETAS_DE_CD = 24;

// una palabra del shell entera: comillas pegadas a texto, escapes y texto suelto, hasta un blanco o un operador
const PALABRA_ENTERA = /(?:'[^']*'|"(?:\\.|[^"\\])*"|\\.|[^\s'"|;&<>\\])+/g;

/** Las palabras del tramo, cada una entera y con sus comillas resueltas (`.tycon/'control-changes.jsonl'` es una). */
function palabrasEnteras(tramo) {
  return (String(tramo).match(PALABRA_ENTERA) || []).map((w) => sinCierreDeGrupo(palabraDelShell(w)));
}

/** La palabra sin los `)` que cierran un paréntesis abierto antes (`(cd d && touch f)` toca `f`), si ella no abre uno. */
function sinCierreDeGrupo(w) {
  return String(w).includes('(') ? String(w) : String(w).replace(/\)+$/, '');
}

/**
 * El destino y los orígenes de una copia:el de `-t`/`--target-directory` (siempre una carpeta, en los comandos donde
 * `-t` es eso: en `rsync` es otra cosa), o el último argumento.
 */
function destinoDeLaCopia(args, conT) {
  let t = null;
  const sueltos = [];
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (w === '--target-directory' || (conT && w === '-t')) { t = args[++i]; continue; }
    const pegado = conT ? /^(?:--target-directory=|-t)(.+)$/.exec(w) : /^--target-directory=(.+)$/.exec(w);
    if (pegado) { t = pegado[1]; continue; }
    if (w.startsWith('-') || w.startsWith('<')) continue;
    sueltos.push(w);
  }
  if (t) return { destino: t, origenes: sueltos, carpeta: true };
  if (sueltos.length < 2) return null;
  return { destino: sueltos[sueltos.length - 1], origenes: sueltos.slice(0, -1), carpeta: false };
}

/**
 * Los argumentos que no son opciones, sin el valor de las opciones que lo llevan aparte (`conValor`). `-` (la entrada
 * estándar) cuenta como uno, y después de `--` cuentan todos.
 */
function posicionales(args, conValor) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (w === '--') { out.push(...args.slice(i + 1)); break; }
    if (w === '-' || !w.startsWith('-')) { out.push(w); continue; }
    if (conValor.test(w)) i++;
  }
  return out;
}

/** Una palabra del shell con sus comillas y sus escapes resueltos: `.tycon/'control-changes.jsonl'` es una sola ruta. */
function palabraDelShell(w) {
  return String(w).replace(/'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.)/g, (m, simple, doble, escapado) => (simple !== undefined ? simple
    : doble !== undefined ? doble.replace(/\\(["\\$`])/g, '$1') : escapado));
}

/** Los archivos de parche de un `patch`: el de `-i`/`--input`, o el segundo argumento suelto (el primero es el que se parcha). */
function parchesDePatch(args) {
  const out = [];
  const sueltos = [];
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (w === '-i' || w === '--input') { if (args[i + 1]) out.push(args[++i]); continue; }
    const pegado = /^(?:--input=|-i)(.+)$/.exec(w);
    if (pegado) { out.push(pegado[1]); continue; }
    // las opciones de `patch` que llevan su valor aparte no son el archivo a parchar
    if (/^-[pdoDrBVYzFgx]$/.test(w)) { i++; continue; }
    if (!w.startsWith('-') && !w.startsWith('<')) sueltos.push(w);
  }
  if (sueltos.length >= 2) out.push(sueltos[1]);
  return out;
}

/** ¿El texto de un parche nombra una constancia? Con las rutas que git escribe entre comillas y con escapes octales. */
function parcheNombraConstancia(texto, isControlApproval) {
  const t = String(texto).replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
  if (/control-changes|exemptions\.jsonl/i.test(t)) return true;
  const rutas = [];
  for (const linea of t.split(/\r?\n/)) {
    let m = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(linea);
    if (m) { rutas.push(m[1], m[2]); continue; }
    m = /^(?:\+\+\+|---)\s+"?(?:[ab]\/)?([^"\t]+)"?/.exec(linea) || /^(?:rename|copy) (?:from|to) (.+)$/.exec(linea);
    if (m) rutas.push(m[1].trim());
  }
  return rutas.some((r) => isControlApproval(r));
}

/**
 * Las constancias que un comando de git trae de otra ref al árbol, al índice o a la historia de una rama, con el motivo:
 * `merge`, `reset`, `cherry-pick`, `revert`, `read-tree`, `rebase` (también lo que corre con `-x` y la lista de tareas
 * de un `--continue`), `pull`, `stash apply|pop|branch`, el cambio de rama con constancias sin commitear, y lo que mueve
 * una rama por fuera (`branch -f|-M|-C`, `update-ref`, `fetch . a:b`, `push . a:b`). Las que la rama principal del
 * remoto ya tiene iguales pasan, porque llegaron por un pedido; esa rama vale sólo si su copia la escribió git al bajarla
 * (su registro), y por eso escribir a mano las copias del remoto o cambiar a dónde apunta `origin` no pasa. Si git no
 * contesta, la ref no se pudo mirar y no pasa. Fuera de alcance: editar a mano los archivos de `.git`.
 * `extra.tramo`: el tramo entero, con lo de antes del comando · `extra.anidado(cmd)`: lo mismo para un comando adentro.
 */
/**
 * ¿El repo de `carpeta` ya tiene, o tuvo, un remoto `origin`? true o false; null si git no contestó. Lo tuvo si quedan
 * sus copias (`refs/remotes/origin/…`): sacado editando .git/config a mano, `add` lo pondría a apuntar a otro lado. Una
 * carpeta que no existe o que todavía no es un repo (el `git init` del mismo comando) no lo tiene.
 */
function yaHayOrigin(carpeta) {
  if (!fs.existsSync(carpeta)) return false;
  // git en inglés: su error se reconoce por el texto. Sin la biblioteca no se sabe, y el freno frena
  let env;
  try { env = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'clean-git-env.js')).idiomaFijo(); } catch (_) { return null; }
  const git = (argv) => require('child_process').spawnSync('git', ['-C', carpeta, ...argv], {
    windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, env,
  });
  const r = git(['remote']);
  if (r.error || r.status !== 0) return !r.error && /not a git repository/i.test(String(r.stderr)) ? false : null;
  if (String(r.stdout).split(/\r?\n/).includes('origin')) return true;
  const copias = git(['for-each-ref', '--count=1', '--format=%(refname)', 'refs/remotes/origin/']);
  if (copias.error || copias.status !== 0) return null;
  return String(copias.stdout).trim() !== '';
}

// las acciones de `git config` que cambian la configuración, en su forma de opción
const ACCIONES_QUE_ESCRIBEN_CONFIG = /^--(?:add|replace-all|unset|unset-all|remove-section|rename-section|edit)$|^-e$/;

/**
 * Cómo se usa `git config`, de sus argumentos: `{ sueltos, sub, clave, lee, quita }`. `sueltos` son las palabras sin las
 * opciones ni sus valores (`--file .git/config`); `sub`, el subcomando si lo hay (`get`, `set`, `remove-section`…);
 * `lee`, si es `get`/`list` o `--get*`/`--list`; `quita`, si es `unset`.
 */
function formaDeGitConfig(args) {
  const sueltos = [];
  for (let i = 0; i < args.length; i++) {
    if (/^(?:-f|--file|--blob|-t|--type|--default|--comment|--value)$/.test(args[i])) { i++; continue; }
    if (!args[i].startsWith('-')) sueltos.push(args[i]);
  }
  // la forma con subcomando (`git config set|unset|remove-section|rename-section <clave>`) y la de opciones
  const sub = /^(?:get|list|set|unset|remove-section|rename-section)$/.test(sueltos[0] || '') ? sueltos[0] : null;
  const clave = sub ? sueltos[1] : sueltos[0];
  const lee = sub ? /^(?:get|list)$/.test(sub) : args.some((w) => /^--(?:get|get-all|get-regexp|list)$|^-l$/.test(w));
  const quita = sub ? sub === 'unset' : args.some((w) => /^--(?:unset|unset-all)$/.test(w));
  return { sueltos, sub, clave, lee, quita };
}

function constanciasDeOtraRama(c, args, base, isControlApproval, extra = {}) {
  const { spawnSync } = require('child_process');
  const git = (argv) => {
    const r = spawnSync('git', ['-C', base, ...argv], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return r.error || r.status !== 0 ? null : String(r.stdout);
  };
  const tramo = String(extra.tramo || '');
  const anidado = extra.anidado || (() => []);
  const commit = (ref) => (git(['rev-parse', '--verify', '-q', '--end-of-options', `${ref}^{commit}`]) || '').trim() || null;
  const out = [];
  // la rama principal del remoto, si su copia la escribió git al bajarla (fetch, pull o push); una copia sin registro
  // (recién clonada, o escrita a mano) no prueba nada hasta el próximo `git fetch`
  const principal = (() => {
    for (const r of ['refs/remotes/origin/main', 'refs/remotes/origin/master']) {
      const sha = commit(r);
      if (!sha) continue;
      const ultimo = (git(['reflog', 'show', '-n1', '--format=%H%x09%gs', r]) || '').trim().split('\t');
      return ultimo[0] === sha && /^(?:fetch|pull|update by push)\b/.test(ultimo[1] || '') ? sha : null;
    }
    return null;
  })();
  const blob = (ref, p) => (git(['rev-parse', '--verify', '-q', `${ref}:${p}`]) || '').trim() || null;
  // las rutas de constancias que quedan distintas al pasar de `desde` a `hasta`, salvo las que se borran
  const comparar = (desde, hasta, nombre, rutas = []) => {
    if (/^-/.test(desde) || /^-/.test(hasta)) { out.push(`no pude ver qué constancias trae ${nombre}`); return; }
    const r = git(['diff', '--name-only', '--no-renames', '--diff-filter=d', '--end-of-options', desde, hasta, ...(rutas.length ? ['--', ...rutas] : [])]);
    if (r === null) { out.push(`no pude ver qué constancias trae ${nombre}${principal ? '' : ' (la rama principal no está confirmada: git fetch)'}`); return; }
    for (const p of r.split(/\r?\n/).filter(Boolean).filter((x) => isControlApproval(x))) {
      const traida = blob(hasta, p);
      if (principal && traida && blob(principal, p) === traida) continue;
      out.push(`${p} desde ${nombre}${principal ? '' : ' (la rama principal no está confirmada: corré git fetch)'}`);
    }
  };
  const fusion = (ref, desde = 'HEAD') => {
    const mb = (git(['merge-base', '--end-of-options', desde, ref]) || '').trim() || null;
    if (!mb) { out.push(`no pude ver qué constancias trae ${ref}`); return; }
    comparar(mb, ref, ref);
  };
  // mover la rama `nombre` (o crearla) a `ref`: lo que trae es lo que cambia en su historia
  const mover = (nombre, ref) => {
    if (/^refs\/remotes\//.test(nombre)) { out.push(`${nombre}: la copia del remoto la escribe git fetch, no a mano`); return; }
    if (!commit(ref)) { out.push(`no pude ver qué constancias trae ${ref}`); return; }
    const antes = commit(nombre) || commit(/^refs\//.test(nombre) ? nombre : `refs/heads/${nombre}`);
    if (antes) comparar(antes, ref, ref); else fusion(ref);
  };
  const config = c === 'git config' ? formaDeGitConfig(args) : null;
  // `-c remote.origin.url=…` o `GIT_CONFIG_*` en el tramo: lo que se baja ya no es del remoto. Un `git config` que sólo
  // lee (`--get remote.origin.url`) no cambia a dónde apunta, aunque lo nombre
  const soloLee = config && config.lee && !args.some((w) => ACCIONES_QUE_ESCRIBEN_CONFIG.test(w));
  if (!soloLee && /\bremote\.origin\.(?:url|fetch|pushurl)\b|\bGIT_CONFIG_(?:PARAMETERS|COUNT|KEY_\d+)=/i.test(tramo) && ['git fetch', 'git pull', 'git remote', 'git config'].includes(c)) {
    out.push('cambiar a dónde apunta origin deja de probar qué está en la rama principal');
    return out;
  }
  if (config) {
    const { sueltos, sub, clave, lee, quita } = config;
    const pone = !lee && !quita && (sub ? sub === 'set' : sueltos.length >= 2) && /^remote\.origin\./i.test(clave || '');
    // borrar la sección de origin, o renombrarla (desde o hacia origin), también cuenta: sin origin, después
    // `git remote add origin` lo pone a apuntar a otro lado
    const seccion = sub ? /^(?:remove-section|rename-section)$/.test(sub) : args.some((w) => /^--(?:remove-section|rename-section)$/.test(w));
    const nombres = sub ? sueltos.slice(1, 3) : sueltos.slice(0, 2);
    // con una opción que no conozco antes del subcomando, la palabra del subcomando vale donde esté
    const suelta = sueltos.findIndex((w) => /^(?:remove-section|rename-section)$/.test(w));
    const deOrigin = (ns) => ns.some((n) => /^remote\.origin$/i.test(n));
    if (pone || (seccion && deOrigin(nombres)) || (suelta >= 0 && deOrigin(sueltos.slice(suelta + 1, suelta + 3)))) out.push('cambiar a dónde apunta origin deja de probar qué está en la rama principal');
    return out;
  }
  if (c === 'git remote') {
    const sub = args.find((w) => !w.startsWith('-'));
    const resto = args.slice(args.indexOf(sub) + 1).filter((w) => !w.startsWith('-'));
    const automatico = args.some((w) => /^(?:-a|--auto|-d|--delete)$/.test(w));
    // `add origin` en un repo sin origin no cambia a dónde apunta: no apuntaba a ningún lado. Como sacar origin frena
    // (`remove`, `rename origin …`, `git config`), un repo sin origin no lo tuvo, o lo perdió editando .git a mano.
    const nuevo = sub === 'add' && resto[0] === 'origin' && yaHayOrigin(base) === false;
    if ((/^(?:set-url|add|remove|rm)$/.test(sub || '') && resto[0] === 'origin' && !nuevo) || (sub === 'rename' && (resto[0] === 'origin' || resto[1] === 'origin')) || (sub === 'set-head' && resto[0] === 'origin' && !automatico)) {
      out.push('cambiar a dónde apunta origin deja de probar qué está en la rama principal');
    }
    return out;
  }
  // retomar: la lista de tareas que queda se mira como si se corriera ahora; abandonar o saltear no trae nada
  if (args.some((w) => /^--(?:abort|quit|skip|edit-todo|show-current-patch)$/.test(w))) return out;
  if (args.includes('--continue')) {
    if (c === 'git rebase') {
      const dir = ['rebase-merge', 'rebase-apply'].map((d) => (git(['rev-parse', '--git-path', d]) || '').trim()).map((d) => (d && !path.isAbsolute(d) ? path.join(base, d) : d)).find((d) => d && fs.existsSync(d));
      if (!dir) return out;
      let lista = '';
      try { lista = fs.readFileSync(path.join(dir, 'git-rebase-todo'), 'utf8'); } catch (_) { return out; }
      let propia = '';
      try { propia = fs.readFileSync(path.join(dir, 'orig-head'), 'utf8').trim(); } catch (_) { /* sin la punta de antes, todo commit se mira */ }
      for (const linea of lista.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) {
        const m = /^(?:p|pick|r|reword|e|edit|s|squash|f|fixup)\s+(?:-[Cc]\s+)?(\S+)/.exec(linea);
        const x = /^(?:x|exec)\s+(.+)$/.exec(linea);
        if (x) { out.push(...anidado(x[1])); continue; }
        if (m) {
          // los commits de la rama que se rebasa ya están en ella; uno de afuera, agregado a la lista, se mira
          if (propia && git(['merge-base', '--is-ancestor', '--end-of-options', m[1], propia]) !== null) continue;
          comparar(`${m[1]}^`, m[1], m[1]);
        } else if (!/^(?:d|drop|b|break|l|label|t|reset|u|update-ref|noop)\b/.test(linea)) out.push(`la lista de tareas tiene «${linea.slice(0, 60)}»: no pude ver qué trae`);
      }
    } else if (c === 'git cherry-pick' || c === 'git revert') {
      let lista = '';
      try { lista = fs.readFileSync((p => (path.isAbsolute(p) ? p : path.join(base, p)))((git(['rev-parse', '--git-path', 'sequencer/todo']) || '').trim()), 'utf8'); } catch (_) { return out; }
      for (const linea of lista.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) {
        const m = /^(pick|revert|p)\s+(\S+)/.exec(linea);
        if (!m) { out.push(`la lista de tareas tiene «${linea.slice(0, 60)}»: no pude ver qué trae`); continue; }
        if (m[1] === 'revert') comparar(m[2], `${m[2]}^`, m[2]); else comparar(`${m[2]}^`, m[2], m[2]);
      }
    }
    return out;
  }
  // las opciones que llevan su valor en la palabra siguiente, para no tomarlo por una ref; una que no está acá y se lleva
  // el valor deja una palabra de más, que se mira como ref y, si no lo es, no pasa: frena de más, nunca de menos
  const conValor = {
    'git merge': /^(?:-m|-F|-s|-X|--message|--file|--strategy|--strategy-option|--into-name)$/,
    'git cherry-pick': /^(?:-X|--strategy|--strategy-option)$/,
    'git revert': /^(?:-X|--strategy|--strategy-option)$/,
    'git rebase': /^(?:-s|-X|--strategy|--strategy-option)$/,
    'git pull': /^(?:-s|-X|--strategy|--strategy-option|--depth|--deepen|--shallow-since|--shallow-exclude|-j|--jobs|-o|--server-option|--upload-pack|--negotiation-tip|--refmap|--recurse-submodules)$/,
    'git fetch': /^(?:--depth|--deepen|--shallow-since|--shallow-exclude|-j|--jobs|-o|--server-option|--upload-pack|--negotiation-tip|--refmap|--recurse-submodules)$/,
    'git push': /^(?:-o|--push-option|--receive-pack|--exec|--repo)$/,
    'git switch': /^(?:-c|-C|--create|--force-create|--orphan)$/,
    'git checkout': /^(?:-b|-B|--orphan)$/,
    'git branch': /^(?:-u|--set-upstream-to|--contains|--no-contains|--merged|--no-merged|--points-at|--sort|--format)$/,
    'git update-ref': /^-m$/,
    'git symbolic-ref': /^-m$/,
  }[c] || /^$/;
  const sueltas = [];
  const rutas = [];
  let onto = null;
  let padre = 1;
  const execs = [];
  const creada = [];
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (w === '--') {
      // en reset lo de después son rutas; en los otros, todavía refs
      if (c === 'git reset' || c === 'git checkout') { rutas.push(...args.slice(i + 1)); break; }
      sueltas.push(...args.slice(i + 1)); break;
    }
    if (c === 'git rebase' && w === '--onto') { onto = args[++i]; continue; }
    if (c === 'git rebase' && /^--onto=/.test(w)) { onto = w.slice(7); continue; }
    if (c === 'git rebase' && /^(?:-x|--exec)$/.test(w)) { execs.push(args[++i] || ''); continue; }
    if (c === 'git rebase' && /^(?:--exec=|-x.)/.test(w)) { execs.push(w.replace(/^(?:--exec=|-x)/, '')); continue; }
    if ((c === 'git cherry-pick' || c === 'git revert') && /^(?:-m|--mainline)$/.test(w)) { padre = Number(args[++i]) || 0; continue; }
    if ((c === 'git cherry-pick' || c === 'git revert') && /^(?:-m\d+|--mainline=\d+)$/.test(w)) { padre = Number(w.replace(/\D/g, '')); continue; }
    if ((c === 'git switch' && /^(?:-c|-C|--create|--force-create|--orphan)$/.test(w)) || (c === 'git checkout' && /^(?:-b|-B|--orphan)$/.test(w))) { creada.push(args[++i]); continue; }
    if (conValor.test(w)) { i++; continue; }
    // `-` es la rama de antes
    if (w === '-' && c !== 'git stash') { sueltas.push('@{-1}'); continue; }
    if (!w.startsWith('-')) sueltas.push(w);
  }
  // lo que no se ve en la línea: las refs por la entrada estándar, o rutas puestas bajo otro prefijo
  if ((c === 'git cherry-pick' || c === 'git revert' || c === 'git update-ref') && args.includes('--stdin')) { out.push('las refs vienen por la entrada estándar: no pude ver qué trae'); return out; }
  if (c === 'git read-tree' && args.some((w) => /^--prefix(?:=|$)/.test(w))) { out.push('con --prefix las rutas quedan en otra carpeta: no pude ver qué constancias trae'); return out; }
  for (const e of execs) out.push(...anidado(e));
  if (c === 'git merge') {
    for (const ref of sueltas.length ? sueltas : ['@{upstream}']) fusion(ref);
  } else if (c === 'git rebase') {
    // la rama queda encima de la de arriba y trae todo lo que esa tiene; con `<arriba> <rama>`, se rebasa esa rama
    if (args.some((w) => /^(?:-i|--interactive)$/.test(w) || /^-[A-Za-z]*i[A-Za-z]*$/.test(w))) {
      const editor = /(?:\bGIT_SEQUENCE_EDITOR=|\bsequence\.editor=)(['"]?)([^'"\s]*)\1/.exec(tramo);
      const configurado = (git(['config', '--get', 'sequence.editor']) || '').trim();
      const quieto = (v) => /^(?::|true|cat)$/.test(v);
      if ((editor && !quieto(editor[2])) || (!editor && configurado && !quieto(configurado))) out.push('el editor de la lista de tareas puede agregar cualquier commit: no pude ver qué trae');
    }
    fusion(onto || sueltas[0] || '@{upstream}', sueltas[1] || 'HEAD');
  } else if (c === 'git pull') {
    // `.` es este repo y se mira la rama tal cual; de un remoto, lo que trae se baja recién al correr: sólo pasa su rama
    // principal (entró por un pedido), mirada en la copia; cualquier otra, primero `git fetch` y después `git merge`
    const remotos = (git(['remote']) || '').split(/\r?\n/).filter(Boolean);
    const remoto = sueltas.length && (sueltas[0] === '.' || remotos.includes(sueltas[0])) ? sueltas[0] : sueltas.length ? '?' : null;
    const refs = (remoto ? sueltas.slice(1) : sueltas).map((r) => r.replace(/^\+/, '').replace(/:.*$/, '').replace(/^refs\/heads\//, ''));
    const arriba = refs.length ? null : (git(['rev-parse', '--symbolic-full-name', '@{upstream}']) || '').trim();
    const destino = remoto === '.' ? refs : refs.length ? refs.map((r) => `refs/remotes/${remoto}/${r}`) : remoto === '?' ? [`refs/remotes/?/${sueltas[0]}`] : [arriba || '@{upstream}'];
    for (const ref of destino) {
      const local = /^refs\/heads\//.test(ref) || remoto === '.';
      const esPrincipal = /^refs\/remotes\/origin\/(?:main|master)$/.test(ref) && remoto !== '?';
      if (!local && !esPrincipal) { out.push(`${ref.replace(/^refs\/remotes\//, '')} se baja recién al correr: traela con git fetch y git merge, que el freno puede mirar`); continue; }
      if (!commit(ref)) { out.push(`no pude ver qué constancias trae ${ref}: traela con git fetch y git merge, que el freno puede mirar`); continue; }
      fusion(ref);
    }
  } else if (c === 'git reset') {
    // cualquier forma mueve la rama, el índice o el árbol a lo de la ref; con rutas, sólo esas
    const ref = sueltas[0];
    if (ref && commit(ref)) comparar('HEAD', ref, ref, rutas);
    else if (ref && args.includes('--')) out.push(`no pude ver qué constancias trae ${ref}`);
  } else if (c === 'git cherry-pick' || c === 'git revert') {
    for (const s of sueltas) {
      const rango = /^(.+?)\.\.\.?(.+)$/.exec(s);
      // un rango: lo que agrega de A a B (cherry-pick), o lo que deshace, que vuelve (revert: de B a A)
      if (rango) { if (c === 'git cherry-pick') comparar(rango[1], rango[2], s); else comparar(rango[2], rango[1], s); continue; }
      // un commit contra el padre que se elige (`-m N`, el primero si no se dice)
      const p = `${s}^${padre || 1}`;
      if (c === 'git cherry-pick') comparar(p, s, s); else comparar(s, p, s);
    }
  } else if (c === 'git read-tree') {
    for (const s of sueltas) comparar('HEAD', s, s);
  } else if (c === 'git stash') {
    // lo guardado vuelve al árbol de la rama de ahora
    const sub = sueltas[0] || 'push';
    if (sub === 'apply' || sub === 'pop') comparar('HEAD', sueltas[1] || 'stash@{0}', sueltas[1] || 'stash@{0}');
    else if (sub === 'branch') comparar('HEAD', sueltas[2] || 'stash@{0}', sueltas[2] || 'stash@{0}');
  } else if (c === 'git switch' || c === 'git checkout') {
    // cambiar de rama lleva lo que no está commiteado: una constancia suelta pasaría a la otra rama
    if (rutas.length || (c === 'git checkout' && args.includes('--'))) return out;
    const destino = creada.length ? (sueltas[0] || 'HEAD') : sueltas[0];
    const sha = destino ? commit(destino) : null;
    if (!sha || sha === commit('HEAD')) return out;
    const sueltasDelArbol = [...(git(['diff', '--name-only', '--no-renames', 'HEAD']) || '').split(/\r?\n/), ...(git(['ls-files', '--others', '--exclude-standard']) || '').split(/\r?\n/)]
      .filter(Boolean).filter((p) => isControlApproval(p));
    for (const p of [...new Set(sueltasDelArbol)]) {
      const ahora = (git(['hash-object', '--', p]) || '').trim() || null;
      if (ahora && (blob(sha, p) === ahora || (principal && blob(principal, p) === ahora))) continue;
      if (!ahora && !blob(sha, p)) continue;
      out.push(`${p} sin commitear pasa a ${destino}`);
    }
  } else if (c === 'git branch') {
    // `-f <rama> <ref>` la mueve; `-M|-C <vieja> <nueva>` pone la vieja en el lugar de la nueva
    if (args.some((w) => /^(?:-f|--force)$/.test(w) || /^-[A-Za-z]*f[A-Za-z]*$/.test(w)) && !args.some((w) => /^(?:-[dDmMcC]|--delete|--move|--copy)$/.test(w)) && sueltas.length >= 2) mover(sueltas[0], sueltas[1]);
    else if (args.some((w) => /^(?:-M|-C)$/.test(w) || (/^(?:-m|-c|--move|--copy)$/.test(w) && args.some((x) => /^(?:-f|--force)$/.test(x)))) && sueltas.length >= 2) mover(sueltas[1], sueltas[0]);
  } else if (c === 'git update-ref') {
    if (args.some((w) => /^(?:-d|--delete)$/.test(w))) return out;
    if (sueltas.length >= 2) mover(sueltas[0], sueltas[1]);
  } else if (c === 'git symbolic-ref') {
    if (args.some((w) => /^(?:-d|--delete)$/.test(w)) || sueltas.length < 2) return out;
    if (/^refs\/remotes\//.test(sueltas[0])) out.push(`${sueltas[0]}: la copia del remoto la escribe git fetch, no a mano`);
  } else if (c === 'git fetch' || c === 'git push') {
    // con un destino explícito (`a:b`): de este repo (`.`) se mira como mover b a a; a la copia del remoto sólo llega lo
    // que el mismo remoto tiene con ese nombre; a una rama local, desde un remoto, no se ve antes de bajar
    const remotos = (git(['remote']) || '').split(/\r?\n/).filter(Boolean);
    const remoto = sueltas[0] || null;
    for (const spec of sueltas.slice(1).filter((s) => s.includes(':')).map((s) => s.replace(/^\+/, ''))) {
      const [src, dst] = spec.split(':');
      if (!dst) continue;
      if (c === 'git push' && remoto !== '.') continue;
      const dstRef = /^refs\//.test(dst) ? dst : `refs/heads/${dst}`;
      if (remoto === '.') { mover(dstRef, src); continue; }
      const enCopia = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(dstRef);
      if (enCopia) {
        const mismo = enCopia[1] === remoto && remotos.includes(remoto) && (src.replace(/^refs\/heads\//, '') === enCopia[2]);
        if (!mismo) out.push(`${dstRef}: la copia del remoto la escribe git fetch desde ese remoto y con ese nombre`);
        continue;
      }
      out.push(`${dstRef} se baja recién al correr: traela con git fetch y git merge, que el freno puede mirar`);
    }
  }
  return out;
}

/** El archivo que lee un `tar` (`-f x`, `-xzf x`, `-fx`, `--file=x`, `xzf x`), o null si lee la entrada estándar. */
function archivoDeTar(args) {
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (w === '--file' || w === '-f') return args[i + 1] && args[i + 1] !== '-' ? args[i + 1] : null;
    let m = /^--file=(.+)$/.exec(w);
    if (m) return m[1] === '-' ? null : m[1];
    // en un grupo de letras, la `f` se lleva lo que sigue pegado o la palabra siguiente
    m = /^-[A-Za-z]*f(.*)$/.exec(w);
    if (m && !w.startsWith('--')) { const a = m[1] || args[i + 1]; return a && a !== '-' ? a : null; }
    if (i === 0 && /^[A-Za-z]*f[A-Za-z]*$/.test(w)) return args[1] && args[1] !== '-' ? args[1] : null;
  }
  return null;
}

/**
 * Las rutas que trae un archivo que `tar`, `unzip` o `cpio` va a abrir, listadas antes con la misma herramienta; null
 * si no se pueden ver (por la entrada estándar, un archivo que no existe, la herramienta que falla o tarda).
 */
function contenidoDelArchivo(c, args, tramo, abs) {
  const { spawnSync } = require('child_process');
  const correr = (bin, argv, input) => {
    const r = spawnSync(bin, argv, { windowsHide: true, input, encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 32 * 1024 * 1024 });
    return r.error || r.status !== 0 ? null : String(r.stdout).split(/\r?\n/).filter(Boolean);
  };
  if (c === 'cpio') {
    const entrada = /(?<!<)<(?!<)\s*([^\s<>;&|]+)/.exec(tramo);
    if (!entrada) return null;
    let datos;
    try { datos = fs.readFileSync(abs(entrada[1])); } catch (_) { return null; }
    return correr('cpio', ['-it'], datos);
  }
  if (c === 'unzip') {
    const i = args.findIndex((w, k) => !w.startsWith('-') && args[k - 1] !== '-d');
    if (i < 0 || !fs.existsSync(abs(args[i]))) return null;
    return correr('unzip', ['-Z1', abs(args[i])]);
  }
  const archivo = archivoDeTar(args);
  if (!archivo || !fs.existsSync(abs(archivo))) return null;
  return correr(c, ['-tf', abs(archivo)]);
}

/** Lo que se llama como una constancia adentro de una carpeta, en rutas relativas; null si no se pudo revisar entera. */
function nombresDeConstancia(dir, tope = 20000) {
  const out = [];
  const pendientes = [''];
  let vistos = 0;
  while (pendientes.length) {
    const rel = pendientes.shift();
    let entradas;
    try { entradas = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch (_) { return null; }
    for (const e of entradas) {
      if (++vistos > tope) return null;
      const r = path.join(rel, e.name);
      if (/^control-changes|^exemptions\.jsonl$/i.test(e.name)) out.push(r);
      let carpeta = e.isDirectory();
      // un enlace a una carpeta se sigue (`cp -L`, `rsync -L`); el tope corta un enlace que vuelve sobre sí
      if (e.isSymbolicLink()) { try { carpeta = fs.statSync(path.join(dir, r)).isDirectory(); } catch (_) { carpeta = false; } }
      if (carpeta && e.name !== '.git') pendientes.push(r);
    }
  }
  return out;
}

// lo que el shell pone delante de un comando sin cambiar cuál corre: `{`, `then`, `do`, `!`, `xargs` con sus opciones
const PALABRA_DEL_SHELL = /^(?:(?:\{|then|do|else|elif|if|while|until|!|time)\s+|xargs\s+(?:(?:-[InLPdEs]\s+\S+|-\S+)\s+)*)/;

/** El tramo sin sus prefijos ni las palabras del shell que van delante del comando. */
function sinPalabrasDelShell(tramo) {
  let t = String(tramo).trim();
  for (;;) {
    const n = t.replace(PREFIJO, '').replace(PALABRA_DEL_SHELL, '').trim();
    if (n === t) return t;
    t = n;
  }
}

/**
 * El tramo sin sus redirecciones de salida (`2>&1`, `> f`, `>> f`, `&> f`, `2> f`), que no son argumentos. Un `>` entre
 * comillas o escapado es texto, y `>(…)` lleva un comando: quedan como están.
 */
function sinRedireccionesDeSalida(tramo) {
  const s = String(tramo);
  const es = posicionesDeComando(s);
  // el destino es la palabra entera del shell: con comillas pegadas a texto (`>'a'a`) o con una sustitución (`> $(date).log`)
  return s.replace(/(?:(?<![^\s])\d+|&)?(?<!\\)>>?(?!\()[|&]?[ \t]*(?:\$\([^()]*\)|'[^']*'|"[^"]*"|[^\s'"|;&<>]+)*/g, (m, en) => (es[en] ? ' ' : m));
}

// un heredoc entero: lo que tiene delante en su línea, la comilla y la marca, lo que tiene detrás, el cuerpo y el cierre
const HEREDOC_ENTERO = /(^|\n)([^\n]*?)(?<![\\<])<<(?!<)-?[ \t]*(['"]?)([^\s'"<>;&|()]+)\3(?=[\s;&|()<>]|$)([^\n]*)\n([\s\S]*?)(\n[ \t]*\4[ \t]*)(?=\n|$)/g;
// un grupo, una comilla invertida o una palabra de control abierta antes del heredoc: lo que escribe puede seguir camino a otro programa
const GRUPO_O_CONTROL = /[({`]|(?:^|[\s;&|])(?:if|then|else|elif|do|while|until|for|case|select|function)(?=[\s;]|$)/;
const CAT_O_TEE_REDEFINIDO = /(?:^|[\s;&|(])(?:function[ \t]+(?:cat|tee)\b|alias[ \t]+(?:cat|tee)=|(?:cat|tee)[ \t]*\(\s*\))/;
// lo que puede ir detrás de la marca sin que la línea siga abajo ni el cuerpo vaya a otro programa: palabras y
// redirecciones. El `&` sólo vale en `N>&M`: `&&` y `&` empiezan otro comando, que puede correr lo que se escribió
const DETRAS_DE_LA_MARCA = /^[ \t\w./~@%+=:,>-]*$/;
const REDIRECCION_A_DESCRIPTOR = /\d*>&\d+/g;

// los programas que leen el cuerpo de un heredoc como texto (un mensaje o el texto de un pedido): no lo corren
const LEE_EL_CUERPO_COMO_TEXTO = /^(?:git(?: -[cC] \S+)* commit|gh \S+|az \S+|grep|egrep|fgrep|rg|wc)(?: |$)/;

/** El texto de un `$'…'` como lo deja el shell: `\n`, `\t`, `\xHH`, `\uHHHH`, `\NNN` (octal), `\cX`, `\'` y `\\`. */
function ansiC(s) {
  const simples = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v' };
  return String(s).replace(/\\(?:x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8})|([0-7]{1,3})|c(.)|([\s\S]))/g,
    (m, x, u, U, oct, ctl, otro) => {
      if (x || u || U) { const n = parseInt(x || u || U, 16); return n <= 0x10ffff ? String.fromCodePoint(n) : ''; }
      if (oct) return String.fromCharCode(parseInt(oct, 8) & 0xff);
      if (ctl) return String.fromCharCode(ctl.charCodeAt(0) & 0x1f);
      return Object.prototype.hasOwnProperty.call(simples, otro) ? simples[otro] : otro;
    });
}

// una variable del shell: `$V`, `${V}` y las formas con operador (`${V:-x}`, `${V#p}`), que se leen como su valor
const EXPANSION_DE_VARIABLE = /\$\{([A-Za-z_]\w*)(?:[:#%/^,@][^}]*)?\}|\$([A-Za-z_]\w*)/g;

const SHELLS_CON_DASH_C = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'pdksh', 'ash', 'fish']);

/**
 * El cuerpo de un shell anidado con lo que vale afuera: `$PWD` (y `${PWD}`, `$(pwd)`) es la carpeta en la que corre, y una
 * variable asignada en el comando (`F=h.md; sh -c 'echo x >> "$F"'`) vale lo asignado, una lectura por valor (los
 * últimos ocho, que son los que rigen). Un valor armado con otra variable (`F=$D/h.md`) se arma con la última de ésa.
 * La que el cuerpo asigna no se toca: adentro vale la suya. Sin exportar, el shell de adentro no la ve; se lee igual,
 * porque una variable ya exportada cambia de valor con la asignación.
 */
function cuerpoConValores(cuerpo, asignados) {
  // `$PWD` es la carpeta de los `cd` que el cuerpo hizo antes (`cd /tmp && echo x > $PWD/a` escribe en /tmp), o la de partida
  const conPwd = String(cuerpo).replace(/\$\{PWD\}|\$PWD(?!\w)|\$\(pwd\)|`pwd`/g, (m, donde, s) => {
    let dir = '.';
    for (const c of s.slice(0, donde).matchAll(/(?:^|[\s;&|(])(?:cd|pushd)\s+(['"]?)([^\s'";&|)]+)\1/g)) {
      if (c[2] !== '-') dir = path.posix.isAbsolute(c[2]) ? c[2] : path.posix.join(dir, c[2]);
    }
    return dir;
  });
  const propias = new Set([...conPwd.matchAll(/(?:^|[\s;&|(])([A-Za-z_]\w*)=/g)].map((m) => m[1]));
  const valoresDe = (n, hondo = 0) => (asignados.get(n) || []).slice(-8).map((v) => (hondo > 2 ? v
    : String(v).replace(EXPANSION_DE_VARIABLE, (m, a, b) => { const x = valoresDe(a || b, hondo + 1); return x.length ? x[x.length - 1] : m; })));
  const nombres = [...new Set([...conPwd.matchAll(EXPANSION_DE_VARIABLE)].map((m) => m[1] || m[2]))]
    .filter((n) => !propias.has(n) && valoresDe(n).length);
  if (!nombres.length) return [conPwd];
  const valores = new Map(nombres.map((n) => [n, valoresDe(n)]));
  const lecturas = Math.max(...[...valores.values()].map((v) => v.length));
  const out = [];
  for (let k = 0; k < lecturas; k++) {
    out.push(conPwd.replace(EXPANSION_DE_VARIABLE, (m, a, b) => {
      const v = valores.get(a || b);
      return v ? v[Math.min(k, v.length - 1)] : m;
    }));
  }
  return out;
}

/**
 * El comando con las comillas pegadas en medio de una palabra resueltas, como las deja el shell: `sp""ecs/h.md` y
 * `specs/"h".md` son `specs/h.md`. Sólo las que van fuera de otras comillas, pegadas a la palabra por algún lado y con un
 * texto sin espacios ni caracteres del shell adentro; lo demás queda como está. Las de una opción (`sed -i''`) también:
 * ahí la forma escrita decide cómo la lee el programa.
 */
function sinComillasPegadas(cmd) {
  const s = String(cmd);
  const deLaPalabra = (ch) => ch !== undefined && !/[\s'"`;&|<>()]/.test(ch);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') { out += ch + (s[i + 1] ?? ''); i++; continue; }
    if (ch !== "'" && ch !== '"') { out += ch; continue; }
    let j = i + 1;
    if (ch === "'") { while (j < s.length && s[j] !== "'") j++; } else { while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1; }
    if (j >= s.length) { out += s.slice(i); break; }
    const adentro = s.slice(i + 1, j);
    const pegada = deLaPalabra(s[i - 1]) || deLaPalabra(s[j + 1]);
    const deUnaOpcion = /(?:^|[\s;&|<>()])-[^\s;&|<>()]*$/.test(out);
    out += pegada && !deUnaOpcion && /^[^\s'"`$\\;&|<>(){}*?[\]!#~]*$/.test(adentro) ? adentro : s.slice(i, j + 1);
    i = j;
  }
  return out;
}

// Si el comando puede correr un texto, qué hay entre comillas y dónde: lo decide el partidor común
// (scripts/lib/shell-parse.js), el mismo del freno de sesiones. Sin él (una instalación a medias), todo texto puede
// correrse: falla cerrado, como antes de que un texto entre comillas fuera texto.
let partidor;
function partidorComun() {
  if (partidor === undefined) {
    try { partidor = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'shell-parse.js')); } catch (e) { logHookError(e); partidor = null; }
    if (partidor && typeof partidor.ejecutaTexto !== 'function') partidor = null;
  }
  return partidor;
}
const ejecutaTexto = (cmd) => { const p = partidorComun(); return p ? p.ejecutaTexto(cmd) : true; };
const citados = (cmd) => { const p = partidorComun(); return p ? p.citados(cmd) : []; };
const posicionesFueraDeComillas = (texto) => { const p = partidorComun(); return p ? p.posicionesFueraDeComillas(texto) : () => true; };

/** ¿La ruta queda adentro de un repo de git? Sube desde la carpeta que exista más cerca. */
function dentroDeUnRepo(p) {
  let d = path.resolve(p);
  for (;;) {
    try { if (fs.existsSync(path.join(d, '.git'))) return true; } catch (_) { return true; }
    const arriba = path.dirname(d);
    if (arriba === d) return false;
    d = arriba;
  }
}

// Las opciones de cada copiador que llevan su valor en la palabra que sigue: ese valor (un patrón de `--exclude`, el
// programa de `-e`, el puerto de `scp -P`) no es un origen ni el destino. Sólo las que significan lo mismo en las
// versiones de GNU y de BSD: tomar de más una opción que no lleva valor haría perder el destino. Las largas van sin sus
// dos guiones: son las opciones de esos programas, no nombres del arnés
const conGuiones = (nombres) => nombres.map((n) => `--${n}`);
const OPCIONES_CON_VALOR = {
  rsync: {
    cortas: 'efBTM@',
    largas: conGuiones(['exclude', 'include', 'exclude-from', 'include-from', 'filter', 'files-from', 'rsh',
      'rsync-path', 'info', 'debug', 'stderr', 'backup-dir', 'suffix', 'chmod', 'chown', 'copy-as',
      'block-size', 'max-delete', 'max-size', 'min-size', 'max-alloc', 'partial-dir', 'usermap', 'groupmap',
      'timeout', 'contimeout', 'modify-window', 'temp-dir', 'compare-dest', 'copy-dest', 'link-dest',
      'compress-choice', 'zc', 'compress-level', 'zl', 'skip-compress', 'address', 'port', 'sockopts',
      'out-format', 'log-file', 'log-file-format', 'password-file', 'bwlimit', 'stop-after', 'stop-at',
      'write-batch', 'only-write-batch', 'read-batch', 'protocol', 'iconv', 'checksum-choice', 'cc',
      'checksum-seed', 'remote-option', 'outbuf', 'early-input']),
  },
  scp: { cortas: 'cDFiJloPSX', largas: [] },
  install: { cortas: 'mog', largas: conGuiones(['mode', 'owner', 'group', 'suffix', 'strip-program']) },
  ditto: { cortas: '', largas: conGuiones(['arch', 'bom']) },
};

/**
 * Las palabras sueltas de un copiador (orígenes y destino) y la carpeta de `install -t`: sin sus opciones ni el valor de
 * las que lo llevan aparte (`rsync a/ b/ --exclude x`, `rsync -e ssh a h:b`). Después de `--` todo es suelto.
 */
function argumentosDeCopia(c, args) {
  const tabla = OPCIONES_CON_VALOR[c] || { cortas: '', largas: [] };
  const sueltos = [];
  let carpeta = null;
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (w === '--') { sueltos.push(...args.slice(i + 1)); break; }
    if (!w.startsWith('-') || w === '-') { sueltos.push(w); continue; }
    if (c === 'install') {
      if (w === '-t' || w === '--target-directory') { carpeta = args[++i] ?? null; continue; }
      const pegado = /^(?:--target-directory=|-t)(.+)$/.exec(w);
      if (pegado) { carpeta = pegado[1]; continue; }
      // `-t` dentro de un grupo de cortas (`-Dt dir`, `-vtdir`): la carpeta es lo que sigue a la `t`, o la palabra que sigue
      const enGrupo = /^-([A-Za-z]*?)t(.*)$/.exec(w);
      if (enGrupo && !w.startsWith('--') && /^[A-Za-z]*$/.test(enGrupo[1])) { carpeta = enGrupo[2] || (args[++i] ?? null); continue; }
    }
    if (w.startsWith('--')) { if (!w.includes('=') && tabla.largas.includes(w)) i++; continue; }
    // un grupo de cortas (`-avz`, `-ae ssh`): la primera que lleva valor se queda con el resto del grupo o, si es la
    // última, con la palabra que sigue
    const letras = w.slice(1);
    const k = [...letras].findIndex((l) => tabla.cortas.includes(l));
    if (k >= 0 && k === letras.length - 1) i++;
  }
  return { sueltos, carpeta };
}

/**
 * El corchete que abre en `g[i]`, como comparador de un carácter, y dónde cierra. `[!a]` y `[^a]` son la negación, un `]`
 * que va primero es un carácter más, `\]` es un `]` que no cierra y `[:digit:]` es su clase. Sin cerrar, o con un rango al
 * revés, devuelve null: es texto, como para el shell.
 * El que cierra a más de `CORCHETE_TOPE` caracteres coincide con cualquiera, del lado que frena, sin armar su clase: armar
 * una por cada `[` de una tira larga hace crecer el tiempo con el cuadrado del largo, y como texto dejaría pasar lo que nombra.
 * Una clase que no se conoce, también: depende del idioma de la máquina.
 */
function corcheteDelShell(g, i) {
  let j = i + 1;
  const negado = g[j] === '!' || g[j] === '^';
  if (negado) j++;
  const desde = j;
  const escapar = (c) => (/[\\\]\[^-]/.test(c) ? `\\${c}` : c);
  const adentro = [];
  let cualquiera = false;
  let trasClase = false;
  if (g[j] === ']') { adentro.push('\\]'); j++; }
  while (j < g.length && g[j] !== ']') {
    if (g[j] === '\\' && j + 1 < g.length) { adentro.push(escapar(g[j + 1])); j += 2; continue; }
    // `[=a=]` y `[.a.]` dependen del idioma de la máquina: como una clase que no se conoce
    if (g[j] === '[' && (g[j + 1] === '=' || g[j + 1] === '.')) {
      const cierre = new RegExp(`^.{0,12}?\\${g[j + 1]}\\]`).exec(g.slice(j + 2, j + 16).join(''));
      if (cierre) { cualquiera = true; j += cierre[0].length + 2; trasClase = true; continue; }
    }
    if (g[j] === '[' && g[j + 1] === ':') {
      const nombre = /^([a-z]*):\]/.exec(g.slice(j + 2, j + 16).join(''));
      if (nombre) {
        if (Object.hasOwn(CLASES_POSIX, nombre[1])) adentro.push(CLASES_POSIX[nombre[1]]); else cualquiera = true;
        j += nombre[0].length + 2;
        trasClase = true;
        continue;
      }
    }
    // un rango que arranca o termina en una clase (`[[:digit:]-_]`) no dice qué abarca: del lado que frena. Al final, el
    // guion es un carácter más
    if (g[j] === '-' && g[j + 1] !== ']' && (trasClase || (g[j + 1] === '[' && g[j + 2] === ':'))) cualquiera = true;
    adentro.push(g[j] === '-' ? (g[j + 1] === ']' ? '\\-' : '-') : escapar(g[j]));
    trasClase = false;
    j++;
  }
  if (j >= g.length) {
    // el único `]` era parte de lo que parecía una clase, o tenía la barra: el corchete puede cerrar ahí, del lado que frena
    const primero = g.indexOf(']', g[desde] === ']' ? desde + 1 : desde);
    return primero < 0 ? null : { fin: primero, coincide: () => true };
  }
  if (cualquiera || j - desde > CORCHETE_TOPE) return { fin: j, coincide: () => true };
  let clase;
  // un rango al revés no abarca nada: solo no nombra nada, y negado nombra cualquier carácter
  try { clase = new RegExp(`^[${adentro.join('')}]$`, 'u'); } catch { return negado ? { fin: j, coincide: () => true } : null; }
  return { fin: j, coincide: (c) => clase.test(c) !== negado };
}

/**
 * Un comodín del shell para un tramo de una ruta: `*`, `?` y los corchetes. Compara carácter por carácter, sin una
 * expresión para el comodín entero: una excepción o una expresión que no termina abrirían el freno, y acá el peor caso es
 * el largo del comodín por el largo del nombre.
 */
function comodinDelShell(glob) {
  const g = [...String(glob)];
  const ESTRELLA = null;
  const partes = [];
  // después del último `]` no hay nada que cerrar: una tira de `[` no busca el cierre hasta el final en cada uno
  const ultimoCierre = g.lastIndexOf(']');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    // la barra escapa el carácter que sigue (en Windows ya no llega: separa carpetas)
    if (c === '\\' && i + 1 < g.length) { const x = g[++i]; partes.push((y) => y === x); continue; }
    if (c === '*') { if (partes[partes.length - 1] !== ESTRELLA) partes.push(ESTRELLA); continue; }
    if (c === '?') { partes.push(() => true); continue; }
    const corchete = c === '[' && i < ultimoCierre ? corcheteDelShell(g, i) : null;
    if (corchete) { partes.push(corchete.coincide); i = corchete.fin; continue; }
    partes.push((x) => x === c);
  }
  return {
    test(nombre) {
      const n = [...String(nombre)];
      let p = 0;
      let i = 0;
      // al fallar se vuelve sólo a la última estrella: darle un carácter más alcanza, las anteriores ya coincidieron
      let trasEstrella = -1;
      let desde = 0;
      while (i < n.length) {
        if (p < partes.length && partes[p] === ESTRELLA) { trasEstrella = ++p; desde = i; continue; }
        if (p < partes.length && partes[p](n[i])) { p++; i++; continue; }
        if (trasEstrella < 0) return false;
        p = trasEstrella;
        i = ++desde;
      }
      while (p < partes.length && partes[p] === ESTRELLA) p++;
      return p === partes.length;
    },
  };
}

/**
 * Las rutas que un comodín (`specs/*.md`, `specs/story-2.?`) nombra en el disco, desde `base` (hasta 200 en cada
 * tramo). Si se le pasa `aviso`, `aviso.recortado` queda en true cuando algún tramo pasó de 200.
 */
function expandirComodin(patron, base, aviso) {
  const absoluto = path.isAbsolute(patron) ? patron : path.join(base, patron);
  // la barra invertida separa carpetas sólo en Windows: en los demás, `[1\]]` es un solo tramo
  const partes = absoluto.split(process.platform === 'win32' ? /[\\/]+/ : /\/+/);
  let actuales = [partes[0] === '' ? path.sep : `${partes[0]}${path.sep}`];
  for (const parte of partes.slice(1)) {
    if (!parte) continue;
    const sig = [];
    const comodin = /[*?[]/.test(parte) ? comodinDelShell(parte) : null;
    for (const dir of actuales) {
      if (!comodin) { sig.push(path.join(dir, parte.replace(/\\(.)/g, '$1'))); continue; }
      let nombres = [];
      try { nombres = fs.readdirSync(dir); } catch { continue; }
      // un `\.` al comienzo pide los ocultos igual que un `.`
      for (const n of nombres) if (comodin.test(n) && (!n.startsWith('.') || /^\\?\./.test(parte))) sig.push(path.join(dir, n));
    }
    if (aviso && sig.length > 200) aviso.recortado = true;
    actuales = sig.slice(0, 200);
    if (!actuales.length) break;
  }
  return actuales.filter((p) => fs.existsSync(p));
}

/** Los `.md` adentro de una carpeta cuyo nombre cumple `cumple`, hasta cuatro niveles y 500 archivos. */
function mdAdentro(dir, cumple = () => true) {
  const out = [];
  const ver = (d, nivel) => {
    let entradas = [];
    try { entradas = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
      if (out.length >= 500) return;
      if (e.isDirectory() && nivel < 4 && !NEVER_CODE_SEGMENTS.has(e.name) && e.name !== '.git') ver(path.join(d, e.name), nivel + 1);
      else if (e.isFile() && /\.md$/i.test(e.name) && cumple(e.name)) out.push(path.join(d, e.name));
    }
  };
  ver(dir, 0);
  return out;
}

const SHELLS_QUE_LEEN_COMANDOS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const LECTORES_DE_HISTORIA = new Set(['cat', 'grep', 'head', 'tail', 'wc', 'ls']);
// las opciones de xargs que llevan su valor en la palabra siguiente (GNU y BSD); `-I`, `-J` y `-i` fijan el marcador
const XARGS_CON_VALOR = new Set(['-n', '-L', '-P', '-d', '-E', '-s', '-a', '-R', '-S', '--max-args', '--max-lines',
  '--max-procs', '--delimiter', '--max-chars', '--arg-file']);
// lo que puede ir delante de un `xargs` sin cambiar qué corre
const PALABRA_ANTES_DE_XARGS = /^(?:\{|!|time(?:\s+-p)?|then|do|else|elif|if|while|until)\s+/;

// una redirección con su destino (`<<EOF`, `<<< "x"`, `> f`, `2>&1`): `palabras` saca el operador y deja el destino
const REDIRECCION = /(?<![^\s;&|(])\d*(?:<<<|<<-?|&>>?|[<>]{1,2}&?)[ \t]*(?:'[^']*'|"(?:[^"\\]|\\.)*"|[^\s;&|()<>]+)?/g;

/** El guion que corre un shell (`bash -o errexit x.sh` → `x.sh`), o null: las opciones con valor no son el guion. */
function guionDelShell(words) {
  for (let i = 1; i < words.length; i++) {
    if (words[i] === '--') return words[i + 1] || null;
    // `-o` toma la palabra que sigue, también agrupado (`-euo pipefail`)
    if (/^[+-][A-Za-z]*[oO]$/.test(words[i]) || /^--(?:rcfile|init-file)$/.test(words[i])) { i++; continue; }
    if (/^[+-]/.test(words[i])) continue;
    return words[i];
  }
  return null;
}

/**
 * Suma a `cds` el `cd` de las palabras `w` (`cd`/`pushd` y su carpeta, sin las opciones `-P`/`-L`/`-e`/`-@` ni el `--`).
 * `cd -` vuelve a la carpeta de antes: saca el último.
 */
function moverCds(cds, w) {
  const i = w.findIndex((x, k) => k > 0 && !/^-[LPe@]+$/.test(x) && x !== '--');
  if (i < 0) return;
  if (w[i] === '-') { cds.pop(); return; }
  cds.push(`cd ${/\s/.test(w[i]) ? `"${w[i]}"` : w[i]}`);
}

/** Lo que escribe un `printf` con estos argumentos: el formato con cada `%s` (o `%b`, `%d`) cambiado por el que sigue. */
function formatoDePrintf(args) {
  const [formato = '', ...resto] = args;
  if (!/%/.test(formato)) return [formato, ...resto].join(' ');
  if (!resto.length) return formato.replace(/%[-0-9.]*[sbdq]/g, '');
  let salida = '';
  // como printf, el formato se repite hasta usar todos los argumentos
  for (let k = 0; k < resto.length;) {
    const antes = k;
    salida += formato.replace(/%[-0-9.]*[sbdq]/g, () => (k < resto.length ? resto[k++] : ''));
    if (k === antes) break;
  }
  return salida;
}

// los nombres de la entrada estándar como archivo: un guion con ese nombre es lo que llega por la entrada
const LA_ENTRADA_COMO_ARCHIVO = /^(?:\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/;

/**
 * ¿El tramo es un shell que lee sus comandos de la entrada? Sí sin guion, con `-s` o con la entrada como guion
 * (`bash /dev/stdin`); no con `-c` ni con otro guion. `source` y `.` con la entrada como archivo también la corren en el
 * shell de ahora (`source /dev/stdin <<EOF`).
 */
function shellLeeEntrada(tramo) {
  const words = palabras(sinPalabrasDelShell(String(tramo).replace(REDIRECCION, ' '))).filter((w) => w !== '');
  const programa = nombreDeComando(words[0]);
  if (programa === 'source' || programa === '.') return LA_ENTRADA_COMO_ARCHIVO.test(words.slice(1).find((w) => w !== '--') || '');
  if (!SHELLS_QUE_LEEN_COMANDOS.has(programa)) return false;
  for (let i = 1; i < words.length; i++) {
    if (/^-[A-Za-z]*c/.test(words[i])) return false;
    if (/^-[A-Za-z]*s/.test(words[i])) return true;
  }
  const guion = guionDelShell(words);
  return guion === null || LA_ENTRADA_COMO_ARCHIVO.test(guion);
}

/**
 * Los renglones de un comando como los lee el shell: un salto adentro de comillas, o después de un `|`, `&&` o `||` que
 * espera lo que sigue, no corta.
 */
function renglonesDelShell(texto) {
  const out = [];
  let actual = '';
  let q = null;
  const s = String(texto);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { actual += c; if (c === '\\' && q === '"') actual += s[++i] || ''; else if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; actual += c; continue; }
    if (c === '\\') { actual += c + (s[i + 1] || ''); i++; continue; }
    if (c === '\n' && !/(?:\||&&)\s*$/.test(actual)) { out.push(actual); actual = ''; continue; }
    actual += c === '\n' ? ' ' : c;
  }
  out.push(actual);
  return out;
}

/**
 * La palabra con `$PWD`, `${PWD}`, `$(pwd)` y `` `pwd` `` reemplazados por `carpeta`, la carpeta en la que corre. El
 * `$(pwd` sin su paréntesis también: quien lee la ruta le saca el `)` del final, que suele cerrar un subshell.
 */
const conCarpetaDelComando = (palabra, carpeta) => String(palabra).replace(/\$\{PWD\}|\$PWD(?!\w)|\$\(\s*pwd\s*(?:\)|$)|`pwd`/g, () => carpeta);

const FIN_DE_EXEC = new Set([';', '\\;', '+', '\\']);
const citarParaElShell = (w) => (/^[\w@%+=:,./~*?[\]{}-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`);

/**
 * ¿El nombre cumple el patrón de `-name`? Se lee como el shell (`*`, `?`, corchetes con sus clases, `\x`), con el mismo
 * comparador de los comodines; un patrón que no se entiende cumple: se mira de más.
 */
function cumplePatronDeFind(patron, sinMayusculas) {
  try {
    const c = comodinDelShell(sinMayusculas ? String(patron).toLowerCase() : patron);
    return (nombre) => c.test(sinMayusculas ? String(nombre).toLowerCase() : nombre);
  } catch { return () => true; }
}

/** Las historias que alcanza un `find`: sus carpetas de partida (resueltas con `absoluta`) filtradas por sus `-name`. */
function alcanzadasPorFind(words, absoluta) {
  const carpetas = [];
  for (let i = 1; i < words.length && !/^[-!(]/.test(words[i]); i++) {
    // `"$PWD"/docs` llega partido en dos palabras: la carpeta es una sola
    const previa = carpetas[carpetas.length - 1];
    if (previa !== undefined && words[i].startsWith('/') && conCarpetaDelComando(previa, '\0') === '\0') carpetas[carpetas.length - 1] = previa + words[i];
    else carpetas.push(words[i]);
  }
  if (!carpetas.length) carpetas.push('.');
  // con una negación, un «o» o un `-prune`, un `-name` ya no dice qué alcanza: se miran todas
  const filtros = [];
  const sinFiltro = words.some((w) => ['!', '-not', '-o', '-or', ',', '-prune'].includes(w));
  const patrones = [];
  if (!sinFiltro) words.forEach((w, k) => { if ((w === '-name' || w === '-iname') && words[k + 1] !== undefined) { patrones.push(words[k + 1]); filtros.push(cumplePatronDeFind(words[k + 1], w === '-iname')); } });
  // ningún `-name` que pueda dar un `.md` (`*.tmp`, `cache-*.log`): no hay historia que buscar, y el recorrido cuesta
  // Con un corchete o una barra, cualquier cosa (`*.[m]d`, `*.m\d`). Si no, lo que sigue al último comodín tiene que poder
  // ser el final de un `.md`, o terminar en `.md`
  const puedeSerMd = (crudo) => {
    const p = String(crudo).replace(/^['"]|['"]$/g, '').toLowerCase();
    if (/[[\\]/.test(p)) return true;
    const cola = p.slice(Math.max(p.lastIndexOf('*'), p.lastIndexOf('?')) + 1);
    return '.md'.endsWith(cola) || cola.endsWith('.md') || (p.lastIndexOf('?') === p.length - 1);
  };
  if (patrones.length && !patrones.some(puedeSerMd)) return [];
  const cumple = filtros.length ? (nombre) => filtros.some((f) => f(nombre)) : () => true;
  return carpetas.flatMap(absoluta).flatMap((abs) => {
    try { if (fs.statSync(abs).isFile()) return cumple(path.basename(abs)) ? [abs] : []; } catch { return []; }
    return mdAdentro(abs, cumple);
  });
}

/** Lo que corre cada `-exec`, `-execdir`, `-ok` y `-okdir` de un `find`, con `{}` reemplazado por las historias que alcanza. */
function ordenesDeFind(words, absoluta) {
  const alcanzadas = () => alcanzadasPorFind(words, absoluta);
  const out = [];
  for (let k = 0; k < words.length; k++) {
    if (!/^-(?:exec|execdir|ok|okdir)$/.test(words[k])) continue;
    let fin = k + 1;
    while (fin < words.length && !FIN_DE_EXEC.has(words[fin])) fin++;
    const orden = words.slice(k + 1, fin);
    k = fin;
    if (!orden.length || LECTORES_DE_HISTORIA.has(nombreDeComando(orden[0]))) continue;
    const archivos = orden.some((w) => w.includes('{}')) ? alcanzadas() : [];
    out.push(orden.flatMap((w) => (w.includes('{}') ? archivos.map((a) => citarParaElShell(w.split('{}').join(a))) : [citarParaElShell(w)])).join(' '));
  }
  return out;
}

/**
 * Lo que corre un `xargs`, con las palabras del tramo anterior como argumentos. Con marcador (`-I`, `-J`, `-i`,
 * `--replace`) corre una orden por argumento, con el marcador reemplazado adentro de cada palabra. Sin marcador, todas
 * juntas y también una por vez (con `-n1` o `-L1`, el `$1` de un `sh -c` es cada una).
 */
/** El marcador de un `xargs` (`-I`, `-J`, `-i`, `--replace`; null sin él) y su orden, sin las opciones. */
function marcaDeXargs(words) {
  let i = 1;
  let marca = null;
  for (; i < words.length && words[i].startsWith('-'); i++) {
    const w = words[i];
    if (w === '--') { i++; break; }
    if (w === '-I' || w === '-J') { marca = words[++i] || null; continue; }
    if (/^-[IJ]./.test(w)) { marca = w.slice(2); continue; }
    if (w === '-i' || w === '--replace') { marca = '{}'; continue; }
    if (/^-i./.test(w)) { marca = w.slice(2); continue; }
    if (w.startsWith('--replace=')) { marca = w.slice('--replace='.length) || '{}'; continue; }
    if (XARGS_CON_VALOR.has(w)) i++;
  }
  return { marca, orden: words.slice(i) };
}

function ordenesDeXargs(words, previas) {
  const { marca, orden } = marcaDeXargs(words);
  if (!orden.length) return [];
  if (marca) return previas.map((a) => orden.map((w) => citarParaElShell(w.split(marca).join(a))).join(' '));
  const juntas = [[...orden, ...previas].map(citarParaElShell).join(' ')];
  return previas.length > 1 ? [...juntas, ...previas.map((a) => [...orden, a].map(citarParaElShell).join(' '))] : juntas;
}

// las opciones de GNU parallel que llevan su valor en la palabra siguiente
const PARALLEL_CON_VALOR = new Set(['-j', '--jobs', '-P', '--max-procs', '-S', '-a', '--arg-file', '-n', '--max-args', '-L',
  '--max-lines', '-N', '-d', '--delimiter', '-C', '-E', '--delay', '--timeout', '--results', '--tmpdir', '--wd', '--tag-string',
  '--retries', '--load']);
/**
 * Lo que corre un `parallel` (GNU): su orden con cada argumento de `:::` (o, sin ellos, con lo que llega por la entrada)
 * en el lugar del marcador (`{}`, u otro con `-I`), o al final si no lo nombra. Sin orden, cada argumento es un comando.
 * Una opción larga que no está en la lista puede llevar su valor en la palabra siguiente o no: se leen las dos formas
 * (hasta dos de ellas), que es el lado que frena.
 */
function ordenesDeParallel(words, previas) {
  const out = new Set();
  const leer = (desde, marcaDeAntes, dudas) => {
    let i = desde;
    let marca = marcaDeAntes;
    for (; i < words.length && words[i].startsWith('-') && !/^:::/.test(words[i]); i++) {
      if (words[i] === '-I' || words[i] === '--replace') { marca = words[++i] || marca; continue; }
      if (words[i] === '--') { i++; break; }
      if (PARALLEL_CON_VALOR.has(words[i])) { i++; continue; }
      if (/^--[^=]+$/.test(words[i]) && dudas < 2) leer(i + 2, marca, dudas + 1);
    }
    const separador = words.findIndex((w, j) => j >= i && /^::::?\+?$/.test(w));
    const orden = words.slice(i, separador < 0 ? undefined : separador);
    const args = separador < 0 ? previas : words.slice(separador).filter((w) => !/^::::?\+?$/.test(w));
    if (!orden.length) { for (const a of args) out.add(a); return; }
    const conMarca = orden.some((w) => w.includes(marca));
    for (const a of args) out.add((conMarca ? orden.map((w) => citarParaElShell(w.split(marca).join(a))) : [...orden, a].map(citarParaElShell)).join(' '));
  };
  leer(1, '{}', 0);
  return [...out];
}

// El tramo sin su comentario del final (desde los blancos antes del primer `#` que va después de la última comilla) y sin
// su cierre (`; )`, ` }`). Lo mismo que `/\s+#[^'"]*$/` y `/\s*;?\s*[)}]\s*$/` sobre el texto recortado, pero a mano:
// con esas expresiones una tirada larga de espacios hace al freno cuadrático y cúbico, y pasa de su tope de tiempo.
function sinComentarioAlFinal(t) {
  const ultimaComilla = Math.max(t.lastIndexOf("'"), t.lastIndexOf('"'));
  for (let q = t.indexOf('#', ultimaComilla + 1); q !== -1; q = t.indexOf('#', q + 1)) {
    if (q === 0 || !/\s/.test(t[q - 1])) continue;
    let p = q - 1;
    while (p > 0 && /\s/.test(t[p - 1])) p--;
    return t.slice(0, p);
  }
  return t;
}
function sinCierre(t) {
  if (!/[)}]$/.test(t)) return t;
  const s = t.slice(0, -1).trimEnd();
  return s.endsWith(';') ? s.slice(0, -1).trimEnd() : s;
}

const NO_VA_FUERA_DEL_FOR = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'eval', 'source', '.', 'xargs', 'find']);

/**
 * El estado de una historia: `'draft'`, otro estado, `''` (historia sin `status:`), o null si no es una historia. Sin la
 * marca de orden de bytes y con CRLF. Un archivo que existe y no se puede leer cuenta como historia (del lado que frena).
 */
function estadoDeHistoria(abs) {
  let texto = '';
  try { texto = fs.readFileSync(abs, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n'); } catch (e) { logHookError(e); return '?'; }
  let declares = (t) => /^---[\s\S]*?^[ \t]*story[ \t]*:/m.test(t);
  try { ({ declaresStoryIdentity: declares } = require('./story-discovery.js')); } catch (e) { logHookError(e); /* la forma de siempre */ }
  if (!declares(texto)) return null;
  const fm = /^---\n([\s\S]*?)\n---/.exec(texto);
  const estado = fm && /^["']?status["']?\s*:\s*["']?([\w-]+)/m.exec(fm[1]);
  return estado ? estado[1].toLowerCase() : '';
}

/** Lo que git sigue en esa ruta (un archivo, una carpeta, un comodín): `[rutas absolutas]`, o null si no se pudo preguntar. */
function seguidos(repo, abs) {
  const r = require('child_process').spawnSync('git', ['-C', repo, 'ls-files', '-z', '--full-name', '--', abs],
    { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  if (r.error || r.status !== 0) return null;
  const top = require('child_process').spawnSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'],
    { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  const raiz = top.status === 0 ? String(top.stdout).trim() : repo;
  return String(r.stdout).split('\0').filter(Boolean).map((f) => path.join(raiz, f));
}

// cuántos cuerpos distintos de un mismo archivo se juzgan: cada juicio lleva su tiempo
const CUERPOS_A_JUZGAR = 16;
/**
 * Frontmatter inline: `printf '---\nstory: "9.9"\n…' > f.md` / `echo -e`. Se des-escapan los `\n`
 * y se toma desde el primer `---` de línea. Devuelve el texto si declara identidad de story, si no null.
 */
function inlineStoryText(cmd, declares) {
  const t = String(cmd || '').replace(/\\n/g, '\n');
  // El `---` abre al inicio, tras un salto de línea o tras la comilla que abre el string.
  const m = t.match(/(^|[\n'"`])---\n/);
  if (!m) return null;
  const slice = t.slice(m.index + m[1].length);
  return declares(slice) ? slice : null;
}

/**
 * `mv|cp <origen> <destino>` donde el ORIGEN existe y ES una story (frontmatter con story:+status:):
 * renombrar o duplicar una story existente no es crearla a mano. Devuelve
 * { src, dest } absolutos o null. Sólo el primer segmento cp/mv del comando.
 */
/**
 * El destino de una escritura, absoluto y en la forma nativa de la máquina. En Windows un destino puede venir como
 * `C:\a\b`, `C:/a/b` o `/c/a/b` (la de Git Bash, que es con lo que corre el comando): las tres son el mismo archivo,
 * y sin pasarlas por una sola función la tercera no encontraría su repo y el portón dejaría pasar.
 * Fuera de Windows es lo de siempre.
 */
function resolveTarget(target, cwd, platform = process.platform, { homeVariable = false } = {}) {
  const P = platform === 'win32' ? path.win32 : path;
  let expanded = String(target).replace(/^~(?=\/|$)/, os.homedir());
  // `$HOME` sólo lo expande quien ya lo expandía (los destinos de una escritura): acá no cambia qué se expande
  if (homeVariable) expanded = expanded.replace(/^\$\{?HOME\}?(?=\/|$)/, os.homedir());
  expanded = nativePath(expanded, platform);
  return P.isAbsolute(expanded) ? expanded : P.resolve(nativePath(cwd, platform), expanded);
}


/**
 * Las formas que puede tomar una palabra con las variables asignadas en el comando (A57). La primera es la de siempre: la
 * última asignación de cada variable. Después, cada combinación de las demás: la última del texto puede ser posterior al
 * uso (`f=h.md; echo $f | xargs rm; f=otro`) y un bucle puede usar cualquiera. Hasta `TOPE_DE_VARIANTES`; con más,
 * `{ variantes, pasado: true }`: quien llama lo trata como una entrada que no se ve.
 */
const TOPE_DE_VARIANTES = 16;
function variantesDeVariables(w, asignados) {
  const texto = String(w);
  const ultima = texto.replace(EXPANSION_DE_VARIABLE, (m, a, b) => {
    const v = asignados.get(a || b) || [];
    return v.length ? v[v.length - 1] : m;
  });
  let variantes = [texto];
  let pasado = false;
  for (const m of texto.matchAll(EXPANSION_DE_VARIABLE)) {
    const v = [...new Set(asignados.get(m[1] || m[2]) || [])];
    if (!v.length) continue;
    const siguientes = variantes.flatMap((x) => v.map((valor) => x.replace(m[0], () => valor)));
    if (siguientes.length > TOPE_DE_VARIANTES) { pasado = true; break; }
    variantes = siguientes;
  }
  return { variantes: [...new Set([ultima, ...(pasado ? [] : variantes)])], pasado };
}

/**
 * Las entradas alternativas de una lista de palabras: la alternativa `i` toma la variante `i` de cada palabra (o su
 * última, si tiene menos). Cada alternativa es una entrada entera, así las posiciones no se corren (`printf '%s/%s'`,
 * `sh -c 'rm $1'`). `pasado`: alguna palabra pasó el tope.
 */
function entradasAlternativas(words, asignados) {
  const vs = words.map((w) => variantesDeVariables(w, asignados));
  const n = Math.max(1, ...vs.map((v) => v.variantes.length));
  const alternativas = [];
  for (let i = 0; i < n; i++) alternativas.push(vs.map((v) => v.variantes[Math.min(i, v.variantes.length - 1)]));
  return { alternativas, pasado: vs.some((v) => v.pasado) };
}

module.exports = { TOPE_DE_VARIANTES, variantesDeVariables, entradasAlternativas, MAS_OPCIONES_CON_VALOR, opcionesDelEnvoltorio, palabraConAnsi, cpMvDest, destinosDeCpMv, programaEscrito, interpreteDe, abreParaEscribir, algunOpenEscribe, sedConEfectos, comodinSimple, ensayarSeds, estadosDelEncabezado, FORMAS_DE_ESCRIBIR_RE, ESCRIBE, nombreDeComando, LECTORES_DE_XARGS, ANTES_DEL_ENV, ENVOLTORIOS_CON_VALOR, pelarEnv, TOPE_DE_CARPETAS_DE_CD, PALABRA_ENTERA, palabrasEnteras, sinCierreDeGrupo, destinoDeLaCopia, posicionales, palabraDelShell, parchesDePatch, parcheNombraConstancia, yaHayOrigin, constanciasDeOtraRama, archivoDeTar, contenidoDelArchivo, nombresDeConstancia, PALABRA_DEL_SHELL, sinPalabrasDelShell, sinRedireccionesDeSalida, HEREDOC_ENTERO, GRUPO_O_CONTROL, CAT_O_TEE_REDEFINIDO, DETRAS_DE_LA_MARCA, REDIRECCION_A_DESCRIPTOR, LEE_EL_CUERPO_COMO_TEXTO, ansiC, EXPANSION_DE_VARIABLE, SHELLS_CON_DASH_C, cuerpoConValores, sinComillasPegadas, partidorComun, ejecutaTexto, citados, posicionesFueraDeComillas, dentroDeUnRepo, conGuiones, OPCIONES_CON_VALOR, argumentosDeCopia, corcheteDelShell, comodinDelShell, expandirComodin, mdAdentro, SHELLS_QUE_LEEN_COMANDOS, LECTORES_DE_HISTORIA, XARGS_CON_VALOR, PALABRA_ANTES_DE_XARGS, REDIRECCION, guionDelShell, moverCds, formatoDePrintf, LA_ENTRADA_COMO_ARCHIVO, shellLeeEntrada, renglonesDelShell, FIN_DE_EXEC, citarParaElShell, cumplePatronDeFind, ordenesDeFind, ordenesDeXargs, marcaDeXargs, PARALLEL_CON_VALOR, ordenesDeParallel, sinComentarioAlFinal, sinCierre, NO_VA_FUERA_DEL_FOR, estadoDeHistoria, seguidos, CUERPOS_A_JUZGAR, inlineStoryText, resolveTarget, conCarpetaDelComando, alcanzadasPorFind };
