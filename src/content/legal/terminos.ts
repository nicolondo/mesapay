/**
 * Términos de servicio de MESAPAY (contrato comercio–MESAPAY, con una
 * sección corta para los comensales).
 *
 * Markdown reducido (ver `src/lib/help/markdown.ts`). El español es la
 * fuente; inglés y portugués son traducciones fieles y tienen las mismas
 * secciones (`legal.test.ts` lo exige). Sin HTML, sin enlaces externos: el
 * correo de contacto va como texto.
 */
import type { LegalDocument } from "./types";

const es = `
Estos términos regulan el uso de MESAPAY, la plataforma con la que un restaurante recibe pedidos y pagos desde la mesa por código QR, administra su comanda, su equipo, sus reservas, su facturación y los demás módulos que active. Son el contrato entre MESAPAY y el comercio que crea una cuenta, e incluyen una sección breve para los comensales que usan la plataforma en un restaurante. Léelos con calma: al crear la cuenta o usar el servicio los aceptas.

## Quiénes somos y aceptación

El servicio lo presta MESAPAY, con domicilio en Colombia. El canal de contacto para cualquier asunto de estos términos es el correo info@mesapay.co.

Aceptas estos términos al crear una cuenta de comercio, al usar el servicio o al permitir que tu equipo lo use. Quien crea la cuenta declara que tiene facultades para obligar al comercio. Si no estás de acuerdo con alguna parte, no uses el servicio.

## Definiciones

- **MESAPAY** o **la plataforma**: el software, las pantallas, las aplicaciones web, las integraciones y los servicios asociados que prestamos.
- **Comercio**: el restaurante, bar o negocio de comida que contrata el servicio, incluidas sus sedes.
- **Usuarios del comercio**: las personas a las que el comercio da acceso: dueños, administradores, meseros, cocina, caja y demás roles.
- **Comensal**: la persona que escanea un QR, consulta la carta, pide, paga, reserva o crea una cuenta en un comercio.
- **Pasarela**: Kushki, la empresa que procesa los pagos con tarjeta, PSE, Apple Pay y otros medios en línea.
- **Plan**: el conjunto de módulos y límites contratados y su precio.

## La cuenta del comercio y sus usuarios

El comercio registra su cuenta con datos veraces y los mantiene actualizados, en especial su razón social, NIT, dirección, correo de contacto y datos fiscales. Cada persona del equipo entra con su propio usuario y contraseña; el comercio decide qué rol tiene cada uno y es responsable de todo lo que se haga con las cuentas que crea. Las credenciales son personales: no deben compartirse ni prestarse. Si sospechas un acceso no autorizado, cambia la contraseña y escríbenos.

El comercio puede tener varias sedes; cada sede es una cuenta con sus propios datos. MESAPAY puede verificar la identidad y la información legal del comercio antes de activar módulos como los pagos en línea o la facturación electrónica.

## Planes, mensualidad y pago

- **Prueba gratis**: el comercio puede probar el servicio durante el periodo gratuito vigente al momento del registro, sin tarjeta. Al terminar, para seguir usando la plataforma debe elegir un plan.
- **Precio**: el plan se cobra por mensualidad, en pesos colombianos, según los precios vigentes publicados o los acordados por escrito con el comercio. Los precios no incluyen los impuestos que la ley exija ni las comisiones de la pasarela por los pagos de los comensales.
- **Débito automático**: la mensualidad se cobra por débito automático a la tarjeta o cuenta que el comercio registra para ese fin, a través de la pasarela. El comercio autoriza ese cobro recurrente al registrar el medio de pago y puede cambiarlo desde su panel. Cuando un cobro no se puede realizar, lo intentamos de nuevo y avisamos por correo.
- **Mora y suspensión**: si una mensualidad no se paga después de los intentos de cobro y del aviso, MESAPAY puede suspender el acceso al servicio hasta que se regularice. Durante la suspensión el comercio conserva sus datos, pero el equipo no puede operar con la plataforma. La suspensión no exime de pagar lo adeudado.
- **Cambios de plan**: el comercio puede subir o bajar de plan; el nuevo precio aplica desde el siguiente periodo.
- **Cancelación**: el comercio puede cancelar en cualquier momento desde su panel o escribiendo a info@mesapay.co. El servicio sigue activo hasta el final del periodo ya pagado. No se reembolsan periodos ya cobrados, salvo que la ley disponga otra cosa o que MESAPAY haya incumplido el servicio.
- **Cambios de precio**: podemos cambiar los precios avisando con al menos treinta (30) días de anticipación por correo o en el panel. Si no estás de acuerdo, puedes cancelar antes de que el nuevo precio aplique.

## Pagos de los comensales

- MESAPAY no es una entidad financiera ni una pasarela de pagos. Los pagos en línea de los comensales los procesa Kushki bajo el contrato que el comercio celebra directamente con Kushki para abrir su cuenta de cobro. La plataforma integra ese servicio y registra el resultado de cada pago.
- El dinero de las ventas lo recibe y lo liquida Kushki al comercio, en los plazos, condiciones y tarifas de ese contrato. MESAPAY no custodia fondos de los comensales ni responde por los tiempos de liquidación de la pasarela o de los bancos.
- Los datos de las tarjetas nunca pasan por MESAPAY: la pasarela los tokeniza. Las comisiones por transacción las fija la pasarela y, si el plan lo contempla, MESAPAY puede cobrar una comisión adicional informada en el plan.
- **Disputas y contracargos**: los reclamos de los titulares de tarjeta, las devoluciones y los contracargos se resuelven entre el comercio, Kushki y la entidad emisora. MESAPAY entrega los registros del pedido y del pago que tenga para apoyar al comercio, pero no asume el valor de los contracargos ni decide sobre ellos.
- Los pagos en efectivo, con datáfono del comercio u otros medios registrados manualmente son responsabilidad del comercio; la plataforma sólo los anota.
- El comercio debe cumplir las reglas de la pasarela y de las franquicias, y no usar la plataforma para cobros que no correspondan a una venta real de su negocio.

## Facturación electrónica

- El comercio es el emisor de sus facturas y el responsable de sus obligaciones tributarias. Debe cargar y mantener vigentes su resolución de numeración de la DIAN, su certificado de firma, su régimen, sus impuestos y los datos de su RUT, y configurar correctamente los impuestos de su carta.
- MESAPAY genera las facturas y notas crédito electrónicas con los datos que el comercio configuró y las transmite a la DIAN. Si la DIAN rechaza un documento por datos incorrectos, el comercio debe corregirlos; la plataforma muestra el motivo del rechazo.
- MESAPAY no responde por sanciones, intereses o rechazos derivados de datos fiscales incompletos o errados, de resoluciones vencidas o de cambios normativos que el comercio no haya atendido. Tampoco presta asesoría tributaria.
- Las facturas a nombre de un comensal se emiten con los datos que el comensal escribe; el comercio puede corregirlas con una nota crédito cuando la ley lo permita.

## Propinas

La propina es voluntaria y la decide el comensal. La plataforma la sugiere y la registra según lo que el comercio configure, conforme a la Ley 1935 de 2018 y las normas que la complementen. El comercio es el único responsable de administrarla y distribuirla entre su equipo como la ley exige; MESAPAY sólo la registra y la reporta.

## Datos personales y confidencialidad

- El tratamiento de los datos personales se rige por la [Política de privacidad](/privacidad). Para los datos de los comensales y del equipo que el comercio registra, el comercio es el responsable del tratamiento y MESAPAY actúa como encargado por cuenta de él. El comercio debe contar con las autorizaciones que exige la Ley 1581 de 2012 y usar los datos de sus clientes sólo para atender la relación con ellos.
- Ambas partes mantienen confidencial la información no pública que conozcan por el servicio: MESAPAY, los datos de operación del comercio; el comercio, las condiciones comerciales y la información técnica de la plataforma. Esta obligación sigue vigente después de terminar el contrato.
- MESAPAY puede usar datos agregados y anónimos de uso para operar y mejorar el producto.

## Propiedad intelectual

La plataforma, su código, su diseño, sus marcas y su documentación son de MESAPAY o de sus licenciantes. El comercio recibe una licencia limitada, no exclusiva e intransferible para usar la plataforma mientras tenga una cuenta activa. No se permite copiarla, modificarla, descompilarla, revenderla ni usarla para construir un producto equivalente.

El contenido que el comercio carga (carta, fotos, nombre, logo y textos) es suyo. El comercio autoriza a MESAPAY a mostrarlo a sus comensales, a traducirlo a otros idiomas y a procesarlo para prestar el servicio, y garantiza que tiene derecho a usarlo.

## Asistente de inteligencia artificial

La plataforma incluye un asistente que responde preguntas sobre los datos del comercio usando modelos de inteligencia artificial de un proveedor externo. Sus respuestas son orientativas: pueden contener errores, omisiones o interpretaciones inexactas y no sustituyen la revisión de un contador, un asesor financiero o un abogado. El comercio debe verificar la información antes de tomar decisiones con base en ella. Al usar el asistente, el comercio acepta que los datos necesarios para responder se envíen al proveedor del modelo, como se describe en la Política de privacidad.

## Disponibilidad, mantenimiento y copias de seguridad

- Trabajamos para que la plataforma esté disponible de forma continua, pero no garantizamos una disponibilidad del cien por ciento. Puede haber interrupciones por mantenimiento, actualizaciones, fallas de proveedores, de redes o de equipos del comercio, o causas fuera de nuestro control.
- Los mantenimientos programados se avisan con anticipación cuando es posible, preferiblemente en horarios de baja operación.
- Hacemos copias de seguridad diarias de la base de datos y las conservamos durante siete (7) días. Esas copias sirven para recuperar la plataforma ante un incidente, no para restaurar datos que un usuario del comercio borró a propósito. El comercio puede exportar sus propios datos desde el panel y le recomendamos hacerlo periódicamente.
- El comercio es responsable de su conexión a internet, de sus equipos (tablets, celulares, impresoras) y de mantener un procedimiento alterno para seguir atendiendo si la plataforma no está disponible.

## Obligaciones del comercio

El comercio se compromete a:

- Usar la plataforma sólo para la operación lícita de su negocio y cumplir las normas que le apliquen, incluidas las de protección al consumidor, sanitarias, laborales y tributarias.
- Publicar una carta veraz: nombres, descripciones, precios, impuestos, alérgenos y disponibilidad reales. Los precios que ve el comensal son los que el comercio cobra.
- Atender los pedidos y las reservas que acepta, y resolver directamente con sus clientes las quejas sobre la comida, el servicio o la atención.
- Registrar los datos de sus clientes y empleados con las autorizaciones que exige la ley y no cargar datos sensibles.
- No intentar vulnerar la seguridad de la plataforma, no acceder a datos de otros comercios ni usar herramientas automáticas que la sobrecarguen.
- Pagar la mensualidad y los demás cargos del plan.

## Límites de responsabilidad

- En la medida en que la ley lo permita, MESAPAY no responde por daños indirectos, lucro cesante, pérdida de ventas, de datos o de reputación derivados del uso o de la imposibilidad de usar la plataforma.
- La responsabilidad total de MESAPAY frente al comercio por cualquier reclamo relacionado con el servicio se limita al valor de las mensualidades que el comercio pagó en los doce (12) meses anteriores al hecho que lo originó.
- MESAPAY no responde por los servicios de terceros integrados (pasarela de pagos, DIAN, proveedores de correo, bancos, inteligencia artificial, impresoras o redes), ni por decisiones que el comercio tome con base en reportes, proyecciones o respuestas del asistente.
- La relación de consumo por la comida y el servicio en el restaurante es entre el comercio y el comensal. MESAPAY es el proveedor de la herramienta, no el vendedor de los productos.
- Nada en estos términos limita la responsabilidad que la ley colombiana no permita limitar.

## Terminación y exportación de datos

- Cualquiera de las partes puede terminar el contrato en cualquier momento. El comercio, cancelando su plan; MESAPAY, avisando con al menos treinta (30) días de anticipación, o de inmediato si el comercio incumple estos términos, usa la plataforma para actividades ilícitas, pone en riesgo su seguridad o incurre en mora prolongada.
- Al terminar, el comercio tiene treinta (30) días para exportar sus datos desde el panel o pedirlos a info@mesapay.co. Después de ese plazo podemos eliminarlos, salvo los registros que debamos conservar por obligación legal, contable o tributaria, que se guardan por los plazos indicados en la Política de privacidad.
- La terminación no exime de pagar lo adeudado hasta la fecha efectiva.

## Para comensales

Si pides, pagas o reservas en un restaurante que usa MESAPAY:

- La compra de la comida y el servicio es un contrato entre tú y el restaurante. MESAPAY sólo pone la herramienta para pedir y pagar; las quejas sobre los platos o la atención se resuelven con el restaurante.
- Revisa tu pedido antes de enviarlo: una vez que la cocina lo recibe, el restaurante puede no aceptar cambios. Los precios, impuestos y la propina sugerida se muestran antes de confirmar; la propina es voluntaria.
- Los pagos en línea los procesa Kushki y tus datos de tarjeta no pasan por MESAPAY. Si tienes un problema con un cobro, escríbele primero al restaurante; también puedes acudir a tu banco.
- Puedes pedir una factura a tu nombre escribiendo tus datos; es tu responsabilidad que sean correctos.
- Crear una cuenta es opcional y sirve para que el restaurante te reconozca, aplique tu descuento y te muestre tus pedidos. La cuenta es de ese restaurante. Tus datos se tratan según la [Política de privacidad](/privacidad).
- No uses la plataforma para hacer pedidos falsos, cargar contenido ofensivo o intentar vulnerar su seguridad.

## Ley aplicable y resolución de conflictos

Estos términos se rigen por las leyes de la República de Colombia. Ante cualquier diferencia, las partes intentarán primero resolverla directamente, escribiendo a info@mesapay.co, dentro de los treinta (30) días siguientes al reclamo. Si no hay acuerdo, podrán acudir a la conciliación o a los jueces competentes en Colombia. Nada de esto limita los derechos que tengan los consumidores conforme a la Ley 1480 de 2011.

## Cambios a estos términos

Podemos modificar estos términos cuando cambie el servicio, nuestros proveedores o la ley. Los cambios relevantes se avisan por correo al comercio o en el panel con al menos quince (15) días de anticipación; los demás se publican en esta página con su fecha de actualización. Si sigues usando el servicio después de la fecha en que un cambio entra en vigor, lo aceptas. Si no estás de acuerdo, puedes cancelar antes de esa fecha.

## Contacto

Para cualquier pregunta, notificación o reclamo relacionado con estos términos escribe a info@mesapay.co. Estos términos están disponibles en español, inglés y portugués; si hay diferencias entre las versiones, prevalece la versión en español. Consulta también la [Política de privacidad](/privacidad).
`.trim();

