package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"mesapay.co/print-agent/internal/config"
	"mesapay.co/print-agent/internal/dedupe"
	"mesapay.co/print-agent/internal/logging"
)

// ── El banco de pruebas ──────────────────────────────────────────────
//
// Un MESAPAY falso (httptest) y una impresora térmica falsa (un socket
// TCP en 127.0.0.1). Entre los dos cubren el camino completo: los bytes
// entran por HTTP y tienen que salir por el socket, y el acuse tiene que
// volver. Es lo más cerca de una cocina real que se puede llegar sin un
// PC con Windows y una Xprinter enchufada.

type fakePrinter struct {
	ln       net.Listener
	mu       sync.Mutex
	received [][]byte
}

func newFakePrinter(t *testing.T) *fakePrinter {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f := &fakePrinter{ln: ln}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				data, _ := io.ReadAll(c)
				f.mu.Lock()
				f.received = append(f.received, data)
				f.mu.Unlock()
			}(conn)
		}
	}()
	t.Cleanup(func() { ln.Close() })
	return f
}

func (f *fakePrinter) host() string {
	h, _, _ := net.SplitHostPort(f.ln.Addr().String())
	return h
}

func (f *fakePrinter) port() int {
	_, p, _ := net.SplitHostPort(f.ln.Addr().String())
	n := 0
	for _, c := range p {
		n = n*10 + int(c-'0')
	}
	return n
}

func (f *fakePrinter) jobs() [][]byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([][]byte, len(f.received))
	copy(out, f.received)
	return out
}

// fakeServer es MESAPAY: entrega los trabajos que le carguemos y guarda
// los acuses que reciba.
type fakeServer struct {
	mu       sync.Mutex
	pending  []map[string]any
	acks     []ackRecord
	failAcks bool
	srv      *httptest.Server
}

type ackRecord struct {
	JobID string
	OK    bool
	Error string
}

func newFakeServer(t *testing.T) *fakeServer {
	t.Helper()
	fs := &fakeServer{}
	mux := http.NewServeMux()

	mux.HandleFunc("/api/print-agent/jobs", func(w http.ResponseWriter, r *http.Request) {
		fs.mu.Lock()
		jobs := fs.pending
		fs.pending = nil
		fs.mu.Unlock()
		if jobs == nil {
			jobs = []map[string]any{}
		}
		json.NewEncoder(w).Encode(map[string]any{
			"agent": map[string]string{"id": "ag1", "label": "Local de prueba"},
			"jobs":  jobs,
		})
	})

	mux.HandleFunc("/api/print-agent/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"ok": true, "agent": map[string]string{"id": "ag1", "label": "Local de prueba"},
			"printers": []any{}, "pendingJobs": 0,
		})
	})

	mux.HandleFunc("/api/print-agent/printers", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"printers": []any{}})
	})

	// El ack va al final porque el patrón es más general que los otros.
	mux.HandleFunc("/api/print-agent/jobs/", func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/ack") {
			http.NotFound(w, r)
			return
		}
		fs.mu.Lock()
		fail := fs.failAcks
		fs.mu.Unlock()
		if fail {
			// Se cayó el internet justo después de imprimir: el
			// escenario que obliga a que exista el dedupe.
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		jobID := parts[len(parts)-2]
		var body struct {
			OK    bool   `json:"ok"`
			Error string `json:"error"`
		}
		json.NewDecoder(r.Body).Decode(&body)

		fs.mu.Lock()
		fs.acks = append(fs.acks, ackRecord{JobID: jobID, OK: body.OK, Error: body.Error})
		fs.mu.Unlock()

		json.NewEncoder(w).Encode(map[string]any{
			"status": "printed", "willRetry": !body.OK, "attempts": 1, "maxAttempts": 5,
		})
	})

	fs.srv = httptest.NewServer(mux)
	t.Cleanup(fs.srv.Close)
	return fs
}

