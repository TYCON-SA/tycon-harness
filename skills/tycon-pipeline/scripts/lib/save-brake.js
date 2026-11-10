'use strict';
/**
 * save-brake.js — el freno de guardar: dentro de una corrida o de un camino rápido (el carril firmado de `marker.js
 * adhoc set`), la persona aprueba lo que sale hacia el equipo, no cada commit. El commit y el empuje de la rama de
 * trabajo son del agente: no preguntan. El pedido (crearlo o mergearlo) y el empuje a una rama compartida (`main`,
 * `master`, `dev`, `release/*`) preguntan en la ventana de permiso, y en una corrida, además, frenan si el paso
 * «Preparar el pull request» no cerró o si el código ya no es el de su foto, y la pregunta trae la evidencia. Lo llama
 * `on-pre-commit.js` en cada comando de consola; en una pestaña que no pide permisos (la ventana se aprobaría sola) guarda
 * sin preguntar y lo dice en pantalla, y los frenos frenan igual. No hay firma ni constancia del ok: la constancia es el
 * pedido, y lo delicado (frenos, firmas, controles, producción) lo cubre la firma de control del pedido, que no cambia.
 *
 *   · comandosQueGuardan  los `git commit`, `git push` y los pedidos que se crean o se mergean (los comandos con `pr`
 *                         que declaran los conectores de plataforma en `rawCommands`) de verdad del comando, con su repo;
 *                         los que no se pueden leer (una variable, una carpeta que no se sabe, un programa que corre git
 *                         por su cuenta) salen como `opaco`;
 *   · leerComando         lo mismo y las dudas: lo que no se lee con certeza, guarde o no (un comando en una variable,
 *                         un shell que lee de la entrada, una función o un alias que no está en la copia del shell de
 *                         la sesión, un subcomando que no es de git, más de cuatro niveles, una ruta que no se
 *                         entiende, una comilla o un heredoc sin cerrar, un programa con lo que el shell expande, un
 *                         programa que no se encuentra y dice commit, push o pr). Los alias y las funciones de la copia
 *                         del shell (`~/.claude/shell-snapshots`) se leen como lo que corren. Los comentarios y los
 *                         heredocs con comillas no corren: se sacan antes de leer. Las redirecciones de la salida no
 *                         son una duda. Durante una corrida, una duda pregunta;
 *   · decidir             null (pasa), `{ aviso }` (pasa y lo dice en pantalla), `{ pregunta }` (el texto de la ventana)
 *                         o `{ texto }` (no guarda: un pedido sin preparar o con el código cambiado, o un camino rápido
 *                         al que le faltan los revisores y el pase, o la maqueta y la captura de su pantalla). Sin una
 *                         corrida ni un camino rápido abierto, o sin un comando que guarda ni una duda, no lee nada.
 *
 * Ninguna frase, opción ni variable saltea la ventana. El texto nombra la forma (`git push`, `… pr create`…) y el repo,
 * nunca el comando: un comando puede traer una credencial.
 *
 * Lo que no ve (lo dice guides/firmas-del-arnes.md): un guion o un programa que guarda sin nombrar git en el comando
 * (un archivo de guion corrido por su nombre, un programa que lee el comando de un archivo), los alias propios del
 * programa de la plataforma, los comandos de pedido que no lo crean ni lo mergean (la API, marcarlo listo, cambiarlo),
 * y los commits que hacen `merge`, `cherry-pick`, `revert`, `am` o `commit-tree`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SO = () => require('./save-ok.js');

// ── el lector del shell ─────────────────────────────────────────────────────────────────────────────────────────────

// El texto sin lo que el shell no corre: los comentarios, y los heredocs (su apertura y su cuerpo). `duda` si algo no se
// lee con certeza: una comilla o una sustitución sin cerrar, un heredoc sin su renglón de fin, o el cuerpo de un heredoc
// sin comillas que trae una sustitución (el shell la corre).
function limpiar(texto) {
  let out = '';
  // 'sq' (comillas simples), 'ansi' (`$'…'`), 'dq' (dobles), 'bt' (invertidas), o la cuenta de paréntesis de `$(…)`
  const pila = [];
  const pendientes = [];
  let duda = false;
  for (let i = 0; i < texto.length;) {
    const c = texto[i];
    const tope = pila[pila.length - 1];
    if (tope === 'sq') { if (c === "'") pila.pop(); out += c; i += 1; continue; }
    if (c === '\\' && i + 1 < texto.length) { out += texto.slice(i, i + 2); i += 2; continue; }
    if (tope === 'ansi') { if (c === "'") pila.pop(); out += c; i += 1; continue; }
    // una cuenta del shell (`$((…))`) va entera: su `<<` es un corrimiento, no un heredoc
    if (c === '$' && texto[i + 1] === '(' && texto[i + 2] === '(') { const j = finDeSustitucion(texto, i); out += texto.slice(i, j); i = j; continue; }
    if (tope === 'dq') {
      if (c === '"') pila.pop();
      else if (c === '`') pila.push('bt');
      else if (c === '$' && texto[i + 1] === '(') { pila.push(1); out += '$('; i += 2; continue; }
      out += c; i += 1; continue;
    }
    if (tope === 'bt' && c === '`') { pila.pop(); out += c; i += 1; continue; }
    if (c === '$' && texto[i + 1] === "'") { pila.push('ansi'); out += "$'"; i += 2; continue; }
    if (c === "'") { pila.push('sq'); out += c; i += 1; continue; }
    if (c === '"') { pila.push('dq'); out += c; i += 1; continue; }
    if (c === '`') { pila.push('bt'); out += c; i += 1; continue; }
    if (/[$<>]/.test(c) && texto[i + 1] === '(') { pila.push(1); out += texto.slice(i, i + 2); i += 2; continue; }
    if (typeof tope === 'number' && c === '(') pila[pila.length - 1] += 1;
    if (typeof tope === 'number' && c === ')' && --pila[pila.length - 1] === 0) pila.pop();
    // el comentario: un `#` al comienzo de una palabra, hasta el fin del renglón (dentro de comillas invertidas, hasta
    // la comilla que las cierra)
    if (c === '#' && (i === 0 || /[\s;&|()]/.test(texto[i - 1]))) {
      while (i < texto.length && texto[i] !== '\n' && !(texto[i] === '`' && pila.includes('bt'))) i += 1;
      continue;
    }
    if (c === '<' && texto[i + 1] === '<' && texto[i + 2] !== '<' && texto[i - 1] !== '<') {
      const m = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|(\\?)([^\s;&|()<>'"]+))/.exec(texto.slice(i));
      if (m) {
        const literal = m[2] !== undefined || m[3] !== undefined || m[4] === '\\';
        // el programa que recibe el cuerpo: el del tramo que abre el heredoc
        const tramo = out.slice(Math.max(...[';', '&', '|', '\n', '('].map((s) => out.lastIndexOf(s))) + 1);
        const programa = sinPrefijos(palabrasDelShell(tramo)).ps[0];
        pendientes.push({ fin: m[2] ?? m[3] ?? m[5], tabs: m[1] === '-', literal, programa: programa === undefined ? '' : normal(programa) });
        out += ' '; i += m[0].length; continue;
      }
    }
    // después del renglón que los abre, el cuerpo de cada heredoc hasta su renglón de fin
    if (c === '\n' && pendientes.length) {
      out += c; i += 1;
      for (const h of pendientes) {
        let cerro = false;
        const cuerpo = [];
        while (i < texto.length && !cerro) {
          const j = texto.indexOf('\n', i);
          const linea = texto.slice(i, j < 0 ? texto.length : j);
          i = j < 0 ? texto.length : j + 1;
          if ((h.tabs ? linea.replace(/^\t+/, '') : linea) === h.fin) cerro = true;
          else {
            cuerpo.push(linea);
            if (!h.literal && /\$\(|`/.test(linea)) duda = true;
          }
        }
        if (!cerro) duda = true;
        // un intérprete que corre el cuerpo como programa: si nombra un git que guarda, no se lee qué hace
        if (INTERPRETES.test(h.programa) && nombraUnGuardado([cuerpo.join('\n')])) duda = true;
      }
      pendientes.length = 0;
      continue;
    }
    out += c; i += 1;
  }
  if (pila.length || pendientes.length) duda = true;
  return { texto: out, duda };
}

// `$'…'`: las secuencias de la barra, como las arma el shell
const ANSI = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
function deAnsi(cuerpo) {
  return cuerpo.replace(/\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|[0-7]{1,3}|c.|.)/g, (todo, s) => {
    // un código fuera de Unicode no es un carácter: queda el de reemplazo
    if (/^[xuU]/.test(s)) { const n = parseInt(s.slice(1), 16); return n > 0x10FFFF ? '�' : String.fromCodePoint(n); }
    if (/^[0-7]/.test(s)) return String.fromCharCode(parseInt(s, 8));
    if (s[0] === 'c') return String.fromCharCode(s.charCodeAt(1) & 31);
    return ANSI[s] !== undefined ? ANSI[s] : todo;
  });
}
// el índice de la comilla que cierra un `$'…'` que abre en `i` (la de `$`), o el largo del texto
function finDeAnsi(texto, i) {
  let j = i + 2;
  while (j < texto.length && texto[j] !== "'") j += texto[j] === '\\' ? 2 : 1;
  return Math.min(j, texto.length);
}

// Los tramos de un comando de shell: corta en `;`, `&`, `|` y el salto de línea que están fuera de comillas y de una
// sustitución (`$(…)`, `<(…)`, `>(…)`, las comillas invertidas). La barra antes de un salto de línea sigue el renglón.
// El `&` y el `|` de una redirección (`2>&1`, `&>`, `>|`) no cortan.
function tramosDelShell(texto) { return tramosConSeparador(texto).map((t) => t.texto); }
// Lo mismo, con el separador que sigue a cada tramo: `&&`, `||`, `;`, `&`, `|`, el salto de línea, o '' al final.
function tramosConSeparador(texto) {
  const out = [];
  let cur = '';
  let prof = 0;
  for (let i = 0; i < texto.length;) {
    const c = texto[i];
    if (c === '\\' && texto[i + 1] === '\n') { i += 2; continue; }
    if (c === '$' && texto[i + 1] === "'") { const j = finDeAnsi(texto, i); cur += texto.slice(i, j + 1); i = j + 1; continue; }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < texto.length && texto[j] !== c) j += (c !== "'" && texto[j] === '\\') ? 2 : 1;
      cur += texto.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '\\' && i + 1 < texto.length) { cur += texto.slice(i, i + 2); i += 2; continue; }
    if (/[$<>]/.test(c) && texto[i + 1] === '(') { prof += 1; cur += texto.slice(i, i + 2); i += 2; continue; }
    if (prof && c === '(') prof += 1;
    if (prof && c === ')') prof -= 1;
    const redireccion = (c === '&' && (/[<>]/.test(texto[i - 1] || '') || texto[i + 1] === '>')) || (c === '|' && texto[i - 1] === '>');
    if (!prof && !redireccion && /[;&|\n]/.test(c)) {
      const doble = (c === '&' || c === '|') && texto[i + 1] === c;
      out.push({ texto: cur, sep: doble ? c + c : c });
      cur = '';
      i += doble ? 2 : 1;
      continue;
    }
    cur += c; i += 1;
  }
  out.push({ texto: cur, sep: '' });
  return out.map((t) => ({ texto: t.texto.trim(), sep: t.sep })).filter((t) => t.texto);
}

// Una redirección escrita como palabra (`2>&1`, `>`, `2>/dev/null`, `&>log`, `<<<`): `{ salida, destino }`, con el
// destino pegado o '' si va en la palabra siguiente; null si no lo es. `<(…)` y `>(…)` son sustituciones, no redirecciones.
function redireccion(w) {
  if (/^[<>]\(/.test(w)) return null;
  const m = /^(?:\d+|&)?(>>|>\||>&|>|<<<|<>|<&|<)([\s\S]*)$/.exec(w);
  return m ? { salida: m[1].includes('>'), destino: m[2] } : null;
}
// Las palabras sin sus redirecciones, y los archivos que el comando escribe por una (sin `/dev/…` ni otro descriptor).
function sinRedirecciones(ws) {
  const ps = [];
  const archivos = [];
  for (let i = 0; i < ws.length; i++) {
    const r = redireccion(ws[i]);
    if (!r) { ps.push(ws[i]); continue; }
    let destino = r.destino;
    if (destino === '') { i += 1; destino = ws[i] === undefined ? '' : ws[i]; }
    if (r.salida && destino && !/^&?\d+-?$|^-$|^\/dev\//.test(destino)) archivos.push(destino);
  }
  return { ps, archivos };
}

// Hasta dónde llega la sustitución que abre en `i` (`$(`, `<(` o `>(`): el índice después de su paréntesis de cierre.
function finDeSustitucion(texto, i) {
  let prof = 1;
  let j = i + 2;
  for (; j < texto.length && prof; j++) {
    if (texto[j] === '(') prof += 1;
    else if (texto[j] === ')') prof -= 1;
  }
  return j;
}

// Las palabras de un texto como las arma el shell: las comillas agrupan y se sacan, la barra escapa el carácter
// siguiente (entre comillas dobles, sólo `$`, la comilla invertida, la doble, la barra y el salto de línea: la ruta de
// Windows entre comillas conserva sus barras), y una sustitución (`$(…)`, las comillas invertidas) queda entera dentro de
// su palabra.
function palabrasDelShell(texto) {
  const out = [];
  let cur = null;
  for (let i = 0; i < texto.length;) {
    const c = texto[i];
    if (/\s/.test(c)) { if (cur !== null) { out.push(cur); cur = null; } i += 1; continue; }
    // `$'…'`: comillas simples con las secuencias de la barra
    if (c === '$' && texto[i + 1] === "'") { const j = finDeAnsi(texto, i); cur = (cur || '') + deAnsi(texto.slice(i + 2, j)); i = j + 1; continue; }
    if (/[$<>]/.test(c) && texto[i + 1] === '(') { const j = finDeSustitucion(texto, i); cur = (cur || '') + texto.slice(i, j); i = j; continue; }
    if (c === '`') {
      const fin = texto.indexOf('`', i + 1);
      const hasta = fin < 0 ? texto.length : fin + 1;
      cur = (cur || '') + texto.slice(i, hasta); i = hasta; continue;
    }
    if (c === "'") {
      const fin = texto.indexOf("'", i + 1);
      const hasta = fin < 0 ? texto.length : fin;
      cur = (cur || '') + texto.slice(i + 1, hasta); i = hasta + 1; continue;
    }
    if (c === '"') {
      let j = i + 1; let buf = '';
      while (j < texto.length && texto[j] !== '"') {
        if (texto[j] === '\\' && /[$`"\\\n]/.test(texto[j + 1] || '')) { buf += texto[j + 1]; j += 2; } else { buf += texto[j]; j += 1; }
      }
      cur = (cur || '') + buf; i = j + 1; continue;
    }
    if (c === '\\' && i + 1 < texto.length) { cur = (cur || '') + texto[i + 1]; i += 2; continue; }
    cur = (cur || '') + c; i += 1;
  }
  if (cur !== null) out.push(cur);
  return out;
}

// Lo que corre dentro de un texto sin ser su comando: las sustituciones `$(…)`, `<(…)`, `>(…)` y las comillas
// invertidas, fuera de comillas simples.
function sustituciones(texto) {
  const out = [];
  let enDobles = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (c === '\\') { i += 1; continue; }
    if (c === '$' && texto[i + 1] === "'" && !enDobles) { i = finDeAnsi(texto, i); continue; }
    if (c === "'" && !enDobles) { const j = texto.indexOf("'", i + 1); if (j < 0) break; i = j; continue; }
    if (c === '"') { enDobles = !enDobles; continue; }
    if (c === '`') {
      const j = texto.indexOf('`', i + 1);
      const fin = j < 0 ? texto.length : j;
      out.push(texto.slice(i + 1, fin)); i = fin; continue;
    }
    // una cuenta del shell (`$((…))`) no corre un comando
    if (c === '$' && texto[i + 1] === '(' && texto[i + 2] === '(') { i = finDeSustitucion(texto, i) - 1; continue; }
    if (/[$<>]/.test(c) && texto[i + 1] === '(') {
      const j = finDeSustitucion(texto, i);
      out.push(texto.slice(i + 2, j - 1)); i = j - 1;
    }
  }
  return out;
}

// El nombre de un programa como lo busca el sistema: sin carpeta, en minúsculas y sin la extensión de Windows (ni el `=`
// con que zsh lo cambia por su ruta).
const normal = (w) => String(w).replace(/^=/, '').replace(/^.*[\\/]/, '').toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
const conVariable = (w) => /[$`]/.test(w);
// el programa sale de una variable o de una sustitución: no se sabe qué corre (`$HOME/bin/x` sí: corre `x`)
const programaVariable = (w) => /\$\(|`/.test(w) || /\$/.test(String(w).replace(/^.*[\\/]/, ''));
// una ruta de Windows sin barras: el shell se las comió (`C:\Git\git.exe` sin comillas)
const rutaSinBarras = (w) => /^[A-Za-z]:[^\\/]/.test(w);
const ASIGNACION = /^[A-Za-z_]\w*=/;

// las palabras del shell que no son el comando: lo que sigue sí lo es
const RESERVADAS = new Set(['!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', '{', '}']);
// los programas que corren el comando que les sigue, con sus opciones que llevan valor aparte
const PREFIJOS = {
  env: ['-u', '--unset'], command: [], builtin: [], exec: ['-a'], time: ['-f', '-o', '--format', '--output'], nohup: [], noglob: [], nocorrect: [],
  sudo: ['-u', '-g', '-h', '-p', '-C', '-U', '-r', '-t', '--user', '--group', '--host', '--prompt'], doas: ['-u', '-C'],
  nice: ['-n', '--adjustment'], ionice: ['-c', '-n', '-p'], stdbuf: ['-i', '-o', '-e'], timeout: ['-s', '-k', '--signal', '--kill-after'],
  xargs: ['-I', '-n', '-L', '-d', '-E', '-a', '-P', '-s', '-R', '-S', '--max-args', '--delimiter', '--arg-file', '--max-procs', '--replace'],
  caffeinate: ['-t', '-w'], unbuffer: [], chronic: [], busybox: [],
};
// las opciones de un prefijo que cambian la carpeta o arman el comando de un texto: lo que sigue no se puede leer
const CAMBIAN_LA_CARPETA = { env: ['-C', '--chdir', '-S', '--split-string'], sudo: ['-D', '--chdir'] };
const SHELLS = /^(?:ba|z|da|k|mk|a|fi|tc|c)?sh$/;
// los programas que muestran o buscan texto: nombrar git en sus argumentos no lo corre
const INOFENSIVOS = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'cat', 'head', 'tail', 'less', 'more', 'man',
  'which', 'type', 'whatis', 'apropos', 'tldr', 'test', '[', 'true', 'false', 'wc', 'sort', 'uniq', 'jq', 'git']);
// las variables del ambiente que cambian el repo de git, o lo que corre
const GIT_REPO = ['GIT_DIR', 'GIT_WORK_TREE'];
// (la casa y la configuración global cambian los alias)
const GIT_OPACAS = ['GIT_COMMON_DIR', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_EXEC_PATH', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM', 'HOME', 'XDG_CONFIG_HOME'];

/** Las palabras sin los prefijos que corren lo que sigue: `{ ps, asign, opaco, noCorre, xargs }`. */
function sinPrefijos(ps) {
  const asign = [];
  let opaco = false;
  let xargs = false;
  for (let vueltas = 0; ps.length && vueltas < 30; vueltas++) {
    if (ASIGNACION.test(ps[0])) { asign.push(ps[0]); ps = ps.slice(1); continue; }
    if (RESERVADAS.has(ps[0])) { ps = ps.slice(1); continue; }
    const p = normal(ps[0]);
    // `command -v` busca el programa: no lo corre
    if (p === 'command' && /^-[a-zA-Z]*[vV]/.test(ps[1] || '')) return { ps: [], asign, opaco, noCorre: true, xargs };
    const conValor = PREFIJOS[p];
    if (!conValor) break;
    if (p === 'xargs') xargs = true;
    const cambia = CAMBIAN_LA_CARPETA[p] || [];
    let i = 1;
    while (i < ps.length) {
      const x = ps[i];
      if (p === 'env' && ASIGNACION.test(x)) { asign.push(x); i += 1; continue; }
      if (!x.startsWith('-')) break;
      if (x === '--') { i += 1; break; }
      if (cambia.some((o) => x === o || x.startsWith(`${o}=`) || (!o.startsWith('--') && x.startsWith(o)))) opaco = true;
      i += conValor.includes(x) ? 2 : 1;
    }
    // la duración de `timeout`
    if (p === 'timeout' && i < ps.length) i += 1;
    ps = ps.slice(i);
  }
  return { ps, asign, opaco, noCorre: false, xargs };
}

