#!/usr/bin/env bash
# context-budget.test.sh — el medidor de contexto no cobra esquemas que NO están cargados.
#
# El medidor no puede asumir 500 tokens por herramienta para TODO servidor
# MCP, incluidos los conectores de claude.ai que la cuenta NO tiene autorizados —cuyos esquemas no
# se cargan—: sobre esa cuenta inflada puntuaría 0/10 y recomendaría desconectar cosas.
# Un medidor que infla no es sólo impreciso: recomienda perder algo a cambio de un
# ahorro que no existe, y un 0/10 permanente entrena a ignorar la categoría.
#
# Lo que se afirma acá, y nada más: un conector que figura en `mcp-needs-auth-cache.json` (la lista
# que Claude Code escribe de los servidores que piden autorización) NO se cobra al precio de un
# esquema cargado, y el reporte lo DICE. Cuánto cuesta exactamente un nombre diferido no se midió:
# se cobra un mínimo declarado, no 500.
#
# 🔴 con el cálculo sin esta distinción, los 4 conectores sin autorizar suman 21.500 y
#    el reporte no menciona «sin autorizar».
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }

H=$(mktemp -d)
mkdir -p "$H/.claude"
cat > "$H/.claude/settings.json" <<'JSON'
{ "mcpServers": { "engram": { "command": "engram", "args": ["mcp"] }, "chrome-devtools": { "command": "chrome-devtools-mcp" } } }
JSON
# Los cuatro que la cuenta tiene SIN autorizar (tal cual los escribe Claude Code)
cat > "$H/.claude/mcp-needs-auth-cache.json" <<'JSON'
{ "claude.ai Wix": {"timestamp": 1}, "claude.ai Gamma": {"timestamp": 1}, "claude.ai Gmail": {"timestamp": 1}, "claude.ai Docu de MS": {"timestamp": 1} }
JSON

