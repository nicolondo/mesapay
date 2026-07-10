# -*- coding: utf-8 -*-
"""Genera el HTML del Brand Kit de MESAPAY (luego Chrome lo imprime a PDF)."""
import os, html

ROOT = "/Users/nicolas/Documents/APPS/MESAPAY"
KIT = os.path.join(ROOT, "brand-kit")

def read_svg_inline(path, prefix):
    s = open(path, "r", encoding="utf-8").read()
    # quitar la declaración <?xml ... ?>
    if s.lstrip().startswith("<?xml"):
        s = s.split("?>", 1)[1]
    # Los <style> dentro de un SVG NO están scopeados: si inlineamos dos SVGs
    # con las mismas clases (.st0..st3), el último gana para AMBOS. Renombramos
    # las clases con un prefijo único por logo para evitar la colisión.
    for i in range(4):
        s = s.replace(f"st{i}", f"{prefix}{i}")
    s = s.replace('id="Layer_1"', f'id="Layer_{prefix}"')
    return s.strip()

ICON = "file://" + os.path.join(KIT, "logos", "MESAPAY-icono-512.png")
logo_light = read_svg_inline(os.path.join(KIT, "logos", "MESAPAY-logo.svg"), "la")
logo_dark  = read_svg_inline(os.path.join(KIT, "logos", "MESAPAY-logo-fondo-oscuro.svg"), "lb")

# ---- Paleta (nombre, hex, rol) ----
GROUPS = [
    ("Marca", "#C9532E", [
        ("Terracota", "#C9532E", "Color primario. Botones, enlaces, acentos."),
        ("Terracota oscuro", "#A8401F", "Hover y estados activos."),
        ("Terracota suave", "#F0D9CB", "Fondos de acento, badges, resaltados."),
    ]),
    ("Tinta / Texto", "#1A1613", [
        ("Tinta", "#1A1613", "Texto principal (negro cálido)."),
        ("Tinta 2", "#2B2521", "Titulares secundarios."),
        ("Tinta 3", "#423B35", "Texto sobre fondos claros."),
        ("Apagado", "#6B6259", "Texto secundario."),
        ("Apagado 2", "#8F867C", "Terciario / placeholders."),
    ]),
    ("Fondos / Neutros", "#F5F1EA", [
        ("Hueso", "#F5F1EA", "Fondo principal."),
        ("Papel", "#FBF8F3", "Tarjetas y superficies."),
        ("Crema", "#EFE8DC", "Fondos alternos."),
        ("Marfil", "#FFFDF9", "Superficie más clara."),
        ("Línea", "#E5DED1", "Bordes sutiles."),
        ("Línea 2", "#D8CFBF", "Divisores."),
    ]),
    ("Secundarios", "#5C6B3B", [
        ("Oliva", "#5C6B3B", "Acento natural / orgánico."),
        ("Oro", "#B8893B", "Acento premium."),
    ]),
    ("Semánticos", "#2E6B4C", [
        ("Éxito", "#2E6B4C", "Confirmaciones, pagado."),
        ("Atención", "#C98A2E", "Avisos, pendiente."),
        ("Error", "#B23A2E", "Errores, rechazos."),
    ]),
]

def luminance(hexc):
    h = hexc.lstrip("#")
    r,g,b = int(h[0:2],16), int(h[2:4],16), int(h[4:6],16)
    return (0.299*r + 0.587*g + 0.114*b)

def swatch(name, hexc, role):
    txt = "#1A1613" if luminance(hexc) > 150 else "#FBF8F3"
    bord = "border:1px solid #E5DED1;" if luminance(hexc) > 235 else ""
    return f"""
    <div class="sw">
      <div class="chip" style="background:{hexc};color:{txt};{bord}">{hexc}</div>
      <div class="sw-name">{html.escape(name)}</div>
      <div class="sw-role">{html.escape(role)}</div>
    </div>"""

def group_block(title, accent, items):
    chips = "".join(swatch(n,h,r) for (n,h,r) in items)
    return f"""
    <div class="grp">
      <div class="grp-h"><span class="dot" style="background:{accent}"></span>{html.escape(title)}</div>
      <div class="grid">{chips}</div>
    </div>"""

colors_html = "".join(group_block(t,a,items) for (t,a,items) in GROUPS)

