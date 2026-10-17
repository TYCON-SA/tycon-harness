#!/usr/bin/env bash
# 🔴 AISLAMIENTO PRIMERO (regla heredada de la story 2.5): HOME falso antes de cualquier línea que
#    ejecute algo. Este lector no escribe nada, pero la regla es de la familia y no se negocia.
# 🔴 La casa REAL se guarda ANTES de falsear HOME (2026-09-18). Se reconstruía con la entrada de
#    passwd del usuario, que en el agente de Azure NO es la casa donde el pipeline clona AgentSkills:
#    el enlace a los revisores quedaba colgado y C7/C7b morían con «Agents dir not found», verdes acá
#    y rojos todas las noches. Mismo criterio que trimmed-close.test.sh: resolver agent-skills
#    ANTES del home falso.
CASA_REAL="${HOME}"
HOME="$(mktemp -d)"; export HOME
#
# rules-catalog.test.sh — el parser ÚNICO de guides/advisor-rules-catalog.md (story 2.9).
#
# Qué defiende, y por qué existe cada caso:
#   · C1  un_solo_contador — una regla se DEFINE en la primera columna en negrita de una fila; nombrarla
#         en la prosa es una REFERENCIA. Y el identificador admite DÍGITOS en el prefijo (`I18N`), que es
#         el defecto de rules-distill.js:79 (`[A-Z]{2,12}`): 7 reglas invisibles y un revisor sin dueño.
#   · C2  clave_es_dueno_mas_regla — `SEC-C1` está DEFINIDO por dos dueños distintos (el revisor de
#         seguridad y el freno de mano) con contenido sin relación. Clavear por identificador los fusiona.
#         `PIPE-C5`, definida dos veces por el MISMO dueño, es UNA regla.
#   · C3  sin_revisor_y_sin_verificacion — un dueño que no es un revisor (freno de mano, pipeline, banco)
#         no entra en ningún veredicto de poda. Contarlo como cubierto sería verde falso.
#   · C4  modos_de_falla — «no pude leer» sale 2 con motivo. Un catálogo ilegible que devuelva 0 reglas
#         se leería como «el catálogo está vacío» y la tabla de poda marcaría candidata a todo.
#   · C5  el_catalogo_real — los números que la story publica salen de acá, no de una lista tipeada.
#
# 🔴 REGLA DE ADMISIÓN: cada caso trae escrito su rojo previo. El exit code se lee ANTES de cualquier
#    pipe. bash 3.2 (macOS): siempre `${v}`.

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LECTOR="${RAIZ}/scripts/lib/rules-catalog.js"
CATALOGO_REAL="${RAIZ}/guides/advisor-rules-catalog.md"
# La señal de «copia pública», la de siempre: sin el perfil del equipo o sin el mapa de renombres (story 8.7, C5 y C7).
PUBLIC_COPY=0
if [ ! -f "${RAIZ}/perfil-equipo.json" ] || [ ! -f "${RAIZ}/scripts/lib/renames.json" ]; then PUBLIC_COPY=1; fi
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }

echo "== rules-catalog.test.sh =="
[ -f "${LECTOR}" ] || { mal "no existe ${LECTOR} (rojo previo: el lector todavía no está)"; echo; echo "${FALLOS} fallo(s)"; exit 1; }

BASE="$(mktemp -d)"
trap 'rm -rf "${BASE}" "${HOME}"' EXIT
unset TYCON_CATALOG TYCON_REVIEWERS_DIR

# ── andamios ────────────────────────────────────────────────────────────────────────────────────
# Un roster de revisores de mentira: el lector decide `esRevisor` por la presencia del .toml generado
# (adapters/codex/agents/<dueño>.toml), que es el padrón que el arnés ya mantiene.
roster() {                 # $1 = dir ; resto = ids de revisores
  local d="$1"; shift
  mkdir -p "${d}"
  local id
  for id in "$@"; do printf 'name = "%s"\n' "${id}" > "${d}/${id}.toml"; done
}

leer() {                   # $1 = catálogo ; $2 = dir de revisores ; resto = args → RC; salida en ${OUT}/${ERR}
  local cat="$1" rev="$2"; shift 2
  OUT="${BASE}/out"; ERR="${BASE}/err"
  node "${LECTOR}" --catalog "${cat}" --reviewers "${rev}" "$@" > "${OUT}" 2> "${ERR}"
}

