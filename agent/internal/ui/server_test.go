package ui

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"mesapay.co/print-agent/internal/agent"
	"mesapay.co/print-agent/internal/config"
	"mesapay.co/print-agent/internal/dedupe"
	"mesapay.co/print-agent/internal/logging"
)

func newTestUI(t *testing.T) (*Server, string) {
	t.Helper()
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.json")
	log := logging.New(filepath.Join(dir, "agent.log"), nil)
	t.Cleanup(func() { log.Close() })

	cfg := config.Default()
	cfg.Token = "mpa_0123456789abcd"
	cfg.Printers = []config.Printer{
		{LocalKey: "cocina", Label: "Cocina", Host: "192.168.1.50", Port: 9100,
			Station: "kitchen", PaperWidthMm: 80, Active: true},
	}
	a := agent.New(cfgPath, cfg, dedupe.Open(filepath.Join(dir, "state.json")), log, "test")
	return New(a, cfgPath, log, 9110), cfgPath
}

// post arma un request como lo haría la página: loopback, JSON, y Host
// local. Los tests que prueban las defensas lo modifican a propósito.
func post(t *testing.T, path string, body any) *http.Request {
	t.Helper()
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "127.0.0.1:54321"
	req.Host = "127.0.0.1:9110"
	return req
}

func handler(s *Server) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleIndex)
	mux.HandleFunc("/api/state", s.guard(s.handleState))
	mux.HandleFunc("/api/config", s.guard(s.handleSaveConfig))
	mux.HandleFunc("/api/test-print", s.guard(s.handleTestPrint))
	return mux
}

func TestElEstadoNuncaDevuelveElTokenCompleto(t *testing.T) {
	// Es el secreto que da acceso al comercio entero. Que la página sea
	// loopback no es razón para exponerlo.
	s, _ := newTestUI(t)
	req := httptest.NewRequest(http.MethodGet, "/api/state", nil)
	req.RemoteAddr = "127.0.0.1:1234"
	req.Host = "127.0.0.1:9110"
	rec := httptest.NewRecorder()
	handler(s).ServeHTTP(rec, req)

	body := rec.Body.String()
	if strings.Contains(body, "mpa_0123456789abcd") {
		t.Fatal("el token completo viajó en la respuesta")
	}
	var out map[string]any
	json.Unmarshal([]byte(body), &out)
	if out["tokenSet"] != true {
		t.Error("debería informar que hay token guardado")
	}
	if out["tokenTail"] != "abcd" {
		t.Errorf("tokenTail = %v, se esperaban los últimos 4", out["tokenTail"])
	}
}

func TestSeRechazaCualquieraQueNoSeaEstePC(t *testing.T) {
	// Escenario: alguien conectado al WiFi del local descubre el puerto.
	s, _ := newTestUI(t)
	req := post(t, "/api/config", map[string]any{})
	req.RemoteAddr = "192.168.1.77:5555"
	rec := httptest.NewRecorder()
	handler(s).ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("código = %d, se esperaba 403", rec.Code)
	}
}

func TestSeRechazaElDNSRebinding(t *testing.T) {
	// Un dominio malicioso que resuelve a 127.0.0.1: la conexión llega
	// desde loopback, pero el Host delata el truco.
	s, _ := newTestUI(t)
	req := post(t, "/api/config", map[string]any{})
	req.Host = "impresoras-mesapay.example.com"
	rec := httptest.NewRecorder()
	handler(s).ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("código = %d, se esperaba 403 por el Host", rec.Code)
	}
}

func TestSeRechazaElFormularioDeOtraPagina(t *testing.T) {
	// El CSRF clásico: un <form> en una web cualquiera abierta en este
	// PC. No puede mandar application/json sin preflight, así que exigir
	// JSON ya lo bloquea.
	s, _ := newTestUI(t)
	req := post(t, "/api/config", map[string]any{})
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	handler(s).ServeHTTP(rec, req)
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Errorf("código = %d, se esperaba 415", rec.Code)
	}
}

func TestSeRechazaUnOrigenExterno(t *testing.T) {
	s, _ := newTestUI(t)
	req := post(t, "/api/config", map[string]any{})
	req.Header.Set("Origin", "https://sitio-malicioso.example")
	rec := httptest.NewRecorder()
	handler(s).ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("código = %d, se esperaba 403 por el Origin", rec.Code)
	}
}

func TestGuardarSinTokenNoBorraElQueYaEstaba(t *testing.T) {
	// Alguien corrige la IP de la barra: no debería tener que ir a
	// buscar el token al panel otra vez.
	s, cfgPath := newTestUI(t)
	req := post(t, "/api/config", map[string]any{
		"serverUrl": "https://mesapay.co",
		"token":     "", // vacío = no lo cambies
		"printers": []map[string]any{
			{"localKey": "cocina", "label": "Cocina", "host": "192.168.1.99",
				"port": 9100, "station": "kitchen", "paperWidthMm": 80, "active": true},
		},
	})
	rec := httptest.NewRecorder()
	handler(s).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("código = %d: %s", rec.Code, rec.Body.String())
	}

	saved, err := config.Load(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Token != "mpa_0123456789abcd" {
		t.Errorf("el token se perdió al guardar: %q", saved.Token)
	}
	if saved.Printers[0].Host != "192.168.1.99" {
		t.Errorf("la IP nueva no se guardó: %q", saved.Printers[0].Host)
	}
}

