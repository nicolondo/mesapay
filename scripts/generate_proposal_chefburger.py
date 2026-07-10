#!/usr/bin/env python3
"""
Propuesta comercial personalizada — Chef Burger (23 puntos de venta).
A4 vertical, diseño de marca MESAPAY (mismo sistema que los folletos).

Salida: docs/Propuesta-Chef-Burger-MESAPAY.pdf
"""
import base64
import os
import subprocess
import sys

ROOT = "/Users/nicolas/Documents/APPS/MESAPAY"
LOGO_DARK = f"{ROOT}/brand-kit/_build/logo-white-on-ink.png"
LOGO_LIGHT = f"{ROOT}/brand-kit/_build/logo-on-bone.png"
BUILD_HTML = f"{ROOT}/brand-kit/_build/proposal_chefburger.html"
OUTPUT = f"{ROOT}/docs/Propuesta-Chef-Burger-MESAPAY.pdf"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

PUNTOS = 23
PRECIO_PUNTO = 200_000
TOTAL_MES = PUNTOS * PRECIO_PUNTO  # 4.600.000


def b64(p):
    with open(p, "rb") as f:
        return base64.b64encode(f.read()).decode()


LOGO_DARK_URI = f"data:image/png;base64,{b64(LOGO_DARK)}"
LOGO_LIGHT_URI = f"data:image/png;base64,{b64(LOGO_LIGHT)}"


def cop(n):
    return "$" + f"{n:,.0f}".replace(",", ".")


