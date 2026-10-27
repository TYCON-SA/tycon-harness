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
| **SQL-C1** | `DROP DATABASE`, en mayúsculas o minúsculas y con comentarios entre las dos palabras (un `grep` solo que busca el texto no frena) | Te llevás esquema + datos + historial |
| **SQL-C2** | `DROP TABLE` inline (no en `.sql`) | Modificaciones de schema van por migration numerada |
| **SEC-C1** | `cat ~/.ssh/...` / `cat .../aws/credentials` | Secretos al contexto del LLM |
| **SEC-C2** | `cat .env` / `cat .env.*` | Secretos al contexto del LLM |
| **CMD-C1** | Un comando que trae un `\r` (retorno de carro); en PowerShell, también `\f`, `\v`, el espacio duro, NEL o un espacio de Unicode | Bash lee el `\r` como una letra y PowerShell como un salto de línea: con él, una parte del comando se le esconde al freno. Un comando escrito a mano no lo trae. Frena también si el carácter va dentro de un texto entre comillas (un mensaje de commit con un espacio duro pegado de una página, un heredoc con saltos de Windows): el freno no puede saber si las comillas son de verdad. La misma regla la aplican el freno de alcance de pruebas y el aviso de memoria: con este freno apagado, un `\r` sigue frenado |
| **ESC-C1** | `TYCON_PROD_LINT` o `TYCON_NEW_NAMES` asignadas en cualquier parte del comando, con cualquier valor salvo `=1` (también `export`, `declare`, `printf -v`, el nombre partido con comillas, o `$env:` en PowerShell); `TYCON_TEST_GATE`, `DOD_BYPASS` o `TYCON_NO_DEEP_REVIEW` asignadas con cualquier valor salvo `0` o vacío (nombre exacto: `TYCON_TEST_GATE_PART` no es ella) | Las dos primeras apagan, al commitear, la revisión del catálogo de producción y el freno de nombres reales. `TYCON_TEST_GATE` la pone `test-gate.sh` dentro de su proceso: escrita por el agente da un verde de pruebas (o un «sin medir») que no corrió; `DOD_BYPASS` cierra un paso sin la evidencia de la prueba en vivo; `TYCON_NO_DEEP_REVIEW` apaga el pase adversarial, que el agente apagaba después de preguntar si lo corría. Vale con la frase de la persona (abajo). Nombrarlas sin asignar no frena; un texto que trae la asignación sí (como GIT-C2) |
| **ESC-C3** | `marker.js set-autonomous <valor que lo apaga>` con el modo autónomo prendido; `marker.js clear`, `clear-session` de la propia sesión o `update-story-status <h> review\|done` con un control en rojo, pasos sin correr o el pase adversarial sin cerrar; `marker.js set-check … --force-manual` o `pipeline.js check-count … --trust-ran` con la ejecución en verde o en rojo («autorizo force-manual», «autorizo trust-ran»); `--no-deep-review` en `pipeline.js start` o `deep-review-gate` o en `marker.js mark-adversarial-skipped`, siempre, también antes de que exista la ejecución («autorizo no-deep-review»); `marker.js clear-session <sesión> --lost` o `marker.js restore <sesión>`, siempre, sólo con la frase del dueño posterior a la apertura de la ejecución y sin reenvío («autorizo cerrar la ejecución»; abajo, «La ejecución perdida»). Los archivos que siguen a `--files` no son la bandera, salvo una variable sola sin valor conocido o una que vale una bandera | Apagan el lazo que no deja cerrar con las pruebas en rojo, o archivan como terminada una ejecución que no terminó. La salida normal de una historia que no se pudo es `marker.js close-as-debt`; hacerlo igual lo decide la persona (abajo). El cierre normal del paso 11, `adhoc clear`, `doing clear` y un texto que sólo nombra el comando no frenan |
| **ESC-C4** | `marker.js close-as-debt` o `marker.js expect-red`, con una ejecución en la sesión | Dejan una salida prevista por la historia como el final de la ejecución, o un control en rojo como esperado. Lo autoriza la persona, siempre (abajo); un texto que sólo nombra el comando no frena |
| **ESC-C5** | Un comando que crea, toca o copia un archivo `ALLOW_DOD_EVIDENCE_WRITE` (`touch`, `cp`, `mv`, una redirección, `tee`, un intérprete, `New-Item`, `Set-Content`, …), o que escribe `dod_runtime_exempt: true` en un `.md` (`sed -i`, `perl -i`, `>`, `>>`, `tee`) | El permiso de escribir a mano la evidencia de la prueba en vivo y la exención de esa prueba los decide la persona («autorizo ALLOW_DOD_EVIDENCE_WRITE», «autorizo dod_runtime_exempt»). Mirarlo, buscarlo, borrarlo o sacar la exención no frena. Por la herramienta de escribir archivos lo miran el guardián de la evidencia (consume el permiso sólo con la constancia de este freno de la misma sesión, dentro de los 30 minutos, o con la frase) y el hook del encabezado (pide la frase para agregar la exención a una historia en implementación) |
| **ESC-C6** | `marker.js complete-step approve-plan` (o `3`) con `--approved "<cita>"` o `--mockup-approved "<cita>"`, o `approve-mockup --approved`, cuando la cita no está en un mensaje de la persona de esta conversación (una de menos de 10 letras, sólo si es el mensaje entero), ni es la opción que eligió en una pregunta con opciones (leída del resultado de esa herramienta), ni la reenvió la sesión designada; con `--delegated-by`, sólo la reenviada | La aprobación del plan es de la persona: no tiene frase para saltearla. Sin conversación legible (Codex) no mira y deja la constancia `sin-conversacion` (asimetría declarada). `--auto-approved` no cambia |
| **ESC-C7** | Un comando que corre `run-base-controls.sh approve … --relayed-by <rol>` (firmar un cambio de control por delegación; también adentro de un `bash -c`, un `eval` o un `"$(…)"`; un `grep`, un `cat` o un mensaje de commit que nombran esas palabras no la corren y pasan) pedido desde una sesión que no es la designada, desde la designada con una ejecución o un ad-hoc propio abierto, o con algo que el shell expande (`$`, comillas invertidas, `;`, `\|`, `&`, redirecciones, un salto de línea) | Si nada de eso pasa, deja la ficha de un solo uso que `approve` consume (vale 60 s) y el comando sigue. No tiene frase para saltearla: si no se puede, firma el dueño en su terminal con el comando de `pending`. Un comando que esconde la firma (`node -e`, otro guion) no deja ficha, y `approve` no firma |
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

