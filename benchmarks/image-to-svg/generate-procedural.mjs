#!/usr/bin/env node

/**
 * Deterministically generates the benchmark's self-authored vector references.
 *
 * The files deliberately use only basic SVG geometry. They are intended to be
 * rasterized into model inputs while the original vectors remain exact,
 * rights-cleared ground truth.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const sourceDirectory = join(root, "sources", "procedural");
const fragmentPath = join(root, "fragments", "procedural.jsonl");
const checkMode = process.argv.includes("--check");

const writeOrCheck = async (path, content) => {
  if (checkMode) {
    const current = await readFile(path, "utf8");
    if (current !== content) {
      throw new Error(`${path} is stale; run npm run benchmark:corpus:build.`);
    }
    return;
  }
  await writeFile(path, content, "utf8");
};

const escapeXml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const points = (pairs) => pairs.map(([x, y]) => `${x},${y}`).join(" ");

const starPoints = (cx, cy, outerRadius, innerRadius, count = 5, rotation = -Math.PI / 2) => {
  const result = [];
  for (let index = 0; index < count * 2; index += 1) {
    const radius = index % 2 === 0 ? outerRadius : innerRadius;
    const angle = rotation + (index * Math.PI) / count;
    result.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]);
  }
  return points(result);
};

const rosette = (cx, cy, radius) => {
  const petals = Array.from({ length: 8 }, (_, index) => {
    const angle = (index * Math.PI) / 4;
    const x = cx + Math.cos(angle) * radius * 0.56;
    const y = cy + Math.sin(angle) * radius * 0.56;
    const degrees = index * 45;
    return `<ellipse cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" rx="${(
      radius * 0.25
    ).toFixed(2)}" ry="${(radius * 0.48).toFixed(2)}" transform="rotate(${degrees + 90} ${x.toFixed(
      2,
    )} ${y.toFixed(2)})"/>`;
  }).join("\n");
  return `<g fill="none" stroke="#111" stroke-width="6">${petals}<circle cx="${cx}" cy="${cy}" r="${(
    radius * 0.18
  ).toFixed(2)}" fill="#111" stroke="none"/></g>`;
};

const wedge = (x, y, rotation = 0, scale = 1) =>
  `<path d="M ${x} ${y} l ${28 * scale} ${-7 * scale} l ${-20 * scale} ${16 * scale} z" ` +
  `fill="#111" transform="rotate(${rotation} ${x} ${y})"/>`;

const makeSvg = ({ id, title, description, art, transparent = false }) => {
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const background = transparent ? "" : '<rect width="512" height="512" fill="#fff"/>';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-labelledby="${titleId} ${descriptionId}">
  <title id="${titleId}">${escapeXml(title)}</title>
  <desc id="${descriptionId}">${escapeXml(description)}</desc>
  ${background}
  ${art.trim()}
</svg>
`;
};

const cases = [
  {
    id: "procedural-001-crescent-star",
    title: "Crescent and eight-pointed star",
    description: "A bold crescent silhouette facing an eight-pointed star.",
    tags: ["icon", "silhouette", "celestial", "filled", "symmetry"],
    splitSuggestion: "development",
    transparent: true,
    art: `<path d="M 297 88 A 180 180 0 1 0 297 424 A 145 145 0 0 1 297 88 Z" fill="#111"/>
<polygon points="${starPoints(362, 256, 61, 25, 8)}" fill="#111"/>`,
  },
  {
    id: "procedural-002-amphora",
    title: "Symmetric amphora",
    description: "An outlined two-handled amphora with neck, shoulder, and geometric bands.",
    tags: ["icon", "vessel", "symmetry", "outline", "ancient"],
    splitSuggestion: "development",
    art: `<g fill="none" stroke="#111" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">
  <path d="M 211 74 H 301 L 291 112 H 221 Z"/>
  <path d="M 225 112 V 151 C 225 170 201 184 180 207 C 150 240 159 303 181 352 C 194 381 202 402 197 431 H 315 C 310 402 318 381 331 352 C 353 303 362 240 332 207 C 311 184 287 170 287 151 V 112"/>
  <path d="M 193 196 C 123 184 119 288 173 303 M 319 196 C 389 184 393 288 339 303"/>
  <path d="M 181 248 H 331 M 174 282 H 338 M 194 369 H 318"/>
  <path d="M 203 264 L 225 282 L 247 264 L 269 282 L 291 264 L 313 282" stroke-width="7"/>
</g>`,
  },
  {
    id: "procedural-003-flying-bird",
    title: "Bird in flight",
    description: "A sweeping filled bird silhouette with a small incised wing detail.",
    tags: ["icon", "animal", "bird", "silhouette", "organic"],
    splitSuggestion: "development",
    transparent: true,
    art: `<path d="M 52 280 C 123 226 167 217 218 228 C 185 191 174 148 181 91 C 232 142 258 184 272 225 C 311 190 362 172 452 179 C 404 208 376 237 351 270 C 382 276 415 293 448 329 C 369 329 311 312 267 281 C 224 323 155 350 64 353 C 104 324 129 304 145 282 C 117 278 86 278 52 280 Z" fill="#111"/>
<path d="M 225 242 C 252 229 281 228 314 236" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round"/>`,
  },
  {
    id: "procedural-004-mountain-sun",
    title: "Mountain sunrise",
    description: "Layered mountain ridges, a rising sun, and short radiating rays.",
    tags: ["icon", "landscape", "mountain", "sun", "outline"],
    splitSuggestion: "development",
    art: `<g fill="none" stroke="#111" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">
  <path d="M 51 393 L 186 198 L 251 286 L 315 163 L 462 393 Z"/>
  <path d="M 140 264 L 186 198 L 222 247 L 250 216 L 278 236 L 315 163 L 357 222"/>
  <path d="M 116 393 C 154 349 199 345 239 375 C 286 321 352 319 413 393"/>
  <path d="M 98 184 A 72 72 0 0 1 234 166"/>
  <path d="M 82 133 L 58 116 M 111 94 L 103 64 M 156 82 V 48 M 201 95 L 212 65 M 232 125 L 258 106" stroke-width="7"/>
</g>`,
  },
  {
    id: "procedural-005-fish",
    title: "Patterned fish",
    description: "A fish outline with a triangular tail, circular eye, scales, and fin marks.",
    tags: ["icon", "animal", "fish", "outline", "internal-detail"],
    splitSuggestion: "development",
    art: `<g fill="none" stroke="#111" stroke-width="9" stroke-linecap="round" stroke-linejoin="round">
  <path d="M 75 257 C 145 161 302 163 380 257 C 302 351 145 353 75 257 Z"/>
  <path d="M 380 257 L 459 182 L 445 257 L 459 332 Z"/>
  <circle cx="137" cy="238" r="12" fill="#111"/>
  <path d="M 183 201 Q 208 224 183 247 Q 208 270 183 293 M 226 188 Q 253 216 226 244 Q 253 272 226 318 M 273 190 Q 299 217 273 244 Q 299 271 273 316 M 317 207 Q 340 232 317 257 Q 340 282 317 307" stroke-width="6"/>
  <path d="M 245 179 L 275 129 L 304 190 M 242 333 L 274 382 L 302 322"/>
</g>`,
  },
  {
    id: "procedural-006-ceremonial-key",
    title: "Ceremonial key",
    description: "An ornate diagonal key with a quatrefoil bow and stepped teeth.",
    tags: ["icon", "object", "key", "geometric", "outline"],
    splitSuggestion: "development",
    art: `<g transform="rotate(-38 256 256)" fill="none" stroke="#111" stroke-linejoin="round">
  <circle cx="151" cy="256" r="72" stroke-width="13"/>
  <path d="M 151 184 C 176 209 176 235 151 256 C 126 235 126 209 151 184 Z M 151 328 C 176 303 176 277 151 256 C 126 277 126 303 151 328 Z" stroke-width="8"/>
  <path d="M 218 256 H 423 V 292 H 387 V 328 H 350 V 292 H 314 V 256" stroke-width="14"/>
  <path d="M 238 235 V 277 M 276 235 V 277" stroke-width="7"/>
</g>`,
  },
  {
    id: "procedural-007-leaf-sprig",
    title: "Curving leaf sprig",
    description: "A curved botanical stem carrying alternating almond-shaped leaves and berries.",
    tags: ["icon", "botanical", "leaf", "organic", "mixed-fill-stroke"],
    splitSuggestion: "validation",
    transparent: true,
    art: `<path d="M 110 420 C 135 327 189 236 366 103" fill="none" stroke="#111" stroke-width="11" stroke-linecap="round"/>
<g fill="#111">
  <path d="M 157 335 C 98 322 81 282 89 245 C 137 257 168 284 157 335 Z"/>
  <path d="M 190 282 C 184 223 215 191 253 181 C 258 228 239 266 190 282 Z"/>
  <path d="M 236 229 C 180 211 168 169 182 135 C 226 153 251 184 236 229 Z"/>
  <path d="M 284 184 C 281 128 313 96 352 89 C 353 135 332 171 284 184 Z"/>
  <path d="M 126 382 C 83 377 59 351 60 317 C 99 320 129 341 126 382 Z"/>
  <circle cx="324" cy="140" r="13"/><circle cx="373" cy="97" r="13"/><circle cx="142" cy="347" r="12"/>
</g>`,
  },
  {
    id: "procedural-008-scarab",
    title: "Geometric scarab",
    description: "A bilaterally symmetric scarab with segmented body, legs, and horn-like antennae.",
    tags: ["icon", "animal", "scarab", "symmetry", "ancient"],
    splitSuggestion: "test",
    art: `<g fill="none" stroke="#111" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">
  <ellipse cx="256" cy="273" rx="92" ry="125"/>
  <path d="M 256 151 V 398 M 179 215 H 333 M 168 280 H 344 M 187 348 H 325" stroke-width="7"/>
  <path d="M 215 157 C 208 104 229 75 256 63 C 283 75 304 104 297 157"/>
  <path d="M 195 193 L 130 144 L 91 157 M 175 258 L 107 243 L 72 273 M 177 324 L 120 356 L 102 397"/>
  <path d="M 317 193 L 382 144 L 421 157 M 337 258 L 405 243 L 440 273 M 335 324 L 392 356 L 410 397"/>
  <path d="M 229 73 L 198 51 M 283 73 L 314 51"/>
</g>`,
  },
  {
    id: "procedural-009-tea-table",
    title: "Tea table still life",
    description: "A loose line drawing of a teapot, cup, vase, flower, and small table.",
    tags: ["scene", "still-life", "multi-object", "freehand", "domestic"],
    splitSuggestion: "development",
    art: `<g fill="none" stroke="#111" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M 54 363 Q 256 348 458 363 M 92 364 L 76 455 M 419 364 L 438 455"/>
  <path d="M 139 331 C 117 297 122 242 159 218 C 195 195 257 207 275 248 C 292 288 267 329 234 337 Z"/>
  <path d="M 144 239 C 108 215 80 240 89 275 C 95 297 115 306 136 297 M 272 252 C 307 241 322 261 303 276 L 277 296"/>
  <path d="M 164 211 Q 199 183 235 211 M 189 190 V 171 H 216 V 190"/>
  <path d="M 318 313 V 263 H 382 V 313 C 382 334 318 334 318 313 Z M 382 277 C 417 269 417 310 384 306"/>
  <path d="M 389 350 C 378 316 383 260 397 231 C 410 256 417 313 405 350 Z"/>
  <path d="M 397 232 C 375 206 362 177 374 150 M 397 232 C 414 201 439 181 455 176"/>
  <path d="M 374 150 C 347 151 340 123 360 112 C 374 94 399 112 393 133 C 392 149 385 154 374 150 Z"/>
</g>`,
  },
  {
    id: "procedural-010-river-boat",
    title: "River boat scene",
    description: "A small sailboat among layered waves beneath a sun and three distant birds.",
    tags: ["scene", "boat", "water", "multi-object", "freehand"],
    splitSuggestion: "development",
    art: `<g fill="none" stroke="#111" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="389" cy="112" r="49"/>
  <path d="M 221 101 V 327 M 223 120 L 348 272 H 224 Z M 210 150 L 126 271 H 210 Z"/>
  <path d="M 92 294 H 380 L 345 358 H 130 Z"/>
  <path d="M -24 382 Q 24 345 72 382 T 168 382 T 264 382 T 360 382 T 456 382 T 552 382"/>
  <path d="M -24 429 Q 24 392 72 429 T 168 429 T 264 429 T 360 429 T 456 429 T 552 429"/>
  <path d="M 61 137 Q 78 119 95 137 Q 112 119 129 137 M 169 76 Q 185 60 201 76 Q 217 60 233 76 M 297 79 Q 311 65 325 79 Q 339 65 353 79" stroke-width="6"/>
</g>`,
  },
  {
    id: "procedural-011-night-camp",
    title: "Night camp",
    description: "A tent, pine tree, campfire, crescent moon, and stones in a compact outdoor scene.",
    tags: ["scene", "camp", "landscape", "multi-object", "mixed-detail"],
    splitSuggestion: "validation",
    art: `<g fill="none" stroke="#111" stroke-width="9" stroke-linecap="round" stroke-linejoin="round">
  <path d="M 132 394 L 256 168 L 380 394 Z M 256 168 L 278 394 M 256 278 L 192 394"/>
  <path d="M 80 380 V 179 M 80 179 L 20 263 H 54 L 11 324 H 55 L 16 377 H 143 L 107 324 H 146 L 105 263 H 137 Z"/>
  <path d="M 375 403 C 338 371 363 337 393 304 C 398 338 421 349 421 376 C 421 402 399 416 375 403 Z"/>
  <path d="M 392 403 C 374 386 385 368 397 352 C 399 375 410 383 392 403 Z" fill="#111"/>
  <path d="M 328 419 Q 393 438 454 418 M 346 420 L 326 438 M 436 420 L 457 438"/>
  <path d="M 384 72 A 60 60 0 1 0 445 155 A 48 48 0 0 1 384 72 Z" fill="#111" stroke="none"/>
  <circle cx="282" cy="84" r="6" fill="#111" stroke="none"/><circle cx="328" cy="127" r="7" fill="#111" stroke="none"/>
</g>`,
  },
  {
    id: "procedural-012-garden-tools",
    title: "Garden tools and seedling",
    description: "A watering can, hand trowel, and three-leaf seedling drawn as a small vignette.",
    tags: ["scene", "garden", "tools", "multi-object", "outline"],
    splitSuggestion: "development",
    art: `<g fill="none" stroke="#111" stroke-width="9" stroke-linecap="round" stroke-linejoin="round">
  <path d="M 72 342 V 236 H 221 V 342 C 221 370 72 370 72 342 Z"/>
  <path d="M 78 251 C 28 224 22 317 70 316 M 218 257 L 315 198 L 332 220 L 222 303 M 312 198 Q 343 180 367 187"/>
  <path d="M 118 234 V 197 H 178 V 234 M 132 196 Q 148 170 165 196"/>
  <path d="M 392 89 L 345 292 M 377 94 L 414 103 L 405 129 L 369 120 Z M 345 292 C 306 306 302 358 328 391 C 371 372 387 334 345 292 Z"/>
  <path d="M 257 411 C 262 359 267 309 278 268 M 278 310 C 233 296 214 267 222 239 C 257 242 280 266 278 310 Z M 272 352 C 316 335 340 305 333 275 C 299 281 275 308 272 352 Z"/>
  <path d="M 45 411 Q 256 394 467 411"/>
</g>`,
  },
  {
    id: "procedural-013-fox-and-moon",
    title: "Fox beneath the moon",
    description: "A stylized seated fox with a curled tail, ground tufts, stars, and a full moon.",
    tags: ["scene", "animal", "fox", "night", "organic"],
    splitSuggestion: "development",
    art: `<g fill="none" stroke="#111" stroke-width="9" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="386" cy="118" r="66"/>
  <path d="M 201 183 L 152 111 L 229 143 L 299 111 L 278 190 C 318 233 315 314 279 354 C 333 344 367 365 360 407 C 312 430 255 414 225 385 C 185 430 110 430 70 395 C 112 393 131 376 145 348 C 118 290 135 222 201 183 Z"/>
  <path d="M 181 212 Q 203 230 225 212 M 249 212 Q 268 228 287 210 M 220 244 L 238 244 L 229 258 Z" fill="#111"/>
  <path d="M 163 301 C 203 327 247 324 288 299 M 225 385 C 214 347 220 317 236 295"/>
  <path d="M 66 404 L 50 374 M 88 403 L 95 370 M 383 408 L 373 378 M 406 407 L 421 380"/>
  <circle cx="72" cy="111" r="6" fill="#111" stroke="none"/><circle cx="333" cy="69" r="6" fill="#111" stroke="none"/><circle cx="448" cy="205" r="7" fill="#111" stroke="none"/>
</g>`,
  },
  {
    id: "procedural-014-workshop-tools",
    title: "Workshop tools",
    description: "A crossed hammer and chisel above a hand saw and coiled measuring cord.",
    tags: ["scene", "tools", "multi-object", "geometric", "overlap"],
    splitSuggestion: "test",
    art: `<g fill="none" stroke="#111" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">
  <g transform="rotate(38 214 221)"><path d="M 199 105 H 245 V 361 H 199 Z"/><path d="M 140 68 H 304 V 132 H 140 Z" fill="#111"/></g>
  <g transform="rotate(-43 293 225)"><path d="M 280 91 H 311 L 321 346 L 270 346 Z"/><path d="M 270 346 L 295 401 L 321 346"/></g>
  <path d="M 49 409 L 443 321 L 456 377 L 63 465 Z"/>
  <path d="M 89 401 L 109 426 L 129 392 L 149 417 L 169 383 L 189 408 L 209 374 L 229 399 L 249 365 L 269 390 L 289 356 L 309 381 L 329 347 L 349 372 L 369 338" stroke-width="7"/>
  <path d="M 366 167 C 421 132 463 174 449 222 C 436 266 379 274 353 236 C 329 201 350 171 379 181 C 402 190 398 220 378 222" stroke-width="8"/>
</g>`,
  },
  {
    id: "procedural-015-meander-seam",
    title: "Seam-crossing meander",
    description: "A continuous Greek-key meander whose horizontal rails and corner fragments cross both edges.",
    tags: ["frieze", "repeat", "meander", "seam-crossing", "geometric"],
    splitSuggestion: "development",
    art: `<g fill="none" stroke="#111" stroke-width="12" stroke-linecap="square" stroke-linejoin="miter">
  <path d="M -30 120 H 542 M -30 392 H 542"/>
  <path d="M -24 173 H 84 V 227 H 30 V 335 H 138 V 281 H 84 V 173 H 192 V 227 H 138 V 335 H 246 V 281 H 192 V 173 H 300 V 227 H 246 V 335 H 354 V 281 H 300 V 173 H 408 V 227 H 354 V 335 H 462 V 281 H 408 V 173 H 516 V 227 H 462 V 335 H 570"/>
</g>`,
  },
  {
    id: "procedural-016-wave-seam",
    title: "Interlocking wave frieze",
    description: "Two offset rows of curling waves continue through the left and right seams.",
    tags: ["frieze", "repeat", "wave", "seam-crossing", "organic"],
    splitSuggestion: "validation",
    art: `<g fill="none" stroke="#111" stroke-width="9" stroke-linecap="round" stroke-linejoin="round">
  <path d="M -60 166 C -20 104 56 102 87 153 C 112 194 69 225 37 197 C 14 177 31 151 54 158 C 116 181 138 221 181 221 C 224 221 246 181 308 158 C 331 151 348 177 325 197 C 293 225 250 194 275 153 C 306 102 382 104 422 166 C 451 211 489 221 572 176"/>
  <path d="M -60 346 C -20 284 56 282 87 333 C 112 374 69 405 37 377 C 14 357 31 331 54 338 C 116 361 138 401 181 401 C 224 401 246 361 308 338 C 331 331 348 357 325 377 C 293 405 250 374 275 333 C 306 282 382 284 422 346 C 451 391 489 401 572 356"/>
  <path d="M -20 259 H 532" stroke-width="5"/>
</g>`,
  },
  {
    id: "procedural-017-rosette-beads",
    title: "Rosette and bead band",
    description: "Four outlined rosettes alternate with bead triplets between double horizontal rules.",
    tags: ["frieze", "repeat", "rosette", "beads", "symmetry"],
    splitSuggestion: "test",
    art: `<path d="M 18 112 H 494 M 18 400 H 494" fill="none" stroke="#111" stroke-width="8"/>
${[72, 195, 318, 441].map((x) => rosette(x, 256, 53)).join("\n")}
<g fill="#111">${[133, 256, 379]
      .flatMap((x) => [-24, 0, 24].map((offset) => `<circle cx="${x}" cy="${256 + offset}" r="7"/>`))
      .join("")}</g>`,
  },
  {
    id: "procedural-018-palmette-band",
    title: "Alternating palmette band",
    description: "Upright and inverted fan-shaped palmettes alternate along a bounded ornamental band.",
    tags: ["frieze", "repeat", "palmette", "botanical", "alternating"],
    splitSuggestion: "validation",
    art: `<g fill="none" stroke="#111" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M 14 92 H 498 M 14 420 H 498"/>
  ${[70, 194, 318, 442]
    .map(
      (x, index) => `<g transform="${index % 2 ? `rotate(180 ${x} 256)` : ""}">
    <path d="M ${x - 49} 323 Q ${x} 291 ${x + 49} 323 M ${x} 322 V 167"/>
    <path d="M ${x} 292 C ${x - 53} 277 ${x - 64} 222 ${x - 45} 185 C ${x - 10} 204 ${x} 244 ${x} 292 Z"/>
    <path d="M ${x} 292 C ${x + 53} 277 ${x + 64} 222 ${x + 45} 185 C ${x + 10} 204 ${x} 244 ${x} 292 Z"/>
    <path d="M ${x} 246 C ${x - 24} 209 ${x - 13} 168 ${x} 145 C ${x + 13} 168 ${x + 24} 209 ${x} 246 Z"/>
  </g>`,
    )
    .join("\n")}
</g>`,
  },
  {
    id: "procedural-019-braid-seam",
    title: "Seam-crossing braided ribbon",
    description: "Three interlaced diagonal ribbons form a wide braid that exits and re-enters at both edges.",
    tags: ["frieze", "repeat", "braid", "seam-crossing", "interlace"],
    splitSuggestion: "test",
    art: `<g fill="none" stroke="#111" stroke-width="18" stroke-linecap="round" stroke-linejoin="round">
  <path d="M -74 331 C -13 331 11 181 72 181 C 133 181 157 331 218 331 C 279 331 303 181 364 181 C 425 181 449 331 586 331"/>
  <path d="M -74 181 C -13 181 11 331 72 331 C 133 331 157 181 218 181 C 279 181 303 331 364 331 C 425 331 449 181 586 181"/>
  <path d="M -36 256 C 21 126 123 126 181 256 C 239 386 341 386 399 256 C 457 126 521 147 555 212"/>
</g>
<g fill="#fff" stroke="none">
  <circle cx="72" cy="181" r="10"/><circle cx="218" cy="331" r="10"/><circle cx="364" cy="181" r="10"/>
</g>`,
  },
  {
    id: "procedural-020-gazelle-chase-seam",
    title: "Gazelle chase cylinder frieze",
    description: "A repeated running gazelle motif forms a chase scene, with partial animals at both seams.",
    tags: ["frieze", "animal", "gazelle", "seam-crossing", "procession"],
    splitSuggestion: "development",
    art: `<g fill="none" stroke="#111" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">
  <path d="M -20 406 H 532 M -20 106 H 532"/>
  ${[-82, 92, 266, 440]
    .map(
      (x) => `<g transform="translate(${x} 0)">
    <path d="M 43 281 C 73 230 132 231 154 277 C 164 298 154 326 129 339 C 94 358 55 334 43 281 Z"/>
    <path d="M 144 270 C 160 223 190 209 212 229 C 223 240 218 259 201 265 L 160 285"/>
    <path d="M 197 229 Q 206 197 192 173 M 204 231 Q 222 202 217 177"/>
    <path d="M 65 329 L 31 389 M 91 342 L 125 394 M 127 335 L 167 384 M 148 314 L 196 357"/>
    <path d="M 45 277 Q 17 253 5 272"/>
  </g>`,
    )
    .join("\n")}
</g>`,
  },
  {
    id: "procedural-021-procession-seam",
    title: "Seam-crossing offering procession",
    description: "Four simplified human figures carry bowls and staffs in a cylinder-seal-style procession.",
    tags: ["frieze", "figures", "procession", "seam-crossing", "narrative"],
    splitSuggestion: "test",
    art: `<g fill="none" stroke="#111" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M -18 430 H 530 M -18 82 H 530"/>
  ${[-76, 69, 214, 359, 504]
    .map(
      (x, index) => `<g transform="translate(${x} 0)">
    <circle cx="52" cy="145" r="28"/>
    <path d="M 51 174 L 39 302 L 13 403 M 42 302 L 79 403 M 45 212 L 5 265 M 48 218 L 103 246"/>
    ${index % 2 === 0 ? '<path d="M 98 230 H 146 Q 132 272 110 265 Z"/>' : '<path d="M 102 247 V 130 M 93 130 H 111"/>'}
    <path d="M 35 193 Q 52 180 69 193" stroke-width="5"/>
  </g>`,
    )
    .join("\n")}
</g>`,
  },
  {
    id: "procedural-022-cuneiform-registers",
    title: "Cuneiform in three registers",
    description: "Three ruled registers contain varied clusters of wedge-shaped pseudo-cuneiform marks.",
    tags: ["cuneiform", "inscription", "registers", "dense", "wedge"],
    splitSuggestion: "development",
    art: `<g fill="none" stroke="#111" stroke-width="6"><rect x="35" y="42" width="442" height="428" rx="18"/><path d="M 49 184 H 463 M 49 326 H 463"/></g>
<g>
  ${[
    [71, 91, 0, 1], [112, 113, 35, 0.8], [155, 84, 90, 0.9], [192, 128, -15, 1], [245, 91, 20, 0.9], [286, 126, 90, 1], [335, 83, -10, 0.8], [373, 120, 40, 1], [425, 87, 90, 0.9],
    [68, 229, 90, 1], [108, 266, 15, 0.8], [151, 217, -20, 1], [197, 257, 90, 0.9], [238, 218, 30, 1], [291, 270, -10, 0.8], [330, 224, 90, 1], [382, 265, 20, 0.9], [425, 220, 0, 1],
    [69, 372, -10, 1], [111, 411, 90, 0.9], [159, 365, 30, 0.8], [199, 421, 0, 1], [248, 370, 90, 1], [291, 411, -20, 0.9], [337, 369, 15, 1], [383, 418, 90, 0.8], [427, 370, -10, 1],
  ].map(([x, y, rotation, scale]) => wedge(x, y, rotation, scale)).join("\n")}
  ${[
    [82, 142], [175, 148], [267, 148], [356, 147], [445, 144], [88, 293], [179, 286], [267, 296], [356, 289], [444, 294], [88, 448], [179, 447], [269, 450], [358, 447], [444, 447],
  ].map(([x, y], index) => wedge(x, y, index % 2 ? 180 : 0, 0.55)).join("\n")}
</g>`,
  },
  {
    id: "procedural-023-cuneiform-seal",
    title: "Circular seal inscription",
    description: "Radial pseudo-cuneiform wedges surround a central eight-pointed star inside a double seal border.",
    tags: ["cuneiform", "seal", "radial", "wedge", "symmetry"],
    splitSuggestion: "validation",
    art: `<g fill="none" stroke="#111" stroke-width="8"><circle cx="256" cy="256" r="211"/><circle cx="256" cy="256" r="184"/><circle cx="256" cy="256" r="76"/></g>
<polygon points="${starPoints(256, 256, 57, 23, 8)}" fill="#111"/>
<g>${Array.from({ length: 20 }, (_, index) => {
      const angle = (index * 360) / 20;
      const radians = (angle * Math.PI) / 180;
      const x = 256 + Math.cos(radians) * 131;
      const y = 256 + Math.sin(radians) * 131;
      return wedge(x.toFixed(2), y.toFixed(2), angle + (index % 3 === 0 ? 35 : 6), index % 2 ? 0.72 : 0.9);
    }).join("\n")}</g>`,
  },
];

if (cases.length !== 23) {
  throw new Error(`Expected exactly 23 procedural cases, found ${cases.length}`);
}

const splitCounts = cases.reduce((counts, item) => {
  counts[item.splitSuggestion] = (counts[item.splitSuggestion] ?? 0) + 1;
  return counts;
}, {});

if (
  splitCounts.development !== 13 ||
  splitCounts.validation !== 5 ||
  splitCounts.test !== 5
) {
  throw new Error(`Expected a 13/5/5 split, found ${JSON.stringify(splitCounts)}`);
}

if (!checkMode) {
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(dirname(fragmentPath), { recursive: true });
}

for (const item of cases) {
  await writeOrCheck(join(sourceDirectory, `${item.id}.svg`), makeSvg(item));
}

const expectedFiles = new Set(cases.map((item) => `${item.id}.svg`));
const unexpectedFiles = (await readdir(sourceDirectory)).filter(
  (filename) => filename.endsWith(".svg") && !expectedFiles.has(filename),
);
if (unexpectedFiles.length > 0) {
  throw new Error(`Unexpected procedural SVGs: ${unexpectedFiles.join(", ")}`);
}

const manifest = cases
  .map((item) =>
    JSON.stringify({
      id: item.id,
      title: item.title,
      description: item.description,
      sourcePath: `sources/procedural/${item.id}.svg`,
      tags: item.tags,
      splitSuggestion: item.splitSuggestion,
      license: "CC0-1.0",
      creator: "Cylinder Seal Studio contributors",
      sourceKind: "procedural",
      trainingAllowed: false,
      trainingNotes:
        "Evaluation-only because the fixtures were created with coding-agent assistance; review applicable provider-output terms before using them as training targets.",
    }),
  )
  .join("\n");

await writeOrCheck(fragmentPath, `${manifest}\n`);

process.stdout.write(
  `${checkMode ? "Validated" : "Generated"} ${cases.length} procedural SVGs (${splitCounts.development} development, ` +
    `${splitCounts.validation} validation, ${splitCounts.test} test).\n`,
);
