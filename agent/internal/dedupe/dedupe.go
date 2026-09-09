// Package dedupe recuerda qué trabajos ya salieron por la impresora.
//
// ── Por qué hace falta ───────────────────────────────────────────────
// El servidor re-entrega un trabajo entregado y no confirmado a los ~2
// minutos (CLAIM_RETRY_MS en src/lib/print/claim.ts). Eso es correcto:
// el PC se puede apagar entre "recibí los bytes" y "salió el papel". El
// precio es que si escribimos los bytes y el ack se pierde —se cayó
// internet justo ahí— la comanda vuelve. Sin memoria local, la cocina
// recibe el mismo pedido dos veces y salen dos platos.
//
// Por eso el id del trabajo se anota en disco APENAS la impresora acepta
// los bytes, ANTES de intentar el ack. Si el ack falla y el trabajo
// vuelve, se reconoce y se confirma sin volver a imprimir.
//
// ── Lo que este archivo NO puede arreglar ────────────────────────────
// Queda una ventana de milisegundos entre "la impresora aceptó los
// bytes" y "el id quedó en el disco". Si se corta la luz JUSTO ahí, la
// comanda se imprime dos veces. Es inevitable sin transacciones en la
// impresora, y es el lado correcto en el que equivocarse: un plato de
// más se ve y se resuelve; un plato que nunca se cocinó no.
package dedupe

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// TTL es cuánto se recuerda un id. Tiene que ser mayor que el JOB_TTL_MS
// del servidor (6 horas): pasado ese plazo el servidor ya no re-entrega,
// así que recordarlo no sirve para nada y sólo hace crecer el archivo.
// 24 horas cubre el servicio completo más el margen del cierre.
const TTL = 24 * time.Hour

// MaxEntries es el techo duro por si algo se descontrola (un servidor
// entregando en bucle). Al llegar, se descartan los más viejos.
//
// 2000 sale de la cuenta del peor local imaginable: 300 mesas al día ×
// 2 rondas × 2 impresoras = 1200 trabajos en 24 horas. Y no conviene
// pasarse: Mark reescribe el archivo entero con fsync en CADA comanda,
// así que cada entrada de más es peso muerto en el camino crítico.
const MaxEntries = 2000

// Store es el registro de trabajos ya impresos, respaldado en un archivo.
type Store struct {
	mu      sync.Mutex
	path    string
	printed map[string]time.Time
	// maxEntries es MaxEntries salvo en los tests, que necesitan
	// provocar la poda sin escribir 2000 archivos.
	maxEntries int
}

type fileFormat struct {
	Printed map[string]time.Time `json:"printed"`
}

// Open lee el archivo de estado. Un archivo ausente o corrupto NO es un
// error fatal: se arranca con la memoria vacía. El costo de eso es, como
// mucho, una comanda repetida; el costo de negarse a arrancar es un
// local entero sin impresión.
func Open(path string) *Store {
	s := &Store{path: path, printed: map[string]time.Time{}, maxEntries: MaxEntries}
	raw, err := os.ReadFile(path)
	if err != nil {
		return s
	}
	var parsed fileFormat
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return s
	}
	cutoff := time.Now().Add(-TTL)
	for id, at := range parsed.Printed {
		if at.After(cutoff) {
			s.printed[id] = at
		}
	}
	return s
}

// Has dice si ese trabajo ya se imprimió.
func (s *Store) Has(jobID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	at, ok := s.printed[jobID]
	if !ok {
		return false
	}
	if time.Since(at) > TTL {
		delete(s.printed, jobID)
		return false
	}
	return true
}

// Mark anota el trabajo y lo baja a disco inmediatamente.
//
// El fsync no es paranoia de más: sin él, el id se queda en el caché del
// sistema operativo y un corte de luz —lo habitual en un local— se lo
// lleva, que es exactamente el escenario que este paquete existe para
// cubrir. Son unos milisegundos por comanda.
func (s *Store) Mark(jobID string) error {
	s.mu.Lock()
	s.printed[jobID] = time.Now()
	s.pruneLocked()
	snapshot := make(map[string]time.Time, len(s.printed))
	for k, v := range s.printed {
		snapshot[k] = v
	}
	path := s.path
	s.mu.Unlock()

	return writeAtomic(path, fileFormat{Printed: snapshot})
}

// Count es cuántos ids hay en memoria — lo muestra la página de estado.
func (s *Store) Count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.printed)
}

// pruneLocked saca los vencidos y, si aun así sobran, los más viejos.
func (s *Store) pruneLocked() {
	cutoff := time.Now().Add(-TTL)
	for id, at := range s.printed {
		if at.Before(cutoff) {
			delete(s.printed, id)
		}
	}
	for len(s.printed) > s.maxEntries {
		var oldestID string
		var oldestAt time.Time
		first := true
		for id, at := range s.printed {
			if first || at.Before(oldestAt) {
				oldestID, oldestAt, first = id, at, false
			}
		}
		delete(s.printed, oldestID)
	}
}

func writeAtomic(path string, data fileFormat) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	raw, err := json.Marshal(data)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".state-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}
