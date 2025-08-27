import { mulberry32 } from '../lib/utils'
import type { EraTag } from '../lib/types'
import { IntersectionHandler } from '../lib/intersection-handler'

// Types for road network
type RoadClass = 'highway' | 'avenue' | 'street' | 'local'
type RoadMaterial = 'dirt' | 'cobblestone' | 'asphalt' | 'concrete'

// Zone types for parcels
type ZoneType = 'residential' | 'commercial' | 'industrial' | 'none'
type ZoneDensity = 'low' | 'medium' | 'high'

interface Vec2 {
  x: number
  y: number
}

interface RoadNode {
  id: number
  pos: Vec2
  edges: number[] // IDs of connected nodes
  isIntersection: boolean
}

interface RoadEdge {
  id: number
  nodeA: number
  nodeB: number
  roadClass: RoadClass
  material: RoadMaterial
  width: number // in meters
  length: number // cached length in meters
}

interface RoadSegment {
  start: Vec2
  end: Vec2
  class: RoadClass
  material: RoadMaterial
  width: number
}

interface GenerationConfig {
  seed: number
  era: EraTag
  bounds: { width: number; height: number } // in meters
  gridBias: number // 0.0 = organic, 1.0 = grid
  density: number // 0.1 to 1.0
  blockSizeMin: number // meters
  blockSizeMax: number // meters
  minIntersectionAngle: number // degrees
  centerCount: number // number of city centers
}

// Parcel interfaces
interface Parcel {
  id: number
  vertices: Vec2[] // Polygon vertices in CCW order
  zoneType: ZoneType
  zoneDensity: ZoneDensity
  area: number // square meters
  frontage: number // street frontage in meters
  frontageEdge: number // ID of the road edge this parcel fronts
  isCorner: boolean // true if parcel has frontage on multiple streets
  centroid: Vec2
  blockId: number // ID of the city block this parcel belongs to
}

interface CityBlock {
  id: number
  vertices: Vec2[] // Outer boundary vertices
  holes: Vec2[][] // Inner holes (for blocks with interior voids)
  parcels: number[] // IDs of parcels within this block
  area: number
  perimeter: number
  roadEdges: number[] // IDs of road edges that bound this block
}

interface ZonePaintRequest {
  polygon: Vec2[] // Area to zone
  zoneType: ZoneType
  zoneDensity: ZoneDensity
  subdivisionMethod?: 'skeleton' | 'voronoi' // default 'skeleton'
}

// Constants
const METER_SCALE = 1.0 // 1 unit = 1 meter
const MIN_ROAD_SEPARATION = 20 // meters
const SNAP_THRESHOLD = 15 // meters - snap roads together if closer than this
const INTERSECTION_MERGE_DIST = 10 // meters

// Road widths by class (in meters)
const ROAD_WIDTHS: Record<RoadClass, number> = {
  highway: 24,
  avenue: 16,
  street: 12,
  local: 8
}

// Parcel size configuration by zone type (in meters)
const PARCEL_WIDTHS: Record<ZoneType, { min: number; max: number }> = {
  residential: { min: 15, max: 30 },
  commercial: { min: 20, max: 40 },
  industrial: { min: 30, max: 60 },
  none: { min: 0, max: 0 }
}

// Minimum frontage requirements by zone type (in meters)
const MIN_FRONTAGE: Record<ZoneType, number> = {
  residential: 12,
  commercial: 15,
  industrial: 20,
  none: 0
}

// Parcel depth multipliers (depth = width * multiplier)
const DEPTH_MULTIPLIER: Record<ZoneDensity, number> = {
  low: 2.0,    // Deeper lots for low density
  medium: 1.5, // Standard depth
  high: 1.0    // Shallow lots for high density
}

// Era-based materials
function getMaterialForEra(era: EraTag, roadClass: RoadClass): RoadMaterial {
  const eraYear = parseInt(era.substring(0, 4))
  
  if (eraYear <= 1900) return 'dirt'
  if (eraYear <= 1930) {
    return roadClass === 'highway' || roadClass === 'avenue' ? 'cobblestone' : 'dirt'
  }
  if (eraYear <= 1950) {
    return roadClass === 'local' ? 'dirt' : 'cobblestone'
  }
  if (eraYear <= 1990) {
    return roadClass === 'local' ? 'cobblestone' : 'asphalt'
  }
  return roadClass === 'highway' ? 'concrete' : 'asphalt'
}

// Spatial indexing grid for efficient collision detection
class SpatialGrid {
  private cellSize: number
  private grid: Map<string, number[]>
  private width: number
  private height: number

  constructor(width: number, height: number, cellSize: number = 50) {
    this.width = width
    this.height = height
    this.cellSize = cellSize
    this.grid = new Map()
  }

  private getKey(x: number, y: number): string {
    const gx = Math.floor(x / this.cellSize)
    const gy = Math.floor(y / this.cellSize)
    return `${gx},${gy}`
  }

  insert(nodeId: number, x: number, y: number) {
    const key = this.getKey(x, y)
    if (!this.grid.has(key)) {
      this.grid.set(key, [])
    }
    this.grid.get(key)!.push(nodeId)
  }

  getNearby(x: number, y: number, radius: number): number[] {
    const result: number[] = []
    const cellRadius = Math.ceil(radius / this.cellSize)
    const cx = Math.floor(x / this.cellSize)
    const cy = Math.floor(y / this.cellSize)

    for (let dx = -cellRadius; dx <= cellRadius; dx++) {
      for (let dy = -cellRadius; dy <= cellRadius; dy++) {
        const key = `${cx + dx},${cy + dy}`
        const nodes = this.grid.get(key)
        if (nodes) {
          result.push(...nodes)
        }
      }
    }
    return result
  }

  clear() {
    this.grid.clear()
  }
  
  remove(nodeId: number, x: number, y: number) {
    const key = this.getKey(x, y)
    const nodes = this.grid.get(key)
    if (nodes) {
      const index = nodes.indexOf(nodeId)
      if (index !== -1) {
        nodes.splice(index, 1)
        if (nodes.length === 0) {
          this.grid.delete(key)
        }
      }
    }
  }
}

// Main road network class
class RoadNetwork {
  private nodes: Map<number, RoadNode>
  private edges: Map<number, RoadEdge>
  private spatialIndex: SpatialGrid
  private nextNodeId: number = 0
  private nextEdgeId: number = 0
  private rng: () => number

  constructor(width: number, height: number, rng: () => number) {
    this.nodes = new Map()
    this.edges = new Map()
    this.spatialIndex = new SpatialGrid(width, height)
    this.rng = rng
  }

  addNode(x: number, y: number): number {
    // Check for nearby nodes to snap to
    const nearby = this.spatialIndex.getNearby(x, y, SNAP_THRESHOLD)
    for (const nodeId of nearby) {
      const node = this.nodes.get(nodeId)
      if (node) {
        const dist = this.distance(node.pos, { x, y })
        if (dist < SNAP_THRESHOLD) {
          return nodeId // Snap to existing node
        }
      }
    }

    // Create new node
    const id = this.nextNodeId++
    const node: RoadNode = {
      id,
      pos: { x, y },
      edges: [],
      isIntersection: false
    }
    this.nodes.set(id, node)
    this.spatialIndex.insert(id, x, y)
    return id
  }

  addEdge(nodeAId: number, nodeBId: number, roadClass: RoadClass, material: RoadMaterial): number | null {
    const nodeA = this.nodes.get(nodeAId)
    const nodeB = this.nodes.get(nodeBId)
    if (!nodeA || !nodeB) return null

    // Check if edge already exists
    for (const edgeId of nodeA.edges) {
      const edge = this.edges.get(edgeId)
      if (edge && (edge.nodeB === nodeBId || edge.nodeA === nodeBId)) {
        return edgeId // Edge already exists
      }
    }

    // Check minimum angle constraint with existing edges
    if (!this.checkMinimumAngle(nodeAId, nodeBId, 30)) {
      return null
    }

    const id = this.nextEdgeId++
    const length = this.distance(nodeA.pos, nodeB.pos)
    
    const edge: RoadEdge = {
      id,
      nodeA: nodeAId,
      nodeB: nodeBId,
      roadClass,
      material,
      width: ROAD_WIDTHS[roadClass],
      length
    }

    this.edges.set(id, edge)
    nodeA.edges.push(id)
    nodeB.edges.push(id)

    // Mark as intersections if they have multiple edges
    if (nodeA.edges.length > 1) nodeA.isIntersection = true
    if (nodeB.edges.length > 1) nodeB.isIntersection = true

    return id
  }

  private distance(a: Vec2, b: Vec2): number {
    const dx = b.x - a.x
    const dy = b.y - a.y
    return Math.sqrt(dx * dx + dy * dy)
  }

  private angle(a: Vec2, b: Vec2): number {
    return Math.atan2(b.y - a.y, b.x - a.x)
  }

  private angleDifference(a1: number, a2: number): number {
    let diff = Math.abs(a2 - a1)
    if (diff > Math.PI) diff = 2 * Math.PI - diff
    return diff
  }
  
  removeNode(nodeId: number) {
    const node = this.nodes.get(nodeId)
    if (!node) return
    
    // Remove from spatial index
    this.spatialIndex.remove(nodeId, node.pos.x, node.pos.y)
    
    // Remove associated edges
    for (const edgeId of node.edges) {
      this.removeEdge(edgeId)
    }
    
    // Remove the node
    this.nodes.delete(nodeId)
  }
  
  removeEdge(edgeId: number) {
    const edge = this.edges.get(edgeId)
    if (!edge) return
    
    // Remove edge from connected nodes
    const nodeA = this.nodes.get(edge.nodeA)
    const nodeB = this.nodes.get(edge.nodeB)
    
    if (nodeA) {
      const index = nodeA.edges.indexOf(edgeId)
      if (index !== -1) nodeA.edges.splice(index, 1)
      if (nodeA.edges.length <= 1) nodeA.isIntersection = false
    }
    
    if (nodeB) {
      const index = nodeB.edges.indexOf(edgeId)
      if (index !== -1) nodeB.edges.splice(index, 1)
      if (nodeB.edges.length <= 1) nodeB.isIntersection = false
    }
    
    // Remove the edge
    this.edges.delete(edgeId)
  }

  private checkMinimumAngle(nodeId: number, newNodeId: number, minAngleDeg: number): boolean {
    const node = this.nodes.get(nodeId)
    const newNode = this.nodes.get(newNodeId)
    if (!node || !newNode) return false

    const minAngleRad = (minAngleDeg * Math.PI) / 180
    const newAngle = this.angle(node.pos, newNode.pos)

    for (const edgeId of node.edges) {
      const edge = this.edges.get(edgeId)
      if (!edge) continue

      const otherId = edge.nodeA === nodeId ? edge.nodeB : edge.nodeA
      const otherNode = this.nodes.get(otherId)
      if (!otherNode) continue

      const existingAngle = this.angle(node.pos, otherNode.pos)
      const diff = this.angleDifference(newAngle, existingAngle)
      
      if (diff < minAngleRad) {
        return false
      }
    }

    return true
  }

  // Get typed arrays for efficient storage and transfer
  getTypedArrays(): {
    nodePositions: Float32Array
    nodeConnections: Uint32Array
    edgeData: Uint32Array
    roadSegments: Float32Array
  } {
    const nodeCount = this.nodes.size
    const edgeCount = this.edges.size

    // Node positions: [x, y] for each node
    const nodePositions = new Float32Array(nodeCount * 2)
    
    // Node connections: [edgeCount, edge1, edge2, ...] for each node
    const maxEdgesPerNode = 8
    const nodeConnections = new Uint32Array(nodeCount * (1 + maxEdgesPerNode))
    
    // Edge data: [nodeA, nodeB, roadClass, material, width] for each edge
    const edgeData = new Uint32Array(edgeCount * 5)
    
    // Road segments for rendering: [startX, startY, endX, endY, width, class] for each edge
    const roadSegments = new Float32Array(edgeCount * 6)

    // Fill node positions
    let nodeIndex = 0
    const nodeIdMap = new Map<number, number>()
    for (const [id, node] of this.nodes) {
      nodeIdMap.set(id, nodeIndex)
      nodePositions[nodeIndex * 2] = node.pos.x
      nodePositions[nodeIndex * 2 + 1] = node.pos.y
      
      // Fill connections
      const connOffset = nodeIndex * (1 + maxEdgesPerNode)
      nodeConnections[connOffset] = Math.min(node.edges.length, maxEdgesPerNode)
      for (let i = 0; i < Math.min(node.edges.length, maxEdgesPerNode); i++) {
        nodeConnections[connOffset + 1 + i] = node.edges[i]
      }
      
      nodeIndex++
    }

    // Fill edge data and road segments
    let edgeIndex = 0
    for (const [id, edge] of this.edges) {
      const nodeA = this.nodes.get(edge.nodeA)
      const nodeB = this.nodes.get(edge.nodeB)
      if (!nodeA || !nodeB) continue

      // Edge data
      const edgeOffset = edgeIndex * 5
      edgeData[edgeOffset] = nodeIdMap.get(edge.nodeA) || 0
      edgeData[edgeOffset + 1] = nodeIdMap.get(edge.nodeB) || 0
      edgeData[edgeOffset + 2] = this.roadClassToInt(edge.roadClass)
      edgeData[edgeOffset + 3] = this.materialToInt(edge.material)
      edgeData[edgeOffset + 4] = edge.width

      // Road segments
      const segOffset = edgeIndex * 6
      roadSegments[segOffset] = nodeA.pos.x
      roadSegments[segOffset + 1] = nodeA.pos.y
      roadSegments[segOffset + 2] = nodeB.pos.x
      roadSegments[segOffset + 3] = nodeB.pos.y
      roadSegments[segOffset + 4] = edge.width
      roadSegments[segOffset + 5] = this.roadClassToInt(edge.roadClass)

      edgeIndex++
    }

    return { nodePositions, nodeConnections, edgeData, roadSegments }
  }

  private roadClassToInt(roadClass: RoadClass): number {
    const map: Record<RoadClass, number> = {
      highway: 0,
      avenue: 1,
      street: 2,
      local: 3
    }
    return map[roadClass]
  }

  private materialToInt(material: RoadMaterial): number {
    const map: Record<RoadMaterial, number> = {
      dirt: 0,
      cobblestone: 1,
      asphalt: 2,
      concrete: 3
    }
    return map[material]
  }

  getRoadSegments(): RoadSegment[] {
    const segments: RoadSegment[] = []
    for (const edge of this.edges.values()) {
      const nodeA = this.nodes.get(edge.nodeA)
      const nodeB = this.nodes.get(edge.nodeB)
      if (!nodeA || !nodeB) continue

      segments.push({
        start: { ...nodeA.pos },
        end: { ...nodeB.pos },
        class: edge.roadClass,
        material: edge.material,
        width: edge.width
      })
    }
    return segments
  }

  clear() {
    this.nodes.clear()
    this.edges.clear()
    this.spatialIndex.clear()
    this.nextNodeId = 0
    this.nextEdgeId = 0
  }
}

// Road network generator
class RoadGenerator {
  private network: RoadNetwork
  private config: GenerationConfig
  private rng: () => number

  constructor(config: GenerationConfig, rng: () => number) {
    this.config = config
    this.rng = rng
    this.network = new RoadNetwork(config.bounds.width, config.bounds.height, rng)
  }

  generate(): RoadNetwork {
    this.network.clear()

    // Don't auto-generate roads - let user draw them manually
    // Keep the network empty for user-drawn roads
    console.log('[RoadGen] Network initialized for manual road drawing')

    return this.network
  }

  private generateCenters(): Vec2[] {
    const centers: Vec2[] = []
    const margin = Math.min(this.config.bounds.width, this.config.bounds.height) * 0.15
    
    if (this.config.centerCount === 1) {
      // Single center - place it slightly off-center for organic feel
      centers.push({
        x: this.config.bounds.width * (0.4 + this.rng() * 0.2),
        y: this.config.bounds.height * (0.4 + this.rng() * 0.2)
      })
    } else {
      // Multiple centers - use Poisson disk sampling for better distribution
      const minDist = Math.min(this.config.bounds.width, this.config.bounds.height) / (this.config.centerCount + 1)
      
      for (let i = 0; i < this.config.centerCount; i++) {
        let attempts = 0
        let validPosition = false
        let newCenter: Vec2 = { x: 0, y: 0 }
        
        while (!validPosition && attempts < 30) {
          newCenter = {
            x: margin + this.rng() * (this.config.bounds.width - 2 * margin),
            y: margin + this.rng() * (this.config.bounds.height - 2 * margin)
          }
          
          validPosition = true
          for (const existing of centers) {
            const dist = this.distance(existing, newCenter)
            if (dist < minDist) {
              validPosition = false
              break
            }
          }
          attempts++
        }
        
        if (validPosition) {
          centers.push(newCenter)
        }
      }
    }
    
    return centers
  }

  private generateRadialRoads(centers: Vec2[]) {
    for (const center of centers) {
      const centerNode = this.network.addNode(center.x, center.y)
      
      // Vary number of rays based on density and era
      const baseRays = 5 + Math.floor(this.config.density * 4)
      const numRays = baseRays + Math.floor(this.rng() * 3)
      const angleOffset = this.rng() * Math.PI * 2
      
      // Track angles to ensure good distribution
      const rayAngles: number[] = []
      
      for (let i = 0; i < numRays; i++) {
        // Calculate base angle with golden ratio for better distribution
        const goldenAngle = Math.PI * (3 - Math.sqrt(5))
        const baseAngle = angleOffset + i * goldenAngle
        
        // Add organic variation
        const angleVariation = (this.rng() - 0.5) * 0.4
        let finalAngle = baseAngle + angleVariation
        
        // Ensure minimum separation between rays
        let tooClose = false
        for (const existingAngle of rayAngles) {
          const diff = Math.abs(this.angleDifference(finalAngle, existingAngle))
          if (diff < (this.config.minIntersectionAngle * Math.PI / 180)) {
            tooClose = true
            break
          }
        }
        if (tooClose) continue
        rayAngles.push(finalAngle)
        
        // Calculate ray length with falloff from center
        const distFromMapCenter = this.distance(center, {
          x: this.config.bounds.width / 2,
          y: this.config.bounds.height / 2
        })
        const centralityFactor = 1 - (distFromMapCenter / (Math.max(this.config.bounds.width, this.config.bounds.height) / 2))
        const rayLength = (this.config.bounds.width + this.config.bounds.height) / 4 * (0.5 + centralityFactor * 0.5 + this.rng() * 0.3)
        
        // Generate ray with organic curves
        const points = this.generateOrganicPath(
          center,
          {
            x: center.x + Math.cos(finalAngle) * rayLength,
            y: center.y + Math.sin(finalAngle) * rayLength
          },
          'radial'
        )
        
        // Create road segments
        let prevNode = centerNode
        for (let j = 1; j < points.length; j++) {
          const point = this.clipToBounds(points[j])
          const nodeId = this.network.addNode(point.x, point.y)
          
          // Road class based on distance from center
          const distFromCenter = this.distance(center, point)
          const roadClass: RoadClass = 
            distFromCenter < 100 ? 'avenue' :
            distFromCenter < 300 ? 'street' : 'local'
            
          const material = getMaterialForEra(this.config.era, roadClass)
          this.network.addEdge(prevNode, nodeId, roadClass, material)
          prevNode = nodeId
        }
      }
    }
  }

