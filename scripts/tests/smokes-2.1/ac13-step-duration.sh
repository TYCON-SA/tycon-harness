#!/usr/bin/env bash
# AC 13 · el paso del nocturno imprime su duración, y la story no le sumó pasos ni clones.
# Se EJECUTA el cronómetro real extraído del YAML (las líneas que esta story agregó), con el
# medidor apuntado a un repo de verdad. Las macros de Azure no se pueden resolver fuera del
# servidor, así que se sustituye SÓLO la invocación: el cronómetro y el `echo` son textuales.
set -uo pipefail
RAIZ="$1"; MEDIDOR="$2"; REPO_REAL="$3"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

python3 - "$RAIZ" "$MEDIDOR" "$REPO_REAL" > "$T/paso.sh" <<'PY'
import sys
raiz, medidor, repo = sys.argv[1], sys.argv[2], sys.argv[3]
y = open(f'{raiz}/pipelines/azure-pipelines.yml', encoding='utf8').read()
i = y.index('INICIO=$(date +%s)')
j = y.index('displayName:', i)
salida, saltando = [], False
for linea in y[i:j].splitlines():
    l = linea.strip()
    if not l or l.startswith('#'):
        continue
    if l.startswith('node scripts/metrics'):
        salida.append(f"node '{medidor}' --repo '{repo}' --json > /dev/null")
        saltando = l.endswith('\\')
        continue
    if saltando:                      # continuaciones del comando original
        saltando = l.endswith('\\')
        continue
    salida.append(l)
print('\n'.join(salida))
PY

grep -q 'INICIO=' "$T/paso.sh" && grep -q 'FIN=' "$T/paso.sh" \
  || { echo "🛑 el cronómetro no se pudo extraer del YAML"; cat "$T/paso.sh"; exit 1; }

bash "$T/paso.sh" | tee "$T/paso.out"
grep -qE '⏱ .*medición.*: [0-9]+ s' "$T/paso.out" \
  || { echo "🛑 el paso no imprimió su duración"; exit 1; }

# story 8.12 (tanda R6): el yml pasó a pipelines/. Hasta el merge, origin/main lo tiene en su ruta de antes: se compara
# contra la nueva si ya está publicada; si no, contra la vieja armada DESDE EL MAPA (nunca escrita acá), diciéndolo.
NUEVA=pipelines/azure-pipelines.yml
if git -C "$RAIZ" cat-file -e "origin/main:$NUEVA" 2>/dev/null; then
  PUB="$NUEVA"
else
  [ -f "$RAIZ/scripts/lib/renames.json" ] || { echo "∅ NO MEDIDO — copia pública sin el mapa: no sé dónde estaba el nocturno en origin/main"; exit 2; }
  PUB=$(node -e 'try { const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const e = m.entries.find((x) => x && x.kind === "file" && x.new === process.argv[2]); if (e) console.log(e.old); } catch (_) {}' \
    "$RAIZ/scripts/lib/renames.json" "$NUEVA")
  { [ -n "$PUB" ] && git -C "$RAIZ" cat-file -e "origin/main:$PUB" 2>/dev/null; } \
    || { echo "🛑 no encontré el nocturno en origin/main, ni en $NUEVA ni en su ruta de antes"; exit 1; }
  echo "(origin/main todavía tiene $NUEVA en su ruta de antes, $PUB: se compara contra esa)"
fi
git -C "$RAIZ" show "origin/main:$PUB" > "$T/publicado.yml" || { echo "🛑 no pude leer $PUB de origin/main"; exit 1; }
AGREGA="$(git diff --no-index -- "$T/publicado.yml" "$RAIZ/$NUEVA" | grep -cE '^\+.*(git clone|- script:)' || true)"
[ "${AGREGA:-0}" = "0" ] \
  || { echo "🛑 la story agregó $AGREGA paso(s) o clon(es) al nocturno"; exit 1; }
echo "el paso imprime su duración y no sumó pasos ni clones"
