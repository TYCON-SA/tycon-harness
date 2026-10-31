#!/usr/bin/env bash
# dashboard-runs.test.sh — los casos de la vista de corridas del tablero.
#
# 🔴 REGLA DE ADMISIÓN (la misma que dashboard.test.sh): cada caso trae escrita la MUTACIÓN que lo
#    pone en rojo. Un caso que no sabe ponerse rojo no vale.
#
# Sin red. El registro de corridas se FABRICA en un temporal (`--runs-dir`): nunca se lee el de la
# máquina. El exit code se lee ANTES de cualquier pipe. La capa ejecutiva se dibuja en el cliente
# (para que el filtro la recalcule), así que los casos que la miran corren el cliente REAL sobre un
# DOM mínimo en Node — la misma técnica del `harness.js` del prototipo — sin navegador.
#
# bash 3.2 (macOS): siempre `${v}`, nunca `«$v»`.

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TABLERO="${RAIZ}/scripts/nightly/dashboard/dashboard.js"
# 🔴 La suite nunca lee la carpeta bajada del buzón de ESTA máquina: apunta a la nada.
export TYCON_MAILBOX_DIR="/nonexistent/tablero-corridas-test/corridas-buzon"
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }

# ── Huellas ANTES de correr nada (las lee T15, al final). La vista de corridas no tiene entregable
#    commiteado: su huella es AUSENTE y T15 exige que siga así. ──────────────────────
huella() { python3 -c "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$1" 2>/dev/null || echo AUSENTE; }
ENTREGABLE_CORRIDAS="${RAIZ}/artifacts/runs-dashboard.html"
ENTREGABLE_SEIS="${RAIZ}/artifacts/tablero-del-arnes.html"
HUELLA_CORRIDAS_ANTES="$(huella "${ENTREGABLE_CORRIDAS}")"
HUELLA_SEIS_ANTES="$(huella "${ENTREGABLE_SEIS}")"

# ── El fabricante de volcados ────────────────────────────────────────────────────────────────
# Un volcado COMPLETO y realista (la forma exacta del archivador: marker + gates + costo + consumo),
# con MARCADORES únicos en cada campo que la página NO puede publicar. Un parche JSON lo modifica:
# dicts se fusionan, listas y escalares se reemplazan, `null` borra la clave.
FX="$(mktemp -t fx.XXXXXX).py"
cat > "${FX}" <<'PY'
import json, sys, os, copy
from datetime import datetime, timedelta, timezone

