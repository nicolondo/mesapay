// Package agent es el bucle de trabajo: pedir, imprimir, confirmar.
//
// Tres cosas corren en paralelo y ninguna depende de las otras:
//
//	poll      — pide trabajos y los imprime. Es el trabajo real.
//	heartbeat — avisa que seguimos vivos, con la versión del .exe.
//	sync      — declara las impresoras locales para diagnóstico.
//
// Están separadas a propósito: si el latido falla porque el servidor
// tiene un problema en esa ruta, las comandas tienen que seguir
// saliendo. Lo único indispensable es el poll.
package agent

import (
	"context"
	"errors"
	"sync"
	"time"

	"mesapay.co/print-agent/internal/api"
	"mesapay.co/print-agent/internal/config"
	"mesapay.co/print-agent/internal/dedupe"
	"mesapay.co/print-agent/internal/logging"
	"mesapay.co/print-agent/internal/printer"
)

// JobLimit es cuántos trabajos se piden por vuelta. 10 es el default del
// servidor; con más, un local que estuvo desconectado 10 minutos se come
// una ráfaga que la impresora no digiere.
const JobLimit = 10

// Status es todo lo que la página de diagnóstico necesita saber para
// responder la única pregunta que importa cuando algo falla: ¿el
// problema es el internet, el token, o la impresora?
type Status struct {
	// Connected: el último intento de hablar con el servidor salió bien.
	Connected     bool       `json:"connected"`
	LastError     string     `json:"lastError,omitempty"`
	LastErrorAt   *time.Time `json:"lastErrorAt,omitempty"`
	LastContactAt *time.Time `json:"lastContactAt,omitempty"`

	AgentLabel string `json:"agentLabel,omitempty"`

	// Última comanda impresa: lo primero que pregunta alguien parado en
	// una cocina que no ve salir papel.
	LastPrintedJobID  string     `json:"lastPrintedJobId,omitempty"`
	LastPrintedLabel  string     `json:"lastPrintedLabel,omitempty"`
	LastPrintedAt     *time.Time `json:"lastPrintedAt,omitempty"`
	PrintedSinceStart int        `json:"printedSinceStart"`
	FailedSinceStart  int        `json:"failedSinceStart"`
	DuplicatesSkipped int        `json:"duplicatesSkipped"`
	PendingJobsServer int        `json:"pendingJobsServer"`
	PrintersSynced    bool       `json:"printersSynced"`
	PrintersSyncNote  string     `json:"printersSyncNote,omitempty"`
	StartedAt         time.Time  `json:"startedAt"`
	Version           string     `json:"version"`
}

// Agent es el servicio en marcha.
type Agent struct {
	mu      sync.RWMutex
	cfg     config.Config
	status  Status
	client  *api.Client
	printer *printer.Client
	store   *dedupe.Store
	log     *logging.Logger
	version string
	// cfgPath es dónde se persiste la configuración cuando el agente la
	// modifica solo (al cachear los ids que devuelve el servidor).
	cfgPath string

	// reload despierta a los bucles cuando cambia la configuración desde
	// la página. Con capacidad 1 y envío no bloqueante: un cambio en
	// vuelo ya cubre a los que lleguen mientras tanto.
	reload chan struct{}
}

// New arma el agente. No habla con la red todavía.
func New(cfgPath string, cfg config.Config, store *dedupe.Store, log *logging.Logger, version string) *Agent {
	a := &Agent{
		cfgPath: cfgPath,
		cfg:     cfg,
		store:   store,
		log:     log,
		version: version,
		printer: printer.NewClient(),
		reload:  make(chan struct{}, 1),
		status:  Status{StartedAt: time.Now(), Version: version},
	}
	a.client = api.New(cfg.ServerURL, cfg.Token, version)
	return a
}

// Config devuelve una copia de la configuración vigente.
func (a *Agent) Config() config.Config {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.cfg
}

// Status devuelve una copia del estado, para la página de diagnóstico.
func (a *Agent) Status() Status {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.status
}

// Printer expone el cliente de impresión para la prueba manual desde la
// página de configuración.
func (a *Agent) Printer() *printer.Client { return a.printer }

// Log expone el logger para que la página pueda mostrar los últimos
// eventos y decir dónde está el archivo.
func (a *Agent) Log() *logging.Logger { return a.log }

// ApplyConfig cambia la configuración en caliente.
//
// No hay reinicio del servicio: alguien que corrige la IP de la
// impresora de la barra no debería tener que reiniciar el PC de la caja
// —ni saber que existe un servicio— para que tome efecto.
func (a *Agent) ApplyConfig(cfg config.Config) {
	a.mu.Lock()
	a.cfg = cfg
	a.client = api.New(cfg.ServerURL, cfg.Token, a.version)
	a.status.PrintersSynced = false
	a.mu.Unlock()

	a.log.Infof("configuración actualizada: servidor=%s impresoras=%d vinculado=%v",
		cfg.ServerURL, len(cfg.ActivePrinters()), cfg.Linked())

	select {
	case a.reload <- struct{}{}:
	default:
	}
}

