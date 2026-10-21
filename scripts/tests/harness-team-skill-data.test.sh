#!/usr/bin/env bash
# harness-team-skill-data.test.sh — una skill de la lista FIJA de la versión, con sus datos fuera de su carpeta
# (T35, T36), en el laboratorio: el GitHub de juguete con los dos repos, y una capa de juguete que trae la skill de
# la lista (`skills/bizuit-sdd`, su nombre de la lista; TODO su contenido inventado) con sus dos archivos de datos.
#
# Lo que no se puede perder:
#   T35 · la conexión vieja de un dev (`.bizuit-config.yaml`) llega a la casa nueva (~/.bizuit-sdd/config.yaml) sin que la
#         persona haga nada, UNA vez por skill: el orden fijo de orígenes (la carpeta propia, la apartada de una mudanza —la más
#         nueva primero—, el clon dejado, previous/), byte a byte, sólo para el usuario, el original en su lugar; nada se pisa;
#         sin poder escribir o con el cambio de versión que no se hizo, la máquina sigue y la casa queda vacía; un enlace no se
#         sigue; la clave sensible se dice sin el valor; el contenido no aparece en salidas, registros ni estado; el plan y el
#         resumen lo dicen; la variable relativa se ignora; el segundo update y el refresco no copian; la casa REAL del dev no
#         se toca. Ningún comando de settings.json ni del hooks.json de Codex apunta dentro de la capa.
#   T36 · doctor (nunca fail): lo de más dentro de la carpeta de la skill con su lugar —sin la línea «de más»—, la carpeta propia
#         que tapa la de la capa (con las dos versiones y lo ajeno que trae) en ~/.claude/skills y en ~/.codex/skills, el
#         original ya copiado, la casa resuelta; lo de más se guarda en ~/.tycon/team/kept-… antes de trash/ y de uninstall, y
#         se nombra; `deja:` nombra la casa; sin capa, ninguna línea nueva.
#
# Límite dicho: el aplicador del laboratorio es de juguete (el de los laboratorios de versiones bajadas): «ningún comando
# apunta dentro de la capa» se mide sobre lo que ESE aplicador registra; con el aplicador real, no medido.
# En Windows, los permisos del archivo no se miden.
#
# Laboratorio: scripts/tests/lib/harness-lab.sh. Nunca ~/.claude, ~/.tycon, ~/.bizuit-sdd ni el checkout real.
# Uso: bash scripts/tests/harness-team-skill-data.test.sh [--only T35|T35m|T36]
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# la casa REAL del dev, por hash, ANTES de armar nada (el laboratorio cambia HOME)
REAL_CASA="$HOME/.bizuit-sdd"
casa_hash() { if [ -e "$1" ]; then find "$1" -type f -exec shasum {} \; 2>/dev/null | sort | shasum | cut -c1-40; else printf 'ausente'; fi; }
REAL_ANTES="$(casa_hash "$REAL_CASA")"
source "$RAIZ/scripts/tests/lib/harness-lab.sh"
export TYCON_UPDATE_APPLY=auto TYCON_STARTUP_DETACH=0
ONLY=""; [ "${1:-}" = "--only" ] && ONLY="${2:-}"
corre() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
BASE="$(mktemp -d)"
case "$BASE" in "$RAIZ"*|*agent-skills*|*/.claude*) echo "❌ harness-team-skill-data: el laboratorio cayó en ${BASE}"; exit 1 ;; esac
trap 'chmod -R u+w "$BASE" 2>/dev/null; rm -rf "$BASE"; kill $(jobs -p) 2>/dev/null' EXIT
j() { python3 -c "import json,sys; d=json.load(open(sys.argv[1], encoding='utf-8')); print($2)" "$1" 2>/dev/null; }
jtxt() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
NEW() { printf '%s' "$LAB_HOME/.tycon/harness"; }
ESTADO() { node -e 'process.stdout.write(require(process.argv[1]).stateDir(process.argv[2]))' "$(NEW)/scripts/setup/harness/tycon-home.js" "$LAB_HOME"; }
estado() { j "$(ESTADO)/harness-state.json" "$1"; }
estado_edita() { # estado_edita '<python sobre d>'
  python3 - "$(ESTADO)/harness-state.json" "$1" <<'PY'
import json,sys
f,code=sys.argv[1:3]; d=json.load(open(f, encoding='utf-8'))
exec(code)
json.dump(d, open(f,'w', encoding='utf-8'), indent=2)
PY
}
ventana_none() { estado_edita "d['last_fetch']=None; d['last_fetch_failed']=None"; }
SKILL=skills/bizuit-sdd
CASA() { printf '%s' "$LAB_HOME/.bizuit-sdd/config.yaml"; }
OLD=.bizuit-config.yaml
SENT="CENTINELA-de-la-conexion-9q4z"
conexion() { printf 'environments:\n  active: dev\n  dev:\n    url: https://bpm.example.test/%s\n    user: %s\n' "$1" "$SENT"; }
modo() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }
# la skill de la lista en la capa de juguete: su nombre es el de la lista; el contenido, inventado
skill_con_datos() {
  local d="$LAB_AUTHOR_TEAM/$SKILL"
  mkdir -p "$d/docs" "$d/templates" "$d/rules/custom"
  printf -- '---\nname: bizuit-sdd\ndescription: skill de juguete con datos (laboratorio)\n---\nUsala para probar.\n' > "$d/SKILL.md"
  printf '# guía de juguete\n' > "$d/docs/guia.md"
  printf '# reglas propias: reservado\n' > "$d/rules/custom/README.md"
  printf '%s\n' "${1:-2.0.0-juguete}" > "$d/VERSION"
  printf 'body { color: black; }\n' > "$d/templates/shared-styles.css"
}
lab_c() { # lab_c <dir> — la máquina sin arnés, los dos repos y la capa con la skill de la lista
  harness_lab_create "$1"
  export TYCON_PROFILE=
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.08.1
  harness_lab_team_repo
  skill_con_datos
  harness_lab_team_publish "la skill de la lista, con sus datos"
  harness_lab_team_server
  harness_lab_release_fresh_home
  VERSION_N=1
}
nueva_version() { VERSION_N=$((VERSION_N+1)); harness_lab_publish_stable "2026.10.08.$VERSION_N"; }
actualiza() { nueva_version; UPD_OUT="$(harness_release update --yes 2>&1)"; UPD_RC=$?; ALL_OUT="${ALL_OUT:-}
$UPD_OUT"; }
olvida_mudanza() { estado_edita "d.get('team') and d['team'].pop('data_moved', None)"; rm -rf "$LAB_HOME/.bizuit-sdd"; }
pone() { mkdir -p "$(dirname "$1")"; conexion "$2" > "$1"; }

# ───────────────────────────────────────────── T35 ────────────────────────────────────────────────────────────────────
if corre T35; then
  echo "T35 TeamSkillData_LegacyConfigCopiedOncePerSkill_FixedSourceOrder_AfterHealthySwapOrLinksStage_NeverOverwrites_RegularFileUnder64K_ContentNeverPrinted_SensitiveKeySaid_UserOnlyPerms_OriginalKept_RealHomeUntouched_RealApplierHooksNeverIntoLayer"
  echo "      · la conexión vieja llega a la casa nueva una vez, en el orden fijo, sin pisar, sin mostrarse"
  lab_c "$BASE/lab35"
  PROPIA="$LAB_HOME/.claude/skills/bizuit-sdd"
  mkdir -p "$PROPIA"; printf '1.0.0\n' > "$PROPIA/VERSION"
  { printf 'token: %s\n' "$SENT"; conexion propia; } > "$PROPIA/$OLD"
  # (a) el plan de install --dry-run lo anticipa y no escribe
  OUT="$(harness install --version latest --team "$LAB_TEAM" --dry-run 2>&1)"; RC=$?
  ALL_OUT="$OUT"
  [ "$RC" = 0 ] && case "$OUT" in *"se copiaría $PROPIA/$OLD"*"$(CASA)"*) true ;; *) false ;; esac && ok "(a) el plan de --dry-run dice qué se copiaría" || mal "(a) rc $RC: $OUT"
  [ ! -e "$(CASA)" ] && ok "(a) …y no escribe la casa" || mal "(a) --dry-run escribió la casa"
  # (b) install --team: copiada byte a byte, sólo para el usuario, el original en su lugar, la clave sensible dicha sin el valor
  OUT="$(harness install --version latest --team "$LAB_TEAM" --yes 2>&1)"; RC=$?
  ALL_OUT="$ALL_OUT
