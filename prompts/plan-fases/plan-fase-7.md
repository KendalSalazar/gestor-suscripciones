# Plan Fase 7 — Rediseño visual y organización del frontend

**Estado al 15 de noviembre de 2026: bloque 1 completado con limitación visual documentada; propuesta del bloque 2 preparada e inspeccionada, pendiente de aprobación del propietario. Bloques 3 a 18 pendientes. No se modificó el producto.**
Alcance original en [07-fase.md](../07-fase.md). Una entrega por bloque, con
explicación, comprobación y parada. Crear este plan no ejecuta sus bloques.

## 0. Punto de partida contrastado

Se comprobaron carpeta de trabajo y raíz Git: ambas son
`E:\repos vsc\gestor-suscripciones`. Commit observado: `ca1aedf`,
«Fase 6 completada: notificaciones». Hay cambios previos en `AGENTS.md`, los
documentos de cierre de Fase 6 y el perfil `frontend-designer`; se conservan.

Se leyeron `AGENTS.md`, `frontend/AGENTS.md`, el cierre de Fase 6, el perfil
`.codex/agents/frontend-designer.toml`, la skill `frontend-design` y los archivos
de las pantallas. El diagnóstico inicial procede del código y de los comentarios
del propietario; no se presenta como una inspección visual en navegador.

Evidencia previa de Fase 6: 1092 pruebas backend con PostgreSQL, compilaciones,
lint y TypeScript aprobados; recorrido manual confirmado por el propietario.
No se volvieron a ejecutar para redactar este plan. El bloque 1 comprobará el
estado vigente y documentará las pantallas antes de modificarlas.

### Problemas concretos encontrados

| Evidencia en código | Consecuencia que debe resolver el diseño |
|---|---|
| `dashboard/page.tsx`: saludo, descripción, espacio, contador y navegación preceden al contenido | El título de la tarea y el contexto pierden protagonismo |
| Alta de suscripción siempre visible junto a la lista | El formulario compite con la consulta cotidiana |
| `family-groups-panel.tsx`: crear, renombrar, transferir, salir y miembros | Acciones de uso frecuente y delicadas al mismo nivel |
| `family-payments-panel.tsx`: partes propias, historial y pagos sin parte propia | Se puede confundir el importe propio con el importe del grupo |
| `notifications/page.tsx`: estructura y anchos distintos del dashboard | Cambiar de destino rompe la continuidad visual |
| `/invitations` existe, pero el propietario no encontró dónde introducir el código | Hace falta un acceso visible, también sin pertenecer a una familia |
| `layout.tsx` carga Geist y `globals.css` aplica Arial; modo oscuro automático parcial | Tipografía y contraste sin un criterio común |

Frontend actual: Next.js 16.3.3 App Router, React 19.2.8, Tailwind 4, TypeScript.
Sin dependencias de componentes ni infraestructura de pruebas de navegador
instaladas en `package.json`. Reutilizar las herramientas existentes.

### Bloque 1 — Inventario y comprobaciones base (15 de noviembre de 2026)

Carpeta y raíz Git verificadas otra vez. Se conservaron los cambios previos y
se delegó al perfil `frontend-designer` el inventario de solo lectura, aplicando
la skill `frontend-design`. Este registro procede de código, no de capturas.

