# Plan Fase 1 — Base del proyecto

Guía de implementación para OpenCode. Ejecutar **solo esta fase**. No implementar autenticación, CRUD de negocio, jobs, ni frontend.

Proyecto: sistema de rastreo de suscripciones compartidas (`gestor-suscripciones`).
Stack de esta fase: Node.js + Express 5 + TypeScript + PostgreSQL + Winston + pnpm.

---

## 0. Alcance y estado actual del repo

### En alcance

- Alinear TypeScript (`^5.7.0`, `"module": "commonjs"`).
- Estructura de carpetas del backend.
- Variables de entorno y `.env.example`.
- Winston (niveles, formato, transports, child loggers por contexto).
- Pool `pg` con manejo de errores de conexión.
- Migraciones SQL de `users`, `groups`, `group_members` + runner.
- App Express mínima: `GET /health`, 404, middleware de errores.
- Arranque (`server.ts`) que conecta a Postgres, corre migraciones (o un script aparte) y escucha el puerto.

### Fuera de alcance (no tocar / no implementar)

- Rutas de registro, login, refresh, logout.
- Uso de `bcrypt`, `jsonwebtoken`, `axios` (pueden quedar instalados, no importarlos).
- Tablas `refresh_tokens`, `subscriptions`, `payments`, `payment_shares`, `notifications`.
- Frontend (`frontend/` ya existe con Next.js App Router). No modificarlo.
- Lógica de grupo personal al registrarse (Fase 2).
- Tests de negocio. Convención: cuando existan, van co-ubicados en `src/**/*.test.ts`.

### Estado actual (partir de esto, no recrear el repo)

```
gestor-suscripciones/
  backend/
    package.json          # dependencias ya instaladas (ver sección 2)
    pnpm-lock.yaml
    tsconfig.json         # INCORRECTO: module nodenext, typescript ^5.9.3, sin rootDir/outDir
    (no existe src/)
  frontend/               # Next.js App Router — no tocar
  docker-compose.yml      # Postgres 16 listo
  .gitignore
  README.md               # vacío
  prompts/                # no implementar código aquí
```

`docker-compose.yml` ya define:

- imagen `postgres:16`
- user `subscripciones`
- password `dev_password`
- db `subscripciones_db`
- puerto `5432`

No cambiar esas credenciales de desarrollo. El backend usa `PORT=3001` para no chocar con Next.js (`3000`).

---

## 1. Estructura de carpetas

Crear exactamente esto bajo `backend/`. No crear archivos vacíos de “por si acaso” fuera de esta lista.

```
gestor-suscripciones/
├── backend/
│   ├── src/
│   │   ├── config/
│   │   │   ├── env.ts              # carga y valida process.env
│   │   │   └── logger.ts           # Winston + child loggers (auth, payment, job, db, http)
│   │   ├── db/
│   │   │   ├── pool.ts             # Pool de pg
│   │   │   ├── migrate.ts          # runner de migraciones SQL
│   │   │   └── migrations/
│   │   │       ├── 001_create_users.sql
│   │   │       ├── 002_create_groups.sql
│   │   │       └── 003_create_group_members.sql
│   │   ├── middleware/
│   │   │   ├── errorHandler.ts     # AppError + handler 4 args
│   │   │   └── notFound.ts         # 404 JSON
│   │   ├── routes/
│   │   │   └── health.ts           # GET /health — única ruta de esta fase
│   │   ├── types/
│   │   │   └── express.d.ts        # ampliación de Request si hace falta (vacío útil para Fase 2)
│   │   ├── app.ts                  # crea y exporta la app Express (sin listen)
│   │   └── server.ts               # entrypoint: env, pool, migrate, listen
│   ├── logs/                       # creado en runtime; ya está en .gitignore raíz
│   ├── .env.example
│   ├── .env                        # local, no commitear
│   ├── package.json
│   └── tsconfig.json
├── frontend/                       # YA EXISTE. Fase 1 no lo modifica.
│   └── src/app/                    # App Router
├── docker-compose.yml
└── .gitignore
```

