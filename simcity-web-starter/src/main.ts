import type { EraTag, ZoneType } from './lib/types'

// DOM elements
const canvas = document.getElementById('view') as HTMLCanvasElement
const hudEra = document.getElementById('era') as HTMLSelectElement
const fpsEl = document.getElementById('fps') as HTMLElement
const zoomEl = document.getElementById('zoom') as HTMLElement
const populationEl = document.getElementById('population') as HTMLElement
const budgetEl = document.getElementById('budget') as HTMLElement

// State
let seed = Math.floor(Math.random() * 0xffffffff) >>> 0
let currentTool: 'road' | 'zone-r' | 'zone-c' | 'zone-i' = 'road'
let mouseDown = false
let paintStart: { x: number, y: number } | null = null
let isTimelapsing = false
let isPaused = false
let population = 0
let budget = 50000

// Workers
const renderWorker = new Worker(new URL('./workers/render.worker.ts', import.meta.url), { type: 'module' })
const simWorker = new Worker(new URL('./workers/sim.worker.ts', import.meta.url), { type: 'module' })
const procgenWorker = new Worker(new URL('./workers/procgen.worker.ts', import.meta.url), { type: 'module' })
const aiWorker = new Worker(new URL('./workers/ai.worker.ts', import.meta.url), { type: 'module' })

// Initialize canvas and workers
function initCanvasToWorker() {
  if ('transferControlToOffscreen' in canvas) {
    // Set initial canvas size before transferring control
    canvas.width = window.innerWidth
    canvas.height = window.innerHeight
    
    const offscreen = (canvas as any).transferControlToOffscreen()
    renderWorker.postMessage({ type: 'init', canvas: offscreen }, [offscreen])
    
    // Handle window resizing
    window.addEventListener('resize', () => {
      renderWorker.postMessage({ 
        type: 'resize', 
        width: window.innerWidth, 
        height: window.innerHeight 
      })
    })
  } else {
    // Fallback for browsers without OffscreenCanvas
    const ctx = (canvas as HTMLCanvasElement).getContext('2d')!
    const fit = () => { 
      (canvas as HTMLCanvasElement).width = window.innerWidth;
      (canvas as HTMLCanvasElement).height = window.innerHeight 
    }
    fit()
    window.addEventListener('resize', fit)
    
    function draw() {
      ctx.fillStyle = '#10131a'
      ctx.fillRect(0, 0, (canvas as HTMLCanvasElement).width, (canvas as HTMLCanvasElement).height)
      ctx.fillStyle = '#9ca3af'
      ctx.fillText('OffscreenCanvas not supported. WebGL rendering disabled.', 20, 30)
      requestAnimationFrame(draw)
    }
    draw()
  }
}

// Track current pan/zoom from renderer
let currentIsoPan = { x: 0, y: 0 }
let currentIsoZoom = 1.0

// Convert screen coordinates to world coordinates with grid snapping
function screenToWorld(screenX: number, screenY: number, snapToGrid: boolean = false): { x: number, z: number } {
  const GRID_SIZE = 1000
  const aspect = window.innerWidth / window.innerHeight

  // Convert to NDC space (-1 to 1)
  const ndcX = (screenX / window.innerWidth) * 2 - 1
  const ndcY = -((screenY / window.innerHeight) * 2 - 1)

  // Account for pan (stored in pixels, convert to NDC)
  const panNdcX = currentIsoPan.x / window.innerWidth * 2
  const panNdcY = currentIsoPan.y / window.innerHeight * 2

  const X = ndcX - panNdcX
  const Y = ndcY + panNdcY

  // Inverse isometric transform matching renderer's matrix
  const scale = 2.0 * currentIsoZoom / GRID_SIZE
  const sqrt3 = Math.sqrt(3)

  const worldX = (Y / scale) + (aspect / (sqrt3 * scale)) * X
  const worldZ = (Y / scale) - (aspect / (sqrt3 * scale)) * X

  // Convert from render coordinates (-500..500) to procgen coordinates (0..2000)
  const finalX = (worldX + GRID_SIZE / 2) * 2
  const finalZ = (worldZ + GRID_SIZE / 2) * 2

  if (snapToGrid) {
    const gridSize = 40
    const snappedX = Math.round(finalX / gridSize) * gridSize
    const snappedZ = Math.round(finalZ / gridSize) * gridSize
    return { x: snappedX, z: snappedZ }
  }

  return { x: finalX, z: finalZ }
}

