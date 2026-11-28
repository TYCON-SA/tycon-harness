'use strict';
/**
 * bash-gate-scripts.js — una parte de on-bash-write-gate.js, el freno de escrituras por consola.
 *
 * Responsabilidad: los guiones en archivo y los borrados: lo que escribe un guion o corre otro programa, borrar o mover carpetas, la ejecución abierta y los destinos de la coordinadora.
 *
 * El código viene de on-bash-write-gate.js tal cual, salvo dos reescrituras mecánicas: los `require` locales van
 * relativos a esta carpeta, y las rutas que salían de la carpeta de los guiones suben un nivel más. Cada parte carga
 * sólo las de abajo (la red primero; el despachador, todas).
 */

const fs = require('fs');
const path = require('path');
const { isCodeFile, isManifestFile, NEVER_CODE_SEGMENTS } = require('./story-gate.js');
const { resolveSessionId } = require('./session-id.js');
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
const { PIPELINE_LEE, PIPELINE_LISTA } = require('./marker-command.js');
const { NOMBRA_RUTA_DE_HISTORIA, logHookError } = require('./bash-gate-net.js');
const { ANTES_DEL_PROGRAMA, BORRA_O_MUEVE, CORRE_ARCHIVO, EXTENSION_DE, GUION_TOPE, GUION_TOPE_DURO, INTERPRETE_DE, PREFIJO, Q, RECORRIDO_ARCHIVOS, RECORRIDO_BYTES, RECORRIDO_NIVELES, expandirLlaves, familiaDe, importsLocales, isInsideReal, nativePath, noSeLeeElPrograma, palabraExpandida, palabras, rutaRealDelGuion, sinGrupo, splitSegments, tok, versionadoEnElArbolPropio, igualAMainDelArbolPropio } = require('./bash-gate-words.js');
const { CUERPOS_A_JUZGAR, LECTORES_DE_HISTORIA, NO_VA_FUERA_DEL_FOR, comodinDelShell, expandirComodin, interpreteDe, nombreDeComando, programaEscrito, resolveTarget, seguidos, sinRedireccionesDeSalida } = require('./bash-gate-expansions.js');
const { CONTROL, ENVOLTORIOS, MARKER_LEE, VARIABLE_DEL_SHELL, anotarBorradosDeLaStory, anotarEscriturasConsola, destinosArmados, esteGuion, extractWriteTargets, gitQueLee, gitQueNombra, heredocs, opcionesDelInterprete, origenesMovidos, programaDelSistema, sedQueLee, sinContinuaciones, stripNonCommandText, tramos } = require('./bash-gate-targets.js');
const { carpetasDelComando, comandosAnidados, comandosPorOtroPrograma, deshacenEnBloque, destinosBorrados, guionesDeShellEscritos, sinCuerposDeTexto } = require('./bash-gate-commands.js');

// programas que no corren sus argumentos: un guion que aparece entre ellos se lee o se nombra, no se ejecuta. Son los
// lectores y vecinos que el freno ya conoce (LEE_ARCHIVOS, VECINOS, sin los intérpretes ni `cd`) más estos
const NO_CORRE_PROPIOS = ['rg', 'file', 'du', 'cp', 'mv', 'rm', 'ln', 'mkdir', 'touch', 'chmod', 'cmp', 'less', 'readlink',
  'shasum', 'sha1sum', 'sha256sum', 'md5', 'md5sum', 'xxd', 'tar', 'zip', 'rsync', 'scp', 'eslint', 'prettier', 'tsc',
  'black', 'ruff', 'flake8', 'mypy'];
const noCorreSusArgumentos = (programa) => !CORRE_ARCHIVO.test(programa) && programa !== 'cd'
  && (NO_CORRE_PROPIOS.includes(programa) || LEE_ARCHIVOS.has(programa) || VECINOS.has(programa));

/**
 * El peor caso: en un tramo con algo que el freno no puede leer (una variable sin valor conocido, `$(…)`, `eval`), cada
 * guion que aparece después se mira como si corriera, con el intérprete de su extensión. No hace falta saber dónde
 * está el programa ni qué lanzador lo antecede: `$N x.js`, `timeout -s KILL 9 $N x.js`, `if $N x.js` o `xargs $N` frenan
 * igual que con `node` escrito. Sólo queda afuera un tramo cuyo programa escrito no corre sus argumentos
 * (`git diff $(…) -- x.js`, `wc -l $F x.js`). Detrás de `xargs` el guion llega por la entrada: cuenta el de cualquier
 * parte del comando. `todas` da las palabras de todo el comando (se arman sólo si hacen falta).
 * `[{ interprete, valor, argv }]`.
 */
function guionesDelPeorCaso(cmd, crudas, todas, escrito) {
  const i0 = crudas.findIndex((w) => !ANTES_DEL_PROGRAMA.test(w) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  if (i0 < 0) return [];
  if (!escrito.ilegible && noCorreSusArgumentos(escrito.programa)) return [];
  const deGuion = (w) => { const v = palabraExpandida(cmd, w); return [v, Object.keys(EXTENSION_DE).find((f) => EXTENSION_DE[f].test(v))]; };
  const out = [];
  let ilegible = -1;
  for (let j = i0; j < crudas.length; j++) {
    const w = crudas[j];
    if (/^(?:\d|&)?[<>|]/.test(w)) break;
    if (noSeLeeElPrograma(cmd, w)) { if (ilegible < 0) ilegible = j; continue; }
    if (ilegible < 0 || w.startsWith('-')) continue;
    const [valor, familia] = deGuion(w);
    if (familia) out.push({ interprete: INTERPRETE_DE[familia], valor, argv: crudas.slice(j + 1) });
  }
  if (ilegible >= 0 && !out.length && crudas.slice(0, ilegible).some((w) => nombreDeComando(w) === 'xargs')) {
    for (const w of todas()) {
      const [valor, familia] = deGuion(w);
      if (familia) out.push({ interprete: INTERPRETE_DE[familia], valor, argv: [] });
    }
  }
  return out;
}

/**
 * Los guiones que el comando corre desde un archivo (`python3 p.py a`, `time node p.js`, `./x.py`, `python3 -m x`,
 * `node -r ./p.js`), leídos: `[{ interprete, archivo, texto, argv, grande }]`. El intérprete se busca en cualquier
 * palabra del tramo, detrás de cualquier envoltorio (`time`, `sudo -u x`, `nice -10`, `if … then`, `xargs`); el guion
 * es la primera palabra después de sus opciones que existe, desde cada carpeta donde puede estar parado el comando, o
 * que escribe un heredoc del mismo comando. Se lee de su ruta real, la misma que corre el intérprete, y con él los
 * módulos locales que importa. Un guion de la instalación del arnés no cuenta, por la ruta real ya resuelta: el
 * orquestador escribe historias. Un guion que un tramo sólo nombra tampoco (`tramoQueSoloNombra`).
 */
// el comienzo de un archivo, sin leerlo entero: un ejecutable puede ser enorme y su línea `#!` no pide más
function comienzoDe(real, bytes) {
  const fd = fs.openSync(real, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, bytes, 0));
  } finally { fs.closeSync(fd); }
}

/**
 * Las suites que nombra un comodín de `node --test` desde `base`. Con comodín sólo en el último tramo (`dir/*.test.js`,
 * lo común) se lista la carpeta hasta SUITES_DEL_COMODIN archivos; si no, lo que da `expandirComodin`. Un `null` en la
 * lista dice que quedaron archivos sin mirar.
 */
