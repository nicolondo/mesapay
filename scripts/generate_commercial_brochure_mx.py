#!/usr/bin/env python3
"""
Folleto comercial MESAPAY para restaurantes en México (A4 vertical, 6 páginas).
Variante MX del folleto de Colombia: precios en MXN, factura CFDI (SAT), SPEI,
ROI en pesos mexicanos y español en tuteo.

Salida: docs/MESAPAY-Presentacion-Comercial-MX.pdf
"""
import base64
import os
import subprocess
import sys

ROOT = "/Users/nicolas/Documents/APPS/MESAPAY"
LOGO_DARK = f"{ROOT}/brand-kit/_build/logo-white-on-ink.png"
LOGO_LIGHT = f"{ROOT}/brand-kit/_build/logo-on-bone.png"
BUILD_HTML = f"{ROOT}/brand-kit/_build/brochure_mx.html"
OUTPUT = f"{ROOT}/docs/MESAPAY-Presentacion-Comercial-MX.pdf"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def b64(path: str) -> str:
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode()


LOGO_DARK_URI = f"data:image/png;base64,{b64(LOGO_DARK)}"
LOGO_LIGHT_URI = f"data:image/png;base64,{b64(LOGO_LIGHT)}"


def icon(paths: str) -> str:
    return (
        '<svg viewBox="0 0 24 24" fill="none" stroke="#C9532E" '
        'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
        f"{paths}</svg>"
    )


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
    (IC_QR, "Pedido y pago por QR", "El comensal ordena y paga desde su celular, sin esperar al mesero."),
    (IC_GLOBE, "Carta digital trilingüe", "Tu menú en español, inglés y portugués — se traduce solo."),
    (IC_KDS, "Comanda a cocina y bar", "Pantallas de cocina y bar separadas, con tiempos y prioridades."),
    (IC_CAL, "Reservaciones con depósito", "Recibe reservaciones en línea y cobra un depósito para frenar los no-shows."),
    (IC_PHONE, "App del mesero", "Tus meseros toman pedidos, cobran y reciben avisos desde el celular."),
    (IC_DOC, "Factura electrónica CFDI", "Factura válida ante el SAT (CFDI 4.0), enviada al correo del cliente al instante."),
    (IC_CASH, "Corte de caja y arqueo", "Corte de caja, propinas y reportes contables al cerrar el turno."),
    (IC_BUILDING, "Multi-sucursal", "Administra varias sucursales desde un solo panel, con datos consolidados."),
    (IC_AI, "Pulso · asistente de IA", "Pregúntale a tus datos: platillos más vendidos, horas pico, mejor mesero.", True),
]


def feature_card(f) -> str:
    new = len(f) > 3 and f[3]
    badge = '<span class="newbadge">NUEVO</span>' if new else ""
    return f"""
    <div class="fcard">
      <div class="ficon">{f[0]}</div>
      <div class="fbody">
        <div class="ftitle">{f[1]}{badge}</div>
        <div class="ftext">{f[2]}</div>
      </div>
    </div>"""


PROBLEMS = [
    ("Meseros caros y escasos", "Un mesero cuesta cerca de <b>$12,000/mes</b> con prestaciones — y conseguirlos y retenerlos es cada vez más difícil."),
    ("Mesas que rotan lento", "El cliente espera para pedir, espera la cuenta y espera la terminal. Cada minuto extra es una mesa menos que rotas."),
    ("Errores y descuadres", "Comandas mal tomadas, propinas confusas y cortes de caja que no cuadran al final de la noche."),
    ("La fila para pagar", "Pagar es el momento más lento del servicio — y el que peor sabor de boca deja al cliente."),
]


def problem_card(p) -> str:
    return f"""
    <div class="pcard">
      <div class="ptitle">{p[0]}</div>
      <div class="ptext">{p[1]}</div>
    </div>"""


STEPS = [
    ("01", "Escanea", "El comensal escanea el QR de su mesa y ve tu carta al instante — con fotos, en su idioma. Sin descargar ninguna app."),
    ("02", "Ordena", "Cada persona de la mesa elige, personaliza y envía su pedido a la vez — nadie espera su turno. Va directo a cocina y bar, sin intermediarios ni malentendidos."),
    ("03", "Paga", "Paga desde el celular con tarjeta, SPEI o Apple Pay, o divide la cuenta entre varios. Recibe su factura CFDI al correo."),
]