func (fs *fakeServer) enqueue(jobs ...map[string]any) {
	fs.mu.Lock()
	fs.pending = append(fs.pending, jobs...)
	fs.mu.Unlock()
}

func (fs *fakeServer) ackList() []ackRecord {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	return append([]ackRecord(nil), fs.acks...)
}

func (fs *fakeServer) setAcksFailing(v bool) {
	fs.mu.Lock()
	fs.failAcks = v
	fs.mu.Unlock()
}

func job(id string, payload []byte, host string, port int) map[string]any {
	return map[string]any{
		"id": id, "kind": "kitchen_round", "attempt": 1,
		"createdAt": time.Now().Format(time.RFC3339),
		"printer": map[string]any{
			"id": "prt-" + host, "label": "Cocina", "host": host, "port": port,
		},
		"data":  base64.StdEncoding.EncodeToString(payload),
		"bytes": len(payload),
	}
}

func newTestAgent(t *testing.T, serverURL string) *Agent {
	t.Helper()
	dir := t.TempDir()
	log := logging.New(filepath.Join(dir, "agent.log"), nil)
	t.Cleanup(func() { log.Close() })
	store := dedupe.Open(filepath.Join(dir, "state.json"))
	cfg := config.Config{
		ServerURL:        serverURL,
		Token:            "mpa_test",
		PollSeconds:      1,
		HeartbeatSeconds: 3600,
	}
	cfg.Normalize()
	return New(filepath.Join(dir, "config.json"), cfg, store, log, "test")
}

// runAgent arranca el agente y garantiza que esté COMPLETAMENTE parado
// antes de que el test termine. Sin esperar el cierre, los bucles siguen
// escribiendo (config, estado) mientras t.TempDir ya se está borrando, y
// el test falla por una carrera que no tiene nada que ver con lo que se
// está probando.
func runAgent(t *testing.T, a *Agent) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		a.Run(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("el agente no se detuvo en 5s")
		}
	})
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("se agotó la espera: %s", what)
}

// ── El test que importa ──────────────────────────────────────────────

func TestDePuntaAPuntaLosBytesLleganALaImpresoraYSeConfirma(t *testing.T) {
	fp := newFakePrinter(t)
	fs := newFakeServer(t)
	a := newTestAgent(t, fs.srv.URL)

	comanda := []byte{0x1b, 0x40, 'M', 'E', 'S', 'A', ' ', '4', 0x0a, 0x1d, 0x56, 0x42, 0x04}
	fs.enqueue(job("job-1", comanda, fp.host(), fp.port()))

	runAgent(t, a)

	waitFor(t, "que la comanda llegue a la impresora", func() bool { return len(fp.jobs()) == 1 })
	if got := string(fp.jobs()[0]); got != string(comanda) {
		t.Errorf("la impresora recibió %v, se esperaba %v", fp.jobs()[0], comanda)
	}

	waitFor(t, "que se confirme el trabajo", func() bool { return len(fs.ackList()) == 1 })
	ack := fs.ackList()[0]
	if ack.JobID != "job-1" || !ack.OK {
		t.Errorf("acuse = %+v, se esperaba job-1 ok", ack)
	}

	st := a.Status()
	if st.PrintedSinceStart != 1 {
		t.Errorf("impresas = %d", st.PrintedSinceStart)
	}
	if st.LastPrintedJobID != "job-1" {
		t.Errorf("último trabajo impreso = %q", st.LastPrintedJobID)
	}
}

