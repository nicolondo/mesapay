// Package ui sirve la página de configuración del agente.
//
// ── Por qué una página web y no una ventana ──────────────────────────
// Un GUI nativo en Go para Windows significa cgo, un toolchain de
// Windows y un .exe que ya no es un solo archivo. La página local no
// cuesta nada (el binario ya trae un servidor HTTP), se ve igual en
// cualquier PC del local, y el mismo dueño la puede abrir desde el
// navegador que ya tiene abierto.
//
// ── Por qué sólo loopback ────────────────────────────────────────────
// Esta página puede cambiar el token del comercio y la IP de destino de
// todas las comandas. Escucha ÚNICAMENTE en 127.0.0.1: nadie conectado
// al WiFi del local —ni un cliente— puede alcanzarla.
//
// Que sea loopback no alcanza por sí solo: una página web maliciosa
// abierta en ese mismo PC podría enviarle formularios (o alcanzarla por
// DNS rebinding). Por eso, además, cada escritura exige JSON, y se
// validan el Host y el Origin. Ver guard().
package ui

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"mesapay.co/print-agent/internal/agent"
	"mesapay.co/print-agent/internal/api"
	"mesapay.co/print-agent/internal/config"
	"mesapay.co/print-agent/internal/logging"
	"mesapay.co/print-agent/internal/printer"
)

// Server es la página de configuración.
type Server struct {
	agent   *agent.Agent
	cfgPath string
	log     *logging.Logger
	port    int
	srv     *http.Server
}

// New arma el servidor. No escucha todavía.
func New(a *agent.Agent, cfgPath string, log *logging.Logger, port int) *Server {
	return &Server{agent: a, cfgPath: cfgPath, log: log, port: port}
}

// URL es la dirección que hay que abrir en el navegador.
func (s *Server) URL() string {
	return fmt.Sprintf("http://127.0.0.1:%d", s.port)
}

// Start escucha en loopback y sirve hasta que ctx se cancele.
//
// Si el puerto está ocupado NO se aborta el agente: se loguea y se sigue
// imprimiendo. La página es para configurar y diagnosticar; el trabajo
// es imprimir, y un agente ya configurado no la necesita.
func (s *Server) Start(ctx context.Context) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleIndex)
	mux.HandleFunc("/api/state", s.guard(s.handleState))
	mux.HandleFunc("/api/config", s.guard(s.handleSaveConfig))
	mux.HandleFunc("/api/test-print", s.guard(s.handleTestPrint))
	mux.HandleFunc("/api/check-link", s.guard(s.handleCheckLink))

	// 127.0.0.1 explícito, nunca ":puerto" — eso escucharía en todas las
	// interfaces y expondría la configuración a la red del local.
	ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(s.port))
	if err != nil {
		return fmt.Errorf("no se pudo abrir la página de configuración en el puerto %d: %w", s.port, err)
	}

	s.srv = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.srv.Shutdown(shutdownCtx)
	}()

	s.log.Infof("página de configuración disponible en %s", s.URL())
	if err := s.srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// guard es la defensa de las rutas que escriben.
//
// Tres controles, cada uno tapa un agujero distinto:
//
//  1. RemoteAddr loopback — que nadie de la red del local llegue acá.
//     Redundante con el bind, y va igual: si algún día alguien cambia
//     el bind por descuido, esto sigue cerrando la puerta.
//  2. Host 127.0.0.1/localhost — contra DNS rebinding, donde un dominio
//     malicioso resuelve a 127.0.0.1 y el navegador considera la
//     petición de mismo origen.
//  3. Content-Type JSON en los POST — un <form> de otra página no puede
//     mandar application/json sin preflight CORS, así que esto solo ya
//     bloquea el CSRF clásico. Y Origin, si viene, tiene que ser local.
func (s *Server) guard(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil || !isLoopback(host) {
			http.Error(w, "solo desde este equipo", http.StatusForbidden)
			return
		}
		reqHost := r.Host
		if h, _, err := net.SplitHostPort(reqHost); err == nil {
			reqHost = h
		}
		if !isLoopback(reqHost) && reqHost != "localhost" {
			http.Error(w, "host no permitido", http.StatusForbidden)
			return
		}
		if r.Method == http.MethodPost {
			if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
				http.Error(w, "se esperaba application/json", http.StatusUnsupportedMediaType)
				return
			}
			if origin := r.Header.Get("Origin"); origin != "" && !isLocalOrigin(origin) {
				http.Error(w, "origen no permitido", http.StatusForbidden)
				return
			}
		}
		w.Header().Set("Cache-Control", "no-store")
		next(w, r)
	}
}