// Set up mouse interactions
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0) { // Left click
    mouseDown = true
    // Use grid snapping for road tool
    const snapToGrid = currentTool === 'road'
    const world = screenToWorld(e.clientX, e.clientY, snapToGrid)
    paintStart = { x: world.x, y: world.z }
    console.log('[Main] Mouse down - Tool:', currentTool, 'at screen:', e.clientX, e.clientY, 'world:', world, 'snapped:', snapToGrid)
  }
})

canvas.addEventListener('mousemove', (e) => {
  // Only send mouse movement to renderer for camera control with right button
  if (e.buttons === 2) {
    renderWorker.postMessage({
      type: 'mouse-move',
      x: e.clientX,
      y: e.clientY,
      buttons: e.buttons
    })
  }
  
  // Handle painting preview with left button (but don't actually paint until mouseup)
  if (mouseDown && paintStart && e.buttons === 1) {
    if (currentTool === 'road') {
      // Show ghost/preview road while dragging
      const snapToGrid = true
      const world = screenToWorld(e.clientX, e.clientY, snapToGrid)
      
      // Create preview road segment
      const endPoint = { x: world.x, y: world.z }
      
      // Force road to be either horizontal or vertical
      const dx = Math.abs(endPoint.x - paintStart.x)
      const dz = Math.abs(endPoint.y - paintStart.y)
      
      if (dx > dz) {
        endPoint.y = paintStart.y  // Horizontal
      } else {
        endPoint.x = paintStart.x  // Vertical
      }
      
      // Send preview to renderer
      const previewSegment = new Float32Array(6)
      previewSegment[0] = paintStart.x
      previewSegment[1] = paintStart.y
      previewSegment[2] = endPoint.x
      previewSegment[3] = endPoint.y
      previewSegment[4] = 12  // Standard street width
      previewSegment[5] = 0
      
      renderWorker.postMessage({
        type: 'preview-road',
        segment: previewSegment
      })
    }
  }
})

