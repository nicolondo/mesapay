# Agente de impresión MESAPAY

Programa que corre en un PC del local, recibe las comandas de MESAPAY y las
manda a las impresoras térmicas de la red.

Reemplaza el sistema viejo —una pestaña de Chrome abierta llamando a
`window.print()`— que perdía comandas en silencio apenas alguien cambiaba de
pestaña o el navegador dormía la pestaña de fondo.

**Índice**

- [Qué hace y qué no](#qué-hace-y-qué-no)
- [Instalación](#instalación)
- [Vincular con el comercio](#vincular-con-el-comercio)
- [Configurar las impresoras](#configurar-las-impresoras)
- [Cuando no imprime](#cuando-no-imprime)
- [Dónde está todo](#dónde-está-todo)
- [Para desarrolladores](#para-desarrolladores)

---

## Qué hace y qué no

MESAPAY arma la comanda entera —el diseño, la letra, el corte de papel— y se la
manda al agente ya lista, como bytes. El agente abre una conexión con la
impresora, escribe esos bytes y avisa si salió o no.

**El agente no sabe qué es una comanda.** No la arma, no la formatea, no la
entiende. Esto es a propósito: cuando cambie el diseño del ticket, cambia sólo
MESAPAY y **no hay que actualizar el programa en ninguna cocina del país**.

La única excepción es el ticket de *prueba* del botón "Imprimir prueba", que sí
lo genera el agente — porque tiene que funcionar aunque MESAPAY esté caído o el
token todavía no esté pegado.

---

## Instalación

Requisitos: Windows 64 bits, y que el PC esté en la **misma red** que las
impresoras.

### 1. Copiar el programa

Copiá `mesapay-print-agent.exe` a una carpeta permanente, por ejemplo:

```
C:\Program Files\MESAPAY\mesapay-print-agent.exe
```

No lo dejes en el Escritorio ni en Descargas: el servicio va a apuntar a esa
ruta para siempre, y si alguien mueve el archivo el servicio deja de arrancar.

### 2. Instalarlo como servicio

Abrí **Símbolo del sistema como Administrador** (botón derecho → "Ejecutar como
administrador") y ejecutá:

```bat
cd "C:\Program Files\MESAPAY"
mesapay-print-agent.exe install
mesapay-print-agent.exe start
```

Eso registra el servicio `MesapayPrintAgent`, lo pone en arranque **automático**
y configura que Windows lo reinicie solo si se cae (a los 5s, 10s y 30s).

Se instala como servicio y no como programa de inicio porque tiene que arrancar
con la máquina **sin que nadie inicie sesión**: el PC de la caja se enciende a
las 7am y se queda en la pantalla de login hasta que llega alguien.

<details>
<summary>Equivalente con <code>sc.exe</code> (si preferís los comandos crudos)</summary>

Ojo con los espacios después de los `=`: son obligatorios y es el error más
común.

```bat
sc.exe create MesapayPrintAgent ^
  binPath= "\"C:\Program Files\MESAPAY\mesapay-print-agent.exe\"" ^
  start= auto ^
  DisplayName= "MESAPAY - Agente de impresion"

sc.exe description MesapayPrintAgent "Recibe las comandas de MESAPAY y las envia a las impresoras termicas del local."

sc.exe failure MesapayPrintAgent reset= 86400 actions= restart/5000/restart/10000/restart/30000

sc.exe start MesapayPrintAgent
```
</details>

### 3. Comprobar que arrancó

```bat
sc.exe query MesapayPrintAgent
```

Tiene que decir `STATE : 4 RUNNING`. También aparece en **services.msc** como
"MESAPAY - Agente de impresión".

### Desinstalar

```bat
mesapay-print-agent.exe stop
mesapay-print-agent.exe uninstall
```

La configuración y los logs **no** se borran: si se reinstala, no hay que volver
a pegar el token.

---

## Vincular con el comercio

1. En un navegador de ese PC, abrí **http://127.0.0.1:9110**

   Es la página de configuración del agente. Sólo se puede abrir **desde ese
   PC**: no es accesible desde ningún otro equipo de la red, ni desde el WiFi
   del local. Podés cerrarla cuando termines — el servicio sigue funcionando
   igual con la página cerrada.

2. En MESAPAY, entrá a **Configuración → Impresión** y generá un token para este
   agente. **Se muestra una sola vez.** Copialo completo (empieza con `mpa_`).

3. Pegalo en el campo "Token de vinculación" y tocá **Probar la conexión**.

   - Si dice *Conectado a «...»*, listo.
   - Si dice que el token fue rechazado, volvé a copiarlo. El error más común es
     pegarlo cortado o con un espacio adelante.

4. Tocá **Guardar configuración**.

---

## Configurar las impresoras

Se pueden configurar **varias**: cocina, barra y caja pueden ser tres equipos
distintos. Por cada una, en la misma página:

| Campo | Qué poner |
|---|---|
| **Nombre** | Cómo la vas a reconocer: "Cocina", "Barra cócteles", "Caja". |
| **IP o nombre en la red** | La dirección de la impresora en la red del local. |
| **Puerto** | `9100`, salvo que la impresora indique otro. |
| **Estación** | A qué área sirve: Cocina, Barra, o Mostrador/caja. |
| **Sub-estación de barra** | Sólo si la estación es Barra y el comercio tiene sub-estaciones definidas. Vacío = recibe **todo** lo de la barra. |
| **Ancho del papel** | 80 mm (lo normal) o 58 mm (rollo angosto). |

### Cómo averiguar la IP de una impresora

Casi todas la imprimen solas: **apagala, mantené apretado el botón FEED, y
encendela sin soltarlo**. Sale una tirilla con la configuración de red, donde
dice `IP Address`.

Si la impresora está en DHCP, pedile al que maneja la red que le **fije la IP**
(reserva por MAC en el router). Si no, el día que se reinicie el router la
impresora puede cambiar de dirección y las comandas dejan de salir sin que nadie
haya tocado nada.

### Probar

El botón **Imprimir prueba** de cada impresora manda una tirilla generada en el
momento. Funciona sin internet y sin token: sirve justo para confirmar que la IP
que acabás de escribir es la impresora que tenés enfrente.

Si sale papel con el nombre y la dirección que pusiste, esa impresora está bien.

Cuando termines, **Guardar configuración**. Se aplica al instante: no hay que
reiniciar el servicio ni el PC.

---

## Cuando no imprime

Abrí **http://127.0.0.1:9110** y mirá el bloque **ESTADO** de arriba. Responde la
única pregunta que importa: ¿el problema es el internet, el token, o la
impresora?

### "Sin conexión con MESAPAY"

El PC no está llegando al servidor.

1. ¿Ese PC abre `https://mesapay.co` en el navegador? Si no, es el internet del
   local.
2. Si abre bien pero el agente igual falla, mirá el **último error** en la misma
   pantalla. Si dice que el token no es válido o fue revocado, hay que generar
   uno nuevo en MESAPAY y pegarlo otra vez.

### Conectado, pero no sale papel

Mirá **Última comanda impresa** y **Impresas / fallidas**.

- **Fallidas > 0**: el agente intentó y la impresora no respondió. El "último
  error" dice a qué dirección intentó conectar. Tocá "Imprimir prueba" en esa
  impresora para confirmarlo.
- **Todo en 0 y "En cola en el servidor" también en 0**: MESAPAY no está
  generando comandas para este local. El problema no está acá, está en la
  configuración de impresión del comercio (¿la categoría del plato tiene
  estación asignada?).
- **"En cola en el servidor" creciendo**: hay comandas esperando y no se están
  entregando. Revisá que el agente esté vinculado y sin errores.

### Qué revisar en la impresora

Los tres de siempre, en este orden:

1. **¿Está encendida y con papel?** Una térmica sin papel acepta la conexión y
   se come los bytes: para el agente "salió bien".
2. **¿Está en la misma red que el PC?** El clásico: el PC quedó conectado al
   WiFi de invitados y la impresora está en la red del local. Desde el PC:
   `ping 192.168.1.50`.
3. **¿Le cambió la IP?** Imprimí la configuración de la impresora (FEED al
   encender) y comparala con la que está guardada en la página.

### El servicio no arranca

```bat
sc.exe query MesapayPrintAgent
```

Si dice `STOPPED`, mirá el log (abajo). La causa más común es que alguien **movió
o renombró el .exe** después de instalarlo: hay que desinstalar y volver a
instalar desde la ruta nueva.

### La página no abre

Si `http://127.0.0.1:9110` no responde pero el servicio está corriendo, es que
otro programa ocupó el puerto 9110. El agente lo dice en el log y **sigue
imprimiendo igual**. Para cambiarlo, editá `uiPort` en el archivo de
configuración y reiniciá el servicio.

---

## Dónde está todo

| Qué | Dónde |
|---|---|
| Configuración | `C:\ProgramData\MESAPAY\agent\config.json` |
| Log actual | `C:\ProgramData\MESAPAY\agent\logs\agent.log` |
| Logs anteriores | `agent.log.1` … `agent.log.5` (rotan solos, 2 MB cada uno) |
| Memoria de lo impreso | `C:\ProgramData\MESAPAY\agent\state.json` |

`C:\ProgramData` está oculto por defecto: pegá la ruta directamente en la barra
del Explorador.

**Cuando pidas soporte, mandá el `agent.log`.** Es lo único que vamos a tener
para saber qué pasó.

Para ver un resumen rápido sin abrir archivos:

```bat
mesapay-print-agent.exe config
```

### Sobre `state.json`

Guarda los identificadores de las comandas que ya salieron, para no imprimir la
misma dos veces si el acuse se pierde. **No lo borres** salvo que alguien te lo
pida: sin ese archivo, una caída de internet en el momento justo puede hacer que
la cocina reciba un pedido repetido.

---

## Para desarrolladores

### Compilar

Requiere Go 1.24 o superior. No hace falta nada más — ni cgo, ni el toolchain de
Windows.

```bash
cd agent

# El .exe para el local (desde macOS, Linux o Windows)
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build \
  -trimpath -ldflags "-s -w -X main.version=1.0.0" \
  -o dist/mesapay-print-agent.exe ./cmd/mesapay-print-agent
```

Sale **un solo archivo de ~7,5 MB**, sin dependencias de runtime: la página de
configuración va embebida dentro del binario. Se elige Go exactamente por eso —
instalar en una cocina es copiar un archivo.

`version` viaja en cada latido, así que desde el panel se puede ver qué local
quedó con una versión vieja sin llamar a nadie. **Ponelo siempre al compilar una
release.**

### Probar

```bash
go vet ./...
go test ./...
go test -race ./...
```

En macOS o Linux el agente corre en primer plano, sin servicio:

```bash
MESAPAY_AGENT_CONFIG=/tmp/mesapay/config.json go run ./cmd/mesapay-print-agent
```

Abre la página de configuración en `http://127.0.0.1:9110` igual que en Windows.
`MESAPAY_AGENT_CONFIG` también sirve en Windows para correr dos agentes en la
misma máquina durante una migración.

### Cómo está armado

```
cmd/mesapay-print-agent/   arranque, subcomandos, detección de servicio
internal/config/           config.json: leer, validar, guardar (atómico)
internal/api/              cliente de /api/print-agent/* — espejo del servidor
internal/printer/          escribir bytes por TCP + el ticket de prueba
internal/dedupe/           qué comandas ya salieron (contra los duplicados)
internal/agent/            los tres bucles: trabajos, latido, sincronización
internal/ui/               la página de configuración (embebida)
internal/winsvc/           integración con el servicio de Windows
```

### El contrato con el servidor

Está implementado en `src/app/api/print-agent/` de este mismo repo. **Esa es la
fuente de verdad**; si algo no coincide, el que está mal es el agente.

| Ruta | Para qué |
|---|---|
| `GET /api/print-agent/jobs?limit=N` | Pedir comandas. Las devuelve con los bytes ESC/POS en base64 y las marca como entregadas. |
| `POST /api/print-agent/jobs/{id}/ack` | `{ok:true}` o `{ok:false, error:"..."}`. |
| `POST /api/print-agent/heartbeat` | Latido con la versión del binario. |
| `POST /api/print-agent/printers` | Declarar las impresoras locales (reemplazo total). |

Todas piden `Authorization: Bearer mpa_<hex>`.

**El endpoint es de sondeo, no de long-polling** (la ruta responde y cierra), así
que el agente pregunta cada 3 segundos. Cuando no hay nada, la espera se estira
hasta 6 segundos como mucho — más que eso ya se nota en la cocina. Cuando el
servidor falla, la espera escala de 5 a 60 segundos con jitter, para que 40
locales que perdieron la conexión a la vez no vuelvan todos juntos.

### Las dos garantías que importan

**No perder comandas.** El agente confirma *siempre*, con éxito o con el motivo
del fallo. Una comanda sin confirmar el servidor la re-entrega a los 2 minutos.
Si el PC se apaga a mitad de un trabajo, al volver se imprime lo que quedó
debiendo.

**No duplicarlas.** El caso incómodo: los bytes salieron pero el acuse se perdió.
El servidor va a re-entregar. Por eso el id de cada comanda impresa se anota en
disco (con `fsync`) *antes* de intentar el acuse: cuando el trabajo vuelve, se
reconoce y se confirma **sin volver a imprimir**.

Queda una ventana de milisegundos entre "la impresora aceptó los bytes" y "el id
quedó en el disco". Un corte de luz exactamente ahí puede duplicar una comanda.
Es inevitable sin transacciones en la impresora, y es el lado correcto en el que
equivocarse: un plato de más se ve y se resuelve; uno que nunca se cocinó, no.

### Sobre el idioma

El resto de MESAPAY es trilingüe (es/en/pt) vía `next-intl`. **Este programa está
sólo en español**, y es deliberado: no lo ve ningún comensal. Lo ve quien instala
y quien diagnostica, en locales de Colombia. Meter un sistema de traducciones
acá agregaría complejidad al binario sin un solo usuario que la aproveche. Si
algún día MESAPAY se instala fuera de Latinoamérica, hay que revisar esta
decisión.
