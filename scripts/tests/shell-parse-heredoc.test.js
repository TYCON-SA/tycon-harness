#!/usr/bin/env node
'use strict';
// shell-parse-heredoc.test.js — el cuerpo de un heredoc SIN comillas es texto, pero sus `$(…)` y comillas invertidas el
// shell sí los ejecuta antes de pasarle el texto al programa. El partidor quita el cuerpo y deja esos comandos a la vista.
const test = require('node:test');
const assert = require('node:assert');
const P = require('../lib/shell-parse');

test('ShellParseHeredoc_UnquotedSubstitution_StaysVisible — un $(…) del cuerpo sin comillas queda como comando', () => {
  // 🔴 rojo si: el cuerpo se quita entero → `rm` corre y ningún freno lo ve.
  const s = P.sinHeredocs('cat > /tmp/n.txt <<EOF\nhola $(rm -f /protegido) y `touch /otro`\nEOF\necho fin');
  assert.match(s, /rm -f \/protegido/);
  assert.match(s, /touch \/otro/);
  assert.match(s, /echo fin/);
  assert.doesNotMatch(s, /hola/, 'el texto del cuerpo sigue siendo texto');
});

test('ShellParseHeredoc_Interpreter_SubstitutionVisible — también cuando el cuerpo va a un intérprete', () => {
  // 🔴 rojo si: `python3 - <<EOF` esconde lo que el shell corre al armar el programa.
  assert.match(P.sinHeredocs('python3 - <<EOF\nprint("$(rm -f /w)")\nEOF'), /rm -f \/w/);
});

test('ShellParseHeredoc_Nested_And_Apostrophe — una comilla suelta del texto no esconde la sustitución que sigue', () => {
  // 🔴 rojo si: el apóstrofo del texto se lee como comilla y el `$(…)` de después queda adentro.
  const s = P.sinHeredocs("cat <<EOF\ndon't $(touch /z) ${X:-$(rm /v)} $((1+2))\nEOF");
  assert.match(s, /touch \/z/);
  assert.match(s, /rm \/v/);
});

test('ShellParseHeredoc_QuotedOrEscaped_StaysText — con comillas en la palabra, o con el $ escapado, no se ejecuta nada', () => {
  // 🔴 rojo si: se leen como comandos cosas que el shell no corre → frena de más.
  assert.doesNotMatch(P.sinHeredocs("cat <<'EOF'\n$(rm -f /y)\nEOF"), /rm/);
  assert.doesNotMatch(P.sinHeredocs('cat <<EOF\n\\$(rm -f /y) \\`touch /x\\`\nEOF'), /rm|touch/);
  assert.match(P.sinHeredocs('cat <<EOF\n\\\\$(rm -f /y)\nEOF'), /rm -f \/y/, 'una barra escapada no escapa el $');
});

test('ShellParseHeredoc_TwoOnOneLine_BothBodiesSeen — con dos heredocs en una línea se ven las sustituciones de los dos', () => {
  // 🔴 rojo si: sólo se rescata el primer cuerpo → el `$(rm y)` del segundo pasa.
  const s = P.sinHeredocs('cat <<A; cat <<B\n$(touch /a)\nA\n$(rm /y)\nB');
  assert.match(s, /touch \/a/);
  assert.match(s, /rm \/y/);
});

test('ShellParseHeredoc_Unclosed_KeepsTheWholeText — una sustitución sin cierre se lleva el texto entero', () => {
  // 🔴 rojo si: se corta un carácter de más → el destino que juzgan los frenos queda otro.
  assert.match(P.sinHeredocs('cat <<EOF\n$(rm /prod/x\nEOF'), /rm \/prod\/x/);
});