Lo mismo para `ESC-C1`: «autorizo TYCON_PROD_LINT», «autorizo TYCON_NEW_NAMES», «autorizo TYCON_TEST_GATE»,
«autorizo DOD_BYPASS», «autorizo TYCON_NO_DEEP_REVIEW» o «autorizo TYCON_STATUS_GATE» (que también autoriza «autorizo
cambiar el estado»). Para `ESC-C4`: «autorizo cerrar como deuda»; la ejecución queda con `cierre: deuda`, la deuda y
quién la autorizó, y sigue hasta el commit. Para `ESC-C3`, que no es una variable sino el comando: «autorizo
set-autonomous», «autorizo cerrar la ejecución», «autorizo force-manual», «autorizo trust-ran» o «autorizo no-deep-review» (apagar el pase
adversarial tiene dos nombres, y la frase de cualquiera vale para los dos); para `ESC-C5`,
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
comilla sin cerrar o un comando que no se pudo leer. Los nombres se leen sin comillas ni barras invertidas: `pipe''line.js`
o `mar''ker.js` son los guiones, como para el shell, y una barra invertida con salto de línea se une. Si el comando
corre `node` con un guion cuyo nombre no se puede leer (`pipelin?.js`, `pipe[l]ine.js`, `mar$'k'er.js`, una variable),
se lee como cualquiera de los dos guiones; un guion así ejecutado directo, sin `node`, no se ve. Con la carpeta en
una variable y el nombre escrito (`node $S/a.js`, `node "${D}/x.js"`), el guion es ése: el shell no cambia la última
parte. Se lee como escondido si el shell puede partir la variable en palabras (sin comillas, con un valor que el comando
no muestra o con espacios), o si la ruta lleva un `$(…)`. Si el freno no puede leer el comando (no está el intérprete del
arnés, falta `run-close.js` o el lector se cae), un comando que nombra `marker` o `pipeline` frena: sin el intérprete esos
guiones tampoco andan, así que frenar no cuesta nada. `ESC-C1` frena además una asignación con el **nombre armado** en
otra variable (`V=TYCON_…; export $V=1`, `declare -x "$V=1"`, `env "$V=1"`, `printf -v "$V"`) en un comando que corre
`marker`, `pipeline` o `test-gate.sh`: el nombre no se ve, y el camino es escribirlo entero para que decida su regla.
Fuera del pipeline, armar nombres no frena. Lo que no asigna no cuenta: el nombre de un programa que empieza como uno
de esos comandos (`readability` no es `read`), unas llaves de código entre comillas, o una cuenta `$((…))` que calcula
(`$((L-60))`); una cuenta que asigna (`$(( $V = 1 ))`) sí frena.