  private generateHighwayNetwork(centers: Vec2[]) {
    // Generate major highways connecting city centers and map edges
    if (centers.length < 2) return
    
    // Connect centers with highways
    for (let i = 0; i < centers.length; i++) {
      for (let j = i + 1; j < centers.length; j++) {
        const path = this.generateOrganicPath(centers[i], centers[j], 'highway')
        this.createRoadFromPath(path, 'highway')
      }
    }
    
    // Add ring roads around major centers
    for (const center of centers.slice(0, 2)) { // Only first 2 centers get ring roads
      const radius = 200 + this.rng() * 100
      const points = 16
      const ringNodes: number[] = []
      
      for (let i = 0; i < points; i++) {
        const angle = (i / points) * Math.PI * 2
        const r = radius + (this.rng() - 0.5) * 30 // Add variation
        const x = center.x + Math.cos(angle) * r
        const y = center.y + Math.sin(angle) * r
        
        if (x >= 0 && x <= this.config.bounds.width && y >= 0 && y <= this.config.bounds.height) {
          const nodeId = this.network.addNode(x, y)
          ringNodes.push(nodeId)
        }
      }
      
      // Connect ring road segments
      for (let i = 0; i < ringNodes.length; i++) {
        const next = (i + 1) % ringNodes.length
        const material = getMaterialForEra(this.config.era, 'highway')
        this.network.addEdge(ringNodes[i], ringNodes[next], 'highway', material)
      }
    }
  }
  
  private generateAdaptiveGrid() {
    // Generate grid that adapts to existing road network
    const gridSize = (this.config.blockSizeMin + this.config.blockSizeMax) / 2
    const gridVariation = (this.config.blockSizeMax - this.config.blockSizeMin) / 2
    
    // Find regions between major roads
    const regions = this.findEmptyRegions()
    
    for (const region of regions) {
      // Determine grid orientation based on nearby roads
      const orientation = this.calculateRegionOrientation(region)
      
      // Generate aligned grid within region
      this.generateAlignedGrid(region, orientation, gridSize, gridVariation)
    }
  }
  
  private generateLocalRoads() {
    // Fill in local roads in areas that still have large gaps
    const nodes = Array.from(this.network['nodes'].values())
    const threshold = this.config.blockSizeMax * 1.5
    
    // Find areas that need more roads
    for (let x = 50; x < this.config.bounds.width - 50; x += threshold / 2) {
      for (let y = 50; y < this.config.bounds.height - 50; y += threshold / 2) {
        const nearby = this.network['spatialIndex'].getNearby(x, y, threshold)
        
        if (nearby.length === 0) {
          // This area needs roads
          this.generateLocalCluster({ x, y }, threshold / 2)
        }
      }
    }
  }
  
  private generateOrganicPath(start: Vec2, end: Vec2, pathType: 'highway' | 'radial' | 'local'): Vec2[] {
    const points: Vec2[] = [start]
    const dist = this.distance(start, end)
    
    // Number of segments based on distance and path type
    const segments = pathType === 'highway' ? 
      Math.ceil(dist / 150) : 
      Math.ceil(dist / 80)
    
    // Generate intermediate points with organic curves
    for (let i = 1; i < segments; i++) {
      const t = i / segments
      
      // Linear interpolation
      let x = start.x + (end.x - start.x) * t
      let y = start.y + (end.y - start.y) * t
      
      // Add perpendicular offset for curves
      const perpAngle = this.angle(start, end) + Math.PI / 2
      const curveStrength = pathType === 'highway' ? 15 : 25
      const offset = Math.sin(t * Math.PI) * curveStrength * (this.rng() - 0.5) * 2
      
      x += Math.cos(perpAngle) * offset
      y += Math.sin(perpAngle) * offset
      
      // Add small random perturbations
      if (pathType !== 'highway') {
        x += (this.rng() - 0.5) * 10
        y += (this.rng() - 0.5) * 10
      }
      
      points.push({ x, y })
    }
    
    points.push(end)
    return points
  }
  
  private createRoadFromPath(path: Vec2[], roadClass: RoadClass) {
    if (path.length < 2) return
    
    const material = getMaterialForEra(this.config.era, roadClass)
    let prevNode = this.network.addNode(path[0].x, path[0].y)
    
    for (let i = 1; i < path.length; i++) {
      const node = this.network.addNode(path[i].x, path[i].y)
      this.network.addEdge(prevNode, node, roadClass, material)
      prevNode = node
    }
  }
  
  private findEmptyRegions(): { center: Vec2, radius: number }[] {
    const regions: { center: Vec2, radius: number }[] = []
    const testRadius = this.config.blockSizeMax * 2
    const step = testRadius
    
    for (let x = testRadius; x < this.config.bounds.width - testRadius; x += step) {
      for (let y = testRadius; y < this.config.bounds.height - testRadius; y += step) {
        const nearby = this.network['spatialIndex'].getNearby(x, y, testRadius)
        
        // Check if this region has few roads
        if (nearby.length < 3) {
          // Measure actual empty space
          let actualRadius = testRadius
          for (const nodeId of nearby) {
            const node = this.network['nodes'].get(nodeId)
            if (node) {
              const dist = this.distance({ x, y }, node.pos)
              actualRadius = Math.min(actualRadius, dist * 0.8)
            }
          }
          
          if (actualRadius > this.config.blockSizeMin) {
            regions.push({ center: { x, y }, radius: actualRadius })
          }
        }
      }
    }
    
    return regions
  }
  
  private calculateRegionOrientation(region: { center: Vec2, radius: number }): number {
    // Find nearby roads and calculate their average orientation
    const nearby = this.network['spatialIndex'].getNearby(
      region.center.x, 
      region.center.y, 
      region.radius * 2
    )
    
    if (nearby.length < 2) {
      // Default to north-south orientation
      return 0
    }
    
    // Calculate average angle of nearby edges
    let totalAngle = 0
    let count = 0
    
    for (const nodeId of nearby) {
      const node = this.network['nodes'].get(nodeId)
      if (!node) continue
      
      for (const edgeId of node.edges) {
        const edge = this.network['edges'].get(edgeId)
        if (!edge) continue
        
        const otherNodeId = edge.nodeA === nodeId ? edge.nodeB : edge.nodeA
        const otherNode = this.network['nodes'].get(otherNodeId)
        if (!otherNode) continue
        
        const angle = this.angle(node.pos, otherNode.pos)
        totalAngle += angle
        count++
      }
    }
    
    return count > 0 ? totalAngle / count : 0
  }
  
  private generateAlignedGrid(
    region: { center: Vec2, radius: number },
    orientation: number,
    gridSize: number,
    gridVariation: number
  ) {
    const cos = Math.cos(orientation)
    const sin = Math.sin(orientation)
    
    // Generate grid points within the region
    const gridNodes: Map<string, number> = new Map()
    const steps = Math.floor(region.radius * 2 / gridSize)
    
    for (let i = -steps / 2; i <= steps / 2; i++) {
      for (let j = -steps / 2; j <= steps / 2; j++) {
        // Transform grid coordinates by orientation
        const localX = i * gridSize + (this.rng() - 0.5) * gridVariation
        const localY = j * gridSize + (this.rng() - 0.5) * gridVariation
        
        const x = region.center.x + localX * cos - localY * sin
        const y = region.center.y + localX * sin + localY * cos
        
        // Check if within region and bounds
        const dist = this.distance(region.center, { x, y })
        if (dist > region.radius) continue
        if (x < 0 || x > this.config.bounds.width || y < 0 || y > this.config.bounds.height) continue
        
        // Check for existing roads
        const nearby = this.network['spatialIndex'].getNearby(x, y, MIN_ROAD_SEPARATION)
        if (nearby.length > 0) continue
        
        const nodeId = this.network.addNode(x, y)
        gridNodes.set(`${i},${j}`, nodeId)
      }
    }
    
    // Connect grid nodes
    for (const [key, nodeId] of gridNodes) {
      const [i, j] = key.split(',').map(Number)
      
      // Connect to neighbors
      const neighbors = [
        [`${i + 1},${j}`, 'horizontal'],
        [`${i},${j + 1}`, 'vertical']
      ]
      
      for (const [neighborKey, direction] of neighbors) {
        if (gridNodes.has(neighborKey)) {
          const neighborId = gridNodes.get(neighborKey)!
          
          // Vary road class based on position
          const roadClass: RoadClass = 
            (Math.abs(i) + Math.abs(j)) % 4 === 0 ? 'street' : 'local'
            
          const material = getMaterialForEra(this.config.era, roadClass)
          this.network.addEdge(nodeId, neighborId, roadClass, material)
        }
      }
    }
  }
  
  private generateLocalCluster(center: Vec2, radius: number) {
    // Generate a small cluster of local roads
    const numRoads = 3 + Math.floor(this.rng() * 3)
    const centerNode = this.network.addNode(center.x, center.y)
    
    for (let i = 0; i < numRoads; i++) {
      const angle = (i / numRoads) * Math.PI * 2 + this.rng() * 0.5
      const length = radius * (0.5 + this.rng() * 0.5)
      
      const endX = center.x + Math.cos(angle) * length
      const endY = center.y + Math.sin(angle) * length
      
      if (endX >= 0 && endX <= this.config.bounds.width && 
          endY >= 0 && endY <= this.config.bounds.height) {
        const endNode = this.network.addNode(endX, endY)
        const material = getMaterialForEra(this.config.era, 'local')
        this.network.addEdge(centerNode, endNode, 'local', material)
      }
    }
  }

  private connectIsolatedSections() {
    // Find disconnected components and connect them
    const components = this.findConnectedComponents()
    
    if (components.length <= 1) return // Already connected
    
    // Connect each component to the largest one
    const largestComponent = components.reduce((largest, current) => 
      current.size > largest.size ? current : largest
    )
    
    for (const component of components) {
      if (component === largestComponent) continue
      
      // Find closest pair of nodes between components
      let minDist = Infinity
      let bestPair: [number, number] | null = null
      
      for (const nodeId of component) {
        const node = this.network['nodes'].get(nodeId)
        if (!node) continue
        
        for (const otherNodeId of largestComponent) {
          const otherNode = this.network['nodes'].get(otherNodeId)
          if (!otherNode) continue
          
          const dist = this.distance(node.pos, otherNode.pos)
          if (dist < minDist) {
            minDist = dist
            bestPair = [nodeId, otherNodeId]
          }
        }
      }
      
      // Connect the components
      if (bestPair && minDist < this.config.bounds.width / 4) {
        const material = getMaterialForEra(this.config.era, 'street')
        this.network.addEdge(bestPair[0], bestPair[1], 'street', material)
      }
    }
  }
  
  private findConnectedComponents(): Set<number>[] {
    const visited = new Set<number>()
    const components: Set<number>[] = []
    
    for (const [nodeId] of this.network['nodes']) {
      if (!visited.has(nodeId)) {
        const component = new Set<number>()
        this.dfsComponent(nodeId, visited, component)
        components.push(component)
      }
    }
    
    return components
  }
  
  private dfsComponent(nodeId: number, visited: Set<number>, component: Set<number>) {
    visited.add(nodeId)
    component.add(nodeId)
    
    const node = this.network['nodes'].get(nodeId)
    if (!node) return
    
    for (const edgeId of node.edges) {
      const edge = this.network['edges'].get(edgeId)
      if (!edge) continue
      
      const neighborId = edge.nodeA === nodeId ? edge.nodeB : edge.nodeA
      if (!visited.has(neighborId)) {
        this.dfsComponent(neighborId, visited, component)
      }
    }
  }

  private mergeCloseIntersections() {
    // Merge intersections that are too close together
    const nodes = Array.from(this.network['nodes'].values())
    const toMerge: Map<number, number> = new Map()
    
    for (let i = 0; i < nodes.length; i++) {
      const nodeA = nodes[i]
      if (toMerge.has(nodeA.id)) continue
      
      for (let j = i + 1; j < nodes.length; j++) {
        const nodeB = nodes[j]
        if (toMerge.has(nodeB.id)) continue
        
        const dist = this.distance(nodeA.pos, nodeB.pos)
        if (dist < INTERSECTION_MERGE_DIST && nodeA.isIntersection && nodeB.isIntersection) {
          // Merge nodeB into nodeA
          toMerge.set(nodeB.id, nodeA.id)
        }
      }
    }
    
    // Perform merges
    for (const [mergeFrom, mergeTo] of toMerge) {
      this.mergeNodes(mergeFrom, mergeTo)
    }
  }
  
  private mergeNodes(fromId: number, toId: number) {
    const fromNode = this.network['nodes'].get(fromId)
    const toNode = this.network['nodes'].get(toId)
    if (!fromNode || !toNode) return
    
    // Redirect all edges from fromNode to toNode
    for (const edgeId of fromNode.edges) {
      const edge = this.network['edges'].get(edgeId)
      if (!edge) continue
      
      // Update edge endpoints
      if (edge.nodeA === fromId) {
        edge.nodeA = toId
      }
      if (edge.nodeB === fromId) {
        edge.nodeB = toId
      }
      
      // Add edge to toNode if not already there
      if (!toNode.edges.includes(edgeId)) {
        toNode.edges.push(edgeId)
      }
    }
    
    // Remove the merged node
    this.network['nodes'].delete(fromId)
    
    // Update intersection status
    if (toNode.edges.length > 1) {
      toNode.isIntersection = true
    }
  }
  
  private optimizeIntersectionAngles() {
    // Adjust intersection positions to improve angles between roads
    const intersections = Array.from(this.network['nodes'].values())
      .filter(node => node.isIntersection && node.edges.length > 2)
    
    for (const intersection of intersections) {
      // Calculate optimal position based on connected roads
      const connectedPositions: Vec2[] = []
      
      for (const edgeId of intersection.edges) {
        const edge = this.network['edges'].get(edgeId)
        if (!edge) continue
        
        const otherId = edge.nodeA === intersection.id ? edge.nodeB : edge.nodeA
        const otherNode = this.network['nodes'].get(otherId)
        if (otherNode) {
          connectedPositions.push(otherNode.pos)
        }
      }
      
      if (connectedPositions.length < 3) continue
      
      // Calculate angles between roads
      const angles: number[] = []
      for (let i = 0; i < connectedPositions.length; i++) {
        const angle = this.angle(intersection.pos, connectedPositions[i])
        angles.push(angle)
      }
      angles.sort((a, b) => a - b)
      
      // Check if angles are well distributed
      let minAngleDiff = Math.PI * 2
      for (let i = 0; i < angles.length; i++) {
        const next = (i + 1) % angles.length
        const diff = angles[next] - angles[i]
        minAngleDiff = Math.min(minAngleDiff, diff)
      }
      
      // If angles are too close, slightly adjust position
      if (minAngleDiff < (this.config.minIntersectionAngle * Math.PI / 180)) {
        // Move intersection slightly to improve angles
        const adjustment = 5 // meters
        intersection.pos.x += (this.rng() - 0.5) * adjustment
        intersection.pos.y += (this.rng() - 0.5) * adjustment
        
        // Update spatial index
        this.network['spatialIndex'].clear()
        for (const [id, node] of this.network['nodes']) {
          this.network['spatialIndex'].insert(id, node.pos.x, node.pos.y)
        }
      }
    }
  }
  
  private applyEraEvolution() {
    // Update road materials and widths based on era
    const eraYear = parseInt(this.config.era.substring(0, 4))
    
    for (const edge of this.network['edges'].values()) {
      // Update material based on era and road class
      edge.material = getMaterialForEra(this.config.era, edge.roadClass)
      
      // Adjust widths for different eras
      if (eraYear <= 1920) {
        // Narrower roads in early eras
        edge.width = ROAD_WIDTHS[edge.roadClass] * 0.8
      } else if (eraYear >= 1960) {
        // Wider roads in modern eras
        edge.width = ROAD_WIDTHS[edge.roadClass] * 1.1
      }
      
      // Upgrade some roads in later eras
      if (eraYear >= 1950 && edge.roadClass === 'street') {
        // Some streets become avenues
        const shouldUpgrade = this.rng() < 0.2
        if (shouldUpgrade) {
          edge.roadClass = 'avenue'
          edge.width = ROAD_WIDTHS['avenue']
        }
      }
    }
  }

  private clipToBounds(point: Vec2): Vec2 {
    return {
      x: Math.max(0, Math.min(this.config.bounds.width, point.x)),
      y: Math.max(0, Math.min(this.config.bounds.height, point.y))
    }
  }
  
  private distance(a: Vec2, b: Vec2): number {
    const dx = b.x - a.x
    const dy = b.y - a.y
    return Math.sqrt(dx * dx + dy * dy)
  }
  
  private angle(a: Vec2, b: Vec2): number {
    return Math.atan2(b.y - a.y, b.x - a.x)
  }
  
  private angleDifference(a1: number, a2: number): number {
    let diff = Math.abs(a2 - a1)
    if (diff > Math.PI) diff = 2 * Math.PI - diff
    return diff
  }

  paintRoad(start: Vec2, end: Vec2, roadClass: RoadClass): boolean {
    // Add a new road segment painted by the player
    const startNode = this.network.addNode(start.x, start.y)
    const endNode = this.network.addNode(end.x, end.y)
    
    const material = getMaterialForEra(this.config.era, roadClass)
    const edgeId = this.network.addEdge(startNode, endNode, roadClass, material)
    
    return edgeId !== null
  }

  getNetwork(): RoadNetwork {
    return this.network
  }
}

