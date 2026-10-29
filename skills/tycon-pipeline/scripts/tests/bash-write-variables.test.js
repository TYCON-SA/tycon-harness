#!/usr/bin/env node
'use strict';
/**
 * bash-write-variables.test.js — variables del comando en la puerta de la consola (T5-T9).
 *
 * QUÉ CUIDA: que la puerta de la consola (`on-bash-write-gate.js`) lea las variables del propio comando antes de decidir
 * dónde escribe. Caso real de un producto del equipo: `SP=<scratchpad>; python3 -c "open('$SP/x.cs','w')"` sale
 * frenado como «EDICIÓN INVISIBLE»: el freno arma `<repo>/$SP/x.cs` sin expandir y lo cuenta como código del repo de la
 * corrida. Y el escape del dev (`TYCON_LEDGER_VISIBLE=off`) promete una constancia en gates.log, y esa constancia tiene que escribirse.
 *
 * Las variables las expande `lib/command-vars.js` (un lector propio de la skill:
 * el compartido `scripts/lib/shell-parse.js` da rutas falsas para esto — ver su cabecera).
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/bash-write-variables.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPTS = path.join(__dirname, '..');
const bash = require(path.join(SCRIPTS, 'on-bash-write-gate.js'));

const SID = 'sesion-725';

function corral() {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vars-725-')));
  const estado = path.join(raiz, 'estado');
  const repo = path.join(raiz, 'repo');
  const scratch = path.join(raiz, 'scratchpad');
  for (const d of [estado, path.join(repo, 'src'), scratch]) fs.mkdirSync(d, { recursive: true });
  // corrida abierta con el plan aprobado: el carril deja editar, el registro visible exige Edit/Write
  fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
  fs.writeFileSync(path.join(estado, 'active', `${SID}.json`), JSON.stringify({
    storyId: '9.9', repoPath: repo, sessionId: SID, stepsCompleted: [0, 1, 2, 3], stepsPending: [4, 5, 6, 7, 8],
  }));
  return { raiz, estado, repo, scratch };
}

function conEnv(vars, fn) {
  const antes = {};
  for (const k of Object.keys(vars)) { antes[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k]; }
  }
}

const ENV = { TYCON_LEDGER_VISIBLE: undefined, TYCON_STORY_GATE: undefined, TYCON_NO_RUN_CHANGE: '1', NADIE: undefined };
const ev = (command, cwd) => ({ tool_name: 'Bash', session_id: SID, cwd, tool_input: { command } });

test('T5 BashWrite_VariableDefinidaEnElComando_Resuelve — VAR=, ${VAR} y export', () => {
  const { repo } = corral();
  conEnv(ENV, () => {
    const casos = [
      [`SP=/tmp/x; python3 -c "open('$SP/a.cs','w').write('1')"`, '/tmp/x/a.cs'],
      [`SP=/tmp/x && cat > "\${SP}/b.cs" <<'EOF'\nint b;\nEOF`, '/tmp/x/b.cs'],
      [`export SP=/tmp/y; cp src/a.cs $SP/c.cs`, '/tmp/y/c.cs'],
    ];
    for (const [cmd, esperado] of casos) {
      const r = bash.destinosResueltos(cmd, repo);
      assert.deepEqual(r.map((d) => d.abs), [esperado], `comando: ${cmd}`);
      assert.deepEqual(r[0].sinResolver, [], `nada sin resolver en: ${cmd}`);
    }
  });
});

test('T6 BashWrite_ScratchpadConPipelineAbierto_NoFrena', () => {
  const { estado, repo, scratch } = corral();
  conEnv(ENV, () => {
    const r = bash.handle(ev(`SP=${scratch}; python3 -c "open('$SP/servicetests-head.cs','w').write('x')"`, repo), { stateDir: estado });
    assert.equal(r, null, `el scratchpad no es código del repo de la corrida: ${r && r.block}`);
  });
});

test('T7 BashWrite_VariableAlRepoConPipelineAbierto_Frena — expandir no abre un hueco', () => {
  const { estado, repo } = corral();
  conEnv(ENV, () => {
    const r = bash.handle(ev(`R=${repo}; cat > $R/src/x.cs <<'EOF'\nint x;\nEOF`, repo), { stateDir: estado });
    assert.ok(r && r.block, 'una escritura al repo por variable sigue siendo invisible para el registro');
    assert.match(r.block, /EDICIÓN INVISIBLE/);
    assert.match(r.block, new RegExp(`${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/src/x\\.cs`));
  });
});

test('T8 BashWrite_VariableSinDefinir_FrenaYLoDice', () => {
  const { estado, repo } = corral();
  conEnv(ENV, () => {
    const r = bash.handle(ev(`cat > $NADIE/src/x.cs <<'EOF'\nint x;\nEOF`, repo), { stateDir: estado });
    assert.ok(r && r.block, 'sin saber adónde va, se frena del lado seguro');
    assert.match(r.block, /\$NADIE/, 'nombra la variable');
    assert.match(r.block, /sin resolver/i, 'y dice que no se pudo resolver');
    // Si la variable es el nombre entero o la extensión, tampoco se sabe si es código
    for (const cmd of ['cat > $NADIE <<EOF\nx\nEOF', 'cat > src/x.$NADIE <<EOF\nx\nEOF']) {
      const b = bash.handle(ev(cmd, repo), { stateDir: estado });
      assert.ok(b && b.block, `frena: ${cmd}`);
    }
  });
});

test('T9 BashWrite_EscapeDelDev_DejaConstancia — el escape pasa y queda en gates.log', () => {
  const { estado, repo } = corral();
  conEnv({ ...ENV, TYCON_LEDGER_VISIBLE: 'off' }, () => {
    const r = bash.handle(ev(`cat > src/y.cs <<'EOF'\nint y;\nEOF`, repo), { stateDir: estado });
    assert.equal(r, null, 'el escape del dev deja pasar');
  });
  const log = path.join(estado, 'gates.log');
  assert.ok(fs.existsSync(log), 'gates.log tiene que existir');
  const lineas = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const esc = lineas.find((l) => l.name === 'ledger-visible' && l.status === 'escaped');
  assert.ok(esc, `falta la línea escaped: ${JSON.stringify(lineas)}`);
  assert.ok((esc.paths || []).some((p) => p.endsWith('/src/y.cs')), 'con el archivo que pasó');
});

// T19 — casos límite. Expandir con el lector compartido (`shell-parse.js`) no sirve: está hecho para otro freno,
// guarda sólo la ÚLTIMA asignación, no mira el ambiente y toma `$(mktemp -d)` como texto. El lector propio tiene
// que resolver como el shell o, si no puede, decir que no pudo (nunca una ruta inventada).
test('T19 BashWrite_CasosDelPaseAdversarial_ResuelveComoElShellONoResuelve', () => {
  const home = os.homedir();
  conEnv({ ...ENV, SP: '/tmp/out', REPO: undefined, TMPDIR: '/tmp/zz' }, () => {
    const uno = (cmd) => { const r = bash.destinosResueltos(cmd, '/repo'); assert.equal(r.length, 1, cmd); return r[0]; };
    // sustitución de comando: no se sabe el valor → sin resolver, adentro del repo (lado seguro) y avisado
    for (const cmd of ['SP=$(mktemp -d); echo hi > "$SP/x.cs"', 'SP=`mktemp -d`; echo hi > $SP/x.cs', 'SP="$(mktemp -d)"/sub; echo hi > $SP/x.cs']) {
      const d = uno(cmd);
      assert.deepEqual(d.sinResolver, ['SP'], `sin resolver en: ${cmd} → ${JSON.stringify(d)}`);
      assert.ok(d.abs.startsWith('/repo/'), `del lado seguro: ${d.abs}`);
    }
    // una asignación que no se resuelve NO cae al valor viejo del ambiente (SP=/tmp/out)
    assert.deepEqual(uno('SP=$REPO/src; cat > $SP/a.cs').sinResolver, ['SP']);
    // armada desde el ambiente: $HOME y $TMPDIR se resuelven
    assert.equal(uno('D=$HOME/x; echo hi > $D/a.cs').abs, path.join(home, 'x', 'a.cs'));
    assert.equal(uno('T=$TMPDIR/w; echo hi > $T/a.cs').abs, '/tmp/zz/w/a.cs');
    // ${VAR:-x}, ${VAR%…}: no se interpreta → sin resolver, nunca una ruta corrupta
    for (const cmd of ['SP=/tmp/x; echo hi > "${SP:-/z}/a.cs"', 'R=/repo; echo hi > ${R%/}/src/a.cs']) {
      const d = uno(cmd);
      assert.equal(d.sinResolver.length, 1, `${cmd} → ${JSON.stringify(d)}`);
      assert.ok(d.abs.startsWith('/repo/'), `del lado seguro: ${d.abs}`);
    }
    // reasignación: cada destino con el valor que la variable tenía EN ESE PUNTO del comando
    const dos = bash.destinosResueltos('SP=/tmp/a; echo 1 > $SP/1.cs; SP=/repo/src; echo 2 > $SP/2.cs', '/repo');
    assert.deepEqual(dos.map((d) => d.abs), ['/tmp/a/1.cs', '/repo/src/2.cs']);
    // el MISMO destino escrito dos veces con la variable reasignada en el medio: no se sabe cuál
    // de los dos valores mirar → sin resolver, del lado seguro (tomar el primero dejaría pasar el que cae en el repo)
    const rep = bash.destinosResueltos('SP=/tmp/a; echo 1 > $SP/x.cs; SP=/repo; echo 2 > $SP/x.cs', '/repo');
    assert.equal(rep.length, 1, 'un destino (el texto es el mismo)');
    assert.deepEqual(rep[0].sinResolver, ['SP'], JSON.stringify(rep));
    assert.ok(rep[0].abs.startsWith('/repo/'), rep[0].abs);
  });
});

// T24 — sólo cuenta una asignación que el shell de verdad deja puesta.
// Lo que está entre comillas o en el cuerpo de un heredoc es texto; un `VAR=x cmd` vale sólo para ese comando; en un
// subshell, después de `||` o dentro de un `then`/`else`/`do` puede no haber pasado. Esos casos son «no sé», nunca un valor.
test('T24 BashWrite_SoloCuentanLasAsignacionesQueQuedanPuestas', () => {
  conEnv({ ...ENV, SP: '/repo' }, () => {
    const uno = (cmd) => { const r = bash.destinosResueltos(cmd, '/repo'); assert.equal(r.length, 1, cmd); return r[0]; };
    // entre comillas y en un heredoc: texto, no asignación → vale el ambiente (SP=/repo)
    assert.equal(uno('echo "SP=/tmp/x"; cat > $SP/a.cs').abs, '/repo/a.cs');
    const conHeredoc = bash.destinosResueltos("cat > /tmp/nota.txt <<'EOF'\nSP=/tmp/x\nEOF\ncp a.cs $SP/a.cs", '/repo');
    assert.equal(conHeredoc.find((d) => d.raw === '$SP/a.cs').abs, '/repo/a.cs');
    // prefijo, subshell, después de ||, dentro de then: no se sabe si quedó puesta → sin resolver
    for (const cmd of ['SP=/tmp/x make; cat > $SP/a.cs', '(SP=/tmp/x); cat > $SP/a.cs', 'false || SP=/tmp/x; cat > $SP/a.cs',
      'if true; then SP=/tmp/x; fi; cat > $SP/a.cs']) {
      assert.deepEqual(uno(cmd).sinResolver, ['SP'], cmd);
    }
    // el texto del destino aparece antes como lectura y después como escritura, con la variable reasignada
    assert.deepEqual(uno('SP=/tmp/x; echo $SP/a.cs; SP=/repo; cat > $SP/a.cs').sinResolver, ['SP']);
  });
  // y no se vuelve lento con un heredoc enorme
  const grande = `SP=/tmp/x; cat > $SP/a.cs <<'EOF'\n${'linea con  espacios\n'.repeat(20000)}EOF`;
  const t0 = Date.now();
  bash.destinosResueltos(grande, '/repo');
  assert.ok(Date.now() - t0 < 1000, `tardó ${Date.now() - t0} ms`);
});

// T26 — el lector es CONSERVADOR. Una asignación cuenta sólo si seguro quedó puesta
// en el shell de la sesión; ante cualquier forma que no sabe leer del todo, «no sé» (frena avisando). Y nunca tira: un
// error adentro del freno es un freno apagado (el hook falla abierto).
test('T26 BashWrite_LectorConservador_NoSeAnteLoQueNoLeeDelTodo', () => {
  conEnv({ ...ENV, SP: '/repo' }, () => {
    const uno = (cmd) => { const r = bash.destinosResueltos(cmd, '/repo'); return r.find((d) => /\$/.test(d.raw)); };
    for (const cmd of [
      'true && SP=/tmp/x; cat > $SP/a.cs',          // condicional
      'echo hola | SP=/tmp/x; cat > $SP/a.cs',      // del lado de un caño: subshell
      'SP=/tmp/x & cat > $SP/a.cs',                 // en segundo plano: subshell
      'f() { SP=/tmp/x; }; cat > $SP/a.cs',         // cuerpo de función: no corre al definirla
      'echo \\"; SP=/tmp/x; cat > $SP/a.cs',        // comilla escapada
      "# it's\nSP=/tmp/x; cat > $SP/a.cs",          // comentario con apóstrofe
    ]) {
      assert.deepEqual(uno(cmd).sinResolver, ['SP'], cmd);
    }
    // lo de siempre sigue andando
    assert.equal(uno('SP=/tmp/x; cat > $SP/a.cs').abs, '/tmp/x/a.cs');
    assert.equal(uno('SP=/tmp/x\ncat > $SP/a.cs').abs, '/tmp/x/a.cs');
  });
  // entradas hostiles: ni se cuelga ni tira
  const cadena = Array.from({ length: 5000 }, (_, i) => (i ? `A${i}=$A${i - 1}` : 'A0=/tmp')).join('; ') + '; cat > $A4999/x.cs';
  const aperturas = 'cat <<X1\n'.repeat(5000) + 'SP=/tmp/x; cat > $SP/a.cs';
  for (const cmd of [cadena, aperturas]) {
    const t0 = Date.now();
    assert.doesNotThrow(() => bash.destinosResueltos(cmd, '/repo'));
    assert.ok(Date.now() - t0 < 1500, `tardó ${Date.now() - t0} ms`);
  }
});

// T28 — imitar al shell no converge; el lector entiende una forma SIMPLE y todo lo
// demás es «no sé». Cada caso de abajo resolvería afuera un destino que el shell escribe adentro.
test('T28 BashWrite_SoloLaFormaSimple_TodoLoDemasNoSe', () => {
  conEnv({ ...ENV, SP: '/tmp/viejo', PWD: '/otra' }, () => {
    const uno = (cmd) => bash.destinosResueltos(cmd, '/repo').find((d) => /\$/.test(d.raw));
    for (const cmd of [
      'cat <<< x; SP=/repo; cat > $SP/a.cs',                 // here-string
      'echo "a << b"; SP=/repo; cat > $SP/a.cs',              // << entre comillas
      'echo $((1 << 2)); SP=/repo; cat > $SP/a.cs',           // aritmética
      'true && { echo; SP=/tmp/y; }; cat > $SP/a.cs',         // llaves
      'declare SP=/repo; cat > $SP/a.cs',                     // declare / local / readonly / typeset
      'read SP < f; cat > $SP/a.cs',                          // read
      'eval "SP=/repo"; cat > $SP/a.cs',                      // eval
      'SP+=/x; cat > $SP/a.cs',                               // +=
      'printf -v SP /repo; cat > $SP/a.cs',                   // printf -v
      'source ./vars.sh; cat > $SP/a.cs',                     // source
    ]) {
      assert.ok(uno(cmd).sinResolver.length > 0, `${cmd} → ${JSON.stringify(uno(cmd))}`);
    }
    // comillas simples: literal en el shell — ni el valor ni el destino se expanden
    assert.ok(uno("SP='$HOME/x'; cat > $SP/a.cs").sinResolver.length > 0, 'valor entre comillas simples');
    assert.ok(uno("SP=/tmp/x; cat > '$SP/a.cs'").sinResolver.length > 0, 'destino entre comillas simples');
    // $PWD / $OLDPWD los mantiene el shell, no el ambiente del freno
    assert.deepEqual(uno('cat > $PWD/src/x.cs').sinResolver, ['PWD']);
    // lo simple sigue andando
    assert.equal(uno('SP=/tmp/x; cat > $SP/a.cs').abs, '/tmp/x/a.cs');
    assert.equal(uno('SP="/tmp/x y"; cat > "$SP/a.cs"').abs, '/tmp/x y/a.cs');
  });
});

// T29 — `for`/`select`/`case` y las variables posiciones o especiales (`$1`, `$@`,
// `$$`) son «no sé»; y lo que está ADENTRO de comillas no dispara las reglas de forma (un caso típico
// escribe con `python3 -c "…f.close()"`, y `f.close()` no es una función de shell).
test('T29 BashWrite_BuclesPosicionalesYLoQueEstaEntreComillas', () => {
  conEnv({ ...ENV, SP: '/tmp/viejo' }, () => {
    const uno = (cmd) => bash.destinosResueltos(cmd, '/repo').find((d) => /\$/.test(d.raw));
    for (const cmd of [
      'SP=/tmp/x; for SP in /repo/src; do cat > $SP/a.cs; done',
      'SP=/tmp/x; case y in y) SP=/repo;; esac; cat > $SP/a.cs',
      'set -- /repo/src; cat > $1/x.cs',
      'cat > ${1}/x.cs',
      'cat > $@/x.cs',
    ]) {
      assert.ok(uno(cmd).sinResolver.length > 0, `${cmd} → ${JSON.stringify(uno(cmd))}`);
    }
    const py = 'SP=/tmp/scratch; python3 -c "f=open(\'$SP/x.cs\',\'w\'); f.write(\'x\'); f.close()"';
    assert.equal(uno(py).abs, '/tmp/scratch/x.cs', 'el caso original: el destino al scratchpad se resuelve');
    // Dos formas que asignan en el shell actual aunque vayan entre comillas dobles
    for (const cmd of ['echo "$((SP=3))"; cat > $SP/a.cs', 'echo ${SP:=/repo/src}; cat > $SP/a.cs']) {
      assert.ok(uno(cmd).sinResolver.length > 0, `${cmd} → ${JSON.stringify(uno(cmd))}`);
    }
  });
});

// T31 — un destino de código con una variable sin resolver frena aunque la
// sesión esté parada FUERA del repo de la corrida — no se sabe adónde va, así que no puede pasar callado.
test('T31 BashWrite_SinResolverDesdeOtraCarpeta_FrenaIgual', () => {
  const { estado, raiz } = corral();
  conEnv(ENV, () => {
    const r = bash.handle(ev('R=$(git rev-parse --show-toplevel); cat > $R/src/x.cs <<EOF\nx\nEOF', raiz), { stateDir: estado });
    assert.ok(r && r.block, 'frena: el destino puede caer en el repo de la corrida');
    assert.match(r.block, /sin resolver/);
  });
});

// T32 — un destino sin resolver con una extensión LITERAL que no es código (`$OUT/notes.md`)
// sigue pasando sin fricción; y cuando un destino dudoso pasa (sin corrida abierta), no suma al cupo del carril ad-hoc
// pero deja constancia en gates.log (`unresolved-passed`).
test('T32 BashWrite_SinResolverQueNoEsCodigoYConstancia', () => {
  const { estado, repo } = corral();
  conEnv(ENV, () => {
    assert.equal(bash.handle(ev('cat > $OUT/notes.md <<EOF\nx\nEOF', repo), { stateDir: estado }), null, 'un .md pasa');
  });
  // sin corrida abierta y con un carril ad-hoc declarado
  const { estado: e2, repo: r2 } = corral();
  fs.rmSync(path.join(e2, 'active', `${SID}.json`));
  const io = require(path.join(SCRIPTS, 'lib', 'story-gate-io.js'));
  // la declaración como la deja `marker.js adhoc set`: con la hora de la firma y su renglón en gates.log
  const firma = new Date(Date.now() - 1000);
  fs.appendFileSync(path.join(e2, 'gates.log'), `${JSON.stringify({ ts: firma.toISOString(), name: 'adhoc-lane-signed', status: 'ok', via: 'ventana', sesion: SID, destino: SID })}\n`);
  io.writeAdhoc(e2, SID, { reason: 'prueba', files: [], startedAt: new Date().toISOString(), firmadaEn: new Date(firma.getTime() + 500).toISOString() });
  conEnv(ENV, () => {
    assert.equal(bash.handle(ev('cat > $F <<EOF\nx\nEOF', r2), { stateDir: e2 }), null, 'sin corrida, pasa');
  });
  const adhoc = io.readAdhoc(e2, SID);
  assert.deepEqual(adhoc.files, [], `el destino dudoso no suma al cupo: ${JSON.stringify(adhoc.files)}`);
  const log = fs.readFileSync(path.join(e2, 'gates.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(log.some((l) => l.name === 'ledger-visible' && l.status === 'unresolved-passed'), `constancia: ${JSON.stringify(log)}`);
  // con la corrida abierta y el escape del dev: pasa y quedan LAS DOS constancias
  const { estado: e3, repo: r3 } = corral();
  conEnv({ ...ENV, TYCON_LEDGER_VISIBLE: 'off' }, () => {
    assert.equal(bash.handle(ev('cat > $F <<EOF\nx\nEOF', r3), { stateDir: e3 }), null, 'con el escape, pasa');
  });
  const log3 = fs.readFileSync(path.join(e3, 'gates.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const st of ['escaped', 'unresolved-passed']) {
    assert.ok(log3.some((l) => l.name === 'ledger-visible' && l.status === st), `falta ${st}: ${JSON.stringify(log3)}`);
  }
});

// ── Un `$(date …)` en el nombre de un informe ──────────────────────────────────────────────────────────────────────

/** El repo de juguete de la tanda: historias en `specs/` y `docs/stories/`, informes en `out/`. */
function corralConHistorias() {
  const c = corral();
  const fm = (n) => `---\nstory: "${n}"\ntitle: "x"\nstatus: in-progress\n---\n\n# x\n`;
  for (const d of ['specs', 'docs/stories', 'out', '.advisors/pipeline-runs']) fs.mkdirSync(path.join(c.repo, d), { recursive: true });
  fs.writeFileSync(path.join(c.repo, 'specs', 'story-x.md'), fm('9.9'));
  fs.writeFileSync(path.join(c.repo, 'docs', 'stories', 'story-y.md'), fm('9.8'));
  return c;
}
/** El título del motivo con que frena el freno (la primera línea), o '' si pasa. */
function tituloDe(r) { return r && r.block ? r.block.split('\n').find((l) => l.trim()).trim() : ''; }
const INVISIBLE = '🔴 EDICIÓN INVISIBLE — escritura de código por Bash con el pipeline ABIERTO (story 9.9):';
const HISTORIA = '⛔ tycon-pipeline — HISTORIA ESCRITA POR CONSOLA';

