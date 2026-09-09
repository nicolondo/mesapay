# MESAPAY

Plataforma de operación de restaurantes: carta y pedidos por QR, caja y pagos, reservas, inventario, facturación e impresión. Next.js 16, React 19, PostgreSQL y Prisma 6. Importes internos en centavos enteros; país y moneda se definen por comercio, e idioma por sesión.

## Desarrollo local

Requiere Node.js 22+, npm y PostgreSQL. Configura una base **local desechable** en `.env` con `DATABASE_URL` y un `AUTH_SECRET` propio. No copies credenciales productivas para desarrollar.

```sh
npm ci
npm run db:migrate
npm run dev
```

La aplicación se abre en `http://localhost:3300`. `npm run db:seed` carga datos de demostración: úsalo solamente en una base local de pruebas. Los conectores externos requieren su configuración; un proveedor simulado no debe registrar pagos operativos.

## Comprobaciones

```sh
npm test
npm run lint
npx tsc --noEmit
npm run build
```

Las pruebas de PostgreSQL exigen una URL explícita de localhost y una base cuyo nombre cumpla `mesapay_*test` o `mesapay_*validation`. No limpian tablas completas: crean y eliminan sus propios fixtures.

```sh
DATABASE_URL=postgresql://usuario@127.0.0.1:5548/mesapay_local_test npm run db:migrate
DATABASE_URL=postgresql://usuario@127.0.0.1:5548/mesapay_local_test npm run test:integration
```

Cubren reservas concurrentes de pagos, reintentos, webhooks, devoluciones, descuentos, inventario e invalidación de sesiones. `e2e/README.md` documenta las comprobaciones de navegador. La integración continua ejecuta pruebas, lint, migraciones sobre PostgreSQL aislado y build.

## Operación

- [Despliegue blue/green](vps/blue-green/SETUP.md). Se usa `prisma migrate deploy`; no se acepta pérdida automática de datos. Las instalaciones anteriores con `db push` necesitan verificar y adoptar el baseline antes de desplegar.
- [Auditoría y hallazgos originales](docs/auditoria-plataforma-2026-09-08.md).
- [Estado de la integración y validación](docs/estado-integracion-codex-2026-09-09.md).
- [Agente de impresión Windows](agent/README.md).

Un timeout de pago conserva el saldo reservado. Los operadores pueden conciliar desde el detalle del pedido después de verificar estado e importe con Kushki; la evidencia queda registrada en auditoría. Esa acción no solicita dinero ni ejecuta devoluciones. El cron de consumo recupera inventario pendiente, programa reintentos y señala operaciones financieras antiguas sin resultado confirmado.