func TestGuardarAplicaLaConfiguracionSinReiniciar(t *testing.T) {
	s, _ := newTestUI(t)
	req := post(t, "/api/config", map[string]any{
		"serverUrl": "https://otro.mesapay.co",
		"printers": []map[string]any{
			{"localKey": "barra", "label": "Barra", "host": "10.0.0.5", "port": 9100,
				"station": "bar", "barSubStation": "cocteles", "paperWidthMm": 58, "active": true},
		},
	})
	rec := httptest.NewRecorder()
	handler(s).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("código = %d: %s", rec.Code, rec.Body.String())
	}
	cfg := s.agent.Config()
	if cfg.ServerURL != "https://otro.mesapay.co" {
		t.Errorf("el agente no tomó el servidor nuevo: %q", cfg.ServerURL)
	}
	if len(cfg.Printers) != 1 || cfg.Printers[0].BarSubStation != "cocteles" {
		t.Errorf("las impresoras no se aplicaron: %+v", cfg.Printers)
	}
}

func TestGuardarRechazaUnaConfiguracionInservible(t *testing.T) {
	s, _ := newTestUI(t)
	req := post(t, "/api/config", map[string]any{
		"serverUrl": "mesapay.co", // sin https
		"printers": []map[string]any{
			{"localKey": "cocina", "label": "Cocina", "host": "", "port": 9100},
		},
	})
	rec := httptest.NewRecorder()
	handler(s).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("código = %d, se esperaba 400", rec.Code)
	}
	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	msg, _ := out["error"].(string)
	// El mensaje lo lee alguien parado en una cocina: tiene que decir
	// qué corregir.
	if !strings.Contains(msg, "https://") || !strings.Contains(msg, "no tiene IP") {
		t.Errorf("el mensaje no explica qué arreglar: %q", msg)
	}
}

func TestLaPruebaDeImpresionMandaBytesDeVerdad(t *testing.T) {
	// Es la única cosa que el agente genera por su cuenta, y tiene que
	// funcionar con MESAPAY caído.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	recibido := make(chan []byte, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		data, _ := io.ReadAll(conn)
		recibido <- data
	}()

	host, portStr, _ := net.SplitHostPort(ln.Addr().String())
	port := 0
	for _, c := range portStr {
		port = port*10 + int(c-'0')
	}

	s, _ := newTestUI(t)
	req := post(t, "/api/test-print", map[string]any{
		"host": host, "port": port, "label": "Cocina", "paperWidthMm": 80,
	})
	rec := httptest.NewRecorder()
	handler(s).ServeHTTP(rec, req)

	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	if out["ok"] != true {
		t.Fatalf("la prueba falló: %v", out)
	}

	data := <-recibido
	if !bytes.HasPrefix(data, []byte{0x1b, 0x40}) {
		t.Error("el ticket de prueba no empieza con ESC @")
	}
	if !bytes.Contains(data, []byte("MESAPAY")) {
		t.Error("el ticket de prueba no dice MESAPAY")
	}
}

func TestLaPruebaFallidaExplicaQueHacer(t *testing.T) {
	// Un error sin pista de qué revisar genera una llamada a soporte.
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	host, portStr, _ := net.SplitHostPort(ln.Addr().String())
	port := 0
	for _, c := range portStr {
		port = port*10 + int(c-'0')
	}
	ln.Close() // nadie escuchando

	s, _ := newTestUI(t)
	s.agent.Printer().ConnectTimeout = 300_000_000 // 300ms
	req := post(t, "/api/test-print", map[string]any{"host": host, "port": port, "label": "Cocina"})
	rec := httptest.NewRecorder()
	handler(s).ServeHTTP(rec, req)

	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	if out["ok"] != false {
		t.Fatalf("se esperaba un fallo: %v", out)
	}
	hint, _ := out["hint"].(string)
	if !strings.Contains(hint, "encendida") || !strings.Contains(hint, "MISMA red") {
		t.Errorf("la pista no dice qué revisar: %q", hint)
	}
}

func TestLaPruebaExigeUnaIP(t *testing.T) {
	s, _ := newTestUI(t)
	rec := httptest.NewRecorder()
	handler(s).ServeHTTP(rec, post(t, "/api/test-print", map[string]any{"host": "  "}))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("código = %d, se esperaba 400", rec.Code)
	}
}

func TestLaPaginaSeSirveSinRecursosExternos(t *testing.T) {
	// Tiene que abrir con el internet caído, que es justo cuando alguien
	// la necesita.
	s, _ := newTestUI(t)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "127.0.0.1:1234"
	rec := httptest.NewRecorder()
	handler(s).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("código = %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "Agente de impresión MESAPAY") {
		t.Error("la página no trae su propio contenido")
	}
	for _, bad := range []string{"http://cdn", "https://cdn", "https://fonts.", "src=\"http"} {
		if strings.Contains(body, bad) {
			t.Errorf("la página carga algo de afuera (%q): no abriría sin internet", bad)
		}
	}
}
