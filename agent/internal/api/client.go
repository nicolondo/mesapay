// Package api habla con MESAPAY.
//
// Es el espejo exacto de src/app/api/print-agent/ del servidor. Las
// formas de acá no se inventan: se copian de esas rutas, que están en
// producción. Si algo no coincide, el que está mal es este archivo.
//
//	GET  /api/print-agent/jobs?limit=N     → trabajos pendientes
//	POST /api/print-agent/jobs/{id}/ack    → salió / no salió y por qué
//	POST /api/print-agent/heartbeat        → sigo vivo, esta es mi versión
//	POST /api/print-agent/printers         → mis impresoras (reemplazo total)
package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Timeout de cada request. Generoso porque el internet de un local
// puede ser un módem 4G bajo la barra, y corto frente al TTL de 6 horas
// de un trabajo.
const DefaultTimeout = 30 * time.Second

// ErrUnauthorized es el 401: token mal pegado, o revocado desde el panel.
// Se distingue de "el servidor está caído" porque la respuesta es
// distinta: reintentar no lo va a arreglar, hay que ir a la página de
// configuración y pegar el token de nuevo.
var ErrUnauthorized = fmt.Errorf("el token del agente no es válido o fue revocado")

// ErrNotImplemented lo devuelve SyncPrinters cuando el servidor todavía
// no tiene esa ruta (404). No es un fallo del agente y no debe impedir
// que imprima: la sincronización de impresoras es diagnóstico, la
// impresión es el trabajo.
var ErrNotImplemented = fmt.Errorf("el servidor no tiene esta ruta todavía")

// Client es el cliente HTTP autenticado.
type Client struct {
	BaseURL string
	Token   string
	Version string
	HTTP    *http.Client
}

// New arma un cliente con timeouts razonables.
func New(baseURL, token, version string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Token:   token,
		Version: version,
		HTTP: &http.Client{
			Timeout: DefaultTimeout,
			Transport: &http.Transport{
				// Reusar conexiones importa: son ~20 requests por
				// minuto por local, y abrir TLS cada vez sobre 4G es
				// medio segundo perdido cada vez.
				MaxIdleConns:        4,
				MaxIdleConnsPerHost: 4,
				IdleConnTimeout:     90 * time.Second,
			},
		},
	}
}

// Printer es la impresora tal como viaja dentro de un trabajo.
type Printer struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Host  string `json:"host"`
	Port  int    `json:"port"`
}

// Addr es lo que se le pasa a net.Dial. JoinHostPort y no un Sprintf
// porque hay locales con impresoras en IPv6 y ahí el host va entre
// corchetes.
func (p Printer) Addr() string {
	return net.JoinHostPort(p.Host, strconv.Itoa(p.Port))
}

// Job es una comanda lista para escupir por el socket.
//
// Data llega en base64 desde el servidor; acá ya viene decodificada a
// los bytes ESC/POS crudos. Bytes es lo que dijo el servidor que mandó:
// se compara con lo decodificado como control de integridad barato.
type Job struct {
	ID        string  `json:"id"`
	Kind      string  `json:"kind"`
	Attempt   int     `json:"attempt"`
	CreatedAt string  `json:"createdAt"`
	OrderID   *string `json:"orderId"`
	RoundID   *string `json:"roundId"`
	Printer   Printer `json:"printer"`
	Data      string  `json:"data"`
	Bytes     int     `json:"bytes"`

	// Payload son los bytes ya decodificados. No viene del JSON.
	Payload []byte `json:"-"`
}

// JobsResponse es la respuesta de GET /jobs.
type JobsResponse struct {
	Agent      AgentInfo `json:"agent"`
	ServerTime string    `json:"serverTime"`
	Jobs       []Job     `json:"jobs"`
}

