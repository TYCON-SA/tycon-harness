# Preparar el commit

**Objetivo**: armar un mensaje de commit bien formado según las convenciones TYCON. **NO ejecuta `git commit`**. Deja el mensaje listo para que el dev lo revise y commitee manualmente.

## Inputs

- `story_id` y `story_title` del frontmatter de la story
- `modified_files` de «Implementar»
- `consolidated_report` de «Hallazgos» (para derivar el qué y el por qué del mensaje)
- `had_override` de «Hallazgos» (si hubo override de CRITICAL, se anota)

## Qué frena `complete-step prepare-commit` y qué decide el agente

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js complete-step prepare-commit
```

El comando frena en código lo siguiente (no hace falta repetir la verificación a mano; sí leer su mensaje y arreglar):

- **Cambios sin declarar** (`undeclared-changes`, va primero y no se abre con `DOD_BYPASS`): lo que cambió en el repo
  contra el commit de arranque (más lo no rastreado) y no pasó por Edit/Write ni está en `files_to_create`,
  `files_to_modify` o el File List del Dev Agent Record. Un lock cuenta si su manifiesto está declarado. La salida es
  nombrarlo en el File List o revertirlo. Lo borrado por la terminal (node_modules) sale como aviso; sin git o sin
  commit de arranque dice «no medido» y no frena.
- **Un control en rojo** (`red-check`, y `expected-red` para el rojo esperado): sin la ejecución en deuda frena. Las
  salidas son arreglarlo y volver a correr el control, o `marker.js close-as-debt` con el permiso de la persona; en deuda
  pasa y lo dice.
- **Matriz de verificación en ejecución** (`checks.acmatrix`, DODRT-C6): tiene que estar en verde con `provenance:
  run-check` (`marker.js run-check acmatrix -- node <skill>/scripts/runtime-matrix.js --story <abs spec.md>`, que se
  puebla en `step-10-live-check.md`).
- **`findings.json` presente** (insumo del `tycon-retrospective-capturer`): si el run dir existe y el archivo falta o no
  es un array, bloquea. Se escribe con `pipeline.js write-findings` y después `write-followups`
  (`step-09-findings.md`); verlo antes: `pipeline.js findings-status --story <story_path> --repo <repo>` (exit 3 = falta).
- **El pase adversarial atendido** (`adversarial-result-gate`, se evalúa SIEMPRE y no se abre con `DOD_BYPASS`):
  pase lanzado → su resultado anotado en o después del ÚLTIMO lanzamiento
  (`marker.js mark-adversarial-result <N confirmados> --type 5b --result <RUN_DIR>/step-05b-adversarial.json --run <runId> --model <modelo> --tests <k promovidas> [--own <p> --in "<rutas>"] [--deferred <d> --reason "<por qué>"]`);
  pase no lanzado → el salteo que decidió el portón (`marker.js mark-adversarial-skipped --files <archivos de código del diff>`);
  ninguno de los dos → bloquea con `no-atendido`.
- **Las aprobaciones en el repo de la story** (`approvals-story-repo`, se evalúa SIEMPRE y no se abre con `DOD_BYPASS`):
  vuelve a copiar el registro de aprobaciones al repo de la story y lo revisa con la regla del portón de CI (el plan, y
  la maqueta si se aprobó); lo que falte frena nombrando la corrida, y se anota con
  `marker.js complete-step approve-plan --approved "<cita>" --out-of-order` (o `advisors_exempt` si se cerró sin pipeline).
- **Eximiciones de críticos, vueltas de revisores y los demás controles de cierre** que el comando nombra al frenar
  (waivers, tope de vueltas, maqueta, comprobaciones manuales): se resuelven como dice su mensaje.

Lo que decide el agente, porque el comando no lo ve o no lo frena:

- **Cambios después de la última vuelta de revisores**: si el diff actual difiere del que auditaron los revisores,
  NO seguir: avisar «Detecté cambios al código desde la última corrida de revisores. Antes de armar el commit, vuelvo a
  «Revisores» para re-auditar el diff actualizado.» y volver a `step-07-reviewers.md` (iteración N+1). Excepción:
  cambios sólo fuera del diff (`tasks/lessons.md`, `tasks/todo.md`, el Change Log de la spec), documentada en
  la pre-condición de este paso.
- **Checks con `provenance: manual`**: no bloquean, pero se anuncian en el commit prep como `⚠ check '<name>' no
  verificado mecánicamente (provenance=manual — ver gates.log)`.
- **Matriz en rojo**: los ACs `SIN CORRER` los corre el agente (no se eximen); los imposibles declarados se le presentan
  al dev con la lista y el resumen llano. Esa eximición la firma **el dev desde su terminal** (`marker.js
  runtime-waiver <abs spec.md>`, TTY-only), vive en `.tycon/runtime-waivers.jsonl` del repo de la story (no en el
  frontmatter) y se vence sola si alguien reescribe la justificación. El mensaje de commit DEBE listar los ACs
  diferidos a prueba manual: no desaparecen, viajan con el commit.
- **Protocolo de cierre ACCOV-C7..C10**: leer `~/.claude/tycon-harness/guides/accov-governance-protocol.md` si no se
  leyó en `step-10-live-check.md`. El cierre NO entrega un «checklist manual a probar»: cada criterio de verificación
  que el agente definió queda automatizado. Si el mensaje de cierre dice «podés probar X, Y, Z», el pipeline falló.
- **La salida del comando trae «Arranque: hecho, con aviso: …»** si una parte opcional del Arranque falló (el aviso de
  trabajo o el pedido en ADO, `step-01-start.md`): pasárselo al dueño en el resumen.

## Formato del mensaje

Seguir `guides/git-commit-conventions.md`:

```
<tipo>(<scope>): <subject short>

