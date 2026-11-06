'use strict';
/**
 * scripts/lib/az-pr.js — cómo leer un comando `az repos pr …` sin dejarse engañar.
 *
 * Lo comparten pr-auto-complete-guard.js, pr-one-per-repo-guard.js y retro-pending.js. Un regex de una línea por hook
 * se equivoca en seis cosas: una bandera escrita dentro del título cuenta como bandera; dos creaciones encadenadas con
 * `&&` se juzgan por las banderas de la primera; la forma corta `--squash` (que para az vale `true`) se lee como su
 * siguiente token; el último valor repetido es el que toma az, no el primero; `--auto-complete yes` es válido para az;
 * y una continuación de línea (`\` + salto) no es un valor.
 *
 * 🔴 UN SOLO RECORRIDO DEL TEXTO. Con varios recorridos con conciencia de comillas —partir en segmentos, vaciar las
 * cadenas, buscar cada bandera— las banderas se buscarían sobre el texto ya vaciado, y `--auto-complete "true"`
 * (válido para az) se leería como vacío y quedaría BLOQUEADO. Un freno que corta el camino correcto se apaga.
 * Por eso el texto se recorre UNA vez y se parte en fichas; cada ficha sabe si empezó entre comillas, que es lo único
 * que hace falta para distinguir «esto es una bandera» de «esto es el título que la menciona».
 *
 * 🔴 Los tres hooks leen de acá, para que el criterio no diverja, y los tres recorren TODOS los `pr create` de una
 * cadena, no el primero. Quien agregue un cuarto lector lo suma acá, no escribe otro regex.
 *
 * Qué NO resuelve, a propósito: sustitución de comandos (`$(…)`), heredocs, backticks. No los expande: en una bandera
 * que el freno juzga, un valor así es ilegible y es una falta (`valorDe`), y lo que se ve no puede decir
 * "auto-complete" sin tenerlo.
 */

const CIERTO = new Set(['true', 't', 'yes', 'y', '1']);
const FALSO = new Set(['false', 'f', 'no', 'n', '0']);