// Geometric utilities for parcel subdivision
class GeometryUtils {
  // Calculate polygon area using shoelace formula
  static polygonArea(vertices: Vec2[]): number {
    let area = 0
    const n = vertices.length
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      area += vertices[i].x * vertices[j].y
      area -= vertices[j].x * vertices[i].y
    }
    return Math.abs(area) / 2
  }

  // Calculate polygon centroid
  static polygonCentroid(vertices: Vec2[]): Vec2 {
    let cx = 0, cy = 0
    const area = this.polygonArea(vertices)
    const n = vertices.length
    
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const factor = vertices[i].x * vertices[j].y - vertices[j].x * vertices[i].y
      cx += (vertices[i].x + vertices[j].x) * factor
      cy += (vertices[i].y + vertices[j].y) * factor
    }
    
    const scale = 1 / (6 * area)
    return { x: Math.abs(cx * scale), y: Math.abs(cy * scale) }
  }

  // Calculate distance from point to line segment
  static pointToSegmentDistance(point: Vec2, segStart: Vec2, segEnd: Vec2): number {
    const dx = segEnd.x - segStart.x
    const dy = segEnd.y - segStart.y
    const lengthSq = dx * dx + dy * dy
    
    if (lengthSq === 0) {
      return Math.sqrt((point.x - segStart.x) ** 2 + (point.y - segStart.y) ** 2)
    }
    
    let t = ((point.x - segStart.x) * dx + (point.y - segStart.y) * dy) / lengthSq
    t = Math.max(0, Math.min(1, t))
    
    const projX = segStart.x + t * dx
    const projY = segStart.y + t * dy
    
    return Math.sqrt((point.x - projX) ** 2 + (point.y - projY) ** 2)
  }

  // Check if point is inside polygon
  static pointInPolygon(point: Vec2, vertices: Vec2[]): boolean {
    let inside = false
    const n = vertices.length
    
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = vertices[i].x, yi = vertices[i].y
      const xj = vertices[j].x, yj = vertices[j].y
      
      const intersect = ((yi > point.y) !== (yj > point.y)) &&
        (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi)
      
      if (intersect) inside = !inside
    }
    
    return inside
  }

  // Offset polygon inward by distance
  static offsetPolygon(vertices: Vec2[], offset: number): Vec2[] {
    const n = vertices.length
    const offsetVertices: Vec2[] = []
    
    for (let i = 0; i < n; i++) {
      const prev = vertices[(i - 1 + n) % n]
      const curr = vertices[i]
      const next = vertices[(i + 1) % n]
      
      // Calculate edge normals
      const dx1 = curr.x - prev.x
      const dy1 = curr.y - prev.y
      const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1)
      const nx1 = -dy1 / len1
      const ny1 = dx1 / len1
      
      const dx2 = next.x - curr.x
      const dy2 = next.y - curr.y
      const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2)
      const nx2 = -dy2 / len2
      const ny2 = dx2 / len2
      
      // Average normal direction
      let nx = (nx1 + nx2) / 2
      let ny = (ny1 + ny2) / 2
      const nlen = Math.sqrt(nx * nx + ny * ny)
      
      if (nlen > 0.001) {
        nx /= nlen
        ny /= nlen
        
        // Scale by offset divided by sin of half angle
        const dot = nx1 * nx2 + ny1 * ny2
        const scale = offset / Math.sqrt((1 + dot) / 2)
        
        offsetVertices.push({
          x: curr.x + nx * scale,
          y: curr.y + ny * scale
        })
      } else {
        offsetVertices.push({ ...curr })
      }
    }
    
    return offsetVertices
  }

  // Calculate perimeter length
  static polygonPerimeter(vertices: Vec2[]): number {
    let perimeter = 0
    const n = vertices.length
    
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const dx = vertices[j].x - vertices[i].x
      const dy = vertices[j].y - vertices[i].y
      perimeter += Math.sqrt(dx * dx + dy * dy)
    }
    
    return perimeter
  }

  // Line intersection for subdivision
  static lineIntersection(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): Vec2 | null {
    const denom = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x)
    
    if (Math.abs(denom) < 0.0001) return null
    
    const t = ((p1.x - p3.x) * (p3.y - p4.y) - (p1.y - p3.y) * (p3.x - p4.x)) / denom
    const u = -((p1.x - p2.x) * (p1.y - p3.y) - (p1.y - p2.y) * (p1.x - p3.x)) / denom
    
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      return {
        x: p1.x + t * (p2.x - p1.x),
        y: p1.y + t * (p2.y - p1.y)
      }
    }
    
    return null
  }
}

// Parcel subdivision algorithms
class ParcelSubdivider {
  private rng: () => number
  
  constructor(rng: () => number) {
    this.rng = rng
  }

  // Straight skeleton subdivision (improved version)
  subdivideWithSkeleton(
    block: Vec2[],
    zoneType: ZoneType,
    zoneDensity: ZoneDensity,
    frontageEdgeIndex: number
  ): Vec2[][] {
    const parcels: Vec2[][] = []
    
    // Adjust parcel sizes based on zone type and density
    const baseWidth = PARCEL_WIDTHS[zoneType]
    const densityMultiplier = zoneDensity === 'high' ? 0.7 : zoneDensity === 'medium' ? 0.85 : 1.0
    const targetWidth = ((baseWidth.min + baseWidth.max) / 2) * densityMultiplier
    const targetDepth = targetWidth * DEPTH_MULTIPLIER[zoneDensity]
    
    // Get the frontage edge
    const frontStart = block[frontageEdgeIndex]
    const frontEnd = block[(frontageEdgeIndex + 1) % block.length]
    const frontageLength = Math.sqrt(
      (frontEnd.x - frontStart.x) ** 2 + (frontEnd.y - frontStart.y) ** 2
    )
    
    // Calculate number of parcels that fit along frontage
    const minParcels = Math.max(1, Math.floor(frontageLength / baseWidth.max))
    const maxParcels = Math.max(1, Math.ceil(frontageLength / baseWidth.min))
    const numParcels = Math.max(1, Math.round(frontageLength / targetWidth))
    const actualWidth = frontageLength / numParcels
    
    // Create parcels by subdividing perpendicular to frontage
    const frontDir = {
      x: (frontEnd.x - frontStart.x) / frontageLength,
      y: (frontEnd.y - frontStart.y) / frontageLength
    }
    const perpDir = { x: -frontDir.y, y: frontDir.x }
    
    // Check if we should do double-depth subdivision (two rows of parcels)
    const blockDepth = this.estimateBlockDepth(block, frontageEdgeIndex)
    const doDoubleRow = blockDepth > targetDepth * 2.5 && zoneDensity !== 'low'
    
    for (let i = 0; i < numParcels; i++) {
      const t1 = i / numParcels
      const t2 = (i + 1) / numParcels
      
      // Create front row parcel
      const p1 = {
        x: frontStart.x + t1 * (frontEnd.x - frontStart.x),
        y: frontStart.y + t1 * (frontEnd.y - frontStart.y)
      }
      const p2 = {
        x: frontStart.x + t2 * (frontEnd.x - frontStart.x),
        y: frontStart.y + t2 * (frontEnd.y - frontStart.y)
      }
      const p3 = {
        x: p2.x + perpDir.x * targetDepth,
        y: p2.y + perpDir.y * targetDepth
      }
      const p4 = {
        x: p1.x + perpDir.x * targetDepth,
        y: p1.y + perpDir.y * targetDepth
      }
      
      // Clip parcel to block boundaries
      const frontParcel = this.clipToPolygon([p1, p2, p3, p4], block)
      if (frontParcel.length >= 3) {
        const area = GeometryUtils.polygonArea(frontParcel)
        if (area >= 50) {  // Minimum area check
          parcels.push(frontParcel)
        }
      }
      
      // Create back row parcel if doing double row
      if (doDoubleRow) {
        const backP1 = {
          x: p4.x,
          y: p4.y
        }
        const backP2 = {
          x: p3.x,
          y: p3.y
        }
        const backP3 = {
          x: p3.x + perpDir.x * targetDepth,
          y: p3.y + perpDir.y * targetDepth
        }
        const backP4 = {
          x: p4.x + perpDir.x * targetDepth,
          y: p4.y + perpDir.y * targetDepth
        }
        
        const backParcel = this.clipToPolygon([backP1, backP2, backP3, backP4], block)
        if (backParcel.length >= 3) {
          const area = GeometryUtils.polygonArea(backParcel)
          if (area >= 50) {
            parcels.push(backParcel)
          }
        }
      }
    }
    
    return parcels
  }

  // Voronoi subdivision (improved version)
  subdivideWithVoronoi(
    block: Vec2[],
    zoneType: ZoneType,
    zoneDensity: ZoneDensity
  ): Vec2[][] {
    const parcels: Vec2[][] = []
    const blockArea = GeometryUtils.polygonArea(block)
    
    // Calculate target parcel area based on zone type and density
    const baseWidth = PARCEL_WIDTHS[zoneType]
    const avgWidth = (baseWidth.min + baseWidth.max) / 2
    const densityMultiplier = zoneDensity === 'high' ? 0.6 : zoneDensity === 'medium' ? 0.8 : 1.0
    const targetParcelArea = avgWidth * avgWidth * DEPTH_MULTIPLIER[zoneDensity] * densityMultiplier
    
    // Calculate number of parcels
    const minParcels = Math.max(2, Math.floor(blockArea / (baseWidth.max * baseWidth.max * 2)))
    const maxParcels = Math.ceil(blockArea / (baseWidth.min * baseWidth.min * 0.8))
    const numParcels = Math.max(2, Math.min(maxParcels, Math.round(blockArea / targetParcelArea)))
    
    // Generate seed points for Voronoi cells
    const seeds: Vec2[] = []
    const bounds = this.getPolygonBounds(block)
    
    // Try grid-based seed placement first for more regular parcels
    const gridSize = Math.ceil(Math.sqrt(numParcels))
    const cellWidth = (bounds.maxX - bounds.minX) / gridSize
    const cellHeight = (bounds.maxY - bounds.minY) / gridSize
    
    for (let row = 0; row < gridSize && seeds.length < numParcels; row++) {
      for (let col = 0; col < gridSize && seeds.length < numParcels; col++) {
        // Add some randomness to avoid perfect grid
        const jitterX = (this.rng() - 0.5) * cellWidth * 0.3
        const jitterY = (this.rng() - 0.5) * cellHeight * 0.3
        
        const x = bounds.minX + (col + 0.5) * cellWidth + jitterX
        const y = bounds.minY + (row + 0.5) * cellHeight + jitterY
        const point = { x, y }
        
        if (GeometryUtils.pointInPolygon(point, block)) {
          seeds.push(point)
        }
      }
    }
    
    // Fill remaining with random points if needed
    let attempts = 0
    while (seeds.length < numParcels && attempts < numParcels * 20) {
      const x = bounds.minX + this.rng() * (bounds.maxX - bounds.minX)
      const y = bounds.minY + this.rng() * (bounds.maxY - bounds.minY)
      const point = { x, y }
      
      if (GeometryUtils.pointInPolygon(point, block)) {
        // Check minimum distance to other seeds
        let tooClose = false
        const minDist = Math.sqrt(targetParcelArea) * 0.4
        
        for (const seed of seeds) {
          const dist = Math.sqrt((seed.x - x) ** 2 + (seed.y - y) ** 2)
          if (dist < minDist) {
            tooClose = true
            break
          }
        }
        
        if (!tooClose) {
          seeds.push(point)
        }
      }
      attempts++
    }
    
    // Create Voronoi cells
    for (let i = 0; i < seeds.length; i++) {
      const cell = this.computeVoronoiCell(seeds[i], seeds, block)
      if (cell.length >= 3) {
        const area = GeometryUtils.polygonArea(cell)
        if (area >= 50) {  // Minimum area check
          parcels.push(cell)
        }
      }
    }
    
    return parcels
  }

  // Compute a single Voronoi cell clipped to boundary
  private computeVoronoiCell(seed: Vec2, allSeeds: Vec2[], boundary: Vec2[]): Vec2[] {
    let cell = [...boundary]
    
    // Clip by perpendicular bisectors to all other seeds
    for (const otherSeed of allSeeds) {
      if (otherSeed === seed) continue
      
      // Get perpendicular bisector
      const midpoint = {
        x: (seed.x + otherSeed.x) / 2,
        y: (seed.y + otherSeed.y) / 2
      }
      
      const dx = otherSeed.x - seed.x
      const dy = otherSeed.y - seed.y
      const perpX = -dy
      const perpY = dx
      
      // Clip polygon by this half-plane
      cell = this.clipByHalfPlane(cell, midpoint, { x: perpX, y: perpY })
      
      if (cell.length < 3) break
    }
    
    return cell
  }

  // Clip polygon by half-plane defined by point and normal
  private clipByHalfPlane(polygon: Vec2[], point: Vec2, normal: Vec2): Vec2[] {
    if (polygon.length < 3) return []
    
    const clipped: Vec2[] = []
    const n = polygon.length
    
    for (let i = 0; i < n; i++) {
      const curr = polygon[i]
      const next = polygon[(i + 1) % n]
      
      const currSide = (curr.x - point.x) * normal.x + (curr.y - point.y) * normal.y
      const nextSide = (next.x - point.x) * normal.x + (next.y - point.y) * normal.y
      
      if (currSide >= 0) {
        clipped.push(curr)
        
        if (nextSide < 0) {
          // Edge crosses the plane
          const t = currSide / (currSide - nextSide)
          clipped.push({
            x: curr.x + t * (next.x - curr.x),
            y: curr.y + t * (next.y - curr.y)
          })
        }
      } else if (nextSide >= 0) {
        // Edge crosses the plane
        const t = currSide / (currSide - nextSide)
        clipped.push({
          x: curr.x + t * (next.x - curr.x),
          y: curr.y + t * (next.y - curr.y)
        })
      }
    }
    
    return clipped
  }

  // Simplified polygon clipping
  private clipToPolygon(subject: Vec2[], clip: Vec2[]): Vec2[] {
    let output = subject
    
    for (let i = 0; i < clip.length; i++) {
      if (output.length === 0) break
      
      const input = output
      output = []
      
      const edge1 = clip[i]
      const edge2 = clip[(i + 1) % clip.length]
      
      for (let j = 0; j < input.length; j++) {
        const curr = input[j]
        const prev = input[(j - 1 + input.length) % input.length]
        
        const currInside = this.isLeftOfLine(curr, edge1, edge2)
        const prevInside = this.isLeftOfLine(prev, edge1, edge2)
        
        if (currInside) {
          if (!prevInside) {
            const intersection = GeometryUtils.lineIntersection(prev, curr, edge1, edge2)
            if (intersection) output.push(intersection)
          }
          output.push(curr)
        } else if (prevInside) {
          const intersection = GeometryUtils.lineIntersection(prev, curr, edge1, edge2)
          if (intersection) output.push(intersection)
        }
      }
    }
    
    return output
  }

  private isLeftOfLine(point: Vec2, lineStart: Vec2, lineEnd: Vec2): boolean {
    return ((lineEnd.x - lineStart.x) * (point.y - lineStart.y) -
            (lineEnd.y - lineStart.y) * (point.x - lineStart.x)) >= 0
  }

  private getPolygonBounds(vertices: Vec2[]) {
    let minX = Infinity, minY = Infinity
    let maxX = -Infinity, maxY = -Infinity
    
    for (const v of vertices) {
      minX = Math.min(minX, v.x)
      minY = Math.min(minY, v.y)
      maxX = Math.max(maxX, v.x)
      maxY = Math.max(maxY, v.y)
    }
    
    return { minX, minY, maxX, maxY }
  }
  
  // Estimate the depth of a block perpendicular to the frontage edge
  private estimateBlockDepth(block: Vec2[], frontageEdgeIndex: number): number {
    const frontStart = block[frontageEdgeIndex]
    const frontEnd = block[(frontageEdgeIndex + 1) % block.length]
    const frontMid = {
      x: (frontStart.x + frontEnd.x) / 2,
      y: (frontStart.y + frontEnd.y) / 2
    }
    
    // Find the farthest point from the frontage edge
    let maxDist = 0
    for (const vertex of block) {
      const dist = GeometryUtils.pointToSegmentDistance(vertex, frontStart, frontEnd)
      maxDist = Math.max(maxDist, dist)
    }
    
    return maxDist
  }
}

// City block detection and management
class CityBlockManager {
  private blocks: Map<number, CityBlock>
  private parcels: Map<number, Parcel>
  private nextBlockId: number = 0
  private nextParcelId: number = 0
  private subdivider: ParcelSubdivider
  
  constructor(rng: () => number) {
    this.blocks = new Map()
    this.parcels = new Map()
    this.subdivider = new ParcelSubdivider(rng)
  }

  // Find city blocks from road network using cycle detection
  findCityBlocks(network: RoadNetwork): void {
    this.blocks.clear()
    
    // Get all edges and nodes
    const edges = network['edges']
    const nodes = network['nodes']
    
    // Build adjacency for cycle detection
    const adjacency = new Map<number, Set<number>>()
    for (const [edgeId, edge] of edges) {
      if (!adjacency.has(edge.nodeA)) adjacency.set(edge.nodeA, new Set())
      if (!adjacency.has(edge.nodeB)) adjacency.set(edge.nodeB, new Set())
      adjacency.get(edge.nodeA)!.add(edge.nodeB)
      adjacency.get(edge.nodeB)!.add(edge.nodeA)
    }
    
    // Find minimal cycles (simplified - in production use proper planar face detection)
    const visited = new Set<number>()
    const cycles: number[][] = []
    
    for (const [nodeId, neighbors] of adjacency) {
      if (visited.has(nodeId)) continue
      
      // DFS to find cycles
      const stack: number[] = [nodeId]
      const path: number[] = []
      const pathSet = new Set<number>()
      
      while (stack.length > 0) {
        const current = stack[stack.length - 1]
        
        if (pathSet.has(current)) {
          // Found a cycle
          const cycleStart = path.indexOf(current)
          if (cycleStart !== -1) {
            const cycle = path.slice(cycleStart)
            if (cycle.length >= 3 && cycle.length <= 12) {
              // Reasonable sized cycle for a city block
              cycles.push([...cycle])
            }
          }
          stack.pop()
          if (path[path.length - 1] === current) {
            path.pop()
            pathSet.delete(current)
          }
        } else {
          visited.add(current)
          path.push(current)
          pathSet.add(current)
          
          const neighbors = adjacency.get(current) || new Set()
          let hasUnvisited = false
          
          for (const neighbor of neighbors) {
            if (!visited.has(neighbor) || pathSet.has(neighbor)) {
              stack.push(neighbor)
              hasUnvisited = true
              break
            }
          }
          
          if (!hasUnvisited) {
            stack.pop()
            path.pop()
            pathSet.delete(current)
          }
        }
        
        // Limit cycles found for performance
        if (cycles.length > 500) break
      }
    }
    
    // Convert cycles to blocks
    for (const cycle of cycles) {
      const vertices: Vec2[] = []
      const roadEdges: number[] = []
      
      for (let i = 0; i < cycle.length; i++) {
        const nodeId = cycle[i]
        const node = nodes.get(nodeId)
        if (node) {
          vertices.push({ ...node.pos })
        }
        
        // Find edge between this and next node
        const nextNodeId = cycle[(i + 1) % cycle.length]
        for (const [edgeId, edge] of edges) {
          if ((edge.nodeA === nodeId && edge.nodeB === nextNodeId) ||
              (edge.nodeB === nodeId && edge.nodeA === nextNodeId)) {
            roadEdges.push(edgeId)
            break
          }
        }
      }
      
      if (vertices.length >= 3) {
        const area = GeometryUtils.polygonArea(vertices)
        
        // Filter out very small or very large blocks
        if (area > 100 && area < 50000) {
          const block: CityBlock = {
            id: this.nextBlockId++,
            vertices,
            holes: [],
            parcels: [],
            area,
            perimeter: GeometryUtils.polygonPerimeter(vertices),
            roadEdges
          }
          
          this.blocks.set(block.id, block)
        }
      }
    }
  }

