"""
Propuesta para Ejecutivo Comercial Independiente de MESAPAY (corretaje mercantil).

Salida: /Users/nicolas/Documents/APPS/MESAPAY/docs/Propuesta-Comercial-Independiente-MESAPAY.pdf

Modelo de compensación:
- 100% del primer mes de cada cuenta activada (apertura)
- 10% recurrente mensual del mes 2 al 12
- Pago anual del cliente: 210% del precio mensual de lista, liquidado en mes 1
- Total año 1 por cuenta = 2,1 mensualidades del plan
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

OUTPUT = "/Users/nicolas/Documents/APPS/MESAPAY/docs/Propuesta-Comercial-Independiente-MESAPAY.pdf"

# Paleta MESAPAY
INK = colors.HexColor("#1a1a1a")
INK_2 = colors.HexColor("#3a3a3a")
INK_3 = colors.HexColor("#6b6b6b")
BONE = colors.HexColor("#f8f4ec")
HAIRLINE = colors.HexColor("#e8e2d4")
ACCENT = colors.HexColor("#c75432")
ACCENT_BG = colors.HexColor("#fae9e0")


def cop(n: int) -> str:
    return "$" + f"{n:,.0f}".replace(",", ".")


# Constantes
PRECIO_ESENCIAL = 399_000
PRECIO_PRO = 899_000
PRECIO_PREMIUM = 1_599_000

PCT_APERTURA = 1.00       # 100% del precio mes 1
PCT_RECURRENTE = 0.10     # 10% mensual del mes 2 al 12
MESES_RECURRENTE = 11
TOTAL_ANO_1_PCT = PCT_APERTURA + PCT_RECURRENTE * MESES_RECURRENTE  # 210%

DESCUENTO_ANUAL_STANDARD = 0.15
DESCUENTO_ANUAL_PROMO = 0.20

MIX = [("Esencial", PRECIO_ESENCIAL, 0.50),
       ("Pro", PRECIO_PRO, 0.35),
       ("Premium", PRECIO_PREMIUM, 0.15)]


def apertura(precio: int) -> int:
    return int(precio * PCT_APERTURA)


def recurrente_mensual(precio: int) -> int:
    return int(precio * PCT_RECURRENTE)


def total_y1_por_cuenta(precio: int) -> int:
    return apertura(precio) + recurrente_mensual(precio) * MESES_RECURRENTE


def avg_apertura() -> int:
    return int(sum(w * apertura(precio) for _, precio, w in MIX))


def avg_recurrente_mensual() -> int:
    return int(sum(w * recurrente_mensual(precio) for _, precio, w in MIX))


def escenario(cuentas_por_mes: int):
    avg_ap = avg_apertura()
    avg_rec = avg_recurrente_mensual()
    mes_1 = cuentas_por_mes * avg_ap
    mes_ss = cuentas_por_mes * avg_ap + cuentas_por_mes * MESES_RECURRENTE * avg_rec
    total_y1 = cuentas_por_mes * 12 * avg_ap + cuentas_por_mes * 66 * avg_rec
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
        title="Propuesta · Ejecutivo Comercial Independiente · MESAPAY",
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

    story.append(Paragraph("PROPUESTA · CORRETAJE MERCANTIL", style_eyebrow))
    story.append(Paragraph("Propuesta de colaboración", style_title))
    story.append(Paragraph(
        "Ejecutivo Comercial Independiente · Modalidad: corretaje mercantil",
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
        [Paragraph("100%", stat_big), Paragraph("del primer mes<br/>de cada cuenta abierta", stat_label)],
        [Paragraph("10%", stat_big), Paragraph("recurrente mensual<br/>del mes 2 al 12", stat_label)],
        [Paragraph("2,1", stat_big), Paragraph("mensualidades del plan<br/>por cuenta en año 1", stat_label)],
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
        "Buscamos ejecutivos comerciales que abran cuentas nuevas de restaurantes para "
        "MESAPAY como corretaje mercantil. Por cada cuenta que actives recibís el "
        "<b>100% del primer mes</b> del plan que contrate el restaurante y el <b>10% "
        "mensual del mes 2 al 12</b> mientras la cuenta siga al día. Cada cuenta te paga "
        "<b>2,1 mensualidades del plan</b> en su primer año. Sin techo: tu ingreso crece "
        "con cada cuenta abierta y se acumula mientras tu libro de clientes esté vivo.",
        style_body,
    ))

    # === 2. Estructura de compensación ===
    story.append(Paragraph("2. Estructura de compensación", style_section))
    story.append(Paragraph(
        "Dos componentes acumulables, <b>sin techo</b>:",
        style_body,
    ))
    story.append(Paragraph(
        "<b>Mes 1 — Apertura:</b> el <b>100%</b> del precio mensual del plan que contrate "
        "el restaurante. Pago único al activarse la cuenta.",
        style_bullet, bulletText="·",
    ))
    story.append(Paragraph(
        "<b>Mes 2 al 12 — Recurrente:</b> el <b>10%</b> mensual del precio del plan, mientras "
        "la cuenta siga activa y al día.",
        style_bullet, bulletText="·",
    ))

    story.append(Paragraph("2.1 Lo que ganás por cada plan", style_h3))
    data = [
        [Paragraph("Plan", style_th),
         Paragraph("Precio mensual<br/>al restaurante", style_th),
         Paragraph("Apertura (mes 1)<br/>100% del precio", style_th),
         Paragraph("Recurrente (mes 2-12)<br/>10% mensual", style_th),
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
        "Cada cuenta = 2,1 mensualidades del plan en el año 1 "
        "(100% mes 1 + 10% × 11 mes 2-12). Cifras en COP sobre suscripción.",
        style_caption,
    ))

    # === 2.2 Descuento al cliente ===
    story.append(Spacer(1, 6))
    story.append(Paragraph(
        "2.2 Descuento al cliente por pago anual anticipado", style_h3,
    ))
    story.append(Paragraph(
        "Podés ofrecerle al restaurante un descuento sobre la lista cuando paga el año "
        "por adelantado. Es tu mejor herramienta de cierre — y a vos te paga todo el año "
        "en el mes 1:",
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
        "El descuento sale del margen de MESAPAY. Tu comisión se calcula siempre sobre "
        "el precio de lista (sin descuento).",
        style_caption,
    ))

    # === 2.3 Comisión sobre anuales ===
    story.append(Spacer(1, 6))
    story.append(Paragraph("2.3 Tu comisión sobre cuentas con pago anual", style_h3))
    story.append(Paragraph(
        "Cuando cerrás una cuenta anual, tu comisión completa del año 1 se "
        "<b>liquida en el mes 1</b>, calculada sobre el precio mensual de lista:",
        style_body,
    ))
    story.append(Paragraph(
        "<b>Comisión anual = 210% del precio mensual de lista</b>, pagada toda junta.",
        style_bullet, bulletText="·",
    ))
    story.append(Spacer(1, 4))
    data = [
        [Paragraph("Plan", style_th),
         Paragraph("Mes 1 anual<br/>(210% del precio)", style_th),
         Paragraph("Mes 1 mensual<br/>(solo 100% apertura)", style_th)],
    ]
    for nombre, precio, _ in MIX:
        total_anual = int(precio * TOTAL_ANO_1_PCT)
        solo_apertura = apertura(precio)
        data.append([
            Paragraph(nombre, style_td_b),
            Paragraph(cop(total_anual), style_td_rb),
            Paragraph(cop(solo_apertura), style_td_r),
        ])
    story.append(styled_table(data, [3.2 * cm, 6.9 * cm, 6.9 * cm]))
    story.append(Paragraph(
        "Cerrar un Premium anual te deja $3,36M en el bolsillo en el mes 1.",
        style_caption,
    ))

    story.append(PageBreak())

    # === 3. Escenarios ===
    story.append(Paragraph("3. Escenarios de ingreso", style_section))
    story.append(Paragraph(
        "Asumimos una mezcla típica del pipeline de <b>50% Esencial · 35% Pro · 15% "
        "Premium</b>. Se muestran tres puntos: <b>mes 1</b> (libro vacío, solo apertura), "
        "<b>mes 12 en steady state</b> (libro completo, 11 cohortes anteriores en "
        "recurrente) y <b>total acumulado año 1</b>.",
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
        "Mezcla 50/35/15 sobre Esencial/Pro/Premium. Asume todas las cuentas en modalidad "
        "mensual. Si empujás anuales, tu mes 1 sube significativamente — cobrás todo el "
        "año 1 de esa cuenta de una sola vez.",
        style_caption,
    ))

    # === 4. Reglas claras ===
    story.append(Paragraph("4. Reglas claras (para que no haya sorpresas)", style_section))
    for r in [
        "<b>Venta válida:</b> cuenta activada en MESAPAY y con su primer pago recibido.",
        "<b>Liquidación:</b> mensual, dentro de los primeros 5 días hábiles del mes siguiente, sobre los pagos efectivamente cobrados al restaurante.",
        "<b>Base de cálculo:</b> los porcentajes (100% y 10%) se calculan sobre la suscripción mensual del local de lista (no sobre impuestos ni sobre el markup de pagos), salvo acuerdo escrito distinto.",
        "<b>Vigencia del recurrente:</b> el 10% mensual aplica del mes 2 al 12 de cada cuenta. Al mes 13 finaliza la comisión sobre esa cuenta.",
        "<b>Descuento autorizado al cliente:</b> podés ofrecer 15% por pago anual (permanente) o 20% durante la promo de lanzamiento (hasta 31 de diciembre 2026). El descuento sale del margen de MESAPAY.",
        "<b>Comisión sobre anuales:</b> 210% del precio mensual de lista liquidado en el mes 1. Tu base de cálculo es siempre el precio de lista, no el precio con descuento.",
        "<b>Permanencia y clawback:</b> si una cuenta cancela dentro de los primeros 60 días, el bono de apertura se descuenta de comisiones futuras. Anuales: clawback proporcional si cancela en los primeros 90 días.",
        "<b>Tus cuentas son tuyas:</b> las cuentas que abrís quedan asignadas a vos para efectos de comisión durante todo el primer año.",
        "<b>MESAPAY te respalda:</b> demo, material comercial, lista de precios y acompañamiento técnico en el onboarding del restaurante.",
    ]:
        story.append(Paragraph(r, style_bullet, bulletText="•"))

    # === 5. Naturaleza de la relación ===
    story.append(Paragraph("5. Naturaleza de la relación", style_section))
    story.append(Paragraph(
        "Esta es una relación de <b>corretaje mercantil</b> (Art. 1340 y ss. del Código de "
        "Comercio):",
        style_body,
    ))
    for b in [
        "<b>Sin subordinación, sin horario fijo, sin metas mínimas obligatorias.</b>",
        "<b>Sin exclusividad:</b> podés representar otros productos o servicios siempre que no sean competencia directa de MESAPAY en restaurantes.",
        "<b>Sin reporte semanal obligatorio:</b> vos gestionás tu agenda y tu pipeline.",
        "<b>Obligaciones tributarias propias:</b> DIAN, RUT, retención en la fuente sobre comisiones.",
        "<b>Se formaliza mediante contrato escrito</b> de corretaje mercantil firmado con MESAPAY.",
    ]:
        story.append(Paragraph(b, style_bullet, bulletText="•"))
    story.append(Paragraph(
        "Nota: las cifras proyectadas son ilustrativas. Antes de firmar, validá los términos "
        "fiscales y legales con tu contador o abogado.",
        style_caption,
    ))

    # === 6. Por qué te conviene ===
    story.append(Paragraph("6. Por qué te conviene", style_section))
    for b in [
        "<b>Comisión sin techo:</b> el 100% del primer mes y el 10% mensual del mes 2 al 12 por cada cuenta que mantengas activa.",
        "<b>Renta recurrente:</b> cada cuenta te paga 11 meses adicionales después del cierre, mientras siga al día.",
        "<b>Libertad total:</b> sin exclusividad, sin horario, sin meta mínima, sin reuniones obligatorias.",
        "<b>Arranque inmediato:</b> sin cuota de entrada, empezás a generar desde la primera cuenta.",
        "<b>Producto que se vende solo en demo:</b> carta digital QR, pedido y pago, comanda automática, reservas, facturación electrónica.",
    ]:
        story.append(Paragraph(b, style_bullet, bulletText="•"))

    # === 7. Próximos pasos ===
    story.append(Paragraph("7. Próximos pasos", style_section))
    for i, p in enumerate([
        "Conversación con la dirección comercial para definir territorio y alcance.",
        "Firma del contrato de corretaje mercantil.",
        "Acceso a la demo, lista de precios, herramientas comerciales y material de ventas.",
        "Arranque en tu pipeline.",
    ], 1):
        story.append(Paragraph(f"<b>{i}.</b> {p}", style_bullet, bulletText="·"))

    story.append(Spacer(1, 18))
    story.append(hairline())
    story.append(Spacer(1, 8))
    story.append(Paragraph(
        "Esta propuesta es confidencial y de uso exclusivo del destinatario. Las cifras "
        "de escenarios son ilustrativas; los ingresos reales dependen exclusivamente de tu "
        "desempeño y de la retención de las cuentas. Condiciones sujetas a negociación.",
        style_caption,
    ))
    story.append(Spacer(1, 22))

    firma = Table([
        [Paragraph("_______________________________", style_body_l),
         Paragraph("_______________________________", style_body_l)],
        [Paragraph("<b>Acepta — Comercial Independiente</b>", style_body_l),
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