func TestUnTrabajoReentregadoNoSeImprimeDosVeces(t *testing.T) {
	// El escenario exacto: se imprime, el ack se pierde, el servidor
	// re-entrega a los 2 minutos. La cocina NO puede ver el pedido dos
	// veces — se confirma y punto.
	fp := newFakePrinter(t)
	fs := newFakeServer(t)
	a := newTestAgent(t, fs.srv.URL)

	comanda := []byte("COMANDA MESA 7")
	fs.setAcksFailing(true) // el acuse se va a perder
	fs.enqueue(job("job-repetido", comanda, fp.host(), fp.port()))

	runAgent(t, a)

	waitFor(t, "la primera impresión", func() bool { return len(fp.jobs()) == 1 })

	// Vuelve el internet y el servidor re-entrega el mismo trabajo.
	fs.setAcksFailing(false)
	fs.enqueue(job("job-repetido", comanda, fp.host(), fp.port()))

	waitFor(t, "que se confirme la re-entrega", func() bool { return len(fs.ackList()) >= 1 })

	// Un momento extra por si estuviera imprimiendo de nuevo.
	time.Sleep(300 * time.Millisecond)

	if n := len(fp.jobs()); n != 1 {
		t.Fatalf("la impresora recibió %d comandas: la cocina vería el pedido repetido", n)
	}
	if ack := fs.ackList()[0]; !ack.OK {
		t.Errorf("la re-entrega debería confirmarse como impresa: %+v", ack)
	}
	if a.Status().DuplicatesSkipped != 1 {
		t.Errorf("repeticiones evitadas = %d, se esperaba 1", a.Status().DuplicatesSkipped)
	}
}

func TestImpresoraApagadaSeReportaConElMotivo(t *testing.T) {
	// Sin esto no habría forma de saber que un ticket se perdió — que es
	// justamente el agujero del esquema viejo con la pestaña de Chrome.
	fs := newFakeServer(t)
	a := newTestAgent(t, fs.srv.URL)
	a.Printer().ConnectTimeout = 200 * time.Millisecond

	// Un puerto donde no hay nadie escuchando.
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	h, p, _ := net.SplitHostPort(ln.Addr().String())
	port := 0
	for _, c := range p {
		port = port*10 + int(c-'0')
	}
	ln.Close()

	fs.enqueue(job("job-sin-impresora", []byte("x"), h, port))

	runAgent(t, a)

	waitFor(t, "que se reporte el fallo", func() bool { return len(fs.ackList()) == 1 })
	ack := fs.ackList()[0]
	if ack.OK {
		t.Fatal("se confirmó como impresa una comanda que nunca salió")
	}
	if !strings.Contains(ack.Error, "no se pudo conectar") {
		t.Errorf("el motivo no es diagnosticable: %q", ack.Error)
	}
	if !strings.Contains(ack.Error, h) {
		t.Errorf("el motivo no dice a qué dirección se intentó: %q", ack.Error)
	}
	if a.Status().FailedSinceStart != 1 {
		t.Errorf("fallidas = %d", a.Status().FailedSinceStart)
	}
}

func TestUnaImpresoraCaidaNoTrabaLasComandasDeOtra(t *testing.T) {
	// La barra apagada no puede dejar a la cocina esperando: los grupos
	// por impresora van en paralelo.
	fp := newFakePrinter(t)
	fs := newFakeServer(t)
	a := newTestAgent(t, fs.srv.URL)
	a.Printer().ConnectTimeout = 1500 * time.Millisecond

	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	muertaHost, muertaPortStr, _ := net.SplitHostPort(ln.Addr().String())
	muertaPort := 0
	for _, c := range muertaPortStr {
		muertaPort = muertaPort*10 + int(c-'0')
	}
	ln.Close()

	fs.enqueue(
		job("barra-1", []byte("trago"), muertaHost, muertaPort),
		job("cocina-1", []byte("plato"), fp.host(), fp.port()),
	)

	runAgent(t, a)

	// La de cocina tiene que salir sin esperar a que la de la barra
	// agote su timeout de conexión.
	start := time.Now()
	waitFor(t, "que salga la comanda de cocina", func() bool { return len(fp.jobs()) == 1 })
	if elapsed := time.Since(start); elapsed > 1200*time.Millisecond {
		t.Errorf("la comanda de cocina tardó %v: quedó esperando a la impresora caída", elapsed)
	}
}