// las opciones largas de un shell que llevan valor aparte
const SHELL_CON_VALOR = new Set(['--rcfile', '--init-file']);
// El texto que corre un shell con `-c` (o `-lc`, `-ec`…): la primera palabra que no es opción. Null sin `-c`.
function scriptDelShell(ps) {
  let conC = false;
  for (let i = 1; i < ps.length; i++) {
    const x = ps[i];
    if (/^[-+][oO]$/.test(x) || SHELL_CON_VALOR.has(x)) { i += 1; continue; }
    if (/^-[a-zA-Z]+$/.test(x)) { if (x.includes('c')) conC = true; continue; }
    if (x.startsWith('--')) continue;
    return conC ? x : null;
  }
  return null;
}

// ¿Un shell sin `-c` lee su guion de la entrada (un tubo, `<<<`, un heredoc, `-s`)? Con un archivo de guion, no.
function leeDeLaEntrada(ps) {
  for (let i = 1; i < ps.length; i++) {
    const x = ps[i];
    if (/^\d*(<<?<?|>>?|&>)/.test(x)) { if (/^\d*(<<?<?|>>?|&>)$/.test(x)) i += 1; continue; }
    if (/^[-+][oO]$/.test(x) || SHELL_CON_VALOR.has(x)) { i += 1; continue; }
    if (/^-[a-zA-Z]+$/.test(x)) { if (x.includes('s')) return true; continue; }
    // `-` y `/dev/stdin` son la entrada
    if (x === '-' || x === '/dev/stdin') return true;
    if (x.startsWith('--')) continue;
    return false;
  }
  return true;
}

const casa = () => process.env.HOME || os.homedir();
// una ruta escrita, con la tilde de la casa resuelta; null si sale de una variable o de otra casa
function rutaEscrita(p) {
  if (conVariable(p)) return null;
  if (p === '~') return casa();
  if (p.startsWith('~/')) return path.join(casa(), p.slice(2));
  if (p.startsWith('~')) return null;
  return p;
}

const esCarpeta = (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };
// `cd`/`pushd`: la carpeta nueva reemplaza a la de partida si existe; si no existe, el `cd` falla y quedan las dos
// posibles. La que no se puede leer deja opaco lo que sigue
function moverCarpeta(ctx, ps) {
  const destino = ps.slice(1).find((x) => !/^-[LPe@]+$/.test(x));
  const r = destino === undefined ? casa() : destino === '-' || /^[+-]\d+$/.test(destino) ? null : rutaEscrita(destino);
  if (r === null) { ctx.cdOpaco = true; return; }
  ctx.dirs = [...new Set(ctx.dirs.flatMap((d) => { const x = path.resolve(d, r); return esCarpeta(x) ? [x] : [d, x]; }))];
}

// Una variable de git en el ambiente del comando que sigue: exportada (`export`, `declare -x`, `set -a`), o una que el
// ambiente ya trae. La asignación suelta de una que no está en el ambiente queda en el shell y no le llega a git.
function anotarVariable(ctx, asignacion, exportada) {
  const i = asignacion.indexOf('=');
  const nombre = asignacion.slice(0, i);
  if (!GIT_REPO.includes(nombre) && !GIT_OPACAS.includes(nombre)) return;
  const valor = asignacion.slice(i + 1);
  if (exportada || ctx.exportarTodo || nombre in ctx.vars || nombre in process.env) ctx.vars[nombre] = valor;
  else ctx.locales[nombre] = valor;
}
// `export NOMBRE`: la variable del shell pasa al ambiente
function exportar(ctx, nombre) {
  if (Object.prototype.hasOwnProperty.call(ctx.locales, nombre)) ctx.vars[nombre] = ctx.locales[nombre];
}

// los intérpretes que corren un programa recibido por la entrada (un heredoc)
const INTERPRETES = /^(python[\d.]*|pypy[\d.]*|node|nodejs|deno|bun|ruby|irb|perl|php|lua|tclsh|osascript|pwsh|powershell|rscript|swift|groovy|jshell|ts-node|tsx)$/;
// los nombres que el shell entiende sin buscarlos en el PATH
const DEL_SHELL = new Set(['cd', 'pushd', 'popd', 'dirs', 'echo', 'printf', 'print', 'read', 'set', 'unset', 'export', 'source', '.', 'type', 'test',
  '[', '[[', 'local', 'declare', 'typeset', 'readonly', 'return', 'exit', 'shift', 'trap', 'wait', 'kill', 'jobs', 'fg', 'bg', 'disown', 'pwd',
  'umask', 'ulimit', 'hash', 'rehash', 'history', 'fc', 'let', 'true', 'false', ':', 'getopts', 'break', 'continue', 'alias', 'unalias', 'setopt',
  'unsetopt', 'autoload', 'whence', 'where', 'which', 'emulate', 'zmodload', 'bindkey', 'compdef', 'eval', 'exec', 'command', 'builtin',
  'times', 'shopt', 'complete', 'compgen', 'enable', 'help', 'mapfile', 'readarray', 'caller', 'bind', 'functions', 'fi', 'done', 'esac',
  'case', 'for', 'select', 'function', 'coproc', 'vared', 'zstyle', 'zle', 'integer', 'float', 'repeat', 'zparseopts', 'zformat']);
