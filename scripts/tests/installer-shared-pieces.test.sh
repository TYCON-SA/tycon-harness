#!/usr/bin/env bash
# installer-shared-pieces.test.sh — las tres piezas que el aplicador y `harness.js` COMPARTEN (story 8.13, tanda D · AC 28,
# la parte de T36 que no depende del enganche).
#
# Qué se protege: `cleanupPeriodDays`, la variable de `env` (`CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR`) y la copia de
# `<árbol>/commands/` a `~/.claude/commands/` las escribía sólo `install-tycon-hooks.sh`; en Windows no las hacía nadie.
# `scripts/setup/harness/shared.js` las hace desde Node, con las mismas reglas, y devuelve la lista de piezas con la forma
# del reporte del aplicador. Acá se prueba el MÓDULO, llamado directo sobre una HOME de juguete:
#
#   S1 · Shared_FreshHome_ThreePiecesAndList — deja las tres piezas y devuelve su lista (forma del reporte, `where`
#        absoluto, `value` en los ajustes), el nombre de la clase y el de la variable con que `harness.js` avisa.
#   S2 · Shared_DevValueWins_NotRecorded — el dev ya fijó otro valor: no se pisa y no se anota (y el espejo: lo sano sí).
#   S3 · Shared_CommandsSyncOff_AndOwnCommands — `TYCON_NO_COMMANDS_SYNC=1` apaga la copia; un comando propio del dev
#        queda; uno del arnés que quedó viejo se pone al día; uno que no se pudo copiar no se anota.
#   S4 · Shared_Idempotent_ByteForByte — la segunda corrida no cambia ni un byte de la HOME.
#   S5 · Shared_SettingsMissingEmptyBlank_AsEmptyObject — sin archivo, vacío o sólo espacios: como `{}`.
#   S6 · Shared_SettingsUnreadable_NotOverwritten — ilegible, o con otra forma: no se pisa, se dice, no se escribe nada.
#   S7 · Shared_Backup_StandaloneYes_UnderHarnessNo — suelto deja `settings.json.bak.<ts>`; con la copia del mecanismo, no.
#   S8 · Shared_RunsFromFixedCopy_OnlyOwnFolder — corre copiado a otra carpeta, sin `require` fuera de la suya.
#   S9 · Shared_PiecesAreRegistryPieces — las piezas pasan por `managed.parseReport`, `managed.present` las ve y
#        `remove.js` las quita (lo que `uninstall` necesita); `union` no duplica las que el aplicador también reportó.
#   S10 · Shared_ByteForByte_AgainstRealInstaller — el `install-tycon-hooks.sh` REAL corrido suelto en otra HOME, con la
#        misma entrada: el mismo `settings.json` por `cmp`, los mismos comandos y las mismas piezas. De paso: suelto, el
#        instalador sigue haciendo las tres piezas y la normalización `--ff-only --autostash` del pull (No-regresión).
#
#   S11 · Applier_UnderSharedDone_SkipsThree_LockOnlyDoesThem — el enganche del lado del `.sh` (T36): bajo la variable de
#        `shared.DONE_ENV` saltea las tres piezas y NO las reporta; con sólo `TYCON_HARNESS_LOCK_HELD=1` (un programa
#        viejo) las sigue haciendo; la normalización del pull corre en los dos. El módulo + el `.sh` bajo la variable
#        dejan el mismo `settings.json` que el `.sh` suelto, por `cmp`, en los dos órdenes. Y sin settings.json, el orden
#        que iguala al suelto es el `.sh` primero (su esqueleto trae `"$schema"`).
#   S12 · Shared_WriteRetriesWhenBusy_GivesUpClean — la escritura en Windows: si el reemplazo de settings.json falla por
#        «ocupado» (EBUSY, EPERM, EACCES) reintenta ESPERANDO (50 y 100 ms, como `state.js`) y escribe; si sigue ocupado
#        se rinde limpio (`ok: false`, nada escrito, ni temporal ni `.bak` tirados); otro código no se reintenta.
#   S13 · Shared_GivesUp_NamesWhatItCouldNotRemove — si al rendirse TAMPOCO puede borrar su temporal o su `.bak` (el
#        mismo programa que tiene ocupado el archivo), el motivo nombra la ruta de lo que quedó; si los borró, no.
#
# El enganche del lado de `harness.js` (install y apply dejan las piezas en `managed` y `uninstall` las quita;
# `install --from-existing` no las hace; un rollback no las quita ni las duplica) está en harness-install.test.sh (T36, con
# el aplicador de juguete) y en harness-uninstall.test.sh (T18 y T26, con el aplicador real).
#
# Aislamiento (el de harness-uninstall.test.sh): HOME de juguete, agent-skills vacío de juguete (nunca un enlace al real),
# sin perfil del equipo, sin Codex, sin el examen ni launchd, sin terceros, sin hooks de git, sin la tanda de fondo, sin
# red. Nunca ~/.claude ni el checkout real. 🔴 Sin pipes sobre el comando medido: el exit code REAL es el veredicto.
#
# Uso: bash scripts/tests/installer-shared-pieces.test.sh [--only S1|…|S13]
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MOD="$RAIZ/scripts/setup/harness/shared.js"
INST="$RAIZ/scripts/install-tycon-hooks.sh"
ONLY=""; [ "${1:-}" = "--only" ] && ONLY="${2:-}"
corre() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
# ── La suite corre por partes (story 8.22, tramo F: ninguna suite pasa de 45 s en la validación de una rama). Entera
# —a mano— corre todos los casos; como parte (`installer-shared-pieces.p<k>.test.sh`), sólo los suyos: S11, que corre el
# instalador de verdad una docena de veces, va solo en la parte 2. Cada caso arma su HOME: ninguno depende de otro
# (scripts/tests/lib/suite-parts.sh).
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/suite-parts.sh"
suite_parts 2
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
T="$(mktemp -d "${TMPDIR:-/tmp}/shared-pieces.XXXXXX")"
case "$T" in *tycon-claude-guides*|*agent-skills*|*/.claude*) echo "❌ installer-shared-pieces: el laboratorio cayó en ${T}"; exit 1 ;; esac
trap 'rm -rf "$T"' EXIT

VAR_ENV="CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR"

# Lo que se borra del ambiente de quien corre la suite (podría estar corriendo bajo harness.js, o con sus interruptores).
ENV_UNSET=(-u TYCON_SETTINGS_PATH -u CLAUDE_MD_PATH -u CODEX_AGENTS_MD_PATH -u TYCON_HARNESS_SNAPSHOT_DIR -u TYCON_REPORT_PIECES
     -u TYCON_HARNESS_LOCK_HELD -u TYCON_HARNESS_SHARED_DONE -u TYCON_NO_AUTOINSTALL -u TYCON_NO_CLAUDEMD_SYNC
     -u TYCON_NO_COMMANDS_SYNC -u TYCON_NO_GIT_HOOKS -u TYCON_THIRD_PARTY -u TYCON_ENGRAM_HOOK -u TYCON_SAFETY_GUARD
     -u TYCON_TEST_SCOPE_GUARD -u TYCON_SESSION_GUARD -u TYCON_TG_ZOMBIE_SWEEP -u TYCON_CLOCKIFY -u TYCON_ENGRAM
     -u TYCON_NIGHTLY -u TYCON_ADO_ORG -u ADO_ORG -u TYCON_REPOS_ROOT -u TF_BUILD -u XDG_CONFIG_HOME -u TYCON_GUIDES_DIR
     -u TYCON_SKILLS_DIR -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE -u GIT_COMMON_DIR)

# ── el árbol de juguete: sus comandos, y lo que NO es un comando ───────────────────────────────────────────────────
TREE="$T/tree"; mkdir -p "$TREE/commands/sub"
printf '# comando uno\ncon eñe y 🔴\n' > "$TREE/commands/lab-one.md"
printf '# comando dos\n' > "$TREE/commands/lab-two.md"
printf 'no es un comando\n' > "$TREE/commands/notes.txt"          # otra extensión: no se copia
printf '# oculto\n' > "$TREE/commands/.hidden.md"                 # el `*.md` de bash no lo ve: tampoco se copia
printf '# adentro\n' > "$TREE/commands/sub/inner.md"              # una carpeta: no se baja

# call <home> <salida.json> [VAR=valor…] — la función del módulo, directa (`node -e`), con el árbol $TREE (o LAB_TREE)
call() {
  local h="$1" out="$2"; shift 2
  # TYCON_NO_MODS=1: la carpeta de los mods (story 7.27) la prueba harness-mods.test.js; acá, los dos ajustes de siempre
  env "${ENV_UNSET[@]}" HOME="$h" TYCON_NO_MODS=1 LAB_TREE="${LAB_TREE:-$TREE}" LAB_MOD="${LAB_MOD:-$MOD}" "$@" node -e '
    const S = require(process.env.LAB_MOD);
    const r = S.applyShared({ home: process.env.HOME, env: process.env, tree: process.env.LAB_TREE });
    process.stdout.write(JSON.stringify(r) + "\n");
  ' > "$out" 2> "$out.err"
}
# q <resultado.json> <expresión sobre r> — un valor del resultado (texto tal cual; lo demás, en JSON)
q() {
  node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const v = new Function("r", "return (" + process.argv[2] + ")")(r);
    process.stdout.write(typeof v === "string" ? v : JSON.stringify(v === undefined ? null : v));' "$1" "$2" 2>/dev/null
}
# m <expresión sobre S> — un valor del módulo (sus constantes)
m() { node -e 'const S = require(process.argv[1]); const v = new Function("S", "return (" + process.argv[2] + ")")(S); process.stdout.write(typeof v === "string" ? v : JSON.stringify(v === undefined ? null : v));' "$MOD" "$1" 2>/dev/null; }
new_home() { rm -rf "$1"; mkdir -p "$1/.claude"; }
home_hash() { # todo lo que hay en la HOME: nombres, enlaces y bytes
  ( cd "$1" && find . -print | LC_ALL=C sort | while IFS= read -r f; do
      if [ -L "$f" ]; then printf '%s -> %s\n' "$f" "$(readlink "$f")"; elif [ -f "$f" ]; then printf '%s ' "$f"; shasum -a 256 < "$f"; else printf '%s/\n' "$f"; fi
    done ) | shasum -a 256 | cut -d' ' -f1
}
baks() { find "$1/.claude" -maxdepth 1 -name 'settings.json.bak*' 2>/dev/null | wc -l | tr -d ' '; }
# el settings.json que tiene que quedar cuando se parte de `{}`: el orden y el formato del python del aplicador
expected_from_empty() { printf '{\n  "hooks": {},\n  "cleanupPeriodDays": 365,\n  "env": {\n    "%s": "1"\n  }\n}\n' "$VAR_ENV"; }

