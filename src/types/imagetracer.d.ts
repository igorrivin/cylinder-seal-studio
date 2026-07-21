declare module 'imagetracerjs' {
  const ImageTracer: {
    imagedataToSVG(imgdata: ImageData, options?: Record<string, unknown>): string
    imageToSVG(url: string, callback: (svg: string) => void, options?: Record<string, unknown>): void
    getImgdata(canvas: HTMLCanvasElement): ImageData
  }
  export default ImageTracer
}
