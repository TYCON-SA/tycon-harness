#!/usr/bin/env bash
# test-scope-guard.test.sh — el freno de pruebas sin alcance (scripts/hooks/test-scope-guard-pre.sh) frena el comando de
# pruebas que se corre de verdad, y no frena un texto que sólo se busca o se nombra entre comillas.
#
# Cada caso le pasa al freno la entrada de un PreToolUse de Bash, con una HOME vacía (lo que anota no toca la de quien
# corre) y mira su salida: 2 frena, 0 deja pasar.
#
# Correr: bash scripts/tests/test-scope-guard.test.sh, y /bin/bash scripts/tests/test-scope-guard.test.sh (el 3.2 de la
# Mac): el freno corre con el mismo bash que la suite.

set -u
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GUARD="$RAIZ/scripts/hooks/test-scope-guard-pre.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
PASA=0; FALLA=0
ok() { echo "  ok   — $1"; PASA=$((PASA + 1)); }
mal() { echo "  MAL  — $1"; FALLA=$((FALLA + 1)); }

# el freno con un comando: imprime su código de salida
frena() {
  local entrada
  entrada="$(node -e 'process.stdout.write(JSON.stringify({ tool_name: "Bash", tool_input: { command: process.argv[1] }, cwd: process.argv[2] }))' "$1" "$T")"
  printf '%s' "$entrada" | env -u TYCON_TEST_SCOPE_GUARD -u TYCON_FULL_SUITE HOME="$T" "$BASH" "$GUARD" >/dev/null 2>&1
  echo $?
}

# Guard_GrepForCommandText_Passes @story-7.51 @ac-12 — un texto entre comillas no es un comando corrido
# stable-data: no crea commits ni lee el reloj; el `git commit -m …` de un caso es un texto que se le pasa al freno
for cmd in \
  'grep -n -E "test-runners.js|resolve|dotnet test|\.sln" test-gate.sh' \
  "rg 'npm test' scripts/" \
  'grep -c "dotnet test" a.sh; echo listo' \
  "echo 'para correr: npm test'" \
  "$(printf 'git commit -m "arreglo\nnpm test corre igual"')"; do
  [ "$(frena "$cmd")" = "0" ] && ok "deja pasar: $cmd" || mal "frenó un texto entre comillas: $cmd"
done

# el comando corrido de verdad sigue frenando, también encadenado o al lado de un texto con comillas
for cmd in \
  'dotnet test' \
  'npm test' \
  'cd x && dotnet test' \
  'grep -c "x|y" a.sh; npm test' \
  'echo "listo" | dotnet test' \
  "echo it\\'s; npm test; echo 'x'" \
  'echo "a \"b|c\" d"; dotnet test' \
  'bash -c "cd x; dotnet test"' \
  "sh -c 'echo; npm test'" \
  'eval "true; npm test"' \
  'ssh build "cd app; dotnet test"' \
  'pwsh -Command "cd app; dotnet test"' \
  "echo \$'it\\'s'; npm test" \
  'echo "$(cd x; dotnet test)"' \
  "$(printf 'echo "\140cd x; npm test\140"')" \
  "$(printf "echo hola # don't\ndotnet test")" \
  'echo $(dotnet test)' \
  'x=$(dotnet test) && echo ok' \
  'echo `dotnet test`' \
  'bash -c "dotnet test"' \
  "eval 'npm test'" \
  "$(printf 'cat <<EOF\nit'"'"'s\nEOF\nnpm test')" \
  "$(printf 'echo a \\\\\\\\\ndotnet test')" \
  "$(printf '# nota \\\\\ndotnet test')"; do
  [ "$(frena "$cmd")" = "2" ] && ok "frena: $cmd" || mal "dejó pasar el comando de pruebas corrido: $cmd"
done

