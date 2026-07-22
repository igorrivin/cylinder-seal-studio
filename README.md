# Cylinder Seal Studio

Cylinder Seal Studio turns high-contrast raster artwork into a cylindrical relief for fabrication. Everything runs locally in the browser: the source image is never uploaded to a server.

[![CI](https://github.com/igorrivin/cylinder-seal-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/igorrivin/cylinder-seal-studio/actions/workflows/ci.yml)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Figorrivin%2Fcylinder-seal-studio)

The app can:

- threshold, soften, invert, and mirror raster artwork;
- add an optional seam band for a continuous roller edge;
- create raised or recessed relief;
- generate solid, through-bore, or open-ended shell bodies;
- preview the resulting mesh in 3D;
- keep mesh, STL, and SVG tracing work off the browser's main thread;
- export a manifold binary STL in millimetres; and
- export a smooth, compound-path SVG sized to the cylinder circumference and height in millimetres.

## Requirements

- Node.js `^20.19.0`, `^22.12.0`, or `>=24.0.0`
- npm 10 or newer

## Local development

From the repository root:

```bash
npm ci
npm run dev
```

Vite prints the local development URL, normally `http://localhost:3000`.

## Using the app

1. Drop in a raster image or load the included sample.
2. Adjust threshold, edge softness, inversion, mirroring, and the seam band.
3. Choose the relief direction and cylinder body type.
4. Enter the physical dimensions and select a mesh quality.
5. Inspect the 2D and 3D previews, then export STL or SVG.

High-contrast line art produces the cleanest relief. Mirroring is normally appropriate for a roller that must stamp the original orientation. Fabrication tolerances depend on the printer, resin or filament, and mating hardware, so test bores and wall thicknesses on your equipment before a final print.

The app rejects non-finite, out-of-range, geometrically impossible, or excessively large mesh settings instead of silently changing the requested model.

## Project checks

| Command | Purpose |
| --- | --- |
| `npm run lint` | Check TypeScript and React source with ESLint |
| `npm test` | Run the Vitest suite once |
| `npm run test:watch` | Run tests while files change |
| `npm run build` | Type-check and create a production build |
| `npm run audit` | Check production dependencies for high-severity advisories |
| `npm run check` | Run lint, tests, and the production build |
| `npm run preview` | Serve the production build locally |

GitHub Actions audits production dependencies and runs `npm run check` for pushes and pull requests.

## Production build

```bash
npm run build
```

The static site is written to `dist/`. Vite uses relative asset URLs so the directory can be hosted at a domain root or under a subdirectory.

## Deploy to Vercel

Use the deploy button near the top of this README, or import this GitHub repository from the Vercel dashboard. The committed `vercel.json` selects Vite; Vercel uses `npm run build` and serves the generated `dist/` directory. Once the Git repository is connected, pushes and pull requests can receive automatic production and preview deployments.

## Source layout

- `src/pages/Home.tsx` owns the editor state, validation feedback, lazy loading, and export actions.
- `src/lib/seal.ts` contains image processing, geometry generation, validation, and STL serialization.
- `src/lib/svg.ts` turns traced paths into dimensionally accurate, fill-only fabrication SVGs.
- `src/lib/tracing.ts` owns the vendor-neutral SVG worker protocol, validation, cancellation, and lifecycle.
- `src/lib/vector-tracer.ts` contains the narrow adapter to the VTracer WebAssembly binding.
- `src/components/ThreePreview.tsx` renders the generated mesh with Three.js.
- `src/workers/mesh.worker.ts` builds preview meshes and STL files away from the main thread.
- `src/workers/trace.worker.ts` traces processed artwork to smooth SVG paths in WebAssembly.
- `src/components/ui/` contains the small set of shadcn/Radix primitives used by the page.
- Tests under `src/lib/` cover validation, worker lifecycle, tracing topology, geometry, and serialization.

See [info.md](info.md) for implementation notes and project invariants.

## License

Cylinder Seal Studio is available under the [MIT License](LICENSE). Third-party
notices are collected in [public/THIRD_PARTY_NOTICES.md](public/THIRD_PARTY_NOTICES.md)
and included in production builds.
