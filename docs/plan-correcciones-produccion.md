# Plan de correcciones — preparación para producción

Estado actualizado. Casi todo aplicado y verificado a nivel de compilación
(`next build` + TypeScript). Ver "Notas de verificación" al final.

Leyenda de estado:
- ✅ HECHO — aplicado y verificado con build.
- ⬜ PENDIENTE — no aplicado (con motivo).
- ⛔ DESCARTADO — decisión explícita de no hacerlo por ahora.

Leyenda de prioridad original:
- P0 Crítico · P1 Seguridad · P2 Calidad/operación

---

## P0 — Crítico

### ✅ P0-1. Auth + autorización en el PATCH de media
`app/api/event/[event-slug]/media/[media-id]/route.ts`. Añadido `verifyRequest`;
un usuario solo mueve su propia media (`AND user_id`), admin mueve cualquiera.

### ✅ P0-2. Proxy (auth gate a nivel edge)
En Next 16 la convención `middleware` se renombró a `proxy`. `proxy.ts` reescrito:
`export function proxy` que rechaza 401 sin cookie `auth_token`, matcher
`/api/event/:path*`. La verificación completa del JWT sigue por-ruta.

### ✅ P0-3. Corregido el PUT de usuarios + guard
`app/api/me/route.ts`. Ahora keya por `userId` (no `event_id`), update parcial,
contraseña opcional, hash tras validar. Desactivado por defecto (503) salvo
`ENABLE_USER_ADMIN_API=true`.

### ✅ P0-4. Eliminado el endpoint de debug `test-db`
Borrado `app/api/test-db/`.

---

## P1 — Seguridad

### ✅ P1-1. Validación TLS del certificado de Postgres
`lib/db.ts`. Helper `buildSslConfig()`: `DB_SSL_CA` → valida; 
`DB_SSL_REJECT_UNAUTHORIZED=true` → valida contra trust store; si no, permisivo
(default para no romper la conexión actual). **Activar en producción.**

### ✅ P1-2. Login endurecido
`app/api/me/login/route.ts`. Validación antes de la query, respuesta uniforme 401
(sin enumeración de usuarios), rate limiting por IP.
**Limitación:** el rate limiter es en memoria → best-effort en serverless
(Vercel). Para límite real distribuido: Upstash/Redis.

### ✅ P1-3. Cabeceras de seguridad
`next.config.ts`. `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
`Strict-Transport-Security`, `Permissions-Policy` para todas las rutas.
**Pendiente dentro de este punto:** ⬜ Content-Security-Policy NO puesta a
propósito (GA + Vercel Blob + estilos externos/inline la romperían sin validar
contra el deploy real). CORS: no añadido; no hay clientes cross-origin conocidos.

### ✅ P1-4. Algoritmo JWT fijado a HS256
`app/utils/jwt.ts` (sign) y los 11 `jwt.verify` (vía `verifyRequest` y los que
quedaban inline). Cierra el riesgo de confusión de algoritmo.

### ✅ P1-5. Centralización de auth — Parte A
Reemplazado el `jwt.verify` inline por `verifyRequest` en: POST event, GET event,
GET/POST me, bulk DELETE/PATCH, likes, download (x2), media legacy. Sin cambiar
autorización. `jsonwebtoken` ya solo se importa en `app/utils/jwt.ts`.
- ⛔ **Parte B (pertenencia al evento): DESCARTADA.** Proyecto pequeño; el slug
  ya actúa como barrera de acceso. Revisitar si se vuelve multi-evento real.

### ✅ P1-6. Colisión de slug al crear/editar eventos
`app/api/event/route.ts` (POST) y `.../[event-slug]/route.ts` (PUT). Detección de
`23505` → 409; el PUT además distingue 404 (rowCount 0) del resto.

---

## P2 — Calidad y operación

### ✅ P2-1. Un solo lockfile (yarn)
Borrado `package-lock.json`; añadido `"packageManager": "yarn@1.22.22"` y
`turbopack.root` en `next.config.ts`. Warning de lockfiles resuelto.
- ✅ Borrados los `yarn.lock` vacíos `~/yarn.lock` y `~/projects/yarn.lock`
  (fuera del workspace) que confundían la raíz del proyecto.

### ✅ P2-2. README con env vars y despliegue
`README.md` reescrito: variables reales, setup de DB + migraciones, usuario demo,
worker de Railway, testing y deploy.

### ✅ P2-3. Blobs huérfanos en borrado bulk
`.../media/bulk/route.ts`. El fallo de `del()` ahora loguea línea estructurada
`ORPHANED_BLOBS` (evento, mediaIds, blobUrls) para limpieza posterior.

---

## Hallazgo extra (fuera del plan original)

### ✅ Rutas de secciones sin autenticación
Detectado al hacer P1-5. `POST /sections` y `PUT`/`DELETE /sections/[section-id]`
no tenían auth (solo guard de demo). Cerradas con `verifyRequest`
(**cualquier usuario autenticado**, temporal). Además en el POST: quitados los
`console.log` de debug y añadido guard de evento inexistente (404 en vez de crash).
- Nota de coherencia: crear evento exige admin, pero secciones = cualquier
  autenticado. Unificar a solo-admin si se decide más adelante.

---

## Notas de verificación

- Todo verificado con `next build` (compila + TypeScript pasa) tras cada tanda.
- **NO** ejecutado en runtime ni con la suite de tests. El comportamiento en vivo
  (rate limiting, 401/403/409, proxy rechazando sin cookie) conviene comprobarlo
  al desplegar.
- Antes de tráfico real, revisar los 3 puntos dependientes del entorno:
  1. CSP (P1-3) — pendiente, afinar contra el deploy.
  2. Rate limiting del login (P1-2) — best-effort en serverless.
  3. TLS de la DB (P1-1) — activar con `DB_SSL_CA` o `DB_SSL_REJECT_UNAUTHORIZED`.
- Variables de entorno a fijar en producción: `JWT_SECRET`, `BLOB_READ_WRITE_TOKEN`,
  DB (`DATABASE_URL` o `DB_*`), y opcionalmente `DB_SSL_CA`,
  `ENABLE_USER_ADMIN_API`.
