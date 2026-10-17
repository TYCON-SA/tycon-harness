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

**Lo que NO bloquea (a propósito):**

- `git reset --hard` — común para descartar cambios locales no commiteados.
- `git checkout -- file` / `git restore file` — selectivo, recovery posible.
- `kubectl delete` / `docker system prune` — TYCON no es heavy en infra; agregar si surge incidente.
- `rm -rf <path>` con path explícito (ej: `rm -rf bin obj node_modules`) — uso legítimo.
- `git push --force-with-lease` a branches que NO son `main`/`master`/`dev`/`release/*` — rebase de feature branch propia es válido.
- Lectura de `.env` vía `grep`/`awk`/`sed` — el bloqueo es solo sobre `cat`/`less`/`more`/`head`/`tail` (modos típicos de "miremos qué hay acá"). Workflows automatizados que extraen una key específica con `grep` siguen funcionando.

## Override de emergencia

Hay 2 formas, según alcance:

**Por comando** (recomendada — explícita, no se olvida):

```bash
TYCON_SAFETY_OFF=1 rm -rf ~/Downloads/junk
```

El hook detecta el prefijo `TYCON_SAFETY_OFF=1` en el propio comando y deja pasar SOLO ese.

**Por sesión** (cuando hacés varios destructivos legítimos seguidos, ej: limpiar entornos de dev):

```bash
export TYCON_SAFETY_OFF=1
# ... varios comandos ...
unset TYCON_SAFETY_OFF
```

⚠️ El override de sesión es peligroso porque queda activo hasta que cierres la terminal. Preferí el override por comando.

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

1. Override por comando: `TYCON_SAFETY_OFF=1 <cmd>`.
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