# con alcance, pasa (lo de siempre)
for cmd in 'dotnet test --filter "FullyQualifiedName~Foo"' 'npm test -- Foo' 'dotnet test "tests/Foo.Tests/Foo.Tests.csproj"' \
  'bash -c "dotnet test --filter FullyQualifiedName~Foo"' 'x=$(npm test -- Foo)'; do
  [ "$(frena "$cmd")" = "0" ] && ok "con alcance pasa: $cmd" || mal "frenó un comando con alcance: $cmd"
done

# sin un perl que funcione, el comando se corta como antes: frena de más, nunca de menos
mkdir -p "$T/bin-perl-roto"
printf '#!/bin/sh\nexit 1\n' > "$T/bin-perl-roto/perl"; chmod +x "$T/bin-perl-roto/perl"
frena_con_perl_roto() {
  local entrada
  entrada="$(node -e 'process.stdout.write(JSON.stringify({ tool_name: "Bash", tool_input: { command: process.argv[1] }, cwd: process.argv[2] }))' "$1" "$T")"
  printf '%s' "$entrada" | env -u TYCON_TEST_SCOPE_GUARD -u TYCON_FULL_SUITE HOME="$T" PATH="$T/bin-perl-roto:$PATH" "$BASH" "$GUARD" >/dev/null 2>&1
  echo $?
}
[ "$(frena_con_perl_roto 'npm test')" = "2" ] && ok "con perl roto, el comando corrido sigue frenando" || mal "con perl roto dejó pasar «npm test»"

# Guard_MeasuredCases_AllAsExpected @story-7.52 @ac-1 @ac-2 @ac-3 @ac-4 @ac-5 @ac-6 @ac-7 — la tabla de casos medidos, cada
# uno con lo que tiene que dar. Corre con el bash que corre esta suite: `bash` y `/bin/bash` (el 3.2 de la Mac) dan las dos
# pasadas. Guard_751Passes_StillPass @story-7.52 @ac-6 — de esos, los que pasaban en la 7.51 siguen pasando.
CASOS="$RAIZ/scripts/tests/fixtures/test-scope-guard-cases.json"
mkdir -p "$T/casos"
node -e '
  const fs = require("fs"), path = require("path");
  const { casos } = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const lista = [];
  casos.forEach((c, i) => {
    fs.writeFileSync(path.join(process.argv[2], i + ".json"),
      JSON.stringify({ tool_name: c.herramienta || "Bash", tool_input: { command: c.cmd }, cwd: process.argv[2] }));
    lista.push([i, c.espera === "frena" ? 2 : 0, c.grupo, JSON.stringify(c.cmd)].join("\t"));
  });
  fs.writeFileSync(path.join(process.argv[2], "lista.tsv"), lista.join("\n") + "\n");
' "$CASOS" "$T/casos"
MAL_T1=0; MAL_T2=0; N_T1=0; N_T2=0
while IFS="$(printf '\t')" read -r i espera grupo cmd; do
  N_T1=$((N_T1 + 1))
  env -u TYCON_TEST_SCOPE_GUARD -u TYCON_FULL_SUITE HOME="$T" "$BASH" "$GUARD" < "$T/casos/$i.json" >/dev/null 2>&1
  dio=$?
  if [ "$grupo" = "pasan-7.51" ] && [ "$espera" = "0" ]; then N_T2=$((N_T2 + 1)); fi
  if [ "$dio" != "$espera" ]; then
    MAL_T1=$((MAL_T1 + 1))
    [ "$grupo" = "pasan-7.51" ] && [ "$espera" = "0" ] && MAL_T2=$((MAL_T2 + 1))
    echo "    esperaba $espera y dio $dio: $cmd"
  fi
done < "$T/casos/lista.tsv"
# el mínimo sigue a la tabla (los 452 del probador, los de los revisores y los que confirmó el pase adversarial): una
# tabla que se achica en silencio deja formas sin probar
[ "$N_T1" -ge 550 ] && [ "$MAL_T1" = "0" ] && ok "T1 los $N_T1 casos medidos dan lo esperado ($BASH_VERSION)" \
  || mal "T1 $MAL_T1 de $N_T1 casos medidos no dan lo esperado ($BASH_VERSION)"