canvas.addEventListener('mouseup', (e) => {
  // Always send mouse up to renderer to reset drag state
  renderWorker.postMessage({
    type: 'mouse-up'
  })
  
  if (e.button === 0 && mouseDown) {
    mouseDown = false
    
    if (paintStart) {
      // Use grid snapping for road tool
      const snapToGrid = currentTool === 'road'
      const world = screenToWorld(e.clientX, e.clientY, snapToGrid)
      
      if (currentTool === 'road') {
        // Paint road segment - ensure it's axis-aligned
        const endPoint = { x: world.x, y: world.z }
        
        // Force road to be either horizontal or vertical
        const dx = Math.abs(endPoint.x - paintStart.x)
        const dz = Math.abs(endPoint.y - paintStart.y)
        
        if (dx > dz) {
          // Horizontal road
          endPoint.y = paintStart.y
        } else {
          // Vertical road
          endPoint.x = paintStart.x
        }
        
        console.log('[Main] Painting road from', paintStart, 'to', endPoint)
        procgenWorker.postMessage({
          type: 'paint-road',
          start: paintStart,
          end: endPoint,
          roadClass: 'street'
        })
      } else if (currentTool.startsWith('zone-')) {
        // Paint zone as a rectangle
        console.log('[Main] Zone tool detected:', currentTool)
        console.log('[Main] Paint start:', paintStart, 'Paint end:', world)
        const minX = Math.min(paintStart.x, world.x)
        const maxX = Math.max(paintStart.x, world.x)
        const minZ = Math.min(paintStart.y, world.z)
        const maxZ = Math.max(paintStart.y, world.z)
        
        // Ensure we have a minimum size for the zone
        const width = Math.abs(maxX - minX)
        const height = Math.abs(maxZ - minZ)
        
        if (width < 20 || height < 20) {
          // If zone is too small, make it at least 40x40
          const centerX = (minX + maxX) / 2
          const centerZ = (minZ + maxZ) / 2
          const finalMinX = centerX - 20
          const finalMaxX = centerX + 20
          const finalMinZ = centerZ - 20
          const finalMaxZ = centerZ + 20
          
          const zoneMap: Record<string, 'residential' | 'commercial' | 'industrial'> = {
            'zone-r': 'residential',
            'zone-c': 'commercial',
            'zone-i': 'industrial'
          }
          
          console.log('[Main] Painting zone (adjusted):', currentTool, 'bounds:', finalMinX, finalMinZ, finalMaxX, finalMaxZ)
          
          procgenWorker.postMessage({
            type: 'paint-zone',
            polygon: [
              { x: finalMinX, y: finalMinZ },
              { x: finalMaxX, y: finalMinZ },
              { x: finalMaxX, y: finalMaxZ },
              { x: finalMinX, y: finalMaxZ }
            ],
            zoneType: zoneMap[currentTool],
            zoneDensity: 'medium',
            subdivisionMethod: 'skeleton'
          })
        } else {
          const zoneMap: Record<string, 'residential' | 'commercial' | 'industrial'> = {
            'zone-r': 'residential',
            'zone-c': 'commercial',
            'zone-i': 'industrial'
          }
          
          console.log('[Main] Painting zone:', currentTool, 'from', paintStart, 'to', world)
          console.log('[Main] Zone bounds:', minX, minZ, maxX, maxZ)
          
          procgenWorker.postMessage({
            type: 'paint-zone',
            polygon: [
              { x: minX, y: minZ },
              { x: maxX, y: minZ },
              { x: maxX, y: maxZ },
              { x: minX, y: maxZ }
            ],
            zoneType: zoneMap[currentTool],
            zoneDensity: 'medium',
            subdivisionMethod: 'skeleton'
          })
        }
      }
    }
    
    paintStart = null
  }
})

canvas.addEventListener('wheel', (e) => {
  e.preventDefault()
  renderWorker.postMessage({
    type: 'mouse-wheel',
    deltaY: e.deltaY
  })
})

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault() // Prevent context menu on right click
})

// Wire up worker messages
renderWorker.onmessage = (e) => {
  const msg = e.data
  if (msg.type === 'stats') {
    fpsEl.textContent = msg.fps.toFixed(0)
    if (msg.zoom !== undefined) {
      zoomEl.textContent = msg.zoom.toFixed(1) + 'x'
    }
  } else if (msg.type === 'camera-update') {
    // Update tracked camera state for coordinate conversion
    currentIsoZoom = msg.zoom || 1.0
    currentIsoPan.x = msg.panX || 0
    currentIsoPan.y = msg.panY || 0
  }
}

