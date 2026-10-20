# Plan Fase 2 — Autenticación

Guía de implementación para OpenCode. Ejecutar **solo esta fase**. No implementar suscripciones, pagos, jobs, notificaciones ni modo familia. No modificar `frontend/`.

Proyecto: sistema de rastreo de suscripciones compartidas (`gestor-suscripciones`).
Stack de esta fase: Express 5 + TypeScript + PostgreSQL + JWT (access) + refresh opaco en cookie httpOnly + bcrypt + zod + Winston (`authLogger`).

---

## 0. Alcance y estado actual

### En alcance

- Migración `004_create_refresh_tokens.sql`.
- Registro atómico: `users` + `groups` (`personal`) + `group_members` (`owner`/`active`).
- Login, refresh con rotación y logout.
- Access token JWT corto en el body JSON.
- Refresh token opaco en cookie `httpOnly`, persistido **solo como hash**.
- Middleware `auth.middleware.ts` y tipado de `req.user`.
- Validación con `zod`.
- Logging con `authLogger` (ya exportado en `src/config/logger.ts`).
- Tests unitarios co-ubicados de hashing, normalización y claims.

### Fuera de alcance

- CRUD de suscripciones, dashboard, pagos, invitaciones, jobs.
- Uso de `axios`.
- Access token en cookie.
- Refresh token en texto plano en la base de datos.
- Cambiar CORS a `origin: '*'`.
- Modificar `frontend/`.
- Tablas `subscriptions`, `payments`, `payment_shares`, `notifications`.

### Ya existe (reutilizar, no recrear)

| Pieza | Ubicación | Uso en Fase 2 |
|---|---|---|
| Pool `pg` | `src/db/pool.ts` | Transacciones de registro y refresh |
| Runner de migraciones | `src/db/migrate.ts` | Aplicará `004_*.sql` automáticamente |
| Tablas `users`, `groups`, `group_members` | `src/db/migrations/001-003` | Inserciones de registro |
| Índice único un personal por owner | `idx_groups_one_personal_per_owner` | Garantiza 1 grupo personal |
| `CHECK` active ⇒ `joined_at IS NOT NULL` | `003_create_group_members.sql` | El registro **debe** setear `joined_at` |
| `AppError` + `errorHandler` | `src/middleware/errorHandler.ts` | Errores 400/401/409/500 |
| `authLogger` | `src/config/logger.ts` | Único logger de este módulo |
| Env JWT | `src/config/env.ts` | `jwtAccessSecret`, `jwtRefreshSecret`, expiraciones |
| CORS | `src/app.ts` | `origin: 'http://localhost:3000'`, `credentials: true` |
| `bcrypt`, `jsonwebtoken` | `package.json` | Ya instalados; **usarlos ahora** |

### Decisiones bloqueadas (no reabrir)

1. Access token = JWT HS256 en `Authorization: Bearer`. Nunca en cookie.
2. Refresh token = string opaco aleatorio (no JWT) en cookie `httpOnly`. Nunca en el JSON de respuesta.
3. En DB solo se guarda `SHA-256(refresh_token)` en hex, nunca el valor crudo.
4. Rotación en cada refresh + familia (`family_id`) para detectar reutilización.
5. Email: `trim().toLowerCase()` en aplicación antes de SELECT/INSERT.
6. Login no enumera usuarios: siempre `401 Invalid credentials`.
7. Registro duplicado: `409` con mensaje genérico.
8. `register` y `login` devuelven `{ user, accessToken }` y setean la cookie.
9. Cookie `path: '/auth'`, nombre `refresh_token`.
10. Production `sameSite: 'lax'` (ver sección 7).
11. bcrypt cost `12`.
12. Dependencias nuevas: `cookie-parser`, `zod`, `vitest` (+ tipos).

---

## 1. Estructura de archivos a crear / tocar

`src/modules/` **no existe todavía**. Créalo en esta fase. No inventar `src/utils` ni `src/jobs`.

