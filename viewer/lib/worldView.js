const { spiral, ViewRect, chunkPos } = require('./simpleUtils')
const { Vec3 } = require('vec3')
const EventEmitter = require('events')

// Skin and cape texture URLs of a player entity (textures.minecraft.net on
// online-mode servers, or our own route for local skins); nothing for other entities or players without skin data
function playerSkin (bot, e) {
  if (e.username !== undefined && bot.localSkins?.[e.username]) return { skin: 'skin/' + encodeURIComponent(e.username) }
  const skinData = e.username !== undefined && bot.players[e.username]?.skinData
  if (!skinData) return { skinModel: defaultSkinModel(e.uuid) }
  return { skin: skinData.url, skinModel: skinData.model, cape: skinData.capeUrl }
}

// Registry order of villager types and professions, which villager_data sends as ids
const villagerTypes = ['desert', 'jungle', 'plains', 'savanna', 'snow', 'swamp', 'taiga']
const villagerProfessions = ['none', 'armorer', 'butcher', 'cartographer', 'cleric', 'farmer', 'fisherman',
  'fletcher', 'leatherworker', 'librarian', 'mason', 'nitwit', 'shepherd', 'toolsmith', 'weaponsmith']

// A villager's texture is composited by the server from its biome and profession; the data
// arrives in the metadata after the spawn, so there is nothing until then
function villagerSkin (e) {
  if (e.name !== 'villager' && e.name !== 'zombie_villager') return {}
  const data = Object.values(e.metadata ?? {}).find(v => v && typeof v === 'object' && 'villagerType' in v)
  if (!data) return {}
  const type = villagerTypes[data.villagerType] ?? 'plains'
  const profession = villagerProfessions[data.villagerProfession] ?? 'none'
  return { skin: `villager/${e.name}/${type}/${profession}` }
}

// Other mobs pick a texture by one metadata value: [metadata key, textures by id]
const t = 'textures/1.16.4/entity/'
const dyes = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray',
  'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
const variants = {
  cat: ['variant', ['tabby', 'black', 'red', 'siamese', 'british_shorthair', 'calico', 'persian', 'ragdoll',
    'white', 'jellie', 'all_black'].map(n => `${t}cat/${n}.png`)],
  fox: ['type', ['fox', 'snow_fox'].map(n => `${t}fox/${n}.png`)],
  llama: ['variant', ['creamy', 'white', 'brown', 'gray'].map(n => `${t}llama/${n}.png`)],
  trader_llama: ['variant', ['creamy', 'white', 'brown', 'gray'].map(n => `${t}llama/${n}.png`)],
  parrot: ['variant', ['red_blue', 'blue', 'green', 'yellow_blue', 'grey'].map(n => `${t}parrot/parrot_${n}.png`)],
  rabbit: ['type', { 0: 'brown', 1: 'white', 2: 'black', 3: 'white_splotched', 4: 'gold', 5: 'salt', 99: 'caerbannog' }],
  shulker: ['color', dyes.map(n => `${t}shulker/shulker_${n}.png`)]
}
variants.rabbit[1] = Object.fromEntries(Object.entries(variants.rabbit[1]).map(([k, n]) => [k, `${t}rabbit/${n}.png`]))
const horseColors = ['white', 'creamy', 'chestnut', 'brown', 'black', 'gray', 'darkbrown']
const horseMarkings = ['none', 'white', 'whitefield', 'whitedots', 'blackdots']

function metadataValue (bot, e, key) {
  const i = bot.registry.entitiesByName[e.name]?.metadataKeys?.indexOf(key)
  return i >= 0 ? e.metadata?.[i] : undefined
}

function variantSkin (bot, e) {
  if (e.name === 'horse') {
    const v = metadataValue(bot, e, 'type_variant')
    if (typeof v !== 'number') return {}
    return { skin: `horse/${horseColors[v & 0xff] ?? 'brown'}/${horseMarkings[(v >> 8) & 0xff] ?? 'none'}` }
  }
  const variant = variants[e.name]
  if (!variant) return {}
  const skin = variant[1][metadataValue(bot, e, variant[0])]
  return skin ? { skin } : {}
}

