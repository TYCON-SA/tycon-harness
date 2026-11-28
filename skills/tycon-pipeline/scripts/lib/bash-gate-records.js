'use strict';
/**
 * bash-gate-records.js — una parte de on-bash-write-gate.js, el freno de escrituras por consola.
 *
 * Responsabilidad: lo que el comando toca de las historias, las constancias (con su huella) y la coordinadora.
 *
 * El código viene de on-bash-write-gate.js tal cual, salvo dos reescrituras mecánicas: los `require` locales van
 * relativos a esta carpeta, y las rutas que salían de la carpeta de los guiones suben un nivel más. Cada parte carga
 * sólo las de abajo (la red primero; el despachador, todas).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { NEVER_CODE_SEGMENTS } = require('./story-gate.js');
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
const { GUION_ESCRIBE, NOMBRA_RUTA_DE_HISTORIA, logHookError } = require('./bash-gate-net.js');
const { BORRA_O_MUEVE, PREFIJO, TOPE_ANIDADOS, expandirLlaves, nativePath, palabras, recorrerCarpetaDeCd, sinEscapesDeComillas } = require('./bash-gate-words.js');
const { CD_DEL_TRAMO, conCarpetasNombradas, conCarpetasPorTramo } = require('./bash-gate-folders.js');
const { ESCRIBE, LECTORES_DE_XARGS, OPCIONES_CON_VALOR, REDIRECCION, SHELLS_QUE_LEEN_COMANDOS, TOPE_DE_CARPETAS_DE_CD, algunOpenEscribe, argumentosDeCopia, citados, constanciasDeOtraRama, contenidoDelArchivo, dentroDeUnRepo, destinoDeLaCopia, ejecutaTexto, ensayarSeds, estadoDeHistoria, estadosDelEncabezado, expandirComodin, mdAdentro, nombreDeComando, nombresDeConstancia, palabraDelShell, palabrasEnteras, parcheNombraConstancia, parchesDePatch, pelarEnv, posicionales, posicionesFueraDeComillas, resolveTarget, sinCierreDeGrupo, sinComillasPegadas, sinPalabrasDelShell, sinRedireccionesDeSalida } = require('./bash-gate-expansions.js');
const { carpetasDeLosCd, carpetasDeLosCdDeConstancias, destinosArmados, extractWriteTargets, heredocs, quitarCuerposDeHeredoc, scriptsInline, tramos } = require('./bash-gate-targets.js');
const { FOR_IN, anidadosHasta, carpetasDelComando, cdInicial, comandosAnidados, comandosPorOtroPrograma, cwdDelComando, destinosBorrados, destinosDeCopia, destinosDeGuionDeSed, editaEnSitio, guionesDeShellEscritos, guionesDeShellEnDisco, movidosFueraDeMd, palabrasDelEditor, sedsLiterales, sinCuerposDeTexto, todoCorreDespuesDelCd } = require('./bash-gate-commands.js');
const { cdSinResolver, conLosCdDeSiempre, destinosDeLaCoordinadora, destinosResueltos, palabrasDelBucleSiFueraSoloSeLee, sinMayoresQueNoRedirigen } = require('./bash-gate-scripts.js');

/**
 * Las constancias de cambio de control que el comando pone por otro camino que el guion: lo que deja una copia, un
 * movimiento o un enlace (`cp`, `git mv`, `install`, `rsync`, `ditto`, `scp`, `ln`) en su destino (el último argumento o
 * el de `-t`), también adentro de lo que copia una carpeta entera; lo que se repone desde otra rama (`git checkout <ref>
 * -- x`, `git restore --source`); lo que entra directo al índice (`git update-index`); y un parche (`git apply`, `git am`,
 * `patch`) que las nombra. Un parche que no se puede leer antes de aplicarlo (por la entrada estándar, que no existe
 * todavía, ilegible) y una copia recursiva a un repo de algo que no se puede mirar (remota, que no existe) también
 * cuentan: lo que no se ve no pasa. Las escrituras comunes (`>`, `tee`, `node -e`) las ve `extractWriteTargets`.
 * Casos: scripts/controls-bench/cases/hooks/01-frenos-duros.json
 */