// AgentInfo identifica al agente del lado servidor.
type AgentInfo struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// AckResponse es lo que contesta el servidor al acuse. WillRetry dice si
// va a volver a entregar el trabajo — se loguea para que el diagnóstico
// diga "va a reintentar" y no sólo "falló".
type AckResponse struct {
	Status      string `json:"status"`
	WillRetry   bool   `json:"willRetry"`
	Attempts    int    `json:"attempts"`
	MaxAttempts int    `json:"maxAttempts"`
	RetryAfter  string `json:"retryAfter"`
}

// ServerPrinter es una impresora tal como la conoce el servidor.
type ServerPrinter struct {
	ID            string  `json:"id"`
	LocalKey      string  `json:"localKey,omitempty"`
	Label         string  `json:"label"`
	Host          string  `json:"host"`
	Port          int     `json:"port"`
	Station       string  `json:"station"`
	BarSubStation *string `json:"barSubStation"`
	PaperWidthMm  *int    `json:"paperWidthMm,omitempty"`
	Active        *bool   `json:"active,omitempty"`
}

// HeartbeatResponse es la respuesta del latido.
type HeartbeatResponse struct {
	OK          bool            `json:"ok"`
	Agent       AgentInfo       `json:"agent"`
	ServerTime  string          `json:"serverTime"`
	Printers    []ServerPrinter `json:"printers"`
	PendingJobs int             `json:"pendingJobs"`
}

// PrinterInput es una impresora que el agente le declara al servidor.
//
// Los punteros no son adorno: barSubStation y paperWidthMm son
// nullable en el servidor y `null` significa algo distinto de "no
// mandado" (una impresora "de toda la barra" vs una de una sub-estación;
// ancho heredado del restaurante vs ancho propio).
type PrinterInput struct {
	LocalKey      string  `json:"localKey"`
	Label         string  `json:"label"`
	Host          string  `json:"host"`
	Port          int     `json:"port"`
	Station       string  `json:"station"`
	BarSubStation *string `json:"barSubStation"`
	PaperWidthMm  *int    `json:"paperWidthMm"`
	Active        bool    `json:"active"`
}

// FetchJobs pide trabajos. Los devuelve con Payload ya decodificado.
//
// Un trabajo con base64 roto se descarta acá con su error, en vez de
// tumbar todo el lote: si una comanda de 200 llega corrupta, las otras
// 199 tienen que salir igual. El llamador lo confirma como fallido.
func (c *Client) FetchJobs(ctx context.Context, limit int) (*JobsResponse, []JobError, error) {
	u := c.BaseURL + "/api/print-agent/jobs?limit=" + strconv.Itoa(limit)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, nil, err
	}
	var out JobsResponse
	if err := c.do(req, &out); err != nil {
		return nil, nil, err
	}

	var broken []JobError
	jobs := make([]Job, 0, len(out.Jobs))
	for _, job := range out.Jobs {
		payload, err := base64.StdEncoding.DecodeString(job.Data)
		if err != nil {
			broken = append(broken, JobError{
				JobID:  job.ID,
				Reason: fmt.Sprintf("los bytes del trabajo no son base64 válido: %v", err),
			})
			continue
		}
		if job.Bytes > 0 && len(payload) != job.Bytes {
			broken = append(broken, JobError{
				JobID: job.ID,
				Reason: fmt.Sprintf("el servidor anunció %d bytes y llegaron %d",
					job.Bytes, len(payload)),
			})
			continue
		}
		if len(payload) == 0 {
			broken = append(broken, JobError{JobID: job.ID, Reason: "el trabajo llegó vacío"})
			continue
		}
		job.Payload = payload
		jobs = append(jobs, job)
	}
	out.Jobs = jobs
	return &out, broken, nil
}

// JobError es un trabajo que llegó inservible; hay que confirmarlo como
// fallido igual, si no el servidor lo re-entrega para siempre.
type JobError struct {
	JobID  string
	Reason string
}

// AckSuccess confirma que la comanda salió.
func (c *Client) AckSuccess(ctx context.Context, jobID string) (*AckResponse, error) {
	return c.ack(ctx, jobID, map[string]any{"ok": true})
}