if corre S1 && suite_part 1; then
  echo "S1 · Shared_FreshHome_ThreePiecesAndList"
  # 🔴 rojo previo: sin scripts/setup/harness/shared.js, `require` tira «Cannot find module» y no queda nada en la HOME.
  H="$T/s1"; new_home "$H"; echo '{"hooks":{}}' > "$H/.claude/settings.json"
  rc=0; call "$H" "$T/s1.json" || rc=$?
  [ "$rc" = "0" ] && [ "$(q "$T/s1.json" 'r.ok')" = "true" ] && ok "S1 el módulo corre y dice ok" \
    || { mal "S1 el módulo no corrió (rc $rc)"; head -3 "$T/s1.json.err" | sed 's/^/        /'; }
  expected_from_empty > "$T/s1-want.json"
  cmp -s "$T/s1-want.json" "$H/.claude/settings.json" && ok "S1 settings.json queda con cleanupPeriodDays=365 y la variable de env, en el formato del aplicador" \
    || { mal "S1 settings.json no quedó como lo deja el aplicador"; diff "$T/s1-want.json" "$H/.claude/settings.json" | head -8 | sed 's/^/        /'; }
  if cmp -s "$TREE/commands/lab-one.md" "$H/.claude/commands/lab-one.md" && cmp -s "$TREE/commands/lab-two.md" "$H/.claude/commands/lab-two.md" \
     && [ "$(ls -A "$H/.claude/commands" 2>/dev/null | LC_ALL=C sort | tr '\n' ' ')" = "lab-one.md lab-two.md " ]; then
    ok "S1 los comandos del árbol quedan en ~/.claude/commands (sólo los *.md de la raíz: ni ocultos, ni otra extensión, ni carpetas)"
  else
    mal "S1 ~/.claude/commands quedó con «$(ls -A "$H/.claude/commands" 2>/dev/null | tr '\n' ' ')»"
  fi
  # la lista: la forma del reporte del aplicador ({kind, where, id} y `value` sólo en los ajustes), where absoluto
  WANT="$(node -e 'const p = require("path"); const h = process.argv[1]; const s = p.resolve(h, ".claude", "settings.json");
    process.stdout.write(JSON.stringify([
      { kind: "setting", where: s, id: "cleanupPeriodDays", value: 365 },
      { kind: "setting", where: s, id: "env." + process.argv[2], value: "1" },
      { kind: "command", where: p.resolve(h, ".claude", "commands", "lab-one.md"), id: "lab-one.md" },
      { kind: "command", where: p.resolve(h, ".claude", "commands", "lab-two.md"), id: "lab-two.md" }]));' "$H" "$VAR_ENV")"
  [ "$(q "$T/s1.json" 'r.pieces')" = "$WANT" ] && ok "S1 devuelve las cuatro piezas con la forma del reporte (los dos ajustes con su valor, un comando por archivo)" \
    || mal "S1 la lista de piezas no es la esperada: $(q "$T/s1.json" 'r.pieces')"
  [ "$(q "$T/s1.json" 'r.origin')" = "shared" ] && [ "$(m 'S.ORIGIN')" = "shared" ] && ok "S1 la clase de las piezas es «shared» (en el resultado y como constante)" \
    || mal "S1 la clase no es «shared»: resultado «$(q "$T/s1.json" 'r.origin')», constante «$(m 'S.ORIGIN')»"
  DONE="$(m 'S.DONE_ENV')"
  case "$DONE" in
    TYCON_HARNESS_LOCK_HELD|TYCON_HARNESS_SNAPSHOT_DIR|"") mal "S1 la variable del aviso es «${DONE}»: tiene que ser propia (P6)" ;;
    TYCON_HARNESS_[A-Z_]*) ok "S1 el módulo exporta el nombre de la variable propia con que harness.js avisa al aplicador (${DONE})" ;;
    *) mal "S1 la variable del aviso «${DONE}» no es de la familia TYCON_HARNESS_*" ;;
  esac
  # isShared: las devueltas sí; un hook o un ajuste ajeno, no (el espejo)
  [ "$(node -e 'const S = require(process.argv[1]); const r = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
      const yes = r.pieces.length === 4 && r.pieces.every((p) => S.isShared(p));
      const no = [{ kind: "hook", where: "/x/settings.json", id: "Stop:@tcg:x.js" }, { kind: "setting", where: "/x/settings.json", id: "model", value: "x" },
        { kind: "setting", where: "/x/settings.json", id: "env.OTHER", value: "1" }, null, "x"].every((p) => !S.isShared(p));
      process.stdout.write(String(yes && no));' "$MOD" "$T/s1.json" 2>/dev/null)" = "true" ] \
    && ok "S1 isShared reconoce las piezas compartidas y no un hook ni un ajuste ajeno" || mal "S1 isShared no distingue las piezas compartidas"
  # lo que escribió esta corrida, para el resumen de quien llama
  [ "$(q "$T/s1.json" 'r.changed')" = "[\"cleanupPeriodDays\",\"env.${VAR_ENV}\",\"command:lab-one.md\",\"command:lab-two.md\"]" ] \
    && ok "S1 «changed» nombra lo que escribió esta corrida" || mal "S1 changed = $(q "$T/s1.json" 'r.changed')"
fi

if corre S2 && suite_part 1; then
  echo "S2 · Shared_DevValueWins_NotRecorded"
  # 🔴 rojo previo: sin el módulo no hay resultado; con un módulo que pisara, `cmp` contra el original falla.
  H="$T/s2"; new_home "$H"
  printf '{"hooks":{},"cleanupPeriodDays":90,"env":{"%s":"0","MIA":"x"}}' "$VAR_ENV" > "$H/.claude/settings.json"
  cp "$H/.claude/settings.json" "$T/s2-before.json"
  call "$H" "$T/s2.json"
  cmp -s "$T/s2-before.json" "$H/.claude/settings.json" && [ "$(baks "$H")" = "0" ] && [ "$(q "$T/s2.json" 'r.changed')" = '["command:lab-one.md","command:lab-two.md"]' ] \
    && ok "S2 con los dos valores fijados por el dev, settings.json no cambia ni un byte (ni queda .bak); los comandos se copian igual" \
    || mal "S2 el módulo tocó un settings.json donde el dev ya había fijado los dos valores"
  [ "$(q "$T/s2.json" 'r.pieces.filter((p) => p.kind === "setting").length')" = "0" ] && [ "$(q "$T/s2.json" 'r.ok')" = "true" ] \
    && ok "S2 los ajustes del dev no se anotan (y no es un fallo)" || mal "S2 anotó un ajuste que es del dev: $(q "$T/s2.json" 'r.pieces')"
  [ "$(q "$T/s2.json" 'r.notes.filter((n) => /gana|fijaste|tuy/.test(n)).length')" = "2" ] \
    && ok "S2 lo dice: una nota por cada valor que respetó" || mal "S2 no dijo que respetó los valores del dev: $(q "$T/s2.json" 'r.notes')"
  # uno del dev y el otro no: el que falta se escribe y se anota; el del dev queda (null también es «la fijó»)
  new_home "$H"; printf '{"cleanupPeriodDays":null,"env":{"MIA":"x"}}' > "$H/.claude/settings.json"
  call "$H" "$T/s2b.json"
  GOT="$(python3 -c "import json,sys; s=json.load(open(sys.argv[1])); print(json.dumps([list(s), s['cleanupPeriodDays'], s['env']]))" "$H/.claude/settings.json")"
  [ "$GOT" = "[[\"cleanupPeriodDays\", \"env\", \"hooks\"], null, {\"MIA\": \"x\", \"${VAR_ENV}\": \"1\"}]" ] \
    && [ "$(q "$T/s2b.json" 'r.pieces.filter((p) => p.kind === "setting").map((p) => p.id)')" = "[\"env.${VAR_ENV}\"]" ] \
    && ok "S2 uno del dev (null) y el otro ausente: el ausente se escribe y se anota, el del dev queda, lo demás de env también" \
    || mal "S2 con uno y uno quedó ${GOT} · piezas $(q "$T/s2b.json" 'r.pieces')"
  # el valor del arnés que YA estaba (lo puso una corrida anterior o el propio aplicador) sí se anota, sin escribir
  new_home "$H"; printf '{"hooks":{},"cleanupPeriodDays":365.0,"env":{"%s":"1"}}' "$VAR_ENV" > "$H/.claude/settings.json"
  cp "$H/.claude/settings.json" "$T/s2-before.json"
  call "$H" "$T/s2c.json"
  cmp -s "$T/s2-before.json" "$H/.claude/settings.json" && [ "$(q "$T/s2c.json" 'r.pieces.filter((p) => p.kind === "setting").length')" = "2" ] \
    && ok "S2 (espejo) los valores del arnés que ya estaban se anotan, y el archivo no se reescribe" \
    || mal "S2 (espejo) los valores del arnés que ya estaban no se anotaron, o el archivo cambió"
  # la variable con el valor en otro tipo (1 número) es del dev, como en el python (`env[k] != v`)
  new_home "$H"; printf '{"hooks":{},"env":{"%s":1}}' "$VAR_ENV" > "$H/.claude/settings.json"
  call "$H" "$T/s2d.json"
  [ "$(q "$T/s2d.json" 'r.pieces.filter((p) => p.kind === "setting").map((p) => p.id)')" = '["cleanupPeriodDays"]' ] \
    && grep -q "\"${VAR_ENV}\": 1\$" "$H/.claude/settings.json" \
    && ok "S2 la variable con otro tipo (1, número) es del dev: queda y no se anota" || mal "S2 pisó o anotó la variable que el dev fijó en 1 (número)"
fi

if corre S3 && suite_part 1; then
  echo "S3 · Shared_CommandsSyncOff_AndOwnCommands"
  # 🔴 rojo previo: sin el módulo, ni «no copia» ni «copia» se pueden afirmar (no hay resultado).
  H="$T/s3"; new_home "$H"; echo '{"hooks":{}}' > "$H/.claude/settings.json"
  call "$H" "$T/s3.json" TYCON_NO_COMMANDS_SYNC=1
  [ ! -e "$H/.claude/commands" ] && [ "$(q "$T/s3.json" 'r.pieces.filter((p) => p.kind === "command").length')" = "0" ] \
    && [ "$(q "$T/s3.json" 'r.pieces.filter((p) => p.kind === "setting").length')" = "2" ] \
    && ok "S3 con TYCON_NO_COMMANDS_SYNC=1 no se crea la carpeta ni se anota ningún comando (los ajustes, sí)" \
    || mal "S3 con TYCON_NO_COMMANDS_SYNC=1 quedó commands/ o un comando anotado: $(q "$T/s3.json" 'r.pieces')"
  # el espejo: con la variable en 0 (sólo «1» apaga), se copian
  call "$H" "$T/s3b.json" TYCON_NO_COMMANDS_SYNC=0
  [ "$(q "$T/s3b.json" 'r.pieces.filter((p) => p.kind === "command").length')" = "2" ] && [ -f "$H/.claude/commands/lab-one.md" ] \
    && ok "S3 (espejo) con TYCON_NO_COMMANDS_SYNC=0 los comandos se copian y se anotan" || mal "S3 (espejo) con la variable en 0 no copió los comandos"
  # uno propio del dev queda; uno del arnés que quedó viejo se pone al día; uno que no se puede copiar no se anota
  new_home "$H"; echo '{"hooks":{}}' > "$H/.claude/settings.json"; mkdir -p "$H/.claude/commands/lab-two.md"
  printf '# mío\n' > "$H/.claude/commands/mine.md"; printf '# versión vieja\n' > "$H/.claude/commands/lab-one.md"
  rc=0; call "$H" "$T/s3c.json" || rc=$?
  [ "$rc" = "0" ] && [ "$(cat "$H/.claude/commands/mine.md")" = "# mío" ] && cmp -s "$TREE/commands/lab-one.md" "$H/.claude/commands/lab-one.md" \
    && ok "S3 un comando propio del dev queda intacto y uno del arnés que quedó viejo se pone al día" \
    || mal "S3 tocó un comando propio o no puso al día el del arnés (rc $rc)"
  [ "$(q "$T/s3c.json" 'r.pieces.filter((p) => p.kind === "command").map((p) => p.id)')" = '["lab-one.md"]' ] && [ -d "$H/.claude/commands/lab-two.md" ] \
    && ok "S3 un comando que no se pudo copiar (hay una carpeta en su lugar) no se anota, y el módulo no tira" \
    || mal "S3 anotó un comando que no pudo copiar: $(q "$T/s3c.json" 'r.pieces')"
  # un árbol sin commands/: ni carpeta ni piezas (la copia pública puede no traerla)
  new_home "$H"; echo '{"hooks":{}}' > "$H/.claude/settings.json"; mkdir -p "$T/tree-bare"
  LAB_TREE="$T/tree-bare" call "$H" "$T/s3d.json"
  [ ! -e "$H/.claude/commands" ] && [ "$(q "$T/s3d.json" 'r.ok')" = "true" ] && ok "S3 un árbol sin commands/ no crea la carpeta ni falla" \
    || mal "S3 con un árbol sin commands/ quedó ~/.claude/commands o falló"
fi

if corre S4 && suite_part 1; then
  echo "S4 · Shared_Idempotent_ByteForByte"
  # 🔴 rojo previo: sin el módulo las dos corridas fallan igual y la primera no deja las piezas (lo ve el primer chequeo).
  H="$T/s4"; new_home "$H"; printf '{\n    "permissions": {"allow": ["Bash(ls:*)"]},\n    "hooks": {}\n}\n' > "$H/.claude/settings.json"
  call "$H" "$T/s4a.json"; A="$(home_hash "$H")"
  [ "$(q "$T/s4a.json" 'r.changed.length')" = "4" ] && ok "S4 la primera corrida escribe las cuatro piezas" || mal "S4 la primera corrida escribió $(q "$T/s4a.json" 'r.changed')"
  call "$H" "$T/s4b.json"; B="$(home_hash "$H")"
  [ "$A" = "$B" ] && [ -f "$H/.claude/commands/lab-one.md" ] && [ "$(baks "$H")" = "1" ] \
    && ok "S4 la segunda corrida no cambia ni un byte de la HOME (ni un .bak nuevo: queda el de la primera)" || mal "S4 la segunda corrida cambió la HOME (o la primera no dejó nada)"
  [ "$(q "$T/s4a.json" 'r.pieces')" = "$(q "$T/s4b.json" 'r.pieces')" ] && [ "$(q "$T/s4b.json" 'r.changed')" = "[]" ] \
    && ok "S4 la segunda corrida devuelve las mismas piezas (las que ya estaban también son del arnés) y «changed» vacío" \
    || mal "S4 la segunda corrida devolvió otras piezas o dijo que cambió algo: $(q "$T/s4b.json" 'r.changed')"
fi

if corre S5 && suite_part 1; then
  echo "S5 · Shared_SettingsMissingEmptyBlank_AsEmptyObject"
  # 🔴 rojo previo: sin el módulo el archivo no aparece (o queda vacío como estaba).
  expected_from_empty > "$T/s5-want.json"
  H="$T/s5"; rm -rf "$H"; mkdir -p "$H"      # ni siquiera ~/.claude
  call "$H" "$T/s5a.json"
  cmp -s "$T/s5-want.json" "$H/.claude/settings.json" && [ "$(baks "$H")" = "0" ] && [ "$(q "$T/s5a.json" 'r.pieces.length')" = "4" ] \
    && ok "S5 sin settings.json (ni ~/.claude): nace con las dos claves, sin .bak" || mal "S5 sin settings.json no quedó el esperado"
  new_home "$H"; : > "$H/.claude/settings.json"
  call "$H" "$T/s5b.json"
  cmp -s "$T/s5-want.json" "$H/.claude/settings.json" && ok "S5 un settings.json vacío se trata como {}" || mal "S5 un settings.json vacío no se trató como {}"
  new_home "$H"; printf ' \n\t\n' > "$H/.claude/settings.json"
  call "$H" "$T/s5c.json"
  cmp -s "$T/s5-want.json" "$H/.claude/settings.json" && [ "$(q "$T/s5c.json" 'r.ok')" = "true" ] \
    && ok "S5 un settings.json con sólo espacios se trata como {}" || mal "S5 un settings.json con sólo espacios no se trató como {}"
  # TYCON_SETTINGS_PATH mueve el archivo (como en el aplicador) y el `where` de las piezas lo sigue
  new_home "$H"; mkdir -p "$T/s5-other"; echo '{}' > "$T/s5-other/mine.json"
  call "$H" "$T/s5d.json" TYCON_SETTINGS_PATH="$T/s5-other/mine.json"
  cmp -s "$T/s5-want.json" "$T/s5-other/mine.json" && [ ! -e "$H/.claude/settings.json" ] \
    && [ "$(q "$T/s5d.json" 'r.pieces[0].where')" = "$(node -p 'require("path").resolve(process.argv[1])' "$T/s5-other/mine.json")" ] \
    && ok "S5 con TYCON_SETTINGS_PATH escribe ese archivo, no el de la HOME, y las piezas lo nombran" || mal "S5 no respetó TYCON_SETTINGS_PATH"
fi

if corre S6 && suite_part 1; then
  echo "S6 · Shared_SettingsUnreadable_NotOverwritten"
  # 🔴 rojo previo: sin el módulo no hay `ok: false` ni motivo; con uno que pisara, `cmp` contra el original falla.
  H="$T/s6"
  for caso in 'ilegible|{"hooks": {' 'arreglo|[1, 2]' 'env-texto|{"hooks":{},"env":"x"}' 'texto|"hola"'; do
    nombre="${caso%%|*}"; cuerpo="${caso#*|}"
    new_home "$H"; printf '%s' "$cuerpo" > "$H/.claude/settings.json"; cp "$H/.claude/settings.json" "$T/s6-before"
    rc=0; call "$H" "$T/s6.json" || rc=$?
    if [ "$rc" = "0" ] && cmp -s "$T/s6-before" "$H/.claude/settings.json" && [ "$(q "$T/s6.json" 'r.ok')" = "false" ] \
       && [ "$(q "$T/s6.json" 'r.pieces.length')" = "0" ] && [ -n "$(q "$T/s6.json" 'r.reason')" ] && [ "$(q "$T/s6.json" 'r.reason')" != "null" ] \
       && [ ! -e "$H/.claude/commands" ] && [ "$(baks "$H")" = "0" ]; then
      ok "S6 settings.json ${nombre}: no se pisa, no se escribe nada (ni comandos ni .bak), ok:false con su motivo, sin tirar"
    else
      mal "S6 settings.json ${nombre}: rc $rc · ok $(q "$T/s6.json" 'r.ok') · motivo «$(q "$T/s6.json" 'r.reason')» · piezas $(q "$T/s6.json" 'r.pieces.length')"
    fi
  done
  # el espejo: lo mismo con un settings.json sano sí escribe (S1); y un BOM delante no lo hace ilegible ni se pierde
  new_home "$H"; printf '\xef\xbb\xbf{"hooks":{}}' > "$H/.claude/settings.json"
  call "$H" "$T/s6b.json"
  [ "$(q "$T/s6b.json" 'r.ok')" = "true" ] && [ "$(head -c 3 "$H/.claude/settings.json" | od -An -tx1 | tr -d ' \n')" = "efbbbf" ] \
    && [ "$(q "$T/s6b.json" 'r.pieces.filter((p) => p.kind === "setting").length')" = "2" ] \
    && ok "S6 (espejo) un settings.json con BOM se lee, se escribe y conserva su BOM" || mal "S6 (espejo) un settings.json con BOM no se pudo leer o perdió el BOM"
fi

if corre S7 && suite_part 1; then
  echo "S7 · Shared_Backup_StandaloneYes_UnderHarnessNo"
  # 🔴 rojo previo: sin el módulo no hay escritura ni .bak que contar.
  H="$T/s7"; new_home "$H"; echo '{"hooks":{},"model":"x"}' > "$H/.claude/settings.json"; cp "$H/.claude/settings.json" "$T/s7-before.json"
  call "$H" "$T/s7.json"
  BAK="$(find "$H/.claude" -maxdepth 1 -name 'settings.json.bak.*' | head -1)"
  [ "$(baks "$H")" = "1" ] && cmp -s "$T/s7-before.json" "$BAK" && ok "S7 suelto, antes de escribir deja settings.json.bak.<ts> con lo que había" \
    || mal "S7 suelto no dejó la copia .bak de lo que había (hay $(baks "$H"))"
  new_home "$H"; echo '{"hooks":{},"model":"x"}' > "$H/.claude/settings.json"; mkdir -p "$T/s7-snap"
  call "$H" "$T/s7b.json" TYCON_HARNESS_SNAPSHOT_DIR="$T/s7-snap"
  [ "$(baks "$H")" = "0" ] && grep -q '"cleanupPeriodDays": 365' "$H/.claude/settings.json" \
    && ok "S7 con la copia del mecanismo ya tomada (TYCON_HARNESS_SNAPSHOT_DIR) escribe sin dejar .bak" || mal "S7 bajo harness.js quedó un .bak, o no escribió"
  # la opción explícita le gana a la variable (harness.js sin copia posible pide el .bak de siempre)
  new_home "$H"; echo '{"hooks":{}}' > "$H/.claude/settings.json"
  env "${ENV_UNSET[@]}" HOME="$H" TYCON_NO_MODS=1 TYCON_HARNESS_SNAPSHOT_DIR="$T/s7-snap" node -e '
    const S = require(process.argv[1]);
    S.applyShared({ home: process.env.HOME, env: process.env, tree: process.argv[2], backup: true });' "$MOD" "$TREE" 2>/dev/null
  [ "$(baks "$H")" = "1" ] && ok "S7 con backup: true deja el .bak aunque la variable esté puesta" || mal "S7 backup: true no dejó el .bak"
  # los permisos del archivo no se abren: uno 600 sigue 600
  new_home "$H"; echo '{"hooks":{}}' > "$H/.claude/settings.json"; chmod 600 "$H/.claude/settings.json"
  call "$H" "$T/s7c.json"
  [ "$(node -p '(require("fs").statSync(process.argv[1]).mode & 0o777).toString(8)' "$H/.claude/settings.json")" = "600" ] \
    && grep -q '"cleanupPeriodDays": 365' "$H/.claude/settings.json" \
    && ok "S7 un settings.json con permisos 600 los conserva después de la escritura" || mal "S7 la escritura cambió los permisos de settings.json (o no escribió)"
fi

if corre S8 && suite_part 1; then
  echo "S8 · Shared_RunsFromFixedCopy_OnlyOwnFolder"
  # 🔴 rojo previo: sin el archivo no hay nada que copiar ni que leer.
  mkdir -p "$T/fixed/program"; cp -R "$RAIZ/scripts/setup/harness" "$T/fixed/program/harness"
  H="$T/s8"; new_home "$H"; echo '{"hooks":{}}' > "$H/.claude/settings.json"
  rc=0; LAB_MOD="$T/fixed/program/harness/shared.js" call "$H" "$T/s8.json" || rc=$?
  [ "$rc" = "0" ] && [ "$(q "$T/s8.json" 'r.pieces.length')" = "4" ] && ok "S8 copiado a la carpeta de la copia fija, lejos del árbol, hace las piezas igual" \
    || { mal "S8 desde la copia fija no corrió (rc $rc)"; head -3 "$T/s8.json.err" | sed 's/^/        /'; }
  OUTSIDE="$(grep -o "require([^)]*)" "$MOD" 2>/dev/null | grep -v -E "require\('(fs|os|path|crypto|child_process)'\)|require\('\./[A-Za-z0-9_.-]+'\)|tycon-config" || true)"
  [ -f "$MOD" ] && [ -z "$OUTSIDE" ] && ok "S8 el módulo sólo requiere módulos de Node y de su propia carpeta" \
    || mal "S8 el módulo requiere algo de afuera de su carpeta: ${OUTSIDE:-no existe}"
