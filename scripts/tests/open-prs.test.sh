#!/usr/bin/env bash
# open-prs.test.sh — red de scripts/nightly/open-prs/open-prs.js (story 4.6).
#
# El caso que la motiva: un pull request del backend de un producto del equipo quedó 13 días abierto con auto-completar,
# esperando un verde que nunca iba a llegar, y nadie se enteró. La sección que arma este guion va
# al final del resumen diario de Telegram. Los casos giran alrededor de las formas de mentir sin un
# solo error:
#   · un «ninguno» cuando en realidad Azure no contestó (no medido no es cero);
#   · perder los PR de la página 2 (el endpoint corta en 101 sin avisar);
#   · listar los borradores y los PR de las colas del arnés, que ya tienen su rubro;
#   · un listado tan largo que nadie lo lee.
#
# 🔴 NINGÚN CASO TOCA LA RED: Azure es `scripts/tests/lib/fake-az.sh` (TYCON_ADO_CMD), con las
# respuestas en $FIXAZ.
#
# Rojo previo (declarado): el guion nace en esta story; sin él, toda la suite sale roja.
#
# Correr: bash scripts/tests/open-prs.test.sh   (~2 s)

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GUION="$RAIZ/scripts/nightly/open-prs/open-prs.js"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# Como las demás suites: el doble se copia y se hace ejecutable (en el repo no tiene el bit).
DOBLE="$TMP/az"; cp "$RAIZ/scripts/tests/lib/fake-az.sh" "$DOBLE"; chmod +x "$DOBLE"

FALLOS=0; TOTAL=0
ok() { TOTAL=$((TOTAL+1)); echo "✅ prs-abiertos: $1"; }
no() { TOTAL=$((TOTAL+1)); FALLOS=$((FALLOS+1)); echo "❌ prs-abiertos: $1"; }

HOY=2026-09-20

# prs <dir> <skip> <spec>…  — escribe la página `prs-<skip>.json` con la forma medida el 2026-09-17.
# spec = id:dias[:draft|:rama=<ref>|:autor=<x>|:repo=<x>|:proy=<x>|:fecha=<texto>|:fecha=AUSENTE]  (sin «:» en los valores)
prs() {
  local D="$1" SKIP="$2"; shift 2
  node -e '
const [arch, hoy, ...specs] = process.argv.slice(1);
const value = specs.map((s) => {
  const [id, dias, ...extra] = s.split(":");
  const creado = new Date(Date.parse(hoy + "T10:00:00Z") - Number(dias) * 864e5).toISOString();
  const opt = (k, def) => { const e = extra.find((x) => x.startsWith(k + "=")); return e === undefined ? def : e.slice(k.length + 1); };
  const rama = opt("rama", "refs/heads/feature/x");
  const fecha = opt("fecha", null);
  const pr = { pullRequestId: Number(id), creationDate: fecha === null ? creado : fecha, isDraft: extra.includes("draft"), sourceRefName: rama,
    status: "active", title: "titulo " + id, createdBy: { displayName: opt("autor", "Autor " + id) },
    repository: { name: opt("repo", "Repo" + id), project: { name: opt("proy", "Proy" + id) } } };
  if (fecha === "AUSENTE") delete pr.creationDate;
  return pr;
});
require("fs").writeFileSync(arch, JSON.stringify({ count: value.length, value }, null, 2));' "$D/fixaz/prs-$SKIP.json" "$HOY" "$@"
}
mundo() { rm -rf "$1"; mkdir -p "$1/fixaz"; }
# correr <dir> [args…] → exit code; stdout+stderr en <dir>/out.txt, sección en <dir>/seccion.txt
correr() {
  local D="$1"; shift
  FIXAZ="$D/fixaz" TYCON_ADO_CMD="$DOBLE" node "$GUION" --today "$HOY" --org https://dev.azure.com/prueba \
    --out "$D/seccion.txt" "$@" > "$D/out.txt" 2>&1
  echo $?
}

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T1 (AC 1) lista_los_de_mas_de_dos_dias
D="$TMP/t1"; mundo "$D"; prs "$D" 0 101:1 102:3 103:12
RC=$(correr "$D")
ESPERADO=$'PR abiertos hace más de 2 días: 2\n#102 Proy102/Repo102 — Autor 102 — 3 días\n#103 Proy103/Repo103 — Autor 103 — 12 días'
# el detalle sale por stdout (el registro del pipeline); el archivo que va al aviso lleva sólo la cantidad
[ "$RC" = 0 ] && [ "$(cat "$D/out.txt" 2>/dev/null)" = "$ESPERADO" ] && [ "$(cat "$D/seccion.txt")" = "PR abiertos hace más de 2 días: 2" ] \
  && ok "T1 salen los de 3 y 12 días, del más nuevo al más viejo, con el total arriba (por stdout); el archivo, sólo la cantidad" \
  || no "T1 rc=$RC · sección: $(cat "$D/seccion.txt" 2>/dev/null) · $(head -c 300 "$D/out.txt")"
