"""
Addendum al Estudio de Mercado de MESAPAY — actualización estratégica de pricing.

Salida: /Users/nicolas/Documents/APPS/MESAPAY/Estudio-de-mercado-MESAPAY-Addendum.pdf

Documenta el cambio de estrategia de pricing: del posicionamiento
"más barato que Fudo armado por módulos" (estudio Junio 2026) a un
posicionamiento premium con servicio diferenciado.
"""

from reportlab.lib import colors
from reportlab.lib.enums import TA_JUSTIFY, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageTemplate,
    Paragraph, Spacer, Table, TableStyle,
)

OUTPUT = "/Users/nicolas/Documents/APPS/MESAPAY/docs/Estudio-de-mercado-MESAPAY-Addendum.pdf"

# Paleta verde (consistente con el estudio original)
INK = colors.HexColor("#1a1a1a")
INK_2 = colors.HexColor("#3a3a3a")
INK_3 = colors.HexColor("#6b6b6b")
HAIRLINE = colors.HexColor("#dde3e0")
GREEN = colors.HexColor("#2d6a5a")
GREEN_BG = colors.HexColor("#e7f0ed")
AMBER_BG = colors.HexColor("#fdf2e1")
AMBER_BORDER = colors.HexColor("#d6a55b")


def cop(n: int) -> str:
    return "$" + f"{n:,.0f}".replace(",", ".")


styles = getSampleStyleSheet()

style_eyebrow = ParagraphStyle("Eyebrow", parent=styles["Normal"],
                               fontName="Helvetica-Bold", fontSize=8.5, leading=11,
                               textColor=GREEN, alignment=TA_LEFT, spaceAfter=4)
style_title = ParagraphStyle("Title", parent=styles["Title"],
                             fontName="Helvetica-Bold", fontSize=26, leading=30,
                             textColor=INK, alignment=TA_LEFT, spaceAfter=4)
style_subtitle = ParagraphStyle("Subtitle", parent=styles["Normal"],
                                fontName="Helvetica", fontSize=12, leading=16,
                                textColor=INK_3, alignment=TA_LEFT, spaceAfter=16)
style_section_num = ParagraphStyle("SectionNum", parent=styles["Normal"],
                                   fontName="Helvetica-Bold", fontSize=10, leading=12,
                                   textColor=colors.white, alignment=TA_LEFT)
style_section = ParagraphStyle("Section", parent=styles["Heading1"],
                               fontName="Helvetica-Bold", fontSize=14, leading=18,
                               textColor=INK, alignment=TA_LEFT,
                               spaceBefore=8, spaceAfter=8, leftIndent=0)
style_body = ParagraphStyle("Body", parent=styles["Normal"],
                            fontName="Helvetica", fontSize=10, leading=14.5,
                            textColor=INK_2, alignment=TA_JUSTIFY, spaceAfter=6)
style_body_left = ParagraphStyle("BodyLeft", parent=style_body, alignment=TA_LEFT)
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


def section_header(num: str, title: str):
    """Replica el estilo de los headers numerados del estudio original."""
    badge = Table([[Paragraph(num, style_section_num)]], colWidths=[0.65 * cm], rowHeights=[0.65 * cm])
    badge.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), GREEN),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
    ]))
    row = Table([[badge, Paragraph(title, style_section)]],
                colWidths=[0.9 * cm, 16.1 * cm])
    row.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("LINEBELOW", (0, 0), (-1, -1), 0.5, HAIRLINE),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
    ]))
    return row


def callout(text: str, kind: str = "green"):
    """Recuadro con borde — verde para insights, ámbar para advertencias."""
    bg = GREEN_BG if kind == "green" else AMBER_BG
    border = GREEN if kind == "green" else AMBER_BORDER
    box = Table([[Paragraph(text, style_body_left)]], colWidths=[17 * cm])
    box.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("LINEBEFORE", (0, 0), (-1, -1), 3, border),
        ("LEFTPADDING", (0, 0), (-1, -1), 14),
        ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
    ]))
    return box