def step_card(s) -> str:
    return f"""
    <div class="scard">
      <div class="snum">{s[0]}</div>
      <div class="stitle">{s[1]}</div>
      <div class="stext">{s[2]}</div>
    </div>"""


HTML = f"""<!doctype html><html lang="es-MX"><head><meta charset="utf-8">
<style>
  @page {{ size: A4; margin: 0; }}
  * {{ box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
  :root{{
    --bone:#F5F1EA; --paper:#FBF8F3; --cream:#EFE8DC; --ivory:#FFFDF9;
    --ink:#1A1613; --ink2:#2B2521; --ink3:#423B35; --muted:#6B6259; --muted2:#8F867C;
    --hairline:#E5DED1; --line2:#D8CFBF;
    --terra:#C9532E; --terra2:#A8401F; --terra-soft:#F0D9CB; --gold:#B8893B; --success:#2E6B4C;
    --display:'Instrument Serif',Georgia,serif;
    --sans:'Geist',ui-sans-serif,system-ui,-apple-system,sans-serif;
    --mono:'Geist Mono',ui-monospace,Menlo,monospace;
  }}
  html,body{{ margin:0; padding:0; font-family:var(--sans); color:var(--ink); background:#fff; }}
  .page{{ width:210mm; height:297mm; padding:20mm 16mm 22mm; position:relative; overflow:hidden;
          background:var(--bone); page-break-after:always;
          display:flex; flex-direction:column; justify-content:center; }}
  .page:last-child{{ page-break-after:auto; }}
  .kick{{ font-family:var(--mono); font-size:9.5px; letter-spacing:0.20em; text-transform:uppercase; color:var(--terra2); }}
  h1{{ font-family:var(--display); font-weight:400; font-size:52px; line-height:1.05; letter-spacing:-0.01em; margin:14px 0 10px; }}
  h2{{ font-family:var(--display); font-weight:400; font-size:33px; line-height:1.1; letter-spacing:-0.01em; margin:8px 0 6px; color:var(--ink); }}
  .lead{{ font-size:14px; line-height:1.6; color:var(--ink3); max-width:150mm; }}
  .pagefoot{{ position:absolute; left:16mm; right:16mm; bottom:11mm; display:flex; justify-content:space-between;
             font-family:var(--mono); font-size:8px; letter-spacing:0.14em; text-transform:uppercase;
             color:var(--muted2); border-top:1px solid var(--hairline); padding-top:7px; }}
  .footlogo{{ height:13px; opacity:0.85; }}

  .cover{{ background:var(--ink); color:var(--ivory); justify-content:flex-start; }}
  .cover .clogo{{ height:34px; width:auto; align-self:flex-start; object-fit:contain; }}
  .cover .kick{{ color:var(--terra-soft); }}
  .cover h1{{ color:#fff; font-size:58px; margin-top:18px; }}
  .cover .lead{{ color:#D8CFBF; font-size:15px; max-width:150mm; }}
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
  .pcard{{ background:var(--paper); border:1px solid var(--hairline); border-radius:16px; padding:22px 22px; }}
  .pcard .ptitle{{ font-family:var(--display); font-size:23px; color:var(--terra2); margin-bottom:7px; }}
  .pcard .ptext{{ font-size:12.5px; line-height:1.55; color:var(--ink3); }}
  .closer{{ font-family:var(--display); font-size:30px; color:var(--ink); text-align:center; margin-top:30px; }}
  .closer b{{ color:var(--terra); font-weight:400; }}

  .steps{{ display:flex; flex-direction:column; gap:16px; margin-top:26px; }}
  .scard{{ background:var(--paper); border:1px solid var(--hairline); border-radius:16px; padding:22px 26px;
           display:grid; grid-template-columns:74px 1fr; align-items:center; gap:8px 22px; }}
  .scard .snum{{ font-family:var(--display); font-size:50px; color:var(--terra); line-height:1; }}
  .scard .stitle{{ font-family:var(--display); font-size:25px; }}
  .scard .stext{{ font-size:13px; line-height:1.55; color:var(--ink3); grid-column:2; }}
  .note{{ margin-top:24px; background:var(--terra-soft); border-radius:14px; padding:16px 20px;
          font-size:12.5px; line-height:1.5; color:var(--ink2); }}
  .note b{{ color:var(--terra2); }}
  .svc{{ margin-top:14px; background:var(--paper); border:1px solid var(--hairline); border-radius:14px; padding:18px 22px; }}
  .svct{{ font-family:var(--display); font-size:22px; color:var(--ink); margin-bottom:6px; }}
  .svct b{{ color:var(--terra); font-weight:400; }}
  .svcx{{ font-size:12.5px; line-height:1.55; color:var(--ink3); }}

  .fgrid{{ display:grid; grid-template-columns:1fr 1fr; gap:13px; margin-top:22px; }}
  .fcard{{ background:var(--paper); border:1px solid var(--hairline); border-radius:14px; padding:16px 17px;
           display:grid; grid-template-columns:42px 1fr; gap:14px; align-items:start; }}
  .ficon{{ width:42px; height:42px; border-radius:11px; background:var(--terra-soft); display:flex; align-items:center; justify-content:center; }}
  .ficon svg{{ width:22px; height:22px; }}
  .ftitle{{ font-size:14px; font-weight:600; color:var(--ink); margin-bottom:3px; }}
  .ftext{{ font-size:11.5px; line-height:1.45; color:var(--muted); }}
  .newbadge{{ font-family:var(--mono); font-size:7.5px; letter-spacing:0.1em; background:var(--terra); color:#fff;
              padding:2px 6px; border-radius:999px; margin-left:7px; vertical-align:middle; }}

  .bignum{{ background:var(--ink); color:var(--ivory); border-radius:18px; padding:30px 32px; margin-top:24px; position:relative; overflow:hidden; }}
  .bignum .glow{{ position:absolute; right:-90px; top:-90px; width:280px; height:280px; border-radius:50%;
                 background:radial-gradient(circle, rgba(201,83,46,0.5), rgba(201,83,46,0) 70%); }}
  .bignum .n{{ font-family:var(--display); font-size:60px; line-height:1; color:#fff; position:relative; }}
  .bignum .nlabel{{ font-size:13.5px; line-height:1.55; color:#D8CFBF; max-width:120mm; margin-top:10px; position:relative; }}
  .example{{ background:var(--paper); border:1px solid var(--hairline); border-radius:16px; padding:24px 26px; margin-top:18px; }}
  .example .eh{{ display:flex; justify-content:space-between; align-items:baseline; margin-bottom:12px; }}
  .example .et{{ font-family:var(--display); font-size:24px; }}
  .example .epill{{ font-family:var(--mono); font-size:9.5px; letter-spacing:0.06em; background:var(--terra); color:#fff; padding:4px 11px; border-radius:999px; }}
  .elist{{ list-style:none; padding:0; margin:0; }}
  .elist li{{ font-size:12.5px; line-height:1.45; color:var(--ink3); padding:5px 0 5px 22px; position:relative; }}
  .elist li::before{{ content:"✓"; color:var(--terra); font-weight:700; position:absolute; left:0; }}
  .roi{{ margin-top:16px; border-top:1px solid var(--line2); padding-top:14px; display:flex; justify-content:space-between; align-items:baseline; }}
  .roi .rl{{ font-size:13px; color:var(--ink3); }}
  .roi .rn{{ font-family:var(--display); font-size:30px; color:var(--success); }}
  .fineprint{{ font-size:9.5px; color:var(--muted2); margin-top:14px; line-height:1.4; }}

  .pricewrap{{ text-align:center; margin-top:30px; }}
  .priceline{{ font-family:var(--display); font-size:62px; color:var(--terra); line-height:1; }}
  .pricesub{{ font-size:14px; color:var(--ink3); margin-top:12px; line-height:1.6; }}
  .promo{{ display:inline-block; margin-top:18px; background:var(--terra-soft); color:var(--terra2);
           font-size:12.5px; border-radius:999px; padding:8px 18px; }}
  .ctabox{{ background:var(--ink); color:var(--ivory); border-radius:20px; padding:40px; text-align:center; margin-top:40px; position:relative; overflow:hidden; }}
  .ctabox .glow{{ position:absolute; left:50%; top:-120px; transform:translateX(-50%); width:460px; height:300px; border-radius:50%;
                 background:radial-gradient(circle, rgba(201,83,46,0.45), rgba(201,83,46,0) 70%); }}
  .ctabox .ct{{ font-family:var(--display); font-size:38px; color:#fff; position:relative; }}
  .ctabox .cs{{ font-size:14px; color:#D8CFBF; margin-top:10px; position:relative; }}
  .ctabox .links{{ position:relative; margin-top:24px; display:flex; gap:14px; justify-content:center; flex-wrap:wrap; }}
  .ctabox .lk{{ font-family:var(--mono); font-size:13px; letter-spacing:0.04em; background:var(--terra); color:#fff;
               padding:13px 26px; border-radius:999px; }}
  .ctabox .lk.ghost{{ background:transparent; border:1px solid rgba(245,241,234,0.4); color:var(--ivory); }}
</style></head><body>

<!-- 1 · Portada -->
<section class="page cover">
  <div class="glow"></div><div class="glow2"></div>
  <img class="clogo" src="{LOGO_DARK_URI}" alt="MESAPAY">
  <div class="spacer"></div>
  <div class="kick">Carta digital · Pedido y pago por QR · Para restaurantes en México</div>
  <h1>Tu restaurante<br>vende más y<br>trabaja menos.</h1>
  <div class="lead">Tus comensales escanean, ordenan y pagan desde el celular. Liberas meseros,
    aceleras la rotación y subes el ticket promedio. Sin app, sin hardware costoso, en menos de una semana.</div>
  <div class="tagrow">
    <span class="tag">Sin app para el cliente</span>
    <span class="tag">Sin hardware costoso</span>
    <span class="tag">Factura CFDI (SAT)</span>
    <span class="tag">Pagos reales (tarjeta · SPEI)</span>
  </div>
  <div class="spacer"></div>
  <div class="footrow"><span>mesapay.co</span><span>La carta digital de tu restaurante</span></div>
</section>

<!-- 2 · El problema -->
<section class="page">
  <div class="kick">El problema</div>
  <h2>Operar un restaurante hoy es<br>más caro y más difícil que nunca.</h2>
  <div class="pgrid">
    {''.join(problem_card(p) for p in PROBLEMS)}
  </div>
  <div class="closer">Hay una forma <b>más simple</b> de hacerlo.</div>
  <div class="pagefoot"><img class="footlogo" src="{LOGO_LIGHT_URI}"><span>mesapay.co · info@mesapay.co</span></div>
</section>

<!-- 3 · Cómo funciona -->
<section class="page">
  <div class="kick">Cómo funciona</div>
  <h2>Tres pasos. Cero fricción.</h2>
  <div class="steps">
    {''.join(step_card(s) for s in STEPS)}
  </div>
  <div class="note"><b>Sin app para tus clientes. Sin equipos costosos.</b> Tu cliente usa el celular que ya
    trae en la mano; de tu lado basta una tableta en cocina y los celulares de tus meseros — nada de POS
    propietario ni licencias por terminal. Se monta sobre tu operación actual en días, no meses.</div>
  <div class="svc">
    <div class="svct">¿Y la buena atención? <b>Mejora.</b></div>
    <div class="svcx">MESAPAY no reemplaza a tus meseros: les devuelve el tiempo. Dejan de transcribir pedidos
      y de caminar hasta el sistema, y ese tiempo lo dedican a lo que de verdad vende — asesorar, recomendar
      y resolver dudas en la mesa. Y si un cliente prefiere el trato de siempre, el mesero toma el pedido
      él mismo desde su app. Más asesoría en mesa = ticket más alto.</div>
  </div>
  <div class="pagefoot"><img class="footlogo" src="{LOGO_LIGHT_URI}"><span>mesapay.co · info@mesapay.co</span></div>
</section>

<!-- 4 · La plataforma -->
<section class="page">
  <div class="kick">La plataforma</div>
  <h2>Todo lo que tu restaurante<br>necesita, en un solo lugar.</h2>
  <div class="fgrid">
    {''.join(feature_card(f) for f in FEATURES)}
  </div>
  <div class="pagefoot"><img class="footlogo" src="{LOGO_LIGHT_URI}"><span>mesapay.co · info@mesapay.co</span></div>
</section>

<!-- 5 · El retorno -->
<section class="page">
  <div class="kick">El retorno</div>
  <h2>Se paga solo desde<br>el primer mes.</h2>
  <div class="bignum">
    <div class="glow"></div>
    <div class="n">~$12,000<span style="font-size:22px;color:#D8CFBF">/mes</span></div>
    <div class="nlabel">Es lo que cuesta un mesero en México, con prestaciones. MESAPAY automatiza el pedido,
      el pago, la comanda y el corte — el equivalente al trabajo de al menos un mesero.</div>
  </div>
  <div class="example">
    <div class="eh"><div class="et">Restaurante de 30 mesas</div><div class="epill">Plan Pro</div></div>
    <ul class="elist">
      <li>Ahorro equivalente a <b>al menos 1 mesero</b> (~$12,000/mes con prestaciones).</li>
      <li>Ticket promedio <b>+10–15%</b>: venta sugerida en la carta + meseros con más tiempo para asesorar y recomendar.</li>
      <li>Rotación de mesa <b>+3–5%</b> al eliminar la espera para pedir y pagar.</li>
      <li>Menos descuadres, menos errores de comanda y cortes de caja exactos.</li>
    </ul>
    <div class="roi"><span class="rl">Retorno neto estimado</span><span class="rn">~$8,000 / mes</span></div>
  </div>
  <div class="fineprint">Estimación ilustrativa; el retorno real varía según el tamaño y la operación de cada restaurante.
    El ahorro de personal asume reasignar el equivalente a un mesero a tareas de mayor valor.</div>
  <div class="pagefoot"><img class="footlogo" src="{LOGO_LIGHT_URI}"><span>mesapay.co · info@mesapay.co</span></div>
</section>

<!-- 6 · Precio + CTA -->
<section class="page">
  <div class="kick">Empieza hoy</div>
  <div class="pricewrap">
    <div class="priceline">Desde $1,999<span style="font-size:24px;color:var(--ink3)"> / mes</span></div>
    <div class="pricesub">Sin permanencia. Listo en menos de una semana.<br>
      El plan se elige según el tamaño de tu restaurante. Precios en MXN, no incluyen IVA.</div>
    <div class="promo">★ Pago anual: hasta 20% de descuento — promo de lanzamiento</div>
  </div>
  <div class="ctabox">
    <div class="glow"></div>
    <div class="ct">Agenda una demo gratuita.</div>
    <div class="cs">Te mostramos MESAPAY funcionando con la carta de tu restaurante, sin compromiso.</div>
    <div class="links">
      <span class="lk">mesapay.co</span>
      <span class="lk ghost">info@mesapay.co</span>
    </div>
  </div>
  <div class="pagefoot"><img class="footlogo" src="{LOGO_LIGHT_URI}"><span>MESAPAY · La carta digital de tu restaurante</span></div>
</section>

</body></html>"""


def main():
    os.makedirs(os.path.dirname(BUILD_HTML), exist_ok=True)
    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    with open(BUILD_HTML, "w", encoding="utf-8") as f:
        f.write(HTML)
    if not os.path.exists(CHROME):
        print(f"Chrome no encontrado en {CHROME}", file=sys.stderr)
        sys.exit(1)
    subprocess.run([
        CHROME, "--headless", "--disable-gpu", "--no-sandbox",
        "--print-to-pdf-no-header",
        f"--print-to-pdf={OUTPUT}",
        f"file://{BUILD_HTML}",
    ], check=True, capture_output=True)
    print(f"OK → {OUTPUT}")


if __name__ == "__main__":
    main()