const en = `
These terms govern the use of MESAPAY, the platform with which a restaurant receives orders and payments from the table through a QR code and manages its kitchen tickets, its team, its bookings, its invoicing and the other modules it turns on. They are the contract between MESAPAY and the restaurant that creates an account, and they include a short section for the guests who use the platform at a restaurant. Read them carefully: by creating the account or using the service you accept them.

## Who we are and acceptance

The service is provided by MESAPAY, domiciled in Colombia. The contact channel for any matter regarding these terms is the email address info@mesapay.co.

You accept these terms by creating a restaurant account, by using the service or by allowing your team to use it. Whoever creates the account declares that they have the authority to bind the restaurant. If you do not agree with any part, do not use the service.

## Definitions

- **MESAPAY** or **the platform**: the software, screens, web applications, integrations and associated services we provide.
- **Restaurant**: the restaurant, bar or food business that contracts the service, including its locations.
- **Restaurant users**: the people the restaurant gives access to: owners, administrators, waiters, kitchen, cashier and other roles.
- **Guest**: the person who scans a QR code, browses the menu, orders, pays, books a table or creates an account at a restaurant.
- **Gateway**: Kushki, the company that processes payments by card, PSE, Apple Pay and other online methods.
- **Plan**: the set of modules and limits contracted and its price.

## The restaurant account and its users

The restaurant registers its account with truthful data and keeps it up to date, especially its legal name, tax ID (NIT), address, contact email and tax details. Each team member signs in with their own user and password; the restaurant decides each person's role and is responsible for everything done with the accounts it creates. Credentials are personal: they must not be shared or lent. If you suspect unauthorized access, change the password and write to us.

The restaurant may have several locations; each location is an account with its own data. MESAPAY may verify the restaurant's identity and legal information before activating modules such as online payments or electronic invoicing.

## Plans, monthly fee and payment

- **Free trial**: the restaurant may try the service during the free period in force at the time of registration, without a card. When it ends, the restaurant must choose a plan to keep using the platform.
- **Price**: the plan is charged monthly, in Colombian pesos, according to the published prices in force or those agreed in writing with the restaurant. Prices do not include the taxes required by law or the gateway's fees for guests' payments.
- **Automatic debit**: the monthly fee is charged by automatic debit to the card or account the restaurant registers for that purpose, through the gateway. The restaurant authorizes that recurring charge when it registers the payment method and may change it from its panel. When a charge cannot be made, we retry it and notify by email.
- **Arrears and suspension**: if a monthly fee is not paid after the charge attempts and the notice, MESAPAY may suspend access to the service until it is settled. During the suspension the restaurant keeps its data, but the team cannot operate with the platform. Suspension does not exempt the restaurant from paying what is owed.
- **Plan changes**: the restaurant may upgrade or downgrade its plan; the new price applies from the next period.
- **Cancellation**: the restaurant may cancel at any time from its panel or by writing to info@mesapay.co. The service remains active until the end of the period already paid. Periods already charged are not refunded, unless the law provides otherwise or MESAPAY has failed to provide the service.
- **Price changes**: we may change prices with at least thirty (30) days' notice by email or in the panel. If you do not agree, you may cancel before the new price applies.

## Guests' payments

- MESAPAY is not a financial institution or a payment gateway. Guests' online payments are processed by Kushki under the contract the restaurant enters into directly with Kushki to open its collection account. The platform integrates that service and records the result of each payment.
- The money from sales is received and settled by Kushki to the restaurant, within the terms, conditions and fees of that contract. MESAPAY does not hold guests' funds and is not responsible for the settlement times of the gateway or the banks.
- Card data never passes through MESAPAY: the gateway tokenizes it. Per-transaction fees are set by the gateway and, if the plan provides for it, MESAPAY may charge an additional fee stated in the plan.
- **Disputes and chargebacks**: cardholder claims, refunds and chargebacks are resolved between the restaurant, Kushki and the issuing bank. MESAPAY provides the order and payment records it has to support the restaurant, but does not assume the amount of chargebacks or decide on them.
- Payments in cash, with the restaurant's own card terminal or other manually recorded methods are the restaurant's responsibility; the platform only records them.
- The restaurant must comply with the rules of the gateway and the card networks, and must not use the platform for charges that do not correspond to a real sale of its business.

## Electronic invoicing

- The restaurant is the issuer of its invoices and is responsible for its tax obligations. It must upload and keep current its DIAN numbering resolution, its signing certificate, its tax regime, its taxes and its RUT details, and configure the taxes on its menu correctly.
- MESAPAY generates electronic invoices and credit notes with the data the restaurant configured and transmits them to the DIAN. If the DIAN rejects a document because of incorrect data, the restaurant must correct it; the platform shows the reason for the rejection.
- MESAPAY is not liable for penalties, interest or rejections arising from incomplete or incorrect tax data, expired resolutions or regulatory changes the restaurant has not addressed. Nor does it provide tax advice.
- Invoices in a guest's name are issued with the details the guest types; the restaurant may correct them with a credit note where the law allows it.

## Tips

Tips are voluntary and decided by the guest. The platform suggests and records them according to what the restaurant configures, in accordance with Colombian Law 1935 of 2018 and the rules that complement it. The restaurant is solely responsible for managing tips and distributing them among its team as the law requires; MESAPAY only records and reports them.

## Personal data and confidentiality

- The processing of personal data is governed by the [Privacy Policy](/privacidad). For the guest and team data the restaurant records, the restaurant is the data controller and MESAPAY acts as processor on its behalf. The restaurant must have the authorizations required by Law 1581 of 2012 and use its customers' data only to serve its relationship with them.
- Both parties keep confidential the non-public information they learn through the service: MESAPAY, the restaurant's operating data; the restaurant, the commercial conditions and the technical information of the platform. This obligation survives the termination of the contract.
- MESAPAY may use aggregated, anonymous usage data to operate and improve the product.

## Intellectual property

The platform, its code, its design, its trademarks and its documentation belong to MESAPAY or its licensors. The restaurant receives a limited, non-exclusive, non-transferable license to use the platform while it has an active account. Copying, modifying, decompiling, reselling it or using it to build an equivalent product is not allowed.

The content the restaurant uploads (menu, photos, name, logo and texts) belongs to the restaurant. The restaurant authorizes MESAPAY to display it to its guests, translate it into other languages and process it to provide the service, and warrants that it has the right to use it.

## Artificial intelligence assistant

The platform includes an assistant that answers questions about the restaurant's data using artificial intelligence models from an external provider. Its answers are for guidance only: they may contain errors, omissions or inaccurate interpretations and do not replace review by an accountant, a financial advisor or a lawyer. The restaurant must verify the information before making decisions based on it. By using the assistant, the restaurant accepts that the data needed to answer is sent to the model provider, as described in the Privacy Policy.

## Availability, maintenance and backups

- We work to keep the platform continuously available, but we do not guarantee one hundred percent availability. There may be interruptions due to maintenance, updates, failures of providers, networks or the restaurant's equipment, or causes beyond our control.
- Scheduled maintenance is announced in advance when possible, preferably during low-activity hours.
- We make daily backups of the database and keep them for seven (7) days. Those backups are for recovering the platform after an incident, not for restoring data that a restaurant user deleted on purpose. The restaurant can export its own data from the panel and we recommend doing so regularly.
- The restaurant is responsible for its internet connection, its equipment (tablets, phones, printers) and for keeping an alternative procedure to continue serving if the platform is unavailable.

## Restaurant obligations

The restaurant undertakes to:

- Use the platform only for the lawful operation of its business and comply with the rules that apply to it, including consumer protection, health, labor and tax rules.
- Publish a truthful menu: real names, descriptions, prices, taxes, allergens and availability. The prices the guest sees are the prices the restaurant charges.
- Fulfil the orders and bookings it accepts, and resolve directly with its customers any complaints about the food, the service or the attention received.
- Record its customers' and employees' data with the authorizations required by law and not upload sensitive data.
- Not attempt to breach the platform's security, not access other restaurants' data and not use automated tools that overload it.
- Pay the monthly fee and the other charges of the plan.

## Limits of liability

- To the extent permitted by law, MESAPAY is not liable for indirect damages, loss of profit, loss of sales, data or reputation arising from the use of or inability to use the platform.
- MESAPAY's total liability to the restaurant for any claim related to the service is limited to the amount of the monthly fees the restaurant paid in the twelve (12) months before the event that gave rise to it.
- MESAPAY is not liable for integrated third-party services (payment gateway, DIAN, email providers, banks, artificial intelligence, printers or networks), nor for decisions the restaurant makes based on reports, projections or the assistant's answers.
- The consumer relationship for the food and service at the restaurant is between the restaurant and the guest. MESAPAY is the provider of the tool, not the seller of the products.
- Nothing in these terms limits liability that Colombian law does not allow to be limited.

## Termination and data export

- Either party may terminate the contract at any time. The restaurant, by cancelling its plan; MESAPAY, with at least thirty (30) days' notice, or immediately if the restaurant breaches these terms, uses the platform for unlawful activities, endangers its security or falls into prolonged arrears.
- Upon termination, the restaurant has thirty (30) days to export its data from the panel or request it from info@mesapay.co. After that period we may delete it, except for the records we must keep under legal, accounting or tax obligations, which are kept for the periods stated in the Privacy Policy.
- Termination does not exempt the restaurant from paying what is owed up to the effective date.

## For guests

If you order, pay or book at a restaurant that uses MESAPAY:

- The purchase of the food and service is a contract between you and the restaurant. MESAPAY only provides the tool to order and pay; complaints about the dishes or the service are resolved with the restaurant.
- Check your order before sending it: once the kitchen receives it, the restaurant may not accept changes. Prices, taxes and the suggested tip are shown before you confirm; the tip is voluntary.
- Online payments are processed by Kushki and your card details do not pass through MESAPAY. If you have a problem with a charge, write to the restaurant first; you can also contact your bank.
- You can request an invoice in your name by entering your details; it is your responsibility that they are correct.
- Creating an account is optional and lets the restaurant recognize you, apply your discount and show you your orders. The account belongs to that restaurant. Your data is processed according to the [Privacy Policy](/privacidad).
- Do not use the platform to place fake orders, upload offensive content or attempt to breach its security.

## Governing law and dispute resolution

These terms are governed by the laws of the Republic of Colombia. In the event of any dispute, the parties will first try to resolve it directly, by writing to info@mesapay.co, within thirty (30) days of the claim. If there is no agreement, they may resort to conciliation or to the competent courts in Colombia. None of this limits the rights consumers have under Law 1480 of 2011.

## Changes to these terms

We may modify these terms when the service, our providers or the law change. Significant changes are notified to the restaurant by email or in the panel with at least fifteen (15) days' notice; the rest are published on this page with their update date. If you keep using the service after the date a change takes effect, you accept it. If you do not agree, you may cancel before that date.

## Contact

For any question, notice or claim related to these terms, write to info@mesapay.co. These terms are available in Spanish, English and Portuguese; if there are differences between the versions, the Spanish version prevails. See also the [Privacy Policy](/privacidad).
`.trim();

