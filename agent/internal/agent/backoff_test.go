package agent

import (
	"testing"
	"time"
)

func TestIdleBackoffCreceYSeDetieneEnElTecho(t *testing.T) {
	base := 3 * time.Second
	max := time.Duration(idleMaxFactor) * base

	if got := idleBackoff(base, 0); got != base {
		t.Errorf("sin respuestas vacías la espera debería ser el intervalo (%v), fue %v", base, got)
	}
	prev := base
	for i := 1; i <= 10; i++ {
		got := idleBackoff(base, i)
		if got < prev {
			t.Errorf("la espera bajó entre %d y %d vacíos: %v → %v", i-1, i, prev, got)
		}
		if got > max {
			t.Fatalf("con %d vacíos la espera fue %v: el techo es %v y una comanda no puede esperar más",
				i, got, max)
		}
		prev = got
	}
	if idleBackoff(base, 50) != max {
		t.Errorf("tras muchos vacíos debería quedarse en el techo %v", max)
	}
}

func TestIdleBackoffNoDejaAUnaComandaEsperandoDemasiado(t *testing.T) {
	// El número que importa en la práctica: con los 3s por defecto, la
	// primera comanda tras un rato tranquilo no puede tardar más de 6s.
	if got := idleBackoff(3*time.Second, 999); got > 6*time.Second {
		t.Errorf("espera máxima = %v: demasiado para una cocina", got)
	}
}

func TestErrorBackoffEscalaHastaElMinuto(t *testing.T) {
	prev := time.Duration(0)
	for i := 1; i <= 12; i++ {
		got := errorBackoff(i)
		if got > errorMax {
			t.Fatalf("con %d errores la espera fue %v, el techo es %v", i, got, errorMax)
		}
		// El jitter puede bajarlo hasta un 20%, así que se compara
		// contra el piso de lo posible, no contra el valor exacto.
		if got <= 0 {
			t.Fatalf("espera no positiva: %v", got)
		}
		if i > 1 && got < prev*4/10 {
			t.Errorf("la espera cayó demasiado entre %d y %d errores: %v → %v", i-1, i, prev, got)
		}
		prev = got
	}
	// Ya en el techo, se queda ahí.
	if got := errorBackoff(50); got > errorMax {
		t.Errorf("errorBackoff(50) = %v", got)
	}
}

func TestErrorBackoffTieneJitter(t *testing.T) {
	// Sin jitter, 40 locales que perdieron la conexión al mismo tiempo
	// vuelven todos juntos y tumban el VPS otra vez.
	seen := map[time.Duration]bool{}
	for i := 0; i < 40; i++ {
		seen[errorBackoff(6)] = true
	}
	if len(seen) < 5 {
		t.Errorf("sólo %d valores distintos en 40 llamadas: falta jitter", len(seen))
	}
}

func TestErrorBackoffNuncaSuperaElTecho(t *testing.T) {
	// El jitter va sólo hacia abajo: nadie debería esperar más de lo que
	// dice el techo cuando pregunte "¿cuánto tarda en reconectar?".
	for i := 1; i <= 20; i++ {
		for n := 0; n < 30; n++ {
			if got := errorBackoff(i); got > errorMax {
				t.Fatalf("errorBackoff(%d) = %v > %v", i, got, errorMax)
			}
		}
	}
}