// Run arranca los tres bucles y vuelve cuando ctx se cancela.
func (a *Agent) Run(ctx context.Context) {
	a.log.Infof("agente MESAPAY %s iniciado", a.version)

	var wg sync.WaitGroup
	wg.Add(3)
	go func() { defer wg.Done(); a.pollLoop(ctx) }()
	go func() { defer wg.Done(); a.heartbeatLoop(ctx) }()
	go func() { defer wg.Done(); a.syncLoop(ctx) }()
	wg.Wait()

	a.log.Infof("agente detenido")
}

// ── Bucle de trabajos ────────────────────────────────────────────────

func (a *Agent) pollLoop(ctx context.Context) {
	emptyRuns := 0
	errorRuns := 0

	for {
		cfg := a.Config()
		if !cfg.Linked() {
			// Sin token no hay nada que hacer más que esperar a que
			// alguien abra la página y lo pegue. No se golpea al
			// servidor con 401 en bucle.
			if !a.sleep(ctx, 5*time.Second) {
				return
			}
			continue
		}

		printed, err := a.pollOnce(ctx)
		switch {
		case err != nil:
			errorRuns++
			emptyRuns = 0
			a.noteError(err)
			wait := errorBackoff(errorRuns)
			if errors.Is(err, api.ErrUnauthorized) {
				// El token no se arregla reintentando; se arregla
				// pegando uno nuevo. Se espera largo y se dice claro.
				wait = 30 * time.Second
				a.log.Errorf("token rechazado por el servidor: abrí la página de configuración y pegá el token de vinculación otra vez")
			} else {
				a.log.Warnf("no se pudieron pedir trabajos (intento %d, reintento en %s): %v",
					errorRuns, wait.Round(time.Second), err)
			}
			if !a.sleep(ctx, wait) {
				return
			}
		case printed > 0:
			// Hubo trabajo: puede haber más esperando. Se vuelve a
			// preguntar enseguida en vez de dormir el intervalo.
			errorRuns, emptyRuns = 0, 0
			if !a.sleep(ctx, 250*time.Millisecond) {
				return
			}
		default:
			errorRuns = 0
			emptyRuns++
			if !a.sleep(ctx, idleBackoff(a.pollInterval(), emptyRuns)) {
				return
			}
		}
	}
}

func (a *Agent) pollInterval() time.Duration {
	return time.Duration(a.Config().PollSeconds) * time.Second
}

// pollOnce hace una vuelta completa. Devuelve cuántos trabajos se
// procesaron (impresos, duplicados o fallidos: todo lo que consumió una
// entrega).
func (a *Agent) pollOnce(ctx context.Context) (int, error) {
	client := a.apiClient()
	resp, broken, err := client.FetchJobs(ctx, JobLimit)
	if err != nil {
		return 0, err
	}
	a.noteContact(resp.Agent.Label)

	// Los que llegaron rotos se confirman como fallidos enseguida: si no
	// se confirman, el servidor los re-entrega cada 2 minutos hasta
	// agotar los intentos y tapan la cola mientras tanto.
	for _, b := range broken {
		a.log.Errorf("trabajo %s inservible: %s", b.JobID, b.Reason)
		a.ackFailure(ctx, client, b.JobID, b.Reason)
		a.bumpFailed()
	}

	if len(resp.Jobs) == 0 {
		return len(broken), nil
	}

	// Se agrupa por impresora y cada grupo va en su propia goroutine.
	//
	// Dentro de un grupo el orden se respeta (una cocina espera las
	// comandas en el orden en que se pidieron). Entre grupos no hace
	// falta, y separarlos evita el escenario feo: la impresora de la
	// barra está apagada, cada intento tarda 5 segundos en dar timeout,
	// y las comandas de cocina se quedan haciendo cola detrás.
	groups := map[string][]api.Job{}
	order := []string{}
	for _, job := range resp.Jobs {
		key := job.Printer.ID
		if key == "" {
			key = job.Printer.Addr()
		}
		if _, ok := groups[key]; !ok {
			order = append(order, key)
		}
		groups[key] = append(groups[key], job)
	}

	var wg sync.WaitGroup
	for _, key := range order {
		jobs := groups[key]
		wg.Add(1)
		go func(jobs []api.Job) {
			defer wg.Done()
			for _, job := range jobs {
				a.handleJob(ctx, client, job)
			}
		}(jobs)
	}
	wg.Wait()

	return len(resp.Jobs) + len(broken), nil
}

