# API de suscripciones

Las rutas requieren un access token válido en `Authorization: Bearer <accessToken>`. Todas las suscripciones se consultan y modifican dentro del grupo indicado en la URL.

Base path: `/groups/:groupId/subscriptions`

## Permisos

| Operación | Owner activo | Member activo | Invitado o removido |
|---|---:|---:|---:|
| Listar y consultar | Sí | Sí | 403 |
| Crear, editar y borrar | Sí | 403 | 403 |

Un grupo inexistente y un usuario que no pertenece activamente a ese grupo reciben el mismo `403 Forbidden`. Para una persona autorizada, una suscripción inexistente dentro del grupo devuelve `404`.

## Endpoints

### Crear

`POST /groups/:groupId/subscriptions` — solo owner. Devuelve `201`.

```json
{
  "name": "Plan Premium",
  "provider": "Netflix",
  "expectedCost": "17.99",
  "billingCycle": "monthly",
  "nextBillingDate": "2026-10-01"
}
```

`billingCycle` acepta `weekly`, `monthly`, `quarterly` o `yearly`. El costo puede enviarse como string decimal o número, pero siempre se devuelve como string para conservar el valor decimal de PostgreSQL.

Respuesta abreviada:

```json
{
  "subscription": {
    "id": "<uuid>",
    "groupId": "<uuid>",
    "name": "Plan Premium",
    "provider": "Netflix",
    "expectedCost": "17.99",
    "billingCycle": "monthly",
    "nextBillingDate": "2026-10-01",
    "active": true,
    "createdAt": "2026-09-01T12:00:00.000Z"
  }
}
```

### Listar

`GET /groups/:groupId/subscriptions` — owner o member activo. Devuelve `200` y `{ "subscriptions": [...] }`, ordenadas de más recientes a más antiguas. El filtro opcional `?active=true` o `?active=false` limita los resultados por estado.

### Consultar una

`GET /groups/:groupId/subscriptions/:subscriptionId` — owner o member activo. Devuelve `200` y `{ "subscription": { ... } }`.

### Editar parcialmente

`PATCH /groups/:groupId/subscriptions/:subscriptionId` — solo owner. Se debe enviar al menos un campo permitido; por ejemplo:

```json
{ "active": false }
```

Los campos permitidos son `name`, `provider`, `expectedCost`, `billingCycle`, `nextBillingDate` y `active`. Campos como `id` o `groupId` se rechazan.

### Borrar

`DELETE /groups/:groupId/subscriptions/:subscriptionId` — solo owner. Devuelve `204` sin cuerpo.

## Errores

Los errores siguen el formato `{ "error": { "message": string, "status": number } }`.

| Estado | Significado |
|---|---|
| `400` | Parámetros, query o body inválidos |
| `401` | Falta el access token o no es válido |
| `403` | No hay membresía activa o el rol no permite escribir |
| `404` | La suscripción no existe dentro del grupo autorizado |
| `500` | Error interno |

## Identidad para el dashboard

`GET /auth/me` requiere Bearer y devuelve el perfil junto al identificador del grupo personal que usa el dashboard:

```json
{
  "user": { "id": "<uuid>", "email": "persona@example.com", "name": "Persona" },
  "personalGroupId": "<uuid>"
}
```

No se incluyen contraseñas, hashes ni tokens en estas respuestas. Los valores UUID son ejemplos, no credenciales.
