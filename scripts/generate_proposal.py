"""
Genera la Propuesta Comercial para Gerente Comercial de MESAPAY.

Salida: /Users/nicolas/Documents/APPS/MESAPAY/Propuesta_Gerente_Comercial.pdf

Modelo de compensación:
- Básico mensual: $3.000.000 COP
- Override apertura (mes 1 de cada cuenta del equipo): 25% del precio del plan
- Override recurrente (mes 2 al 12 de cada cuenta): 2.5% del precio del plan
- Sin techo de ingreso
"""

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

OUTPUT = "/Users/nicolas/Documents/APPS/MESAPAY/docs/Propuesta-Gerente-Comercial-MESAPAY.pdf"

# ---------- Paleta de marca MESAPAY (cálida, editorial) ----------
INK = colors.HexColor("#1a1a1a")
INK_2 = colors.HexColor("#3a3a3a")
INK_3 = colors.HexColor("#6b6b6b")
BONE = colors.HexColor("#f8f4ec")
HAIRLINE = colors.HexColor("#e8e2d4")
ACCENT = colors.HexColor("#c75432")
ACCENT_BG = colors.HexColor("#fae9e0")


def cop(n: int) -> str:
    return "$" + f"{n:,.0f}".replace(",", ".")


# ---------- Constantes de negocio ----------
BASE_GERENTE = 3_000_000
BASE_COMERCIAL = 2_000_000

PRECIO_ESENCIAL = 399_000     # hasta 20 mesas
PRECIO_PRO = 899_000          # 21 a 40 mesas
PRECIO_PREMIUM = 1_599_000    # más de 40 mesas

# Split: 75% comercial / 25% gerente, aplicado a apertura Y recurrente
PCT_GERENTE_APERTURA = 0.25
PCT_COMERCIAL_APERTURA = 0.75
PCT_GERENTE_RECURRENTE = 0.025  # 2.5% (25% del 10% recurrente del comercial)
PCT_COMERCIAL_RECURRENTE = 0.10

MESES_RECURRENTE = 11  # mes 2 al 12

# Descuento por pago anual anticipado
DESCUENTO_ANUAL_STANDARD = 0.15  # 15% estándar
DESCUENTO_ANUAL_PROMO = 0.20     # 20% promo de lanzamiento (hasta diciembre 2026)
# Comp total año 1 expresada como múltiplo del precio mensual lista:
# Gerente: 25% (apertura) + 2.5% × 11 (recurrente) = 52.5%
GERENTE_TOTAL_ANO_1_PCT = PCT_GERENTE_APERTURA + PCT_GERENTE_RECURRENTE * MESES_RECURRENTE


def override_apertura(precio: int) -> int:
    return int(precio * PCT_GERENTE_APERTURA)


def override_recurrente_mensual(precio: int) -> int:
    return int(precio * PCT_GERENTE_RECURRENTE)


# ---------- Estilos ----------
styles = getSampleStyleSheet()

style_eyebrow = ParagraphStyle(
    "Eyebrow",
    parent=styles["Normal"],
    fontName="Helvetica-Bold",
    fontSize=8.5,
    leading=10,
    textColor=ACCENT,
    alignment=TA_LEFT,
    spaceAfter=4,
)

style_title = ParagraphStyle(
    "Title",
    parent=styles["Title"],
    fontName="Helvetica-Bold",
    fontSize=28,
    leading=32,
    textColor=INK,
    alignment=TA_LEFT,
    spaceAfter=4,
)

style_subtitle = ParagraphStyle(
    "Subtitle",
    parent=styles["Normal"],
    fontName="Helvetica",
    fontSize=12,
    leading=16,
    textColor=INK_3,
    alignment=TA_LEFT,
    spaceAfter=18,
)

style_section = ParagraphStyle(
    "Section",
    parent=styles["Heading1"],
    fontName="Helvetica-Bold",
    fontSize=15,
    leading=20,
    textColor=INK,
    alignment=TA_LEFT,
    spaceBefore=16,
    spaceAfter=8,
)

style_h3 = ParagraphStyle(
    "H3",
    parent=styles["Heading3"],
    fontName="Helvetica-Bold",
    fontSize=11,
    leading=14,
    textColor=INK,
    alignment=TA_LEFT,
    spaceBefore=8,
    spaceAfter=4,
)

