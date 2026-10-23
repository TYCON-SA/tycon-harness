'use strict';
/**
 * marker-command — qué llamadas a `marker.js` corre un comando de la terminal, leído como lo lee el shell.
 *
 * El freno de seguridad (ESC-C3) pregunta acá si un comando apaga el modo autónomo o cierra la ejecución. Leerlo como
 * texto deja pasar formas que el shell sí corre (dos llamadas en renglones distintos, `$(…)`, la ruta de Windows con
 * barras invertidas, `$'clear'`, `Marker.js` en un disco que no distingue mayúsculas) y frena un `grep` o un mensaje
 * de commit que sólo la nombran. Por eso se parte en palabras respetando comillas, comentarios, heredocs y
 * separadores, y cuenta toda palabra `marker.js` (o `marker`) que no sea argumento de un programa que sólo lee o
 * muestra texto: así los envoltorios (`nice -n 5`, `cmd /c`, `find -exec`, `timeout -s KILL 5`) no hace falta
 * conocerlos uno por uno. Un texto entre comillas con `marker` adentro, pasado a cualquier otro programa (`bash -c`,
 * `eval`, `iex`, `Start-Process`), se lee como otro comando; con un shell que lee de la entrada (`| sh`), todos.
 *
 * Lo dudoso se lee del lado que frena: una palabra que no es literal (`$VAR`, `$(…)`), una llamada sin subcomando por
 * `xargs` o una comilla que no se cierra. Lo que no ve: el nombre del archivo armado en una variable, `node -e` con el
 * código adentro, una copia con otro nombre, y un programa de texto que además ejecuta (`awk` con `system`).
 *
 * Uso: llamadas(comando, { shell: 'bash' | 'powershell' }) → [{ sub, args: [{ texto, literal }], dudosa }]
 *      escapeDe(llamada, sid) → 'set-autonomous' | 'cerrar la ejecución' | 'cerrar como deuda' | null
 */

const PREFIJOS = new Set(['sudo', 'env', 'exec', 'command', 'nohup', 'time', 'nice', 'timeout', 'xargs', 'builtin',
  'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}']);
const TEXTO = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'echo', 'printf', 'cat', 'bat', 'less', 'more',
  'head', 'tail', 'wc', 'sed', 'awk', 'git', 'gh', 'diff', 'ls', 'stat', 'file', 'code', 'open', 'vim', 'nano', 'cp',
  'mv', 'touch', 'write-output', 'write-host', 'get-content', 'select-string', 'findstr', 'type']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'pwsh', 'powershell', 'iex', 'invoke-expression', 'cmd']);

/** Dónde cierra el paréntesis que abre en `i` (el de `$(`), saltando comillas y paréntesis anidados; -1 si no cierra. */
function cierreDeSub(cmd, i) {
  let n = 0;
  for (let j = i; j < cmd.length; j++) {
    const c = cmd[j];
    if (c === '\\') { j++; continue; }
    if (c === "'") { const k = cmd.indexOf("'", j + 1); if (k < 0) return -1; j = k; continue; }
    if (c === '"') {
      let k = j + 1;
      for (; k < cmd.length && cmd[k] !== '"'; k++) if (cmd[k] === '\\') k++;
      if (k >= cmd.length) return -1;
      j = k;
      continue;
    }
    if (c === '(') n++;
    else if (c === ')' && --n === 0) return j;
  }
  return -1;
}

/** Los `$(…)` y `` `…` `` de un cuerpo de heredoc sin comillas, que el shell expande: ahí `'` es un carácter más. */
function sustituciones(texto) {
  const fuera = [];
  for (let i = 0; i < texto.length; i++) {
    if (texto[i] === '\\') { i++; continue; }
    let j = -2;
    if (texto[i] === '$' && texto[i + 1] === '(') { j = cierreDeSub(texto, i + 1); fuera.push(texto.slice(i + 2, j < 0 ? texto.length : j)); }
    else if (texto[i] === '`') { j = texto.indexOf('`', i + 1); fuera.push(texto.slice(i + 1, j < 0 ? texto.length : j)); }
    if (j === -1) break;
    if (j >= 0) i = j;
  }
  return fuera;
}

/**
 * El comando en tramos: `{ palabras: [{ texto, literal }], heredocs: [cuerpo] }`; `subs`, los comandos de adentro de
 * `$(…)`, `<(…)` y `` `…` `` (fuera de comillas simples, y en el cuerpo de un heredoc sin comillas); y `abierta` si
 * una comilla o un `$(` quedaron sin cerrar.
 */
