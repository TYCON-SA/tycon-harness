<!-- Fixture de scripts/tests/windows-rehearsal.test.js (R9): el texto del alta en su forma de UN SOLO CLON.
     Es el texto real de onboarding/new-dev-harness-setup.md en la rama story/8.18-union (commit 9fb7fa45), recortado
     a lo que el ensayo lee: los pasos 1, 2, 3, 4 y 9, tal cual. Los pasos 0 y 5 a 8 (requisitos, engram, BMAD,
     opcionales, permisos) no se ensayan y acá no están. El único cambio contra el texto real: la organización de
     Azure va con el nombre anónimo de la tabla de reemplazos en la dirección del repo, y con un sujeto genérico en el
     texto (este archivo se publica).
     No se edita a mano: si el texto del alta cambia de forma, se vuelve a recortar del commit nuevo. -->

═══ INICIO DEL PROMPT ═══

Sos el asistente de onboarding del harness TYCON. Vas a configurar ESTA máquina para tener
el mismo setup automatizado que usa el equipo. Seguí los pasos EN ORDEN, verificando cada
uno antes de seguir.

---

## PASO 1 — Clonar el repo del equipo (uno solo)

Es de la organización de Azure DevOps del equipo, y es **un solo repo**: trae las guías, los scripts, las skills
(`skills/`) y los advisors (`agents/`). No hay un segundo repo que clonar. Idempotente: si la
carpeta ya existe y es un repo git, saltá (no re-clones).

- Mac/Linux:
  ```bash
  mkdir -p ~/SourceCode && cd ~/SourceCode
  [ -d tycon-claude-guides/.git ] || git clone https://org-del-equipo@dev.azure.com/org-del-equipo/tycon-claude-guides/_git/tycon-claude-guides
  ```
- Windows:
  ```powershell
  New-Item -ItemType Directory -Path "$env:USERPROFILE\SourceCode" -Force | Out-Null
  Set-Location "$env:USERPROFILE\SourceCode"
  if (-not (Test-Path tycon-claude-guides\.git)) { git clone https://org-del-equipo@dev.azure.com/org-del-equipo/tycon-claude-guides/_git/tycon-claude-guides }
  ```

Verificá que `.git/HEAD` exista y que el clon traiga `skills/tycon-pipeline` y `agents/` en su
raíz. Si no los trae, quedó en un commit viejo: `git -C <clon> pull --ff-only` y volvé a mirar.

---

## PASO 2 — Correr el instalador (crea los enlaces, el import, la línea de arranque y los hooks)

UN comando deja todo lo que antes se hacía a mano: los enlaces `~/.claude/tycon-claude-guides`
y `~/.claude/agent-skills` (al clon), `~/.claude/skills` y `~/.claude/agents` (a sus carpetas
`skills/` y `agents/`: por ahí Claude Code descubre las skills y los advisors), el `@import` en
`~/.claude/CLAUDE.md`, la línea de arranque de cada sesión y los hooks del equipo en
`~/.claude/settings.json` (con copia de seguridad antes de tocarlo), y las skills de terceros.

- Mac/Linux:
  ```bash
  node ~/SourceCode/tycon-claude-guides/scripts/setup/harness.js install
  ```
- Windows:
  ```powershell
  node "$env:USERPROFILE\SourceCode\tycon-claude-guides\scripts\setup\harness.js" install
  ```

Es idempotente (una segunda corrida dice «sin cambios»). **NO crees ningún enlace a mano, ni
agregues el `@import`, ni escribas un bloque `SessionStart`**: todo eso lo hace el instalador, y
hecho a mano encima deja cosas duplicadas.

Si sale distinto de 0, **PARÁ y mostrame la salida entera**. Los dos casos conocidos:
- «falta … en el PATH» → es un prerequisito del Paso 0 (en Windows, PowerShell 7).
- «agent-skills no encontrado» → el clon no trae `skills/` (ver el final del Paso 1).

