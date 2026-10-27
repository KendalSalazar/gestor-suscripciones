# Invitaciones a familias — Fase 5

Las invitaciones permiten al owner compartir una familia con una cuenta existente
o futura. No se envían correos automáticamente. La API está montada bajo
`/groups/:groupId/invitations` y exige Bearer; los códigos del destinatario se
resuelven bajo `/invitations/:invitationId/{preview,accept,decline}`.

## Owner

- `POST /groups/:groupId/invitations` recibe `{ "email": "..." }`. El servidor
  normaliza el correo y devuelve `201 { invitation, token }`. El secreto es
  aleatorio, de un uso y válido por siete días; en la base solo se conserva SHA-256.
- `GET /groups/:groupId/invitations` devuelve hasta 100 estados recientes y nunca
  el token ni su hash. Una invitación pending cuya fecha ya venció se presenta como
  expired.
- `POST /groups/:groupId/invitations/:invitationId/revoke` recibe `{}` o cuerpo
  ausente. Solo revoca invitaciones pending y vigentes.

Solo un owner activo de una familia puede usar estas rutas. Cambiar ownership no
impide administrar invitaciones anteriores. Emails ajenos no se consultan para
determinar si una cuenta existe. Una invitación pending duplicada, el email del
owner o el de un miembro activo producen un conflicto.

La interfaz del dashboard crea, lista y revoca invitaciones. El código que se
comparte es `invitation.id + "." + token`; se muestra una vez en memoria después
de crear. Al copiarlo u ocultarlo se elimina del estado de pantalla. Perderlo
requiere revocar la invitación y crear otra. La lista nunca puede recuperarlo.

## Destinatario

El destinatario inicia sesión con el correo actual de su cuenta y pega el código
completo en `/invitations`. El cliente separa UUID y token; el UUID va en la ruta
y el token solo en el body `{ "token": "..." }`. El token no se coloca en URL,
query, almacenamiento persistente, logs ni navegación al login. Si falta la sesión,
la persona inicia sesión y vuelve a pegar el código.

- `POST /invitations/:invitationId/preview` comprueba el código, el email actual
  en la base de datos y la vigencia sin mutar la invitación.
- `POST /invitations/:invitationId/accept` activa la membresía como member y marca
  la invitación accepted en una sola transacción. La capacidad máxima de 20 miembros
  se comprueba bajo el bloqueo del grupo.
- `POST /invitations/:invitationId/decline` marca declined sin crear membresía.

Un UUID, token o destinatario no disponible comparte la respuesta `404 Invitation
unavailable`. Invitaciones vencidas o resueltas y conflictos de capacidad o
membresía responden `409`. Aceptar no modifica repartos históricos ni crea partes
retroactivas; después de aceptar, el dashboard vuelve a cargar `GET /groups`.

## Interfaz y privacidad

El owner ve destinatario, estado, creador y vencimiento; los errores de cuenta se
presentan sin enumerar usuarios ajenos. El recipient preview muestra familia,
correo destinatario, owner y vencimiento antes de aceptar o rechazar. Las acciones
usan `apiWithSession`; el access token sigue en memoria y refresh usa la cookie
httpOnly existente.

La creación, listado, revocación, preview, aceptación y rechazo cuentan con las
pruebas de ruta y las integraciones PostgreSQL descritas en
[groups.md](groups.md). La UI pasó lint y typecheck durante su implementación.
La comprobación manual con dos cuentas, incluido el código copiado, revocado,
vencido y ya resuelto, sigue pendiente; no se afirma que la fase esté cerrada.