```
backend/
├── src/
│   ├── app.ts                              # TOCAR: cookieParser + montar /auth
│   ├── config/
│   │   └── env.ts                          # TOCAR: rechazar secretos placeholder en production
│   ├── db/migrations/
│   │   └── 004_create_refresh_tokens.sql   # CREAR
│   ├── middleware/
│   │   ├── auth.middleware.ts              # CREAR
│   │   ├── validate.ts                     # CREAR (wrapper zod → AppError 400)
│   │   └── errorHandler.ts                 # NO cambiar salvo necesidad real
│   ├── modules/                            # CREAR directorio
│   │   └── auth/
│   │       ├── auth.controller.ts          # CREAR
│   │       ├── auth.routes.ts              # CREAR
│   │       ├── auth.service.ts             # CREAR
│   │       ├── auth.schemas.ts             # CREAR
│   │       ├── auth.types.ts               # CREAR
│   │       ├── auth.tokens.ts              # CREAR (JWT + opaque refresh + cookie helpers)
│   │       └── auth.service.test.ts        # CREAR
│   └── types/
│       └── express.d.ts                    # TOCAR: Request.user
├── package.json                            # TOCAR: deps + script test
└── .env.example                            # TOCAR: quitar comentario "reserved for Phase 2"
```

No crear `auth.logger.ts`. Usar `import { authLogger } from '../../config/logger'`.

---

## 2. Dependencias

Trabajar en `backend/` con **pnpm**.

```bash
pnpm add cookie-parser zod
pnpm add -D @types/cookie-parser vitest
```

| Paquete | Propósito |
|---|---|
| `cookie-parser` | Expone `req.cookies` |
| `zod` | Schemas de register/login |
| `vitest` | Tests co-ubicados |
| `bcrypt` (ya está) | Hash de passwords, cost 12 |
| `jsonwebtoken` (ya está) | Firmar/verificar access token |

No instalar `csurf`, `express-validator`, ORMs ni `jsonwebtoken` de nuevo.

Añadir script:

```json
"test": "vitest run"
```

`vitest` debe resolver TypeScript con el `tsconfig` actual (`module: commonjs`). Si vitest exige `vite.config` o `vitest.config.ts`, crear `backend/vitest.config.ts` mínimo:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

No añadir script `test` de Jest.

---

## 3. Variables de entorno

Ya definidas en Fase 1. No añadir keys nuevas.

Valores vigentes (`.env.example`):

```
JWT_ACCESS_SECRET=change_me_access_secret_min_32_chars
JWT_REFRESH_SECRET=change_me_refresh_secret_min_32_chars
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
```

`JWT_REFRESH_SECRET` **no se usa para firmar un JWT de refresh** (el refresh es opaco). Se usa como pepper al hashear el refresh token:

```
token_hash = SHA256(hex) of (rawToken + ':' + env.jwtRefreshSecret)
```

Así un dump de `token_hash` no es suficiente para reutilizar el cookie sin el secreto.

En `src/config/env.ts`, **añadir** (solo si `env.isProd`):

- Si `jwtAccessSecret` o `jwtRefreshSecret` empiezan por `change_me_` o tienen longitud < 32 → `throw` al arrancar, sin imprimir el valor.

En development los placeholders están permitidos (son ≥ 32 caracteres).

`JWT_ACCESS_EXPIRES_IN=15m` y `JWT_REFRESH_EXPIRES_IN=7d` se pasan a `jsonwebtoken` y a `maxAge` de la cookie respectivamente. Crear un helper `durationToMs(value: string): number` en `auth.tokens.ts` que acepte `15m`, `7d`, `1h`, `30s`. Si el formato es inválido, lanzar `Error` en arranque o en el helper (fail fast).

---

## 4. Migración `004_create_refresh_tokens.sql`

Archivo exacto: `backend/src/db/migrations/004_create_refresh_tokens.sql`.

```sql
CREATE TABLE refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  family_id UUID NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  replaced_by UUID REFERENCES refresh_tokens (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT refresh_tokens_hash_unique UNIQUE (token_hash)
);

CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens (user_id);
CREATE INDEX idx_refresh_tokens_family_id ON refresh_tokens (family_id);
CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens (expires_at);
CREATE INDEX idx_refresh_tokens_active
  ON refresh_tokens (user_id, expires_at)
  WHERE revoked_at IS NULL;
```

Notas:

- `token_hash` es SHA-256 hex (64 chars). Unique para lookup O(1).
- `family_id` agrupa la cadena de rotaciones de una sesión. Al detectar reuso, revocar **toda** la familia.
- `ON DELETE CASCADE` en `user_id`: borrar usuario elimina sus refresh tokens. (Borrar usuario no está en esta fase; el FK queda listo.)
- `replaced_by` apunta al token sucesor. Nullable hasta la rotación.
- No crear ENUMs. Un token está activo sii `revoked_at IS NULL AND expires_at > NOW()`.
- No crear otras tablas.

Tras implementarla: `pnpm migrate` debe aplicarla una vez y ser idempotente en la segunda corrida (el runner de Fase 1 ya lo garantiza).

---

## 5. Passwords (bcrypt)

Archivo: lógica en `auth.service.ts`.

| Regla | Valor |
|---|---|
| Algoritmo | bcrypt |
| Cost factor | `12` (constante `BCRYPT_COST = 12`) |
| Password min | 8 caracteres |
| Password max | 72 caracteres (límite bcrypt; recortar o rechazar por encima) |
| Vacía / solo espacios | rechazar en zod |

Por qué 12: equilibrio razonable CPU vs. fuerza bruta para un proyecto de práctica (~250–400 ms por hash en hardware de desarrollo). El cost está embebido en el hash (`$2b$12$...`), así que subir a 13 más adelante no rompe hashes existentes: `bcrypt.compare` lee el cost del hash almacenado.

```
hashPassword(plain) → bcrypt.hash(plain, 12)
verifyPassword(plain, hash) → bcrypt.compare(plain, hash)
```

Nunca devolver `password_hash`. Nunca loguearlo. Nunca meter `password` en `authLogger`.

Anti-enumeración en login: si el usuario no existe, igual ejecutar `bcrypt.compare` contra un hash dummy constante (generado una vez al cargar el módulo, no en cada request) para no filtrar existencia por timing.

---

## 6. Tokens

Archivo: `src/modules/auth/auth.tokens.ts`.

### 6.1 Access token (JWT)

Algoritmo: **HS256**. Secreto: `env.jwtAccessSecret`. Expiración: `env.jwtAccessExpiresIn` (`15m`).

Payload exacto al firmar:

```ts
{
  sub: user.id,          // UUID string
  email: user.email,     // ya normalizado
  type: 'access',
}
```

`iat` y `exp` los pone `jsonwebtoken`. No añadir `name`, `role`, `groupId`, `password_hash`, ni refresh.

Firmar:

```ts
jwt.sign(payload, env.jwtAccessSecret, {
  algorithm: 'HS256',
  expiresIn: env.jwtAccessExpiresIn,
});
```

Verificar:

```ts
jwt.verify(token, env.jwtAccessSecret, {
  algorithms: ['HS256'],
});
```

Tras verify:

1. `typeof payload !== 'string'`.
2. `payload.type === 'access'`.
3. `typeof payload.sub === 'string'` y UUID v4 razonable (`/^[0-9a-f-]{36}$/i`).
4. `typeof payload.email === 'string'`.

Si falla cualquiera → `AppError(401, 'Invalid or expired token')`.

**Qué no incluir nunca en el JWT:** passwords, hashes, refresh tokens, secretos, PAN/CVV, grupos, permisos, `family_id`.

El access token **no se persiste**. Vive solo en memoria del cliente (Fase 3 lo guardará). El backend no tiene tabla de access tokens.

### 6.2 Refresh token (opaco)

Generación:

```ts
const raw = crypto.randomBytes(32).toString('base64url');
const familyId = familyIdFromPrevious ?? crypto.randomUUID();
const tokenHash = hashRefreshToken(raw);
```

`hashRefreshToken(raw)`:

```ts
crypto.createHash('sha256')
  .update(`${raw}:${env.jwtRefreshSecret}`)
  .digest('hex');
```

Lookup: hashear el valor de la cookie con el mismo pepper y `SELECT ... WHERE token_hash = $1`.

Comparación: igualdad de hashes SHA-256 (hex). No usar `===` sobre el token crudo contra la DB porque el crudo **no está** en la DB.

TTL: `durationToMs(env.jwtRefreshExpiresIn)` → `expires_at = NOW() + interval`.

El valor crudo **solo** viaja en la cookie. Nunca en JSON, nunca en logs.

### 6.3 Cookie

Nombre: `refresh_token`.

Helper `refreshCookieOptions()`:

```ts
{
  httpOnly: true,
  secure: env.isProd,          // false en development, true en production
  sameSite: 'lax' as const,    // ver justificación abajo
  maxAge: durationToMs(env.jwtRefreshExpiresIn),
  path: '/auth',
}
```

**Development**

```
httpOnly: true
secure: false
sameSite: 'lax'
maxAge: 7d en ms
path: /auth
```

**Production**

```
httpOnly: true
secure: true
sameSite: 'lax'
maxAge: igual a JWT_REFRESH_EXPIRES_IN
path: /auth
```

Por qué `lax` y no `strict` en production: `localhost:3000` (Next) y `localhost:3001` (API) son **distinto origin** (puerto) pero **mismo site**. `Lax` envía la cookie en POST same-site con `credentials: 'include'`. `Strict` también funcionaría en XHR same-site; se elige `lax` para no romper un refresh iniciado desde una navegación top-level futura. Si API y frontend se despliegan en dominios distintos (cross-site), habrá que pasar a `sameSite: 'none'` + `secure: true` **y** CSRF explícito. No implementar CSRF en esta fase.

CORS ya está bien: `origin: 'http://localhost:3000'`, `credentials: true`. No cambiar a `*`. El frontend, cuando exista, deberá usar `fetch(url, { credentials: 'include' })`.

Setear: `res.cookie('refresh_token', raw, refreshCookieOptions())`.
Borrar en logout: `res.clearCookie('refresh_token', { ...refreshCookieOptions(), maxAge: undefined })` con **los mismos** `path`, `httpOnly`, `sameSite`, `secure`. Si `clearCookie` no borra, setear `maxAge: 0` y value vacío.

---

## 7. Flujo completo

### 7.1 Registro — `POST /auth/register`

**Request**

```json
{
  "email": "Ada@Example.com",
  "password": "secret123",
  "name": "Ada"
}
```

**Pasos (en este orden)**

1. `validate(registerSchema)` → 400 si falla.
2. `email = email.trim().toLowerCase()` (zod `.trim().toLowerCase()`).
3. `passwordHash = await hashPassword(password)`.
4. Abrir cliente del pool: `BEGIN`.
5. `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name, created_at`.
   - Si unique violation (`code === '23505'`) → `ROLLBACK` → `authLogger.warn('Registration duplicate', { emailHash })` → `AppError(409, 'Email already registered')`.
6. `INSERT INTO groups (name, type, owner_id) VALUES ('Personal', 'personal', $userId) RETURNING id`.
7. `INSERT INTO group_members (group_id, user_id, role, status, joined_at) VALUES ($groupId, $userId, 'owner', 'active', NOW())`.
   - `joined_at` **obligatorio**: el CHECK de Fase 1 rechaza `active` sin `joined_at`.
8. `COMMIT`.
9. **Solo después del commit:** generar access JWT + refresh opaco, insertar fila en `refresh_tokens` (`family_id` nuevo, `revoked_at` null).
10. Set-Cookie `refresh_token`.
11. `authLogger.info('Registration succeeded', { userId })`.
12. `201`:

```json
{
  "user": { "id": "...", "email": "ada@example.com", "name": "Ada" },
  "accessToken": "<jwt>"
}
```

Si 5, 6 o 7 fallan por cualquier motivo distinto de 23505: `ROLLBACK`, `authLogger.error` con `message` (sin password), `AppError(500, 'Unable to register')` o dejar que el errorHandler cubra 500.

Los tokens **no** se generan dentro de la transacción de usuario/grupo. Si el INSERT de `refresh_tokens` falla después del commit, el usuario ya existe y puede hacer login; no dejar la transacción de registro abierta por eso. Documentar este orden.

Nombre del grupo personal: literal `'Personal'`. No usar el nombre del usuario (PII extra en `groups.name`).

### 7.2 Login — `POST /auth/login`

**Request**

```json
{
  "email": "ada@example.com",
  "password": "secret123"
}
```

**Pasos**

