import type { EraTag, ZoneType } from '../lib/types'

// ============================================================================
// Types and Interfaces
// ============================================================================

interface Vector2 {
  x: number
  y: number
}

interface Zone {
  id: number
  type: ZoneType
  position: Vector2
  developed: boolean
  buildingLevel: number // 0 = empty, 1-5 = building levels
  population: number
  jobs: number
  desirability: number
  lastUpgradeTime: number
  trafficGeneration: number
  pollutionGeneration: number
}

interface CivicBuilding {
  id: number
  type: CivicType
  position: Vector2
  radius: number
  strength: number
  maintenanceCost: number
}

type CivicType = 'school' | 'hospital' | 'park' | 'police' | 'fire' | 'power' | 'water'

interface DemandData {
  residential: number
  commercial: number
  industrial: number
}

interface DesirabilityField {
  width: number
  height: number
  data: Float32Array
}

interface SimulationStats {
  population: number
  jobs: number
  unemployed: number
  taxRevenue: number
  maintenanceCost: number
  happiness: number
}

// ============================================================================
// Configuration and Constants
// ============================================================================

const CONFIG = {
  // Grid dimensions for desirability fields
  FIELD_WIDTH: 128,
  FIELD_HEIGHT: 128,
  CELL_SIZE: 16, // World units per field cell
  
  // Demand calculation parameters
  DEMAND_SMOOTHING: 0.1, // Exponential moving average factor
  BASE_DEMAND_RATE: 0.01,
  MAX_DEMAND: 1.0,
  MIN_DEMAND: -0.5,
  
  // Zone balance ratios (ideal ratios)
  IDEAL_RCI_RATIO: { R: 0.5, C: 0.3, I: 0.2 },
  JOBS_PER_COMMERCIAL: 4,
  JOBS_PER_INDUSTRIAL: 8,
  PEOPLE_PER_RESIDENTIAL: 4,
  
  // Growth triggers
  SPAWN_THRESHOLD: 0.7,
  UPGRADE_THRESHOLD: 0.8,
  UPGRADE_SUSTAINED_TICKS: 60,
  ABANDON_THRESHOLD: 0.2,
  ABANDON_SUSTAINED_TICKS: 120,
  
  // Civic coverage parameters
  CIVIC_RADII: {
    school: 48,
    hospital: 64,
    park: 32,
    police: 56,
    fire: 56,
    power: 80,
    water: 80
  },
  
  CIVIC_STRENGTHS: {
    school: 0.3,
    hospital: 0.25,
    park: 0.2,
    police: 0.15,
    fire: 0.15,
    power: 0.4,
    water: 0.4
  },
  
  // Pollution and traffic
  POLLUTION_RADIUS: 48,
  POLLUTION_STRENGTH: -0.3,
  TRAFFIC_IMPACT: -0.1,
  INDUSTRIAL_POLLUTION_RATE: 0.5,
  COMMERCIAL_TRAFFIC_RATE: 0.3,
  RESIDENTIAL_TRAFFIC_RATE: 0.2,
  
  // Economic parameters
  TAX_RATE: 0.1,
  TAX_IMPACT_ON_DEMAND: -0.2
}

// ============================================================================
// Core Simulation State
// ============================================================================

class CitySimulation {
  private era: EraTag = '2010s'
  private seed = 1
  private tickCount = 0
  
  // Zone management
  private zones = new Map<number, Zone>()
  private zoneGrid: (Zone | null)[][] = []
  private nextZoneId = 1
  
  // Civic buildings
  private civicBuildings = new Map<number, CivicBuilding>()
  private nextCivicId = 1
  
  // Demand tracking - START WITH VERY HIGH DEMAND FOR TESTING
  private demand: DemandData = {
    residential: 0.9,  // Very high residential demand
    commercial: 0.7,   // High commercial demand
    industrial: 0.6    // High industrial demand
  }
  
  // Desirability fields
  private residentialDesirability: DesirabilityField
  private commercialDesirability: DesirabilityField
  private industrialDesirability: DesirabilityField
  private pollutionField: DesirabilityField
  private trafficField: DesirabilityField
  
  // Statistics
  private stats: SimulationStats = {
    population: 0,
    jobs: 0,
    unemployed: 0,
    taxRevenue: 0,
    maintenanceCost: 0,
    happiness: 0.5
  }
  