  // Paint zone on blocks or create standalone parcels
  paintZone(request: ZonePaintRequest, network: RoadNetwork): number[] {
    const affectedParcels: number[] = []
    
    // First, check if the paint area intersects with any existing blocks
    let foundIntersectingBlock = false
    
    for (const [blockId, block] of this.blocks) {
      if (this.polygonsIntersect(block.vertices, request.polygon)) {
        foundIntersectingBlock = true
        // Clear existing parcels in this block
        for (const parcelId of block.parcels) {
          this.parcels.delete(parcelId)
        }
        block.parcels = []
        
        // Determine subdivision method
        const method = request.subdivisionMethod || 'skeleton'
        
        // Find best frontage edge (closest to a road)
        let bestFrontageIndex = 0
        let minDistance = Infinity
        
        for (let i = 0; i < block.vertices.length; i++) {
          const edgeStart = block.vertices[i]
          const edgeEnd = block.vertices[(i + 1) % block.vertices.length]
          const midpoint = {
            x: (edgeStart.x + edgeEnd.x) / 2,
            y: (edgeStart.y + edgeEnd.y) / 2
          }
          
          // Check distance to road edges
          const edges = network['edges']
          const nodes = network['nodes']
          
          for (const roadEdgeId of block.roadEdges) {
            const edge = edges.get(roadEdgeId)
            if (edge) {
              const nodeA = nodes.get(edge.nodeA)
              const nodeB = nodes.get(edge.nodeB)
              if (nodeA && nodeB) {
                const dist = GeometryUtils.pointToSegmentDistance(
                  midpoint,
                  nodeA.pos,
                  nodeB.pos
                )
                if (dist < minDistance) {
                  minDistance = dist
                  bestFrontageIndex = i
                }
              }
            }
          }
        }
        
        // Subdivide the block
        let parcelPolygons: Vec2[][]
        if (method === 'voronoi') {
          parcelPolygons = this.subdivider.subdivideWithVoronoi(
            block.vertices,
            request.zoneType,
            request.zoneDensity
          )
        } else {
          parcelPolygons = this.subdivider.subdivideWithSkeleton(
            block.vertices,
            request.zoneType,
            request.zoneDensity,
            bestFrontageIndex
          )
        }
        
        // Create parcel objects
        for (const vertices of parcelPolygons) {
          if (vertices.length < 3) continue
          
          const area = GeometryUtils.polygonArea(vertices)
          if (area < 50) continue // Skip tiny parcels
          
          // Calculate frontage and detect corner lots
          let frontage = 0
          let frontageEdge = -1
          let isCorner = false
          const frontageEdges = new Set<number>()
          
          // Check each parcel edge against block edges
          for (let i = 0; i < vertices.length; i++) {
            const edgeStart = vertices[i]
            const edgeEnd = vertices[(i + 1) % vertices.length]
            const edgeLength = Math.sqrt(
              (edgeEnd.x - edgeStart.x) ** 2 + (edgeEnd.y - edgeStart.y) ** 2
            )
            
            // Check if this edge is on a block boundary (potential frontage)
            for (let j = 0; j < block.vertices.length; j++) {
              const blockEdgeStart = block.vertices[j]
              const blockEdgeEnd = block.vertices[(j + 1) % block.vertices.length]
              
              if (this.edgesOverlap(edgeStart, edgeEnd, blockEdgeStart, blockEdgeEnd)) {
                // This parcel edge aligns with a block edge
                frontage += edgeLength
                
                // Track which block edges this parcel fronts on
                if (block.roadEdges.length > 0) {
                  // If we have road information, use it
                  const roadEdgeId = block.roadEdges[j]
                  if (roadEdgeId !== undefined && roadEdgeId >= 0) {
                    frontageEdges.add(roadEdgeId)
                    if (frontageEdge === -1) {
                      frontageEdge = roadEdgeId
                    }
                  }
                } else {
                  // No road information - treat longest edges as frontage
                  if (edgeLength > 10) {  // Minimum frontage length
                    if (frontageEdge === -1) {
                      frontageEdge = j
                    }
                    frontageEdges.add(j)
                  }
                }
              }
            }
          }
          
          // Corner lot if fronting on multiple edges
          isCorner = frontageEdges.size > 1
          
          // If no frontage calculated but parcel exists, estimate it
          if (frontage === 0 && vertices.length >= 3) {
            // Find the longest edge as presumed frontage
            let maxEdgeLength = 0
            for (let i = 0; i < vertices.length; i++) {
              const edgeStart = vertices[i]
              const edgeEnd = vertices[(i + 1) % vertices.length]
              const length = Math.sqrt(
                (edgeEnd.x - edgeStart.x) ** 2 + (edgeEnd.y - edgeStart.y) ** 2
              )
              maxEdgeLength = Math.max(maxEdgeLength, length)
            }
            frontage = maxEdgeLength
          }
          
          const parcel: Parcel = {
            id: this.nextParcelId++,
            vertices,
            zoneType: request.zoneType,
            zoneDensity: request.zoneDensity,
            area,
            frontage,
            frontageEdge,
            isCorner,
            centroid: GeometryUtils.polygonCentroid(vertices),
            blockId
          }
          
          this.parcels.set(parcel.id, parcel)
          block.parcels.push(parcel.id)
          affectedParcels.push(parcel.id)
        }
      }
    }
    
    // If no blocks were found, create a standalone zone directly from the paint area
    if (!foundIntersectingBlock && request.polygon.length >= 3) {
      console.log('[ProcGen] No blocks found, creating standalone zone')
      
      // Create a virtual block for this zone
      const virtualBlock: CityBlock = {
        id: this.nextBlockId++,
        vertices: request.polygon,
        holes: [],
        parcels: [],
        area: GeometryUtils.polygonArea(request.polygon),
        perimeter: GeometryUtils.polygonPerimeter(request.polygon),
        roadEdges: []
      }
      
      // Store the virtual block
      this.blocks.set(virtualBlock.id, virtualBlock)
      
      // Subdivide it directly
      const parcelPolygons = this.subdivider.subdivideWithSkeleton(
        request.polygon,
        request.zoneType,
        request.zoneDensity,
        0  // frontage index
      )
      
      // Create parcels
      for (const vertices of parcelPolygons) {
        if (vertices.length < 3) continue
        
        const area = GeometryUtils.polygonArea(vertices)
        if (area < 50) continue // Skip tiny parcels
        
        // Calculate estimated frontage for standalone zones
        let estimatedFrontage = 0
        if (vertices.length >= 3) {
          // Use the longest edge as frontage
          for (let i = 0; i < vertices.length; i++) {
            const edgeStart = vertices[i]
            const edgeEnd = vertices[(i + 1) % vertices.length]
            const length = Math.sqrt(
              (edgeEnd.x - edgeStart.x) ** 2 + (edgeEnd.y - edgeStart.y) ** 2
            )
            estimatedFrontage = Math.max(estimatedFrontage, length)
          }
        }
        
        const parcel: Parcel = {
          id: this.nextParcelId++,
          vertices,
          zoneType: request.zoneType,
          zoneDensity: request.zoneDensity,
          area,
          frontage: estimatedFrontage,  // Use estimated frontage
          frontageEdge: -1,
          isCorner: false,
          centroid: GeometryUtils.polygonCentroid(vertices),
          blockId: virtualBlock.id
        }
        
        this.parcels.set(parcel.id, parcel)
        virtualBlock.parcels.push(parcel.id)
        affectedParcels.push(parcel.id)
      }
      
      console.log('[ProcGen] Created', virtualBlock.parcels.length, 'parcels in standalone zone')
    }
    
    return affectedParcels
  }

  // Check if two polygons intersect (simplified)
  private polygonsIntersect(poly1: Vec2[], poly2: Vec2[]): boolean {
    // Check if any vertex of poly1 is inside poly2
    for (const vertex of poly1) {
      if (GeometryUtils.pointInPolygon(vertex, poly2)) return true
    }
    
    // Check if any vertex of poly2 is inside poly1
    for (const vertex of poly2) {
      if (GeometryUtils.pointInPolygon(vertex, poly1)) return true
    }
    
    // Check edge intersections
    for (let i = 0; i < poly1.length; i++) {
      const p1 = poly1[i]
      const p2 = poly1[(i + 1) % poly1.length]
      
      for (let j = 0; j < poly2.length; j++) {
        const p3 = poly2[j]
        const p4 = poly2[(j + 1) % poly2.length]
        
        if (GeometryUtils.lineIntersection(p1, p2, p3, p4)) {
          return true
        }
      }
    }
    
    return false
  }

  // Check if two edges overlap
  private edgesOverlap(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): boolean {
    const threshold = 2.0 // 2 meters tolerance
    
    // Check if edges are roughly parallel and close
    const da = { x: a2.x - a1.x, y: a2.y - a1.y }
    const db = { x: b2.x - b1.x, y: b2.y - b1.y }
    
    const lenA = Math.sqrt(da.x * da.x + da.y * da.y)
    const lenB = Math.sqrt(db.x * db.x + db.y * db.y)
    
    if (lenA < 0.001 || lenB < 0.001) return false
    
    da.x /= lenA
    da.y /= lenA
    db.x /= lenB
    db.y /= lenB
    
    const dot = Math.abs(da.x * db.x + da.y * db.y)
    if (dot < 0.95) return false // Not parallel enough
    
    // Check if endpoints are close
    const dist1 = GeometryUtils.pointToSegmentDistance(a1, b1, b2)
    const dist2 = GeometryUtils.pointToSegmentDistance(a2, b1, b2)
    
    return dist1 < threshold && dist2 < threshold
  }
  
  private calculatePerimeter(vertices: Vec2[]): number {
    let perimeter = 0
    for (let i = 0; i < vertices.length; i++) {
      const start = vertices[i]
      const end = vertices[(i + 1) % vertices.length]
      perimeter += Math.sqrt(
        (end.x - start.x) ** 2 + (end.y - start.y) ** 2
      )
    }
    return perimeter
  }

  // Get parcels as typed arrays for efficient transfer
  getParcelsTypedArrays(): {
    parcelData: Float32Array  // [id, zoneType, density, area, frontage, isCorner, centroid.x, centroid.y, blockId]
    parcelVertices: Float32Array  // Flattened vertices with separator values
    blockData: Float32Array  // [id, area, perimeter, parcelCount]
  } {
    const parcelCount = this.parcels.size
    const blockCount = this.blocks.size
    
    // Calculate total vertices
    let totalVertices = 0
    for (const parcel of this.parcels.values()) {
      totalVertices += parcel.vertices.length + 1 // +1 for separator
    }
    
    const parcelData = new Float32Array(parcelCount * 9)
    const parcelVertices = new Float32Array(totalVertices * 2)
    const blockData = new Float32Array(blockCount * 4)
    
    let parcelIndex = 0
    let vertexIndex = 0
    
    for (const parcel of this.parcels.values()) {
      // Parcel data
      parcelData[parcelIndex * 9] = parcel.id
      parcelData[parcelIndex * 9 + 1] = this.zoneTypeToInt(parcel.zoneType)
      parcelData[parcelIndex * 9 + 2] = this.zoneDensityToInt(parcel.zoneDensity)
      parcelData[parcelIndex * 9 + 3] = parcel.area
      parcelData[parcelIndex * 9 + 4] = parcel.frontage
      parcelData[parcelIndex * 9 + 5] = parcel.isCorner ? 1 : 0
      parcelData[parcelIndex * 9 + 6] = parcel.centroid.x
      parcelData[parcelIndex * 9 + 7] = parcel.centroid.y
      parcelData[parcelIndex * 9 + 8] = parcel.blockId
      
      // Vertices
      for (const vertex of parcel.vertices) {
        parcelVertices[vertexIndex * 2] = vertex.x
        parcelVertices[vertexIndex * 2 + 1] = vertex.y
        vertexIndex++
      }
      
      // Separator
      parcelVertices[vertexIndex * 2] = -999999
      parcelVertices[vertexIndex * 2 + 1] = -999999
      vertexIndex++
      
      parcelIndex++
    }
    
    let blockIndex = 0
    for (const block of this.blocks.values()) {
      blockData[blockIndex * 4] = block.id
      blockData[blockIndex * 4 + 1] = block.area
      blockData[blockIndex * 4 + 2] = block.perimeter
      blockData[blockIndex * 4 + 3] = block.parcels.length
      blockIndex++
    }
    
    return { parcelData, parcelVertices, blockData }
  }

  private zoneTypeToInt(zoneType: ZoneType): number {
    const map: Record<ZoneType, number> = {
      residential: 0,
      commercial: 1,
      industrial: 2,
      none: 3
    }
    return map[zoneType]
  }

  private zoneDensityToInt(density: ZoneDensity): number {
    const map: Record<ZoneDensity, number> = {
      low: 0,
      medium: 1,
      high: 2
    }
    return map[density]
  }

  clear() {
    this.blocks.clear()
    this.parcels.clear()
    this.nextBlockId = 0
    this.nextParcelId = 0
  }

  getBlocks(): CityBlock[] {
    return Array.from(this.blocks.values())
  }

  getParcels(): Parcel[] {
    return Array.from(this.parcels.values())
  }

  // Find parcel containing a world position
  findParcelAt(point: Vec2): Parcel | null {
    for (const parcel of this.parcels.values()) {
      if (GeometryUtils.pointInPolygon(point, parcel.vertices)) {
        return parcel
      }
    }
    return null
  }
}

// Building types and interfaces
type BuildingStyle = 'victorian' | 'art-deco' | 'modern' | 'brutalist' | 'postmodern' | 'contemporary' | 'futuristic'
type RoofType = 'flat' | 'gable' | 'hip' | 'mansard' | 'pyramid' | 'barrel' | 'sawtooth' | 'green'
type BuildingLOD = 0 | 1 | 2 // 0 = highest detail, 2 = lowest

// Material IDs for different building components
enum BuildingMaterial {
  BRICK = 0,
  CONCRETE = 1,
  STONE = 2,
  METAL_PANEL = 3,
  ROOF_TILE = 4,
  ROOF_METAL = 5,
  ROOF_GREEN = 6,
  WOOD_SIDING = 7,
  GLASS_CURTAIN = 8,
  INDUSTRIAL_METAL = 9,
  STUCCO = 10
}

interface BuildingMassing {
  id: number
  parcelId: number
  footprint: Vec2[] // Building outline on ground
  height: number // Total height in meters
  baseHeight: number // Height of base component
  bodyHeight: number // Height of main body
  roofHeight: number // Height of roof component
  style: BuildingStyle
  roofType: RoofType
  floorCount: number
  setback: number // Distance from property line
  seed: number // For deterministic generation
  zoneType?: ZoneType // Zone type for specialized generation
  zoneDensity?: ZoneDensity // Density level for variations
  level?: number // Building level (1-5) for progression
}

interface BuildingMesh {
  positions: Float32Array // Vertex positions [x,y,z, x,y,z, ...]
  normals: Float32Array // Vertex normals
  uvs: Float32Array // Texture coordinates
  indices: Uint32Array // Triangle indices
  materialIds: Uint8Array // Material ID per face
  lod: BuildingLOD
}

interface BuildingComponent {
  type: 'base' | 'body' | 'roof' | 'detail'
  vertices: { x: number; y: number; z: number }[]
  faces: number[][] // Indices into vertices
  materialId: number
}

// Building generation configuration
const FLOOR_HEIGHT = 3.0 // Standard floor height in meters
const SETBACK_BY_DENSITY: Record<ZoneDensity, { min: number; max: number }> = {
  low: { min: 4, max: 6 },
  medium: { min: 2, max: 4 },
  high: { min: 1, max: 2 }
}

const HEIGHT_BY_DENSITY: Record<ZoneDensity, { min: number; max: number }> = {
  low: { min: 3, max: 6 },    // 1-2 floors
  medium: { min: 9, max: 15 }, // 3-5 floors
  high: { min: 18, max: 60 }   // 6-20 floors
}

const STYLE_BY_ERA: Record<string, BuildingStyle[]> = {
  '1890s': ['victorian'],
  '1910s': ['victorian', 'art-deco'],
  '1930s': ['art-deco'],
  '1950s': ['modern', 'brutalist'],
  '1970s': ['brutalist', 'modern'],
  '1990s': ['postmodern', 'contemporary'],
  '2010s': ['contemporary', 'modern'],
  '2030s': ['futuristic', 'contemporary']
}

const ROOF_BY_ERA: Record<string, RoofType[]> = {
  '1890s': ['gable', 'hip', 'mansard'],
  '1910s': ['gable', 'hip', 'mansard', 'pyramid'],
  '1930s': ['flat', 'pyramid', 'barrel'],
  '1950s': ['flat', 'sawtooth'],
  '1970s': ['flat'],
  '1990s': ['flat', 'pyramid', 'hip'],
  '2010s': ['flat', 'green'],
  '2030s': ['flat', 'green', 'pyramid']
}

// Split grammar rules for building generation
class SplitGrammar {
  private rng: () => number
  
  constructor(rng: () => number) {
    this.rng = rng
  }
  
