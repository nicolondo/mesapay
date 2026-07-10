#!/usr/bin/env python3
"""
Presentación institucional de MESAPAY (A4 vertical, 7 páginas, SIN precios).
País-neutral: sirve para Colombia y México.

Salida: docs/MESAPAY-Presentacion-Empresa.pdf
"""
import base64
import os
import subprocess
import sys

ROOT = "/Users/nicolas/Documents/APPS/MESAPAY"
LOGO_DARK = f"{ROOT}/brand-kit/_build/logo-white-on-ink.png"
LOGO_LIGHT = f"{ROOT}/brand-kit/_build/logo-on-bone.png"
BUILD_HTML = f"{ROOT}/brand-kit/_build/company_overview.html"
OUTPUT = f"{ROOT}/docs/MESAPAY-Presentacion-Empresa.pdf"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def b64(p):
    with open(p, "rb") as f:
        return base64.b64encode(f.read()).decode()


LOGO_DARK_URI = f"data:image/png;base64,{b64(LOGO_DARK)}"
LOGO_LIGHT_URI = f"data:image/png;base64,{b64(LOGO_LIGHT)}"


def icon(paths):
    return ('<svg viewBox="0 0 24 24" fill="none" stroke="#C9532E" '
            'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
            f"{paths}</svg>")


IC_QR = icon('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3M21 14v.01M21 21v.01M17 21h.01M21 17v4"/>')
IC_GLOBE = icon('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>')
IC_KDS = icon('<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 9h18M8 18v3M16 18v3M6 22h12"/>')
IC_CAL = icon('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4M9 14l2 2 4-4"/>')
IC_PHONE = icon('<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M10 18h4"/>')
IC_DOC = icon('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>')
IC_CASH = icon('<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9v.01M18 15v.01"/>')
IC_BUILDING = icon('<path d="M4 21V5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v16"/><path d="M13 9h6a1 1 0 0 1 1 1v11M7 8h.01M10 8h.01M7 12h.01M10 12h.01M7 16h.01M10 16h.01"/>')
IC_AI = icon('<path d="M12 3l1.8 4.4L18 9l-4.2 1.6L12 15l-1.8-4.4L6 9l4.2-1.6L12 3z"/><path d="M19 14l.7 1.8L21.5 16.5 19.7 17.2 19 19l-.7-1.8L16.5 16.5 18.3 15.8 19 14z"/>')

FEATURES = [
    (IC_QR, "Pedido y pago por QR", "El comensal ordena y paga desde su celular, sin esperar al mesero y sin descargar ninguna app."),
    (IC_GLOBE, "Carta digital trilingüe", "El menú en español, inglés y portugués — se traduce automáticamente."),
    (IC_KDS, "Comanda a cocina y bar", "Pantallas de cocina y bar separadas, con tiempos, prioridades e impresión de tickets."),
    (IC_CAL, "Reservas con depósito", "Reservas en línea con cobro de depósito para frenar los no-shows."),
    (IC_PHONE, "App del equipo", "Los meseros toman pedidos, cobran y reciben avisos desde su celular."),
    (IC_DOC, "Factura electrónica local", "Válida ante la autoridad de cada país (DIAN en Colombia, CFDI 4.0 en México), enviada al correo del cliente."),
    (IC_CASH, "Cierre de turno y arqueo", "Cuadre de caja, propinas y reportes contables al cerrar cada turno."),
    (IC_BUILDING, "Multi-sucursal", "Varias sedes administradas desde un solo panel, con datos consolidados."),
    (IC_AI, "Pulso · asistente de IA", "El dueño le pregunta a sus datos en lenguaje natural: productos más vendidos, horas pico, desempeño del equipo.", True),
]


def feature_card(f):
    badge = '<span class="newbadge">IA</span>' if len(f) > 3 and f[3] else ""
    return f"""
    <div class="fcard">
      <div class="ficon">{f[0]}</div>
      <div class="fbody">
        <div class="ftitle">{f[1]}{badge}</div>
        <div class="ftext">{f[2]}</div>
      </div>
    </div>"""