HTML = f"""<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root{{
    --bone:#F5F1EA; --paper:#FBF8F3; --ink:#1A1613; --ink3:#423B35;
    --muted:#6B6259; --hairline:#E5DED1; --terra:#C9532E; --terra2:#A8401F;
    --display:'Instrument Serif',Georgia,serif;
    --sans:'Geist',ui-sans-serif,system-ui,sans-serif;
    --mono:'Geist Mono',ui-monospace,Menlo,monospace;
  }}
  @page {{ size: Letter; margin: 0; }}
  * {{ box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
  html,body{{ margin:0; padding:0; font-family:var(--sans); color:var(--ink); background:var(--bone); }}
  .page{{ width:8.5in; height:11in; padding:0.62in 0.62in 0.5in; position:relative; overflow:hidden; page-break-after:always; background:var(--bone); }}
  .page:last-child{{ page-break-after:auto; }}
  .kick{{ font-family:var(--mono); font-size:9px; letter-spacing:0.18em; text-transform:uppercase; color:var(--muted); }}
  h1{{ font-family:var(--display); font-weight:400; font-size:46px; line-height:1.04; letter-spacing:-0.01em; margin:6px 0 4px; }}
  h2{{ font-family:var(--display); font-weight:400; font-size:27px; letter-spacing:-0.01em; margin:0 0 2px; }}
  .lead{{ font-size:13px; line-height:1.5; color:var(--ink3); max-width:6.4in; }}
  .foot{{ position:absolute; left:0.62in; right:0.62in; bottom:0.34in; display:flex; justify-content:space-between;
          font-family:var(--mono); font-size:7.5px; letter-spacing:0.14em; text-transform:uppercase; color:var(--muted);
          border-top:1px solid var(--hairline); padding-top:6px; }}
  .rule{{ height:1px; background:var(--hairline); margin:14px 0; }}

  /* Cover */
  .cover{{ display:flex; flex-direction:column; justify-content:center; }}
  .cover .logo{{ width:3.7in; }}
  .cover .logo svg{{ width:100%; height:auto; display:block; }}
  .cover h1{{ font-size:40px; margin-top:30px; }}

  /* Logo page */
  .panel{{ border:1px solid var(--hairline); border-radius:16px; padding:26px; display:flex; align-items:center; justify-content:center; }}
  .panel.light{{ background:var(--paper); }}
  .panel.dark{{ background:var(--ink); border-color:var(--ink); }}
  .panel svg{{ width:2.9in; height:auto; display:block; }}
  .two{{ display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:10px; }}
  .cap{{ font-family:var(--mono); font-size:8px; letter-spacing:0.14em; text-transform:uppercase; color:var(--muted); margin-top:7px; }}
  .mark-row{{ display:flex; gap:14px; align-items:center; margin-top:16px; }}
  .mark-row img{{ height:74px; width:74px; border-radius:14px; }}
  .donts{{ display:grid; grid-template-columns:1fr 1fr; gap:8px 22px; margin-top:8px; font-size:11.5px; color:var(--ink3); line-height:1.45; }}
  .ok::before{{ content:"✓"; color:var(--terra); font-weight:700; margin-right:7px; }}
  .no::before{{ content:"✕"; color:#B23A2E; font-weight:700; margin-right:7px; }}

  /* Colors */
  .grp{{ margin-top:13px; }}
  .grp-h{{ font-family:var(--mono); font-size:9px; letter-spacing:0.16em; text-transform:uppercase; color:var(--ink3); margin-bottom:7px; display:flex; align-items:center; }}
  .dot{{ width:9px; height:9px; border-radius:50%; display:inline-block; margin-right:8px; }}
  .grid{{ display:grid; grid-template-columns:repeat(6,1fr); gap:8px; }}
  .sw .chip{{ height:46px; border-radius:9px; display:flex; align-items:flex-end; padding:6px 7px; font-family:var(--mono); font-size:8.5px; letter-spacing:0.02em; }}
  .sw-name{{ font-size:10px; font-weight:600; margin-top:5px; }}
  .sw-role{{ font-size:8.2px; color:var(--muted); line-height:1.25; margin-top:1px; }}
  .note{{ font-size:9.5px; color:var(--muted); font-style:italic; margin-top:12px; }}

  /* Type */
  .type-block{{ border:1px solid var(--hairline); border-radius:14px; padding:18px 20px; margin-top:12px; background:var(--paper); }}
  .type-meta{{ display:flex; justify-content:space-between; align-items:baseline; }}
  .type-name{{ font-size:15px; font-weight:600; }}
  .type-tag{{ font-family:var(--mono); font-size:8px; letter-spacing:0.14em; text-transform:uppercase; color:var(--terra2); }}
  .sample-serif{{ font-family:var(--display); font-size:40px; line-height:1.05; letter-spacing:-0.01em; margin:8px 0 2px; }}
  .sample-sans{{ font-family:var(--sans); font-size:17px; line-height:1.5; margin:8px 0 2px; max-width:6.2in; }}
  .sample-mono{{ font-family:var(--mono); font-size:14px; letter-spacing:0.06em; margin:8px 0 2px; }}
  .weights{{ font-family:var(--sans); font-size:13px; color:var(--ink3); margin-top:4px; }}
  .weights b.w4{{font-weight:400}} .weights b.w5{{font-weight:500}} .weights b.w6{{font-weight:600}} .weights b.w7{{font-weight:700}}
  .glyph{{ font-family:var(--display); font-size:13px; color:var(--muted); letter-spacing:0.06em; margin-top:4px; }}
  .use{{ font-size:10.5px; color:var(--muted); margin-top:6px; }}

  /* Canva steps */
  ol.steps{{ font-size:12.5px; line-height:1.6; color:var(--ink3); padding-left:18px; }}
  ol.steps b{{ color:var(--ink); }}
  .card{{ border:1px solid var(--hairline); border-radius:12px; padding:14px 16px; margin-top:10px; background:var(--paper); font-size:11.5px; color:var(--ink3); line-height:1.5; }}
  .card a{{ color:var(--terra2); }}
  .pill{{ display:inline-block; font-family:var(--mono); font-size:9px; letter-spacing:0.08em; background:var(--terra); color:#FBF8F3; padding:3px 8px; border-radius:999px; }}
</style></head><body>

<!-- COVER -->
<section class="page cover">
  <div class="logo">{logo_light}</div>
  <h1>Brand Kit</h1>
  <p class="lead">Identidad visual de MESAPAY: logo, colores y tipografías para usar en Canva y en cualquier pieza de marca. Pedido y pago desde la mesa, sin fricción.</p>
  <div class="foot"><span>MESAPAY · Brand Kit</span><span>Junio 2026</span></div>
</section>

<!-- LOGO -->
<section class="page">
  <div class="kick">01 · Logo</div>
  <h2>El logo</h2>
  <p class="lead">El lockup horizontal es la versión principal. Usá el reverso sobre fondos oscuros. Dejá siempre aire alrededor (mínimo la altura del icono) y nunca lo deformes.</p>
  <div class="two">
    <div><div class="panel light">{logo_light}</div><div class="cap">Principal · sobre fondo claro (Hueso / Papel)</div></div>
    <div><div class="panel dark">{logo_dark}</div><div class="cap">Reverso · sobre fondo oscuro (Tinta)</div></div>
  </div>
  <div class="mark-row">
    <img src="{ICON}" alt="icono">
    <div style="font-size:11.5px;color:var(--ink3);line-height:1.5;max-width:4.6in">
      <b>Isotipo.</b> El cuadro con la “M” serif y el acento terracota funciona solo como avatar, favicon o foto de perfil cuando el espacio es chico. Disponible en PNG 192 y 512&nbsp;px.
    </div>
  </div>
  <div class="rule"></div>
  <div class="donts">
    <div class="ok">Sobre Hueso, Papel o Tinta.</div>
    <div class="no">No cambiar los colores del logo.</div>
    <div class="ok">Respetar el área de seguridad.</div>
    <div class="no">No estirar ni rotar.</div>
    <div class="ok">Reverso sobre fotos oscuras.</div>
    <div class="no">No agregar sombras ni contornos.</div>
  </div>
  <div class="foot"><span>MESAPAY · Brand Kit</span><span>01 · Logo</span></div>
</section>

<!-- COLORS -->
<section class="page">
  <div class="kick">02 · Color</div>
  <h2>Paleta</h2>
  <p class="lead">Paleta cálida tipo papel con un acento terracota. La <b>Terracota</b> es el color de marca; los neutros (Hueso, Papel, Tinta) sostienen casi todo.</p>
  {colors_html}
  <p class="note">Nota: el archivo del logo usa una terracota un punto más cálida (#C55B3B) y tinta #161311; si vas a igualar colores pegados al logo, podés usar esos. El estándar del sistema es #C9532E / #1A1613.</p>
  <div class="foot"><span>MESAPAY · Brand Kit</span><span>02 · Color</span></div>
</section>

<!-- TYPE -->
<section class="page">
  <div class="kick">03 · Tipografía</div>
  <h2>Tipografías</h2>
  <p class="lead">Tres familias, todas gratuitas (Google Fonts). Serif para titulares con carácter; un grotesque neutro para la interfaz; y su mono para etiquetas y montos.</p>

  <div class="type-block">
    <div class="type-meta"><span class="type-name">Instrument Serif</span><span class="type-tag">Display · titulares</span></div>
    <div class="sample-serif">La carta · Mesapay</div>
    <div class="glyph">A a B b G g Q q &nbsp; 0 1 2 3 4 5 6 7 8 9 &nbsp; $ &amp; ?</div>
    <div class="use">Para títulos, el nombre del producto y números grandes (totales). Peso regular, tracking ajustado.</div>
  </div>

  <div class="type-block">
    <div class="type-meta"><span class="type-name">Geist</span><span class="type-tag">Sans · interfaz y texto</span></div>
    <div class="sample-sans">Pedí y pagá desde la mesa escaneando un QR. Sin app, sin filas.</div>
    <div class="weights"><b class="w4">Regular 400</b> · <b class="w5">Medium 500</b> · <b class="w6">Semibold 600</b> · <b class="w7">Bold 700</b></div>
    <div class="use">Texto de interfaz, párrafos, botones. Es la tipografía de trabajo del producto.</div>
  </div>

  <div class="type-block">
    <div class="type-meta"><span class="type-name">Geist Mono</span><span class="type-tag">Mono · etiquetas y datos</span></div>
    <div class="sample-mono">MESA 1 · DELIRIO RESTAURANTE&nbsp;&nbsp;·&nbsp;&nbsp;$43.890</div>
    <div class="use">Etiquetas en mayúscula con tracking, códigos, montos y datos tabulares (números alineados).</div>
  </div>
  <div class="foot"><span>MESAPAY · Brand Kit</span><span>03 · Tipografía</span></div>
</section>

<!-- CANVA -->
<section class="page">
  <div class="kick">04 · Canva</div>
  <h2>Cómo cargarlo en Canva</h2>
  <p class="lead">En Canva: <b>Marca → Kit de marca</b> (Brand Kit). Necesitás Canva Pro para subir fuentes y guardar varios logos.</p>
  <ol class="steps">
    <li><b>Logos.</b> Subí los archivos de <span class="pill">logos/</span>: el PNG principal, el de fondo oscuro y el isotipo. Si tu plan acepta SVG, subí también los <b>.svg</b> (escalan sin perder calidad).</li>
    <li><b>Colores.</b> En “Colores de marca”, agregá los HEX de la página 02 (o pegá los de <span class="pill">colores.txt</span>). Empezá por los 6 principales: Terracota, Terracota oscuro, Tinta, Hueso, Papel, Apagado.</li>
    <li><b>Fuentes.</b> Buscá <b>Instrument Serif</b> en la librería de Canva (ya está). Para <b>Geist</b> y <b>Geist Mono</b>, descargá los .ttf de Google Fonts y subilos en “Fuentes de la marca”.</li>
  </ol>
  <div class="card">
    <b>Descarga de fuentes (gratis, licencia abierta):</b><br>
    Instrument Serif — <a>fonts.google.com/specimen/Instrument+Serif</a><br>
    Geist — <a>fonts.google.com/specimen/Geist</a><br>
    Geist Mono — <a>fonts.google.com/specimen/Geist+Mono</a><br>
    <span style="color:var(--muted)">En cada página: botón “Get font” / “Download all” → descargás el .zip con los .ttf.</span>
  </div>
  <div class="card">
    <b>Contenido del kit (carpeta brand-kit):</b><br>
    <span class="pill">logos/</span> logo (PNG+SVG), reverso, isotipo 192/512, .ai &nbsp; · &nbsp;
    <span class="pill">colores.txt</span> lista de HEX &nbsp; · &nbsp;
    <span class="pill">MESAPAY-Brand-Kit.pdf</span> esta guía.
  </div>
  <div class="foot"><span>MESAPAY · Brand Kit</span><span>04 · Canva</span></div>
</section>

</body></html>"""

os.makedirs(os.path.join(KIT, "_build"), exist_ok=True)
out = os.path.join(KIT, "_build", "brandkit.html")
open(out, "w", encoding="utf-8").write(HTML)
print("HTML ->", out)
