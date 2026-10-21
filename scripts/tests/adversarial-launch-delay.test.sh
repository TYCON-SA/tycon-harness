#!/usr/bin/env bash
# adversarial-launch-delay.test.sh — la medición del pase adversarial lanzado tarde, por horas.
#
# Por qué existe: contar el rótulo `launchedAtStep`, que tipea el agente, da un número falso (en 36 de 86 casos
# estaba mal). La cuenta buena es por horas: flujo lanzado menos primer revisor, mayor a 2 minutos.
#
# Lo que prueba (T15 · LaunchDelay_MeasuredByClock), con cuatro volcados inventados (esta carpeta se publica):
#   · a tiempo                         → no cuenta
#   · tarde, con el temprano prendido  → 1 tarde
#   · tarde, con el temprano apagado   → 1 tarde aparte, como apagada
#   · rotulado «5b» pero a tiempo      → no cuenta (el rótulo no se lee)
#
# Correr: bash scripts/tests/adversarial-launch-delay.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GUION="$AQUI/scripts/metrics/adversarial-launch-delay.js"
fallos=0; pasaron=0
ok(){ echo "✅ lanzamiento-tarde: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ lanzamiento-tarde: $1"; fallos=$((fallos+1)); }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/lanz-tarde-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
HIST="$TMP/timing-history"; PROY="$TMP/projects"
mkdir -p "$HIST" "$PROY"

H(){ echo "2026-10-15T$1:00.000Z"; }
# volcado <archivo> <story> <primer revisor> <lanzado> <paso rotulado> <gate: on|off|none>
volcado(){
  local gate=""
  case "$6" in
    on)  gate=",\"adversarialGate\":{\"run\":true,\"early_launch\":true,\"files\":[\"a.js\"]}" ;;
    off) gate=",\"adversarialGate\":{\"run\":true,\"early_launch\":false,\"early_origin\":\"TYCON_5B_EARLY=0\",\"files\":[\"a.js\"]}" ;;
  esac
  cat > "$HIST/$1" <<EOF
{"marker":{"storyId":"$2","sessionId":"sesion-$2","adversarial":{"launchedAtStep":"$5","runId":"wf-$2","sessionId":"sesion-$2","launchedAt":"$4"}$gate},
 "revisores":{"detalle":[
   {"tipo":"tycon-story-validator","lanzado":"$(H 08:00)"},
   {"tipo":"tycon-plugin-security-basics","lanzado":"$3"},
   {"tipo":"general-purpose","lanzado":"$(H 08:30)"},
   {"tipo":"tycon-ac-coverage-checker","lanzado":"$(H 11:00)"}]}}
EOF
}
volcado a-tiempo.json      A "$(H 10:00)" "$(H 10:01)" 4  on
volcado tarde.json         B "$(H 10:00)" "$(H 10:10)" 4  on
volcado tarde-apagado.json C "$(H 10:00)" "$(H 10:30)" 4  off
volcado rotulado-5b.json   D "$(H 10:00)" "$(H 09:59)" 5b none
echo '{"marker":{"storyId":"E"}}' > "$HIST/sin-pase.json"
# tarde y sin anotación del portón, ni hilo: «no se sabe»
volcado no-se-sabe.json    G "$(H 10:00)" "$(H 10:20)" 4  none
# tarde, sin anotación del portón, con el hilo guardado al lado: la señal de respaldo es el resultado del portón
volcado hilo-apagado.json  K "$(H 10:00)" "$(H 10:20)" 4  none
printf '%s\n' '{"type":"user","message":{"content":[{"type":"tool_result","content":"{\n  \"run\": true,\n  \"early_launch\": false\n}"}]}}' \
  | gzip -c > "$HIST/hilo-apagado.hilo.jsonl.gz"
# un volcado que es JSON válido pero no un objeto : se cuenta como
# ilegible y el informe sale igual, con las demás corridas
echo 'null' > "$HIST/nulo.json"

OUTPUT="$(node "$GUION" --history-dir "$HIST" --projects-dir "$PROY" --json 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "sale 0 (un volcado null no aborta el informe)" || no "salió $rc: $OUTPUT"
campo(){ OUTPUT="$OUTPUT" node -e 'const r = JSON.parse(process.env.OUTPUT); process.stdout.write(String(r[process.argv[1]]));' "$1" 2>/dev/null; }

[ "$(campo con_pase)" = "6" ] && ok "cuenta las 6 corridas con pase (ni la sin pase ni la ilegible)" || no "con_pase = $(campo con_pase)"
[ "$(campo ilegibles)" = "1" ] && ok "el volcado null cuenta como ilegible" || no "ilegibles = $(campo ilegibles)"
[ "$(campo tardias)" = "4" ] && ok "cuatro tardías por horas" || no "tardias = $(campo tardias)"
[ "$(campo tardias_con_temprano_prendido)" = "1" ] && ok "1 tarde con el temprano prendido" || no "prendido = $(campo tardias_con_temprano_prendido)"
[ "$(campo tardias_con_temprano_apagado)" = "2" ] && ok "2 tardes con el temprano apagado, aparte (una por la anotación, otra por el hilo)" || no "apagado = $(campo tardias_con_temprano_apagado)"
[ "$(campo tardias_no_se_sabe)" = "1" ] && ok "1 «no se sabe», contada aparte" || no "no_se_sabe = $(campo tardias_no_se_sabe)"
K_APAGADO="$(OUTPUT="$OUTPUT" node -e 'const r = JSON.parse(process.env.OUTPUT); const d = r.detalle.find((x) => x.story === "K"); process.stdout.write(String(d && d.apagado));')"
[ "$K_APAGADO" = "true" ] && ok "sin anotación, el apagado sale del resultado del portón en el hilo guardado" || no "K apagado = $K_APAGADO"
D_TARDE="$(OUTPUT="$OUTPUT" node -e 'const r = JSON.parse(process.env.OUTPUT); const d = r.detalle.find((x) => x.story === "D"); process.stdout.write(String(d && d.tarde));')"
[ "$D_TARDE" = "false" ] && ok "el rotulado «5b» a tiempo no cuenta como tarde (el rótulo no se lee)" || no "D tarde = $D_TARDE"
B_DEMORA="$(OUTPUT="$OUTPUT" node -e 'const r = JSON.parse(process.env.OUTPUT); const d = r.detalle.find((x) => x.story === "B"); process.stdout.write(String(d && d.demora_ms));')"
[ "$B_DEMORA" = "600000" ] && ok "el primer revisor es el del arnés más temprano, sin el validador ni un agente suelto" || no "B demora = $B_DEMORA"

TEXTO="$(node "$GUION" --history-dir "$HIST" --projects-dir "$PROY" 2>&1)"
case "$TEXTO" in
  *"con el temprano apagado: 2"*"no se sabe: 1"*) ok "la salida de texto separa las apagadas y las que no se sabe" ;;
  *) no "texto: $TEXTO" ;;
esac

echo "— $pasaron ok · $fallos fallos"
[ "$fallos" -eq 0 ]