$OUT"
  [ "$RC" = 0 ] && ok "(b) install --team sale 0" || mal "(b) install rc $RC: $OUT"
  cmp -s "$PROPIA/$OLD" "$(CASA)" && ok "(b) la casa nueva tiene la conexión, byte a byte" || mal "(b) la casa: $(ls -la "$LAB_HOME/.bizuit-sdd" 2>&1)"
  if [ "$(uname -s)" = Darwin ] || [ "$(uname -s)" = Linux ]; then
    [ "$(modo "$(CASA)")" = 600 ] && [ "$(modo "$LAB_HOME/.bizuit-sdd")" = 700 ] && ok "(b) 600 y 700" || mal "(b) modos $(modo "$(CASA)") $(modo "$LAB_HOME/.bizuit-sdd")"
  fi
  [ -f "$PROPIA/$OLD" ] && ok "(b) el original queda donde estaba" || mal "(b) el original no está"
  case "$OUT" in *"clave sensible"*) ok "(b) la clave sensible se dice" ;; *) mal "(b) no dice la clave sensible: $OUT" ;; esac
  case "$OUT" in *"pasó de $PROPIA/$OLD"*) ok "(b) el resumen lo dice" ;; *) mal "(b) el resumen no lo dice: $OUT" ;; esac
  [ "$(estado "d['team']['data_moved']['bizuit-sdd']['from']")" = "$PROPIA/$OLD" ] && ok "(b) una vez por skill: queda en state.team.data_moved" || mal "(b) estado: $(estado "d['team'].get('data_moved')")"
  [ -f "$(NEW)/$SKILL/VERSION" ] && [ -f "$(NEW)/$SKILL/templates/shared-styles.css" ] && ok "(b) los dos archivos de datos apilados" || mal "(b) faltan los datos en $(NEW)/$SKILL"
  # (c) el segundo update no copia (aunque la casa se haya borrado) y no dice nada de la conexión
  rm -f "$(CASA)"
  actualiza
  [ "$UPD_RC" = 0 ] && [ ! -e "$(CASA)" ] && ok "(c) el segundo update no copia" || mal "(c) rc $UPD_RC, casa $(ls "$(CASA)" 2>&1): $UPD_OUT"
  case "$UPD_OUT" in *"su conexión"*) mal "(c) el segundo update vuelve a hablar de la conexión: $UPD_OUT" ;; *) ok "(c) …ni lo dice" ;; esac
  # (d) el refresco en el lugar (un commit sólo del equipo) no copia
  printf '# otra guía\n' > "$LAB_AUTHOR_TEAM/$SKILL/docs/otra.md"; harness_lab_team_publish "un cambio sólo del equipo"
  olvida_mudanza
  ventana_none
  OUT="$(harness_release startup 2>&1)"
  ALL_OUT="$ALL_OUT
