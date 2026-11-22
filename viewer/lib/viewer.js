const THREE = require('three')
const TWEEN = require('@tweenjs/tween.js')
const { WorldRenderer } = require('./worldrenderer')
const { Entities } = require('./entities')
const { Primitives } = require('./primitives')
const { getVersion } = require('./version')
const { Vec3 } = require('vec3')

// Rain is drawn the cheap way: streaks falling in a box that follows the camera
const RAIN_DROPS = 2000
const RAIN_BOX = 32 // horizontal size, centred on the camera
const RAIN_HEIGHT = 24
const RAIN_STREAK = 0.7
const RAIN_SPEED = 20 // blocks per second

// Block light, also cheap: a fixed pool of point lights (a fixed count, so shaders never recompile)
// goes to the light sources nearest the camera; light passes through walls
const LAMPS = 32

class Viewer {
  constructor (renderer) {
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color('lightblue')

    this.ambientLight = new THREE.AmbientLight(0xcccccc)
    this.scene.add(this.ambientLight)

    this.directionalLight = new THREE.DirectionalLight(0xffffff, 0.5)
    this.directionalLight.position.set(1, 1, 0.5).normalize()
    this.directionalLight.castShadow = true
    this.scene.add(this.directionalLight)

    const size = renderer.getSize(new THREE.Vector2())
    this.camera = new THREE.PerspectiveCamera(75, size.x / size.y, 0.1, 1000)

    this.world = new WorldRenderer(this.scene)
    this.entities = new Entities(this.scene)
    this.primitives = new Primitives(this.scene, this.camera)

    this.domElement = renderer.domElement
    this.playerHeight = 1.6
    this.isSneaking = false

    this.daylight = 1
    this.rainLevel = 0
    this.rain = makeRain()
    this.scene.add(this.rain)
    this.lastFrame = performance.now()

    this.lightSources = []
    this.lamps = []
    for (let i = 0; i < LAMPS; i++) {
      const lamp = new THREE.PointLight(0xffc68a, 0, 1, 2)
      this.lamps.push(lamp)
      this.scene.add(lamp)
    }
    this.lastLampSort = 0
  }

  // sources: [{ x, y, z, level }] in block coordinates, level 1-15
  setLights (sources) {
    this.lightSources = sources
    this.lastLampSort = 0
  }

  placeLamps (now) {
    if (now - this.lastLampSort < 500) return
    this.lastLampSort = now
    const c = this.camera.position
    const near = this.lightSources
      .map(s => ({ s, d: (s.x + 0.5 - c.x) ** 2 + (s.y + 0.5 - c.y) ** 2 + (s.z + 0.5 - c.z) ** 2 }))
      .sort((a, b) => a.d - b.d)
    this.lamps.forEach((lamp, i) => {
      const s = near[i]?.s
      // Vanilla takes the brighter of sky light and block light, but these lamps add on top of the
      // sun, so they fade out as the sky brightens (rain lets a little through by day)
      lamp.intensity = s ? 0.7 * (1 - this.daylight * (1 - 0.35 * this.rainLevel)) : 0
      if (!s) return
      lamp.position.set(s.x + 0.5, s.y + 0.5, s.z + 0.5)
      lamp.distance = s.level // vanilla light drops one level per block
    })
  }

  resetAll () {
    this.world.resetWorld()
    this.entities.clear()
    this.primitives.clear()
  }

  setVersion (version) {
    const assetsVersion = getVersion(version)
    if (assetsVersion === null) {
      const msg = `${version} is not supported`
      window.alert(msg)
      console.log(msg)
      return false
    }
    console.log(`Using version: ${version} (assets: ${assetsVersion})`)
    this.version = version
    this.world.setVersion(version, assetsVersion)
    this.entities.setVersion(assetsVersion)
    this.primitives.clear()
    return true
  }

  addColumn (x, z, chunk) {
    this.world.addColumn(x, z, chunk)
  }

  removeColumn (x, z) {
    this.world.removeColumn(x, z)
  }

  setBlockStateId (pos, stateId) {
    this.world.setBlockStateId(pos, stateId)
  }

  updateEntity (e) {
    this.entities.update(e)
  }

  updatePrimitive (p) {
    this.primitives.update(p)
  }

  // timeOfDay is in ticks (0-24000, 0 = sunrise, 6000 = noon, 18000 = midnight).
  // Blocks carry no sky/block light, so dim the whole scene and sky instead.
  setTimeOfDay (timeOfDay) {
    const t = ((timeOfDay % 24000) + 24000) % 24000
    let daylight
    if (t < 12000) daylight = 1
    else if (t < 13800) daylight = 1 - (t - 12000) / 1800
    else if (t < 22200) daylight = 0
    else daylight = (t - 22200) / 1800
    this.daylight = daylight
    this.applySky()
  }

