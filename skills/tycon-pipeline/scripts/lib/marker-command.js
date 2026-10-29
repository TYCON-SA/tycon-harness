'use strict';
/**
 * marker-command — qué llamadas a `marker.js` y `pipeline.js` corre un comando de la terminal, leído como lo lee el shell.
 *
 * El freno de seguridad (ESC-C3) pregunta acá si un comando apaga el modo autónomo, cierra la ejecución, declara un
 * control en verde a mano (`set-check … --force-manual`) o da por corridos revisores que el arnés no vio
 * (`pipeline.js check-count --trust-ran`); ESC-C6, qué cita trae la aprobación del plan. Leerlo como
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
 * Uso: llamadas(comando, { shell: 'bash' | 'powershell' }) → [{ guion, sub, args: [{ texto, literal }], dudosa, asig }]
 *      escapeDe(llamada, sid, comando?) → 'set-autonomous' | 'cerrar la ejecución' | 'cerrar como deuda' |
 *      'force-manual' | 'trust-ran' | 'no-deep-review' | null. Con `comando`, el comando entero en la forma canónica de
 *      la firma de force-manual o trust-ran no es un escape: lo firma su guion en la ventana.
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
    // `partida`: sin comillas, el shell parte la salida en palabras (puede traer una bandera además del valor)
    empezar(); palabra.literal = false; palabra.partida = true; palabra.texto += '$(…)';
    return j < 0 ? cmd.length : j;
  };
  const comillaInvertida = (i) => {
    const j = cmd.indexOf('`', i + 1);
    subs.push(cmd.slice(i + 1, j < 0 ? cmd.length : j));
    if (j < 0) abierta = true;
    empezar(); palabra.literal = false; palabra.partida = true; palabra.texto += '`…`';
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
      // la continuación de renglón con CRLF (un comando escrito en Windows)
      if (cmd[i + 1] === '\r' && cmd[i + 2] === '\n') { i += 2; continue; }
      empezar(); palabra.texto += cmd[i + 1] || ''; i++; continue;
    }
    if (c === '`' && ps) { empezar(); palabra.texto += cmd[i + 1] || ''; i++; continue; }
    if (c === "'" || c === '"' || (c === '$' && !ps && (cmd[i + 1] === "'" || cmd[i + 1] === '"'))) {
      const comilla = c === '$' ? cmd[++i] : c;
      // `$'…'` interpreta escapes (`\x72` es una «r»): su texto no se puede leer tal cual
      if (c === '$' && comilla === "'") { empezar(); palabra.literal = false; }
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
    // una variable sin comillas: el shell parte su valor en palabras
    if (c === '$') palabra.partida = true;
    // las llaves sin comillas se expanden (`--x-{a,b}`, `{1..3}`): la palabra no es su texto
    if (c === '{' && /^\{[^{}\s]*(,|\.\.)[^{}\s]*\}/.test(cmd.slice(i))) palabra.literal = false;
    palabra.texto += c;
  }
  cerrarTramo();
  return { tramos: salida, subs, abierta };
}

const base = (t) => t.replace(/\{[^}]*\}/g, '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
// el guion que nombra la palabra: `marker` o `pipeline` (con o sin `.js`, con cualquier ruta), o null
const guionDe = (t) => { const m = /^(marker|pipeline)(\.js)?$/.exec(base(t)); return m ? m[1] : null; };
const NOMBRA_GUION = /marker|pipeline/i;
const CORRE_NODE = /(^|[\s;&|(]|\/)(node|nodejs|bun)(\.exe)?\s/i;
const NODES = new Set(['node', 'nodejs', 'bun']);
// las opciones de `node` que llevan su valor en la palabra siguiente: ese valor no es el guion
const NODE_CON_VALOR = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions']);
// las opciones de `node` cuyo valor es el código que corre: ese código se lee como el guion. Puede correr lo que
// recibe en sus argumentos (`node -e 'spawnSync(process.argv[1],…)' "$S" start --no-deep-review`), y distinguirlo del
// de una sonda pide leer JavaScript: con llaves o comodines, se lee como un guion escondido (freno aceptado por duda)
const NODE_CODIGO = new Set(['-e', '-p', '--eval', '--print']);
// apagar el pase adversarial, escrito en el comando: con el pipeline o el marcador nombrados en el mismo comando que
// corre node, cuenta aunque el lector no vea cómo los une el código (un `node -e` que los recibe por el ambiente)
// con o sin `.js`: `node pipeline` corre `pipeline.js`
const NOMBRA_GUION_JS = /(^|[^\w.-])(marker|pipeline)(\.js)?(?![\w.-])/i;
// node en cualquier lugar del comando, también al final o pegado a `<<<` (no sólo con un espacio después)
const CORRE_NODE_SUELTO = /(^|[\s;&|(]|\/)(node|nodejs|bun)(\.exe)?(?![\w.-])/i;
const APAGA_EL_PASE = /(^|[^\w-])--no-deep-review(?![\w-])/;

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
  // sin comillas ni barras invertidas, y con la barra invertida + salto de línea unida: `pipe''line.js` y `pipe\⏎line.js`
  // son `pipeline.js` para el shell. Un comando que corre `node` se lee siempre: el guion puede venir con el nombre
  // armado por el shell (`pipelin?.js`, `mar$'k'er.js`)
  const plano = String(cmd).replace(/\\\r?\n/g, '').replace(/["'\\`]/g, '');
  if (hondo > 4 || !(NOMBRA_GUION.test(plano) || CORRE_NODE.test(plano))) return fuera;
  // en todo el comando, también en el cuerpo de cualquier heredoc: uno que se escribe en un archivo puede correrse
  // después (`./a.sh`, `make`), y distinguirlo pide leer shell. Las notas con ese texto se escriben con Edit/Write
  if (CORRE_NODE_SUELTO.test(plano) && NOMBRA_GUION_JS.test(plano) && APAGA_EL_PASE.test(plano)) {
    fuera.push({ guion: 'pipeline', sub: 'start', args: [{ texto: '--no-deep-review', literal: true }], dudosa: false, asig: {}, envFile: false, porXargs: false });
  }
  const { tramos: lista, subs, abierta } = tramos(cmd, shell);
  for (const interno of subs) fuera.push(...llamadas(interno, { shell }, hondo + 1));
  // las variables asignadas con un valor literal en este comando (`F=--trust-ran; …`): escapeDe las lee por su valor.
  // Cuenta sólo una asignación de verdad: delante del programa o como argumento de `export`, `declare`, `local`,
  // `readonly` o `typeset` (`echo F=--ok` no asigna nada). Una variable que también toma valor de otra forma (`for F in`,
  // `read F`, `printf -v F`, `F+=`), asignada dos veces con valores distintos o con un valor que no se ve, no tiene
  // valor conocido (null)
  const asig = {};
  const anotar = (nombre, v) => { asig[nombre] = Object.prototype.hasOwnProperty.call(asig, nombre) && asig[nombre] !== v ? null : v; };
  const DECLARA = new Set(['export', 'declare', 'local', 'readonly', 'typeset']);
  for (const t of lista) {
    const p = programa(t.palabras);
    const pal = t.palabras;
    const comoAsignacion = (w) => {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=([\s\S]*)$/.exec(w.texto);
      if (m) anotar(m[1], w.literal && !m[2] ? m[3] : null);
    };
    pal.slice(0, p.i).forEach(comoAsignacion);
    if (DECLARA.has(p.nombre)) pal.slice(p.i + 1).forEach(comoAsignacion);
    // los nombres que toman valor sin `=`: quedan sin valor conocido
    if (p.nombre === 'for' && pal[p.i + 1]) anotar(pal[p.i + 1].texto, null);
    if (['read', 'mapfile', 'readarray', 'getopts'].includes(p.nombre)) pal.slice(p.i + 1).forEach((w) => { if (/^[A-Za-z_]\w*$/.test(w.texto)) anotar(w.texto, null); });
    pal.forEach((w, k) => { if (w.texto === '-v' && pal[k + 1] && /^[A-Za-z_]\w*$/.test(pal[k + 1].texto)) anotar(pal[k + 1].texto, null); });
    // `F+=b` en cualquier lugar del tramo (el lector de programas no lo toma por asignación)
    pal.forEach((w) => { const m = /^([A-Za-z_][A-Za-z0-9_]*)\+=/.exec(w.texto); if (m) anotar(m[1], null); });
  }
  // una comilla sin cerrar: el resto del comando no se puede leer (puede ser un `marker.js clear`; un comando que sólo
  // nombra `pipeline` no cierra nada)
  if (abierta && /marker/i.test(plano)) fuera.push({ guion: 'marker', sub: null, args: [], dudosa: true });
  // un shell que lee de la entrada (`echo '…' | sh`) corre cualquier texto del comando
  const leeEntrada = lista.some((t) => {
    const p = programa(t.palabras);
    return SHELLS.has(p.nombre) && !t.palabras.slice(p.i + 1).some((w) => /^[-/](c|command|commandwithargs)$/i.test(w.texto));
  });
  for (const t of lista) {
    const p = programa(t.palabras);
    const deTexto = TEXTO.has(p.nombre);
    const pal = t.palabras;
    // el guion que corre `node`: la primera palabra después que no es una opción, ni el valor de una opción que lo
    // lleva aparte (`-r x`), ni el `run` de `bun run`
    let posGuion = -1;
    if (NODES.has(p.nombre)) {
      for (let k = p.i + 1; k < pal.length; k++) {
        const x = pal[k].texto;
        // un código que empieza con `-` se saltea como una opción, igual que antes: el guion es lo que sigue
        if (NODE_CODIGO.has(x)) { if (k + 1 < pal.length && !/^-/.test(pal[k + 1].texto)) { posGuion = k + 1; break; } continue; }
        if (NODE_CON_VALOR.has(x)) { k++; continue; }
        if (/^-/.test(x) || (p.nombre === 'bun' && x === 'run' && k === p.i + 1)) continue;
        posGuion = k;
        break;
      }
    }
    for (let m = 0; m < pal.length; m++) {
      const w = pal[m];
      // el guion con un nombre que el shell arma (una variable sola, `$'…'`, un comodín, llaves) y no se puede leer: puede
      // ser cualquiera de los dos, y se lee como los dos. Con la carpeta en variables simples y la última parte escrita
      // (`$S/a.js`, `"${D}/x.js"`) el nombre es fijo, salvo que el shell parta una de esas variables en palabras
      const ultimo = w.texto.split(/[\\/]/).pop();
      const sinVariables = w.texto.replace(/\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/g, '');
      const partible = [...w.texto.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)]
        .some((v) => asig[v[1]] === null || (typeof asig[v[1]] === 'string' && /\s/.test(asig[v[1]])));
      const nombreFijo = ultimo !== w.texto && /^[^$*?[{`'"]+$/.test(ultimo) && !/[$`*?[{]/.test(sinVariables)
        && !(w.partida && partible);
      const escondido = m === posGuion && !guionDe(w.texto) && !nombreFijo && (!w.literal || /[*?[{]/.test(w.texto));
      const guiones = guionDe(w.texto) ? [guionDe(w.texto)] : escondido ? ['pipeline', 'marker'] : [];
      const guion = guiones[0];
      if (guion) {
        if (deTexto && m !== p.i) continue;
        let args = pal.slice(m + 1);
        // después del código de `node -e`, node descarta un `--`: no es el subcomando
        if (m === posGuion && m > 0 && NODE_CODIGO.has(pal[m - 1].texto) && args.length && args[0].literal && args[0].texto === '--') args = args.slice(1);
        // `marker.js{,} clear` se expande a dos `marker.js`: la segunda no es el subcomando
        while (args.length && guionDe(args[0].texto) === guion) { args = args.slice(1); m++; }
        // el subcomando en una variable asignada en el mismo comando (`S=start; pipeline.js $S`) se lee por su valor,
        // partido en palabras como lo parte el shell: vacía, el subcomando es la palabra siguiente (`S=; … $S start`);
        // con varias, la primera es el subcomando y las demás son argumentos
        const enVariable = args.length && !args[0].literal && /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(args[0].texto);
        if (enVariable && typeof asig[enVariable[1]] === 'string') {
          const partes = asig[enVariable[1]].split(/\s+/).filter(Boolean).map((texto) => ({ texto, literal: true }));
          args = [...partes, ...args.slice(1)];
        }
        const sub = args.length && args[0].literal ? args[0].texto : null;
        // `node --env-file=<archivo> pipeline.js …`: el archivo puede traer variables que el comando no muestra
        const envFile = pal.slice(0, m).some((x) => /^--env-file(-if-exists)?(=|$)/.test(x.texto));
        // `subPalabra`: el subcomando que no se ve, para saber si el shell lo parte y trae una bandera consigo
        const subPalabra = sub === null && args.length ? args[0] : undefined;
        for (const g of guiones) fuera.push({ guion: g, sub, args: args.slice(1), dudosa: sub === null && (p.porXargs || args.length > 0), asig, envFile, porXargs: p.porXargs, ...(subPalabra ? { subPalabra } : {}) });
        // lo que va después de `--` es otro comando que el guion corre (`marker.js run-check <x> -- marker.js …`)
        const corte = args.findIndex((a) => a.literal && a.texto === '--');
        if (corte >= 0 && corte + 1 < args.length) {
          fuera.push(...llamadas(args.slice(corte + 1).map((a) => (/\s/.test(a.texto) ? `'${a.texto.replace(/'/g, '')}'` : a.texto)).join(' '), { shell }, hondo + 1));
        }
        break;
      }
      // un texto con `marker` o `pipeline` adentro, pasado a un programa que no es de texto: puede ser un comando
      if (/\s/.test(w.texto) && NOMBRA_GUION.test(w.texto) && (!deTexto || leeEntrada)) {
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
 * Lo que la llamada pide decidir a la persona: 'set-autonomous', 'cerrar la ejecución', 'force-manual', 'trust-ran',
 * 'no-deep-review' o null. `sid` es la sesión del pedido (para `clear-session` de otra sesión, que no cierra esta ejecución).
 */
