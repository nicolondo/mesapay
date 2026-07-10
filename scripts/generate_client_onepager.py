"""
One-pager comercial dirigido al cliente (restaurante).

Salida: /Users/nicolas/Documents/APPS/MESAPAY/docs/MESAPAY-Planes-y-Precios.pdf

Es el documento que el ejecutivo comercial le entrega al dueño del restaurante
después de la demo. Muestra los 3 planes lado a lado, con precios mensuales
y anuales (con descuento), features por tier y un CTA claro.
"""

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.platypus import (
    Image,
    BaseDocTemplate, Frame, PageBreak, PageTemplate,
    Paragraph, Spacer, Table, TableStyle,
)

OUTPUT = "/Users/nicolas/Documents/APPS/MESAPAY/docs/MESAPAY-Planes-y-Precios.pdf"

# Paleta MESAPAY
INK = colors.HexColor("#1a1a1a")
INK_2 = colors.HexColor("#3a3a3a")
INK_3 = colors.HexColor("#6b6b6b")
BONE = colors.HexColor("#f8f4ec")
HAIRLINE = colors.HexColor("#e8e2d4")
ACCENT = colors.HexColor("#c75432")
ACCENT_BG = colors.HexColor("#fae9e0")
PROMO_BG = colors.HexColor("#fff8e8")
PROMO_BORDER = colors.HexColor("#d6a55b")
GREEN_OK = colors.HexColor("#2d6a5a")

DESCUENTO_ANUAL = 0.15
DESCUENTO_PROMO = 0.20


def cop(n: int) -> str:
    return "$" + f"{n:,.0f}".replace(",", ".")


# Datos de los planes
PLANES = [
    {
        "nombre": "Esencial",
        "tagline": "Para 1 local, hasta 20 mesas",
        "precio_mensual": 399_000,
        "destacado": False,
        "features": [
            "Carta digital trilingüe (es / en / pt)",
            "Pedido y pago por QR desde el celular",
            "Comanda automática a cocina (1 estación)",
            "Facturación electrónica DIAN",
            "Cierre de turno digital",
            "Reportes diarios por correo",
            "Soporte WhatsApp en horario hábil",
        ],
    },
    {
        "nombre": "Pro",
        "tagline": "El plan más elegido · 21 a 40 mesas",
        "precio_mensual": 899_000,
        "destacado": True,
        "features": [
            "Todo lo del plan Esencial, más:",
            "Múltiples menús (comida + vinos + bebidas)",
            "Reservas con depósito en línea",
            "Cocina y bar separados · multi-estación",
            "App nativa para el mesero",
            "Reportes avanzados (rotación, ticket promedio, ventas por hora)",
            "Soporte WhatsApp prioritario",
        ],
    },
    {
        "nombre": "Premium",
        "tagline": "Cadenas o más de 40 mesas",
        "precio_mensual": 1_599_000,
        "destacado": False,
        "features": [
            "Todo lo del plan Pro, más:",
            "Multi-sucursal (hasta 3 sedes)",
            "Account manager dedicado",
            "Onboarding asistido en sitio",
            "Branding completo (logo, colores, dominio)",
            "Soporte 24/7 + número directo",
            "Integración con tu POS existente",
        ],
    },
]


def precio_anual(precio_mensual: int, descuento: float = DESCUENTO_ANUAL) -> int:
    return int(precio_mensual * 12 * (1 - descuento))


def precio_anual_mensualizado(precio_mensual: int, descuento: float = DESCUENTO_ANUAL) -> int:
    return int(precio_mensual * (1 - descuento))


def ahorro_anual(precio_mensual: int, descuento: float = DESCUENTO_ANUAL) -> int:
    return int(precio_mensual * 12 * descuento)


# ---------- Estilos ----------
styles = getSampleStyleSheet()

style_eyebrow = ParagraphStyle("Eyebrow", parent=styles["Normal"],
                               fontName="Helvetica-Bold", fontSize=9, leading=11,
                               textColor=ACCENT, alignment=TA_LEFT, spaceAfter=4)
