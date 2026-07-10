#!/usr/bin/env python3
"""
Propuesta comercial personalizada — Mundo Verde.
Tarifa plana $399.000/mes por punto de venta, sin importar el número de mesas,
con todas las funcionalidades activas incluyendo Pulso (IA).
A4 vertical, diseño de marca MESAPAY (mismo sistema que los folletos).

Salida: docs/Propuesta-Mundo-Verde-MESAPAY.pdf
"""
import base64
import os
import subprocess
import sys

ROOT = "/Users/nicolas/Documents/APPS/MESAPAY"
LOGO_DARK = f"{ROOT}/brand-kit/_build/logo-white-on-ink.png"
LOGO_LIGHT = f"{ROOT}/brand-kit/_build/logo-on-bone.png"
BUILD_HTML = f"{ROOT}/brand-kit/_build/proposal_mundoverde.html"
OUTPUT = f"{ROOT}/docs/Propuesta-Mundo-Verde-MESAPAY.pdf"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

CLIENTE = "Mundo Verde"
PRECIO_PUNTO = 399_000


def b64(p):
    with open(p, "rb") as f:
        return base64.b64encode(f.read()).decode()


LOGO_DARK_URI = f"data:image/png;base64,{b64(LOGO_DARK)}"
LOGO_LIGHT_URI = f"data:image/png;base64,{b64(LOGO_LIGHT)}"


def cop(n):
    return "$" + f"{n:,.0f}".replace(",", ".")


INCLUDES = [
    ("Pedido y pago por QR en la mesa",
     "Tus clientes escanean un QR, ven la carta con fotos, piden y pagan desde su "
     "celular — sin descargar ninguna app. Cada comensal ordena a su ritmo y divide "
     "la cuenta como quiera; las mesas rotan más rápido."),
    ("Tus meseros asesoran, no transcriben",
     "En vez de anotar pedidos y caminar al sistema, el equipo se queda en la mesa "
     "recomendando y resolviendo dudas — y el mesero también puede ingresar pedidos "
     "él mismo cuando la mesa lo prefiere. Mejor atención y ticket más alto."),
    ("Comanda digital de cocina (KDS)",
     "Cada pedido entra directo a cocina y barra, ordenado y ruteado por estación. "
     "Sin papeles, sin errores de transcripción, sin pedidos perdidos en el camino."),
    ("Factura electrónica DIAN, cierre de turno y reportes",
     "Facturación electrónica automática, arqueo de caja que cuadra solo al final "
     "del día y reportes de venta listos para tu contador."),
    ("Pulso · inteligencia artificial — INCLUIDO",
     "Preguntale a tus datos en lenguaje natural: qué platos se venden más, tus horas "
     "pico, el ticket promedio, el desempeño del equipo. Incluido en tu tarifa, sin "
     "costo adicional."),
    ("Carga de carta, capacitación y soporte — GRATIS",
     "Nuestro equipo monta tu menú completo (fotos, precios y modificadores), capacita "
     "a tu personal y te deja línea directa de soporte por WhatsApp en horario laboral, "
     "incluyendo sábados."),
]


def include_card(t, d):
    badge = ""
    for k in ("INCLUIDO", "INCLUIDA", "GRATIS"):
        if k in t:
            t = t.replace(" — " + k, "")
            badge = f'<span class="badge">{k}</span>'
    return f"""
    <div class="inc">
      <div class="inct">{t}{badge}</div>
      <div class="incx">{d}</div>
    </div>"""


STEPS = [
    ("01", "Días 1–3 — Montaje", "Cargamos tu carta completa, generamos los QRs de cada mesa y conectamos la cocina. Tú no tienes que hacer nada."),
    ("02", "Capacitación y primer servicio", "Entrenamos a tu equipo y acompañamos el primer servicio en vivo para resolver cualquier duda directamente en el piso."),
    ("03", "En marcha", "Mundo Verde operando completo con MESAPAY. Pulso empieza a mostrarte tus números desde la primera semana, y el soporte por WhatsApp queda siempre a la mano."),
]

