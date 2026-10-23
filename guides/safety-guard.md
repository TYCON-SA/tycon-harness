# safety-guard — freno de mano del harness TYCON

Hook `PreToolUse` matcher `Bash|PowerShell` (la herramienta PowerShell es por donde Claude Code corre los comandos en Windows; con `Bash` solo el freno no se disparaba ahí, 2026-10-04) que **bloquea comandos destructivos irreversibles** antes de ejecutarse. **Prendido por default** — opt-out vía `TYCON_SAFETY_GUARD=0`. Inspirado en [ECC safety-guard](https://github.com/affaan-m/ECC/blob/main/skills/safety-guard/SKILL.md) pero adaptado al stack TYCON (.NET, SQL Server, monorepos, multi-tenant, host Bizuit).

**Por qué:**
- Sin un gate destructivo cross-repo, nada frena un comando irreversible antes de que corra.
- Bypass clásico `--no-verify` para saltar pre-commit (`git-commit-conventions.md` lo prohíbe, pero una regla escrita no es enforcement).
- Un DROP DATABASE accidental sobre la base de desarrollo de un cliente (`acmebase_dev`) sería catastrófico.

## Cuándo activarlo

- Sí: sesiones autónomas (`tycon-pipeline --autonomous`), trabajo sobre repos productivos, dev nuevo en el equipo que aún no calibró el dedo.
- Sí también para devs senior: el costo de tener el freno puesto es ~0 (false positives bajos, override de 1 línea); el costo de NO tenerlo y borrar un repo es horas.
- No: si tu workflow incluye scripting destructivo intencional (limpiar caches con `rm -rf`, scripts de bootstrap con `curl|bash`). En ese caso, mantenelo desactivado o usá el override de sesión.

## Activación

**Está prendido por default.** Si tu arnés está al día y tu `~/.claude/settings.json` tiene el `SessionStart` hook que corre `install-tycon-hooks.sh` (estándar TYCON), el freno se instala solo en la próxima sesión.

Para forzarlo ahora (sin esperar el próximo `SessionStart`):

```bash
cd ~/.claude/tycon-harness && git pull
bash scripts/install-tycon-hooks.sh
```

Output esperado:
```
✓ tycon: instalé 1 hook(s) en ~/.claude/settings.json
  + PreToolUse (matcher='Bash|PowerShell') → @tcg:safety-guard-pre.sh  [TYCON safety-guard: ...]
```

**Reiniciar Claude Code** (la sesión actual ya tiene los hooks cacheados — no toma el cambio hasta reiniciar).

Para verificar que el script en sí funciona:

```bash
echo '{"tool_input":{"command":"rm -rf /"},"cwd":"/tmp"}' | \
  bash ~/.claude/tycon-harness/scripts/hooks/safety-guard-pre.sh
```

Debería imprimir `🛑 TYCON safety-guard BLOCK [FS-C2]` y exit code 2.

## Desactivación (opt-out)

Setear `TYCON_SAFETY_GUARD=0` en tu shell config (`~/.zshrc` o `~/.bashrc`) y correr el installer:

```bash
echo 'export TYCON_SAFETY_GUARD=0' >> ~/.zshrc
source ~/.zshrc
bash ~/.claude/tycon-harness/scripts/install-tycon-hooks.sh
```

El installer detecta el `=0` explícito y **remueve el hook**:

```
✓ tycon: removí 1 hook(s) (motivo en línea)
  - PreToolUse → @tcg:safety-guard-pre.sh  [disabled by env var]
```

**Re-activarlo después**: quitá la línea del `.zshrc` (o seteala a `1`), `source`, y corré el installer. Vuelve a instalarlo.

## Denylist v1 — qué bloquea

Cada regla tiene un rule ID estable (citado en el mensaje de bloqueo).

| Rule ID | Patrón | Por qué |
|---|---|---|
| **FS-C1** | `sudo rm ...` | sudo rm es irrecuperable + indica permission issue mal diagnosticado |
| **FS-C2** | `rm -rf /` y variantes | Borra el filesystem entero |
| **FS-C3** | `rm -rf ~` / `rm -rf $HOME` | Te borra ssh keys, .zshrc, repos sin pushear |
| **FS-C4** | `rm -rf .` / `rm -rf ..` | Borra el cwd (típicamente un repo entero) |
| **FS-C5** | `chmod -R 777` / `chmod 777 /` | Abre todos los permisos — workaround a permission issue real |
| **GIT-C1** | `git push --force` / `-f` a `main`/`master`/`dev`/`release/*` | Reescribe historia compartida |
| **GIT-C2** | `--no-verify` en `commit`/`push`/`merge`/`rebase` (también con opciones de git antes del subcomando: `git -C <ruta> commit …`), `git commit -n`, y `core.hooksPath` apuntado a otra carpeta para ese comando (`-c`, `--config-env`, `GIT_CONFIG_*`) | Saltea hooks (pre-commit, formatters, security) |
| **GIT-C3** | `git clean -fdx` | Borra archivos gitignored (.env, builds locales, secretos) |
| **GIT-C4** | `git add -A` / `--all` / `.` en `~/.claude/agent-skills` o en el árbol del que salen las skills instaladas (aquél al que resuelve `~/.claude/skills`), parado ahí o nombrando esa carpeta en el mismo comando con `cd <dir>` o `git -C <dir>` | Stagea todo lo ajeno que vive en ese árbol. Si no puede mirar el árbol (un enlace colgado, una carpeta sin permiso) no frena: lo dice y sale 1 |
| **SUP-C1** | `curl ... \| bash` / `wget ... \| sh` | Ejecuta código remoto sin auditar — supply chain attack |
| **SUP-C2** | `eval $(curl ...)` | Peor variante: ejecuta en el shell actual |
| **PUB-C1** | `npm publish` | Publicación accidental al registry público |
| **PUB-C2** | `yarn publish` | Idem npm |
| **PUB-C3** | `dotnet nuget push` | Solo CI debería pushear a NuGet feed |
| **SQL-C1** | `DROP DATABASE` | Te llevás esquema + datos + historial |
| **SQL-C2** | `DROP TABLE` inline (no en `.sql`) | Modificaciones de schema van por migration numerada |
| **SEC-C1** | `cat ~/.ssh/...` / `cat .../aws/credentials` | Secretos al contexto del LLM |
| **SEC-C2** | `cat .env` / `cat .env.*` | Secretos al contexto del LLM |
| **ESC-C1** | `TYCON_PROD_LINT` o `TYCON_NEW_NAMES` asignadas en cualquier parte del comando, con cualquier valor salvo `=1` (también `export`, `declare`, `printf -v`, el nombre partido con comillas, o `$env:` en PowerShell); `TYCON_TEST_GATE` o `DOD_BYPASS` asignadas con cualquier valor salvo `0` o vacío (nombre exacto: `TYCON_TEST_GATE_PART` no es ella) | Las dos primeras apagan, al commitear, la revisión del catálogo de producción y el freno de nombres reales. `TYCON_TEST_GATE` la pone `test-gate.sh` dentro de su proceso: escrita por el agente da un verde de pruebas (o un «sin medir») que no corrió; `DOD_BYPASS` cierra un paso sin la evidencia de la prueba en vivo. Vale con la frase de la persona (abajo). Nombrarlas sin asignar no frena; un texto que trae la asignación sí (como GIT-C2) |
| **ESC-C3** | `marker.js set-autonomous <valor que lo apaga>` con el modo autónomo prendido; `marker.js clear`, `clear-session` de la propia sesión o `update-story-status <h> review\|done` con un control en rojo, pasos sin correr o el pase adversarial sin cerrar; `marker.js set-check … --force-manual` o `pipeline.js check-count … --trust-ran` con la ejecución en verde o en rojo («autorizo force-manual», «autorizo trust-ran») | Apagan el lazo que no deja cerrar con las pruebas en rojo, o archivan como terminada una ejecución que no terminó. La salida normal de una historia que no se pudo es `marker.js close-as-debt`; hacerlo igual lo decide la persona (abajo). El cierre normal del paso 11, `adhoc clear`, `doing clear` y un texto que sólo nombra el comando no frenan |
| **ESC-C4** | `marker.js close-as-debt` o `marker.js expect-red`, con una ejecución en la sesión | Dejan una salida prevista por la historia como el final de la ejecución, o un control en rojo como esperado. Lo autoriza la persona, siempre (abajo); un texto que sólo nombra el comando no frena |
| **ESC-C5** | Un comando que crea, toca o copia un archivo `ALLOW_DOD_EVIDENCE_WRITE` (`touch`, `cp`, `mv`, una redirección, `tee`, un intérprete, `New-Item`, `Set-Content`, …), o que escribe `dod_runtime_exempt: true` en un `.md` (`sed -i`, `perl -i`, `>`, `>>`, `tee`) | El permiso de escribir a mano la evidencia de la prueba en vivo y la exención de esa prueba los decide la persona («autorizo ALLOW_DOD_EVIDENCE_WRITE», «autorizo dod_runtime_exempt»). Mirarlo, buscarlo, borrarlo o sacar la exención no frena. Por la herramienta de escribir archivos lo miran el guardián de la evidencia (consume el permiso sólo con la constancia de este freno de la misma sesión, dentro de los 30 minutos, o con la frase) y el hook del encabezado (pide la frase para agregar la exención a una historia en implementación) |
| **ESC-C6** | `marker.js complete-step approve-plan` (o `3`) con `--approved "<cita>"` o `--mockup-approved "<cita>"`, o `approve-mockup --approved`, cuando la cita no está en un mensaje de la persona de esta conversación (una de menos de 10 letras, sólo si es el mensaje entero), ni es la opción que eligió en una pregunta con opciones (leída del resultado de esa herramienta), ni la reenvió la sesión designada; con `--delegated-by`, sólo la reenviada | La aprobación del plan es de la persona: no tiene frase para saltearla. Sin conversación legible (Codex) no mira y deja la constancia `sin-conversacion` (asimetría declarada). `--auto-approved` no cambia |
| **ESC-C2** | Un comando que nombra `~/.claude/projects` (también tras un `cd`) y trae una forma de escribir: redirección (salvo a `/dev/null`), `tee`, `sponge`, `sed -i`, `awk -i`, `dd`, `truncate`, `cp`, `mv`, un intérprete con código en la línea; en PowerShell `Add-Content`, `Set-Content`, `Out-File`, `Copy-Item`, `Move-Item` | Las conversaciones guardadas son de donde se lee la frase que autoriza un escape. Leer con `tail`, `grep`, `ls` o `wc` no frena |

**Lo que NO bloquea (a propósito):**

- `git reset --hard` — común para descartar cambios locales no commiteados.
- `git checkout -- file` / `git restore file` — selectivo, recovery posible.
- `kubectl delete` / `docker system prune` — TYCON no es heavy en infra; agregar si surge incidente.
- `rm -rf <path>` con path explícito (ej: `rm -rf bin obj node_modules`) — uso legítimo.
- `git push --force-with-lease` a branches que NO son `main`/`master`/`dev`/`release/*` — rebase de feature branch propia es válido.
- Lectura de `.env` vía `grep`/`awk`/`sed` — el bloqueo es solo sobre `cat`/`less`/`more`/`head`/`tail` (modos típicos de "miremos qué hay acá"). Workflows automatizados que extraen una key específica con `grep` siguen funcionando.

## Saltear el freno: lo decide la persona

Hay dos formas, y ninguna la puede usar el agente solo:

**Por comando, con la frase de la persona.** La persona escribe en el chat de la sesión:

```text
autorizo TYCON_SAFETY_OFF
```

y después se repite el comando con el prefijo (`TYCON_SAFETY_OFF=1 <comando>`; en PowerShell,
`$env:TYCON_SAFETY_OFF=1; <comando>`). El freno deja pasar ese comando sólo si encuentra la frase:

- en un turno **tipeado por la persona** en esta conversación: no cuenta lo que escribió el agente, la salida de una
  herramienta, un archivo leído, un subagente ni un texto pegado;
- o textual dentro de un mensaje de la **sesión que la organización designó** para reenviar el ok de un dev
  (`approvals.relay_session` del perfil del equipo, y la designación de la máquina);
- **de los últimos 30 minutos**. Una frase negada («no autorizo …») o retirada en un mensaje posterior no vale.
- y **en la cadena de la conversación** que lleva al pedido del comando: Claude Code guarda cada registro con el de su
  padre y le pasa al freno el id del pedido. Un renglón agregado al archivo por fuera no está en esa cadena, así que no
  cuenta; y escribir en las conversaciones lo frena `ESC-C2`. Reescribir con un guion un mensaje que ya está en la
  cadena es el límite conocido: Claude Code no firma sus registros.

Lo mismo para `ESC-C1`: «autorizo TYCON_PROD_LINT», «autorizo TYCON_NEW_NAMES», «autorizo TYCON_TEST_GATE» o
«autorizo DOD_BYPASS». Para `ESC-C4`: «autorizo cerrar como deuda»; la ejecución queda con `cierre: deuda`, la deuda y
quién la autorizó, y sigue hasta el commit. Para `ESC-C3`, que no es una variable sino el comando: «autorizo
set-autonomous», «autorizo cerrar la ejecución», «autorizo force-manual» o «autorizo trust-ran»; para `ESC-C5`,
«autorizo ALLOW_DOD_EVIDENCE_WRITE» o «autorizo dod_runtime_exempt». La constancia de estos escapes anota la sesión y el
nombre del escape. Una ejecución cerrada así queda
con `cierre: abortada`, su motivo y quién lo autorizó (`marker.js clear` lo lee del registro de escapes); sin esa
línea, `via: sin-registro`. `ESC-C3` lee el comando como lo lee la terminal: cuenta toda llamada a `marker.js` (o
`marker`, sin distinguir mayúsculas) que no sea argumento de un programa que sólo lee o muestra texto (`grep`, `rg`,
`echo`, `cat`, `sed`, `git`…). Así cuentan dos llamadas en renglones distintos, `$(…)`, la ruta de Windows con barras
invertidas, el id de la sesión en una variable, los prefijos con sus opciones (`nice -n 5`, `timeout -s KILL 5`) y los
envoltorios (`bash -c`, `eval`, `cmd /c`, `find -exec`, `iex`, `Start-Process`, un texto que va a `| sh`, un heredoc
que va a un shell); un comentario, un heredoc que va a un archivo o un mensaje de commit que nombran `marker.js clear`
no frenan. Lo dudoso frena como cerrar: un subcomando o un id que no se ve (`$VAR`, `xargs`), `clear-session` sin id, una
comilla sin cerrar o un comando que no se pudo leer. Si falta `node` o `run-close.js`, `ESC-C3` no mira y el comando
pasa, como antes de esta regla. Lo que no ve: el nombre del archivo `marker.js` armado en una variable, un `node -e`
que lo carga, una copia con otro nombre, o un programa de texto que además ejecuta (`awk` con `system`). Para eso sigue el lazo del
modo autónomo, que no deja cerrar el turno con un control en rojo, y el `cierre` del volcado: `marker.js set` no lo
escribe, no pisa los controles (`checks`, `checksProvenance`), el pase ni el modo autónomo de la misma historia, no vacía sus pasos pendientes, y al
pasar a otra historia deja la anterior anotada como abortada si no había terminado.

Por qué: el prefijo lo puede escribir el agente. Un modelo frenado por `--no-verify` reescribió el comando con
`TYCON_SAFETY_OFF=1` por su cuenta y commiteó, aunque la orden decía que no buscara otra forma. Con la frase, saltear
el freno vuelve a ser una decisión de una persona.

Cada escape queda en `~/.claude/.tycon-pipeline/frenos.jsonl`, con la regla esquivada y el camino (`persona`,
`reenvio` con la sesión que lo reenvió, o `ambiente`), sin el texto del comando.

**Por sesión, desde la terminal del dev** (cuando hacés varios destructivos legítimos seguidos): la variable en el
ambiente **antes de abrir la sesión**. El agente no la puede poner: el prefijo de un comando no llega al freno, y
escribirla en el `.zshrc` la frena `HARNESS-C1`.

```bash
TYCON_SAFETY_OFF=1 claude
```

⚠️ Apaga el freno para toda esa sesión. Preferí la frase por comando.

**Codex** no deja leer su conversación: ahí el escape por comando no vale y queda sólo el de la sesión.

## Log de bloqueos

Cada bloqueo se loggea en `~/.claude/safety-guard.log`:

```
[2026-05-23 13:36:42] BLOCK rule=FS-C2 cwd=/Users/<usuario>/SourceCode/Ceibo
  cmd: rm -rf /
  reason: rm -rf sobre raíz '/'. Irreversible y catastrófico.
```

Útil para:

- **Retro post-incidente** — "¿qué quiso ejecutar el agente que no debía?"
- **Calibración de denylist** — si hay un patrón que dispara mucho con casos legítimos, ajustar la regla.
- **Métricas para `tycon-retrospective-capturer`** — alimentar el dashboard de quality del harness.

## Troubleshooting

**El hook no bloquea cuando debería:**

1. Verificá que está instalado en `~/.claude/settings.json`:
   ```bash
   grep safety-guard ~/.claude/settings.json
   ```
2. Verificá que Claude Code lo cargó (los hooks se leen al inicio de la sesión — reiniciá si no).
3. Verificá que `TYCON_SAFETY_OFF` no quedó seteado en el ambiente:
   ```bash
   env | grep TYCON_SAFETY
   ```
4. Probá el script directamente (ver "Activación" paso 5).
5. Si aparece el aviso «NO REVISÓ este comando y lo dejó pasar», el hook no pudo leer su entrada: no necesita `jq` (lee con `jq` si está y, si no, con `node`), pero sin ninguno de los dos en el PATH con el que arrancó la herramienta deja pasar avisando en cada comando. Arreglo: que `node` esté en ese PATH. Lo mismo vale para `test-scope-guard-pre.sh`.

**El hook bloquea algo legítimo (false positive):**

1. Que la persona escriba «autorizo TYCON_SAFETY_OFF» en el chat y repetir el comando con `TYCON_SAFETY_OFF=1` adelante.
2. Si la regla está mal calibrada (bloquea muchos legítimos), abrí un issue en el arnés con el caso. La regla puede refinarse o exceptarse.

**Quiero probar reglas nuevas sin afectar el real:**

Usá `TYCON_SETTINGS_PATH=/tmp/test-settings.json` con el installer:

```bash
cp ~/.claude/settings.json /tmp/test-settings.json
TYCON_SETTINGS_PATH=/tmp/test-settings.json \
TYCON_SAFETY_GUARD=1 \
  bash ~/.claude/tycon-harness/scripts/install-tycon-hooks.sh
```

## Limitations v1 + roadmap v2

**v1 NO cubre:**

- **Read/Edit/Write tool calls** — el hook solo intercepta `Bash`. Una llamada `Read` a `~/.ssh/id_rsa` sigue funcionando. Para cubrir eso necesitamos hook `PreToolUse` matcher `Read|Edit|Write` con denylist de paths. v2.
- **Freeze mode** — limitar edits a un directorio. Requiere estado persistente entre invocations del hook (qué scope freezeaste). v2.
- **Guard mode autónomo** — combinación Careful + Freeze auto-activada cuando `tycon-pipeline --autonomous`. v2.
- **Windows / `.ps1`** — el script es bash. Devs en Windows no tienen safety-guard por ahora. Roadmap: portar a PowerShell con paridad de denylist.

**Roadmap v2 (propuesto, sin compromiso):**

1. Hook `PreToolUse` matcher `Read|Edit|Write` para denylist de paths (.ssh, .aws, .env, secrets/).
2. Freeze mode con state en `~/.claude/safety-guard-state.json`.
3. Guard auto-activado por `tycon-pipeline --autonomous`.
4. Métrica al dashboard de `tycon-retrospective-capturer` (cantidad de bloqueos / semana, top rules disparadas).

## Referencias

- Script: [`scripts/hooks/safety-guard-pre.sh`](../scripts/hooks/safety-guard-pre.sh)
- Installer: [`scripts/install-tycon-hooks.sh`](../scripts/install-tycon-hooks.sh) — sección `OPTIN_HOOKS`
- Catálogo de reglas: [`advisor-rules-catalog.md`](advisor-rules-catalog.md) — entradas `FS-*`, `GIT-*`, `SUP-*`, `PUB-*`, `SQL-*`, `SEC-*`
- Hooks complementarios .NET: la guía `dotnet-hooks.md` del paquete bizuit — bloqueo de migraciones SQL ya commiteadas
- Inspiración: [ECC safety-guard](https://github.com/affaan-m/ECC/blob/main/skills/safety-guard/SKILL.md)
