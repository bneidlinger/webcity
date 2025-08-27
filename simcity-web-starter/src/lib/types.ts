export type EraTag = '1890s'|'1910s'|'1930s'|'1950s'|'1970s'|'1990s'|'2010s'|'2030s'
export type ZoneType = 'R'|'C'|'I'|'residential'|'commercial'|'industrial'

export interface CityStateMeta {
  cityId: string
  era: EraTag
  climate: 'temperate'|'arid'|'tropical'|'cold'
  seed: number
}

export interface LotInfo {
  id: number
  zone: ZoneType
  density: 0|1|2|3
  wealth: 0|1|2
}

export interface AIRequest {
  cityId: string
  era: EraTag
  climate: 'temperate'|'arid'|'tropical'|'cold'
  seed: number
  lot: LotInfo
  materials: Array<'facade'|'window'|'roof'|'ground'|'street'|'sidewalk'>
  maps: { uv0: ArrayBuffer, normal?: ArrayBuffer, ao?: ArrayBuffer, curvature?: ArrayBuffer }
  context: { neighbors: string[], traffic: number, pollution: number }
}

export interface AIResponse {
  lotId: number
  pbr: Record<string, { ktx2: ArrayBuffer }>
  decals: Array<{ type: 'grime'|'poster'|'crack', ktx2: ArrayBuffer }>
  meta: { styleLabel: string, seedUsed: number, genMs: number }
}
