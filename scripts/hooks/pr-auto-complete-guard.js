#!/usr/bin/env node
/**
 * pr-auto-complete-guard.js — freno: un pull request a main, armado a mano y sin auto-complete, no sale.
 *
 * 🔴 POR QUÉ EXISTE. Un agente con un fix listo, en un repo que declara `merge.mode: pr` y con el skill
 * `tycon-merge-to-main` que sabe crear el pull request como corresponde, puede abrir el PR con
 * `az repos pr create` suelto: sin `--auto-complete true` (el PR
 * queda abierto para siempre, nadie lo completa) y sin `--squash false` (con squash los commits
 * desaparecen de main y las notas de versión, que listan los commits desde la versión publicada,
 * colapsan a una línea). El skill hace lo correcto; lo que hace falta es algo que OBLIGUE a pasar por él,
 * porque una regla escrita («usá el skill») no alcanza.
 *
 * QUÉ MIRA. Al CREAR, sólo los pull requests **a main/master**: el skill es el camino de esa rama,
 * y frenar un `feature → dev` con el consejo de usarlo sería un consejo equivocado — un freno que
 * estorba el trabajo legítimo se apaga, y con él el caso que sí importa.
 * Al ACTUALIZAR no se puede acotar igual: `az repos pr update` identifica el PR por número y **no
 * dice a qué rama apunta**, así que se mira siempre (decisión fail-closed, con el escape a mano).
 * Por eso el mensaje del update no afirma "a main" — decirlo sería falso.
 *
 * QUÉ HACE. Para cada `az repos pr create` del comando —cada uno con SUS banderas, aunque vengan
 * varios encadenados— exige `--auto-complete true` y `--squash false` explícitos (sin el segundo la
 * estrategia la decide la política de la rama), y `--delete-source-branch` explícito: `true` desde una rama efímera
 * que se vea en `--source-branch`, o `false` sólo desde una de larga vida (sin borrarla, la rama queda viva después
 * del merge; con `true` desde `dev`, la plataforma la borraría; la lista es la de §9b.4 del paso de merge). Cierra
 * además las otras dos puertas al mismo resultado: un `az repos pr update` que APAGUE el auto-complete o PRENDA el
 * squash, y el que PUBLIQUE un borrador (`--draft false`) sin llevar las tres banderas. El `update` no dice la rama de
 * origen: si puede completar el pedido o lo borra, y no trae `--delete-source-branch false`, le pregunta la rama a
 * Azure (una llamada del conector, con el `--org` del comando, en la carpeta de la sesión y con tope) y frena si es
 * de larga vida; si la consulta no contesta bien, frena. Un `update` que no completa nada no se juzga por la bandera:
 * az conserva la que el pedido ya tenía. Lo que no puede leer (un valor que arma la terminal, un comodín, un
 * `@archivo`) es una falta. Lee el comando con scripts/lib/az-pr.js (`faltasDe`), y la red sólo para esa consulta.
 * Un pedido escrito adentro de `"$(…)"` o del heredoc de una terminal se juzga como uno suelto; uno que le llega a az
 * por una tubería a un intérprete, en una variable, por `python -m azure.cli`, `xargs` o `find -exec` frena con «no
 * puedo leer» (`pedidosOcultos`).
 *
 * QUÉ NO HACE. Un borrador recién creado no se toca (no se completa solo por definición) y lo dice.
 * `--help`, listar, mostrar y abandonar tampoco. Salida para el caso puntual —incluido el legítimo
 * de apagar el auto-complete para retener una entrega—: `TYCON_PR_BY_HAND=1` como prefijo PEGADO al
 * comando, nunca desde el entorno (exportarla en el rc la volvería permanente y silenciosa); deja
 * constancia en stderr y en el mismo `bypass.log` que ya usa el freno de tests.
 *
 * Salida: exit 2 bloquea (el comando no corre) · exit 0 deja pasar.
 * Apagar del todo: TYCON_PR_AUTO_COMPLETE_GUARD=0 (la variable tuvo un nombre en castellano, que sigue
 * valiendo hasta el retiro del mapa de renombres).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
// La carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: los
// laboratorios copian carpetas sueltas de scripts/ sin scripts/setup/; ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const az = require('../lib/az-pr.js');
const constanciaFreno = require('../lib/guard-record.js');

const TAG = '[pr-sin-auto-complete]';

// 🔴 SE LEE LA ENTRADA ANTES DE DECIDIR NADA, incluso para apagarse (misma lección que
// pr-one-per-repo-guard.js: salir sin drenar stdin rompe la tubería de quien escribe).
let payload;
try { payload = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
if (require('../lib/legacy-names.js').readEnv('TYCON_PR_AUTO_COMPLETE_GUARD', { where: 'scripts/hooks/pr-auto-complete-guard.js' }) === '0') process.exit(0);

let cmd = '';
// la carpeta de la sesión: ahí corre la consulta a Azure, como el comando
let eventoCwd = process.cwd();
try {
  const evento = JSON.parse(payload || '{}');
  cmd = (evento.tool_input || {}).command || '';
  if (typeof evento.cwd === 'string' && evento.cwd) eventoCwd = evento.cwd;
} catch {
  // No pudo leer: no frena —un freno que rompe la sesión por un bug propio se apaga— pero lo dice.
  console.error(`${TAG} no pude leer la entrada del hook: no freno, pero tampoco miré.`);
  process.exit(0);
}
// Azure DevOps: crear o actualizar un pedido. GitHub: un `gh pr merge` que aplasta, reordena o saca la entrada
// automática (el pedido de GitHub entra con un commit de merge, como el de Azure).
const esAz = typeof cmd === 'string' && az.pareceAzPr(cmd);
const esGh = typeof cmd === 'string' && /\bgh\b/.test(cmd);
if (!esAz && !esGh) process.exit(0);

// Las opciones de `gh pr merge` que rompen la regla, y las que llevan un valor (lo que sigue es su valor, no una opción).
const GH_ROMPE = new Map([['--squash', 'aplasta los commits'], ['--rebase', 'reordena los commits'], ['--disable-auto', 'saca la entrada automática']]);
const GH_CORTAS = new Map([['s', '--squash'], ['r', '--rebase']]);
const GH_CON_VALOR = new Set(['--subject', '--body', '--body-file', '--author-email', '--match-head-commit', '--repo']);
const GH_CORTAS_CON_VALOR = new Set(['t', 'b', 'F', 'A', 'R']);
// programas que sólo escriben su texto: un `gh` entre sus argumentos no corre
const SOLO_ESCRIBEN = new Set(['echo', 'printf']);
const esGhBin = (t) => path.basename(String(t).replace(/\\/g, '/')).replace(/\.(exe|cmd)$/i, '') === 'gh';
const faltaGh = (larga) => `${larga} ${GH_ROMPE.get(larga)}: el pedido entra con un commit de merge (\`--merge\`), o solo con su entrada automática`;

/**
 * Las faltas de los `gh pr merge` de un tramo: [] si no hay o si están bien armados. Como `verboDePr` del lado de Azure
 * DevOps, el `gh` se busca en cualquier lugar del tramo (detrás de `sudo`, `time`, `nohup`, `env`, `xargs`…), salvo
 * que el programa sólo escriba texto (`echo`). Las opciones se leen como las recibe `gh`: sin comillas, con las cortas
 * juntas desarmadas (`-sd` es `-s -d`) y salteando el valor de las que llevan uno.
 */
