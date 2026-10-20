## Contexto del proyecto

Estoy construyendo un proyecto de práctica personal: un **sistema de rastreo de suscripciones compartidas** ("subscripciones-compartidas"). El objetivo es llevar el control de suscripciones (Netflix, Spotify, gimnasio, etc.), con recordatorios de pago y detección de anomalías (subidas de precio, pagos faltantes).

### Modos de uso

El sistema soporta dos modalidades bajo el mismo modelo de datos:

- **Modo individual**: un usuario lleva sus propias suscripciones sin compartir con nadie.
- **Modo familia**: varias personas comparten una suscripción y cada una confirma su parte del pago.

Ambos modos se resuelven con un `group`. El modo individual es un grupo con un solo miembro (el usuario como owner). Al registrarse, cada usuario obtiene un grupo `personal`. Si crea o se une a un grupo `family`, sus suscripciones familiares viven en ese grupo.

### Registro de pagos futuro

Los pagos todavía no se implementan en esta fase. Más adelante:

1. Un job revisará `next_billing_date` y generará pagos `pending`.
2. El usuario confirmará el pago.
3. Un cambio de precio marcará `price_changed = true`.
4. Los grupos familiares tendrán `payment_shares`.

No crear nada de pagos, notificaciones ni jobs durante la Fase 3.

### Modelo de datos existente y futuro

Ya existen:

```
users
  id, email, password_hash, name, created_at

groups
  id, name, type (personal/family), owner_id, created_at

group_members
  id, group_id, user_id, role (owner/member),
  status (active/invited/removed), joined_at

refresh_tokens
  id, user_id, family_id, token_hash, expires_at,
  revoked_at, replaced_by, created_at
```

En esta fase se añadirá únicamente:

```
subscriptions
  id, group_id, name, provider, expected_cost, billing_cycle,
  next_billing_date, active, created_at
```

### Stack técnico

- **Backend**: Node.js + Express 5 + TypeScript.
- **Frontend**: Next.js + React, App Router y TypeScript.
- **Base de datos**: PostgreSQL local vía Docker.
- **Autenticación ya existente**: access JWT en `Authorization: Bearer`; refresh token en cookie `httpOnly`.
- **Validación**: Zod.
- **Logger**: Winston, reutilizar `httpLogger` y el contexto apropiado.
- **Gestor de paquetes**: pnpm.
- **Convenciones**: TypeScript con `"module": "commonjs"`, tests co-ubicados dentro de `src/`.

### Estado real del repositorio después de Fase 2

Partir de esta estructura. No asumir que todo está organizado de otra manera:

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
│   │   │       ├── 003_create_group_members.sql
│   │   │       └── 004_create_refresh_tokens.sql
│   │   ├── middleware/
│   │   │   ├── auth.middleware.ts
│   │   │   ├── errorHandler.ts
│   │   │   ├── notFound.ts
│   │   │   └── validate.ts
│   │   ├── modules/
│   │   │   └── auth/
│   │   │       ├── auth.controller.ts
│   │   │       ├── auth.routes.ts
│   │   │       ├── auth.schemas.ts
│   │   │       ├── auth.service.ts
│   │   │       ├── auth.service.test.ts
│   │   │       ├── auth.tokens.ts
│   │   │       └── auth.types.ts
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

Notas:

- La carpeta real es `src/middleware`, en singular.
- `src/modules/auth` fue creada durante la Fase 2.
- `requireAuth` ya valida el access token y asigna `req.user = { id, email }`.
- `frontend/` existe, pero su UI sigue siendo la generada inicialmente; el dashboard de esta fase será mínimo.
- No añadir `src/jobs`, `src/payments` ni `src/notifications`.

### Plan de fases general

1. Base del proyecto — completada.
2. Autenticación — completada.
3. Suscripciones (CRUD, permisos por rol, dashboard básico) — **fase actual**.
4. Pagos y jobs programados.
5. Modo familia e invitaciones.
6. Notificaciones y anomalías.
7. Pulido, logging completo, tests y documentación del API.

---

## Instrucción principal

Genera un **plan detallado en Markdown para la Fase 3 únicamente** (Suscripciones: CRUD, permisos por rol y dashboard básico), listo para dárselo a un modelo de implementación (OpenCode) como guía paso a paso.

Debes crear o actualizar únicamente este archivo:

```text
prompts/plan-fases/plan-fase-3.md
```

No implementes código de la Fase 3 en este prompt ni en `backend/` o `frontend/`. Este archivo es un prompt para que otro modelo genere el plan; el resultado esperado es el documento `plan-fase-3.md`.