fi

if corre S9 && suite_part 1; then
  echo "S9 · Shared_PiecesAreRegistryPieces"
  # 🔴 rojo previo: sin el módulo no hay piezas que pasarle a managed.js ni a remove.js.
  H="$T/s9"; new_home "$H"; printf '{"model":"x","env":{"MIA":"x"}}' > "$H/.claude/settings.json"
  printf '# mío\n' > "$T/s9-mine.md"; mkdir -p "$H/.claude/commands"; cp "$T/s9-mine.md" "$H/.claude/commands/mine.md"
  call "$H" "$T/s9.json"
  env "${ENV_UNSET[@]}" HOME="$H" TYCON_NO_MODS=1 node -e '
    const path = require("path"); const fs = require("fs");
    const [dir, resFile, tree] = process.argv.slice(1);
    const S = require(path.join(dir, "shared.js")), M = require(path.join(dir, "managed.js")), R = require(path.join(dir, "remove.js"));
    const home = process.env.HOME, env = process.env;
    const pieces = JSON.parse(fs.readFileSync(resFile, "utf8")).pieces;
    const out = {};
    const rep = M.parseReport(JSON.stringify(pieces));
    out.report = rep.ok && JSON.stringify(rep.pieces) === JSON.stringify(pieces);
    out.present = pieces.every((p) => M.present(p, { home, env }) === true);
    // union: lo que el aplicador también reportó no se duplica; lo suyo queda primero y entero
    const hook = { kind: "hook", where: pieces[0].where, id: "Stop:@tcg:x.js" };
    const u = S.union([hook, pieces[0]], pieces);
    out.union = u.length === pieces.length + 1 && u[0] === hook && new Set(u.map((p) => [p.kind, p.where, p.id].join("|"))).size === u.length;
    out.unionNull = JSON.stringify(S.union(null, pieces)) === JSON.stringify(pieces) && S.union([hook], null).length === 1;
    // el dev cambia un valor después: esa pieza deja de estar (se cae del registro) y remove.js no la quita
    const s = JSON.parse(fs.readFileSync(pieces[0].where, "utf8")); s.cleanupPeriodDays = 30; fs.writeFileSync(pieces[0].where, JSON.stringify(s, null, 2) + "\n");
    out.changedGone = M.present(pieces[0], { home, env }) === false;
    const r = R.removePieces(pieces, { home, env, tree });
    const after = JSON.parse(fs.readFileSync(pieces[0].where, "utf8"));
    out.removed = r.removed.length === pieces.length - 1 && r.kept.length === 1 && r.kept[0].piece.id === "cleanupPeriodDays";
    // `hooks: {}` queda, como con el aplicador (que lo crea donde no había): `uninstall` lo ignora al comparar con la copia
    out.settings = JSON.stringify(after) === JSON.stringify({ model: "x", env: { MIA: "x" }, hooks: {}, cleanupPeriodDays: 30 });
    out.commands = fs.readdirSync(path.join(home, ".claude", "commands")).join(",") === "mine.md";
    process.stdout.write(JSON.stringify(out) + "\n");' "$RAIZ/scripts/setup/harness" "$T/s9.json" "$TREE" > "$T/s9-out.json" 2> "$T/s9-out.err"
  for chk in 'report|la lista pasa por managed.parseReport sin perder ni cambiar nada (es la forma del reporte del aplicador)' \
             'present|managed.present ve cada pieza en la máquina (doctor no las da por faltantes)' \
             'union|union suma las compartidas al reporte del aplicador sin duplicar las que él también trajo' \
             'unionNull|union sin reporte (un aplicador viejo) o sin piezas devuelve lo que hay' \
             'changedGone|un valor que el dev cambia después deja de estar para managed.present (se cae del registro)' \
             'removed|remove.js quita las piezas compartidas y deja el ajuste que el dev cambió' \
             'settings|después de quitar, settings.json queda con lo del dev (el ajuste que cambió y su env)' \
             'commands|después de quitar, en ~/.claude/commands sólo queda el comando propio del dev'; do
    k="${chk%%|*}"
    [ "$(q "$T/s9-out.json" "r.$k")" = "true" ] && ok "S9 ${chk#*|}" || { mal "S9 ${chk#*|}"; head -3 "$T/s9-out.err" | sed 's/^/        /'; }
  done
