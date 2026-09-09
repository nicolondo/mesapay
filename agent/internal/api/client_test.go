package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Los tests de este archivo levantan un MESAPAY de mentira que responde
// exactamente como src/app/api/print-agent/. Si el servidor real cambia
// una forma, acá es donde hay que enterarse.

const testToken = "mpa_" + "0123456789abcdef"

func newTestServer(t *testing.T, h http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv
}

func TestFetchJobsDecodificaLosBytesESCPOS(t *testing.T) {
	payload := []byte{0x1b, 0x40, 'C', 'O', 'M', 'A', 'N', 'D', 'A', 0x0a}
	srv := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/print-agent/jobs" {
			t.Errorf("ruta = %q", r.URL.Path)
		}
		if got := r.URL.Query().Get("limit"); got != "10" {
			t.Errorf("limit = %q", got)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer "+testToken {
			t.Errorf("Authorization = %q", got)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"agent":      map[string]string{"id": "ag1", "label": "Cocina PC"},
			"serverTime": "2026-01-01T00:00:00.000Z",
			"jobs": []map[string]any{{
				"id": "job1", "kind": "kitchen_round", "attempt": 1,
				"createdAt": "2026-01-01T00:00:00.000Z",
				"printer": map[string]any{
					"id": "prt1", "label": "Cocina", "host": "192.168.1.50", "port": 9100,
				},
				"data":  base64.StdEncoding.EncodeToString(payload),
				"bytes": len(payload),
			}},
		})
	})

	resp, broken, err := New(srv.URL, testToken, "test").FetchJobs(context.Background(), 10)
	if err != nil {
		t.Fatalf("FetchJobs: %v", err)
	}
	if len(broken) != 0 {
		t.Fatalf("no debería haber trabajos rotos: %v", broken)
	}
	if len(resp.Jobs) != 1 {
		t.Fatalf("trabajos = %d", len(resp.Jobs))
	}
	job := resp.Jobs[0]
	if string(job.Payload) != string(payload) {
		t.Errorf("los bytes no coinciden: %v", job.Payload)
	}
	if job.Printer.Addr() != "192.168.1.50:9100" {
		t.Errorf("dirección de la impresora = %q", job.Printer.Addr())
	}
	if resp.Agent.Label != "Cocina PC" {
		t.Errorf("rótulo del agente = %q", resp.Agent.Label)
	}
}

func TestFetchJobsAisaLosTrabajosCorruptosSinPerderElResto(t *testing.T) {
	// Si una comanda llega rota, las otras tienen que salir igual. Y la
	// rota tiene que reportarse para poder confirmarla como fallida, si
	// no el servidor la re-entrega cada 2 minutos para siempre.
	buena := []byte{0x1b, 0x40, 'O', 'K'}
	srv := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"agent": map[string]string{"id": "ag1", "label": "PC"},
			"jobs": []any{
				map[string]any{"id": "roto-b64", "data": "no-es-base64!!!", "bytes": 4,
					"printer": map[string]any{"id": "p", "host": "h", "port": 9100}},
				map[string]any{"id": "buena", "data": base64.StdEncoding.EncodeToString(buena),
					"bytes":   len(buena),
					"printer": map[string]any{"id": "p", "host": "h", "port": 9100}},
				map[string]any{"id": "largo-mal", "data": base64.StdEncoding.EncodeToString(buena),
					"bytes":   999, // el servidor dijo 999 y llegaron 4
					"printer": map[string]any{"id": "p", "host": "h", "port": 9100}},
				map[string]any{"id": "vacia", "data": "", "bytes": 0,
					"printer": map[string]any{"id": "p", "host": "h", "port": 9100}},
			},
		})
	})

	resp, broken, err := New(srv.URL, testToken, "test").FetchJobs(context.Background(), 10)
	if err != nil {
		t.Fatalf("FetchJobs: %v", err)
	}
	if len(resp.Jobs) != 1 || resp.Jobs[0].ID != "buena" {
		t.Fatalf("debería quedar sólo la comanda buena, quedaron %d", len(resp.Jobs))
	}
	if len(broken) != 3 {
		t.Fatalf("rotas = %d, se esperaban 3: %v", len(broken), broken)
	}
	ids := map[string]bool{}
	for _, b := range broken {
		ids[b.JobID] = true
		if b.Reason == "" {
			t.Errorf("el trabajo %s no dice por qué se descartó", b.JobID)
		}
	}
	for _, want := range []string{"roto-b64", "largo-mal", "vacia"} {
		if !ids[want] {
			t.Errorf("falta %q entre las rotas", want)
		}
	}
}