| Pantalla / archivo bajo `frontend/src/app/` | Acciones vigentes y permiso | Estados que conservar |
|---|---|---|
| `/`, `page.tsx` | Ir al login o dashboard, público | Landing fuera del rediseño |
| `/login`, `login/page.tsx` | Iniciar sesión, envío a dashboard | Envío pendiente, error y credenciales; no existe formulario de registro ni botón de logout en la UI actual |
| `/dashboard`, `dashboard/page.tsx` | Seleccionar espacio y Suscripciones/Pagos/Familia; enlaces a inicio y Notificaciones | Sesión, grupos, carga/error, retorno al personal ante contexto inválido y recarga de vista |
| Suscripciones, `dashboard/page.tsx` | Consultar para miembro activo; crear, cambiar coste, activar/desactivar y eliminar para owner | Vacío, errores de consulta/acción, formulario/borrador, bloqueo durante envío; no hay edición general de nombre/proveedor/ciclo/fecha |
| Pagos personal, `dashboard/payments-panel.tsx` | Consultar pendientes e historial; confirmar importe u omitir como owner personal | Recargas independientes, formulario de confirmación, éxito/error y acción en curso |
| Pagos familiar, `dashboard/family-payments-panel.tsx` | Consultar partes propias, historial, pagos sin parte propia y desglose; confirmar solo parte propia; omitir conjunto intacto solo owner | Respuestas separadas por lista/desglose, expansión, borrador, límite miembro y excepción de owner; fallo de acceso actualiza grupos |
| Familia, `dashboard/family-groups-panel.tsx` | Crear familia; miembro activo consulta lista; owner renombra, transfiere y retira miembros; member puede salir | Carga/permisos, recarga/reintento, confirmación y bloqueo por obligaciones pendientes |
| Invitaciones owner, `dashboard/invitations-panel.tsx` | Crear por correo, copiar/ocultar código, listar historial y revocar; solo owner familiar | Código entregado una vez en memoria, errores de copia/red y operación pendiente |
| `/invitations`, `invitations/page.tsx` | Con sesión invitada, pegar código, revisar, aceptar/rechazar, usar otro código y volver al dashboard | Sin sesión, reintento, código inválido/no disponible/vencido/resuelto, envío y resultado; código se borra al ir a login |
| `/notifications`, `notifications/page.tsx` | Destinatario consulta, filtra grupo/lectura, actualiza, carga más, marca leído y abre pagos del grupo | Sesión/grupos/lista independientes, vacío/error, cursor/conteo, respuesta obsoleta cancelada y error por fila |

Riesgos de implementación localizados:

- `dashboard/page.tsx:612`, `:838` y `:857` usan `hidden` para conservar vistas
  montadas. Cambiar por renderizado condicional puede perder borradores; sus
  efectos también pueden seguir activos con la vista oculta.
- Las claves de paneles familiares incluyen grupo, owner y rol (`:846`, `:861`,
  `:873`); conservar su invalidación al cambiar permisos.
- `dashboard/page.tsx:614` coloca el formulario de alta junto a la lista;
  `:773` edita solo coste. Las maquetas no deben prometer una edición más amplia.
- El desglose y las tres listas familiares no representan obligaciones nuevas;
  evitar acciones duplicadas o sumas de listas parciales.
- La sesión de `lib/api.ts` coordina refresh; las cabeceras nuevas serán
  presentacionales para no duplicar peticiones ni crear otro almacén de sesión.

Comprobaciones ejecutadas ahora:

- [x] `pnpm.cmd --dir frontend lint` y `pnpm.cmd --dir frontend exec tsc --noEmit`.
- [x] `pnpm.cmd --dir frontend build`: compiló y generó `/`, `/login`,
  `/dashboard`, `/invitations` y `/notifications`, además de la ruta de error.
  Primer intento falló por conexión a Google Fonts; repetido con acceso de red
  terminó correctamente, sin cambiar fuentes ni código.
- [x] Inventario de acciones/permisos y riesgos contrastado con los archivos.
- [ ] Capturas base de 390 y 1440 px. Limitación: no hay herramienta conectada de
  navegador ni sesión de prueba automatizada disponible. Se localizaron binarios
  de Chrome/Edge, pero no se lanzó una sesión autenticada ni se inspeccionó la
  interfaz. No se afirman contrastes, desbordes o comportamiento responsive verificados.

Se acepta el bloque con esta limitación explícita, según su criterio original.
Antes de cambiar estilos en el bloque 3, registrar las capturas base con sesión
de prueba en el bloque 2: escritorio/móvil, personal owner, familia owner/member,
Notificaciones e Invitación, sin códigos secretos visibles. Puede completarlo
el propietario desde su navegador o el agente con un entorno autorizado.
Las capturas de mockups futuros no reemplazan las del estado anterior.
No se iniciaron servidores, jobs ni escrituras sobre cuentas o pagos.

