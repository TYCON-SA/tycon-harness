# Una página de juguete, con la forma de la página pública de Windows

Dato de prueba del ensayo guiado: el bloque de la parte 1 con su marca, y el nombre del repo ya puesto (una organización
y un repo de juguete), como queda en una copia publicada. Donde la página nombra la carpeta del arnés va el marcador
`{{harness-place}}`: la prueba pone ahí el nombre de verdad antes de leerla.

## Parte 1 — instalación base

<!-- guided:base -->
```text
Necesito instalar en esta máquina el arnés TYCON para trabajar con Claude Code (y con BIZUIT Extensions). El arnés
vive en un repo público de GitHub: se baja sin cuenta y sin permiso. Seguí estos pasos EN ORDEN, en PowerShell 7,
corriendo cada comando TAL CUAL (no lo reescribas ni lo "mejores"). Si una salida no es la esperada, o aparece un error
que no está acá, PARÁ, no arregles nada a mano y mostrame la salida tal cual.

Perfil: si arriba de este pedido te escribí «quiero el perfil mínimo», en los pasos 3 y 4 cambiá --profile full por
--profile minimal, y salteá el paso 5. Si no, va full.

Si un paso contesta 403 o «límite de la API de GitHub»: GitHub limita los pedidos sin credencial a 60 por hora por
dirección de red, y una oficina entera suele compartir la suya. PARÁ y avisame, sin reintentar: o espero a que se
renueve (como mucho una hora) y repetimos ese paso; o, si tengo un permiso de GitHub propio, lo pongo YO en la variable
TYCON_GITHUB_TOKEN con la línea de abajo, en la misma terminal donde corro el guion (no se ve al pegarlo; vos no lo
leas ni lo muestres), y vuelvo a correr get-harness, que lo usa y lo guarda:
    $s = Read-Host -AsSecureString 'Permiso de GitHub'; $env:TYCON_GITHUB_TOKEN = [System.Net.NetworkCredential]::new('', $s).Password
Bajar el propio guion va siempre sin credencial: si el 403 fue ahí, sólo queda esperar.

1. Herramientas:
   $PSVersionTable.PSVersion.ToString(); node --version; tar --version
   Esperado: PowerShell 7.algo, node v22 o más y tar (viene con Windows 10 y posteriores). Lo que falte, decime que lo
   instale yo, de a uno:  winget install Microsoft.PowerShell · winget install OpenJS.NodeJS.LTS
   Después de instalar algo, tengo que cerrar y volver a abrir la terminal y Claude Code: avisame y esperá.
   (git NO hace falta: el arnés se baja como archivos, no se clona.)

2. Bajar el guion de instalación (se baja, se lee y después se corre; no se clona nada): dame estas dos líneas para
   pegar en mi ventana de PowerShell 7, una por una:
       Invoke-WebRequest -Headers @{ Accept = 'application/vnd.github.raw' } -OutFile get-harness.ps1 https://api.github.com/repos/acme-lab/arnes-lab/contents/scripts/setup/get-harness.ps1
       Get-Content get-harness.ps1
   Esperado: el archivo get-harness.ps1 en mi carpeta y un guion que empieza con «# get-harness.ps1 — baja la versión
   publicada del arnés (sin git)».

3. Ver el plan de instalación (no instala nada): dame esta línea para mi ventana:
       pwsh -File get-harness.ps1 -- --profile full --integrations none --packs all --dry-run
   Baja la versión a una carpeta temporal y muestra el plan. Te paso la salida: mostrame el plan resumido (qué escribe,
   qué hooks pone) y preguntame si sigo.

4. Con mi sí, instalar, en mi ventana:
       pwsh -File get-harness.ps1 -- --profile full --integrations none --packs all --yes
   Esperado: termina con «versión: …» y un resumen, sin rojo. El arnés queda en $env:USERPROFILE\.tycon\harness
   (archivos, sin git).

5. Los controles que corren al commitear (hooks globales de git). Antes de configurar nada, avisame esto y esperá mi
   sí: con una carpeta global de hooks, git deja de correr los .git/hooks/ propios de cada uno de mis repos (el control
   del arnés corre en su lugar el .githooks/pre-commit de cada repo). Si te digo que no, salteá este paso.
   Con mi sí, primero mirá si ya tengo algo configurado:
   git config --global --get core.hooksPath
   Si no devuelve nada, corré:  git config --global core.hooksPath "$env:USERPROFILE\.git-hooks"
   Si devuelve otra carpeta, NO la pises: mostrámela y decidimos.

6. Verificar (tres comandos):
   node "$env:USERPROFILE\.claude\{{harness-place}}\scripts\setup\harness.js" doctor
   @(Get-ChildItem "$env:USERPROFILE\.claude\skills" -Directory).Count
   (Select-String -Path "$env:USERPROFILE\.claude\CLAUDE.md" -Pattern "README.md").Count
   Esperado: doctor dice «perfil: full» (o «perfil: minimal» si pedí el mínimo) y cierra con «todo en orden» (o «N aviso(s), nada en rojo»); más de 40 skills; 1.

7. Armame UN solo bloque de texto, para guardarlo o para pedir ayuda, con la salida de los pasos 1, 2 y 4 (el final), y
   la salida COMPLETA del paso 6, más una línea final «OK» o «NO OK». Después decime que cierre y vuelva a abrir Claude
   Code.

Para trabajar con BIZUIT Extensions: el paquete bizuit ya queda prendido para todos mis repos (--packs all). Las guías
para empezar un plugin o un formulario están en ~/.claude/{{harness-place}}/guides/bizuit/ y te mandan a los templates públicos.
```
<!-- /guided:base -->
