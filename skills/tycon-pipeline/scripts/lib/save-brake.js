'use strict';
/**
 * save-brake.js — el freno de guardar: dentro de una corrida o de un camino rápido (el carril firmado de `marker.js
 * adhoc set`), antes de un commit, un push o un pedido, la sesión le
 * pregunta a la persona en la ventana de permiso, y con el sí guarda. Lo llama `on-pre-commit.js` en cada comando de
 * consola; en una pestaña que no pide permisos (la ventana se aprobaría sola) guarda sin preguntar y lo dice en pantalla.
 * No hay firma ni constancia del ok: lo delicado (frenos, firmas, controles, producción) lo cubre la firma de control del
 * pedido, que no cambia.
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
 *   · decidir             null (pasa) o `{ pregunta }` (el texto de la ventana). Sin una corrida ni un camino rápido
 *                         abierto, o sin un comando que guarda ni una duda, no lee nada.
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
function tramosDelShell(texto) {
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
    if (!prof && !redireccion && /[;&|\n]/.test(c)) { out.push(cur); cur = ''; i += 1; continue; }
    cur += c; i += 1;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
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
const nuevoCtx = (dirs, dudas, home) => ({ dirs, cdOpaco: false, vars: {}, locales: {}, exportarTodo: false, dudas, home, expandidos: [] });
// lo que hereda un subshell, una sustitución u otro shell: sus cambios no vuelven (las dudas, sí)
const copiar = (ctx) => ({ ...ctx, dirs: [...ctx.dirs], vars: { ...ctx.vars }, locales: { ...ctx.locales } });
function volver(ctx, previo) {
  for (const k of ['dirs', 'cdOpaco', 'vars', 'locales', 'exportarTodo']) ctx[k] = previo[k];
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
    if (cmd === 'cd' || cmd === 'pushd') { moverCarpeta(ctx, ps); return cierra; }
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
// el destino de cada refspec de un push: la rama, sin `+` ni `refs/heads/` (`@` y la rama actual son `HEAD`)
const ramaDe = (refspec) => {
  const destino = refspec.includes(':') ? refspec.slice(refspec.indexOf(':') + 1) : refspec;
  const rama = destino.replace(/^\+/, '').replace(/^refs\/heads\//, '') || null;
  return rama === '@' || RAMA_ACTUAL.test(rama || '') ? 'HEAD' : rama;
};

const OPACO = 'un comando que no se puede leer';

/**
 * Los comandos que guardan: `[{ tipo: 'commit'|'push'|'pr'|'opaco', forma, dir, remoto, rama, opaco, incierto,
 * escritos }]`. `forma` es la forma (`git push`), sin el texto del comando. `remoto` y `rama` del push, si se escribieron
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

/**
 * `{ cs, dudas }`: los comandos que guardan (`comandosQueGuardan`) y si algo del comando no se pudo leer con certeza,
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
  porComando(command, (ps, cmd, ctx) => {
    leer(ps, cmd, ctx);
    escritos.push(...rutasEscritas(ctx.archivos, ctx.dirs));
  }, 0, nuevoCtx([cwd], dudas, home));
  return { cs: out, dudas };

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
      // `-o`/`--push-option` y `--repo` llevan valor aparte: su valor no es el remoto
      const conValor = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
      const limpios = [];
      let todas = false;
      for (let k = 0; k < resto.length; k++) {
        if (conValor.has(resto[k])) { k += 1; continue; }
        if (['--all', '--mirror', '--branches'].includes(resto[k])) todas = true;
        if (!resto[k].startsWith('-')) limpios.push(resto[k]);
      }
      const [remoto, ...refspecs] = limpios;
      // sin una rama escrita, o con `HEAD`, el destino sale del estado de antes del comando: si el comando cambió la
      // rama, ya no es ése
      const sinRamaEscrita = !refspecs.length || refspecs.some((r) => ramaDe(r) === 'HEAD');
      // una rama que sale de otro comando o de una variable que no se conoce: no se sabe cuál es
      const ramaArmada = refspecs.some((r) => /[$`]/.test(ramaDe(r) || ''));
      const incierto = g.cambiaDestino || !!ctx.xargs || refspecs.includes(':') || ramaArmada || (cambioLaRama && sinRamaEscrita);
      const push = (rama) => guardar({ tipo: 'push', forma: 'git push', dir, remoto: remoto || null, rama, ...(incierto ? { incierto: true } : {}) });
      if (todas) push('todas las ramas (--all o --mirror)');
      else if (!refspecs.length) push(null);
      else for (const r of refspecs) push(r === ':' ? null : ramaDe(r));
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
function pregunta(c, repo, story) {
  return `¿GUARDO? «${c.forma}»${repo ? ` sobre ${repo}` : ''}, de la corrida de ${story}. ${COMO_SE_AUTORIZA}`;
}
// lo que no se lee con certeza, durante una corrida: no se sabe qué guardaría ni a dónde, y se pregunta igual
function preguntaNoLeo(story) {
  return `¿GUARDO? no pude leer este comando; si guarda, es de la corrida de ${story}. ${COMO_SE_AUTORIZA}`;
}

/**
 * ¿Pregunta? null (pasa) o `{ pregunta }`: el texto de la ventana de permiso. Dentro de una corrida (el marcador de la
 * sesión), un commit o un push sobre un repo de la corrida, todo pedido y lo que no se puede leer con certeza preguntan.
 * Un marcador que existe y no es el de una corrida también pregunta. Sin corrida, pregunta un camino rápido abierto
 * (`decidirCarril`); sin ninguno de los dos, nada pregunta. No hay ok que
 * guardar: lo que toca algo delicado lo cubre la firma de control del pedido.
 */