fi

# ── el instalador REAL en una HOME de juguete (S10 y S11) ──────────────────────────────────────────────────────────
# Con un agent-skills que es un esqueleto vacío; el estado del mecanismo ya escrito evita que lance
# `install --from-existing`. Las HOME de un mismo caso se arman una detrás de otra EN LA MISMA RUTA (al terminar se
# apartan con `mv`): las rutas de los hooks que el instalador registra pueden llevar la HOME adentro, y así la misma
# entrada vale igual para todas.
installer_home() { rm -rf "$1"; mkdir -p "$1/.claude/agent-skills/skills/tycon-pipeline" "$1/.claude/.tycon-pipeline"; echo '{}' > "$1/.claude/.tycon-pipeline/harness-state.json"; }
run_installer() { # run_installer <home> <salida.txt> [VAR=valor…] [-- args del instalador]
  local h="$1" out="$2"; shift 2
  local extra=(); while [ $# -gt 0 ] && [ "$1" != "--" ]; do extra+=("$1"); shift; done; [ "${1:-}" = "--" ] && shift
  env "${ENV_UNSET[@]}" HOME="$h" TYCON_PROFILE=0 TYCON_CODEX=0 CODEX_HOME="$h/.codex" TYCON_GIT_HOOKS_DIR="$h/.git-hooks" \
    TYCON_NO_NIGHTLY_EXAM=1 TYCON_NO_GUI_ENV=1 TYCON_NO_GIT_HOOKS=1 TYCON_THIRD_PARTY=0 LAUNCHCTL_BIN=/usr/bin/true \
    TYCON_BENCH_DAILY=0 TYCON_STAGE_METRICS=0 TYCON_NO_THREAD_RESCUE=1 TYCON_NO_UPLOAD_RUNS=1 TYCON_NO_DOWNLOAD_RUNS=1 \
    TYCON_NO_COLLECT_FINDINGS=1 TYCON_MAILBOX_URL_BASE=http://127.0.0.1:9 TYCON_NO_AZ_PROJECTS_REFRESH=1 \
    TYCON_NO_ENGRAM_VERSION_CHECK=1 TYCON_NO_SQLITE_CHECK=1 TYCON_NO_ENGRAM_PROJECT_CHECK=1 TYCON_NO_AGENTSMD_POINTER=1 \
    TYCON_NO_CANONICAL_PATH=1 TYCON_NO_CLAUDEMD_SYNC=1 TYCON_NO_BOOTSTRAP_HEAL=1 TYCON_SAFETY_GUARD=0 TYCON_TEST_SCOPE_GUARD=0 \
    TYCON_SESSION_GUARD=0 TYCON_NO_MODS=1 GIT_CONFIG_NOSYSTEM=1 ${extra[@]+"${extra[@]}"} bash "$INST" "$@" > "$out" 2>&1
}

if corre S10 && suite_part 1; then
  echo "S10 · Shared_ByteForByte_AgainstRealInstaller"
  # 🔴 rojo previo: sin el módulo la HOME «M» queda con la entrada sin tocar y `cmp` contra la del instalador falla.
  # El instalador REAL, suelto (sin TYCON_HARNESS_LOCK_HELD). Son TRES HOME distintas (la que prepara la entrada, la del
  # instalador y la del módulo), cada una una carpeta nueva, armadas en la misma ruta (`$HH`).
  # 1. la entrada del dev: sangría propia, texto no ASCII, un hook y una variable suyos, y una línea de arranque vieja
  #    con los pull sin proteger
  HH="$T/s10-home"; P="$T/s10-p"; S="$T/s10-s"; M="$T/s10-m"
  installer_home "$HH"
  cat > "$HH/.claude/settings.json" <<'JSON'
{
    "permissions": { "allow": ["Bash(ls:*)", "Read(~/año/**)"], "deny": [] },
    "env": { "MIA": "señal 🔴" },
    "hooks": {
        "SessionStart": [
            { "hooks": [ { "type": "command", "command": "cd ~/.claude/tycon-claude-guides && git pull; cd ~/.claude/agent-skills && git pull --ff-only" } ] }
        ],
        "Stop": [ { "hooks": [ { "type": "command", "command": "echo \"fin\tde turno\"" } ] } ]
    }
}
JSON
  rc=0; run_installer "$HH" "$T/s10-p.txt" -- --report-json "$T/s10-p-report.json" || rc=$?
  if [ "$rc" != "0" ]; then mal "S10 el instalador real, suelto, salió $rc"; tail -15 "$T/s10-p.txt" | sed 's/^/        /'; fi
  # No-regresión (T36, «suelto»): las tres piezas y la normalización del pull
  SUELTO="$(python3 - "$HH/.claude/settings.json" "$T/s10-p-report.json" "$VAR_ENV" "$HH" "$RAIZ" <<'PY' 2>&1
import glob, json, os, sys
s = json.load(open(sys.argv[1], encoding="utf-8")); rep = json.load(open(sys.argv[2], encoding="utf-8"))
var, home, tree = sys.argv[3:6]
bad = []
if s.get("cleanupPeriodDays") != 365: bad.append("cleanupPeriodDays")
if s.get("env", {}).get(var) != "1" or s["env"].get("MIA") != "señal 🔴": bad.append("env")
line = s["hooks"]["SessionStart"][0]["hooks"][0]["command"]
if line != "cd ~/.claude/tycon-claude-guides && git pull --ff-only --autostash; cd ~/.claude/agent-skills && git pull --autostash --ff-only": bad.append("normalización: " + line)
ids = {(p["kind"], p["id"]) for p in rep}
names = [os.path.basename(c) for c in glob.glob(os.path.join(tree, "commands", "*.md"))]
for n in names:
    a, b = os.path.join(tree, "commands", n), os.path.join(home, ".claude", "commands", n)
    if not os.path.exists(b) or open(a, "rb").read() != open(b, "rb").read(): bad.append("comando " + n)
    if ("command", n) not in ids: bad.append("reporte sin el comando " + n)
if not names: bad.append("el árbol no trae comandos: la prueba no mide la copia")
for k in ("cleanupPeriodDays", "env." + var):
    if ("setting", k) not in ids: bad.append("reporte sin " + k)
print("; ".join(bad) if bad else "ok")
PY
)"
  [ "$SUELTO" = "ok" ] && ok "S10 suelto, el instalador real sigue haciendo y reportando las tres piezas, y normaliza el pull (--ff-only --autostash)" \
    || mal "S10 suelto, el instalador real ya no hace lo de siempre: ${SUELTO}"
  # 2. la MISMA entrada para los dos: lo que dejó el instalador, sin las tres piezas, y con OTRO formato (compacto,
  #    todo escapado a ASCII, sin salto final) más contenido difícil: los dos tienen que normalizarlo igual
  python3 - "$HH/.claude/settings.json" "$T/s10-in.json" "$VAR_ENV" <<'PY'
