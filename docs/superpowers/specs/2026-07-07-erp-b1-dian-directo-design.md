# ERP Fase B1 · Facturación electrónica DIAN directa (software propio)

> Spec para aprobación antes de codear. Módulo: `einvoicing` (slug ya en
> el catálogo con `shipped: false`). Decisión de producto (2026-07-07):
> integración DIRECTA con la DIAN en modo "software propio" (gratuito) —
> sin proveedor tecnológico (descartados Factus/Alegra/Matías) — al
> estilo del módulo `l10n_co_dian` de Odoo que el dueño trajo como
> referencia.
>
> **Licencia**: los módulos de referencia (carpeta `modulos odoo/`, NO
> versionada — está en .gitignore) son OEEL-1 (propietaria de Odoo). NO
> se copia ni porta código: la implementación sale del **Anexo Técnico
> de Factura Electrónica de Venta v1.9** (público, dian.gov.co) y de la
> documentación pública de los web services. La carpeta sirve solo como
> referencia de comportamiento (qué configura el comercio, secuencia del
> flujo).

## Objetivo

Que un comercio colombiano facture electrónicamente **directo contra la
DIAN** desde MESAPAY: sube su certificado digital, pone las credenciales
del portal DIAN, pasa la habilitación (set de pruebas) desde la propia
UI, y desde ahí cada factura sale como XML UBL firmado con CUFE y QR,
validada por la DIAN y enviada al cliente por correo.

## Qué configura el comercio (la pregunta del dueño)

1. **Certificado digital de firma** — archivo `.p12` + contraseña,
   comprado a una CA autorizada (Certicámara, GSE, Andes SCD; ~$150-400
   mil COP/año). Firma el XML y autentica el canal con la DIAN. Este es
   "el archivo".
2. **Software ID + PIN** — se generan en el portal DIAN al registrarse
   como facturador con software propio.
3. **Set de pruebas (TestSetId)** — del portal DIAN, para la habilitación.
4. **Resolución de numeración + clave técnica** — del portal DIAN
   (prefijo/rango/vigencia ya viven en `LegalEntity`; falta la **clave
   técnica**, que entra al CUFE).
5. Ambiente: habilitación (`vpfe-hab.dian.gov.co`) / producción
   (`vpfe.dian.gov.co`).

## Flujo técnico (Anexo Técnico 1.9)

1. **UBL 2.1** con perfil DIAN (`DianExtensions`: software provider,
   security code, autorización de numeración; `ProfileExecutionID` 1=prod
   2=hab).
2. **CUFE** = SHA-384 de la concatenación (número, fecha, hora con TZ,
   subtotal, códigos/valores de IVA-01, INC-04, ICA-03, total, NIT
   emisor, identificación adquirente, **clave técnica**, ProfileExecutionID).
   Nota crédito usa CUDE (misma mecánica con el PIN en vez de la clave).
3. **Firma XAdES-EPES** del XML con el certificado (política de firma
   DIAN, SHA-256).
4. ZIP → **SOAP con WS-Security** (BinarySecurityToken = el mismo
   certificado, firma del Timestamp) a `WcfDianCustomerServices.svc`:
   - Habilitación: `SendTestSetAsync` + `GetStatusZip` (asíncrono).
   - Producción: `SendBillSync` + `GetStatus`.
   - Consulta: `GetXmlByDocumentKey`.
5. **ApplicationResponse** de la DIAN (aceptado/rechazado con reglas
   `FAD`/`ZB`…); **QR** = URL `catalogo-vpfe[-hab].dian.gov.co/document/
   searchqr?documentkey={cufe}`.
6. **AttachedDocument** (XML factura + respuesta DIAN) → correo al
   cliente junto con la representación gráfica (nuestra tirilla/PDF, que
   gana CUFE + QR).

## Decisiones de diseño

### D1. Emisor = LegalEntity o Restaurant (mismo criterio que numeración)