  // rainLevel is 0 (dry) to 1 (full rain); rain greys the sky and dims the light
  setRain (rainLevel) {
    this.rainLevel = rainLevel
    this.rain.visible = rainLevel > 0
    this.rain.material.opacity = 0.55 * rainLevel
    this.applySky()
  }

  applySky () {
    const dim = 1 - 0.35 * this.rainLevel
    this.ambientLight.intensity = (0.25 + 0.75 * this.daylight) * dim
    this.directionalLight.intensity = (0.05 + 0.45 * this.daylight) * dim
    const sky = new THREE.Color(0x0a0e1f).lerp(new THREE.Color('lightblue'), this.daylight)
    const grey = new THREE.Color(0x0a0e1f).lerp(new THREE.Color(0x7a8088), this.daylight)
    this.scene.background = sky.lerp(grey, 0.8 * this.rainLevel)
  }

  animateRain (seconds) {
    if (!this.rain.visible) return
    this.rain.position.copy(this.camera.position)
    const pos = this.rain.geometry.attributes.position
    const fall = RAIN_SPEED * seconds
    for (let i = 0; i < pos.count; i += 2) {
      let y = pos.getY(i) - fall
      if (y < -RAIN_HEIGHT / 2) y += RAIN_HEIGHT
      pos.setY(i, y)
      pos.setY(i + 1, y + RAIN_STREAK)
    }
    pos.needsUpdate = true
  }

  setFirstPersonCamera (pos, yaw, pitch) {
    if (pos) {
      let y = pos.y + this.playerHeight
      if (this.isSneaking) y -= 0.3
      new TWEEN.Tween(this.camera.position).to({ x: pos.x, y, z: pos.z }, 50).start()
    }
    // Looks arrive about 20 times a second and unevenly over the socket; setting them straight
    // away makes the view step, so update() eases the camera toward the last one each frame
    if (!this.look) this.camera.rotation.set(pitch, yaw, 0, 'ZYX')
    this.look = { yaw, pitch }
  }

  easeLook (seconds) {
    if (!this.look) return
    const r = this.camera.rotation
    const k = 1 - Math.exp(-seconds / 0.12)
    const dYaw = Math.atan2(Math.sin(this.look.yaw - r.y), Math.cos(this.look.yaw - r.y))
    r.set(r.x + (this.look.pitch - r.x) * k, r.y + dYaw * k, 0, 'ZYX')
  }

  listen (emitter) {
    emitter.on('entity', (e) => {
      this.updateEntity(e)
    })

    emitter.on('primitive', (p) => {
      this.updatePrimitive(p)
    })

    emitter.on('loadChunk', ({ x, z, chunk }) => {
      this.addColumn(x, z, chunk)
    })

    emitter.on('unloadChunk', ({ x, z }) => {
      this.removeColumn(x, z)
    })

    emitter.on('time', ({ timeOfDay }) => {
      this.setTimeOfDay(timeOfDay)
    })

    emitter.on('weather', ({ rainLevel }) => {
      this.setRain(rainLevel)
    })

    emitter.on('lights', (sources) => {
      this.setLights(sources)
    })

    emitter.on('blockUpdate', ({ pos, stateId }) => {
      this.setBlockStateId(new Vec3(pos.x, pos.y, pos.z), stateId)
    })

    this.domElement.addEventListener('pointerdown', (evt) => {
      const raycaster = new THREE.Raycaster()
      const mouse = new THREE.Vector2()
      mouse.x = (evt.clientX / this.domElement.clientWidth) * 2 - 1
      mouse.y = -(evt.clientY / this.domElement.clientHeight) * 2 + 1
      raycaster.setFromCamera(mouse, this.camera)
      const ray = raycaster.ray
      emitter.emit('mouseClick', { origin: ray.origin, direction: ray.direction, button: evt.button })
    })
  }

  update () {
    const now = performance.now()
    const dt = Math.min((now - this.lastFrame) / 1000, 0.1)
    this.animateRain(dt)
    this.easeLook(dt)
    this.placeLamps(now)
    this.lastFrame = now
    TWEEN.update()
    this.world.update()
    this.entities.animate()
  }

  async waitForChunksToRender () {
    await this.world.waitForChunksToRender()
  }
}

function makeRain () {
  const positions = new Float32Array(RAIN_DROPS * 6)
  for (let i = 0; i < RAIN_DROPS; i++) {
    const x = (Math.random() - 0.5) * RAIN_BOX
    const y = (Math.random() - 0.5) * RAIN_HEIGHT
    const z = (Math.random() - 0.5) * RAIN_BOX
    positions.set([x, y, z, x, y + RAIN_STREAK, z], i * 6)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const rain = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0xaab4c8, transparent: true, opacity: 0 }))
  rain.frustumCulled = false // it moves with the camera; its bounds are never recomputed
  rain.visible = false
  return rain
}

module.exports = { Viewer }