$OUT"
  [ -f "$(NEW)/$SKILL/docs/otra.md" ] && ok "(d) el refresco en el lugar trajo el cambio" || mal "(d) el refresco no trajo el cambio"
  [ ! -e "$(CASA)" ] && ok "(d) …y no copió la conexión" || mal "(d) el refresco copió la conexión"
  # (e) sin carpeta propia: dos apartadas (sin diario), el clon dejado y previous/ → la apartada más nueva
  rm -rf "$PROPIA"
  A_VIEJA="$LAB_HOME/.claude/agent-skills.before-migrate-20261001-000000-1-1"; A_NUEVA="$LAB_HOME/.claude/agent-skills.before-migrate-20261005-000000-1-1"
  CLON="$BASE/clon-dejado"
  pone "$A_VIEJA/$SKILL/$OLD" apartada-vieja; pone "$A_NUEVA/$SKILL/$OLD" apartada-nueva; pone "$CLON/$SKILL/$OLD" clon; pone "$(NEW)/$SKILL/$OLD" previous
  estado_edita "d['migrate_home']={'status':'done','from':'$CLON'}"
  olvida_mudanza
  actualiza
  cmp -s "$A_NUEVA/$SKILL/$OLD" "$(CASA)" && ok "(e) la apartada más nueva gana" || mal "(e) la casa: $(head -3 "$(CASA)" 2>&1 | grep url) · $UPD_OUT"
  case "$UPD_OUT" in *"$A_VIEJA/$SKILL/$OLD"*"$CLON/$SKILL/$OLD"*"$LAB_HOME/.tycon/previous/$SKILL/$OLD"*) ok "(e) los demás se nombran, en orden" ;; *) mal "(e) no nombra los demás en orden: $UPD_OUT" ;; esac
  # (e') sin apartadas: el clon dejado gana a previous/; y sólo previous/
  rm -rf "$A_VIEJA" "$A_NUEVA"; pone "$(NEW)/$SKILL/$OLD" previous
  olvida_mudanza; actualiza
  cmp -s "$CLON/$SKILL/$OLD" "$(CASA)" && ok "(e') el clon dejado gana a previous/" || mal "(e') $UPD_OUT"
  rm -rf "$CLON"; estado_edita "d.pop('migrate_home', None)"; pone "$(NEW)/$SKILL/$OLD" previous
  olvida_mudanza; actualiza
  [ -f "$(CASA)" ] && grep -q '/previous$' "$(CASA)" && ok "(e') sólo previous/: se copia de ahí (desde previous/, que sigue ahí tras el cambio)" || mal "(e') $UPD_OUT"
  # (f) la casa ya con otra: no se pisa y se dice
  olvida_mudanza; mkdir -p "$LAB_HOME/.bizuit-sdd"; printf 'environments: {}\n' > "$(CASA)"; pone "$(NEW)/$SKILL/$OLD" previous
  actualiza
  [ "$(cat "$(CASA)")" = 'environments: {}' ] && ok "(f) la casa nueva no se pisa" || mal "(f) se pisó la casa"
  case "$UPD_OUT" in *"gana la casa nueva"*) ok "(f) …y se dice" ;; *) mal "(f) no se dice: $UPD_OUT" ;; esac
  # (g) la casa que no se puede escribir: la actualización sigue, nada queda escrito, se dice, y se reintenta la próxima
  olvida_mudanza; BLOQ="$BASE/bloqueada"; mkdir -p "$BLOQ"; chmod 500 "$BLOQ"; pone "$(NEW)/$SKILL/$OLD" previous
  nueva_version; UPD_OUT="$(BIZUIT_SDD_HOME="$BLOQ/casa" harness_release update --yes 2>&1)"; UPD_RC=$?
  ALL_OUT="$ALL_OUT