  constructor() {
    // Initialize desirability fields
    const fieldSize = CONFIG.FIELD_WIDTH * CONFIG.FIELD_HEIGHT
    this.residentialDesirability = {
      width: CONFIG.FIELD_WIDTH,
      height: CONFIG.FIELD_HEIGHT,
      data: new Float32Array(fieldSize)
    }
    this.commercialDesirability = {
      width: CONFIG.FIELD_WIDTH,
      height: CONFIG.FIELD_HEIGHT,
      data: new Float32Array(fieldSize)
    }
    this.industrialDesirability = {
      width: CONFIG.FIELD_WIDTH,
      height: CONFIG.FIELD_HEIGHT,
      data: new Float32Array(fieldSize)
    }
    this.pollutionField = {
      width: CONFIG.FIELD_WIDTH,
      height: CONFIG.FIELD_HEIGHT,
      data: new Float32Array(fieldSize)
    }
    this.trafficField = {
      width: CONFIG.FIELD_WIDTH,
      height: CONFIG.FIELD_HEIGHT,
      data: new Float32Array(fieldSize)
    }
    
    // Initialize zone grid
    this.initializeZoneGrid()
  }
  
  private initializeZoneGrid() {
    const gridWidth = Math.ceil(CONFIG.FIELD_WIDTH * CONFIG.CELL_SIZE / 16)
    const gridHeight = Math.ceil(CONFIG.FIELD_HEIGHT * CONFIG.CELL_SIZE / 16)
    this.zoneGrid = Array(gridHeight).fill(null).map(() => Array(gridWidth).fill(null))
  }
  
  // ============================================================================
  // Demand Calculation
  // ============================================================================
  
  private calculateDemand() {
    const totalPop = this.stats.population
    const totalJobs = this.stats.jobs
    const unemploymentRate = totalPop > 0 ? this.stats.unemployed / totalPop : 0
    
    // Count zones by type
    let zoneCount = { R: 0, C: 0, I: 0, residential: 0, commercial: 0, industrial: 0 }
    let developedCount = { R: 0, C: 0, I: 0, residential: 0, commercial: 0, industrial: 0 }
    
    for (const zone of this.zones.values()) {
      if (zone.type in zoneCount) {
        zoneCount[zone.type as keyof typeof zoneCount]++
        if (zone.developed) {
          developedCount[zone.type as keyof typeof developedCount]++
        }
      }
    }
    
    const totalZones = zoneCount.R + zoneCount.C + zoneCount.I + 
                       zoneCount.residential + zoneCount.commercial + zoneCount.industrial
    if (totalZones === 0) return
    
    // Calculate zone ratios (combine old and new zone types)
    const ratios = {
      R: (zoneCount.R + zoneCount.residential) / totalZones,
      C: (zoneCount.C + zoneCount.commercial) / totalZones,
      I: (zoneCount.I + zoneCount.industrial) / totalZones
    }
    
    // Residential demand based on job availability and zone balance
    let resDemand = CONFIG.BASE_DEMAND_RATE
    if (totalJobs > totalPop * 0.8) {
      resDemand += 0.3 // Need more residents for jobs
    }
    if (ratios.R < CONFIG.IDEAL_RCI_RATIO.R) {
      resDemand += 0.2 // Below ideal ratio
    }
    if (unemploymentRate > 0.1) {
      resDemand -= 0.1 // Too much unemployment
    }
    
    // Commercial demand based on population and industrial supply
    let comDemand = CONFIG.BASE_DEMAND_RATE
    if (totalPop > developedCount.C * CONFIG.JOBS_PER_COMMERCIAL * 2) {
      comDemand += 0.3 // Population needs more commercial
    }
    if (ratios.C < CONFIG.IDEAL_RCI_RATIO.C) {
      comDemand += 0.15
    }
    if (developedCount.I > developedCount.C * 1.5) {
      comDemand += 0.1 // Industrial needs commercial outlets
    }
    
    // Industrial demand based on commercial needs and employment
    let indDemand = CONFIG.BASE_DEMAND_RATE
    if (developedCount.C > developedCount.I * 2) {
      indDemand += 0.25 // Commercial needs industrial supply
    }
    if (ratios.I < CONFIG.IDEAL_RCI_RATIO.I) {
      indDemand += 0.15
    }
    if (unemploymentRate < 0.05 && totalPop > 100) {
      indDemand += 0.2 // Low unemployment, can support more industry
    }
    
    // Apply tax impact
    const taxImpact = CONFIG.TAX_RATE * CONFIG.TAX_IMPACT_ON_DEMAND
    resDemand += taxImpact
    comDemand += taxImpact * 0.5 // Commercial less sensitive
    indDemand += taxImpact * 0.3 // Industrial least sensitive
    
    // Smooth demand changes (exponential moving average)
    this.demand.residential = this.smoothDemand(this.demand.residential, resDemand)
    this.demand.commercial = this.smoothDemand(this.demand.commercial, comDemand)
    this.demand.industrial = this.smoothDemand(this.demand.industrial, indDemand)
    
    // Clamp demand values
    this.demand.residential = Math.max(CONFIG.MIN_DEMAND, Math.min(CONFIG.MAX_DEMAND, this.demand.residential))
    this.demand.commercial = Math.max(CONFIG.MIN_DEMAND, Math.min(CONFIG.MAX_DEMAND, this.demand.commercial))
    this.demand.industrial = Math.max(CONFIG.MIN_DEMAND, Math.min(CONFIG.MAX_DEMAND, this.demand.industrial))
  }
  