simWorker.onmessage = (e) => {
  const msg = e.data
  
  switch (msg.type) {
    case 'growth-event':
      // Handle building spawns/upgrades
      console.log('[Main] Growth event:', msg.event, 'for zone', msg.zoneId, 'type:', msg.zoneType, 'level:', msg.level)
      break
      
    case 'generate-building':
      // Forward building generation request to procgen worker
      console.log('[Main] Generate building for zone', msg.zoneId, msg.zoneType, 'level:', msg.buildingLevel)
      procgenWorker.postMessage({
        type: 'generate-building-for-zone',
        zoneId: msg.zoneId,
        zoneType: msg.zoneType,
        zoneDensity: msg.zoneDensity,
        level: msg.buildingLevel || 1,  // Ensure level is set
        position: msg.position,
        event: 'spawn'  // Add the event type
      })
      break
      
    case 'demand-data':
      // Update HUD with demand levels
      console.log('Demand:', msg.demand)
      if (msg.demand) {
        const demandR = document.getElementById('demand-r') as HTMLElement
        const demandC = document.getElementById('demand-c') as HTMLElement
        const demandI = document.getElementById('demand-i') as HTMLElement
        if (demandR) demandR.style.height = Math.max(0, Math.min(100, msg.demand.residential * 100)) + '%'
        if (demandC) demandC.style.height = Math.max(0, Math.min(100, msg.demand.commercial * 100)) + '%'
        if (demandI) demandI.style.height = Math.max(0, Math.min(100, msg.demand.industrial * 100)) + '%'
      }
      break
      
    case 'stats-data':
      // Update city statistics
      console.log('City stats:', msg.stats)
      if (msg.stats) {
        if (msg.stats.population !== undefined) {
          population = msg.stats.population
          populationEl.textContent = population.toLocaleString()
        }
        if (msg.stats.budget !== undefined) {
          budget = msg.stats.budget
          budgetEl.textContent = '$' + budget.toLocaleString()
        }
      }
      break
  }
}

procgenWorker.onmessage = (e) => {
  const msg = e.data
  console.log('[Main] Message from procgen:', msg.type)
  
  switch (msg.type) {
    case 'roads-generated':
      console.log('[Main] Roads generated, sending to renderer. Segments:', msg.segments?.length)
      // Convert road segments to typed array for renderer
      if (msg.segments && msg.segments.length > 0) {
        const segmentArray = new Float32Array(msg.segments.length * 6)
        for (let i = 0; i < msg.segments.length; i++) {
          const seg = msg.segments[i]
          const idx = i * 6
          segmentArray[idx] = seg.start.x
          segmentArray[idx + 1] = seg.start.y
          segmentArray[idx + 2] = seg.end.x
          segmentArray[idx + 3] = seg.end.y
          segmentArray[idx + 4] = seg.width
          segmentArray[idx + 5] = 0 // road class as number (not used yet)
        }
        
        renderWorker.postMessage({
          type: 'update-roads',
          data: { roadSegments: segmentArray }
        })
      }
      
      // Send to sim for traffic calculation
      simWorker.postMessage({
        type: 'update-roads',
        roads: msg.segments
      })
      break
      
    case 'parcels-generated':
      // Send zone data to sim
      simWorker.postMessage({
        type: 'update-zones',
        zones: msg.parcels
      })
      break
      
    case 'buildings-generated':
      // Send building meshes to renderer
      renderWorker.postMessage({
        type: 'update-buildings',
        data: { buildings: msg.buildings }
      })
      break
    case 'building-spawned':
      // Handle single building spawn for zone growth
      console.log('[Main] Building spawned for zone', msg.zoneId, 'parcel', msg.parcelId)
      if (msg.meshData) {
        renderWorker.postMessage({
          type: 'add-building',
          data: {
            buildingId: msg.building?.id,
            parcelId: msg.parcelId,
            meshData: msg.meshData,
            lod: msg.lod
          }
        })
      }
      break
    case 'zones-updated':
      // Send zone data to renderer
      console.log('[Main] Zones updated, sending to renderer')
      renderWorker.postMessage({
        type: 'update-zones',
        data: msg.data
      })
      break
    case 'road-painted':
      // Send updated road data to renderer
      console.log('[Main] Road painted, success:', msg.success)
      if (msg.success && msg.segments) {
        // Convert road segments to typed array
        const segmentArray = new Float32Array(msg.segments.length * 6)
        for (let i = 0; i < msg.segments.length; i++) {
          const seg = msg.segments[i]
          const idx = i * 6
          segmentArray[idx] = seg.start.x
          segmentArray[idx + 1] = seg.start.y
          segmentArray[idx + 2] = seg.end.x
          segmentArray[idx + 3] = seg.end.y
          segmentArray[idx + 4] = seg.width
          segmentArray[idx + 5] = 0
        }
        
        renderWorker.postMessage({
          type: 'update-roads',
          data: { roadSegments: segmentArray }
        })
      }
      break
    case 'zone-painted':
      // Send updated zone data to renderer and simulation
      console.log('[Main] Zone painted, affected parcels:', msg.affectedParcels?.length || msg.affectedParcelIds?.length)
      console.log('[Main] Parcels data:', msg.parcels)
      if (msg.parcels) {
        renderWorker.postMessage({
          type: 'update-zones',
          data: msg.parcels  // Send the entire parcels object directly
        })
      }
      
      // Send zones to simulation for building spawning
      if (msg.affectedParcels && msg.affectedParcels.length > 0) {
        console.log('[Main] Sending', msg.affectedParcels.length, 'zones to simulation')
        for (const parcel of msg.affectedParcels) {
          const zoneData = {
            id: parcel.id,
            type: parcel.zoneType === 'residential' ? 'R' : 
                  parcel.zoneType === 'commercial' ? 'C' : 'I',
            position: { x: parcel.centroid.x, y: parcel.centroid.y },
            area: parcel.area,
            frontage: parcel.frontage
          }
          console.log('[Main] Adding zone to sim:', zoneData)
          simWorker.postMessage({
            type: 'add-zone',
            zone: zoneData
          })
        }
      }
      break
  }
}