const pt = `
Estes termos regulam o uso do MESAPAY, a plataforma com a qual um restaurante recebe pedidos e pagamentos na mesa por código QR e administra sua comanda, sua equipe, suas reservas, seu faturamento e os demais módulos que ativar. Eles são o contrato entre o MESAPAY e o restaurante que cria uma conta, e incluem uma seção breve para os clientes que usam a plataforma em um restaurante. Leia com calma: ao criar a conta ou usar o serviço você os aceita.

## Quem somos e aceitação

O serviço é prestado pelo MESAPAY, com domicílio na Colômbia. O canal de contato para qualquer assunto destes termos é o e-mail info@mesapay.co.

Você aceita estes termos ao criar uma conta de restaurante, ao usar o serviço ou ao permitir que sua equipe o use. Quem cria a conta declara que tem poderes para obrigar o restaurante. Se não concordar com alguma parte, não use o serviço.

## Definições

- **MESAPAY** ou **a plataforma**: o software, as telas, os aplicativos web, as integrações e os serviços associados que prestamos.
- **Restaurante**: o restaurante, bar ou negócio de alimentação que contrata o serviço, incluindo suas unidades.
- **Usuários do restaurante**: as pessoas a quem o restaurante dá acesso: donos, administradores, garçons, cozinha, caixa e demais funções.
- **Cliente**: a pessoa que escaneia um QR, consulta o cardápio, pede, paga, reserva ou cria uma conta em um restaurante.
- **Gateway**: a Kushki, a empresa que processa os pagamentos com cartão, PSE, Apple Pay e outros meios on-line.
- **Plano**: o conjunto de módulos e limites contratados e seu preço.

## A conta do restaurante e seus usuários

O restaurante cadastra sua conta com dados verdadeiros e os mantém atualizados, em especial a razão social, o NIT, o endereço, o e-mail de contato e os dados fiscais. Cada pessoa da equipe entra com seu próprio usuário e senha; o restaurante decide a função de cada um e é responsável por tudo o que for feito com as contas que cria. As credenciais são pessoais: não devem ser compartilhadas nem emprestadas. Se suspeitar de um acesso não autorizado, troque a senha e escreva para nós.

O restaurante pode ter várias unidades; cada unidade é uma conta com seus próprios dados. O MESAPAY pode verificar a identidade e as informações legais do restaurante antes de ativar módulos como os pagamentos on-line ou a nota fiscal eletrônica.

## Planos, mensalidade e pagamento

- **Teste grátis**: o restaurante pode testar o serviço durante o período gratuito vigente no momento do cadastro, sem cartão. Ao terminar, para continuar usando a plataforma, deve escolher um plano.
- **Preço**: o plano é cobrado por mensalidade, em pesos colombianos, conforme os preços vigentes publicados ou os acordados por escrito com o restaurante. Os preços não incluem os impostos exigidos por lei nem as taxas do gateway pelos pagamentos dos clientes.
- **Débito automático**: a mensalidade é cobrada por débito automático no cartão ou na conta que o restaurante cadastra para esse fim, por meio do gateway. O restaurante autoriza essa cobrança recorrente ao cadastrar o meio de pagamento e pode alterá-lo pelo painel. Quando uma cobrança não pode ser feita, tentamos de novo e avisamos por e-mail.
- **Inadimplência e suspensão**: se uma mensalidade não for paga após as tentativas de cobrança e o aviso, o MESAPAY pode suspender o acesso ao serviço até a regularização. Durante a suspensão o restaurante conserva seus dados, mas a equipe não pode operar com a plataforma. A suspensão não dispensa o pagamento do que é devido.
- **Mudanças de plano**: o restaurante pode subir ou descer de plano; o novo preço vale a partir do período seguinte.
- **Cancelamento**: o restaurante pode cancelar a qualquer momento pelo painel ou escrevendo para info@mesapay.co. O serviço continua ativo até o fim do período já pago. Períodos já cobrados não são reembolsados, salvo se a lei dispuser de outra forma ou se o MESAPAY tiver descumprido o serviço.
- **Mudanças de preço**: podemos alterar os preços avisando com pelo menos trinta (30) dias de antecedência por e-mail ou no painel. Se não concordar, você pode cancelar antes de o novo preço valer.

## Pagamentos dos clientes

- O MESAPAY não é uma instituição financeira nem um gateway de pagamento. Os pagamentos on-line dos clientes são processados pela Kushki sob o contrato que o restaurante celebra diretamente com a Kushki para abrir sua conta de recebimento. A plataforma integra esse serviço e registra o resultado de cada pagamento.
- O dinheiro das vendas é recebido e repassado pela Kushki ao restaurante, nos prazos, condições e tarifas desse contrato. O MESAPAY não guarda fundos dos clientes nem responde pelos prazos de repasse do gateway ou dos bancos.
- Os dados dos cartões nunca passam pelo MESAPAY: o gateway os tokeniza. As taxas por transação são fixadas pelo gateway e, se o plano previr, o MESAPAY pode cobrar uma taxa adicional informada no plano.
- **Disputas e chargebacks**: as reclamações dos titulares de cartão, os estornos e os chargebacks são resolvidos entre o restaurante, a Kushki e o banco emissor. O MESAPAY entrega os registros do pedido e do pagamento que tiver para apoiar o restaurante, mas não assume o valor dos chargebacks nem decide sobre eles.
- Os pagamentos em dinheiro, com a maquininha do próprio restaurante ou outros meios registrados manualmente são responsabilidade do restaurante; a plataforma só os anota.
- O restaurante deve cumprir as regras do gateway e das bandeiras, e não usar a plataforma para cobranças que não correspondam a uma venda real do seu negócio.

## Nota fiscal eletrônica

- O restaurante é o emissor das suas notas fiscais e o responsável pelas suas obrigações tributárias. Deve carregar e manter vigentes sua resolução de numeração da DIAN, seu certificado de assinatura, seu regime, seus impostos e os dados do seu RUT, e configurar corretamente os impostos do seu cardápio.
- O MESAPAY gera as notas fiscais e notas de crédito eletrônicas com os dados que o restaurante configurou e as transmite à DIAN. Se a DIAN rejeitar um documento por dados incorretos, o restaurante deve corrigi-los; a plataforma mostra o motivo da rejeição.
- O MESAPAY não responde por multas, juros ou rejeições decorrentes de dados fiscais incompletos ou errados, de resoluções vencidas ou de mudanças normativas que o restaurante não tenha atendido. Também não presta consultoria tributária.
- As notas fiscais em nome de um cliente são emitidas com os dados que o cliente digita; o restaurante pode corrigi-las com uma nota de crédito quando a lei permitir.

## Gorjetas

A gorjeta é voluntária e quem decide é o cliente. A plataforma a sugere e a registra conforme o que o restaurante configurar, de acordo com a Lei colombiana 1935 de 2018 e as normas que a complementam. O restaurante é o único responsável por administrá-la e distribuí-la entre a equipe como a lei exige; o MESAPAY só a registra e a reporta.

## Dados pessoais e confidencialidade

- O tratamento dos dados pessoais é regido pela [Política de privacidade](/privacidad). Para os dados dos clientes e da equipe que o restaurante registra, o restaurante é o responsável pelo tratamento e o MESAPAY atua como operador por conta dele. O restaurante deve ter as autorizações exigidas pela Lei 1581 de 2012 e usar os dados dos seus clientes só para atender a relação com eles.
- Ambas as partes mantêm confidenciais as informações não públicas que conhecerem pelo serviço: o MESAPAY, os dados de operação do restaurante; o restaurante, as condições comerciais e as informações técnicas da plataforma. Essa obrigação continua vigente depois do término do contrato.
- O MESAPAY pode usar dados agregados e anônimos de uso para operar e melhorar o produto.

## Propriedade intelectual

A plataforma, seu código, seu design, suas marcas e sua documentação pertencem ao MESAPAY ou aos seus licenciantes. O restaurante recebe uma licença limitada, não exclusiva e intransferível para usar a plataforma enquanto tiver uma conta ativa. Não é permitido copiá-la, modificá-la, descompilá-la, revendê-la nem usá-la para construir um produto equivalente.

O conteúdo que o restaurante carrega (cardápio, fotos, nome, logo e textos) é dele. O restaurante autoriza o MESAPAY a exibi-lo aos seus clientes, a traduzi-lo para outros idiomas e a processá-lo para prestar o serviço, e garante que tem o direito de usá-lo.

## Assistente de inteligência artificial

A plataforma inclui um assistente que responde perguntas sobre os dados do restaurante usando modelos de inteligência artificial de um provedor externo. Suas respostas são orientativas: podem conter erros, omissões ou interpretações inexatas e não substituem a revisão de um contador, de um consultor financeiro ou de um advogado. O restaurante deve verificar as informações antes de tomar decisões com base nelas. Ao usar o assistente, o restaurante aceita que os dados necessários para responder sejam enviados ao provedor do modelo, como descrito na Política de privacidade.

## Disponibilidade, manutenção e cópias de segurança

- Trabalhamos para que a plataforma esteja disponível de forma contínua, mas não garantimos disponibilidade de cem por cento. Pode haver interrupções por manutenção, atualizações, falhas de provedores, de redes ou de equipamentos do restaurante, ou causas fora do nosso controle.
- As manutenções programadas são avisadas com antecedência quando possível, de preferência em horários de pouca operação.
- Fazemos cópias de segurança diárias do banco de dados e as conservamos por sete (7) dias. Essas cópias servem para recuperar a plataforma diante de um incidente, não para restaurar dados que um usuário do restaurante apagou de propósito. O restaurante pode exportar seus próprios dados pelo painel e recomendamos fazê-lo periodicamente.
- O restaurante é responsável pela sua conexão à internet, pelos seus equipamentos (tablets, celulares, impressoras) e por manter um procedimento alternativo para continuar atendendo se a plataforma não estiver disponível.

## Obrigações do restaurante

O restaurante se compromete a:

- Usar a plataforma só para a operação lícita do seu negócio e cumprir as normas que se apliquem a ele, incluindo as de proteção ao consumidor, sanitárias, trabalhistas e tributárias.
- Publicar um cardápio verdadeiro: nomes, descrições, preços, impostos, alérgenos e disponibilidade reais. Os preços que o cliente vê são os que o restaurante cobra.
- Atender os pedidos e as reservas que aceita, e resolver diretamente com seus clientes as reclamações sobre a comida, o serviço ou o atendimento.
- Registrar os dados dos seus clientes e funcionários com as autorizações exigidas por lei e não carregar dados sensíveis.
- Não tentar violar a segurança da plataforma, não acessar dados de outros restaurantes nem usar ferramentas automáticas que a sobrecarreguem.
- Pagar a mensalidade e os demais encargos do plano.

## Limites de responsabilidade

- Na medida em que a lei permitir, o MESAPAY não responde por danos indiretos, lucros cessantes, perda de vendas, de dados ou de reputação decorrentes do uso ou da impossibilidade de usar a plataforma.
- A responsabilidade total do MESAPAY perante o restaurante por qualquer reclamação relacionada ao serviço limita-se ao valor das mensalidades que o restaurante pagou nos doze (12) meses anteriores ao fato que a originou.
- O MESAPAY não responde pelos serviços de terceiros integrados (gateway de pagamento, DIAN, provedores de e-mail, bancos, inteligência artificial, impressoras ou redes), nem por decisões que o restaurante tome com base em relatórios, projeções ou respostas do assistente.
- A relação de consumo pela comida e pelo serviço no restaurante é entre o restaurante e o cliente. O MESAPAY é o fornecedor da ferramenta, não o vendedor dos produtos.
- Nada nestes termos limita a responsabilidade que a lei colombiana não permita limitar.

## Término e exportação de dados

- Qualquer das partes pode encerrar o contrato a qualquer momento. O restaurante, cancelando seu plano; o MESAPAY, avisando com pelo menos trinta (30) dias de antecedência, ou de imediato se o restaurante descumprir estes termos, usar a plataforma para atividades ilícitas, colocar em risco a segurança dela ou ficar inadimplente por tempo prolongado.
- Ao encerrar, o restaurante tem trinta (30) dias para exportar seus dados pelo painel ou solicitá-los a info@mesapay.co. Depois desse prazo podemos apagá-los, exceto os registros que devamos conservar por obrigação legal, contábil ou tributária, que ficam guardados pelos prazos indicados na Política de privacidade.
- O término não dispensa o pagamento do que for devido até a data efetiva.

## Para clientes

Se você pede, paga ou reserva em um restaurante que usa o MESAPAY:

- A compra da comida e do serviço é um contrato entre você e o restaurante. O MESAPAY só fornece a ferramenta para pedir e pagar; as reclamações sobre os pratos ou o atendimento são resolvidas com o restaurante.
- Confira seu pedido antes de enviá-lo: depois que a cozinha o recebe, o restaurante pode não aceitar alterações. Os preços, os impostos e a gorjeta sugerida aparecem antes de confirmar; a gorjeta é voluntária.
- Os pagamentos on-line são processados pela Kushki e os dados do seu cartão não passam pelo MESAPAY. Se tiver um problema com uma cobrança, escreva primeiro ao restaurante; você também pode recorrer ao seu banco.
- Você pode pedir uma nota fiscal em seu nome digitando seus dados; é sua responsabilidade que estejam corretos.
- Criar uma conta é opcional e serve para o restaurante reconhecer você, aplicar seu desconto e mostrar seus pedidos. A conta é daquele restaurante. Seus dados são tratados conforme a [Política de privacidade](/privacidad).
- Não use a plataforma para fazer pedidos falsos, carregar conteúdo ofensivo ou tentar violar a segurança dela.

## Lei aplicável e resolução de conflitos

Estes termos são regidos pelas leis da República da Colômbia. Diante de qualquer divergência, as partes tentarão primeiro resolvê-la diretamente, escrevendo para info@mesapay.co, dentro dos trinta (30) dias seguintes à reclamação. Se não houver acordo, poderão recorrer à conciliação ou aos juízes competentes na Colômbia. Nada disso limita os direitos que os consumidores tenham conforme a Lei 1480 de 2011.

## Alterações nestes termos

Podemos modificar estes termos quando o serviço, nossos provedores ou a lei mudarem. As alterações relevantes são avisadas por e-mail ao restaurante ou no painel com pelo menos quinze (15) dias de antecedência; as demais são publicadas nesta página com a data de atualização. Se você continuar usando o serviço depois da data em que uma alteração entra em vigor, você a aceita. Se não concordar, pode cancelar antes dessa data.

## Contato

Para qualquer pergunta, notificação ou reclamação relacionada a estes termos, escreva para info@mesapay.co. Estes termos estão disponíveis em espanhol, inglês e português; se houver diferenças entre as versões, prevalece a versão em espanhol. Consulte também a [Política de privacidade](/privacidad).
`.trim();

export const TERMINOS: LegalDocument = {
  updatedAt: "2026-11-02",
  es,
  en,
  pt,
};