### Bloque 2 — Propuesta visual (15 de noviembre de 2026)

Preparada por el perfil `frontend-designer` con la skill `frontend-design`.

- [x] [Maqueta navegable](../diseno/fase-7/propuesta.html) independiente, con datos
  sintéticos, sin API, sesión, almacenamiento persistente ni dependencias.
- [x] [Criterios visuales](../diseno/fase-7/criterios-visuales.md): tokens finales,
  tipografía, jerarquía, contrastes calculados y límites de la simulación.
- [x] Suscripciones, Pagos familiar y Familia, patrón de Notificaciones, formulario,
  vacío y alternancia responsable/miembro. El selector de rol superior pertenece
  solo a la maqueta; los permisos del producto seguirán viniendo del servidor.
- [x] Capturas Chrome con ancho CSS real de 1440/390 px: inspeccionadas en
  escritorio y móvil. Se comprobó que `scrollWidth` no supera el viewport de
  390 px en Suscripciones, Pagos miembro y vacío. Se verificaron título/escenario,
  rol, formulario abierto y vacío antes de capturar cada variante.
- [x] Revisión de código encontró foco perdido al leer, estado de confirmación
  retenido al cambiar rol y controles inferiores a 44 px; el diseñador los corrigió.
  No se presenta esta revisión como una prueba integral de teclado o de API.
- [x] Scripts y perfiles temporales del renderizado eliminados. Sin cambios en
  `frontend/src`, cuentas o base de datos. No se repitieron builds del producto
  porque solo se añadieron artefactos de diseño y documentación.
- [ ] Aprobación visual del propietario antes del bloque 3, según `AGENTS.md`.
- [ ] Capturas previas del producto autenticado: siguen pendientes de registrar
  antes de cambiar estilos. Las imágenes siguientes representan la propuesta,
  no el estado anterior de la aplicación.

Galería de la propuesta:

| Escenario | Imagen |
|---|---|
| Suscripciones escritorio | [1440 px](../diseno/fase-7/suscripciones-escritorio.png) |
| Pagos familiares escritorio | [1440 px](../diseno/fase-7/pagos-escritorio.png) |
| Familia escritorio | [1440 px](../diseno/fase-7/familia-escritorio.png) |
| Notificaciones escritorio | [1440 px](../diseno/fase-7/notificaciones-escritorio.png) |
| Formulario abierto | [1440 px](../diseno/fase-7/formulario-escritorio.png) |
| Suscripciones móvil | [390 px](../diseno/fase-7/suscripciones-movil.png) |
| Pagos miembro móvil | [390 px](../diseno/fase-7/pagos-movil.png) |
| Lista vacía móvil | [390 px](../diseno/fase-7/vacio-movil.png) |

Tokens elegidos por el diseñador: fondo `#F3F6FA`, superficie `#FFFFFF`, texto
`#1D2B3A`, secundario `#526375`, línea `#D6DFE8` y acento `#006B75`.
El prototipo usa fuente del sistema si Geist no está instalada; no descarga
fuentes. La implementación posterior reutilizará la fuente ya cargada por Next.

## 1. Resultado deseado y límites

En cada pantalla se debe poder responder: «¿dónde estoy?», «¿para qué espacio?»
y «¿qué puedo hacer aquí?». El usuario ha elegido tres vistas para el dashboard;
se mantienen y se organizan mejor. No crear otra portada de estadísticas que
repita las mismas listas ni convertir toda la información en tarjetas iguales.

Incluye `/dashboard`, sus paneles, `/notifications`, `/invitations`, `/login`
y componentes de presentación pequeños. Conserva la landing `/` y su contenido;
los estilos nuevos deben quedar delimitados para no rediseñarla por accidente.