grep -qF "#102 Proy102/Repo102" "$D/out.txt" && ok "T1 la sección también sale por stdout" || no "T1 stdout sin la sección: $(head -c 300 "$D/out.txt")"

# T2 (AC 1) excluye_borradores_y_colas_del_arnes
D="$TMP/t2"; mundo "$D"
prs "$D" 0 201:10:draft 202:10:rama=refs/heads/vigilante/2026-09-05-fresno-x 203:10:rama=refs/heads/dependencias/d7b4a316 204:5
RC=$(correr "$D")
[ "$RC" = 0 ] && [ "$(cat "$D/out.txt" 2>/dev/null)" = $'PR abiertos hace más de 2 días: 1\n#204 Proy204/Repo204 — Autor 204 — 5 días' ] && [ "$(cat "$D/seccion.txt")" = "PR abiertos hace más de 2 días: 1" ] \
  && ok "T2 el borrador y los PR de vigilante/ y dependencias/ no salen" \
  || no "T2 rc=$RC · $(cat "$D/seccion.txt" 2>/dev/null) · $(head -c 300 "$D/out.txt")"

# T3 (AC 2) pagina_hasta_pagina_incompleta
D="$TMP/t3"; mundo "$D"
SPECS=(); for i in $(seq 1000 1099); do SPECS+=("$i:5"); done
prs "$D" 0 "${SPECS[@]}"; prs "$D" 100 2000:5 2001:5 2002:5
RC=$(correr "$D")
SKIPS=$(grep '^prs' "$D/fixaz/llamadas.log" 2>/dev/null | grep -o '\$skip=[0-9]*' | tr '\n' ' ')
[ "$RC" = 0 ] && [ "$(head -1 "$D/seccion.txt" 2>/dev/null)" = "PR abiertos hace más de 2 días: 103" ] && [ "$SKIPS" = '$skip=0 $skip=100 ' ] \
  && ok "T3 pide la página 2 (\$skip=100), para en la incompleta y cuenta los 103" \
  || no "T3 rc=$RC · pedidos: [$SKIPS] · $(head -1 "$D/seccion.txt" 2>/dev/null) · $(head -c 300 "$D/out.txt")"
grep '^prs' "$D/fixaz/llamadas.log" 2>/dev/null | head -1 | grep '\$top=100' >/dev/null && grep -q 'searchCriteria.status=active' "$D/fixaz/llamadas.log" \
  && ok "T3 cada página pide \$top=100 y sólo los activos" || no "T3 la consulta no pide \$top=100 / status=active"

# T4 (AC 3) consulta_fallida_no_es_cero
for SAB in FAIL GARBAGE; do
  D="$TMP/t4-$SAB"; mundo "$D"; prs "$D" 0 401:9
  RC=$(export "TYCON_AZ_$SAB=prs"; correr "$D")
  SEC=$(head -1 "$D/out.txt" 2>/dev/null)
  [ "$RC" != 0 ] && [[ "$SEC" == "PR abiertos: no se pudo consultar ("*")" ]] && ! grep -qi 'ninguno' "$D/out.txt" "$D/seccion.txt" \
    && [ "$(cat "$D/seccion.txt")" = "PR abiertos hace más de 2 días: ? (no se pudo consultar)" ] \
    && ok "T4 con az $SAB: sale ≠ 0, el registro dice «no se pudo consultar (motivo)», el archivo «?» sin el motivo, y nunca «ninguno»" \
    || no "T4 $SAB rc=$RC · sección: [$SEC] · $(head -c 300 "$D/out.txt")"
done

# T5 (AC 4) sin_trabados_una_linea
D="$TMP/t5"; mundo "$D"; prs "$D" 0 501:0 502:1 503:2
RC=$(correr "$D")
[ "$RC" = 0 ] && [ "$(cat "$D/out.txt" 2>/dev/null)" = "PR abiertos hace más de 2 días: ninguno" ] && [ "$(cat "$D/seccion.txt")" = "PR abiertos hace más de 2 días: 0" ] \
  && ok "T5 con todos recientes (0, 1 y 2 días) la sección es una línea: ninguno" \
  || no "T5 rc=$RC · [$(cat "$D/seccion.txt" 2>/dev/null)] · $(head -c 300 "$D/out.txt")"