SALIDA=$(HOME="$H" node "$RAIZ/scripts/tools/context-budget.js" --json 2>/dev/null)
TOT=$(echo "$SALIDA" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('mcps',{}).get('totalTokens') or d.get('mcpTokens') or 0)" 2>/dev/null || echo "?")
WIX=$(echo "$SALIDA" | python3 -c "
import json,sys; d=json.load(sys.stdin)
its=(d.get('mcps') or {}).get('items') or []
w=next((i for i in its if 'Wix' in i.get('name','')), None)
print(json.dumps({'tokens': w and w.get('tokens'), 'sinAutorizar': w and w.get('sinAutorizar')}))" 2>/dev/null || echo "?")

# C-01 · Wix sin autorizar no se cobra a 500/tool (19 tools → 9.500)
echo "$WIX" | grep '"sinAutorizar": true' >/dev/null && ok "C-01 Wix figura como SIN AUTORIZAR (esquemas no cargados)" || mal "C-01 Wix no se marcó como sin autorizar: $WIX"
W_TOK=$(echo "$WIX" | python3 -c "import json,sys; print(json.load(sys.stdin).get('tokens') or 0)" 2>/dev/null || echo 9999)
[ "$W_TOK" -lt 1000 ] 2>/dev/null && ok "C-01 …y se cobra un mínimo ($W_TOK), no 9.500" || mal "C-01 Wix se cobra $W_TOK (la cuenta inflada)"

# C-02 · el total de MCP baja del umbral que pintaba 0/10 (los 2 locales: engram 6.500 + chrome 12.500)
[ "$TOT" != "?" ] && [ "$TOT" -lt 35000 ] && ok "C-02 total MCP = $TOT (< 35.000): la categoría deja de estar en 0/10 por una cuenta inflada" || mal "C-02 total MCP = $TOT"

# C-03 · lo autorizado y local se sigue cobrando entero (no se afloja para todos)
E_TOK=$(echo "$SALIDA" | python3 -c "
import json,sys; d=json.load(sys.stdin)
its=(d.get('mcps') or {}).get('items') or []
print(next((i.get('tokens') for i in its if i.get('name')=='engram'), 0))" 2>/dev/null || echo 0)
[ "$E_TOK" -ge 6000 ] 2>/dev/null && ok "C-03 engram (local, cargado) se sigue cobrando entero ($E_TOK)" || mal "C-03 engram se cobra $E_TOK — el descuento se aplicó de más"

# C-04 · el texto del reporte lo dice
HOME="$H" node "$RAIZ/scripts/tools/context-budget.js" 2>/dev/null | grep -i "sin autorizar" >/dev/null && ok "C-04 el reporte legible dice «sin autorizar»" || mal "C-04 el reporte no distingue lo no autorizado"

# C-05 · harness-audit usa el mismo criterio (tiene su propia copia de la cuenta): su número tiene
# que ser EL MISMO que el de context-budget, y su propio veredicto `passed` tiene que ser verdadero.
# 🔴 El caso compara el número exacto, no una regex (`actual: NN,NNN`) que acepte cualquier
# cifra menor a 100.000: con una copia desactualizada de harness-audit (48.500) seguiría verde, o sea que el
# único caso que cuida la copia no se pondría rojo nunca. Con esa copia: 27.516 ≠ 48.500.
HA=$(HOME="$H" node "$RAIZ/scripts/lib/harness-audit.js" --json 2>/dev/null | python3 -c "
import json,sys,re; d=json.load(sys.stdin)
for cat in d.get('categories',[]):
    for c in cat.get('checks',[]):
        if 'MCP overhead' in c.get('name',''):
            m=re.search(r'actual: ([0-9.,]+)', c.get('name',''))
            print((m.group(1).replace('.','').replace(',','') if m else '?'), 'passed' if c.get('passed') else 'failed')" 2>/dev/null)
HA_N=$(echo "$HA" | awk '{print $1}'); HA_OK=$(echo "$HA" | awk '{print $2}')
if [ "$HA_N" = "$TOT" ] && [ "$HA_OK" = "passed" ]; then
  ok "C-05 harness-audit cuenta lo MISMO que context-budget ($HA_N) y su veredicto es passed"
else
  mal "C-05 harness-audit: $HA_N/$HA_OK contra context-budget $TOT — las dos copias de la cuenta divergen"
fi
rm -rf "$H"

# ── La cadena del CLAUDE.md con sus @imports, y el piso MEDIDO ──────────
# El medidor sigue los `@imports` de `~/.claude/CLAUDE.md`, no sólo el archivo: si no, reporta 4.724 tokens para
# una cadena de 276 KB, con el README del arnés (235.771 bytes ≈ 76 mil tokens) invisible. La herramienta
# con la que se decide qué recortar del arranque tiene que ver el ítem más grande.
# Y su cuenta es una ESTIMACIÓN (chars/4): medido, este contenido tokeniza a 3,08 bytes/token, así
# que subestima ~30 %. Por eso `--measured` pone al lado el piso REAL, leído del primer pedido de cada
# transcripción de subagente.

H2=$(mktemp -d); mkdir -p "$H2/.claude" "$H2/x"
printf '{ "mcpServers": {} }\n' > "$H2/.claude/settings.json"
# la cadena: CLAUDE.md → a.md (relativo) y ~/x/b.md · a.md → b.md OTRA VEZ y uno inexistente
printf 'raíz\n@a.md\n@~/x/b.md\n' > "$H2/.claude/CLAUDE.md"
printf 'hijo\n@b.md\n@no-existe.md\n' > "$H2/.claude/a.md"
head -c 4000 /dev/zero | tr '\0' 'b' > "$H2/x/b.md"
printf 'este de al lado NO se importa\n' > "$H2/.claude/b.md"

J=$(HOME="$H2" node "$RAIZ/scripts/tools/context-budget.js" --json 2>/dev/null)

# C-06 · los @imports se resuelven, se cuentan UNA vez, y un import ausente se dice sin cortar el reporte
LEE=$(echo "$J" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('SIN-JSON'); raise SystemExit
its=(d.get('claudemd') or {}).get('items') or []
bs=[i for i in its if i.get('path','').endswith('/x/b.md') or i.get('path','').endswith('x/b.md')]
falta=[i for i in its if 'no-existe' in i.get('path','')]
print(len(its), len(bs), (bs[0].get('tokens') if bs else 0), len(falta), (falta[0].get('missing') if falta else None), (d.get('claudemd') or {}).get('totalTokens'))" 2>/dev/null)
set -- $LEE
# 🔴 El 5º campo (`missing`) se COMPARA, no sólo se imprime: si `inventoryClaudeMd` dejara de marcar
# el import inexistente (regresión del import), este caso seguiría en VERDE.
if [ "${1:-}" != "SIN-JSON" ] && [ "${2:-0}" = 1 ] && [ "${3:-0}" -ge 900 ] 2>/dev/null && [ "${4:-0}" = 1 ] && [ "${5:-}" = "True" ] && [ "${6:-0}" -ge 1000 ] 2>/dev/null; then
  ok "C-06 la cadena sigue los @imports (b.md una sola vez con ~1.000 tok, el ausente listado Y marcado missing, el total los suma)"
else
  mal "C-06 la cadena NO resuelve los @imports: items=${1:-?} b.md=${2:-?} tok=${3:-?} ausentes=${4:-?} missing=${5:-?} total=${6:-?}"
fi

# C-06b · el reporte legible dice de dónde viene cada archivo importado
HOME="$H2" node "$RAIZ/scripts/tools/context-budget.js" 2>/dev/null | grep -i "import de" >/dev/null \
  && ok "C-06b el reporte legible dice «import de <archivo>»" || mal "C-06b el reporte no distingue lo importado de lo propio"

# C-06c · 🔴 con un import GRANDE, la recomendación se dispara y el reporte NO revienta.
# El fixture chico de C-06 no alcanza: la recomendación sólo entra si el import pasa los 20.000
# tokens, así que el reporte se rompería SÓLO en la máquina real (forma {savings,action,how} contra
# {ahorro,titulo,como}) y la suite seguiría verde. Un fixture que nunca cruza el umbral no prueba el
# camino que importa.
H4=$(mktemp -d); mkdir -p "$H4/.claude"
printf '{ "mcpServers": {} }\n' > "$H4/.claude/settings.json"
printf 'raiz\n@grande.md\n' > "$H4/.claude/CLAUDE.md"
head -c 250000 /dev/zero | tr '\0' 'g' > "$H4/.claude/grande.md"
if SAL=$(HOME="$H4" node "$RAIZ/scripts/tools/context-budget.js" 2>&1) && echo "$SAL" | grep "se importa ENTERO" >/dev/null; then
  ok "C-06c un import de 250 KB sale RECOMENDADO y el reporte se renderiza (no revienta)"
else
  mal "C-06c el reporte falló o no recomienda el import grande: $(echo "$SAL" | tail -3 | tr '\n' ' ')"
fi
rm -rf "$H4"

# C-06d · un @import que resuelve FUERA del home se cuenta igual, pero queda MARCADO (SEC-C7).
# Excluirlo haría que la medición subestime lo que de
# verdad se carga —Claude Code lo carga igual— así que la respuesta correcta es decirlo, no esconderlo.
H5=$(mktemp -d); mkdir -p "$H5/.claude"
printf '{ "mcpServers": {} }\n' > "$H5/.claude/settings.json"
AFUERA=$(mktemp -d); printf 'contenido de afuera del home\n' > "$AFUERA/lejano.md"
printf 'raiz\n@%s/lejano.md\n' "$AFUERA" > "$H5/.claude/CLAUDE.md"
FUERA=$(HOME="$H5" node "$RAIZ/scripts/tools/context-budget.js" --json 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('SIN-JSON'); raise SystemExit
its=(d.get('claudemd') or {}).get('items') or []
f=[i for i in its if 'lejano' in i.get('path','')]
print(len(f), (f[0].get('fueraDeCasa') if f else None), (f[0].get('tokens') if f else 0))" 2>/dev/null)
set -- $FUERA
if [ "${1:-}" = 1 ] && [ "${2:-}" = "True" ] && [ "${3:-0}" -gt 0 ] 2>/dev/null; then
  ok "C-06d un @import fuera del home se cuenta (no se esconde) y queda marcado fueraDeCasa"
else
  mal "C-06d items=${1:-?} fueraDeCasa=${2:-?} tokens=${3:-?} — o no se cuenta, o no se marca"
fi
HOME="$H5" node "$RAIZ/scripts/tools/context-budget.js" 2>/dev/null | grep -i "fuera de" >/dev/null \
  && ok "C-06d2 el reporte legible lo dice" || mal "C-06d2 el reporte no avisa del import de afuera"
rm -rf "$H5" "$AFUERA"

# C-07 · --measured: el piso REAL del primer pedido de cada subagente, por tipo, con los ilegibles aparte
S="$H2/.claude/projects/p/sesion/subagents"; mkdir -p "$S"
turno() { printf '{"type":"assistant","timestamp":"%s","message":{"usage":{"input_tokens":%s,"cache_read_input_tokens":%s,"cache_creation_input_tokens":%s}}}\n' "$1" "$2" "$3" "$4"; }
HOY=$(date -u "+%Y-%m-%dT%H:%M:%SZ")
{ turno "$HOY" 2 0 99998; turno "$HOY" 5 99998 0; } > "$S/agent-a1.jsonl"
printf '{"agentType":"tycon-x"}\n' > "$S/agent-a1.meta.json"
{ turno "$HOY" 0 120000 0; } > "$S/agent-a2.jsonl"
printf '{"agentType":"tycon-x"}\n' > "$S/agent-a2.meta.json"
{ turno "$HOY" 0 0 140000; } > "$S/agent-a3.jsonl"          # sin .meta.json → tipo '?'
printf 'esto no es json\n{{{\n' > "$S/agent-roto.jsonl"       # ilegible → se cuenta, no corta

M=$(HOME="$H2" node "$RAIZ/scripts/tools/context-budget.js" --measured --json 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('SIN-JSON'); raise SystemExit
m=d.get('medido') or {}
pt=m.get('por_tipo') or {}
print(m.get('n'), m.get('mediana'), m.get('min'), m.get('max'), (pt.get('tycon-x') or {}).get('n'), (pt.get('?') or {}).get('n'), m.get('ilegibles'))" 2>/dev/null)
set -- $M
if [ "${1:-}" = 3 ] && [ "${2:-}" = 120000 ] && [ "${3:-}" = 100000 ] && [ "${4:-}" = 140000 ] && [ "${5:-}" = 2 ] && [ "${6:-}" = 1 ] && [ "${7:-}" = 1 ]; then
  ok "C-07 --measured da el piso real (n=3, mediana 120.000, min/max, 2 de tycon-x, 1 sin tipo, 1 ilegible aparte)"
else
  mal "C-07 --measured: n=${1:-?} mediana=${2:-?} min=${3:-?} max=${4:-?} tycon-x=${5:-?} sinTipo=${6:-?} ilegibles=${7:-?}"
fi

# C-07c · 🔴 las transcripciones ANIDADAS también cuentan. Los subagentes lanzados por la tool
# Workflow (los hunters del pase adversarial, por ejemplo) no viven en `subagents/*.jsonl` sino un
# nivel más abajo, en `subagents/workflows/<id>/*.jsonl`. Si `medirPiso` sólo
# mirara los hijos directos, se saltearía EN SILENCIO la mayoría de los lanzamientos reales (el «piso medido» saldría de una
# minoría no aleatoria, sin un solo aviso de «no medido»): el «verde que significa no miré nada». Con el
# recorrido de un nivel, n=1 en vez de 3.
W="$H2/.claude/projects/p/sesion/subagents/workflows/wf_abc"; mkdir -p "$W"
{ turno "$HOY" 0 111000 0; } > "$W/agent-w1.jsonl"
printf '{"agentType":"general-purpose","workflowPhase":"Hunt"}\n' > "$W/agent-w1.meta.json"
{ turno "$HOY" 0 113000 0; } > "$W/agent-w2.jsonl"
printf '{"agentType":"general-purpose"}\n' > "$W/agent-w2.meta.json"
ANID=$(HOME="$H2" node "$RAIZ/scripts/tools/context-budget.js" --measured --json 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('SIN-JSON'); raise SystemExit
m=d.get('medido') or {}; pt=m.get('por_tipo') or {}
print(m.get('n'), (pt.get('general-purpose') or {}).get('n'), m.get('max'))" 2>/dev/null)
set -- $ANID
if [ "${1:-}" = 5 ] && [ "${2:-}" = 2 ] && [ "${3:-}" = 140000 ]; then
  ok "C-07c las transcripciones anidadas en subagents/workflows/<id>/ también cuentan (n=5, 2 de general-purpose)"
else
  mal "C-07c n=${1:-?} general-purpose=${2:-?} max=${3:-?} — se esperaba n=5 y 2 de general-purpose; con el recorrido de un nivel salen 3 y 0"
fi

# C-07c2 · 🔴 un primer pedido con el consumo TODO EN CERO no es un piso de 0: es «no se pudo
# medir». En una máquina real, 120 de 1.372 transcripciones traen
# `input_tokens: 0, cache_read: 0, cache_creation: 0` (agentes que nunca llegaron a pedir nada), y
# entrarían a la muestra arrastrando el mínimo a 0 y la mediana hacia abajo. Un cero publicado como
# medición es lo que el medidor evita: se cuentan aparte, como los ilegibles.
{ turno "$HOY" 0 0 0; } > "$W/agent-w3.jsonl"
printf '{"agentType":"general-purpose"}\n' > "$W/agent-w3.meta.json"
CERO=$(HOME="$H2" node "$RAIZ/scripts/tools/context-budget.js" --measured --json 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('SIN-JSON'); raise SystemExit
m=d.get('medido') or {}; pt=m.get('por_tipo') or {}
print(m.get('n'), m.get('min'), m.get('sin_consumo'), (pt.get('general-purpose') or {}).get('n'))" 2>/dev/null)
set -- $CERO
if [ "${1:-}" = 5 ] && [ "${2:-}" = 100000 ] && [ "${3:-}" = 1 ] && [ "${4:-}" = 2 ]; then
  ok "C-07c2 un primer pedido en cero se cuenta aparte (sin_consumo=1) y NO arrastra el mínimo a 0"
else
  mal "C-07c2 n=${1:-?} min=${2:-?} sin_consumo=${3:-?} general-purpose=${4:-?} — un cero entró a la muestra como si fuera un piso"
fi

# C-07d · el orden del listado por tipo es ESTABLE ante empates: dos tipos con la misma mediana
# tienen que salir siempre en el mismo orden, no en el que devuelva el sistema de archivos. Con más
# de 8 tipos y un empate en el borde del corte, un tipo podría aparecer o desaparecer del top según el orden
# incidental de las carpetas.
ORD=$(HOME="$H2" node -e '
const { medirPiso } = require(process.argv[1]);
const fs = require("fs"), os = require("os"), path = require("path");
// dos HOME con datos IDÉNTICOS y las carpetas que introducen cada tipo intercambiadas
function armar(dir, primero, segundo) {
  for (const [proy, tipo] of [["1-primero", primero], ["2-segundo", segundo]]) {
    const s = path.join(dir, ".claude/projects", proy, "ses", "subagents");
    fs.mkdirSync(s, { recursive: true });
    fs.writeFileSync(path.join(s, "agent-x.jsonl"), JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { usage: { cache_read_input_tokens: 100000 } } }) + "\n");
    fs.writeFileSync(path.join(s, "agent-x.meta.json"), JSON.stringify({ agentType: tipo }));
  }
}
const a = fs.mkdtempSync(path.join(os.tmpdir(), "ord-a")), b = fs.mkdtempSync(path.join(os.tmpdir(), "ord-b"));
armar(a, "ZTIPO", "ATIPO"); armar(b, "ATIPO", "ZTIPO");
const ka = Object.keys(medirPiso({ home: a }).por_tipo), kb = Object.keys(medirPiso({ home: b }).por_tipo);
console.log(JSON.stringify(ka) === JSON.stringify(kb) ? "ESTABLE" : "INESTABLE", ka.join(","), kb.join(","));
' "$RAIZ/scripts/tools/context-budget.js" 2>/dev/null)
case "$ORD" in
  ESTABLE*) ok "C-07d el orden por tipo es estable ante empates ($ORD)";;
  *) mal "C-07d el orden depende del orden de las carpetas: $ORD";;
esac

# C-08 · «no medido» nunca es 0: sin transcripciones, y con transcripciones fuera de la ventana
H3=$(mktemp -d); mkdir -p "$H3/.claude"; printf '{ "mcpServers": {} }\n' > "$H3/.claude/settings.json"; printf 'x\n' > "$H3/.claude/CLAUDE.md"
E=$(HOME="$H3" node "$RAIZ/scripts/tools/context-budget.js" --measured --json 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('SIN-JSON'); raise SystemExit
m=d.get('medido') or {}; print(m.get('estado'), bool(m.get('motivo')), m.get('n'))" 2>/dev/null)
set -- $E
[ "${1:-}" = "no_medido" ] && [ "${2:-}" = "True" ] && [ "${3:-}" != "0" ] \
  && ok "C-08 sin transcripciones: estado no_medido con motivo, NO un 0" || mal "C-08 estado=${1:-?} motivo=${2:-?} n=${3:-?}"
# una transcripción VIEJA: con la ventana por default no entra, y los de hoy sí
{ turno "2020-01-02T03:04:05Z" 0 77000 0; } > "$S/agent-viejo.jsonl"
printf '{"agentType":"tycon-x"}\n' > "$S/agent-viejo.meta.json"
V=$(HOME="$H2" node "$RAIZ/scripts/tools/context-budget.js" --measured --days 1 --json 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin); m=d.get('medido') or {}; print(m.get('n'), 1 if m.get('desde') else 0, m.get('min'))" 2>/dev/null)
set -- $V
# n=5: las 3 de C-07 + las 2 anidadas de C-07c, todas de hoy. La de 2020 queda afuera.
if [ "${1:-}" = 5 ] && [ "${2:-}" = 1 ] && [ "${3:-}" = 100000 ]; then
  ok "C-08b --days acota la ventana: la transcripción de 2020 queda afuera (n=5, min 100.000)"
else
  mal "C-08b la ventana no excluye lo viejo: n=${1:-?} desde=${2:-?} min=${3:-?} (con la vieja adentro el min sería 77.000)"
fi
rm -rf "$H3"

# C-09 · harness-audit usa la MISMA cuenta de la cadena (importada, no copiada) y su chequeo existe
HA=$(HOME="$H2" node "$RAIZ/scripts/lib/harness-audit.js" --json 2>/dev/null | python3 -c "
import json,sys,re
try: d=json.load(sys.stdin)
except Exception: print('SIN-JSON'); raise SystemExit
for cat in d.get('categories',[]):
    for c in cat.get('checks',[]):
        if 'CLAUDE.md' in c.get('name','') and 'imports' in c.get('name','').replace('@',''):
            det=c.get('detail') or {}
            print(det.get('totalTokens'), 'passed' if c.get('passed') else 'failed'); raise SystemExit
print('SIN-CHEQUEO')" 2>/dev/null)
CB=$(echo "$J" | python3 -c "import json,sys; print((json.load(sys.stdin).get('claudemd') or {}).get('totalTokens'))" 2>/dev/null)
if [ "$(echo "$HA" | awk '{print $1}')" = "$CB" ] && [ -n "$CB" ]; then
  ok "C-09 harness-audit cuenta la cadena con el MISMO número que context-budget ($CB) — la importa, no la copia"
else
  mal "C-09 harness-audit: [${HA}] contra context-budget [${CB}]"
fi
rm -rf "$H2"

# ── T17 · R2_Tools_MovedRequiresAndManifests ──────────────────────────────────────
# Las seis utilidades viven en scripts/tools/. Lo que las nombra por ruta tiene que seguirlas, o se rompe en silencio:
# harness-audit las importa y las invoca (su «Catalog Integrity» corre rules-distill.js; si no lo encuentra, la
# categoría entera pasa a un único rojo «no corre» y el resto de la auditoría sigue verde), los manifiestos de la
# publicación las nombran (el `target` de las derivadas y la excepción por archivo del detector), y una excepción que
# apunta a una ruta muerta hace que el detector marque la constante de context-budget.js como si fuera un secreto.
H6=$(mktemp -d); mkdir -p "$H6/.claude"; printf '{ "mcpServers": {} }\n' > "$H6/.claude/settings.json"; printf 'x\n' > "$H6/.claude/CLAUDE.md"
# rules-distill lee los revisores del home: con el home falso se enlazan los reales, sólo para leer (mismo criterio
# que C7 de rules-catalog.test.sh). Sin revisores, rules-distill no corre por eso y el caso lo dice como NO MEDIDO.
T17SK="${TYCON_SKILLS_DIR:-$HOME/.claude/agent-skills/skills}"
T17AG=""
for CAND in "${TYCON_AGENTS_DIR:-}" "${T17SK%/skills}/agents" "$HOME/.claude/agent-skills/agents"; do
  [ -n "$CAND" ] && [ -d "$CAND" ] && { T17AG="$CAND"; break; }
done
[ -n "$T17AG" ] && ln -sfn "$T17AG" "$H6/.claude/agents" && ln -sfn "$(dirname "$T17AG")" "$H6/.claude/agent-skills"
FALTAN=""
for f in context-budget.js lint-wiki.sh release-notes-parity.js rules-distill.js tycon-backfill-followups.js tycon-worktree.sh; do
  [ -f "$RAIZ/scripts/tools/$f" ] || FALTAN="$FALTAN $f"
done
[ -z "$FALTAN" ] && ok "T17 R2_Tools_MovedRequiresAndManifests — las seis viven en scripts/tools/" \
  || mal "T17 R2_Tools_MovedRequiresAndManifests — faltan en scripts/tools/:$FALTAN"
T17HA=$(HOME="$H6" TYCON_NO_NIGHTLY_EXAM=1 node "$RAIZ/scripts/lib/harness-audit.js" --json 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('SIN-JSON'); raise SystemExit
cat=next((c for c in d.get('categories',[]) if c.get('name')=='Catalog Integrity'), None)
if not cat: print('SIN-CATEGORIA'); raise SystemExit
names=[c.get('name','') for c in cat.get('checks',[])]
corre=any(n.startswith('Catalog: 0 BROKEN-REFS') for n in names)
roto=any('rules-distill.js corre OK' in n for n in names)
cadena=next((c.get('name','') for cc in d.get('categories',[]) for c in cc.get('checks',[]) if c.get('name','').startswith('Cadena del CLAUDE.md')), '')
print('CORRE' if corre and not roto else 'NO-CORRE', 'IMPORTA' if cadena and 'NO se pudo medir' not in cadena else 'NO-IMPORTA')" 2>/dev/null)
if [ -z "$T17AG" ]; then
  echo "  NO MEDIDO — T17 harness-audit: sin revisores (agent-skills/agents) rules-distill no corre en ningún lado"
  case "$T17HA" in *" IMPORTA") ok "T17 R2_Tools_MovedRequiresAndManifests — harness-audit --json importa context-budget.js desde scripts/tools/";;
    *) mal "T17 R2_Tools_MovedRequiresAndManifests — harness-audit --json: [$T17HA] (no importa context-budget.js)";; esac
else
  [ "$T17HA" = "CORRE IMPORTA" ] && ok "T17 R2_Tools_MovedRequiresAndManifests — harness-audit --json invoca rules-distill.js e importa context-budget.js desde scripts/tools/" \
    || mal "T17 R2_Tools_MovedRequiresAndManifests — harness-audit --json: [$T17HA] (se esperaba «CORRE IMPORTA»)"
fi
rm -rf "$H6"
# los `target` de las derivadas de este repo nombran archivos que existen (third-party-coverage sólo mide los de
# agent-skills: una derivada de acá con la ruta vieja queda muerta sin que nadie lo diga)
MUERTOS=$(node -e '
const fs = require("fs"), path = require("path");
const m = JSON.parse(fs.readFileSync(path.join(process.argv[1], "scripts/publishing/third-party-skills.json"), "utf8"));
console.log((m.derived || []).filter((d) => d.repo === "tycon-claude-guides" && !fs.existsSync(path.join(process.argv[1], d.target))).map((d) => d.target).join(" "));
' "$RAIZ" 2>&1)
[ -z "$MUERTOS" ] && ok "T17 R2_Tools_MovedRequiresAndManifests — los target de third-party-skills.json existen" \
  || mal "T17 R2_Tools_MovedRequiresAndManifests — target muertos en third-party-skills.json: $MUERTOS"
# third-party-coverage mira la historia de git de agent-skills: una versión bajada (sin .git) no se puede medir
if [ -d "$T17SK" ] && git -C "$T17SK" rev-parse --git-dir >/dev/null 2>&1; then
  TYCON_SKILLS_DIR="$T17SK" node "$RAIZ/scripts/publishing/third-party-coverage.js" >/dev/null 2>&1; RC=$?
  [ "$RC" = 0 ] && ok "T17 R2_Tools_MovedRequiresAndManifests — third-party-coverage.js sale 0" \
    || mal "T17 R2_Tools_MovedRequiresAndManifests — third-party-coverage.js sale $RC"
elif [ -d "$T17SK" ]; then
  echo "  NO MEDIDO — T17 third-party-coverage: $T17SK no es un clon de git (una versión bajada no trae historia)"
else
  echo "  NO MEDIDO — T17 third-party-coverage: no hay agent-skills en $T17SK"
fi
if [ -f "$RAIZ/scripts/publishing/denylist.json" ]; then
  node "$RAIZ/scripts/publishing/detector.js" --config "$RAIZ/scripts/publishing/denylist.json" --base "$RAIZ" "$RAIZ/scripts/tools/context-budget.js" >/dev/null 2>&1; RC=$?
  [ "$RC" = 0 ] && ok "T17 R2_Tools_MovedRequiresAndManifests — el detector no marca scripts/tools/context-budget.js (la excepción sigue al archivo)" \
    || mal "T17 R2_Tools_MovedRequiresAndManifests — el detector sale $RC sobre scripts/tools/context-budget.js (la excepción apunta a otra ruta)"
else
  echo "  NO MEDIDO — T17 detector: copia pública sin la lista de denegación"
fi

echo
if [ "$FALLOS" -gt 0 ]; then echo "FALLARON $FALLOS chequeo(s)"; exit 1; fi
echo "todo verde"; exit 0
