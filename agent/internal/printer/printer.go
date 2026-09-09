// Package printer escribe bytes ESC/POS crudos en una impresora térmica
// de red.
//
// Esto es TODO lo que el agente sabe hacer con una impresora: abrir un
// socket, escribir lo que le dieron, cerrar. No arma tickets, no sabe
// qué es una comanda, no interpreta los bytes. Es a propósito: si el
// diseño del ticket vive en el servidor, cambiarlo no obliga a
// reinstalar el .exe en cada cocina del país.
package printer

import (
	"errors"
	"fmt"
	"net"
	"time"
)

// Tiempos de espera. Son cortos porque una impresora en la MISMA red
// local contesta en milisegundos: si tarda 5 segundos en aceptar la
// conexión, está apagada o alguien le cambió la IP, y conviene fallar y
// que el servidor reintente antes que trabar la cola.
const (
	DefaultConnectTimeout = 5 * time.Second
	DefaultWriteTimeout   = 15 * time.Second
)

// Kind clasifica el fallo. La distinción importa para el diagnóstico:
// "no conecta" manda a mirar el cable y la IP, "se cortó a la mitad"
// manda a mirar el papel y el cabezal.
type Kind string

const (
	// KindConnect: no se llegó a abrir el socket. Impresora apagada, IP
	// equivocada, o en otra red (el caso clásico: el PC en WiFi de
	// invitados y la impresora en la red del local).
	KindConnect Kind = "conexion"
	// KindWrite: la conexión abrió pero la escritura falló. Suele ser la
	// impresora reiniciándose o cortando la conexión.
	KindWrite Kind = "escritura"
	// KindTimeout: aceptó la conexión pero dejó de leer. Típico de
	// impresora sin papel con el buffer lleno.
	KindTimeout Kind = "timeout"
)

// Error es un fallo de impresión con su causa clasificada y cuántos
// bytes alcanzaron a salir.
//
// BytesWritten > 0 es la información incómoda pero necesaria: puede
// haber salido media comanda. Va en el mensaje que se le manda al
// servidor para que quede en el historial.
type Error struct {
	Kind         Kind
	Addr         string
	BytesWritten int
	Err          error
}

func (e *Error) Error() string {
	switch e.Kind {
	case KindConnect:
		return fmt.Sprintf("no se pudo conectar a la impresora %s: %v", e.Addr, e.Err)
	case KindTimeout:
		return fmt.Sprintf("la impresora %s dejó de responder tras %d bytes: %v",
			e.Addr, e.BytesWritten, e.Err)
	default:
		return fmt.Sprintf("la impresión en %s se cortó tras %d bytes: %v",
			e.Addr, e.BytesWritten, e.Err)
	}
}

func (e *Error) Unwrap() error { return e.Err }

// KindOf saca la clasificación de un error devuelto por Print.
func KindOf(err error) (Kind, bool) {
	var pe *Error
	if errors.As(err, &pe) {
		return pe.Kind, true
	}
	return "", false
}

// Client abre una conexión por trabajo.
//
// Nada de pool ni de conexión persistente: las térmicas baratas aceptan
// UNA conexión a la vez y se quedan colgadas si alguien la deja abierta.
// Abrir y cerrar por comanda es lento en papel y correcto en la práctica.
type Client struct {
	ConnectTimeout time.Duration
	WriteTimeout   time.Duration
	// dial se inyecta en los tests; en producción es net.DialTimeout.
	dial func(network, addr string, timeout time.Duration) (net.Conn, error)
}

// NewClient devuelve un cliente con los tiempos por defecto.
func NewClient() *Client {
	return &Client{
		ConnectTimeout: DefaultConnectTimeout,
		WriteTimeout:   DefaultWriteTimeout,
		dial:           net.DialTimeout,
	}
}

// Print escribe data en addr ("192.168.1.50:9100") y cierra.
//
// Devuelve nil cuando TODOS los bytes salieron por el socket. Ojo con lo
// que eso significa y lo que no: significa que la impresora los aceptó,
// no que el papel haya salido. Una térmica sin papel acepta los bytes y
// se los come. Es el techo de lo que se puede saber por TCP crudo, y es
// el mismo techo que tenía el esquema viejo con window.print().
func (c *Client) Print(addr string, data []byte) error {
	connectTimeout := c.ConnectTimeout
	if connectTimeout <= 0 {
		connectTimeout = DefaultConnectTimeout
	}
	writeTimeout := c.WriteTimeout
	if writeTimeout <= 0 {
		writeTimeout = DefaultWriteTimeout
	}
	dial := c.dial
	if dial == nil {
		dial = net.DialTimeout
	}

	conn, err := dial("tcp", addr, connectTimeout)
	if err != nil {
		return &Error{Kind: KindConnect, Addr: addr, Err: err}
	}
	defer conn.Close()

	// Sin Nagle: una comanda son pocos cientos de bytes y no queremos
	// que el stack los retenga esperando a llenar un segmento.
	if tcp, ok := conn.(*net.TCPConn); ok {
		_ = tcp.SetNoDelay(true)
	}

	if err := conn.SetWriteDeadline(time.Now().Add(writeTimeout)); err != nil {
		return &Error{Kind: KindWrite, Addr: addr, Err: err}
	}

	n, err := conn.Write(data)
	if err != nil {
		kind := KindWrite
		var ne net.Error
		if errors.As(err, &ne) && ne.Timeout() {
			kind = KindTimeout
		}
		return &Error{Kind: kind, Addr: addr, BytesWritten: n, Err: err}
	}
	if n != len(data) {
		return &Error{
			Kind:         KindWrite,
			Addr:         addr,
			BytesWritten: n,
			Err:          fmt.Errorf("se escribieron %d de %d bytes", n, len(data)),
		}
	}

	// CloseWrite antes del Close: le avisa a la impresora que no viene
	// más nada, en vez de cortarle el socket de un tirón. Algunas
	// térmicas descartan lo que tienen en el buffer ante un RST.
	if tcp, ok := conn.(*net.TCPConn); ok {
		_ = tcp.CloseWrite()
	}
	return nil
}