// AckFailure confirma que NO salió, con el motivo.
//
// Se recorta a 500 caracteres porque es el máximo que acepta el zod del
// servidor: mandar más devolvería 400 y perderíamos el acuse entero, que
// es peor que perder el final del mensaje.
func (c *Client) AckFailure(ctx context.Context, jobID, reason string) (*AckResponse, error) {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		reason = "error desconocido en el agente"
	}
	if len(reason) > 500 {
		reason = reason[:500]
	}
	return c.ack(ctx, jobID, map[string]any{"ok": false, "error": reason})
}

func (c *Client) ack(ctx context.Context, jobID string, body map[string]any) (*AckResponse, error) {
	u := c.BaseURL + "/api/print-agent/jobs/" + url.PathEscape(jobID) + "/ack"
	req, err := c.jsonRequest(ctx, http.MethodPost, u, body)
	if err != nil {
		return nil, err
	}
	var out AckResponse
	if err := c.do(req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Heartbeat avisa que el agente sigue vivo y con qué versión.
func (c *Client) Heartbeat(ctx context.Context) (*HeartbeatResponse, error) {
	u := c.BaseURL + "/api/print-agent/heartbeat"
	req, err := c.jsonRequest(ctx, http.MethodPost, u, map[string]any{"version": c.Version})
	if err != nil {
		return nil, err
	}
	var out HeartbeatResponse
	if err := c.do(req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SyncPrinters declara las impresoras del local.
//
// Es un reemplazo declarativo: lo que no va en la lista queda desactivado
// del lado servidor. Por eso se manda la lista COMPLETA de impresoras
// activas, nunca un delta.
//
// Si el servidor devuelve 404 (la ruta se está escribiendo en paralelo)
// se devuelve ErrNotImplemented y el agente sigue trabajando: sin esto
// igual imprime, porque el host y el puerto de cada trabajo los manda el
// servidor y la IP real vive en este archivo de configuración.
func (c *Client) SyncPrinters(ctx context.Context, printers []PrinterInput) ([]ServerPrinter, error) {
	if printers == nil {
		printers = []PrinterInput{}
	}
	u := c.BaseURL + "/api/print-agent/printers"
	req, err := c.jsonRequest(ctx, http.MethodPost, u, map[string]any{"printers": printers})
	if err != nil {
		return nil, err
	}
	var out struct {
		Printers []ServerPrinter `json:"printers"`
	}
	if err := c.do(req, &out); err != nil {
		return nil, err
	}
	return out.Printers, nil
}

func (c *Client) jsonRequest(ctx context.Context, method, u string, body any) (*http.Request, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, u, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	return req, nil
}

// do agrega el Bearer, ejecuta y decodifica. Todos los errores salen ya
// en castellano: los va a leer alguien en una cocina, no un backend.
func (c *Client) do(req *http.Request, out any) error {
	if strings.TrimSpace(c.Token) == "" {
		return fmt.Errorf("el agente no tiene token: falta vincularlo con el comercio")
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("User-Agent", "MESAPAY-PrintAgent/"+c.Version)
	req.Header.Set("Accept", "application/json")

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("no se pudo hablar con el servidor: %w", err)
	}
	defer resp.Body.Close()

	// 1MB de tope: si el servidor devuelve algo enorme (una página de
	// error del proxy) no queremos comernos la memoria del PC de la caja.
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("se cortó la respuesta del servidor: %w", err)
	}

	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		return ErrUnauthorized
	case resp.StatusCode == http.StatusNotFound && req.Method == http.MethodPost &&
		strings.HasSuffix(req.URL.Path, "/api/print-agent/printers"):
		return ErrNotImplemented
	case resp.StatusCode < 200 || resp.StatusCode >= 300:
		return fmt.Errorf("el servidor respondió %d: %s",
			resp.StatusCode, snippet(string(body)))
	}

	if out == nil {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("el servidor devolvió algo que no es JSON: %s", snippet(string(body)))
	}
	return nil
}

func snippet(s string) string {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\n", " "))
	if len(s) > 200 {
		return s[:200] + "…"
	}
	if s == "" {
		return "(respuesta vacía)"
	}
	return s
}