def iso(t): return t.strftime('%Y-%m-%dT%H:%M:%S.') + '%03dZ' % (t.microsecond // 1000)

def base(sid, inicio):
    t0 = datetime.strptime(inicio, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
    m = lambda mins, secs=0: iso(t0 + timedelta(minutes=mins, seconds=secs))
    return {
      "archivedAt": m(125),
      "marker": {
        "storyId": "2.1",
        "storyPath": "/Users/dev/SourceCode/FUGA_STORYPATH/specs/story-2.1.md",
        "repoPath": "/Users/dev/SourceCode/Totora/FrontEnd",
        "sprint": 2,
        "sessionId": sid,
        "startedAt": m(0),
        "lastTouch": m(120),
        "stepsCompleted": [0,1,2,3,4,5,6,7,8],
        "stepsPending": [],
        "filesTouched": ["/Users/dev/SourceCode/FUGA_FILE_TOUCHED/a.ts"],
        "iterations": {"1": {"ts": m(90), "filesSnapshot": ["/Users/dev/FUGA_SNAPSHOT/b.ts"]}},
        "fileEvents": [{"path": "/Users/dev/FUGA_FILEEVENT/c.ts", "ts": m(40)}],
        "stepTimings": {"0": {"completedAt": m(1)}, "1": {"completedAt": m(10)}, "2": {"completedAt": m(12)},
                        "3": {"completedAt": m(14)}, "4": {"completedAt": m(40)}, "5": {"completedAt": m(95)},
                        "6": {"completedAt": m(100)}, "7": {"completedAt": m(102)}, "8": {"completedAt": m(118)}},
        "planApproval": {"text": "FUGA_PROMPT_DEL_DEV aprobado dale", "ts": m(14)},
        "adversarial": {"runId": "wf_FUGA_RUNID", "sessionId": sid},
        "dodRuntime": {"verdict": "PASS", "evidencePath": "/Users/dev/FUGA_EVIDENCE/.advisors/x.md"},
        "checks": {"build": "green", "tests": "green"}
      },
      "gates": [
        {"ts": m(20), "sessionId": sid, "check": "build", "status": "green", "cmd": "npm run build --prefix /private/tmp/FUGA_CMD_SCRATCH", "exit": 0, "durationMs": 11542},
        {"ts": m(25), "sessionId": sid, "check": "atdd-preedit", "status": "blocked", "cmd": "FUGA_CMD_2", "durationMs": 4},
        {"ts": m(26), "sessionId": sid, "check": "atdd-commit", "cmd": "FUGA_CMD_3"},
        {"ts": m(30), "sessionId": sid, "check": "tests", "status": "red:exit=1", "cmd": "npm test -- /Users/dev/FUGA_CMD_4", "exit": 1, "durationMs": 61000,
         "mensaje": "FAIL src/x.test.ts › caso 3\n  expected 2, got 3"}
      ],
      "costo": {"spawns": 19, "adhoc": 0, "iteraciones": 2,
                "por_tipo": {"tycon-story-validator": 4, "tycon-plugin-security-basics": 3, "tycon-silent-failure-hunter": 3}},
      "consumo": {"estado": "medido", "respuestas": 476, "sinteticos": 0, "lineas_ilegibles": 0,
                  "tokens": {"in": 952, "out": 306371, "cache_new": 1166940, "cache_read": 218153754},
                  "por_modelo": {"claude-opus-5": {"respuestas": 476, "in": 952, "out": 306371, "cache_new": 1166940, "cache_read": 218153754}},
                  "por_paso": {"0": 207372, "1": 162655, "4": 152838, "5": 876136, "8": 31482},
                  "fuera_de_ventana": 36484, "hilo_hasta": m(126), "medido_en": m(300)}
    }

def merge(a, b):
    for k, v in b.items():
        if v is None: a.pop(k, None)
        elif isinstance(v, dict) and isinstance(a.get(k), dict): merge(a[k], v)
        else: a[k] = v
    return a

d, sid = sys.argv[1], sys.argv[2]
inicio = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else '2026-08-15T05:53:47Z'
patch = json.loads(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] else {}
nombre = sys.argv[5] if len(sys.argv) > 5 else None
v = merge(base(sid, inicio), patch)
os.makedirs(d, exist_ok=True)
f = os.path.join(d, nombre or ('%s-%s.json' % (v['marker'].get('storyId', 'x'), sid[:8])))
json.dump(v, open(f, 'w'), indent=1)
PY
# volcado <dir> <sessionId> [<inicio ISO sin ms>] [<parche JSON>] [<nombre de archivo>]
volcado() { python3 "${FX}" "$@"; }

# ── El corredor del cliente SIN navegador ─────────────────────────────────────────────────────
# Toma la página generada, saca el modelo embebido y el script del cliente, monta un DOM mínimo y
# ejecuta el cliente REAL. Después contesta una pregunta: qué quedó dibujado en un contenedor, qué
# dibuja el detalle de la corrida N, o qué pasa con un filtro imposible.
CL="$(mktemp -t cl.XXXXXX).js"
cat > "${CL}" <<'JS'
const fs = require('fs');
const [html, op, arg] = [fs.readFileSync(process.argv[2], 'utf8'), process.argv[3], process.argv[4]];
const modelo = (html.match(/<script id="modelo" type="application\/json">([\s\S]*?)<\/script>/) || [])[1];
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (!modelo || !scripts.length) { console.error('la página no trae modelo o cliente'); process.exit(2); }
const cliente = scripts[scripts.length - 1];
const nodos = {};
const el = () => ({ innerHTML: '', textContent: '', value: '', checked: false, min: '', max: '', hidden: false, rows: [], oyentes: {},
  addEventListener(t, f) { (this.oyentes[t] = this.oyentes[t] || []).push(f); }, set onclick(f) {}, querySelectorAll: () => [], querySelector: () => el(), classList: { add() {}, remove() {}, contains: () => false } });
global.window = global; global.window.parent = global.window;
// La dirección y el «ahora» de la prueba vienen del entorno: CL_SEARCH (la parte «?…» de la dirección) y CL_NOW (un instante ISO).
// history.replaceState guarda la dirección que el cliente escribe en global.__url (null = no escribió nada).
global.location = { pathname: '/corridas', search: process.env.CL_SEARCH || '', hash: '' };
global.__url = null;
global.history = { replaceState(s, t, u) { global.__url = u; } };
if (process.env.CL_NOW) { const R = Date, ahora = R.parse(process.env.CL_NOW); global.Date = class extends R { constructor(...a) { super(...(a.length ? a : [ahora])); } static now() { return ahora; } }; }
global.document = { addEventListener() {}, querySelectorAll: () => [], createElement: () => el(),
  getElementById: (id) => id === 'modelo' ? { textContent: modelo } : (nodos[id] = nodos[id] || el()) };
// table-dates: la tabla viene con la página; una fila por corrida, con su celda de fecha como la dibuja el servidor (UTC)
if (op === 'table-dates') {
  nodos.cuerpo = el();
  nodos.cuerpo.rows = JSON.parse(modelo).corridas.map((c) => { const td = { firstChild: { nodeType: 3, nodeValue: (c.inicio || '').slice(0, 10) } };
    return { dataset: { id: c.id }, hidden: false, classList: { contains: () => false }, querySelector: (q) => (q === 'td.fecha' ? td : el()), _td: td }; });
}
eval(cliente);
const M = JSON.parse(modelo);
if (op === 'container') console.log(nodos[arg] ? nodos[arg].innerHTML : '');
else if (op === 'detail') console.log(window.__detalle(M.corridas[Number(arg)]));
else if (op === 'all') console.log(M.corridas.map((c) => window.__detalle(c)).join('\n'));
else if (op === 'impossible-filter') { nodos['f-desde'].value = '2030-01-01'; nodos['f-hasta'].value = '2030-12-31'; window.__aplicar(); console.log(nodos['fichas'].innerHTML); }
else if (op === 'usage-filter') { nodos['fc'].checked = true; window.__aplicar(); console.log(nodos['fichas'].innerHTML); }
else if (op === 'machine-filter') { nodos['f-maquina'].value = arg; window.__aplicar(); console.log(nodos['fichas'].innerHTML + '\n' + nodos['cuenta'].textContent); }
else if (op === 'link') console.log(JSON.stringify(window.__enlace()));
// preset-then «hoy|semana|mes» <contenedor>: aprieta el atajo y devuelve lo dibujado en el contenedor
else if (op === 'preset-then') { window.__atajo(arg); console.log(nodos[process.argv[5]] ? nodos[process.argv[5]].innerHTML : ''); }
else if (op === 'table-dates') { window.__atajo('hoy'); console.log(nodos.cuerpo.rows.map((r) => r._td.firstChild.nodeValue + (r.hidden ? ':oculta' : ':visible')).join(',')); }
else if (['state', 'set', 'change', 'check', 'preset', 'clear'].includes(op)) {
  // set «campo=valor;campo=valor» cambia campos y aplica; preset «hoy|semana|mes»; clear «limpiar»; state sólo lo lee.
  if (op === 'set') { for (const par of arg.split(';')) { const [k, ...v] = par.split('='); nodos[k].value = v.join('='); } window.__aplicar(); }
  // change «campo=valor»: como la persona, dispara los oyentes de «change» del campo (los que el código registró).
  if (op === 'change') { const [k, ...v] = arg.split('='); nodos[k].value = v.join('='); (nodos[k].oyentes.change || []).forEach((f) => f()); }
  // check «fc,ff»: marca las casillas como la persona, disparando sus oyentes de «change».
  if (op === 'check') { for (const k of arg.split(',')) { nodos[k].checked = true; (nodos[k].oyentes.change || []).forEach((f) => f()); } }
  if (op === 'preset') window.__atajo(arg);
  if (op === 'clear') window.__limpiar();
  const g = (id) => nodos[id] ? nodos[id].value : null;
  console.log(JSON.stringify({ desde: g('f-desde'), hasta: g('f-hasta'), repo: g('f-repo'), maquina: g('f-maquina'), fc: nodos.fc ? nodos.fc.checked : null, ff: nodos.ff ? nodos.ff.checked : null, cuenta: nodos['cuenta'].textContent, vistas: ((/n=(\d+) de (\d+) ejecuci(ón|ones)/.exec(nodos['fichas'].innerHTML) || [])[0] || 'ninguna').replace(/ ejecuci(ón|ones)/, ''), fichas: nodos['fichas'].innerHTML, url: global.__url }));
}
else { console.error('op desconocida'); process.exit(2); }
JS
cliente() { node "${CL}" "$@"; }

# Genera la vista sobre un registro; deja rc en RC y la página en $2.
generar() { node "${TABLERO}" --view runs --runs-dir "$1" --output "$2" >"$3" 2>&1; RC=$?; }
modelo_json() { node "${TABLERO}" --view runs --runs-dir "$1" --json --dry-run 2>/dev/null | python3 -c "
import json,sys
raw=sys.stdin.read()
i=raw.find('{'); print(json.dumps(json.loads(raw[i:])))"; }
# ¿Una frase aparece FUERA de todo <svg>…</svg>? Imprime 'fuera' / 'dentro' / 'ausente'.
fuera_del_svg() { python3 - "$1" "$2" <<'PY2'
import re, sys
h = open(sys.argv[1], encoding='utf8').read(); frase = sys.argv[2]
if frase not in h: print('ausente'); sys.exit()
sin_svg = re.sub(r'<svg[\s\S]*?</svg>', '', h)
print('fuera' if frase in sin_svg else 'dentro')
PY2
}

echo "== dashboard-runs.test.sh =="
S1="11111111-1111-4111-8111-111111111111"
S2="22222222-2222-4222-8222-222222222222"
S3="33333333-3333-4333-8333-333333333333"

# ── T1 · registro ausente → gris con motivo, exit 0, ningún cero dibujado ──────────────────────
# 🔴 Falla con: tratar la fuente como obligatoria (exit 2) o dibujar «0 corridas» en la ficha.
T=$(mktemp -d); generar "${T}/no-existe" "${T}/o.html" "${T}/log"
[ "${RC}" -eq 0 ] && ok "T1 registro ausente → exit 0 (fue ${RC})" || mal "T1 esperaba exit 0, fue ${RC}"
[ -f "${T}/o.html" ] && ok "T1 la página se escribió igual" || mal "T1 no escribió la página"
grep -q 'no está el registro de ejecuciones' "${T}/o.html" && ok "T1 la página dice el motivo" || mal "T1 falta el motivo del gris"
F="$(cliente "${T}/o.html" container fichas)"
grep -q 'tile blind' <<< "${F}" && ok "T1 las fichas salen con trama" || mal "T1 las fichas no salen con trama"
grep -q 't-val">0' <<< "${F}" && mal "T1 dibujó un cero donde hubo ausencia" || ok "T1 ningún cero dibujado"
rm -rf "${T}"

# ── T2 · sources.json declara la fuente y deja de decir que los tokens no se miden ─────────────
# 🔴 Falla con: dejar la entrada vieja de not_measurable_today («costo en tokens…: no existe fuente»).
python3 - "${RAIZ}/scripts/nightly/dashboard/sources.json" <<'PY2' && ok "T2 sources.json: fuente 'corridas' local no obligatoria; los tokens ya no figuran como no medibles" || mal "T2 sources.json no declara la fuente como corresponde (ver detalle arriba)"
import json, sys
c = json.load(open(sys.argv[1]))
f = [x for x in c['sources'] if x['id'] == 'corridas']
assert f, 'falta la fuente corridas'
assert f[0]['required'] is False, 'corridas tiene que ser required: false'
assert f[0].get('local') is True, 'corridas tiene que declararse local: true'
nm = [x['what'].lower() for x in c['not_measurable_today']]
assert not any('token' in q for q in nm), 'not_measurable_today sigue diciendo que los tokens no se miden'
assert any('plata' in q or 'dólar' in q or 'usd' in q for q in nm), 'la plata sigue siendo no medible y tiene que estar declarada'
PY2

# ── T3 · una corrida por sesión: dos archivos del mismo sessionId → una fila, la más nueva ──────
# 🔴 Falla con: contar archivos (el registro real trae corridas dobles).
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "" '{"archivedAt":"2026-08-15T09:00:00.000Z","marker":{"storyId":"VIEJA"}}' vieja.json
volcado "${T}/r" "${S1}" "" '{"archivedAt":"2026-08-15T10:00:00.000Z","marker":{"storyId":"NUEVA"}}' nueva.json
J="$(modelo_json "${T}/r")"
python3 -c "
import json,sys; m=json.loads(sys.argv[1]); c=m['corridas']
assert len(c)==1, 'esperaba 1 corrida, hay %d'%len(c)
assert c[0]['story']=='NUEVA', 'tomó la vieja: %s'%c[0]['story']
assert m['archivos']==2 and m['duplicados']==1, (m['archivos'], m['duplicados'])
" "${J}" && ok "T3 dos archivos de la misma sesión → una corrida, la del archivedAt mayor" || mal "T3 no deduplica por sessionId"
generar "${T}/r" "${T}/o.html" "${T}/log"
grep -q '1 ejecución' "${T}/log" && grep -q '2 archivos' "${T}/log" && ok "T3 el resumen dice «1 ejecución … 2 archivos»" || mal "T3 el resumen no dice ejecuciones vs archivos: $(cat "${T}/log")"
rm -rf "${T}"

# ── T3c · dos corridas de la MISMA sesión (arranques distintos) → dos filas, cada una con su consumo ──
# Cada corrida trae sólo el consumo de su tramo de la sesión: juntarlas en una perdería el de la otra.
# 🔴 Falla con: deduplicar por la sesión sola (queda una fila), o darles el mismo id (el enlace abre la otra).
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "2026-08-15T08:00:00Z" '{"marker":{"storyId":"PRIMERA"},"consumo":{"tokens":{"in":111},"tramo":{"desde":"2026-08-15T07:50:00.000Z","hasta":null}}}' primera.json
volcado "${T}/r" "${S1}" "2026-08-15T14:00:00Z" '{"marker":{"storyId":"SEGUNDA"},"consumo":{"tokens":{"in":222},"tramo":{"desde":"2026-08-15T13:50:00.000Z","hasta":null}}}' segunda.json
volcado "${T}/r" "${S2}" "2026-08-15T16:00:00Z" '{"marker":{"storyId":"SOLA"}}' sola.json
J="$(modelo_json "${T}/r")"
python3 - "${J}" "${RAIZ}" <<'PY2' && ok "T3c dos corridas de la misma sesión → dos filas con su consumo e ids distintos; la sesión de una sola conserva su id" || mal "T3c juntó dos corridas de la misma sesión (ver detalle arriba)"
import json, sys, subprocess
m = json.loads(sys.argv[1]); c = {x['story']: x for x in m['corridas']}
assert set(c) == {'PRIMERA', 'SEGUNDA', 'SOLA'}, sorted(c)
assert m['duplicados'] == 0, m['duplicados']
assert c['PRIMERA']['consumo']['tokens']['in'] == 111 and c['SEGUNDA']['consumo']['tokens']['in'] == 222
assert c['PRIMERA']['id'] != c['SEGUNDA']['id']
viejo = subprocess.run(['node', '-e', "process.stdout.write(require(process.argv[1]).idEstable(null, process.argv[2]))",
                        sys.argv[2] + '/scripts/nightly/dashboard/runs.js', '22222222-2222-4222-8222-222222222222'], capture_output=True, text=True).stdout
assert c['SOLA']['id'] == viejo, (c['SOLA']['id'], viejo)
PY2
rm -rf "${T}"

# ── T3d · dos corridas VIEJAS de la misma sesión (sin tramo) → el consumo de la sesión una sola vez ──
# Medidas antes del recorte, cada una trae el consumo de la sesión entera, y sin la conversación no se recalculan.
# 🔴 Falla con: publicar el consumo de las dos (se suma dos veces la sesión).
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "2026-08-15T08:00:00Z" '{"archivedAt":"2026-08-15T10:00:00.000Z","marker":{"storyId":"VIEJA-A"},"consumo":{"tokens":{"in":900}}}' vieja-a.json
volcado "${T}/r" "${S1}" "2026-08-15T14:00:00Z" '{"archivedAt":"2026-08-15T16:00:00.000Z","marker":{"storyId":"VIEJA-B"},"consumo":{"tokens":{"in":900}}}' vieja-b.json
J="$(modelo_json "${T}/r")"
python3 - "${J}" <<'PY2' && ok "T3d dos corridas viejas de la misma sesión → la archivada más tarde lleva el consumo, la otra sale «no medido»" || mal "T3d sumó dos veces el consumo de la sesión (ver detalle arriba)"
import json, sys
m = json.loads(sys.argv[1]); c = {x['story']: x for x in m['corridas']}
assert c['VIEJA-B']['consumo']['estado'] == 'medido' and c['VIEJA-B']['consumo']['tokens']['in'] == 900, c['VIEJA-B']['consumo']
assert c['VIEJA-A']['consumo']['estado'] == 'no_medido', c['VIEJA-A']['consumo']
assert 'sesión entera' in c['VIEJA-A']['consumo']['motivo'], c['VIEJA-A']['consumo']
PY2
rm -rf "${T}"

# ── T3b · un JSON roto y uno sin sessionId se CUENTAN y se dicen ───────────────────────────────
# 🔴 Falla con: `continue` mudo → el universo achica sin que nadie lo vea.
T=$(mktemp -d); mkdir -p "${T}/r"
volcado "${T}/r" "${S1}"
echo '{ esto no es json' > "${T}/r/roto.json"
volcado "${T}/r" "${S2}" "" '{"marker":{"sessionId":null}}' sin-sesion.json
generar "${T}/r" "${T}/o.html" "${T}/log"
grep -q '2 no se pudieron leer' "${T}/log" && ok "T3b el resumen cuenta los 2 archivos ilegibles" || mal "T3b el resumen no cuenta los ilegibles: $(cat "${T}/log")"
grep -q '2 no se pudieron leer' "${T}/o.html" && ok "T3b la página también lo dice" || mal "T3b la página calla los ilegibles"
rm -rf "${T}"

# ── T4 · ANTI-FUGA: ningún campo prohibido del volcado llega al HTML ───────────────────────────
# 🔴 Falla con: pasar el volcado entero al cliente (JSON.stringify del dump) → todo se filtra.
T=$(mktemp -d); volcado "${T}/r" "${S1}"; generar "${T}/r" "${T}/o.html" "${T}/log"
for marca in FUGA_STORYPATH FUGA_FILE_TOUCHED FUGA_SNAPSHOT FUGA_FILEEVENT FUGA_PROMPT_DEL_DEV wf_FUGA_RUNID FUGA_EVIDENCE FUGA_CMD "${S1}" "/Users/" "/private/tmp"; do
  n="$(grep -c -F -- "${marca}" "${T}/o.html")"
  [ "${n}" -eq 0 ] && ok "T4 no se filtra ${marca}" || mal "T4 SE FILTRA ${marca} (${n} veces)"
done
rm -rf "${T}"

# ── T4b · el mensaje rescatado pasa OTRA VEZ por el saneado al dibujarse ───────────────────────
# 🔴 Falla con: confiar en que el rescate ya saneó → un volcado viejo publica la ruta del cliente.
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "" '{"gates":[{"ts":"2026-08-15T06:23:47.000Z","check":"tests","status":"red:exit=1","cmd":"x","exit":1,"mensaje":"error en /Users/dev/SourceCode/Cliente Grande SA/a.ts sesión 99999999-9999-4999-8999-999999999999"}]}'
generar "${T}/r" "${T}/o.html" "${T}/log"
grep -q 'Cliente Grande' "${T}/o.html" && mal "T4b el nombre del cliente llegó a la página" || ok "T4b la ruta del cliente no llega"
grep -q '99999999-9999' "${T}/o.html" && mal "T4b el identificador de sesión del mensaje llegó a la página" || ok "T4b el identificador del mensaje no llega"
D="$(cliente "${T}/o.html" detail 0)"
grep -q '&lt;ruta&gt;' <<< "${D}" && ok "T4b el mensaje se dibuja con <ruta> tapada" || mal "T4b el detalle no muestra el mensaje saneado"
rm -rf "${T}"

# ── T19b · el mismo repo, clonado en otra carpeta de proyectos, es el MISMO producto ──
# 🔴 Falla con: contar sólo «SourceCode» como contenedor → las corridas de DevB (proyectos en otra carpeta)
#    parten un producto en dos en el filtro de la vista multi-máquina («HostApi» y «Projects/HostApi»).
CORR216="${RAIZ}/scripts/nightly/dashboard/runs.js"
R216="$(HOME=/Users/otro node -e "const p=require('${CORR216}').producto;console.log([p('/Users/devb/Projects/HostApi'),p('/home/devb/src/HostApi'),p('/Users/devb/Projects/FRESNO/specs'),p('/Users/a/SourceCode/FRESNO/specs'),p('/Users/a/SourceCode/HostApi')].join('|'))")"
[ "${R216}" = "HostApi|HostApi|FRESNO/specs|FRESNO/specs|HostApi" ] && ok "2.16-T19b cualquier carpeta de proyectos directa bajo el usuario es contenedor; los repos anidados siguen con su padre" || mal "2.16-T19b producto() dio: ${R216}"

# ── T4c · el producto es el nombre corto, nunca la ruta ────────────────────────────────────────
# 🔴 Falla con: publicar repoPath (T4 lo caza; éste fija la FORMA correcta).
T=$(mktemp -d); volcado "${T}/r" "${S1}"
volcado "${T}/r" "${S2}" "" '{"marker":{"repoPath":"/Users/dev/SourceCode/tycon-claude-guides"}}'
J="$(modelo_json "${T}/r")"
python3 -c "
import json,sys; c=json.loads(sys.argv[1])['corridas']; p=sorted(x['producto'] for x in c)
assert p==['Totora/FrontEnd','tycon-claude-guides'], p
" "${J}" && ok "T4c producto = Totora/FrontEnd y tycon-claude-guides (nombre corto)" || mal "T4c el producto no es el nombre corto"
rm -rf "${T}"

# ── T5 · sin `costo` no es «0 agentes» ─────────────────────────────────────────────────────────
# 🔴 Falla con: rellenar con 0 → la mediana baja en silencio.
T=$(mktemp -d); volcado "${T}/r" "${S1}"
volcado "${T}/r" "${S2}" "2026-08-16T05:53:47Z" '{"costo":null}'
generar "${T}/r" "${T}/o.html" "${T}/log"
F="$(cliente "${T}/o.html" container fichas)"
grep -q 'n=1 de 2 ejecuciones' <<< "${F}" && ok "T5 la ficha de agentes dice n=1 de 2" || mal "T5 la ficha de agentes no excluye la ejecución sin costo"
J="$(modelo_json "${T}/r")"
IDX="$(python3 -c "import json,sys; c=json.loads(sys.argv[1])['corridas']; print([i for i,x in enumerate(c) if x['costo'] is None][0])" "${J}")"
D="$(cliente "${T}/o.html" detail "${IDX}")"
grep -qE 'no registra|no trae el conteo' <<< "${D}" && ok "T5 el detalle dice que no registra agentes" || mal "T5 el detalle calla la ausencia de costo"
grep -q '0 agentes' <<< "${D}" && mal "T5 el detalle dice «0 agentes»" || ok "T5 el detalle no dice «0 agentes»"
rm -rf "${T}"

# ── T6 · sin `gates` no es verde ───────────────────────────────────────────────────────────────
# 🔴 Falla con: `gates || []` → cero errores, chip verde.
T=$(mktemp -d); volcado "${T}/r" "${S1}"
volcado "${T}/r" "${S2}" "2026-08-16T05:53:47Z" '{"gates":null}'
generar "${T}/r" "${T}/o.html" "${T}/log"
J="$(modelo_json "${T}/r")"
IDX="$(python3 -c "import json,sys; c=json.loads(sys.argv[1])['corridas']; print([i for i,x in enumerate(c) if x['controles'] is None][0])" "${J}")"
D="$(cliente "${T}/o.html" detail "${IDX}")"
grep -q 'no registró evaluaciones de controles' <<< "${D}" && ok "T6 el detalle dice que no registró controles" || mal "T6 el detalle no declara la ausencia de controles"
grep -q '0 con error' <<< "${D}" && mal "T6 el detalle pinta «0 con error»" || ok "T6 no dice «0 con error»"
F="$(cliente "${T}/o.html" container fichas)"
grep -q 'de 1 ejecución con controles' <<< "${F}" && ok "T6 la ficha de errores cuenta sólo la ejecución con controles" || mal "T6 la ficha de errores no dice «de 1 ejecución con controles»"
rm -rf "${T}"

# ── T7 · consumo borrado no es «0 tokens» ──────────────────────────────────────────────────────
# 🔴 Falla con: contar tokens: 0 → la mediana se desploma.
T=$(mktemp -d); volcado "${T}/r" "${S1}"
volcado "${T}/r" "${S2}" "2026-08-16T05:53:47Z" '{"consumo":{"estado":"borrada","motivo":"MOTIVO_DEL_VOLCADO la conversación ya no está","tokens":null,"por_modelo":null,"por_paso":null,"fuera_de_ventana":null,"respuestas":null}}'
generar "${T}/r" "${T}/o.html" "${T}/log"
F="$(cliente "${T}/o.html" container fichas)"
grep -q 'Tokens de una ejecución' <<< "${F}" && grep -q 'n=1 de 2 ejecuciones' <<< "${F}" && ok "T7 la mediana de tokens excluye la ejecución borrada (n=1 de 2)" || mal "T7 la mediana de tokens no excluye la borrada"
J="$(modelo_json "${T}/r")"
IDX="$(python3 -c "import json,sys; c=json.loads(sys.argv[1])['corridas']; print([i for i,x in enumerate(c) if x['consumo']['estado']=='borrada'][0])" "${J}")"
D="$(cliente "${T}/o.html" detail "${IDX}")"
grep -q 'MOTIVO_DEL_VOLCADO' <<< "${D}" && ok "T7 el detalle muestra el motivo del volcado" || mal "T7 el detalle no muestra el motivo"
grep -q '0 tokens' <<< "${D}" && mal "T7 el detalle dice «0 tokens»" || ok "T7 no dice «0 tokens»"
rm -rf "${T}"

# ── T7b · el MOTIVO que viene del volcado también se sanea ─────────────────────────────────────
# 🔴 Falla con: el motivo de «borrada» del rescate dice «se buscó
#    <sessionId>.jsonl en las 1970 carpetas» → 144 identificadores de sesión en la página.
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "" '{"consumo":{"estado":"borrada","motivo":"se buscó 77777777-7777-4777-8777-777777777777.jsonl bajo /Users/dev/.claude/projects","tokens":null,"por_modelo":null,"por_paso":null,"fuera_de_ventana":null,"respuestas":null}}'
generar "${T}/r" "${T}/o.html" "${T}/log"
grep -q '77777777-7777' "${T}/o.html" && mal "T7b el identificador de sesión del motivo llegó a la página" || ok "T7b el motivo del volcado sale sin identificador de sesión"
grep -q '/Users/dev' "${T}/o.html" && mal "T7b la ruta del motivo llegó a la página" || ok "T7b el motivo del volcado sale sin ruta"
rm -rf "${T}"

# ── T8 · medianas con n y universo; semanas vacías del medio en 0 ──────────────────────────────
# 🔴 Falla con: omitir la semana sin corridas (el eje miente) o sacar el denominador.
#    Duraciones DISTINTAS (1 h, 2 h, 4 h): un fixture empatado esconde el criterio.
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "2026-08-10T05:00:00Z" '{"marker":{"lastTouch":"2026-08-10T06:00:00.000Z"}}'
volcado "${T}/r" "${S2}" "2026-08-11T05:00:00Z" '{"marker":{"lastTouch":"2026-08-11T07:00:00.000Z"}}'
volcado "${T}/r" "${S3}" "2026-08-25T05:00:00Z" '{"marker":{"lastTouch":"2026-08-25T09:00:00.000Z"}}'
generar "${T}/r" "${T}/o.html" "${T}/log"
F="$(cliente "${T}/o.html" container fichas)"
grep -q '>2 h<' <<< "${F}" && grep -q 'n=3 de 3 ejecuciones' <<< "${F}" && ok "T8 mediana de duración 2 h con n=3 de 3" || mal "T8 la mediana o su denominador no están"
G="$(cliente "${T}/o.html" container gsem)"
grep -q 'S34: 0 ejecuciones' <<< "${G}" && ok "T8 la semana vacía del medio (S34) se dibuja con 0" || mal "T8 la semana vacía del medio no aparece"
rm -rf "${T}"

# ── T9 · el filtro recalcula: con un rango imposible no quedan números ─────────────────────────
# 🔴 Falla con: dibujar la capa ejecutiva en el servidor → el filtro no la toca.
T=$(mktemp -d); volcado "${T}/r" "${S1}"; generar "${T}/r" "${T}/o.html" "${T}/log"
F="$(cliente "${T}/o.html" impossible-filter)"
grep -q '0 ejecuciones' <<< "${F}" && ok "T9 con el filtro imposible dice «0 ejecuciones» (story 2.79, AC 60)" || mal "T9 el filtro imposible no dice «0 ejecuciones»"
grep -q 'n=1 de 1' <<< "${F}" && mal "T9 la capa ejecutiva siguió mostrando números viejos" || ok "T9 no quedan números viejos"
# ── T9b · sin red ──
# 🔴 Falla con: pedir la tipografía a Google → la página depende de la red.
grep -q -E 'https?://|fonts\.googleapis' "${T}/o.html" && mal "T9b la página pide algo por red" || ok "T9b la página no referencia ninguna URL"
rm -rf "${T}"

# ── T10 · «sin estado» nunca cuenta como «pasó» ────────────────────────────────────────────────
# 🔴 Falla con: `status && status !== 'green'` → la sin estado entra como pasó.
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "" '{"gates":[{"ts":"2026-08-15T06:10:00.000Z","check":"a","cmd":"x"},{"ts":"2026-08-15T06:11:00.000Z","check":"b","status":"red:exit=1","cmd":"x","exit":1},{"ts":"2026-08-15T06:12:00.000Z","check":"c","status":"blocked","cmd":"x"},{"ts":"2026-08-15T06:13:00.000Z","check":"d","status":"green","cmd":"x"}]}'
J="$(modelo_json "${T}/r")"
python3 -c "
import json,sys; k=json.loads(sys.argv[1])['corridas'][0]['controles']
assert (k['sin_estado'],k['error'],k['freno'],k['paso'])==(1,1,1,1), k
" "${J}" && ok "T10 1 sin estado · 1 error · 1 frenó · 1 pasó" || mal "T10 la clasificación cuenta mal (sin estado como pasó?)"
rm -rf "${T}"

# ── T11 · rebotes idénticos y consecutivos se agrupan ×N; iguales SEPARADOS no ─────────────────
# 🔴 Falla con: no agrupar (cinco filas tapan la corrida) / agrupar sin exigir adyacencia (borra una vuelta).
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "" '{"gates":[{"ts":"2026-08-15T06:35:02.000Z","check":"atdd-preedit","status":"blocked","cmd":"x"},{"ts":"2026-08-15T06:35:16.000Z","check":"atdd-preedit","status":"blocked","cmd":"x"},{"ts":"2026-08-15T06:35:20.000Z","check":"atdd-preedit","status":"blocked","cmd":"x"},{"ts":"2026-08-15T06:35:30.000Z","check":"atdd-preedit","status":"blocked","cmd":"x"},{"ts":"2026-08-15T06:35:34.000Z","check":"atdd-preedit","status":"blocked","cmd":"x"}]}'
volcado "${T}/r" "${S2}" "2026-08-16T05:53:47Z" '{"gates":[{"ts":"2026-08-16T06:35:02.000Z","check":"shared-surface","status":"blocked","cmd":"x"},{"ts":"2026-08-16T06:40:02.000Z","check":"shared-surface","status":"green","cmd":"x"},{"ts":"2026-08-16T06:45:02.000Z","check":"shared-surface","status":"blocked","cmd":"x"}]}'
J="$(modelo_json "${T}/r")"
python3 -c "
import json,sys; c=json.loads(sys.argv[1])['corridas']
a=[x for x in c if x['story']=='2.1' and x['inicio'].startswith('2026-08-15')][0]
g=[e for e in a['eventos_agrupados'] if e['cls']=='freno']
assert len(g)==1 and g[0]['n']==5, g
b=[x for x in c if x['inicio'].startswith('2026-08-16')][0]
gb=[e for e in b['eventos_agrupados'] if e['cls']=='freno']
assert len(gb)==2 and all(e['n']==1 for e in gb), gb
" "${J}" && ok "T11 cinco rebotes seguidos → un grupo ×5 · T11b blocked·green·blocked → dos grupos" || mal "T11/T11b el agrupado no distingue consecutivo de separado"
generar "${T}/r" "${T}/o.html" "${T}/log"
D="$(cliente "${T}/o.html" all)"
grep -q '×5' <<< "${D}" && ok "T11 el detalle muestra ×5" || mal "T11 el detalle no muestra ×5"
grep -q '×2' <<< "${D}" && mal "T11b el detalle fundió dos frenos separados en ×2" || ok "T11b no aparece ×2"
rm -rf "${T}"

# ── T12 · un rojo sin mensaje lo dice; con mensaje, lo muestra ─────────────────────────────────
# 🔴 Falla con: dejar la celda vacía → «encontró un error · salida 2» sin decir cuál.
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "" '{"gates":[{"ts":"2026-08-15T06:10:00.000Z","check":"build","status":"red:exit=2","cmd":"x","exit":2},{"ts":"2026-08-15T06:20:00.000Z","check":"tests","status":"red:exit=1","cmd":"x","exit":1,"mensaje":"MENSAJE_RESCATADO expected 2 got 3"}]}'
generar "${T}/r" "${T}/o.html" "${T}/log"
D="$(cliente "${T}/o.html" detail 0)"
grep -q 'se rescata de la conversación' <<< "${D}" && ok "T12 el rojo sin mensaje remite al rescate de la conversación" || mal "T12 el rojo sin mensaje queda mudo"
grep -q 'MENSAJE_RESCATADO' <<< "${D}" && ok "T12 el rojo con mensaje lo muestra" || mal "T12 el mensaje rescatado no se muestra"
# ── T12b · un control que no está en el diccionario sale con su nombre técnico, no se descarta ──
# 🔴 Falla con: filtrar por diccionario → un freno nuevo desaparece de la tabla.
volcado "${T}/r" "${S2}" "2026-08-16T05:53:47Z" '{"gates":[{"ts":"2026-08-16T06:10:00.000Z","check":"nuevo-freno-desconocido","status":"blocked","cmd":"x"}]}'
generar "${T}/r" "${T}/o.html" "${T}/log"
D="$(cliente "${T}/o.html" all)"
grep -q 'nuevo-freno-desconocido' <<< "${D}" && ok "T12b el control desconocido aparece con su nombre técnico" || mal "T12b el control desconocido desapareció"
rm -rf "${T}"

# ── T13 · T5 Dashboard_StepNamesFromTable — los nombres de paso salen de lib/steps.js ─────
# 🔴 Falla con: leer el título `# Step N — …` de cada archivo de paso (los nombres llanos salen de otra tabla) / tipear los nombres acá (se separan de la tabla). Un archivo de paso con otro título no cambia nada:
# TYCON_SKILLS_DIR apunta a propósito a un skill con un título viejo, para probar que ya no se lee de ahí.
T=$(mktemp -d); volcado "${T}/r" "${S1}"
mkdir -p "${T}/skills/tycon-pipeline/steps"
printf '# Step 4 — TITULO_VIEJO\n' > "${T}/skills/tycon-pipeline/steps/step-05-implement.md"
J="$(TYCON_SKILLS_DIR="${T}/skills" modelo_json "${T}/r")"
python3 -c "
import json,sys; p=json.loads(sys.argv[1])['pasos']
assert p['fuente']=='tabla', p
n=p['nombres']
assert len(n)==10, n
assert n[0]=='Arranque' and n[4]=='Implementar' and n[5]=='Correr las pruebas' and n[6]=='Implementar + pruebas' and n[7]=='Revisores' and n[9]=='Preparar el commit', n
assert 'TITULO_VIEJO' not in json.dumps(n), n
" "${J}" && ok "T13 (7.23-T5) los pasos se llaman como en lib/steps.js, no como el título de su archivo" || mal "T13 (7.23-T5) los nombres no salen de lib/steps.js: ${J:0:300}"
R="$(node -e "const p=require('${RAIZ}/scripts/nightly/dashboard/runs.js').nombresDePasos('${T}/nada/steps.js');console.log(p.fuente+' · '+p.nombres.join(',')+' · '+p.motivo)")"
grep -q '^numeros · 0,1,2,3,4,5,6,7,8,9 · .*no se pudo cargar' <<< "${R}" && ok "T13 sin la tabla, números con motivo" || mal "T13 sin la tabla dio: ${R}"
rm -rf "${T}"

# ── T13b · las notas (fuera de ventana, evaluaciones previas) van FUERA del SVG ────────────────
# 🔴 Falla con: escribirlas dentro del SVG → se montan sobre el eje.
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "" '{"consumo":{"fuera_de_ventana":349000},"gates":[{"ts":"2026-08-15T05:40:00.000Z","check":"build","status":"green","cmd":"x"},{"ts":"2026-08-15T06:10:00.000Z","check":"build","status":"green","cmd":"x"}]}'
generar "${T}/r" "${T}/o.html" "${T}/log"
cliente "${T}/o.html" detail 0 > "${T}/det.html"
for frase in 'después del último paso' 'anteriores al inicio'; do
  r="$(fuera_del_svg "${T}/det.html" "${frase}")"
  [ "${r}" = fuera ] && ok "T13b «${frase}» está fuera del SVG" || mal "T13b «${frase}» está ${r} (tiene que estar fuera del SVG)"
done
rm -rf "${T}"

# ── T14 · la presentación compartida vive UNA vez, en common.js ─────────────────────────────────
# 🔴 Falla con: copiar `ficha`/`chip`/`juzgar`/`esc` de vuelta en dashboard.js → dos copias que se separan.
n="$(grep -c -E '^(function (ficha|chip|juzgar)\(|const (esc|GLIFO) =)' "${RAIZ}/scripts/nightly/dashboard/dashboard.js")"
[ "${n}" -eq 0 ] && ok "T14 dashboard.js no redefine la presentación compartida" || mal "T14 dashboard.js redefine ${n} pieza(s) de common.js"
node -e "const c=require('${RAIZ}/scripts/nightly/dashboard/common.js');for(const k of ['esc','chip','ficha','juzgar','medida','noMedida','ratio','mediana','CSS_BASE'])if(!(k in c))process.exit(1)" && ok "T14 common.js exporta esc/chip/ficha/juzgar/medida/noMedida/ratio/mediana/CSS_BASE" || mal "T14 common.js no exporta lo compartido"
grep -q "require('./common')" "${RAIZ}/scripts/nightly/dashboard/dashboard.js" && grep -q "require('./common')" "${RAIZ}/scripts/nightly/dashboard/runs.js" && ok "T14 las dos vistas requieren common.js" || mal "T14 alguna vista no requiere common.js"

# ── T16 · contrato de salida ──────────────────────────────────────────────────────────────────
# 🔴 Falla con: salir 0 sin escribir → «midió» sin página.
T=$(mktemp -d); volcado "${T}/r" "${S1}"
node "${TABLERO}" --view runs --runs-dir "${T}/r" --output "${T}/no-existe/sub/o.html" >/dev/null 2>&1; RC=$?
[ "${RC}" -eq 3 ] && ok "T16 carpeta de salida imposible → exit 3 (fue ${RC})" || mal "T16 esperaba exit 3, fue ${RC}"
mkdir -p "${T}/dash"
node "${TABLERO}" --dir "${T}/dash" --output "${T}/seis.html" >/dev/null 2>&1; RC=$?
[ "${RC}" -eq 2 ] && grep -q 'El arnés en seis preguntas' "${T}/seis.html" && ok "T16 sin --view genera la de seis preguntas como siempre (exit 2 por fuentes ausentes, página escrita)" || mal "T16 sin --view no generó la de seis preguntas (rc=${RC})"
# ── T18 · las dos páginas se enlazan con ruta RELATIVA ──
# 🔴 Falla con: poner la ruta absoluta del disco → el enlace se rompe en otra máquina y en el artifact.
generar "${T}/r" "${T}/o.html" "${T}/log"
# La vista de corridas se arma en cada máquina y no vive al lado de la de seis preguntas → se NOMBRAN,
# no se enlazan (un href relativo quedaría roto en las dos).
grep -q 'artifacts/tablero-del-arnes.html' "${T}/o.html" && ! grep -q 'href="tablero-del-arnes.html"' "${T}/o.html" && ok "T18 la de ejecuciones nombra a la de seis preguntas sin un enlace roto" || mal "T18 la de ejecuciones no nombra a la de seis preguntas (o la enlaza con una ruta que no existe)"
grep -q 'dashboard.js --view runs' "${T}/seis.html" && ! grep -q 'href="runs-dashboard.html"' "${T}/seis.html" && ok "T18 la de seis preguntas dice cómo armar la de ejecuciones, sin enlace roto" || mal "T18 la de seis preguntas enlaza a una vista que ya no está en el repo (o no dice cómo armarla)"
grep -q 'href="/' "${T}/o.html" && mal "T18 hay un enlace con ruta absoluta" || ok "T18 ningún enlace absoluto"
rm -rf "${T}"

# ── T19 · producto() no depende del $HOME de quien genera; ramas por posición ──────────────────
# 🔴 Falla con: con HOME=/Users/devb, '/Users/deva/algun-repo' publica «deva/algun-repo».
CORR="${RAIZ}/scripts/nightly/dashboard/runs.js"
R="$(HOME=/Users/otro node -e "const p=require('${CORR}').producto;console.log([p('/Users/deva/algun-repo'),p('/home/devb/x'),p(['C:','Users','devb','Repo'].join(String.fromCharCode(92))),p('/private/tmp/claude-501/-Users-a-b/00000000-0000-4000-8000-000000000013/scratchpad/tcg-2.3'),p('/Users/a/SourceCode/Totora/FrontEnd'),p('')].join('|'))")"
# El clon del scratchpad es el repo de la sesión que lo lanzó («b»), no el nombre del clon.
[ "${R}" = "algun-repo|x|Repo|b|Totora/FrontEnd|" ] && ok "T19 producto() esconde el usuario por posición en la ruta, con cualquier HOME" || mal "T19 producto() dio: ${R}"
# ── T20 · clasificar(): la rama «otro» existe y no cae en «pasó» ──
# 🔴 Falla con: un estado desconocido contado como pasó.
R="$(node -e "const c=require('${CORR}').clasificar;console.log([c('green'),c('red:exit=1'),c('blocked'),c(undefined),c(''),c('raro-estado')].join('|'))")"
[ "${R}" = "paso|error|freno|sin_estado|sin_estado|otro" ] && ok "T20 clasificar(): paso · error · freno · sin_estado ×2 · otro" || mal "T20 clasificar() dio: ${R}"
# ── T20 · la guía de QA anota «presente» y «no-aplica»: los dos son «pasó» ──
# 🔴 Falla con: caen en «otro» → la vista muestra «estado no reconocido» en cada cierre con la guía bien.
R="$(node -e "const c=require('${CORR}').clasificar;console.log([c('presente'),c('no-aplica')].join('|'))")"
[ "${R}" = "paso|paso" ] && ok "2.8-T20 clasificar(): presente y no-aplica son «miró y dejó pasar»" || mal "2.8-T20 clasificar() dio: ${R}"

# ── T21 · el gráfico de TOKENS por paso declara los tramos fusionados (como el de tiempo) ──────
# 🔴 Falla con: pasar 0 como «fusionados» → el 95 % del consumo de una corrida desaparece sin nota.
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "" '{"marker":{"stepTimings":{"5":{"completedAt":"2026-08-15T07:28:47.000Z"},"6":{"completedAt":"2026-08-15T07:20:47.000Z"}}},"consumo":{"por_paso":{"0":10000,"1":10000,"4":10000,"5+6":600000,"8":10000}}}'
generar "${T}/r" "${T}/o.html" "${T}/log"
K="$(cliente "${T}/o.html" container ppk)"
grep -q 'marcas invertidas o empatadas' <<< "${K}" && ok "T21 ppk declara la ejecución con tramo fusionado" || mal "T21 ppk calla el tramo fusionado (600 k tokens invisibles)"
rm -rf "${T}"

# ── T22 · «quedó en <paso>» con huecos en stepsCompleted ─────────────────────────────────────
# 🔴 Falla con: length-1 → [0,1,4,5,6,7] dice «quedó en Revisores». Las filas: el 6 y el 7 viejos son Hallazgos (fila 8).
T=$(mktemp -d); volcado "${T}/r" "${S1}" "" '{"marker":{"stepsCompleted":[0,1,4,5,6,7]}}'
J="$(modelo_json "${T}/r")"
python3 -c "
import json,sys; c=json.loads(sys.argv[1])['corridas'][0]; assert c['ultimo_paso']==8 and not c['llego_al_final'], c['ultimo_paso']" "${J}" && ok "T22 ultimo_paso = la fila de Hallazgos con huecos" || mal "T22 ultimo_paso mal calculado"
generar "${T}/r" "${T}/o.html" "${T}/log"; grep -q 'quedó en Hallazgos' "${T}/o.html" && ok "T22 la fila dice «quedó en Hallazgos»" || mal "T22 la fila no dice «quedó en Hallazgos»"
rm -rf "${T}"

# ── T22b · «quedó en» el paso que arrancó y no terminó, no en el último terminado ─────────────
# 🔴 Falla con: tomar sólo stepsCompleted → una ejecución archivada a mitad de implementar dice «quedó en Aprobar
#    el plan», y la trama dice «sin marca» por pasos que nunca corrieron (caso real de la pestaña Ejecuciones).
for CASO in '4|Implementar + pruebas' 'implement|Implementar'; do
  PASO="${CASO%%|*}"; NOMBRE="${CASO#*|}"
  T=$(mktemp -d)
  volcado "${T}/r" "${S1}" "" '{"marker":{"startedAt":"2026-10-22T14:10:37.000Z","stepsCompleted":[0,1,2,3],"stepTimings":{"0":{"startedAt":"2026-10-22T14:10:37.000Z","completedAt":"2026-10-22T14:11:16.000Z"},"1":{"completedAt":"2026-10-22T14:13:46.000Z"},"2":{"startedAt":"2026-10-22T14:14:03.000Z","completedAt":"2026-10-22T14:49:12.000Z"},"3":{"completedAt":"2026-10-22T14:50:03.000Z"},"4":null,"5":null,"6":null,"7":null,"8":null,"'"${PASO}"'":{"startedAt":"2026-10-22T14:50:03.600Z","completedAt":null},"0b":{"startedAt":"2026-10-22T14:10:45.000Z"}}}}'
  generar "${T}/r" "${T}/o.html" "${T}/log"
  grep -q "quedó en ${NOMBRE}<" "${T}/o.html" && ok "T22b (${PASO}) la fila dice «quedó en ${NOMBRE}»" || mal "T22b (${PASO}) la fila no dice «quedó en ${NOMBRE}»: $(grep -o 'quedó en [^<]*' "${T}/o.html" | head -1)"
  grep -q "${NOMBRE} quedó sin terminar; [1-9] paso(s) no se llegaron a correr\"" "${T}/o.html" && ok "T22b (${PASO}) la trama dice qué quedó sin terminar y cuántos no corrieron" || mal "T22b (${PASO}) la trama no lo dice: $(grep -o 'title="[^"]*sin terminar[^"]*"' "${T}/o.html" | head -1)"
  D="$(cliente "${T}/o.html" detail 0)"
  grep -q "quedó en ${NOMBRE}" <<< "${D}" && grep -q "${NOMBRE} quedó sin terminar; [1-9] paso(s) no se llegaron a correr" <<< "${D}" && ok "T22b (${PASO}) el detalle dice lo mismo" || mal "T22b (${PASO}) el detalle no lo dice"
  rm -rf "${T}"
done

# ── T22c · los otros casos de «quedó en» y de la trama ─────────────────────────────────────────
# 🔴 Falla con: contar como «no se llegaron a correr» las filas anteriores a donde quedó (corrieron sin marca); tomar
#    un arranque viejo sin cierre, o una fecha inválida, como el paso en curso; no ver la otra vuelta de revisores.
caso_22c() {  # $1 nombre · $2 parche del marcador · $3 «quedó en» esperado · $4 trama esperada (sin el title=)
  local T; T=$(mktemp -d)
  volcado "${T}/r" "${S1}" "" "$2"
  generar "${T}/r" "${T}/o.html" "${T}/log"
  grep -q "quedó en $3<" "${T}/o.html" && grep -q "title=\"$4\"" "${T}/o.html" && ok "T22c $1" || mal "T22c $1: $(grep -o 'quedó en [^<]*' "${T}/o.html" | head -1) · $(grep -o 'class="falta"[^>]*title="[^"]*"' "${T}/o.html" | head -1)"
  rm -rf "${T}"
}
BASE22='"stepsCompleted":[0,1,2,3],"stepTimings":{"0":{"startedAt":"2026-10-22T14:10:37.000Z","completedAt":"2026-10-22T14:11:16.000Z"},"1":{"completedAt":"2026-10-22T14:13:46.000Z"},"2":{"startedAt":"2026-10-22T14:14:03.000Z","completedAt":"2026-10-22T14:49:12.000Z"},"3":{"completedAt":"2026-10-22T14:50:03.000Z"},"4":null,"5":null,"6":null,"7":null,"8":null'
caso_22c 'sin paso a medias: «no se llegaron a correr», sin nombrar ninguno' \
  '{"marker":{"startedAt":"2026-10-22T14:10:37.000Z",'"${BASE22}"'}}}' 'Aprobar el plan' '4 paso(s) no se llegaron a correr'
caso_22c 'un arranque viejo sin cierre, anterior a lo terminado, no es el paso en curso' \
  '{"marker":{"startedAt":"2026-10-22T14:10:37.000Z",'"${BASE22}"',"1":{"startedAt":"2026-10-22T14:12:00.000Z","completedAt":null}}}}' 'Aprobar el plan' '4 paso(s) no se llegaron a correr; 1 paso(s) sin marca'
caso_22c 'una fecha de arranque inválida no cuenta como arrancado' \
  '{"marker":{"startedAt":"2026-10-22T14:10:37.000Z",'"${BASE22}"',"4":{"startedAt":"ayer"}}}}' 'Aprobar el plan' '3 paso(s) no se llegaron a correr'
caso_22c 'otra vuelta de revisores, arrancada después de cerrar Hallazgos' \
  '{"marker":{"startedAt":"2026-10-22T14:10:37.000Z","stepsCompleted":[0,1,2,3,4,5,6],"stepTimings":{"5":{"startedAt":"2026-10-22T16:00:00.000Z","completedAt":"2026-10-22T15:00:00.000Z"},"6":{"completedAt":"2026-10-22T15:30:00.000Z"},"7":null,"8":null}}}' 'Revisores' 'Revisores quedó sin terminar; 1 paso(s) no se llegaron a correr'
# la ejecución que llegó al final, con una fila sin marca: corrió, así que sigue diciendo «sin marca»
T=$(mktemp -d); volcado "${T}/r" "${S1}" "" '{"marker":{"stepTimings":{"2":null}}}'
generar "${T}/r" "${T}/o.html" "${T}/log"
grep -q 'class="falta" style="width:6px" title="1 paso(s) sin marca"' "${T}/o.html" && ok "T22c la ejecución que llegó al final sigue diciendo «sin marca»" || mal "T22c la que llegó al final: $(grep -o 'class="falta"[^>]*title="[^"]*"' "${T}/o.html" | head -1)"
rm -rf "${T}"

# ── T23 · sin hora de inicio, las evaluaciones NO desaparecen ─────────────────────────────────
# 🔴 Falla con: off() → null → todas van a «anteriores al inicio» y el detalle dice «ningún control encontró un error».
T=$(mktemp -d); volcado "${T}/r" "${S1}" "" '{"marker":{"startedAt":null}}'
J="$(modelo_json "${T}/r")"
python3 -c "
import json,sys; c=json.loads(sys.argv[1])['corridas'][0]
assert c['eventos_previos']==0, c['eventos_previos']; assert len(c['eventos'])==4, len(c['eventos']); assert c['controles']['total']==4
assert any(e['cls']=='error' for e in c['eventos_agrupados'])" "${J}" && ok "T23 sin startedAt: 4 eventos con t=null, 0 previos, el error sigue en la lista" || mal "T23 sin startedAt las evaluaciones desaparecen"
generar "${T}/r" "${T}/o.html" "${T}/log"; D="$(cliente "${T}/o.html" detail 0)"
grep -q 'sin minuto' <<< "${D}" && ok "T23 el detalle declara las evaluaciones sin minuto" || mal "T23 el detalle no declara «sin minuto»"
rm -rf "${T}"

# ── T24 · tabla de controles y lista de eventos cuentan sobre el MISMO universo ────────────────
# 🔴 Falla con: que la tabla cuente TODOS los gates (incluidos los anteriores al inicio) y la lista sólo los de la corrida.
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "" '{"gates":[{"ts":"2026-08-15T05:00:00.000Z","check":"build","status":"red:exit=2","cmd":"x","exit":2},{"ts":"2026-08-15T06:10:00.000Z","check":"build","status":"green","cmd":"x"}]}'
J="$(modelo_json "${T}/r")"
python3 -c "
import json,sys; c=json.loads(sys.argv[1])['corridas'][0]
assert c['eventos_previos']==1 and c['controles']['total']==1 and c['controles']['error']==0 and len(c['eventos'])==1, (c['eventos_previos'],c['controles'])" "${J}" && ok "T24 el rojo anterior al inicio no entra ni en la tabla ni en la lista, y se cuenta aparte" || mal "T24 tabla y lista cuentan universos distintos"
generar "${T}/r" "${T}/o.html" "${T}/log"; D="$(cliente "${T}/o.html" detail 0)"
grep -q '1 anteriores al inicio, no contadas' <<< "${D}" && ok "T24 la tabla declara la anterior al inicio" || mal "T24 la tabla no declara la anterior al inicio"
rm -rf "${T}"

# ── T25 · --view desconocida → exit 1, no la otra página en silencio ─────────────────────────
# 🔴 Falla con: que un `--view runz` genere la de seis preguntas.
T=$(mktemp -d); node "${TABLERO}" --view runz --output "${T}/o.html" >/dev/null 2>&1; RC=$?
[ "${RC}" -eq 1 ] && [ ! -f "${T}/o.html" ] && ok "T25 --view desconocida → exit 1 sin página" || mal "T25 --view desconocida: rc=${RC}"
rm -rf "${T}"

# ── T26 · nombresDePasos dice por qué no pudo cargar la tabla ─────────────────────────────────
# 🔴 Falla con: leer una tabla rota como «sin tabla». Los
# nombres salen de lib/steps.js; el motivo trae el código del error.
T=$(mktemp -d); printf 'module.exports = {' > "${T}/rota.js"
R="$(node -e "console.log(require('${CORR}').nombresDePasos('${T}/rota.js').motivo)")"
grep -q 'no se pudo cargar (SyntaxError\|no se pudo cargar (.*Unexpected' <<< "${R}" && ok "T26 tabla rota → «no se pudo cargar» con su error" || mal "T26 tabla rota se reportó como: ${R}"
R="$(node -e "console.log(require('${CORR}').nombresDePasos('${T}/nada.js').motivo)")"
grep -q 'no se pudo cargar (MODULE_NOT_FOUND, .*nada\.js)' <<< "${R}" && ok "T26 tabla ausente → «no se pudo cargar (MODULE_NOT_FOUND, <ruta>)»" || mal "T26 ausente se reportó como: ${R}"
# 🔴 Falla con: proteger sólo el `require`; una tabla
# que carga pero exporta null, o cuyo `stepName` lanza, tira el tablero entero en vez de degradar a números.
printf 'module.exports = null;\n' > "${T}/nula.js"
printf "module.exports = { stepName: () => { throw new Error('boom /ruta/de/la/maquina'); } };\n" > "${T}/lanza.js"
printf "module.exports = { stepName: () => { throw null; } };\n" > "${T}/lanza-nulo.js"
for t in nula lanza lanza-nulo; do
  R="$(node -e "const p=require('${CORR}').nombresDePasos('${T}/${t}.js');console.log(p.fuente+' · '+p.nombres.join(',')+' · '+p.motivo)" 2>&1)"
  grep -q '^numeros · 0,1,2,3,4,5,6,7,8,9 · la tabla de pasos' <<< "${R}" && ! grep -q 'ruta/de/la/maquina' <<< "${R}" \
    && ok "T26 tabla mal armada (${t}) → números con motivo, sin caerse y sin el mensaje del error" || mal "T26 tabla mal armada (${t}) dio: ${R}"
done
# una tabla que nombra sólo algunos pasos: los que tiene, por nombre; los demás por número, y el motivo dice cuáles
printf "module.exports = { stepName: (i) => (i === 'implement' ? 'Cuatro' : null) };\n" > "${T}/parcial.js"
R="$(node -e "const p=require('${CORR}').nombresDePasos('${T}/parcial.js');console.log(p.fuente+' · '+p.nombres.join(',')+' · '+p.motivo)" 2>&1)"
grep -q '^tabla · 0,1,2,3,Cuatro,5,6,7,8,9 · la tabla de pasos no nombra el/los paso(s) 0, 1, 2, 3, 5, 6, 7, 8, 9' <<< "${R}" && ok "T26 tabla parcial → los nombres que tiene y el motivo de los que faltan" || mal "T26 tabla parcial dio: ${R}"
rm -rf "${T}"

# ── T27 · el umbral de la ficha sale de sources.json, no del cliente ──────────────────────────
# 🔴 Falla con: 80 % escrito en el cliente.
grep -q "pf >= 0.8" "${CORR}" && mal "T27 el umbral 0.8 sigue escrito en el cliente" || ok "T27 el cliente no tiene el umbral escrito"
python3 -c "import json;u=json.load(open('${RAIZ}/scripts/nightly/dashboard/sources.json'))['thresholds'];assert 'corridas_al_final' in u" && ok "T27 sources.json declara el umbral corridas_al_final" || mal "T27 falta el umbral en sources.json"

# ── T9c · el filtro «sólo con consumo medido» filtra de verdad ────────────────────────────────
# 🔴 Falla con: que ningún caso tilde ese casillero.
T=$(mktemp -d); volcado "${T}/r" "${S1}"
volcado "${T}/r" "${S2}" "2026-08-16T05:53:47Z" '{"consumo":{"estado":"borrada","motivo":"x","tokens":null,"por_modelo":null,"por_paso":null,"fuera_de_ventana":null,"respuestas":null}}'
generar "${T}/r" "${T}/o.html" "${T}/log"
F="$(cliente "${T}/o.html" usage-filter)"
# (el DOM mínimo no tiene filas de tabla, así que el contador «a la vista» no se puede mirar acá: se mira la capa ejecutiva)
grep -q 'n=1 de 1 ejecución' <<< "${F}" && ! grep -q 'de 2 ejecuciones' <<< "${F}" && ok "T9c «sólo con consumo medido» deja la capa ejecutiva en n=1 de 1 (antes 2)" || mal "T9c el filtro por consumo no filtra"
rm -rf "${T}"

# ── T28 · sin el saneador, el mensaje del registro se RETIENE y se dice; los tramos no se cortan ──
# 🔴 Falla con: que la rama `retenido` no tenga caso. Se copia scripts/ a un temporal
#    y se borra tokens-digest.js — sin interruptores de entorno.
T=$(mktemp -d); mkdir -p "${T}/c/copia"; cp -R "${RAIZ}/scripts/nightly" "${T}/c/copia/nightly"; mkdir -p "${T}/c/copia/metrics"; cp -R "${RAIZ}/scripts/lib" "${T}/c/copia/lib"
volcado "${T}/r" "${S1}"
J="$(node "${T}/c/copia/nightly/dashboard/runs.js" --runs-dir "${T}/r" --json --dry-run 2>/dev/null | python3 -c "
import json,sys; raw=sys.stdin.read(); m=json.loads(raw[raw.find('{'):]); c=m['corridas'][0]
e=[x for x in c['eventos'] if x['control']=='tests'][0]
print('retenido' if e['mensaje_estado']=='retenido' and e['mensaje'] is None else 'MAL:'+e['mensaje_estado'], '|', 'sin_rescate' if m['sin_rescate'] else 'MAL:sin motivo', '|', 'tramos_vacios' if c['tramos']==[] and c['motivo_tramos'] else 'MAL:tramos')")"
[ "${J}" = "retenido | sin_rescate | tramos_vacios" ] && ok "T28 sin tokens-digest.js: mensaje retenido, motivo global y tramos sin cortar con motivo" || mal "T28 sin saneador: ${J}"
node "${T}/c/copia/nightly/dashboard/runs.js" --runs-dir "${T}/r" --output "${T}/o.html" >/dev/null 2>&1
grep -q 'FAIL src/x.test.ts' "${T}/o.html" && mal "T28 el mensaje se publicó SIN sanear" || ok "T28 el mensaje sin sanear no llega a la página"
D="$(cliente "${T}/o.html" detail 0)"; grep -q 'no se publica sin sanear' <<< "${D}" && ok "T28 el detalle explica que el mensaje está retenido" || mal "T28 el detalle no distingue retenido de ausente"
rm -rf "${T}"

# ── T29 · el juicio de color sale del umbral, con datos ──────────────────────────────────────
# 🔴 Falla con: que T27 mire sólo que la config exista.
T=$(mktemp -d); volcado "${T}/r" "${S1}"; volcado "${T}/r" "${S2}" "2026-08-16T05:53:47Z" '{"marker":{"stepsCompleted":[0,1,2,3,4]}}'
generar "${T}/r" "${T}/o.html" "${T}/log"; F="$(cliente "${T}/o.html" container fichas)"
grep -q 'tile bad' <<< "${F}" && grep -q '>50%<' <<< "${F}" && ok "T29 1 de 2 al final (50 %) → rojo por umbral bad_max 0.5" || mal "T29 el 50 % no sale rojo"
volcado "${T}/r" "${S3}" "2026-08-17T05:53:47Z"; volcado "${T}/r" "44444444-4444-4444-8444-444444444444" "2026-08-18T05:53:47Z"; volcado "${T}/r" "55555555-5555-4555-8555-555555555555" "2026-08-19T05:53:47Z"
generar "${T}/r" "${T}/o.html" "${T}/log"; F="$(cliente "${T}/o.html" container fichas)"
grep -q '>80%<' <<< "${F}" && grep -q 'class="tile ok"' <<< "${F}" && ok "T29 4 de 5 al final (80 %) → verde por ok_min 0.8" || mal "T29 el 80 % no sale verde"
rm -rf "${T}"

# ── T30 · un sources.json ROTO no es «sin umbral»: se dice ──────────────────────────────────
# 🔴 Falla con: catch → {} y las fichas pierden el color en silencio.
T=$(mktemp -d); mkdir -p "${T}/c/copia"; cp -R "${RAIZ}/scripts/nightly" "${T}/c/copia/nightly"; cp -R "${RAIZ}/scripts/metrics" "${T}/c/copia/metrics"; cp -R "${RAIZ}/scripts/lib" "${T}/c/copia/lib"
echo '{ roto' > "${T}/c/copia/nightly/dashboard/sources.json"; volcado "${T}/r" "${S1}"
node "${T}/c/copia/nightly/dashboard/runs.js" --runs-dir "${T}/r" --output "${T}/o.html" > "${T}/log" 2>&1
grep -q 'umbrales NO LEÍDOS' "${T}/log" && grep -q 'no se pudo leer' "${T}/o.html" && ok "T30 sources.json roto → motivo en el resumen y en la página" || mal "T30 sources.json roto pasa en silencio"
rm -rf "${T}"

# ── T31 · un umbral PRESENTE pero mal formado no juzga: neutro con motivo, en las dos páginas ────
# 🔴 Falla con: comparar contra undefined da siempre «atención».
T=$(mktemp -d); mkdir -p "${T}/c/copia"; cp -R "${RAIZ}/scripts/nightly" "${T}/c/copia/nightly"; cp -R "${RAIZ}/scripts/metrics" "${T}/c/copia/metrics"; cp -R "${RAIZ}/scripts/lib" "${T}/c/copia/lib"
python3 - "${T}/c/copia/nightly/dashboard/sources.json" <<'PY2'
import json,sys; p=sys.argv[1]; c=json.load(open(p)); c['thresholds']['corridas_al_final']={"ok_min":0.8}; json.dump(c,open(p,'w'))
PY2
volcado "${T}/r" "${S1}"; volcado "${T}/r" "${S2}" "2026-08-16T05:53:47Z" '{"marker":{"stepsCompleted":[0,1,2,3,4]}}'
node "${T}/c/copia/nightly/dashboard/runs.js" --runs-dir "${T}/r" --output "${T}/o.html" >/dev/null 2>&1; F="$(cliente "${T}/o.html" container fichas)"
grep -q 'mal formado en sources.json' <<< "${F}" && ! grep -q 'tile warn' <<< "${F}" && ok "T31 (ejecuciones) umbral sin sentido → ficha neutra con motivo, no «atención»" || mal "T31 (ejecuciones) el umbral mal formado juzga en silencio"
R="$(node -e "const c=require('${RAIZ}/scripts/nightly/dashboard/common.js');const cfg={thresholds:{x:{ok_min:0.8}}};const m=c.medida(0.9,9,10);console.log(JSON.stringify(c.juzgar(cfg,'x',m))+'|'+c.motivoUmbral(cfg,'x')+'|'+c.motivoUmbral(cfg,'y'))")"
[ "${R}" = '""|umbral «x» mal formado en sources.json: sin juicio de color|null' ] && ok "T31 (common.js) juzgar() neutro + motivoUmbral() con la clave; sin fila → sin motivo" || mal "T31 (common.js) dio: ${R}"
R="$(node -e "const c=require('${RAIZ}/scripts/nightly/dashboard/common.js');console.log(c.ficha({thresholds:{x:{ok_min:0.8}}},'x','Título',c.medida(0.9,9,10),(v)=>String(v)))")"
grep -q 'mal formado' <<< "${R}" && ok "T31 (common.js) la ficha lleva el motivo al pie" || mal "T31 (common.js) la ficha calla el umbral mal formado"
# las tres ramas de umbralValido, y los tipos que el isFinite global deja pasar ('' y true)
R="$(node -e "const v=require('${RAIZ}/scripts/nightly/dashboard/common.js').umbralValido;console.log([v({direction:'mayor_es_mejor',ok_min:0.8,bad_max:0.5}),v({direction:'mayor_es_mejor',ok_min:0.8}),v({direction:'menor_es_mejor',ok_max:0.2,bad_min:0.4}),v({direction:'menor_es_mejor',ok_max:0.2}),v({direction:'mayor_es_mejor',ok_min:'',bad_max:true}),v({ok_min:1,bad_max:0})].join('|'))")"
[ "${R}" = "true|false|true|false|false|false" ] && ok "T31 (common.js) umbralValido: mayor/menor válidos, sin número, mal tipeado ('' / true) y sin sentido" || mal "T31 (common.js) umbralValido dio: ${R}"
# la copia del cliente: mismo veredicto con el umbral mal TIPEADO (isFinite global lo deja pasar)
T=$(mktemp -d); mkdir -p "${T}/c/copia"; cp -R "${RAIZ}/scripts/nightly" "${T}/c/copia/nightly"; cp -R "${RAIZ}/scripts/metrics" "${T}/c/copia/metrics"; cp -R "${RAIZ}/scripts/lib" "${T}/c/copia/lib"
python3 - "${T}/c/copia/nightly/dashboard/sources.json" <<'PY2'
import json,sys; p=sys.argv[1]; c=json.load(open(p)); c['thresholds']['corridas_al_final']={"direction":"mayor_es_mejor","ok_min":"","bad_max":True}; json.dump(c,open(p,'w'))
PY2
volcado "${T}/r" "${S1}"; volcado "${T}/r" "${S2}" "2026-08-16T05:53:47Z" '{"marker":{"stepsCompleted":[0,1,2,3,4]}}'
node "${T}/c/copia/nightly/dashboard/runs.js" --runs-dir "${T}/r" --output "${T}/o.html" >/dev/null 2>&1; F="$(cliente "${T}/o.html" container fichas)"
# se mira LA ficha del umbral roto (la de errores tiene su umbral sano y puede salir roja legítimamente)
E="$(python3 -c "
import sys; f=sys.stdin.read()
for t in f.split('<div class=\"tile ')[1:]:
    if 'llegaron al último paso' in t: print(t.split('\"')[0] or 'sin-clase', 'mal formado en sources.json' in t); break
" <<< "${F}")"
[ "${E}" = "neutro True" ] && ok "T31 (cliente) umbral mal tipeado ('' / true) → la ficha sale neutra con motivo" || mal "T31 (cliente) la ficha del umbral mal tipeado salió: ${E}"
rm -rf "${T}"
rm -rf "${T}"

# ═══════════════════════ varias máquinas (T12–T16 y T18) ═══════════════════════
# Una carpeta bajada del buzón, fabricada: <maquina>/ por máquina, un volcado suelto en la raíz, una carpeta
# que no tiene forma de nombre de máquina, y el registro local de ESTA máquina (TYCON_MACHINE=maq-a).
# Los ids de estos casos chocan con los de los casos anteriores de esta suite: van con el prefijo «2.16-».
S4="44444444-4444-4444-8444-444444444444"; S5="55555555-5555-4555-8555-555555555555"; S6="66666666-6666-4666-8666-666666666666"
T=$(mktemp -d); C="${T}/buzon"; R="${T}/local"
# red de seguridad: con el código roto, estos casos escribirían la vista en artifacts/; se borra al final del
# bloque y T15 lo sigue denunciando igual (la huella AUSENTE se tomó al principio de la suite).
volcado "${C}/maq-a" "${S1}" "2026-08-20T10:00:00Z" '{"archivedAt":"2026-08-20T12:00:00.000Z","marker":{"storyId":"A1"}}'
volcado "${C}/maq-a" "${S2}" "2026-08-21T10:00:00Z" '{"marker":{"storyId":"A2"}}'
volcado "${C}/maq-b" "${S3}" "2026-08-22T10:00:00Z" '{"archivedAt":"2026-08-22T12:00:00.000Z","marker":{"storyId":"B3"}}'
volcado "${C}" "${S3}" "2026-08-22T10:00:00Z" '{"archivedAt":"2026-08-23T12:00:00.000Z","marker":{"storyId":"B3"}}' suelto-de-maq-b.json   # copia suelta MÁS NUEVA
volcado "${C}" "${S4}" "2026-08-23T10:00:00Z" '{"marker":{"storyId":"SUELTO"}}' suelto.json
volcado "${C}/Carpeta Rara" "${S5}" "2026-08-24T10:00:00Z" '{"marker":{"storyId":"RARA"}}'
echo '<html>foto vieja</html>' > "${C}/runs-dashboard.html"
mkdir -p "${C}/.oculta"; echo '{"marker":{"sessionId":"no-es-una-corrida"}}' > "${C}/.oculta/x.json"
volcado "${R}" "${S1}" "2026-08-20T10:00:00Z" '{"archivedAt":"2026-08-25T12:00:00.000Z","marker":{"storyId":"A1"}}'   # la misma corrida, en local, más nueva
volcado "${R}" "${S6}" "2026-08-26T10:00:00Z" '{"marker":{"storyId":"L6"}}'
multi() { TYCON_MACHINE=maq-a node "${TABLERO}" --view runs --runs-dir "${R}" --mailbox "${C}" "$@"; }
JM="$(multi --json --dry-run 2>/dev/null | python3 -c "
import json,sys
raw=sys.stdin.read(); i=raw.find('{'); print(json.dumps(json.loads(raw[i:])))")"

# ── T12 · la máquina sale de la carpeta; el local lleva el nombre de esta máquina ──────
# 🔴 Falla con: sin campo → las corridas de dos máquinas salen indistinguibles (el defecto medido).
python3 -c "
import json,sys; m=json.loads(sys.argv[1])
maq={c['story']: c.get('maquina') for c in m['corridas']}
assert maq.get('A2')=='maq-a', maq
assert maq.get('B3')=='maq-b', maq
assert maq.get('L6')=='maq-a', maq
" "${JM}" && ok "2.16-T12 cada corrida con la máquina de su carpeta; la local con la de esta máquina" || mal "2.16-T12 la máquina no sale de la carpeta: $(echo "${JM}" | python3 -c "import json,sys; print([(c.get('story'),c.get('maquina')) for c in json.load(sys.stdin).get('corridas',[])])" 2>&1)"
# lo que no se puede atribuir sale «sin declarar» con motivo, nunca adjudicado
# 🔴 Falla con: adjudicarlo a la máquina que genera la página → la corrida de DevB figura como de DevA.
python3 -c "
import json,sys; m=json.loads(sys.argv[1]); c={x['story']: x for x in m['corridas']}
for k, pista in (('SUELTO','raíz'), ('RARA','Carpeta Rara')):
    x=c[k]; assert x.get('maquina') is None, (k, x.get('maquina'))
    assert x.get('maquina_motivo') and pista in x['maquina_motivo'], (k, x.get('maquina_motivo'))
assert 'no-es-una-corrida' not in json.dumps(m), 'leyó una carpeta oculta'
" "${JM}" && ok "2.16-T12 volcado suelto y carpeta sin forma de máquina → sin declarar, con motivo; lo oculto no se lee" || mal "2.16-T12 lo no atribuible no sale «sin declarar» con motivo (o se leyó lo oculto)"

# ── T13 · la misma corrida en los dos lados: una fila, con su máquina ─────────────────
# 🔴 Falla con: que gane la copia sin carpeta → «sin declarar» justo en la máquina propia.
python3 -c "
import json,sys; m=json.loads(sys.argv[1]); ids=[x['story'] for x in m['corridas']]
assert ids.count('A1')==1 and ids.count('B3')==1, ids
c={x['story']: x for x in m['corridas']}
assert c['A1']['maquina']=='maq-a', c['A1'].get('maquina')
assert c['B3']['maquina']=='maq-b', c['B3'].get('maquina')
assert len(ids)==6, len(ids)
" "${JM}" && ok "2.16-T13 la corrida repetida sale una vez y conserva su máquina (también contra una copia suelta más nueva)" || mal "2.16-T13 la corrida repetida se duplicó o perdió su máquina"

# ── T14 · columna, filtro y sello con conteos ─────────────────────────────────────────
# 🔴 Falla con: sin columna ni filtro, el AC es prosa; «Alcance: esta máquina» fijo → el pie miente.
multi --output "${T}/o.html" > "${T}/log" 2>&1; RC=$?
[ "${RC}" -eq 0 ] && ok "2.16-T14 la página multi-máquina se genera (exit 0)" || mal "2.16-T14 exit ${RC}: $(head -3 "${T}/log")"
grep -q '<th>máquina' "${T}/o.html" && ok "2.16-T14 la tabla tiene la columna «máquina»" || mal "2.16-T14 la tabla no tiene columna de máquina"
grep -q 'class="maq">maq-b<' "${T}/o.html" && ok "2.16-T14 la fila nombra su máquina" || mal "2.16-T14 ninguna fila nombra la máquina"
grep -q 'id="f-maquina"' "${T}/o.html" && ok "2.16-T14 hay filtro por máquina" || mal "2.16-T14 no hay filtro por máquina"
FM="$(cliente "${T}/o.html" machine-filter maq-b)"
grep -q 'n=1 de 1 ejecución' <<< "${FM}" && ok "2.16-T14 filtrar por maq-b deja una sola ejecución" || mal "2.16-T14 el filtro por máquina no recalcula: $(echo "${FM}" | grep -o 'n=[0-9]* de [0-9]* ejecuciones' | head -2)"
FM="$(cliente "${T}/o.html" machine-filter '(sin declarar)')"
grep -q 'n=2 de 2 ejecuciones' <<< "${FM}" && ok "2.16-T14 «sin declarar» también se filtra (2)" || mal "2.16-T14 el filtro no reúne las sin declarar"
grep -q "${C}" "${T}/o.html" && mal "2.16-T14 la ruta de la carpeta bajada llegó a la página" || ok "2.16-T14 la ruta de la carpeta bajada no llega a la página"
SELLO="$(grep -o '<b>Alcance:</b>[^<]*' "${T}/o.html")"
grep -q 'maq-a 3' <<< "${SELLO}" && grep -q 'maq-b 1' <<< "${SELLO}" && grep -q 'sin declarar 2' <<< "${SELLO}" && ok "2.16-T14 con varias máquinas el sello las nombra con su conteo («${SELLO#*</b>}»)" || mal "2.16-T14 el sello dice: «${SELLO}»"
grep -q 'esta máquina' <<< "${SELLO}" && mal "2.16-T14 el sello sigue diciendo «esta máquina» con datos mezclados" || ok "2.16-T14 ya no dice «esta máquina»"
# una sola máquina (la carpeta bajada sólo con la propia) → lo de siempre
T1C=$(mktemp -d); volcado "${T1C}/buzon/maq-a" "${S2}"; volcado "${T1C}/local" "${S6}"
TYCON_MACHINE=maq-a node "${TABLERO}" --view runs --runs-dir "${T1C}/local" --mailbox "${T1C}/buzon" --output "${T1C}/o.html" >/dev/null 2>&1
grep -q '<b>Alcance:</b> esta máquina' "${T1C}/o.html" && ok "2.16-T14 con una sola máquina el sello sigue diciendo «esta máquina»" || mal "2.16-T14 con una sola máquina: «$(grep -o '<b>Alcance:</b>[^<]*' "${T1C}/o.html")»"
generar "${T1C}/local" "${T1C}/solo.html" "${T1C}/log"
grep -q 'id="f-maquina"' "${T1C}/solo.html" && mal "2.16-T14 sin carpeta bajada la página igual dibuja el filtro por máquina" || ok "2.16-T14 sin carpeta bajada la página queda como antes (sin filtro por máquina)"
grep -q 'maq-a' "${T1C}/solo.html" && mal "2.16-T14 sin carpeta bajada el nombre de la máquina llega a la página (el entregable del equipo)" || ok "2.16-T14 sin carpeta bajada el nombre de la máquina no llega a la página"
rm -rf "${T1C}"

# ── T12b · sin el módulo de la subida (arnés partido): las locales salen «sin declarar» con motivo ──
TS=$(mktemp -d); mkdir -p "${TS}/copia"; cp -R "${RAIZ}/scripts/nightly" "${TS}/copia/nightly"; cp -R "${RAIZ}/scripts/metrics" "${TS}/copia/metrics"; cp -R "${RAIZ}/scripts/lib" "${TS}/copia/lib"; rm -f "${TS}/copia/metrics/upload-runs.js"
volcado "${TS}/buzon/maq-b" "${S3}"; volcado "${TS}/local" "${S6}" "" '{"marker":{"storyId":"L6"}}'
J16="$(node "${TS}/copia/nightly/dashboard/runs.js" --runs-dir "${TS}/local" --mailbox "${TS}/buzon" --json --dry-run 2>/dev/null | python3 -c "
import json,sys; r=sys.stdin.read(); m=json.loads(r[r.find('{'):]); c=[x for x in m['corridas'] if x['story']=='L6'][0]
print('ok' if c['maquina'] is None and 'upload-runs.js' in (c['maquina_motivo'] or '') else 'MAL:%r %r'%(c['maquina'],c['maquina_motivo']))")"
[ "${J16}" = "ok" ] && ok "2.16-T12b sin el módulo de la subida, la ejecución local sale «sin declarar» con el motivo" || mal "2.16-T12b ${J16}"
rm -rf "${TS}"
# Una carpeta de máquina ilegible dentro de una carpeta legible también se dice en la PÁGINA
# 🔴 Falla con: que sólo lo diga la consola y la página diga «1 de 1 archivos» y «esta máquina».
TA=$(mktemp -d); volcado "${TA}/buzon/maq-a" "${S2}"; volcado "${TA}/buzon/maq-b" "${S3}"; volcado "${TA}/local" "${S6}"; chmod 000 "${TA}/buzon/maq-b"
TYCON_MACHINE=maq-a node "${TABLERO}" --view runs --runs-dir "${TA}/local" --mailbox "${TA}/buzon" --output "${TA}/o.html" >/dev/null 2>&1
chmod 755 "${TA}/buzon/maq-b"
grep -q 'carpeta.*no se pudo leer\|no se pudieron leer.*carpeta' "${TA}/o.html" && ok "2.16-A1 la carpeta de máquina ilegible se avisa en la página" || mal "2.16-A1 la página calla la carpeta ilegible"
grep -q '<b>Alcance:</b> esta máquina' "${TA}/o.html" && mal "2.16-A1 con una carpeta sin leer, el sello igual dice «esta máquina»" || ok "2.16-A1 el sello no dice «esta máquina» si faltó leer una carpeta"
rm -rf "${TA}"
# La atribución no depende del orden del disco: la misma sesión en dos carpetas → la primera en orden alfabético
TA=$(mktemp -d); volcado "${TA}/buzon/zzz" "${S1}"; volcado "${TA}/buzon/aaa" "${S1}"; mkdir -p "${TA}/local"
M8="$(TYCON_MACHINE=otra node "${TABLERO}" --view runs --runs-dir "${TA}/local" --mailbox "${TA}/buzon" --json --dry-run 2>/dev/null | python3 -c "import json,sys; r=sys.stdin.read(); print(json.loads(r[r.find('{'):])['corridas'][0]['maquina'])")"
[ "${M8}" = "aaa" ] && ok "2.16-A8 dos carpetas con la misma sesión → gana la primera en orden (aaa), no el orden del disco" || mal "2.16-A8 atribuyó a «${M8}»"
rm -rf "${TA}"
# T12c · la carpeta pedida con --mailbox que no se puede leer se DICE (banda gris), nunca «cero corridas de otras máquinas»
TYCON_MACHINE=maq-a node "${TABLERO}" --view runs --runs-dir "${R}" --mailbox "${T}/no-hay-buzon" --output "${T}/sinbuzon.html" > "${T}/log" 2>&1; RC=$?
[ "${RC}" -eq 0 ] && grep -q 'No se leyó la carpeta bajada del depósito' "${T}/sinbuzon.html" && grep -q 'buzón NO LEÍDO' "${T}/log" && ok "2.16-T12c carpeta del buzón ilegible → banda gris en la página y aviso en el resumen" || mal "2.16-T12c carpeta ilegible: rc=${RC}, la página no lo dice: $(tail -2 "${T}/log")"

# T12d · la carpeta por defecto que EXISTE pero no se puede mirar se dice; sólo «no existe» es «no participa»
# 🔴 Falla con: que el catch de statSync trate EACCES igual que ENOENT → la página sale de una sola máquina, sin banda.
TD=$(mktemp -d); mkdir -p "${TD}/casa/.claude/.tycon-pipeline"; cp -R "${R}" "${TD}/casa/.claude/.tycon-pipeline/timing-history"; mkdir -p "${TD}/cerrada/corridas-buzon"; chmod 000 "${TD}/cerrada"
HOME="${TD}/casa" TYCON_MAILBOX_DIR="${TD}/cerrada/corridas-buzon" TYCON_MACHINE=maq-a node "${TABLERO}" --view runs --output "${TD}/o.html" > "${TD}/log" 2>&1; RC=$?
chmod 755 "${TD}/cerrada"
[ "${RC}" -eq 0 ] && grep -q 'No se leyó la carpeta bajada del depósito' "${TD}/o.html" && grep -q 'buzón NO LEÍDO' "${TD}/log" && ok "2.16-T12d carpeta por defecto sin permiso para mirarla → banda gris y aviso, no «una sola máquina»" || mal "2.16-T12d rc=${RC}: la página no lo dice: $(tail -2 "${TD}/log")"
rm -rf "${TD}"

# T12e (adversarial) · un symlink dentro de la carpeta bajada se sigue; uno roto se cuenta, nunca desaparece en silencio
# 🔴 Falla con: el Dirent de un symlink no es ni archivo ni carpeta → la entrada se tira sin constancia y el sello dice «esta máquina».
TE=$(mktemp -d); volcado "${TE}/buzon/maq-a" "${S2}"; volcado "${TE}/otra/maq-b" "${S3}" "2026-08-22T10:00:00Z" '{"marker":{"storyId":"ENLACE"}}'; mkdir -p "${TE}/local"
ln -s "${TE}/otra/maq-b" "${TE}/buzon/maq-b"; ln -s "${TE}/no-existe" "${TE}/buzon/maq-z"
JE="$(TYCON_MACHINE=maq-a node "${TABLERO}" --view runs --runs-dir "${TE}/local" --mailbox "${TE}/buzon" --json --dry-run 2>/dev/null | python3 -c "
import json,sys; r=sys.stdin.read(); m=json.loads(r[r.find('{'):]); c={x['story']: x.get('maquina') for x in m['corridas']}
print('ok' if c.get('ENLACE')=='maq-b' and m['buzon']['carpetas_ilegibles']==1 and not m['maquinas']['solo_esta'] else 'MAL:%r %r %r'%(c, m['buzon'], m['maquinas']['solo_esta']))")"
[ "${JE}" = "ok" ] && ok "2.16-T12e carpeta de máquina enlazada → se lee con su máquina; enlace roto → carpeta ilegible contada" || mal "2.16-T12e ${JE}"
# y la negativa a escribir en el repo del equipo no se esquiva con un symlink en el ARCHIVO de salida
ln -s "${RAIZ}/artifacts/runs-dashboard.html" "${TE}/salida.html"; HE="$(huella "${ENTREGABLE_CORRIDAS}")"
TYCON_MACHINE=maq-a node "${TABLERO}" --view runs --runs-dir "${TE}/local" --mailbox "${TE}/buzon" --output "${TE}/salida.html" > "${TE}/log" 2>&1; RC=$?
[ "$(huella "${ENTREGABLE_CORRIDAS}")" = "${HE}" ] || { mal "2.16-T12e un symlink de salida ESCRIBIÓ en artifacts/runs-dashboard.html (borrado)"; rm -f "${ENTREGABLE_CORRIDAS}"; }
[ "${RC}" -eq 2 ] && ok "2.16-T12e --output que es un symlink hacia el repo del equipo → exit 2" || mal "2.16-T12e symlink de salida salió ${RC}"
rm -rf "${TE}"

# T12f · una máquina que sólo BAJA (sin registro propio) no recibe la banda «las fichas salen con trama»
# 🔴 Falla con: que, con corridas del buzón, la banda diga que las fichas salen sin medir mientras muestran números.
TF=$(mktemp -d); volcado "${TF}/buzon/maq-a" "${S2}"; volcado "${TF}/buzon/maq-b" "${S3}"
TYCON_MACHINE=maq-z node "${TABLERO}" --view runs --runs-dir "${TF}/no-hay-registro" --mailbox "${TF}/buzon" --output "${TF}/o.html" > "${TF}/log" 2>&1; RC=$?
[ "${RC}" -eq 0 ] && ! grep -q 'Las fichas salen con trama' "${TF}/o.html" && grep -q 'sólo con lo bajado del depósito' "${TF}/o.html" && ok "2.16-T12f sin registro propio y con buzón → la banda dice que la página sale sólo con lo bajado, no «con trama»" || mal "2.16-T12f rc=${RC}: $(grep -o '<div class="banda gris">[^/]*' "${TF}/o.html" | head -2)"
rm -rf "${TF}"
# T12g · un symlink de salida con «..» que atraviesa una carpeta enlazada tampoco esquiva la negativa
# 🔴 Falla con: que path.resolve pliegue «lnk/..» como texto (afuera del repo) mientras el kernel sigue el enlace (adentro).
TG=$(mktemp -d); volcado "${TG}/buzon/maq-a" "${S2}"; mkdir -p "${TG}/local" "${TG}/out"
ln -s "${RAIZ}/scripts" "${TG}/lnk"; ln -s "../lnk/../x-2-16-symlink.html" "${TG}/out/f.html"
TYCON_MACHINE=maq-a node "${TABLERO}" --view runs --runs-dir "${TG}/local" --mailbox "${TG}/buzon" --output "${TG}/out/f.html" > "${TG}/log" 2>&1; RC=$?
if [ -e "${RAIZ}/x-2-16-symlink.html" ]; then mal "2.16-T12g la página se ESCRIBIÓ en la raíz del repo del equipo (borrada)"; rm -f "${RAIZ}/x-2-16-symlink.html"; fi
[ "${RC}" -eq 2 ] && ok "2.16-T12g symlink con «..» a través de una carpeta enlazada → exit 2, nada escrito en el repo" || mal "2.16-T12g salió ${RC}"
rm -rf "${TG}"

# T12h · lo que no se puede resolver se NIEGA: ciclo de enlaces y componente sin permiso
# 🔴 Falla con: tratar un lstat con EACCES como «no existe» y agregar la ruta literal → puede quedar «afuera» del repo.
TH=$(mktemp -d); volcado "${TH}/buzon/maq-a" "${S2}"; mkdir -p "${TH}/local"
ln -s "${TH}/b" "${TH}/a"; ln -s "${TH}/a" "${TH}/b"
TYCON_MACHINE=maq-a node "${TABLERO}" --view runs --runs-dir "${TH}/local" --mailbox "${TH}/buzon" --output "${TH}/a/o.html" > "${TH}/log" 2>&1; RC=$?
[ "${RC}" -eq 2 ] && ok "2.16-T12h ciclo de enlaces en la salida → exit 2 (se niega, no se adivina)" || mal "2.16-T12h ciclo de enlaces salió ${RC}"
mkdir -p "${TH}/cerrada/sub"; chmod 000 "${TH}/cerrada"
TYCON_MACHINE=maq-a node "${TABLERO}" --view runs --runs-dir "${TH}/local" --mailbox "${TH}/buzon" --output "${TH}/cerrada/sub/o.html" > "${TH}/log2" 2>&1; RC=$?
chmod 755 "${TH}/cerrada"
[ "${RC}" -eq 2 ] && ok "2.16-T12h componente sin permiso en la salida → exit 2 (no se asume «afuera»)" || mal "2.16-T12h componente sin permiso salió ${RC}: $(tail -1 "${TH}/log2")"
rm -rf "${TH}"

# ── T16 · la página con corridas del buzón va a la carpeta bajada, nunca al repo del equipo ──
# 🔴 Falla con: escribir en la ruta commiteada → las corridas de todos se commitean al repo del equipo.
rm -f "${C}/runs-dashboard.html"
multi > "${T}/log" 2>&1; RC=$?
[ "${RC}" -eq 0 ] && [ -f "${C}/runs-dashboard.html" ] && ! grep -q 'foto vieja' "${C}/runs-dashboard.html" && ok "2.16-T16 sin --output, la página cae en <carpeta bajada>/runs-dashboard.html" || mal "2.16-T16 rc=${RC}, la página no está en la carpeta bajada: $(tail -2 "${T}/log")"
H_ANTES="$(huella "${ENTREGABLE_CORRIDAS}")"
multi --output "${RAIZ}/artifacts/runs-dashboard.html" > "${T}/log" 2>&1; RC=$?
[ "$(huella "${ENTREGABLE_CORRIDAS}")" = "${H_ANTES}" ] || { mal "2.16-T16 ESCRIBIÓ en artifacts/runs-dashboard.html (borrado)"; rm -f "${ENTREGABLE_CORRIDAS}"; }
[ "${RC}" -eq 2 ] && ok "2.16-T16 apuntarla a artifacts/runs-dashboard.html → exit 2" || mal "2.16-T16 apuntarla al entregable salió ${RC}"
grep -q 'repo del equipo' "${T}/log" && ok "2.16-T16 y dice por qué" || mal "2.16-T16 no dice por qué: $(tail -2 "${T}/log")"
multi --output "${RAIZ}/artifacts/otra-cosa-2-16.html" > /dev/null 2>&1; RC=$?
[ "${RC}" -eq 2 ] && [ ! -e "${RAIZ}/artifacts/otra-cosa-2-16.html" ] && ok "2.16-T16 cualquier ruta dentro del repo del equipo → exit 2, sin escribir" || { mal "2.16-T16 otra ruta del repo del equipo salió ${RC}"; rm -f "${RAIZ}/artifacts/otra-cosa-2-16.html"; }
# de dónde sale la carpeta: la bajada por defecto (~/.claude/.tycon-pipeline/corridas-buzon) sólo sin --runs-dir; --local-only la apaga
mkdir -p "${T}/casa/.claude/.tycon-pipeline"; cp -R "${R}" "${T}/casa/.claude/.tycon-pipeline/timing-history"; cp -R "${C}" "${T}/casa/.claude/.tycon-pipeline/corridas-buzon"
N="$(env -u TYCON_MAILBOX_DIR HOME="${T}/casa" TYCON_MACHINE=maq-a node "${TABLERO}" --view runs --json --dry-run 2>/dev/null | python3 -c "import json,sys; r=sys.stdin.read(); print(len(json.loads(r[r.find('{'):])['corridas']))")"
[ "${N}" = "6" ] && ok "2.16-T16 sin banderas lee la carpeta bajada por defecto (6 ejecuciones)" || mal "2.16-T16 sin banderas leyó ${N} ejecuciones (esperaba 6)"
N="$(env -u TYCON_MAILBOX_DIR HOME="${T}/casa" TYCON_MACHINE=maq-a node "${TABLERO}" --view runs --local-only --json --dry-run 2>/dev/null | python3 -c "import json,sys; r=sys.stdin.read(); print(len(json.loads(r[r.find('{'):])['corridas']))")"
[ "${N}" = "2" ] && ok "2.16-T16 --local-only no lee la carpeta bajada (2 ejecuciones)" || mal "2.16-T16 --local-only leyó ${N} ejecuciones (esperaba 2)"
N="$(env -u TYCON_MAILBOX_DIR HOME="${T}/casa" TYCON_MACHINE=maq-a node "${TABLERO}" --view runs --runs-dir "${R}" --json --dry-run 2>/dev/null | python3 -c "import json,sys; r=sys.stdin.read(); print(len(json.loads(r[r.find('{'):])['corridas']))")"
[ "${N}" = "2" ] && ok "2.16-T16 con --runs-dir explícito no lee la carpeta bajada de la máquina (así ninguna suite la lee)" || mal "2.16-T16 con --runs-dir leyó ${N} ejecuciones (esperaba 2)"

# ── T18 (parte vista) · el camino del clon git no existe ────────────────────────────
# 🔴 Falla con: dejar --clone y corridas.json vivos «por las dudas» → dos fuentes para lo mismo.
TYCON_MACHINE=maq-a node "${TABLERO}" --view runs --runs-dir "${R}" --clone "${C}" --dry-run > "${T}/log" 2>&1; RC=$?
[ "${RC}" -eq 2 ] && grep -q -- '--mailbox' "${T}/log" && ok "2.16-T18 --clone ya no se acepta (exit 2) y dice que ahora es --mailbox" || mal "2.16-T18 --clone salió ${RC}: $(tail -2 "${T}/log")"
grep -q 'corridas\.json\|clonDeclarado\|TYCON_RUNS_JSON' "${RAIZ}/scripts/nightly/dashboard/runs.js" "${RAIZ}/scripts/nightly/dashboard/dashboard.js" && mal "2.16-T18 la vista todavía nombra corridas.json / el clon" || ok "2.16-T18 la vista ya no nombra corridas.json ni el clon"
[ "${HUELLA_CORRIDAS_ANTES}" = "AUSENTE" ] && rm -f "${ENTREGABLE_CORRIDAS}"
rm -rf "${T}"

# ── 2.7 · espera humana contra trabajo, y el hueco entre pasos ─────────────────────────────────
# Parche de arranques sobre el volcado base (inicio 05:53:47; fines 1,10,12,14,40,95,100,102,118 min).
# Arranques: el 4 empieza 6 min después de que terminó el 3 y el 8, 8 min después del 7.
# → espera (3 y 7) = 2 + 2 = 4 min · hueco = 6 + 8 = 14 min · trabajo = 118 − 4 − 14 = 100 min.
ARRANQUES="$(python3 -c "
import json
from datetime import datetime, timedelta, timezone
t0 = datetime(2026,8,15,5,53,47,tzinfo=timezone.utc)
iso = lambda m: (t0 + timedelta(minutes=m)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
st = {'0':0,'1':1,'2':10,'3':12,'4':20,'5':40,'6':95,'7':100,'8':110}
print(json.dumps({'marker':{'stepTimings':{k:{'startedAt':iso(v)} for k,v in st.items()}}}))
")"

# ── T7 · la corrida medida: trabajo y espera en dos columnas, el hueco como tramo propio ──
# 🔴 Falla con: la vista de hoy reparte «del fin del anterior al fin» → el paso 4 se come los 6 min
#    del hueco, y no hay columnas de trabajo/espera.
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "" "${ARRANQUES}"
volcado "${T}/r" "${S2}" "2026-08-16T05:53:47Z"
J="$(modelo_json "${T}/r")"
python3 -c "
import json,sys; c=json.loads(sys.argv[1])['corridas']
m=[x for x in c if x['tiempos'] and x['tiempos']['estado']=='medida']
assert len(m)==1, 'esperaba 1 corrida medida: %s' % [x.get('tiempos') for x in c]
t=m[0]['tiempos']; M=60000
assert t['espera_humana_ms']==4*M, t
assert t['entre_pasos_ms']==14*M, t
assert t['trabajo_ms']==100*M, t
entre=[x for x in m[0]['tramos'] if x.get('tipo')=='entre']
assert sum(x['ms'] for x in entre)==14*M, m[0]['tramos']
p4=[x for x in m[0]['tramos'] if x.get('paso')=='6'][0]  # el 4 viejo es la fila 6, «Implementar + pruebas» (story 7.23)
assert p4['ms']==20*M, p4
" "${J}" && ok "2.7-T7 la corrida medida separa trabajo (100 min), espera (4) y hueco (14); el paso 4 dura 20, no 26" || mal "2.7-T7 la cuenta de la corrida medida no es la esperada"
generar "${T}/r" "${T}/o.html" "${T}/log"
grep -q '<th>trabajo' "${T}/o.html" && grep -q '<th>espera' "${T}/o.html" && ok "2.7-T7 la tabla tiene las columnas trabajo y espera" || mal "2.7-T7 faltan las columnas trabajo/espera"
F="$(cliente "${T}/o.html" container fichas)"
grep -q 'Espera humana' <<< "${F}" && grep -q 'n=1 de 2 ejecuciones' <<< "${F}" && ok "2.7-T7 la capa ejecutiva da la espera con su n (1 de 2)" || mal "2.7-T7 la ficha de espera no está o no dice su n"
D="$(cliente "${T}/o.html" detail "$(python3 -c "import json,sys; c=json.loads(sys.argv[1])['corridas']; print([i for i,x in enumerate(c) if x['tiempos']['estado']=='medida'][0])" "${J}")")"
grep -q 'entre pasos' <<< "${D}" && ok "2.7-T7 la línea de tiempo dibuja el hueco como tramo propio" || mal "2.7-T7 el detalle no dibuja el hueco entre pasos"
rm -rf "${T}"

# ── T8 · la corrida vieja se rotula estimada; las notas viejas desaparecen ─────────
# 🔴 Falla con: dibujar la vieja como medida → el rótulo desaparece; dejar el aviso «se arregla en otra story».
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "" '{"marker":{"stepTimings":{"2":{"completedAt":"2026-08-15T06:03:57.000Z"}}}}'
generar "${T}/r" "${T}/o.html" "${T}/log"
D="$(cliente "${T}/o.html" detail 0)"
grep -q 'estimadas por diferencia' <<< "${D}" && ok "2.7-T8 la ejecución vieja dice «estimadas por diferencia»" || mal "2.7-T8 la ejecución vieja no lleva el rótulo"
grep -q 'marcado junto con el anterior' <<< "${D}" && ok "2.7-T8 el paso de 10 s se dibuja como marca «junto con el anterior»" || mal "2.7-T8 el paso corto no se rotula"
grep -q 'se arregla con la story 2.7' "${T}/o.html" && mal "2.7-T8 la página sigue diciendo «se arregla con la story 2.7»" || ok "2.7-T8 ninguna nota promete la 2.7"
F="$(cliente "${T}/o.html" container fichas)"
EST="$(python3 -c "
import sys
h=sys.argv[1]
for frag in h.split('<div class=\"tile')[1:]:
    if 'Espera humana' in frag:
        print('blind' if frag.lstrip().startswith('blind') else 'medida'); break
else: print('ausente')
" "${F}")"
[ "${EST}" = "blind" ] && ok "2.7-T8 sin arranques la ficha de espera sale con trama (no medida), no con un cero" || mal "2.7-T8 la ficha de espera salió «${EST}»"
rm -rf "${T}"

# ── T9 · si la cuenta de tiempos se rompe, la vista lo DICE (no se calla ni inventa) ──────
# 🔴 Falla con: `catch { cuentaTiempos = null }` sin motivo → los tramos se cortan a la vieja y nadie
#    sabe que la cuenta nueva no corrió.
T=$(mktemp -d); mkdir -p "${T}/c/copia"
cp -R "${RAIZ}/scripts" "${T}/c/copia/scripts"
echo 'throw new Error("roto a propósito");' > "${T}/c/copia/scripts/metrics/step-times.js"
volcado "${T}/r" "${S1}" "" "${ARRANQUES}"
node "${T}/c/copia/scripts/nightly/dashboard/dashboard.js" --view runs --runs-dir "${T}/r" --output "${T}/o.html" > "${T}/log" 2>&1; RC=$?
[ "${RC}" -eq 0 ] && grep -q 'step-times.js no se pudo cargar' "${T}/o.html" && ok "2.7-T9 con la cuenta rota, la página lo dice (y sale igual)" || mal "2.7-T9 rc=${RC}; la página no dice que la cuenta de tiempos falló"
rm -rf "${T}"

# ── T1 · la columna «vueltas» es la misma cuenta que el latido ─────
# 🔴 Falla con: `costo.iteraciones` cuenta las VECES QUE SE CALCULÓ EL SET de revisores (eventos step5-start),
#    no las vueltas: no coincide con los revisores medidos (3 donde hubo 2 vueltas).
#    La vista y el latido tienen que dar el mismo número: la última vuelta de `revisores.por_vuelta` (o de las
#    fotos si falta), leída con LA MISMA función (`vueltaDeVolcado` de retro-heartbeat.js), no con una copia.
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "" '{"costo":{"iteraciones":3},"revisores":{"estado":"medido","por_vuelta":{"0":1,"1":6,"2":5}}}'
generar "${T}/r" "${T}/o.html" "${T}/log"
J="$(modelo_json "${T}/r")"
python3 -c "
import json,sys; c=json.loads(sys.argv[1])['corridas'][0]['costo']
assert c['vueltas']==2, c
assert c['calculos_del_set']==3, c
" "${J}" && ok "7.1-T1 vueltas = 2 (revisores por vuelta) y el conteo viejo queda aparte como «cálculos del set» = 3" || mal "7.1-T1 la vista no usa la cuenta del latido: $(echo "${J}" | head -c 300)"
D="$(cliente "${T}/o.html" detail 0)"
grep -q 'en 2 vuelta' <<< "${D}" && ok "7.1-T1 el detalle dice «en 2 vuelta(s)»" || mal "7.1-T1 el detalle no dice 2 vueltas"
grep -q 'lista de revisores calculada 3 veces' <<< "${D}" && ok "7.1-T1 el detalle dice que el set se calculó 3 veces" || mal "7.1-T1 el detalle calla los cálculos del set"
F="$(cliente "${T}/o.html" container fichas)"
grep -q 'Vueltas de revisión por ejecución' <<< "${F}" && grep -q 'misma cuenta que el latido' <<< "${F}" && ok "7.1-T1 la ficha nombra la fuente (misma cuenta que el latido)" || mal "7.1-T1 la ficha no nombra la fuente"
rm -rf "${T}"
# sin `revisores` ni fotos: vueltas null con motivo, aunque el conteo viejo tenga un número
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "" '{"costo":{"iteraciones":3},"marker":{"iterations":null}}'
generar "${T}/r" "${T}/o.html" "${T}/log"
J="$(modelo_json "${T}/r")"
python3 -c "
import json,sys; c=json.loads(sys.argv[1])['corridas'][0]['costo']
assert c['vueltas'] is None and c['calculos_del_set']==3, c
" "${J}" && ok "7.1-T1b sin revisores por vuelta ni fotos, vueltas es null (no el conteo viejo)" || mal "7.1-T1b rellenó vueltas con el conteo viejo: $(echo "${J}" | head -c 300)"
rm -rf "${T}"

# ── T6 · Corridas_Validador_ListaBlancaYFicha ──────────────────────────────────────────
# 🔴 Falla con: la vista no publica el resumen del validador ni tiene la ficha. Mutaciones que lo ponen
#    en rojo: copiar `revisores.validador` entero (se filtran una fase desconocida y un campo extra),
#    publicar el `detalle` (informe y prompt), o contar las vueltas de revisores sin relanzar sobre las que sí se relanzó.
T=$(mktemp -d)
FASE_CERO='{"lanzamientos":0,"limpio":0,"hallazgos":0,"inconsistente":0,"sin_veredicto":0,"no_medido":0}'
volcado "${T}/r" "${S1}" "" "{\"revisores\":{\"estado\":\"medido\",\"lanzamientos\":5,\"por_vuelta\":{\"0\":1,\"1\":1,\"2\":3},\"duracion_ms\":{\"mediana\":90000,\"n\":5},\"devuelto_bytes\":{\"mediana\":1000,\"n\":5},\"tokens_medidos\":{\"total\":600000,\"n\":5},\"estimado\":{\"estado\":\"vacio\"},
  \"detalle\":[{\"tipo\":\"tycon-story-validator\",\"veredicto\":\"hallazgos\",\"veredicto_reglas\":[\"VAL-W15\"],\"informe\":\"FUGA_INFORME_VALIDADOR\",\"prompt\":\"FUGA_PROMPT_VALIDADOR\"}],
  \"validador\":{\"estado\":\"medido\",\"lanzamientos\":5,\"campo_extra\":\"FUGA_EXTRA_VALIDADOR\",\"por_fase\":{
    \"antes-de-implementar\":{\"lanzamientos\":1,\"limpio\":1,\"hallazgos\":0,\"inconsistente\":0,\"sin_veredicto\":0,\"no_medido\":0},
    \"vuelta-1\":{\"lanzamientos\":1,\"limpio\":0,\"hallazgos\":1,\"inconsistente\":0,\"sin_veredicto\":0,\"no_medido\":0},
    \"re-loop\":{\"lanzamientos\":2,\"limpio\":2,\"hallazgos\":0,\"inconsistente\":0,\"sin_veredicto\":0,\"no_medido\":0},
    \"sin-vuelta\":${FASE_CERO},
    \"otra-story\":{\"lanzamientos\":1,\"limpio\":0,\"hallazgos\":1,\"inconsistente\":0,\"sin_veredicto\":0,\"no_medido\":0},
    \"FUGA_FASE\":{\"lanzamientos\":9}}}},
 \"gates\":[{\"ts\":\"2026-08-15T06:30:00.000Z\",\"name\":\"validador-reloop\",\"iter\":2,\"invoca\":true,\"limpias_seguidas\":1,\"motivo\":\"FUGA_MOTIVO_GATE\"},
           {\"ts\":\"2026-08-15T06:50:00.000Z\",\"name\":\"validador-reloop\",\"iter\":3,\"invoca\":false,\"limpias_seguidas\":2,\"motivo\":\"dos limpios\"}]}"
generar "${T}/r" "${T}/o.html" "${T}/log"
J="$(modelo_json "${T}/r")"
python3 -c "
import json,sys
v=json.loads(sys.argv[1])['corridas'][0].get('validador')
cero={'lanzamientos':0,'limpio':0,'hallazgos':0,'inconsistente':0,'sin_veredicto':0,'no_medido':0}
esp={'estado':'medido','lanzamientos':5,'por_fase':{
  'antes-de-implementar':dict(cero,lanzamientos=1,limpio=1),'vuelta-1':dict(cero,lanzamientos=1,hallazgos=1),
  're-loop':dict(cero,lanzamientos=2,limpio=2),'sin-vuelta':cero,'otra-story':dict(cero,lanzamientos=1,hallazgos=1)},
  're_loops_sin_relanzar':1,'re_loops_decididos':2}
assert v==esp, v
" "${J}" && ok "7.3-T6 el modelo publica el resumen del validador por lista blanca (fases conocidas, conteos, vueltas de revisores sin relanzar 1 de 2)" || mal "7.3-T6 resumen del validador: $(echo "${J}" | python3 -c 'import json,sys;print(json.dumps(json.load(sys.stdin)["corridas"][0].get("validador")))' 2>&1 | head -c 400)"
for marca in FUGA_INFORME_VALIDADOR FUGA_PROMPT_VALIDADOR FUGA_EXTRA_VALIDADOR FUGA_FASE FUGA_MOTIVO_GATE; do
  n="$(grep -c -F -- "${marca}" "${T}/o.html")"
  [ "${n}" -eq 0 ] && ok "7.3-T6 no se filtra ${marca}" || mal "7.3-T6 SE FILTRA ${marca} (${n} veces)"
done
F="$(cliente "${T}/o.html" container fichas)"
grep -q 'El validador de stories, por fase' <<< "${F}" && ok "7.3-T6 la ficha existe" || mal "7.3-T6 falta la ficha del validador"
grep -q '2 de 5 con hallazgos' <<< "${F}" && ok "7.3-T6 la ficha dice «2 de 5 con hallazgos» (denominador: los que dejaron veredicto)" || mal "7.3-T6 la ficha no trae el total con denominador"
grep -q 'otras stories 1 de 1' <<< "${F}" && grep -q 'vueltas de revisores 0 de 2' <<< "${F}" && ok "7.3-T6 la ficha desglosa por fase" || mal "7.3-T6 la ficha no desglosa por fase: $(echo "${F}" | grep -o 'validador de stories[^<]*<[^§]\{0,600\}' | head -c 600)"
grep -q 'no se relanzó en 1 de 2 vueltas de revisores' <<< "${F}" && ok "7.3-T6 la ficha cuenta las vueltas de revisores sin relanzar" || mal "7.3-T6 la ficha no cuenta las vueltas de revisores sin relanzar"
D="$(cliente "${T}/o.html" detail 0)"
grep -q 'validador de stories' <<< "${D}" && ok "7.3-T6 el detalle de la ejecución dice qué dijo el validador por fase" || mal "7.3-T6 el detalle de la ejecución no nombra al validador"
rm -rf "${T}"

# ── T6b · Corridas_Validador_SinResultado_SeCuentan ──────────
# 🔴 Falla con: que la ficha sume limpio, hallazgos, inconsistente y sin veredicto, pero no los lanzamientos
#    que NO VOLVIERON (`no_medido`): desaparecen de todo número ejecutivo mientras la tarjeta de la corrida sí
#    los dice. Mutación: volver a sumar sin `no_medido` (en la ficha con veredictos y en la gris).
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "" "{\"revisores\":{\"estado\":\"medido\",\"lanzamientos\":5,\"duracion_ms\":{\"mediana\":1,\"n\":3},\"devuelto_bytes\":{\"mediana\":1,\"n\":3},\"tokens_medidos\":{\"total\":1,\"n\":3},\"estimado\":{\"estado\":\"vacio\"},
  \"validador\":{\"estado\":\"medido\",\"lanzamientos\":5,\"por_fase\":{\"antes-de-implementar\":${FASE_CERO},\"vuelta-1\":{\"lanzamientos\":5,\"limpio\":2,\"hallazgos\":1,\"inconsistente\":0,\"sin_veredicto\":0,\"no_medido\":2},\"re-loop\":${FASE_CERO},\"sin-vuelta\":${FASE_CERO},\"otra-story\":${FASE_CERO}}}}}"
generar "${T}/r" "${T}/o.html" "${T}/log"
F="$(cliente "${T}/o.html" container fichas)"
grep -q '1 de 3 con hallazgos' <<< "${F}" && ok "7.3-T6b el denominador sigue siendo los que dejaron veredicto" || mal "7.3-T6b la ficha no trae «1 de 3 con hallazgos»"
grep -q '2</b> lanzamientos sin resultado' <<< "${F}" && ok "7.3-T6b los lanzamientos que no volvieron se cuentan aparte" || mal "7.3-T6b los lanzamientos sin resultado desaparecen de la ficha: $(echo "${F}" | grep -o 'vuelta 1 1 de 3[^<]\{0,200\}' | head -c 300)"
rm -rf "${T}"
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "" "{\"revisores\":{\"estado\":\"medido\",\"lanzamientos\":2,\"duracion_ms\":{\"mediana\":1,\"n\":1},\"devuelto_bytes\":{\"mediana\":1,\"n\":1},\"tokens_medidos\":{\"total\":1,\"n\":1},\"estimado\":{\"estado\":\"vacio\"},
  \"validador\":{\"estado\":\"medido\",\"lanzamientos\":2,\"por_fase\":{\"antes-de-implementar\":${FASE_CERO},\"vuelta-1\":{\"lanzamientos\":2,\"limpio\":0,\"hallazgos\":0,\"inconsistente\":0,\"sin_veredicto\":0,\"no_medido\":2},\"re-loop\":${FASE_CERO},\"sin-vuelta\":${FASE_CERO},\"otra-story\":${FASE_CERO}}}}}"
generar "${T}/r" "${T}/o.html" "${T}/log"
F="$(cliente "${T}/o.html" container fichas)"
TILE="$(echo "${F}" | python3 -c "
import sys
h=sys.stdin.read(); i=h.find('El validador de stories, por fase')
print(h[max(0,h.rfind('<div class=\"tile',0,i)):i+700] if i>=0 else 'AUSENTE')")"
grep -q 'tile blind' <<< "${TILE}" && grep -q '2 lanzamientos sin resultado' <<< "${TILE}" && ok "7.3-T6b sin veredictos, la ficha gris dice cuántos no volvieron" || mal "7.3-T6b la ficha gris no cuenta los sin resultado: $(echo "${TILE}" | head -c 300)"
rm -rf "${T}"

# ── T7 · Corridas_Validador_SinVeredictos_Gris ─────────────────────────────────────────
# 🔴 Falla con: sin la ficha. Mutación: dibujar «0 de 0» (o 0 %) donde no hay ningún veredicto.
T=$(mktemp -d)
volcado "${T}/r" "${S1}"
volcado "${T}/r" "${S2}" "2026-08-16T05:53:47Z" "{\"revisores\":{\"estado\":\"medido\",\"lanzamientos\":3,\"duracion_ms\":{\"mediana\":1,\"n\":1},\"devuelto_bytes\":{\"mediana\":1,\"n\":1},\"tokens_medidos\":{\"total\":1,\"n\":1},\"estimado\":{\"estado\":\"vacio\"},
  \"validador\":{\"estado\":\"medido\",\"lanzamientos\":3,\"por_fase\":{\"antes-de-implementar\":${FASE_CERO},\"vuelta-1\":{\"lanzamientos\":3,\"limpio\":0,\"hallazgos\":0,\"inconsistente\":0,\"sin_veredicto\":3,\"no_medido\":0},\"re-loop\":${FASE_CERO},\"sin-vuelta\":${FASE_CERO},\"otra-story\":${FASE_CERO}}}}}"
generar "${T}/r" "${T}/o.html" "${T}/log"
J="$(modelo_json "${T}/r")"
python3 -c "
import json,sys
cs=json.loads(sys.argv[1])['corridas']
vieja=[c for c in cs if c['story']=='2.1' and c['validador']['estado']=='no_medido']
assert len(vieja)==1 and all(p in vieja[0]['validador']['motivo'] for p in ('validador', 'veredicto')), [c['validador'] for c in cs]
" "${J}" && ok "7.3-T7 una corrida anterior a la 7.3 publica el validador como no medido, con el motivo" || mal "7.3-T7 corrida vieja: $(echo "${J}" | head -c 300)"
F="$(cliente "${T}/o.html" container fichas)"
TILE="$(echo "${F}" | python3 -c "
import sys,re
h=sys.stdin.read(); i=h.find('El validador de stories, por fase')
print(h[max(0,h.rfind('<div class=\"tile',0,i)):i+700] if i>=0 else 'AUSENTE')")"
grep -q 'tile blind' <<< "${TILE}" && grep -q 'no dejan veredicto' <<< "${TILE}" && ok "7.3-T7 sin ningún veredicto la ficha sale gris con el motivo" || mal "7.3-T7 la ficha no sale gris con el motivo: $(echo "${TILE}" | head -c 300)"
grep -q '3 lanzamientos sin veredicto' <<< "${TILE}" && ok "7.3-T7 el motivo cuenta los lanzamientos sin veredicto (no los esconde)" || mal "7.3-T7 el motivo no cuenta los sin veredicto"
grep -q '0 de 0' <<< "${TILE}" && mal "7.3-T7 dibujó «0 de 0» donde no hay veredictos" || ok "7.3-T7 ningún «0 de 0» dibujado"
rm -rf "${T}"

# ── ANCHO-T1 · ninguna columna de la tabla queda fuera del ancho de la página (Chrome real, 1400 px) ──
# 🔴 Falla con: dejar las etiquetas de «controles» sin partir, que (con «máquina», «trabajo» y «espera»)
#    empujan agentes, vueltas y tokens detrás de un scroll horizontal que en Mac no se ve.
#    Mutación: `td.frenos{white-space:nowrap}` o sacar el orden nuevo de las columnas → rojo.
# Necesita un navegador de verdad (el DOM mínimo de arriba no calcula anchos). Sin Chrome el caso sale
# NO MEDIDO con su motivo — nunca «ok».
CHROME_BIN="${TYCON_CHROME:-}"
# TYCON_CHROME=0: «esta máquina no tiene navegador» a propósito — la prueba de suites portables corre
# en una HOME vacía, donde Chrome sin perfil vuelca el DOM y no sale nunca; el caso sale NO MEDIDO, nunca «ok».
if [ "${CHROME_BIN}" = "0" ]; then
  CHROME_BIN=""
elif [ -z "${CHROME_BIN}" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" google-chrome google-chrome-stable chromium chromium-browser; do
    if [ -x "${c}" ] || command -v "${c}" >/dev/null 2>&1; then CHROME_BIN="${c}"; break; fi
  done
fi
if [ -z "${CHROME_BIN}" ]; then
  echo "  NO MEDIDO — ANCHO-T1 no hay Chrome en esta máquina (TYCON_CHROME lo apunta; TYCON_CHROME=0 lo apaga a propósito): el ancho de la tabla no se verificó"
else
  T=$(mktemp -d); CB="${T}/buzon"; RB="${T}/local"
  # el peor caso: la máquina de nombre más largo y tres controles con etiqueta larga y contador
  GATES='[{"ts":"2026-09-10T10:20:00.000Z","check":"atdd-preedit","status":"red:exit=1"},{"ts":"2026-09-10T10:21:00.000Z","check":"atdd-commit","status":"red:exit=1"},{"ts":"2026-09-10T10:22:00.000Z","check":"story-skill-gate","status":"blocked"}]'
  volcado "${CB}/macbook-pro-de-devb" "${S1}" "2026-09-10T10:00:00Z" "{\"marker\":{\"storyId\":\"5.17\",\"repoPath\":\"/Users/dev/SourceCode/FRESNO/CodigoFRESNOBZExtForms--wt-story-5-17-tanda-b\",\"stepsCompleted\":[0,1,2,3,4,5,6,7]},\"gates\":${GATES}}"
  volcado "${RB}" "${S2}" "2026-09-11T10:00:00Z" '{"marker":{"storyId":"2.10","storyPath":"/Users/dev/x/specs/story-2.10-una-descripcion-larguisima-de-la-story-que-tiene-que-partir-renglon-y-no-ensanchar-la-tabla.md"}}'
  TYCON_MACHINE=devas-mac-mini node "${TABLERO}" --view runs --runs-dir "${RB}" --mailbox "${CB}" --output "${T}/o.html" >"${T}/log" 2>&1
  cat >> "${T}/o.html" <<'MEDIR'
<script>window.addEventListener('load',function(){var caja=document.querySelector('.tabla'),t=caja.querySelector('table'),d=caja.getBoundingClientRect().right+1,fuera=[];t.querySelectorAll('thead th').forEach(function(th){if(th.getBoundingClientRect().right>d)fuera.push(th.childNodes[0].textContent.trim());});document.body.setAttribute('data-ancho',(t.scrollWidth<=caja.clientWidth+1&&!fuera.length?'entra':'desborda')+'|'+t.scrollWidth+'/'+caja.clientWidth+'|'+fuera.join(','));});</script>
MEDIR
  # Tope de tiempo: sin perfil de Chrome —una HOME vacía, o un perfil recién creado con
  # --user-data-dir— el navegador vuelca el DOM y después NO SALE nunca; la suite entera queda colgada
  # sin tope. No se le da un perfil temporal (eso es lo que lo cuelga): usa el perfil que haya
  # y, si a los 60 s no salió, se lo mata y el caso sale rojo con «sin-medida», nunca colgado. `perl alarm` porque
  # macOS no trae `timeout`. Sin navegador (HOME vacía) la prueba de suites portables lo apaga con TYCON_CHROME=0.
  R_ANCHO="$(perl -e 'alarm shift; exec @ARGV' 60 "${CHROME_BIN}" --headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check --window-size=1400,1000 --virtual-time-budget=4000 --dump-dom "file://${T}/o.html?abrir=0" 2>/dev/null | python3 -c "
import re,sys; m=re.search(r'data-ancho=\"([^\"]*)\"', sys.stdin.read()); print(m.group(1) if m else 'sin-medida')")"
  case "${R_ANCHO}" in
    entra\|*) ok "ANCHO-T1 a 1400 px las 13 columnas entran en la tabla sin scroll, con una descripción larga y el detalle abierto (${R_ANCHO#entra|})" ;;
    sin-medida) mal "ANCHO-T1 Chrome no devolvió la medida (¿la página no cargó?): $(head -c 300 "${T}/log")" ;;
    *) mal "ANCHO-T1 la tabla desborda a 1400 px — tabla/caja y columnas fuera: ${R_ANCHO#desborda|}" ;;
  esac
  rm -rf "${T}"
fi

# ── CAMBIOS-T1 · el detalle muestra los archivos que tocó la corrida y su cambio, leídos del hilo ──
# 🔴 Falla con: que la vista no lea el hilo → ni archivos ni cambios en el detalle.
#    Mutaciones que lo ponen rojo: no relativizar la ruta (sale /Users/dev/…), no pasar el cambio por el
#    saneado (sale la clave), meter el texto en el modelo en vez de comprimido aparte, o decir «no tocó
#    nada» a una corrida sin hilo.
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "2026-08-15T05:53:47Z" '{"marker":{"repoPath":"/Users/dev/SourceCode/Totora/FrontEnd"}}' con-hilo.json
volcado "${T}/r" "${S2}" "2026-08-16T05:53:47Z" '{"marker":{"repoPath":"/Users/dev/SourceCode/Totora/Backend"}}' sin-hilo.json
# la AS-1: ni una edición con herramientas, todo desde la consola, y un commit de 8 archivos → no es «0»
volcado "${T}/r" "${S3}" "2026-08-17T05:53:47Z" '{"marker":{"storyId":"AS-1"}}' consola.json
python3 - "${T}/r/consola.hilo.jsonl.gz" <<'PYK'
import gzip, json, sys
l = [{"type": "assistant", "timestamp": "2026-08-17T06:10:00.000Z", "message": {"content": [{"type": "tool_use", "name": "Bash", "input": {"command": "python3 - <<'EOF'\nopen('a.cs','w').write('x')\nEOF"}}]}},
     {"type": "user", "timestamp": "2026-08-17T06:30:00.000Z", "message": {"content": [{"type": "tool_result", "content": "[dev 0627d30] feat: por consola\n 8 files changed, 120 insertions(+)"}]}}]
with gzip.open(sys.argv[1], "wt") as f:
    for x in l: f.write(json.dumps(x) + "\n")
PYK
python3 - "${T}/r/con-hilo.hilo.jsonl.gz" <<'PYH'
import gzip, json, sys
def uso(ts, name, inp): return {"type": "assistant", "timestamp": ts, "message": {"content": [{"type": "tool_use", "name": name, "input": inp}]}}
lineas = [
  uso("2026-08-15T05:50:00.000Z", "Edit", {"file_path": "/Users/dev/SourceCode/Totora/FrontEnd/src/Previa.ts", "old_string": "a", "new_string": "b"}),
  uso("2026-08-15T06:20:00.000Z", "Edit", {"file_path": "/Users/dev/SourceCode/Totora/FrontEnd/src/Pago.ts",
      "old_string": "const viejo = 0;", "new_string": "const CODIGO_SEMBRADO_42 = 1;\nconst cadena = \"Password=ClaveSecreta123;\";"}),
  uso("2026-08-15T07:10:00.000Z", "Write", {"file_path": "/private/tmp/claude-501/-Users-dev-SourceCode-Totora/abcd/scratchpad/clon/src/Nuevo.ts", "content": "export const NUEVO_SEMBRADO = true;"}),
  {"type": "user", "timestamp": "2026-08-15T07:30:00.000Z", "message": {"content": [{"type": "tool_result", "content": "[main abc1234] feat: commit sembrado\n 2 files changed"}]}},
  {"type": "user", "timestamp": "2026-08-15T05:55:00.000Z", "message": {"content": [{"type": "tool_result", "content": "     1\t---\n     2\tstory: \"2.1\"\n     3\tepic: 2\n     4\ttitle: \"TITULO SEMBRADO de la story\"\n     5\tstatus: ready\n"}]}},
  # la MISMA respuesta partida en dos líneas (mismo id): el consumo cuenta una vez; la herramienta, sí
  {"type": "assistant", "timestamp": "2026-08-15T06:00:00.000Z", "message": {"id": "msg_1", "model": "claude-opus-5", "usage": {"input_tokens": 10, "output_tokens": 100, "cache_creation_input_tokens": 1000, "cache_read_input_tokens": 99999}, "content": [{"type": "text", "text": "x"}]}},
  {"type": "assistant", "timestamp": "2026-08-15T06:00:00.000Z", "message": {"id": "msg_1", "model": "claude-opus-5", "usage": {"input_tokens": 10, "output_tokens": 100, "cache_creation_input_tokens": 1000, "cache_read_input_tokens": 99999}, "content": [{"type": "tool_use", "name": "Bash", "input": {"command": "echo COMANDO_SEMBRADO_NO_SALE"}}, {"type": "tool_use", "name": "Agent", "input": {"subagent_type": "tycon-story-validator", "prompt": "PROMPT_SEMBRADO_NO_SALE"}}]}},
]
with gzip.open(sys.argv[1], "wt") as f:
    for l in lineas: f.write(json.dumps(l) + "\n")
PYH
generar "${T}/r" "${T}/o.html" "${T}/log"
J="$(modelo_json "${T}/r")"
python3 -c "
import json,sys
m=json.loads(sys.argv[1]); k=[x['cambios'] for x in m['corridas'] if x['story']=='AS-1'][0]
assert [a['f'] for a in k['archivos']]==['a.cs'] and k['lista'][0]['k']==1 and k['por_consola']==1 and k['en_commits']==8, k
m['corridas']=[x for x in m['corridas'] if x['story']!='AS-1']
c={x['cambios']['estado']: x['cambios'] for x in m['corridas']}
l=c['leido']; fs=[a['f'] for a in l['archivos']]
assert fs==['src/Pago.ts','src/Nuevo.ts'], fs
assert l['anteriores_al_inicio']==1 and len(l['lista'])==2 and l['lista'][0]['p']=='6', l
assert [x['h'] for x in l['commits']]==['abc1234'], l['commits']
assert 'no tiene su conversación guardada' in c['sin_hilo']['motivo'], c['sin_hilo']
assert '_texto' not in json.dumps(m) and 'CODIGO_SEMBRADO' not in json.dumps(m)
# la descripción: el título de la story con hilo; sin hilo, nada inventado (el archivo se llama story-2.1.md)
d={x['cambios']['estado']: x.get('descripcion') for x in m['corridas']}
assert d['leido']=={'texto':'TITULO SEMBRADO de la story','fuente':'el título de la story'}, d
assert d['sin_hilo'] is None, d
# la columna «archivos»: el número con hilo; sin hilo una raya con motivo, nunca 0
import re; h=open(sys.argv[2],encoding='utf8').read(); ar=re.findall(r'<td class=\"ar\">(.*?)</td>',h)
assert sorted(re.sub(r'<[^>]+>','',x) for x in ar)==['1','2','—'] and 'no es cero' in ''.join(ar), ar
# el consumo minuto a minuto: la respuesta partida en dos líneas cuenta UNA vez (1110, no 2220); sólo nombres
mi=[x for x in l['minutos'] if x[0]==6]
assert mi==[[6,1110,100,1000,{'Bash':1,'Agent':1},{'tycon-story-validator':1}]], l['minutos']
assert 'COMANDO_SEMBRADO' not in json.dumps(m) and 'PROMPT_SEMBRADO' not in json.dumps(m)
" "${J}" "${T}/o.html" && ok "CAMBIOS-T1 el modelo trae archivos relativos al repo (el clon del scratchpad también), el paso, el commit y lo previo contado aparte; sin hilo dice «sin hilo»" || mal "CAMBIOS-T1 modelo: $(echo "${J}" | head -c 400)"
R="$(python3 - "${T}/o.html" <<'PYC'
import base64, gzip, json, re, sys
h = open(sys.argv[1], encoding='utf8').read()
b = re.findall(r'<script type="text/plain" id="cz-\d+">([^<]*)</script>', h)
txt = ''.join(gzip.decompress(base64.b64decode(x)).decode() for x in b) if len(b) == 2 else ''   # la corrida con ediciones y la de consola
modelo = re.search(r'<script id="modelo" type="application/json">([\s\S]*?)</script>', h).group(1)
print('|'.join([
  'codigo' if 'CODIGO_SEMBRADO_42' in txt and 'NUEVO_SEMBRADO' in txt else 'sin-codigo',
  'clave-tapada' if 'ClaveSecreta123' not in h and 'ClaveSecreta123' not in txt else 'CLAVE-VISIBLE',
  'sin-ruta-abs' if '/Users/dev' not in h and '/Users/dev' not in txt else 'RUTA-ABS',
  'comprimido' if 'CODIGO_SEMBRADO' not in h else 'EN-CLARO']))
PYC
)"
[ "${R}" = "codigo|clave-tapada|sin-ruta-abs|comprimido" ] && ok "CAMBIOS-T1 la página trae el cambio comprimido aparte, con la clave tapada y sin rutas absolutas" || mal "CAMBIOS-T1 página: ${R}"
D0="$(cliente "${T}/o.html" all)"
grep -q 'Archivos que tocó' <<< "${D0}" && grep -q 'src/Pago.ts' <<< "${D0}" && grep -q 'sin conversación' <<< "${D0}" && grep -q 'se muestra <b>entero</b>' <<< "${D0}" && grep -q 'class="balde"' <<< "${D0}" && grep -q 'class="tokbar"' <<< "${D0}" && grep -q 'TITULO SEMBRADO de la story' <<< "${D0}" && grep -q 'sin conversación: no hay consumo minuto a minuto' <<< "${D0}" && grep -q 'a.cs</span> <span class="nd">por consola' <<< "${D0}" && grep -q 'Sus commits llevaron <b>8 archivos</b>' <<< "${D0}" && grep -q 'sin conversación: no se sabe qué archivos tocó' <<< "${D0}" \
  && ok "CAMBIOS-T1 el detalle dice de qué fue la ejecución, lista los archivos enteros, dibuja archivos y consumo en el gráfico y marca «sin hilo» donde no hay" || mal "CAMBIOS-T1 detalle: $(echo "${D0}" | grep -o 'Archivos que tocó.\{0,300\}' | head -2)"
rm -rf "${T}"

# ── ESPERA-T1 · la espera por una persona sale del hilo, no sólo de los pasos 3 y 7 ──
# 🔴 Falla con: una corrida que le pregunta al dev en el paso 5 a las 03:32 y recibe la respuesta a las 11:44; la
#    página debe decir «10,4 h, trabajo 9,8 h, espera 5 min». Mutación: no restar la espera del trabajo → rojo.
T=$(mktemp -d)
PASOS='{"marker":{"stepTimings":{"0":{"startedAt":"2026-08-15T05:53:47.000Z","completedAt":"2026-08-15T05:54:47.000Z"},"1":{"startedAt":"2026-08-15T05:54:47.000Z","completedAt":"2026-08-15T06:03:47.000Z"},"2":{"startedAt":"2026-08-15T06:03:47.000Z","completedAt":"2026-08-15T06:05:47.000Z"},"3":{"startedAt":"2026-08-15T06:05:47.000Z","completedAt":"2026-08-15T06:07:47.000Z"},"4":{"startedAt":"2026-08-15T06:07:47.000Z","completedAt":"2026-08-15T06:33:47.000Z"},"5":{"startedAt":"2026-08-15T06:33:47.000Z","completedAt":"2026-08-15T07:28:47.000Z"},"6":{"startedAt":"2026-08-15T07:28:47.000Z","completedAt":"2026-08-15T07:33:47.000Z"},"7":{"startedAt":"2026-08-15T07:33:47.000Z","completedAt":"2026-08-15T07:35:47.000Z"},"8":{"startedAt":"2026-08-15T07:35:47.000Z","completedAt":"2026-08-15T07:51:47.000Z"}}}}'
volcado "${T}/r" "${S1}" "2026-08-15T05:53:47Z" "${PASOS}" espera.json
python3 - "${T}/r/espera.hilo.jsonl.gz" <<'PYE'
import gzip, json, sys
l = [
  {"type": "assistant", "timestamp": "2026-08-15T06:40:00.000Z", "message": {"content": [{"type": "tool_use", "id": "q1", "name": "AskUserQuestion", "input": {"questions": []}}]}},
  {"type": "user", "timestamp": "2026-08-15T07:10:00.000Z", "message": {"content": [{"type": "tool_result", "tool_use_id": "q1", "content": "PREGUNTA_SEMBRADA_NO_SALE"}]}},
  {"type": "assistant", "timestamp": "2026-08-15T07:40:00.000Z", "message": {"content": [{"type": "text", "text": "listo el paso"}]}},
  {"type": "user", "timestamp": "2026-08-15T07:50:00.000Z", "origin": {"kind": "human"}, "message": {"content": "RESPUESTA_SEMBRADA_NO_SALE"}},
]
with gzip.open(sys.argv[1], "wt") as f:
    for x in l: f.write(json.dumps(x) + "\n")
PYE
generar "${T}/r" "${T}/o.html" "${T}/log"
J="$(modelo_json "${T}/r")"
python3 -c "
import json,sys
m=json.loads(sys.argv[1]); t=m['corridas'][0]['tiempos']
# paso 5 (55 min) tenía 30 min de pregunta; paso 8 (16 min) tenía 10 min esperando un mensaje. Los pasos 3 y 7 ya eran 4 min de espera.
assert t['espera_del_hilo_ms']==40*60000, t
assert t['espera_humana_ms']==44*60000, t
assert t['trabajo_ms']==(118-4-40)*60000, t
w=m['corridas'][0]['cambios']['esperas_min']; assert w==[[46.22,76.22],[106.22,116.22]], w
assert 'SEMBRADA' not in json.dumps(m)
" "${J}" && ok "ESPERA-T1 una pregunta en el paso 5 y un turno que esperó al dev pasan de trabajo a espera, sin publicar el texto" || mal "ESPERA-T1 $(echo "${J}" | python3 -c "import json,sys; c=json.load(sys.stdin)['corridas'][0]; print(c.get('tiempos'), c['cambios'].get('esperas_min'))" 2>&1 | head -c 400)"
D0="$(cliente "${T}/o.html" detail 0)"
grep -q 'fill="url(#espera)"' <<< "${D0}" && grep -q 'esperando a una persona' <<< "${D0}" && ok "ESPERA-T1 el gráfico dibuja la espera" || mal "ESPERA-T1 el gráfico no dibuja la espera"
# la ficha: la corrida medida entra en la mediana; una SIN arranques pero con espera en el hilo va aparte, como piso
volcado "${T}/r" "${S2}" "2026-08-16T05:53:47Z" '' piso.json
python3 - "${T}/r/piso.hilo.jsonl.gz" <<'PYP'
import gzip, json, sys
l = [{"type": "assistant", "timestamp": "2026-08-16T06:10:00.000Z", "message": {"content": [{"type": "tool_use", "id": "q9", "name": "AskUserQuestion", "input": {}}]}},
     {"type": "user", "timestamp": "2026-08-16T07:10:00.000Z", "message": {"content": [{"type": "tool_result", "tool_use_id": "q9", "content": "x"}]}}]
with gzip.open(sys.argv[1], "wt") as f:
    for x in l: f.write(json.dumps(x) + "\n")
PYP
generar "${T}/r" "${T}/o.html" "${T}/log"
F="$(cliente "${T}/o.html" container fichas)"
grep -q '>44 min<' <<< "${F}" && grep -q 'n=1 de 2 ejecuciones' <<< "${F}" && grep -q 'en otra ejecución sin la espera de los pasos medida, la conversación muestra <b>al menos 60 min</b>' <<< "${F}" \
  && ok "ESPERA-T1 la ficha: la mediana sólo con la medida (44 min, n=1) y el piso de la otra aparte (al menos 60 min)" || mal "ESPERA-T1 ficha de espera: $(echo "${F}" | grep -o 'Espera humana.\{0,500\}' | head -1)"
rm -rf "${T}"

# ── COMBO-T1 · el combo de producto va en orden alfabético, sin distinguir mayúsculas; lo «sin producto», al final ──
# 🔴 Falla con: ordenar por cantidad de corridas → para encontrar un repo hay que leer la lista entera.
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "" '{"marker":{"repoPath":"/Users/dev/SourceCode/tycon-claude-guides"}}' a.json
volcado "${T}/r" "${S2}" "" '{"marker":{"repoPath":"/Users/dev/SourceCode/tycon-claude-guides"}}' b.json
volcado "${T}/r" "${S3}" "" '{"marker":{"repoPath":"/Users/dev/SourceCode/Ceibo/CeiboBackend"}}' c.json
volcado "${T}/r" "44444444-4444-4444-8444-444444444444" "" '{"marker":{"repoPath":"/Users/dev/SourceCode/Modeler-MCP"}}' d.json
volcado "${T}/r" "55555555-5555-4555-8555-555555555555" "" '{"marker":{"repoPath":"."}}' e.json
generar "${T}/r" "${T}/o.html" "${T}/log"
R="$(cliente "${T}/o.html" container f-repo | grep -o 'value="[^"]*"' | tr '\n' ' ')"
[ "${R}" = 'value="" value="Ceibo/CeiboBackend" value="Modeler-MCP" value="tycon-claude-guides" value="(sin producto)" ' ] && ok "COMBO-T1 el combo de producto sale alfabético, con «sin producto» al final" || mal "COMBO-T1 el combo salió: ${R}"
rm -rf "${T}"

# ── PRODUCTO-T1 · el filtro es por REPO, no por la carpeta donde estaba clonado ──
# 🔴 Falla con: «Codigo/FRESNOBZExtBackend» (DevB) y «FRESNO/FRESNOBZExtBackend» (DevA) salen separados, igual que
#    un worktree «…--wt-x», los clones «tcg-2.10» del scratchpad, «.» y «tmp».
R="$(HOME=/Users/otro node -e "
const {producto:p,unificarProductos:u}=require('${RAIZ}/scripts/nightly/dashboard/runs.js');
const rutas=['/Users/devb/Proyectos/FRESNO/Codigo/FRESNOBZExtBackend','/Users/a/SourceCode/FRESNO/FRESNOBZExtBackend','/Users/devb/Proyectos/FRESNO/Codigo/FRESNOBZExtForms--wt-5-17-tanda-b',
 '/private/tmp/claude-501/-Users-a-SourceCode-tycon-claude-guides/00000000-0000-4000-8000-000000000003/scratchpad/tcg-215','/Users/a/SourceCode/tycon-claude-guides',
 '.','/tmp','/tmp/atk-vector4/CeiboBackend','/Users/a/SourceCode/Ceibo/CeiboBackend','/Users/a/SourceCode/PLUGINHost','/Users/a/SourceCode/PluginHost','/Users/a/SourceCode/PluginHost',
 '/Users/devb/Proyectos/Tucan/Codigo/Backend','/Users/a/SourceCode/Totora/Backend'];
const cs=rutas.map(r=>({producto:p(r)}));u(cs);console.log(cs.map(c=>c.producto).join('|'))")"
[ "${R}" = "FRESNO/FRESNOBZExtBackend|FRESNO/FRESNOBZExtBackend|FRESNO/FRESNOBZExtForms|tycon-claude-guides|tycon-claude-guides|||Ceibo/CeiboBackend|Ceibo/CeiboBackend|PluginHost|PluginHost|PluginHost|Tucan/Backend|Totora/Backend" ] \
  && ok "PRODUCTO-T1 un repo es una entrada: sin carpeta genérica, sin sufijo de worktree, el clon del scratchpad es su repo, mayúsculas y nombre suelto unificados, dos Backend distintos siguen distintos" || mal "PRODUCTO-T1 dio: ${R}"

# ── REPOS-T1 · un repo con sus worktrees es UN renglón; el repo real del volcado manda sobre la carpeta ──
# 🔴 Falla con: `arnes-wt-127` y `arnes--wt-x` salen como repos aparte, `c825a2c-impl` como un repo propio, o el
#    `repo.path` del volcado ignorado (un worktree con nombre libre, `otra-carpeta`, no cae en su repo).
T=$(mktemp -d)
volcado "${T}/r" "11111111-1111-4111-8111-111111111111" "" '{"marker":{"repoPath":"/Users/dev/SourceCode/arnes"}}' a.json
volcado "${T}/r" "22222222-2222-4222-8222-222222222222" "" '{"marker":{"repoPath":"/Users/dev/SourceCode/arnes-wt-127"}}' b.json
volcado "${T}/r" "33333333-3333-4333-8333-333333333333" "" '{"marker":{"repoPath":"/Users/dev/SourceCode/arnes--wt-x"}}' c.json
volcado "${T}/r" "44444444-4444-4444-8444-444444444444" "" '{"marker":{"repoPath":"/Users/Otro/Proyectos/ClienteA/Backend/c825a2c-impl"}}' d.json
volcado "${T}/r" "55555555-5555-4555-8555-555555555555" "" '{"marker":{"repoPath":"/Users/dev/SourceCode/otra-carpeta"},"repo":{"path":"/Users/dev/SourceCode/arnes","remote":"acme/arnes"}}' e.json
volcado "${T}/r" "66666666-6666-4666-8666-666666666666" "" '{"marker":{"repoPath":"/Users/dev/SourceCode/ClienteA/Backend"}}' f.json
R="$(node -e "
const r=require('${RAIZ}/scripts/nightly/dashboard/runs.js');
const M=r.modelo('${T}/r',{repos:[]});const c={};for(const x of M.corridas)c[x.producto]=(c[x.producto]||0)+1;
console.log(Object.keys(c).sort().map(k=>k+':'+c[k]).join('|'))")"
[ "${R}" = "ClienteA/Backend:2|arnes:4" ] && ok "REPOS-T1 tres worktrees y una carpeta con su repo real dan UN renglón; la carpeta de implementación cae en su repo" || mal "REPOS-T1 dio: ${R}"
rm -rf "${T}"

# ── REPOS-T2 · el producto sale de repos.json; un repo que no está queda sin producto ──
# 🔴 Falla con: un producto inventado para el repo ausente, el cruce por remoto ignorado, o `Backend` suelto cruzado con
#    uno de los dos `Backend` de la lista (es de varios: no se sabe de cuál).
R="$(node -e "
const r=require('${RAIZ}/scripts/nightly/dashboard/runs.js');
const repos=[{producto:'Cliente A',ruta:'ClienteA/Backend',ado:'Cliente%20A/ClienteABackend'},{producto:'Cliente B',ruta:'ClienteB/Backend',ado:'ClienteB/Backend'},{producto:'Viejo',ruta:'Viejo/Web',activo:false}];
const cs=[{producto:'ClienteA/Backend'},{producto:'clientea/backend'},{producto:'otro-nombre',remoto:'Cliente A/ClienteABackend'},{producto:'Backend'},{producto:'Viejo/Web'},{producto:'suelto'},{producto:'Otro/Backend'},{producto:'Web'}];
r.agruparRepos(cs,repos);r.agruparRepos(cs,repos);console.log(cs.map(c=>c.grupo).join('|'))")"
[ "${R}" = "Cliente A|Cliente A|Cliente A|||||" ] && ok "REPOS-T2 producto por ruta y por remoto, sin inventar: el ausente, el inactivo, el nombre ambiguo y otro repo con el mismo último tramo quedan sin producto" || mal "REPOS-T2 dio: ${R}"

# ── REPOS-T3 · el laboratorio va aparte, y lo decide la RUTA aunque el clon traiga un remoto real ──
# 🔴 Falla con: `acme-tienda` o un clon de /tmp mezclados con los productos, o el clon descartable de una sesión sacado del
#    laboratorio porque su `.git` apunta al repo de un producto.
T=$(mktemp -d)
volcado "${T}/r" "11111111-1111-4111-8111-111111111111" "" '{"marker":{"repoPath":"/Users/dev/SourceCode/acme-tienda"}}' a.json
volcado "${T}/r" "22222222-2222-4222-8222-222222222222" "" '{"marker":{"repoPath":"/private/var/folders/x1/T/ensayo-1/arnes"}}' b.json
volcado "${T}/r" "33333333-3333-4333-8333-333333333333" "" '{"marker":{"repoPath":"/private/tmp/claude-501/-Users-dev-SourceCode-arnes/00000000-0000-4000-8000-000000000003/scratchpad/clon"},"repo":{"path":"/private/tmp/claude-501/-Users-dev-SourceCode-arnes/00000000-0000-4000-8000-000000000003/scratchpad/clon","remote":"Cliente%20A/ClienteABackend"}}' c.json
volcado "${T}/r" "44444444-4444-4444-8444-444444444444" "" '{"marker":{"repoPath":"/Users/dev/SourceCode/ClienteA/Backend"}}' d.json
R="$(node -e "
const r=require('${RAIZ}/scripts/nightly/dashboard/runs.js');
const M=r.modelo('${T}/r',{repos:[{producto:'Cliente A',ruta:'ClienteA/Backend',ado:'Cliente%20A/ClienteABackend'}]});
console.log(M.corridas.map(c=>c.producto+'='+c.grupo).sort().join('|'))")"
[ "${R}" = "ClienteA/Backend=Cliente A|acme-tienda=laboratorio|arnes=laboratorio|arnes=laboratorio" ] && ok "REPOS-T3 acme-tienda, el clon de la carpeta temporal de macOS y el clon de una sesión con remoto real van a laboratorio" || mal "REPOS-T3 dio: ${R}"
# el filtro: un grupo por producto, «otros repos» y «laboratorio» al final; el valor del laboratorio no se junta con el repo
volcado "${T}/r" "55555555-5555-4555-8555-555555555555" "" '{"marker":{"repoPath":"/Users/dev/SourceCode/arnes"}}' e.json
volcado "${T}/r" "77777777-7777-4777-8777-777777777777" "" '{"marker":{"repoPath":"/Users/dev/SourceCode/acme-lab/arnes"}}' g.json
generar "${T}/r" "${T}/o.html" "${T}/log"
R="$(cliente "${T}/o.html" container f-repo | grep -o '<optgroup label="[^"]*"\|value="[^"]*"' | tr '\n' ' ')"
[ "${R}" = 'value="" <optgroup label="otros repos" value="arnes" value="ClienteA/Backend" <optgroup label="laboratorio" value="laboratorio/acme-lab/arnes" value="laboratorio/acme-tienda" ' ] \
  && ok "REPOS-T3 el filtro agrupa con optgroup: otros repos y laboratorio al final, con el valor del laboratorio aparte, y el nombre de un ensayo no se le pega al repo de verdad" || mal "REPOS-T3 el filtro salió: ${R}"
rm -rf "${T}"

# ── LOCAL-T1 · sin buzón, la vista va a ~/.claude y nunca al repo del equipo ──────────────
# 🔴 Falla con: SALIDA_DEFAULT en artifacts/ → cada máquina commitea su foto parcial (18 o 232 corridas
#    según quién la armó). Mutación: volver SALIDA_DEFAULT a artifacts/ o la negativa sólo en modo multi → rojo.
T=$(mktemp -d); volcado "${T}/r" "${S1}"; mkdir -p "${T}/casa"
env -u TYCON_MAILBOX_DIR HOME="${T}/casa" node "${TABLERO}" --view runs --runs-dir "${T}/r" > "${T}/log" 2>&1; RC=$?
[ "${RC}" -eq 0 ] && [ -f "${T}/casa/.claude/.tycon-pipeline/runs-dashboard.html" ] && [ ! -e "${ENTREGABLE_CORRIDAS}" ] && ok "LOCAL-T1 sin --output la página va a ~/.claude/.tycon-pipeline/runs-dashboard.html" || { mal "LOCAL-T1 rc=${RC}: $(tail -2 "${T}/log")"; [ "${HUELLA_CORRIDAS_ANTES}" = "AUSENTE" ] && rm -f "${ENTREGABLE_CORRIDAS}"; }
env -u TYCON_MAILBOX_DIR HOME="${T}/casa" node "${TABLERO}" --view runs --local-only --runs-dir "${T}/r" --output "${RAIZ}/artifacts/runs-dashboard.html" > "${T}/log" 2>&1; RC=$?
[ "${RC}" -eq 2 ] && [ ! -e "${ENTREGABLE_CORRIDAS}" ] && grep -q 'no se commitea' "${T}/log" && ok "LOCAL-T1 --local-only apuntada al repo del equipo → exit 2, sin escribir, y dice por qué" || { mal "LOCAL-T1 --local-only al repo salió ${RC}"; [ "${HUELLA_CORRIDAS_ANTES}" = "AUSENTE" ] && rm -f "${ENTREGABLE_CORRIDAS}"; }
rm -rf "${T}"

# ── LOCAL-T2 · la página por defecto se llama runs-dashboard.html; una máquina que todavía
#    tiene la de antes pasa por la migración de estado (prepareStateWrite) y la vieja queda intacta hasta el retiro ──
# 🔴 Falla con: SALIDA_DEFAULT con el nombre viejo, o escribir sin prepareStateWrite → la HOME no anota la migración.
#    El nombre viejo sale del mapa en tiempo de ejecución (nunca literal: lo cuenta spanish-names.js --stale-mentions).
T=$(mktemp -d); volcado "${T}/r" "${S1}"; mkdir -p "${T}/casa/.claude/.tycon-pipeline"
VIEJA=""
[ -f "${RAIZ}/scripts/lib/renames.json" ] && VIEJA="$(node -e "const m=require('${RAIZ}/scripts/lib/renames.json');const e=m.entries.find(x=>x.kind==='state-file'&&x.batch==='D2'&&x.new.endsWith('/runs-dashboard.html'));process.stdout.write(e?require('path').basename(e.old):'')")"
# en la copia pública el mapa no viaja: sin nombre viejo no hay migración que mirar
if [ ! -f "${RAIZ}/scripts/lib/renames.json" ]; then ok "LOCAL-T2 se saltea — copia pública, sin el mapa de renombres"
elif [ -z "${VIEJA}" ]; then mal "LOCAL-T2 el mapa no tiene la entrada D2 de runs-dashboard.html"; else
  echo '<html>foto vieja</html>' > "${T}/casa/.claude/.tycon-pipeline/${VIEJA}"
  env -u TYCON_MAILBOX_DIR HOME="${T}/casa" node "${TABLERO}" --view runs --runs-dir "${T}/r" > "${T}/log" 2>&1; RC=$?
  NUEVA="${T}/casa/.claude/.tycon-pipeline/runs-dashboard.html"
  [ "${RC}" -eq 0 ] && [ -f "${NUEVA}" ] && ! grep -q 'foto vieja' "${NUEVA}" && ok "LOCAL-T2 sin --output la página sale con el nombre nuevo, regenerada entera" || mal "LOCAL-T2 rc=${RC}: $(tail -2 "${T}/log")"
  grep -q 'foto vieja' "${T}/casa/.claude/.tycon-pipeline/${VIEJA}" && ok "LOCAL-T2 la página con el nombre viejo queda intacta" || mal "LOCAL-T2 tocó la página con el nombre viejo"
  grep -q '"script":"scripts/nightly/dashboard/runs.js"' "${T}/casa/.claude/.tycon-pipeline/legacy-names.jsonl" 2>/dev/null && grep -q "${VIEJA}" "${T}/casa/.claude/.tycon-pipeline/legacy-names.jsonl" \
    && ok "LOCAL-T2 la escritura pasó por la migración de estado (queda anotada a nombre de runs.js)" || mal "LOCAL-T2 escribió sin prepareStateWrite: $(cat "${T}/casa/.claude/.tycon-pipeline/legacy-names.jsonl" 2>/dev/null | head -3)"
fi
rm -rf "${T}"

# ── T40 · el resultado del pase adversarial se ve: veredicto + cuántos confirmados tienen prueba ──
# 🔴 Falla con: la línea `adversarial-pass` trae `veredicto`, no `status` → «sin estado», y un pase con
# 13 confirmados se dibuja igual que uno sin constancia. La línea trae además pruebas/diferidos.
# El `motivo` del diferido es prosa del dev: NO se publica (se siembra un nombre de cliente y se exige ausente).
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "" '{"gates":[{"ts":"2026-08-15T06:10:00.000Z","name":"adversarial-pass","storyId":"A","tipo":"5b","confirmados":3,"pruebas":1,"diferidos":2,"motivo":"código viejo de Cliente Grande SA","veredicto":"no-listo"},{"ts":"2026-08-15T06:20:00.000Z","name":"adversarial-pass","storyId":"A","tipo":"revision","confirmados":0,"pruebas":0,"diferidos":0,"motivo":null,"veredicto":"listo"}]}'
J="$(modelo_json "${T}/r")"
python3 -c "
import json,sys; c=json.loads(sys.argv[1])['corridas'][0]; k=c['controles']
assert (k['error'],k['paso'],k['sin_estado'])==(1,1,0), k
ev=[e for e in c['eventos'] if e['control']=='adversarial-pass']
assert ev[0]['nota']=='3 confirmados · 1 con prueba en la suite · 2 diferidos', ev[0]
assert ev[1]['nota']=='0 confirmados', ev[1]
" "${J}" && ok "T40 no-listo = error con su nota · listo = pasó" || mal "T40 el resultado del pase adversarial no se clasifica ni anota"
generar "${T}/r" "${T}/o.html" "${T}/log"
grep -q "Cliente Grande SA" "${T}/o.html" && mal "T40 el motivo del diferido (prosa del dev) se publicó" || ok "T40 el motivo del diferido no sale en la página"
grep -q "1 con prueba en la suite" "${T}/o.html" && ok "T40 la nota viaja a la página" || mal "T40 la nota no llegó a la página"
rm -rf "${T}"

# ── T36/T37/T38 · el resultado con la casilla de prueba propia ────────────────
# 🔴 Falla con: sin `propias`, la línea sale «1 con prueba en la suite · 1 diferido» y la prueba escrita a
#    mano no se cuenta. Mutación T36: volver al texto sin `propias` aunque venga `propias` → rojo. T37: exigir `propias`
#    para dibujar la nota → la línea vieja pierde su texto → rojo. T38: publicar `en` → el nombre sembrado aparece.
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "" '{"gates":[{"ts":"2026-08-15T06:10:00.000Z","name":"adversarial-pass","storyId":"A","tipo":"5b","confirmados":3,"pruebas":1,"propias":1,"en":["tests/ClienteSembradoSA/x.test.js"],"diferidos":1,"motivo":"otra story","veredicto":"no-listo"},{"ts":"2026-08-15T06:12:00.000Z","name":"adversarial-pass","storyId":"A","tipo":"5b","confirmados":3,"pruebas":1,"diferidos":2,"motivo":"código viejo","veredicto":"no-listo"}]}'
J="$(modelo_json "${T}/r")"
python3 -c "
import json,sys; c=json.loads(sys.argv[1])['corridas'][0]
ev=[e for e in c['eventos'] if e['control']=='adversarial-pass']
assert ev[0]['nota']=='3 confirmados · 1 con prueba promovida · 1 con prueba propia · 1 diferido', ev[0]
" "${J}" && ok "1.8-T36 con prueba propia: cuatro números en la nota" || mal "1.8-T36 la nota con prueba propia salió: $(echo "${J}" | grep -o '3 confirmados[^\"]*' | head -1)"
python3 -c "
import json,sys; c=json.loads(sys.argv[1])['corridas'][0]
ev=[e for e in c['eventos'] if e['control']=='adversarial-pass']
assert ev[1]['nota']=='3 confirmados · 1 con prueba en la suite · 2 diferidos', ev[1]
" "${J}" && ok "1.8-T37 una línea sin propias (anterior a la 1.8) conserva su texto" || mal "1.8-T37 la línea vieja cambió de texto"
generar "${T}/r" "${T}/o.html" "${T}/log"
grep -q "ClienteSembradoSA" "${T}/o.html" && mal "1.8-T38 las rutas de --en se publicaron" || ok "1.8-T38 las rutas de --en no salen en la página"
grep -q "1 con prueba propia" "${T}/o.html" && ok "1.8-T38 la nota con prueba propia llega a la página" || mal "1.8-T38 la nota con prueba propia no llegó a la página"
rm -rf "${T}"

# ── T39 · el salteo y el freno del paso 8 se ven con nombre y nota ─────────────
# 🔴 Falla con: sin entrada en CONTROLES salen con su nombre técnico y sin nota. Mutación: sacar las dos entradas
#    de CONTROLES → rojo; armar la nota con el `motivo` del portón (prosa) → «forzado» deja de ser la nota → rojo.
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "" '{"gates":[{"ts":"2026-08-15T06:10:00.000Z","name":"adversarial-skip","status":"ok","storyId":"A","motivo":"forzado OFF en /Users/dev/FUGA_MOTIVO_SKIP","forzado":true,"abandonado":false},{"ts":"2026-08-15T06:20:00.000Z","name":"adversarial-result-gate","status":"blocked","motivo":"sin-resultado","story":"A","step":8,"runId":"wf_FUGA_RUNID_GATE"}]}'
J="$(modelo_json "${T}/r")"
python3 -c "
import json,sys; m=json.loads(sys.argv[1]); c=m['corridas'][0]; n=m['controles_nombres']
assert n['adversarial-skip']=='pase adversarial (salteado por el portón)', n.get('adversarial-skip')
assert n['adversarial-result-gate']=='pase adversarial con su resultado (paso «Pase adversarial»)', n.get('adversarial-result-gate')
ev={e['control']:e for e in c['eventos']}
assert ev['adversarial-skip']['cls']=='paso' and 'forzado' in (ev['adversarial-skip']['nota'] or ''), ev['adversarial-skip']
assert ev['adversarial-result-gate']['cls']=='freno', ev['adversarial-result-gate']
assert c['controles']['por_control']['adversarial-result-gate']['freno']==1
" "${J}" && ok "1.8-T39 salteo y freno del paso 8: nombre legible, «forzado» en la nota, el bloqueo cuenta como freno" || mal "1.8-T39 salteo/freno del paso 8 mal nombrados o clasificados"
generar "${T}/r" "${T}/o.html" "${T}/log"
grep -q "FUGA_MOTIVO_SKIP" "${T}/o.html" && mal "1.8-T39 el motivo del portón (prosa, con ruta) se publicó" || ok "1.8-T39 el motivo del portón no sale en la página"
rm -rf "${T}"

# ── T51 · el tablero del equipo conoce los nombres nuevos ──
# 🔴 Falla con: sources.json (listas cerradas del reductor) sin adversarial-result-gate ni adversarial-skip, ni
#    los escapes ADVERSARIAL_SKIP_FORZADO y ADVERSARIAL_ABANDONADO: el tablero los publica como «otro». Un tipo
#    nuevo de marker.js puede llegar sin su entrada, así que se prueba la CLASE: todo kind/type que marker.js
#    escribe en bypass.log tiene que estar en los escapes. Mutación: sacar uno de los dos escapes → rojo.
#    marker.js sale del mismo árbol que sources.json; el instalado sólo en un árbol sin skills (el privado adelgazado).
SKILLS_T51="${RAIZ}/skills"
[ -f "${SKILLS_T51}/tycon-pipeline/scripts/marker.js" ] || SKILLS_T51="${TYCON_SKILLS_DIR:-$HOME/.claude/agent-skills/skills}"
R="$(node -e '
const fs=require("fs"); const f=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const busca=(o,k)=>{ if(o&&typeof o==="object"){ for(const [kk,v] of Object.entries(o)){ if(kk===k) return v; const r=busca(v,k); if(r!==undefined) return r; } } };
const m=busca(f,"metrics"); const esc=new Set(m.escapes.values); const blo=new Set(m.bloqueos.values);
const faltan=[];
for (const n of ["adversarial-result-gate","adversarial-skip"]) if(!blo.has(n)) faltan.push(n);
for (const n of ["ADVERSARIAL_SKIP_FORZADO","ADVERSARIAL_ABANDONADO"]) if(!esc.has(n)) faltan.push(n);
const src=fs.readFileSync(process.argv[2],"utf8"); let i=-1;
while((i=src.indexOf("appendLog(\x27bypass.log\x27",i+1))>=0){
  const tramo=src.slice(i, src.indexOf("});", i)+3);
  for (const mm of tramo.matchAll(/(?:kind|type):[^,}]*/g)) for (const t of mm[0].matchAll(/\x27([A-Z][A-Z_]+)\x27/g)) if(!esc.has(t[1])) faltan.push(t[1]);
}
console.log(faltan.length?"FALTAN "+[...new Set(faltan)].join(","):"OK");
' "${RAIZ}/scripts/nightly/dashboard/sources.json" "${SKILLS_T51}/tycon-pipeline/scripts/marker.js" 2>&1)"
[ "${R}" = "OK" ] && ok "1.8-T51 sources.json conoce los nombres nuevos y todo tipo de bypass.log que escribe marker.js" || mal "1.8-T51 ${R}"

# ── 2.19 · el cambio de cada corrida según git, arriba; la conversación, abajo ──────────
# Un volcado con hilo Y con su .cambio.json.gz sintético (la forma de scripts/metrics/run-change.js), y
# otro con hilo y SIN cambio. El parche del fixture trae una clave a propósito: la vista lo vuelve a sanear.
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "2026-08-15T05:53:47Z" '{}' con-git.json
volcado "${T}/r" "${S2}" "2026-08-16T05:53:47Z" '{}' sin-git.json
python3 - "${T}/r" <<'PYG'
import gzip, json, sys, os
d = sys.argv[1]
def uso(ts, name, inp): return {"type": "assistant", "timestamp": ts, "message": {"content": [{"type": "tool_use", "name": name, "input": inp}]}}
def hilo(nombre, dia):
    l = [
      uso(dia + "T06:20:00.000Z", "Edit", {"file_path": "/Users/dev/SourceCode/Totora/FrontEnd/src/Pago.ts", "old_string": "const viejo = 0;", "new_string": "const nuevo = 1;"}),
      uso(dia + "T06:25:00.000Z", "Bash", {"command": "sed -i '' 's/a/b/' tests/x.test.ts"}),
      uso(dia + "T06:30:00.000Z", "Bash", {"command": "cat > /Users/dev/SourceCode/Totora/FrontEnd/src/Filtro.cs <<'EOF'\nvar q = lista.Where(p => p.Id > 0);\nEOF"}),
      # el repo del arnés: la conversación lo nombra por su carpeta (agent-skills), git por su remoto (AgentSkills)
      uso(dia + "T06:35:00.000Z", "Bash", {"command": "sed -i '' 's/a/b/' /Users/dev/.claude/agent-skills/skills/x.js"}),
    ]
    with gzip.open(os.path.join(d, nombre), "wt") as f:
        for x in l: f.write(json.dumps(x) + "\n")
hilo("con-git.hilo.jsonl.gz", "2026-08-15")
hilo("sin-git.hilo.jsonl.gz", "2026-08-16")
diff = lambda ruta, lineas: "diff --git a/%s b/%s\n--- a/%s\n+++ b/%s\n@@ -1 +1,%d @@\n%s\n" % (ruta, ruta, ruta, ruta, len(lineas), "\n".join(lineas))
parte = lambda ruta, e, mas, menos, lineas: {"ruta": ruta, "estado": e, "mas": mas, "menos": menos, "binario": False, "parche": diff(ruta, lineas), "cortado": 0}
cambio = {"version": 1, "estado": "medido", "motivo": None, "medido_en": "2026-08-15T08:00:00Z",
  "ventana": {"desde": "2026-08-15T05:52:47Z", "hasta": "2026-08-15T08:00:00Z"},
  "repos": [
    {"nombre": "FrontEnd", "principal": True, "por": ["story", "herramientas", "consola"], "otras_sesiones": 1, "sin_commitear_previo": 3, "estado": "medido",
     "commits": [{"h": "abc123456789", "fecha": "2026-08-15T07:30:00Z", "asunto": "feat: commit sembrado", "archivos": [
        parte("src/Pago.ts", "M", 2, 1, ["-const viejo = 0;", "+const PARCHE_GIT_SEMBRADO = 1;", "+const cadena = \"Password=ClaveSecreta123;\";"]),
        parte("scripts/tests/x.test.ts", "A", 1, 0, ["+it('x')"])]},
       # copia compartida (arreglo 2026-09-18): un commit que coincidió con un comando de la sesión que no lo nombra
       {"h": "def987654321", "fecha": "2026-08-15T07:40:00Z", "asunto": "fix: hecho mientras corría un ls", "atribucion": "coincide_la_hora", "archivos": [
        parte("scripts/tests/x.test.ts", "M", 1, 0, ["+it('y')"])]}],
     "commits_de_otras_sesiones": [{"h": "aaaa1111bbbb", "fecha": "2026-08-15T07:35:00Z", "asunto": "ajeno: lo commiteó la otra sesión"}],
     "sin_commitear": [parte("src/Pago.ts", "M", 1, 0, ["+// SIN_COMMITEAR_SEMBRADO"]), parte("src/Filtro.cs", "A", 1, 0, ["+var q = lista.Where(p => p.Id > 0);"]),
                       {"ruta": "assets/logo.png", "estado": "A", "mas": 0, "menos": 0, "binario": True, "parche": None, "cortado": 0},
                       parte("docs/nota.md", "A", 1, 0, ["+nota"])]},
    {"nombre": "AgentSkills", "principal": False, "por": ["consola"], "otras_sesiones": 0, "estado": "medido",
     "commits": None, "commits_motivo": "esta copia no tiene historial local de git (reflog): no se puede saber qué commits hizo la corrida",
     "sin_commitear": [parte("skills/x.js", "M", 3, 0, ["+a", "+b", "+c"])]},
  ],
  "totales": {"repos": 2, "archivos": 6, "partes": 8, "cortados": 0, "sin_parche_por_tope": 0},
  "topes": {"por_parte": 200000, "por_corrida": 5242880}}
with open(os.path.join(d, "con-git.cambio.json.gz"), "wb") as f: f.write(gzip.compress(json.dumps(cambio).encode()))
PYG
generar "${T}/r" "${T}/o.html" "${T}/log"
J="$(modelo_json "${T}/r")"

# ── T14 · VistaSegunGit ──
# 🔴 Falla con: la vista que no lee el .cambio.json.gz → sin «según git». Mutaciones: meter el parche en el
#    modelo, no sanear otra vez, sumar las partes de un archivo en un número, o contar la columna del hilo.
python3 -c "
import json,sys
m=json.loads(sys.argv[1]); c={x['story_path_nombre'] if 'story_path_nombre' in x else x.get('sesion',''): x for x in m['corridas']}
cg=[x for x in m['corridas'] if (x.get('cambios') or {}).get('git',{}).get('estado')=='medido']
assert len(cg)==1, [ (x.get('cambios') or {}).get('git') for x in m['corridas']]
g=cg[0]['cambios']['git']
fs=[a['f'] for a in g['archivos']]
assert fs==['src/Pago.ts','scripts/tests/x.test.ts','src/Filtro.cs','assets/logo.png','docs/nota.md','AgentSkills/skills/x.js'], fs
pago=g['archivos'][0]
assert len(pago['partes'])==2 and pago['partes'][0]['c']==0 and pago['partes'][1]['c']==-1, pago
assert g['total_archivos']==6 and g['repos'][0]['otras']==1 and 'reflog' in (g['repos'][1].get('commits_motivo') or ''), g['repos']
assert g['commits'][0]['h']=='abc123456789' and g['commits'][0]['t']==96, g['commits']
# copia compartida: el commit sin confirmar viene marcado y el de la otra sesión listado aparte, no en la lista
assert 'at' not in g['commits'][0] and g['commits'][1].get('at')=='coincide_la_hora', g['commits']
assert [k['s'] for k in g['repos'][0]['de_otras']]==['ajeno: lo commiteó la otra sesión'] and not any(k['h'].startswith('aaaa1111') for k in g['commits']), g['repos'][0]
s=json.dumps(m)
assert 'PARCHE_GIT_SEMBRADO' not in s and 'SIN_COMMITEAR_SEMBRADO' not in s and '_textoGit' not in s, 'el parche entró al modelo'
" "${J}" && ok "2.19-T14 el modelo trae los archivos de git (con el repo que no es el de la story adelante), las partes sin sumar, el minuto del commit, otra sesión y el reflog que falta; sin parches" || mal "2.19-T14 modelo: $(echo "${J}" | head -c 300)"
R="$(python3 - "${T}/o.html" <<'PYC'
import base64, gzip, json, re, sys
h = open(sys.argv[1], encoding='utf8').read()
b = re.findall(r'<script type="text/plain" id="cg-\d+">([^<]*)</script>', h)
txt = ''.join(gzip.decompress(base64.b64decode(x)).decode() for x in b)
print('|'.join([
  'uno' if len(b) == 1 else 'bloques=%d' % len(b),
  'parche' if 'PARCHE_GIT_SEMBRADO' in txt and 'SIN_COMMITEAR_SEMBRADO' in txt else 'sin-parche',
  'clave-tapada' if 'ClaveSecreta123' not in txt and 'ClaveSecreta123' not in h else 'CLAVE-VISIBLE',
  'comprimido' if 'PARCHE_GIT_SEMBRADO' not in h else 'EN-CLARO']))
PYC
)"
[ "${R}" = "uno|parche|clave-tapada|comprimido" ] && ok "2.19-T14 los parches van comprimidos aparte (cg-N), saneados otra vez" || mal "2.19-T14 página: ${R}"
D="$(cliente "${T}/o.html" all)"
grep -q 'según git' <<< "${D}" && grep -q 'en 2 partes' <<< "${D}" && grep -q 'AgentSkills/skills/x.js' <<< "${D}" \
  && grep -q 'otra sesión' <<< "${D}" && grep -q 'no tiene historial local de git' <<< "${D}" && grep -q 'class="cg-f" data-g="0"' <<< "${D}" \
  && grep -q 'data-g="0"' <<< "${D}" && grep -q 'UUID salen tapados' <<< "${D}" && grep -q '3 archivos que ya estaban sin commitear antes de la ejecución no se muestran' <<< "${D}" \
  && grep -q '1 commit de otra sesión no se cuenta: <span class="mono">aaaa111</span> ajeno: lo commiteó la otra sesión' <<< "${D}" \
  && grep -q '1 commit no se pudo confirmar como de esta sesión y se muestra marcado' <<< "${D}" \
  && ok "2.19-T14 el detalle: según git arriba, «en 2 partes», el otro repo, aviso de otra sesión y de reflog, el commit ajeno listado y el dudoso avisado, y el filtro por archivo" || mal "2.19-T14 detalle: $(echo "${D}" | grep -o 'según git.\{0,600\}' | head -1)"
AR="$(python3 -c "
import re,sys; h=open(sys.argv[1],encoding='utf8').read(); ar=re.findall(r'<td class=\"ar\">(.*?)</td>',h)
print(','.join(sorted(re.sub(r'<[^>]+>','',x) for x in ar)))" "${T}/o.html")"
[ "${AR}" = "5,6" ] && ok "2.19-T14 la columna «archivos» usa git donde hay (6) y el hilo donde no (5)" || mal "2.19-T14 columna archivos: ${AR}"

# ── T15 · ConsolaAproximada_YNombresQueGitNoConfirma ──
# 🔴 Falla con: el minuto de la consola se muestra igual que el de una edición, y «p.Id» sale como archivo.
#    Mutaciones: no marcar ≈ en la consola, marcarlo también en la edición, o no ocultar el nombre sin git → rojo.
python3 -c "
import json,sys
m=json.loads(sys.argv[1]); x=[c['cambios'] for c in m['corridas'] if (c.get('cambios') or {}).get('git',{}).get('estado')=='medido'][0]
fs=[x['archivos'][e['a']]['f'] for e in x['lista'] if not e.get('o')]
oc=[x['archivos'][e['a']]['f'] for e in x['lista'] if e.get('o')]
assert fs==['src/Pago.ts','scripts/tests/x.test.ts','src/Filtro.cs','AgentSkills/skills/x.js'], fs
assert oc==['p.Id'] and x['no_confirmados']==1, (oc, x.get('no_confirmados'))
assert [e.get('g') for e in x['lista'] if not e.get('o')]==[0,1,2,5], x['lista']
" "${J}" && ok "2.19-T15 la ruta corta de la consola se asocia a la de git, «p.Id» queda oculto y contado" || mal "2.19-T15 lista: $(echo "${J}" | python3 -c "import json,sys;m=json.load(sys.stdin);print([c['cambios'].get('lista') for c in m['corridas']][:1])" 2>&1 | head -c 400)"
IG="$(echo "${J}" | python3 -c "import json,sys;m=json.load(sys.stdin);print([i for i,c in enumerate(m['corridas']) if (c.get('cambios') or {}).get('git',{}).get('estado')=='medido'][0])")"
DG="$(cliente "${T}/o.html" detail "${IG}")"
grep -q '<span class="cz-t">26 min</span>' <<< "${DG}" && grep -q '<span class="cz-t">≈ 31 min</span>' <<< "${DG}" && grep -q 'por consola · aproximado' <<< "${DG}" \
  && ! grep -q '<span class="cz-t">≈ 26 min' <<< "${DG}" && ! grep -q '<span class="ruta">p.Id</span>' <<< "${DG}" && grep -q '1 nombre de la consola que git no confirma' <<< "${DG}" \
  && ok "2.19-T15 la edición dice «26 min», la consola «≈ 31 min · aproximado», y el nombre que git no confirma no se muestra (se cuenta)" || mal "2.19-T15 detalle: $(echo "${DG}" | grep -o 'Cada cambio.\{0,300\}' | head -1)"

# ── T28 · sin el saneado en esta máquina, el motivo del volcado NO se publica (+ SEC) ─────
# 🔴 Falla con: la única rama que publica texto de afuera sin sanear
#    cuando `tokens-digest.js` no está. Mutación: volver a publicar el motivo crudo → la ruta sembrada aparece.
T4=$(mktemp -d); mkdir -p "${T4}/copia/scripts"
cp -R "${RAIZ}/scripts/nightly" "${RAIZ}/scripts/metrics" "${RAIZ}/scripts/lib" "${T4}/copia/scripts/"
rm -f "${T4}/copia/scripts/metrics/tokens-digest.js"      # la máquina sin el saneado
volcado "${T4}/r" "${S1}" "2026-08-20T05:53:47Z" '{"cambio":{"estado":"no_medido","repos":0,"archivos":0,"motivo":"no encontré run-change.js en /Users/fulano/SourceCode/ClienteSecreto/scripts"}}' sinsaneo.json
node "${T4}/copia/scripts/nightly/dashboard/dashboard.js" --view runs --runs-dir "${T4}/r" --local-only --output "${T4}/o.html" > "${T4}/log" 2>&1
RC4=$?
D4="$(cliente "${T4}/o.html" all 2>/dev/null)"
if [ "${RC4}" -eq 0 ] && ! grep -q 'fulano\|ClienteSecreto' "${T4}/o.html" && grep -q 'sin el saneado' <<< "${D4}"; then
  ok "2.19-T28 sin tokens-digest.js el motivo del volcado no se publica: la vista dice «sin el saneado» y la ruta sembrada no aparece"
else
  mal "2.19-T28 rc=${RC4} · $(grep -o 'fulano[^<]*' "${T4}/o.html" | head -1) · $(echo "${D4}" | grep -o 'según git:.\{0,90\}' | head -1)"
fi
rm -rf "${T4}"

# ── T27 · un repo que no se pudo mirar NO es «no cambió nada» ─────────────────
# 🔴 Falla con: con git «medido» y 0 archivos por un repo no medido, la vista dice «esta corrida no dejó
#    cambios», la columna imprime 0 y TODO lo hecho por consola se oculta como «nombre que git no confirma».
#    Mutaciones: volver a publicar el 0, o volver a armar `ids` con la lista vacía → rojo.
T3=$(mktemp -d)
volcado "${T3}/r" "${S1}" "2026-08-19T05:53:47Z" '{}' nomedido.json
python3 - "${T3}/r" <<'PYN'
import gzip, json, os, sys
d = sys.argv[1]
def uso(ts, name, inp): return {"type": "assistant", "timestamp": ts, "message": {"content": [{"type": "tool_use", "name": name, "input": inp}]}}
with gzip.open(os.path.join(d, "nomedido.hilo.jsonl.gz"), "wt") as f:
    f.write(json.dumps(uso("2026-08-19T06:20:00.000Z", "Bash", {"command": "sed -i '' 's/a/b/' src/Pago.ts"})) + "\n")
cambio = {"version": 1, "estado": "medido", "motivo": None, "medido_en": "2026-08-19T08:00:00Z",
          "ventana": {"desde": "2026-08-19T05:52:47Z", "hasta": "2026-08-19T08:00:00Z"},
          "repos": [{"nombre": "FrontEnd", "principal": True, "por": ["story"], "otras_sesiones": 0,
                     "estado": "no_medido", "motivo": "la carpeta del repo de la corrida ya no existe en esta máquina"},
                    {"nombre": "OtroRepo", "principal": False, "por": ["consola"], "otras_sesiones": None,
                     "otras_sesiones_motivo": "el registro no trae sesión: no se puede saber si otra sesión escribió en esta copia",
                     "estado": "medido", "commits": [], "sin_commitear": [], "sin_commitear_previo": 0}],
          "totales": {"repos": 1, "archivos": 0, "partes": 0, "cortados": 0, "sin_parche_por_tope": 0}}
with open(os.path.join(d, "nomedido.cambio.json.gz"), "wb") as f: f.write(gzip.compress(json.dumps(cambio).encode()))
PYN
generar "${T3}/r" "${T3}/o.html" "${T3}/log"
D3="$(cliente "${T3}/o.html" all)"
AR3="$(python3 -c "
import re,sys; h=open(sys.argv[1],encoding='utf8').read(); print(','.join(re.sub(r'<[^>]+>','',x) for x in re.findall(r'<td class=\"ar\">(.*?)</td>',h)))" "${T3}/o.html")"
TIT3="$(python3 -c "
import re,sys; h=open(sys.argv[1],encoding='utf8').read(); m=re.search(r'<td class=\"ar\"><span class=\"nd\" title=\"([^\"]*)\"',h); print(m.group(1) if m else 'sin-title')" "${T3}/o.html")"
grep -q 'no se sabe si escribió otra sesión' <<< "${D3}" && grep -q 'no se pudo mirar 1 de los 2 repos' <<< "${D3}" && grep -q 'src/Pago.ts' <<< "${D3}" && [ "${AR3}" = "—" ] \
  && case "${TIT3}" in *undefined*) false ;; *FrontEnd*) true ;; *) false ;; esac \
  && ok "2.19-T27 con el repo sin medir: lo dice, la columna no publica un 0 y lo de consola sigue a la vista" \
  || mal "2.19-T27 columna=«${AR3}» título=«${TIT3}» · detalle: $(echo "${D3}" | grep -o 'no se pudo mirar.\{0,80\}\|no dejó cambios.\{0,40\}' | head -2)"