---

## PASO 3 — Verificar los enlaces y el import (no se crea nada a mano)

Los cuatro enlaces tienen que apuntar al clon, y el `@import` estar UNA vez. **NO** repliques mi
config personal (Telegram, tokens, paths de iCloud, etc.) — eso es por-máquina.

**Mac/Linux**:
```bash
ls -la ~/.claude/tycon-claude-guides ~/.claude/agent-skills ~/.claude/skills ~/.claude/agents
# tycon-claude-guides y agent-skills -> el clon · skills -> <clon>/skills · agents -> <clon>/agents
grep -c 'tycon-claude-guides/README.md' ~/.claude/CLAUDE.md     # 1
```

**Windows** (son junctions: el `Attributes` debe incluir `ReparsePoint`):
```powershell
Get-Item "$env:USERPROFILE\.claude\tycon-claude-guides","$env:USERPROFILE\.claude\agent-skills","$env:USERPROFILE\.claude\skills","$env:USERPROFILE\.claude\agents" | Format-List Name,Attributes,Target
(Select-String -Path "$env:USERPROFILE\.claude\CLAUDE.md" -Pattern 'tycon-claude-guides/README.md').Count   # 1
```

Si `~/.claude/skills` o `~/.claude/agents` ya existían como **carpetas reales** con cosas
propias, el instalador NO las pisa ni las mueve: deja adentro un enlace por cada skill y por
cada advisor del equipo. Está bien así: no las muevas ni las reemplaces. Si el instalador dijo
que no pudo crear o que no movió un enlace, **PARÁ y preguntame** (no lo toques).

---

## PASO 4 — La línea de arranque y los hooks (ya los dejó el instalador): diagnóstico

El instalador del Paso 2 ya dejó en `settings.json` la línea de arranque (`SessionStart`) y el
set canónico de hooks TYCON (clocki, tycon-pipeline, los frenos, los avisos). En CADA sesión
nueva esa línea mira si hay una versión nueva del arnés, la trae, y vuelve a correr
`install-tycon-hooks.{sh,ps1}`: cuando el equipo agrega un hook nuevo, le llega al dev solo.

**NO escribas ni edites un bloque `SessionStart` a mano.** Si la máquina ya tenía uno viejo (un
`git pull` por repo y `install-tycon-hooks`), el instalador lo reemplaza solo por el nuevo, con
copia de seguridad: no agregues un segundo bloque.

Corré el diagnóstico (tiene que cerrar con «nada en rojo»; si hay algo en rojo, **PARÁ y
mostrame la salida entera**):
- Mac: `node ~/.claude/tycon-claude-guides/scripts/setup/harness.js doctor`
- Windows: `node "$env:USERPROFILE\.claude\tycon-claude-guides\scripts\setup\harness.js" doctor`

**Sólo Mac/Linux — los hooks globales de git** (el pre-commit y el post-commit del arnés): el
instalador los deja en `~/.git-hooks`, pero git no los corre hasta que su configuración global
los nombre. Es un cambio en la configuración global de git: mostrame el comando y pedime OK.
```bash
git config --global core.hooksPath            # si ya dice ~/.git-hooks (la ruta entera), no hagas nada
git config --global core.hooksPath ~/.git-hooks
```
(Si ya apunta a OTRA carpeta, PARÁ y preguntame: no lo pises.)

Y **validá el JSON** (si tira error, arreglalo ANTES de seguir):
- Mac: `python3 -c "import json,os; json.load(open(os.path.expanduser('~/.claude/settings.json'))); print('JSON OK')"`
- Windows: `pwsh -NoProfile -Command "Get-Content $env:USERPROFILE\.claude\settings.json -Raw | ConvertFrom-Json | Out-Null; 'JSON OK'"`

Opt-out del auto-install: env var `TYCON_NO_AUTOINSTALL=1` en el shell rc / `$PROFILE`.

---

---

## PASO 9 — Verificación final + reporte

