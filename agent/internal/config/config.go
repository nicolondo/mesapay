// Package config guarda y lee la configuración local del agente.
//
// El archivo vive fuera del directorio del programa a propósito
// (%ProgramData% en Windows): el servicio corre como LocalSystem, sin
// sesión iniciada, y no puede depender de la carpeta de un usuario que
// tal vez nunca inicie sesión. Además así una actualización del .exe no
// se lleva por delante la configuración del local.
//
// Todo lo que el agente necesita para trabajar está acá: a qué servidor
// habla, con qué token, y qué impresoras hay en la red del comercio. La
// IP de la impresora vive ACÁ y no en el servidor — el servidor la
// espeja sólo para diagnóstico.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// TokenPrefix es el prefijo de los tokens del agente. Coincide con
// PRINT_AGENT_TOKEN_PREFIX del servidor (src/lib/print/agentAuth.ts).
// Sirve para que quien pega el token en la pantalla de configuración se
// dé cuenta enseguida si pegó cualquier otra cosa.
const TokenPrefix = "mpa_"

// EnvConfigPath permite mover el archivo de configuración. Existe sobre
// todo para los tests y para correr dos agentes en la misma máquina
// durante una migración.
const EnvConfigPath = "MESAPAY_AGENT_CONFIG"

// Valores por defecto pensados para una cocina, no para un datacenter.
const (
	// DefaultUIPort: puerto de la página de configuración local. Sólo
	// escucha en 127.0.0.1, nunca en la red del local.
	DefaultUIPort = 9110
	// DefaultPollSeconds: cada cuánto se piden trabajos cuando hay
	// actividad. 3s es el techo de demora que un mesero tolera entre
	// "enviar" y el papel saliendo.
	DefaultPollSeconds = 3
	// DefaultHeartbeatSeconds: cada cuánto se avisa que seguimos vivos.
	DefaultHeartbeatSeconds = 60
	// DefaultPort: puerto ESC/POS crudo. Prácticamente todas las
	// térmicas de red escuchan acá.
	DefaultPort = 9100
	// DefaultPaperWidthMm: 80mm es el rollo estándar de comanda.
	DefaultPaperWidthMm = 80
	// DefaultServerURL: producción. Se puede cambiar desde la página.
	DefaultServerURL = "https://mesapay.co"
)

// Estaciones válidas. Es el enum PrepStation del servidor
// (prisma/schema.prisma): si acá aceptáramos cualquier cosa, el POST de
// impresoras se rechazaría del otro lado con un error críptico.
var validStations = map[string]bool{"kitchen": true, "bar": true, "counter": true}

// Printer es una impresora térmica en la red del local.
//
// LocalKey es la identidad estable del lado del agente: el servidor
// devuelve su propio id (cuid) al sincronizar, pero si alguien borra y
// recrea la impresora del lado servidor, el agente tiene que poder
// reconocer que es "la de la cocina" y no duplicarla.
type Printer struct {
	LocalKey      string `json:"localKey"`
	Label         string `json:"label"`
	Host          string `json:"host"`
	Port          int    `json:"port"`
	Station       string `json:"station"`
	BarSubStation string `json:"barSubStation,omitempty"`
	PaperWidthMm  int    `json:"paperWidthMm,omitempty"`
	Active        bool   `json:"active"`

	// ServerID es el cuid que devolvió el último POST /printers. No lo
	// escribe el humano; se cachea para que la página de estado pueda
	// mostrar a qué impresora del servidor corresponde cada una.
	ServerID string `json:"serverId,omitempty"`
}

// Addr es lo que se le pasa a net.Dial.
func (p Printer) Addr() string {
	return net.JoinHostPort(p.Host, strconv.Itoa(p.Port))
}

// Config es el archivo completo.
type Config struct {
	ServerURL        string    `json:"serverUrl"`
	Token            string    `json:"token"`
	UIPort           int       `json:"uiPort"`
	PollSeconds      int       `json:"pollSeconds"`
	HeartbeatSeconds int       `json:"heartbeatSeconds"`
	Printers         []Printer `json:"printers"`
}