$UPD_OUT"
  chmod 700 "$BLOQ"
  [ "$UPD_RC" = 0 ] && [ ! -e "$BLOQ/casa" ] && ok "(g) sin poder escribir: la actualización sigue y no queda nada en la casa" || mal "(g) rc $UPD_RC: $UPD_OUT"
  case "$UPD_OUT" in *"no pude copiar"*) ok "(g) …y se dice" ;; *) mal "(g) no se dice: $UPD_OUT" ;; esac
  [ -z "$(estado "(d['team'].get('data_moved') or {}).get('bizuit-sdd') or ''")" ] && ok "(g) …y no se registra (la próxima se reintenta)" || mal "(g) se registró igual"
  # (h) un cambio de versión que no se hizo (previous/ no se puede apartar): no queda nada en la casa
  olvida_mudanza; pone "$(NEW)/$SKILL/$OLD" previous
  chmod 555 "$LAB_HOME/.tycon"
  actualiza
  chmod 755 "$LAB_HOME/.tycon"
  [ "$UPD_RC" != 0 ] && [ ! -e "$(CASA)" ] && ok "(h) el cambio que no se hizo no deja nada en la casa (rc $UPD_RC)" || mal "(h) rc $UPD_RC, casa $(ls "$(CASA)" 2>&1): $UPD_OUT"
  # (i) un enlace en lugar del archivo y uno de 100 KB: no se copian, y se dice
  olvida_mudanza; mkdir -p "$PROPIA"; conexion enlace > "$BASE/otro.yaml"; ln -s "$BASE/otro.yaml" "$PROPIA/$OLD"
  actualiza
  [ ! -e "$(CASA)" ] && case "$UPD_OUT" in *"es un enlace"*) true ;; *) false ;; esac && ok "(i) el enlace no se sigue y se dice" || mal "(i) $UPD_OUT"
  rm -f "$PROPIA/$OLD"; { conexion grande; head -c 102400 /dev/zero | tr '\0' '#'; } > "$PROPIA/$OLD"
  olvida_mudanza; actualiza
  [ ! -e "$(CASA)" ] && case "$UPD_OUT" in *"64 KB"*) true ;; *) false ;; esac && ok "(i) el de 100 KB no se copia y se dice" || mal "(i) $UPD_OUT"
  # (j) BIZUIT_SDD_HOME absoluta la cambia; relativa se ignora y se dice
  conexion propia > "$PROPIA/$OLD"; olvida_mudanza
  nueva_version; UPD_OUT="$(BIZUIT_SDD_HOME="$BASE/otra-casa" harness_release update --yes 2>&1)"; ALL_OUT="$ALL_OUT
