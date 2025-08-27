import type { EraTag } from '../lib/types'

// Renderer state
let canvas: OffscreenCanvas | null = null
let gl: WebGL2RenderingContext | null = null
let era: EraTag = '2010s'

// Camera state
interface Camera {
  position: Float32Array    // [x, y, z]
  target: Float32Array      // [x, y, z]
  up: Float32Array          // [x, y, z]
  fov: number              // field of view in degrees
  near: number
  far: number
  viewMatrix: Float32Array
  projMatrix: Float32Array
  viewProjMatrix: Float32Array
}

// Initialize identity matrix
function identity(): Float32Array {
  const m = new Float32Array(16)
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1
  return m
}

const camera: Camera = {
  position: new Float32Array([50, 50, 50]),
  target: new Float32Array([0, 0, 0]),
  up: new Float32Array([0, 1, 0]),
  fov: 60,
  near: 0.1,
  far: 2000,
  viewMatrix: identity(),
  projMatrix: identity(),
  viewProjMatrix: identity()
}

// Mouse/input state
let mouseX = 0, mouseY = 0
let lastMouseX = 0, lastMouseY = 0
let mouseDown = false
let cameraDistance = 150
let cameraRotationX = 45 * Math.PI / 180
let cameraRotationY = 45 * Math.PI / 180

// Mesh data storage
interface MeshData {
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array
  indices: Uint32Array
  materialIds: Uint8Array
  vao?: WebGLVertexArrayObject
  indexBuffer?: WebGLBuffer
  vertexCount: number
}

const meshes = new Map<string, MeshData>()
const buildings = new Map<number, MeshData>()
let roadMesh: MeshData | null = null
let groundMesh: MeshData | null = null
let zoneMeshResidential: MeshData | null = null
let zoneMeshCommercial: MeshData | null = null
let zoneMeshIndustrial: MeshData | null = null
let debugTriangle: MeshData | null = null
let previewRoadMesh: MeshData | null = null
let intersectionMesh: MeshData | null = null
let trafficLightMesh: MeshData | null = null

// Store intersection data
interface Intersection {
  x: number
  z: number
  type: 'T' | 'cross' | 'complex'  // T-junction, 4-way, or 5+ way
  hasTrafficLight: boolean
  hasStopSign: boolean
}
const intersections: Intersection[] = []

// Shader programs
let basicShader: WebGLProgram | null = null
let buildingShader: WebGLProgram | null = null

// Grid/ground
const GRID_SIZE = 1000
const GRID_DIVISIONS = 100

// Convert procgen coordinates (0..2000) to renderer coords (-500..500)
function toRenderCoord(value: number): number {
  return value * 0.5 - GRID_SIZE / 2
}

// Isometric camera state
let isoZoom = 1.0  // Default zoom level
let isoPanX = 0
let isoPanY = 0

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data
  switch (msg.type) {
    case 'init':
      canvas = msg.canvas as OffscreenCanvas
      console.log('[Render] Canvas received, size:', canvas.width, 'x', canvas.height)
      await initRenderer()
      createGroundMesh()  // Create ground mesh immediately after init
      
      // TEST: Add a hardcoded building after init
      setTimeout(() => {
        console.log('[Render] TEST: Adding hardcoded test building')
        // Make test building visible but not too huge
        const testPositions = new Float32Array([
          -100, -100, 0,   100, -100, 0,   100, 100, 0,   -100, 100, 0,  // Bottom
          -100, -100, 200,  100, -100, 200,  100, 100, 200,  -100, 100, 200  // Top (tall)
        ])
        const testNormals = new Float32Array(24) // 8 vertices * 3 components
        const testUvs = new Float32Array(16) // 8 vertices * 2 components
        const testIndices = new Uint32Array([
          0,1,2, 0,2,3,  // Bottom
          4,5,6, 4,6,7,  // Top
          0,1,5, 0,5,4,  // Front
          2,3,7, 2,7,6,  // Back
          0,3,7, 0,7,4,  // Left
          1,2,6, 1,6,5   // Right
        ])
        
        const testMesh = createMeshFromArrays(
          testPositions,
          testNormals,
          testUvs,
          testIndices,
          new Uint8Array(12) // 12 triangles
        )
        
        if (testMesh) {
          buildings.set(999, testMesh)
          console.log('[Render] TEST: Test building added to map, total buildings:', buildings.size)
        } else {
          console.error('[Render] TEST: Failed to create test building mesh!')
        }
      }, 1000)
      
      loop()
      break
    case 'set-era':
      era = msg.era
      break
    case 'mouse-move':
      handleMouseMove(msg.x, msg.y, msg.buttons)
      break
    case 'mouse-up':
      // Reset last mouse position when mouse is released
      lastMouseX = 0
      lastMouseY = 0
      // Clear preview road
      previewRoadMesh = null
      break
    case 'preview-road':
      updatePreviewRoad(msg.segment)
      break
    case 'mouse-wheel':
      handleMouseWheel(msg.deltaY)
      break
    case 'update-roads':
      updateRoadMesh(msg.data)
      break
    case 'update-buildings':
      updateBuildingMeshes(msg.data)
      break
    case 'add-building':
      addSingleBuilding(msg.data)
      break
    case 'update-zones':
      updateZoneMesh(msg.data)
      break
    case 'update-camera':
      if (msg.position) camera.position.set(msg.position)
      if (msg.target) camera.target.set(msg.target)
      updateCamera()
      break
    case 'resize':
      if (canvas) {
        canvas.width = msg.width
        canvas.height = msg.height
      }
      break
    case 'boot':
      // Ground mesh already created in init
      break
  }
}

async function initRenderer() {
  if (!canvas) {
    console.error('[Render] No canvas available')
    return
  }
  
  console.log('[Render] Initializing WebGL2...')
  
  // Get WebGL2 context
  gl = canvas.getContext('webgl2', { 
    antialias: true, 
    alpha: false,
    depth: true,
    stencil: false,
    powerPreference: 'high-performance'
  })
  
  if (!gl) {
    console.error('[Render] WebGL2 not supported')
    return
  }
  
  console.log('[Render] WebGL2 context created successfully')
  
  // Enable depth testing
  gl.enable(gl.DEPTH_TEST)
  gl.depthFunc(gl.LEQUAL)
  
  // Disable culling temporarily to debug
  gl.disable(gl.CULL_FACE)
  
  // Create shaders
  console.log('[Render] Creating shaders...')
  basicShader = createShaderProgram(BASIC_VERTEX_SHADER, BASIC_FRAGMENT_SHADER)
  buildingShader = createShaderProgram(BUILDING_VERTEX_SHADER, BUILDING_FRAGMENT_SHADER)
  
  console.log('[Render] Shaders created:', basicShader ? 'basic OK' : 'basic FAILED', buildingShader ? 'building OK' : 'building FAILED')
  
  // Initial camera setup - position camera to look at the city
  updateCameraPosition()
  updateCamera()  // Make sure to update the matrices
  console.log('[Render] Initial camera position:', camera.position)
  console.log('[Render] Initial camera target:', camera.target)
  console.log('[Render] View-projection matrix:', camera.viewProjMatrix)
  console.log('[Render] Renderer initialized')
}

