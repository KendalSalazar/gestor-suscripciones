## Contexto del proyecto

Estoy construyendo un proyecto de práctica personal: un **sistema de rastreo de suscripciones compartidas** ("subscripciones-compartidas"). El objetivo es llevar el control de suscripciones (Netflix, Spotify, gimnasio, etc.), con recordatorios de pago y detección de anomalías (subidas de precio, pagos faltantes).

### Modos de uso

El sistema soporta dos modalidades bajo el mismo modelo de datos:

- **Modo individual**: un usuario lleva sus propias suscripciones sin compartir con nadie.
- **Modo familia**: varias personas comparten una suscripción y cada una confirma su parte del pago.

Ambos modos se resuelven con el mismo concepto: un `group` (grupo). El modo individual es simplemente un grupo con un solo miembro (el usuario mismo, como owner). Al registrarse, cada usuario obtiene automáticamente un grupo `personal`. Si además crea o se une a un grupo `family`, sus suscripciones familiares viven en ese otro grupo.

### Registro de pagos (nivel semi-automático con confirmación)

1. Un job programado (cron) revisa `next_billing_date` de cada suscripción activa y genera un registro de pago en estado `pending` con el monto esperado.
2. El usuario recibe una notificación y confirma el pago desde el dashboard.
3. Al confirmar, puede aceptar el monto esperado o corregirlo si cambió. Si cambió, se marca `price_changed = true`.
4. En modo familia, al generarse el pago se crean automáticamente los `payment_shares` correspondientes a cada miembro activo del grupo, y cada quien confirma su propia parte.
5. Otro job revisa pagos que llevan muchos días en `pending` sin confirmar y genera una notificación de "pago no confirmado".

### Modelo de datos

```
users
  id, email, password_hash, name, created_at

groups
  id, name, type (personal/family), owner_id (FK users), created_at

group_members
  id, group_id (FK), user_id (FK), role (owner/member),
  status (active/invited/removed), joined_at

subscriptions
  id, group_id (FK), name, provider, expected_cost, billing_cycle,
  next_billing_date, active, created_at

payments
  id, subscription_id (FK), expected_amount, actual_amount, expected_date,
  status (pending/confirmed/skipped), price_changed (boolean)

payment_shares
  id, payment_id (FK), user_id (FK), share_amount, share_percentage,
  status (pending/confirmed), confirmed_at

notifications
  id, user_id (FK), subscription_id (FK), type (reminder/anomaly/invite),
  message, sent_at, read_at
```

### Stack técnico

- **Backend**: Node.js + Express 5 + TypeScript, `axios` solo si más adelante se requieren llamadas externas.
- **Frontend**: Next.js + React (App Router).
- **Autenticación**: JWT (access token corto + refresh token). El refresh token se entrega como cookie `httpOnly` y se persiste únicamente como hash en `refresh_tokens`.
- **Logger**: Winston (niveles `info`, `warn`, `error`, transports separados por contexto: `auth`, `payment`, `job`; sin loguear passwords, tokens, secretos, cookies, URLs de conexión ni datos de tarjetas).
- **Base de datos**: PostgreSQL corriendo local vía Docker.
- **Gestor de paquetes**: pnpm.
- **Convenciones**: TypeScript con specifier `^5.7.0`, `"module": "commonjs"`, tests co-ubicados dentro de `src/`.

### Estructura real del repositorio

La Fase 1 ya está completada. Partir de esta estructura real; no asumir directorios que no existen:

```
gestor-suscripciones/
├── backend/
│   ├── src/
│   │   ├── config/
│   │   │   ├── env.ts
│   │   │   └── logger.ts
│   │   ├── db/
│   │   │   ├── pool.ts
│   │   │   ├── migrate.ts
│   │   │   └── migrations/
│   │   │       ├── 001_create_users.sql
│   │   │       ├── 002_create_groups.sql
│   │   │       └── 003_create_group_members.sql
│   │   ├── middleware/
│   │   │   ├── errorHandler.ts
│   │   │   └── notFound.ts
│   │   ├── routes/
│   │   │   └── health.ts
│   │   ├── types/
│   │   │   └── express.d.ts
│   │   ├── app.ts
│   │   └── server.ts
│   ├── .env.example
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   ├── src/app/
│   └── .gitignore
├── docker-compose.yml
└── .gitignore
```

Notas importantes:

- El directorio existente se llama `src/middleware`, en singular.
- No existen todavía `src/modules`, `src/jobs` ni `src/utils`; no describirlos como si ya estuvieran establecidos.
- No existe un `backend/.gitignore`; el `.gitignore` raíz ya ignora `.env`, `node_modules`, `dist` y logs.
- `backend/src/config/logger.ts` exporta `authLogger`, que debe reutilizarse para este módulo.
- `backend/src/middleware/errorHandler.ts` ya exporta `AppError` y el middleware base.
- `frontend/` no se modifica durante esta fase, salvo que el plan indique explícitamente una integración mínima imprescindible.