rm -rf "${T3}"

# ── T22 · el archivador intentó y no pudo: la vista lo DICE, no se hace la desentendida ──
# 🔴 Falla con: la vista que sólo mira si el archivo del cambio existe,
#    así que una corrida cuyo archivador falló se ve IGUAL que una sin archivado del cambio. Mutación: volver a
#    ignorar `cambio` del volcado → rojo.
T2=$(mktemp -d)
volcado "${T2}/r" "${S3}" "2026-08-18T05:53:47Z" '{"cambio":{"estado":"no_medido","repos":0,"archivos":0,"motivo":"no encontré run-change.js en <ruta> — el arnés de esta máquina puede estar atrasado"}}' fallo.json
generar "${T2}/r" "${T2}/o.html" "${T2}/log"
D2="$(cliente "${T2}/o.html" all)"
grep -q 'el arnés de esta máquina puede estar atrasado' <<< "${D2}" && grep -q 'según git' <<< "${D2}" \
  && ok "2.19-T22 con el cambio no medido, la vista muestra el motivo del archivador" || mal "2.19-T22 detalle: $(echo "${D2}" | grep -o 'según git.\{0,160\}' | head -1)"
rm -rf "${T2}"

# ── T16 · VistaSinCambio_ComoHoy ──
# 🔴 Falla con: sin cambio, la vista no dice que la conversación es aproximada. Mutación: ocultar nombres
#    sin git también donde no hay git → «p.Id» desaparece de la corrida sin cambio → rojo.
python3 -c "
import json,sys
m=json.loads(sys.argv[1]); x=[c['cambios'] for c in m['corridas'] if not (c.get('cambios') or {}).get('git') or c['cambios']['git'].get('estado')=='sin_cambio'][0]
assert not any(e.get('o') for e in x['lista']) and any(x['archivos'][e['a']]['f']=='p.Id' for e in x['lista']), x['lista']
" "${J}" && cliente "${T}/o.html" all | grep 'según la conversación: lo hecho por consola se reconoce por aproximación y lo de los subagentes no está' >/dev/null \
  && ok "2.19-T16 sin cambio de git: la lista de hoy, con la consola marcada aproximada y dicho en la tarjeta" || mal "2.19-T16 sin cambio: $(echo "${DG}" | grep -o 'según la conversación.\{0,120\}' | head -1)"