  private smoothDemand(current: number, target: number): number {
    return current + (target - current) * CONFIG.DEMAND_SMOOTHING
  }
  
  // ============================================================================
  // Desirability Field Calculation
  // ============================================================================
  
  private updateDesirabilityFields() {
    // Reset fields
    this.residentialDesirability.data.fill(0)
    this.commercialDesirability.data.fill(0)
    this.industrialDesirability.data.fill(0)
    this.pollutionField.data.fill(0)
    this.trafficField.data.fill(0)
    
    // Apply civic building coverage
    for (const civic of this.civicBuildings.values()) {
      this.applyCivicCoverage(civic)
    }
    
    // Apply zone-based effects (pollution, traffic)
    for (const zone of this.zones.values()) {
      if (zone.developed) {
        this.applyZoneEffects(zone)
      }
    }
    
    // Blur fields for smooth gradients
    this.blurField(this.residentialDesirability)
    this.blurField(this.commercialDesirability)
    this.blurField(this.industrialDesirability)
    this.blurField(this.pollutionField)
    this.blurField(this.trafficField)
    
    // Apply negative effects (pollution, traffic) to desirability
    this.applyNegativeEffects()
    
    // Update zone desirability values
    this.updateZoneDesirability()
  }
  
  private applyCivicCoverage(civic: CivicBuilding) {
    const gridX = Math.floor(civic.position.x / CONFIG.CELL_SIZE)
    const gridY = Math.floor(civic.position.y / CONFIG.CELL_SIZE)
    const radius = civic.radius / CONFIG.CELL_SIZE
    
    // Determine which fields to affect based on civic type
    const affectsResidential = ['school', 'hospital', 'park', 'police', 'fire', 'power', 'water'].includes(civic.type)
    const affectsCommercial = ['police', 'fire', 'power', 'water'].includes(civic.type)
    const affectsIndustrial = ['power', 'water', 'fire'].includes(civic.type)
    
    // Apply gaussian falloff
    const radiusSq = radius * radius
    for (let dy = -Math.ceil(radius); dy <= Math.ceil(radius); dy++) {
      for (let dx = -Math.ceil(radius); dx <= Math.ceil(radius); dx++) {
        const distSq = dx * dx + dy * dy
        if (distSq > radiusSq) continue
        
        const x = gridX + dx
        const y = gridY + dy
        if (x < 0 || x >= CONFIG.FIELD_WIDTH || y < 0 || y >= CONFIG.FIELD_HEIGHT) continue
        
        const idx = y * CONFIG.FIELD_WIDTH + x
        const falloff = Math.exp(-distSq / (radiusSq * 0.5)) * civic.strength
        
        if (affectsResidential) this.residentialDesirability.data[idx] += falloff
        if (affectsCommercial) this.commercialDesirability.data[idx] += falloff * 0.8
        if (affectsIndustrial) this.industrialDesirability.data[idx] += falloff * 0.6
      }
    }
  }
  
  private applyZoneEffects(zone: Zone) {
    const gridX = Math.floor(zone.position.x / CONFIG.CELL_SIZE)
    const gridY = Math.floor(zone.position.y / CONFIG.CELL_SIZE)
    
    if (gridX < 0 || gridX >= CONFIG.FIELD_WIDTH || gridY < 0 || gridY >= CONFIG.FIELD_HEIGHT) return
    
    const idx = gridY * CONFIG.FIELD_WIDTH + gridX
    
    // Industrial zones generate pollution
    if (zone.type === 'I') {
      this.pollutionField.data[idx] += zone.pollutionGeneration * zone.buildingLevel
    }
    
    // All zones generate traffic
    this.trafficField.data[idx] += zone.trafficGeneration * zone.buildingLevel
  }
  
