#!/usr/bin/env bash
# validator-verdict.test.sh — red del renglón `Veredicto:` del validador de stories.
#
# Lo que cuida, en una frase: que lo que encuentra cada lanzamiento de `tycon-story-validator` quede
# legible por una máquina —limpio, o qué reglas y si bloquea— sin inferir nada de la prosa, y que se lea
# del informe real aunque llegue encolado o por traspaso.
#
# 🔴 REGLA DE ADMISIÓN: cada caso trae escrita la MUTACIÓN que lo pone en rojo. Los que más pesan:
#    · T1c — «limpio» con un identificador de regla NO es limpio: es inconsistente (si el parse lo
#      aceptara, el descuento de los re-loops se apoyaría en un informe que dice haber encontrado algo).
#    · T1g — gana el ÚLTIMO renglón: un informe que cita el formato arriba y cierra con su veredicto real.
#    · T2c — el informe por traspaso se lee DEL mensaje del agente, y sólo de adentro del marco: el texto
#      que el arnés agrega después de `</agent-message>` trae un «Veredicto: limpio» falso a propósito.
#    · T2d — un lanzamiento que no volvió no tiene veredicto: `no_medido`, nunca `limpio`.
#
# Sin red, sin modelo, sin tocar el registro de la máquina: todo va a un temporal.
# bash 3.2 (macOS): siempre `${v}`, nunca una variable pegada a comillas angulares.
#
# Correr: bash scripts/tests/validator-verdict.test.sh

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="${RAIZ}/scripts/lib/validator-verdict.js"
METER="${RAIZ}/scripts/metrics/reviewers-cost.js"
CASES="${RAIZ}/scripts/controls-bench/cases/advisors/tycon-story-validator.json"
RUNNER="${RAIZ}/scripts/controls-bench/advisor-runner.js"

