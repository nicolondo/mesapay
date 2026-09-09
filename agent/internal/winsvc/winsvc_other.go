//go:build !windows

// En macOS y Linux no hay SCM. Este archivo existe para que el resto del
// programa no tenga que llenarse de `if runtime.GOOS == "windows"`: en
// cualquier otro sistema el agente corre en primer plano y listo.
//
// Correrlo fuera de Windows no es un caso hipotético: es como se
// desarrolla y como se prueba contra un servidor de MESAPAY real desde
// un Mac, sin tener que compilar y copiar el .exe cada vez.
package winsvc

import (
	"context"
	"errors"
)

const (
	ServiceName = "MesapayPrintAgent"
	DisplayName = "MESAPAY - Agente de impresión"
	Description = "Recibe las comandas de MESAPAY y las envía a las impresoras térmicas del local."
)

// ErrNotWindows explica por qué no se puede instalar un servicio acá.
var ErrNotWindows = errors.New("el servicio de Windows sólo se puede instalar en Windows; en este sistema el agente corre en primer plano")

// IsWindowsService siempre es false fuera de Windows.
func IsWindowsService() bool { return false }

// Run no aplica: el llamador corre el agente directamente.
func Run(func(ctx context.Context)) error { return ErrNotWindows }

func Install(string) error { return ErrNotWindows }
func Uninstall() error     { return ErrNotWindows }
func Start() error         { return ErrNotWindows }
func Stop() error          { return ErrNotWindows }