style_body = ParagraphStyle(
    "Body",
    parent=styles["Normal"],
    fontName="Helvetica",
    fontSize=10.5,
    leading=15,
    textColor=INK_2,
    alignment=TA_JUSTIFY,
    spaceAfter=6,
)

style_body_left = ParagraphStyle("BodyLeft", parent=style_body, alignment=TA_LEFT)

style_bullet = ParagraphStyle(
    "Bullet",
    parent=style_body,
    leftIndent=14,
    bulletIndent=2,
    spaceAfter=3,
    alignment=TA_LEFT,
)

style_caption = ParagraphStyle(
    "Caption",
    parent=styles["Normal"],
    fontName="Helvetica-Oblique",
    fontSize=8.5,
    leading=11,
    textColor=INK_3,
    alignment=TA_LEFT,
    spaceAfter=10,
)

style_th = ParagraphStyle(
    "TableHeader",
    parent=styles["Normal"],
    fontName="Helvetica-Bold",
    fontSize=9.5,
    leading=12,
    textColor=colors.white,
    alignment=TA_LEFT,
)

style_td = ParagraphStyle(
    "TD",
    parent=styles["Normal"],
    fontName="Helvetica",
    fontSize=9.5,
    leading=12,
    textColor=INK_2,
    alignment=TA_LEFT,
)

style_td_b = ParagraphStyle("TDB", parent=style_td, fontName="Helvetica-Bold", textColor=INK)
style_td_r = ParagraphStyle("TDR", parent=style_td, alignment=TA_RIGHT)
style_td_rb = ParagraphStyle("TDRB", parent=style_td_b, alignment=TA_RIGHT)


# ---------- Helpers ----------
def hairline() -> Table:
    t = Table([[""]], colWidths=[17 * cm], rowHeights=[1])
    t.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, -1), 0.5, HAIRLINE)]))
    return t


def fact_table(rows):
    data = [[Paragraph(k, style_td), Paragraph(v, style_td_rb)] for k, v in rows]
    t = Table(data, colWidths=[8.5 * cm, 8.5 * cm])
    t.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LINEBELOW", (0, 0), (-1, -2), 0.4, HAIRLINE),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ]
        )
    )
    return t


def styled_table(data, col_widths, highlight_last_row=False):
    """Tabla con header oscuro, filas alternadas en bone, opcional fila destacada al final."""
    t = Table(data, colWidths=col_widths)
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), INK),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [BONE, colors.white]),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, HAIRLINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]
    if highlight_last_row:
        style.append(("LINEABOVE", (0, -1), (-1, -1), 0.8, INK))
    t.setStyle(TableStyle(style))
    return t


# ---------- Cálculos de escenarios ----------
# Mix por defecto del pipeline (basado en mercado SMB Colombia)
MIX = [("Esencial", PRECIO_ESENCIAL, 0.50),
       ("Pro", PRECIO_PRO, 0.35),
       ("Premium", PRECIO_PREMIUM, 0.15)]


def split_mix(total: int):
    """Reparte `total` cuentas entre los 3 tiers según MIX, garantizando suma exacta."""
    esencial = round(total * MIX[0][2])
    pro = round(total * MIX[1][2])
    premium = total - esencial - pro
    return esencial, pro, premium


def avg_precio_mensual() -> float:
    return sum(w * precio for _, precio, w in MIX)


def gerente_mes_1_mix_anual(num_reps: int, cuentas_por_rep: int, pct_anual: float) -> int:
    """Ingreso del Gerente en el mes 1 cuando un % del libro entra en modalidad anual.
    Las cuentas mensuales aportan solo apertura (25%) y las anuales aportan el 52,5% completo
    del año liquidado upfront."""
    cuentas_total = num_reps * cuentas_por_rep
    avg_precio = avg_precio_mensual()
    cuentas_anuales = cuentas_total * pct_anual
    cuentas_mensuales = cuentas_total * (1 - pct_anual)
    apertura_mensual = cuentas_mensuales * PCT_GERENTE_APERTURA * avg_precio
    liquidacion_anual = cuentas_anuales * GERENTE_TOTAL_ANO_1_PCT * avg_precio
    return int(BASE_GERENTE + apertura_mensual + liquidacion_anual)