  // Apply vertical split to create base, body, and roof
  splitVertical(height: number, style: BuildingStyle): { base: number; body: number; roof: number } {
    let baseRatio: number
    let roofRatio: number
    
    switch (style) {
      case 'victorian':
        baseRatio = 0.15
        roofRatio = 0.2
        break
      case 'art-deco':
        baseRatio = 0.2
        roofRatio = 0.15
        break
      case 'modern':
      case 'contemporary':
        baseRatio = 0.1
        roofRatio = 0.05
        break
      case 'brutalist':
        baseRatio = 0.08
        roofRatio = 0.03
        break
      case 'postmodern':
        baseRatio = 0.12
        roofRatio = 0.1
        break
      case 'futuristic':
        baseRatio = 0.05
        roofRatio = 0.08
        break
      default:
        baseRatio = 0.1
        roofRatio = 0.1
    }
    
    // Add some variation
    baseRatio += (this.rng() - 0.5) * 0.05
    roofRatio += (this.rng() - 0.5) * 0.05
    
    const base = height * Math.max(0.05, Math.min(0.25, baseRatio))
    const roof = height * Math.max(0.03, Math.min(0.25, roofRatio))
    const body = height - base - roof
    
    return { base, body, roof }
  }
  
  // Split body horizontally for floor plates
  splitFloors(bodyHeight: number): number[] {
    const floorCount = Math.max(1, Math.round(bodyHeight / FLOOR_HEIGHT))
    const actualFloorHeight = bodyHeight / floorCount
    const floors: number[] = []
    
    for (let i = 0; i < floorCount; i++) {
      floors.push(actualFloorHeight)
    }
    
    return floors
  }
  
  // Apply facade subdivision for windows and details
  subdivideFacade(width: number, height: number, style: BuildingStyle): { windows: Vec2[]; details: Vec2[] } {
    const windows: Vec2[] = []
    const details: Vec2[] = []
    
    let windowWidth: number
    let windowHeight: number
    let windowSpacing: number
    
    switch (style) {
      case 'victorian':
        windowWidth = 1.2
        windowHeight = 2.0
        windowSpacing = 2.0
        break
      case 'art-deco':
        windowWidth = 1.5
        windowHeight = 2.5
        windowSpacing = 2.5
        break
      case 'modern':
      case 'contemporary':
        windowWidth = 2.0
        windowHeight = 2.8
        windowSpacing = 3.0
        break
      case 'brutalist':
        windowWidth = 3.0
        windowHeight = 2.5
        windowSpacing = 4.0
        break
      case 'postmodern':
        windowWidth = 1.8
        windowHeight = 2.4
        windowSpacing = 2.8
        break
      case 'futuristic':
        windowWidth = 4.0
        windowHeight = 3.0
        windowSpacing = 5.0
        break
      default:
        windowWidth = 1.5
        windowHeight = 2.0
        windowSpacing = 2.5
    }
    
    // Calculate window grid
    const cols = Math.max(1, Math.floor(width / windowSpacing))
    const rows = Math.max(1, Math.floor(height / (windowHeight + 1.0)))
    
    const actualSpacingX = width / cols
    const actualSpacingY = height / rows
    
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        windows.push({
          x: (col + 0.5) * actualSpacingX,
          y: (row + 0.5) * actualSpacingY
        })
      }
    }
    
    return { windows, details }
  }
}

// Building mesh generator
class BuildingMeshGenerator {
  private splitGrammar: SplitGrammar
  private rng: () => number
  
  constructor(rng: () => number) {
    this.rng = rng
    this.splitGrammar = new SplitGrammar(rng)
  }
  
  // Helper to add window details to a facade
  private addWindowsToFacade(vertices: { x: number; y: number; z: number }[], 
                            faces: number[][], 
                            facadeStart: Vec2, 
                            facadeEnd: Vec2, 
                            bottomZ: number, 
                            topZ: number,
                            style: BuildingStyle,
                            lod: BuildingLOD): void {
    if (lod === 2) return // Skip windows for lowest LOD
    
    const facadeWidth = Math.sqrt((facadeEnd.x - facadeStart.x) ** 2 + (facadeEnd.y - facadeStart.y) ** 2)
    const facadeHeight = topZ - bottomZ
    
    // Determine window pattern based on style
    let windowWidth = 1.5
    let windowHeight = 2.0
    let windowSpacingH = 3.0
    let windowSpacingV = 3.5
    
    switch (style) {
      case 'modern':
      case 'contemporary':
        windowWidth = 2.5
        windowHeight = 2.8
        windowSpacingH = 3.0
        break
      case 'brutalist':
        windowWidth = 3.0
        windowHeight = 2.0
        windowSpacingH = 4.0
        break
      case 'art-deco':
        windowWidth = 1.8
        windowHeight = 3.0
        windowSpacingV = 4.0
        break
    }
    
    // Calculate window grid
    const windowsH = Math.floor(facadeWidth / windowSpacingH)
    const windowsV = Math.floor(facadeHeight / windowSpacingV)
    
    if (windowsH <= 0 || windowsV <= 0) return
    
    // Add simplified window indentations
    const windowDepth = 0.15
    const startIdx = vertices.length
    
    for (let row = 0; row < windowsV; row++) {
      for (let col = 0; col < windowsH; col++) {
        const t = (col + 0.5) / windowsH
        const z = bottomZ + (row + 0.5) * windowSpacingV
        
        // Window position along facade
        const windowX = facadeStart.x + (facadeEnd.x - facadeStart.x) * t
        const windowY = facadeStart.y + (facadeEnd.y - facadeStart.y) * t
        
        // Add recessed window vertices (simplified)
        vertices.push({ x: windowX - windowDepth, y: windowY - windowDepth, z })
      }
    }
  }
  
  // Helper to add balconies
  private addBalcony(vertices: { x: number; y: number; z: number }[], 
                     faces: number[][], 
                     position: Vec2, 
                     z: number, 
                     width: number = 3.0,
                     depth: number = 1.5): number {
    const startIdx = vertices.length
    
    // Balcony floor vertices
    vertices.push({ x: position.x - width/2, y: position.y, z })
    vertices.push({ x: position.x + width/2, y: position.y, z })
    vertices.push({ x: position.x + width/2, y: position.y + depth, z })
    vertices.push({ x: position.x - width/2, y: position.y + depth, z })
    
    // Balcony railing (simplified)
    const railHeight = 1.1
    vertices.push({ x: position.x - width/2, y: position.y + depth, z: z + railHeight })
    vertices.push({ x: position.x + width/2, y: position.y + depth, z: z + railHeight })
    
    // Balcony floor face
    faces.push([startIdx, startIdx + 1, startIdx + 2, startIdx + 3])
    
    // Front railing face
    faces.push([startIdx + 2, startIdx + 3, startIdx + 4, startIdx + 5])
    
    return startIdx + 6
  }
  
  // Generate mesh for a building massing
  generateMesh(massing: BuildingMassing, lod: BuildingLOD): BuildingMesh {
    // SIMPLIFIED: Just create a box for now to ensure buildings render
    const positions: number[] = []
    const normals: number[] = []
    const uvs: number[] = []
    const indices: number[] = []
    
    // Get building footprint bounds
    let minX = Infinity, maxX = -Infinity
    let minY = Infinity, maxY = -Infinity
    
    for (const v of massing.footprint) {
      minX = Math.min(minX, v.x)
      maxX = Math.max(maxX, v.x)
      minY = Math.min(minY, v.y)
      maxY = Math.max(maxY, v.y)
    }
    
    console.log('[BuildingMeshGen] Building bounds:', { minX, maxX, minY, maxY }, 'height:', massing.height)
    
    // Create a simple box
    const height = massing.height || 20
    
    // Bottom face (4 vertices)
    positions.push(
      minX, minY, 0,
      maxX, minY, 0,
      maxX, maxY, 0,
      minX, maxY, 0
    )
    
    // Top face (4 vertices)
    positions.push(
      minX, minY, height,
      maxX, minY, height,
      maxX, maxY, height,
      minX, maxY, height
    )
    
    // Add normals (pointing up for all vertices for now)
    for (let i = 0; i < 8; i++) {
      normals.push(0, 0, 1)
    }
    
    // Add simple UVs
    for (let i = 0; i < 8; i++) {
      uvs.push(0, 0)
    }
    
    // Create faces (12 triangles for a box)
    // Bottom
    indices.push(0, 2, 1, 0, 3, 2)
    // Top
    indices.push(4, 5, 6, 4, 6, 7)
    // Front
    indices.push(0, 1, 5, 0, 5, 4)
    // Back
    indices.push(2, 3, 7, 2, 7, 6)
    // Left
    indices.push(0, 4, 7, 0, 7, 3)
    // Right
    indices.push(1, 2, 6, 1, 6, 5)
    
    console.log('[BuildingMeshGen] Created simple box mesh:', positions.length / 3, 'vertices,', indices.length / 3, 'triangles')
    
    return {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      uvs: new Float32Array(uvs),
      indices: new Uint32Array(indices),
      materialIds: new Uint8Array(indices.length / 3),
      lod
    }
  }
  
  private generateBase(massing: BuildingMassing, lod: BuildingLOD): BuildingComponent {
    const vertices: { x: number; y: number; z: number }[] = []
    const faces: number[][] = []
    
    const bottomZ = 0
    const topZ = massing.baseHeight
    const zoneType = massing.zoneType || 'residential'
    const density = massing.zoneDensity || 'medium'
    
    // Zone-specific base features
    let footprint = massing.footprint
    let hasRecession = false
    let hasColumns = false
    let hasPodium = false
    
    // Commercial bases often have recessed entrances
    if (zoneType === 'commercial') {
      hasRecession = density !== 'low' && this.rng() > 0.4
      hasColumns = massing.style === 'art-deco' || massing.style === 'postmodern'
      hasPodium = density === 'high' && massing.floorCount > 10
    }
    
    // Industrial bases are typically simple
    if (zoneType === 'industrial') {
      // Keep simple base for industrial
    }
    
    // Residential bases vary by density
    if (zoneType === 'residential') {
      hasRecession = density === 'high' && this.rng() > 0.5
      hasPodium = density === 'high' && massing.floorCount > 15
    }
    
    // Generate base with recession if needed
    if (hasRecession && footprint.length >= 4) {
      // Create recessed entrance on one side
      const recessionDepth = 2.0
      const recessionWidth = Math.min(8.0, this.getFootprintBounds(footprint).maxX - this.getFootprintBounds(footprint).minX * 0.4)
      
      // Add vertices for recessed area (simplified)
      for (const point of footprint) {
        vertices.push({ x: point.x, y: point.y, z: bottomZ })
      }
      
      // Create inset for entrance
      const insetFootprint = [...footprint]
      if (footprint.length >= 4) {
        // Modify first edge for entrance
        const p0 = footprint[0]
        const p1 = footprint[1]
        const edgeLength = Math.sqrt((p1.x - p0.x) ** 2 + (p1.y - p0.y) ** 2)
        
        if (edgeLength > recessionWidth) {
          // Add recession vertices
          const t1 = recessionWidth / edgeLength * 0.3
          const t2 = recessionWidth / edgeLength * 0.7
          
          const recess1 = {
            x: p0.x + (p1.x - p0.x) * t1,
            y: p0.y + (p1.y - p0.y) * t1
          }
          const recess2 = {
            x: p0.x + (p1.x - p0.x) * t2,
            y: p0.y + (p1.y - p0.y) * t2
          }
          
          // Add recessed vertices
          vertices.push({ x: recess1.x, y: recess1.y - recessionDepth, z: bottomZ })
          vertices.push({ x: recess2.x, y: recess2.y - recessionDepth, z: bottomZ })
        }
      }
      
      // Top vertices
      for (const point of footprint) {
        vertices.push({ x: point.x, y: point.y, z: topZ })
      }
    } else {
      // Simple base
      for (const point of footprint) {
        vertices.push({ x: point.x, y: point.y, z: bottomZ })
      }
      for (const point of footprint) {
        vertices.push({ x: point.x, y: point.y, z: topZ })
      }
    }
    
    const n = footprint.length
    const vertexGroups = hasRecession ? 2 : 1
    
    // Create side faces
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n
      const topOffset = hasRecession ? n + 2 : n
      faces.push([i, next, next + topOffset, i + topOffset])
    }
    
    // Create top and bottom faces
    const topFace: number[] = []
    const bottomFace: number[] = []
    const topStart = hasRecession ? n + 2 : n
    
    for (let i = 0; i < n; i++) {
      topFace.push(i + topStart)
      bottomFace.unshift(i)
    }
    faces.push(topFace)
    faces.push(bottomFace)
    
    // Determine material based on zone and style
    let materialId = 0
    if (zoneType === 'commercial') {
      materialId = massing.style === 'modern' || massing.style === 'contemporary' ? 8 : 1
    } else if (zoneType === 'industrial') {
      materialId = 9
    } else {
      materialId = massing.style === 'modern' ? 1 : 0
    }
    