1. Validar schema.
2. Normalizar email.
3. `SELECT id, email, name, password_hash FROM users WHERE email = $1`.
4. Si no hay fila: `bcrypt.compare(password, DUMMY_HASH)` → `authLogger.warn('Login failed', { reason: 'invalid_credentials' })` → `AppError(401, 'Invalid credentials')`.
5. Si hay fila: `bcrypt.compare(password, row.password_hash)`. Si false: mismo log genérico y mismo `401 Invalid credentials`.
6. Crear familia nueva de refresh + access JWT + INSERT `refresh_tokens`.
7. Cookie.
8. `authLogger.info('Login succeeded', { userId })`.
9. `200`:

```json
{
  "user": { "id": "...", "email": "...", "name": "..." },
  "accessToken": "<jwt>"
}
```

No devolver `password_hash`. No decir "email not found" ni "wrong password".

### 7.3 Refresh — `POST /auth/refresh`

**Request:** body vacío. Cookie `refresh_token` requerida.

**Pasos (transacción)**

1. Leer `req.cookies.refresh_token`. Si falta → `401` `'Refresh token missing'`.
2. `hash = hashRefreshToken(raw)`.
3. `BEGIN`.
4. `SELECT id, user_id, family_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`.
5. Si no hay fila → `ROLLBACK` → `authLogger.warn('Refresh invalid', { reason: 'unknown' })` → `401` `'Invalid or expired refresh token'`.
6. Si `revoked_at IS NOT NULL` → **reutilización**:
   - `UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, NOW()) WHERE family_id = $familyId AND revoked_at IS NULL`.
   - `COMMIT`.
   - `authLogger.warn('Refresh reuse detected', { userId, familyId })`.
   - `401` `'Invalid or expired refresh token'`.
   - No emitir tokens nuevos. Toda la familia queda muerta (sesión comprometida).
7. Si `expires_at <= NOW()` → marcar `revoked_at = NOW()` (opcional), `COMMIT`, `401` mismo mensaje genérico. Log `{ reason: 'expired', userId }`.
8. Rotación (token válido):
   - Generar `newRaw`.
   - `newHash = hashRefreshToken(newRaw)`.
   - `INSERT` nueva fila con el **mismo** `family_id`, `user_id`, nuevo hash, nuevo `expires_at`.
   - `UPDATE` fila vieja: `revoked_at = NOW()`, `replaced_by = newId`.
   - `COMMIT`.
9. Firmar access JWT (cargar `email` con `SELECT email FROM users WHERE id = $userId`).
10. Set-Cookie con `newRaw`.
11. `authLogger.info('Refresh succeeded', { userId })`.
12. `200 { "accessToken": "<jwt>" }`. No devolver `user` (el cliente ya lo tiene).

Si el SELECT/UPDATE falla a mitad: `ROLLBACK`, 500.

### 7.4 Logout — `POST /auth/logout`

**Request:** cookie `refresh_token` (puede faltar). Access token opcional; no exigirlo.

**Pasos**

1. Si hay cookie: hashear, `UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL`.
2. `clearCookie` siempre, con las mismas opciones (path/sameSite/secure/httpOnly).
3. Si se identificó `user_id` de la fila: `authLogger.info('Logout succeeded', { userId })`. Si no había cookie o hash desconocido: `authLogger.info('Logout succeeded')` sin userId. No fallar.
4. `204` sin body **o** `200 { "status": "ok" }`. Elegir **`204`**.

Logout es idempotente: cookie ausente o ya revocada → 204 igual.

No revocar toda la familia en logout normal (solo el token actual). Un usuario puede tener varias sesiones (varios `family_id`). Logout cierra **esta** sesión.

---

## 8. Endpoints — contrato HTTP

Montar el router en `app.use('/auth', authRouter)`. Rutas del router: `/register`, `/login`, `/refresh`, `/logout`.

Todas JSON. Errores siempre `{ "error": { "message": string, "status": number } }` vía `AppError` + `errorHandler` existente.

| Método | Path | Auth | Cookie in | Cookie out | Body in | Success |
|---|---|---|---|---|---|---|
| POST | `/auth/register` | no | — | set refresh | `{ email, password, name }` | 201 `{ user, accessToken }` |
| POST | `/auth/login` | no | — | set refresh | `{ email, password }` | 200 `{ user, accessToken }` |
| POST | `/auth/refresh` | no (usa cookie) | refresh | rotate refresh | vacío | 200 `{ accessToken }` |
| POST | `/auth/logout` | no | refresh opcional | clear | vacío | 204 |

`user` público:

```ts
{ id: string, email: string, name: string }
```