function entityInfo (bot, e) {
  return { id: e.id, name: e.name, pos: e.position, width: e.width, height: e.height, username: e.username, riding: !!e.vehicle, itemName: droppedItemName(bot.registry, e), yaw: e.yaw, pitch: e.pitch, headYaw: e.headYaw, held: heldItem(e), ...playerSkin(bot, e), ...villagerSkin(e), ...variantSkin(bot, e) }
}

// What the entity holds in its main hand ('' for nothing)
function heldItem (e) {
  return e.equipment?.[0]?.name ?? ''
}

// Vanilla's DefaultPlayerSkin: a player without skin data is Alex when the Java hashCode of
// their UUID is odd, which is the xor of the lowest bit of each 32-bit quarter.
function defaultSkinModel (uuid) {
  if (typeof uuid !== 'string') return undefined
  const hex = uuid.replace(/-/g, '')
  if (hex.length !== 32) return undefined
  const odd = [7, 15, 23, 31].reduce((acc, i) => acc ^ parseInt(hex[i], 16), 0) & 1
  return odd ? 'slim' : undefined
}

// A dropped item's stack lives in the entity's metadata, keyed by the raw metadata index.
function droppedItemName (registry, entity) {
  if (entity.name !== 'item' || !entity.metadata) return undefined
  const keys = registry.entitiesByName?.item?.metadataKeys
  const slots = keys ? [entity.metadata[keys.indexOf('item')]] : Object.values(entity.metadata)
  for (const slot of slots) {
    if (!slot || typeof slot !== 'object') continue
    if (slot.present === false || slot.itemCount === 0) continue
    const id = slot.itemId ?? slot.blockId
    if (id === undefined || id < 0) continue
    return registry.items[id]?.name
  }
}

// Blocks that give off light; the dimmest (mushrooms, sculk…) are left out
let lightBlockIds
function lightIds (bot) {
  if (!lightBlockIds) lightBlockIds = bot.registry.blocksArray.filter(b => b.emitLight >= 5).map(b => b.id)
  return lightBlockIds
}

class WorldView extends EventEmitter {
  constructor (world, viewDistance, position = new Vec3(0, 0, 0), emitter = null) {
    super()
    this.world = world
    this.viewDistance = viewDistance
    this.loadedChunks = {}
    // loadChunk awaits the world, so a load can finish after its column was unloaded or the world
    // was replaced. Each load records a token under its column key and the world generation it read
    // from; it only emits if both are still current once the column arrives.
    this.pendingLoads = {}
    this.nextLoadToken = 0
    this.worldGeneration = 0
    this.lastPos = new Vec3(0, 0, 0).update(position)
    this.emitter = emitter || this

    this.listeners = {}
    this.stopEnvironment = {}
    this.skins = {}
    this.emitter.on('mouseClick', async (click) => {
      const ori = new Vec3(click.origin.x, click.origin.y, click.origin.z)
      const dir = new Vec3(click.direction.x, click.direction.y, click.direction.z)
      const block = this.world.raycast(ori, dir, 256)
      if (!block) return
      this.emit('blockClicked', block, block.face, click.button)
    })
  }