El plan debe dividirse en **bloques pequeños, ordenados y verificables**, porque el objetivo del proyecto es aprender sin recibir demasiados cambios de una sola vez. Cada bloque debe indicar:

- Qué se va a construir.
- Qué archivos se crean o modifican.
- Qué conceptos se aprenden.
- Cómo verificarlo antes de pasar al bloque siguiente.
- Qué prueba manual requiere y cuándo detenerse para que el desarrollador la ejecute.

No saltar directamente a una implementación grande. Si una decisión es necesaria, tomarla explícitamente y explicar por qué.

---

## Requisitos del plan que debes generar

### 1. Alcance exacto de la Fase 3

El plan debe incluir únicamente:

- Migración de `subscriptions`.
- CRUD de suscripciones.
- Autorización basada en pertenencia al grupo y rol.
- Dashboard básico de suscripciones.
- Tests y documentación mínima de los endpoints.

Debe excluir explícitamente:

- Pagos.
- `payment_shares`.
- Jobs o cron.
- Notificaciones.
- Invitaciones.
- Gestión avanzada de grupos y transferencia de ownership.
- Detección de anomalías.
- Integraciones externas.

### 2. Decisiones de dominio que deben quedar fijadas

El plan debe usar estas decisiones, sin dejar la implementación ambigua:

- Cada suscripción pertenece exactamente a un `group` mediante `group_id`.
- Solo miembros con `status = 'active'` pueden consultar suscripciones del grupo.
- El owner (`role = 'owner'`) tiene CRUD completo.
- Un miembro (`role = 'member'`) puede listar y consultar, pero no crear, editar ni eliminar.
- Las filas con `status = 'invited'` o `status = 'removed'` no tienen acceso.
- Las suscripciones de un grupo personal siguen las mismas reglas; su usuario es owner.
- `active` permite activar/desactivar sin borrar el historial de la suscripción.
- El borrado será físico en esta fase mediante `DELETE`; la eliminación lógica completa no se implementa todavía.
- No se debe permitir acceder a una suscripción usando solo su `subscriptionId` si el usuario no pertenece al grupo.
- El owner del grupo se identifica mediante `group_members`, pero el plan debe comprobar también que el `group_id` corresponde al usuario autenticado.

Si el modelo cree que alguna decisión debe cambiarse, debe justificarlo antes de proponer código. No introducir permisos nuevos como `admin`.

### 3. Diseño de la tabla `subscriptions`

Definir la migración exacta `005_create_subscriptions.sql` respetando las tablas existentes.

Requisitos mínimos:

```sql
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
group_id UUID NOT NULL REFERENCES groups(id)
name VARCHAR(255) NOT NULL
provider VARCHAR(255) NOT NULL
expected_cost NUMERIC(12, 2) NOT NULL
billing_cycle ... NOT NULL
next_billing_date DATE NOT NULL
active BOOLEAN NOT NULL DEFAULT TRUE
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

El plan debe decidir y fijar:

- `ON DELETE` para `group_id`. Recomendación: `ON DELETE CASCADE`, porque una suscripción no puede existir sin grupo.
- Tipo de `billing_cycle`. Recomendación: ENUM `weekly`, `monthly`, `quarterly`, `yearly` para esta fase; no incluir `custom` mientras no exista lógica para calcularlo.
- `expected_cost >= 0` mediante `CHECK`.
- `name` y `provider` no vacíos, controlados por límites y validación de aplicación.
- Si se permiten dos suscripciones iguales del mismo proveedor en el mismo grupo. Recomendación: sí, no añadir unique artificial.
- Índices en `group_id`, `(group_id, active)` y `next_billing_date` para los jobs futuros.
- No añadir `updated_at`, moneda ni campos de pagos en esta fase salvo justificación explícita.

El plan debe proporcionar el SQL completo, el orden de la migración y explicar por qué es idempotente usando el runner existente. No crear ninguna tabla adicional.

### 4. Estructura de archivos

Proponer una estructura concreta respetando `src/modules/auth` como precedente. Se recomienda:

```text
backend/src/
├── db/migrations/
│   └── 005_create_subscriptions.sql
├── modules/subscriptions/
│   ├── subscription.controller.ts
│   ├── subscription.routes.ts
│   ├── subscription.service.ts
│   ├── subscription.schemas.ts
│   ├── subscription.types.ts
│   └── subscription.service.test.ts
├── middleware/
│   ├── auth.middleware.ts             # existente, reutilizar
│   ├── groupAccess.middleware.ts      # nuevo, si se justifica
│   └── validate.ts                    # existente, reutilizar
└── types/express.d.ts                 # solo extender si hace falta
```

El plan debe explicar si conviene un `groupAccess.middleware.ts` o una función de autorización en el servicio. Para aprendizaje y evitar duplicación, se recomienda una función reutilizable que:

1. Reciba `userId` y `groupId`.
2. Busque un `group_members` activo.
3. Devuelva el rol o lance `AppError(403, 'Forbidden')`.

No confiar en un `role` enviado por el cliente. No permitir que el cliente decida el grupo desde el body si el `groupId` ya está en la URL.

### 5. Dependencias

El plan debe revisar el `package.json` actual antes de instalar algo. Ya existe `zod`, `pg`, Express, JWT, bcrypt y Vitest.

No instalar ORM.

No instalar librerías nuevas salvo que sean imprescindibles. Para esta fase debe bastar con las dependencias actuales.

Si el frontend necesita un cliente HTTP, preferir `fetch` nativo de Next.js antes que añadir Axios al frontend.

### 6. Autorización y seguridad

Explicar detalladamente el flujo para cada operación:

1. `requireAuth` valida el access token.
2. Se obtiene `groupId` desde `req.params`.
3. Se valida que tenga formato UUID antes de consultar.
4. Se consulta `group_members` con `user_id`, `group_id` y `status = 'active'`.
5. Si no existe → `403 Forbidden` o `404` según la política elegida; el plan debe fijar una sola política. Recomendación: `403` para pertenencia insuficiente.
6. Para escritura se exige `role = 'owner'`.
7. Las queries de `subscriptions` siempre incluyen `group_id` para impedir acceso cruzado.

Diferenciar:

- `401`: falta o es inválido el access token.
- `403`: usuario autenticado sin permisos o no miembro activo.
- `404`: recurso inexistente dentro de un grupo al que sí tiene acceso.
- `400`: UUID o body inválido.

El plan debe indicar cómo evitar la enumeración de suscripciones de otros grupos. No hacer primero un `SELECT subscription WHERE id = ...` sin comprobar el grupo.

### 7. Endpoints exactos

Definir request, response, validaciones, permisos y códigos HTTP para estos endpoints:

```text
POST   /groups/:groupId/subscriptions
GET    /groups/:groupId/subscriptions
GET    /groups/:groupId/subscriptions/:subscriptionId
PATCH  /groups/:groupId/subscriptions/:subscriptionId
DELETE /groups/:groupId/subscriptions/:subscriptionId
```

Todos requieren `Authorization: Bearer <accessToken>`.

#### Crear

Owner solamente.

Request recomendado:

```json
{
  "name": "Plan Premium",
  "provider": "Netflix",
  "expectedCost": 17.99,
  "billingCycle": "monthly",
  "nextBillingDate": "2026-10-01"
}
```

Response: `201` con el recurso creado, sin campos internos innecesarios.

#### Listar

Owner y miembros activos.

Response: `200` con array. El plan debe decidir si devuelve array directo o `{ subscriptions: [] }`; usar `{ subscriptions: [] }` para mantener espacio futuro de paginación.

Filtros mínimos opcionales:

- `active=true|false`.
- No añadir búsqueda, paginación ni orden complejo salvo que se especifique con claridad.

Orden recomendado: `created_at DESC`.

#### Obtener una

Owner y miembros activos.

Si no existe dentro del grupo autorizado → `404 Subscription not found`.

#### Editar

Owner solamente.

Usar `PATCH`, permitir actualizar parcialmente:

- `name`.
- `provider`.
- `expectedCost`.
- `billingCycle`.
- `nextBillingDate`.
- `active`.

No permitir cambiar `id`, `groupId` ni `createdAt`.

#### Eliminar

Owner solamente.

`204 No Content`. Si no existe dentro del grupo autorizado → `404`.

El plan debe indicar cómo evitar que un body malicioso cambie `groupId` mediante spread del objeto recibido.

### 8. Validación con Zod

Definir schemas concretos:

```ts
createSubscriptionSchema
updateSubscriptionSchema
subscriptionParamsSchema
subscriptionQuerySchema
```

Validar:

- `name`: trim, mínimo 1, máximo 255.
- `provider`: trim, mínimo 1, máximo 255.
- `expectedCost`: número finito, mínimo 0, máximo razonable, máximo 2 decimales.
- `billingCycle`: solo los valores del ENUM.
- `nextBillingDate`: formato ISO `YYYY-MM-DD` y fecha calendario válida.
- `active`: boolean real, no string arbitrario en body.
- `groupId` y `subscriptionId`: UUID válido.
- Query `active`: transformar explícitamente `"true"`/`"false"` a boolean.

Para `PATCH`, al menos un campo debe estar presente y no aceptar objetos desconocidos silenciosamente sin decisión documentada.

Usar el middleware `validate` existente. No duplicar validación manual en cada controller.

### 9. Servicio y SQL

El plan debe exigir queries parametrizadas, nunca interpolación de valores del usuario.

Definir funciones con nombres y responsabilidades claras, por ejemplo:

```text
createSubscription(userId, groupId, input)
listSubscriptions(userId, groupId, filters)
getSubscription(userId, groupId, subscriptionId)
updateSubscription(userId, groupId, subscriptionId, input)
deleteSubscription(userId, groupId, subscriptionId)
getActiveMembership(userId, groupId)
```

La autorización debe centralizarse para no repetir una versión distinta en cada función.

Las queries de lectura y escritura deben tener esta forma conceptual:

```sql
... FROM subscriptions s
JOIN group_members gm ON gm.group_id = s.group_id
WHERE s.id = $subscriptionId
  AND s.group_id = $groupId
  AND gm.user_id = $userId
  AND gm.status = 'active'