jq_py() {                  # $1 = expresión python sobre `d` (el JSON de ${OUT})
  python3 -c "
import json,sys
d=json.load(open('${OUT}'))
print($1)
" 2>/dev/null
}

# ── C1 · un solo contador: definición vs referencia, y el prefijo con dígito ─────────────────────
C1="${BASE}/c1"; mkdir -p "${C1}"
cat > "${C1}/catalogo.md" <<'MD'
# Catálogo

## Textos sin traducir — `i18n-hardcoded-text-reviewer`

| Regla | Qué detecta | Fix |
|---|---|---|
| **I18N-C1** | texto visible hardcodeado | pasar por i18n |
| **I18N-W1** | label sin traducir en un mapa | idem |

## .NET Conventions — `tycon-plugin-dotnet-conventions`

| Regla | Qué detecta | Fix |
|---|---|---|
| **DOTNET-C4** | IConfiguration en el ctor | usar IOptions. Ver SEC-C1 y DOTNET-C5 para el contexto |
MD
roster "${C1}/revisores" i18n-hardcoded-text-reviewer tycon-plugin-dotnet-conventions

leer "${C1}/catalogo.md" "${C1}/revisores" --json; RC=$?
if [ "${RC}" -ne 0 ]; then
  mal "C1 · el lector salió ${RC} sobre un catálogo bien formado"
else
  REGLAS="$(jq_py "d['reglas']")"
  [ "${REGLAS}" = "3" ] && ok "C1 · 3 reglas definidas (las menciones en prosa no cuentan)" \
    || mal "C1 · reglas=${REGLAS}, esperaba 3 — rojo previo: contar toda aparición del identificador da 5 (SEC-C1 y DOTNET-C5 están sólo citados)"
  TIENE_I18N="$(jq_py "sum(1 for r in d['lista'] if r['regla']=='I18N-C1')")"
  [ "${TIENE_I18N}" = "1" ] && ok "C1 · I18N-C1 se ve (prefijo con dígito)" \
    || mal "C1 · I18N-C1 invisible — rojo previo: el regex [A-Z]{2,12} de rules-distill.js:79 no admite el dígito y se pierden 7 reglas"
  CITADA="$(jq_py "sum(1 for r in d['lista'] if r['regla']=='DOTNET-C5')")"
  [ "${CITADA}" = "0" ] && ok "C1 · una regla sólo citada en la prosa NO se inventa" \
    || mal "C1 · DOTNET-C5 apareció como regla definida — rojo previo: escanear el texto entero crea reglas fantasma"
fi

# ── C2 · la clave es (dueño, regla) ─────────────────────────────────────────────────────────────
C2="${BASE}/c2"; mkdir -p "${C2}"
cat > "${C2}/catalogo.md" <<'MD'
# Catálogo

## Security — `tycon-plugin-security-basics`

| Regla | Qué detecta | Fix |
|---|---|---|
| **SEC-C1** | path injection por interpolación cruda | Uri.EscapeDataString |

## Freno de mano — `safety-guard-pre.sh`

| Regla | Qué bloquea | Alternativa |
|---|---|---|
| **SEC-C1** | cat ~/.ssh/... | ls -la ~/.ssh/ |

## Pipeline — `tycon-pipeline`

| Regla | Caso | Acción |
|---|---|---|
| **PIPE-C5** (caso crítico) | status in-progress sin marker | pausa |
| **PIPE-C5** (caso normal) | update de status falló | avisar |
MD
roster "${C2}/revisores" tycon-plugin-security-basics

leer "${C2}/catalogo.md" "${C2}/revisores" --json; RC=$?
if [ "${RC}" -ne 0 ]; then
  mal "C2 · el lector salió ${RC}"
