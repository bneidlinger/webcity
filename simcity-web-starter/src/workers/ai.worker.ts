import type { AIRequest, AIResponse } from '../lib/types'

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data
  if (msg.type === 'boot') {
    // Placeholder: initialize ONNX runtime web later
  }
  if (msg.type === 'tex-request') {
    const req = msg.req as AIRequest
    // Stub response: return empty buffers to simulate KTX2
    const empty = new ArrayBuffer(8)
    const res: AIResponse = {
      lotId: req.lot.id,
      pbr: Object.fromEntries(req.materials.map(m => [m, { ktx2: empty }])),
      decals: [{ type: 'grime', ktx2: empty }],
      meta: { styleLabel: 'stub', seedUsed: req.seed, genMs: 1 }
    }
    ;(self as any).postMessage({ type: 'tex-response', res }, [empty])
  }
}