function faltasGh(seg) {
  const programa = seg.find((f) => !(f.esBandera && /^[A-Za-z_][A-Za-z0-9_]*=/.test(f.texto)));
  if (programa && SOLO_ESCRIBEN.has(programa.texto)) return [];
  const faltas = [];
  for (let i = 0; i < seg.length; i++) {
    if (!esGhBin(seg[i].texto)) continue;
    // las dos primeras palabras que no son opciones (después de `-R dueño/repo`, si viene antes)
    const palabras = [];
    let j = i + 1;
    for (; j < seg.length && palabras.length < 2; j++) {
      const t = seg[j].texto;
      if (t === '-R' || t === '--repo') { j++; continue; }
      if (t.startsWith('-')) continue;
      palabras.push(t);
    }
    if (palabras.join(' ') !== 'pr merge') continue;
    let elegido = false;   // el primer argumento suelto es el pedido (`$N` vale); otra expansión puede ser una opción
    for (let k = j; k < seg.length; k++) {
      const f = seg[k];
      const t = String(f.texto);
      if (f.expande) {
        if (!elegido && !t.startsWith('-')) { elegido = true; continue; }
        faltas.push(`\`${t}\` lo reemplaza la terminal antes de correr: no puedo leer qué opción llega — y lo que no pude mirar no está aprobado`);
        continue;
      }
      if (t.startsWith('--')) {
        const [nombre, valor] = t.split(/=(.*)/s);
        if (GH_ROMPE.has(nombre) && !(valor !== undefined && /^false$/i.test(valor))) faltas.push(faltaGh(nombre));
        else if (GH_CON_VALOR.has(nombre) && valor === undefined) k++;
        continue;
      }
      if (/^-[A-Za-z]/.test(t)) {
        // un grupo de cortas: cada letra es una opción; la que lleva valor se queda con el resto (o con la ficha siguiente)
        for (let c = 1; c < t.length; c++) {
          if (GH_CORTAS.has(t[c])) faltas.push(faltaGh(GH_CORTAS.get(t[c])));
          else if (GH_CORTAS_CON_VALOR.has(t[c])) { if (c === t.length - 1) k++; break; }
        }
        continue;
      }
      elegido = true;
    }
  }
  return faltas;
}