PROBLEMS = [
    ("Personal caro y escaso", "Conseguir y retener meseros es cada vez más difícil, y la nómina pesa más cada año."),
    ("Mesas que rotan lento", "El cliente espera para pedir, espera la cuenta y espera el medio de pago. Cada minuto extra es una mesa que no gira."),
    ("Errores y descuadres", "Comandas mal tomadas, propinas confusas y cierres de caja que no cuadran al final de la noche."),
    ("Datos invisibles", "El dueño decide a ciegas: no sabe qué se vende más, cuándo se satura la cocina ni quién de su equipo rinde mejor."),
]

STEPS = [
    ("01", "Escanea", "El comensal escanea el QR de su mesa y ve la carta al instante — con fotos, en su idioma. Sin descargar ninguna app."),
    ("02", "Ordena", "Cada persona de la mesa elige y envía su pedido a la vez — nadie espera su turno. Va directo a cocina y bar."),
    ("03", "Paga", "Paga desde el celular, divide la cuenta entre varios y recibe su factura electrónica al correo."),
]

BENEFITS = [
    ("+10–15%", "de ticket promedio", "La carta sugiere acompañamientos y adicionales en el momento exacto, y los meseros tienen tiempo para recomendar."),
    ("+3–5%", "de rotación de mesa", "Sin esperas para pedir ni para pagar, cada mesa gira más veces por servicio."),
    ("−90%", "de errores de comanda", "El pedido lo escribe el propio cliente y llega directo a cocina: sin transcripciones, sin malentendidos."),
    ("100%", "de visibilidad del negocio", "Ventas, horas pico, desempeño por mesero y por sede — y Pulso, la IA que responde preguntas sobre tu operación."),
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
  h2{{ font-family:var(--display); font-weight:400; font-size:33px; line-height:1.1; margin:8px 0 6px; }}
  .lead{{ font-size:14px; line-height:1.6; color:var(--ink3); max-width:150mm; }}
  .pagefoot{{ position:absolute; left:16mm; right:16mm; bottom:11mm; display:flex; justify-content:space-between;
             font-family:var(--mono); font-size:8px; letter-spacing:0.14em; text-transform:uppercase;
             color:var(--muted2); border-top:1px solid var(--hairline); padding-top:7px; }}
  .footlogo{{ height:13px; opacity:0.85; }}

  .cover{{ background:var(--ink); color:var(--ivory); justify-content:flex-start; }}
  .cover .clogo{{ height:34px; width:auto; align-self:flex-start; object-fit:contain; }}
  .cover .kick{{ color:var(--terra-soft); }}
  .cover h1{{ color:#fff; font-size:58px; margin-top:18px; }}
  .cover .lead{{ color:#D8CFBF; font-size:15px; }}
  .cover .glow{{ position:absolute; width:520px; height:520px; right:-160px; top:-150px; border-radius:50%;
                background:radial-gradient(circle, rgba(201,83,46,0.55), rgba(201,83,46,0) 68%); }}
  .cover .glow2{{ position:absolute; width:420px; height:420px; left:-160px; bottom:-160px; border-radius:50%;
                 background:radial-gradient(circle, rgba(184,137,59,0.28), rgba(184,137,59,0) 70%); }}
  .cover .spacer{{ flex:1; }}
  .cover .tagrow{{ display:flex; gap:8px; flex-wrap:wrap; margin-top:22px; position:relative; z-index:2; }}
  .tag{{ font-family:var(--mono); font-size:9.5px; letter-spacing:0.06em; color:var(--ivory);
         border:1px solid rgba(245,241,234,0.28); border-radius:999px; padding:6px 12px; }}
  .cover .footrow{{ position:relative; z-index:2; display:flex; justify-content:space-between; align-items:center;
                    font-family:var(--mono); font-size:10px; letter-spacing:0.14em; text-transform:uppercase; color:var(--muted2);
                    border-top:1px solid rgba(245,241,234,0.18); padding-top:12px; margin-top:18px; }}

  .pgrid{{ display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-top:24px; }}
  .pcard{{ background:var(--paper); border:1px solid var(--hairline); border-radius:16px; padding:22px; }}
  .pcard .ptitle{{ font-family:var(--display); font-size:23px; color:var(--terra2); margin-bottom:7px; }}
  .pcard .ptext{{ font-size:12.5px; line-height:1.55; color:var(--ink3); }}
  .closer{{ font-family:var(--display); font-size:30px; text-align:center; margin-top:30px; }}
  .closer b{{ color:var(--terra); font-weight:400; }}

  .steps{{ display:flex; flex-direction:column; gap:14px; margin-top:24px; }}
  .scard{{ background:var(--paper); border:1px solid var(--hairline); border-radius:16px; padding:20px 26px;
           display:grid; grid-template-columns:74px 1fr; align-items:center; gap:8px 22px; }}
  .scard .snum{{ font-family:var(--display); font-size:46px; color:var(--terra); line-height:1; }}
  .scard .stitle{{ font-family:var(--display); font-size:24px; }}
  .scard .stext{{ font-size:13px; line-height:1.55; color:var(--ink3); grid-column:2; }}
  .note{{ margin-top:18px; background:var(--terra-soft); border-radius:14px; padding:15px 20px;
          font-size:12px; line-height:1.5; color:var(--ink2); }}
  .note b{{ color:var(--terra2); }}
  .svc{{ margin-top:12px; background:var(--paper); border:1px solid var(--hairline); border-radius:14px; padding:17px 22px; }}
  .svct{{ font-family:var(--display); font-size:21px; margin-bottom:5px; }}
  .svct b{{ color:var(--terra); font-weight:400; }}
  .svcx{{ font-size:12px; line-height:1.55; color:var(--ink3); }}

  .fgrid{{ display:grid; grid-template-columns:1fr 1fr; gap:13px; margin-top:22px; }}
  .fcard{{ background:var(--paper); border:1px solid var(--hairline); border-radius:14px; padding:16px 17px;
           display:grid; grid-template-columns:42px 1fr; gap:14px; align-items:start; }}
  .ficon{{ width:42px; height:42px; border-radius:11px; background:var(--terra-soft); display:flex; align-items:center; justify-content:center; }}
  .ficon svg{{ width:22px; height:22px; }}
  .ftitle{{ font-size:14px; font-weight:600; margin-bottom:3px; }}
  .ftext{{ font-size:11.5px; line-height:1.45; color:var(--muted); }}
  .newbadge{{ font-family:var(--mono); font-size:7.5px; letter-spacing:0.1em; background:var(--terra); color:#fff;
              padding:2px 6px; border-radius:999px; margin-left:7px; vertical-align:middle; }}

  .bgrid{{ display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-top:24px; }}
  .bcard{{ background:var(--paper); border:1px solid var(--hairline); border-radius:16px; padding:24px; }}
  .bnum{{ font-family:var(--display); font-size:44px; color:var(--terra); line-height:1; }}
  .blabel{{ font-family:var(--mono); font-size:9px; letter-spacing:0.14em; text-transform:uppercase; color:var(--muted); margin-top:6px; }}
  .btext{{ font-size:12px; line-height:1.5; color:var(--ink3); margin-top:10px; }}
  .fineprint{{ font-size:9.5px; color:var(--muted2); margin-top:14px; line-height:1.4; }}

  .about{{ background:var(--paper); border:1px solid var(--hairline); border-radius:18px; padding:28px 30px; margin-top:22px; }}
  .about p{{ font-size:13.5px; line-height:1.7; color:var(--ink3); margin:0 0 14px; }}
  .about p:last-child{{ margin:0; }}
  .pillrow{{ display:flex; gap:10px; flex-wrap:wrap; margin-top:18px; }}
  .pill{{ font-family:var(--mono); font-size:10px; letter-spacing:0.06em; background:var(--terra-soft);
          color:var(--terra2); border-radius:999px; padding:7px 14px; }}

  .ctabox{{ background:var(--ink); color:var(--ivory); border-radius:20px; padding:40px; text-align:center; margin-top:30px; position:relative; overflow:hidden; }}
  .ctabox .glow{{ position:absolute; left:50%; top:-120px; transform:translateX(-50%); width:460px; height:300px; border-radius:50%;
                 background:radial-gradient(circle, rgba(201,83,46,0.45), rgba(201,83,46,0) 70%); }}
  .ctabox .ct{{ font-family:var(--display); font-size:38px; color:#fff; position:relative; }}
  .ctabox .cs{{ font-size:14px; color:#D8CFBF; margin-top:10px; position:relative; }}
  .ctabox .links{{ position:relative; margin-top:24px; display:flex; gap:14px; justify-content:center; flex-wrap:wrap; }}
  .ctabox .lk{{ font-family:var(--mono); font-size:13px; background:var(--terra); color:#fff; padding:13px 26px; border-radius:999px; }}
  .ctabox .lk.ghost{{ background:transparent; border:1px solid rgba(245,241,234,0.4); color:var(--ivory); }}
</style></head><body>

<!-- 1 · Portada -->
<section class="page cover">
  <div class="glow"></div><div class="glow2"></div>
  <img class="clogo" src="{LOGO_DARK_URI}" alt="MESAPAY">
  <div class="spacer"></div>
  <div class="kick">Presentación de la empresa</div>
  <h1>La tecnología que<br>transforma la mesa.</h1>
  <div class="lead">MESAPAY es la plataforma todo-en-uno para restaurantes: tus comensales escanean,
    ordenan y pagan desde el celular, mientras el dueño ve su negocio completo en tiempo real —
    de la comanda a la factura, de la reserva a la inteligencia artificial.</div>
  <div class="tagrow">
    <span class="tag">Colombia · México</span>
    <span class="tag">Sin app para el cliente</span>
    <span class="tag">Sin hardware costoso</span>
    <span class="tag">IA integrada</span>
  </div>
  <div class="spacer"></div>
  <div class="footrow"><span>mesapay.co</span><span>info@mesapay.co</span></div>
</section>

<!-- 2 · Quiénes somos -->
<section class="page">
  <div class="kick">Quiénes somos</div>
  <h2>Tecnología de clase mundial,<br>hecha para nuestros restaurantes.</h2>
  <div class="about">
    <p><b>MESAPAY</b> nació de una convicción simple: los restaurantes de Latinoamérica merecen la misma
      tecnología que las grandes cadenas del mundo — sin la complejidad ni los costos que normalmente
      la acompañan.</p>
    <p>Construimos una plataforma que digitaliza el ciclo completo del servicio: el comensal ordena y paga
      desde su propio celular, la cocina recibe la comanda al instante, la factura electrónica sale sola,
      el turno cierra cuadrado y el dueño le pregunta a sus datos lo que necesita saber — en lenguaje natural,
      gracias a nuestra inteligencia artificial integrada.</p>
    <p>Operamos en <b>Colombia y México</b>, con cumplimiento local en cada país (facturación DIAN y CFDI 4.0,
      medios de pago locales) y una carta trilingüe pensada para ciudades turísticas.</p>
  </div>
  <div class="pillrow">
    <span class="pill">Restaurantes de mesa</span>
    <span class="pill">Cadenas y grupos</span>
    <span class="pill">Cafés y heladerías</span>
    <span class="pill">Bares y rooftops</span>
  </div>
  <div class="pagefoot"><img class="footlogo" src="{LOGO_LIGHT_URI}"><span>mesapay.co · info@mesapay.co</span></div>
</section>

<!-- 3 · El problema -->
<section class="page">
  <div class="kick">El problema que resolvemos</div>
  <h2>Operar un restaurante hoy es<br>más difícil que nunca.</h2>
  <div class="pgrid">
    {''.join(f'<div class="pcard"><div class="ptitle">{t}</div><div class="ptext">{d}</div></div>' for t, d in PROBLEMS)}
  </div>
  <div class="closer">Hay una forma <b>más simple</b> de hacerlo.</div>
  <div class="pagefoot"><img class="footlogo" src="{LOGO_LIGHT_URI}"><span>mesapay.co · info@mesapay.co</span></div>
</section>

<!-- 4 · Cómo funciona -->
<section class="page">
  <div class="kick">Cómo funciona</div>
  <h2>Tres pasos. Cero fricción.</h2>
  <div class="steps">
    {''.join(f'<div class="scard"><div class="snum">{n}</div><div class="stitle">{t}</div><div class="stext">{d}</div></div>' for n, t, d in STEPS)}
  </div>
  <div class="note"><b>Sin app para tus clientes. Sin equipos costosos.</b> Tu cliente usa el celular que ya
    tiene en la mano; del lado del restaurante basta una tablet en cocina y los celulares del equipo —
    nada de POS propietario ni licencias por terminal.</div>
  <div class="svc">
    <div class="svct">¿Y la buena atención? <b>Mejora.</b></div>
    <div class="svcx">MESAPAY no reemplaza a los meseros: les devuelve el tiempo. Dejan de transcribir
      pedidos y de caminar hasta el sistema, y lo dedican a lo que de verdad vende — asesorar, recomendar
      y resolver dudas en la mesa. Y si un cliente prefiere el trato de siempre, el mesero toma el pedido
      él mismo desde su app.</div>
  </div>
  <div class="pagefoot"><img class="footlogo" src="{LOGO_LIGHT_URI}"><span>mesapay.co · info@mesapay.co</span></div>
</section>

<!-- 5 · La plataforma -->
<section class="page">
  <div class="kick">La plataforma</div>
  <h2>Todo el restaurante,<br>en un solo sistema.</h2>
  <div class="fgrid">
    {''.join(feature_card(f) for f in FEATURES)}
  </div>
  <div class="pagefoot"><img class="footlogo" src="{LOGO_LIGHT_URI}"><span>mesapay.co · info@mesapay.co</span></div>
</section>

<!-- 6 · El impacto -->
<section class="page">
  <div class="kick">El impacto</div>
  <h2>Resultados que se sienten<br>desde el primer mes.</h2>
  <div class="bgrid">
    {''.join(f'<div class="bcard"><div class="bnum">{n}</div><div class="blabel">{l}</div><div class="btext">{d}</div></div>' for n, l, d in BENEFITS)}
  </div>
  <div class="fineprint">Estimaciones basadas en la operación de restaurantes piloto; el resultado real
    depende del tipo de servicio, el ticket promedio y la adopción del equipo.</div>
  <div class="pagefoot"><img class="footlogo" src="{LOGO_LIGHT_URI}"><span>mesapay.co · info@mesapay.co</span></div>
</section>

<!-- 7 · Cierre -->
<section class="page">
  <div class="kick">Conversemos</div>
  <h2 style="text-align:center; margin-top:10px">Véalo funcionando<br>con su propia carta.</h2>
  <div class="lead" style="text-align:center; margin:10px auto 0; max-width:130mm">
    En una demo de 15 minutos montamos el menú de su restaurante en la plataforma y le mostramos
    el ciclo completo: el pedido, la cocina, el pago y los datos. Sin costo y sin compromiso.</div>
  <div class="ctabox">
    <div class="glow"></div>
    <div class="ct">Agendemos una demo.</div>
    <div class="cs">Escribanos y le respondemos el mismo día hábil.</div>
    <div class="links">
      <span class="lk">info@mesapay.co</span>
      <span class="lk ghost">mesapay.co</span>
    </div>
  </div>
  <div class="pagefoot"><img class="footlogo" src="{LOGO_LIGHT_URI}"><span>MESAPAY · La carta digital de tu restaurante</span></div>
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