else
  SEC="$(jq_py "sum(1 for r in d['lista'] if r['regla']=='SEC-C1')")"
  [ "${SEC}" = "2" ] && ok "C2 · SEC-C1 con dos dueños cuenta como dos reglas" \
    || mal "C2 · SEC-C1 aparece ${SEC} vez(ces), esperaba 2 — rojo previo: clavear por identificador fusiona dos reglas sin relación y arruina el conteo en las dos puntas"
  PIPE="$(jq_py "sum(1 for r in d['lista'] if r['regla']=='PIPE-C5')")"
  [ "${PIPE}" = "1" ] && ok "C2 · PIPE-C5 definida dos veces por el MISMO dueño cuenta una" \
    || mal "C2 · PIPE-C5 aparece ${PIPE} vez(ces), esperaba 1 — rojo previo: contar filas en vez de pares (dueño, regla) la duplica"
  COL="$(jq_py "sum(1 for c in d['colisiones'] if c['regla']=='SEC-C1')")"
  [ "${COL}" = "1" ] && ok "C2 · la colisión real se publica" \
    || mal "C2 · SEC-C1 no figura en colisiones — rojo previo: sin publicarla, nadie se entera de que el identificador dejó de ser único"
  COLP="$(jq_py "sum(1 for c in d['colisiones'] if c['regla']=='PIPE-C5')")"
  [ "${COLP}" = "0" ] && ok "C2 · dos filas del mismo dueño NO son una colisión" \
    || mal "C2 · PIPE-C5 reportada como colisión — rojo previo: marcar toda repetición produce una falsa alarma permanente"
  # filas vs reglas: 4 filas declaradas, 3 pares distintos
  FIL="$(jq_py "d['filas']")"; REG="$(jq_py "d['reglas']")"; IDE="$(jq_py "d['identificadores']")"
  [ "${FIL}" = "4" ] && [ "${REG}" = "3" ] && [ "${IDE}" = "2" ] \
    && ok "C2 · filas=4 · reglas=3 · identificadores=2, los tres por separado" \
    || mal "C2 · filas=${FIL} reglas=${REG} identificadores=${IDE}, esperaba 4/3/2 — rojo previo: publicar un solo número esconde que el identificador dejó de ser clave única"
fi

# ── C3 · sin revisor / sin verificación ─────────────────────────────────────────────────────────
leer "${C2}/catalogo.md" "${C2}/revisores" --json; RC=$?
if [ "${RC}" -ne 0 ]; then
  mal "C3 · el lector salió ${RC}"
else
  ES_REV="$(jq_py "sum(1 for r in d['lista'] if r['dueno']=='tycon-plugin-security-basics' and r['esRevisor'])")"
  [ "${ES_REV}" = "1" ] && ok "C3 · un dueño con .toml es revisor" \
    || mal "C3 · el revisor con .toml no se reconoce — rojo previo: sin padrón, todo dueño parece revisor"
  NO_REV="$(jq_py "sum(1 for r in d['lista'] if r['dueno'] in ('safety-guard-pre.sh','tycon-pipeline') and r['esRevisor'])")"
  [ "${NO_REV}" = "0" ] && ok "C3 · el freno de mano y el pipeline NO son revisores" \
    || mal "C3 · ${NO_REV} regla(s) de un dueño sin .toml marcadas como de revisor — rojo previo: contarlas cubiertas es verde falso sobre 32 reglas"
fi

# ── C4 · modos de falla: «no pude leer» nunca es «no hay reglas» ─────────────────────────────────
leer "${BASE}/no-existe.md" "${C2}/revisores" --json; RC=$?
[ "${RC}" = "2" ] && ok "C4 · catálogo ausente → exit 2" \
  || mal "C4 · catálogo ausente salió ${RC}, esperaba 2 — rojo previo: salir 0 con 0 reglas se lee como «el catálogo está vacío» y la poda marca candidata a todo"
grep -q . "${ERR}" && ok "C4 · el motivo se imprime" || mal "C4 · sin motivo en stderr — rojo previo: un fallo mudo es indistinguible de un catálogo vacío"

printf 'esto no es markdown de catálogo\n' > "${BASE}/vacio.md"
leer "${BASE}/vacio.md" "${C2}/revisores" --json; RC=$?
[ "${RC}" = "2" ] && ok "C4 · catálogo sin una sola regla → exit 2, no 0 reglas" \
  || mal "C4 · catálogo sin reglas salió ${RC}, esperaba 2 — rojo previo: idéntico al anterior, con el agravante de que el archivo existe"

# ── C6 · iter 2: sufijo, reutilización, padrón vacío, catálogo sin dueños, «sin verificación» ─────
# 🔴 Cinco caminos por los que el lector devolvía algo que parecía bueno y no lo era (revisión de la vuelta 1):
#    un identificador con sufijo (`ACCOV-C1-EXT`) desaparecía del total; un identificador retirado y vuelto a
#    usar no se decía; un padrón vacío dejaba TODO «sin revisor» como si fuera una medición; un catálogo sin
#    un solo dueño salía «medido»; y la marca «sin verificación» del AC 7 no existía.
C6="${BASE}/c6"; mkdir -p "${C6}"
cat > "${C6}/catalogo.md" <<'MD'
# Catálogo

