#!/usr/bin/env bash
# folders.sh — T26, variante 2: quien ya usa Claude Code (corre DENTRO del contenedor del núcleo, con red).
# La HOME arranca con `~/.claude/skills` y `~/.claude/agents` como carpetas REALES, con una skill y un agente propios, y
# con un settings.json y un CLAUDE.md sembrados. El bloque `install:core` termina igual que en la variante 1, pero con
# un enlace por entrada dentro de esas carpetas; lo propio queda intacto; y `uninstall --yes` deja settings.json y
# CLAUDE.md byte a byte como estaban.
# uso: bash /opt/lab/scenarios/folders.sh
set -uo pipefail
. /opt/lab/lib.sh
scenario_begin folders
fakes_setup ${WATCHED} dotnet curl wget launchctl open

# ── lo sembrado: lo propio de quien ya usa Claude Code ───────────────────────────────────────────────────────
SEED=/tmp/seed; mkdir -p "${SEED}" "${HOME}/.claude/skills/my-own-skill" "${HOME}/.claude/agents"
printf -- '---\nname: my-own-skill\ndescription: una skill propia, de antes del arnés\n---\n# Mi skill\n' > "${HOME}/.claude/skills/my-own-skill/SKILL.md"
printf -- '---\nname: my-own-agent\ndescription: un agente propio, de antes del arnés\n---\nUn agente propio.\n' > "${HOME}/.claude/agents/my-own-agent.md"
printf '{\n  "model": "opus",\n  "hooks": {\n    "Stop": [\n      { "hooks": [ { "type": "command", "command": "true" } ] }\n    ]\n  }\n}\n' > "${HOME}/.claude/settings.json"
printf '# Lo mío\n\nUna regla propia, de antes del arnés.\n' > "${HOME}/.claude/CLAUDE.md"
cp "${HOME}/.claude/settings.json" "${SEED}/settings.json"; cp "${HOME}/.claude/CLAUDE.md" "${SEED}/CLAUDE.md"
cp "${HOME}/.claude/skills/my-own-skill/SKILL.md" "${SEED}/SKILL.md"; cp "${HOME}/.claude/agents/my-own-agent.md" "${SEED}/agent.md"
# own_intact → 0 si la skill y el agente propios siguen siendo archivos reales, con su contenido
own_intact() {
  [ ! -L "${HOME}/.claude/skills" ] && [ ! -L "${HOME}/.claude/agents" ] \
    && [ ! -L "${HOME}/.claude/skills/my-own-skill" ] && [ ! -L "${HOME}/.claude/agents/my-own-agent.md" ] \
    && cmp -s "${SEED}/SKILL.md" "${HOME}/.claude/skills/my-own-skill/SKILL.md" && cmp -s "${SEED}/agent.md" "${HOME}/.claude/agents/my-own-agent.md"
}

serve_copy
# story 8.16, tanda B (AC 19 · T25): esta variante corre el bloque sin terminal de la portada (install:unattended), tal cual;
# desde la tanda D (AC 36 · T51) ese bloque nombra el perfil (--profile minimal --yes) y lo que queda es minimal
run_block unattended "${OUT_DIR}/install.out" < /dev/null; RC=$?
if [ "${RC}" -eq 0 ] && find_clone; then ok "T26 (carpetas reales) el bloque install:unattended de la portada, tal cual y sin terminal, sale 0"
else
  no "T26 (carpetas reales) el bloque install:unattended salió ${RC}: $(tail -n 4 "${OUT_DIR}/install.out" | tr '\n' ' ')"
  fakes_check "T26 (carpetas reales)"; scenario_end folders; exit 0
fi

# los dos enlaces enteros, y un enlace POR ENTRADA dentro de las dos carpetas reales
BAD=""
# el enlace del arnés es el LUGAR (HARNESS_LINK, story 8.19): una máquina nueva ya no recibe el nombre viejo
for name in "$(basename "${HARNESS_LINK}")" agent-skills; do
  if [ ! -L "${HOME}/.claude/${name}" ] || [ "$(real "${HOME}/.claude/${name}")" != "${CLONE}" ]; then BAD="${BAD} ${name}"; fi
