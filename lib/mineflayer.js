const EventEmitter = require('events')
const { WorldView } = require('../viewer')
const { made } = require('./textures')

module.exports = (bot, { viewDistance = 6, firstPerson = false, port = 3000, prefix = '', skins = {} }) => {
  const express = require('express')

  const app = express()
  const http = require('http').createServer(app)

  // Frames and recordings come back over the socket, so allow more than the 1 MB default
  const io = require('socket.io')(http, { path: prefix + '/socket.io', maxHttpBufferSize: 1e8 })

  const { setupRoutes } = require('./common')
  setupRoutes(app, prefix)

  // Textures made on request (lib/textures.js): proxied skins and capes (textures.minecraft.net
  // sends no CORS headers), local skin files, layered villagers and horses
  bot.localSkins = skins
  app.get(new RegExp(`^${prefix}/(skin|villager|horse|texture)/.+`), async (req, res) => {
    const png = await made(req.path.slice(prefix.length + 1), skins)
    if (!png) return res.sendStatus(404)
    res.type('png').send(png)
  })

  const sockets = []
  const primitives = {}

  bot.viewer = new EventEmitter()

  bot.viewer.erase = (id) => {
    delete primitives[id]
    for (const socket of sockets) {
      socket.emit('primitive', { id })
    }
  }

  bot.viewer.drawBoxGrid = (id, start, end, color = 'aqua') => {
    primitives[id] = { type: 'boxgrid', id, start, end, color }
    for (const socket of sockets) {
      socket.emit('primitive', primitives[id])
    }
  }

  bot.viewer.drawLine = (id, points, color = 0xff0000) => {
    primitives[id] = { type: 'line', id, points, color }
    for (const socket of sockets) {
      socket.emit('primitive', primitives[id])
    }
  }

  bot.viewer.drawPoints = (id, points, color = 0xff0000, size = 5) => {
    primitives[id] = { type: 'points', id, points, color, size }
    for (const socket of sockets) {
      socket.emit('primitive', primitives[id])
    }
  }

  // Pictures straight from the page's canvas, asked of the newest open page:
  // /capture is the next rendered frame as PNG, /record?sec=4&fps=30 a webm
  function askPage (event, args, timeout) {
    const page = sockets.at(-1)
    if (!page) return Promise.reject(new Error('no viewer page open'))
    return page.timeout(timeout).emitWithAck(event, ...args).then(data => Buffer.from(data))
  }
  app.get(prefix + '/capture', async (req, res) => {
    try {
      res.type('png').send(await askPage('capture', [], 5000))
    } catch (err) {
      res.status(503).send(err.message)
    }
  })
  app.get(prefix + '/record', async (req, res) => {
    const sec = Math.min(Number(req.query.sec) || 4, 30)
    const fps = Math.min(Number(req.query.fps) || 30, 60)
    try {
      res.type('webm').send(await askPage('record', [{ ms: sec * 1000, fps }], sec * 1000 + 10000))
    } catch (err) {
      res.status(503).send(err.message)
    }
  })

  io.on('connection', (socket) => {
    socket.emit('version', bot.version)
    sockets.push(socket)

    const worldView = new WorldView(bot.world, viewDistance, bot.entity.position, socket)
    worldView.init(bot.entity.position)

    worldView.on('blockClicked', (block, face, button) => {
      bot.viewer.emit('blockClicked', block, face, button)
    })

    for (const id in primitives) {
      socket.emit('primitive', primitives[id])
    }

    function botPosition () {
      const packet = { pos: bot.entity.position, yaw: bot.entity.yaw, addMesh: true }
      if (firstPerson) {
        packet.pitch = bot.entity.pitch
      }
      socket.emit('position', packet)
      worldView.updatePosition(bot.entity.position)
    }

    bot.on('move', botPosition)
    worldView.listenToBot(bot)
    socket.on('disconnect', () => {
      bot.removeListener('move', botPosition)
      worldView.removeListenersFromBot(bot)
      sockets.splice(sockets.indexOf(socket), 1)
    })
  })

  http.listen(port, () => {
    console.log(`Prismarine viewer web server running on *:${port}`)
  })

  bot.viewer.close = () => {
    http.close()
    for (const socket of sockets) {
      socket.disconnect()
    }
  }
}