Fuera de alcance: backend, migraciones, jobs, nuevos endpoints, nuevas reglas de
pagos, registro de cuentas desde una nueva UI, perfil, búsqueda global, gráficos,
tema oscuro configurable, monedas, librerías UI y cambios de framework.
Si una pantalla necesita datos que la API no devuelve, se ajusta la propuesta
visual a lo disponible; cualquier ampliación de producto requiere otro alcance.

## 2. Organización de la información

| Destino | Información principal | Acción y contexto |
|---|---|---|
| Suscripciones | Servicios del espacio seleccionado, coste, frecuencia y próxima fecha | «Añadir suscripción» para owner; edición contextual; consulta para miembro |
| Pagos personal | Pendientes primero, historial después | Registrar el importe de un pago u omitir según permisos actuales |
| Pagos familiar | «Mis partes» primero; «Pago del grupo» como contexto separado | Confirmar únicamente la parte propia y consultar desglose |
| Familia | Miembros y rol, entrada/creación de familia y administración | Invitar, introducir código y acciones de gestión según permisos |
| Notificaciones | Eventos propios, lectura y obligación actual | Filtros, marcar leído, abrir pagos del grupo |
| Invitación | Introducir código, revisar familia y aceptar/rechazar | Acceso visible sin requerir una membresía familiar previa |
| Login | Acceso a la aplicación | Mantener flujo actual de sesión y errores |

Reglas de composición:

- Navegación estable con estado activo. En dashboard: Suscripciones, Pagos y
  Familia; enlace independiente a Notificaciones y acceso directo «Tengo un
  código de invitación». Este último lleva a `/invitations` y no depende de
  seleccionar una familia ni de ser owner.
- El selector de espacio es contexto de trabajo, separado de la navegación.
  Mostrar nombre, tipo y rol legible, sin exponer identificadores técnicos.
- Notificaciones mantiene su filtro propio «Todos los espacios» y el grupo
  elegido en ese centro. No hereda silenciosamente el espacio del dashboard al
  compartir la cabecera; solo un enlace explícito aplica contexto.
- Un título principal describe la tarea de la vista activa. Una acción primaria
  por ámbito; botones secundarios y peligrosos claramente diferenciados.
- Listas antes que formularios extensos. «Añadir» abre un formulario en línea
  que puede cerrarse; el estado del formulario conserva la política de borradores
  existente. Las acciones de cada fila pertenecen a esa fila.
- Información frecuente visible; detalle secundario expandible con etiqueta
  explícita. Los controles de transferencia/eliminación no compiten con lectura.
- No fusionar pagos ni notificaciones de tipos distintos para reducir filas:
  son eventos y obligaciones diferentes aunque compartan servicio o fecha.
- No inventar totales de gasto a partir de listas truncadas o páginas. Conservar
  límites visibles, filtros y paginación; no añadir sumas a esta fase.

## 3. Dirección visual propuesta, pendiente de aprobación

Una agenda de servicios recurrentes: nombres, fechas y cantidades fáciles de
recorrer; ritmo de filas y espacio en blanco, con un acento de color reconocible.
El rasgo principal será la jerarquía entre servicio, próxima fecha y acción,
sin ilustraciones decorativas ni una cuadrícula de estadísticas ficticias.

Paleta inicial para los mockups:

| Token | Propuesta | Uso |
|---|---|---|
| Fondo | `#F5F7FA` | Superficie de la aplicación |
| Superficie | `#FFFFFF` | Contenido y formularios |
| Texto | `#18283B` | Títulos y lectura |
| Secundario | `#536276` | Información auxiliar |
| Acento | `#006B75` | Acción principal, selección y foco |
| Separador | `#D5DEE7` | Estructura entre grupos y filas |