function constanciasTocadas(cmd, cwd, stateDir = null, sesion = cwd) {
  // las constancias firmadas: las de cambio de control, la del salteo del pase adversarial y el registro del arnés
  // (`gates.log`), que lleva el renglón de la firma del salteo
  const { signedRecordKind } = require('./story-gate.js');
  const installedTree = require('./installed-tree.js');
  const registros = stateDir ? [...new Set([stateDir, installedTree.realPath(stateDir)].filter(Boolean).map((d) => path.join(d, 'gates.log')))] : [];
  const esRegistro = (p) => {
    if (!registros.length || !path.isAbsolute(String(p))) return false;
    const a = path.resolve(String(p));
    return registros.includes(a) || registros.includes(installedTree.realPath(a));
  };
  // un archivo con más de un nombre que es el mismo que una constancia del repo (un enlace duro) es la constancia
  const { constanciaDelMismoArchivo } = require('./story-gate-io.js');
  const enlazadas = new Map();
  const enlazada = (p) => {
    if (!path.isAbsolute(String(p))) return false;
    if (!enlazadas.has(p)) enlazadas.set(p, constanciaDelMismoArchivo(String(p), [cwd, sesion]) !== null);
    return enlazadas.get(p);
  };
  const isControlApproval = (p) => signedRecordKind(p) !== null || esRegistro(p) || enlazada(p);
  // los comandos de git no miran el registro de aprobaciones de una ejecución: cada ejecución lo cambia y viaja en el
  // commit de su pedido, así que cambiar de rama o traer main lo mueve todos los días. Lo que llega así lo mira la CI
  const { isRunApprovalsRecord } = require('./story-gate.js');
  const constanciaDeGit = (p) => isControlApproval(p) && !isRunApprovalsRecord(p);
  // una carpeta donde vive una constancia del salteo: la del estado, o la de una ejecución (`pipeline-runs/<carpeta>`)
  const carpetaDeFirma = (d) => {
    const reales = [...new Set([path.resolve(String(d)), installedTree.realPath(path.resolve(String(d)))].filter(Boolean))];
    return reales.some((r) => registros.some((g) => r === path.dirname(g)) || path.basename(path.dirname(r)) === 'pipeline-runs');
  };
  let base = cwd;
  // con un `cd` que no se puede resolver (`cd "$X"`), una ruta relativa que nombra la carpeta o el archivo de las
  // constancias puede caer en ellas: cuenta como una
  let cdSinResolver = false;
  // `$PWD`, `${PWD}` y `$(pwd)` son la carpeta que se está mirando (la de un `cd`, no la de partida)
  const conPwd = (raw) => String(raw).replace(/\$\{PWD\}|\$PWD(?!\w)|\$\(pwd\)|`pwd`/g, () => base);
  const abs = (raw) => resolveTarget(expandirRuta(cmd, conPwd(raw)).valor, base, process.platform, { homeVariable: true });
  // la constancia de las exenciones (lib/exemptions.js), también nombrada con un comodín que la alcanza
  // (`.tycon/exempt*.jsonl`, `exemptions*` después de un `cd .tycon`)
  const comodinDeExenciones = (raw) => {
    if (!/[*?[]/.test(String(raw))) return false;
    const a = abs(raw);
    if (!/(^|[\\/])\.tycon$/i.test(path.dirname(a))) return false;
    const patron = path.basename(a).replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    try { return new RegExp(`^${patron}$`, 'i').test('exemptions.jsonl'); } catch (_) { return true; }
  };
  // una ruta con un tramo que no se lee: un comodín, comillas invertidas, `$(…)` o una variable
  // sin un valor literal antes. Frena por lo que sí se lee: el último nombre es el de un archivo de constancias, o no se
  // lee y la carpeta que se lee es una carpeta de constancias. Un comodín en el último nombre frena sólo si puede nombrar
  // una constancia: si calza con una que existe, con el nombre de un archivo de constancias en una carpeta de constancias
  // o que no se lee, o si la carpeta es una de las que guardan sólo constancias
  const sg = require('./story-gate.js');
  // `)` suelto: la palabra quedó cortada adentro de un `$( … )` (las palabras del comando no lo leen entero)
  const NO_SE_LEE = /[*?[`)]|\$/;
  const norm = (p) => String(p || '').replace(/\\/g, '/');
  const globARegex = (g) => {
    let out = '';
    for (let i = 0; i < g.length; i++) {
      const ch = g[i];
      if (ch === '*') out += '.*';
      else if (ch === '?') out += '.';
      else if (ch === '[') { const j = g.indexOf(']', i + 2); if (j < 0) { out += '\\['; continue; } out += `[${g.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`; i = j; }
      else out += ch.replace(/[.+^${}()|\\]/g, '\\$&');
    }
    // un comodín que no se puede convertir cuenta como que puede nombrar una constancia: el freno falla cerrado
    try { return new RegExp(`^${out}$`, 'i'); } catch (_) { return { test: () => true }; }
  };
  const armada = (raw) => {
    const r = String(raw);
    if (!NO_SE_LEE.test(r)) return false;
    const e = expandirRuta(cmd, conPwd(r));
    const valor = norm(String(e.sinResolver && e.sinResolver.length ? r : (e.valor || r)));
    if (!NO_SE_LEE.test(valor)) return false;
    // los tramos, sin cortar adentro de `$(…)` ni de comillas invertidas
    const partes = [];
    let actual = '';
    let hondo = 0;
    let tilde = false;
    for (const ch of valor) {
      if (ch === '`') tilde = !tilde;
      if (ch === '(' && actual.endsWith('$')) hondo++;
      else if (ch === ')' && hondo) hondo--;
      if (ch === '/' && !hondo && !tilde) { partes.push(actual); actual = ''; continue; }
      actual += ch;
    }
    partes.push(actual);
    const ultimo = partes[partes.length - 1].replace(/^["']|["']$/g, '');
    const carpetaPartes = partes.slice(0, -1);
    const iLegible = carpetaPartes.map((p) => NO_SE_LEE.test(p)).lastIndexOf(true);
    const carpetaLeida = carpetaPartes.slice(iLegible + 1).join('/');
    // la carpeta entera se lee: se resuelve contra la del comando (la de un `cd`); si no, su parte de atrás
    const carpetaAbs = iLegible < 0 ? (carpetaPartes.length ? abs(carpetaPartes.join('/') || '/') : base) : null;
    const esCarpetaDeConstancias = carpetaAbs ? sg.isRecordsDir(carpetaAbs) : sg.isRecordsDir(carpetaLeida);
    const soloConstancias = /(^|\/)(?:\.tycon\/control-changes|\.github\/control-changes|tasks\/pending-approvals)\/?$/i.test(carpetaAbs ? norm(carpetaAbs) : carpetaLeida);
    if (!NO_SE_LEE.test(ultimo)) return sg.isRecordFileName(ultimo);
    if (/[`$]/.test(ultimo)) return esCarpetaDeConstancias;
    // un comodín en el último nombre
    if (soloConstancias) return true;
    const re = globARegex(ultimo);
    if (sg.RECORD_FILE_NAMES.some((n) => re.test(n)) && (esCarpetaDeConstancias || iLegible >= 0)) return true;
    if (carpetaAbs) {
      try { if (fs.readdirSync(carpetaAbs).some((n) => re.test(n) && isControlApproval(path.join(carpetaAbs, n)))) return true; } catch (_) { /* no existe */ }
    }
    return false;
  };
  const es = (raw) => isControlApproval(String(raw)) || isControlApproval(abs(raw)) || comodinDeExenciones(raw) || armada(raw)
    || (cdSinResolver && !path.isAbsolute(String(raw)) && /control-changes|exemptions/i.test(String(raw)));
  // una vez por ruta: una copia con miles de orígenes a un mismo destino preguntaba por su ruta real una vez por origen
  const rutasVistas = new Map();
  const esRuta = (p) => {
    if (!rutasVistas.has(p)) rutasVistas.set(p, isControlApproval(p) || isControlApproval(`${p}/`));
    return rutasVistas.get(p);
  };
  const out = [];
  // se lee también con la continuación de renglón juntada: `cat <<'EOF' \` y abajo `> constancia` es una redirección del
  // `cat`. La lectura de siempre sigue, y toma lo de abajo como comando. Lo que otro programa corre (el heredoc a un
  // shell, `xargs`, `find -exec`) se mira como un comando más
  const plano = String(cmd).replace(/\\\r?\n/g, ' ');
  const lecturas = plano === String(cmd) ? [cmd] : [cmd, plano];
  const todos = [...new Set(lecturas.flatMap((t) => [...comandosAnidados(t), ...comandosPorOtroPrograma(t, cwd)]))]
    .flatMap((sub) => tramos(sub)).flatMap((t) => t.split(/(?<![&>|])&(?![&>])/));
  // Un texto entre comillas es texto (`desc='…'`, `--description '…'`, `echo '…'`) sólo si nada en el comando puede
  // correrlo. Si algo puede —un shell, `eval`, `source`, un intérprete, `xargs`, un guion como programa, una variable como
  // programa—, falla cerrado: la redirección citada cuenta, y cada texto citado se mira también como un comando (el que
  // entra a un shell por tubería, por `<<<`, por un guion escrito antes o leído con `read`)
  const ejecuta = ejecutaTexto(cmd);
  if (ejecuta) todos.push(...citados(cmd).flatMap((c) => comandosAnidados(c)).flatMap((sub) => tramos(sub)).flatMap((t) => t.split(/(?<![&>|])&(?![&>])/)));
  // un guion de shell que ya está en el disco y el comando corre (`sh g.sh`, `. g.sh`, `./g.sh`, `bash -s < g.sh`): sus
  // renglones se miran como comandos de la consola, en la carpeta del comando; también los guiones que él corre. Uno que
  // no se lee entero cuenta si nombra una constancia
  {
    const instalados = require('./story-gate-io.js').defaultInstalledRoots();
    let pendientes = [cmd];
    for (let hondo = 0; hondo < 3 && pendientes.length; hondo++) {
      const siguientes = [];
      for (const texto of pendientes) {
        for (const g of guionesDeShellEnDisco(texto, [...new Set([cwd, sesion])], instalados)) {
          if (g.grande && (!g.texto || /control-changes|exemptions|runtime-waivers|approvals\.jsonl|adversarial-skips|pending-approvals/i.test(g.texto))) {
            out.push(`${g.archivo} (un guion que no se lee entero y nombra una constancia)`);
          }
          if (g.grande) continue;
          todos.push(...[...comandosAnidados(g.texto), ...comandosPorOtroPrograma(g.texto, cwd)].flatMap((sub) => tramos(sub)).flatMap((t) => t.split(/(?<![&>|])&(?![&>])/)));
          siguientes.push(g.texto);
        }
      }
      pendientes = siguientes;
    }
  }
  const bases = carpetasDeLosCdDeConstancias(todos, cmd, [cwd, sesion]);
  cdSinResolver = bases.sinResolver;
  // `cd /otro && git merge <sha>` con todo encadenado detrás: ese git corre en la carpeta del cd, y en la de partida no se
  // mira (un commit que sólo existe en la otra carpeta no se puede ver desde la de partida, y frenaba un merge que no corre
  // ahí). Vale sólo para un `git <subcomando>` escrito tal cual en el primer nivel: sin opciones antes del subcomando
  // (`-c core.worktree=…`), sin un programa delante que lo corra en otra carpeta (`sudo -D`) y sin que corra también
  // anidado en otro programa o en un texto. Tampoco si una variable de git apunta a otro repo (`GIT_DIR=…`). Todo lo
  // demás se sigue mirando en todas las carpetas
  const partir = (t) => tramos(t).flatMap((x) => x.split(/(?<![&>|])&(?![&>])/)).map((x) => x.trim());
  const soloEnElCd = bases.unico && !/\bGIT_[A-Z_]+\b/.test(String(cmd)) && todoCorreDespuesDelCd(cmd);
  const deArriba = soloEnElCd ? new Set(lecturas.flatMap(partir)) : new Set();
  const deAdentro = soloEnElCd ? new Set([...lecturas.flatMap((t) => [...comandosAnidados(t).slice(1), ...comandosPorOtroPrograma(t, cwd)]),
    ...(ejecuta ? citados(cmd).flatMap((c) => comandosAnidados(c)) : [])].flatMap(partir)) : new Set();
  const delCd = bases.carpetas.filter((d) => d === bases.unico || ![cwd, sesion].includes(d));
  const carpetasDe = (tramo) => {
    const t = String(tramo).trim();
    return soloEnElCd && deArriba.has(t) && !deAdentro.has(t) && /^git\s+[a-z]/.test(t) ? delCd : bases.carpetas;
  };
  for (const tramo of todos) for (const raiz of carpetasDe(tramo)) {
    base = raiz;
    // sin las redirecciones de lectura con su archivo (`< lista`): no son argumentos de la copia. La carpeta de `env -C`
    // ya está entre las bases: se saca para que lo que corre `env` quede como el comando
    const resto = pelarEnv(tramo).resto;
    const limpio = sinPalabrasDelShell(resto);
    // `sinPalabrasDelShell` se come un `xargs` del principio con sus opciones: se anota antes
    let porXargs = nombreDeComando(palabrasEnteras(resto.trim().replace(PREFIJO, ''))[0]) === 'xargs';
    // las redirecciones y el tee a una constancia, también adentro de `bash -c` (los tramos anidados están en `todos`);
    // `<>` abre el archivo para leer y escribir
    // el destino es la palabra entera del shell, con sus comillas resueltas (`.tycon/'control-changes.jsonl'`); uno armado
    // con una sustitución que nombra una constancia no se puede resolver y no pasa
    // sólo la redirección que está fuera de comillas: `desc='… > .tycon/control-changes.jsonl'` es un texto. Salvo que el
    // comando pueda correr un texto (`ejecuta`): ahí cuenta también la citada, como siempre
    const fuera = ejecuta ? () => true : posicionesFueraDeComillas(limpio);
    for (const m of limpio.matchAll(/(?<![<\d&])(?:\d?>>?|&>>?|\d?<>)\|?\s*((?:\$\([^()]*\)|`[^`]*`|'[^']*'|"(?:\\.|[^"\\])*"|\\.|[^\s<>;&|'"\\])+)/g)) {
      if (!fuera(m.index)) continue;
      const destino = sinCierreDeGrupo(palabraDelShell(m[1]));
      if (es(destino) || (/\$\(|`/.test(destino) && /control-changes|gates\.log|exemptions\.jsonl/i.test(destino))) out.push(destino);
    }
    // cada argumento es la palabra entera del shell, con sus comillas resueltas (`cp x .tycon/'control-changes.jsonl'`),
    // y sin el `)` que cierra un paréntesis (`(cd d && touch f)`)
    const words = palabrasEnteras(sinRedireccionesDeSalida(limpio).replace(/(?<![<\d])<(?!<)\s*[^\s<>;&|]+/g, ' ').trim().replace(PREFIJO, '')).filter((w) => w !== '' && w !== '\\');
    let c = nombreDeComando(words[0]);
    let args = words.slice(1);
    if (c === 'xargs') {
      // lo que corre xargs, sin sus opciones (las que llevan valor, con él)
      let i = 0;
      while (i < args.length && args[i].startsWith('-')) i += /^-(?:[IinLPdEsa]|-(?:replace|max-args|max-lines|max-procs|delimiter|eof|max-chars|arg-file))$/.test(args[i]) ? 2 : 1;
      c = nombreDeComando(args[i]);
      args = args.slice(i + 1);
      porXargs = true;
    }
    // lo que corre un `xargs` recibe archivos de la entrada, que no se ven: en la carpeta de las constancias, lo que no sea
    // un lector conocido no pasa
    if (porXargs && esRuta(path.join(base, 'x')) && !LECTORES_DE_XARGS.has(c)) { out.push(`${tramo.trim()} (en la carpeta de las constancias, con archivos que no se ven)`); continue; }
    const lleva = (opciones) => {
      // las cortas, también juntas (`-qO <ruta>`) o con el valor pegado (`-O<ruta>`); leer de más no frena nada:
      // sólo cuenta lo que nombra un archivo de la firma
      const cortas = opciones.filter((o) => /^-[A-Za-z]$/.test(o)).map((o) => o[1]).join('');
      const r = [];
      for (let i = 0; i < args.length; i++) {
        if ((opciones.includes(args[i]) || (cortas && new RegExp(`^-[A-Za-z]*[${cortas}]$`).test(args[i]))) && args[i + 1]) { r.push(args[++i]); continue; }
        const pegado = opciones.map((o) => (o.startsWith('--') ? new RegExp(`^${o}=(.+)$`).exec(args[i]) : null)).find(Boolean)
          || (cortas ? new RegExp(`^-[A-Za-z]*[${cortas}](.+)$`).exec(args[i]) : null);
        if (pegado) r.push(pegado[1]);
      }
      return r;
    };
    if (c === 'tee') { out.push(...args.filter((w) => !w.startsWith('-')).filter(es)); continue; }
    if (c === 'sponge') { out.push(...args.filter((w) => !w.startsWith('-')).filter(es)); continue; }
    // los que escriben un archivo que nombran: `sort -o` y `shuf -o`, la salida de `uniq` (su segundo archivo), `awk -i
    // inplace`, `ruby -i`, los editores (y su `w <archivo>` en `-c` o `+`), el `w` de un guion de `sed`, y `touch`, que la
    // crea vacía. El valor de una opción que sólo se lee (`touch -r`, `vim -u`, `uniq -f`) no es lo que se escribe
    if (['sort', 'gsort', 'shuf'].includes(c)) { out.push(...lleva(['-o', '--output']).filter(es)); continue; }
    if (c === 'uniq') { const s = posicionales(args, /^-[fsw]$|^--(?:skip-fields|skip-chars|check-chars)$/); if (s[1] && es(s[1])) out.push(s[1]); continue; }
    // los que escriben archivos con el nombre que les dan: `split` y `csplit` (el prefijo, con lo que le agregan),
    // `script` (el registro: su primer argumento, o el de `-O`/`--log-out` y los demás registros), `diff`/`sdiff -o`
    if (c === 'split' || c === 'gsplit') {
      const prefijo = posicionales(args, /^-[abClnpt]$|^--(?:suffix-length|bytes|line-bytes|lines|number|separator|additional-suffix|filter)$/)[1] || 'x';
      if (es(prefijo) || es(`${prefijo}aa`)) out.push(prefijo);
      continue;
    }
    if (c === 'csplit' || c === 'gcsplit') {
      const prefijo = lleva(['-f', '--prefix'])[0] || 'xx';
      if (es(prefijo) || es(`${prefijo}00`)) out.push(prefijo);
      continue;
    }
    if (c === 'script') {
      // `-t` lleva valor en macOS y no en Linux: el registro se busca con las dos lecturas
      const registros = [
        // las cortas, también juntas con la que lleva valor al final (`-qc ls`)
        posicionales(args, /^-[A-Za-z]*[cEIOBTmot]$|^--(?:command|echo|log-in|log-out|log-io|log-timing|timing|logging-format|output-limit)$/)[0],
        posicionales(args, /^-[A-Za-z]*[cEIOBTmo]$|^--(?:command|echo|log-in|log-out|log-io|log-timing|timing|logging-format|output-limit)$/)[0],
        ...lleva(['-O', '-I', '-B', '-T', '--log-out', '--log-in', '--log-io', '--log-timing', '--timing']),
      ].map((r) => r || 'typescript');
      out.push(...registros.filter(es));
      continue;
    }
    if (c === 'diff' || c === 'gdiff' || c === 'sdiff') { out.push(...lleva(['-o', '--output']).filter(es)); continue; }
    if (c === 'awk' || c === 'gawk') {
      const incluye = lleva(['-i', '--include']).concat(args.filter((w) => /^-i./.test(w)).map((w) => w.slice(2)));
      if (incluye.some((v) => /(?:^|[\\/])inplace(?:\.awk)?$/.test(v))) out.push(...posicionales(args, /^-[ifvE]$|^--(?:include|file|assign|exec)$/).slice(1).filter(es));
      continue;
    }
    if (c === 'ruby' && args.some((w) => /^-[A-Za-z]*i/.test(w))) { out.push(...posicionales(args, /^-[eIrC]$/).filter(es)); continue; }
    if (['ex', 'vi', 'vim', 'nvim', 'gvim', 'rvim', 'view', 'vimdiff', 'nano', 'pico', 'emacs', 'micro', 'ed', 'touch'].includes(c)) {
      // `-s` lleva valor en vim (el guion de teclas) y no en `ex`, `vim -e` ni `ed` (callado): los archivos se buscan con
      // las dos lecturas. Leer de más no frena nada: sólo cuenta lo que nombra una constancia
      const lecturas = c === 'touch' ? [/^-[rdt]$|^--(?:reference|date)$/]
        : c === 'ed' ? [/^-p$/] : [/^-[uUiTcSsWwq]$|^--cmd$/, /^-[uUiTcSWwq]$|^--cmd$/];
      // la familia de vi con `-R` o `-M` sólo mira el archivo si nada le puede dar una orden de escribir: ni órdenes ni
      // guiones (`-c`, `+`, `-s`, `-S`, `-w`), ni el modo ex (`ex`, `-e`, `-E`), ni la entrada (`-`, una tubería o una
      // redirección de entrada en el comando, un heredoc). Con cualquiera de ellos, un `:w!` la escribe igual
      // Sólo valen las banderas que no escriben ni leen órdenes (`-R`, `-M`, `-n`, `-b`…): cualquier otra opción (`-i`,
      // `-V9<archivo>`, `-c:w`) la saca de sólo lectura
      const soloMira = ['vi', 'vim', 'nvim', 'gvim', 'rvim', 'view', 'vimdiff'].includes(c)
        && args.some((w) => /^-[A-Za-z]*[RM][A-Za-z]*$/.test(w) && !w.startsWith('--'))
        && args.every((w) => !w.startsWith('-') && !w.startsWith('+') ? true : /^-[RMnNbylZXg]+$/.test(w))
        && !/[|<]/.test(String(cmd));
      if (!soloMira) out.push(...lecturas.flatMap((conValor) => posicionales(args, conValor)).filter((w) => !w.startsWith('+')).filter(es));
      if (c !== 'touch') {
        // `+'w x'` llega como dos palabras: el `+` solo y la orden
        // `-w`/`-W` escriben las teclas en el archivo que nombran, `-i` el viminfo y `-V<n><archivo>` un registro
        out.push(...lleva(['-w', '-W', '-i']).filter(es));
        out.push(...args.map((w) => /^-V\d*(.+)$/.exec(w)).filter(Boolean).map((m) => m[1]).filter(es));
        const ordenes = [...lleva(['-c', '--cmd']), ...args.filter((w) => w.startsWith('+')).map((w) => w.slice(1)), ...args.filter((w, k) => args[k - 1] === '+')];
        out.push(...ordenes.flatMap((o) => [...o.matchAll(/(?:^|[|\s])(?:w(?:rite)?|sav(?:eas)?|x(?:it)?|wq)!?\s+(\S+)/g)].map((x) => x[1])).filter(es));
      }
      continue;
    }
    if (c === 'sed' || c === 'gsed') {
      // `w <archivo>` (o el modificador `w` de `s///w <archivo>`) escribe hasta el final del renglón del guion
      const guiones = [...lleva(['-e', '--expression']), ...(args.some((w) => /^-[A-Za-z]*[ef]$|^--(?:expression|file)/.test(w)) ? [] : posicionales(args, /^-[lf]$/).slice(0, 1))];
      out.push(...guiones.flatMap((g) => [...g.matchAll(/(?:^|[;\n}\s]|\/[gpIi0-9]*)w\s+([^\n;]+)/g)].map((x) => x[1].trim())).filter(es));
    }
    // los que cambian el archivo que nombran: `sed -i` y `perl -i` (sus archivos, sin el guion), el `of=` de `dd` y
    // `truncate`. Se miran acá también, además de en `extractWriteTargets`, para resolverlos desde cada carpeta de un `cd`
    if ((c === 'sed' || c === 'gsed') && args.some((w) => /^-[A-Za-z]*i|^--in-place/.test(w))) {
      const conGuionAparte = args.some((w) => /^-[A-Za-z]*[ef]$|^--(?:expression|file)/.test(w));
      out.push(...posicionales(args, /^-[A-Za-z]*[ef]$|^--(?:expression|file)$|^-l$/).slice(conGuionAparte ? 0 : 1).filter(es));
      continue;
    }
    // el grupo de banderas puede llevar el separador de registro con dígitos antes de `-i` (`-0pi`, `-0777pi`)
    if (c === 'perl' && args.some((w) => /^-[A-Za-z0-9]*i/.test(w))) { out.push(...posicionales(args, /^-[A-Za-z0-9]*[eEIMm]$/).filter(es)); continue; }
    if (c === 'dd' || c === 'gdd') { out.push(...args.filter((w) => w.startsWith('of=')).map((w) => w.slice(3)).filter(es)); continue; }
    if (c === 'truncate' || c === 'gtruncate') { out.push(...posicionales(args, /^-[sr]$|^--(?:size|reference)$/).filter(es)); continue; }
    // lo que sale de una sustitución de proceso corre en el shell (`source <(echo …)`, `bash <(…)`): no se puede ver
    // antes; si el comando nombra una constancia, no pasa
    if (['source', '.', ...SHELLS_QUE_LEEN_COMANDOS].includes(c) && /<\(/.test(tramo) && /control-changes|gates\.log|exemptions\.jsonl/i.test(String(cmd))) {
      out.push(`${tramo.trim()} (corre en el shell lo que sale de una sustitución de proceso)`);
      continue;
    }
    if (c === 'curl' || c === 'wget') { out.push(...lleva(['-o', '--output', '-O', '--output-document']).filter(es)); continue; }
    if (c === 'tar' || c === 'bsdtar' || c === 'unzip' || c === 'cpio') {
      // lo que trae un archivo comprimido no se ve antes de abrirlo: a la carpeta de una constancia, no pasa
      // `tar -xf`, `tar xzf` (el primer argumento sin guion) o `--extract`; `cpio -i` o `--extract`
      // listar (`unzip -l`, `unzip -Z1`, `unzip -t`, `cpio -it`) o mandar a la salida (`unzip -p`) no escribe
      const extrae = c === 'unzip' ? !args.some((w) => /^-[A-Za-z]*[lZtpv]/.test(w))
        : c === 'cpio' ? args.some((w) => /^-[A-Za-z]*i/.test(w) || w === '--extract') && !args.some((w) => /^-[A-Za-z]*t/.test(w) || w === '--list')
          : args.some((w, k) => /^-[A-Za-z]*x/.test(w) || (k === 0 && /^[A-Za-z]*x[A-Za-z]*$/.test(w)) || w === '--extract' || w === '--get');
      if (!extrae) continue;
      const dirs = lleva(c === 'unzip' ? ['-d'] : c === 'cpio' ? ['-D', '--directory'] : ['-C', '--directory']);
      const destinos = dirs.length ? dirs.map((d) => abs(d)) : [raiz];
      const enFirma = destinos.find(carpetaDeFirma);
      if (enFirma) { out.push(`${enFirma} (no se puede ver qué trae lo que se descomprime)`); continue; }
      // con los nombres cambiados al extraer (`tar -s`, `--transform`, `--strip-components`), lo que se lista no es lo
      // que queda escrito: dentro de un repo, no pasa
      if (c !== 'unzip' && c !== 'cpio' && args.some((w) => w === '-s' || /^--(?:transform|xform|strip-components)(?:=|$)/.test(w))) {
        if (destinos.some(dentroDeUnRepo)) out.push(`${tramo.trim()} (cambia los nombres al extraer: no se puede ver si trae una constancia)`);
        continue;
      }
      // a cualquier otra carpeta, lo que trae se mira antes: una constancia adentro, o un archivo que no se puede
      // listar (por la entrada estándar, que todavía no existe) dentro de un repo, no pasa
      const lista = contenidoDelArchivo(c, args, tramo, abs);
      if (lista === null) { if (destinos.some(dentroDeUnRepo)) out.push(`${tramo.trim()} (no se puede ver si trae una constancia)`); continue; }
      if (lista.some((e) => /control-changes|exemptions\.jsonl/i.test(e) || destinos.some((d) => esRuta(path.join(d, e))))) out.push(`${tramo.trim()} (trae una constancia)`);
      continue;
    }
    // otros que extraen y que el freno no sabe listar: `pax -r`, `ditto -x`, `python3 -m zipfile|tarfile -e`. A la
    // carpeta de una constancia o dentro de un repo, no pasan
    const extractor = (c === 'pax' && args.some((w) => /^-[A-Za-z]*r/.test(w))) ? raiz
      : (c === 'ditto' && args.some((w) => /^-[A-Za-z]*x/.test(w))) ? abs(args.filter((w) => !w.startsWith('-')).pop() || '.')
        : (/^python[\d.]*$/.test(c) && args[0] === '-m' && /^(?:zipfile|tarfile)$/.test(args[1] || '') && args.some((w) => w === '-e' || w === '--extract'))
          ? abs(args[args.length - 1] && !args[args.length - 1].startsWith('-') && args.length > 4 ? args[args.length - 1] : '.') : null;
    if (extractor) {
      if (carpetaDeFirma(extractor) || dentroDeUnRepo(extractor)) out.push(`${tramo.trim()} (no se puede ver si trae una constancia)`);
      continue;
    }
    if (c === 'git') {
      // las opciones de git antes del subcomando, con su valor; `-C` cambia la carpeta de las rutas
      let i = 0;
      while (i < args.length && args[i].startsWith('-')) {
        if (/^(?:-C|-c|--git-dir|--work-tree|--namespace|--exec-path)$/.test(args[i])) {
          if (args[i] === '-C' && args[i + 1]) base = path.resolve(base, args[i + 1]);
          i += 2;
        } else i += 1;
      }
      c = `git ${args[i]}`;
      args = args.slice(i + 1);
    }
    const sueltos = args.filter((w) => !w.startsWith('-') && !w.startsWith('<'));
    if (c === 'link') {
      const o = sueltos.find((x) => es(x));
      if (o) { out.push(`${o} (enlace duro)`); continue; }
    }
    if (['cp', 'mv', 'git mv', 'install', 'rsync', 'ditto', 'scp', 'ln'].includes(c)) {
      // el valor de una opción de `rsync`, `scp`, `install` o `ditto` (`--exclude x`) no es el destino
      let deLaCopia = args;
      if (OPCIONES_CON_VALOR[c]) {
        const { sueltos, carpeta } = argumentosDeCopia(c, args);
        deLaCopia = carpeta ? ['--target-directory', carpeta, ...sueltos] : sueltos;
      }
      const copia = destinoDeLaCopia(deLaCopia, ['cp', 'mv', 'install', 'ln'].includes(c));
      if (!copia) continue;
      if (es(copia.destino)) { out.push(copia.destino); continue; }
      // un enlace duro le da otro nombre a la constancia, y escribir en ese nombre la escribe: `ln` sin `-s` y `cp -l`
      const simbolico = args.some((w) => /^-[A-Za-z]*s[A-Za-z]*$/.test(w) || w === '--symbolic');
      const duro = (c === 'ln' && !simbolico) || (c === 'cp' && args.some((w) => /^-[A-Za-z]*l[A-Za-z]*$/.test(w) || w === '--link'));
      if (duro) { const o = copia.origenes.find((x) => es(x)); if (o) { out.push(`${o} (enlace duro)`); continue; } }
      // cp, install, scp y rsync sólo bajan a una carpeta con su opción
      const recursiva = !['cp', 'install', 'scp', 'rsync'].includes(c) || args.some((w) => /^-[A-Za-z]*[rRa][A-Za-z]*$/.test(w) || w === '--recursive' || w === '--archive');
      const destino = abs(copia.destino);
      let esCarpeta = copia.carpeta || /[\\/]$/.test(copia.destino);
      try { esCarpeta = esCarpeta || fs.statSync(destino).isDirectory(); } catch (_) { /* un destino nuevo es el nombre de la copia */ }
      for (const o of copia.origenes) {
        const adentro = /[\\/]\.?$/.test(o);
        const lugar = esCarpeta && !adentro ? path.join(destino, path.basename(o.replace(/[\\/]\.?$/, ''))) : destino;
        if (esRuta(lugar)) { out.push(o); break; }
        if (!recursiva) continue;
        // un enlace a una carpeta se sigue: la copia trae lo de adentro
        let st = null;
        try { st = fs.statSync(abs(o)); } catch (_) { /* remoto, o todavía no existe */ }
        if (!st) {
          // un origen de otra máquina (`host:ruta`) no se puede ver: frena hacia cualquier carpeta de un repo. Uno que no
          // existe o que está armado (comodín, variable) frena sólo hacia una carpeta de constancias: una plantilla copiada
          // a la raíz con un origen armado pasa, y la mira la CI
          const remoto = /^[^\\/]*[^\\/:]:/.test(String(o)) && !/^[A-Za-z]:[\\/]/.test(String(o));
          if (remoto ? dentroDeUnRepo(destino) : (sg.isRecordsDir(destino) || sg.isRecordsDir(lugar) || esRuta(path.join(lugar, 'x')))) { out.push(`${o} (no se puede ver qué trae)`); break; }
          continue;
        }
        if (!st.isDirectory()) continue;
        const hallados = nombresDeConstancia(abs(o));
        if (hallados === null) {
          if (dentroDeUnRepo(destino)) { out.push(`${o} (no pude revisar todo lo que trae)`); break; }
          continue;
        }
        if (hallados.some((rel) => esRuta(path.join(lugar, rel)))) { out.push(o); break; }
      }
    } else if (c === 'git update-index' || (c === 'git checkout' && !args.some((w) => /^(?:-b|-B|--orphan)$/.test(w)) && (args.indexOf('--') > 0 ? args.slice(0, args.indexOf('--')).some((w) => !w.startsWith('-')) : sueltos.length >= 2 || (sueltos.length === 1 && args.some((w) => /^--pathspec-from-file(?:=|$)/.test(w))))) || (c === 'git restore' && args.some((w) => /^(?:--source|-s)/.test(w)))) {
      out.push(...sueltos.flatMap((w) => w.split(',')).filter(es));
      // una carpeta repuesta desde otra rama (`git checkout otra -- .`) trae las constancias que esa rama tenga distintas:
      // se le pregunta a git cuáles cambiarían; si git no contesta, la carpeta que las puede contener no pasa
      const desdeRef = c === 'git checkout' ? (args.indexOf('--') > 0 ? args.slice(0, args.indexOf('--')).find((w) => !w.startsWith('-')) : sueltos[0])
        : c === 'git restore' ? lleva(['--source', '-s'])[0] : null;
      // una ref que empieza con guion sería una opción de `git diff` (`--output=<archivo>`): no se le pregunta a git
      if (desdeRef && desdeRef.startsWith('-')) out.push(`${tramo.trim()} (no pude ver qué constancias trae ${desdeRef})`);
      else if (desdeRef && args.some((w) => /^--pathspec-from-file(?:=|$)/.test(w))) out.push(`${tramo.trim()} (las rutas vienen de un archivo: no pude ver qué constancias trae ${desdeRef})`);
      else if (desdeRef) {
        const fuentes = c === 'git restore' ? lleva(['--source', '-s']) : [desdeRef];
        const rutas = (c === 'git checkout' && args.indexOf('--') > 0 ? args.slice(args.indexOf('--') + 1) : sueltos.filter((w) => !fuentes.includes(w)))
          .filter((w) => w && !w.startsWith('-') && !es(w));
        if (rutas.length) {
          // `checkout <ref> -- <rutas>` escribe lo que la ref trae y no borra lo que no tiene (lo que en el diff aparece
          // como agregado); `restore --source` también borra, así que cuenta todo
          const filtro = c === 'git checkout' ? ['--diff-filter=a'] : [];
          const r = require('child_process').spawnSync('git', ['-C', base, 'diff', '--name-only', ...filtro, '--end-of-options', desdeRef, '--', ...rutas],
            { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
          if (r.error || r.status !== 0) {
            const raiz = require('child_process').spawnSync('git', ['-C', base, 'rev-parse', '--show-toplevel'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
            const top = raiz.status === 0 ? String(raiz.stdout).trim() : null;
            // sin la raíz del repo, una ruta suelta a un archivo no puede traer una constancia; una carpeta, un patrón o
            // una ruta que nombra la carpeta de las constancias, sí
            const esCarpeta = (w) => { try { return fs.statSync(abs(w)).isDirectory(); } catch (_) { return false; } };
            const cubre = (w) => /[*?[]/.test(w) || w.startsWith(':') || (top
              ? ['.github', '.tycon'].some((d) => { const rel = path.relative(abs(w), path.join(top, d)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); })
              : w === '.' || esCarpeta(w) || /(?:^|[\\/])(?:\.github|\.tycon|control-changes)(?:[\\/]|$)/i.test(w));
            const dudosas = rutas.filter(cubre);
            if (dudosas.length) out.push(`${tramo.trim()} (no pude ver qué constancias trae ${desdeRef})`);
          } else {
            const traidas = String(r.stdout).split(/\r?\n/).filter(Boolean).filter((p) => constanciaDeGit(p));
            if (traidas.length) out.push(...traidas.map((p) => `${p} (desde ${desdeRef})`));
          }
        }
      }
    } else if (['git merge', 'git reset', 'git cherry-pick', 'git revert', 'git read-tree', 'git rebase', 'git pull', 'git stash', 'git switch', 'git checkout', 'git branch', 'git update-ref', 'git symbolic-ref', 'git fetch', 'git push', 'git remote', 'git config'].includes(c)) {
      const desde = base;
      out.push(...constanciasDeOtraRama(c, args, base, constanciaDeGit, { tramo, anidado: (sub) => constanciasTocadas(sub, desde, stateDir) }).map((p) => `${tramo.trim()} (${p})`));
    } else if (c === 'git apply' || c === 'git am' || c === 'patch') {
      const textos = [];
      const heredoc = /<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\1/.exec(tramo);
      if (heredoc) {
        // otro heredoc antes con la misma marca no es el del parche: se miran todos los cuerpos con esa marca
        const cuerpos = [...String(cmd).matchAll(new RegExp(`<<-?[ \\t]*(['"]?)${heredoc[2]}\\1[^\\n]*\\n([\\s\\S]*?)\\n[ \\t]*${heredoc[2]}[ \\t]*(?=\\n|$)`, 'g'))];
        if (cuerpos.length) textos.push(...cuerpos.map((x) => x[2])); else textos.push(null);
      }
      const entrada = /(?<!<)<(?!<)\s*([^\s<>;&|]+)/.exec(tramo);
      // la marca del texto en línea (`<<'EOF'`) no es un archivo
      const sinMarca = heredoc ? args.filter((w) => w !== heredoc[2] && !/^<</.test(w)) : args;
      const parches = c === 'patch' ? parchesDePatch(sinMarca) : sinMarca.filter((w) => !w.startsWith('-') && !w.startsWith('<'));
      if (entrada) parches.push(entrada[1]);
      for (const p of parches) {
        try { textos.push(fs.readFileSync(abs(p), 'utf8')); } catch (e) { out.push(`${p} (no se pudo leer el parche: ${e.code || e.message})`); }
      }
      const porEntrada = !heredoc && !entrada && (parches.length === 0 || args.includes('-'));
      if (porEntrada) out.push(`${tramo.trim()} (un parche por la entrada estándar no se puede mirar antes)`);
      for (const t of textos) {
        if (t === null) out.push(`${tramo.trim()} (no encontré el final del texto del parche)`);
        else if (parcheNombraConstancia(t, isControlApproval)) out.push(tramo.trim());
      }
    }
  }
  return [...new Set(out)];
}

// mientras se lee el comando con la carpeta escrita (abajo): esa lectura no abre otra
let leyendoConLaCarpeta = false;

/** La raíz del repo de `carpeta` (la primera carpeta hacia arriba con `.git`), o null. */
function raizDelRepo(carpeta) {
  let d = path.resolve(carpeta);
  for (;;) {
    try { if (fs.existsSync(path.join(d, '.git'))) return d; } catch (_) { return null; }
    const arriba = path.dirname(d);
    if (arriba === d) return null;
    d = arriba;
  }
}

function historiasPorConsola(cmd, cwd, targets, sesion = cwd, destinosConComodin = [], hondo = 0, instalados = []) {
  // con las comillas pegadas en medio de una palabra (`rm sp""ecs/h.md`) se lee también como lo deja el shell
  const pegadas = sinComillasPegadas(cmd);
  if (pegadas !== String(cmd)) {
    const h = historiasPorConsola(pegadas, cwd, extractWriteTargets(pegadas, { keep: () => true }), sesion, destinosConComodin, hondo, instalados);
    if (h.length) return h;
  }
  // con la carpeta del comando nombrada (`rm $PWD/specs/h.md`, `find ~+ …`, `$(git rev-parse --show-toplevel)`), se lee
  // también con esa carpeta escrita, tramo por tramo: cada `cd` mueve `$PWD` (A50)
  if (hondo === 0 && !leyendoConLaCarpeta) {
    // desde la carpeta de la sesión: quien llama puede haber movido `cwd` al primer `cd` del comando, que el recorrido
    // vuelve a aplicar (`cd specs && rm $PWD/h.md`)
    const raiz = raizDelRepo(sesion) || raizDelRepo(cwd);
    const porTramo = conCarpetasPorTramo(cmd, sesion, { raiz });
    // y con la carpeta de cada `cd` del comando en todo el texto (hasta ocho): con `cd $PWD/specs && rm h.md`, quien llama
    // no pudo mover la carpeta y el `rm` relativo se lee desde la del `cd`
    const destinos = [...porTramo.matchAll(CD_DEL_TRAMO)].map((m) => m[2]).filter((d) => !/[$*?[{`]/.test(d) && d !== '-')
      .map((d) => resolveTarget(d, sesion, process.platform, { homeVariable: true }));
    const escritos = [porTramo, ...[...new Set(destinos)].slice(0, 8).map((d) => conCarpetasNombradas(cmd, d, { raiz, carpetaAnterior: sesion }))];
    for (const escrito of [...new Set(escritos)].filter((e) => e !== String(cmd))) {
      // en el mismo nivel: lo que corre otro programa (`find … -exec`, `| xargs`) también se mira. El texto escrito ya no
      // nombra la carpeta, así que no vuelve a entrar acá
      // una sola vez por comando: adentro, la segunda lectura no se vuelve a abrir
      leyendoConLaCarpeta = true;
      let h;
      try { h = historiasPorConsola(escrito, cwd, extractWriteTargets(escrito, { keep: () => true }), sesion, destinosConComodin, 0, instalados); } finally { leyendoConLaCarpeta = false; }
      if (h.length) return h;
    }
  }
  const enSitio = editaEnSitio(cmd);
  const destinosB = destinosBorrados(cmd);
  // más allá del tope no se sabe qué corre: si nombra la ruta de una historia y escribe o borra, frena por el texto
  const sinLeer = anidadosHasta(cmd).hondos.some((h) => NOMBRA_RUTA_DE_HISTORIA.test(h) && (ESCRIBE.test(h) || BORRA_O_MUEVE.test(h)));
  // un guion de shell que escribe un heredoc del mismo comando corre lo que dice, y lo mismo lo que llega por otro
  // programa: se mira como otro comando, un nivel. Lo que corre adentro (`sh -c '…'`, `$(…)`, comillas invertidas,
  // también dentro de la orden de un `xargs`) se mira igual: su redirección a una historia escribe aunque vaya entre
  // comillas para el comando de afuera
  // lo que pasa el tope se dice primero: la lectura de abajo vería sólo los niveles que alcanza
  if (sinLeer) return [`(un comando anidado a más de ${TOPE_ANIDADOS} niveles nombra una historia y escribe o borra: no se lee qué corre)`];
  if (hondo === 0) {
    const porOtro = [...guionesDeShellEscritos(cmd, [...new Set([cwd, sesion])]), ...comandosPorOtroPrograma(cmd, cwd)];
    // sólo lo que de verdad corre (en posición de comando): un `sh -c "…"` citado en un mensaje o en un texto no
    const adentro = [cmd, ...porOtro].flatMap((t) => comandosAnidados(sinCuerposDeTexto(t)).slice(1));
    for (const texto of [...new Set([...porOtro, ...adentro])]) {
      const h = historiasPorConsola(texto, cwd, extractWriteTargets(texto, { keep: () => true }), sesion, [], hondo + 1, instalados);
      if (h.length) return h;
    }
  }
  if (!enSitio && !destinosB.length && !ESCRIBE.test(String(cmd || ''))) return [];
  // con todos los editores en el lugar escritos como `sed` que nombra sus archivos, lo que escriben es lo que nombran:
  // la carpeta de un `cd` es desde dónde se leen, y una historia que tocan se ensaya para ver si le cambia el estado
  const seds = enSitio ? sedsLiterales(cmd) : null;
  const resolver = (raw, base) => resolveTarget(expandirRuta(cmd, raw).valor, base, process.platform, { homeVariable: true });
  const bases = [cwd];
  // cada `cd` o `pushd` desde la sesión y también desde el anterior (`cd sub && cd ../specs`); `cd -` vuelve al de antes.
  // La carpeta de un `env -C` también es una base
  const visitadas = [cwd];
  for (const m of String(cmd).matchAll(/(?:^|[\s;&|(])(?:cd|pushd)\s+(['"]?)([^\s'";&|)]+)\1/g)) {
    if (m[2] === '-') { if (visitadas.length > 1) visitadas.pop(); continue; }
    const encadenada = resolver(m[2], visitadas[visitadas.length - 1]);
    bases.push(resolver(m[2], cwd), encadenada);
    visitadas.push(encadenada);
  }
  for (const t of tramos(String(cmd))) for (const d of pelarEnv(t).carpetas) bases.push(resolver(d, cwd));
  // con un editor en el lugar, la carpeta de cada `cd` cuenta por las historias que tiene, salvo en la forma exacta de
  // un solo `sed` (o un solo `perl` que sólo sustituye) que nombra sus archivos: desde la sesión y desde el `cd` anterior,
  // con su comodín expandido; la que no se sabe resolver frena
  const carpetasDeCd = [];
  const cdSinResolver = [];
  if (enSitio && cdInicial(cmd) == null) {
    // un comodín puede dejar varias carpetas: el `cd` que sigue se resuelve desde todas
    let previas = [sesion];
    const absoluta = (v, b) => resolveTarget(v, b, process.platform, { homeVariable: true });
    for (const c of carpetasDeLosCd(cmd)) {
      if (c.valor == null) { cdSinResolver.push(`cd ${c.texto}`); continue; }
      // `cd` solo va a HOME: mueve la base del `cd` que sigue, pero la HOME entera no es una carpeta de historias
      if (!c.texto) { previas = [os.homedir()]; continue; }
      const desde = [...new Set([...previas, sesion])];
      const aviso = {};
      const halladas = c.comodin
        ? desde.flatMap((b) => expandirComodin(c.valor.replace(/^~(?=\/|$)/, os.homedir()), b, aviso))
        : desde.map((b) => absoluta(c.valor, b));
      // `expandirComodin` corta en 200 por tramo: con un tramo recortado no se sabe si quedó una carpeta afuera
      if (aviso.recortado) cdSinResolver.push(`cd ${c.texto} (más de 200 carpetas)`);
      (seds ? bases : carpetasDeCd).push(...halladas);
      previas = c.comodin ? (halladas.length ? halladas : previas.map((b) => absoluta(c.valor, b))) : halladas.slice(0, previas.length);
    }
  }
  for (const tramo of tramos(cmd)) {
    const words = palabras(tramo.trim().replace(PREFIJO, '')).filter((w) => w !== '');
    const i = words.findIndex((w) => path.basename(w) === 'find');
    if (i >= 0) for (const w of words.slice(i + 1)) { if (w.startsWith('-') || w === '!' || w === '(') break; bases.push(resolver(w, cwd)); }
  }
  // un guion que escribe, copia, mueve o borra: cuenta cada texto que nombra (`glob.glob('specs/*.md')`, `'h.md'`)
  // las comillas escapadas del shell (`open(\"specs/h.md\", \"w\")`) cuentan como comillas
  const textosDeGuion = scriptsInline(cmd).filter(({ script }) => GUION_ESCRIBE.test(script) || algunOpenEscribe(script))
    .flatMap(({ script }) => [script, sinEscapesDeComillas(script)])
    .flatMap((script) => [...script.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2]).filter((t) => !/\s/.test(t)));
  const borrados = destinosB.map((d) => d.raw);
  // lo que sólo se repone (`git checkout -- x`, `git restore x`): cuenta si la historia tiene cambios que perdería
  // (desde otra rama o commit, `git checkout <ref> -- x` o `git restore --source`, la cambia aunque no tenga cambios)
  const conRef = /\bgit\b[^\n;&|]*\scheckout\s+(?!--)[^\s-]\S*\s+--|\bgit\b[^\n;&|]*\srestore\b[^\n;&|]*\s(?:--source|-s)\b/.test(String(cmd));
  const soloRepone = new Set(conRef ? [] : destinosB.filter((d) => d.kind === 'restore').map((d) => d.raw));
  const nombradas = seds ? seds.map((x) => x.archivo) : palabrasDelEditor(cmd);
  const crudos = [
    ...targets,
    ...destinosArmados(cmd).flatMap((a) => (a.literal ? [a.literal] : (a.literales || []))),
    // lo que borra, repone (`git checkout -- h.md`, `git restore`) o saca de `.md` con un `mv`: también la toca
    ...borrados,
    ...movidosFueraDeMd(cmd),
    ...destinosDeCopia(cmd),
    ...textosDeGuion,
    ...destinosDeGuionDeSed(cmd, bases),
    // con un `for`, cuentan todas las palabras salvo que lo de afuera del bucle sólo lea
    ...(enSitio ? nombradas : (FOR_IN.test(cmd) ? (palabrasDelBucleSiFueraSoloSeLee(cmd, [...new Set([cwd, sesion])], instalados) || nombradas) : [])),
  ];
  // una carpeta cuenta por las historias que tiene adentro cuando el comando la borra, la repone o la edita en el lugar
  // (`git checkout <rama> -- specs/`, `git restore .`, `grep -rl x specs | xargs sed -i`)
  const porCarpeta = new Set([...borrados, ...(enSitio ? nombradas : [])]);
  const adentro = (dir) => mdAdentro(dir);
  const vistos = new Set();
  const repuestos = new Set();   // las que sólo se nombran como algo que se repone
  const otros = new Set();
  // lo que nombra otra cosa que un `sed` ensayable: ésas no se ensayan
  const noSoloSed = new Set();
  const deSed = new Set(seds ? nombradas : []);
  const sedsDe = new Map();
  // el paréntesis que cierra un subshell no es parte de la ruta: `(cd specs; echo x >> h.md)`. Una variable que puede no
  // haber quedado puesta (`cd wt && f=specs/h.md && python3 - "$f" <<EOF`) cuenta también por lo que valdría si corrió
  // (con las llaves expandidas, como el shell: `specs/{h,x}.md` nombra `specs/h.md` entera)
  const valoresDe = (raw) => {
    // la comilla invertida que cierra (`echo \`sed -i … h.md\``) tampoco
    const limpio = String(raw).replace(/[)`]+$/, '');
    // con comillas escapadas del shell (`python3 -c "open(\"$F\", \"w\")"`) el lector de variables no sabe leer el
    // comando y deja la variable sin expandir: cuenta también lo que valdría leído con esas comillas como comillas
    return [...new Set([expandirRuta(cmd, limpio).valor, expandirRuta(cmd, limpio, { posibles: true }).valor,
      expandirRuta(sinEscapesDeComillas(cmd), limpio, { posibles: true }).valor]
      .flatMap((v) => (v ? expandirLlaves(v) : [v])))];
  };
  for (const raw of crudos) for (const valor of valoresDe(raw)) {
    // una palabra que no nombra un archivo no es un destino: el `))` que cierra una cuenta queda vacío sin sus
    // paréntesis, y la `/` suelta de un guion (`'s/^a /b /'`) no es la raíz que el editor escribe; la raíz que se
    // borra o que es destino de una escritura sigue contando
    if (!valor || (/^\/+$/.test(valor) && !borrados.includes(raw) && !targets.includes(raw))) continue;
    const anotar = (abs) => {
      vistos.add(abs);
      (soloRepone.has(raw) ? repuestos : otros).add(abs);
      if (!deSed.has(raw)) noSoloSed.add(abs);
      else sedsDe.set(abs, [...(sedsDe.get(abs) || []), ...seds.filter((x) => x.archivo === raw)]);
    };
    for (const base of bases) {
      // el comodín de un `sed` que nombra sus archivos cuenta sólo por lo que expande: recortado, puede dejar una
      // historia afuera
      const aviso = {};
      const rutas = /[*?[]/.test(valor) ? expandirComodin(valor.replace(/^~(?=\/|$)/, os.homedir()), base, aviso)
        : [resolveTarget(valor, base, process.platform, { homeVariable: true })];
      if (aviso.recortado && deSed.has(raw)) cdSinResolver.push(`${raw} (más de 200 coincidencias desde ${base})`);
      for (const abs of rutas) {
        let esCarpeta = false;
        try { esCarpeta = porCarpeta.has(raw) && !NEVER_CODE_SEGMENTS.has(path.basename(abs)) && fs.statSync(abs).isDirectory(); } catch { /* no existe */ }
        if (esCarpeta) { for (const md of adentro(abs)) anotar(md); continue; }
        if (/\.md$/i.test(abs) && fs.existsSync(abs)) anotar(abs);
      }
    }
  }
  for (const dir of new Set(carpetasDeCd)) {
    let esCarpeta = false;
    try { esCarpeta = !NEVER_CODE_SEGMENTS.has(path.basename(dir)) && fs.statSync(dir).isDirectory(); } catch { /* no existe */ }
    if (!esCarpeta) continue;
    const { mds, incompleta } = recorrerCarpetaDeCd(dir);
    // sin recorrerla entera (los topes, una carpeta que no se puede leer) puede quedar una historia sin mirar
    if (incompleta) cdSinResolver.push(`cd ${dir} (${incompleta})`);
    for (const md of mds) { vistos.add(md); otros.add(md); }
  }
  // un destino con un `$(date …)` puede caer en cualquier archivo de su carpeta: si la carpeta tiene
  // historias, cuentan todas (salga `.md` o `.log`)
  // (con las variables del comando, y desde cada carpeta donde puede estar parado: `cd a; cd ../b`, `cd a || cd b`)
  const basesDelDestino = [...new Set([...bases, sesion, ...carpetasDelComando(cmd, sesion)])];
  for (const glob of destinosConComodin) {
    const carpeta = path.dirname(expandirRuta(cmd, glob).valor);
    const aviso = {};
    const carpetas = basesDelDestino.flatMap((b) => (/[*?[]/.test(carpeta) ? expandirComodin(carpeta, b, aviso)
      : [resolveTarget(carpeta, b, process.platform, { homeVariable: true })]));
    // con un tramo del comodín recortado no se sabe si quedó afuera una carpeta con historias
    if (aviso.recortado) cdSinResolver.push(`${glob} (más de 200 carpetas)`);
    for (const dir of new Set(carpetas)) {
      let nombres = [];
      try { nombres = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
        // una carpeta que no existe no tiene historias; una que no se puede leer, no se sabe
        if (e && e.code !== 'ENOENT' && e.code !== 'ENOTDIR') { logHookError(e); cdSinResolver.push(`${glob} (no pude leer ${dir})`); }
        continue;
      }
      for (const e of nombres) {
        if (!/\.md$/i.test(e.name)) continue;
        const p = path.join(dir, e.name);
        // un enlace simbólico a una historia cuenta como la historia
        let esArchivo = e.isFile();
        if (e.isSymbolicLink()) { try { esArchivo = fs.statSync(p).isFile(); } catch { /* roto */ } }
        if (esArchivo) { vistos.add(p); otros.add(p); }
      }
    }
  }
  // reponer una historia sin cambios no le cambia nada: pasa (`git restore .` después de tocar código)
  const conCambios = (abs) => {
    const r = require('child_process').spawnSync('git', ['-C', path.dirname(abs), 'status', '--porcelain', '--', abs],
      { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return r.error || r.status !== 0 || String(r.stdout).trim() !== '';
  };
  for (const abs of repuestos) if (!otros.has(abs) && !conCambios(abs)) vistos.delete(abs);
  // los cuerpos de los heredocs que reescriben el archivo entero (`>`, no `>>`); con varios para el mismo archivo, se
  // miran todos
  const enteros = new Map();
  for (const h of heredocs(cmd)) {
    if (!h.target || !new RegExp(`(?:^|[^>])>\\s*['"]?${h.target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(cmd)) continue;
    const abs = resolveTarget(expandirRuta(cmd, h.target).valor, cwd, process.platform, { homeVariable: true });
    enteros.set(abs, [...(enteros.get(abs) || []), h.body]);
  }
  const sinResolver = cdSinResolver.map((t) => `(la carpeta de \`${t}\`, que no sé resolver: puede tener historias)`);
  return [...sinResolver, ...[...vistos].filter((abs) => {
    const estado = estadoDeHistoria(abs);
    if (estado === null) return false;
    // un `sed` que deja el encabezado como estaba no la cierra: pasa como el cuerpo editado con Edit. Los `status:` de
    // arriba tienen que quedar iguales y, además, la herramienta de edición tiene que dejar pasar el mismo cambio (una
    // tanda del bloque `pipelines` a `done`, el número de la historia, un estado repetido)
    if (sedsDe.has(abs) && !noSoloSed.has(abs)) {
      let antes = null;
      try { antes = fs.readFileSync(abs, 'utf8'); } catch (e) { logHookError(e); }
      const despues = antes == null ? null : ensayarSeds(abs, [...new Set(sedsDe.get(abs))]);
      const ea = estadosDelEncabezado(antes || '');
      if (despues != null && ea.length && JSON.stringify(ea) === JSON.stringify(estadosDelEncabezado(despues))
        && !require('./story-transition.js').transicionAMano(abs, antes, despues)) return false;
    }
    if (estado !== 'draft') return true;
    // el estado del encabezado de cada cuerpo (todos sus `status:` en borrador), no un `status: draft` cualquiera más
    // abajo: frena si alguno deja de estar en borrador
    return (enteros.get(abs) || ['']).some((cuerpo) => {
      const fm = /^---\s*\n([\s\S]*?)\n---/.exec(cuerpo);
      const estados = fm ? [...fm[1].matchAll(/^["']?status["']?\s*:\s*["']?([\w-]+)/gm)].map((m) => m[1].toLowerCase()) : [];
      return !(estados.length && estados.every((e) => e === 'draft'));
    });
  })];
}

// La coordinadora no cambia archivos de los repos (scripts/lib/coordination-writes.js): lo que el comando escribe o
// borra, con cada carpeta donde puede caer una escritura relativa. Lo que no se resuelve sin ejecutar pasa (también lo
// relativo detrás de un `cd` a una carpeta sin resolver), y lo que escribe un guion guardado en un archivo no se mira:
// los guiones del arnés que corre la coordinadora escriben su estado.
function coordinadoraPorConsola(event, opts = {}) {
  if (event?.tool_name && event.tool_name !== 'Bash' && event.tool_name !== 'PowerShell') return null;
  const original = event?.tool_input?.command;
  if (!original) return null;
  const cmd = sinMayoresQueNoRedirigen(original);
  const baseCwd = nativePath(event?.cwd || process.cwd());
  const archivos = () => {
    const out = [];
    const soloAbsolutos = cdSinResolver(cmd);
    const absoluta = (raw) => {
      const v = String(expandirRuta(cmd, raw).valor);
      return path.isAbsolute(v) || /^~(?:\/|$)/.test(v) || /^\$\{?HOME\}?(?:\/|$)/.test(v);
    };
    const resolverEn = (cwd, d) => {
      const ruta = expandirRuta(cmd, d.raw);
      if (ruta.sinResolver.length) return null;
      let base = cwd;
      if (d.base) {
        const b = expandirRuta(cmd, d.base);
        if (b.sinResolver.length) return null;
        if (soloAbsolutos && !absoluta(d.base)) return null;
        base = resolveTarget(b.valor, cwd, process.platform, { homeVariable: true });
      } else if (soloAbsolutos && !absoluta(d.raw)) return null;
      return resolveTarget(ruta.valor, base, process.platform, { homeVariable: true });
    };
    for (const cwd of carpetasDelComando(conLosCdDeSiempre(cmd), baseCwd)) {
      for (const d of destinosResueltos(cmd, cwd, process.platform, { keep: () => true })) {
        if (d.sinResolver.length || (soloAbsolutos && !absoluta(d.raw))) continue;
        out.push(d.abs);
      }
      for (const d of destinosBorrados(cmd)) {
        const abs = resolverEn(cwd, d);
        // `git checkout <nombre>` sin `--`: si no hay un archivo con ese nombre, es una rama (la cuenta la regla de git)
        if (abs && !(d.quizas && !fs.existsSync(abs))) out.push(abs);
      }
      for (const d of destinosDeLaCoordinadora(cmd)) {
        const abs = resolverEn(cwd, d);
        if (abs) out.push(abs);
      }
    }
    return [...new Set(out)];
  };
  return require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'coordination-writes.js')).judge({
    sessionId: event.session_id, files: archivos, home: opts.home, stateDir: opts.stateDir, installedRoots: opts.installedRoots,
    // con el click del dueño a este comando exacto, pasa una vez
    comando: original, cwd: baseCwd, casa: opts.casa, buscar: opts.buscarAprobacion, herramienta: opts.herramienta,
  });
}

/**
 * Antes de un `git commit` o un `git push` (también con `-C <carpeta>`), cada constancia de control nueva del repo tiene que
 * tener la huella que deja `approve` en esta máquina (lib/control-change-prints.js): mira lo escrito en la carpeta de
 * constancias, no el comando que lo escribió. Sin huella, frena y dice cómo seguir.
 */
function constanciasSinHuella(event, opts = {}) {
  if (event?.tool_name && event.tool_name !== 'Bash' && event.tool_name !== 'PowerShell') return null;
  const cmd = event?.tool_input?.command;
  if (!cmd || !/\bgit\b/.test(cmd) || !/\b(?:commit|push)\b/.test(cmd)) return null;
  const huellas = require('./control-change-prints.js');
  const stateDir = opts.stateDir || require('./story-gate-io.js').DEFAULT_STATE_DIR;
  const sesion = nativePath(event?.cwd || process.cwd());
  // las carpetas donde puede correr el `git` que termina en la posición `hasta` del texto sin cuerpos de heredoc (sin
  // `hasta`, cualquiera): la del `cd` del principio, la de cada `cd` o `pushd` (con sus opciones; desde el anterior y desde
  // la sesión; `cd -` vuelve al de antes, y vale adentro de un paréntesis o de llaves), la de un `env -C` y la de
  // GIT_WORK_TREE o GIT_DIR asignadas. Sólo lo que está antes del `git` y a nivel del shell: un `cd` posterior, o adentro
  // de un texto entre comillas (el mensaje de un commit), de un comentario o del cuerpo de un heredoc, no mueve al `git`.
  // `sinResolver`: las que no se pueden saber (una variable o una sustitución); `demasiadas`: más carpetas que el tope,
  // que no se terminan de leer
  const absoluta = (raw) => resolveTarget(raw, sesion, process.platform, { homeVariable: true });
  const carpetasDe = (texto, hasta = Infinity) => {
    const leido = quitarCuerposDeHeredoc(String(texto));
    const fuera = posicionesFueraDeComillas(leido);
    // la posición de la palabra que sigue al separador con que empieza la coincidencia
    const palabraEn = (m) => m.index + (/^[\s;&|({]/.test(m[0]) ? 1 : 0);
    const out = [cwdDelComando(texto, sesion)];
    const sinResolver = [];
    const visitadas = [sesion];
    // la carpeta del cd: entre comillas, o una palabra suelta que puede llevar `$(…)` o acentos invertidos
    for (const m of leido.matchAll(/(?:^|[\s;&|({])(?:cd|pushd)(?:[ \t]+(?:-[LPe@]+|--))*[ \t]+(?:'([^']*)'|"([^"]*)"|((?:\$\([^()]*\)|`[^`]*`|[^\s;&|()<>'"`])+))/g)) {
      if (palabraEn(m) >= hasta) break;
      if (!fuera(palabraEn(m))) continue;
      const tok = m[1] ?? m[2] ?? m[3];
      if (tok === '-') { if (visitadas.length > 1) visitadas.pop(); out.push(visitadas[visitadas.length - 1]); continue; }
      if (!tok) continue;
      // un comodín sin comillas lo expande el shell: no se sabe a qué carpeta va
      if (m[3] !== undefined && /[*?[]|\{[^}]*,/.test(tok)) { sinResolver.push(`cd ${tok}`); continue; }
      const ex = expandirRuta(leido.slice(0, m.index + m[0].length), tok);
      if (ex.sinResolver.length) { sinResolver.push(`cd ${tok}`); continue; }
      const encadenada = resolveTarget(ex.valor, visitadas[visitadas.length - 1], process.platform, { homeVariable: true });
      out.push(encadenada, absoluta(ex.valor));
      visitadas.push(encadenada);
      if (new Set(out).size > TOPE_DE_CARPETAS_DE_CD) return { carpetas: [...new Set(out)], sinResolver, demasiadas: true };
    }
    let cursor = 0;
    for (const t of tramos(String(texto))) {
      const p = leido.indexOf(t, cursor);
      if (p < 0) continue;
      if (p >= hasta) break;
      cursor = p + t.length;
      for (const d of pelarEnv(t).carpetas) out.push(absoluta(d));
    }
    for (const m of leido.matchAll(/(?:^|[\s;&|({])(?:(?:export|local|declare|readonly|typeset)\s+(?:-\w+\s+)*)?(GIT_WORK_TREE|GIT_DIR)=((?:'[^']*'|"(?:\\.|[^"\\])*"|\\.|[^\s'"\\;&|()])*)/g)) {
      if (palabraEn(m) >= hasta) break;
      if (!fuera(palabraEn(m))) continue;
      const v = palabraDelShell(m[2]);
      if (/[$`]/.test(v)) { sinResolver.push(`${m[1]}=${v}`); continue; }
      const abs = absoluta(v);
      out.push(m[1] === 'GIT_DIR' && path.basename(abs) === '.git' ? path.dirname(abs) : abs);
    }
    return { carpetas: [...new Set(out)], sinResolver, demasiadas: false };
  };
  // dos lecturas juntas: la del texto anidado y la del comando que lo lleva
  const unir = (a, b) => (b ? { carpetas: [...new Set([...a.carpetas, ...b.carpetas])], sinResolver: [...a.sinResolver, ...b.sinResolver], demasiadas: a.demasiadas || b.demasiadas } : a);
  const via = `Bash: ${String(cmd).replace(/\s+/g, ' ').slice(0, 120)}`;
  const frena = (texto) => {
    try { require('./story-gate-io.js').appendLog(stateDir, 'gates.log', resolveSessionId(event?.session_id), { name: 'story-gate', status: 'blocked', kind: 'constancia-sin-huella', via, reason: texto.split('\n')[0] }); } catch { /* el registro no traba el freno */ }
    return { block: `${texto}\n` };
  };
  const vistos = new Set();
  // también lo que corre adentro (`bash -c "git commit …"`, `$(…)`), lo que corre otro programa (un heredoc a un shell)
  // y el comando con los renglones partidos con `\` juntados
  const plano = String(cmd).replace(/\\\r?\n/g, ' ');
  const textos = [...new Set([String(cmd), plano, ...comandosAnidados(String(cmd)).slice(1), ...comandosPorOtroPrograma(String(cmd), sesion)])];
  const sinMirar = (que, sub) => frena(`🔒 CONSTANCIA SIN MIRAR — no pude resolver la carpeta de \`${que}\` antes de \`git ${sub}\`: no sé qué repo commitea o empuja ni si lleva una constancia sin firmar. Escribí la ruta sin variables.`);
  const externo = quitarCuerposDeHeredoc(String(cmd));
  for (const texto of textos) {
    // un texto anidado (`$(git push)`, `bash -c "…"`, un `-exec`) corre también en las carpetas del comando que lo lleva,
    // hasta donde aparece
    const anidado = texto !== String(cmd) && texto !== plano;
    const dondeAparece = anidado ? externo.indexOf(String(texto)) : -1;
    const leido = quitarCuerposDeHeredoc(String(texto));
    let cursor = 0;
    for (const tramo of tramos(texto)) {
      const p = leido.indexOf(tramo, cursor);
      const fin = p < 0 ? Infinity : p + tramo.length;
      if (p >= 0) cursor = fin;
      // sin el comentario del final (`git push # x` no empuja `x`), sin el `env` de delante (`env -C repo git push`), sin
      // las redirecciones (`2>&1` o `> salida.txt` no son parte de lo que se empuja) y sin el `)` que cierra un grupo; la
      // palabra vacía de `-C ""` queda (git la toma como «acá»)
      const enTramo = posicionesFueraDeComillas(String(tramo));
      let corte = String(tramo).length;
      if (typeof enTramo.esComentario === 'function') for (let k = 0; k < corte; k++) if (enTramo.esComentario(k)) corte = k;
      const w = palabras(sinPalabrasDelShell(pelarEnv(String(tramo).slice(0, corte)).resto.replace(REDIRECCION, ' '))).map(sinCierreDeGrupo).filter((x, k, a) => x !== '' || a[k - 1] === '-C');
      if (nombreDeComando(w[0]) !== 'git') continue;
      const lectura = unir(carpetasDe(texto, fin), anidado ? carpetasDe(String(cmd), dondeAparece < 0 ? Infinity : dondeAparece) : null);
      const carpetas = lectura.carpetas;
      let dirs = carpetas;
      let fija = false;
      const pendientes = [];
      let i = 1;
      while (i < w.length && /^-/.test(w[i])) {
        const pegada = /^-C(.+)$/.exec(w[i]);
        if ((w[i] === '-C' && w[i + 1] !== undefined) || pegada) {
          const crudo = pegada ? pegada[1] : w[i + 1];
          const ruta = expandirRuta(texto, crudo);
          // una carpeta que no se resuelve no se puede mirar: frena
          if (ruta.sinResolver.length) return frena(`🔒 CONSTANCIA SIN MIRAR — no pude resolver la carpeta de \`git -C ${crudo}\`: no sé qué repo commitea o empuja ni si lleva una constancia sin firmar. Escribí la ruta sin variables.`);
          dirs = dirs.map((d) => resolveTarget(ruta.valor, d, process.platform, { homeVariable: true }));
          fija = fija || path.isAbsolute(String(ruta.valor));
          i += pegada ? 1 : 2; continue;
        }
        // `--work-tree` y `--git-dir`, pegados o aparte, nombran un repo más para mirar (el del `.git` es la carpeta que lo
        // tiene); la carpeta de trabajo sigue: `git --git-dir=<otro> add -A` toma los archivos de acá
        // (`--git-dir="$X"` llega partido en `--git-dir=` y el valor: el `=` vacío toma la palabra que sigue)
        const repoPor = /^--(work-tree|git-dir)(?:=(.*))?$/.exec(w[i]);
        if (repoPor) {
          const valor = repoPor[2] || w[i + 1];
          if (valor !== undefined) pendientes.push([repoPor[1], valor]);
          i += repoPor[2] ? 1 : 2;
          continue;
        }
        // las opciones de git que llevan su valor en la palabra que sigue; `-c user.name="AB"` llega partido en
        // `user.name=` y el valor, que también es de la opción
        if (w[i] === '-c' && /=$/.test(w[i + 1] || '') && w[i + 2] !== undefined && w[i + 2] !== 'commit' && w[i + 2] !== 'push') { i += 3; continue; }
        if (/^(?:-c|--namespace|--super-prefix|--attr-source|--config-env|--exec-path)$/.test(w[i])) { i += 2; continue; }
        i++;
      }
      const sub = w[i];
      if (sub !== 'commit' && sub !== 'push') continue;
      for (const [cual, valor] of pendientes) {
        const ruta = expandirRuta(texto, valor);
        if (ruta.sinResolver.length) return sinMirar(`git --${cual} ${valor}`, sub);
        const abs = resolveTarget(ruta.valor, carpetas[0], process.platform, { homeVariable: true });
        dirs = [...dirs, cual === 'git-dir' && path.basename(abs) === '.git' ? path.dirname(abs) : abs];
      }
      if (!fija && lectura.demasiadas) return frena(`🔒 CONSTANCIA SIN MIRAR — el comando cambia de carpeta más de ${TOPE_DE_CARPETAS_DE_CD} veces antes de \`git ${sub}\`: no sé en qué repo corre ni si lleva una constancia sin firmar. Partilo en comandos más cortos.`);
      if (!fija && lectura.sinResolver.length) return sinMirar(lectura.sinResolver[0], sub);
      // lo que se empuja: sin refspec, la rama de HEAD; con `--all`/`--mirror`/`--branches` (también abreviadas) o un
      // comodín, todas; si no, el origen de cada refspec. Borrar una rama remota no empuja nada
      let refs = ['HEAD'];
      if (sub === 'push') {
        const resto = w.slice(i + 1);
        const posicionales = [];
        let remotoPorOpcion = false;
        let borra = false;
        for (let k = 0; k < resto.length; k++) {
          const x = resto[k];
          if (/^(?:-o|--push-option|--repo|--receive-pack|--exec)$/.test(x)) { if (x === '--repo') remotoPorOpcion = true; k++; continue; }
          if (/^--repo=/.test(x)) { remotoPorOpcion = true; continue; }
          if (x === '-d' || /^--del(?:e(?:t(?:e)?)?)?$/.test(x)) { borra = true; continue; }
          if (x.startsWith('-')) continue;
          posicionales.push(x);
        }
        const todas = resto.some((x) => /^--(?:al|all|mir|mirr|mirro|mirror|br|bra|bran|branc|branch|branche|branches)$/.test(x));
        const especificaciones = [];
        const lista = remotoPorOpcion ? posicionales : posicionales.slice(1);
        for (let k = 0; k < lista.length; k++) {
          if (lista[k] === 'tag' && lista[k + 1]) { especificaciones.push(`refs/tags/${lista[++k]}`); continue; }
          // un destino con una variable vale lo asignado; uno que no se resuelve (`$(…)`) puede ser cualquier rama
          const ex = expandirRuta(texto, lista[k]);
          const origen = (ex.sinResolver.length ? '*' : String(ex.valor)).replace(/^\+/, '').split(':')[0];
          if (origen) especificaciones.push(/\*/.test(origen) ? '*' : origen);
        }
        if (todas || especificaciones.includes('*')) refs = ['*'];
        else if (borra) refs = [];
        else if (especificaciones.length) refs = especificaciones;
        else if (lista.length) refs = [];
        if (!refs.length) continue;
      }
      for (const dir of dirs) {
        const clave = `${dir}\0${sub}\0${refs.join(',')}`;
        if (vistos.has(clave)) continue;
        vistos.add(clave);
        const cartel = huellas.frenoDe({ dir, cuando: sub, stateDir, refs });
        if (cartel) return frena(cartel);
      }
    }
  }
  return null;
}


module.exports = { constanciasTocadas, historiasPorConsola, coordinadoraPorConsola, constanciasSinHuella };
