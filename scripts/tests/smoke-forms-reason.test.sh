#!/usr/bin/env bash
# smoke-forms-reason.test.sh — cuando un formulario no pasa el humo, smoke-forms.sh dice POR QUÉ.
#
# Un humo de formularios que dice «falló» y nada más obliga a averiguar a mano si lo rompió el host de pruebas
# (por ejemplo, con su circuit breaker abierto). Por eso cada falla al consultar el host muestra el código HTTP y un
# recorte del cuerpo, con lo que parezca una llave tapado, y una línea que dice si parece del host o nuestro.
#
# A diferencia de smoke.test.sh (un `curl` de mentira), acá el host es un servidor de verdad en 127.0.0.1 y el `curl`
# es el real: se prueban las opciones con que el humo lo llama. Sólo `sleep` es de mentira, así los reintentos no
# esperan. Casos:
#   R1 · la lista contesta 503 con un cuerpo de breaker (que además trae un token, una llave y un `##vso[`): el motivo
#        («circuit breaker», «parece del host», HTTP 503) aparece; el token y la llave no; el `##vso[` del host no
#        arma una orden; el código de salida sigue siendo 1.
#   R2 · la lista bien y el código de un formulario 404: «parece nuestro», HTTP 404 y el cuerpo; sale 1.
#   R3 · la lista tarda más que el tope (SMOKE_FORMS_MAX_TIME=1): «tiempo agotado», «parece del host»; sale 1.
#   R0 · el host bien: sale 0 y no habla de respuestas del host (el camino verde queda igual).
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HF="$RAIZ/scripts/ci/smoke-forms.sh"
fallos=0; ok(){ echo "  ok   — $1"; }; mal(){ echo "  MAL  — $1"; fallos=$((fallos+1)); }
for req in jq unzip zip curl node; do command -v "$req" >/dev/null || { echo "⚠️ smoke-forms-reason: falta $req — suite salteada (no es verde)"; exit 0; }; done
T="$(mktemp -d)"; PID=""
trap '[ -n "$PID" ] && kill "$PID" 2>/dev/null; rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/zips"
printf '#!/usr/bin/env bash\nexit 0\n' > "$T/bin/sleep"; chmod +x "$T/bin/sleep"

# un formulario de juguete en su paquete
( cd "$T" && jq -nc '{commitHash:"abc1234", forms:[{formName:"acme-catalogo",version:"1.0.2"}]}' > manifest.json \
  && zip -q "$T/zips/acme-catalogo.zip" manifest.json ) || { echo "❌ smoke-forms-reason: no pude armar el paquete"; exit 1; }

# el token que da el login: largo, como uno de verdad, para ver que no sale en la salida
# (se arman al correr: escritos tal cual parecerían un secreto de verdad y el freno de publicación los frena)
FALSO_TOKEN="falso$(printf '%036d' 7)"
FALSA_LLAVE="otra$(printf '%036d' 9)"
cat > "$T/host.js" <<'JS'
const http = require('http');
const fs = require('fs');
const [modeFile, portFile, token, key] = process.argv.slice(2);
const mode = () => { try { return fs.readFileSync(modeFile, 'utf8').trim(); } catch (_) { return 'ok'; } };
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
const server = http.createServer((req, res) => {
  const m = mode();
  if (req.url === '/api/auth/login') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `admin_token=${token}; Path=/` });
    return res.end('{}');
  }
  if (req.url === '/api/custom-forms') {
    if (m === 'breaker') {
      return send(res, 503, JSON.stringify({ error: 'Service Unavailable: circuit breaker is open for BizuitDashboardAPI',
        token, apiKey: key, hint: '##vso[task.setvariable variable=x]y' }));
    }
    if (m === 'slow') return setTimeout(() => send(res, 200, '[]'), 4000);
    return send(res, 200, JSON.stringify([{ formName: 'acme-catalogo', currentVersion: '1.0.2' }]));
  }
  if (req.url === '/api/custom-forms/acme-catalogo/code') {
    if (m === 'notfound') return send(res, 404, JSON.stringify({ error: 'Form not found: acme-catalogo' }));
    return send(res, 200, 'export default 1;\n', 'text/javascript');
  }
  return send(res, 404, 'no');
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, String(server.address().port)));
JS
node "$T/host.js" "$T/mode" "$T/port" "$FALSO_TOKEN" "$FALSA_LLAVE" & PID=$!; disown "$PID" 2>/dev/null || true
for _ in $(seq 1 50); do [ -s "$T/port" ] && break; /bin/sleep 0.1; done
[ -s "$T/port" ] || { echo "❌ smoke-forms-reason: el host de mentira no arrancó"; exit 1; }
URL="http://127.0.0.1:$(cat "$T/port")"