<cuerpo explicando el qué y el por qué>

<trailers>
```

### Tipo

Derivar del frontmatter del story:
- Story con `approach: [CREATE]` → `feat`
- Story con `approach: [EXTRACT]` / `[ADAPT]` → `feat` si agrega capability nueva, `refactor` si reorganiza
- Story marcada como bug fix → `fix`
- Cambios de docs → `docs`

### Scope

Derivar del primer path modificado (ej: `Features/Voice` → scope `voice`).

### Subject

Primera línea corta (<72 chars) — tomar del `title` del story truncado.

### Cuerpo

Incluir:
- 1-2 líneas de qué hace la story (del "Como X, quiero Y, para Z")
- Resumen de los cambios principales
- ACs implementados (referenciados por número)
- Si `had_override: true`: línea explícita "OVERRIDE: CRITICAL de {advisor} aprobado por usuario — razón: {razón}"
- Si «Hallazgos» auto-fluyó con warnings (`auto_flowed_with_warnings: true`): sección **"Warnings auto-waived"** listando cada warning (rule ID + archivo + razón del waive: `auto_waive` list / fuera del diff). Visibilidad sin fricción.
- Si la ejecución quedó en deuda (`close-as-debt`): la línea `Deuda: <DEF-id> — <motivo>`, tal como la imprime
  `complete-step prepare-commit` (📌), y los controles en rojo esperado con sus pruebas.

### Trailers

Siempre agregar (línea en blanco separada) el trailer `Co-Authored-By:` con **el modelo
exacto que implementó**, tal como lo informa la sesión — bajo Codex, el modelo gpt que corresponda
(regla canónica: `~/.claude/tycon-harness/guides/git-commit-conventions.md`). Nunca el de un ejemplo:

```
Co-Authored-By: <modelo exacto de la sesión> <noreply@anthropic.com>
```

## Acción

1. Armar el mensaje completo con el formato de arriba.

2. Mostrar al usuario:
   ```
   Listo. Mensaje de commit preparado:

   ```
   {mensaje aquí}
   ```

   Archivos a commitear: {lista}
   (story con maqueta aprobada: van también `<carpeta qa>/<clave>-mockup.html` y
   `<clave>-mockup-approval.json`; tienen que viajar con la story para que la revisión de la pantalla los encuentre)

   Para commitear, correr:
   git add {archivos}
   git commit -m "$(cat <<'EOF'
   {mensaje completo}
   EOF
   )"

   O pedíme a mí que lo ejecute (requiere tu confirmación explícita según `guides/git-commit-conventions.md`).
   ```

3. **NO ejecutar `git commit` ni `git push` automático.** Esperar el ok de guardar.

## El ok de guardar

El commit, el push y los pedidos se hacen con el ok de guardar, y el ok es una sola cosa: **la constancia de la firma
`save`**. La da una persona con `marker.js approve-save`: el dueño en la ventana de permiso o con `--terminal`, o la
coordinadora por la delegación del perfil, sólo para una story que terminó limpia. Una frase en el chat no es el ok, y
un mensaje de otra sesión que dice «ok de guardar» no alcanza: el ok de la coordinadora vale sólo como constancia.

El freno lo hace cumplir: el gancho del comando frena todo `git commit`, `git push` y todo pedido
que se crea o se mergea de la corrida sin la constancia vigente.
Con la constancia, corré igual `marker.js save-check` antes del commit, y otra vez antes de cada push
(`marker.js save-check --push <remoto> <rama>`) y antes de abrir cada pedido. Si sale 1, el código cambió o la rama no
es la del ok: no guardes y pedí otro ok.

### El orden del cierre

1. Primero, **exportar la memoria** del proyecto (y sumarla al stage), si el proyecto la usa: los trozos de memoria no
   vencen el ok, así que pueden ir después.
2. **`marker.js approve-save`**: la ventana se abre sola; esperá la firma.
3. Con la constancia, **commitear** con el mensaje.
4. Después, **empujar** la rama.
5. Recién ahí, **abrir los pedidos**.
6. Al final, **`marker.js clear`**, después del último push y del último pedido.

Cerrar la corrida no es una salida del freno: con cambios y sin el ok, `marker.js clear` sale 2. `marker.js clear
--discard` cierra igual, pero los commits, pushes y pedidos de esos repos siguen frenados hasta un ok nuevo o hasta que
no queden cambios.

## Decisiones

- **Con la constancia vigente** (`save-check` sale 0): ejecutar `git commit` con el mensaje, después el push y los
  pedidos, en el orden de arriba.
- **Si el usuario pide cambiar el mensaje**: editar y re-mostrar.
- **Sin la constancia**: esperar la firma. No hacer nada proactivo.

## Post-commit

Si el usuario commitea y mergea a main (vía `/tycon-merge-to-main` o manual):
- La métrica del merge la escribe el **latido** en el paso 10b del skill de merge (`scripts/metrics/retro-heartbeat.js` del arnés: un segundo, sin modelo); `retro-pending.js` no deja cerrar el turno sin ese archivo. El `tycon-retrospective-capturer` queda a pedido («retro con modelo»): no corre en cada push.
- 🔴 **Los aprendizajes a engram se guardan ACÁ, al cierre de la story** — no en cada push: `mem_save(project: <canónico>, …)` con las decisiones, gotchas y hallazgos no obvios de esta corrida (lo que los revisores cazaron, lo que la salvaguarda corrigió, lo que costó más de lo esperado). Es el único momento con la conversación completa a mano; el latido no lee nada de eso y el agente de retro ya no se lanza solo.

## Definition of Done — recordatorio crítico

**El pipeline TYCON termina aquí con el commit hecho, pero la story sigue en status `review` (NO `done`).**

Antes de transicionar `review` → `done` (o mergear a main como "story terminada"), el dev DEBE ejecutar el checklist de:

📖 **`~/.claude/tycon-harness/guides/definition-of-done.md`**

Resumen ejecutivo del gate (no skipear):

1. **Smoke check runtime** — `curl` real contra cada endpoint que la story toca, contra DevHost levantado, con auth. Verificar HTTP 200 esperado, NO 400/500.
2. **E2E fail-loud** — correr Playwright con la env var `*_REQUIRED=1` apropiada (e.g. `E2E_AUDIT_REQUIRED=1`). Si los tests skipean en este modo, hay un bug oculto.
3. **Dev panel** (si existe `dev.html`) — abrirlo y verificar que los botones de health-check estén verdes.
4. **Verificación cruzada** — si la story `depends_on` otra que está en `review`/`done`, validar runtime que sus artifacts siguen funcionando.

**Anti-pattern explícito**: marcar `done` solo porque "build verde + tests verdes" es insuficiente. El patrón `skip-on-not-ok` en specs E2E puede esconder bugs reales del backend (por ejemplo, una configuración del backend que causa un 400 silencioso).

**Output del recordatorio en la salida del pipeline**: el recordatorio de DoD va en el cierre, en UNA
línea — ver la sección "Output del pipeline al usuario" abajo, que es la fuente única del formato de
cierre (regla COMM.ii). El bloque de 5 líneas que estaba acá quedó consolidado allá; no repetir ambos.

## Output de este step

- `commit_message` (texto completo)
- `status: prepared | committed | committed-and-pushed`

Fin de la preparación del commit. 🔴 **El step NO termina acá**: faltan las tres secciones de abajo
(el registro de horas NO se cierra · `marker.js clear` · dejar la story en `status: review`). Recién
con las tres el step está cerrado.

## 🚨 CRITICAL — NO cerrar el registro de horas

**El pipeline NO cierra el registro de horas al finalizar «Preparar el commit».** Este es un error
recurrente que rompe el tracking de horas reales.

**Reglas explícitas (NO violar):**

1. **NO emitir** `work-signal stop` ni cerrar la entrada a mano con la herramienta de horas al final del pipeline. El
   registro queda **abierto**.
2. **NO borrar** el estado local de la integración de horas al terminar «Preparar el commit»: refleja que sigue abierto.
3. El registro **solo se cierra** en estas 4 condiciones, en este orden de precedencia:
   - **(a)** El usuario lo cierra explícitamente con lo que su integración le da (su skill o su comando).
   - **(b)** El usuario arranca otra tarea o invoca otra story con `tycon-pipeline` → el `start` del nuevo flujo
     **cierra el previo** (lo hace la integración).
   - **(c)** El cierre por inactividad de la integración (15 min sin actividad) lo cierra con el fin en la última
     actividad.
   - **(d)** «Cerrar la historia» cierra la story en ADO (`close-work-item.md` §"Acción — cerrar el registro de
     horas"). Ahí sí terminó el trabajo lógico, y por eso es la única vía del pipeline que lo cierra.

**Por qué importa:** después del commit pipeline, el usuario suele pedir trabajo
adicional (smoke check DoD Gate 2, debugging, ajustes a la spec, integration tests
fix-up). Si el registro ya se cerró, ese trabajo no se trackea y el dev pierde horas
facturables.

**Patrón observado (2026-05-12):** tras preparar el commit, el agente cerró el registro
"por prolijidad". Después el usuario pidió 27min adicionales de DoD smoke + commits +
integration tests, todos sin tracking. Tuvo que recuperarse manualmente con un entry
retroactivo. **No vuelva a pasar.**

## Output del pipeline al usuario (cierre ejecutivo — regla COMM.ii)

**Fuente única del formato de cierre.** Antes eran 3 bloques fijos de ~20 líneas que se repetían
idénticos en cada corrida y enterraban el resumen real (feedback del dev 2026-07-25). Ahora:

```markdown
**{Story id} lista.** {UNA frase en llano: qué hace ahora el sistema que antes no hacía.}

