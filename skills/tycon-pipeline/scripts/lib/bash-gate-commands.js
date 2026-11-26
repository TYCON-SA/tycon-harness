'use strict';
/**
 * bash-gate-commands.js — una parte de on-bash-write-gate.js, el freno de escrituras por consola.
 *
 * Responsabilidad: los comandos dentro de otros: los `sed` y las zonas que tocan, las carpetas de los `cd` y lo que borra un comando.
 *
 * El código viene de on-bash-write-gate.js tal cual, salvo dos reescrituras mecánicas: los `require` locales van
 * relativos a esta carpeta, y las rutas que salían de la carpeta de los guiones suben un nivel más. Cada parte carga
 * sólo las de abajo (la red primero; el despachador, todas).
 */

const fs = require('fs');
const path = require('path');
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
const { logHookError } = require('./bash-gate-net.js');
const { BORRA_O_MUEVE, LECTORES_DE_FIND, PREFIJO, PS_CON_VALOR, SED_W_EN_COMANDO, SED_W_EN_GUION, TOPE_ANIDADOS, blancoPorRedireccion, expandirLlaves, guionDeSedSinEfectos, guionesInternos, leadingCd, palabras, posicionesDeComando, programaDePerlSoloSustituye, programasSinProcesos, sinComillasDeLosBordes, textosCitados, tok } = require('./bash-gate-words.js');
const { CAT_O_TEE_REDEFINIDO, DETRAS_DE_LA_MARCA, EXPANSION_DE_VARIABLE, GRUPO_O_CONTROL, HEREDOC_ENTERO, LEE_EL_CUERPO_COMO_TEXTO, PALABRA_ANTES_DE_XARGS, REDIRECCION_A_DESCRIPTOR, SHELLS_CON_DASH_C, XARGS_CON_VALOR, ansiC, argumentosDeCopia, citados, citarParaElShell, comodinDelShell, comodinSimple, cuerpoConValores, expandirComodin, formatoDePrintf, guionDelShell, moverCds, nombreDeComando, ordenesDeFind, ordenesDeParallel, ordenesDeXargs, palabraDelShell, palabrasEnteras, pelarEnv, posicionales, renglonesDelShell, resolveTarget, sedConEfectos, shellLeeEntrada, sinCierre, sinComentarioAlFinal, sinPalabrasDelShell } = require('./bash-gate-expansions.js');
const { ANTES_DEL_CD_COMPLEJO, delimitadoresQueAbre, destinosArmados, extractWriteTargets, heredocs, heredocsCerrados, origenesMovidos, palabrasProfundas, quitarCuerposDeHeredoc, tramos } = require('./bash-gate-targets.js');

/**
 * La carpeta contra la que se resuelven los destinos relativos del comando. Sólo una forma se sigue:
 * `[VAR=literal; …;] [… &&] cd DIR && <escritura>`, con el primer `cd` del comando, todo lo de antes simple (ver
 * ANTES_DEL_CD_COMPLEJO), `DIR` resuelto sin `$(…)` ni opciones, un `&&` después y cada destino relativo adentro de esa
 * misma cadena de `&&` y antes de cualquier otro `cd`: si el `cd` falla, la escritura no corre, y un `cd` posterior no
 * cambia dónde cayó. Cualquier otra forma resuelve como antes de esta función: con el `cd` del principio (`leadingCd`),
 * salvo que un segundo `cd` venga antes de una escritura relativa, que resuelve contra la carpeta de la sesión.
 */
function cwdDelComando(cmd, baseCwd) {
  return resolverCd(cmd, baseCwd).dir;
}

/**
 * Las carpetas donde puede caer una escritura relativa del comando: una sola, salvo que sea ambiguo (un segundo `cd`
 * antes de una escritura relativa, fuera de la forma mínima). Ahí, la de la sesión, la del `cd` del principio y la de
 * cada `cd` que se pueda resolver (seguido del anterior, o desde la sesión).
 */
function carpetasDelComando(cmd, baseCwd) {
  const r = resolverCd(cmd, baseCwd);
  if (r.forma !== 'ambiguo') return [r.dir];
  const raw = String(cmd || '');
  const out = [baseCwd];
  const d = leadingCd(raw);
  if (d) out.push(resolveTarget(d, baseCwd));
  let previa = baseCwd;
  for (const m of r.s.matchAll(/\bcd[ \t]+(?:'([^']*)'|"([^"]*)"|([^\s;&|()<>'"`]+))/g)) {
    const tok = m[1] ?? m[2] ?? m[3];
    if (!tok || tok.startsWith('-')) continue;
    const ex = expandirRuta(raw.slice(0, m.index + m[0].length), tok);
    if (ex.sinResolver.length) continue;
    previa = resolveTarget(ex.valor, previa, process.platform, { homeVariable: true });
    out.push(previa, resolveTarget(ex.valor, baseCwd, process.platform, { homeVariable: true }));
  }
  return [...new Set(out)];
}

/** Los destinos relativos que escribe un tramo de un comando (con las variables de `raw`); null si alguno no se sabe. */
function relativosDe(raw, texto) {
  const armados = destinosArmados(texto);
  if (armados.some((a) => !a.literal && !a.literales)) return null;
  return [
    ...extractWriteTargets(texto, { keep: () => true }),
    ...destinosBorrados(texto).map((d) => d.raw),
    ...armados.flatMap((a) => (a.literal ? [a.literal] : a.literales)),
  ].filter((t) => { const v = expandirRuta(raw, t).valor; return !path.isAbsolute(v) && !/^~/.test(v) && !/^[A-Za-z]:[\\/]/.test(v); });
}

