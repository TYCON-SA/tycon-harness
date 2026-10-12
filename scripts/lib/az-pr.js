'use strict';
/**
 * scripts/lib/az-pr.js — cómo leer un comando `az repos pr …` sin dejarse engañar.
 *
 * Nace con pr-auto-complete-guard.js (2026-09-03) después de que su primera versión, escrita con
 * el mismo regex de una línea que ya usaban pr-one-per-repo-guard.js y retro-pending.js, cayera en la
 * revisión adversarial por SEIS caminos distintos: una bandera escrita dentro del título contaba
 * como bandera; dos creaciones encadenadas con `&&` se juzgaban por las banderas de la primera;
 * la forma corta `--squash` (que para az vale `true`) se leía como su siguiente token; el último
 * valor repetido es el que toma az y el hook tomaba el primero; `--auto-complete yes` es válido
 * para az y el hook lo rechazaba; y una continuación de línea (`\` + salto) se leía como valor.
 *
 * 🔴 UN SOLO RECORRIDO DEL TEXTO (segunda revisión adversarial, el mismo día). La versión que
 * arregló esos seis tenía TRES recorridos con conciencia de comillas —partir en segmentos, vaciar
 * las cadenas, y el regex de cada bandera— y esa duplicación produjo su propio defecto: como las
 * banderas se buscaban sobre el texto YA vaciado, `--auto-complete "true"` (perfectamente válido
 * para az) se leía como vacío y quedaba BLOQUEADO. Un freno que corta el camino correcto se apaga.
 * Ahora el texto se recorre UNA vez y se parte en fichas; cada ficha sabe si empezó entre comillas,
 * que es lo único que hacía falta para distinguir «esto es una bandera» de «esto es el título que
 * la menciona».
 *
 * 🔴 Los tres hooks que miran `az repos pr` parseaban por su cuenta y ya divergían (el más viejo
 * deja pasar en silencio la forma `--org=…`). Éste es el lugar para que diverjan una sola vez.
 * Desde el 2026-09-06 los tres (pr-auto-complete-guard, pr-one-per-repo-guard, retro-pending) leen de acá
 * (AZ-PR-PARSER-UNICO-1), y los tres recorren TODOS los `pr create` de una cadena, no el primero.
 * Quien agregue un cuarto lector lo suma acá, no escribe otro regex.
 *
 * Qué NO resuelve, a propósito: sustitución de comandos (`$(…)`), heredocs, backticks. Un comando
 * armado así se juzga por lo que se ve; lo que se ve no puede decir "auto-complete" sin tenerlo.
 */

