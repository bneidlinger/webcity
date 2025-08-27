# SimCity Web Prototype Starter

Browser-first skeleton for a SimCity-style sandbox with:
- **Render Worker** (OffscreenCanvas, WebGPU → WebGL2 fallback)
- **Sim Worker** (fixed-step loop)
- **ProcGen Worker** (roads/parcels/buildings — stubbed)
- **AI Worker** (PBR texture generation — stubbed)

## Quick Start

```bash
pnpm i   # or npm i / yarn
pnpm dev # or npm run dev
```

Vite dev server sends required headers for **COOP/COEP** so SharedArrayBuffer/WebGPU work locally.

## Deploy
- For Netlify, `_headers` or `netlify.toml` included with:
  - Cross-Origin-Opener-Policy: same-origin
  - Cross-Origin-Embedder-Policy: require-corp
  - Cross-Origin-Resource-Policy: same-site

On static hosts that support custom headers, configure the same.

## Next Steps
- Implement road graph + parcel split in `procgen.worker.ts`
- Move sim data via `postMessage` with Transferables/SharedArrayBuffer
- Integrate ONNX Runtime Web in `ai.worker.ts` (WebGPU backend)
- Add KTX2 encoder/decoder pipeline (BasisU/ktx2)

— Generated 2025-08-12
