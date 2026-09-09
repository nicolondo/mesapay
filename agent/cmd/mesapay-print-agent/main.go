// Command mesapay-print-agent es el programa de impresión de MESAPAY.
//
// Corre como servicio en un PC del local, pide las comandas al servidor
// y las escribe en las impresoras térmicas de la red por ESC/POS crudo
// (TCP 9100). Reemplaza la pestaña de Chrome con window.print(), que
// perdía comandas en silencio apenas alguien cambiaba de pestaña.
//
// Uso:
//
//	mesapay-print-agent                 corre en primer plano (o como servicio si lo arrancó Windows)
//	mesapay-print-agent config          muestra dónde está la configuración y qué dice
//	mesapay-print-agent install         registra el servicio de Windows (como Administrador)
//	mesapay-print-agent uninstall       lo borra
//	mesapay-print-agent start | stop    lo arranca o lo detiene
//	mesapay-print-agent version         imprime la versión
package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"mesapay.co/print-agent/internal/agent"
	"mesapay.co/print-agent/internal/config"
	"mesapay.co/print-agent/internal/dedupe"
	"mesapay.co/print-agent/internal/logging"
	"mesapay.co/print-agent/internal/ui"
	"mesapay.co/print-agent/internal/winsvc"
)

// version se sobreescribe al compilar:
//
//	go build -ldflags "-X main.version=1.2.0"
//
// Viaja en cada latido, así que desde el panel se puede ver qué local
// quedó con una versión vieja sin llamar a nadie.
var version = "dev"

func main() {
	cmd := ""
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}

	switch cmd {
	case "version", "-v", "--version":
		fmt.Printf("mesapay-print-agent %s (%s/%s)\n", version, runtime.GOOS, runtime.GOARCH)
	case "config":
		printConfigLocation()
	case "install":
		exe, err := os.Executable()
		if err != nil {
			fail(err)
		}
		if err := winsvc.Install(exe); err != nil {
			fail(err)
		}
		fmt.Printf("Servicio %q instalado.\nArrancalo con: %s start\n", winsvc.ServiceName, filepath.Base(exe))
	case "uninstall":
		if err := winsvc.Uninstall(); err != nil {
			fail(err)
		}
		fmt.Printf("Servicio %q desinstalado. La configuración y los logs quedan en %s\n",
			winsvc.ServiceName, config.DefaultDir())
	case "start":
		if err := winsvc.Start(); err != nil {
			fail(err)
		}
		fmt.Println("Servicio arrancado.")
	case "stop":
		if err := winsvc.Stop(); err != nil {
			fail(err)
		}
		fmt.Println("Servicio detenido.")
	case "", "run":
		runAgent()
	default:
		fmt.Fprintf(os.Stderr, "Comando desconocido: %q\n", cmd)
		fmt.Fprintln(os.Stderr, "Usá: mesapay-print-agent [run|install|uninstall|start|stop|config|version]")
		os.Exit(2)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "Error:", err)
	os.Exit(1)
}

func printConfigLocation() {
	path := config.DefaultPath()
	fmt.Println("Configuración:", path)
	fmt.Println("Logs:         ", filepath.Join(config.DefaultDir(), "logs", "agent.log"))
	cfg, err := config.Load(path)
	if err != nil {
		fail(err)
	}
	fmt.Println("Servidor:     ", cfg.ServerURL)
	fmt.Println("Vinculado:    ", cfg.Linked())
	fmt.Println("Impresoras:")
	if len(cfg.Printers) == 0 {
		fmt.Println("   (ninguna configurada)")
	}
	for _, p := range cfg.Printers {
		estado := "activa"
		if !p.Active {
			estado = "desactivada"
		}
		fmt.Printf("   %-14s %-22s %-8s %s\n", p.LocalKey, p.Addr(), p.Station, estado)
	}
	fmt.Printf("\nPágina de configuración: http://127.0.0.1:%d (con el agente corriendo)\n", cfg.UIPort)
}

// runAgent es el arranque real. El mismo código sirve para el servicio y
// para la consola: lo único que cambia es quién avisa cuándo parar.
func runAgent() {
	cfgPath := config.DefaultPath()
	dir := config.DefaultDir()

	cfg, cfgErr := config.Load(cfgPath)

	// La consola sólo cuando hay una persona mirando: como servicio, el
	// stdout no va a ningún lado y sólo gasta llamadas al sistema.
	var console *os.File
	if !winsvc.IsWindowsService() {
		console = os.Stdout
	}
	log := logging.New(filepath.Join(dir, "logs", "agent.log"), console)
	defer log.Close()

	if cfgErr != nil {
		// Se sigue con la configuración por defecto: el agente arranca,
		// sirve la página, y quien la abra ve el error y lo corrige.
		// Negarse a arrancar dejaría al local sin ninguna forma de
		// arreglarlo salvo editar JSON a mano.
		log.Errorf("no se pudo leer la configuración (%v): se arranca con la configuración por defecto", cfgErr)
	}
	log.Infof("configuración: %s", cfgPath)
	log.Infof("logs: %s", log.Path())

	store := dedupe.Open(filepath.Join(dir, "state.json"))
	log.Infof("trabajos recordados de la sesión anterior: %d", store.Count())

	a := agent.New(cfgPath, cfg, store, log, version)
	page := ui.New(a, cfgPath, log, cfg.UIPort)

	run := func(ctx context.Context) {
		go func() {
			if err := page.Start(ctx); err != nil {
				// Que la página no abra no puede tumbar la impresión: un
				// agente ya configurado no la necesita para trabajar.
				log.Errorf("%v (el agente sigue imprimiendo; para configurarlo, liberá ese puerto o cambiá uiPort en %s)",
					err, cfgPath)
			}
		}()

		// Primera instalación: sin token no hay nada que hacer salvo
		// configurar, así que se le abre la página al que está adelante.
		if !cfg.Linked() && console != nil {
			openBrowser(page.URL())
			log.Infof("el agente no está vinculado todavía: abrí %s y pegá el token", page.URL())
		}

		a.Run(ctx)
	}

	if winsvc.IsWindowsService() {
		if err := winsvc.Run(run); err != nil {
			log.Errorf("el servicio terminó con error: %v", err)
			os.Exit(1)
		}
		return
	}

	// En consola: Ctrl+C corta, y se le da un momento a lo que esté en
	// vuelo para que confirme antes de salir.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	run(ctx)
}

// openBrowser abre la página de configuración. Best-effort: si falla, el
// log ya dice la URL para copiarla a mano.
func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	// Se le da un segundo al servidor local para que escuche, si no el
	// navegador abre en un "no se puede conectar" y asusta al que instala.
	time.Sleep(500 * time.Millisecond)
	_ = cmd.Start()
}