// T3 DestinoConSubcomando_CasoReal_Pasa @story-8.113 @ac-3
// 🔴 Falla con: cortar el destino en el espacio de adentro del `$(…)`, o dejarlo «sin resolver» (frena «EDICIÓN
//    INVISIBLE» un informe `.md` o `.log`).
test('T3 DestinoConSubcomando_CasoReal_Pasa', () => {
  const { estado, repo } = corralConHistorias();
  conEnv({ ...ENV, SP: path.join(repo, 'out'), f: 'a.test.js' }, () => {
    for (const c of [
      "cat > .advisors/pipeline-runs/validate-story-$(date +%s)/step-01-validator.md << 'EOF'\nhola\nEOF",
      'echo x > out/run-$(date +%Y%m%d-%H%M%S).log',
      'echo x | tee out/r-$(date +%s).md',
      'echo x >> out/r-$(date +%s).log',
      'echo x > $SP/v-$(date +%Y)-$(date +%m).md',
      // un `>` adentro de un texto o de un heredoc no es una redirección
      // stable-data: el `git commit` es el texto de un comando que se le pasa al freno; la prueba nunca lo corre
      'git commit -m "nota > specs/r-$(date +%s).md"; echo ok', 'echo "a > specs/r-$(date +%s).md b"',
      "cat > out/n.txt <<'EOF'\necho x > specs/r-$(date +%s).md\nEOF",
    ]) assert.equal(tituloDe(bash.handle(ev(c, repo), { stateDir: estado, installedRoots: [] })), '', c);
  });
});