/** ¿El comando corre un `gh pr merge` que no se puede leer (adentro de otro intérprete, o el programa en una variable)? */
function ghMergeIlegible(comando) {
  if (!/\bmerge\b/.test(comando)) return null;
  let lista;
  try { lista = require('../lib/gh-pr.js').comandosGh(comando, 0, {}); } catch (e) {
    return `no pude leer el comando (${String((e && e.message) || e).slice(0, 60)})`;
  }
  const oculto = lista.find((c) => !c.grupo && c.ilegible.length);
  return oculto && /\bgh\b[\s\S]*\bpr\b[\s\S]*\bmerge\b/.test(comando.replace(/["'\\]/g, '')) ? oculto.ilegible[0] : null;
}

function constancia(tipo, texto, comando) {
  console.error(`${TAG} ${texto}`);
  try {
    const dir = path.join(stateDirOf(os.homedir()));
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'bypass.log'),
      JSON.stringify({ ts: new Date().toISOString(), type: tipo, command: String(comando).slice(0, 500) }) + '\n');
  } catch { /* la constancia en stderr ya salió */ }
}

let huboEscape = false;   // ¿ya se anotó el escape de este comando?
// ¿este freno llegó a JUZGAR algún segmento? Un `--help`, un pull request que va a `dev` o un
// borrador son cosas que él mismo declara fuera de su alcance: anotarles un `paso` mete en su
// denominador comandos que nunca juzga.
let huboJuicio = false;
const problemas = [];
const problemasGh = [];
function juzgarSegmentos(segs) {
  for (let iSeg = 0; iSeg < segs.length; iSeg += 1) {
    const seg = segs[iSeg];
    if (az.pideAyuda(seg)) continue;

    if (esGh) {
      const ilegible = ghMergeIlegible(az.textoDe(seg));
      const faltas = ilegible
        ? [`el \`gh pr merge\` no se deja leer desde acá (${ilegible}): otro intérprete o una variable lo corre, así que no puedo leer sus banderas — y lo que no pude mirar no está aprobado`]
        : faltasGh(seg);
      if (faltas.length) {
        huboJuicio = true;
        if (az.tieneEscape(seg)) {
          constancia('PR_A_MANO', 'TYCON_PR_BY_HAND=1: dejo mergear el pedido a mano. Queda dicho.', az.textoDe(seg));
          huboEscape = true;
        } else problemasGh.push({ seg, faltas });
        continue;
      }
    }
    if (!esAz) continue;

    // Código adentro de una cadena que va a un intérprete: no se puede juzgar lo que se ejecuta.
    if (az.pasaCodigoAUnInterprete(seg)) {
      problemas.push({ seg, verbo: 'interprete', faltas: ['el comando viaja adentro de una cadena que ejecuta otro intérprete, así que no puedo leer sus banderas — y lo que no pude mirar no está aprobado'] });
      huboJuicio = true;
      continue;
    }

    const verbo = az.verboDePr(seg);
    if (verbo !== 'create' && verbo !== 'update') continue;

    // La regla vive en `faltasDe` (scripts/lib/az-pr.js): la misma que lee la revisión nocturna de las ejecuciones.
    // Se juzga ANTES de mirar el prefijo: un prefijo puesto sobre un tramo que pasaría igual no es un salteo, y anotarlo
    // llenaba el registro de salteos que no eran.
    const { juzgado, borrador, faltas, consultarOrigen } = az.faltasDe(seg, { cambiaCarpeta: az.cambiaCarpetaAntes(segs, iSeg) });
    let sobra = false;
    if (az.tieneEscape(seg)) {
      // con el escape no se consulta: si el pedido necesitaba la consulta, el prefijo no sobraba
      if (faltas.length || consultarOrigen) {
        constancia('PR_A_MANO', `TYCON_PR_BY_HAND=1: dejo armar el PR a mano. Queda dicho.`, az.textoDe(seg));
        huboEscape = true;
        continue;
      }
      sobra = true;
    }
    // Una línea por tramo: un borrador con el prefijo dice las dos cosas en la misma línea.
    const SOBRA = 'TYCON_PR_BY_HAND=1: el prefijo sobra, este pedido pasa igual sin él; no lo anoto como salteo.';
    if (borrador) {
      console.error(`${TAG} ${sobra ? SOBRA + ' ' : ''}borrador (--draft): no lo freno ahora, un borrador no se completa solo. Al publicarlo (--draft false) van a hacer falta --auto-complete true --squash false --delete-source-branch <true|false>.`);
      continue;
    }
    if (sobra) console.error(`${TAG} ${SOBRA}`);
    if (!juzgado) continue;
    huboJuicio = true;
    if (faltas.length) { problemas.push({ seg, verbo, faltas }); continue; }
    // el `update` que puede completar el pedido o lo borra: la rama se le pregunta a Azure, una llamada por pedido
    if (consultarOrigen) {
      const r = az.consultaDeOrigen({ ...consultarOrigen, cwd: eventoCwd });
      if (r.problema) {
        problemas.push({ seg, verbo, faltas: [`para ver si borraría una rama de larga vida le pregunté a Azure la rama del pedido ${consultarOrigen.id}, y no pude: ${r.problema}. Repetí el comando cuando az responda; si el pedido sale de dev, develop, main o master, va \`--delete-source-branch false\`; si no, el escape`] });
      } else if (az.esDeLargaVida(r.rama)) {
        problemas.push({ seg, verbo, faltas: [`el pedido ${consultarOrigen.id} sale de \`${r.rama}\`, una rama de larga vida: al completarse la plataforma la borraría. Va \`--delete-source-branch false\``] });
      }
    }
  }
}
juzgarSegmentos(az.segmentos(cmd));

// El pedido que el recorrido común no ve (8.225): lo que corre aparte —una sustitución adentro de comillas dobles, el
// cuerpo de un heredoc a una terminal o el que expande— se juzga como un comando suelto, con su propio escape; lo que le
// llega a az por un camino que no se lee frena con «no puedo leer». Y la red de abajo: si el comando nombra más pedidos
// de los que se juzgaron y algo en él corre código (`quienEjecuta`), frena aunque la forma no esté en la lista. Con un
// tope de vueltas: cada texto es más corto que el que lo contiene, pero un comando enorme no se recorre sin fin.
if (esAz) {
  const cuenta = (segs) => segs.filter((x) => ['create', 'update'].includes(az.verboDePr(x))).length;
  let juzgados = cuenta(az.segmentos(cmd));
  let ejecutor = null;
  const tuberias = [];
  const pendientes = [cmd];
  for (let vuelta = 0; pendientes.length && vuelta < 50; vuelta += 1) {
    const oculto = az.pedidosOcultos(pendientes.shift());
    ejecutor = ejecutor || oculto.ejecutor;
    for (const i of oculto.ilegibles) {
      if (i.porTuberia) { tuberias.push(i); continue; }
      problemas.push({ seg: i.seg, verbo: 'interprete', faltas: [`${i.motivo}, así que no puedo leer sus banderas — y lo que no pude mirar no está aprobado`] });
      huboJuicio = true;
    }
    for (const t of oculto.textos.filter((x) => az.pareceAzPr(x))) {
      const segsDeAdentro = az.segmentos(t);
      juzgados += cuenta(segsDeAdentro);
      juzgarSegmentos(segsDeAdentro);
      pendientes.push(t);
    }
  }
  if (!problemas.length && az.mencionesDePedido(cmd) > juzgados) {
    const sinLeer = tuberias.length ? tuberias.map((i) => ({ seg: i.seg, motivo: i.motivo }))
      : (ejecutor ? [{ seg: az.segmentos(cmd)[0] || [], motivo: `el comando nombra un pedido que no se deja leer como tal, y \`${ejecutor}\` corre código` }] : []);
    for (const i of sinLeer) {
      problemas.push({ seg: i.seg, verbo: 'interprete', faltas: [`${i.motivo}, así que no puedo leer sus banderas — y lo que no pude mirar no está aprobado. Escribí el pedido con \`az\` directo`] });
      huboJuicio = true;
    }
  }
}

// 🔴 UNA DECISIÓN, UNA LÍNEA — y el veredicto es el que tuvo EL COMANDO, no cada segmento.
// Un comando con dos `pr create` —uno salteado y otro mal armado— escribiría `escape` Y `bloqueo`: dos
// decisiones donde hubo una, y el `escape` quedaría registrado como si algo hubiera pasado cuando
// el comando entero murió en 2 y no corrió nada. Por eso la constancia se escribe ACÁ, una sola vez,
// cuando ya se sabe qué decidió: si frenó es `bloqueo`, si no frenó pero hubo escape es `escape`, y si
// no frenó ni hubo escape es `paso`.
// Sólo se anota si el freno TUVO algo que decidir: juzgó un segmento, o se lo saltearon con el
// escape declarado. Un `--help`, un pull request que va a `dev` o un borrador no son decisiones.
if (huboJuicio || huboEscape) {
  constanciaFreno.anotar({
    freno: 'pr-sin-auto-complete', regla: 'sin-auto-complete',
    veredicto: problemas.length || problemasGh.length ? 'bloqueo' : (huboEscape ? 'escape' : 'paso'), cmd,
  });
}
if (problemasGh.length) {
  const detalleGh = problemasGh.map((p) => `  ${az.textoDe(p.seg).replace(/\s+/g, ' ').slice(0, 110)}\n${p.faltas.map((f) => `    · ${f}`).join('\n')}`).join('\n');
  console.error(`🔴 Este gh pr merge rompe cómo entra el pedido:
${detalleGh}

Un pedido entra con un commit de merge: los commits individuales quedan en la rama, y el tablero, los latidos de
retrospectiva y las notas de versión los identifican uno por uno. Lo abre y lo hace entrar el skill de merge:

  Skill(skill="tycon-merge-to-main", args="source=<rama> target=main")

A mano: \`gh pr merge <n> --merge\` (o \`--merge --auto\`). Para saltear este freno una sola vez, a propósito, el
prefijo va PEGADO al comando: TYCON_PR_BY_HAND=1 gh pr merge …`);
}
if (!problemas.length) process.exit(problemasGh.length ? 2 : 0);

const rama = problemas.map((p) => (p.verbo === 'create' ? az.flagDe(p.seg, 'source-branch', 's') : null)).find(Boolean) || '<rama>';
const detalle = problemas.map((p) => {
  const cabeza = az.textoDe(p.seg).replace(/\s+/g, ' ').slice(0, 110);
  const rotulo = p.verbo === 'create' ? 'CREAR' : (p.verbo === 'update' ? 'ACTUALIZAR' : 'NO PUEDO LEER');
  return `  ${rotulo}: ${cabeza}${cabeza.length >= 110 ? '…' : ''}\n${p.faltas.map((f) => `    · ${f}`).join('\n')}`;
}).join('\n');

const soloUpdates = problemas.every((p) => p.verbo === 'update');
// Las dos formas legítimas que el freno veía frenadas una y otra vez: el pedido que espera una aprobación (se crea en
// borrador) y el que se retiene apagando la entrada automática (el prefijo es su salida).
const esperaAprobacion = problemas.some((p) => p.verbo === 'create' && !az.esCierto(az.flagDe(p.seg, 'auto-complete')));
const retiene = problemas.some((p) => p.verbo === 'update' && az.esFalso(az.flagDe(p.seg, 'auto-complete')));
const formas = [
  esperaAprobacion ? 'Si el pedido espera una aprobación, crealo en borrador (`--draft true`) y, cuando se apruebe, publicalo con `--draft false --auto-complete true --squash false --delete-source-branch true` (el freno le pregunta la rama a Azure: desde dev, develop, main o master va `false`).' : null,
  retiene ? 'Para retener una entrega ya encolada (apagar la entrada automática), el prefijo es la salida: `TYCON_PR_BY_HAND=1` pegado a ese mismo `update`.' : null,
].filter(Boolean);
console.error(`🔴 Este pull request se está armando A MANO y no va a quedar bien${soloUpdates ? '' : ' (va a main)'}:
${detalle}

En los repos del equipo un pull request a main lo crea el skill de merge, que además del PR corre
el gate de build y tests y arma el mensaje que queda como descripción:

  Skill(skill="tycon-merge-to-main", args="source=${rama} target=main")

Si de verdad tiene que ir a mano, el comando lleva las tres banderas, explícitas:

  az repos pr create ... --source-branch <rama> --auto-complete true --squash false --delete-source-branch true

(\`--delete-source-branch false\` sólo desde dev, develop, main o master: las demás ramas se borran al entrar.)
${formas.length ? `\n${formas.join('\n')}\n` : ''}
Un borrador recién creado no se toca (sí al publicarlo). Para saltear este freno una sola vez, a
propósito —por ejemplo para retener una entrega apagando el auto-complete—, el prefijo va PEGADO al
comando; desde el entorno no vale, porque exportado quedaría permanente y en silencio:

  TYCON_PR_BY_HAND=1 az repos pr ...

Caso que lo motivó: un pull request del backend de un producto, 2026-09-03 — el skill sabía hacerlo bien y
nada obligaba a usarlo.`);
process.exit(2);