rm -rf "${T}"

# ═══════════════ los pasos de una corrida, al lado de su consumo ═══════════════
S4="44444444-4444-4444-8444-444444444444"
S5="55555555-5555-4555-8555-555555555555"
S6="66666666-6666-4666-8666-666666666666"
# ¿Dos fichas están PEGADAS en el contenedor? Imprime la distancia entre sus posiciones (1 = vecinas).
distancia_fichas() { python3 -c "
import sys
t = sys.stdin.read().split('<div class=\"tile')[1:]
i = [k for k, x in enumerate(t) if sys.argv[1] in x]; j = [k for k, x in enumerate(t) if sys.argv[2] in x]
print(abs(i[0] - j[0]) if i and j else 'AUSENTE')" "$1" "$2"; }

# ── 7.12-T1 · Corridas_MuestraLaMediana (AC 1) @story-7.12 @ac-1 ──
# 🔴 Falla con: no dibujar la ficha, o dibujarla lejos de la de tokens. Pasos DISTINTOS (100/300/500/700):
#    un fixture empatado esconde el criterio. Mutación: mover la ficha al principio de la grilla → rojo.
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "2026-08-10T05:00:00Z" '{"consumo":{"respuestas":100}}'
volcado "${T}/r" "${S2}" "2026-08-20T05:00:00Z" '{"consumo":{"respuestas":300}}'
volcado "${T}/r" "${S3}" "2026-09-05T05:00:00Z" '{"consumo":{"respuestas":500}}'
volcado "${T}/r" "${S4}" "2026-09-15T05:00:00Z" '{"consumo":{"respuestas":700}}'
generar "${T}/r" "${T}/o.html" "${T}/log"
F="$(cliente "${T}/o.html" container fichas)"
P="$(echo "${F}" | python3 -c "
import sys
for x in sys.stdin.read().split('<div class=\"tile')[1:]:
    if 'Respuestas del modelo por ejecución' in x: print(x)")"
grep -q 't-val">400<' <<< "${P}" && ok "7.12-T1 la vista trae la mediana de pasos (400 de 100/300/500/700)" || mal "7.12-T1 la mediana de pasos no está: ${P:0:200}"
grep -q 'n=4 de 4 ejecuciones' <<< "${P}" && ok "7.12-T1 con su denominador al lado (n=4 de 4)" || mal "7.12-T1 falta el denominador: ${P:0:300}"
[ "$(echo "${F}" | distancia_fichas 'Respuestas del modelo por ejecución' 'Tokens de una ejecución')" = "1" ] && ok "7.12-T1 la ficha de pasos está PEGADA a la de tokens" || mal "7.12-T1 la ficha de pasos no está al lado del consumo"
# …y la recalcula el filtro: con «sólo con consumo medido» sigue ahí, con un rango imposible desaparece.
cliente "${T}/o.html" impossible-filter | grep 'Respuestas del modelo por ejecución' >/dev/null && mal "7.12-T1 con el filtro imposible la ficha siguió mostrando un número" || ok "7.12-T1 el filtro la recalcula (rango imposible → sin número)"

# ── 7.12-T4 · la serie por mes, en el cliente (AC 4) @story-7.12 @ac-4 ──
# 🔴 Falla con: publicar sólo la mediana global → no hay contra qué comparar la línea base.
G="$(cliente "${T}/o.html" container gpasos)"
grep -q '2026-08: mediana 200 · n=2' <<< "${G}" && grep -q '2026-09: mediana 600 · n=2' <<< "${G}" && ok "7.12-T4 un punto por mes, con su mediana y su n" || mal "7.12-T4 la serie por mes no está: $(echo "${G}" | grep -o '<title>[^<]*' | head -4 | tr '\n' ' ')"
grep -q 'línea base' <<< "${G}" && ok "7.12-T4 la serie dibuja la línea base contra la que se compara" || mal "7.12-T4 falta la línea base en la serie"
rm -rf "${T}"

# ── 7.12-T2 · NoMedidasSeCuentanAparte (AC 2) @story-7.12 @ac-2 ──
# 🔴 Falla con: tratar `respuestas` ausente como 0 → la mediana se desploma; o sacar a las no medidas del
#    denominador en silencio. Dos formas de «no medido»: la conversación borrada, y un consumo medido que no
#    trae cuántas respuestas dio (volcado de una versión vieja del rescate).
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "2026-08-10T05:00:00Z" '{"consumo":{"respuestas":100}}'
volcado "${T}/r" "${S2}" "2026-08-20T05:00:00Z" '{"consumo":{"respuestas":300}}'
volcado "${T}/r" "${S3}" "2026-09-05T05:00:00Z" '{"consumo":{"respuestas":500}}'
volcado "${T}/r" "${S4}" "2026-09-15T05:00:00Z" '{"consumo":{"respuestas":700}}'
volcado "${T}/r" "${S5}" "2026-09-16T05:00:00Z" '{"consumo":{"estado":"borrada","motivo":"la conversación ya no está","tokens":null,"por_modelo":null,"por_paso":null,"fuera_de_ventana":null,"respuestas":null}}'
volcado "${T}/r" "${S6}" "2026-09-17T05:00:00Z" '{"consumo":{"respuestas":null}}'
generar "${T}/r" "${T}/o.html" "${T}/log"
P="$(cliente "${T}/o.html" container fichas | python3 -c "
import sys
for x in sys.stdin.read().split('<div class=\"tile')[1:]:
    if 'Respuestas del modelo por ejecución' in x: print(x)")"
grep -q 't-val">400<' <<< "${P}" && ok "7.12-T2 las no medidas NO entran en la mediana (sigue en 400)" || mal "7.12-T2 la mediana se movió con las no medidas: ${P:0:200}"
grep -q 'n=4 de 6 ejecuciones' <<< "${P}" && ok "7.12-T2 siguen en el denominador (n=4 de 6)" || mal "7.12-T2 las no medidas desaparecieron del denominador: ${P:0:300}"
grep -q '<b>2</b> no tienen sus pasos medidos' <<< "${P}" && ok "7.12-T2 y se dicen, aparte" || mal "7.12-T2 no dice cuántas quedaron sin medir"
rm -rf "${T}"

# ── 7.12-T5 · BuzonVacioNoEsCero, en la vista (AC 5) @story-7.12 @ac-5 ──
# 🔴 Falla con: `mediana([])` o `|| 0` → «0 pasos» con una sola corrida borrada en el filtro.
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "2026-09-16T05:00:00Z" '{"consumo":{"estado":"borrada","motivo":"la conversación ya no está","tokens":null,"por_modelo":null,"por_paso":null,"fuera_de_ventana":null,"respuestas":null}}'
generar "${T}/r" "${T}/o.html" "${T}/log"
P="$(cliente "${T}/o.html" container fichas | python3 -c "
import sys
for x in sys.stdin.read().split('<div class=\"tile')[1:]:
    if 'Respuestas del modelo por ejecución' in x: print(x)")"
grep -q 'blind' <<< "${P}" && grep -q 'ninguna ejecución del filtro' <<< "${P}" && ok "7.12-T5 sin ninguna medida: trama y motivo" || mal "7.12-T5 sin medidas no salió «no medido»: ${P:0:200}"
grep -q 't-val">0' <<< "${P}" && mal "7.12-T5 publicó un cero" || ok "7.12-T5 ningún cero publicado"
G="$(cliente "${T}/o.html" container gpasos)"
grep -q 'mediana 0' <<< "${G}" && mal "7.12-T5 la serie dibujó un cero" || ok "7.12-T5 la serie tampoco inventa un cero"
rm -rf "${T}"

# ── T4b · un mes SIN corridas medidas en el medio no es un cero: es un hueco dicho ──
# 🔴 Falla con: rellenar el mes vacío con 0, como hace (bien) el gráfico de corridas por semana — ahí
#    cero corridas es un dato; acá «mediana 0» sería un número que nadie midió.
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "2026-06-10T05:00:00Z" '{"consumo":{"respuestas":100}}'
volcado "${T}/r" "${S2}" "2026-08-20T05:00:00Z" '{"consumo":{"respuestas":300}}'
generar "${T}/r" "${T}/o.html" "${T}/log"
G="$(cliente "${T}/o.html" container gpasos)"
grep -q '2026-07: sin ejecuciones medidas' <<< "${G}" && ok "7.12-T4b el mes vacío del medio se dice, sin número" || mal "7.12-T4b el mes vacío del medio no aparece como hueco"
grep -q '2026-07: mediana' <<< "${G}" && mal "7.12-T4b el mes vacío publicó una mediana" || ok "7.12-T4b ninguna mediana inventada para el mes vacío"
rm -rf "${T}"

# ── T4c · una corrida medida SIN fecha de arranque no entra en la serie, y se dice cuántas ──
# 🔴 Falla con: `if (c.inicio)` a secas → la ficha dice n=3 y los puntos del gráfico suman 2, sin explicación.
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "2026-08-10T05:00:00Z" '{"consumo":{"respuestas":100}}'
volcado "${T}/r" "${S2}" "2026-08-20T05:00:00Z" '{"consumo":{"respuestas":300}}'
volcado "${T}/r" "${S3}" "2026-09-05T05:00:00Z" '{"consumo":{"respuestas":500},"marker":{"startedAt":null}}'
generar "${T}/r" "${T}/o.html" "${T}/log"
cliente "${T}/o.html" container fichas | grep 'n=3 de 3 ejecuciones' >/dev/null && ok "7.12-T4c la ficha cuenta las 3 medidas" || mal "7.12-T4c la ficha no cuenta las 3 medidas"
G="$(cliente "${T}/o.html" container gpasos)"
grep -q '1 ejecución medida no trae su fecha de arranque' <<< "${G}" && ok "7.12-T4c la serie dice la que quedó afuera por no tener fecha" || mal "7.12-T4c la serie descarta una ejecución medida sin decirlo"

# ── T4d · la etiqueta de la línea base no se pisa con el número de ningún mes ──
# 🔴 Falla con: la etiqueta dentro del área de los valores — con la serie pegada a la línea base (lo esperable) queda
#    encima del número de un punto. Va en la leyenda, debajo del gráfico (story 2.79, AC 47).
echo "${G}" | python3 -c "
import re, sys
g = sys.stdin.read()
s = re.search(r'<svg[\s\S]*?</svg>', g)
assert s and re.search(r'<line [^>]*stroke-dasharray', s.group(0)), 'no encontré la línea punteada'
assert 'línea base' not in re.sub(r'<title>.*?</title>', '', s.group(0)), 'la etiqueta está dentro del gráfico'
assert re.search(r'<p class=\"tlnota leyenda\">.*?línea base', g.replace(s.group(0), ''), re.S), 'la etiqueta va en la leyenda, debajo'
" && ok "7.12-T4d la etiqueta de la línea base va en la leyenda, fuera del área de los valores" || mal "7.12-T4d la etiqueta de la línea base puede pisarse con los números"
rm -rf "${T}"

# ── T4e · sin línea base, la página lo DICE con su motivo (ficha y serie) ──
# 🔴 Falla con: un cliente que omite la frase y la línea punteada → «no la pude cargar» se ve igual que «no hay».
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "2026-08-10T05:00:00Z" '{"consumo":{"respuestas":100}}'
node -e "
const c = require('${RAIZ}/scripts/nightly/dashboard/runs.js');
const M = c.modelo('${T}/r');
M.linea_base_pasos = { estado: 'sin_linea_base', motivo: 'MOTIVO_SIN_LINEA_BASE' };
require('fs').writeFileSync('${T}/o.html', c.render(M));"
F="$(cliente "${T}/o.html" container fichas)"; G="$(cliente "${T}/o.html" container gpasos)"
grep -q 'sin línea base contra la que comparar' <<< "${F}" && grep -q 'MOTIVO_SIN_LINEA_BASE' <<< "${F}" && ok "7.12-T4e la ficha dice que no hay línea base, y por qué" || mal "7.12-T4e la ficha calla que falta la línea base"
grep -q 'MOTIVO_SIN_LINEA_BASE' <<< "${G}" && ok "7.12-T4e la serie también lo dice" || mal "7.12-T4e la serie calla que falta la línea base"
grep -q 'stroke-dasharray' <<< "${G}" && mal "7.12-T4e dibujó una línea base que no tiene" || ok "7.12-T4e y no dibuja ninguna línea inventada"
rm -rf "${T}"

# ── T38 · Vista_CarpetaVieja_UnaVezYAntes ──────────────────────────────
# Cada máquina sube a `<nombre>-<código>`; el bajador deja `.carpetas-de-maquina.json` (acá, fabricado a mano).
# S1 está en las dos carpetas de la misma máquina (la vieja con la copia archivada MÁS TARDE, para que «gana la más nueva»
# y «gana la nueva» difieran); S2 sólo en la vieja; S3 en una vieja compartida; S4 en una que siguió recibiendo.
# 🔴 Falla con: la sesión atribuida a la vieja por orden de nombre («macbook-pro» < «macbook-pro-1a2b3c4d»), su copia
#    vieja ganando por fecha, y la compartida sin marca.
T=$(mktemp -d); mkdir -p "${T}/local"
volcado "${T}/buzon/macbook-pro" "${S1}" "2026-09-01T10:00:00Z" '{"archivedAt":"2026-09-03T12:00:00.000Z","marker":{"storyId":"COPIA-VIEJA"}}' s1.json
volcado "${T}/buzon/macbook-pro-1a2b3c4d" "${S1}" "2026-09-01T10:00:00Z" '{"archivedAt":"2026-09-02T12:00:00.000Z","marker":{"storyId":"COPIA-NUEVA"}}' s1.json
volcado "${T}/buzon/macbook-pro" "${S2}" "2026-08-20T10:00:00Z" '{"marker":{"storyId":"SOLO-VIEJA"}}'
volcado "${T}/buzon/mac-mini" "${S3}" "2026-08-21T10:00:00Z" '{"marker":{"storyId":"COMPARTIDA"}}'
volcado "${T}/buzon/imac" "${S4}" "2026-08-22T10:00:00Z" '{"marker":{"storyId":"SIGUIO"}}'
cat > "${T}/buzon/.carpetas-de-maquina.json" <<'JSON'
{ "schema": 1,
  "carpetas": {
    "macbook-pro": { "estado": "unida", "nueva": "macbook-pro-1a2b3c4d", "declarantes": 1, "desde": "2026-09-01" },
    "mac-mini": { "estado": "compartida", "nueva": null, "declarantes": 2, "desde": "2026-09-01" },
    "imac": { "estado": "siguio_recibiendo", "nueva": null, "declarantes": 1, "desde": "2026-09-01" } },
  "regeneradas": {} }
JSON
vista_t38() { TYCON_MACHINE=maq-z node "${TABLERO}" --view runs --runs-dir "${T}/local" --mailbox "${T}/buzon" "$@"; }
J38="$(vista_t38 --json --dry-run 2>/dev/null | python3 -c "
import json,sys
raw=sys.stdin.read(); i=raw.find('{'); print(json.dumps(json.loads(raw[i:])))")"
python3 -c "
import json,sys; m=json.loads(sys.argv[1]); cs=m['corridas']
uno=[c for c in cs if c['story'] in ('COPIA-VIEJA','COPIA-NUEVA')]
assert len(uno)==1, [c['story'] for c in uno]
c=uno[0]
assert c['story']=='COPIA-NUEVA', ('ganó la copia', c['story'])
assert c['maquina']=='macbook-pro-1a2b3c4d', ('máquina', c['maquina'])
assert c.get('maquina_nota')=='antes, macbook-pro', ('nota', c.get('maquina_nota'))
" "${J38}" && ok "2.28-T38 la sesión en las dos carpetas sale una vez, de la carpeta nueva, con «antes, macbook-pro»" \
  || mal "2.28-T38 la sesión de las dos carpetas: $(python3 -c "import json,sys; print([(c['story'],c.get('maquina'),c.get('maquina_nota')) for c in json.loads(sys.argv[1])['corridas']])" "${J38}" 2>&1 | head -c 400)"
python3 -c "
import json,sys; m=json.loads(sys.argv[1]); c={x['story']: x for x in m['corridas']}
assert (c['SOLO-VIEJA']['maquina'], c['SOLO-VIEJA'].get('maquina_nota'))==('macbook-pro-1a2b3c4d','antes, macbook-pro'), c['SOLO-VIEJA'].get('maquina')
assert (c['COMPARTIDA']['maquina'], c['COMPARTIDA'].get('maquina_nota'))==('mac-mini','compartida por 2 máquinas: no se une'), c['COMPARTIDA'].get('maquina_nota')
assert (c['SIGUIO']['maquina'], c['SIGUIO'].get('maquina_nota'))==('imac','siguió recibiendo después de la mudanza'), c['SIGUIO'].get('maquina_nota')
assert sorted((x['nombre'], x['corridas']) for x in m['maquinas']['lista'])==[('imac',1),('mac-mini',1),('macbook-pro-1a2b3c4d',2)], m['maquinas']['lista']
assert m['buzon']['uniones']['estado']=='medidas', m['buzon'].get('uniones')
" "${J38}" && ok "2.28-T38 la corrida de la vieja es de la nueva; la compartida y la que siguió recibiendo, marcadas y sin unir" \
  || mal "2.28-T38 atribución: $(python3 -c "import json,sys; m=json.loads(sys.argv[1]); print([(c['story'],c.get('maquina'),c.get('maquina_nota')) for c in m['corridas']], m['maquinas']['lista'], m['buzon'].get('uniones'))" "${J38}" 2>&1 | head -c 500)"
vista_t38 --output "${T}/o.html" > "${T}/log" 2>&1; RC=$?
[ "${RC}" -eq 0 ] && grep -q 'antes, macbook-pro' "${T}/o.html" && grep -q 'compartida por 2 máquinas: no se une' "${T}/o.html" \
  && ! grep -q 'uniones de carpetas no medidas' "${T}/o.html" \
  && ok "2.28-T38 la página muestra «antes, macbook-pro» y la marca de la compartida" || mal "2.28-T38 la página (rc=${RC}) no muestra las marcas: $(grep -o 'class="maq">[^<]*<[^<]*' "${T}/o.html" | head -4)"
DET="$(cliente "${T}/o.html" all)"
grep -q 'antes, macbook-pro' <<< "${DET}" && ok "2.28-T38 el detalle de la ejecución también lo dice" || mal "2.28-T38 el detalle no dice «antes, macbook-pro»"
# Sin el archivo del bajador: cada carpeta por separado, sin unir, y la página lo dice.
# 🔴 Falla con: unir sin el archivo (inventar la regla en la vista), o no decir nada.
rm -f "${T}/buzon/.carpetas-de-maquina.json"
J38="$(vista_t38 --json --dry-run 2>/dev/null | python3 -c "
import json,sys
raw=sys.stdin.read(); i=raw.find('{'); print(json.dumps(json.loads(raw[i:])))")"
python3 -c "
import json,sys; m=json.loads(sys.argv[1]); c={x['story']: x for x in m['corridas']}
assert c['SOLO-VIEJA']['maquina']=='macbook-pro' and not c['SOLO-VIEJA'].get('maquina_nota'), c['SOLO-VIEJA']
assert not c['COMPARTIDA'].get('maquina_nota'), c['COMPARTIDA']
assert m['buzon']['uniones']['estado']=='no_medidas', m['buzon'].get('uniones')
" "${J38}" && ok "2.28-T38 sin .carpetas-de-maquina.json cada carpeta es su máquina, como hoy" || mal "2.28-T38 sin archivo: $(python3 -c "import json,sys; m=json.loads(sys.argv[1]); print([(c['story'],c.get('maquina'),c.get('maquina_nota')) for c in m['corridas']], m['buzon'])" "${J38}" 2>&1 | head -c 400)"
vista_t38 --output "${T}/o.html" > "${T}/log" 2>&1; RC=$?
[ "${RC}" -eq 0 ] && grep -q 'uniones de carpetas no medidas' "${T}/o.html" && grep -q 'uniones de carpetas no medidas' "${T}/log" \
  && ok "2.28-T38 y lo dice: «uniones de carpetas no medidas» en la página y en el resumen" || mal "2.28-T38 sin archivo (rc=${RC}) no lo dice: $(tail -3 "${T}/log")"
rm -rf "${T}"
# Una sesión que está en una vieja COMPARTIDA (o que siguió recibiendo) y en la carpeta nueva que la re-subió es de la
# nueva, aunque las dos copias tengan la misma fecha de archivo.
# 🔴 Falla con: la preferencia por la nueva vale sólo con una vieja `unida`; con el empate de
#    fechas gana la vieja por orden de nombre, y las carpetas nuevas quedan sin su historia.
T=$(mktemp -d); mkdir -p "${T}/local"
volcado "${T}/buzon/mac-mini" "sid-c1" "2026-08-21T10:00:00Z" '{"archivedAt":"2026-08-21T12:00:00.000Z","marker":{"storyId":"C1-VIEJA"}}' c1.json
volcado "${T}/buzon/mac-mini-aaaaaaaa" "sid-c1" "2026-08-21T10:00:00Z" '{"archivedAt":"2026-08-21T12:00:00.000Z","marker":{"storyId":"C1-NUEVA"}}' c1.json
volcado "${T}/buzon/imac" "sid-c2" "2026-08-22T10:00:00Z" '{"archivedAt":"2026-08-22T12:00:00.000Z","marker":{"storyId":"C2-VIEJA"}}' c2.json
volcado "${T}/buzon/imac-bbbbbbbb" "sid-c2" "2026-08-22T10:00:00Z" '{"archivedAt":"2026-08-22T12:00:00.000Z","marker":{"storyId":"C2-NUEVA"}}' c2.json
cat > "${T}/buzon/.carpetas-de-maquina.json" <<'JSON'
{ "schema": 1,
  "carpetas": {
    "mac-mini": { "estado": "compartida", "nueva": null, "declarantes": 2, "desde": "2026-09-01" },
    "imac": { "estado": "siguio_recibiendo", "nueva": null, "declarantes": 1, "desde": "2026-09-01" } },
  "regeneradas": {} }
JSON
J38="$(vista_t38 --json --dry-run 2>/dev/null | python3 -c "
import json,sys
raw=sys.stdin.read(); i=raw.find('{'); print(json.dumps(json.loads(raw[i:])))")"
python3 -c "
import json,sys; m=json.loads(sys.argv[1]); cs=m['corridas']
assert sorted((c['story'], c['maquina'], c.get('maquina_nota')) for c in cs)==[('C1-NUEVA','mac-mini-aaaaaaaa',None),('C2-NUEVA','imac-bbbbbbbb',None)], [(c['story'],c['maquina'],c.get('maquina_nota')) for c in cs]
" "${J38}" && ok "2.28-T38 con una vieja compartida o que siguió recibiendo, la sesión re-subida es de su carpeta nueva" \
  || mal "2.28-T38 vieja compartida: $(python3 -c "import json,sys; print([(c['story'],c.get('maquina'),c.get('maquina_nota')) for c in json.loads(sys.argv[1])['corridas']])" "${J38}" 2>&1 | head -c 400)"
rm -rf "${T}"

# ── T23 · VistaLocal_FuenteEmbebida_SinCambios ──────────────────────────
# El cliente de la vista lee sus datos de una FUENTE: embebida en la página local, por la red en el sitio. La página
# local sigue trayendo el modelo y los textos adentro y no pide nada por la red: abrir el detalle y su cambio no llama a
# `fetch`. 🔴 Falla con: un cliente que sólo sabe pedir por la red (la página local quedaría vacía sin el sitio).
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "2026-08-15T05:53:47Z" '{}' uno.json
generar "${T}/r" "${T}/o.html" "${T}/log"
R="$(node -e '
const fs=require("fs");const html=fs.readFileSync(process.argv[1],"utf8");
const modelo=(html.match(/<script id="modelo" type="application\/json">([\s\S]*?)<\/script>/)||[])[1];
const cliente=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()[1];
const nodos={};const el=()=>({innerHTML:"",textContent:"",value:"",checked:false,hidden:false,rows:[],addEventListener(){},set onclick(f){},querySelectorAll:()=>[],querySelector:()=>el(),classList:{add(){},remove(){},contains:()=>false}});
let pedidos=0;global.fetch=()=>{pedidos+=1;return Promise.reject(new Error("sin red"));};
global.window=global;global.location={search:"",hash:""};
global.document={addEventListener(){},querySelectorAll:()=>[],createElement:()=>el(),getElementById:(id)=>id==="modelo"?{textContent:modelo}:(nodos[id]=nodos[id]||el())};
eval(cliente);
const M=JSON.parse(modelo);const d=window.__detalle(M.corridas[0]);
console.log([/class="tile/.test(nodos.fichas.innerHTML)?"fichas":"sin-fichas",d.length>100?"detalle":"sin-detalle",typeof window.__fuente==="object"&&window.__fuente.forma,"pedidos="+pedidos,/id="cz-0"|id="cg-0"|<script id="modelo"/.test(html)?"embebida":"sin-embebida"].join(" "));
' "${T}/o.html" 2>&1)"
[ "${R}" = "fichas detalle embebida pedidos=0 embebida" ] && ok "2.27-T23 la página local trae su fuente embebida y no pide nada por la red" || mal "2.27-T23 fuente embebida: ${R}"
rm -rf "${T}"

# ═══════════════════════ filtros por fecha y máquina en la dirección; «no anotó sus pasos» ═══════════════════════
# Dos corridas de dos productos (15/08 y 20/08). El cliente real corre con CL_NOW (el «ahora»), CL_SEARCH (la dirección) y TZ.
S7="77777777-7777-4777-8777-777777777777"; S8="88888888-8888-4888-8888-888888888888"
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "2026-08-15T10:00:00Z" '{"marker":{"storyId":"F1"}}'
volcado "${T}/r" "${S2}" "2026-08-20T10:00:00Z" '{"marker":{"storyId":"F2","repoPath":"/Users/dev/SourceCode/Otro/FrontEnd"}}'
generar "${T}/r" "${T}/o.html" "${T}/log"
PROD_A="$(modelo_json "${T}/r" | python3 -c "import json,sys; print([c['producto'] for c in json.load(sys.stdin)['corridas'] if c['story']=='F1'][0])")"
PROD_B="$(modelo_json "${T}/r" | python3 -c "import json,sys; print([c['producto'] for c in json.load(sys.stdin)['corridas'] if c['story']=='F2'][0])")"
campo() { python3 -c "import json,sys; v=json.loads(sys.argv[1])[sys.argv[2]]; print('' if v is None else v)" "$1" "$2"; }
estado() { CL_NOW="$1" CL_SEARCH="$2" TZ="${3:-UTC}" cliente "${T}/o.html" "${@:4}"; }

# ── T1 · AtajosLlenanDesdeHasta: hoy / esta semana (lunes a hoy) / este mes (día 1 a hoy) ──
# 🔴 Falla con: sin botones ni __atajo, o la semana contada desde el domingo (el domingo 18/10 quedaría en su propio día).
for caso in "hoy|2026-10-14T15:00:00Z|2026-10-14|2026-10-14" "semana|2026-10-14T15:00:00Z|2026-10-12|2026-10-14" "mes|2026-10-14T15:00:00Z|2026-10-01|2026-10-14" "semana|2026-10-18T15:00:00Z|2026-10-12|2026-10-18" "semana|2026-10-12T15:00:00Z|2026-10-12|2026-10-12"; do
  IFS='|' read -r nom ahora d h <<< "${caso}"
  E="$(estado "${ahora}" "" UTC preset "${nom}")"
  [ "$(campo "${E}" desde)|$(campo "${E}" hasta)" = "${d}|${h}" ] && ok "2.45-T1 «${nom}» el ${ahora%%T*} → ${d} a ${h}" || mal "2.45-T1 «${nom}» el ${ahora%%T*}: ${E}"
done
for id in f-hoy f-semana f-mes; do grep -q "id=\"${id}\"" "${T}/o.html" && ok "2.45-T1 el botón #${id} está en la página" || mal "2.45-T1 falta el botón #${id}"; done
grep -q '>hoy<' "${T}/o.html" && grep -q '>esta semana<' "${T}/o.html" && grep -q '>este mes<' "${T}/o.html" && ok "2.45-T1 los botones dicen hoy / esta semana / este mes" || mal "2.45-T1 los botones no dicen sus nombres"

# ── T2 · FiltroEscribeLaDireccion: sólo lo que difiere del default; limpiar la vacía ──
# 🔴 sale rojo si no escribe nada, o si escribe también los campos en su valor por defecto (desde=hasta= siempre).
E="$(estado "2026-10-14T15:00:00Z" "?abrir=0&ver=2" UTC set "f-desde=2026-08-18")"
U="$(campo "${E}" url)"
case "${U}" in *desde=2026-08-18*) ok "2.45-T2 cambiar «desde» lo escribe en la dirección (${U})";; *) mal "2.45-T2 «desde» no llegó a la dirección: ${E}";; esac
case "${U}" in *hasta=*|*producto=*|*maquina=*) mal "2.45-T2 la dirección lleva campos que están en su valor por defecto: ${U}";; *) ok "2.45-T2 los campos en su default no se escriben";; esac
case "${U}" in *abrir=0*ver=2*|*ver=2*abrir=0*) ok "2.45-T2 conserva abrir y ver";; *) mal "2.45-T2 perdió abrir/ver: ${U}";; esac
E="$(estado "2026-10-14T15:00:00Z" "" UTC set "f-repo=${PROD_B}")"
case "$(campo "${E}" url)" in *producto=*) ok "2.45-T2 cambiar el producto lo escribe";; *) mal "2.45-T2 el producto no llegó a la dirección: ${E}";; esac
E="$(estado "2026-10-14T15:00:00Z" "?solo=0&desde=2026-08-18&producto=${PROD_B}" UTC clear)"
U="$(campo "${E}" url)"
case "${U}" in *desde=*|*producto=*|*hasta=*|*maquina=*) mal "2.45-T2 limpiar dejó parámetros del filtro: ${U}";; *) ok "2.45-T2 limpiar vacía los parámetros del filtro";; esac
case "${U}" in *solo=0*) ok "2.45-T2 limpiar conserva solo";; *) mal "2.45-T2 limpiar perdió solo: ${U}";; esac
E="$(estado "2026-10-14T15:00:00Z" "" UTC set "f-hasta=2026-08-19")"
case "$(campo "${E}" url)" in *hasta=2026-08-19*) ok "2.45-T2 cambiar «hasta» lo escribe";; *) mal "2.45-T2 «hasta» no llegó a la dirección: ${E}";; esac
# 🔴 sale rojo si «hoy», el día de la última corrida, no escribe «hasta» por coincidir con el rango: el enlace compartido,
# abierto al día siguiente, trae también las corridas nuevas.
E="$(estado "2026-08-20T15:00:00Z" "" UTC preset hoy)"
case "$(campo "${E}" url)" in *desde=2026-08-20*hasta=2026-08-20*) ok "2.45-T2 un atajo escribe desde y hasta aunque coincidan con el rango";; *) mal "2.45-T2 el atajo no fijó el rango en la dirección: ${E}";; esac
E="$(estado "2026-10-14T15:00:00Z" "" UTC change "f-hasta=2026-08-20")"
case "$(campo "${E}" url)" in *hasta=2026-08-20*) ok "2.45-T2 «hasta» puesto a mano en el último día con ejecuciones se escribe igual";; *) mal "2.45-T2 «hasta» a mano en el borde del rango no llegó: ${E}";; esac
E="$(estado "2026-10-14T15:00:00Z" "?hasta=2026-08-20" UTC set "f-repo=${PROD_B}")"
case "$(campo "${E}" url)" in *hasta=2026-08-20*) ok "2.45-T2 un «hasta» que vino en la dirección se conserva al cambiar otro filtro";; *) mal "2.45-T2 se perdió el «hasta» de la dirección: ${E}";; esac