def escenario_gerente(num_reps: int, cuentas_por_rep: int):
    """Devuelve dict con ingreso mes 1, mes 12+ (steady state), y total año 1."""
    nuevas_por_mes = num_reps * cuentas_por_rep
    e, p, pr = split_mix(nuevas_por_mes)
    apertura_mes = (
        e * override_apertura(PRECIO_ESENCIAL)
        + p * override_apertura(PRECIO_PRO)
        + pr * override_apertura(PRECIO_PREMIUM)
    )
    recurrente_por_cuenta_mes_mix = (
        (e / nuevas_por_mes if nuevas_por_mes else 0) * override_recurrente_mensual(PRECIO_ESENCIAL)
        + (p / nuevas_por_mes if nuevas_por_mes else 0) * override_recurrente_mensual(PRECIO_PRO)
        + (pr / nuevas_por_mes if nuevas_por_mes else 0) * override_recurrente_mensual(PRECIO_PREMIUM)
    )
    # Steady state: las 11 cohortes anteriores siguen recurriendo
    recurring_ss = int(nuevas_por_mes * MESES_RECURRENTE * recurrente_por_cuenta_mes_mix)
    mes_1 = BASE_GERENTE + apertura_mes  # sin recurring (todavía no hay cohortes activas)
    mes_ss = BASE_GERENTE + apertura_mes + recurring_ss
    # Total año 1: base × 12 + apertura × 12 + recurring acumulado (suma triangular)
    # Cohorte mes N aporta (12 - N) meses de recurring en año 1; suma de (11,10,...,0) = 66
    recurring_y1 = int(nuevas_por_mes * 66 * recurrente_por_cuenta_mes_mix)
    total_y1 = BASE_GERENTE * 12 + apertura_mes * 12 + recurring_y1
    return {
        "reps": num_reps,
        "cuentas_mes": nuevas_por_mes,
        "mes_1": mes_1,
        "mes_ss": mes_ss,
        "total_y1": total_y1,
        "apertura_mes": apertura_mes,
        "recurring_ss": recurring_ss,
    }


