# Plan Fase 3 — Suscripciones, permisos y dashboard básico

Guía de implementación para OpenCode. Ejecutar **solo esta fase**, en **bloques pequeños**. El objetivo es aprender: no entregar todo el CRUD y el frontend de una sola vez. Detenerse donde el bloque lo indique.

Proyecto: rastreo de suscripciones compartidas (`gestor-suscripciones`).
Stack: Express 5 + TypeScript + PostgreSQL + Zod + Winston + Next.js App Router (dashboard mínimo).

---

## 0. Alcance y estado actual

### En alcance

- Migración `005_create_subscriptions.sql`.
- CRUD de suscripciones anidado en `/groups/:groupId/subscriptions`.
- Autorización por membresía activa y rol (`owner` escribe, `member` solo lee).
- Extensión mínima de `GET /auth/me` para devolver `personalGroupId` (el dashboard lo necesita).
- Dashboard mínimo + login mínimo en el frontend.
- Tests co-ubicados y documentación ligera de la API.

### Fuera de alcance

- Pagos, `payment_shares`, jobs, cron, notificaciones, anomalías.
- Invitaciones, grupos `family` de negocio, transferencia de ownership.
- Roles nuevos (`admin`).
- ORM, Axios en frontend, Swagger.
- `localStorage` para tokens.
- Paginación, búsqueda, moneda, `updated_at`, ciclo `custom`.

### Ya existe (reutilizar)

| Pieza | Ubicación | Uso |
|---|---|---|
| `requireAuth` | `src/middleware/auth.middleware.ts` | Todas las rutas de suscripciones |
| `validate` | `src/middleware/validate.ts` | Hoy solo parsea **body**; hay que extenderlo |
| `AppError` | `src/middleware/errorHandler.ts` | 400 / 401 / 403 / 404 |
| `req.user` | `src/types/express.d.ts` | `{ id, email }` tras `requireAuth` |
| Pool + migraciones | `src/db/` | SQL crudo, runner idempotente |
| Grupo personal al registrarse | `auth.service.ts` | Owner + `joined_at` + `status = 'active'` |
| CORS | `app.ts` | `http://localhost:3000` + `credentials: true` |
| `zod`, `vitest`, `pg` | `package.json` | No instalar nada nuevo |
| Frontend Next 16 | `frontend/src/app/page.tsx` | Landing por defecto de `create-next-app` |

### Decisiones bloqueadas (no reabrir)

1. Una suscripción pertenece a **un** `group` (`group_id`).
2. Solo `group_members.status = 'active'` puede leer.
3. Solo `role = 'owner'` puede crear, editar y borrar.
4. `invited` y `removed` → `403`.
5. Si el usuario **no** es miembro activo del grupo (o el grupo no existe) → **`403 Forbidden`**, no `404`. Evita enumerar grupos ajenos.
6. Si el usuario **sí** es miembro y la suscripción no existe en ese grupo → **`404 Subscription not found`**.
7. Borrado físico `DELETE`. Fase 4 (pagos) podrá cambiar esto; no adelantarlo.
8. Autorización en el **servicio**, no un middleware `groupAccess`. Más fácil de seguir: auth HTTP aparte, reglas de negocio junto al SQL.
9. `groupId` sale de la **URL**, nunca del body. Schemas `.strict()`.
10. `expectedCost` en respuestas JSON es **string** (`"17.99"`), porque `pg` devuelve `NUMERIC` como string.
11. `nextBillingDate` es `DATE` y se expone `YYYY-MM-DD`, sin zona horaria.
12. `GET /auth/me` pasa a consultar DB y devolver `personalGroupId`. Sin eso el dashboard no sabe qué `groupId` usar (Fase 2 no lo exponía).
13. Frontend: login mínimo + dashboard. `fetch` nativo. Access token **solo en memoria**. Refresh con `credentials: 'include'` a `/auth/refresh`.
14. Tests de `member` / `invited` / `removed`: **fixtures SQL** en tests de integración. No implementar invitaciones.
15. Cero dependencias nuevas.

