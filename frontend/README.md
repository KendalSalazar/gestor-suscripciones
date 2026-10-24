This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Dashboard personal — Fase 4, bloque 8

El dashboard conserva el formulario y listado de suscripciones, y añade pagos
pendientes e historial. Cada listado tiene sus estados de carga, vacío, error y
reintento; un fallo de suscripciones permite seguir consultando los pagos.

`src/app/dashboard/page.tsx` obtiene el perfil y grupo personal, carga las
suscripciones y permite editar explícitamente su coste esperado. Si un DELETE
devuelve `409` por historial de pagos, explica que se puede desactivar el servicio.
Cambiar el coste afecta a pagos que se generen después y conserva los existentes.

`src/app/dashboard/payments-panel.tsx` consulta los pendientes por separado.
Para el historial combina confirmados y omitidos, ordena por fecha e identificador
descendentes y muestra hasta 100. Confirmar abre un formulario con el importe
esperado; omitir pide confirmación. Tras una resolución o un conflicto `409`,
vuelve a consultar las listas. Las diferencias de importe se destacan en el historial.
Los importes se editan y envían como strings y las fechas de pagos conservan
`YYYY-MM-DD`.

`apiWithSession` en `src/lib/api.ts` reutiliza `api` y `refreshSession`: reintenta
un `401` una sola vez y coordina el refresh entre peticiones simultáneas. El
access token continúa en memoria y la cookie httpOnly permite recuperar la
sesión al recargar. El contrato del backend está en [la documentación de pagos](../backend/docs/payments.md).

### Comprobar el bloque

Desde la raíz, ejecutar `pnpm --dir frontend lint`,
`pnpm --dir frontend exec tsc --noEmit` y `pnpm --dir frontend build`.
El build utiliza las fuentes Google Fonts existentes y necesita poder descargarlas.

Con backend y frontend activos, usar una cuenta y suscripción de prueba con
pagos generados mediante el procedimiento del bloque 4:

1. Iniciar sesión y comprobar los listados de suscripciones, pendientes e historial.
2. Confirmar un pago con su importe esperado y otro con un importe diferente; comprobar la marca y que el coste de la suscripción se conserva.
3. Cancelar una omisión y después aceptarla; revisar que el pago pase al historial.
4. Editar el coste de la suscripción y comprobar que los importes esperados del historial se conservan.
5. Intentar borrarla, leer la explicación del historial y desactivarla.
6. Recargar y comprobar sesión, importes y estados. Revisar también el ancho móvil.

Verificación realizada: lint, TypeScript y build correctos, y revisión sin hallazgos.
Se recorrió el flujo en Chrome con frontend de producción, API y PostgreSQL reales.
También se comprobaron fallos simulados de cada listado, `409` por un pago resuelto
desde otro proceso, `401` simultáneos con refresh compartido, bloqueo de acciones
durante envío y ausencia de tokens en localStorage/sessionStorage. Los datos de
prueba se crearon con UUID exclusivos y se limpiaron al finalizar; la prueba
arrancó la aplicación Express sin ejecutar el scheduler global.