function createShaderProgram(vertexSource: string, fragmentSource: string): WebGLProgram | null {
  if (!gl) return null
  
  const vertexShader = gl.createShader(gl.VERTEX_SHADER)!
  gl.shaderSource(vertexShader, vertexSource)
  gl.compileShader(vertexShader)
  
  if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
    console.error('Vertex shader compile error:', gl.getShaderInfoLog(vertexShader))
    return null
  }
  
  const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER)!
  gl.shaderSource(fragmentShader, fragmentSource)
  gl.compileShader(fragmentShader)
  
  if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
    console.error('Fragment shader compile error:', gl.getShaderInfoLog(fragmentShader))
    return null
  }
  
  const program = gl.createProgram()!
  gl.attachShader(program, vertexShader)
  gl.attachShader(program, fragmentShader)
  gl.linkProgram(program)
  
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('Shader link error:', gl.getProgramInfoLog(program))
    return null
  }
  
  return program
}

function handleMouseMove(x: number, y: number, buttons: number) {
  // Only update pan with right mouse button (buttons === 2)
  if (buttons === 2) {
    const dx = x - lastMouseX
    const dy = y - lastMouseY
    
    // Only pan if we have a valid last position (not first frame)
    if (lastMouseX !== 0 || lastMouseY !== 0) {
      isoPanX += dx * 1.5
      isoPanY += dy * 1.5
    }
  }
  
  // Always update last position
  lastMouseX = x
  lastMouseY = y
  mouseX = x
  mouseY = y
}

function handleMouseWheel(deltaY: number) {
  // For isometric view, adjust zoom instead of camera distance
  const zoomSpeed = 0.001
  isoZoom = Math.max(0.3, Math.min(5.0, isoZoom * (1 - deltaY * zoomSpeed)))
}

function updateCameraPosition() {
  camera.position[0] = camera.target[0] + Math.sin(cameraRotationY) * Math.cos(cameraRotationX) * cameraDistance
  camera.position[1] = camera.target[1] + Math.sin(cameraRotationX) * cameraDistance
  camera.position[2] = camera.target[2] + Math.cos(cameraRotationY) * Math.cos(cameraRotationX) * cameraDistance
  updateCamera()
}

function updateCamera() {
  mat4.lookAt(camera.viewMatrix, camera.position, camera.target, camera.up)
  
  if (canvas && canvas.width > 0 && canvas.height > 0) {
    const aspect = canvas.width / canvas.height
    mat4.perspective(camera.projMatrix, camera.fov * Math.PI / 180, aspect, camera.near, camera.far)
    mat4.multiply(camera.viewProjMatrix, camera.projMatrix, camera.viewMatrix)
  } else {
    // Use a default aspect ratio if canvas isn't ready
    console.warn('[Render] Canvas not ready, using default aspect ratio')
    const defaultAspect = 16/9
    mat4.perspective(camera.projMatrix, camera.fov * Math.PI / 180, defaultAspect, camera.near, camera.far)
    mat4.multiply(camera.viewProjMatrix, camera.projMatrix, camera.viewMatrix)
  }
}

function createDebugTriangle() {
  console.log('[Render] Creating debug triangle...')
  if (!gl) return
  
  // Simple triangle in NDC space (normalized device coordinates)
  const positions = new Float32Array([
    -0.5, -0.5, 0,  // Bottom left
     0.5, -0.5, 0,  // Bottom right
     0.0,  0.5, 0   // Top center
  ])
  
  const normals = new Float32Array([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1
  ])
  
  const uvs = new Float32Array([
    0, 0,
    1, 0,
    0.5, 1
  ])
  
  const indices = new Uint32Array([0, 1, 2])
  
  debugTriangle = createMeshFromArrays(
    positions,
    normals,
    uvs,
    indices,
    new Uint8Array(1)
  )
  
  console.log('[Render] Debug triangle created:', debugTriangle ? 'success' : 'failed')
}

function createGroundMesh() {
  console.log('[Render] Creating ground mesh...')
  if (!gl) {
    console.log('[Render] Cannot create ground mesh - no GL context')
    return
  }
  
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  
  const step = GRID_SIZE / GRID_DIVISIONS
  
  // Create grid vertices - simpler approach for debugging
  for (let z = 0; z <= GRID_DIVISIONS; z++) {
    for (let x = 0; x <= GRID_DIVISIONS; x++) {
      const px = (x - GRID_DIVISIONS / 2) * step
      const pz = (z - GRID_DIVISIONS / 2) * step
      
      positions.push(px, 0, pz)
      normals.push(0, 1, 0)
      uvs.push(x / GRID_DIVISIONS, z / GRID_DIVISIONS)
    }
  }
  
  // Create indices for grid squares
  for (let z = 0; z < GRID_DIVISIONS; z++) {
    for (let x = 0; x < GRID_DIVISIONS; x++) {
      const topLeft = z * (GRID_DIVISIONS + 1) + x
      const topRight = topLeft + 1
      const bottomLeft = topLeft + GRID_DIVISIONS + 1
      const bottomRight = bottomLeft + 1
      
      // Two triangles per square
      indices.push(topLeft, topRight, bottomRight)
      indices.push(topLeft, bottomRight, bottomLeft)
    }
  }
  
  groundMesh = createMeshFromArrays(
    new Float32Array(positions),
    new Float32Array(normals),
    new Float32Array(uvs),
    new Uint32Array(indices),
    new Uint8Array(indices.length / 3)
  )
  
  console.log('[Render] Ground mesh created:', groundMesh ? 'success' : 'failed')
  if (groundMesh) {
    console.log('[Render] Ground mesh vertices:', groundMesh.vertexCount)
    console.log('[Render] First few positions:', positions.slice(0, 9))
    console.log('[Render] Grid bounds: X:', -(GRID_DIVISIONS/2)*step, 'to', (GRID_DIVISIONS/2)*step)
    console.log('[Render] Grid bounds: Z:', -(GRID_DIVISIONS/2)*step, 'to', (GRID_DIVISIONS/2)*step)
  }
}

function createMeshFromArrays(
  positions: Float32Array,
  normals: Float32Array,
  uvs: Float32Array,
  indices: Uint32Array,
  materialIds: Uint8Array
): MeshData | null {
  console.log('[Render] createMeshFromArrays called with:', {
    positions: positions?.length,
    normals: normals?.length,
    uvs: uvs?.length,
    indices: indices?.length,
    positionsSample: positions ? Array.from(positions.slice(0, 9)) : null,
    indicesSample: indices ? Array.from(indices.slice(0, 6)) : null
  })
  
  if (!gl) {
    console.error('[Render] No GL context!')
    return null
  }
  
  const vao = gl.createVertexArray()
  if (!vao) {
    console.error('[Render] Failed to create VAO!')
    return null
  }
  gl.bindVertexArray(vao)
  
  // Position buffer
  const posBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW)
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0)
  gl.enableVertexAttribArray(0)
  
  // Normal buffer
  const normBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, normBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW)
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0)
  gl.enableVertexAttribArray(1)
  
  // UV buffer
  const uvBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW)
  gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0)
  gl.enableVertexAttribArray(2)
  
  // Index buffer
  const indexBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW)
  
  gl.bindVertexArray(null)
  
  const error = gl.getError()
  if (error !== gl.NO_ERROR) {
    console.error('[Render] WebGL error after mesh creation:', error)
  }
  
  console.log('[Render] Mesh created successfully, vertex count:', indices.length)
  
  return {
    positions,
    normals,
    uvs,
    indices,
    materialIds,
    vao: vao!,
    indexBuffer: indexBuffer!,
    vertexCount: indices.length
  }
}