  private blurField(field: DesirabilityField) {
    const temp = new Float32Array(field.data.length)
    const width = field.width
    const height = field.height
    
    // Simple box blur (can be optimized with separated gaussian)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0
        let count = 0
        
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx
            const ny = y + dy
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              sum += field.data[ny * width + nx]
              count++
            }
          }
        }
        
        temp[y * width + x] = sum / count
      }
    }
    
    field.data.set(temp)
  }
  
  private applyNegativeEffects() {
    for (let i = 0; i < this.residentialDesirability.data.length; i++) {
      // Residential heavily affected by pollution and traffic
      this.residentialDesirability.data[i] -= this.pollutionField.data[i] * CONFIG.POLLUTION_STRENGTH
      this.residentialDesirability.data[i] -= this.trafficField.data[i] * CONFIG.TRAFFIC_IMPACT
      
      // Commercial moderately affected by pollution, less by traffic
      this.commercialDesirability.data[i] -= this.pollutionField.data[i] * CONFIG.POLLUTION_STRENGTH * 0.5
      this.commercialDesirability.data[i] -= this.trafficField.data[i] * CONFIG.TRAFFIC_IMPACT * 0.3
      
      // Industrial barely affected
      this.industrialDesirability.data[i] -= this.pollutionField.data[i] * CONFIG.POLLUTION_STRENGTH * 0.1
      
      // Clamp to [0, 1]
      this.residentialDesirability.data[i] = Math.max(0, Math.min(1, this.residentialDesirability.data[i]))
      this.commercialDesirability.data[i] = Math.max(0, Math.min(1, this.commercialDesirability.data[i]))
      this.industrialDesirability.data[i] = Math.max(0, Math.min(1, this.industrialDesirability.data[i]))
    }
  }
  
  private updateZoneDesirability() {
    for (const zone of this.zones.values()) {
      const gridX = Math.floor(zone.position.x / CONFIG.CELL_SIZE)
      const gridY = Math.floor(zone.position.y / CONFIG.CELL_SIZE)
      
      if (gridX < 0 || gridX >= CONFIG.FIELD_WIDTH || gridY < 0 || gridY >= CONFIG.FIELD_HEIGHT) continue
      
      const idx = gridY * CONFIG.FIELD_WIDTH + gridX
      
      switch (zone.type) {
        case 'R':
          zone.desirability = this.residentialDesirability.data[idx]
          break
        case 'C':
          zone.desirability = this.commercialDesirability.data[idx]
          break
        case 'I':
          zone.desirability = this.industrialDesirability.data[idx]
          break
      }
    }
  }
  
  // ============================================================================
  // Growth Triggers
  // ============================================================================
  
  private processGrowthTriggers() {
    const currentTick = this.tickCount
    
    // Log total zones periodically
    if (this.tickCount % 180 === 0) {
      console.log(`[Sim] processGrowthTriggers: Checking ${this.zones.size} zones at tick ${this.tickCount}`)
      console.log(`[Sim] Current demand - R: ${this.demand.residential.toFixed(2)}, C: ${this.demand.commercial.toFixed(2)}, I: ${this.demand.industrial.toFixed(2)}`)
    }
    
    for (const zone of this.zones.values()) {
      // FORCE SPAWN: Always spawn if not developed
      if (!zone.developed) {
        console.log(`[Sim] FORCE SPAWNING building in zone ${zone.id}!`)
        this.spawnBuilding(zone)
      }
      
      // Check for upgrades
      if (zone.developed && zone.buildingLevel < 5) {
        if (zone.desirability > CONFIG.UPGRADE_THRESHOLD) {
          const ticksSinceUpgrade = currentTick - zone.lastUpgradeTime
          if (ticksSinceUpgrade > CONFIG.UPGRADE_SUSTAINED_TICKS) {
            this.upgradeBuilding(zone)
          }
        }
      }
      
      // DISABLED: Abandonment for debugging
      // Buildings should never be abandoned during testing
      /*
      if (zone.developed && zone.desirability < CONFIG.ABANDON_THRESHOLD) {
        const ticksSinceUpgrade = currentTick - zone.lastUpgradeTime
        if (ticksSinceUpgrade > CONFIG.ABANDON_SUSTAINED_TICKS) {
          this.abandonBuilding(zone)
        }
      }
      */
    }
  }
  
  private shouldSpawnBuilding(zone: Zone): boolean {
    let demandThreshold = 0
    
    switch (zone.type) {
      case 'R':
        demandThreshold = this.demand.residential
        break
      case 'C':
        demandThreshold = this.demand.commercial
        break
      case 'I':
        demandThreshold = this.demand.industrial
        break
    }
    
    // VERY permissive spawning for debugging
    const highDemand = demandThreshold > 0.3  // Very low threshold
    const goodDesirability = zone.desirability > 0.1  // Almost any desirability
    
    // For debugging: spawn if ANY positive demand exists
    const shouldSpawn = demandThreshold > 0.01 || zone.desirability > 0.01
    
    if (this.tickCount % 300 === 0 && !zone.developed) {
      console.log(`[Sim] Zone ${zone.id} detailed check:`, {
        type: zone.type,
        demand: demandThreshold,
        desirability: zone.desirability,
        shouldSpawn,
        position: zone.position
      })
    }
    
    return shouldSpawn
  }
  
  private spawnBuilding(zone: Zone) {
    zone.developed = true
    zone.buildingLevel = 1
    zone.lastUpgradeTime = this.tickCount
    
    // Set initial population/jobs based on type
    switch (zone.type) {
      case 'R':
        zone.population = CONFIG.PEOPLE_PER_RESIDENTIAL
        zone.trafficGeneration = CONFIG.RESIDENTIAL_TRAFFIC_RATE
        break
      case 'C':
        zone.jobs = CONFIG.JOBS_PER_COMMERCIAL
        zone.trafficGeneration = CONFIG.COMMERCIAL_TRAFFIC_RATE
        break
      case 'I':
        zone.jobs = CONFIG.JOBS_PER_INDUSTRIAL
        zone.pollutionGeneration = CONFIG.INDUSTRIAL_POLLUTION_RATE
        zone.trafficGeneration = CONFIG.RESIDENTIAL_TRAFFIC_RATE
        break
    }
    
    this.updateStatistics()
    this.sendGrowthEvent('spawn', zone)
  }
  
  private upgradeBuilding(zone: Zone) {
    zone.buildingLevel++
    zone.lastUpgradeTime = this.tickCount
    
    // Increase capacity with level
    const multiplier = 1 + zone.buildingLevel * 0.5
    
    switch (zone.type) {
      case 'R':
        zone.population = Math.floor(CONFIG.PEOPLE_PER_RESIDENTIAL * multiplier)
        break
      case 'C':
        zone.jobs = Math.floor(CONFIG.JOBS_PER_COMMERCIAL * multiplier)
        break
      case 'I':
        zone.jobs = Math.floor(CONFIG.JOBS_PER_INDUSTRIAL * multiplier)
        zone.pollutionGeneration = CONFIG.INDUSTRIAL_POLLUTION_RATE * (1 + zone.buildingLevel * 0.3)
        break
    }
    
    zone.trafficGeneration *= 1.2
    
    this.updateStatistics()
    this.sendGrowthEvent('upgrade', zone)
  }
  
  private abandonBuilding(zone: Zone) {
    zone.developed = false
    zone.buildingLevel = 0
    zone.population = 0
    zone.jobs = 0
    zone.pollutionGeneration = 0
    zone.trafficGeneration = 0
    zone.lastUpgradeTime = this.tickCount
    
    this.updateStatistics()
    this.sendGrowthEvent('abandon', zone)
  }
  
  // ============================================================================
  // Statistics and Economy
  // ============================================================================
  
  private updateStatistics() {
    let totalPop = 0
    let totalJobs = 0
    let totalRevenue = 0
    
    for (const zone of this.zones.values()) {
      totalPop += zone.population
      totalJobs += zone.jobs
      
      if (zone.developed) {
        // Simple tax calculation
        totalRevenue += zone.population * CONFIG.TAX_RATE * 10
        totalRevenue += zone.jobs * CONFIG.TAX_RATE * 15
      }
    }
    
    // Calculate maintenance costs
    let totalMaintenance = 0
    for (const civic of this.civicBuildings.values()) {
      totalMaintenance += civic.maintenanceCost
    }
    
    this.stats.population = totalPop
    this.stats.jobs = totalJobs
    this.stats.unemployed = Math.max(0, totalPop - totalJobs)
    this.stats.taxRevenue = totalRevenue
    this.stats.maintenanceCost = totalMaintenance
    
    // Calculate happiness based on employment and services
    const employmentRate = totalPop > 0 ? Math.min(1, totalJobs / totalPop) : 0.5
    const serviceQuality = this.calculateAverageServiceQuality()
    this.stats.happiness = (employmentRate * 0.6 + serviceQuality * 0.4)
  }
  
  private calculateAverageServiceQuality(): number {
    if (this.zones.size === 0) return 0.5
    
    let totalQuality = 0
    let count = 0
    
    for (const zone of this.zones.values()) {
      if (zone.type === 'R' && zone.developed) {
        totalQuality += zone.desirability
        count++
      }
    }
    
    return count > 0 ? totalQuality / count : 0.5
  }
  
  // ============================================================================
  // Message Handling
  // ============================================================================
  
  public handleMessage(msg: any) {
    switch (msg.type) {
      case 'set-era':
        this.era = msg.era
        break
        
      case 'boot':
        this.seed = msg.seed ?? this.seed
        break
        
      case 'update-zones':
        this.updateZonesFromProcgen(msg.zones)
        break
        
      case 'add-zone':
        // Add a new zone from painting
        console.log('[Sim] Received add-zone message:', msg)
        if (msg.zone) {
          // Validate zone data
          if (!msg.zone.id && msg.zone.id !== 0) {
            console.error('[Sim] Zone missing ID!', msg.zone)
            return
          }
          if (!msg.zone.type) {
            console.error('[Sim] Zone missing type!', msg.zone)
            return
          }
          if (!msg.zone.position) {
            console.error('[Sim] Zone missing position!', msg.zone)
            return
          }
          
          const zone: Zone = {
            id: msg.zone.id,
            type: msg.zone.type as ZoneType,
            position: msg.zone.position,
            developed: false,
            buildingLevel: 0,
            population: 0,
            jobs: 0,
            desirability: 0.8, // HIGH initial desirability for guaranteed spawning
            lastUpgradeTime: 0,
            trafficGeneration: 0,
            pollutionGeneration: 0
          }
          this.zones.set(zone.id, zone)
          console.log('[Sim] Added zone', zone.id, 'type:', zone.type, 'at', zone.position, 'Total zones:', this.zones.size)
          console.log('[Sim] Current demand - R:', this.demand.residential, 'C:', this.demand.commercial, 'I:', this.demand.industrial)
          
          // FORCE IMMEDIATE SPAWN FOR DEBUGGING
          console.log('[Sim] FORCING immediate spawn for debugging!')
          // Always spawn, even if already developed (for testing)
          console.log('[Sim] Spawning building immediately for zone', zone.id)
          this.spawnBuilding(zone)
        } else {
          console.error('[Sim] No zone data in message!')
        }
        break
        
      case 'get-demand':
        self.postMessage({
          type: 'demand-data',
          demand: { ...this.demand }
        })
        break
        
      case 'get-desirability':
        self.postMessage({
          type: 'desirability-data',
          residential: this.getFieldData(this.residentialDesirability),
          commercial: this.getFieldData(this.commercialDesirability),
          industrial: this.getFieldData(this.industrialDesirability),
          pollution: this.getFieldData(this.pollutionField),
          traffic: this.getFieldData(this.trafficField)
        })
        break
        
      case 'place-civic':
        this.placeCivicBuilding(msg.civic)
        break
        
      case 'get-stats':
        self.postMessage({
          type: 'stats-data',
          stats: { ...this.stats }
        })
        break
    }
  }
  
  private updateZonesFromProcgen(zonesData: any[]) {
    // Clear existing zones
    this.zones.clear()
    
    // Add new zones
    for (const zoneData of zonesData) {
      const zone: Zone = {
        id: this.nextZoneId++,
        type: zoneData.type,
        position: zoneData.position,
        developed: false,
        buildingLevel: 0,
        population: 0,
        jobs: 0,
        desirability: 0,
        lastUpgradeTime: 0,
        trafficGeneration: 0,
        pollutionGeneration: 0
      }
      
      this.zones.set(zone.id, zone)
      
      // Update grid
      const gridX = Math.floor(zone.position.x / 16)
      const gridY = Math.floor(zone.position.y / 16)
      if (gridX >= 0 && gridX < this.zoneGrid[0].length && 
          gridY >= 0 && gridY < this.zoneGrid.length) {
        this.zoneGrid[gridY][gridX] = zone
      }
    }
  }
  
  private placeCivicBuilding(civicData: any) {
    const civic: CivicBuilding = {
      id: this.nextCivicId++,
      type: civicData.type,
      position: civicData.position,
      radius: CONFIG.CIVIC_RADII[civicData.type as CivicType],
      strength: CONFIG.CIVIC_STRENGTHS[civicData.type as CivicType],
      maintenanceCost: civicData.maintenanceCost ?? 100
    }
    
    this.civicBuildings.set(civic.id, civic)
    
    // Immediate desirability update
    this.updateDesirabilityFields()
    
    self.postMessage({
      type: 'civic-placed',
      civicId: civic.id
    })
  }
  
  private getFieldData(field: DesirabilityField): ArrayBuffer {
    // Return a copy of the field data as ArrayBuffer for transfer
    const buffer = field.data.buffer
    if (buffer instanceof SharedArrayBuffer) {
      // Convert SharedArrayBuffer to ArrayBuffer
      const copy = new ArrayBuffer(buffer.byteLength)
      new Uint8Array(copy).set(new Uint8Array(buffer))
      return copy
    }
    return buffer.slice(0)
  }
  
  private sendGrowthEvent(eventType: 'spawn' | 'upgrade' | 'abandon', zone: Zone) {
    console.log(`[Sim] sendGrowthEvent: ${eventType} for zone ${zone.id} at position`, zone.position)
    
    // Determine density based on building level
    const density = zone.buildingLevel <= 2 ? 'low' : 
                   zone.buildingLevel <= 4 ? 'medium' : 'high'
    
    self.postMessage({
      type: 'growth-event',
      event: eventType,
      zoneId: zone.id,
      zoneType: zone.type,
      position: zone.position,
      level: zone.buildingLevel,
      density: density
    })
    
    // Request building mesh generation for spawns and upgrades
    if (eventType === 'spawn' || eventType === 'upgrade') {
      console.log(`[Sim] Requesting building generation for zone ${zone.id}`)
      self.postMessage({
        type: 'generate-building',
        zoneId: zone.id,
        zoneType: zone.type === 'R' ? 'residential' : 
                  zone.type === 'C' ? 'commercial' : 'industrial',
        zoneDensity: density,
        buildingLevel: zone.buildingLevel,
        position: zone.position
      })
    }
  }
  
  // ============================================================================
  // Main Simulation Tick
  // ============================================================================
  
  public tick(dt: number) {
    this.tickCount++
    
    // Log tick periodically to ensure simulation is running
    if (this.tickCount % 300 === 0) { // Every 5 seconds
      console.log(`[Sim] Simulation tick ${this.tickCount}, zones: ${this.zones.size}, developed: ${Array.from(this.zones.values()).filter(z => z.developed).length}`)
    }
    
    // Update different systems at different rates for performance
    if (this.tickCount % 6 === 0) { // Every 100ms (6 ticks at 60fps)
      this.calculateDemand()
    }
    
    if (this.tickCount % 12 === 0) { // Every 200ms
      this.updateDesirabilityFields()
    }
    
    if (this.tickCount % 30 === 0) { // Every 500ms
      this.processGrowthTriggers()
    }
    
    if (this.tickCount % 60 === 0) { // Every second
      this.updateStatistics()
      // Send periodic updates to main thread
      self.postMessage({
        type: 'demand-data',
        demand: { ...this.demand }
      })
      self.postMessage({
        type: 'stats-data',
        stats: { ...this.stats }
      })
    }
  }
}

// ============================================================================
// Worker Setup
// ============================================================================

const simulation = new CitySimulation()

// Fixed-step simulation loop (60 ticks per second)
let accum = 0
let last = performance.now()

function tick(dt: number) {
  simulation.tick(dt)
}

function loop() {
  const now = performance.now()
  let delta = (now - last)
  last = now
  accum += delta
  
  // Process multiple ticks if we're behind
  while (accum >= 16.6667) {
    tick(16.6667)
    accum -= 16.6667
  }
  
  ;(self as any).requestAnimationFrame(loop)
}

// Start the simulation loop
loop()

// Handle incoming messages
self.onmessage = (e: MessageEvent) => {
  simulation.handleMessage(e.data)
}