fallos=0
ok()  { echo "✅ $1"; }
bad() { echo "❌ $1 — $2"; fallos=$((fallos+1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
export HOME="${TMP}/home"
mkdir -p "${HOME}"

# ── T1 · Veredicto_Parser_EstadosYReglas ─────────────────────────────────────────────────────
# Mutación que lo pone en rojo: leer el PRIMER renglón en vez del último (T1g), aceptar «limpio» con
# reglas (T1c), o normalizar tokens que no son VAL- (T1h).
if [ ! -f "${LIB}" ]; then
  bad "T1 Veredicto_Parser_EstadosYReglas" "falta ${LIB}"
else
  salida="$(LIB="${LIB}" node - <<'JS' 2>&1
const { veredictoDe } = require(process.env.LIB);
const casos = [
  ['T1a limpio', 'Todo verificado.\n\nVeredicto: limpio', { estado: 'limpio', reglas: [], bloquea: false }],
  ['T1b hallazgos con reglas y bloquea sí', '- algo\n\nVeredicto: hallazgos (VAL-C8, VAL-W15) · bloquea: sí', { estado: 'hallazgos', reglas: ['VAL-C8', 'VAL-W15'], bloquea: true }],
  ['T1b2 bloquea no', 'Veredicto: hallazgos (VAL-W3) · bloquea: no', { estado: 'hallazgos', reglas: ['VAL-W3'], bloquea: false }],
  ['T1b3 bloquea ausente', 'Veredicto: hallazgos (VAL-W3)', { estado: 'hallazgos', reglas: ['VAL-W3'], bloquea: null }],
  ['T1b4 si sin tilde', 'Veredicto: hallazgos (VAL-C1) · bloquea: si', { estado: 'hallazgos', reglas: ['VAL-C1'], bloquea: true }],
  ['T1c limpio con identificador', 'Veredicto: limpio (VAL-W3)', { estado: 'inconsistente', reglas: ['VAL-W3'], bloquea: null }],
  ['T1d valor desconocido', 'Veredicto: casi todo bien', { estado: 'inconsistente', reglas: [], bloquea: null }],
  ['T1e sin renglón', 'Limpio, 0 hallazgos.', { estado: 'sin_veredicto', reglas: [], bloquea: null }],
  ['T1e2 texto vacío', '', { estado: 'sin_veredicto', reglas: [], bloquea: null }],
  ['T1f negrita, sangría y mayúsculas', '  **VEREDICTO:** Limpio', { estado: 'limpio', reglas: [], bloquea: false }],
  ['T1g gana el último', 'El formato es `Veredicto: limpio`.\n- hallazgo real\nVeredicto: hallazgos (VAL-W15) · bloquea: no', { estado: 'hallazgos', reglas: ['VAL-W15'], bloquea: false }],
  ['T1h token que no es VAL', 'Veredicto: hallazgos (SEC-C1, VAL-W5, val-w6) · bloquea: no', { estado: 'hallazgos', reglas: ['VAL-W5', 'VAL-W6'], bloquea: false }],
];
let mal = 0;
for (const [nombre, texto, esperado] of casos) {
  const r = veredictoDe(texto);
  const a = JSON.stringify({ estado: r.estado, reglas: r.reglas, bloquea: r.bloquea });
  const e = JSON.stringify(esperado);
  if (a !== e) { mal += 1; console.log(`MAL ${nombre}: ${a} ≠ ${e}`); }
}
console.log(mal ? `ROJO ${mal}` : 'VERDE');
JS
)"
  if printf '%s' "${salida}" | grep '^VERDE$' >/dev/null; then ok "T1 Veredicto_Parser_EstadosYReglas"; else bad "T1 Veredicto_Parser_EstadosYReglas" "$(printf '%s' "${salida}" | tr '\n' ' ' | cut -c1-600)"; fi
fi

# ── T2 · Veredicto_Conversacion_NotificacionEncoladaYTraspaso ─────────────────────────────────
# Conversación sintética: cuatro lanzamientos del validador (notificación como mensaje · encolada ·
# informe por traspaso con sangría y un veredicto FALSO después del marco · sin resultado) y un revisor de
# otro tipo que también dice «limpio».
cat > "${TMP}/conversacion.py" <<'PY'
import json, sys
def agente(i, ts, tipo, prompt):
    return {"type": "assistant", "timestamp": ts, "message": {"role": "assistant", "content": [
        {"type": "tool_use", "id": i, "name": "Agent", "input": {"subagent_type": tipo, "description": "x", "prompt": prompt}}]}}
def notif(tarea, i, resultado, tok):
    return ("<task-notification>\n<task-id>%s</task-id>\n<tool-use-id>%s</tool-use-id>\n<status>completed</status>\n"
            "<result>%s</result>\n<usage><subagent_tokens>%d</subagent_tokens><tool_uses>3</tool_uses><duration_ms>60000</duration_ms></usage>\n"
            "</task-notification>") % (tarea, i, resultado, tok)
aviso = 'This agent\'s report was delivered to you as a message from "ccc" (its SubagentHandback call). Read it there; it is not repeated here.'
traspaso = ('Another Claude session sent a message:\n<agent-message from="ccc">\n[Subagent hand-back] The text below is the final report of a subagent. The report follows:\n'
            '  - la lista de archivos no declara uno que se tocó\n  \n  Veredicto: hallazgos (VAL-W15) · bloquea: no\n</agent-message>\n\n'
            'That "other Claude session" is an agent working inside this same session.\nVeredicto: limpio\n')
lineas = [
  agente("toolu_A", "2026-09-17T10:00:00Z", "tycon-story-validator", "Validar la story en /r/specs/story-9.9-algo.md contra el repo /r."),
  {"type": "user", "timestamp": "2026-09-17T10:02:00Z", "message": {"role": "user", "content": notif("aaa", "toolu_A", "- todo verificado\n\nVeredicto: limpio", 120000)}},
  agente("toolu_B", "2026-09-17T10:10:00Z", "tycon-story-validator", "context_file: /h/.claude/.tycon-pipeline/advisor-context/s-iter2-tycon-story-validator.md"),
  {"type": "queue-operation", "operation": "enqueue", "timestamp": "2026-09-17T10:12:00Z", "content": notif("bbb", "toolu_B", "- falta la sección\n\nVeredicto: hallazgos (VAL-W15, VAL-C8) · bloquea: sí", 130000)},
  agente("toolu_C", "2026-09-17T10:20:00Z", "tycon-story-validator", "Validá la story /r/specs/story-9.10-otra.md antes de implementarla."),
  {"type": "user", "timestamp": "2026-09-17T10:22:00Z", "message": {"role": "user", "content": notif("ccc", "toolu_C", aviso, 140000)}},
  {"type": "user", "timestamp": "2026-09-17T10:22:01Z", "message": {"role": "user", "content": traspaso}},
  agente("toolu_D", "2026-09-17T10:30:00Z", "tycon-story-validator", "Re-validá /r/specs/story-9.9-algo.md."),
  agente("toolu_E", "2026-09-17T10:31:00Z", "tycon-plugin-security-basics", "context_file: x"),
  {"type": "user", "timestamp": "2026-09-17T10:33:00Z", "message": {"role": "user", "content": notif("eee", "toolu_E", "Limpio.\nVeredicto: limpio", 90000)}},
]
with open(sys.argv[1], "w") as f:
    for l in lineas: f.write(json.dumps(l, ensure_ascii=False) + "\n")
PY
python3 "${TMP}/conversacion.py" "${TMP}/conversacion.jsonl"

salida="$(METER="${METER}" CONV="${TMP}/conversacion.jsonl" node - <<'JS' 2>&1
const fs = require('fs');
let m;
try { m = require(process.env.METER); } catch (e) { console.log(`NO_CARGA ${e.message}`); process.exit(0); }
if (typeof m.veredictosDeConversacion !== 'function') { console.log('SIN_FUNCION veredictosDeConversacion'); process.exit(0); }
const lineas = fs.readFileSync(process.env.CONV, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const r = m.veredictosDeConversacion(lineas, { storyPath: '/r/specs/story-9.9-algo.md' });
const porId = Object.fromEntries(r.map((x) => [x.id, x]));
const chk = [];
const eq = (nombre, a, e) => { const A = JSON.stringify(a), E = JSON.stringify(e); chk.push(A === E ? `OK ${nombre}` : `MAL ${nombre}: ${A} ≠ ${E}`); };
eq('T2a sólo el tipo pedido, en orden', r.map((x) => x.id), ['toolu_A', 'toolu_B', 'toolu_C', 'toolu_D']);
eq('T2a notificación como mensaje', porId.toolu_A && [porId.toolu_A.veredicto, porId.toolu_A.reglas], ['limpio', []]);
eq('T2b encolada', porId.toolu_B && [porId.toolu_B.veredicto, porId.toolu_B.reglas, porId.toolu_B.bloquea], ['hallazgos', ['VAL-W15', 'VAL-C8'], true]);
eq('T2c traspaso leído del marco (no del texto de después)', porId.toolu_C && [porId.toolu_C.veredicto, porId.toolu_C.reglas, porId.toolu_C.bloquea, porId.toolu_C.fuente], ['hallazgos', ['VAL-W15'], false, 'traspaso']);
eq('T2d sin resultado', porId.toolu_D && [porId.toolu_D.veredicto, porId.toolu_D.con_resultado], ['no_medido', false]);
eq('T2e sobre otra story', r.map((x) => x.sobre_otra_story), [false, null, true, false]);
const { resultadosDeConversacion } = m;
const res = resultadosDeConversacion(lineas).get('toolu_C');
const esperado = Buffer.byteLength('- la lista de archivos no declara uno que se tocó\n\nVeredicto: hallazgos (VAL-W15) · bloquea: no', 'utf8');
eq('T2f bytes del traspaso = texto del informe', res && res.bytes, esperado);
console.log(chk.join('\n'));
console.log(chk.some((c) => c.startsWith('MAL')) ? 'ROJO' : 'VERDE');
JS
)"
if printf '%s' "${salida}" | grep '^VERDE$' >/dev/null; then ok "T2 Veredicto_Conversacion_NotificacionEncoladaYTraspaso"; else bad "T2 Veredicto_Conversacion_NotificacionEncoladaYTraspaso" "$(printf '%s' "${salida}" | grep -v '^OK' | tr '\n' ' ' | cut -c1-700)"; fi

# ── T2g · el marco del traspaso cierra en el renglón SIN sangría ───────────────────────────────────
# Medido en 78 traspasos reales (135 hilos guardados): los 78 cierran con `</agent-message>` al principio de
# renglón y los 353 renglones del informe van sangrados dos espacios. Mutaciones que lo ponen en rojo: cortar
# en el PRIMER `</agent-message>` (un informe que cita el tag pierde su renglón Veredicto → sin_veredicto) o en
# el ÚLTIMO (dos marcos seguidos se funden y el veredicto del segundo pasa al primero).
# ── T2h · «no es una story» por nombre exacto o por carpeta, nunca por un pedazo ────────────────────
# Con un substring («catalog», «README», «-pasos.md»), la story de otro tema saldría «no sé» (null), contaría
# como propia en la racha y podría soltar al validador con la mitad de la evidencia. Mutación: volver al
# substring. Guarda: lo que sí es contexto, guía o planificación sigue sin contar como otra story.
salida="$(METER="${METER}" LIB="${LIB}" node - <<'JS' 2>&1
let m, v;
try { m = require(process.env.METER); v = require(process.env.LIB).veredictoDe; } catch (e) { console.log(`NO_CARGA ${e.message}`); process.exit(0); }
const chk = [];
const eq = (nombre, a, e) => { const A = JSON.stringify(a), E = JSON.stringify(e); chk.push(A === E ? `OK ${nombre}` : `MAL ${nombre}: ${A} ≠ ${E}`); };
const marco = (de, renglones) => `<agent-message from="${de}">\n[Subagent hand-back] The text below is the final report of a subagent. The report follows:\n${renglones.map((r) => (r ? `  ${r}` : '  ')).join('\n')}\n</agent-message>\n`;
const cita = `Another Claude session sent a message:\n${marco('ddd', ['- el ejemplo `</agent-message>` del comentario está bien escrito', '', 'Veredicto: hallazgos (VAL-W15) · bloquea: no'])}\nThat "other Claude session" is an agent.\n`;
const t1 = m.traspasoDe(cita);
eq('T2g un informe que cita el tag conserva su veredicto', t1 && [t1.agente, v(t1.texto).estado, v(t1.texto).reglas], ['ddd', 'hallazgos', ['VAL-W15']]);
const dos = marco('e1', ['Veredicto: hallazgos (VAL-C8) · bloquea: sí']) + marco('e2', ['Veredicto: limpio']);
const t2 = m.traspasoDe(dos);
eq('T2g dos marcos seguidos no se funden', t2 && [t2.agente, v(t2.texto).estado], ['e1', 'hallazgos']);
const propia = '/r/specs/story-7.3-algo.md';
for (const [nombre, prompt, esperado] of [
  ['T2h otra story con «catalogo» en el nombre', 'Validá specs/story-9.10-armar-el-catalogo-de-productos.md.', true],
  ['T2h otra story con «readme» en el nombre', 'Validá la story specs/stories/2-1-readme-vivo.md', true],
  ['T2h otra story que termina en «-pasos»', 'Validá /r/specs/story-5.1-ordenar-los-pasos.md', true],
  ['T2h otra story con «incident-log» en el nombre', 'Validá specs/story-3.3-incident-log-por-cliente.md', true],
  ['T2h sólo guías y planificación', 'Leé guides/advisor-rules-catalog.md, README.md, specs/epics.md y story-format.md.', null],
  ['T2h sólo contexto de la corrida', 'context_file: /h/.claude/.tycon-pipeline/advisor-context/abc-iter2-tycon-story-validator.md · ver .advisors/pipeline-runs/7.3-x/step-05-contexto.md y tasks/medicion-7.3.md', null],
  ['T2h un step del pipeline', 'Seguí skills/tycon-pipeline/steps/step-07-reviewers.md', null],
  ['T2h la propia story gana', `Validar ${propia} y de paso specs/story-9.10-armar-el-catalogo.md`, false],
]) eq(nombre, m.sobreOtraStory(prompt, propia), esperado);
console.log(chk.join('\n'));
console.log(chk.some((c) => c.startsWith('MAL')) ? 'ROJO' : 'VERDE');
JS
)"
if printf '%s' "${salida}" | grep '^VERDE$' >/dev/null; then ok "T2g/T2h traspaso cerrado sin sangría · otra story por nombre o carpeta"; else bad "T2g/T2h traspaso y otra story" "$(printf '%s' "${salida}" | grep -v '^OK' | tr '\n' ' ' | cut -c1-900)"; fi

# ── T16 · Banco_ExpectVeredicto_AutotestYCasos ──────────────────────────────────────────────
# Mutación: un caso sin `expect_veredicto`, o con el estado que no corresponde a su tipo; o el autotest del
# runner sin el parse del renglón.
salida="$(CASES="${CASES}" node - <<'JS' 2>&1
const d = JSON.parse(require('fs').readFileSync(process.env.CASES, 'utf8'));
const mal = [];
for (const c of d.cases) {
  // Los gemelos no esperan «limpio»: son limpios para SU regla (corrida en vivo del 2026-09-17).
  const esperado = c.type === 'must-flag' ? 'hallazgos' : c.type === 'must-not-flag' ? 'sin-la-regla' : null;
  if (!esperado) { mal.push(`${c.id}: tipo desconocido ${c.type}`); continue; }
  if (c.expect_veredicto !== esperado) mal.push(`${c.id}: expect_veredicto=${c.expect_veredicto} (esperaba ${esperado})`);
}
console.log(d.cases.length === 5 ? '' : `se esperaban 5 casos, hay ${d.cases.length}`);
console.log(mal.length ? `ROJO ${mal.join(' · ')}` : 'VERDE');
JS
)"
if printf '%s' "${salida}" | grep '^VERDE$' >/dev/null; then ok "T16a los 5 casos del validador declaran expect_veredicto coherente con su tipo"; else bad "T16a casos del validador" "$(printf '%s' "${salida}" | tr '\n' ' ' | cut -c1-500)"; fi

salida="$(node "${RUNNER}" --selftest-retro 2>&1)"
rc=$?
if [ "${rc}" -eq 0 ] && printf '%s' "${salida}" | grep 'selftest-retro: VEREDICTO' >/dev/null; then
  ok "T16b el autotest del banco parsea el renglón Veredicto (y sale verde)"
else
  bad "T16b autotest del banco" "rc=${rc}; $(printf '%s' "${salida}" | grep -i 'veredicto\|❌' | tr '\n' ' ' | cut -c1-400)"
fi

echo
if [ "${fallos}" -eq 0 ]; then echo "veredicto-validador: todo verde"; exit 0; fi
echo "veredicto-validador: ${fallos} en rojo"; exit 1