D="$TMP/t5b"; mundo "$D"; prs "$D" 0 511:3
RC=$(correr "$D" --days 5)
[ "$RC" = 0 ] && [ "$(cat "$D/out.txt" 2>/dev/null)" = "PR abiertos hace más de 5 días: ninguno" ] && [ "$(cat "$D/seccion.txt")" = "PR abiertos hace más de 5 días: 0" ] \
  && ok "T5 --days cambia el umbral y el texto" || no "T5 --days: rc=$RC · [$(cat "$D/seccion.txt" 2>/dev/null)]"

# T6 (AC 1) tope_de_diez_lineas
D="$TMP/t6"; mundo "$D"
SPECS=(); for d in $(seq 3 16); do SPECS+=("$((600 + d)):$d"); done
prs "$D" 0 "${SPECS[@]}"
RC=$(correr "$D")
SEC="$D/out.txt"
[ "$RC" = 0 ] && [ "$(grep -c . "$SEC" 2>/dev/null)" = 12 ] && [ "$(head -1 "$SEC")" = "PR abiertos hace más de 2 días: 14" ] \
  && [ "$(tail -1 "$SEC")" = "(+4 más)" ] && grep -q '^#612 .* — 12 días$' "$SEC" && ! grep -q '— 13 días' "$SEC" \
  && ok "T6 14 viejos: el total, los 10 más nuevos y «(+4 más)» — los más viejos quedan afuera" \
  || no "T6 rc=$RC · $(tr '\n' '|' < "$SEC" 2>/dev/null)"

# T7 (SEC-C5, iter 2) nombres_hostiles_no_llegan_como_comando — Azure interpreta `##vso[` y `##[` en cualquier
# línea de stdout: un display name o un nombre de repo no pueden fijar variables ni marcar errores en la corrida.
D="$TMP/t7"; mundo "$D"
prs "$D" 0 '701:9:autor=Eve ##vso[task.setvariable variable=PWN]si' '702:8:repo=##[error]repo' '703:7:proy=P##vso[task.complete result=Failed]'
RC=$(correr "$D")
[ "$RC" = 0 ] && ! grep -qE '##(vso)?\[' "$D/out.txt" "$D/seccion.txt" && [ "$(grep -c '^#70' "$D/out.txt")" = 3 ] \
  && ok "T7 ningún «##vso[» ni «##[» llega a stdout ni a la sección, y los tres PR siguen listados" \
  || no "T7 rc=$RC · $(tr '\n' '|' < "$D/seccion.txt" 2>/dev/null)"

# T8 (adversarial ADV-2, iter 2) fecha_ilegible_no_desaparece — un PR sin fecha legible no puede ser invisible
D="$TMP/t8"; mundo "$D"; prs "$D" 0 801:9 802:9:fecha=AUSENTE 803:9:fecha=no-es-fecha
RC=$(correr "$D")
[ "$RC" = 0 ] && [ "$(tail -1 "$D/out.txt" 2>/dev/null)" = "(2 PR sin fecha legible: no se pudo medir su antigüedad)" ] && grep -q '^#801 ' "$D/out.txt" \
  && ok "T8 dos PR sin fecha legible salen contados al final, y el que sí tiene fecha se lista" \
  || no "T8 rc=$RC · $(tr '\n' '|' < "$D/seccion.txt" 2>/dev/null)"
D="$TMP/t8b"; mundo "$D"; prs "$D" 0 811:1 812:9:fecha=AUSENTE
RC=$(correr "$D")
[ "$RC" = 0 ] && [ "$(cat "$D/out.txt" 2>/dev/null)" = $'PR abiertos hace más de 2 días: ninguno\n(1 PR sin fecha legible: no se pudo medir su antigüedad)' ] \
  && ok "T8 «ninguno» no esconde a los que no se pudieron medir" || no "T8b rc=$RC · $(tr '\n' '|' < "$D/seccion.txt" 2>/dev/null)"
# la línea del aviso tampoco los esconde — «0» donde no se midió sería mentira
[ "$(cat "$D/seccion.txt")" = "PR abiertos hace más de 2 días: 0 (+1 sin fecha legible)" ] \
  && ok "2.30-T24b la línea del aviso cuenta aparte los PR sin fecha legible" || no "2.30-T24b línea: [$(cat "$D/seccion.txt")]"