## Revisor A — `adv-a`

| Regla | Qué | Fix |
|---|---|---|
| **ACC-C1** | base | x |
| **ACC-C1-EXT** | extensión con sufijo | x |
| **SEC-W4** | regla viva que reusa un identificador retirado | x |

## Banco — `build/banco.js`

<!-- sin-verificacion: BAN-C1 BAN-W1 -->

| Regla | Qué | Fix |
|---|---|---|
| **BAN-C1** | la encuentra el rojo previo | x |
| **BAN-W1** | la encuentra quien revisa | x |
| **BAN-W3** | la verifica el guion | x |

## Retiradas

| Regla | Qué | Estado |
|---|---|---|
| ~~SEC-W4~~ | ~~otra cosa~~ | **RETIRED** |
MD
roster "${C6}/revisores" adv-a
leer "${C6}/catalogo.md" "${C6}/revisores" --json; RC=$?
if [ "${RC}" -ne 0 ]; then
  mal "C6 · el lector salió ${RC}"
else
  EXT="$(jq_py "sum(1 for r in d['lista'] if r['regla']=='ACC-C1-EXT')")"
  [ "${EXT}" = "1" ] && ok "C6 · un identificador con sufijo es una regla propia" \
    || mal "C6 · ACC-C1-EXT aparece ${EXT} vez(ces) — rojo previo: el patrón sin sufijo la saca del total (en el catálogo real, ACCOV-C1-EXT)"
  VIVA="$(jq_py "sum(1 for r in d['lista'] if r['regla']=='SEC-W4')")"
  [ "${VIVA}" = "1" ] && ok "C6 · la regla viva que reusa un identificador retirado SE CUENTA" \
    || mal "C6 · SEC-W4 viva aparece ${VIVA} vez(ces) — rojo previo: tratarla como retirada esconde una regla activa"
  REU="$(jq_py "d['reutilizadas']")"
  [ "${REU}" = "['SEC-W4']" ] && ok "C6 · la reutilización se publica (el catálogo prohíbe reusar identificadores retirados)" \
    || mal "C6 · reutilizadas=${REU} — rojo previo: sin publicarla, nadie ve que un identificador significa dos cosas"
  SV="$(jq_py "sorted(r['regla'] for r in d['lista'] if r.get('sin_verificacion'))")"
  [ "${SV}" = "['BAN-C1', 'BAN-W1']" ] && ok "C6 · «sin verificación» sale de la marca declarada en el catálogo (2 de 3)" \
    || mal "C6 · sin_verificacion=${SV} — rojo previo: la marca del AC 7 no existía"
  SVW3="$(jq_py "next(r.get('sin_verificacion') for r in d['lista'] if r['regla']=='BAN-W3')")"
  [ "${SVW3}" = "False" ] && ok "C6 · la regla que el guion SÍ verifica no lleva la marca" \
    || mal "C6 · BAN-W3 sin_verificacion=${SVW3}"
fi
# la marca que nombra una regla de OTRA sección no se aplica (y se dice)
cat > "${C6}/cruzada.md" <<'MD'
## Banco — `build/banco.js`

<!-- sin-verificacion: BAN-C1 ADV-C9 -->

| Regla | Qué | Fix |
|---|---|---|
| **BAN-C1** | x | x |
MD
leer "${C6}/cruzada.md" "${C6}/revisores" --json; RC=$?
HUE="$(jq_py "d['marcas_sin_regla']")"
[ "${RC}" = "0" ] && [ "${HUE}" = "['ADV-C9']" ] && ok "C6 · una marca que nombra una regla que la sección no define se publica, no se aplica" \
  || mal "C6 · marcas_sin_regla=${HUE} rc=${RC} — una marca mal escrita tiene que verse"
# padrón legible pero vacío → no medido
mkdir -p "${C6}/padron-vacio"
leer "${C6}/catalogo.md" "${C6}/padron-vacio" --json; RC=$?
[ "${RC}" = "2" ] && grep -qi 'padrón' "${ERR}" && ok "C6 · un padrón sin un solo revisor → exit 2, no «todo sin revisor»" \
  || mal "C6 · padrón vacío salió ${RC} — rojo previo: 360 reglas «sin revisor» publicadas como medición"
