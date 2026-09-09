package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadArchivoInexistenteDevuelveDefaults(t *testing.T) {
	// Un agente recién instalado no tiene archivo. No es un error: es el
	// estado esperado antes de que alguien abra la página.
	cfg, err := Load(filepath.Join(t.TempDir(), "no-existe.json"))
	if err != nil {
		t.Fatalf("un archivo ausente no debería ser error: %v", err)
	}
	if cfg.ServerURL != DefaultServerURL {
		t.Errorf("ServerURL = %q, se esperaba %q", cfg.ServerURL, DefaultServerURL)
	}
	if cfg.Linked() {
		t.Error("un agente sin archivo no puede estar vinculado")
	}
}

func TestGuardarYLeerConservaTodo(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	original := Config{
		ServerURL: "https://mesapay.co",
		Token:     "mpa_deadbeef",
		UIPort:    9110,
		Printers: []Printer{
			{LocalKey: "cocina", Label: "Cocina", Host: "192.168.1.50", Port: 9100,
				Station: "kitchen", PaperWidthMm: 80, Active: true},
			{LocalKey: "barra", Label: "Barra", Host: "192.168.1.51", Port: 9100,
				Station: "bar", BarSubStation: "cocteles", PaperWidthMm: 58, Active: true},
		},
	}
	if err := Save(path, original); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got.Token != original.Token {
		t.Errorf("token = %q", got.Token)
	}
	if len(got.Printers) != 2 {
		t.Fatalf("impresoras = %d, se esperaban 2", len(got.Printers))
	}
	if got.Printers[1].BarSubStation != "cocteles" {
		t.Errorf("la sub-estación de barra se perdió: %q", got.Printers[1].BarSubStation)
	}
	if got.Printers[1].PaperWidthMm != 58 {
		t.Errorf("el ancho de papel se perdió: %d", got.Printers[1].PaperWidthMm)
	}
}

