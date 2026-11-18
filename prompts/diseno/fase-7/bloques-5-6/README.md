# Suscripciones — bloques 5 y 6

Se avanza hasta completar la primera vista de producto para revisión visual del
propietario. Pagos, Familia, Invitaciones y Notificaciones continúan por sus
bloques del plan. La propuesta y el color #CF7FFF ya estaban aprobados.

## Galería del producto

| Escenario | Escritorio | Móvil |
|---|---|---|
| Checkpoint de bloque 5: lista con alta todavía permanente | [1440](checkpoint-5-1440.png) | — |
| Lista familiar owner, alta cerrada y acciones plegadas | [1440](suscripciones-owner-1440.png) | [390](suscripciones-owner-390.png) |
| Alta abierta | [1440](alta-1440.png) | [390](alta-390.png) |
| Cambiar coste, borrador sin guardar | [1440](cambiar-coste-1440.png) | [390](cambiar-coste-390.png) |
| Consulta de miembro en la misma familia | [1440](suscripciones-miembro-1440.png) | [390](suscripciones-miembro-390.png) |
| Preferencia oscura, consulta de miembro | — | [390](preferencia-oscura-390.png) |
| Error de alta simulado | — | [390](error-alta-simulado-390.png) |
| Lista vacía simulada | — | [390](vacio-simulado-390.png) |
| Error de consulta simulado | — | [390](error-consulta-simulado-390.png) |
| Foco por teclado en el botón de alta | — | [390](foco-alta-390.png) |
| Landing para comparar | [1440](landing-1440.png) | [390](landing-390.png) |

Capturas reales del frontend local, viewport CSS de 1440/390 × 900, escala 1,
contenido completo. Preferencia clara salvo donde se indica; indicador de
desarrollo oculto solo para capturar. Las imágenes principales de lista, alta,
edición, miembro, error y vacío se abrieron e inspeccionaron. Referencia anterior:
[bloque 4](../bloque-4/README.md).

Las capturas de consulta usan datos existentes de las dos cuentas autorizadas.
La edición muestra un borrador; no modifica el coste guardado. Los escenarios
con nombre «simulado» fueron creados interceptando respuestas en ese navegador,
sin escrituras de suscripciones en la API ni base de datos.

## Comprobaciones

- Una sola lista por contexto, servicio/proveedor/frecuencia, fecha DATE con
  `<time>`, coste decimal string y estado textual. No se añade moneda ni se
  convierten importes a números para mostrarlos.
- Owner: alta cerrada al entrar; abrir enfoca Nombre. El formulario vacío
  mantiene la validación HTML. Cancelar cierra sin envío, devuelve foco al
  disparador y conserva el borrador. Ir a Pagos y volver conserva apertura y
  borrador; cambiar de grupo cierra y limpia conforme a la política anterior.
- Miembro de la misma familia: dos servicios consultables; no aparece botón
  de alta ni disclosure de administración. Contexto y datos corresponden a su
  membresía real.
- Los controles de cada servicio están en un disclosure nativo `details`.
  Cambiar coste enfoca su campo; colapsar y expandir conserva el borrador;
  ir a otra vista y volver conserva la edición y reabre el disclosure.
- Respuesta de error de alta simulada: alerta, formulario abierto y datos
  conservados. Durante la espera, enviar de nuevo con el botón bloqueado no
  añade otra petición; navegación y selector también están bloqueados.
- Respuesta exitosa de alta simulada: se añade la fila en memoria, se limpia
  y cierra el formulario. Se corrigió una carrera del foco: el éxito registra
  intención y un efecto espera el commit con el botón habilitado. Repetición
  con error rápido seguido de éxito rápido: formulario oculto, datos limpios,
  botón habilitado y foco devuelto, todos comprobados. Una recarga de la consulta
  restaura la lista real.
- PATCH de coste simulado conserva `expectedCost` como string; error mantiene
  borrador y éxito actualiza fila, cierra editor y devuelve foco al summary.
- Desactivar simulado envía `{ active: false }` y muestra «Inactiva». Cancelar
  la confirmación de eliminar no envía una petición. DELETE simulado con 409
  conserva la fila y el mensaje sobre pagos registrados; respuesta 204 retira
  únicamente la fila en memoria. Una nueva consulta restaura el estado real.
- GET simulado vacío/error y reintento con demora: estados visibles y recuperación
  de las dos filas reales con su coste original. Las respuestas simuladas fueron
  retiradas antes de cerrar la sesión.
- Sin desborde horizontal en consulta a 360/390/768 px medidos. Capturas principales
  a 1440/390; no equivale a comprobar todos los recorridos y zoom del bloque 16.
- Tab desde el selector alcanza Añadir suscripción con contorno violeta de 3 px.
- La preferencia oscura conserva el ámbito claro del producto. Las PNG de landing
  en ambos anchos son idénticas por SHA-256 a las referencias de `estado-inicial`.

Las mutaciones se interceptaron solo en la página temporal: las respuestas de
éxito/error prueban la integración visual con el contrato, no constituyen nuevas
pruebas de persistencia ni reemplazan las comprobaciones previas del backend.
No se generaron pagos ni invitaciones ni se cambiaron membresías o lecturas.

Implementación por `frontend-designer` con `frontend-design`, revisión de código
por `reviewer` sin hallazgos nuevos en catálogo/alta/edición y en el ajuste de
foco. Lint y TypeScript aprobados por el diseñador; build final y
`git diff --check` aprobados por el principal.

Sesiones cerradas, interceptores retirados, navegador/perfil temporal y script
eliminados. No se guardaron credenciales en archivos. Se mantienen disponibles
frontend en 3000 y API de revisión en 3001 para que el propietario pueda revisar
la pantalla. La API se levantó directamente desde Express, sin scheduler ni
migraciones; no se cambiaron sus fuentes o configuración persistente.
