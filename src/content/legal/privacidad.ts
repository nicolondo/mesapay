/**
 * Política de tratamiento de datos personales (privacidad) de MESAPAY.
 *
 * Markdown reducido (ver `src/lib/help/markdown.ts`). El español es la
 * fuente; inglés y portugués son traducciones fieles y tienen las mismas
 * secciones (`legal.test.ts` lo exige). Sin HTML, sin enlaces externos: el
 * correo de contacto va como texto.
 *
 * Marco: Ley 1581 de 2012, Decreto 1377 de 2013 (compilado en el Decreto
 * 1074 de 2015) y las demás normas que los modifiquen. Autoridad:
 * Superintendencia de Industria y Comercio (SIC).
 */
import type { LegalDocument } from "./types";

const es = `
Esta política explica qué datos personales trata MESAPAY, para qué los usa, con quién los comparte y cómo puedes ejercer tus derechos. Aplica a los comercios que usan la plataforma, a sus equipos, a los comensales que piden y pagan con ella y a las personas que contactamos como prospectos. Está escrita conforme a la Ley 1581 de 2012, el Decreto 1377 de 2013 (compilado en el Decreto 1074 de 2015) y las normas que los complementen.

## Responsable del tratamiento

El responsable del tratamiento de los datos personales es MESAPAY, con domicilio en Colombia. Para cualquier asunto relacionado con esta política o con tus datos, el canal de contacto es el correo info@mesapay.co.

Cuando un restaurante usa MESAPAY para atender a sus clientes, el restaurante es responsable de los datos de sus comensales y de su equipo, y MESAPAY actúa como encargado del tratamiento por cuenta de él. MESAPAY es responsable directo de los datos de las cuentas de los comercios, de los datos de facturación de la suscripción y de los datos de los prospectos comerciales.

## A quién aplica

Tratamos datos de tres tipos de personas:

- **Comercios y su equipo**: dueños, administradores, meseros, personal de cocina y demás usuarios que el comercio crea en la plataforma.
- **Comensales**: las personas que escanean el QR de una mesa, piden, pagan, reservan o crean una cuenta en un restaurante que usa MESAPAY.
- **Prospectos**: restaurantes y personas de contacto que el equipo comercial de MESAPAY gestiona para ofrecer el servicio.

## Qué datos tratamos

### De los comercios y su equipo

- Datos de la cuenta: nombre, correo electrónico, contraseña (guardada cifrada, nunca en texto plano), rol y comercio al que pertenece.
- Datos legales del restaurante: razón social, NIT, dirección, ciudad, régimen tributario, RUT, resolución de numeración de la DIAN y certificado de firma para facturación electrónica, cuando el comercio activa ese módulo.
- Datos para activar los pagos en línea: la información legal, de representación y bancaria que la pasarela de pagos exige para abrir la cuenta de cobro del comercio.
- Datos de la suscripción: plan, historial de cobros y estado de pago.
- Datos de operación: carta, precios, mesas, pedidos, cobros, inventario, turnos, nómina y contabilidad que el comercio registra. Incluyen datos personales de los empleados del comercio (nombre, documento, salario y horas) cuando el comercio usa el módulo de nómina.
- Datos técnicos: dirección IP, navegador, dispositivo, fecha y hora de acceso y registros de actividad, para seguridad y soporte.

### De los comensales

- Al pedir desde la mesa, sin registro: el nombre que escribes para que la mesa te reconozca, los platos que pides, las notas del pedido, la propina que eliges y el medio de pago usado. Tu sesión de invitado se guarda en una cookie que sólo identifica tu mesa en ese restaurante.
- Al pagar con tarjeta, PSE o Apple Pay: el pago lo procesa Kushki. **Los datos de tu tarjeta nunca pasan por los servidores de MESAPAY**: Kushki los convierte en un token y MESAPAY sólo recibe el resultado del pago, los últimos dígitos y la franquicia.
- Al pedir una factura a tu nombre: nombre o razón social, tipo y número de documento, correo electrónico y, si aplica, dirección y teléfono. Estos datos van en la factura electrónica que exige la DIAN.
- Al crear una cuenta en un restaurante: nombre completo, número de cédula, correo electrónico, celular (opcional), contraseña cifrada, los dispositivos donde entraste y tu historial de pedidos en ese restaurante. La cuenta es de ese restaurante; en otro restaurante que use MESAPAY tendrías que crear otra.
- Al reservar: nombre, celular, correo, número de personas, fecha y hora, y el abono si el restaurante lo pide.
- Al calificar un plato: la calificación y el comentario que escribes.

### De los prospectos

Nombre del restaurante, nombre y cargo de la persona de contacto, teléfono, correo electrónico, ciudad, notas de la gestión comercial, citas agendadas y los correos que intercambiamos. Estos datos provienen de contacto directo, de referidos o de fuentes públicas como el sitio web o las redes del restaurante.

## Para qué usamos los datos

- Prestar el servicio: mostrar la carta, recibir pedidos, cobrarlos, emitir facturas, administrar reservas y operar los módulos que el comercio tenga activos.
- Procesar los pagos a través de la pasarela y conciliarlos con los pedidos.
- Emitir y transmitir facturas electrónicas y notas crédito a la DIAN, y enviarlas por correo al comensal que las pide.
- Cobrar la suscripción del comercio y gestionar su plan.
- Enviar correos transaccionales: confirmaciones de pedido y reserva, facturas, enlaces de acceso, restablecimiento de contraseña y avisos de la cuenta.
- Mantener la seguridad de la plataforma: detectar fraudes, abusos y accesos no autorizados, y conservar registros de actividad.
- Responder consultas del comercio con el asistente de inteligencia artificial, usando los datos de operación de ese comercio.
- Dar soporte técnico y de uso.
- Ofrecer el servicio a prospectos y hacer seguimiento comercial.
- Mejorar el producto a partir de datos de uso agregados, que no identifican a una persona.
- Cumplir obligaciones legales, contables y tributarias.

No vendemos datos personales ni los usamos para publicidad de terceros.

## Base legal y autorización

Tratamos los datos con alguna de estas bases:

- **Ejecución del contrato**: lo necesario para prestar el servicio que el comercio contrató o para atender el pedido, pago o reserva que el comensal hace.
- **Obligación legal**: la facturación electrónica, la conservación de registros contables y tributarios y las respuestas a autoridades.
- **Autorización del titular**: para lo demás, como la cuenta del comensal, el recibo de comunicaciones comerciales o el tratamiento de datos de prospectos. Puedes revocar la autorización en cualquier momento escribiendo a info@mesapay.co, salvo que una obligación legal o contractual nos exija conservar los datos.

Al crear una cuenta, pedir, pagar o reservar en MESAPAY aceptas esta política. Si el comercio carga datos de sus empleados o clientes, es responsable de contar con la autorización que la ley exige.

## Datos sensibles y menores de edad

MESAPAY no pide datos sensibles (salud, orientación sexual, origen étnico, creencias, datos biométricos ni similares). No escribas ese tipo de información en las notas de un pedido o en un comentario. El número de cédula se pide sólo para la cuenta del comensal y la factura a su nombre, porque la ley tributaria lo exige para identificar al comprador.

Los servicios de MESAPAY están dirigidos a mayores de edad. Un menor puede ver la carta y pedir acompañado de un adulto responsable, pero no debe crear una cuenta ni registrar datos personales. Si sabemos que registramos datos de un menor sin la autorización de su representante, los eliminamos.

## Con quién compartimos los datos

Compartimos datos sólo con quienes necesitan tratarlos para prestar el servicio, bajo contratos que les exigen protegerlos y usarlos únicamente para ese fin:

- **Kushki** (pasarela de pagos): recibe los datos del pago y, para los comercios, los datos que exige para abrir y operar su cuenta de cobro. Los datos de tarjeta se tratan bajo los estándares de seguridad de la industria de pagos que aplican a Kushki.
- **DIAN**: recibe las facturas electrónicas y notas crédito que el comercio emite, con los datos del comprador que la ley exige. MESAPAY las transmite directamente, sin un proveedor tecnológico intermedio.
- **Resend** (envío de correo): recibe la dirección y el contenido de los correos transaccionales que enviamos.
- **Anthropic** (asistente de inteligencia artificial): cuando un usuario del comercio hace una pregunta al asistente, enviamos al modelo la pregunta y los datos de operación necesarios para responderla (por ejemplo, ventas, platos o turnos). Según los términos del servicio que usamos, Anthropic no utiliza esos datos para entrenar sus modelos. No enviamos datos de tarjetas ni contraseñas.
- **Proveedores de infraestructura**: los servidores y la base de datos de MESAPAY están alojados en infraestructura contratada a proveedores de hosting, que sólo tratan los datos como encargados.
- **El restaurante que visitas**: tus pedidos, pagos, reservas, datos de factura y, si la creaste, tu cuenta, son visibles para el equipo del restaurante donde los registraste.
- **Autoridades**: cuando una ley o una orden de autoridad competente lo exija.

## Transferencias internacionales

Algunos de estos proveedores tratan los datos fuera de Colombia, principalmente en Estados Unidos (envío de correo y asistente de inteligencia artificial). Cuando esto ocurre, exigimos al proveedor un nivel de protección adecuado mediante los términos contractuales de su servicio, conforme a lo que exige la ley colombiana para las transferencias internacionales. Al usar MESAPAY autorizas estas transferencias en la medida en que sean necesarias para prestar el servicio.

## Cuánto tiempo conservamos los datos

- **Cuentas de comercios y de comensales**: mientras la cuenta exista. Cuando se cierra, eliminamos o anonimizamos los datos que no debamos conservar por otra razón.
- **Pedidos, pagos, facturas y registros contables**: al menos cinco (5) años desde la operación, o el plazo mayor que exijan las normas contables y tributarias colombianas, porque son soporte de las obligaciones fiscales del comercio.
- **Sesiones de invitado**: la cookie dura lo que dure tu visita a la mesa y los pedidos quedan asociados al restaurante, no a una persona identificada, salvo que pidas factura a tu nombre.
- **Prospectos**: mientras haya una gestión comercial activa o hasta que la persona pida que la borremos.
- **Registros de seguridad**: el tiempo necesario para investigar incidentes, normalmente no más de un año.
- **Copias de seguridad**: hacemos copias diarias de la base de datos y las conservamos durante siete (7) días. Un dato eliminado puede permanecer en esas copias hasta que se reemplacen.

## Cómo protegemos los datos

Aplicamos medidas técnicas y organizativas razonables: cifrado de las comunicaciones (HTTPS), contraseñas guardadas con funciones de hash, control de acceso por roles dentro de cada comercio, sesiones revocables, registros de actividad, copias de seguridad diarias y acceso restringido a la infraestructura. Ningún sistema es infalible: si ocurre un incidente que afecte tus datos, lo notificaremos a los afectados y a la autoridad según lo exija la ley.

## Tus derechos

Como titular de los datos tienes derecho a:

- Conocer, actualizar y rectificar tus datos.
- Solicitar prueba de la autorización que nos diste, salvo cuando la ley no la exija.
- Ser informado sobre el uso que les hemos dado.
- Revocar la autorización y pedir la supresión de tus datos, cuando no exista un deber legal o contractual de conservarlos.
- Acceder gratuitamente a tus datos.
- Presentar quejas ante la Superintendencia de Industria y Comercio (SIC) por infracciones a la ley de protección de datos.

Si tienes una cuenta de comensal, puedes ver y actualizar tu perfil, revisar tus dispositivos y cerrar tus sesiones desde Mi cuenta en el restaurante. Los usuarios de un comercio pueden actualizar sus datos desde su perfil en el panel.

## Cómo ejercer tus derechos

Escribe a info@mesapay.co desde el correo registrado o indicando tu nombre, tipo y número de documento, el restaurante donde registraste los datos (si aplica) y qué necesitas. Si actúas en nombre de otra persona, adjunta la autorización.

- **Consultas**: respondemos en un máximo de diez (10) días hábiles desde que recibimos la solicitud. Si no es posible en ese plazo, te lo informamos y respondemos dentro de los cinco (5) días hábiles siguientes.
- **Reclamos** (rectificación, supresión, revocación o presunto incumplimiento): si el reclamo está incompleto, te pediremos completarlo dentro de los cinco (5) días siguientes; si pasan dos (2) meses sin respuesta, entendemos que desistes. Una vez completo, respondemos en un máximo de quince (15) días hábiles; si no es posible, te lo informamos y respondemos dentro de los ocho (8) días hábiles siguientes.

Sólo puedes presentar queja ante la SIC después de haber agotado la consulta o el reclamo con MESAPAY.

Cuando los datos los registró un restaurante como responsable (por ejemplo, un pedido o una reserva), podemos redirigir tu solicitud al restaurante o atenderla en coordinación con él.

## Cookies

MESAPAY usa sólo cookies necesarias para funcionar:

- **Sesión del equipo del comercio**: mantiene la sesión de quien entra al panel o a la app del mesero.
- **Sesión del comensal**: mantiene tu sesión de invitado en la mesa y, si creaste una cuenta, tu sesión en ese restaurante hasta que la cierres.
- **Idioma**: recuerda el idioma que elegiste (español, inglés o portugués).

No usamos cookies de publicidad ni de seguimiento de terceros. Puedes borrar las cookies desde tu navegador; si lo haces, tendrás que volver a entrar o a escanear el QR de la mesa.

## Cambios a esta política

Podemos actualizar esta política cuando cambie el servicio, nuestros proveedores o la ley. Publicaremos la versión vigente en esta página con su fecha de actualización y, si el cambio es relevante, avisaremos por correo a los comercios. El uso del servicio después de un cambio implica su aceptación.

## Vigencia y contacto

Esta política rige desde su fecha de publicación y mientras MESAPAY trate datos personales. Los datos se conservan por los plazos indicados arriba.

Para consultas, reclamos y cualquier asunto sobre tus datos personales escribe a info@mesapay.co. Esta política está disponible en español, inglés y portugués; si hay diferencias entre las versiones, prevalece la versión en español. Consulta también los [Términos de servicio](/terminos).
`.trim();