- {qué cambió de comportamiento observable, en llano}
- {qué se verificó DE VERDAD — corrido, no leído: "la suite pasó entera", "el endpoint respondió 200 contra DevHost"}
- {qué quedó pendiente o diferido, si hay algo}
- Advisors: {🟢 limpio | 🟡 N warnings, ninguno bloqueante}

Está listo para commitear: falta el ok de guardar, en la ventana de permiso.

Pendiente tuyo: antes de darla por terminada, probala andando (que compile y pasen las pruebas no alcanza){ · el reloj de horas sigue abierto}{ · el pedido de Azure DevOps se cierra después de mergear}.
Detalle técnico (findings, archivos, mensaje de commit completo) — pedímelo y te lo pego.
```

**Story de pantalla: el dev la VE antes de pedir el commit.** 🔴 Por qué (2026-10-14): si el cierre entrega
sólo el mensaje de commit, una pantalla inentendible pasa todos los controles y se ve recién en staging. Para una story de pantalla (la que pide la guía del tester), antes de pedir el commit:
listar las capturas de la sección `## Capturas` de la ÚLTIMA evidencia del gate E2E de la story (carpeta de
evidencia, `<sid>-e2e-gate-<ts>.md`) como enlaces que se abren con un clic —un enlace markdown por captura con la
ruta ABSOLUTA, `[01-la-lista](/ruta/absoluta/01-la-lista.png)`: el editor lo abre al tocarlo y en la terminal
queda la ruta para copiar—, y debajo la línea
**«Así se ve: ¿se entiende?»**. Sin capturas, esa misma línea dice el motivo que trae la evidencia. Va arriba del
«Está listo para commitear», no en el detalle diferido.