`DianConfig` 1:1 con el emisor (`legalEntityId` XOR `restaurantId`,
como la numeración DIAN existente): certificado `.p12` **encriptado at
rest** (AES-256-GCM con secret del server — nunca en texto plano, nunca
al cliente), contraseña encriptada, softwareId, softwarePin (encriptado),
technicalKey, testSetId, environment, estado de habilitación
(`pending | testing | enabled`), y vigencia del certificado (derivada,
con aviso de vencimiento).

### D2. `DianDocument` por factura — el tracking es la verdad

Estado (`to_send | sent | pending | accepted | rejected | error`), CUFE,
XML firmado (comprimido), ApplicationResponse, trackId/zipKey, errores
parseados. La factura simple existente (`SimpleInvoice`) se mantiene como
representación gráfica y gana `dianDocumentId`; con el módulo apagado
todo sigue como hoy.

### D3. Crypto en Node, sin SaaS

`node-forge` para el `.p12`; firma XMLDSig/XAdES-EPES propia (canonical-
ización C14N exclusiva + digests + política DIAN) — es la parte más
delicada y va con sanity exhaustivo contra los ejemplos del anexo
técnico. SOAP construido como plantilla (sin librería SOAP pesada).

### D4. Habilitación desde la UI

Wizard en configuración: subir certificado → credenciales → botón
"Correr set de pruebas" (emite los documentos del set contra
habilitación — facturas + notas crédito — y consulta estado con
progreso) → al aprobar la DIAN, pasar a producción (un click). Estado
visible siempre.

### D5. Emisión integrada al flujo actual

Donde hoy se emite la factura simple (solicitud del comensal / operador):
con `einvoicing` activo y habilitado, se construye el UBL desde el
snapshot de la orden (IVA/impoconsumo según `taxCents` y configuración
fiscal del comercio), se firma, se envía `SendBillSync`, y la tirilla/
página pública/email ganan CUFE + QR + AttachedDocument adjunto. Rechazo
de la DIAN ⇒ la factura queda en estado rechazado con los errores
legibles y botón reintentar (la venta NUNCA se bloquea por la DIAN).
**Nota crédito** para anulaciones desde el detalle de la factura.

### D6. Fuera de alcance

CFDI México (fase aparte). Documento soporte, nómina electrónica,
eventos RADIAN (acuse/reclamo del receptor). Contingencia tipo 03.
Multi-moneda (COP only).

## Entrega (7 PRs)

1. Schema (`DianConfig`, `DianDocument`) + crypto base: p12, cifrado at
   rest, XAdES-EPES, CUFE/CUDE, QR — sanity contra vectores del anexo.
2. Builder UBL 2.1 factura de venta desde Order (+ validación local).
3. Cliente SOAP (WS-Security) + máquina de estados de `DianDocument`.
4. Nota crédito UBL + anulación.
5. UI configuración + wizard de habilitación — subagente.
6. Integración con el flujo de factura (tirilla/QR/email) — subagente.
7. Flip `einvoicing.shipped = true` + verificación integral.

## Criterios de aceptación

1. CUFE de los vectores del anexo técnico calza byte a byte; el XML
   firmado pasa validación de firma independiente.
2. Con credenciales de habilitación reales del comercio: el set de
   pruebas corre desde la UI y la DIAN lo aprueba.
3. Factura de venta en producción: aceptada por la DIAN, con CUFE + QR
   en tirilla/página/email y AttachedDocument adjunto.
4. Rechazo DIAN ⇒ estado + errores legibles + reintento; la venta no se
   bloquea. Nota crédito acredita una factura aceptada.
5. Certificado por vencer (≤30 días) ⇒ aviso. Módulo apagado ⇒ todo
   como hoy. Trilingüe en paridad.

## Riesgos honestos

Es la fase más pesada del ERP. La habilitación depende de la DIAN y de
credenciales/certificado reales del comercio — el criterio 2 no se puede
verificar sin ellos (se probará con el NIT del dueño en habilitación).
XAdES/C14N es quisquilloso: presupuestar iteración contra el validador
de la DIAN.
