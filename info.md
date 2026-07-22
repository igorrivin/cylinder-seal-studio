# Implementation notes

## Processing pipeline

1. `processImage` rasterizes the selected image to a normalized grayscale heightfield, applies thresholding and softness, and performs optional inversion, mirroring, and seam-band processing.
2. Parameter validation checks physical bounds, body-specific constraints, and the estimated mesh size before allocation.
3. A module worker runs `buildCylinderMesh`, which samples the heightfield around the cylinder and closes the selected solid, bore, or shell topology.
4. The worker transfers the resulting buffers to the Three.js preview or serializes them as binary STL without blocking the main thread.
5. A separate, short-lived worker transfers the full-resolution processed raster into a VTracer WebAssembly adapter. The resulting compound paths are normalized into a fill-only SVG with explicit physical dimensions.

The geometry functions keep fabrication units in millimetres. Angular sampling wraps at the seam, while axial sampling spans the requested cylinder height.

## Important invariants

- Invalid input must produce an actionable validation error; geometry code must not clamp it into a different requested shape.
- Mesh-size estimates must be checked before typed arrays are allocated.
- STL triangle winding must remain consistent for the outer wall, caps, bores, and shell interior.
- SVG output must declare `mm` dimensions and a matching `viewBox`.
- Tracer settings exposed in degrees must be converted to radians at the VTracer boundary.
- Trace workers must be terminated after success, failure, cancellation, or component unmount.
- Object URLs, Three.js geometries, materials, controls, renderers, and animation callbacks must be disposed when replaced or unmounted.
- Uploaded images remain in the browser and must not trigger a network request.

## Toolchain

The frontend uses React, TypeScript, Vite, Tailwind CSS, Radix UI primitives, Three.js, and a small VTracer WebAssembly binding. Vitest exercises validation, worker lifecycle, geometry, and serialization paths. ESLint checks the TypeScript and React source, and the root GitHub Actions workflow runs the complete `npm run check` command.

The Three.js preview is loaded on demand. Mesh construction and SVG tracing run in dedicated module workers. Interactive image processing uses a smaller heightfield and committed slider values; exports regenerate the design at full quality.

Dependencies are intentionally limited to packages imported by the application. Add a shadcn component with its CLI when it becomes necessary instead of restoring the full generated catalog.

## Deployment

`vite.config.ts` keeps `base: './'`, and runtime public-asset paths are derived from `import.meta.env.BASE_URL`. This allows the generated `dist/` directory to work under both root and subdirectory static hosting.

The application has no backend and stores no user artwork.