humo() { # humo <modo> → corre el humo; deja la salida en $T/out y el código en $RC
  printf '%s' "$1" > "$T/mode"
  PATH="$T/bin:$PATH" bash "$HF" "$URL" usuario-de-prueba "clave-de-prueba-larga" "$T/zips" > "$T/out" 2>&1; RC=$?
}
tiene() { grep -qF -- "$1" "$T/out"; }

echo "▸ R0 · host bien"
humo ok
[ "$RC" = 0 ] && ok "R0 sale 0" || mal "R0 salió $RC: $(tail -3 "$T/out")"
tiene "respuesta del host" && mal "R0 habló de la respuesta del host en el camino verde" || ok "R0 el camino verde no cambió"

echo "▸ R1 · la lista contesta 503 con el breaker abierto"
SMOKE_FORMS_MAX_TIME="" humo breaker
[ "$RC" = 1 ] && ok "R1 sale 1, como hoy" || mal "R1 salió $RC"
tiene "HTTP 503" && ok "R1 dice el código HTTP" || mal "R1 sin el código: $(cat "$T/out")"
tiene "circuit breaker is open" && ok "R1 muestra el cuerpo recortado" || mal "R1 sin el cuerpo: $(cat "$T/out")"
tiene "parece del host: tiene el circuit breaker abierto" && ok "R1 dice que parece del host (breaker)" || mal "R1 sin la línea de quién: $(cat "$T/out")"
tiene "$FALSO_TOKEN" && mal "R1 el token del login salió en la salida" || ok "R1 el token no sale"
tiene "$FALSA_LLAVE" && mal "R1 la llave del cuerpo salió en la salida" || ok "R1 la llave no sale"
tiene "[tapado]" && ok "R1 lo tapado se ve como [tapado]" || mal "R1 no tapó nada: $(cat "$T/out")"
grep -q '##vso\[task.setvariable' "$T/out" && mal "R1 el ##vso[ del host armó una orden" || ok "R1 el ##vso[ del host no arma una orden"

echo "▸ R2 · el código del formulario contesta 404"
humo notfound
[ "$RC" = 1 ] && ok "R2 sale 1, como hoy" || mal "R2 salió $RC"
tiene "HTTP 404" && ok "R2 dice el código HTTP" || mal "R2 sin el código: $(cat "$T/out")"
tiene "Form not found" && ok "R2 muestra el cuerpo" || mal "R2 sin el cuerpo: $(cat "$T/out")"
tiene "parece nuestro" && ok "R2 dice que parece nuestro" || mal "R2 sin la línea de quién: $(cat "$T/out")"

echo "▸ R3 · la lista tarda más que el tope"
printf 'slow' > "$T/mode"
PATH="$T/bin:$PATH" SMOKE_FORMS_MAX_TIME=1 bash "$HF" "$URL" usuario-de-prueba "clave-de-prueba-larga" "$T/zips" > "$T/out" 2>&1; RC=$?
[ "$RC" = 1 ] && ok "R3 sale 1, como hoy" || mal "R3 salió $RC"
tiene "tiempo agotado" && ok "R3 dice tiempo agotado" || mal "R3 sin tiempo agotado: $(cat "$T/out")"
tiene "parece del host" && ok "R3 dice que parece del host" || mal "R3 sin la línea de quién: $(cat "$T/out")"

echo "─────────────"
[ "$fallos" -eq 0 ] && { echo "✅ smoke-forms-reason: todo verde"; exit 0; } || { echo "❌ smoke-forms-reason: $fallos fallo(s)"; exit 1; }