function tramos(cmd, shell) {
  const ps = shell === 'powershell';
  const salida = [];
  const subs = [];
  let tramo = { palabras: [], heredocs: [] };
  let palabra = null;
  let abierta = false;
  const pendientes = []; // heredocs que empiezan al terminar el renglón: { fin, tabs, citado, tramo }
  const empezar = () => { if (!palabra) palabra = { texto: '', literal: true }; };
  const cerrarPalabra = () => { if (palabra) tramo.palabras.push(palabra); palabra = null; };
  const cerrarTramo = () => {
    cerrarPalabra();
    if (tramo.palabras.length || tramo.heredocs.length) salida.push(tramo);
    tramo = { palabras: [], heredocs: [] };
  };
  // `$(…)` o `<(…)` que abre en `i`: su comando va a `subs`, la palabra deja de ser literal; devuelve dónde cierra
  const sustitucion = (i) => {
    const j = cierreDeSub(cmd, i + 1);
    subs.push(cmd.slice(i + 2, j < 0 ? cmd.length : j));
    if (j < 0) abierta = true;
    empezar(); palabra.literal = false; palabra.texto += '$(…)';
    return j < 0 ? cmd.length : j;
  };
  const comillaInvertida = (i) => {
    const j = cmd.indexOf('`', i + 1);
    subs.push(cmd.slice(i + 1, j < 0 ? cmd.length : j));
    if (j < 0) abierta = true;
    empezar(); palabra.literal = false; palabra.texto += '`…`';
    return j < 0 ? cmd.length : j;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === '\n') {
      cerrarTramo();
      // los cuerpos de los heredocs abiertos en este renglón: hasta el renglón que es su delimitador
      while (pendientes.length) {
        const h = pendientes.shift();
        const cuerpo = [];
        let j = i + 1;
        for (;;) {
          const k = cmd.indexOf('\n', j);
          const linea = cmd.slice(j, k < 0 ? cmd.length : k);
          if ((h.tabs ? linea.replace(/^\t+/, '') : linea) === h.fin || k < 0) {
            if (linea !== h.fin && k < 0) cuerpo.push(linea);
            i = k < 0 ? cmd.length : k;
            break;
          }
          cuerpo.push(linea);
          j = k + 1;
        }
        const texto = cuerpo.join('\n');
        h.tramo.heredocs.push(texto);
        // sin comillas en el delimitador, el shell expande el cuerpo: sus `$(…)` corren
        if (!h.citado) subs.push(...sustituciones(texto));
      }
      continue;
    }
    if (/\s/.test(c)) { cerrarPalabra(); continue; }
    // un comentario: la palabra empieza con `#`, hasta el fin del renglón
    if (c === '#' && !palabra) {
      const k = cmd.indexOf('\n', i);
      i = (k < 0 ? cmd.length : k) - 1;
      continue;
    }
    if (c === '$' && cmd[i + 1] === '(') { i = sustitucion(i); continue; }
    if (!ps && (c === '<' || c === '>') && cmd[i + 1] === '(') { cerrarPalabra(); i = sustitucion(i); continue; }
    if (!ps && c === '`') { i = comillaInvertida(i); continue; }
    if (!ps && c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
      cerrarPalabra();
      let j = i + 2;
      const tabs = cmd[j] === '-';
      if (tabs) j++;
      while (cmd[j] === ' ' || cmd[j] === '\t') j++;
      const m = /^(['"]?)([^\s'"<>;&|()]+)\1/.exec(cmd.slice(j));
      if (m) {
        pendientes.push({ fin: m[2], tabs, citado: !!m[1], tramo });
        i = j + m[0].length - 1;
        continue;
      }
    }
    if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')') {
      const actual = tramo;
      cerrarTramo();
      // un heredoc pendiente sigue perteneciendo a su tramo aunque el renglón siga (`cat <<EOF | bash`)
      if (c === '|') tramo.desde = actual;
      continue;
    }
    if (c === '\\' && !ps) {
      if (cmd[i + 1] === '\n') { i++; continue; }
      empezar(); palabra.texto += cmd[i + 1] || ''; i++; continue;
    }
    if (c === '`' && ps) { empezar(); palabra.texto += cmd[i + 1] || ''; i++; continue; }
    if (c === "'" || c === '"' || (c === '$' && !ps && (cmd[i + 1] === "'" || cmd[i + 1] === '"'))) {
      const comilla = c === '$' ? cmd[++i] : c;
      empezar();
      let j = i + 1;
      for (; j < cmd.length && cmd[j] !== comilla; j++) {
        if (comilla === '"') {
          if (cmd[j] === '\\' && !ps && /["\\$`]/.test(cmd[j + 1] || '')) { palabra.texto += cmd[++j]; continue; }
          if (cmd[j] === '$' && cmd[j + 1] === '(') {
            const k = cierreDeSub(cmd, j + 1);
            subs.push(cmd.slice(j + 2, k < 0 ? cmd.length : k));
            palabra.literal = false;
            if (k < 0) { j = cmd.length; break; }
            j = k;
            continue;
          }
          if (cmd[j] === '`' && !ps) {
            const k = cmd.indexOf('`', j + 1);
            subs.push(cmd.slice(j + 1, k < 0 ? cmd.length : k));
            palabra.literal = false;
            if (k < 0) { j = cmd.length; break; }
            j = k;
            continue;
          }
          if (cmd[j] === '$') palabra.literal = false;
        }
        palabra.texto += cmd[j];
      }
      if (j >= cmd.length) abierta = true;
      i = j;
      continue;
    }
    empezar();
    if (c === '$' || c === '*' || c === '?') palabra.literal = false;
    palabra.texto += c;
  }
  cerrarTramo();
  return { tramos: salida, subs, abierta };
}

const base = (t) => t.replace(/\{[^}]*\}/g, '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
const esMarker = (t) => /^marker(\.js)?$/.test(base(t));

/** El programa del tramo: saltea asignaciones, redirecciones y prefijos (`sudo`, `xargs`) con sus opciones. */
function programa(palabras) {
  let i = 0;
  let porXargs = false;
  while (i < palabras.length) {
    const t = palabras[i].texto;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || /^\d*[<>]/.test(t)) { i++; continue; }
    const b = base(t);
    if (PREFIJOS.has(b)) {
      if (b === 'xargs') porXargs = true;
      i++;
      while (i < palabras.length && palabras[i].texto.startsWith('-')) i++;
      continue;
    }
    break;
  }
  return { i, nombre: i < palabras.length ? base(palabras[i].texto) : '', porXargs };
}

/** Las llamadas a `marker.js` que ejecuta el comando. */
function llamadas(cmd, { shell = 'bash' } = {}, hondo = 0) {
  const fuera = [];
  if (hondo > 4 || !/marker/i.test(cmd)) return fuera;
  const { tramos: lista, subs, abierta } = tramos(cmd, shell);
  for (const interno of subs) fuera.push(...llamadas(interno, { shell }, hondo + 1));
  // una comilla sin cerrar: el resto del comando no se puede leer
  if (abierta) fuera.push({ sub: null, args: [], dudosa: true });
  // un shell que lee de la entrada (`echo '…' | sh`) corre cualquier texto del comando
  const leeEntrada = lista.some((t) => {
    const p = programa(t.palabras);
    return SHELLS.has(p.nombre) && !t.palabras.slice(p.i + 1).some((w) => /^[-/](c|command|commandwithargs)$/i.test(w.texto));
  });
  for (const t of lista) {
    const p = programa(t.palabras);
    const deTexto = TEXTO.has(p.nombre);
    const pal = t.palabras;
    for (let m = 0; m < pal.length; m++) {
      const w = pal[m];
      if (esMarker(w.texto)) {
        if (deTexto && m !== p.i) continue;
        let args = pal.slice(m + 1);
        // `marker.js{,} clear` se expande a dos `marker.js`: la segunda no es el subcomando
        while (args.length && esMarker(args[0].texto)) { args = args.slice(1); m++; }
        const sub = args.length && args[0].literal ? args[0].texto : null;
        fuera.push({ sub, args: args.slice(1), dudosa: sub === null && (p.porXargs || args.length > 0) });
        break;
      }
      // un texto con `marker` adentro, pasado a un programa que no es de texto: puede ser un comando
      if (/\s/.test(w.texto) && /marker/i.test(w.texto) && (!deTexto || leeEntrada)) {
        fuera.push(...llamadas(w.texto, { shell: /^(pwsh|powershell|iex|invoke-expression)$/.test(p.nombre) ? 'powershell' : shell }, hondo + 1));
      }
    }
    // el cuerpo de un heredoc es un comando si lo lee un shell (`bash <<EOF`, `cat <<EOF | bash`)
    const destino = t.heredocs.length ? lista[lista.indexOf(t) + 1] : null;
    const aShell = SHELLS.has(p.nombre) || (destino && destino.desde === t && SHELLS.has(programa(destino.palabras).nombre));
    for (const cuerpo of t.heredocs) if (aShell || leeEntrada) fuera.push(...llamadas(cuerpo, { shell }, hondo + 1));
  }
  return fuera;
}

/**
 * Lo que la llamada pide decidir a la persona: 'set-autonomous', 'cerrar la ejecución' o null. `sid` es la sesión del
 * pedido (para `clear-session` de otra sesión, que no cierra esta ejecución).
 */
function escapeDe(llamada, sid) {
  const { sub, args } = llamada;
  const lit = (a) => a && a.literal;
  // sin subcomando a la vista (por `xargs`, en una variable, tras una comilla sin cerrar): puede ser `clear`
  if (sub === null) return llamada.dudosa ? 'cerrar la ejecución' : null;
  if (sub === 'set-autonomous') {
    const v = args[0];
    return lit(v) && ['true', '1', 'on'].includes(v.texto) ? null : 'set-autonomous';
  }
  if (sub === 'clear') return 'cerrar la ejecución';
  // cerrar la historia como deuda, o registrar un control en rojo como esperado: siempre lo decide la persona
  if (sub === 'close-as-debt' || sub === 'expect-red') return 'cerrar como deuda';
  if (sub === 'clear-session') {
    const v = args[0];
    if (!v || !lit(v)) return 'cerrar la ejecución';
    return sid && v.texto.toLowerCase() !== String(sid).toLowerCase() ? null : 'cerrar la ejecución';
  }
  // `update-story-status <historia> <estado>`: cuenta el estado; la ruta puede venir en una variable
  if (sub === 'update-story-status') {
    const v = args[1];
    if (!v) return null;
    return !lit(v) || ['review', 'done'].includes(v.texto.toLowerCase()) ? 'cerrar la ejecución' : null;
  }
  return null;
}

module.exports = { llamadas, escapeDe, tramos };