$UPD_OUT"
  cmp -s "$PROPIA/$OLD" "$BASE/otra-casa/config.yaml" && ok "(j) la variable absoluta cambia la casa" || mal "(j) $UPD_OUT"
  olvida_mudanza
  nueva_version; UPD_OUT="$(BIZUIT_SDD_HOME="relativa/casa" harness_release update --yes 2>&1)"; ALL_OUT="$ALL_OUT
$UPD_OUT"
  [ -f "$(CASA)" ] && case "$UPD_OUT" in *"no es una ruta absoluta"*) true ;; *) false ;; esac && ok "(j) la relativa se ignora y se dice" || mal "(j) $UPD_OUT"
  # (n) en el ARRANQUE con aplicación automática (el modo del perfil del equipo), lo que la mudanza tiene que decir —acá, la clave
  # sensible— llega al aviso de la sesión, no sólo al registro
  olvida_mudanza; rm -f "$PROPIA/$OLD"; { printf 'password: %s\n' "$SENT"; conexion arranque; } > "$(NEW)/$SKILL/$OLD"
  nueva_version; ventana_none
  OUT="$(harness_release startup 2>&1)"; ALL_OUT="$ALL_OUT
$OUT"
  [ -f "$(CASA)" ] && ok "(n) el arranque aplicó la versión y mudó la conexión" || mal "(n) la casa no está: $OUT · estado $(estado "d.get('version')")"
  case "$(estado "d.get('notice') or ''")" in *"clave sensible"*) ok "(n) …y el aviso de la sesión dice la clave sensible" ;; *) mal "(n) el aviso no la dice: $(estado "d.get('notice')")" ;; esac
  # (k) el contenido no aparece en ninguna salida, registro ni estado
  case "$ALL_OUT" in *"$SENT"*) mal "(k) el contenido apareció en una salida" ;; *) ok "(k) el contenido no aparece en las salidas" ;; esac
  LEAK="$(grep -rl -- "$SENT" "$(ESTADO)" "$LAB_HOME/.claude/.tycon-pipeline" 2>/dev/null)"
  [ -z "$LEAK" ] && ok "(k) …ni en el estado ni en los registros" || mal "(k) aparece en: $LEAK"
  # (l) ningún comando registrado apunta dentro de la capa (aplicador de juguete; con el real, no medido)
  HOOKS="$(cat "$LAB_HOME/.claude/settings.json" "${CODEX_HOME:-$LAB_HOME/.codex}/hooks.json" 2>/dev/null)"
  case "$HOOKS" in *"$SKILL"*) mal "(l) un comando apunta dentro de la skill de la capa" ;; *) ok "(l) settings.json y hooks.json: nada apunta dentro de la capa (aplicador de juguete; el real, no medido)" ;; esac
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T35m ───────────────────────────────────────────────────────────────────
# la mudanza REAL: una máquina con clon, la conexión vieja en su clon viejo de skills, y migrate --to-home
if corre T35m; then
  echo "T35 (la mudanza) · migrate --to-home con repo del equipo: el plan lo anticipa, la conexión llega a la casa nueva desde lo que la mudanza apartó, y el estado recuerda la apartada"
  harness_lab_create "$BASE/lab35m"
  export TYCON_PROFILE=
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.08.1
  harness_lab_team_repo
  skill_con_datos
  harness_lab_team_publish "la skill de la lista, con sus datos"
  harness_lab_team_server
  harness install --profile full --yes >"$BASE/lab35m/install.out" 2>&1 || mal "la instalación desde el clon falló: $(tail -3 "$BASE/lab35m/install.out" | tr '\n' ' ')"
  harness_lab_team_set_clone_key "$LAB_TEAM"
  VIEJA="$LAB_SKILLS/$SKILL/$OLD"
  pone "$VIEJA" clon-viejo-de-skills
  [ -d "$LAB_SKILLS" ] && [ ! -L "$LAB_SKILLS" ] && ok "(m) el clon viejo de skills es una carpeta real (la mudanza la aparta)" || mal "(m) $LAB_SKILLS no es una carpeta real: el caso no mide la apartada"
  OUT="$(harness migrate --to-home --dry-run 2>&1)"; RC=$?
  [ "$RC" = 0 ] && case "$OUT" in *"datos:"*"se copiaría"*"$OLD"*"$(CASA)"*) true ;; *) false ;; esac && ok "(m) el plan de la mudanza lo anticipa" || mal "(m) plan rc $RC: $OUT"
  [ ! -e "$(CASA)" ] && ok "(m) …sin escribir la casa" || mal "(m) --dry-run escribió la casa"
  OUT="$(harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "(m) migrate --to-home sale 0" || mal "(m) migrate rc $RC: $OUT"
  grep -q '/clon-viejo-de-skills$' "$(CASA)" 2>/dev/null && ok "(m) la conexión llegó a la casa nueva" || mal "(m) la casa: $(ls -la "$LAB_HOME/.bizuit-sdd" 2>&1 | tr '\n' ' ') · $OUT"
  case "$OUT" in *"su conexión pasó de"*) ok "(m) …y el resumen de la mudanza lo dice" ;; *) mal "(m) el resumen no lo dice: $OUT" ;; esac
  ASIDE="$(estado "d['migrate_home'].get('aside') or ''")"
  case "$ASIDE" in "$LAB_HOME/.claude/agent-skills.before-migrate-"*) ok "(m) state.migrate_home.aside recuerda la apartada" ;; *) mal "(m) migrate_home: $(estado "d.get('migrate_home')")" ;; esac
  [ -n "$(estado "d['team']['data_moved']['bizuit-sdd']['from']")" ] && ok "(m) una vez por skill: queda en state.team.data_moved" || mal "(m) data_moved: $(estado "d['team'].get('data_moved')")"
  # el update siguiente no vuelve a copiar
  rm -f "$(CASA)"; VERSION_N=1
  actualiza
  [ "$UPD_RC" = 0 ] && [ ! -e "$(CASA)" ] && ok "(m) el update siguiente no vuelve a copiar" || mal "(m) rc $UPD_RC: $UPD_OUT"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T36 ────────────────────────────────────────────────────────────────────
