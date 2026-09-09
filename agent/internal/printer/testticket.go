package printer

import (
	"bytes"
	"fmt"
	"strings"
	"time"
)

// ── La única excepción a "puente tonto" ──────────────────────────────
//
// El agente NO arma comandas: eso lo hace el servidor y por eso los
// bytes llegan renderizados. Pero el ticket de PRUEBA sí se genera acá,
// y a propósito: quien está instalando necesita saber si la IP que
// acaba de escribir corresponde a la impresora que tiene enfrente, y eso
// tiene que funcionar aunque MESAPAY no responda, aunque el token esté
// mal, o aunque el local no tenga internet ese día.
//
// Es un puñado de bytes que no cambia nunca. No es "el diseño del
// ticket" viviendo en el cliente.

// Comandos ESC/POS. Es el mismo subconjunto de src/lib/escpos/commands.ts:
// si el servidor imprime bien con estos, la prueba también.
const (
	esc = 0x1b
	gs  = 0x1d
	lf  = 0x0a
)

// codePageCP850 es `ESC t 2` — Multilingual Latin-1. Cubre español y
// portugués, que es lo que MESAPAY imprime.
const codePageCP850 = 2

// cp850High es el tramo 0x80–0xFF de CP850, copiado de
// src/lib/escpos/codepage.ts. Sólo se usa para el ticket de prueba.
const cp850High = "ÇüéâäàåçêëèïîìÄÅ" +
	"ÉæÆôöòûùÿÖÜø£Ø×ƒ" +
	"áíóúñÑªº¿®¬½¼¡«»" +
	"░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐" +
	"└┴┬├─┼ãÃ╚╔╩╦╠═╬¤" +
	"ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀" +
	"ÓßÔÒõÕµþÞÚÛÙýÝ¯´" +
	"­±‗¾¶§÷¸°¨·¹³²■ "

var cp850ByRune = func() map[rune]byte {
	m := make(map[rune]byte, 128)
	for i, r := range []rune(cp850High) {
		m[r] = byte(0x80 + i)
	}
	return m
}()

// encodeCP850 codifica texto para la térmica. Lo que no entra en la
// tabla se descarta en silencio: en un ticket de prueba, un carácter
// perdido es infinitamente mejor que una fila de "?".
func encodeCP850(s string) []byte {
	out := make([]byte, 0, len(s))
	for _, r := range s {
		switch {
		case r < 0x80:
			out = append(out, byte(r))
		default:
			if b, ok := cp850ByRune[r]; ok {
				out = append(out, b)
			}
		}
	}
	return out
}

func line(buf *bytes.Buffer, text string) {
	buf.Write(encodeCP850(text))
	buf.WriteByte(lf)
}

// TestTicket arma la tirilla de prueba de UNA impresora.
//
// Lo que imprime está elegido para que sirva de diagnóstico en papel:
// el rótulo y la IP (para confirmar que salió por la impresora que uno
// cree), la fecha y hora (para distinguir esta prueba de una de ayer que
// quedó colgando del rollo) y una línea con acentos y eñe (porque si la
// code page está mal, se ve acá y no cuando salga la primera comanda con
// "Ñoquis").
func TestTicket(label, addr string, paperWidthMm int) []byte {
	columns := 48
	if paperWidthMm == 58 {
		columns = 32
	}

	var b bytes.Buffer
	b.Write([]byte{esc, 0x40})                // ESC @  — reset
	b.Write([]byte{esc, 0x74, codePageCP850}) // ESC t 2

	b.Write([]byte{esc, 0x61, 1})   // centrado
	b.Write([]byte{gs, 0x21, 0x11}) // doble alto y ancho
	b.Write([]byte{esc, 0x45, 1})   // negrita
	line(&b, "MESAPAY")             //
	b.Write([]byte{gs, 0x21, 0x00}) // tamaño normal
	line(&b, "PRUEBA DE IMPRESION") //
	b.Write([]byte{esc, 0x45, 0})   // sin negrita
	b.Write([]byte{esc, 0x61, 0})   // a la izquierda
	line(&b, strings.Repeat("=", columns))

	line(&b, "Impresora: "+truncate(label, columns-11))
	line(&b, "Direccion: "+addr)
	line(&b, "Papel:     "+fmt.Sprintf("%d mm (%d columnas)", widthOrDefault(paperWidthMm), columns))
	line(&b, "Fecha:     "+time.Now().Format("02/01/2006 15:04:05"))
	line(&b, strings.Repeat("-", columns))
	// Si esta línea sale con símbolos raros, la code page de la
	// impresora no es CP850 y las comandas van a salir igual de rotas.
	line(&b, "Acentos: aeiou ÁÉÍÓÚ ñÑ ção ¿? ¡!")
	line(&b, strings.Repeat("=", columns))
	b.Write([]byte{esc, 0x61, 1}) // centrado
	line(&b, "Si lee esto, la impresora")
	line(&b, "esta bien configurada.")

	b.Write([]byte{esc, 0x64, 3})      // ESC d 3 — avanza 3 líneas
	b.Write([]byte{gs, 0x56, 0x42, 4}) // GS V 66 4 — corte parcial
	return b.Bytes()
}

func widthOrDefault(mm int) int {
	if mm == 58 || mm == 80 {
		return mm
	}
	return 80
}

func truncate(s string, max int) string {
	r := []rune(s)
	if max <= 0 || len(r) <= max {
		return s
	}
	return string(r[:max])
}