import json, sys
s = json.load(open(sys.argv[1], encoding="utf-8"))
del s["cleanupPeriodDays"]; del s["env"][sys.argv[3]]
ctl = "a" + chr(1) + "b" + chr(0x7f) + "c" + chr(0x2028) + "d\te\"f\\g/h</script>"   # control, DEL, separador de línea, tab, comilla, barras
s["raro"] = {"vacío": {}, "lista": [], "anidado": [[1, -2, {"a": None}], True, False], "ctl": ctl,
             "clave con espacio": "ñandú", "emoji": "🧉", "largo": 1234567890123}
with open(sys.argv[2], "w", encoding="utf-8") as f:
    json.dump(s, f, ensure_ascii=True, separators=(",", ":"))
PY
  mv "$HH" "$P"
  seed_same_input() { # la misma entrada y los mismos comandos previos: uno propio del dev y uno del arnés que quedó viejo
    installer_home "$HH"; cp "$T/s10-in.json" "$HH/.claude/settings.json"; mkdir -p "$HH/.claude/commands"
    printf '# mío\n' > "$HH/.claude/commands/mine.md"
    first="$(ls "$RAIZ/commands"/*.md | head -1)"; printf '# versión vieja\n' > "$HH/.claude/commands/$(basename "$first")"
  }
  seed_same_input
  rc=0; run_installer "$HH" "$T/s10-s.txt" -- --report-json "$T/s10-s-report.json" || rc=$?
  [ "$rc" = "0" ] || { mal "S10 el instalador real (segunda HOME) salió $rc"; tail -15 "$T/s10-s.txt" | sed 's/^/        /'; }
  mv "$HH" "$S"
  seed_same_input
  rc=0; LAB_TREE="$RAIZ" call "$HH" "$T/s10-m.json" || rc=$?
  [ "$rc" = "0" ] && [ "$(q "$T/s10-m.json" 'r.ok')" = "true" ] || { mal "S10 el módulo no corrió sobre la misma entrada (rc $rc)"; head -3 "$T/s10-m.json.err" | sed 's/^/        /'; }
  mv "$HH" "$M"
  if cmp -s "$S/.claude/settings.json" "$M/.claude/settings.json" && ! cmp -s "$T/s10-in.json" "$M/.claude/settings.json"; then
    ok "S10 con la misma entrada, el settings.json del módulo es BYTE A BYTE el del instalador real (orden, sangría, no ASCII, escapes, salto final)"
  else
    mal "S10 el settings.json del módulo difiere del que deja el instalador real con la misma entrada"
    diff "$S/.claude/settings.json" "$M/.claude/settings.json" | head -10 | sed 's/^/        /'
  fi
  diff -r "$S/.claude/commands" "$M/.claude/commands" > "$T/s10-commands.diff" 2>&1 \
    && ok "S10 ~/.claude/commands queda igual en las dos (los del árbol al día, el propio del dev intacto)" \
    || { mal "S10 ~/.claude/commands difiere entre el instalador y el módulo"; head -6 "$T/s10-commands.diff" | sed 's/^/        /'; }
  [ "$(baks "$S")" = "1" ] && [ "$(baks "$M")" = "1" ] && cmp -s "$T/s10-in.json" "$(find "$M/.claude" -maxdepth 1 -name 'settings.json.bak.*' | head -1)" \
    && ok "S10 los dos dejan una copia settings.json.bak.<ts> con la entrada" || mal "S10 las copias .bak no coinciden (instalador $(baks "$S"), módulo $(baks "$M"))"
  # las piezas: las `setting` y `command` del reporte del instalador, contra la lista del módulo — tal cual, con su
  # `where` (la misma ruta de HOME): es la clave con que entran al registro, la haga quien la haga
  PIEZAS="$(node -e 'const fs = require("fs");
    const [repFile, resFile] = process.argv.slice(1);
    const line = (p) => JSON.stringify([p.kind, p.where, p.id, "value" in p ? p.value : null, Object.keys(p).sort()]);
    const a = JSON.parse(fs.readFileSync(repFile, "utf8")).filter((p) => p.kind === "setting" || p.kind === "command").map(line).sort();
    const b = JSON.parse(fs.readFileSync(resFile, "utf8")).pieces.map(line).sort();
    process.stdout.write(a.length >= 3 && JSON.stringify(a) === JSON.stringify(b) ? "ok" : JSON.stringify({ instalador: a, modulo: b }));' \
    "$T/s10-s-report.json" "$T/s10-m.json" 2>&1)"
  [ "$PIEZAS" = "ok" ] && ok "S10 el módulo devuelve las mismas piezas (clase, ruta, id y valor) que el instalador real reporta para esas tres" \
    || mal "S10 las piezas difieren: ${PIEZAS}"
fi