Nunca `password_hash`, nunca el refresh, nunca `family_id`.

### Códigos

| Caso | Status | message |
|---|---|---|
| Validación zod | 400 | primer issue zod, o `'Validation error'` |
| Credenciales login | 401 | `Invalid credentials` |
| Access/refresh inválido o expirado | 401 | `Invalid or expired token` / `Invalid or expired refresh token` |
| Refresh ausente | 401 | `Refresh token missing` |
| Email duplicado | 409 | `Email already registered` |
| No autenticado en rutas futuras protegidas | 401 | `Unauthorized` |
| Autorización futura (no esta fase) | 403 | `Forbidden` |
| Error interno | 500 | `Internal server error` en prod |

401 vs 403: 401 = no se pudo autenticar (no hay identidad). 403 = hay identidad pero no permiso. Esta fase no emite 403. El middleware de auth solo emite 401.

---

## 9. Validación (`zod`)

Archivo: `src/modules/auth/auth.schemas.ts`.

```ts
registerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(8).max(72),
  name: z.string().trim().min(1).max(100),
});

loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(1).max(72),
});
```

Refresh y logout: sin body schema. Cookie se lee en el controller.

`src/middleware/validate.ts`:

```ts
export const validate = (schema: ZodType) => (req, _res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const message = result.error.issues[0]?.message ?? 'Validation error';
    return next(new AppError(400, message));
  }
  req.body = result.data;
  next();
};
```

No incluir el password en el mensaje de error. Los mensajes default de zod (`"String must contain at least 8 character(s)"`) son aceptables; no loguear `req.body`.

Uso: `router.post('/register', validate(registerSchema), controller.register)`.

---

## 10. Middleware `auth.middleware.ts`

Ubicación: `src/middleware/auth.middleware.ts` (singular, junto a `errorHandler.ts`).

```ts
export function requireAuth(req, _res, next) { ... }
```

Algoritmo:

1. `const header = req.headers.authorization`.
2. Si no empieza por `Bearer ` (espacio incluido) → `AppError(401, 'Unauthorized')`.
3. Extraer el token. `jwt.verify` con `algorithms: ['HS256']` y `env.jwtAccessSecret`.
4. Validar claims (sección 6.1). Token con `type !== 'access'` → 401.
5. `req.user = { id: payload.sub, email: payload.email }`.
6. `next()`.

No leer cookies. No pegar a la DB en cada request (el JWT es autosuficiente). Si más adelante se necesita “usuario borrado”, será otra fase.

Errores de `TokenExpiredError` y `JsonWebTokenError` → el mismo `AppError(401, 'Invalid or expired token')`. No filtrar “expired” vs “malformed” al cliente (sí se puede distinguir en log: `authLogger.warn('Access token rejected', { reason: 'expired' | 'malformed' })` **sin** el token).

En Fase 2 este middleware **no se monta** en `/auth/*`. Queda exportado para Fase 3. Añadir una ruta de smoke opcional `GET /auth/me` protegida:

```
GET /auth/me
Authorization: Bearer <access>
200 { "user": { "id", "email" } }
```

Sí incluir `GET /auth/me`: verifica `requireAuth` + `req.user` sin meterse en suscripciones. No devolver `name` si no está en el JWT; o hacer un SELECT puntual. Preferir **no pegar a DB**: responder `{ id, email }` desde el token. Documentarlo.

### Tipado `src/types/express.d.ts`

Reemplazar `export {}` por:

```ts
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
      };
    }
  }
}

export {};
```

Asegurar que `tsconfig` incluye este archivo (`src/**/*.ts` ya lo cubre). No usar `req.user!` en el middleware después de asignarlo.

---

## 11. Wiring de `app.ts`

Orden de middlewares (estricto):

```
1. express.json({ limit: '100kb' })
2. cors({ origin: 'http://localhost:3000', credentials: true })
3. cookieParser()
4. healthRouter
5. authRouter en '/auth'
6. notFound
7. errorHandler
```

Importar `cookieParser` de `cookie-parser`. No loguear cookies.

---

## 12. Logging (`authLogger`)

Importar desde `src/config/logger.ts`. Eventos **obligatorios**:

| Evento | Nivel | Meta permitida |
|---|---|---|
| Registro exitoso | info | `{ userId }` |
| Registro duplicado | warn | `{ emailHash }` (SHA-256 del email, 8 primeros hex) |
| Login exitoso | info | `{ userId }` |
| Login fallido | warn | `{ reason: 'invalid_credentials' }` — sin email |
| Refresh ok | info | `{ userId }` |
| Refresh unknown/expired | warn | `{ reason }` |
| Refresh reuse | warn | `{ userId, familyId }` |
| Access token rejected | warn | `{ reason }` |
| Logout | info | `{ userId? }` |

`emailHash` = `sha256(email).slice(0, 8)` para correlación sin PII completa.

**Prohibido en meta y mensaje:** `password`, `password_hash`, access JWT, refresh crudo, cookie header, `authorization`, `jwtAccessSecret`, `jwtRefreshSecret`, `DATABASE_URL`, bodies.

El sanitizer de Fase 1 ya redacta esas keys; igual **no pasarlas**.

No emitir logs de `paymentLogger` / `jobLogger`.

---

## 13. Tipos `auth.types.ts`

```ts
export type PublicUser = {
  id: string;
  email: string;
  name: string;
};

export type AuthResult = {
  user: PublicUser;
  accessToken: string;
  refreshToken: string; // crudo, solo para setear cookie en el controller; jamás JSON
};

export type AccessTokenPayload = {
  sub: string;
  email: string;
  type: 'access';
};
```

El controller extrae `refreshToken`, llama `res.cookie`, y responde `{ user, accessToken }`.

---

## 14. Tests co-ubicados

Archivo: `src/modules/auth/auth.service.test.ts`.

Cubrir sin levantar HTTP (unitario):

1. `hashPassword` + `verifyPassword` round-trip.
2. Password incorrecta → `verifyPassword` false.
3. `hashRefreshToken` es determinista con el mismo pepper y distinto con raw distinto.
4. Normalización: schema register convierte `Ada@Example.com` → `ada@example.com`.
5. Password `< 8` falla el schema.
6. Helper de claims: payload sin `type: 'access'` se rechaza.

No conectar a Postgres en estos tests. No imprimir hashes en `expect` messages con el password plano más de lo necesario.

Comando: `pnpm test` en `backend/`. Debe pasar en CI local antes de cerrar la fase.

Verificación HTTP (manual o script curl, no obligatorio automatizar e2e en esta fase):

```bash
# 1. register
curl -s -c cookies.txt -X POST http://localhost:3001/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"Ada@Example.com","password":"secret123","name":"Ada"}'
# esperar 201, email ada@example.com, Set-Cookie httpOnly

# 2. duplicate
# mismo curl → 409

# 3. login wrong password → 401 Invalid credentials
# 4. login ok → 200
# 5. GET /auth/me con Bearer → 200 { id, email }
# 6. GET /auth/me sin token → 401
# 7. POST /auth/refresh -b cookies.txt → 200 accessToken nuevo, cookie rotada
# 8. reusar cookie vieja de refresh → 401 y familia revocada
# 9. POST /auth/logout -b cookies.txt → 204, cookie borrada
# 10. GET /health sigue 200
```

Comprobar en Postgres tras un registro:

```sql
SELECT u.email, g.type, gm.role, gm.status, gm.joined_at IS NOT NULL AS joined
FROM users u
JOIN groups g ON g.owner_id = u.id AND g.type = 'personal'
JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = u.id;
-- 1 fila, type=personal, role=owner, status=active, joined=true

SELECT token_hash, revoked_at IS NULL FROM refresh_tokens;
-- token_hash length 64, no valor crudo
```

---

## 15. Orden de implementación

Ejecutar en este orden:

1. `pnpm add cookie-parser zod` y `pnpm add -D @types/cookie-parser vitest` en `backend/`.
2. Script `test` + `vitest.config.ts` si hace falta.
3. Endurecer `env.ts` (placeholder secrets en production).
4. Escribir `004_create_refresh_tokens.sql` y `pnpm migrate`.
5. Extender `express.d.ts`.
6. `auth.types.ts` → `auth.schemas.ts` → `auth.tokens.ts` → `auth.service.ts` → `auth.controller.ts` → `auth.routes.ts`.
7. `middleware/validate.ts` y `middleware/auth.middleware.ts`.
8. Montar cookieParser + `/auth` en `app.ts`.
9. Tests unitarios + `pnpm test` + `pnpm typecheck`.
10. Probar curl de la sección 14 contra `pnpm dev` (Postgres Docker ya definido en la raíz).
11. Confirmar que `GET /health` no se rompió y que no hay rutas `/subscriptions`.

