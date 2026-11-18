# Comprobaciones del bloque 3

16 de noviembre de 2026. Referencia previa en [estado inicial](../estado-inicial/README.md).
Esta entrega cambia únicamente la presentación del alta existente.

| Evidencia real | Capturas |
|---|---|
| Muestra del alta, owner personal | [1440](personal-owner-1440.png), [390](personal-owner-390.png) |
| Foco por teclado en Proveedor | [390](foco-390.png) |
| Botón bloqueado durante envío simulado | [390](envio-simulado-390.png) |
| Alerta tras fallo simulado | [1440](error-simulado-1440.png), [390](error-simulado-390.png) |
| Muestra con preferencia oscura | [390](muestra-preferencia-oscura-390.png) |
| Miembro de la misma familia sin alta ni controles owner | [390](suscripciones-miembro-390.png) |
| Landing para comparar | [1440](landing-1440.png), [390](landing-390.png) |

Los anchos son píxeles CSS con escala 1 y viewport de 900 px de alto; captura
de página completa. Navegador temporal y mismas condiciones que la referencia.
Las dos PNG de landing tienen exactamente el mismo SHA-256 que las previas.

Comprobado en navegador: Geist aplicada solo a la muestra; botón con fondo
rgb(207, 127, 255) y texto rgb(17, 16, 24); campos de 45–46 px y botón de 44 px;
viewport y ancho de página de 390 px; foco visible de 3 px rgb(120, 38, 158) con
separación de 3 px. La validación HTML vacía enfoca Nombre. Tab pasa a Proveedor;
el botón también conserva foco visible. No es una auditoría completa de teclado.

Se introdujo un borrador, se abrió Pagos y se volvió: los datos permanecieron.
Para comprobar espera/error se sustituyó temporalmente `fetch` en esa página,
rechazando únicamente el POST de suscripción después de una espera. Se observó
un intento interceptado, botón `disabled` con «Guardando…», alerta `role=alert`,
botón rehabilitado y borrador conservado. La petición no llegó al backend y no
se creó una suscripción. La sustitución se retiró antes de cerrar la sesión.
Estas capturas de error y espera representan una simulación explícita de red;
no demuestran un guardado exitoso ni un fallo real del servidor.

Con preferencia oscura, la muestra conserva superficie blanca, texto oscuro y
`color-scheme: light`. La cabecera y otras zonas anteriores todavía muestran
el problema global de contraste ya registrado: su migración sigue pendiente.

Lint y TypeScript aprobados por el diseñador, build de producción aprobado por
el principal; revisión de código sin hallazgos por `reviewer`. Sin dependencias
nuevas, backend, migraciones o cambios de contratos. Script y perfil temporal
eliminados, sesiones cerradas. Las imágenes de arriba permanecen como evidencia.
