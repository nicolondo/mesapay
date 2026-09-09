// Package logging es el log del agente: a archivo con rotación y, en
// paralelo, a un buffer circular en memoria.
//
// Cuando algo falle va a ser en una cocina, a 400 km, un viernes a las
// 9pm, y lo único que vamos a tener es este archivo. Por eso rota solo
// (nadie va a ir a borrarlo) y por eso el buffer en memoria: la página
// de configuración muestra los últimos errores sin que nadie tenga que
// buscar una ruta en el disco.
package logging

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Límites de rotación. 5 archivos de 2MB = 10MB como mucho en el disco
// del PC de la caja, que suele ser el más lleno del local.
const (
	MaxFileBytes = 2 << 20
	MaxBackups   = 5
	// RecentSize: cuántas líneas guarda el buffer en memoria para la
	// página de estado. 200 alcanzan para ver un servicio completo.
	RecentSize = 200
)

// Level existe sólo para que la página pueda pintar los errores en rojo.
type Level string

const (
	LevelInfo  Level = "info"
	LevelWarn  Level = "warn"
	LevelError Level = "error"
)

// Entry es una línea del log tal como la ve la página de configuración.
type Entry struct {
	Time    time.Time `json:"time"`
	Level   Level     `json:"level"`
	Message string    `json:"message"`
}

// Logger escribe a archivo (con rotación) y a un buffer circular.
type Logger struct {
	mu sync.Mutex

	path   string
	file   *os.File
	size   int64
	extra  io.Writer // consola, cuando no corre como servicio
	recent []Entry
	next   int
	count  int
}

// New abre (o crea) el archivo de log. Si el archivo no se puede abrir
// —disco lleno, permisos— NO devuelve error: el agente tiene que seguir
// imprimiendo comandas aunque no pueda loguear. Se pierde el log, no el
// servicio.
func New(path string, console io.Writer) *Logger {
	l := &Logger{
		path:   path,
		extra:  console,
		recent: make([]Entry, RecentSize),
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err == nil {
		if f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); err == nil {
			l.file = f
			if st, err := f.Stat(); err == nil {
				l.size = st.Size()
			}
		}
	}
	return l
}

// Path es dónde está el archivo, para poder decírselo a quien pide soporte.
func (l *Logger) Path() string { return l.path }

func (l *Logger) Infof(format string, args ...any)  { l.logf(LevelInfo, format, args...) }
func (l *Logger) Warnf(format string, args ...any)  { l.logf(LevelWarn, format, args...) }
func (l *Logger) Errorf(format string, args ...any) { l.logf(LevelError, format, args...) }

func (l *Logger) logf(level Level, format string, args ...any) {
	entry := Entry{Time: time.Now(), Level: level, Message: fmt.Sprintf(format, args...)}
	line := fmt.Sprintf("%s [%s] %s\n",
		entry.Time.Format("2006-01-02 15:04:05.000"), level, entry.Message)

	l.mu.Lock()
	defer l.mu.Unlock()

	l.recent[l.next] = entry
	l.next = (l.next + 1) % len(l.recent)
	if l.count < len(l.recent) {
		l.count++
	}

	if l.extra != nil {
		fmt.Fprint(l.extra, line)
	}
	if l.file == nil {
		return
	}
	n, err := l.file.WriteString(line)
	if err != nil {
		return
	}
	l.size += int64(n)
	if l.size >= MaxFileBytes {
		l.rotateLocked()
	}
}

// Recent devuelve las últimas líneas, de la más nueva a la más vieja.
// Ese orden y no el cronológico porque quien abre la página de
// diagnóstico quiere ver PRIMERO lo último que pasó.
func (l *Logger) Recent(limit int) []Entry {
	l.mu.Lock()
	defer l.mu.Unlock()
	if limit <= 0 || limit > l.count {
		limit = l.count
	}
	out := make([]Entry, 0, limit)
	for i := 0; i < limit; i++ {
		idx := (l.next - 1 - i + len(l.recent)*2) % len(l.recent)
		out = append(out, l.recent[idx])
	}
	return out
}

// Close cierra el archivo.
func (l *Logger) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file == nil {
		return nil
	}
	err := l.file.Close()
	l.file = nil
	return err
}

// rotateLocked corre el archivo actual a .1, el .1 a .2, etc.
//
// Windows no deja renombrar un archivo abierto, así que se cierra
// primero. Si algo falla a mitad, se intenta reabrir igual: quedarse sin
// log es malo, quedarse sin agente es peor.
func (l *Logger) rotateLocked() {
	if l.file != nil {
		l.file.Close()
		l.file = nil
	}
	os.Remove(fmt.Sprintf("%s.%d", l.path, MaxBackups))
	for i := MaxBackups - 1; i >= 1; i-- {
		os.Rename(fmt.Sprintf("%s.%d", l.path, i), fmt.Sprintf("%s.%d", l.path, i+1))
	}
	os.Rename(l.path, l.path+".1")

	l.size = 0
	if f, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); err == nil {
		l.file = f
		if st, err := f.Stat(); err == nil {
			l.size = st.Size()
		}
	}
}
