import { useEffect, useRef } from 'react'
import * as THREE from 'three'

type EarthGlobeProps = {
  listening: boolean
}

const TEX_EARTH = 'https://unpkg.com/three-globe@2.31.0/example/img/earth-blue-marble.jpg'
const TEX_CLOUDS = 'https://unpkg.com/three-globe@2.31.0/example/clouds/clouds.png'
const TEX_CLOUDS_FALLBACK =
  'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/textures/planets/earth_clouds_1024.png'

const EARTH_VERTEX_SHADER = `
  varying vec2 vUv; varying vec3 vN; varying vec3 vVN;
  void main(){
    vUv = uv;
    vN = normalize(normal);
    vVN = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`

const EARTH_FRAGMENT_SHADER = `
  uniform sampler2D dayMap; uniform vec3 sunDir;
  varying vec2 vUv; varying vec3 vN; varying vec3 vVN;
  void main(){
    float cosA = max(dot(normalize(vN), normalize(sunDir)), 0.0);
    vec3 tex = texture2D(dayMap, vUv).rgb;
    vec3 g = pow(tex, vec3(0.45)) * 1.45;
    float lum = dot(g, vec3(0.299, 0.587, 0.114));
    g += vec3(0.10, 0.20, 0.38) * smoothstep(0.5, 0.05, lum);
    g = mix(vec3(dot(g, vec3(0.299, 0.587, 0.114))), g, 0.9);
    vec3 col = g * (0.52 + 0.58 * pow(cosA, 0.8));
    float rim = pow(1.0 - max(dot(normalize(vVN), vec3(0.0, 0.0, 1.0)), 0.0), 3.0);
    col += vec3(0.35, 0.5, 0.8) * rim * 0.25 * (0.3 + 0.7 * cosA);
    gl_FragColor = vec4(col, 1.0);
  }`

const CLOUD_VERTEX_SHADER = `
  varying vec2 vUv; varying vec3 vN;
  void main(){
    vUv = uv;
    vN = normalize(normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`

const CLOUD_FRAGMENT_SHADER = `
  uniform sampler2D cloudMap; uniform vec3 sunDir;
  varying vec2 vUv; varying vec3 vN;
  void main(){
    float cosA = max(dot(normalize(vN), normalize(sunDir)), 0.0);
    vec4 s = texture2D(cloudMap, vUv);
    float a = pow(s.r * s.a, 1.6) * 0.55;
    gl_FragColor = vec4(vec3(0.6 + 0.5 * cosA), a);
  }`

export function EarthGlobe({ listening }: EarthGlobeProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const listeningRef = useRef(listening)

  useEffect(() => {
    listeningRef.current = listening
  }, [listening])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let disposed = false

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100)
    camera.position.set(0, 0, 3.2)
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    } catch {
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.domElement.style.cssText = 'width:100%;height:100%;display:block'
    container.appendChild(renderer.domElement)

    let requestRender = () => {}
    const loader = new THREE.TextureLoader()
    loader.setCrossOrigin('anonymous')
    const setup = (texture: THREE.Texture) => {
      texture.colorSpace = THREE.SRGBColorSpace
      texture.anisotropy = 4
    }
    const dayMap = loader.load(TEX_EARTH, (texture) => {
      setup(texture)
      requestRender()
    })
    setup(dayMap)

    const sun = new THREE.Vector3(-0.45, 0.4, 0.85).normalize()
    const earthMaterial = new THREE.ShaderMaterial({
      uniforms: { dayMap: { value: dayMap }, sunDir: { value: sun.clone() } },
      vertexShader: EARTH_VERTEX_SHADER,
      fragmentShader: EARTH_FRAGMENT_SHADER,
    })
    const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 96), earthMaterial)
    const userLongitude = -new Date().getTimezoneOffset() / 4
    earth.rotation.y = ((-90 - userLongitude) * Math.PI) / 180
    scene.add(earth)

    const cloudMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { cloudMap: { value: null }, sunDir: { value: sun.clone() } },
      vertexShader: CLOUD_VERTEX_SHADER,
      fragmentShader: CLOUD_FRAGMENT_SHADER,
    })
    const clouds = new THREE.Mesh(new THREE.SphereGeometry(1.012, 96, 96), cloudMaterial)
    clouds.visible = false
    loader.load(
      TEX_CLOUDS,
      (texture) => {
        cloudMaterial.uniforms.cloudMap!.value = texture
        clouds.visible = true
        requestRender()
      },
      undefined,
      () =>
        loader.load(TEX_CLOUDS_FALLBACK, (texture) => {
          cloudMaterial.uniforms.cloudMap!.value = texture
          clouds.visible = true
          requestRender()
        }),
    )
    clouds.rotation.y = earth.rotation.y
    scene.add(clouds)

    const starCount = 900
    const positions = new Float32Array(starCount * 3)
    for (let i = 0; i < starCount; i += 1) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(20 + Math.random() * 25)
      positions.set([v.x, v.y, v.z], i * 3)
    }
    const starGeometry = new THREE.BufferGeometry()
    starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    scene.add(
      new THREE.Points(
        starGeometry,
        new THREE.PointsMaterial({ color: 0x8899bb, size: 0.05, sizeAttenuation: true, transparent: true, opacity: 0.8 }),
      ),
    )

    const resize = () => {
      const width = container.clientWidth || 300
      const height = container.clientHeight || 300
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(container)
    resize()

    const yAxis = new THREE.Vector3(0, 1, 0)
    let speed = 0
    let raf = 0
    const renderFrame = () => {
      const target = listeningRef.current ? 0.02 : 0.0008
      speed += (target - speed) * 0.04
      earth.rotation.y += speed
      clouds.rotation.y += speed * 1.15
      earthMaterial.uniforms.sunDir!.value.copy(sun).applyAxisAngle(yAxis, -earth.rotation.y)
      cloudMaterial.uniforms.sunDir!.value.copy(sun).applyAxisAngle(yAxis, -clouds.rotation.y)
      renderer.render(scene, camera)
    }
    const tick = () => {
      if (disposed) return
      raf = requestAnimationFrame(tick)
      renderFrame()
    }
    requestRender = () => {
      if (!disposed) renderFrame()
    }
    renderFrame()
    raf = requestAnimationFrame(tick)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      resizeObserver.disconnect()
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
      dayMap.dispose()
      earthGeometryAndMaterialsDispose(earth, clouds)
    }
  }, [])

  return (
    <div
      aria-label={listening ? 'Earth globe rotating quickly' : 'Earth globe rotating slowly'}
      className="earth-globe"
      ref={containerRef}
      role="img"
    />
  )
}

function earthGeometryAndMaterialsDispose(earth: THREE.Mesh, clouds: THREE.Mesh) {
  earth.geometry.dispose()
  ;(earth.material as THREE.Material).dispose()
  clouds.geometry.dispose()
  ;(clouds.material as THREE.Material).dispose()
}