# ningún dueño en ninguna sección → no medido
printf '# C\n\n## Sin dueño\n\n| R | Q | F |\n|---|---|---|\n| **ZZ-C1** | x | x |\n' > "${C6}/sin-duenos.md"
leer "${C6}/sin-duenos.md" "${C6}/revisores" --json; RC=$?
[ "${RC}" = "2" ] && ok "C6 · un catálogo donde ninguna regla tiene dueño → exit 2" \
  || mal "C6 · catálogo sin dueños salió ${RC} — rojo previo: «medido» con 362 reglas sin dueño"
# un dueño que no está en el padrón se NOMBRA (así se ve un .toml que falta)
leer "${C6}/catalogo.md" "${C6}/revisores" --json; RC=$?
SP="$(jq_py "d['duenos_sin_padron']")"
[ "${SP}" = "['build/banco.js']" ] && ok "C6 · los dueños que no están en el padrón se nombran" \
  || mal "C6 · duenos_sin_padron=${SP} — rojo previo: si falta el .toml de un revisor, sus reglas pasan a «sin revisor» sin que nadie lo vea"

# ── T22 (story 8.41, AC 26) · el revisor de un paquete: su sección lo dice, y fuera del padrón no es un .toml que falta ──
T22="${BASE}/t22"; mkdir -p "${T22}"
cat > "${T22}/catalogo.md" <<'MD'
# Catálogo

## Del núcleo — `rev-nucleo`

| Regla | Qué detecta | Fix |
|---|---|---|
| **NUC-C1** | algo del núcleo | arreglarlo |

## Del stack (paquete stack-juguete) — `rev-del-paquete`

| Regla | Qué detecta | Fix |
|---|---|---|
| **STK-C1** | algo del stack | arreglarlo |
| **STK-W1** | otra cosa del stack | idem |
MD
roster "${T22}/revisores" rev-nucleo
leer "${T22}/catalogo.md" "${T22}/revisores" --json; RC=$?
SP="$(jq_py "d['duenos_sin_padron']")"; DP="$(jq_py "[(x['dueno'], x['paquete']) for x in d['duenos_de_paquetes_ausentes']]")"; N="$(jq_py "d['reglas']")"
SR="$(jq_py "sorted(x['regla'] for x in d['lista'] if not x['esRevisor'])")"
[ "${RC}" = "0" ] && [ "${SP}" = "[]" ] && [ "${DP}" = "[('rev-del-paquete', 'stack-juguete')]" ] && [ "${N}" = "3" ] && [ "${SR}" = "[]" ] \
  && ok "T22 RulesCatalog_PackPerPrefix_SameCount · la sección dice su paquete; su revisor ausente se nombra con su paquete, no como faltante; la cuenta no cambia y sus reglas son de un revisor" \
  || mal "T22 · rc=${RC} sin_padron=${SP} de_paquetes=${DP} reglas=${N} sin_revisor=${SR} (esperado 0 · [] · [('rev-del-paquete', 'stack-juguete')] · 3 · [])"
# y el catálogo real: cada sección de un revisor de paquete dice su paquete
SINP="$(python3 - "${RAIZ}/guides/advisor-rules-catalog.md" <<'PY'
import re,sys
t=open(sys.argv[1]).read()
heads=[l for l in t.split('\n') if l.startswith('## ') and '`' in l]
print(sum(1 for l in heads if '(paquete ' in l))
PY
)"
[ "${SINP}" -ge 13 ] && ok "T22 · el catálogo real marca con su paquete las secciones de los revisores de paquete (${SINP})" \
  || mal "T22 · el catálogo real marca ${SINP} secciones con su paquete (esperado al menos 13: los nueve de bizuit y los cuatro de nextjs-postgres)"

# ── C6b · un bloque de código es un EJEMPLO, no una definición ni una retirada ────────────────────
# 🔴 Existe por un defecto real que se arrastraba: la guía «Retirar una regla» del catálogo trae, dentro
#    de un bloque de código, el ejemplo `| ~~SEC-W4~~ | … RETIRED …`. Leído como texto plano, eso retira
#    a SEC-W4 — que es una regla VIVA (firma de webhooks). rules-distill la escondía desde siempre.
cat > "${C6}/ejemplo.md" <<'MD'
## Revisor A — `adv-a`