  listenToBot (bot) {
    const worldView = this
    const env = this.environment(bot)
    this.listeners[bot.username] = {
      // 'move': botPosition,
      move: env.weather,
      time: env.time,
      weatherUpdate: env.weather,
      entitySpawn: function (e) {
        if (e === bot.entity) return
        worldView.emitter.emit('entity', entityInfo(bot, e))
      },
      entityUpdate: function (e) {
        const itemName = droppedItemName(bot.registry, e)
        if (itemName !== undefined) worldView.emitter.emit('entity', { id: e.id, pos: e.position, itemName })
        // A villager's biome and profession come after its spawn (and change when it takes a job)
        const skin = villagerSkin(e).skin ?? variantSkin(bot, e).skin
        if (skin && skin !== worldView.skins[e.id]) {
          worldView.skins[e.id] = skin
          worldView.emitter.emit('entity', entityInfo(bot, e))
        }
      },
      entityMoved: function (e) {
        worldView.emitter.emit('entity', { id: e.id, pos: e.position, pitch: e.pitch, yaw: e.yaw, headYaw: e.headYaw })
      },
      entitySwingArm: function (e) {
        worldView.emitter.emit('entity', { id: e.id, swing: true })
      },
      entityEquip: function (e) {
        worldView.emitter.emit('entity', { id: e.id, held: heldItem(e) })
      },
      entityAttach: function (e) {
        worldView.emitter.emit('entity', { id: e.id, riding: true })
      },
      entityDetach: function (e) {
        worldView.emitter.emit('entity', { id: e.id, riding: false })
      },
      entityHurt: function (e) {
        worldView.emitter.emit('entity', { id: e.id, hurt: true })
      },
      entityGone: function (e) {
        delete worldView.skins[e.id]
        worldView.emitter.emit('entity', { id: e.id, delete: true })
      },
      chunkColumnLoad: function (pos) {
        worldView.loadChunk(pos)
        env.chunkLoaded()
      },
      chunkColumnUnload: function (pos) {
        worldView.unloadChunk(pos)
      },
      // A dimension change or server transfer unloads every column (each arrives above as a
      // chunkColumnUnload) and may replace bot.world with a fresh object; follow it so chunks that
      // load afterwards are read from the world the bot is now in, not the one it left.
      login: function () {
        worldView.setWorld(bot.world)
      },
      blockUpdate: function (oldBlock, newBlock) {
        const stateId = newBlock.stateId ? newBlock.stateId : ((newBlock.type << 4) | newBlock.metadata)
        worldView.emitter.emit('blockUpdate', { pos: oldBlock.position, stateId })
        env.lightChanged(oldBlock, newBlock)
      }
    }
    this.stopEnvironment[bot.username] = env.stop

    for (const [evt, listener] of Object.entries(this.listeners[bot.username])) {
      bot.on(evt, listener)
    }

    for (const id in bot.entities) {
      const e = bot.entities[id]
      if (e && e !== bot.entity) {
        this.emitter.emit('entity', entityInfo(bot, e))
      }
    }
  }

  removeListenersFromBot (bot) {
    for (const [evt, listener] of Object.entries(this.listeners[bot.username])) {
      bot.removeListener(evt, listener)
    }
    delete this.listeners[bot.username]
    this.stopEnvironment[bot.username]()
    delete this.stopEnvironment[bot.username]
  }

  // Game time (day/night), rain level and light sources around the bot, for the viewer's sky,
  // rain and lamps. Sends the current state now; the returned handlers keep it up to date
  environment (bot) {
    const emitter = this.emitter
    function time () {
      emitter.emit('time', { timeOfDay: bot.time.timeOfDay })
    }

    // Rain level (0-1). Weather is world-wide but biomes without precipitation (desert, savanna,
    // badlands…) stay dry, so it goes by the biome the bot is in; sent again when that changes
    let lastRain
    function weather () {
      const biome = bot.registry.biomes[bot.blockAt(bot.entity.position)?.biome?.id]
      const rainLevel = biome?.has_precipitation === false ? 0 : bot.rainState
      if (rainLevel === lastRain) return
      lastRain = rainLevel
      emitter.emit('weather', { rainLevel })
    }

    // Light sources (torches, lava, glowstone…) within 96 blocks. A full findBlocks takes over
    // half a second and stalls everything else, so it runs once, again only after chunks finish
    // loading, and single block changes patch the set
    const lightSources = new Map()
    function scanLights () {
      lightSources.clear()
      for (const p of bot.findBlocks({ matching: lightIds(bot), maxDistance: 96, count: 512 })) {
        lightSources.set(`${p.x},${p.y},${p.z}`, { x: p.x, y: p.y, z: p.z, level: bot.registry.blocksByStateId[bot.world.getBlockStateId(p)]?.emitLight ?? 0 })
      }
      sendLights()
    }
    let lastLights = ''
    let sendTimer
    function sendLights () {
      clearTimeout(sendTimer)
      sendTimer = setTimeout(() => {
        const lights = [...lightSources.values()]
        const key = JSON.stringify(lights)
        if (key === lastLights) return
        lastLights = key
        emitter.emit('lights', lights)
      }, 200)
    }
    function lightChanged (oldBlock, newBlock) {
      const level = newBlock?.type !== undefined ? bot.registry.blocks[newBlock.type]?.emitLight ?? 0 : 0
      const oldLevel = oldBlock?.type !== undefined ? bot.registry.blocks[oldBlock.type]?.emitLight ?? 0 : 0
      if (level < 5 && oldLevel < 5) return
      const p = newBlock.position
      if (level >= 5) lightSources.set(`${p.x},${p.y},${p.z}`, { x: p.x, y: p.y, z: p.z, level })
      else lightSources.delete(`${p.x},${p.y},${p.z}`)
      sendLights()
    }
    let rescanTimer
    function chunkLoaded () {
      clearTimeout(rescanTimer)
      rescanTimer = setTimeout(scanLights, 3000)
    }

    time()
    weather()
    // Immediate scan is often empty: headless starts in the same spawn tick as the bot, before
    // columns are in; the browser connects later and sees torches. Chunk events also miss if the
    // world was already loaded before listenToBot. Deferred scans go through the same emitter →
    // Viewer.setLights path both engines use (no headless side channel).
    scanLights()
    const bootScans = [1500, 5000, 12000].map((ms) => setTimeout(scanLights, ms))
    return {
      time,
      weather,
      lightChanged,
      chunkLoaded,
      stop () {
        clearTimeout(sendTimer)
        clearTimeout(rescanTimer)
        for (const t of bootScans) clearTimeout(t)
      }
    }
  }

