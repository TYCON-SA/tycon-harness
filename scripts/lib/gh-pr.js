'use strict';
/**
 * scripts/lib/gh-pr.js — cómo leer un comando `gh` para saber qué PUBLICA (story 8.26, tanda F1 · AC 54).
 *
 * POR QUÉ EXISTE. Con el arnés mantenido directo en su repo público, un `gh pr create`, un comentario o una versión
 * publican texto sin pasar por `git push`: el `pre-push` no los ve. El freno antes de publicar
 * (scripts/hooks/public-push-guard.js) necesita, de cada `gh` de un comando de terminal: si es de lectura, a qué repo
 * apunta y desde dónde corre, qué textos publica, qué archivos sube o lee, y qué parte NO se puede leer desde el texto.
 *
 * Se arma SOBRE el lector de scripts/lib/az-pr.js (`fichas`: un solo recorrido del texto, con conciencia de comillas) y
 * no es otro lector: la regla de ese archivo es que quien necesite leer otro comando lo sume ahí, no escriba otro regex.
 *
 * LAS DECISIONES, y hacia dónde falla cada una:
 *   · LECTURA es una lista CERRADA (`view`, `list`, `status`, `checks`, `diff`, `checkout`, `download`, `clone`, `gh api`
 *     con GET, una consulta de GraphQL que no es una mutación, y los grupos que no publican texto). Un verbo o un alias
 *     que no está en la lista PUBLICA: lo desconocido se mira. El grupo y el verbo son los que vienen PEGADOS a `gh`.
 *   · UNA OPCIÓN CON VALOR SE LLEVA LO QUE SIGUE, empiece como empiece: así lee `gh` (`--title --help` es un título que
 *     dice «--help», no un pedido de ayuda). La ayuda cuenta sólo como opción suelta, y nunca detrás de una opción que
 *     este lector no conoce (podría ser su valor).
 *   · TEXTO es todo valor de opción y todo argumento, salvo lo que elige algo que ya existe (el repo, la rama base, un
 *     commit) y la ruta de un archivo local (se lee el archivo, no se revisa su ruta). Una opción que este lector no
 *     conoce se toma por un interruptor y lo que sigue cuenta como texto: de más, nunca de menos.
 *   · ILEGIBLE es lo que la terminal arma antes de correr: `$(…)`, comillas invertidas, una variable, `$'…'`, la
 *     entrada estándar, el editor, la web, o un programa con la forma de un `gh` que publica que llega por una
 *     variable, o por un alias o una función puestos en la misma línea (un alias del perfil de la terminal no se ve:
 *     es un límite). Y un `gh` que publica pasado como TEXTO A UNA TERMINAL —`bash -c "gh …"`, `iex`, `cmd /c`,
 *     `eval`, `ssh`; como argumento, por una tubería, en un bloque heredoc, o guardado en una variable o un
 *     alias de la misma línea (`TERMINAL`, más abajo, con el porqué de que la lista sea corta)—, y el código de una
 *     línea que lo ejecuta, dado a un intérprete (`INTERPRETE`: `python3 -c`, `node -e`). El mismo texto dado a
 *     otro programa es un dato, y un `gh` de lectura corrido así se lee como tal. ALCANCE: este lector cubre el accidente, no la evasión — se lee la LÍNEA de comando,
 *     no lo que hace un guion que esa línea corre, ni un `gh` armado a pedazos adentro de un texto, ni un programa que
 *     no es una terminal y ejecuta una opción suya. Quien llama decide qué hace con lo ilegible (el freno: no sale). Una
 *     sola excepción, porque es la forma en que un agente escribe el cuerpo de un pedido: `"$(cat <<'EOF' … EOF)"`, con
 *     el delimitador entre comillas (o sin nada que expandir adentro), se LEE — su texto es el cuerpo del bloque.
 *   · DÓNDE CORRE Y A QUÉ REPO VA no siempre está en el `gh`: un `cd` anterior en la misma línea, un `export GH_REPO=…`.
 *     Los `cd` literales se informan en orden (`cds`), diciendo si alguno puede fallar sin cortar la línea
 *     (`cdIncierto`: el `gh` corre en la carpeta nueva o en la de antes); el repo puesto por un comando anterior se
 *     informa como tal (`repoAmbiente`). Lo que no se puede seguir se dice (`cwdDesconocido`, `repoDesconocido`) y
 *     nunca se lee como «sin repo»: un `cd` o un `export` adentro de un subshell, de unas llaves, de un `if`, de una
 *     tubería o en segundo plano; un `cd` entre comillas; un `gh` que corre otro programa (`xargs gh`, `env -C x gh`);
 *     una asignación suelta de GH_REPO; las formas de PowerShell (`$env:GH_REPO = …`).
 *
 *   · LAS RAMAS DE UN PEDIDO (`gh pr create --base … --head …`) no son texto que se publica, pero quien anota una
 *     entrega (scripts/hooks/retro-pending.js) necesita saber hacia dónde va: se devuelven en `base` y `head` —`null`
 *     si la opción no vino; con `baseDesconocida`/`headDesconocida` si la arma la terminal, que no es lo mismo— y
 *     `simulacro` dice si el comando trae `--dry-run` (no crea nada).
 *
 * Devuelve datos, nunca decide si algo sale. `resumen` (`gh pr create`) es lo único pensado para un mensaje: jamás trae
 * texto del comando.
 */

const crypto = require('crypto');
const az = require('./az-pr.js');