func TestTokenRechazadoSeDistingueDeUnServidorCaido(t *testing.T) {
	// La diferencia importa: un 401 no se arregla reintentando, se
	// arregla pegando otro token.
	srv := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"error":"unauthorized"}`))
	})
	_, _, err := New(srv.URL, testToken, "test").FetchJobs(context.Background(), 10)
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("se esperaba ErrUnauthorized, hubo: %v", err)
	}
}

func TestErrorDelServidorLlegaLegible(t *testing.T) {
	srv := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		w.Write([]byte("<html>502 Bad Gateway</html>"))
	})
	_, _, err := New(srv.URL, testToken, "test").FetchJobs(context.Background(), 10)
	if err == nil {
		t.Fatal("se esperaba error")
	}
	if !strings.Contains(err.Error(), "502") {
		t.Errorf("el error no dice el código: %v", err)
	}
}

func TestSinTokenNiSeIntentaElRequest(t *testing.T) {
	llamado := false
	srv := newTestServer(t, func(w http.ResponseWriter, r *http.Request) { llamado = true })
	_, _, err := New(srv.URL, "", "test").FetchJobs(context.Background(), 10)
	if err == nil {
		t.Fatal("se esperaba error por falta de token")
	}
	if llamado {
		t.Error("no hay que golpear el servidor con 401 en bucle cuando no hay token")
	}
}

func TestAckSuccessMandaOkTrue(t *testing.T) {
	var body map[string]any
	var path string
	srv := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		json.Unmarshal(raw, &body)
		json.NewEncoder(w).Encode(map[string]any{"status": "printed"})
	})

	resp, err := New(srv.URL, testToken, "test").AckSuccess(context.Background(), "job1")
	if err != nil {
		t.Fatalf("AckSuccess: %v", err)
	}
	if path != "/api/print-agent/jobs/job1/ack" {
		t.Errorf("ruta = %q", path)
	}
	if body["ok"] != true {
		t.Errorf("body = %v, se esperaba ok:true", body)
	}
	if resp.Status != "printed" {
		t.Errorf("status = %q", resp.Status)
	}
}

func TestAckFailureRecortaElMotivoALoQueAceptaElServidor(t *testing.T) {
	// El zod del servidor corta en 500; mandar más devolvería 400 y
	// perderíamos el acuse entero, que es peor que perder el final.
	var body map[string]any
	srv := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		json.Unmarshal(raw, &body)
		json.NewEncoder(w).Encode(map[string]any{
			"status": "pending", "willRetry": true, "attempts": 2, "maxAttempts": 5,
		})
	})

	largo := strings.Repeat("x", 900)
	resp, err := New(srv.URL, testToken, "test").AckFailure(context.Background(), "job1", largo)
	if err != nil {
		t.Fatalf("AckFailure: %v", err)
	}
	if body["ok"] != false {
		t.Errorf("se esperaba ok:false, hubo %v", body["ok"])
	}
	if got := body["error"].(string); len(got) != 500 {
		t.Errorf("el motivo mide %d, debería recortarse a 500", len(got))
	}
	if !resp.WillRetry {
		t.Error("willRetry debería llegar como true")
	}
}

func TestAckFailureNuncaMandaMotivoVacio(t *testing.T) {
	var body map[string]any
	srv := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		json.Unmarshal(raw, &body)
		w.Write([]byte(`{"status":"pending"}`))
	})
	if _, err := New(srv.URL, testToken, "test").AckFailure(context.Background(), "j", "   "); err != nil {
		t.Fatal(err)
	}
	if body["error"] == "" || body["error"] == nil {
		t.Error("un fallo sin motivo no le sirve a nadie para diagnosticar")
	}
}

func TestHeartbeatMandaLaVersionYDevuelveLasImpresoras(t *testing.T) {
	var body map[string]any
	srv := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		json.Unmarshal(raw, &body)
		json.NewEncoder(w).Encode(map[string]any{
			"ok":    true,
			"agent": map[string]string{"id": "ag1", "label": "Sede Centro"},
			"printers": []map[string]any{
				{"id": "p1", "label": "Cocina", "host": "192.168.1.50", "port": 9100,
					"station": "kitchen", "barSubStation": nil},
			},
			"pendingJobs": 3,
		})
	})

	resp, err := New(srv.URL, testToken, "1.2.3").Heartbeat(context.Background())
	if err != nil {
		t.Fatalf("Heartbeat: %v", err)
	}
	if body["version"] != "1.2.3" {
		t.Errorf("version = %v: sin esto no sabemos a qué local hay que actualizar", body["version"])
	}
	if resp.PendingJobs != 3 {
		t.Errorf("pendingJobs = %d", resp.PendingJobs)
	}
	if len(resp.Printers) != 1 || resp.Printers[0].Label != "Cocina" {
		t.Errorf("impresoras = %v", resp.Printers)
	}
	if resp.Agent.Label != "Sede Centro" {
		t.Errorf("rótulo = %q", resp.Agent.Label)
	}
}

func TestSyncPrintersMandaLaListaCompleta(t *testing.T) {
	// Es un reemplazo declarativo: lo que no va en la lista queda
	// desactivado del lado servidor, así que nunca se manda un delta.
	var body struct {
		Printers []map[string]any `json:"printers"`
	}
	srv := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/print-agent/printers" {
			t.Errorf("ruta = %q", r.URL.Path)
		}
		json.NewDecoder(r.Body).Decode(&body)
		json.NewEncoder(w).Encode(map[string]any{
			"printers": []map[string]any{
				{"id": "cuid1", "localKey": "cocina", "label": "Cocina",
					"host": "192.168.1.50", "port": 9100, "station": "kitchen",
					"barSubStation": nil},
			},
		})
	})

	sub := "cocteles"
	ancho := 58
	out, err := New(srv.URL, testToken, "test").SyncPrinters(context.Background(), []PrinterInput{
		{LocalKey: "cocina", Label: "Cocina", Host: "192.168.1.50", Port: 9100,
			Station: "kitchen", Active: true},
		{LocalKey: "barra", Label: "Barra", Host: "192.168.1.51", Port: 9100,
			Station: "bar", BarSubStation: &sub, PaperWidthMm: &ancho, Active: true},
	})
	if err != nil {
		t.Fatalf("SyncPrinters: %v", err)
	}
	if len(body.Printers) != 2 {
		t.Fatalf("se mandaron %d impresoras, se esperaban 2", len(body.Printers))
	}
	// barSubStation null explícito, no ausente: en el servidor null
	// significa "impresora de toda la barra", que es distinto de no
	// haberlo mandado.
	if v, ok := body.Printers[0]["barSubStation"]; !ok || v != nil {
		t.Errorf("barSubStation de cocina = %v (presente=%v), debería ser null explícito", v, ok)
	}
	if body.Printers[1]["barSubStation"] != "cocteles" {
		t.Errorf("barSubStation de barra = %v", body.Printers[1]["barSubStation"])
	}
	if body.Printers[1]["paperWidthMm"] != float64(58) {
		t.Errorf("paperWidthMm = %v", body.Printers[1]["paperWidthMm"])
	}
	if len(out) != 1 || out[0].ID != "cuid1" {
		t.Errorf("no se devolvieron los ids del servidor: %v", out)
	}
}

func TestSyncPrintersCon404NoEsUnFalloDelLocal(t *testing.T) {
	// La ruta se estaba escribiendo en paralelo. Un 404 tiene que ser
	// reconocible para no asustar a nadie ni impedir que se imprima.
	srv := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	_, err := New(srv.URL, testToken, "test").SyncPrinters(context.Background(), nil)
	if !errors.Is(err, ErrNotImplemented) {
		t.Fatalf("se esperaba ErrNotImplemented, hubo: %v", err)
	}
}

func TestSyncPrintersNuncaMandaNull(t *testing.T) {
	// `{"printers": null}` sería rechazado por el zod del servidor; con
	// cero impresoras hay que mandar un array vacío.
	var raw string
	srv := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		raw = string(b)
		w.Write([]byte(`{"printers":[]}`))
	})
	if _, err := New(srv.URL, testToken, "test").SyncPrinters(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(raw, `"printers":[]`) {
		t.Errorf("body = %s, se esperaba un array vacío", raw)
	}
}

func TestRespuestaQueNoEsJSONDaUnErrorEntendible(t *testing.T) {
	// El caso real: el proxy del VPS devolviendo su propia página de
	// error con status 200.
	srv := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("<html>Bad Gateway</html>"))
	})
	_, _, err := New(srv.URL, testToken, "test").FetchJobs(context.Background(), 10)
	if err == nil || !strings.Contains(err.Error(), "no es JSON") {
		t.Errorf("error = %v", err)
	}
}