# ── T3 · DireccionFiltraAlCargar: filtra; un valor inválido se ignora y la página carga ──
# 🔴 sale rojo si no lee la dirección (la página sale sin filtrar) o si falla con una fecha mal escrita.
E="$(estado "2026-10-14T15:00:00Z" "?desde=2026-08-18&hasta=2026-08-30&producto=${PROD_B}" UTC state)"
[ "$(campo "${E}" desde)|$(campo "${E}" hasta)|$(campo "${E}" repo)" = "2026-08-18|2026-08-30|${PROD_B}" ] && ok "2.45-T3 la dirección pone desde, hasta y producto" || mal "2.45-T3 no leyó la dirección: ${E}"
case "$(campo "${E}" vistas)" in "n=1 de 1") ok "2.45-T3 la vista carga filtrada (una ejecución)";; *) mal "2.45-T3 la vista no quedó filtrada: ${E}";; esac
[ -z "$(campo "${E}" url)" ] && ok "2.45-T3 cargar no reescribe la dirección" || mal "2.45-T3 cargar escribió la dirección: ${E}"
E="$(estado "2026-10-14T15:00:00Z" "?desde=2026-13-45&hasta=abc&producto=NoExiste&maquina=zzz" UTC state)"; RC=$?
[ "${RC}" -eq 0 ] && [ "$(campo "${E}" desde)|$(campo "${E}" hasta)|$(campo "${E}" repo)" = "2026-08-15|2026-08-20|" ] && ok "2.45-T3 valores inválidos → el filtro queda en todos y la página carga" || mal "2.45-T3 con valores inválidos: rc=${RC} ${E}"
E="$(estado "2026-10-14T15:00:00Z" "?desde=2026-02-30" UTC state)"
[ "$(campo "${E}" desde)" = "2026-08-15" ] && ok "2.45-T3 una fecha imposible (30 de febrero) se ignora" || mal "2.45-T3 aceptó el 30 de febrero: ${E}"
rm -rf "${T}"

