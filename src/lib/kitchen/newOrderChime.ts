/**
 * Pitido de "entró un pedido" del tablero de cocina/bar.
 *
 * Todo lo de este módulo es independiente del DOM para poder testearlo en
 * el entorno `node` de vitest:
 *   - detección de rondas nuevas (qué ids nunca se vieron en esta página);
 *   - síntesis del pitido sobre un AudioContext (real o falso);
 *   - preferencia por dispositivo (activado/silenciado) sobre un Storage
 *     inyectado;
 *   - el controlador que maneja la política de autoplay (contexto
 *     suspendido hasta un gesto del usuario).
 *
 * El hook de React que lo conecta con la página vive en
 * `useNewOrderChime.ts`.
 */

// ── Detección ────────────────────────────────────────────────────────────

/**
 * Ids de `roundIds` que no están en `seenIds`, en el orden en que llegan y
 * sin repetidos. Sólo cuenta la IDENTIDAD de la ronda: un cambio de estado
 * de un pedido existente no produce ids nuevos.
 */
export function detectNewRounds(
  seenIds: ReadonlySet<string>,
  roundIds: readonly string[],
): string[] {
  const fresh: string[] = [];
  const added = new Set<string>();
  for (const id of roundIds) {
    if (seenIds.has(id) || added.has(id)) continue;
    added.add(id);
    fresh.push(id);
  }
  return fresh;
}

/**
 * Rondas ya vistas en esta sesión de página. `scope` identifica la vista
 * (p. ej. la sub-estación del bar): al cambiar de vista aparecen rondas que
 * ya existían y que no son pedidos nuevos.
 */
export type SeenRounds = {
  readonly scope: string;
  readonly ids: ReadonlySet<string>;
};

/**
 * Paso de la detección, llamado cada vez que cambian las rondas del tablero.
 *
 *   - Primera observación (`prev === null`, al abrir o recargar la página):
 *     todo lo que ya estaba cuenta como visto y NO suena.
 *   - Cambio de `scope` (otra pestaña de sub-estación): lo que aparece se
 *     da por visto y NO suena.
 *   - Si no: suenan sólo ids nunca vistos. Varios juntos = UNA señal. Una
 *     ronda que sale del tablero sigue en el conjunto, así que si reaparece
 *     (p. ej. le agregaron algo) no vuelve a sonar.
 */
export function observeRounds(
  prev: SeenRounds | null,
  scope: string,
  roundIds: readonly string[],
): { seen: SeenRounds; newIds: string[]; chime: boolean } {
  if (prev === null || prev.scope !== scope) {
    const ids = new Set(prev?.ids ?? []);
    for (const id of roundIds) ids.add(id);
    return { seen: { scope, ids }, newIds: [], chime: false };
  }
  const newIds = detectNewRounds(prev.ids, roundIds);
  if (newIds.length === 0) return { seen: prev, newIds, chime: false };
  const ids = new Set(prev.ids);
  for (const id of newIds) ids.add(id);
  return { seen: { scope, ids }, newIds, chime: true };
}

// ── Síntesis del pitido ──────────────────────────────────────────────────

/*
 * Interfaces mínimas de Web Audio que usa el pitido. Un AudioContext real
 * las cumple; en los tests se inyecta uno falso que registra lo programado.
 */
export interface ChimeAudioParam {
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
}
export interface ChimeAudioNode {
  connect(destination: ChimeAudioNode): unknown;
  disconnect(): void;
}
export interface ChimeOscillatorNode extends ChimeAudioNode {
  type: OscillatorType;
  readonly frequency: ChimeAudioParam;
  start(when: number): void;
  stop(when: number): void;
  onended: unknown;
}
export interface ChimeGainNode extends ChimeAudioNode {
  readonly gain: ChimeAudioParam;
}
export interface ChimeAudioContext {
  readonly currentTime: number;
  readonly destination: ChimeAudioNode;
  createOscillator(): ChimeOscillatorNode;
  createGain(): ChimeGainNode;
}

/**
 * Tres pitidos cortos y agudos, el último más alto ("bip-bip-biip"). Entre
 * 2 y 3 kHz el oído es más sensible, así que se oye por encima del ruido de
 * una cocina sin tener que saturar el volumen.
 */
