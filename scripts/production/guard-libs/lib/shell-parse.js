'use strict';
/**
 * shell-parse.js — leer un comando de shell como lo leería el shell, sin ejecutarlo.
 *
 * POR QUÉ EXISTE (2026-09-15, story 6.1): estas piezas estaban en dos hooks distintos —
 * `failed-query-notice.js` (que las exportaba) y `session-collision-guard.js` (que las tenía
 * copiadas sin exportar)— y el freno de producción necesitaba las dos. Una tercera copia era el
 * patrón que este repo ya pagó caro con `release-notes.sh` en 8 repos: ocho copias que divergieron
 * y nadie las mantenía iguales. Definición en un solo lugar; los consumidores la requieren.
 *
 * Los hooks que la usan tienen sus casos en el banco (`14-retro-pending`, `38-session-collision-guard`,
 * `39-consulta-fallida-notice`, `40-prod-access-guard`): ésa es la red, y se corre al tocar este archivo.
 *
 * STORY 8.14 (2026-10-03) — EL PARTIDOR NO PARTE PALABRAS Y HAY UN EXPANSOR. El partidor cortaba en
 * `{`, `}`, `(` y `)` aunque fueran parte de una palabra: `rm -f …/production-{index,memory}.json` le
 * llegaba al freno como `…/production-`, `index,memory` y `.json`, y la escritura pasaba. Ahora:
 *  - `segmentos()` / `lex()` cortan por PROFUNDIDAD: un grupo `{ …; }` se abre en posición de comando y
 *    se cierra con su `}`; una subshell `( … )` se abre en posición de comando; `$( … )`, `<( … )`,
 *    `>( … )` y la comilla invertida siguen cortando como antes; dentro de una palabra (`a{b,c}`,
 *    `a(b|c)`, `x(N)`, `a=(x y)`, `${(j::)a}`) nada corta. Los patrones de un `case` (`a|b)`) no son
 *    tubería ni subshell. Una comilla escapada fuera de comillas (`\"`, `\'`) no abre comillas.
 *  - `expandWord()` expande UNA palabra como zsh y como bash 3.2 (la unión): llaves y rangos,
 *    alternancia de zsh, calificadores, `$'…'`, `$"…"`, variables y arreglos del propio comando, `~`.
 *    MISMO CONTRATO QUE `expandir`: lo que no resuelve es DESCONOCIDO y vale `*`, nunca «nada».
 *  - `parseSimpleCommand()` separa asignaciones, palabras y TODAS las redirecciones con su operador.
 *  - El presupuesto de expansiones es GLOBAL por comando (`ExpansionBudget`, 4.096) y se calcula ANTES
 *    de generar: una palabra con un rango enorme no se materializa.
 *
 * LÍMITES CONOCIDOS (no son bugs, son el contrato):
 *  - `expandir` no entiende `${VAR:-x}`, ni `$(…)`, ni comillas anidadas: ante algo sin resolver
 *    devuelve `null`, que quien llama tiene que tratar como «no sé» (en el freno: desconocido).
 *  - `variablesDelComando` es un regex sobre el texto: una asignación dentro de un `echo` entra
 *    igual. Falla hacia «sé de más», nunca hacia «no vi nada».
 *  - `tokens` PIERDE las comillas: sirve para saber qué palabra es, no para reconstruir el comando.
 *    Quien necesite distinguir `'…'` de `"…"` (la forma canónica de la puerta) mira el texto crudo.
 *  - `expandWord` no ejecuta nada: no sabe qué archivos existen (un comodín queda como comodín), ni
 *    qué devuelve una sustitución (`$(…)` es desconocido), ni el valor de una variable del entorno
 *    que el comando no define (desconocido, salvo lo que quien llama le pase en `ctx.env`).
 *  - Las rarezas de zsh con `..` que no es un rango (`{1..}` → `1..`) se leen como las dos cosas.
 *  - Los patrones de un `case` no salen en ningún segmento: se comparan contra un valor, no se
 *    ejecutan ni nombran archivos.
 *  - El cuerpo de un heredoc que no alimenta a un shell es texto y se quita; si la palabra no lleva comillas, sus `$(…)`
 *    y comillas invertidas (que zsh y bash sí ejecutan) quedan como comandos, cada uno en su línea.
 *  - El relleno de ceros de un rango sigue a bash y al caso común de zsh; las rarezas de zsh (`{-0..3}`, `{2..5..02}`,
 *    `{01..001}`) no. Ningún nombre protegido lleva dígitos (pase adversarial #38).
 *  - Un carácter de control 0x01 o 0x02 dentro de `$'…'` se lee como «desconocido» (`*`): son las marcas internas.
 */
const os = require('os');

