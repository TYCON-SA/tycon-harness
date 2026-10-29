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