    return {
      type: 'base',
      vertices,
      faces,
      materialId
    }
  }
  
  private generateBody(massing: BuildingMassing, lod: BuildingLOD): BuildingComponent {
    const vertices: { x: number; y: number; z: number }[] = []
    const faces: number[][] = []
    
    const bottomZ = massing.baseHeight
    const topZ = massing.baseHeight + massing.bodyHeight
    
    // Get zone type from massing
    const zoneType = massing.zoneType || 'residential'
    const density = massing.zoneDensity || 'medium'
    
    // Apply zone-specific body generation
    switch (zoneType) {
      case 'residential':
        return this.generateResidentialBody(massing, bottomZ, topZ, lod)
      case 'commercial':
        return this.generateCommercialBody(massing, bottomZ, topZ, lod)
      case 'industrial':
        return this.generateIndustrialBody(massing, bottomZ, topZ, lod)
      default:
        return this.generateGenericBody(massing, bottomZ, topZ, lod)
    }
  }
  
  private generateResidentialBody(massing: BuildingMassing, bottomZ: number, topZ: number, lod: BuildingLOD): BuildingComponent {
    const vertices: { x: number; y: number; z: number }[] = []
    const faces: number[][] = []
    const details: { x: number; y: number; z: number }[] = []
    
    const density = massing.zoneDensity || 'medium'
    let currentFootprint = [...massing.footprint]
    const floors = this.splitGrammar.splitFloors(massing.bodyHeight)
    let currentZ = bottomZ
    
    // Determine building variation based on density and style
    const hasBalconies = density !== 'low' && massing.style !== 'victorian' && this.rng() > 0.3
    const hasSetbacks = massing.floorCount > 8 && this.rng() > 0.4
    const balconyDepth = 1.5
    const windowInset = 0.2
    
    if (lod === 2) {
      // Simple box for LOD2
      return this.generateGenericBody(massing, bottomZ, topZ, lod)
    }
    
    // Generate floor-by-floor with residential features
    for (let floorIdx = 0; floorIdx <= floors.length; floorIdx++) {
      // Add stepping/setbacks for tall residential
      if (hasSetbacks && floorIdx > 0) {
        if (floorIdx === Math.floor(floors.length * 0.7)) {
          currentFootprint = GeometryUtils.offsetPolygon(currentFootprint, -1.0)
        } else if (floorIdx === Math.floor(floors.length * 0.85)) {
          currentFootprint = GeometryUtils.offsetPolygon(currentFootprint, -0.5)
        }
      }
      
      // Add main footprint vertices
      for (const point of currentFootprint) {
        vertices.push({ x: point.x, y: point.y, z: currentZ })
      }
      
      // Add balconies every 2-3 floors for apartments
      if (hasBalconies && floorIdx > 0 && floorIdx % 2 === 0 && floorIdx < floors.length) {
        const balconyFootprint = GeometryUtils.offsetPolygon(currentFootprint, balconyDepth)
        for (const point of balconyFootprint) {
          details.push({ x: point.x, y: point.y, z: currentZ })
        }
      }
      
      if (floorIdx < floors.length) {
        currentZ += floors[floorIdx]
      }
    }
    
    // Create faces with window subdivisions
    const levelsCount = floors.length + 1
    const pointsPerLevel = massing.footprint.length
    
    for (let level = 0; level < levelsCount - 1; level++) {
      for (let i = 0; i < pointsPerLevel; i++) {
        const next = (i + 1) % pointsPerLevel
        const bottomLeft = level * pointsPerLevel + i
        const bottomRight = level * pointsPerLevel + next
        const topLeft = (level + 1) * pointsPerLevel + i
        const topRight = (level + 1) * pointsPerLevel + next
        
        faces.push([bottomLeft, bottomRight, topRight, topLeft])
      }
    }
    
    // Add details to vertices if present
    const detailStartIdx = vertices.length
    vertices.push(...details)
    
    return {
      type: 'body',
      vertices,
      faces,
      materialId: density === 'low' ? 7 : 2 // Different material for low-density residential
    }
  }
  
  private generateCommercialBody(massing: BuildingMassing, bottomZ: number, topZ: number, lod: BuildingLOD): BuildingComponent {
    const vertices: { x: number; y: number; z: number }[] = []
    const faces: number[][] = []
    
    const density = massing.zoneDensity || 'medium'
    let currentFootprint = [...massing.footprint]
    const floors = this.splitGrammar.splitFloors(massing.bodyHeight)
    
    // Commercial buildings have taller ground floors
    const groundFloorHeight = floors[0] * 1.5
    const upperFloorHeight = (massing.bodyHeight - groundFloorHeight) / (floors.length - 1)
    
    let currentZ = bottomZ
    const hasGlassFacade = massing.style === 'modern' || massing.style === 'contemporary' || massing.style === 'futuristic'
    const hasSignage = density !== 'low' && this.rng() > 0.4
    const hasCornerEntrances = density === 'high' && this.rng() > 0.5
    
    if (lod === 2) {
      return this.generateGenericBody(massing, bottomZ, topZ, lod)
    }
    
    // Generate commercial-specific features
    for (let floorIdx = 0; floorIdx <= floors.length; floorIdx++) {
      // Slight setback after ground floor for some styles
      if (floorIdx === 1 && massing.style === 'art-deco') {
        currentFootprint = GeometryUtils.offsetPolygon(currentFootprint, -0.3)
      }
      
      // Progressive setbacks for skyscrapers
      if (density === 'high' && massing.floorCount > 15) {
        if (floorIdx === Math.floor(floors.length * 0.6)) {
          currentFootprint = GeometryUtils.offsetPolygon(currentFootprint, -1.5)
        } else if (floorIdx === Math.floor(floors.length * 0.8)) {
          currentFootprint = GeometryUtils.offsetPolygon(currentFootprint, -1.0)
        }
      }
      
      for (const point of currentFootprint) {
        vertices.push({ x: point.x, y: point.y, z: currentZ })
      }
      
      if (floorIdx === 0) {
        currentZ += groundFloorHeight
      } else if (floorIdx < floors.length) {
        currentZ += upperFloorHeight
      }
    }
    
    // Create faces
    const levelsCount = floors.length + 1
    const pointsPerLevel = currentFootprint.length
    
    for (let level = 0; level < levelsCount - 1; level++) {
      for (let i = 0; i < pointsPerLevel; i++) {
        const next = (i + 1) % pointsPerLevel
        const bottomLeft = level * pointsPerLevel + i
        const bottomRight = level * pointsPerLevel + next
        const topLeft = (level + 1) * pointsPerLevel + i
        const topRight = (level + 1) * pointsPerLevel + next
        
        faces.push([bottomLeft, bottomRight, topRight, topLeft])
      }
    }
    
    return {
      type: 'body',
      vertices,
      faces,
      materialId: hasGlassFacade ? 8 : 2 // Glass material for modern commercial
    }
  }
  
  private generateIndustrialBody(massing: BuildingMassing, bottomZ: number, topZ: number, lod: BuildingLOD): BuildingComponent {
    const vertices: { x: number; y: number; z: number }[] = []
    const faces: number[][] = []
    
    const density = massing.zoneDensity || 'medium'
    const footprint = massing.footprint
    
    // Industrial buildings are typically simpler with functional features
    const hasLoadingDock = this.rng() > 0.3
    const hasClerestoryWindows = density !== 'low' && this.rng() > 0.4
    const hasExternalStructures = density === 'high' && this.rng() > 0.5 // Silos, tanks, etc.
    
    if (lod === 2) {
      return this.generateGenericBody(massing, bottomZ, topZ, lod)
    }
    
    // Main warehouse/factory volume
    const mainHeight = massing.bodyHeight * (hasClerestoryWindows ? 0.8 : 1.0)
    
    // Bottom vertices
    for (const point of footprint) {
      vertices.push({ x: point.x, y: point.y, z: bottomZ })
    }
    
    // Top vertices of main volume
    for (const point of footprint) {
      vertices.push({ x: point.x, y: point.y, z: bottomZ + mainHeight })
    }
    
    // Add clerestory if present
    if (hasClerestoryWindows) {
      const clerestoryFootprint = GeometryUtils.offsetPolygon(footprint, -2.0)
      const clerestoryZ = bottomZ + mainHeight
      const clerestoryTop = topZ
      
      for (const point of clerestoryFootprint) {
        vertices.push({ x: point.x, y: point.y, z: clerestoryZ })
      }
      for (const point of clerestoryFootprint) {
        vertices.push({ x: point.x, y: point.y, z: clerestoryTop })
      }
    }
    
    // Create main volume faces
    const n = footprint.length
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n
      faces.push([i, next, next + n, i + n])
    }
    
    // Add clerestory faces if present
    if (hasClerestoryWindows) {
      const clerestoryStart = n * 2
      for (let i = 0; i < n; i++) {
        const next = (i + 1) % n
        faces.push([
          clerestoryStart + i,
          clerestoryStart + next,
          clerestoryStart + next + n,
          clerestoryStart + i + n
        ])
      }
    }
    
    // Add loading dock as a simple extrusion
    if (hasLoadingDock && footprint.length >= 4) {
      const dockWidth = 4.0
      const dockHeight = 1.5
      const dockDepth = 3.0
      
      // Add dock on one side (simplified)
      const p1 = footprint[0]
      const p2 = footprint[1]
      const dockStart = vertices.length
      
      // Dock vertices (simplified box)
      vertices.push({ x: p1.x, y: p1.y - dockDepth, z: bottomZ })
      vertices.push({ x: p1.x + dockWidth, y: p1.y - dockDepth, z: bottomZ })
      vertices.push({ x: p1.x + dockWidth, y: p1.y, z: bottomZ })
      vertices.push({ x: p1.x, y: p1.y, z: bottomZ })
      
      vertices.push({ x: p1.x, y: p1.y - dockDepth, z: bottomZ + dockHeight })
      vertices.push({ x: p1.x + dockWidth, y: p1.y - dockDepth, z: bottomZ + dockHeight })
      vertices.push({ x: p1.x + dockWidth, y: p1.y, z: bottomZ + dockHeight })
      vertices.push({ x: p1.x, y: p1.y, z: bottomZ + dockHeight })
      
      // Dock faces
      faces.push([dockStart, dockStart + 1, dockStart + 5, dockStart + 4])
      faces.push([dockStart + 1, dockStart + 2, dockStart + 6, dockStart + 5])
      faces.push([dockStart + 2, dockStart + 3, dockStart + 7, dockStart + 6])
      faces.push([dockStart + 3, dockStart, dockStart + 4, dockStart + 7])
      faces.push([dockStart + 4, dockStart + 5, dockStart + 6, dockStart + 7])
    }
    
    return {
      type: 'body',
      vertices,
      faces,
      materialId: 9 // Industrial material (corrugated metal, concrete)
    }
  }
  
  private generateGenericBody(massing: BuildingMassing, bottomZ: number, topZ: number, lod: BuildingLOD): BuildingComponent {
    const vertices: { x: number; y: number; z: number }[] = []
    const faces: number[][] = []
    
    // Fallback to original simple implementation
    let currentFootprint = [...massing.footprint]
    const floors = this.splitGrammar.splitFloors(massing.bodyHeight)
    let currentZ = bottomZ
    
    if (lod === 2) {
      // Simple box for LOD2
      for (const point of currentFootprint) {
        vertices.push({ x: point.x, y: point.y, z: bottomZ })
      }
      for (const point of currentFootprint) {
        vertices.push({ x: point.x, y: point.y, z: topZ })
      }
      
      const n = currentFootprint.length
      for (let i = 0; i < n; i++) {
        const next = (i + 1) % n
        faces.push([i, next, next + n, i + n])
      }
    } else {
      // Detailed geometry with floor divisions for LOD0 and LOD1
      for (let floorIdx = 0; floorIdx <= floors.length; floorIdx++) {
        // Add stepping for tall buildings
        if (massing.floorCount > 10 && floorIdx > 0 && floorIdx % 5 === 0) {
          currentFootprint = GeometryUtils.offsetPolygon(currentFootprint, -0.5)
        }
        
        for (const point of currentFootprint) {
          vertices.push({ x: point.x, y: point.y, z: currentZ })
        }
        
        if (floorIdx < floors.length) {
          currentZ += floors[floorIdx]
        }
      }
      
      // Create faces between floor levels
      const levelsCount = floors.length + 1
      const pointsPerLevel = currentFootprint.length
      
      for (let level = 0; level < levelsCount - 1; level++) {
        for (let i = 0; i < pointsPerLevel; i++) {
          const next = (i + 1) % pointsPerLevel
          const bottomLeft = level * pointsPerLevel + i
          const bottomRight = level * pointsPerLevel + next
          const topLeft = (level + 1) * pointsPerLevel + i
          const topRight = (level + 1) * pointsPerLevel + next
          
          faces.push([bottomLeft, bottomRight, topRight, topLeft])
        }
      }
    }
    
    // Add top and bottom caps
    const n = currentFootprint.length
    const bottomCap: number[] = []
    const topCap: number[] = []
    
    for (let i = 0; i < n; i++) {
      bottomCap.push(i)
      topCap.push(vertices.length - n + i)
    }
    
    faces.push(bottomCap.reverse())
    faces.push(topCap)
    
    return {
      type: 'body',
      vertices,
      faces,
      materialId: 2
    }
  }
  
  private generateRoof(massing: BuildingMassing, lod: BuildingLOD): BuildingComponent {
    const vertices: { x: number; y: number; z: number }[] = []
    const faces: number[][] = []
    
    const bottomZ = massing.baseHeight + massing.bodyHeight
    const topZ = massing.height
    const zoneType = massing.zoneType || 'residential'
    const density = massing.zoneDensity || 'medium'
    
    // Zone-specific roof selection override
    let roofType = massing.roofType
    
    // Industrial buildings prefer functional roofs
    if (zoneType === 'industrial') {
      if (roofType !== 'sawtooth' && roofType !== 'flat' && this.rng() > 0.7) {
        roofType = 'sawtooth' // Force sawtooth for some industrial
      }
    }
    
    // High-density commercial prefers flat roofs with equipment
    if (zoneType === 'commercial' && density === 'high') {
      if (roofType !== 'flat' && this.rng() > 0.8) {
        roofType = 'flat'
      }
    }
    
    switch (roofType) {
      case 'flat':
        return this.generateEnhancedFlatRoof(massing, bottomZ, topZ, lod)
      case 'gable':
        return this.generateGableRoof(massing, bottomZ, topZ, lod)
      case 'hip':
        return this.generateHipRoof(massing, bottomZ, topZ, lod)
      case 'mansard':
        return this.generateMansardRoof(massing, bottomZ, topZ, lod)
      case 'pyramid':
        return this.generatePyramidRoof(massing, bottomZ, topZ, lod)
      case 'barrel':
        return this.generateBarrelRoof(massing, bottomZ, topZ, lod)
      case 'sawtooth':
        return this.generateSawtoothRoof(massing, bottomZ, topZ, lod)
      case 'green':
        return this.generateGreenRoof(massing, bottomZ, topZ, lod)
      default:
        return this.generateEnhancedFlatRoof(massing, bottomZ, topZ, lod)
    }
  }
  
  private generateEnhancedFlatRoof(massing: BuildingMassing, bottomZ: number, topZ: number, lod: BuildingLOD): BuildingComponent {
    const vertices: { x: number; y: number; z: number }[] = []
    const faces: number[][] = []
    
    const zoneType = massing.zoneType || 'residential'
    const density = massing.zoneDensity || 'medium'
    
    // Parapet with zone-specific features
    const outerFootprint = massing.footprint
    const parapetThickness = zoneType === 'industrial' ? 0.5 : 0.3
    const innerFootprint = GeometryUtils.offsetPolygon(outerFootprint, -parapetThickness)
    
    // Add mechanical equipment for commercial/industrial
    const hasMechanical = (zoneType === 'commercial' || zoneType === 'industrial') && 
                          density !== 'low' && this.rng() > 0.3
    const hasHelipad = zoneType === 'commercial' && density === 'high' && 
                       massing.floorCount > 20 && this.rng() > 0.7
    
    // Bottom outer ring
    for (const point of outerFootprint) {
      vertices.push({ x: point.x, y: point.y, z: bottomZ })
    }
    
    // Bottom inner ring
    for (const point of innerFootprint) {
      vertices.push({ x: point.x, y: point.y, z: bottomZ })
    }
    
    // Top outer ring (parapet top)
    const parapetHeight = topZ - bottomZ
    for (const point of outerFootprint) {
      vertices.push({ x: point.x, y: point.y, z: topZ })
    }
    
    // Top inner ring (roof surface, slightly lower for drainage)
    const roofSurfaceZ = topZ - 0.1
    for (const point of innerFootprint) {
      vertices.push({ x: point.x, y: point.y, z: roofSurfaceZ })
    }
    
    const n = outerFootprint.length
    
    // Create parapet faces
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n
      
      // Outer wall
      faces.push([i, next, next + 2 * n, i + 2 * n])
      
      // Inner wall
      faces.push([i + n, i + 3 * n, next + 3 * n, next + n])
      
      // Top of parapet
      faces.push([i + 2 * n, next + 2 * n, next + 3 * n, i + 3 * n])
    }
    
    // Roof surface
    const roofFace: number[] = []
    for (let i = 0; i < n; i++) {
      roofFace.push(i + 3 * n)
    }
    faces.push(roofFace)
    
    // Add mechanical equipment if present
    if (hasMechanical && lod < 2) {
      const bounds = this.getFootprintBounds(innerFootprint)
      const centerX = (bounds.minX + bounds.maxX) / 2
      const centerY = (bounds.minY + bounds.maxY) / 2
      
      // Add simple mechanical penthouse
      const mechSize = 3.0
      const mechHeight = 2.5
      const mechStart = vertices.length
      
      // Mechanical box vertices
      vertices.push({ x: centerX - mechSize, y: centerY - mechSize, z: roofSurfaceZ })
      vertices.push({ x: centerX + mechSize, y: centerY - mechSize, z: roofSurfaceZ })
      vertices.push({ x: centerX + mechSize, y: centerY + mechSize, z: roofSurfaceZ })
      vertices.push({ x: centerX - mechSize, y: centerY + mechSize, z: roofSurfaceZ })
      
      vertices.push({ x: centerX - mechSize, y: centerY - mechSize, z: roofSurfaceZ + mechHeight })
      vertices.push({ x: centerX + mechSize, y: centerY - mechSize, z: roofSurfaceZ + mechHeight })
      vertices.push({ x: centerX + mechSize, y: centerY + mechSize, z: roofSurfaceZ + mechHeight })
      vertices.push({ x: centerX - mechSize, y: centerY + mechSize, z: roofSurfaceZ + mechHeight })
      
      // Mechanical box faces
      faces.push([mechStart, mechStart + 1, mechStart + 5, mechStart + 4])
      faces.push([mechStart + 1, mechStart + 2, mechStart + 6, mechStart + 5])
      faces.push([mechStart + 2, mechStart + 3, mechStart + 7, mechStart + 6])
      faces.push([mechStart + 3, mechStart, mechStart + 4, mechStart + 7])
      faces.push([mechStart + 4, mechStart + 5, mechStart + 6, mechStart + 7])
    }
    
    return {
      type: 'roof',
      vertices,
      faces,
      materialId: zoneType === 'industrial' ? 5 : 3
    }
  }
  
  private generateFlatRoof(massing: BuildingMassing, bottomZ: number, topZ: number, lod: BuildingLOD): BuildingComponent {
    const vertices: { x: number; y: number; z: number }[] = []
    const faces: number[][] = []
    
    // Simple parapet around the edge
    const outerFootprint = massing.footprint
    const innerFootprint = GeometryUtils.offsetPolygon(outerFootprint, -0.3)
    
    // Bottom outer ring
    for (const point of outerFootprint) {
      vertices.push({ x: point.x, y: point.y, z: bottomZ })
    }
    
    // Bottom inner ring
    for (const point of innerFootprint) {
      vertices.push({ x: point.x, y: point.y, z: bottomZ })
    }
    
    // Top outer ring
    for (const point of outerFootprint) {
      vertices.push({ x: point.x, y: point.y, z: topZ })
    }
    
    // Top inner ring (slightly lower for drainage)
    for (const point of innerFootprint) {
      vertices.push({ x: point.x, y: point.y, z: topZ - 0.1 })
    }
    
    const n = outerFootprint.length
    
    // Create parapet faces
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n
      
      // Outer wall
      faces.push([i, next, next + 2 * n, i + 2 * n])
      
      // Inner wall
      faces.push([i + n, i + 3 * n, next + 3 * n, next + n])
      
      // Top of parapet
      faces.push([i + 2 * n, next + 2 * n, next + 3 * n, i + 3 * n])
    }
    
    // Roof surface (inner area)
    const roofFace: number[] = []
    for (let i = 0; i < n; i++) {
      roofFace.push(i + 3 * n)
    }
    faces.push(roofFace)
    
    return {
      type: 'roof',
      vertices,
      faces,
      materialId: 3
    }
  }
  
  private generateGableRoof(massing: BuildingMassing, bottomZ: number, topZ: number, lod: BuildingLOD): BuildingComponent {
    const vertices: { x: number; y: number; z: number }[] = []
    const faces: number[][] = []
    
    // Simplified gable for alpha version
    const footprint = massing.footprint
    const bounds = this.getFootprintBounds(footprint)
    const centerX = (bounds.minX + bounds.maxX) / 2
    const centerY = (bounds.minY + bounds.maxY) / 2
    
    // Base vertices
    for (const point of footprint) {
      vertices.push({ x: point.x, y: point.y, z: bottomZ })
    }
    
    // Ridge vertices (simplified to 2 points)
    vertices.push({ x: bounds.minX, y: centerY, z: topZ })
    vertices.push({ x: bounds.maxX, y: centerY, z: topZ })
    
    const n = footprint.length
    const ridgeStart = n
    const ridgeEnd = n + 1
    
    // Create sloped faces (simplified)
    faces.push([0, 1, ridgeStart]) // Front gable
    faces.push([2, 3, ridgeEnd]) // Back gable
    
    // Side slopes
    faces.push([0, ridgeStart, ridgeEnd, 3])
    faces.push([1, 2, ridgeEnd, ridgeStart])
    
    return {
      type: 'roof',
      vertices,
      faces,
      materialId: 4
    }
  }
  
  private generateHipRoof(massing: BuildingMassing, bottomZ: number, topZ: number, lod: BuildingLOD): BuildingComponent {
    // Simplified hip roof - similar to pyramid but with a ridge
    return this.generatePyramidRoof(massing, bottomZ, topZ, lod)
  }
  
  private generateMansardRoof(massing: BuildingMassing, bottomZ: number, topZ: number, lod: BuildingLOD): BuildingComponent {
    const vertices: { x: number; y: number; z: number }[] = []
    const faces: number[][] = []
    
    // Two-level roof with steep lower slope and flat/shallow upper
    const footprint = massing.footprint
    const midFootprint = GeometryUtils.offsetPolygon(footprint, -1.0)
    const topFootprint = GeometryUtils.offsetPolygon(footprint, -1.5)
    
    const midZ = bottomZ + (topZ - bottomZ) * 0.7
    
    // Bottom level
    for (const point of footprint) {
      vertices.push({ x: point.x, y: point.y, z: bottomZ })
    }
    
    // Mid level
    for (const point of midFootprint) {
      vertices.push({ x: point.x, y: point.y, z: midZ })
    }
    
    // Top level
    for (const point of topFootprint) {
      vertices.push({ x: point.x, y: point.y, z: topZ })
    }
    
    const n = footprint.length
    
    // Lower steep section
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n
      faces.push([i, next, next + n, i + n])
    }
    
    // Upper shallow section
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n
      faces.push([i + n, next + n, next + 2 * n, i + 2 * n])
    }
    
    // Top cap
    const topFace: number[] = []
    for (let i = 0; i < n; i++) {
      topFace.push(i + 2 * n)
    }
    faces.push(topFace)
    
    return {
      type: 'roof',
      vertices,
      faces,
      materialId: 4
    }
  }
  
  private generatePyramidRoof(massing: BuildingMassing, bottomZ: number, topZ: number, lod: BuildingLOD): BuildingComponent {
    const vertices: { x: number; y: number; z: number }[] = []
    const faces: number[][] = []
    
    const footprint = massing.footprint
    const centroid = GeometryUtils.polygonCentroid(footprint)
    
    // Base vertices
    for (const point of footprint) {
      vertices.push({ x: point.x, y: point.y, z: bottomZ })
    }
    
    // Apex vertex
    vertices.push({ x: centroid.x, y: centroid.y, z: topZ })
    
    const n = footprint.length
    const apex = n
    
    // Create triangular faces
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n
      faces.push([i, next, apex])
    }
    
    // Bottom cap
    const bottomFace: number[] = []
    for (let i = n - 1; i >= 0; i--) {
      bottomFace.push(i)
    }
    faces.push(bottomFace)
    
    return {
      type: 'roof',
      vertices,
      faces,
      materialId: 4
    }
  }
  
  private generateBarrelRoof(massing: BuildingMassing, bottomZ: number, topZ: number, lod: BuildingLOD): BuildingComponent {
    // Simplified barrel vault roof
    const vertices: { x: number; y: number; z: number }[] = []
    const faces: number[][] = []
    
    const footprint = massing.footprint
    const bounds = this.getFootprintBounds(footprint)
    const centerY = (bounds.minY + bounds.maxY) / 2
    const radius = (bounds.maxY - bounds.minY) / 2
    
    // Generate curved profile
    const segments = lod === 2 ? 3 : 5
    
    for (let seg = 0; seg <= segments; seg++) {
      const angle = (seg / segments) * Math.PI
      const offsetY = -radius * Math.cos(angle)
      const offsetZ = radius * Math.sin(angle)
      
      for (const point of footprint) {
        vertices.push({
          x: point.x,
          y: centerY + offsetY,
          z: bottomZ + offsetZ
        })
      }
    }
    
    // Create faces
    const n = footprint.length
    for (let seg = 0; seg < segments; seg++) {
      for (let i = 0; i < n; i++) {
        const next = (i + 1) % n
        const bottomLeft = seg * n + i
        const bottomRight = seg * n + next
        const topLeft = (seg + 1) * n + i
        const topRight = (seg + 1) * n + next
        
        faces.push([bottomLeft, bottomRight, topRight, topLeft])
      }
    }
    
    return {
      type: 'roof',
      vertices,
      faces,
      materialId: 4
    }
  }
  
  private generateSawtoothRoof(massing: BuildingMassing, bottomZ: number, topZ: number, lod: BuildingLOD): BuildingComponent {
    // Industrial sawtooth roof with repeated triangular sections
    const vertices: { x: number; y: number; z: number }[] = []
    const faces: number[][] = []
    
    const footprint = massing.footprint
    const bounds = this.getFootprintBounds(footprint)
    const width = bounds.maxX - bounds.minX
    
    const teethCount = Math.max(2, Math.floor(width / 8))
    const toothWidth = width / teethCount
    
    // Generate sawtooth profile along X axis
    for (let tooth = 0; tooth < teethCount; tooth++) {
      const x1 = bounds.minX + tooth * toothWidth
      const x2 = x1 + toothWidth * 0.7
      const x3 = x1 + toothWidth
      
      // Add vertices for this tooth
      vertices.push({ x: x1, y: bounds.minY, z: bottomZ })
      vertices.push({ x: x1, y: bounds.maxY, z: bottomZ })
      vertices.push({ x: x2, y: bounds.minY, z: topZ })
      vertices.push({ x: x2, y: bounds.maxY, z: topZ })
      vertices.push({ x: x3, y: bounds.minY, z: bottomZ })
      vertices.push({ x: x3, y: bounds.maxY, z: bottomZ })
      
      const base = tooth * 6
      
      // Sloped face
      faces.push([base, base + 1, base + 3, base + 2])
      
      // Vertical face
      faces.push([base + 2, base + 3, base + 5, base + 4])
      
      // End caps
      faces.push([base, base + 2, base + 4])
      faces.push([base + 1, base + 5, base + 3])
    }
    
    return {
      type: 'roof',
      vertices,
      faces,
      materialId: 5
    }
  }
  
  private generateGreenRoof(massing: BuildingMassing, bottomZ: number, topZ: number, lod: BuildingLOD): BuildingComponent {
    // Flat roof with raised planting areas
    const component = this.generateEnhancedFlatRoof(massing, bottomZ, topZ, lod)
    component.materialId = 6 // Green/planted material
    return component
  }
  
  private getFootprintBounds(footprint: Vec2[]): { minX: number; maxX: number; minY: number; maxY: number } {
    let minX = Infinity, maxX = -Infinity
    let minY = Infinity, maxY = -Infinity
    
    for (const point of footprint) {
      minX = Math.min(minX, point.x)
      maxX = Math.max(maxX, point.x)
      minY = Math.min(minY, point.y)
      maxY = Math.max(maxY, point.y)
    }
    
    return { minX, maxX, minY, maxY }
  }
  
  private combineComponents(components: BuildingComponent[], lod: BuildingLOD): BuildingMesh {
    let totalVertices = 0
    let totalFaces = 0
    
    for (const comp of components) {
      totalVertices += comp.vertices.length
      totalFaces += comp.faces.reduce((sum, face) => sum + (face.length - 2), 0) // Triangulate
    }
    
    const positions = new Float32Array(totalVertices * 3)
    const normals = new Float32Array(totalVertices * 3)
    const uvs = new Float32Array(totalVertices * 2)
    const indices = new Uint32Array(totalFaces * 3)
    const materialIds = new Uint8Array(totalFaces)
    
    let vertexOffset = 0
    let indexOffset = 0
    let faceOffset = 0
    
    for (const comp of components) {
      // Add vertices
      for (let i = 0; i < comp.vertices.length; i++) {
        const v = comp.vertices[i]
        positions[vertexOffset * 3] = v.x
        positions[vertexOffset * 3 + 1] = v.y
        positions[vertexOffset * 3 + 2] = v.z
        
        // Simple UV mapping
        uvs[vertexOffset * 2] = v.x / 10
        uvs[vertexOffset * 2 + 1] = v.y / 10
        
        vertexOffset++
      }
      
      // Add faces (triangulate if needed)
      for (const face of comp.faces) {
        if (face.length === 3) {
          // Triangle
          indices[indexOffset++] = face[0] + vertexOffset - comp.vertices.length
          indices[indexOffset++] = face[1] + vertexOffset - comp.vertices.length
          indices[indexOffset++] = face[2] + vertexOffset - comp.vertices.length
          materialIds[faceOffset++] = comp.materialId
        } else if (face.length === 4) {
          // Quad - split into 2 triangles
          indices[indexOffset++] = face[0] + vertexOffset - comp.vertices.length
          indices[indexOffset++] = face[1] + vertexOffset - comp.vertices.length
          indices[indexOffset++] = face[2] + vertexOffset - comp.vertices.length
          materialIds[faceOffset++] = comp.materialId
          
          indices[indexOffset++] = face[0] + vertexOffset - comp.vertices.length
          indices[indexOffset++] = face[2] + vertexOffset - comp.vertices.length
          indices[indexOffset++] = face[3] + vertexOffset - comp.vertices.length
          materialIds[faceOffset++] = comp.materialId
        } else {
          // General polygon - fan triangulation
          const first = face[0] + vertexOffset - comp.vertices.length
          for (let i = 1; i < face.length - 1; i++) {
            indices[indexOffset++] = first
            indices[indexOffset++] = face[i] + vertexOffset - comp.vertices.length
            indices[indexOffset++] = face[i + 1] + vertexOffset - comp.vertices.length
            materialIds[faceOffset++] = comp.materialId
          }
        }
      }
    }
    
    // Calculate normals
    this.calculateNormals(positions, indices, normals)
    
    return {
      positions,
      normals,
      uvs,
      indices,
      materialIds,
      lod
    }
  }
  
  private calculateNormals(positions: Float32Array, indices: Uint32Array, normals: Float32Array) {
    // Reset normals
    normals.fill(0)
    
    // Calculate face normals and accumulate
    for (let i = 0; i < indices.length; i += 3) {
      const i0 = indices[i] * 3
      const i1 = indices[i + 1] * 3
      const i2 = indices[i + 2] * 3
      
      // Get vertices
      const v0x = positions[i0], v0y = positions[i0 + 1], v0z = positions[i0 + 2]
      const v1x = positions[i1], v1y = positions[i1 + 1], v1z = positions[i1 + 2]
      const v2x = positions[i2], v2y = positions[i2 + 1], v2z = positions[i2 + 2]
      
      // Calculate edges
      const e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z
      const e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z
      
      // Cross product
      const nx = e1y * e2z - e1z * e2y
      const ny = e1z * e2x - e1x * e2z
      const nz = e1x * e2y - e1y * e2x
      
      // Accumulate
      normals[i0] += nx; normals[i0 + 1] += ny; normals[i0 + 2] += nz
      normals[i1] += nx; normals[i1 + 1] += ny; normals[i1 + 2] += nz
      normals[i2] += nx; normals[i2 + 1] += ny; normals[i2 + 2] += nz
    }
    
    // Normalize
    for (let i = 0; i < normals.length; i += 3) {
      const nx = normals[i], ny = normals[i + 1], nz = normals[i + 2]
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
      if (len > 0) {
        normals[i] /= len
        normals[i + 1] /= len
        normals[i + 2] /= len
      }
    }
  }
}

