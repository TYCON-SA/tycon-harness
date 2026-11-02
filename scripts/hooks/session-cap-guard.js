#!/usr/bin/env node
'use strict';
/**
 * session-cap-guard.js — freno: con la máquina en el tope de sesiones trabajando, el agente no abre otra de fondo.
 *
 * POR QUÉ EXISTE. El tope (`coordination.max_working`) lo cumplía sólo `coordination.js open`, que se niega en el tope.
 * Una sesión que abre otra con `claude --bg` a mano, o con `claude -p … &`, lo saltea: la máquina se carga de más
 * porque alguien se olvidó del camino correcto. Este freno pone el tope antes del comando, por cualquier camino.
 *
 * QUÉ MIRA. Cada comando de las herramientas `Bash` y `PowerShell` del agente. Primero lee el comando, sin tocar el
 * estado de la máquina: abre una sesión el programa `claude` (también con ruta o `.exe`/`.cmd`) con `--bg`/`--background`,
 * o corriendo de fondo (`run_in_background` de la herramienta, `&` al final —que vale para la tubería o la lista entera,
 * y también adentro de un paréntesis—, `nohup`, `setsid`, `tmux new|new-window|split-window -d`, `screen -dm`, el `start`
 * de cmd; en PowerShell `Start-Process`, `Start-Job`, `Start-ThreadJob`). Lo envuelto se lee por dentro (`env`, también
 * `env -S`, `sudo`, `bash -c`, `pwsh -c`, `cmd /c`, el `&` de PowerShell…). Los subcomandos que no inician una conversación
 * (`attach`, `logs`, `mcp`…) y `claude` en primer plano no abren. Si el programa no se puede leer (`eval`, `xargs`, una
 * variable de afuera) y el texto trae `claude` como palabra de comando, cuenta como que abre.
 *
 * QUÉ HACE. Sólo si el comando abre, cuenta con `capCheck` de scripts/tools/coordination.js, la misma cuenta que `open`.
 * En el tope niega y da el comando de `open`, que espera turno. Si no puede contar, niega igual y nombra lo que no pudo
 * leer: no se abre a ciegas. Debajo del tope deja pasar y anota la sesión en `opened.json` con `noteOpened` (la misma de
 * `open`), para que cuente desde ya; si no la puede anotar, niega. Si el freno mismo falla al decidir, decide una
 * expresión sobre el texto crudo: con `claude` como palabra de comando niega, sin ella deja.
 *
 * QUÉ NO HACE. No mira la terminal de la persona: ahí abre lo que quiera. No tiene interruptor: el tope se cambia con
 * `coordination.max_working`, y subirlo lo decide una persona. No sugiere subirlo.
 *
 * Cada negativa deja una línea en `frenos.jsonl` (scripts/lib/guard-record.js), sin el texto del comando.
 * Salida: exit 2 niega (el comando no corre) · exit 0 deja pasar.
 */
const fs = require('fs');
const path = require('path');

const FRENO = 'session-cap-guard';
const TAG = '[tope-de-sesiones]';
const COORD = path.join(__dirname, '..', 'tools', 'coordination.js');

// Los subcomandos de `claude` que no inician una conversación (los de `claude --help` 2.1.312, y `config`).
const SUBCOMANDOS = new Set(['agents', 'attach', 'auth', 'auto-mode', 'config', 'doctor', 'gateway', 'import', 'install', 'logs',
  'mcp', 'plugin', 'plugins', 'purge', 'respawn', 'rm', 'setup-token', 'stop', 'kill', 'ultrareview', 'update', 'upgrade']);