# ── T5 · FechaLocalDelNavegador: una corrida de las 23:30 locales entra en su día local ──
# 🔴 sale rojo si compara el ISO en UTC: 23:30 en Buenos Aires (02:30Z del día siguiente) cae en «mañana».
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "2026-08-16T02:30:00Z" '{"marker":{"storyId":"L1"}}'
generar "${T}/r" "${T}/o.html" "${T}/log"
E="$(CL_NOW="2026-08-16T01:00:00Z" CL_SEARCH="?desde=2026-08-15&hasta=2026-08-15" TZ=America/Argentina/Buenos_Aires cliente "${T}/o.html" state)"
[ "$(campo "${E}" vistas)" = "n=1 de 1" ] && ok "2.45-T5 la ejecución de las 23:30 locales entra en su día local (15/08)" || mal "2.45-T5 la ejecución de las 23:30 locales quedó fuera de su día: ${E}"
E="$(CL_NOW="2026-08-16T01:00:00Z" TZ=America/Argentina/Buenos_Aires cliente "${T}/o.html" preset hoy)"
[ "$(campo "${E}" desde)" = "2026-08-15" ] && [ "$(campo "${E}" vistas)" = "n=1 de 1" ] && ok "2.45-T5 «hoy» a las 22 h locales es el día local y trae la ejecución" || mal "2.45-T5 «hoy» usó la fecha UTC: ${E}"
rm -rf "${T}"