func isLoopback(host string) bool {
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func isLocalOrigin(origin string) bool {
	origin = strings.TrimPrefix(strings.TrimPrefix(origin, "http://"), "https://")
	if h, _, err := net.SplitHostPort(origin); err == nil {
		origin = h
	}
	return isLoopback(origin) || origin == "localhost"
}

// ── Estado ───────────────────────────────────────────────────────────

// statePrinter es una impresora tal como la ve la página. El token no
// aparece nunca acá.
type statePrinter struct {
	LocalKey      string `json:"localKey"`
	Label         string `json:"label"`
	Host          string `json:"host"`
	Port          int    `json:"port"`
	Station       string `json:"station"`
	BarSubStation string `json:"barSubStation"`
	PaperWidthMm  int    `json:"paperWidthMm"`
	Active        bool   `json:"active"`
	ServerID      string `json:"serverId,omitempty"`
}

type stateResponse struct {
	ServerURL string         `json:"serverUrl"`
	TokenSet  bool           `json:"tokenSet"`
	TokenTail string         `json:"tokenTail"`
	UIPort    int            `json:"uiPort"`
	Printers  []statePrinter `json:"printers"`

	Status  agent.Status    `json:"status"`
	LogPath string          `json:"logPath"`
	Events  []logging.Entry `json:"events"`
}

func (s *Server) handleState(w http.ResponseWriter, r *http.Request) {
	cfg := s.agent.Config()
	printers := make([]statePrinter, 0, len(cfg.Printers))
	for _, p := range cfg.Printers {
		printers = append(printers, statePrinter{
			LocalKey: p.LocalKey, Label: p.Label, Host: p.Host, Port: p.Port,
			Station: p.Station, BarSubStation: p.BarSubStation,
			PaperWidthMm: p.PaperWidthMm, Active: p.Active, ServerID: p.ServerID,
		})
	}
	// El token NUNCA vuelve entero, ni siquiera a loopback: si algo
	// lograra leer esta respuesta, se llevaría el acceso al comercio.
	// Sólo los últimos 4, que es lo que hace falta para reconocerlo.
	tail := ""
	if len(cfg.Token) >= 4 {
		tail = cfg.Token[len(cfg.Token)-4:]
	}
	writeJSON(w, http.StatusOK, stateResponse{
		ServerURL: cfg.ServerURL,
		TokenSet:  cfg.Linked(),
		TokenTail: tail,
		UIPort:    cfg.UIPort,
		Printers:  printers,
		Status:    s.agent.Status(),
		LogPath:   s.log.Path(),
		Events:    s.log.Recent(60),
	})
}

// ── Guardar configuración ────────────────────────────────────────────

type saveRequest struct {
	ServerURL string `json:"serverUrl"`
	// Token vacío = "no lo cambies". Así se puede editar una impresora
	// sin tener que ir a buscar el token otra vez al panel.
	Token    string         `json:"token"`
	Printers []statePrinter `json:"printers"`
}

func (s *Server) handleSaveConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "método no permitido", http.StatusMethodNotAllowed)
		return
	}
	var req saveRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "no se entendió el formulario"})
		return
	}

	cfg := s.agent.Config()
	previous := map[string]string{} // localKey → serverId ya conocido
	for _, p := range cfg.Printers {
		previous[p.LocalKey] = p.ServerID
	}

	cfg.ServerURL = req.ServerURL
	if strings.TrimSpace(req.Token) != "" {
		cfg.Token = strings.TrimSpace(req.Token)
	}
	cfg.Printers = cfg.Printers[:0]
	for _, p := range req.Printers {
		cfg.Printers = append(cfg.Printers, config.Printer{
			LocalKey: p.LocalKey, Label: p.Label, Host: p.Host, Port: p.Port,
			Station: p.Station, BarSubStation: p.BarSubStation,
			PaperWidthMm: p.PaperWidthMm, Active: p.Active,
			ServerID: previous[p.LocalKey],
		})
	}
	cfg.Normalize()

	if problems := cfg.Validate(); len(problems) > 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error":    strings.Join(problems, " · "),
			"problems": problems,
		})
		return
	}
	if err := config.Save(s.cfgPath, cfg); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error": "no se pudo guardar la configuración: " + err.Error(),
		})
		return
	}
	s.agent.ApplyConfig(cfg)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ── Prueba de impresión ──────────────────────────────────────────────