if corre S11 && suite_part 2; then
  echo "S11 · Applier_UnderSharedDone_SkipsThree_LockOnlyDoesThem"
  # 🔴 rojo previo (medido con el `.sh` de antes del enganche, que no conocía la variable): bajo
  #    TYCON_HARNESS_SHARED_DONE=1 escribía igual cleanupPeriodDays y la variable de env, copiaba los comandos y
  #    reportaba las tres piezas (4 chequeos en MAL: «bajo la variable», y los dos «el reporte del .sh no las trae»).
  DONE="$(m 'S.DONE_ENV')"
  HH="$T/s11-home"; SNAP="$T/s11-snap"; mkdir -p "$SNAP"
  # la entrada del dev: su formato, una variable y un permiso suyos, y la línea de arranque vieja con los pull sin proteger
  cat > "$T/s11-in.json" <<'JSON'
{
    "permissions": { "allow": ["Bash(ls:*)"] },
    "env": { "MIA": "señal 🔴" },
    "hooks": {
        "SessionStart": [
            { "hooks": [ { "type": "command", "command": "cd ~/.claude/tycon-claude-guides && git pull; cd ~/.claude/agent-skills && git pull --ff-only" } ] }
        ]
    }
}
JSON
  seed11() { # seed11 [<entrada>] — la misma HOME de partida: la entrada y un comando propio del dev
    installer_home "$HH"; cp "${1:-$T/s11-in.json}" "$HH/.claude/settings.json"
    mkdir -p "$HH/.claude/commands"; printf '# mío\n' > "$HH/.claude/commands/mine.md"
  }
  module11() { # module11 <salida.json> — el módulo como lo llama harness.js: con la copia del mecanismo ya tomada
    LAB_TREE="$RAIZ" call "$HH" "$1" TYCON_HARNESS_SNAPSHOT_DIR="$SNAP"
  }
  # look11 <home> <reporte> skip|do → «ok», o lo que no está como se espera
  look11() {
    python3 - "$1/.claude/settings.json" "$2" "$VAR_ENV" "$1" "$RAIZ" "$3" <<'PY' 2>&1
import glob, json, os, sys
s = json.load(open(sys.argv[1], encoding="utf-8")); rep = json.load(open(sys.argv[2], encoding="utf-8"))
var, home, tree, mode = sys.argv[3:7]
bad = []
kinds = [p["kind"] for p in rep]
names = sorted(os.path.basename(c) for c in glob.glob(os.path.join(tree, "commands", "*.md")))
have = sorted(os.listdir(os.path.join(home, ".claude", "commands")))
if not names: bad.append("el árbol no trae comandos: la prueba no mide la copia")
if s.get("env", {}).get("MIA") != "señal 🔴" or s.get("permissions") != {"allow": ["Bash(ls:*)"]}: bad.append("lo del dev cambió")
line = s["hooks"]["SessionStart"][0]["hooks"][0]["command"]
if line != "cd ~/.claude/tycon-claude-guides && git pull --ff-only --autostash; cd ~/.claude/agent-skills && git pull --autostash --ff-only":
    bad.append("la normalización del pull no corrió: " + line)
if kinds.count("hook") < 5: bad.append("el reporte trae %d hooks: el aplicador no registró lo suyo" % kinds.count("hook"))
if mode == "skip":
    if "cleanupPeriodDays" in s: bad.append("escribió cleanupPeriodDays")
    if list(s.get("env", {})) != ["MIA"]: bad.append("tocó env: %r" % list(s.get("env", {})))
    if have != ["mine.md"]: bad.append("copió comandos: %r" % have)
    if "setting" in kinds or "command" in kinds: bad.append("reportó piezas compartidas: %r" % [(p["kind"], p["id"]) for p in rep if p["kind"] in ("setting", "command")])
else:
    if s.get("cleanupPeriodDays") != 365: bad.append("no escribió cleanupPeriodDays")
    if s.get("env", {}).get(var) != "1": bad.append("no escribió la variable de env")
    if have != sorted(names + ["mine.md"]): bad.append("no copió los comandos: %r" % have)
    ids = {(p["kind"], p["id"]) for p in rep}
    for k in [("setting", "cleanupPeriodDays"), ("setting", "env." + var)] + [("command", n) for n in names]:
        if k not in ids: bad.append("reporte sin %s %s" % k)
print("; ".join(bad) if bad else "ok")
PY
  }

  # (a) la referencia: el instalador suelto
  seed11; rc=0; run_installer "$HH" "$T/s11-ref.txt" -- --report-json "$T/s11-ref-report.json" || rc=$?
  [ "$rc" = "0" ] || { mal "S11 el instalador real, suelto, salió $rc"; tail -15 "$T/s11-ref.txt" | sed 's/^/        /'; }
  REF="$T/s11-ref"; rm -rf "$REF"; mv "$HH" "$REF"

  # (b) bajo la variable (como lo lanza un harness.js que ya hizo las piezas), SIN el módulo antes: las saltea y no las
  #     reporta; lo demás —sus hooks, la normalización del pull— corre igual
  seed11; rc=0; run_installer "$HH" "$T/s11-b.txt" TYCON_HARNESS_LOCK_HELD=1 TYCON_HARNESS_SNAPSHOT_DIR="$SNAP" "$DONE=1" -- --report-json "$T/s11-b-report.json" || rc=$?
  GOT="$(look11 "$HH" "$T/s11-b-report.json" skip)"
  [ "$rc" = "0" ] && [ "$GOT" = "ok" ] \
    && ok "S11 bajo ${DONE}=1 el .sh saltea las tres piezas (ni las dos claves, ni los comandos) y no las reporta; sus hooks y la normalización del pull, sí" \
    || { mal "S11 bajo ${DONE}=1 (rc $rc): ${GOT}"; tail -5 "$T/s11-b.txt" | sed 's/^/        /'; }
  grep -q -E 'settings:cleanupPeriodDays|env:CLAUDE_BASH' "$T/s11-b.txt" \
    && mal "S11 bajo ${DONE}=1 la salida del .sh dice que agregó una clave que no escribió" \
    || ok "S11 bajo ${DONE}=1 la salida del .sh no nombra las claves que no escribió"
  # sólo «1» la prende: con 0 (o vacía) las hace, como suelto
  seed11; rc=0; run_installer "$HH" "$T/s11-b0.txt" "$DONE=0" -- --report-json "$T/s11-b0-report.json" || rc=$?
  GOT="$(look11 "$HH" "$T/s11-b0-report.json" do)"
  [ "$rc" = "0" ] && [ "$GOT" = "ok" ] && ok "S11 (espejo) con ${DONE}=0 el .sh hace y reporta las tres piezas" || mal "S11 (espejo) con ${DONE}=0 (rc $rc): ${GOT}"

  # (c) con sólo el candado (un harness.js viejo, que no conoce la variable): las hace y las reporta, como hoy
  seed11; rc=0; run_installer "$HH" "$T/s11-c.txt" TYCON_HARNESS_LOCK_HELD=1 TYCON_HARNESS_SNAPSHOT_DIR="$SNAP" -- --report-json "$T/s11-c-report.json" || rc=$?
  GOT="$(look11 "$HH" "$T/s11-c-report.json" do)"
  [ "$rc" = "0" ] && [ "$GOT" = "ok" ] && cmp -s "$REF/.claude/settings.json" "$HH/.claude/settings.json" \
    && ok "S11 con sólo TYCON_HARNESS_LOCK_HELD=1 (un programa viejo) el .sh hace y reporta las tres piezas: el mismo settings.json que suelto" \
    || mal "S11 con sólo el candado (rc $rc): ${GOT}"

  # (d) y (e) módulo + `.sh` bajo la variable = `.sh` suelto, byte a byte, en los dos órdenes; y entre los dos anotan
  #     las mismas piezas que el suelto reporta (la unión que arma harness.js)
  same11() { # same11 <etiqueta> <reporte del .sh> <resultado del módulo>
    cmp -s "$REF/.claude/settings.json" "$HH/.claude/settings.json" \
      && ok "S11 $1: settings.json BYTE A BYTE el del .sh suelto" \
      || { mal "S11 $1: settings.json difiere del que deja el .sh suelto"; diff "$REF/.claude/settings.json" "$HH/.claude/settings.json" | head -8 | sed 's/^/        /'; }
    diff -r "$REF/.claude/commands" "$HH/.claude/commands" > "$T/s11-commands.diff" 2>&1 && [ "$(baks "$HH")" = "0" ] \
      && ok "S11 $1: los mismos comandos, y ningún .bak (la copia ya la tomó el mecanismo)" \
      || { mal "S11 $1: los comandos difieren, o quedó un .bak ($(baks "$HH"))"; head -4 "$T/s11-commands.diff" | sed 's/^/        /'; }
    local got; got="$(node -e 'const fs = require("fs"), path = require("path");
      const [ref, rep, res, dir] = process.argv.slice(1);
      const S = require(path.join(dir, "shared.js"));
      const J = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
      const line = (p) => JSON.stringify([p.kind, p.where, p.id, "value" in p ? p.value : null]);
      const applier = J(rep), shared = J(res).pieces;
      const bad = [];
      if (applier.some((p) => S.isShared(p))) bad.push("el reporte del .sh trae piezas compartidas");
      const u = S.union(applier, shared).map(line).sort(), want = J(ref).map(line).sort();
      if (JSON.stringify(u) !== JSON.stringify(want)) bad.push("la unión no es el reporte del suelto: sobra " + JSON.stringify(u.filter((x) => !want.includes(x))) + " falta " + JSON.stringify(want.filter((x) => !u.includes(x))));
      process.stdout.write(bad.length ? bad.join("; ") : "ok");' "$T/s11-ref-report.json" "$2" "$3" "$RAIZ/scripts/setup/harness" 2>&1)"
    [ "$got" = "ok" ] && ok "S11 $1: el reporte del .sh no trae las compartidas, y sumadas a las del módulo dan las piezas del suelto" || mal "S11 $1: ${got}"
  }
  seed11; module11 "$T/s11-d.json"
  rc=0; run_installer "$HH" "$T/s11-d.txt" TYCON_HARNESS_LOCK_HELD=1 TYCON_HARNESS_SNAPSHOT_DIR="$SNAP" "$DONE=1" -- --report-json "$T/s11-d-report.json" || rc=$?
  [ "$rc" = "0" ] || mal "S11 módulo y después el .sh: el .sh salió $rc"
  same11 "módulo y después el .sh bajo la variable (el orden de harness.js)" "$T/s11-d-report.json" "$T/s11-d.json"
  seed11
  rc=0; run_installer "$HH" "$T/s11-e.txt" TYCON_HARNESS_LOCK_HELD=1 TYCON_HARNESS_SNAPSHOT_DIR="$SNAP" "$DONE=1" -- --report-json "$T/s11-e-report.json" || rc=$?
  [ "$rc" = "0" ] || mal "S11 el .sh y después el módulo: el .sh salió $rc"
  module11 "$T/s11-e.json"
  same11 "el .sh bajo la variable y después el módulo" "$T/s11-e-report.json" "$T/s11-e.json"

  # (f) settings.json AUSENTE: el esqueleto del `.sh` trae `"$schema"`, que el módulo no pone. Por eso, si el archivo no
  #     está, harness.js deja que el aplicador corra SIN la variable y llama al módulo después: el resultado es el del
  #     suelto. Y queda fijado por qué no puede ser al revés: módulo primero pierde el `"$schema"`.
  installer_home "$HH"; rm -f "$HH/.claude/settings.json"
  rc=0; run_installer "$HH" "$T/s11-f-ref.txt" -- --report-json "$T/s11-f-ref-report.json" || rc=$?
  rm -rf "$T/s11-f-ref"; mv "$HH" "$T/s11-f-ref"
  installer_home "$HH"; rm -f "$HH/.claude/settings.json"
  rc=0; run_installer "$HH" "$T/s11-f.txt" TYCON_HARNESS_LOCK_HELD=1 TYCON_HARNESS_SNAPSHOT_DIR="$SNAP" -- --report-json "$T/s11-f-report.json" || rc=$?
  module11 "$T/s11-f.json"
  [ "$rc" = "0" ] && cmp -s "$T/s11-f-ref/.claude/settings.json" "$HH/.claude/settings.json" && grep -q '"\$schema"' "$HH/.claude/settings.json" \
    && [ "$(q "$T/s11-f.json" 'r.changed')" = "[]" ] && [ "$(q "$T/s11-f.json" 'r.pieces.filter((p) => p.kind === "setting").length')" = "2" ] \
    && ok "S11 sin settings.json: el .sh sin la variable y el módulo después dejan el archivo del suelto, con su \"\$schema\" (el módulo no escribe y anota las piezas)" \
    || { mal "S11 sin settings.json, el .sh y después el módulo no dejan el archivo del suelto (rc $rc)"; diff "$T/s11-f-ref/.claude/settings.json" "$HH/.claude/settings.json" | head -6 | sed 's/^/        /'; }
  installer_home "$HH"; rm -f "$HH/.claude/settings.json"; module11 "$T/s11-f2.json"
  rc=0; run_installer "$HH" "$T/s11-f2.txt" TYCON_HARNESS_LOCK_HELD=1 TYCON_HARNESS_SNAPSHOT_DIR="$SNAP" "$DONE=1" -- --report-json "$T/s11-f2-report.json" || rc=$?
  grep -q '"\$schema"' "$HH/.claude/settings.json" \
    && mal "S11 sin settings.json, el módulo primero ya conserva el \"\$schema\": el desvío de harness.js (módulo después) sobra y hay que quitarlo" \
    || ok "S11 (por qué) sin settings.json, el módulo ANTES del .sh pierde el \"\$schema\" del esqueleto: ese orden no iguala al suelto"
  rm -rf "$HH"