style_eyebrow_c = ParagraphStyle("EyebrowC", parent=style_eyebrow, alignment=TA_CENTER)
style_hero = ParagraphStyle("Hero", parent=styles["Title"],
                            fontName="Helvetica-Bold", fontSize=26, leading=29,
                            textColor=INK, alignment=TA_LEFT, spaceAfter=4)
style_hero_sub = ParagraphStyle("HeroSub", parent=styles["Normal"],
                                fontName="Helvetica", fontSize=12, leading=16,
                                textColor=INK_2, alignment=TA_LEFT, spaceAfter=8)
style_section = ParagraphStyle("Section", parent=styles["Heading1"],
                               fontName="Helvetica-Bold", fontSize=15, leading=20,
                               textColor=INK, alignment=TA_LEFT,
                               spaceBefore=14, spaceAfter=8)
style_body = ParagraphStyle("Body", parent=styles["Normal"],
                            fontName="Helvetica", fontSize=10.5, leading=15,
                            textColor=INK_2, alignment=TA_JUSTIFY, spaceAfter=6)
style_body_l = ParagraphStyle("BodyL", parent=style_body, alignment=TA_LEFT)
style_caption = ParagraphStyle("Caption", parent=styles["Normal"],
                               fontName="Helvetica-Oblique", fontSize=8.5, leading=11,
                               textColor=INK_3, alignment=TA_LEFT, spaceAfter=8)
style_plan_name = ParagraphStyle("PlanName", parent=styles["Normal"],
                                 fontName="Helvetica-Bold", fontSize=18, leading=22,
                                 textColor=INK, alignment=TA_LEFT, spaceAfter=2)
style_plan_tagline = ParagraphStyle("PlanTag", parent=styles["Normal"],
                                    fontName="Helvetica", fontSize=9, leading=12,
                                    textColor=INK_3, alignment=TA_LEFT, spaceAfter=6)
style_price_big = ParagraphStyle("PriceBig", parent=styles["Normal"],
                                 fontName="Helvetica-Bold", fontSize=22, leading=26,
                                 textColor=INK, alignment=TA_LEFT, spaceAfter=2)
style_price_period = ParagraphStyle("PricePeriod", parent=styles["Normal"],
                                    fontName="Helvetica", fontSize=9, leading=12,
                                    textColor=INK_3, alignment=TA_LEFT, spaceAfter=4)
style_price_annual = ParagraphStyle("PriceAnnual", parent=styles["Normal"],
                                    fontName="Helvetica-Bold", fontSize=10, leading=13,
                                    textColor=GREEN_OK, alignment=TA_LEFT, spaceAfter=2)
style_price_save = ParagraphStyle("PriceSave", parent=styles["Normal"],
                                  fontName="Helvetica", fontSize=8.5, leading=11,
                                  textColor=INK_3, alignment=TA_LEFT, spaceAfter=6)
style_feature = ParagraphStyle("Feature", parent=styles["Normal"],
                               fontName="Helvetica", fontSize=9, leading=12,
                               textColor=INK_2, alignment=TA_LEFT, spaceAfter=3,
                               leftIndent=12, bulletIndent=2)
style_feature_first = ParagraphStyle("FeatureFirst", parent=style_feature,
                                     fontName="Helvetica-Bold", textColor=INK)


def hairline(width_cm: float = 4.5):
    # Ancho acotado al interior de la tarjeta (≈card − padding) para que el
    # separador NO se extienda a lo ancho de toda la página al apilar 3 cards.
    t = Table([[""]], colWidths=[width_cm * cm], rowHeights=[1])
    t.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, -1), 0.5, HAIRLINE)]))
    return t