### Mejora respecto al prompt 03 (ya aplicada en este plan)

- El prompt pedía un dashboard de suscripciones del grupo personal, pero Fase 2 no devuelve `groupId`. Se añade `personalGroupId` en `/auth/me`.
- `validate` solo cubre `req.body`. Se extiende a `params` y `query`.
- Sin página de login el dashboard es inutilizable en el navegador. Se añade `/login` mínimo (no un sistema de cuentas nuevo).
- Autorización vive en el servicio (no `groupAccess.middleware.ts`) para no duplicar consultas y para que el flujo sea lineal de leer.

---

## 1. Estructura de archivos

```
backend/
├── docs/
│   └── subscriptions.md                 # CREAR (bloque 8)
├── src/
│   ├── app.ts                           # TOCAR: montar router
│   ├── config/logger.ts                 # TOCAR: subscriptionLogger
│   ├── db/migrations/
│   │   └── 005_create_subscriptions.sql # CREAR
│   ├── middleware/
│   │   ├── auth.middleware.ts           # NO tocar salvo necesidad
│   │   └── validate.ts                  # TOCAR: body | params | query
│   ├── modules/
│   │   ├── auth/
│   │   │   ├── auth.controller.ts       # TOCAR: GET /me con DB
│   │   │   └── auth.service.ts          # TOCAR: getMe(userId)
│   │   └── subscriptions/               # CREAR
│   │       ├── membership.ts            # getActiveMembership
│   │       ├── membership.test.ts
│   │       ├── subscription.controller.ts
│   │       ├── subscription.routes.ts
│   │       ├── subscription.service.ts
│   │       ├── subscription.schemas.ts
│   │       ├── subscription.types.ts
│   │       ├── subscription.schemas.test.ts
│   │       └── subscription.service.test.ts
│   └── types/express.d.ts               # NO hace falta extender
frontend/
├── .env.local                           # CREAR, gitignored
├── src/
│   ├── app/
│   │   ├── page.tsx                     # TOCAR: enlaces a /login y /dashboard
│   │   ├── login/page.tsx               # CREAR
│   │   └── dashboard/page.tsx           # CREAR
│   └── lib/
│       ├── api.ts                       # CREAR: fetch + Bearer + credentials
│       └── session.ts                   # CREAR: access token en memoria
```

No crear `src/jobs`, `src/payments`, `src/notifications` ni `groupAccess.middleware.ts`.

---

## 2. Contrato HTTP

Todas las rutas de suscripciones: `Authorization: Bearer <accessToken>`.
Errores: `{ "error": { "message": string, "status": number } }`.

### 2.1 Extensión de auth (infraestructura del dashboard)

`GET /auth/me` (ya protegido con `requireAuth`):

**Antes (Fase 2):** `{ "user": { "id", "email" } }` desde el JWT, sin DB.

**Ahora:**

```json
{
  "user": { "id": "...", "email": "...", "name": "..." },
  "personalGroupId": "uuid"
}
```

SQL:

```sql
SELECT u.id, u.email, u.name, g.id AS personal_group_id
FROM users u
JOIN groups g ON g.owner_id = u.id AND g.type = 'personal'
JOIN group_members gm
  ON gm.group_id = g.id AND gm.user_id = u.id AND gm.status = 'active'
WHERE u.id = $1
```

Si no hay fila (dato inconsistente) → `500` genérico + log. No debería ocurrir tras un registro correcto de Fase 2.

### 2.2 Suscripciones

| Método | Path | Quién | Éxito |
|---|---|---|---|
| POST | `/groups/:groupId/subscriptions` | owner | 201 `{ subscription }` |
| GET | `/groups/:groupId/subscriptions` | owner y member activos | 200 `{ subscriptions: [] }` |
| GET | `/groups/:groupId/subscriptions/:subscriptionId` | owner y member activos | 200 `{ subscription }` |
| PATCH | `/groups/:groupId/subscriptions/:subscriptionId` | owner | 200 `{ subscription }` |
| DELETE | `/groups/:groupId/subscriptions/:subscriptionId` | owner | 204 vacío |