// Lo que da el freno de origin/main (e0a33e20) con cada variante: frena «EDICIÓN INVISIBLE».
const VARIANTES_DE_SUBCOMANDO = [
  'echo x > src/x-$(date +%s).ts',
  'echo x > src/x-$(date +%s)',
  'echo x > out-$(echo "$(date)").md',
  'echo x > out-$(echo `date`).md',
  'echo x > out-$(rm -rf src).md',
  'echo x > out-$(cp a src/x.ts).md',
  'echo x > specs/$(date +%s)/story-x.md',
];

// T4 DestinoConSubcomando_Variantes_SiguenComoHoy @story-8.113 @ac-4
// 🔴 Falla con: leer como inofensivo otro `$(…)` (otro comando, otras opciones de `date`, `basename -a`), un `$(…)`
//    que es el segmento entero, un destino que puede pisar una historia o caer en el estado del pipeline.
test('T4 DestinoConSubcomando_Variantes_SiguenComoHoy', () => {
  const { estado, repo } = corralConHistorias();
  conEnv({ ...ENV, f: 'specs/story-x.md' }, () => {
    const freno = (c) => tituloDe(bash.handle(ev(c.replaceAll('<estado>', estado), repo), { stateDir: estado, installedRoots: [] }));
    for (const c of VARIANTES_DE_SUBCOMANDO) assert.equal(freno(c), INVISIBLE, c);
    for (const c of [
      'echo x > out/x-$(date +%D).md', 'echo x > out/x-$(date +%Y/%m).md', 'echo x > out/x-$(date +../specs/story-x).md',
      'echo x > out/x-$(date -s 1).md', 'echo x > out/x-$(date -r a +%s).md', 'echo x > out/x-$(basename -a $f).md',
      'echo x > out/$(basename $f)/x.md', 'echo x > out/$(date +%s)/x.md', 'echo x > $NADIE/x-$(date +%s).md',
      'echo x > specs/r-$(basename $(ls)).md',
      // basename queda afuera: su salida puede ser `/` (`basename /`) y abrir una carpeta
      'node --test $f > $SP/suite-$(basename $f).log', 'echo x > out/r-$(basename $f .js).md',
      'V=/; echo x > specs$(basename $V)story-x.md',
      // el destino sigue después de una comilla o de una barra invertida: no termina en `.md`
      "echo x > src/r-$(date +%s).md'.ts'", 'echo x > src/a$(date +%s).md".cs"', 'echo x > src/r-$(date +%s).md\\.ts',
      // lo que el shell expande además del `$(…)` (llaves, un comodín escrito, un `~` en el medio), una variable que no
      // se resuelve pegada al comodín, y un `date` que el comando redefine
      'echo x > {specs,out}/r-$(date +%s).md', 'echo x > out/{a,b}-$(date +%s).log', 'echo x > spe*/r-$(date +%s).md',
      'echo x > out/a~b-$(date +%s).md', 'echo x > out/$NADIE-$(date +%s).md',
      'date(){ echo /; }; echo x > specs$(date +%s)story-x.md', 'PATH=/tmp:$PATH; echo x > out/r-$(date +%s).log',
    ]) assert.equal(freno(c), INVISIBLE, c);
    // una historia nueva escrita por heredoc a un destino con `$(date …)`: el freno de historias nuevas la juzga igual
    // que con el nombre escrito (el cuerpo del heredoc se atribuye al destino con comodín)
    const nueva = (destino) => `cat > ${destino} <<'EOF'\n---\nstory: "9.7"\ntitle: "n"\nstatus: ready-for-dev\n---\n# n\nEOF`;
    assert.equal(freno(nueva('out/r-$(date +%s).md')), freno(nueva('out/r-1.md')), 'una historia nueva por heredoc');
    const sio = require(path.join(SCRIPTS, 'lib', 'story-skill-gate-io.js'));
    const original = sio.evaluate;
    let contenido;
    sio.evaluate = (a) => { contenido = a.content; return original(a); };
    try { freno(nueva('out/r-$(date +%s).md')); } finally { sio.evaluate = original; }
    assert.match(String(contenido), /story: "9\.7"/, 'el freno de historias nuevas recibe el cuerpo del heredoc');
    // el árbol instalado del arnés, como el estado
    const inst = path.join(repo, 'inst');
    fs.mkdirSync(inst);
    assert.notEqual(tituloDe(bash.handle(ev('echo x > inst/r-$(date +%s).md', repo), { stateDir: estado, installedRoots: [inst] })), '', 'el árbol instalado');
    // el estado del pipeline: nombrado entero, desde otra carpeta posible del comando o por un enlace simbólico
    assert.match(freno('echo x > <estado>/r-$(date +%s).md'), /ESTADO DEL PIPELINE|EDICIÓN INVISIBLE/, 'el estado');
    assert.equal(freno('cd out || cd <estado>; echo x > r-$(date +%s).log'), INVISIBLE, 'cd a || cd b');
    fs.symlinkSync(estado, path.join(repo, 'out', 'lnk1'));
    assert.equal(freno('echo x > out/lnk$(date +%s)/x.md'), INVISIBLE, 'un enlace al estado que el comodín nombra');
    // una carpeta con historias: el `$(…)` puede caer en una de ellas, salga `.md` o `.log`, también si la carpeta sale
    // de una variable del comando o de dos `cd` seguidos
    for (const c of [
      'echo x > specs/story-$(date +%s).md', 'echo x > specs/$(date +%s)-run.log', 'echo x > docs/stories/r-$(date +%s).log',
      'D=specs; echo x > $D/r-$(date +%s).md', 'D=specs/; echo x > ${D}r-$(date +%s).md', 'D=specs; echo x > $D/r-$(date +%s).log',
      'cd out; cd ../specs; echo x > story$(date +%s).md', 'D=specs/; echo x > ${D}r-$(date +%s).log',
      // el comodín en una carpeta que da con una que tiene historias
      'echo x > spec$(date +%s)/x.md',
    ]) assert.equal(freno(c), HISTORIA, c);
    // un enlace simbólico a una historia en la carpeta del informe cuenta como la historia
    fs.mkdirSync(path.join(repo, 'out2'));
    fs.symlinkSync(path.join(repo, 'specs', 'story-x.md'), path.join(repo, 'out2', 'enlace.md'));
    assert.equal(freno('echo x > out2/r-$(date +%s).md'), HISTORIA, 'enlace a una historia');
    // una carpeta que no se puede leer no se sabe si tiene historias (con root, o en Windows, el permiso no impide leer)
    if (process.platform !== 'win32' && !(process.getuid && process.getuid() === 0)) {
      fs.mkdirSync(path.join(repo, 'cerrada'));
      fs.chmodSync(path.join(repo, 'cerrada'), 0o000);
      try { assert.equal(freno('echo x > cerrada/r-$(date +%s).log'), HISTORIA, 'carpeta sin leer'); } finally { fs.chmodSync(path.join(repo, 'cerrada'), 0o755); }
    }
  });
});