### Plan de fases general

1. Base del proyecto (setup, Express, Postgres, Winston, migraciones de `users`/`groups`/`group_members`) — **completada**.
2. Autenticación (JWT access+refresh, creación automática del grupo personal al registrarse) — **fase actual**.
3. Suscripciones (CRUD, permisos por rol, dashboard básico).
4. Pagos y jobs programados (generación de pagos pendientes, confirmación, detección de `price_changed`).
5. Modo familia e invitaciones (flujo de invitación, `payment_shares`, gestión de miembros).
6. Notificaciones y anomalías (job de pagos vencidos, reglas de anomalía, centro de notificaciones).
7. Pulido (manejo de errores, logging completo, tests, documentación del API).

---

## Instrucción principal

Genera un **plan detallado en Markdown para la Fase 2 únicamente** (Autenticación), listo para dárselo a un modelo de implementación (OpenCode) como guía paso a paso.

Debes crear el archivo:

```text
prompts/plan-fases/plan-fase-2.md
```

No implementes código de la Fase 2 en este archivo ni en `backend/`. Este archivo es un prompt para que otro modelo genere el plan; tu única modificación debe ser la creación o actualización de `prompts/plan-fases/plan-fase-2.md`.

El plan generado debe asumir que la Fase 1 está implementada y debe incluir lo siguiente.

### 1. Flujo completo de autenticación

Describir paso a paso:

- Registro.
- Login.
- Refresh.
- Logout.
- Qué sucede exactamente al registrarse.

El registro debe crear, en **una única transacción**:

1. El usuario en `users`.
2. Un `groups` con `type = 'personal'` y `owner_id` igual al nuevo usuario.
3. Un `group_members` con `role = 'owner'`, `status = 'active'` y `joined_at = NOW()`.

Los tokens solo deben generarse después de confirmar correctamente la transacción. Un fallo en cualquiera de las tres inserciones debe hacer rollback completo.

### 2. Migración de `refresh_tokens`

Definir una migración SQL concreta. Como mínimo debe incluir:

- `id` UUID.
- `user_id` con FK a `users`.
- `token_hash`, nunca el refresh token en texto plano.
- `expires_at`.
- `revoked_at` nullable.
- `created_at`.
- Índices razonables para `user_id`, `expires_at` y tokens no revocados.
- Foreign key y comportamiento `ON DELETE`.

Explicar el ciclo de vida y decidir explícitamente si se utiliza una familia de tokens. La recomendación para este proyecto es rotar el refresh token en cada uso: revocar el anterior, crear uno nuevo y detectar, si es posible, reutilización de un token revocado.

El plan debe indicar cómo hashear y comparar refresh tokens, evitando que un acceso a la base de datos permita reutilizarlos directamente.

### 3. Payload exacto del access token

Fijar un payload concreto. Preferir claims estándar:

```json
{
  "sub": "user-uuid",
  "email": "usuario@example.com",
  "type": "access",
  "iat": 1234567890,
  "exp": 1234568790
}
```

El plan debe explicar:

- Cómo se valida `sub`.
- Cómo se verifica `type`.
- Qué algoritmo y secreto se usan.
- Qué no se incluye nunca: `password_hash`, passwords, refresh tokens, secretos, datos de tarjetas, grupos completos, permisos potencialmente obsoletos o información innecesaria.

Usar `sub` como claim estándar y exponer internamente `req.user.id` para las rutas futuras, salvo que el plan justifique otra decisión.

### 4. Passwords

Definir bcrypt con cost factor concreto, recomendando `12` como punto de partida para este proyecto. Explicar que debe medirse en el entorno real y poder ajustarse posteriormente sin romper usuarios existentes.

Definir reglas mínimas de password sin exigir complejidad artificial: longitud mínima, rechazo de valores vacíos y nunca devolver ni registrar la contraseña o su hash.

### 5. Middleware de autenticación

Describir `auth.middleware.ts` en la estructura real `src/middleware/`:

- Obtención del Bearer access token.
- Verificación de firma, algoritmo, expiración y claim `type`.
- Respuesta ante token ausente, malformado, inválido o expirado.
- Diferenciar errores de autenticación (`401`) de autorización (`403`) futura.
- Qué debe añadir a `req`: como mínimo `req.user = { id, email }`.
- Tipado de `Express.Request` en `src/types/express.d.ts`.
- No leer el access token desde una cookie.

### 6. Endpoints exactos