Query opcional en listado: `?active=true` o `?active=false`. Orden: `created_at DESC`.

**Crear — body**

```json
{
  "name": "Plan Premium",
  "provider": "Netflix",
  "expectedCost": "17.99",
  "billingCycle": "monthly",
  "nextBillingDate": "2026-10-01"
}
```

También se acepta `expectedCost` numérico (`17.99`); se normaliza a string de 2 decimales **antes** de persistir. La respuesta **siempre** usa string.

**Recurso `subscription`**

```json
{
  "id": "uuid",
  "groupId": "uuid",
  "name": "Plan Premium",
  "provider": "Netflix",
  "expectedCost": "17.99",
  "billingCycle": "monthly",
  "nextBillingDate": "2026-10-01",
  "active": true,
  "createdAt": "2026-09-01T12:00:00.000Z"
}
```

Nunca: `password_hash`, tokens, filas de `users`, `role` del request.

**PATCH — al menos un campo**, `.strict()`:

```json
{ "active": false }
```

Prohibido en body: `id`, `groupId`, `createdAt`, `group_id`.

### Códigos

| Caso | Status | message |
|---|---|---|
| Validación zod / UUID | 400 | primer issue o `Validation error` |
| Sin Bearer / token malo | 401 | `Unauthorized` / `Invalid or expired token` |
| No miembro activo, o escritura sin ser owner | 403 | `Forbidden` |
| Suscripción inexistente **en ese grupo** (siendo miembro) | 404 | `Subscription not found` |
| Error interno | 500 | `Internal server error` en prod |

---

## 3. Migración `005_create_subscriptions.sql`

```sql
CREATE TYPE billing_cycle AS ENUM ('weekly', 'monthly', 'quarterly', 'yearly');

CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  provider VARCHAR(255) NOT NULL,
  expected_cost NUMERIC(12, 2) NOT NULL,
  billing_cycle billing_cycle NOT NULL,
  next_billing_date DATE NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT subscriptions_expected_cost_non_negative CHECK (expected_cost >= 0)
);

CREATE INDEX idx_subscriptions_group_id ON subscriptions (group_id);
CREATE INDEX idx_subscriptions_group_active ON subscriptions (group_id, active);
CREATE INDEX idx_subscriptions_next_billing_date ON subscriptions (next_billing_date);
```

Por qué:

- `ON DELETE CASCADE`: una suscripción no existe sin grupo.
- ENUM sin `custom`: no hay lógica de cálculo todavía.
- Sin UNIQUE de `(group_id, provider, name)`: un grupo puede tener dos planes del mismo proveedor.
- Sin `updated_at` ni moneda.
- Índices: listados por grupo, filtro activo, jobs de Fase 4 (`next_billing_date`).
- Idempotencia: el runner de Fase 1 registra el filename en `schema_migrations`; la segunda corrida no reejecuta el SQL.

`NUMERIC(12, 2)`: máximo `9999999999.99`. Zod debe rechazar valores mayores.

---

## 4. Extender `validate.ts`

Hoy solo hace `schema.safeParse(request.body)`. Los UUID van en params y `active` en query.

Cambiar a:

```ts
type Location = 'body' | 'params' | 'query';

export const validate = (schema: ZodType, location: Location = 'body'): RequestHandler =>
  (request, _response, next) => {
    const result = schema.safeParse(request[location]);
    if (!result.success) {
      next(new AppError(400, result.error.issues[0]?.message ?? 'Validation error'));
      return;
    }
    (request as unknown as Record<Location, unknown>)[location] = result.data;
    next();
  };
```

Uso en rutas:

```ts
router.post(
  '/',
  requireAuth,
  validate(groupIdParamsSchema, 'params'),
  validate(createSubscriptionSchema, 'body'),
  controller.create,
);
```

Las rutas de auth existentes siguen usando `validate(schema)` (default `body`). No romper registro/login.

---

## 5. Tipos, schemas y dinero

### 5.1 `subscription.types.ts`

```ts
export type BillingCycle = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

export type Subscription = {
  id: string;
  groupId: string;
  name: string;
  provider: string;
  expectedCost: string;
  billingCycle: BillingCycle;
  nextBillingDate: string;
  active: boolean;
  createdAt: string;
};

export type Membership = {
  groupId: string;
  userId: string;
  role: 'owner' | 'member';
  status: 'active';
};
```

Mapear filas SQL (`snake_case`, `expected_cost` string, `next_billing_date` Date o string) a este tipo en un `toSubscription(row)` documentado.

Para `DATE`, `pg` suele devolver un `Date` a medianoche UTC. **No** usar `toISOString().slice(0, 10)` a ciegas (puede restar un día según TZ). Formatear con UTC:

```ts
function toIsoDate(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10); // pg DATE llega como UTC midnight
}
```

Documentar en un comentario de 1–2 líneas junto a `toSubscription`. Tests con una fecha conocida (`2026-10-01`).

### 5.2 Zod

```ts
const money = z.union([
  z.string().regex(/^\d+(\.\d{1,2})?$/),
  z.number().finite().nonnegative(),
]).transform((value) => {
  if (typeof value === 'string') {
    const [whole, fraction = ''] = value.split('.');
    return `${whole}.${fraction.padEnd(2, '0')}`;
  }
  return (Math.round(value * 100) / 100).toFixed(2);
}).refine((value) => Number(value) <= 9_999_999_999.99);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}, 'Invalid calendar date');
```

- `createSubscriptionSchema`: `name`, `provider` trim 1–255; `expectedCost: money`; `billingCycle` enum; `nextBillingDate: isoDate`. **`.strict()`**.
- `updateSubscriptionSchema`: todos opcionales, `.strict()`, `.refine(data => Object.keys(data).length > 0)`.
- `groupIdParamsSchema`: `{ groupId: z.string().uuid() }`.
- `subscriptionParamsSchema`: `{ groupId, subscriptionId }` UUID.
- `subscriptionQuerySchema`: `{ active: z.enum(['true', 'false']).transform(v => v === 'true').optional() }`.

El transform de `number` usa `Math.round`; es suficiente para importes de 2 decimales en esta app de práctica. La fuente de verdad al **salir** de la API es siempre el `NUMERIC` de Postgres (string).

---

## 6. Autorización (`membership.ts`)

```ts
export async function getActiveMembership(userId: string, groupId: string): Promise<Membership>
```

```sql
SELECT group_id, user_id, role, status
FROM group_members
WHERE user_id = $1 AND group_id = $2 AND status = 'active'
```

- 0 filas → `AppError(403, 'Forbidden')` + `subscriptionLogger.warn('Access denied', { userId, groupId, operation })`.
- No distinguir “grupo inexistente” vs “no miembro”.
- Nunca leer `role` del cliente.

Helpers:

```ts
export function assertOwner(membership: Membership): void {
  if (membership.role !== 'owner') throw new AppError(403, 'Forbidden');
}
```

Flujo de cada operación de servicio:

1. `getActiveMembership(userId, groupId)`.
2. Si es escritura → `assertOwner`.
3. Query de `subscriptions` **siempre** con `AND group_id = $groupId` (y `id` si aplica).
4. 0 filas en get/update/delete **después** de ser miembro → `404`.

Comentario breve sobre aislamiento: no hacer `SELECT * FROM subscriptions WHERE id = $1` sin `group_id`.

---

## 7. Servicio SQL (parametrizado)