/** La decisión de `cwdDelComando`: `{ dir, forma: 'sin-cd'|'minima'|'hoy'|'ambiguo', s }`. */
function resolverCd(cmd, baseCwd) {
  const raw = String(cmd || '');
  // los cuerpos de heredoc, en blanco con su largo: las posiciones siguen siendo las del comando
  let s = raw;
  let cds = [];
  // como hoy: el cd del principio (`leadingCd`), salvo que un segundo cd venga antes de una escritura relativa (ahí no se
  // sabe en qué carpeta cae: ambiguo, y la de la sesión)
  const hoy = () => {
    const d = leadingCd(raw);
    if (cds.length > 1) {
      const despues = relativosDe(raw, raw.slice(cds[1].index));
      if (!despues || despues.length) return { dir: baseCwd, forma: 'ambiguo', s };
    }
    return d ? { dir: resolveTarget(d, baseCwd), forma: 'hoy', s } : { dir: baseCwd, forma: 'hoy', s };
  };
  try {
    s = raw.replace(/((?<!<)<<(?!<)(?<=(?:^|\n)(?:[^"'\n]|"[^"\n]*"|'[^'\n]*')*<<)(?<!\$\(\([^\n]*<<)-?[ \t]*(['"]?)([^\s'"<>;&|()$`\\-][^\s'"<>;&|()$`\\]*)\2(?=[\s;&|()<>]|$)[^\n]*\n)((?:[\s\S]*?\n)??)([ \t]*\3[ \t]*(?=\n|$))/g, (m, cab, _q, _d, cuerpo, cierre) => cab + cuerpo.replace(/[^\n]/g, ' ') + cierre);
    cds = [...s.matchAll(/\bcd\b/g)];
    if (!cds.length) return { dir: baseCwd, forma: 'sin-cd', s };
    const m = /(^|;|\n|&&)[ \t]*cd[ \t]+([^\s;&|()<>'"`\\]+)[ \t]*&&/.exec(s.slice(Math.max(0, cds[0].index - 3)));
    if (!m) return hoy();
    const enCd = Math.max(0, cds[0].index - 3) + m.index + m[1].length;
    const antes = raw.slice(0, enCd);
    if (ANTES_DEL_CD_COMPLEJO.test(antes)) return hoy();
    const dirRaw = m[2];
    if (dirRaw.startsWith('-') || dirRaw.includes('$(')) return hoy();
    const ex = expandirRuta(antes + 'cd ' + dirRaw, dirRaw);
    if (ex.sinResolver.length) return hoy();
    const dir = resolveTarget(ex.valor, baseCwd, process.platform, { homeVariable: true });
    // el fin de la cadena de `&&` que arranca en el cd: el primer `;`, `||`, `|`, `&` suelto o fin de línea fuera de
    // comillas y de paréntesis (un heredoc se saltea entero: su cuerpo es parte del comando que lo abre)
    const desde = Math.max(0, cds[0].index - 3) + m.index + m[0].length;
    let fin = raw.length;
    let q = null;
    let nivel = 0;
    const pendientes = [];
    for (let i = desde; i < raw.length; i++) {
      const c = raw[i];
      if (q) { if (c === '\\' && q !== "'") i++; else if (c === q) q = null; continue; }
      if (c === "'" || c === '"' || c === '`') { q = c; continue; }
      if (c === '(') { nivel++; continue; }
      if (c === ')') { nivel--; continue; }
      const h = /^<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\1/.exec(raw.slice(i, i + 80));
      if (h) { pendientes.push(h[2]); i += h[0].length - 1; continue; }
      if (c === '\n' && pendientes.length) {
        let j = i;
        while (pendientes.length) {
          const del = pendientes.shift();
          const cierre = new RegExp(`\\n[ \\t]*${del}[ \\t]*(?=\\n|$)`).exec(raw.slice(j));
          if (!cierre) return hoy();
          j += cierre.index + cierre[0].length;
        }
        i = j - 1;
        continue;
      }
      if (nivel > 0) continue;
      if (c === ';' || c === '\n' || c === '|' || (c === '&' && raw[i + 1] !== '&' && raw[i - 1] !== '&')) { fin = i; break; }
    }
    if (q || nivel !== 0) return hoy();
    // un segundo cd corta la cadena: lo que viene después ya no se sabe dónde cae
    if (cds.length > 1) fin = Math.min(fin, cds[1].index);
    const cadena = relativosDe(raw, raw.slice(desde, fin));
    const resto = relativosDe(raw, raw.slice(0, enCd) + '\n' + raw.slice(fin));
    const todos = relativosDe(raw, raw);
    if (!cadena || !resto || !todos) return hoy();
    // cada destino relativo del comando se escribe adentro de la cadena del cd, y nada fuera de ella escribe uno relativo
    return resto.length === 0 && todos.every((t) => cadena.includes(t)) ? { dir, forma: 'minima', s } : hoy();
  } catch (e) {
    logHookError(e);
    try { return hoy(); } catch (_e) { return { dir: baseCwd, forma: 'ambiguo', s }; }
  }
}

/**
 * Lo que el comando borra (`rm`, `del`, `Remove-Item` y sus alias, `git rm`) o deshace (`git checkout [<ref>] [--]
 * <ruta>`, `git restore <ruta>`): `[{ raw, kind: 'delete'|'restore', base?, quizas?, git? }]`. `base` es la carpeta de un
 * `git -C`. `quizas`: un `git checkout <nombre>` sin `--`, que es una ruta si existe y si no una rama. `git`: lo borra un
 * `git rm`, que deja el borrado en el índice. Lo que sólo toca el
 * índice (`git restore --staged`, `git rm --cached`) no cambia el archivo. Se lee también lo que corre adentro
 * (`$(…)`, comillas invertidas, `sh -c`) y detrás de las palabras del shell (`{`, `if`, `!`, `time`…).
 */
function destinosBorrados(cmd) {
  const out = [];
  for (const tramo of [String(cmd || ''), ...anidadosHasta(cmd).leidos].flatMap((t) => tramos(t))) {
    const sinComentario = blancoPorRedireccion(tramo.replace(/(^|\s)#.*$/, ''));
    const words = palabras(sinPalabrasDelShell(sinComentario)).filter((w) => w !== '').map((w) => w.replace(/\)+$/, '')).filter(Boolean);
    if (!words.length) continue;
    const c = path.basename(words[0].replace(/^\\/, '')).toLowerCase().replace(/\.exe$/, '');
    if (['rm', 'del', 'erase', 'remove-item', 'ri', 'rmdir', 'rd', 'unlink'].includes(c)) {
      for (let i = 1; i < words.length; i++) {
        const w = words[i];
        if (/^-(?:path|literalpath)$/i.test(w)) { if (words[i + 1]) out.push({ raw: words[++i], kind: 'delete' }); continue; }
        if (PS_CON_VALOR.test(w)) { i++; continue; }
        if (w.startsWith('-') || /^\/[a-z]$/i.test(w)) continue;
        out.push({ raw: w, kind: 'delete' });
      }
      continue;
    }
    if (c !== 'git') continue;
    // las opciones de git antes del subcomando; `-C <carpeta>` cambia contra qué se resuelven las rutas
    let i = 1;
    let base = null;
    while (i < words.length && words[i].startsWith('-')) {
      if (words[i] === '-C') { base = base ? `${base}/${words[i + 1]}` : words[i + 1]; i += 2; continue; }
      if (words[i] === '-c' || words[i] === '--git-dir' || words[i] === '--work-tree' || words[i] === '--namespace') { i += 2; continue; }
      i++;
    }
    const sub = words[i];
    const resto = words.slice(i + 1);
    const con = (raw, kind, extra) => out.push({ raw, kind, ...(base ? { base } : {}), ...extra });
    if (sub === 'rm') {
      if (resto.includes('--cached')) continue;
      for (const w of resto) if (!w.startsWith('-')) con(w, 'delete', { git: true });
    } else if (sub === 'checkout') {
      if (resto.some((w) => /^-(?:b|B|-orphan|-detach)$/.test(w))) continue;
      const corte = resto.indexOf('--');
      if (corte >= 0) { for (const w of resto.slice(corte + 1)) con(w, 'restore'); continue; }
      const sueltos = resto.filter((w) => !w.startsWith('-'));
      // `git checkout <ref> <ruta>…`: lo que sigue al primero son rutas; uno solo puede ser una rama o una ruta
      if (sueltos.length >= 2) for (const w of sueltos.slice(1)) con(w, 'restore');
      if (sueltos.length) con(sueltos[0], 'restore', { quizas: true });
    } else if (sub === 'restore') {
      if (resto.some((w) => w === '--staged' || w === '-S') && !resto.some((w) => w === '--worktree' || w === '-W')) continue;
      for (let k = 0; k < resto.length; k++) {
        if (resto[k] === '--source' || resto[k] === '-s') { k++; continue; }
        if (resto[k] === '--' || resto[k].startsWith('-')) continue;
        con(resto[k], 'restore');
      }
    }
  }
  return out;
}

// `cd <carpeta> && ` al principio exacto del comando, con la carpeta hecha sólo de letras, cifras y `_ . / + , -` (puede
// empezar con `~/`; nada que bash o zsh expandan, como `~+`, `~-` o `~usuario`), seguido de UN `sed` que nombra sus archivos: ni tubería,
// ni `$(…)`, ni comillas invertidas, ni otro comando, ni redirección, ni salto de línea, ni llaves, `@` o `~` (nombres
// que el shell expande, `{a,b}.md`, `~+/a.md`). Un `perl -e` es un programa entero, que puede armar y escribir sus
// archivos desde adentro (`BEGIN{@ARGV=glob …}`): es esta forma sólo como `CD_PERL`. Cualquier otra forma no es ésta: un
// editor que toma sus archivos de una tubería (`ls | xargs sed -i`) o de `$(ls)` escribe en la carpeta del `cd`, y esa
// carpeta es lo único que la nombra.
const CD_INICIAL = /^cd ((?:~\/)?[\w./+,][\w./+,-]*) && sed [^\n|;&<>`${}@~]*$/;

// La misma forma con UN `perl` en el lugar: opciones escritas tal cual, un solo programa entre comillas simples sin `$`,
// `@`, llaves ni comillas invertidas, y la carpeta y los archivos hechos sólo de letras, cifras y `_ . / + , -` (la
// carpeta puede empezar con `~/`): nada que bash o zsh expandan (`~+`, `~usuario`, `^`, `#`, `=`). Nada antes del `cd` ni
// después de los archivos: dentro del comando no hay dónde cambiar el ambiente de perl ni qué programa se llama así. Las
// opciones y el programa los mira `cdInicial`.
const CD_PERL = /^cd ((?:~\/)?[\w./+,][\w./+,-]*) && perl((?: -[A-Za-z0-9.]+)*) -([pl0-9]*)e '([^'\n$@{}`]*)'((?: [\w./+,][\w./+,-]*)+)$/;

/**
 * La forma de `CD_INICIAL` o de `CD_PERL`: `{ carpeta, archivos }`, con la carpeta del `cd` y, en la de perl, los archivos
 * que escribe (en la de sed, null: los dice `sedsLiterales`); o null si el comando no tiene ninguna de las dos. En la de
 * perl, las opciones tienen que editar en el lugar e imprimir (`-i`, sin sufijo o con uno que empieza con punto y no
 * termina en `md`; `-p`; `-0` y `-l` también; nada más: ni `-n`, `-M`, `-I`, `-x`, `-d`), y el programa tiene que ser sólo
 * sustituciones (`programaDePerlSoloSustituye`). Con `CDPATH` puesto, un `cd` relativo puede ir a otra carpeta: no es
 * ninguna de las dos formas.
 */
function cdInicial(cmd) {
  const s = String(cmd || '');
  const relativoConCdpath = (carpeta) => Boolean(process.env.CDPATH) && !/^(?:\/|~\/)/.test(carpeta);
  const sed = CD_INICIAL.exec(s);
  if (sed) return relativoConCdpath(sed[1]) ? null : { carpeta: sed[1], archivos: null };
  const p = CD_PERL.exec(s);
  if (!p || relativoConCdpath(p[1])) return null;
  const opciones = [...p[2].split(' ').filter(Boolean), ...(p[3] ? [`-${p[3]}`] : [])];
  let enLugar = false;
  let imprime = false;
  for (const w of opciones) {
    const m = /^-([pl0-9]*)(?:(i)(\.[\w.-]*)?)?$/.exec(w);
    if (!m || w === '-' || (m[3] && /md$/i.test(m[3]))) return null;
    if (/[0-9]/.test(m[1]) && !/^[pl]*0[0-7]*[pl]*$/.test(m[1])) return null;
    if (m[1].includes('p')) imprime = true;
    if (m[2]) enLugar = true;
  }
  if (!enLugar || !imprime || !programaDePerlSoloSustituye(p[4])) return null;
  return { carpeta: p[1], archivos: p[5].split(' ').filter(Boolean) };
}

/**
 * Las palabras que un editor en el lugar puede escribir: las de `palabrasProfundas`, sin las que tienen espacios. Con
 * la forma de `CD_INICIAL`, la carpeta del `cd` sale de la lista por su posición —la segunda palabra, después de `cd`—:
 * es la base desde la que se resuelven las demás, no algo que el editor escribe. La misma carpeta nombrada otra vez más
 * adelante sigue en la lista. Con la de `CD_PERL`, son sólo sus archivos: las palabras del programa no son destinos.
 */
function palabrasDelEditor(cmd) {
  const cd = cdInicial(cmd);
  if (cd && cd.archivos) return cd.archivos;
  const ws = palabrasProfundas(cmd).filter((w) => !/\s/.test(w));
  if (cd && ws[0] === 'cd' && ws[1] === cd.carpeta) ws.splice(1, 1);
  return ws;
}

/**
 * Lo que corre adentro del comando, nivel por nivel (`guionesInternos`, sin el texto de los heredocs que nadie corre):
 * `{ leidos, hondos }`. `leidos`, hasta `TOPE_ANIDADOS` niveles; `hondos`, lo del nivel siguiente, que no se lee.
 */
function anidadosHasta(cmd) {
  const leidos = [];
  const hondos = [];
  const ver = (texto, nivel) => {
    for (const g of guionesInternos(sinCuerposDeTexto(texto))) {
      if (!String(g).trim()) continue;
      if (nivel >= TOPE_ANIDADOS) { hondos.push(g); continue; }
      leidos.push(g);
      ver(g, nivel + 1);
    }
  };
  ver(String(cmd || ''), 0);
  return { leidos, hondos };
}

/** Lo que borra cada tramo, también los de adentro de `bash -c '…'`, y lo que recorre un `find` que borra. */
function borradosProfundos(cmd) {
  const out = [];
  const ver = (texto, nivel) => {
    for (const d of destinosBorrados(texto)) out.push(d);
    for (const raw of origenesMovidos(texto)) out.push({ raw });
    for (const tramo of tramos(texto)) {
      const words = palabras(tramo.trim().replace(PREFIJO, '')).filter((w) => w !== '');
      const lee = new RegExp(`^${LECTORES_DE_FIND}`);
      const borraEnFind = words.some((w, k) => w === '-delete' || (/^-exec(?:dir)?$/.test(w) && !lee.test(words[k + 1] || '')));
      if (path.basename(words[0] || '').toLowerCase() === 'find' && borraEnFind) {
        for (const w of words.slice(1)) { if (w.startsWith('-') || w === '!' || w === '(') break; out.push({ raw: w }); }
      }
      const citados = textosCitados(tramo, cmd);
      if (nivel < 2) for (const w of palabras(tramo)) if (/\s/.test(w) && !citados.has(w)) ver(w, nivel + 1);
    }
  };
  ver(cmd, 0);
  return out;
}

/**
 * Los marcadores de la ejecución (`<estado>/active/`, `<estado>/active.json`) que el comando puede borrar o mover:
 * `[ruta o texto]`. La regla: un comando que borra o mueve algo y nombra un marcador frena. Nombrarlo es una palabra
 * que, expandida (variables, `~`, llaves), cae en uno o en su carpeta, o un texto que lo nombra por la carpeta del estado
 * (`'/.claude/.tycon-pipeline/active/x.json'` armado en un guion). Una carpeta de arriba (`rm -rf ~/.claude`) cuenta
 * sólo si es lo que el comando borra o recorre.
 */
function marcadoresTocados(cmd, cwd, stateDir) {
  const installedTree = require('./installed-tree.js');
  const registros = [stateDir, installedTree.realPath(stateDir)].filter(Boolean).map((b) => path.join(b, 'gates.log'));
  // el registro de aperturas (`gates.log`) y la copia de una apertura (`.advisors/pipeline-runs/<carpeta>/run-open.json`):
  // las otras dos piezas de una ejecución abierta (lib/open-runs.js)
  const pieza = (r) => registros.includes(r) || (path.basename(r) === 'run-open.json' && path.basename(path.dirname(path.dirname(r))) === 'pipeline-runs');
  return zonaTocada(cmd, cwd, stateDir, { carpeta: 'active', nombres: ['active', 'active.json'], pieza });
}

/**
 * Lo que el comando borra o mueve del registro de las aprobaciones de la persona (`owner-approvals/`, de cualquier
 * estado): lo gastado está en `usadas/`, y borrarlo devuelve una aprobación ya usada. Sin interruptor.
 */
function aprobacionesTocadas(cmd, cwd, stateDir) {
  const { isOwnerApprovalsRecord } = require('./story-gate.js');
  // el nombre alcanza donde la ruta no se puede resolver: un guion que la arma por partes, una variable, o una relativa con
  // un `cd` adelante. Una ruta que se lee sola se resuelve, y una carpeta de un producto que se llama igual no es el registro
  const conCd = /(^|[;&|(\s])(?:cd|pushd)\s/.test(String(cmd || ''));
  const noSeResuelve = (t) => /[\s$`(),'"]/.test(t) || (conCd && !/^(?:\/|~)/.test(t));
  return zonaTocada(cmd, cwd, stateDir, { carpeta: 'owner-approvals', nombres: ['owner-approvals'], pieza: isOwnerApprovalsRecord,
    enTexto: (t) => noSeResuelve(t) && /(^|[^\w.-])owner-approvals(?![\w.-])/i.test(t) });
}

/**
 * Lo que el comando borra o mueve de las marcas de las constancias dadas en la terminal (`terminal-acknowledgments/`, de
 * cualquier estado): sin la marca, una constancia de Codex no vale, y una puesta a mano la finge. Sin interruptor.
 */
function marcasDeTerminalTocadas(cmd, cwd, stateDir) {
  const { isTerminalAcknowledgmentsRecord } = require('./story-gate.js');
  const conCd = /(^|[;&|(\s])(?:cd|pushd)\s/.test(String(cmd || ''));
  const noSeResuelve = (t) => /[\s$`(),'"]/.test(t) || (conCd && !/^(?:\/|~)/.test(t));
  return zonaTocada(cmd, cwd, stateDir, { carpeta: 'terminal-acknowledgments', nombres: ['terminal-acknowledgments'], pieza: isTerminalAcknowledgmentsRecord,
    enTexto: (t) => noSeResuelve(t) && /(^|[^\w.-])terminal-acknowledgments(?![\w.-])/i.test(t) });
}

/**
 * Lo que el comando borra o mueve del registro de las sesiones que abrió la coordinadora (`coordination/launched.json`, de
 * cualquier estado): sacar un renglón deja a esa sesión preguntarle a la persona. Sin interruptor.
 */
function lanzadasTocadas(cmd, cwd, stateDir) {
  const { isLaunchedSessionsRecord } = require('./story-gate.js');
  const conCd = /(^|[;&|(\s])(?:cd|pushd)\s/.test(String(cmd || ''));
  const noSeResuelve = (t) => /[\s$`(),'"]/.test(t) || (conCd && !/^(?:\/|~)/.test(t));
  return zonaTocada(cmd, cwd, stateDir, { carpeta: path.join('coordination', 'launched.json'), nombres: [path.join('coordination', 'launched.json')], pieza: isLaunchedSessionsRecord,
    enTexto: (t) => noSeResuelve(t) && /(^|[^\w.-])coordination[\\/]launched\.json(?![\w.-])/i.test(t) });
}

/**
 * Lo que el comando borra o mueve del buzón de la oficina (`office/inbox`, `tomados`, `usados` y el registro, de cualquier
 * estado): borrar lo usado devuelve un mensaje ya gastado, y mover algo al buzón finge uno de la persona. Sin interruptor.
 */
function buzonTocado(cmd, cwd, stateDir) {
  const { isOfficeMailboxRecord } = require('./story-gate.js');
  const conCd = /(^|[;&|(\s])(?:cd|pushd)\s/.test(String(cmd || ''));
  const noSeResuelve = (t) => /[\s$`(),'"]/.test(t) || (conCd && !/^(?:\/|~)/.test(t));
  const { isInside } = require('./atdd-preedit.js');
  const installedTree = require('./installed-tree.js');
  const oficinas = [...new Set([stateDir, installedTree.realPath(stateDir)].filter(Boolean))].map((b) => path.join(b, 'office'));
  // por la ruta (el estado de cualquier cuenta) o por estar en el buzón de este estado, se llame como se llame su carpeta
  const pieza = (r) => isOfficeMailboxRecord(r) || oficinas.some((o) => r === path.join(o, 'messages.jsonl') || r === path.join(o, 'messages.jsonl.1')
    || ['inbox', 'tomados', 'usados', 'vigilantes'].some((n) => r === path.join(o, n) || isInside(path.join(o, n), r)));
  return zonaTocada(cmd, cwd, stateDir, { carpeta: path.join('office', 'inbox'), nombres: ['office'], pieza,
    enTexto: (t) => noSeResuelve(t) && /(^|[^\w.-])office[\\/](?:inbox|tomados|usados|vigilantes|messages\.jsonl(?:\.1)?)(?![\w.-])/i.test(t) });
}

/**
 * Lo que el comando borra o mueve del registro de los críticos que reportaron los revisores (`reported-criticals/`, de
 * cualquier estado): borrar un renglón es borrar lo que dijo un revisor. Sin interruptor.
 */
function criticosTocados(cmd, cwd, stateDir) {
  const { isReportedCriticalsRecord } = require('./story-gate.js');
  const conCd = /(^|[;&|(\s])(?:cd|pushd)\s/.test(String(cmd || ''));
  const noSeResuelve = (t) => /[\s$`(),'"]/.test(t) || (conCd && !/^(?:\/|~)/.test(t));
  return zonaTocada(cmd, cwd, stateDir, { carpeta: 'reported-criticals', nombres: ['reported-criticals'], pieza: isReportedCriticalsRecord,
    enTexto: (t) => noSeResuelve(t) && /(^|[^\w.-])reported-criticals(?![\w.-])/i.test(t) });
}

/**
 * Lo que el comando borra o mueve del registro de corridas de los revisores (`advisor-runs/`, de cualquier estado): el
 * cierre lo lee para ver lo que dijo un revisor fuera del registro de críticos, y borrarlo es saltear esa revisión. El
 * subcomando `pipeline.js advisor-runs` no es una ruta y no cuenta. Sin interruptor.
 */
function corridasDeRevisoresTocadas(cmd, cwd, stateDir) {
  const { isAdvisorRunsRecord } = require('./story-gate.js');
  // `pipeline.js advisor-runs` es un subcomando que lee el registro, no una ruta: se saca antes de buscar la palabra
  // (sólo si `pipeline.js` es lo que corre node: `rm pipeline.js advisor-runs` borra la carpeta)
  // (con opciones de node antes del guion, y con la ruta entre comillas si tiene espacios)
  cmd = String(cmd || '').replace(/(\bnode(?:\.exe)?["']?(?:\s+-{1,2}[\w-]+(?:=[^\s;&|]*)?)*\s+(?:"[^"]*pipeline\.js"|'[^']*pipeline\.js'|[^\s;&|'"]*pipeline\.js)\s+)advisor-runs(?![\w.\/-])/gi, '$1(subcomando)');
  const conCd = /(^|[;&|(\s])(?:cd|pushd)\s/.test(cmd);
  const noSeResuelve = (t) => /[\s$`(),'"]/.test(t) || (conCd && !/^(?:\/|~)/.test(t));
  return zonaTocada(cmd, cwd, stateDir, { carpeta: 'advisor-runs', nombres: ['advisor-runs'], pieza: isAdvisorRunsRecord,
    enTexto: (t) => noSeResuelve(t) && /(^|[^\w.-])advisor-runs(?![\w.-])/i.test(t) });
}

/**
 * Lo que el comando borra o mueve de la revisión automática del plan (`plan-review/`, de cualquier estado): el pedido, el
 * resultado del corredor y la constancia con el veredicto. Moverlo o borrarlo deja otra constancia en su lugar. Lo que
 * se escribe ahí lo frena el freno del estado; pasan sólo `marker.js plan-review` y el corredor del pase del arnés
 * (`corredorDelPase`). Sin interruptor.
 */
function revisionDelPlanTocada(cmd, cwd, stateDir) {
  const { isPlanReviewRecord } = require('./story-gate.js');
  const conCd = /(^|[;&|(\s])(?:cd|pushd)\s/.test(String(cmd || ''));
  const noSeResuelve = (t) => /[\s$`(),'"]/.test(t) || (conCd && !/^(?:\/|~)/.test(t));
  return zonaTocada(cmd, cwd, stateDir, { carpeta: 'plan-review', nombres: ['plan-review'], pieza: isPlanReviewRecord,
    enTexto: (t) => noSeResuelve(t) && /(^|[^\w.-])plan-review[\\/](?![\w.-]*\.md\b)/i.test(t) });
}

/**
 * Lo que el comando borra o mueve de una zona del estado: `carpeta` y `nombres` adentro del estado, o lo que `pieza` dice.
 * `enTexto`: cuándo un texto la nombra sin que la ruta se pueda resolver (un guion que la arma por partes); sin él, el nombre de la carpeta del estado.
 */
function zonaTocada(cmd, cwd, stateDir, { carpeta, nombres, pieza, enTexto = null }) {
  if (!BORRA_O_MUEVE.test(String(cmd || ''))) return [];
  // un `git checkout|restore|rm` dice sus rutas (destinosBorrados las lee una por una): si es lo único que borra, el
  // nombre de la carpeta del estado suelto en otro lado del comando (`gh … --json state`) no es lo que borra
  const sinGitLeido = String(cmd).replace(/\bgit\b[^\n;&|$`<>]*\s(?:checkout|restore|rm)\b[^\n;&|$`<>]*/gi, ' ');
  const porTexto = BORRA_O_MUEVE.test(sinGitLeido);
  const { isInside } = require('./atdd-preedit.js');
  const installedTree = require('./installed-tree.js');
  const bases = [...new Set([stateDir, installedTree.realPath(stateDir)].filter(Boolean))];
  const alcanza = (seg) => expandirLlaves(seg).some((s) => nombres.includes(s)
    || (/[*?[]/.test(s) && nombres.some((n) => comodinDelShell(s).test(n))));
  // la ruta cae en la zona; `arriba`: también una carpeta que la contiene
  const toca = (abs, arriba) => {
    const reales = [...new Set([abs, installedTree.realPath(abs)].filter(Boolean))];
    if (reales.some(pieza)) return true;
    return bases.some((b) => {
      const activos = path.join(b, carpeta);
      return reales.some((r) => {
        if (nombres.some((n) => r === path.join(b, n)) || isInside(activos, r)) return true;
        if (arriba && isInside(r, activos)) return true;
        const dir = path.dirname(r);
        if (!/[*?[]/.test(path.basename(r))) return false;
        // un comodín: en active/, o al lado de active y active.json, o (si es lo borrado) en una carpeta de arriba
        if (dir === activos || isInside(activos, dir)) return true;
        if (dir === b) return alcanza(path.basename(r));
        return arriba && isInside(dir, activos) && comodinDelShell(path.basename(r)).test(path.relative(dir, activos).split(path.sep)[0]);
      });
    });
  };
  const resolver = (raw, base) => {
    const desde = base ? resolveTarget(expandirRuta(cmd, base).valor, cwd, process.platform, { homeVariable: true }) : cwd;
    return resolveTarget(expandirRuta(cmd, raw).valor, desde, process.platform, { homeVariable: true });
  };
  // el nombre de la carpeta del estado en un texto, seguido de nada o de algo que alcanza a un marcador
  const nombre = path.basename(stateDir);
  const nombraPorTexto = (t) => {
    for (let i = t.indexOf(nombre); i >= 0; i = t.indexOf(nombre, i + 1)) {
      if (/[\w.-]/.test(t[i - 1] || '')) continue;
      const resto = t.slice(i + nombre.length);
      if (!resto || /^[\s'"`)]/.test(resto)) return true;
      if (!/^[\\/]/.test(resto)) continue;
      const seg = resto.replace(/^[\\/]+/, '').split(/[\\/\s'"`)]/)[0];
      if (!seg || alcanza(seg)) return true;
    }
    return false;
  };
  const out = [];
  // una palabra repetida contesta lo mismo: se mira una vez, y una tira de `!|` no resuelve la misma ruta miles de veces
  const vistas = new Set();
  for (const w of palabrasProfundas(cmd)) {
    if (vistas.has(w)) continue;
    vistas.add(w);
    // `enTexto`: la zona dice cómo se la nombra; el nombre suelto de la carpeta del estado no habla de ella
    if (porTexto && (enTexto ? enTexto(w) : nombraPorTexto(w))) { out.push(w); continue; }
    if (/\s/.test(w)) continue;
    for (const x of expandirLlaves(w)) {
      const abs = resolver(x);
      if (toca(abs, false)) { out.push(abs); continue; }
      // un comodín en una carpeta del medio (`~/.claude/.tycon-p*/active`): lo que nombra en el disco
      if (/[*?[]/.test(path.dirname(abs))) for (const r of expandirComodin(abs, cwd)) if (toca(r, false)) out.push(r);
    }
  }
  for (const d of borradosProfundos(cmd)) {
    for (const x of expandirLlaves(d.raw)) { const abs = resolver(x, d.base); if (toca(abs, true)) out.push(abs); }
  }
  return [...new Set(out)];
}

// ── una historia no se escribe por consola ────────────────────────────────────────────────────────────────────────────

/**
 * ¿Algún tramo edita en el lugar los archivos que nombra? `sed`/`perl`/`ruby` con una opción que lleva `i` (`-i`,
 * `-ibak`, `-0pi`, `--in-place`), `awk -i inplace`, `ed` o `ex`. Se lee por palabras con sus comillas (un `;` o un `|`
 * dentro del guion de `sed` no corta) y también detrás de `xargs`, `find -exec`, las palabras del shell (`{`, `if`…) y
 * adentro de `bash -c '…'`, `$(…)` y las comillas invertidas. El programa de un `node -e '…'` que no puede correr
 * otro proceso, en un comando donde nada corre lo que imprime o escribe, no se lee como comandos: un `sed -i` adentro
 * de uno de sus textos es texto (`programasSinProcesos`).
 */
function editaEnSitio(cmd) {
  const opcionI = (w) => /^-[A-Za-z0-9]*i/.test(w) || /^--in-place\b/.test(w);
  const programas = programasSinProcesos(cmd);
  const ver = (texto, nivel) => {
    for (const tramo of tramos(texto)) {
      const words = palabras(sinPalabrasDelShell(tramo)).filter((w) => w !== '');
      for (let k = 0; k < words.length; k++) {
        const c = path.basename(words[k]).toLowerCase().replace(/\.exe$/, '');
        // el resto de las palabras sólo para los que editan: copiarlo por cada palabra crece con el cuadrado del tramo
        if (!['sed', 'gsed', 'perl', 'ruby', 'awk', 'gawk', 'ed', 'ex'].includes(c)) continue;
        const resto = words.slice(k + 1);
        if (['sed', 'gsed', 'perl', 'ruby'].includes(c) && resto.some(opcionI)) return true;
        if (['sed', 'gsed'].includes(c) && sedConEfectos(resto)) return true;
        if (['awk', 'gawk'].includes(c) && resto.some((w, j) => w === '-iinplace' || (w === '-i' && resto[j + 1] === 'inplace'))) return true;
        if (k === 0 && (c === 'ed' || c === 'ex')) return true;
      }
      const citados = textosCitados(tramo, cmd);
      if (nivel < 2) for (const w of words) if (/\s/.test(w) && !citados.has(w) && !programas.has(w) && ver(w, nivel + 1)) return true;
    }
    return false;
  };
  return [String(cmd || ''), ...anidadosHasta(cmd).leidos].some((t) => ver(t, 0));
}

/**
 * Lo que escriben los guiones de un `sed`: los de la línea (`-e`, `--expression`, `--expression=…` o el primer
 * argumento) y los de archivo (`-f x.sed`, `--file=x.sed`), leídos desde cada carpeta donde puede correr el comando. Un
 * guion de archivo que no se puede leer (llega por la entrada con `-f -` o `/dev/stdin`, o lo escribe el mismo comando)
 * se busca en el texto del comando, donde va su heredoc o lo que lo escribe. Leer de más no frena nada: sólo cuenta lo
 * que resulta ser una historia.
 */
function destinosDeGuionDeSed(cmd, bases) {
  const out = [];
  let buscarEnElComando = false;
  for (const tramo of tramos(cmd)) {
    const words = palabras(tramo.trim().replace(PREFIJO, '')).filter((w) => w !== '');
    const k = words.findIndex((w) => ['sed', 'gsed'].includes(path.basename(w).toLowerCase()));
    if (k < 0) continue;
    const deArchivo = [];
    const enLinea = [];
    let posicional = null;
    for (let j = k + 1; j < words.length; j++) {
      const w = words[j];
      if (w === '-f' || w === '--file') { if (words[j + 1] != null) deArchivo.push(words[++j]); continue; }
      if (w === '-e' || w === '--expression') { if (words[j + 1] != null) enLinea.push(words[++j]); continue; }
      // el valor citado de `--file=` y `--expression=` puede llegar pegado o como la palabra que sigue
      const conValor = /^--(file|expression)=(.*)$/s.exec(w);
      if (conValor) {
        const v = sinComillasDeLosBordes(conValor[2]);
        const valor = v !== '' ? v : words[++j];
        if (valor != null) (conValor[1] === 'file' ? deArchivo : enLinea).push(valor);
        continue;
      }
      const corta = /^-([A-Za-z]*?)([fe])(.*)$/s.exec(w);
      if (corta && !w.startsWith('--')) {
        const valor = corta[3] !== '' ? corta[3] : words[++j];
        if (valor != null) (corta[2] === 'f' ? deArchivo : enLinea).push(valor);
        continue;
      }
      if (w.startsWith('-') && w !== '-') continue;
      if (posicional == null) posicional = w;
    }
    if (!deArchivo.length && !enLinea.length && posicional != null) enLinea.push(posicional);
    for (const g of enLinea) for (const m of String(g).matchAll(SED_W_EN_GUION)) out.push(m[1].trim());
    for (const g of deArchivo) {
      let leido = false;
      if (g !== '-' && !/^\/dev\/(?:stdin|fd\/0)$/.test(g)) {
        for (const base of bases) {
          let texto;
          try { texto = fs.readFileSync(resolveTarget(g, base, process.platform, { homeVariable: true }), 'utf8'); } catch { continue; }
          leido = true;
          for (const m of texto.matchAll(SED_W_EN_GUION)) out.push(m[1].trim());
        }
      }
      if (!leido) buscarEnElComando = true;
    }
  }
  if (buscarEnElComando) for (const m of String(cmd).matchAll(SED_W_EN_COMANDO)) out.push(m[1]);
  return out;
}

/**
 * Las palabras de un tramo como las arma el shell, con los pedazos citados pegados en una sola (`'a'"'"'b'` es `a'b`,
 * como lo escribe quien cierra la comilla simple para meter una): `{ words, conVariable }`, con los índices de las
 * palabras que llevan una variable. Lo lee el lector de comandos de `marker-command.js`. Una palabra con una variable
 * vale sólo si `palabras` la lee igual (`"$f"`, `$f/a.sh`): pegada a otro pedazo (`"$s"x.md`) el nombre de la variable
 * no se sabe dónde termina, y entonces null. null también si el lector no lo deja en un solo tramo sin heredocs.
 */
function palabrasDelSed(texto) {
  let r;
  try { r = require('./marker-command.js').tramos(String(texto), 'bash'); } catch (e) { logHookError(e); return null; }
  if (!r || r.abierta || r.subs.length || r.tramos.length !== 1 || r.tramos[0].heredocs.length) return null;
  const viejas = new Set(palabras(texto));
  const words = [];
  const conVariable = new Set();
  for (const p of r.tramos[0].palabras) {
    if (!p.literal) {
      if (!viejas.has(p.texto)) return null;
      conVariable.add(words.length);
    }
    words.push(p.texto);
  }
  return { words, conVariable };
}

/**
 * Los `sed` en el lugar de un comando cuando todos nombran sus archivos: `[{ sed, opciones, guiones, archivo }]`, con el
 * archivo como palabra (una variable del comando ya resuelta) o como un comodín simple (`comodinSimple`), que se expande
 * desde cada carpeta donde puede correr. null si algún editor en el lugar no es así: un `perl`/`ruby`/`awk`/`ed`, un
 * `sed` detrás de `xargs`, `find -exec`, un `for` o adentro de `bash -c`, un archivo con otro comodín, llaves, `~+`,
 * `$(…)` o una variable que no se resuelve, un guion que lee, escribe o corre algo aparte, o una opción que no se
 * conoce. Con esa forma, lo que el editor escribe es sólo lo que nombra.
 */
function sedsLiterales(cmd) {
  if (FOR_IN.test(String(cmd || ''))) return null;
  const opcionI = (w) => /^-[A-Za-z0-9]*i/.test(w) || /^--in-place\b/.test(w);
  const bsd = process.platform === 'darwin';
  const out = [];
  for (const tramo of tramos(cmd)) {
    // un `$(…)`, comillas invertidas o un subshell (`(cd x && sed -i … a.sh)`): el paréntesis queda pegado a la ruta y
    // el carril de código no la reconoce, así que no es la forma
    const sinComillas = tramo.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '');
    if (/\$\(|`|[()]/.test(sinComillas)) { if (editaEnSitio(tramo)) return null; continue; }
    const sinRedir = tramo.trim().replace(PREFIJO, '').replace(/[ \t]*(?:&|\d)?>{1,2}(?:\||&)?[ \t]*(?:'[^']*'|"[^"]*"|[^\s'"|;&<>]+)?/g, ' ');
    // `-i''` pegado se lee como `-i ''`, el sufijo vacío aparte (como lo lee `palabras` y lo juzga el resto del freno)
    const lectura = palabrasDelSed(sinRedir.replace(/(^|\s)(-[A-Za-z0-9]*i)(''|"")(?=\s|$)/g, '$1$2 $3'));
    if (!lectura) { if (editaEnSitio(tramo)) return null; continue; }
    const { words, conVariable } = lectura;
    const k = words.findIndex((w, j) => {
      const c = path.basename(w).toLowerCase().replace(/\.exe$/, '');
      const resto = words.slice(j + 1);
      return (['sed', 'gsed', 'perl', 'ruby'].includes(c) && resto.some(opcionI))
        || (['awk', 'gawk'].includes(c) && resto.some((x, n) => x === '-iinplace' || (x === '-i' && resto[n + 1] === 'inplace')))
        || (j === 0 && (c === 'ed' || c === 'ex'));
    });
    // sin un editor a la vista, el tramo no edita en el lugar por otro lado (`git grep -O"sed -i …"` corre su texto)
    if (k < 0) { if (editaEnSitio(tramo) || words.some((w) => /\s/.test(w) && editaEnSitio(w))) return null; continue; }
    if (k !== 0 || !['sed', 'gsed'].includes(path.basename(words[0]))) return null;
    const opciones = [];
    const guiones = [];
    const archivos = [];
    let enLugar = false;
    let finOpciones = false;
    for (let n = 1; n < words.length; n++) {
      const w = words[n];
      if (finOpciones || !w.startsWith('-') || w === '-') { archivos.push(w); continue; }
      if (w === '--') { finOpciones = true; continue; }
      if (w === '-e') { if (n + 1 >= words.length || conVariable.has(n + 1)) return null; guiones.push(words[++n]); continue; }
      const m = /^-([Enrsuz]*)(i(.*))?$/.exec(w);
      if (m && (m[1] || m[2] !== undefined)) {
        if (m[1]) opciones.push(`-${m[1]}`);
        // `-i` suelto: en BSD la palabra que sigue es el sufijo de la copia (`-i ''`); en GNU no, y un `-i ''` es el
        // guion vacío seguido del de verdad tomado por archivo: no es la forma (cada sistema lo correría distinto)
        if (m[2] !== undefined) {
          enLugar = true;
          if (m[3] === '' && bsd) n++;
          else if (m[3] === '' && words[n + 1] === '') return null;
        }
        continue;
      }
      if (/^--in-place(?:=.*)?$/.test(w)) { enLugar = true; continue; }
      return null;
    }
    if (!enLugar) return null;
    // el guion se lee tal cual: con una variable adentro (`"s/a/$X/"`) no se sabe qué hace
    if (!guiones.length) { if (!archivos.length || conVariable.has(words.indexOf(archivos[0], 1))) return null; guiones.push(archivos.shift()); }
    if (!archivos.length || !guiones.every(guionDeSedSinEfectos)) return null;
    for (const a of archivos) {
      if (!a || /[{}]/.test(a) || /^~[+-]/.test(a) || a.includes('@') || !comodinSimple(a)) return null;
      const ex = expandirRuta(cmd, a);
      if (ex.sinResolver.length || /[{}]/.test(ex.valor) || !comodinSimple(ex.valor)) return null;
      out.push({ sed: words[0], opciones, guiones, archivo: ex.valor });
    }
  }
  return out;
}

// una palabra suelta del comando cuenta como destino con un editor en el lugar (`editaEnSitio`), o con un
// `for … in <comodín>` que escribe. En un `ls specs/*.md > lista.txt` el comodín sólo se lee
const FOR_IN = /(?:^|[\s;&|(])for\s+\w+\s+in\s/i;

/** Los orígenes de un `mv` (o `git mv`, `Move-Item`) cuyo destino no es un `.md`: la historia sale de la vista de los frenos. */
function movidosFueraDeMd(cmd) {
  const out = [];
  for (const tramo of tramos(cmd)) {
    let words = palabras(tramo.trim().replace(PREFIJO, '')).filter((w) => w !== '' && !w.startsWith('-'));
    if (nombreDeComando(words[0]) === 'git' && words[1] === 'mv') words = words.slice(1);
    const c = nombreDeComando(words[0]);
    if (!['mv', 'move', 'mi', 'move-item', 'rename-item', 'ren'].includes(c) || words.length < 3) continue;
    if (!/\.md$/i.test(words[words.length - 1])) out.push(...words.slice(1, -1));
  }
  return out;
}

/**
 * Si el comando empieza con un `cd` (o `pushd`, `chdir`) y todo lo demás va encadenado con `&&` o `|`: así nada corre en
 * la carpeta de partida, porque si el `cd` falla el `&&` corta. Un `;`, un salto de línea, `||`, un `&` suelto, un
 * paréntesis, llaves o una comilla invertida fuera de comillas pueden correr algo en la carpeta de partida (o no se sabe):
 * entonces no.
 */
function todoCorreDespuesDelCd(cmd) {
  const s = quitarCuerposDeHeredoc(String(cmd));
  if (!/^\s*(?:builtin\s+)?(?:cd|pushd|chdir)\s/.test(s)) return false;
  let q = null;
  let encadenado = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && q !== "'") { i++; continue; }
    if (q) { if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === '&' && s[i + 1] === '&') { encadenado = true; i++; continue; }
    if (c === '|' && s[i + 1] === '|') return false;
    // el primer separador es el `&&` del cd: `cd d | x` corre el cd en otro proceso
    if (c === '|') { if (!encadenado) return false; continue; }
    if (c === ';' || c === '\n' || c === '\r' || c === '(' || c === ')' || c === '{' || c === '}' || c === '`') return false;
    // `2>&1`, `>&2`, `&>archivo` y `|&` son redirecciones, no un `&` que manda al fondo
    if (c === '&' && !/[>&|]/.test(s[i - 1] || '') && s[i + 1] !== '>') return false;
  }
  return encadenado;
}

/**
 * El comando sin el texto de los heredocs que nadie corre: la marca va entre comillas (el shell no expande el cuerpo) y
 * el cuerpo sólo llega a un archivo o a un mensaje. Eso es `cat` o `tee` sin una tubería ni un grupo que lo lleve a otro
 * programa, o `git commit` y `gh pr|issue` con `"$(cat <<'X'`. Con una barra invertida, una comilla abierta o un `$(` tras
 * la marca, la línea sigue abajo y lo que parece el cuerpo es parte del comando. El cuerpo de cualquier otro se sigue
 * mirando, y con dos heredocs en una línea, lo que sigue también: no se sabe de cuál es cada texto.
 */
function sinTextoDeHeredocs(cmd) {
  const s = String(cmd);
  if (!s.includes('<<') || CAT_O_TEE_REDEFINIDO.test(s)) return s;
  const es = posicionesDeComando(s);
  const comandoHasta = (fin) => { let t = ''; for (let i = 0; i < fin; i++) if (es[i]) t += s[i]; return t; };
  const soloTexto = (m) => {
    const [todo, ini, antes, comilla, marca, despues, cuerpo] = m;
    const linea = m.index + ini.length;
    const abre = linea + antes.length;
    if (!comilla || s.slice(0, linea).endsWith('\\\n')) return false;
    // con el cuerpo vacío, el shell cerró en la primera línea y lo que sigue, hasta la otra marca, es comando
    if (cuerpo.split('\n')[0].trim() === marca) return false;
    const mensaje = /^(.*)"\$\(cat[ \t]+$/.exec(antes);
    if (mensaje) {
      const comilla0 = linea + mensaje[1].length;
      if (comilla0 === 0 || !es[comilla0 - 1] || despues.trim() || !/^\s*\)"/.test(s.slice(m.index + todo.length))) return false;
      if (GRUPO_O_CONTROL.test(comandoHasta(comilla0)) || mensaje[1].includes('#')) return false;
      const w = palabras(sinPalabrasDelShell(tramos(mensaje[1]).pop() || '')).filter((x) => x !== '').join(' ');
      return /^(?:git(?: -[cC] \S+)* commit|gh (?:pr|issue) \S+)(?: |$)/.test(w);
    }
    if (!es[abre] || antes.includes('#') || /\||>\(/.test(antes) || !DETRAS_DE_LA_MARCA.test(despues.replace(REDIRECCION_A_DESCRIPTOR, ' '))) return false;
    if (GRUPO_O_CONTROL.test(comandoHasta(abre))) return false;
    const w = palabras(sinPalabrasDelShell(tramos(antes).pop() || '')).filter((x) => x !== '');
    return w[0] === 'cat' || w[0] === 'tee';
  };
  let out = '';
  let hasta = 0;
  for (const m of s.matchAll(HEREDOC_ENTERO)) {
    if (m[2].includes('<<') || m[5].includes('<<')) break;
    if (!soloTexto(m)) continue;
    const fin = m.index + m[0].length;
    out += s.slice(hasta, fin - m[6].length - m[7].length) + m[7];
    hasta = fin;
  }
  return out + s.slice(hasta);
}

/**
 * El comando sin el cuerpo de los heredocs cuyo `$(…)` no corre, para leer lo anidado: la marca va entre comillas (el
 * shell no expande el cuerpo) y lo lee como texto un programa que no es un shell (`git commit -F -`, `gh … --body-file
 * -`, `grep`). `sinTextoDeHeredocs` se queda con esos cuerpos porque una redirección ahí podría seguir camino; un
 * `$(…)` sin expandir, no. Con el cuerpo vacío, en un grupo o con algo detrás de la marca, el cuerpo se sigue mirando.
 */
function sinCuerposDeTexto(cmd) {
  const s = sinTextoDeHeredocs(cmd);
  if (!s.includes('<<')) return s;
  const es = posicionesDeComando(s);
  const comandoHasta = (fin) => { let t = ''; for (let i = 0; i < fin; i++) if (es[i]) t += s[i]; return t; };
  let out = '';
  let hasta = 0;
  for (const m of s.matchAll(HEREDOC_ENTERO)) {
    const [todo, ini, antes, comilla, marca, despues, cuerpo, cierre] = m;
    if (antes.includes('<<') || despues.includes('<<')) break;
    const linea = m.index + ini.length;
    const abre = linea + antes.length;
    if (!comilla || s.slice(0, linea).endsWith('\\\n') || cuerpo.split('\n')[0].trim() === marca) continue;
    if (!es[abre] || antes.includes('#') || /\||>\(/.test(antes) || !DETRAS_DE_LA_MARCA.test(despues.replace(REDIRECCION_A_DESCRIPTOR, ' '))) continue;
    if (GRUPO_O_CONTROL.test(comandoHasta(abre))) continue;
    const w = palabras(sinPalabrasDelShell(tramos(antes).pop() || '')).filter((x) => x !== '').join(' ');
    if (!LEE_EL_CUERPO_COMO_TEXTO.test(w)) continue;
    const fin = m.index + todo.length;
    out += s.slice(hasta, fin - cuerpo.length - cierre.length) + cierre;
    hasta = fin;
  }
  return out + s.slice(hasta);
}

// una palabra del shell entera: también con `$'…'`, `$"…"` y con tramos citados pegados (`'a'"'"'b'` es `a'b`)
const PALABRA_CON_ANSI = /(?:\$'(?:\\[\s\S]|[^'\\])*'|'[^']*'|\$?"(?:\\.|[^"\\])*"|\\.|[^\s'"|;&<>\\])+/g;
// la palabra que un `<<<` da a la entrada
const CADENA_A_LA_ENTRADA = new RegExp(`<<<[ \\t]*(${PALABRA_CON_ANSI.source})`);
/** Las palabras de un tramo como las lee el shell, con sus comillas, sus escapes y los `$'…'` resueltos. */
function palabrasConAnsi(tramo) {
  return (String(tramo).match(PALABRA_CON_ANSI) || []).map((w) => w.replace(/\$'((?:\\[\s\S]|[^'\\])*)'|'([^']*)'|\$?"((?:\\.|[^"\\])*)"|\\(.)/g,
    (m, ansi, simple, doble, escapado) => (ansi !== undefined ? ansiC(ansi) : simple !== undefined ? simple
      : doble !== undefined ? doble.replace(/\\(["\\$`])/g, '$1') : escapado)));
}

/**
 * El cuerpo de un shell con `-c` y lo que lo sigue (sus `$0`, `$1`…), leídos como el shell: `bash -c $'…'` y
 * `sh -c 'sh -c '"'"'…'"'"''` dan el cuerpo entero. null sin `-c`.
 */
function cuerpoDelShell(tramo) {
  const w = palabrasConAnsi(sinPalabrasDelShell(pelarEnv(tramo).resto)).filter((x) => x !== '');
  let k0 = w.findIndex((x) => !/^[A-Za-z_]\w*=/.test(x));
  while (k0 >= 0 && k0 < w.length - 1 && ['builtin', 'command', 'busybox', 'toybox'].includes(nombreDeComando(w[k0]))) k0++;
  if (!SHELLS_CON_DASH_C.has(nombreDeComando(w[k0]))) return null;
  const i = w.findIndex((x, k) => k > k0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(x));
  if (i < 0) return null;
  let j = i + 1;
  while (j < w.length && /^-[A-Za-z-]*$/.test(w[j]) && w[j] !== '-') { if (w[j++] === '--') break; }
  if (w[j] === undefined) return null;
  const resto = w.slice(j + 1);
  return String(w[j]).replace(/\$\{?([0-9])\}?/g, (m, d) => (resto[Number(d)] !== undefined ? resto[Number(d)] : m))
    .replace(/"?\$\{?[@*]\}?"?/g, () => resto.slice(1).join(' '));
}
/**
 * El comando y lo que corre adentro de él: `$(…)`, comillas invertidas, `bash -c '…'`, `eval …` y `find … -exec …`.
 * Cada uno se mira como otro comando. El texto de un heredoc que nadie corre no es un comando.
 */
function comandosAnidados(comando, hondo = 0, valores = null) {
  const cmd = sinTextoDeHeredocs(comando);
  const out = [cmd];
  if (hondo > 3) return out;
  // Lo que el comando guarda en una variable (`c='cp … constancia'`) es texto hasta que se corre: con `eval "$c"`,
  // `bash -c "$c"` o `$c` como programa. Ahí su valor se mira como un comando más; sin esto, guardarlo antes en una
  // variable era el camino para que el freno no lo viera. Los valores de todo el comando, también los de afuera.
  const asignados = valores || asignacionesDe(cmd);
  const valoresEn = (c) => [...String(c || '').matchAll(/\$\{?([A-Za-z_]\w*)\}?/g)].flatMap((m) => asignados.get(m[1]) || []);
  const sumarUno = (t) => { if (t && String(t).trim()) out.push(...comandosAnidados(String(t), hondo + 1, asignados)); };
  const sumarValores = (c) => { for (const t of valoresEn(c)) sumarUno(t); };
  const sumar = (c) => { sumarUno(c); sumarValores(c); };
  // entre comillas simples (fuera de las dobles) `$(…)` y las comillas invertidas son texto: no corren
  let sinSimples = '';
  let q = null;
  for (let i = 0, s = String(cmd); i < s.length; i++) {
    const ch = s[i];
    if (q === "'") { sinSimples += ch === "'" ? (q = null, ch) : ' '; continue; }
    // la barra se come el carácter que sigue: un `$` o una comilla invertida escapados quedan como espacio (no abren una
    // sustitución), y una barra escapada (`\\`) no escapa lo que viene después
    if (ch === '\\' && q !== "'") { const sig = s[i + 1] || ''; sinSimples += ch + (sig === '$' || sig === '`' ? ' ' : sig); i++; continue; }
    if (ch === '"') q = q === '"' ? null : '"';
    else if (ch === "'" && q !== '"') q = "'";
    sinSimples += ch;
  }
  // una comilla simple que no cierra no deja leer el comando: no se sabe qué es texto, y se mira todo
  if (q === "'") sinSimples = String(cmd);
  // un `\$(` o una comilla invertida escapada también son texto
  // se busca sobre el texto sin lo de comillas simples (mismo largo) y se toma del original: un `sh -c '…'` adentro de
  // un `$(…)` conserva su cuerpo. Lo de adentro de una sustitución corre; una variable que ahí sólo se NOMBRA como
  // argumento, no (la mira su programa)
  const original = String(cmd);
  for (const m of sinSimples.matchAll(/\$\(((?:[^()]|\([^()]*\))*)\)/g)) sumarUno(original.slice(m.index + 2, m.index + m[0].length - 1));
  for (const m of sinSimples.matchAll(/`([^`]*)`/g)) sumarUno(original.slice(m.index + 1, m.index + m[0].length - 1));
  // los `cd` de antes en el mismo comando también valen para lo que corre adentro (`bash -c "cd specs && sh -c '…'"`): el
  // cuerpo anidado se mira con ellos delante
  const cds = [];
  for (const tramo of tramos(cmd)) {
    // la carpeta de un `env -C` vale para lo que corre ese tramo, y sólo para él
    const cdsDelEnv = pelarEnv(tramo).carpetas.map((d) => `cd ${/\s/.test(d) ? `"${d}"` : d}`);
    const sumarConCd = (b) => { const todos = [...cds, ...cdsDelEnv]; sumar(todos.length && b ? `${todos.join(' && ')} && ${b}` : b); };
    // sin el `env` de delante (`env -C d sh -c '…'`): lo que corre `env` es el comando
    const w = palabras(sinPalabrasDelShell(pelarEnv(tramo).resto)).filter((x) => x !== '');
    // las asignaciones de delante (`A=1 B=2 programa`) no son el programa, ni `builtin`/`command` (`builtin eval "$c"`)
    let k0 = w.findIndex((x) => !/^[A-Za-z_]\w*=/.test(x));
    while (k0 >= 0 && k0 < w.length - 1 && ['builtin', 'command'].includes(w[k0])) k0++;
    const c = nombreDeComando(w[k0]);
    // una variable como programa (`$c`, `"$c" arg`): se corre su valor
    if (k0 >= 0 && /^\$\{?[A-Za-z_]\w*\}?$/.test(w[k0])) sumarValores(w[k0]);
    if (c === 'cd' || c === 'pushd') moverCds(cds, w.slice(k0));
    // `script -c <comando>` (también `-qc` o `--command[=]`) corre el comando en un shell
    if (c === 'script') {
      // con las palabras enteras: `--command='touch x'` es una sola
      const we = palabrasEnteras(sinPalabrasDelShell(pelarEnv(tramo).resto)).filter((x) => x !== '');
      let ke = we.findIndex((x) => !/^[A-Za-z_]\w*=/.test(x));
      while (ke >= 0 && ke < we.length - 1 && ['builtin', 'command'].includes(we[ke])) ke++;
      we.forEach((x, k) => {
        if (k <= ke) return;
        if (/^-[A-Za-z]*c$|^--command$/.test(x)) sumarConCd(we[k + 1]);
        else if (x.startsWith('--command=')) sumarConCd(x.slice('--command='.length));
      });
      // macOS: `script [opciones] <registro> <comando…>`; con las dos lecturas de `-t` (con valor en macOS, sin él en Linux)
      for (const conValor of [/^-[A-Za-z]*[cEIOBTmot]$|^--[\w-]+$/, /^-[A-Za-z]*[cEIOBTmo]$|^--[\w-]+$/]) {
        const sueltos = posicionales(we.slice(ke + 1), conValor);
        if (sueltos.length > 1) sumarConCd(sueltos.slice(1).map(citarParaElShell).join(' '));
      }
    }
    if (['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'pdksh', 'ash', 'fish'].includes(c)) {
      const i = w.findIndex((x, k) => k > k0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(x));
      // las opciones después de `-c` (`bash -c -x '…'`) y el `--` que las corta no son el cuerpo: es lo primero que sigue
      let j = i + 1;
      while (i > 0 && j < w.length && /^-[A-Za-z-]*$/.test(w[j]) && w[j] !== '-') { if (w[j++] === '--') break; }
      // con comillas dobles escapadas adentro (`sh -c "echo x >> \"h.md\""`) las palabras cortan el cuerpo en la comilla:
      // el cuerpo lo saca el lector de los guiones internos, que lee las comillas dobles enteras
      if (i > 0 && /\\"/.test(tramo)) for (const g of guionesInternos(tramo)) sumarConCd(g);
      else if (i > 0 && w[j] !== undefined) {
        // lo que sigue al cuerpo son sus argumentos: `$0`, `$1`… (y `$@`, `$*`) valen eso adentro (`sh -c 'echo x >> "$1"' _ h.md`)
        const resto = w.slice(j + 1);
        // entre comillas dobles, `\"` y `\\` llegan escapados: adentro valen la comilla y la barra
        const cuerpo = String(w[j]).replace(/\\(["\\$`])/g, '$1');
        sumarConCd(cuerpo.replace(/\$\{?([0-9])\}?/g, (m, d) => (resto[Number(d)] !== undefined ? resto[Number(d)] : m))
          .replace(/"?\$\{?[@*]\}?"?/g, () => resto.slice(1).join(' ')));
      }
    }
    // el cuerpo como lo lee el shell (`$'…'`, las comillas pegadas), con lo que vale afuera: `$PWD` y las variables del
    // comando. Lo de arriba sigue: las palabras de este lector no cortan lo que aquél sí lee
    const cuerpo = cuerpoDelShell(tramo);
    if (cuerpo !== null) for (const b of cuerpoConValores(cuerpo, asignados)) sumarConCd(b);
    // `busybox` y `toybox` corren el programa que les sigue (`busybox rm h.md`, `sudo busybox sh -c '…'`): se mira el
    // tramo sin ellos, con lo que vale afuera
    if (w.some((x) => /^(?:\S*\/)?(?:busybox|toybox)$/.test(x))) {
      const sinEllos = pelarEnv(tramo).resto.replace(/(^|[\s;&|(])(?:\S*\/)?(?:busybox|toybox)(?=\s)/, '$1');
      for (const b of cuerpoConValores(sinEllos, asignados)) sumarConCd(b);
    }
    // el texto de un `eval`, también con lo que vale afuera (`d=x; eval "cp a $d"` copia a `x`)
    if (c === 'eval') {
      sumarConCd(w.slice(k0 + 1).join(' '));
      for (const b of cuerpoConValores(w.slice(k0 + 1).join(' '), asignados)) sumarConCd(b);
    }
    // `su -c <comando>` (también `--command[=]`, antes o después del usuario) corre el comando en un shell
    if (c === 'su') {
      w.forEach((x, k) => {
        if (k <= k0) return;
        if (/^-[A-Za-z]*c$|^--command$/.test(x)) sumarConCd(w[k + 1]);
        else if (x.startsWith('--command=')) sumarConCd(x.slice('--command='.length));
      });
    }
    if (c === 'find') {
      const i = w.findIndex((x) => x === '-exec' || x === '-execdir' || x === '-ok');
      if (i >= 0) {
        const fin = w.findIndex((x, k) => k > i && (x === ';' || x === '+' || x === '\\;' || x === '\\'));
        sumar(w.slice(i + 1, fin < 0 ? undefined : fin).join(' '));
      }
    }
  }
  return out;
}

/** Los valores asignados a cada variable en el comando (`A='x'`, `export A=x`, `local A="x"`), todos los que tenga. */
function asignacionesDe(cmd) {
  // la palabra entera del shell, leída del texto: `palabras` parte `c='a b'` en `c=` y `a b`
  const m = new Map();
  for (const tramo of tramos(String(cmd))) {
    for (const a of String(tramo).matchAll(/(?:^|[\s(])(?:(?:export|local|declare|readonly|typeset)\s+(?:-\w+\s+)*)?([A-Za-z_]\w*)=((?:'[^']*'|"(?:\\.|[^"\\])*"|\$'(?:\\.|[^'\\])*'|\\.|[^\s'"\\;&|()])*)/g)) {
      // `$'…'` con sus escapes (palabraDelShell no lee el citado ANSI-C y dejaría el `$` delante)
      const v = /^\$'((?:\\.|[^'\\])*)'$/.exec(a[2]);
      m.set(a[1], [...(m.get(a[1]) || []), v ? ansiC(v[1]) : palabraDelShell(a[2])]);
    }
  }
  return m;
}

/** Los destinos de los que copian sin que `extractWriteTargets` los vea: `install`, `rsync`, `ditto`, `scp`, `curl -o`, `wget -O`. */
function destinosDeCopia(cmd) {
  const out = [];
  for (const tramo of tramos(cmd)) {
    const words = palabras(tramo.trim().replace(PREFIJO, '')).filter((w) => w !== '');
    const c = nombreDeComando(words[0]);
    if (['install', 'rsync', 'ditto', 'scp'].includes(c)) {
      const { sueltos, carpeta } = argumentosDeCopia(c, words.slice(1));
      // `install -t <carpeta>`: cada origen llega a la carpeta con su nombre
      if (carpeta) out.push(carpeta, ...sueltos.map((s) => `${carpeta.replace(/[\\/]+$/, '')}/${s.split(/[\\/]/).pop()}`));
      else if (sueltos.length >= 2) out.push(sueltos[sueltos.length - 1]);
    }
    if (c === 'curl' || c === 'wget') {
      for (let i = 1; i < words.length; i++) {
        if (/^(?:-o|--output|-O|--output-document)$/.test(words[i]) && words[i + 1]) out.push(words[i + 1]);
        const pegado = /^(?:--output|--output-document)=(.+)$/.exec(words[i]);
        if (pegado) out.push(pegado[1]);
      }
    }
  }
  return out;
}

/**
 * El cuerpo de cada guion de shell que el comando escribe con un heredoc y después corre (`sh x.sh`, `bash -e x.sh`,
 * `. x.sh`, `source x.sh`), con la ruta relativa o absoluta: lo comparan resuelta desde cada carpeta de `bases`. Un
 * guion que ya estaba en el disco no se lee acá.
 */
function guionesDeShellEscritos(cmd, bases) {
  const escritos = heredocs(cmd).filter((h) => h.target);
  if (!escritos.length) return [];
  const resolver = (raw, base) => resolveTarget(expandirRuta(cmd, raw).valor, base, process.platform, { homeVariable: true });
  const out = [];
  for (const tramo of [String(cmd), ...anidadosHasta(cmd).leidos].flatMap((t) => tramos(t))) {
    const words = palabras(sinPalabrasDelShell(tramo)).filter((w) => w !== '');
    const c = words[0] === '.' || words[0] === 'source' ? 'source' : nombreDeComando(words[0]);
    if (!['source', 'sh', 'bash', 'zsh', 'dash', 'ksh'].includes(c)) continue;
    const opciones = words.slice(1).filter((w) => w.startsWith('-'));
    if (c !== 'source' && opciones.some((w) => /^-[A-Za-z]*c/.test(w))) continue;
    const guion = guionDelShell(words);
    if (!guion) continue;
    for (const base of bases) {
      const h = escritos.find((x) => resolver(x.target, base) === resolver(guion, base));
      if (h) { out.push(h.body); break; }
    }
  }
  return out;
}

/** Las tuberías de un renglón y los tramos de cada una, sin cortar adentro de las comillas. */
function tuberiasDelRenglon(linea) {
  const tuberias = [[]];
  let actual = '';
  let q = null;
  const cerrarTramo = () => { tuberias[tuberias.length - 1].push(actual); actual = ''; };
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i];
    if (q) { actual += c; if (c === '\\' && q === '"') actual += linea[++i] || ''; else if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; actual += c; continue; }
    if (c === '\\') { actual += c + (linea[++i] || ''); continue; }
    const doble = linea[i + 1] === c;
    if (c === ';' || (c === '&' && linea[i + 1] !== '>' && linea[i - 1] !== '>') || (c === '|' && doble)) {
      cerrarTramo();
      tuberias.push([]);
      if (doble) i++;
      continue;
    }
    if (c === '|') { cerrarTramo(); if (linea[i + 1] === '&') i++; continue; }
    actual += c;
  }
  cerrarTramo();
  return tuberias;
}

/**
 * ¿El heredoc `indice` del renglón llega a un shell que lo corre? Lo corre si el tramo que lo abre es un shell que lee su
 * entrada (`bash <<EOF`, no `bash x.sh <<EOF`), o si su tubería sigue en uno (`cat <<EOF | bash`).
 */
function heredocVaAUnShell(linea, indice) {
  let visto = 0;
  for (const tuberia of tuberiasDelRenglon(linea)) {
    for (let t = 0; t < tuberia.length; t++) {
      const abiertos = [...delimitadoresQueAbre(tuberia[t])].length;
      if (indice >= visto + abiertos) { visto += abiertos; continue; }
      return tuberia.slice(t).some((tramo) => shellLeeEntrada(tramo));
    }
  }
  return false;
}
/**
 * Las palabras que un `<<<` le da a un `xargs`: la palabra leída como el shell (comillas pegadas, `$'…'`, una variable
 * asignada en el comando), partida por el separador del `xargs` (`-0`, `-d`) y también por los espacios.
 */
function entradaPorCadena(cadena, crudas, asignados) {
  let palabra = (palabrasConAnsi(cadena)[0] || '').replace(EXPANSION_DE_VARIABLE, (m, a, b) => {
    const v = asignados.get(a || b) || [];
    return v.length ? v[v.length - 1] : m;
  });
  let sep = null;
  for (let i = 1; i < crudas.length; i++) {
    const x = crudas[i];
    if (x === '--' || !x.startsWith('-')) break;
    if (x === '-0' || x === '--null') sep = '\0';
    else if (x === '-d' || x === '--delimiter') sep = ansiC(crudas[++i] || '') || sep;
    else if (/^-d./.test(x)) sep = ansiC(x.slice(2));
    else if (x.startsWith('--delimiter=')) sep = ansiC(x.slice('--delimiter='.length)) || sep;
    else if (XARGS_CON_VALOR.has(x)) i++;
  }
  palabra = String(palabra);
  return [...new Set([...(sep ? palabra.split(sep) : []), ...palabra.split(/\s+/)].map((x) => x.trim()).filter(Boolean))];
}

/**
 * Lo que corre otro programa, como texto de un comando: la orden de un `find -exec`, la de un `xargs` y lo que un heredoc o
 * un `<<<` le da a un shell. El cuerpo de un heredoc que va a otro programa no se lee como comando.
 */
function comandosPorOtroPrograma(cmd, cwd) {
  const s = String(cmd || '');
  if (!/\bfind\b|\bxargs\b|\bparallel\b|<<|\|/.test(s)) return [];
  const resolver = (raw, base) => resolveTarget(expandirRuta(cmd, raw).valor, base, process.platform, { homeVariable: true });
  const bases = [cwd];
  for (const m of s.matchAll(/(?:^|[\s;&|(])cd\s+(['"]?)([^\s'";&|)]+)\1/g)) bases.push(resolver(m[2], cwd));
  const absoluta = (raw) => [...new Set(bases.map((b) => resolver(raw, b)))];
  const out = [];
  for (const crudo of [s, ...anidadosHasta(s).leidos]) {
    // la continuación de renglón (`\` y salto) junta los dos renglones en una orden, como en el shell
    const texto = crudo.replace(/\\\r?\n/g, ' ');
    // el `\;` de un `-exec` no separa comandos: lo que sigue es del mismo `find`
    const lista = [];
    for (const t of tramos(texto)) {
      const previo = lista[lista.length - 1];
      if (previo !== undefined && previo.trimEnd().endsWith('\\')) lista[lista.length - 1] = `${previo} ${t}`;
      else lista.push(t);
    }
    lista.forEach((tramo, k) => {
      // sinPalabrasDelShell se come el `xargs` con sus opciones: acá sólo se sacan los prefijos y las palabras del shell
      let antes = pelarEnv(tramo).resto.trim();
      for (let previo = null; previo !== antes;) { previo = antes; antes = antes.replace(PREFIJO, '').replace(PALABRA_ANTES_DE_XARGS, '').trim(); }
      // un `<<<` le da su palabra a la entrada, y le gana a la tubería: no es un argumento de la orden
      const cadena = CADENA_A_LA_ENTRADA.exec(antes);
      const crudas = palabras(cadena ? antes.replace(cadena[0], ' ') : antes).filter((w) => w !== '');
      // `parallel` corre su orden con los argumentos de `:::` o, sin ellos, con lo que llega por la entrada, como `xargs`
      const lanzador = nombreDeComando(crudas[0]);
      const ordenes = lanzador === 'parallel' ? ordenesDeParallel : ordenesDeXargs;
      if (lanzador === 'xargs' || lanzador === 'parallel') {
        if (cadena) { out.push(...ordenes(crudas, entradaPorCadena(cadena[1], crudas, asignacionesDe(texto)))); return; }
        // lo que llega por la entrada: las palabras del tramo de antes, sin el `echo`/`printf` que las escribe (con él,
        // `$0` del cuerpo de un `xargs sh -c` sería `echo`)
        const previas = k ? palabras(lista[k - 1]).filter((w) => w !== '') : [];
        // (de `printf`, lo que escribe: el formato con sus argumentos y sus escapes, `printf 'h.md\n'` escribe `h.md`)
        const escritor = nombreDeComando(previas[0]) || '';
        const entrada = /^(?:echo|printf|print)$/.test(escritor) ? previas.slice(1).filter((w) => !/^-[a-zA-Z]+$/.test(w)) : previas;
        out.push(...ordenes(crudas, escritor === 'printf' ? ansiC(formatoDePrintf(entrada)).split(/[\s\0]+/).filter(Boolean) : entrada));
        return;
      }
      const words = palabras(sinPalabrasDelShell(tramo)).filter((w) => w !== '');
      const programa = nombreDeComando(words[0]);
      if (programa === 'find') out.push(...ordenesDeFind(words, absoluta));
      if (!shellLeeEntrada(tramo)) return;
      const entrada = /<<<[ \t]*(?:'([^']*)'|"([^"]*)"|([^\s;&|]+))/.exec(tramo);
      if (entrada) out.push(entrada[1] ?? entrada[2] ?? entrada[3]);
    });
    const lineas = texto.split('\n');
    // lo que un `echo`/`printf` escribe por una tubería a un shell que lee sus órdenes de la entrada (`| sh`, `| bash -s`)
    // corre como un comando
    // (con filtros en el medio, `| cat | sh`; con llaves o un subshell alrededor; y con los `cd` de antes en el renglón)
    const sinEnvoltura = (t) => sinCierre(sinComentarioAlFinal(String(t)).trim().replace(/^[({]\s*/, '')).replace(/^(?:builtin|busybox)\s+/, '');
    const escritoPor = (tramo) => {
      const w = palabras(sinPalabrasDelShell(sinEnvoltura(tramo))).filter((x) => x !== '');
      const escritor = nombreDeComando(w[0]) || '';
      if (!/^(?:echo|printf|print)$/.test(escritor)) return null;
      if (escritor === 'printf') return formatoDePrintf(w.slice(1)).replace(/\\(.)/g, (m, c) => (c === 'n' ? '\n' : c));
      // el de `echo` sale del tramo crudo, sin comillas ni escapes como lo deja el shell: las palabras sacan un `\>` suelto
      const crudo = sinEnvoltura(tramo).replace(/^\s*(?:builtin\s+)?\S*?(?:echo|print)\s*/, '').replace(/^(?:-[neE]+\s+)+/, '');
      let texto = '';
      for (let i = 0, q = null; i < crudo.length; i++) {
        const ch = crudo[i];
        if (q === "'") { if (ch === "'") q = null; else texto += ch; continue; }
        if (ch === '\\') { const sig = crudo[++i] || ''; texto += sig === 'n' ? '\n' : sig; continue; }
        if (ch === '"') { q = q === '"' ? null : '"'; continue; }
        if (ch === "'" && !q) { q = "'"; continue; }
        texto += ch;
      }
      return texto.replace(/\\n/g, '\n').trim();
    };
    // los `cd` valen para los renglones que siguen; un renglón del shell no se corta adentro de comillas ni después de un `|`
    const cdsDelRenglon = [];
    for (const linea of renglonesDelShell(texto)) {
      // lo que escribió la tubería de antes: un grupo (`{ echo …; } | sh`) se corta en el `;`, y lo que sigue empieza en `}`
      let escritoAntes = null;
      for (const tuberia of tuberiasDelRenglon(linea)) {
        const primera = palabras(sinPalabrasDelShell(sinEnvoltura(tuberia[0] || ''))).filter((x) => x !== '');
        if (nombreDeComando(primera[0]) === 'cd' || nombreDeComando(primera[0]) === 'pushd') moverCds(cdsDelRenglon, primera);
        const cierraGrupo = /^\s*[})]/.test(tuberia[0] || '');
        for (let k = 1; k < tuberia.length; k++) {
          if (!shellLeeEntrada(sinEnvoltura(tuberia[k]))) continue;
          let texto = null;
          for (let j = k - 1; j >= 0 && texto === null; j--) texto = escritoPor(tuberia[j]);
          if (texto === null && cierraGrupo) texto = escritoAntes;
          if (texto !== null) out.push(cdsDelRenglon.length ? `${cdsDelRenglon.join(' && ')} && ${texto}` : texto);
        }
        escritoAntes = escritoPor(tuberia[tuberia.length - 1] || '');
      }
    }
    for (const { abre, desde, cierre, indice } of heredocsCerrados(lineas)) {
      if (heredocVaAUnShell(lineas[abre], indice)) out.push(lineas.slice(desde, cierre).join('\n'));
    }
  }
  return [...new Set(out)];
}


module.exports = { cwdDelComando, carpetasDelComando, relativosDe, resolverCd, destinosBorrados, CD_INICIAL, CD_PERL, cdInicial, palabrasDelEditor, anidadosHasta, borradosProfundos, marcadoresTocados, aprobacionesTocadas, marcasDeTerminalTocadas, lanzadasTocadas, buzonTocado, criticosTocados, corridasDeRevisoresTocadas, revisionDelPlanTocada, zonaTocada, editaEnSitio, destinosDeGuionDeSed, palabrasDelSed, sedsLiterales, FOR_IN, movidosFueraDeMd, todoCorreDespuesDelCd, sinTextoDeHeredocs, sinCuerposDeTexto, PALABRA_CON_ANSI, CADENA_A_LA_ENTRADA, palabrasConAnsi, cuerpoDelShell, comandosAnidados, asignacionesDe, destinosDeCopia, guionesDeShellEscritos, tuberiasDelRenglon, heredocVaAUnShell, entradaPorCadena, comandosPorOtroPrograma };