// T34 GuionPorEntradaQueEscribeSusArgumentos_Frena
// `python3 - "$f" <<'EOF' … open(p, 'w').write(s) … EOF` reescribe la historia que recibe por argumento: la ruta no
// está en el texto del guion, está en sus argumentos.
// 🔴 Falla con: contar sólo los textos del guion y no sus argumentos, o frenar un guion que sólo lee sus argumentos.
test('T34 GuionPorEntradaQueEscribeSusArgumentos_Frena', () => {
  const { estado, repo } = corralConHistorias();
  conEnv(ENV, () => {
    const freno = (c) => tituloDe(bash.handle(ev(c, repo), { stateDir: estado, installedRoots: [] }));
    const escribePy = "import sys\np = sys.argv[1]\ns = open(p, encoding='utf-8').read()\nopen(p, 'w', encoding='utf-8').write(s.replace('in-progress', 'done'))";
    const leePy = "import sys\nprint(open(sys.argv[1], encoding='utf-8').read())";
    const escribeNode = "const fs = require('fs');\nconst p = process.argv[2];\nfs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('a', 'b'));";
    // otro worktree con su historia, el `cd` y la variable encadenados con `&&`, y más comandos después
    const wt = path.join(path.dirname(repo), 'repo-wt');
    fs.mkdirSync(path.join(wt, 'specs'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'specs', 'story-z.md'), '---\nstory: "9.7"\ntitle: "z"\nstatus: ready-for-dev\n---\n\n# z\n');
    const real = `cd ${wt} && f=specs/story-z.md && python3 - "$f" <<'EOF'\nimport sys\np=sys.argv[1];s=open(p).read()\ns=s.replace("a","b",1)\nopen(p,'w').write(s)\nEOF\n`
      + `node lint-story-frontmatter.js $f 2>&1 | head -4\ncat >> specs/sprint-status.yaml <<'EOF'\n9-7-z: ready-for-dev\nEOF\ntail -2 specs/sprint-status.yaml | cut -c1-80`;
    const realEnElCuerpo = `cd ${wt} && python3 - <<'EOF'\np='specs/story-z.md'; s=open(p).read()\ns=s.replace("a","b",1)\nopen(p,'w').write(s)\nEOF\ngit diff --stat`;
    assert.equal(freno(real), HISTORIA, 'el caso real');
    assert.equal(freno(realEnElCuerpo), HISTORIA, 'el caso real, con la ruta en el cuerpo del guion');
    for (const c of [
      `f=specs/story-x.md; python3 - "$f" <<'EOF'\n${escribePy}\nEOF`,
      `python3 - specs/story-x.md <<'EOF'\n${escribePy}\nEOF`,
      `F=docs/stories/story-y.md\npython3 - "$F" <<EOF\n${escribePy}\nEOF`,
      `node - docs/stories/story-y.md <<'EOF'\n${escribeNode}\nEOF`,
      `python3 -c "import sys; open(sys.argv[1], 'w').write('x')" specs/story-x.md`,
      // las otras formas de darle el programa por la entrada
      `python3 /dev/stdin specs/story-x.md <<'EOF'\n${escribePy}\nEOF`,
      `python3 - specs/story-x.md <<'END-DOC'\n${escribePy}\nEND-DOC`,
      `cat <<'EOF' | python3 - specs/story-x.md\n${escribePy}\nEOF`,
      `python3 - \\\n  specs/story-x.md <<'EOF'\n${escribePy}\nEOF`,
      `python3 - specs/story-x.md <<< "import sys; open(sys.argv[1],'w').write('x')"`,
      `/usr/bin/env python3 - specs/story-x.md <<'EOF'\n${escribePy}\nEOF`,
      `python3 - specs/story-x.md <<'EOF'\nimport os, sys\nopen('/tmp/t', 'w').write('x')\nos.replace('/tmp/t', sys.argv[1])\nEOF`,
    ]) assert.equal(freno(c), HISTORIA, c);
    for (const c of [
      `f=specs/story-x.md; python3 - "$f" <<'EOF'\n${leePy}\nEOF`,
      `python3 -c "import sys; print(open(sys.argv[1]).read())" specs/story-x.md`,
      // el guion escribe, pero lo que nombra no es una historia
      `python3 - out/r.md <<'EOF'\n${escribePy}\nEOF`,
    ]) assert.equal(freno(c), '', c);
  });
});