```ts
createSubscription(userId, groupId, input)
listSubscriptions(userId, groupId, filters?: { active?: boolean })
getSubscription(userId, groupId, subscriptionId)
updateSubscription(userId, groupId, subscriptionId, input)
deleteSubscription(userId, groupId, subscriptionId)
```

Escritura: membership + owner, luego INSERT/UPDATE/DELETE con `group_id` en el WHERE.

`UPDATE` dinámico: construir `SET` solo con keys presentes del input ya validado (whitelist: `name`, `provider`, `expected_cost`, `billing_cycle`, `next_billing_date`, `active`). Nunca `Object.assign` del body crudo.

`RETURNING` mapeado con `toSubscription`.

Listado:

```sql
SELECT ... FROM subscriptions
WHERE group_id = $1
  AND ($2::boolean IS NULL OR active = $2)
ORDER BY created_at DESC
```

Logs (`subscriptionLogger`, no costes ni bodies):

- create/update/delete ok → `info` con `{ userId, groupId, subscriptionId }`
- 403 → ya logueado en membership
- error pg → `error` con `{ code, message }` (no config del cliente)

Añadir en `logger.ts`:

```ts
export const subscriptionLogger = logger.child({ context: 'subscription' });
```

---

## 8. Rutas y `app.ts`

`subscription.routes.ts`: `Router({ mergeParams: true })`.

Montaje:

```ts
app.use('/groups/:groupId/subscriptions', requireAuth, subscriptionRouter);
```

Orden en `app.ts` (no romper Fase 1–2):

```
json → cors → cookieParser → health → /auth → /groups/:groupId/subscriptions → notFound → errorHandler
```

`requireAuth` en el `use` cubre todos los métodos. Controllers asumen `request.user`; si TypeScript se queja:

```ts
function actor(request: Request): { id: string; email: string } {
  if (!request.user) throw new AppError(401, 'Unauthorized');
  return request.user;
}
```

---

## 9. Frontend mínimo

Revisar `frontend/` real: Next 16, App Router, Tailwind 4, **sin** Axios. `page.tsx` es el starter de Next; **no borrar** el archivo: dejar la landing y añadir enlaces a `/login` y `/dashboard`. Actualizar `layout.tsx` metadata a “Gestor de suscripciones”.

`frontend/.env.local` (no commitear):

```
NEXT_PUBLIC_API_URL=http://localhost:3001
```

### `src/lib/session.ts`

Módulo cliente (`'use client'` o importado solo desde client components):

```ts
let accessToken: string | null = null;
export const session = {
  getAccessToken: () => accessToken,
  setAccessToken: (token: string | null) => { accessToken = token; },
};
```

Nunca `localStorage` / `sessionStorage`.

### `src/lib/api.ts`

```ts
async function api(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  const token = session.getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) throw data;
  return data;
}
```

`refreshSession()`: `POST /auth/refresh` sin Bearer, con cookie. Guarda `accessToken` en memoria.

### `/login` (client component)

Formulario email + password → `POST /auth/login` → `session.setAccessToken` → `router.push('/dashboard')`. Error visible si 401.

### `/dashboard` (client component)

Al montar:

1. Si no hay access token, intentar refresh.
2. Si refresh falla → mostrar “No autenticado” + enlace a `/login`.
3. `GET /auth/me` → `personalGroupId`.
4. `GET /groups/{id}/subscriptions`.
5. Estados: loading, vacío, error, lista.

Lista: name, provider, expectedCost, billingCycle, nextBillingDate, active.

Formulario crear (campos del contrato). Botones: desactivar/activar (`PATCH { active }`), eliminar (`DELETE` + confirm `window.confirm`). Edición completa puede ser el mismo formulario con valores cargados o un `PATCH` parcial; no hace falta un diseño rico.

No grupos familiares, no pagos, no centro de notificaciones.

---

## 10. Tests

Co-ubicados. Unitarios **sin** Postgres:

`subscription.schemas.test.ts`