Corré los checks (variante según OS) y mostrame el output. La verificación de hooks cuenta
entries (no solo presencia) para detectar duplicados de un re-run:

**Mac/Linux:**
```bash
ls -la ~/SourceCode/tycon-claude-guides/.git/HEAD
ls -la ~/.claude/tycon-claude-guides ~/.claude/agent-skills ~/.claude/skills ~/.claude/agents   # los cuatro, al clon
grep tycon-claude-guides ~/.claude/CLAUDE.md
node ~/.claude/tycon-claude-guides/scripts/setup/harness.js doctor     # tiene que cerrar con «nada en rojo»
python3 - <<'PY'
import json,os
s=json.load(open(os.path.expanduser('~/.claude/settings.json')))
h=s.get('hooks',{})
cmds=lambda n:[k.get('command','') for b in h.get(n,[]) for k in b.get('hooks',[])]
ss=[c for c in cmds('SessionStart') if '.tycon-pipeline/harness/bootstrap.js' in c]
old=[c for c in cmds('SessionStart') if 'git pull' in c]
eng=[c for c in cmds('PreToolUse') if 'engram-pre-commit' in c]
allc=[(n,c) for n in h for c in cmds(n)]
print('línea de arranque (bootstrap.js):',len(ss),'(esperado 1)')
print('líneas de arranque viejas (git pull):',len(old),'(esperado 0 — NO la re-agregues: el instalador la reemplazó)')
print('hooks repetidos:',len(allc)-len(set(allc)),'(esperado 0)')
print('engram PreToolUse entries:',len(eng),'(esperado 1)')
PY
engram --version
head -3 ~/_bmad/_config/manifest.yaml
ls ~/.claude/skills | grep -c '^bmad-'               # >= 30
```

**Windows:**
```powershell
Test-Path "$env:USERPROFILE\SourceCode\tycon-claude-guides\.git\HEAD"
Get-Item "$env:USERPROFILE\.claude\tycon-claude-guides","$env:USERPROFILE\.claude\agent-skills","$env:USERPROFILE\.claude\skills","$env:USERPROFILE\.claude\agents" | Format-List Name,Attributes,Target
Select-String -Path "$env:USERPROFILE\.claude\CLAUDE.md" -Pattern 'tycon-claude-guides'
node "$env:USERPROFILE\.claude\tycon-claude-guides\scripts\setup\harness.js" doctor     # tiene que cerrar con «nada en rojo»
$s = Get-Content "$env:USERPROFILE\.claude\settings.json" -Raw | ConvertFrom-Json
$ss = @($s.hooks.SessionStart.hooks.command) | ? { $_ -match 'tycon-pipeline/harness/bootstrap\.js' }
$old = @($s.hooks.SessionStart.hooks.command) | ? { $_ -match 'git pull' }
$eng = @($s.hooks.PreToolUse.hooks.command) | ? { $_ -match 'engram-pre-commit' }
"linea de arranque (bootstrap.js): $($ss.Count) (esperado 1)"
"lineas de arranque viejas (git pull): $($old.Count) (esperado 0: NO la re-agregues, el instalador la reemplazo)"
"engram PreToolUse entries: $($eng.Count) (esperado 1)"
engram --version
Get-Content "$env:USERPROFILE\_bmad\_config\manifest.yaml" -TotalCount 3
(Get-ChildItem "$env:USERPROFILE\.claude\skills" -Directory | ? Name -like 'bmad-*').Count   # >= 30
```

Reportame un resumen: qué quedó OK, qué se saltó (ya estaba), qué falló, y qué quedó
pendiente (ej: instinct-mining en Windows, Clockify sin key). Después pedime que **reinicie
Claude Code** para que hooks y skills tomen efecto, y validá con: *"¿qué guías y advisors
TYCON tenés disponibles?"* (debería listar varias guías + los advisors Core).

═══ FIN DEL PROMPT ═══