// handleJob es el camino de una comanda: ¿ya salió? → escribir bytes →
// anotar → confirmar.
func (a *Agent) handleJob(ctx context.Context, client *api.Client, job api.Job) {
	label := a.printerLabel(job)

	// Paso 1: ¿ya la imprimimos? Pasa cuando el ack anterior se perdió.
	// Confirmar sin reimprimir es exactamente lo que hay que hacer.
	if a.store.Has(job.ID) {
		a.log.Warnf("trabajo %s ya estaba impreso (el acuse anterior no llegó): se confirma sin reimprimir", job.ID)
		a.bumpDuplicate()
		a.ackSuccess(ctx, client, job.ID)
		return
	}

	// Paso 2: escribir los bytes. Host y puerto son los que manda el
	// servidor: es el espejo de lo que este mismo agente le declaró.
	addr := job.Printer.Addr()
	start := time.Now()
	err := a.printer.Print(addr, job.Payload)
	if err != nil {
		kind, _ := printer.KindOf(err)
		a.log.Errorf("trabajo %s (%s → %s): %v [%s]", job.ID, job.Kind, label, err, kind)
		a.bumpFailed()
		a.noteJobError(err)
		a.ackFailure(ctx, client, job.ID, err.Error())
		return
	}

	// Paso 3: anotarlo ANTES de confirmar. Si el ack falla, el servidor
	// va a re-entregar; esta marca es lo único que impide que la cocina
	// reciba el mismo pedido dos veces.
	if err := a.store.Mark(job.ID); err != nil {
		// No se aborta: la comanda YA salió. Se avisa fuerte porque
		// implica que se perdió la protección contra duplicados.
		a.log.Errorf("no se pudo anotar el trabajo %s como impreso (%v): si el acuse falla podría reimprimirse", job.ID, err)
	}

	a.log.Infof("trabajo %s (%s) impreso en %s [%s] — %d bytes en %s (intento %d)",
		job.ID, job.Kind, label, addr, len(job.Payload),
		time.Since(start).Round(time.Millisecond), job.Attempt)
	a.notePrinted(job.ID, label)

	// Paso 4: confirmar.
	a.ackSuccess(ctx, client, job.ID)
}

func (a *Agent) ackSuccess(ctx context.Context, client *api.Client, jobID string) {
	if _, err := client.AckSuccess(ctx, jobID); err != nil {
		// Se pierde el acuse, no la comanda. El servidor la va a
		// re-entregar en 2 minutos y el dedupe la va a reconocer.
		a.log.Warnf("no se pudo confirmar el trabajo %s (%v): el servidor lo va a reenviar y se confirmará sin reimprimir", jobID, err)
	}
}

func (a *Agent) ackFailure(ctx context.Context, client *api.Client, jobID, reason string) {
	resp, err := client.AckFailure(ctx, jobID, reason)
	if err != nil {
		a.log.Warnf("no se pudo reportar el fallo del trabajo %s: %v", jobID, err)
		return
	}
	if resp.WillRetry {
		a.log.Infof("el servidor va a reintentar el trabajo %s (intento %d de %d)",
			jobID, resp.Attempts, resp.MaxAttempts)
	} else {
		a.log.Errorf("el servidor dio por perdido el trabajo %s tras %d intentos",
			jobID, resp.Attempts)
	}
}

// ── Latido ───────────────────────────────────────────────────────────

func (a *Agent) heartbeatLoop(ctx context.Context) {
	for {
		cfg := a.Config()
		interval := time.Duration(cfg.HeartbeatSeconds) * time.Second
		if cfg.Linked() {
			if resp, err := a.apiClient().Heartbeat(ctx); err != nil {
				a.log.Warnf("latido fallido: %v", err)
			} else {
				a.mu.Lock()
				a.status.PendingJobsServer = resp.PendingJobs
				a.status.AgentLabel = resp.Agent.Label
				a.mu.Unlock()
				a.noteContact(resp.Agent.Label)
			}
		}
		if !a.sleep(ctx, interval) {
			return
		}
	}
}

// ── Sincronización de impresoras ─────────────────────────────────────

func (a *Agent) syncLoop(ctx context.Context) {
	// Cada 15 minutos aunque nada cambie: cubre el caso de que el
	// servidor se haya restaurado de un backup y perdido las impresoras.
	const period = 15 * time.Minute
	timer := time.NewTimer(0)
	defer timer.Stop()

	for {
		if a.Config().Linked() {
			a.syncPrintersOnce(ctx)
		}
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(period)
		select {
		case <-ctx.Done():
			return
		case <-a.reload:
			// Cambió la configuración desde la página: se sincroniza ya.
		case <-timer.C:
		}
	}
}