// Default devuelve una configuración recién instalada: sin token y sin
// impresoras, lista para que alguien abra la página y la complete.
func Default() Config {
	return Config{
		ServerURL:        DefaultServerURL,
		UIPort:           DefaultUIPort,
		PollSeconds:      DefaultPollSeconds,
		HeartbeatSeconds: DefaultHeartbeatSeconds,
		Printers:         []Printer{},
	}
}

// Linked dice si el agente ya tiene con qué autenticar. Sin token no
// tiene sentido ni intentar hablar con el servidor: sólo generaría 401
// en bucle.
func (c Config) Linked() bool {
	return strings.TrimSpace(c.Token) != ""
}

// ActivePrinters son las que hay que sincronizar y usar.
func (c Config) ActivePrinters() []Printer {
	out := make([]Printer, 0, len(c.Printers))
	for _, p := range c.Printers {
		if p.Active {
			out = append(out, p)
		}
	}
	return out
}

// PrinterByServerID busca la impresora local que corresponde al id que
// vino en un trabajo. Se usa sólo para loguear con el rótulo local; el
// host/puerto a usar es SIEMPRE el que manda el servidor en el trabajo,
// porque es el que el servidor cree correcto.
func (c Config) PrinterByServerID(id string) (Printer, bool) {
	for _, p := range c.Printers {
		if p.ServerID != "" && p.ServerID == id {
			return p, true
		}
	}
	return Printer{}, false
}

// DefaultPath es dónde vive el archivo si nadie dice lo contrario.
//
// En Windows: %ProgramData%\MESAPAY\agent\config.json — legible por el
// servicio (LocalSystem) y por el administrador que instala, sin
// depender de ningún perfil de usuario.
func DefaultPath() string {
	if p := strings.TrimSpace(os.Getenv(EnvConfigPath)); p != "" {
		return p
	}
	return filepath.Join(DefaultDir(), "config.json")
}

// DefaultDir es el directorio de datos del agente: config, estado y logs.
func DefaultDir() string {
	if p := strings.TrimSpace(os.Getenv(EnvConfigPath)); p != "" {
		return filepath.Dir(p)
	}
	switch runtime.GOOS {
	case "windows":
		base := os.Getenv("ProgramData")
		if base == "" {
			base = `C:\ProgramData`
		}
		return filepath.Join(base, "MESAPAY", "agent")
	case "darwin":
		home, err := os.UserHomeDir()
		if err != nil {
			return filepath.Join(os.TempDir(), "mesapay-agent")
		}
		return filepath.Join(home, "Library", "Application Support", "MESAPAY", "agent")
	default:
		if os.Geteuid() == 0 {
			return "/var/lib/mesapay-agent"
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return filepath.Join(os.TempDir(), "mesapay-agent")
		}
		return filepath.Join(home, ".local", "share", "mesapay-agent")
	}
}

// Load lee el archivo. Si no existe todavía devuelve la configuración
// por defecto SIN error: un agente recién instalado no es un error, es
// un agente esperando que alguien abra la página de configuración.
func Load(path string) (Config, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Default(), nil
	}
	if err != nil {
		return Default(), fmt.Errorf("no se pudo leer %s: %w", path, err)
	}
	cfg := Default()
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return Default(), fmt.Errorf("%s no es JSON válido: %w", path, err)
	}
	cfg.Normalize()
	return cfg, nil
}