Añadir colores semánticos para éxito, advertencia y peligro con contraste
medido en el bloque 2, sin depender únicamente del color. Geist Sans ya cargada
para títulos y cuerpo; cantidades con cifras tabulares, sin convertir toda la
interfaz a monoespaciado. Escala orientativa: 14/16/20/28/36 px; textos auxiliares
de al menos 14 px. Espaciado: 4/8/12/16/24/32/48 px. Alineación a la izquierda;
texto explicativo de hasta unas 75 letras por línea y controles con etiquetas.

El diseñador puede revisar estos valores al crear la propuesta; no son un diseño
aprobado. Usar bordes, radios y elevación por función, no una sombra y tarjeta
para cada dato. Mantener modo claro explícito en las superficies rediseñadas;
probar también con preferencia oscura del sistema para evitar herencias ilegibles.
No cambiar globalmente la landing al introducir tokens.

Boceto de organización, no maqueta aprobada:

```text
Escritorio
┌───────────────────┬──────────────────────────────────────────┐
│ Nombre aplicación │ Espacio: Personal / Familia    Rol       │
│ Suscripciones     ├──────────────────────────────────────────┤
│ Pagos             │ Suscripciones       [Añadir suscripción] │
│ Familia           │ Servicio      Próxima fecha      Coste   │
│ Notificaciones    │ ...                                      │
│ Tengo un código   │ [detalle o formulario solo al solicitar] │
└───────────────────┴──────────────────────────────────────────┘
Móvil
┌────────────────────────────────┐
│ Nombre aplicación              │
│ Suscripciones · Pagos · Familia │
│ Notificaciones · Tengo código  │
│ Espacio y rol                  │
│ Suscripciones         [Añadir] │
│ Servicio, fecha, coste, acción  │
│ ...                            │
└────────────────────────────────┘
```

La propuesta del bloque 2 debe mostrar datos realistas en escritorio y móvil:
Suscripciones, Pagos familiar y Familia, además de un patrón de notificación,
un estado vacío y un formulario. En móvil se priorizan destinos con nombre
visible, sin depender de iconos ni de un menú oculto. Se presenta al propietario
y se espera aprobación antes de ejecutar el bloque 3, por instrucción de
`AGENTS.md` sobre rediseños importantes. Cambios de dirección posteriores
necesitan una propuesta visual actualizada antes de aplicarse.

## 4. Reglas para conservar el funcionamiento

1. Reutilizar `lib/api.ts` y `lib/session.ts`; tokens en memoria, cookie de refresh
   y coordinación existente. No crear un segundo proveedor global de sesión.
2. Conservar rutas, enlaces y parámetros `groupId`/`view`; validar el espacio
   contra membresías activas. Atrás/adelante y enlaces directos deben funcionar.
3. Mantener `hidden`, claves y estados de los paneles hasta comprobar su propósito.
   Un cambio de montaje no puede perder borradores del mismo contexto ni conservar
   datos de un grupo/rol anterior. No convertir la navegación en un cambio de rutas
   ni mover la lógica entre archivos dentro del mismo bloque visual.
4. Conservar recarga al entrar a cada vista, cancelaciones, descarte de respuestas
   antiguas y bloqueo de acciones pendientes. Una nueva envoltura visual no hará
   fetches duplicados ni activará nuevas escrituras.
5. Owner gestiona recursos según contratos actuales; miembro confirma su parte
   hasta la cuota prevista, owner puede superar la propia. Ninguno confirma por
   otra persona. No habilitar controles antes de conocer el permiso actual.
6. NUMERIC sigue como string y DATE como `YYYY-MM-DD`, sin cálculos flotantes ni
   desplazamiento horario. No anteponer un símbolo monetario no definido.
7. Mantener la diferencia entre importe propio y total familiar, leído y resuelto,
   y diferencia de importe y subida de precio. No afirmar cargos bancarios reales.
8. Transferir, retirar miembro, salir, omitir y eliminar conservan validaciones,
   confirmaciones y mensajes actuales. Se mejora su presentación sin cambiar reglas.