def styled_table(data, col_widths):
    t = Table(data, colWidths=col_widths)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), GREEN),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [GREEN_BG, colors.white]),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, HAIRLINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    return t


def build():
    doc = BaseDocTemplate(
        OUTPUT, pagesize=letter,
        leftMargin=2.2 * cm, rightMargin=2.2 * cm,
        topMargin=2.0 * cm, bottomMargin=2.0 * cm,
        title="Addendum · Estudio de Mercado MESAPAY · Junio 2026",
        author="MESAPAY",
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height,
                  id="main", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)

    def footer(canvas, _doc):
        canvas.saveState()
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(INK_3)
        canvas.drawString(doc.leftMargin, 1.0 * cm,
                          f"MESAPAY · Addendum estratégico de pricing · Pág. {_doc.page}")
        canvas.drawRightString(letter[0] - doc.rightMargin, 1.0 * cm, "Junio 2026")
        canvas.restoreState()

    doc.addPageTemplates([PageTemplate(id="default", frames=[frame], onPage=footer)])

    story = []

    # Header
    story.append(Paragraph("MESAPAY", style_eyebrow))
    story.append(Spacer(1, 4))
    story.append(Paragraph("ADDENDUM ESTRATÉGICO · ACTUALIZACIÓN DE PRICING", style_eyebrow))
    story.append(Paragraph("Reposicionamiento premium", style_title))
    story.append(Paragraph(
        "Actualización al Estudio de Mercado y Estrategia de Pricing · Colombia · Junio 2026",
        style_subtitle,
    ))

    # Nota metodológica de apertura
    story.append(callout(
        "<b>Léase junto con el documento original.</b> Este addendum no reemplaza el "
        "Estudio de Mercado de Junio 2026 — lo complementa. El estudio original recomendaba "
        "una estrategia de undercut frente a Fudo armado por módulos; este addendum documenta "
        "una decisión estratégica posterior de reposicionar MESAPAY como un producto premium "
        "con servicio diferenciado. Las fuentes verificadas del estudio original siguen siendo "
        "válidas como descripción del mercado — lo que cambia es la posición competitiva.",
        kind="amber",
    ))
    story.append(Spacer(1, 14))

    # 1. Qué cambió
    story.append(section_header("1", "Qué cambió respecto al estudio original"))
    story.append(Paragraph(
        "El estudio de Junio 2026 recomendó precios anclados <b>por debajo del costo de armar "
        "Fudo módulo por módulo</b>: $149.000 (Esencial), $259.000 (Pro) y $399.000 "
        "(Cadenas/Premium). Esa tesis era defensiva — \"no te dejes ganar por precio\".",
        style_body,
    ))
    story.append(Paragraph(
        "La nueva estrategia abandona el undercut y posiciona a MESAPAY como un producto "
        "<b>premium con servicio diferenciado</b> — onboarding asistido, account manager, "
        "respaldo del Gerente Comercial en demos y soporte priorizado por tier. Los nuevos "
        "precios son ~3x sobre la recomendación original:",
        style_body,
    ))

    data = [
        [Paragraph("Plan", style_th),
         Paragraph("Precio estudio<br/>(Junio 2026)", style_th),
         Paragraph("Precio nuevo<br/>(addendum)", style_th),
         Paragraph("Múltiplo", style_th)],
        [Paragraph("Esencial", style_td_b),
         Paragraph(cop(149_000), style_td_r),
         Paragraph(cop(399_000), style_td_rb),
         Paragraph("2,7x", style_td_r)],
        [Paragraph("Pro", style_td_b),
         Paragraph(cop(259_000), style_td_r),
         Paragraph(cop(899_000), style_td_rb),
         Paragraph("3,5x", style_td_r)],
        [Paragraph("Premium", style_td_b),
         Paragraph(cop(399_000), style_td_r),
         Paragraph(cop(1_599_000), style_td_rb),
         Paragraph("4,0x", style_td_r)],
    ]
    story.append(styled_table(data, [3.5 * cm, 4.5 * cm, 4.5 * cm, 3.0 * cm]))
    story.append(Paragraph(
        "Cifras en COP/mes + IVA. Tiering por tamaño del restaurante: "
        "Esencial = hasta 20 mesas · Pro = 21-40 mesas · Premium = más de 40 mesas.",
        style_caption,
    ))

    # 2. Por qué — racional estratégico
    story.append(section_header("2", "Racional estratégico"))
    for r in [
        "<b>Margen de comisión vendible.</b> El nuevo modelo de compensación (comercial: $2M básico + 75% mes 1 + 10% recurrente; gerente: $3M + 25% + 2,5%) requiere precios que sostengan ese costo operativo. A $149K, la primera mensualidad no alcanza para cubrir el bono de apertura del comercial.",
        "<b>Reposicionamiento competitivo.</b> Competir por precio contra Fudo es una carrera al fondo — y Fudo tiene economía de escala regional. Competir por <b>servicio integral</b> (onboarding asistido, mesero acompañando demos, account manager para Premium) es defendible y escalable.",
        "<b>Calificación del cliente.</b> Un precio más alto filtra naturalmente al cliente serio. Un restaurante que paga $1,6M/mes está más comprometido con adopción que uno que paga $149K — eso mejora retención y baja churn.",
        "<b>Cobertura comercial.</b> El equipo comercial necesita una propuesta económica con upside real. A los precios viejos, un comercial top-performer no superaba los $5M/mes; a los nuevos, puede superar los $15M/mes en steady state.",
    ]:
        story.append(Paragraph(r, style_bullet, bulletText="•"))

    # 3. Qué del estudio original sigue válido
    story.append(section_header("3", "Qué del estudio original sigue válido"))
    story.append(Paragraph(
        "El cambio de precio <b>no invalida</b> los datos de mercado del estudio original. "
        "Estos hallazgos verificados siguen siendo el contexto operativo:",
        style_body,
    ))
    for r in [
        "<b>Tamaño del mercado Colombia:</b> ~95% de los establecimientos son independientes; food service +7% en 2023 (USD$14B); 29,4% ya tiene QR interoperable (Banrep 2025).",
        "<b>Tarifas de procesamiento (MDR):</b> Wompi 2,65% + $700 · datafono ~2,99% + $300-900. <b>Techo creíble que el comercio tolera: 2,99% + $700-900 en tarjeta.</b>",
        "<b>Competidor de referencia:</b> Fudo cobra por módulo; stack completo equivalente a MESAPAY ≈ $1.650-1.850 MXN/mes (USD$90-100). MESAPAY ahora compite arriba de eso por servicio, no debajo por precio.",
        "<b>Cumplimiento DIAN:</b> Res. 000202/2025 sobre validación POS sigue obligando — el producto está bien encaminado.",
    ]:
        story.append(Paragraph(r, style_bullet, bulletText="•"))

    # 4. Qué cambia en la conversación con el cliente
    story.append(section_header("4", "Qué cambia en la conversación con el cliente"))
    story.append(Paragraph(
        "El comercial ya no vende contra precio. Vende contra <b>tiempo, fricción y costo de "
        "no hacerlo</b>:",
        style_body,
    ))
    for r in [
        "<b>Ya no se dice:</b> «MESAPAY es más barato que armar Fudo por partes».",
        "<b>Se dice:</b> «MESAPAY es la única plataforma todo-incluido en Colombia con onboarding asistido, mesero acompañando demos y carta trilingüe de fábrica».",
        "<b>Ancla de valor del Premium:</b> «por $1,6M al mes te damos account manager dedicado, multi-sucursal y soporte 24/7 — el equivalente armado en cualquier otro lado pasa los $3M».",
        "<b>Manejo de objeción de precio:</b> comparar contra el costo real de un mesero adicional en Colombia (~$3M/mes con salario base + prestaciones + aportes + parafiscales) que MESAPAY ahorra al automatizar pedido/pago/comanda. El plan Premium se paga 1,9x; el Pro 3,3x; el Esencial 7,5x.",
    ]:
        story.append(Paragraph(r, style_bullet, bulletText="•"))

    # 5. Riesgos
    story.append(section_header("5", "Riesgos de la nueva estrategia"))
    for r in [
        "<b>Ciclo de venta más largo.</b> Arriba de $1M/mes el dueño rara vez decide solo — entra el socio, el contador, el gerente de operaciones. Esperar +30-60% más de tiempo al cierre.",
        "<b>Barra de demo más alta.</b> No basta con mostrar features; hay que demostrar ROI concreto en la operación del restaurante (calcular ahorro de mesero, aumento de ticket promedio, mejora de rotación).",
        "<b>Perfil de comercial más senior.</b> Un junior no cierra a $1,6M sin acompañamiento. El Gerente Comercial debe entrar en cierres Premium las primeras 5-10 veces.",
        "<b>Riesgo de churn temprano.</b> Al precio nuevo, una cancelación en el mes 2-3 duele mucho más. El producto debe entregar la promesa del onboarding o la cuenta no aguanta.",
        "<b>Validación pendiente.</b> Los precios nuevos no están validados con tracción real al cierre del addendum. Acción #1: probar con 3-5 restaurantes piloto antes de imprimir material comercial masivo.",
    ]:
        story.append(Paragraph(r, style_bullet, bulletText="•"))

    # 6. Política de descuento anual
    story.append(section_header("6", "Política de pago anual y descuento"))
    story.append(Paragraph(
        "MESAPAY ofrece la opción de pago anual anticipado con descuento, para incentivar "
        "permanencia, mejorar el cash flow del primer año y reducir el riesgo de churn:",
        style_body,
    ))
    data = [
        [Paragraph("Modalidad", style_th),
         Paragraph("Descuento", style_th),
         Paragraph("Equivalente", style_th),
         Paragraph("Vigencia", style_th)],
        [Paragraph("Pago anual estándar", style_td_b),
         Paragraph("<b>15%</b>", style_td_rb),
         Paragraph("~1,8 meses gratis", style_td_r),
         Paragraph("Permanente", style_td_r)],
        [Paragraph("Promo de lanzamiento", style_td_b),
         Paragraph("<b>20%</b>", style_td_rb),
         Paragraph("~2,4 meses gratis", style_td_r),
         Paragraph("Hasta diciembre 2026", style_td_r)],
    ]
    story.append(styled_table(data, [4.5 * cm, 3.0 * cm, 4.5 * cm, 5.0 * cm]))
    story.append(Paragraph(
        "Aplica a los 3 tiers (Esencial, Pro, Premium). El descuento se calcula sobre el "
        "precio anual de lista (precio mensual × 12).",
        style_caption,
    ))
    story.append(Paragraph(
        "<b>Tratamiento de comisiones sobre cuentas anuales (Opción A):</b> La comisión "
        "completa del año 1 se liquida al comercial y al gerente en el mes 1, calculada "
        "sobre el <b>precio de lista</b> (no se les descuenta la rebaja al cliente). El "
        "descuento sale del margen de MESAPAY. Esto alinea al equipo comercial para empujar "
        "modalidad anual sin conflicto de interés:",
        style_body,
    ))
    story.append(Paragraph(
        "<b>Comercial:</b> 185% del precio mensual de lista (= 75% + 10% × 11), pagado en mes 1.",
        style_bullet, bulletText="·",
    ))
    story.append(Paragraph(
        "<b>Gerente:</b> 52,5% del precio mensual de lista (= 25% + 2,5% × 11), pagado en mes 1.",
        style_bullet, bulletText="·",
    ))
    story.append(Paragraph(
        "<b>Clawback:</b> si la cuenta cancela en los primeros 90 días, se descuenta "
        "proporcionalmente de liquidaciones futuras.",
        style_bullet, bulletText="·",
    ))

    # Cash flow comparativo
    story.append(Spacer(1, 6))
    story.append(Paragraph(
        "<b>Impacto cash flow comparativo</b> (ejemplo: cuenta Esencial nueva):",
        style_body,
    ))
    data = [
        [Paragraph("Modalidad", style_th),
         Paragraph("Cliente paga", style_th),
         Paragraph("Cash MESAPAY mes 1", style_th),
         Paragraph("Cash MESAPAY año 1", style_th)],
        [Paragraph("Mensual ($399K × 12)", style_td_b),
         Paragraph(cop(4_788_000), style_td_r),
         Paragraph(cop(250), style_td_r),
         Paragraph(cop(3_840_375), style_td_rb)],
        [Paragraph("Anual 15% off", style_td_b),
         Paragraph(cop(4_069_800), style_td_r),
         Paragraph("<b>" + cop(3_122_175) + "</b>", style_td_rb),
         Paragraph(cop(3_122_175), style_td_rb)],
        [Paragraph("Anual 20% off (promo)", style_td_b),
         Paragraph(cop(3_830_400), style_td_r),
         Paragraph("<b>" + cop(2_882_775) + "</b>", style_td_rb),
         Paragraph(cop(2_882_775), style_td_rb)],
    ]
    story.append(styled_table(data, [4.5 * cm, 4.2 * cm, 4.2 * cm, 4.1 * cm]))
    story.append(Paragraph(
        "El descuento cuesta hasta $958K por cuenta vs lista anual, pero te asegura 12 "
        "meses de retención garantizada y el cash necesario para escalar el equipo "
        "comercial. En etapa de crecimiento, anual gana por margen amplio.",
        style_caption,
    ))

    # 7. Acciones inmediatas
    story.append(section_header("7", "Acciones inmediatas"))
    for i, a in enumerate([
        "<b>Validar precios en campo:</b> ofrecer los nuevos planes a 3-5 prospectos de cada tier. Medir tasa de cierre y objeciones recurrentes en 30 días.",
        "<b>Actualizar material comercial:</b> deck de demo, one-pager por tier, calculadora de ROI para el comercial. Tres documentos máximo.",
        "<b>Definir features Premium:</b> multi-sucursal, account manager, soporte 24/7 deben estar implementados antes de cerrar el primer cliente Premium. Confirmar roadmap técnico.",
        "<b>Briefing al equipo comercial:</b> entrenamiento de 2-4 horas sobre el cambio de discurso (no más «más barato que Fudo»; ahora «servicio integral premium»).",
        "<b>Monitoreo a 90 días:</b> revisar si el nuevo pricing sostiene el cierre. Si la tasa de cierre cae por debajo del 15%, reconsiderar o ajustar.",
    ], 1):
        story.append(Paragraph(f"<b>{i}.</b> {a}", style_bullet, bulletText="·"))

    # Caja final
    story.append(Spacer(1, 14))
    story.append(callout(
        "<b>Decisión estratégica documentada · Junio 2026.</b> "
        "MESAPAY abandona la estrategia de undercut y se reposiciona como producto premium "
        "con servicio diferenciado. Precios nuevos: <b>$399.000 / $899.000 / $1.599.000 COP/mes</b>. "
        "Modelo de compensación comercial: $2M básico + 75% mes 1 + 10% recurrente. "
        "El éxito de esta estrategia depende de la entrega operativa del servicio prometido "
        "en los tiers Pro y Premium.",
        kind="green",
    ))

    story.append(Spacer(1, 14))
    story.append(Paragraph(
        "Este documento es un addendum al Estudio de Mercado y Estrategia de Pricing de "
        "Junio 2026. No reemplaza al original, lo actualiza en su sección de recomendación "
        "de precios. Toda referencia futura a pricing debe usar las cifras de este addendum.",
        style_caption,
    ))

    doc.build(story)
    print(f"OK -> {OUTPUT}")


if __name__ == "__main__":
    build()