```

Para escritura, además comprobar owner. El plan debe decidir si esa comprobación vive en el servicio antes de la query o en una query con `role = 'owner'`; elegir una estrategia consistente.

### 10. Manejo de dinero y fechas

El plan debe explicar que PostgreSQL devuelve `NUMERIC` como string con `pg` por defecto. No convertir automáticamente a `number` perdiendo precisión.

Decidir una representación de API:

- Recomendación: devolver `expectedCost` como string decimal (`"17.99"`) para conservar precisión, o documentar de forma explícita una conversión segura.
- No utilizar cálculos de dinero con floats sin redondeo.

Para `next_billing_date`:

- Usar `DATE` porque no se necesita hora en esta fase.
- Devolver `YYYY-MM-DD`.
- No aplicar conversiones de zona horaria.

Esta decisión debe quedar reflejada en tipos, schemas, respuestas y tests.

### 11. Logging

Usar `httpLogger` para requests si ya está disponible o un logger de contexto de suscripciones si se crea explícitamente. No crear logs excesivos.

Registrar:

- Creación exitosa: `userId`, `groupId`, `subscriptionId`.
- Actualización exitosa: `userId`, `groupId`, `subscriptionId`.
- Eliminación exitosa: `userId`, `groupId`, `subscriptionId`.
- Acceso denegado: `userId`, `groupId`, `operation`.
- Error de base de datos: código y mensaje seguro.

No registrar:

- Access tokens.
- Cookies.
- Passwords.
- `DATABASE_URL`.
- Bodies completos.
- Datos innecesarios de la suscripción.

Si se registra el coste, explicar por qué; la recomendación es no registrarlo porque no aporta valor en esta fase.

### 12. Dashboard básico del frontend

El plan debe decidir el alcance mínimo del frontend sin convertirlo en una fase de diseño extensa.

Recomendación:

- Crear una pantalla `/dashboard` protegida visualmente.
- Mostrar las suscripciones del grupo personal del usuario.
- Mostrar nombre, proveedor, coste esperado, ciclo, próxima fecha y estado activo/inactivo.
- Añadir formulario sencillo para crear.
- Añadir acciones simples para editar, activar/desactivar y eliminar.
- Mostrar estados de carga, vacío y error.
- No implementar todavía grupos familiares, invitaciones ni pagos.

Como el access token vive en memoria y el refresh está en cookie:

1. El cliente API debe mantener el access token en memoria.
2. Al cargar el dashboard, intentar `POST /auth/refresh` con `credentials: 'include'`.
3. Usar el access token resultante para las peticiones.
4. Si refresh falla, mostrar estado no autenticado y enlace al login existente o documentar claramente que el login de frontend queda fuera.

El plan debe revisar el frontend real antes de proponer archivos. No borrar la página inicial sin indicar la razón. No almacenar tokens en `localStorage`.

### 13. Tests

Mantener tests co-ubicados dentro de `src/`.

Tests unitarios mínimos:

- Schema de creación válido.
- Schema de creación rechaza coste negativo.
- Schema rechaza ciclo no permitido.
- Schema rechaza fecha inválida.
- Schema de PATCH exige al menos un campo.
- Query `active=true|false` se transforma correctamente.
- Usuario member no puede ejecutar operación de owner.
- Usuario invited o removed no puede consultar.
- Un `groupId` de otro grupo no permite acceso.
- Respuesta de recurso no incluye campos sensibles de `users`.

Tests de servicio o integración recomendados:

- Owner crea una suscripción.
- Member lista y obtiene una suscripción.
- Member recibe `403` al crear, editar o eliminar.
- Usuario de otro grupo recibe `403`.
- Actualización parcial conserva los campos no enviados.
- Eliminación devuelve `204`.
- Filtro `active` funciona.

No hacer mocks complejos si una prueba contra PostgreSQL local es más clara. El plan debe separar tests unitarios de integración y explicar cómo limpiar datos de prueba sin borrar usuarios reales.

### 14. Documentación de API

Incluir en el plan una forma ligera de documentar los endpoints, por ejemplo `backend/docs/subscriptions.md` o una sección del README del backend.

Documentar:

- Header de autenticación.
- Permisos por operación.
- Request y response.
- Errores `400`, `401`, `403`, `404`.
- Ejemplos sin tokens reales ni datos sensibles.

No instalar Swagger salvo que se justifique como una tarea independiente y pequeña.

### 15. Orden de implementación por bloques

El plan generado debe dividirse como mínimo así:

#### Bloque 1: Modelo de datos

- Migración `005`.
- Verificación SQL.
- `typecheck`.
- Detenerse para revisar el esquema antes de programar servicios.

#### Bloque 2: Schemas y tipos

- Tipos de suscripción.
- Schemas Zod.
- Parámetros y filtros.
- Tests unitarios de validación.

#### Bloque 3: Autorización de grupos

- Función reusable para membership y rol.
- Tests de owner, member, invited y removed.

#### Bloque 4: Listado y consulta

- `GET` list y detail.
- Queries con aislamiento por grupo.
- Verificación de permisos.

#### Bloque 5: Crear, editar y eliminar

- `POST`, `PATCH`, `DELETE`.
- Permisos de owner.
- Respuestas y errores.

#### Bloque 6: Integración de rutas

- Montar `/groups/:groupId/subscriptions`.
- Mantener `/auth` y `/health` funcionando.
- `typecheck`, tests y build.

#### Bloque 7: Dashboard mínimo

- Revisar estructura del frontend.
- API client en memoria.
- Pantalla de listado y formulario básico.
- Estados loading/empty/error.

#### Bloque 8: Verificación final

- Tests automáticos.
- Pruebas manuales con owner, member y usuario no autorizado.
- Revisión de logs.
- Revisión de no regresión.

Cada bloque debe tener una condición de entrada y una condición de salida. El modelo implementador debe parar después de los bloques que requieran decisión o prueba manual, en lugar de continuar automáticamente.

### 16. Checklist final

Incluir un checklist ejecutable que confirme:

#### Base de datos

- [ ] Migración `005` aplicada e idempotente.
- [ ] Solo existe la tabla `subscriptions` nueva.
- [ ] FK a `groups` e índices presentes.
- [ ] Coste no negativo.
- [ ] Ciclo de facturación limitado a los valores definidos.

#### API

- [ ] Todos los endpoints requieren access token.
- [ ] Owner tiene CRUD completo.
- [ ] Member solo puede listar y consultar.
- [ ] Invited y removed no tienen acceso.
- [ ] Usuario de otro grupo no puede acceder por ID.
- [ ] `PATCH` no permite cambiar `id`, `groupId` ni `createdAt`.
- [ ] Errores tienen formato estándar del proyecto.
- [ ] Queries parametrizadas.

#### Validación y datos

- [ ] Inputs validados con Zod.
- [ ] Costes no pierden precisión.
- [ ] Fechas usan `YYYY-MM-DD`.
- [ ] Respuestas no incluyen `password_hash`, tokens ni secretos.

#### Frontend

- [ ] Dashboard básico muestra loading, vacío, error y datos.
- [ ] No se guardan access tokens en `localStorage`.
- [ ] Refresh usa cookie con `credentials: 'include'`.
- [ ] No se implementan grupos familiares ni pagos.

#### Calidad

- [ ] `pnpm typecheck` pasa.
- [ ] `pnpm test` pasa.
- [ ] `pnpm build` pasa.
- [ ] Tests co-ubicados dentro de `src/`.
- [ ] Código documentado brevemente en autorización, dinero y aislamiento por grupo.
- [ ] `/health` y autenticación de Fase 2 siguen funcionando.

No dar la Fase 3 por cerrada si falla un punto del checklist. El objetivo es una implementación pequeña, comprensible y segura, no adelantar funcionalidades de fases posteriores.