function updatePreviewRoad(segment: Float32Array) {
  if (!gl || !segment || segment.length < 6) return
  
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  
  // Single road segment for preview
  const x1 = toRenderCoord(segment[0])
  const z1 = toRenderCoord(segment[1])
  const x2 = toRenderCoord(segment[2])
  const z2 = toRenderCoord(segment[3])
  const width = segment[4]
  
  // Calculate perpendicular direction for road width
  const dx = x2 - x1
  const dz = z2 - z1
  const len = Math.sqrt(dx * dx + dz * dz)
  
  if (len > 0) {
    const perpX = -dz / len * width * 0.5
    const perpZ = dx / len * width * 0.5
    
    // Add road quad vertices - slightly higher than normal roads
    const roadHeight = 0.25  // Slightly above regular roads
    positions.push(x1 - perpX, roadHeight, z1 - perpZ)
    positions.push(x1 + perpX, roadHeight, z1 + perpZ)
    positions.push(x2 + perpX, roadHeight, z2 + perpZ)
    positions.push(x2 - perpX, roadHeight, z2 - perpZ)
    
    // Add normals
    for (let j = 0; j < 4; j++) {
      normals.push(0, 1, 0)
    }
    
    // Add UVs
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1)
    
    // Add indices
    indices.push(0, 1, 2, 0, 2, 3)
    
    previewRoadMesh = createMeshFromArrays(
      new Float32Array(positions),
      new Float32Array(normals),
      new Float32Array(uvs),
      new Uint32Array(indices),
      new Uint8Array(2)  // Single triangle pair
    )
  }
}

function updateRoadMesh(data: any) {
  console.log('[Render] updateRoadMesh called, data keys:', Object.keys(data))
  if (!gl) {
    console.log('[Render] No GL context')
    return
  }
  
  // Handle new format with proper intersection data
  const segments = data.roadSegments || data.segments
  const intersectionData = data.intersections || []
  
  console.log('[Render] Road segments:', segments?.length, 'intersections:', intersectionData?.length)
  
  if (!segments || segments.length === 0) {
    console.log('[Render] No segments to render')
    return
  }
  
  // Process intersection data from the intersection handler
  intersections.length = 0
  for (const inter of intersectionData) {
    intersections.push({
      x: toRenderCoord(inter.x),  // Center coordinates
      z: toRenderCoord(inter.y),  // y becomes z in 3D
      type: inter.type as 'T' | 'cross' | 'complex',
      hasTrafficLight: inter.type === 'cross' || inter.type === 'complex',
      hasStopSign: inter.type === 'T'
    })
  }
    
  
  console.log('[Render] Found', intersections.length, 'intersections')
  
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  
  let vertexIndex = 0
  
  // Check if segments is a typed array (old format) or array of objects (new format)
  const isTypedArray = segments instanceof Float32Array || (Array.isArray(segments) && typeof segments[0] === 'number')
  
  if (isTypedArray) {
    // Old format: process as flat array
    for (let i = 0; i < segments.length; i += 6) {
      const x1 = toRenderCoord(segments[i])
      const z1 = toRenderCoord(segments[i + 1])
      const x2 = toRenderCoord(segments[i + 2])
      const z2 = toRenderCoord(segments[i + 3])
      const width = segments[i + 4]
      const roadClass = segments[i + 5]
      
      processRoadSegment(x1, z1, x2, z2, width, roadClass)
    }
  } else {
    // New format: array of segment objects
    for (const segment of segments) {
      const x1 = toRenderCoord(segment.start.x)
      const z1 = toRenderCoord(segment.start.y)  // y becomes z in 3D
      const x2 = toRenderCoord(segment.end.x)
      const z2 = toRenderCoord(segment.end.y)
      const width = segment.width
      const roadClass = segment.class
      
      processRoadSegment(x1, z1, x2, z2, width, roadClass)
    }
  }
  
  function processRoadSegment(x1: number, z1: number, x2: number, z2: number, width: number, roadClass: number) {
    // Don't clip at intersections anymore - they're already properly handled by intersection handler
    // The segments are already split at intersection points
    
    // Calculate perpendicular direction for road width
    const dx = x2 - x1
    const dz = z2 - z1
    const len = Math.sqrt(dx * dx + dz * dz)
    
    if (len < 1) return  // Skip very short segments
    
    const perpX = -dz / len * width * 0.5
    const perpZ = dx / len * width * 0.5
    
    // Add road quad vertices with procedural imperfections
    const roadHeight = 0.2  // Base height above ground
    
    // Add procedural height variation for realistic undulation
    const seed1 = x1 * 0.013 + z1 * 0.017
    const seed2 = x2 * 0.013 + z2 * 0.017
    const undulation1 = Math.sin(seed1) * 0.02 + Math.sin(seed1 * 3.7) * 0.01
    const undulation2 = Math.sin(seed2) * 0.02 + Math.sin(seed2 * 3.7) * 0.01
    
    // Add subtle height variation based on road class
    const heightVar = roadClass === 0 ? 0.1 : 0  // Highways slightly elevated
    
    // Add edge deformation for weathered look
    const edgeWarp1 = Math.sin(x1 * 0.1 + z1 * 0.15) * 0.5
    const edgeWarp2 = Math.sin(x2 * 0.1 + z2 * 0.15) * 0.5
    
    // Vertices with procedural variations
    positions.push(
      x1 - perpX + edgeWarp1, 
      roadHeight + heightVar + undulation1 - 0.01, 
      z1 - perpZ + edgeWarp1 * 0.3
    )
    positions.push(
      x1 + perpX - edgeWarp1, 
      roadHeight + heightVar + undulation1 - 0.01, 
      z1 + perpZ - edgeWarp1 * 0.3
    )
    positions.push(
      x2 + perpX - edgeWarp2, 
      roadHeight + heightVar + undulation2 - 0.01, 
      z2 + perpZ - edgeWarp2 * 0.3
    )
    positions.push(
      x2 - perpX + edgeWarp2, 
      roadHeight + heightVar + undulation2 - 0.01, 
      z2 - perpZ + edgeWarp2 * 0.3
    )
    
    // Add normals (pointing up)
    for (let j = 0; j < 4; j++) {
      normals.push(0, 1, 0)
    }
    
    // Add UVs based on road length for proper texture tiling
    const roadLength = len / 10  // Scale for texture repetition
    uvs.push(0, 0, 1, 0, 1, roadLength, 0, roadLength)
    
    // Add indices
    const base = vertexIndex
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
    vertexIndex += 4
  }  // End of processRoadSegment function
  
  roadMesh = createMeshFromArrays(
    new Float32Array(positions),
    new Float32Array(normals),
    new Float32Array(uvs),
    new Uint32Array(indices),
    new Uint8Array(indices.length / 3)
  )
  
  // Create intersection meshes
  createIntersectionMeshes()
}

