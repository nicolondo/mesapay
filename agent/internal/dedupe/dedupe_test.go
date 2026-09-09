package dedupe

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRecuerdaLoImpreso(t *testing.T) {
	s := Open(filepath.Join(t.TempDir(), "state.json"))
	if s.Has("job1") {
		t.Error("un trabajo nuevo no puede estar marcado")
	}
	if err := s.Mark("job1"); err != nil {
		t.Fatalf("Mark: %v", err)
	}
	if !s.Has("job1") {
		t.Error("job1 debería estar marcado")
	}
	if s.Has("job2") {
		t.Error("job2 no fue marcado")
	}
}

func TestSobreviveAlReinicioDelPC(t *testing.T) {
	// El escenario entero: se imprime, se corta la luz, el PC vuelve y
	// el servidor re-entrega la misma comanda. Si no se recuerda, la
	// cocina la ve dos veces.
	path := filepath.Join(t.TempDir(), "state.json")
	primera := Open(path)
	if err := primera.Mark("comanda-123"); err != nil {
		t.Fatal(err)
	}

	// Un proceso nuevo, como después del reinicio.
	segunda := Open(path)
	if !segunda.Has("comanda-123") {
		t.Fatal("tras reiniciar, el agente reimprimiría la comanda")
	}
}

func TestOlvidaLoViejo(t *testing.T) {
	// Pasado el TTL del servidor ya no re-entrega nada, así que
	// recordarlo sólo engorda el archivo.
	path := filepath.Join(t.TempDir(), "state.json")
	viejo := time.Now().Add(-48 * time.Hour)
	raw, _ := json.Marshal(fileFormat{Printed: map[string]time.Time{
		"antiguo":  viejo,
		"reciente": time.Now(),
	}})
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	s := Open(path)
	if s.Has("antiguo") {
		t.Error("un trabajo de hace 48h no debería recordarse")
	}
	if !s.Has("reciente") {
		t.Error("el reciente sí")
	}
}

func TestArchivoCorruptoNoImpideArrancar(t *testing.T) {
	// Vale más arrancar con la memoria vacía (a lo sumo una comanda
	// repetida) que negarse a imprimir en todo el local.
	path := filepath.Join(t.TempDir(), "state.json")
	if err := os.WriteFile(path, []byte("{roto"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := Open(path)
	if s.Count() != 0 {
		t.Errorf("se esperaba memoria vacía, hay %d", s.Count())
	}
	if err := s.Mark("nuevo"); err != nil {
		t.Fatalf("debería poder seguir trabajando: %v", err)
	}
	if !s.Has("nuevo") {
		t.Error("el nuevo debería quedar marcado")
	}
}

func TestArchivoInexistenteEsUnArranqueLimpio(t *testing.T) {
	s := Open(filepath.Join(t.TempDir(), "no", "existe", "state.json"))
	if s.Count() != 0 {
		t.Errorf("Count = %d", s.Count())
	}
	// El directorio tampoco existe: Mark lo tiene que crear.
	if err := s.Mark("x"); err != nil {
		t.Fatalf("Mark debería crear el directorio: %v", err)
	}
}

func TestNoCreceSinLimite(t *testing.T) {
	// Un servidor entregando en bucle no puede llenar el disco del PC
	// de la caja.
	s := Open(filepath.Join(t.TempDir(), "state.json"))
	s.setMaxEntries(50)
	total := 250
	for i := 0; i < total; i++ {
		if err := s.Mark("job-" + itoa(i)); err != nil {
			t.Fatal(err)
		}
	}
	if s.Count() > 50 {
		t.Errorf("Count = %d, el tope es 50", s.Count())
	}
	// La poda tiene que llevarse los más viejos, no los últimos: son
	// justamente los últimos los que el servidor podría re-entregar
	// ahora mismo.
	ultimo := "job-" + itoa(total-1)
	if !s.Has(ultimo) {
		t.Errorf("el trabajo más reciente (%s) se perdió en la poda", ultimo)
	}
	if s.Has("job-0") {
		t.Error("el más viejo debería haberse podado antes que el más nuevo")
	}
}

func TestEscrituraAtomicaNoDejaTemporales(t *testing.T) {
	dir := t.TempDir()
	s := Open(filepath.Join(dir, "state.json"))
	for i := 0; i < 5; i++ {
		if err := s.Mark("job" + itoa(i)); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Errorf("archivos = %d, se esperaba 1 (quedaron temporales)", len(entries))
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