# T9 (TEST-W4, iter 2; story 8.3) org_por_defecto — sin --org usa `ado.org` de la configuración del arnés (acá, por variable),
#    no el default de `az devops configure` ni el repos.json de la operación interna
D="$TMP/t9"; mundo "$D"; prs "$D" 0 901:1
ORG=https://dev.azure.com/configurada
FIXAZ="$D/fixaz" TYCON_ADO_CMD="$DOBLE" TYCON_ADO_ORG="$ORG" node "$GUION" --today "$HOY" --out "$D/seccion.txt" > "$D/out.txt" 2>&1; RC=$?
[ "$RC" = 0 ] && grep '^prs' "$D/fixaz/llamadas.log" | grep -F "\"--org\",\"$ORG\"" >/dev/null \
  && ok "T9 sin --org pregunta a la organización de la configuración del arnés ($ORG)" || no "T9 rc=$RC · $(head -c 300 "$D/out.txt")"

# T10 (story 8.3, AC 10) — sin --org y sin organización configurada (HOME vacía, sin perfil): Azure DevOps está APAGADA:
#    la sección lo dice, el guion sale 0 y NO consulta nada. Nunca «ninguno» sin haber mirado.
D="$TMP/t10"; mundo "$D"; mkdir -p "$D/casa"
FIXAZ="$D/fixaz" TYCON_ADO_CMD="$DOBLE" HOME="$D/casa" TYCON_PROFILE=0 node "$GUION" --today "$HOY" --out "$D/seccion.txt" > "$D/out.txt" 2>&1; RC=$?
if [ "$RC" = 0 ] && grep -qi 'Azure DevOps apagad' "$D/out.txt" && ! grep -qiE 'ninguno|: 0$' "$D/out.txt" "$D/seccion.txt" && [ "$(cat "$D/seccion.txt")" = "PR abiertos hace más de 2 días: ? (Azure DevOps apagado)" ] && [ ! -s "$D/fixaz/llamadas.log" ]; then
  ok "T10 sin organización configurada: «Azure DevOps apagado», exit 0, y no se consulta Azure"
else no "T10 rc=$RC · sección: $(tr '\n' '|' < "$D/seccion.txt" 2>/dev/null) · llamadas: $(wc -l < "$D/fixaz/llamadas.log" 2>/dev/null)"; fi

# T26 (story 2.23, AC 16) OpenPrs_JsonConAutorSinTitulo — `--json <archivo>` deja, por PR, número, proyecto, repo, días, la
#    identidad única del autor y el enlace: NUNCA el título ni el nombre para mostrar (los lee el sitio de la organización).
#    Con az fallando, el archivo dice `no_medido` con su motivo y el guion sale 1.
#    🔴 rojo previo: sin --json no había archivo; volcar el PR entero traería el título.
D="$TMP/t26"; mundo "$D"
node -e '
const hoy = Date.parse(process.argv[2] + "T10:00:00Z");
const pr = (id, dias, unico, extra = {}) => ({ pullRequestId: id, creationDate: new Date(hoy - dias * 864e5).toISOString(), isDraft: false, sourceRefName: "refs/heads/f",
  title: "TITULO-SECRETO-" + id, createdBy: { displayName: "NOMBRE-VISIBLE-" + id, uniqueName: unico }, repository: { name: "Repo X", project: { name: "Proyecto X" } }, ...extra });
// el 262 viene dos veces: el paginado sobre una lista viva puede repetir un PR entre dos páginas (pase adversarial 2.23)
const value = [pr(261, 1, "Dev.A@Acme.Example"), pr(262, 5, "dev.b@acme.example"), pr(263, 9, "dev.a@acme.example"), pr(264, 3, "x@acme.example", { isDraft: true }), pr(262, 5, "dev.b@acme.example")];
require("fs").writeFileSync(process.argv[1], JSON.stringify({ count: value.length, value }));' "$D/fixaz/prs-0.json" "$HOY"
RC=$(correr "$D" --json "$D/prs.json")
if [ "$RC" = 0 ] && node -e '
const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const txt = JSON.stringify(d);
const ok = d.estado === "medido" && d.fecha === process.argv[2] && Array.isArray(d.prs) && d.prs.length === 3
  && d.prs.every((p) => Object.keys(p).sort().join() === "autor,dias,enlace,numero,proyecto,repo")
  && d.prs.find((p) => p.numero === 261).autor === "dev.a@acme.example" && d.prs.find((p) => p.numero === 262).dias === 5
  && /^https:\/\/dev\.azure\.com\/prueba\/Proyecto%20X\/_git\/Repo%20X\/pullrequest\/263$/.test(d.prs.find((p) => p.numero === 263).enlace)
  && !/TITULO-SECRETO|NOMBRE-VISIBLE/.test(txt);