| Regla | Qué | Fix |
|---|---|---|
| **SEC-W4** | regla viva | x |

## Cómo retirar una regla

Ejemplo:
```
| ~~SEC-W4~~ | ~~otra cosa~~ | **RETIRED** |
| **FAKE-C9** | una definición de mentira dentro del ejemplo | x |
```
MD
leer "${C6}/ejemplo.md" "${C6}/revisores" --json; RC=$?
if [ "${RC}" -ne 0 ]; then
  mal "C6b · el lector salió ${RC}"
else
  RET="$(jq_py "[r['regla'] for r in d['retiradas']]")"
  REU="$(jq_py "d['reutilizadas']")"
  [ "${RET}" = "[]" ] && [ "${REU}" = "[]" ] && ok "C6b · la fila tachada dentro de un bloque de código no retira nada" \
    || mal "C6b · retiradas=${RET} reutilizadas=${REU} — rojo previo: el ejemplo de la guía retiraba (o «reutilizaba») una regla viva"
  FAKE="$(jq_py "sum(1 for r in d['lista'] if r['regla']=='FAKE-C9')")"
  [ "${FAKE}" = "0" ] && ok "C6b · una definición dentro de un bloque de código no es una regla" \
    || mal "C6b · FAKE-C9 contada como regla — rojo previo: un ejemplo se sumaba al catálogo"
fi

# un identificador tachado EN LA PROSA también es un retirado (así declara el catálogo los reservados)
printf '## Revisor A — `adv-a`\n\n**IDs reservados, no publicados**: `~~ACC-C5~~` · `~~ACC-W5~~`.\n\n| R | Q | F |\n|---|---|---|\n| **ACC-C1** | x | x |\n' > "${C6}/prosa.md"
leer "${C6}/prosa.md" "${C6}/revisores" --json; RC=$?
RP="$(jq_py "sorted(r['regla'] for r in d['retiradas'])")"
[ "${RC}" = "0" ] && [ "${RP}" = "['ACC-C5', 'ACC-W5']" ] && ok "C6b · un identificador tachado en la prosa es un retirado" \
  || mal "C6b · retiradas=${RP} rc=${RC} — rojo previo: sólo se leían las filas, y los reservados de la prosa salían huérfanos"