[ "$N_T2" -gt 50 ] && [ "$MAL_T2" = "0" ] && ok "T2 los $N_T2 que pasaban en la 7.51 siguen pasando" \
  || mal "T2 $MAL_T2 de $N_T2 que pasaban en la 7.51 ahora frenan"

# Guard_ReaderBroken_FallsBackToSimpleCut @story-7.52 @ac-3 — con el lector de Node roto (un `node` que sale 1), el freno
# no deja pasar en silencio: con `jq` lee la entrada y corta como antes (frena), sin `jq` dice que no pudo leer (sale 1)
mkdir -p "$T/bin-node-roto"
printf '#!/bin/sh\nexit 1\n' > "$T/bin-node-roto/node"; chmod +x "$T/bin-node-roto/node"
entrada="$(node -e 'process.stdout.write(JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm test" }, cwd: "/tmp" }))')"
dio="$(printf '%s' "$entrada" | env -u TYCON_TEST_SCOPE_GUARD -u TYCON_FULL_SUITE HOME="$T" TYCON_HARNESS_NODE=0 \
  PATH="$T/bin-node-roto:$PATH" "$BASH" "$GUARD" >/dev/null 2>&1; echo $?)"
if command -v jq >/dev/null 2>&1; then esperado=2; else esperado=1; fi
[ "$dio" = "$esperado" ] && ok "con el lector roto, «npm test» sale $esperado (corte de antes o «no pude leer»)" \
  || mal "con el lector roto, «npm test» salió $dio y se esperaba $esperado"

# Guard_Record_VerdictPerCommand @story-7.52 @ac-6 — cada decisión deja su constancia: frenar, pasar acotado, usar el
# escape; un comando sin herramienta de pruebas no deja nada
CASA="$T/casa-constancia"; mkdir -p "$CASA"
for cmd in 'npm test' 'npm test -- Foo' 'TYCON_FULL_SUITE=1 npm test' 'git status'; do
  printf '%s' "$(node -e 'process.stdout.write(JSON.stringify({ tool_name: "Bash", tool_input: { command: process.argv[1] }, cwd: "/tmp" }))' "$cmd")" \
    | env -u TYCON_TEST_SCOPE_GUARD -u TYCON_FULL_SUITE HOME="$CASA" "$BASH" "$GUARD" >/dev/null 2>&1
done
veredictos="$(grep -o '"veredicto":"[a-z]*"' "$CASA/.claude/.tycon-pipeline/frenos.jsonl" 2>/dev/null | tr '\n' ' ')"
[ "$veredictos" = '"veredicto":"bloqueo" "veredicto":"paso" "veredicto":"escape" ' ] && ok "la constancia: bloqueo, paso y escape, en orden" \
  || mal "la constancia dio: [$veredictos]"

# Guard_Cartel_NoDictaElEscape — el cartel dice de quién es la decisión de correr la suite completa y dónde está el
# camino, sin dictarle al agente el prefijo pegado al comando (por Bash ni por PowerShell)
for herr in Bash PowerShell; do
  cartel="$(printf '%s' "$(node -e 'process.stdout.write(JSON.stringify({ tool_name: process.argv[1], tool_input: { command: "npm test" }, cwd: "/tmp" }))' "$herr")" \
    | env -u TYCON_TEST_SCOPE_GUARD -u TYCON_FULL_SUITE HOME="$T" "$BASH" "$GUARD" 2>&1 >/dev/null)"
  if printf '%s' "$cartel" | grep -q 'TYCON_FULL_SUITE'; then mal "por $herr, el cartel dicta el escape"
  elif ! printf '%s' "$cartel" | grep -q 'lo decide la persona'; then mal "por $herr, el cartel no dice de quién es la decisión"
  elif ! printf '%s' "$cartel" | grep -q 'test-execution-discipline.md'; then mal "por $herr, el cartel no señala la guía"
  else ok "por $herr, el cartel no dicta el escape y señala la guía"; fi