func (a *Agent) syncPrintersOnce(ctx context.Context) {
	cfg := a.Config()
	inputs := make([]api.PrinterInput, 0, len(cfg.Printers))
	for _, p := range cfg.ActivePrinters() {
		in := api.PrinterInput{
			LocalKey: p.LocalKey,
			Label:    p.Label,
			Host:     p.Host,
			Port:     p.Port,
			Station:  p.Station,
			Active:   true,
		}
		if p.BarSubStation != "" {
			sub := p.BarSubStation
			in.BarSubStation = &sub
		}
		if p.PaperWidthMm != 0 {
			w := p.PaperWidthMm
			in.PaperWidthMm = &w
		}
		inputs = append(inputs, in)
	}

	result, err := a.apiClient().SyncPrinters(ctx, inputs)
	if err != nil {
		note := err.Error()
		if errors.Is(err, api.ErrNotImplemented) {
			// La ruta se está escribiendo del lado servidor. No es un
			// problema del local y no hay que asustar a nadie con esto.
			note = "el servidor todavía no acepta la sincronización de impresoras (no afecta la impresión)"
			a.log.Infof("%s", note)
		} else {
			a.log.Warnf("no se pudieron sincronizar las impresoras: %v", err)
		}
		a.mu.Lock()
		a.status.PrintersSynced = false
		a.status.PrintersSyncNote = note
		a.mu.Unlock()
		return
	}

	// Se guardan los ids que devolvió el servidor para poder mostrar en
	// la página a qué impresora del servidor corresponde cada una.
	byKey := map[string]string{}
	for _, sp := range result {
		if sp.LocalKey != "" {
			byKey[sp.LocalKey] = sp.ID
		}
	}
	a.mu.Lock()
	for i := range a.cfg.Printers {
		if id, ok := byKey[a.cfg.Printers[i].LocalKey]; ok {
			a.cfg.Printers[i].ServerID = id
		}
	}
	a.status.PrintersSynced = true
	a.status.PrintersSyncNote = ""
	updated := a.cfg
	a.mu.Unlock()

	a.log.Infof("impresoras sincronizadas con el servidor: %d", len(result))

	// Se persisten los ids para no perderlos al reiniciar.
	if err := config.Save(a.cfgPath, updated); err != nil {
		a.log.Warnf("no se pudo guardar la configuración con los ids del servidor: %v", err)
	}
}

// ── Estado ───────────────────────────────────────────────────────────

func (a *Agent) apiClient() *api.Client {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.client
}

func (a *Agent) printerLabel(job api.Job) string {
	if p, ok := a.Config().PrinterByServerID(job.Printer.ID); ok {
		return p.Label
	}
	if job.Printer.Label != "" {
		return job.Printer.Label
	}
	return job.Printer.Addr()
}

func (a *Agent) noteContact(agentLabel string) {
	now := time.Now()
	a.mu.Lock()
	defer a.mu.Unlock()
	a.status.Connected = true
	a.status.LastContactAt = &now
	a.status.LastError = ""
	if agentLabel != "" {
		a.status.AgentLabel = agentLabel
	}
}

func (a *Agent) noteError(err error) {
	now := time.Now()
	a.mu.Lock()
	defer a.mu.Unlock()
	a.status.Connected = false
	a.status.LastError = err.Error()
	a.status.LastErrorAt = &now
}

// noteJobError guarda el error de impresión SIN marcar el servidor como
// desconectado: que la impresora esté apagada no dice nada del servidor,
// y confundirlos manda a diagnosticar al lugar equivocado.
func (a *Agent) noteJobError(err error) {
	now := time.Now()
	a.mu.Lock()
	defer a.mu.Unlock()
	a.status.LastError = err.Error()
	a.status.LastErrorAt = &now
}

func (a *Agent) notePrinted(jobID, label string) {
	now := time.Now()
	a.mu.Lock()
	defer a.mu.Unlock()
	a.status.LastPrintedJobID = jobID
	a.status.LastPrintedLabel = label
	a.status.LastPrintedAt = &now
	a.status.PrintedSinceStart++
}

func (a *Agent) bumpFailed() {
	a.mu.Lock()
	a.status.FailedSinceStart++
	a.mu.Unlock()
}

func (a *Agent) bumpDuplicate() {
	a.mu.Lock()
	a.status.DuplicatesSkipped++
	a.mu.Unlock()
}

// sleep espera d, o vuelve antes si cambió la configuración o si hay que
// terminar. Devuelve false cuando hay que salir del bucle.
func (a *Agent) sleep(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