- create válido (coste string y number).
- coste negativo / `abc` / más de 2 decimales inválido.
- ciclo fuera del enum.
- fecha `2026-13-40` inválida.
- PATCH `{}` inválido.
- PATCH con `groupId` inválido (`.strict()`).
- query `active=true|false` → boolean.

`membership.test.ts` (unitario del mapeo de errores si se extrae; si no, cubrir en integración).

Integración con Postgres local (`subscription.service.test.ts`):

Usar el pool real. Prefijo de emails `phase3-test-*@example.com`. En `beforeEach` / `afterAll` borrar **solo** esos usuarios (`DELETE FROM users WHERE email LIKE 'phase3-test-%'` → CASCADE limpia grupos, members, refresh, subscriptions). No tocar usuarios de desarrollo.

Casos:

1. Owner crea y lista.
2. GET por id del mismo grupo.
3. PATCH parcial conserva el resto.
4. DELETE → 204 y GET posterior 404.
5. Filtro `active`.
6. Segundo usuario (otro registro) → 403 al `groupId` del primero.
7. Fixture SQL: insertar `group_members` extra con `role = 'member'`, `status = 'active'` en el grupo personal del owner (el índice único personal-por-owner no impide un member extra). Ese member lista 200 y POST 403.
8. Mismo fixture con `invited` / `removed` → 403 en GET.

No mockear `pg` si la integración es más clara. Si no hay Postgres en CI, documentar que `pnpm test` unitario no abre pool; marcar tests de integración con `describe.skipIf(!process.env.DATABASE_URL)` o un archivo separado `subscription.service.int.test.ts` incluido solo cuando `RUN_DB_TESTS=1`. Preferir **un** archivo de integración que use `DATABASE_URL` del `.env` ya cargado por dotenv (como los tests de auth actuales cargan env). Si el test de auth no abre DB, no forzar a que `pnpm test` falle sin Docker: usar `it.skip` condicional o documentar `pnpm test` = unitarios y un script `test:int`.

Decisión: **unitarios en `pnpm test` (siempre)**. Integración en `subscription.service.int.test.ts` con:

```
include: src/**/*.test.ts
```

y al inicio:

```ts
if (!process.env.RUN_DB_TESTS) {
  describe.skip('subscription service integration', () => { ... });
}
```

Checklist de cierre pide `pnpm test` en verde **sin** obligar Docker. Las pruebas HTTP manuales del bloque 8 cubren owner/member.

---

## 11. Documentación `backend/docs/subscriptions.md`

Incluir: Bearer, tabla de permisos, ejemplos de request/response, errores 400/401/403/404, nota de `expectedCost` string, nota de `personalGroupId` en `/me`. Sin tokens reales.

---

## 12. Bloques de implementación

El modelo implementador **un bloque por vez**. Tras un bloque con prueba manual, **detenerse**.

### Bloque 1 — Modelo de datos

**Entrada:** Fase 2 operativa, Postgres arriba.

**Hacer:** `005_create_subscriptions.sql`. `pnpm --dir backend migrate` dos veces.

**Aprender:** ENUM, NUMERIC, FK CASCADE, índices parciales vs compuestos.

**Verificar:** `\d subscriptions` en psql. Tablas de fases 4+ no existen.

**Parar** para que el desarrollador mire el esquema.

### Bloque 2 — Schemas, tipos, `validate`

**Hacer:** extender `validate.ts`; `subscription.types.ts`; `subscription.schemas.ts`; tests de schemas; `toIsoDate` + tests de fecha.

**Verificar:** `pnpm --dir backend test` y `typecheck`. Rutas `/auth/register` siguen 201 (validate default body).

**Parar** si `validate` rompe auth.

### Bloque 3 — Membership

**Hacer:** `membership.ts`, `subscriptionLogger`, tests unitarios del 403.

**Aprender:** 403 vs 404, no enumerar grupos.

**Verificar:** typecheck.

### Bloque 4 — Lectura

**Hacer:** `list` + `get` en service/controller/routes. Aún se puede montar el router solo con GET.

