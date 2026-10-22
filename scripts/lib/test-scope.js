'use strict';
/**
 * test-scope.js — ¿este comando corre una suite de pruebas entera, sin acotar? Lee el comando como lo lee el shell.
 *
 * Lo usa el freno de pruebas sin alcance (scripts/hooks/test-scope-guard-pre.sh) cuando el comando nombra una
 * herramienta de pruebas. Una suite sin filtro paraleliza en casi todos los núcleos y puede congelar la máquina; el
 * freno pide acotarla. Mirar sólo si el comando EMPIEZA con `npm test` deja pasar todo lo que va adelante (un prefijo,
 * una variable, un paréntesis, otro programa que la lanza) y toma por alcance el valor de una opción.
 *
 * Cómo lee:
 *  - corta con el lector de shell compartido (shell-parse.js): agrupaciones, control de flujo, sustituciones, cuerpos de
 *    heredoc que alimentan a un shell; los comentarios y los patrones de un `case` no son comandos;
 *  - por cada comando simple saca los prefijos (`time`, `nice`, `env A=b`, `sudo`, `!`, `timeout 60`, `xargs`…) y entra
 *    a lo que lanzan los envoltorios (`bash -c`, `eval`, `<<<`, `echo … | bash`, `ssh`, `docker exec`, `su -c`, `tmux`,
 *    `pwsh -Command`, `iex`, `cmd /c`, `Start-Process`, un alias);
 *  - reconoce la herramienta por su nombre, con ruta o con `.exe`/`.cmd`, y a través de los gestores (npm, pnpm, yarn,
 *    bun, npx, uv, poetry, pipenv, `python -m`);
 *  - decide con las opciones de cada herramienta: cuáles acotan y cuáles llevan un valor que no es alcance.
 * Lo que no puede leer (comillas sin cerrar, el texto de un shell armado con variables) frena de más y lo dice.
 *
 * El escape `TYCON_FULL_SUITE=1` cuenta cuando acompaña al comando de pruebas (como prefijo, con `env`, exportado o con
 * `$env:` en un comando anterior), no cuando sólo se nombra en un texto.
 *
 * CLI: el comando por la entrada estándar; `--tool <herramienta>` con la que lo corre el asistente (`Bash` o
 * `PowerShell`: en PowerShell también se leen sus bloques entre paréntesis). Imprime dos renglones:
 * el veredicto (`frena`, `escape`, `pasa` o `nada`) y el comando que lo decidió, o el motivo cuando no se pudo leer.
 */
const path = require('path');
const sp = require('./shell-parse.js');

// Si el texto no nombra ninguna de estas, no hay nada que mirar. El guion del freno filtra con la misma lista
// (NOMBRA_PRUEBAS) antes de arrancar Node: si se agrega una herramienta acá, va también allá.
const NOMBRA = /dotnet|npm|pnpm|pnpx|yarn|bunx?|npx|vitest|jest|pytest|py\.test|(?:pwsh|powershell)[^\n]{0,300}\s-e/i;

const SHELLS = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash', 'fish']);
// los programas que este lector sabe seguir: sirven para encontrar el comando adentro de un envoltorio
const PROGRAMAS = new Set(['dotnet', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'pnpx', 'bunx', 'vitest', 'jest', 'pytest', 'py.test',
  'python', 'python3', 'py', 'uv', 'poetry', 'pipenv', 'pdm', 'hatch', 'node', ...SHELLS]);
const PROFUNDIDAD = 8;      // textos anidados (`bash -c` adentro de `ssh` adentro de …)
const CADENA = 32;          // programas encadenados en un mismo comando (`sudo env A=1 nice timeout 60 …`)
// Dos topes: el comando entero (un heredoc que escribe un archivo grande es normal) y lo que se corta como comandos, sin
// los cuerpos de heredoc que no van a un shell (cortar 250 KB de palabras tarda segundos en una máquina lenta).
const TOPE = 1024 * 1024;
const TOPE_CORTE = 64 * 1024;