done

# Un repo de juguete para el alcance por carpeta: un proyecto con su `package.json` adentro de un repo que no es la
# raíz, y las carpetas que no cuentan como alcance propio.
R="$T/repo"
mkdir -p "$R/.git" "$R/forms/Alta/src" "$R/packages/api" "$R/packages/sube" "$R/packages/ws" "$R/packages/pnpmws" \
  "$R/packages/vw" "$R/packages/jp" "$R/packages/roto" "$T/fuera/proj" \
  "$R/packages/ws1" "$R/packages/ws2" "$R/packages/ws3" "$R/packages/ws4" "$R/packages/ws5" "$R/packages/ws6" \
  "$R/packages/jc" "$R/packages/vc" "$R/packages/bom" "$R/packages/jr"
printf '{"name":"raiz","scripts":{"test":"vitest run"}}' > "$R/package.json"
printf '{"name":"alta","scripts":{"test":"vitest run"}}' > "$R/forms/Alta/package.json"
printf '{"name":"api","scripts":{"test":"turbo run test"}}' > "$R/packages/api/package.json"
printf '{"name":"sube","scripts":{"test":"cd .. && vitest run"}}' > "$R/packages/sube/package.json"
printf '{"name":"ws","workspaces":["a"],"scripts":{"test":"vitest run"}}' > "$R/packages/ws/package.json"
printf '{"name":"pnpmws","scripts":{"test":"vitest run"}}' > "$R/packages/pnpmws/package.json"
printf 'packages:\n  - a\n' > "$R/packages/pnpmws/pnpm-workspace.yaml"
printf '{"name":"vw","scripts":{"test":"vitest run"}}' > "$R/packages/vw/package.json"
printf 'export default []\n' > "$R/packages/vw/vitest.workspace.ts"
printf '{"name":"jp","jest":{"projects":["a"]},"scripts":{"test":"jest"}}' > "$R/packages/jp/package.json"
printf '{"name":' > "$R/packages/roto/package.json"
printf '{"name":"fuera","scripts":{"test":"vitest run"}}' > "$T/fuera/proj/package.json"
# scripts `test` que recorren los paquetes de la raíz, y configuraciones de la herramienta con varios proyectos
printf '{"name":"ws1","scripts":{"test":"npm test -ws"}}' > "$R/packages/ws1/package.json"
printf '{"name":"ws2","scripts":{"test":"npm run -ws test"}}' > "$R/packages/ws2/package.json"
printf '{"name":"ws3","scripts":{"test":"yarn workspaces foreach -A run test"}}' > "$R/packages/ws3/package.json"
printf '{"name":"ws4","scripts":{"test":"pnpm run -r test"}}' > "$R/packages/ws4/package.json"
printf '{"name":"ws5","scripts":{"test":"pnpm -F web test"}}' > "$R/packages/ws5/package.json"
printf '{"name":"ws6","scripts":{"test":"pnpm --filter ./packages/* test"}}' > "$R/packages/ws6/package.json"
printf '{"name":"jc","scripts":{"test":"jest"}}' > "$R/packages/jc/package.json"
printf 'module.exports = { projects: ["<rootDir>/a", "<rootDir>/b"] }\n' > "$R/packages/jc/jest.config.js"
printf '{"name":"vc","scripts":{"test":"vitest run"}}' > "$R/packages/vc/package.json"
printf 'export default { test: { projects: ["a", "b"] } }\n' > "$R/packages/vc/vitest.config.ts"
printf '\357\273\277{"name":"bom","scripts":{"test":"vitest run"}}' > "$R/packages/bom/package.json"
# una configuración que no se puede leer cuenta como de varios proyectos
printf '{"name":"jr","scripts":{"test":"jest"}}' > "$R/packages/jr/package.json"
printf 'module.exports = {}\n' > "$R/packages/jr/jest.config.js"; chmod 000 "$R/packages/jr/jest.config.js"