def plan_card(plan: dict, width_cm: float) -> Table:
    """Una tarjeta vertical con: nombre, tagline, precio mensual, precio anual, ahorro, features."""
    rows = []

    # Header del plan
    rows.append([Paragraph(plan["nombre"], style_plan_name)])
    rows.append([Paragraph(plan["tagline"], style_plan_tagline)])

    # Precio mensual
    rows.append([Paragraph(f"{cop(plan['precio_mensual'])}", style_price_big)])
    rows.append([Paragraph("/mes · pago mensual", style_price_period)])

    # Precio anual con descuento
    pa_mensualizado = precio_anual_mensualizado(plan["precio_mensual"])
    pa_total = precio_anual(plan["precio_mensual"])
    ahorro = ahorro_anual(plan["precio_mensual"])
    rows.append([Paragraph(
        f"{cop(pa_mensualizado)}/mes <font size='8'>· pago anual</font>",
        style_price_annual,
    )])
    rows.append([Paragraph(
        f"({cop(pa_total)} al año · ahorrás {cop(ahorro)})",
        style_price_save,
    )])

    # Hairline separador
    rows.append([hairline()])

    # Features
    for i, f in enumerate(plan["features"]):
        st = style_feature_first if i == 0 else style_feature
        rows.append([Paragraph(("· " if i > 0 else "") + f, st)])

    # Construir tabla vertical
    card = Table(rows, colWidths=[width_cm * cm])
    bg = ACCENT_BG if plan["destacado"] else BONE
    border = ACCENT if plan["destacado"] else HAIRLINE
    border_w = 1.2 if plan["destacado"] else 0.5
    card.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("BOX", (0, 0), (-1, -1), border_w, border),
        ("LEFTPADDING", (0, 0), (-1, -1), 14),
        ("RIGHTPADDING", (0, 0), (-1, -1), 14),
        ("TOPPADDING", (0, 0), (-1, -1), 2.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    return card


def build():
    import os
    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)

    doc = BaseDocTemplate(
        OUTPUT, pagesize=letter,
        leftMargin=1.8 * cm, rightMargin=1.8 * cm,
        topMargin=1.4 * cm, bottomMargin=1.4 * cm,
        title="MESAPAY · Planes y precios",
        author="MESAPAY",
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height,
                  id="main", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)

    def footer(canvas, _doc):
        canvas.saveState()
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(INK_3)
        canvas.drawString(doc.leftMargin, 1.0 * cm,
                          f"MESAPAY · La carta digital de tu restaurante · Pág. {_doc.page}")
        canvas.drawRightString(letter[0] - doc.rightMargin, 1.0 * cm,
                               "mesapay.co · info@mesapay.co")
        canvas.restoreState()

    doc.addPageTemplates([PageTemplate(id="default", frames=[frame], onPage=footer)])

    story = []

    # === HERO ===
    logo = Image("/Users/nicolas/Documents/APPS/MESAPAY/brand-kit/_build/logo-on-white.png",
                 width=4.4 * cm, height=4.4 * cm / 3.71)
    logo.hAlign = "LEFT"
    story.append(logo)
    story.append(Spacer(1, 12))

    story.append(Paragraph("PLANES Y PRECIOS · COLOMBIA · 2026", style_eyebrow))
    story.append(Paragraph("La carta digital que<br/>transforma tu restaurante.", style_hero))
    story.append(Paragraph(
        "Tus comensales escanean el QR de la mesa, ven tu carta en su idioma, ordenan desde "
        "el celular y pagan al final. Vos liberás meseros, acelerás la rotación y vendés "
        "más por mesa. Sin descargar app, sin hardware costoso, en menos de una semana.",
        style_hero_sub,
    ))

    # === Promo banner ===
    promo = Table([[Paragraph(
        "<b><font color='#c75432'>Promo de lanzamiento · hasta diciembre 2026:</font></b> "
        f"&nbsp;<b>{int(DESCUENTO_PROMO*100)}% de descuento</b> en cualquier plan con pago anual. "
        "Después del 31 de diciembre, el descuento por pago anual será del "
        f"{int(DESCUENTO_ANUAL*100)}%.",
        style_body_l,
    )]], colWidths=[17.4 * cm])
    promo.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), PROMO_BG),
        ("LINEBEFORE", (0, 0), (-1, -1), 4, PROMO_BORDER),
        ("LEFTPADDING", (0, 0), (-1, -1), 12),
        ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    story.append(promo)
    story.append(Spacer(1, 12))

    # === Tres tarjetas de planes ===
    cards_row = Table(
        [[plan_card(p, 5.6) for p in PLANES]],
        colWidths=[5.8 * cm, 5.8 * cm, 5.8 * cm],
    )
    cards_row.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
    ]))
    story.append(cards_row)
    story.append(Spacer(1, 10))
    story.append(Paragraph(
        "Precios en COP, no incluyen IVA. El plan se elige según el tamaño del restaurante. "
        "Para cadenas con más de 3 sucursales, cotización a medida.",
        style_caption,
    ))

    story.append(PageBreak())

    # === Página 2: ROI + Cómo arrancar ===
    story.append(Paragraph("PARA EL DUEÑO DEL RESTAURANTE", style_eyebrow))
    story.append(Paragraph("¿Cuánto ahorra MESAPAY en tu operación?", style_hero))
    story.append(Spacer(1, 6))

    story.append(Paragraph(
        "El cálculo es simple. Un mesero en Colombia cuesta <b>~$3.000.000 COP/mes</b> "
        "cuando sumás el salario base, prestaciones sociales (cesantías, prima, vacaciones, "
        "intereses), aportes a seguridad social (salud, pensión, ARL) y parafiscales (SENA, "
        "ICBF, Caja de Compensación). MESAPAY automatiza el pedido, el pago, la comanda a "
        "cocina y el cierre — el equivalente al trabajo de mínimo un mesero. "
        "<b>Incluso el plan Premium se paga solo desde el mes 1.</b>",
        style_body,
    ))

    story.append(Spacer(1, 6))
    # Cuadro con cálculo ilustrativo
    roi = Table([[
        Paragraph("<b>Restaurante de 30 mesas</b><br/>"
                  "Plan recomendado: <b>Pro</b><br/>"
                  "Costo mensual: <b>$899.000</b><br/>"
                  "<font color='#6b6b6b' size='8'>Pago anual con 15% off: $763.150/mes equivalente</font>",
                  style_body_l),
        Paragraph("<b>Lo que ganás</b><br/>"
                  "· Ahorro mínimo equivalente a 1 mesero (~$3M/mes con prestaciones)<br/>"
                  "· Aumento de ticket promedio 10-15% (cross-sell automático)<br/>"
                  "· +3-5% de rotación de mesa por tiempos más cortos<br/>"
                  "· Cero filas en la caja, cero errores de pedido<br/>"
                  "· <b>ROI neto: ~$2,1M/mes recuperados</b> (ahorro − costo del plan)",
                  style_body_l),
    ]], colWidths=[8.5 * cm, 8.9 * cm])
    roi.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), BONE),
        ("BOX", (0, 0), (-1, -1), 0.4, HAIRLINE),
        ("LINEAFTER", (0, 0), (0, 0), 0.4, HAIRLINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 14),
        ("RIGHTPADDING", (0, 0), (-1, -1), 14),
        ("TOPPADDING", (0, 0), (-1, -1), 12),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
    ]))
    story.append(roi)
    story.append(Spacer(1, 4))
    story.append(Paragraph(
        "Estimaciones basadas en restaurantes piloto. El resultado real depende del "
        "ticket promedio, tipo de servicio y nivel de adopción del personal.",
        style_caption,
    ))

    # === Comparativo Mensual vs Anual ===
    story.append(Paragraph("Mensual vs. anual — la cuenta clara", style_section))
    story.append(Paragraph(
        "Pagar el año por adelantado te da <b>2,4 meses gratis</b> durante la promo de "
        "lanzamiento (o <b>1,8 meses gratis</b> después de diciembre 2026):",
        style_body,
    ))

    th_style = ParagraphStyle("TH2", parent=styles["Normal"],
                              fontName="Helvetica-Bold", fontSize=9.5, leading=12,
                              textColor=colors.white, alignment=TA_LEFT)
    td_style = ParagraphStyle("TD2", parent=styles["Normal"],
                              fontName="Helvetica", fontSize=9.5, leading=12,
                              textColor=INK_2, alignment=TA_LEFT)
    td_b = ParagraphStyle("TDB2", parent=td_style, fontName="Helvetica-Bold", textColor=INK)
    td_r = ParagraphStyle("TDR2", parent=td_style, alignment=TA_RIGHT)
    td_rb = ParagraphStyle("TDRB2", parent=td_b, alignment=TA_RIGHT)
    td_green = ParagraphStyle("TDG", parent=td_rb, textColor=GREEN_OK)

    data = [[
        Paragraph("Plan", th_style),
        Paragraph("Mensual", th_style),
        Paragraph("Anual (15% off)", th_style),
        Paragraph("Anual con promo (20% off)", th_style),
        Paragraph("Ahorrás con promo", th_style),
    ]]
    for p in PLANES:
        pm = p["precio_mensual"]
        pa15 = precio_anual(pm, 0.15)
        pa20 = precio_anual(pm, 0.20)
        ahorro20 = ahorro_anual(pm, 0.20)
        data.append([
            Paragraph(p["nombre"], td_b),
            Paragraph(cop(pm) + "/mes", td_r),
            Paragraph(cop(pa15) + "/año", td_r),
            Paragraph(cop(pa20) + "/año", td_rb),
            Paragraph(cop(ahorro20), td_green),
        ])

    t = Table(data, colWidths=[2.5 * cm, 3.2 * cm, 3.6 * cm, 4.2 * cm, 3.5 * cm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), INK),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [BONE, colors.white]),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, HAIRLINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    story.append(t)
    story.append(Paragraph(
        "Cifras en COP, no incluyen IVA. Promo válida hasta el 31 de diciembre de 2026.",
        style_caption,
    ))

    # === Cómo arrancar ===
    story.append(Paragraph("Cómo arrancar — 3 pasos", style_section))

    pasos_data = []
    for i, (titulo, desc) in enumerate([
        ("Demo de 30 min",
         "Te mostramos MESAPAY funcionando con tu carta. Sin compromiso."),
        ("Onboarding en una semana",
         "Subimos tu carta, configuramos cocina y bar, generamos los QR para cada mesa, entrenamos al equipo."),
        ("Primer día en vivo",
         "Estamos contigo el día del lanzamiento — soporte en vivo durante el primer servicio."),
    ], 1):
        num = Paragraph(f"<font size='20' color='#c75432'><b>{i}</b></font>", style_body_l)
        contenido = Paragraph(f"<b>{titulo}</b><br/><font color='#3a3a3a'>{desc}</font>", style_body_l)
        pasos_data.append([num, contenido])

    pasos = Table(pasos_data, colWidths=[1.2 * cm, 16.2 * cm])
    pasos.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
    ]))
    story.append(pasos)

    # === CTA final ===
    story.append(Spacer(1, 10))
    cta = Table([[Paragraph(
        "<b><font size='14' color='#1a1a1a'>¿Listo para empezar?</font></b><br/><br/>"
        "<font color='#3a3a3a'>Hablá con tu ejecutivo MESAPAY o escribinos a "
        "<b>info@mesapay.co</b>. Te respondemos el mismo día hábil.</font>",
        style_body_l,
    )]], colWidths=[17.4 * cm])
    cta.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), ACCENT_BG),
        ("BOX", (0, 0), (-1, -1), 1.2, ACCENT),
        ("LEFTPADDING", (0, 0), (-1, -1), 16),
        ("RIGHTPADDING", (0, 0), (-1, -1), 16),
        ("TOPPADDING", (0, 0), (-1, -1), 16),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 16),
    ]))
    story.append(cta)

    doc.build(story)
    print(f"OK -> {OUTPUT}")


if __name__ == "__main__":
    build()