9. Código de invitación solo en memoria, una vez para el owner; nunca en URL,
   almacenamiento persistente, logs o capturas compartidas. Conservar aceptación,
   rechazo, expiración y errores sin enumerar cuentas.
10. Nada de SQL, migraciones, inicio del scheduler o generación global para probar
    el diseño. Pruebas de escritura solo con fixtures identificadas y autorizadas.

## 5. Bloques y puntos de parada

Bloque 1 completado con limitación visual registrada; las demás filas pendientes.
Antes: explicar alcance, archivos y concepto.
Después: mostrar resultado, evidencia y límite, actualizar solo su checklist y
detenerse. Si una fila exige cambios grandes de lógica, dividirla antes de editar.

| Bloque | Entrega acotada y archivos principales | Criterio medible para aceptarlo |
|---|---|---|
| 1. Inventario y base | Revisar rutas/paneles, capturas y mapa de acciones; registrar en este plan | Cada acción vigente tiene destino y permiso; capturas reales de 390 y 1440 px o limitación documentada; frontend lint/TypeScript/build como base |
| 2. Propuesta visual | `frontend-designer`: mockups de Suscripciones, Pagos familiar y Familia, patrón de notificación, móvil, vacío y formulario; artefactos enlazados al plan | 6 colores base, tipografía, estados y jerarquía definidos; propietario aprueba propuesta concreta antes de código |
| 3. Fundamentos | Tokens delimitados en `globals.css` y pocos controles en `src/components/ui/` si hay reutilización real | Botón, campo, estado y foco coherentes en una muestra de la vista; landing idéntica; no nuevas dependencias |
| 4. Navegación y contexto | Contenedor presentacional compartido; cabecera del dashboard y accesos a Notificaciones/código | Destino activo inequívoco; introducir código y llegar a Notificaciones en una activación desde dashboard; grupo/rol siempre identificables; enlaces antiguos y borradores conservados |
| 5. Consulta de suscripciones | Lista y jerarquía de datos en `dashboard/page.tsx` | Servicio, coste, frecuencia, fecha y estado distinguibles; una sola lista principal; consulta de miembro sin controles owner |
| 6. Alta y edición | Formulario bajo demanda y acciones de fila en `dashboard/page.tsx` | Abrir, cancelar, validar, guardar y error conservan comportamiento; borrador sobrevive al cambio de vista en el mismo contexto; un envío por acción |
| 7. Pagos personales | Presentación de `payments-panel.tsx` | Pendientes antes de historial; confirmar/omitir igual que antes; estado e importe claros sin columnas ilegibles en móvil |
| 8. Mis partes familiares | Secciones propias en `family-payments-panel.tsx` | Cuota prevista, importe registrado y estado propio separados del total; límite member y excepción owner preservados |
| 9. Pago del grupo y desglose | Resto de `family-payments-panel.tsx` | Progreso y participantes visibles al expandir; no duplicar una obligación como dos pagos; conserva pagos sin parte propia y sus permisos |
| 10. Familia y miembros | Lista, creación y consulta en `family-groups-panel.tsx` | Miembros/roles claros; estado sin familia permite crear o introducir código; una familia se selecciona sin mezclar sus datos con otra |
| 11. Administración familiar | Presentación de renombrar, transferir, retirar y salir en el mismo panel | Acciones peligrosas separadas; confirmaciones y bloqueos intactos; cambio de owner/baja refresca permisos y limpia contexto ajeno |
| 12. Invitaciones completas | `invitations-panel.tsx` y `/invitations/page.tsx`, mismo flujo owner/receptor | Acceso por navegación visible; crear/copiar/ocultar código, revisar, aceptar/rechazar y estados de código inválido/vencido/revocado; sin perder secreto ni incluirlo en URL |
| 13. Notificaciones | `/notifications/page.tsx` con contenedor y patrón de lista aprobado | Mensaje breve, tipo, lectura y obligación diferenciados; filtros, conteo y cargar más funcionan; enlace contextual válido y errores por fila conservados |
| 14. Acceso | Presentación de `/login/page.tsx` | Aspecto coherente y formulario claro; errores, envío, refresh y salida por sesión vencida siguen operativos; no crear otro flujo de autenticación |
| 15. Estados y textos | Ajustes puntuales sobre las vistas ya migradas | Cada carga/vacío/error ofrece información y recuperación útil; términos consistentes; no borrar datos ni borradores por fallo de red |
| 16. Móvil y teclado | Ajustes de composición, foco y controles en componentes/pantallas afectadas | Recorridos a 360, 390, 768 y 1440 px; zoom 200 %; sin desborde horizontal de página ni controles inaccesibles; navegación completa por teclado |
| 17. Regresión de flujos | Matriz de sección 6 con dos cuentas y revisión `reviewer` | Todos los flujos críticos pasan, sin acciones duplicadas ni acceso ajeno; problemas encontrados se resuelven antes del cierre |
| 18. Cierre | Comparación antes/después y evidencia en el plan | Checklist final completo, comprobaciones finales aprobadas y aceptación visual del propietario; registrar mejoras y límites reales |