// Las opciones que llevan valor, por guion: lo que va después de una de ellas es su valor (`--repo $PWD`). Las de
// `pipeline.js` se leen de su propio lector de opciones (las que consumen `argv[++i]`), así una opción nueva no queda
// afuera; las de `marker.js`, que lee sus opciones por subcomando, van en una lista. Cada guion usa sólo las suyas: una
// opción del otro (`pipeline.js … --tests "$(…)"`) el guion la ignora y lee lo que sigue como bandera. Lo que sigue a
// cualquier otra opción, o a una que no se conoce, puede ser la bandera.
const CON_VALOR_MARKER = ['--files', '--reason', '--run', '--result', '--model', '--classes', '--tests', '--own', '--in',
  '--deferred', '--type', '--approved', '--approved-by', '--delegated-by', '--agent', '--relayed-by', '--quote', '--debt',
  '--rule', '--file', '--iter', '--story', '--repo', '--mockup-approved', '--evidence-dir', '--max-mutants', '--cost-tier',
  '--session-model', '-r'];
const conValorCache = {};
function opcionesConValor(guion) {
  if (guion !== 'pipeline') return conValorCache.marker || (conValorCache.marker = new Set(CON_VALOR_MARKER));
  if (conValorCache.pipeline) return conValorCache.pipeline;
  const set = new Set();
  try {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'pipeline.js'), 'utf8');
    const i = src.indexOf('function parseArgs');
    const cuerpo = i >= 0 ? src.slice(i, src.indexOf('\n}\n', i)) : '';
    for (const linea of cuerpo.split('\n')) {
      if (!/argv\[\+\+i\]|argv\[i \+ 1\]/.test(linea)) continue;
      for (const m of linea.matchAll(/t === '(-{1,2}[\w-]+)'/g)) set.add(m[1]);
    }
  } catch { /* sin el lector de pipeline.js ninguna opción lleva valor: todo se lee del lado que frena */ }
  conValorCache.pipeline = set;
  return set;
}

