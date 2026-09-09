package agent

import (
	"math/rand"
	"time"
)

// ── Dos esperas distintas, porque son dos problemas distintos ────────
//
// "No hay nada que imprimir" es lo normal en un local: el 95% de los
// GET van a volver vacíos. Ahí se puede aflojar un poco el ritmo, pero
// POCO — cada segundo de espera es un segundo que el plato tarda en
// empezar a cocinarse.
//
// "El servidor no contesta" es otra cosa: puede ser el VPS reiniciando,
// o los 40 locales del país reconectando a la vez después de un corte.
// Ahí sí hay que apartarse rápido y con jitter, para no volver todos
// juntos y tirarlo de nuevo.

const (
	// idleFactor: cuánto se estira la espera por cada GET vacío seguido.
	idleFactor = 1.5
	// idleMaxFactor: techo de la espera ociosa, en múltiplos del
	// intervalo configurado. Con los 3s por defecto son 6s de demora
	// máxima para la primera comanda tras un rato tranquilo — el
	// precio que estamos dispuestos a pagar por no martillar el VPS.
	idleMaxFactor = 2
	// errorMin / errorMax: la escalada cuando el servidor falla.
	errorMin = 5 * time.Second
	errorMax = 60 * time.Second
)

// idleBackoff calcula la espera tras `consecutiveEmpty` respuestas
// vacías seguidas, partiendo del intervalo configurado.
func idleBackoff(base time.Duration, consecutiveEmpty int) time.Duration {
	if consecutiveEmpty <= 0 {
		return base
	}
	max := time.Duration(idleMaxFactor) * base
	d := base
	for i := 0; i < consecutiveEmpty; i++ {
		d = time.Duration(float64(d) * idleFactor)
		if d >= max {
			return max
		}
	}
	return d
}

// errorBackoff duplica desde errorMin hasta errorMax, con hasta 20% de
// jitter hacia abajo. El jitter es lo que evita el rebaño: sin él, 40
// agentes que perdieron la conexión al mismo tiempo vuelven al mismo
// tiempo.
func errorBackoff(consecutiveErrors int) time.Duration {
	if consecutiveErrors <= 1 {
		return withJitter(errorMin)
	}
	d := errorMin
	for i := 1; i < consecutiveErrors; i++ {
		d *= 2
		if d >= errorMax {
			return withJitter(errorMax)
		}
	}
	return withJitter(d)
}

func withJitter(d time.Duration) time.Duration {
	// Sólo hacia abajo: nunca esperamos MÁS del techo, que es lo que
	// alguien va a mirar cuando pregunte "¿cuánto tarda en reconectar?".
	jitter := time.Duration(rand.Int63n(int64(d) / 5))
	return d - jitter
}