// Building manager class
class BuildingManager {
  private buildings: Map<number, BuildingMassing>
  private meshCache: Map<string, BuildingMesh>
  private meshGenerator: BuildingMeshGenerator
  private splitGrammar: SplitGrammar
  private nextBuildingId: number = 0
  private rng: () => number
  
  constructor(rng: () => number) {
    this.buildings = new Map()
    this.meshCache = new Map()
    this.rng = rng
    this.meshGenerator = new BuildingMeshGenerator(rng)
    this.splitGrammar = new SplitGrammar(rng)
  }
  
  // Generate building for a specific parcel
  generateBuildingForParcel(parcel: Parcel, era: EraTag, level: number = 1): BuildingMassing | null {
    if (parcel.zoneType === 'none') return null
    
    // Create deterministic RNG for this parcel
    const parcelRng = mulberry32(parcel.id + level * 1000)
    
    // Determine building parameters based on zone and era
    const style = this.getStyleForEra(era, parcelRng)
    const roofType = this.getRoofForEra(era, parcel.zoneDensity, parcelRng)
    const setback = this.getSetback(parcel.zoneDensity, parcelRng)
    
    // Calculate building footprint with setback
    const footprint = GeometryUtils.offsetPolygon(parcel.vertices, -setback)
    if (footprint.length < 3) return null // Skip if setback leaves no buildable area
    
    // Determine height based on density and level
    const heightRange = HEIGHT_BY_DENSITY[parcel.zoneDensity]
    const baseHeight = heightRange.min + parcelRng() * (heightRange.max - heightRange.min)
    const height = baseHeight * (1 + (level - 1) * 0.3) // Increase height with level
    const floorCount = Math.max(1, Math.round(height / FLOOR_HEIGHT))
    
    // Apply zone-specific adjustments
    let adjustedHeight = height
    let adjustedStyle = style
    
    switch (parcel.zoneType) {
      case 'commercial':
        // Taller ground floor for retail
        adjustedHeight *= 1.1
        break
      case 'industrial':
        // Lower, wider buildings
        adjustedHeight *= 0.7
        adjustedStyle = era >= '1950s' ? 'modern' : style
        break
    }
    
    // Split into components
    const splits = this.splitGrammar.splitVertical(adjustedHeight, adjustedStyle)
    
    const building: BuildingMassing = {
      id: this.nextBuildingId++,
      parcelId: parcel.id,
      footprint,
      height: adjustedHeight,
      baseHeight: splits.base,
      bodyHeight: splits.body,
      roofHeight: splits.roof,
      floorCount,
      style: adjustedStyle,
      roofType,
      setback,
      seed: parcel.id,
      zoneType: parcel.zoneType,
      zoneDensity: parcel.zoneDensity,
      level
    }
    
    this.buildings.set(building.id, building)
    return building
  }
  
  // Get mesh data for a specific parcel's building
  getBuildingMeshForParcel(parcelId: number, lod: BuildingLOD): {
    buildingId: number
    lod: BuildingLOD
    positions: Float32Array
    indices: Uint32Array
    normals: Float32Array
    uvs: Float32Array
    materialIds: Uint8Array
  } | null {
    // Find building for this parcel
    let building: BuildingMassing | null = null
    for (const [_, b] of this.buildings) {
      if (b.parcelId === parcelId) {
        building = b
        break
      }
    }
    
    if (!building) return null
    
    const cacheKey = `${building.id}_${lod}`
    let mesh = this.meshCache.get(cacheKey)
    
    if (!mesh) {
      mesh = this.meshGenerator.generateMesh(building, lod)
      this.meshCache.set(cacheKey, mesh)
    }
    
    return {
      buildingId: building.id,
      lod,
      positions: mesh.positions,
      indices: mesh.indices,
      normals: mesh.normals,
      uvs: mesh.uvs,
      materialIds: mesh.materialIds
    }
  }
  
  // Generate buildings for all parcels
  generateBuildings(parcels: Parcel[], era: EraTag): BuildingMassing[] {
    const generated: BuildingMassing[] = []
    
    for (const parcel of parcels) {
      if (parcel.zoneType === 'none') continue
      
      // Create deterministic RNG for this parcel
      const parcelRng = mulberry32(parcel.id)
      
      // Determine building parameters based on zone and era
      const style = this.getStyleForEra(era, parcelRng)
      const roofType = this.getRoofForEra(era, parcel.zoneDensity, parcelRng)
      const setback = this.getSetback(parcel.zoneDensity, parcelRng)
      
      // Calculate building footprint with setback
      const footprint = GeometryUtils.offsetPolygon(parcel.vertices, -setback)
      if (footprint.length < 3) continue // Skip if setback leaves no buildable area
      
      // Determine height based on density
      const heightRange = HEIGHT_BY_DENSITY[parcel.zoneDensity]
      const height = heightRange.min + parcelRng() * (heightRange.max - heightRange.min)
      const floorCount = Math.max(1, Math.round(height / FLOOR_HEIGHT))
      
      // Apply zone-specific adjustments
      let adjustedHeight = height
      let adjustedStyle = style
      
      switch (parcel.zoneType) {
        case 'commercial':
          // Taller ground floor for retail
          adjustedHeight *= 1.1
          break
        case 'industrial':
          // Lower, wider buildings
          adjustedHeight *= 0.7
          adjustedStyle = era >= '1950s' ? 'modern' : style
          break
        case 'residential':
          // Standard heights
          break
      }
      
      // Split into components
      const splits = this.splitGrammar.splitVertical(adjustedHeight, adjustedStyle)
      
      const massing: BuildingMassing = {
        id: this.nextBuildingId++,
        parcelId: parcel.id,
        footprint,
        height: adjustedHeight,
        baseHeight: splits.base,
        bodyHeight: splits.body,
        roofHeight: splits.roof,
        style: adjustedStyle,
        roofType,
        floorCount,
        setback,
        seed: parcel.id,
        zoneType: parcel.zoneType,
        zoneDensity: parcel.zoneDensity,
        level: 1 // Default level for bulk generation
      }
      
      this.buildings.set(massing.id, massing)
      generated.push(massing)
    }
    
    return generated
  }
  
  private getStyleForEra(era: EraTag, rng: () => number): BuildingStyle {
    const styles = STYLE_BY_ERA[era] || ['modern']
    return styles[Math.floor(rng() * styles.length)]
  }
  
  private getRoofForEra(era: EraTag, density: ZoneDensity, rng: () => number): RoofType {
    const roofs = ROOF_BY_ERA[era] || ['flat']
    
    // High density tends toward flat roofs
    if (density === 'high' && rng() > 0.3) {
      return 'flat'
    }
    
    return roofs[Math.floor(rng() * roofs.length)]
  }
  
  private getSetback(density: ZoneDensity, rng: () => number): number {
    const range = SETBACK_BY_DENSITY[density]
    return range.min + rng() * (range.max - range.min)
  }
  
  // Get mesh for a building at specified LOD
  getBuildingMesh(buildingId: number, lod: BuildingLOD): BuildingMesh | null {
    const building = this.buildings.get(buildingId)
    if (!building) return null
    
    const cacheKey = `${buildingId}_${lod}`
    
    if (this.meshCache.has(cacheKey)) {
      return this.meshCache.get(cacheKey)!
    }
    
    const mesh = this.meshGenerator.generateMesh(building, lod)
    this.meshCache.set(cacheKey, mesh)
    
    return mesh
  }
  
  // Get all building meshes as typed arrays for transfer
  getAllBuildingMeshes(lod: BuildingLOD): {
    meshData: Float32Array  // Packed mesh data
    buildingOffsets: Uint32Array  // Offset into meshData for each building
    buildingInfo: Float32Array  // [id, parcelId, height, style, roofType] per building
  } {
    const meshes: BuildingMesh[] = []
    const buildingInfoList: number[] = []
    
    for (const building of this.buildings.values()) {
      const mesh = this.getBuildingMesh(building.id, lod)
      if (mesh) {
        meshes.push(mesh)
        buildingInfoList.push(
          building.id,
          building.parcelId,
          building.height,
          this.styleToInt(building.style),
          this.roofToInt(building.roofType)
        )
      }
    }
    
    // Calculate total size needed
    let totalPositions = 0
    let totalIndices = 0
    
    for (const mesh of meshes) {
      totalPositions += mesh.positions.length
      totalIndices += mesh.indices.length
    }
    
    // Pack mesh data
    const meshData = new Float32Array(totalPositions + totalIndices)
    const buildingOffsets = new Uint32Array(meshes.length * 2) // position offset, index offset
    const buildingInfo = new Float32Array(buildingInfoList)
    
    let posOffset = 0
    let idxOffset = totalPositions
    
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i]
      
      // Store offsets
      buildingOffsets[i * 2] = posOffset
      buildingOffsets[i * 2 + 1] = idxOffset - totalPositions
      
      // Copy position data
      meshData.set(mesh.positions, posOffset)
      posOffset += mesh.positions.length
      
