package ui

import (
	_ "embed"
	"net/http"
)

// La página va DENTRO del binario. Es la razón entera de elegir Go: se
// copia un .exe al PC de la cocina y no hay que llevar una carpeta de
// archivos sueltos que alguien va a mover o borrar.
//
//go:embed assets/index.html
var indexHTML []byte

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	// Sin recursos externos: la página tiene que abrir con el internet
	// caído, que es justo cuando alguien la necesita.
	w.Header().Set("Content-Security-Policy",
		"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(indexHTML)
}