# el freno con un comando y la carpeta del evento, con una HOME propia: imprime su salida; el stderr queda en $3.err
frena_en() { # $1 comando · $2 carpeta (cwd del evento) · $3 HOME
  mkdir -p "$3"
  printf '%s' "$(node -e 'process.stdout.write(JSON.stringify({ tool_name: "Bash", tool_input: { command: process.argv[1] }, cwd: process.argv[2] }))' "$1" "$2")" \
    | env -u TYCON_TEST_SCOPE_GUARD -u TYCON_FULL_SUITE HOME="$3" "$BASH" "$GUARD" >/dev/null 2>"$3.err"
  echo $?
}
anotados() { grep -c '"type":"FULL_SUITE_RUN"' "$1/.claude/.tycon-pipeline/bypass.log" 2>/dev/null || true; }

# ProyectoConSuPackageJson_EsAlcance @story-1.32 @ac-5 — en la carpeta de un proyecto con su `package.json`, que no es la
# raíz del repo, la suite de ese proyecto pasa (por el `cwd` del evento o por un `cd` literal), con la constancia `paso`
n=0
for caso in \
  "npx vitest run|$R/forms/Alta" \
  "cd forms/Alta && npm test|$R" \
  "cd forms/Alta && npx jest|$R" \
  "cd Alta && vitest run|$R/forms" \
  "cd $R/forms/Alta && npm test|$T" \
  "npx vitest run|$R/packages/bom"; do
  n=$((n + 1)); cmd="${caso%|*}"; dir="${caso##*|}"; casa="$T/casa-t6-$n"
  dio="$(frena_en "$cmd" "$dir" "$casa")"
  if [ "$dio" = "0" ] && grep -q '"veredicto":"paso"' "$casa/.claude/.tycon-pipeline/frenos.jsonl" 2>/dev/null; then
    ok "T6 un proyecto con su package.json es alcance: $cmd (en ${dir#$T/})"
  else mal "T6 frenó (salió $dio) o no dejó «paso»: $cmd (en ${dir#$T/})"; fi
done

# PrefijoDeMas_SuiteNoAnota @story-1.32 @ac-6 — el prefijo delante de un comando que pasaría sin él no anota
# `FULL_SUITE_RUN` y avisa que sobra; el que hace falta anota como siempre; un texto que lo nombra no avisa ni anota; en
# un comando con varios tramos, uno que lo necesita lo anota una vez y no avisa
n=0
for caso in \
  "TYCON_FULL_SUITE=1 npx vitest run|$R/forms/Alta|0|0|si" \
  "TYCON_FULL_SUITE=1 npx vitest run a.test.ts|$R|0|0|si" \
  "TYCON_FULL_SUITE=1 bash $RAIZ/skills/tycon-pipeline/scripts/smoke-run.sh a b|$R|0|0|si" \
  "TYCON_FULL_SUITE=1 npx vitest run|$R|0|1|no" \
  "git commit -m 'TYCON_FULL_SUITE=1 sobra'|$R|0|0|no" \
  "TYCON_FULL_SUITE=1 npx vitest run a.ts && TYCON_FULL_SUITE=1 npx vitest run|$R|0|1|no"; do
  n=$((n + 1)); IFS='|' read -r cmd dir sale anota avisa <<< "$caso"; casa="$T/casa-t7-$n"
  dio="$(frena_en "$cmd" "$dir" "$casa")"; hay="$(anotados "$casa")"; hay="${hay:-0}"
  if grep -q 'sobra' "$casa.err" 2>/dev/null; then aviso=si; else aviso=no; fi
  if [ "$dio" = "$sale" ] && [ "$hay" = "$anota" ] && [ "$aviso" = "$avisa" ]; then
    ok "T7 $cmd → sale $dio, $hay FULL_SUITE_RUN, aviso: $aviso"
  else mal "T7 $cmd → salió $dio (esperaba $sale), $hay FULL_SUITE_RUN (esperaba $anota), aviso: $aviso (esperaba $avisa)"; fi