const en = `
This policy explains which personal data MESAPAY processes, what it is used for, who it is shared with and how you can exercise your rights. It applies to the restaurants that use the platform, to their teams, to the guests who order and pay with it and to the people we contact as prospects. It is written in accordance with Colombian Law 1581 of 2012, Decree 1377 of 2013 (compiled in Decree 1074 of 2015) and the rules that complement them.

## Data controller

The controller of the personal data is MESAPAY, domiciled in Colombia. For any matter related to this policy or to your data, the contact channel is the email address info@mesapay.co.

When a restaurant uses MESAPAY to serve its customers, the restaurant is the controller of its guests' and its team's data, and MESAPAY acts as a processor on its behalf. MESAPAY is the direct controller of the data of restaurant accounts, of subscription billing data and of the data of commercial prospects.

## Who this applies to

We process data about three kinds of people:

- **Restaurants and their teams**: owners, administrators, waiters, kitchen staff and any other users the restaurant creates on the platform.
- **Guests**: the people who scan a table's QR code, order, pay, book a table or create an account at a restaurant that uses MESAPAY.
- **Prospects**: restaurants and contact people that MESAPAY's sales team manages in order to offer the service.

## What data we process

### About restaurants and their teams

- Account data: name, email address, password (stored encrypted, never in plain text), role and the restaurant the user belongs to.
- The restaurant's legal data: legal name, tax ID (NIT), address, city, tax regime, RUT, DIAN numbering resolution and the signing certificate for electronic invoicing, when the restaurant turns that module on.
- Data to activate online payments: the legal, representation and banking information the payment gateway requires to open the restaurant's collection account.
- Subscription data: plan, billing history and payment status.
- Operating data: menu, prices, tables, orders, charges, inventory, shifts, payroll and accounting that the restaurant records. This includes personal data of the restaurant's employees (name, ID number, salary and hours) when the restaurant uses the payroll module.
- Technical data: IP address, browser, device, date and time of access and activity logs, for security and support.

### About guests

- When ordering from the table without registering: the name you type so the table recognizes you, the dishes you order, the order notes, the tip you choose and the payment method used. Your guest session is stored in a cookie that only identifies your table at that restaurant.
- When paying by card, PSE or Apple Pay: the payment is processed by Kushki. **Your card details never pass through MESAPAY's servers**: Kushki turns them into a token and MESAPAY only receives the result of the payment, the last digits and the card brand.
- When requesting an invoice in your name: name or legal name, type and number of ID document, email address and, if applicable, address and phone number. This data goes on the electronic invoice required by the DIAN.
- When creating an account at a restaurant: full name, ID number, email address, mobile number (optional), encrypted password, the devices you signed in from and your order history at that restaurant. The account belongs to that restaurant; at another restaurant that uses MESAPAY you would need to create another one.
- When booking: name, mobile number, email, number of people, date and time, and the deposit if the restaurant asks for one.
- When rating a dish: the rating and the comment you write.

### About prospects

Restaurant name, name and position of the contact person, phone number, email address, city, sales follow-up notes, scheduled appointments and the emails we exchange. This data comes from direct contact, referrals or public sources such as the restaurant's website or social networks.

## What we use the data for

- To provide the service: show the menu, receive orders, charge them, issue invoices, manage bookings and run the modules the restaurant has turned on.
- To process payments through the gateway and reconcile them with the orders.
- To issue and transmit electronic invoices and credit notes to the DIAN, and to email them to the guest who requests them.
- To bill the restaurant's subscription and manage its plan.
- To send transactional emails: order and booking confirmations, invoices, sign-in links, password resets and account notices.
- To keep the platform secure: detect fraud, abuse and unauthorized access, and keep activity logs.
- To answer the restaurant's questions through the artificial intelligence assistant, using that restaurant's operating data.
- To provide technical and usage support.
- To offer the service to prospects and follow up commercially.
- To improve the product using aggregated usage data that does not identify a person.
- To comply with legal, accounting and tax obligations.

We do not sell personal data or use it for third-party advertising.

## Legal basis and authorization

We process data on one of these bases:

- **Performance of the contract**: what is needed to provide the service the restaurant contracted, or to handle the order, payment or booking the guest makes.
- **Legal obligation**: electronic invoicing, the retention of accounting and tax records and responses to authorities.
- **The data subject's authorization**: for everything else, such as the guest account, receiving commercial communications or the processing of prospect data. You can revoke your authorization at any time by writing to info@mesapay.co, unless a legal or contractual obligation requires us to keep the data.

By creating an account, ordering, paying or booking on MESAPAY you accept this policy. If the restaurant uploads data about its employees or customers, it is responsible for having the authorization the law requires.

## Sensitive data and minors

MESAPAY does not ask for sensitive data (health, sexual orientation, ethnic origin, beliefs, biometric data or similar). Do not write that kind of information in order notes or in a comment. The ID number is requested only for the guest account and for the invoice in your name, because tax law requires it to identify the buyer.

MESAPAY's services are aimed at adults. A minor may look at the menu and order together with a responsible adult, but should not create an account or register personal data. If we learn that we have registered a minor's data without their guardian's authorization, we delete it.

## Who we share data with

We share data only with those who need to process it to provide the service, under contracts that require them to protect it and use it solely for that purpose:

- **Kushki** (payment gateway): receives the payment data and, for restaurants, the data it requires to open and operate their collection account. Card data is handled under the payment industry security standards that apply to Kushki.
- **DIAN**: receives the electronic invoices and credit notes the restaurant issues, with the buyer data required by law. MESAPAY transmits them directly, without an intermediary technology provider.
- **Resend** (email delivery): receives the address and content of the transactional emails we send.
- **Anthropic** (artificial intelligence assistant): when a restaurant user asks the assistant a question, we send the model the question and the operating data needed to answer it (for example sales, dishes or shifts). Under the terms of the service we use, Anthropic does not use that data to train its models. We do not send card data or passwords.
- **Infrastructure providers**: MESAPAY's servers and database are hosted on infrastructure contracted from hosting providers, which only process the data as processors.
- **The restaurant you visit**: your orders, payments, bookings, invoice details and, if you created one, your account are visible to the team of the restaurant where you registered them.
- **Authorities**: when a law or an order from a competent authority requires it.

## International transfers

Some of these providers process data outside Colombia, mainly in the United States (email delivery and the artificial intelligence assistant). When this happens, we require the provider to offer an adequate level of protection through the contractual terms of its service, as Colombian law requires for international transfers. By using MESAPAY you authorize these transfers to the extent they are necessary to provide the service.

## How long we keep the data

- **Restaurant and guest accounts**: for as long as the account exists. When it is closed, we delete or anonymize the data we are not required to keep for another reason.
- **Orders, payments, invoices and accounting records**: at least five (5) years from the transaction, or the longer period required by Colombian accounting and tax rules, because they support the restaurant's tax obligations.
- **Guest sessions**: the cookie lasts as long as your visit to the table, and the orders remain associated with the restaurant, not with an identified person, unless you request an invoice in your name.
- **Prospects**: while there is active sales follow-up or until the person asks us to delete them.
- **Security logs**: as long as needed to investigate incidents, normally no more than one year.
- **Backups**: we make daily backups of the database and keep them for seven (7) days. Deleted data may remain in those backups until they are replaced.

## How we protect the data

We apply reasonable technical and organizational measures: encrypted communications (HTTPS), passwords stored with hash functions, role-based access control within each restaurant, revocable sessions, activity logs, daily backups and restricted access to the infrastructure. No system is infallible: if an incident affecting your data occurs, we will notify those affected and the authority as required by law.

## Your rights

As the data subject you have the right to:

- Know, update and correct your data.
- Request proof of the authorization you gave us, except where the law does not require it.
- Be informed about how we have used it.
- Revoke your authorization and request the deletion of your data, when there is no legal or contractual duty to keep it.
- Access your data free of charge.
- File complaints with the Superintendence of Industry and Commerce (SIC) for breaches of data protection law.

If you have a guest account, you can view and update your profile, review your devices and close your sessions from My account at the restaurant. Restaurant users can update their data from their profile in the panel.

## How to exercise your rights

Write to info@mesapay.co from your registered email address or stating your name, type and number of ID document, the restaurant where you registered the data (if applicable) and what you need. If you are acting on someone else's behalf, attach the authorization.

- **Queries**: we answer within a maximum of ten (10) business days from receiving the request. If that is not possible within that period, we will let you know and answer within the following five (5) business days.
- **Claims** (correction, deletion, revocation or alleged non-compliance): if the claim is incomplete, we will ask you to complete it within the following five (5) days; if two (2) months pass without a reply, we will consider it withdrawn. Once complete, we answer within a maximum of fifteen (15) business days; if that is not possible, we will let you know and answer within the following eight (8) business days.

You can only file a complaint with the SIC after having completed the query or claim process with MESAPAY.

When the data was registered by a restaurant as controller (for example an order or a booking), we may forward your request to the restaurant or handle it in coordination with it.

## Cookies

MESAPAY uses only the cookies needed to work:

- **Restaurant team session**: keeps the session of whoever signs in to the panel or the waiter app.
- **Guest session**: keeps your guest session at the table and, if you created an account, your session at that restaurant until you sign out.
- **Language**: remembers the language you chose (Spanish, English or Portuguese).

We do not use advertising cookies or third-party tracking cookies. You can delete cookies from your browser; if you do, you will have to sign in again or scan the table's QR code again.

## Changes to this policy

We may update this policy when the service, our providers or the law change. We will publish the current version on this page with its update date and, if the change is significant, we will notify restaurants by email. Using the service after a change implies acceptance of it.

## Term and contact

This policy is in force from its publication date and for as long as MESAPAY processes personal data. Data is kept for the periods indicated above.

For queries, claims and any matter regarding your personal data, write to info@mesapay.co. This policy is available in Spanish, English and Portuguese; if there are differences between the versions, the Spanish version prevails. See also the [Terms of Service](/terminos).
`.trim();

