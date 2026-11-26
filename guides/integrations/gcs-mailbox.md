# El buzón de ejecuciones sobre Google Cloud Storage

Para un equipo cuya nube es GCP: las máquinas suben sus ejecuciones a un bucket de Cloud Storage y el sitio de la
organización, en Cloud Run, las lee. El conector vive en `integrations/gcs/` (tipo `mailbox`, proveedor `gcs`); el
núcleo del arnés no lo nombra. Azure Blob Storage sigue igual.

## Qué crear en GCP

1. **El bucket.** Privado, sin acceso público, con acceso uniforme a nivel de bucket. Por ejemplo
   `gcloud storage buckets create gs://<bucket> --uniform-bucket-level-access --public-access-prevention`.
2. **Un rol propio con un único permiso: `storage.objects.create`.** Nada de leer, listar ni borrar: la cuenta de la
   subida sólo crea objetos nuevos. Sin `storage.objects.delete` tampoco puede pisar uno que ya está.
   `gcloud iam roles create buzonSoloCrear --project <proyecto> --permissions storage.objects.create`
3. **Una cuenta de servicio para la subida**, con ese rol otorgado **sobre el bucket** (no sobre el proyecto):
   `gcloud storage buckets add-iam-policy-binding gs://<bucket> --member serviceAccount:<cuenta> --role projects/<proyecto>/roles/buzonSoloCrear`
4. **Su clave HMAC** (`gcloud storage hmac create <cuenta>`): da el id de acceso y el secreto que van en la llave. La
   clave se revoca **desactivándola** (`gcloud storage hmac update <id> --deactivate`); recién desactivada se puede
   borrar. Para rotar: crear una clave nueva, cambiar la llave, desactivar la vieja.
5. **El rol de lector del bucket para la identidad del sitio**: la cuenta de servicio con la que corre el servicio de
   Cloud Run recibe `roles/storage.objectViewer` sobre el bucket. El sitio no usa ninguna clave: pide el token de su
   identidad al servidor de metadatos de su entorno.

## La llave de las máquinas

`scripts/metrics/corridas-buzon.json` en la capa del equipo, como la de Azure, con otra forma:

```json
{
  "provider": "gcs",
  "bucket": "<bucket>",
  "accessId": "<id de la clave HMAC>",
  "secret": "<secreto de la clave HMAC>",
  "vence": "AAAA-MM-DD",
  "rotar": "crear una clave HMAC nueva, cambiar esta llave y desactivar la vieja"
}
```

- `vence` es la fecha de rotación que fija el equipo (una clave HMAC no vence sola); 30 días antes la subida avisa,
  igual que con Azure.
- Un campo que falta o tiene otra forma es `config_ilegible`, con el campo nombrado. Ningún mensaje repite un valor de la
  llave: el secreto no sale nunca.
- Antes de cada tanda la subida intenta **listar** el bucket y sólo sigue si la respuesta es 403 `AccessDenied`: una llave
  que puede listar no es la del buzón (sale 2, `llave_con_lectura`, sin subir nada).

## El perfil del equipo

`operations.json`, sección `site.mailbox`:

```json
{ "provider": "gcs", "bucket": "<bucket>", "threads": false }
```

La llave de las máquinas y `site.mailbox.bucket` nombran **el mismo bucket**: la subida usa el de la llave y el sitio el
del perfil, y no se cruzan. El sitio corre con `SITE_MAILBOX_IDENTITY=managed` (la identidad del entorno donde corre).
Fuera de GCP no hay servidor de metadatos: el sitio dice `sin_configurar` a los 2 segundos, sin colgarse.

## Comprobar que la llave sólo crea

Desde una máquina con la llave instalada y algo ya subido:

```bash
node scripts/metrics/upload-runs.js --check-create-only
```

Vuelve a subir los mismos bytes del objeto confirmado más chico, sin la precondición de no pisar. 403 `AccessDenied`
(la cuenta no tiene `storage.objects.delete`) sale 0: la cuenta sólo crea. 200 sale 1: la cuenta pudo pisar, o el
objeto ya no estaba.

## Los códigos de respuesta

Medidos en un bucket de laboratorio (`acme-buzon-lab` en los ejemplos) con la API XML y una clave HMAC:

| Situación | Respuesta | Qué hace la subida |
|---|---|---|
| Objeto nuevo | 200 | `creado`: recién ahí se anota en el registro local |
| El objeto ya está (`x-goog-if-generation-match: 0`) | 412 `PreconditionFailed` | `ya_existe`: un reintento con una versión nueva |
| La cuenta no puede crear | 403 `AccessDenied` | `llave_sin_permiso` |
| Listar con la cuenta que sólo crea | 403 `AccessDenied` | la prueba de antes de la tanda pasa |
| La firma no casa (secreto equivocado) | 403 `SignatureDoesNotMatch` | `llave_invalida` |
| La clave HMAC desactivada | 401 `KeyInactive` | `llave_invalida` |
| El bucket no existe | 404 `NoSuchBucket` | `llave_invalida`, con el bucket en el motivo |
| El Content-MD5 no casa | 400 `BadDigest` | el contenido no llegó entero: no se anota |
| El servicio falló | 5xx, 429, 408 | `servicio_fallo` |
| Sin respuesta (corte de red, tiempo agotado) | — | `sin_red` |

Ninguna respuesta que no sea 200 marca el archivo como subido, y la salida es distinta de 0.

Del lado del sitio (API JSON, con el token de su identidad): 401 es `credencial_rechazada` (el token venció o no vale),
403 es `sin_permiso` (la identidad no tiene el rol de lector) y 404 es `sin_contenedor`. En los tres la pasada no es
completa y el sitio sigue mostrando lo último que leyó entero.

## Lo que todavía no hace

- La bajada desde una máquina (`download-runs.js`) y los procesos de la noche leen sólo Azure: con una llave gcs salen 1
  con `no_soportado` y no piden nada. Van en otra historia.
- No borra ni poda objetos del bucket: la subida sólo crea.
