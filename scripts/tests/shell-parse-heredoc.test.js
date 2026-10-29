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

test('ShellParseHeredoc_Segments_SeeTheCommand — el comando del cuerpo sale como un segmento propio', () => {
  // 🔴 rojo si: sale pegado al marcador del heredoc y las reglas no lo leen como comando.
  const segs = P.segmentos('cat > /tmp/n.txt <<EOF\n$(rm -f /protegido)\nEOF').map((x) => x.texto.trim());
  assert.ok(segs.some((t) => /^rm -f \/protegido$/.test(t)), JSON.stringify(segs));
});