/**
 * Parte el comando en FICHAS y operadores, en un solo recorrido.
 *
 * Cada ficha es `{ texto, esBandera }`: `texto` es el contenido ya sin comillas, y `esBandera`
 * dice si la ficha EMPEZÓ fuera de comillas — lo único que separa una bandera de verdad
 * (`--squash false`) de un título que la nombra (`--title "usá --squash false"`). Un valor entre
 * comillas (`--auto-complete "true"`) es un valor normal: las comillas no lo cambian.
 *
 * `\` + salto de línea se quita (así lo lee la terminal): un comando partido en varias líneas es UN comando.
 *
 * `expande`: la ficha trae algo que la terminal va a reemplazar antes de correr el comando
 * —`$nombre`, `${…}`, `$(…)` o comillas invertidas, fuera de comillas simples y sin barra delante—. Su `texto` es lo
 * escrito, no lo que va a llegar: quien necesita el texto de verdad (scripts/lib/gh-pr.js) lo da por ilegible.
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

// `{…,…}` o `{…..…}` sin comillas, con partes citadas adentro (lo citado puede llevar espacios y llaves).
const LLAVES = /^\{(?:[^{}\s"']|"[^"]*"|'[^']*')*(?:,|\.\.)(?:[^{}\s"']|"[^"]*"|'[^']*')*\}/;

function fichas(cmd, opts = {}) {
  // `powershell`: el comando lo escribió la herramienta de PowerShell. Ahí la barra invertida NO escapa nada (es parte
  // de las rutas: `C:\tools\gh.exe`) y el renglón se continúa con una comilla invertida, no con una barra.
  const ps = Boolean(opts && opts.powershell);
  // la barra al final del renglón se QUITA junto con el salto, como hace la terminal: `cre\<salto>ate` es `create` y
  // `g\<salto>h` es `gh` (con un espacio en su lugar eran dos palabras, y el comando partido así no se reconocía)
  const s = String(cmd || '').replace(ps ? /`\r?\n/g : /\\\r?\n/g, '');
  const out = [];
  let texto = '';
  let abierta = false;      // hay ficha en curso
  let empezoLibre = false;  // …y empezó fuera de comillas
  let expande = false;      // …y trae una expansión de la terminal
  let partida = false;      // …fuera de comillas
  let q = null;

  const cerrar = () => {
    if (abierta) out.push({ texto, esBandera: empezoLibre, expande, partida });
    texto = ''; abierta = false; empezoLibre = false; expande = false; partida = false;
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
    // 🔴 El `&` suelto (segundo plano) TAMBIÉN separa: `az … create --auto-complete true & az … create`
    // son dos comandos, y juzgarlos como uno le regalaría al segundo las banderas del primero.
    // No confundirlo con las redirecciones: en `2>&1` el `&` viene
    // detrás de un `>`, y en `&>` lo precede.
    if (c === '&' && s[i - 1] !== '>' && n !== '>') { cerrar(); out.push({ op: '&' }); continue; }
    // Una sustitución de comandos ES un comando: `PR=$(az repos pr create …)` tiene que juzgarse
    // igual que si estuviera suelto: si no, el mismo comando tendría veredictos opuestos según un espacio de más.
    if (c === '$' && n === '(') { cerrar(); out.push({ op: '$(' }); i++; continue; }
    if (c === '(' || c === ')' || c === '`') { cerrar(); out.push({ op: c }); continue; }
    if (c === ';' || c === '|' || c === '\n') { cerrar(); out.push({ op: c === '\n' ? '\n' : c }); continue; }
    if (c === ' ' || c === '\t' || c === '\r') { cerrar(); continue; }
    // Un comentario se descarta hasta el fin de línea. Sin esto, un `# don't …` deja una comilla
    // abierta que se traga el `az repos pr create` de la línea siguiente.
    if (c === '#' && !abierta) { while (i < s.length && s[i] !== '\n') i++; out.push({ op: '\n' }); continue; }
    if (c === '\\' && n !== undefined && !ps) { if (!abierta) { abierta = true; empezoLibre = true; } texto += n; i++; continue; }

    if (!abierta) { abierta = true; empezoLibre = true; }
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
 * Los segmentos del comando: cada `az repos pr create` se juzga solo, con SUS banderas — nunca
 * con las del vecino encadenado por `&&`, `;` o `|`. Devuelve arreglos de fichas.
 */
function segmentos(cmd) {
  const out = [];
  let cur = [];
  for (const f of fichas(cmd)) {
    if (f.op !== undefined) { if (cur.length) out.push(cur); cur = []; continue; }
    cur.push(f);
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Valor de `--nombre` en un segmento, como lo entiende az (argparse): el ÚLTIMO gana; formas
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
    // Sin valor detrás, o con otra bandera detrás: forma corta — para az vale `true`.
    val = (!sig || (sig.esBandera && /^-/.test(sig.texto))) ? 'true' : sig.texto;
  }
  return val === null ? null : String(val);
}

/**
 * Valor de una bandera en todas las formas en que la lee az (argparse): `--nombre valor`, `--nombre=valor`, un prefijo
 * (`--sour dev` es `--source-branch`), la corta separada (`-s dev`), con `=` (`-s=dev`) y pegada (`-sdev`). Gana la
 * última. Un prefijo que sirve para dos banderas lo rechaza az antes de correr, así que leerlo como ésta no deja pasar
 * nada. Devuelve `{ texto, literal }` o `null`. `literal` es falso si el valor lo arma la terminal (una expansión), si
 * trae un `*`, `?` o `[` (git no los admite en una rama) o si empieza con `@` (az lo lee de un archivo).
 * `flagDe` sigue leyendo sólo las formas largas y la corta separada: lo usan otros lectores que esto no cambia.
 *
 * Mira sólo lo que va después del `az` del pedido (`delPedido`): el `-s` de `timeout -s KILL` no es el origen. Y lee
 * también una bandera escrita entre comillas (`'--delete-source-branch' true`): la terminal saca las comillas y az la
 * lee como bandera. Con un espacio adentro, argparse decide por la forma: la corta sigue siendo bandera con el resto
 * como valor (`'-s dev'` es el origen ` dev`), igual que la larga con `=` (`'--source-branch= main'`); la larga sin
 * `=` (`'--title usá'`) es texto.
 */