# ── T6 · SinPasosAnotadosLoDice: sólo el paso 0 pero trabajó → «no anotó sus pasos» ──
# 🔴 sale rojo si falta el campo: la fila dice «quedó en el 0» y parece una corrida abandonada.
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "" '{"marker":{"stepsCompleted":[0]}}'
J="$(modelo_json "${T}/r")"
python3 -c "
import json,sys; c=json.loads(sys.argv[1])['corridas'][0]; assert c['sin_pasos_anotados'] is True and not c['llego_al_final'], c.get('sin_pasos_anotados')" "${J}" && ok "2.45-T6 el modelo marca sin_pasos_anotados y no cuenta como llegada al 8" || mal "2.45-T6 el modelo no marca sin_pasos_anotados"
generar "${T}/r" "${T}/o.html" "${T}/log"
CELDA="$(grep -o '<td class="pasos-n">.*</td>' "${T}/o.html")"
grep -q 'no anotó sus pasos' <<< "${CELDA}" && ok "2.45-T6 la fila dice «no anotó sus pasos»" || mal "2.45-T6 la fila no lo dice: ${CELDA}"
grep -q 'quedó en el 0' <<< "${CELDA}" && mal "2.45-T6 la fila sigue diciendo «quedó en el 0»" || ok "2.45-T6 ya no dice «quedó en el 0»"
grep -q 'title="[^"]*no es una ejecución abandonada' <<< "${CELDA}" && ok "2.45-T6 la explicación al pasar el mouse está" || mal "2.45-T6 falta la explicación (title)"
D="$(cliente "${T}/o.html" detail 0)"
grep -q 'no anotó sus pasos' <<< "${D}" && ! grep -q 'quedó en el paso 0' <<< "${D}" && ok "2.45-T6 el chip del detalle dice «no anotó sus pasos»" || mal "2.45-T6 el detalle: $(echo "${D}" | grep -o 'quedó en el paso [0-9?]*\|no anotó sus pasos' | head -1)"
grep -q '"sin_pasos_anotados":true' "${T}/o.html" && ok "2.45-T6 el campo está en el modelo que va al cliente" || mal "2.45-T6 falta en el modelo embebido"
rm -rf "${T}"

# T6 · sólo consumo: sin archivos, pero con consumo fuera del paso 0 → también trabajó
# 🔴 sale rojo si cuenta sólo archivos: una corrida que leyó y razonó sin escribir diría «quedó en el 0».
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "" '{"marker":{"stepsCompleted":[0],"filesTouched":[],"fileEvents":[]},"consumo":{"por_paso":{"0":1000,"1":null,"4":null,"5":null,"8":null},"fuera_de_ventana":5000}}'
python3 -c "
import json,sys; c=json.loads(sys.argv[1])['corridas'][0]; assert c['sin_pasos_anotados'] is True, c.get('sin_pasos_anotados')" "$(modelo_json "${T}/r")" && ok "2.45-T6 sólo con consumo fuera del paso 0 también se marca" || mal "2.45-T6 el consumo solo no la marcó"
rm -rf "${T}"

# ── T7 · PasoCeroSinTrabajoSigueIgual: el paso 0 sin archivos ni consumo, o sin ningún paso, sigue «quedó en el 0» / «—» ──
# 🔴 sale rojo si marca toda corrida con [0]: una abandonada de verdad diría «no anotó» y se escondería.
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "" '{"marker":{"stepsCompleted":[0],"filesTouched":[],"fileEvents":[]},"consumo":{"por_paso":{"0":1000,"1":null,"4":null,"5":null,"8":null},"fuera_de_ventana":0}}'
volcado "${T}/r" "${S2}" "2026-08-16T05:53:47Z" '{"marker":{"stepsCompleted":[]}}'
J="$(modelo_json "${T}/r")"
python3 -c "
import json,sys; c=json.loads(sys.argv[1])['corridas']
por={x['inicio'][:10]: x for x in c}
assert por['2026-08-15']['sin_pasos_anotados'] is False, por['2026-08-15'].get('sin_pasos_anotados')
assert por['2026-08-16']['sin_pasos_anotados'] is False, 'sin ningún paso no es «sólo el paso 0»'" "${J}" && ok "2.45-T7 el 0 sin trabajo y la corrida sin pasos NO se marcan" || mal "2.45-T7 se marcó una corrida que no cumple"
generar "${T}/r" "${T}/o.html" "${T}/log"
CELDAS="$(grep -o '<td class="pasos-n">[^/]*</span></td>' "${T}/o.html")"
grep -q 'quedó en Arranque' <<< "${CELDAS}" && ok "2.45-T7 la ejecución en el Arranque sin trabajo sigue diciendo «quedó en Arranque»" || mal "2.45-T7 ya no dice «quedó en Arranque»: ${CELDAS}"
grep -q 'no anotó sus pasos' <<< "${CELDAS}" && mal "2.45-T7 dice «no anotó sus pasos» sin que haya trabajado" || ok "2.45-T7 no dice «no anotó sus pasos»"
rm -rf "${T}"

# ── T8 · PermalinksViejosSiguen: solo, abrir y maquina andan como antes ──
# 🔴 sale rojo si la lectura de la dirección pisa ENLACE (solo/abrir) o el valor de ?maquina=.
T=$(mktemp -d); C="${T}/buzon"; R="${T}/local"
volcado "${C}/maq-a" "${S1}" "2026-08-20T10:00:00Z" '{"marker":{"storyId":"A1"}}'
volcado "${C}/maq-b" "${S3}" "2026-08-22T10:00:00Z" '{"marker":{"storyId":"B3"}}'
mkdir -p "${R}"
TYCON_MACHINE=maq-a node "${TABLERO}" --view runs --runs-dir "${R}" --mailbox "${C}" --output "${T}/o.html" >/dev/null 2>&1
E="$(CL_SEARCH="?maquina=maq-b" cliente "${T}/o.html" state)"
[ "$(campo "${E}" maquina)" = "maq-b" ] && [ "$(campo "${E}" vistas)" = "n=1 de 1" ] && ok "2.45-T8 ?maquina= filtra como antes" || mal "2.45-T8 ?maquina=: ${E}"
E="$(CL_SEARCH="?maquina=NoExiste" cliente "${T}/o.html" state)"
[ -z "$(campo "${E}" maquina)" ] && [ "$(campo "${E}" vistas)" = "n=2 de 2" ] && ok "2.45-T8 una máquina que no está se ignora" || mal "2.45-T8 máquina inexistente: ${E}"
E="$(CL_SEARCH="" cliente "${T}/o.html" set "f-maquina=maq-b")"
case "$(campo "${E}" url)" in *maquina=maq-b*) ok "2.45-T2 cambiar la máquina la escribe en la dirección";; *) mal "2.45-T2 la máquina no llegó a la dirección: ${E}";; esac
ENL="$(CL_SEARCH="?abrir=1&ver=3&git=2" cliente "${T}/o.html" link)"
[ "${ENL}" = '{"abrir":1,"ver":3,"git":2,"solo":null,"maquina":null}' ] && ok "2.45-T8 abrir, ver y git se leen como antes" || mal "2.45-T8 el enlace salió: ${ENL}"
ENL="$(CL_SEARCH="?solo=1&desde=2026-08-20" cliente "${T}/o.html" link)"
[ "${ENL}" = '{"abrir":1,"ver":null,"git":null,"solo":1,"maquina":null}' ] && ok "2.45-T8 solo sigue andando junto a un filtro nuevo" || mal "2.45-T8 solo: ${ENL}"
rm -rf "${T}"

# ── 7.23-T15 Metrics_EquivalenceWithoutSplitting (vista de ejecuciones) @story-7.23 @ac-13 ─────────────────────────
# Una ejecución vieja (pasos por número) y una nueva (por nombre) en la misma vista: cada una dice su esquema, la vieja
# lleva el 4 en una sola fila «Implementar + pruebas» y la nueva, Implementar y Correr las pruebas partidos; la página dice
# desde qué día están partidos.
# 🔴 sale rojo si la vista reparte el 4 viejo, pierde los pasos por nombre o no dice el esquema.
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "2026-08-15T05:53:47Z" '{"consumo":{"por_paso":{"4":100,"6":30,"7":20}}}'
volcado "${T}/r" "${S2}" "2026-08-20T05:53:47Z"
python3 - "${T}/r" "${S2}" <<'PYN'
import glob, json, sys
from datetime import datetime, timedelta, timezone
for f in glob.glob(sys.argv[1] + '/*.json'):
    v = json.load(open(f))
    if not f.endswith(sys.argv[2][:8] + '.json'): continue
    t0 = datetime(2026, 8, 20, 5, 53, 47, tzinfo=timezone.utc)
    iso = lambda m: (t0 + timedelta(minutes=m)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    pasos = ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'findings', 'prepare-commit']
    v['marker']['stepScheme'] = 2
    v['marker']['stepsCompleted'] = pasos
    v['marker']['stepsPending'] = []
    v['marker']['stepTimings'] = {p: {'startedAt': iso(i * 10), 'completedAt': iso(i * 10 + 8)} for i, p in enumerate(pasos)}
    v['consumo'] = {**(v.get('consumo') or {}), 'por_paso': {'implement': 10, 'run-tests': 20, 'findings': 5}}
    json.dump(v, open(f, 'w'), indent=1)
PYN
J="$(modelo_json "${T}/r")"
python3 -c "
import json,sys; m=json.loads(sys.argv[1]); c={x['inicio'][:10]: x for x in m['corridas']}
viejo, nuevo = c['2026-08-15'], c['2026-08-20']
assert viejo['esquema']==1 and nuevo['esquema']==2, (viejo['esquema'], nuevo['esquema'])
fv = [t['pasos'] for t in viejo['tramos'] if t.get('tipo')!='entre' and not t.get('subpaso')]
fn = [t['pasos'] for t in nuevo['tramos'] if t.get('tipo')!='entre' and not t.get('subpaso')]
assert [6] in fv and [4] not in fv and [5] not in fv, fv
assert [4] in fn and [5] in fn and [6] not in fn, fn
assert [t['nombre'] for t in viejo['tramos'] if t['pasos']==[6]]==['Implementar + pruebas'], viejo['tramos']
assert nuevo['llego_al_final'] and viejo['llego_al_final']
assert m['pasos_partidos_desde']=='2026-08-20', m['pasos_partidos_desde']
# el consumo por paso, con los dos esquemas en las mismas filas: el 4 viejo en la junta (6), el 6 y el 7 viejos sumados en Hallazgos (8)
kv, kn = viejo['consumo'].get('por_paso'), nuevo['consumo'].get('por_paso')
assert kv is None or (kv.get('6')==100 and kv.get('8')==50 and '4' not in kv), kv
assert kn is None or (kn.get('4')==10 and kn.get('5')==20 and kn.get('8')==5), kn
assert kv is not None or kn is not None, 'ninguna ejecución trajo su consumo'
" "${J}" && ok "7.23-T15 cada ejecución con su esquema; el 4 viejo en una fila, el nuevo partido" || mal "7.23-T15 vista con los dos esquemas: $(echo "${J}" | head -c 300)"
generar "${T}/r" "${T}/o.html" "${T}/log"
grep -q 'Desde el 2026-08-20, «Implementar» y «Correr las pruebas» son dos pasos' "${T}/o.html" && ok "7.23-T15 la página dice desde qué día están partidos" || mal "7.23-T15 la página no dice desde cuándo están partidos"
rm -rf "${T}"
# una ejecución nueva que sólo anotó el Arranque y trabajó se marca «no anotó sus pasos», como una vieja con el 0
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "" '{"marker":{"stepScheme":2,"stepsCompleted":["start"],"stepsPending":["validate-story"],"filesTouched":["a.js"],"fileEvents":[]}}'
python3 -c "
import json,sys; c=json.loads(sys.argv[1])['corridas'][0]; assert c['sin_pasos_anotados'] is True, c.get('sin_pasos_anotados')" "$(modelo_json "${T}/r")" && ok "7.23-T15 una ejecución nueva con sólo el Arranque y trabajo se marca" || mal "7.23-T15 la ejecución nueva con sólo el Arranque no se marcó"
rm -rf "${T}"
# una clave de paso que ninguna fila conoce no se publica cruda: sale «paso desconocido»
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "" '{"marker":{"stepTimings":{"CLAVE_SEMBRADA<b>":{"startedAt":"2026-08-15T05:54:00.000Z","completedAt":"2026-08-15T05:59:00.000Z"}}},"consumo":{"por_paso":{"CLAVE_SEMBRADA<b>":10}}}'
J="$(modelo_json "${T}/r")"
generar "${T}/r" "${T}/o.html" "${T}/log"
! grep -q 'CLAVE_SEMBRADA' <<< "${J}" && ! grep -q 'CLAVE_SEMBRADA' "${T}/o.html" && ok "7.23-T15 una clave de paso desconocida no sale cruda (ni en el modelo ni en la página)" || mal "7.23-T15 la clave cruda del volcado se publicó"
rm -rf "${T}"

