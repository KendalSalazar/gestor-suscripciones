# Navegación y contexto — bloque 4

16 de noviembre de 2026. Se comprobó raíz Git y carpeta antes de editar. Se
conservó el trabajo anterior y se aplicó la propuesta aprobada con #CF7FFF.

| Escenario | Escritorio | Móvil |
|---|---|---|
| Dashboard antes del bloque | [1440](antes-dashboard-1440.png) | [390](antes-dashboard-390.png) |
| Dashboard con contenedor y borrador sin guardar | [1440](dashboard-1440.png) | [390](dashboard-390.png) |
| Familia desde contexto personal | — | [390](familia-personal-390.png) |
| Familia owner | [1440](familia-owner-1440.png) | [390](familia-owner-390.png) |
| Misma familia, miembro | [1440](familia-miembro-1440.png) | [390](familia-miembro-390.png) |
| Foco por Tab en Pagos, tras contexto inválido | — | [390](foco-navegacion-390.png) |
| Dashboard con preferencia oscura | — | [390](dashboard-preferencia-oscura-390.png) |
| Landing para comparar | [1440](landing-1440.png) | [390](landing-390.png) |

Capturas reales de Chrome temporal, escala 1, viewport de 900 px de alto y ancho
CSS indicado, contenido completo. Preferencia clara salvo la captura oscura.
Indicador de desarrollo de Next oculto solo para capturar. Se inspeccionaron
las imágenes principales de dashboard y Familia de ambos roles y anchos; no
se presenta este recorrido como una auditoría completa de móvil/teclado.

Comprobaciones realizadas en navegador:

- Título y botón activo cambian con Suscripciones/Pagos/Familia. Los tres
  paneles siguen montados; el borrador sobrevive al cambio de vista y se limpia
  al seleccionar otro grupo.
- La entrada a cada vista mantiene su recarga. Al volver a Suscripciones se
  observaron GET de grupos y suscripciones, igual que antes del contenedor.
- Notificaciones se abre con una activación y conserva todos los espacios como
  filtro inicial. Familia → entrada de código se abre con dos activaciones,
  tanto desde personal como con owner/miembro. Ningún enlace global duplica
  la entrada al código. No se introdujo ni resolvió un código.
- Enlace directo a Pagos de familia: contexto y rol correctos. `groupId` inválido:
  vuelta al personal, limpieza de parámetros y aviso. Atrás/adelante recupera
  esos contextos. Los botones del dashboard siguen usando el estado existente.
- Navegación a 390 px: cuatro controles de 46.5 px de alto; ancho de página
  medido sin superar el viewport. Tab pasa de Suscripciones a Pagos y muestra
  foco violeta sólido de 3 px. No se verificó todavía el recorrido de todos los
  controles de cada panel ni zoom 200 % (bloque 16).
- Miembro en familia compartida: cabecera «Miembro», código disponible y sin
  campo de renombrado de owner. Owner: cabecera «Responsable».
- Preferencia oscura: dashboard usa superficie #F3F6FA y `color-scheme: light`.
  Las pantallas de acceso/error fuera del contenedor siguen en sus bloques.
- Landing: las PNG de ambos anchos son idénticas por SHA-256 a las capturas
  de `estado-inicial/`, bajo las mismas condiciones de captura.

Frontend lint y TypeScript aprobados por el diseñador; build de producción
aprobado por el principal; reviewer sin hallazgos nuevos. La revisión mantiene
separados los cambios previos del bloque 3. Sin dependencias nuevas, backend,
contratos, lógica de sesión, migraciones o escrituras de producto.

La API temporal se inició directamente desde Express para evitar scheduler y
migraciones; frontend/API cerrados tras comprobar. Ambas sesiones se cerraron;
perfil y script temporal eliminados. Ninguna contraseña se guardó en archivos.

Aviso existente observado en consola: los dos paneles hermanos de Familia
owner comparten key en el código anterior. Se conserva aquí y se registra para
corregirlo al migrar Familia/Invitaciones, comprobando sus borradores y montaje.
No se considera resuelto por estas capturas.