Dependencia secuencial por defecto. Un archivo tiene un único escritor; no
trabajar en paralelo los bloques 5/6, 8/9 o 10/11. El diseñador presenta y realiza
los cambios visuales autorizados; el principal integra y explica. Después de un
cambio significativo, `reviewer` revisa regresiones, accesibilidad e integración
sin editar. Los subagentes no adelantan bloques ni delegan por su cuenta.

## 6. Comprobaciones y evidencia

### En cada bloque de implementación

- Captura antes/después con datos equivalentes, al menos escritorio y móvil de
  la pantalla tocada. Usar fixtures sin secretos; registrar qué se inspeccionó.
- Lint y TypeScript frontend; build si cambian estructura, imports, layout,
  rutas o APIs de Next. Leer antes la documentación local relevante en
  `frontend/node_modules/next/dist/docs/`, según `frontend/AGENTS.md`.
- Recorrido funcional de las acciones y estados afectados y revisión del diff
  para detectar cambios accidentales en handlers, payloads y permisos.
- Tras un cambio visual significativo, revisión `reviewer` antes de darlo por
  terminado. Un build correcto no demuestra que la vista se vea o funcione bien.

No instalar un framework de pruebas solo para esta fase. Usar navegador si está
disponible; si no, dejar la prueba visual pendiente y dar al propietario pasos
concretos para completarla. No marcarla aprobada por inspeccionar únicamente JSX.
Las pruebas automatizadas nuevas deben cubrir un riesgo concreto, como una
regresión de navegación o un cálculo existente, sin duplicar cadenas CSS.

### Matriz de regresión funcional

| Contexto | Recorrido y resultado que conservar |
|---|---|
| Sin sesión y sesión vencida | Login/refresh actual; no mostrar datos protegidos durante recuperación ni tras un 401 definitivo |
| Personal owner | Consultar, crear, cambiar coste/estado y eliminar suscripción; confirmar/omitir pagos; historial sin pérdida de datos |
| Familia owner/member | Consultar servicios; escritura solo owner; confirmar cuota propia y límites actuales; desglose y pagos sin parte propia |
| Familia administración | Crear/renombrar, invitar, aceptar/rechazar, transferir, retirar/salir; mantener bloqueos por obligaciones pendientes |
| Notificaciones | Solo propias; leer persiste por cuenta; conteo, filtros y páginas; acceso perdido oculta y reingreso restaura con lectura anterior |
| Navegación y borradores | Cambiar vistas recarga; atrás/adelante, enlaces directos y groupId inválido; mismo contexto conserva borradores, cambio de grupo/rol no filtra datos |
| Red lenta o caída | Estado de carga perceptible; reintento funcional; cancelación al cambiar contexto; ningún doble POST ni respuesta antigua sobrescribe el contexto actual |

