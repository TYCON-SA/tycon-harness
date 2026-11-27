'use strict';
/**
 * scripts/lib/command-tokens.js — cómo leer un comando de terminal sin dejarse engañar, sin saber de qué plataforma es.
 *
 * Lo usan los frenos y los avisos que leen un comando, y los lectores de cada plataforma (`integrations/<conector>/
 * scripts/command-reader.js`), que se arman encima: el conector sabe qué subcomando publica y qué banderas importan;
 * acá está lo que vale para cualquier programa. Un regex de una línea por hook se equivoca en seis cosas: una bandera
 * escrita dentro del título cuenta como bandera; dos comandos encadenados con `&&` se juzgan por las banderas del
 * primero; la forma corta `--flag` (que vale `true`) se lee como su siguiente token; el último valor repetido es el que
 * toma el programa, no el primero; `--flag yes` también es cierto; y una continuación de línea (`\` + salto) no es un
 * valor.
 *
 * 🔴 UN SOLO RECORRIDO DEL TEXTO. Con varios recorridos con conciencia de comillas —partir en segmentos, vaciar las
 * cadenas, buscar cada bandera— las banderas se buscarían sobre el texto ya vaciado, y `--flag "true"` se leería como
 * vacío y quedaría BLOQUEADO. Un freno que corta el camino correcto se apaga. Por eso el texto se recorre UNA vez y se
 * parte en fichas; cada ficha sabe si empezó entre comillas, que es lo único que hace falta para distinguir «esto es una
 * bandera» de «esto es el título que la menciona».
 *
 * Qué NO resuelve, a propósito: sustitución de comandos (`$(…)`), heredocs, backticks. No los expande: en una bandera
 * que el freno juzga, un valor así es ilegible y es una falta, y lo que se ve no puede decir lo que no tiene.
 */

const CIERTO = new Set(['true', 't', 'yes', 'y', '1']);
const FALSO = new Set(['false', 'f', 'no', 'n', '0']);

/**
 * Parte el comando en FICHAS y operadores, en un solo recorrido.
 *
 * Cada ficha es `{ texto, esBandera }`: `texto` es el contenido ya sin comillas, y `esBandera`
 * dice si la ficha EMPEZÓ fuera de comillas — lo único que separa una bandera de verdad
 * (`--squash false`) de un título que la nombra (`--title "usá --squash false"`). Un valor entre
 * comillas (`--flag "true"`) es un valor normal: las comillas no lo cambian.
 *
 * `\` + salto de línea se quita (así lo lee la terminal): un comando partido en varias líneas es UN comando.
 *
 * `expande`: la ficha trae algo que la terminal va a reemplazar antes de correr el comando
 * —`$nombre`, `${…}`, `$(…)` o comillas invertidas, fuera de comillas simples y sin barra delante—. Su `texto` es lo
 * escrito, no lo que va a llegar: quien necesita el texto de verdad (el lector de `gh`) lo da por ilegible.
 *
 * `partida`: la expansión está FUERA de comillas. La terminal parte su resultado en palabras, así que puede meter una
 * bandera que el comando no muestra (`--title $T`). Adentro de comillas dobles (`--title "$T"`) queda una sola palabra.
 */
const FIN_DE_LINEA = new Set(['\n', '\r', ' ', ' ']);

/** La línea sin los espacios ni tabs de sus costados (sólo esos dos: así lee la terminal el cierre de un bloque). */
function sinBordes(linea) {
  let a = 0;
  let b = linea.length;
  while (a < b && (linea[a] === ' ' || linea[a] === '\t')) a++;
  while (b > a && (linea[b - 1] === ' ' || linea[b - 1] === '\t')) b--;
  return linea.slice(a, b);
}

