"""
Genera la Propuesta Comercial para Ejecutivo Comercial de MESAPAY.

Salida: /Users/nicolas/Documents/APPS/MESAPAY/docs/Propuesta-Comercial-MESAPAY.pdf

Modelo de compensación HÍBRIDO:
- Básico mensual: $2.000.000 COP
- Bono apertura (mes 1 de cada cuenta): 75% del precio del plan
- Comisión recurrente (mes 2 al 12): 10% del precio del plan
- Sin techo de ingreso, con recurrente acumulable
"""

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageBreak, PageTemplate,
    Paragraph, Spacer, Table, TableStyle,
)

OUTPUT = "/Users/nicolas/Documents/APPS/MESAPAY/docs/Propuesta-Comercial-MESAPAY.pdf"

# Paleta MESAPAY (idéntica al gerente)
INK = colors.HexColor("#1a1a1a")
INK_2 = colors.HexColor("#3a3a3a")
INK_3 = colors.HexColor("#6b6b6b")
BONE = colors.HexColor("#f8f4ec")
HAIRLINE = colors.HexColor("#e8e2d4")
ACCENT = colors.HexColor("#c75432")
ACCENT_BG = colors.HexColor("#fae9e0")


def cop(n: int) -> str:
    return "$" + f"{n:,.0f}".replace(",", ".")


# Constantes de negocio
BASE = 2_000_000

PRECIO_ESENCIAL = 399_000
PRECIO_PRO = 899_000
PRECIO_PREMIUM = 1_599_000

PCT_APERTURA = 0.75       # 75% del precio mes 1
PCT_RECURRENTE = 0.10     # 10% del precio mes 2 al 12
MESES_RECURRENTE = 11

# Descuento por pago anual anticipado del restaurante
DESCUENTO_ANUAL_STANDARD = 0.15
DESCUENTO_ANUAL_PROMO = 0.20  # promo hasta diciembre 2026
# Comp total año 1 expresada como múltiplo del precio mensual lista:
# 75% (apertura) + 10% × 11 (recurrente) = 185%
TOTAL_ANO_1_PCT = PCT_APERTURA + PCT_RECURRENTE * MESES_RECURRENTE

MIX = [("Esencial", PRECIO_ESENCIAL, 0.50),
       ("Pro", PRECIO_PRO, 0.35),
       ("Premium", PRECIO_PREMIUM, 0.15)]


def apertura(precio: int) -> int:
    return int(precio * PCT_APERTURA)


def recurrente_mensual(precio: int) -> int:
    return int(precio * PCT_RECURRENTE)


def total_y1_por_cuenta(precio: int) -> int:
    return apertura(precio) + recurrente_mensual(precio) * MESES_RECURRENTE


def split_mix(total: int):
    e = round(total * MIX[0][2])
    p = round(total * MIX[1][2])
    pr = total - e - p
    return e, p, pr


def avg_apertura_por_cuenta() -> int:
    return int(sum(w * apertura(precio) for _, precio, w in MIX))


def avg_recurrente_mensual_por_cuenta() -> int:
    return int(sum(w * recurrente_mensual(precio) for _, precio, w in MIX))


def comercial_mes_1_mix_anual(cuentas_por_mes: int, pct_anual: float) -> int:
    """Ingreso del comercial en mes 1 según % del libro que entra como anual.
    Mensuales aportan solo 75% apertura; anuales aportan 185% liquidado upfront."""
    avg_precio = avg_apertura_por_cuenta() / PCT_APERTURA  # precio mensual promedio ponderado
    cuentas_anuales = cuentas_por_mes * pct_anual
    cuentas_mensuales = cuentas_por_mes * (1 - pct_anual)
    apertura_m = cuentas_mensuales * PCT_APERTURA * avg_precio
    liquidacion_a = cuentas_anuales * TOTAL_ANO_1_PCT * avg_precio
    return int(BASE + apertura_m + liquidacion_a)