if corre T36; then
  echo "T36 Doctor_FileInsideListedSkillWarnedWithItsPlace_ReplacesExtraLine_OwnFolderShadowsInClaudeAndCodexWithVersionsAndForeignContents_OriginalNamed_ResolvedHomeShown_KeptBeforeTrashAndUninstall_NeverFail"
  echo "      · doctor avisa lo que quedó dentro de la skill y la carpeta propia que la tapa; lo ajeno se guarda antes de borrarse"
  lab_c "$BASE/lab36"
  harness_lab_codex_pieces || mal "no pude sumar las piezas de Codex al laboratorio"
  harness_lab_tools both
  # la carpeta propia de antes del arnés, en las dos herramientas: otra VERSION, specs, credenciales, la conexión vieja
  for P in "$LAB_HOME/.claude/skills/bizuit-sdd" "$CODEX_HOME/skills/bizuit-sdd"; do
    mkdir -p "$P/processes/acme/proceso-x" "$P/rules/custom"; printf '1.0.0\n' > "$P/VERSION"
    printf '# spec de juguete\n' > "$P/processes/acme/proceso-x/spec.md"; printf 'BIZUIT_X=1\n' > "$P/.env"; printf '# propia\n' > "$P/rules/custom/cliente.md"
  done
  conexion propia > "$LAB_HOME/.claude/skills/bizuit-sdd/$OLD"
  OUT="$(harness install --version latest --team "$LAB_TEAM" --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "(a) install --team con Claude Code y Codex sale 0" || mal "(a) install rc $RC: $OUT"
  # lo escrito dentro de la carpeta de la skill en el árbol
  conexion arbol > "$(NEW)/$SKILL/$OLD"; mkdir -p "$(NEW)/$SKILL/processes/x"; printf '# una spec escrita acá por error\n' > "$(NEW)/$SKILL/processes/x/spec.md"
  JSON="$(harness_release doctor --json 2>/dev/null)"
  WARN="$(printf '%s' "$JSON" | jtxt "'\n'.join(d['warn'])")"
  [ "$(printf '%s' "$JSON" | jtxt "len(d['fail'])")" = 0 ] && ok "(a) doctor sin fail" || mal "(a) doctor fail: $(printf '%s' "$JSON" | jtxt "d['fail']")"
  case "$WARN" in *"$SKILL/$OLD"*"su lugar es $(CASA)"*) ok "(a) la conexión dentro de la skill, con su lugar" ;; *) mal "(a) no avisa la conexión con su lugar: $WARN" ;; esac
  case "$WARN" in *"$SKILL/processes/x/spec.md"*"se pierde con la próxima versión"*) ok "(a) la spec dentro de la skill, con «se pierde»" ;; *) mal "(a) no avisa la spec: $WARN" ;; esac
  case "$WARN" in *"$SKILL/processes/x/spec.md: de más"*|*"$SKILL/$OLD: de más"*) mal "(a) sigue la línea «de más» para esas rutas" ;; *) ok "(a) sin la línea «de más» para esas rutas" ;; esac
  for P in "$LAB_HOME/.claude/skills/bizuit-sdd" "$CODEX_HOME/skills/bizuit-sdd"; do
    case "$WARN" in *"$P es una carpeta propia"*"1.0.0"*"2.0.0-juguete"*) ok "(b) la carpeta propia de $(basename "$(dirname "$(dirname "$P")")"), con las dos versiones" ;; *) mal "(b) no avisa $P con sus versiones: $WARN" ;; esac
  done
  LINE="$(printf '%s\n' "$WARN" | grep "$LAB_HOME/.claude/skills/bizuit-sdd es una carpeta propia")"
  case "$LINE" in *"processes/"*".env"*"rules/custom/cliente.md"*"$OLD"*"copialo antes de sacarla"*) ok "(b) …y lo ajeno que trae" ;; *) mal "(b) no nombra lo ajeno: $LINE" ;; esac
  case "$WARN" in *"sigue en $LAB_HOME/.claude/skills/bizuit-sdd/$OLD"*) ok "(c) el original ya copiado se nombra" ;; *) mal "(c) no nombra el original: $WARN" ;; esac
  case "$WARN" in *"la casa de sus datos es $(CASA) (existe"*) ok "(d) la casa resuelta, con warn (AC 36)" ;; *) mal "(d) no dice la casa como warn: $WARN" ;; esac
  # (e) dos updates: la spec escrita en el árbol se guarda en kept- antes de mandar previous/ a trash/, y se nombra
  actualiza; actualiza
  KEPT="$(ls -d "$LAB_HOME"/.tycon/team/kept-*/previous/$SKILL/processes/x/spec.md 2>/dev/null | head -1)"
  [ -n "$KEPT" ] && ok "(e) la spec quedó en ~/.tycon/team/kept-…/previous/" || mal "(e) no quedó en kept-: $(ls -R "$LAB_HOME/.tycon/team" 2>&1 | head -20)"
  case "$UPD_OUT" in *"guardado en"*"previous/$SKILL/processes/x/spec.md"*) ok "(e) …y la salida la nombra" ;; *) mal "(e) la salida no la nombra: $UPD_OUT" ;; esac
  # (e') rollback tampoco toca la casa de los datos (nada del arnés la borra)
  CASA_H="$(shasum "$(CASA)" 2>/dev/null | cut -c1-40)"
  OUT="$(harness_release rollback 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(shasum "$(CASA)" 2>/dev/null | cut -c1-40)" = "$CASA_H" ] && [ -n "$CASA_H" ] && ok "(e') rollback deja la casa igual" || mal "(e') rollback rc $RC, casa $(ls -la "$(CASA)" 2>&1): $OUT"
  # (f) uninstall: lo de dentro de la skill se guarda y se nombra; `deja:` nombra la casa
  mkdir -p "$(NEW)/$SKILL/processes/y"; printf '# otra\n' > "$(NEW)/$SKILL/processes/y/spec.md"
  OUT="$(harness_release uninstall --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "(f) uninstall sale 0" || mal "(f) uninstall rc $RC: $OUT"
  case "$OUT" in *"harness/$SKILL/processes/y/spec.md"*) ok "(f) la spec dentro de la skill se guardó y se nombra" ;; *) mal "(f) no se nombra: $OUT" ;; esac
  ls "$LAB_HOME"/.tycon/team/kept-*/harness/$SKILL/processes/y/spec.md >/dev/null 2>&1 && ok "(f) …en kept-…/harness/" || mal "(f) no está en kept-"
  case "$OUT" in *"deja:"*"$LAB_HOME/.bizuit-sdd"*) ok "(f) deja: nombra la casa de los datos" ;; *) mal "(f) deja: no nombra la casa: $OUT" ;; esac
  [ -f "$(CASA)" ] && ok "(f) la casa sigue (nada del arnés la borra)" || mal "(f) uninstall borró la casa"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
  # (g) sin capa: ninguna línea nueva
  lab_c "$BASE/lab36b"
  mkdir -p "$LAB_HOME/.claude/skills/bizuit-sdd"; printf '1.0.0\n' > "$LAB_HOME/.claude/skills/bizuit-sdd/VERSION"
  OUT="$(harness install --version latest --yes 2>&1)"; RC=$?
  JSON="$(harness_release doctor --json 2>/dev/null)"
  case "$JSON" in *"bizuit-sdd"*|*"lista fija"*) mal "(g) sin capa, doctor dice algo de la skill: $(printf '%s' "$JSON" | jtxt "d['warn']")" ;; *) ok "(g) sin capa, ninguna línea nueva" ;; esac
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# la casa REAL del dev: igual por hash antes y después
[ "$(casa_hash "$REAL_CASA")" = "$REAL_ANTES" ] && ok "la casa real del dev ($REAL_CASA) no se tocó" || mal "la casa real del dev cambió"

[ "$FALLOS" = 0 ] && { echo "✅ harness-team-skill-data: todo en verde"; exit 0; }
echo "❌ harness-team-skill-data: $FALLOS falla(s)"; exit 1
