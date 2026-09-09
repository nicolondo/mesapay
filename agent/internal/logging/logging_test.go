package logging

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestEscribeAlArchivo(t *testing.T) {
	path := filepath.Join(t.TempDir(), "logs", "agent.log")
	l := New(path, nil)
	defer l.Close()

	l.Infof("comanda %s impresa en %s", "job-1", "Cocina")
	l.Errorf("no se pudo conectar a %s", "192.168.1.50:9100")

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("el log no se creó: %v", err)
	}
	body := string(raw)
	if !strings.Contains(body, "comanda job-1 impresa en Cocina") {
		t.Error("falta la línea de info")
	}
	if !strings.Contains(body, "[error]") || !strings.Contains(body, "192.168.1.50:9100") {
		t.Error("falta la línea de error")
	}
}

func TestRotaCuandoCreceYConservaLosAnteriores(t *testing.T) {
	// Nadie va a ir a borrar el log de una cocina: si no rota, llena el
	// disco del PC de la caja.
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.log")
	l := New(path, nil)
	defer l.Close()

	linea := strings.Repeat("x", 4096)
	for i := 0; i < (MaxFileBytes/4096)*3; i++ {
		l.Infof("%s", linea)
	}

	if _, err := os.Stat(path + ".1"); err != nil {
		t.Fatalf("no se generó el archivo rotado: %v", err)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if st.Size() >= MaxFileBytes {
		t.Errorf("el archivo activo mide %d, debería haber rotado antes de %d", st.Size(), MaxFileBytes)
	}
}

func TestNoGuardaMasDeMaxBackups(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.log")
	l := New(path, nil)
	defer l.Close()

	linea := strings.Repeat("x", 4096)
	// Suficiente para forzar más rotaciones que backups permitidos.
	for i := 0; i < (MaxFileBytes/4096)*(MaxBackups+3); i++ {
		l.Infof("%s", linea)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) > MaxBackups+1 {
		t.Errorf("hay %d archivos, el máximo es %d (activo + %d backups)",
			len(entries), MaxBackups+1, MaxBackups)
	}
}

func TestRecentDevuelveLoUltimoPrimero(t *testing.T) {
	// Quien abre la página de diagnóstico quiere ver primero lo último
	// que pasó, no el arranque de hace tres horas.
	l := New(filepath.Join(t.TempDir(), "agent.log"), nil)
	defer l.Close()

	l.Infof("primera")
	l.Warnf("segunda")
	l.Errorf("tercera")

	recent := l.Recent(10)
	if len(recent) != 3 {
		t.Fatalf("entradas = %d", len(recent))
	}
	if recent[0].Message != "tercera" || recent[2].Message != "primera" {
		t.Errorf("orden = %q, %q, %q", recent[0].Message, recent[1].Message, recent[2].Message)
	}
	if recent[0].Level != LevelError || recent[1].Level != LevelWarn {
		t.Errorf("los niveles no se conservaron: %+v", recent)
	}
}

func TestElBufferEnMemoriaNoCreceSinLimite(t *testing.T) {
	l := New(filepath.Join(t.TempDir(), "agent.log"), nil)
	defer l.Close()
	for i := 0; i < RecentSize*3; i++ {
		l.Infof("linea %d", i)
	}
	if got := len(l.Recent(0)); got != RecentSize {
		t.Errorf("entradas en memoria = %d, el tope es %d", got, RecentSize)
	}
}

func TestUnDestinoImposibleNoTumbaAlAgente(t *testing.T) {
	// Disco lleno o sin permisos: se pierde el log, no el servicio. Una
	// cocina tiene que seguir imprimiendo aunque no se pueda loguear.
	l := New("/proceso/inexistente/imposible/agent.log", nil)
	defer l.Close()
	l.Infof("esto no se puede escribir a ningún lado")
	if got := len(l.Recent(0)); got != 1 {
		t.Errorf("el buffer en memoria debería seguir funcionando, entradas = %d", got)
	}
}

func TestEsSeguroDesdeVariasGoroutines(t *testing.T) {
	// Los tres bucles del agente loguean a la vez.
	l := New(filepath.Join(t.TempDir(), "agent.log"), nil)
	defer l.Close()

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				l.Infof("goroutine %d linea %d", n, j)
				l.Recent(5)
			}
		}(i)
	}
	wg.Wait()
}