// ── 1. cortar el comando en segmentos (fuera de comillas, sin heredocs) ───────────────────────
// `{ salvoShell: true }` (2026-09-17, retro-pending.js): conserva el cuerpo cuando el heredoc alimenta a
// un SHELL (`bash <<EOF`, `cat <<EOF | sh`) —ahí el cuerpo SON comandos— y lo quita en el resto
// (`node - <<EOF`, `cat > f <<EOF`, `python3 - <<EOF`), donde es texto. Sin la opción, todo igual que siempre.
const SHELL_ANTES = /(?:^|[\s;&|(])(?:sudo\s+)?(?:\S*\/)?(?:bash|sh|zsh|dash|ksh)(?:\s+-[A-Za-z]+)*\s*$/;
const SHELL_DESPUES = /\|\s*(?:sudo\s+)?(?:\S*\/)?(?:bash|sh|zsh|dash|ksh)(?=\s|$)/;

// El operador de un heredoc con su palabra, como la escribe el shell: `EOF`, `'EOF'`, `"EOF"`, `\EOF`, `E"OF"`, `'E'OF`.
// Sin `<<<`: eso es una cadena, no un heredoc.
const OPERADOR_HEREDOC = /(?<!<)<<(?!<)-?[ \t]*((?:[^\s'"<>|&;()\\]|\\[^\n]|\$?'[^'\n]*'|\$?"(?:[^"\\\n]|\\[^\n])*")+)/g;

/**
 * El delimitador que usa el shell: la palabra sin sus comillas ni sus barras (`<<\EOF` y `<<E"OF"` cierran en `EOF`), y
 * `$'…'` decodificado (`<<$'E\x4fF'` cierra en `EOF`).
 */
function delimitadorDelShell(palabra) {
  let out = '';
  for (let i = 0; i < palabra.length; i++) {
    const c = palabra[i];
    if (c === '\\') { out += palabra[i + 1] || ''; i++; }
    else if (c === '$' && palabra[i + 1] === "'") { const j = palabra.indexOf("'", i + 2); out += decodeAnsiC(palabra.slice(i + 2, j)); i = j; }
    else if (c === '$' && palabra[i + 1] === '"') continue;
    else if (c === "'") { const j = palabra.indexOf("'", i + 1); out += palabra.slice(i + 1, j); i = j; }
    else if (c === '"') {
      let j = i + 1;
      for (; j < palabra.length && palabra[j] !== '"'; j++) {
        if (palabra[j] === '\\' && /["\\$`]/.test(palabra[j + 1] || '')) j++;
        out += palabra[j];
      }
      i = j;
    } else out += c;
  }
  return out;
}

/**
 * Los heredocs del texto, en orden: `{ indice, fin, delim, comillas, resto, cuerpo }`. `indice` es la posición del `<<`
 * y `fin` la del final de la línea que lo cierra. `delim` es el que usa el shell y `comillas` dice si la palabra traía
 * comillas o barras (entonces el shell no expande el cuerpo). `resto` es lo que sigue a la palabra en su línea.
 * La línea de cierre admite blancos alrededor, por el lado seguro: un cierre antes del real deja más texto como comandos.
 * Un heredoc sin cierre no sale: su texto queda como comandos.
 */
function heredocs(texto) {
  const s = String(texto);
  const out = [];
  let lineas = null;                                      // por texto de línea, dónde empieza cada una (en orden)
  const lineasDe = () => {
    if (lineas) return lineas;
    lineas = new Map();
    for (let ini = 0; ini <= s.length;) {
      let fin = s.indexOf('\n', ini); if (fin < 0) fin = s.length;
      const t = s.slice(ini, fin).replace(/^[ \t]+|[ \t]+$/g, '');
      if (!lineas.has(t)) lineas.set(t, []);
      lineas.get(t).push([ini, fin]);
      ini = fin + 1;
    }
    return lineas;
  };
  const re = new RegExp(OPERADOR_HEREDOC.source, 'g');
  // dos heredocs en una línea (`cat <<A; python3 - <<B`): el cuerpo del segundo empieza donde cierra el primero
  let lineaPrevia = -1;
  let finPrevio = -1;
  let m;
  while ((m = re.exec(s))) {
    if (lineaPrevia >= 0 && m.index > lineaPrevia && m.index < finPrevio) { re.lastIndex = finPrevio; continue; }
    const finLinea = s.indexOf('\n', re.lastIndex);
    if (finLinea < 0) break;
    // `<<EO\` y en la línea siguiente `F`: bash junta las dos líneas y cierra en `EOF`. No se adivina: el texto queda
    // como comandos, que es el lado que frena.
    if (s[re.lastIndex] === '\\' && s[re.lastIndex + 1] === '\n') continue;
    const delim = delimitadorDelShell(m[1]);
    const desde = finLinea === lineaPrevia ? finPrevio : finLinea;
    const cierre = (lineasDe().get(delim) || []).find(([ini]) => ini > desde);
    if (!cierre) continue;
    out.push({
      indice: m.index, fin: cierre[1], delim, comillas: /[\\'"]/.test(m[1]),
      resto: s.slice(re.lastIndex, finLinea), cuerpo: cierre[0] > desde + 1 ? s.slice(desde + 1, cierre[0] - 1) : '',
    });
    lineaPrevia = finLinea;
    finPrevio = cierre[1];
  }
  return out;
}

function sinHeredocs(cmd, opciones) {
  const s = String(cmd);
  // bash acepta cualquier palabra como delimitador (END-DOC, EOF.1), con o sin comillas.
  // 🔴 El RESTO de la línea del `<<` se conserva (2026-09-16): `cat <<EOF > destino` y `cat <<EOF | bash`
  // son comandos de verdad —la redirección y la tubería las ejecuta el shell—, y borrarlos junto con el
  // cuerpo dejaba al freno de producción sin ver que el heredoc iba a parar a un archivo protegido o a
  // un shell. Sólo el cuerpo es texto; la línea del operador no.
  let out = '';
  let desde = 0;
  let inicioDeLinea = 0;                                  // en `out`, dónde van las líneas de lo que corre del cuerpo
  for (const h of heredocs(s)) {
    const antes = s.slice(s.lastIndexOf('\n', h.indice - 1) + 1, h.indice);
    const alimentaShell = opciones && opciones.salvoShell && (SHELL_ANTES.test(antes) || SHELL_DESPUES.test(h.resto));
    const corre = alimentaShell || h.comillas ? [] : comandosDelCuerpo(h.cuerpo);
    if (h.indice < desde) {
      // otro heredoc de la misma línea: su marca ya quedó en el resto del anterior y su cuerpo sigue al de aquél
      if (alimentaShell) out += s.slice(desde, h.fin);
      else if (corre.length) {
        const lineas = `${corre.join('\n')}\n`;
        out = out.slice(0, inicioDeLinea) + lineas + out.slice(inicioDeLinea);
        inicioDeLinea += lineas.length;
      }
      desde = h.fin;
      continue;
    }
    // lo que corre del cuerpo va en sus propias líneas, antes del comando del `<<` (el shell lo corre antes de dárselo):
    // la línea del `<<` no cambia de forma, y un comando que viene de líneas anteriores (`a |`, `a &&`, `a \`) se toma entero
    let ini = s.lastIndexOf('\n', h.indice - 1) + 1;
    while (ini > desde && SIGUE_EN_LA_LINEA.test(s.slice(desde, ini))) ini = s.lastIndexOf('\n', ini - 2) + 1;
    if (ini < desde) ini = desde;
    out += s.slice(desde, ini);
    if (corre.length) out += `${corre.join('\n')}\n`;
    inicioDeLinea = out.length;
    out += s.slice(ini, h.indice);
    out += alimentaShell ? s.slice(h.indice, h.fin) : ` __HEREDOC__${h.resto}`;
    desde = h.fin;
  }
  return out + s.slice(desde);
}

// una línea que no termina el comando: sigue con `\`, con una tubería o con `&&`/`||`
const SIGUE_EN_LA_LINEA = /(?:\\|\|\|?|&&)[ \t]*\n$/;

/**
 * Los comandos que el shell corre al armar el cuerpo de un heredoc sin comillas: el texto de cada `$(…)` y comilla
 * invertida, con sus saltos de línea. El texto alrededor es texto: sus comillas no abren nada, así que cada sustitución
 * se mide desde donde empieza. `\$(` y `` \` `` son literales; una sustitución sin cierre se lleva el resto del cuerpo,
 * que es el lado que frena. Una barra al final de una línea la junta con la siguiente, como hace el shell en el cuerpo
 * (`$\` y en la otra línea `(rm …)` es un `$(rm …)`).
 */
function comandosDelCuerpo(crudo) {
  let cuerpo = '';
  for (let i = 0; i < crudo.length; i++) {
    if (crudo[i] === '\\' && crudo[i + 1] === '\n') { i++; continue; }
    cuerpo += crudo[i];
    if (crudo[i] === '\\' && i + 1 < crudo.length) cuerpo += crudo[++i];
  }
  const out = [];
  for (let i = 0; i < cuerpo.length; i++) {
    if (cuerpo[i] === '\\') { i++; continue; }
    if (cuerpo[i] === '`') {
      const fin = finDeSustitucion(cuerpo, i);
      const cerro = fin <= cuerpo.length && cuerpo[fin - 1] === '`' && fin - 1 > i;
      out.push(cuerpo.slice(i + 1, cerro ? fin - 1 : fin).replace(/\\([`\\$])/g, '$1'));
      i = fin - 1;
    } else if (cuerpo[i] === '$' && cuerpo[i + 1] === '(') {
      // `$((…))` también: si no es una cuenta, bash lo corre como comando; y una cuenta puede traer su `$(…)`
      const resto = cuerpo.slice(i);
      const k = cierreDe(resto, 1);
      out.push(k < 0 ? resto.slice(2) : resto.slice(2, k));
      i += k < 0 ? resto.length : k;
    }
  }
  return out;
}

/**
 * Desde `s[i]` (una comilla de apertura: `'`, `"` o el `$` de `$'`), el índice JUSTO DESPUÉS de su cierre,
 * o `s.length` si no cierra. En simples el backslash no escapa; en dobles y en `$'…'` sí.
 */
function finDeComillas(s, i) {
  // 🔴 `$'…'` sólo si quien llama arranca en el `$`: mirar `s[i - 1] === '$'` tomaba como ANSI-C la comilla de `\$'…'` y de
  // `$$'…'`, donde `\'` NO escapa, y el partidor escondía los comandos de después (8.14 #31)
  const ansi = s[i] === '$';
  if (ansi) i++;
  const q = s[i];
  const escapa = q === '"' || ansi;
  for (let j = i + 1; j < s.length; j++) {
    if (escapa && s[j] === '\\') { j++; continue; }
    // 🔴 en `"…"` una sustitución trae sus propias comillas: `"x=$(git -C "$D" rev-parse HEAD)"` es UNA palabra. Cerrar
    // en la primera `"` de adentro partía el comando en cualquier lado, y su `&&` interno pasaba a cortar segmentos
    // (story 8.14, medido con measure-guard sobre comandos reales: un freno falso)
    if (q === '"' && s[j] === '$' && (s[j + 1] === '(' || s[j + 1] === '{')) { const k = cierreDe(s, j + 1); if (k >= 0) { j = k; continue; } }
    if (q === '"' && s[j] === '`') { j = finDeSustitucion(s, j) - 1; continue; }
    if (s[j] === q) return j + 1;
  }
  return s.length;
}

/**
 * El índice del cierre que corresponde a la apertura `s[i]` (`(` o `{`), saltando comillas, escapes,
 * comillas invertidas y aperturas anidadas del mismo tipo. -1 si no cierra.
 */
// 🔴 Una sola pasada por texto (con dos pilas), no una búsqueda por cada apertura: buscar el cierre desde cada
// `(` de un comando de 32 KB lleno de paréntesis sin cerrar es cuadrático, y el freno tiene reloj (AC 15).
const CIERRES = new Map();
function mapaDeCierres(s) {
  let m = CIERRES.get(s);
  if (m) return m;
  m = new Map();
  // la pila lleva las aperturas y los contextos: dentro de `"…"` sólo cuentan `$(`, `${` y la comilla invertida;
  // dentro de esos, todo vuelve a contar (comillas incluidas) hasta su cierre
  const pila = [];
  const root = {};                                                   // el contexto de afuera de todo (para sus `case`)
  const cerrar = (tipo, j) => {
    for (let k = pila.length - 1; k >= 0; k--) {
      const e = pila[k];
      if (e.t === '"' || e.t === '`') return;                       // no se cruza un contexto de comillas
      if (e.t === tipo) { pila.length = k; m.set(e.i, j); return; }
    }
  };
  for (let j = 0; j < s.length; j++) {
    const c = s[j];
    const tope = pila.length ? pila[pila.length - 1].t : null;
    if (c === '\\') { j++; continue; }
    if (tope === '"') {
      if (c === '"') pila.pop();
      else if (c === '$' && (s[j + 1] === '(' || s[j + 1] === '{')) { pila.push({ t: s[j + 1], i: j + 1, param: s[j + 1] === '{' }); j++; }
      else if (c === '`') pila.push({ t: '`' });
      continue;
    }
    if (c === '`') { if (tope === '`') pila.pop(); else pila.push({ t: '`' }); continue; }
    if (c === '$' && s[j + 1] === '$') { j++; continue; }                // `$$` (el pid): su `'` siguiente no es `$'…'`
    if (c === "'" || (c === '$' && s[j + 1] === "'")) { j = finDeComillas(s, j) - 1; continue; }
    if (c === '"') { pila.push({ t: '"' }); continue; }
    // 🔴 los patrones de un `case`: su `)` no cierra nada. Sin esto, en `"$(case a in a) echo x;; esac; rm …)"` la
    // sustitución cerraba en el `)` del patrón y el resto quedaba como texto que nadie juzgaba (8.14 #33)
    // cada contexto de comando lleva sus `case` abiertos: 'subject' (antes del `in`), 'pattern' o 'body'
    const frame = pila.length ? pila[pila.length - 1] : root;
    if (!frame.param) {
      const cases = frame.cases;
      const st = cases && cases.length ? cases[cases.length - 1] : null;
      if (st && st !== 'subject' && c === 'e' && wordAt(s, j, 'esac') && atCommandPosition(s, j)) { cases.pop(); j += 3; continue; }
      if (st === 'subject' && c === 'i' && /\s/.test(s[j - 1]) && wordAt(s, j, 'in')) { cases[cases.length - 1] = 'pattern'; j++; continue; }
      if (st === 'pattern' && c === ')') { cases[cases.length - 1] = 'body'; continue; }
      if (st === 'body' && c === ';' && /[;&|]/.test(s[j + 1] || '')) {
        cases[cases.length - 1] = 'pattern'; j++; if (s[j] === ';' && s[j + 1] === '&') j++;     // `;;`, `;&`, `;|`, `;;&`
        continue;
      }
      if (c === 'c' && wordAt(s, j, 'case') && atCommandPosition(s, j)) { (frame.cases = cases || []).push('subject'); j += 3; continue; }
    }
    // dentro de `${…}` una `{` suelta no anida: bash cierra la variable en la primera `}` (8.14 #15, #36)
    if (c === '$' && s[j + 1] === '{') { pila.push({ t: '{', i: j + 1, param: true }); j++; continue; }
    if (c === '{' && tope === '{' && pila[pila.length - 1].param) continue;
    if (c === '(' || c === '{') pila.push({ t: c, i: j });
    else if (c === ')') cerrar('(', j);
    else if (c === '}') cerrar('{', j);
  }
  if (CIERRES.size > 256) CIERRES.clear();
  CIERRES.set(s, m);
  return m;
}
/** ¿El carácter `s[k]` está escapado? (una cantidad impar de barras invertidas justo antes) */
function isEscaped(s, k) {
  let b = 0;
  while (k - 1 - b >= 0 && s[k - 1 - b] === '\\') b++;
  return b % 2 === 1;
}
/** ¿`s` tiene la palabra `w` en `j`, terminada en un blanco, un separador o el fin? */
function wordAt(s, j, w) {
  return s.startsWith(w, j) && (j + w.length >= s.length || /[\s;&|()]/.test(s[j + w.length]));
}
/** ¿`s[j]` está en posición de comando? (al principio, después de un separador o de una palabra reservada) */
const RESERVED_BEFORE = /(?:^|[\s;&|(])(?:then|do|else|elif|if|while|until|in|!)$/;
function atCommandPosition(s, j) {
  let k = j - 1;
  while (k >= 0 && (s[k] === ' ' || s[k] === '\t')) k--;
  if (k < 0 || /[;&|(\n{]/.test(s[k])) return true;
  return RESERVED_BEFORE.test(s.slice(Math.max(0, k - 6), k + 1));
}
function cierreDe(s, i) {
  const k = mapaDeCierres(s).get(i);
  return k === undefined ? -1 : k;
}

/** Desde una sustitución (`$(`, `<(`, `>(`, `=(` o comilla invertida) en `s[i]`, el índice justo después de su fin. */
function finDeSustitucion(s, i) {
  if (s[i] === '`') {
    for (let j = i + 1; j < s.length; j++) { if (s[j] === '\\') { j++; continue; } if (s[j] === '`') return j + 1; }
    return s.length;
  }
  const k = cierreDe(s, i + 1);
  return k < 0 ? s.length : k + 1;
}

// Palabras reservadas tras las que se sigue en posición de comando (`if (…)`, `then { …; }`).
// 🔴 La última puede ir PEGADA al `(` (`then(…)`, `do(…)`, `time(…)`, `!(…)` en bash), y cuentan las cabezas de los comandos
// compuestos de zsh: `repeat N (…)`, `for i (…) (…)`, `if [[ … ]] (…)`, `while (( … )) (…)`, `coproc (…)`. Leídas como
// paréntesis de palabra, la subshell entera era UN argumento y todas las reglas del freno quedaban ciegas (8.14 #39).
// `time -p (…)` y `coproc NOMBRE (…)` también (repaso de seguridad de la tanda A): con la bandera o el nombre en el medio,
// el subshell quedaba como UNA palabra, el programa del comando. `select`/`foreach` con su lista entre paréntesis (zsh).
const COMMAND_HEAD = String.raw`(?:if|then|else|elif|do|while|until|time(?:\s+-[A-Za-z-]*)*|!|coproc(?:\s+[A-Za-z_]\w*)?|repeat\s+\S+`
  + String.raw`|(?:for|select|foreach)\s+[A-Za-z_]\w*(?:\s+[A-Za-z_]\w*)*\s*\([^()]*\)`
  + String.raw`|(?:if|elif|while|until)\s*(?:\[\[(?:[^\]]|\][^\]])*\]\]|\(\((?:[^)]|\)[^)])*\)\)))`;
const POSICION_DE_COMANDO = new RegExp(String.raw`^\s*(?:${COMMAND_HEAD}\s+)*(?:${COMMAND_HEAD})?$`);
const ABRE_CASE = /^\s*case\s+(?:"[^"]*"|'[^']*'|[^\s"'])+\s+in\s$/;
const FUNCION = /\(\s*\)/y;                   // `f()`, `f ()`: definición de función (sticky: sin copiar el resto)
// `>!`, `>>!`, `>>|`, `&>!`, `>&!`, `>>&`… son de zsh (pisar o agregar aunque esté `noclobber`): el destino es un archivo
// (8.14 #4: leído como `>` con destino `!`, el archivo real quedaba como argumento del programa)
const OPERADOR_REDIR = /&>>[|!]?|&>[|!]?|>>&[|!]?|<<<|<<-|<<|<>|<&|>>[|!]?|>&[|!]?|>[|!]?|</y;
const NOMBRE_VAR = /[A-Za-z_]\w*/y;
const MODIFICADOR_Y = /:(?:gs|[aAcehlpqQrstux&])/y;

/**
 * El partidor: corta el texto en segmentos con el separador que los SIGUE. No saca heredocs (eso es
 * `segmentos`). `{ keepSubst: true }` deja `$(…)`, la comilla invertida y `<(…)`/`>(…)` DENTRO de la
 * palabra (sin cortar), para que quien llama sepa qué argumento arma cada sustitución; su texto se
 * saca con `substitutions()` y se juzga aparte.
 * @returns {{texto:string, sep:string}[]}
 */
function lex(texto, opciones) {
  const keep = !!(opciones && opciones.keepSubst);
  const s = String(texto);
  const n = s.length;
  const out = [];
  let cur = '';
  const corte = (sep) => { out.push({ texto: cur, sep }); cur = ''; };
  // contextos de COMANDO: dentro de cada uno se corta en `;`, `|`, `&&`… — `top`, `$(`, subshell, `<(`,
  // grupo `{ …; }`, comilla invertida y `case`. Cada uno lleva su pila de contextos de PALABRA (`w`):
  // `${…}` y paréntesis de palabra, donde nada corta; y la cuenta de llaves abiertas en la palabra actual.
  const pila = [{ k: 'top', w: [], llaves: 0 }];
  const tope = () => pila[pila.length - 1];
  const enPalabra = () => tope().w.length > 0;
  for (let i = 0; i < n; i++) {
    const T = tope();
    const ch = s[i]; const nx = s[i + 1];

    // ── dentro de una construcción de palabra (`${…}`, `a(…)`): nada corta, salvo una sustitución ──
    if (enPalabra()) {
      const W = T.w;
      if (ch === '\\' && (nx === '\n' || i === n - 1)) { i++; continue; }          // continuación de línea (8.14 #13, #37)
      if (ch === '\\') { cur += s.slice(i, i + 2); i++; continue; }
      if (ch === "'" || ch === '"' || (ch === '$' && nx === "'")) { const f = finDeComillas(s, i); cur += s.slice(i, f); i = f - 1; continue; }
      if ((ch === '$' && nx === '(') || ch === '`') {
        // `finDeSustitucion` se para en el `$` (o en la comilla invertida), no en el `(`
        if (keep) { const f = finDeSustitucion(s, i); cur += s.slice(i, f); i = f - 1; continue; }
        if (ch === '`') { corte('('); pila.push({ k: 'bt', w: [], llaves: 0 }); continue; }
        corte('$('); i++; pila.push({ k: 'cmd', w: [], llaves: 0 }); continue;
      }
      if (ch === '$' && nx === '$') { cur += '$$'; i++; continue; }
      if (ch === '$' && nx === '{') { W.push('param'); cur += '${'; i++; continue; }
      // 🔴 dentro de `${…}` una `{` suelta NO anida: bash cierra en la primera `}` (`echo ${x:-{}; rm …` corre el rm; zsh da
      // error). Contarla dejaba el resto del comando pegado a la palabra (8.14 #15, #36)
      if (ch === '{' && W[W.length - 1] !== 'paren' && W[W.length - 1] !== 'param') { W.push('llave'); cur += ch; continue; }
      if (ch === '}' && W[W.length - 1] !== 'paren') { W.pop(); cur += ch; continue; }
      // un `(` de palabra anida sólo si cierra (`${x:-(}` no)
      if (ch === '(') { if (cierreDe(s, i) >= 0) W.push('paren'); cur += ch; continue; }
      if (ch === ')' && W[W.length - 1] === 'paren') { W.pop(); cur += ch; continue; }
      cur += ch;
      continue;
    }

    // ── patrones de un `case`: `a|b)` no es tubería ni subshell; no sale en ningún segmento ──
    if (T.k === 'case' && !cur.trim()) {
      if (/^esac(?=[\s;&|)]|$)/.test(s.slice(i, i + 5))) { pila.pop(); cur += ch; continue; }
      if (T.st === 'patron' && !/[\s;]/.test(ch)) {
        let j = ch === '(' ? i + 1 : i; let prof = 0;
        for (; j < n; j++) {
          const c = s[j];
          if (c === '\\') { j++; continue; }
          if (c === "'" || c === '"' || (c === '$' && s[j + 1] === "'")) { j = finDeComillas(s, j) - 1; continue; }
          if (c === '(') prof++;
          else if (c === ')') { if (prof === 0) break; prof--; }
        }
        if (j < n) { i = j; T.st = 'cuerpo'; continue; }
        // sin `)`: no es un patrón que el shell acepte; se lee como texto
      }
    }

    if (ch === '$' && nx === '$') { cur += '$$'; i++; continue; }                 // `$$` (el pid): su `'` no es `$'…'`
    if (ch === "'" || ch === '"' || (ch === '$' && nx === "'")) { const f = finDeComillas(s, i); cur += s.slice(i, f); i = f - 1; continue; }
    // un comentario `# …` (al principio de una palabra) va hasta el fin de la línea: sus comillas no cuentan.
    // 🔴 «Principio de una palabra» es lo que el partidor lleva, no el carácter crudo de antes: `a\ #` y `a\;#` son una sola
    // palabra, y mirar `s[i - 1]` tomaba el `#` como comentario y se tragaba el comando siguiente (8.14 #32)
    if (ch === '#' && (cur === '' || (/\s$/.test(cur) && !isEscaped(cur, cur.length - 1)))) { while (i < n && s[i] !== '\n') i++; corte(';'); T.llaves = 0; continue; }
    // continuación de línea: el shell QUITA la barra y el salto y une la palabra (8.14 #13: con un espacio, un nombre
    // partido así le llegaba al freno como dos palabras). Una barra al final del texto entero es lo mismo (8.14 #37)
    if (ch === '\\' && (nx === '\n' || i === n - 1)) { i++; continue; }
    // 🔴 fuera de comillas `\x` es el carácter x: `\"` y `\'` NO abren comillas (story 8.14, AC 4)
    if (ch === '\\') { cur += s.slice(i, i + 2); i++; continue; }
    if (ch === '$' && nx === '(') {
      // 🔴 desde el `$`: con `i + 1` buscaba el cierre de lo que sigue al `(`, no encontraba ninguno y pegaba el resto del
      // comando en una sola palabra — `X=$(a); rm …` dejaba de cortar en `;` y en `&&` (story 8.14, measure-guard)
      if (keep) { const f = finDeSustitucion(s, i); cur += s.slice(i, f); i = f - 1; continue; }
      corte('$('); i++; pila.push({ k: 'cmd', w: [], llaves: 0 }); continue;
    }
    if (ch === '$' && nx === '{') { T.w.push('param'); cur += '${'; i++; continue; }   // ${VAR}, ${VAR:-x}: no separa
    if (ch === '`') {
      if (T.k === 'bt') { corte('('); pila.pop(); continue; }
      if (keep) { const f = finDeSustitucion(s, i); cur += s.slice(i, f); i = f - 1; continue; }
      corte('('); pila.push({ k: 'bt', w: [], llaves: 0 }); continue;
    }
    if (ch === ';' && T.k === 'case' && T.st === 'cuerpo' && (nx === ';' || nx === '&' || nx === '|')) {
      corte(';'); i++; if (s[i] === ';' && s[i + 1] === '&') i++;            // `;;`, `;&`, `;|`, `;;&`
      T.st = 'patron'; T.llaves = 0; continue;
    }
    if (ch === '&' && nx === '&') { corte('&&'); i++; T.llaves = 0; continue; }
    if (ch === '|' && nx === '&') { corte('|'); i++; T.llaves = 0; continue; }          // `|&`: pipe que además lleva stderr
    // `>` o `<` justo antes: es parte de una redirección (`2>&1`, `>&2`, `<&0`, `>|`), salvo que esté escapado (`x\>&` corta, 8.14 #32)
    const redirBefore = (s[i - 1] === '>' || s[i - 1] === '<') && !isEscaped(s, i - 1);
    if (ch === '&' && nx !== '>' && !redirBefore) { corte('&'); T.llaves = 0; continue; }   // `cmd &` (no `2>&1`, `>&2`, `<&0` ni `&>`)
    if (ch === '|' && s[i - 1] === '>' && redirBefore) { cur += ch; continue; }            // `>|`, `>>|`, `&>|`: pisar, no tubería
    if (ch === '|' && nx === '|') { corte('||'); i++; T.llaves = 0; continue; }
    if (ch === '|') { corte('|'); T.llaves = 0; continue; }
    if (ch === ';' || ch === '\n') { corte(';'); T.llaves = 0; continue; }
    if (ch === '(') {
      const u = cur[cur.length - 1]; const u2 = cur[cur.length - 2];
      const procesal = u === '<' || u === '>' || (u === '=' && (u2 === undefined || /\s/.test(u2)));   // `<(…)`, `>(…)`, `=(…)` de zsh
      if (procesal && keep) { const f = finDeSustitucion(s, i - 1); cur += s.slice(i, f); i = f - 1; continue; }   // desde el `<`/`>`/`=`
      if (procesal) { corte('('); pila.push({ k: 'sub', w: [], llaves: 0 }); continue; }
      // `()` es definición de función sólo detrás de un NOMBRE: `a=()` es un arreglo vacío, no una función (8.14)
      FUNCION.lastIndex = i;
      const funcion = /(?:^|\s)[^\s=]+\s*$/.test(cur) ? FUNCION.exec(s) : null;
      if (funcion) { corte('('); i += funcion[0].length - 1; corte(')'); continue; }   // `f()`, `f ()`: definición
      if (POSICION_DE_COMANDO.test(cur)) { corte('('); pila.push({ k: 'sub', w: [], llaves: 0 }); continue; }
      // paréntesis de PALABRA: `a(b|c)`, `x(N)`, `a=(x y)`, `@(a|b)` — sólo si cierra; si no, es un carácter
      if (cierreDe(s, i) >= 0) { T.w.push('paren'); cur += ch; continue; }
      cur += ch; continue;
    }
    if (ch === ')') {
      if (T.k === 'cmd' || T.k === 'sub') pila.pop();
      corte(')'); T.llaves = 0; continue;
    }
    if (ch === '{') {
      if (POSICION_DE_COMANDO.test(cur) && (nx === undefined || /\s/.test(nx))) {      // grupo `{ …; }`
        corte(')'); pila.push({ k: 'grupo', w: [], llaves: 0 }); continue;
      }
      T.llaves++; cur += ch; continue;                                       // llave de palabra
    }
    if (ch === '}') {
      if (T.llaves > 0) { T.llaves--; cur += ch; continue; }
      if (T.k === 'grupo') { corte(')'); pila.pop(); continue; }            // cierre por profundidad, pegado o no
      cur += ch; continue;                                                   // `}` suelto: un carácter
    }
    if (/\s/.test(ch)) {
      T.llaves = 0; cur += ch;
      if ((T.k !== 'case' || T.st === 'cuerpo') && ABRE_CASE.test(cur)) { corte(';'); pila.push({ k: 'case', st: 'patron', w: [], llaves: 0 }); }
      continue;
    }
    cur += ch;
  }
  out.push({ texto: cur, sep: '' });
  // segmentos vacíos (dos separadores seguidos) se descartan, pero su separador se conserva en el anterior.
  // 🔴 Salvo una TUBERÍA: `ls x |⏎ xargs rm`, `ls x | { xargs rm; }` y `ls x | ( xargs rm )` siguen siendo tubería, y el
  // salto de línea, la apertura del grupo o de la subshell no le pisan el `|` al lector (8.14 #2: el freno vaciaba la
  // tubería antes de llegar al `xargs`). Contrato: el segmento que alimenta una tubería termina en `|` aunque entre él y
  // el comando siguiente haya saltos de línea, un `{` o un `(`. Lo mismo para el salto de línea detrás de `&&`, `||` o
  // `&`: no los vuelve `;` (`a &&⏎ b` sigue siendo «b si a anduvo»).
  const limpio = [];
  for (const seg of out) {
    const t = seg.texto.trim();
    if (t) limpio.push({ texto: t, sep: seg.sep });
    else if (limpio.length && seg.sep) {
      const previo = limpio[limpio.length - 1];
      const tuberia = previo.sep === '|' && (seg.sep === ';' || seg.sep === '(' || seg.sep === ')');
      if (!tuberia && !(seg.sep === ';' && ['&&', '||', '&'].includes(previo.sep))) previo.sep = seg.sep;
    }
  }
  return limpio;
}

/** @returns {{texto:string, sep:string}[]} cada segmento con el separador que lo SIGUE ('' al final) */
function segmentos(cmd, opciones) {
  return lex(sinHeredocs(cmd), opciones);
}

/** Lo que puede preceder al programa de verdad: variables, sudo/env/time…, `timeout N`, `then`/`do`… */
const PREFIJOS = /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)|(?:sudo|env|time|nohup|command|exec|nice|builtin)\s+|timeout\s+\S+\s+|(?:then|do|else|elif|if|while|until|!)\s+)+/;

/**
 * tokens tipo shell: respeta comillas, saca las comillas del valor (`"acme-s"ql` → `acme-sql`).
 * Fuera de comillas `\x` queda como `\x` (quien llama des-escapa) y NO abre comillas ni parte en `\ `;
 * en dobles `\"` no las cierra; `$'…'` se decodifica (story 8.14, AC 4 y 7).
 */
function tokens(texto) {
  const t = []; let cur = ''; let q = null; let hubo = false;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (q === "'") { if (ch === "'") q = null; else cur += ch; continue; }
    if (q === '"') {
      if (ch === '\\' && i + 1 < texto.length && '"\\$`'.includes(texto[i + 1])) { cur += texto[++i]; continue; }
      if (ch === '"') q = null; else cur += ch;
      continue;
    }
    if (ch === '$' && texto[i + 1] === '$') { cur += '$$'; i++; continue; }
    if (ch === '$' && texto[i + 1] === "'") {
      const f = finDeComillas(texto, i);
      cur += decodeAnsiC(texto.slice(i + 2, texto[f - 1] === "'" && f - 1 > i + 1 ? f - 1 : f));
      hubo = true; i = f - 1; continue;
    }
    if (ch === '"' || ch === "'") { q = ch; hubo = true; continue; }
    if (ch === '\\' && (texto[i + 1] === '\n' || i + 1 >= texto.length)) { i++; continue; }   // continuación de línea (8.14 #13, #37)
    if (ch === '\\' && i + 1 < texto.length) { cur += ch + texto[++i]; continue; }
    if (/\s/.test(ch)) { if (cur || hubo) { t.push(cur); cur = ''; hubo = false; } continue; }
    cur += ch;
  }
  if (cur || hubo) t.push(cur);
  return t;
}

// ── 2. variables definidas en el propio comando ───────────────────────────────────────────────
const SIN_RESOLVER = '<<SIN-RESOLVER>>';   // marca interna: "acá había una variable que el comando no define"

/** `$VAR` / `${VAR}` con lo definido en el propio comando, y `~`. null si queda algo sin resolver. */
function expandir(token, vars) {
  let s = String(token).replace(/^["']|["']$/g, '');
  s = s.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, v) => (v in vars ? vars[v] : SIN_RESOLVER));
  if (s.includes(SIN_RESOLVER)) return null;
  return s.replace(/^~(?=\/|$)/, os.homedir());
}

/** Las asignaciones `NOMBRE=valor` del texto del comando, en orden (una puede usar la anterior). */
function variablesDelComando(texto) {
  const vars = {};
  // el valor sin comillas termina en ; & | ) — `D=.; git …` define D como `.`, no como `.;`
  const re = /(?:^|[;&|\n(]\s*)(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|)]*)/g;
  let m;
  while ((m = re.exec(texto))) { const v = expandir(m[2], vars); vars[m[1]] = v === null ? SIN_RESOLVER : v; }
  return vars;
}

// ── 3. palabras crudas y el comando simple (story 8.14) ───────────────────────────────────────

/** `$'…'` decodificado: `\xHH`, `\NNN`, `\uHHHH`, `\UHHHHHHHH`, `\cX`, `\n`, `\t`, `\\`, `\'`… */
function decodeAnsiC(s) {
  const SIMPLES = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\' || i + 1 >= s.length) { out += s[i]; continue; }
    const c = s[++i];
    if (c in SIMPLES) { out += SIMPLES[c]; continue; }
    let m;
    if (c === 'x' && (m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 1)))) { out += String.fromCharCode(parseInt(m[0], 16)); i += m[0].length; continue; }
    if (c === 'u' && (m = /^[0-9a-fA-F]{1,4}/.exec(s.slice(i + 1)))) { out += String.fromCodePoint(parseInt(m[0], 16)); i += m[0].length; continue; }
    if (c === 'U' && (m = /^[0-9a-fA-F]{1,8}/.exec(s.slice(i + 1)))) {
      const cp = parseInt(m[0], 16); out += cp <= 0x10ffff ? String.fromCodePoint(cp) : ''; i += m[0].length; continue;
    }
    if (/[0-7]/.test(c)) { m = /^[0-7]{1,3}/.exec(s.slice(i)); out += String.fromCharCode(parseInt(m[0], 8) & 0xff); i += m[0].length - 1; continue; }
    if (c === 'c' && i + 1 < s.length) { out += String.fromCharCode(s[++i].toUpperCase().charCodeAt(0) ^ 0x40); continue; }
    out += '\\' + c;
  }
  return out;
}

/**
 * `$'…'` como lo lee zsh: lo mismo que bash en los escapes comunes, pero un escape que no conoce deja la LETRA (`\p` → `p`,
 * y `\c` → `c`), y entiende `\C-x` y `\M-x`. Medido contra `zsh -f` 5.9 (8.14 #34: la unión con bash quedaba incompleta).
 */
function decodeAnsiCZsh(s) {
  const SIMPLES = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\' || i + 1 >= s.length) { out += s[i]; continue; }
    const c = s[++i];
    if (c in SIMPLES) { out += SIMPLES[c]; continue; }
    let m;
    if (c === 'x' && (m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 1)))) { out += String.fromCharCode(parseInt(m[0], 16)); i += m[0].length; continue; }
    if ((c === 'u' || c === 'U') && (m = (c === 'u' ? /^[0-9a-fA-F]{1,4}/ : /^[0-9a-fA-F]{1,8}/).exec(s.slice(i + 1)))) {
      const cp = parseInt(m[0], 16); out += cp <= 0x10ffff ? String.fromCodePoint(cp) : ''; i += m[0].length; continue;
    }
    if (/[0-7]/.test(c)) { m = /^[0-7]{1,3}/.exec(s.slice(i)); out += String.fromCharCode(parseInt(m[0], 8) & 0xff); i += m[0].length - 1; continue; }
    if ((c === 'C' || c === 'M') && s[i + 1] === '-' && i + 2 < s.length) {
      const x = s[i + 2].charCodeAt(0); i += 2;
      out += String.fromCharCode(c === 'C' ? (x === 0x3f ? 0x7f : x & 0x1f) : (x | 0x80) & 0xff); continue;
    }
    out += c;                                                                  // desconocido (también `\c`): la letra
  }
  return out;
}

/**
 * Las palabras CRUDAS de un segmento (con sus comillas) y sus operadores de redirección, en orden.
 * Una palabra no se parte en `{`, `(`, `${…}`, `$(…)` ni en comillas; `<`, `>` y `&>` son operadores.
 * @returns {({type:'word', raw:string}|{type:'redir', op:string, fd:string|null})[]}
 */
function lexWords(texto) {
  const s = String(texto); const n = s.length;
  const out = [];
  let cur = ''; let empezada = false;
  const cerrar = () => { if (empezada) out.push({ type: 'word', raw: cur }); cur = ''; empezada = false; };
  for (let i = 0; i < n; i++) {
    const ch = s[i]; const nx = s[i + 1];
    if (/\s/.test(ch)) { cerrar(); continue; }
    if (ch === '\\' && (nx === '\n' || i === n - 1)) { i++; continue; }            // continuación de línea (8.14 #13, #37)
    if (ch === '\\') { cur += s.slice(i, i + 2); empezada = true; i++; continue; }
    if (ch === '$' && nx === '$') { cur += '$$'; empezada = true; i++; continue; }
    if (ch === "'" || ch === '"' || (ch === '$' && nx === "'")) { const f = finDeComillas(s, i); cur += s.slice(i, f); empezada = true; i = f - 1; continue; }
    if (ch === '`') { const f = finDeSustitucion(s, i); cur += s.slice(i, f); empezada = true; i = f - 1; continue; }
    if (ch === '$' && (nx === '(' || nx === '{')) {
      const k = cierreDe(s, i + 1); const f = k < 0 ? n : k + 1;
      cur += s.slice(i, f); empezada = true; i = f - 1; continue;
    }
    if ((ch === '<' || ch === '>') && nx === '(') {                         // `<(…)` / `>(…)`: una palabra
      const f = finDeSustitucion(s, i); cur += s.slice(i, f); empezada = true; i = f - 1; continue;   // desde el `<`/`>`
    }
    if (ch === '(') {                                                        // paréntesis de palabra, si cierra
      const k = cierreDe(s, i);
      if (k >= 0) { cur += s.slice(i, k + 1); empezada = true; i = k; continue; }
      cur += ch; empezada = true; continue;
    }
    // redirecciones: `N>`, `N>>`, `N>|`, `N<>`, `N<`, `N<<<`, `N>&M`, `&>`, `&>>`, `<<`
    if (ch === '<' || ch === '>' || (ch === '&' && nx === '>')) {
      let fd = null;
      if (empezada && /^\d+$/.test(cur)) { fd = cur; cur = ''; empezada = false; } else cerrar();
      OPERADOR_REDIR.lastIndex = i;
      const m = OPERADOR_REDIR.exec(s);
      out.push({ type: 'redir', op: m[0], fd });
      i += m[0].length - 1; continue;
    }
    cur += ch; empezada = true;
  }
  cerrar();
  return out;
}

/** Las palabras crudas de un texto, sin los operadores (los operadores de redirección se descartan). */
function splitWords(texto) {
  return lexWords(texto).filter((x) => x.type === 'word').map((x) => x.raw);
}

const ASIGNACION = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?(\+?)=([\s\S]*)$/;
const DECLARA = new Set(['export', 'typeset', 'declare', 'local', 'readonly', 'integer', 'float']);
const RESERVADAS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', 'time']);
const ESCRIBE_A_ARCHIVO = new Set(['>', '>>', '>|', '&>', '&>>', '<>',
  '>!', '>>|', '>>!', '&>|', '&>!', '&>>|', '&>>!', '>>&', '>>&|', '>>&!', '>&|', '>&!']);

function leerAsignacion(raw, builtin) {
  const m = ASIGNACION.exec(raw);
  if (!m) return null;
  const valor = m[4];
  const arreglo = !m[2] && /^\([\s\S]*\)$/.test(valor) ? splitWords(valor.slice(1, -1)) : null;
  return { name: m[1], op: m[3] ? '+=' : '=', raw: valor, array: arreglo, element: !!m[2], builtin: builtin || null };
}

/**
 * Un comando simple (UN segmento de `segmentos()`): asignaciones de adelante (y las de
 * `export`/`typeset`/`declare`/`local`/`readonly`), palabras crudas y TODAS las redirecciones.
 * `redirections[].write`: escribe a un archivo (`>`, `>>`, `>|`, `N>…`, `&>`, `&>>`, `<>`, y `>&palabra`
 * que no es un descriptor). `dup`: `>&2`, `<&0`, `>&-` (no es un archivo). El destino de un `<<<` se
 * expande con `expandWord(target, ctx, { hereString: true })`: ni zsh ni bash le expanden llaves ni comodines.
 * `reserved`: las palabras reservadas de adelante (`do`, `then`, `while`…), que no son el programa.
 * @returns {{assignments:object[], words:string[], redirections:{op:string, fd:string|null, target:string|null, write:boolean, dup:boolean}[], reserved:string[]}}
 */
function parseSimpleCommand(texto) {
  const items = lexWords(texto);
  const assignments = []; const words = []; const redirections = []; const reserved = [];
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    if (it.type === 'redir') {
      const sig = items[k + 1];
      const target = sig && sig.type === 'word' ? sig.raw : null;
      if (target !== null) k++;
      const dup = (it.op === '>&' || it.op === '<&') && target !== null && /^(?:\d+|-)$/.test(target);
      const write = !dup && (ESCRIBE_A_ARCHIVO.has(it.op) || it.op === '>&');
      redirections.push({ op: it.op, fd: it.fd, target, write, dup });
      continue;
    }
    if (!words.length) {
      // `then`, `do`, `while`… no son parte del comando simple: el programa es lo que sigue
      if (!assignments.length && RESERVADAS.has(it.raw)) { reserved.push(it.raw); continue; }
      const a = leerAsignacion(it.raw);
      if (a) { assignments.push(a); continue; }
    } else if (DECLARA.has(words[0].replace(/^\\/, '')) && !/^[-+]/.test(it.raw)) {
      const a = leerAsignacion(it.raw, words[0]);
      if (a) { assignments.push(a); continue; }
    }
    words.push(it.raw);
  }
  return { assignments, words, redirections, reserved };
}

/** Los textos de las sustituciones (`$(…)`, comilla invertida, `<(…)`, `>(…)`) de una palabra o texto. */
function substitutions(texto) {
  const s = String(texto); const out = [];
  let dobles = false;                                       // en `"…"` la comilla simple es un carácter
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '$' && s[i + 1] === '$') { i++; continue; }
    if (c === '"') { dobles = !dobles; continue; }
    if (!dobles && (c === "'" || (c === '$' && s[i + 1] === "'"))) { i = finDeComillas(s, i) - 1; continue; }
    if (c === '`') { const f = finDeSustitucion(s, i); out.push(s.slice(i + 1, s[f - 1] === '`' ? f - 1 : f)); i = f - 1; continue; }
    if ((c === '$' || c === '<' || c === '>') && s[i + 1] === '(') {
      const k = cierreDe(s, i + 1);
      out.push(s.slice(i + 2, k < 0 ? s.length : k)); i = k < 0 ? s.length : k; continue;
    }
  }
  return out;
}

// ── 4. el expansor (story 8.14) ──────────────────────────────────────────────────────────────
// Lo que devuelve `expandWord` son PATRONES: un `*`, `?`, `[` o `\` escapado con `\` es literal; uno sin
// escapar es comodín. Lo DESCONOCIDO (una variable que el comando no define, `$(…)`, `${X:-y}`…) es `*`.
const EXPANSION_LIMIT = 4096;
const DESCONOCIDO = '\u0001';        // marca interna: «acá hay algo que no sé» → `*`
const PARTIR = '\u0000';             // marca interna: bash parte acá (variable sin comillas con blancos)
const EXTENDIDO = '\u0002';          // marca interna: operador de glob extendido → el componente es `*`
const escLit = (s) => String(s).replace(/[\\*?[\]~]/g, '\\$&');

/** El presupuesto GLOBAL de expansiones de un comando: se calcula antes de generar, nunca se materializa de más. */
class ExpansionBudget {
  constructor(limit = EXPANSION_LIMIT) { this.limit = limit; this.used = 0; this.exhausted = false; }
  get remaining() { return Math.max(0, this.limit - this.used); }
  take(n) {
    if (!(n <= this.limit - this.used)) { this.exhausted = true; return false; }
    this.used += n; return true;
  }
}

class Indecidible extends Error {}

const lit = (v) => ({ t: 'lit', v });
const alt = (alts) => ({ t: 'alt', alts });

/** zsh ∪ bash 3.2 para un rango `{a..b[..paso]}`; null si no es un rango que alguno de los dos acepte. */
function rango(contenido) {
  const zsh = []; const bash = []; let zshLit = null; let bashLit = `{${contenido}}`;
  const num = /^([-+]?\d+)\.\.([-+]?\d+)(?:\.\.([-+]?\d+))?$/.exec(contenido);
  const car = /^([^\\])\.\.([^\\])(?:\.\.([-+]?\d+))?$/.exec(contenido);
  const serie = (a, b, paso) => {                    // de a hacia b con |paso|, sin pasarse
    const p = Math.abs(paso) || 1; const r = [];
    const cuenta = Math.floor(Math.abs(b - a) / p) + 1;
    return { cuenta, gen: () => { for (let k = 0, v = a; k < cuenta; k++, v += (b >= a ? p : -p)) r.push(v); return r; } };
  };
  if (num) {
    const [, a, b, paso] = num;
    const A = parseInt(a, 10); const B = parseInt(b, 10);
    const zshOk = /^-?\d+$/.test(a) && /^-?\d+$/.test(b) && (paso === undefined || /^-?\d+$/.test(paso));
    if (zshOk && paso !== undefined && parseInt(paso, 10) === 0) zshLit = contenido;          // zsh: `1..3..0`
    else if (zshOk) {
      const ancho = /^-?0\d/.test(a) || /^-?0\d/.test(b) ? Math.max(a.length, b.length) : 0;
      const fmt = (v) => { if (!ancho) return String(v); const neg = v < 0; return (neg ? '-' : '') + String(Math.abs(v)).padStart(ancho - (neg ? 1 : 0), '0'); };
      const sr = serie(A, B, paso === undefined ? 1 : parseInt(paso, 10));
      zsh.push({ cuenta: sr.cuenta, gen: () => sr.gen().map(fmt) });
    }
    if (paso === undefined) {
      bashLit = null;
      // la misma lista que zsh (sin relleno, sin signo +): no se cuenta dos veces contra el presupuesto
      const igual = zsh.length && !/^-?0\d/.test(a) && !/^-?0\d/.test(b);
      if (!igual) { const sr = serie(A, B, 1); bash.push({ cuenta: sr.cuenta, gen: () => sr.gen().map(String) }); }
    }
  } else if (car && !(/\d/.test(car[1]) && /\d/.test(car[2]))) {
    const [, a, b, paso] = car;
    const A = a.codePointAt(0); const B = b.codePointAt(0);
    if (paso === undefined) {
      const sr = serie(A, B, 1);
      zsh.push({ cuenta: sr.cuenta, gen: () => sr.gen().map((c) => String.fromCodePoint(c)) });
      if (/[a-zA-Z]/.test(a) && /[a-zA-Z]/.test(b)) bashLit = null;     // bash da la misma lista que zsh
    } else zshLit = `{${contenido}}`;
  } else if (/^-?\d*\.\.-?\d*(?:\.\.-?\d*)?$/.test(contenido)) {
    zshLit = contenido;                                                         // zsh: `{1..}` → `1..`
  } else return null;
  if (!zsh.length && zshLit === null) zshLit = `{${contenido}}`;
  const partes = [...zsh, ...bash];
  const literales = [zshLit, bashLit].filter((x) => x !== null);
  const cuenta = partes.reduce((s0, p) => s0 + p.cuenta, 0) + literales.length;
  return { t: 'rango', cuenta, gen: () => [...partes.flatMap((p) => p.gen().map(escLit)), ...literales.map(escLit)] };
}

/** Parte `s` (el contenido de `{…}` o de `(…)`) en el separador `sep` de primer nivel. */
function partirPrimerNivel(s, sep) {
  const out = []; let ini = 0; let prof = 0;
  for (let j = 0; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '$' && s[j + 1] === '$') { j++; continue; }
    if (c === "'" || c === '"' || (c === '$' && s[j + 1] === "'")) { j = finDeComillas(s, j) - 1; continue; }
    if (c === '`') { j = finDeSustitucion(s, j) - 1; continue; }
    if (c === '{' || c === '(') prof++;
    else if (c === '}' || c === ')') prof--;
    else if (c === sep && prof === 0) { out.push(s.slice(ini, j)); ini = j + 1; }
  }
  out.push(s.slice(ini));
  return out;
}