// Normalize rellena huecos y corrige valores imposibles. Se aplica al
// leer Y al guardar, así un archivo editado a mano con el Bloc de notas
// (que va a pasar) no deja al agente en un estado raro.
func (c *Config) Normalize() {
	c.ServerURL = strings.TrimRight(strings.TrimSpace(c.ServerURL), "/")
	if c.ServerURL == "" {
		c.ServerURL = DefaultServerURL
	}
	c.Token = strings.TrimSpace(c.Token)
	if c.UIPort <= 0 || c.UIPort > 65535 {
		c.UIPort = DefaultUIPort
	}
	// El piso de 1s no es capricho: por debajo, un servidor caído
	// convierte al agente en un martillo contra el VPS.
	if c.PollSeconds < 1 {
		c.PollSeconds = DefaultPollSeconds
	}
	if c.PollSeconds > 60 {
		c.PollSeconds = 60
	}
	if c.HeartbeatSeconds < 10 {
		c.HeartbeatSeconds = DefaultHeartbeatSeconds
	}
	if c.Printers == nil {
		c.Printers = []Printer{}
	}
	for i := range c.Printers {
		p := &c.Printers[i]
		p.LocalKey = strings.TrimSpace(p.LocalKey)
		p.Label = strings.TrimSpace(p.Label)
		p.Host = strings.TrimSpace(p.Host)
		p.Station = strings.TrimSpace(strings.ToLower(p.Station))
		p.BarSubStation = strings.TrimSpace(p.BarSubStation)
		if p.Port <= 0 || p.Port > 65535 {
			p.Port = DefaultPort
		}
		if !validStations[p.Station] {
			p.Station = "kitchen"
		}
		// La sub-estación sólo tiene sentido en la barra; en cocina el
		// servidor la ignoraría y sólo generaría confusión al diagnosticar.
		if p.Station != "bar" {
			p.BarSubStation = ""
		}
		if p.PaperWidthMm != 0 && p.PaperWidthMm != 58 && p.PaperWidthMm != 80 {
			p.PaperWidthMm = DefaultPaperWidthMm
		}
		if p.LocalKey == "" {
			p.LocalKey = slug(p.Label)
		}
		if p.LocalKey == "" {
			p.LocalKey = fmt.Sprintf("impresora-%d", i+1)
		}
		if p.Label == "" {
			p.Label = p.LocalKey
		}
	}
}

// Validate son los errores que hay que MOSTRARLE a quien está parado
// frente al PC, en su idioma, no un stack trace.
func (c Config) Validate() []string {
	var errs []string
	if !strings.HasPrefix(c.ServerURL, "http://") && !strings.HasPrefix(c.ServerURL, "https://") {
		errs = append(errs, "La dirección del servidor debe empezar con https://")
	}
	if c.Token != "" && !strings.HasPrefix(c.Token, TokenPrefix) {
		errs = append(errs, "El token de vinculación debe empezar con "+TokenPrefix)
	}
	seen := map[string]bool{}
	for _, p := range c.Printers {
		if p.Host == "" {
			errs = append(errs, fmt.Sprintf("La impresora %q no tiene IP", p.Label))
		}
		if seen[p.LocalKey] {
			errs = append(errs, fmt.Sprintf("Hay dos impresoras con la misma clave %q", p.LocalKey))
		}
		seen[p.LocalKey] = true
	}
	return errs
}

// Save escribe el archivo de forma atómica: primero a un temporal en el
// MISMO directorio, luego rename. Si se corta la luz a mitad de guardar
// —que en un local pasa— el archivo viejo queda intacto en vez de quedar
// truncado y dejar al agente sin token.
func Save(path string, cfg Config) error {
	cfg.Normalize()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("no se pudo crear %s: %w", filepath.Dir(path), err)
	}
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')

	tmp, err := os.CreateTemp(filepath.Dir(path), ".config-*.tmp")
	if err != nil {
		return fmt.Errorf("no se pudo crear el archivo temporal: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op si el rename salió bien

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
	// El token es un secreto: 0600 para que no lo lea cualquier usuario
	// del PC de la caja.
	if err := os.Chmod(tmpName, 0o600); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

// slug convierte "Barra de cócteles" en "barra-de-cocteles" para usarlo
// como localKey cuando quien configura no puso una.
func slug(s string) string {
	var b strings.Builder
	prevDash := true // evita empezar con guion
	for _, r := range strings.ToLower(strings.TrimSpace(s)) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			prevDash = false
		case strings.ContainsRune("áàä", r):
			b.WriteRune('a')
			prevDash = false
		case strings.ContainsRune("éèë", r):
			b.WriteRune('e')
			prevDash = false
		case strings.ContainsRune("íìï", r):
			b.WriteRune('i')
			prevDash = false
		case strings.ContainsRune("óòö", r):
			b.WriteRune('o')
			prevDash = false
		case strings.ContainsRune("úùü", r):
			b.WriteRune('u')
			prevDash = false
		case r == 'ñ':
			b.WriteRune('n')
			prevDash = false
		default:
			if !prevDash {
				b.WriteRune('-')
				prevDash = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}
