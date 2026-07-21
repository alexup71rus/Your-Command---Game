import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createManualHeightGrid, generateMap } from '../src/game/generator'
import { createMatch } from '../src/game/match'
import { mapPresets } from '../src/game/presets'
import { createMapScenario, foundAutomatedMatch } from '../src/game/scenario'
import { runAiSkirmish } from '../src/game/ai/testing/scenarioHarness'

const preset = mapPresets.find((candidate) => candidate.id === 'greenMarches')
if (!preset) throw new Error('Missing greenMarches map preset')
const settings = { ...preset.settings, mapSize: 50 }
const generated = generateMap(settings, createManualHeightGrid())
const scenarioResult = createMapScenario(generated, 2, settings.seed, {
  id: 'ai-visual-replay', name: 'AI visual replay',
})
if (!scenarioResult.ok) throw new Error(scenarioResult.reason)
const scenario = foundAutomatedMatch(scenarioResult.scenario, ['svyatobor', 'radomir'])
const run = runAiSkirmish(createMatch(scenario), { rounds: 90 })
const participants = scenario.participants.map((participant) => ({
  id: participant.id,
  profile: participant.profileId,
  region: participant.regionId,
}))
const regionIndex = new Map(participants.map((participant, index) => [participant.region, index]))
const terrain = scenario.cells.map((row, rowIndex) => row.map((cell, column) => ({
  l: cell.landform === 'peak' ? 2 : cell.landform === 'hill' ? 1 : 0,
  v: Number(Boolean(cell.vegetation)),
  r: regionIndex.get(scenario.territories[rowIndex]?.[column] ?? '') ?? -1,
})))
const compactSnapshot = (snapshot: typeof run.initialSnapshot) => ({
  round: snapshot.round,
  status: snapshot.status,
  domains: Object.fromEntries(Object.entries(snapshot.domains).map(([ownerId, domain]) => [ownerId, {
    p: domain.population,
    r: domain.resources,
  }])),
  objects: snapshot.objects.map(({ position, object }) => ({
    x: position.column,
    y: position.row,
    o: object.ownerId,
    t: object.type === 'castle' ? 'c' : object.type === 'squad' ? 's' : 'b',
    k: object.type === 'building' ? object.kind : undefined,
    h: object.type === 'squad' ? object.health : object.hitPoints,
    m: object.type === 'squad' ? undefined : object.maxHitPoints,
    u: object.type === 'squad'
      ? [object.units.militia, object.units.spearmen, object.units.archers, object.units.knights]
      : undefined,
  })),
})
const commandLabel = (command: (typeof run.turns)[number]['executed'][number]) => {
  if (command.type === 'move-or-attack') return `move/attack ${command.from.column},${command.from.row} → ${command.to.column},${command.to.row}`
  if (command.type === 'build') return `build ${command.building} @ ${command.position.column},${command.position.row}`
  if (command.type === 'recruit') return `recruit ${command.quantity} ${command.troop}`
  if (command.type === 'demolish') return `demolish @ ${command.position.column},${command.position.row}`
  if (command.type === 'trade') return `${command.direction} ${command.quantity} ${command.resource}`
  if (command.type === 'tower-attack') return `tower attack ${command.to.column},${command.to.row}`
  if (command.type === 'garrison') return `garrison tower ${command.tower.column},${command.tower.row}`
  if (command.type === 'ungarrison') return `ungarrison tower ${command.tower.column},${command.tower.row}`
  if (command.type === 'split') return `split squad @ ${command.from.column},${command.from.row}`
  if (command.type === 'dismiss') return `dismiss troops @ ${command.from.column},${command.from.row}`
  return `tax: ${command.rate}`
}
const frames = [{
  ...compactSnapshot(run.initialSnapshot), owner: null, phase: 'initial', wave: 'none', commands: [],
  nodes: 0,
}, ...run.turns.map((turn) => ({
  ...compactSnapshot(turn.snapshot), owner: turn.ownerId, phase: turn.phase, wave: turn.wave,
  nodes: turn.exploredNodes,
  commands: [...turn.executed.map((command) => {
    const trace = turn.trace.find((entry) => entry.command
      && JSON.stringify(entry.command) === JSON.stringify(command) && !entry.rejectedReason)
    const tacticalFactors = trace?.factors.filter((factor) => (
      factor === 'core-breach-response'
        || factor === 'committed-defense-contact'
        || factor === 'consolidate-force'
        || factor === 'certain-destruction'
        || factor.startsWith('projected-reply-loss:')
        || factor.startsWith('defense-concentration:')
        || factor.startsWith('plan-review:')
    )) ?? []
    return `${commandLabel(command)}${tacticalFactors.length > 0 ? ` · ${tacticalFactors.join(', ')}` : ''}`
  }), ...turn.cancellations.map(({ command, reason }) => `replan after ${commandLabel(command)} · ${reason}`),
  ...turn.trace.filter((entry) => entry.factors.includes('no-tactical-selection')).slice(-1)
    .map((entry) => `no tactical selection · ${entry.factors.slice(1).join(', ')}`)],
}))]
const data = JSON.stringify({ participants, terrain, frames }).replaceAll('<', '\\u003c')
const outputPath = resolve(process.env.AI_REPLAY_OUTPUT ?? 'ai-behavior-replay.html')