const MAX_NESTING = 64;          // niveles de llaves o paréntesis anidados en una palabra (8.14 #26)
const MAX_FORKS = 6;         // llaves que zsh y bash leen distinto en una palabra: cada una lee el resto dos veces (#35)

/** ¿Hay un blanco fuera de comillas (y sin escapar) en `s`? */
function hasUnquotedBlank(s) {
  for (let j = 0; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === "'" || c === '"' || (c === '$' && s[j + 1] === "'")) { j = finDeComillas(s, j) - 1; continue; }
    if (c === '`' || (c === '$' && s[j + 1] === '(')) { j = finDeSustitucion(s, j) - 1; continue; }
    if (/\s/.test(c)) return true;
  }
  return false;
}

/**
 * La palabra cruda → secuencia de nodos. `asignacion`: el valor de `X=…` (sin llaves, sin comodines,
 * sin alternancia: el shell no los expande ahí).
 */
function parsear(raw, ctx, asignacion, subst) {
  const s = String(raw); const n = s.length;
  const seq = [];
  // los valores guardados son patrones ya expandidos: su `~` es un carácter, no el HOME
  const guardado = (x) => (x === SIN_RESOLVER || x === null || x === undefined ? DESCONOCIDO : String(x).replace(/~/g, '\\~'));
  // 🔴 Un arreglo (o una variable) sin valores vale DESCONOCIDO, no «nada»: una alternativa vacía multiplica la palabra
  // entera por cero y el freno se quedaba sin nombres que juzgar (`a=(); rm …/x$a.json`; revisión de la tanda A, 8.14)
  const alMenosUno = (lista) => (lista.length ? lista : [DESCONOCIDO]);
  const valoresDe = (nombre, entreComillas) => {
    if (ctx.arrays && Object.prototype.hasOwnProperty.call(ctx.arrays, nombre)) return alMenosUno([].concat(ctx.arrays[nombre]).map(guardado));
    if (ctx.vars && Object.prototype.hasOwnProperty.call(ctx.vars, nombre)) {
      const v = ctx.vars[nombre];
      const lista = alMenosUno((Array.isArray(v) ? v : [v]).map(guardado));
      return entreComillas || asignacion ? lista : lista.map((x) => x.replace(/\s+/g, (m) => PARTIR + m));
    }
    if (ctx.env && Object.prototype.hasOwnProperty.call(ctx.env, nombre)) return [escLit(ctx.env[nombre])];
    return null;
  };
  const variable = (nombre, entreComillas) => {
    const v = valoresDe(nombre, entreComillas);
    return v === null ? lit(DESCONOCIDO) : alt(v.map((x) => [lit(x)]));
  };
  // `$…` desde s[i] (s[i] === '$'); devuelve el índice siguiente
  const dolar = (i, entreComillas, dst) => {
    const nx = s[i + 1];
    if (nx === "'" && !entreComillas) {
      const f = finDeComillas(s, i);
      if (s[f - 1] !== "'" || f - 1 <= i + 1) throw new Indecidible('una comilla $\'…\' sin cerrar');
      // bash y zsh leen distinto los escapes que no conocen: las dos lecturas (8.14 #34)
      const inner = s.slice(i + 2, f - 1);
      const bash = decodeAnsiC(inner); const zsh = decodeAnsiCZsh(inner);
      dst.push(bash === zsh ? lit(escLit(bash)) : alt([[lit(escLit(bash))], [lit(escLit(zsh))]])); return f;
    }
    if (nx === '"' && !entreComillas) {
      const adentro = []; const f = dobles(i + 1, adentro);
      dst.push(alt([adentro, [lit('$'), ...adentro]]));                      // bash: texto · zsh: `$` + texto
      return f;
    }
    if (nx === '(') {
      const k = cierreDe(s, i + 1);
      if (k < 0) throw new Indecidible('una sustitución $( sin cerrar');
      subst.push(s.slice(i + 2, k));
      dst.push(lit(DESCONOCIDO)); return k + 1;
    }
    if (nx === '{') {
      const k = cierreDe(s, i + 1);
      if (k < 0) throw new Indecidible('una variable ${ sin cerrar');
      const c = s.slice(i + 2, k);
      let m;
      if (/^[A-Za-z_]\w*$/.test(c)) dst.push(variable(c, entreComillas));
      else if ((m = /^([A-Za-z_]\w*)\[[^\]]*\]$/.exec(c)) && ctx.arrays && Object.prototype.hasOwnProperty.call(ctx.arrays, m[1])) dst.push(variable(m[1], entreComillas));
      else dst.push(lit(DESCONOCIDO));                                        // operador, bandera, especial
      return k + 1;
    }
    NOMBRE_VAR.lastIndex = i + 1;
    let m = NOMBRE_VAR.exec(s);
    if (m) {
      const nombre = m[0]; let j = i + 1 + nombre.length;
      if (s[j] === '[' && ctx.arrays && Object.prototype.hasOwnProperty.call(ctx.arrays, nombre)) {
        const k = s.indexOf(']', j); if (k > 0) j = k + 1;                    // `$a[2]` de zsh: la unión
      }
      MODIFICADOR_Y.lastIndex = j;
      if (MODIFICADOR_Y.test(s)) {
        // modificador de zsh (`$X:l`, `$X:s/a/b/`, `$X:h`…): la carpeta del valor + `*`, o `*` si no se sabe
        while ((MODIFICADOR_Y.lastIndex = j, m = MODIFICADOR_Y.exec(s))) {
          const letra = m[0].slice(-1); j += m[0].length;
          if (letra === 's') { const d = s[j]; let cuenta = 0; j++; while (j < n && cuenta < 2) { if (s[j] === d) cuenta++; j++; } }
        }
        const v = valoresDe(nombre, true);
        if (v === null) dst.push(lit(DESCONOCIDO));
        else dst.push(alt(v.map((x) => { const k2 = x.lastIndexOf('/'); return [lit(k2 >= 0 ? x.slice(0, k2 + 1) + DESCONOCIDO : DESCONOCIDO)]; })));
        return j;
      }
      dst.push(variable(nombre, entreComillas)); return j;
    }
    if (nx !== undefined && /[0-9@*#?$!-]/.test(nx)) { dst.push(lit(DESCONOCIDO)); return i + 2; }   // `$1`, `$@`, `$?`…
    dst.push(lit('$')); return i + 1;
  };
  // `"…"` desde s[i] (s[i] === '"'); devuelve el índice siguiente
  const dobles = (i, dst) => {
    let j = i + 1;
    for (; j < n; j++) {
      const c = s[j];
      if (c === '"') return j + 1;
      if (c === '\\' && j + 1 < n) {
        if ('$`"\\\n'.includes(s[j + 1])) { if (s[j + 1] !== '\n') dst.push(lit(escLit(s[j + 1]))); j++; continue; }
        dst.push(lit('\\\\')); continue;
      }
      if (c === '$') { j = dolar(j, true, dst) - 1; continue; }
      if (c === '`') {
        const f = finDeSustitucion(s, j);
        if (s[f - 1] !== '`' || f - 1 === j) throw new Indecidible('una comilla invertida sin cerrar');
        subst.push(s.slice(j + 1, f - 1)); dst.push(lit(DESCONOCIDO)); j = f - 1; continue;
      }
      dst.push(lit(escLit(c)));
    }
    throw new Indecidible('una comilla doble sin cerrar');
  };
  // la palabra (o un pedazo de ella) desde i hasta fin
  // 🔴 la profundidad tiene tope: llaves o paréntesis anidados a 1.500 niveles (unos 6 KB) desbordaban la pila, y la
  // excepción salía del expansor como una falla cualquiera (8.14 #26). Ningún nombre de verdad anida tanto: es indecidible.
  let nesting = 0; let forks = 0;
  // desde la `{` en s[i]: dónde la cierra bash (una `}` de primer nivel después de una coma de primer nivel), o -1
  const skipQuoted = (j) => {
    const c = s[j];
    if (c === '\\') return j + 1;
    if (c === "'" || c === '"' || (c === '$' && s[j + 1] === "'")) return finDeComillas(s, j) - 1;
    if (c === '`' || (c === '$' && s[j + 1] === '(')) return finDeSustitucion(s, j) - 1;
    if (c === '$' && s[j + 1] === '{') { const k = cierreDe(s, j + 1); return k < 0 ? s.length : k; }
    return -1;
  };
  const bashBraceClose = (i, fin) => {
    let nivel = 0; let coma = false;
    for (let j = i + 1; j < fin; j++) {
      const sj = skipQuoted(j); if (sj >= 0) { j = sj; continue; }
      const c = s[j];
      if (c === '{') nivel++;
      else if (c === '}') { if (nivel > 0) nivel--; else if (coma) return j; }
      else if (c === ',' && nivel === 0) coma = true;
    }
    return -1;
  };
  // las alternativas de bash entre `ini` y `fin`: comas de primer nivel, donde una `}` sin pareja no baja de nivel
  const splitBashAlternatives = (ini, fin) => {
    const out = []; let a = ini; let nivel = 0;
    for (let j = ini; j < fin; j++) {
      const sj = skipQuoted(j); if (sj >= 0) { j = sj; continue; }
      const c = s[j];
      if (c === '{') nivel++;
      else if (c === '}') { if (nivel > 0) nivel--; }
      else if (c === ',' && nivel === 0) { out.push([a, j]); a = j + 1; }
    }
    out.push([a, fin]);
    return out;
  };
  const secuencia = (ini, fin, dst) => {
    if (++nesting > MAX_NESTING) throw new Indecidible('llaves o paréntesis anidados de más');
    try { return flatSequence(ini, fin, dst); } finally { nesting--; }
  };
  const flatSequence = (ini, fin, dst) => {
    for (let i = ini; i < fin; i++) {
      const c = s[i];
      // la continuación de línea (y la barra al final de la palabra, que sólo queda así al final del texto) se quitan (8.14 #13, #37)
      if (c === '\\' && (s[i + 1] === '\n' || i + 1 >= n)) { i++; continue; }
      if (c === '\\') { if (i + 1 < fin) { dst.push(lit(escLit(s[i + 1]))); i++; } else dst.push(lit('\\\\')); continue; }
      if (c === "'") {
        const k = s.indexOf("'", i + 1);
        if (k < 0 || k >= fin) throw new Indecidible('una comilla simple sin cerrar');
        dst.push(lit(escLit(s.slice(i + 1, k)))); i = k; continue;
      }
      if (c === '"') { i = dobles(i, dst) - 1; continue; }
      if (c === '$') { i = dolar(i, false, dst) - 1; continue; }
      if (c === '`') {
        const f = finDeSustitucion(s, i);
        if (s[f - 1] !== '`' || f - 1 === i) throw new Indecidible('una comilla invertida sin cerrar');
        subst.push(s.slice(i + 1, f - 1)); dst.push(lit(DESCONOCIDO)); i = f - 1; continue;
      }
      // `<(…)`, `>(…)` y el `=(…)` de zsh al principio: una sustitución de proceso (el shell pone ahí un `/dev/fd/N`); su
      // texto se juzga aparte, como el de `$(…)`. No es un paréntesis de palabra (8.14 #39: con blancos sería indecidible)
      if ((c === '<' || c === '>' || (c === '=' && i === 0)) && s[i + 1] === '(' && !asignacion) {
        const k = cierreDe(s, i + 1);
        if (k >= 0 && k < fin) { subst.push(s.slice(i + 2, k)); dst.push(lit(DESCONOCIDO)); i = k; continue; }
      }
      // `~` al principio de la palabra (o de una alternativa de llaves: bash expande la tilde después) es el HOME
      if (c === '~' && i === ini) { dst.push(lit('~')); continue; }
      if (asignacion) { dst.push(lit(asignacion !== 'literal' && (c === '*' || c === '?' || c === '[' || c === ']') ? c : escLit(c))); continue; }
      if (c === '{') {
        const k = cierreDe(s, i);
        if (k >= 0 && k < fin) {
          const contenido = s.slice(i + 1, k);
          const partes = partirPrimerNivel(contenido, ',');
          if (partes.length >= 2) {
            let off = i + 1; const alts = [];
            for (const p of partes) { const sub = []; secuencia(off, off + p.length, sub); alts.push(sub); off += p.length + 1; }
            dst.push(alt(alts)); i = k; continue;
          }
          const r = !/["'$`\\]/.test(contenido) ? rango(contenido) : null;
          if (r) { dst.push(r); i = k; continue; }
        }
        // 🔴 bash 3.2 no cierra una llave en una `}` sin coma ni rango: sigue hasta la próxima `}` después de una coma
        // (`{x},y}` → `x}` y `y`; zsh lo deja literal). Las dos lecturas: el resto de la palabra se lee dos veces (8.14 #35)
        const kb = bashBraceClose(i, fin);
        if (kb >= 0) {
          if (++forks > MAX_FORKS) throw new Indecidible('demasiadas llaves que zsh y bash leen distinto');
          const zshReading = [lit('{')]; secuencia(i + 1, fin, zshReading);
          const bashReading = [alt(splitBashAlternatives(i + 1, kb).map(([a, b]) => secuencia(a, b, [])))]; secuencia(kb + 1, fin, bashReading);
          dst.push(alt([zshReading, bashReading])); i = fin; continue;
        }
        dst.push(lit('{')); continue;                                        // `{x}`, `{}`, `{` sin cerrar: literal
      }
      if (c === '(') {
        const k = cierreDe(s, i);
        if (k < 0 || k >= fin) throw new Indecidible('un paréntesis sin cerrar');
        const contenido = s.slice(i + 1, k);
        const previo = s[i - 1];
        const escapadoPrevio = i >= 2 && s[i - 2] === '\\';
        if (i > ini && /[@+!*?]/.test(previo) && !escapadoPrevio) { dst.push(lit(EXTENDIDO)); i = k; continue; }   // `@(…)` de ksh
        if (contenido.startsWith('#')) { dst.push(lit(EXTENDIDO)); i = k; continue; }                              // `(#i)`, `(#q…)`
        // un paréntesis con blancos sin comillas no es un patrón ni un calificador: es un comando que el partidor no separó
        // (`(rm -f …)` entero como palabra). Tirarlo dejaba la palabra en «nada»; es indecidible (8.14 #39)
        if (hasUnquotedBlank(contenido)) throw new Indecidible('un paréntesis con blancos');
        if (k === n - 1 && fin === n && i > ini && !partirPrimerNivel(contenido, '|').slice(1).length) { i = k; continue; } // calificador final `(N)`
        let off = i + 1; const alts = [];
        for (const p of partirPrimerNivel(contenido, '|')) { const sub = []; secuencia(off, off + p.length, sub); alts.push(sub); off += p.length + 1; }
        dst.push(alt(alts)); i = k; continue;
      }
      if (c === ')' || c === '|') throw new Indecidible(`un «${c}» suelto`);
      if (c === '*') { while (s[i + 1] === '*' && i + 1 < fin) i++; dst.push(lit('*')); continue; }   // `**` = `*`
      if (c === '?') { dst.push(lit('?')); continue; }
      if (c === '[') {
        let k = i + 1; if (s[k] === '!' || s[k] === '^') k++; if (s[k] === ']') k++;
        const cierre = s.indexOf(']', k);
        if (cierre > 0 && cierre < fin) { dst.push(lit(s.slice(i, cierre + 1).replace(/\\(?=[\s\S])/g, ''))); i = cierre; continue; }
        dst.push(lit('\\[')); continue;
      }
      if (c === '^' || c === '#' || c === '~') { dst.push(lit(EXTENDIDO)); continue; }   // glob extendido de zsh
      dst.push(lit(escLit(c)));
    }
    return dst;
  };
  return secuencia(0, n, seq);
}

function contar(seq) {
  let total = 1;
  for (const nodo of seq) {
    if (nodo.t === 'alt') total *= nodo.alts.reduce((s0, a) => s0 + contar(a), 0);
    else if (nodo.t === 'rango') total *= nodo.cuenta;
    if (!(total <= Number.MAX_SAFE_INTEGER)) return Infinity;
  }
  return total;
}

function generar(seq, vencido) {
  let res = [''];
  for (const nodo of seq) {
    let vals;
    if (nodo.t === 'lit') vals = [nodo.v];
    else if (nodo.t === 'rango') vals = nodo.gen();
    else vals = nodo.alts.flatMap((a) => generar(a, vencido));
    const nuevo = [];
    for (const r of res) for (const v of vals) nuevo.push(r + v);
    res = nuevo;
    if (vencido && vencido()) throw new Indecidible('el reloj');
  }
  return res;
}

/**
 * La lectura gruesa (presupuesto agotado o reloj vencido): cada rango vale `*`, y cada lista vale `*` MÁS sus alternativas
 * que cruzan una `/`, leídas gruesas a su vez. 🔴 Un `*` no cruza `/`: con sólo `*`, `~/.claude/{.tycon-pipeline/x.json,
 * {1..5000}}` quedaba en `~/.claude/*` y el nombre entero desaparecía (8.14 #11, AC 15). Con tope: pasado `COARSE_LIMIT`,
 * null, y quien llama suma la palabra cruda como patrón.
 */
const COARSE_LIMIT = 256;
function coarseReadings(seq) {
  let res = [''];
  for (const nodo of seq) {
    let vals;
    if (nodo.t === 'lit') vals = [nodo.v];
    else if (nodo.t === 'rango') vals = [DESCONOCIDO];
    else {
      const withSlash = new Set(); let withoutSlash = false;
      for (const a of nodo.alts) {
        const sub = coarseReadings(a);
        if (sub === null) return null;
        for (const x of sub) { if (x.includes('/')) withSlash.add(x); else withoutSlash = true; }
        if (withSlash.size > COARSE_LIMIT) return null;
      }
      vals = [...(withoutSlash ? [DESCONOCIDO] : []), ...withSlash];
    }
    if (res.length * vals.length > COARSE_LIMIT) return null;
    const nuevo = [];
    for (const r of res) for (const v of vals) nuevo.push(r + v);
    res = nuevo;
  }
  return res;
}
/** La palabra cruda con todo lo raro como comodín: lo que vale cuando no se la puede leer (o la lectura gruesa no entra). */
const rawAsPattern = (raw) => String(raw).replace(/[\\*?[\]]/g, '').replace(/[(){}|'"`$]/g, '*').replace(/\*+/g, '*') || '*';
function grueso(seq, raw) {
  const g = coarseReadings(seq);
  return g === null ? [seq.map((nodo) => (nodo.t === 'lit' ? nodo.v : DESCONOCIDO)).join(''), rawAsPattern(raw)] : g;
}

/** Del patrón interno al patrón final: `~` → HOME, glob extendido → componente `*`, marcas → `*`, escapes de lo que no es comodín fuera. */
function terminar(p, home) {
  let s = p;
  if (s.includes(EXTENDIDO)) {
    s = s.split('/').map((comp) => (comp.includes(EXTENDIDO) ? '*' : comp)).join('/');
  }
  if (s.startsWith('~')) {
    const m = /^~([^/]*)/.exec(s);
    s = (m[1] === '' ? escLit(home) : DESCONOCIDO) + s.slice(m[0].length);
  }
  let out = ''; let desconocido = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { const d = s[++i]; out += '\\*?[]'.includes(d) ? '\\' + d : d; continue; }
    if (c === DESCONOCIDO) { out += '*'; desconocido = true; continue; }
    out += c;
  }
  return { patron: out, desconocido };
}

/**
 * Expande UNA palabra cruda como lo harían zsh y bash 3.2 (la unión).
 * @param {string} raw la palabra con sus comillas, tal como sale de `splitWords`/`parseSimpleCommand`
 * @param {object} [ctx] `{ vars, arrays, env, home, budget, expired, shellOptionsChanged }` —
 *   `vars`: nombre → patrón o lista de patrones (lo que el propio comando definió; `applyAssignments`
 *   lo arma); `arrays`: nombre → lista de patrones; `env`: nombre → texto literal que quien llama sabe;
 *   `budget`: un `ExpansionBudget` compartido por todo el comando; `expired`: el reloj del freno.
 * @param {object} [opts] `{ assignment: true }` para el valor de `X=…` (sin llaves ni alternancia; un comodín
 *   sin comillas queda comodín, porque bash lo expande al USAR la variable) · `{ hereString: true }` para el
 *   destino de `<<<` (ni llaves ni comodines: `<<< a{b,c}` y `<<< x*` llegan tal cual, en zsh y en bash)
 * @returns {{patterns:string[], unknown:boolean, glob:boolean, undecidable:boolean, exhausted:boolean, reason:string|null, substitutions:string[]}}
 */
function expandWord(raw, ctx, opts) {
  ctx = ctx || {};
  const home = ctx.home || os.homedir();
  const asignacion = opts && opts.hereString ? 'literal' : !!(opts && opts.assignment);
  const subst = [];
  const res = { patterns: [], unknown: false, glob: false, undecidable: false, exhausted: false, reason: null, substitutions: subst };
  let seq;
  try { seq = parsear(raw, ctx, asignacion, subst); } catch (e) {
    // una pila desbordada es lo mismo que «no se puede leer»: nunca una falla que el freno no sepa juzgar (8.14 #26)
    if (!(e instanceof Indecidible) && !(e instanceof RangeError)) throw e;
    res.undecidable = true; res.reason = e instanceof RangeError ? 'una palabra anidada de más' : e.message;
    // lo que no se pudo leer vale `*`: la palabra cruda con todo lo raro como comodín
    res.patterns = [rawAsPattern(raw)];
    res.unknown = true; res.glob = true;
    return res;
  }
  let crudos;
  const total = contar(seq);
  if (ctx.budget && !ctx.budget.take(total)) {
    res.exhausted = true; res.undecidable = true; res.reason = 'el presupuesto de expansiones';
    crudos = grueso(seq, raw);
  } else {
    try { crudos = generar(seq, ctx.expired); } catch (e) {
      if (!(e instanceof Indecidible)) throw e;
      res.exhausted = true; res.undecidable = true; res.reason = e.message;
      crudos = grueso(seq, raw);
    }
  }
  // bash parte una variable sin comillas en sus blancos; zsh no: las dos lecturas
  const lecturas = [];
  for (const c of crudos) {
    if (!c.includes(PARTIR)) { lecturas.push(c); continue; }
    lecturas.push(c.split(PARTIR).join(''));
    for (const pedazo of c.split(new RegExp(PARTIR + '\\s+'))) if (pedazo) lecturas.push(pedazo);
  }
  const vistos = new Set();
  for (const c of lecturas) {
    const { patron, desconocido } = terminar(c, home);
    if (desconocido) res.unknown = true;
    if (!vistos.has(patron)) { vistos.add(patron); res.patterns.push(patron); }
  }
  res.glob = res.patterns.some((p) => !patternIsLiteral(p));
  if (ctx.shellOptionsChanged) { res.undecidable = true; res.reason = res.reason || 'un comando que cambia cómo el shell lee las palabras'; }
  return res;
}

/** ¿El patrón no tiene comodines sin escapar? */
function patternIsLiteral(p) {
  for (let i = 0; i < p.length; i++) { if (p[i] === '\\') { i++; continue; } if ('*?['.includes(p[i])) return false; }
  return true;
}
/** El texto de un patrón literal (sin los escapes). */
function patternToLiteral(p) { return String(p).replace(/\\([\s\S])/g, '$1'); }
/** El patrón como RegExp anclada: `*` y `?` no cruzan `/`. `{ nocase: true }` sin distinguir mayúsculas. */
function patternToRegExp(p, opciones) {
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\' && i + 1 < p.length) { re += p[++i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); continue; }
    if (c === '*') { re += '[^/]*'; continue; }
    if (c === '?') { re += '[^/]'; continue; }
    if (c === '[') {
      const k = p.indexOf(']', i + 2);
      if (k > 0) { let clase = p.slice(i + 1, k); if (/^[!^]/.test(clase)) clase = '^' + clase.slice(1); re += '[' + clase.replace(/\\/g, '\\\\') + ']'; i = k; continue; }
    }
    re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', opciones && opciones.nocase ? 'i' : '');
}

// ── 5. variables, arreglos y opciones del propio comando (story 8.14) ─────────────────────────
const OPCIONES_INOCUAS = new Set(['pipefail', 'errexit', 'unset', 'xtrace', 'verbose', 'clobber']);
const normOpcion = (o) => String(o).toLowerCase().replace(/_/g, '').replace(/^no/, '');

// ── las opciones pasadas al INVOCAR un shell (8.14 #20) ──
// `zsh -o braceccl -c '…'`, `zsh --braceccl -c '…'`, `bash -O extglob -c '…'`: el texto de `-c` se lee con otras reglas.
// Banderas de una letra que no tocan cómo se leen los nombres (`-c`, `-l`, `-e`, `-x`, `-f` —en zsh sin rc, en bash sin
// comodines: menos nombres, nunca más—…) y opciones largas de arranque (`--login`, `--norc`…). Todo lo demás cuenta.
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const HARMLESS_FLAGS = /^[-+][bcefilnprsuvx]+$/;
const HARMLESS_LONG_OPTIONS = new Set(['login', 'rc', 'rcs', 'globalrcs', 'profile', 'rcfile', 'initfile', 'verbose', 'editing', 'restricted',
  'debugger', 'help', 'version', 'interactive', 'posix', 'xtrace', 'errexit', 'unset', 'pipefail', 'clobber']);
const SHELL_PREFIXES = new Set(['sudo', 'env', 'exec', 'nohup', 'time', 'nice', 'command', 'builtin']);
function invokesShellWithOptions(w) {
  let i = 0;
  while (i < w.length) {                                                  // `sudo -E`, `env -i A=b`, `nice -n 5`…
    const b = w[i].replace(/^\\/, '').split('/').pop();
    if (!SHELL_PREFIXES.has(b)) break;
    i++;
    while (i < w.length && (/^-/.test(w[i]) || (b === 'env' && /^[A-Za-z_]\w*=/.test(w[i])))) i += /^-[nu]$/.test(w[i]) ? 2 : 1;
  }
  if (!SHELLS.has((w[i] || '').replace(/^\\/, '').split('/').pop())) return false;
  for (let k = i + 1; k < w.length; k++) {
    const a = w[k];
    if (a === '--' || a === '-' || !/^[-+]/.test(a)) return false;       // el guion o el texto: lo que sigue son sus argumentos
    if (/^--/.test(a)) {
      const name = normOpcion(a.slice(2).replace(/-/g, ''));
      if (name === 'rcfile' || name === 'initfile') { k++; continue; }
      if (!HARMLESS_LONG_OPTIONS.has(name)) return true;
      continue;
    }
    if (/^[-+][A-Za-z]*[oO]$/.test(a)) {                                   // `-o <opción>`, `-fo <opción>`, `-O <opción>`
      const o = w[k + 1];
      if (o === undefined) return false;
      if (/O$/.test(a) || !OPCIONES_INOCUAS.has(normOpcion(o))) return true;
      k++;
      if (/c/.test(a)) return false;
      continue;
    }
    if (!HARMLESS_FLAGS.test(a)) return true;
    if (/c/.test(a)) return false;                                          // `-c`: lo que sigue es el texto
  }
  return false;
}

/**
 * ¿Este comando simple cambia cómo el shell lee las palabras? `setopt`, `unsetopt`, `emulate`, `shopt -s|-u|-o`,
 * `set -o|+o <opción>` — salvo las opciones que no tocan nombres (`pipefail`, `errexit`, `nounset`, `xtrace`,
 * `verbose`, `noclobber`: `set -euo pipefail` es de todos los días).
 * @param {{words:string[]}|string[]} parsed lo de `parseSimpleCommand`, o sus palabras
 */
function changesShellOptions(parsed) {
  // `GLOBIGNORE=…` prende `dotglob` en bash: un comodín sin punto empieza a casar con `.tycon-pipeline` (8.14)
  if (!Array.isArray(parsed) && (parsed.assignments || []).some((a) => a.name === 'GLOBIGNORE')) return true;
  const w = (Array.isArray(parsed) ? parsed : parsed.words).map((x) => tokens(x)[0] || '');
  let i = 0;
  while (i < w.length && (w[i] === 'builtin' || w[i] === 'command')) i++;
  const prog = (w[i] || '').replace(/^\\/, '');
  const args = w.slice(i + 1);
  if (prog === 'setopt' || prog === 'unsetopt' || prog === 'emulate') return args.length > 0;
  if (invokesShellWithOptions(w)) return true;
  if (prog === 'shopt') return args.some((a) => /^-[a-z]*[suo]/.test(a));
  if (prog === 'set') {
    for (let k = 0; k < args.length; k++) {
      if (!/^[-+][A-Za-z]*o[A-Za-z]*$/.test(args[k])) continue;
      const o = args[k + 1];
      if (o === undefined || /^[-+]/.test(o)) continue;
      if (!OPCIONES_INOCUAS.has(normOpcion(o))) return true;
      k++;
    }
  }
  return false;
}

const OPENS_BRANCH = new Set(['if', 'while', 'until', 'case', 'for', 'select', 'repeat', 'foreach']);
const CLOSES_BRANCH = new Set(['fi', 'done', 'esac', 'end']);

/**
 * Suma a `ctx` (`vars`, `arrays`) lo que asigna este comando simple, EN ORDEN: quien llama recorre los
 * segmentos y expande las palabras de cada uno con lo que había antes. Un valor nuevo se SUMA al anterior
 * (la unión: una rama de un `if` no borra la otra). `for X in …`, `select X`, `read … X` dejan X desconocida;
 * `unset X` la olvida.
 * `opts.previousSep`: el separador del segmento ANTERIOR (`segs[k - 1].sep`, o '' en el primero). Con él, una asignación
 * que corre seguro y en el mismo shell —primer segmento o detrás de `;`/salto de línea, fuera de un `if`/`case`/lazo—
 * REEMPLAZA el valor, como el shell (8.14 #28: `OUT=<protegida>; ls $OUT; OUT=build; rm -rf $OUT/*` frenaba). Detrás de
 * `&&`, `||`, `|`, `&`, `(` o `)` puede no correr o correr en una subshell: la unión. Sin `opts`, la unión de siempre.
 */
function applyAssignments(ctx, parsed, opts) {
  ctx.vars = ctx.vars || {}; ctx.arrays = ctx.arrays || {};
  const sumar = (mapa, nombre, valores) => {
    const prev = Object.prototype.hasOwnProperty.call(mapa, nombre) ? [].concat(mapa[nombre]) : [];
    mapa[nombre] = [...new Set([...prev, ...valores])];
  };
  // la profundidad de ramas (`if`, `case`, `for`, `while`…) se lleva en ctx: adentro, siempre la unión
  const w0 = parsed.words.map((x) => tokens(x)[0] || '');
  if (CLOSES_BRANCH.has(w0[0])) ctx.branchDepth = Math.max(0, (ctx.branchDepth || 0) - 1);
  const opens = parsed.reserved.some((r) => OPENS_BRANCH.has(r)) || OPENS_BRANCH.has(w0[0]);
  const replaces = !!opts && (opts.previousSep === '' || opts.previousSep === ';') && !(ctx.branchDepth > 0) && !opens;
  // `X=a cmd` sólo vale para ese comando: no reemplaza la X del shell (`export`/`typeset`… sí). `ctx.replaced` dice qué
  // nombres reemplazó ESTE comando, para que quien lleva datos propios de cada variable los olvide también
  ctx.replaced = new Set();
  const reemplazar = (mapa, nombre, valores) => { mapa[nombre] = [...new Set(valores)]; ctx.replaced.add(nombre); };
  const setterFor = (a) => (replaces && (!parsed.words.length || a.builtin) ? reemplazar : sumar);
  // un valor que es SÓLO algo sin resolver (`F=$(ls …)`, `F=$X`) se guarda como DESCONOCIDO, no como el comodín `*`: al
  // usarla, quien juzga tiene que poder distinguir «no sé qué vale» de «el shell expande un comodín» (8.14, T30)
  const patrones = (r) => r.patterns.map((p) => (r.unknown && p === '*' ? DESCONOCIDO : p));
  for (const a of parsed.assignments) {
    const assign = setterFor(a);
    if (a.array) {
      const elementos = a.array.flatMap((w) => patrones(expandWord(w, ctx)));
      if (a.op === '+=') sumar(ctx.arrays, a.name, elementos);
      else assign(ctx.arrays, a.name, elementos);
      continue;
    }
    const valores = patrones(expandWord(a.raw, ctx, { assignment: true }));
    if (a.element) { sumar(ctx.arrays, a.name, valores); continue; }
    if (a.op === '+=') {
      const prev = ctx.vars[a.name] ? [].concat(ctx.vars[a.name]) : [DESCONOCIDO];
      assign(ctx.vars, a.name, prev.flatMap((p) => valores.map((v) => p + v)));
    } else assign(ctx.vars, a.name, valores);
  }
  if (opens) ctx.branchDepth = (ctx.branchDepth || 0) + 1;
  const w = parsed.words.map((x) => tokens(x)[0] || '');
  if ((w[0] === 'for' || w[0] === 'select') && /^[A-Za-z_]\w*$/.test(w[1] || '')) sumar(ctx.vars, w[1], [DESCONOCIDO]);
  if (w[0] === 'read') {
    for (let k = 1; k < w.length; k++) {
      if (/^-[A-Za-z]*a$/.test(w[k]) || w[k] === '-A') {                    // `read -a arr`: el arreglo, desconocido
        if (/^[A-Za-z_]\w*$/.test(w[k + 1] || '')) sumar(ctx.arrays, w[++k], [DESCONOCIDO]);
        continue;
      }
      if (/^-[A-Za-z]*[dinNptu]$/.test(w[k])) { k++; continue; }            // opciones con argumento
      if (/^-/.test(w[k])) continue;
      if (/^[A-Za-z_]\w*$/.test(w[k])) sumar(ctx.vars, w[k], [DESCONOCIDO]);
    }
  }
  if (w[0] === 'unset') for (const x of w.slice(1)) { delete ctx.vars[x]; delete ctx.arrays[x]; }
  return ctx;
}

/** Las variables y arreglos que define todo el texto, en orden (segmento por segmento). */
function commandVariables(texto, ctx) {
  const c = ctx || { vars: {}, arrays: {} };
  const segs = segmentos(texto);
  segs.forEach((seg, k) => applyAssignments(c, parseSimpleCommand(seg.texto), { previousSep: k ? segs[k - 1].sep : '' }));
  return c;
}

// ── el programa que un intérprete lee de su entrada ──────────────────────────────────────────────────────────

// Intérpretes que, sin un archivo de programa, leen el programa de la entrada estándar.
const LEE_SU_PROGRAMA = /^(?:python(?:\d+(?:\.\d+)*)?|pypy\d*|node|nodejs|bun|deno|perl|ruby|php|osascript|pwsh|powershell)$/;
// opciones que llevan su valor aparte (`-W ignore`, `-l JavaScript`, `-r ./x.js`)
const OPCION_CON_VALOR = new Set(['-W', '-X', '-l', '-r', '--require', '--import']);
// el programa va en un argumento: lo que llega por la entrada es dato
const PROGRAMA_EN_ARGUMENTO = /^(?:-[A-Za-z]*[ce]|--eval|-p|--print|-m|-Command)$/;
const ENTRADA = new Set(['-', '/dev/stdin', '/dev/fd/0']);

/**
 * Si las palabras de una etapa corren un intérprete que lee su programa de la entrada: `{ interprete, conGuion,
 * despues }` (`despues`: las palabras que siguen al `-` o a `/dev/stdin`, que son los argumentos del programa), o null.
 * El intérprete se busca en toda la etapa: así también se ve detrás de `env`, `time -p`, `arch`, `stdbuf` o `uv run`.
 */
function lectorDePrograma(palabras) {
  const w = [];
  for (let i = 0; i < palabras.length; i++) {
    const p = palabras[i].replace(/^[({]+/, '');
    if (/^\d*(?:[<>]{1,3}|&>>?|>&|<&|<>)$/.test(p)) { i++; continue; }      // una redirección y su destino
    if (/^\d*(?:[<>]|&>)/.test(p)) continue;                                // la redirección pegada a su destino
    if (p && p !== '}' && p !== ')') w.push(p);
  }
  const i = w.findIndex((p) => LEE_SU_PROGRAMA.test(p.replace(/^.*[\\/]/, '').toLowerCase().replace(/\.exe$/, '')));
  if (i < 0) return null;
  const interprete = w[i].replace(/^.*[\\/]/, '').toLowerCase().replace(/\.exe$/, '');
  for (let k = i + 1; k < w.length; k++) {
    if ((interprete === 'deno' || interprete === 'bun') && w[k] === 'run') continue;
    if (ENTRADA.has(w[k])) return { interprete, conGuion: true, despues: w.slice(k + 1) };
    if (OPCION_CON_VALOR.has(w[k])) { k++; continue; }
    if (PROGRAMA_EN_ARGUMENTO.test(w[k])) return null;
    if (w[k].startsWith('-')) continue;
    return null;                                                            // un archivo de programa: la entrada es dato
  }
  return { interprete, conGuion: false, despues: [] };
}

/** Cada índice de `s` entre `desde` y `hasta` fuera de comillas y escapes, con su carácter. */
function* fueraDeComillas(s, desde, hasta) {
  for (let i = desde; i < hasta; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"' || (c === '$' && s[i + 1] === "'")) { i = finDeComillas(s, i) - 1; continue; }
    yield [i, c];
  }
}

/** Dónde empieza el comando (la tubería entera) que contiene la posición `i`: después del `;`, `&&`, `(`… anterior. */
function inicioDeLaTuberia(s, i) {
  let ini = s.lastIndexOf('\n', i - 1) + 1;
  while (ini >= 2 && s[ini - 2] === '\\') ini = s.lastIndexOf('\n', ini - 3) + 1;   // la línea continuada con `\`
  let corte = ini;
  for (const [k, c] of fueraDeComillas(s, ini, i)) {
    const sig = s[k + 1];
    if (c === ';' || c === '`' || c === '(' || c === '\n') corte = k + 1;
    else if (c === '{' && /\s/.test(sig || '')) corte = k + 1;
    else if ((c === '&' && sig === '&') || (c === '|' && sig === '|')) corte = k + 2;
    else if (c === '&' && s[k - 1] !== '>' && s[k - 1] !== '<' && sig !== '>') corte = k + 1;
  }
  return corte;
}

/** El texto desde `i` hasta el final del comando (el `;`, `&&`, `)`… siguiente, o el fin de la línea). */
function finDelComando(s, i, hasta) {
  for (const [k, c] of fueraDeComillas(s, i, hasta)) {
    const sig = s[k + 1];
    if (c === ';' || c === '`' || c === ')' || c === '\n' || (c === '&' && sig === '&') || (c === '|' && sig === '|')) return k;
    if (c === '&' && s[k - 1] !== '>' && s[k - 1] !== '<' && sig !== '>') return k;
  }
  return hasta;
}

/** Las etapas de una tubería, por sus `|` fuera de comillas. */
function etapas(s) {
  const out = [];
  let ini = 0;
  for (const [k, c] of fueraDeComillas(s, 0, s.length)) if (c === '|' && s[k + 1] !== '|' && s[k - 1] !== '|') { out.push(s.slice(ini, k)); ini = k + 1; }
  out.push(s.slice(ini));
  return out;
}

/**
 * Lo que llega a la entrada estándar de un intérprete como su programa, por un heredoc (`python3 - <<EOF`) o un
 * here-string (`python3 <<< '…'`): `[{ interprete, conGuion, despues, cuerpo, comillas }]`. Cuenta el intérprete de la
 * etapa que recibe el texto y el de las etapas que le siguen en la tubería (`cat <<EOF | python3`), también en la
 * línea que sigue al cierre cuando la del `<<` termina en `|`. `comillas`: el shell no expande el texto.
 */
function programasPorEntrada(cmd) {
  const s = String(cmd);
  if (!s.includes('<<')) return [];
  const out = [];
  const juzgar = (texto, indice, resto, siguiente, cuerpo, comillas) => {
    const antes = etapas(texto.slice(inicioDeLaTuberia(texto, indice), indice));
    const despues = etapas(resto.slice(0, finDelComando(resto, 0, resto.length)));
    if (/\|\s*$/.test(resto) && siguiente != null) despues.push(...etapas(siguiente.slice(0, finDelComando(siguiente, 0, siguiente.length))));
    const propia = `${antes[antes.length - 1]} ${despues[0]}`;
    for (const etapa of [propia, ...despues.slice(1)]) {
      const l = lectorDePrograma(tokens(etapa));
      if (l) { out.push({ ...l, cuerpo, comillas }); return; }
    }
  };
  for (const h of heredocs(s)) {
    let sig = null;
    if (h.fin < s.length) { const f = s.indexOf('\n', h.fin + 1); sig = s.slice(h.fin + 1, f < 0 ? s.length : f); }
    juzgar(s, h.indice, h.resto, sig, h.cuerpo, h.comillas);
  }
  const sin = sinHeredocs(s);
  for (const [k] of fueraDeComillas(sin, 0, sin.length)) {
    if (!sin.startsWith('<<<', k)) continue;
    let j = k + 3;
    while (sin[j] === ' ' || sin[j] === '\t') j++;
    let f = j;
    while (f < sin.length && !/[\s;&|()<>]/.test(sin[f])) f = /['"]/.test(sin[f]) || (sin[f] === '$' && sin[f + 1] === "'") ? finDeComillas(sin, sin[f] === '$' ? f : f) : f + 1;
    const palabra = sin.slice(j, f);
    juzgar(sin, k, sin.slice(f), null, tokens(palabra).join(' '), /^\$?'/.test(palabra));
  }
  return out;
}

module.exports = {
  // las de siempre
  programasPorEntrada,
  sinHeredocs, segmentos, tokens, PREFIJOS, expandir, variablesDelComando, SIN_RESOLVER,
  heredocs, OPERADOR_HEREDOC,
  // story 8.14
  lex, lexWords, splitWords, parseSimpleCommand, substitutions, decodeAnsiC,
  expandWord, ExpansionBudget, EXPANSION_LIMIT, applyAssignments, commandVariables, changesShellOptions,
  patternIsLiteral, patternToLiteral, patternToRegExp,
};