export const CHIME_FREQUENCIES_HZ: readonly number[] = [2500, 2500, 3000];
/** Onda cuadrada: más armónicos que una senoidal → más penetrante. */
export const CHIME_WAVEFORM: OscillatorType = "square";
export const CHIME_BEEP_SECONDS = 0.14;
export const CHIME_GAP_SECONDS = 0.08;
/** Ataque y caída de pocos ms: evitan el "clic" de arrancar a volumen pleno. */
export const CHIME_ATTACK_SECONDS = 0.005;
export const CHIME_RELEASE_SECONDS = 0.015;
/**
 * Pico de ganancia. La onda cuadrada tiene RMS = pico, así que 0,35 ya suena
 * fuerte; el sobrepico de la cuadrada limitada en banda (~10 %) queda muy
 * lejos de 1, sin saturar.
 */
export const CHIME_PEAK_GAIN = 0.35;
/** Margen para no programar nada "en el pasado" respecto del reloj de audio. */
export const CHIME_LEAD_SECONDS = 0.02;

/**
 * Programa el pitido en `ctx` y devuelve cuándo empieza y termina (en el
 * reloj del contexto). Cada pitido es un oscilador con su propia envolvente
 * de ganancia; los nodos se desconectan solos al terminar.
 */
export function playNewOrderChime(ctx: ChimeAudioContext): {
  startAt: number;
  endAt: number;
} {
  const startAt = ctx.currentTime + CHIME_LEAD_SECONDS;
  let t = startAt;
  let endAt = startAt;
  for (const freq of CHIME_FREQUENCIES_HZ) {
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = CHIME_WAVEFORM;
    osc.frequency.setValueAtTime(freq, t);

    const end = t + CHIME_BEEP_SECONDS;
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(CHIME_PEAK_GAIN, t + CHIME_ATTACK_SECONDS);
    amp.gain.setValueAtTime(CHIME_PEAK_GAIN, end - CHIME_RELEASE_SECONDS);
    amp.gain.linearRampToValueAtTime(0, end);

    osc.connect(amp);
    amp.connect(ctx.destination);
    osc.onended = () => {
      osc.disconnect();
      amp.disconnect();
    };
    osc.start(t);
    osc.stop(end);

    endAt = end;
    t = end + CHIME_GAP_SECONDS;
  }
  return { startAt, endAt };
}

// ── Preferencia por dispositivo ──────────────────────────────────────────

export type ChimeBoard = "kitchen" | "bar";

export const CHIME_STORAGE_PREFIX = "mesapay.newOrderChime.";

/** Clave de localStorage: distinta por tablero (cocina / bar). */
export function chimeStorageKey(board: ChimeBoard): string {
  return CHIME_STORAGE_PREFIX + board;
}

/**
 * Por defecto suena en la cocina (lo pidió el dueño); en el bar el control
 * aparece pero arranca silenciado.
 */
export function chimeDefaultEnabled(board: ChimeBoard): boolean {
  return board === "kitchen";
}

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

/** Lee la preferencia; ante storage ausente, roto o valor raro → default. */
export function readChimePref(
  storage: ReadableStorage | null | undefined,
  board: ChimeBoard,
): boolean {
  try {
    const raw = storage?.getItem(chimeStorageKey(board));
    if (raw === "on") return true;
    if (raw === "off") return false;
  } catch {
    // Modo privado, cuota, storage bloqueado: usamos el default.
  }
  return chimeDefaultEnabled(board);
}

/** Guarda la preferencia. Devuelve false si el storage no la aceptó. */
export function writeChimePref(
  storage: WritableStorage | null | undefined,
  board: ChimeBoard,
  enabled: boolean,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(chimeStorageKey(board), enabled ? "on" : "off");
    return true;
  } catch {
    return false;
  }
}

// ── Controlador (política de autoplay) ───────────────────────────────────

/** Lo que el controlador necesita de un AudioContext además del pitido. */
export interface ChimeContext extends ChimeAudioContext {
  readonly state: string;
  resume(): Promise<void>;
  close(): Promise<void>;
  addEventListener(type: "statechange", listener: () => void): void;
}

/**
 * Cuánto esperamos a que un contexto recién creado pase a "running". Según
 * el spec todo AudioContext nace "suspended" y, si el navegador lo permite,
 * arranca de forma asíncrona; sólo si sigue suspendido pasado este margen
 * concluimos que falta un gesto del usuario.
 */
