import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { Mesh } from '@/lib/seal'

export default function ThreePreview({ mesh }: { mesh: Mesh | null }) {
  const mountRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<{
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    renderer: THREE.WebGLRenderer
    controls: OrbitControls
    current?: THREE.Mesh
    requestRender: () => void
  } | null>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0xf4f7f9)
    const width = Math.max(1, mount.clientWidth)
    const height = Math.max(1, mount.clientHeight)
    const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 2000)
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(width, height)
    mount.appendChild(renderer.domElement)

    scene.add(new THREE.AmbientLight(0xffffff, 0.55))
    const key = new THREE.DirectionalLight(0xffffff, 1.4)
    key.position.set(60, 80, 40)
    scene.add(key)
    const fill = new THREE.DirectionalLight(0xdfeaf5, 0.6)
    fill.position.set(-50, -20, -60)
    scene.add(fill)
    const grid = new THREE.GridHelper(120, 24, 0xc8d4dc, 0xe4ebf0)
    grid.position.y = -0.01
    scene.add(grid)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = false
    let raf: number | null = null
    const requestRender = () => {
      if (raf !== null) return
      raf = requestAnimationFrame(() => {
        raf = null
        renderer.render(scene, camera)
      })
    }
    controls.addEventListener('change', requestRender)
    const onResize = () => {
      const nextWidth = Math.max(1, mount.clientWidth)
      const nextHeight = Math.max(1, mount.clientHeight)
      camera.aspect = nextWidth / nextHeight
      camera.updateProjectionMatrix()
      renderer.setSize(nextWidth, nextHeight)
      requestRender()
    }
    const ro = new ResizeObserver(onResize)
    ro.observe(mount)
    sceneRef.current = { scene, camera, renderer, controls, requestRender }
    requestRender()

    return () => {
      if (raf !== null) cancelAnimationFrame(raf)
      ro.disconnect()
      controls.removeEventListener('change', requestRender)
      controls.dispose()
      scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return
        object.geometry.dispose()
        const materials = Array.isArray(object.material) ? object.material : [object.material]
        materials.forEach((material) => material.dispose())
      })
      grid.geometry.dispose()
      const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material]
      gridMaterials.forEach((material) => material.dispose())
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
      scene.clear()
      sceneRef.current = null
    }
  }, [])

  useEffect(() => {
    const ctx = sceneRef.current
    if (!ctx) return
    if (ctx.current) {
      ctx.scene.remove(ctx.current)
      ctx.current.geometry.dispose()
      ;(ctx.current.material as THREE.Material).dispose()
      ctx.current = undefined
    }
    if (!mesh) {
      ctx.requestRender()
      return
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3))
    geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1))
    geo.computeBoundingSphere()
    const mat = new THREE.MeshStandardMaterial({
      color: 0x9fc6dd,
      roughness: 0.55,
      metalness: 0.08,
      flatShading: true,
    })
    const obj = new THREE.Mesh(geo, mat)
    obj.position.y = -geo.boundingSphere!.center.y
    ctx.scene.add(obj)
    ctx.current = obj
    const r = geo.boundingSphere!.radius
    ctx.camera.position.set(r * 1.6, r * 0.9, r * 1.6)
    ctx.controls.target.set(0, 0, 0)
    ctx.camera.near = r / 100
    ctx.camera.far = r * 20
    ctx.camera.updateProjectionMatrix()
    ctx.controls.update()
    ctx.requestRender()
  }, [mesh])

  return (
    <div
      ref={mountRef}
      className="h-full w-full rounded-lg border bg-[#f4f7f9]"
      role="img"
      aria-label={mesh ? 'Interactive three-dimensional cylinder seal preview' : 'Three-dimensional preview is unavailable'}
    />
  )
}