Las escrituras del recorrido manual usan cuentas/familia/suscripción exclusivas
de prueba, no las suscripciones reales. Si se necesita generar un pago, preparar
primero la fixture y limitar el comando por su UUID; no iniciar un servidor con
scheduler global para hacer comprobaciones casuales. No limpiar datos ajenos.

### Criterios visuales comunes

- Un h1 por pantalla; títulos y nombres de controles consistentes y en español.
- Ubicación, espacio y rol se identifican sin abrir un formulario ni otro destino.
- Contraste medido: texto normal al menos 4.5:1; texto grande y controles 3:1.
  Foco visible, orden de tabulación lógico y estados con texto además de color.
- Controles táctiles de al menos 44 × 44 px; etiquetas asociadas a campos;
  errores asociados y avisos dinámicos anunciados sin duplicarse.
- Disclosure con `aria-expanded`; navegación con estado accesible. Evitar modales
  y menús complejos si un bloque en línea o enlaces visibles bastan. Si el diseño
  aprobado los necesita, incluir Escape, foco inicial, contención y retorno.
- Movimiento reducido respetado; ningún control oculto exclusivamente al hover.
- Nombres largos, listas vacías, múltiples grupos y cifras con decimales no rompen
  la composición. Estados e información importante no dependen de truncamientos.

En el cierre: `pnpm.cmd --dir frontend lint`, `pnpm.cmd --dir frontend exec tsc
--noEmit` y `pnpm.cmd --dir frontend build`. Backend typecheck/build y suite
`RUN_DB_TESTS=1 pnpm.cmd --dir backend test` como regresión final sobre esquemas
aislados; restaurar la variable tras su uso. Registrar conteos actuales, omisiones
y fallos. No reutilizar números de Fase 6 como si fueran una nueva ejecución.
Comprobar `git diff --check`; conservar archivos y cambios ajenos. No dejar
servidores, perfiles de navegador ni scripts temporales del recorrido.

## 7. Reversibilidad y control de alcance

- Cada bloque debe poder revisarse y revertirse de manera independiente con un
  diff pequeño. Sugerir un commit por bloque; no crearlo sin petición del usuario.
- Extraer un componente solo si elimina repetición real y mantiene claras sus
  props. No introducir un motor de formularios ni reescribir los paneles enteros.
- Tokens compartidos se activan gradualmente: revisar todas las vistas que los
  consumen. Separar modificaciones globales y reorganización de cada pantalla.
- Si una comprobación falla, corregir o revertir únicamente los cambios propios
  del bloque y repetir la prueba pertinente antes de avanzar. No usar resets ni
  restauraciones generales de archivos con trabajo ajeno.
- Aprobación visual y permisos de API son controles distintos: la apariencia no
  sustituye comprobaciones del servidor ni concede nuevas facultades.

## 8. Checklist final — pendiente

- [x] Inventario de código y comprobaciones base registrados; capturas previas pendientes para el bloque 2.
- [ ] Propuesta visual desktop/móvil aprobada por el propietario.
- [ ] Navegación y contexto de espacio coherentes; introducir código fácil de encontrar.
- [ ] Suscripciones consultables sin formularios que compitan con la lista.
- [ ] Pagos personales y partes familiares claramente diferenciados.
- [ ] Miembros, administración e invitaciones organizados según tarea y permiso.
- [ ] Notificaciones y login integrados en el mismo lenguaje visual.
- [ ] Sesión, borradores, recargas, enlaces y permisos conservados.
- [ ] Importes string, fechas DATE y límites de las listas conservados.
- [ ] Carga, vacío, error, móvil y teclado inspeccionados en navegador.
- [ ] Dos cuentas completaron los recorridos críticos con fixtures autorizadas.
- [ ] Revisión de cambios sin hallazgos pendientes; checks de cierre registrados.
- [ ] Landing, contratos backend y datos existentes conservados.
- [ ] Comparativa antes/después y aceptación visual del propietario registradas.
- [ ] Sin dependencias innecesarias, artefactos temporales ni trabajo de fases futuras.
