/**
 * Intersection Handler
 * Manages road intersection detection, welding, and geometry generation
 */

export interface Vec2 {
  x: number
  y: number
}

export interface RoadSegment {
  id: number
  start: Vec2
  end: Vec2
  width: number
  class: number // 0=highway, 1=avenue, 2=street, 3=local
}

export interface Intersection {
  id: number
  position: Vec2
  connectedSegments: number[] // IDs of connected road segments
  type: 'end' | 'T' | 'cross' | 'complex' // 2, 3, 4, or 5+ way
  angle: number // Average angle for orientation
  radius: number // Intersection size based on largest road
}

export interface SplitSegment {
  original: RoadSegment
  segments: RoadSegment[] // Split parts
  intersectionIds: number[] // Intersections where splits occur
}

export class IntersectionHandler {
  private segments: Map<number, RoadSegment> = new Map()
  private intersections: Map<number, Intersection> = new Map()
  private nextSegmentId: number = 0
  private nextIntersectionId: number = 0
  private readonly SNAP_THRESHOLD = 10 // Distance to snap endpoints together
  private readonly INTERSECTION_THRESHOLD = 2 // Distance to consider line intersection
  
  constructor() {}

  /**
   * Clear all data
   */
  clear() {
    this.segments.clear()
    this.intersections.clear()
    this.nextSegmentId = 0
    this.nextIntersectionId = 0
  }

  /**
   * Add a new road segment and handle intersections
   */
  addSegment(start: Vec2, end: Vec2, width: number, roadClass: number): number {
    const segmentId = this.nextSegmentId++
    const newSegment: RoadSegment = {
      id: segmentId,
      start: { ...start },
      end: { ...end },
      width,
      class: roadClass
    }

    // Find all intersections with existing segments
    const intersectionPoints = this.findIntersections(newSegment)
    
    // Split the new segment at intersection points
    const splitSegments = this.splitSegmentAtPoints(newSegment, intersectionPoints)
    
    // Add all split segments
    for (const segment of splitSegments) {
      this.segments.set(segment.id, segment)
    }

    // Update or create intersections
    this.updateIntersections(splitSegments, intersectionPoints)

    // Handle endpoint snapping and merging
    this.handleEndpointSnapping(splitSegments)

    return segmentId
  }

  /**
   * Find all intersection points between a segment and existing segments
   */
  private findIntersections(newSegment: RoadSegment): Array<{point: Vec2, segmentId: number}> {
    const intersections: Array<{point: Vec2, segmentId: number}> = []

    for (const [id, segment] of this.segments) {
      const intersection = this.lineIntersection(
        newSegment.start, newSegment.end,
        segment.start, segment.end
      )

      if (intersection) {
        // Check if intersection is not at endpoints (those are handled separately)
        const distToNewStart = this.distance(intersection, newSegment.start)
        const distToNewEnd = this.distance(intersection, newSegment.end)
        const distToSegStart = this.distance(intersection, segment.start)
        const distToSegEnd = this.distance(intersection, segment.end)

        const isMiddleIntersection = 
          distToNewStart > this.INTERSECTION_THRESHOLD &&
          distToNewEnd > this.INTERSECTION_THRESHOLD &&
          distToSegStart > this.INTERSECTION_THRESHOLD &&
          distToSegEnd > this.INTERSECTION_THRESHOLD

        if (isMiddleIntersection) {
          intersections.push({ point: intersection, segmentId: id })
        }
      }
    }

    return intersections
  }

  /**
   * Calculate line intersection point
   */
  private lineIntersection(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): Vec2 | null {
    const denom = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x)
    
    if (Math.abs(denom) < 0.001) return null // Parallel lines
    
    const t = ((p1.x - p3.x) * (p3.y - p4.y) - (p1.y - p3.y) * (p3.x - p4.x)) / denom
    const u = -((p1.x - p2.x) * (p1.y - p3.y) - (p1.y - p2.y) * (p1.x - p3.x)) / denom
    