**Freno aceptado por duda: el código de `node -e`.** `node -e '<código con llaves>' "$a" "$b"` frena `ESC-C3`, igual con
`-p`, `--eval` y `--print`. El código se lee como el guion: puede correr lo que recibe en sus argumentos (`node -e
'spawnSync(process.argv[1],…)' "$S" start --no-deep-review` corre el pipeline con el nombre escondido), y distinguirlo
del de una sonda pide leer JavaScript. La salida, para una sonda que no corre nada: pasar los valores por el ambiente
(`C="$c" L="$L" node -e '…process.env.C…'`) o un solo argumento. Las dos pasan. Además, un comando que nombra `node`,
`nodejs` o `bun`, nombra `pipeline` o `marker` (con o sin `.js`) y dice `--no-deep-review` en cualquier lugar (un
argumento, una variable, un `export`, el cuerpo de cualquier heredoc, un texto) frena `ESC-C3`, aunque el lector no vea
cómo los une el código. Del lado seguro: también frena un mensaje de commit o unas notas por heredoc con esas tres
palabras; las notas se escriben con la herramienta de edición. Sin `node` (un `grep` de la bandera) no frena.

Lo que no ve: el nombre del archivo `marker.js` armado en una variable, un `node -e` que lo carga o que corre otro
programa con lo que recibe sin que el comando nombre el pipeline y la bandera juntos (residuos conocidos: la bandera
partida en dos variables, `S=… A=--no-deep B=-review node -e '…spawnSync("node",[process.env.S,"start",process.env.A+process.env.B])…'`,
`node` en una variable o en una sustitución, `N=node; $N -e '…'` o `$(which node) -e '…'`, y otro intérprete,
`S=pipeline.js python3 -c '…os.system(…--no-deep-review)…'`, pasan; sacarle a la regla la condición de que corra
`node` los cerraba, pero frenaba un `grep`, un mensaje de commit o un `echo` que sólo nombran el pipeline con la
bandera), una copia con otro nombre, o un programa de texto que además ejecuta (`awk` con `system`). Estos residuos
los borra de raíz que apagar el pase pida la firma del dueño (la story que sigue a la 8.111): sin la firma, el pipeline
no apaga el pase, se escriba como se escriba. Mientras tanto sigue el lazo del
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
escribirla en el `.zshrc` la frena `HARNESS-C1`. Sacar un control de la configuración de la herramienta (`disableAllHooks`,
un interruptor en `env`, un hook del arnés) lo frena `HARNESS-C2`, por la terminal y por las herramientas de edición.

```bash
TYCON_SAFETY_OFF=1 claude
```

⚠️ Apaga el freno para toda esa sesión. Preferí la frase por comando.

**Codex** no deja leer su conversación: ahí el escape por comando no vale y queda sólo el de la sesión.

### El estado de la historia y el marcador

Cuando el freno le niega cerrar una ejecución en rojo, un agente puede buscar otro camino: escribir el estado de la
historia a mano y borrar el marcador. Los ganchos del pipeline lo frenan, con cualquier herramienta:

- **Una historia escrita por consola.** Un comando que escribe una historia que no está en borrador (redirección, `sed
  -i`, `tee`, `cp`, un `node -e` o un `python3 -c`) frena con «HISTORIA ESCRITA POR CONSOLA». Desde un comando no se ve
  qué queda escrito. En su lugar: la herramienta de edición, y para el estado
  `marker.js update-story-status <historia> <estado>`. Cuando todos los editores en el lugar del comando son un `sed`
  que nombra sus archivos tal cual (sin comodines, llaves, `$(…)` ni una variable que el comando no define, y con un
  guion que no lee, escribe ni corre otra cosa: sin `r`, `w`, `e` ni los indicadores `w` y `e`), el editor escribe sólo
  esos archivos: la carpeta de cada `cd` es desde dónde se leen, y no cuentan las demás palabras del comando.
  `cd specs; sed -i -e 's/a/b/' notas.txt` pasa aunque `specs` tenga historias. Si uno de esos archivos es una historia,
  el freno ensaya el `sed` sobre su texto sin escribirlo: si el `status:` del encabezado queda igual, pasa, como el
  cuerpo editado con la herramienta de edición; si cambia, frena. Con un editor en el lugar de otra forma, la carpeta de un `cd <carpeta> && `
  al principio exacto del comando (la carpeta escrita tal cual, sin comillas, opciones, `$` ni comodines), seguido de
  un solo `sed` que nombra sus archivos (sin tubería, `$(…)`, comillas invertidas, otro comando, redirección, salto de
  línea, llaves, `@` ni `~`), es desde dónde se leen las demás palabras, no algo que el editor escribe. Con `perl` no:
  un `perl -e` puede armar y escribir sus archivos desde adentro (`BEGIN{@ARGV=glob …}`), y sigue frenando.
  `cd <repo> && sed -i -e 's/a/b/' x.sh` pasa aunque haya historias adentro de esa carpeta. Un editor que toma sus
  archivos de una tubería o de `$(ls)` (`cd specs && ls | xargs sed -i …`) sigue frenando. `cd specs && sed -i -e 's/a/b/' story-x.md` sigue frenando, y también cualquier
  otra forma de llegar a la carpeta (`;`, `|`, `&&` pegado, un espacio o un `(` delante, `cd -- x`, `cd $D`, `pushd`).
  Fuera de esa forma, la carpeta de un `cd` cuenta por las historias que tiene, escrita relativa o absoluta, con
  comillas o con espacios, con su comodín expandido (`cd docs/st*`): `cd docs/stories && ls | xargs sed -i …` frena
  desde la raíz del repo. Una carpeta que el freno no sabe resolver (`cd $(pwd)/docs`, `$'…'`, llaves, una variable que
  no conoce) también frena, y una con más `.md` de los que recorre. Un «cd» dentro de un texto entre comillas o de un
  heredoc no cuenta.
- **El paso a review o done a mano.** Un Edit, un Write o un `apply_patch` de Codex que pasa la historia a `review` o
  `done` frena aunque esté la evidencia. En su lugar: `marker.js update-story-status`, `update-pipeline-status` o
  `/tycon-pipeline close`. Hacerlo a mano lo decide la persona («autorizo cambiar el estado»).
- **Borrar el marcador.** Borrar o mover por consola un marcador de ejecución (`active/`, `active.json`), de esta
  sesión o de otra, frena con «BORRADO DEL ESTADO DEL PIPELINE». En su lugar: `marker.js clear` o `marker.js
  clear-session <sesión>`. No tiene frase. Los demás archivos de la carpeta del estado siguen como siempre. **Freno
  aceptado por duda:** `gh pr close 7 --delete-branch; gh pr view 7 --json state` frena «BORRADO DEL ESTADO DEL
  PIPELINE» cuando la carpeta del estado se llama `state` (`~/.tycon/state`). `--delete-branch` borra una rama de git,
  pero esa palabra es lo único que hace mirar el comando a formas de borrar que la lista no conoce (`zip -m`, `rsync
  --remove-source-files`, `tar --remove-files`), y quitarla las deja borrar el marcador. La salida: el cierre del pedido
  y la lectura de su estado en dos comandos. No abren esa lectura: los alias cortos de Windows (`del`, `erase`, `rd`,
  `ren`, `mi`, `ri`) fuera de donde empieza un comando («la deuda del cliente» en un texto), un `find -exec` con un
  programa que sólo lee (`wc`, `cat`, `grep`, `ls`…), y un `git checkout`, `restore` o `rm`, que dicen sus rutas: si es
  lo único que borra, frena sólo cuando una de esas rutas cae en el marcador.
- **Un `$(…)` en el nombre de un informe.** Con el pipeline abierto, un destino `.md` o `.log` (`>`, `>>` o `tee`) con
  un `$(date +F)` (formato sólo de `%Y %m %d %H %M %S %s %j %y - _`), pegado a texto, se lee entero y el `$(…)` cuenta
  como un comodín: `> out/run-$(date +%s).log` pasa. Frena si la carpeta donde puede caer tiene historias, si la
  carpeta que se sabe toca el estado del pipeline o el árbol instalado (también por un enlace o desde otra carpeta
  posible del comando), o con cualquier otro `$(…)`, otra opción de `date`, el `$(…)` como segmento entero, un destino
  que sigue después de una comilla, llaves o un comodín escrito en el destino, un `date` que el mismo comando redefine
  (función, alias, `PATH=`) o un destino de código. **Freno aceptado por duda:** `$(basename …)` en un destino
  (`> $SP/suite-$(basename $f).log`) frena «EDICIÓN INVISIBLE». `basename /` da `/`, y su salida puede abrir una
  carpeta que el freno no ve. Para un informe con ese nombre, escribilo con la herramienta de edición o armá el
  nombre antes en una variable con su valor literal.