// T35 GuionEnArchivoQueEscribeUnaHistoriaOUnaConstancia_Frena
// `python3 p.py`, `node p.js <historia>`: el programa no está en el comando, está en un archivo. El freno lo lee y mira
// lo que escribe, como si llegara por la entrada. `ruby -e` es un guion en línea más.
// Una historia entre los argumentos cuenta como escrita aunque el guion sólo la lea (T1 de bash-write-interpreter-args).
// 🔴 Falla con: mirar sólo el texto del comando, contar como destino todo texto entre comillas del guion (uno que sólo
//    lee una historia que nombra frenaría), o eximir un guion por el nombre de su carpeta en vez de por la instalación.
test('T35 GuionEnArchivoQueEscribeUnaHistoriaOUnaConstancia_Frena', () => {
  const { estado, repo, raiz } = corralConHistorias();
  conEnv(ENV, () => {
    const freno = (c, installedRoots = []) => tituloDe(bash.handle(ev(c, repo), { stateDir: estado, installedRoots }));
    const CONSTANCIA = /constancia de cambio de control/;
    const guion = (nombre, texto) => { fs.mkdirSync(path.dirname(path.join(repo, nombre)), { recursive: true }); fs.writeFileSync(path.join(repo, nombre), texto); return nombre; };
    guion('p.py', "s = open('specs/story-x.md').read()\nopen('specs/story-x.md', 'w').write(s.replace('in-progress', 'done'))\n");
    guion('arg.py', "import sys\np = sys.argv[1]\ns = open(p).read()\nopen(p, 'w').write(s.replace('in-progress', 'done'))\n");
    guion('arg.js', "const fs = require('fs');\nconst p = process.argv[2];\nfs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('a', 'b'));\n");
    guion('w.rb', "File.write('specs/story-x.md', 'x')\n");
    guion('c.py', "open('.github/control-changes/abc.json', 'w').write('{}')\n");
    guion('c.js', "require('fs').writeFileSync('.github/control-changes/abc.json', '{}');\n");
    guion('lee.py', "import sys\nprint(open(sys.argv[1]).read())\nprint(open('specs/story-x.md').read())\n");
    guion('lee.js', "const fs = require('fs');\nconst t = fs.readFileSync('specs/story-x.md', 'utf8');\nfs.writeFileSync('out/r.md', t);\n");
    // con el nombre de la carpeta del arnés, pero en el repo: no es la instalación
    guion('skills/tycon-pipeline/scripts/marker.js', "require('fs').writeFileSync('specs/story-x.md', 'x');\n");
    const instalado = path.join(raiz, 'instalado');
    fs.mkdirSync(instalado, { recursive: true });
    fs.writeFileSync(path.join(instalado, 'orq.js'), "require('fs').writeFileSync('specs/story-x.md', 'x');\n");
    for (const c of [
      'python3 p.py',
      'python3 -u p.py',
      'python3 arg.py specs/story-x.md',
      'node arg.js docs/stories/story-y.md',
      'f=specs/story-x.md; python3 arg.py "$f"',
      'ruby w.rb',
      `ruby -e "File.write('specs/story-x.md', 'x')"`,
      'node skills/tycon-pipeline/scripts/marker.js',
      `cat > nuevo.py <<'EOF'\nopen('specs/story-x.md', 'w').write('x')\nEOF\npython3 nuevo.py`,
      `cd specs && python3 ../arg.py story-x.md`,
      'python3 lee.py specs/story-x.md',
    ]) assert.equal(freno(c), HISTORIA, c);
    for (const c of [
      'python3 c.py',
      'node c.js',
      `ruby -e "File.write('.github/control-changes/abc.json', '{}')"`,
    ]) assert.match(freno(c), CONSTANCIA, c);
    for (const c of [
      'python3 lee.py',
      'node lee.js',
      'python3 arg.py out/r.md',
      'python3 no-existe.py specs/story-x.md',
      `node ${path.join(instalado, 'orq.js')}`,
    ]) assert.equal(freno(c, [instalado]), '', c);
  });
});