HTML = f"""<!doctype html><html lang="es"><head><meta charset="utf-8">
<style>
  @page {{ size: A4; margin: 0; }}
  * {{ box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
  :root{{
    --bone:#F5F1EA; --paper:#FBF8F3; --ivory:#FFFDF9; --ink:#1A1613; --ink2:#2B2521; --ink3:#423B35;
    --muted:#6B6259; --muted2:#8F867C; --hairline:#E5DED1; --line2:#D8CFBF;
    --terra:#C9532E; --terra2:#A8401F; --terra-soft:#F0D9CB; --success:#2E6B4C;
    --display:'Instrument Serif',Georgia,serif;
    --sans:'Geist',ui-sans-serif,system-ui,sans-serif;
    --mono:'Geist Mono',ui-monospace,Menlo,monospace;
  }}
  html,body{{ margin:0; padding:0; font-family:var(--sans); color:var(--ink); background:#fff; }}
  .page{{ width:210mm; height:297mm; padding:20mm 16mm 22mm; position:relative; overflow:hidden;
          background:var(--bone); page-break-after:always; display:flex; flex-direction:column; justify-content:center; }}
  .page:last-child{{ page-break-after:auto; }}
  .kick{{ font-family:var(--mono); font-size:9.5px; letter-spacing:0.20em; text-transform:uppercase; color:var(--terra2); }}
  h1{{ font-family:var(--display); font-weight:400; font-size:54px; line-height:1.05; margin:14px 0 10px; }}
  h2{{ font-family:var(--display); font-weight:400; font-size:32px; line-height:1.1; margin:8px 0 6px; }}
  .lead{{ font-size:14px; line-height:1.6; color:var(--ink3); max-width:150mm; }}
  .pagefoot{{ position:absolute; left:16mm; right:16mm; bottom:11mm; display:flex; justify-content:space-between;
             font-family:var(--mono); font-size:8px; letter-spacing:0.14em; text-transform:uppercase;
             color:var(--muted2); border-top:1px solid var(--hairline); padding-top:7px; }}
  .footlogo{{ height:13px; opacity:0.85; }}

  .cover{{ background:var(--ink); color:var(--ivory); justify-content:flex-start; }}
  .cover .clogo{{ height:34px; width:auto; align-self:flex-start; object-fit:contain; }}
  .cover .kick{{ color:var(--terra-soft); }}
  .cover h1{{ color:#fff; }}
  .cover .lead{{ color:#D8CFBF; font-size:15px; }}
  .cover .glow{{ position:absolute; width:520px; height:520px; right:-160px; top:-150px; border-radius:50%;
                background:radial-gradient(circle, rgba(201,83,46,0.55), rgba(201,83,46,0) 68%); }}
  .cover .spacer{{ flex:1; }}
  .cover .meta{{ position:relative; z-index:2; display:grid; grid-template-columns:1fr 1fr 1fr; gap:14px;
                border-top:1px solid rgba(245,241,234,0.18); padding-top:16px; margin-top:20px; }}
  .cover .ml{{ font-family:var(--mono); font-size:8.5px; letter-spacing:0.16em; text-transform:uppercase; color:var(--muted2); }}
  .cover .mv{{ font-size:13px; color:var(--ivory); margin-top:4px; }}

  .inc{{ background:var(--paper); border:1px solid var(--hairline); border-radius:14px; padding:15px 20px; margin-top:10px; }}
  .inct{{ font-size:14.5px; font-weight:600; }}
  .incx{{ font-size:12px; line-height:1.52; color:var(--ink3); margin-top:4px; }}
  .badge{{ font-family:var(--mono); font-size:8px; letter-spacing:0.1em; background:var(--success); color:#fff;
           padding:2.5px 8px; border-radius:999px; margin-left:8px; vertical-align:middle; }}

  .pricebox{{ background:var(--ink); color:var(--ivory); border-radius:18px; padding:28px 32px; margin-top:20px; position:relative; overflow:hidden; }}
  .pricebox .glow{{ position:absolute; right:-90px; top:-90px; width:280px; height:280px; border-radius:50%;
                   background:radial-gradient(circle, rgba(201,83,46,0.5), rgba(201,83,46,0) 70%); }}
  .hero{{ position:relative; padding:2px 0 16px; border-bottom:1px solid rgba(245,241,234,0.14); }}
  .heroprice{{ font-family:var(--display); font-size:62px; line-height:1; color:var(--terra-soft); }}
  .heroprice .permo{{ font-family:var(--sans); font-size:18px; color:#D8CFBF; }}
  .herolabel{{ font-size:12.5px; color:#D8CFBF; margin-top:9px; }}
  .flatrow{{ position:relative; display:flex; justify-content:space-between; align-items:center; gap:16px;
             padding:13px 0; border-bottom:1px solid rgba(245,241,234,0.14); }}
  .flatk{{ font-weight:600; color:#fff; font-size:14px; }}
  .flatv{{ font-size:11.5px; color:var(--muted2); text-align:right; }}
  .prow{{ display:flex; justify-content:space-between; align-items:baseline; padding:9px 0; position:relative;
          border-bottom:1px solid rgba(245,241,234,0.14); font-size:13.5px; color:#D8CFBF; }}
  .prow:last-of-type{{ border-bottom:none; }}
  .prow b{{ color:#fff; font-weight:600; }}
  .pnote{{ font-size:10px; color:var(--muted2); margin-top:12px; position:relative; line-height:1.5; }}
  .freebar{{ margin-top:14px; background:var(--terra-soft); color:var(--terra2); border-radius:12px;
             padding:13px 18px; font-size:13px; }}
  .freebar b{{ color:var(--terra2); }}

  .scard{{ background:var(--paper); border:1px solid var(--hairline); border-radius:16px; padding:18px 24px;
           display:grid; grid-template-columns:64px 1fr; align-items:center; gap:6px 20px; margin-top:13px; }}
  .scard .snum{{ font-family:var(--display); font-size:42px; color:var(--terra); line-height:1; }}
  .scard .stitle{{ font-family:var(--display); font-size:21px; }}
  .scard .stext{{ font-size:12.5px; line-height:1.5; color:var(--ink3); grid-column:2; }}

  .terms{{ margin-top:18px; }}
  .terms li{{ font-size:12px; line-height:1.6; color:var(--ink3); margin-bottom:6px; }}
  .ctabox{{ background:var(--ink); color:var(--ivory); border-radius:20px; padding:34px; text-align:center; margin-top:26px; position:relative; overflow:hidden; }}
  .ctabox .glow{{ position:absolute; left:50%; top:-120px; transform:translateX(-50%); width:460px; height:300px; border-radius:50%;
                 background:radial-gradient(circle, rgba(201,83,46,0.45), rgba(201,83,46,0) 70%); }}
  .ctabox .ct{{ font-family:var(--display); font-size:32px; color:#fff; position:relative; }}
  .ctabox .cs{{ font-size:13.5px; color:#D8CFBF; margin-top:8px; position:relative; }}
  .ctabox .links{{ position:relative; margin-top:20px; display:flex; gap:14px; justify-content:center; }}
  .ctabox .lk{{ font-family:var(--mono); font-size:12.5px; background:var(--terra); color:#fff; padding:12px 24px; border-radius:999px; }}
  .ctabox .lk.ghost{{ background:transparent; border:1px solid rgba(245,241,234,0.4); color:var(--ivory); }}
</style></head><body>

<!-- 1 · Portada -->
<section class="page cover">
  <div class="glow"></div>
  <img class="clogo" src="{LOGO_DARK_URI}" alt="MESAPAY">
  <div class="spacer"></div>
  <div class="kick">Propuesta comercial · Confidencial</div>
  <h1>{CLIENTE}<br>× MESAPAY</h1>
  <div class="lead">Una sola tarifa por punto de venta — <b>sin importar cuántas mesas tengas</b> —
    con todas las funcionalidades activas, inteligencia artificial incluida y un arranque
    acompañado de principio a fin.</div>
  <div class="spacer"></div>
  <div class="meta">
    <div><div class="ml">Preparado para</div><div class="mv">{CLIENTE}</div></div>
    <div><div class="ml">Fecha</div><div class="mv">Junio 2026</div></div>
    <div><div class="ml">Vigencia</div><div class="mv">30 días</div></div>
  </div>
</section>

<!-- 2 · Qué incluye -->
<section class="page">
  <div class="kick">La propuesta</div>
  <h2>Todas las funcionalidades activas.</h2>
  {''.join(include_card(t, d) for t, d in INCLUDES)}
  <div class="pagefoot"><img class="footlogo" src="{LOGO_LIGHT_URI}"><span>mesapay.co · info@mesapay.co</span></div>
</section>

<!-- 3 · Inversión + plan -->
<section class="page">
  <div class="kick">Inversión</div>
  <h2>Una tarifa plana. Sin letra chica.</h2>
  <div class="pricebox">
    <div class="glow"></div>
    <div class="hero">
      <div class="heroprice">{cop(PRECIO_PUNTO)} <span class="permo">/mes</span></div>
      <div class="herolabel">por punto de venta · todas las funcionalidades activas + Pulso (IA)</div>
    </div>
    <div class="flatrow">
      <div class="flatk">Sin importar el número de mesas</div>
      <div class="flatv">10, 20 o 40 mesas — la tarifa es la misma.</div>
    </div>
    <div class="prow"><span>Pulso · inteligencia artificial</span><b>Incluido</b></div>
    <div class="prow"><span>Carga de carta, capacitación y soporte</span><b>Incluido</b></div>
    <div class="prow"><span>Instalación y configuración</span><b>$0</b></div>
    <div class="pnote">Precios en COP, no incluyen IVA. ¿Más de un punto de venta? Cada punto adicional se
      factura a la misma tarifa de {cop(PRECIO_PUNTO)}/mes. Sin costos de instalación ni licencias por terminal.</div>
  </div>
  <div class="freebar">★ <b>Primer mes gratis:</b> montaje, capacitación y arranque sin costo.
    El primer cobro llega cuando la operación ya está andando.</div>
  <h2 style="margin-top:24px">Cómo arrancamos.</h2>
  {''.join(f'<div class="scard"><div class="snum">{n}</div><div class="stitle">{t}</div><div class="stext">{d}</div></div>' for n, t, d in STEPS)}
  <div class="pagefoot"><img class="footlogo" src="{LOGO_LIGHT_URI}"><span>mesapay.co · info@mesapay.co</span></div>
</section>

<!-- 4 · Condiciones + CTA -->
<section class="page">
  <div class="kick">Condiciones</div>
  <h2>Claras y simples.</h2>
  <ul class="terms">
    <li><b>Tarifa plana:</b> {cop(PRECIO_PUNTO)}/mes por punto de venta, sin importar el número de mesas ni el volumen de pedidos.</li>
    <li><b>Facturación mensual</b> por punto de venta activo, mes vencido a partir del mes 2 (el mes 1 es gratis).</li>
    <li><b>Sin permanencia:</b> puedes cancelar con un aviso de 30 días.</li>
    <li><b>Soporte:</b> línea directa de WhatsApp en horario laboral, incluyendo sábados. Los incidentes críticos de plataforma se atienden con prioridad.</li>
    <li><b>Equipos:</b> la plataforma corre sobre una tablet en la cocina y los celulares del equipo — sin POS propietario ni licencias por terminal.</li>
    <li><b>Datos:</b> la información de ventas y clientes de {CLIENTE} es de {CLIENTE}. Confidencialidad total; disponible NDA si lo requieren.</li>
    <li><b>Vigencia de la propuesta:</b> 30 días desde la fecha de emisión.</li>
  </ul>
  <div class="ctabox">
    <div class="glow"></div>
    <div class="ct">Probémoslo en tu próximo servicio.</div>
    <div class="cs">Cargamos tu carta y en pocos días {CLIENTE} está pidiendo y pagando por QR — sin costo y sin compromiso.</div>
    <div class="links">
      <span class="lk">info@mesapay.co</span>
      <span class="lk ghost">mesapay.co</span>
    </div>
  </div>
  <div class="pagefoot"><img class="footlogo" src="{LOGO_LIGHT_URI}"><span>Nicolás Londoño · Fundador · MESAPAY</span></div>
</section>

</body></html>"""


def main():
    os.makedirs(os.path.dirname(BUILD_HTML), exist_ok=True)
    with open(BUILD_HTML, "w", encoding="utf-8") as f:
        f.write(HTML)
    if not os.path.exists(CHROME):
        print("Chrome no encontrado", file=sys.stderr)
        sys.exit(1)
    subprocess.run([CHROME, "--headless", "--disable-gpu", "--no-sandbox",
                    "--print-to-pdf-no-header", f"--print-to-pdf={OUTPUT}",
                    f"file://{BUILD_HTML}"], check=True, capture_output=True)
    print(f"OK → {OUTPUT}")


if __name__ == "__main__":
    main()
