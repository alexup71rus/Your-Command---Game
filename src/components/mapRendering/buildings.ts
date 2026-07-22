import type { BuildingKind } from '../../game/map'

const roofColors: Record<BuildingKind, string> = {
  mill: '#b6a072', farm: '#a77b47', orchard: '#657d4e', huntingLodge: '#72543b',
  lumberMill: '#6e5035', quarry: '#89877b', mine: '#696b63', smelter: '#6f584a',
  kitchen: '#8b6043', house: '#9b6548', barracks: '#7f5544', church: '#7f684d',
  market: '#a06f3f', wall: '#8e8a77', tower: '#817b6b', barbican: '#777263',
}

export function drawBuilding(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  kind: BuildingKind,
  color: string,
  ghost = false,
) {
  const inset = size * 0.16
  context.save()
  context.globalAlpha = ghost ? 0.68 : 1
  context.shadowColor = ghost ? 'transparent' : 'rgba(0, 0, 0, .32)'
  context.shadowBlur = size * .065
  context.shadowOffsetY = size * .045
  context.fillStyle = ghost ? color : '#c2b083'
  context.strokeStyle = color
  context.lineWidth = Math.max(1, size * 0.045)
  if (kind === 'mill') {
    context.fillStyle = ghost ? color : '#bcae86'
    context.beginPath(); context.moveTo(x + size * .28, y + size * .82); context.lineTo(x + size * .36, y + size * .25); context.lineTo(x + size * .64, y + size * .25); context.lineTo(x + size * .72, y + size * .82); context.closePath(); context.fill(); context.stroke()
    context.fillStyle = ghost ? color : '#806047'
    context.beginPath(); context.moveTo(x + size * .31, y + size * .28); context.lineTo(x + size * .5, y + size * .1); context.lineTo(x + size * .69, y + size * .28); context.closePath(); context.fill(); context.stroke()
    context.shadowColor = 'transparent'
    context.fillStyle = ghost ? 'rgba(25,31,25,.3)' : '#40372d'
    context.fillRect(x + size * .455, y + size * .63, size * .09, size * .19)
    context.strokeStyle = ghost ? color : '#d2bd78'
    context.lineWidth = Math.max(1.5, size * .025)
    context.beginPath(); context.arc(x + size * .5, y + size * .43, size * .055, 0, Math.PI * 2); context.stroke()
    for (let blade = 0; blade < 4; blade += 1) {
      context.save(); context.translate(x + size * .5, y + size * .43); context.rotate(blade * Math.PI / 2 + .2)
      context.beginPath(); context.moveTo(size * .045, 0); context.lineTo(size * .31, -size * .055); context.lineTo(size * .28, size * .055); context.closePath(); context.stroke(); context.restore()
    }
    context.restore()
    return
  }
  if (kind === 'orchard') {
    const border = size * .055
    context.fillStyle = ghost ? color : '#485237'
    context.fillRect(x + border, y + border, size - border * 2, size - border * 2)
    context.strokeRect(x + border, y + border, size - border * 2, size - border * 2)
    context.shadowColor = 'transparent'
    for (let treeRow = 0; treeRow < 3; treeRow += 1) {
      for (let treeColumn = 0; treeColumn < 3; treeColumn += 1) {
        const treeX = x + size * (.22 + treeColumn * .28)
        const treeY = y + size * (.22 + treeRow * .28)
        context.fillStyle = ghost ? color : '#6c4e35'
        context.fillRect(treeX - size * .018, treeY + size * .035, size * .036, size * .09)
        context.fillStyle = ghost ? color : treeRow % 2 === treeColumn % 2 ? '#547044' : '#617b4b'
        context.beginPath(); context.arc(treeX, treeY, size * .09, 0, Math.PI * 2); context.fill(); context.stroke()
        context.fillStyle = ghost ? color : '#c58c4d'
        context.beginPath(); context.arc(treeX + size * .026, treeY - size * .018, size * .014, 0, Math.PI * 2); context.fill()
      }
    }
    context.restore()
    return
  }
  if (kind === 'farm') {
    const border = size * .055
    context.shadowBlur = ghost ? 0 : size * .04
    context.fillStyle = ghost ? color : '#6f5a35'
    context.fillRect(x + border, y + border, size - border * 2, size - border * 2)
    context.strokeRect(x + border, y + border, size - border * 2, size - border * 2)
    context.shadowColor = 'transparent'
    context.fillStyle = ghost ? 'rgba(24, 31, 24, .26)' : '#493f28'
    context.fillRect(x + size * .11, y + size * .12, size * .49, size * .7)
    context.strokeStyle = ghost ? 'rgba(24, 31, 24, .52)' : '#c4a554'
    context.lineWidth = Math.max(1, size * .014)
    for (let row = 0; row < 6; row += 1) {
      const cropY = y + size * (.17 + row * .105)
      context.beginPath(); context.moveTo(x + size * .14, cropY); context.lineTo(x + size * .57, cropY); context.stroke()
      for (let plant = 0; plant < 5; plant += 1) {
        const plantX = x + size * (.17 + plant * .085)
        context.beginPath(); context.moveTo(plantX, cropY - size * .024); context.lineTo(plantX, cropY + size * .024); context.stroke()
      }
    }
    context.fillStyle = ghost ? color : '#c1ad7d'
    context.strokeStyle = color
    context.lineWidth = Math.max(1, size * .02)
    context.fillRect(x + size * .66, y + size * .5, size * .23, size * .27)
    context.strokeRect(x + size * .66, y + size * .5, size * .23, size * .27)
    context.fillStyle = ghost ? color : '#925f3d'
    context.beginPath(); context.moveTo(x + size * .62, y + size * .51); context.lineTo(x + size * .775, y + size * .36); context.lineTo(x + size * .93, y + size * .51); context.closePath(); context.fill(); context.stroke()
    context.fillStyle = ghost ? 'rgba(24,31,24,.3)' : '#3c3528'
    context.fillRect(x + size * .745, y + size * .61, size * .06, size * .16)
    context.strokeStyle = ghost ? color : '#d1b968'
    context.lineWidth = Math.max(1, size * .012)
    context.strokeRect(x + border, y + border, size - border * 2, size - border * 2)
    for (const [postX, postY] of [[.055, .055], [.5, .055], [.945, .055], [.055, .5], [.945, .5], [.055, .945], [.5, .945], [.945, .945]]) context.fillRect(x + size * (postX - .01), y + size * (postY - .01), size * .02, size * .02)
    context.restore()
    return
  }
  if (kind === 'quarry') {
    const border = size * .055
    context.fillStyle = ghost ? color : '#53584f'
    context.fillRect(x + border, y + border, size - border * 2, size - border * 2)
    context.strokeRect(x + border, y + border, size - border * 2, size - border * 2)
    context.shadowColor = 'transparent'
    context.fillStyle = ghost ? 'rgba(24,31,24,.28)' : '#77786e'
    context.beginPath()
    context.moveTo(x + size * .1, y + size * .24)
    context.lineTo(x + size * .53, y + size * .1)
    context.lineTo(x + size * .88, y + size * .28)
    context.lineTo(x + size * .79, y + size * .79)
    context.lineTo(x + size * .25, y + size * .88)
    context.lineTo(x + size * .1, y + size * .57)
    context.closePath(); context.fill(); context.stroke()
    context.fillStyle = ghost ? 'rgba(24,31,24,.24)' : '#5e6059'
    context.beginPath(); context.ellipse(x + size * .48, y + size * .53, size * .29, size * .21, -.16, 0, Math.PI * 2); context.fill(); context.stroke()
    context.fillStyle = ghost ? 'rgba(24,31,24,.2)' : '#454a45'
    context.beginPath(); context.ellipse(x + size * .49, y + size * .56, size * .18, size * .12, -.16, 0, Math.PI * 2); context.fill()
    context.strokeStyle = ghost ? color : '#aaa99d'
    context.lineWidth = Math.max(1, size * .014)
    for (let ledge = 0; ledge < 3; ledge += 1) {
      context.beginPath(); context.arc(x + size * .49, y + size * .55, size * (.14 + ledge * .075), .2, Math.PI * 1.63); context.stroke()
    }
    context.fillStyle = ghost ? color : '#898b80'
    for (const [stoneX, stoneY, radius] of [[.2, .35, .045], [.28, .73, .055], [.68, .33, .06], [.72, .69, .04], [.83, .49, .05]] as const) {
      context.beginPath(); context.arc(x + size * stoneX, y + size * stoneY, size * radius, 0, Math.PI * 2); context.fill(); context.stroke()
    }
    context.strokeStyle = ghost ? color : '#c7ad67'
    context.lineWidth = Math.max(1, size * .018)
    context.beginPath(); context.moveTo(x + size * .73, y + size * .2); context.lineTo(x + size * .73, y + size * .62); context.moveTo(x + size * .63, y + size * .62); context.lineTo(x + size * .73, y + size * .2); context.lineTo(x + size * .83, y + size * .62); context.moveTo(x + size * .7, y + size * .31); context.lineTo(x + size * .86, y + size * .31); context.stroke()
    context.fillStyle = ghost ? color : '#725743'
    context.fillRect(x + size * .82, y + size * .29, size * .09, size * .08)
    context.restore()
    return
  }
  if (kind === 'mine') {
    context.fillStyle = ghost ? color : '#65675f'
    context.beginPath()
    context.moveTo(x + size * .08, y + size * .76)
    context.lineTo(x + size * .14, y + size * .34)
    context.lineTo(x + size * .36, y + size * .12)
    context.lineTo(x + size * .68, y + size * .18)
    context.lineTo(x + size * .89, y + size * .48)
    context.lineTo(x + size * .92, y + size * .78)
    context.closePath(); context.fill(); context.stroke()
    context.shadowColor = 'transparent'
    context.fillStyle = ghost ? 'rgba(24,31,24,.3)' : '#242824'
    context.beginPath(); context.arc(x + size * .5, y + size * .62, size * .2, Math.PI, 0); context.lineTo(x + size * .7, y + size * .83); context.lineTo(x + size * .3, y + size * .83); context.closePath(); context.fill()
    context.strokeStyle = ghost ? color : '#ad8954'
    context.lineWidth = Math.max(1, size * .055)
    context.beginPath(); context.moveTo(x + size * .29, y + size * .84); context.lineTo(x + size * .29, y + size * .6); context.arc(x + size * .5, y + size * .6, size * .21, Math.PI, 0); context.lineTo(x + size * .71, y + size * .84); context.stroke()
    context.lineWidth = Math.max(1, size * .035)
    context.beginPath(); context.moveTo(x + size * .24, y + size * .52); context.lineTo(x + size * .76, y + size * .52); context.stroke()
    context.strokeStyle = ghost ? color : '#c1a966'
    context.lineWidth = Math.max(1, size * .025)
    context.beginPath(); context.moveTo(x + size * .39, y + size * .84); context.lineTo(x + size * .46, y + size * .6); context.moveTo(x + size * .61, y + size * .84); context.lineTo(x + size * .54, y + size * .6); context.stroke()
    for (let sleeper = 0; sleeper < 3; sleeper += 1) {
      const sleeperY = y + size * (.67 + sleeper * .075)
      const halfWidth = size * (.045 + sleeper * .027)
      context.beginPath(); context.moveTo(x + size * .5 - halfWidth, sleeperY); context.lineTo(x + size * .5 + halfWidth, sleeperY); context.stroke()
    }
    context.fillStyle = ghost ? color : '#8d8170'
    for (const [stoneX, stoneY, radius] of [[.19, .72, .055], [.79, .71, .045], [.75, .35, .04]] as const) {
      context.beginPath(); context.arc(x + size * stoneX, y + size * stoneY, size * radius, 0, Math.PI * 2); context.fill(); context.stroke()
    }
    context.restore()
    return
  }
  if (kind === 'smelter') {
    const border = size * .055
    context.fillStyle = ghost ? color : '#51483d'
    context.fillRect(x + border, y + border, size - border * 2, size - border * 2)
    context.strokeRect(x + border, y + border, size - border * 2, size - border * 2)
    context.shadowColor = 'transparent'
    context.fillStyle = ghost ? color : '#a58e69'
    context.fillRect(x + size * .17, y + size * .43, size * .54, size * .36)
    context.strokeRect(x + size * .17, y + size * .43, size * .54, size * .36)
    context.fillStyle = ghost ? color : '#6d5542'
    context.fillRect(x + size * .58, y + size * .17, size * .15, size * .45)
    context.strokeRect(x + size * .58, y + size * .17, size * .15, size * .45)
    context.fillStyle = ghost ? 'rgba(42,31,26,.35)' : '#2d2925'
    context.beginPath(); context.arc(x + size * .39, y + size * .67, size * .13, Math.PI, 0); context.lineTo(x + size * .52, y + size * .77); context.lineTo(x + size * .26, y + size * .77); context.closePath(); context.fill()
    context.fillStyle = ghost ? color : '#d0783f'
    context.beginPath(); context.arc(x + size * .39, y + size * .7, size * .065, Math.PI, 0); context.fill()
    context.strokeStyle = ghost ? color : '#c8a65d'
    context.lineWidth = Math.max(1, size * .025)
    context.beginPath(); context.moveTo(x + size * .77, y + size * .58); context.lineTo(x + size * .9, y + size * .58); context.lineTo(x + size * .86, y + size * .78); context.lineTo(x + size * .73, y + size * .78); context.closePath(); context.stroke()
    context.fillStyle = ghost ? color : '#696c68'
    context.beginPath(); context.arc(x + size * .79, y + size * .7, size * .055, 0, Math.PI * 2); context.fill(); context.stroke()
    context.restore()
    return
  }
  if (kind === 'kitchen') {
    context.fillStyle = ghost ? color : '#b5a378'
    context.fillRect(x + size * .16, y + size * .38, size * .68, size * .46)
    context.strokeRect(x + size * .16, y + size * .38, size * .68, size * .46)
    context.fillStyle = ghost ? color : '#8b6043'
    context.beginPath(); context.moveTo(x + size * .1, y + size * .4); context.lineTo(x + size * .5, y + size * .14); context.lineTo(x + size * .9, y + size * .4); context.closePath(); context.fill(); context.stroke()
    context.fillStyle = ghost ? color : '#756352'
    context.fillRect(x + size * .66, y + size * .14, size * .12, size * .32)
    context.strokeRect(x + size * .66, y + size * .14, size * .12, size * .32)
    context.shadowColor = 'transparent'
    context.fillStyle = ghost ? 'rgba(30,35,28,.28)' : '#433a31'
    context.fillRect(x + size * .28, y + size * .57, size * .16, size * .27)
    context.fillStyle = ghost ? color : '#d8b55e'
    context.beginPath(); context.arc(x + size * .62, y + size * .64, size * .105, 0, Math.PI); context.lineTo(x + size * .515, y + size * .64); context.closePath(); context.fill(); context.stroke()
    context.strokeStyle = ghost ? color : '#d18a4f'
    context.lineWidth = Math.max(1, size * .02)
    context.beginPath(); context.moveTo(x + size * .58, y + size * .61); context.quadraticCurveTo(x + size * .55, y + size * .52, x + size * .59, y + size * .48); context.moveTo(x + size * .66, y + size * .61); context.quadraticCurveTo(x + size * .7, y + size * .52, x + size * .66, y + size * .46); context.stroke()
    context.restore()
    return
  }
  if (kind === 'barracks') {
    const border = size * .055
    context.fillStyle = ghost ? color : '#5b5542'
    context.fillRect(x + border, y + border, size - border * 2, size - border * 2)
    context.strokeRect(x + border, y + border, size - border * 2, size - border * 2)
    context.shadowColor = 'transparent'
    context.fillStyle = ghost ? 'rgba(24,31,24,.28)' : '#35372e'
    context.fillRect(x + size * .12, y + size * .48, size * .5, size * .33)
    context.strokeRect(x + size * .12, y + size * .48, size * .5, size * .33)
    context.fillStyle = ghost ? color : '#784e3d'
    context.beginPath(); context.moveTo(x + size * .08, y + size * .49); context.lineTo(x + size * .37, y + size * .29); context.lineTo(x + size * .66, y + size * .49); context.closePath(); context.fill(); context.stroke()
    context.fillStyle = ghost ? 'rgba(24,31,24,.3)' : '#252b26'
    context.fillRect(x + size * .31, y + size * .64, size * .12, size * .17)
    context.strokeStyle = ghost ? color : '#ddc373'
    context.lineWidth = Math.max(1, size * .018)
    context.beginPath(); context.moveTo(x + size * .71, y + size * .28); context.lineTo(x + size * .86, y + size * .69); context.moveTo(x + size * .86, y + size * .28); context.lineTo(x + size * .71, y + size * .69); context.stroke()
    for (let index = 0; index < 3; index += 1) {
      const dummyX = x + size * (.7 + index * .085)
      context.fillStyle = ghost ? color : '#bda760'
      context.beginPath(); context.arc(dummyX, y + size * .73, size * .025, 0, Math.PI * 2); context.fill()
      context.fillRect(dummyX - size * .009, y + size * .75, size * .018, size * .1)
    }
    context.strokeStyle = ghost ? color : '#d9bb63'
    context.beginPath(); context.moveTo(x + size * .18, y + size * .29); context.lineTo(x + size * .18, y + size * .13); context.lineTo(x + size * .34, y + size * .18); context.lineTo(x + size * .18, y + size * .22); context.stroke()
    context.restore()
    return
  }
  if (kind === 'church') {
    const border = size * .055
    context.fillStyle = ghost ? 'rgba(24,31,24,.24)' : '#4b4c40'
    context.fillRect(x + border, y + border, size - border * 2, size - border * 2)
    context.strokeRect(x + border, y + border, size - border * 2, size - border * 2)
    context.shadowColor = 'transparent'
    context.fillStyle = ghost ? color : '#b9aa83'
    context.fillRect(x + size * .3, y + size * .34, size * .4, size * .48)
    context.fillRect(x + size * .18, y + size * .5, size * .64, size * .22)
    context.strokeRect(x + size * .3, y + size * .34, size * .4, size * .48)
    context.strokeRect(x + size * .18, y + size * .5, size * .64, size * .22)
    context.fillStyle = ghost ? color : '#765d49'
    context.beginPath(); context.moveTo(x + size * .24, y + size * .51); context.lineTo(x + size * .5, y + size * .26); context.lineTo(x + size * .76, y + size * .51); context.closePath(); context.fill(); context.stroke()
    context.fillStyle = ghost ? color : '#c4b58d'
    context.fillRect(x + size * .4, y + size * .18, size * .2, size * .27)
    context.strokeRect(x + size * .4, y + size * .18, size * .2, size * .27)
    context.fillStyle = ghost ? color : '#6f5747'
    context.beginPath(); context.moveTo(x + size * .37, y + size * .19); context.lineTo(x + size * .5, y + size * .08); context.lineTo(x + size * .63, y + size * .19); context.closePath(); context.fill(); context.stroke()
    context.fillStyle = ghost ? 'rgba(24,31,24,.3)' : '#32342e'
    context.beginPath(); context.arc(x + size * .5, y + size * .71, size * .065, Math.PI, 0); context.lineTo(x + size * .565, y + size * .82); context.lineTo(x + size * .435, y + size * .82); context.closePath(); context.fill()
    context.strokeStyle = ghost ? color : '#e1cc82'
    context.lineWidth = Math.max(1, size * .017)
    context.beginPath(); context.moveTo(x + size * .5, y + size * .08); context.lineTo(x + size * .5, y + size * .015); context.moveTo(x + size * .46, y + size * .045); context.lineTo(x + size * .54, y + size * .045); context.stroke()
    context.restore()
    return
  }
  if (kind === 'wall') {
    context.fillRect(x + size * 0.08, y + size * 0.43, size * 0.84, size * 0.34)
    context.strokeRect(x + size * 0.08, y + size * 0.43, size * 0.84, size * 0.34)
    for (let index = 0; index < 4; index += 1) context.fillRect(x + size * (0.1 + index * 0.22), y + size * 0.29, size * 0.13, size * 0.16)
    context.restore()
    return
  }
  if (kind === 'tower') {
    context.fillRect(x + size * 0.25, y + size * 0.28, size * 0.5, size * 0.55)
    context.strokeRect(x + size * 0.25, y + size * 0.28, size * 0.5, size * 0.55)
    for (let index = 0; index < 3; index += 1) context.fillRect(x + size * (0.25 + index * 0.2), y + size * 0.16, size * 0.1, size * 0.14)
    context.fillStyle = ghost ? 'rgba(12,16,13,.32)' : '#37352d'
    context.fillRect(x + size * 0.43, y + size * 0.58, size * 0.14, size * 0.25)
    context.restore()
    return
  }
  if (kind === 'barbican') {
    context.fillRect(x + size * 0.12, y + size * 0.3, size * 0.28, size * 0.54)
    context.fillRect(x + size * 0.6, y + size * 0.3, size * 0.28, size * 0.54)
    context.fillRect(x + size * 0.32, y + size * 0.42, size * 0.36, size * 0.42)
    context.strokeRect(x + size * 0.12, y + size * 0.3, size * 0.76, size * 0.54)
    context.fillStyle = ghost ? 'rgba(12,16,13,.32)' : '#37352d'
    context.beginPath(); context.arc(x + size * 0.5, y + size * 0.72, size * 0.12, Math.PI, 0); context.lineTo(x + size * 0.62, y + size * 0.84); context.lineTo(x + size * 0.38, y + size * 0.84); context.closePath(); context.fill()
    context.restore()
    return
  }
  context.fillRect(x + inset, y + size * 0.42, size - inset * 2, size * 0.38)
  context.strokeRect(x + inset, y + size * 0.42, size - inset * 2, size * 0.38)
  context.shadowColor = 'transparent'
  if (!ghost) {
    context.fillStyle = 'rgba(77, 62, 43, .22)'
    context.fillRect(x + inset, y + size * .7, size - inset * 2, size * .1)
  }
  context.fillStyle = ghost ? color : roofColors[kind]
  context.beginPath()
  context.moveTo(x + size * 0.1, y + size * 0.44)
  context.lineTo(x + size * 0.5, y + size * 0.16)
  context.lineTo(x + size * 0.9, y + size * 0.44)
  context.closePath(); context.fill(); context.stroke()
  context.fillStyle = ghost ? 'rgba(12,16,13,.32)' : '#37352d'
  if (kind === 'lumberMill') {
    context.fillRect(x + size * 0.42, y + size * 0.5, size * 0.16, size * 0.3)
    context.strokeStyle = ghost ? color : '#d4c18c'
    context.beginPath(); context.arc(x + size * 0.72, y + size * 0.68, size * 0.11, 0, Math.PI * 2); context.stroke()
    for (let index = 0; index < 4; index += 1) {
      const angle = index * Math.PI / 2
      context.beginPath(); context.moveTo(x + size * .72, y + size * .68); context.lineTo(x + size * (.72 + Math.cos(angle) * .1), y + size * (.68 + Math.sin(angle) * .1)); context.stroke()
    }
  } else if (kind === 'huntingLodge') {
    context.fillRect(x + size * .42, y + size * .57, size * .16, size * .23)
    context.strokeStyle = ghost ? color : '#d8bd72'
    context.lineWidth = Math.max(1, size * .025)
    context.beginPath(); context.moveTo(x + size * .31, y + size * .6); context.quadraticCurveTo(x + size * .22, y + size * .52, x + size * .25, y + size * .41); context.moveTo(x + size * .31, y + size * .6); context.quadraticCurveTo(x + size * .4, y + size * .52, x + size * .37, y + size * .41); context.moveTo(x + size * .25, y + size * .45); context.lineTo(x + size * .2, y + size * .4); context.moveTo(x + size * .37, y + size * .45); context.lineTo(x + size * .42, y + size * .4); context.stroke()
    context.fillStyle = ghost ? color : '#b99655'
    context.beginPath(); context.arc(x + size * .31, y + size * .61, size * .035, 0, Math.PI * 2); context.fill()
  } else if (kind === 'market') {
    context.fillStyle = ghost ? color : '#d2a14c'
    context.fillRect(x + size * 0.23, y + size * 0.53, size * 0.54, size * 0.11)
    context.fillStyle = ghost ? color : '#7e4c36'
    for (let index = 0; index < 3; index += 1) context.fillRect(x + size * (.23 + index * .18), y + size * .53, size * .09, size * .11)
    context.strokeStyle = ghost ? color : '#dbc47b'
    for (let index = 0; index < 3; index += 1) {
      context.beginPath(); context.moveTo(x + size * (0.28 + index * 0.2), y + size * 0.48); context.lineTo(x + size * (0.28 + index * 0.2), y + size * 0.75); context.stroke()
    }
  } else if (kind === 'house') {
    context.fillRect(x + size * .43, y + size * .57, size * .14, size * .23)
    context.fillStyle = ghost ? color : '#e0c982'
    context.fillRect(x + size * .66, y + size * .55, size * .1, size * .1)
    context.fillStyle = ghost ? color : '#594332'
    context.fillRect(x + size * .69, y + size * .22, size * .09, size * .2)
  } else context.fillRect(x + size * 0.43, y + size * 0.57, size * 0.14, size * 0.23)
  context.restore()
}