El freno del paso a mano también frena volver una historia en implementación a otro estado (por ejemplo a `draft`, para
después escribirla por consola), sacarle el encabezado y cambiarle el id. Por consola, un borrador sólo pasa si el
comando lo reescribe entero y lo deja en borrador; y borrar una historia, sacarla de `.md` con un `mv` o reponer una
versión vieja (`git checkout -- <historia>`, `git restore`) también frena. Se apaga con `TYCON_STATUS_GATE=off` en el ambiente del gancho (lo usan pruebas que miden
la evidencia), y cada escritura que deja pasar así queda anotada; escrita en un comando, la frena `ESC-C1` sin la frase.

Lo que no ve: un guion que el agente escribe en un archivo y después corre; `patch` o `git apply` con un parche que toca
la historia; `git stash pop`; un enlace (`ln -sf`) sobre el marcador; y el nombre de la carpeta del estado partido entre una variable y
un comodín (`cd ~/.claude/.tyc* && rm -rf act*`). Eso lo ven el control de cambios sin declarar al cerrar y el diff del
commit; y si lo que se fue es el marcador, lo ve la segunda capa de abajo, al faltar.

### La ejecución perdida

La lista de formas de borrar el marcador nunca está completa. Por eso hay una segunda capa que mira el efecto, no el
comando: cada ejecución deja tres piezas que se vigilan entre sí.

- **El marcador** de la sesión, en la carpeta del estado.
- **La apertura** en `gates.log`: un renglón `run-open` con la sesión, la historia, la carpeta de la ejecución y la hora.
- **La copia de la apertura** en la carpeta de la ejecución del repo (`.advisors/pipeline-runs/<ejecución>/run-open.json`).

Todo cierre legítimo anota su `run-close` en `gates.log` y borra la copia: `marker.js clear`, `clear-session`,
`adopt-session` (cierra la vieja y abre la nueva), las dos podas de marcadores viejos y el reemplazo por otra historia.
Si una ejecución sigue abierta y le falta una pieza, la ejecución está **perdida**: falta el marcador; hay una copia sin
su apertura o sin `gates.log`; la copia no coincide con su apertura, no se puede leer o trae campos de un cierre; o
`gates.log` no se puede leer. Lo que no se puede decidir frena.

Con la ejecución perdida frena, con el cartel «🔴 EJECUCIÓN PERDIDA» (qué pieza falta, la historia y cuándo se abrió):
toda edición de código (Edit, Write, `apply_patch`), también con un carril ad-hoc o con `story_gate: false`; el cierre
del turno; el commit en el repo de la ejecución; y en la consola, todo lo que no está en una lista cerrada. La lista:
`marker.js` y `pipeline.js` para leer y para la salida, `git status`, `git diff`, `git log`, y `cat`, `ls`, `grep`,
`head` y `tail` sin redirección. `gates.log` y `run-open.json` son además rutas protegidas de la primera capa, al lado
del marcador.

**La salida es del dueño.** Con «autorizo cerrar la ejecución», escrita por el dueño en la pestaña de esa sesión
después de la apertura, pasan:

- `marker.js clear-session <sesión> --lost`: anota `run-close` con `estado: perdida`, la cita y la hora, y borra la copia.
- `marker.js restore <sesión>`: vuelve a abrir la ejecución desde la copia del repo (marcador nuevo y `run-open` con
  `motivo: restaurada`).

Los dos la piden también para una sesión ajena, y los frena `ESC-C3` sin ella. Una frase anterior a la apertura no vale,
y tampoco la reenviada por la sesión designada (`approvals.relay_session`): reenviarla sería lavar un permiso. Si esa
salida admite delegación lo decide una sola función (`delegacionDeLaSalida`, en `lib/open-runs.js`); hoy dice que no.
`clear-session <sesión>` sin `--lost` y sin marcador no cierra nada y dice que hace falta `--lost`.

Límite: si se borran las tres piezas, en la sesión no se ve. Lo ve el portón de la CI, que pide el registro de autoría
de la historia para mergear.

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
