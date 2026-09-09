package printer

import (
	"bytes"
	"errors"
	"io"
	"net"
	"sync"
	"testing"
	"time"
)

// fakePrinter es una impresora térmica de mentira: un socket TCP que
// acepta una conexión y guarda todo lo que le escriben. Es lo más cerca
// que se puede estar de una Xprinter sin tener una en el escritorio.
type fakePrinter struct {
	ln       net.Listener
	mu       sync.Mutex
	received []byte
	conns    int
	// stall hace que deje de leer, para simular la impresora sin papel
	// con el buffer lleno.
	stall bool
}

func newFakePrinter(t *testing.T) *fakePrinter {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("no se pudo abrir la impresora falsa: %v", err)
	}
	f := &fakePrinter{ln: ln}
	go f.serve()
	t.Cleanup(func() { ln.Close() })
	return f
}

func (f *fakePrinter) serve() {
	for {
		conn, err := f.ln.Accept()
		if err != nil {
			return
		}
		f.mu.Lock()
		f.conns++
		stall := f.stall
		f.mu.Unlock()

		go func(c net.Conn) {
			defer c.Close()
			if stall {
				// Aceptada pero sin leer nunca: el que escribe se va a
				// llenar el buffer y a chocar con su deadline.
				time.Sleep(30 * time.Second)
				return
			}
			data, _ := io.ReadAll(c)
			f.mu.Lock()
			f.received = append(f.received, data...)
			f.mu.Unlock()
		}(conn)
	}
}

func (f *fakePrinter) addr() string { return f.ln.Addr().String() }

func (f *fakePrinter) bytesReceived() []byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]byte(nil), f.received...)
}

func (f *fakePrinter) waitFor(t *testing.T, n int) []byte {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if got := f.bytesReceived(); len(got) >= n {
			return got
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("la impresora falsa recibió %d bytes, se esperaban %d",
		len(f.bytesReceived()), n)
	return nil
}

func TestPrintEntregaLosBytesExactos(t *testing.T) {
	fp := newFakePrinter(t)
	// Bytes ESC/POS de verdad, incluidos 0x00 y 0xFF: si algo por el
	// camino tratara esto como texto, este test lo caza.
	payload := []byte{0x1b, 0x40, 'H', 'o', 'l', 'a', 0x00, 0xff, 0x0a, 0x1d, 0x56, 0x42, 0x04}

	if err := NewClient().Print(fp.addr(), payload); err != nil {
		t.Fatalf("Print: %v", err)
	}
	got := fp.waitFor(t, len(payload))
	if !bytes.Equal(got, payload) {
		t.Errorf("la impresora recibió %v, se esperaba %v", got, payload)
	}
}

func TestPrintImpresoraApagadaDaErrorDeConexion(t *testing.T) {
	// Se abre y se cierra enseguida para quedarse con un puerto que
	// seguro no tiene a nadie escuchando.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()

	err = NewClient().Print(addr, []byte("hola"))
	if err == nil {
		t.Fatal("se esperaba un error: no hay nadie escuchando")
	}
	kind, ok := KindOf(err)
	if !ok || kind != KindConnect {
		t.Errorf("clasificación = %q (ok=%v), se esperaba %q", kind, ok, KindConnect)
	}
	// El mensaje lo va a leer alguien en una cocina: tiene que decir
	// dónde intentó conectar.
	var pe *Error
	if !errors.As(err, &pe) {
		t.Fatal("el error debería ser *printer.Error")
	}
	if pe.Addr != addr {
		t.Errorf("el error no dice la dirección: %q", pe.Addr)
	}
}

func TestPrintImpresoraQueNoLeeDaTimeout(t *testing.T) {
	fp := newFakePrinter(t)
	fp.mu.Lock()
	fp.stall = true
	fp.mu.Unlock()

	c := NewClient()
	c.WriteTimeout = 150 * time.Millisecond
	// Payload grande para llenar el buffer del socket: con pocos bytes
	// el kernel los acepta y el Write vuelve sin esperar a nadie.
	big := bytes.Repeat([]byte("A"), 8<<20)

	start := time.Now()
	err := c.Print(fp.addr(), big)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("se esperaba un timeout")
	}
	if kind, _ := KindOf(err); kind != KindTimeout {
		t.Errorf("clasificación = %q, se esperaba %q (%v)", kind, KindTimeout, err)
	}
	if elapsed > 3*time.Second {
		t.Errorf("el timeout tardó %v: debería respetar WriteTimeout", elapsed)
	}
}