**Verificar:** typecheck. Prueba manual opcional tras bloque 6.

### Bloque 5 — Escritura

**Hacer:** create / patch / delete, whitelist de UPDATE, owner-only.

**Verificar:** typecheck.

### Bloque 6 — Wiring backend + `/auth/me`

**Hacer:** montar router en `app.ts`; `getMe` en auth; no romper `/health` ni `/auth/*`.

**Verificar:** `typecheck`, `test`, `build`.

**Parar.** Prueba manual mínima:

```
POST /auth/register
GET  /auth/me                         → personalGroupId
POST /groups/{id}/subscriptions       → 201
GET  /groups/{id}/subscriptions       → 200
GET  /health                          → 200
```

Segundo usuario + `groupId` del primero → 403.

### Bloque 7 — Frontend mínimo

**Entrada:** bloque 6 validado a mano.

**Hacer:** `.env.local`, `session.ts`, `api.ts`, `/login`, `/dashboard`, enlaces en `page.tsx`, metadata.

**Verificar:** `pnpm --dir frontend lint` (o typecheck de Next). No guardar tokens en storage.

**Parar.** El desarrollador prueba en el navegador: login → lista vacía → crear → desactivar → eliminar.

### Bloque 8 — Cierre

**Hacer:** `docs/subscriptions.md`; comentarios breves en membership, `toSubscription` (dinero/fecha) y WHERE con `group_id`; checklist.

**Verificar:** checklist de la sección 13. No iniciar Fase 4.

---

## 13. Checklist final

### Base de datos

- [x] `005` aplicada e idempotente (verificado con dos ejecuciones y consulta de esquema).
- [x] Solo tabla nueva: `subscriptions` (+ ENUM `billing_cycle`).
- [x] FK a `groups` `ON DELETE CASCADE`.
- [x] Índices `group_id`, `(group_id, active)`, `next_billing_date`.
- [x] `CHECK (expected_cost >= 0)`.

### API

- [x] Todas las rutas de suscripciones usan `requireAuth`.
- [x] Owner: CRUD completo implementado.
- [x] Member activo: solo GET implementado.
- [x] Invited/removed: 403 (verificado manualmente).
- [x] Otro usuario: 403 al intentar acceder al `groupId` de otra persona (prueba manual reportada).
- [x] Miembro + id inexistente en su grupo: 404 implementado.
- [x] PATCH no acepta `id` / `groupId` / `createdAt`.
- [x] DELETE 204 implementado.
- [x] Queries parametrizadas.
- [x] `GET /auth/me` devuelve `personalGroupId` (prueba manual reportada).
- [x] `/health` y login/register/refresh/logout intactos (verificados en los checks del backend).

### Datos

- [x] Zod en body, params y query.
- [x] `expectedCost` string en respuestas.
- [x] Fechas `YYYY-MM-DD` sin corrimiento de TZ.
- [x] Respuestas sin `password_hash` ni tokens.

### Frontend

- [x] `/login` y `/dashboard` existen.
- [x] Loading / vacío / error / datos.
- [x] Access token solo en memoria.
- [x] Refresh con `credentials: 'include'`.
- [x] Sin grupos familiares ni pagos.
- [x] Landing de Next se conserva y tiene enlaces.
- [x] Prueba manual en navegador: login, lista vacía, crear, desactivar, eliminar y recargar.

### Calidad

- [x] `pnpm --dir backend typecheck`
- [x] `pnpm --dir backend test` (3 archivos, 18 pruebas).
- [x] `pnpm --dir backend build`
- [x] Comentarios breves en autorización, dinero/fecha y aislamiento.
- [x] `backend/docs/subscriptions.md` escrito.
- [x] Cero dependencias nuevas.
- [x] Cero tablas de fases posteriores.
- [x] Frontend: `pnpm --dir frontend lint` y `pnpm --dir frontend exec tsc --noEmit`.

Si un ítem falla, la Fase 3 no está cerrada.
