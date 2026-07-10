"""
Propuesta para Gerente Comercial Independiente (freelance) de MESAPAY.

Salida: /Users/nicolas/Documents/APPS/MESAPAY/docs/Propuesta-Gerente-Comercial-Independiente-MESAPAY.pdf

Modelo de compensación (mismos porcentajes que el Gerente con básico):
- Override apertura: 25% del precio mensual de cada cuenta del equipo (mes 1)
- Override recurrente: 2,5% mensual del precio del plan (mes 2 al 12)
- Pago anual del cliente: 52,5% del precio mensual de lista, liquidado en mes 1
- Total año 1 por cuenta del equipo = 52,5% del precio mensual
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

OUTPUT = "/Users/nicolas/Documents/APPS/MESAPAY/docs/Propuesta-Gerente-Comercial-Independiente-MESAPAY-MXN.pdf"

# Paleta MESAPAY
INK = colors.HexColor("#1a1a1a")
INK_2 = colors.HexColor("#3a3a3a")
INK_3 = colors.HexColor("#6b6b6b")
BONE = colors.HexColor("#f8f4ec")
HAIRLINE = colors.HexColor("#e8e2d4")
ACCENT = colors.HexColor("#c75432")
ACCENT_BG = colors.HexColor("#fae9e0")


def cop(n: int) -> str:
    return "$" + f"{int(round(n)):,}"


# Constantes
PRECIO_ESENCIAL = 1999
PRECIO_PRO = 3999
PRECIO_PREMIUM = 7999

# Porcentajes del Gerente (mismos que el modelo con básico)
PCT_APERTURA = 0.25
PCT_RECURRENTE = 0.025
MESES_RECURRENTE = 11
TOTAL_ANO_1_PCT = PCT_APERTURA + PCT_RECURRENTE * MESES_RECURRENTE  # 52,5%

DESCUENTO_ANUAL_STANDARD = 0.15
DESCUENTO_ANUAL_PROMO = 0.20

MIX = [("Esencial", PRECIO_ESENCIAL, 0.50),
       ("Pro", PRECIO_PRO, 0.35),
       ("Premium", PRECIO_PREMIUM, 0.15)]


def apertura(precio: int) -> int:
    return round(precio * PCT_APERTURA)


def recurrente_mensual(precio: int) -> int:
    return round(precio * PCT_RECURRENTE)


def total_y1_por_cuenta(precio: int) -> int:
    return apertura(precio) + recurrente_mensual(precio) * MESES_RECURRENTE


def avg_apertura() -> int:
    return int(sum(w * apertura(precio) for _, precio, w in MIX))


def avg_recurrente_mensual() -> int:
    return int(sum(w * recurrente_mensual(precio) for _, precio, w in MIX))


def split_mix(total: int):
    e = round(total * MIX[0][2])
    p = round(total * MIX[1][2])
    pr = total - e - p
    return e, p, pr


def escenario(num_reps: int, cuentas_por_rep: int):
    """Ingreso del Gerente freelance."""
    cuentas_total = num_reps * cuentas_por_rep
    avg_ap = avg_apertura()
    avg_rec = avg_recurrente_mensual()
    apertura_mes = cuentas_total * avg_ap
    recurring_ss = cuentas_total * MESES_RECURRENTE * avg_rec
    mes_1 = apertura_mes
    mes_ss = apertura_mes + recurring_ss
    # Año 1: 12 cohortes de apertura + recurrente triangular (66 cohort-meses)
    total_y1 = cuentas_total * 12 * avg_ap + cuentas_total * 66 * avg_rec
    return {
        "reps": num_reps,
        "cuentas_mes": cuentas_total,
        "mes_1": mes_1,
        "mes_ss": mes_ss,
        "total_y1": total_y1,
    }


def gerente_mes_1_mix_anual(num_reps: int, cuentas_por_rep: int, pct_anual: float) -> int:
    """Ingreso del Gerente freelance en mes 1 según % del libro que entra como anual."""
    cuentas_total = num_reps * cuentas_por_rep
    avg_ap = avg_apertura()
    avg_total_y1_pc = avg_ap + avg_recurrente_mensual() * MESES_RECURRENTE  # 52,5% × avg_precio
    cuentas_a = cuentas_total * pct_anual
    cuentas_m = cuentas_total * (1 - pct_anual)
    return int(cuentas_m * avg_ap + cuentas_a * avg_total_y1_pc)


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
style_body_l = ParagraphStyle("BodyL", parent=style_body, alignment=TA_LEFT)
style_bullet = ParagraphStyle("Bullet", parent=style_body,
                              leftIndent=14, bulletIndent=2, spaceAfter=3, alignment=TA_LEFT)
style_caption = ParagraphStyle("Caption", parent=styles["Normal"],
                               fontName="Helvetica-Oblique", fontSize=8.5, leading=11,
                               textColor=INK_3, alignment=TA_LEFT, spaceAfter=10)
style_th = ParagraphStyle("TH", parent=styles["Normal"],
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
        title="Propuesta · Gerente Comercial Independiente · MESAPAY",
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

    # === Header ===
    logo = Table([[Paragraph('<font color="white"><b>MESAPAY</b></font>', styles["Normal"])]],
                 colWidths=[3.2 * cm], rowHeights=[0.9 * cm])
    logo.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), INK),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
    ]))
    story.append(logo)
    story.append(Spacer(1, 18))

    story.append(Paragraph("PROPUESTA · COMISIÓN MERCANTIL · MÉXICO · LIDERAZGO COMERCIAL", style_eyebrow))
    story.append(Paragraph("Propuesta de colaboración", style_title))
    story.append(Paragraph(
        "Gerente Comercial Independiente · Modalidad: comisión mercantil",
        style_subtitle,
    ))
    story.append(hairline())
    story.append(Spacer(1, 14))

    # === Stat cards ===
    stat_big = ParagraphStyle("StatBig", parent=styles["Normal"],
                              fontName="Helvetica-Bold", fontSize=20, leading=22,
                              textColor=ACCENT, alignment=TA_CENTER)
    stat_label = ParagraphStyle("StatLabel", parent=styles["Normal"],
                                fontName="Helvetica", fontSize=8.5, leading=11,
                                textColor=INK_3, alignment=TA_CENTER, spaceBefore=2)
    stats = Table([[
        [Paragraph("25%", stat_big), Paragraph("override sobre el primer mes<br/>de cada cuenta del equipo", stat_label)],
        [Paragraph("2,5%", stat_big), Paragraph("recurrente mensual<br/>del mes 2 al 12", stat_label)],
        [Paragraph("52,5%", stat_big), Paragraph("del precio mensual<br/>por cuenta en año 1", stat_label)],
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

    # === 1. En una frase ===
    story.append(Paragraph("1. En una frase", style_section))
    story.append(Paragraph(
        "Buscamos un Gerente Comercial que coordine y haga crecer al equipo de Ejecutivos "
        "Comerciales de MESAPAY como comisión mercantil. Por cada cuenta que el equipo "
        "active recibís el <b>25% del primer mes</b> del plan contratado por el restaurante "
        "y el <b>2,5% mensual del mes 2 al 12</b> mientras la cuenta siga al día. Total: "
        "cada cuenta del equipo te paga el <b>52,5% del precio mensual del plan</b> en su "
        "primer año. Sin techo: tu ingreso crece con cada cuenta nueva del equipo y se "
        "acumula mientras el libro de clientes esté vivo.",
        style_body,
    ))

    # === 2. El rol ===
    story.append(Paragraph("2. El rol", style_section))
    story.append(Paragraph(
        "Como <b>Gerente Comercial</b> coordinás al equipo de Ejecutivos Comerciales "
        "encargados de la venta directa a restaurantes. Sos responsable del crecimiento "
        "del MRR (ingreso mensual recurrente) generado por el equipo.",
        style_body,
    ))
    story.append(Paragraph("Funciones principales:", style_h3))
    for b in [
        "Reclutar, entrenar y desarrollar al equipo comercial.",
        "Definir y ejecutar la estrategia de prospección y cierre de cuentas.",
        "Hacer seguimiento al pipeline de cada comercial.",
        "Acompañar demos y cierres clave cuando se requiera.",
        "Contribuir a la retención de las cuentas activas del equipo.",
    ]:
        story.append(Paragraph(b, style_bullet, bulletText="•"))

    # === 3. Estructura de compensación ===
    story.append(Paragraph("3. Estructura de compensación", style_section))
    story.append(Paragraph(
        "Dos componentes acumulables, <b>sin techo</b>:",
        style_body,
    ))
    story.append(Paragraph(
        "<b>Mes 1 — Apertura:</b> el <b>25%</b> del precio mensual del plan que contrate "
        "el restaurante (el 75% restante corresponde al comercial que cerró la cuenta).",
        style_bullet, bulletText="·",
    ))
    story.append(Paragraph(
        "<b>Mes 2 al 12 — Recurrente:</b> el <b>2,5%</b> mensual del precio del plan, "
        "mientras la cuenta siga activa y al día.",
        style_bullet, bulletText="·",
    ))

    story.append(Paragraph("3.1 Lo que ganás por cada cuenta del equipo", style_h3))
    data = [
        [Paragraph("Plan", style_th),
         Paragraph("Precio mensual<br/>al restaurante", style_th),
         Paragraph("Override apertura<br/>(mes 1, 25%)", style_th),
         Paragraph("Override recurrente<br/>(mes 2-12, 2,5%)", style_th),
         Paragraph("Total año 1<br/>por cuenta", style_th)],
    ]
    for nombre, precio, _ in MIX:
        data.append([
            Paragraph(nombre, style_td_b),
            Paragraph(cop(precio), style_td_r),
            Paragraph(cop(apertura(precio)), style_td_r),
            Paragraph(cop(recurrente_mensual(precio)) + " /mes", style_td_r),
            Paragraph(cop(total_y1_por_cuenta(precio)), style_td_rb),
        ])
    story.append(styled_table(data, [2.8 * cm, 3.0 * cm, 3.4 * cm, 3.5 * cm, 3.3 * cm]))
    story.append(Paragraph(
        "Cada cuenta del equipo = 52,5% del precio mensual del plan en el año 1 "
        "(25% mes 1 + 2,5% × 11 mes 2-12). Cifras en MXN sobre suscripción.",
        style_caption,
    ))

    # === 3.2 Descuento al cliente ===
    story.append(Spacer(1, 6))
    story.append(Paragraph(
        "3.2 Descuento al cliente por pago anual anticipado", style_h3,
    ))
    story.append(Paragraph(
        "El equipo comercial tiene autorizado ofrecer al restaurante un descuento sobre la "
        "lista cuando el cliente paga el año por adelantado:",
        style_body,
    ))
    story.append(Paragraph(
        "<b>Descuento estándar: 15%</b> &nbsp;·&nbsp; permanente.",
        style_bullet, bulletText="·",
    ))
    story.append(Paragraph(
        "<b>Promo de lanzamiento: 20%</b> &nbsp;·&nbsp; hasta el <b>31 de diciembre 2026</b>.",
        style_bullet, bulletText="·",
    ))
    story.append(Spacer(1, 4))
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
        "El descuento sale del margen de MESAPAY. Las comisiones del equipo y tu override "
        "se calculan siempre sobre el precio de lista (sin aplicar el descuento).",
        style_caption,
    ))

    # === 3.3 Override sobre cuentas anuales ===
    story.append(Spacer(1, 6))
    story.append(Paragraph("3.3 Tu override sobre cuentas con pago anual", style_h3))
    story.append(Paragraph(
        "Cuando una cuenta del equipo entra con pago anual, tu override completo del año 1 "
        "se <b>liquida en el mes 1</b>, calculado sobre el precio mensual de lista:",
        style_body,
    ))
    story.append(Paragraph(
        "<b>Override anual = 52,5% del precio mensual de lista</b>, pagado todo junto.",
        style_bullet, bulletText="·",
    ))
    story.append(Spacer(1, 4))
    data = [
        [Paragraph("Plan", style_th),
         Paragraph("Mes 1 anual<br/>(52,5% del precio)", style_th),
         Paragraph("Mes 1 mensual<br/>(solo 25% apertura)", style_th)],
    ]
    for nombre, precio, _ in MIX:
        total_anual = total_y1_por_cuenta(precio)
        solo_apertura = apertura(precio)
        data.append([
            Paragraph(nombre, style_td_b),
            Paragraph(cop(total_anual), style_td_rb),
            Paragraph(cop(solo_apertura), style_td_r),
        ])
    story.append(styled_table(data, [3.2 * cm, 6.9 * cm, 6.9 * cm]))
    story.append(Paragraph(
        "Cada cuenta Premium anual del equipo te deja $4,200 en el bolsillo en el mes 1.",
        style_caption,
    ))

    story.append(PageBreak())

    # === 4. Equipo bajo tu coordinación ===
    story.append(Paragraph("4. Equipo comercial bajo tu coordinación", style_section))
    story.append(Paragraph(
        "Coordinás a un equipo de Ejecutivos Comerciales contratados por MESAPAY bajo sus "
        "propios términos. La compensación de ellos es:",
        style_body,
    ))
    story.append(fact_table([
        ("Cargo", "Ejecutivo Comercial"),
        ("Bono apertura por cuenta (mes 1)", "75% del precio del plan"),
        ("Comisión recurrente (mes 2 al 12)", "10% del precio del plan / mes"),
        ("Coordinación comercial", "Gerente Comercial"),
    ]))

    # === 5. Escenarios ===
    story.append(Paragraph("5. Escenarios de ingreso", style_section))
    story.append(Paragraph(
        "Las tablas proyectan tu ingreso bajo dos niveles de productividad por comercial. "
        "Asumimos una mezcla típica del pipeline de <b>50% Esencial · 35% Pro · 15% Premium</b>. "
        "Se muestran <b>mes 1</b> (libro vacío), <b>mes 12 en steady state</b> (libro completo) "
        "y <b>total acumulado año 1</b>.",
        style_body,
    ))

    def build_scenarios(cuentas_por_rep, label):
        story.append(Paragraph(label, style_h3))
        escenarios = [escenario(n, cuentas_por_rep) for n in [3, 5, 8, 10, 15]]
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
        "Productividad conservadora, alcanzable durante el periodo de arranque del equipo.",
        style_caption,
    ))

    build_scenarios(10, "5.2 Escenario de alto desempeño — 10 cuentas/mes por comercial")
    story.append(Paragraph(
        "Productividad ambiciosa, esperada una vez consolidado el proceso comercial.",
        style_caption,
    ))

    # === 5.3 Cash flow con anuales ===
    story.append(Paragraph(
        "5.3 Cash flow del Gerente según % de cuentas anuales", style_h3,
    ))
    story.append(Paragraph(
        "Si el equipo empuja la modalidad anual, tu ingreso en el <b>mes 1</b> sube "
        "fuertemente — porque el override de las anuales se liquida completo al inicio. "
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
        "Pasar de 0% a 30% anual te sube el mes 1 de $36,000 a $47,880 (+33%). El total año 1 "
        "se mantiene similar — lo que cambia es el momento. Empujar anuales suaviza la "
        "curva de ingreso y reduce el riesgo de churn en el libro.",
        style_caption,
    ))

    # === 6. Reglas claras ===
    story.append(Paragraph("6. Reglas claras (para que no haya sorpresas)", style_section))
    for r in [
        "<b>Override válido:</b> cuenta del equipo activada en MESAPAY y con su primer pago recibido.",
        "<b>Liquidación:</b> mensual, dentro de los primeros 5 días hábiles del mes siguiente, sobre los pagos efectivamente cobrados al restaurante.",
        "<b>Base de cálculo:</b> los porcentajes (25% y 2,5%) se calculan sobre la suscripción mensual del local de lista (no sobre impuestos ni sobre el markup de pagos), salvo acuerdo escrito distinto.",
        "<b>Vigencia del recurrente:</b> el 2,5% mensual aplica del mes 2 al 12 de cada cuenta. Al mes 13 finaliza el override sobre esa cuenta.",
        "<b>Descuento autorizado al cliente:</b> el equipo puede ofrecer 15% por pago anual (permanente) o 20% durante la promo de lanzamiento (hasta 31 de diciembre 2026). El descuento sale del margen de MESAPAY.",
        "<b>Override sobre anuales:</b> 52,5% del precio mensual de lista liquidado en el mes 1. La base de cálculo es siempre el precio de lista, no el precio con descuento.",
        "<b>Clawback (mensuales):</b> si una cuenta cancela dentro de los primeros 60 días, el override de apertura se descuenta de liquidaciones futuras.",
        "<b>Clawback (anuales):</b> si una cuenta anual cancela y solicita reembolso dentro de los primeros 90 días, se descuenta proporcionalmente el override anual ya liquidado.",
        "<b>Equipo bajo tu coordinación:</b> los comerciales que recluten en conjunto con MESAPAY quedan asignados a tu coordinación para efectos de override.",
        "<b>MESAPAY te respalda:</b> CRM, material comercial, lista de precios y respaldo técnico en el onboarding de los restaurantes.",
    ]:
        story.append(Paragraph(r, style_bullet, bulletText="•"))

    # === 7. Naturaleza de la relación ===
    story.append(Paragraph("7. Naturaleza de la relación", style_section))
    story.append(Paragraph(
        "Esta es una relación de <b>comisión mercantil</b> (Art. 1340 y ss. del Código de "
        "Comercio):",
        style_body,
    ))
    for b in [
        "<b>Sin subordinación, sin horario fijo, sin metas mínimas obligatorias.</b>",
        "<b>Sin exclusividad:</b> podés representar otros productos o servicios siempre que no sean competencia directa de MESAPAY en restaurantes.",
        "<b>Coordinación, no jefatura laboral:</b> los comerciales del equipo son contratados directamente por MESAPAY bajo sus propios términos. Vos coordinás y acompañás su gestión comercial.",
        "<b>Obligaciones fiscales propias:</b> SAT, RFC, ISR e IVA sobre comisiones (emisión de CFDI).",
        "<b>Se formaliza mediante contrato escrito</b> de comisión mercantil firmado con MESAPAY.",
    ]:
        story.append(Paragraph(b, style_bullet, bulletText="•"))
    story.append(Paragraph(
        "Nota: las cifras proyectadas son ilustrativas. Antes de firmar, validá los términos "
        "fiscales y legales con tu contador o abogado.",
        style_caption,
    ))

    # === 8. Por qué te conviene ===
    story.append(Paragraph("8. Por qué te conviene", style_section))
    for b in [
        "<b>Override sin techo:</b> el 25% del primer mes y el 2,5% recurrente por cada cuenta que el equipo mantenga activa.",
        "<b>Renta acumulativa:</b> a más cuentas activas del equipo, más recurrente mes a mes. En steady state tu ingreso se multiplica.",
        "<b>Libertad total:</b> sin exclusividad, sin horario fijo, sin metas mínimas obligatorias.",
        "<b>Apalancamiento:</b> escalás a través del equipo — tu ingreso no depende solo de tu propio cierre.",
        "<b>Cash flow ágil con anuales:</b> cuando el equipo cierra anuales, tu override completo del año 1 se liquida upfront.",
    ]:
        story.append(Paragraph(b, style_bullet, bulletText="•"))

    # === 9. Próximos pasos ===
    story.append(Paragraph("9. Próximos pasos", style_section))
    for i, p in enumerate([
        "Conversación con la dirección para alinear visión, territorio y plan del equipo.",
        "Firma del contrato de comisión mercantil.",
        "Onboarding al producto, CRM, herramientas y procesos comerciales.",
        "Arranque del equipo y de tu pipeline de coordinación.",
    ], 1):
        story.append(Paragraph(f"<b>{i}.</b> {p}", style_bullet, bulletText="·"))

    story.append(Spacer(1, 18))
    story.append(hairline())
    story.append(Spacer(1, 8))
    story.append(Paragraph(
        "Esta propuesta es confidencial y de uso exclusivo del destinatario. Las cifras "
        "de escenarios son ilustrativas; los ingresos reales dependen del desempeño del "
        "equipo y de la retención de las cuentas. Condiciones sujetas a negociación.",
        style_caption,
    ))
    story.append(Spacer(1, 22))

    firma = Table([
        [Paragraph("_______________________________", style_body_l),
         Paragraph("_______________________________", style_body_l)],
        [Paragraph("<b>Acepta — Gerente Comercial Independiente</b>", style_body_l),
         Paragraph("<b>Por MESAPAY</b>", style_body_l)],
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