/**
 * `pide(bandera)`: si los argumentos de la llamada pueden llevar `bandera`, a la vista o escondida en un argumento que
 * no se ve. La usa escapeDe y la ventana de permiso (owner-window.js), con la misma lectura.
 */
function lectorDeBanderas(llamada) {
  const { sub, args } = llamada;
  const asig = llamada.asig || {};
  const lit = (a) => a && a.literal;
  // las palabras de un argumento: el literal, o las del valor de una variable sola asignada con un valor literal en el
  // mismo comando (`F=--trust-ran; … $F`). Sin comillas, el shell parte el valor en palabras (`OPTS="--story s
  // --no-deep-review"`): se miran todas. `undefined` si no se puede saber
  const valorDe = (a) => {
    if (lit(a)) return [a.texto];
    const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(a.texto);
    return m && typeof asig[m[1]] === 'string' ? asig[m[1]].split(/\s+/).filter(Boolean) : undefined;
  };
  // un archivo de `--files` escrito con variables: una o más variables y después texto fijo con una barra o un punto
  // (`$W/a.sh`, `${D}x.md`). Cualquier otra forma (una variable sola sin valor conocido, un `$(…)`, comillas que lo
  // esconden) puede ser la bandera
  const archivoConVariables = (a) => /^(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)+[^$`]*[/.][^$`]*$/.test(a.texto);
  const conValor = opcionesConValor(llamada.guion);
  // ¿el shell puede partir este argumento en varias palabras, una de ellas la bandera? Sin comillas, la salida de un
  // `$(…)` sí; una variable, sólo si tomó en este mismo comando un valor que no se ve (`read F`, `for F in`). Una
  // variable que viene del ambiente de la sesión (`$PWD`, `$S` sin asignar acá) no la escribe el comando
  const puedeTraerOtra = (a) => !!a.partida && (/\$\(…\)|`…`/.test(a.texto)
    || [...a.texto.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].some((m) => asig[m[1]] === null
      || (typeof asig[m[1]] === 'string' && /\s/.test(asig[m[1]]))));
  // `--force-manual`, `--trust-ran` o `--no-deep-review` en un argumento que no se ve (`$F`) se lee del lado que frena,
  // salvo que sea el valor de la opción de antes que lleva valor (`--repo $PWD`, `-x "$V"`), un argumento de posición
  // (`set-check "$N" green`: el nombre y el estado) o un archivo de `--files` (lo que la sigue hasta la próxima opción,
  // si tiene la forma de `archivoConVariables`). Una variable asignada en el mismo comando se lee por su valor; en
  // `--files`, uno que empieza con «--» también cuenta. En `marker.js`, lo que va después de `--` es otro comando (el de
  // `run-check`); en `pipeline.js` no hay corte: su lector de opciones no se detiene en `--`.
  const posicionales = sub === 'set-check' ? 2 : 0;
  const pide = (bandera) => {
    // con los argumentos por `xargs`, vienen de un tubo y no se ven
    if (llamada.porXargs) return true;
    // el subcomando que no se ve y que el shell parte (`$(echo check-count --trust-ran)`, `read S; … $S`) trae lo que quiera
    if (sub === null && llamada.subPalabra && puedeTraerOtra(llamada.subPalabra)) return true;
    const fin = llamada.guion === 'marker' && sub === 'run-check' ? args.findIndex((a) => a.literal && a.texto === '--') : -1;
    const propios = fin >= 0 ? args.slice(0, fin) : args;
    let enFiles = false;
    // la palabra que una opción con valor se come; una opción comida como valor (`--story --repo "$F"`) no se come la
    // siguiente, y lo que sigue queda suelto
    let comida = -1;
    return propios.some((a, i) => {
      if (lit(a) && /^-/.test(a.texto) && i !== comida) {
        enFiles = a.texto === '--files';
        if (!enFiles && conValor.has(a.texto)) comida = i + 1;
        return a.texto === bandera;
      }
      const v = valorDe(a);
      if (enFiles) return v !== undefined ? v.some((w) => w === bandera || w.startsWith('--')) : !archivoConVariables(a) || puedeTraerOtra(a);
      if (v !== undefined) return v.includes(bandera);
      return i >= posicionales && !(i === comida && !puedeTraerOtra(a));
    });
  };
  return pide;
}

