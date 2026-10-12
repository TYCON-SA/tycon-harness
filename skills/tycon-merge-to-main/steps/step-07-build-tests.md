# Step 7 — Build + tests gate (paranoia)

**Objetivo**: verificar que el target post-merge compila y los tests pasan, ANTES de pushear. Si falla → propone abortar el merge.

## Detección de stack

Ejecutar en este orden y usar el primero que aplique:

### .NET
```bash
ls *.sln 2>/dev/null || ls **/*.csproj 2>/dev/null
```
Si existe → comandos:
```bash
dotnet build
dotnet test --filter "Category!=Integration&Category!=EdgeCase"
```

### Node.js
```bash
test -f package.json && jq -r '.scripts.test // empty' package.json
```
Si existe `package.json` y tiene script `test` → comandos:
```bash
npm install --no-audit --prefer-offline
TYCON_FULL_SUITE=1 npm test   # el prefijo es la corrida legítima que el freno de tests espera
```

### Stack desconocido o sin tests configurados

Preguntar al usuario:

```
No detecté stack conocido o tests configurados en este repo.
Stack detection:
- *.sln / *.csproj: <yes|no>
- package.json con script test: <yes|no>

Opciones:
(a) Especificá comandos custom (build_cmd y test_cmd)
(b) Saltar el gate (NO recomendado — el merge se pushea sin verificación)
(c) Cancelar el push (deja el merge commit local, abortá vos manualmente con `git reset --hard HEAD~1`)
```

## Acciones (con stack detectado)

### 7.1 — Build

```bash
<build_cmd>
```

Capturar exit code y últimas ~20 líneas del output.

Si falla → ir a 7.4 (handle failure).

### 7.2 — Tests

```bash
<test_cmd>
```

Capturar exit code y últimas ~20 líneas + el conteo total/pasados/fallados (parsear del output).

### 7.3 — Si todo OK

Actualizar el `full_message` del merge commit con los resultados reales — reemplazar el placeholder `Tests: [pendiente...]` por:

```
Tests: <N>/<N> PASS, 0 regresiones.
```

Para amendar el merge commit:

```bash
git commit --amend -m "$(cat <<'EOF'
<full_message con tests reales>
EOF
)"
```

Esto cambia el hash del merge commit. Actualizar `merge_commit_hash` en el state.

### 7.4 — Si falla

🚫 ABORT con mensaje:

```
❌ <Build|Tests> falló post-merge.

Output (últimas líneas):
<excerpt>

El merge commit (`<merge_commit_hash>`) quedó local pero NO se va a pushear.

Opciones:
(a) Abortar el merge (vuelve al estado pre-merge, perdés el merge commit local):
    git reset --hard HEAD~1

(b) Conservar el merge commit y arreglar el problema:
    1. Investigá la falla (output completo arriba)
    2. Si es flaky test: re-corré `<test_cmd>` manualmente
    3. Si es bug introducido por el merge: abrí un fix branch desde HEAD, fixealo, commiteá encima del merge, después pusheá

(c) Saltar el gate y pushear igual (RIESGOSO — solo si confiás 100% que es flaky):
    git push origin <target>

NO voy a pushear automáticamente con tests rojos.
```

## Edge cases

- **Tests con flakiness conocida**: el skill no trackea historial de flaky. Si el usuario dice que lo era, ofrecer re-correr una vez (`<test_cmd>` again). Si pasa la segunda → seguir; si falla otra vez → tratarlo como falla real.

- **Build muy largo (>10 min)**: ejecutar con `run_in_background: true` y notificar al usuario. NO sleep loop.

- **Tests parcialmente pasan** (algunos skip esperados, ej: integration filter): contar solo PASS+FAIL, ignorar SKIPPED. Si hay 0 FAIL → green.

## Output del step

```json
{
  "build_passed": true,
  "tests_passed": true,
  "test_count_pass": <N>,
  "test_count_fail": 0,
  "merge_commit_hash_post_amend": "<sha>",
  "amended": true|false
}
```

Pasar al Step 8.