done
N=0
for sub in skills agents; do
  for entry in "${CLONE}/${sub}"/*; do
    [ -e "${entry}" ] || continue
    e="$(basename "${entry}")"; link="${HOME}/.claude/${sub}/${e}"; N=$((N + 1))
    if [ ! -L "${link}" ] || [ ! -e "${link}" ] || [ "$(real "${link}")" != "$(real "${entry}")" ]; then BAD="${BAD} ${sub}/${e}"; fi
  done
done
if [ -z "${BAD}" ] && [ "${N}" -gt 0 ]; then ok "T26 (carpetas reales) el lugar del arnés y agent-skills apuntan al clon, y cada una de las ${N} entradas de skills/ y agents/ tiene su enlace"
else no "T26 (carpetas reales) enlaces que faltan o apuntan a otro lado:${BAD:- (el clon no tiene entradas)}"; fi
if own_intact; then ok "T26 (carpetas reales) skills/ y agents/ siguen siendo carpetas reales y la skill y el agente propios están intactos"
else no "T26 (carpetas reales) el instalador pisó una carpeta real o algo propio (skills/my-own-skill, agents/my-own-agent.md)"; fi
V="$(json "${HOME}/.claude/settings.json" '[d.model, JSON.stringify(((d.hooks || {}).Stop || []).map((m) => (m.hooks || []).map((h) => h.command))).includes("\"true\"")].join("|")')"
if [ "${V}" = "opus|true" ] && [ "$(head -n 1 "${HOME}/.claude/CLAUDE.md")" = "# Lo mío" ]; then ok "T26 (carpetas reales) lo sembrado en settings.json y en CLAUDE.md sigue ahí después de instalar"
else no "T26 (carpetas reales) lo sembrado no sobrevivió a la instalación (settings.json: ${V:-ilegible}; CLAUDE.md empieza con «$(head -n 1 "${HOME}/.claude/CLAUDE.md")»)"; fi
check_install "T26 (carpetas reales)" minimal
# minimal (T51): los hooks del arnés son los de la lista de efectos para minimal —seis que anotan, el freno de comandos y
# el portón de edición—
WANT="$(node -e 'const e = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).effects;
  console.log(e.filter((x) => x.kind === "hook" && x.profiles.includes("minimal") && ["always", "optin:TYCON_SAFETY_GUARD"].includes(x.when)).length)' "${CLONE}/scripts/setup/install-effects.json" 2>/dev/null)"
GOT="$(json "${HOME}/.claude/settings.json" 'Object.values(d.hooks || {}).flat().flatMap((m) => m.hooks || []).filter((h) => /tycon-claude-guides|agent-skills|\/skills\/|scripts\/hooks/.test(h.command || "") && !/bootstrap\.js/.test(h.command || "")).length')"
if [ -n "${WANT}" ] && [ "${GOT}" = "${WANT}" ] && [ "${WANT}" = 8 ]; then ok "T51 (carpetas reales) minimal: ${GOT} hooks del arnés (seis que anotan, el freno de comandos y el portón de edición)"
else no "T51 (carpetas reales) minimal: ${GOT:-?} hooks del arnés (esperado ${WANT:-?}, que tienen que ser 8)"; fi
if ! grep -q 'TYCON_BLOCK:' "${HOME}/.claude/CLAUDE.md"; then ok "T51 (carpetas reales) minimal: ningún bloque de reglas en CLAUDE.md"
else no "T51 (carpetas reales) minimal: hay bloques en CLAUDE.md: $(grep -o 'TYCON_BLOCK:[a-z-]* START' "${HOME}/.claude/CLAUDE.md" | tr '\n' ' ')"; fi

# ── al final de la variante: uninstall deja la máquina como estaba, byte a byte ──────────────────────────────
uninstall_keeps_clone "T26 (carpetas reales)"
if cmp -s "${SEED}/settings.json" "${HOME}/.claude/settings.json" && cmp -s "${SEED}/CLAUDE.md" "${HOME}/.claude/CLAUDE.md"; then
  ok "T26 (carpetas reales) tras uninstall, settings.json y CLAUDE.md son byte a byte los sembrados"
else no "T26 (carpetas reales) tras uninstall, settings.json o CLAUDE.md no son los sembrados"; fi
LEFT=""
for sub in skills agents; do
  for link in "${HOME}/.claude/${sub}"/*; do
    [ -L "${link}" ] && LEFT="${LEFT} ${sub}/$(basename "${link}")"
  done
done
if [ -z "${LEFT}" ] && own_intact; then ok "T26 (carpetas reales) tras uninstall no queda ningún enlace por entrada, y las carpetas y lo propio siguen intactos"
else no "T26 (carpetas reales) tras uninstall quedan enlaces por entrada (${LEFT:- ninguno}) o se tocó lo propio"; fi

fakes_check "T26 (carpetas reales)"
scenario_end folders
