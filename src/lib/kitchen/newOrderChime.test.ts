import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHIME_ATTACK_SECONDS,
  CHIME_BEEP_SECONDS,
  CHIME_FREQUENCIES_HZ,
  CHIME_GAP_SECONDS,
  CHIME_PEAK_GAIN,
  CHIME_UNLOCK_GRACE_MS,
  NewOrderChimeController,
  chimeDefaultEnabled,
  chimeStorageKey,
  detectNewRounds,
  observeRounds,
  playNewOrderChime,
  readChimePref,
  writeChimePref,
  type ChimeAudioNode,
  type ChimeContext,
  type SeenRounds,
} from "./newOrderChime";

/*
 * El entorno de vitest de este repo es `node` (sin DOM ni Web Audio): se
 * testea la lógica pura con un AudioContext falso que registra qué se
 * programa. El hook de React (`useNewOrderChime`) sólo cablea estas piezas
 * a la página y se verifica a mano en el navegador.
 */

// ── AudioContext falso ───────────────────────────────────────────────────

type ParamEvent = { kind: "set" | "ramp"; value: number; time: number };

class FakeParam {
  events: ParamEvent[] = [];
  setValueAtTime(value: number, time: number) {
    this.events.push({ kind: "set", value, time });
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.events.push({ kind: "ramp", value, time });
  }
}

class FakeNode implements ChimeAudioNode {
  connectedTo: ChimeAudioNode[] = [];
  disconnected = false;
  connect(destination: ChimeAudioNode) {
    this.connectedTo.push(destination);
    return destination;
  }
  disconnect() {
    this.disconnected = true;
  }
}