const esOpcion = (t) => /^-[^-\s]/.test(t) || /^--[^=\s]*(?:=|$)/.test(t);
function valorDe(seg, nombre, corta = null) {
  const largo = `--${nombre}`;
  const esPrefijo = (n) => n.length > 2 && largo.startsWith(n);
  const leer = (texto, expande) => ({ texto: String(texto), literal: !expande && !/[*?[]/.test(texto) && !String(texto).startsWith('@') });
  const pedido = delPedido(seg);
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
    // Sin valor detrás, o con otra bandera detrás: forma corta — para az vale `true`.
    val = (!sig || esOpcion(sig.texto)) ? leer('true', false) : leer(sig.texto, sig.expande);
  }
  return val;
}

/** Las fichas que van después del `az` del pedido (`az [globales] repos pr <verbo> …`), o el segmento entero si no lo hay. */
function delPedido(seg) {
  for (let i = 0; i < seg.length; i++) {
    if (seg[i].esBandera && /(^|\/|\\)az(\.cmd|\.exe)?$/i.test(seg[i].texto) && verboDePr(seg.slice(i))) return seg.slice(i + 1);
  }
  return seg;
}

const esCierto = (v) => v !== null && v !== undefined && CIERTO.has(String(v).toLowerCase());
const esFalso = (v) => v !== null && v !== undefined && FALSO.has(String(v).toLowerCase());

/**
 * `az [opciones globales] repos pr <verbo>` leído de las fichas sueltas: un `echo "az repos pr
 * create"` no cuenta, y `az -o json repos pr create` sí — az acepta sus opciones globales antes
 * del grupo, y exigir las cuatro palabras pegadas dejaría pasar esa forma.
 * El binario puede venir con ruta, con `.cmd`/`.exe` y en cualquier caja (macOS no distingue).
 */
function verboDePr(seg) {
  const libres = seg.filter((f) => f.esBandera).map((f) => f.texto);
  for (let i = 0; i < libres.length; i++) {
    if (!/(^|\/|\\)az(\.cmd|\.exe)?$/i.test(libres[i])) continue;
    let j = i + 1;
    // saltear opciones globales (`-o json`, `--output=json`, `--only-show-errors`, …)
    while (j < libres.length && /^-/.test(libres[j])) {
      const pegado = libres[j].includes('=');
      j++;
      if (!pegado && j < libres.length && !/^-/.test(libres[j]) && libres[j] !== 'repos') j++;
    }
    if (libres[j] === 'repos' && libres[j + 1] === 'pr' && libres[j + 2]) return libres[j + 2];
  }
  return null;
}

/**
 * ¿El segmento le pasa CÓDIGO a un intérprete? (`bash -c "…"`, `sh -c`, `eval`, `python3 -c`). Ahí
 * el `az repos pr create` viaja adentro de una cadena y ninguna ficha lo delata: no se puede juzgar
 * lo que se ejecuta, así que quien llama decide (este freno lo trata como «no pude mirar» y frena).
 * Un `echo "az repos pr create"` NO entra acá: echo no ejecuta nada.
 */
function pasaCodigoAUnInterprete(seg) {
  const nombre = /(^|\/|\\)(ba|z|k|da)?sh(\.exe)?$|(^|\/|\\)python3?(\.exe)?$|^eval$|^source$/i;
  for (let i = 0; i < seg.length; i++) {
    if (!seg[i].esBandera || !nombre.test(seg[i].texto)) continue;
    if (seg.slice(i + 1).some((f) => !f.esBandera && /\baz(?:\.cmd|\.exe)?\s+(?:-\S+(?:\s+[^\s-]\S*)?\s+)*repos\s+pr\s+(?:create|update)\b/i.test(f.texto))) return true;
  }
  return false;
}

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
      if (cual !== nombre) legacy.recordUse({ kind: 'env', old: cual, new: nombre, script: 'scripts/lib/az-pr.js' });
    }
    i++;
  }
  // Después de las variables puede venir `command` / `env` antes del binario: el escape vale igual.
  while (i < seg.length && seg[i].esBandera && /^(command|env)$/.test(seg[i].texto)) i++;
  return visto && i < seg.length;
}