Convenciones de código:

- TypeScript pineado a `^5.7.0`.
- `"module": "commonjs"`.
- Imports CommonJS-friendly (`esModuleInterop: true`). No usar `verbatimModuleSyntax`.
- Tests futuros: `src/foo.test.ts` al lado del módulo, nunca en `__tests__/` ni `backend/tests/`.
- No añadir comentarios en el código salvo que un archivo de config lo necesite de forma mínima.

### 1.1 `tsconfig.json` — reemplazar el actual por completo

El archivo actual usa `"module": "nodenext"`, `verbatimModuleSyntax` y no define `rootDir`/`outDir`. Sustituirlo por:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "rootDir": "./src",
    "outDir": "./dist",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "sourceMap": true,
    "declaration": false,
    "types": ["node"],
    "moduleDetection": "force"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

No incluir `jsx`. No usar `nodenext`.

### 1.2 Scripts en `backend/package.json`

Dejar / actualizar:

```json
{
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "typecheck": "tsc --noEmit",
    "migrate": "tsx src/db/migrate.ts"
  }
}
```

`main` puede quedar `"dist/server.js"`. No añadir script `test` todavía.

---

## 2. Dependencias exactas

Trabajar siempre dentro de `backend/` con **pnpm**. No usar npm/yarn.

### 2.1 Ya instaladas — usar en esta fase

| Paquete | Versión actual | Propósito en Fase 1 |
|---|---|---|
| `express` | `^5.2.1` | Servidor HTTP |
| `pg` | `^8.23.0` | Cliente / Pool PostgreSQL |
| `winston` | `^3.19.0` | Logger |
| `dotenv` | `^17.4.2` | Cargar `.env` |
| `cors` | `^2.8.6` | CORS hacia el frontend (origen `http://localhost:3000`) |

Dev:

| Paquete | Versión actual | Propósito |
|---|---|---|
| `typescript` | `^5.9.3` → **cambiar a `^5.7.0`** | Compilador, convención del proyecto |
| `tsx` | `^4.23.13` | `dev` y `migrate` sin build |
| `@types/node` | `^26.4.0` | Tipos Node |
| `@types/express` | `^5.0.6` | Tipos Express |
| `@types/pg` | `^8.23.1` | Tipos pg |
| `@types/cors` | `^2.8.19` | Tipos cors |

Comando para pinear TypeScript:

```bash
pnpm add -D typescript@^5.7.0
```

### 2.2 Ya instaladas — NO usar en esta fase

Dejarlas en `package.json`, no importarlas:

| Paquete | Se usará en |
|---|---|
| `bcrypt` + `@types/bcrypt` | Fase 2 (hash de passwords) |
| `jsonwebtoken` + `@types/jsonwebtoken` | Fase 2 (access/refresh) |
| `axios` | Fases posteriores (llamadas externas, si aplican) |

### 2.3 No instalar en esta fase

- `cookie-parser` (Fase 2, cookie httpOnly del refresh).
- `node-cron` / `bull` (Fase 4).
- runners de test (`vitest`, `jest`).
- ORMs (`prisma`, `drizzle`, `typeorm`). SQL crudo + `pg`.
- `node-pg-migrate` / `umzug`. El runner es el archivo `src/db/migrate.ts`.

No añadir dependencias nuevas salvo que `pnpm typecheck` lo exija (no debería).

---

## 3. Variables de entorno

Crear `backend/.env.example` (se commitea) y `backend/.env` (no se commitea; ya cubierto por `.gitignore` raíz).

Contenido exacto de `.env.example`:

```
# App
NODE_ENV=development
PORT=3001

# PostgreSQL (debe coincidir con docker-compose.yml de la raíz)
DATABASE_URL=postgresql://subscripciones:dev_password@localhost:5432/subscripciones_db

# JWT — no se usan en Fase 1; se definen ahora para no tocar .env en Fase 2
JWT_ACCESS_SECRET=change_me_access_secret_min_32_chars
JWT_REFRESH_SECRET=change_me_refresh_secret_min_32_chars
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d

# Winston
LOG_LEVEL=info
LOG_DIR=logs
```

Copiar a `.env` con los mismos valores de desarrollo.

### 3.1 `src/config/env.ts`

Responsabilidad: cargar dotenv **una sola vez** al inicio y exportar un objeto tipado. Fallar rápido si falta algo.

Comportamiento:

1. `import dotenv from 'dotenv'` y `dotenv.config()` (cwd = `backend/`).
2. Leer variables. Si falta cualquiera de las listadas abajo, `throw` con el nombre de la variable y **sin** imprimir el valor.
3. Exportar:

```ts
export const env = {
  nodeEnv: 'development' | 'production' | 'test',
  isProd: boolean,
  port: number,                    // parseInt, default 3001 solo si PORT ausente… en realidad PORT es requerida
  databaseUrl: string,
  jwtAccessSecret: string,
  jwtRefreshSecret: string,
  jwtAccessExpiresIn: string,
  jwtRefreshExpiresIn: string,
  logLevel: 'info' | 'warn' | 'error',
  logDir: string,
};
```

Validaciones mínimas:

- `NODE_ENV` ∈ `development | production | test`.
- `PORT` entero 1–65535.
- `DATABASE_URL` empieza por `postgres://` o `postgresql://`.
- `JWT_ACCESS_SECRET` y `JWT_REFRESH_SECRET` longitud ≥ 32 (aunque no se usen aún).
- `LOG_LEVEL` ∈ `info | warn | error`. Default `info` si se quiere ser permisivo; preferible requerirla.

Este módulo no loguea secretos ni `DATABASE_URL`.

`server.ts` debe importar `./config/env` **antes** que el resto.

---

## 4. Configuración de Winston

Archivo: `src/config/logger.ts`.

### 4.1 Niveles

Solo tres, en este orden de severidad: `error`, `warn`, `info`.
`LOG_LEVEL=info` muestra los tres; `warn` oculta `info`; `error` solo errores.

No usar `debug` ni `silly` en esta fase.

### 4.2 Formato

- Timestamp ISO (`YYYY-MM-DDTHH:mm:ss.SSSZ`).
- Nivel.
- `context` (default `app` si no hay child logger).
- Mensaje.
- `error.stack` cuando se pase un `Error`.
- JSON en producción (`NODE_ENV=production`).
- Texto alineado + color en desarrollo (`winston.format.cli` o `colorize` + `printf`).

Campos útiles en cada log: `{ context, message, ...meta }`.
No incluir `password`, `password_hash`, `token`, `authorization`, `cookie`, `secret`.

### 4.3 Transports

**Development (`NODE_ENV !== 'production'`):**

- Un `Console` transport, nivel = `LOG_LEVEL`.

**Production:**

- `Console` (stdout), mismo nivel (útil en Docker/hosting).
- `File` → `${LOG_DIR}/combined.log`, nivel `info`.
- `File` → `${LOG_DIR}/error.log`, nivel `error`.
- Crear `LOG_DIR` si no existe (`fs.mkdirSync({ recursive: true })`) al inicializar el logger.

Rotación: no hace falta `winston-daily-rotate-file` en Fase 1. Archivos simples.

### 4.4 Child loggers por contexto

Exportar:

```ts
export const logger = /* winston root, defaultMeta: { context: 'app' } */;
export const authLogger = logger.child({ context: 'auth' });
export const paymentLogger = logger.child({ context: 'payment' });
export const jobLogger = logger.child({ context: 'job' });
export const dbLogger = logger.child({ context: 'db' });
export const httpLogger = logger.child({ context: 'http' });
```