process.exit(ok ? 0 : 1);' "$D/prs.json" "$HOY"; then
  ok "T26 --json: número, proyecto, repo, días, autor (identidad única, en minúsculas) y enlace; sin título ni nombre; sin borradores"
else no "T26 rc=$RC · $(head -c 400 "$D/prs.json" 2>/dev/null) · $(head -c 300 "$D/out.txt")"; fi
D="$TMP/t26b"; mundo "$D"
RC=$(FIXAZ="$D/fixaz" TYCON_AZ_FAIL=prs TYCON_ADO_CMD="$DOBLE" node "$GUION" --today "$HOY" --org https://dev.azure.com/prueba --json "$D/prs.json" > "$D/out.txt" 2>&1; echo $?)
if [ "$RC" = 1 ] && node -e 'const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit(d.estado === "no_medido" && d.motivo && Array.isArray(d.prs) && d.prs.length === 0 ? 0 : 1);' "$D/prs.json"; then
  ok "T26 con az fallando: el archivo dice no_medido con su motivo y el guion sale 1"
else no "T26b rc=$RC · $(head -c 300 "$D/prs.json" 2>/dev/null)"; fi

D="$TMP/t26c"; mundo "$D"
RC=$(FIXAZ="$D/fixaz" TYCON_ADO_CMD="$DOBLE" node "$GUION" --today "$HOY" --provider github --json "$D/prs.json" > "$D/out.txt" 2>&1; echo $?)
if [ "$RC" = 0 ] && [ ! -s "$D/fixaz/llamadas.log" ] && node -e 'const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit(d.estado === "no_medido" && /los pull requests y los pedidos de GitHub todavía no se leen/.test(d.motivo) ? 0 : 1);' "$D/prs.json"; then
  ok "T26 en GitHub: no_medido con su frase, sale 0 y no consulta Azure"
else no "T26c rc=$RC · $(head -c 300 "$D/prs.json" 2>/dev/null) · $(head -c 200 "$D/out.txt")"; fi

# 2.30-T24 OpenPrs_SeccionComoCantidad — lo que va al aviso es sólo la cantidad: ni repo, ni título, ni
#    autor, ni la organización que az nombra en su error
D="$TMP/t2430"; mundo "$D"; prs "$D" 0 '2401:9:autor=AutorMarcador:repo=RepoMarcador' '2402:8:proy=ProyMarcador' 2403:5
RC=$(correr "$D")
[ "$RC" = 0 ] && [ "$(cat "$D/seccion.txt")" = "PR abiertos hace más de 2 días: 3" ] && ! grep -qE 'Marcador|titulo|#240' "$D/seccion.txt" \
  && ok "2.30-T24 tres PR viejos con título y autor: el archivo dice «PR abiertos hace más de 2 días: 3» y nada más" \
  || no "2.30-T24 cantidad: rc=$RC · [$(tr '\n' '|' < "$D/seccion.txt")]"
D="$TMP/t2430b"; mundo "$D"
printf '#!/usr/bin/env bash\necho "ERROR: TF400813: la organización OrgMarcador ($*) rechazó el pedido" >&2\nexit 1\n' > "$D/az-que-nombra"; chmod +x "$D/az-que-nombra"
TYCON_ADO_CMD="$D/az-que-nombra" node "$GUION" --today "$HOY" --org https://dev.azure.com/OrgMarcador --out "$D/seccion.txt" > "$D/out.txt" 2>&1; RC=$?
[ "$RC" != 0 ] && [ "$(cat "$D/seccion.txt")" = "PR abiertos hace más de 2 días: ? (no se pudo consultar)" ] && ! grep -q 'OrgMarcador\|prueba' "$D/seccion.txt" \
  && ok "2.30-T24 con az fallando y la organización en su error: «? (no se pudo consultar)», sin el motivo ni la organización" \
  || no "2.30-T24 falla: rc=$RC · [$(cat "$D/seccion.txt")] · $(head -c 200 "$D/out.txt")"

# Uso: sin --today sale 2 y no consulta nada
D="$TMP/uso"; mundo "$D"
FIXAZ="$D/fixaz" TYCON_ADO_CMD="$DOBLE" node "$GUION" --org https://x > "$D/out.txt" 2>&1; RC=$?
[ "$RC" = 2 ] && [ ! -s "$D/fixaz/llamadas.log" ] && ok "uso: sin --today sale 2 sin llamar a Azure" || no "uso: rc=$RC · $(head -c 200 "$D/out.txt")"

echo
if [ "$FALLOS" -eq 0 ]; then echo "✅ prs-abiertos: $TOTAL/$TOTAL"; exit 0; fi
echo "❌ prs-abiertos: $FALLOS de $TOTAL en rojo"; exit 1