// `{…,…}` o `{…..…}` sin comillas, con partes citadas o escapadas adentro (`{"a b",dev}`, `{x,\ dev}`).
const LLAVES = /^\{(?:\\.|[^{}\s"'\\]|"(?:\\.|[^"\\])*"|'[^']*')*(?:,|\.\.)(?:\\.|[^{}\s"'\\]|"(?:\\.|[^"\\])*"|'[^']*')*\}/;

function fichas(cmd, opts = {}) {
  // `powershell`: el comando lo escribió la herramienta de PowerShell. Ahí la barra invertida NO escapa nada (es parte
  // de las rutas: `C:\tools\gh.exe`) y el renglón se continúa con una comilla invertida, no con una barra.
  const ps = Boolean(opts && opts.powershell);
  // la barra al final del renglón se QUITA junto con el salto, como hace la terminal: `cre\<salto>ate` es `create` y
  // `g\<salto>h` es `gh` (con un espacio en su lugar eran dos palabras, y el comando partido así no se reconocía)
  // (sólo la barra que no está escapada: `\\` antes del salto es una barra escrita, y el salto queda; si se la comiera,
  // adentro de `$'…'` quedaría un `\'` que no cierra la cadena)
  const s = ps ? String(cmd || '').replace(/`\r?\n/g, '') : String(cmd || '').replace(/(?<!\\)((?:\\\\)*)\\\r?\n/g, '$1');
  const out = [];
  let texto = '';
  let abierta = false;      // hay ficha en curso
  let empezoLibre = false;  // …y empezó fuera de comillas
  let expande = false;      // …y trae una expansión de la terminal
  let partida = false;      // …fuera de comillas
  let escapada = false;     // …y lleva un carácter escapado con barra (`\>` es texto, no una redirección)
  let q = null;

  const cerrar = () => {
    if (abierta) out.push({ texto, esBandera: empezoLibre, expande, partida, escapada });
    texto = ''; abierta = false; empezoLibre = false; expande = false; partida = false; escapada = false;
  };
  // `$5`, `$@`, `$?` también se reemplazan (un parámetro de la terminal); un `$` suelto o al final, no
  // (`$[…]` es una cuenta en bash y zsh; `$=VAR`, `$~VAR`, `$^VAR`, `$+VAR` son de zsh, la terminal de una Mac)
  const abreExpansion = (c, n) => c === '`' || (c === '$' && n !== undefined && /[A-Za-z_{(0-9@*#?$!\-[=~^+]/.test(n));

  // Heredocs: `<<[-]['"]?PALABRA['"]?` … hasta la línea que sólo dice PALABRA. Todo eso es TEXTO.
  // 🔴 Sólo cuenta el `<<` que está FUERA de comillas: buscado en el texto crudo, un
  // `echo "ejemplo: cat <<EOF"` abriría un bloque que no existe, y todo lo que siguiera —los comandos de los renglones
  // de abajo— se tragaría como cuerpo. Por eso acá sólo se ANOTAN los candidatos, y cada uno se abre cuando el
  // recorrido llega a su `<<` sin estar adentro de una cadena. (`<<<` es un texto de entrada, no un bloque.)
  // El delimitador puede llevar una barra delante (`<<\EOF`) y guiones o puntos adentro (`<<'FIN-1'`). Y un `<<` adentro
  // de una cuenta (`$((1<<b))`) es un corrimiento de bits, no un bloque.
  const candidatos = new Map();
  for (const m of s.matchAll(/(?<!<)<<(?!<)-?\s*(["']?)\\?([A-Za-z_][A-Za-z0-9_.-]*)\1/g)) {
    const finLinea = s.indexOf('\n', m.index);
    if (finLinea === -1) continue;
    const antes = s.slice(s.lastIndexOf('\n', m.index) + 1, m.index);
    if (antes.split('((').length > antes.split('))').length) continue;
    // el cierre es la primera línea que, sin espacios ni tabs a los costados, es el delimitador: se compara el texto,
    // sin armar una expresión con él (el delimitador viene del comando). Una línea termina en \n, \r, U+2028 o U+2029,
    // así que `FIN\r\n` (un comando escrito en Windows) cierra
    let fin = -1;
    for (let a = finLinea + 1; a <= s.length;) {
      let b = a;
      while (b < s.length && !FIN_DE_LINEA.has(s[b])) b++;
      if (sinBordes(s.slice(a, b)) === m[2]) { fin = a; break; }
      a = b + 1;
    }
    candidatos.set(m.index, [finLinea + 1, fin === -1 ? s.length : fin]);
  }
  const cuerpos = [];
  const enHeredoc = (i) => cuerpos.some(([a, b]) => i >= a && i < b);

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const n = s[i + 1];

    if (!q && enHeredoc(i)) { cerrar(); continue; }
    if (!q && candidatos.has(i)) cuerpos.push(candidatos.get(i));

    if (q === "$'") {
      // El citado ANSI-C (`$'…'`): la barra escapa lo que sigue, y `\'` es una comilla del texto, no el cierre. Leído
      // como una comilla simple común, el lector se desincroniza: invierte qué está entre comillas y puede abrir un
      // bloque `<<PALABRA` que está adentro de una cadena. La comilla y la barra escapadas quedan como el carácter; las
      // demás secuencias (`\n`, `\x62`) quedan escritas: el texto ya cuenta como armado por la terminal (`expande`).
      if (c === '\\' && n !== undefined) { texto += n === "'" || n === '\\' ? n : c + n; i++; continue; }
      if (c === "'") { q = null; continue; }
      texto += c;
      continue;
    }
    if (q) {
      // Entre comillas dobles la terminal sólo se come la barra delante de `$`, de una comilla invertida, de `"` y de
      // otra barra; delante de cualquier otra cosa la barra QUEDA (`"C:\Users\x"` se publica con sus barras). Sacarlas
      // todas esconde una ruta de máquina de Windows y deja ilegible la ruta de un archivo.
      if (c === '\\' && q === '"' && !ps && n !== undefined && /[$`"\\]/.test(n)) { texto += n; i++; continue; }
      if (c === q) { q = null; continue; }
      if (q === '"' && abreExpansion(c, n)) expande = true;
      texto += c;
      continue;
    }

    if (c === '"' || c === "'") {
      if (!abierta) { abierta = true; empezoLibre = false; }
      q = c;
      continue;
    }

    if ((c === '&' && n === '&') || (c === '|' && n === '|')) { cerrar(); out.push({ op: c + c }); i++; continue; }
    // 🔴 El `&` suelto (segundo plano) TAMBIÉN separa: `prog create --flag true & prog create`
    // son dos comandos, y juzgarlos como uno le regalaría al segundo las banderas del primero.
    // No confundirlo con las redirecciones: en `2>&1` el `&` viene
    // detrás de un `>`, y en `&>` lo precede.
    if (c === '&' && s[i - 1] !== '>' && n !== '>') { cerrar(); out.push({ op: '&' }); continue; }
    // Una sustitución de comandos ES un comando: `PR=$(prog create …)` tiene que juzgarse
    // igual que si estuviera suelto: si no, el mismo comando tendría veredictos opuestos según un espacio de más.
    if (c === '$' && n === '(') { cerrar(); out.push({ op: '$(' }); i++; continue; }
    if (c === '(' || c === ')' || c === '`') { cerrar(); out.push({ op: c }); continue; }
    if (c === ';' || c === '|' || c === '\n') { cerrar(); out.push({ op: c === '\n' ? '\n' : c }); continue; }
    if (c === ' ' || c === '\t' || c === '\r') { cerrar(); continue; }
    // Un comentario se descarta hasta el fin de línea. Sin esto, un `# don't …` deja una comilla
    // abierta que se traga el comando de la línea siguiente.
    if (c === '#' && !abierta) { while (i < s.length && s[i] !== '\n') i++; out.push({ op: '\n' }); continue; }
    if (c === '\\' && n !== undefined && !ps) { if (!abierta) { abierta = true; empezoLibre = true; } escapada = true; texto += n; i++; continue; }

    if (!abierta) { abierta = true; empezoLibre = true; }
    // `$'…'` abre el citado ANSI-C, con sus escapes (arriba). En PowerShell `$'` no es eso: sigue siendo `$` y una comilla
    // `$$` es el número del proceso: el `$` de atrás no abre nada, y una comilla que lo siga es una comilla simple común
    if (c === '$' && n === '$') { expande = true; partida = true; texto += '$$'; i++; continue; }
    if (c === '$' && n === "'" && !ps) { expande = true; texto += c; q = "$'"; i++; continue; }
    // fuera de comillas también `$'…'` y `$"…"`: el citado ANSI-C arma el texto (`$'\x62'` es una letra)
    if (abreExpansion(c, n)) { expande = true; partida = true; } else if (c === '$' && (n === "'" || n === '"')) expande = true;
    // `{a,b}` y `{a..c}` sin comillas: la terminal los abre en varias palabras (`-s{x,dev}` es `-sx -sdev`), también
    // con comillas adentro de las llaves, aunque lo citado lleve espacios (`-s{x,"dev"}`, `-s{"a b",dev}`)
    else if (c === '{' && LLAVES.test(s.slice(i))) { expande = true; partida = true; }
    texto += c;
  }
  cerrar();
  return out;
}

/**
 * Los segmentos del comando: cada comando se juzga solo, con SUS banderas — nunca
 * con las del vecino encadenado por `&&`, `;` o `|`. Devuelve arreglos de fichas. `opts.powershell`: lo escribió la
 * herramienta de PowerShell (ver `fichas`).
 */
function segmentos(cmd, opts = {}) {
  const out = [];
  let cur = [];
  let entreComillasInvertidas = false;
  for (const f of fichas(cmd, opts)) {
    if (f.op !== undefined) {
      // `sigueSustitucion`: el segmento termina donde abre una sustitución sin comillas, y lo que ella devuelva se suma a
      // sus argumentos
      const abre = f.op === '$(' || (f.op === '`' && !entreComillasInvertidas);
      if (f.op === '`') entreComillasInvertidas = !entreComillasInvertidas;
      if (cur.length) { if (abre) cur.sigueSustitucion = true; out.push(cur); }
      cur = [];
      continue;
    }
    cur.push(f);
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Valor de `--nombre` en un segmento, como lo entiende un lector de opciones al estilo argparse: el ÚLTIMO gana; formas
 * `--nombre valor`, `--nombre=valor` y `--nombre` a secas (que para las banderas de tres estados
 * vale `true`). Devuelve el valor TAL CUAL: un nombre de rama distingue mayúsculas, y el mensaje
 * del freno lo pega en una invocación que el dev copia. Lo booleano se compara con esCierto/esFalso,
 * que sí ignoran mayúsculas. `null` si no está. Sólo cuentan las fichas que empezaron fuera de
 * comillas: lo escrito dentro de un título no es una bandera.
 */
function flagDe(seg, nombre, corta = null) {
  const nombres = corta ? [`--${nombre}`, `-${corta}`] : [`--${nombre}`];
  let val = null;
  for (let i = 0; i < seg.length; i++) {
    const f = seg[i];
    if (!f.esBandera) continue;
    const igual = nombres.find((n) => f.texto === n || f.texto.startsWith(`${n}=`));
    if (!igual) continue;
    if (f.texto.startsWith(`${igual}=`)) { val = f.texto.slice(igual.length + 1); continue; }
    const sig = seg[i + 1];
    // Sin valor detrás, o con otra bandera detrás: forma corta — vale `true`.
    val = (!sig || (sig.esBandera && /^-/.test(sig.texto))) ? 'true' : sig.texto;
  }
  return val === null ? null : String(val);
}

/**
 * Valor de una bandera en todas las formas en que la lee un lector al estilo argparse: `--nombre valor`, `--nombre=valor`, un prefijo
 * (`--sour dev` es `--source-branch`), la corta separada (`-s dev`), con `=` (`-s=dev`) y pegada (`-sdev`). Gana la
 * última. Un prefijo que sirve para dos banderas lo rechaza el programa antes de correr, así que leerlo como ésta no deja pasar
 * nada. Devuelve `{ texto, literal }` o `null`. `literal` es falso si el valor lo arma la terminal (una expansión), si
 * trae un `*`, `?` o `[` (git no los admite en una rama) o si empieza con `@` (hay programas que lo leen de un archivo).
 * `flagDe` sigue leyendo sólo las formas largas y la corta separada: lo usan otros lectores que esto no cambia.
 *
 * `desde(seg)` elige las fichas que se miran: el lector de un conector le pasa sólo las de después de su programa (el
 * `-s` de `timeout -s KILL` no es el origen); sin él, el segmento entero. Lee también una bandera escrita entre
 * comillas (`'--source-branch' main`): la terminal saca las comillas y el programa la lee como bandera. Con un espacio
 * adentro, argparse decide por la forma: la corta sigue siendo bandera con el resto como valor (`'-s dev'` es ` dev`),
 * igual que la larga con `=`; la larga sin `=` (`'--title usá'`) es texto.
 */
const esOpcion = (t) => /^-[^-\s]/.test(t) || /^--[^=\s]*(?:=|$)/.test(t);
function valorDe(seg, nombre, corta = null, { desde = (s) => s } = {}) {
  const largo = `--${nombre}`;
  const esPrefijo = (n) => n.length > 2 && largo.startsWith(n);
  const leer = (texto, expande) => ({ texto: String(texto), literal: !expande && !/[*?[]/.test(texto) && !String(texto).startsWith('@') });
  const pedido = desde(seg);
  let val = null;
  for (let i = 0; i < pedido.length; i++) {
    const f = pedido[i];
    if (!esOpcion(f.texto)) continue;
    const t = f.texto;
    if (t.startsWith('--')) {
      const igual = t.indexOf('=');
      const n = igual === -1 ? t : t.slice(0, igual);
      if (!esPrefijo(n)) continue;
      if (igual !== -1) { val = leer(t.slice(igual + 1), f.expande); continue; }
    } else if (corta && t.startsWith(`-${corta}`) && !t.startsWith('--')) {
      const resto = t.slice(2);
      if (resto) { val = leer(resto.startsWith('=') ? resto.slice(1) : resto, f.expande); continue; }
    } else continue;
    const sig = pedido[i + 1];
    // Sin valor detrás, o con otra bandera detrás: forma corta — vale `true`.
    val = (!sig || esOpcion(sig.texto)) ? leer('true', false) : leer(sig.texto, sig.expande);
  }
  return val;
}

// Una palabra del comando: la que empezó fuera de comillas, o la citada sin espacios adentro (`'prog' sub "create"`
// es el mismo comando para la terminal). Un texto citado con espacios adentro, como el de un `echo`, no lo es.
const esPalabra = (f) => f.esBandera || !/\s/.test(f.texto);

const esCierto = (v) => v !== null && v !== undefined && CIERTO.has(String(v).toLowerCase());
const esFalso = (v) => v !== null && v !== undefined && FALSO.has(String(v).toLowerCase());

const pideAyuda = (seg) => seg.some((f) => f.esBandera && (f.texto === '--help' || f.texto === '-h'));

/**
 * Texto del segmento, para el mensaje del freno y la línea que deja en bypass.log. Es fiel: partido de nuevo con
 * `fichas`, da las mismas fichas (el texto y si empezó fuera de comillas). Entre comillas simples nada se lee de otra
 * forma —ni la barra, ni `$`, ni un salto de línea—, así que lo que no es un carácter común va ahí, con la comilla simple
 * de adentro como `'\''`. Una ficha libre deja afuera su primer carácter (escapado con la barra si hace falta), para
 * seguir empezando fuera de comillas.
 */
function textoDe(seg) {
  const simple = (t) => `'${t.replace(/'/g, "'\\''")}'`;
  const comun = (t) => /^[A-Za-z0-9_./:=,@%+-]*$/.test(t);
  return seg.map((f) => {
    const t = String(f.texto);
    if (!f.esBandera) return simple(t);
    if (comun(t)) return t;
    const primero = /[A-Za-z0-9_./:=,@%+-]/.test(t[0]) ? t[0] : `\\${t[0]}`;
    const resto = t.slice(1);
    return primero + (comun(resto) ? resto : simple(resto));
  }).join(' ');
}

/**
 * ¿El segmento arranca con el escape `TYCON_PR_BY_HAND=1` PEGADO al comando? Sólo así vale: desde
 * el entorno sería permanente y silencioso, y en cualquier otra parte del texto sería un accidente.
 * El nombre viejo de la variable sigue valiendo hasta el retiro y anota su uso.
 */
// Los nombres de cada variable de escape, pedidos al mapa de renombres una sola vez por proceso: la revisión de la noche
// llama a `tieneEscape` por cada pedido de cada comando, y cada consulta al mapa mira el disco y recorre el mapa entero.
const NOMBRES = new Map();
function tieneEscape(seg, nombre = 'TYCON_PR_BY_HAND') {
  const legacy = (() => { try { return require('./legacy-names.js'); } catch (_) { return null; } })();
  if (!NOMBRES.has(nombre)) NOMBRES.set(nombre, legacy ? legacy.envNames(nombre) : [nombre]);
  const nombres = NOMBRES.get(nombre);
  let i = 0;
  let visto = false;
  while (i < seg.length && seg[i].esBandera && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[i].texto)) {
    const [, val] = seg[i].texto.split(/=(.*)/s);
    const cual = nombres.find((n) => seg[i].texto.startsWith(`${n}=`));
    if (cual && CIERTO.has(String(val).toLowerCase())) {
      visto = true;
      if (cual !== nombre) legacy.recordUse({ kind: 'env', old: cual, new: nombre, script: 'scripts/lib/command-tokens.js' });
    }
    i++;
  }
  // Después de las variables puede venir `command` / `env` antes del binario: el escape vale igual.
  while (i < seg.length && seg[i].esBandera && /^(command|env)$/.test(seg[i].texto)) i++;
  return visto && i < seg.length;
}

module.exports = { fichas, segmentos, flagDe, valorDe, esOpcion, esPalabra, esCierto, esFalso, pideAyuda, textoDe, tieneEscape, sinBordes, CIERTO, FALSO };