function createIntersectionMeshes() {
  if (!gl || intersections.length === 0) return
  
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  
  const lightPositions: number[] = []
  const lightNormals: number[] = []
  const lightUvs: number[] = []
  const lightIndices: number[] = []
  
  let vertexIndex = 0
  let lightVertexIndex = 0
  
  for (const intersection of intersections) {
    const size = 12  // Intersection square size
    const height = 0.22  // Slightly above roads
    
    // Add subtle variation to intersection height
    const intersectionSeed = intersection.x * 0.011 + intersection.z * 0.013
    const heightVariation = Math.sin(intersectionSeed) * 0.01
    
    // Add intersection square with slight imperfections
    positions.push(
      intersection.x - size, height + heightVariation, intersection.z - size,
      intersection.x + size, height + heightVariation * 0.8, intersection.z - size,
      intersection.x + size, height + heightVariation * 0.9, intersection.z + size,
      intersection.x - size, height + heightVariation * 1.1, intersection.z + size
    )
    
    for (let i = 0; i < 4; i++) {
      normals.push(0, 1, 0)
    }
    
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1)
    
    const base = vertexIndex
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
    vertexIndex += 4
    
    // Add traffic lights or stop signs
    if (intersection.hasTrafficLight) {
      // Create a simple traffic light pole at each corner
      const poleHeight = 8
      const poleRadius = 0.3
      const lightBoxSize = 1.5
      
      // Place lights at two opposite corners
      const corners = [
        { x: intersection.x + size - 2, z: intersection.z + size - 2 },
        { x: intersection.x - size + 2, z: intersection.z - size + 2 }
      ]
      
      for (const corner of corners) {
        // Pole (vertical cylinder approximated as box)
        for (let h = 0; h < poleHeight; h += 2) {
          lightPositions.push(
            corner.x - poleRadius, height + h, corner.z - poleRadius,
            corner.x + poleRadius, height + h, corner.z - poleRadius,
            corner.x + poleRadius, height + h + 2, corner.z - poleRadius,
            corner.x - poleRadius, height + h + 2, corner.z - poleRadius
          )
          
          for (let i = 0; i < 4; i++) {
            lightNormals.push(0, 0, 1)
          }
          
          lightUvs.push(0, 0, 1, 0, 1, 1, 0, 1)
          
          const lb = lightVertexIndex
          lightIndices.push(lb, lb + 1, lb + 2, lb, lb + 2, lb + 3)
          lightVertexIndex += 4
        }
        
        // Light box
        lightPositions.push(
          corner.x - lightBoxSize, height + poleHeight, corner.z - lightBoxSize,
          corner.x + lightBoxSize, height + poleHeight, corner.z - lightBoxSize,
          corner.x + lightBoxSize, height + poleHeight + lightBoxSize * 2, corner.z - lightBoxSize,
          corner.x - lightBoxSize, height + poleHeight + lightBoxSize * 2, corner.z - lightBoxSize
        )
        
        for (let i = 0; i < 4; i++) {
          lightNormals.push(0, 0, 1)
        }
        
        lightUvs.push(0, 0, 1, 0, 1, 1, 0, 1)
        
        const lb = lightVertexIndex
        lightIndices.push(lb, lb + 1, lb + 2, lb, lb + 2, lb + 3)
        lightVertexIndex += 4
      }
    }
  }
  
  if (positions.length > 0) {
    intersectionMesh = createMeshFromArrays(
      new Float32Array(positions),
      new Float32Array(normals),
      new Float32Array(uvs),
      new Uint32Array(indices),
      new Uint8Array(indices.length / 3)
    )
  }
  
  if (lightPositions.length > 0) {
    trafficLightMesh = createMeshFromArrays(
      new Float32Array(lightPositions),
      new Float32Array(lightNormals),
      new Float32Array(lightUvs),
      new Uint32Array(lightIndices),
      new Uint8Array(lightIndices.length / 3)
    )
  }
}

function updateZoneMesh(data: any) {
  if (!gl || !data) return
  
  console.log('[Render] Updating zone mesh, data:', data)
  
  // Handle the data format from procgen worker
  // data contains parcelData, parcelVertices, and blockData
  const parcelData = data.parcelData as Float32Array
  const parcelVertices = data.parcelVertices as Float32Array
  
  if (!parcelData || parcelData.length === 0) {
    console.log('[Render] No parcel data to render')
    return
  }
  
  // Separate arrays for each zone type
  const residentialPositions: number[] = []
  const residentialNormals: number[] = []
  const residentialUvs: number[] = []
  const residentialIndices: number[] = []
  
  const commercialPositions: number[] = []
  const commercialNormals: number[] = []
  const commercialUvs: number[] = []
  const commercialIndices: number[] = []
  
  const industrialPositions: number[] = []
  const industrialNormals: number[] = []
  const industrialUvs: number[] = []
  const industrialIndices: number[] = []
  
  let residentialVertexIndex = 0
  let commercialVertexIndex = 0
  let industrialVertexIndex = 0
  let vertexOffset = 0
  
  // parcelData format: [id, zoneType, density, area, frontage, isCorner, centroid.x, centroid.y, blockId]
  // parcelVertices format: flattened vertices with -999999 separators
  
  const parcelCount = parcelData.length / 9
  console.log('[Render] Processing', parcelCount, 'parcels')
  
  for (let p = 0; p < parcelCount; p++) {
    const zoneType = parcelData[p * 9 + 1]
    const density = parcelData[p * 9 + 2]
    const centroidX = parcelData[p * 9 + 6]
    const centroidY = parcelData[p * 9 + 7]
    
    // Collect vertices for this parcel
    const parcelVerts: { x: number, y: number }[] = []
    
    while (vertexOffset < parcelVertices.length / 2) {
      const x = parcelVertices[vertexOffset * 2]
      const y = parcelVertices[vertexOffset * 2 + 1]
      
      // Check for separator
      if (x === -999999 && y === -999999) {
        vertexOffset++ // Skip the separator
        break // End of this parcel's vertices
      }
      
      parcelVerts.push({ x, y })
      vertexOffset++
    }
    
    if (parcelVerts.length < 3) continue // Skip invalid parcels
    
    // Select the appropriate arrays based on zone type
    let positions: number[], normals: number[], uvs: number[], indices: number[]
    let vertexIndex: number
    
    if (zoneType === 0) { // residential
      positions = residentialPositions
      normals = residentialNormals
      uvs = residentialUvs
      indices = residentialIndices
      vertexIndex = residentialVertexIndex
    } else if (zoneType === 1) { // commercial
      positions = commercialPositions
      normals = commercialNormals
      uvs = commercialUvs
      indices = commercialIndices
      vertexIndex = commercialVertexIndex
    } else if (zoneType === 2) { // industrial
      positions = industrialPositions
      normals = industrialNormals
      uvs = industrialUvs
      indices = industrialIndices
      vertexIndex = industrialVertexIndex
    } else {
      continue // Unknown zone type
    }
    
    // Add vertices for the parcel polygon
    for (const vert of parcelVerts) {
      // Convert from procgen coordinates (0-2000) to render coordinates (-500 to 500)
      const x = toRenderCoord(vert.x)
      const z = toRenderCoord(vert.y)
      
      positions.push(x, 0.05, z)  // Slightly above ground
      normals.push(0, 1, 0)
      uvs.push((x + GRID_SIZE / 2) / GRID_SIZE, (z + GRID_SIZE / 2) / GRID_SIZE)
    }
    
    // Create triangles for the polygon (simple fan triangulation)
    const startIdx = vertexIndex
    for (let v = 1; v < parcelVerts.length - 1; v++) {
      indices.push(startIdx, startIdx + v, startIdx + v + 1)
    }
    
    // Update the appropriate vertex index
    if (zoneType === 0) {
      residentialVertexIndex += parcelVerts.length
    } else if (zoneType === 1) {
      commercialVertexIndex += parcelVerts.length
    } else if (zoneType === 2) {
      industrialVertexIndex += parcelVerts.length
    }
  }
  
  console.log('[Render] Zone vertices - R:', residentialPositions.length / 3, 'C:', commercialPositions.length / 3, 'I:', industrialPositions.length / 3)
  
  // Create separate meshes for each zone type
  if (residentialPositions.length > 0) {
    zoneMeshResidential = createMeshFromArrays(
      new Float32Array(residentialPositions),
      new Float32Array(residentialNormals),
      new Float32Array(residentialUvs),
      new Uint32Array(residentialIndices),
      new Uint8Array(residentialIndices.length / 3)
    )
  }
  
  if (commercialPositions.length > 0) {
    zoneMeshCommercial = createMeshFromArrays(
      new Float32Array(commercialPositions),
      new Float32Array(commercialNormals),
      new Float32Array(commercialUvs),
      new Uint32Array(commercialIndices),
      new Uint8Array(commercialIndices.length / 3)
    )
  }
  
  if (industrialPositions.length > 0) {
    zoneMeshIndustrial = createMeshFromArrays(
      new Float32Array(industrialPositions),
      new Float32Array(industrialNormals),
      new Float32Array(industrialUvs),
      new Uint32Array(industrialIndices),
      new Uint8Array(industrialIndices.length / 3)
    )
  }
}