# ═══════════════════════ la revisión de la historia antes de programar ═══════════════════════
# El cierre de cada corrida copia al volcado la constancia de la revisión previa (`revision_previa`, o null con su nota).
# La ficha cuenta historias, no corridas: dos corridas de la misma historia comparten su constancia.
# pon_null <archivo>: escribe `revision_previa: null` con su nota (el parche del fabricante borra las claves en null).
pon_null() { node -e "const f=process.argv[1],fs=require('fs');const d=JSON.parse(fs.readFileSync(f,'utf8'));d.revision_previa=null;d.revision_previa_nota=process.argv[2];fs.writeFileSync(f,JSON.stringify(d))" "$1" "$2"; }
# ficha_rp: sólo la ficha de la revisión previa, desde su apertura hasta la ficha siguiente.
ficha_rp() { python3 -c "
import sys
h=sys.stdin.read(); i=h.find('La historia revisada antes de programar')
fin=h.find('<div class=\"tile',i)
print(h[max(0,h.rfind('<div class=\"tile',0,i)):fin if fin>=0 else len(h)] if i>=0 else 'AUSENTE')"; }
RP_CORR='"revision_previa":{"resultado":"corregido","modelo":"MODELO_SEMBRADO","hallazgos":{"total":2,"por_regla":{"REGLA_SEMBRADA":2},"por_destino":{"corregido":2}},"duracion_ms":40000,"tokens":8000,"medido":true}'
RP_LIMPIO='"revision_previa":{"resultado":"limpio","modelo":"MODELO_SEMBRADO","hallazgos":{"total":0,"por_regla":{},"por_destino":{}},"duracion_ms":20000,"tokens":2000,"medido":true}'

# ── RP1 · con datos: cuántas historias se revisaron, cuántas se corrigieron y cuánto costó ──
# 🔴 Falla con: sin la ficha; contar la corrida vieja (sin el campo) como «sin revisión» (diría «de 4»); sumar el
#    costo de las dos corridas de la misma historia (diría 18 k); publicar el modelo o las reglas de los hallazgos.
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "2026-08-15T05:53:47Z" "{\"marker\":{\"storyId\":\"2.1\"},${RP_CORR}}" a.json
volcado "${T}/r" "${S2}" "2026-08-16T05:53:47Z" "{\"marker\":{\"storyId\":\"2.1\"},${RP_CORR}}" b.json
volcado "${T}/r" "${S3}" "2026-08-17T05:53:47Z" "{\"marker\":{\"storyId\":\"3.1\"},${RP_LIMPIO}}" c.json
volcado "${T}/r" "44444444-4444-4444-8444-444444444444" "2026-08-18T05:53:47Z" '{"marker":{"storyId":"4.1"}}' d.json
pon_null "${T}/r/d.json" "sin revisión previa"
volcado "${T}/r" "55555555-5555-4555-8555-555555555555" "2026-08-19T05:53:47Z" '{"marker":{"storyId":"5.1"}}' e.json
generar "${T}/r" "${T}/o.html" "${T}/log"
TILE="$(cliente "${T}/o.html" container fichas | ficha_rp)"
grep -q 'tile blind' <<< "${TILE}" && mal "RP1 con constancias la ficha salió gris: $(echo "${TILE}" | head -c 300)" || ok "RP1 con constancias la ficha sale medida"
grep -q '2 de 3 historias revisadas' <<< "${TILE}" && ok "RP1 2 de 3 historias revisadas (la vieja no entra en el denominador)" || mal "RP1 no dice «2 de 3 historias revisadas»: $(echo "${TILE}" | head -c 400)"
grep -q '<b>1</b> corregida por la revisión' <<< "${TILE}" && ok "RP1 una historia corregida por la revisión" || mal "RP1 no cuenta la corregida"
grep -q '<b>10 k</b> tokens en total' <<< "${TILE}" && ok "RP1 el costo en tokens, una vez por historia (10 k)" || mal "RP1 el costo en tokens no es 10 k: $(echo "${TILE}" | head -c 600)"
grep -q 'duración mediana <b>30 s</b>' <<< "${TILE}" && ok "RP1 la duración mediana de la revisión" || mal "RP1 falta la duración mediana"
grep -q '<b>1</b> sin revisión previa' <<< "${TILE}" && ok "RP1 la que no tuvo revisión se cuenta" || mal "RP1 no cuenta la que no tuvo revisión"
grep -q '<b>1</b> ejecución anterior a la revisión previa, contada aparte' <<< "${TILE}" && ! grep -q '(es)\|(s)' <<< "${TILE}" && ok "RP1 la corrida vieja se cuenta aparte" || mal "RP1 la corrida vieja no se cuenta aparte"
! grep -q 'MODELO_SEMBRADO\|REGLA_SEMBRADA' "${T}/o.html" && ok "RP1 ni el modelo ni las reglas de los hallazgos llegan a la página" || mal "RP1 la página publica texto de la constancia"
python3 -c "
import json,sys
cs={c['story']:c['revision_previa'] for c in json.loads(sys.argv[1])['corridas']}
assert cs['5.1']=={'estado':'sin_campo'}, cs['5.1']
assert cs['4.1']['estado']=='sin_revision', cs['4.1']
assert cs['3.1']=={'estado':'revisada','corregida':False,'hallazgos':0,'tokens':2000,'duracion_ms':20000}, cs['3.1']
" "$(modelo_json "${T}/r")" && ok "RP1 el modelo: la vieja «sin_campo», la sin revisión, y la revisada sólo con números" || mal "RP1 el modelo de la revisión previa no es el esperado"
rm -rf "${T}"

# ── RP2 · sin datos: sólo corridas viejas → gris con su motivo, nunca un cero ──
# 🔴 Falla con: tratar «sin el campo» como «sin revisión» (diría «0 de 2 historias revisadas»).
T=$(mktemp -d)
volcado "${T}/r" "${S1}"; volcado "${T}/r" "${S2}" "2026-08-16T05:53:47Z" '{"marker":{"storyId":"3.1"}}'
generar "${T}/r" "${T}/o.html" "${T}/log"
TILE="$(cliente "${T}/o.html" container fichas | ficha_rp)"
grep -q 'tile blind' <<< "${TILE}" && grep -q 'ninguna ejecución del filtro registra la revisión previa de su historia' <<< "${TILE}" && ok "RP2 sin constancias la ficha sale gris con el motivo" || mal "RP2 sin constancias la ficha no sale gris con su motivo: $(echo "${TILE}" | head -c 300)"
grep -q '2 ejecuciones anteriores a la revisión previa, contadas aparte' <<< "${TILE}" && ok "RP2 el motivo cuenta las viejas" || mal "RP2 el motivo no cuenta las viejas"
grep -q '0 de \|t-val">0' <<< "${TILE}" && mal "RP2 dibujó un cero donde no hay dato" || ok "RP2 ningún cero dibujado"
rm -rf "${T}"

# ── RP3 · revisada sin tokens ni duración medidos → «no medido», nunca 0; pendiente y saltada no son «revisada» ──
# 🔴 Falla con: sumar los null como 0 («0 tokens»); contar la pendiente como revisada o como sin revisión.
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "" '{"revision_previa":{"resultado":"limpio","modelo":"m","hallazgos":{"total":0,"por_regla":{},"por_destino":{}},"medido":false}}'
volcado "${T}/r" "${S2}" "2026-08-16T05:53:47Z" '{"marker":{"storyId":"3.1"},"revision_previa":{"resultado":"pendiente","modelo":"m","hallazgos":{"total":0,"por_regla":{},"por_destino":{}},"medido":false}}'
volcado "${T}/r" "${S3}" "2026-08-17T05:53:47Z" '{"marker":{"storyId":"4.1"},"revision_previa":{"resultado":"saltado","modelo":"m","hallazgos":{"total":0,"por_regla":{},"por_destino":{}},"medido":false}}'
generar "${T}/r" "${T}/o.html" "${T}/log"
TILE="$(cliente "${T}/o.html" container fichas | ficha_rp)"
grep -q '1 de 2 historias revisadas' <<< "${TILE}" && ok "RP3 la pendiente queda fuera del denominador; la saltada adentro" || mal "RP3 no dice «1 de 2 historias revisadas»: $(echo "${TILE}" | head -c 400)"
grep -q 'tokens: no medidos' <<< "${TILE}" && grep -q 'duración: no medida' <<< "${TILE}" && ok "RP3 tokens y duración sin medir lo dicen" || mal "RP3 tokens o duración sin medir no lo dicen"
grep -q '>0</b> tokens\|0 tokens' <<< "${TILE}" && mal "RP3 dibujó 0 tokens" || ok "RP3 ningún «0 tokens»"
grep -q '<b>1</b> saltada por riesgo bajo o apagada' <<< "${TILE}" && grep -q '<b>1</b> con la revisión sin medir' <<< "${TILE}" && ok "RP3 la saltada y la pendiente se cuentan aparte" || mal "RP3 la saltada o la pendiente no se cuentan"
rm -rf "${T}"

# ── RP4 · la misma historia en dos productos son dos historias ──
# 🔴 Falla con: agrupar sólo por el número de la historia (diría «1 de 1» y sumaría un solo costo).
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "2026-08-15T05:53:47Z" "{\"marker\":{\"storyId\":\"2.1\",\"repoPath\":\"/Users/dev/SourceCode/Totora/FrontEnd\"},${RP_CORR}}" a.json
volcado "${T}/r" "${S2}" "2026-08-16T05:53:47Z" "{\"marker\":{\"storyId\":\"2.1\",\"repoPath\":\"/Users/dev/SourceCode/HostApi\"},${RP_LIMPIO}}" b.json
generar "${T}/r" "${T}/o.html" "${T}/log"
TILE="$(cliente "${T}/o.html" container fichas | ficha_rp)"
grep -q '2 de 2 historias revisadas' <<< "${TILE}" && ok "RP4 la misma historia en dos productos cuenta dos veces" || mal "RP4 no dice «2 de 2 historias revisadas»: $(echo "${TILE}" | head -c 400)"
grep -q '<b>10 k</b> tokens en total' <<< "${TILE}" && ok "RP4 el costo suma las dos" || mal "RP4 el costo no suma las dos (10 k)"
rm -rf "${T}"

# ── ConErrorSinSemaforo · «encontró un error» es el control funcionando: la ficha informa, no se pinta ──
# 🔴 Falla con: juzgarla con el umbral de «menor es mejor» (el 100 % salía ROJO al lado de «es el control haciendo su trabajo»).
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "" '{"gates":[{"ts":"2026-08-15T06:10:00.000Z","check":"tests","status":"red:exit=1","cmd":"x","exit":1}]}'
generar "${T}/r" "${T}/o.html" "${T}/log"
TILE="$(cliente "${T}/o.html" container fichas | python3 -c "import re,sys; h=sys.stdin.read(); m=[t for t in re.findall(r'<div class=\"tile[^\"]*\">.*?</div></div>', h, re.S) if 'Ejecuciones donde un control' in t]; print(m[0] if m else 'SIN-FICHA')")"
grep -q '100%' <<< "${TILE}" && grep -q 'chip neutro' <<< "${TILE}" && ! grep -q 'chip bad\|chip warn\|>rojo<' <<< "${TILE}" && ok "ConErrorSinSemaforo el 100 % con error sale informativo, sin rojo" || mal "ConErrorSinSemaforo la ficha sigue con semáforo: $(head -c 400 <<< "${TILE}")"
rm -rf "${T}"

# ── FechaLocal · la columna de la fecha dice el mismo día que el filtro «hoy» ──
# 🔴 Falla con: la tabla en UTC y el filtro en la hora del navegador (una corrida de las 22 h de Argentina figuraba con el
# día siguiente y no aparecía en «hoy»).
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "2026-08-20T01:30:00Z" '{"marker":{"storyId":"F1"}}'
generar "${T}/r" "${T}/o.html" "${T}/log"
R="$(CL_NOW="2026-08-19T23:00:00Z" TZ="America/Argentina/Buenos_Aires" LANG=es_AR.UTF-8 cliente "${T}/o.html" table-dates)"
# el día con el formato del navegador, el mismo que muestran los campos de fecha del filtro
DIA_NAV="$(TZ="America/Argentina/Buenos_Aires" LANG=es_AR.UTF-8 node -e "console.log(new Date(2026, 7, 19).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' }))")"
[ "${R}" = "${DIA_NAV}:visible" ] && [ "${DIA_NAV}" != "2026-08-19" ] && ok "FechaLocal la fila dice el día local (19/08) con el formato del navegador y entra en «hoy»" || mal "FechaLocal la tabla y el filtro no dicen el mismo día: ${R}"
rm -rf "${T}"

# ── 2.79-T9 · 2.79-Corridas_SemanaDelGrafico_UsaElDiaLocalComoElFiltro @story-2.79 @ac-8 ──
# 🔴 Falla con: la barra con la semana UTC del servidor (la del domingo 22 h de Argentina cae en la semana siguiente).
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "2026-10-26T01:00:00Z" '{"marker":{"storyId":"D1"}}'   # domingo 25/10 22 h en Buenos Aires
volcado "${T}/r" "${S2}" "2026-10-27T15:00:00Z" '{"marker":{"storyId":"M1"}}'   # martes 27/10
volcado "${T}/r" "${S3}" "2026-10-20T15:00:00Z" '{"marker":{"storyId":"M0"}}'   # martes de la semana anterior
generar "${T}/r" "${T}/o.html" "${T}/log"
BAR="$(CL_NOW="2026-10-28T15:00:00Z" TZ="America/Argentina/Buenos_Aires" cliente "${T}/o.html" preset-then semana gsem | grep -o '<title>[^<]*</title>' | tr '\n' ' ')"
VIS="$(estado "2026-10-28T15:00:00Z" "" "America/Argentina/Buenos_Aires" preset semana | python3 -c "import json,sys; print(json.load(sys.stdin)['vistas'])")"
grep -q '2026-S44: 1 ' <<< "${BAR}" && ! grep -q '2026-S44: 2' <<< "${BAR}" && [ "${VIS}" = "n=1 de 1" ] \
  && ok "2.79-T9 la barra de esta semana y el filtro «esta semana» dicen 1 (el domingo 22 h local queda en la anterior)" || mal "2.79-T9 la barra y el filtro no coinciden: barras «${BAR}» · filtro «${VIS}»"
TODAS="$(CL_NOW="2026-10-28T15:00:00Z" TZ="America/Argentina/Buenos_Aires" cliente "${T}/o.html" container gsem | grep -o '<title>[^<]*</title>' | tr '\n' ' ')"
grep -q '2026-S43: 2 ' <<< "${TODAS}" && ok "2.79-T9 sin filtro, la semana del domingo local junta las dos de esa semana" || mal "2.79-T9 las semanas sin filtro: ${TODAS}"
rm -rf "${T}"

# ── 2.79-T10 · 2.79-Corridas_FichaConError_NoLlamaOtrasALasQueSeSuperponen @story-2.79 @ac-9 ──
# 🔴 Falla con: «En otras M el control frenó» (las frenadas también pueden tener error: no son «otras»).
T=$(mktemp -d)
ROJO='{"ts":"2026-08-15T06:10:00.000Z","check":"tests","status":"red:exit=1","cmd":"x","exit":1}'
FRENO='{"ts":"2026-08-15T06:12:00.000Z","check":"atdd-preedit","status":"blocked","cmd":"x"}'
volcado "${T}/r" "${S1}" "2026-08-15T05:53:47Z" "{\"marker\":{\"storyId\":\"E1\"},\"gates\":[${ROJO}]}"
volcado "${T}/r" "${S2}" "2026-08-15T05:53:47Z" "{\"marker\":{\"storyId\":\"E2\"},\"gates\":[${ROJO}]}"
volcado "${T}/r" "${S3}" "2026-08-15T05:53:47Z" "{\"marker\":{\"storyId\":\"F1\"},\"gates\":[${FRENO}]}"
volcado "${T}/r" "44444444-4444-4444-8444-444444444444" "2026-08-15T05:53:47Z" "{\"marker\":{\"storyId\":\"EF\"},\"gates\":[${ROJO},${FRENO}]}"
generar "${T}/r" "${T}/o.html" "${T}/log"
TILE="$(cliente "${T}/o.html" container fichas | python3 -c "import re,sys; h=sys.stdin.read(); m=[t for t in re.findall(r'<div class=\"tile[^\"]*\">.*?</div></div>', h, re.S) if 'Ejecuciones donde un control' in t]; print(re.sub(r'<[^>]+>', '', m[0]) if m else 'SIN-FICHA')")"
grep -q '2 con error, 1 frenadas por un control, 1 con las dos' <<< "${TILE}" && ok "2.79-T10 la ficha dice «2 con error, 1 frenadas por un control, 1 con las dos»" || mal "2.79-T10 la ficha dice: $(head -c 400 <<< "${TILE}")"
grep -qw 'otras' <<< "${TILE}" && mal "2.79-T10 la ficha todavía dice «otras»" || ok "2.79-T10 sin «otras»"
rm -rf "${T}"

# ── 2.79-T11 · 2.79-Corridas_PieDeEspera_DiceLoMismoQueLaFicha @story-2.79 @ac-10 ──
# 🔴 Falla con: el pie que habla sólo de los dos pasos y la ficha que suma las preguntas de la conversación.
R11="$(node -e "
const r = require(process.argv[1]);
const M = { corridas: [], multi: false, varias_maquinas: false };
const out = [];
for (const I of ['es', 'en']) {
  const def = r.textosDelCliente(I).esperaDefinicion;
  const pie = r.pie(M, { idioma: I }).replace(/<[^>]+>/g, '');
  out.push(I + ':' + (def && pie.includes(def) ? 'igual' : 'distinta'));
}
console.log(out.join(' '));" "${RAIZ}/scripts/nightly/dashboard/runs.js" 2>&1)"
[ "${R11}" = "es:igual en:igual" ] && ok "2.79-T11 el pie da la misma definición de espera que la ficha, en los dos idiomas" || mal "2.79-T11 dio: ${R11}"
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "" "${ARRANQUES}"
generar "${T}/r" "${T}/o.html" "${T}/log"
DEF="$(node -e "console.log(require(process.argv[1]).textosDelCliente('es').esperaDefinicion)" "${RAIZ}/scripts/nightly/dashboard/runs.js")"
FICHA="$(cliente "${T}/o.html" container fichas)"
grep -qF "${DEF}" <<< "${FICHA}" && ok "2.79-T11 la ficha dibujada usa esa definición" || mal "2.79-T11 la ficha dibujada no trae la definición «${DEF}»"
rm -rf "${T}"

# ── 2.79-T12 · 2.79-Corridas_DetalleSinEvaluaciones_DiceSinDatosNoCero @story-2.79 @ac-11 ──
# 🔴 Falla con: «ningún control encontró un error» para una ejecución sin una sola evaluación, y contarla «con controles».
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "" '{"gates":[]}'
volcado "${T}/r" "${S2}" "2026-08-16T05:53:47Z" '{"marker":{"storyId":"3.1"}}'
generar "${T}/r" "${T}/o.html" "${T}/log"
DET="$(cliente "${T}/o.html" all)"
grep -q 'no registró evaluaciones de controles' <<< "${DET}" && ok "2.79-T12 el detalle dice «no registró evaluaciones de controles»" || mal "2.79-T12 el detalle no lo dice"
grep -q 'ningún control encontró un error' <<< "$(cliente "${T}/o.html" detail 0)" && mal "2.79-T12 dice «ningún control encontró un error» sin evaluaciones" || ok "2.79-T12 no dice que ningún control encontró un error"
TILE="$(cliente "${T}/o.html" container fichas | python3 -c "import re,sys; h=sys.stdin.read(); m=[t for t in re.findall(r'<div class=\"tile[^\"]*\">.*?</div></div>', h, re.S) if 'Ejecuciones donde un control' in t]; print(re.sub(r'<[^>]+>', '', m[0]) if m else 'SIN-FICHA')")"
grep -q '1 de 1 ejecución con controles' <<< "${TILE}" && ok "2.79-T12 la ejecución sin evaluaciones no cuenta «con controles»" || mal "2.79-T12 la ficha cuenta: $(head -c 300 <<< "${TILE}")"
rm -rf "${T}"

# ── 2.79-T13 · 2.79-Corridas_SinCostoReciente_NoDiceAnteriorAlConteo @story-2.79 @ac-11 ──
# 🔴 Falla con: «es anterior al conteo mecánico» para una ejecución posterior a otra que sí lo trae.
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "2026-08-10T05:53:47Z" '{"marker":{"storyId":"V1"},"costo":null}'
volcado "${T}/r" "${S2}" "2026-08-15T05:53:47Z" '{"marker":{"storyId":"C1"}}'
volcado "${T}/r" "${S3}" "2026-08-20T05:53:47Z" '{"marker":{"storyId":"N1"},"costo":null}'
generar "${T}/r" "${T}/o.html" "${T}/log"
I_N="$(node -e "const h=require('fs').readFileSync(process.argv[1],'utf8');const M=JSON.parse(h.match(/<script id=\"modelo\" type=\"application\/json\">([\s\S]*?)<\/script>/)[1]);console.log(M.corridas.findIndex(c=>c.story==='N1'), M.corridas.findIndex(c=>c.story==='V1'))" "${T}/o.html")"
DN="$(cliente "${T}/o.html" detail "${I_N% *}")"; DV="$(cliente "${T}/o.html" detail "${I_N#* }")"
grep -q 'el registro de la ejecución no trae el conteo de agentes' <<< "${DN}" && ! grep -q 'es anterior al conteo' <<< "${DN}" && ok "2.79-T13 la posterior sin conteo dice que el registro no lo trae" || mal "2.79-T13 la posterior dice otra cosa"
grep -q 'es anterior al conteo' <<< "${DV}" && ok "2.79-T13 la anterior sigue diciendo que es anterior" || mal "2.79-T13 la anterior perdió su motivo"
rm -rf "${T}"

# ── 2.79-T18 · 2.79-Corridas_ConteosDelDesplegable_SiguenElFiltroDeFechas @story-2.79 @ac-15 ──
# 🔴 Falla con: los conteos del desplegable armados una vez, con todas las ejecuciones.
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "2026-10-05T15:00:00Z" '{"marker":{"storyId":"A","repoPath":"/Users/dev/SourceCode/Totora/FrontEnd"}}'
volcado "${T}/r" "${S2}" "2026-09-05T15:00:00Z" '{"marker":{"storyId":"B","repoPath":"/Users/dev/SourceCode/Totora/FrontEnd"}}'
volcado "${T}/r" "${S3}" "2026-09-06T15:00:00Z" '{"marker":{"storyId":"C","repoPath":"/Users/dev/SourceCode/Totora/FrontEnd"}}'
generar "${T}/r" "${T}/o.html" "${T}/log"
ANTES="$(CL_NOW="2026-10-20T15:00:00Z" cliente "${T}/o.html" container f-repo | grep -o '>[^<]*([0-9]*)<' | tr '\n' ' ')"
DESP="$(CL_NOW="2026-10-20T15:00:00Z" cliente "${T}/o.html" preset-then mes f-repo | grep -o '>[^<]*([0-9]*)<' | tr '\n' ' ')"
grep -q 'todos (3)' <<< "${ANTES}" && grep -q 'Totora · FrontEnd (3)' <<< "${ANTES}" && grep -q 'todos (1)' <<< "${DESP}" && grep -q 'Totora · FrontEnd (1)' <<< "${DESP}" \
  && ok "2.79-T18 con «este mes» el desplegable cuenta 1, no 3" || mal "2.79-T18 antes «${ANTES}» · con el mes «${DESP}»"
rm -rf "${T}"

# ── 2.79-T24 · 2.79-Corridas_DesplegableSinRepetidosNiWorktrees @story-2.79 @ac-21 ──
# 🔴 Falla con: «(sin producto)» y el repo del arnés dos veces (en «otros repos» y en «laboratorio»), y la carpeta
# `worktrees/<nombre>` como si fuera un repo.
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "2026-08-15T05:53:47Z" '{"marker":{"storyId":"A","repoPath":"/Users/dev/SourceCode/tycon-claude-guides"}}'
volcado "${T}/r" "${S2}" "2026-08-15T05:53:47Z" '{"marker":{"storyId":"B","repoPath":"/private/tmp/lab-x/tycon-claude-guides"}}'
volcado "${T}/r" "${S3}" "2026-08-15T05:53:47Z" '{"marker":{"storyId":"C","repoPath":"."}}'
volcado "${T}/r" "44444444-4444-4444-8444-444444444444" "2026-08-15T05:53:47Z" '{"marker":{"storyId":"D","repoPath":"/private/tmp"}}'
volcado "${T}/r" "55555555-5555-4555-8555-555555555555" "2026-08-15T05:53:47Z" '{"marker":{"storyId":"E","repoPath":"/Users/dev/SourceCode/worktrees/th-63"}}'
volcado "${T}/r" "66666666-6666-4666-8666-666666666666" "2026-08-15T05:53:47Z" '{"marker":{"storyId":"F","repoPath":"/Users/dev/SourceCode/worktrees/hm-64"},"repo":{"path":"/Users/dev/SourceCode/Totora/FrontEnd"}}'
volcado "${T}/r" "77777777-7777-4777-8777-777777777777" "2026-08-15T05:53:47Z" '{"marker":{"storyId":"G","repoPath":"/Users/dev/SourceCode/Totora/frontend"}}'
generar "${T}/r" "${T}/o.html" "${T}/log"
ETQ="$(cliente "${T}/o.html" container f-repo | grep -o '<option value="[^"]*">[^<]*</option>' | sed -E 's/<option value="[^"]*">//; s/ \([0-9]+\)<\/option>//' | sort)"
[ -z "$(uniq -d <<< "${ETQ}")" ] && ok "2.79-T24 el desplegable no repite etiquetas" || mal "2.79-T24 etiquetas repetidas: $(uniq -d <<< "${ETQ}" | tr '\n' ',')"
grep -q 'worktrees' <<< "${ETQ}" && mal "2.79-T24 el desplegable muestra una carpeta de worktree" || ok "2.79-T24 ninguna carpeta de worktree"
CUENTA="$(cliente "${T}/o.html" container f-repo | grep -io '>Totora · frontend ([0-9]*)<' | tr '\n' ' ')"
[ "$(tr '[:upper:]' '[:lower:]' <<< "${CUENTA}")" = ">totora · frontend (2)< " ] && ok "2.79-T24 el worktree con su repo cuenta como el repo, y la mayúscula distinta se une" || mal "2.79-T24 Totora/FrontEnd: «${CUENTA}» · etiquetas: $(tr '\n' ',' <<< "${ETQ}")"
grep -q 'Totora/' <<< "${ETQ}" && mal "2.79-T24 el desplegable muestra «producto/repo» en vez de «producto · repo»" || ok "2.79-T24 el desplegable rotula «producto · repo», como Proyectos y Configuración"
rm -rf "${T}"

# ── 2.79-T36 · 2.79-Corridas_TokensSinMedir_MuestraElMotivo @story-2.79 @ac-32 ──
# 🔴 Falla con: el motivo sólo en el «title» (hay que pasar el mouse) y nombrando `cleanupPeriodDays`.
T=$(mktemp -d)
volcado "${T}/r" "${S1}" "" '{"consumo":{"estado":"borrada","motivo":"la conversación de esta ejecución ya no está (Claude Code las borra según cleanupPeriodDays); se buscó x.jsonl en las 3 carpetas de conversaciones","tokens":null}}'
generar "${T}/r" "${T}/o.html" "${T}/log"
CELDA="$(python3 -c "import re,sys; h=open(sys.argv[1]).read(); m=re.search(r'<td class=\"tk\">(.*?)</td>', h, re.S); print(m.group(1) if m else 'SIN-CELDA')" "${T}/o.html")"
VISIBLE="$(sed -E 's/title="[^"]*"//g; s/<[^>]+>/ /g' <<< "${CELDA}")"
grep -q 'ya no está' <<< "${VISIBLE}" && ok "2.79-T36 el motivo se ve en la celda, sin pasar el mouse" || mal "2.79-T36 la celda muestra: ${VISIBLE}"
grep -q 'cleanupPeriodDays' "${T}/o.html" && mal "2.79-T36 la página nombra cleanupPeriodDays" || ok "2.79-T36 sin cleanupPeriodDays"
grep -q 'cleanupPeriodDays' "${RAIZ}/scripts/metrics/tokens-digest.js" && mal "2.79-T36 el medidor sigue escribiendo cleanupPeriodDays en el motivo" || ok "2.79-T36 el medidor ya no lo escribe"
rm -rf "${T}"

# ── 2.79-T48 · 2.79-Corridas_DatosCrudosEnLlano @story-2.79 @ac-39 ──
# 🔴 Falla con: el chip del detalle armado con `'DoD ' + c.dod` («DoD PASS», «DoD FAIL»). La otra mitad (estilo,
# opción con valor técnico y campo sin nombre, en Configuración) está en site-config.test.js con el mismo nombre.
T=$(mktemp -d)
volcado "${T}/r" "${S1}"
volcado "${T}/r" "${S2}" "2026-08-16T05:53:47Z" '{"marker":{"dodRuntime":{"verdict":"FAIL","evidencePath":"x.md"}}}'
generar "${T}/r" "${T}/o.html" "${T}/log"
D="$(cliente "${T}/o.html" all)"
grep -qE 'DoD|\bPASS\b' <<< "$(sed -E 's/<[^>]+>/ /g' <<< "${D}")" && mal "2.79-T48 el detalle muestra el veredicto crudo: $(grep -oE '[^>]{0,20}(DoD|PASS)[^<]{0,20}' <<< "${D}" | head -2 | tr '\n' ' ')" || ok "2.79-T48 sin «DoD PASS» ni «DoD FAIL» en el detalle"
grep -q 'terminado de verdad: pasó' <<< "${D}" && grep -q 'terminado de verdad: no pasó' <<< "${D}" && ok "2.79-T48 el veredicto se dice en llano, el que pasó y el que no" || mal "2.79-T48 falta el veredicto en llano"
rm -rf "${T}"

# ── 2.79-T55 · 2.79-Corridas_ControlesSinDesplazar @story-2.79 @ac-44 ──
# 🔴 Falla con: la tabla sin la señal de «sigue» a 900 px, o sin tarjetas a 640 px o menos (Controles detrás del
#    desplazamiento lateral). Mismo navegador que ANCHO-T1; sin Chrome, NO MEDIDO — nunca «ok».
if [ -z "${CHROME_BIN}" ]; then
  echo "  NO MEDIDO — 2.79-T55 no hay Chrome en esta máquina (TYCON_CHROME lo apunta; TYCON_CHROME=0 lo apaga a propósito): la tabla en sus anchos no se verificó"
else
  T=$(mktemp -d)
  volcado "${T}/r" "${S1}" "2026-09-10T10:00:00Z" '{"gates":[{"ts":"2026-09-10T10:20:00.000Z","check":"atdd-preedit","status":"red:exit=1"}]}'
  volcado "${T}/r" "${S2}" "2026-09-11T10:00:00Z"
  generar "${T}/r" "${T}/o.html" "${T}/log"
  cat >> "${T}/o.html" <<'MEDIR'
<script>window.addEventListener('load',function(){setTimeout(function(){var caja=document.querySelector('.tabla'),t=caja.querySelector('table'),vista=document.documentElement.clientWidth,ths=t.querySelectorAll('thead th'),ctl=ths[ths.length-1],fila=t.querySelector('tbody tr[data-i]'),fr=fila.querySelector('td.frenos').getBoundingClientRect(),envoltorio=caja.parentElement,despues=envoltorio?getComputedStyle(envoltorio,'::after'):null;
var r={vista:vista,desplaza:t.scrollWidth>caja.clientWidth+1,ctlDentro:ctl.getBoundingClientRect().right<=caja.getBoundingClientRect().right+1,tarjeta:getComputedStyle(fila).display!=='table-row'&&getComputedStyle(t.querySelector('thead')).display==='none',frenosDentro:fr.left>=0&&fr.right<=vista+1&&fr.width>0,senal:!!(despues&&despues.content!=='none'&&Number(despues.opacity)>0&&/sigue/.test(envoltorio.className))};
document.body.setAttribute('data-medida',JSON.stringify(r));},300);});</script>
MEDIR
  for ANCHO in 1440 900 600 390; do
    R="$(perl -e 'alarm shift; exec @ARGV' 60 "${CHROME_BIN}" --headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check --window-size=${ANCHO},1000 --virtual-time-budget=4000 --dump-dom "file://${T}/o.html?abrir=0" 2>/dev/null | python3 -c "
import re,sys,html; m=re.search(r'data-medida=\"([^\"]*)\"', sys.stdin.read()); print(html.unescape(m.group(1)) if m else 'sin-medida')")"
    if [ "${R}" = "sin-medida" ]; then mal "2.79-T55 a ${ANCHO} px Chrome no devolvió la medida: $(head -c 300 "${T}/log")"; continue; fi
    python3 -c "
import json,sys; r=json.loads(sys.argv[1]); a=int(sys.argv[2])
if a>=1440: assert not r['desplaza'] and r['ctlDentro'], ('entera y Controles a la vista', r)
elif a>640: assert r['desplaza'] and r['senal'], ('se desplaza y la señal de que sigue se ve', r)
else: assert r['tarjeta'] and r['frenosDentro'] and not r['desplaza'], ('tarjetas con Controles dentro del ancho', r)
" "${R}" "${ANCHO}" 2>"${T}/err" && ok "2.79-T55 a ${ANCHO} px la tabla se lee con Controles a la vista" || mal "2.79-T55 a ${ANCHO} px: $(tail -1 "${T}/err")"
  done
  rm -rf "${T}"
fi

# ── 2.79-T56 · 2.79-Corridas_RampaDistinguible @story-2.79 @ac-45 ──
# 🔴 Falla con: la rampa de un solo tono (dos vecinos a menos de 15 de distancia), las dos copias distintas, o un
#    rótulo de barra que no se lee sobre su color.
python3 - "${RAIZ}/scripts/nightly/dashboard/runs.js" <<'PY' 2>"${FX}.err" && ok "2.79-T56 la rampa: diez colores en cuatro familias, vecinos distinguibles, las dos copias iguales y el rótulo legible" || mal "2.79-T56 $(tail -1 "${FX}.err")"
import re, sys, math
src = open(sys.argv[1]).read()
rampas = [re.findall(r"#[0-9A-Fa-f]{6}", m) for m in re.findall(r"(?:const|var) RAMPA = \[([^\]]*)\]", src)]
assert len(rampas) == 2, 'hay dos rampas: la del servidor y la del navegador (%d)' % len(rampas)
assert [c.upper() for c in rampas[0]] == [c.upper() for c in rampas[1]], 'las dos rampas son la misma'
R = [c.upper() for c in rampas[0]]
assert len(R) == 10 and len(set(R)) == 10, 'diez colores sin repetidos: %s' % R
def lab(h):
    rgb = [int(h[i:i+2], 16) / 255 for i in (1, 3, 5)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    x = (lin[0]*0.4124 + lin[1]*0.3576 + lin[2]*0.1805) / 0.95047
    y = (lin[0]*0.2126 + lin[1]*0.7152 + lin[2]*0.0722)
    z = (lin[0]*0.0193 + lin[1]*0.1192 + lin[2]*0.9505) / 1.08883
    f = lambda t: t ** (1/3) if t > 0.008856 else 7.787 * t + 16/116
    return (116*f(y) - 16, 500*(f(x) - f(y)), 200*(f(y) - f(z)))
L = [lab(c) for c in R]
for i in range(9):
    d = math.dist(L[i], L[i+1])
    assert d >= 15, 'los pasos %d y %d están a %.1f (menos de 15)' % (i, i+1, d)
tono = lambda l: math.degrees(math.atan2(l[2], l[1])) % 360
dif = lambda a, b: min(abs(a - b), 360 - abs(a - b))
FAM = [[0, 1, 2, 3], [4, 5, 6], [7, 8], [9]]
medio = []
for f in FAM:
    t = [tono(L[i]) for i in f]
    assert all(dif(a, t[0]) <= 25 for a in t), 'la familia %s no es una sola tonalidad: %s' % (f, [round(x) for x in t])
    medio.append(t[0])
for i in range(4):
    for j in range(i + 1, 4):
        assert dif(medio[i], medio[j]) >= 30, 'las familias %s y %s tienen casi el mismo tono' % (FAM[i], FAM[j])
tinta = re.search(r"var TINTA = \[([^\]]*)\]", src)
assert tinta, 'el color del rótulo de cada barra está declarado (TINTA)'
T = re.findall(r"#[0-9A-Fa-f]{3,6}", tinta.group(1))
assert len(T) == 10, 'un color de rótulo por paso'
def lum(h):
    h = h if len(h) == 7 else '#' + ''.join(c * 2 for c in h[1:])
    v = [int(h[i:i+2], 16) / 255 for i in (1, 3, 5)]
    v = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in v]
    return 0.2126*v[0] + 0.7152*v[1] + 0.0722*v[2]
for i, (b, t) in enumerate(zip(R, T)):
    a, c = sorted([lum(b), lum(t)], reverse=True)
    assert (a + 0.05) / (c + 0.05) >= 4.5, 'el rótulo del paso %d no se lee sobre su barra' % i
PY

# ── 2.79-T57 · 2.79-Corridas_EtiquetaLargaConTitle @story-2.79 @ac-46 ──
# 🔴 Falla con: la etiqueta del control entera, anclada a la derecha: un nombre largo se corta por la izquierda.
T=$(mktemp -d)
LARGO='un-control-de-nombre-larguisimo-que-no-entra-en-la-columna-de-las-etiquetas-del-detalle'
volcado "${T}/r" "${S1}" "2026-09-10T10:00:00Z" "{\"gates\":[{\"ts\":\"2026-09-10T10:20:00.000Z\",\"check\":\"${LARGO}\",\"status\":\"red:exit=1\"}]}"
generar "${T}/r" "${T}/o.html" "${T}/log"
cliente "${T}/o.html" detail 0 > "${T}/d"
python3 - "${T}/d" "${LARGO}" <<'PY' 2>"${T}/err" && ok "2.79-T57 la etiqueta larga se recorta con «…» y el nombre entero va en su <title>" || mal "2.79-T57 $(tail -1 "${T}/err")"
import re, sys
d = open(sys.argv[1]).read(); largo = sys.argv[2]
etiquetas = [m for m in re.findall(r'<text [^>]*text-anchor="end"[^>]*>(.*?)</text>', d, re.S) if largo[:20] in m]
assert etiquetas, 'no encontré la etiqueta del control en la línea de tiempo'
e = etiquetas[0]
assert '<title>' in e and largo in re.search(r'<title>(.*?)</title>', e, re.S).group(1), 'el nombre entero va en el <title>'
visible = re.sub(r'<title>.*?</title>', '', e, flags=re.S)
assert visible.rstrip().endswith('…') and len(visible) < len(largo), 'lo visible se recorta con «…»: %r' % visible
PY
rm -rf "${T}"

# ── 2.79-T58 · 2.79-Corridas_GraficoPasos_AvisaMesesSinMedir @story-2.79 @ac-47 ──
# 🔴 Falla con: el gráfico mes a mes con textos de 9,5 px, el rótulo de la línea base dentro del área de los valores, o
#    sin el aviso de los meses que no se midieron.
T=$(mktemp -d)
volcado "${T}/hueco" "${S1}" "2026-06-10T05:00:00Z" '{"consumo":{"respuestas":100}}'
volcado "${T}/hueco" "${S2}" "2026-08-10T05:00:00Z" '{"consumo":{"respuestas":104}}'
volcado "${T}/todos" "${S1}" "2026-06-10T05:00:00Z" '{"consumo":{"respuestas":100}}'
volcado "${T}/todos" "${S2}" "2026-07-10T05:00:00Z" '{"consumo":{"respuestas":120}}'
volcado "${T}/nada" "${S1}" "2026-06-10T05:00:00Z" '{"consumo":null}'
for caso in hueco todos nada; do
  node -e "
const c = require('${RAIZ}/scripts/nightly/dashboard/runs.js');
const M = c.modelo('${T}/${caso}');
M.linea_base_pasos = { estado: 'medida', mediana: 102, fecha: '2026-05-01' };
require('fs').writeFileSync('${T}/${caso}.html', c.render(M));"
done
for caso in hueco todos nada; do cliente "${T}/${caso}.html" container gpasos > "${T}/${caso}.g"; done
python3 - "${T}/hueco.g" <<'PY' 2>"${T}/err" && ok "2.79-T58 con un mes sin medir: el aviso lo nombra, ningún texto chico y la línea base en la leyenda" || mal "2.79-T58 $(tail -1 "${T}/err")"
import re, sys
g = open(sys.argv[1]).read()
svg = re.search(r'<svg[\s\S]*?</svg>', g)
assert svg, 'el gráfico se dibuja'
s = svg.group(0); fuera = g.replace(s, '')
chicos = [float(x) for x in re.findall(r'font-size="([\d.]+)"', s) if float(x) < 11]
assert not chicos, 'textos de menos de 11 px en el gráfico: %s' % chicos
textos = re.sub(r'<title>.*?</title>', '', s)
assert 'línea base' not in re.sub(r'<[^>]+>', ' ', textos), 'el rótulo de la línea base no va dentro del área de los valores'
assert 'línea base' in fuera, 'la línea base se nombra en la leyenda, debajo'
assert re.search(r'sin medir[^<]*2026-07', fuera), 'el aviso nombra el mes sin medir: %s' % re.sub(r'<[^>]+>', ' ', fuera)[:300]
PY
python3 - "${T}/todos.g" <<'PY' 2>"${T}/err" && ok "2.79-T58 con todos los meses medidos no hay aviso" || mal "2.79-T58 con todos medidos: $(tail -1 "${T}/err")"
import re, sys
g = open(sys.argv[1]).read()
assert '<svg' in g, 'el gráfico se dibuja'
fuera = re.sub(r'<svg[\s\S]*?</svg>', '', g)
assert not re.search(r'sin medir[^<]*2026-', fuera), 'un aviso de meses sin medir con todos medidos: %s' % re.sub(r'<[^>]+>', ' ', fuera)[:300]
PY
grep -q 'no hay serie que dibujar' "${T}/nada.g" && ! grep -q '<svg' "${T}/nada.g" && ok "2.79-T58 sin ningún mes medido: el texto de «sin serie» y ningún gráfico" || mal "2.79-T58 sin ninguno: $(head -c 300 "${T}/nada.g")"
rm -rf "${T}"

# ── 2.79-T68 · 2.79-Corridas_TituloCortoFiltroVacioYDireccion @story-2.79 @ac-57 @ac-59 @ac-60 @ac-61 ──
# 🔴 Falla con: el título de 285 caracteres entero en la tabla, el filtro vacío en NO MEDIDO o sin sugerir qué cambiar,
#    las casillas «sin consumo» y «llegaron» fuera de la dirección, o «1 ejecuciones» / «de otras 0» con una sola.
T=$(mktemp -d)
LARGO="$(python3 -c "print('-'.join('palabra%03d' % i for i in range(26)))")"
volcado "${T}/r" "${S1}" "2026-10-20T15:00:00Z" "{\"marker\":{\"storyId\":\"9.9\",\"storyPath\":\"/x/specs/story-9.9-${LARGO}.md\"}}"
generar "${T}/r" "${T}/o.html" "${T}/log"
python3 - "${T}/o.html" "${LARGO}" <<'PY' 2>"${T}/err" && ok "2.79-T68 el título largo se corta en «…» y el entero queda en su title" || mal "2.79-T68 $(tail -1 "${T}/err")"
import re, sys, html
h = open(sys.argv[1]).read(); entero = sys.argv[2].replace('-', ' ')
m = re.search(r'<span class="desc" title="([^"]*)">([^<]*)</span>', h)
assert m, 'la fila no trae la descripción'
assert html.unescape(m.group(1)) == entero, 'el title lleva el título entero'
visible = html.unescape(m.group(2))
assert visible.endswith('…') and len(visible) <= 241, 'lo visible se corta en 240 con «…»: %d %r' % (len(visible), visible[-20:])
PY
# pase adversarial: un emoji justo en el corte no se parte a la mitad (queda entero o afuera, nunca «�»)
T2=$(mktemp -d)
EMOJI="$(python3 -c "print('a' * 239 + '\U0001F600' + 'b' * 40)")"
volcado "${T2}/r" "${S1}" "2026-10-20T15:00:00Z" "{\"marker\":{\"storyId\":\"9.8\",\"storyPath\":\"/x/specs/story-9.8-${EMOJI}.md\"}}"
generar "${T2}/r" "${T2}/o.html" "${T2}/log"
python3 - "${T2}/o.html" <<'PY' 2>"${T2}/err" && ok "2.79-T68 un emoji en el corte del título no se parte" || mal "2.79-T68 $(tail -1 "${T2}/err")"
import re, sys, html
h = open(sys.argv[1], encoding='utf-8', errors='surrogateescape').read()
m = re.search(r'<span class="desc" title="([^"]*)">([^<]*)</span>', h)
assert m, 'la fila no trae la descripción'
visible = html.unescape(m.group(2))
assert '�' not in visible and not re.search('[\ud800-\udfff]', visible), 'el emoji quedó partido: %r' % visible[-6:]
assert visible.endswith('…'), 'se corta con «…»: %r' % visible[-6:]
PY
rm -rf "${T2}"
PROD="$(modelo_json "${T}/r" | python3 -c "import json,sys; print(json.load(sys.stdin)['corridas'][0]['producto'] or '')")"
estado() { CL_NOW="$1" CL_SEARCH="$2" TZ="${3:-UTC}" cliente "${T}/o.html" "${@:4}"; }
# el filtro por máquina sólo existe con varias máquinas: esa página sale de una carpeta bajada del buzón
volcado "${T}/b/maq-b" "${S2}" "2026-10-20T16:00:00Z" '{"marker":{"storyId":"B1"}}'
TYCON_MACHINE=maq-a node "${TABLERO}" --view runs --runs-dir "${T}/r" --mailbox "${T}/b" --output "${T}/m.html" >/dev/null 2>&1
for caso in "o|fechas|f-desde=2030-01-01;f-hasta=2030-12-31|rango" "o|producto|f-desde=2030-01-01;f-hasta=2030-12-31;f-repo=${PROD}|producto" "m|maquina|f-desde=2030-01-01;f-hasta=2030-12-31;f-maquina=maq-b|máquina"; do
  IFS='|' read -r pag nom campos pista <<< "${caso}"
  FV="$(CL_NOW="2026-10-21T15:00:00Z" cliente "${T}/${pag}.html" set "${campos}" | python3 -c "import json,re,sys; print(re.sub(r'<[^>]+>', ' ', json.load(sys.stdin)['fichas']))")"
  grep -q '0 ejecuciones' <<< "${FV}" && ! grep -qi 'no medido' <<< "${FV}" && grep -q "${pista}" <<< "${FV}" \
    && ok "2.79-T68 filtro vacío por ${nom}: «0 ejecuciones», sin NO MEDIDO, y nombra «${pista}»" || mal "2.79-T68 filtro vacío por ${nom}: ${FV:0:300}"
done
# pase adversarial: un vacío que viene de la casilla «sin consumo» lo dice, en vez de mandar a cambiar las fechas
#    (con una sola ejecución, sin consumo medido: la casilla «sólo con consumo medido» la deja afuera)
volcado "${T}/sc" "${S2}" "2026-10-20T15:00:00Z" '{"consumo":{"estado":"borrada","motivo":"x","tokens":null,"por_modelo":null,"por_paso":null,"fuera_de_ventana":null,"respuestas":null}}'
generar "${T}/sc" "${T}/sc.html" "${T}/sc.log"
FV="$(cliente "${T}/sc.html" usage-filter | sed 's/<[^>]*>/ /g')"
grep -q '0 ejecuciones' <<< "${FV}" && grep -q 'casillas' <<< "${FV}" \
  && ok "2.79-T68 filtro vacío por la casilla: «0 ejecuciones» y nombra las casillas" || mal "2.79-T68 filtro vacío por la casilla: ${FV:0:300}"
E="$(estado "2026-10-21T15:00:00Z" "" UTC check "fc,ff")"
U="$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['url'] or '')" "${E}")"
case "${U}" in *sin-consumo=1*llegaron=1*|*llegaron=1*sin-consumo=1*) ok "2.79-T68 las dos casillas viajan en la dirección (${U})";; *) mal "2.79-T68 las casillas no llegaron a la dirección: ${U}";; esac
E="$(estado "2026-10-21T15:00:00Z" "?${U#*\?}" UTC state)"
[ "$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(d['fc'], d['ff'])" "${E}")" = "True True" ] && ok "2.79-T68 al recargar con esa dirección las dos casillas vuelven marcadas" || mal "2.79-T68 al recargar: ${E:0:300}"
# una sola ejecución: el singular, y ninguna frase con cero
F1="$(cliente "${T}/o.html" container fichas; cliente "${T}/o.html" container nota-tokens)"
for frase in '1 ejecuciones' 'de otras 0' 'las 1 ' 'otras 1 ' '(es)'; do
  grep -qF "${frase}" <<< "$(sed 's/<[^>]*>//g' <<< "${F1}")" && mal "2.79-T68 con una sola ejecución dice «${frase}»" || ok "2.79-T68 con una sola ejecución no dice «${frase}»"
done
# ningún texto de la vista lleva el plural a medias «(es)»: con 1 va su clave en singular, la misma con un 1 al final
node -e "const t=require(process.argv[1]); const m=Object.entries(t.TEXTOS||t).filter(([k,v])=>v&&/\(es\)/.test(v.es||'')).map(([k])=>k); if(m.length){console.error(m.join(' '));process.exit(1)}" "${RAIZ}/scripts/nightly/dashboard/runs-texts.js" 2>"${T}.err" \
  && ok "2.79-T68 ningún texto de la vista dice «(es)»" || mal "2.79-T68 textos con «(es)»: $(cat "${T}.err")"
rm -f "${T}.err"
rm -rf "${T}"

# ── T15 · esta suite NO toca los entregables commiteados (gemelo del C-27) ─────────────────────
# 🔴 sale rojo si un caso genera sobre artifacts/ en vez de sobre un temporal.
[ "$(huella "${ENTREGABLE_CORRIDAS}")" = "${HUELLA_CORRIDAS_ANTES}" ] && ok "T15 la suite no escribió artifacts/runs-dashboard.html (no se commitea)" || mal "T15 la suite ESCRIBIÓ artifacts/runs-dashboard.html"
[ "$(huella "${ENTREGABLE_SEIS}")" = "${HUELLA_SEIS_ANTES}" ] && ok "T15 la suite no tocó artifacts/tablero-del-arnes.html" || mal "T15 la suite REESCRIBIÓ artifacts/tablero-del-arnes.html"

rm -f "${FX}" "${CL}"
echo
if [ "${FALLOS}" -eq 0 ]; then echo "todo verde"; exit 0; else echo "${FALLOS} fallo(s)"; exit 1; fi