def escenario(cuentas_por_mes: int):
    """Ingreso del comercial individual."""
    avg_ap = avg_apertura_por_cuenta()
    avg_rec = avg_recurrente_mensual_por_cuenta()
    mes_1 = BASE + cuentas_por_mes * avg_ap
    mes_ss = BASE + cuentas_por_mes * avg_ap + cuentas_por_mes * MESES_RECURRENTE * avg_rec
    # Año 1: 12 meses de base + 12 cohortes de apertura + recurring triangular (sum 11+10+...+0 = 66)
    total_y1 = BASE * 12 + cuentas_por_mes * 12 * avg_ap + cuentas_por_mes * 66 * avg_rec
    return {
        "cuentas_mes": cuentas_por_mes,
        "mes_1": mes_1,
        "mes_ss": mes_ss,
        "total_y1": total_y1,
    }


# ---------- Estilos ----------
styles = getSampleStyleSheet()

style_eyebrow = ParagraphStyle("Eyebrow", parent=styles["Normal"],
                               fontName="Helvetica-Bold", fontSize=8.5, leading=10,
                               textColor=ACCENT, alignment=TA_LEFT, spaceAfter=4)
style_title = ParagraphStyle("Title", parent=styles["Title"],
                             fontName="Helvetica-Bold", fontSize=28, leading=32,
                             textColor=INK, alignment=TA_LEFT, spaceAfter=4)
style_subtitle = ParagraphStyle("Subtitle", parent=styles["Normal"],
                                fontName="Helvetica", fontSize=12, leading=16,
                                textColor=INK_3, alignment=TA_LEFT, spaceAfter=18)
style_section = ParagraphStyle("Section", parent=styles["Heading1"],
                               fontName="Helvetica-Bold", fontSize=15, leading=20,
                               textColor=INK, alignment=TA_LEFT,
                               spaceBefore=16, spaceAfter=8)
style_h3 = ParagraphStyle("H3", parent=styles["Heading3"],
                          fontName="Helvetica-Bold", fontSize=11, leading=14,
                          textColor=INK, alignment=TA_LEFT,
                          spaceBefore=8, spaceAfter=4)
style_body = ParagraphStyle("Body", parent=styles["Normal"],
                            fontName="Helvetica", fontSize=10.5, leading=15,
                            textColor=INK_2, alignment=TA_JUSTIFY, spaceAfter=6)
style_body_left = ParagraphStyle("BodyLeft", parent=style_body, alignment=TA_LEFT)
style_bullet = ParagraphStyle("Bullet", parent=style_body,
                              leftIndent=14, bulletIndent=2, spaceAfter=3, alignment=TA_LEFT)
style_caption = ParagraphStyle("Caption", parent=styles["Normal"],
                               fontName="Helvetica-Oblique", fontSize=8.5, leading=11,
                               textColor=INK_3, alignment=TA_LEFT, spaceAfter=10)
style_th = ParagraphStyle("TableHeader", parent=styles["Normal"],
                          fontName="Helvetica-Bold", fontSize=9.5, leading=12,
                          textColor=colors.white, alignment=TA_LEFT)
style_td = ParagraphStyle("TD", parent=styles["Normal"],
                          fontName="Helvetica", fontSize=9.5, leading=12,
                          textColor=INK_2, alignment=TA_LEFT)
style_td_b = ParagraphStyle("TDB", parent=style_td, fontName="Helvetica-Bold", textColor=INK)
style_td_r = ParagraphStyle("TDR", parent=style_td, alignment=TA_RIGHT)
style_td_rb = ParagraphStyle("TDRB", parent=style_td_b, alignment=TA_RIGHT)


def hairline():
    t = Table([[""]], colWidths=[17 * cm], rowHeights=[1])
    t.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, -1), 0.5, HAIRLINE)]))
    return t


def fact_table(rows):
    data = [[Paragraph(k, style_td), Paragraph(v, style_td_rb)] for k, v in rows]
    t = Table(data, colWidths=[8.5 * cm, 8.5 * cm])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LINEBELOW", (0, 0), (-1, -2), 0.4, HAIRLINE),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
    ]))
    return t


def styled_table(data, col_widths):
    t = Table(data, colWidths=col_widths)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), INK),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [BONE, colors.white]),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, HAIRLINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    return t