    // Check if intersection is within both line segments
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      return {
        x: p1.x + t * (p2.x - p1.x),
        y: p1.y + t * (p2.y - p1.y)
      }
    }
    
    return null
  }

  /**
   * Split a segment at multiple points
   */
  private splitSegmentAtPoints(
    segment: RoadSegment, 
    intersectionPoints: Array<{point: Vec2, segmentId: number}>
  ): RoadSegment[] {
    if (intersectionPoints.length === 0) {
      return [segment]
    }

    // Sort intersection points by distance from start
    const sortedPoints = intersectionPoints.sort((a, b) => {
      const distA = this.distance(segment.start, a.point)
      const distB = this.distance(segment.start, b.point)
      return distA - distB
    })

    const segments: RoadSegment[] = []
    let currentStart = segment.start
    let segmentIndex = 0

    // Create segments between intersection points
    for (const intersection of sortedPoints) {
      const newSegment: RoadSegment = {
        id: segment.id + segmentIndex * 0.001, // Sub-IDs for split segments
        start: { ...currentStart },
        end: { ...intersection.point },
        width: segment.width,
        class: segment.class
      }
      segments.push(newSegment)
      currentStart = intersection.point
      segmentIndex++

      // Also split the existing segment that we're intersecting with
      this.splitExistingSegment(intersection.segmentId, intersection.point)
    }

    // Add final segment from last intersection to end
    segments.push({
      id: segment.id + segmentIndex * 0.001,
      start: { ...currentStart },
      end: { ...segment.end },
      width: segment.width,
      class: segment.class
    })

    return segments
  }

  /**
   * Split an existing segment at an intersection point
   */
  private splitExistingSegment(segmentId: number, point: Vec2) {
    const segment = this.segments.get(segmentId)
    if (!segment) return

    // Check if point is far enough from endpoints to warrant splitting
    const distToStart = this.distance(point, segment.start)
    const distToEnd = this.distance(point, segment.end)

    if (distToStart > this.INTERSECTION_THRESHOLD && distToEnd > this.INTERSECTION_THRESHOLD) {
      // Remove original segment
      this.segments.delete(segmentId)

      // Create two new segments
      const segment1: RoadSegment = {
        id: segmentId,
        start: segment.start,
        end: { ...point },
        width: segment.width,
        class: segment.class
      }

      const segment2: RoadSegment = {
        id: this.nextSegmentId++,
        start: { ...point },
        end: segment.end,
        width: segment.width,
        class: segment.class
      }

      this.segments.set(segment1.id, segment1)
      this.segments.set(segment2.id, segment2)
    }
  }

  /**
   * Update or create intersections at split points
   */
  private updateIntersections(segments: RoadSegment[], intersectionPoints: Array<{point: Vec2, segmentId: number}>) {
    // Create intersections at all segment endpoints and intersection points
    const points = new Set<string>()
    const pointMap = new Map<string, Vec2>()

    // Add all segment endpoints
    for (const segment of segments) {
      const startKey = `${Math.round(segment.start.x)},${Math.round(segment.start.y)}`
      const endKey = `${Math.round(segment.end.x)},${Math.round(segment.end.y)}`
      points.add(startKey)
      points.add(endKey)
      pointMap.set(startKey, segment.start)
      pointMap.set(endKey, segment.end)
    }

    // Add intersection points
    for (const intersection of intersectionPoints) {
      const key = `${Math.round(intersection.point.x)},${Math.round(intersection.point.y)}`
      points.add(key)
      pointMap.set(key, intersection.point)
    }

    // Create or update intersections
    for (const [key, point] of pointMap) {
      this.createOrUpdateIntersection(point)
    }
  }

  /**
   * Create or update an intersection at a point
   */
  private createOrUpdateIntersection(point: Vec2) {
    // Find all segments connected to this point
    const connectedSegments: number[] = []
    let maxWidth = 0

    for (const [id, segment] of this.segments) {
      const distToStart = this.distance(point, segment.start)
      const distToEnd = this.distance(point, segment.end)

      if (distToStart < this.INTERSECTION_THRESHOLD || distToEnd < this.INTERSECTION_THRESHOLD) {
        connectedSegments.push(id)
        maxWidth = Math.max(maxWidth, segment.width)
      }
    }

    if (connectedSegments.length < 2) return // Not an intersection

    // Check if intersection already exists at this point
    let existingIntersection: Intersection | undefined
    for (const [id, intersection] of this.intersections) {
      if (this.distance(intersection.position, point) < this.INTERSECTION_THRESHOLD) {
        existingIntersection = intersection
        break
      }
    }

    if (existingIntersection) {
      // Update existing intersection
      existingIntersection.connectedSegments = connectedSegments
      existingIntersection.type = this.getIntersectionType(connectedSegments.length)
      existingIntersection.radius = maxWidth * 0.75
    } else {
      // Create new intersection
      const intersection: Intersection = {
        id: this.nextIntersectionId++,
        position: { ...point },
        connectedSegments,
        type: this.getIntersectionType(connectedSegments.length),
        angle: this.calculateAverageAngle(connectedSegments, point),
        radius: maxWidth * 0.75
      }
      this.intersections.set(intersection.id, intersection)
    }
  }

  /**
   * Handle endpoint snapping to merge nearby endpoints
   */
  private handleEndpointSnapping(segments: RoadSegment[]) {
    for (const segment of segments) {
      // Check segment start point
      for (const [id, existing] of this.segments) {
        if (existing.id === segment.id) continue

        const distStartToStart = this.distance(segment.start, existing.start)
        const distStartToEnd = this.distance(segment.start, existing.end)

        if (distStartToStart < this.SNAP_THRESHOLD) {
          segment.start = { ...existing.start }
        } else if (distStartToEnd < this.SNAP_THRESHOLD) {
          segment.start = { ...existing.end }
        }

        const distEndToStart = this.distance(segment.end, existing.start)
        const distEndToEnd = this.distance(segment.end, existing.end)

        if (distEndToStart < this.SNAP_THRESHOLD) {
          segment.end = { ...existing.start }
        } else if (distEndToEnd < this.SNAP_THRESHOLD) {
          segment.end = { ...existing.end }
        }
      }
    }
  }

  /**
   * Get intersection type based on number of connections
   */
  private getIntersectionType(connectionCount: number): Intersection['type'] {
    switch (connectionCount) {
      case 2: return 'end'
      case 3: return 'T'
      case 4: return 'cross'
      default: return 'complex'
    }
  }

  /**
   * Calculate average angle of connected segments
   */
  private calculateAverageAngle(segmentIds: number[], point: Vec2): number {
    let totalAngle = 0
    let count = 0

    for (const id of segmentIds) {
      const segment = this.segments.get(id)
      if (!segment) continue

      const distToStart = this.distance(point, segment.start)
      const angle = distToStart < this.INTERSECTION_THRESHOLD
        ? Math.atan2(segment.end.y - segment.start.y, segment.end.x - segment.start.x)
        : Math.atan2(segment.start.y - segment.end.y, segment.start.x - segment.end.x)

      totalAngle += angle
      count++
    }

    return count > 0 ? totalAngle / count : 0
  }

  /**
   * Calculate distance between two points
   */
  private distance(a: Vec2, b: Vec2): number {
    const dx = b.x - a.x
    const dy = b.y - a.y
    return Math.sqrt(dx * dx + dy * dy)
  }

  /**
   * Get all segments as an array for rendering
   */
  getSegments(): RoadSegment[] {
    return Array.from(this.segments.values())
  }

  /**
   * Get all intersections for rendering
   */
  getIntersections(): Intersection[] {
    return Array.from(this.intersections.values())
  }

  /**
   * Generate intersection geometry for rendering
   */
  generateIntersectionGeometry(intersection: Intersection): {
    vertices: Float32Array
    indices: Uint32Array
    uvs: Float32Array
  } {
    const segments: RoadSegment[] = []
    for (const segId of intersection.connectedSegments) {
      const segment = this.segments.get(segId)
      if (segment) segments.push(segment)
    }

    // Generate geometry based on intersection type
    switch (intersection.type) {
      case 'T':
        return this.generateTJunctionGeometry(intersection, segments)
      case 'cross':
        return this.generateCrossIntersectionGeometry(intersection, segments)
      case 'complex':
        return this.generateComplexIntersectionGeometry(intersection, segments)
      default:
        return this.generateSimpleIntersectionGeometry(intersection, segments)
    }
  }

  /**
   * Generate T-junction geometry
   */
  private generateTJunctionGeometry(intersection: Intersection, segments: RoadSegment[]): {
    vertices: Float32Array
    indices: Uint32Array
    uvs: Float32Array
  } {
    const vertices: number[] = []
    const indices: number[] = []
    const uvs: number[] = []

    // Create a rounded T-junction shape
    const radius = intersection.radius
    const center = intersection.position
    const segments_count = 16 // For curved corners

    // Add center vertex
    vertices.push(center.x, 0.22, center.y)
    uvs.push(0.5, 0.5)

    // Add vertices in a circle around the intersection
    for (let i = 0; i <= segments_count; i++) {
      const angle = (i / segments_count) * Math.PI * 2
      const x = center.x + Math.cos(angle) * radius
      const y = center.y + Math.sin(angle) * radius
      vertices.push(x, 0.22, y)
      uvs.push(0.5 + Math.cos(angle) * 0.5, 0.5 + Math.sin(angle) * 0.5)
    }

    // Create triangles
    for (let i = 0; i < segments_count; i++) {
      indices.push(0, i + 1, i + 2)
    }

    return {
      vertices: new Float32Array(vertices),
      indices: new Uint32Array(indices),
      uvs: new Float32Array(uvs)
    }
  }

  /**
   * Generate 4-way intersection geometry
   */
  private generateCrossIntersectionGeometry(intersection: Intersection, segments: RoadSegment[]): {
    vertices: Float32Array
    indices: Uint32Array
    uvs: Float32Array
  } {
    const vertices: number[] = []
    const indices: number[] = []
    const uvs: number[] = []

    const radius = intersection.radius
    const center = intersection.position

    // Create a square with rounded corners for 4-way intersection
    const cornerRadius = radius * 0.3
    const squareSize = radius

    // Define corner centers
    const corners = [
      { x: center.x - squareSize, y: center.y - squareSize },
      { x: center.x + squareSize, y: center.y - squareSize },
      { x: center.x + squareSize, y: center.y + squareSize },
      { x: center.x - squareSize, y: center.y + squareSize }
    ]

    let vertexIndex = 0

    // Add center vertex
    vertices.push(center.x, 0.22, center.y)
    uvs.push(0.5, 0.5)
    vertexIndex++

    // Add vertices for each corner arc
    for (let c = 0; c < 4; c++) {
      const corner = corners[c]
      const startAngle = c * Math.PI / 2
      const arcSegments = 8

      for (let i = 0; i <= arcSegments; i++) {
        const angle = startAngle + (i / arcSegments) * Math.PI / 2
        const x = corner.x + Math.cos(angle) * cornerRadius
        const y = corner.y + Math.sin(angle) * cornerRadius
        vertices.push(x, 0.22, y)
        
        const u = (x - center.x) / (radius * 2) + 0.5
        const v = (y - center.y) / (radius * 2) + 0.5
        uvs.push(u, v)
      }

      // Create triangles for this corner
      const startIdx = 1 + c * (arcSegments + 1)
      for (let i = 0; i < arcSegments; i++) {
        indices.push(0, startIdx + i, startIdx + i + 1)
      }
    }

    return {
      vertices: new Float32Array(vertices),
      indices: new Uint32Array(indices),
      uvs: new Float32Array(uvs)
    }
  }

  /**
   * Generate complex intersection geometry (5+ ways)
   */
  private generateComplexIntersectionGeometry(intersection: Intersection, segments: RoadSegment[]): {
    vertices: Float32Array
    indices: Uint32Array
    uvs: Float32Array
  } {
    // For complex intersections, create a circular roundabout-like shape
    const vertices: number[] = []
    const indices: number[] = []
    const uvs: number[] = []

    const radius = intersection.radius * 1.2 // Larger for complex intersections
    const center = intersection.position
    const segments_count = 32 // More segments for smoother circle

    // Add center vertex
    vertices.push(center.x, 0.22, center.y)
    uvs.push(0.5, 0.5)

    // Add vertices in a circle
    for (let i = 0; i <= segments_count; i++) {
      const angle = (i / segments_count) * Math.PI * 2
      const x = center.x + Math.cos(angle) * radius
      const y = center.y + Math.sin(angle) * radius
      vertices.push(x, 0.22, y)
      uvs.push(0.5 + Math.cos(angle) * 0.5, 0.5 + Math.sin(angle) * 0.5)
    }

    // Create triangles
    for (let i = 0; i < segments_count; i++) {
      indices.push(0, i + 1, i + 2)
    }

    return {
      vertices: new Float32Array(vertices),
      indices: new Uint32Array(indices),
      uvs: new Float32Array(uvs)
    }
  }

  /**
   * Generate simple intersection geometry (2-way/end connection)
   */
  private generateSimpleIntersectionGeometry(intersection: Intersection, segments: RoadSegment[]): {
    vertices: Float32Array
    indices: Uint32Array
    uvs: Float32Array
  } {
    // For simple connections, just create a small circular patch
    const vertices: number[] = []
    const indices: number[] = []
    const uvs: number[] = []

    const radius = intersection.radius * 0.5
    const center = intersection.position
    const segments_count = 12

    // Add center vertex
    vertices.push(center.x, 0.22, center.y)
    uvs.push(0.5, 0.5)

    // Add vertices in a circle
    for (let i = 0; i <= segments_count; i++) {
      const angle = (i / segments_count) * Math.PI * 2
      const x = center.x + Math.cos(angle) * radius
      const y = center.y + Math.sin(angle) * radius
      vertices.push(x, 0.22, y)
      uvs.push(0.5 + Math.cos(angle) * 0.5, 0.5 + Math.sin(angle) * 0.5)
    }

    // Create triangles
    for (let i = 0; i < segments_count; i++) {
      indices.push(0, i + 1, i + 2)
    }

    return {
      vertices: new Float32Array(vertices),
      indices: new Uint32Array(indices),
      uvs: new Float32Array(uvs)
    }
  }
}