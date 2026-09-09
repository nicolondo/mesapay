//go:build windows

// Package winsvc integra el agente con el Administrador de Servicios de
// Windows.
//
// ── Por qué golang.org/x/sys/windows/svc y no un envoltorio ──────────
// Un .exe común NO se puede registrar como servicio: el SCM le habla por
// un canal propio al arrancar y, si no le contestan en 30 segundos, lo
// mata con "el servicio no respondió a tiempo". La salida barata es
// NSSM o srvany — otro programa más que instalar en cada cocina, que es
// exactamente lo que estamos tratando de evitar. x/sys es el paquete
// oficial de Go, es Go puro (no necesita cgo ni el toolchain de
// Windows), y deja el .exe en un solo archivo que se registra solo.
package winsvc

import (
	"context"
	"fmt"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// ServiceName es el nombre interno del servicio: el que se usa en
// `sc.exe` y `net start`.
const ServiceName = "MesapayPrintAgent"

// DisplayName es lo que se ve en services.msc.
const DisplayName = "MESAPAY - Agente de impresión"

// Description sale en services.msc; que diga algo útil ahorra una
// llamada a soporte cuando alguien lo encuentra y se pregunta qué es.
const Description = "Recibe las comandas de MESAPAY y las envía a las impresoras térmicas del local. Si se detiene, la cocina deja de recibir pedidos."

// IsWindowsService dice si nos arrancó el SCM (y no una persona con una
// consola). El binario es el mismo; sólo cambia cómo reporta su estado.
func IsWindowsService() bool {
	ok, err := svc.IsWindowsService()
	return err == nil && ok
}

type handler struct {
	run func(ctx context.Context)
}

// Execute es el contrato del SCM: aceptar, reportar Running, y responder
// a Stop/Shutdown.
func (h *handler) Execute(args []string, req <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	const accepted = svc.AcceptStop | svc.AcceptShutdown

	status <- svc.Status{State: svc.StartPending}
	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan struct{})
	go func() {
		defer close(done)
		h.run(ctx)
	}()

	status <- svc.Status{State: svc.Running, Accepts: accepted}

	for c := range req {
		switch c.Cmd {
		case svc.Interrogate:
			status <- c.CurrentStatus
		case svc.Stop, svc.Shutdown:
			// StopPending antes de cancelar: si no, Windows puede
			// considerar que el servicio se colgó mientras termina de
			// confirmar la comanda que tenía en vuelo.
			status <- svc.Status{State: svc.StopPending}
			cancel()
			<-done
			status <- svc.Status{State: svc.Stopped}
			return false, 0
		}
	}
	cancel()
	<-done
	return false, 0
}

// Run arranca el agente bajo el SCM.
func Run(run func(ctx context.Context)) error {
	return svc.Run(ServiceName, &handler{run: run})
}

// Install registra el servicio y configura el reinicio automático.
//
// Se hace desde el propio binario (`mesapay-print-agent.exe install`) en
// vez de dejarlo sólo documentado: son cinco comandos de `sc.exe` con
// una sintaxis llena de trampas (los espacios después del `=` son
// obligatorios) y quien instala está parado en una cocina, no en una
// terminal.
func Install(exePath string) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("no se pudo hablar con el administrador de servicios (¿abriste la consola como Administrador?): %w", err)
	}
	defer m.Disconnect()

	if existing, err := m.OpenService(ServiceName); err == nil {
		existing.Close()
		return fmt.Errorf("el servicio %s ya existe: desinstalalo primero con «%s uninstall»", ServiceName, exePath)
	}

	s, err := m.CreateService(ServiceName, exePath, mgr.Config{
		DisplayName: DisplayName,
		Description: Description,
		// Automático y como LocalSystem: tiene que arrancar con la
		// máquina y SIN que nadie inicie sesión. El PC de la caja se
		// enciende y se queda en la pantalla de login media hora.
		StartType:        mgr.StartAutomatic,
		ServiceStartName: "",
	})
	if err != nil {
		return fmt.Errorf("no se pudo crear el servicio: %w", err)
	}
	defer s.Close()

	// Reinicio automático ante cualquier caída, siempre. ResetPeriod muy
	// alto = el contador de fallos no se reinicia nunca, así que el
	// tercer fallo del mes también reintenta en vez de rendirse.
	if err := s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 5_000_000_000},
		{Type: mgr.ServiceRestart, Delay: 10_000_000_000},
		{Type: mgr.ServiceRestart, Delay: 30_000_000_000},
	}, 86400); err != nil {
		return fmt.Errorf("el servicio se creó pero no se pudo configurar el reinicio automático: %w", err)
	}
	return nil
}

// Uninstall borra el servicio. Deja la configuración y los logs: si
// alguien reinstala, no tiene que volver a pegar el token.
func Uninstall() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("no se pudo hablar con el administrador de servicios (¿abriste la consola como Administrador?): %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(ServiceName)
	if err != nil {
		return fmt.Errorf("el servicio %s no está instalado", ServiceName)
	}
	defer s.Close()

	if err := s.Delete(); err != nil {
		return fmt.Errorf("no se pudo borrar el servicio: %w", err)
	}
	return nil
}

// Start arranca el servicio ya instalado.
func Start() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(ServiceName)
	if err != nil {
		return fmt.Errorf("el servicio %s no está instalado", ServiceName)
	}
	defer s.Close()
	return s.Start()
}

// Stop detiene el servicio.
func Stop() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(ServiceName)
	if err != nil {
		return fmt.Errorf("el servicio %s no está instalado", ServiceName)
	}
	defer s.Close()
	_, err = s.Control(svc.Stop)
	return err
}