done

# LaRaizSigueFrenando @story-1.32 @ac-5 @ac-7 — la raíz, un `cd` que no se resuelve, un envoltorio, una subcarpeta sin
# su `package.json`, un proyecto que recorre otros o tiene marcas de raíz, un `package.json` roto y una carpeta fuera de
# todo repo frenan como hoy
for caso in \
  "npx vitest run|$R" \
  "npm test|$R" \
  "dotnet test X.sln|$R/forms/Alta" \
  "cd \$X && npx vitest run|$R" \
  "cd - && npx vitest run|$R/forms/Alta" \
  "bash -c \"cd forms/Alta && npx vitest run\"|$R" \
  "npx vitest run|$R/forms/Alta/src" \
  "npm test|$R/packages/api" \
  "npm test|$R/packages/sube" \
  "npx vitest run|$R/packages/ws" \
  "npx vitest run|$R/packages/pnpmws" \
  "npx vitest run|$R/packages/vw" \
  "npx jest|$R/packages/jp" \
  "npx vitest run|$R/packages/roto" \
  "npx vitest run|$T/fuera/proj" \
  "cd forms/Alta && cd .. && npx vitest run|$R" \
  "cd forms/Alta; npm test|$R" \
  "cd forms/Alta || npm test|$R" \
  "true || cd forms/Alta && npm test|$R" \
  "echo | cd forms/Alta && npm test|$R" \
  "builtin cd .. && npm test|$R/forms/Alta" \
  "command -- cd .. && npm test|$R/forms/Alta" \
  "command -p cd .. && npm test|$R/forms/Alta" \
  "noglob cd .. && npm test|$R/forms/Alta" \
  "nocorrect cd .. && npm test|$R/forms/Alta" \
  "sl .. && npm test|$R/forms/Alta" \
  "Set-Location .. && npm test|$R/forms/Alta" \
  "chdir .. && npm test|$R/forms/Alta" \
  "command cd .. && npm test|$R/forms/Alta" \
  "eval 'cd ..' && npm test|$R/forms/Alta" \
  "source volver.sh && npm test|$R/forms/Alta" \
  ". volver.sh && npm test|$R/forms/Alta" \
  "env -C .. npm test|$R/forms/Alta" \
  "env --chdir=.. npm test|$R/forms/Alta" \
  "sudo -D .. npm test|$R/forms/Alta" \
  "sudo --chdir=.. npm test|$R/forms/Alta" \
  "npx jest --roots ..|$R/forms/Alta" \
  "npm test|$R/packages/ws1" \
  "npm test|$R/packages/ws2" \
  "npm test|$R/packages/ws3" \
  "npm test|$R/packages/ws4" \
  "npm test|$R/packages/ws5" \
  "npm test|$R/packages/ws6" \
  "npm test|$R/packages/jc" \
  "npx jest|$R/packages/jc" \
  "npx vitest run|$R/packages/vc" \
  "npx jest|$R/packages/jr" \
  "if true; then cd ..; fi; npm test|$R/forms/Alta" \
  "npm --prefix .. test|$R/forms/Alta" \
  "npx vitest run --root ..|$R/forms/Alta" \
  "pnpm -r test|$R/forms/Alta"; do
  cmd="${caso%|*}"; dir="${caso##*|}"
  dio="$(frena_en "$cmd" "$dir" "$T/casa-t8")"
  [ "$dio" = "2" ] && ok "T8 sigue frenando: $cmd (en ${dir#$T/})" || mal "T8 dejó pasar (salió $dio): $cmd (en ${dir#$T/})"