      // Copy index data
      for (let j = 0; j < mesh.indices.length; j++) {
        meshData[idxOffset + j] = mesh.indices[j]
      }
      idxOffset += mesh.indices.length
    }
    
    return { meshData, buildingOffsets, buildingInfo }
  }
  
  private styleToInt(style: BuildingStyle): number {
    const map: Record<BuildingStyle, number> = {
      victorian: 0,
      'art-deco': 1,
      modern: 2,
      brutalist: 3,
      postmodern: 4,
      contemporary: 5,
      futuristic: 6
    }
    return map[style]
  }
  
  private roofToInt(roof: RoofType): number {
    const map: Record<RoofType, number> = {
      flat: 0,
      gable: 1,
      hip: 2,
      mansard: 3,
      pyramid: 4,
      barrel: 5,
      sawtooth: 6,
      green: 7
    }
    return map[roof]
  }
  
  clear() {
    this.buildings.clear()
    this.meshCache.clear()
    this.nextBuildingId = 0
  }
  
  getBuildings(): BuildingMassing[] {
    return Array.from(this.buildings.values())
  }
}

// Worker state
let rng = mulberry32(1)
let currentSeed = 1
let currentEra: EraTag = '1890s'
let generator: RoadGenerator | null = null
let network: RoadNetwork | null = null
let blockManager: CityBlockManager | null = null
let buildingManager: BuildingManager | null = null
let intersectionHandler: IntersectionHandler | null = null

// Initialize with default config
function initializeGenerator(seed: number, era: EraTag = '1890s') {
  console.log('[ProcGen] Initializing with seed:', seed, 'era:', era)
  currentSeed = seed
  currentEra = era
  rng = mulberry32(seed)

  const config: GenerationConfig = {
    seed,
    era,
    bounds: { width: 2000, height: 2000 }, // 2km x 2km city
    gridBias: era.startsWith('18') || era.startsWith('191') ? 0.3 : 0.6, // More organic in early eras
    density: era.startsWith('20') ? 0.7 : 0.5, // Denser in modern eras
    blockSizeMin: era === '1890s' || era === '1910s' ? 60 : 80,
    blockSizeMax: era === '1890s' || era === '1910s' ? 120 : 150,
    minIntersectionAngle: 30,
    centerCount: era === '1890s' ? 1 : (era.startsWith('20') ? 3 : 2) // More centers in modern eras
  }

  generator = new RoadGenerator(config, rng)
  network = generator.generate()
  
  // Initialize BlockManager
  blockManager = new CityBlockManager(rng)
  
  // Initialize BuildingManager if not already initialized
  if (!buildingManager) {
    buildingManager = new BuildingManager(rng)
  }
  
  console.log('[ProcGen] Network generated:', network ? 'yes' : 'no')
  console.log('[ProcGen] BlockManager initialized:', !!blockManager)
  if (network) {
    const nodes = network['nodes'] ? network['nodes'].size : 0
    const edges = network['edges'] ? network['edges'].size : 0
    console.log('[ProcGen] Network has', nodes, 'nodes and', edges, 'edges')
  }
  
  // Initialize intersection handler for proper road welding
  intersectionHandler = new IntersectionHandler()
  
  // Initialize block manager and find city blocks
  blockManager = new CityBlockManager(rng)
  if (network) {
    blockManager.findCityBlocks(network)
  }
  
  // Initialize building manager
  buildingManager = new BuildingManager(rng)
}

// Message handlers
self.onmessage = (e: MessageEvent) => {
  const msg = e.data
  console.log('[ProcGen] Received message:', msg.type)

  switch (msg.type) {
    case 'boot':
      initializeGenerator(msg.seed || 1, msg.era || '1890s')
      
      // Send initial road network and blocks
      if (network) {
        const arrays = network.getTypedArrays()
        const blocks = blockManager ? blockManager.getBlocks().map(block => ({
          id: block.id,
          vertices: block.vertices,
          area: block.area,
          parcelCount: block.parcels.length
        })) : []
        
        self.postMessage({
          type: 'roads-generated',
          data: arrays,
          segments: network.getRoadSegments(),
          blocks
        })
      }
      break

    case 'shuffle-seed':
      initializeGenerator(msg.seed, currentEra)
      
      // Send updated road network and blocks
      if (network) {
        const arrays = network.getTypedArrays()
        const blocks = blockManager ? blockManager.getBlocks().map(block => ({
          id: block.id,
          vertices: block.vertices,
          area: block.area,
          parcelCount: block.parcels.length
        })) : []
        
        self.postMessage({
          type: 'roads-generated',
          data: arrays,
          segments: network.getRoadSegments(),
          blocks
        })
      }
      break

    case 'set-era':
      currentEra = msg.era
      initializeGenerator(currentSeed, msg.era)
      
      if (network) {
        const arrays = network.getTypedArrays()
        const blocks = blockManager ? blockManager.getBlocks().map(block => ({
          id: block.id,
          vertices: block.vertices,
          area: block.area,
          parcelCount: block.parcels.length
        })) : []
        
        self.postMessage({
          type: 'roads-generated',
          data: arrays,
          segments: network.getRoadSegments(),
          blocks
        })
      }
      break

    case 'paint-road':
      console.log('[ProcGen] Paint road request:', msg)
      if (intersectionHandler) {
        const { start, end, roadClass = 'street' } = msg
        console.log('[ProcGen] Painting road from', start, 'to', end, 'class:', roadClass)
        
        // Get road width based on class
        const roadWidths = { highway: 24, avenue: 16, street: 12, local: 8 }
        const width = roadWidths[roadClass as keyof typeof roadWidths] || 12
        const classNum = roadClass === 'highway' ? 0 : roadClass === 'avenue' ? 1 : roadClass === 'street' ? 2 : 3
        
        // Add segment with proper intersection handling
        intersectionHandler.addSegment(start, end, width, classNum)
        
        // Get all segments and intersections for rendering
        const segments = intersectionHandler.getSegments()
        const intersections = intersectionHandler.getIntersections()
        
        console.log('[ProcGen] After paint: ', segments.length, 'segments,', intersections.length, 'intersections')
        
        // Convert to format expected by renderer
        const roadSegments = segments.map(seg => ({
          start: seg.start,
          end: seg.end,
          width: seg.width,
          class: seg.class,
          material: 2 // asphalt
        }))
        
        self.postMessage({
          type: 'road-painted',
          success: true,
          segments: roadSegments,
          intersections: intersections.map(i => ({
            x: i.position.x,
            y: i.position.y,
            type: i.type,
            radius: i.radius
          }))
        })
      } else {
        console.log('[ProcGen] No intersection handler available')
        self.postMessage({
          type: 'road-painted',
          success: false,
          error: 'Intersection handler not initialized'
        })
      }
      break

    case 'get-roads':
      if (intersectionHandler) {
        const segments = intersectionHandler.getSegments()
        const intersections = intersectionHandler.getIntersections()
        console.log('[ProcGen] Sending roads data, segments:', segments.length, 'intersections:', intersections.length)
        
        // Convert to format expected by renderer
        const roadSegments = segments.map(seg => ({
          start: seg.start,
          end: seg.end,
          width: seg.width,
          class: seg.class,
          material: 2 // asphalt
        }))
        
        self.postMessage({
          type: 'roads-generated',
          segments: roadSegments,
          intersections: intersections.map(i => ({
            x: i.position.x,
            y: i.position.y,
            type: i.type,
            radius: i.radius
          }))
        })
      } else {
        console.log('[ProcGen] No intersection handler available yet')
        self.postMessage({
          type: 'roads-generated',
          segments: []
        })
      }
      break

    case 'get-stats':
      if (network) {
        const nodeCount = network['nodes'].size
        const edgeCount = network['edges'].size
        const segments = network.getRoadSegments()
        const totalLength = segments.reduce((sum, seg) => {
          const dx = seg.end.x - seg.start.x
          const dy = seg.end.y - seg.start.y
          return sum + Math.sqrt(dx * dx + dy * dy)
        }, 0)

        let blockCount = 0
        let parcelCount = 0
        if (blockManager) {
          blockCount = blockManager.getBlocks().length
          parcelCount = blockManager.getParcels().length
        }

        self.postMessage({
          type: 'network-stats',
          stats: {
            nodeCount,
            edgeCount,
            totalRoadLength: totalLength,
            averageBlockSize: totalLength > 0 ? (2000 * 2000) / edgeCount : 0,
            blockCount,
            parcelCount
          }
        })
      }
      break

    case 'paint-zone':
      console.log('[ProcGen] Paint zone request received:', msg.zoneType, 'Polygon:', msg.polygon)
      console.log('[ProcGen] BlockManager exists:', !!blockManager, 'Network exists:', !!network)
      if (blockManager && network) {
        const request: ZonePaintRequest = {
          polygon: msg.polygon || [],
          zoneType: msg.zoneType || 'residential',
          zoneDensity: msg.zoneDensity || 'medium',
          subdivisionMethod: msg.subdivisionMethod || 'skeleton'
        }
        
        console.log('[ProcGen] Paint request constructed:', request)
        console.log('[ProcGen] Blocks before painting:', blockManager.getBlocks().length)
        const affectedParcelIds = blockManager.paintZone(request, network)
        console.log('[ProcGen] Affected parcels:', affectedParcelIds.length)
        
        const arrays = blockManager.getParcelsTypedArrays()
        console.log('[ProcGen] Parcel arrays size:', arrays?.parcelData?.length || 0)
        
        // Get the actual parcel data for affected parcels
        const allParcels = blockManager.getParcels()
        const affectedParcels = allParcels.filter(p => affectedParcelIds.includes(p.id))
        
        self.postMessage({
          type: 'zone-painted',
          affectedParcelIds,
          affectedParcels: affectedParcels.map(p => ({
            id: p.id,
            zoneType: p.zoneType,
            zoneDensity: p.zoneDensity,
            area: p.area,
            frontage: p.frontage,
            centroid: p.centroid,
            vertices: p.vertices
          })),
          parcels: arrays,
          blocks: blockManager.getBlocks().map(block => ({
            id: block.id,
            vertices: block.vertices,
            area: block.area,
            parcelCount: block.parcels.length
          }))
        })
      } else {
        console.error('[ProcGen] Block manager not initialized!', 'blockManager:', !!blockManager, 'network:', !!network)
        self.postMessage({
          type: 'zone-painted',
          error: 'Block manager not initialized',
          affectedParcels: []
        })
      }
      break

    case 'get-parcels':
      if (blockManager) {
        const arrays = blockManager.getParcelsTypedArrays()
        const parcels = blockManager.getParcels()
        
        self.postMessage({
          type: 'parcels-data',
          parcels: arrays,
          parcelList: parcels.map(p => ({
            id: p.id,
            vertices: p.vertices,
            zoneType: p.zoneType,
            zoneDensity: p.zoneDensity,
            area: p.area,
            frontage: p.frontage,
            isCorner: p.isCorner,
            centroid: p.centroid
          })),
          blocks: blockManager.getBlocks().map(block => ({
            id: block.id,
            vertices: block.vertices,
            area: block.area,
            parcelCount: block.parcels.length
          }))
        })
      } else {
        self.postMessage({
          type: 'parcels-data',
          error: 'Block manager not initialized',
          parcels: null
        })
      }
      break

    case 'get-blocks':
      if (blockManager) {
        const blocks = blockManager.getBlocks()
        self.postMessage({
          type: 'blocks-data',
          blocks: blocks.map(block => ({
            id: block.id,
            vertices: block.vertices,
            holes: block.holes,
            area: block.area,
            perimeter: block.perimeter,
            parcelCount: block.parcels.length,
            roadEdges: block.roadEdges
          }))
        })
      } else {
        self.postMessage({
          type: 'blocks-data',
          error: 'Block manager not initialized',
          blocks: []
        })
      }
      break

    case 'clear-zones':
      if (blockManager) {
        blockManager.clear()
        if (network) {
          blockManager.findCityBlocks(network)
        }
        
        // Also clear buildings
        if (buildingManager) {
          buildingManager.clear()
        }
        
        self.postMessage({
          type: 'zones-cleared',
          success: true
        })
      }
      break

    case 'generate-building-for-zone':
      // Generate a building for a specific zone that has spawned or upgraded
      if (blockManager && buildingManager) {
        const { zoneId, zoneType, position, level, event } = msg
        console.log('[ProcGen] Generating building for zone', zoneId, 'event:', event, 'level:', level, 'position:', position)
        
        // First attempt to locate the parcel by point-in-polygon test
        let targetParcel = blockManager.findParcelAt(position)

        const parcels = blockManager.getParcels()
        console.log('[ProcGen] Searching among', parcels.length, 'parcels')

        // If direct containment fails, fall back to centroid matching
        if (!targetParcel) {
          targetParcel = parcels.find(p => {
            const centroid = GeometryUtils.polygonCentroid(p.vertices)
            const dist = Math.sqrt((centroid.x - position.x) ** 2 + (centroid.y - position.y) ** 2)
            if (dist < 5) {
              console.log('[ProcGen] Found exact match parcel', p.id, 'at distance', dist)
              return true
            }
            return false
          })
        }

        // If still not found, choose the closest parcel within reasonable range
        if (!targetParcel) {
          let minDist = Infinity
          for (const p of parcels) {
            const centroid = GeometryUtils.polygonCentroid(p.vertices)
            const dist = Math.sqrt((centroid.x - position.x) ** 2 + (centroid.y - position.y) ** 2)
            if (dist < minDist) {
              minDist = dist
              targetParcel = p
            }
          }
          if (targetParcel && minDist < 100) {
            console.log('[ProcGen] Found closest parcel', targetParcel.id, 'at distance', minDist)
          } else {
            console.log('[ProcGen] No parcel within 100m of position', position)
            targetParcel = null
          }
        }
        
        if (targetParcel) {
          console.log('[ProcGen] Generating building for parcel', targetParcel.id, 'zone type:', targetParcel.zoneType)
          
          // Generate building for this specific parcel
          const building = buildingManager.generateBuildingForParcel(targetParcel, currentEra, level || 1)
          console.log('[ProcGen] Building generated:', building ? `yes (id: ${building.id})` : 'no')
          
          if (!building) {
            console.error('[ProcGen] Failed to generate building for parcel', targetParcel.id)
            return
          }
          
          const lod = 1 as BuildingLOD // Medium detail
          const meshData = buildingManager.getBuildingMeshForParcel(targetParcel.id, lod)
          console.log('[ProcGen] Mesh data generated:', meshData ? 'yes' : 'no')
          
          if (!meshData) {
            console.error('[ProcGen] Failed to generate mesh for building', building.id)
          }
          
          self.postMessage({
            type: 'building-spawned',
            zoneId,
            parcelId: targetParcel.id,
            building: building ? {
              id: building.id,
              parcelId: building.parcelId,
              height: building.height,
              floorCount: building.floorCount,
              style: building.style,
              roofType: building.roofType
            } : null,
            meshData: meshData ? {
              buildingId: meshData.buildingId,
              vertices: meshData.positions,  // Rename to match renderer expectation
              indices: meshData.indices,
              normals: meshData.normals,
              uvs: meshData.uvs,
              materialIds: meshData.materialIds
            } : null,
            lod
          })
          console.log('[ProcGen] Building spawn message sent for zone', zoneId, 'mesh vertices:', meshData?.positions?.length)
        } else {
          console.error('[ProcGen] ERROR: No parcel found at position', position, 'for zone', zoneId)
        }
      }
      break
      
    case 'generate-buildings':
      if (blockManager && buildingManager) {
        const parcels = blockManager.getParcels()
        const buildings = buildingManager.generateBuildings(parcels, currentEra)
        
        // Get mesh data at specified LOD (default 1 for medium detail)
        const lod = (msg.lod !== undefined ? msg.lod : 1) as BuildingLOD
        const meshData = buildingManager.getAllBuildingMeshes(lod)
        
        self.postMessage({
          type: 'buildings-generated',
          buildings: buildings.map(b => ({
            id: b.id,
            parcelId: b.parcelId,
            height: b.height,
            floorCount: b.floorCount,
            style: b.style,
            roofType: b.roofType
          })),
          meshData,
          lod
        })
      } else {
        self.postMessage({
          type: 'buildings-generated',
          error: 'Managers not initialized',
          buildings: []
        })
      }
      break

    case 'get-buildings':
      if (buildingManager) {
        const buildings = buildingManager.getBuildings()
        const lod = (msg.lod !== undefined ? msg.lod : 1) as BuildingLOD
        const meshData = buildingManager.getAllBuildingMeshes(lod)
        
        self.postMessage({
          type: 'buildings-data',
          buildings: buildings.map(b => ({
            id: b.id,
            parcelId: b.parcelId,
            height: b.height,
            floorCount: b.floorCount,
            style: b.style,
            roofType: b.roofType
          })),
          meshData,
          lod
        })
      } else {
        self.postMessage({
          type: 'buildings-data',
          error: 'Building manager not initialized',
          buildings: []
        })
      }
      break

    case 'get-building-mesh':
      if (buildingManager) {
        const { buildingId, lod = 1 } = msg
        const mesh = buildingManager.getBuildingMesh(buildingId, lod as BuildingLOD)
        
        if (mesh) {
          self.postMessage({
            type: 'building-mesh',
            buildingId,
            mesh,
            lod
          })
        } else {
          self.postMessage({
            type: 'building-mesh',
            error: 'Building not found',
            buildingId
          })
        }
      }
      break

    case 'set-building-lod':
      // Request to change LOD for all buildings
      if (buildingManager) {
        const lod = msg.lod as BuildingLOD
        const meshData = buildingManager.getAllBuildingMeshes(lod)
        
        self.postMessage({
          type: 'building-lod-changed',
          meshData,
          lod
        })
      }
      break

    case 'regenerate-with-zone':
      // Regenerate buildings after zone changes
      if (blockManager && buildingManager && network) {
        // First apply zone paint if provided
        if (msg.zoneRequest) {
          const request: ZonePaintRequest = msg.zoneRequest
          blockManager.paintZone(request, network)
        }
        
        // Clear existing buildings
        buildingManager.clear()
        
        // Generate new buildings
        const parcels = blockManager.getParcels()
        const buildings = buildingManager.generateBuildings(parcels, currentEra)
        
        const lod = (msg.lod !== undefined ? msg.lod : 1) as BuildingLOD
        const meshData = buildingManager.getAllBuildingMeshes(lod)
        
        self.postMessage({
          type: 'buildings-regenerated',
          buildings: buildings.map(b => ({
            id: b.id,
            parcelId: b.parcelId,
            height: b.height,
            floorCount: b.floorCount,
            style: b.style,
            roofType: b.roofType
          })),
          meshData,
          lod,
          parcels: blockManager.getParcelsTypedArrays()
        })
      }
      break

    default:
      console.warn('Unknown message type:', msg.type)
  }
}