const BINARIO = /(^|[\\/])gh(\.exe|\.cmd)?$/i;
// LAS TERMINALES, y los programas que corren como comando el TEXTO que reciben: un `gh` que publica pasado como texto a
// uno de éstos (`bash -c "gh …"`, `iex "gh …"`, `cmd /c`, `eval`, `ssh`; por una tubería, un bloque heredoc o
// un texto de entrada) es una forma común de correrlo, y desde acá no se puede leer. El mismo texto dado a cualquier
// otro programa (`git commit -m`, `grep`, `sed`, `npm test -t`, un guion de python) es un dato.
// 🔴 Es una lista corta A PROPÓSITO. La alternativa —«todo texto con esa forma es oculto salvo en una lista de programas
// inofensivos»— se probó: frenaba `sed`, `npm test -t "…"`, un `python3 - <<EOF` que edita una guía, en CUALQUIER repo.
// Este freno cubre el accidente, no la evasión: un programa que no es una terminal y ejecuta una opción suya (`git -c
// alias.x='!…'`, `git rebase -x`, `rg --pre`), el nombre de `gh` armado a pedazos adentro de un texto, y un `gh` adentro
// de un guion que la línea corre, NO se ven. Lo dice la story (AC 54) y lo mira la verificación de lo publicado.
// (`xargs` no está: corre el programa que se le nombra, y ése se mira —`xargs sh -c …` tiene su `sh`, `xargs gh …` su `gh`—.)
const TERMINAL = /(^|[\\/])((ba|z|k|da|a)?sh|fish|pwsh|powershell|cmd)(\.exe)?$|^(eval|iex|invoke-expression|ssh|watch|su|doas|parallel)$/i;
const HAY_HEREDOC = /\d*<<-?(?!<)/;   // `<<EOF`, `<< EOF`, `3<<EOF`, `bash<<EOF`; `<<<` es otra cosa (su texto sí llega como ficha)
// lo que la terminal expande en una ruta al correr: un comodín, llaves, `~usuario` (`~` y `~/…` no: ésas se saben leer)
const SE_EXPANDE_AL_CORRER = /[*?[\]{}]|^~[^/\\]/;
const GRUPOS_EN_TEXTO = '(pr|issue|release|api|gist|repo|label|project|secret|variable)';
// una sustitución (`$(…` o una comilla invertida) que nombra a `gh` como palabra antes de cerrarse
const GH_EN_SUSTITUCION = /\$\((?!\()[^)]*?(?<![A-Za-z0-9_.-])gh(\.exe)?(\s|$)|`[^`]*?(?<![A-Za-z0-9_.-])gh(\.exe)?(\s|$)/i;
const DENTRO_DE_CADENA = new RegExp(`(^|[^A-Za-z0-9_.-])gh(\\.exe)?\\s+${GRUPOS_EN_TEXTO}\\b`, 'i');
// Código de una línea que EJECUTA un `gh` que publica, en el lenguaje que sea: `os.system("gh …")`, `execSync("gh …")`,
// `subprocess.run("gh …", shell=True)`, `system("gh …")`. Se reconoce por la llamada: un guion que sólo NOMBRA el
// comando (`texto = 'usar gh pr create'`, o entre comillas invertidas en una guía) es un dato.
// Las formas usuales: el comando entero en un texto (`llamada("gh pr create …")`, también `f"…"`, y sin paréntesis
// como en ruby y perl: `system "gh pr create …"`, `%x(gh …)`, `qx{gh …}`), y el programa y sus argumentos por separado
// (`run(['gh', 'pr', 'create', …])`, `execFileSync('gh', ['pr', 'create', …])`).
// El comando que la llamada corre se LEE como una línea más (uno de lectura no se frena). En la lista, lo que no es un
// texto (una variable, una llamada) ocupa su lugar como un argumento más: `["gh", "--repo", repo, "pr", "create"]` se
// lee `gh --repo <algo> pr create`. Cortar la lista en la primera variable lo dejaba en `gh --repo`, «de lectura».
// …y sólo cuenta cuando ese código se le da a un INTÉRPRETE (por `-c`/`-e`, por un bloque o por una tubería). Lista
// corta a propósito, como `TERMINAL`: el mismo texto dado a `grep`, a `git commit -m` o a `echo` es un dato. Frenando
// por la llamada sola, buscar `execSync("gh pr` en el código quedaba frenado en cualquier repo.
const INTERPRETE = /(^|[\\/])(python[\d.]*|pypy[\d.]*|node(js)?|deno|bun|ruby|perl|php|lua|osascript|rscript|tsx|ts-node)(\.exe)?$/i;
// las opciones de un buscador que llevan el nombre de un lenguaje o un patrón de archivos como valor (`rg -t ruby`)
const OPCION_DE_TIPO = /^(-t|-T|--type|--type-not|--type-add|-g|--glob|--iglob|--include|--exclude)$/;
const LLAMADA_CON_TEXTO = new RegExp('(?:\\b(?:system|popen|exec[A-Za-z_]*|spawn[A-Za-z_]*|check_output|check_call|run|call|subprocess\\.[a-z_]+|shell_exec|passthru)\\s*\\(\\s*\\[?\\s*[A-Za-z]?|\\b(?:system|exec)\\s+)(["\'`])', 'gi');
const LLAMADA_SIN_COMILLAS = /(?:%x|\bqx)\s*([({[<|/!])/g;
const CIERRE_DE = { '(': ')', '{': '}', '[': ']', '<': '>' };
const GH_EN_LISTA = /(["'])(\S*[\\/])?gh(\.exe)?\1\s*,/gi;
const GH_COMO_PALABRA = /(?<![A-Za-z0-9_.-])gh(\.exe)?(\s|$)/i;
const ES_UN_GRUPO = new RegExp(`^${GRUPOS_EN_TEXTO}$`, 'i');
const GH_CON_GRUPO = new RegExp(`(?<![A-Za-z0-9_.-])gh(\\.exe)?\\s+[\\s\\S]*?\\b${GRUPOS_EN_TEXTO}\\b`, 'i');
/** Los argumentos de una lista de código desde `desde` (`'pr', 'create', titulo, f"--body={b}"]`), cada uno en su
 *  lugar: `{ texto, literal }` si es UN texto entre comillas y nada más; si no, un argumento cualquiera (`variable`),
 *  con `mezcla` cuando trae un texto con algo pegado (`'--repo=' + repo`, `"view" if x else "create"`, `f(")")`): ése
 *  no se puede leer. Se parte por las comas de afuera: una coma, un paréntesis o un corchete adentro de un texto o de
 *  una llamada no cortan. */
function argumentosDeLista(s, desde) {
  const args = [];
  let ini = desde;
  let hondo = 0;
  let comilla = null;
  const cerrar = (fin) => {
    const crudo = s.slice(ini, fin).trim().replace(/^\[\s*/, '');
    if (!crudo) return;
    const m = /^[A-Za-z]?(["'])((?:\\[\s\S]|(?!\1)[^\\])*)\1$/.exec(crudo);
    args.push(m ? { texto: m[2], literal: true } : { texto: 'variable', literal: false, mezcla: /["']/.test(crudo) });
  };
  let i = desde;
  for (; i < s.length; i += 1) {
    const c = s[i];
    if (comilla) { if (c === '\\') i += 1; else if (c === comilla) comilla = null; continue; }
    if (c === '"' || c === "'") { comilla = c; continue; }
    if (c === '(' || c === '[' || c === '{') {
      if (c === '[' && !s.slice(ini, i).trim()) continue;   // la lista adentro de la llamada: `'gh', ['pr', 'create']`
      hondo += 1;
      continue;
    }
    if (c === ')' || c === ']' || c === '}') { if (hondo === 0) break; hondo -= 1; continue; }
    if (c === ',' && hondo === 0) { cerrar(i); ini = i + 1; }
  }
  cerrar(i);
  return args;
}
const ASIGNACION = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;
const PREFIJOS = new Set(['command', 'env', 'sudo', 'time', 'nohup', 'exec', 'builtin']);
const EXPORTA = new Set(['export', 'declare', 'typeset', 'local', 'readonly']);
// cambiar de carpeta, en una terminal de Unix y en PowerShell (que no distingue mayúsculas)
const ENTRA_A_CARPETA = /^(cd|chdir|pushd|set-location|sl|push-location)$/i;
const SALE_DE_CARPETA = /^(popd|pop-location)$/i;
// las palabras con que una terminal agrupa comandos; los paréntesis de un subshell llegan como operadores
const AGRUPADORES = new Set(['{', '}', 'if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'do', 'done', 'for', 'case', 'esac', 'function']);
// las variables con que `gh` decide a qué repo va, nombradas de cualquier forma (`GH_REPO=…`, `$env:GH_REPO`, `env:GH_REPO`)
const DESTINO_DE_GH = /GH_(REPO|HOST)/i;
// `gh` nombrado adentro de una ficha que no es el programa de un comando: `g=gh`, `gh pr` (el valor de un alias), `gh`
const NOMBRA_A_GH = /(^|[=\s\\/])gh(\.exe|\.cmd)?($|\s)/i;

// ── lectura: la lista cerrada ────────────────────────────────────────────────────────────────────────────────────
const GRUPOS_DE_LECTURA = new Set(['auth', 'config', 'help', 'version', 'search', 'browse', 'status', 'completion', 'extension', 'alias',
  'run', 'workflow', 'cache', 'codespace', 'ssh-key', 'gpg-key', 'attestation', 'ruleset', 'org']);
const VERBOS_DE_LECTURA = new Set(['view', 'list', 'status', 'checks', 'diff', 'checkout', 'download', 'clone']);
// los grupos de `gh` cuyos verbos se conocen: sólo en ellos un verbo de la lista hace al comando de lectura
const GRUPOS_CON_VERBOS = new Set(['pr', 'issue', 'release', 'repo', 'gist', 'label', 'project', 'secret', 'variable']);
// lo que se nombra en `resumen`; un grupo o un verbo fuera de acá sale como «(otro)»: puede ser un alias con cualquier texto
const GRUPOS = new Set([...GRUPOS_DE_LECTURA, ...GRUPOS_CON_VERBOS, 'api']);
const VERBOS = new Set([...VERBOS_DE_LECTURA, 'create', 'edit', 'comment', 'review', 'merge', 'close', 'reopen', 'ready', 'upload', 'delete',
  'delete-asset', 'rename', 'sync', 'fork', 'set', 'lock', 'unlock', 'pin', 'unpin', 'transfer', 'develop', 'update-branch', 'archive', 'unarchive']);
const SIN_VERBO = new Set(['api', 'browse', 'status', 'help', 'version', 'completion']);
// la forma de un `gh` que publica, para reconocerlo cuando el programa llega por una variable o una sustitución
const VERBOS_QUE_PUBLICAN = new Set(['create', 'edit', 'comment', 'review', 'merge', 'close', 'upload', 'set', 'item-create', 'item-edit', 'item-add']);
const GRUPOS_QUE_PUBLICAN = new Set(['pr', 'issue', 'release', 'gist', 'label', 'repo', 'project', 'secret', 'variable']);

// ── qué opción lleva un valor, y de qué clase ────────────────────────────────────────────────────────────────────
// ARCHIVO: su valor es la ruta de un archivo que `gh` lee y publica. SELECTOR: elige algo que ya existe (una rama, un
// commit, un formato de salida): no publica texto. TEXTO: publica su valor. Lo que no está en ninguna se toma por un
// interruptor.
const PR_ISSUE = {
  archivo: ['--body-file', '-F', '--template', '-T', '--recover'],
  texto: ['--title', '-t', '--body', '-b', '--subject', '--comment', '--milestone', '--label', '--assignee', '--reviewer', '--project',
    '--add-label', '--remove-label', '--add-assignee', '--remove-assignee', '--add-reviewer', '--remove-reviewer', '--add-project', '--remove-project',
    '--reason', '--name', '--author-email', '-A'],   // el correo del autor del commit de merge se publica con el commit
  selector: ['--base', '-B', '--head', '-H', '--match-head-commit', '--json', '--jq', '-q', '--limit', '-L', '--state', '--search', '-S'],
};
const TABLAS = {
  pr: PR_ISSUE,
  issue: PR_ISSUE,
  release: {
    archivo: ['--notes-file', '-F'],
    texto: ['--title', '-t', '--notes', '-n', '--discussion-category', '--tag'],
    selector: ['--target', '--notes-start-tag', '--pattern', '--dir', '-D'],
  },
  api: {
    archivo: ['--input'],
    texto: [],
    selector: ['--method', '-X', '--header', '-H', '--jq', '-q', '--template', '-t', '--preview', '-p', '--hostname', '--cache'],
  },
  gist: { archivo: ['--add', '-a'], texto: ['--desc', '-d', '--filename', '-f'], selector: [] },
  repo: { archivo: [], texto: ['--description', '-d', '--homepage', '--add-topic', '--remove-topic', '--default-branch', '--visibility'], selector: [] },
  label: { archivo: [], texto: ['--description', '-d', '--color', '-c', '--name', '-n'], selector: [] },
};
const SIN_TABLA = { archivo: [], texto: [], selector: [] };
const REPO = ['--repo', '-R'];
// las opciones cortas cambian de sentido según el verbo: en `merge`, `review` y `create` éstas son interruptores
const CORTAS_INTERRUPTOR = { merge: ['-m', '-s', '-r', '-d'], review: ['-a', '-c', '-r'], create: ['-d', '-f', '-p', '-w', '-e'], comment: ['-e', '-w'] };
// y éstas llevan texto sólo con ese verbo (`-c` es `--comment` en `close`; en `review`, un interruptor)
const CORTAS_TEXTO = { pr: { close: ['-c'], merge: ['-t', '-b', '-A'], create: ['-a', '-l', '-m', '-p', '-r'], edit: ['-a', '-l', '-m', '-p', '-r'] },
  issue: { close: ['-c', '-r'], create: ['-a', '-l', '-m', '-p'], edit: ['-a', '-l', '-m', '-p'] } };
const INTERRUPTORES = new Set(['--merge', '--squash', '--rebase', '--auto', '--disable-auto', '--delete-branch', '--admin', '--draft', '--fill', '--fill-first',
  '--fill-verbose', '--approve', '--request-changes', '--delete-last', '--edit-last', '--yes', '--undo', '--dry-run', '--no-maintainer-edit',
  '--prerelease', '--latest', '--generate-notes', '--notes-from-tag', '--verify-tag', '--clobber', '--public', '--paginate', '--include', '--silent', '--verbose', '--create-if-none']);
const PIDE_EDITOR = ['--editor', '--web'];
const TOMA_DE_LOS_COMMITS = ['--fill', '--fill-first', '--fill-verbose'];
// las dos ramas de un pedido (`gh pr create --base … --head …`): selectores, pero el lector las devuelve
const RAMAS_DE_PEDIDO = { '--base': 'base', '-B': 'base', '--head': 'head', '-H': 'head' };
const CON_VALOR = new Set(['repo', 'archivo', 'texto', 'selector', 'campo', 'campo-crudo']);
const ARMADO = 'un texto que la terminal arma antes de correr (`$…`, `$(…)` o comillas invertidas)';

/** `OWNER/REPO`, `HOST/OWNER/REPO` o una URL → `owner/repo` en minúsculas; null si no tiene esa forma. */
function repoDe(valor) {
  let s = String(valor || '').trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]+@/, '');
  const partes = s.split(/[/:]/).filter(Boolean);
  if (partes.length < 2 || partes.length > 3) return null;
  const [owner, repo] = partes.slice(-2);
  const nombre = /^[A-Za-z0-9._-]+$/;
  return nombre.test(owner) && nombre.test(repo) ? `${owner}/${repo}`.toLowerCase() : null;
}

/** El repo de la ruta de `gh api`: `repos/OWNER/REPO/…`. Con `{owner}` o `:owner` decide la carpeta: null. */
function repoDeRuta(ruta) {
  // `gh api` acepta también la dirección completa (`https://api.github.com/repos/o/r/…`)
  const m = /^(?:https?:\/\/[^/]+)?\/?repos\/([^/{}:?]+)\/([^/{}:?]+)(?:[/?]|$)/i.exec(String(ruta || ''));
  return m ? repoDe(`${m[1]}/${m[2]}`) : null;
}

// ── el bloque `"$(cat <<'EOF' … EOF)"`: se saca ANTES de partir en fichas ──────────────────────────────────────────
// Adentro de las comillas dobles hay otro contexto de comillas (el de la sustitución), y el cuerpo de un pedido trae
// comillas: partido tal cual, la primera comilla del cuerpo cerraba la cadena. Cada bloque se cambia por una marca que
// no puede venir en el comando (lleva un número al azar) y después se le devuelve su texto.
const BLOQUE = /"\$\(\s*cat\s+<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2[ \t]*\r?\n([\s\S]*?)\r?\n([ \t]*)\3[ \t]*\r?\n?[ \t]*\)"/g;
// Los bloques de texto de PowerShell: `@'` … `'@` (literal) y `@"` … `"@` (con expansión).
const BLOQUE_PS = /@(['"])[ \t]*\r?\n([\s\S]*?)\r?\n\1@/g;
function sacarBloques(cmd, opts = {}) {
  const sello = crypto.randomBytes(8).toString('hex');
  const cuerpos = new Map();
  const guardar = (cuerpo) => { const marca = `ghprbloque${sello}n${cuerpos.size}`; cuerpos.set(marca, cuerpo); return `"${marca}"`; };
  let texto = String(cmd || '').replace(BLOQUE, (todo, guion, comilla, delimitador, cuerpo, sangria) => {
    // sin comillas en el delimitador la terminal expande el cuerpo: sólo se lee si no hay nada que expandir
    if (!comilla && /[$`\\]/.test(cuerpo)) return todo;
    // La terminal corta el bloque en el PRIMER renglón que es exactamente el delimitador. Si adentro de lo que se
    // tomó por cuerpo hay uno, el bloque de verdad terminó antes: lo leído no es lo que se publica. Y el cierre con
    // sangría sólo vale con `<<-` (y con tabuladores). En los dos casos el bloque no se da por leído: queda como una
    // sustitución, que el lector da por ilegible.
    if (cuerpo.split(/\r?\n/).some((l) => l === delimitador) || (sangria && !(guion && /^\t+$/.test(sangria)))) return todo;
    return guardar(cuerpo);
  });
  // En PowerShell, el bloque literal se lee; el que expande, sólo si no trae nada que expandir. Si no, queda una
  // sustitución en su lugar (ilegible). Sin esto, un apóstrofo suelto adentro del bloque cerraba «la cadena», el
  // renglón siguiente cortaba el comando, y el resto del cuerpo quedaba como otros comandos que nadie miraba.
  if (opts.powershell) {
    texto = texto.replace(BLOQUE_PS, (todo, comilla, cuerpo) => (comilla === '"' && /[$`]/.test(cuerpo) ? '"$(bloque de texto de PowerShell)"' : guardar(cuerpo)));
  }
  return { texto, cuerpos };
}

/**
 * Los segmentos del comando, cada uno con el operador que lo cortó, el que lo abrió y TODOS los que hubo entre el
 * segmento anterior y él (`antes`): `a |& b` y un `|` al final de un renglón llegan como dos operadores seguidos, y
 * quedarse sólo con el último perdía la tubería.
 */
function segmentosConCorte(cmd, opts = {}) {
  const out = [];
  let cur = [];
  let abre = null;
  let antes = [];
  for (const f of az.fichas(cmd, opts)) {
    if (f.op !== undefined) {
      if (cur.length) { out.push({ fichas: cur, corte: f.op, abre, antes }); cur = []; antes = []; }
      antes.push(f.op);
      abre = f.op;
      continue;
    }
    cur.push(f);
  }
  if (cur.length) out.push({ fichas: cur, corte: null, abre, antes });
  return out;
}

/** El cuerpo de cada bloque heredoc del texto. Sin su línea de cierre, todo lo que sigue es cuerpo (así lo corre la terminal). */
function cuerposDeHeredoc(texto) {
  const out = [];
  for (const m of texto.matchAll(/\d*<<-?[ \t]*(['"]?)\\?([A-Za-z_][A-Za-z0-9_.-]*)\1/g)) {
    const resto = texto.slice(m.index + m[0].length);
    const cierre = new RegExp(`\\r?\\n[ \\t]*${m[2].replace(/[.\\-]/g, '\\$&')}[ \\t]*(?=\\r?\\n|$)`).exec(resto);
    out.push(cierre ? resto.slice(0, cierre.index) : resto);
  }
  return out;
}

const esOpcion = (f) => f.esBandera && /^-./.test(f.texto);

/** Dónde empieza el comando de un segmento: después de las asignaciones (`VAR=valor`) y de `env`, `command`, `sudo`… */
function posicionDeComando(seg) {
  let i = 0;
  const asignaciones = [];
  for (;;) {
    while (i < seg.length && seg[i].esBandera && ASIGNACION.test(seg[i].texto)) { asignaciones.push(seg[i]); i += 1; }
    if (i < seg.length && seg[i].esBandera && PREFIJOS.has(seg[i].texto)) { i += 1; continue; }
    break;
  }
  return { i, asignaciones };
}

/** Aplica `GH_REPO=…` / `GH_HOST=…` de una lista de fichas a un estado `{ repo, repoDesconocido }`. */
function aplicarEntorno(estado, fichas) {
  for (const f of fichas) {
    const m = ASIGNACION.exec(f.texto);
    if (!m) continue;
    if (m[1] === 'GH_HOST') { estado.repoDesconocido = true; continue; }   // otro servidor: no se sabe qué repo es
    if (m[1] !== 'GH_REPO') continue;
    const r = f.expande ? null : repoDe(m[2]);
    estado.propio = true;
    if (r) { estado.repo = r; estado.repoDesconocido = false; } else { estado.repo = null; estado.repoDesconocido = true; }
  }
}

/** Lee un `gh` ya ubicado. `lugar`: el estado de la línea hasta acá (cds, repo puesto antes); `propias`: sus asignaciones. */
function leerGh(propias, resto, corte, cuerpos, lugar) {
  const ilegible = [];
  const textos = [];
  const archivos = [];
  const marcar = (motivo) => { if (!ilegible.includes(motivo)) ilegible.push(motivo); };
  // El cuerpo de un bloque, donde esté su marca: la ficha entera, o PEGADA a otra cosa (`body=<bloque>` en un campo de
  // `gh api`). Devolviéndolo sólo cuando la ficha entera era la marca, lo pegado se revisaba como la marca —un texto al
  // azar— y el cuerpo de verdad salía sin mirar.
  const leer = (texto) => {
    let t = String(texto);
    for (const [marca, cuerpo] of cuerpos) if (t.includes(marca)) t = t.split(marca).join(cuerpo);
    return t;
  };

  // La opción del repo puede venir ANTES del grupo (`gh -R a/b pr create`): se aparta, y se aplica más abajo.
  const repoAdelante = [];
  let ini = 0;
  while (ini < resto.length && esOpcion(resto[ini]) && !resto[ini].expande) {
    if (REPO.includes(resto[ini].texto) && resto[ini + 1]) { repoAdelante.push(resto[ini + 1]); ini += 2; continue; }
    const pegado = /^(--repo|-R)=([\s\S]*)$/.exec(resto[ini].texto);
    if (!pegado) break;
    repoAdelante.push({ texto: pegado[2], expande: resto[ini].expande });
    ini += 1;
  }
  resto = resto.slice(ini);

  // grupo y verbo: los que vienen PEGADOS a `gh` (`gh pr create`). Buscar «el primer argumento que no es una opción»
  // dejaba elegir el verbo desde un valor: `gh pr create --title view …` se leía como `gh pr view`, de lectura. Si en
  // el lugar del grupo o del verbo hay una opción, no hay grupo o no hay verbo: lo que no se sabe leer no es de lectura.
  const primero = resto[0] && !esOpcion(resto[0]) ? resto[0] : null;
  const grupo = primero && !primero.expande ? primero.texto : null;
  const llevaVerbo = Boolean(grupo) && !SIN_VERBO.has(grupo);
  const segundo = llevaVerbo && resto[1] && !esOpcion(resto[1]) && !resto[1].expande ? resto[1] : null;
  const verbo = segundo ? segundo.texto : null;
  const cuerpo = resto.slice(!grupo ? 0 : (segundo ? 2 : 1));

  // a qué repo va: lo puesto antes en la línea, después lo propio del comando, después --repo/-R
  // `propio`: lo nombró este comando (su opción, su variable o la ruta de `gh api`), no uno anterior de la línea
  const destino = { repo: lugar.repo, repoDesconocido: lugar.repoDesconocido, propio: false };
  aplicarEntorno(destino, propias);

  const tabla = TABLAS[grupo] || SIN_TABLA;
  const cortasTexto = (CORTAS_TEXTO[grupo] || {})[verbo] || [];
  const cortasInterruptor = CORTAS_INTERRUPTOR[verbo] || [];
  const clase = (nombre) => {
    if (REPO.includes(nombre)) return 'repo';
    // en `gh pr review`, `--comment` es un interruptor (la clase de revisión); en `close` lleva el texto del comentario
    if (grupo === 'pr' && verbo === 'review' && nombre === '--comment') return 'interruptor';
    if (cortasTexto.includes(nombre)) return 'texto';
    if (nombre.length === 2 && cortasInterruptor.includes(nombre) && grupo !== 'api' && grupo !== 'gist' && grupo !== 'label' && grupo !== 'repo') return 'interruptor';
    if (grupo === 'api' && (nombre === '-f' || nombre === '--raw-field')) return 'campo-crudo';
    if (grupo === 'api' && (nombre === '-F' || nombre === '--field')) return 'campo';
    if (tabla.archivo.includes(nombre)) return 'archivo';
    if (tabla.texto.includes(nombre)) return 'texto';
    if (tabla.selector.includes(nombre)) return 'selector';
    return INTERRUPTORES.has(nombre) || PIDE_EDITOR.includes(nombre) ? 'interruptor' : 'desconocida';
  };

  const valores = new Map();   // nombre de opción → cuántas veces vino
  const vino = (nombre) => valores.set(nombre, (valores.get(nombre) || 0) + 1);
  const posicionales = [];
  let conocido = true;         // ¿todo lo que hubo desde el verbo es conocido? (para la ayuda y para el primer argumento)
  let ayuda = false;
  let metodo = null;           // el de `gh api`: null = no lo dice
  let consulta;                // la de GraphQL: un texto, o null si no se puede leer
  const ramas = { base: null, head: null, baseDesconocida: false, headDesconocida: false };   // las de `gh pr create`
  let enSeco = false;          // `--dry-run` (y no `--dry-run=false`)
  // el comando sigue en algo que arma la terminal (una sustitución o un paréntesis SIN comillas): lo de después no se leyó
  const cortado = corte === '$(' || corte === '`' || corte === '(';
  const usar = (nombre, tipo, valor, expande) => {
    vino(nombre);
    if (tipo === 'repo') {
      const r = expande ? null : repoDe(leer(valor));
      destino.propio = true;
      if (r) { destino.repo = r; destino.repoDesconocido = false; } else { destino.repo = null; destino.repoDesconocido = true; }
      return;
    }
    if (tipo === 'selector') {
      if (nombre === '-X' || nombre === '--method') metodo = expande ? 'DESCONOCIDO' : String(valor).toUpperCase();
      // la rama base y la de origen de un pedido: no son texto que se publica, pero quien anota una entrega necesita
      // saber hacia dónde va. Repetida, vale la última (así lee `gh`); armada por la terminal, «no se sabe».
      const rama = grupo === 'pr' ? RAMAS_DE_PEDIDO[nombre] : null;
      if (rama) { ramas[rama] = expande ? null : leer(valor); ramas[`${rama}Desconocida`] = Boolean(expande); }
      return;
    }
    if (tipo === 'archivo') {
      if (valor === '-') return marcar('lee el texto de la entrada estándar');
      if (expande) return marcar('la ruta del archivo la arma la terminal');
      archivos.push({ de: nombre, ruta: valor });
      return;
    }
    // un campo de `gh api` es `clave=dato`; la clave se ve aunque el dato lo arme la terminal (`query="$Q"`)
    const esCampo = tipo === 'campo' || tipo === 'campo-crudo';
    const partido = esCampo ? /^([^=\s]+)=([\s\S]*)$/.exec(String(valor)) : null;
    const clave = partido ? partido[1] : null;
    if (expande) { if (clave === 'query') consulta = null; return marcar(ARMADO); }
    const texto = leer(valor);
    const dato = clave === null ? texto : texto.slice(clave.length + 1);
    if (tipo === 'campo' && dato === '@-') { if (clave === 'query') consulta = null; return marcar('lee el texto de la entrada estándar'); }
    if (tipo === 'campo' && dato.startsWith('@')) { if (clave === 'query') consulta = null; archivos.push({ de: nombre, ruta: dato.slice(1) }); return; }
    if (clave === 'query') consulta = dato;
    textos.push({ de: nombre, texto });
    // La API de contenidos pide el archivo en base64 (`-f content=…`): revisado tal cual es un texto sin sentido, y lo
    // que se publica es lo que dice adentro. Se mira también descifrado.
    if (esCampo && /^[A-Za-z0-9+/\s]{24,}={0,2}$/.test(dato)) {
      const claro = Buffer.from(dato, 'base64').toString('utf8');
      const esTexto = Boolean(claro) && !claro.includes(String.fromCharCode(0xFFFD));   // el carácter con que Node marca lo que no es UTF-8
      if (esTexto) textos.push({ de: nombre, texto: claro });
      // el contenido de un archivo que no es texto (una imagen): no se puede leer, igual que un binario que se empuja
      else if (clave === 'content') marcar('un contenido en base64 que no es texto: no se puede leer');
    }
  };
  for (const r of repoAdelante) usar('--repo', 'repo', r.texto, r.expande);

  let soloArgumentos = false;   // después de `--`, todo es argumento
  for (let k = 0; k < cuerpo.length; k += 1) {
    const f = cuerpo[k];
    // Una opción CONOCIDA escrita entre comillas (`gh api "-X" POST …`) es la misma opción para `gh`: las comillas las
    // saca la terminal. Tomada por un argumento, ese `gh api` quedaba «de lectura». (Una desconocida entre comillas se
    // sigue mirando como texto, y un pedido de ayuda entre comillas no cuenta como ayuda: de más, nunca de menos.)
    const conocidaEntreComillas = !f.esBandera && !f.expande && /^-[A-Za-z-]/.test(f.texto) && f.texto !== '--' && !/^--?h(elp)?$/.test(f.texto)
      && clase(f.texto.startsWith('--') ? f.texto.split('=')[0] : f.texto.slice(0, 2)) !== 'desconocida';
    if (soloArgumentos || !(esOpcion(f) || conocidaEntreComillas)) { posicionales.push({ f, despuesDeConocido: conocido }); continue; }
    if (f.texto === '--') { soloArgumentos = true; continue; }
    // lo que sigue, si esta opción lleva valor: SIEMPRE se lo lleva, empiece como empiece
    const siguiente = () => { const sig = cuerpo[k + 1]; if (sig) k += 1; return sig; };
    const tomar = (nombre, tipo, pegado) => {
      if (pegado !== undefined) return usar(nombre, tipo, pegado, f.expande);
      const sig = siguiente();
      if (!sig) {
        // sin valor detrás: `gh` daría error… salvo que el comando se haya cortado en una sustitución sin comillas
        // (`--base $(…)`): ahí el valor existe y lo arma la terminal. Una rama así «no se sabe», no «no vino».
        const rama = grupo === 'pr' && cortado ? RAMAS_DE_PEDIDO[nombre] : null;
        if (rama) { ramas[rama] = null; ramas[`${rama}Desconocida`] = true; }
        return vino(nombre);
      }
      return usar(nombre, tipo, sig.texto, sig.expande);
    };
    const esAyuda = (nombre) => nombre === '--help' || (nombre === '-h' && grupo !== 'repo' && grupo !== 'api');
    if (f.texto.startsWith('--')) {
      const igual = f.texto.indexOf('=');
      const nombre = igual >= 0 ? f.texto.slice(0, igual) : f.texto;
      const pegado = igual >= 0 ? f.texto.slice(igual + 1) : undefined;
      // `--help=false` NO es un pedido de ayuda: `gh` corre el comando
      if (esAyuda(nombre) && conocido && (pegado === undefined || /^(true|1)$/i.test(pegado))) { ayuda = true; continue; }
      const tipo = clase(nombre);
      if (CON_VALOR.has(tipo)) { tomar(nombre, tipo, pegado); continue; }
      vino(nombre);
      // `--dry-run=false` SÍ crea el pedido (vale la última, como en `gh`)
      if (nombre === '--dry-run') enSeco = !(pegado !== undefined && /^(false|0)$/i.test(pegado));
      if (tipo === 'desconocida') {
        // no se sabe si lleva valor: se toma por interruptor, y lo que siga cuenta como argumento (se mira como texto)
        conocido = false;
        if (pegado !== undefined) { if (f.expande) marcar(ARMADO); else textos.push({ de: nombre, texto: leer(pegado) }); }
      }
      continue;
    }
    // cortas: `-t valor`, `-tvalor`, `-t=valor`, y varios interruptores juntos (`-dp`)
    for (let c = 1; c < f.texto.length; c += 1) {
      const nombre = `-${f.texto[c]}`;
      const cola = f.texto.slice(c + 1);
      if (esAyuda(nombre) && conocido) { ayuda = true; continue; }
      const tipo = clase(nombre);
      if (CON_VALOR.has(tipo)) { tomar(nombre, tipo, cola ? cola.replace(/^=/, '') : undefined); break; }
      vino(nombre);
      if (tipo === 'desconocida') {
        conocido = false;
        if (cola) { if (f.expande) marcar(ARMADO); else textos.push({ de: nombre, texto: cola }); }
        break;
      }
    }
  }

  // los argumentos: qué son depende del grupo
  const esPrOIssue = grupo === 'pr' || grupo === 'issue';
  let esGraphql = false;
  let rutaApi = null;
  const nombrar = (r) => { destino.repo = r; destino.repoDesconocido = false; destino.propio = true; };
  posicionales.forEach(({ f, despuesDeConocido }, n) => {
    const texto = leer(f.texto);
    if (grupo === 'api' && n === 0) {   // la ruta: a dónde apunta (y, si el comando escribe, también es texto: más abajo)
      if (f.expande) { destino.repo = null; destino.repoDesconocido = true; destino.propio = true; return; }
      esGraphql = /^(https?:\/\/[^/]+)?\/*graphql$/i.test(texto);
      rutaApi = texto;
      const r = repoDeRuta(texto);
      if (r) nombrar(r);
      return;
    }
    // 🔴 El repo también se nombra por un ARGUMENTO, y entonces `gh` ignora la carpeta: la dirección de un pedido o de
    // un issue (`gh pr comment https://github.com/o/r/pull/5 …`) y el `OWNER/REPO` de `gh repo edit|delete|rename|…`.
    // Sin esto, desde una carpeta que no es un clon del arnés el comando era «de otro repo» y salía sin mirar.
    if (n === 0 && !f.expande && esPrOIssue && verbo !== 'create') {
      const m = /^https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/(?:pull|issues)\/\d+/i.exec(texto);
      const r = m ? repoDe(`${m[1]}/${m[2]}`) : null;
      if (r) nombrar(r);
    }
    if (n === 0 && !f.expande && grupo === 'repo' && verbo && verbo !== 'create' && verbo !== 'list') {
      const r = /^[^/\s]+\/[^/\s]+$/.test(texto) || /^https?:\/\//i.test(texto) ? repoDe(texto) : null;
      if (r) nombrar(r);
    }
    // `gh gist edit <id> <archivo-local>` reemplaza un archivo del gist con el contenido de ése: se lee el archivo
    if (grupo === 'gist' && verbo === 'edit' && n > 0) {
      if (f.expande) return marcar('la ruta de un archivo la arma la terminal');
      archivos.push({ de: 'archivo', ruta: texto });
      return;
    }
    if (grupo === 'release' && (verbo === 'create' || verbo === 'upload') && n > 0) {
      if (f.expande) return marcar('la ruta de un adjunto la arma la terminal');
      const corte2 = texto.indexOf('#');
      archivos.push({ de: 'adjunto', ruta: corte2 >= 0 ? texto.slice(0, corte2) : texto });
      if (corte2 >= 0) textos.push({ de: 'adjunto', texto: texto.slice(corte2 + 1) });
      return;
    }
    if (grupo === 'gist' && verbo === 'create') {
      if (texto === '-') return marcar('lee el texto de la entrada estándar');
      if (f.expande) return marcar('la ruta de un archivo la arma la terminal');
      archivos.push({ de: 'archivo', ruta: texto });
      return;
    }
    if (f.expande) {
      // el número o la rama de un pedido en una variable elige cuál, no publica texto: sólo el primero, y sólo si antes
      // no hubo una opción que este lector no conoce (su valor quedaría acá, y ése sí es texto)
      if (esPrOIssue && verbo !== 'create' && n === 0 && despuesDeConocido) return;
      return marcar(ARMADO);
    }
    textos.push({ de: 'argumento', texto });
  });

  if (corte === '$(' || corte === '`') marcar('el comando sigue en una sustitución de la terminal (`$(…)` o comillas invertidas)');
  // un paréntesis suelto corta el comando: en PowerShell es un valor que calcula la terminal (`--body (Get-Content f)`)
  if (corte === '(') marcar('el comando sigue en un paréntesis: ese valor lo calcula la terminal');

  // ¿es de lectura? `gh` a secas imprime la ayuda; con una opción en el lugar del grupo, sólo si pide la versión o la ayuda
  let lectura = ayuda || resto.length === 0 || GRUPOS_DE_LECTURA.has(grupo)
    || (!grupo && resto.some((f) => esOpcion(f) && (f.texto === '--version' || f.texto === '--help')));
  // dos que la lista general daría por lectura y ESCRIBEN: `gh workflow run` manda sus campos al repo, y `gh label
  // clone` copia al repo las etiquetas de otro (un texto que no está en el comando)
  if (grupo === 'workflow' && verbo === 'run' && !ayuda) lectura = false;
  if (!lectura && grupo === 'api') {
    if (esGraphql) {
      // una consulta no publica nada; una mutación sí, y nombra su destino por un identificador: no se sabe a qué repo
      // va. Con `--input`, lo que se manda es ESE archivo (la consulta de la línea va a la dirección): no es lectura
      lectura = typeof consulta === 'string' && !/\bmutation\b/i.test(consulta) && !valores.has('--input');
      if (!lectura) { destino.repo = null; destino.repoDesconocido = true; }
    } else {
      const conCuerpo = ['-f', '--raw-field', '-F', '--field', '--input'].some((n) => valores.has(n));
      lectura = metodo ? metodo === 'GET' : !conCuerpo;
    }
    // si escribe, su ruta también se publica (el nombre del archivo en la API de contenidos)
    if (!lectura && rutaApi) textos.push({ de: 'ruta', texto: rutaApi });
  } else if (!lectura && grupo === 'label' && verbo === 'clone') {
    marcar('copia las etiquetas de otro repo: ese texto no está en el comando');
  } else if (!lectura && verbo && VERBOS_DE_LECTURA.has(verbo) && GRUPOS_CON_VERBOS.has(grupo)) lectura = true;   // un alias con verbo de lectura no

  // lo que `gh` pediría por el editor, por la web o por una pregunta: ahí no hay texto que leer
  if (!lectura) {
    const tiene = (...nombres) => nombres.some((n) => valores.has(n));
    if (PIDE_EDITOR.some((n) => valores.has(n)) || ((esPrOIssue || grupo === 'gist') && (valores.has('-w') || (valores.has('-e') && verbo !== 'edit')))) {
      marcar('abre el editor o la web: el texto se escribe donde este freno no lo ve');
    }
    const cuerpoDado = tiene('--body', '-b', '--body-file', '-F');
    if (esPrOIssue && verbo === 'create') {
      const delCommit = grupo === 'pr' && (TOMA_DE_LOS_COMMITS.some((n) => valores.has(n)) || valores.has('-f'));   // `-f` es `--fill`
      if (!delCommit && !(tiene('--title', '-t') && cuerpoDado)) marcar('sin título o sin cuerpo en el comando: `gh` los pide por el editor');
    }
    if (esPrOIssue && verbo === 'comment' && !cuerpoDado && !tiene('--delete-last')) marcar('sin cuerpo en el comando: `gh` lo pide por el editor');
    if (grupo === 'pr' && verbo === 'review' && tiene('--comment', '-c', '--request-changes', '-r') && !cuerpoDado) marcar('sin cuerpo en el comando: `gh` lo pide por el editor');
    if (grupo === 'release' && verbo === 'create' && !tiene('--notes', '-n', '--notes-file', '-F', '--generate-notes', '--notes-from-tag')) {
      marcar('sin notas en el comando: `gh` las pide por el editor');
    }
  }

  const g = grupo ? (GRUPOS.has(grupo) ? grupo : '(otro)') : '';
  const v = verbo ? (VERBOS.has(verbo) ? verbo : '(otro)') : '';
  return { grupo, verbo, lectura, repo: destino.repo, repoAmbiente: Boolean(destino.repo) && !destino.propio, repoDesconocido: destino.repoDesconocido,
    cds: [...lugar.cds], cdIncierto: lugar.cdIncierto, cwdDesconocido: lugar.cwdDesconocido,
    textos, archivos, ilegible, otros: lugar.otros || 0, resumen: ['gh', g, v].filter(Boolean).join(' '),
    base: ramas.base, head: ramas.head, baseDesconocida: ramas.baseDesconocida, headDesconocida: ramas.headDesconocida,
    simulacro: grupo === 'pr' && enSeco, cortado, verboTrasOpciones: verbo || verboTrasElRepo(grupo, llevaVerbo, resto),
    porOtroPrograma: false, loLanzaOtro: false };
}

/**
 * El verbo cuando entre el grupo y él viene la opción del repo (`gh pr -R dueño/repo create …`, forma que `gh` acepta).
 * `verbo` sigue siendo sólo el que viene PEGADO al grupo —es el que decide qué es de lectura, y ahí lo que no se sabe
 * leer no es de lectura—; esto es para quien necesita saber si el comando crea un pedido. `null` si no hay tal cosa.
 */
function verboTrasElRepo(grupo, llevaVerbo, resto) {
  if (!grupo || !llevaVerbo) return null;
  let k = 1;
  while (k < resto.length && esOpcion(resto[k]) && !resto[k].expande) {
    if (REPO.includes(resto[k].texto) && resto[k + 1]) { k += 2; continue; }
    if (/^(--repo|-R)=/.test(resto[k].texto)) { k += 1; continue; }
    return null;   // otra opción: lo que sigue puede ser su valor
  }
  const f = resto[k];
  return k > 1 && f && !esOpcion(f) && !f.expande ? f.texto : null;
}

/** Un `gh` que no se puede leer: adentro de otro intérprete, o con el programa en una variable. */
function oculto(lugar, motivo) {
  return { grupo: null, verbo: null, lectura: false, repo: null, repoAmbiente: false, repoDesconocido: true,
    cds: [...lugar.cds], cdIncierto: lugar.cdIncierto, cwdDesconocido: lugar.cwdDesconocido,
    textos: [], archivos: [], ilegible: [motivo], otros: lugar.otros || 0, resumen: 'gh (no se puede leer)',
    base: null, head: null, baseDesconocida: false, headDesconocida: false, simulacro: false, cortado: false,
    verboTrasOpciones: null, porOtroPrograma: false, loLanzaOtro: false };
}

/** ¿Estas fichas tienen la forma de un `gh` que publica con grupo y verbo (`pr create …`, `issue comment …`)? */
function formaDeGhConVerbo(fichas) {
  const [a, b] = sinOpcionesAdelante(fichas);
  if (!a || a.expande || esOpcion(a)) return false;
  return GRUPOS_QUE_PUBLICAN.has(a.texto) && Boolean(b) && !b.expande && VERBOS_QUE_PUBLICAN.has(b.texto);
}
/** Lo mismo, contando también `api …` (sin verbo: sólo vale cuando el programa llega por una variable). */
function formaDeGhQuePublica(fichas) {
  const resto = sinOpcionesAdelante(fichas);
  const [a] = resto;
  if (a && !a.expande && !esOpcion(a) && a.texto === 'api') return resto.length > 1;
  return formaDeGhConVerbo(fichas);
}
// los programas que corren el programa que se les nombra (además de los prefijos que `posicionDeComando` ya saltea)
const CORRE_A_OTRO = new Set(['xargs', 'timeout', 'nice', 'stdbuf', 'caffeinate', 'watch', 'parallel', 'doas', 'su', 'then', 'do', 'else', '!']);
/** Las redirecciones no son argumentos del programa: `>/dev/null`, `2>&1`, `&> salida.txt`, `> archivo`, `< archivo`. */
function sinRedirecciones(fichas) {
  const out = [];
  for (let k = 0; k < fichas.length; k += 1) {
    const f = fichas[k];
    const m = f.esBandera && !f.expande ? /^(\d*|&)(>>?|<)(?!<)(.*)$/.exec(f.texto) : null;
    if (!m) { out.push(f); continue; }
    if (m[3] === '') k += 1;   // el destino viene en la ficha que sigue
  }
  return out;
}
/** Lo que hay adentro de cada `$(…)` (con paréntesis balanceados) y de cada par de comillas invertidas de un texto. */
/**
 * Las sustituciones que van ENTRE COMILLAS DOBLES (`"… $(comando) …"`, `"… \`comando\` …"`): se sacan del texto ANTES de
 * partirlo —adentro de esas comillas hay otro contexto de comillas, el del comando de adentro, y partido tal cual la
 * primera comilla de adentro cerraba la cadena— y cada una se devuelve para leerla como una línea más. En su lugar
 * queda una sustitución sin nada adentro, que el lector sigue viendo como «texto que arma la terminal».
 * (Fuera de comillas no hace falta: ahí `$(` corta el comando y lo de adentro ya se lee.)
 */
function sacarSustituciones(texto) {
  const s = String(texto);
  const adentro = [];
  let out = '';
  let q = null;
  const pendientes = [];   // los bloques heredoc abiertos en el renglón en curso
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (q === "'") { out += c; if (c === "'") q = null; continue; }
    if (c === '\\' && i + 1 < s.length) { out += c + s[i + 1]; i += 1; continue; }
    if (!q) {
      // 🔴 Un comentario y el cuerpo de un bloque heredoc NO son código: un apóstrofo ahí («don't») no abre ninguna
      // cadena. Recorridos como código, dejaban este recorrido «adentro de comillas» y la sustitución con el `gh` que
      // venía después no se sacaba — y como para el lector de fichas (que sí los saltea) era una ficha más, salía sin mirar.
      if (c === '#' && (i === 0 || /[\s;&|()]/.test(s[i - 1]))) {
        const fin = s.indexOf('\n', i);
        const hasta = fin < 0 ? s.length : fin;
        out += s.slice(i, hasta);
        i = hasta - 1;
        continue;
      }
      const h = c === '<' && s[i - 1] !== '<' ? /^<<(?!<)-?[ \t]*(['"]?)(\\?)([A-Za-z_][A-Za-z0-9_.-]*)\1/.exec(s.slice(i)) : null;
      const renglon = h ? s.slice(s.lastIndexOf('\n', i) + 1, i) : '';
      if (h && renglon.split('((').length <= renglon.split('))').length) {   // (un `<<` adentro de `$((…))` es una cuenta)
        pendientes.push({ delim: h[3], expande: !h[1] && !h[2] });
        out += h[0];
        i += h[0].length - 1;
        continue;
      }
      if (c === '\n' && pendientes.length) {
        out += c;
        let j = i + 1;
        for (const p of pendientes.splice(0)) {
          const resto = s.slice(j);
          const cierre = new RegExp(`(^|\\n)[ \\t]*${p.delim.replace(/[.\\-]/g, '\\$&')}[ \\t]*(?=\\r?\\n|$)`).exec(resto);
          const cuerpo = cierre ? resto.slice(0, cierre.index) : resto;
          // con el delimitador sin comillas la terminal expande el cuerpo: una sustitución ahí adentro CORRE
          if (p.expande) for (const x of deUnCuerpo(cuerpo)) adentro.push(x);
          const hasta = cierre ? cierre.index + cierre[0].length : resto.length;
          out += resto.slice(0, hasta);
          j += hasta;
        }
        i = j - 1;
        continue;
      }
      if (c === "'") { q = c; out += c; continue; }
    }
    if (c === '"') { q = q ? null : '"'; out += c; continue; }
    if (q === '"' && c === '$' && s[i + 1] === '(' && s[i + 2] !== '(') {
      const fin = cierreDe(s, i + 2);
      if (fin < 0) { out += c; continue; }
      adentro.push(s.slice(i + 2, fin));
      out += '$(sustitucion)';
      i = fin;
      continue;
    }
    if (q === '"' && c === '`') {
      const fin = s.indexOf('`', i + 1);
      if (fin > 0) { adentro.push(s.slice(i + 1, fin)); out += '$(sustitucion)'; i = fin; continue; }
    }
    out += c;
  }
  return { texto: out, adentro };
}
/** Las sustituciones del cuerpo de un bloque que la terminal expande (ahí las comillas no cuentan). */
function deUnCuerpo(cuerpo) {
  const out = [];
  for (let i = 0; i < cuerpo.length; i += 1) {
    if (cuerpo[i] === '\\') { i += 1; continue; }
    if (cuerpo[i] === '$' && cuerpo[i + 1] === '(' && cuerpo[i + 2] !== '(') {
      const fin = cierreDe(cuerpo, i + 2);
      if (fin < 0) continue;
      out.push(cuerpo.slice(i + 2, fin));
      i = fin;
    } else if (cuerpo[i] === '`') {
      const fin = cuerpo.indexOf('`', i + 1);
      if (fin > 0) { out.push(cuerpo.slice(i + 1, fin)); i = fin; }
    }
  }
  return out;
}
/** El índice del `)` que cierra el `$(` abierto antes de `desde` (mirando comillas y paréntesis de adentro), o -1. */
function cierreDe(s, desde) {
  let hondo = 1;
  let q = null;
  for (let j = desde; j < s.length; j += 1) {
    const c = s[j];
    if (q) { if (c === '\\' && q === '"') { j += 1; continue; } if (c === q) q = null; continue; }
    if (c === '\\') { j += 1; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '(') hondo += 1;
    else if (c === ')') { hondo -= 1; if (hondo === 0) return j; }
  }
  return -1;
}
/** `gh` acepta opciones ANTES del grupo (`gh -R a/b pr create`): se saltean, con su valor si es la del repo. */
function sinOpcionesAdelante(fichas) {
  let k = 0;
  while (k < fichas.length && esOpcion(fichas[k])) k += REPO.includes(fichas[k].texto) ? 2 : 1;
  return fichas.slice(k);
}

/**
 * Cada `gh` del comando, en orden, cada uno con SUS opciones:
 *   { grupo, verbo, lectura, repo, repoAmbiente, repoDesconocido, cds, cdIncierto, cwdDesconocido,
 *     textos: [{ de, texto }], archivos: [{ de, ruta }], ilegible: [motivo], otros, resumen }
 * `cds`: los `cd` literales que la línea hizo antes (en orden); `otros`: cuántos comandos ANTERIORES de la línea (los
 * de después —`… | tail -3`, `&& echo listo`— corren cuando el `gh` ya leyó su archivo) no son un `gh`,
 * un `cd` ni una asignación (pueden escribir el archivo que el `gh` va a leer).
 */
function comandosGh(cmd, nivel = 0, opts = {}) {
  const bloques0 = sacarBloques(cmd, opts);
  const { cuerpos } = bloques0;
  // 🔴 Una sustitución entre comillas dobles es un comando que CORRE (`URL="$(gh pr create …)"` es como un agente guarda
  // la dirección del pedido), y adentro de las comillas el lector no parte la ficha: quedaba como texto de otro programa
  // y salía sin mirar. Se sacan antes de partir, y lo de adentro se lee como una línea más (al final de esta función).
  // (hasta tres niveles: `"$(basename "$(gh pr create …)")"` tiene una adentro de otra)
  const sueltas0 = nivel <= 2 ? sacarSustituciones(bloques0.texto) : { texto: bloques0.texto, adentro: [] };
  const texto = sueltas0.texto;
  const out = [];
  const lugar = { cds: [], cdIncierto: false, cwdDesconocido: false, repo: null, repoDesconocido: false, otros: 0 };
  const segmentos = segmentosConCorte(texto, opts);
  // ¿La línea agrupa comandos (un subshell, unas llaves, un `if`, un bucle)? Entonces el efecto de un `cd` o de un
  // `export` puede no llegar al `gh` que sigue, o llegar sólo a veces: este lector no sigue esa estructura, así que
  // con un agrupador en la línea NINGÚN `cd` ni `export` se da por aplicado — lo que hubiera pasa a «no se sabe».
  const agrupa = segmentos.some(({ fichas, corte, abre }) => corte === '(' || corte === ')' || abre === '(' || abre === ')'
    || fichas.some((f) => f.esBandera && !f.expande && AGRUPADORES.has(f.texto)));
  // ¿La línea nombra a `gh` en una ficha que NO es el programa de un comando (`alias g=gh`, `Set-Alias g gh`, el
  // cuerpo de una función)? Entonces otro nombre de la línea puede ser `gh`. Y si lo nombra junto a un grupo
  // (`alias pub='gh pr'`), ese otro nombre puede correr con el verbo solo (`pub create …`).
  const sueltas = segmentos.flatMap(({ fichas }) => {
    const p = posicionDeComando(fichas).i;
    return fichas.filter((f, k) => !f.expande && !(k === p && BINARIO.test(f.texto)));
  });
  const nombraGh = sueltas.some((f) => NOMBRA_A_GH.test(f.texto));
  const nombraGhConGrupo = sueltas.some((f) => DENTRO_DE_CADENA.test(f.texto));
  // …y cuáles son esos otros nombres: los que la línea DEFINE como alias o como función. Sin esto, la regla tomaba por
  // «un alias de gh» a cualquier programa con un verbo parecido (`git merge -m "… gh pr …"` quedaba frenado).
  const definidos = new Set();
  for (const { fichas, corte } of segmentos) {
    const p = posicionDeComando(fichas).i;
    const c0 = fichas[p];
    if (!c0 || c0.expande) continue;
    if (/^alias$/i.test(c0.texto)) { for (const f of fichas.slice(p + 1)) { const m = /^([A-Za-z_][A-Za-z0-9_-]*)=/.exec(f.texto); if (m) definidos.add(m[1]); } }
    else if (/^(set-alias|new-alias|sal|nal)$/i.test(c0.texto)) { const a = fichas.slice(p + 1).find((f) => !esOpcion(f)); if (a) definidos.add(a.texto); }
    else if (c0.texto === 'function' && fichas[p + 1]) definidos.add(fichas[p + 1].texto);
    else if (corte === '(' && fichas.length === p + 1) definidos.add(c0.texto);   // `g() { … }`: el `(` corta después del nombre
  }
  const noSeSabeDonde = () => { lugar.cwdDesconocido = true; };
  const noSeSabeElRepo = () => { lugar.repo = null; lugar.repoDesconocido = true; };
  // El texto de una ficha como lo va a ver quien lo ejecute: con el cuerpo de su bloque `"$(cat <<'EOF' …)"` de vuelta
  // en su lugar (se había cambiado por una marca) y sin comillas ni barras (`gh "pr" create` y `g''h pr create`
  // adentro de un texto son el mismo comando).
  const conBloque = (f) => {
    let t = String(f.texto);
    for (const [marca, cuerpo] of cuerpos) if (t.includes(marca)) t = t.split(marca).join(cuerpo);
    return t;
  };
  const plano = (f) => conBloque(f).replace(/["'\\]/g, '');
  // el cuerpo de un bloque heredoc no llega como ficha: se busca en el texto
  const bloques = cuerposDeHeredoc(texto);
  // ¿Este texto, corrido como comando, publica? Se LEE como una línea más (un nivel): `bash -c "gh pr view 5"` es de
  // lectura y no se frena. Si tiene la forma y no se deja leer como comando, cuenta como que sí.
  // 🔴 La puerta es que el texto NOMBRE a `gh` como palabra, no que traiga `gh <grupo>` pegado: `gh` acepta opciones
  // antes del grupo (`gh -R a/b pr create …`), y con la forma pegada como puerta ese texto ni se leía. Leído como una
  // línea más valen las mismas reglas que afuera: una variable, un alias o un `cd` adentro del texto.
  const publicaAdentro = (t) => {
    const liso = String(t).replace(/["'\\]/g, '');
    if (!PARECE.test(liso) && !PARECE_OCULTO.test(liso)) return false;
    const conForma = DENTRO_DE_CADENA.test(` ${liso}`);
    if (nivel > 0) return conForma;   // un texto adentro de otro texto: no se sigue leyendo, cuenta por su forma
    const adentro = comandosGh(t, nivel + 1, opts);
    return adentro.length ? adentro.some((c) => !c.lectura) : conForma;
  };
  // Una variable o un alias cuyo VALOR es un `gh` que publica (`CMD="gh pr create …"`, `alias x='gh -R a/b pr create'`):
  // está para correrlo. El valor se lee como un comando; `alias g=gh` solo no cuenta (un `gh` a secas no publica).
  const guardaUnGh = (f) => {
    const m = /^[A-Za-z_][A-Za-z0-9_-]*=([\s\S]+)$/.exec(conBloque(f));
    if (!m || nivel > 1 || !/^["']?(\S*[\\/])?gh(\.exe)?(\s|$)/i.test(m[1])) return false;
    return comandosGh(m[1], nivel + 1, opts).some((c) => !c.lectura);
  };
  // ¿Este código de una línea corre un `gh` que publica? El comando que la llamada corre se LEE como una línea más:
  // `os.system("gh pr view 5")` es de lectura. Si tiene la forma y no se deja leer, cuenta como que sí.
  const publicaLeido = (linea, forma) => {
    if (nivel > 1) return forma;
    const leidos = comandosGh(linea, nivel + 1, opts);
    return leidos.length ? leidos.some((c) => !c.lectura) : forma;
  };
  const codigoQuePublica = (t) => {
    const s = String(t);
    if (!GH_COMO_PALABRA.test(s) && s.search(GH_EN_LISTA) < 0) return false;
    // un texto que es un comando: se lee; si después se le pega algo (`"gh --repo " + repo + " pr create"`) y lo leído
    // todavía no trae su grupo, el comando se arma al correr y no se puede leer
    const juzgar = (linea, sigue) => {
      if (!GH_COMO_PALABRA.test(linea)) return false;
      if (GH_CON_GRUPO.test(linea)) return publicaLeido(linea, true);
      return /^\s*[+.%~]/.test(sigue);
    };
    // el comando entero en un texto: desde la comilla que abre hasta la misma comilla sin barra delante
    for (const m of s.matchAll(LLAMADA_CON_TEXTO)) {
      let ini = m.index + m[0].length;
      let fin = ini;
      // …o hasta las tres comillas que cierran, si abre con tres (`os.system("""gh pr create …""")`: leída como un
      // texto vacío seguido de otra cosa, el comando quedaba afuera)
      const triple = m[1].repeat(3);
      if (s.startsWith(triple, ini - 1)) {
        ini += 2;
        fin = s.indexOf(triple, ini);
        if (fin < 0) fin = s.length;
        if (juzgar(s.slice(ini, fin), s.slice(fin + 3, fin + 14))) return true;
        continue;
      }
      while (fin < s.length && s[fin] !== m[1]) fin += s[fin] === '\\' ? 2 : 1;
      if (juzgar(s.slice(ini, fin), s.slice(fin + 1, fin + 12))) return true;
    }
    // …o sin comillas, entre los delimitadores de `%x` y de `qx`
    for (const m of s.matchAll(LLAMADA_SIN_COMILLAS)) {
      const fin = s.indexOf(CIERRE_DE[m[1]] || m[1], m.index + m[0].length);
      if (juzgar(s.slice(m.index + m[0].length, fin < 0 ? s.length : fin), '')) return true;
    }
    // el programa y sus argumentos por separado: lo que sigue a `'gh',` son sus argumentos, cada uno en su lugar
    for (const m of s.matchAll(GH_EN_LISTA)) {
      const args = argumentosDeLista(s, m.index + m[0].length);
      // sin un grupo escrito entre ellos no es un comando que se pueda leer (`['gh', 'jq', 'git']` es una lista de nombres)
      if (!args.some((a) => a.literal && ES_UN_GRUPO.test(a.texto))) continue;
      // un texto con algo pegado puede ser cualquier cosa al correr (`"-X" + metodo`, `"view" if x else "create"`)
      if (args.some((a) => a.mezcla)) return true;
      // una opción va sin comillas, como la escribiría una línea de comando (entre comillas el lector no la toma por opción)
      const escrito = (a) => (/^[A-Za-z0-9_./:=@,+-]+$/.test(a.texto) ? a.texto : `'${a.texto.replace(/'/g, "'\\''")}'`);
      if (publicaLeido(`gh ${args.map(escrito).join(' ')}`, true)) return true;
    }
    return false;
  };
  const heredocConGh = bloques.some((c) => publicaAdentro(c));
  const heredocQueEjecuta = bloques.some((c) => codigoQuePublica(c));
  let porTuberia = false;   // el segmento anterior dejó pasar por su tubería un texto con un `gh` que publica
  let codigoPorTuberia = false;   // …o un código de una línea que corre uno
  let huboO = false;        // hubo un `||` en la lista de comandos en curso (se corta con `;` o un salto de línea)
  for (const { fichas: seg, corte, abre, antes } of segmentos) {
    const veniaPorTuberia = porTuberia && antes.includes('|');
    const codigoVeniaPorTuberia = codigoPorTuberia && antes.includes('|');
    porTuberia = false;
    codigoPorTuberia = false;
    if (abre !== '&&' && abre !== '||') huboO = false;
    const trasUnO = huboO;   // con un `||` antes en la misma lista, este comando puede no correr aunque lo siga un `&&`
    if (corte === '||') huboO = true;
    // La red: si después de sacar las sustituciones entre comillas todavía queda una ficha con una sustitución que
    // nombra a `gh`, es que no se pudo sacar (unas comillas que este lector siguió mal). No se sabe qué corre.
    if (seg.some((f) => f.expande && GH_EN_SUSTITUCION.test(f.texto))) {
      out.push(oculto(lugar, 'un `gh` adentro de una sustitución (`$(…)` o comillas invertidas) que no pude leer: corré el `gh` directamente'));
    }
    const { i, asignaciones } = posicionDeComando(seg);
    const comando = seg[i];
    // Sólo asignaciones, sin `export`. Casi siempre es una variable de la terminal que `gh` no ve — pero si esa
    // variable ya estaba exportada (o la terminal exporta todo), sí la ve. No se sabe: se dice. Y una variable que
    // guarda un `gh` que publica (`CMD="gh pr create …"; $CMD`) está para correrlo: no se sabe qué corre.
    if (!comando) {
      if (asignaciones.some((f) => DESTINO_DE_GH.test(f.texto))) noSeSabeElRepo();
      if (asignaciones.some((f) => guardaUnGh(f))) out.push(oculto(lugar, 'una variable guarda un `gh` que publica: no se sabe qué corre'));
      continue;
    }
    const nombre = comando.expande ? null : comando.texto;
    // en una tubería o en segundo plano, un `cd` y un `export` corren en otro proceso: no le llegan a lo que sigue
    const aparte = agrupa || corte === '|' || abre === '|' || corte === '&';
    if (comando.esBandera && EXPORTA.has(nombre)) {
      if (aparte) { if (seg.some((f) => DESTINO_DE_GH.test(f.texto))) noSeSabeElRepo(); } else aplicarEntorno(lugar, seg.slice(i + 1));
      if (seg.some((f) => guardaUnGh(f))) out.push(oculto(lugar, 'una variable guarda un `gh` que publica: no se sabe qué corre'));
      continue;
    }
    if (comando.esBandera && nombre !== null && ENTRA_A_CARPETA.test(nombre)) {
      const a = seg.slice(i + 1).find((f) => !esOpcion(f));
      // una ruta que la terminal arma al correr —un comodín, llaves, `~usuario`— no es la carpeta que se lee acá
      if (aparte || !a || a.expande || a.texto === '-' || (a.esBandera && SE_EXPANDE_AL_CORRER.test(a.texto))) noSeSabeDonde();
      else { lugar.cds.push(a.texto); if (corte !== '&&' || trasUnO) lugar.cdIncierto = true; }
      continue;
    }
    if (comando.esBandera && nombre !== null && SALE_DE_CARPETA.test(nombre)) { noSeSabeDonde(); continue; }
    // el programa: en la posición del comando (con o sin comillas), o más adelante como palabra suelta (`xargs gh …`)
    let donde = nombre !== null && BINARIO.test(nombre) ? i : -1;
    if (donde < 0) {
      donde = seg.findIndex((f, k) => k > i && f.esBandera && !f.expande && BINARIO.test(f.texto));
      // Más adelante en el segmento, `gh` puede ser el programa que OTRO corre (`xargs gh …`, `timeout 30 gh …`, el
      // `then gh …` de un `if`) o sólo un NOMBRE (`which gh`, `command -v gh`, `brew install gh jq`). Es el programa si
      // lo que lo antecede es de los que corren otro programa, o si lo que sigue tiene la forma de un `gh` que publica.
      // Tomado siempre por el programa, `brew install gh jq` era «un `gh` desconocido que publica» en cualquier repo.
      if (donde > i && !(CORRE_A_OTRO.has(String(nombre || '').toLowerCase()) || AGRUPADORES.has(nombre)
        || formaDeGhQuePublica(sinRedirecciones(seg.slice(donde + 1))))) donde = -1;
    }
    if (donde >= 0) {
      // un `gh` que no está en la posición del comando lo corre OTRO programa (`xargs gh`, `env -C carpeta gh`, el
      // `then gh` de un `if`): desde dónde, y con qué entorno, lo decide ese otro
      const c = leerGh(asignaciones, sinRedirecciones(seg.slice(donde + 1)), corte, cuerpos, lugar);
      if (donde !== i) {
        c.cwdDesconocido = true;
        // quien anota entregas distingue el `gh` MENCIONADO como argumento de otro programa (`echo gh pr create`, un
        // buscador) del que otro LANZA (`xargs gh`, `timeout 30 gh`, el `then gh` de un `if`)
        c.porOtroPrograma = true;
        c.loLanzaOtro = CORRE_A_OTRO.has(String(nombre || '').toLowerCase()) || AGRUPADORES.has(nombre);
        // …y si no trae argumentos y le llega algo por una tubería, se los da ese otro (`echo "pr create …" | xargs gh`):
        // ahí un `gh` a secas no es la ayuda. Sin tubería sigue siendo sólo un nombre (`which gh`, `brew install gh`).
        if (seg.length === donde + 1 && antes.includes('|')) { c.lectura = false; c.ilegible.push('otro programa le pasa los argumentos al `gh` (por la entrada): no se sabe qué corre'); }
      }
      out.push(c);
      // un `gh` también es «otro comando» para los que siguen: puede escribir el archivo que el siguiente va a leer
      // (`gh pr view 5 > cuerpo.md && gh pr comment 5 --body-file cuerpo.md`, `gh release download`)
      lugar.otros += 1;
      continue;
    }
    // el programa llega por una variable, o por una sustitución que se acaba de cerrar, y lo que sigue tiene la forma
    // de un `gh` que publica: no se sabe qué corre
    if ((comando.expande && formaDeGhQuePublica(seg.slice(i + 1))) || ((abre === ')' || abre === '`') && formaDeGhQuePublica(seg.slice(i)))) {
      out.push(oculto(lugar, 'el programa llega por una variable o una sustitución, con la forma de un `gh` que publica: no se sabe qué corre'));
      continue;
    }
    // Un `gh` que publica pasado como TEXTO A UNA TERMINAL (ver `TERMINAL`, arriba): como argumento (`bash -c "gh …"`),
    // por una tubería (`echo "gh …" | sh`, también a través de otros programas), por un bloque heredoc o un texto de
    // entrada, o guardado en una variable o en un alias de la misma línea. Ninguna ficha lo delata como programa, y no
    // se puede leer qué corre. El mismo texto dado a cualquier otro programa es un dato y no cuenta.
    if (seg.some((f) => guardaUnGh(f))) {
      out.push(oculto(lugar, 'una variable o un alias guarda un `gh` que publica: no se sabe qué corre'));
      continue;
    }
    // una terminal por su nombre; `env -S "…"` (parte el texto y lo corre); o una que llega por una variable y recibe
    // su comando con `-c` (`$SHELL -c "gh …"`)
    const esTerminal = seg.some((f) => f.esBandera && !f.expande && TERMINAL.test(f.texto.replace(/\d*<<.*$/, '')))
      || (seg.some((f) => f.esBandera && f.texto === 'env') && seg.some((f) => f.esBandera && /^(-S|--split-string)/.test(f.texto)))
      || (comando.expande && seg.some((f, k) => k > i && f.esBandera && /^-[a-z]*c$/i.test(f.texto)));
    const traeGh = seg.some((f, k) => k !== i && publicaAdentro(conBloque(f))) || (heredocConGh && seg.some((f) => HAY_HEREDOC.test(f.texto)));
    if (esTerminal && (traeGh || veniaPorTuberia)) {
      out.push(oculto(lugar, 'el `gh` viaja adentro de un texto que se le pasa a una terminal (como argumento, por una tubería o en un bloque): corré el `gh` directamente'));
      continue;
    }
    // Código de una línea que corre un `gh` que publica, dado a un INTÉRPRETE (ver `INTERPRETE`, arriba): como
    // argumento, por un bloque o por una tubería. El mismo código dado a otro programa (`grep`, `git commit -m`) es un dato.
    // El intérprete es el programa del segmento, o el que otro lanza, con sus opciones o sin ellas (`uv run python -c`,
    // `sudo -E python3 -c`, `npx -y tsx -e`). Una palabra con ese nombre NO lo es en dos casos, donde el código es el
    // dato que otro programa busca: cuando es el valor de una opción de TIPO de un buscador (`rg -t ruby '…'`), y cuando
    // viene DESPUÉS del código (`grep '…' node`).
    // (Se probaron dos reglas más finas —«con una opción delante no cuenta», y «…salvo que después traiga `-c`/`-e`»— y
    // cada una abría el caso contrario: `npx -y tsx -e` salía sin mirar, o `rg -t ruby -e '…'` quedaba frenado.)
    const kInterprete = seg.findIndex((f, k) => f.esBandera && !f.expande && INTERPRETE.test(f.texto.replace(/\d*<<.*$/, ''))
      && !(k > 0 && seg[k - 1].esBandera && !seg[k - 1].expande && OPCION_DE_TIPO.test(seg[k - 1].texto)));
    const esInterprete = kInterprete >= 0;
    const traeCodigo = seg.some((f) => codigoQuePublica(conBloque(f)));
    const codigoParaEl = esInterprete && seg.some((f, k) => k > kInterprete && codigoQuePublica(conBloque(f)));
    if (esInterprete && (codigoParaEl || codigoVeniaPorTuberia || (heredocQueEjecuta && seg.some((f) => HAY_HEREDOC.test(f.texto))))) {
      out.push(oculto(lugar, 'un guion de una línea ejecuta un `gh` que publica: corré el `gh` directamente'));
      continue;
    }
    if ((traeCodigo || codigoVeniaPorTuberia) && corte === '|') codigoPorTuberia = true;
    if ((traeGh || veniaPorTuberia) && corte === '|') porTuberia = true;
    // Otro programa con la forma de un `gh` que publica (`x pr create …`) en una línea que nombra a `gh`: un alias o
    // una función que lo envuelve, puestos en la misma línea (`alias g=gh; g pr create …`). No se sabe qué corre.
    const verboSolo = seg[i + 1] && !seg[i + 1].expande && !esOpcion(seg[i + 1]) && VERBOS_QUE_PUBLICAN.has(seg[i + 1].texto);
    const apiSuelto = seg[i + 1] && !seg[i + 1].expande && seg[i + 1].texto === 'api' && seg.length > i + 2;   // `alias g=gh; g api …`
    const esDefinido = nombre !== null && definidos.has(nombre);
    if (esDefinido && ((nombraGh && (formaDeGhConVerbo(seg.slice(i + 1)) || apiSuelto)) || (nombraGhConGrupo && verboSolo))) {
      out.push(oculto(lugar, 'otro programa corre con la forma de un `gh` que publica, en una línea que nombra a `gh` (un alias o una función): no se sabe qué corre'));
      continue;
    }
    // Otro comando. Si nombra un `cd` o la variable del repo en una forma que este lector no sigue —entre comillas,
    // adentro de un `if` o de unas llaves, `$env:GH_REPO = …` de PowerShell—, lo que sigue corre no se sabe dónde, o
    // contra no se sabe qué repo. Se dice de más (un `echo cd` también cuenta): de menos, un pedido saldría sin mirar.
    if (seg.some((f) => !f.expande && (ENTRA_A_CARPETA.test(f.texto) || SALE_DE_CARPETA.test(f.texto)))) noSeSabeDonde();
    if (seg.some((f) => DESTINO_DE_GH.test(f.texto))) noSeSabeElRepo();
    lugar.otros += 1;
  }
  // lo de adentro de cada sustitución entre comillas dobles, leído como una línea más
  for (let adentro of sueltas0.adentro) {
    if (!pareceGh(adentro)) continue;
    // un bloque que viajaba adentro vuelve a su forma, para que esa lectura lo saque de nuevo
    for (const [marca, cuerpo] of cuerpos) adentro = adentro.split(`"${marca}"`).join(`"$(cat <<'GHPRBLOQUE'\n${cuerpo}\nGHPRBLOQUE\n)"`);
    for (const c of comandosGh(adentro, nivel + 1, opts)) {
      // No se sabe en qué punto de la línea corre: si la línea cambió de carpeta o de repo, tampoco desde dónde ni a cuál
      if (lugar.cds.length || lugar.cwdDesconocido) c.cwdDesconocido = true;
      if (!c.repo && (lugar.repo || lugar.repoDesconocido)) c.repoDesconocido = true;
      c.otros += lugar.otros;
      out.push(c);
    }
  }
  return out;
}

/**
 * Filtro barato para descartar de una un comando que no tiene nada que ver. Mira el texto sin comillas ni barras
 * (`g""h` es `gh`) y es un superconjunto: quien decide de verdad es `comandosGh`, sobre las fichas. Suma la forma de un
 * `gh` que publica detrás de una variable o de una sustitución (`$GH pr create`, `$(which gh) pr create`).
 */
const PARECE = /(^|[^A-Za-z0-9_.-])gh(\.exe|\.cmd)?($|[^A-Za-z0-9_.-])/i;   // `gh` como palabra, siga lo que siga (`alias g=gh;`)
const PARECE_OCULTO = /(\$[A-Za-z_{(][^\s]*|[)`])\s+(pr|issue|release|gist|label)\s+(create|edit|comment|review|merge|close|upload)\b|(\$[A-Za-z_{(][^\s]*|[)`])\s+api\s/i;
function pareceGh(cmd) {
  // una barra al final del renglón une los dos renglones SIN dejar un espacio: `g\<salto>h` es `gh`
  const unido = String(cmd || '').replace(/[\\`]\r?\n/g, '');
  const plano = unido.replace(/["'\\]/g, '');
  // …y la barra invertida también es el separador de una ruta de Windows (`C:\tools\gh.exe`): se mira de las dos formas,
  // para que este filtro siga siendo un superconjunto de lo que el lector reconoce
  const conRutas = unido.replace(/["']/g, '').replace(/\\/g, '/');
  return PARECE.test(plano) || PARECE_OCULTO.test(plano) || PARECE.test(conRutas);
}

module.exports = { comandosGh, pareceGh, repoDe, repoDeRuta, GRUPOS_DE_LECTURA, VERBOS_DE_LECTURA };