func TestSaveNoDejaElTokenLegibleParaCualquiera(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := Save(path, Config{Token: "mpa_secreto"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := st.Mode().Perm(); perm != 0o600 {
		t.Errorf("permisos = %o, se esperaba 600: el token da acceso al comercio", perm)
	}
}

func TestNormalizeCorrigeLoQueRompeAlServidor(t *testing.T) {
	cfg := Config{
		ServerURL: "  https://mesapay.co/  ", // espacios y barra final
		Token:     "  mpa_x  ",
		Printers: []Printer{
			// Estación inventada: el servidor la rechazaría.
			{Label: "Cocina", Host: " 192.168.1.50 ", Port: 0, Station: "COCINA"},
			// Sub-estación en una impresora que no es de barra.
			{LocalKey: "caja", Label: "Caja", Host: "10.0.0.9", Station: "counter",
				BarSubStation: "cocteles", PaperWidthMm: 77},
		},
	}
	cfg.Normalize()

	if cfg.ServerURL != "https://mesapay.co" {
		t.Errorf("ServerURL = %q", cfg.ServerURL)
	}
	if cfg.Token != "mpa_x" {
		t.Errorf("el token quedó con espacios: %q", cfg.Token)
	}
	p0 := cfg.Printers[0]
	if p0.Port != DefaultPort {
		t.Errorf("puerto 0 debería volverse %d, quedó %d", DefaultPort, p0.Port)
	}
	if p0.Station != "kitchen" {
		t.Errorf("estación inválida debería caer en kitchen, quedó %q", p0.Station)
	}
	if p0.Host != "192.168.1.50" {
		t.Errorf("el host quedó con espacios: %q", p0.Host)
	}
	if p0.LocalKey != "cocina" {
		t.Errorf("localKey generada = %q, se esperaba «cocina»", p0.LocalKey)
	}
	p1 := cfg.Printers[1]
	if p1.BarSubStation != "" {
		t.Errorf("una impresora de mostrador no puede tener sub-estación de barra: %q", p1.BarSubStation)
	}
	if p1.PaperWidthMm != DefaultPaperWidthMm {
		t.Errorf("ancho 77mm no existe; debería caer en %d, quedó %d", DefaultPaperWidthMm, p1.PaperWidthMm)
	}
}

func TestNormalizeNoPermitePollearMasRapidoQueUnSegundo(t *testing.T) {
	// Un poll de 0s convertiría al agente en un martillo contra el VPS.
	cfg := Config{PollSeconds: 0}
	cfg.Normalize()
	if cfg.PollSeconds < 1 {
		t.Errorf("PollSeconds = %d", cfg.PollSeconds)
	}
	cfg = Config{PollSeconds: 9999}
	cfg.Normalize()
	if cfg.PollSeconds > 60 {
		t.Errorf("PollSeconds = %d, debería estar acotado", cfg.PollSeconds)
	}
}

func TestValidateAvisaLosErroresDeInstalacionTipicos(t *testing.T) {
	cfg := Config{
		ServerURL: "mesapay.co", // sin https
		Token:     "abc123",     // sin el prefijo mpa_
		Printers: []Printer{
			{LocalKey: "cocina", Label: "Cocina", Host: ""},    // sin IP
			{LocalKey: "cocina", Label: "Cocina 2", Host: "x"}, // clave repetida
		},
	}
	problems := cfg.Validate()
	if len(problems) < 3 {
		t.Fatalf("se esperaban al menos 3 avisos, hubo %d: %v", len(problems), problems)
	}
	joined := strings.Join(problems, " | ")
	for _, want := range []string{"https://", TokenPrefix, "no tiene IP", "misma clave"} {
		if !strings.Contains(joined, want) {
			t.Errorf("falta el aviso sobre %q en: %s", want, joined)
		}
	}
}

func TestValidateAceptaUnaConfiguracionSana(t *testing.T) {
	cfg := Config{
		ServerURL: "https://mesapay.co",
		Token:     "mpa_abc",
		Printers:  []Printer{{LocalKey: "cocina", Label: "Cocina", Host: "192.168.1.50", Port: 9100}},
	}
	if problems := cfg.Validate(); len(problems) != 0 {
		t.Errorf("no debería haber avisos: %v", problems)
	}
}

func TestPrinterAddr(t *testing.T) {
	p := Printer{Host: "192.168.1.50", Port: 9100}
	if got := p.Addr(); got != "192.168.1.50:9100" {
		t.Errorf("Addr() = %q", got)
	}
	// IPv6: el host tiene que ir entre corchetes o net.Dial falla.
	p6 := Printer{Host: "fd00::1", Port: 9100}
	if got := p6.Addr(); got != "[fd00::1]:9100" {
		t.Errorf("Addr() IPv6 = %q", got)
	}
}

func TestSaveEsAtomicoYNoDejaBasura(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	for i := 0; i < 3; i++ {
		if err := Save(path, Config{Token: "mpa_x"}); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	// Un temporal olvidado por guardado significaría que el rename no
	// está pasando y que un corte de luz puede dejar el archivo a medias.
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Errorf("quedó un archivo temporal: %s", e.Name())
		}
	}
	if len(entries) != 1 {
		t.Errorf("se esperaba 1 archivo, hay %d", len(entries))
	}
}

func TestDefaultPathRespetaLaVariableDeEntorno(t *testing.T) {
	custom := filepath.Join(t.TempDir(), "otro", "config.json")
	t.Setenv(EnvConfigPath, custom)
	if got := DefaultPath(); got != custom {
		t.Errorf("DefaultPath() = %q, se esperaba %q", got, custom)
	}
	if got := DefaultDir(); got != filepath.Dir(custom) {
		t.Errorf("DefaultDir() = %q", got)
	}
}

func TestActivePrintersFiltraLasApagadas(t *testing.T) {
	cfg := Config{Printers: []Printer{
		{LocalKey: "a", Active: true},
		{LocalKey: "b", Active: false},
		{LocalKey: "c", Active: true},
	}}
	active := cfg.ActivePrinters()
	if len(active) != 2 {
		t.Fatalf("activas = %d, se esperaban 2", len(active))
	}
}

func TestJSONCorruptoNoTumbaAlAgente(t *testing.T) {
	// Alguien editó el archivo con el Bloc de notas y lo rompió. El
	// agente tiene que devolver el error para loguearlo, pero con una
	// configuración usable para poder arrancar y servir la página.
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte("{esto no es json"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err == nil {
		t.Fatal("se esperaba un error de parseo")
	}
	if cfg.UIPort != DefaultUIPort {
		t.Errorf("aun con error debería devolver defaults usables, UIPort = %d", cfg.UIPort)
	}
}