done

mkdir -p "$R/forms/Baja"
printf '{"name":"baja","scripts":{"test":"vitest run"}}' > "$R/forms/Baja/package.json"

# AgrupaFueraDeComillas_NoBorraCarpeta @story-1.32 @ac-11 — un paréntesis, una llave o una palabra de control dentro de
# comillas, de un comentario o de un argumento no hace perder la carpeta; cada caso tiene su gemelo, que sigue frenando
n=0
pasa_y_gemelo() { # $1 comando · $2 carpeta que pasa · $3 comando gemelo · $4 carpeta del gemelo
  n=$((n + 1)); local casa="$T/casa-t13-$n" dio
  dio="$(frena_en "$1" "$2" "$casa")"
  if [ "$dio" = "0" ] && grep -q '"veredicto":"paso"' "$casa/.claude/.tycon-pipeline/frenos.jsonl" 2>/dev/null; then
    ok "T13 pasa: $1 (en ${2#$T/})"
  else mal "T13 frenó (salió $dio) o no dejó «paso»: $1 (en ${2#$T/})"; fi
  dio="$(frena_en "$3" "$4" "$T/casa-t13-gemelo")"
  [ "$dio" = "2" ] && ok "T13 el gemelo frena: $3 (en ${4#$T/})" || mal "T13 el gemelo pasó (salió $dio): $3 (en ${4#$T/})"
}
for c in 'npm test && echo done' 'npm test 2>&1 | grep -E "(fail|pass)"' 'npm test # (rápido)' \
  'npm test -- -t "suma (con IVA)"'; do
  pasa_y_gemelo "$c" "$R/forms/Baja" "$c" "$R"
done
pasa_y_gemelo 'cd forms/Baja && npm test; echo "fin (ok)"' "$R" 'cd forms && npm test; echo "fin (ok)"' "$R"
# las agrupaciones de verdad siguen borrando la carpeta: desde la raíz, con el `cd` al proyecto adentro, y en el proyecto
# con un `cd ..` adentro
for caso in \
  "(cd forms/Baja) && npm test|$R" \
  "{ cd forms/Baja; } && npm test|$R" \
  "if true; then cd forms/Baja && npm test; fi|$R" \
  "for x in 1; do cd forms/Baja && npm test; done|$R" \
  "while true; do cd forms/Baja && npm test; break; done|$R" \
  "case x in x) cd forms/Baja && npm test;; esac|$R" \
  "function f { cd forms/Baja; }; f && npm test|$R" \
  "until false; do cd forms/Baja && npm test; break; done|$R" \
  "select x in a; do cd forms/Baja && npm test; break; done|$R" \
  "coproc { cd forms/Baja; }; npm test|$R" \
  "bash <<EOF
(cd forms/Baja) && npm test
EOF|$R" \
  "if true; then cd ..; fi; npm test|$R/forms/Baja" \
  "(cd ..) && npm test|$R/forms/Baja"; do
  cmd="${caso%|*}"; dir="${caso##*|}"
  dio="$(frena_en "$cmd" "$dir" "$T/casa-t13-agrupa")"
  [ "$dio" = "2" ] && ok "T13 la agrupación frena: $cmd (en ${dir#$T/})" || mal "T13 la agrupación pasó (salió $dio): $cmd (en ${dir#$T/})"
done
# las formas que la lectura simple no sigue (sustituciones, `$'…'`, comillas invertidas, escapes, continuaciones de
# renglón, heredocs a un shell) se leen como antes: con el `cd` al proyecto adentro, desde la raíz, siguen frenando.
# Cada caso termina en un renglón `---`.
n=0; cmd=""
while IFS= read -r -u 3 linea; do
  if [ "$linea" != "---" ]; then cmd="${cmd:+$cmd
}$linea"; continue; fi
  n=$((n + 1))
  dio="$(frena_en "$cmd" "$R" "$T/casa-t13-raro-$n")"
  [ "$dio" = "2" ] && ok "T13 la forma rara frena: $cmd" || mal "T13 la forma rara pasó (salió $dio): $cmd"
  cmd=""