func TestPrintRespetaElTimeoutDeConexion(t *testing.T) {
	c := NewClient()
	c.ConnectTimeout = 100 * time.Millisecond
	// 203.0.113.0/24 es TEST-NET-3 (RFC 5737): no se enruta a ningún
	// lado, así que el dial se queda esperando hasta el deadline.
	start := time.Now()
	err := c.Print("203.0.113.1:9100", []byte("x"))
	if err == nil {
		t.Fatal("se esperaba un error")
	}
	if kind, _ := KindOf(err); kind != KindConnect {
		t.Errorf("clasificación = %q, se esperaba %q", kind, KindConnect)
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Errorf("tardó %v: no está respetando ConnectTimeout", elapsed)
	}
}

func TestPrintAbreUnaConexionPorTrabajo(t *testing.T) {
	// Las térmicas baratas aceptan una conexión a la vez y se cuelgan si
	// alguien la deja abierta. Cada trabajo tiene que abrir y cerrar.
	fp := newFakePrinter(t)
	c := NewClient()
	for i := 0; i < 3; i++ {
		if err := c.Print(fp.addr(), []byte("comanda")); err != nil {
			t.Fatalf("Print %d: %v", i, err)
		}
	}
	fp.waitFor(t, len("comanda")*3)
	fp.mu.Lock()
	conns := fp.conns
	fp.mu.Unlock()
	if conns != 3 {
		t.Errorf("conexiones = %d, se esperaban 3 (una por trabajo)", conns)
	}
}

func TestTestTicketLlevaLosComandosImprescindibles(t *testing.T) {
	data := TestTicket("Cocina", "192.168.1.50:9100", 80)

	if !bytes.HasPrefix(data, []byte{0x1b, 0x40}) {
		t.Error("el ticket tiene que empezar con ESC @ (reset), si no arrastra el estado del ticket anterior")
	}
	if !bytes.Contains(data, []byte{0x1b, 0x74, 0x02}) {
		t.Error("falta ESC t 2 (CP850): sin eso las eñes salen rotas")
	}
	if !bytes.Contains(data, []byte{0x1d, 0x56, 0x42}) {
		t.Error("falta el corte de papel (GS V 66)")
	}
	// La dirección tiene que salir impresa: es lo que confirma que el
	// papel salió por la impresora que uno cree.
	if !bytes.Contains(data, []byte("192.168.1.50:9100")) {
		t.Error("el ticket no imprime la dirección de la impresora")
	}
	if !bytes.Contains(data, []byte("MESAPAY")) {
		t.Error("el ticket no dice MESAPAY")
	}
}

func TestTestTicketCodificaAcentosEnCP850NoEnUTF8(t *testing.T) {
	data := TestTicket("Cocina", "1.2.3.4:9100", 80)
	// "Ñ" en CP850 es 0xA5. En UTF-8 sería 0xC3 0x91: si aparece eso,
	// la comanda saldría como "Ã‘".
	if !bytes.Contains(data, []byte{0xa5}) {
		t.Error("no se encontró Ñ codificada en CP850 (0xA5)")
	}
	if bytes.Contains(data, []byte{0xc3, 0x91}) {
		t.Error("hay UTF-8 crudo en el ticket: la impresora lo mostraría como basura")
	}
}

func TestTestTicketSeAdaptaAlPapelDe58(t *testing.T) {
	ancho := TestTicket("Cocina", "1.2.3.4:9100", 80)
	angosto := TestTicket("Cocina", "1.2.3.4:9100", 58)
	if !bytes.Contains(ancho, bytes.Repeat([]byte("="), 48)) {
		t.Error("en 80mm la línea separadora debería ser de 48 columnas")
	}
	if !bytes.Contains(angosto, bytes.Repeat([]byte("="), 32)) {
		t.Error("en 58mm la línea separadora debería ser de 32 columnas")
	}
	if bytes.Contains(angosto, bytes.Repeat([]byte("="), 48)) {
		t.Error("en 58mm no puede haber líneas de 48 columnas: se cortarían")
	}
}