/**
 * Filtro barato para descartar de una un comando que no tiene nada que ver. Mira el texto YA unido:
 * un `az repos pr \<salto> create` esquivaría el filtro y con él al hook entero. Y NO nombra al binario a
 * propósito: pedir `az` pegado a `repos` lo esquivaría
 * con `az -o json repos pr create`, que az acepta. Es un superconjunto barato — quien decide de
 * verdad es `verboDePr` sobre las fichas.
 */
const pareceAzPr = (cmd) => /\brepos\s+pr\s+(?:create|update)\b/i
  .test(String(cmd || '').replace(/\\\r?\n/g, ' '));

const ROMPE_SQUASH = 'los commits desaparecen de main y las notas de versión colapsan a una línea';
const A_MAIN = /^(?:refs\/heads\/)?(?:main|master)$/i;

/**
 * Las ramas de origen que NO se borran al completar un pedido. La lista declarada es la de §9b.4 del paso de merge
 * (`skills/tycon-merge-to-main/steps/step-09b-create-change-request.md`, «Ramas de larga vida»); ésta es su copia para
 * el freno, y `scripts/tests/pr-auto-complete-guard.test.sh` falla si las dos difieren. Cualquier otra rama de origen
 * es efímera: si el pedido no la borra, queda viva después del merge y se acumula.
 */