# ---------- Construcción del documento ----------
def build():
    doc = BaseDocTemplate(
        OUTPUT,
        pagesize=letter,
        leftMargin=2.2 * cm,
        rightMargin=2.2 * cm,
        topMargin=2.0 * cm,
        bottomMargin=2.0 * cm,
        title="Propuesta Comercial · Gerente Comercial · MESAPAY",
        author="MESAPAY",
    )
    frame = Frame(
        doc.leftMargin, doc.bottomMargin, doc.width, doc.height,
        id="main", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0,
    )

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

    # === Header con block de marca ===
    # MESAPAY logo (block negro con texto blanco)
    logo = Table([[Paragraph('<font color="white"><b>MESAPAY</b></font>', styles["Normal"])]],
                 colWidths=[3.2 * cm], rowHeights=[0.9 * cm])
    logo.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), INK),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
    ]))
    story.append(logo)
    story.append(Spacer(1, 18))

    story.append(Paragraph("PROPUESTA INTERNA · LIDERAZGO COMERCIAL", style_eyebrow))
    story.append(Paragraph("Propuesta de colaboración", style_title))
    story.append(Paragraph("Gerente Comercial · Modalidad: prestación de servicios", style_subtitle))
    story.append(hairline())
    story.append(Spacer(1, 14))

    # === Stat cards ===
    stat_card_style = ParagraphStyle("StatBig", parent=styles["Normal"],
                                     fontName="Helvetica-Bold", fontSize=20, leading=22,
                                     textColor=ACCENT, alignment=TA_CENTER)
    stat_label = ParagraphStyle("StatLabel", parent=styles["Normal"],
                                fontName="Helvetica", fontSize=8.5, leading=11,
                                textColor=INK_3, alignment=TA_CENTER, spaceBefore=2)
    stats = Table([[
        [Paragraph("$3M", stat_card_style), Paragraph("básico mensual<br/>fijo", stat_label)],
        [Paragraph("25%", stat_card_style), Paragraph("override sobre<br/>cuentas del equipo (mes 1)", stat_label)],
        [Paragraph("2,5%", stat_card_style), Paragraph("override recurrente<br/>mes 2 al 12", stat_label)],
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

    # === 1. Sobre MESAPAY ===
    story.append(Paragraph("1. Sobre MESAPAY", style_section))
    story.append(Paragraph(
        "MESAPAY es una plataforma SaaS para restaurantes que digitaliza la operación de mesa "
        "completa: carta trilingüe (es/en/pt), pedido y pago por QR, comanda automática a "
        "cocina y bar, reservas con depósito, facturación electrónica y reportes. El comensal "
        "no descarga nada — escanea el código en la mesa y opera todo desde su celular. "
        "El producto está validado en restaurantes piloto y estamos en la etapa de expansión "
        "comercial agresiva en Colombia.",
        style_body,
    ))

    # === 2. El rol ===
    story.append(Paragraph("2. El rol", style_section))
    story.append(Paragraph(
        "Buscamos un <b>Gerente Comercial</b> que construya, lidere y haga crecer al equipo "
        "de Ejecutivos Comerciales encargados de la venta directa a restaurantes. Es el "
        "responsable directo del crecimiento del MRR (ingreso mensual recurrente).",
        style_body,
    ))
    story.append(Paragraph("Responsabilidades principales:", style_h3))
    for b in [
        "Reclutar, entrenar y liderar al equipo de comerciales bajo su cargo.",
        "Definir y ejecutar la estrategia de prospección y cierre de cuentas nuevas.",
        "Hacer seguimiento semanal del pipeline de cada comercial.",
        "Acompañar demos y cierres clave cuando se requiera.",
        "Garantizar la retención de las cuentas activas del equipo.",
        "Reportar resultados semanales a la dirección.",
    ]:
        story.append(Paragraph(b, style_bullet, bulletText="•"))

    # === 3. Compensación ===
    story.append(Paragraph("3. Estructura de compensación", style_section))
    story.append(Paragraph(
        "Tres componentes acumulables, <b>sin techo</b>: básico fijo, override de apertura "
        "(una vez por cuenta activada), y override recurrente (mes 2 al 12 mientras la cuenta "
        "siga al día). El último componente alinea al Gerente con la retención del libro de "
        "clientes — si las cuentas se caen, su recurrente se cae.",
        style_body,
    ))

    story.append(Paragraph("3.1 Básico mensual", style_h3))
    story.append(fact_table([
        ("Modalidad de contratación", "Prestación de servicios"),
        ("Básico mensual fijo", cop(BASE_GERENTE) + " COP"),
        ("Periodicidad de pago", "Mensual"),
    ]))

    story.append(Spacer(1, 10))
    story.append(Paragraph("3.2 Override sobre cuentas del equipo", style_h3))
    story.append(Paragraph(
        "Por cada cuenta que abra un comercial bajo su cargo:",
        style_body,
    ))
    story.append(Paragraph(
        "<b>Mes 1 — Apertura:</b> el Gerente recibe el <b>25%</b> del precio mensual del plan "
        "contratado. El 75% restante es para el comercial.",
        style_bullet, bulletText="·",
    ))
    story.append(Paragraph(
        "<b>Mes 2 al 12 — Recurrente:</b> el Gerente recibe el <b>2,5%</b> mensual del precio "
        "del plan, mientras la cuenta siga activa y al día. El comercial recibe el 10% sobre "
        "la misma base.",
        style_bullet, bulletText="·",
    ))

    story.append(Spacer(1, 6))
    # Tabla por plan
    data = [
        [Paragraph("Plan", style_th),
         Paragraph("Precio mensual", style_th),
         Paragraph("Override apertura<br/>(mes 1, una vez)", style_th),
         Paragraph("Override recurrente<br/>(mes 2 al 12)", style_th),
         Paragraph("Total año 1<br/>por cuenta", style_th)],
    ]
    for nombre, precio, _ in MIX:
        ap = override_apertura(precio)
        rec = override_recurrente_mensual(precio)
        total = ap + rec * MESES_RECURRENTE
        data.append([
            Paragraph(nombre, style_td_b),
            Paragraph(cop(precio), style_td_r),
            Paragraph(cop(ap), style_td_r),
            Paragraph(cop(rec) + " /mes", style_td_r),
            Paragraph(cop(total), style_td_rb),
        ])
    story.append(styled_table(data, [3.0 * cm, 2.9 * cm, 3.4 * cm, 3.5 * cm, 3.3 * cm]))
    story.append(Paragraph(
        "Tiers según tamaño del restaurante: Esencial = hasta 20 mesas · "
        "Pro = 21 a 40 mesas · Premium = más de 40 mesas. "
        "Cifras en COP, sobre suscripción (no incluye markup de pagos).",
        style_caption,
    ))

    # === 3.3 Descuento por pago anual (oferta al cliente) ===
    story.append(Spacer(1, 10))
    story.append(Paragraph(
        "3.3 Descuento al cliente por pago anual anticipado", style_h3,
    ))
    story.append(Paragraph(
        "El equipo comercial tiene autorizado ofrecer al restaurante un descuento sobre la "
        "lista cuando el cliente paga el año por adelantado. Hay dos niveles:",
        style_body,
    ))
    story.append(Paragraph(
        "<b>Descuento estándar: 15%</b> &nbsp;·&nbsp; permanente, aplica todo el año.",
        style_bullet, bulletText="·",
    ))
    story.append(Paragraph(
        "<b>Promo de lanzamiento: 20%</b> &nbsp;·&nbsp; vigente hasta el "
        "<b>31 de diciembre 2026</b>. Después vuelve al 15%.",
        style_bullet, bulletText="·",
    ))
    story.append(Spacer(1, 4))
    # Tabla precios al cliente
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
        "El descuento sale del margen de MESAPAY. Las comisiones del equipo se calculan "
        "siempre sobre el precio de lista (sin aplicar el descuento), de modo que vendér "
        "anual no afecta lo que cobrás vos ni tu equipo.",
        style_caption,
    ))

    # === 3.4 Override sobre cuentas anuales (la mecánica de comisión) ===
    story.append(Spacer(1, 10))
    story.append(Paragraph("3.4 Override sobre cuentas con pago anual", style_h3))
    story.append(Paragraph(
        "Cuando una cuenta entra con modalidad anual, el override completo del año "
        "1 se <b>liquida al Gerente en el mes 1</b>, calculado sobre el precio mensual "
        "de lista (no se aplica el descuento que recibió el cliente):",
        style_body,
    ))
    story.append(Paragraph(
        "<b>Override anual liquidado en mes 1 = 52,5% del precio mensual de lista</b> "
        "&nbsp;=&nbsp; 25% (apertura) + 2,5% × 11 (recurrente).",
        style_bullet, bulletText="·",
    ))
    story.append(Spacer(1, 4))
    # Tabla comparativa para el gerente
    data = [
        [Paragraph("Plan", style_th),
         Paragraph("Camino mensual<br/>(override repartido año 1)", style_th),
         Paragraph("Camino anual<br/>(liquidado todo en mes 1)", style_th)],
    ]
    for nombre, precio, _ in MIX:
        ap = override_apertura(precio)
        rec = override_recurrente_mensual(precio)
        total_mensual = ap + rec * MESES_RECURRENTE
        total_anual = int(precio * GERENTE_TOTAL_ANO_1_PCT)
        data.append([
            Paragraph(nombre, style_td_b),
            Paragraph(cop(total_mensual), style_td_r),
            Paragraph(cop(total_anual), style_td_rb),
        ])
    story.append(styled_table(data, [3.2 * cm, 6.9 * cm, 6.9 * cm]))
    story.append(Paragraph(
        "Mismo total, distinto momento. Cobrás todo el año 1 upfront cuando el cliente "
        "elige anual — esto te incentiva activamente a empujar esa modalidad. "
        "Clawback: si la cuenta cancela en los primeros 90 días, se descuenta la parte "
        "proporcional de liquidaciones futuras.",
        style_caption,
    ))

    # === 4. Equipo ===
    story.append(Paragraph("4. Equipo comercial bajo su cargo", style_section))
    story.append(Paragraph(
        "El Gerente lidera un equipo de Ejecutivos Comerciales con la siguiente compensación:",
        style_body,
    ))
    story.append(fact_table([
        ("Cargo", "Ejecutivo Comercial"),
        ("Modalidad", "Prestación de servicios"),
        ("Básico mensual fijo", cop(BASE_COMERCIAL) + " COP"),
        ("Bono apertura por cuenta (mes 1)", "75% del precio del plan"),
        ("Comisión recurrente (mes 2 al 12)", "10% del precio del plan / mes"),
        ("Reporte directo", "Gerente Comercial"),
    ]))

    story.append(PageBreak())

    # === 5. Escenarios ===
    story.append(Paragraph("5. Escenarios de ingreso", style_section))
    story.append(Paragraph(
        "Las tablas proyectan tu ingreso bajo dos niveles de productividad por comercial. "
        "Asumimos una mezcla típica del pipeline de <b>50% Esencial · 35% Pro · 15% Premium</b>. "
        "Se muestran tres puntos en el tiempo: <b>mes 1</b> (solo base + apertura, libro vacío), "
        "<b>mes 12 en steady state</b> (libro completo, todas las cohortes recurrentes activas) y "
        "<b>total acumulado del año 1</b>.",
        style_body,
    ))

    def build_scenarios(cuentas_por_rep, label):
        story.append(Paragraph(label, style_h3))
        escenarios = [escenario_gerente(n, cuentas_por_rep) for n in [3, 5, 8, 10, 15]]
        data = [[
            Paragraph("Tamaño<br/>del equipo", style_th),
            Paragraph("Cuentas<br/>nuevas/mes", style_th),
            Paragraph("Mes 1<br/>(libro vacío)", style_th),
            Paragraph("Mes 12+<br/>(steady state)", style_th),
            Paragraph("Total<br/>año 1", style_th),
        ]]
        for e in escenarios:
            data.append([
                Paragraph(f"{e['reps']} reps", style_td),
                Paragraph(f"{e['cuentas_mes']}", style_td),
                Paragraph(cop(e["mes_1"]), style_td_r),
                Paragraph(cop(e["mes_ss"]), style_td_r),
                Paragraph(cop(e["total_y1"]), style_td_rb),
            ])
        story.append(styled_table(data, [2.5 * cm, 2.8 * cm, 3.4 * cm, 3.5 * cm, 3.7 * cm]))
        story.append(Spacer(1, 4))

    build_scenarios(4, "5.1 Escenario base — 4 cuentas/mes por comercial")
    story.append(Paragraph(
        "Productividad conservadora, alcanzable durante el periodo de adaptación.",
        style_caption,
    ))

    build_scenarios(10, "5.2 Escenario de alto desempeño — 10 cuentas/mes por comercial")
    story.append(Paragraph(
        "Productividad ambiciosa, esperada una vez consolidado el proceso comercial.",
        style_caption,
    ))

    # === 5.3 Cash flow con cuentas anuales en el mix ===
    story.append(Paragraph(
        "5.3 Cash flow del Gerente según % de cuentas anuales", style_h3,
    ))
    story.append(Paragraph(
        "Los escenarios 5.1 y 5.2 asumen que todas las cuentas pagan mensual. Si el equipo "
        "empuja la modalidad anual, el ingreso del Gerente en el <b>mes 1</b> sube "
        "fuertemente — porque el override de las anuales se liquida completo al inicio.",
        style_body,
    ))
    story.append(Paragraph(
        "Tomando el escenario base de 10 reps × 4 cuentas/mes:",
        style_body,
    ))
    data = [
        [Paragraph("% del libro anual", style_th),
         Paragraph("Cuentas mensuales<br/>(solo apertura)", style_th),
         Paragraph("Cuentas anuales<br/>(liquidación completa)", style_th),
         Paragraph("Tu ingreso mes 1", style_th)],
    ]
    for pct in [0.0, 0.30, 0.50, 0.70, 1.0]:
        cuentas_total = 10 * 4
        cuentas_m = int(round(cuentas_total * (1 - pct)))
        cuentas_a = cuentas_total - cuentas_m
        ingreso = gerente_mes_1_mix_anual(10, 4, pct)
        pct_label = f"{int(pct * 100)}%"
        data.append([
            Paragraph(pct_label, style_td_b),
            Paragraph(f"{cuentas_m}", style_td_r),
            Paragraph(f"{cuentas_a}", style_td_r),
            Paragraph(cop(ingreso), style_td_rb),
        ])
    story.append(styled_table(data, [3.2 * cm, 4.0 * cm, 4.5 * cm, 4.3 * cm]))
    story.append(Paragraph(
        "Pasando de 0% a 30% anual en el mix, tu mes 1 sube de $10,5M a $13,0M (+24%). "
        "El total año 1 acumulado se mantiene similar — lo que cambia es el momento. "
        "Empujar anuales suaviza la curva de ingreso y reduce el riesgo de churn en el libro.",
        style_caption,
    ))

    # === 6. KPIs ===
    story.append(Paragraph("6. Indicadores de gestión", style_section))
    for k in [
        "<b>Cuentas nuevas activadas</b> por el equipo en el mes.",
        "<b>MRR neto generado</b> (suma del valor mensual de las cuentas activadas).",
        "<b>Churn del libro</b> (cuentas que cancelan / cuentas activas).",
        "<b>Cobertura del pipeline</b>: demos agendadas y realizadas.",
        "<b>Retención del equipo</b>: rotación de comerciales y curva de aprendizaje.",
        "<b>Tasa de cierre</b>: demos realizadas vs. cuentas cerradas.",
    ]:
        story.append(Paragraph(k, style_bullet, bulletText="•"))

    # === 7. Reglas ===
    story.append(Paragraph("7. Reglas y condiciones", style_section))
    for c in [
        "<b>Modalidad:</b> contrato de prestación de servicios profesionales.",
        "<b>Dedicación:</b> tiempo completo, exclusiva.",
        "<b>Liquidación:</b> mensual, dentro de los primeros 5 días hábiles del mes siguiente, sobre los pagos efectivamente cobrados al restaurante.",
        "<b>Vigencia del recurrente:</b> el 2,5% mensual aplica del mes 2 al 12 de cada cuenta. Al mes 13 finaliza.",
        "<b>Descuento por pago anual al cliente:</b> 15% estándar sobre la lista, permanente. "
        "Promo de lanzamiento del 20% vigente hasta el 31 de diciembre 2026. El equipo comercial "
        "está autorizado a ofrecer estos descuentos sin aprobación adicional.",
        "<b>Override anual:</b> cuando una cuenta entra con pago anual, el override completo "
        "del año 1 (52,5% del precio mensual de lista) se liquida en el mes 1 siguiente a la "
        "activación. Calculado sobre el precio de lista, sin aplicar el descuento al cliente.",
        "<b>Clawback (mensuales):</b> si una cuenta cancela dentro de los primeros 60 días, el override de apertura se descuenta de liquidaciones futuras.",
        "<b>Clawback (anuales):</b> si una cuenta anual cancela y solicita reembolso dentro de los primeros 90 días, se descuenta proporcionalmente el override anual ya liquidado.",
        "<b>Herramientas:</b> CRM corporativo, equipo de cómputo, plan de datos cubierto por el contratista.",
        "<b>Periodo de adaptación:</b> primeros 60 días con seguimiento semanal y metas progresivas.",
        "<b>Confidencialidad:</b> firma de acuerdo de confidencialidad y no competencia.",
    ]:
        story.append(Paragraph(c, style_bullet, bulletText="•"))

    # === 8. Próximos pasos ===
    story.append(Paragraph("8. Próximos pasos", style_section))
    for i, p in enumerate([
        "Entrevista con la dirección general para alinear visión y expectativas.",
        "Presentación del plan de los primeros 90 días por parte del candidato.",
        "Firma del contrato de prestación de servicios.",
        "Onboarding al producto, herramientas y procesos comerciales.",
    ], 1):
        story.append(Paragraph(f"<b>{i}.</b> {p}", style_bullet, bulletText="·"))

    story.append(Spacer(1, 18))
    story.append(hairline())
    story.append(Spacer(1, 8))
    story.append(Paragraph(
        "Esta propuesta es confidencial y de uso exclusivo del destinatario. Las cifras "
        "de escenarios son ilustrativas; los ingresos reales dependen del desempeño del equipo. "
        "Condiciones sujetas a negociación.",
        style_caption,
    ))
    story.append(Spacer(1, 26))

    firma = Table([
        [Paragraph("_______________________________", style_body_left),
         Paragraph("_______________________________", style_body_left)],
        [Paragraph("<b>Por MESAPAY</b>", style_body_left),
         Paragraph("<b>Aceptado por el candidato</b>", style_body_left)],
        [Paragraph("Nicolás · Dirección General", style_caption),
         Paragraph("Nombre · C.C. · Fecha", style_caption)],
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