const SUITES_DEL_COMODIN = 5000;
// una variable dentro de una ruta: `$f`, `${f}`
const VARIABLE_EN_RUTA = /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g;
const FOR_CON_LISTA = /(?:^|[\s;&|(])for[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+in[ \t]+([^;\n]*?)[ \t]*(?:;|\n)[ \t\n]*do(?=[\s;])/g;

/**
 * Lo que puede valer la variable de un guion en una ruta (`t/$f.test.js`): con la lista de su `for` a la vista, la
 * ruta con cada palabra de la lista; si no (un `while read`, una lista con `$(…)`, varias variables, un `${f%x}`), la
 * ruta con un comodín en lugar de la variable. Las comillas del medio (`t/"$f"`) no cuentan.
 */
function valoresDeLaVariable(cmd, valor) {
  const v = String(valor).replace(/["']/g, '');
  const usadas = [...v.matchAll(VARIABLE_EN_RUTA)].map((m) => m[0]);
  const nombre = usadas.length === 1 ? (/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(usadas[0]) || [])[1] : null;
  if (nombre) {
    const listas = [...String(cmd).matchAll(FOR_CON_LISTA)].filter((m) => m[1] === nombre).map((m) => m[2]);
    const lista = listas.length === 1 ? palabras(listas[0]).map(sinGrupo).filter(Boolean) : null;
    if (lista && lista.length && lista.length <= 200 && lista.every((w) => !/[$`]/.test(w))) {
      return lista.map((w) => v.replace(usadas[0], w.replace(/^"([^"]*)"$|^'([^']*)'$/, (_, a, b) => (a !== undefined ? a : b))));
    }
  }
  const conComodin = v.replace(VARIABLE_EN_RUTA, '*');
  return /[^*]/.test(conComodin) ? [conComodin] : [];
}
function suitesDelComodin(patron, base) {
  const absoluto = path.isAbsolute(patron) ? patron : path.join(base, patron);
  const dir = path.dirname(absoluto);
  const ultimo = path.basename(absoluto);
  if (!/[*?[]/.test(dir)) {
    let nombres;
    try { nombres = fs.readdirSync(dir); } catch { return []; }
    const re = comodinDelShell(ultimo);
    const out = nombres.filter((n) => re.test(n) && (!n.startsWith('.') || /^\\?\./.test(ultimo))).map((n) => path.join(dir, n));
    return out.length > SUITES_DEL_COMODIN ? [...out.slice(0, SUITES_DEL_COMODIN), null] : out;
  }
  const aviso = {};
  const out = expandirComodin(patron, base, aviso);
  return aviso.recortado ? [...out, null] : out;
}

function guionesEnArchivo(cmd, bases, instalados = [], topeDeLectura = RECORRIDO_BYTES) {
  const out = [];
  const vistos = new Set();
  const escritos = heredocs(cmd).filter((h) => h.target);
  const todosLosTramos = comandosAnidados(sinContinuaciones(cmd)).flatMap((sub) => tramos(sub));
  const palabrasDe = (tramo) => palabras(tramo.trim().replace(PREFIJO, '')).map(sinGrupo).filter((w) => w !== '');
  // las palabras de todo el comando, armadas una vez: pedirlas en cada tramo crece con el cuadrado de los tramos (una
  // tira de miles de tuberías tardaba segundos)
  let todas = null;
  const todasLasPalabras = () => todas || (todas = todosLosTramos.flatMap(palabrasDe));
  // la ruta real del guion tal como la abre el intérprete: unida a la carpeta sin normalizar, para que `enlace/..` se
  // resuelva por donde lleva el enlace y no por el texto (la versión nativa: la otra normaliza el `..` antes)
  const rutaReal = rutaRealDelGuion;
  // lo que git contestó, por esta llamada: un módulo que importan varios se pregunta una vez
  const memo = { porRuta: new Map() };
  const instalado = (real) => instalados.some((r) => isInsideReal(r, real)) || versionadoEnElArbolPropio(real, memo);
  // cada archivo se lee una vez, y entre todos no pasan del tope: el que lo pasaría no se lee, y desde ahí no se lee
  // más. Lo que falta cuenta como un guion que no se pudo leer
  const lecturas = new Map();
  let gastado = 0;
  let agotado = false;
  const sinLugar = (real) => {
    if (!agotado) out.push({ interprete: '', archivo: real, texto: '', argv: [], grande: true });
    agotado = true;
    return { texto: '', grande: true };
  };
  const leerDelDisco = (real) => {
    try {
      const st = fs.statSync(real);
      if (!st.isFile()) return null;
      if (st.size > GUION_TOPE_DURO) return { texto: '', grande: true };
      const costo = Math.max(st.size, 4096);
      if (agotado || gastado + costo > topeDeLectura) return sinLugar(real);
      gastado += costo;
      const texto = fs.readFileSync(real, 'utf8').replace(/\u0000/g, ' ');
      return { texto, grande: st.size > GUION_TOPE };
    } catch { return null; }
  };
  const leer = (real) => {
    if (!lecturas.has(real)) lecturas.set(real, leerDelDisco(real));
    return lecturas.get(real);
  };
  // el guion y los módulos locales que importa, hasta RECORRIDO_NIVELES niveles y RECORRIDO_ARCHIVOS archivos; uno del
  // arnés no se revisa, pero lo que importa pasa la misma prueba. El tope es de los módulos, y los del arnés llevan la
  // cuenta aparte: no le comen el lugar a lo que corre después. Un guion nombrado en el comando se mira siempre. Lo que
  // el tope deja afuera cuenta como grande: frena si no se pudo leer, o si escribe y nombra una historia o una constancia.
  // Lo que carga un módulo de afuera también queda afuera, hasta agotarlo (`vistos` termina el recorrido): cortar ahí
  // dejaría pasar al que escribe un nivel más abajo
  const modulos = { exentos: 0, revisados: 0 };
  const afuera = (interprete, real, leido, argv) => {
    const pendientes = [];
    const anotar = (archivo, l) => {
      vistos.add(archivo);
      if (!instalado(archivo)) out.push({ interprete, archivo, texto: l ? l.texto : '', argv, grande: true });
      if (l) pendientes.push([archivo, l]);
    };
    if (!vistos.has(real)) anotar(real, leido);
    while (pendientes.length) {
      const [archivo, l] = pendientes.pop();
      for (const m of importsLocales(familiaDe(interprete), l.texto, path.dirname(archivo))) {
        const r = rutaReal(m, path.dirname(archivo));
        if (r && !vistos.has(r)) anotar(r, leer(r));
      }
    }
  };
  // lo anotado de cada guion: si vuelve a correr con otros argumentos (`node t.js; node t.js <historia>`, o abierto
  // antes sin argumentos como candidato de un bucle), se anota otra vez con ellos para la prueba de los argumentos
  const anotados = new Map();
  const agregar = (interprete, real, leido, argv, hondo = 0, exento = false) => {
    if (vistos.has(real)) {
      const antes = anotados.get(real);
      if (hondo === 0 && antes && argv.length && argv.join('\0') !== antes.argv.join('\0')) out.push({ ...antes, interprete, argv });
      return;
    }
    const cuenta = exento ? 'exentos' : 'revisados';
    if (hondo > 0 && modulos[cuenta]++ >= RECORRIDO_ARCHIVOS) { afuera(interprete, real, leido, argv); return; }
    vistos.add(real);
    // uno grande de otra copia del arnés con los mismos bytes que main en la misma ruta es lo revisado: no frena por
    // tamaño, pero sigue la prueba de las historias entre sus argumentos, y lo que importa se mira igual
    const revisado = !exento && leido.grande && igualAMainDelArbolPropio(real, memo);
    if (!exento) {
      const entrada = { interprete, archivo: real, texto: leido.texto, argv, grande: leido.grande && !revisado, revisado };
      out.push(entrada);
      anotados.set(real, entrada);
    }
    if (leido.grande && !exento && !revisado) return;
    for (const m of importsLocales(familiaDe(interprete), leido.texto, path.dirname(real))) {
      const r = rutaReal(m, path.dirname(real));
      if (!r) continue;
      const l = leer(r);
      if (hondo >= RECORRIDO_NIVELES) { afuera(interprete, r, l, argv); continue; }
      if (l) agregar(interprete, r, l, argv, hondo + 1, instalado(r));
    }
  };
  // un guion nombrado: su archivo, la carpeta (`__main__.py`, `index.js`) o el heredoc que lo escribe
  const abrir = (interprete, valor, argv) => {
    for (const base of bases) {
      let real = rutaReal(valor, base);
      if (real && fs.statSync(real).isDirectory()) {
        real = rutaReal(familiaDe(interprete) === 'python' ? '__main__.py' : 'index.js', real);
        if (!real) return false;
      }
      if (real) {
        const leido = leer(real);
        if (!leido) { if (instalado(real)) return true; continue; }
        agregar(interprete, real, leido, argv, 0, instalado(real));
        return true;
      }
      const abs = resolveTarget(valor, base, process.platform, { homeVariable: true });
      const h = escritos.find((x) => resolveTarget(expandirRuta(cmd, x.target).valor, base, process.platform, { homeVariable: true }) === abs);
      if (h) { agregar(interprete, abs, { texto: h.body.replace(/\u0000/g, ' '), grande: false }, argv); return true; }
    }
    return false;
  };
  const argumentos = (ws) => ws.filter((w) => !/^(?:\d|&)?[<>]/.test(w)).map((w) => expandirRuta(cmd, w).valor);
  // el `pipeline.js` o el `marker.js` de la instalación, desde cada carpeta donde puede estar parado el comando
  const esGuionInstalado = (valor, nombre) => {
    const reales = bases.map((b) => rutaReal(valor, b)).filter(Boolean);
    return reales.length > 0 && reales.every((r) => path.basename(r) === nombre && instalado(r));
  };
  // las palabras del tramo sin sus redirecciones de salida y de entrada, si lo de antes de `desde` queda igual
  const sinRedirecciones = (tramo, words, desde) => {
    const texto = sinRedireccionesDeSalida(tramo).replace(/(?:(?<![^\s])\d+)?(?<!\\)<(?![<(])[ \t]*(?:'[^']*'|"[^"]*"|[^\s'"|;&<>]+)?/g, ' ');
    const otras = palabrasDe(texto);
    return otras.slice(0, desde).join('\0') === words.slice(0, desde).join('\0') ? otras : words;
  };
  const noTocaElShell = comandoNoTocaElShell(cmd);
  for (const tramo of todosLosTramos) {
    const words = palabrasDe(tramo);
    const soloNombra = noTocaElShell && tramoQueSoloNombra(cmd, tramo, esGuionInstalado);
    // el ejecutable directo con su línea `#!` (`./x.py`, `bin/x`), también en una variable (`G=./x.py; "$G"`)
    for (let k = 0; k < words.length && !soloNombra; k++) {
      const valor = expandirRuta(cmd, words[k]).valor;
      if (!String(valor).includes('/')) continue;
      for (const base of bases) {
        const real = rutaReal(valor, base);
        if (!real) continue;
        try {
          const st = fs.statSync(real);
          if (!st.isFile() || !(st.mode & 0o111)) break;
          const linea = comienzoDe(real, 200).split('\n')[0];
          // `#!/usr/bin/python3` · `#!/usr/bin/env -S python3 -u`: con `env`, el intérprete es su primera palabra
          const partes = linea.startsWith('#!') ? linea.slice(2).trim().split(/\s+/) : [];
          const interprete = nombreDeComando(partes[0]) === 'env'
            ? nombreDeComando(partes.slice(1).find((x) => !x.startsWith('-') && !x.includes('=')))
            : nombreDeComando(partes[0]);
          if (interprete && CORRE_ARCHIVO.test(interprete)) {
            const leido = leer(real);
            if (leido) agregar(interprete, real, leido, argumentos(words.slice(k + 1)), 0, instalado(real));
          }
        } catch (e) {   // no se lee: no es un guion. Lo que no es «no existe» o «es una carpeta» queda dicho
          if (!['ENOENT', 'ENOTDIR', 'EISDIR'].includes(e && e.code)) logHookError(e);
        }
        break;
      }
    }
    // lo que el freno no puede leer (un programa en una variable sin valor conocido, `$(…)`, `eval`): el peor caso, cada
    // guion que sigue se mira como si corriera. Sobre las palabras del tramo sin recortar
    const escrito = programaEscrito(cmd, tramo);
    if (!soloNombra) {
      const crudas = palabras(tramo.trim()).map(sinGrupo).filter((w) => w !== '');
      for (const g of guionesDelPeorCaso(cmd, crudas, todasLasPalabras, escrito)) abrir(g.interprete, g.valor, argumentos(g.argv));
    }
    // en un tramo de un programa que no corre sus argumentos, una variable con valor conocido es un argumento más
    const lector = !escrito.ilegible && noCorreSusArgumentos(escrito.programa);
    // de un tramo que sólo nombra, el intérprete es la primera palabra: `grep node x` o un archivo `node` de la lista no lo son
    for (let k = 0; k < (soloNombra ? 1 : words.length); k++) {
      const interprete = lector ? nombreDeComando(words[k]) : interpreteDe(cmd, words[k]);
      if (!CORRE_ARCHIVO.test(interprete)) continue;
      const familia = familiaDe(interprete);
      let i = k + 1;
      if (/^(?:bun|deno)$/.test(interprete) && words[i] === 'run') i++;
      const op = opcionesDelInterprete(familia, words, i);
      for (const p of op.precargas) abrir(interprete, p, []);
      for (const m of op.modulos) {
        const rel = m.replace(/\./g, '/');
        if (!abrir(interprete, `${rel}.py`, argumentos(words.slice(op.desde)))) abrir(interprete, `${rel}/__main__.py`, argumentos(words.slice(op.desde)));
      }
      if (op.enLinea || op.modulos.length) continue;
      // con `node --test`, cada archivo nombrado es una suite que corre: se abren todos, no sólo el primero (una suite
      // chica delante no esconde a la que sigue), también detrás de un `-` y los que nombran llaves y comodines. Un
      // comodín con más archivos de los que se miran cuenta como un guion que no se pudo leer
      let hallado = false;
      const porVariable = [];
      // en modo pruebas, sin las redirecciones: su destino (`> salida.txt`) no es una suite
      const lista = op.pruebas ? sinRedirecciones(tramo, words, op.desde) : words;
      for (let j = op.desde; j < lista.length && (!hallado || op.pruebas); j++) {
        const w = lista[j];
        if (w === '-' || /^\/dev\/(?:stdin|fd\/0)$/.test(w) || /^(?:\d|&)?[<>]/.test(w)) { if (op.pruebas) continue; break; }
        const valor = palabraExpandida(cmd, w);
        if (expandirRuta(cmd, w).sinResolver.length) {
          porVariable.push(String(valor));
          // `t/"$f"` llega partido en `t/` y `$f`: la ruta es la de las dos juntas
          if (j > op.desde && /\/$/.test(lista[j - 1])) porVariable.push(`${palabraExpandida(cmd, lista[j - 1])}${valor}`);
        }
        if (!op.pruebas) { hallado = abrir(interprete, valor, argumentos(words.slice(j + 1))); continue; }
        for (const x of expandirLlaves(String(valor))) {
          // también la ruta tal cual: un `[id]` puede ser parte del nombre
          if (abrir(interprete, x, argumentos(lista.slice(j + 1)))) hallado = true;
          if (!/[*?[]/.test(x)) continue;
          for (const base of bases) for (const f of suitesDelComodin(x, base)) {
            if (f === null) out.push({ interprete, archivo: path.join(base, x), texto: '', argv: [], grande: true });
            else if (abrir(interprete, f, [])) hallado = true;
          }
        }
      }
      // el guion en una variable que no se resuelve (la de un `for f in …`, la de un `while read f`, también de fondo):
      // cuenta cada archivo del comando con la extensión del intérprete, y la ruta con la variable cambiada por cada
      // palabra de la lista de su `for` (se abre aunque no tenga extensión: el intérprete la corre igual) o, si la
      // lista no se ve, por un comodín (`scripts/tests/$f`)
      if (porVariable.length) {
        const valores = porVariable.flatMap((v) => valoresDeLaVariable(cmd, v));
        for (const v of valores) if (!/[*?[]/.test(v)) abrir(interprete, v, []);
        const conComodin = valores.filter((v) => /\*/.test(v)).map((v) => (EXTENSION_DE[familia].test(v) ? v : `${v}*`));
        const candidatos = [...todasLasPalabras().map((x) => palabraExpandida(cmd, x)), ...conComodin];
        for (const c of candidatos) for (const x of expandirLlaves(String(c))) {
          if (!/[*?[]/.test(x)) { if (EXTENSION_DE[familia].test(x)) abrir(interprete, x, []); continue; }
          for (const base of bases) for (const f of suitesDelComodin(x, base)) {
            if (f === null) out.push({ interprete, archivo: path.join(base, x), texto: '', argv: [], grande: true });
            else if (EXTENSION_DE[familia].test(f)) abrir(interprete, f, []);
          }
        }
      }
      // `echo p.py | xargs python3`: el guion llega por la entrada; cuenta cada archivo del comando con su extensión
      if ((!hallado || op.pruebas) && words.slice(0, k).some((w) => nombreDeComando(w) === 'xargs')) {
        for (const w of todasLasPalabras()) if (EXTENSION_DE[familia].test(w)) abrir(interprete, expandirRuta(cmd, w).valor, []);
      }
    }
  }
  return out;
}

/**
 * Las palabras de los bucles del comando, si lo de afuera sólo lee: cada tubería que nombra una historia está hecha de
 * lectores y afuera no corre un shell. null si no se puede afirmar: entonces cuentan todas las palabras. Un `pipeline.js`
 * es lector sólo si es el instalado y sus opciones no piden otra cosa (`tramoQueSoloNombra`).
 */
function palabrasDelBucleSiFueraSoloSeLee(cmd, bases, instalados) {
  const { tramos: lista, subs, abierta, conParentesis } = require('./marker-command.js').tramos(String(cmd), 'bash');
  if (abierta || conParentesis || subs.length || lista.some((t) => t.heredocs.length)) return null;
  const delBucle = [];
  const fuera = [];
  let hondo = 0;
  let recienCerrado = false;
  for (const t of lista) {
    const w = t.palabras.map((p) => p.texto);
    const abreBucle = ['for', 'while', 'until'].includes(w[0]);
    if (t.tras === '|' && (recienCerrado || abreBucle)) return null;
    recienCerrado = false;
    if (abreBucle) hondo++;
    if (hondo > 0) {
      delBucle.push(...w);
      if (w[0] === 'done') { hondo--; recienCerrado = true; }
      continue;
    }
    if (w[0] === 'done' || w[0] === 'do') return null;
    fuera.push(t);
  }
  if (hondo !== 0) return null;
  const memo = { porRuta: new Map() };
  const esGuionInstalado = (valor, nombre) => {
    const reales = bases.map((b) => rutaRealDelGuion(valor, b)).filter(Boolean);
    return reales.length > 0 && reales.every((r) => path.basename(r) === nombre
      && (instalados.some((x) => isInsideReal(x, r)) || versionadoEnElArbolPropio(r, memo)));
  };
  const lee = (t) => {
    const w = t.palabras.map((p) => p.texto);
    if (w.some((x) => /[<>]/.test(x))) return false;
    if (LECTORES_DE_HISTORIA.has(w[0])) return true;
    if (!/^node(?:js)?$/.test(nombreDeComando(w[0])) || !w[1]) return false;
    if (PIPELINE_LEE.has(w[2]) && w.slice(3).every((x) => !x.startsWith('--output'))
      && esGuionInstalado(expandirRuta(cmd, w[1]).valor, 'pipeline.js')) return true;
    return tramoQueSoloNombra(cmd, w.map((x) => (/\s/.test(x) ? `'${x.replace(/'/g, '')}'` : x)).join(' '), esGuionInstalado);
  };
  const cadenas = [];
  for (const t of fuera) {
    if (t.tras === '|' && cadenas.length) cadenas[cadenas.length - 1].push(t);
    else cadenas.push([t]);
    const w = t.palabras.map((p) => p.texto);
    if (NO_VA_FUERA_DEL_FOR.has(path.basename(w[0] || '')) || w.includes('for')) return null;
    if (!lee(t) && t.palabras.some((p) => !p.literal)) return null;
  }
  const nombra = (t) => t.palabras.some((p) => NOMBRA_RUTA_DE_HISTORIA.test(p.texto));
  return cadenas.every((c) => !c.some(nombra) || c.every(lee)) ? delBucle : null;
}

/**
 * Las historias que el comando puede escribir: sus destinos de escritura, el destino de un guion que sale de una ruta
 * literal (`const f='…'`) y, con un editor en el lugar o un `for` que escribe, cada palabra y cada comodín que nombra
 * (`ls … | xargs sed -i`, `find specs -name '*.md' -exec sed -i`). Se resuelven desde la carpeta de la sesión, cada `cd`
 * y cada carpeta de un `find`. Desde un comando no se ve qué queda escrito: la historia se edita con Edit/Write y el
 * estado lo cambia marker.js. Un borrador pasa sólo si el comando lo reescribe entero con un heredoc legible que lo
 * deja en borrador (ahí lo juzga el freno de la historia sin validar); escribirle encima de otra forma podría cerrarla.
 */
/**
 * Lo que escribe en el estado del pipeline una orden que corre adentro de otro programa: el cuerpo de un `sh -c`, de un
 * `eval` o de un `su -c`, la orden de un `xargs`, de un `find -exec` o de un `parallel`, y un guion de shell escrito por
 * un heredoc del mismo comando. Cada una se mira como un comando, un nivel, con la misma lectura que las historias. El
 * primer destino que cae en el estado, o null; lo escrito a la vista lo mira el portón de carril.
 */
function estadoPorOtroPrograma(cmd, cwd, sesion, enElEstado) {
  const porOtro = [...guionesDeShellEscritos(cmd, [...new Set([cwd, sesion])]), ...comandosPorOtroPrograma(cmd, cwd)];
  const adentro = [cmd, ...porOtro].flatMap((t) => comandosAnidados(sinCuerposDeTexto(t)).slice(1));
  for (const texto of new Set([...porOtro, ...adentro])) {
    for (const d of destinosResueltos(texto, cwd, process.platform, { keep: () => true })) if (enElEstado(d.abs)) return d.abs;
  }
  return null;
}

/**
 * Los archivos que tocaría lo que `deshacenEnBloque` leyó, corrido en `dir`, preguntándole a git o a `find` sin cambiar
 * nada: `{ archivos: [{ abs, kind, conocidos? }] }` o `{ error }`. El reset (y el cambio de rama forzado) y el stash
 * deshacen lo seguido que difiere (`restore`); el stash con `-u` o `-a`, `git clean` y `find -delete` borran (`delete`).
 * `conocidos` dice si git sigue el archivo (`[abs]`) o no (`[]`), para no preguntarlo de a uno. Al ensayar, `git clean`
 * lleva sólo las opciones que eligen qué borrar, y `find` cambia cada `-delete` por `-print0` y no corre si su expresión
 * hace otra cosa (`-exec`, `-ok`, `-fprint`, `-fls`) o tiene algo que el shell expande: entonces cuenta la carpeta entera.
 * La configuración del repo no corre programas acá, y la salida se lee en inglés y sin comillas.
 */
function loQueDeshaceEnBloque(b, dir) {
  // sin las variables de git del proceso padre (un gancho de git las deja puestas) y en inglés, para leer la salida.
  // Sin la biblioteca (las skills en un clon aparte, sin scripts/), a git no se le pregunta: lo que deshace en bloque
  // cuenta como «no pude preguntar» y frena; find corre igual
  let env = null;
  try { const cge = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'clean-git-env.js')); env = cge.idiomaFijo(cge.sinGitDelPadre()); } catch (_) { env = null; }
  const correr = (prog, args, cwd = dir) => {
    if (prog === 'git' && !env) throw new Error('falta la biblioteca de git del arnés (scripts/lib/clean-git-env.js)');
    const r = require('child_process').spawnSync(prog, args, { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, ...(env ? { env } : {}), maxBuffer: 32 * 1024 * 1024 });
    if (r.error || r.status !== 0) throw new Error((r.error && (r.error.code || r.error.message)) || String(r.stderr || '').trim().split('\n')[0] || `${prog} salió ${r.status}`);
    return String(r.stdout);
  };
  const gitDir = b.gitDir ? ['--git-dir', path.resolve(dir, b.gitDir), '--work-tree', dir] : [];
  const git = (args) => correr('git', ['-C', dir, ...gitDir, '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', ...args]);
  try {
    if (b.op === 'find') {
      // otra acción (que corre, escribe o imprime algo más) o algo que expande el shell: no se ensaya
      const peligro = (w) => /^-(?:exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls|print|print0|printf|ls|quit)$/.test(w) || /[$`{~]/.test(w);
      if (b.expresion.some(peligro) || b.desde.some(peligro)) throw new Error('la expresión de find no se puede ensayar');
      // `-delete` lleva `-depth`, que hace que `-prune` no pode: el ensayo también
      const salida = correr('find', [...b.opciones, ...b.desde, '-depth', ...b.expresion.map((w) => (w === '-delete' ? '-print0' : w))]);
      // por ruta real: el repo puede estar detrás de un enlace (en Mac, /tmp y /var lo son)
      const realDe = (p) => { try { return fs.realpathSync(p); } catch (_) { return p; } };
      const archivos = salida.split('\0').filter(Boolean).map((f) => ({ abs: realDe(path.resolve(dir, f)), kind: 'delete' }));
      // qué sigue git, de una vez: la carpeta puede no ser un repo (y entonces nada es código seguido de la corrida)
      let seguidosAca = null;
      try {
        const top = git(['rev-parse', '--show-toplevel']).trim();
        seguidosAca = new Set(git(['ls-files', '-z', '--full-name', ':/']).split('\0').filter(Boolean).map((f) => path.join(top, f)));
      } catch (_) { seguidosAca = null; }
      if (seguidosAca) for (const a of archivos) if (!fs.statSync(a.abs, { throwIfNoEntry: false })?.isDirectory()) a.conocidos = seguidosAca.has(a.abs) ? [a.abs] : [];
      return { archivos };
    }
    const top = git(['rev-parse', '--show-toplevel']).trim();
    const desdeArriba = (s) => s.split('\0').filter(Boolean).map((f) => path.join(top, f));
    if (b.op === 'reset' || b.op === 'stash') {
      const diff = b.op === 'reset' ? ['diff', '--name-only', '-z', '--no-renames', b.ref, '--']
        : ['diff', ...(b.staged ? ['--cached'] : []), '--name-only', '-z', '--no-renames', 'HEAD', '--', ...(b.rutas || [])];
      const archivos = desdeArriba(git(diff)).map((abs) => ({ abs, kind: 'restore', conocidos: [abs] }));
      if (b.op === 'stash' && b.untracked && !b.staged) {
        const donde = b.rutas && b.rutas.length ? b.rutas : [':/'];
        for (const abs of desdeArriba(git(['ls-files', '-z', '--full-name', '--others', '--exclude-standard', '--', ...donde]))) archivos.push({ abs, kind: 'delete', conocidos: [] });
      }
      return { archivos };
    }
    // git clean: el mismo comando en ensayo, sólo con lo que elige qué borrar (`-d`, `-x`, `-X`, `-e`, las rutas)
    const args = [];
    let rutas = false;
    for (let i = 0; i < b.args.length; i++) {
      const w = b.args[i];
      if (rutas || w === '--') { if (w === '--') rutas = true; args.push(w); continue; }
      if (w === '-e' || w === '--exclude') { args.push('-e', b.args[i + 1]); i++; continue; }
      if (/^--exclude=/.test(w)) { args.push(w); continue; }
      if (w.startsWith('--')) continue;
      if (/^-[a-zA-Z]/.test(w)) {
        const [letras, ...patron] = w.slice(1).split('e');
        const quedan = letras.replace(/[^dxX]/g, '');
        if (quedan) args.push(`-${quedan}`);
        if (patron.length) { const valor = patron.join('e'); if (valor) args.push('-e', valor); else { args.push('-e', b.args[i + 1]); i++; } }
        continue;
      }
      args.push(w);
    }
    const salida = git(['clean', '-n', ...args]);
    const archivos = salida.split('\n').map((l) => /^Would remove (.+)$/.exec(l)).filter(Boolean)
      .map((m) => ({ abs: path.join(dir, m[1]), kind: 'delete', ...(m[1].endsWith('/') ? {} : { conocidos: [] }) }));
    return { archivos };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Con el pipeline abierto: borrar o deshacer código del repo de la corrida, o escribir desde un intérprete en un destino
 * que no es una ruta literal, frenan como edición invisible. Lo borrado que pasa (node_modules, un archivo que git no
 * sigue) queda en `console-writes` con `kind: "delete"`, para el control al cerrar; si el comando frena, no corre y no se
 * anota nada.
 */
function frenoBorrarYArmados({ cmd, cwd, stateDir, sessionId, io, isInside, via, codex = false }) {
  const borrados = destinosBorrados(cmd).map((d) => {
    const base = d.base ? resolveTarget(expandirRuta(cmd, d.base).valor, cwd, process.platform, { homeVariable: true }) : cwd;
    return { ...d, abs: resolveTarget(expandirRuta(cmd, d.raw).valor, base, process.platform, { homeVariable: true }) };
  }).filter((d) => !d.quizas || fs.existsSync(d.abs));
  const enBloque = deshacenEnBloque(cmd);
  const todosLosArmados = destinosArmados(cmd);
  if (!borrados.length && !todosLosArmados.length && !enBloque.length) return null;
  const lv = require('./ledger-visible.js');
  const marker = io.readMarker(stateDir, sessionId);
  if (!lv.pipelineAbierto(marker) || !marker.repoPath) return null;
  const repo = marker.repoPath;
  // lo que se deshace o borra en bloque, archivo por archivo, como si el comando los nombrara; sin poder preguntarle a
  // git, del lado seguro
  const sinPreguntar = [];
  for (const b of enBloque) {
    const dir = b.base ? resolveTarget(expandirRuta(cmd, b.base).valor, cwd, process.platform, { homeVariable: true }) : cwd;
    const r = loQueDeshaceEnBloque(b, dir);
    if (r.error && b.op === 'find') {
      // sin poder ensayarlo, cuenta cada carpeta donde arranca, como un `rm -r`
      for (const raw of b.desde) borrados.push({ raw, kind: 'delete', abs: resolveTarget(expandirRuta(cmd, raw).valor, dir, process.platform, { homeVariable: true }) });
      continue;
    }
    if (r.error) { sinPreguntar.push({ dir, op: b.op, error: r.error }); continue; }
    for (const f of r.archivos) borrados.push({ raw: f.abs, abs: f.abs, kind: f.kind, ...(f.conocidos ? { conocidos: f.conocidos } : {}) });
  }
  // por ruta real también: `/var` y `/private/var` (o un enlace en el medio) son el mismo repo
  const real = (p) => {
    try { return fs.realpathSync(p); } catch (_) { /* no existe: su carpeta */ }
    try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch (_) { return p; }
  };
  const repoReal = real(repo);
  const enElRepo = (abs) => isInside(repo, abs) || isInside(repoReal, real(abs)) || real(abs) === repoReal;
  const esCodigo = (abs) => isCodeFile(abs) || isManifestFile(abs);
  const esDelRegistro = (abs) => enElRepo(abs) && esCodigo(abs);
  // lo que se sabe sin ejecutar: una variable con su ruta literal, un argumento, o una cola con extensión que no es código
  const armados = todosLosArmados.filter((a) => {
    // `'$SP/x.cs'` en un script entre comillas dobles: el shell expande `$SP` antes de correrlo. Si el comando (o el
    // ambiente) la define, es esa ruta
    const entre = /^(['"])(.*)\1$/.exec(a.expr);
    if (entre && /\$/.test(entre[2])) {
      const ex = expandirRuta(cmd, entre[2]);
      if (!ex.sinResolver.length) return esDelRegistro(resolveTarget(ex.valor, cwd, process.platform, { homeVariable: true }));
    }
    if (a.literal) return esDelRegistro(resolveTarget(expandirRuta(cmd, a.literal).valor, cwd, process.platform, { homeVariable: true }));
    if (a.literales) {
      return a.literales.some((l) => {
        const ex = expandirRuta(cmd, l);
        // una variable que nadie define: se juzga por la extensión que se ve (`$SP/x.json` no es código)
        if (ex.sinResolver.length) return !path.extname(l) || esCodigo(l);
        return esDelRegistro(resolveTarget(ex.valor, cwd, process.platform, { homeVariable: true }));
      });
    }
    if (a.ext) return isCodeFile(`x${a.ext}`) || isManifestFile(a.cola);
    return true;
  }).map((a) => a.expr);
  const adentro = borrados.filter((d) => enElRepo(d.abs));
  const deCodigo = [];
  const pasan = [];
  const deLaStory = [];
  let declarados = null;
  // los archivos del repo que la story declara (files_to_create, files_to_modify, files_to_delete), por ruta real. La
  // story puede nombrarlos desde otra raíz (`app/src/a.ts` en un repo de specs): cuenta el final de la ruta, desde una
  // carpeta, y sólo si nombra una carpeta (`a.ts` a secas no dice cuál)
  const nombrados = () => {
    if (declarados) return declarados;
    declarados = new Set();
    let texto = '';
    try { texto = marker.storyPath ? fs.readFileSync(marker.storyPath, 'utf8') : ''; } catch (e) { logHookError(e); return declarados; }
    const ts = require('./test-scope.js');
    const finales = [...ts.parseDeclaredFiles(texto), ...ts.parseFilesToDelete(texto)]
      .map((f) => String(f).replace(/\\/g, '/').replace(/^\.\//, '')).filter((f) => f.includes('/') && !f.split('/').includes('..'));
    for (const d of adentro) {
      const abs = real(d.abs);
      const posix = abs.split(path.sep).join('/');
      const rel = path.relative(repoReal, abs).split(path.sep).join('/');
      // desde una raíz más arriba (`acme-web/src/a.ts`) o desde una carpeta del repo (`app/src/a.ts` con el repo en `app`)
      if (finales.some((f) => posix.endsWith(`/${f}`) || f === rel || (rel.includes('/') && f.endsWith(`/${rel}`)))) declarados.add(abs);
    }
    return declarados;
  };
  for (const d of adentro) {
    // un archivo de código: deshacerlo frena siempre; borrarlo, si git lo sigue (uno de prueba de la sesión pasa).
    // Una carpeta, `.` o un comodín: frena si git sigue código adentro. Sin poder preguntarle a git, del lado seguro.
    // node_modules, dist, bin… (las carpetas que nunca son código de la historia) pasan sin preguntarle a git
    const rel = path.relative(repoReal, real(d.abs)).split(path.sep);
    if (rel.some((seg) => NEVER_CODE_SEGMENTS.has(seg))) { pasan.push(d); continue; }
    // un archivo que no es código (`notas.md`) tampoco: a git se le pregunta por lo que puede tener código adentro
    let esCarpeta = false;
    try { esCarpeta = fs.statSync(d.abs).isDirectory(); } catch (_) { /* no existe: lo decide su forma */ }
    if (!esCodigo(d.abs) && !esCarpeta && !/[*?[]/.test(d.raw) && path.extname(d.abs)) { pasan.push(d); continue; }
    // lo que ya se le preguntó a git de una vez (lo deshecho en bloque) no se pregunta de a uno
    const lista = Array.isArray(d.conocidos) ? d.conocidos : seguidos(repoReal, real(d.abs));
    // un `git rm` de un archivo que la story declara: es parte de la historia, pasa y se anota como tocado
    if (d.git && esCodigo(d.abs) && !esCarpeta && !/[*?[]/.test(d.raw) && lista && lista.length && nombrados().has(real(d.abs))) {
      deLaStory.push(d);
      continue;
    }
    if (esCodigo(d.abs)) {
      if (d.kind === 'restore' || lista === null || lista.length) deCodigo.push(d.abs); else pasan.push(d);
      continue;
    }
    if (lista === null) { deCodigo.push(`${d.abs} (no pude preguntarle a git qué sigue adentro)`); continue; }
    const codigoAdentro = lista.filter(esCodigo);
    if (codigoAdentro.length) deCodigo.push(`${d.abs} (${codigoAdentro.length} archivo(s) de código que git sigue)`);
    else pasan.push(d);
  }
  for (const s of sinPreguntar) {
    if (enElRepo(s.dir)) deCodigo.push(`${s.dir} (no pude preguntarle a git qué deshace \`git ${s.op}\`: ${s.error})`);
  }
  const frena = [...new Set(deCodigo), ...armados.map((e) => `(destino armado) ${e}`)];
  if (!frena.length) {
    anotarEscriturasConsola(stateDir, sessionId, [...pasan.filter((d) => d.kind === 'delete'), ...deLaStory].map((d) => d.abs), 'delete');
    if (deLaStory.length) anotarBorradosDeLaStory({ stateDir, sessionId, marker, rutas: deLaStory.map((d) => d.abs), via });
    return null;
  }
  const linea = (status, extra) => {
    try {
      fs.appendFileSync(path.join(stateDir, 'gates.log'), JSON.stringify({
        ts: new Date().toISOString(), sessionId, repoPath: repo, name: 'ledger-visible', status,
        storyId: marker.storyId || null, files: frena.length, paths: frena, via, ...extra,
      }) + '\n', 'utf8');
    } catch (e) { logHookError(e); }
  };
  if (String(process.env.TYCON_LEDGER_VISIBLE || '').toLowerCase() === 'off') {
    linea('escaped', { reason: 'TYCON_LEDGER_VISIBLE=off en el ambiente de la sesión' });
    anotarEscriturasConsola(stateDir, sessionId, pasan.filter((d) => d.kind === 'delete').map((d) => d.abs), 'delete');
    return null;
  }
  linea('blocked', { forma: deCodigo.length ? 'borrar-o-deshacer' : 'destino-armado' });
  return { block: lv.mensaje(frena, marker.storyId, { borrarODeshacer: deCodigo.length > 0, armado: armados.length > 0, codex }) + '\n' };
}

/** Compat: sólo los cuerpos. */
function heredocBodies(cmd) { return heredocs(cmd).map((h) => h.body); }

/**
 * Los heredocs de un mismo archivo, un cuerpo distinto una sola vez (el mismo cuerpo da el mismo juicio). Con más de
 * `CUERPOS_A_JUZGAR` distintos, los primeros y los últimos: el último es el que queda escrito, el primero el que juzgaba
 * la lectura de antes.
 */
function cuerposDistintos(hs) {
  const vistos = new Set();
  const unicos = hs.filter((h) => !vistos.has(h.body) && vistos.add(h.body));
  const mitad = CUERPOS_A_JUZGAR / 2;
  return unicos.length <= CUERPOS_A_JUZGAR ? unicos : [...unicos.slice(0, mitad), ...unicos.slice(-mitad)];
}

function destinosResueltos(cmd, cwd, platform = process.platform, { keep = null } = {}) {
  return extractWriteTargets(cmd, { keep }).map((raw) => {
    const { valor, sinResolver, temporal } = expandirRuta(cmd, raw);
    return { raw, abs: resolveTarget(valor, cwd, platform, { homeVariable: true }), sinResolver, ...(temporal ? { temporal } : {}) };
  });
}

function renameOrCopyOfExistingStory(cmd, cwd) {
  const seg = splitSegments(stripNonCommandText(cmd)).find((sg) => /^(?:\w+=\S+\s+)*(?:sudo\s+)?(?:cp|mv|git\s+mv)\b/.test(sg.trim()));
  if (!seg) return null;
  const words = (seg.match(new RegExp(Q, 'g')) || []).map((w) => { const mm = w.match(new RegExp(`^${Q}$`)); return mm ? tok(mm, 1) : null; }).filter((w) => w && !w.startsWith('-'));
  if (words.length < 3) return null;
  const abs = (t) => resolveTarget(t, cwd);
  const src = abs(words[words.length - 2]);
  const dest = abs(words[words.length - 1]);
  try {
    const { probeStoryFile } = require('./story-discovery.js');
    return fs.existsSync(src) && probeStoryFile(src) ? { src, dest } : null;
  } catch (e) { logHookError(e); return null; }   // sin mirarla, la copia se juzga como historia nueva
}

/**
 * La puerta entera: primero el código deprecado del repo (on-deprecated-edit.js), que frena por su cuenta y no depende
 * de los demás frenos de esta puerta; después el carril y la historia a mano. Un aviso de lo deprecado viaja como
 * `aviso` si nada frena.
 */
// Con la ejecución perdida, lo único que pasa por la terminal es leer y la salida: cada tramo del comando, un programa de
// esta lista con palabras literales, sin redirecciones, sin `$(…)`, sin heredocs y sin asignaciones delante.
const LEE = new Set(['cat', 'ls', 'grep', 'head', 'tail']);
// Los programas que leen los archivos que reciben y no corren ninguno. Sin `awk`, `rg --pre`, `sort --compress-program`
// ni `open`, que pueden correr lo que se les da; `sed` va aparte (`sedQueLee`). Las listas de `pipeline.js` son las
// mismas que usa el freno de la firma
const LEE_ARCHIVOS = new Set([...LEE, 'wc', 'stat']);
// Lo que puede ir en el mismo comando sin cambiar qué programa corre un nombre: un programa aparte no toca al shell. Lo
// que sí lo toca (`hash -p`, `source`, `export`, un alias, una función) no está, sin hacer falta conocerlo uno por uno
const VECINOS = new Set([...LEE_ARCHIVOS, 'sed', 'git', 'node', 'nodejs', 'cd', 'echo', 'printf', 'pwd', 'true', 'false', 'test', '[',
  'sleep', 'date', 'sort', 'uniq', 'cut', 'tr', 'jq', 'diff', 'tee', 'basename', 'dirname', 'realpath']);
/**
 * ¿Ningún tramo del comando, ni de lo que corre adentro de él, puede cambiar qué programa corre un nombre? Cada uno es un
 * programa de `VECINOS` o una variable suelta que no es del shell. Lee programas, no texto: un `function` o un `f()`
 * entre comillas es lo que se busca, no una función.
 */
function comandoNoTocaElShell(cmd, hondo = 0) {
  const mc = require('./marker-command.js');
  const { tramos: lista, subs, abierta } = mc.tramos(sinRedireccionesDeSalida(cmd), 'bash');
  if (abierta || hondo > 3) return false;
  return subs.every((s) => comandoNoTocaElShell(s, hondo + 1)) && lista.every((t) => {
    const w = t.palabras;
    if (!w.length) return true;
    const asignada = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(w[0].texto);
    if (asignada) return w.length === 1 && !VARIABLE_DEL_SHELL.test(asignada[1]);
    if (!w[0].literal || !programaDelSistema(w[0].texto)) return false;
    const prog = nombreDeComando(w[0].texto);
    return VECINOS.has(prog) && !(prog === 'printf' && w[1] && w[1].texto === '-v');
  });
}

/**
 * ¿El tramo nombra guiones sin correrlos? Sí, si su programa sólo lee sus archivos o es un comando de sólo lectura del
 * `pipeline.js` instalado, solo o como lo corre el `marker.js run-check <paso> --` instalado: la lista es de lo que no
 * corre, y lo que no está en ella cuenta, sin hacer falta conocer cada envoltura (`stdbuf`, `flock`, `caffeinate`). El
 * tramo se lee como lo lee el shell (lib/marker-command.js): si ahí hay más de uno (`&`, paréntesis), o un comando adentro,
 * no se exime. Se pregunta sólo si el comando entero no puede cambiar qué programa corre ese nombre (`comandoNoTocaElShell`).
 */
function tramoQueSoloNombra(cmd, tramo, esGuionInstalado) {
  const mc = require('./marker-command.js');
  // sin las redirecciones de salida: el `&` de `2>&1` no empieza otro tramo, y lo que escriben lo miran los demás frenos
  const texto = sinRedireccionesDeSalida(tramo);
  const { tramos: lista, subs, abierta } = mc.tramos(texto, 'bash');
  if (subs.length || abierta || lista.length !== 1) return false;
  const w = lista[0].palabras;
  if (!w.length) return false;
  const prog = nombreDeComando(w[0].texto);
  if (LEE_ARCHIVOS.has(prog) || (prog === 'sed' && sedQueLee(w)) || (prog === 'git' && gitQueNombra(w))) return true;
  if (prog !== 'node' && prog !== 'nodejs') return false;
  // `node marker.js run-check <paso> -- node pipeline.js …`: lo que se mira es lo que va detrás del `--`
  const envuelto = w.length > 5 && w[2].texto === 'run-check' && w[3].literal && w[4].texto === '--';
  if (envuelto && !esGuionInstalado(expandirRuta(cmd, w[1].texto).valor, 'marker.js')) return false;
  const p = envuelto ? w.slice(5) : w;
  if (envuelto && !/^node(?:js)?$/.test(nombreDeComando(p[0].texto))) return false;
  const llamadas = mc.llamadas(envuelto ? p.map((x) => (/\s/.test(x.texto) ? `'${x.texto.replace(/'/g, '')}'` : x.texto)).join(' ') : texto, { shell: 'bash' });
  const l = llamadas[0];
  if (llamadas.length !== 1 || l.guion !== 'pipeline' || !PIPELINE_LISTA.has(l.sub) || !p[2] || p[2].texto !== l.sub) return false;
  // las banderas se leen como las lee el freno de firmas: una que no se ve puede ser la que pide una firma. La vuelta
  // extra escrita tal cual sí se exime (su firma la pide el freno de firmas, aparte); la que llega por una variable o
  // por lo que no se ve, no
  const sinLaVueltaALaVista = { ...l, args: (l.args || []).filter((a) => !(a.literal && a.texto === '--extra-round')) };
  if (l.envFile || l.porXargs || mc.escapeDe(l, null) || mc.lectorDeBanderas(sinLaVueltaALaVista)('--extra-round')) return false;
  // una variable que no se sabe queda escrita en la ruta, y esa ruta no existe
  return esGuionInstalado(expandirRuta(cmd, p[1].texto).valor, 'pipeline.js');
}

function soloLee(cmd, shell, cwd) {
  const { tramos, subs, abierta } = require('./marker-command.js').tramos(String(cmd), shell);
  if (subs.length || abierta || !tramos.length) return false;
  return tramos.every((t) => {
    const w = t.palabras;
    if ((t.heredocs && t.heredocs.length) || !w.length) return false;
    if (w.some((x) => !x.literal || /[<>]/.test(x.texto))) return false;
    if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(w[0].texto)) return false;
    if (!programaDelSistema(w[0].texto)) return false;
    const prog = path.basename(w[0].texto.replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
    if (LEE.has(prog)) return true;
    if (prog === 'git') return gitQueLee(w);
    if (prog !== 'node' && prog !== 'nodejs') return false;
    const guion = w[1] ? path.basename(w[1].texto.replace(/\\/g, '/')).toLowerCase() : '';
    // el nombre no alcanza: un marker.js cualquiera podría escribir; vale sólo el guion de esta misma carpeta
    if (!esteGuion(w[1] && w[1].texto, guion, cwd)) return false;
    const sub = w[2] && w[2].texto;
    // clear-session sólo es la salida con --lost; sin él, sacaría la ejecución sin la frase del dueño
    if (guion === 'marker.js') return MARKER_LEE.has(sub) && (sub !== 'clear-session' || w.some((x) => x.texto === '--lost'));
    if (guion === 'pipeline.js') return PIPELINE_LEE.has(sub) || (sub === 'run-dir' && !w.some((x) => x.texto === '--create'));
    return false;
  });
}

// La ejecución de la sesión perdió una pieza (lib/open-runs.js): frena todo lo que no es leer o la salida, antes de mirar
// destinos. No poder preguntar no es estar sana.
function ejecucionPerdida(event) {
  if (event?.tool_name && event.tool_name !== 'Bash' && event.tool_name !== 'PowerShell') return null;
  const cmd = event?.tool_input?.command;
  if (!cmd) return null;
  const or = require('./open-runs.js');
  const sessionId = resolveSessionId(event?.session_id);
  let p;
  try { p = or.perdida({ sid: sessionId, cwd: nativePath(event?.cwd || process.cwd()) }); } catch (e) {
    p = { caso: 'ilegible', falta: `no pude revisar las piezas de la ejecución (${e.message})`, sesion: String(sessionId) };
  }
  if (!p) return null;
  if (soloLee(cmd, event?.tool_name === 'PowerShell' ? 'powershell' : 'bash', nativePath(event?.cwd || process.cwd()))) return null;
  const io = require('./story-gate-io.js');
  io.appendLog(io.DEFAULT_STATE_DIR, 'gates.log', sessionId, { name: 'story-gate', status: 'blocked', kind: 'ejecucion-perdida', via: `Bash: ${String(cmd).replace(/\s+/g, ' ').slice(0, 120)}`, story: p.story, reason: `ejecución perdida (${p.caso}): ${p.falta}` });
  return { block: or.cartel(p) + '\n' };
}

/**
 * Las palabras otra vez como un tramo: entre comillas simples las que lo necesitan, donde la barra y la comilla doble
 * son letras; una comilla simple se cierra, se escapa y se vuelve a abrir (`'\''`).
 */
const comoTramo = (words) => words.map((w) => (/[\s'"\\$`]/.test(w) ? `'${w.split("'").join("'\\''")}'` : w)).join(' ');

function carpetasQueBorraOMueve(cmd) {
  // `cmd /c`, `pushd` y `Set-Location` cambian de forma, no de efecto; las palabras de control del shell (`if`, `then`,
  // `do`, `else`, `time`, `!`, `{`, `(`) no son el comando
  const sinCmd = String(cmd || '')
    // la continuación de línea junta los renglones
    .replace(/\\\r?\n/g, ' ')
    // `cd` solo va a la carpeta personal; `cd "<carpeta>"` sin espacios es `cd <carpeta>`
    .replace(/(^|[;&|(\n]\s*)cd(?=\s*(?:[;&|\n)]|$))/g, '$1cd $HOME')
    .replace(/\bcd\s+"([^"\s]*)"/g, 'cd $1')
    .replace(/\$\(\s*pwd\s*\)|\$\{PWD(?::?[-?=+][^}]*)?\}/g, '$PWD')
    // comillas pegadas a la palabra sin espacios adentro (`wt-"a"`): la misma palabra
    .replace(/(?<=[^\s=])(["'])([^"'\s]*)\1/g, '$2')
    // una redirección no cambia qué se borra ni dónde (`cd X >/dev/null && rm -rf wt`)
    .replace(/(?<=[ \t])\d?>{1,2}&?[ \t]*(?:\/dev\/null|&?\d|NUL)\b/gi, '')
    .replace(/(^|[;&|(\n]\s*)cmd(?:\.exe)?\s+\/[ck]\s+/gi, '$1')
    .replace(/(^|[;&|(\n{]\s*)(?:pushd|set-location|sl|chdir)(?=\s)/gi, '$1cd')
    // un subshell o un grupo que abre el tramo (`(cd x && …)`, `{ rm …; }`): sin la llave ni el paréntesis
    .replace(/(^|[;&|\n])[ \t]*[({]+/g, '$1 ');
  const rutas = [];
  const prune = [];
  // un borrado cuenta si puede llevarse una carpeta con algo adentro: `rm` con `-r`, `Remove-Item` (y sus alias) con
  // `-Recurse`, `rd`/`rmdir` con `/s`. `rm -f <carpeta>` o un `rmdir` de una carpeta vacía no se la llevan
  const recursivo = (words) => {
    const c = nombreDeComando(words[0] || '');
    const resto = words.slice(1);
    if (c === 'rm') return resto.some((w) => /^-[a-zA-Z]*[rR]/.test(w) || w === '--recursive');
    // `/s` también pegado a otros (`/s/q`, `/q/s`)
    if (['rd', 'rmdir', 'remove-item', 'ri', 'del', 'erase'].includes(c)) return resto.some((w) => /^(?:\/[a-z])*\/s(?:\/[a-z])*$/i.test(w) || /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?$/i.test(w));
    return false;
  };
  const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'pwsh', 'powershell', 'eval', 'xargs', 'env', 'sudo', 'nohup', 'nice', 'time']);
  const textos = [sinCmd];
  const ver = (texto, nivel) => {
    for (const tramo of tramos(texto)) {
      // sin PREFIJO: los envoltorios se sacan acá, con sus opciones (`sudo -u x`: PREFIJO dejaría `x` como el comando)
      let words = palabras(tramo.trim()).filter((w) => w !== '');
      let tramoDe = tramo;
      // las palabras de control (`then`, `do`, `!`, `time`…) y los envoltorios que corren otro comando, con sus opciones
      // y valores (`sudo -u x`, `env -u X`, `nice -5`): se sacan de a una palabra, sin una expresión que pueda retroceder
      // con un índice y un solo corte al final: `shift()` mueve el arreglo entero en cada palabra (cuadrático)
      let k0 = 0;
      for (let vuelta = 0; vuelta < 64 && k0 < words.length; vuelta++) {
        const w0 = words[k0];
        if (CONTROL.has(w0) || /^[A-Za-z_]\w*=/.test(w0)) { k0++; continue; }
        if (!ENVOLTORIOS.has(nombreDeComando(w0))) break;
        k0++;
        while (k0 < words.length && (words[k0].startsWith('-') || /^[A-Za-z_]\w*=/.test(words[k0]) || /^\d+(?:\.\d+)?[smhd]?$/.test(words[k0]))) {
          const op = words[k0++];
          if (/^-[ugnc]$/.test(op) && k0 < words.length) k0++;
        }
      }
      if (k0) { words = words.slice(k0); tramoDe = comoTramo(words); }
      // `xargs [opciones] rm -rf <ruta>` y `eval rm -rf <ruta>`: el comando es lo que sigue
      if (['xargs', 'eval'].includes(nombreDeComando(words[0] || ''))) {
        let k = 1;
        while (nombreDeComando(words[0]) === 'xargs' && k < words.length && words[k].startsWith('-')) k += /^-(?:I|n|P|L|d|E|s|a)$/.test(words[k]) ? 2 : 1;
        words = words.slice(k);
        tramoDe = comoTramo(words);
      }
      if (recursivo(words)) for (const d of destinosBorrados(tramoDe)) if (d.kind === 'delete' && !d.git) rutas.push({ raw: d.raw });
      for (const raw of origenesMovidos(tramoDe)) rutas.push({ raw });
      // `trash <carpeta>` la saca entera (a la papelera)
      if (nombreDeComando(words[0] || '') === 'trash') for (const w of words.slice(1)) if (!w.startsWith('-')) rutas.push({ raw: w });
      // `find <carpetas> -exec rm -r {}` sin elegir por nombre: borra las carpetas enteras
      if (nombreDeComando(words[0] || '') === 'find') {
        const e = words.findIndex((w) => /^-exec(?:dir)?$/.test(w));
        const porNombre = words.some((w) => /^-(?:i?name|i?path|i?wholename|i?regex|newer\w*|[acm]time|[acm]min|size|perm|user|group)$/.test(w));
        if (e > 0 && !porNombre && recursivo(words.slice(e + 1))) {
          // `-H`, `-L` y `-P` van antes de las carpetas
          const desde = words.slice(1);
          while (/^-[HLP]$/.test(desde[0] || '')) desde.shift();
          for (const w of desde) { if (w.startsWith('-') || w === '!' || w === '(') break; rutas.push({ raw: w }); }
        }
      }
      // adentro de un texto sólo cuando lo corre otro shell (`bash -c '…'`): el texto de un `echo` o un mensaje no borra
      if (nivel < 2 && SHELLS.has(nombreDeComando(words[0] || ''))) for (const w of words.slice(1)) if (/\s/.test(w)) { textos.push(w); ver(w, nivel + 1); }
      if (nombreDeComando(words[0] || '') !== 'git') continue;
      let i = 1;
      let base = null;
      while (i < words.length && words[i].startsWith('-')) {
        // varios `-C` se encadenan como git: uno absoluto empieza de nuevo
        if (words[i] === '-C') { const v = words[i + 1]; base = base && !(path.isAbsolute(v) || /^[A-Za-z]:[\\/]/.test(v)) ? `${base}/${v}` : v; i += 2; continue; }
        if (['-c', '--git-dir', '--work-tree', '--namespace'].includes(words[i])) { i += 2; continue; }
        i++;
      }
      if (words[i] !== 'worktree') continue;
      const sub = words[i + 1];
      const opciones = words.slice(i + 2).filter((w) => w.startsWith('-'));
      const resto = words.slice(i + 2).filter((w) => !w.startsWith('-'));
      if ((sub === 'remove' || sub === 'move') && resto[0]) rutas.push({ raw: resto[0], ...(base ? { base } : {}) });
      // `--dry-run` (`-n`) sólo dice qué podaría
      if (sub === 'prune' && !opciones.some((w) => w === '-n' || w === '--dry-run')) prune.push(base);
    }
  };
  ver(sinCmd, 0);
  // la lista con coma de PowerShell (`Remove-Item a,b -Recurse`): cada una, además de la palabra entera
  const conComas = [];
  for (const r of rutas) { conComas.push(r); if (/,/.test(r.raw)) for (const x of r.raw.split(',')) if (x.trim()) conComas.push({ ...r, raw: x.trim() }); }
  return { rutas: conComas, prune, texto: sinCmd, textos };
}

/**
 * Las carpetas de trabajo que un `git worktree prune` corrido en `dir` olvidaría: las que git marca `prunable`.
 * `{ ok: true, carpetas }`, o `{ ok: false, motivo }` si git no se pudo leer o no trae el campo `prunable` (anterior a
 * 2.31): una carpeta anotada que ya no existe, sin la marca, no se sabe si se poda.
 */
function lasQuePoda(dir) {
  const r = require('child_process').spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: dir, encoding: 'utf8', timeout: 10000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.status !== 0) return { ok: false, motivo: `no pude leer las carpetas de trabajo de git (${String(r.stderr || (r.error && r.error.code) || 'sin salida').trim().split('\n')[0]})` };
  const lista = [];
  let cur = null;
  for (const l of String(r.stdout).split(/\r?\n/)) {
    if (l.startsWith('worktree ')) { cur = { path: nativePath(l.slice(9)), prunable: false, locked: false }; lista.push(cur); }
    else if (cur && (l === 'prunable' || l.startsWith('prunable '))) cur.prunable = true;
    else if (cur && (l === 'locked' || l.startsWith('locked '))) cur.locked = true;
  }
  const hayCampo = lista.some((w) => w.prunable);
  const faltan = lista.slice(1).filter((w) => !w.locked && !fs.existsSync(w.path));
  if (!hayCampo && faltan.length) return { ok: false, motivo: 'este git no marca qué carpetas poda (le falta el campo «prunable», anterior a 2.31): no pude saber qué se poda' };
  return { ok: true, carpetas: lista.slice(1).filter((w) => w.prunable).map((w) => w.path) };
}

/** El cartel de «cerrá la ejecución antes»: cada ejecución con su historia, su sesión y cómo se cierra. */
function cartelBorraAbierta(abiertas, sid, via) {
  const or = require('./open-runs.js');
  const lineas = [`🔒 CERRÁ LA EJECUCIÓN ANTES — ${via} borra o mueve la carpeta de una ejecución abierta. Si se va, la ejecución queda perdida y para salir hace falta la firma de una persona.`];
  for (const a of abiertas) {
    const propia = a.sesion === String(sid);
    const f = or.formaDeMarker(propia ? 'clear' : `clear-session ${a.sesion}`, a.sesion);
    lineas.push(`  · story ${a.story || '?'} (sesión ${a.sesion}), su carpeta ${a.runDir}, dentro de ${a.en}.`);
    lineas.push(propia
      ? `    Cerrala antes, después del último push y del último pedido: ${f.ventana}`
      : `    Es de otra sesión: se cierra desde esa sesión, con ${f.ventana}. Si esa sesión ya no está, la cierra una persona en su terminal: ${f.terminal}`);
  }
  lineas.push('Con la ejecución cerrada, el mismo comando pasa.');
  return lineas.join('\n');
}

/**
 * Las constancias de control (`.github/control-changes/`, `.tycon/control-changes/` y su registro `.jsonl`) sin commitear
 * en el repo o worktree que vive en `dir`, con su ruta relativa. Una carpeta que no es la raíz de un repo, o donde git no
 * contesta, no tiene: el freno de siempre decide.
 */
function constanciasSinCommitear(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) return [];
  const { spawnSync } = require('child_process');
  const r = spawnSync('git', ['-C', dir, '-c', 'core.quotepath=false', 'status', '--porcelain', '--untracked-files=all', '--', '.github/control-changes', '.tycon/control-changes', '.tycon/control-changes.jsonl'],
    { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  if (r.error || r.status !== 0) return [];
  return String(r.stdout).split('\n').filter(Boolean).map((l) => l.slice(3).trim());
}

// El comando borra o mueve una carpeta que contiene la carpeta de una ejecución abierta (D4 de la 8.318: abierta según
// gates.log). Sólo mira cuando el comando borra o mueve, y lee el registro sólo si hay una carpeta que exista en el disco
// (o un `git worktree prune`). Un registro que no se puede leer frena: lo indecidible frena (8.121, decisión 13).
function borraEjecucionAbierta(event) {
  if (event?.tool_name && event.tool_name !== 'Bash' && event.tool_name !== 'PowerShell') return null;
  const cmd = event?.tool_input?.command;
  if (!cmd || !BORRA_O_MUEVE.test(String(cmd))) return null;
  const { rutas, prune, textos } = carpetasQueBorraOMueve(cmd);
  if (!rutas.length && !prune.length) return null;
  const baseCwd = nativePath(event?.cwd || process.cwd());
  // las carpetas desde donde puede correr: las del original y las del texto sin subshells ni `pushd`, también adentro
  // de un `bash -c '…'`
  const cwds = [...new Set([cmd, ...textos].flatMap((t) => carpetasDelComando(conLosCdDeSiempre(t), baseCwd)))];
  // `{1..3}` y `{a..c}` como el shell, en una lista con coma (hasta 64)
  const conRangos = (raw) => String(raw).replace(/\{(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])\}/g, (m, a, b) => {
    const num = /\d/.test(a);
    const x = num ? Number(a) : a.charCodeAt(0);
    const y = num ? Number(b) : b.charCodeAt(0);
    if (Math.abs(y - x) > 63) return m;
    const out = [];
    for (let v = x; x <= y ? v <= y : v >= y; v += x <= y ? 1 : -1) out.push(num ? String(v) : String.fromCharCode(v));
    return `{${out.join(',')}}`;
  });
  // `$PWD` y `$(pwd)` son la carpeta del comando; una ruta que no se resuelve se mira por su parte fija de adelante
  // (`../wt-$X` mira `..`): lo que se borra está adentro de esa carpeta
  const fija = (raw) => {
    const i = String(raw).search(/[$`]/);
    if (i <= 0) return null;
    const pre = String(raw).slice(0, i);
    return /[\\/]$/.test(pre) ? pre : path.dirname(pre);
  };
  const resolver = (raw, base, desde) => {
    // comillas y escapes pegados a la palabra (`wt-"a"`, `wt\-a`) son la misma ruta; en Windows la barra invertida separa
    const limpia = String(raw).replace(/["']/g, '').replace(process.platform === 'win32' ? /^$/ : /\\(.)/g, '$1');
    const conPwd = limpia.replace(/\$\{?PWD\}?|\$\(\s*pwd\s*\)/g, () => desde);
    let dir = desde;
    if (base) { const b = expandirRuta(cmd, base); if (b.sinResolver.length) return { sinResolver: true }; dir = resolveTarget(b.valor, desde, process.platform, { homeVariable: true }); }
    const ruta = expandirRuta(cmd, conPwd);
    if (!ruta.sinResolver.length) return { abs: resolveTarget(ruta.valor, dir, process.platform, { homeVariable: true }) };
    const f = fija(conPwd);
    return f ? { abs: resolveTarget(f, dir, process.platform, { homeVariable: true }), aproximada: true } : { sinResolver: true };
  };
  const esCarpeta = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  const carpetas = new Set();
  const comodines = [];
  for (const desde of cwds) {
    for (const d of rutas) {
      for (const raw of expandirLlaves(conRangos(d.raw))) {
        const r = resolver(raw, d.base, desde);
        if (!r.abs) continue;
        // un comodín no se expande (la lista tiene tope y su orden depende del disco): se compara con cada ejecución
        if (/[*?[]/.test(r.abs)) comodines.push(r.abs);
        else if (esCarpeta(r.abs)) carpetas.add(r.abs);
      }
    }
  }
  const sid = resolveSessionId(event?.session_id);
  const via = `Bash: ${String(cmd).replace(/\s+/g, ' ').slice(0, 120)}`;
  const frena = (texto, reason, story) => {
    // el registro se carga recién al frenar: una falla suya no cambia lo que pasa sin frenar
    try { const io = require('./story-gate-io.js'); io.appendLog(io.DEFAULT_STATE_DIR, 'gates.log', sid, { name: 'story-gate', status: 'blocked', kind: 'borra-ejecucion-abierta', via, story: story || null, reason }); } catch { /* el registro no traba el freno */ }
    return { block: texto + '\n' };
  };
  const motivos = [];
  if (prune.length) {
    for (const desde of cwds) for (const b of prune) {
      const dir = b ? resolver(b, null, desde).abs : desde;
      if (!dir) { motivos.push('no pude resolver la carpeta del `git worktree prune`'); continue; }
      const r = lasQuePoda(dir);
      if (!r.ok) motivos.push(r.motivo);
      else for (const c of r.carpetas) carpetas.add(c);
    }
  }
  // una constancia de control firmada y sin commitear vive sólo en esa carpeta: sacarla borra la firma del dueño, y
  // `git worktree remove` sugiere `--force` justamente por ella
  for (const c of carpetas) {
    const sueltas = constanciasSinCommitear(c);
    if (sueltas.length) {
      return frena(`🔒 CONSTANCIA SIN COMMITEAR — ${via} saca ${c}, que tiene una constancia de control sin commitear: ${sueltas.join(', ')}. ` +
        'Sacar la carpeta la borra, y con ella la firma. Commiteala y empujala a la rama de su pedido antes; con la constancia en la rama, el mismo comando pasa.',
      `saca una constancia sin commitear: ${sueltas.join(', ')}`);
    }
  }
  if (!carpetas.size && !motivos.length && !comodines.length) return null;
  const or = require('./open-runs.js');
  const r = or.abiertasDentro([...carpetas], { comodines });
  if (!r.ok) {
    return frena(`🔒 CERRÁ LA EJECUCIÓN ANTES — ${via} borra o mueve carpetas, y no pude leer el registro de aperturas (gates.log: ${r.error}): no sé si adentro hay una ejecución abierta, y lo que no se puede decidir frena.`, `registro ilegible: ${r.error}`);
  }
  if (r.abiertas.length) {
    return frena(cartelBorraAbierta(r.abiertas, sid, via), `borra o mueve la carpeta de ${r.abiertas.map((a) => `la ejecución de la story ${a.story} (sesión ${a.sesion})`).join(', ')}`, r.abiertas[0].story);
  }
  if (motivos.length) {
    // sin saber qué se poda, pesa sólo si hay alguna ejecución abierta en la máquina
    const todas = or.hayAbiertas();
    if (!todas.ok || todas.n > 0) {
      return frena(`🔒 CERRÁ LA EJECUCIÓN ANTES — ${via}: ${[...new Set(motivos)].join('; ')}. Hay una ejecución abierta en esta máquina y podar podría borrar el último rastro de su carpeta: lo que no se puede decidir frena. Cerrá la ejecución antes, o mirá con \`git worktree list --porcelain\` qué se poda.`, [...new Set(motivos)].join('; '));
    }
  }
  return null;
}

// Lo que la coordinadora escribe o borra por la consola y el lector de destinos de siempre no ve: el origen de un `mv`,
// los comandos que tocan lo que nombran, las descargas, `find -delete` y los `git` que cambian el árbol de trabajo (éstos,
// como la carpeta del repo entera). `[{ raw, base? }]`, sin resolver.
const TOCAN_LO_QUE_NOMBRAN = new Set(['mv', 'touch', 'mkdir', 'rmdir', 'shred', 'trash', 'install', 'rsync', 'ditto', 'ln', 'truncate', 'chmod', 'chown', 'chgrp', 'vi', 'vim', 'nvim', 'nano', 'emacs', 'ed', 'ex']);
// de éstos, el primer argumento es el modo o el dueño, no una ruta
const PRIMERO_NO_ES_RUTA = new Set(['chmod', 'chown', 'chgrp']);
// el modo simbólico de chmod que empieza con guion es el modo, no una opción: una o varias acciones por cláusula, cada
// una con letras de permiso o la copia de los de otro (`-x`, `-x+w`, `-wx=r`, `-g`, `-x=`), y más cláusulas con quién
// (`-w,o-r`, `-xX,g=u`). Ninguna opción de chmod (`-R`, `-f`, `-v`, `-h`) tiene esa forma
const ACCION_DE_MODO = '(?:[rwxXst]*|[ugo])';
const MODO_CON_GUION = new RegExp(`^-(?!$)${ACCION_DE_MODO}(?:[-+=]${ACCION_DE_MODO})*(?:,[ugoa]*(?:[-+=]${ACCION_DE_MODO})+)*$`);
const OPCION_CON_VALOR = /^-(?:m|o|g|t|e|-mode|-owner|-group|-target-directory|-rsh|-exclude|-include|-chmod|-suffix)$/;
// los subcomandos de git que cambian el árbol de trabajo; commits, empujes y merges quedan fuera (los cubre la guía)
const GIT_CAMBIA_EL_ARBOL = new Set(['reset', 'clean', 'checkout', 'switch', 'stash', 'restore', 'mv', 'rm']);
const FIND_QUE_ESCRIBE = new Set(['rm', 'mv', 'sed', 'perl', 'truncate', 'shred', 'chmod', 'chown', 'cp', 'tee', 'dd']);
function destinosDeLaCoordinadora(cmd) {
  const out = [];
  for (const tramo of tramos(cmd)) {
    const limpio = tramo.replace(/(^|\s)#.*$/, '').replace(/[ \t]*(?:&|\d)?>{1,2}(?:\||&)?[ \t]*(?:'[^']*'|"[^"]*"|[^\s'"|;&<>]+)?/g, ' ');
    const words = palabras(limpio.trim().replace(PREFIJO, '')).filter((w) => w !== '').map((w) => w.replace(/\)+$/, '')).filter(Boolean);
    if (!words.length) continue;
    const c = path.basename(words[0].replace(/^\\/, '')).toLowerCase().replace(/\.exe$/, '');
    const resto = words.slice(1);
    const args = [];
    for (let i = 0; i < resto.length; i++) {
      if (resto[i] === '--') { args.push(...resto.slice(i + 1)); break; }
      if (c === 'chmod' && !args.length && MODO_CON_GUION.test(resto[i])) { args.push(resto[i]); continue; }
      if (resto[i].startsWith('-')) { if (OPCION_CON_VALOR.test(resto[i])) i++; continue; }
      args.push(resto[i]);
    }
    const poner = (raw, base) => { if (raw) out.push({ raw, ...(base ? { base } : {}) }); };
    if (TOCAN_LO_QUE_NOMBRAN.has(c)) { for (const a of PRIMERO_NO_ES_RUTA.has(c) ? args.slice(1) : args) poner(a); continue; }
    if (c === 'gsed' && resto.some((w) => /^-i/.test(w) || w.startsWith('--in-place'))) {
      for (const a of resto.includes('-e') || resto.includes('-f') ? args : args.slice(1)) poner(a);
      continue;
    }
    if ((c === 'awk' || c === 'gawk') && resto.join(' ').includes('-i inplace')) { for (const a of args.filter((w) => w !== 'inplace').slice(1)) poner(a); continue; }
    if (c === 'curl') {
      resto.forEach((w, i) => {
        if (w === '-o' || w === '--output') poner(resto[i + 1]);
        else if (/^-o\S/.test(w)) poner(w.slice(2));
        else if (w === '-O' || w === '--remote-name' || /^-[a-zA-Z]*O$/.test(w)) poner('.');
      });
      continue;
    }
    if (c === 'wget') {
      const o = resto.findIndex((w) => w === '-O' || w === '--output-document');
      const p = resto.findIndex((w) => w === '-P' || w === '--directory-prefix');
      if (o >= 0) { if (resto[o + 1] !== '-') poner(resto[o + 1]); } else poner(p >= 0 ? resto[p + 1] : '.');
      continue;
    }
    if (c === 'dd') { for (const w of resto) if (/^of=/.test(w)) poner(w.slice(3)); continue; }
    if (c === 'find') {
      const exec = resto.findIndex((w) => ['-exec', '-execdir', '-ok', '-okdir'].includes(w));
      const escribe = resto.includes('-delete') || (exec >= 0 && FIND_QUE_ESCRIBE.has(path.basename(String(resto[exec + 1] || ''))));
      if (!escribe) continue;
      const raices = [];
      for (const w of resto) { if (w.startsWith('-') || w === '(' || w === '!') break; raices.push(w); }
      for (const r of raices.length ? raices : ['.']) poner(r);
      continue;
    }
    if (c === 'git') {
      let i = 0;
      let base = null;
      while (i < resto.length && resto[i].startsWith('-')) {
        if (resto[i] === '-C') { base = base ? `${base}/${resto[i + 1]}` : resto[i + 1]; i += 2; continue; }
        if (['-c', '--git-dir', '--work-tree', '--namespace'].includes(resto[i])) { i += 2; continue; }
        i++;
      }
      const sub = resto[i];
      const deSub = resto.slice(i + 1);
      // `worktree remove --force` borra la copia aunque tenga cambios sin commitear; sin `--force`, git no la borra si los tiene
      if (sub === 'worktree' && deSub[0] === 'remove') {
        // git acepta `--force` abreviado (`--fo`, `--forc`) y `-f` junto a otras letras
        if (deSub.some((w) => (w.length >= 3 && '--force'.startsWith(w)) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(w))) {
          for (const w of deSub.slice(1)) if (!w.startsWith('-')) poner(w, base);
        }
        continue;
      }
      if (!GIT_CAMBIA_EL_ARBOL.has(sub)) continue;
      if (sub === 'reset' && !deSub.some((w) => /^--(?:hard|merge|keep)$/.test(w))) continue;
      if (sub === 'clean' && deSub.some((w) => w === '-n' || w === '--dry-run')) continue;
      if (sub === 'stash' && ['list', 'show', 'create'].includes(deSub[0])) continue;
      poner('.', base);
    }
  }
  return out;
}

// Lo que no es una redirección aunque lleve `>`: una cuenta `$((1>2))`, un `\>`, un valor `${x:-a>b}` y la entrada de
// otro comando `>(…)` (queda como `$(…)`: su destino no se resuelve sin ejecutar).
function sinMayoresQueNoRedirigen(cmd) {
  return String(cmd).replace(/\$\(\([\s\S]*?\)\)/g, ' ').replace(/\\>/g, ' ').replace(/\$\{[^}]*>[^}]*\}/g, '"$__SIN_RESOLVER__"').replace(/>\(/g, '$(');
}

// El `cd` en otro renglón, con `|| exit` o con `cd --` es el mismo `cd`: así lo ven las carpetas del comando.
function conLosCdDeSiempre(cmd) {
  const CD = String.raw`(\bcd[ \t]+(?:'[^']*'|"[^"]*"|[^\s;&|()<>'"` + '`' + String.raw`]+))`;
  return String(cmd)
    .replace(/\bcd[ \t]+--[ \t]+/g, 'cd ')
    .replace(new RegExp(`${CD}[ \\t]*\\|\\|[ \\t]*(?:exit|return)\\b[^;&\\n]*`, 'g'), '$1')
    .replace(new RegExp(`${CD}[ \\t]*\\n`, 'g'), '$1 && ');
}

// ¿Algún `cd` del comando va a una carpeta armada con una variable o un comando (`cd "$TMPDIR"`, `cd "$(mktemp -d)"`)?
// Las carpetas del comando no siguen ese `cd`: lo relativo de después no se sabe dónde cae.
function cdSinResolver(cmd) {
  for (const m of String(cmd).matchAll(/\bcd[ \t]+(?:--[ \t]+)?(?:'([^']*)'|"([^"]*)"|([^\s;&|()<>'"]+))/g)) {
    if (/[`$]/.test(m[2] ?? m[3] ?? '')) return true;
  }
  return false;
}


module.exports = { NO_CORRE_PROPIOS, noCorreSusArgumentos, guionesDelPeorCaso, comienzoDe, guionesEnArchivo, palabrasDelBucleSiFueraSoloSeLee, estadoPorOtroPrograma, frenoBorrarYArmados, heredocBodies, cuerposDistintos, destinosResueltos, renameOrCopyOfExistingStory, LEE, LEE_ARCHIVOS, VECINOS, comandoNoTocaElShell, tramoQueSoloNombra, soloLee, ejecucionPerdida, comoTramo, carpetasQueBorraOMueve, lasQuePoda, cartelBorraAbierta, constanciasSinCommitear, borraEjecucionAbierta, TOCAN_LO_QUE_NOMBRAN, PRIMERO_NO_ES_RUTA, ACCION_DE_MODO, MODO_CON_GUION, OPCION_CON_VALOR, GIT_CAMBIA_EL_ARBOL, FIND_QUE_ESCRIBE, destinosDeLaCoordinadora, sinMayoresQueNoRedirigen, conLosCdDeSiempre, cdSinResolver };