const pt = `
Esta política explica quais dados pessoais o MESAPAY trata, para que os usa, com quem os compartilha e como você pode exercer seus direitos. Ela se aplica aos restaurantes que usam a plataforma, às suas equipes, aos clientes que pedem e pagam com ela e às pessoas que contatamos como prospects. Foi escrita conforme a Lei colombiana 1581 de 2012, o Decreto 1377 de 2013 (compilado no Decreto 1074 de 2015) e as normas que os complementam.

## Responsável pelo tratamento

O responsável pelo tratamento dos dados pessoais é o MESAPAY, com domicílio na Colômbia. Para qualquer assunto relacionado a esta política ou aos seus dados, o canal de contato é o e-mail info@mesapay.co.

Quando um restaurante usa o MESAPAY para atender seus clientes, o restaurante é o responsável pelos dados dos seus clientes e da sua equipe, e o MESAPAY atua como operador do tratamento por conta dele. O MESAPAY é responsável direto pelos dados das contas dos restaurantes, pelos dados de cobrança da assinatura e pelos dados dos prospects comerciais.

## A quem se aplica

Tratamos dados de três tipos de pessoas:

- **Restaurantes e sua equipe**: donos, administradores, garçons, pessoal de cozinha e demais usuários que o restaurante cria na plataforma.
- **Clientes**: as pessoas que escaneiam o QR de uma mesa, pedem, pagam, reservam ou criam uma conta em um restaurante que usa o MESAPAY.
- **Prospects**: restaurantes e pessoas de contato que a equipe comercial do MESAPAY gerencia para oferecer o serviço.

## Quais dados tratamos

### Dos restaurantes e da sua equipe

- Dados da conta: nome, e-mail, senha (guardada criptografada, nunca em texto puro), função e restaurante ao qual pertence.
- Dados legais do restaurante: razão social, NIT (CNPJ colombiano), endereço, cidade, regime tributário, RUT, resolução de numeração da DIAN e certificado de assinatura para a nota fiscal eletrônica, quando o restaurante ativa esse módulo.
- Dados para ativar os pagamentos on-line: as informações legais, de representação e bancárias que o gateway de pagamento exige para abrir a conta de recebimento do restaurante.
- Dados da assinatura: plano, histórico de cobranças e situação do pagamento.
- Dados de operação: cardápio, preços, mesas, pedidos, cobranças, estoque, turnos, folha de pagamento e contabilidade que o restaurante registra. Incluem dados pessoais dos funcionários do restaurante (nome, documento, salário e horas) quando o restaurante usa o módulo de folha de pagamento.
- Dados técnicos: endereço IP, navegador, dispositivo, data e hora de acesso e registros de atividade, para segurança e suporte.

### Dos clientes

- Ao pedir na mesa, sem cadastro: o nome que você digita para a mesa reconhecer você, os pratos que pede, as observações do pedido, a gorjeta que escolhe e o meio de pagamento usado. Sua sessão de convidado fica em um cookie que só identifica sua mesa naquele restaurante.
- Ao pagar com cartão, PSE ou Apple Pay: o pagamento é processado pela Kushki. **Os dados do seu cartão nunca passam pelos servidores do MESAPAY**: a Kushki os converte em um token e o MESAPAY só recebe o resultado do pagamento, os últimos dígitos e a bandeira.
- Ao pedir uma nota fiscal em seu nome: nome ou razão social, tipo e número do documento, e-mail e, se for o caso, endereço e telefone. Esses dados vão na nota fiscal eletrônica exigida pela DIAN.
- Ao criar uma conta em um restaurante: nome completo, número do documento de identidade, e-mail, celular (opcional), senha criptografada, os dispositivos de onde você entrou e seu histórico de pedidos naquele restaurante. A conta é daquele restaurante; em outro restaurante que use o MESAPAY você precisaria criar outra.
- Ao reservar: nome, celular, e-mail, número de pessoas, data e hora, e o sinal, se o restaurante o pedir.
- Ao avaliar um prato: a avaliação e o comentário que você escreve.

### Dos prospects

Nome do restaurante, nome e cargo da pessoa de contato, telefone, e-mail, cidade, anotações do acompanhamento comercial, reuniões agendadas e os e-mails que trocamos. Esses dados vêm de contato direto, de indicações ou de fontes públicas, como o site ou as redes sociais do restaurante.

## Para que usamos os dados

- Prestar o serviço: mostrar o cardápio, receber pedidos, cobrá-los, emitir notas fiscais, administrar reservas e operar os módulos que o restaurante tiver ativos.
- Processar os pagamentos pelo gateway e conciliá-los com os pedidos.
- Emitir e transmitir notas fiscais eletrônicas e notas de crédito à DIAN, e enviá-las por e-mail ao cliente que as pede.
- Cobrar a assinatura do restaurante e gerenciar seu plano.
- Enviar e-mails transacionais: confirmações de pedido e de reserva, notas fiscais, links de acesso, redefinição de senha e avisos da conta.
- Manter a segurança da plataforma: detectar fraudes, abusos e acessos não autorizados, e conservar registros de atividade.
- Responder perguntas do restaurante com o assistente de inteligência artificial, usando os dados de operação daquele restaurante.
- Dar suporte técnico e de uso.
- Oferecer o serviço a prospects e fazer o acompanhamento comercial.
- Melhorar o produto a partir de dados de uso agregados, que não identificam uma pessoa.
- Cumprir obrigações legais, contábeis e tributárias.

Não vendemos dados pessoais nem os usamos para publicidade de terceiros.

## Base legal e autorização

Tratamos os dados com uma destas bases:

- **Execução do contrato**: o necessário para prestar o serviço que o restaurante contratou ou para atender o pedido, o pagamento ou a reserva que o cliente faz.
- **Obrigação legal**: a nota fiscal eletrônica, a conservação de registros contábeis e tributários e as respostas às autoridades.
- **Autorização do titular**: para o restante, como a conta do cliente, o recebimento de comunicações comerciais ou o tratamento de dados de prospects. Você pode revogar a autorização a qualquer momento escrevendo para info@mesapay.co, salvo se uma obrigação legal ou contratual nos exigir conservar os dados.

Ao criar uma conta, pedir, pagar ou reservar no MESAPAY você aceita esta política. Se o restaurante carrega dados dos seus funcionários ou clientes, ele é responsável por ter a autorização que a lei exige.

## Dados sensíveis e menores de idade

O MESAPAY não pede dados sensíveis (saúde, orientação sexual, origem étnica, crenças, dados biométricos ou similares). Não escreva esse tipo de informação nas observações de um pedido ou em um comentário. O número do documento é pedido só para a conta do cliente e para a nota fiscal em seu nome, porque a lei tributária o exige para identificar o comprador.

Os serviços do MESAPAY são dirigidos a maiores de idade. Um menor pode ver o cardápio e pedir acompanhado de um adulto responsável, mas não deve criar uma conta nem registrar dados pessoais. Se soubermos que registramos dados de um menor sem a autorização do seu responsável, nós os apagamos.

## Com quem compartilhamos os dados

Compartilhamos dados só com quem precisa tratá-los para prestar o serviço, sob contratos que os obrigam a protegê-los e a usá-los unicamente para esse fim:

- **Kushki** (gateway de pagamento): recebe os dados do pagamento e, para os restaurantes, os dados que exige para abrir e operar a conta de recebimento. Os dados de cartão são tratados sob os padrões de segurança do setor de pagamentos que se aplicam à Kushki.
- **DIAN**: recebe as notas fiscais eletrônicas e notas de crédito que o restaurante emite, com os dados do comprador exigidos por lei. O MESAPAY as transmite diretamente, sem um provedor tecnológico intermediário.
- **Resend** (envio de e-mail): recebe o endereço e o conteúdo dos e-mails transacionais que enviamos.
- **Anthropic** (assistente de inteligência artificial): quando um usuário do restaurante faz uma pergunta ao assistente, enviamos ao modelo a pergunta e os dados de operação necessários para respondê-la (por exemplo, vendas, pratos ou turnos). Segundo os termos do serviço que usamos, a Anthropic não utiliza esses dados para treinar seus modelos. Não enviamos dados de cartões nem senhas.
- **Provedores de infraestrutura**: os servidores e o banco de dados do MESAPAY ficam hospedados em infraestrutura contratada de provedores de hospedagem, que só tratam os dados como operadores.
- **O restaurante que você visita**: seus pedidos, pagamentos, reservas, dados de nota fiscal e, se você a criou, sua conta, ficam visíveis para a equipe do restaurante onde você os registrou.
- **Autoridades**: quando uma lei ou uma ordem de autoridade competente o exigir.

## Transferências internacionais

Alguns desses provedores tratam os dados fora da Colômbia, principalmente nos Estados Unidos (envio de e-mail e assistente de inteligência artificial). Quando isso ocorre, exigimos do provedor um nível de proteção adequado por meio dos termos contratuais do seu serviço, conforme a lei colombiana exige para as transferências internacionais. Ao usar o MESAPAY você autoriza essas transferências na medida em que sejam necessárias para prestar o serviço.

## Por quanto tempo conservamos os dados

- **Contas de restaurantes e de clientes**: enquanto a conta existir. Quando ela é encerrada, apagamos ou anonimizamos os dados que não devamos conservar por outro motivo.
- **Pedidos, pagamentos, notas fiscais e registros contábeis**: pelo menos cinco (5) anos a partir da operação, ou o prazo maior exigido pelas normas contábeis e tributárias colombianas, porque são comprovantes das obrigações fiscais do restaurante.
- **Sessões de convidado**: o cookie dura o tempo da sua visita à mesa, e os pedidos ficam associados ao restaurante, não a uma pessoa identificada, salvo se você pedir nota fiscal em seu nome.
- **Prospects**: enquanto houver um acompanhamento comercial ativo ou até a pessoa pedir que os apaguemos.
- **Registros de segurança**: o tempo necessário para investigar incidentes, normalmente não mais de um ano.
- **Cópias de segurança**: fazemos cópias diárias do banco de dados e as conservamos por sete (7) dias. Um dado apagado pode permanecer nessas cópias até que sejam substituídas.

## Como protegemos os dados

Aplicamos medidas técnicas e organizacionais razoáveis: criptografia das comunicações (HTTPS), senhas guardadas com funções de hash, controle de acesso por função dentro de cada restaurante, sessões revogáveis, registros de atividade, cópias de segurança diárias e acesso restrito à infraestrutura. Nenhum sistema é infalível: se ocorrer um incidente que afete seus dados, notificaremos os afetados e a autoridade conforme a lei exigir.

## Seus direitos

Como titular dos dados você tem direito a:

- Conhecer, atualizar e corrigir seus dados.
- Solicitar prova da autorização que nos deu, salvo quando a lei não a exigir.
- Ser informado sobre o uso que demos a eles.
- Revogar a autorização e pedir a exclusão dos seus dados, quando não existir um dever legal ou contratual de conservá-los.
- Acessar gratuitamente seus dados.
- Apresentar queixas à Superintendência de Indústria e Comércio (SIC) por infrações à lei de proteção de dados.

Se você tem uma conta de cliente, pode ver e atualizar seu perfil, conferir seus dispositivos e encerrar suas sessões em Minha conta no restaurante. Os usuários de um restaurante podem atualizar seus dados pelo perfil no painel.

## Como exercer seus direitos

Escreva para info@mesapay.co a partir do e-mail cadastrado ou informando seu nome, tipo e número do documento, o restaurante onde registrou os dados (se for o caso) e o que você precisa. Se agir em nome de outra pessoa, anexe a autorização.

- **Consultas**: respondemos em no máximo dez (10) dias úteis a partir do recebimento da solicitação. Se não for possível nesse prazo, avisamos e respondemos dentro dos cinco (5) dias úteis seguintes.
- **Reclamações** (correção, exclusão, revogação ou suposto descumprimento): se a reclamação estiver incompleta, pediremos que a complete dentro dos cinco (5) dias seguintes; se passarem dois (2) meses sem resposta, entendemos que você desistiu. Uma vez completa, respondemos em no máximo quinze (15) dias úteis; se não for possível, avisamos e respondemos dentro dos oito (8) dias úteis seguintes.

Você só pode apresentar queixa à SIC depois de ter esgotado a consulta ou a reclamação com o MESAPAY.

Quando os dados foram registrados por um restaurante como responsável (por exemplo, um pedido ou uma reserva), podemos encaminhar sua solicitação ao restaurante ou atendê-la em coordenação com ele.

## Cookies

O MESAPAY usa só cookies necessários para funcionar:

- **Sessão da equipe do restaurante**: mantém a sessão de quem entra no painel ou no app do garçom.
- **Sessão do cliente**: mantém sua sessão de convidado na mesa e, se você criou uma conta, sua sessão naquele restaurante até você sair.
- **Idioma**: lembra o idioma que você escolheu (espanhol, inglês ou português).

Não usamos cookies de publicidade nem de rastreamento de terceiros. Você pode apagar os cookies pelo navegador; se fizer isso, terá que entrar de novo ou escanear outra vez o QR da mesa.

## Alterações nesta política

Podemos atualizar esta política quando o serviço, nossos provedores ou a lei mudarem. Publicaremos a versão vigente nesta página com a data de atualização e, se a mudança for relevante, avisaremos os restaurantes por e-mail. O uso do serviço após uma alteração implica sua aceitação.

## Vigência e contato

Esta política vigora a partir da data de publicação e enquanto o MESAPAY tratar dados pessoais. Os dados são conservados pelos prazos indicados acima.

Para consultas, reclamações e qualquer assunto sobre seus dados pessoais, escreva para info@mesapay.co. Esta política está disponível em espanhol, inglês e português; se houver diferenças entre as versões, prevalece a versão em espanhol. Consulte também os [Termos de serviço](/terminos).
`.trim();

export const PRIVACIDAD: LegalDocument = {
  updatedAt: "2026-11-02",
  es,
  en,
  pt,
};