// T36 GuionEnArchivoDetrasDeEnvoltoriosOpcionesYEnlaces_Frena
// El mismo guion, corrido de las formas que el freno no leía: detrás de un envoltorio, con opciones pegadas, como módulo
// o precarga, como carpeta o ejecutable directo, en perl, importado, muy grande, con un NUL, con `argparse`, y por un
// enlace que hace caer el `..` en la instalación. Uno con miles de llamadas sin cerrar se juzga en poco tiempo.
// 🔴 Falla con: buscar el intérprete sólo al principio del tramo, leer las opciones de todos los intérpretes igual,
//    eximir por la ruta normalizada antes de seguir los enlaces, o pasar un guion que no se lee entero.
test('T36 GuionEnArchivoDetrasDeEnvoltoriosOpcionesYEnlaces_Frena', () => {
  const { estado, repo, raiz } = corralConHistorias();
  conEnv(ENV, () => {
    const freno = (c, installedRoots = []) => tituloDe(bash.handle(ev(c, repo), { stateDir: estado, installedRoots }));
    const guion = (nombre, texto) => { fs.mkdirSync(path.dirname(path.join(repo, nombre)), { recursive: true }); fs.writeFileSync(path.join(repo, nombre), texto); return path.join(repo, nombre); };
    const PY = "open('specs/story-x.md', 'w').write('x')\n";
    const JS = "require('fs').writeFileSync('specs/story-x.md', 'x');\n";
    guion('p.py', PY); guion('evil.py', PY); guion('p.js', JS); guion('pkg/__main__.py', PY);
    fs.chmodSync(guion('x.py', '#!/usr/bin/env python3\n' + PY), 0o755);
    guion('pl.pl', "open(F, '>specs/story-x.md'); print F 'x';\n");
    guion('big.py', PY + '#' + 'a'.repeat(300 * 1024) + '\n');
    guion('nul.js', JS.trim() + ' // \u0000\n');
    guion('imp.py', 'import evil\n');
    guion('ap.py', "import argparse\na = argparse.ArgumentParser(); a.add_argument('f'); f = a.parse_args().f\nopen(f, 'w').write('x')\n");
    guion('lee.js', "const fs = require('fs');\nconst t = fs.readFileSync(process.argv[2], 'utf8');\nfs.writeFileSync('out/r.md', t);\n");
    // `M/../evil.py`: por el texto es `evil.py`, un enlace a la instalación; el intérprete sigue `M` y corre `deep/evil.py`
    const instalado = path.join(raiz, 'instalado');
    fs.mkdirSync(instalado, { recursive: true });
    fs.writeFileSync(path.join(instalado, 'orq.js'), JS);
    guion('deep/sub/.keep', '');
    guion('deep/evil.py', PY);
    fs.symlinkSync(path.join(repo, 'deep', 'sub'), path.join(repo, 'M'));
    fs.symlinkSync(path.join(instalado, 'orq.js'), path.join(repo, 'evil2.py'));
    fs.renameSync(path.join(repo, 'deep', 'evil.py'), path.join(repo, 'deep', 'evil2.py'));
    for (const c of [
      'time python3 p.py', '( python3 p.py )', 'true & python3 p.py', 'sudo -u root python3 p.py',
      'if true; then python3 p.py; fi', 'nice -10 python3 p.py', 'echo p.py | xargs python3',
      'python3 -Wignore p.py', 'node --stack-size 1000 p.js', 'python3 -m evil', 'python3 -mevil', 'node -r ./p.js -e 1',
      'node --require=./p.js -e 1', 'python3 pkg', './x.py', 'perl pl.pl', 'perl -Ilib pl.pl', 'python3 big.py',
      'node nul.js', 'python3 imp.py', 'python3 ap.py specs/story-x.md', 'npx tsx p.js',
    ]) assert.notEqual(freno(c), '', c);
    assert.equal(freno('python3 M/../evil2.py', [instalado]), HISTORIA, 'el enlace no exime lo que corre afuera de la instalación');
    assert.equal(freno('node evil2.py', [instalado]), '', 'el enlace a la instalación, sin `..`, sí');
    for (const c of ['node lee.js out/r.md', 'python3 -m json.tool specs/story-x.md', 'python3 -I -E lee.py']) assert.equal(freno(c), '', c);
    assert.equal(freno('node lee.js specs/story-x.md'), HISTORIA, 'con la historia de argumento cuenta como escrita');
    guion('lento.js', 'fs.writeFileSync('.repeat(8000) + '\n');
    // el tiempo se mide en un proceso sin el medidor de cobertura: bajo el medidor (el portón de pruebas lo pasa a la
    // suite) el mismo juicio tarda veinte veces más, y lo que se mide es el freno, no el medidor. Vacía y no borrada: si
    // falta, Node la vuelve a copiar al proceso hijo
    const sinMedidor = { ...process.env, NODE_V8_COVERAGE: '' };
    const medir = `const b = require(${JSON.stringify(path.join(SCRIPTS, 'on-bash-write-gate.js'))}); const t0 = Date.now();`
      + ` b.handle(${JSON.stringify(ev('node lento.js specs/story-x.md', repo))}, { stateDir: ${JSON.stringify(estado)}, installedRoots: [] });`
      + ' process.stdout.write(String(Date.now() - t0));';
    const r = require('child_process').spawnSync(process.execPath, ['-e', medir], { encoding: 'utf8', env: sinMedidor });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(Number(r.stdout) < 5000, `miles de llamadas sin cerrar: ${r.stdout} ms`);
  });
});