const RAMAS_DE_LARGA_VIDA = Object.freeze(['dev', 'develop', 'main', 'master']);
// Azure DevOps no distingue mayúsculas en los nombres de rama: `-s DEV` es `dev`, y `Refs/Heads/main` es `main`. Los
// espacios de los costados no cuentan: `-s ' dev'` se compara como `dev`, así frena de más y nunca de menos.
const esDeLargaVida = (rama) => RAMAS_DE_LARGA_VIDA.includes(String(rama).trim().replace(/^refs\/heads\//i, '').toLowerCase());

const ilegible = (bandera, v) => `no puedo leer \`${bandera} ${v.texto}\`: lo arma la terminal, trae un comodín o az lo lee de un archivo, y lo que no pude leer no está aprobado. Escribí el valor`;

/**
 * La falta de un pedido que se crea sobre «borrar la rama al completar», o null. `borrar` y `origen` son lo que da
 * `valorDe`. Ningún «sin falta» sale antes de ver la rama: con `true` desde `dev`, la plataforma borraría `dev`.
 */
function faltaDeBorrarRama(borrar, origen) {
  const regla = '`true` desde una rama efímera escrita con `-s`, o `false` desde dev, develop, main o master';
  if (borrar === null) return `sin \`--delete-source-branch\` explícito: la rama queda viva después del merge. Va ${regla}`;
  if (!borrar.literal) return ilegible('--delete-source-branch', borrar);
  if (!esCierto(borrar.texto) && !esFalso(borrar.texto)) return `con \`--delete-source-branch ${borrar.texto}\`: no es un valor que entienda. Va ${regla}`;
  const cierto = esCierto(borrar.texto);
  if (origen === null) {
    return cierto
      ? 'con `--delete-source-branch true` y sin `--source-branch`: az toma la rama actual, que puede ser dev. Escribí la rama'
      : 'con `--delete-source-branch false` y sin `--source-branch`: no puedo ver si la rama es de larga vida. Escribí la rama';
  }
  if (!origen.literal) return ilegible('--source-branch', origen);
  const larga = esDeLargaVida(origen.texto);
  if (cierto && larga) return `con \`--delete-source-branch true\` desde \`${origen.texto}\`: la plataforma borraría \`${origen.texto}\` al completar, sin vuelta atrás. Desde una rama de larga vida va \`false\``;
  if (!cierto && !larga) return `con \`--delete-source-branch false\` desde \`${origen.texto}\`: la rama queda viva después del merge. Va ${regla}`;
  return null;
}

/**
 * Lo mismo para un `update`, que no dice la rama de origen (az no acepta `--source-branch` ahí): con `true` el freno no
 * puede ver si borraría `dev`, así que frena. Ver la rama pidiéndosela a Azure es la historia 8.225.
 */
function faltaDeBorrarRamaUpdate(borrar, publica) {
  const regla = 'va `--delete-source-branch false`: el `update` no dice la rama de origen, así que `true` no lo puedo juzgar. Si no, el skill de merge, o el escape';
  if (borrar === null) return publica ? `publica un borrador sin \`--delete-source-branch\` explícito: ${regla}` : null;
  if (!borrar.literal) return ilegible('--delete-source-branch', borrar);
  if (esCierto(borrar.texto)) return `con \`--delete-source-branch true\`: ${regla}`;
  if (!esFalso(borrar.texto)) return `con \`--delete-source-branch ${borrar.texto}\`: no es un valor que entienda; ${regla}`;
  return null;
}

/**
 * Una ficha del pedido con una expansión fuera de comillas: la terminal la parte en palabras y puede meter una bandera.
 * Lo de antes del `az` no cuenta: el lado derecho de `VAR=$X az …` no se parte.
 */
const partidas = (seg) => delPedido(seg).filter((f) => f.partida).map((f) => `\`${f.texto}\` lo arma la terminal fuera de comillas: puede meter una bandera que no veo, y lo que no pude leer no está aprobado. Ponelo entre comillas o escribí el valor`)
  .concat(fantasmas(seg));

// Las banderas de az que leen un valor sólo si el que sigue no parece otra bandera (`--draft "$F" true`): detrás de
// ellas una expansión puede ser la bandera siguiente.
const OPCIONALES = ['auto-complete', 'squash', 'delete-source-branch', 'draft', 'bypass-policy', 'transition-work-items'];
const esOpcional = (t) => t.startsWith('--') && t.length > 2 && OPCIONALES.some((n) => `--${n}`.startsWith(t));

/**
 * Una expansión, aunque esté entre comillas, puesta donde az espera una bandera: `"$F" dev` o `"--delete-source-$X" true`
 * puede ser cualquier bandera, y lo que no se lee no está aprobado. Sólo se salva el valor de una bandera que lo exige
 * (`--title "$T"`): si la terminal lo convierte en bandera, az falla en vez de correr.
 */
function fantasmas(seg) {
  const pedido = delPedido(seg);
  const out = [];
  pedido.forEach((f, i) => {
    // Sólo si la expansión puede cambiar el NOMBRE: `--title=x"$T"` o `-s"$X"` tienen la bandera escrita.
    if (!f.expande || f.partida || !/^(?:[$`]|-[$`]|--[^=]*[$`])/.test(f.texto)) return;
    const prev = pedido[i - 1];
    if (prev && esOpcion(prev.texto) && !prev.texto.includes('=') && !esOpcional(prev.texto)) return;
    out.push(`no puedo leer \`${f.texto}\`: una expansión donde va una bandera puede ser cualquier bandera, y lo que no pude leer no está aprobado. Escribí la bandera`);
  });
  return out;
}

/**
 * La regla del freno de pedidos sobre UN segmento, sin mirar el escape: `{ verbo, juzgado, borrador, faltas }`.
 * `juzgado: false` es un segmento que la regla no mira (otro verbo, un pedido que no va a main, un borrador recién
 * creado: `borrador: true`). Un segmento juzgado sin `faltas` cumple la regla. La usan el freno (que agrega el escape,
 * el pedido de ayuda y el código pasado a un intérprete) y la revisión nocturna de las ejecuciones, que con ella sabe
 * si un pedido armado con el escape lo necesitaba.
 */
function faltasDe(seg) {
  const verbo = verboDePr(seg);
  const res = { verbo, juzgado: false, borrador: false, faltas: [] };
  if (verbo !== 'create' && verbo !== 'update') return res;
  // Lo que se juzga se lee como lo lee az, y lo que no se puede leer es una falta (`valorDe`).
  const v = {
    autoComplete: valorDe(seg, 'auto-complete'), squash: valorDe(seg, 'squash'), draft: valorDe(seg, 'draft'),
    destino: valorDe(seg, 'target-branch', 't'), borrar: valorDe(seg, 'delete-source-branch'),
  };
  const ilegibles = [['--auto-complete', v.autoComplete], ['--squash', v.squash], ['--draft', v.draft], ['--target-branch', v.destino]]
    .filter(([, x]) => x && !x.literal).map(([b, x]) => ilegible(b, x));
  const autoComplete = v.autoComplete && v.autoComplete.literal ? v.autoComplete.texto : null;
  const squash = v.squash && v.squash.literal ? v.squash.texto : null;
  const draft = v.draft && v.draft.literal ? v.draft.texto : null;
  if (verbo === 'create') {
    // Sólo los que van a main: el skill es el camino de esa rama. Un destino ilegible puede ser main.
    // Una ficha partida va antes que todo: puede meter `--target-branch main` o `--draft false` detrás de lo que se ve,
    // y en az gana la última.
    const partes = partidas(seg);
    if (partes.length) { res.juzgado = true; res.faltas.push(...partes); }
    if (!partes.length && v.destino && v.destino.literal && !A_MAIN.test(v.destino.texto)) return res;
    if (!partes.length && esCierto(draft)) { res.borrador = true; return res; }
    res.juzgado = true;
    res.faltas.push(...ilegibles);
    if (v.autoComplete && !v.autoComplete.literal) return res;
    if (!esCierto(autoComplete)) res.faltas.push('sin `--auto-complete true`: el PR queda abierto para siempre, nadie lo completa');
    if (v.squash === null) res.faltas.push(`sin \`--squash false\` explícito: la estrategia la decide la política de la rama, y si es squash ${ROMPE_SQUASH}`);
    else if (v.squash.literal && !esFalso(squash)) res.faltas.push(`con \`--squash ${squash}\`: ${ROMPE_SQUASH}`);
    // Sólo con auto-completar: sin él ya hay una falta, y la rama no se borra porque el pedido no se completa solo.
    if (esCierto(autoComplete)) {
      const falta = faltaDeBorrarRama(v.borrar, valorDe(seg, 'source-branch', 's'));
      if (falta) res.faltas.push(falta);
    }
    return res;
  }
  res.juzgado = true;
  // Una ficha partida es falta en todo `update`: puede meter `--delete-source-branch true` que no se ve.
  res.faltas.push(...ilegibles, ...partidas(seg));
  if (esFalso(autoComplete)) res.faltas.push('apaga el auto-complete de un PR ya creado: queda abierto para siempre');
  if (esCierto(squash)) res.faltas.push(`prende el squash de un PR ya creado: ${ROMPE_SQUASH}`);
  // Publicar un borrador es CREARLO de verdad: la tercera puerta al mismo resultado.
  const publica = esFalso(draft);
  if (publica) {
    if (!esCierto(autoComplete)) res.faltas.push('publica un borrador (`--draft false`) sin `--auto-complete true`: queda un PR normal que nadie completa');
    if (squash === null || !esFalso(squash)) res.faltas.push('publica un borrador sin `--squash false` explícito: la estrategia la decide la política de la rama');
  }
  // El borrador se creó sin que el freno lo juzgara, y el `update` no dice la rama: publicar pide la bandera, y `true`
  // frena siempre. Un `update` común sin la bandera no se mira: az conserva la opción que el pedido ya tenía
  // (`update_pull_request` parte de `existing_pr.completion_options`).
  const falta = faltaDeBorrarRamaUpdate(v.borrar, publica && esCierto(autoComplete));
  if (falta) res.faltas.push(falta);
  return res;
}

module.exports = { fichas, pareceAzPr, segmentos, flagDe, esCierto, esFalso, verboDePr, pasaCodigoAUnInterprete, pideAyuda, textoDe, tieneEscape, faltasDe, ROMPE_SQUASH, RAMAS_DE_LARGA_VIDA };