function updateBuildingMeshes(data: any) {
  if (!gl || !data.buildings) return
  
  // DON'T CLEAR - this was removing our buildings!
  // buildings.clear()
  console.log('[Render] updateBuildingMeshes called, NOT clearing existing buildings')
  
  for (const building of data.buildings) {
    const mesh = createMeshFromArrays(
      building.positions,
      building.normals,
      building.uvs,
      building.indices,
      building.materialIds
    )
    
    if (mesh) {
      buildings.set(building.id, mesh)
    }
  }
}

function addSingleBuilding(data: any) {
  if (!gl || !data.meshData) {
    console.error('[Render] Cannot add building: gl or meshData missing')
    return
  }
  
  const meshData = data.meshData
  const buildingId = data.buildingId || data.parcelId
  
  console.log('[Render] Adding building', buildingId, 'vertices length:', meshData.vertices?.length)
  
  // Log first few vertices to see positions
  if (meshData.vertices && meshData.vertices.length >= 3) {
    console.log('[Render] First vertex position:', meshData.vertices[0], meshData.vertices[1], meshData.vertices[2])
  }
  
  // Validate mesh data
  if (!meshData.vertices || meshData.vertices.length === 0) {
    console.error('[Render] Building has no vertices!')
    return
  }
  
  // Create mesh from the building data
  const mesh = createMeshFromArrays(
    meshData.vertices,
    meshData.normals || new Float32Array(meshData.vertices.length), // Default normals if missing
    meshData.uvs || new Float32Array((meshData.vertices.length / 3) * 2), // Default UVs if missing
    meshData.indices,
    new Uint8Array(meshData.materialIds || new Array(meshData.indices.length / 3).fill(0))
  )
  
  if (mesh) {
    buildings.set(buildingId, mesh)
    console.log('[Render] Successfully added building', buildingId, 'with', mesh.vertexCount, 'vertices. Total buildings:', buildings.size)
  } else {
    console.error('[Render] Failed to create mesh for building', buildingId)
  }
}

let lastTime = performance.now()
let frames = 0
let fps = 0

function loop() {
  const now = performance.now()
  frames++
  
  if (now - lastTime >= 1000) {
    fps = (frames * 1000) / (now - lastTime)
    self.postMessage({ type: 'stats', fps, zoom: isoZoom, panX: isoPanX, panY: isoPanY })
    lastTime = now
    frames = 0
  }
  
  // Send camera updates more frequently for coordinate conversion
  if (frames % 10 === 0) {
    self.postMessage({ type: 'camera-update', zoom: isoZoom, panX: isoPanX, panY: isoPanY })
  }
  
  draw()
  self.requestAnimationFrame(loop)
}

let frameCount = 0

// Helper function to create isometric projection matrix
function getIsometricMatrix(): Float32Array {
  if (!canvas) return identity()
  
  const aspect = canvas.width / canvas.height
  
  // Direct isometric transformation
  // Map 3D coordinates to 2D screen using classic isometric formulas
  // For a point (x, y, z) in 3D:
  // screen_x = (x - z) * cos(30°)
  // screen_y = y + (x + z) * sin(30°) 
  
  const scale = 2.0 * isoZoom / GRID_SIZE
  
  // Classic isometric projection matrix
  // This directly maps 3D world coordinates to 2D screen coordinates
  const sqrt3 = Math.sqrt(3)
  const matrix = new Float32Array([
    // X component: moves right-up in screen space
    sqrt3/2 * scale / aspect,    // x affects screen x
    0.5 * scale,                  // x affects screen y
    0,                            // x doesn't affect z
    0,
    
    // Y component: moves straight up in screen space  
    0,                            // y doesn't affect screen x
    scale,                        // y affects screen y
    0,                            // y doesn't affect z
    0,
    
    // Z component: moves left-up in screen space
    -sqrt3/2 * scale / aspect,   // z affects screen x (negative)
    0.5 * scale,                  // z affects screen y
    0.001,                        // small z for depth sorting
    0,
    
    // Translation
    isoPanX / canvas.width * 2,
    -isoPanY / canvas.height * 2,
    0,
    1
  ])
  
  return matrix
}

