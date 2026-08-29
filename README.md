# SixSixMusic Together Relay

Servidor **relay** para el modo **online** de la app SixSixMusic. Permite que dos móviles se conecten por **internet** (sin importar la red Wi-Fi) usando un **código de 6 dígitos** o un **QR** que apunte a ese código.

Es un "hub de retransmisión" + API REST:

- `POST /v1/together/sessions` → el **host** crea una sesión y recibe un `code` de 6 dígitos.
- `POST /v1/together/sessions/resolve` → el **invitado** entrega el `code` y recibe la sesión.
- WebSocket `/v1/together/ws` → el relay conecta host e invitados y **reenvía los mensajes** de sincronización en tiempo real.

Necesita un entorno que soporte **WebSocket persistente** (Railway, Render, Fly.io o un VPS). **NO** funciona en hosting web estático/fáctico (PHP sin procesos).

---

## Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `PORT` | no | Puerto HTTP. Railway/Render lo definen solos. |
| `TOGETHER_TOKEN` | sí (recomendado) | Token Bearer. **Debe coincidir** con `BuildConfig.TOGETHER_BEARER_TOKEN` de la app. Sin esto, cualquiera podría crear sesiones. |
| `PUBLIC_BASE_URL` | sí | URL pública del relay **sin `/v1`** (p. ej. `https://tu-relay.up.railway.app`). Se usa para calcular el `wsUrl` que se devuelve a la app. |

---

## Despliegue en Railway (gratis para empezar)

1. Sube la carpeta `relay/` (o este repo) a **GitHub**.
2. En Railway → **New Project → Deploy from GitHub** → elige el repo.
3. Railway detecta `relay/package.json`. En **Settings** de la app, define `Root Directory = relay`.
4. Ve a **Variables** y añade:
   - `TOGETHER_TOKEN` = un token tuyo (ej. `mi-token-secreto-123`)
   - `PUBLIC_BASE_URL` = la URL que te da Railway (la de tu servicio, ej. `https://sixsixmusic-relay.up.railway.app`)
5. Railway asigna `PORT` solo. Espera a que esté **Deployed** y **Healthy**.

> En **Render**: crea un **Web Service**, conecta el repo, Root Directory `relay`, Build `npm install`, Start `npm start`. Proporciona `TOGETHER_TOKEN` y `PUBLIC_BASE_URL` (la URL de tu servicio Render).

## Probar que está vivo

```
GET https://tu-relay.up.railway.app/health
```

---

## Conectar con la app

### 1. Token en la app
Pon el **mismo** `TOGETHER_TOKEN` en `app/local.properties`:

```properties
TOGETHER_BEARER_TOKEN=mi-token-secreto-123
```

(o configura la variable de entorno `TOGETHER_BEARER_TOKEN`).

Reconstruye la app.

### 2. URL del relay en la app
La app descarga la URL del relay desde un archivo en GitHub
(`SixSixMusicServer.txt`). Tienes dos opciones:

- **Opción A (recomendada, sin GitHub):** usa el relay en `localhost`/una IP temporal o edita el código para fijar tu URL. (Más abajo.)
- **Opción B (vía GitHub):** crea un repo o archivo accesible y que la primera línea contenga tu URL pública.

Para fijar la URL directamente en el código, edita
`app/src/main/kotlin/com/sixsixmusic/together/TogetherOnlineEndpoint.kt`
y cambia el valor de `EndpointSourceUrl` por la URL de tu relay, o añade un `fallback`. El archivo que se descarga solo tiene que contener tu URL en su primera línea.

---

## Notas

- El relay guarda las sesiones **en memoria** (sin base de datos). Se reinicia al desplegar; eso está bien para este uso.
- El código de 6 dígitos deja de ser válido al cortarse la sesión o reiniciarse el server.
- Para producción con muchos usuarios usa un VPS y, si quieres, persistencia.