const CIERTO = new Set(['true', 't', 'yes', 'y', '1']);
const FALSO = new Set(['false', 'f', 'no', 'n', '0']);
const OPERADORES = new Set(['&&', '||', ';', '|', '\n']);

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
 * `expande` (story 8.26, tanda F1): la ficha trae algo que la terminal va a reemplazar antes de correr el comando
 * —`$nombre`, `${…}`, `$(…)` o comillas invertidas, fuera de comillas simples y sin barra delante—. Su `texto` es lo
 * escrito, no lo que va a llegar: quien necesita el texto de verdad (scripts/lib/gh-pr.js) lo da por ilegible. Los
 * lectores de `az` no lo miran.
 */
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
  let q = null;

  const cerrar = () => {
    if (abierta) out.push({ texto, esBandera: empezoLibre, expande });
    texto = ''; abierta = false; empezoLibre = false; expande = false;
  };
  // `$5`, `$@`, `$?` también se reemplazan (un parámetro de la terminal); un `$` suelto o al final, no
  // (`$[…]` es una cuenta en bash y zsh; `$=VAR`, `$~VAR`, `$^VAR`, `$+VAR` son de zsh, la terminal de una Mac)
  const abreExpansion = (c, n) => c === '`' || (c === '$' && n !== undefined && /[A-Za-z_{(0-9@*#?$!\-[=~^+]/.test(n));

  // Heredocs: `<<[-]['"]?PALABRA['"]?` … hasta la línea que sólo dice PALABRA. Todo eso es TEXTO.
  // 🔴 Sólo cuenta el `<<` que está FUERA de comillas (story 8.26, tanda F1): buscado en el texto crudo, un
  // `echo "ejemplo: cat <<EOF"` abría un bloque que no existe, y todo lo que seguía —los comandos de los renglones
  // de abajo— se tragaba como cuerpo. Por eso acá sólo se ANOTAN los candidatos, y cada uno se abre cuando el
  // recorrido llega a su `<<` sin estar adentro de una cadena. (`<<<` es un texto de entrada, no un bloque.)
  // El delimitador puede llevar una barra delante (`<<\EOF`) y guiones o puntos adentro (`<<'FIN-1'`). Y un `<<` adentro
  // de una cuenta (`$((1<<b))`) es un corrimiento de bits, no un bloque.
  const candidatos = new Map();
  for (const m of s.matchAll(/(?<!<)<<(?!<)-?\s*(["']?)\\?([A-Za-z_][A-Za-z0-9_.-]*)\1/g)) {
    const finLinea = s.indexOf('\n', m.index);
    if (finLinea === -1) continue;
    const antes = s.slice(s.lastIndexOf('\n', m.index) + 1, m.index);
    if (antes.split('((').length > antes.split('))').length) continue;
    const cierre = new RegExp(`^[\\t ]*${m[2].replace(/[.\\-]/g, '\\$&')}[\\t ]*$`, 'm');
    const resto = s.slice(finLinea + 1);
    const fin = resto.search(cierre);
    candidatos.set(m.index, [finLinea + 1, fin === -1 ? s.length : finLinea + 1 + fin]);
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
      // todas escondía una ruta de máquina de Windows, y dejaba ilegible la ruta de un archivo.
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
    // son dos comandos, y juzgarlos como uno le regalaba al segundo las banderas del primero
    // (segunda revisión adversarial). No confundirlo con las redirecciones: en `2>&1` el `&` viene
    // detrás de un `>`, y en `&>` lo precede.
    if (c === '&' && s[i - 1] !== '>' && n !== '>') { cerrar(); out.push({ op: '&' }); continue; }
    // Una sustitución de comandos ES un comando: `PR=$(az repos pr create …)` tiene que juzgarse
    // igual que si estuviera suelto (3ª revisión: pasaba, y con un espacio de más bloqueaba —
    // el mismo comando con veredicto opuesto delataba que era un accidente, no una decisión).
    if (c === '$' && n === '(') { cerrar(); out.push({ op: '$(' }); i++; continue; }
    if (c === '(' || c === ')' || c === '`') { cerrar(); out.push({ op: c }); continue; }
    if (c === ';' || c === '|' || c === '\n') { cerrar(); out.push({ op: c === '\n' ? '\n' : c }); continue; }
    if (c === ' ' || c === '\t' || c === '\r') { cerrar(); continue; }
    // Un comentario se descarta hasta el fin de línea. Sin esto, un `# don't …` dejaba una comilla
    // abierta que se tragaba el `az repos pr create` de la línea siguiente (2ª revisión adversarial).
    if (c === '#' && !abierta) { while (i < s.length && s[i] !== '\n') i++; out.push({ op: '\n' }); continue; }
    if (c === '\\' && n !== undefined && !ps) { if (!abierta) { abierta = true; empezoLibre = true; } texto += n; i++; continue; }

    if (!abierta) { abierta = true; empezoLibre = true; }
    // fuera de comillas también `$'…'` y `$"…"`: el citado ANSI-C arma el texto (`$'\x62'` es una letra)
    if (abreExpansion(c, n) || (c === '$' && (n === "'" || n === '"'))) expande = true;
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

const esCierto = (v) => v !== null && v !== undefined && CIERTO.has(String(v).toLowerCase());
const esFalso = (v) => v !== null && v !== undefined && FALSO.has(String(v).toLowerCase());

/**
 * `az [opciones globales] repos pr <verbo>` leído de las fichas sueltas: un `echo "az repos pr
 * create"` no cuenta, y `az -o json repos pr create` sí — az acepta sus opciones globales antes
 * del grupo, y exigir las cuatro palabras pegadas dejaba pasar esa forma (2ª revisión adversarial).
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
 * Un `echo "az repos pr create"` NO entra acá: echo no ejecuta nada. (2ª revisión adversarial.)
 */
function pasaCodigoAUnInterprete(seg) {
  const nombre = /(^|\/|\\)(ba|z|k|da)?sh(\.exe)?$|(^|\/|\\)python3?(\.exe)?$|^eval$|^source$/i;
  for (let i = 0; i < seg.length; i++) {
    if (!seg[i].esBandera || !nombre.test(seg[i].texto)) continue;
    if (seg.slice(i + 1).some((f) => !f.esBandera && /\baz(?:\.cmd|\.exe)?\s+(?:-\S+\s+\S*\s+)*repos\s+pr\s+(?:create|update)\b/i.test(f.texto))) return true;
  }
  return false;
}

const pideAyuda = (seg) => seg.some((f) => f.esBandera && (f.texto === '--help' || f.texto === '-h'));


/** Texto legible del segmento, para el mensaje del freno. */
const textoDe = (seg) => seg.map((f) => (f.esBandera ? f.texto : `"${f.texto}"`)).join(' ');

/**
 * ¿El segmento arranca con el escape `TYCON_PR_BY_HAND=1` PEGADO al comando? Sólo así vale: desde
 * el entorno sería permanente y silencioso, y en cualquier otra parte del texto sería un accidente.
 * El nombre viejo de la variable (story 8.9, tanda B1) sigue valiendo hasta el retiro y anota su uso.
 */
function tieneEscape(seg, nombre = 'TYCON_PR_BY_HAND') {
  const legacy = (() => { try { return require('./legacy-names.js'); } catch (_) { return null; } })();
  const nombres = legacy ? legacy.envNames(nombre) : [nombre];
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
 * un `az repos pr \<salto> create` esquivaba el filtro y con él al hook entero (2ª revisión
 * adversarial). Y NO nombra al binario a propósito: pedir `az` pegado a `repos` volvía a esquivarlo
 * con `az -o json repos pr create`, que az acepta. Es un superconjunto barato — quien decide de
 * verdad es `verboDePr` sobre las fichas.
 */
const pareceAzPr = (cmd) => /\brepos\s+pr\s+(?:create|update)\b/i
  .test(String(cmd || '').replace(/\\\r?\n/g, ' '));

module.exports = { fichas, pareceAzPr, segmentos, flagDe, esCierto, esFalso, verboDePr, pasaCodigoAUnInterprete, pideAyuda, textoDe, tieneEscape };