const html = `<div id="ai-behavior-replay">
<style>
#ai-behavior-replay{--bg:var(--color-background-primary,#f5f0e6);--panel:var(--color-background-secondary,#fffaf0);--text:var(--color-text-primary,#241d16);--muted:var(--color-text-secondary,#74695c);--border:var(--color-border-secondary,#d6c9b8);--accent:var(--color-accent-primary,#9b3d28);color:var(--text);background:var(--bg);font:13px/1.35 ui-sans-serif,system-ui,sans-serif;border:1px solid var(--border);border-radius:18px;overflow:hidden}
#ai-behavior-replay *{box-sizing:border-box}#ai-behavior-replay .top{padding:16px 18px 10px;background:linear-gradient(120deg,color-mix(in srgb,var(--accent) 13%,var(--panel)),var(--panel));border-bottom:1px solid var(--border)}
#ai-behavior-replay h2{margin:0 0 4px;font:700 18px/1.2 ui-serif,Georgia,serif}#ai-behavior-replay .sub{color:var(--muted)}#ai-behavior-replay .layout{display:grid;grid-template-columns:minmax(320px,1.45fr) minmax(260px,.75fr);gap:14px;padding:14px}
#ai-behavior-replay .mapbox,#ai-behavior-replay .card{background:var(--panel);border:1px solid var(--border);border-radius:14px}#ai-behavior-replay .mapbox{padding:10px}#ai-behavior-replay canvas{display:block;width:100%;aspect-ratio:1;border-radius:9px;background:#d8ccb8}
#ai-behavior-replay .controls{display:grid;grid-template-columns:auto auto auto 1fr auto;align-items:center;gap:8px;margin-top:10px}#ai-behavior-replay button{border:1px solid var(--border);background:var(--panel);color:var(--text);border-radius:9px;padding:6px 9px;cursor:pointer}#ai-behavior-replay button:hover{border-color:var(--accent)}#ai-behavior-replay input{width:100%;accent-color:var(--accent)}
#ai-behavior-replay .side{display:flex;flex-direction:column;gap:10px;min-width:0}#ai-behavior-replay .card{padding:12px}#ai-behavior-replay .headline{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}#ai-behavior-replay .round{font-weight:750;font-size:15px}#ai-behavior-replay .badge{white-space:nowrap;padding:3px 7px;border-radius:999px;background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--accent);font-weight:700}
#ai-behavior-replay table{width:100%;border-collapse:collapse;margin-top:8px}#ai-behavior-replay th,#ai-behavior-replay td{text-align:left;padding:6px 4px;border-top:1px solid var(--border);vertical-align:top}#ai-behavior-replay th{color:var(--muted);font-weight:600}#ai-behavior-replay .dot{width:9px;height:9px;border-radius:50%;display:inline-block;margin-right:5px}#ai-behavior-replay .commands{max-height:180px;overflow:auto;margin:7px 0 0;padding-left:20px}#ai-behavior-replay .commands li{margin:3px 0}#ai-behavior-replay .legend{display:flex;flex-wrap:wrap;gap:9px;color:var(--muted);margin-top:8px}#ai-behavior-replay .legend b{color:var(--text)}
@media(max-width:760px){#ai-behavior-replay .layout{grid-template-columns:1fr}#ai-behavior-replay .controls{grid-template-columns:auto auto auto 1fr}#ai-behavior-replay .frame{grid-column:1/-1;text-align:right}}
</style>
<div class="top"><h2>AI behavior replay</h2><div class="sub">Authoritative Святобор vs Радомир run · drag the timeline or press play</div></div>
<div class="layout"><div class="mapbox"><canvas aria-label="AI match map replay"></canvas><div class="controls"><button class="prev" title="Previous action">◀</button><button class="play">Play</button><button class="next" title="Next action">▶</button><input class="range" type="range" min="0" value="0"><span class="frame"></span></div><div class="legend"><span><b>■</b> castle</span><span><b>▰</b> building / wall</span><span><b>●</b> squad (number = units)</span><span>dark cells = forest</span></div></div><div class="side"><div class="card state"></div><div class="card"><b>Commands in this action</b><ol class="commands"></ol></div><div class="card"><b>What to inspect</b><div class="sub" style="margin-top:6px">Watch whether weak groups reinforce or merge instead of forming a one-unit stream; whether viable interceptions spend enough consecutive orders to make contact; whether defenders leave archer firing lanes through cover; and whether a castle breach recalls the field army immediately.</div></div></div></div>
<script>(()=>{const root=document.querySelector('#ai-behavior-replay');if(!root)return;const data=${data};const colors=['#b54832','#345b9d','#3f7b54'];const canvas=root.querySelector('canvas'),ctx=canvas.getContext('2d'),range=root.querySelector('.range'),frameLabel=root.querySelector('.frame'),stateBox=root.querySelector('.state'),commands=root.querySelector('.commands'),play=root.querySelector('.play');range.max=String(data.frames.length-1);let index=0,timer=null;
const resize=()=>{const size=Math.max(320,Math.floor(canvas.clientWidth));const ratio=Math.min(2,window.devicePixelRatio||1);canvas.width=size*ratio;canvas.height=size*ratio;ctx.setTransform(ratio,0,0,ratio,0,0);render()};
const ownerIndex=id=>data.participants.findIndex(p=>p.id===id);const label=id=>{const p=data.participants.find(p=>p.id===id);return p?(p.profile+' '+id.split('-').at(-1)):id};const total=u=>u?u.reduce((a,b)=>a+b,0):0;
function render(){const f=data.frames[index],n=data.terrain.length,size=canvas.clientWidth,cell=size/n;ctx.clearRect(0,0,size,size);for(let y=0;y<n;y++)for(let x=0;x<n;x++){const t=data.terrain[y][x],base=t.l===2?'#8e877b':t.l===1?'#c5ac7d':'#d9cba9';ctx.fillStyle=base;ctx.fillRect(x*cell,y*cell,cell+.4,cell+.4);if(t.r>=0){ctx.fillStyle=colors[t.r]+'24';ctx.fillRect(x*cell,y*cell,cell+.4,cell+.4)}if(t.v){ctx.fillStyle='#274d33aa';ctx.fillRect(x*cell,y*cell,cell+.4,cell+.4)}}
for(const o of f.objects){const c=colors[Math.max(0,ownerIndex(o.o))]||'#333',cx=(o.x+.5)*cell,cy=(o.y+.5)*cell;if(o.t==='c'){ctx.fillStyle=c;ctx.fillRect(cx-cell*.43,cy-cell*.43,cell*.86,cell*.86);ctx.strokeStyle='#fff';ctx.lineWidth=Math.max(1,cell*.1);ctx.strokeRect(cx-cell*.43,cy-cell*.43,cell*.86,cell*.86)}else if(o.t==='b'){ctx.fillStyle=o.k==='wall'?'#4c4338':c;const s=o.k==='wall'?cell*.72:cell*.58;ctx.fillRect(cx-s/2,cy-s/2,s,s);if(o.k==='tower'){ctx.strokeStyle='#fff';ctx.lineWidth=1;ctx.strokeRect(cx-s/2,cy-s/2,s,s)}}else{const radius=Math.max(3,cell*.42);ctx.beginPath();ctx.arc(cx,cy,radius,0,Math.PI*2);ctx.fillStyle=c;ctx.fill();ctx.strokeStyle='#fff';ctx.lineWidth=Math.max(1,cell*.08);ctx.stroke();ctx.fillStyle='#fff';ctx.font='700 '+Math.max(8,cell*.65)+'px system-ui';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(String(total(o.u)),cx,cy)}}
range.value=String(index);frameLabel.textContent=(index+1)+' / '+data.frames.length;const acting=f.owner?label(f.owner):'initial state';stateBox.innerHTML='<div class="headline"><div><div class="round">Round '+f.round+' · '+acting+'</div><div class="sub">phase '+f.phase+' · wave '+f.wave+' · planner '+f.nodes+' nodes</div></div><span class="badge">'+f.status+'</span></div><table><thead><tr><th>Owner</th><th>Pop / army</th><th>Castle</th><th>Stores</th></tr></thead><tbody>'+data.participants.map((p,i)=>{const d=f.domains[p.id],objs=f.objects.filter(o=>o.o===p.id),army=objs.filter(o=>o.t==='s').reduce((s,o)=>s+total(o.u),0),castle=objs.find(o=>o.t==='c'),r=d?.r||{};return '<tr><td><span class="dot" style="background:'+colors[i]+'"></span>'+label(p.id)+'</td><td>'+(d?.p??0)+' / '+army+'</td><td>'+(castle?Math.round(castle.h)+'/'+castle.m:'defeated')+'</td><td>W '+Math.round(r.wood||0)+' · S '+Math.round(r.stone||0)+' · G '+Math.round(r.gold||0)+'</td></tr>'}).join('')+'</tbody></table>';commands.innerHTML=(f.commands.length?f.commands:['no commands']).map(c=>'<li>'+c+'</li>').join('')}
const set=i=>{index=Math.max(0,Math.min(data.frames.length-1,i));render()};root.querySelector('.prev').onclick=()=>set(index-1);root.querySelector('.next').onclick=()=>set(index+1);range.oninput=()=>set(Number(range.value));play.onclick=()=>{if(timer){clearInterval(timer);timer=null;play.textContent='Play';return}play.textContent='Pause';timer=setInterval(()=>{if(index>=data.frames.length-1){clearInterval(timer);timer=null;play.textContent='Play';return}set(index+1)},420)};new ResizeObserver(resize).observe(canvas);resize()})();</script>
</div>`

writeFileSync(outputPath, html)
console.log(`AI replay written to ${outputPath} (${frames.length} frames)`)