func TestVariasComandasALaMismaImpresoraSalenEnOrden(t *testing.T) {
	// Dentro de una misma impresora el orden importa: una cocina espera
	// las comandas en el orden en que se pidieron.
	fp := newFakePrinter(t)
	fs := newFakeServer(t)
	a := newTestAgent(t, fs.srv.URL)

	fs.enqueue(
		job("j1", []byte("PRIMERA"), fp.host(), fp.port()),
		job("j2", []byte("SEGUNDA"), fp.host(), fp.port()),
		job("j3", []byte("TERCERA"), fp.host(), fp.port()),
	)

	runAgent(t, a)

	waitFor(t, "las tres comandas", func() bool { return len(fp.jobs()) == 3 })
	got := fp.jobs()
	for i, want := range []string{"PRIMERA", "SEGUNDA", "TERCERA"} {
		if string(got[i]) != want {
			t.Errorf("comanda %d = %q, se esperaba %q", i, got[i], want)
		}
	}
}

func TestUnaComandaCorruptaSeDaPorPerdidaYNoTrabaLaCola(t *testing.T) {
	// Si no se confirma, el servidor la re-entrega cada 2 minutos y tapa
	// todo lo demás hasta agotar los intentos.
	fp := newFakePrinter(t)
	fs := newFakeServer(t)
	a := newTestAgent(t, fs.srv.URL)

	rota := job("job-roto", []byte("x"), fp.host(), fp.port())
	rota["data"] = "esto no es base64 %%%"

	fs.enqueue(rota, job("job-bueno", []byte("OK"), fp.host(), fp.port()))

	runAgent(t, a)

	waitFor(t, "los dos acuses", func() bool { return len(fs.ackList()) == 2 })

	var roto, bueno *ackRecord
	for i := range fs.ackList() {
		a := fs.ackList()[i]
		if a.JobID == "job-roto" {
			roto = &a
		}
		if a.JobID == "job-bueno" {
			bueno = &a
		}
	}
	if roto == nil || roto.OK {
		t.Errorf("la comanda rota debería reportarse como fallida: %+v", roto)
	}
	if bueno == nil || !bueno.OK {
		t.Errorf("la comanda buena debería salir igual: %+v", bueno)
	}
	if len(fp.jobs()) != 1 {
		t.Errorf("la impresora recibió %d comandas, se esperaba sólo la buena", len(fp.jobs()))
	}
}

func TestSinTokenNoSeGolpeaAlServidor(t *testing.T) {
	var hits int32
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	dir := t.TempDir()
	log := logging.New(filepath.Join(dir, "agent.log"), nil)
	defer log.Close()
	cfg := config.Config{ServerURL: srv.URL, PollSeconds: 1, HeartbeatSeconds: 3600}
	cfg.Normalize()
	a := New(filepath.Join(dir, "config.json"), cfg,
		dedupe.Open(filepath.Join(dir, "state.json")), log, "test")

	ctx, cancel := context.WithTimeout(context.Background(), 600*time.Millisecond)
	defer cancel()
	a.Run(ctx)

	mu.Lock()
	defer mu.Unlock()
	if hits != 0 {
		t.Errorf("hubo %d requests sin token: no hay que generar 401 en bucle", hits)
	}
}

func TestApplyConfigCambiaElServidorSinReiniciar(t *testing.T) {
	// Corregir la IP de una impresora no puede exigir reiniciar el PC de
	// la caja ni saber que existe un servicio de Windows.
	fp := newFakePrinter(t)
	fs := newFakeServer(t)
	a := newTestAgent(t, "https://servidor-que-no-existe.invalid")

	runAgent(t, a)

	time.Sleep(150 * time.Millisecond)

	cfg := a.Config()
	cfg.ServerURL = fs.srv.URL
	a.ApplyConfig(cfg)

	fs.enqueue(job("post-cambio", []byte("HOLA"), fp.host(), fp.port()))
	waitFor(t, "que imprima con el servidor nuevo", func() bool { return len(fp.jobs()) == 1 })
}