En Fase 1 se usan `logger`, `dbLogger` y `httpLogger`. Los de `auth` / `payment` / `job` se exportan ya para Fases 2/4/6, sin escribir logs ficticios.

### 4.5 Qué NO debe loguearse nunca

Implementar un `sanitizeMeta` (o equivalente) que, si el meta trae estas keys (case-insensitive), las reemplace por `'[REDACTED]'`:

- `password`, `password_hash`, `currentPassword`, `newPassword`
- `token`, `accessToken`, `refreshToken`, `jwt`, `authorization`
- `cookie`, `cookies`
- `secret`, `jwtAccessSecret`, `jwtRefreshSecret`, `DATABASE_URL`, `databaseUrl`, `connectionString`
- `cardNumber`, `pan`, `cvv`, `cvc`, `card`, `creditCard`

Regla de producto (cumplir y dejar constancia en un comentario de una línea junto a `sanitizeMeta` está prohibido por convención de “no comments”; cumplir la regla en código y en este plan):

- Nunca loguear passwords ni hashes.
- Nunca loguear JWT (access o refresh) ni headers `Authorization`.
- Nunca loguear números de tarjeta, CVV, ni montos completos asociados a datos de tarjeta.
- Nunca loguear `DATABASE_URL` (contiene la password de Postgres).
- En errores de `pg`, loguear `err.message` / `err.code`, no el objeto de config del cliente.

El `errorHandler` debe pasar el error a Winston **después** de sanitizar.

---

## 5. Pool de conexión a Postgres

Archivo: `src/db/pool.ts`. Cliente: `pg` (`Pool`), no ORM.

### 5.1 Creación

```ts
import { Pool } from 'pg';
import { env } from '../config/env';
import { dbLogger } from '../config/logger';

export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});
```

No pasar `user`/`password` sueltos además de `connectionString`. No loguear la URL.

### 5.2 Eventos y errores

```ts
pool.on('error', (err) => {
  dbLogger.error('Unexpected error on idle client', { message: err.message });
});
```

No hacer `process.exit` dentro del handler `error` (es un cliente idle). El exit controlado va en `server.ts` si falla el ping inicial.

### 5.3 Ping al arrancar

Exportar:

```ts
export async function assertDbConnection(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    dbLogger.info('Postgres connection OK');
  } finally {
    client.release();
  }
}
```

Si lanza, `server.ts` loguea con `dbLogger.error` (mensaje + `err.message`) y `process.exit(1)`.

### 5.4 Cierre limpio

```ts
export async function closePool(): Promise<void> {
  await pool.end();
  dbLogger.info('Postgres pool closed');
}
```

`server.ts` registra `SIGINT` y `SIGTERM` → `closePool()` → `process.exit(0)`.

`migrate.ts` usa el mismo `pool` (o uno propio que también haga `end()` al terminar). Preferir el mismo `pool` e invocar `closePool()` solo cuando el proceso sea el de migrate, no cuando migrate se llame desde `server.ts` (ver 5.5).

### 5.5 ¿Migrar al arrancar?

Dos modos, ambos obligatorios:

1. Script: `pnpm migrate` ejecuta `src/db/migrate.ts` y termina (cierra el pool).
2. Arranque: `server.ts` llama `runMigrations()` **antes** de `listen`, y **no** cierra el pool.

Así `pnpm dev` deja el esquema listo sin paso extra, y CI/producción puede correr `pnpm migrate` aparte.

---

## 6. Migraciones SQL

Solo tres tablas de negocio + la tabla de control del runner. No crear `subscriptions`, `payments`, `payment_shares`, `notifications`, `refresh_tokens`.

### 6.1 Runner `src/db/migrate.ts`

Algoritmo:

1. Importar `env` primero, luego `pool` y `dbLogger`.
2. `CREATE TABLE IF NOT EXISTS schema_migrations (id SERIAL PRIMARY KEY, filename TEXT NOT NULL UNIQUE, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`
3. Leer `src/db/migrations/`, filtrar `*.sql`, ordenar por nombre (`001_...`, `002_...`, `003_...`).
4. Para cada archivo: si `filename` ya está en `schema_migrations`, skip; si no, `BEGIN` → ejecutar SQL completo → `INSERT INTO schema_migrations (filename) VALUES ($1)` → `COMMIT`. Si falla, `ROLLBACK`, loguear `filename` + `err.message`, `process.exit(1)`.
5. Loguear `Applied N migration(s)` o `No pending migrations`.
6. Si el proceso es el de CLI (`require.main === module` equivalente en TS/CJS: `if (require.main === module)`), llamar `closePool()`.

Leer archivos con `fs.readFileSync` + `path.join(__dirname, 'migrations', filename)` (CJS, `__dirname` disponible).

Exportar `runMigrations()` para `server.ts`.

Idempotencia: re-ejecutar `pnpm migrate` no debe fallar ni duplicar tablas.

### 6.2 `001_create_users.sql`

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_email_unique UNIQUE (email),
  CONSTRAINT users_email_format CHECK (email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);

CREATE INDEX idx_users_email ON users (email);
CREATE INDEX idx_users_created_at ON users (created_at);
```

Notas:

- `email` se guarda en minúsculas en Fase 2 (aplicación). No forzar `LOWER()` aquí.
- `password_hash` nunca se selecciona en logs. No hay trigger de auditoría en esta fase.

### 6.3 `002_create_groups.sql`

```sql
CREATE TYPE group_type AS ENUM ('personal', 'family');

CREATE TABLE groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  type group_type NOT NULL,
  owner_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_groups_owner_id ON groups (owner_id);
CREATE INDEX idx_groups_type ON groups (type);

-- Un usuario solo puede poseer un grupo personal (el que se crea al registrarse en Fase 2)
CREATE UNIQUE INDEX idx_groups_one_personal_per_owner
  ON groups (owner_id)
  WHERE type = 'personal';
```

`ON DELETE RESTRICT` en `owner_id`: no borrar un usuario que aún es owner. La transferencia de ownership es Fase 5.

### 6.4 `003_create_group_members.sql`

```sql
CREATE TYPE member_role AS ENUM ('owner', 'member');
CREATE TYPE member_status AS ENUM ('active', 'invited', 'removed');

CREATE TABLE group_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role member_role NOT NULL,
  status member_status NOT NULL DEFAULT 'invited',
  joined_at TIMESTAMPTZ,
  CONSTRAINT group_members_unique_user_per_group UNIQUE (group_id, user_id),
  CONSTRAINT group_members_active_has_joined_at CHECK (
    status <> 'active' OR joined_at IS NOT NULL
  )
);