// el nombre del programa, sin ruta, sin `.exe`/`.cmd` y sin la versión de un paquete (`vitest@latest`, `jest@29`)
const nombre = (w) => path.posix.basename(String(w).replace(/\\/g, '/')).toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, '').replace(/(.)@[^@/]*$/, '$1');
const esOpcion = (w) => /^-/.test(w) || /^\/[A-Za-z]+:/.test(w);
const escape = (asig) => asig.some((a) => a.name === 'TYCON_FULL_SUITE' && /^["']?1["']?$/.test(a.raw || ''));

/** Una palabra del comando: su texto sin comillas y si depende de algo que sólo se sabe al correr. */
function palabra(raw) {
  const t = sp.tokens(raw);
  const texto = t.length ? t.join(' ') : '';
  const dinamica = /\$|`/.test(String(raw).replace(/'[^']*'/g, ''));
  // lo que queda al sacar las partes variables: `${X}/a.py` deja `/a.py`, `"$X"` no deja nada
  const fijo = String(raw).replace(/\$\([^)]*\)|\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|`[^`]*`|["']/g, '');
  return { raw, texto, dinamica, fijo };
}

/** ¿Quedan comillas (o comillas invertidas) sin cerrar? Fuera de los comentarios y respetando `\` y `$'…'`. */
function comillasAbiertas(texto) {
  let q = null; let invertidas = 0;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (q === "'") { if (c === "'") q = null; continue; }
    if (q === '$\'') { if (c === '\\') { i++; continue; } if (c === "'") q = null; continue; }
    if (q === '"') { if (c === '\\') { i++; continue; } if (c === '`') invertidas++; if (c === '"') q = null; continue; }
    if (c === '\\') { i++; continue; }
    if (c === '#' && (i === 0 || /\s|[;&|(]/.test(texto[i - 1]))) { const f = texto.indexOf('\n', i); if (f < 0) break; i = f; continue; }
    if (c === '$' && texto[i + 1] === "'") { q = '$\''; i++; continue; }
    if (c === '`') invertidas++;
    if (c === '"' || c === "'") q = c;
  }
  return q !== null || invertidas % 2 === 1;
}

/**
 * Lee un texto de comandos. Devuelve los hallazgos: {tipo: 'suite'|'acotada'|'opaco', comando, motivo, escape}.
 * ctx: { ps, escape, prof }.
 */
function revisar(texto, ctx, out) {
  texto = String(texto);
  if (!NOMBRA.test(texto)) return out;
  if (ctx.prof > PROFUNDIDAD) { out.push({ tipo: 'opaco', comando: texto, motivo: 'demasiados envoltorios anidados', escape: ctx.escape }); return out; }
  // cada texto anidado se vuelve a cortar: lo cortado en toda la lectura no pasa del tope
  ctx.trabajo.leido += sp.sinHeredocs(texto, { salvoShell: true }).length;
  if (ctx.trabajo.leido > TOPE_CORTE) { out.push({ tipo: 'opaco', comando: texto.slice(0, 200), motivo: 'demasiado texto anidado para leerlo', escape: ctx.escape }); return out; }
  // `<<\EOF` es un heredoc con el delimitador entre comillas, como `<<'EOF'`: su cuerpo es texto
  texto = texto.replace(/<<(-?)[ \t]*\\([A-Za-z_][A-Za-z0-9_]*)/g, "<<$1'$2'");
  if (!ctx.ps && comillasAbiertas(sp.sinHeredocs(texto))) {
    out.push({ tipo: 'opaco', comando: texto, motivo: 'tiene comillas sin cerrar', escape: ctx.escape });
    return out;
  }
  // el cuerpo de un heredoc SIN comillas ejecuta sus `$( … )` y comillas invertidas aunque vaya a `cat`
  const heredoc = /<<-?[ \t]*(['"]?)([^\s'"<>|&;]+)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g;
  for (let h; (h = heredoc.exec(texto));) if (!h[1]) for (const sub of sp.substitutions(h[3])) revisar(sub, hijo(ctx, ctx.escape), out);
  const segs = sp.lex(sp.sinHeredocs(texto, { salvoShell: true }));
  let declarado = ctx.escape;
  // adentro de una subshell `( … )` la variable no sale: así declarada, no vale para lo que sigue
  const enSubshell = /\(\s*(?:export\s+)?TYCON_FULL_SUITE=/.test(texto);
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k].texto.trim();
    if (!seg) continue;
    // `$env:TYCON_FULL_SUITE=1`, `export TYCON_FULL_SUITE=1` o la asignación sola valen para lo que sigue
    if (/^\$env:TYCON_FULL_SUITE\s*=\s*["']?1["']?$/i.test(seg)) { declarado = true; continue; }
    const p = sp.parseSimpleCommand(seg);
    if ((!p.words.length || p.words[0] === 'export') && escape(p.assignments)) { declarado = declarado || !enSubshell; continue; }
    // `unset TYCON_FULL_SUITE` o otro valor lo apagan para lo que sigue
    if ((p.words[0] === 'unset' && p.words.includes('TYCON_FULL_SUITE'))
      || ((!p.words.length || p.words[0] === 'export') && p.assignments.some((a) => a.name === 'TYCON_FULL_SUITE'))
      || /^\$env:TYCON_FULL_SUITE\s*=/i.test(seg) || /^Remove-Item\s+env:TYCON_FULL_SUITE/i.test(seg)) { declarado = false; continue; }
    // `echo "…" | bash`: lo que el primero imprime es lo que el shell corre
    const sig = segs[k + 1] && segs[k + 1].texto.trim();
    if (segs[k].sep === '|' && sig && esShellSinTexto(sig)) {
      const w = p.words.map(palabra);
      const prog = w.length ? nombre(w[0].texto) : '';
      if ((prog === 'echo' || prog === 'printf') && !w.slice(1).some((x) => x.dinamica)) {
        revisar(w.slice(1).filter((x) => !/^-[neE]+$/.test(x.texto)).map((x) => x.texto).join(' '), hijo(ctx, declarado), out);
      } else {
        out.push({ tipo: 'opaco', comando: seg + ' | ' + sig, motivo: 'no sé qué texto le llega al shell', escape: declarado });
      }
      k++;
      continue;
    }
    comando(seg, p, { ...ctx, escape: declarado }, out);
    // lo de adentro de `$(…)` y de las comillas invertidas corre aunque vaya entre comillas dobles
    for (const sub of sp.substitutions(seg)) revisar(sub, hijo(ctx, declarado), out);
    // un bloque entre llaves después de un programa (`Measure-Command { npm test }`, `try { … }`, `ForEach-Object { … }`)
    // y, en PowerShell, entre paréntesis (`$r = (npm test)`): lo de adentro corre
    for (const b of bloques(seg, ctx.ps)) revisar(b, hijo(ctx, declarado), out);
  }
  return out;
}

/** Lo de adentro de cada `{ … }` (y `( … )` en PowerShell) del primer nivel, fuera de comillas. */
function bloques(seg, ps) {
  const out = []; const pila = []; let q = null;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (q) { if (c === '\\' && q === '"') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '{' || (ps && c === '(')) pila.push({ c, i });
    else if ((c === '}' || (ps && c === ')')) && pila.length) {
      const a = pila.pop();
      if (!pila.length && (a.c === '{') === (c === '}')) out.push(seg.slice(a.i + 1, i));
    }
  }
  return out.filter((x) => NOMBRA.test(x));
}

const hijo = (ctx, escape) => ({ ...ctx, escape, prof: ctx.prof + 1 });

/** `bash`, `sh -s`, sin `-c` ni guion: lee los comandos de la entrada. */
function esShellSinTexto(seg) {
  const w = sp.parseSimpleCommand(seg).words.map((x) => palabra(x).texto);
  if (!w.length || !SHELLS.has(nombre(w[0]))) return false;
  return w.slice(1).every((x) => esOpcion(x) && !/^-[a-z]*c[a-z]*$/i.test(x));
}

/** Un comando simple ya cortado. */
function comando(seg, p, ctx, out) {
  let esc = ctx.escape || escape(p.assignments);
  let w = p.words.map(palabra);
  // en PowerShell, `& prog` y `. prog` llaman al programa
  if (ctx.ps && w.length && (w[0].texto === '&' || w[0].texto === '.')) w = w.slice(1);
  // `time -p dotnet test`: el lector de shell ya sacó `time` y dejó su `-p` adelante
  if (/^\s*time\s/.test(seg)) while (w.length && w[0].texto === '-p') w = w.slice(1);
  // palabras reservadas que pueden quedar adelante (`then dotnet test`, `! dotnet test`, `{ dotnet test`)
  while (w.length && /^(?:!|then|do|else|elif|if|while|until|\{|\}|time)$/.test(w[0].texto) && !w[0].dinamica) {
    if (w[0].texto === 'time') { w = w.slice(1); while (w.length && w[0].texto === '-p') w = w.slice(1); continue; }
    w = w.slice(1);
  }
  if (!w.length) return;
  // `"dotnet test"` como una sola palabra: el shell busca un programa con ese nombre; se lee como lo que nombra. Una ruta
  // con espacios (`"C:/Program Files/dotnet/dotnet.exe"`) es un programa.
  if (/\s/.test(w[0].texto) && !/[\\/]/.test(w[0].texto) && !w[0].dinamica) w =sp.tokens(w[0].texto).map((x) => palabra(JSON.stringify(x))).concat(w.slice(1));
  // un `here-string` a un shell: `bash <<< "dotnet test"`
  const hs = p.redirections.find((r) => r.op === '<<<');
  if (hs && SHELLS.has(nombre(w[0].texto)) && esShellSinTexto(seg)) {
    const t = palabra(hs.target);
    if (t.dinamica) out.push({ tipo: 'opaco', comando: seg, motivo: 'el texto que le llega al shell depende de una variable', escape: esc });
    else revisar(t.texto, hijo(ctx, esc), out);
    return;
  }
  programa(w, { ...ctx, escape: esc }, out, seg);
}

// prefijos: cuántas palabras de opción con valor se saltean, por programa
const PREFIJOS = {
  nice: ['-n'], nohup: [], command: [], exec: ['-a'], builtin: [], sudo: ['-u', '-g', '-h', '-C', '-D', '-p', '-r', '-t', '-U', '-T'],
  doas: ['-u', '-C'], stdbuf: ['-i', '-o', '-e'], ionice: ['-c', '-n', '-p'], caffeinate: ['-t', '-w'], unbuffer: [],
  chronic: [], nocorrect: [], noglob: [], setsid: [], arch: [], time: ['-f', '-o', '--format', '--output'], gtime: ['-f', '-o', '--format', '--output'],
  corepack: [],
};

function saltarOpciones(w, i, conValor) {
  while (i < w.length && esOpcion(w[i].texto) && w[i].texto !== '--') {
    const o = w[i].texto;
    i += (conValor.includes(o) && !o.includes('=')) ? 2 : 1;
  }
  if (i < w.length && w[i].texto === '--') i++;
  return i;
}

/**
 * ¿Un texto armado al correr puede esconder un comando de pruebas? Sí si usa variables, o si una sustitución `$( … )`
 * nombra una herramienta. Lo que imprime una sustitución que no nombra ninguna (`eval "$(ssh-agent -s)"`) no se cuenta.
 */
function textoOpaco(palabras) {
  const r = palabras.map((x) => x.raw).join(' ');
  if (/\$(?:\{|[A-Za-z_])/.test(r.replace(/'[^']*'/g, ''))) return true;
  return sp.substitutions(r).some((s) => NOMBRA.test(s));
}

/** Índice de la primera palabra que es un programa que este lector sigue (sin ruta: `/jest` es un argumento). */
function primerPrograma(w, desde = 0) {
  for (let i = desde; i < w.length; i++) if (!/[\\/]/.test(w[i].texto) && PROGRAMAS.has(nombre(w[i].texto))) return i;
  return -1;
}

/** Desde la palabra que es el programa. `seg` es el texto para el mensaje. Corta una cadena demasiado larga. */
function programa(w, ctx, out, seg) {
  const cadena = (ctx.cadena || 0) + 1;
  if (cadena > CADENA) { out.push({ tipo: 'opaco', comando: seg, motivo: 'demasiados programas encadenados', escape: ctx.escape }); return; }
  return programaDe(w, { ...ctx, cadena }, out, seg);
}

function programaDe(w, ctx, out, seg) {
  if (!w.length) return;
  const prog = nombre(w[0].texto);
  const resto = w.slice(1);
  const opaco = (motivo) => out.push({ tipo: 'opaco', comando: seg, motivo, escape: ctx.escape });
  const adentro = (texto, ps) => revisar(texto, { ...hijo(ctx, ctx.escape), ps: !!ps }, out);
  // un texto que corre otro programa: si no se encontró nada y se arma al correr, no se pudo leer
  const adentroDe = (palabras, ps) => {
    const ini = out.length;
    adentro(palabras.map((x) => x.texto).join(' '), ps);
    if (out.length === ini && textoOpaco(palabras)) opaco('el texto que corre depende de algo que sólo se sabe al correr');
  };

  if (w[0].dinamica && !w[0].fijo) {
    // `"$PYTHON" -m pytest …` se lee como python; `$T test` no se puede leer; `$EDITOR notas.md` no corre pruebas
    if (resto.some((x) => x.texto === '-m')) return programa([palabra('python'), ...resto], ctx, out, seg);
    if (resto.some((x) => /^(?:test|t|run|exec|x|vitest|jest|pytest|py\.test)$/.test(x.texto))) opaco('el programa es una variable');
    return;
  }

  // ── prefijos ─────────────────────────────────────────────────────────────────────────────────────────
  if (prog === 'command' && resto.some((x) => /^-[vV]$/.test(x.texto))) return;   // `command -v x` sólo busca
  // `sudo A=1 cmd`: después de sus opciones, sudo acepta asignaciones
  if (prog === 'sudo' || prog === 'doas') {
    let i = saltarOpciones(resto, 0, PREFIJOS[prog]);
    let esc = ctx.escape;
    while (i < resto.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(resto[i].texto)) { if (/^TYCON_FULL_SUITE=1$/.test(resto[i].texto)) esc = true; i++; }
    return programa(resto.slice(i), { ...ctx, escape: esc }, out, seg);
  }
  if (Object.prototype.hasOwnProperty.call(PREFIJOS, prog)) return programa(resto.slice(saltarOpciones(resto, 0, PREFIJOS[prog])), ctx, out, seg);
  // `taskset -c 0 cmd` o `taskset 0x1 cmd`: la máscara va antes del comando
  if (prog === 'taskset') return programa(resto.slice(saltarOpciones(resto, 0, []) + 1), ctx, out, seg);
  // los que ponen variables y lanzan: `cross-env A=1 cmd`, `dotenv -e .env -- cmd`
  if (prog === 'cross-env' || prog === 'dotenv' || prog === 'dotenvx' || prog === 'env-cmd') {
    let i = saltarOpciones(resto, 0, ['-e', '-f', '-c', '-v', '--file', '--environments']);
    let esc = ctx.escape;
    while (i < resto.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(resto[i].texto)) { if (/^TYCON_FULL_SUITE=1$/.test(resto[i].texto)) esc = true; i++; }
    if (resto[i] && resto[i].texto === '--') i++;
    if (resto[i] && resto[i].texto === 'run') i = saltarOpciones(resto, i + 1, ['-f', '--env-file']);
    return programa(resto.slice(i), { ...ctx, escape: esc }, out, seg);
  }
  if (prog === 'cross-env-shell') {
    let i = 0;
    while (i < resto.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(resto[i].texto)) i++;
    return adentroDe(resto.slice(i));
  }
  // los que eligen la versión de Node o del entorno: `volta run`, `fnm exec`, `nvm exec 20`, `mise exec --`, `direnv exec .`
  if (['volta', 'fnm', 'nvm', 'mise', 'rtx', 'asdf', 'direnv'].includes(prog)) {
    const i = resto.findIndex((x) => x.texto === 'run' || x.texto === 'exec' || x.texto === 'x');
    if (i < 0) return;
    let j = saltarOpciones(resto, i + 1, OPCIONES.envoltorios.versiones);
    // `nvm exec 20 cmd`, `direnv exec . cmd`: la versión o la carpeta va antes del comando
    if ((prog === 'nvm' || prog === 'direnv') && resto[j] && !PROGRAMAS.has(nombre(resto[j].texto))) j++;
    // `mise exec node@20 -- npm test`: si hay `--`, el comando es lo que sigue
    const d = resto.findIndex((x, k) => k >= i && x.texto === '--');
    if (d >= 0) j = d + 1;
    return programa(resto.slice(j), ctx, out, seg);
  }
  // `wsl npm test`, `wsl -e dotnet test`, `wsl -- cmd`: lo corre el shell de la distribución
  if (prog === 'wsl') {
    let i = saltarOpciones(resto, 0, ['-d', '--distribution', '-u', '--user', '--cd']);
    if (resto[i - 1] && /^(?:-e|--exec)$/.test(resto[i - 1].texto)) i--;
    if (resto[i] && /^(?:-e|--exec)$/.test(resto[i].texto)) return programa(resto.slice(i + 1), ctx, out, seg);
    return adentroDe(resto.slice(i));
  }
  // `git rebase -x "npm test"`, `git rebase --exec=…`, `git bisect run npm test`
  if (prog === 'git') {
    for (let i = 0; i < resto.length; i++) {
      const t = resto[i].texto;
      if (t === '-x' || t === '--exec') adentroDe(resto.slice(i + 1, i + 2));
      else if (t.startsWith('--exec=')) adentro(t.slice('--exec='.length));
      else if (t === 'bisect' && resto[i + 1] && resto[i + 1].texto === 'run') return programa(resto.slice(i + 2), ctx, out, seg);
    }
    return;
  }
  if (prog === 'env') {
    let i = 0; let esc = ctx.escape;
    while (i < resto.length) {
      const t = resto[i].texto;
      if (t === '-S' || t === '--split-string') { adentro([resto[i + 1] ? resto[i + 1].texto : ''].concat(resto.slice(i + 2).map((x) => x.texto)).join(' ')); return; }
      if (OPCIONES.envoltorios.env.includes(t)) { i += 2; continue; }
      if (esOpcion(t)) { i++; continue; }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { if (/^TYCON_FULL_SUITE=1$/.test(t)) esc = true; i++; continue; }
      break;
    }
    return programa(resto.slice(i), { ...ctx, escape: esc }, out, seg);
  }
  if (prog === 'timeout' || prog === 'gtimeout') {
    let i = saltarOpciones(resto, 0, ['-s', '-k', '--signal', '--kill-after']);
    return programa(resto.slice(i + 1), ctx, out, seg);
  }
  if (prog === 'xargs') {
    // lo que xargs agrega al final no se sabe: no puede acotar
    const i = saltarOpciones(resto, 0, ['-n', '-I', '-L', '-P', '-d', '-E', '-s', '-a', '-J', '-R', '-S']);
    return programa(resto.slice(i), { ...ctx, sinPosicionales: true }, out, seg);
  }
  if (prog === 'watch') { const i = saltarOpciones(resto, 0, ['-n', '--interval', '-d', '-q']); return adentroDe(resto.slice(i)); }

  // ── envoltorios que corren un texto ──────────────────────────────────────────────────────────────────
  if (prog === 'eval') return adentroDe(resto);
  if (prog === 'iex' || prog === 'invoke-expression') return adentroDe(resto.filter((x) => !/^-command$/i.test(x.texto)), true);
  if (SHELLS.has(prog)) {
    const i = resto.findIndex((x) => /^-[A-Za-z]*c[A-Za-z]*$/.test(x.texto) && !/^--/.test(x.texto));
    if (i < 0) return;   // corre un guion del disco, o lee la entrada (`| bash`, heredoc): se mira donde se arma
    return adentroDe(resto.slice(i + 1));
  }
  if (prog === 'pwsh' || prog === 'powershell') {
    for (let i = 0; i < resto.length; i++) {
      const o = resto[i].texto.toLowerCase();
      if (/^-(?:c|co|com|comm|comma|comman|command)$/.test(o)) return adentroDe(resto.slice(i + 1), true);
      if (/^-(?:e|ec|en|enc|encodedcommand)$/.test(o)) {
        const t = resto[i + 1] ? Buffer.from(resto[i + 1].texto, 'base64').toString('utf16le') : '';
        return t ? adentro(t, true) : opaco('no pude leer el texto codificado');
      }
      if (/^-(?:f|file)$/.test(o)) return;
      // sin `-Command`, la primera palabra suelta y lo que sigue: PowerShell 5.1 lo corre como comando
      if (!/^-/.test(o)) return adentroDe(resto.slice(i), true);
    }
    return;
  }
  if (prog === 'cmd') {
    const i = resto.findIndex((x) => /^\/[ck]$/i.test(x.texto));
    return i < 0 ? undefined : adentroDe(resto.slice(i + 1));
  }
  if (prog === 'su') {
    const i = resto.findIndex((x) => x.texto === '-c' || x.texto === '--command');
    return i < 0 ? undefined : adentroDe(resto.slice(i + 1, i + 2));
  }
  if (prog === 'script') {
    const i = resto.findIndex((x) => /^-[a-z]*c$/.test(x.texto) || x.texto === '--command');
    if (i >= 0) return adentroDe(resto.slice(i + 1, i + 2));
    // la forma de BSD: `script [-q] archivo comando …`
    const j = saltarOpciones(resto, 0, ['-F', '-t', '-T']);
    return programa(resto.slice(j + 1), ctx, out, seg);
  }
  if (prog === 'ssh') {
    const i = saltarOpciones(resto, 0, ['-p', '-i', '-l', '-o', '-F', '-J', '-L', '-R', '-D', '-b', '-c', '-E', '-e', '-m', '-O', '-Q', '-S', '-W', '-w', '-B']);
    return adentroDe(resto.slice(i + 1));
  }
  if (prog === 'nix-shell') {
    const i = resto.findIndex((x) => x.texto === '--run' || x.texto === '--command');
    return i < 0 ? undefined : adentroDe(resto.slice(i + 1, i + 2));
  }
  if (prog === 'alias') {
    for (const x of resto) { const m = /^[^=]+=([\s\S]*)$/.exec(x.texto); if (m) adentro(m[1]); }
    return;
  }
  if (prog === 'start-process' || prog === 'saps' || (ctx.ps && prog === 'start')) {
    let archivo = null; const args = [];
    for (let i = 0; i < resto.length; i++) {
      const o = resto[i].texto.toLowerCase();
      if (o === '-filepath') { archivo = resto[++i]; continue; }
      if (o === '-argumentlist' || o === '-args') { if (resto[i + 1]) args.push(resto[++i]); continue; }
      if (/^-(?:wait|nonewwindow|passthru)$/.test(o)) continue;
      if (/^-/.test(o)) { i++; continue; }
      if (!archivo) archivo = resto[i]; else args.push(resto[i]);
    }
    if (!archivo) return;
    const lista = args.flatMap((a) => sp.tokens(a.raw.replace(/,/g, ' ')).map((x) => palabra(JSON.stringify(x))));
    return programa([archivo, ...lista], ctx, out, seg);
  }

  // ── envoltorios que lanzan un programa: el comando empieza en su primera palabra suelta tras las opciones ─────
  // Si una opción con valor que no está en la lista corre la cuenta, se busca el primer programa que este lector sigue.
  const desde = (i) => {
    const ini = out.length;
    programa(resto.slice(i), ctx, out, seg);
    if (out.length > ini) return;
    const j = primerPrograma(resto, i + 1);
    if (j >= 0) programa(resto.slice(j), ctx, out, seg);
  };
  if (prog === 'docker' || prog === 'podman' || prog === 'nerdctl') {
    let i = saltarOpciones(resto, 0, OPCIONES.envoltorios.docker.global);
    let sub = resto[i] ? resto[i].texto : '';
    if (sub === 'container' || sub === 'compose') { i++; sub = resto[i] ? resto[i].texto : ''; }
    if (sub !== 'exec' && sub !== 'run') return;
    i = saltarOpciones(resto, i + 1, OPCIONES.envoltorios.docker.lanzar);
    return desde(i + 1);   // la palabra `i` es el contenedor, la imagen o el servicio
  }
  if (prog === 'kubectl') {
    const d = resto.findIndex((x) => x.texto === '--');
    return d < 0 ? undefined : desde(d + 1);
  }
  if (prog === 'screen') return desde(saltarOpciones(resto, 0, ['-S', '-t', '-c', '-e', '-h', '-p', '-X', '-T', '-L', '-Logfile']));
  if (prog === 'tmux') {
    let i = saltarOpciones(resto, 0, ['-L', '-S', '-f', '-c', '-T']);
    const sub = resto[i] ? resto[i].texto : '';
    const valores = ['-s', '-n', '-t', '-c', '-x', '-y', '-F', '-e', '-f', '-l'];
    if (['new', 'new-session', 'new-window', 'neww', 'split-window', 'splitw', 'respawn-pane', 'respawnp', 'respawn-window', 'respawnw'].includes(sub)) {
      i = saltarOpciones(resto, i + 1, valores);
      return i < resto.length ? adentroDe(resto.slice(i)) : undefined;
    }
    if (sub === 'send-keys' || sub === 'send') {
      i = saltarOpciones(resto, i + 1, ['-t', '-N']);
      return adentroDe(resto.slice(i).filter((x) => !/^(?:Enter|C-m|KPEnter|C-j)$/.test(x.texto)));
    }
    return;
  }
  if (prog === 'flock') {
    const c = resto.findIndex((x) => x.texto === '-c' || x.texto === '--command');
    if (c >= 0) return adentroDe(resto.slice(c + 1, c + 2));
    return desde(saltarOpciones(resto, 0, ['-w', '--timeout', '-E', '--conflict-exit-code']) + 1);   // la palabra que sigue es el archivo
  }
  if (prog === 'devbox') {
    const i = resto.findIndex((x) => x.texto === 'run');
    return i < 0 ? undefined : desde(saltarOpciones(resto, i + 1, ['-c', '--config', '-e', '--env']));
  }
  // `find … -exec cmd … ;` (cada `-exec`, todos) y `parallel cmd ::: args` o `parallel ::: 'cmd1' 'cmd2'`
  if (prog === 'find') {
    for (let i = 0; i < resto.length; i++) {
      if (!/^-(?:exec|execdir|ok|okdir)$/.test(resto[i].texto)) continue;
      let f = i + 1;
      while (f < resto.length && !/^(?:;|\\;|\+)$/.test(resto[f].texto)) f++;
      programa(resto.slice(i + 1, f), ctx, out, seg);
      i = f;
    }
    return;
  }
  if (prog === 'parallel' || prog === 'xjobs') {
    const sep = resto.findIndex((x) => /^:::+$/.test(x.texto));
    const plantilla = resto.slice(saltarOpciones(resto, 0, OPCIONES.envoltorios.parallel), sep < 0 ? resto.length : sep);
    if (plantilla.length) return programa(plantilla, { ...ctx, sinPosicionales: true }, out, seg);
    if (sep >= 0) for (const x of resto.slice(sep + 1)) if (!/^:::+$/.test(x.texto)) adentro(x.texto);
    return;
  }

  // ── gestores ─────────────────────────────────────────────────────────────────────────────────────────
  if (prog === 'npx' || prog === 'pnpx' || prog === 'bunx') {
    for (let i = 0; i < resto.length; i++) {
      const o = resto[i].texto;
      if (o === '-c' || o === '--call') return adentroDe(resto.slice(i + 1, i + 2));
      if (o === '-p' || o === '--package') { i++; continue; }
      if (esOpcion(o)) continue;
      return programa(resto.slice(i), ctx, out, seg);
    }
    return;
  }
  if (prog === 'npm' || prog === 'pnpm' || prog === 'yarn' || prog === 'bun') return gestor(prog, resto, ctx, out, seg);
  if (['uv', 'poetry', 'pipenv', 'pdm', 'hatch', 'rye', 'conda', 'mamba', 'micromamba'].includes(prog)) {
    const i = resto.findIndex((x) => x.texto === 'run');
    if (i < 0) return;
    return desde(saltarOpciones(resto, i + 1, ['--with', '--python', '-p', '--project', '--directory', '--package', '--extra',
      '--group', '--env-file', '--index', '-n', '--name', '--prefix', '-e', '--env']));
  }
  if (/^python[0-9.]*$/.test(prog) || prog === 'py') {
    const i = resto.findIndex((x) => x.texto === '-m');
    if (i < 0 || !resto[i + 1]) return;
    const mod = resto[i + 1].texto;
    if (mod === 'pytest' || mod === 'py.test') return herramienta('pytest', resto.slice(i + 2), ctx, out, seg);
    return;
  }
  if (prog === 'node' && resto.length && /(?:^|\/)(?:vitest|jest)(?:\/|\.m?js$|$)/.test(resto[0].texto.replace(/\\/g, '/'))) {
    return herramienta(/vitest/.test(resto[0].texto) ? 'vitest' : 'jest', resto.slice(1).filter((x, k) => !(k === 0 && /^bin\//.test(x.texto))), ctx, out, seg);
  }

  // ── las herramientas ─────────────────────────────────────────────────────────────────────────────────
  if (prog === 'dotnet') {
    const i = saltarOpciones(resto, 0, []);
    if (!resto[i] || resto[i].texto.toLowerCase() !== 'test') return;
    return herramienta('dotnet', resto.slice(i + 1), ctx, out, seg);
  }
  if (prog === 'vitest' || prog === 'jest' || prog === 'pytest' || prog === 'py.test') return herramienta(prog === 'py.test' ? 'pytest' : prog, resto, ctx, out, seg);
}

// Las opciones de las herramientas ajenas (cuáles llevan valor, cuáles acotan, cuáles no llevan valor) son datos de esas
// herramientas, no opciones del arnés: viven en test-scope-options.json.
const OPCIONES = require('./test-scope-options.json');
const VALOR_JS = OPCIONES.js.valor;
const ACOTA_JS = OPCIONES.js.acota;
const VALOR_PYTEST = OPCIONES.pytest.valor;
const VALOR_DOTNET = OPCIONES.dotnet.valor;
const FILTRO_DOTNET = OPCIONES.dotnet.filtro;

/** Una palabra que, como argumento suelto, acota: un archivo o carpeta concreta, no `.`, `./` ni algo variable. */
function acotaPosicional(x, ctx) {
  if (ctx.sinPosicionales) return false;
  // `true`, `false` o un número son el valor de una opción (`--watch false`, `--bail 1`), nunca un archivo
  if (!x.dinamica && /^(?:true|false|\d+(?:\.\d+)?)$/i.test(x.texto)) return false;
  if (x.dinamica) return /[A-Za-z0-9_]/.test(x.fijo.replace(/^[./\\]+/, ''));
  return x.texto !== '' && !/^\.{1,2}[\\/]?$/.test(x.texto);
}

// pytest sólo acepta archivos, carpetas o `archivo::prueba`: una palabra suelta que no parece eso es el valor de una
// opción que no está en la lista (`--timeout 30`, `--reruns 2`), no alcance
const pareceRutaPytest = (x) => /[\\/]|\.py\b|::|\s|test/i.test(x.dinamica ? x.fijo : x.texto);

// Las opciones largas que NO llevan valor. Una opción larga que no está acá se lleva la palabra que sigue: si era un
// archivo, el freno frena de más; al revés, el valor de una opción desconocida pasaría por alcance.
const BOOLEANAS_JS = new Set(OPCIONES.js.sinValor);
const BOOLEANAS_PYTEST = new Set(OPCIONES.pytest.sinValor);
const BOOLEANAS_DOTNET = new Set(OPCIONES.dotnet.sinValor);

/** ¿La opción `t` se lleva la palabra que sigue? Las de la lista, y toda larga que no es booleana ni lleva `=`. */
function llevaValor(t, conValor, booleanas, siguiente) {
  if (t.includes('=')) return false;
  if (conValor.includes(t)) return true;
  if (!/^--[A-Za-z]/.test(t) || booleanas.has(t) || /^--no-/.test(t)) return false;
  return siguiente !== undefined && !esOpcion(siguiente.texto);
}

function herramienta(cual, args, ctx, out, seg) {
  const hallazgo = (acotada) => out.push({ tipo: acotada ? 'acotada' : 'suite', comando: seg, escape: ctx.escape });
  if (cual === 'dotnet') {
    for (let i = 0; i < args.length; i++) {
      const x = args[i]; const t = x.texto;
      if (t === '--') break;   // lo que sigue va a la configuración de la corrida, no filtra
      const [o, v] = t.includes('=') && t.startsWith('-') ? [t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)] : [t, null];
      if (FILTRO_DOTNET.includes(o)) {
        const valor = v !== null ? v : (args[i + 1] && !esOpcion(args[i + 1].texto) ? args[++i].texto : '');
        if (valor.trim()) return hallazgo(true);
        continue;
      }
      if (o === '--project') {
        const p = v !== null ? palabra(v) : args[++i];
        if (p && proyectoDotnet(p, ctx)) return hallazgo(true);
        continue;
      }
      if (o === '--list-tests' || o === '-t') return;   // sólo lista
      if (llevaValor(t, VALOR_DOTNET, BOOLEANAS_DOTNET, args[i + 1])) { i++; continue; }
      if (esOpcion(t)) continue;
      if (proyectoDotnet(x, ctx)) return hallazgo(true);
    }
    return hallazgo(false);
  }
  if (cual === 'pytest') {
    for (let i = 0; i < args.length; i++) {
      const t = args[i].texto;
      if (t === '-k') { if (args[i + 1] && args[i + 1].texto.trim()) return hallazgo(true); continue; }
      if (/^-k./.test(t)) return hallazgo(true);
      if (['--version', '--co', '--collect-only', '-h', '--help', '--fixtures', '--markers'].includes(t)) return;
      if (llevaValor(t, VALOR_PYTEST, BOOLEANAS_PYTEST, args[i + 1])) { i++; continue; }
      if (esOpcion(t)) continue;
      if (acotaPosicional(args[i], ctx) && pareceRutaPytest(args[i])) return hallazgo(true);
    }
    return hallazgo(false);
  }
  // vitest, jest y bun test
  let i = 0;
  if (cual === 'vitest' && args[0] && SUBCOMANDOS_VITEST.includes(args[0].texto)) i = 1;
  const acotada = acotadoJs(args.slice(i), ctx, cual === 'jest');
  return acotada === null ? undefined : hallazgo(acotada);
}

const SUBCOMANDOS_VITEST = ['run', 'watch', 'dev', 'related', 'bench', 'list', 'typecheck'];

/**
 * ¿Los argumentos de vitest, jest o bun test (o los que un gestor le pasa al script) acotan? true, false, o null si
 * la corrida sólo lista (`jest --listTests`).
 */
function acotadoJs(args, ctx, esJest) {
  for (let i = 0; i < args.length; i++) {
    const t = args[i].texto;
    if (t === '--') continue;
    if (esJest !== false && t === '--listTests') return null;
    const o = t.includes('=') ? t.slice(0, t.indexOf('=')) : t;
    if (ACOTA_JS.includes(o)) { if (t.includes('=') || (args[i + 1] && !esOpcion(args[i + 1].texto))) return true; continue; }
    if (llevaValor(t, VALOR_JS, BOOLEANAS_JS, args[i + 1])) { i++; continue; }
    if (esOpcion(t)) continue;
    if (acotaPosicional(args[i], ctx)) return true;
  }
  return false;
}

/** Un proyecto de pruebas de dotnet: un .csproj/.fsproj/.vbproj/.dll o una carpeta que se nombra de pruebas. */
function proyectoDotnet(x, ctx) {
  if (ctx.sinPosicionales) return false;
  const t = x.dinamica ? x.fijo : x.texto;
  if (/\.(?:slnx?|slnf)$/i.test(t)) return false;
  if (/\.(?:csproj|fsproj|vbproj|dll|exe)$/i.test(t)) return true;
  if (!/test/i.test(t)) return false;
  return !/^(?:\.[\\/])?tests?[\\/]?$/i.test(t);
}

/** npm, pnpm, yarn y bun como gestores. */
function gestor(prog, args, ctx, out, seg) {
  const VALOR = OPCIONES.gestores.valor;
  let i = 0;
  while (i < args.length && esOpcion(args[i].texto)) i += (VALOR.includes(args[i].texto) ? 2 : 1);
  const sub = args[i] ? args[i].texto : '';
  const resto = args.slice(i + 1);
  // `yarn workspace web test`, `yarn workspaces foreach -A run test`, `yarn workspaces run test`, `pnpm recursive test`:
  // lo que sigue es el comando
  if (prog === 'yarn' && sub === 'workspace') return gestor(prog, resto.slice(1), ctx, out, seg);
  if (prog === 'yarn' && sub === 'workspaces' && resto[0] && resto[0].texto === 'foreach') {
    return gestor(prog, resto.slice(saltarOpciones(resto, 1, ['--include', '--exclude', '-j', '--jobs', '--from', '--since'])), ctx, out, seg);
  }
  if (prog === 'yarn' && sub === 'workspaces' && resto[0] && resto[0].texto === 'run') return gestor(prog, resto, ctx, out, seg);
  if (prog === 'pnpm' && (sub === 'recursive' || sub === 'multi' || sub === 'm')) return gestor(prog, resto, ctx, out, seg);
  if (prog === 'bun' && sub === 'test') return herramienta('bun', resto, ctx, out, seg);
  if (['exec', 'x', 'dlx'].includes(sub)) return programa(resto.slice(saltarOpciones(resto, 0, ['-c', '--package', '-p'])), ctx, out, seg);
  let script = null; let pasados = resto;
  if (['test', 't', 'tst'].includes(sub)) script = 'test';
  else if (['run', 'run-script', 'rum', 'urn'].includes(sub)) {
    const j = saltarOpciones(resto, 0, VALOR);
    script = resto[j] ? resto[j].texto : null;
    pasados = resto.slice(j + 1);
  } else if (prog !== 'npm' && sub) {
    // `pnpm vitest`, `yarn jest`: el gestor corre el binario; `pnpm test:x`, `yarn test` corren el script
    if (['vitest', 'jest', 'pytest'].includes(nombre(sub))) return programa(args.slice(i), ctx, out, seg);
    script = sub;
  }
  if (!script || !/^test(?::|$)/.test(script)) return;
  // el gestor le pasa al script lo que sigue (npm también los argumentos sueltos, sin `--`); un subcomando de vitest
  // adelante (`npm test -- run`) no es alcance
  const lista = pasados.filter((x, k) => !(k === pasados.findIndex((y) => y.texto !== '--') && SUBCOMANDOS_VITEST.includes(x.texto)));
  out.push({ tipo: acotadoJs(lista, ctx, false) ? 'acotada' : 'suite', comando: seg, escape: ctx.escape });
}

/** El veredicto de un comando entero: {veredicto: 'frena'|'escape'|'pasa'|'nada', comando, motivo}. */
function analizar(cmd, opciones = {}) {
  cmd = String(cmd || '');
  // el largo se mira antes que nada: un texto enorme no se recorre, ni siquiera para ver si nombra una herramienta
  if (cmd.length > TOPE) return { veredicto: 'frena', comando: cmd.slice(0, 200), motivo: 'el comando es demasiado largo para leerlo' };
  if (!NOMBRA.test(cmd)) return { veredicto: 'nada' };
  const out = revisar(cmd, { ps: !!opciones.powershell, escape: false, prof: 0, trabajo: { leido: 0 } }, []);
  const malo = out.find((h) => (h.tipo === 'suite' || h.tipo === 'opaco') && !h.escape);
  if (malo) return { veredicto: 'frena', comando: malo.comando, motivo: malo.tipo === 'opaco' ? malo.motivo : '' };
  // con el escape junto a un comando de pruebas (acotado o no) se anota como escape, como siempre
  const conEscape = out.find((h) => h.escape);
  if (conEscape) return { veredicto: 'escape', comando: conEscape.comando };
  if (out.some((h) => h.tipo === 'acotada')) return { veredicto: 'pasa', comando: out[0].comando };
  return { veredicto: 'nada' };
}

module.exports = { analizar, NOMBRA };

if (require.main === module) {
  const cmd = require('fs').readFileSync(0, 'utf8');
  // un error del lector (una forma que rompe el recorrido) frena y lo dice: el guion no cae al corte simple
  let r;
  const herramienta = process.argv[process.argv.indexOf('--tool') + 1] || '';
  try { r = analizar(cmd, { powershell: process.argv.includes('--tool') && herramienta === 'PowerShell' }); } catch (e) {
    r = { veredicto: 'frena', comando: cmd.slice(0, 200), motivo: `el lector falló (${(e && e.message) || e})` };
  }
  const una = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  process.stdout.write(`${r.veredicto}\n${r.motivo ? una(r.comando) + ' — no pude leerlo: ' + r.motivo : una(r.comando)}\n`);
}
