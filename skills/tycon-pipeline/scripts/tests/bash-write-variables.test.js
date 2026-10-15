#!/usr/bin/env node
'use strict';
/**
 * bash-write-variables.test.js — story 7.25 del arnés (AC 3, 4 y 5; T5-T9).
 *
 * QUÉ CUIDA: que la puerta de la consola (`on-bash-write-gate.js`) lea las variables del propio comando antes de decidir
 * dónde escribe. Caso de un producto del equipo (2026-10-14): `SP=<scratchpad>; python3 -c "open('$SP/x.cs','w')"` salió
 * frenado como «EDICIÓN INVISIBLE»: el freno armó `<repo>/$SP/x.cs` sin expandir y lo contó como código del repo de la
 * corrida. Y el escape del dev (`TYCON_LEDGER_VISIBLE=off`) prometía una constancia en gates.log que no se escribía.
 *
 * Las variables las expande `lib/command-vars.js` (un lector propio de la skill desde el pase adversarial de la 7.25:
 * el compartido `scripts/lib/shell-parse.js` daba rutas falsas para esto — ver su cabecera).
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
    // vuelta 7: si la variable es el nombre entero o la extensión, tampoco se sabe si es código
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

// T19 — los casos que confirmó el pase adversarial de la 7.25 (2026-10-15). La primera versión expandía con el lector
// compartido (`shell-parse.js`), que está hecho para otro freno: guarda sólo la ÚLTIMA asignación, no mira el ambiente
// y toma `$(mktemp -d)` como texto. Cada caso es un hallazgo reproducido; el lector propio tiene que resolver como el shell
// o, si no puede, decir que no pudo (nunca una ruta inventada).
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
    // el MISMO destino escrito dos veces con la variable reasignada en el medio (re-loop de la 7.25): no se sabe cuál
    // de los dos valores mirar → sin resolver, del lado seguro (antes se tomaba el primero y el que caía en el repo pasaba)
    const rep = bash.destinosResueltos('SP=/tmp/a; echo 1 > $SP/x.cs; SP=/repo; echo 2 > $SP/x.cs', '/repo');
    assert.equal(rep.length, 1, 'un destino (el texto es el mismo)');
    assert.deepEqual(rep[0].sinResolver, ['SP'], JSON.stringify(rep));
    assert.ok(rep[0].abs.startsWith('/repo/'), rep[0].abs);
  });
});

// T24 — vuelta 2 de revisores (seguridad, 2026-10-15): sólo cuenta una asignación que el shell de verdad deja puesta.
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

// T26 — vuelta 3 de revisores (seguridad): el lector es CONSERVADOR. Una asignación cuenta sólo si seguro quedó puesta
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

// T28 — vuelta 4 de revisores (seguridad): imitar al shell no converge; el lector entiende una forma SIMPLE y todo lo
// demás es «no sé». Cada caso de abajo, antes, resolvía afuera un destino que el shell escribe adentro.
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

// T29 — vuelta 5 de revisores (seguridad): `for`/`select`/`case` y las variables posiciones o especiales (`$1`, `$@`,
// `$$`) son «no sé»; y lo que está ADENTRO de comillas no dispara las reglas de forma (el caso original de la story
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
    // vuelta 6: dos formas que asignan en el shell actual aunque vayan entre comillas dobles
    for (const cmd of ['echo "$((SP=3))"; cat > $SP/a.cs', 'echo ${SP:=/repo/src}; cat > $SP/a.cs']) {
      assert.ok(uno(cmd).sinResolver.length > 0, `${cmd} → ${JSON.stringify(uno(cmd))}`);
    }
  });
});

// T31 — vuelta 6 de revisores (fallas silenciosas): un destino de código con una variable sin resolver frena aunque la
// sesión esté parada FUERA del repo de la corrida — no se sabe adónde va, así que no puede pasar callado.
test('T31 BashWrite_SinResolverDesdeOtraCarpeta_FrenaIgual', () => {
  const { estado, raiz } = corral();
  conEnv(ENV, () => {
    const r = bash.handle(ev('R=$(git rev-parse --show-toplevel); cat > $R/src/x.cs <<EOF\nx\nEOF', raiz), { stateDir: estado });
    assert.ok(r && r.block, 'frena: el destino puede caer en el repo de la corrida');
    assert.match(r.block, /sin resolver/);
  });
});

// T32 — vuelta 8 de revisores: un destino sin resolver con una extensión LITERAL que no es código (`$OUT/notes.md`)
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
  io.writeAdhoc(e2, SID, { reason: 'prueba', files: [], startedAt: new Date().toISOString() });
  conEnv(ENV, () => {
    assert.equal(bash.handle(ev('cat > $F <<EOF\nx\nEOF', r2), { stateDir: e2 }), null, 'sin corrida, pasa');
  });
  const adhoc = io.readAdhoc(e2, SID);
  assert.deepEqual(adhoc.files, [], `el destino dudoso no suma al cupo: ${JSON.stringify(adhoc.files)}`);
  const log = fs.readFileSync(path.join(e2, 'gates.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(log.some((l) => l.name === 'ledger-visible' && l.status === 'unresolved-passed'), `constancia: ${JSON.stringify(log)}`);
  // con la corrida abierta y el escape del dev: pasa y quedan LAS DOS constancias (vuelta 9 de revisores)
  const { estado: e3, repo: r3 } = corral();
  conEnv({ ...ENV, TYCON_LEDGER_VISIBLE: 'off' }, () => {
    assert.equal(bash.handle(ev('cat > $F <<EOF\nx\nEOF', r3), { stateDir: e3 }), null, 'con el escape, pasa');
  });
  const log3 = fs.readFileSync(path.join(e3, 'gates.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const st of ['escaped', 'unresolved-passed']) {
    assert.ok(log3.some((l) => l.name === 'ledger-visible' && l.status === st), `falta ${st}: ${JSON.stringify(log3)}`);
  }
});

test('el mensaje del freno dice de quién es el escape y nombra la receta', () => {
  const lv = require(path.join(SCRIPTS, 'lib', 'ledger-visible.js'));
  const m = lv.mensaje(['/repo/src/Foo.cs'], '9.9');
  assert.match(m, /replace-section\.js/, 'la receta para un reemplazo grande');
  assert.match(m, /ambiente de la sesión/, 'el escape no se pone desde el comando');
});
