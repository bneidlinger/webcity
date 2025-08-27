# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SimCity-style web sandbox game with procedural generation and AI-powered texture stylization. Browser-first architecture using WebWorkers for performance isolation. The main codebase is located in the `simcity-web-starter` directory.

## Build Commands

```bash
# Navigate to project directory
cd simcity-web-starter

# Install dependencies
npm install

# Development server with COOP/COEP headers for SharedArrayBuffer/WebGPU
npm run dev

# Production build
npm run build

# Preview production build
npm run preview
```

## Architecture

### Multi-Worker Threading Model
The application uses dedicated workers to keep the main thread responsive:

- **Main Thread** (`src/main.ts`): UI orchestration, worker communication, DOM interaction, mouse/keyboard input handling
- **Render Worker** (`src/workers/render.worker.ts`): WebGPU/WebGL2 rendering with OffscreenCanvas
- **Sim Worker** (`src/workers/sim.worker.ts`): Fixed-step simulation loop for game mechanics, zone development, civic buildings, demand calculations
- **ProcGen Worker** (`src/workers/procgen.worker.ts`): Procedural generation of roads, parcels, buildings using graph-based road networks
- **AI Worker** (`src/workers/ai.worker.ts`): PBR texture generation and stylization with ONNX Runtime

Workers communicate via `postMessage` with Transferables and SharedArrayBuffer where available.

### Key Data Types

Core types defined in `src/lib/types.ts`:
- `EraTag`: Time periods ('1890s' through '2030s')
- `ZoneType`: 'R'|'C'|'I' (Residential, Commercial, Industrial)
- `CityStateMeta`: City metadata including era, climate, seed
- `LotInfo`: Zone density and wealth information
- `AIRequest`/`AIResponse`: AI texture generation communication

Additional domain types in workers:
- `RoadNode`, `RoadEdge` in procgen.worker.ts: Graph-based road network
- `Zone`, `CivicBuilding` in sim.worker.ts: Simulation entities
- `DemandData`, `DesirabilityField`: Economic simulation

### Performance Targets
- WebGPU primary renderer with WebGL2 fallback
- Target 60 FPS with budgets: Render ≤ 8ms, Sim ≤ 2ms, ProcGen ≤ 2ms avg
- Memory target: 512-1024 MB cap

## Deployment Configuration

### Required Headers
For SharedArrayBuffer and WebGPU support:
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`
- `Cross-Origin-Resource-Policy: same-site`

Configured in:
- `vite.config.ts` for dev/preview servers
- `netlify.toml` and `_headers` for Netlify deployment

## Implementation Status

### Completed
- ✅ Basic worker architecture with message passing
- ✅ WebGPU/WebGL2 renderer initialization
- ✅ Fixed-step simulation loop (60 ticks/sec)
- ✅ Mouse controls for camera and tool painting
- ✅ Basic simulation types (zones, civics, demand)

### In Progress / Stubbed
- ⚠️ ProcGen worker: Road graph generation stubbed
- ⚠️ AI worker: Texture generation pipeline stubbed
- ⚠️ Sim-to-render data transfer optimizations
- ⚠️ SharedArrayBuffer implementation

## TypeScript Configuration
- Target: ES2022
- Strict mode enabled
- Worker types included (DOM + WebWorker libs)
- Module: ESNext with Bundler resolution
- No JSX (pure TypeScript)

## Dependencies
- `vite`: Build tool and dev server
- `typescript`: Type checking
- `mitt`: Event emitter for worker communication

## File Structure
```
simcity-web-starter/
├── src/
│   ├── main.ts            # Entry point, UI orchestration
│   ├── lib/
│   │   ├── types.ts       # Shared type definitions
│   │   └── utils.ts       # Shared utilities (RNG, etc.)
│   └── workers/
│       ├── render.worker.ts  # WebGPU/WebGL2 rendering
│       ├── sim.worker.ts     # Game simulation
│       ├── procgen.worker.ts # Procedural generation
│       └── ai.worker.ts      # AI texture generation
├── vite.config.ts         # Vite configuration with COOP/COEP
├── tsconfig.json          # TypeScript configuration
└── index.html             # Main HTML with canvas and HUD
```