fi

if corre S12 && suite_part 1; then
  echo "S12 · Shared_WriteRetriesWhenBusy_GivesUpClean"
  # Windows: con settings.json abierto por otro proceso (un antivirus, Claude Code leyéndolo) el `rename` del temporal
  # falla con EBUSY / EPERM / EACCES durante unos milisegundos. Acá se inyecta la falla envolviendo `fs.renameSync` ANTES
  # de requerir el módulo (sólo para el reemplazo de settings.json), y se cuentan los intentos y el tiempo entre ellos.
  # 🔴 rojo previo: con el `writeAtomic` de antes, EBUSY no se reintentaba (1 intento, ok:false, las claves sin
  #    escribir); EPERM y EACCES se reintentaban SIN esperar (0 ms entre intentos: en Windows los tres pasan antes de que
  #    el otro proceso suelte el archivo); y al rendirse quedaba el `.bak` que se había tomado para una escritura que no
  #    ocurrió.
  call_busy() { # call_busy <home> <salida.json> <código> <cuántas veces falla> [VAR=valor…]
    local h="$1" out="$2" code="$3" times="$4"; shift 4
    env "${ENV_UNSET[@]}" HOME="$h" TYCON_NO_MODS=1 LAB_TREE="$TREE" LAB_MOD="$MOD" LAB_FAIL_CODE="$code" LAB_FAIL_TIMES="$times" "$@" node -e '
      const fs = require("fs");
      const real = fs.renameSync; const at = [];
      fs.renameSync = (from, to) => {
        if (/settings\.json$/.test(String(to))) {
          at.push(Date.now());
          if (at.length <= Number(process.env.LAB_FAIL_TIMES)) { const e = new Error("inyectado: " + process.env.LAB_FAIL_CODE); e.code = process.env.LAB_FAIL_CODE; throw e; }
        }
        return real(from, to);
      };
      const S = require(process.env.LAB_MOD);
      const r = S.applyShared({ home: process.env.HOME, env: process.env, tree: process.env.LAB_TREE });
      r.attempts = at.length; r.gaps = at.slice(1).map((t, i) => t - at[i]);
      process.stdout.write(JSON.stringify(r) + "\n");
    ' > "$out" 2> "$out.err"
  }
  leftovers() { find "$1/.claude" -maxdepth 1 \( -name 'settings.json.tmp-*' -o -name '.settings.*' \) 2>/dev/null | wc -l | tr -d ' '; }
  H="$T/s12"
  # 1. ocupado dos veces y libre a la tercera: se escribe, esperando entre intentos (50 y 100 ms, como state.js)
  for code in EBUSY EPERM EACCES; do
    new_home "$H"; echo '{"hooks":{}}' > "$H/.claude/settings.json"
    rc=0; call_busy "$H" "$T/s12.json" "$code" 2 || rc=$?
    if [ "$rc" = "0" ] && [ "$(q "$T/s12.json" 'r.ok')" = "true" ] && [ "$(q "$T/s12.json" 'r.attempts')" = "3" ] \
       && grep -q '"cleanupPeriodDays": 365' "$H/.claude/settings.json" && [ "$(q "$T/s12.json" 'r.pieces.filter((p) => p.kind === "setting").length')" = "2" ] \
       && [ "$(leftovers "$H")" = "0" ]; then
      ok "S12 ${code} dos veces y libre a la tercera: las claves quedan escritas, ok:true, sin temporal"
    else
      mal "S12 ${code} dos veces y libre a la tercera: rc $rc · ok $(q "$T/s12.json" 'r.ok') · intentos $(q "$T/s12.json" 'r.attempts') · motivo «$(q "$T/s12.json" 'r.reason')» · temporales $(leftovers "$H")"
    fi
    [ "$(q "$T/s12.json" 'r.gaps.length === 2 && r.gaps[0] >= 45 && r.gaps[1] >= 95')" = "true" ] \
      && ok "S12 ${code}: espera entre intentos (≥ 50 ms y ≥ 100 ms), no reintenta en el acto" \
      || mal "S12 ${code}: entre intentos pasaron $(q "$T/s12.json" 'r.gaps') ms (esperado ≥ 50 y ≥ 100)"
  done
  # 2. el espejo: ocupado SIEMPRE → tres intentos y se rinde limpio: nada escrito, ni temporal, ni .bak, ni comandos
  for mode in 644 444; do
    new_home "$H"; echo '{"hooks":{},"model":"x"}' > "$H/.claude/settings.json"; chmod "$mode" "$H/.claude/settings.json"; cp "$H/.claude/settings.json" "$T/s12-before.json"
    rc=0; call_busy "$H" "$T/s12b.json" EBUSY 99 || rc=$?
    if [ "$rc" = "0" ] && [ "$(q "$T/s12b.json" 'r.ok')" = "false" ] && [ "$(q "$T/s12b.json" 'r.attempts')" = "3" ] \
       && [ "$(q "$T/s12b.json" '/EBUSY/.test(r.reason) && r.pieces.length === 0')" = "true" ] && cmp -s "$T/s12-before.json" "$H/.claude/settings.json" \
       && [ "$(leftovers "$H")" = "0" ] && [ "$(baks "$H")" = "0" ] && [ ! -e "$H/.claude/commands" ]; then
      ok "S12 ocupado siempre (settings.json ${mode}): tres intentos, ok:false con el motivo, nada escrito y nada tirado (ni temporal ni .bak)"
    else
      mal "S12 ocupado siempre (settings.json ${mode}): rc $rc · ok $(q "$T/s12b.json" 'r.ok') · intentos $(q "$T/s12b.json" 'r.attempts') · motivo «$(q "$T/s12b.json" 'r.reason')» · temporales $(leftovers "$H") · .bak $(baks "$H")"
    fi
    chmod 644 "$H/.claude/settings.json"
  done
  # 3. un código que NO es de «ocupado» no se reintenta (aunque el segundo intento hubiera pasado)
  new_home "$H"; echo '{"hooks":{}}' > "$H/.claude/settings.json"; cp "$H/.claude/settings.json" "$T/s12-before.json"
  rc=0; call_busy "$H" "$T/s12c.json" ENOSPC 1 || rc=$?
  [ "$rc" = "0" ] && [ "$(q "$T/s12c.json" 'r.ok')" = "false" ] && [ "$(q "$T/s12c.json" 'r.attempts')" = "1" ] && [ "$(q "$T/s12c.json" '/ENOSPC/.test(r.reason)')" = "true" ] \
    && cmp -s "$T/s12-before.json" "$H/.claude/settings.json" && [ "$(leftovers "$H")" = "0" ] && [ "$(baks "$H")" = "0" ] \
    && ok "S12 ENOSPC (no es «ocupado»): un solo intento, ok:false, nada escrito ni tirado" \
    || mal "S12 ENOSPC: rc $rc · ok $(q "$T/s12c.json" 'r.ok') · intentos $(q "$T/s12c.json" 'r.attempts') · temporales $(leftovers "$H") · .bak $(baks "$H")"
  # 4. sin falla inyectada: un solo intento, sin esperas (el camino de todos los días no se hace más lento)
  new_home "$H"; echo '{"hooks":{}}' > "$H/.claude/settings.json"
  call_busy "$H" "$T/s12d.json" EBUSY 0
  [ "$(q "$T/s12d.json" 'r.ok === true && r.attempts === 1')" = "true" ] && [ "$(baks "$H")" = "1" ] \
    && ok "S12 (espejo) sin nada ocupado: un solo intento, y el .bak de la escritura que sí ocurrió queda" || mal "S12 (espejo) sin falla: intentos $(q "$T/s12d.json" 'r.attempts'), .bak $(baks "$H")"