// T37 GuionDelArbolPropio_SoloLoVersionadoSinCambios_Pasa
// En una máquina que corre el arnés desde un clon, no hay instalación: el orquestador es un guion del árbol del propio
// freno. Pasa si git lo tiene versionado, sin cambios y en un commit que también está en el servidor; uno nuevo, cambiado,
// commiteado sólo en ese clon o que git dejó de mirar frena, y lo que importa uno eximido pasa la misma prueba. Sin git
// (una versión bajada), el árbol es el arnés.
// 🔴 Falla con: eximir el árbol propio entero (un guion dejado en el clon escribe cualquier historia), no eximirlo
//    nunca (el orquestador no puede marcar nada en una máquina de clon), pasarle la ruta a git como patrón, o creerle
//    a un commit local.
test('T37 GuionDelArbolPropio_SoloLoVersionadoSinCambios_Pasa', () => {
  const { estado, repo, raiz } = corralConHistorias();
  const ORIGEN = path.join(SCRIPTS, '..', '..', '..');
  const copiar = (destino) => {
    fs.cpSync(SCRIPTS, path.join(destino, 'skills', 'tycon-pipeline', 'scripts'), { recursive: true, filter: (s) => !/[\\/](?:tests|node_modules)$/.test(s) });
    fs.cpSync(path.join(ORIGEN, 'scripts', 'lib'), path.join(destino, 'scripts', 'lib'), { recursive: true });
  };
  const ESCRIBE = `require('fs').writeFileSync(${JSON.stringify(path.join(repo, 'specs', 'story-x.md'))}, 'x');\n`;
  const clon = path.join(raiz, 'clon');
  copiar(clon);
  const guiones = path.join(clon, 'skills', 'tycon-pipeline', 'scripts');
  fs.writeFileSync(path.join(guiones, 'orq-x.js'), ESCRIBE);
  fs.writeFileSync(path.join(guiones, 'orq-y.js'), "require('./mod-y');\n");
  const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'b', GIT_AUTHOR_EMAIL: 'b@acme.test', GIT_COMMITTER_NAME: 'b', GIT_COMMITTER_EMAIL: 'b@acme.test' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete GIT_ENV[k];
  const git = (...a) => require('child_process').execFileSync('git', ['-C', clon, '-c', 'commit.gpgsign=false', ...a], { stdio: 'ignore', env: GIT_ENV });
  git('init', '-q', '.'); git('add', '-A'); git('commit', '-q', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  fs.writeFileSync(path.join(guiones, 'nuevo-x.js'), ESCRIBE);
  fs.writeFileSync(path.join(guiones, 'mod-y.js'), ESCRIBE);
  fs.writeFileSync(path.join(guiones, 'orq-[x].js'), ESCRIBE);
  fs.writeFileSync(path.join(guiones, '.gitignore'), 'orq-\\[x\\].js\n');
  const bajada = path.join(raiz, 'bajada');
  copiar(bajada);
  fs.writeFileSync(path.join(bajada, 'skills', 'tycon-pipeline', 'scripts', 'orq-x.js'), ESCRIBE);
  conEnv(ENV, () => {
    const freno = (arbol, archivo) => tituloDe(require(path.join(arbol, 'skills', 'tycon-pipeline', 'scripts', 'on-bash-write-gate.js'))
      .handle(ev(`node ${path.join(arbol, 'skills', 'tycon-pipeline', 'scripts', archivo)}`, repo), { stateDir: estado, installedRoots: [] }));
    assert.equal(freno(clon, 'orq-x.js'), '', 'versionado y sin cambios: es el orquestador');
    assert.equal(freno(clon, 'nuevo-x.js'), HISTORIA, 'un guion nuevo en el clon no es del arnés');
    assert.equal(freno(clon, 'orq-y.js'), HISTORIA, 'lo que importa un guion eximido pasa la misma prueba');
    assert.equal(freno(clon, 'orq-[x].js'), HISTORIA, 'la ruta es literal: no la encuentra un patrón de git');
    fs.appendFileSync(path.join(guiones, 'orq-x.js'), '// cambiado\n');
    assert.equal(freno(clon, 'orq-x.js'), HISTORIA, 'uno cambiado en el clon tampoco');
    git('update-index', '--assume-unchanged', path.join(guiones, 'orq-x.js'));
    assert.equal(freno(clon, 'orq-x.js'), HISTORIA, 'ni uno que git dejó de mirar');
    git('update-index', '--no-assume-unchanged', path.join(guiones, 'orq-x.js'));
    git('add', '-A'); git('commit', '-q', '-m', 'local');
    assert.equal(freno(clon, 'orq-x.js'), HISTORIA, 'ni uno commiteado sólo en este clon');
    assert.equal(freno(bajada, 'orq-x.js'), '', 'sin git, el árbol es el arnés');
  });
});

// T37b GuionDelArbolPropio_CommitLocalDeOtroArchivo_Pasa
// Un commit que sólo está en el clon cuenta para los guiones que toca: el que no tocó sigue siendo el del servidor, y lo
// que importa un guion se mira igual.
// 🔴 Falla con: mirar los commits locales del clon entero (cualquier commit sin empujar frena a todos los guiones), o
//    no mirarlos (un guion commiteado sólo en el clon escribe cualquier historia).
test('T37b GuionDelArbolPropio_CommitLocalDeOtroArchivo_Pasa', () => {
  const { estado, repo, raiz } = corralConHistorias();
  const ORIGEN = path.join(SCRIPTS, '..', '..', '..');
  const clon = path.join(raiz, 'clon');
  fs.cpSync(SCRIPTS, path.join(clon, 'skills', 'tycon-pipeline', 'scripts'), { recursive: true, filter: (s) => !/[\\/](?:tests|node_modules)$/.test(s) });
  fs.cpSync(path.join(ORIGEN, 'scripts', 'lib'), path.join(clon, 'scripts', 'lib'), { recursive: true });
  const ESCRIBE = `require('fs').writeFileSync(${JSON.stringify(path.join(repo, 'specs', 'story-x.md'))}, 'x');\n`;
  const guiones = path.join(clon, 'skills', 'tycon-pipeline', 'scripts');
  fs.writeFileSync(path.join(guiones, 'orq-x.js'), ESCRIBE);
  fs.writeFileSync(path.join(guiones, 'orq-y.js'), "require('./mod-y');\n");
  fs.writeFileSync(path.join(guiones, 'mod-y.js'), ESCRIBE);
  fs.writeFileSync(path.join(clon, 'LEAME.md'), 'a\n');
  const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'b', GIT_AUTHOR_EMAIL: 'b@acme.test', GIT_COMMITTER_NAME: 'b', GIT_COMMITTER_EMAIL: 'b@acme.test' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete GIT_ENV[k];
  const git = (...a) => require('child_process').execFileSync('git', ['-C', clon, '-c', 'commit.gpgsign=false', ...a], { stdio: 'ignore', env: GIT_ENV });
  git('init', '-q', '.'); git('add', '-A'); git('commit', '-q', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  conEnv(ENV, () => {
    const freno = (archivo) => tituloDe(require(path.join(guiones, 'on-bash-write-gate.js'))
      .handle(ev(`node ${path.join(guiones, archivo)}`, repo), { stateDir: estado, installedRoots: [] }));
    fs.appendFileSync(path.join(clon, 'LEAME.md'), 'b\n');
    git('commit', '-q', '-am', 'otro archivo');
    assert.equal(freno('orq-x.js'), '', 'un commit sin empujar de otro archivo no lo toca');
    assert.equal(freno('orq-y.js'), '', 'ni a lo que importa');
    fs.appendFileSync(path.join(guiones, 'mod-y.js'), '// local\n');
    git('commit', '-q', '-am', 'el módulo');
    assert.equal(freno('orq-y.js'), HISTORIA, 'el módulo que importa, commiteado sólo acá, frena');
    assert.equal(freno('orq-x.js'), '', 'y al otro guion no');
    fs.appendFileSync(path.join(guiones, 'orq-x.js'), '// local\n');
    git('commit', '-q', '-am', 'el guion');
    assert.equal(freno('orq-x.js'), HISTORIA, 'el guion commiteado sólo en este clon frena');
  });
});

// T37c GuionDelArbolPropio_CommitLocalIgualAUnaPunta_Pasa
// El árbol que arma el portón (lib/private-tree.js) pone el público en un commit local y declara su punta como rama del
// servidor: un guion que un commit local dejó igual a la punta de una rama del servidor es el publicado. Igual a una
// versión vieja, o distinto de todas las puntas, sigue frenando.
// 🔴 Falla con: mirar sólo si un commit local lo tocó (el orquestador del árbol armado frena), o comparar contra
//    cualquier versión de la historia del servidor (vuelve una versión vieja del guion).
test('T37c GuionDelArbolPropio_CommitLocalIgualAUnaPunta_Pasa', () => {
  const { estado, repo, raiz } = corralConHistorias();
  const ORIGEN = path.join(SCRIPTS, '..', '..', '..');
  const clon = path.join(raiz, 'clon');
  fs.cpSync(SCRIPTS, path.join(clon, 'skills', 'tycon-pipeline', 'scripts'), { recursive: true, filter: (s) => !/[\\/](?:tests|node_modules)$/.test(s) });
  fs.cpSync(path.join(ORIGEN, 'scripts', 'lib'), path.join(clon, 'scripts', 'lib'), { recursive: true });
  const ESCRIBE = `require('fs').writeFileSync(${JSON.stringify(path.join(repo, 'specs', 'story-x.md'))}, 'x');\n`;
  const guiones = path.join(clon, 'skills', 'tycon-pipeline', 'scripts');
  const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'b', GIT_AUTHOR_EMAIL: 'b@acme.test', GIT_COMMITTER_NAME: 'b', GIT_COMMITTER_EMAIL: 'b@acme.test' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete GIT_ENV[k];
  const git = (...a) => require('child_process').execFileSync('git', ['-C', clon, '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: GIT_ENV }).trim();
  git('init', '-q', '.'); git('add', '-A'); git('commit', '-q', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  // otra historia (el público): su punta trae el guion, la vieja una versión anterior
  git('checkout', '-q', '--orphan', 'publico');
  fs.writeFileSync(path.join(guiones, 'orq-x.js'), `${ESCRIBE}// vieja\n`);
  git('add', '-A'); git('commit', '-q', '-m', 'pub vieja');
  fs.writeFileSync(path.join(guiones, 'orq-x.js'), ESCRIBE);
  git('add', '-A'); git('commit', '-q', '-m', 'pub punta');
  git('update-ref', 'refs/remotes/publico/punta', 'HEAD');
  git('checkout', '-q', 'refs/remotes/origin/main');
  conEnv(ENV, () => {
    const freno = (archivo) => tituloDe(require(path.join(guiones, 'on-bash-write-gate.js'))
      .handle(ev(`node ${path.join(guiones, archivo)}`, repo), { stateDir: estado, installedRoots: [] }));
    // la superposición: un commit local que trae el guion de la punta del público
    fs.writeFileSync(path.join(guiones, 'orq-x.js'), ESCRIBE);
    git('add', '-A'); git('commit', '-q', '-m', 'superposición');
    assert.equal(freno('orq-x.js'), '', 'igual a la punta de una rama del servidor: es el publicado');
    fs.writeFileSync(path.join(guiones, 'orq-x.js'), `${ESCRIBE}// vieja\n`);
    git('commit', '-q', '-am', 'la vieja');
    assert.equal(freno('orq-x.js'), HISTORIA, 'igual a una versión vieja del servidor: frena');
    fs.writeFileSync(path.join(guiones, 'orq-x.js'), `${ESCRIBE}// local\n`);
    git('commit', '-q', '-am', 'otra');
    assert.equal(freno('orq-x.js'), HISTORIA, 'distinto de todas las puntas: frena');
  });
});

// T38 HeredocQueElShellNoAbre_NoEscondeLoQueSigue
// Un `<<` dentro de comillas, de `$((` o de `<<<`, o con la palabra pegada a una comilla, no abre un heredoc: el shell
// corre las líneas siguientes, y el freno también las mira. Un heredoc de verdad sigue sin contar su cuerpo.
// 🔴 Falla con: tomar cualquier `<<` como apertura, o el delimitador hasta la primera comilla.
test('T38 HeredocQueElShellNoAbre_NoEscondeLoQueSigue', () => {
  const { estado, repo } = corralConHistorias();
  conEnv(ENV, () => {
    const freno = (c) => tituloDe(bash.handle(ev(c, repo), { stateDir: estado, installedRoots: [] }));
    const ESCRIBE = 'echo x > specs/story-x.md';
    for (const [abre, cierre] of [['cat <<<1', '1'], ['echo $((1<<2))', '2'], ['echo "a <<-"', '-'], ['cat <<1"x"', '1'], ["echo 'b <<E'", 'E']]) {
      assert.equal(freno(`${abre}\n${ESCRIBE}\n${cierre}`), HISTORIA, abre);
    }
    for (const abre of ["cat <<'END-DOC' > /tmp/nota.txt", 'cat <<-1EOF > /tmp/nota.txt']) {
      const fin = abre.includes('END-DOC') ? 'END-DOC' : '1EOF';
      assert.equal(freno(`${abre}\n${ESCRIBE}\n${fin}`), '', `el cuerpo de ${abre} es texto`);
    }
  });
});

test('el mensaje del freno dice de quién es el escape y nombra la receta', () => {
  const lv = require(path.join(SCRIPTS, 'lib', 'ledger-visible.js'));
  const m = lv.mensaje(['/repo/src/Foo.cs'], '9.9');
  assert.match(m, /replace-section\.js/, 'la receta para un reemplazo grande');
  assert.match(m, /ambiente de la sesión/, 'el escape no se pone desde el comando');
});