function draw() {
  if (!gl || !canvas) {
    if (frameCount === 0) console.log('[Render] Draw called but gl or canvas missing')
    frameCount++
    return
  }
  
  if (frameCount === 0) {
    console.log('[Render] First frame drawing, canvas size:', canvas.width, 'x', canvas.height)
    console.log('[Render] Initial isometric settings - Zoom:', isoZoom, 'Pan:', isoPanX, isoPanY)
  }
  frameCount++
  
  // Set viewport and handle canvas resize
  if (canvas.width > 0 && canvas.height > 0) {
    gl.viewport(0, 0, canvas.width, canvas.height)
  } else {
    return // Skip drawing if canvas has no size
  }
  
  // Lighter sky blue for better contrast
  gl.clearColor(0.7, 0.82, 0.92, 1.0)
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
  
  // Ensure depth testing is enabled
  gl.enable(gl.DEPTH_TEST)
  gl.depthFunc(gl.LEQUAL)
  
  // Debug: draw a simple colored rectangle to test if rendering works
  if (frameCount === 1) {
    console.log('[Render] Debug triangle exists:', !!debugTriangle)
    console.log('[Render] Ground mesh exists:', !!groundMesh)
    console.log('[Render] Basic shader exists:', !!basicShader)
    console.log('[Render] Road mesh exists:', !!roadMesh)
  }
  
  // Draw ground grid
  if (groundMesh && basicShader) {
    if (frameCount <= 3) {
      console.log('[Render] Drawing ground mesh, vertices:', groundMesh.vertexCount)
    }
    gl.useProgram(basicShader)
    
    const mvpLoc = gl.getUniformLocation(basicShader, 'uMVP')
    const colorLoc = gl.getUniformLocation(basicShader, 'uColor')
    
    // Get isometric projection matrix
    const isoMatrix = getIsometricMatrix()
    
    gl.uniformMatrix4fv(mvpLoc, false, isoMatrix)
    // More visible green for the ground
    gl.uniform4f(colorLoc, 0.45, 0.55, 0.45, 1.0)
    
    gl.bindVertexArray(groundMesh.vao!)
    gl.drawElements(gl.TRIANGLES, groundMesh.vertexCount, gl.UNSIGNED_INT, 0)
    
    const error = gl.getError()
    if (error !== gl.NO_ERROR && frameCount === 2) {
      console.error('[Render] WebGL error after ground draw:', error)
    }
  }
  
  // Draw zones (before roads so roads appear on top)
  if (basicShader) {
    gl.useProgram(basicShader)
    
    const mvpLoc = gl.getUniformLocation(basicShader, 'uMVP')
    const colorLoc = gl.getUniformLocation(basicShader, 'uColor')
    
    // Use isometric projection
    const isoMatrix = getIsometricMatrix()
    
    gl.uniformMatrix4fv(mvpLoc, false, isoMatrix)
    
    // Enable blending for semi-transparent zones
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    
    // Draw residential zones (green)
    if (zoneMeshResidential) {
      gl.uniform4f(colorLoc, 0.1, 0.7, 0.1, 0.4)
      gl.bindVertexArray(zoneMeshResidential.vao!)
      gl.drawElements(gl.TRIANGLES, zoneMeshResidential.vertexCount, gl.UNSIGNED_INT, 0)
    }
    
    // Draw commercial zones (blue)
    if (zoneMeshCommercial) {
      gl.uniform4f(colorLoc, 0.1, 0.1, 0.7, 0.4)
      gl.bindVertexArray(zoneMeshCommercial.vao!)
      gl.drawElements(gl.TRIANGLES, zoneMeshCommercial.vertexCount, gl.UNSIGNED_INT, 0)
    }
    
    // Draw industrial zones (orange/yellow)
    if (zoneMeshIndustrial) {
      gl.uniform4f(colorLoc, 0.7, 0.5, 0.1, 0.4)
      gl.bindVertexArray(zoneMeshIndustrial.vao!)
      gl.drawElements(gl.TRIANGLES, zoneMeshIndustrial.vertexCount, gl.UNSIGNED_INT, 0)
    }
    
    gl.disable(gl.BLEND)
  }
  
  // Draw roads
  if (roadMesh && basicShader) {
    gl.useProgram(basicShader)
    
    const mvpLoc = gl.getUniformLocation(basicShader, 'uMVP')
    const colorLoc = gl.getUniformLocation(basicShader, 'uColor')
    
    // Use isometric projection
    const isoMatrix = getIsometricMatrix()
    
    gl.uniformMatrix4fv(mvpLoc, false, isoMatrix)
    // Darker asphalt color with slight blue tint for roads
    gl.uniform4f(colorLoc, 0.12, 0.12, 0.14, 1.0)
    
    gl.bindVertexArray(roadMesh.vao!)
    gl.drawElements(gl.TRIANGLES, roadMesh.vertexCount, gl.UNSIGNED_INT, 0)
  }
  
  // Draw intersections
  if (intersectionMesh && basicShader) {
    gl.useProgram(basicShader)
    
    const mvpLoc = gl.getUniformLocation(basicShader, 'uMVP')
    const colorLoc = gl.getUniformLocation(basicShader, 'uColor')
    
    const isoMatrix = getIsometricMatrix()
    
    gl.uniformMatrix4fv(mvpLoc, false, isoMatrix)
    // Slightly lighter color for intersections
    gl.uniform4f(colorLoc, 0.14, 0.14, 0.16, 1.0)
    
    gl.bindVertexArray(intersectionMesh.vao!)
    gl.drawElements(gl.TRIANGLES, intersectionMesh.vertexCount, gl.UNSIGNED_INT, 0)
  }
  
  // Draw traffic lights
  if (trafficLightMesh && basicShader) {
    gl.useProgram(basicShader)
    
    const mvpLoc = gl.getUniformLocation(basicShader, 'uMVP')
    const colorLoc = gl.getUniformLocation(basicShader, 'uColor')
    
    const isoMatrix = getIsometricMatrix()
    
    gl.uniformMatrix4fv(mvpLoc, false, isoMatrix)
    // Dark gray for traffic light poles
    gl.uniform4f(colorLoc, 0.3, 0.3, 0.3, 1.0)
    
    gl.bindVertexArray(trafficLightMesh.vao!)
    gl.drawElements(gl.TRIANGLES, trafficLightMesh.vertexCount, gl.UNSIGNED_INT, 0)
  }
  
  // Draw preview/ghost road
  if (previewRoadMesh && basicShader) {
    gl.useProgram(basicShader)
    
    const mvpLoc = gl.getUniformLocation(basicShader, 'uMVP')
    const colorLoc = gl.getUniformLocation(basicShader, 'uColor')
    
    // Use isometric projection
    const isoMatrix = getIsometricMatrix()
    
    gl.uniformMatrix4fv(mvpLoc, false, isoMatrix)
    // Bright cyan for preview - more visible
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.uniform4f(colorLoc, 0.3, 0.8, 1.0, 0.8)
    
    gl.bindVertexArray(previewRoadMesh.vao!)
    gl.drawElements(gl.TRIANGLES, previewRoadMesh.vertexCount, gl.UNSIGNED_INT, 0)
    gl.disable(gl.BLEND)
  }
  
  // Draw buildings - FIXED VERSION WITH LOGGING
  if (buildings.size > 0) {
    console.log('[Render] Drawing', buildings.size, 'buildings at frame', frameCount)
    
    // Use basic shader for now with isometric projection
    if (basicShader) {
      gl.useProgram(basicShader)
      
      const mvpLoc = gl.getUniformLocation(basicShader, 'uMVP')
      const colorLoc = gl.getUniformLocation(basicShader, 'uColor')
      
      if (!mvpLoc || !colorLoc) {
        console.error('[Render] Building shader uniforms not found!')
        return
      }
      
      // Use isometric projection
      const isoMatrix = getIsometricMatrix()
      gl.uniformMatrix4fv(mvpLoc, false, isoMatrix)
      
      let drawnCount = 0
      for (const [id, mesh] of buildings) {
        if (!mesh || !mesh.vao) {
          console.error('[Render] Building', id, 'has invalid mesh!')
          continue
        }
        
        // BRIGHT RED for maximum visibility
        gl.uniform4f(colorLoc, 1.0, 0.0, 0.0, 1.0)
        
        gl.bindVertexArray(mesh.vao!)
        
        const error = gl.getError()
        if (error !== gl.NO_ERROR) {
          console.error('[Render] GL error before drawing building:', error)
        }
        
        gl.drawElements(gl.TRIANGLES, mesh.vertexCount, gl.UNSIGNED_INT, 0)
        
        const error2 = gl.getError()
        if (error2 !== gl.NO_ERROR) {
          console.error('[Render] GL error after drawing building:', error2)
        }
        
        drawnCount++
        
        if (frameCount % 60 === 0) {
          console.log('[Render] Drew building', id, 'with', mesh.vertexCount, 'vertices')
        }
      }
      
      console.log('[Render] Successfully drew', drawnCount, 'of', buildings.size, 'buildings')
    } else if (buildingShader) {
      // Fallback to building shader if basic shader not available
      gl.useProgram(buildingShader)
      
      const mvpLoc = gl.getUniformLocation(buildingShader, 'uMVP')
      const viewLoc = gl.getUniformLocation(buildingShader, 'uView')
      const lightDirLoc = gl.getUniformLocation(buildingShader, 'uLightDir')
      const baseColorLoc = gl.getUniformLocation(buildingShader, 'uBaseColor')
      
      // Use isometric projection
      const isoMatrix = getIsometricMatrix()
      gl.uniformMatrix4fv(mvpLoc, false, isoMatrix)
      gl.uniformMatrix4fv(viewLoc, false, camera.viewMatrix)
      gl.uniform3f(lightDirLoc, 0.3, -0.7, 0.5)
      
      for (const [id, mesh] of buildings) {
        // Set building color based on ID for variety
        const hue = (id * 137.5) % 360
        const color = hslToRgb(hue / 360, 0.2, 0.6)
        gl.uniform4f(baseColorLoc, color[0], color[1], color[2], 1.0)
        
        gl.bindVertexArray(mesh.vao!)
        gl.drawElements(gl.TRIANGLES, mesh.vertexCount, gl.UNSIGNED_INT, 0)
      }
    }
  }
  
  gl.bindVertexArray(null)
}