def build():
    import os
    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)

    doc = BaseDocTemplate(
        OUTPUT, pagesize=letter,
        leftMargin=2.2 * cm, rightMargin=2.2 * cm,
        topMargin=2.0 * cm, bottomMargin=2.0 * cm,
        title="Propuesta Comercial · Ejecutivo Comercial · MESAPAY",
        author="MESAPAY",
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height,
                  id="main", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)

    def footer(canvas, _doc):
        canvas.saveState()
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(INK_3)
        canvas.drawString(doc.leftMargin, 1.0 * cm,
                          f"MESAPAY · Documento confidencial · Pág. {_doc.page}")
        canvas.drawRightString(letter[0] - doc.rightMargin, 1.0 * cm, "mesapay.co")
        canvas.restoreState()

    doc.addPageTemplates([PageTemplate(id="default", frames=[frame], onPage=footer)])

    story = []

    # Header
    logo = Table([[Paragraph('<font color="white"><b>MESAPAY</b></font>', styles["Normal"])]],
                 colWidths=[3.2 * cm], rowHeights=[0.9 * cm])
    logo.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), INK),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
    ]))
    story.append(logo)
    story.append(Spacer(1, 18))

    story.append(Paragraph("PROPUESTA INTERNA · APERTURA DE CUENTAS", style_eyebrow))
    story.append(Paragraph("Propuesta de colaboración", style_title))
    story.append(Paragraph("Ejecutivo Comercial · Modalidad: prestación de servicios", style_subtitle))
    story.append(hairline())
    story.append(Spacer(1, 14))

    # Stat cards
    stat_big = ParagraphStyle("StatBig", parent=styles["Normal"],
                              fontName="Helvetica-Bold", fontSize=20, leading=22,
                              textColor=ACCENT, alignment=TA_CENTER)
    stat_label = ParagraphStyle("StatLabel", parent=styles["Normal"],
                                fontName="Helvetica", fontSize=8.5, leading=11,
                                textColor=INK_3, alignment=TA_CENTER, spaceBefore=2)
    stats = Table([[
        [Paragraph("$2M", stat_big), Paragraph("básico mensual<br/>fijo", stat_label)],
        [Paragraph("75%", stat_big), Paragraph("del primer mes<br/>de cada cuenta abierta", stat_label)],
        [Paragraph("10%", stat_big), Paragraph("recurrente mensual<br/>del mes 2 al 12", stat_label)],
    ]], colWidths=[5.7 * cm, 5.7 * cm, 5.7 * cm], rowHeights=[2.2 * cm])
    stats.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), ACCENT_BG),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("BOX", (0, 0), (0, 0), 0.6, ACCENT),
        ("BOX", (1, 0), (1, 0), 0.6, ACCENT),
        ("BOX", (2, 0), (2, 0), 0.6, ACCENT),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(stats)
    story.append(Spacer(1, 18))

    # 1. En una frase
    story.append(Paragraph("1. En una frase", style_section))
    story.append(Paragraph(
        f"Buscamos un <b>Ejecutivo Comercial</b> que abra cuentas nuevas de restaurantes "
        f"para MESAPAY. La compensación combina un <b>básico fijo de "
        f"{cop(BASE)} COP/mes</b> con dos comisiones: el <b>75% del primer mes</b> de cada "
        f"cuenta que actives, y el <b>10% mensual del mes 2 al 12</b> mientras la cuenta "
        f"siga al día. Sin techo: tu ingreso crece con cada cuenta abierta y se acumula "
        f"mientras tu libro de clientes esté vivo.",
        style_body,
    ))

    # 2. Cómo ganás
    story.append(Paragraph("2. Cómo ganás — tres componentes", style_section))
    cols_data = [[
        Paragraph("<b>A · Básico fijo</b><br/><br/>"
                  f"<font color='#3a3a3a'>{cop(BASE)} COP cada mes, independiente de cuántas "
                  "cuentas abrás. Te da estabilidad para enfocarte en el cierre.</font>",
                  style_body_left),
        Paragraph("<b>B · Bono apertura</b><br/><br/>"
                  "<font color='#3a3a3a'>75% del precio mensual del plan que contrate el "
                  "restaurante. Pago único en el mes 1.</font>",
                  style_body_left),
        Paragraph("<b>C · Recurrente</b><br/><br/>"
                  "<font color='#3a3a3a'>10% del pago mensual del restaurante, del mes 2 al "
                  "12 (los 11 meses siguientes). Se acumula mientras tu libro crece.</font>",
                  style_body_left),
    ]]
    cols = Table(cols_data, colWidths=[5.7 * cm, 5.7 * cm, 5.7 * cm])
    cols.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BACKGROUND", (0, 0), (-1, -1), BONE),
        ("BOX", (0, 0), (0, 0), 0.4, HAIRLINE),
        ("BOX", (1, 0), (1, 0), 0.4, HAIRLINE),
        ("BOX", (2, 0), (2, 0), 0.4, HAIRLINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
    ]))
    story.append(cols)
    story.append(Spacer(1, 6))
    story.append(Paragraph(
        "<b>Regla de oro:</b> cada cuenta te paga <b>1,85 mensualidades del plan</b> en su "
        "primer año (75% en mes 1 + 110% repartido entre mes 2 y 12). Y mientras siga activa, "
        "tu recurrente sigue corriendo.",
        style_body,
    ))

    # 3. Fórmula
    story.append(Paragraph("3. La fórmula por cuenta", style_section))
    formula = Table([[Paragraph(
        "<b>Ingreso por cuenta (año 1)</b> = 75% × precio mensual <i>(mes 1)</i> + "
        "(10% × precio mensual × 11 meses) <i>(mes 2-12)</i> = "
        "<b>1,85 mensualidades del plan</b>",
        style_body_left)]], colWidths=[17 * cm])
    formula.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), ACCENT_BG),
        ("BOX", (0, 0), (-1, -1), 0.6, ACCENT),
        ("LEFTPADDING", (0, 0), (-1, -1), 12),
        ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
    ]))
    story.append(formula)

    # 4. Lo que ganás por plan
    story.append(Paragraph("4. Lo que ganás por cada plan", style_section))
    data = [[
        Paragraph("Plan", style_th),
        Paragraph("Precio mensual<br/>al restaurante", style_th),
        Paragraph("Bono apertura<br/>(mes 1)", style_th),
        Paragraph("Recurrente<br/>(mes 2-12)", style_th),
        Paragraph("Total año 1<br/>por cuenta", style_th),
    ]]
    for nombre, precio, _ in MIX:
        data.append([
            Paragraph(nombre, style_td_b),
            Paragraph(cop(precio), style_td_r),
            Paragraph(cop(apertura(precio)), style_td_r),
            Paragraph(cop(recurrente_mensual(precio)) + " /mes", style_td_r),
            Paragraph(cop(total_y1_por_cuenta(precio)), style_td_rb),
        ])
    story.append(styled_table(data, [3.0 * cm, 3.2 * cm, 3.2 * cm, 3.4 * cm, 3.2 * cm]))
    story.append(Paragraph(
        "Tiers por tamaño del restaurante: Esencial = hasta 20 mesas · Pro = 21 a 40 mesas · "
        "Premium = más de 40 mesas. Cifras en COP sobre suscripción.",
        style_caption,
    ))

    # === 4.1 Descuento al cliente por pago anual ===
    story.append(Spacer(1, 6))
    story.append(Paragraph(
        "4.1 Descuento al cliente por pago anual anticipado", style_h3,
    ))
    story.append(Paragraph(
        "Tenés autorizado ofrecerle al restaurante un <b>descuento sobre la lista cuando "
        "paga el año por adelantado</b>. Es una herramienta de cierre poderosa — y para "
        "vos, además, significa cobrar todo el año en el mes 1.",
        style_body,
    ))
    story.append(Paragraph(
        "<b>Descuento estándar: 15%</b> &nbsp;·&nbsp; permanente.",
        style_bullet, bulletText="·",
    ))
    story.append(Paragraph(
        "<b>Promo de lanzamiento: 20%</b> &nbsp;·&nbsp; hasta el <b>31 de diciembre 2026</b>. "
        "Aprovechala para cerrar más rápido este semestre.",
        style_bullet, bulletText="·",
    ))
    story.append(Spacer(1, 4))
    # Tabla precios cliente
    data = [
        [Paragraph("Plan", style_th),
         Paragraph("Pago mensual<br/>(lista)", style_th),
         Paragraph("Pago anual<br/>(–15%)", style_th),
         Paragraph("Pago anual con promo<br/>(–20%)", style_th)],
    ]
    for nombre, precio, _ in MIX:
        anual_lista = precio * 12
        anual_15 = int(anual_lista * 0.85)
        anual_20 = int(anual_lista * 0.80)
        data.append([
            Paragraph(nombre, style_td_b),
            Paragraph(cop(precio) + "/mes", style_td_r),
            Paragraph(cop(anual_15) + "/año", style_td_r),
            Paragraph(cop(anual_20) + "/año", style_td_rb),
        ])
    story.append(styled_table(data, [2.8 * cm, 3.7 * cm, 3.7 * cm, 4.8 * cm]))
    story.append(Paragraph(
        "El descuento sale del margen de MESAPAY. Tu comisión se calcula siempre sobre el "
        "precio de lista (sin descuento) — no perdés un peso por vender anual.",
        style_caption,
    ))

    # === 4.2 Comisión sobre pago anual ===
    story.append(Spacer(1, 10))
    story.append(Paragraph("4.2 Tu comisión sobre cuentas anuales", style_h3))
    story.append(Paragraph(
        "Cuando cerrás una cuenta con modalidad anual, tu comisión completa del año 1 se "
        "<b>liquida en el mes 1</b>, calculada sobre el precio de lista mensual:",
        style_body,
    ))
    story.append(Paragraph(
        "<b>Comisión anual liquidada en mes 1 = 185% del precio mensual de lista</b> "
        "&nbsp;=&nbsp; 75% (apertura) + 10% × 11 (recurrente). Toda junta, en el mes 1.",
        style_bullet, bulletText="·",
    ))
    story.append(Spacer(1, 4))
    data = [
        [Paragraph("Plan", style_th),
         Paragraph("Camino mensual<br/>(comisión goteando año 1)", style_th),
         Paragraph("Camino anual<br/>(toda liquidada en mes 1)", style_th)],
    ]
    for nombre, precio, _ in MIX:
        total = total_y1_por_cuenta(precio)
        total_anual = int(precio * TOTAL_ANO_1_PCT)
        data.append([
            Paragraph(nombre, style_td_b),
            Paragraph(cop(total), style_td_r),
            Paragraph(cop(total_anual), style_td_rb),
        ])
    story.append(styled_table(data, [3.2 * cm, 6.9 * cm, 6.9 * cm]))
    story.append(Paragraph(
        "Mismo total — distinto momento. Cerrar un Premium anual te pone "
        "$2.958.150 en el bolsillo en el mes 1, vs $1.199.250 (apertura) + 11 cuotas "
        "mensuales de $159.900. Y eliminás el riesgo de que el cliente se caiga en el "
        "mes 4 y pierdas el resto del recurrente.",
        style_caption,
    ))

    story.append(PageBreak())

    # 5. Escenarios
    story.append(Paragraph("5. Escenarios de ingreso mensual", style_section))
    story.append(Paragraph(
        "Tu ingreso depende de cuántas cuentas abrás por mes. Asumimos una mezcla típica "
        "del pipeline de <b>50% Esencial · 35% Pro · 15% Premium</b>. Se muestran tres "
        "puntos: <b>mes 1</b> (solo base + apertura, sin recurrente todavía), "
        "<b>mes 12 en steady state</b> (libro completo, todas las cohortes recurrentes activas) "
        "y <b>total acumulado del año 1</b>.",
        style_body,
    ))

    escenarios = [escenario(n) for n in [2, 4, 6, 8, 10]]
    data = [[
        Paragraph("Cuentas<br/>nuevas/mes", style_th),
        Paragraph("Mes 1<br/>(libro vacío)", style_th),
        Paragraph("Mes 12+<br/>(steady state)", style_th),
        Paragraph("Total<br/>año 1", style_th),
    ]]
    for e in escenarios:
        data.append([
            Paragraph(f"{e['cuentas_mes']} cuentas/mes", style_td),
            Paragraph(cop(e["mes_1"]), style_td_r),
            Paragraph(cop(e["mes_ss"]), style_td_r),
            Paragraph(cop(e["total_y1"]), style_td_rb),
        ])
    story.append(styled_table(data, [4.0 * cm, 4.0 * cm, 4.5 * cm, 4.5 * cm]))
    story.append(Paragraph(
        "Mezcla 50/35/15 sobre Esencial/Pro/Premium. El recurrente tarda 12 meses en alcanzar "
        "steady state — el primer año tu ingreso crece mes a mes mientras tu libro de clientes "
        "se va construyendo.",
        style_caption,
    ))

    # === 5.1 Cash flow con anuales en el mix ===
    story.append(Paragraph(
        "5.1 Cash flow según % de cuentas anuales que cierres", style_h3,
    ))
    story.append(Paragraph(
        "La tabla anterior asume todas las cuentas mensuales. Si empujás la modalidad anual, "
        "tu ingreso en el <b>mes 1</b> sube fuerte — porque cobrás el 185% del precio "
        "mensual de lista de una sola vez por cada cuenta anual que cierres.",
        style_body,
    ))
    story.append(Paragraph(
        "Tomando 4 cuentas/mes (mezcla 50/35/15 entre tiers):",
        style_body,
    ))
    data = [
        [Paragraph("% del libro anual", style_th),
         Paragraph("Cuentas mensuales<br/>(solo 75% apertura)", style_th),
         Paragraph("Cuentas anuales<br/>(185% liquidado)", style_th),
         Paragraph("Tu ingreso mes 1", style_th)],
    ]
    for pct in [0.0, 0.30, 0.50, 0.70, 1.0]:
        cuentas_m = int(round(4 * (1 - pct)))
        cuentas_a = 4 - cuentas_m
        ingreso = comercial_mes_1_mix_anual(4, pct)
        pct_label = f"{int(pct * 100)}%"
        data.append([
            Paragraph(pct_label, style_td_b),
            Paragraph(f"{cuentas_m}", style_td_r),
            Paragraph(f"{cuentas_a}", style_td_r),
            Paragraph(cop(ingreso), style_td_rb),
        ])
    story.append(styled_table(data, [3.2 * cm, 4.2 * cm, 4.2 * cm, 4.4 * cm]))
    story.append(Paragraph(
        "Pasar de 0% a 30% anual te sube el mes 1 de $4,26M a $5,26M (+23%). Y en 100% anual, "
        "tu mes 1 alcanza inmediatamente los $7,58M — el mismo nivel que el camino mensual "
        "tarda 12 meses en alcanzar. Cobrás antes y eliminás el riesgo de que la cuenta se "
        "caiga en el mes 4 y pierdas el resto del recurrente.",
        style_caption,
    ))

    # 6. Reglas claras
    story.append(Paragraph("6. Reglas claras (para que no haya sorpresas)", style_section))
    for r in [
        "<b>Venta válida:</b> cuenta activada en MESAPAY y con su primer pago recibido.",
        "<b>Liquidación:</b> las comisiones se pagan mensualmente, dentro de los primeros 5 días hábiles del mes siguiente, sobre los pagos efectivamente cobrados al restaurante.",
        "<b>Base de cálculo:</b> los porcentajes (75% y 10%) se calculan sobre la suscripción mensual del local (no sobre impuestos ni sobre el markup de pagos), salvo acuerdo escrito distinto.",
        "<b>Vigencia del recurrente:</b> la comisión cubre el primer año — 75% del mes 1 + 10% del mes 2 al 12. Al mes 13 finaliza la comisión sobre esa cuenta.",
        "<b>Permanencia y clawback:</b> si una cuenta cancela o deja de pagar, se suspende su recurrente. Si se cae dentro de los primeros 60 días, el bono de apertura se descuenta de comisiones futuras.",
        "<b>Descuento autorizado al cliente:</b> podés ofrecer 15% off por pago anual (permanente) o 20% off durante la promo de lanzamiento (hasta 31 de diciembre 2026). Sin necesidad de aprobación adicional. El descuento sale del margen de MESAPAY.",
        "<b>Comisión sobre anuales:</b> cuando el cliente paga anual, recibís el 185% del precio mensual de lista liquidado en el mes 1 (mismo total que el camino mensual, pero todo upfront). Tu base de cálculo es siempre el precio de lista, no el precio con descuento.",
        "<b>Clawback en anuales:</b> si una cuenta anual cancela y solicita reembolso dentro de los primeros 90 días, se descuenta proporcionalmente la comisión ya liquidada de futuras liquidaciones.",
        "<b>Tus cuentas son tuyas:</b> las cuentas que abrís quedan asignadas a vos para efectos de comisión durante todo el primer año.",
        "<b>MESAPAY te respalda:</b> demo, material comercial, lista de precios y acompañamiento del Gerente Comercial en el onboarding del restaurante.",
    ]:
        story.append(Paragraph(r, style_bullet, bulletText="•"))

    # 7. Naturaleza de la relación
    story.append(Paragraph("7. Naturaleza de la relación", style_section))
    story.append(Paragraph(
        "Esta es una relación de <b>prestación de servicios profesionales</b>. El básico fijo "
        f"de {cop(BASE)} COP/mes corresponde a la contraprestación por tu disponibilidad "
        "exclusiva y cumplimiento de metas comerciales — no constituye salario laboral. Cada "
        "parte asume sus propias obligaciones tributarias. Se formaliza mediante contrato "
        "escrito.",
        style_body,
    ))
    story.append(Paragraph(
        "Nota: las cifras proyectadas son ilustrativas. Antes de firmar, validá los términos "
        "fiscales y legales con tu contador o abogado.",
        style_caption,
    ))

    # 8. Por qué te conviene
    story.append(Paragraph("8. Por qué te conviene", style_section))
    for b in [
        "<b>Estabilidad + upside:</b> básico fijo que te asegura piso, comisión sin techo que te asegura crecimiento.",
        "<b>Renta recurrente:</b> cada cuenta que abrís te paga 11 meses adicionales, no solo una vez.",
        "<b>Ingreso que se acumula:</b> en 12 meses tu libro de clientes está completo — los meses siguientes recibís base + apertura del mes + recurrente acumulado de todo el libro.",
        "<b>Producto que se vende solo en demo:</b> carta digital QR, pedido y pago, comanda automática, reservas, facturación electrónica — todo integrado.",
        "<b>Respaldo de un equipo:</b> el Gerente Comercial te acompaña en demos clave, te da seguimiento semanal y mejora tu proceso.",
        "<b>Arranque inmediato:</b> sin cuota de entrada; empezás a generar desde la primera cuenta.",
    ]:
        story.append(Paragraph(b, style_bullet, bulletText="•"))

    # 9. Próximos pasos
    story.append(Paragraph("9. Próximos pasos", style_section))
    for i, p in enumerate([
        "Entrevista con el Gerente Comercial para alinear visión y territorio.",
        "Firma del contrato de prestación de servicios.",
        "Acceso a la demo, lista de precios, CRM y material de ventas.",
        "Definición de meta del primer mes y arranque en territorio.",
    ], 1):
        story.append(Paragraph(f"<b>{i}.</b> {p}", style_bullet, bulletText="·"))

    story.append(Spacer(1, 18))
    story.append(hairline())
    story.append(Spacer(1, 8))
    story.append(Paragraph(
        "Esta propuesta es confidencial y de uso exclusivo del destinatario. Las cifras "
        "de escenarios son ilustrativas; los ingresos reales dependen de tu desempeño y de "
        "la retención de las cuentas. Condiciones sujetas a negociación.",
        style_caption,
    ))
    story.append(Spacer(1, 22))

    firma = Table([
        [Paragraph("_______________________________", style_body_left),
         Paragraph("_______________________________", style_body_left)],
        [Paragraph("<b>Acepta — Ejecutivo Comercial</b>", style_body_left),
         Paragraph("<b>Por MESAPAY</b>", style_body_left)],
        [Paragraph("Nombre y documento · Fecha", style_caption),
         Paragraph("Nicolás · Dirección General · Fecha", style_caption)],
    ], colWidths=[8.5 * cm, 8.5 * cm])
    firma.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(firma)

    doc.build(story)
    print(f"OK -> {OUTPUT}")


if __name__ == "__main__":
    build()
