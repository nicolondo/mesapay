// Reconocimiento facial compartido (C2 · D1/D2) entre el kiosko de
// marcación y el enrolamiento del tab Equipo. La librería
// @vladmandic/face-api (+ tfjs) SOLO se carga vía import dinámico: queda
// en su propio chunk, fuera del bundle común — la descargan únicamente
// las pantallas que capturan rostro. Modelos (~6 MB) en /public/models.

type FaceApi = typeof import("@vladmandic/face-api");

// Singleton a nivel de módulo: una sola descarga de librería + modelos
// por sesión, compartida entre kiosko y enrolamiento.
let faceApiPromise: Promise<FaceApi> | null = null;

export function loadFaceApi(): Promise<FaceApi> {
  if (!faceApiPromise) {
    faceApiPromise = (async () => {
      const faceapi = await import("@vladmandic/face-api");
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri("/models"),
        faceapi.nets.faceLandmark68Net.loadFromUri("/models"),
        faceapi.nets.faceRecognitionNet.loadFromUri("/models"),
      ]);
      return faceapi;
    })();
    // Si falla (red caída a mitad de descarga), se permite reintentar en
    // la próxima captura en vez de dejar la promesa envenenada.
    faceApiPromise.catch(() => {
      faceApiPromise = null;
    });
  }
  return faceApiPromise;
}

/** Lado máximo de las fotos capturadas (JPEG 0.8 ≪ 5 MB del upload). */
export const MAX_PHOTO_WIDTH = 640;

/**
 * Frame actual del `<video>` a un canvas reducido a MAX_PHOTO_WIDTH (la
 * foto se captura SIN espejo — frame real de la cámara). Devuelve null si
 * el canvas no da contexto 2d; el caller debe verificar
 * `video.videoWidth > 0` ANTES de llamar (cámara todavía arrancando).
 */
export function captureVideoFrame(
  video: HTMLVideoElement,
): HTMLCanvasElement | null {
  const w = Math.min(video.videoWidth, MAX_PHOTO_WIDTH);
  const h = Math.round((video.videoHeight / video.videoWidth) * w);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.drawImage(video, 0, 0, w, h);
  return canvas;
}

/**
 * Descriptor facial (128 floats) del rostro del canvas, calculado 100%
 * en el cliente — nada biométrico sale del dispositivo. null = ningún
 * rostro detectado. Carga librería y modelos si hace falta (singleton).
 */
export async function detectFaceDescriptor(
  canvas: HTMLCanvasElement,
): Promise<Float32Array | null> {
  const faceapi = await loadFaceApi();
  const det = await faceapi
    .detectSingleFace(canvas, new faceapi.TinyFaceDetectorOptions())
    .withFaceLandmarks()
    .withFaceDescriptor();
  return det ? det.descriptor : null;
}