CREATE INDEX idx_group_members_group_id ON group_members (group_id);
CREATE INDEX idx_group_members_user_id ON group_members (user_id);
CREATE INDEX idx_group_members_status ON group_members (status);
```

Semántica (no implementar lógica, solo respetar el schema):

- `joined_at` NULL mientras `status = 'invited'`.
- Al pasar a `active`, la app pondrá `joined_at = NOW()` (Fase 2/5).
- `removed` conserva la fila (no DELETE) para historial.
- El owner del grupo también existirá como fila `role = 'owner'`, `status = 'active'` (Fase 2).

Orden de FKs: `001` users → `002` groups → `003` group_members. No invertir.

---

## 7. App Express, health y middleware de errores

### 7.1 `src/app.ts`

Crear la app **sin** `listen`:

1. `express()`
2. `express.json()` (limit `100kb`)
3. `cors({ origin: 'http://localhost:3000', credentials: true })` — el frontend ya vive en 3000; `credentials: true` anticipa la cookie de Fase 2.
4. Montar `healthRouter` en `/`.
5. `notFound`
6. `errorHandler` (último).

No montar routers de `auth`, `groups`, `subscriptions`.

No añadir `morgan`. Si se loguea un request, usar `httpLogger` en un middleware de una sola línea opcional (`method`, `url`, `statusCode` al `finish`). Querystring y bodies no se loguean (pueden traer passwords).

### 7.2 `src/routes/health.ts`

`GET /health`

Comportamiento:

1. `pool.query('SELECT 1 AS ok')`.
2. Si OK, `200`:

```json
{ "status": "ok", "db": "up" }
```

3. Si falla, **no** tragar el error en silencio: `next(err)` o lanzar `AppError(503, 'Database unavailable')`. El errorHandler responde JSON. Alternativa aceptable: responder `503 { "status": "error", "db": "down" }` sin stack.

No devolver `DATABASE_URL`, ni versión de Postgres, ni listas de tablas.

### 7.3 `src/middleware/notFound.ts`

```ts
export function notFound(_req, res, _next) {
  res.status(404).json({ error: { message: 'Not found', status: 404 } });
}
```

### 7.4 `src/middleware/errorHandler.ts`

Estructura, no lógica de negocio.

```ts
export class AppError extends Error {
  status: number;
  isOperational: boolean;
  constructor(status: number, message: string, isOperational = true) {
    super(message);
    this.status = status;
    this.isOperational = isOperational;
    this.name = 'AppError';
  }
}

export function errorHandler(err, _req, res, _next) {
  const status = err instanceof AppError ? err.status : 500;
  const message =
    env.isProd && status === 500 ? 'Internal server error' : err.message;

  logger.error('Unhandled error', {
    message: err.message,
    status,
    stack: env.isProd ? undefined : err.stack,
  });

  res.status(status).json({ error: { message, status } });
}
```

Reglas:

- Firma de 4 argumentos (`err, req, res, next`) — Express no lo registra si faltan.
- Nunca devolver `stack` al cliente en producción.
- Nunca meter `err` entero en el JSON de respuesta (puede contener config de pg).
- Express 5 propaga rechazos de async automáticamente; no hace falta `asyncHandler` salvo que se prefiera por claridad. Si se añade, que sea un wrapper de 5 líneas en el mismo archivo.

`src/types/express.d.ts` puede quedar así para Fase 2 (no usar `user` todavía):

```ts
export {};
```

o vacío de augmentations. No declarar `Request.user` aún.

### 7.5 `src/server.ts` (orden estricto)

```
1. import { env } from './config/env'
2. import { logger } from './config/logger'
3. import { assertDbConnection, closePool } from './db/pool'
4. import { runMigrations } from './db/migrate'
5. import { app } from './app'
6. assertDbConnection()
7. runMigrations()
8. app.listen(env.port, ...)
9. SIGINT/SIGTERM → closePool() → exit 0
```

Log de arranque: `logger.info('Server listening', { port: env.port, nodeEnv: env.nodeEnv })`.
Sin `databaseUrl`.

---

## 8. Orden de ejecución para el modelo implementador

Ejecutar en este orden, un paso a la vez:

1. Verificar que Docker Postgres está definido. Si no corre: `docker compose up -d` desde la raíz del repo. Comprobar puerto 5432.
2. En `backend/`: `pnpm add -D typescript@^5.7.0` para cumplir la convención.
3. Reemplazar `backend/tsconfig.json` por el de la sección 1.1.
4. Actualizar `scripts` de `package.json` (sección 1.2).
5. Crear `.env.example` y `.env` (sección 3).
6. Crear carpetas y archivos de la sección 1.
7. Implementar `env.ts` → `logger.ts` → `pool.ts` → SQL + `migrate.ts` → middleware → `health.ts` → `app.ts` → `server.ts`.
8. `pnpm typecheck` en `backend/`. Debe pasar sin errores.
9. `pnpm migrate` (o `pnpm dev`, que también migra). Verificar en Postgres que existen `users`, `groups`, `group_members`, `schema_migrations` y los tres ENUMs.
10. `GET http://localhost:3001/health` → `200 { "status": "ok", "db": "up" }`.
11. `GET http://localhost:3001/no-existe` → `404 { "error": { "message": "Not found", "status": 404 } }`.
12. No commitear `.env`. No modificar `frontend/`. No añadir rutas de negocio.