test('ShellParseHeredoc_LineShape_Unchanged — la redirección y la tubería del `<<` siguen con su comando', () => {
  // 🔴 rojo si: el texto de la sustitución parte la línea del `<<` → `> out.txt` o `| python3` quedan en otro segmento.
  const segs = P.segmentos('cat <<EOF > /tmp/out.txt\n$(rm x\n y)\nEOF').map((x) => x.texto.trim());
  assert.ok(segs.includes('cat  __HEREDOC__ > /tmp/out.txt') || segs.some((t) => /^cat\s+__HEREDOC__\s+> \/tmp\/out\.txt$/.test(t)), JSON.stringify(segs));
  assert.ok(segs.includes('rm x'), JSON.stringify(segs));
  const tubo = P.segmentos('echo a |\ncat <<EOF | python3\n$(rm z)\nEOF').map((x) => [x.texto.trim(), x.sep]);
  assert.ok(tubo.some(([t, sep]) => t === 'echo a' && sep === '|'), JSON.stringify(tubo));
  assert.ok(tubo.some(([t]) => /^cat\s+__HEREDOC__$/.test(t)), JSON.stringify(tubo));
});

test('ShellParseHeredoc_Segments_SeeTheCommand — el comando del cuerpo sale como un segmento propio', () => {
  // 🔴 rojo si: sale pegado al marcador del heredoc y las reglas no lo leen como comando.
  const segs = P.segmentos('cat > /tmp/n.txt <<EOF\n$(rm -f /protegido)\nEOF').map((x) => x.texto.trim());
  assert.ok(segs.some((t) => /^rm -f \/protegido$/.test(t)), JSON.stringify(segs));
});

test('ShellParse_EjecutaTexto_SoloDiceQueNoConProgramasConocidos — ante la duda, un texto puede correrse', () => {
  // 🔴 rojo si: un texto que el shell SÍ corre se toma por texto (los frenos de constancias y de sesiones dejarían de
  // mirarlo), o un comando que sólo nombra o guarda texto frena de más
  const noCorren = [
    "desc='a > b; bash x'; echo \"$desc\"",
    "cat >> n.md <<'EOF'\ndon't | bash\nEOF",
    "msg=x; printf '%s' \"$(printf '%s' \"$msg\")\"",
    "echo hola # no, it's fine",
  ];
  const corren = [
    'echo hola | bash', '\\bash -c x', '"bash" -c x', "b''ash -c x", '$0 -c x', "trap 'cp a b' EXIT",
    'if true; then bash x; fi', "bash<<<'x'", "cat >> n.md <<'EOF'\ndon't\nEOF\necho x | bash",
    'echo "$(bash -c x)"', "su -c 'cp a b'", 'PATH=.:$PATH s.sh', './s.sh', 'c=x; $c',
    // los que tienen una opción que corre un texto, y lo que una variable de delante cambia (del pase adversarial)
    "git -c alias.x='!cp a b' x", "git rebase -x 'cp a b' HEAD~1", "gh alias set x --shell 'cp a b'",
    "az repos pr create --description 'x > y'", 'sort --compress-program=sh f', "GIT_SSH_COMMAND='sh -c x' cat f",
    // un comentario con un apóstrofo no tapa lo de abajo, y una comilla invertida escapada falla cerrado
    "echo x # it's\nbash y", 'echo \\` "`bash -c x`"',
  ];
  for (const c of noCorren) assert.strictEqual(P.ejecutaTexto(c), false, `tomó por ejecutor: ${c}`);
  for (const c of corren) assert.strictEqual(P.ejecutaTexto(c), true, `no vio que corre: ${c}`);
});

// ── las dos lecturas (S247e) ─────────────────────────────────────────────────────────────────────────────────────
// La de siempre (`heredocsPorOperador`) toma todo `<<` por heredoc; la de comillas (`heredocsLeidos`) lee comillas,
// comentarios y cuerpos con un mismo lector. El freno de producción juzga las dos cuando difieren.
const q = "'";
const marcas = (l) => l.map((h) => `${h.delim}@${h.indice}`);