function decidir({ command, cwd, sid, home }) {
  // sin una corrida, pregunta sólo un camino rápido abierto
  let crudo = null;
  try { crudo = fs.readFileSync(require('./open-runs.js').markerPath(sid, home), 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return decidirCarril({ command, cwd, sid, home });
  }
  const { cs, dudas } = leerComando(command, cwd || process.cwd(), 0, [], home);
  if (!cs.length && !dudas.length) return null;
  const c0 = cs[0] || { forma: OPACO };
  let m = null;
  try { m = crudo === null ? null : JSON.parse(crudo); } catch (_) { m = null; }
  if (!m || typeof m !== 'object' || Array.isArray(m) || !m.storyId) {
    return { pregunta: `¿GUARDO? «${c0.forma}»: el marcador de la corrida no se puede leer o no dice de qué story es. ${COMO_SE_AUTORIZA}` };
  }
  if (dudas.length || cs.some((c) => c.opaco)) return { pregunta: preguntaNoLeo(m.storyId) };
  let repos;
  try { repos = reposDe(m); } catch (e) { return { pregunta: pregunta(c0, null, m.storyId) }; }
  for (const c of cs) {
    // un pedido se juzga contra toda la corrida
    if (c.tipo === 'pr') return { pregunta: pregunta(c, null, m.storyId) };
    let r;
    // la carpeta sale del comando: no vuelve en el texto
    try { r = SO().raizDe(c.dir); } catch (_) { return { pregunta: pregunta(c, null, m.storyId) }; }
    if (r && repos.includes(r)) return { pregunta: pregunta(c, r, m.storyId) };
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
  return a && io.adhocFirmado(dir, sid, a) ? a : null;
}

/**
 * Sin corrida, con un camino rápido abierto: pregunta como una corrida. Su repo es el de los archivos que el carril
 * anotó; si todavía no anotó ninguno, cualquier repo pregunta. Un pedido y lo que no se lee con certeza preguntan.
 * Sin carril, nada pregunta, como siempre fuera de una corrida.
 */
function decidirCarril({ command, cwd, sid, home }) {
  let a = null;
  try { a = carrilAbierto(sid, home); } catch (_) { a = null; }
  if (!a) return null;
  const { cs, dudas } = leerComando(command, cwd || process.cwd(), 0, [], home);
  if (!cs.length && !dudas.length) return null;
  const de = `del camino rápido «${String(a.reason).slice(0, 160)}»`;
  if (dudas.length || cs.some((c) => c.opaco)) return { pregunta: `¿GUARDO? no pude leer este comando; si guarda, es ${de}. ${COMO_SE_AUTORIZA}` };
  const repos = [];
  for (const f of Array.isArray(a.files) ? a.files : []) {
    let r = null;
    try { r = SO().raizDe(path.dirname(String(f))); } catch (_) { r = null; }
    if (r && !repos.includes(r)) repos.push(r);
  }
  for (const c of cs) {
    if (c.tipo === 'pr') return { pregunta: `¿GUARDO? «${c.forma}», ${de}. ${COMO_SE_AUTORIZA}` };
    let r = null;
    try { r = SO().raizDe(c.dir); } catch (_) { return { pregunta: `¿GUARDO? «${c.forma}», ${de}. ${COMO_SE_AUTORIZA}` }; }
    if (!repos.length || (r && repos.includes(r))) return { pregunta: `¿GUARDO? «${c.forma}»${r ? ` sobre ${r}` : ''}, ${de}. ${COMO_SE_AUTORIZA}` };
  }
  return null;
}

module.exports = { tramosDelShell, palabrasDelShell, commitsDelShell, comandosQueGuardan, leerComando, decidir };