export const CHIME_UNLOCK_GRACE_MS = 350;

/**
 * Dueño del ÚNICO AudioContext de la página. Lo crea perezosamente, lo
 * reanuda con los gestos del usuario y expone `needsUnlock` (entró un pedido
 * y el navegador no nos dejó sonar) como store externo para React.
 *
 * Nunca lanza: si Web Audio no existe o falla, simplemente no suena.
 */
export class NewOrderChimeController {
  private ctx: ChimeContext | null = null;
  private needsUnlock = false;
  private busyUntil = 0;
  private waiting = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly createContext: () => ChimeContext | null) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getNeedsUnlock = (): boolean => this.needsUnlock;

  /** Gesto del usuario: crea el contexto si falta y lo reanuda. */
  unlock(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    if (ctx.state === "running") {
      this.setNeedsUnlock(false);
      return;
    }
    void this.whenRunning(ctx);
  }

  /** Entró al menos un pedido nuevo: una sola señal. */
  announce(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    if (ctx.state === "running") {
      this.play(ctx);
      return;
    }
    // Ya hay una espera en curso por otra tanda: no apilamos pitidos.
    if (this.waiting) return;
    this.waiting = true;
    void this.whenRunning(ctx).then((running) => {
      this.waiting = false;
      if (this.ctx !== ctx) return;
      if (running) this.play(ctx);
      // Nadie tocó la pantalla desde que cargó: avisamos en vez de sonar
      // tarde (un pitido al tocar confundiría).
      else this.setNeedsUnlock(true);
    });
  }

  /** "Probar sonido": siempre llega desde un clic, que desbloquea el audio. */
  async test(): Promise<void> {
    const ctx = this.ensureContext();
    if (!ctx) return;
    if (await this.whenRunning(ctx)) this.play(ctx);
  }

  /** Cierra el contexto (desmontaje). Uno nuevo se crea si hace falta. */
  dispose(): void {
    const ctx = this.ctx;
    this.ctx = null;
    this.busyUntil = 0;
    this.waiting = false;
    this.setNeedsUnlock(false);
    if (ctx) {
      try {
        void ctx.close().catch(() => {});
      } catch {
        // Ya cerrado o navegador viejo: nada que hacer.
      }
    }
  }

  private ensureContext(): ChimeContext | null {
    if (this.ctx && this.ctx.state !== "closed") return this.ctx;
    let ctx: ChimeContext | null = null;
    try {
      ctx = this.createContext();
    } catch {
      ctx = null;
    }
    if (!ctx) return null;
    const created = ctx;
    try {
      created.addEventListener("statechange", () => {
        if (created === this.ctx && created.state === "running") {
          this.setNeedsUnlock(false);
        }
      });
    } catch {
      // Sin eventos de estado: `whenRunning` igual limpia el aviso.
    }
    this.ctx = created;
    return created;
  }

  /**
   * Pide `resume()` y resuelve true si el contexto queda "running" antes de
   * `CHIME_UNLOCK_GRACE_MS`. Sin gesto, el spec deja la promesa de resume
   * pendiente indefinidamente: por eso el tope de tiempo.
   */
  private whenRunning(ctx: ChimeContext): Promise<boolean> {
    if (ctx.state === "running") return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const running = ctx.state === "running";
        if (running && ctx === this.ctx) this.setNeedsUnlock(false);
        resolve(running);
      };
      const timer = setTimeout(finish, CHIME_UNLOCK_GRACE_MS);
      try {
        ctx.resume().then(finish, finish);
      } catch {
        finish();
      }
    });
  }

  private play(ctx: ChimeContext): void {
    // Si todavía está sonando el anterior (p. ej. "Probar" repetido), no
    // encimamos pitidos.
    if (ctx.currentTime < this.busyUntil) return;
    try {
      this.busyUntil = playNewOrderChime(ctx).endAt;
    } catch {
      // Un fallo de audio jamás rompe el tablero.
    }
  }

  private setNeedsUnlock(value: boolean): void {
    if (this.needsUnlock === value) return;
    this.needsUnlock = value;
    for (const listener of this.listeners) listener();
  }
}