# ── C7 · el guion viejo y el lector cuentan LO MISMO (una sola gramática, un solo universo) ───────
# 🔴 Existe porque «un solo contador» no lo era: la revisión adversarial de la vuelta 1 encontró que
#    rules-distill.js escondía una regla VIVA (SEC-W4, reutilizada) por tratarla como retirada, y contaba
#    como regla del catálogo un identificador que sólo se MENCIONA. Y al agregar el sufijo apareció un
#    zombi falso (ACCOV-C1-EXT), porque los dos usaban gramáticas distintas.
if [ -f "${CATALOGO_REAL}" ]; then
  RD="${RAIZ}/scripts/tools/rules-distill.js"
  # rules-distill lee los revisores de ~/.claude/agents y las skills de ~/.claude/agent-skills: con el HOME
  # falso se enlazan los REALES, sólo para leer.
  # 🔴 Los revisores se enlazan desde agent-skills/agents, no desde el atajo ~/.claude/agents de la casa
  # real: ese atajo se crea A MANO (paso 3 de INSTALL.md, el instalador no lo crea) y el job Suites del
  # nocturno no lo tiene — C7 y C7b daban «Agents dir not found» en Azure y verde en las máquinas.
  # Mismo criterio que trimmed-close.test.sh (T8). En una máquina con el atajo, el contenido es el mismo.
  # Los revisores, en orden: la variable explícita · el clon que declara TYCON_SKILLS_DIR · la casa
  # real (la de antes del home falso) · y recién al final la entrada de passwd, que es la que fallaba
  # en el agente. Lo que no exista NO se enlaza: un enlace colgado se lee como «no hay revisores».
  AGENTES=""
  for CAND in "${TYCON_AGENTS_DIR:-}" "$( [ -n "${TYCON_SKILLS_DIR:-}" ] && echo "${TYCON_SKILLS_DIR%/skills}/agents" )" "${CASA_REAL}/.claude/agent-skills/agents" \
              "$(python3 -c 'import pwd,os;print(pwd.getpwuid(os.getuid()).pw_dir)')/.claude/agent-skills/agents"; do
    [ -n "${CAND}" ] && [ -d "${CAND}" ] && { AGENTES="${CAND}"; break; }
  done
  mkdir -p "${HOME}/.claude"
  # `TYCON_AGENTS_DIR` (la misma variable del banco y del generador de adapters) permite verificar contra
  # los revisores de un clon de agent-skills antes de instalarlo (story 7.3: VAL-W15 nace en los dos repos).
  if [ -z "${AGENTES}" ]; then
    mal "C7 · NO MEDIDO: no encontré los revisores (probé TYCON_AGENTS_DIR, TYCON_SKILLS_DIR, ${CASA_REAL}/.claude/agent-skills/agents y la casa de passwd) — no medido no es verde"
  else
  ln -sfn "${AGENTES}" "${HOME}/.claude/agents"
  ln -sfn "$(dirname "${AGENTES}")" "${HOME}/.claude/agent-skills"
  TYCON_GUIDES_DIR="${RAIZ}" node "${RD}" --json > "${BASE}/rd.json" 2> "${BASE}/rd.err"; RC=$?
  leer "${CATALOGO_REAL}" "${RAIZ}/adapters/codex/agents" --json
  IDS_LECTOR="$(jq_py "d['identificadores']")"
  if [ "${RC}" -ne 0 ]; then
    mal "C7 · rules-distill salió ${RC}: $(head -c 200 "${BASE}/rd.err")"
  else
    IDS_RD="$(python3 -c "import json;print(json.load(open('${BASE}/rd.json'))['summary']['catalogIdsCount'])")"
    [ "${IDS_RD}" = "${IDS_LECTOR}" ] && ok "C7 · rules-distill y el lector cuentan los mismos identificadores (${IDS_RD})" \
      || mal "C7 · rules-distill cuenta ${IDS_RD} y el lector ${IDS_LECTOR} — rojo previo: dos universos para la misma pregunta"
    ORF="$(python3 -c "import json;print([o.get('id') for o in json.load(open('${BASE}/rd.json'))['orphans']])")"
    # La copia pública (story 8.7) sale sin las secciones del catálogo de los revisores del paquete de clientes, y un
    # revisor del núcleo cita por su identificador una regla de uno de ellos. Ahí —y sólo ahí— se tolera un huérfano
    # cuyo PREFIJO no tiene ninguna fila en el catálogo (la familia entera no viajó), y se dice cuál. Un huérfano de una
    # familia que sí está en el catálogo sigue siendo rojo en los dos lados; en el repo del equipo no se tolera ninguno.
    if [ "${PUBLIC_COPY}" = 1 ] && [ "${ORF}" != "[]" ]; then
      TOLERATED="$(python3 -c "
import json
cat = json.load(open('${OUT}')); rd = json.load(open('${BASE}/rd.json'))
familias = set(r['regla'].split('-')[0] for r in cat['lista'])
print(' '.join(o.get('id') for o in rd['orphans'] if o.get('id','').split('-')[0] not in familias))")"
      ORF="$(python3 -c "
import json
cat = json.load(open('${OUT}')); rd = json.load(open('${BASE}/rd.json'))
familias = set(r['regla'].split('-')[0] for r in cat['lista'])
print([o.get('id') for o in rd['orphans'] if o.get('id','').split('-')[0] in familias])")"
      [ -z "${TOLERATED}" ] || echo "  ⏭   — C7 · NO MEDIDO para ${TOLERATED}: regla de un revisor que no viaja (su familia no tiene ninguna fila en el catálogo de la copia pública). No es un verde."
    fi
    [ "${ORF}" = "[]" ] && ok "C7 · ningún huérfano (SPEC-W8 es un número retirado, no una regla citada sin definir)" \
      || mal "C7 · huérfanos=${ORF} — rojo previo: un número que el catálogo declara inexistente, citado en una nota de historia, rompía el chequeo de salud del arnés"
    SW4="$(python3 -c "import json;d=json.load(open('${BASE}/rd.json'));print('SEC-W4' in [z['id'] for z in d['zombies']] or 'SEC-W4' in [o['id'] for o in d['orphans']])")"
    [ "${SW4}" = "False" ] && ok "C7 · SEC-W4 está en el catálogo de rules-distill (ya no la esconde el ejemplo de la guía)" \
      || mal "C7 · SEC-W4 sigue fuera del catálogo de rules-distill"
    ZOMB="$(python3 -c "import json;print([z.get('id') for z in json.load(open('${BASE}/rd.json'))['zombies']])")"
    [ "${ZOMB}" = "['ACCOV-C1-EXT']" ] && ok "C7 · ACCOV-C1-EXT sale como zombi REAL (el revisor la fusionó en ACCOV-C1 y nunca la nombra)" \
      || mal "C7 · zombies=${ZOMB}, esperaba ['ACCOV-C1-EXT'] — antes estaba escondida por la gramática sin sufijo"
  fi
  fi