test('ShellParseHeredocReadings_LtLtInsideQuotes_IsText @S247e — un << adentro de una comilla, de una sustitución entre comillas o de un comentario no es heredoc', () => {
  // 🔴 rojo si: la lectura de comillas toma por heredoc un << que es texto, y esconde lo que sigue hasta su «cierre»
  assert.deepStrictEqual(P.heredocsLeidos(`echo "$(echo " <<EOF\n")"\nrm x\nEOF`), []);
  assert.deepStrictEqual(P.heredocsLeidos(`echo it${q}s\n<<EOF\n${q}a\nrm x\nEOF`), []);
  assert.deepStrictEqual(P.heredocsLeidos('# ver cat <<EOF\nrm x\nEOF'), []);
  assert.deepStrictEqual(P.heredocsLeidos('python3 -c "print(1 << 3)"\nrm x\n3)"'), []);
  assert.deepStrictEqual(P.heredocsLeidos('echo $((1 <<EOF))\nrm x\nEOF'), []);
  // la de siempre sí los toma: por eso difieren y el freno juzga las dos
  assert.strictEqual(P.lecturasCoinciden(`echo "$(echo " <<EOF\n")"\nrm x\nEOF`), false);
});

test('ShellParseHeredocReadings_CommonForms_Agree @S247e — en las formas de siempre las dos lecturas dan lo mismo', () => {
  // 🔴 rojo si: el mensaje de un commit con heredoc, o dos heredocs en una línea, se leen distinto: el freno lanzaría la
  // segunda lectura en cada commit
  const formas = [
    `git log -1 --format="$(cat <<${q}EOF${q}\nmensaje\nEOF\n)"`,
    `cat > a.md <<${q}FIN${q}\nit${q}s "una" nota\nFIN\necho fin`,
    'cat <<A; python3 - <<B\nuno\nA\ndos\nB\necho fin',
    'cat <<-EOF\n\ttexto\n\tEOF\necho fin',
    `MSG="$(cat <<${q}EOF${q}\ncuerpo\nEOF\n)"\ncat > n.md <<${q}FIN${q}\necho don${q}t\nFIN`,
    'echo `date` && cat <<EOF\nhola $(whoami)\nEOF',
  ];
  for (const f of formas) {
    assert.ok(P.lecturasCoinciden(f), `difieren en: ${JSON.stringify(f)} → ${marcas(P.heredocsPorOperador(f))} / ${marcas(P.heredocsLeidos(f))}`);
    assert.deepStrictEqual(P.heredocsLeidos(f), P.heredocsPorOperador(f), JSON.stringify(f));
  }
});

test('ShellParseHeredocReadings_BodyOfAnother_IsText @S247e — un << adentro del cuerpo de otro heredoc es texto, y lo de después del cierre son comandos', () => {
  // 🔴 rojo si: el << del cuerpo se toma por heredoc y su «cuerpo» se lleva el comando de verdad que sigue al cierre
  const c = `cat <<A\necho ${q} <<B\nA\nrm x\nB`;
  assert.deepStrictEqual(marcas(P.heredocsLeidos(c)), ['A@4']);
  const segs = P.conLectura('comillas', () => P.segmentos(c)).map((s) => s.texto.trim());
  assert.ok(segs.includes('rm x'), JSON.stringify(segs));
});

test('ShellParseHeredocReadings_ConLectura_RestoresAndRejects @S247e — conLectura vuelve a la lectura de antes, también si tira, y rechaza un nombre que no conoce', () => {
  const c = `echo "$(echo " <<EOF\n")"\nrm x\nEOF`;
  assert.throws(() => P.conLectura('comillas', () => { throw new Error('x'); }));
  assert.strictEqual(P.heredocs(c).length, 1, 'volvió a la de siempre');
  assert.strictEqual(P.conLectura('comillas', () => P.heredocs(c).length), 0);
  assert.throws(() => P.conLectura('otra', () => 0), /no conozco/);
});