Si `typecheck` o el arranque fallan, corregir antes de dar por cerrada la fase.

---

## 9. Checklist final — Fase 1 completa

Marcar todo antes de pasar a Fase 2.

### Setup

- [ ] `backend/tsconfig.json` usa `"module": "commonjs"`, `rootDir: ./src`, `outDir: ./dist`.
- [ ] `typescript` en `package.json` es `^5.7.0` (no 5.9).
- [ ] Scripts `dev`, `build`, `start`, `typecheck`, `migrate` existen.
- [ ] Gestor de paquetes: pnpm. Lockfile intacto salvo el pin de TypeScript.
- [ ] `pnpm typecheck` termina con código 0.

### Estructura

- [ ] Árbol de `backend/src/` coincide con la sección 1.
- [ ] `frontend/` no fue modificado.
- [ ] No hay routers ni servicios de auth/subscriptions/payments.

### Entorno

- [ ] Existe `backend/.env.example` con las keys de la sección 3.
- [ ] Existe `backend/.env` local (gitignored).
- [ ] `env.ts` falla al arrancar si falta una variable, sin loguear valores.

### Winston

- [ ] Niveles solo `info` / `warn` / `error`.
- [ ] Consola en development; consola + archivos `logs/combined.log` y `logs/error.log` en production.
- [ ] Child loggers: `auth`, `payment`, `job`, `db`, `http`.
- [ ] Sanitización activa: passwords, tokens, secrets, `DATABASE_URL`, datos de tarjeta → `[REDACTED]`.
- [ ] Un arranque en `development` no crea ruido de auth/payment/job.

### Postgres

- [ ] `docker compose up -d` deja Postgres 16 accesible en `localhost:5432`.
- [ ] Pool: `max: 10`, timeouts definidos, handler `pool.on('error')`.
- [ ] `assertDbConnection()` corre antes de `listen`.
- [ ] SIGINT/SIGTERM cierran el pool.

### Migraciones

- [ ] `schema_migrations` existe.
- [ ] Tablas `users`, `groups`, `group_members` creadas con los tipos, FKs, CHECKs e índices de la sección 6.
- [ ] ENUMs: `group_type`, `member_role`, `member_status`.
- [ ] Índice único parcial: un solo `groups.type = 'personal'` por `owner_id`.
- [ ] `UNIQUE (group_id, user_id)` en `group_members`.
- [ ] No existen tablas de fases posteriores.
- [ ] `pnpm migrate` es idempotente (segunda corrida = 0 pendientes).

### HTTP

- [ ] Servidor en `PORT=3001`.
- [ ] `GET /health` → 200 y `"db": "up"` con Postgres vivo.
- [ ] `GET /health` degrada (503 o error JSON) si Postgres está caído.
- [ ] Ruta inexistente → 404 JSON `{ error: { message, status } }`.
- [ ] Errores no controlados → JSON `{ error: { message, status } }`, sin stack en production.
- [ ] CORS permite `http://localhost:3000` con `credentials: true`.
- [ ] Cero rutas `/auth`, `/groups`, `/subscriptions`.

### Seguridad / logging

- [ ] Ningún log de prueba contiene passwords, JWT o `DATABASE_URL`.
- [ ] `bcrypt` / `jsonwebtoken` / `axios` no se importan en `src/`.

Si algún ítem falla, la Fase 1 no está cerrada.