done 3<<'CASOS'
y=$(echo $'it\'s') && (cd forms/Baja) && npm test
---
y=$(echo a # it's
) && (cd forms/Baja) && echo 'b' && npm test
---
bash <<'EOF'
cd forms/Baja && true
EOF
npm test
---
x=$(cd forms/Baja && pwd) && npm test
---
echo `cd forms/Baja && true` && npm test
---
true; \
if false; \
then cd forms/Baja && :; \
fi; npm test
---
echo \ #; (cd forms/Baja) && npm test
---
x=$(echo a #(
); (cd forms/Baja) && npm test
---
x=$(echo $'\'') ; (cd forms/Baja) && npm test
---
CASOS

# PuntoPuntoDeReporte_NoEsSalida @story-1.32 @ac-12 — un `..` en el valor pegado de una opción que no es de carpeta (la
# ruta de un reporte) no saca al script `test` de su proyecto; cualquier otro `..` sigue frenando
n=0
for caso in \
  "vitest run --reporter=junit --outputFile=../reports/alta.xml|0" \
  "vitest run --coverage.reportsDirectory=../c|0" \
  "cd .. && vitest run|2" \
  "cd ./.. && vitest run|2" \
  "cd a/../.. && vitest run|2" \
  "pushd .. && vitest run|2" \
  "vitest run --root ..|2" \
  "vitest --dir ../otro|2" \
  "vitest --workspace ../ws.ts|2" \
  "npm --prefix ../x test|2" \
  "vitest run ../otro|2" \
  "vitest run --outputFile ../r.xml|2"; do
  n=$((n + 1)); script="${caso%|*}"; sale="${caso##*|}"; d="$R/punto/p$n"; casa="$T/casa-t14-$n"
  mkdir -p "$d"
  node -e 'process.stdout.write(JSON.stringify({ name: "p", scripts: { test: process.argv[1] } }))' "$script" > "$d/package.json"
  dio="$(frena_en "npm test" "$d" "$casa")"
  if [ "$sale" = "0" ]; then
    if [ "$dio" = "0" ] && grep -q '"veredicto":"paso"' "$casa/.claude/.tycon-pipeline/frenos.jsonl" 2>/dev/null; then
      ok "T14 el reporte no sale del proyecto: $script"
    else mal "T14 frenó (salió $dio) o no dejó «paso»: $script"; fi
  else
    [ "$dio" = "2" ] && ok "T14 sigue frenando: $script" || mal "T14 dejó pasar (salió $dio): $script"
  fi
done
# un `..` entre comillas, pegado a un operador o en una opción que no es de reporte sigue saliendo de la carpeta
while IFS= read -r -u 3 script; do
  n=$((n + 1)); d="$R/punto/p$n"; casa="$T/casa-t14-$n"
  mkdir -p "$d"
  node -e 'process.stdout.write(JSON.stringify({ name: "p", scripts: { test: process.argv[1] } }))' "$script" > "$d/package.json"
  dio="$(frena_en "npm test" "$d" "$casa")"
  [ "$dio" = "2" ] && ok "T14 sigue frenando: $script" || mal "T14 dejó pasar (salió $dio): $script"
done 3<<'CASOS'
cd '../..' && vitest run
cd "../.." && vitest run
cd "../x" && vitest run
pushd "../app" && vitest run
vitest run --dir "../"
vitest run --root="../x"
cd ..;vitest run
cd ..&&vitest run
cd '..' && vitest run
vitest run --rootdir=..
vitest run --directory=..
jest --root-dir=..
mocha --spec=../**/*.test.js
jest --test-path-pattern=../
CASOS

echo "test-scope-guard: $PASA ok, $FALLA mal"
[ "$FALLA" = "0" ]