function pickEraClear(era: string): { r: number, g: number, b: number, a: number } {
  switch (era) {
    case '1890s': return { r: 0.10, g: 0.09, b: 0.08, a: 1 }
    case '1910s': return { r: 0.12, g: 0.10, b: 0.09, a: 1 }
    case '1930s': return { r: 0.10, g: 0.11, b: 0.12, a: 1 }
    case '1950s': return { r: 0.12, g: 0.13, b: 0.14, a: 1 }
    case '1970s': return { r: 0.08, g: 0.12, b: 0.10, a: 1 }
    case '1990s': return { r: 0.08, g: 0.10, b: 0.14, a: 1 }
    case '2010s': return { r: 0.08, g: 0.09, b: 0.12, a: 1 }
    case '2030s': return { r: 0.06, g: 0.09, b: 0.10, a: 1 }
    default: return { r: 0.1, g: 0.1, b: 0.1, a: 1 }
  }
}

function hslToRgb(h: number, s: number, l: number): number[] {
  let r, g, b
  
  if (s === 0) {
    r = g = b = l
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1
      if (t > 1) t -= 1
      if (t < 1/6) return p + (q - p) * 6 * t
      if (t < 1/2) return q
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6
      return p
    }
    
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    r = hue2rgb(p, q, h + 1/3)
    g = hue2rgb(p, q, h)
    b = hue2rgb(p, q, h - 1/3)
  }
  
  return [r, g, b]
}

// Basic math utilities
const vec3 = {
  cross: (a: Float32Array, b: Float32Array): Float32Array => {
    return new Float32Array([
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]
    ])
  },
  subtract: (a: Float32Array, b: Float32Array): Float32Array => {
    return new Float32Array([a[0] - b[0], a[1] - b[1], a[2] - b[2]])
  },
  normalize: (v: Float32Array): Float32Array => {
    const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
    return new Float32Array([v[0] / len, v[1] / len, v[2] / len])
  }
}

const mat4 = {
  lookAt: (out: Float32Array, eye: Float32Array, target: Float32Array, up: Float32Array) => {
    const zAxis = vec3.normalize(vec3.subtract(eye, target))
    const xAxis = vec3.normalize(vec3.cross(up, zAxis))
    const yAxis = vec3.cross(zAxis, xAxis)
    
    out[0] = xAxis[0]; out[1] = yAxis[0]; out[2] = zAxis[0]; out[3] = 0
    out[4] = xAxis[1]; out[5] = yAxis[1]; out[6] = zAxis[1]; out[7] = 0
    out[8] = xAxis[2]; out[9] = yAxis[2]; out[10] = zAxis[2]; out[11] = 0
    out[12] = -xAxis[0] * eye[0] - xAxis[1] * eye[1] - xAxis[2] * eye[2]
    out[13] = -yAxis[0] * eye[0] - yAxis[1] * eye[1] - yAxis[2] * eye[2]
    out[14] = -zAxis[0] * eye[0] - zAxis[1] * eye[1] - zAxis[2] * eye[2]
    out[15] = 1
  },
  perspective: (out: Float32Array, fov: number, aspect: number, near: number, far: number) => {
    const f = 1 / Math.tan(fov / 2)
    const nf = 1 / (near - far)
    
    out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0
    out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0
    out[8] = 0; out[9] = 0; out[10] = (far + near) * nf; out[11] = -1
    out[12] = 0; out[13] = 0; out[14] = 2 * far * near * nf; out[15] = 0
  },
  multiply: (out: Float32Array, a: Float32Array, b: Float32Array) => {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3]
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7]
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11]
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15]
    
    const b00 = b[0], b01 = b[1], b02 = b[2], b03 = b[3]
    const b10 = b[4], b11 = b[5], b12 = b[6], b13 = b[7]
    const b20 = b[8], b21 = b[9], b22 = b[10], b23 = b[11]
    const b30 = b[12], b31 = b[13], b32 = b[14], b33 = b[15]
    
    out[0] = a00 * b00 + a01 * b10 + a02 * b20 + a03 * b30
    out[1] = a00 * b01 + a01 * b11 + a02 * b21 + a03 * b31
    out[2] = a00 * b02 + a01 * b12 + a02 * b22 + a03 * b32
    out[3] = a00 * b03 + a01 * b13 + a02 * b23 + a03 * b33
    
    out[4] = a10 * b00 + a11 * b10 + a12 * b20 + a13 * b30
    out[5] = a10 * b01 + a11 * b11 + a12 * b21 + a13 * b31
    out[6] = a10 * b02 + a11 * b12 + a12 * b22 + a13 * b32
    out[7] = a10 * b03 + a11 * b13 + a12 * b23 + a13 * b33
    
    out[8] = a20 * b00 + a21 * b10 + a22 * b20 + a23 * b30
    out[9] = a20 * b01 + a21 * b11 + a22 * b21 + a23 * b31
    out[10] = a20 * b02 + a21 * b12 + a22 * b22 + a23 * b32
    out[11] = a20 * b03 + a21 * b13 + a22 * b23 + a23 * b33
    
    out[12] = a30 * b00 + a31 * b10 + a32 * b20 + a33 * b30
    out[13] = a30 * b01 + a31 * b11 + a32 * b21 + a33 * b31
    out[14] = a30 * b02 + a31 * b12 + a32 * b22 + a33 * b32
    out[15] = a30 * b03 + a31 * b13 + a32 * b23 + a33 * b33
  }
}

// Shader sources
const BASIC_VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUV;

uniform mat4 uMVP;

out vec3 vNormal;
out vec2 vUV;

