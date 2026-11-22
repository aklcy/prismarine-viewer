// Textures made on request rather than shipped under public/: local player skins, villagers
// and horses layered from the game's textures, and online skins from textures.minecraft.net.
// The mirror server serves them at the same paths for the browser; headless loads them directly.
// made(path, skins) gives a PNG Buffer, or null when the path is not one of these or is missing.
const path = require('path')

const layered = {}
async function layer (key, dir, layers) {
  if (!layered[key]) {
    const { createCanvas, loadImage } = require('canvas')
    const canvas = createCanvas(64, 64)
    const ctx = canvas.getContext('2d')
    for (const l of layers) ctx.drawImage(await loadImage(path.join(dir, l)), 0, 0)
    layered[key] = canvas.toBuffer('image/png')
  }
  return layered[key]
}

// Local skin files by player name ({ Galatea: '/path/Galatea.png' }), for offline-mode players
// that have no skin data
function skin (name, skins) {
  const file = Object.hasOwn(skins, name) && skins[name]
  return file ? require('fs').promises.readFile(file) : null
}

// Villagers straight from the game's textures (public/textures/game, copied out of the client
// jar), layered like vanilla: base, biome type, then profession (none has no layer)
function villager (kind, type, profession) {
  const layers = [kind + '.png', `type/${type}.png`]
  if (profession !== 'none') layers.push(`profession/${profession}.png`)
  return layer(`${kind}/${type}/${profession}`, path.join(__dirname, '../public/textures/game/entity', kind), layers)
}

// A horse is its coat color with the markings drawn over it
function horse (color, markings) {
  const layers = [`horse_${color}.png`]
  if (markings !== 'none') layers.push(`horse_markings_${markings}.png`)
  return layer(`horse/${color}/${markings}`, path.join(__dirname, '../public/textures/1.16.4/entity/horse'), layers)
}

// textures.minecraft.net by texture hash only, so this can't be used to fetch anything else
async function online (hash) {
  const texture = await fetch(`https://textures.minecraft.net/texture/${hash}`)
  if (!texture.ok) return null
  return Buffer.from(await texture.arrayBuffer())
}

async function made (p, skins = {}) {
  let m
  try {
    if ((m = p.match(/^skin\/([^/]+)$/))) return await skin(decodeURIComponent(m[1]), skins)
    if ((m = p.match(/^villager\/(villager|zombie_villager)\/([a-z_]+)\/([a-z_]+)$/))) return await villager(m[1], m[2], m[3])
    if ((m = p.match(/^horse\/([a-z]+)\/([a-z]+)$/))) return await horse(m[1], m[2])
    if ((m = p.match(/^texture\/([0-9a-f]+)$/))) return await online(m[1])
  } catch (err) {}
  return null
}

module.exports = { made }