  async init (pos) {
    const [botX, botZ] = chunkPos(pos)

    const positions = []
    spiral(this.viewDistance * 2, this.viewDistance * 2, (x, z) => {
      const p = new Vec3((botX + x) * 16, 0, (botZ + z) * 16)
      positions.push(p)
    })

    this.lastPos.update(pos)
    await this._loadChunks(positions)
  }

  async _loadChunks (positions, sliceSize = 5, waitTime = 0) {
    for (let i = 0; i < positions.length; i += sliceSize) {
      await new Promise((resolve) => setTimeout(resolve, waitTime))
      await Promise.all(positions.slice(i, i + sliceSize).map(p => this.loadChunk(p)))
    }
  }

  setWorld (world) {
    this.world = world
    this.worldGeneration++
  }

  async loadChunk (pos) {
    const [botX, botZ] = chunkPos(this.lastPos)
    const dx = Math.abs(botX - Math.floor(pos.x / 16))
    const dz = Math.abs(botZ - Math.floor(pos.z / 16))
    if (dx < this.viewDistance && dz < this.viewDistance) {
      const key = `${pos.x},${pos.z}`
      const token = ++this.nextLoadToken
      const generation = this.worldGeneration
      this.pendingLoads[key] = token
      const column = await this.world.getColumnAt(pos)
      if (this.pendingLoads[key] !== token || this.worldGeneration !== generation) return
      delete this.pendingLoads[key]
      if (column) {
        const chunk = column.toJson()
        this.emitter.emit('loadChunk', { x: pos.x, z: pos.z, chunk })
        this.loadedChunks[key] = true
      }
    }
  }

  unloadChunk (pos) {
    this.emitter.emit('unloadChunk', { x: pos.x, z: pos.z })
    delete this.loadedChunks[`${pos.x},${pos.z}`]
    delete this.pendingLoads[`${pos.x},${pos.z}`]
  }

  async updatePosition (pos, force = false) {
    const [lastX, lastZ] = chunkPos(this.lastPos)
    const [botX, botZ] = chunkPos(pos)
    if (lastX !== botX || lastZ !== botZ || force) {
      const newView = new ViewRect(botX, botZ, this.viewDistance)
      for (const coords of Object.keys(this.loadedChunks)) {
        const x = parseInt(coords.split(',')[0])
        const z = parseInt(coords.split(',')[1])
        const p = new Vec3(x, 0, z)
        if (!newView.contains(Math.floor(x / 16), Math.floor(z / 16))) {
          this.unloadChunk(p)
        }
      }
      const positions = []
      spiral(this.viewDistance * 2, this.viewDistance * 2, (x, z) => {
        const p = new Vec3((botX + x) * 16, 0, (botZ + z) * 16)
        if (!this.loadedChunks[`${p.x},${p.z}`]) {
          positions.push(p)
        }
      })
      this.lastPos.update(pos)
      await this._loadChunks(positions)
    } else {
      this.lastPos.update(pos)
    }
  }
}

module.exports = { WorldView }