void main() {
  gl_Position = uMVP * vec4(aPosition, 1.0);
  vNormal = aNormal;
  vUV = aUV;
}
`

const BASIC_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec3 vNormal;
in vec2 vUV;

uniform vec4 uColor;

out vec4 fragColor;

void main() {
  // Check if this is likely a road (darker color)
  bool isRoad = uColor.r < 0.2 && uColor.g < 0.2;
  
  if (isRoad) {
    // Roads: Add realistic texture and procedural details
    vec3 roadColor = uColor.rgb;
    
    // Base asphalt texture with multi-octave noise
    float noise1 = fract(sin(dot(vUV * 100.0, vec2(12.9898, 78.233))) * 43758.5453);
    float noise2 = fract(sin(dot(vUV * 50.0, vec2(94.234, 37.873))) * 28493.2847);
    float noise3 = fract(sin(dot(vUV * 200.0, vec2(45.234, 91.187))) * 91847.3652);
    float combinedNoise = noise1 * 0.5 + noise2 * 0.3 + noise3 * 0.2;
    roadColor = mix(roadColor, roadColor * 1.3, combinedNoise * 0.15);
    
    // Procedural cracks
    float crackNoise = fract(sin(dot(floor(vUV * 30.0), vec2(21.98, 78.233))) * 43758.5453);
    float crack = step(0.95, crackNoise);
    float crackPattern = fract(sin(dot(vUV * 150.0, vec2(12.345, 67.890))) * 12345.6789);
    crack *= step(0.7, crackPattern);
    roadColor = mix(roadColor, roadColor * 0.3, crack * 0.4);
    
    // Procedural potholes and damage
    vec2 cellPos = floor(vUV * 20.0);
    float potholeRandom = fract(sin(dot(cellPos, vec2(127.1, 311.7))) * 43758.5453);
    if (potholeRandom > 0.92) {
      vec2 localUV = fract(vUV * 20.0);
      float dist = length(localUV - 0.5);
      float pothole = 1.0 - smoothstep(0.1, 0.3, dist);
      roadColor = mix(roadColor, roadColor * 0.2, pothole * 0.5);
    }
    
    // Procedural manholes
    vec2 manholeGrid = floor(vUV * vec2(3.0, 8.0));
    float manholeRandom = fract(sin(dot(manholeGrid, vec2(51.23, 73.41))) * 38274.2847);
    if (manholeRandom > 0.85) {
      vec2 manholeLocal = fract(vUV * vec2(3.0, 8.0));
      float manholeDist = length(manholeLocal - 0.5);
      float manholeRing = smoothstep(0.15, 0.2, manholeDist) * (1.0 - smoothstep(0.25, 0.3, manholeDist));
      float manholeCenter = 1.0 - smoothstep(0.0, 0.15, manholeDist);
      roadColor = mix(roadColor, vec3(0.15, 0.15, 0.15), manholeRing * 0.8);
      roadColor = mix(roadColor, vec3(0.1, 0.1, 0.1), manholeCenter * 0.9);
    }
    
    // Oil stains and dark patches
    float stainNoise = fract(sin(dot(floor(vUV * 10.0), vec2(92.34, 28.51))) * 73829.234);
    if (stainNoise > 0.88) {
      vec2 stainLocal = fract(vUV * 10.0);
      float stainShape = smoothstep(0.6, 0.2, length(stainLocal - 0.5));
      stainShape *= fract(sin(dot(vUV * 40.0, vec2(83.23, 19.87))) * 9183.2847);
      roadColor = mix(roadColor, roadColor * 0.5, stainShape * 0.3);
    }
    
    // Tire tracks and wear patterns
    float trackPos1 = smoothstep(0.28, 0.32, vUV.x) * (1.0 - smoothstep(0.34, 0.38, vUV.x));
    float trackPos2 = smoothstep(0.62, 0.66, vUV.x) * (1.0 - smoothstep(0.68, 0.72, vUV.x));
    float tracks = max(trackPos1, trackPos2);
    roadColor = mix(roadColor, roadColor * 0.85, tracks * 0.2);
    
    // Lane markings with wear
    float centerLine = abs(vUV.x - 0.5) < 0.012 ? 1.0 : 0.0;
    float dashPattern = step(0.5, fract(vUV.y * 2.5));
    float lineWear = fract(sin(dot(vUV * 100.0, vec2(73.234, 28.873))) * 18374.234);
    centerLine *= dashPattern * (0.3 + lineWear * 0.7);
    roadColor = mix(roadColor, vec3(0.85, 0.85, 0.75), centerLine * 0.5);
    
    // Edge lines with damage
    float edgeLine = (vUV.x < 0.04 || vUV.x > 0.96) ? 1.0 : 0.0;
    float edgeWear = fract(sin(dot(vUV * 80.0, vec2(43.234, 98.873))) * 28374.234);
    edgeLine *= (0.4 + edgeWear * 0.6);
    roadColor = mix(roadColor, vec3(0.75, 0.75, 0.65), edgeLine * 0.25);
    
    // Edge crumbling
    float edgeCrumble = (vUV.x < 0.08 || vUV.x > 0.92) ? 1.0 : 0.0;
    float crumbleNoise = fract(sin(dot(vUV * 200.0, vec2(127.234, 48.873))) * 48274.234);
    edgeCrumble *= step(0.6, crumbleNoise);
    roadColor = mix(roadColor, roadColor * 0.6, edgeCrumble * 0.3);
    
    // Overall weathering based on position
    float weathering = noise1 * 0.1 + 0.9;
    roadColor *= weathering;
    
    fragColor = vec4(roadColor, 1.0);
  } else {
    // Ground: Grid pattern
    float minorGridScale = 20.0;
    float majorGridScale = 4.0;
    
    vec2 minorGrid = fract(vUV * minorGridScale);
    vec2 majorGrid = fract(vUV * majorGridScale);
    
    float lineWidth = 0.015;
    float minorLineStrength = 0.0;
    if (minorGrid.x < lineWidth || minorGrid.x > 1.0 - lineWidth) minorLineStrength = 1.0;
    if (minorGrid.y < lineWidth || minorGrid.y > 1.0 - lineWidth) minorLineStrength = 1.0;
    
    float majorLineWidth = 0.025;
    float majorLineStrength = 0.0;
    if (majorGrid.x < majorLineWidth || majorGrid.x > 1.0 - majorLineWidth) majorLineStrength = 1.0;
    if (majorGrid.y < majorLineWidth || majorGrid.y > 1.0 - majorLineWidth) majorLineStrength = 1.0;
    
    vec3 baseColor = uColor.rgb;
    vec3 minorGridColor = baseColor * 0.9;
    vec3 majorGridColor = baseColor * 0.75;
    
    vec3 finalColor = baseColor;
    finalColor = mix(finalColor, minorGridColor, minorLineStrength * 0.3);
    finalColor = mix(finalColor, majorGridColor, majorLineStrength * 0.5);
    
    fragColor = vec4(finalColor, uColor.a);
  }
}
`

const BUILDING_VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUV;

uniform mat4 uMVP;
uniform mat4 uView;

out vec3 vNormal;
out vec2 vUV;
out vec3 vWorldPos;

void main() {
  gl_Position = uMVP * vec4(aPosition, 1.0);
  vNormal = aNormal;
  vUV = aUV;
  vWorldPos = aPosition;
}
`

const BUILDING_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec3 vNormal;
in vec2 vUV;
in vec3 vWorldPos;

uniform vec3 uLightDir;
uniform vec4 uBaseColor;

out vec4 fragColor;

void main() {
  vec3 normal = normalize(vNormal);
  float NdotL = max(dot(normal, -normalize(uLightDir)), 0.0);
  
  // Simple diffuse lighting
  vec3 diffuse = uBaseColor.rgb * (0.3 + 0.7 * NdotL);
  
  // Add some variation based on height
  float heightVar = smoothstep(0.0, 50.0, vWorldPos.y) * 0.1;
  diffuse = mix(diffuse, diffuse * 1.2, heightVar);
  
  // Simple window pattern
  float windowPattern = step(0.7, sin(vUV.x * 20.0) * sin(vUV.y * 30.0));
  diffuse = mix(diffuse, diffuse * 0.3, windowPattern * 0.5);
  
  fragColor = vec4(diffuse, uBaseColor.a);
}
`