// UI event handlers
hudEra.addEventListener('change', () => {
  const era = hudEra.value as EraTag
  simWorker.postMessage({ type: 'set-era', era })
  renderWorker.postMessage({ type: 'set-era', era })
  procgenWorker.postMessage({ type: 'set-era', era })
})

// Listen for tool changes from the new UI
window.addEventListener('tool-changed', (e: any) => {
  currentTool = e.detail as typeof currentTool
  console.log('[Main] Tool changed to:', currentTool)
})

// Listen for action events from new UI
window.addEventListener('toggle-pause', () => {
  isPaused = !isPaused
  simWorker.postMessage({ type: 'toggle-pause' })
})

window.addEventListener('shuffle-seed', () => {
  seed = (seed + 1) >>> 0
  procgenWorker.postMessage({ type: 'shuffle-seed', seed })
  simWorker.postMessage({ type: 'boot', seed })
})

window.addEventListener('toggle-timelapse', () => {
  isTimelapsing = !isTimelapsing
  
  if (isTimelapsing) {
    // Cycle through eras automatically
    let eraIndex = hudEra.selectedIndex
    const cycleEra = () => {
      if (!isTimelapsing) return
      
      eraIndex = (eraIndex + 1) % hudEra.options.length
      hudEra.selectedIndex = eraIndex
      hudEra.dispatchEvent(new Event('change'))
      
      setTimeout(cycleEra, 3000) // Change era every 3 seconds
    }
    cycleEra()
  }
})

// Initialize everything
function init() {
  initCanvasToWorker()
  
  // Boot all workers
  const era = hudEra.value as EraTag
  simWorker.postMessage({ type: 'boot', seed })
  procgenWorker.postMessage({ type: 'boot', seed, era })
  aiWorker.postMessage({ type: 'boot' })
  renderWorker.postMessage({ type: 'boot' })
  
  // Request initial road generation
  setTimeout(() => {
    procgenWorker.postMessage({ type: 'get-roads' })
  }, 100)
  
  // Set up periodic updates for UI
  setInterval(() => {
    simWorker.postMessage({ type: 'get-demand' })
    simWorker.postMessage({ type: 'get-stats' })
  }, 1000) // Update every second
}

// Keyboard shortcuts are now handled in the HTML

// Start the application
init()

// Display welcome message
console.log('%cSimCity Web Prototype', 'font-size: 20px; font-weight: bold; color: #4CAF50')
console.log('Controls:')
console.log('  Left Mouse: Paint roads/zones or rotate camera')
console.log('  Right Mouse: Pan camera')
console.log('  Mouse Wheel: Zoom in/out')
console.log('  Keys 1-4: Switch tools (Road, Zone R/C/I)')
console.log('  Space: Pause/resume simulation')