/** El id de la firma `guion` del comando entero en su forma canónica, o null (owner-window.js, que lee este archivo). */
function canonicaDe(comando) {
  let ow;
  try {
    ow = require(require('path').join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'owner-window.js'));
  } catch (e) {
    // sin la ventana, la forma canónica se trata como escape y el freno la niega; el motivo queda en el registro
    try {
      const path = require('path');
      const dir = require('./state-dir.js').stateDir();
      require('fs').mkdirSync(dir, { recursive: true });
      require('fs').appendFileSync(path.join(dir, 'hook-errors.log'),
        `[${new Date().toISOString()}] marker-command: no cargó owner-window.js (${e && e.message}); la forma canónica se lee como escape\n`);
    } catch (_) { /* el registro es ayuda: el freno sigue negando igual */ }
    return null;
  }
  const c = ow.canonicaDe(String(comando));
  return c ? c.id : null;
}

function escapeDe(llamada, sid, comando = null) {
  const { sub, args } = llamada;
  const lit = (a) => a && a.literal;
  const pide = lectorDeBanderas(llamada);
  // el comando entero en la forma canónica de la firma la pide su guion en la ventana: no es un escape del freno
  const porSuGuion = (esc) => comando != null && canonicaDe(comando) === `escape:${esc}`;
  if (llamada.guion === 'pipeline') {
    // `check-count --trust-ran`: la lista de revisores la da el agente y el arnés no la vio correr
    if (sub === 'check-count') return pide('--trust-ran') && !porSuGuion('trust-ran') ? 'trust-ran' : null;
    // apagar el pase adversarial al arrancar la historia o al consultar el portón; un `--env-file` delante del guion
    // puede traer `TYCON_NO_DEEP_REVIEW` sin que el comando la muestre
    if (sub === 'start' || sub === 'deep-review-gate') return pide('--no-deep-review') || llamada.envFile ? 'no-deep-review' : null;
    // sin subcomando a la vista: puede ser cualquiera de los dos
    if (sub === null && llamada.dudosa) return pide('--trust-ran') ? 'trust-ran' : pide('--no-deep-review') ? 'no-deep-review' : null;
    return null;
  }
  // `set-check <nombre> <estado> --force-manual`: un control declarado a mano, en cualquier estado
  if (sub === 'set-check') return pide('--force-manual') && !porSuGuion('force-manual') ? 'force-manual' : null;
  // `mark-adversarial-skipped --no-deep-review`: abandonar el pase aunque el portón diga que corre
  if (sub === 'mark-adversarial-skipped') return pide('--no-deep-review') || llamada.envFile ? 'no-deep-review' : null;
  // sin subcomando a la vista (por `xargs`, en una variable, tras una comilla sin cerrar): puede ser `clear`
  // con la bandera del pase a la vista: apagarlo frena siempre, también con la ejecución en verde o sin ejecución
  if (sub === null) return !llamada.dudosa ? null : pide('--no-deep-review') || llamada.envFile ? 'no-deep-review' : 'cerrar la ejecución';
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

/**
 * La salida de una ejecución perdida (lib/open-runs.js): `marker.js clear-session <sesión> --lost` o `marker.js restore
 * <sesión>`. Pide la frase del dueño siempre, también sin marcador y para otra sesión. Un argumento que no se ve después
 * de la sesión puede ser `--lost`. Devuelve `{ sesion }` (null si la sesión no se ve) o null.
 */
function salidaPerdida(llamada) {
  if (!llamada || llamada.guion !== 'marker') return null;
  const a = llamada.args || [];
  const sesion = a[0] && a[0].literal ? a[0].texto : null;
  if (llamada.sub === 'restore') return { sesion };
  if (llamada.sub === 'clear-session' && (llamada.porXargs || a.slice(1).some((x) => !x.literal || x.texto === '--lost'))) return { sesion };
  return null;
}

module.exports = { llamadas, escapeDe, lectorDeBanderas, salidaPerdida, tramos };