fi

# ── C7b · una regla definida sin dueño no tumba a rules-distill (vuelta 2) ──────────────────────────
# Sin revisores no corre (los lee del home): C7 ya lo dijo como NO MEDIDO, y acá se repite para que
# la ausencia no se lea como «pasó».
# 🔴 rojo previo: la capa de definiciones copiaba el dueño sin mirarlo, y classifyOwner(null) tiraba
#    TypeError: el chequeo de salud del arnés se caía entero por una fila fuera de sección.
if [ -f "${CATALOGO_REAL}" ] && [ -n "${AGENTES:-}" ]; then
  GSD="${BASE}/guias-sin-dueno"; mkdir -p "${GSD}/guides"; ln -sfn "${RAIZ}/scripts" "${GSD}/scripts"
  cat > "${GSD}/guides/advisor-rules-catalog.md" <<'MD'
# Catálogo

| Regla | Qué | Fix |
|---|---|---|
| **SUELTA-C1** | una fila antes de cualquier sección con dueño | x |

## Seguridad — `tycon-plugin-security-basics`

| Regla | Qué | Fix |
|---|---|---|
| **SEC-C1** | a | a |
MD
  TYCON_GUIDES_DIR="${GSD}" node "${RAIZ}/scripts/tools/rules-distill.js" --json > "${BASE}/rd-sd.json" 2> "${BASE}/rd-sd.err"; RC=$?
  if [ "${RC}" -ne 0 ]; then
    mal "C7b · rules-distill salió ${RC} con una regla sin dueño: $(head -c 160 "${BASE}/rd-sd.err")"
  else
    SD="$(python3 -c "import json;d=json.load(open('${BASE}/rd-sd.json'));print('SUELTA-C1' in json.dumps(d.get('zombies',[])+d.get('orphans',[])+d.get('brokenRefs',[])))")"
    [ "${SD}" = "False" ] && ok "C7b · una regla sin dueño no tumba a rules-distill ni se reporta como de un revisor" \
      || mal "C7b · SUELTA-C1 apareció en los reportes de revisores — sin dueño no hay a quién atribuirla"
  fi
fi
if [ -f "${CATALOGO_REAL}" ] && [ -z "${AGENTES:-}" ]; then
  mal "C7b · NO MEDIDO: sin revisores en el home no se puede correr rules-distill"
fi

# ── C5 · el catálogo REAL: los números que publica la story ──────────────────────────────────────
# Los controles y los números viven en scripts/lib/rules-catalog-count.js (EXPECTED, con su historia): los usa también el
# freno de antes del commit cuando un commit toca agents/ o el catálogo, y dos copias de los números se separan solas.
# Los tres exactos son los del NÚCLEO: en el repo del equipo se leen sin las secciones de su paquete de clientes.
C5_OUT="${BASE}/c5.out"
node "${RAIZ}/scripts/lib/rules-catalog-count.js" --root "${RAIZ}" --catalog "${CATALOGO_REAL}" > "${C5_OUT}" 2>&1; RC=$?
cat "${C5_OUT}"
C5_MAL="$(grep -c '^  MAL ' "${C5_OUT}")"
FALLOS=$((FALLOS + C5_MAL))
if [ "${RC}" -ne 0 ] && [ "${C5_MAL}" -eq 0 ]; then mal "C5 · el conteo salió ${RC} sin decir qué control falló"; fi
if [ "${RC}" -eq 0 ] && [ "${C5_MAL}" -ne 0 ]; then mal "C5 · el conteo salió 0 con controles en MAL"; fi

echo
echo "${FALLOS} fallo(s)"
[ "${FALLOS}" -eq 0 ] || exit 1