fi

if corre S13 && suite_part 1; then
  echo "S13 · Shared_GivesUp_NamesWhatItCouldNotRemove"
  # Windows: el programa que tiene ocupado settings.json (un antivirus) suele tener ocupado también el temporal recién
  # escrito. Si la escritura se rinde y además no puede borrar lo que dejó, eso queda en ~/.claude: el motivo tiene que
  # nombrar la ruta. Se inyecta envolviendo `fs.renameSync` (siempre ocupado) y `fs.rmSync` (falla sólo para el temporal,
  # o sólo para el `.bak`) ANTES de requerir el módulo.
  # 🔴 rojo previo: el motivo decía sólo «no pude escribir settings.json (EBUSY)»; el temporal o el `.bak` quedaban en
  #    ~/.claude sin que nada los nombrara.
  call_stuck() { # call_stuck <home> <salida.json> <qué no se deja borrar: tmp|bak|both|none> [half-write]
    # con `half-write`, lo que falla no es el reemplazo sino la escritura del temporal, a medio escribir (disco lleno)
    env "${ENV_UNSET[@]}" HOME="$1" TYCON_NO_MODS=1 LAB_TREE="$TREE" LAB_MOD="$MOD" LAB_STUCK="$3" LAB_HALF_WRITE="${4:-}" node -e '
      const fs = require("fs");
      const realRename = fs.renameSync, realRm = fs.rmSync, realWrite = fs.writeFileSync;
      if (process.env.LAB_HALF_WRITE) fs.writeFileSync = (p, text, o) => {
        if (!/settings\.json\.tmp-/.test(String(p))) return realWrite(p, text, o);
        realWrite(p, String(text).slice(0, 5), o);
        const e = new Error("inyectado: ENOSPC write"); e.code = "ENOSPC"; throw e;
      };
      const stuck = { tmp: /settings\.json\.tmp-/, bak: /settings\.json\.bak\./, both: /settings\.json\.(tmp-|bak\.)/ }[process.env.LAB_STUCK] || null;
      const busy = (what) => { const e = new Error("inyectado: EBUSY " + what); e.code = "EBUSY"; return e; };
      fs.renameSync = (from, to) => { if (/settings\.json$/.test(String(to))) throw busy("rename"); return realRename(from, to); };
      fs.rmSync = (p, o) => { if (stuck && stuck.test(String(p))) throw busy("rm"); return realRm(p, o); };
      const S = require(process.env.LAB_MOD);
      const r = S.applyShared({ home: process.env.HOME, env: process.env, tree: process.env.LAB_TREE });
      process.stdout.write(JSON.stringify(r) + "\n");
    ' > "$2" 2> "$2.err"
  }
  # el NOMBRE de lo que quedó (la ruta que arma `find` puede traer una barra doble del TMPDIR: se compara por nombre)
  leftover_tmp() { find "$1/.claude" -maxdepth 1 -name 'settings.json.tmp-*' -exec basename {} \; 2>/dev/null | head -1; }
  leftover_bak() { find "$1/.claude" -maxdepth 1 -name 'settings.json.bak.*' -exec basename {} \; 2>/dev/null | head -1; }
  H="$T/s13"
  # 1. el temporal no se deja borrar: queda, y el motivo lo nombra con su ruta entera
  new_home "$H"; echo '{"hooks":{}}' > "$H/.claude/settings.json"
  rc=0; call_stuck "$H" "$T/s13a.json" tmp || rc=$?
  LEFT="$(leftover_tmp "$H")"
  if [ "$rc" = "0" ] && [ "$(q "$T/s13a.json" 'r.ok')" = "false" ] && [ -n "$LEFT" ] \
     && [ "$(LEFT="$LEFT" q "$T/s13a.json" '/EBUSY/.test(r.reason) && r.reason.includes(process.env.LEFT)')" = "true" ]; then
    ok "S13 el temporal no se dejó borrar: ok:false, y el motivo nombra la ruta del temporal que quedó"
  else
    mal "S13 el temporal no se dejó borrar: rc $rc · ok $(q "$T/s13a.json" 'r.ok') · quedó «${LEFT}» · motivo «$(q "$T/s13a.json" 'r.reason')»"
  fi
  # 2. el `.bak` no se deja borrar: queda, y el motivo lo nombra
  new_home "$H"; echo '{"hooks":{}}' > "$H/.claude/settings.json"
  rc=0; call_stuck "$H" "$T/s13b.json" bak || rc=$?
  LEFT="$(leftover_bak "$H")"
  if [ "$rc" = "0" ] && [ "$(q "$T/s13b.json" 'r.ok')" = "false" ] && [ -n "$LEFT" ] && [ -z "$(leftover_tmp "$H")" ] \
     && [ "$(LEFT="$LEFT" q "$T/s13b.json" 'r.reason.includes(process.env.LEFT)')" = "true" ]; then
    ok "S13 el .bak no se dejó borrar: ok:false, y el motivo nombra la ruta de la copia que quedó"
  else
    mal "S13 el .bak no se dejó borrar: rc $rc · ok $(q "$T/s13b.json" 'r.ok') · quedó «${LEFT}» · motivo «$(q "$T/s13b.json" 'r.reason')»"
  fi
  # 3. los dos a la vez (un antivirus retiene todo lo recién escrito): quedan los dos y el motivo nombra los dos
  new_home "$H"; echo '{"hooks":{}}' > "$H/.claude/settings.json"
  rc=0; call_stuck "$H" "$T/s13d.json" both || rc=$?
  LEFT="$(leftover_tmp "$H")"; LEFT_BACKUP="$(leftover_bak "$H")"
  if [ "$rc" = "0" ] && [ "$(q "$T/s13d.json" 'r.ok')" = "false" ] && [ -n "$LEFT" ] && [ -n "$LEFT_BACKUP" ] \
     && [ "$(LEFT="$LEFT" LEFT_BACKUP="$LEFT_BACKUP" q "$T/s13d.json" 'r.reason.includes(process.env.LEFT) && r.reason.includes(process.env.LEFT_BACKUP)')" = "true" ]; then
    ok "S13 ni el temporal ni el .bak se dejaron borrar: el motivo nombra los dos"
  else
    mal "S13 los dos retenidos: rc $rc · ok $(q "$T/s13d.json" 'r.ok') · quedaron «${LEFT}» y «${LEFT_BACKUP}» · motivo «$(q "$T/s13d.json" 'r.reason')»"
  fi
  # 4. la misma clase, un paso antes: falla la ESCRITURA del temporal y queda a medio escribir. Si se deja borrar, no
  #    queda nada (🔴 rojo previo: quedaba tirado sin aviso, el reemplazo ni se intentaba); si no, el motivo lo nombra
  new_home "$H"; echo '{"hooks":{}}' > "$H/.claude/settings.json"; cp "$H/.claude/settings.json" "$T/s13-before.json"
  rc=0; call_stuck "$H" "$T/s13e.json" none half-write || rc=$?
  [ "$rc" = "0" ] && [ "$(q "$T/s13e.json" 'r.ok === false && /ENOSPC/.test(r.reason) && !/tmp-/.test(r.reason)')" = "true" ] \
    && [ -z "$(leftover_tmp "$H")" ] && [ -z "$(leftover_bak "$H")" ] && cmp -s "$T/s13-before.json" "$H/.claude/settings.json" \
    && ok "S13 el temporal quedó a medio escribir: se borra, settings.json intacto, y el motivo no nombra nada" \
    || mal "S13 temporal a medio escribir: rc $rc · motivo «$(q "$T/s13e.json" 'r.reason')» · temporal «$(leftover_tmp "$H")» · copia «$(leftover_bak "$H")»"
  new_home "$H"; echo '{"hooks":{}}' > "$H/.claude/settings.json"
  rc=0; call_stuck "$H" "$T/s13f.json" tmp half-write || rc=$?
  LEFT="$(leftover_tmp "$H")"
  [ "$rc" = "0" ] && [ -n "$LEFT" ] && [ "$(LEFT="$LEFT" q "$T/s13f.json" 'r.ok === false && /ENOSPC/.test(r.reason) && r.reason.includes(process.env.LEFT)')" = "true" ] \
    && ok "S13 el temporal a medio escribir no se dejó borrar: el motivo lo nombra" \
    || mal "S13 temporal a medio escribir y retenido: rc $rc · quedó «${LEFT}» · motivo «$(q "$T/s13f.json" 'r.reason')»"
  # 5. el espejo: se rinde y SÍ pudo borrar todo → el motivo no nombra ningún temporal ni copia (no hay nada que avisar)
  new_home "$H"; echo '{"hooks":{}}' > "$H/.claude/settings.json"
  rc=0; call_stuck "$H" "$T/s13c.json" none || rc=$?
  [ "$rc" = "0" ] && [ "$(q "$T/s13c.json" 'r.ok === false && /EBUSY/.test(r.reason) && !/tmp-|\.bak\./.test(r.reason)')" = "true" ] \
    && [ -z "$(leftover_tmp "$H")" ] && [ -z "$(leftover_bak "$H")" ] \
    && ok "S13 (espejo) se rinde y borra lo suyo: el motivo no nombra temporal ni copia, y no queda ninguno" \
    || mal "S13 (espejo): rc $rc · motivo «$(q "$T/s13c.json" 'r.reason')» · temporal «$(leftover_tmp "$H")» · copia «$(leftover_bak "$H")»"
fi

echo
if [ "$FALLOS" -gt 0 ]; then echo "FALLARON $FALLOS chequeo(s)"; exit 1; fi
echo "todo verde"; exit 0
