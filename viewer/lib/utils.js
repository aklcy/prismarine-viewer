function safeRequire (path) {
  try {
    return require(path)
  } catch (e) {
    return {}
  }
}
const { loadImage } = safeRequire('node-canvas-webgl/lib')
const { createCanvas } = safeRequire('canvas')
const THREE = require('three')
const path = require('path')

// Textures made on request (lib/textures.js: local skins, layered villagers and horses, online
// skins): the browser gets them from the mirror server at these same paths; headless hands
// in a maker (setTextureMaker), path → Promise of a PNG Buffer or null
const made = /^(skin|villager|horse|texture)\//
let maker
function setTextureMaker (fn) { maker = fn }

async function nodeSource (texture) {
  if (/^https?:\/\//.test(texture)) return texture
  if (maker && made.test(texture)) {
    const png = await maker(texture)
    if (!png) throw new Error(`no texture ${texture}`)
    return png
  }
  return path.resolve(__dirname, '../../public/' + texture)
}

const textureCache = {}
// todo not ideal, export different functions for browser and node
function loadTexture (texture, cb) {
  if (process.platform === 'browser') {
    return require('./utils.web').loadTexture(texture, cb)
  }

  if (textureCache[texture]) {
    cb(textureCache[texture])
  } else {
    // bundled textures are files under public/; player skins are http(s) URLs
    nodeSource(texture).then(loadImage).then(image => {
      textureCache[texture] = new THREE.CanvasTexture(image)
      cb(textureCache[texture])
    }).catch(() => {})
  }
}

const pixelCache = {}
// RGBA of a texture, for code that needs the picture itself and not just a map
function loadPixels (texture, cb) {
  if (process.platform === 'browser') {
    return require('./utils.web').loadPixels(texture, cb)
  }

  if (pixelCache[texture]) {
    cb(pixelCache[texture])
  } else {
    nodeSource(texture).then(loadImage).then(image => {
      const canvas = createCanvas(image.width, image.height)
      canvas.getContext('2d').drawImage(image, 0, 0)
      pixelCache[texture] = canvas.getContext('2d').getImageData(0, 0, image.width, image.height)
      cb(pixelCache[texture])
    })
  }
}

function loadJSON (json, cb) {
  if (process.platform === 'browser') {
    return require('./utils.web').loadJSON(json, cb)
  }
  cb(require(path.resolve(__dirname, '../../public/' + json)))
}

module.exports = { loadTexture, loadPixels, loadJSON, setTextureMaker }