// ¿Un nombre de programa que no se encuentra: ni del shell, ni en el PATH del hook ni en el que exporta la copia del
// shell de la sesión? Una ruta no se busca: se mira si existe.
const enElPath = new Map();
function estaEn(w, carpetas) {
  const clave = `${w}\0${carpetas.join(path.delimiter)}`;
  if (!enElPath.has(clave)) {
    const exts = process.platform === 'win32' ? ['', ...String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')] : [''];
    enElPath.set(clave, carpetas.some((d) => exts.some((e) => { try { fs.accessSync(path.join(d, w + e), fs.constants.X_OK); return true; } catch (_) { return false; } })));
  }
  return enElPath.get(clave);
}
const enElPathDelHook = (w) => /[\\/]/.test(w) || DEL_SHELL.has(w) || estaEn(w, String(process.env.PATH || '').split(path.delimiter).filter(Boolean));
function noSeEncuentra(w, home, dir) {
  if (/[\\/]/.test(w)) return !fs.existsSync(path.resolve(dir || '.', w.replace(/^~(?=[\\/])/, home || casa())));
  return !enElPathDelHook(w) && !estaEn(w, copiaDelShell(home).rutas);
}

// Las copias del shell que deja Claude Code (`~/.claude/shell-snapshots`): los alias, las funciones y el PATH que la
// sesión trae al correr cada comando. No se sabe cuál es la de esta sesión, así que se leen todas: un nombre que dos
// copias definen distinto queda en null (no se sabe qué corre). `ilegible`: una copia que existe y no se pudo leer.
const copias = new Map();
function copiaDelShell(home) {
  const dir = path.join(home || casa(), '.claude', 'shell-snapshots');
  if (copias.has(dir)) return copias.get(dir);
  const out = { alias: new Map(), funciones: new Map(), rutas: [], ilegible: false };
  copias.set(dir, out);
  let archivos;
  try { archivos = fs.readdirSync(dir).filter((f) => /^snapshot-.*\.sh$/.test(f)).map((f) => path.join(dir, f)); } catch (e) {
    if (e.code !== 'ENOENT') out.ilegible = true;
    return out;
  }
  const anotar = (mapa, nombre, valor) => { if (!mapa.has(nombre)) mapa.set(nombre, valor); else if (mapa.get(nombre) !== valor) mapa.set(nombre, null); };
  for (const archivo of archivos) {
    let txt;
    try { txt = fs.readFileSync(archivo, 'utf8'); } catch (_) { out.ilegible = true; continue; }
    const lineas = txt.split('\n');
    for (let i = 0; i < lineas.length; i++) {
      const a = /^alias (?:-- )?([^=\s]+)=(.*)$/.exec(lineas[i]);
      if (a) { anotar(out.alias, a[1], palabrasDelShell(a[2]).join(' ')); continue; }
      const p = /^export PATH=(.*)$/.exec(lineas[i]);
      if (p) { out.rutas.push(...palabrasDelShell(p[1]).join('').split(':')); continue; }
      // `nombre () {` y el cuerpo hasta la llave sola que la cierra
      const f = /^([\w.:+@%-]+) \(\) (\{)?\s*$/.exec(lineas[i]);
      if (!f) continue;
      let j = i + 1;
      if (!f[2] && (lineas[j] || '').trim() === '{') j += 1;
      const cuerpo = [];
      for (; j < lineas.length && lineas[j] !== '}'; j++) cuerpo.push(lineas[j]);
      anotar(out.funciones, f[1], cuerpo.join('\n'));
      i = j;
    }
  }
  out.rutas = [...new Set(out.rutas.filter((r) => path.isAbsolute(r)))];
  return out;
}
// una palabra entre comillas simples, para volver a armar un texto de shell
const citar = (w) => `'${String(w).replace(/'/g, `'\\''`)}'`;
const citarAsignacion = (a) => { const i = a.indexOf('='); return `${a.slice(0, i)}=${citar(a.slice(i + 1))}`; };
// el cuerpo de una función con sus argumentos en lugar de `$@`, `$*` y `$1`…`$9`
function conArgumentos(cuerpo, nombre, args) {
  const a = args.map(citar);
  return cuerpo.replace(/"\$[@*]"|\$[@*]/g, a.join(' ')).replace(/"\$(\d)"|\$(\d)/g, (_, x, y) => {
    const n = Number(x === undefined ? y : x);
    return n === 0 ? citar(nombre) : (a[n - 1] === undefined ? "''" : a[n - 1]);
  });
}

// el contexto del shell en una carpeta: las carpetas posibles, las variables de git del ambiente y las del shell
// `pila`: las carpetas que `pushd` dejó para que `popd` vuelva. `movidas`: los cambios de carpeta que el lector siguió
// dentro de otro texto (`bash -c`, `eval`, un alias): se comparte entre las copias, como `dudas`
const nuevoCtx = (dirs, dudas, home) => ({ dirs, cdOpaco: false, vars: {}, locales: {}, exportarTodo: false, dudas, home, expandidos: [], pila: [], movidas: [] });
// lo que hereda un subshell, una sustitución u otro shell: sus cambios no vuelven (las dudas, sí)
const copiar = (ctx) => ({ ...ctx, dirs: [...ctx.dirs], vars: { ...ctx.vars }, locales: { ...ctx.locales }, pila: (ctx.pila || []).map((d) => [...d]) });
function volver(ctx, previo) {
  for (const k of ['dirs', 'cdOpaco', 'vars', 'locales', 'exportarTodo', 'pila']) ctx[k] = previo[k];
}

/**
 * Cada comando de verdad del texto, en orden y con lo que el shell sabe al correrlo: `cuerpo(ps, cmd, ctx)`, con
 * `ctx.dirs` (las carpetas posibles), `ctx.cdOpaco` (una carpeta que no se puede leer), `ctx.vars` (las variables de git
 * del ambiente), `ctx.xargs` (el comando lo corre `xargs`, con palabras que llegan por la entrada) y `ctx.archivos` (los
 * que escribe por una redirección). Entra en las sustituciones (con lo que el comando hizo antes), en
 * `bash|sh|zsh… -c '…'`, en `eval` y en los alias y las funciones de la copia del shell, hasta cuatro niveles; lo que
 * cambia un subshell, una sustitución u otro shell no vuelve. Lo que no puede leer con certeza (un programa que sale de
 * una variable, un shell que lee de la entrada, una función o un alias definidos en el comando, más de cuatro niveles,
 * una ruta de Windows sin barras) lo suma a `ctx.dudas`, guarde o no.
 */
function porComando(command, cuerpo, depth = 0, ctx = nuevoCtx([process.cwd()], [])) {
  const dudar = () => { if (ctx.dudas) ctx.dudas.push(depth); };
  const limpio = limpiar(String(command || ''));
  if (limpio.duda) dudar();
  // los subshells abiertos: al cerrarse, el shell vuelve a lo de antes
  const subshells = [];
  for (const tramo of tramosDelShell(limpio.texto)) {
    const abre = (/^[\s(]*/.exec(tramo)[0].match(/\(/g) || []).length;
    for (let k = 0; k < abre; k++) subshells.push(copiar(ctx));
    const cierra = unTramo(tramo);
    for (let k = 0; k < cierra && subshells.length; k++) volver(ctx, subshells.pop());
  }

  // lee un tramo y devuelve cuántos subshells cierra
  function unTramo(tramo) {
    const subs = sustituciones(tramo);
    if (depth < 4) for (const s of subs) porComando(s, cuerpo, depth + 1, copiar(ctx));
    else if (subs.length) dudar();
    // sin los paréntesis y llaves de un grupo (la llave, sola: `{a,b}` es una palabra): los del comienzo, y los del
    // final que no cierran nada del tramo
    let crudo = tramo.replace(/^(?:[()\s]|[{}](?=\s|$))+/, '');
    const cuenta = (re) => (crudo.match(re) || []).length;
    let cierra = 0;
    while (/[)}]\s*$/.test(crudo) && (cuenta(/\)/g) > cuenta(/\(/g) || cuenta(/\}/g) > cuenta(/\{/g))) {
      if (/\)\s*$/.test(crudo)) cierra += 1;
      crudo = crudo.replace(/[)}]\s*$/, '');
    }
    // la definición de una función: lo que corre al llamarla no se lee
    if (/^(function\s+\S|[\w.:-]+\s*\(\s*\))/.test(crudo)) { dudar(); return cierra; }
    const { ps: palabras, archivos } = sinRedirecciones(palabrasDelShell(crudo));
    const { ps, asign, opaco, noCorre, xargs } = sinPrefijos(palabras);
    if (noCorre) return cierra;
    // sólo asignaciones: valen para lo que sigue. Un prefijo que arma el comando de su opción (`env --split-string=…`)
    // no deja palabras que leer
    if (!ps.length) { if (opaco) dudar(); for (const a of asign) anotarVariable(ctx, a, false); return cierra; }
    const cmd = normal(ps[0]);
    if (cmd === 'export' || ((cmd === 'declare' || cmd === 'typeset') && ps.slice(1).some((x) => /^-\w*x/.test(x)))) {
      for (const a of ps.slice(1)) { if (ASIGNACION.test(a)) anotarVariable(ctx, a, true); else if (/^\w+$/.test(a)) exportar(ctx, a); }
      return cierra;
    }
    if (['declare', 'typeset', 'local', 'readonly'].includes(cmd)) { for (const a of ps.slice(1)) if (ASIGNACION.test(a)) anotarVariable(ctx, a, false); return cierra; }
    if (cmd === 'set' && ps.slice(1).some((x) => /^-\w*a/.test(x) || x === 'allexport')) { ctx.exportarTodo = true; return cierra; }
    if (MUEVEN.has(cmd) && depth > 0 && ctx.movidas) ctx.movidas.push(depth);
    if (cmd === 'pushd') { ctx.pila = [...(ctx.pila || []), [...ctx.dirs]]; moverCarpeta(ctx, ps); return cierra; }
    if (cmd === 'cd') { moverCarpeta(ctx, ps); return cierra; }
    // `popd` vuelve a la carpeta que dejó su `pushd`; sin él, el lector no asegura la carpeta (carpetaSegura)
    if (cmd === 'popd') { if (ctx.pila && ctx.pila.length) { ctx.dirs = ctx.pila[ctx.pila.length - 1]; ctx.pila = ctx.pila.slice(0, -1); } return cierra; }
    if (cmd === 'alias') { dudar(); return cierra; }
    if (cmd === 'eval') { if (depth < 4) porComando(ps.slice(1).join(' '), cuerpo, depth + 1, ctx); else dudar(); return cierra; }
    // un alias o una función de la copia del shell: se lee lo que corre (un alias no se expande dentro de sí mismo). Las
    // copias se leen sólo si el nombre no es un programa del PATH o si el comando dice algo de guardar: `ls`, `npm test`
    // o `git status` no las tocan
    const consultar = !enElPathDelHook(ps[0]) || ps.some((w) => PARECE_GUARDAR.has(w));
    if (consultar && /^[\w.:+@%-]+$/.test(ps[0]) && !ctx.expandidos.includes(ps[0])) {
      const copia = copiaDelShell(ctx.home);
      const alias = copia.alias.get(ps[0]);
      const funcion = alias === undefined ? copia.funciones.get(ps[0]) : undefined;
      // dos copias lo definen distinto, o una copia no se leyó y el nombre no es un programa: no se sabe qué corre
      if (alias === null || funcion === null || (alias === undefined && funcion === undefined && copia.ilegible && noSeEncuentra(ps[0], ctx.home))) {
        dudar();
        return cierra;
      }
      if (alias !== undefined || funcion !== undefined) {
        if (depth >= 4) { dudar(); return cierra; }
        const resto = ps.slice(1).map(citar);
        const delante = asign.map(citarAsignacion).join(' ');
        const previos = ctx.expandidos;
        ctx.expandidos = [...previos, ps[0]];
        if (alias !== undefined) porComando(`${delante} ${alias} ${resto.join(' ')}`, cuerpo, depth + 1, ctx);
        else {
          // de una función se lee lo que guarda: lo demás que no se lee de su cuerpo no frena, salvo que el cuerpo nombre
          // un guardado o que la llamen con palabras de guardar (`g commit`, si `g` envuelve otro programa)
          const texto = `${delante} ${conArgumentos(funcion, ps[0], ps.slice(1))}`;
          const propio = { ...ctx, dudas: [] };
          porComando(texto, cuerpo, depth + 1, propio);
          volver(ctx, propio);
          if (propio.dudas.length && (nombraUnGuardado([texto]) || ps.slice(1).some((w) => PARECE_GUARDAR.has(w)))) dudar();
        }
        ctx.expandidos = previos;
        return cierra;
      }
    }
    if (SHELLS.test(cmd)) {
      const script = scriptDelShell(ps);
      // con `-c` y sin un texto que se ubique, no se sabe qué corre
      const conC = ps.slice(1).some((x) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(x));
      if (script !== null) { if (depth < 4) porComando(script, cuerpo, depth + 1, copiar(ctx)); else dudar(); } else if (conC || leeDeLaEntrada(ps)) dudar();
      return cierra;
    }
    // el programa que sale de una variable, de una ruta que el shell rompió, de un texto con espacios (`env -S`,
    // `sudo -s`) o de lo que el shell expande (`g?t`, `gi[t]`, `{git,commit}`)
    const nombre = String(ps[0]).replace(/^.*[\\/]/, '');
    if (programaVariable(ps[0]) || rutaSinBarras(ps[0]) || /\s/.test(nombre) || (!['[', '[['].includes(ps[0]) && /[*?[{]/.test(ps[0]))) dudar();
    const del = copiar(ctx);
    for (const a of asign) anotarVariable(del, a, true);
    cuerpo(ps, cmd, { dirs: ctx.dirs, cdOpaco: ctx.cdOpaco || opaco, vars: del.vars, xargs, archivos, dudar, home: ctx.home });
    return cierra;
  }
}

// los subcomandos propios de git: sin alias que buscar
const GIT_PROPIOS = new Set(['add', 'am', 'apply', 'archive', 'bisect', 'blame', 'branch', 'bundle', 'cat-file', 'check-ignore', 'checkout',
  'cherry', 'cherry-pick', 'clean', 'clone', 'commit', 'commit-graph', 'commit-tree', 'config', 'count-objects', 'describe', 'diff',
  'diff-files', 'diff-index', 'diff-tree', 'fetch', 'for-each-ref', 'format-patch', 'fsck', 'gc', 'grep', 'hash-object', 'help', 'init',
  'log', 'ls-files', 'ls-remote', 'ls-tree', 'merge', 'merge-base', 'mv', 'name-rev', 'notes', 'pull', 'push', 'range-diff', 'rebase',
  'reflog', 'remote', 'repack', 'replace', 'reset', 'restore', 'rev-list', 'rev-parse', 'revert', 'rm', 'shortlog', 'show', 'show-ref',
  'sparse-checkout', 'stash', 'status', 'submodule', 'switch', 'symbolic-ref', 'tag', 'update-index', 'update-ref', 'var', 'version',
  'worktree', 'write-tree', 'maintenance', 'lfs', 'show-branch', 'check-attr', 'whatchanged', 'difftool', 'mergetool', 'rerere', 'prune',
  'interpret-trailers', 'check-ref-format', 'check-mailmap', 'read-tree', 'verify-commit', 'verify-tag', 'verify-pack', 'credential',
  'annotate', 'column', 'bugreport', 'diagnose', 'hook', 'request-pull', 'mktag', 'mktree', 'merge-file', 'merge-tree', 'index-pack',
  'pack-objects', 'unpack-objects', 'prune-packed', 'pack-refs', 'patch-id', 'checkout-index', 'stripspace', 'get-tar-commit-id',
  'fmt-merge-msg', 'mailinfo', 'mailsplit', 'multi-pack-index', 'show-index', 'update-server-info', 'for-each-repo', 'replay', 'refs',
  'sparse-checkout', 'fast-export', 'fast-import', 'filter-branch', 'gui', 'citool', 'instaweb', 'send-email', 'imap-send']);
// los de la versión de git instalada (`git --list-cmds`), una vez por proceso; si no contesta, sólo la lista de arriba
let deLaVersion = null;
function esDeGit(sub) {
  if (GIT_PROPIOS.has(sub)) return true;
  if (deLaVersion === null) {
    const r = spawnSync('git', ['--list-cmds=builtins,main'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    deLaVersion = new Set(r.status === 0 ? String(r.stdout).split('\n').map((s) => s.trim()).filter(Boolean) : []);
  }
  return deLaVersion.has(sub);
}
// los subcomandos de git que cambian la rama o a dónde empuja el push que sigue
const CAMBIAN_LA_RAMA = new Set(['checkout', 'switch', 'branch', 'config', 'remote', 'worktree', 'symbolic-ref', 'update-ref']);
// las formas de esos subcomandos que sólo miran: `git branch --show-current`, `git config --get …`, `git remote -v`
function soloMira(sub, resto) {
  const args = resto.filter((a) => !a.startsWith('-'));
  if (sub === 'branch') return !resto.some((a) => /^(-m|-M|--move|-u|--set-upstream-to|--unset-upstream)(=|$)/.test(a));
  if (sub === 'symbolic-ref') return args.length <= 1 && !resto.some((a) => a === '-d' || a === '--delete');
  if (sub === 'config') {
    if (resto.some((a) => /^(-e|--edit|--unset|--unset-all|--add|--replace-all|--rename-section|--remove-section)$/.test(a))) return false;
    return resto.some((a) => /^(--get|--get-all|--get-regexp|-l|--list)$/.test(a)) || args.length <= 1;
  }
  if (sub === 'remote') return !args.length || ['show', 'get-url'].includes(args[0]);
  if (sub === 'worktree') return args[0] === 'list';
  return false;
}
// los que cambian archivos del árbol
const ESCRIBEN_EN_GIT = new Set(['apply', 'restore', 'checkout', 'switch', 'stash', 'merge', 'pull', 'cherry-pick', 'rebase', 'reset', 'am',
  'revert', 'mv', 'rm', 'clean', 'checkout-index', 'read-tree', 'submodule', 'sparse-checkout']);

/**
 * La lectura de un `git …`: el subcomando, su índice, los repos posibles, si algo no se puede leer, los alias de `-c` y si
 * un `-c` cambia a dónde empuja (`remote.*`, `push.*`, `branch.*`, `url.*`).
 */
function leerGit(ps, ctx) {
  const C = [];
  let workTree = null;
  let gitDir = null;
  let opaco = false;
  let cambiaDestino = false;
  const alias = {};
  let i = 1;
  for (; i < ps.length && ps[i].startsWith('-'); i++) {
    const p = ps[i];
    const igual = /^(--git-dir|--work-tree|--namespace|--config-env|--exec-path|--super-prefix|--attr-source)=(.*)$/.exec(p);
    let opcion = p;
    let valor;
    if (igual) { opcion = igual[1]; valor = igual[2]; } else if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source'].includes(p)) {
      i += 1; valor = ps[i] === undefined ? '' : ps[i];
    } else continue;
    if (conVariable(valor)) opaco = true;
    if (opcion === '-C') C.push(valor);
    else if (opcion === '--git-dir') gitDir = valor;
    else if (opcion === '--work-tree') workTree = valor;
    else if (opcion === '--config-env' || opcion === '--exec-path') opaco = true;
    else if (opcion === '-c') {
      const a = /^alias\.([^=]+)=(.*)$/i.exec(valor);
      if (a) alias[a[1].toLowerCase()] = a[2];
      if (/^(remote|push|branch|url)\./i.test(valor)) cambiaDestino = true;
    }
  }
  const vars = ctx.vars || {};
  if (GIT_OPACAS.some((v) => v in vars)) opaco = true;
  if (gitDir === null && 'GIT_DIR' in vars) gitDir = vars.GIT_DIR;
  if (workTree === null && 'GIT_WORK_TREE' in vars) workTree = vars.GIT_WORK_TREE;
  const escritas = [...C, gitDir, workTree].filter((x) => x !== null).map(rutaEscrita);
  if (escritas.includes(null)) opaco = true;
  // el repo lo dice la carpeta de git; sin ella, git lo busca desde la carpeta de partida, y el árbol de `--work-tree`
  // también cuenta
  const dirs = opaco ? [] : [...new Set(ctx.dirs.flatMap((base) => {
    let b = base;
    for (const c of C) b = path.resolve(b, rutaEscrita(c));
    if (gitDir !== null) {
      const g = path.resolve(b, rutaEscrita(gitDir));
      return [path.basename(g) === '.git' ? path.dirname(g) : g];
    }
    if (workTree !== null) return [b, path.resolve(b, rutaEscrita(workTree))];
    return [b];
  }))];
  return { sub: ps[i], i, dirs, opaco, alias, cambiaDestino };
}

// el alias de git `nombre` en el repo de `dir`, o null si no hay (git sale 1); cualquier otra salida tira
function aliasDelRepo(dir, nombre) {
  const r = spawnSync('git', ['-C', dir, 'config', '--get', `alias.${nombre}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  if (r.status === 0) return String(r.stdout).trim();
  if (r.status === 1) return null;
  throw new Error('no pude buscar el alias');
}

// Las palabras de cada `git commit` de verdad del comando (lo que sigue a `commit`), leídas como las arma el shell.
function commitsDelShell(command) {
  const out = [];
  porComando(command, (ps, cmd, ctx) => {
    if (cmd !== 'git') return;
    const g = leerGit(ps, { ...ctx, dirs: ctx.dirs });
    if (g.sub === 'commit') out.push(ps.slice(g.i + 1));
  });
  return out;
}

// las palabras que, después de un comando escondido en una variable, dicen que puede guardar
const PALABRAS_QUE_GUARDAN = new Set(['commit', 'push', 'pr', 'repos']);

// ¿Las palabras de un programa que no es git nombran un git o un pedido que guarda (`watch git commit`, `find -exec git
// push`, `node -e "…execSync('git push')"`)? Se parten también los textos entre comillas. Sin la lista de los
// conectores, cualquier `pr` puede ser un pedido.
function nombraUnGuardado(ps) {
  const ws = ps.flatMap((w) => w.split(/[\s'"`();|&=,{}[\]<>]+/)).filter(Boolean).map(normal);
  const plataforma = deLaPlataforma();
  if (!plataforma && ws.includes('pr')) return true;
  for (let i = 0; i < ws.length; i++) {
    const resto = ws.slice(i + 1);
    if (ws[i] === 'git' && resto.some((w) => w === 'commit' || w === 'push')) return true;
    if (plataforma && plataforma.pedidos.some((p) => p[0] === ws[i] && p.slice(1).every((w) => resto.includes(w)))) return true;
  }
  return false;
}

// Los comandos de la plataforma, de lo que declaran sus conectores (`rawCommands`): `{ programas, pedidos }`, los
// programas que nombran y, como listas de palabras, los pedidos que guardan (los que dicen `pr` y crean o mergean,
// también con el alias `new`). null si alguna integración no se puede leer.
function deLaPlataforma() {
  let dichos;
  try {
    dichos = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'platform', 'platform.js')).rawCommands();
  } catch (_) { return null; }
  const ws = dichos.map((c) => c.words.map(normal));
  return {
    programas: new Set(ws.map((w) => w[0])),
    pedidos: ws.filter((w) => w.length > 2 && w.includes('pr') && /^(create|new|merge)$/.test(w[w.length - 1])),
  };
}

// El pedido de la lista que dicen las palabras, con las opciones antes de cada palabra (y su valor, si lo traen:
// `-R acme/x pr merge`): `{ forma }`, `{ opaco: true }` si una variable ocupa el lugar de una palabra, o null.
function pedidoDe(ps, cmd, pedidos) {
  for (const p of pedidos) {
    if (p[0] !== cmd) continue;
    let j = 1;
    let ok = true;
    for (const w of p.slice(1)) {
      while (j < ps.length && ps[j] !== w && ps[j].startsWith('-')) {
        j++;
        if (j < ps.length && ps[j] !== w && !ps[j].startsWith('-')) j++;
      }
      if (j < ps.length && conVariable(ps[j])) return { opaco: true };
      if (j < ps.length && ps[j] === w) j++;
      else { ok = false; break; }
    }
    if (ok) return { forma: p.join(' ') };
  }
  return null;
}

// la rama actual dicha por otro comando (`$(git branch --show-current)`, el `git_current_branch` de oh-my-zsh)
const RAMA_ACTUAL = /^(?:\$\(|`)\s*(?:git_current_branch|git branch --show-current|git rev-parse --abbrev-ref HEAD|git symbolic-ref (?:-q )?--short(?: -q)? HEAD)\s*(?:\)|`)$/;
// el destino de cada refspec de un push: la rama, sin `+` ni `refs/heads/` ni `heads/`, que git completa igual
// (`@` y la rama actual son `HEAD`)
const ramaDe = (refspec) => {
  const destino = refspec.includes(':') ? refspec.slice(refspec.indexOf(':') + 1) : refspec;
  const rama = destino.replace(/^\+/, '').replace(/^refs\/heads\//, '').replace(/^heads\//, '') || null;
  return rama === '@' || RAMA_ACTUAL.test(rama || '') ? 'HEAD' : rama;
};
// lo que empuja un refspec (sin `+`): la izquierda de `:`, o el refspec entero si no tiene; un borrado no empuja nada
const origenDe = (refspec) => {
  const o = refspec.includes(':') ? refspec.slice(0, refspec.indexOf(':')) : refspec;
  if (!o) return null;
  return o === '@' || RAMA_ACTUAL.test(o) ? 'HEAD' : o;
};
// una opción larga escrita entera o acortada sin ambigüedad (git pide al menos dos letras después de `--`)
const acorta = (w, opcion) => w.startsWith('--') && !w.includes('=') && w.length >= 4 && opcion.startsWith(w);
const VALOR_SUBMODULOS = /^(check|on-demand|only|no)$/;

const OPACO = 'un comando que no se puede leer';

/**
 * Los comandos que guardan: `[{ tipo: 'commit'|'push'|'pr'|'opaco', forma, dir, remoto, rama, opaco, incierto, borrado,
 * escritos }]`. `borrado`: el push borra la rama (`:rama`, `--delete`, `-d`). `forma` es la forma (`git push`), sin el texto del comando. `remoto` y `rama` del push, si se escribieron
 * (sin ellos los completa `destinoDelPush`); un push con varias ramas da uno por rama, y `--all`/`--mirror` uno que no es
 * la rama del ok. `incierto`: el comando cambia antes a dónde empuja (la rama, la configuración, la refspec `:`, lo que
 * agrega `xargs`). `escritos`: los archivos o carpetas que el comando cambia antes de guardar.
 */
function comandosQueGuardan(command, cwd, home) {
  return leerComando(command, cwd, 0, [], home).cs;
}

// las palabras de un programa que no se encuentra que dicen que puede guardar
const PARECE_GUARDAR = new Set(['commit', 'push', 'pr', 'merge', 'repos']);
// los programas que cambian archivos: con `-i` (sed, perl), con su salida escrita (curl), o siempre
const ESCRIBEN = new Set(['tee', 'touch', 'cp', 'mv', 'rm', 'ln', 'install', 'truncate', 'chmod', 'rsync']);
const ESCRIBEN_EN_LA_CARPETA = new Set(['patch', 'wget', 'unzip', 'tar']);
// un archivo nombrado que existe, o cuya carpeta existe (el que se crea): `s/a/b/` de un sed no lo es
function rutasEscritas(args, dirs) {
  const out = [];
  for (const a of args) {
    if (!a || a.startsWith('-') || conVariable(a)) continue;
    const r = rutaEscrita(a);
    if (r === null) continue;
    for (const d of dirs) { const p = path.resolve(d, r); if (fs.existsSync(p) || esCarpeta(path.dirname(p))) out.push(p); }
  }
  return out;
}

// los comandos que mueven la carpeta del shell
const MUEVEN = new Set(['cd', 'pushd', 'popd']);
const MUEVE_ADENTRO = /(\$\(|`|<\(|>\(|\(|\{)\s*(cd|pushd|popd)(\s|$|\))/;
/**
 * ¿El lector asegura la carpeta donde corre cada guardado? Sólo si cada `cd`, `pushd` o `popd` está en la cadena inicial
 * del comando, unida por `&&` o `;` y no seguida de `|` o `&`, y cada `popd` tiene su `pushd`. Un `cd` después de otro
 * comando es condicional (`false && cd F`), y uno dentro de un `if`, un bucle, un grupo o una sustitución puede no
 * ocurrir: el lector no intenta saber si ocurre, y quien mide mide también la carpeta de la sesión.
 */
function carpetaSegura(command) {
  const tramos = tramosConSeparador(limpiar(String(command || '')).texto);
  let enCadena = true;
  let pushds = 0;
  for (let i = 0; i < tramos.length; i++) {
    const t = tramos[i];
    const ws = palabrasDelShell(t.texto);
    const mueve = ws.some((w) => MUEVEN.has(w)) || MUEVE_ADENTRO.test(t.texto);
    const unido = i === 0 || ['&&', ';', '\n'].includes(tramos[i - 1].sep);
    // un `cd` con opciones (`--`, `-P`, `-q`) el lector puede leerlo mal: no asegura la carpeta
    const conOpciones = ws.slice(1).some((w) => w.startsWith('-'));
    if (enCadena && MUEVEN.has(ws[0]) && unido && !conOpciones && !['|', '&', '||'].includes(t.sep) && ws.filter((w) => MUEVEN.has(w)).length === 1 && !MUEVE_ADENTRO.test(t.texto)) {
      if (ws[0] === 'pushd') pushds += 1;
      if (ws[0] === 'popd') { if (!pushds) return false; pushds -= 1; }
      continue;
    }
    enCadena = false;
    if (mueve) return false;
  }
  return true;
}

/**
 * `{ cs, dudas, segura }`: los comandos que guardan (`comandosQueGuardan`) y si algo del comando no se pudo leer con certeza,
 * guarde o no (un alias de git encadenado o que no es de git, un programa que no se encuentra y dice guardar, además de
 * lo que anota `porComando`).
 */
function leerComando(command, cwd, depth = 0, dudas = [], home) {
  const out = [];
  const opaco = (dir) => out.push({ tipo: 'opaco', forma: OPACO, dir, opaco: true });
  // lo que el comando hizo antes, en orden: los archivos que cambió y si cambió la rama
  const escritos = [];
  let cambioLaRama = false;
  const guardar = (c) => out.push({ ...c, escritos: [...escritos] });
  const ctx0 = nuevoCtx([cwd], dudas, home);
  porComando(command, (ps, cmd, ctx) => {
    leer(ps, cmd, ctx);
    escritos.push(...rutasEscritas(ctx.archivos, ctx.dirs));
  }, 0, ctx0);
  // un `cd` que el lector siguió dentro de otro texto no está en la cadena inicial: no asegura la carpeta
  return { cs: out, dudas, segura: depth > 0 || (carpetaSegura(command) && !ctx0.movidas.length) };

  function leer(ps, cmd, ctx) {
    // el comando desde una variable: no se sabe qué corre
    if (programaVariable(ps[0])) {
      if (ps.slice(1).some((p) => PALABRAS_QUE_GUARDAN.has(p))) opaco(ctx.dirs[0]);
      return;
    }
    // la forma con guion (`git-commit`, `…/git-core/git-push`) es el mismo subcomando
    const conGuion = /^git-(.+)$/.exec(cmd);
    if (conGuion && esDeGit(conGuion[1])) { ps = ['git', conGuion[1], ...ps.slice(1)]; cmd = 'git'; }
    if (cmd === 'git') return leerUnGit(ps, ctx);
    // los programas de la plataforma: guarda el pedido que se crea o se mergea; sin la lista de los conectores, uno que
    // dice `pr` no se lee
    const plataforma = deLaPlataforma();
    if (!plataforma && !INOFENSIVOS.has(cmd) && ps.slice(1).includes('pr')) { ctx.dudar(); return; }
    if (plataforma && plataforma.programas.has(cmd)) {
      const p = pedidoDe(ps, cmd, plataforma.pedidos);
      if (p && p.opaco) opaco(ctx.dirs[0]);
      else if (p) guardar({ tipo: 'pr', forma: p.forma, dir: ctx.dirs[0] });
      return;
    }
    // un programa que corre git por su cuenta
    if (!INOFENSIVOS.has(cmd) && nombraUnGuardado(ps.slice(1))) { opaco(ctx.dirs[0]); return; }
    // un programa que no se encuentra (ni del shell, ni en el PATH, ni alias o función de la sesión) y dice guardar
    if (noSeEncuentra(ps[0], ctx.home, ctx.dirs[0]) && ps.slice(1).some((w) => PARECE_GUARDAR.has(w))) { ctx.dudar(); return; }
    // los que cambian archivos antes de un commit o un push
    const args = ps.slice(1);
    if (ESCRIBEN.has(cmd) || (cmd === 'sed' && args.some((a) => /^(-i|--in-place)/.test(a))) || (cmd === 'perl' && args.some((a) => /^-\w*i/.test(a)))) {
      escritos.push(...rutasEscritas(args, ctx.dirs));
    } else if (cmd === 'curl') {
      for (let k = 0; k < args.length; k++) if (/^(-o|--output)$/.test(args[k])) escritos.push(...rutasEscritas([args[k + 1]], ctx.dirs));
    } else if (cmd === 'dd') {
      escritos.push(...rutasEscritas(args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3)), ctx.dirs));
    } else if (ESCRIBEN_EN_LA_CARPETA.has(cmd)) escritos.push(...ctx.dirs);
  }

  function leerUnGit(ps, ctx) {
    const g = leerGit(ps, ctx);
    let sub = g.sub;
    let resto = ps.slice(g.i + 1);
    // las palabras que `xargs` agrega por la entrada pueden ser el subcomando
    if (sub === undefined) { if (ctx.xargs) ctx.dudar(); return; }
    if (conVariable(sub)) { opaco(ctx.dirs[0]); return; }
    const dudoso = g.opaco || ctx.cdOpaco;
    // un subcomando que no es de git: un alias (hasta cuatro, encadenados), o algo que no se lee (la corrección
    // automática de git, otro programa `git-<nombre>`)
    for (let vuelta = 0; !esDeGit(sub); vuelta++) {
      if (dudoso) { opaco(ctx.dirs[0]); return; }
      if (vuelta === 4) { ctx.dudar(); return; }
      const clave = sub.toLowerCase();
      let exp;
      try { exp = Object.prototype.hasOwnProperty.call(g.alias, clave) ? g.alias[clave] : aliasDelRepo(g.dirs[0], sub); } catch (_) { opaco(ctx.dirs[0]); return; }
      if (exp === null) { ctx.dudar(); return; }
      if (exp.startsWith('!')) {
        if (depth < 4) for (const d of g.dirs) out.push(...leerComando(`${exp.slice(1)} ${resto.join(' ')}`, d, depth + 1, dudas, ctx.home).cs);
        else ctx.dudar();
        return;
      }
      const e = palabrasDelShell(exp);
      if (!e.length) return;
      sub = e[0];
      resto = [...e.slice(1), ...resto];
      if (conVariable(sub)) { opaco(ctx.dirs[0]); return; }
    }
    if (ESCRIBEN_EN_GIT.has(sub)) escritos.push(...g.dirs);
    if (CAMBIAN_LA_RAMA.has(sub) && !soloMira(sub, resto)) cambioLaRama = true;
    if (sub !== 'commit' && sub !== 'push') return;
    if (dudoso) { opaco(ctx.dirs[0]); return; }
    for (const dir of g.dirs) {
      if (sub === 'commit') { guardar({ tipo: 'commit', forma: 'git commit', dir }); continue; }
      // `-o`/`--push-option` y `--repo` llevan valor aparte: su valor no es el remoto. `--recurse-submodules` también,
      // cuando lo que sigue es uno de sus valores
      const conValor = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
      const limpios = [];
      let todas = false;
      let borraTodo = false;
      for (let k = 0; k < resto.length; k++) {
        const w = resto[k];
        if (conValor.has(w) || (w === '--recurse-submodules' && VALOR_SUBMODULOS.test(resto[k + 1] || ''))) { k += 1; continue; }
        // git acepta una opción larga acortada mientras no sea ambigua (`--al`, `--del`), y las cortas juntas
        // (`-fd`): un borrado o «todas las ramas» escritos así son lo mismo
        if (['--all', '--mirror', '--branches'].some((o) => acorta(w, o))) todas = true;
        if (acorta(w, '--delete') || /^-[A-Za-z]*d[A-Za-z]*$/.test(w)) borraTodo = true;
        if (!w.startsWith('-')) limpios.push(w);
      }
      const [remoto, ...refspecs] = limpios;
      // un patrón (`refs/heads/*:refs/heads/*`, `*:*`, `ma*`): git lo abre en todas las ramas que coinciden, main incluida
      if (refspecs.some((r) => r.includes('*'))) todas = true;
      // sin una rama escrita, o con `HEAD`, el destino sale del estado de antes del comando: si el comando cambió la
      // rama, ya no es ése
      const sinRamaEscrita = !refspecs.length || refspecs.some((r) => ramaDe(r) === 'HEAD');
      // una rama que sale de otro comando o de una variable que no se conoce: no se sabe cuál es
      const ramaArmada = refspecs.some((r) => /[$`]/.test(ramaDe(r) || ''));
      const incierto = g.cambiaDestino || !!ctx.xargs || refspecs.includes(':') || ramaArmada || (cambioLaRama && sinRamaEscrita);
      // un borrado (`:rama`, `+:rama`, `--delete`, `-d`) no es un empuje común a esa rama: cambia la rama del equipo.
      // `origen`: lo que se empuja (la rama o el commit de la izquierda del refspec; sin refspec, la rama actual)
      const push = (rama, borra, origen) => guardar({ tipo: 'push', forma: 'git push', dir, remoto: remoto || null, rama,
        origen: borra ? null : origen, ...(incierto ? { incierto: true } : {}), ...(borra ? { borrado: true } : {}) });
      if (todas) push(TODAS_LAS_RAMAS, borraTodo, null);
      else if (!refspecs.length) push(null, borraTodo, 'HEAD');
      else {
        for (const r of refspecs) {
          const sinMas = r.replace(/^\+/, '');
          push(r === ':' ? null : ramaDe(r), borraTodo || (sinMas.startsWith(':') && sinMas !== ':'), origenDe(sinMas));
        }
      }
    }
  }
}

// los repos de la corrida. Una ruta de la corrida (el repo o la story) que no está en ningún repo de git no tiene nada
// que guardar: sale de la cuenta, y sin ninguna de las dos la corrida no guarda en ningún repo
function reposDe(marker) {
  const s = SO();
  const enGit = (p) => p && s.raizDe(p) !== null;
  const m = { ...marker, repoPath: enGit(marker.repoPath) ? marker.repoPath : undefined, storyPath: enGit(marker.storyPath) ? marker.storyPath : undefined };
  if (!m.repoPath && !m.storyPath) return [];
  const hermanos = m.repoPath ? require('./companion-repos.js').companionRoots(path.resolve(m.repoPath), m.storyPath || undefined) : [];
  return s.reposDeLaCorrida({ marker: m, hermanos });
}

// ── la decisión ─────────────────────────────────────────────────────────────────────────────────────────────────────

const COMO_SE_AUTORIZA = 'Antes de guardar, el arnés le pregunta a la persona en la ventana de permiso; con el sí, guarda.';
// lo que no se lee con certeza, durante una corrida y antes de «Preparar el pull request»: no se sabe qué guardaría ni a dónde, y se
// pregunta igual
function preguntaNoLeo(story) {
  return `¿GUARDO? no pude leer este comando; si guarda, es de la corrida de ${story}. ${COMO_SE_AUTORIZA}`;
}

// ── a dónde va un empuje ────────────────────────────────────────────────────────────────────────────────────────────

// Las ramas que comparte el equipo: lo que se empuja ahí sale hacia el equipo igual que un pedido, aunque no haya
// pedido (hay productos que commitean en `dev` y lo empujan). Las mismas que cuida GIT-C1 en el freno de la sesión
// (scripts/hooks/safety-guard-pre.sh). Otra rama es de trabajo.
const RAMAS_COMPARTIDAS = Object.freeze(['main', 'master', 'dev']);
const esCompartida = (rama) => RAMAS_COMPARTIDAS.includes(rama) || /^release\//.test(rama);
const TODAS_LAS_RAMAS = 'todas las ramas (--all o --mirror)';
function gitEn(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  return r.status === 0 ? String(r.stdout || '').trim() : null;
}
// Una clave de la configuración de git: su valor, null si no está (salida 1) o undefined si git no pudo decirlo.
function configDe(dir, args) {
  const r = spawnSync('git', ['-C', dir, 'config', ...args], { encoding: 'utf8' });
  if (r.status === 0) return String(r.stdout || '').trim();
  return r.status === 1 ? null : undefined;
}
/**
 * La rama de destino de un push: `{ rama, compartida, pista }`. La escrita en el comando; `HEAD` (`HEAD`, `@` o la rama
 * actual dicha por otro comando) es la rama actual de antes del comando; sin destino escrito, la rama de empuje de la
 * actual (`@{push}`), que puede no ser la actual (`push.default upstream` lleva `dev` a `main`). Lo que no se lee con
 * certeza (un borrado, todas las ramas, un destino `incierto`, HEAD suelto o un `@{push}` que no se resuelve) se juzga
 * compartido: lo que no se leyó no sale sin la foto. `pista`: el destino no se leyó y escribirlo lo resuelve.
 */
function destinoDelEmpuje(c) {
  const compartida = (pista) => ({ rama: null, compartida: true, pista });
  if (c.borrado || c.rama === TODAS_LAS_RAMAS) return compartida(false);
  if (c.incierto) return compartida(true);
  let rama = c.rama;
  if (rama === 'HEAD' || rama === null) {
    const actual = c.dir ? gitEn(c.dir, ['symbolic-ref', '--short', '-q', 'HEAD']) : null;
    if (!actual) return compartida(true);
    if (rama === 'HEAD') rama = actual;
    else {
      // sin destino escrito, la configuración del repo puede llevar el empuje a varias ramas (main incluida), y `@{push}`
      // nombra una sola: `push.default matching`, un `remote.<r>.push` o un `remote.<r>.mirror`. Una configuración que no
      // se pudo leer puede ser cualquiera de esas
      const porDefecto = configDe(c.dir, ['--get', 'push.default']);
      const remotos = configDe(c.dir, ['--get-regexp', '^remote\\..*\\.(push|mirror)$']);
      if (porDefecto === undefined || remotos === undefined || porDefecto === 'matching') return compartida(true);
      if (remotos && remotos.split('\n').some((l) => /\.push\s/.test(l) || /\.mirror\s+true$/i.test(l.trim()))) return compartida(true);
      const empuje = gitEn(c.dir, ['rev-parse', '--abbrev-ref', '@{push}']);
      const remoto = gitEn(c.dir, ['for-each-ref', '--format=%(push:remotename)', `refs/heads/${actual}`]);
      if (!empuje || !remoto || !empuje.startsWith(`${remoto}/`)) return compartida(true);
      rama = empuje.slice(remoto.length + 1);
    }
  }
  return { rama, compartida: esCompartida(rama), pista: false };
}

// ── el pedido preparado ─────────────────────────────────────────────────────────────────────────────────────────────

// El paso «Preparar el pull request»: al cerrarlo, `marker.js` toma la foto del árbol de cada repo de la corrida
// (`prepareCommitHuellas`) después de las verificaciones del cierre. Lo que sale hacia el equipo tiene que ser lo de esa
// foto: así las verificaciones valen para lo que sale, sin repetirlas acá.
const PASO_PREPARAR = 'prepare-commit';
const cerrarPaso11 = () => `node ${require('./story-gate.js').MARKER_JS} complete-step prepare-commit`;
const textoSinPreparar = () => `🔒 el pull request sale después de preparar: cerrá «Preparar el pull request» (${cerrarPaso11()}).`;
const textoCambio = (repo) => `🔒 el código cambió después de preparar el pull request (${repo}): volvé a correr los revisores de lo que cambió y ${cerrarPaso11()}.`;
const textoNoComprobado = (motivo) => `🔒 no pude comprobar que el código es el que se preparó (${motivo}): repetí «Preparar el pull request».`;
const textoFueraDeLaFoto = (repo) => `🔒 ${repo} cambió después de preparar y no está en la foto: repetí «Preparar el pull request».`;
const TEXTO_MARCADOR = '🔒 no pude leer el marcador de la corrida: no sé si el pull request está preparado.';
const PISTA_DESTINO = ' Si el empuje va a tu rama de trabajo, escribí el destino: `git push -u origin <rama>`.';
const textoEscribe = (que) => `🔒 este comando cambia el código antes de que salga (${que}): corré el cambio aparte y, si cambió el código, volvé a preparar el pull request.`;
// el paso cerrado, por su nombre (también en un marcador sin el número de esquema) o, en el esquema viejo, por su
// número de entonces (el 8)
const pasoPreparado = (m) => (Array.isArray(m.stepsCompleted) && m.stepsCompleted.map(String).includes(PASO_PREPARAR))
  || require('./steps.js').isDone(m, PASO_PREPARAR);

/**
 * ¿Lo que sale es lo que se preparó? `{ ok, repos }` o `{ texto }`. «Preparar el pull request» cerrado, su foto presente y medible, cada
 * repo de la foto en su rama y con su árbol (sin commitear, o commiteado igual: la misma comparación que `vigente` de
 * save-ok.js), y ningún repo de la corrida con cambios fuera de la foto. Lo que no se mide no pasa.
 * `salientes`: lo que manda cada comando (`{ dir, origen }`): el commit de `origen` tiene que ser el de la foto (lo de
 * antes de preparar, sin commitear todavía) o tener su mismo árbol (lo preparado, commiteado). Otra rama, o un commit
 * que el disco ya no muestra, no es lo preparado aunque el disco lo sea.
 */
function preparado(m, salientes = []) {
  if (!pasoPreparado(m)) return { texto: textoSinPreparar() };
  const fotos = m.prepareCommitHuellas;
  // una foto vacía es la de una toma que falló al cerrar el paso: falta, no «no hay nada»
  if (!Array.isArray(fotos) || !fotos.length) return { texto: textoNoComprobado('falta la foto de «Preparar el pull request»') };
  const so = SO();
  for (const f of fotos) {
    if (!f || !f.repo || !f.arbol) return { texto: textoNoComprobado(`${(f && f.repo) || 'un repo'}: la foto no lo midió${f && f.error ? `, ${f.error}` : ''}`) };
    const ahora = so.huella(f.repo);
    if (ahora.error) return { texto: textoNoComprobado(`${f.repo}: ${ahora.error}`) };
    if (ahora.rama !== f.rama || ahora.arbol !== f.arbol) return { texto: textoCambio(f.repo) };
  }
  let repos;
  try { repos = reposDe(m); } catch (e) { return { texto: textoNoComprobado(`los repos de la corrida: ${e.message}`) }; }
  const enLaFoto = new Set(fotos.map((f) => f.repo));
  for (const r of repos) if (!enLaFoto.has(r) && so.tieneCambios(r)) return { texto: textoFueraDeLaFoto(r) };
  for (const s of salientes) {
    if (!s || !s.origen) continue;
    let raiz = null;
    try { raiz = s.dir ? so.raizDe(s.dir) : null; } catch (_) { raiz = null; }
    // un pull request sale del repo donde se abre; sin ubicarlo, de cualquiera de la foto
    const deLaFoto = fotos.filter((f) => !raiz || f.repo === raiz);
    for (const f of deLaFoto.length ? deLaFoto : fotos) {
      // una foto sin el campo `cabeza` es de antes de este control: se mide sólo el disco, como cuando se tomó. Con el
      // campo en null (la rama no tenía commits), lo que se empuja se compara por el árbol
      if (!Object.prototype.hasOwnProperty.call(f, 'cabeza')) continue;
      const c = so.arbolDelCommit(f.repo, s.origen);
      // lo que no existe en el repo no sale (git rechaza el empuje); lo que no se pudo medir, no pasa. El texto no
      // repite lo escrito en el comando
      if (c.falta) continue;
      if (c.error) return { texto: textoNoComprobado(`${f.repo}: no pude medir lo que se empuja`) };
      if (!(f.cabeza && c.commit === f.cabeza) && c.arbol !== f.arbol) return { texto: textoCambio(f.repo) };
    }
  }
  return { ok: true, repos: fotos.map((f) => f.repo) };
}

// Lo que el mismo comando cambia antes de guardar (`escritos` del lector), sin el papeleo: un archivo de la historia, del
// sprint, de la evidencia o de la memoria no es código. Null si no cambia nada.
function escribeCodigo(c) {
  const so = SO();
  for (const p of (c && c.escritos) || []) {
    let raiz = null;
    try { raiz = so.raizDe(fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : path.dirname(p)); } catch (_) { raiz = null; }
    const rel = raiz ? path.relative(raiz, p).split(path.sep).join('/') : '';
    if (rel && !rel.startsWith('..') && so.esPapeleoDeLaHuella(rel, '100644')) continue;
    return rel || path.basename(p);
  }
  return null;
}

// Los hallazgos de la corrida (`findings.json` de su carpeta), o null si no se ubica o no se lee: la evidencia dice
// «no medido».
function findingsDe(m) {
  try {
    const story = m.storyPath ? path.resolve(m.storyPath) : undefined;
    const rd = require('./run-dir.js').resolveRunDir(path.resolve(m.repoPath || process.cwd()), String(m.storyId), false, story);
    return rd ? JSON.parse(fs.readFileSync(path.join(rd, 'findings.json'), 'utf8')) : null;
  } catch (_) { return null; }
}

const COMO_SALE_EL_PEDIDO = 'Antes de que salga, el arnés le pregunta a la persona en la ventana de permiso; con el sí, sale.';
/** La ventana del pedido: qué sale, de qué historia y con qué evidencia; nunca el comando. Hasta 1000 caracteres. */
function preguntaDelPedido({ forma, m, repos, noLeo = false }) {
  const nombres = (repos || []).map((r) => path.basename(r)).join(', ');
  const que = noLeo
    ? `no pude leer este comando; si abre un pull request o empuja a una rama compartida, es de la historia ${m.storyId}`
    : `«${forma}», de la historia ${m.storyId}${nombres ? ` (${nombres})` : ''}`;
  const t = `¿ABRO EL PULL REQUEST? ${que}. ${SO().evidenciaDelPedido({ marker: m, findings: findingsDe(m) })}. ${COMO_SALE_EL_PEDIDO}`;
  return t.length > 1000 ? `${t.slice(0, 999)}…` : t;
}

/**
 * Null (pasa), `{ aviso }` (pasa y lo dice en pantalla), `{ pregunta }` (el texto de la ventana de permiso) o `{ texto }`
 * (no guarda). Dentro de una corrida (el marcador de la sesión): el commit no pregunta y queda en el registro del freno;
 * el empuje de la rama de trabajo pasa antes de «Preparar el pull request», y después sólo con el código de su foto; el pedido y el empuje
 * a una rama compartida frenan sin «Preparar el pull request» o con el código cambiado, y si no, preguntan con la evidencia. Lo que no
 * se lee con certeza pregunta como siempre antes de «Preparar el pull request», y después se juzga como un pedido. Un marcador que existe
 * y no se lee deja pasar el commit con un aviso y frena lo que sale hacia el equipo. Sin corrida, decide el camino
 * rápido abierto (`decidirCarril`); sin ninguno de los dos, nada pregunta. Lo delicado lo cubre la firma de control.
 */
function decidir({ command, cwd, sid, home }) {
  const markerPath = require('./open-runs.js').markerPath(sid, home);
  let crudo = null;
  try { crudo = fs.readFileSync(markerPath, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return decidirCarril({ command, cwd, sid, home });
  }
  const { cs, dudas } = leerComando(command, cwd || process.cwd(), 0, [], home);
  if (!cs.length && !dudas.length) return null;
  const c0 = cs[0] || { forma: OPACO };
  let m = null;
  try { m = crudo === null ? null : JSON.parse(crudo); } catch (_) { m = null; }
  if (!m || typeof m !== 'object' || Array.isArray(m) || !m.storyId) {
    const haciaElEquipo = dudas.length || cs.some((c) => c.opaco || c.tipo === 'pr' || (c.tipo === 'push' && destinoDelEmpuje(c).compartida));
    if (haciaElEquipo) return { texto: TEXTO_MARCADOR };
    return { aviso: `el marcador de la corrida no se puede leer o no dice de qué historia es: «${c0.forma}» guarda sin preguntar; un pull request no sale hasta arreglarlo.` };
  }
  const pasoCerrado = pasoPreparado(m);
  // lo que manda cada comando que sale: el pull request, la rama actual; el empuje, su origen
  const salientes = cs.filter((c) => c.tipo === 'pr' || (c.tipo === 'push' && c.origen)).map((c) => ({ dir: c.dir, origen: c.tipo === 'pr' ? 'HEAD' : c.origen }));
  let prep = null;
  const prepDe = () => { prep = prep || preparado(m, salientes); return prep; };
  if (dudas.length || cs.some((c) => c.opaco)) {
    if (!pasoCerrado) return { pregunta: preguntaNoLeo(m.storyId) };
    const p = prepDe();
    return p.texto ? { texto: p.texto } : { pregunta: preguntaDelPedido({ m, repos: p.repos, noLeo: true }) };
  }
  let repos = null;
  try { repos = reposDe(m); } catch (_) { repos = null; }
  // sin poder ubicar el repo de un comando, o los de la corrida, se juzga como de la corrida; una carpeta que no es un
  // repo no guarda nada
  const deLaCorrida = (c) => {
    if (!repos) return true;
    try { const r = SO().raizDe(c.dir); return !!r && repos.includes(r); } catch (_) { return true; }
  };
  let haciaElEquipo = null;
  let pista = false;
  let commits = 0;
  // con el paso cerrado, la foto se compara con el árbol de antes del comando: un comando que cambia el código y en la
  // misma línea empuja o abre el pull request mandaría lo que nadie preparó
  if (pasoCerrado) {
    for (const c of cs) {
      if (c.tipo !== 'pr' && c.tipo !== 'push') continue;
      const escrito = escribeCodigo(c);
      if (escrito) return { texto: textoEscribe(escrito) };
    }
  }
  for (const c of cs) {
    // un pedido se juzga contra toda la corrida
    if (c.tipo === 'pr') { haciaElEquipo = haciaElEquipo || c; continue; }
    if (!deLaCorrida(c)) continue;
    if (c.tipo === 'commit') { commits += 1; continue; }
    if (c.tipo !== 'push') continue;
    const d = destinoDelEmpuje(c);
    if (d.compartida) { haciaElEquipo = haciaElEquipo || c; pista = pista || d.pista; continue; }
    // la rama de trabajo: antes de «Preparar el pull request» pasa; después, sólo con el código de la foto
    if (pasoCerrado) { const p = prepDe(); if (p.texto) return { texto: p.texto }; }
  }
  if (haciaElEquipo) {
    const p = prepDe();
    if (p.texto) return { texto: `${p.texto}${pista ? PISTA_DESTINO : ''}` };
    return { pregunta: preguntaDelPedido({ forma: haciaElEquipo.forma, m, repos: p.repos }) };
  }
  if (commits) {
    const dir = path.dirname(path.dirname(markerPath));
    require('./story-gate-io.js').appendLog(dir, 'gates.log', sid, { name: 'save-brake', status: 'ok', reason: `commit local, sin pregunta (historia ${m.storyId})` });
  }
  return null;
}

/**
 * El carril de un camino rápido de la sesión, si está abierto: declarado con `marker.js adhoc set`, con su firma y sin
 * vencer, lo mismo que pide el portón para dejar editar código. Sin carril, null.
 */
function carrilAbierto(sid, home) {
  const io = require('./story-gate-io.js');
  const dir = path.dirname(path.dirname(require('./open-runs.js').markerPath(sid, home)));
  const a = io.readAdhoc(dir, sid);
  if (!a) {
    // sin archivo no hay carril; un archivo que existe y no se lee como JSON es otra cosa, y se dice
    let crudo;
    try { crudo = fs.readFileSync(io.adhocPath(dir, sid), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    try { JSON.parse(crudo); } catch (e) { throw new Error(`no es JSON (${e.message})`); }
    return null;
  }
  return io.adhocFirmado(dir, sid, a) ? a : null;
}

/**
 * Sin corrida, con un camino rápido abierto: sus cuatro frenos (tope, pantalla, datos, riesgo) miran todo lo que guarda.
 * El pedido, el empuje a una rama compartida y lo que no se lee con certeza preguntan; el commit y el empuje de la rama
 * de trabajo no (con lo que la pregunta mostraba como `{ aviso }`). No hay «Preparar el pull request» ni foto: el riesgo del carril ya mide
 * lo que se guarda. Su repo es el de los archivos que el carril anotó; si todavía no anotó ninguno, cualquier repo. Sin
 * carril, nada pregunta, como siempre fuera de una corrida.
 */
function decidirCarril({ command, cwd, sid, home }) {
  let a = null;
  let ilegible = null;
  try { a = carrilAbierto(sid, home); } catch (e) { a = null; ilegible = e; }
  if (ilegible) {
    // un registro del carril que no se puede leer no es «no hay carril»: lo que sale hacia el equipo pregunta, el commit y
    // el empuje de la rama de trabajo pasan con un aviso, y todo se anota
    const { cs, dudas } = leerComando(command, cwd || process.cwd(), 0, [], home);
    if (!cs.length && !dudas.length) return null;
    try {
      const dir = path.dirname(path.dirname(require('./open-runs.js').markerPath(sid, home)));
      require('./story-gate-io.js').appendLog(dir, 'gates.log', sid, { name: 'save-brake', status: 'unknown', reason: `registro del camino rápido ilegible: ${ilegible.message}` });
    } catch (_) { /* el aviso de abajo igual sale */ }
    const haciaElEquipo = dudas.length || cs.some((c) => c.opaco || c.tipo === 'pr' || (c.tipo === 'push' && destinoDelEmpuje(c).compartida));
    if (!haciaElEquipo) return { aviso: `no pude leer el registro del camino rápido de esta sesión (${ilegible.message}): «${cs[0].forma}» guarda sin preguntar.` };
    return { pregunta: `¿GUARDO? no pude leer el registro del camino rápido de esta sesión (${ilegible.message}): no sé si le faltan los revisores. ${COMO_SE_AUTORIZA}` };
  }
  if (!a) return null;
  const donde = cwd || process.cwd();
  const { cs, dudas, segura } = leerComando(command, donde, 0, [], home);
  if (!cs.length && !dudas.length) return null;
  const base = require('./adhoc-base.js');
  const raiz = (p) => SO().raizDe(p);
  // los repos se eligen en un solo lugar: el tope, la pantalla y los datos leen `delCarril`; el riesgo, también `delComando`
  const { delCarril, delComando, anotados: repos, fallas: sinUbicar } = base.reposQueSeMiden({ adhoc: a, cs, dudas, cwd: donde, segura, raiz });
  if (sinUbicar.length) {
    const dir = path.dirname(path.dirname(require('./open-runs.js').markerPath(sid, home)));
    require('./story-gate-io.js').appendLog(dir, 'gates.log', sid, { name: 'save-brake', status: 'blocked', reason: `carril sin medir: ${sinUbicar[0]}` });
    return { texto: `🔒 GUARDAR: no pude medir este camino corto (${sinUbicar[0]}). Sin medir no guarda: arreglá eso y repetí el comando.` };
  }
  const conRaiz = cs.filter((c) => { try { return !!raiz(c.dir); } catch (_) { return false; } }).length;
  // el trabajo de otro repo no es de este carril: no le pide su tope, su maqueta ni sus datos
  const esDelCarril = !repos.length || dudas.length || conRaiz < cs.length || cs.some((c) => c.opaco || c.tipo === 'pr') || delComando.some((r) => repos.includes(r));
  // lo que git todavía no sigue puede subir en un solo comando que empuja después de hacer otra cosa, y este freno corre antes:
  // no hay un guardado siguiente que lo cuente. Sin empujar, el siguiente sí lo cuenta. No se busca el `git add` en el texto:
  // tiene sinónimos y atajos, y la palabra puede estar en un mensaje
  const subeLoSinSeguir = dudas.length > 0 || cs.some((c) => c.opaco) || (cs.some((c) => c.tipo === 'push' || c.tipo === 'pr') && !esSoloEmpujar(command, cs, home, donde));
  // una medida por vuelta, y los cuatro frenos la leen, en este orden: el tope, la pantalla (antes que el riesgo: la maqueta y
  // la captura pueden ser archivos del repo, y los revisores tienen que medir lo que se guarda con ellas), los datos y el riesgo
  const vuelta = (carril, registrar, alDia, medida) => {
    const m = medida || base.medirLoPropio(carril, { repos: [...new Set([...delCarril, ...delComando])] });
    const tope = esDelCarril ? frenoDelTope(carril, sid, home, delCarril, subeLoSinSeguir, registrar, m) : null;
    if (registrar && tope) return { freno: tope };
    const pantalla = esDelCarril ? frenoDePantalla(carril, sid, home, delCarril, { registrar, medida: m }) : null;
    if (registrar && pantalla && pantalla.texto) return { freno: pantalla };
    const datos = esDelCarril ? frenoDeDatos(carril, sid, home, delCarril, { sinSeguir: subeLoSinSeguir, registrar, medida: m }) : null;
    if (registrar && datos && datos.texto) return { freno: { texto: datos.texto } };
    const riesgo = frenoDelRiesgo(carril, sid, home, delComando, { registrar, medida: m, alDia });
    if (registrar && riesgo) return { freno: riesgo };
    return { m, frenaria: !!(tope || (pantalla && pantalla.texto) || (datos && datos.texto) || riesgo), pantalla, datos };
  };
  let v = vuelta(a, false, []);
  if (v.frenaria) {
    // antes de frenar, con `main` traído otra vez, una sola vez para los cuatro: lo que frena pudo venir de otro pedido, por
    // una rama que ya lo tenía. Se registra sólo lo que frena después
    const b = basesAlDia(a, sid, home);
    a = b.adhoc;
    v = vuelta(a, true, b.alDia);
  } else v = vuelta(a, true, [], v.m);
  if (v.freno) return v.freno;
  const { pantalla, datos } = v;
  const de = `del camino rápido «${String(a.reason).slice(0, 160)}»`;
  const como = [pantalla && pantalla.mostrar, datos && datos.mostrar, COMO_SE_AUTORIZA].filter(Boolean).join(' ');
  if (dudas.length || cs.some((c) => c.opaco)) return { pregunta: `¿GUARDO? no pude leer este comando; si guarda, es ${de}. ${como}` };
  // el pedido y el empuje a una rama compartida preguntan; el commit y el empuje de la rama de trabajo no, y lo que la
  // pregunta mostraba (la maqueta, el aviso de los datos) sale en pantalla
  let guarda = false;
  for (const c of cs) {
    if (c.tipo === 'pr') return { pregunta: `¿GUARDO? «${c.forma}», ${de}. ${como}` };
    let r = null;
    try { r = raiz(c.dir); } catch (_) { return { pregunta: `¿GUARDO? «${c.forma}», ${de}. ${como}` }; }
    if (!repos.length || (r && repos.includes(r))) {
      if (c.tipo === 'push' && destinoDelEmpuje(c).compartida) return { pregunta: `¿GUARDO? «${c.forma}»${r ? ` sobre ${r}` : ''}, ${de}. ${como}` };
      guarda = true;
    }
  }
  const mostrar = [pantalla && pantalla.mostrar, datos && datos.mostrar].filter(Boolean);
  return guarda && mostrar.length ? { aviso: mostrar.join(' ') } : null;
}

// ── el tope del camino corto ────────────────────────────────────────────────────────────────────────────────────────

// los subcomandos de git que sólo miran: no agregan nada a lo que se empuja
const GIT_QUE_MIRA = new Set(['status', 'fetch', 'log', 'diff', 'show', 'rev-parse']);
// los programas que sólo muestran texto: no corren otro programa ni escriben un archivo con sus opciones. Más corta que
// INOFENSIVOS a propósito: `rg --pre`, `sort -o` o `uniq A B` corren o escriben, y con ellos lo sin seguir sumaría
const SOLO_MUESTRAN = new Set(['echo', 'printf', 'cat', 'head', 'tail', 'wc', 'true', 'false', 'test', '[', 'grep']);
/**
 * ¿El comando sólo empuja o abre el pedido? Se recorre lo que el lector resolvió (las variables y los prefijos delante,
 * la ruta del programa, los alias y las funciones de la copia del shell, los grupos): cada comando es un guardado que
 * empuja o abre el pedido, un `git` que sólo mira, o un programa que sólo muestra texto sin escribir por una redirección.
 * Un shell con `-c`, un `eval`, otro paso o lo que no se lee pueden agregar archivos: no es sólo empujar. `git push | tee x`
 * o `git push | sort` frenan: no son de los que sólo muestran.
 */
function esSoloEmpujar(command, guardados, home, cwd = process.cwd()) {
  if (!guardados.length || !guardados.every((c) => c.tipo === 'push' || c.tipo === 'pr')) return false;
  const limpio = limpiar(String(command || ''));
  if (limpio.duda) return false;
  for (const t of tramosDelShell(limpio.texto)) {
    const { ps } = sinPrefijos(sinRedirecciones(palabrasDelShell(t.replace(/^(?:[()\s]|[{}](?=\s|$))+/, ''))).ps);
    const cmd = ps.length ? normal(ps[0]) : '';
    if (cmd === 'eval' || SHELLS.test(cmd)) return false;
  }
  const dudas = [];
  let solo = true;
  const plataforma = deLaPlataforma();
  porComando(limpio.texto, (ps, cmd, ctx) => {
    if (!solo) return;
    if (cmd === 'git') {
      const sub = leerGit(ps, ctx).sub;
      if (sub !== 'push' && !GIT_QUE_MIRA.has(sub)) solo = false;
      return;
    }
    if (plataforma && plataforma.programas.has(cmd)) {
      const p = pedidoDe(ps, cmd, plataforma.pedidos);
      if (!p || p.opaco) solo = false;
      return;
    }
    if (!SOLO_MUESTRAN.has(cmd) || (ctx.archivos && ctx.archivos.length)) solo = false;
  }, 0, nuevoCtx([cwd], dudas, home));
  return solo && !dudas.length;
}

/**
 * Un carril que cambió más archivos de implementación que su cupo no guarda: `{ texto }`, con los archivos contados. Mide
 * lo que el arreglo cambió de verdad, así que ve lo que el conteo al editar no vio, y cerrar y reabrir el carril en la misma
 * rama no empieza de cero. Dentro del cupo, null. Si git no contesta tampoco guarda: sin medir no hay verde.
 * `registrar`: el freno y sus avisos quedan en el registro una vez, en la vuelta que decide, no en la que el reintento
 * corrige. `medida`: la de esta vuelta.
 */
function frenoDelTope(a, sid, home, repos, sinSeguir = false, registrar = true, medida) {
  const io = require('./story-gate-io.js');
  const gate = require('./story-gate.js');
  const dir = path.dirname(path.dirname(require('./open-runs.js').markerPath(sid, home)));
  let c;
  try { c = require('./adhoc-base.js').cuentaDelCarril(a, { repos, sinSeguir, medida }); } catch (e) { c = { archivos: [], avisos: [], fallas: [e.message] }; }
  if (c.fallas.length) {
    if (registrar) io.appendLog(dir, 'gates.log', sid, { name: 'save-brake', status: 'blocked', reason: `tope del carril sin medir: ${c.fallas[0]}` });
    return { texto: `🔒 GUARDAR: no pude medir cuántos archivos cambió este camino corto (${c.fallas[0]}). Sin medir no guarda: arreglá eso y repetí el comando.` };
  }
  if (registrar) {
    for (const m of c.avisos) {
      process.stderr.write(`⚠️  ${m}\n`);
      io.appendLog(dir, 'gates.log', sid, { name: 'save-brake', status: 'unknown', reason: m });
    }
  }
  // el suyo; sin uno que se pueda leer, el tope de la organización (la misma lectura que el portón y la ventana)
  const cupo = gate.cupoDelCarril(a, null) ?? io.topesDelCaminoCorto({ home, ...(registrar ? { stateDir: dir, sessionId: sid } : {}) }).maximo;
  if (c.archivos.length <= cupo) return null;
  if (registrar) io.appendLog(dir, 'gates.log', sid, { name: 'save-brake', status: 'blocked', reason: `camino corto: ${c.archivos.length} archivos de implementación con cupo ${cupo}`, archivos: c.archivos.slice(0, gate.TOPE_DE_NOMBRES) });
  const harness = (() => { try { return io.isHarnessRepo(c.archivos[0]); } catch (_) { return true; } })();
  return { texto: `🔒 GUARDAR: no guarda.\n${gate.textoDelTope({ harness, tocados: c.archivos.length, cupo, archivos: c.archivos })}` };
}

// ── la pantalla del camino rápido ───────────────────────────────────────────────────────────────────────────────────

/**
 * Un carril que toca una pantalla no guarda sin su maqueta aprobada y una captura posterior al último cambio: `{ texto }`.
 * Con las tres, `{ mostrar }`: las dos rutas para la ventana. Sin pantalla, null. Sin medir no hay verde: tampoco guarda.
 * `registrar`: lo que frena o pasa queda en el registro sólo en la vuelta que decide. `medida`: la de esta vuelta.
 */
function frenoDePantalla(a, sid, home, repos, { registrar = true, medida } = {}) {
  const io = require('./story-gate-io.js');
  const dir = path.dirname(path.dirname(require('./open-runs.js').markerPath(sid, home)));
  let r;
  try { r = require('./adhoc-screen.js').revisar(a, repos, medida); } catch (e) { r = { sinMedir: e.message }; }
  if (r.sinMedir) {
    if (registrar) io.appendLog(dir, 'gates.log', sid, { name: 'save-brake', status: 'blocked', reason: `pantalla del carril sin medir: ${r.sinMedir}` });
    if (r.deLaMaqueta) return { texto: `🔒 GUARDAR: no pude comparar la pantalla con su maqueta (${r.sinMedir}). Sin medir no guarda.` };
    return { texto: `🔒 GUARDAR: no pude medir si este camino rápido toca una pantalla (${r.sinMedir}). Sin medir no guarda: arreglá eso y repetí el comando.` };
  }
  // los avisos de lo que se midió con menos ya los dio el freno del tope, que mide lo mismo
  if (!r.pantallas.length) return null;
  if (!r.faltan.length) {
    if (registrar) for (const reason of r.registro || []) io.appendLog(dir, 'gates.log', sid, { name: 'save-brake', status: 'ok', reason });
    return { mostrar: r.mostrar };
  }
  if (registrar && r.textosQueFaltan) io.appendLog(dir, 'gates.log', sid, { name: 'save-brake', status: 'blocked', reason: `faltan ${r.textosQueFaltan.total} textos de la maqueta` });
  return { texto: textoDeLaMaqueta(r) };
}

/**
 * El texto del freno de pantalla cuando falta algo de la maqueta: los textos que no aparecen (`textosQueFaltan`) o la
 * maqueta, su ok y la captura. Aprobar la maqueta es una firma: se imprime con la ruta absoluta (signatureCommand).
 */
function textoDeLaMaqueta(r) {
  const gate = require('./story-gate.js');
  const { homePath, signatureCommand } = require('./home-command.js');
  const marker = gate.MARKER_JS;
  const aprobar = `${signatureCommand(gate.MARKER_REL)} adhoc set '{"reason":"<el motivo>","mockup":"<ruta>","mockupApproved":"<quién la aprobó y por qué vía>"}'`;
  if (r.textosQueFaltan) {
    return [
      `🔒 GUARDAR: este camino corto toca una pantalla (${r.pantallas[0]}) y le faltan ${r.textosQueFaltan.total} texto(s) de su maqueta aprobada:`,
      ...r.faltan.map((f) => `  · ${f}`),
      '  Se completa de una de estas tres formas:',
      '   1. Corregí la pantalla, para que diga ese texto.',
      `   2. Volvé a aprobar la maqueta, si lo que cambió es ella: ${aprobar}`,
      `   3. Declará la diferencia en ${r.textosQueFaltan.diferencias}, con un renglón \`- «<texto>» — differs: <por qué>\`. Si no se puede comparar: \`mockup-compare: no — <motivo>\`.`,
      '  Se comparan los textos, no el dibujo: un texto que ya existe en otra pantalla del repo pasa.',
    ].join('\n');
  }
  const mockup = homePath(gate.MARKER_REL.replace(/marker\.js$/, 'mockup.js'));
  return [
    `🔒 GUARDAR: este camino rápido toca una pantalla (${r.pantallas[0]}) y le falta:`,
    ...r.faltan.map((f) => `  · ${f}`),
    '  Cómo se completa, en este orden:',
    `   1. La maqueta: node ${mockup} render --data <modelo.json> --out <ruta> (la forma del modelo: node ${mockup} schema).`,
    `   2. Mostrásela a la persona y, con su ok: ${aprobar}`,
    `   3. Con la pantalla ya construida, la captura: node ${marker} adhoc capture <ruta de la imagen>`,
    '  Un cambio de código después de la captura la vence.',
  ].join('\n');
}

// ── de dónde salen los datos y quién los ve ─────────────────────────────────────────────────────────────────────────

/**
 * Un carril cuyo cambio trae una señal fuerte (una llamada a un proceso, un chequeo de rol, la autorización de un
 * endpoint: las declara el paquete del stack) no guarda: `{ texto, huella }`. Lo levanta sólo el click del dueño sobre esa
 * huella (`datosPermitido`, de `marker.js adhoc allow-data-change`). Con sólo señales débiles, `{ mostrar }`: una línea
 * para la ventana. Sin señales, null. Sin medir no guarda. El freno queda anotado en el carril (`frenoDatos`): de ahí lo
 * leen el comando que pide el click y su cuadro. `opciones.cargar` y `opciones.medir` se pasan en las pruebas.
 * `registrar`: el freno, sus avisos y `frenoDatos` quedan escritos sólo en la vuelta que decide. `medida`: la de esta vuelta.
 */
function frenoDeDatos(a, sid, home, repos, { sinSeguir = false, cargar, medir, registrar = true, medida } = {}) {
  const io = require('./story-gate-io.js');
  const ss = require('./source-signals.js');
  const dir = path.dirname(path.dirname(require('./open-runs.js').markerPath(sid, home)));
  const avisar = (m) => { if (registrar) avisarSinMedir(m, sid, home); };
  let r;
  try {
    const porRepo = new Map();
    const senales = (repo) => {
      if (!porRepo.has(repo)) {
        const c = (cargar || ss.cargar)({ repo });
        for (const m of c.avisos) avisar(m);
        porRepo.set(repo, c.senales);
      }
      return porRepo.get(repo);
    };
    r = (medir || ss.buscar)(a, senales, { repos, sinSeguir, medida });
  } catch (e) { r = { hallazgos: [], avisos: [], fallas: [e.message] }; }
  if (r.fallas.length) {
    if (registrar) io.appendLog(dir, 'gates.log', sid, { name: 'save-brake', status: 'blocked', reason: `datos del carril sin medir: ${r.fallas[0]}` });
    return { texto: `🔒 GUARDAR: no pude medir si este camino corto cambia de dónde sale un dato o quién lo ve (${r.fallas[0]}). Sin medir no guarda: arreglá eso y repetí el comando.` };
  }
  for (const m of r.avisos) avisar(m);
  const fuertes = r.hallazgos.filter((h) => h.strength === 'strong');
  const debiles = r.hallazgos.filter((h) => h.strength !== 'strong');
  const mostrar = debiles.length ? `Aviso: el nombre de ${[...new Set(debiles.map((h) => h.file))].slice(0, 3).join(', ')} habla de roles o permisos; mirá que el cambio no toque quién ve qué.` : null;
  if (!fuertes.length) return mostrar ? { mostrar } : null;
  const huella = ss.huella(fuertes);
  if (a.datosPermitido && a.datosPermitido.huella === huella) {
    if (registrar) io.appendLog(dir, 'gates.log', sid, { name: 'save-brake', status: 'ok', reason: `datos del carril: los dejó pasar una persona (${huella})` });
    return mostrar ? { mostrar } : null;
  }
  if (!registrar) return { huella, texto: 'frenaría' };
  io.writeAdhoc(dir, sid, { ...a, frenoDatos: { huella, hallazgos: fuertes.slice(0, 20), at: new Date().toISOString() } });
  io.appendLog(dir, 'gates.log', sid, { name: 'save-brake', status: 'blocked', reason: `camino corto que cambia de dónde sale un dato o quién lo ve: ${ss.descripcion(fuertes[0])}`, huella });
  const marker = require('./story-gate.js').MARKER_JS;
  const mas = fuertes.length > 1 ? `; y ${fuertes.length - 1} más` : '';
  return { huella, texto: [
    `🔴 No guardo: esto cambia de dónde sale un dato o quién lo ve (${ss.descripcion(fuertes[0])}${mas}).`,
    `   Eso no es camino corto: va por historia, aunque sea corta. Ante la duda, historia.${a.datos === 'sin-cambio' ? ` Abriste el carril y declaraste que no («datos: sin-cambio»), y el cambio trae ${fuertes[0].says}.` : ''}`,
    '   Si creés que es un falso positivo, lo decide una persona con un click: pedíselo a la coordinadora con',
    `   node ${marker} adhoc allow-data-change --changed "<qué cambió, en una frase>" --recommends <pasar|historia|descartar> --why "<por qué>"`,
  ].join('\n') };
}

// ── el camino rápido de riesgo alto ─────────────────────────────────────────────────────────────────────────────────

/**
 * El texto del freno cuando faltan los revisores y el pase, en los dos perfiles: en un producto lo lee el dev («vos») y
 * no nombra las piezas de la capa de mantenimiento; en el arnés dice «constancia», que es lo que se escribe.
 */
function textoFaltanRevisoresYPase({ harness, regla, archivo }) {
  const gate = require('./story-gate.js');
  const marker = gate.MARKER_JS;
  const pipeline = require('./home-command.js').homePath(gate.MARKER_REL.replace(/marker\.js$/, 'pipeline.js'));
  const que = `${archivo} (regla: ${regla})`;
  return (harness ? [
    `🔒 GUARDAR: faltan los revisores y el pase. Este camino rápido toca una ruta de riesgo alto: ${que}.`,
    '  Antes de guardar corren los revisores y el pase adversarial sobre el diff del camino rápido contra su base, y quedan',
    '  sus dos constancias en el registro del carril (sin ok firmado: con las dos, guardar sigue como siempre).',
    `   1. node ${pipeline} advisors --adhoc     → lanzá los revisores que devuelve; después: node ${pipeline} check-count --adhoc`,
    `   2. node ${pipeline} deep-review-gate --adhoc → si corre, el pase; después: node ${marker} mark-adversarial-result <N> --adhoc --result <archivo>`,
    '  Un cambio de código después de las constancias las vence. Si no lo abrió una persona, este camino rápido no se',
    '  delega: pedíselo a una persona, o escribí la historia que lo lleva.',
  ] : [
    `🔒 GUARDAR: faltan los revisores y el pase. Este cambio toca una ruta de riesgo alto: ${que}.`,
    '  Antes de guardar, corré vos los revisores y el pase adversarial sobre lo que cambió; el arnés anota que corrieron',
    '  y después guardás como siempre, con tu sí.',
    `   1. node ${pipeline} advisors --adhoc     → lanzá los revisores que devuelve; después: node ${pipeline} check-count --adhoc`,
    `   2. node ${pipeline} deep-review-gate --adhoc → si corre, el pase; después: node ${marker} mark-adversarial-result <N> --adhoc --result <archivo>`,
    '  Si cambiás código después, vas a tener que correrlos de nuevo.',
  ]).join('\n');
}

// Lo que no se pudo medir: se dice en pantalla y queda en el registro.
function avisarSinMedir(texto, sid, home) {
  process.stderr.write(`⚠️  ${texto}\n`);
  const dir = path.dirname(path.dirname(require('./open-runs.js').markerPath(sid, home)));
  require('./story-gate-io.js').appendLog(dir, 'gates.log', sid, { name: 'save-brake', status: 'unknown', reason: texto });
}

// El carril con `main` traído otra vez, avisando los repos donde no se pudo.
function basesAlDia(a, sid, home) {
  const r = require('./adhoc-base.js').conBasesAlDia(a);
  for (const aviso of r.avisos) avisarSinMedir(aviso, sid, home);
  return r;
}

/**
 * Un carril de riesgo alto no guarda sin las dos constancias vigentes: `{ texto }` o null. Marca el carril si lo que se
 * guarda trae una ruta de riesgo alto que la herramienta no vio: la marca no entra a `rutas` (la puso el freno, no una
 * edición) y su repo queda con su base, así la huella y los revisores lo miden. Vigente = la huella de los archivos de
 * código del carril es la de cada constancia. Antes de frenar, quien lo llama trae `main` una vez y vuelve a medir: la
 * marca que ya no tiene de qué agarrarse se levanta (y su ruta sale de `rutas` si una edición no la anotó), y traer `main`
 * a la rama no vence las constancias si lo propio no cambió. Sin medir no hay verde.
 *
 * `opciones`: `medida` (la de esta vuelta, con los repos del carril y los del comando), `alDia` (los repos con `main` recién
 * traído en esta vuelta), `registrar` (en false sólo dice si frenaría, sin escribir nada). Llamado suelto, sin medida,
 * mide, trae `main` y vuelve a medir por su cuenta.
 */
function frenoDelRiesgo(a, sid, home, reposDelComando = [], { medida, alDia = [], registrar = true } = {}) {
  const base = require('./adhoc-base.js');
  if (!medida) {
    const medir = (carril) => base.medirLoPropio(carril, { repos: reposDelComando });
    if (!decidirRiesgo(a, sid, home, { medida: medir(a), alDia: [], registrar: false })) return null;
    const b = basesAlDia(a, sid, home);
    return decidirRiesgo(b.adhoc, sid, home, { medida: medir(b.adhoc), alDia: b.alDia, registrar: true });
  }
  return decidirRiesgo(a, sid, home, { medida, alDia, registrar });
}
function decidirRiesgo(a, sid, home, { medida: m, alDia, registrar }) {
  const io = require('./story-gate-io.js');
  const base = require('./adhoc-base.js');
  const dir = path.dirname(path.dirname(require('./open-runs.js').markerPath(sid, home)));
  let marca = a.riesgoAlto || null;
  try {
    const vigentes = (carril) => {
      const huella = base.huellaDelCarril(carril, m);
      // una huella medida con git caído no confirma nada: las constancias no valen contra ella
      const vigente = (c) => c && typeof c === 'object' && base.huellaCompleta(huella) && c.huella === huella;
      return vigente(carril.revisores) && vigente(carril.pase);
    };
    // lo que mide el riesgo: las dos rutas de cada cambio, lo anotado y todo lo que git no sigue, en cada repo medido
    const porRepo = base.rutasDe(m, a, { como: 'todo' });
    let nueva = null;
    for (const repo of Object.keys(porRepo)) {
      const r = require('./risk-paths.js').riesgoDeArchivos(porRepo[repo], { repo });
      if (r.value) { nueva = { repo, marca: { regla: r.rule, archivo: r.file ? path.join(repo, r.file) : repo, motivo: r.reason, ts: new Date().toISOString() } }; break; }
    }
    // una ruta de riesgo alto en un repo del comando que el carril no mide: la huella de las constancias no lo ve, y con
    // una marca ya vigente pasaría sin revisores. Su repo entra al carril con su base, y la huella cambia
    if (marca) {
      const delCarril = base.reposDelCarril(a);
      for (const repo of Object.keys(porRepo)) {
        if (!delCarril.includes(repo) && require('./risk-paths.js').riesgoDeArchivos(porRepo[repo], { repo }).value) a = base.conBase(a, repo).adhoc;
      }
    }
    if (!marca && !nueva && !m.fallas.length) {
      if (registrar) io.writeAdhoc(dir, sid, a);
      return null;
    }
    if (marca && vigentes(a)) {
      if (registrar) io.writeAdhoc(dir, sid, a);
      return null;
    }
    if (!registrar) return { frenaria: true };
    for (const f of m.fallas) avisarSinMedir(f, sid, home);
    if (!marca && !nueva) {
      io.writeAdhoc(dir, sid, a);
      return { texto: `🔒 GUARDAR: no pude medir si este camino corto toca una ruta de riesgo alto (${m.fallas[0]}). Sin medir no guarda: arreglá eso y repetí el comando.` };
    }
    if (marca && base.marcaSinSustento(marca, m, alDia, a.bases, a, (texto) => avisarSinMedir(texto, sid, home))) {
      io.appendLog(dir, 'gates.log', sid, { name: 'save-brake', status: 'ok', reason: `marca levantada: ${marca.archivo} (regla: ${marca.regla}) ya no es de este camino rápido` });
      const { riesgoAlto: _, ...sinMarca } = a;
      // la ruta que un carril viejo anotó con la marca sale con ella, si ninguna edición la anotó
      const files = Array.isArray(a.files) ? a.files : [];
      if (Array.isArray(a.rutas)) sinMarca.rutas = a.rutas.filter((f) => f !== marca.archivo || files.includes(f));
      a = sinMarca;
      marca = null;
    }
    if (!marca && nueva) {
      marca = nueva.marca;
      // el repo de la marca queda en el carril con su base: los revisores y el pase lo miden después
      a = base.conBase({ ...a, riesgoAlto: marca }, nueva.repo).adhoc;
    }
    io.writeAdhoc(dir, sid, a);
    if (!marca || vigentes(a)) return null;
  } catch (e) {
    // sin medir no hay verde, como en el tope y los datos
    if (!registrar) return { frenaria: true };
    io.appendLog(dir, 'gates.log', sid, { name: 'save-brake', status: 'blocked', reason: `riesgo del carril sin medir: ${e.message}` });
    return { texto: `🔒 GUARDAR: no pude medir si este camino corto toca una ruta de riesgo alto (${e.message}). Sin medir no guarda: arreglá eso y repetí el comando.` };
  }
  const harness = (() => { try { return io.isHarnessRepo(marca.archivo); } catch (_) { return true; } })();
  return { texto: textoFaltanRevisoresYPase({ harness, regla: marca.regla, archivo: marca.archivo }) };
}

module.exports = { tramosDelShell, palabrasDelShell, commitsDelShell, comandosQueGuardan, leerComando, decidir, destinoDelEmpuje, preparado, RAMAS_COMPARTIDAS, textoFaltanRevisoresYPase, textoDeLaMaqueta, frenoDelRiesgo, frenoDeDatos };