Si `typecheck` o tests fallan, no dar la fase por cerrada.

---

## 16. Detalles de implementación que no hay que olvidar

- Express 5 propaga async rejections: los controllers pueden ser `async` sin wrapper.
- Usar `pool.connect()` + `BEGIN/COMMIT/ROLLBACK` + `release()` en `finally`, igual que `migrate.ts`.
- Unique email: la DB compara el valor insertado; por eso la app **debe** normalizar a minúsculas. No añadir `LOWER(email)` en SQL en esta fase.
- Dummy bcrypt hash: generar con `bcrypt.hashSync('dummy-password-not-used', 12)` una vez a nivel de módulo para el timing dummy. No loguearlo.
- `jsonwebtoken` v9: tipar `expiresIn` como `SignOptions['expiresIn']` (string tipo `15m`).
- No importar `axios`.
- `postbuild` de Fase 1 ya copia `src/db/migrations` a `dist/`; el `004` se copiará solo.
- Cookie `path: '/auth'` implica que el browser **no** envía refresh a `GET /health` ni a futuras `/subscriptions`. Correcto.
- `GET /auth/me` vive en el mismo router; `path` de cookie no afecta al Bearer.

---

## 17. Checklist final — Fase 2 completa

### Setup

- [ ] `cookie-parser`, `zod`, `vitest` instalados con pnpm.
- [ ] `pnpm typecheck` código 0.
- [ ] `pnpm test` código 0.
- [ ] `frontend/` intacto.
- [ ] No se importan `axios` ni se crean tablas de fases 3+.

### Registro

- [ ] Una transacción crea `users` + `groups.type='personal'` + `group_members` owner/active con `joined_at`.
- [ ] Rollback si falla cualquier INSERT de esas tres.
- [ ] Email persistido en minúsculas.
- [ ] Duplicado → 409, un solo usuario en DB.
- [ ] Password bcrypt cost 12; respuesta sin `password_hash`.
- [ ] Tokens emitidos **después** del commit.
- [ ] 201 `{ user, accessToken }` + cookie `refresh_token`.

### Login / refresh / logout

- [ ] Login email desconocido y password mala → mismo 401 `Invalid credentials`.
- [ ] Refresh rota el token, revoca el anterior, mismo `family_id`.
- [ ] Reusar refresh revocado → 401 y familia completa revocada.
- [ ] Refresh expirado → 401, sin tokens nuevos.
- [ ] Logout revoca la fila y borra la cookie (path/sameSite/secure iguales).
- [ ] Logout sin cookie → 204.
- [ ] `token_hash` en DB es CHAR 64 hex, nunca el valor de la cookie.

### JWT y middleware

- [ ] Access HS256, claims `sub`, `email`, `type: 'access'`, exp ~15m.
- [ ] `jwt.verify` con `algorithms: ['HS256']`.
- [ ] `requireAuth` lee solo `Authorization: Bearer`.
- [ ] `GET /auth/me` 200 con token válido, 401 sin token o token basura.
- [ ] `req.user: { id, email }` tipado en `express.d.ts`.

### Cookie / CORS

- [ ] `httpOnly: true`, `path: '/auth'`, `sameSite: 'lax'`.
- [ ] `secure: false` en development, `true` en production.
- [ ] CORS sigue `origin: 'http://localhost:3000'` + `credentials: true`.
- [ ] Refresh token no aparece en ningún JSON.

### Logging y seguridad

- [ ] Eventos de la tabla de la sección 12 presentes.
- [ ] Cero passwords, JWT, refresh, cookies o secretos en logs.
- [ ] Secretos `change_me_*` rechazados si `NODE_ENV=production`.

### HTTP residual

- [ ] `GET /health` → 200 `{ status, db }`.
- [ ] Ruta inexistente → 404 `{ error: { message, status } }`.
- [ ] Cero rutas `/subscriptions`, `/payments`, `/groups` de negocio.

Si algún ítem falla, la Fase 2 no está cerrada.