class FakeOscillator extends FakeNode {
  type: OscillatorType = "sine";
  frequency = new FakeParam();
  startAt: number | null = null;
  stopAt: number | null = null;
  onended: unknown = null;
  start(when: number) {
    this.startAt = when;
  }
  stop(when: number) {
    this.stopAt = when;
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeAudioContext implements ChimeContext {
  currentTime = 10;
  state: string = "running";
  destination = new FakeNode();
  oscillators: FakeOscillator[] = [];
  gains: FakeGain[] = [];
  resumeCalls = 0;
  closed = false;
  /** Qué hace resume(): "run" lo arranca, "hang" lo deja pendiente (sin gesto). */
  resumeBehavior: "run" | "hang" = "run";
  private stateListeners: (() => void)[] = [];

  createOscillator() {
    const o = new FakeOscillator();
    this.oscillators.push(o);
    return o;
  }
  createGain() {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  resume() {
    this.resumeCalls++;
    if (this.resumeBehavior === "hang") return new Promise<void>(() => {});
    this.setState("running");
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    this.setState("closed");
    return Promise.resolve();
  }
  addEventListener(_type: "statechange", listener: () => void) {
    this.stateListeners.push(listener);
  }
  setState(state: string) {
    this.state = state;
    for (const l of this.stateListeners) l();
  }
}

// ── Detección ────────────────────────────────────────────────────────────

describe("detectNewRounds", () => {
  it("devuelve sólo los ids nunca vistos, sin repetidos", () => {
    expect(detectNewRounds(new Set(["a", "b"]), ["a", "b", "c", "c", "d"])).toEqual([
      "c",
      "d",
    ]);
  });

  it("sin ids nuevos devuelve vacío (cambios de estado o salidas)", () => {
    const seen = new Set(["a", "b", "c"]);
    expect(detectNewRounds(seen, ["a", "b", "c"])).toEqual([]);
    expect(detectNewRounds(seen, ["b"])).toEqual([]);
    expect(detectNewRounds(seen, [])).toEqual([]);
  });
});

describe("observeRounds", () => {
  it("primer render: lo que ya estaba NO suena", () => {
    const r = observeRounds(null, "", ["a", "b", "c"]);
    expect(r.chime).toBe(false);
    expect(r.newIds).toEqual([]);
    expect([...r.seen.ids].sort()).toEqual(["a", "b", "c"]);
  });

  it("primer render con el tablero vacío tampoco suena", () => {
    expect(observeRounds(null, "", []).chime).toBe(false);
  });

  it("un id nuevo suena", () => {
    const first = observeRounds(null, "", ["a", "b"]).seen;
    const r = observeRounds(first, "", ["a", "b", "c"]);
    expect(r.chime).toBe(true);
    expect(r.newIds).toEqual(["c"]);
    expect(r.seen.ids.has("c")).toBe(true);
  });

  it("varios nuevos juntos = UNA sola señal", () => {
    const first = observeRounds(null, "", ["a"]).seen;
    const r = observeRounds(first, "", ["a", "b", "c", "d"]);
    expect(r.chime).toBe(true);
    expect(r.newIds).toEqual(["b", "c", "d"]);
  });

  it("después de sonar, el mismo conjunto ya no vuelve a sonar", () => {
    let seen: SeenRounds = observeRounds(null, "", ["a"]).seen;
    seen = observeRounds(seen, "", ["a", "b"]).seen;
    expect(observeRounds(seen, "", ["a", "b"]).chime).toBe(false);
  });

  it("cambios de estado de un pedido existente no suenan (mismos ids, otro orden)", () => {
    // El tablero pasa un pedido de "Por preparar" a "En cocina": las props
    // traen las mismas rondas (quizá en otro orden). La actualización
    // optimista de los botones ni siquiera cambia las props.
    const first = observeRounds(null, "", ["a", "b", "c"]).seen;
    const r = observeRounds(first, "", ["c", "a", "b"]);
    expect(r.chime).toBe(false);
    expect(r.seen).toBe(first);
  });

  it("un pedido que sale del tablero no suena, y si reaparece tampoco", () => {
    let seen: SeenRounds = observeRounds(null, "", ["a", "b"]).seen;
    const out = observeRounds(seen, "", ["a"]);
    expect(out.chime).toBe(false);
    seen = out.seen;
    // "b" vuelve (p. ej. le agregaron un plato): ya se vio en esta página.
    const back = observeRounds(seen, "", ["a", "b"]);
    expect(back.chime).toBe(false);
  });

  it("cambiar de vista (sub-estación del bar) no suena por lo que ya existía", () => {
    const cocteles = observeRounds(null, "Cocteles", ["a"]).seen;
    const todo = observeRounds(cocteles, "", ["a", "b", "c"]);
    expect(todo.chime).toBe(false);
    // Y en la vista nueva, un pedido realmente nuevo sí suena.
    expect(observeRounds(todo.seen, "", ["a", "b", "c", "d"]).chime).toBe(true);
  });
});

// ── Síntesis ─────────────────────────────────────────────────────────────

describe("playNewOrderChime", () => {
  it("programa 2-3 pitidos agudos (2-3 kHz), cortos y separados", () => {
    const ctx = new FakeAudioContext();
    const { startAt, endAt } = playNewOrderChime(ctx);

    expect(ctx.oscillators.length).toBeGreaterThanOrEqual(2);
    expect(ctx.oscillators.length).toBeLessThanOrEqual(3);
    expect(ctx.oscillators.length).toBe(CHIME_FREQUENCIES_HZ.length);
    expect(startAt).toBeGreaterThanOrEqual(ctx.currentTime);

    let prevStop = -Infinity;
    ctx.oscillators.forEach((osc, i) => {
      expect(["square", "sine"]).toContain(osc.type);
      const freq = osc.frequency.events[0];
      expect(freq.value).toBeGreaterThanOrEqual(2000);
      expect(freq.value).toBeLessThanOrEqual(3000);
      expect(freq.value).toBe(CHIME_FREQUENCIES_HZ[i]);

      const start = osc.startAt!;
      const stop = osc.stopAt!;
      const dur = stop - start;
      expect(dur).toBeGreaterThanOrEqual(0.12 - 1e-9);
      expect(dur).toBeLessThanOrEqual(0.15 + 1e-9);
      if (i > 0) {
        // Pausa entre pitidos de ~80 ms.
        expect(start - prevStop).toBeCloseTo(CHIME_GAP_SECONDS, 6);
      }
      prevStop = stop;
    });
    expect(endAt).toBeCloseTo(prevStop, 9);
    expect(CHIME_BEEP_SECONDS).toBeGreaterThanOrEqual(0.12);
  });

  it("cada pitido pasa por su ganancia y llega al destino", () => {
    const ctx = new FakeAudioContext();
    playNewOrderChime(ctx);
    ctx.oscillators.forEach((osc, i) => {
      expect(osc.connectedTo).toEqual([ctx.gains[i]]);
      expect(ctx.gains[i].connectedTo).toEqual([ctx.destination]);
    });
  });

  it("envolvente sin saltos: arranca en 0, sube en pocos ms y vuelve a 0", () => {
    const ctx = new FakeAudioContext();
    playNewOrderChime(ctx);
    ctx.gains.forEach((g, i) => {
      const osc = ctx.oscillators[i];
      const ev = g.gain.events;
      // Primer evento: ganancia 0 en el instante en que arranca el oscilador
      // (nunca volumen pleno en t=0 → sin "clic").
      expect(ev[0]).toEqual({ kind: "set", value: 0, time: osc.startAt });
      // Ataque: rampa lineal (no escalón) hasta el pico en ≤ 10 ms.
      expect(ev[1].kind).toBe("ramp");
      expect(ev[1].value).toBe(CHIME_PEAK_GAIN);
      const attack = ev[1].time - osc.startAt!;
      expect(attack).toBeGreaterThan(0);
      expect(attack).toBeLessThanOrEqual(0.01);
      expect(attack).toBeCloseTo(CHIME_ATTACK_SECONDS, 9);
      // Caída: la última automatización es una rampa a 0 que termina justo
      // cuando se detiene el oscilador.
      const last = ev[ev.length - 1];
      expect(last.kind).toBe("ramp");
      expect(last.value).toBe(0);
      expect(last.time).toBeCloseTo(osc.stopAt!, 9);
      // Ningún "set" distinto de 0 ocurre antes del final del ataque.
      for (const e of ev) {
        if (e.kind === "set" && e.value > 0) {
          expect(e.time).toBeGreaterThanOrEqual(ev[1].time);
        }
      }
    });
  });

  it("volumen alto pero sin saturar", () => {
    expect(CHIME_PEAK_GAIN).toBeGreaterThanOrEqual(0.2);
    // Margen para el sobrepico de la onda cuadrada limitada en banda.
    expect(CHIME_PEAK_GAIN * 1.2).toBeLessThan(1);
  });

  it("los nodos se desconectan al terminar", () => {
    const ctx = new FakeAudioContext();
    playNewOrderChime(ctx);
    for (const osc of ctx.oscillators) {
      expect(typeof osc.onended).toBe("function");
      (osc.onended as () => void)();
      expect(osc.disconnected).toBe(true);
    }
    expect(ctx.gains.every((g) => g.disconnected)).toBe(true);
  });
});

// ── Preferencia ──────────────────────────────────────────────────────────

class MemoryStorage {
  data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

describe("preferencia de sonido por dispositivo", () => {
  it("por defecto: activado en cocina, silenciado en bar", () => {
    expect(chimeDefaultEnabled("kitchen")).toBe(true);
    expect(chimeDefaultEnabled("bar")).toBe(false);
    expect(readChimePref(new MemoryStorage(), "kitchen")).toBe(true);
    expect(readChimePref(new MemoryStorage(), "bar")).toBe(false);
  });

  it("clave distinta por tablero", () => {
    expect(chimeStorageKey("kitchen")).not.toBe(chimeStorageKey("bar"));
  });

  it("guarda y lee cada tablero por separado", () => {
    const s = new MemoryStorage();
    expect(writeChimePref(s, "kitchen", false)).toBe(true);
    expect(writeChimePref(s, "bar", true)).toBe(true);
    expect(readChimePref(s, "kitchen")).toBe(false);
    expect(readChimePref(s, "bar")).toBe(true);
  });

  it("storage roto, ausente o con basura → default, sin lanzar", () => {
    const broken = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(readChimePref(broken, "kitchen")).toBe(true);
    expect(readChimePref(broken, "bar")).toBe(false);
    expect(writeChimePref(broken, "kitchen", false)).toBe(false);
    expect(readChimePref(null, "kitchen")).toBe(true);
    expect(writeChimePref(undefined, "bar", true)).toBe(false);
    const junk = new MemoryStorage();
    junk.setItem(chimeStorageKey("kitchen"), "quizás");
    expect(readChimePref(junk, "kitchen")).toBe(true);
  });
});

// ── Controlador (autoplay) ───────────────────────────────────────────────

describe("NewOrderChimeController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("no crea el AudioContext hasta que hace falta y reutiliza uno solo", () => {
    const created: FakeAudioContext[] = [];
    const c = new NewOrderChimeController(() => {
      const ctx = new FakeAudioContext();
      created.push(ctx);
      return ctx;
    });
    expect(created).toHaveLength(0);
    c.announce();
    c.unlock();
    c.announce();
    expect(created).toHaveLength(1);
  });

  it("con el audio desbloqueado suena al entrar un pedido", () => {
    const ctx = new FakeAudioContext();
    const c = new NewOrderChimeController(() => ctx);
    c.announce();
    expect(ctx.oscillators).toHaveLength(CHIME_FREQUENCIES_HZ.length);
    expect(c.getNeedsUnlock()).toBe(false);
  });

  it("no encima pitidos mientras todavía suena el anterior", () => {
    const ctx = new FakeAudioContext();
    const c = new NewOrderChimeController(() => ctx);
    c.announce();
    c.announce();
    expect(ctx.oscillators).toHaveLength(CHIME_FREQUENCIES_HZ.length);
    ctx.currentTime += 5;
    c.announce();
    expect(ctx.oscillators).toHaveLength(2 * CHIME_FREQUENCIES_HZ.length);
  });

  it("contexto recién creado que arranca solo (hubo activación previa): suena", async () => {
    const ctx = new FakeAudioContext();
    ctx.state = "suspended";
    const c = new NewOrderChimeController(() => ctx);
    c.announce();
    await vi.runAllTimersAsync();
    expect(ctx.oscillators).toHaveLength(CHIME_FREQUENCIES_HZ.length);
    expect(c.getNeedsUnlock()).toBe(false);
  });

  it("sin gesto del usuario: no suena, pide tocar la pantalla y se limpia al tocar", async () => {
    const ctx = new FakeAudioContext();
    ctx.state = "suspended";
    ctx.resumeBehavior = "hang";
    const c = new NewOrderChimeController(() => ctx);
    const notified = vi.fn();
    c.subscribe(notified);

    c.announce();
    await vi.advanceTimersByTimeAsync(CHIME_UNLOCK_GRACE_MS + 10);
    expect(ctx.oscillators).toHaveLength(0);
    expect(c.getNeedsUnlock()).toBe(true);
    expect(notified).toHaveBeenCalled();

    // El usuario toca la pantalla: el navegador ahora sí deja reanudar.
    ctx.resumeBehavior = "run";
    c.unlock();
    await vi.runAllTimersAsync();
    expect(ctx.state).toBe("running");
    expect(c.getNeedsUnlock()).toBe(false);
    // Desbloquear no dispara un pitido tardío.
    expect(ctx.oscillators).toHaveLength(0);
  });

  it("varias tandas mientras espera el desbloqueo no apilan esperas", async () => {
    const ctx = new FakeAudioContext();
    ctx.state = "suspended";
    ctx.resumeBehavior = "hang";
    const c = new NewOrderChimeController(() => ctx);
    c.announce();
    c.announce();
    c.announce();
    expect(ctx.resumeCalls).toBe(1);
    await vi.runAllTimersAsync();
    expect(c.getNeedsUnlock()).toBe(true);
  });

  it("'Probar sonido' desbloquea y suena", async () => {
    const ctx = new FakeAudioContext();
    ctx.state = "suspended";
    const c = new NewOrderChimeController(() => ctx);
    await c.test();
    expect(ctx.state).toBe("running");
    expect(ctx.oscillators).toHaveLength(CHIME_FREQUENCIES_HZ.length);
  });

  it("sin Web Audio (navegador viejo o SSR) no rompe nada", async () => {
    const none = new NewOrderChimeController(() => null);
    expect(() => none.announce()).not.toThrow();
    expect(() => none.unlock()).not.toThrow();
    await expect(none.test()).resolves.toBeUndefined();
    expect(none.getNeedsUnlock()).toBe(false);

    const throwing = new NewOrderChimeController(() => {
      throw new Error("NotSupportedError");
    });
    expect(() => throwing.announce()).not.toThrow();
    expect(() => throwing.dispose()).not.toThrow();
  });

  it("dispose cierra el contexto y el siguiente uso crea otro", () => {
    const created: FakeAudioContext[] = [];
    const c = new NewOrderChimeController(() => {
      const ctx = new FakeAudioContext();
      created.push(ctx);
      return ctx;
    });
    c.announce();
    c.dispose();
    expect(created[0].closed).toBe(true);
    c.announce();
    expect(created).toHaveLength(2);
    expect(created[1].oscillators).toHaveLength(CHIME_FREQUENCIES_HZ.length);
  });
});