type testPrintRequest struct {
	Host         string `json:"host"`
	Port         int    `json:"port"`
	Label        string `json:"label"`
	PaperWidthMm int    `json:"paperWidthMm"`
}

// handleTestPrint imprime una tirilla generada localmente.
//
// Es a propósito independiente de MESAPAY: quien instala necesita saber
// si la IP que acaba de escribir es la impresora correcta, y eso tiene
// que poder averiguarlo con el internet caído o el token todavía sin
// pegar.
func (s *Server) handleTestPrint(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "método no permitido", http.StatusMethodNotAllowed)
		return
	}
	var req testPrintRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "no se entendió la petición"})
		return
	}
	host := strings.TrimSpace(req.Host)
	if host == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "falta la IP de la impresora"})
		return
	}
	port := req.Port
	if port <= 0 || port > 65535 {
		port = config.DefaultPort
	}
	label := strings.TrimSpace(req.Label)
	if label == "" {
		label = "sin nombre"
	}

	addr := net.JoinHostPort(host, strconv.Itoa(port))
	data := printer.TestTicket(label, addr, req.PaperWidthMm)

	if err := s.agent.Printer().Print(addr, data); err != nil {
		kind, _ := printer.KindOf(err)
		s.log.Errorf("prueba de impresión en %s falló: %v", addr, err)
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":    false,
			"error": err.Error(),
			"hint":  hintFor(kind, addr),
		})
		return
	}
	s.log.Infof("prueba de impresión enviada a %s (%s), %d bytes", label, addr, len(data))
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"message": fmt.Sprintf("Se enviaron %d bytes a %s. Mirá la impresora: si no salió papel, está encendida pero no es una impresora ESC/POS, o no tiene papel.", len(data), addr),
	})
}

// hintFor traduce el tipo de fallo a qué hacer. Es lo que separa un
// mensaje que resuelve el problema de uno que sólo lo describe.
func hintFor(kind printer.Kind, addr string) string {
	switch kind {
	case printer.KindConnect:
		return "No hay nada escuchando en " + addr + ". Revisá que la impresora esté encendida, que la IP sea la correcta (se imprime desde el menú de la propia impresora) y que este PC y la impresora estén en la MISMA red — el error típico es el PC en el WiFi de invitados."
	case printer.KindTimeout:
		return "La impresora aceptó la conexión pero dejó de leer. Casi siempre es papel: revisá el rollo y la tapa."
	case printer.KindWrite:
		return "La conexión se cortó a mitad de la impresión. Suele ser señal WiFi débil en la impresora o que se reinició."
	default:
		return ""
	}
}

// ── Verificar vinculación ────────────────────────────────────────────

// handleCheckLink prueba el token contra el servidor SIN guardarlo.
//
// Existe porque el error más común de instalación es un token mal
// pegado, y descubrirlo recién cuando no sale una comanda es tardísimo.
func (s *Server) handleCheckLink(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "método no permitido", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		ServerURL string `json:"serverUrl"`
		Token     string `json:"token"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "no se entendió la petición"})
		return
	}
	cfg := s.agent.Config()
	serverURL := strings.TrimRight(strings.TrimSpace(req.ServerURL), "/")
	if serverURL == "" {
		serverURL = cfg.ServerURL
	}
	token := strings.TrimSpace(req.Token)
	if token == "" {
		token = cfg.Token
	}
	if token == "" {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":    false,
			"error": "Todavía no pegaste el token de vinculación.",
		})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	resp, err := api.New(serverURL, token, s.agent.Status().Version).Heartbeat(ctx)
	if err != nil {
		msg := err.Error()
		if errors.Is(err, api.ErrUnauthorized) {
			msg = "El servidor rechazó el token. Copialo de nuevo desde MESAPAY (Configuración → Impresión) y pegalo completo, sin espacios."
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": msg})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":          true,
		"agentLabel":  resp.Agent.Label,
		"printers":    resp.Printers,
		"pendingJobs": resp.PendingJobs,
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	// La página se sirve desde este mismo binario; nada externo debería
	// poder embeberla ni adivinar tipos de contenido.
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