**Reglas del cierre:**

- **Pruebas no medidas, dicho**: si el check `tests` quedó `sin-medir` (salida 3 del portón: no reconoce ninguna
  herramienta de pruebas en el repo), el bullet de lo verificado dice en una línea
  «pruebas no medidas: el portón no sabe correr las pruebas de este repo» y cómo medirlas (declarar el comando en el sitio de la organización, Configuración →
  Tu tecnología → Cómo se corren las pruebas). Nunca «la suite pasó» ni un silencio.
- **Las vueltas y lo abierto, dicho**: el bullet de los revisores copia la línea de
  `node <skill>/scripts/pipeline.js review-rounds --story <s> --repo <r>` («N vueltas de revisores (tope M); quedó
  abierto: …»). Lo que quedó como deuda se nombra; nunca un cierre que parece limpio con deuda adentro.
- **Máximo ~10 líneas** salvo que haya CRITICAL sin resolver (ahí manda COMM.i) o algo haya fallado.
- **El mensaje de commit SÍ va completo al chat** — es lo que el dev tiene que leer para aprobar.
  Es la única excepción al "detalle a pedido".
- **Los recordatorios van en UNA línea combinada y en llano**, no en 3 bloques con emoji y sangría.
  Sólo los que aplican: el del reloj si el Arranque avisó el trabajo a una herramienta de horas
  (`workSignalStarted`); el del pedido de trabajo si la story tiene `work_item` (o su nombre viejo). Sin «smoke», «DoD» ni «ADO» (caso
  2026-10-19: un dev solo, sin herramienta de horas ni Azure DevOps, leía «smoke de DoD» y «cierre en ADO» en su
  primera historia). El contenido normativo no cambia —
  sigue vigente todo lo de arriba (el registro de horas NO se cierra, probarla andando es obligatorio, el pedido se cierra
  después del merge); lo que cambia es cuánto espacio ocupan y cómo se dicen.
