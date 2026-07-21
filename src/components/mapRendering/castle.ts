export function drawCastle(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
  ghost = false,
) {
  const inset = size * 0.18
  context.save()
  context.globalAlpha = ghost ? 0.72 : 1
  context.fillStyle = color
  context.strokeStyle = ghost ? color : '#ead99f'
  context.lineWidth = Math.max(1, size * 0.045)
  context.shadowColor = ghost ? 'transparent' : 'rgba(0, 0, 0, .35)'
  context.shadowBlur = size * .08
  context.shadowOffsetY = size * .05
  context.beginPath()
  context.rect(x + inset, y + size * 0.34, size - inset * 2, size * 0.46)
  context.moveTo(x + inset, y + size * 0.34)
  context.lineTo(x + size * 0.29, y + size * 0.18)
  context.lineTo(x + size * 0.4, y + size * 0.34)
  context.moveTo(x + size * 0.6, y + size * 0.34)
  context.lineTo(x + size * 0.71, y + size * 0.18)
  context.lineTo(x + size - inset, y + size * 0.34)
  context.fill()
  context.stroke()
  context.shadowColor = 'transparent'
  context.fillStyle = ghost ? 'rgba(12,16,13,.35)' : '#242a22'
  context.fillRect(x + size * 0.44, y + size * 0.57, size * 0.12, size * 0.23)
  if (!ghost) {
    context.fillStyle = '#e8d79e'
    context.fillRect(x + size * .27, y + size * .47, size * .055, size * .12)
    context.fillRect(x + size * .675, y + size * .47, size * .055, size * .12)
    context.strokeStyle = '#d8b75e'
    context.lineWidth = Math.max(1, size * .025)
    context.beginPath()
    context.moveTo(x + size * .29, y + size * .18)
    context.lineTo(x + size * .29, y + size * .06)
    context.lineTo(x + size * .42, y + size * .1)
    context.lineTo(x + size * .29, y + size * .13)
    context.stroke()
  }
  context.restore()
}