Definir request, response, validaciones, códigos HTTP y errores para:

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`

Requisitos:

- Normalizar el email con `trim().toLowerCase()` antes de consultar o insertar.
- No permitir enumeración de usuarios: login debe responder `401 Invalid credentials` tanto si el email no existe como si la password es incorrecta.
- Registro duplicado: definir respuesta `409` sin revelar información innecesaria.
- Usar respuestas JSON consistentes con el `errorHandler` de la Fase 1.
- No devolver `password_hash`, refresh tokens ni secretos.
- Definir si `register` y `login` devuelven access token y usuario público.

### 7. Cookie httpOnly

El plan debe incluir instalación y uso de `cookie-parser`, porque Express no expone `req.cookies` por defecto:

```bash
pnpm add cookie-parser
pnpm add -D @types/cookie-parser
```

Definir configuración exacta y diferenciada:

**Development:**

```text
httpOnly: true
secure: false
sameSite: 'lax'
maxAge: 7 días
path: /auth
```

**Production:**

```text
httpOnly: true
secure: true
sameSite: 'lax' o 'strict', con justificación
maxAge: igual a JWT_REFRESH_EXPIRES_IN
path: /auth
```

Explicar que frontend `localhost:3000` y backend `localhost:3001` son distintos orígenes, por lo que CORS debe conservar `credentials: true` y el origen explícito `http://localhost:3000`. No permitir `*`.

Definir cómo se elimina la cookie en logout: mismo nombre, `path`, `httpOnly`, `sameSite` y `secure` compatibles con la cookie original. El logout también debe revocar el refresh token en base de datos.

Incluir una nota sobre CSRF: con `SameSite` restrictivo el riesgo queda reducido, pero si en el futuro se usa `SameSite=None` será necesaria protección CSRF explícita.

### 8. Logging de autenticación

Usar el `authLogger` existente. Definir eventos concretos:

- Registro exitoso, con `userId`.
- Registro duplicado, con email anonimizado o hash parcial.
- Login exitoso, con `userId`.
- Login fallido, sin revelar si el email existe.
- Refresh válido usado, con `userId`.
- Refresh inválido, expirado, revocado o reutilizado.
- Logout exitoso, con `userId` si pudo identificarse.

Nunca registrar passwords, hashes, JWTs, refresh tokens, cookies, headers `Authorization`, secretos, `DATABASE_URL` ni datos de tarjetas. No registrar bodies completos.

### 9. Validación

Recomendar e incluir `zod` como dependencia ligera, salvo justificación explícita para no usarla:

```bash
pnpm add zod
```

Definir schemas para registro, login y cualquier input de refresh/logout. Especificar:

- Email válido y normalizado.
- Password mínima.
- Límites de longitud para email y nombre.
- Mensajes de validación sin filtrar secretos.
- Conversión de errores de validación a `400` con el formato estándar del proyecto.

### 10. Estructura de archivos de la Fase 2

El plan debe proponer rutas concretas respetando la estructura actual. Puede añadir, como mínimo:

```text
backend/src/
├── middleware/
│   ├── auth.middleware.ts
│   └── errorHandler.ts             # existente, extender solo si hace falta
├── modules/auth/
│   ├── auth.controller.ts
│   ├── auth.routes.ts
│   ├── auth.service.ts
│   ├── auth.schemas.ts
│   └── auth.types.ts
├── db/migrations/
│   └── 004_create_refresh_tokens.sql
└── types/express.d.ts              # extender Request.user
```

Si se propone otra estructura, justificarla. No afirmar que `modules` ya existe; será una incorporación de esta fase.

Los tests, si se incluyen en el plan, deben estar co-ubicados dentro de `src/`, por ejemplo `src/modules/auth/auth.service.test.ts`.

### 11. Checklist final

Incluir un checklist ejecutable para verificar antes de pasar a la Fase 3:

- Registro atómico de usuario, grupo personal y miembro owner.
- Rollback ante fallos de cualquier inserción.
- Email normalizado y duplicados controlados.
- Password hasheada con bcrypt.
- Access token firmado y validado correctamente.
- Refresh token almacenado únicamente como hash.
- Rotación y revocación del refresh token.
- Logout revoca en DB y elimina la cookie.
- Cookie `httpOnly` y configuración dev/producción correctas.
- `req.user` tipado y disponible para siguientes rutas.
- Errores `400`, `401`, `403`, `409` y `500` consistentes.
- No hay secretos, tokens ni passwords en logs o respuestas.
- Migración idempotente y sin tablas de fases posteriores adicionales.
- Tests co-ubicados y comandos de verificación concretos.

No implementes suscripciones, pagos, jobs, notificaciones ni el modo familia todavía. Esta fase es únicamente autenticación y la creación automática del grupo personal durante el registro. Sé específico y concreto en cada paso, como si el documento fuera a ser ejecutado por otro modelo sin contexto adicional.