INCLUDES = [
    ("Plataforma completa en los 23 puntos",
     "Pedido y pago por QR, comanda digital a cocina (KDS), app para el equipo, "
     "factura electrónica DIAN, cierre de turno y arqueo, y administración "
     "multi-sucursal con datos consolidados de toda la cadena."),
    ("Pulso · asistente de inteligencia artificial — INCLUIDO",
     "Preguntale a tus datos en lenguaje natural: productos más vendidos por punto, "
     "horas pico, desempeño del equipo, comparación entre sedes. Incluido en la "
     "tarifa para Chef Burger (normalmente exclusivo de planes superiores)."),
    ("Integración con su ERP / POS — INCLUIDA",
     "Conectamos MESAPAY con el sistema que Chef Burger ya usa, para que la "
     "información fluya sin doble digitación. El desarrollo corre por cuenta "
     "de nuestro equipo."),
    ("Carga de la carta — GRATIS",
     "Nuestro equipo monta el menú completo de los 23 puntos (fotos, precios, "
     "modificadores y combos), listo para operar desde el día uno."),
    ("Capacitación 'entrenador de entrenadores'",
     "Capacitamos a fondo a una persona de su equipo, quien se encarga de entrenar "
     "al resto del personal. Esa persona tiene línea directa de soporte por "
     "WhatsApp en horario laboral, incluyendo sábados."),
    ("Primer mes GRATIS",
     "El mes 1 es de implementación y validación sin costo: montamos, integramos, "
     "capacitamos y arrancamos. Empiezan a pagar cuando ya está funcionando."),
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
    ("01", "Semana 1 — Piloto", "Montamos 1–2 puntos piloto: carta cargada, QRs, cocina conectada y el primer servicio en vivo acompañado por nuestro equipo."),
    ("02", "Semanas 2–3 — Capacitación e integración", "Entrenamos al líder designado por Chef Burger y desarrollamos la integración con su ERP/POS en paralelo."),
    ("03", "Semana 4 — Despliegue", "Rollout al resto de los puntos con el playbook validado en el piloto. Al cierre del mes gratis, los 23 puntos operan con MESAPAY."),
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

  .inc{{ background:var(--paper); border:1px solid var(--hairline); border-radius:14px; padding:16px 20px; margin-top:11px; }}
  .inct{{ font-size:14.5px; font-weight:600; }}
  .incx{{ font-size:12px; line-height:1.55; color:var(--ink3); margin-top:4px; }}
  .badge{{ font-family:var(--mono); font-size:8px; letter-spacing:0.1em; background:var(--success); color:#fff;
           padding:2.5px 8px; border-radius:999px; margin-left:8px; vertical-align:middle; }}

  .pricebox{{ background:var(--ink); color:var(--ivory); border-radius:18px; padding:28px 32px; margin-top:22px; position:relative; overflow:hidden; }}
  .pricebox .glow{{ position:absolute; right:-90px; top:-90px; width:280px; height:280px; border-radius:50%;
                   background:radial-gradient(circle, rgba(201,83,46,0.5), rgba(201,83,46,0) 70%); }}
  .prow{{ display:flex; justify-content:space-between; align-items:baseline; padding:9px 0; position:relative;
          border-bottom:1px solid rgba(245,241,234,0.14); font-size:13.5px; color:#D8CFBF; }}
  .prow b{{ color:#fff; font-weight:600; }}
  .prow .pv{{ font-family:var(--display); font-size:21px; color:#fff; }}
  .prow.total .pv{{ font-size:34px; color:var(--terra-soft); }}
  .prow.total{{ border-bottom:none; padding-top:14px; }}
  .pnote{{ font-size:10px; color:var(--muted2); margin-top:10px; position:relative; }}
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
  <h1>Chef Burger<br>× MESAPAY</h1>
  <div class="lead">Propuesta para digitalizar el pedido, el pago y la operación de los
    <b>{PUNTOS} puntos de venta</b> de Chef Burger — con inteligencia artificial incluida,
    integración con su sistema actual y un despliegue acompañado de principio a fin.</div>
  <div class="spacer"></div>
  <div class="meta">
    <div><div class="ml">Preparado para</div><div class="mv">Chef Burger</div></div>
    <div><div class="ml">Fecha</div><div class="mv">Junio 2026</div></div>
    <div><div class="ml">Vigencia</div><div class="mv">30 días</div></div>
  </div>
</section>

<!-- 2 · Qué incluye -->
<section class="page">
  <div class="kick">La propuesta</div>
  <h2>Todo incluido. Sin sorpresas.</h2>
  {''.join(include_card(t, d) for t, d in INCLUDES)}
  <div class="pagefoot"><img class="footlogo" src="{LOGO_LIGHT_URI}"><span>mesapay.co · info@mesapay.co</span></div>
</section>

<!-- 3 · Inversión + plan -->
<section class="page">
  <div class="kick">Inversión</div>
  <h2>Tarifa preferencial de cadena.</h2>
  <div class="pricebox">
    <div class="glow"></div>
    <div class="prow"><span>Tarifa por punto de venta</span><span class="pv">{cop(PRECIO_PUNTO)} <span style="font-size:13px;color:#D8CFBF">/mes</span></span></div>
    <div class="prow"><span>Puntos de venta</span><span class="pv">{PUNTOS}</span></div>
    <div class="prow total"><span><b>Total cadena</b></span><span class="pv">{cop(TOTAL_MES)} <span style="font-size:15px;color:#D8CFBF">/mes</span></span></div>
    <div class="pnote">Precios en COP, no incluyen IVA. Tarifa preferencial por volumen para los {PUNTOS} puntos —
      incluye Pulso (IA), integración ERP/POS, carga de carta, capacitación y soporte. Sin costos de instalación.</div>
  </div>
  <div class="freebar">★ <b>Primer mes gratis:</b> implementación, integración y capacitación sin costo.
    El primer cobro llega cuando la operación ya está andando.</div>
  <h2 style="margin-top:26px">Plan de despliegue.</h2>
  {''.join(f'<div class="scard"><div class="snum">{n}</div><div class="stitle">{t}</div><div class="stext">{d}</div></div>' for n, t, d in STEPS)}
  <div class="pagefoot"><img class="footlogo" src="{LOGO_LIGHT_URI}"><span>mesapay.co · info@mesapay.co</span></div>
</section>

<!-- 4 · Condiciones + CTA -->
<section class="page">
  <div class="kick">Condiciones</div>
  <h2>Claras y simples.</h2>
  <ul class="terms">
    <li><b>Facturación mensual</b> por punto de venta activo, mes vencido a partir del mes 2 (el mes 1 es gratis).</li>
    <li><b>Sin permanencia:</b> pueden cancelar cualquier punto con aviso de 30 días.</li>
    <li><b>Soporte:</b> línea directa de WhatsApp para el líder designado, en horario laboral incluyendo sábados. Incidentes críticos de plataforma se atienden con prioridad.</li>
    <li><b>Integración ERP/POS:</b> el desarrollo lo asume MESAPAY; requerimos acceso a la documentación técnica o al proveedor del sistema de Chef Burger.</li>
    <li><b>Equipos:</b> la plataforma corre sobre una tablet por cocina y los celulares del equipo — sin POS propietario ni licencias por terminal.</li>
    <li><b>Datos:</b> la información de ventas y clientes de Chef Burger es de Chef Burger. Confidencialidad total; disponible NDA si lo requieren.</li>
    <li><b>Vigencia de la propuesta:</b> 30 días desde la fecha de emisión.</li>
  </ul>
  <div class="ctabox">
    <div class="glow"></div>
    <div class="ct">Arranquemos con el piloto.</div>
    <div class="cs">Elegimos juntos los 2 primeros puntos y en una semana los tienen funcionando — sin costo y sin compromiso.</div>
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