const SOLO_MIRAN = new Set(['-v', '--version', '-h', '--help']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash', 'fish']);
const POWERSHELLS = new Set(['pwsh', 'powershell']);
// Los que corren el programa que les sigue, con las opciones que llevan un valor; `fondo`: lo dejan corriendo solo.
const PREFIJOS = {
  env: { valor: ['-u', '-C', '-S', '--unset', '--chdir', '--split-string'] },
  command: { valor: [] },
  exec: { valor: ['-a'] },
  builtin: { valor: [] },
  sudo: { valor: ['-u', '-g', '-h', '-C', '-D', '-p', '-r', '-t', '-U', '-T'] },
  doas: { valor: ['-u', '-C'] },
  nice: { valor: ['-n'] },
  time: { valor: ['-f', '-o', '--format', '--output'] },
  stdbuf: { valor: ['-i', '-o', '-e'] },
  ionice: { valor: ['-c', '-n', '-p'] },
  caffeinate: { valor: ['-t', '-w'] },
  unbuffer: { valor: [] },
  nohup: { valor: [], fondo: true },
  setsid: { valor: [], fondo: true },
};
// Corren algo que no se puede leer desde el texto.
const OPACOS = new Set(['eval', 'xargs', 'source', 'parallel', 'iex', 'invoke-expression']);
// Los interruptores de Start-Process (sin valor) y las opciones de Start-Job que llevan un valor.
const INTERRUPTORES_SAPS = /^-(?:nonewwindow|nnw|wait|passthru|usenewenvironment|loaduserprofile|lup|whatif|wi|confirm|cf)$/i;
const OPCIONES_JOB_CON_VALOR = /^-(?:name|initializationscript|init|credential|argumentlist|args|inputobject|psversion|authentication|workingdirectory|throttlelimit|streaminghost|definitionname|definitionpath|type)$/i;
const PROFUNDIDAD = 8;
const TOPE_LECTURAS = 2000;
const TOPE_TEXTO = 256 * 1024;

// El respaldo cuando el lector no puede: `claude` como palabra de comando (al principio, o después de un separador, un
// espacio, una barra, una comilla o una llave), seguida de fin, espacio, comilla o cierre. No usa shell-parse.js, que pudo
// haber tirado.
const RESPALDO = /(?:^|[;&|({\s/"'`])claude(?:\.exe|\.cmd)?(?=$|[\s"'`)}])/im;
const respaldo = (texto) => RESPALDO.test(String(texto || ''));

const nombre = (w) => path.posix.basename(String(w).replace(/\\/g, '/')).toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, '');
const esOpcion = (w) => /^-/.test(w);

let sp = null;
const shell = () => sp || (sp = require('../lib/shell-parse.js'));

/** Una palabra cruda del comando: su texto sin comillas y si depende de algo que sólo se sabe al correr. */
function palabra(raw) {
  const t = shell().tokens(raw);
  return { raw, texto: t.length ? t.join(' ') : '', dinamica: /\$|`/.test(String(raw).replace(/'[^']*'/g, '')) };
}

/** Saltea las opciones de un prefijo; devuelve el índice del programa. */
function saltar(w, i, conValor) {
  while (i < w.length && esOpcion(w[i].texto) && w[i].texto !== '--') i += conValor.includes(w[i].texto) ? 2 : 1;
  if (i < w.length && w[i].texto === '--') i += 1;
  return i;
}

/**
 * ¿Este comando abre una sesión de Claude de fondo? `{ abre, porque, nombre? }`. `herramienta`: `Bash` o `PowerShell`;
 * `deFondo`: la herramienta lo corre de fondo (`run_in_background`).
 */
function abreSesion(comando, { herramienta = 'Bash', deFondo = false } = {}) {
  const texto = String(comando || '');
  if (!/claude/i.test(texto)) return { abre: false, porque: 'no nombra a claude' };
  if (texto.length > TOPE_TEXTO) return respaldo(texto) ? { abre: true, porque: 'el comando es demasiado largo para leerlo' } : { abre: false, porque: 'no nombra a claude como programa' };
  const ctx = { ps: herramienta === 'PowerShell', fondo: deFondo === true, prof: 0, opaco: null, trabajo: { n: 0, c: 0 } };
  const r = leer(texto, ctx);
  if (r) return r;
  if (ctx.opaco && respaldo(texto)) return { abre: true, porque: `no pude leer el programa (${ctx.opaco}) y el texto nombra a claude` };
  return { abre: false, porque: 'no abre una sesión de fondo' };
}

// Los separadores que siguen dentro del mismo trabajo: el `&` del final manda al fondo la tubería o la lista entera.
const UNEN = new Set(['|', '|&', '&&', '||']);
// Un `&` justo antes de `)` o `}`: `(claude -p x &)`. El lector de shell-parse.js no lo conserva, se mira en el texto.
const FONDO_ADENTRO = /(?<![&>|<])&\s*[)}]/;

/** Para cada segmento, si corre de fondo: el `&` que cierra su trabajo vale para todos los segmentos del trabajo. */
function fondos(segs, texto) {
  const adentro = FONDO_ADENTRO.test(texto);
  const out = new Array(segs.length).fill(false);
  let cur = false;
  for (let k = segs.length - 1; k >= 0; k -= 1) {
    const sep = segs[k].sep;
    if (!UNEN.has(sep)) cur = sep === '&' || (sep === ')' && adentro);
    out[k] = cur;
  }
  return out;
}

function leer(texto, ctx) {
  if (ctx.prof > PROFUNDIDAD) { ctx.opaco = ctx.opaco || 'demasiados envoltorios anidados'; return null; }
  // un tope de lecturas por comando: pasado, decide la expresión de respaldo
  if (ctx.trabajo && ((ctx.trabajo.n += 1) > TOPE_LECTURAS || (ctx.trabajo.c += texto.length) > 2 * TOPE_TEXTO)) {
    ctx.opaco = ctx.opaco || 'demasiado para leer';
    return null;
  }
  const s = shell();
  const sin = s.sinHeredocs(texto, { salvoShell: true });
  // en PowerShell, el bloque de `Start-Job { … }` corre de fondo entero, aunque traiga `;` adentro
  if (ctx.ps) {
    const bloques = bloquesDeJob(sin);
    if (bloques.sinCerrar) { ctx.opaco = ctx.opaco || 'un bloque de Start-Job sin cerrar'; return null; }
    for (const bloque of bloques) {
      const sub = { ...ctx, prof: ctx.prof + 1, fondo: true, opaco: null };
      const r = leer(bloque, sub);
      if (sub.opaco) ctx.opaco = ctx.opaco || sub.opaco;
      if (r) return r;
    }
  }
  const segs = s.lex(sin);
  const vars = s.variablesDelComando(sin);
  const deFondo = fondos(segs, sin);
  for (let k = 0; k < segs.length; k += 1) {
    const seg = segs[k].texto.trim();
    if (!seg) continue;
    const c = { ...ctx, vars, fondo: ctx.fondo || deFondo[k] };
    // `echo … | bash`: lo que le llega al shell por la tubería no se lee
    const sig = segs[k + 1] && segs[k + 1].texto.trim();
    if (segs[k].sep === '|' && sig && shellQueLee(sig)) { ctx.opaco = ctx.opaco || 'un shell lee lo que le llega por la tubería'; }
    const p = s.parseSimpleCommand(seg);
    const r = programa(p.words.map(palabra), c, ctx);
    if (r) return r;
    // lo de adentro de `$( … )` y de las comillas invertidas corre aunque vaya entre comillas dobles
    for (const sub of s.substitutions(seg)) {
      const sc = { ...ctx, prof: ctx.prof + 1, fondo: false, opaco: null };
      const rs = leer(sub, sc);
      if (sc.opaco) ctx.opaco = ctx.opaco || sc.opaco;
      if (rs) return rs;
    }
  }
  return null;
}

/** Los bloques `{ … }` de cada `Start-Job`/`Start-ThreadJob`/`sajb` del texto, con las llaves emparejadas. */
function bloquesDeJob(texto) {
  const out = [];
  const re = /(?:^|[;|&({\s])(?:start-job|start-threadjob|sajb)(?=$|[\s{])/gi;
  let m;
  while ((m = re.exec(texto))) {
    let i = m.index + m[0].length;
    // hasta el fin del enunciado: un `;` o un salto de línea fuera de llaves
    while (i < texto.length && texto[i] !== ';' && texto[i] !== '\n') {
      if (texto[i] !== '{') { i += 1; continue; }
      let prof = 0;
      let j = i;
      for (; j < texto.length; j += 1) {
        if (texto[j] === '{') prof += 1;
        else if (texto[j] === '}') { prof -= 1; if (prof === 0) break; }
      }
      // un bloque sin cerrar no es PowerShell válido: no se lee, y decide la expresión de respaldo
      if (j >= texto.length) { out.sinCerrar = true; return out; }
      out.push(texto.slice(i + 1, j));
      i = j + 1;
    }
    // sólo los de primer nivel: un `Start-Job` adentro de un bloque lo lee la lectura de ese bloque. Sin esto, cada
    // bloque anidado se volvía a leer desde cada uno de los de afuera y el trabajo crecía como una potencia.
    re.lastIndex = Math.max(re.lastIndex, i);
  }
  return out;
}

/** `bash`, `sh -s`, sin `-c` ni archivo: lee los comandos de la entrada. */
function shellQueLee(seg) {
  const w = shell().parseSimpleCommand(seg).words.map((x) => palabra(x).texto);
  return w.length > 0 && SHELLS.has(nombre(w[0])) && w.slice(1).every((x) => esOpcion(x) && !/^-[a-z]*c[a-z]*$/i.test(x));
}

/** Desde la palabra que es el programa. `raiz` junta lo que no se pudo leer. */
function programa(w, ctx, raiz) {
  if (!w.length) return null;
  const adentro = (texto, extra = {}) => {
    const sub = { ...ctx, ...extra, prof: ctx.prof + 1, opaco: null };
    const r = leer(texto, sub);
    if (sub.opaco) raiz.opaco = raiz.opaco || sub.opaco;
    return r;
  };
  // en PowerShell, `& prog` y `. prog` llaman al programa
  if (ctx.ps && (w[0].texto === '&' || w[0].texto === '.')) return programa(w.slice(1), ctx, raiz);
  // en PowerShell, `$x = prog …` asigna lo que devuelve `prog`: el programa va después del `=`
  if (ctx.ps) {
    const asig = /^\$[\w:]+([+\-*/]?=)(.*)$/s.exec(w[0].raw);
    if (asig) return asig[2] ? programa([palabra(asig[2]), ...w.slice(1)], ctx, raiz) : programa(w.slice(1), ctx, raiz);
    if (/^\$[\w:]+$/.test(w[0].raw) && w[1] && /^[+\-*/]?=$/.test(w[1].texto)) return programa(w.slice(2), ctx, raiz);
  }
  let prog;
  if (w[0].dinamica) {
    const e = shell().expandir(w[0].raw, ctx.vars || {});
    if (e == null) { raiz.opaco = raiz.opaco || 'el programa es una variable de afuera'; return null; }
    const partes = shell().tokens(e);
    if (!partes.length) return null;
    return programa([...partes.map((x) => ({ raw: x, texto: x, dinamica: false })), ...w.slice(1)], ctx, raiz);
  }
  prog = nombre(w[0].texto);
  const resto = w.slice(1);
  const textos = resto.map((x) => x.texto);

  if (prog === 'claude') return claude(textos, ctx);
  if (OPACOS.has(prog)) { raiz.opaco = raiz.opaco || `\`${prog}\` corre algo que no se lee desde el texto`; return null; }
  if (prog === 'command' && textos.some((x) => /^-[vV]$/.test(x))) return null;   // `command -v x` sólo busca
  if (prog === 'env') {
    // `env -S "claude --bg"`: el valor de -S es el comando, partido en palabras
    for (let i = 0; i < textos.length && esOpcion(textos[i]) && textos[i] !== '--'; i += 1) {
      const pegado = /^(?:-S|--split-string=)(.+)$/s.exec(textos[i]);
      if (pegado) return adentro([pegado[1], ...textos.slice(i + 1)].join(' '));
      if (textos[i] === '-S' || textos[i] === '--split-string') return adentro(textos.slice(i + 1).join(' '));
      if (PREFIJOS.env.valor.includes(textos[i])) i += 1;
    }
  }
  if (Object.prototype.hasOwnProperty.call(PREFIJOS, prog)) {
    const def = PREFIJOS[prog];
    let i = saltar(resto, 0, def.valor);
    // `env A=1 claude`, `sudo A=1 claude`: asignaciones antes del programa
    while (i < resto.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(resto[i].texto)) i += 1;
    return programa(resto.slice(i), def.fondo ? { ...ctx, fondo: true } : ctx, raiz);
  }
  if (prog === 'timeout') {
    const i = saltar(resto, 0, ['-s', '-k', '--signal', '--kill-after']);
    return programa(resto.slice(i + 1), ctx, raiz);
  }
  if (SHELLS.has(prog)) {
    const ci = textos.findIndex((x) => /^-[a-z]*c[a-z]*$/i.test(x));
    if (ci >= 0 && ci + 1 < textos.length) return adentro(textos[ci + 1], { ps: false });
    return null;
  }
  if (POWERSHELLS.has(prog)) {
    const ci = textos.findIndex((x) => /^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i.test(x));
    if (ci >= 0 && ci + 1 < textos.length) return adentro(textos.slice(ci + 1).join(' '), { ps: true });
    if (textos.some((x) => /^-e(?:nc|ncodedcommand)?$/i.test(x))) raiz.opaco = raiz.opaco || 'PowerShell con un comando codificado';
    return null;
  }
  if (prog === 'cmd') {
    const ci = textos.findIndex((x) => /^\/[ck]$/i.test(x));
    if (ci >= 0 && ci + 1 < textos.length) return adentro(textos.slice(ci + 1).join(' '), { ps: false, cmd: true });
    return null;
  }
  // `start [/b] ["título"] claude …` de cmd deja el programa corriendo solo
  if (prog === 'start' && ctx.cmd && !ctx.ps) {
    const args = textos.filter((x) => !/^\//.test(x));
    return args.slice(0, 2).some((x) => nombre(x) === 'claude') ? { abre: true, porque: 'start de cmd lo deja corriendo de fondo', nombre: nombreDe(textos) } : null;
  }
  if (prog === 'tmux') {
    // `new`, `new-session`, `new-window`, `split-window` (y sus atajos) con `-d` dejan el programa corriendo solo
    const sub = textos.findIndex((x) => /^(?:new(?:-session)?|new-window|neww|split-window|splitw)$/.test(x));
    if (sub < 0) return null;
    const ops = textos.slice(sub + 1);
    let i = 0;
    let suelta = false;
    while (i < ops.length && esOpcion(ops[i]) && ops[i] !== '--') {
      const letras = ops[i].replace(/^-/, '');
      if (/^[A-Za-z]+$/.test(letras) && letras.includes('d')) suelta = true;
      // las opciones juntas (`-ds nombre`): si la última lleva valor, el valor es la palabra siguiente
      i += /^[A-Za-z]*[scntxyeFflp]$/.test(letras) ? 2 : 1;
    }
    if (!suelta) return null;
    if (i < ops.length && ops[i] === '--') i += 1;
    return i < ops.length ? adentro(ops.slice(i).join(' '), { ps: false, fondo: true }) : null;
  }
  if (prog === 'screen') {
    const ops = resto;
    let i = 0;
    let d = false;
    let m = false;
    while (i < ops.length && esOpcion(ops[i].texto) && ops[i].texto !== '--') {
      const t = ops[i].texto;
      // `-Logfile <archivo>` lleva valor; las demás van juntas (`-dmS nombre`) o sueltas (`-d -m -S nombre`)
      if (/^-Logfile$/.test(t)) { i += 2; continue; }
      const letras = t.replace(/^-/, '');
      if (/^[A-Za-z]+$/.test(letras)) {
        if (letras.includes('d') || letras.includes('D')) d = true;
        if (letras.includes('m')) m = true;
      }
      i += /^[A-Za-z]*[StchpTX]$/.test(letras) ? 2 : 1;
    }
    if (i < ops.length && ops[i].texto === '--') i += 1;
    return d && m ? programa(ops.slice(i), { ...ctx, fondo: true }, raiz) : null;
  }
  if (ctx.ps) {
    // `Start-Process claude -ArgumentList '--bg'`: deja el programa corriendo solo
    if (prog === 'start-process' || prog === 'saps' || prog === 'start') {
      let destino = null;
      for (let i = 0; i < textos.length; i += 1) {
        if (/^-(?:filepath|file|f)$/i.test(textos[i])) { destino = textos[i + 1]; break; }
        if (!esOpcion(textos[i])) { destino = textos[i]; break; }
        // los interruptores no llevan valor: la palabra siguiente puede ser el destino
        if (!INTERRUPTORES_SAPS.test(textos[i])) i += 1;
      }
      if (destino == null) return null;
      if (resto.some((x) => x.dinamica) && !/claude/i.test(destino)) { raiz.opaco = raiz.opaco || 'Start-Process con un destino variable'; return null; }
      return nombre(destino) === 'claude' ? { abre: true, porque: 'Start-Process lo deja corriendo de fondo', nombre: nombreDe(textos) } : null;
    }
    if (prog === 'start-job' || prog === 'start-threadjob') {
      if (textos.some((x) => /^-filepath$/i.test(x))) { raiz.opaco = raiz.opaco || `${prog} con un archivo`; return null; }
      // el cuerpo, sin las opciones ni sus valores (`-Name a`); los bloques `{ … }` ya los leyó `leer`
      const partes = [];
      for (let i = 0; i < textos.length; i += 1) {
        if (/^-scriptblock$/i.test(textos[i])) continue;
        if (esOpcion(textos[i])) { if (OPCIONES_JOB_CON_VALOR.test(textos[i])) i += 1; continue; }
        partes.push(textos[i]);
      }
      // un bloque `{ … }` ya lo leyó `leer` con las llaves emparejadas: leerlo otra vez desde acá duplicaba el trabajo
      // en cada nivel de anidamiento
      if (partes.some((x) => x.includes('{'))) return null;
      const cuerpo = partes.join(' ');
      return cuerpo.trim() ? adentro(cuerpo, { ps: true, fondo: true }) : null;
    }
  }
  return null;
}

/** `-n <nombre>` / `--name <nombre>` / `--name=<nombre>`, antes de `--`. */
function nombreDe(args) {
  for (let i = 0; i < args.length && args[i] !== '--'; i += 1) {
    if ((args[i] === '-n' || args[i] === '--name') && args[i + 1]) return args[i + 1];
    const m = /^--name=(.+)$/.exec(args[i]);
    if (m) return m[1];
  }
  return null;
}

function claude(args, ctx) {
  const corte = args.indexOf('--');
  const opciones = corte >= 0 ? args.slice(0, corte) : args;
  if (opciones.length && SUBCOMANDOS.has(opciones[0])) return null;
  if (opciones.some((x) => SOLO_MIRAN.has(x))) return null;
  if (opciones.some((x) => x === '--bg' || x === '--background')) return { abre: true, porque: 'lleva --bg', nombre: nombreDe(args) };
  if (ctx.fondo) return { abre: true, porque: 'corre de fondo', nombre: nombreDe(args) };
  return null;
}

// ── La decisión ──

const shQuote = (s) => (/^[\w@%+=:,./\\-]+$/.test(s) ? s : `"${String(s).replace(/[\\"$`]/g, '\\$&')}"`);
const hhmmss = (ms) => { const d = new Date(ms); return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(''); };
const NOMBRE_OK = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function comandoOpen(nombreSesion, cwd) {
  return `node ${shQuote(path.resolve(COORD))} open --name ${nombreSesion && NOMBRE_OK.test(nombreSesion) ? nombreSesion : '<nombre>'} --cwd ${cwd ? shQuote(cwd) : '<carpeta>'} -- <encargo>`;
}

/**
 * Lo que el freno decide para un evento de PreToolUse: `{ deny, motivo?, message? }`. `lector` reemplaza a `abreSesion`
 * en las pruebas.
 */
function decidir(evento, opts = {}) {
  const ti = (evento && evento.tool_input) || {};
  const comando = typeof ti.command === 'string' ? ti.command : '';
  const herramienta = evento && evento.tool_name;
  if (!['Bash', 'PowerShell'].includes(herramienta) || !/claude/i.test(comando)) return { deny: false };
  const niega = (motivo, message) => ({ deny: true, motivo, message });
  try {
    const lectura = (opts.lector || abreSesion)(comando, { herramienta, deFondo: ti.run_in_background === true });
    if (!lectura || !lectura.abre) return { deny: false };
    const cwd = typeof evento.cwd === 'string' && evento.cwd ? evento.cwd : null;
    const C = require(COORD);
    const now = opts.now == null ? Date.now() : Number(opts.now);
    const base = { home: opts.home || require('os').homedir(), env: opts.env || process.env, now };
    let c;
    try { c = C.capCheck(base); } catch (e) { c = { problems: [`el estado de la máquina (${String((e && e.message) || e).split('\n')[0]})`] }; }
    const salida = `La persona puede abrirla desde su terminal. Para el agente, el camino es: ${comandoOpen(lectura.nombre, cwd)}`;
    if (c.problems && c.problems.length) {
      return niega('no-pude-contar', `No abro otra sesión de fondo: no pude contar las sesiones de la máquina (no pude leer ${c.problems.join(' · ')}). Sin contarlas no se abre a ciegas, igual que con coordination.js open. ${salida}, o arreglá lo que no se pudo leer.`);
    }
    if (c.atCap) {
      const nombres = c.working.map((w) => w.session).join(', ');
      return niega('en-el-tope', `No abro otra sesión de fondo: la máquina está en el tope (${c.working.length} de ${c.cap.value} trabajando: ${nombres}). El tope es ${c.cap.value} (${C.ORIGIN[c.cap.origin] || c.cap.origin}). Cuando haya lugar, abrila con el camino que espera su turno:\n  ${comandoOpen(lectura.nombre, cwd)}\n(o --repo <repo> en vez de --cwd, para un puesto fijo del repo).`);
    }
    // Debajo del tope pasa, y cuenta desde ya: dos aperturas seguidas no pasan el tope.
    const nombreSesion = lectura.nombre && NOMBRE_OK.test(lectura.nombre) ? lectura.nombre : `sin-nombre-${hhmmss(now)}${String(now % 1000).padStart(3, '0')}`;
    try { C.noteOpened({ home: base.home, now, name: nombreSesion, cwd: cwd || '' }); } catch (e) {
      return niega('no-pude-contar', `No abro otra sesión de fondo: no la pude anotar en ${path.join(C.coordinationDir(base.home), 'opened.json')} (${(e && (e.code || e.message)) || e}), y sin anotarla no contaría para el tope. ${salida}, o arreglá ese archivo.`);
    }
    return { deny: false, noted: nombreSesion };
  } catch (e) {
    if (!respaldo(comando)) return { deny: false };
    return niega('no-pude-decidir', `No abro otra sesión de fondo: no pude decidir si este comando abre una (${String((e && e.message) || e).split('\n')[0].slice(0, 120)}) y nombra a claude como programa: freno en la duda. La persona puede abrirla desde su terminal. Para el agente, el camino es: ${comandoOpen(null, null)}`);
  }
}

function anotarNegativa(motivo, comando) {
  try { require('../lib/guard-record.js').anotar({ freno: FRENO, regla: 'tope', veredicto: 'bloqueo', motivo, cmd: comando }); } catch { /* la constancia es ayuda, no evidencia */ }
}

function main() {
  // Se lee la entrada antes de decidir nada: salir sin drenarla rompe la tubería de quien escribe.
  let payload = '';
  try { payload = fs.readFileSync(0, 'utf8'); } catch { return 0; }
  let evento;
  try { evento = JSON.parse(payload || '{}'); } catch { evento = undefined; }
  // una entrada que no es un objeto (`null`, un número, una lista) tampoco se puede leer
  if (!evento || typeof evento !== 'object' || Array.isArray(evento)) {
    if (!respaldo(payload)) return 0;
    const message = `No abro otra sesión de fondo: no pude leer la entrada del freno y nombra a claude como programa: freno en la duda. ${comandoOpen(null, null)}`;
    anotarNegativa('no-pude-decidir', payload);
    process.stderr.write(`${TAG} ${message}\n`);
    return 2;
  }
  if (evento.hook_event_name && evento.hook_event_name !== 'PreToolUse') return 0;
  const d = decidir(evento);
  if (!d.deny) return 0;
  anotarNegativa(d.motivo, (evento.tool_input || {}).command);
  process.stderr.write(`🔴 ${TAG} ${d.message}\n`);
  return 2;
}

if (require.main === module) process.exitCode = main();

module.exports = { abreSesion, decidir, respaldo, SUBCOMANDOS };