- **Sin conteos de líneas, sin listas de archivos tocados, sin rule IDs** en el cierre. Todo eso
  vive en `.advisors/pipeline-runs/<run-dir>/` y en el diff.
- **Lo que no corrió porque no aplicaba no se nombra**: el pase adversarial que no corrió por riesgo bajo, la herramienta de horas
  o Azure DevOps cuando no están. El cierre dice lo que pasó, no lo que no hacía falta.
- **Sin jerga del arnés**: el cierre no dice «gate», «matriz», «done», «riesgo LOW» ni nombres de comandos
  (`/tycon-…`). Se dice lo que significa: «las pruebas de cada criterio corrieron», «para darla por terminada».
  Caso 2026-10-19 (noche): un dev solo leyó «el gate lo salteó por riesgo LOW», «la matriz por criterio da verde» y
  «el reloj de horas y ADO no aplicaron» en su primera historia.
- **Después del commit, lo que sigue en una línea llana** con la frase que lo pide: «Cuando quieras subirla a main,
  decime "mergeala a main"». Nada de cerrarla con un comando.

## 🟢 Limpieza del marker file (MANDATORY post-2026-05-15)

Con `marker.js complete-step prepare-commit` ya marcado, **limpiar el marker del pipeline** para que los hooks dejen de
emitir reminders sobre esta story. Corré `marker.js clear` después del último push y del último pedido, no al aprobar
el mensaje: el ok de guardar (`saveOk`) vive en el marcador de la corrida abierta, y con la corrida cerrada no hay dónde
anotarlo ni qué comprobar. Si la persona decide no guardar, se cierra igual al final.

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js clear
```

Si el flujo sigue sin pausa a «Cerrar la historia» (`close-work-item.md`), el clear ocurre allá. Si el flujo termina en «Preparar el commit» (el dev decide commitear o no manualmente), clear acá.

### Si el cierre ofreció la instalación completa

La primera vez que una máquina nueva con la instalación mínima cierra una historia, `marker.js clear` imprime una
oferta: un título, tres renglones (qué cambia, dónde, cómo se vuelve atrás) y las dos órdenes para contestar. Sale una
sola vez por máquina y la decide el cierre, no vos. **Corré `marker.js clear` sin recortar su salida** (sin `| tail` ni
`| head`): la oferta va al final y con un recorte se pierde. Si igual la leíste recortada, su último renglón trae la
orden `offer show`, que la vuelve a mostrar entera sin contestarla (medido: con `| tail -2` el agente vio sólo las
órdenes y la oferta no llegó a la persona).

1. Mostrá el título y los tres renglones **tal cual**, sin resumirlos ni agregarles nada, y preguntá sí o no (con
   `AskUserQuestion` bajo Claude Code; con una pregunta llana en otra herramienta). La recomendación no la das vos: es
   decisión de la persona.
2. Con «sí», corré la orden de `offer accept` que imprimió el cierre (instala la completa; la salida dice si terminó).
   Con «no», la de `offer decline` (queda anotado y no se vuelve a ofrecer).
3. Sin respuesta, no insistas: la oferta ya quedó anotada como mostrada.

No se ofrece ni se pregunta en otro momento: si el cierre no imprimió la oferta, no hay nada que hacer. Si imprimió un
solo renglón con la orden (sesión sin persona delante), no se pregunta: se deja el renglón en el cierre.

**Salteable** si el dev pidió pausa explícita ("dejá el marker, voy a iterar más") — pero entonces el marker queda activo y los hooks van a seguir recordando los steps pendientes hasta que se complete el flujo o se cleane manualmente.

## 🟢 Setear `status: review` en el frontmatter (MANDATORY fix robusto 2026-05-20)

Tras `marker.js clear`, mutar el frontmatter de la story de `in-progress` a `review`. Source of truth durable cross-sesión:

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js update-story-status \
  "$STORY_PATH" "review"
```

**Por qué**: si el flujo termina en «Preparar el commit» (no llega a «Cerrar la historia»), la story queda lista para review pero el `status:` previo (`in-progress`) reflejaría mal el estado real. Otra sesión que abra `tycon-pipeline` sobre esta story va a leer `review` y NO va a re-arrancar el Arranque (PIPE-C5 lo detecta).

**Si «Cerrar la historia» sigue inmediatamente** después de este paso: el `status: review` se sobreescribe a `done` allá. NO es opcional saltearlo — siempre mutá `review` acá aunque vayas a «Cerrar la historia» después; el costo del double-write es trivial y deja el log de mutación más auditable.

**Si el update falla** (frontmatter sin línea `status:` por algún motivo raro): WARNING al usuario pero NO bloquear el commit prep — el dev puede setearlo manualmente.
